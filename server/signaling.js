'use strict';
/**
 * StreamParty WebSocket Signaling
 * Handles: WebRTC signaling (main + cam), BRB, countdown, kick, mute, permissions, chat
 */
const { WebSocket } = require('ws');
const crypto = require('crypto');
const db     = require('./db');
const jwt    = require('jsonwebtoken');

const SECRET     = process.env.JWT_SECRET  || 'CHANGE_THIS_SECRET_IN_ENV';
const MAX_GUESTS = parseInt(process.env.MAX_GUESTS  || '50');
const ROOM_TTL   = parseInt(process.env.ROOM_TTL_MS || '14400000');
const MSG_RATE   = 3; // max chat per 5s

const rooms = new Map(); // Map<code, Room>

function attach(wss) {
  wss.on('connection', (ws, req) => {
    ws.peerId   = crypto.randomBytes(6).toString('hex');
    ws.isAlive  = true;
    ws.msgCount = 0;
    ws.msgReset = null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    log(`connect ${ws.peerId} ${ip}`);
    ws.on('pong',    ()    => { ws.isAlive = true; });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } handle(ws, m); });
    ws.on('close',   ()    => disconnect(ws));
    ws.on('error',   (e)   => log(`error ${ws.peerId}: ${e.message}`));
    send(ws, { type: 'hello', peerId: ws.peerId });
  });
}

