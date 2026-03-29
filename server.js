const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec } = require('child_process'); // Usar exec para não bloquear o event loop
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');

// Configura o caminho do ffmpeg para fluent-ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json());

// ── Pastas ────────────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── Upload ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB

// ── Jobs em memória ───────────────────────────────────────────────────────────
const jobs = {};

function updateJob(id, data) {
  jobs[id] = { ...jobs[id], ...data, updatedAt: Date.now() };
}

// ── Helpers FFmpeg ────────────────────────────────────────────────────────────
function ffprobe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, metadata) => {
      if (err) return reject(err);
      resolve(parseFloat(metadata.format.duration));
    });
  });
}

function detectSilences(file, db = -35, minDur = 0.4) {
  return new Promise((resolve, reject) => {
    let silences = [];
    let start = null;
    ffmpeg(file)
      .audioFilters(`silencedetect=noise=${db}dB:d=${minDur}`)
      .format('null')
      .output('-')
      .on('stderr', (line) => {
        if (line.includes('silence_start')) {
          start = parseFloat(line.split('silence_start: ')[1]);
        }
        if (line.includes('silence_end') && start !== null) {
          const end = parseFloat(line.split('silence_end: ')[1]);
          silences.push([start, end]);
          start = null;
        }
      })
      .on('end', () => resolve(silences))
      .on('error', (err) => reject(err))
      .run();
  });
}

function silencesToSegments(silences, duration, margin = 0.05) {
  if (!silences.length) return [[0, duration]];
  const segs = [];
  let cursor = 0;
  for (const [s, e] of silences) {
    if (s - cursor > 0.1) segs.push([cursor + margin, s - margin]);
    cursor = e;
  }
  if (duration - cursor > 0.1) segs.push([cursor + margin, duration]);
  return segs.map(([a, b]) => [Math.max(0, a), Math.min(duration, b)]).filter(([a, b]) => b - a > 0.05);
}

// Função run adaptada para usar fluent-ffmpeg ou exec de forma mais controlada
function runFfmpegCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { maxBuffer: 100 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error(`Erro ao executar comando FFmpeg: ${command}\nStderr: ${stderr}`);
        return reject(stderr || err.message);
      }
      resolve(stdout);
    });
  });
}

function srtToSec(t) {
  const [hms, ms] = t.trim().split(',');
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s + Number(ms) / 1000;
}

