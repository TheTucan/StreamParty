#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  StreamParty — Auto Update Script
#  Run: sudo bash update.sh
# ═══════════════════════════════════════════════════════════

# ── CONFIG (edit this if your repo URL changes) ──────────────
REPO_URL="https://github.com/TheTucan/StraemParty"
APP_DIR="/var/www/streamparty"
BACKUP_DIR="/var/backups/streamparty"
TMP_DIR="/tmp/streamparty-update-$$"
SERVICE="streamparty"
# ─────────────────────────────────────────────────────────────

set -euo pipefail

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $1"; }
success() { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

echo ""
echo -e "${CYAN}╔═══════════════════════════════════╗${NC}"
echo -e "${CYAN}║   StreamParty — Auto Updater      ║${NC}"
echo -e "${CYAN}╚═══════════════════════════════════╝${NC}"
echo ""

# ── Must run as root ─────────────────────────────────────────
[[ $EUID -ne 0 ]] && error "Run with sudo: sudo bash update.sh"

# ── Check git is available ───────────────────────────────────
command -v git &>/dev/null || { info "Installing git..."; apt-get install -y git -qq; }

# ── Create backup ────────────────────────────────────────────
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"
info "Backing up current version to ${BACKUP_PATH}..."
mkdir -p "$BACKUP_DIR"
cp -r "$APP_DIR" "$BACKUP_PATH"
success "Backup saved."

# ── Download latest from GitHub ──────────────────────────────
info "Downloading latest code from ${REPO_URL}..."
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"

# Try git clone first, fall back to zip download
if git clone --depth=1 "$REPO_URL" "$TMP_DIR/repo" 2>/dev/null; then
  SRC="$TMP_DIR/repo"
  success "Cloned from git."
else
  # Fallback: download zip
  warn "git clone failed, trying zip download..."
  ZIP_URL="${REPO_URL}/archive/refs/heads/main.zip"
  curl -fsSL "$ZIP_URL" -o "$TMP_DIR/repo.zip" || error "Could not download from ${REPO_URL}. Check the URL."
  unzip -q "$TMP_DIR/repo.zip" -d "$TMP_DIR/"
  SRC=$(find "$TMP_DIR" -maxdepth 1 -type d | grep -v "^$TMP_DIR$" | head -1)
  success "Downloaded zip."
fi

# ── Verify the download looks right ──────────────────────────
[[ -d "$SRC/public" ]] || error "Downloaded repo missing 'public' folder. Check repo URL."
[[ -d "$SRC/server" ]] || error "Downloaded repo missing 'server' folder. Check repo URL."
success "Repo structure looks valid."

# ── Stop service ─────────────────────────────────────────────
info "Stopping ${SERVICE} service..."
systemctl stop "$SERVICE" || warn "Service was not running."

# ── Copy new files (preserve .env and uploads) ───────────────
info "Applying updates..."

# Public files (HTML, CSS, JS)
rsync -a --delete \
  --exclude='uploads/' \
  "$SRC/public/" "$APP_DIR/public/"

# Server files (routes, middleware, etc)
# But DO NOT overwrite .env or node_modules
rsync -a \
  --exclude='node_modules/' \
  --exclude='.env' \
  "$SRC/server/" "$APP_DIR/server/"

# Copy root-level config files if they exist in repo
for f in nginx.conf streamparty.service; do
  [[ -f "$SRC/$f" ]] && cp "$SRC/$f" "$APP_DIR/$f" && info "Updated $f"
done

success "Files updated."

# ── Install any new npm dependencies ─────────────────────────
info "Checking for new npm dependencies..."
cd "$APP_DIR/server"
if npm install --omit=dev --silent 2>/dev/null; then
  success "npm dependencies up to date."
else
  warn "npm install had warnings (non-fatal)."
fi

# ── Reload nginx config if it changed ────────────────────────
if nginx -t 2>/dev/null; then
  systemctl reload nginx && success "NGINX reloaded."
else
  warn "NGINX config test failed — skipping reload. Check nginx.conf manually."
fi

# ── Start service ─────────────────────────────────────────────
info "Starting ${SERVICE} service..."
systemctl start "$SERVICE"
sleep 2

# ── Health check ─────────────────────────────────────────────
info "Running health check..."
if systemctl is-active --quiet "$SERVICE"; then
  success "Service is running."
else
  error "Service failed to start! Check logs: journalctl -u ${SERVICE} -n 30"
fi

# Quick API ping
if curl -sf http://127.0.0.1:3001/api/streams/stats &>/dev/null; then
  success "API is responding."
else
  warn "API health check failed — service may still be starting up. Check: journalctl -u ${SERVICE} -f"
fi

# ── Cleanup ──────────────────────────────────────────────────
rm -rf "$TMP_DIR"

# ── Remove old backups (keep last 5) ─────────────────────────
BACKUP_COUNT=$(ls -1 "$BACKUP_DIR" | wc -l)
if [[ $BACKUP_COUNT -gt 5 ]]; then
  info "Pruning old backups (keeping 5 most recent)..."
  ls -1t "$BACKUP_DIR" | tail -n +6 | xargs -I{} rm -rf "${BACKUP_DIR}/{}"
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Update complete! ✓               ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════╝${NC}"
echo ""
echo -e "  Backup saved at: ${YELLOW}${BACKUP_PATH}${NC}"
echo -e "  Rollback with:   ${YELLOW}sudo bash update.sh --rollback${NC}"
echo ""

# ── Rollback support ─────────────────────────────────────────
if [[ "${1:-}" == "--rollback" ]]; then
  LATEST_BACKUP=$(ls -1t "$BACKUP_DIR" | head -1)
  [[ -z "$LATEST_BACKUP" ]] && error "No backups found in $BACKUP_DIR"
  info "Rolling back to ${LATEST_BACKUP}..."
  systemctl stop "$SERVICE" || true
  rsync -a --delete --exclude='.env' --exclude='node_modules/' --exclude='uploads/' \
    "${BACKUP_DIR}/${LATEST_BACKUP}/" "$APP_DIR/"
  systemctl start "$SERVICE"
  success "Rolled back to ${LATEST_BACKUP}."
fi
