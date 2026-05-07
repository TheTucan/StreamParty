#!/bin/bash
# ═══════════════════════════════════════════════════════
#  StreamParty — Install / Update Script
#  Works for fresh installs AND updates
#  Run: curl -fsSL https://raw.githubusercontent.com/TheTucan/StreamParty/main/update.sh | sudo bash
# ═══════════════════════════════════════════════════════
set -euo pipefail

REPO="https://github.com/TheTucan/StreamParty"
APP_DIR="/var/www/streamparty"
BACKUP_DIR="/var/backups/streamparty"
TMP="/tmp/sp-update-$$"
SERVICE="streamparty"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()      { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[FAIL]${NC}  $*"; exit 1; }

[[ $EUID -ne 0 ]] && die "Run with sudo"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   StreamParty  Install / Update      ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
echo ""

# ── Download latest code ─────────────────────────────
info "Downloading latest from GitHub..."
mkdir -p "$TMP"
curl -fsSL -L "${REPO}/archive/refs/heads/main.zip" -o "$TMP/repo.zip" \
  || die "Download failed. Check internet connection and repo URL: ${REPO}"

unzip -q "$TMP/repo.zip" -d "$TMP/"
SRC=$(find "$TMP" -maxdepth 1 -mindepth 1 -type d | head -1)
[[ -d "$SRC/public" && -d "$SRC/server" ]] || die "Bad repo structure — missing public/ or server/"
ok "Downloaded."

# ── Backup if app already exists ─────────────────────
if [[ -d "$APP_DIR/server" ]]; then
  TS=$(date +%Y%m%d_%H%M%S)
  BPATH="${BACKUP_DIR}/${TS}"
  info "Backing up current install to ${BPATH}..."
  mkdir -p "$BACKUP_DIR"
  cp -r "$APP_DIR" "$BPATH"
  ok "Backup saved."
  IS_UPDATE=1
else
  IS_UPDATE=0
fi

# ── Stop service if running ───────────────────────────
systemctl stop "$SERVICE" 2>/dev/null || true

# ── Copy files (preserve .env, node_modules, uploads) ─
info "Copying files..."
mkdir -p "$APP_DIR/public" "$APP_DIR/server"

rsync -a --delete \
  --exclude='uploads/' \
  "$SRC/public/" "$APP_DIR/public/"

rsync -a \
  --exclude='node_modules/' \
  --exclude='.env' \
  "$SRC/server/" "$APP_DIR/server/"

ok "Files updated."

# ── Install/update npm dependencies ──────────────────
info "Installing npm dependencies..."
cd "$APP_DIR/server"
npm install --omit=dev --silent 2>/dev/null || npm install --omit=dev
ok "Dependencies ready."

# ── First-time setup only ─────────────────────────────
if [[ $IS_UPDATE -eq 0 ]]; then
  info "First-time setup — running full installer..."
  # Check if install.sh exists and run it instead
  if [[ -f "$SRC/install.sh" ]]; then
    bash "$SRC/install.sh"
    rm -rf "$TMP"
    exit 0
  fi
fi

# ── Reload nginx ──────────────────────────────────────
if nginx -t 2>/dev/null; then
  systemctl reload nginx && ok "NGINX reloaded."
else
  warn "NGINX config test failed — check manually."
fi

# ── Start service ─────────────────────────────────────
info "Starting StreamParty service..."
systemctl start "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  ok "Service running."
else
  echo ""
  echo "Service failed to start. Last 20 log lines:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  die "Fix errors above then run: sudo systemctl start $SERVICE"
fi

# ── Health check ──────────────────────────────────────
sleep 1
if curl -sf http://127.0.0.1:3001/api/health &>/dev/null; then
  ok "API responding."
else
  warn "API not responding yet — may still be starting."
fi

# ── Prune old backups (keep 5) ────────────────────────
if [[ -d "$BACKUP_DIR" ]]; then
  COUNT=$(ls -1 "$BACKUP_DIR" | wc -l)
  if [[ $COUNT -gt 5 ]]; then
    ls -1t "$BACKUP_DIR" | tail -n +6 | xargs -I{} rm -rf "${BACKUP_DIR}/{}"
    info "Old backups pruned."
  fi
fi

rm -rf "$TMP"

echo ""
echo -e "${GREEN}╔══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Update complete! ✓                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════╝${NC}"
echo ""
echo -e "  Site:     ${CYAN}https://watch.relay.media${NC}"
echo -e "  Logs:     ${YELLOW}journalctl -u streamparty -f${NC}"
echo -e "  Rollback: ${YELLOW}sudo bash update.sh --rollback${NC}"
echo ""

# ── Rollback flag ─────────────────────────────────────
if [[ "${1:-}" == "--rollback" ]]; then
  LATEST=$(ls -1t "$BACKUP_DIR" 2>/dev/null | head -1)
  [[ -z "$LATEST" ]] && die "No backups found in $BACKUP_DIR"
  info "Rolling back to $LATEST..."
  systemctl stop "$SERVICE" || true
  rsync -a --delete \
    --exclude='.env' --exclude='node_modules/' --exclude='uploads/' \
    "${BACKUP_DIR}/${LATEST}/" "$APP_DIR/"
  cd "$APP_DIR/server" && npm install --omit=dev --silent
  systemctl start "$SERVICE"
  ok "Rolled back to $LATEST"
fi
