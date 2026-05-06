/* StreamParty — Shared Client JS */
'use strict';

const API_BASE = 'https://watch.relay.media/api';
const WS_URL   = 'wss://watch.relay.media/ws';
const COLORS   = ['#00d4ff','#00e5a0','#ffd166','#ff6b6b','#c77dff','#ff9f1c','#4cc9f0','#f72585','#7bed9f','#a29bfe'];

// ── Auth store ─────────────────────────────────────────────
const Auth = {
  get token()   { return localStorage.getItem('sp_token'); },
  get user()    { try { return JSON.parse(localStorage.getItem('sp_user')); } catch { return null; } },
  get isLoggedIn() { return !!this.token && !!this.user; },
  get isAdmin() { return this.user?.role === 'admin'; },

  save(token, user) { localStorage.setItem('sp_token', token); localStorage.setItem('sp_user', JSON.stringify(user)); },
  clear()           { localStorage.removeItem('sp_token'); localStorage.removeItem('sp_user'); },

  // Refresh user from server (call on page load for sensitive pages)
  async refresh() {
    if (!this.token) return null;
    try {
      const r = await API.get('/auth/me');
      if (r.user) { localStorage.setItem('sp_user', JSON.stringify(r.user)); return r.user; }
    } catch { this.clear(); return null; }
  },
};

