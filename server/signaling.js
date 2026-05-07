'use strict';
const { WebSocket } = require('ws');
const crypto = require('crypto');
const db     = require('./db');
const jwt    = require('jsonwebtoken');

const SECRET     = process.env.JWT_SECRET  || 'CHANGE_THIS_SECRET_IN_ENV';
const MAX_GUESTS = parseInt(process.env.MAX_GUESTS  || '50');
const ROOM_TTL   = parseInt(process.env.ROOM_TTL_MS || '14400000');
const MSG_RATE   = 3;
const rooms = new Map();

// Normalise DB keys → short client keys {cam,mic,screen,chat}
function normPerms(p) {
  return {
    cam:    !!(p.allow_guest_cam    !== undefined ? p.allow_guest_cam    : p.cam),
    mic:    !!(p.allow_guest_mic    !== undefined ? p.allow_guest_mic    : p.mic),
    screen: !!(p.allow_guest_screen !== undefined ? p.allow_guest_screen : p.screen),
    chat:   !!(p.allow_chat         !== undefined ? p.allow_chat         : p.chat),
  };
}
// Expand short keys → DB column names
function expandPerms(p) {
  return {
    allow_guest_cam:    !!(p.cam    !== undefined ? p.cam    : p.allow_guest_cam),
    allow_guest_mic:    !!(p.mic    !== undefined ? p.mic    : p.allow_guest_mic),
    allow_guest_screen: !!(p.screen !== undefined ? p.screen : p.allow_guest_screen),
    allow_chat:         !!(p.chat   !== undefined ? p.chat   : p.allow_chat),
  };
}

function attach(wss) {
  wss.on('connection', (ws, req) => {
    ws.peerId = crypto.randomBytes(6).toString('hex');
    ws.isAlive = true; ws.msgCount = 0; ws.msgReset = null;
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    log(`connect ${ws.peerId} ${ip}`);
    ws.on('pong',    () => { ws.isAlive = true; });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch { return; } handle(ws, m); });
    ws.on('close',   () => disconnect(ws));
    ws.on('error',   (e) => log(`error ${ws.peerId}: ${e.message}`));
    send(ws, { type:'hello', peerId:ws.peerId });
  });
  const hb = setInterval(() => {
    wss.clients.forEach(ws => { if (!ws.isAlive) { ws.terminate(); return; } ws.isAlive = false; ws.ping(); });
  }, 30000);
  wss.on('close', () => clearInterval(hb));
}

