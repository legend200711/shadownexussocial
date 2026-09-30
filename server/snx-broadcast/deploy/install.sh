#!/usr/bin/env bash
# =============================================================================
# Shadow Nexus Broadcast Engine — VPS Install Script
# Target: Ubuntu 24.04 LTS
# Stage: 4C
#
# PURPOSE
#   Provisions a fresh VPS with all system dependencies required by
#   snx-broadcast, installs the systemd service, and prepares the application
#   directory.  The service is ENABLED for auto-start on boot but NOT started
#   automatically — it will only start after a valid .env is present.
#
# USAGE
#   Run as root (or with sudo) on a freshly provisioned Ubuntu 24.04 LTS VPS:
#
#     sudo bash install.sh
#
# DOES NOT:
#   - Start an external RTMP broadcast
#   - Generate or print production secrets
#   - Commit or push anything to Git
#   - Require a running VPS beforehand (this IS the first-run script)
# =============================================================================

set -euo pipefail

SNX_USER="snx-broadcast"
SNX_GROUP="snx-broadcast"
APP_DIR="/opt/snx-broadcast"
SERVICE_FILE="snx-broadcast.service"
NODE_MAJOR=20           # LTS — satisfies engines: ">=18.0.0"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INSTALL]${NC} $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}   $*"; }
fail()    { echo -e "${RED}[FAIL]${NC}    $*"; exit 1; }
section() { echo -e "\n${YELLOW}══ $* ══${NC}"; }

# ── Must run as root ──────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  fail "This script must be run as root.  Use: sudo bash install.sh"
fi

# ── Locate script directory (should be server/snx-broadcast/deploy/) ─────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"   # server/snx-broadcast/

# =============================================================================
section "1. Update apt package metadata"
# =============================================================================
apt-get update -y

# =============================================================================
section "2. Install system packages"
# =============================================================================
apt-get install -y \
  curl \
  ca-certificates \
  gnupg \
  lsb-release \
  build-essential \
  git \
  ffmpeg

# =============================================================================
section "3. Install / verify Node.js ${NODE_MAJOR}.x"
# =============================================================================
if command -v node &>/dev/null; then
  INSTALLED_MAJOR=$(node --version | sed 's/v//' | cut -d. -f1)
  if [[ $INSTALLED_MAJOR -lt 18 ]]; then
    warn "Node.js ${INSTALLED_MAJOR} found — upgrading to ${NODE_MAJOR}.x via NodeSource"
    INSTALL_NODE=1
  else
    info "Node.js $(node --version) already installed — skipping NodeSource setup"
    INSTALL_NODE=0
  fi
else
  INSTALL_NODE=1
fi

