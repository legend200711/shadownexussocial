# SNX Live — Dev Setup

## Quick start (local / LAN testing)

### 1. Create `.env`

```
cp .env.example .env
```

Edit `.env`:

```
SNX_LISTEN_IP=0.0.0.0
SNX_PORT=3099
MEDIASOUP_ANNOUNCED_IP=192.168.1.XX    # your LAN IP or 127.0.0.1 for localhost-only
SNX_TOKEN_SECRET=dev-secret-change-me
```

> **Port 3099** is the recommended dev port to avoid conflicts with other local services.

### 2. Install and start

```bash
npm install
npm run dev
```

Server will listen on `ws://0.0.0.0:3099/ws`.

### 3. Connect the frontend

In the browser console (or in a `<script>` tag before `snx-sfu.js` loads):

```js
// Point frontend at your local dev server
window._snxSfuDevUrl = 'ws://192.168.1.XX:3099';  // LAN
// or:
window._snxSfuDevUrl = 'ws://localhost:3099';       // localhost only
```

The `_snxSfuDevUrl` override bypasses the Cloudflare Worker's
`SNX_MEDIA_SERVER_URL` secret and connects directly to your local server.

> **Never set `_snxSfuDevUrl` in production.** Leave it undefined — the Worker
> secret is used instead.

### 4. Cloudflare Worker secrets (production)

```
SNX_MEDIA_SERVER_SECRET=<same as SNX_TOKEN_SECRET in .env>
SNX_MEDIA_SERVER_URL=wss://your-vps.example.com:3099
```

Set with: `wrangler secret put SNX_MEDIA_SERVER_SECRET`

## Firewall requirements

| Port  | Protocol | Direction | Purpose                     |
|-------|----------|-----------|-----------------------------|
| 3099  | TCP      | inbound   | WebSocket signaling         |
| 10000–59999 | UDP | inbound | mediasoup RTP/RTCP media |

## Testing checklist

- [ ] `curl http://localhost:3099/health` → `{"ok":true}`
- [ ] WebSocket opens: `wscat -c ws://localhost:3099/ws`
- [ ] Host presses GO LIVE → console: `[SNX LIVE] Media provider: mediasoup`
- [ ] Host console: `[SNX-MS] Connected to room: ... as: host`
- [ ] Viewer joins → `[SNX-MS] Connected to room: ... as: viewer`
- [ ] Viewer console shows `onTrackSubscribed` with host uid
- [ ] Guest taps REQUEST TO JOIN → host sees request card
- [ ] Host accepts → guest console: `[SFU] Guest connected and publishing`
- [ ] Viewer sees both HOST and GUEST boxes
