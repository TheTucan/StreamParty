'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const signaling = require('./signaling');

const PORT   = process.env.PORT   || 3001;
const ORIGIN = process.env.ORIGIN || 'https://watch.relay.media';
const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: [ORIGIN, 'http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '5m' }));

const apiLimiter  = rateLimit({ windowMs: 60000, max: 120, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15*60000, max: 20, message: { error: 'Too many attempts, try again later.' } });
app.use('/api/', apiLimiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/streams', require('./routes/streams'));
app.use('/api/users',   require('./routes/users'));
app.use('/api/admin',   require('./routes/admin'));

app.get('/api/health', async (_, res) => {
  try { await db.q('SELECT 1'); const ws=signaling.getStats(); res.json({ status:'ok', db:'ok', ...ws, uptime: process.uptime() }); }
  catch { res.status(503).json({ status:'degraded' }); }
});
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
signaling.attach(wss);

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) { ws.terminate(); return; } ws.isAlive=false; ws.ping(); });
}, parseInt(process.env.PING_MS || '20000'));
wss.on('close', () => clearInterval(heartbeat));

function shutdown(sig) {
  console.log(`[server] shutdown ${sig}`); clearInterval(heartbeat); signaling.shutdown();
  server.close(() => { db.end().then(()=>process.exit(0)).catch(()=>process.exit(0)); });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] StreamParty on 127.0.0.1:${PORT} | origin:${ORIGIN}`);
});
