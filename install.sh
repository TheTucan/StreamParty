#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  StreamParty — Remote Install Script
#  Pulls all files directly from GitHub — no zip needed.
#
#  One-liner usage on a fresh VPS:
#    curl -fsSL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/install.sh | sudo bash
#
#  Or download and inspect first (recommended):
#    curl -fsSL https://raw.githubusercontent.com/YOUR_USER/YOUR_REPO/main/install.sh -o install.sh
#    chmod +x install.sh && sudo bash install.sh
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

# ┌─────────────────────────────────────────────────────────────┐
# │  UPDATE THESE to match your GitHub repo before pushing      │
GITHUB_USER="TheTucan"
GITHUB_REPO="StreamParty"
GITHUB_BRANCH="main"
# └─────────────────────────────────────────────────────────────┘

RAW="https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}"
ZIP_URL="https://github.com/${GITHUB_USER}/${GITHUB_REPO}/archive/refs/heads/${GITHUB_BRANCH}.zip"

# ── Colours ────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}══ $* ══${NC}\n"; }

# ── Must run as root ───────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run with sudo: sudo bash install.sh"

# ══════════════════════════════════════════════════════════════
header "StreamParty Installer"
echo -e "Repo: ${CYAN}https://github.com/${GITHUB_USER}/${GITHUB_REPO}${NC}"
echo ""
echo    "This script will install and configure:"
echo    "  • Node.js 18+ · MySQL/MariaDB · NGINX · Let's Encrypt SSL"
echo    "  • StreamParty app at /var/www/streamparty"
echo    "  • systemd service (auto-start on boot)"
echo ""

# ── Collect config ─────────────────────────────────────────────
read -rp "$(echo -e "${BOLD}Domain name${NC} (e.g. watch.relay.media): ")" DOMAIN
[[ -z "$DOMAIN" ]] && die "Domain is required."

read -rp "$(echo -e "${BOLD}Admin email${NC} (for SSL cert notifications): ")" ADMIN_EMAIL
[[ -z "$ADMIN_EMAIL" ]] && die "Email is required."

read -rsp "$(echo -e "${BOLD}MySQL password${NC} for streamparty DB user (pick something strong): ")" DB_PASS
echo ""
[[ ${#DB_PASS} -lt 8 ]] && die "Password must be at least 8 characters."

read -rsp "$(echo -e "${BOLD}Confirm MySQL password${NC}: ")" DB_PASS2
echo ""
[[ "$DB_PASS" != "$DB_PASS2" ]] && die "Passwords do not match."

echo ""
info "Domain : $DOMAIN"
info "Email  : $ADMIN_EMAIL"
info "DB user: streamparty"
echo ""
read -rp "Looks good? Continue? [y/N] " CONFIRM
[[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]] && die "Aborted."

APP_DIR="/var/www/streamparty"

# ══════════════════════════════════════════════════════════════
header "1 · System packages"

apt-get update -qq
apt-get install -y -qq curl unzip git nginx certbot python3-certbot-nginx
success "Base packages installed"

# ── Node.js ────────────────────────────────────────────────────
NODE_VER=$(node --version 2>/dev/null | grep -oP '\d+' | head -1 || echo "0")
if [[ "$NODE_VER" -ge 18 ]]; then
  success "Node.js $(node --version) already installed — skipping"
else
  info "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
  success "Node.js $(node --version) installed"
fi

# ── MySQL / MariaDB ────────────────────────────────────────────
if ! command -v mysql &>/dev/null; then
  info "Installing MariaDB..."
  apt-get install -y -qq mariadb-server
  systemctl enable --now mariadb
  success "MariaDB installed"
else
  success "MySQL/MariaDB already installed — skipping"
fi

# ══════════════════════════════════════════════════════════════
header "2 · Download app from GitHub"

mkdir -p "$APP_DIR"/{server,public,uploads}

info "Downloading from github.com/${GITHUB_USER}/${GITHUB_REPO} ..."
TMP_DIR=$(mktemp -d)
curl -fsSL "$ZIP_URL" -o "$TMP_DIR/repo.zip"
unzip -q "$TMP_DIR/repo.zip" -d "$TMP_DIR"

# GitHub zips extract to REPO-BRANCH/ subfolder
EXTRACTED=$(find "$TMP_DIR" -maxdepth 1 -mindepth 1 -type d | head -1)
[[ -z "$EXTRACTED" ]] && die "Could not find extracted directory in zip"

[[ -d "$EXTRACTED/server" ]] || die "server/ not found in repo — check your GitHub repo structure"
[[ -d "$EXTRACTED/public" ]] || die "public/ not found in repo — check your GitHub repo structure"

cp -r "$EXTRACTED/server/." "$APP_DIR/server/"
cp -r "$EXTRACTED/public/." "$APP_DIR/public/"
rm -rf "$TMP_DIR"
success "Files downloaded and extracted to $APP_DIR"

# ══════════════════════════════════════════════════════════════
header "3 · Database setup"

mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS streamparty CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'streamparty'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON streamparty.* TO 'streamparty'@'localhost';
FLUSH PRIVILEGES;
SQL
success "Database and user created"

info "Importing schema..."
mysql -u streamparty -p"${DB_PASS}" streamparty < "$APP_DIR/server/schema.sql"
success "Schema imported"

# ══════════════════════════════════════════════════════════════
header "4 · Node.js dependencies"

cd "$APP_DIR/server"
npm install --omit=dev --silent
success "Dependencies installed"

chown -R www-data:www-data "$APP_DIR"
chmod 750 "$APP_DIR/uploads"
success "Permissions set"

# ══════════════════════════════════════════════════════════════
header "5 · Environment file"

JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")

cat > /etc/streamparty.env <<ENV
PORT=3001
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=streamparty
DB_PASS=${DB_PASS}
DB_NAME=streamparty
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES=7d
UPLOAD_DIR=${APP_DIR}/uploads
ORIGIN=https://${DOMAIN}
PING_MS=20000
MAX_GUESTS=50
ROOM_TTL_MS=14400000
ENV

chmod 600 /etc/streamparty.env
success "Environment file written to /etc/streamparty.env"

# ══════════════════════════════════════════════════════════════
header "6 · NGINX — temporary HTTP config for SSL challenge"

cat > /etc/nginx/sites-available/streamparty <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    root ${APP_DIR}/public;
    location / { try_files \$uri \$uri/ =404; }
}
NGINX

rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
ln -sf /etc/nginx/sites-available/streamparty /etc/nginx/sites-enabled/streamparty
nginx -t && systemctl start nginx 2>/dev/null || systemctl reload nginx
success "NGINX started on port 80"

# ══════════════════════════════════════════════════════════════
header "7 · SSL certificate"

info "Requesting Let's Encrypt certificate for ${DOMAIN}..."
warn "DNS A record for ${DOMAIN} must already point to this server's IP."
echo ""

SSL_OK=0
if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" --redirect; then
  success "SSL certificate obtained"
  SSL_OK=1
else
  warn "certbot failed — DNS may not have propagated yet."
  warn "After fixing DNS, run:"
  warn "  sudo certbot --nginx -d ${DOMAIN} -m ${ADMIN_EMAIL} --agree-tos --redirect"
  warn "  sudo systemctl reload nginx"
fi

# ── Write final NGINX config (with SSL + proxy) ────────────────
if [[ $SSL_OK -eq 1 ]]; then
cat > /etc/nginx/sites-available/streamparty <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options           SAMEORIGIN                            always;
    add_header X-Content-Type-Options    nosniff                               always;

    location /api/ {
        proxy_pass         http://127.0.0.1:3001/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
        client_max_body_size 10m;
    }

    location /ws {
        proxy_pass         http://127.0.0.1:3001/ws;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location /health {
        proxy_pass http://127.0.0.1:3001/health;
        access_log off;
    }

    root  ${APP_DIR}/public;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
        expires 1h;
    }

    gzip on;
    gzip_types text/plain text/css application/json application/javascript;

    access_log /var/log/nginx/streamparty.access.log;
    error_log  /var/log/nginx/streamparty.error.log warn;
}
NGINX
  nginx -t && systemctl reload nginx
  success "NGINX SSL config applied"
