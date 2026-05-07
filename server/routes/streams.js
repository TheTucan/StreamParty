'use strict';
const router  = require('express').Router();
const multer  = require('multer');
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
const { requireAuth, requireHost, optionalAuth } = require('../middleware/auth');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2*1024*1024 },
  fileFilter: (_, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

// FIX: Return { live, recent } shape that the frontend index.html expects
router.get('/', optionalAuth, async (req, res) => {
  try {
    const { q, search, page = 1 } = req.query;
    const searchTerm = q || search;
    const limit = 24; const offset = (Math.max(1,+page)-1)*limit;
    const params = [];
    let where = `s.is_public = 1`;
    if (searchTerm) { where += ` AND (s.title LIKE ? OR u.display_name LIKE ?)`; const sq=`%${searchTerm}%`; params.push(sq,sq); }

    const allRows = await db.ex(
      `SELECT s.id, s.room_code, s.title, s.description, s.is_live, s.viewer_count,
              s.thumbnail_url, s.started_at, s.ended_at, s.source_type,
              u.display_name AS host_name, u.avatar_color AS host_color
       FROM streams s JOIN users u ON u.id = s.host_id
       WHERE ${where}
       ORDER BY s.is_live DESC, s.viewer_count DESC, s.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const live   = allRows.filter(r => r.is_live);
    const recent = allRows.filter(r => !r.is_live);

    res.json({ live, recent, total: allRows.length, page: +page, limit });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.get('/stats', async (_, res) => {
  try {
    const row = await db.one(`SELECT COUNT(*) AS total_streams, SUM(is_live) AS live_streams, SUM(viewer_count) AS watching FROM streams WHERE is_public=1`);
    res.json(row);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/mine', requireAuth, async (req, res) => {
  try {
    const rows = await db.ex(`SELECT id, room_code, title, is_public, is_live, viewer_count, peak_viewers, thumbnail_url, started_at, ended_at, created_at FROM streams WHERE host_id=? ORDER BY created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.get('/:code', optionalAuth, async (req, res) => {
  try {
    const row = await db.one(`SELECT s.*, u.display_name AS host_name, u.avatar_color AS host_color, u.id AS host_user_id FROM streams s JOIN users u ON u.id=s.host_id WHERE s.room_code=?`, [req.params.code.toUpperCase()]);
    if (!row) return res.status(404).json({ error: 'Stream not found' });
    // Allow host to always see their own private stream
    if (!row.is_public && (!req.user || req.user.id !== row.host_id)) return res.status(403).json({ error: 'Private stream' });

    // Attach recent chat
    try {
      const chat = await db.ex(`SELECT cm.display_name, cm.message, cm.created_at AS sent_at FROM chat_messages cm WHERE cm.stream_id=? AND cm.is_deleted=0 ORDER BY cm.created_at DESC LIMIT 50`, [row.id]);
      row.recent_chat = chat.reverse();
    } catch { row.recent_chat = []; }

    res.json(row);
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const { title='Live Stream', description='', is_public=1, source_type='screen', allow_guest_cam=1, allow_guest_mic=1, allow_guest_screen=0, allow_chat=1, max_guests=50 } = req.body;
    const code = makeCode();
    const [result] = await db.q(`INSERT INTO streams (host_id, room_code, title, description, is_public, source_type, allow_guest_cam, allow_guest_mic, allow_guest_screen, allow_chat, max_guests) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [req.user.id, code, title.slice(0,120), description.slice(0,500), is_public?1:0, source_type, allow_guest_cam?1:0, allow_guest_mic?1:0, allow_guest_screen?1:0, allow_chat?1:0, Math.min(200,Math.max(1,+max_guests))]);
    res.status(201).json({ id: result.insertId, room_code: code });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

router.patch('/:code', requireAuth, requireHost, async (req, res) => {
  try {
    const allowed = ['title','description','is_public','is_live','allow_guest_cam','allow_guest_mic','allow_guest_screen','allow_chat','max_guests'];
    const updates = []; const vals = [];
    for (const k of allowed) { if (req.body[k] !== undefined) { updates.push(`${k}=?`); vals.push(req.body[k]); } }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.stream.id);
    await db.q(`UPDATE streams SET ${updates.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/:code', requireAuth, requireHost, async (req, res) => {
  await db.q(`DELETE FROM streams WHERE id=?`, [req.stream.id]);
  res.json({ ok: true });
});

router.get('/:code/guests', requireAuth, requireHost, async (req, res) => {
  const rows = await db.ex(`SELECT g.id, g.peer_id, g.display_name, g.joined_at, g.kicked_at, g.is_muted_by_host, u.email, u.avatar_color FROM stream_guests g LEFT JOIN users u ON u.id=g.user_id WHERE g.stream_id=? AND g.left_at IS NULL AND g.kicked_at IS NULL ORDER BY g.joined_at`, [req.stream.id]);
  res.json(rows);
});

router.post('/:code/kick', requireAuth, requireHost, async (req, res) => {
  const { peer_id, reason = '' } = req.body;
  if (!peer_id) return res.status(400).json({ error: 'peer_id required' });
  await db.q(`UPDATE stream_guests SET kicked_at=NOW(), kicked_reason=? WHERE stream_id=? AND peer_id=?`, [reason.slice(0,200), req.stream.id, peer_id]);
  res.json({ ok: true });
});

router.post('/:code/mute', requireAuth, requireHost, async (req, res) => {
  const { peer_id, muted } = req.body;
  if (!peer_id) return res.status(400).json({ error: 'peer_id required' });
  await db.q(`UPDATE stream_guests SET is_muted_by_host=? WHERE stream_id=? AND peer_id=?`, [muted?1:0, req.stream.id, peer_id]);
  res.json({ ok: true });
});

router.post('/:code/snapshot', requireAuth, requireHost, upload.single('snap'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image' });
    const fname = `snap_${req.stream.id}_${Date.now()}.jpg`;
    const fpath = path.join(UPLOAD_DIR, fname);
    await sharp(req.file.buffer).resize(640, 360, { fit: 'cover' }).jpeg({ quality: 72 }).toFile(fpath);
    const url = `/uploads/${fname}`;
    await db.q(`UPDATE streams SET thumbnail_url=? WHERE id=?`, [url, req.stream.id]);
    try { await db.q(`INSERT INTO stream_snapshots (stream_id, filename) VALUES (?,?)`, [req.stream.id, fname]); } catch {}
    const old = await db.ex(`SELECT filename FROM stream_snapshots WHERE stream_id=? ORDER BY taken_at DESC LIMIT 999 OFFSET 10`, [req.stream.id]);
    for (const r of old) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.filename)); } catch(_) {} await db.q(`DELETE FROM stream_snapshots WHERE stream_id=? AND filename=?`, [req.stream.id, r.filename]); }
    res.json({ ok: true, url });
  } catch (err) { console.error('[snapshot]', err); res.status(500).json({ error: 'Server error' }); }
});

router.get('/:code/chat', optionalAuth, async (req, res) => {
  try {
    const stream = await db.one(`SELECT id FROM streams WHERE room_code=?`, [req.params.code.toUpperCase()]);
    if (!stream) return res.status(404).json({ error: 'Not found' });
    const rows = await db.ex(`SELECT id, display_name, message, created_at FROM chat_messages WHERE stream_id=? AND is_deleted=0 ORDER BY created_at DESC LIMIT 50`, [stream.id]);
    res.json(rows.reverse());
  } catch { res.status(500).json({ error: 'Server error' }); }
});

const WORDS = ['NOVA','WOLF','DUSK','SILK','ECHO','FIRE','JAZZ','LUNE','MIST','PEAK','FLUX','NEON','VEIL','HAZE','BOLT','ARC','CYAN','DUNE'];
function makeCode() { const w=WORDS[Math.floor(Math.random()*WORDS.length)]; const n=10+Math.floor(Math.random()*90); return w+n; }

module.exports = router;
