const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.use(cors());
app.use(express.json());

// ── TESTE SIMPLES (IMPORTANTE) ──
app.get('/test', (req, res) => {
  res.json({ ok: true });
});

// ── Health check ──
app.get('/', (_, res) => {
  res.json({ status: 'VÍDEO.AI Backend online 🎬' });
});

// ── Pastas ──
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

[UPLOAD_DIR, OUTPUT_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Upload ──
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_, file, cb) => {
    cb(null, `${uuidv4()}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }
});

// ── Jobs ──
const jobs = {};

function updateJob(id, data) {
  jobs[id] = { ...jobs[id], ...data, updatedAt: Date.now() };
}

// ── ROTA SIMPLES (SEM PROCESSAMENTO PESADO) ──
app.post('/upload', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum vídeo enviado' });
  }

  const jobId = uuidv4();

  jobs[jobId] = {
    status: 'done',
    progress: 100,
    step: 'Upload concluído (modo simples)',
    result: {
      message: 'Servidor funcionando sem processamento pesado 🚀'
    }
  };

  res.json({ jobId });
});

// ── STATUS ──
app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json(job);
});

// ── START ──
app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