async function handle(ws, msg) {
  switch (msg.type) {

    case 'host-open': {
      try {
        let userId = null;
        // FIX: client sends userId directly, not a JWT token
        if (msg.userId) {
          userId = parseInt(msg.userId);
        } else if (msg.token) {
          const payload = jwt.verify(msg.token, SECRET);
          userId = payload.sub;
        } else {
          send(ws, { type:'error', code:'AUTH_FAILED', message:'No credentials' }); return;
        }
        const user = await db.one(`SELECT id, display_name, is_banned FROM users WHERE id=?`, [userId]);
        if (!user || user.is_banned) { send(ws, { type:'error', code:'FORBIDDEN', message:'Banned' }); return; }
        const stream = await db.one(`SELECT * FROM streams WHERE room_code=?`, [msg.roomCode?.toUpperCase()]);
        if (!stream) { send(ws, { type:'error', code:'NOT_FOUND', message:'Stream not found' }); return; }
        if (stream.host_id !== user.id) { send(ws, { type:'error', code:'FORBIDDEN', message:'Not your stream' }); return; }
        const code = stream.room_code;
        let room = rooms.get(code);
        if (!room) {
          room = { code, streamId:stream.id, host:null, hostId:ws.peerId, guests:new Map(),
            state:{ isLive:!!stream.is_live, isBrb:false, brbMsg:'', countdown:null,
              permissions: normPerms(stream) }, timer:null };
          room.timer = setTimeout(() => expireRoom(code), ROOM_TTL);
          rooms.set(code, room);
        }
        room.host = ws; room.hostId = ws.peerId;
        ws.roomCode = code; ws.role = 'host'; ws.name = user.display_name; ws.userId = user.id;
        // FIX: send 'room-ready' not 'room-opened'
        send(ws, { type:'room-ready', roomCode:code, peerId:ws.peerId,
          permissions: room.state.permissions,
          roomState:{ isLive:room.state.isLive, isBrb:room.state.isBrb, brbMsg:room.state.brbMsg,
            countdown:room.state.countdown, permissions:room.state.permissions } });
        log(`host-open ${code} uid=${user.id}`);
      } catch(e) { log(`host-open err: ${e.message}`); send(ws, { type:'error', code:'AUTH_FAILED', message:'Auth failed' }); }
      break;
    }

    case 'guest-join': {
      const code = (msg.roomCode||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
      const room = rooms.get(code);
      if (!room) { send(ws, { type:'error', code:'NO_ROOM', message:'Room not found.' }); return; }
      if (!room.host || room.host.readyState !== WebSocket.OPEN) { send(ws, { type:'error', code:'NO_HOST', message:"Host isn't connected yet." }); return; }
      if (room.guests.size >= MAX_GUESTS) { send(ws, { type:'error', code:'FULL', message:'Room is full.' }); return; }
      ws.roomCode = code; ws.role = 'guest'; ws.name = san(msg.name)||'Viewer'; ws.userId = msg.userId||null;
      room.guests.set(ws.peerId, ws);
      await db.q(`INSERT INTO stream_guests (stream_id, user_id, peer_id, display_name) VALUES (?,?,?,?)`,
        [room.streamId, ws.userId, ws.peerId, ws.name]).catch(()=>{});
      send(ws, { type:'room-joined', roomCode:code, peerId:ws.peerId, hostPeerId:room.host.peerId,
        guestCount:room.guests.size, permissions:room.state.permissions,
        roomState:{ isLive:room.state.isLive, isBrb:room.state.isBrb, brbMsg:room.state.brbMsg,
          countdown:room.state.countdown, permissions:room.state.permissions } });
      send(room.host, { type:'guest-arrived', guestPeerId:ws.peerId, guestName:ws.name, guestCount:room.guests.size });
      bcastGuests(room, ws.peerId, { type:'viewer-count', count:room.guests.size });
      await db.q(`UPDATE streams SET viewer_count=?, peak_viewers=GREATEST(peak_viewers,?) WHERE id=?`,
        [room.guests.size, room.guests.size, room.streamId]).catch(()=>{});
      log(`guest-join ${code} "${ws.name}" (${room.guests.size})`);
      break;
    }

    case 'offer':  { if(ws.role!=='host')return; const r1=rooms.get(ws.roomCode); const g1=r1?.guests.get(msg.targetPeerId); if(g1) send(g1,{type:'offer',offer:msg.offer,hostPeerId:ws.peerId}); break; }
    case 'answer': { if(ws.role!=='guest')return; const r2=rooms.get(ws.roomCode); if(r2?.host) send(r2.host,{type:'answer',answer:msg.answer,guestPeerId:ws.peerId}); break; }
    case 'ice': {
      const ri=rooms.get(ws.roomCode); if(!ri)return;
      if(ws.role==='host'){ const g=ri.guests.get(msg.targetPeerId); if(g) send(g,{type:'ice',candidate:msg.candidate,fromPeerId:ws.peerId}); }
      else { if(ri.host) send(ri.host,{type:'ice',candidate:msg.candidate,fromPeerId:ws.peerId}); }
      break;
    }

    case 'cam-offer':  { if(ws.role!=='guest')return; const rco=rooms.get(ws.roomCode); if(!rco?.state.permissions.cam)return; if(rco?.host) send(rco.host,{type:'cam-offer',offer:msg.offer,fromPeerId:ws.peerId,name:ws.name}); break; }
    case 'cam-answer': {
      const rca=rooms.get(ws.roomCode); if(!rca)return;
      if(ws.role==='host'){ const g=rca.guests.get(msg.targetPeerId); if(g) send(g,{type:'cam-answer',answer:msg.answer,fromPeerId:ws.peerId}); }
      else { if(rca.host) send(rca.host,{type:'cam-answer',answer:msg.answer,fromPeerId:ws.peerId,targetPeerId:msg.targetPeerId}); }
      break;
    }
    case 'cam-ice': {
      const rci=rooms.get(ws.roomCode); if(!rci)return;
      if(ws.role==='host'){ const g=rci.guests.get(msg.targetPeerId); if(g) send(g,{type:'cam-ice',candidate:msg.candidate,fromPeerId:ws.peerId}); }
      else { if(rci.host) send(rci.host,{type:'cam-ice',candidate:msg.candidate,fromPeerId:ws.peerId,targetPeerId:msg.targetPeerId}); }
      break;
    }

    case 'chat': {
      const rc=rooms.get(ws.roomCode); if(!rc) return;
      // FIX: check normalised key 'chat'
      if(!rc.state.permissions.chat) return;
      ws.msgCount=(ws.msgCount||0)+1;
      if(!ws.msgReset) ws.msgReset=setTimeout(()=>{ws.msgCount=0;ws.msgReset=null;},5000);
      if(ws.msgCount>MSG_RATE) return;
      const text=san(msg.text); if(!text||text.length>500) return;
      await db.q(`INSERT INTO chat_messages (stream_id, user_id, peer_id, display_name, message) VALUES (?,?,?,?,?)`,
        [rc.streamId, ws.userId, ws.peerId, ws.name, text]).catch(()=>{});
      bcastAll(rc, null, { type:'chat', peerId:ws.peerId, name:ws.name, role:ws.role, text, ts:Date.now() });
      break;
    }

    case 'stream-live': { if(ws.role!=='host')return; const rl=rooms.get(ws.roomCode); if(!rl)return; rl.state.isLive=true; await db.q(`UPDATE streams SET is_live=1, started_at=NOW() WHERE id=?`,[rl.streamId]).catch(()=>{}); bcastGuests(rl,null,{type:'stream-live',hostName:ws.name}); break; }
    case 'stream-ended': { if(ws.role!=='host')return; const re=rooms.get(ws.roomCode); if(!re)return; re.state.isLive=false; re.state.isBrb=false; re.state.countdown=null; await db.q(`UPDATE streams SET is_live=0, ended_at=NOW(), viewer_count=0 WHERE id=?`,[re.streamId]).catch(()=>{}); bcastGuests(re,null,{type:'stream-ended'}); break; }

    case 'brb-on':  { if(ws.role!=='host')return; const rb1=rooms.get(ws.roomCode); if(!rb1)return; rb1.state.isBrb=true; rb1.state.brbMsg=san(msg.message)||'Back Soon'; bcastGuests(rb1,null,{type:'brb-on',message:rb1.state.brbMsg,hostName:ws.name}); break; }
    case 'brb-off': { if(ws.role!=='host')return; const rb2=rooms.get(ws.roomCode); if(!rb2)return; rb2.state.isBrb=false; rb2.state.brbMsg=''; bcastGuests(rb2,null,{type:'brb-off'}); break; }

    case 'countdown-start': {
      if(ws.role!=='host')return; const rcd=rooms.get(ws.roomCode); if(!rcd)return;
      const secs=Math.min(Math.max(parseInt(msg.seconds)||5,3),60);
      rcd.state.countdown={startedAt:Date.now(),seconds:secs};
      bcastGuests(rcd,null,{type:'countdown-start',seconds:secs,startedAt:rcd.state.countdown.startedAt});
      setTimeout(()=>{ const rr=rooms.get(ws.roomCode); if(rr?.state.countdown) rr.state.countdown=null; },(secs+3)*1000);
      break;
    }
    case 'countdown-cancel': { if(ws.role!=='host')return; const rcc=rooms.get(ws.roomCode); if(!rcc)return; rcc.state.countdown=null; bcastGuests(rcc,null,{type:'countdown-cancel'}); break; }

    case 'kick-guest': {
      if(ws.role!=='host')return; const rk=rooms.get(ws.roomCode); if(!rk)return;
      const tid=msg.targetPeerId||msg.guestPeerId;
      const gk=rk.guests.get(tid);
      if(gk){send(gk,{type:'kicked',reason:san(msg.reason)||'Removed by host'});gk.close();}
      rk.guests.delete(tid);
      // FIX: 'guest-left' not 'guest-removed'
      bcastAll(rk,null,{type:'guest-left',guestPeerId:tid,guestCount:rk.guests.size});
      await db.q(`UPDATE stream_guests SET kicked_at=NOW() WHERE stream_id=? AND peer_id=?`,[rk.streamId,tid]).catch(()=>{});
      break;
    }

    case 'mute-guest': {
      if(ws.role!=='host')return; const rm=rooms.get(ws.roomCode);
      const gm=rm?.guests.get(msg.guestPeerId);
      // FIX: 'host-muted' not 'host-mute'
      if(gm) send(gm,{type:'host-muted',muted:!!msg.muted});
      break;
    }

    case 'update-permissions': {
      if(ws.role!=='host')return; const rp=rooms.get(ws.roomCode); if(!rp)return;
      // FIX: client sends {cam,mic,screen,chat} — merge and normalise
      const incoming = normPerms({ ...expandPerms(rp.state.permissions), ...expandPerms(msg.permissions||{}) });
      rp.state.permissions = incoming;
      bcastAll(rp, null, { type:'permissions-updated', permissions:incoming });
      const exp = expandPerms(incoming);
      await db.q(`UPDATE streams SET allow_guest_cam=?,allow_guest_mic=?,allow_guest_screen=?,allow_chat=? WHERE id=?`,
        [exp.allow_guest_cam?1:0, exp.allow_guest_mic?1:0, exp.allow_guest_screen?1:0, exp.allow_chat?1:0, rp.streamId]).catch(()=>{});
      break;
    }
  }
}

async function disconnect(ws) {
  if (!ws.roomCode) return;
  const room = rooms.get(ws.roomCode); if (!room) return;
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

function expireRoom(code) { const room=rooms.get(code); if(!room)return; bcastAll(room,null,{type:'stream-ended',reason:'expired'}); rooms.delete(code); log(`expire ${code}`); }
function kickUser(userId) {
  for (const room of rooms.values()) {
    room.guests.forEach((ws,peerId) => { if(ws.userId===userId){ send(ws,{type:'kicked',reason:'Removed by admin'}); ws.close(); room.guests.delete(peerId); bcastGuests(room,null,{type:'guest-left',guestPeerId:peerId,guestCount:room.guests.size}); } });
    if(room.host?.userId===userId){ bcastGuests(room,null,{type:'stream-ended',reason:'Host removed by admin'}); room.host?.close(); }
  }
}
function getStats() { let g=0; rooms.forEach(r=>{g+=r.guests.size;}); return {rooms:rooms.size,guests:g}; }
function shutdown()  { rooms.forEach(r=>bcastAll(r,null,{type:'stream-ended',reason:'restart'})); }

function send(ws,data)           { if(ws?.readyState===WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function bcastGuests(room,ex,d)  { room.guests.forEach((g,id)=>{if(id!==ex)send(g,d);}); }
function bcastAll(room,ex,d)     { if(room.host?.peerId!==ex) send(room.host,d); bcastGuests(room,ex,d); }
function san(s) { return typeof s==='string'?s.replace(/[<>"'`]/g,'').trim().slice(0,500):''; }
function log(m) { console.log(`${new Date().toISOString()} [ws] ${m}`); }

module.exports = { attach, kickUser, getStats, shutdown };
