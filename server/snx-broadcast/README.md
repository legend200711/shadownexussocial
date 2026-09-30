# Shadow Nexus Broadcast Engine — Stage 4C

Multi-destination RTMP broadcast engine for Shadow Nexus Radio.

---

## Overview

The Broadcast Engine runs as a **persistent Node.js process** on the same VPS as `snx-live`.
It:

1. Reads the authoritative Radio timeline from Firestore (identical algorithm to the browser client)
2. Fetches audio from R2 / Supabase URLs stored in Firestore
3. Passes audio through an FFmpeg pipeline (1280×720 H.264/AAC)
4. Streams to one or more RTMP/RTMPS destinations simultaneously via the FFmpeg `tee` muxer

Broadcast destinations (RTMP URLs and stream keys) are managed via the
**Shadow Nexus Broadcast Studio** (Studio → BROADCAST tab) and stored
server-side in Firestore — never in this repository.

---

## Infrastructure

| Component | Platform | Continuous? |
|-----------|----------|-------------|
| Firestore | Firebase (Managed) | N/A |
| R2 audio hosting | Cloudflare R2 | N/A |
| Cloudflare Worker | Cloudflare Workers | ❌ Serverless |
| **snx-broadcast (this)** | VPS (same as snx-live) | ✅ Long-running |

**continuousEncoderHost = NOT_CURRENTLY_PROVISIONED**

FFmpeg cannot run inside Cloudflare Workers or serverless runtimes.
It requires a persistent process, a system `ffmpeg` binary, adequate CPU,
and upload bandwidth ≥ 3 Mbps for 720p30.

---

## Quick Start (local development / dry-run)

```bash
cd server/snx-broadcast
cp .env.example .env
# Edit .env — set SNX_TOKEN_SECRET and FIREBASE_SERVICE_ACCOUNT
npm install
npm test            # dry-run: no FFmpeg, no Firestore mutations
npm start           # start the control API
```

---

## VPS Deployment

See [`deploy/`](deploy/) for the full deployment toolset:

| File | Purpose |
|------|---------|
| [`deploy/install.sh`](deploy/install.sh) | First-time VPS provisioning |
| [`deploy/deploy.sh`](deploy/deploy.sh) | Safe update/redeploy |
| [`deploy/verify.sh`](deploy/verify.sh) | Post-install verification |
| [`deploy/CLOUDFLARE_TUNNEL.md`](deploy/CLOUDFLARE_TUNNEL.md) | Tunnel setup guide |
| [`deploy/RTMP_FIRST_TEST.md`](deploy/RTMP_FIRST_TEST.md) | Controlled first-test procedure |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SNX_BROADCAST_PORT` | No | `3100` | HTTP control API port |
| `SNX_TOKEN_SECRET` | **Yes** | — | Shared HMAC secret (must match `SNX_MEDIA_SERVER_SECRET` in Cloudflare Worker) |
| `FIREBASE_SERVICE_ACCOUNT` | **Yes** | `./secrets/firebase-service-account.json` | Firebase Admin credential path |
| `FFMPEG_PATH` | No | `/usr/bin/ffmpeg` | Override ffmpeg binary location |
| `FFMPEG_FONT_FILE` | No | `/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf` | Override drawtext font |
| `BROADCAST_STATE_FILE` | No | `./broadcast-state.json` | Engine state persistence path |
| `BROADCAST_DRY_RUN` | No | `false` | Skip FFmpeg and Firestore (testing only) |

See [`.env.example`](.env.example) for the full annotated template.

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/broadcast/health` | Public | Engine health (no secrets) |
| `GET` | `/broadcast/status` | Founder | Full engine status |
| `POST` | `/broadcast/start` | Founder | Start broadcast |
| `POST` | `/broadcast/stop` | Founder | Stop broadcast |
| `POST` | `/broadcast/destinations/refresh` | Founder | Force-refresh destination cache |

**Auth scheme:** Short-lived HMAC-signed SNX session token issued by the
Cloudflare Worker after verifying the Founder's Firebase token.
Token is sent as `Authorization: Bearer <token>`.

---

## Network / Security Architecture

```
Founder browser
      │  Firebase Auth token
      ▼
Cloudflare Worker  — issues signed SNX token
      │  SNX Bearer token
      ▼
Cloudflare Tunnel
      │  (no public port required)
      ▼
127.0.0.1:3100  — snx-broadcast
      │  verifies SNX token
      ▼
FFmpeg  →  RTMP/RTMPS destination(s)
```

Port 3100 is **never** exposed to the public internet.
Stream keys are **never** logged, never returned in API responses,
never committed to Git.

---

## FFmpeg Requirements

```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg

# Verify
ffmpeg -version
ffmpeg -codecs  | grep libx264
ffmpeg -codecs  | grep aac
ffmpeg -muxers  | grep flv
ffmpeg -muxers  | grep tee
```

Required: libx264, aac, flv muxer, tee muxer.

---

## Stage 4C Scope

- [x] Broadcast engine architecture
- [x] Radio source adapter (Firestore timeline)
- [x] FFmpeg encoder (H.264 + AAC + artwork overlay)
- [x] Multi-destination fan-out via FFmpeg tee muxer
- [x] RTMP Destination Manager (Firestore-backed)
- [x] Stream key security (Firestore only, never logged)
- [x] Systemd unit (non-root, journal logging, boot-enable)
- [x] Localhost-only binding (127.0.0.1:3100)
- [x] VPS install script (Ubuntu 24.04 LTS)
- [x] Safe deploy/update script (rollback on failure)
- [x] Verification script (first-boot checks)
- [x] Cloudflare Tunnel preparation guide
- [x] First RTMP test procedure
- [ ] Real VPS provisioned — `NOT_CURRENTLY_PROVISIONED`
- [ ] Cloudflare Tunnel active — pending real VPS