// ── Pipeline de edição ────────────────────────────────────────────────────────
async function processVideo(jobId, inputPath, options) {
  const base = path.join(OUTPUT_DIR, jobId);
  const tmp = [];

  try {
    updateJob(jobId, { status: 'processing', step: 'Analisando vídeo...', progress: 5 });
    const duration = await ffprobe(inputPath);

    // PASSO 1 — Cortar silêncios
    updateJob(jobId, { step: 'Detectando e cortando silêncios...', progress: 15 });
    const silences = await detectSilences(inputPath, options.silenceDb || -35, options.silenceMin || 0.4);
    const segments = silencesToSegments(silences, duration);

    let current = inputPath;

    if (silences.length > 0) {
      const listFile = `${base}_list.txt`;
      const parts = [];
      for (let i = 0; i < segments.length; i++) {
        const [start, end] = segments[i];
        const part = `${base}_part${i}.mp4`;
        await runFfmpegCommand(`ffmpeg -y -ss ${start} -to ${end} -i "${current}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${part}"`);
        parts.push(part);
        tmp.push(part);
      }
      fs.writeFileSync(listFile, parts.map(p => `file '${p}'`).join('\n'));
      tmp.push(listFile);

      const cut = `${base}_cut.mp4`;
      await runFfmpegCommand(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${cut}"`);
      tmp.push(cut);
      current = cut;
    }

    updateJob(jobId, { step: 'Normalizando áudio...', progress: 35 });

    // PASSO 2 — Normalizar áudio
    if (options.normalize !== false) {
      const norm = `${base}_norm.mp4`;
      await runFfmpegCommand(`ffmpeg -y -i "${current}" -af "loudnorm=I=-16:TP=-1.5:LRA=11" -c:v copy "${norm}"`);
      tmp.push(norm);
      current = norm;
    }

    updateJob(jobId, { step: 'Aplicando color grade...', progress: 50 });

    // PASSO 3 — Color grade
    const filtros = {
      cinematico: 'eq=contrast=1.15:brightness=0.02:saturation=1.1,unsharp=5:5:0.8',
      quente:     'eq=contrast=1.1:brightness=0.03:saturation=1.2,colorbalance=rs=0.05:gs=0:bs=-0.05',
      frio:       'eq=contrast=1.2:saturation=0.95,colorbalance=rs=-0.05:gs=0:bs=0.08',
      vivo:       'eq=contrast=1.25:brightness=0.05:saturation=1.4',
      suave:      'eq=contrast=1.05:brightness=0.04:saturation=1.05',
    };
    const filtro = filtros[options.visualFilter || 'cinematico'];
    if (filtro) {
      const visual = `${base}_visual.mp4`;
      await runFfmpegCommand(`ffmpeg -y -i "${current}" -vf "${filtro}" -c:a copy "${visual}"`);
      tmp.push(visual);
      current = visual;
    }

    updateJob(jobId, { step: 'Transcrevendo áudio com IA...', progress: 65 });

    // PASSO 4 — Legendas via Whisper (se disponível)
    let srtPath = null;
    let subtitles = [];
    // A integração com Whisper diretamente em um ambiente como Railway pode ser complexa
    // devido à necessidade de Python, modelos de IA e dependências específicas.
    // Para uma solução mais robusta e escalável, considere:
    // 1. Usar um serviço de transcrição de áudio baseado em nuvem (ex: Google Cloud Speech-to-Text, AWS Transcribe).
    // 2. Executar o Whisper em um serviço separado (ex: um worker em Python) e integrar via API.
    // 3. Garantir que o ambiente do Railway tenha Python, pip, e o modelo Whisper instalados e configurados corretamente.
    // Por simplicidade e robustez para o Railway, esta seção será comentada ou adaptada para um placeholder.
    // Se o Whisper for essencial, será necessário um setup mais avançado no ambiente de deploy.
    /*
    try {
      const srt = `${base}.srt`;
      // O comando whisper pode precisar de ajustes dependendo da instalação no Railway
      await runFfmpegCommand(`whisper "${current}" --model base --language ${options.language || 'pt'} --output_format srt --output_dir "${OUTPUT_DIR}" --task transcribe`);
      const whisperOut = path.join(OUTPUT_DIR, path.basename(current, path.extname(current)) + '.srt');
      if (fs.existsSync(whisperOut)) {
        fs.renameSync(whisperOut, srt);
        srtPath = srt;
        const srtContent = fs.readFileSync(srt, 'utf8');
        const blocks = srtContent.trim().split(/\n\n+/);
        subtitles = blocks.map(b => {
          const lines = b.trim().split('\n');
          if (lines.length < 3) return null;
          const times = lines[1].split(' --> ');
          return { start: srtToSec(times[0]), end: srtToSec(times[1]), text: lines.slice(2).join(' ') };
        }).filter(Boolean);
      }
    } catch (e) {
      console.log('Whisper não disponível ou falhou:', e.message?.slice(0, 100));
    }
    */

    updateJob(jobId, { step: 'Queimando legendas no vídeo...', progress: 80 });

    // PASSO 5 — Queimar legendas
    // Esta etapa só será executada se houver um srtPath (ou seja, se o Whisper funcionar ou se legendas forem fornecidas de outra forma)
    if (srtPath && options.burnSubtitles !== false) {
      const styled = `${base}_sub.mp4`;
      const style = 'FontName=Arial,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Bold=1,Outline=2,Shadow=1,Alignment=2,MarginV=30';
      try {
        await runFfmpegCommand(`ffmpeg -y -i "${current}" -vf "subtitles='${srtPath}':force_style='${style}'" -c:a copy "${styled}"`);
        tmp.push(styled);
        current = styled;
      } catch (e) {
        console.error('Erro ao queimar legendas (libass pode não estar disponível):', e.message);
        // Continua sem legendas queimadas se falhar
      }
    }

    updateJob(jobId, { step: 'Análise com IA...', progress: 90 });

    // PASSO 6 — Análise Claude
    let analysis = null;
    if (ANTHROPIC_API_KEY) {
      try {
        const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
        const durFinal = await ffprobe(current); // Usar await aqui
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: `Analise este vídeo editado automaticamente:\n- Duração original: ${duration.toFixed(1)}s\n- Duração final: ${durFinal.toFixed(1)}s\n- Silêncios removidos: ${silences.length}\n- Legendas: ${subtitles.length} blocos\n\nRetorne JSON:\n{\"titulo\": \"...\", \"descricao\": \"...\", \"tags\": [\"...\"], \"score\": 85, \"recomendacoes\": [\"...\"]}`
          }]
        });
        const text = msg.content[0].text.replace(/```json|```/g, '').trim();
        analysis = JSON.parse(text);
      } catch (e) {
        console.log('Análise IA falhou:', e.message?.slice(0, 80));
      }
    }

    // PASSO 7 — Mover para output final
    const finalPath = `${base}_final.mp4`;
    fs.copyFileSync(current, finalPath);

    // Limpar temporários
    tmp.forEach(f => { try { fs.unlinkSync(f); } catch (e) { console.error(`Erro ao remover arquivo temporário ${f}:`, e.message); } });
    try { fs.unlinkSync(inputPath); } catch (e) { console.error(`Erro ao remover arquivo de entrada ${inputPath}:`, e.message); }

    const durFinal = await ffprobe(finalPath); // Usar await aqui

    updateJob(jobId, {
      status: 'done',
      step: 'Concluído!',
      progress: 100,
      result: {
        videoUrl: `/download/${jobId}/video`,
        srtUrl: srtPath ? `/download/${jobId}/srt` : null,
        duration: { original: duration, final: durFinal, saved: duration - durFinal },
        silencesCut: silences.length,
        subtitles,
        analysis,
      }
    });

  } catch (err) {
    tmp.forEach(f => { try { fs.unlinkSync(f); } catch (e) { console.error(`Erro ao remover arquivo temporário em erro ${f}:`, e.message); } });
    try { fs.unlinkSync(inputPath); } catch (e) { console.error(`Erro ao remover arquivo de entrada em erro ${inputPath}:`, e.message); }
    updateJob(jobId, { status: 'error', step: 'Erro no processamento', error: String(err) });
    console.error('Job error:', err);
  }
}

