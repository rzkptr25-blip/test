/**
 * MiniMax H3 REF2VA Studio — Fullstack Production Server
 * Menjalankan frontend static (public/index.html), Reverse Proxy REST + WebSocket
 * ke ComfyUI, serta penyimpanan riwayat hasil video (data/jobs.json).
 */
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const COMFYUI_URL = (process.env.COMFYUI_URL || 'https://wolfgg.online').replace(/\/+$/, '');
const COMFYUI_WS_URL = COMFYUI_URL.replace(/^http/i, 'ws');
const DATA_DIR = path.join(__dirname, 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(JOBS_FILE)) fs.writeFileSync(JOBS_FILE, '[]', 'utf8');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Helper baca/tulis riwayat video server
function readJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs.slice(0, 100), null, 2), 'utf8');
}

// 1. Healthcheck (dideteksi otomatis oleh frontend untuk mengaktifkan Fullstack Proxy)
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    fullstack: true,
    service: 'MiniMax H3 REF2VA Fullstack',
    upstream: COMFYUI_URL,
    timestamp: new Date().toISOString()
  });
});

// 2. Persistent Video Jobs History API
app.get('/api/jobs', (req, res) => {
  res.json(readJobs());
});

app.post('/api/jobs', express.json({ limit: '2mb' }), (req, res) => {
  const job = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ...req.body,
    createdAt: new Date().toISOString()
  };
  const jobs = readJobs();
  jobs.unshift(job);
  writeJobs(jobs);
  res.status(201).json(job);
});

app.delete('/api/jobs', (req, res) => {
  writeJobs([]);
  res.json({ cleared: true });
});

// 3. Universal ComfyUI REST Proxy (/api/comfy/* -> COMFYUI_URL/*)
// Mendukung JSON, multipart upload (/upload/image), dan streaming video (/view)
app.all('/api/comfy/*', async (req, res) => {
  try {
    const targetPath = req.originalUrl.replace(/^\/api\/comfy/, '');
    const targetUrl = `${COMFYUI_URL}${targetPath}`;

    const headers = {};
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers['accept']) headers['accept'] = req.headers['accept'];
    if (req.headers['range']) headers['range'] = req.headers['range'];

    let body = undefined;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body
    });

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, key) => {
      if (!['transfer-encoding', 'content-encoding', 'connection'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    if (upstreamRes.body) {
      const reader = upstreamRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (err) {
    console.error('[Proxy Error]', err.message);
    res.status(502).json({ error: { message: `Upstream ComfyUI tidak dapat dijangkau: ${err.message}` } });
  }
});

// Fallback SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 4. WebSocket Bridge (/ws/comfy -> COMFYUI_WS_URL/ws)
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  if (urlObj.pathname === '/ws/comfy') {
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      const clientId = urlObj.searchParams.get('clientId') || '';
      const upstreamWsUrl = `${COMFYUI_WS_URL}/ws${clientId ? '?clientId=' + encodeURIComponent(clientId) : ''}`;
      const upstreamWs = new WebSocket(upstreamWsUrl);

      upstreamWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on('message', (data, isBinary) => {
        if (upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data, { binary: isBinary });
        }
      });

      const closeBoth = () => {
        try { clientWs.close(); } catch {}
        try { upstreamWs.close(); } catch {}
      };

      upstreamWs.on('close', closeBoth);
      upstreamWs.on('error', closeBoth);
      clientWs.on('close', closeBoth);
      clientWs.on('error', closeBoth);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[REF2VA Fullstack] Berjalan di http://0.0.0.0:${PORT}`);
  console.log(`[REF2VA Fullstack] Upstream ComfyUI: ${COMFYUI_URL}`);
});
