# ═══════════════════════════════════════════════════════════════════════════════
# Shadow Nexus Broadcast Engine — Stage 4D
# Cloudflare Container image
#
# Base: node:20-slim  (Debian 12 bookworm-slim)
# Added:
#   - ffmpeg (libx264, libfdk-aac/aac, flv/tee muxer) from Debian repos
#   - DejaVu fonts (for drawtext overlay)
#
# Encoder spec: 1280×720 / 30fps / H.264 libx264 / AAC / FLV tee muxer
# Outbound: Firebase HTTPS, R2/media HTTPS, RTMP, RTMPS
# ═══════════════════════════════════════════════════════════════════════════════

FROM node:20-slim

# ── System packages ───────────────────────────────────────────────────────────
# ffmpeg from Debian bullseye/bookworm repos ships with:
#   libx264 (H.264), native aac, flv muxer, tee muxer, lavfi, drawtext
# fonts-dejavu-core provides DejaVuSans-Bold.ttf for drawtext overlays.

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ffmpeg \
        fonts-dejavu-core \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Verify FFmpeg codecs at build time ───────────────────────────────────────
# This makes the build fail loudly if a required codec is missing.
RUN ffmpeg -version && \
    ffmpeg -codecs 2>/dev/null | grep -q 'libx264'  && echo "libx264 OK"   || (echo "MISSING: libx264"  && exit 1) && \
    ffmpeg -codecs 2>/dev/null | grep -qE '\baac\b'  && echo "aac OK"      || (echo "MISSING: aac"      && exit 1) && \
    ffmpeg -formats 2>/dev/null | grep -q '\bflv\b'  && echo "flv OK"      || (echo "MISSING: flv"      && exit 1) && \
    ffmpeg -formats 2>/dev/null | grep -q '\btee\b'  && echo "tee OK"      || (echo "MISSING: tee"      && exit 1)

# ── Application ───────────────────────────────────────────────────────────────

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies only (no devDependencies)
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/

# ── Runtime configuration ─────────────────────────────────────────────────────
# All secrets are injected at runtime by the Container class envVars.
# The container reads standard environment variables — no .env file is used.
# See config.js for the full variable list.

# Default port — must match BroadcastContainer.defaultPort in the Worker
ENV SNX_BROADCAST_PORT=3100
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFMPEG_FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
ENV NODE_ENV=production
# State file disabled inside container — state is held in DO storage instead
ENV BROADCAST_STATE_FILE=

EXPOSE 3100

# ── Entrypoint ────────────────────────────────────────────────────────────────
# Uses node directly — no npm wrapper — for clean signal propagation.
CMD ["node", "src/server.js"]