if [[ $INSTALL_NODE -eq 1 ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

node --version  || fail "Node.js installation failed"
npm  --version  || fail "npm not found after Node.js install"
info "Node.js $(node --version) / npm $(npm --version)"

# =============================================================================
section "4. Verify FFmpeg capabilities"
# =============================================================================
FFMPEG_BIN="$(command -v ffmpeg)" || fail "ffmpeg binary not found — apt install may have failed"
info "ffmpeg at: ${FFMPEG_BIN}"
info "ffmpeg version: $(ffmpeg -version 2>&1 | head -1)"

check_codec() {
  local label="$1"
  local grep_term="$2"
  if ffmpeg -codecs 2>/dev/null | grep -q "${grep_term}"; then
    info "  ${label}: FOUND"
  else
    warn "  ${label}: NOT FOUND in ffmpeg build — broadcast will fail"
  fi
}

check_muxer() {
  local label="$1"
  local grep_term="$2"
  if ffmpeg -muxers 2>/dev/null | grep -q "${grep_term}"; then
    info "  ${label}: FOUND"
  else
    warn "  ${label}: NOT FOUND in ffmpeg build — broadcast will fail"
  fi
}

check_codec  "libx264 (H.264 encoder)" "libx264"
check_codec  "AAC encoder"             "aac"
check_muxer  "FLV muxer"               "flv"
check_muxer  "tee muxer"               "tee"

# =============================================================================
section "5. Create service user: ${SNX_USER}"
# =============================================================================
if id "${SNX_USER}" &>/dev/null; then
  info "User '${SNX_USER}' already exists — skipping"
else
  useradd --system --no-create-home --shell /usr/sbin/nologin \
    --comment "Shadow Nexus Broadcast Engine" \
    "${SNX_USER}"
  info "Created system user: ${SNX_USER}"
fi

# =============================================================================
section "6. Create application directory: ${APP_DIR}"
# =============================================================================
mkdir -p "${APP_DIR}/src"
mkdir -p "${APP_DIR}/secrets"

# Copy source files (never overwrite .env or secrets/)
rsync -a --exclude='.env' --exclude='secrets/' --exclude='node_modules/' \
  "${REPO_SRC_DIR}/" "${APP_DIR}/"

info "Source files copied to ${APP_DIR}"

# ── .env must be created by the operator — do not overwrite if present ────────
if [[ ! -f "${APP_DIR}/.env" ]]; then
  warn ".env not found — copying .env.example as a starting template"
  warn "  → You MUST edit ${APP_DIR}/.env before starting the service"
  cp "${REPO_SRC_DIR}/.env.example" "${APP_DIR}/.env"
  chmod 640 "${APP_DIR}/.env"
else
  info ".env already present — not overwritten"
fi

# =============================================================================
section "7. Install npm production dependencies"
# =============================================================================
cd "${APP_DIR}"
npm ci --omit=dev --ignore-scripts
info "npm dependencies installed"

# =============================================================================
section "8. Set permissions"
# =============================================================================
chown -R "${SNX_USER}:${SNX_GROUP}" "${APP_DIR}"

# secrets/ — readable only by service user
chmod 750 "${APP_DIR}/secrets"
# .env — readable only by root and service user
chmod 640 "${APP_DIR}/.env"
chown root:"${SNX_GROUP}" "${APP_DIR}/.env"

info "Permissions set on ${APP_DIR}"

# =============================================================================
section "9. Install systemd service"
# =============================================================================
SERVICE_SRC="${APP_DIR}/${SERVICE_FILE}"
SERVICE_DEST="/etc/systemd/system/${SERVICE_FILE}"

if [[ ! -f "${SERVICE_SRC}" ]]; then
  fail "Service file not found at ${SERVICE_SRC} — cannot install"
fi

cp "${SERVICE_SRC}" "${SERVICE_DEST}"
chmod 644 "${SERVICE_DEST}"
systemctl daemon-reload
info "Systemd unit installed: ${SERVICE_DEST}"

# =============================================================================
section "10. Enable service at boot"
# =============================================================================
systemctl enable "${SERVICE_FILE}"
info "Service enabled (will start on next boot)"

# =============================================================================
section "11. Startup gate — check for required .env values"
# =============================================================================
ENV_READY=1

check_env() {
  local var="$1"
  local val
  val="$(grep -E "^${var}=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | xargs || true)"
  if [[ -z "${val}" || "${val}" == "CHANGE_ME"* ]]; then
    warn "  ${var} is not set — must be configured before starting the service"
    ENV_READY=0
  fi
}

check_env "SNX_TOKEN_SECRET"
check_env "FIREBASE_SERVICE_ACCOUNT"

if [[ ! -f "${APP_DIR}/secrets/firebase-service-account.json" ]]; then
  warn "  secrets/firebase-service-account.json not found"
  warn "  → Place the Firebase service account JSON at: ${APP_DIR}/secrets/firebase-service-account.json"
  warn "  → Then: sudo chown ${SNX_USER}:${SNX_GROUP} ${APP_DIR}/secrets/firebase-service-account.json"
  warn "  → Then: sudo chmod 640 ${APP_DIR}/secrets/firebase-service-account.json"
  ENV_READY=0
fi

# =============================================================================
section "INSTALL COMPLETE"
# =============================================================================
if [[ $ENV_READY -eq 1 ]]; then
  info "Environment appears ready."
  info "Start the service with:"
  info "  sudo systemctl start snx-broadcast"
  info "  sudo journalctl -fu snx-broadcast"
else
  warn ""
  warn "Required configuration is missing."
  warn "The service has been ENABLED but NOT STARTED."
  warn ""
  warn "Required steps before starting:"
  warn "  1. Edit ${APP_DIR}/.env  — set SNX_TOKEN_SECRET"
  warn "  2. Place Firebase service account JSON at ${APP_DIR}/secrets/firebase-service-account.json"
  warn "  3. sudo systemctl start snx-broadcast"
  warn "  4. sudo journalctl -fu snx-broadcast"
  warn ""
  warn "Health check (once running):"
  warn "  curl http://127.0.0.1:3100/broadcast/health"
fi

echo ""
echo "  continuousEncoderHost = NOT_CURRENTLY_PROVISIONED"
echo "  (Update this after the service is confirmed running on a real VPS)"
echo ""
