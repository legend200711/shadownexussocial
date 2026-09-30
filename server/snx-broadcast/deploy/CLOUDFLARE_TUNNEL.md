# Cloudflare Tunnel — snx-broadcast Connection Guide
## Stage 4C — VPS Deployment Preparation

---

## Architecture

```
Founder browser
      │
      ▼
Cloudflare Worker  (SNX_MEDIA_SERVER_SECRET)
      │   issues signed short-lived SNX token
      ▼
[Cloudflare network]
      │
      ▼
Cloudflare Tunnel  ← cloudflared daemon on VPS
      │   forwards to localhost
      ▼
127.0.0.1:3100  (snx-broadcast HTTP control API)
      │
      ▼
snx-broadcast  (verifies SNX token via SNX_TOKEN_SECRET)
```

The Cloudflare Tunnel removes the need to open any inbound ports on the VPS.
Port 3100 is never exposed to the public internet.

---

## What you will need

| Item | Where to get it |
|------|----------------|
| Cloudflare account with the VPS domain/zone | cloudflare.com |
| `cloudflared` installed on the VPS | see below |
| A Cloudflare Tunnel created via Dashboard or CLI | see below |
| A hostname route (e.g. `broadcast-api.yourdomain.com`) | Tunnel → Public Hostname |

> **Do NOT** create a fake hostname during preparation.
> The hostname is created when a real VPS and Cloudflare zone are available.

---

## Step 1 — Install `cloudflared` on the VPS

```bash
# Ubuntu 24.04 LTS
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg

echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] \
  https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list

sudo apt-get update && sudo apt-get install -y cloudflared
cloudflared --version
```

---

## Step 2 — Authenticate `cloudflared` with your Cloudflare account

```bash
cloudflared tunnel login
# Opens a browser window — authorise via the Cloudflare dashboard
# Credentials are stored at ~/.cloudflared/cert.pem
```

---

## Step 3 — Create the tunnel

```bash
cloudflared tunnel create snx-broadcast
# Output: Created tunnel snx-broadcast with id <UUID>
# Credentials stored at ~/.cloudflared/<UUID>.json
```

The tunnel UUID and credential file will be referenced in the config below.

---

## Step 4 — Create the tunnel config file

Create `/etc/cloudflared/config.yml` (root-readable, not committed to Git):

```yaml
# /etc/cloudflared/config.yml
# Cloudflare Tunnel — snx-broadcast
# DO NOT commit this file — it references the tunnel credential path.

tunnel: <YOUR-TUNNEL-UUID>
credentials-file: /root/.cloudflared/<YOUR-TUNNEL-UUID>.json

ingress:
  - hostname: <YOUR-BROADCAST-HOSTNAME>   # e.g. broadcast-api.yourdomain.com
    service: http://127.0.0.1:3100
  - service: http_status:404
```

Replace:
- `<YOUR-TUNNEL-UUID>` with the UUID from Step 3
- `<YOUR-BROADCAST-HOSTNAME>` with the hostname you will route to this tunnel

> **Never** hardcode a fake hostname or UUID in this documentation before
> a real VPS and Cloudflare zone exist.

---

## Step 5 — Route the hostname through the tunnel

```bash
cloudflared tunnel route dns snx-broadcast <YOUR-BROADCAST-HOSTNAME>
# Creates a CNAME DNS record in Cloudflare pointing to the tunnel
```

Verify in the Cloudflare Dashboard → DNS that a CNAME record was created.

---

## Step 6 — Install `cloudflared` as a systemd service

```bash
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
sudo systemctl status cloudflared
```

---

## Step 7 — Verify the tunnel

```bash
# On the VPS — confirm snx-broadcast health is reachable locally
curl http://127.0.0.1:3100/broadcast/health

# From anywhere — confirm the tunnel is routing correctly
curl https://<YOUR-BROADCAST-HOSTNAME>/broadcast/health
# Expected: {"ok":true,"service":"snx-broadcast",...}
```

The health endpoint is intentionally public-safe.
It returns no stream keys, no credentials, no secrets.

---

## Cloudflare Worker integration

Once the tunnel hostname is confirmed working, update the Cloudflare Worker
to route control requests through it:

```
# In the Cloudflare Worker environment (Workers dashboard or wrangler.toml):
SNX_BROADCAST_SERVICE_URL = https://<YOUR-BROADCAST-HOSTNAME>
```

> **Important:**
> `SNX_BROADCAST_SERVICE_URL` is set in the **Cloudflare Worker** (not in `.env`).
> The Worker adds a signed SNX Bearer token to every request it forwards.
> The VPS never needs to trust any other source.

---

## Security notes

- Port 3100 is **never** open to the internet.  The only inbound path is the Tunnel.
- The Cloudflare Tunnel credential file (`<UUID>.json`) must NOT be committed to Git.
- The tunnel hostname should be protected at the Worker layer — the Worker
  validates the Founder's Firebase token before forwarding any request.
- The `SNX_TOKEN_SECRET` (shared between Worker and VPS) provides a second layer
  of authentication even if the hostname is somehow accessed directly.

---

## Secrets and files that must NEVER be committed to Git

| File | Reason |
|------|--------|
| `/etc/cloudflared/config.yml` | Contains tunnel UUID and hostname |
| `~/.cloudflared/<UUID>.json` | Tunnel credential — full account access |
| `~/.cloudflared/cert.pem` | Cloudflare auth certificate |
| `/opt/snx-broadcast/.env` | Contains `SNX_TOKEN_SECRET` |
| `/opt/snx-broadcast/secrets/firebase-service-account.json` | Firebase private key |

---

## Status

```
continuousEncoderHost = NOT_CURRENTLY_PROVISIONED
Tunnel hostname        = NOT_YET_ASSIGNED
```

These fields will be updated after a real VPS is provisioned and the tunnel
is confirmed routing traffic to `127.0.0.1:3100`.
