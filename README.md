<div align="center">

# 📡 StreamParty

### Watch live, together. No setup. Just stream.

**Host a private room in seconds — share a video file, your screen, or webcam.**  
**Guests join with a room code and watch in real-time with live chat and cameras.**

[![License: MIT](https://img.shields.io/badge/License-MIT-cyan.svg)](#)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](#)
[![MySQL](https://img.shields.io/badge/MySQL-8%2B-blue.svg)](#)
[![NGINX](https://img.shields.io/badge/NGINX-proxy-orange.svg)](#)

</div>

---

## ✨ What is StreamParty?

StreamParty is a self-hosted live streaming platform built for private watch parties. Create a room, share the code with friends, and stream anything — a movie file, your screen, or your webcam — while everyone watches together in real-time.

No third-party streaming services. No subscriptions. Your server, your streams.

---

## 🎬 Features

| Feature | Details |
|---|---|
| 📡 **Live streaming** | Stream a video file, screen share, or webcam via WebRTC |
| 👥 **Guest cameras** | Guests can share their own cams — Teams-style strip at the bottom |
| 💬 **Live chat** | Persistent chat sidebar with message history |
| ☕ **BRB mode** | Animated overlay with custom message while you step away |
| ⏱ **Countdown timer** | Synced countdown for all viewers before you start |
| 🔒 **Private rooms** | Public or private streams, invite by room code |
| 🎛 **Host controls** | Kick guests, mute mics, toggle cam/mic/screen/chat permissions live |
| 🖼 **Thumbnails** | Auto-snapshots every 30s shown on the browse page |
| 🛡 **Admin panel** | Ban users, force-end streams, full audit log |
| 🔐 **Auth** | JWT-based auth with session revocation |

---

## 🖥 How it looks

```
┌─────────────────────────────────────────────────────────┐
│  StreamParty   NOVA42  🔴 LIVE  Friday Night Movie  👁 8 │
├──────────────────────────────────────────┬──────────────┤
│                                          │  Viewers  Chat│
│                                          │               │
│          MAIN VIDEO STREAM               │  Alice: lol   │
│                                          │  Bob: 😂      │
│                                          │  [say something] │
├──────────────────────────────────────────┴──────────────┤
│  [📷 Alice] [📷 Bob] [📷 You]              ⬆ Hide cams  │
├─────────────────────────────────────────────────────────┤
│  🔴 Go Live  ☕ BRB  ⏱ Countdown  📡 Source  ■ End     │
│  Guests: 📷 Cam  🎙 Mic  🖥 Screen  💬 Chat             │
└─────────────────────────────────────────────────────────┘
```

---

## 🚀 One-Line Install

On a fresh **Ubuntu 22.04** VPS, just run:

```bash
curl -fsSL https://raw.githubusercontent.com/TheTucan/StreamParty/main/install.sh | sudo bash
```

The script will ask you three questions and handle everything else automatically.

> **Prerequisites:**
> - Ubuntu 22.04 VPS (1GB RAM minimum, 2GB recommended)
> - A domain name pointing at your VPS IP (DNS A record)
> - Ports 80 and 443 open in your firewall

---

## 📋 What the installer does

```
1. Installs Node.js, MariaDB, NGINX, Certbot
2. Downloads the latest code from this repo
3. Creates the database + imports schema
4. Generates a secure random JWT secret
5. Writes /etc/streamparty.env (600 permissions)
6. Configures NGINX with SSL proxy
7. Gets a free Let's Encrypt SSL certificate
8. Creates & starts a systemd service (auto-restarts on crash)
9. Verifies the API is running
```

Total time: ~3 minutes on a fresh VPS.

---

## 🗂 Project Structure

```
StreamParty/
├── server/
│   ├── index.js              # Express entry point
│   ├── signaling.js          # WebSocket room engine
│   ├── schema.sql            # MySQL schema
│   ├── db.js                 # Database pool
│   ├── middleware/
│   │   └── auth.js           # JWT auth middleware
│   └── routes/
│       ├── auth.js           # Register, login, logout
│       ├── streams.js        # Stream CRUD + snapshots
│       ├── users.js          # Profile management
│       └── admin.js          # Admin moderation
├── public/
│   ├── index.html            # Browse page (lobby)
│   ├── login.html            # Sign in
│   ├── register.html         # Create account
│   ├── dashboard.html        # Host dashboard
│   ├── stream.html           # Watch page (the main event)
│   ├── profile.html          # Edit profile
│   ├── admin.html            # Admin panel
│   ├── css/shared.css        # Design system
│   └── js/shared.js          # Shared client utilities
├── install.sh                # One-shot install script
├── nginx.conf                # NGINX config reference
├── streamparty.service       # systemd service reference
└── streamparty.env.example   # Environment variable template
```

---

## ⚙️ Architecture

```
Browser (HTTPS / WSS)
        ↓
    NGINX :443
    ├── /api/*  →  Node.js :3001  (REST API)
    ├── /ws     →  Node.js :3001  (WebSocket signaling)
    └── /*      →  Static files   (HTML / CSS / JS)
```

Video never touches the server — it's pure **peer-to-peer WebRTC** between host and guests.

---

## 🔧 Managing the app

```bash
# Service control
systemctl status streamparty      # check if running
systemctl restart streamparty     # restart
journalctl -u streamparty -f      # live logs

# NGINX
systemctl reload nginx            # reload config
tail -f /var/log/nginx/streamparty.error.log

# Update to latest version
curl -fsSL https://raw.githubusercontent.com/TheTucan/StreamParty/main/install.sh | sudo bash
```

---

## 🔑 Default admin account

After install, log in at `https://yourdomain.com/login.html`:

| Field | Value |
|---|---|
| Email | `admin@yourdomain.com` |
| Password | `Admin1234!` |

> ⚠️ **Change this password immediately** via Profile → Change Password.

---

## 🌍 Environment variables

Stored at `/etc/streamparty.env` (auto-generated by installer):

| Variable | Description |
|---|---|
| `PORT` | Node server port (default: 3001) |
| `DB_HOST / DB_USER / DB_PASS / DB_NAME` | MySQL connection |
| `JWT_SECRET` | Random secret for token signing (auto-generated) |
| `UPLOAD_DIR` | Where stream thumbnails are saved |
| `ORIGIN` | Your domain (for CORS) |
| `MAX_GUESTS` | Max viewers per room (default: 50) |

---

## 📜 License

MIT — do whatever you want with it.

---

<div align="center">
Built with Node.js · WebRTC · WebSockets · MySQL · NGINX
</div>
