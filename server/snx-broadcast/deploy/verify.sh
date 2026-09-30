#!/usr/bin/env bash
# =============================================================================
# Shadow Nexus Broadcast Engine — First-Boot Verification Script
# Stage: 4C
#
# PURPOSE
#   Verifies that all snx-broadcast runtime requirements are met on the VPS.
#   Runs without root privileges (except the systemctl status check).
#   Does NOT start a broadcast, does NOT print secrets.
#
# USAGE
#   bash verify.sh
#
# OUTPUT (one line per check):
#   NODE:     PASS / FAIL
#   NPM:      PASS / FAIL
#   FFMPEG:   PASS / FAIL
#   LIBX264:  PASS / FAIL
#   AAC:      PASS / FAIL
#   FLV:      PASS / FAIL
#   TEE:      PASS / FAIL
#   SERVICE:  PASS / FAIL
#   HEALTH:   PASS / FAIL
# =============================================================================

HEALTH_URL="http://127.0.0.1:3100/broadcast/health"
NODE_MIN_MAJOR=18

PASS=0
FAIL=0

# ── Colour helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

_pass() { echo -e "  ${GREEN}PASS${NC}"; PASS=$(( PASS + 1 )); }
_fail() { echo -e "  ${RED}FAIL${NC}   $*"; FAIL=$(( FAIL + 1 )); }
_warn() { echo -e "  ${YELLOW}WARN${NC}   $*"; }

padded() {
  # Print a right-padded label
  local label="$1"
  printf "%-10s" "${label}:"
}

echo ""
echo "Shadow Nexus Broadcast Engine — Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# =============================================================================
# NODE
# =============================================================================
printf "%s" "$(padded NODE)"
if command -v node &>/dev/null; then
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="$(echo "${NODE_VERSION}" | sed 's/v//' | cut -d. -f1)"
  if [[ $NODE_MAJOR -ge $NODE_MIN_MAJOR ]]; then
    _pass
    echo "             version: ${NODE_VERSION}"
  else
    _fail "Node.js ${NODE_VERSION} found but requires >= v${NODE_MIN_MAJOR}"
  fi
else
  _fail "node binary not found — run install.sh"
fi

# =============================================================================
# NPM
# =============================================================================
printf "%s" "$(padded NPM)"
if command -v npm &>/dev/null; then
  _pass
  echo "             version: $(npm --version)"
else
  _fail "npm binary not found"
fi

# =============================================================================
# FFMPEG
# =============================================================================
printf "%s" "$(padded FFMPEG)"
if command -v ffmpeg &>/dev/null; then
  FF_VERSION="$(ffmpeg -version 2>&1 | head -1 | awk '{print $3}')"
  _pass
  echo "             version: ${FF_VERSION}"
else
  _fail "ffmpeg not found — run: sudo apt-get install ffmpeg"
fi

# =============================================================================
# LIBX264
# =============================================================================
printf "%s" "$(padded LIBX264)"
if command -v ffmpeg &>/dev/null; then
  if ffmpeg -codecs 2>/dev/null | grep -q 'libx264'; then
    _pass
  else
    _fail "libx264 not found in ffmpeg build — 720p encoding will fail"
  fi
else
  _fail "ffmpeg not available — cannot check codecs"
fi

# =============================================================================
# AAC
# =============================================================================
printf "%s" "$(padded AAC)"
if command -v ffmpeg &>/dev/null; then
  if ffmpeg -codecs 2>/dev/null | grep -qE '\baac\b'; then
    _pass
  else
    _fail "aac encoder not found in ffmpeg build — audio encoding will fail"
  fi
else
  _fail "ffmpeg not available — cannot check codecs"
fi

# =============================================================================
# FLV
# =============================================================================
printf "%s" "$(padded FLV)"
if command -v ffmpeg &>/dev/null; then
  if ffmpeg -muxers 2>/dev/null | grep -q 'flv'; then
    _pass
  else
    _fail "FLV muxer not found in ffmpeg build — RTMP output will fail"
  fi
else
  _fail "ffmpeg not available — cannot check muxers"
fi

# =============================================================================
# TEE muxer
# =============================================================================
printf "%s" "$(padded TEE)"
if command -v ffmpeg &>/dev/null; then
  if ffmpeg -muxers 2>/dev/null | grep -q 'tee'; then
    _pass
  else
    _fail "tee muxer not found in ffmpeg build — multi-destination broadcast will fail"
  fi
else
  _fail "ffmpeg not available — cannot check muxers"
fi

# =============================================================================
# SERVICE (systemd)
# =============================================================================
printf "%s" "$(padded SERVICE)"
if systemctl list-unit-files 'snx-broadcast.service' 2>/dev/null | grep -q 'snx-broadcast'; then
  SERVICE_STATE="$(systemctl is-active snx-broadcast 2>/dev/null || echo 'inactive')"
  SERVICE_ENABLED="$(systemctl is-enabled snx-broadcast 2>/dev/null || echo 'unknown')"
  if [[ "${SERVICE_STATE}" == "active" ]]; then
    _pass
    echo "             active / enabled=${SERVICE_ENABLED}"
  elif [[ "${SERVICE_ENABLED}" == "enabled" ]]; then
    # Enabled but not yet started — valid pre-start state
    _pass
    _warn "Service is enabled but not yet active (start manually after configuring .env)"
  else
    _fail "Service exists but is not enabled — run: sudo systemctl enable snx-broadcast"
  fi
else
  _fail "snx-broadcast.service not found — run install.sh first"
fi

# =============================================================================
# HEALTH endpoint
# =============================================================================
printf "%s" "$(padded HEALTH)"
if ! command -v curl &>/dev/null; then
  _fail "curl not installed — cannot check health endpoint"
else
  SERVICE_ACTIVE="$(systemctl is-active snx-broadcast 2>/dev/null || echo 'inactive')"
  if [[ "${SERVICE_ACTIVE}" != "active" ]]; then
    _fail "Service is not running — start it first, then re-run verify.sh"
    echo "             (start: sudo systemctl start snx-broadcast)"
  else
    HTTP_STATUS="$(curl -s -o /dev/null -w "%{http_code}" "${HEALTH_URL}" 2>/dev/null || echo '000')"
    if [[ "${HTTP_STATUS}" == "200" ]]; then
      _pass
      # Print safe health summary (no secrets)
      HEALTH_JSON="$(curl -s "${HEALTH_URL}" 2>/dev/null)"
      ENGINE_STATE="$(echo "${HEALTH_JSON}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('engineState','?'))" 2>/dev/null || echo '?')"
      FFMPEG_FIELD="$(echo "${HEALTH_JSON}"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ffmpeg','?'))" 2>/dev/null || echo '?')"
      echo "             engineState=${ENGINE_STATE} | ffmpeg=${FFMPEG_FIELD}"
    else
      _fail "HTTP ${HTTP_STATUS} from ${HEALTH_URL}"
    fi
  fi
fi

# =============================================================================
# SUMMARY
# =============================================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$(( PASS + FAIL ))
if [[ $FAIL -eq 0 ]]; then
  echo -e "  ${GREEN}All ${TOTAL} checks PASSED${NC}"
else
  echo -e "  ${RED}${FAIL} of ${TOTAL} checks FAILED${NC}"
fi
echo ""
echo "  continuousEncoderHost = NOT_CURRENTLY_PROVISIONED"
echo "  (Update after service is confirmed running on a real VPS)"
echo ""

exit "${FAIL}"
