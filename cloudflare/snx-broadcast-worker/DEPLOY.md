# Stage 4D — Cloudflare Container Deployment
# Shadow Nexus Broadcast Engine

## Pre-requisites

- Cloudflare account with Workers Paid plan ($5/month)
- `wrangler` CLI authenticated: `npx wrangler login`
- Docker running locally OR use Workers Builds (see below)
- Firebase service account JSON downloaded

---

## 1. Install Worker dependencies

```bash
cd cloudflare/snx-broadcast-worker
npm install
```

---

## 2. Set required secrets

These secrets are injected into the container at runtime via `BroadcastContainer.envVars`.
They are stored encrypted in Cloudflare — never in git or logs.

```bash
# Token secret — must match SNX_MEDIA_SERVER_SECRET in the main Worker
npx wrangler secret put SNX_TOKEN_SECRET --name snx-broadcast-worker

# Firebase Admin service account — full JSON string (not a file path)
# Get from: Firebase Console → Project Settings → Service Accounts → Generate new private key
# Then: cat secrets/firebase-service-account.json | npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON --name snx-broadcast-worker

cat /path/to/firebase-service-account.json | \
  npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON --name snx-broadcast-worker
```

Verify secrets are set (values are not shown):
```bash
npx wrangler secret list --name snx-broadcast-worker
```

---

## 3. Deploy (requires Docker)

From the `cloudflare/snx-broadcast-worker/` directory:

```bash
npx wrangler deploy
```

Wrangler will:
1. Build the Docker image from `server/snx-broadcast/Dockerfile`
2. Push the image to the Cloudflare Registry
3. Deploy the Worker with Container binding
4. Start a rollout of the container instance

**Note:** The first deploy can take several minutes.  
The Worker URL may respond before container routes succeed.  
Wait ~5 minutes then test health.

---

## 4. Deploy without local Docker (Workers Builds)

If Docker is not available locally:

1. Go to Cloudflare Dashboard → Workers & Pages → Create application
2. Connect your GitHub repository
3. Set **Root directory**: `cloudflare/snx-broadcast-worker/`
4. Set **Deploy command**: `npx wrangler deploy`
5. Set **Build command**: *(empty — wrangler deploy handles everything)*
6. Push to your production branch

Workers Builds runs in a cloud environment with Docker available.

---

## 5. Verify deployment

```bash
# List running containers
npx wrangler containers list

# List images in Cloudflare Registry
npx wrangler containers images list

# Check Worker health (replace subdomain)
curl https://snx-broadcast-worker.<YOUR_SUBDOMAIN>.workers.dev/broadcast/health
```

Expected health response (no secrets, no RTMP URLs):
```json
{
  "ok": true,
  "service": "snx-broadcast",
  "version": "4.0.0",
  "engineState": "READY",
  "ffmpeg": "available v6.x",
  "source": null
}
```

---

## 6. Wire main Worker → broadcast Worker

Update the main Cloudflare Worker (`upload-worker.js` or dedicated Worker) to
use the broadcast Worker URL for broadcast control API calls.

Set the broadcast service URL as a Worker secret or variable:

```bash
# URL of the deployed broadcast Worker
npx wrangler secret put SNX_BROADCAST_SERVICE_URL --name yellow-term-11e6
# Value: https://snx-broadcast-worker.<YOUR_SUBDOMAIN>.workers.dev
```

---

## 7. Instance type rationale

| Instance | vCPU | Memory | Disk  | Verdict                           |
|----------|------|--------|-------|-----------------------------------|
| lite     | 1/16 | 256 MiB | 2 GB | Too small — FFmpeg will OOM       |
| basic    | 1/4  | 1 GiB  | 4 GB  | Insufficient CPU for real-time encode |
| standard-1 | 1/2 | 4 GiB | 8 GB | Borderline — may lag at 30fps     |
| **standard-2** | **1** | **6 GiB** | **12 GB** | **Selected — full vCPU for encode** |
| standard-3 | 2  | 8 GiB  | 16 GB | Reserve — upgrade if CPU > 80%    |

**Selected: `standard-2`**  
Reason: libx264 "veryfast" at 1280×720/30fps requires a full vCPU.  
Node.js + Firebase Admin occupy additional memory (~200-400 MB).  
6 GiB RAM is comfortable; 1 vCPU is the minimum for sustained encoding.

---

## 8. VPS fallback

The VPS deployment package in `server/snx-broadcast/deploy/` remains intact.

To revert to VPS mode:
1. Set `SNX_BROADCAST_BIND_HOST=127.0.0.1` (or remove — defaults to `0.0.0.0`)
2. Set `FIREBASE_SERVICE_ACCOUNT=./secrets/firebase-service-account.json`
3. Deploy via `deploy/deploy.sh`
4. Configure Cloudflare Tunnel to route to `localhost:3100`

---

## 9. Pre-broadcast checklist (before YouTube)

Run these tests before attempting any external RTMP broadcast:

- [ ] Container starts (check `npx wrangler containers list`)
- [ ] `GET /broadcast/health` returns `engineState: READY`
- [ ] `ffmpeg` field shows "available vX.X"
- [ ] Firebase connects (no errors in container logs)
- [ ] Radio timeline resolves (source.active: true in /broadcast/status)
- [ ] Current track + offset resolve correctly
- [ ] Artwork URL resolves (R2 HTTPS reachable from container)
- [ ] Founder auth works (`GET /broadcast/status` with valid token → 200)
- [ ] Dry-run test: set `BROADCAST_DRY_RUN=true` in container envVars, start broadcast
- [ ] DO restart recovery: stop container, verify auto-restart and broadcast resumes

---

## 10. Secrets inventory

| Secret name                  | Set where                     | Used by                          |
|------------------------------|-------------------------------|----------------------------------|
| `SNX_TOKEN_SECRET`           | wrangler secret put           | Container → auth.js              |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | wrangler secret put        | Container → server.js            |

**NEVER committed to git.**  
**NEVER in logs.**  
**NEVER in health endpoint.**  
**NEVER in browser responses.**
