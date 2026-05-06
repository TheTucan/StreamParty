'use strict';
const router = require('express').Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

router.get('/:id', async (req, res) => {
  const user = await db.one(`SELECT id, display_name, avatar_color, created_at FROM users WHERE id=? AND is_banned=0`, [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

router.patch('/me', requireAuth, async (req, res) => {
  try {
    const { display_name, avatar_color } = req.body;
    const updates = []; const vals = [];
    if (display_name !== undefined) {
      if (display_name.length < 2 || display_name.length > 60) return res.status(400).json({ error: 'Display name must be 2-60 characters' });
      updates.push('display_name=?'); vals.push(display_name.trim());
    }
    if (avatar_color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(avatar_color)) return res.status(400).json({ error: 'Invalid color format' });
      updates.push('avatar_color=?'); vals.push(avatar_color);
    }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.user.id);
    await db.q(`UPDATE users SET ${updates.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/me/password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both current and new password required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = await db.one(`SELECT password_hash FROM users WHERE id=?`, [req.user.id]);
    const ok = await bcrypt.compare(current_password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
    const hash = await bcrypt.hash(new_password, 12);
    await db.q(`UPDATE users SET password_hash=? WHERE id=?`, [hash, req.user.id]);
    await db.q(`UPDATE sessions SET revoked_at=NOW() WHERE user_id=? AND revoked_at IS NULL`, [req.user.id]);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
