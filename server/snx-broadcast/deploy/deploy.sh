#!/usr/bin/env bash
# =============================================================================
# Shadow Nexus Broadcast Engine — Safe Update / Deploy Script
# Stage: 4C
#
# PURPOSE
#   Deploy or update snx-broadcast on an already-provisioned VPS.
#   Preserves all VPS-local state: .env, secrets/, Firebase credentials,
#   stream keys stored in Firestore.  Rolls back cleanly on failure.
#
# USAGE
#   From the local machine (scp the deploy/ directory to the VPS first), or
#   run directly on the VPS after pulling updated source:
#
#     sudo bash deploy.sh [--source /path/to/snx-broadcast]
#
# OPTIONS
#   --source <dir>   Path to the updated source tree (default: script parent dir)
#   --no-restart     Deploy files + deps only; skip service restart
#   --help           Show this help
#
# DOES NOT:
#   - Overwrite .env
#   - Overwrite secrets/
#   - Start or resume an RTMP broadcast automatically
#   - Push to GitHub
#   - Generate or print secrets
# =============================================================================

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
APP_DIR="/opt/snx-broadcast"
SNX_USER="snx-broadcast"
SNX_GROUP="snx-broadcast"
SERVICE="snx-broadcast"
HEALTH_URL="http://127.0.0.1:3100/broadcast/health"
HEALTH_RETRIES=10
HEALTH_WAIT=2        # seconds between retries
AUTO_RESTART=1
BACKUP_DIR=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"   # server/snx-broadcast/

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[DEPLOY]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}    $*"; }
fail()    { echo -e "${RED}[FAIL]${NC}     $*"; exit 1; }
section() { echo -e "\n${YELLOW}══ $* ══${NC}"; }

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)   SOURCE_DIR="$2"; shift 2 ;;
    --no-restart) AUTO_RESTART=0; shift ;;
    --help)
      head -35 "$0" | tail -30
      exit 0
      ;;
    *) fail "Unknown option: $1  (use --help for usage)" ;;
  esac
done

# ── Must run as root ──────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  fail "This script must be run as root.  Use: sudo bash deploy.sh"
fi

# ── Verify source dir ─────────────────────────────────────────────────────────
[[ -f "${SOURCE_DIR}/package.json" ]] || fail "Source dir '${SOURCE_DIR}' does not contain package.json"
[[ -d "${SOURCE_DIR}/src"          ]] || fail "Source dir '${SOURCE_DIR}' does not contain src/"

# ── Verify app dir is provisioned ────────────────────────────────────────────
[[ -d "${APP_DIR}" ]] || fail "${APP_DIR} does not exist — run install.sh first"

# ── Read deployed version (if any) ───────────────────────────────────────────
DEPLOYED_VERSION="(none)"
if [[ -f "${APP_DIR}/package.json" ]]; then
  DEPLOYED_VERSION="$(node -e "console.log(require('${APP_DIR}/package.json').version)" 2>/dev/null || echo '?')"
fi
SOURCE_VERSION="$(node -e "console.log(require('${SOURCE_DIR}/package.json').version)" 2>/dev/null || echo '?')"

info "Deploying snx-broadcast ${DEPLOYED_VERSION} → ${SOURCE_VERSION}"
info "Source:  ${SOURCE_DIR}"
info "Target:  ${APP_DIR}"

# =============================================================================
section "1. Pre-flight checks"
# =============================================================================

# Verify .env exists and is not a bare template
if [[ ! -f "${APP_DIR}/.env" ]]; then
  fail ".env not found at ${APP_DIR}/.env — cannot deploy without configuration"
fi

SECRET_VAL="$(grep -E '^SNX_TOKEN_SECRET=' "${APP_DIR}/.env" | cut -d= -f2- | tr -d '"' | xargs || true)"
if [[ -z "${SECRET_VAL}" || "${SECRET_VAL}" == "CHANGE_ME"* ]]; then
  fail "SNX_TOKEN_SECRET is not set in ${APP_DIR}/.env — refusing deployment"
fi

if [[ ! -f "${APP_DIR}/secrets/firebase-service-account.json" ]]; then
  fail "Firebase credentials missing at ${APP_DIR}/secrets/firebase-service-account.json"
fi

info "Pre-flight: .env present, SNX_TOKEN_SECRET set, Firebase credentials present"

# =============================================================================
section "2. Create rollback snapshot"
# =============================================================================
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="/opt/snx-broadcast-backup-${TIMESTAMP}"
mkdir -p "${BACKUP_DIR}"