fi

# ══════════════════════════════════════════════════════════════
header "8 · systemd service"

cat > /etc/systemd/system/streamparty.service <<SVC
[Unit]
Description=StreamParty API & Signaling Server
After=network.target mariadb.service mysql.service
Wants=mariadb.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${APP_DIR}/server
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=5
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=streamparty
EnvironmentFile=/etc/streamparty.env
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${APP_DIR}/uploads

[Install]
WantedBy=multi-user.target
SVC

systemctl daemon-reload
systemctl enable streamparty
systemctl start streamparty
sleep 2

if systemctl is-active --quiet streamparty; then
  success "StreamParty service started and enabled"
else
  warn "Service failed to start. Check: journalctl -u streamparty -n 50"
fi

# ══════════════════════════════════════════════════════════════
header "9 · Verify"

sleep 1
HTTP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/health || echo "000")
if [[ "$HTTP" == "200" ]]; then
  success "API health check passed (HTTP 200)"
else
  warn "API returned HTTP $HTTP — check: journalctl -u streamparty -n 30"
fi

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}  StreamParty install complete!${NC}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  Site:       ${CYAN}https://${DOMAIN}${NC}"
echo -e "  Admin:      ${CYAN}https://${DOMAIN}/admin.html${NC}"
echo -e "  API health: ${CYAN}https://${DOMAIN}/health${NC}"
echo ""
echo -e "  ${YELLOW}Default admin login:${NC}"
echo -e "  Email:    admin@${DOMAIN}"
echo -e "  Password: ${RED}Admin1234!${NC}"
echo -e "  ${RED}→ Change this password immediately after first login!${NC}"
echo ""
echo    "  Useful commands:"
echo -e "  ${CYAN}systemctl status streamparty${NC}     — check service"
echo -e "  ${CYAN}journalctl -u streamparty -f${NC}     — live logs"
echo -e "  ${CYAN}systemctl restart streamparty${NC}    — restart app"
echo -e "  ${CYAN}systemctl reload nginx${NC}           — reload NGINX"
echo ""
echo    "  To update (re-runs install pulling latest from GitHub):"
echo -e "  ${CYAN}curl -fsSL ${RAW}/install.sh | sudo bash${NC}"
echo ""