// ── ROTAS ─────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (_, res) => res.json({ status: 'VÍDEO.AI Backend online 🎬' }));

// Upload e iniciar processamento
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum vídeo enviado' });

  const jobId = uuidv4();
  const options = {
    silenceDb:     parseFloat(req.body.silenceDb  || -35),
    silenceMin:    parseFloat(req.body.silenceMin || 0.4),
    normalize:     req.body.normalize     !== 'false',
    visualFilter:  req.body.visualFilter  || 'cinematico',
    language:      req.body.language      || 'pt',
    burnSubtitles: req.body.burnSubtitles !== 'false',
  };

  jobs[jobId] = { status: 'queued', progress: 0, step: 'Na fila...', createdAt: Date.now() };
  res.json({ jobId });

  // Processar em background
  processVideo(jobId, req.file.path, options).catch(console.error);
});

// Status do job
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json(job);
});

// Download vídeo final
app.get('/download/:jobId/video', (req, res) => {
  const file = path.join(OUTPUT_DIR, `${req.params.jobId}_final.mp4`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Arquivo não encontrado' });
  res.download(file, 'video_editado.mp4');
});

// Download SRT
app.get('/download/:jobId/srt', (req, res) => {
  const file = path.join(OUTPUT_DIR, `${req.params.jobId}.srt`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'SRT não encontrado' });
  res.download(file, 'legendas.srt');
});

app.listen(PORT, () => console.log(`🎬 VÍDEO.AI Backend rodando na porta ${PORT}`));