# Snapshot deployed files (exclude node_modules/ — too large)
rsync -a --exclude='node_modules/' --exclude='.env' --exclude='secrets/' \
  "${APP_DIR}/" "${BACKUP_DIR}/"
info "Rollback snapshot at: ${BACKUP_DIR}"

# =============================================================================
section "3. Stop service (graceful)"
# =============================================================================
if systemctl is-active --quiet "${SERVICE}"; then
  info "Stopping ${SERVICE}…"
  systemctl stop "${SERVICE}"
  sleep 1
  # Verify stopped
  if systemctl is-active --quiet "${SERVICE}"; then
    warn "Service did not stop cleanly — sending SIGKILL"
    systemctl kill --signal=SIGKILL "${SERVICE}" || true
    sleep 1
  fi
  info "Service stopped"
else
  info "Service was not running — proceeding"
fi

# =============================================================================
section "4. Deploy source files"
# =============================================================================
# rsync:
#   --delete            remove files no longer in source
#   --exclude           NEVER touch .env, secrets/, node_modules/, broadcast-state.json
rsync -a --delete \
  --exclude='.env' \
  --exclude='secrets/' \
  --exclude='node_modules/' \
  --exclude='broadcast-state.json' \
  "${SOURCE_DIR}/" "${APP_DIR}/"

info "Source files deployed"

# =============================================================================
section "5. Install production npm dependencies"
# =============================================================================
cd "${APP_DIR}"
npm ci --omit=dev --ignore-scripts
info "npm ci complete"

# =============================================================================
section "6. Set permissions"
# =============================================================================
chown -R "${SNX_USER}:${SNX_GROUP}" "${APP_DIR}"
chmod 750 "${APP_DIR}/secrets"
chmod 640 "${APP_DIR}/.env"
chown root:"${SNX_GROUP}" "${APP_DIR}/.env"
# Firebase credential — read only by service user
chmod 640 "${APP_DIR}/secrets/firebase-service-account.json"
chown "${SNX_USER}:${SNX_GROUP}" "${APP_DIR}/secrets/firebase-service-account.json"
info "Permissions restored"

# Reload systemd in case the service file changed
systemctl daemon-reload

# =============================================================================
section "7. Start service"
# =============================================================================
if [[ $AUTO_RESTART -eq 0 ]]; then
  info "Skipping restart (--no-restart specified)"
  info "To start manually: sudo systemctl start ${SERVICE}"
  exit 0
fi

systemctl start "${SERVICE}"
info "Service starting…"

# =============================================================================
section "8. Health check"
# =============================================================================
ATTEMPT=0
HEALTH_OK=0

while [[ $ATTEMPT -lt $HEALTH_RETRIES ]]; do
  sleep "${HEALTH_WAIT}"
  ATTEMPT=$(( ATTEMPT + 1 ))

  HTTP_STATUS="$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo "000")"

  if [[ "${HTTP_STATUS}" == "200" ]]; then
    HEALTH_OK=1
    info "Health check PASS (attempt ${ATTEMPT}/${HEALTH_RETRIES})"
    break
  else
    warn "Health check attempt ${ATTEMPT}/${HEALTH_RETRIES}: HTTP ${HTTP_STATUS} — waiting…"
  fi
done

# =============================================================================
section "9. Result"
# =============================================================================
if [[ $HEALTH_OK -eq 1 ]]; then
  info "Deployment SUCCESSFUL — snx-broadcast ${SOURCE_VERSION} is running"
  info "Health: curl ${HEALTH_URL}"
  info "Logs:   journalctl -fu ${SERVICE}"
  info ""
  info "Broadcast does NOT start automatically."
  info "Use the Shadow Nexus Broadcast Studio → POST /broadcast/start to begin a broadcast."
  info ""
  info "Rollback available at: ${BACKUP_DIR}"
  exit 0
else
  warn "Health check FAILED after ${HEALTH_RETRIES} attempts — initiating rollback"

  # ── Rollback ────────────────────────────────────────────────────────────────
  systemctl stop "${SERVICE}" 2>/dev/null || true

  rsync -a --delete \
    --exclude='.env' \
    --exclude='secrets/' \
    --exclude='node_modules/' \
    --exclude='broadcast-state.json' \
    "${BACKUP_DIR}/" "${APP_DIR}/"

  cd "${APP_DIR}"
  npm ci --omit=dev --ignore-scripts
  chown -R "${SNX_USER}:${SNX_GROUP}" "${APP_DIR}"

  systemctl start "${SERVICE}" 2>/dev/null || warn "Could not restart service after rollback — check manually"

  fail "Deployment failed.  Rolled back to ${DEPLOYED_VERSION}.  Check: journalctl -n 50 -u ${SERVICE}"
fi