async function handle(ws, msg) {
  switch (msg.type) {

    case 'host-open': {
      try {
        const payload = jwt.verify(msg.token, SECRET);
        const user    = await db.one(`SELECT id, display_name, is_banned FROM users WHERE id=?`, [payload.sub]);
        if (!user || user.is_banned) { send(ws, { type:'error', code:'FORBIDDEN', message:'Account banned' }); return; }
        const stream  = await db.one(`SELECT * FROM streams WHERE room_code=?`, [msg.roomCode?.toUpperCase()]);
        if (!stream) { send(ws, { type:'error', code:'NOT_FOUND', message:'Stream not found' }); return; }
        if (stream.host_id !== user.id) { send(ws, { type:'error', code:'FORBIDDEN', message:'Not your stream' }); return; }
        const code = stream.room_code;
        let room = rooms.get(code);
        if (!room) {
          room = { code, streamId: stream.id, host: null, hostId: ws.peerId, guests: new Map(),
            state: { isLive: false, isBrb: false, brbMsg: '', countdown: null,
              permissions: { allow_guest_cam: !!stream.allow_guest_cam, allow_guest_mic: !!stream.allow_guest_mic, allow_guest_screen: !!stream.allow_guest_screen, allow_chat: !!stream.allow_chat } },
            timer: null };
          room.timer = setTimeout(() => expireRoom(code), ROOM_TTL);
          rooms.set(code, room);
        }
        room.host = ws; room.hostId = ws.peerId;
        ws.roomCode = code; ws.role = 'host'; ws.name = user.display_name; ws.userId = user.id;
        send(ws, { type: 'room-opened', roomCode: code, peerId: ws.peerId, state: room.state });
        log(`host-open ${code} uid=${user.id}`);
      } catch (e) { send(ws, { type:'error', code:'AUTH_FAILED', message:'Invalid token' }); }
      break;
    }

    case 'guest-join': {
      const code = (msg.roomCode || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
      const room = rooms.get(code);
      if (!room)            { send(ws, { type:'error', code:'NO_ROOM', message:'Room not found.' }); return; }
      if (!room.host || room.host.readyState !== WebSocket.OPEN) { send(ws, { type:'error', code:'NO_HOST', message:"Host isn't connected yet." }); return; }
      if (room.guests.size >= MAX_GUESTS) { send(ws, { type:'error', code:'FULL', message:'Room is full.' }); return; }
      ws.roomCode = code; ws.role = 'guest'; ws.name = san(msg.name) || 'Viewer'; ws.userId = msg.userId || null;
      room.guests.set(ws.peerId, ws);
      await db.q(`INSERT INTO stream_guests (stream_id, user_id, peer_id, display_name) VALUES (?,?,?,?)`, [room.streamId, ws.userId, ws.peerId, ws.name]).catch(()=>{});
      send(ws, { type:'room-joined', roomCode: code, peerId: ws.peerId, hostPeerId: room.host.peerId, guestCount: room.guests.size, roomState: room.state });
      send(room.host, { type:'guest-arrived', guestPeerId: ws.peerId, guestName: ws.name, guestCount: room.guests.size });
      bcastGuests(room, ws.peerId, { type:'viewer-count', count: room.guests.size });
      await db.q(`UPDATE streams SET viewer_count=?, peak_viewers=GREATEST(peak_viewers,?) WHERE id=?`, [room.guests.size, room.guests.size, room.streamId]).catch(()=>{});
      log(`guest-join ${code} "${ws.name}" (${room.guests.size})`);
      break;
    }

    // Main stream WebRTC
    case 'offer':  { if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); const g=r?.guests.get(msg.targetPeerId); if(g) send(g,{type:'offer',offer:msg.offer,hostPeerId:ws.peerId}); break; }
    case 'answer': { if(ws.role!=='guest')return; const r=rooms.get(ws.roomCode); if(r?.host) send(r.host,{type:'answer',answer:msg.answer,guestPeerId:ws.peerId}); break; }
    case 'ice': {
      const r=rooms.get(ws.roomCode); if(!r)return;
      if(ws.role==='host'){ const g=r.guests.get(msg.targetPeerId); if(g) send(g,{type:'ice',candidate:msg.candidate,fromPeerId:ws.peerId}); }
      else { if(r.host) send(r.host,{type:'ice',candidate:msg.candidate,fromPeerId:ws.peerId}); }
      break;
    }

    // Guest cam WebRTC
    case 'cam-offer':  { if(ws.role!=='guest')return; const r=rooms.get(ws.roomCode); if(!r?.state.permissions.allow_guest_cam)return; if(r?.host) send(r.host,{type:'cam-offer',offer:msg.offer,fromPeerId:ws.peerId,name:ws.name}); break; }
    case 'cam-answer': {
      const r=rooms.get(ws.roomCode); if(!r)return;
      if(ws.role==='host'){ const g=r.guests.get(msg.targetPeerId); if(g) send(g,{type:'cam-answer',answer:msg.answer,fromPeerId:ws.peerId}); }
      else { if(r.host) send(r.host,{type:'cam-answer',answer:msg.answer,fromPeerId:ws.peerId,targetPeerId:msg.targetPeerId}); }
      break;
    }
    case 'cam-ice': {
      const r=rooms.get(ws.roomCode); if(!r)return;
      if(ws.role==='host'){ const g=r.guests.get(msg.targetPeerId); if(g) send(g,{type:'cam-ice',candidate:msg.candidate,fromPeerId:ws.peerId}); }
      else { if(r.host) send(r.host,{type:'cam-ice',candidate:msg.candidate,fromPeerId:ws.peerId,targetPeerId:msg.targetPeerId}); }
      break;
    }

    // Chat
    case 'chat': {
      const r=rooms.get(ws.roomCode); if(!r||!r.state.permissions.allow_chat)return;
      ws.msgCount=(ws.msgCount||0)+1;
      if(!ws.msgReset) ws.msgReset=setTimeout(()=>{ws.msgCount=0;ws.msgReset=null;},5000);
      if(ws.msgCount>MSG_RATE) return;
      const text=san(msg.text); if(!text||text.length>500) return;
      await db.q(`INSERT INTO chat_messages (stream_id, user_id, peer_id, display_name, message) VALUES (?,?,?,?,?)`, [r.streamId, ws.userId, ws.peerId, ws.name, text]).catch(()=>{});
      bcastAll(r, null, { type:'chat', peerId:ws.peerId, name:ws.name, role:ws.role, text, ts:Date.now() });
      break;
    }

    // Stream live/ended
    case 'stream-live': { if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return; r.state.isLive=true; await db.q(`UPDATE streams SET is_live=1, started_at=NOW() WHERE id=?`,[r.streamId]).catch(()=>{}); bcastGuests(r,null,{type:'stream-live',hostName:ws.name}); break; }
    case 'stream-ended': { if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return; r.state.isLive=false; r.state.isBrb=false; r.state.countdown=null; await db.q(`UPDATE streams SET is_live=0, ended_at=NOW(), viewer_count=0 WHERE id=?`,[r.streamId]).catch(()=>{}); bcastGuests(r,null,{type:'stream-ended'}); break; }

    // BRB
    case 'brb-on':  { if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return; r.state.isBrb=true; r.state.brbMsg=san(msg.message)||'Back Soon'; bcastGuests(r,null,{type:'brb-on',message:r.state.brbMsg,hostName:ws.name}); break; }
    case 'brb-off': { if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return; r.state.isBrb=false; r.state.brbMsg=''; bcastGuests(r,null,{type:'brb-off'}); break; }

    // Countdown
    case 'countdown-start': {
      if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return;
      const secs=Math.min(Math.max(parseInt(msg.seconds)||5,3),60);
      r.state.countdown={startedAt:Date.now(),seconds:secs};
      bcastGuests(r,null,{type:'countdown-start',seconds:secs,startedAt:r.state.countdown.startedAt});
      setTimeout(()=>{ const rr=rooms.get(ws.roomCode); if(rr?.state.countdown) rr.state.countdown=null; },(secs+3)*1000);
      break;
    }
    case 'countdown-cancel': { if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return; r.state.countdown=null; bcastGuests(r,null,{type:'countdown-cancel'}); break; }

    // Kick
    case 'kick-guest': {
      if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return;
      const g=r.guests.get(msg.guestPeerId);
      if(g){send(g,{type:'kicked',reason:san(msg.reason)||'Removed by host'}); g.close();}
      r.guests.delete(msg.guestPeerId);
      bcastGuests(r,null,{type:'guest-removed',guestPeerId:msg.guestPeerId,guestCount:r.guests.size});
      await db.q(`UPDATE stream_guests SET kicked_at=NOW() WHERE stream_id=? AND peer_id=?`,[r.streamId,msg.guestPeerId]).catch(()=>{});
      break;
    }

    // Mute
    case 'mute-guest': {
      if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); const g=r?.guests.get(msg.guestPeerId);
      if(g) send(g,{type:'host-mute',muted:!!msg.muted});
      break;
    }

    // Permissions
    case 'update-permissions': {
      if(ws.role!=='host')return; const r=rooms.get(ws.roomCode); if(!r)return;
      const perms=msg.permissions||{}; const keys=['allow_guest_cam','allow_guest_mic','allow_guest_screen','allow_chat'];
      for(const k of keys){ if(perms[k]!==undefined) r.state.permissions[k]=!!perms[k]; }
      bcastAll(r,null,{type:'permissions-updated',permissions:r.state.permissions});
      await db.q(`UPDATE streams SET allow_guest_cam=?,allow_guest_mic=?,allow_guest_screen=?,allow_chat=? WHERE id=?`,
        [r.state.permissions.allow_guest_cam?1:0, r.state.permissions.allow_guest_mic?1:0, r.state.permissions.allow_guest_screen?1:0, r.state.permissions.allow_chat?1:0, r.streamId]).catch(()=>{});
      break;
    }
  }
}

