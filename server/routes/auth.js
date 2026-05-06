'use strict';
const router = require('express').Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { signToken, hashToken, requireAuth } = require('../middleware/auth');
const SALT_ROUNDS = 12;

router.post('/register', async (req, res) => {
  try {
    const { email, password, display_name, avatar_color } = req.body;
    if (!email || !password || !display_name) return res.status(400).json({ error: 'email, password and display_name are required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (display_name.length < 2 || display_name.length > 60) return res.status(400).json({ error: 'Display name must be 2-60 characters' });
    const exists = await db.one(`SELECT id FROM users WHERE email=?`, [email.toLowerCase()]);
    if (exists) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const colors = ['#00d4ff','#00e5a0','#ff6b6b','#ffd166','#c77dff','#ff9a3c','#06d6a0'];
    const color = avatar_color || colors[Math.floor(Math.random()*colors.length)];
    const [result] = await db.q(`INSERT INTO users (email, password_hash, display_name, avatar_color) VALUES (?,?,?,?)`, [email.toLowerCase(), hash, display_name.trim(), color]);
    const userId = result.insertId;
    const token = signToken({ sub: userId, role: 'user' });
    const expiry = new Date(Date.now() + 7*24*3600*1000);
    await db.q(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?,?)`, [userId, hashToken(token), expiry]);
    res.status(201).json({ token, user: { id: userId, email: email.toLowerCase(), display_name: display_name.trim(), avatar_color: color, role: 'user' } });
  } catch (err) { console.error('[register]', err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await db.one(`SELECT * FROM users WHERE email=?`, [email.toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    if (user.is_banned) return res.status(403).json({ error: 'Account suspended' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });
    const token = signToken({ sub: user.id, role: user.role });
    const expiry = new Date(Date.now() + 7*24*3600*1000);
    await db.q(`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?,?)`, [user.id, hashToken(token), expiry]);
    res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name, avatar_color: user.avatar_color, role: user.role } });
  } catch (err) { console.error('[login]', err); res.status(500).json({ error: 'Server error' }); }
});

router.post('/logout', requireAuth, async (req, res) => {
  await db.q(`UPDATE sessions SET revoked_at=NOW() WHERE token_hash=?`, [hashToken(req.token)]);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const { id, email, display_name, avatar_color, role } = req.user;
  res.json({ id, email, display_name, avatar_color, role });
});

module.exports = router;