// ── API client ─────────────────────────────────────────────
const API = {
  async request(method, path, body, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (Auth.token) headers['Authorization'] = 'Bearer ' + Auth.token;
    const res = await fetch(API_BASE + path, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      ...opts,
    });
    if (res.status === 401) { Auth.clear(); location.href = '/login.html?next=' + encodeURIComponent(location.pathname); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get(p)    { return this.request('GET', p); },
  post(p,b) { return this.request('POST', p, b); },
  patch(p,b){ return this.request('PATCH', p, b); },
  del(p)    { return this.request('DELETE', p); },

  // Multipart for snapshots
  async postForm(path, formData) {
    const headers = {};
    if (Auth.token) headers['Authorization'] = 'Bearer ' + Auth.token;
    const res = await fetch(API_BASE + path, { method:'POST', headers, body:formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
};

// ── Nav ─────────────────────────────────────────────────────
function renderNav(activePage = '') {
  const nav = document.getElementById('nav');
  if (!nav) return;

  const user = Auth.user;
  const color = user?.avatar_color || '#00d4ff';
  const initial = (user?.display_name || '?')[0].toUpperCase();

  nav.innerHTML = `
    <a href="/index.html" class="nav-brand">Stream<em>Party</em></a>
    <nav class="nav-links">
      <a href="/index.html"          class="nav-link ${activePage==='home'?'on':''}">Browse</a>
      ${user ? `<a href="/dashboard.html"  class="nav-link ${activePage==='dashboard'?'on':''}">Dashboard</a>` : ''}
      ${user?.role==='admin' ? `<a href="/admin.html" class="nav-link ${activePage==='admin'?'on':''}">Admin</a>` : ''}
    </nav>
    <div class="nav-space"></div>
    ${user ? `
      <div class="nav-menu" id="nav-menu">
        <div class="avatar nav-avatar" style="background:${color};color:#080c12" onclick="toggleNavMenu()">${initial}</div>
        <div class="nav-dropdown" id="nav-dropdown">
          <div style="padding:10px 14px 8px;border-bottom:1px solid var(--border);margin-bottom:4px">
            <div style="font-size:13px;font-weight:700">${escHtml(user.display_name)}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">${escHtml(user.email)}</div>
          </div>
          <a href="/profile.html"    class="nav-dd-item">⚙ Profile</a>
          <a href="/dashboard.html"  class="nav-dd-item">📡 Dashboard</a>
          ${user.role==='admin' ? `<a href="/admin.html" class="nav-dd-item">🛡 Admin Panel</a>` : ''}
          <div class="nav-dd-sep"></div>
          <button class="nav-dd-item danger" onclick="doLogout()">← Sign Out</button>
        </div>
      </div>` : `
      <a href="/login.html"    class="nav-btn outline">Sign In</a>
      <a href="/register.html" class="nav-btn primary">Get Started</a>
    `}
  `;

  // Close dropdown when clicking outside
  document.addEventListener('click', e => {
    const menu = document.getElementById('nav-menu');
    if (menu && !menu.contains(e.target)) closeNavMenu();
  }, true);
}

function toggleNavMenu() {
  document.getElementById('nav-dropdown')?.classList.toggle('open');
}
function closeNavMenu() {
  document.getElementById('nav-dropdown')?.classList.remove('open');
}

async function doLogout() {
  try { await API.post('/auth/logout'); } catch {}
  Auth.clear();
  location.href = '/index.html';
}

// ── Stream card HTML ─────────────────────────────────────
function streamCardHtml(s) {
  const thumb = s.thumbnail_url
    ? `<img src="${API_BASE}${s.thumbnail_url}" alt="" loading="lazy" onerror="this.style.display='none'">`
    : `<div class="card-thumb-placeholder">📡</div>`;

  const sourceIcons = { file:'🎞️', screen:'🖥️', cam:'📷' };

  return `
    <a href="/stream.html?room=${escHtml(s.room_code)}" class="card" style="display:block;text-decoration:none">
      <div class="card-thumb">${thumb}
        ${s.is_live ? `<div style="position:absolute;top:10px;left:10px"><span class="badge badge-live"><span class="live-dot"></span>LIVE</span></div>` : ''}
        ${s.viewer_count > 0 ? `<div style="position:absolute;bottom:8px;right:8px"><span class="badge badge-viewers">👁 ${s.viewer_count}</span></div>` : ''}
      </div>
      <div class="card-body">
        <div class="card-title">${escHtml(s.title)}</div>
        <div class="card-host">
          <div class="avatar avatar-sm" style="background:${s.host_color||'#00d4ff'};color:#080c12">${(s.host_name||'?')[0].toUpperCase()}</div>
          ${escHtml(s.host_name)}
        </div>
        <div class="card-meta">
          ${s.is_live ? `<span class="badge badge-live"><span class="live-dot"></span>Live</span>` : `<span class="badge badge-priv">Ended</span>`}
          ${s.is_public ? `<span class="badge badge-public">Public</span>` : `<span class="badge badge-priv">Private</span>`}
          <span style="font-size:11px;color:var(--dim);margin-left:auto">${sourceIcons[s.source_type]||'📡'}</span>
        </div>
      </div>
    </a>`;
}

// ── Utilities ─────────────────────────────────────────────
function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function relativeTime(ts) {
  const d = (Date.now() - new Date(ts)) / 1000;
  if (d < 60)    return 'just now';
  if (d < 3600)  return Math.floor(d/60) + 'm ago';
  if (d < 86400) return Math.floor(d/3600) + 'h ago';
  return Math.floor(d/86400) + 'd ago';
}

function fmtDuration(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  if (h) return `${h}h ${m%60}m`;
  if (m) return `${m}m ${s%60}s`;
  return `${s}s`;
}

function setLoading(btn, loading, txt) {
  if (loading) { btn.disabled = true; btn._orig = btn.textContent; btn.textContent = txt || 'Loading…'; }
  else         { btn.disabled = false; btn.textContent = btn._orig || txt; }
}

let _toastTid;
function toast(msg, type = 'info') {
  let el = document.getElementById('sp-toast');
  if (!el) { el = document.createElement('div'); el.id = 'sp-toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.style.borderColor = type === 'error' ? 'rgba(255,59,59,.35)' : type === 'success' ? 'rgba(0,229,160,.35)' : 'var(--border2)';
  el.classList.add('show');
  clearTimeout(_toastTid);
  _toastTid = setTimeout(() => el.classList.remove('show'), 3200);
}

function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

function requireLogin(next) {
  if (!Auth.isLoggedIn) { location.href = '/login.html?next=' + encodeURIComponent(next || location.pathname); return false; }
  return true;
}

function colorPicker(containerId, onChange) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const current = Auth.user?.avatar_color || COLORS[0];
  el.innerHTML = COLORS.map(c =>
    `<div class="color-swatch ${c===current?'on':''}" style="background:${c}" data-color="${c}" onclick="__cpick(this,'${containerId}')"></div>`
  ).join('');
  el._onChange = onChange;
}

window.__cpick = function(el, containerId) {
  document.querySelectorAll(`#${containerId} .color-swatch`).forEach(s => s.classList.remove('on'));
  el.classList.add('on');
  document.getElementById(containerId)?._onChange?.(el.dataset.color);
};
