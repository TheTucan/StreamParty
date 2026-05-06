'use strict';
const router = require('express').Router();
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get('/stats', async (_, res) => {
  try {
    const [users]   = await db.q(`SELECT COUNT(*) AS c FROM users`);
    const [streams] = await db.q(`SELECT COUNT(*) AS c FROM streams`);
    const [live]    = await db.q(`SELECT COUNT(*) AS c FROM streams WHERE is_live=1`);
    const [banned]  = await db.q(`SELECT COUNT(*) AS c FROM users WHERE is_banned=1`);
    res.json({ total_users: users[0].c, total_streams: streams[0].c, live_streams: live[0].c, banned_users: banned[0].c });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/users', async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const limit = 50; const offset = (Math.max(1,+page)-1)*limit;
    let where = '1=1'; const params = [];
    if (search) { where += ` AND (email LIKE ? OR display_name LIKE ?)`; const q=`%${search}%`; params.push(q,q); }
    const rows = await db.ex(`SELECT id, email, display_name, avatar_color, role, is_banned, created_at FROM users WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    const [cnt] = await db.q(`SELECT COUNT(*) AS total FROM users WHERE ${where}`, params);
    res.json({ users: rows, total: cnt[0].total, page: +page });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.patch('/users/:id', async (req, res) => {
  try {
    const { is_banned, role } = req.body;
    const updates = []; const vals = [];
    if (is_banned !== undefined) { updates.push('is_banned=?'); vals.push(is_banned?1:0); }
    if (role !== undefined && ['user','admin'].includes(role)) { updates.push('role=?'); vals.push(role); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await db.q(`UPDATE users SET ${updates.join(',')} WHERE id=?`, vals);
    await db.q(`INSERT INTO audit_log (admin_id, action, target_type, target_id, detail) VALUES (?,?,?,?,?)`, [req.user.id, is_banned?'ban_user':'update_user', 'user', req.params.id, JSON.stringify({is_banned,role})]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/streams', async (req, res) => {
  try {
    const { page = 1 } = req.query; const limit = 50; const offset = (Math.max(1,+page)-1)*limit;
    const rows = await db.ex(`SELECT s.id, s.room_code, s.title, s.is_live, s.is_public, s.viewer_count, s.created_at, u.display_name AS host_name, u.email AS host_email FROM streams s JOIN users u ON u.id=s.host_id ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [limit, offset]);
    const [cnt] = await db.q(`SELECT COUNT(*) AS total FROM streams`);
    res.json({ streams: rows, total: cnt[0].total, page: +page });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/streams/:id/end', async (req, res) => {
  await db.q(`UPDATE streams SET is_live=0, ended_at=NOW() WHERE id=?`, [req.params.id]);
  await db.q(`INSERT INTO audit_log (admin_id, action, target_type, target_id) VALUES (?,?,?,?)`, [req.user.id, 'force_end_stream', 'stream', req.params.id]);
  res.json({ ok: true });
});

router.get('/audit', async (_, res) => {
  try {
    const rows = await db.ex(`SELECT a.*, u.display_name AS admin_name FROM audit_log a LEFT JOIN users u ON u.id=a.admin_id ORDER BY a.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/chat/:id', async (req, res) => {
  await db.q(`UPDATE chat_messages SET is_deleted=1 WHERE id=?`, [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