async function disconnect(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  if (ws.role === 'host') {
    log(`host-off ${ws.roomCode}`);
    bcastGuests(room, null, { type:'host-disconnected' });
    room.host = null; room.state.isBrb = false; room.state.countdown = null;
    setTimeout(() => { const r=rooms.get(ws.roomCode); if(r&&(!r.host||r.host.readyState!==WebSocket.OPEN)){clearTimeout(r.timer);rooms.delete(ws.roomCode);log(`closed ${ws.roomCode}`);} }, 30000);
  } else if (ws.role === 'guest') {
    room.guests.delete(ws.peerId);
    log(`left ${ws.roomCode} "${ws.name}" (${room.guests.size})`);
    if(room.host) send(room.host,{type:'guest-left',guestPeerId:ws.peerId,guestName:ws.name,guestCount:room.guests.size});
    bcastGuests(room, ws.peerId, { type:'viewer-count', count:room.guests.size });
    await db.q(`UPDATE stream_guests SET left_at=NOW() WHERE stream_id=? AND peer_id=? AND left_at IS NULL`,[room.streamId,ws.peerId]).catch(()=>{});
    await db.q(`UPDATE streams SET viewer_count=? WHERE id=?`,[room.guests.size,room.streamId]).catch(()=>{});
  }
}

function expireRoom(code) {
  const room = rooms.get(code); if(!room)return;
  bcastAll(room, null, { type:'stream-ended', reason:'expired' });
  rooms.delete(code); log(`expire ${code}`);
}

function kickUser(userId) {
  for (const room of rooms.values()) {
    room.guests.forEach((ws,peerId) => { if(ws.userId===userId){ send(ws,{type:'kicked',reason:'Removed by admin'}); ws.close(); room.guests.delete(peerId); bcastGuests(room,null,{type:'guest-removed',guestPeerId:peerId,guestCount:room.guests.size}); } });
    if(room.host?.userId===userId){ bcastGuests(room,null,{type:'stream-ended',reason:'Host removed by admin'}); room.host?.close(); }
  }
}
function getStats() { let g=0; rooms.forEach(r=>{ g+=r.guests.size; }); return { rooms: rooms.size, guests: g }; }
function shutdown() { rooms.forEach(r=>bcastAll(r,null,{type:'stream-ended',reason:'restart'})); }

function send(ws, data) { if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function bcastGuests(room, ex, d) { room.guests.forEach((g,id)=>{ if(id!==ex) send(g,d); }); }
function bcastAll(room, ex, d)    { if(room.host?.peerId!==ex) send(room.host,d); bcastGuests(room,ex,d); }
function san(s) { return typeof s==='string' ? s.replace(/[<>"'`]/g,'').trim().slice(0,500) : ''; }
function log(m) { console.log(`${new Date().toISOString()} [ws] ${m}`); }

module.exports = { attach, kickUser, getStats, shutdown };
