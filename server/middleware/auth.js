'use strict';
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');

const SECRET = process.env.JWT_SECRET || 'CHANGE_THIS_SECRET_IN_ENV';
const EXPIRES = process.env.JWT_EXPIRES || '7d';

function signToken(payload) { return jwt.sign(payload, SECRET, { expiresIn: EXPIRES }); }
function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

async function verifyToken(token) {
  const decoded = jwt.verify(token, SECRET);
  const h = hashToken(token);
  const sess = await db.one(`SELECT id FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at > NOW()`, [h]);
  if (!sess) throw new Error('Session revoked');
  return decoded;
}

async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const token = hdr.slice(7);
    const payload = await verifyToken(token);
    const user = await db.one(`SELECT id, email, display_name, avatar_color, role, is_banned FROM users WHERE id=?`, [payload.sub]);
    if (!user || user.is_banned) return res.status(403).json({ error: 'Account banned or not found' });
    req.user = user; req.token = token;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}

async function requireAdmin(req, res, next) {
  await requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

async function requireHost(req, res, next) {
  const code = req.params.code || req.body.roomCode;
  const stream = await db.one(`SELECT * FROM streams WHERE room_code=?`, [code]);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  if (stream.host_id !== req.user.id) return res.status(403).json({ error: 'Not your stream' });
  req.stream = stream;
  next();
}

async function optionalAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || '';
    if (!hdr.startsWith('Bearer ')) return next();
    const token = hdr.slice(7);
    const payload = await verifyToken(token);
    const user = await db.one(`SELECT id, email, display_name, avatar_color, role, is_banned FROM users WHERE id=?`, [payload.sub]);
    if (user && !user.is_banned) req.user = user;
  } catch {}
  next();
}

module.exports = { signToken, hashToken, requireAuth, requireAdmin, requireHost, optionalAuth };
