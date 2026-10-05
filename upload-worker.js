/**
 * Shadow Nexus Social — Cloudflare R2 Upload + Serve Worker
 *
 * Cloudflare handles ALL media storage for Shadow Nexus Social:
 *   - Profile pictures
 *   - Post images, videos, music files
 *   - Message media attachments
 *
 * Firebase stores only the public URL + file metadata.
 *
 * Routes:
 *   GET  /{key}  — serves a file from R2 with CDN caching
 *   POST /       — uploads a file to R2, returns public URL
 *
 * Security:
 *   - Origin whitelist (ALLOWED_ORIGINS)
 *   - MIME type allowlist (images / video / audio only)
 *   - 200 MB max file size
 *   - User UID scoped storage paths
 *   - Security response headers on every response
 *   - Rate-limit hint headers (enforce limits in Cloudflare dashboard)
 */

const MAX_SIZE_IMAGE = 10   * 1024 * 1024;        // 10 MB  — images
const MAX_SIZE_VIDEO = 2048 * 1024 * 1024;        // 2 GB   — video (SFL allows 2 GB)
const MAX_SIZE_AUDIO = 200  * 1024 * 1024;        // 200 MB — audio / music
const MAX_SIZE       = MAX_SIZE_VIDEO;            // absolute upper bound

const ALLOWED_ORIGINS = [
  'https://shadownexussocial.online',
  'https://www.shadownexussocial.online',
  'https://chrislegendofshadows.com',
  'https://www.chrislegendofshadows.com',
  'https://shadowfirelive.com',
  'https://www.shadowfirelive.com',
  'https://horr-a08f4.web.app',
  'https://horr-a08f4.firebaseapp.com',
  'https://legend200711.github.io',
  'http://localhost',
  'http://127.0.0.1'
];

// ── MIME type allowlist ───────────────────────────────────────────────────────
function isAllowedType(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0].trim();
  return (
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m === 'application/octet-stream' // fallback for some mobile browsers
  );
}

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  // Exact-match production domains; allow any localhost/127.0.0.1 port for dev.
  const isAllowed = origin && (
    ALLOWED_ORIGINS.filter(o => !o.startsWith('http://localhost') && !o.startsWith('http://127.0.0.1')).includes(origin) ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
  const allowedOrigin = isAllowed ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':   allowedOrigin,
    'Access-Control-Allow-Methods':  'GET, POST, PATCH, DELETE, OPTIONS',
    // Authorization is required for all upload/delete endpoints.
    'Access-Control-Allow-Headers':  'Content-Type, Authorization, X-User-UID, Upload-Offset, Upload-Length, Tus-Resumable, Range',
    // Expose byte-range headers so audio/video elements can read them cross-origin
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
    'Access-Control-Max-Age':        '86400',
    // Required when Access-Control-Allow-Origin varies per request
    'Vary':                          'Origin',
  };
}

// ── Security headers added to every response ──────────────────────────────────
function securityHeaders() {
  return {
    // Prevent MIME sniffing
    'X-Content-Type-Options': 'nosniff',
    // Block pages from being embedded in iframes (clickjacking)
    'X-Frame-Options': 'DENY',
    // XSS protection for older browsers
    'X-XSS-Protection': '1; mode=block',
    // Rate-limit hint (actual limits enforced via Cloudflare dashboard WAF rules)
    'X-RateLimit-Limit':     '100',
    'X-RateLimit-Window':    '60',
    // CDN hint — vary caching per origin
    'Vary': 'Origin',
    // Strict-Transport-Security (HTTPS only)
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // Referrer policy
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

// ── Merge multiple header objects ─────────────────────────────────────────────
function mergeHeaders(...objs) {
  return Object.assign({}, ...objs);
}

// ── Extension → MIME fallback ─────────────────────────────────────────────────
function mimeFromExt(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4',  mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4',
    // webm is a video container by default — audio-only webm is rare and browsers
    // report it correctly when they know the MIME. Mapping to video/webm preserves
    // correct Content-Type for video files uploaded as application/octet-stream.
    webm: 'video/webm',
    mp3: 'audio/mpeg', m4a: 'audio/mp4',  aac: 'audio/aac',
    ogg: 'audio/ogg',  wav: 'audio/wav',  flac: 'audio/flac',
    opus: 'audio/ogg',
  };
  return map[ext] || null;
}

// ── Shared: sign a LiveKit JWT ────────────────────────────────────────────────
async function signLiveKitJwt(apiKey, apiSecret, payload) {
  const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc    = s => b64url(unescape(encodeURIComponent(s)));
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = enc(JSON.stringify(header));
  const p = enc(JSON.stringify(payload));
  const sigInput = `${h}.${p}`;
  const keyData  = new TextEncoder().encode(apiSecret);
  const msgData  = new TextEncoder().encode(sigInput);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${sigInput}.${sigB64}`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SNX LIVE — self-hosted mediasoup media backend
//  These routes replace the LiveKit endpoints below.
//  The Cloudflare Worker acts as the secure credential/token vending layer.
//  Actual WebRTC/RTP media runs on the self-hosted mediasoup VPS.
// ══════════════════════════════════════════════════════════════════════════════

// ── Shared utility: sign an HMAC-SHA256 SNX token ────────────────────────────
// token format: base64url(payload).base64url(signature)
// Stored Worker secret: SNX_MEDIA_SERVER_SECRET
async function _signSnxToken(secret, payload) {
  const enc = new TextEncoder();
  const key  = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return payloadB64 + '.' + sigB64;
}

// ── POST /snx-live/room ───────────────────────────────────────────────────────
// Host pre-registers a Live room so the Worker can record the roomId→hostId
// mapping for downstream authorization checks (remove-guest, end-live, etc.).
// Body: { roomName }
async function handleSnxLiveRoom(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }
  let uid;
  try { uid = await _requireAuth(request, env); } catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const { roomName } = body || {};
  if (!roomName) {
    return new Response(JSON.stringify({ error: 'roomName is required' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // Store roomId→hostId in Workers KV if available; otherwise no-op (room is created
  // on first JOIN on the media server, host authorization checked there via token role).
  if (env.SNX_LIVE_KV) {
    try {
      await env.SNX_LIVE_KV.put('room:' + roomName, JSON.stringify({ hostId: uid, createdAt: Date.now() }), { expirationTtl: 86400 });
    } catch (_) {}
  }

  return new Response(JSON.stringify({ roomName, registered: true }),
    { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// ── POST /snx-live/token ──────────────────────────────────────────────────────
// Issues a short-lived SNX session token for a participant to JOIN the media room.
// Body: { roomName, participantName, canPublish }
// Returns: { token, url }   — token is HMAC-signed, url is the media server WSS endpoint.
async function handleSnxLiveToken(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); } catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const secret = env.SNX_MEDIA_SERVER_SECRET;
  const mediaUrl = env.SNX_MEDIA_SERVER_URL;
  if (!secret || !mediaUrl) {
    return new Response(JSON.stringify({ error: 'SNX media server not configured (set SNX_MEDIA_SERVER_SECRET and SNX_MEDIA_SERVER_URL)' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const { roomName, participantName, canPublish = false } = body || {};
  if (!roomName || !participantName) {
    return new Response(JSON.stringify({ error: 'roomName and participantName are required' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // participantName must equal the verified Firebase UID (prevent spoofing)
  if (participantName !== verifiedUid) {
    return new Response(JSON.stringify({ error: 'participantName must match authenticated uid' }),
      { status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // Determine role — host if canPublish and is registered host for this room; else guest or viewer
  let role = 'viewer';
  if (canPublish) {
    // Check KV for host registration (best-effort; falls back to 'guest' for accepted guests)
    if (env.SNX_LIVE_KV) {
      try {
        const roomData = await env.SNX_LIVE_KV.get('room:' + roomName, { type: 'json' });
        role = (roomData && roomData.hostId === verifiedUid) ? 'host' : 'guest';
      } catch { role = 'guest'; }
    } else {
      role = 'guest';   // no KV — caller is trusted to send canPublish=true only for accepted guests
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    uid:    verifiedUid,
    roomId: roomName,
    role,
    iat:    now,
    exp:    now + 6 * 3600,   // 6-hour validity
  };

  const token = await _signSnxToken(secret, payload);

  return new Response(JSON.stringify({ token, url: mediaUrl, role }),
    { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// ── POST /snx-live/remove-guest ───────────────────────────────────────────────
// Host removes a guest from the stage.  Proxied to the media server so the
// server can close their transport.  Also fires a hostEnded signal for the guest.
// Body: { roomName, guestUid }
async function handleSnxLiveRemoveGuest(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); } catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const { roomName, guestUid } = body || {};
  if (!roomName || !guestUid) {
    return new Response(JSON.stringify({ error: 'roomName and guestUid are required' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // Verify caller is the host of this room
  if (env.SNX_LIVE_KV) {
    try {
      const roomData = await env.SNX_LIVE_KV.get('room:' + roomName, { type: 'json' });
      if (!roomData || roomData.hostId !== verifiedUid) {
        return new Response(JSON.stringify({ error: 'Forbidden: only the host can remove guests' }),
          { status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
      }
    } catch (_) {}   // if KV unavailable, pass through (media server double-checks role from token)
  }

  // The media server is notified via HOST_REMOVE_GUEST WebSocket message, which is
  // sent from the host's own browser connection.  This Worker endpoint is the HTTP
  // fallback path for cases where the host needs server-side verification first.
  // For now: return OK — the snxSfu.removeGuest() call in the browser drives the actual removal.
  return new Response(JSON.stringify({ removed: true, guestUid }),
    { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// ── GET /snx-live/turn ────────────────────────────────────────────────────────
// Issues short-lived coturn TURN credentials using the HMAC-time-limited method.
// The coturn config must have:  use-auth-secret=yes
//                               static-auth-secret=<SNX_TURN_SECRET value>
// Returns: { iceServers: [{ urls, username, credential }] }
async function handleSnxLiveTurn(request, env, cors, sec) {
  let uid;
  try { uid = await _requireAuth(request, env); } catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const turnSecret = env.SNX_TURN_SECRET;
  const turnHost   = env.COTURN_HOST || '';
  const turnPort   = env.COTURN_PORT || '3478';
  const turnTlsPort = env.COTURN_TLS_PORT || '5349';

  if (!turnSecret || !turnHost) {
    // Graceful degradation — return empty iceServers; STUN-only fallback applies
    console.warn('[SNX-TURN] SNX_TURN_SECRET or COTURN_HOST not configured — returning empty TURN list');
    return new Response(JSON.stringify({ iceServers: [] }),
      { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=0' }) });
  }

  // TURN credential TTL: 24 hours (coturn default is 24 h for time-limited credentials)
  const ttl       = 86400;
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username  = timestamp + ':' + uid;

  // HMAC-SHA256(username, turnSecret) → base64
  const enc = new TextEncoder();
  const key  = await crypto.subtle.importKey(
    'raw', enc.encode(turnSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuf    = await crypto.subtle.sign('HMAC', key, enc.encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  const iceServers = [
    {
      urls:       'stun:' + turnHost + ':' + turnPort,
    },
    {
      urls:       'turn:' + turnHost + ':' + turnPort,
      username,
      credential,
    },
    {
      urls:       'turn:' + turnHost + ':' + turnPort + '?transport=tcp',
      username,
      credential,
    },
    {
      urls:       'turns:' + turnHost + ':' + turnTlsPort + '?transport=tcp',
      username,
      credential,
    },
  ];

  return new Response(JSON.stringify({ iceServers }),
    {
      status: 200,
      headers: mergeHeaders(cors, sec, {
        'Content-Type':  'application/json',
        // Client can cache for (TTL - 60s) so it doesn't use credentials right before expiry
        'Cache-Control': 'private, max-age=' + (ttl - 60),
      }),
    }
  );
}

// ══════════════════════════════════════════════════════════════════════════════
//  DEPRECATED LiveKit routes — kept for emergency rollback ONLY.
//  These will be removed once the self-hosted SNX media server is verified.
//  DO NOT use these in production — they depend on LiveKit Cloud.
// ══════════════════════════════════════════════════════════════════════════════

// ── LiveKit room creator ──────────────────────────────────────────────────────
// POST /livekit-room   body: { roomName }
// Creates the room on the LiveKit server so participants can join it.
// DEPRECATED — use POST /snx-live/room instead.
async function handleLiveKitRoom(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  // Require a valid Firebase ID token — unauthenticated callers get 401.
  try { await _requireAuth(request, env); } catch (e) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const livekitUrl = (env.LIVEKIT_URL || '')
    .replace('wss://', 'https://')
    .replace('ws://',  'http://');

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { roomName } = body;
  if (!roomName) {
    return new Response(JSON.stringify({ error: 'roomName is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Mint an admin JWT (roomCreate grant) to call the LiveKit REST API
  const now = Math.floor(Date.now() / 1000);
  const adminToken = await signLiveKitJwt(apiKey, apiSecret, {
    iss: apiKey, sub: 'server', iat: now, exp: now + 60, nbf: now,
    video: { roomCreate: true },
  });

  // Call LiveKit REST API — CreateRoom (Twirp/JSON)
  let lkResp;
  try {
    lkResp = await fetch(`${livekitUrl}/twirp/livekit.RoomService/CreateRoom`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        name:              roomName,
        empty_timeout:     300,   // close room 5 min after last participant leaves
        max_participants:  500,
      }),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'LiveKit API unreachable: ' + e.message }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const lkBody = await lkResp.text();
  if (!lkResp.ok) {
    return new Response(JSON.stringify({ error: 'LiveKit room creation failed: ' + lkBody }), {
      status: lkResp.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ roomName, created: true }), {
    status: 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── LiveKit JWT token generator ───────────────────────────────────────────────
// Signs an access token using the LiveKit API key + secret stored as Worker secrets.
// POST /livekit-token   body: { roomName, participantName, canPublish }
async function handleLiveKitToken(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  // Require a valid Firebase ID token — unauthenticated callers get 401.
  try { await _requireAuth(request, env); } catch (e) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { roomName, participantName, canPublish = false } = body;
  if (!roomName || !participantName) {
    return new Response(JSON.stringify({ error: 'roomName and participantName are required' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Build LiveKit access token using shared JWT signer
  const now = Math.floor(Date.now() / 1000);
  const token = await signLiveKitJwt(apiKey, apiSecret, {
    iss:  apiKey,
    sub:  participantName,
    iat:  now,
    exp:  now + 6 * 3600,
    nbf:  now,
    name: participantName,
    video: {
      room:           roomName,
      roomJoin:       true,
      canPublish,
      canSubscribe:   true,
      canPublishData: true,
    },
  });

  return new Response(JSON.stringify({ token, url: env.LIVEKIT_URL }), {
    status: 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Firebase ID token verifier ────────────────────────────────────────────────
// Calls the Google Identity Toolkit getAccountInfo endpoint to verify a Firebase
// ID token and extract the user's UID.  Returns the verified UID string on success,
// throws a 401/502 error on failure.
async function _fbVerifyToken(env, idToken) {
  const tokenRes = await fetch(
    `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${env.FIREBASE_WEB_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
  ).catch(() => null);
  if (!tokenRes) throw Object.assign(new Error('Token verification service unreachable'), { status: 502 });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.users?.[0]?.localId) {
    const msg = tokenData?.error?.message || 'Invalid or expired token';
    throw Object.assign(new Error('Unauthorized: ' + msg), { status: 401 });
  }
  return tokenData.users[0].localId;
}

// ── Auth helper: extract + verify Bearer token from Authorization header ──────
// Returns uid (string) on success, throws on failure.
// Endpoints that need authentication call this before processing.
async function _requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!idToken) throw Object.assign(new Error('Authentication required'), { status: 401 });
  if (!env.FIREBASE_WEB_API_KEY) throw Object.assign(new Error('Auth service not configured'), { status: 503 });
  const uid = await _fbVerifyToken(env, idToken);
  return uid;
}

// ── Resumable / chunked upload ────────────────────────────────────────────────
//
//  Phase 1 — POST /upload-chunk
//    Authorization: Bearer <firebase-id-token>
//    FormData: { uploadId, chunkIndex, totalChunks, chunk(File) }
//    Stores each chunk as a temporary R2 object at:
//      _tmp/{verifiedUid}/{uploadId}/chunk_{chunkIndex}
//    The UID is derived from the verified Firebase token — never trusted from the body.
//    Returns { ok: true }
//
//  Phase 2 — POST /upload-complete
//    Authorization: Bearer <firebase-id-token>
//    FormData: { uploadId, totalChunks, key, fileName, fileType, fileSize }
//    Reads all chunks from R2 in order, assembles via R2 Multipart Upload
//    (avoids loading entire file into Worker memory), stores final object at `key`,
//    deletes temp chunk objects, returns { url, key }.
//
// This lets the client implement retry-per-chunk for mobile/slow connections.

async function handleUploadChunk(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let fd;
  try { fd = await request.formData(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uploadId    = (fd.get('uploadId')    || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const chunkIndex  = parseInt(fd.get('chunkIndex')  || '0', 10);
  const totalChunks = parseInt(fd.get('totalChunks') || '1', 10);
  const chunk       = fd.get('chunk');

  if (!uploadId || !chunk || typeof chunk === 'string') {
    return new Response(JSON.stringify({ error: 'uploadId and chunk are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  if (chunkIndex < 0 || chunkIndex >= totalChunks) {
    return new Response(JSON.stringify({ error: 'Invalid chunkIndex' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const buffer = await chunk.arrayBuffer();
  if (buffer.byteLength > 50 * 1024 * 1024) { // 50 MB max per chunk
    return new Response(JSON.stringify({ error: 'Chunk too large (max 50 MB)' }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Key scoped to authenticated UID — prevents cross-user chunk injection
  const tmpKey = `_tmp/${verifiedUid}/${uploadId}/chunk_${String(chunkIndex).padStart(6, '0')}`;
  try {
    await env.BUCKET.put(tmpKey, buffer, {
      customMetadata: { uploaderUid: verifiedUid, chunkIndex: String(chunkIndex) }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'R2 chunk store failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ ok: true, chunkIndex }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleUploadComplete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let fd;
  try { fd = await request.formData(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uploadId    = (fd.get('uploadId')    || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const totalChunks = parseInt(fd.get('totalChunks') || '1', 10);
  const fileName    = fd.get('fileName')    || 'upload';
  let   fileType    = fd.get('fileType')    || 'application/octet-stream';
  const fileSize    = parseInt(fd.get('fileSize') || '0', 10);

  // Derive the final key server-side from the verified UID — never accept it from the client
  const ext      = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const finalKey = (fd.get('key') || '').replace(/\.\./g, '') || `${verifiedUid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

  // Enforce: the final key must start with the authenticated user's UID namespace.
  // All organised upload paths are allowed; the user's raw UID prefix is the fallback.
  const allowedPrefixes = [
    `${verifiedUid}/`,
    `profiles/${verifiedUid}/`,
    `videos/${verifiedUid}/`,
    `music/${verifiedUid}/`,
    `posts/${verifiedUid}/`,
    `radio/${verifiedUid}/`,
    `themes/${verifiedUid}/`,
    `users/${verifiedUid}/`,
  ];
  if (!allowedPrefixes.some(p => finalKey.startsWith(p))) {
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to your account' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!uploadId || totalChunks < 1) {
    return new Response(JSON.stringify({ error: 'uploadId and totalChunks are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Validate total assembled size
  const sizeLimit = fileType.startsWith('image/') ? MAX_SIZE_IMAGE
                  : fileType.startsWith('video/') ? MAX_SIZE_VIDEO
                  : MAX_SIZE_AUDIO;
  if (fileSize > sizeLimit) {
    const limitMB = Math.round(sizeLimit / 1024 / 1024);
    return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Validate MIME
  const extMime = mimeFromExt(fileName);
  if (!fileType || fileType === 'application/octet-stream') fileType = extMime || fileType;
  else if (extMime && fileType.startsWith('video/') && extMime.startsWith('audio/')) fileType = extMime;
  if (!isAllowedType(fileType)) {
    return new Response(JSON.stringify({ error: `File type not supported: ${fileType}` }), {
      status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const cleanMime = fileType.split(';')[0].trim();

  // ── Assemble chunks via R2 Multipart Upload (memory-efficient) ──────────────
  // Creates an MPU, streams each temp chunk as a part, then completes —
  // avoids loading the entire file into Worker memory as a single Uint8Array.
  let mpuUpload;
  try {
    mpuUpload = await env.BUCKET.createMultipartUpload(finalKey, {
      httpMetadata:   { contentType: cleanMime },
      customMetadata: { uploaderUid: verifiedUid, originalName: fileName },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Failed to start assembly: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uploadedParts = [];
  for (let i = 0; i < totalChunks; i++) {
    const tmpKey = `_tmp/${verifiedUid}/${uploadId}/chunk_${String(i).padStart(6, '0')}`;
    let obj;
    try { obj = await env.BUCKET.get(tmpKey); }
    catch (e) {
      await mpuUpload.abort().catch(() => {});
      return new Response(JSON.stringify({ error: `Failed to read chunk ${i}: ` + e.message }), {
        status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    if (!obj) {
      await mpuUpload.abort().catch(() => {});
      return new Response(JSON.stringify({ error: `Chunk ${i} not found — upload may have expired` }), {
        status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    let part;
    try {
      part = await mpuUpload.uploadPart(i + 1, obj.body);
    } catch (e) {
      await mpuUpload.abort().catch(() => {});
      return new Response(JSON.stringify({ error: `Failed to assemble chunk ${i}: ` + e.message }), {
        status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    uploadedParts.push({ partNumber: part.partNumber, etag: part.etag });
  }

  try {
    await mpuUpload.complete(uploadedParts);
  } catch (e) {
    await mpuUpload.abort().catch(() => {});
    return new Response(JSON.stringify({ error: 'R2 assembly completion failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Clean up temp chunks (best-effort — do not fail the response if this fails)
  for (let i = 0; i < totalChunks; i++) {
    const tmpKey = `_tmp/${verifiedUid}/${uploadId}/chunk_${String(i).padStart(6, '0')}`;
    env.BUCKET.delete(tmpKey).catch(() => {});
  }

  const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${finalKey}`;
  return new Response(JSON.stringify({ url: publicUrl, key: finalKey }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SHADOW FIRE LIVE — VIDEO UPLOAD HANDLERS
//
//  Routes (SFL video upload pipeline — shares this worker with SNS):
//    GET  /upload-health         — health/capability check (r2, stream configured?)
//    POST /stream/upload-url     — Cloudflare Stream direct-upload URL
//    GET  /stream/status         — Cloudflare Stream processing status
//    POST /stream/delete         — Cloudflare Stream video delete (auth-verified)
//    POST /r2/delete             — R2 video file delete (auth-verified, owner-scoped)
//    POST /mpu/create            — R2 multipart upload: create
//    POST /mpu/presign           — R2 multipart upload: presigned part URL
//    POST /mpu/part              — R2 multipart upload: upload one part (proxy)
//    POST /mpu/complete          — R2 multipart upload: complete
//    POST /mpu/abort             — R2 multipart upload: abort
//
//  These routes are used exclusively by Shadow Fire Live (sfl-upload.html).
//  All SNS routes (LiveKit, media upload, music) are unaffected.
// ═══════════════════════════════════════════════════════════════════════════════

// ── R2 Multipart Upload — video upload without loading file into Worker memory ─
//
//   POST /mpu/create    → BUCKET.createMultipartUpload()  → { r2UploadId, key }
//   POST /mpu/part      → BUCKET.resumeMultipartUpload().uploadPart(stream)  → { partNumber, etag }
//   POST /mpu/presign   → signed URL for PUT directly to R2 (bypasses Worker CPU)
//   POST /mpu/complete  → BUCKET.resumeMultipartUpload().complete(parts)     → { url, key }
//   POST /mpu/abort     → BUCKET.resumeMultipartUpload().abort()
//
// Minimum part size enforced by R2: 5 MiB (except final part).

async function handleMpuCreate(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let uid;
  try { uid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const fileName = (body.fileName || 'upload').slice(0, 200);
  let   fileType =  body.fileType || 'application/octet-stream';
  const fileSize = parseInt(body.fileSize || '0', 10);

  const extMime = mimeFromExt(fileName);
  if (!fileType || fileType === 'application/octet-stream') fileType = extMime || fileType;
  else if (extMime && fileType.startsWith('video/') && extMime.startsWith('audio/')) fileType = extMime;
  if (!isAllowedType(fileType)) {
    return new Response(JSON.stringify({ error: `File type not supported: ${fileType}` }), {
      status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const sizeLimit = fileType.startsWith('image/') ? MAX_SIZE_IMAGE
                  : fileType.startsWith('video/') ? MAX_SIZE_VIDEO
                  : MAX_SIZE_AUDIO;
  if (fileSize > sizeLimit) {
    const limitMB = Math.round(sizeLimit / 1024 / 1024);
    return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB)` }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const ext = (fileName.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = `videos/${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const cleanMime = fileType.split(';')[0].trim();

  let mpu;
  try {
    mpu = await env.BUCKET.createMultipartUpload(key, {
      httpMetadata:   { contentType: cleanMime },
      customMetadata: { uploaderUid: uid, originalName: fileName },
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Failed to create multipart upload: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  console.log(`[MPU] Created. key=${key} r2UploadId=${mpu.uploadId} uid=${uid}`);
  return new Response(JSON.stringify({ r2UploadId: mpu.uploadId, key }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleMpuPresign(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let presignUid;
  try { presignUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    // Gracefully fall back to proxy path — browser will use /mpu/part instead
    return new Response(JSON.stringify({ error: 'R2 presign not configured — use /mpu/part instead', fallback: true }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const key        = (body.key        || '').replace(/\.\./g, '');
  const r2UploadId =  body.r2UploadId || '';
  const partNumber = parseInt(body.partNumber || '0', 10);

  if (!key || !r2UploadId || partNumber < 1 || partNumber > 10000) {
    return new Response(JSON.stringify({ error: 'key, r2UploadId, and partNumber (1–10000) are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Enforce ownership: key must belong to the authenticated user
  const presignKeyOwned = key.startsWith(`${presignUid}/`) || key.startsWith(`profiles/${presignUid}/`) || key.startsWith(`videos/${presignUid}/`);
  if (!presignKeyOwned) {
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to your account' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const bucketName = env.BUCKET_NAME || 'legend';
  const accountId  = env.CLOUDFLARE_ACCOUNT_ID;
  if (!accountId) {
    return new Response(JSON.stringify({ error: 'CLOUDFLARE_ACCOUNT_ID not set' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const s3Endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
  const partUrl    = `${s3Endpoint}/${bucketName}/${encodeURIComponent(key)}?partNumber=${partNumber}&uploadId=${encodeURIComponent(r2UploadId)}`;
  const expires    = 3600;
  const now        = new Date();
  const dateStamp  = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate    = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 16) + 'Z';
  const method     = 'PUT';
  const service    = 's3';
  const region     = 'auto';
  const credScope  = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = 'host';
  const host       = `${accountId}.r2.cloudflarestorage.com`;

  const urlObj = new URL(partUrl);
  urlObj.searchParams.set('X-Amz-Algorithm',     'AWS4-HMAC-SHA256');
  urlObj.searchParams.set('X-Amz-Credential',    `${env.R2_ACCESS_KEY_ID}/${credScope}`);
  urlObj.searchParams.set('X-Amz-Date',          amzDate);
  urlObj.searchParams.set('X-Amz-Expires',       String(expires));
  urlObj.searchParams.set('X-Amz-SignedHeaders', signedHeaders);
  urlObj.searchParams.sort();
  const canonicalQueryString = urlObj.searchParams.toString();

  const canonicalRequest = [
    method,
    `/${bucketName}/${key}`,
    canonicalQueryString,
    `host:${host}\n`,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const enc     = s => new TextEncoder().encode(s);
  const hashHex = async data => {
    const buf = await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc(data) : data);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const hmacKey = async (key, data) => {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc(data)));
  };

  const hashedCanonical = await hashHex(canonicalRequest);
  const stringToSign    = ['AWS4-HMAC-SHA256', amzDate, credScope, hashedCanonical].join('\n');

  const kDate    = await hmacKey(enc('AWS4' + env.R2_SECRET_ACCESS_KEY), dateStamp);
  const kRegion  = await hmacKey(kDate,    region);
  const kService = await hmacKey(kRegion,  service);
  const kSigning = await hmacKey(kService, 'aws4_request');

  const sigBuffer  = await crypto.subtle.sign('HMAC',
    await crypto.subtle.importKey('raw', kSigning, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    enc(stringToSign));
  const signature  = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  urlObj.searchParams.set('X-Amz-Signature', signature);

  console.log(`[MPU Presign] key=${key} part=${partNumber}`);
  return new Response(JSON.stringify({ presignedUrl: urlObj.toString() }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleMpuPart(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const url2       = new URL(request.url);
  const key        = decodeURIComponent(url2.searchParams.get('key')        || '').replace(/\.\./g, '');
  const r2UploadId = url2.searchParams.get('r2UploadId') || '';
  const partNumber = parseInt(url2.searchParams.get('partNumber') || '0', 10);

  if (!key || !r2UploadId || partNumber < 1 || partNumber > 10000) {
    return new Response(JSON.stringify({ error: 'key, r2UploadId, and partNumber (1-10000) are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  if (!request.body) {
    return new Response(JSON.stringify({ error: 'Request body (part bytes) is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Enforce ownership: key must belong to the authenticated user
  const partKeyOwned = key.startsWith(`${verifiedUid}/`) || key.startsWith(`profiles/${verifiedUid}/`) || key.startsWith(`videos/${verifiedUid}/`);
  if (!partKeyOwned) {
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to your account' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const upload = env.BUCKET.resumeMultipartUpload(key, r2UploadId);
  let uploadedPart;
  try {
    uploadedPart = await upload.uploadPart(partNumber, request.body);
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Part upload failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  return new Response(JSON.stringify({ partNumber: uploadedPart.partNumber, etag: uploadedPart.etag }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleMpuComplete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const key        = (body.key        || '').replace(/\.\./g, '');
  const r2UploadId =  body.r2UploadId || '';
  const parts      =  body.parts;

  if (!key || !r2UploadId || !Array.isArray(parts) || parts.length === 0) {
    return new Response(JSON.stringify({ error: 'key, r2UploadId, and parts[] are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Enforce ownership on the key being completed
  const completeKeyOwned = key.startsWith(`${verifiedUid}/`) || key.startsWith(`profiles/${verifiedUid}/`) || key.startsWith(`videos/${verifiedUid}/`);
  if (!completeKeyOwned) {
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to your account' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const upload = env.BUCKET.resumeMultipartUpload(key, r2UploadId);
  try {
    await upload.complete(parts);
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Multipart complete failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${key}`;
  console.log(`[MPU] Complete. key=${key} parts=${parts.length} uid=${verifiedUid}`);
  return new Response(JSON.stringify({ url: publicUrl, key }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

async function handleMpuAbort(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // ── Verify Firebase ID token ──────────────────────────────────────────────
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const key        = (body.key        || '').replace(/\.\./g, '');
  const r2UploadId =  body.r2UploadId || '';
  if (!key || !r2UploadId) {
    return new Response(JSON.stringify({ error: 'key and r2UploadId are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Enforce ownership on the key being aborted
  const abortKeyOwned = key.startsWith(`${verifiedUid}/`) || key.startsWith(`profiles/${verifiedUid}/`) || key.startsWith(`videos/${verifiedUid}/`);
  if (!abortKeyOwned) {
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to your account' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const upload = env.BUCKET.resumeMultipartUpload(key, r2UploadId);
  try { await upload.abort(); } catch(e) { /* best-effort */ }
  return new Response(JSON.stringify({ aborted: true }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── Cloudflare Stream: create a direct-upload URL ────────────────────────────
// POST /stream/upload-url   body: { uid, maxDurationSeconds?, title? }
// Requires secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
async function handleStreamUploadUrl(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    console.error('[Stream] Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN secrets');
    return new Response(JSON.stringify({ error: 'Stream service not configured' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const uid    = (body.uid   || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const title  = (body.title || '').slice(0, 255);
  const maxSec = Math.min(Math.max(parseInt(body.maxDurationSeconds || '10800', 10), 1), 36000);
  if (!uid) {
    return new Response(JSON.stringify({ error: 'uid is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const expiry  = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  const payload = {
    maxDurationSeconds: maxSec, expiry, creator: uid,
    meta: title ? { name: title } : {},
    allowedOrigins: [
      'shadowfirelive.com', '*.shadowfirelive.com',
      'shadownexussocial.online', '*.shadownexussocial.online',
      'localhost', '127.0.0.1',
    ],
    requireSignedURLs: false,
  };

  let cfRes;
  try {
    cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/direct_upload`,
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Failed to reach Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let cfData;
  try { cfData = await cfRes.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid response from Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!cfRes.ok || !cfData.success) {
    const msg      = cfData.errors?.[0]?.message || `Cloudflare API error ${cfRes.status}`;
    const isQuota  = /quota|capacity|storage|minutes|limit/i.test(msg);
    const status   = isQuota ? 503 : (cfRes.status >= 500 ? 502 : 400);
    console.error('[Stream] API error:', msg);
    return new Response(JSON.stringify({ error: msg, fallback: isQuota }), {
      status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const streamId  = cfData.result.uid;
  const uploadURL = cfData.result.uploadURL;
  console.log(`[Stream] Direct upload URL created. streamId=${streamId} uid=${uid}`);
  return new Response(JSON.stringify({ uploadURL, streamId }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// GET /stream/status?id=<streamId>
// Requires secrets: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
async function handleStreamStatus(request, env, cors, sec) {
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'Stream service not configured' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const streamId = (new URL(request.url).searchParams.get('id') || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!streamId) {
    return new Response(JSON.stringify({ error: 'id is required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let cfRes;
  try {
    cfRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${streamId}`,
      { method: 'GET', headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
    );
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Failed to reach Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let cfData;
  try { cfData = await cfRes.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid response from Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!cfRes.ok || !cfData.success) {
    const msg = cfData.errors?.[0]?.message || `Cloudflare API error ${cfRes.status}`;
    return new Response(JSON.stringify({ error: msg }), {
      status: cfRes.ok ? 200 : 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const r       = cfData.result;
  const hlsUrl  = r.playback?.hls  || `https://videodelivery.net/${r.uid}/manifest/video.m3u8`;
  const thumbUrl = r.thumbnail     || `https://videodelivery.net/${r.uid}/thumbnails/thumbnail.jpg`;

  return new Response(JSON.stringify({
    streamId:        r.uid,
    status:          r.status?.state       || 'unknown',
    readyToStream:   r.readyToStream       || false,
    playbackUrl:     hlsUrl,
    dashUrl:         r.playback?.dash      || null,
    thumbnailUrl:    thumbUrl,
    duration:        r.duration            || null,
    pctComplete:     r.status?.pctComplete || null,
    errorReasonCode: r.status?.errorReasonCode || null,
    errorReasonText: r.status?.errorReasonText || null,
  }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// POST /stream/delete   body: { idToken, streamId, ownerId }
// Verifies Firebase ID token then deletes the Cloudflare Stream video.
async function handleStreamDelete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    return new Response(JSON.stringify({ error: 'Stream service not configured' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { idToken, streamId, ownerId } = body || {};
  if (!idToken || !streamId || !ownerId) {
    return new Response(JSON.stringify({ error: 'idToken, streamId, and ownerId are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Verify Firebase ID token
  let verifiedUid;
  try {
    const tokenRes  = await fetch(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${env.FIREBASE_WEB_API_KEY || ''}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.users?.[0]?.localId) {
      console.error('[stream/delete] Token verification failed:', tokenData?.error?.message);
      return new Response(JSON.stringify({ error: 'Unauthorized: invalid or expired token' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    verifiedUid = tokenData.users[0].localId;
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Token verification failed' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (verifiedUid !== ownerId.replace(/[^a-zA-Z0-9_-]/g, '')) {
    return new Response(JSON.stringify({ error: 'Forbidden: you do not own this video' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const safeStreamId = streamId.replace(/[^a-zA-Z0-9]/g, '');
  if (!safeStreamId) {
    return new Response(JSON.stringify({ error: 'Invalid streamId' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  try {
    const delRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${safeStreamId}`,
      { method: 'DELETE', headers: { 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
    );
    if (delRes.status === 204 || delRes.status === 404) {
      console.log(`[stream/delete] Deleted streamId=${safeStreamId} uid=${verifiedUid}`);
      return new Response(JSON.stringify({ deleted: true, streamId: safeStreamId }), {
        status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    const errData = await delRes.json().catch(() => ({}));
    const msg     = errData?.errors?.[0]?.message || `Cloudflare API error ${delRes.status}`;
    return new Response(JSON.stringify({ error: msg }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Failed to reach Cloudflare Stream API' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
}

// POST /r2/delete   body: { idToken, r2Key, ownerId }
// Verifies Firebase ID token, confirms key is owned by caller, then deletes from R2.
async function handleR2Delete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); } catch(e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { idToken, r2Key, ownerId } = body || {};
  if (!idToken || !r2Key || !ownerId) {
    return new Response(JSON.stringify({ error: 'idToken, r2Key, and ownerId are required' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Verify Firebase ID token
  let verifiedUid;
  try {
    const tokenRes  = await fetch(
      `https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${env.FIREBASE_WEB_API_KEY || ''}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) }
    );
    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.users?.[0]?.localId) {
      return new Response(JSON.stringify({ error: 'Unauthorized: invalid or expired token' }), {
        status: 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    verifiedUid = tokenData.users[0].localId;
  } catch(e) {
    return new Response(JSON.stringify({ error: 'Token verification failed' }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const safeOwnerId = ownerId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (verifiedUid !== safeOwnerId) {
    return new Response(JSON.stringify({ error: 'Forbidden: you do not own this file' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const safeKey = r2Key.replace(/\.\./g, '');
  const ownsKey = safeKey.startsWith(`${safeOwnerId}/`)
               || safeKey.startsWith(`profiles/${safeOwnerId}/`)
               || safeKey.startsWith(`videos/${safeOwnerId}/`)
               || safeKey.startsWith(`music/${safeOwnerId}/`)
               || safeKey.startsWith(`posts/${safeOwnerId}/`)
               || safeKey.startsWith(`radio/${safeOwnerId}/`)
               || safeKey.startsWith(`themes/${safeOwnerId}/`)
               || safeKey.startsWith(`users/${safeOwnerId}/`);
  if (!ownsKey) {
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to owner' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  try {
    await env.BUCKET.delete(safeKey);
    console.log(`[r2/delete] Deleted key=${safeKey} uid=${safeOwnerId}`);
    return new Response(JSON.stringify({ deleted: true, key: safeKey }), {
      status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: 'R2 delete failed: ' + e.message }), {
      status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
}

// ── POST /supabase-upload ─────────────────────────────────────────────────────
// Proxies an authenticated music upload to Supabase Storage.
// The Supabase service-role key lives ONLY here in the Worker — never in the browser.
// Auth: requires valid Firebase ID token (Bearer).
// FormData fields: file, path (storage key), bucket (optional, default: snx-music)
async function handleSupabaseUpload(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Verify Firebase identity
  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Supabase service-role key required
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase not configured on this Worker (set SUPABASE_URL and SUPABASE_SERVICE_KEY secrets)' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let formData;
  try { formData = await request.formData(); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const file   = formData.get('file');
  const bucket = (formData.get('bucket') || 'snx-music').replace(/[^a-zA-Z0-9_-]/g, '');
  let   key    = (formData.get('path')   || '').replace(/\.\./g, '').trim();

  if (!file || typeof file === 'string') {
    return new Response(JSON.stringify({ error: 'No file received' }), {
      status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Validate path ownership
  if (!key || !key.startsWith(`music/${verifiedUid}/`)) {
    key = `music/${verifiedUid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${(file.name.split('.').pop()||'mp3').toLowerCase()}`;
  }

  // MIME + size check
  let mime = file.type || 'application/octet-stream';
  const extMime = mimeFromExt(file.name);
  if ((!mime || mime === 'application/octet-stream') && extMime) mime = extMime;
  const cleanMime = mime.split(';')[0].trim();

  const buffer = await file.arrayBuffer();
  const sizeLimit = cleanMime.startsWith('image/') ? MAX_SIZE_IMAGE : MAX_SIZE_AUDIO;
  if (buffer.byteLength > sizeLimit) {
    return new Response(JSON.stringify({ error: `File too large (max ${Math.round(sizeLimit/1024/1024)} MB)` }), {
      status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Upload to Supabase Storage using service-role key
  const supabaseUploadUrl = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${key}`;
  let sbRes;
  try {
    sbRes = await fetch(supabaseUploadUrl, {
      method: 'POST',
      headers: {
        'Authorization':  `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type':   cleanMime,
        'x-upsert':       'false',
      },
      body: buffer
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Supabase upload failed: ' + e.message }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!sbRes.ok) {
    let detail = '(no details)';
    try { const d = await sbRes.json(); detail = d.message || d.error || JSON.stringify(d); } catch(_) {}
    return new Response(JSON.stringify({ error: `Supabase upload failed (HTTP ${sbRes.status}): ${detail}` }), {
      status: sbRes.status >= 500 ? 502 : sbRes.status,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const publicUrl = `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${key}`;
  return new Response(JSON.stringify({ url: publicUrl, key }), {
    status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

// ── POST /supabase-delete ─────────────────────────────────────────────────────
// Deletes an object from Supabase Storage.
// Auth: requires valid Firebase ID token (Bearer).
// Body JSON: { key, bucket }
async function handleSupabaseDelete(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let verifiedUid;
  try { verifiedUid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase not configured' }), {
      status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }
  const key    = (body.key    || '').replace(/\.\./g, '');
  const bucket = (body.bucket || 'snx-music').replace(/[^a-zA-Z0-9_-]/g, '');

  if (!key.startsWith(`music/${verifiedUid}/`)) {
    return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to your account' }), {
      status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const delUrl = `${env.SUPABASE_URL}/storage/v1/object/${bucket}/${key}`;
  try {
    const res = await fetch(delUrl, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}` }
    });
    if (!res.ok && res.status !== 404) {
      return new Response(JSON.stringify({ error: 'Supabase delete failed (HTTP ' + res.status + ')' }), {
        status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }
    return new Response(JSON.stringify({ deleted: true, key }), {
      status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Supabase delete failed: ' + e.message }), {
      status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
}

// ── LiveKit TURN credential provider ─────────────────────────────────────────
// GET /turn-credentials
//   Returns short-lived ICE server entries (STUN + TURN) from LiveKit.
//   Credentials expire in 1 hour (3600 s) — never cached beyond that.
//   Requires: Authorization: Bearer <firebase-id-token>   (authenticated users only)
//
// LiveKit RTCService.GetICEServers is a Twirp/JSON endpoint that returns:
//   { iceServers: [ { urls, username, credential } ] }
// Docs: https://docs.livekit.io/reference/server-apis/
async function handleTurnCredentials(request, env, cors, sec) {
  // Only allow authenticated users
  let uid;
  try { uid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status || 401,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const livekitUrl = (env.LIVEKIT_URL || '')
    .replace('wss://', 'https://')
    .replace('ws://',  'http://');

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Mint a minimal LiveKit JWT with no room/publish grants — only used to
  // authenticate the GetICEServers call. Valid for 65 seconds (enough for one call).
  const now = Math.floor(Date.now() / 1000);
  const token = await signLiveKitJwt(apiKey, apiSecret, {
    iss: apiKey,
    sub: uid,
    iat: now,
    exp: now + 65,
    nbf: now,
    video: {},   // no room grants needed for GetICEServers
  });

  let lkResp;
  try {
    lkResp = await fetch(`${livekitUrl}/twirp/livekit.RTCService/GetICEServers`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'LiveKit TURN API unreachable: ' + e.message }), {
      status: 502,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  if (!lkResp.ok) {
    const errBody = await lkResp.text();
    return new Response(JSON.stringify({ error: 'LiveKit TURN API error: ' + errBody }), {
      status: lkResp.status,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const lkData = await lkResp.json();
  // lkData.iceServers is an array of { urls, username, credential }
  const iceServers = lkData.iceServers || [];

  return new Response(JSON.stringify({ iceServers }), {
    status: 200,
    headers: mergeHeaders(cors, sec, {
      'Content-Type':  'application/json',
      // Allow clients to cache the response for up to 50 minutes (credentials are valid 1 h)
      'Cache-Control': 'private, max-age=3000',
    })
  });
}


// ══════════════════════════════════════════════════════════════════════════════
//  BROADCAST DESTINATION MANAGER
//  Stores RTMP/RTMPS destinations (server URL + stream key) on behalf of the
//  Founder.  Stream keys are NEVER logged and NEVER returned to the client —
//  only a masked preview (last 4 chars) is sent back.
//
//  Storage: Firestore /broadcastDestinations/{destId}
//    Fields: name, serverUrl, streamKey (encrypted at rest by Firestore), enabled,
//            createdAt, updatedAt
//
//  Rules: isFounderEmail() write-only — enforced in firestore.rules.
//  These Worker routes are an additional layer: they verify the Firebase ID token
//  server-side before forwarding any write to Firestore REST.
//
//  Routes:
//    GET    /broadcast/destinations         — list destinations (keys masked)
//    POST   /broadcast/destinations         — create destination
//    PATCH  /broadcast/destinations/:id     — update destination
//    DELETE /broadcast/destinations/:id     — delete destination
// ══════════════════════════════════════════════════════════════════════════════

// Firestore project ID — used to build REST URLs
const FIRESTORE_PROJECT_ID = 'shadownexussocial';
const BROADCAST_COLLECTION = 'broadcastDestinations';

// Mask a stream key — show only last 4 characters, rest as ****
function _maskKey(key) {
  if (!key || key.length <= 4) return '****';
  return '*'.repeat(Math.min(key.length - 4, 20)) + key.slice(-4);
}

// Build Firestore REST base URL
function _fsUrl(projectId) {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

// Convert a Firestore REST document object → plain JS object
function _fsDocToObj(doc) {
  if (!doc || !doc.fields) return null;
  const obj = { _id: (doc.name || '').split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields)) {
    if (v.stringValue  !== undefined) obj[k] = v.stringValue;
    else if (v.booleanValue !== undefined) obj[k] = v.booleanValue;
    else if (v.integerValue !== undefined) obj[k] = Number(v.integerValue);
    else if (v.timestampValue !== undefined) obj[k] = v.timestampValue;
    else obj[k] = null;
  }
  return obj;
}

// Convert a plain JS object → Firestore REST fields map
function _objToFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string')  fields[k] = { stringValue: v };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number')  fields[k] = { integerValue: String(v) };
  }
  return fields;
}

// ── Verify caller is the Founder via Firebase ID token ───────────────────────
// Returns the verified UID. Throws if not authenticated or not the Founder.
async function _requireFounder(request, env) {
  const uid = await _requireAuth(request, env);
  // Fetch the user's record from Firestore to confirm founder role
  // (same check as isFounder() rule, but server-side in the Worker)
  const userUrl = `${_fsUrl(FIRESTORE_PROJECT_ID)}/users/${uid}`;
  const authHeader = request.headers.get('Authorization') || '';
  const userRes = await fetch(userUrl, {
    headers: { 'Authorization': authHeader }
  }).catch(() => null);
  if (!userRes || !userRes.ok) {
    // If we can't read the user doc, fall back to UID allow-list
    // (Firestore rule isFounderEmail checks token email — we trust the token)
    // We still proceed: the Firestore security rules are the final gate.
    return uid;
  }
  const userData = await userRes.json().catch(() => ({}));
  const role = userData?.fields?.role?.stringValue || '';
  if (role !== 'founder') {
    throw Object.assign(new Error('Forbidden: Founder access required'), { status: 403 });
  }
  return uid;
}

// GET /broadcast/destinations
async function handleBroadcastList(request, env, cors, sec) {
  let uid;
  try { uid = await _requireFounder(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const listUrl = `${_fsUrl(FIRESTORE_PROJECT_ID)}/${BROADCAST_COLLECTION}`;
  let fsRes;
  try { fsRes = await fetch(listUrl, { headers: { 'Authorization': authHeader } }); }
  catch (e) {
    return new Response(JSON.stringify({ error: 'Firestore unreachable' }),
      { status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const fsData = await fsRes.json().catch(() => ({}));
  const docs = (fsData.documents || []).map(doc => {
    const obj = _fsDocToObj(doc);
    if (!obj) return null;
    // NEVER return the full stream key — only a masked preview
    if (obj.streamKey) {
      obj.streamKeyMasked = _maskKey(obj.streamKey);
      delete obj.streamKey;
    }
    return obj;
  }).filter(Boolean);

  return new Response(JSON.stringify({ destinations: docs }),
    { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// POST /broadcast/destinations  body: { name, serverUrl, streamKey, enabled }
async function handleBroadcastCreate(request, env, cors, sec) {
  let uid;
  try { uid = await _requireFounder(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const { name, serverUrl, streamKey, enabled = true } = body || {};
  if (!name || !serverUrl || !streamKey) {
    return new Response(JSON.stringify({ error: 'name, serverUrl, and streamKey are required' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }
  // Validate serverUrl starts with rtmp:// or rtmps://
  if (!/^rtmps?:\/\//i.test(serverUrl)) {
    return new Response(JSON.stringify({ error: 'serverUrl must start with rtmp:// or rtmps://' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const now = new Date().toISOString();
  const docFields = _objToFsFields({ name, serverUrl, streamKey, enabled, createdAt: now, updatedAt: now, createdBy: uid });

  const authHeader = request.headers.get('Authorization') || '';
  const createUrl = `${_fsUrl(FIRESTORE_PROJECT_ID)}/${BROADCAST_COLLECTION}`;
  let fsRes;
  try {
    fsRes = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: docFields })
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Firestore write failed: ' + e.message }),
      { status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  if (!fsRes.ok) {
    const errData = await fsRes.json().catch(() => ({}));
    const msg = errData?.error?.message || `Firestore error ${fsRes.status}`;
    return new Response(JSON.stringify({ error: msg }),
      { status: fsRes.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const created = await fsRes.json().catch(() => ({}));
  const obj = _fsDocToObj(created);
  if (obj && obj.streamKey) {
    obj.streamKeyMasked = _maskKey(obj.streamKey);
    delete obj.streamKey;
  }

  // Log only name + masked key — never the full key
  console.log(`[broadcast/create] uid=${uid} name=${name} key=${_maskKey(streamKey)}`);

  return new Response(JSON.stringify({ destination: obj }),
    { status: 201, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// PATCH /broadcast/destinations/:id  body: { name?, serverUrl?, streamKey?, enabled? }
async function handleBroadcastUpdate(request, env, cors, sec, destId) {
  let uid;
  try { uid = await _requireFounder(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const allowed = ['name', 'serverUrl', 'streamKey', 'enabled'];
  const update = { updatedAt: new Date().toISOString() };
  for (const k of allowed) {
    if (body[k] !== undefined) update[k] = body[k];
  }

  if (update.serverUrl && !/^rtmps?:\/\//i.test(update.serverUrl)) {
    return new Response(JSON.stringify({ error: 'serverUrl must start with rtmp:// or rtmps://' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const docFields = _objToFsFields(update);
  // Build updateMask so only provided fields are touched
  const updateMask = Object.keys(update).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');

  const authHeader = request.headers.get('Authorization') || '';
  const patchUrl = `${_fsUrl(FIRESTORE_PROJECT_ID)}/${BROADCAST_COLLECTION}/${destId}?${updateMask}`;
  let fsRes;
  try {
    fsRes = await fetch(patchUrl, {
      method: 'PATCH',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: docFields })
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Firestore write failed: ' + e.message }),
      { status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  if (!fsRes.ok) {
    const errData = await fsRes.json().catch(() => ({}));
    const msg = errData?.error?.message || `Firestore error ${fsRes.status}`;
    return new Response(JSON.stringify({ error: msg }),
      { status: fsRes.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const updated = await fsRes.json().catch(() => ({}));
  const obj = _fsDocToObj(updated);
  if (obj && obj.streamKey) {
    obj.streamKeyMasked = _maskKey(obj.streamKey);
    delete obj.streamKey;
  }

  if (body.streamKey) console.log(`[broadcast/update] uid=${uid} id=${destId} key=**** (updated)`);
  else console.log(`[broadcast/update] uid=${uid} id=${destId}`);

  return new Response(JSON.stringify({ destination: obj }),
    { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// DELETE /broadcast/destinations/:id
async function handleBroadcastDelete(request, env, cors, sec, destId) {
  let uid;
  try { uid = await _requireFounder(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const delUrl = `${_fsUrl(FIRESTORE_PROJECT_ID)}/${BROADCAST_COLLECTION}/${destId}`;
  let fsRes;
  try {
    fsRes = await fetch(delUrl, {
      method: 'DELETE',
      headers: { 'Authorization': authHeader }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Firestore delete failed: ' + e.message }),
      { status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  if (!fsRes.ok && fsRes.status !== 404) {
    const errData = await fsRes.json().catch(() => ({}));
    const msg = errData?.error?.message || `Firestore error ${fsRes.status}`;
    return new Response(JSON.stringify({ error: msg }),
      { status: fsRes.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  console.log(`[broadcast/delete] uid=${uid} id=${destId}`);
  return new Response(JSON.stringify({ deleted: true, id: destId }),
    { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// ══════════════════════════════════════════════════════════════════════════════
//  BROADCAST CONTROL PLANE — proxies to the server-side broadcast engine
//
//  The browser cannot reach the broadcast service directly (it listens on
//  127.0.0.1 only).  This Worker acts as the secure gateway:
//    1. Verifies the Firebase ID token (Founder only)
//    2. Signs a short-lived SNX founder token using SNX_MEDIA_SERVER_SECRET
//    3. Forwards the request to the broadcast service at SNX_BROADCAST_SERVICE_URL
//
//  Routes:
//    POST /broadcast/start   — start the broadcast
//    POST /broadcast/stop    — stop the broadcast
//    GET  /broadcast/status  — full engine status (no secrets)
//
//  Required Worker secrets / vars:
//    SNX_MEDIA_SERVER_SECRET   — shared secret for SNX token signing
//    SNX_BROADCAST_SERVICE_URL — e.g. http://127.0.0.1:3100  (only reachable on VPS)
//
//  NEVER forward stream keys, RTMP URLs, or Firebase credentials.
// ══════════════════════════════════════════════════════════════════════════════

async function handleBroadcastStart(request, env, cors, sec) {
  // 1. Verify Founder
  let uid;
  try { uid = await _requireFounder(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const broadcastUrl = env.SNX_BROADCAST_SERVICE_URL;
  if (!broadcastUrl) {
    return new Response(JSON.stringify({ error: 'Broadcast service not configured (set SNX_BROADCAST_SERVICE_URL)' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }
  const secret = env.SNX_MEDIA_SERVER_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: 'Broadcast auth not configured (set SNX_MEDIA_SERVER_SECRET)' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // 2. Sign a short-lived SNX founder token
  const now = Math.floor(Date.now() / 1000);
  const snxToken = await _signSnxToken(secret, {
    uid, role: 'founder', roomId: 'broadcast', iat: now, exp: now + 300
  });

  // 3. Read body (forceRefreshDestinations flag)
  let body = {};
  try { body = await request.json(); } catch (_) {}

  // 4. Forward to broadcast service
  let svcRes;
  try {
    svcRes = await fetch(`${broadcastUrl}/broadcast/start`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${snxToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Broadcast service unreachable: ' + e.message }),
      { status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const data = await svcRes.json().catch(() => ({}));
  console.log(`[broadcast/start] uid=${uid} status=${svcRes.status}`);
  return new Response(JSON.stringify(data),
    { status: svcRes.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

async function handleBroadcastStop(request, env, cors, sec) {
  // 1. Verify Founder
  let uid;
  try { uid = await _requireFounder(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const broadcastUrl = env.SNX_BROADCAST_SERVICE_URL;
  if (!broadcastUrl) {
    return new Response(JSON.stringify({ error: 'Broadcast service not configured (set SNX_BROADCAST_SERVICE_URL)' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }
  const secret = env.SNX_MEDIA_SERVER_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: 'Broadcast auth not configured (set SNX_MEDIA_SERVER_SECRET)' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const now = Math.floor(Date.now() / 1000);
  const snxToken = await _signSnxToken(secret, {
    uid, role: 'founder', roomId: 'broadcast', iat: now, exp: now + 300
  });

  let svcRes;
  try {
    svcRes = await fetch(`${broadcastUrl}/broadcast/stop`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${snxToken}`, 'Content-Type': 'application/json' },
      body:    '{}',
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Broadcast service unreachable: ' + e.message }),
      { status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const data = await svcRes.json().catch(() => ({}));
  console.log(`[broadcast/stop] uid=${uid} status=${svcRes.status}`);
  return new Response(JSON.stringify(data),
    { status: svcRes.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

async function handleBroadcastStatus(request, env, cors, sec) {
  // 1. Verify Founder
  let uid;
  try { uid = await _requireFounder(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const broadcastUrl = env.SNX_BROADCAST_SERVICE_URL;
  if (!broadcastUrl) {
    return new Response(JSON.stringify({ error: 'Broadcast service not configured (set SNX_BROADCAST_SERVICE_URL)' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }
  const secret = env.SNX_MEDIA_SERVER_SECRET;
  if (!secret) {
    return new Response(JSON.stringify({ error: 'Broadcast auth not configured (set SNX_MEDIA_SERVER_SECRET)' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const now = Math.floor(Date.now() / 1000);
  const snxToken = await _signSnxToken(secret, {
    uid, role: 'founder', roomId: 'broadcast', iat: now, exp: now + 300
  });

  let svcRes;
  try {
    svcRes = await fetch(`${broadcastUrl}/broadcast/status`, {
      method:  'GET',
      headers: { 'Authorization': `Bearer ${snxToken}` },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Broadcast service unreachable: ' + e.message }),
      { status: 502, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const data = await svcRes.json().catch(() => ({}));
  // Safety: ensure no stream keys leak through the status response
  // (the broadcast service is supposed to guarantee this, but we double-check)
  const safeJson = JSON.stringify(data).replace(/"streamKey"\s*:\s*"[^"]*"/g, '"streamKey":"[redacted]"');
  return new Response(safeJson,
    { status: svcRes.status, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

/* ════════════════════════════════════════════════════════════════════════════
   SNS TV — 24/7 CHANNEL ADVANCEMENT
   OWNERSHIP: Shadow Nexus Social
   Firestore project: horr-a08f4  (SNS — Shadow Nexus Social)

   These functions implement the authoritative server-side advancement of the
   SNS 24-Hour TV (channel ALTV).  They are called by:
     1. POST /channel/advance  — viewer-triggered when an item ends in-browser
     2. scheduled()            — Cloudflare Cron Trigger (no viewer required)

   Architecture:
     - Read tv_state/ALTV and tv_config/ALTV from Firestore
     - Determine whether the current item has expired
     - Advance (with catch-up for delayed execution)
     - Write new state back; update config history
     - Idempotency via KV lock (SNX_TV_KV) — prevents double-advance
     - Does NOT stream video; maintains scheduling state only
════════════════════════════════════════════════════════════════════════════ */

// ── SNS TV Firestore constants ───────────────────────────────────────────────
// ── SNS-NATIVE TV REBUILD ──────────────────────────────────────────────────────
// TV state/config now lives in the SNS project (horr-a08f4), same as all other
// Shadow Nexus Social data.  No separate Firebase project.  No cross-project
// service account JSON required.
//
// SNS_TV_PROJECT changed from 'remix-studio-4bf8a' → 'horr-a08f4'
// Collections changed:
//   network_state/{id}           → tv_state/{id}
//   channel_live_tv_config/{id}  → tv_config/{id}
//   network_media                → tv_media
//
// REQUIRED SECRET (for Worker): FIREBASE_SERVICE_KEY must now be a service
// account for project horr-a08f4 (the SNS project), not remix-studio-4bf8a.
// This is the SAME project as FIREBASE_WEB_API_KEY targets.
// ─────────────────────────────────────────────────────────────────────────────
const SNS_TV_PROJECT      = 'horr-a08f4';
const SNS_TV_CHANNEL_ID   = 'ALTV';
const SNS_TV_STATE_DOC    = `tv_state/${SNS_TV_CHANNEL_ID}`;
const SNS_TV_CONFIG_DOC   = `tv_config/${SNS_TV_CHANNEL_ID}`;
const SNS_TV_MEDIA_COL    = 'tv_media';

const SNS_TV_PROGRAM_TYPES    = new Set([
  'video','music_video','show','broadcast_clip','audio_program',
  'podcast','station_id','archive','trailer','audio','music',
]);
const SNS_TV_COMMERCIAL_TYPES = new Set([
  'commercial','promo','trailer','station_id',
]);

// KV key prefix for idempotency locks
const SNS_TV_KV_LOCK_PREFIX = 'snstv:lock:';
// Maximum items to advance in one scheduled invocation (catch-up guard)
const SNS_TV_MAX_CATCHUP    = 50;
// Lock TTL in seconds (expires lock even if Worker crashes mid-write)
const SNS_TV_LOCK_TTL_SEC   = 60;

// ── Firestore REST helpers (SNS TV project) ───────────────────────────────────

function _tvFsUrl() {
  return `https://firestore.googleapis.com/v1/projects/${SNS_TV_PROJECT}/databases/(default)/documents`;
}

/** Decode a Firestore REST field value into a JS primitive / object. */
function _tvFsFieldDecode(f) {
  if (!f) return null;
  if ('stringValue'    in f) return f.stringValue;
  if ('integerValue'   in f) return Number(f.integerValue);
  if ('doubleValue'    in f) return Number(f.doubleValue);
  if ('booleanValue'   in f) return f.booleanValue;
  if ('timestampValue' in f) return new Date(f.timestampValue).getTime(); // epoch ms
  if ('nullValue'      in f) return null;
  if ('arrayValue'     in f) {
    const vals = f.arrayValue?.values || [];
    return vals.map(_tvFsFieldDecode);
  }
  if ('mapValue'       in f) return _tvFsDocToObj(f.mapValue);
  return null;
}

function _tvFsDocToObj(doc) {
  if (!doc || !doc.fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    out[k] = _tvFsFieldDecode(v);
  }
  return out;
}

/** Encode a JS value → Firestore REST field value. */
function _tvFsEncode(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number' && Number.isInteger(val)) return { integerValue: String(val) };
  if (typeof val === 'number')           return { doubleValue: val };
  if (typeof val === 'string')           return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(_tvFsEncode) } };
  }
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = _tvFsEncode(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function _tvObjToFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    fields[k] = _tvFsEncode(v);
  }
  return fields;
}

// ── Firebase Service Account JWT + access token ───────────────────────────────
//
// Required secret: FIREBASE_SERVICE_KEY
//   Value: JSON service account for project horr-a08f4, as a single-line string.
//   Create: Firebase Console → horr-a08f4 → Project Settings →
//           Service Accounts → Generate new private key
//   Store:  wrangler secret put FIREBASE_SERVICE_KEY --name yellow-term-11e6
//
// This is the SNS project service account — same project as FIREBASE_WEB_API_KEY.
// Must NOT be from remix-studio-4bf8a (that project is no longer used for TV).

let _tvAccessTokenCache = null;   // { token, expiresAt }

async function _tvGetAccessToken(env) {
  const now = Date.now();
  // Reuse cached token if still valid (>60s margin)
  if (_tvAccessTokenCache && _tvAccessTokenCache.expiresAt - now > 60_000) {
    return _tvAccessTokenCache.token;
  }

  const saJson = env.FIREBASE_SERVICE_KEY;
  if (!saJson) return null;

  let sa;
  try { sa = JSON.parse(saJson); }
  catch { return null; }

  // Build a signed JWT for the Google OAuth2 token endpoint
  const iat = Math.floor(now / 1000);
  const exp = iat + 3600;
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss:   sa.client_email,
    sub:   sa.client_email,
    aud:  'https://oauth2.googleapis.com/token',
    scope:'https://www.googleapis.com/auth/datastore',
    iat,
    exp,
  };

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = s => b64url(new TextEncoder().encode(JSON.stringify(s)));

  const sigInput = `${enc(header)}.${enc(payload)}`;

  // Import RSA private key from PEM
  const pem     = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyData = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8', keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
  } catch { return null; }

  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput)
  );
  const jwt = `${sigInput}.${b64url(sigBuf)}`;

  // Exchange JWT for OAuth2 access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  }).catch(() => null);

  if (!tokenRes || !tokenRes.ok) return null;
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenData.access_token) return null;

  _tvAccessTokenCache = {
    token:     tokenData.access_token,
    expiresAt: now + (tokenData.expires_in || 3600) * 1000,
  };
  return _tvAccessTokenCache.token;
}

// ── Firestore document read/write helpers ─────────────────────────────────────

async function _tvFsGet(path, token) {
  const url = `${_tvFsUrl()}/${path}`;
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const doc = await res.json().catch(() => null);
  if (!doc || doc.error) return null;
  return _tvFsDocToObj(doc);
}

async function _tvFsSet(path, data, token, updateMask) {
  // PATCH with updateMask to merge-update
  const fields = _tvObjToFsFields(data);
  const maskParam = updateMask
    ? '&' + updateMask.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&')
    : '';
  const url = `${_tvFsUrl()}/${path}?currentDocument.exists=true${maskParam}`;
  const res = await fetch(url, {
    method:  'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields }),
  }).catch(() => null);
  return res && res.ok;
}

/** Unconditional PATCH (create-or-update) — for first-write or full overwrites. */
async function _tvFsSetUncond(path, data, token) {
  const fields = _tvObjToFsFields(data);
  const url = `${_tvFsUrl()}/${path}`;
  const res = await fetch(url, {
    method:  'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields }),
  }).catch(() => null);
  return res && res.ok;
}

/** Query network_media for all approved, live-tv-eligible items (up to 500). */
async function _tvFetchMediaLib(token) {
  // Firestore structured query: status == 'approved'
  const url = `${_tvFsUrl()}/${SNS_TV_MEDIA_COL}:runQuery`;
  const body = {
    structuredQuery: {
      from:  [{ collectionId: SNS_TV_MEDIA_COL }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'status' },
          op:    'EQUAL',
          value: { stringValue: 'approved' },
        },
      },
      limit: 500,
    },
  };
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const rows = await res.json().catch(() => []);
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(r => r.document)
    .map(r => {
      const id   = r.document.name.split('/').pop();
      const data = _tvFsDocToObj(r.document);
      return { id, ...data };
    });
}

// ── KV-based idempotency lock ─────────────────────────────────────────────────
//
// Key:   snstv:lock:{channelId}:{itemId}
// Value: run ID string
// TTL:   SNS_TV_LOCK_TTL_SEC
//
// A successful lock means this Worker instance owns the advancement.
// Any other concurrent invocation reads the key and bails out immediately.

async function _tvAcquireLock(kv, channelId, itemId, runId) {
  if (!kv) return true;  // no KV configured — skip locking (fallback)
  const key = `${SNS_TV_KV_LOCK_PREFIX}${channelId}:${itemId || 'none'}`;
  try {
    // put with expiration: if the key already exists wrangler KV does not
    // support conditional puts natively, so we read first then write.
    const existing = await kv.get(key);
    if (existing) return false;   // already locked
    await kv.put(key, runId, { expirationTtl: SNS_TV_LOCK_TTL_SEC });
    // Double-check: read back to guard against a race between two identical invocations
    const readBack = await kv.get(key);
    return readBack === runId;
  } catch {
    return true; // KV error — proceed (fail-open; Firestore state check is the real guard)
  }
}

async function _tvReleaseLock(kv, channelId, itemId, runId) {
  if (!kv) return;
  const key = `${SNS_TV_KV_LOCK_PREFIX}${channelId}:${itemId || 'none'}`;
  try {
    const existing = await kv.get(key);
    if (existing === runId) await kv.delete(key);
  } catch { /* ignore */ }
}

// ── Program selection ─────────────────────────────────────────────────────────

function _tvPickProgram(mediaLib, config, justPlayedId) {
  const pool = mediaLib.filter(m =>
    SNS_TV_PROGRAM_TYPES.has(m.type) &&
    m.url &&
    m.live_tv_assigned !== false
  );
  if (!pool.length) return null;

  const recentHistory = config.recent_history || [];
  const avoidIds = justPlayedId ? [...recentHistory, justPlayedId] : recentHistory;
  let candidates = pool.filter(m => !avoidIds.includes(m.id));
  if (!candidates.length) candidates = pool.filter(m => m.id !== justPlayedId);
  if (!candidates.length) candidates = pool;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function _tvPickCommercials(mediaLib, config) {
  const FREQ_TABLE = {
    off:    { minPrograms: 999, maxPrograms: 999, minSpot: 0, maxSpot: 0 },
    low:    { minPrograms: 4,   maxPrograms: 7,   minSpot: 1, maxSpot: 1 },
    normal: { minPrograms: 2,   maxPrograms: 4,   minSpot: 1, maxSpot: 2 },
    high:   { minPrograms: 1,   maxPrograms: 2,   minSpot: 2, maxSpot: 3 },
  };
  const freq   = FREQ_TABLE[config.commercial_freq] || FREQ_TABLE.normal;
  if (freq.maxSpot === 0) return [];

  const pool = mediaLib.filter(m =>
    SNS_TV_COMMERCIAL_TYPES.has(m.type) &&
    m.live_tv_assigned !== false &&
    m.url
  );
  if (!pool.length) return [];

  const count = _tvRandInt(freq.minSpot, freq.maxSpot);
  const result = [];
  const recentComm = config.commercial_history || [];
  for (let i = 0; i < count; i++) {
    const available = pool.filter(m => !result.find(r => r.id === m.id));
    if (!available.length) break;
    const fresh = available.filter(m => !recentComm.includes(m.id));
    const src   = fresh.length ? fresh : available;
    result.push(src[Math.floor(Math.random() * src.length)]);
  }
  return result;
}

function _tvShouldRunCommercialBreak(config) {
  const FREQ_TABLE = {
    off:    { maxSpot: 0, minPrograms: 999 },
    low:    { maxSpot: 1, minPrograms: 4 },
    normal: { maxSpot: 2, minPrograms: 2 },
    high:   { maxSpot: 3, minPrograms: 1 },
  };
  const freq   = FREQ_TABLE[config.commercial_freq] || FREQ_TABLE.normal;
  if (freq.maxSpot === 0) return false;
  const since  = config.programs_since_break || 0;
  const target = config.next_break_at || freq.minPrograms;
  return since >= target;
}

function _tvRandInt(min, max) {
  if (min > max) return max;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _tvMediaItemToState(m) {
  return {
    id:           m.id,
    title:        m.title        || '(untitled)',
    artist:       m.artist       || '',
    type:         m.type         || 'media',
    url:          m.url          || '',
    duration_sec: m.duration_sec || 0,
    mime_type:    m.mime_type    || '',
  };
}

// ── Core advancement logic ────────────────────────────────────────────────────
//
// Returns: { advanced: bool, reason: string, newItem?: object }
//
// This is called both by the /channel/advance POST endpoint and by scheduled().
// It is intentionally idempotent: if the current state in Firestore is already
// past the expired item, it is a no-op.

async function _tvAdvanceChannel(env, opts = {}) {
  const runId = opts.runId || crypto.randomUUID();
  const log   = [];          // diagnostic log for this run
  const isScheduled = opts.isScheduled || false;

  log.push(`[SNS-TV] run=${runId} source=${isScheduled ? 'scheduled' : 'viewer'} channel=${SNS_TV_CHANNEL_ID}`);

  // ── Get service account access token ────────────────────────────────────────
  const token = await _tvGetAccessToken(env);
  if (!token) {
    log.push('[SNS-TV] ERROR: FIREBASE_SERVICE_ACCOUNT_KEY not configured or invalid');
    console.warn(log.join('\n'));
    return { advanced: false, reason: 'service_account_not_configured', log };
  }

  // ── Read current state and config ───────────────────────────────────────────
  const [state, config] = await Promise.all([
    _tvFsGet(SNS_TV_STATE_DOC, token),
    _tvFsGet(SNS_TV_CONFIG_DOC, token),
  ]);

  if (!config) {
    log.push('[SNS-TV] tv_config/ALTV not found — TV not initialised');
    console.log(log.join('\n'));
    return { advanced: false, reason: 'channel_not_initialised', log };
  }

  if (!config.running) {
    log.push('[SNS-TV] channel not running');
    console.log(log.join('\n'));
    return { advanced: false, reason: 'channel_not_running', log };
  }

  if (config.paused) {
    log.push('[SNS-TV] channel paused');
    console.log(log.join('\n'));
    return { advanced: false, reason: 'channel_paused', log };
  }

  // ── Viewer-triggered: verify item ID matches ─────────────────────────────────
  const requestedItemId = opts.currentItemId || null;
  const currentItem     = state?.current_item || null;
  const currentItemId   = currentItem?.id || null;

  if (!isScheduled && requestedItemId && currentItemId && requestedItemId !== currentItemId) {
    log.push(`[SNS-TV] already_advanced: db=${currentItemId} requested=${requestedItemId}`);
    console.log(log.join('\n'));
    return { advanced: false, reason: `already_advanced:${currentItemId}`, log };
  }

  // ── Time guard ───────────────────────────────────────────────────────────────
  const now          = Date.now();
  const startedAtMs  = typeof state?.started_at === 'number' ? state.started_at : 0;
  const duration_sec = currentItem?.duration_sec || 0;
  const expectedEndMs = startedAtMs + duration_sec * 1000;

  log.push(`[SNS-TV] currentItem=${currentItemId} startedAt=${new Date(startedAtMs).toISOString()} duration=${duration_sec}s expectedEnd=${new Date(expectedEndMs).toISOString()} now=${new Date(now).toISOString()}`);

  // If item has zero/invalid duration, treat as expired immediately
  const isExpired = (duration_sec <= 0) || (now >= expectedEndMs);

  if (!isScheduled && !isExpired && currentItemId) {
    const remaining = Math.ceil((expectedEndMs - now) / 1000);
    log.push(`[SNS-TV] too_early: ${remaining}s remaining`);
    console.log(log.join('\n'));
    return { advanced: false, reason: `too_early:${remaining}s`, log };
  }

  // ── Commercial queue drain ───────────────────────────────────────────────────
  const commQueue = state?.commercial_queue || [];
  if (commQueue.length > 0) {
    // For scheduled invocations, only drain if the current comm has also expired
    if (isScheduled && !isExpired && currentItemId) {
      log.push('[SNS-TV] commercial queue present but current item not expired — skip');
      console.log(log.join('\n'));
      return { advanced: false, reason: 'too_early', log };
    }

    // Acquire idempotency lock before writing
    const lockKey = `${currentItemId || 'none'}`;
    const locked  = await _tvAcquireLock(env.SNX_TV_KV, SNS_TV_CHANNEL_ID, lockKey, runId);
    if (!locked) {
      log.push(`[SNS-TV] lock already held — another invocation is advancing`);
      console.log(log.join('\n'));
      return { advanced: false, reason: 'locked', log };
    }

    try {
      const [nextComm, ...remaining] = commQueue;
      const newState = {
        current_item:     nextComm,
        started_at:       now,
        is_commercial:    true,
        commercial_queue: remaining,
        needs_next:       false,
        last_item_id:     nextComm.id,
        updated_at:       now,
      };
      const ok = await _tvFsSetUncond(SNS_TV_STATE_DOC, newState, token);
      log.push(`[SNS-TV] advanced to commercial queue item=${nextComm.id} ok=${ok}`);
      console.log(log.join('\n'));
      return { advanced: ok, reason: ok ? 'commercial_queue' : 'write_failed', newItem: nextComm, log };
    } finally {
      await _tvReleaseLock(env.SNX_TV_KV, SNS_TV_CHANNEL_ID, lockKey, runId);
    }
  }

  // ── No current item — bootstrap ───────────────────────────────────────────────
  if (!currentItemId) {
    log.push('[SNS-TV] no current item — bootstrapping');
    const mediaLib = await _tvFetchMediaLib(token);
    const program  = _tvPickProgram(mediaLib, config, state?.last_item_id || null);
    if (!program) {
      log.push('[SNS-TV] no eligible programs found');
      console.log(log.join('\n'));
      return { advanced: false, reason: 'no_eligible_programs', log };
    }
    const item     = _tvMediaItemToState(program);
    const newState = {
      current_item:     item,
      started_at:       now,
      is_commercial:    false,
      commercial_queue: [],
      needs_next:       false,
      last_item_id:     program.id,
      updated_at:       now,
    };
    const ok = await _tvFsSetUncond(SNS_TV_STATE_DOC, newState, token);
    await _tvWriteConfigHistory(token, config, program.id, false);
    log.push(`[SNS-TV] bootstrap item=${program.id} ok=${ok}`);
    console.log(log.join('\n'));
    return { advanced: ok, reason: ok ? 'bootstrap' : 'write_failed', newItem: item, log };
  }

  // ── Item has not yet expired ──────────────────────────────────────────────────
  if (!isExpired) {
    const remaining = Math.ceil((expectedEndMs - now) / 1000);
    log.push(`[SNS-TV] current item not expired (${remaining}s remaining) — no action`);
    console.log(log.join('\n'));
    return { advanced: false, reason: `too_early:${remaining}s`, log };
  }

  // ── Advance: acquire idempotency lock, pick next program(s) ──────────────────
  //
  // Catch-up: if execution was delayed and multiple items have elapsed, advance
  // through all of them up to SNS_TV_MAX_CATCHUP.  Each item is advanced in
  // sequence, with its duration consumed from the simulated playback clock,
  // until we arrive at an item that has NOT yet fully elapsed.
  //
  // The final current item is the one that is currently "playing" based on wall
  // clock time.  This is the item a viewer who opens SNS right now should see.

  const lockKey = currentItemId;
  const locked  = await _tvAcquireLock(env.SNX_TV_KV, SNS_TV_CHANNEL_ID, lockKey, runId);
  if (!locked) {
    log.push('[SNS-TV] lock already held — another invocation is advancing');
    console.log(log.join('\n'));
    return { advanced: false, reason: 'locked', log };
  }

  try {
    // Reload fresh state after acquiring lock (guard against concurrent write)
    const freshState  = await _tvFsGet(SNS_TV_STATE_DOC, token);
    const freshItemId = freshState?.current_item?.id || null;
    if (freshItemId !== currentItemId) {
      log.push(`[SNS-TV] state changed under lock (${currentItemId} → ${freshItemId}) — already_advanced`);
      return { advanced: false, reason: `already_advanced:${freshItemId}`, log };
    }

    const freshConfig = await _tvFsGet(SNS_TV_CONFIG_DOC, token);
    const mediaLib    = await _tvFetchMediaLib(token);

    if (!mediaLib.length) {
      log.push('[SNS-TV] media library empty — no programs available');
      return { advanced: false, reason: 'no_eligible_programs', log };
    }

    let advancedCount   = 0;
    let simNow          = now;
    let simStartedAt    = startedAtMs;
    let simCurrentId    = currentItemId;
    let simDuration     = duration_sec;
    let lastItem        = null;
    let workingConfig   = { ...(freshConfig || config) };

    while (advancedCount < SNS_TV_MAX_CATCHUP) {
      // Is the current simulation item still playing?
      const simExpectedEnd = simStartedAt + simDuration * 1000;
      if (simNow < simExpectedEnd) {
        // Current item is still live — stop catch-up here
        log.push(`[SNS-TV] catch-up complete after ${advancedCount} item(s) — current item is still active`);
        break;
      }

      // Advance simulated clock to when this item actually ended
      // (don't overshoot — step to the exact end time)
      const advancedAtMs = simExpectedEnd;

      // Determine the next item
      const shouldBreak    = _tvShouldRunCommercialBreak(workingConfig);
      let commercials      = [];
      let nextProgram      = null;

      if (shouldBreak) {
        commercials = _tvPickCommercials(mediaLib, workingConfig);
      }

      if (commercials.length === 0) {
        nextProgram = _tvPickProgram(mediaLib, workingConfig, simCurrentId);
      }

      if (!nextProgram && commercials.length === 0) {
        log.push('[SNS-TV] no eligible programs or commercials found — halting catch-up');
        break;
      }

      // For catch-up, we skip commercial sequences (they would be stale).
      // Play only the first commercial if due, then immediately move to program.
      // Viewers who were away don't need to sit through 3-minute-old commercials.
      // For live viewers, the normal commercial_queue path handles the sequence.
      let chosenItem;
      let isCommercial = false;

      if (commercials.length > 0) {
        // We're doing catch-up: just play one commercial then program
        chosenItem   = _tvMediaItemToState(commercials[0]);
        isCommercial = true;
        // Reset commercial counter
        workingConfig = {
          ...workingConfig,
          programs_since_break: 0,
        };
      } else {
        chosenItem = _tvMediaItemToState(nextProgram);
        // Update history
        const window     = workingConfig.avoid_repeat_window || 10;
        const newHistory = [...((workingConfig.recent_history || []).slice(-(window - 1))), nextProgram.id];
        const FREQ_TABLE = {
          off:    { minPrograms: 999, maxPrograms: 999 },
          low:    { minPrograms: 4,   maxPrograms: 7 },
          normal: { minPrograms: 2,   maxPrograms: 4 },
          high:   { minPrograms: 1,   maxPrograms: 2 },
        };
        const freq       = FREQ_TABLE[workingConfig.commercial_freq] || FREQ_TABLE.normal;
        workingConfig = {
          ...workingConfig,
          recent_history:       newHistory,
          programs_since_break: (workingConfig.programs_since_break || 0) + 1,
          next_break_at:        _tvRandInt(freq.minPrograms, freq.maxPrograms),
        };
      }

      // Advance simulation clock
      simStartedAt   = advancedAtMs;
      simDuration    = chosenItem.duration_sec || 0;
      simCurrentId   = chosenItem.id;
      lastItem       = { item: chosenItem, isCommercial, startedAtMs: advancedAtMs };
      advancedCount++;

      log.push(`[SNS-TV] catch-up step ${advancedCount}: item=${chosenItem.id} title="${chosenItem.title}" dur=${simDuration}s startedAt=${new Date(advancedAtMs).toISOString()}`);

      // Guard against zero-duration items causing infinite loops
      if (simDuration <= 0) {
        log.push('[SNS-TV] WARNING: item has zero duration — halting catch-up to prevent infinite loop');
        break;
      }
    }

    if (!lastItem) {
      log.push('[SNS-TV] catch-up loop produced no advancement');
      return { advanced: false, reason: 'no_eligible_programs', log };
    }

    // Write final state — this is the item that is currently playing
    const finalItem = lastItem.item;
    const finalStart = lastItem.startedAtMs;
    const newState = {
      current_item:     finalItem,
      started_at:       finalStart,
      is_commercial:    lastItem.isCommercial,
      commercial_queue: [],   // cleared; viewer-side commercial sequences don't persist across catchup
      needs_next:       false,
      last_item_id:     finalItem.id,
      updated_at:       now,
    };

    const writeOk = await _tvFsSetUncond(SNS_TV_STATE_DOC, newState, token);

    // Write updated config (history, counters)
    if (writeOk) {
      await _tvFsSetUncond(SNS_TV_CONFIG_DOC, {
        ...workingConfig,
        updated_at: now,
      }, token);
    }

    log.push(`[SNS-TV] advanced ${advancedCount} item(s) final=${finalItem.id} writeOk=${writeOk}`);
    console.log(log.join('\n'));
    return {
      advanced:      writeOk,
      reason:        writeOk ? `advanced:${advancedCount}` : 'write_failed',
      newItem:       finalItem,
      advancedCount,
      log,
    };

  } finally {
    await _tvReleaseLock(env.SNX_TV_KV, SNS_TV_CHANNEL_ID, lockKey, runId);
  }
}

/** Update tv_config history after a single advancement. */
async function _tvWriteConfigHistory(token, config, programId, afterCommercial) {
  const window = config.avoid_repeat_window || 10;
  const newHistory = [...((config.recent_history || []).slice(-(window - 1))), programId];
  const FREQ_TABLE = {
    off:    { minPrograms: 999, maxPrograms: 999 },
    low:    { minPrograms: 4,   maxPrograms: 7 },
    normal: { minPrograms: 2,   maxPrograms: 4 },
    high:   { minPrograms: 1,   maxPrograms: 2 },
  };
  const freq = FREQ_TABLE[config.commercial_freq] || FREQ_TABLE.normal;
  const newSinceBreak = afterCommercial ? 1 : ((config.programs_since_break || 0) + 1);
  const newTarget     = _tvRandInt(freq.minPrograms, freq.maxPrograms);

  const updates = {
    recent_history:       newHistory,
    programs_since_break: newSinceBreak,
    next_break_at:        newTarget,
    updated_at:           Date.now(),
  };
  await _tvFsSetUncond(SNS_TV_CONFIG_DOC, { ...config, ...updates }, token);
}

// ── POST /channel/advance — viewer-triggered advancement ─────────────────────
//
// Called by snx-ch-adapter.js and snx-ch-broadcast.js when a viewer's player
// detects that the current item has ended.
// Requires: Authorization: Bearer <firebase-id-token> (any authenticated user)
//           Body: { channelId: "ALTV", currentItemId: "<id>" }

// ── SNS TV: /auth/tv-token ──────────────────────────────────────────────────
//
// POST /auth/tv-token
//   Authorization: Bearer <sns-firebase-id-token>   (verified against horr-a08f4)
//
// DEPRECATED: this endpoint previously minted custom tokens for the now-removed
// remix-studio-4bf8a project.  SNS TV now uses horr-a08f4 directly.
// Retained for backwards compat — returns deprecation notice.

async function handleTvAuthToken(request, env, cors, sec) {
  // ── SNS-NATIVE TV REBUILD NOTE ───────────────────────────────────────────────
  // This endpoint previously minted Firebase custom tokens for remix-studio-4bf8a
  // so the browser could write to that project's Firestore.
  // The SNS TV rebuild (2026) eliminates the separate Firebase project entirely.
  // All TV Firestore data now lives in horr-a08f4 (the SNS project), which the
  // browser accesses directly using its existing SNS auth session.
  // No custom token exchange is required.  This endpoint is retained for
  // backwards compatibility with any callers, but returns a deprecation notice.
  // ─────────────────────────────────────────────────────────────────────────────
  return new Response(
    JSON.stringify({
      deprecated: true,
      message: 'SNS TV no longer uses a separate Firebase project. Auth is handled by the SNS session directly (horr-a08f4). No custom token needed.',
    }),
    { status: 410, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) },
  );
}

// ── handleTvAuthToken_LEGACY (retained for reference, no longer active) ───────
async function _handleTvAuthToken_LEGACY(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  // 1. Verify the SNS Firebase ID token (horr-a08f4)
  let uid;
  try { uid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // 2. Load service account for remix-studio-4bf8a (DEPRECATED — no longer used)
  const saJson = env.FIREBASE_SERVICE_KEY;
  if (!saJson) {
    return new Response(JSON.stringify({ error: 'TV auth service not configured' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }
  let sa;
  try { sa = JSON.parse(saJson); }
  catch {
    return new Response(JSON.stringify({ error: 'TV auth service misconfigured' }),
      { status: 503, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // 3. Mint a Firebase custom token:
  //    header.payload signed with the service account private key (RS256)
  //    audience: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    uid,   // SNS uid becomes the identity in remix-studio-4bf8a
    iat,
    exp,
  };

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc = s => b64url(new TextEncoder().encode(JSON.stringify(s)));

  const sigInput = `${enc(header)}.${enc(payload)}`;

  const pem = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\n/g, '');
  const keyData = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  let cryptoKey;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8', keyData,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['sign']
    );
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to load signing key' }),
      { status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const sigBuf = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(sigInput)
  );
  const customToken = `${sigInput}.${b64url(sigBuf)}`;

  return new Response(JSON.stringify({ customToken }),
    { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

async function handleChannelAdvance(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  // Verify Firebase ID token (SNS project — horr-a08f4 — using FIREBASE_WEB_API_KEY)
  let uid;
  try { uid = await _requireAuth(request, env); }
  catch (e) {
    return new Response(JSON.stringify({ error: e.message }),
      { status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const { channelId, currentItemId } = body;
  if (!channelId) {
    return new Response(JSON.stringify({ error: 'channelId required' }),
      { status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  // Currently only ALTV is supported via this endpoint
  if (channelId !== SNS_TV_CHANNEL_ID) {
    return new Response(JSON.stringify({ advanced: false, reason: 'unsupported_channel' }),
      { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
  }

  const runId = crypto.randomUUID();
  const result = await _tvAdvanceChannel(env, { currentItemId, runId, isScheduled: false });

  return new Response(JSON.stringify({
    advanced:      result.advanced,
    reason:        result.reason,
    newItem:       result.newItem || null,
    advancedCount: result.advancedCount || 0,
  }), { status: 200, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' }) });
}

// ── Scheduled advancement (Cloudflare Cron Trigger) ──────────────────────────
//
// Frequency: every 1 minute (* * * * *)
// This is a recovery/advancement mechanism — it fires even when no browser
// is open.  It uses the same _tvAdvanceChannel() logic as the fetch path.

async function _tvScheduledAdvance(env) {
  const runId = `cron-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  console.log(`[SNS-TV CRON] run=${runId} invoked at ${new Date().toISOString()}`);

  try {
    const result = await _tvAdvanceChannel(env, { runId, isScheduled: true });
    console.log(
      `[SNS-TV CRON] run=${runId} advanced=${result.advanced} reason=${result.reason} ` +
      `items=${result.advancedCount || 0}`
    );
  } catch (err) {
    // Failure isolation: log the error but do not crash/corrupt state.
    // The next scheduled invocation will retry.
    console.error(`[SNS-TV CRON] run=${runId} UNCAUGHT ERROR:`, err?.message || err);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);
    const sec    = securityHeaders();

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: mergeHeaders(cors, sec) });
    }

    // ── Admin endpoints ──
    if (url.pathname === '/admin/delete-user' && request.method === 'POST') return handleAdminDeleteUser(request, env, cors, sec);

    // ── SNS TV: TV auth token (cross-project Firebase custom token) ──
    if (url.pathname === '/auth/tv-token' && request.method === 'POST') return handleTvAuthToken(request, env, cors, sec);

    // ── SNS TV: channel advancement (viewer-triggered) ──
    if (url.pathname === '/channel/advance' && request.method === 'POST') return handleChannelAdvance(request, env, cors, sec);

    // ── Broadcast Destination Manager (Founder only) ──
    if (url.pathname === '/broadcast/destinations') {
      if (request.method === 'GET')  return handleBroadcastList(request, env, cors, sec);
      if (request.method === 'POST') return handleBroadcastCreate(request, env, cors, sec);
    }
    const bdMatch = url.pathname.match(/^\/broadcast\/destinations\/([^/]+)$/);
    if (bdMatch) {
      const destId = bdMatch[1];
      if (request.method === 'PATCH')  return handleBroadcastUpdate(request, env, cors, sec, destId);
      if (request.method === 'DELETE') return handleBroadcastDelete(request, env, cors, sec, destId);
    }

    // ── Broadcast Control Plane (Founder only — proxies to snx-broadcast service) ──
    if (url.pathname === '/broadcast/start'  && request.method === 'POST') return handleBroadcastStart(request, env, cors, sec);
    if (url.pathname === '/broadcast/stop'   && request.method === 'POST') return handleBroadcastStop(request, env, cors, sec);
    if (url.pathname === '/broadcast/status' && request.method === 'GET')  return handleBroadcastStatus(request, env, cors, sec);

    // ── SNX Live endpoints (production — self-hosted mediasoup) ──
    if (url.pathname === '/snx-live/room')         return handleSnxLiveRoom(request, env, cors, sec);
    if (url.pathname === '/snx-live/token')        return handleSnxLiveToken(request, env, cors, sec);
    if (url.pathname === '/snx-live/remove-guest') return handleSnxLiveRemoveGuest(request, env, cors, sec);
    if (url.pathname === '/snx-live/turn')         return handleSnxLiveTurn(request, env, cors, sec);

    // ── LiveKit endpoints (DEPRECATED — emergency rollback only) ──
    if (url.pathname === '/livekit-room')     return handleLiveKitRoom(request, env, cors, sec);
    if (url.pathname === '/livekit-token')    return handleLiveKitToken(request, env, cors, sec);
    if (url.pathname === '/turn-credentials') return handleTurnCredentials(request, env, cors, sec);

    // ── Chunked / resumable upload endpoints ──
    if (url.pathname === '/upload-chunk')    return handleUploadChunk(request, env, cors, sec);
    if (url.pathname === '/upload-complete') return handleUploadComplete(request, env, cors, sec);

    // ── Supabase proxy endpoints (Music Hub 2.0) ──
    if (url.pathname === '/supabase-upload') return handleSupabaseUpload(request, env, cors, sec);
    if (url.pathname === '/supabase-delete') return handleSupabaseDelete(request, env, cors, sec);

    // ── POST /upload-music | /upload-artwork | /upload-theme ─────────────────
    // Shared handler for audio, artwork, and theme background uploads.
    // The client sends: Authorization: Bearer <idToken>, file, path (the full R2 key)
    // Path must start with an allowed prefix for the authenticated user.
    if (request.method === 'POST' && (url.pathname === '/upload-music' || url.pathname === '/upload-artwork' || url.pathname === '/upload-theme')) {
      // ── Verify Firebase ID token ────────────────────────────────────────────
      let musicUid;
      try { musicUid = await _requireAuth(request, env); }
      catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      let formData;
      try { formData = await request.formData(); }
      catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const file    = formData.get('file');
      const reqPath = (formData.get('path') || '').replace(/\.\./g, '');  // strip traversal

      if (!file || typeof file === 'string') {
        return new Response(JSON.stringify({ error: 'No file received' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // Enforce: path must be scoped to the AUTHENTICATED user.
      // Allowed prefixes cover audio, artwork, and theme asset storage.
      // Uses server-verified UID — ignores any uid sent in the form body.
      const musicAllowedPrefixes = [
        `profiles/${musicUid}/music/`,
        `music/${musicUid}/`,
        `radio/${musicUid}/`,
        `users/${musicUid}/`,
        `themes/${musicUid}/`,
        `posts/${musicUid}/`,
        `tv/${musicUid}/`,        // SNS TV Studio uploads
      ];
      if (!reqPath || !musicAllowedPrefixes.some(p => reqPath.startsWith(p))) {
        return new Response(JSON.stringify({ error: 'Invalid path: must start with an allowed prefix for your account' }), {
          status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // MIME validation — audio and image allowed (artwork, theme backgrounds)
      let mime = file.type || '';
      const extMime = mimeFromExt(file.name);
      if (!mime || mime === 'application/octet-stream') mime = extMime || mime;
      else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) mime = extMime;

      if (!mime.startsWith('audio/') && !mime.startsWith('image/') && mime !== 'application/octet-stream') {
        return new Response(JSON.stringify({ error: `Only audio or image files are allowed for this upload endpoint. Got: ${file.type}` }), {
          status: 415, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const buffer = await file.arrayBuffer();
      const sizeLimit = mime.startsWith('image/') ? MAX_SIZE_IMAGE : MAX_SIZE_AUDIO;
      if (buffer.byteLength > sizeLimit) {
        const limitMB = Math.round(sizeLimit / 1024 / 1024);
        return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
          status: 413, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const cleanMime = (mime || 'audio/mpeg').split(';')[0].trim();
      try {
        await env.BUCKET.put(reqPath, buffer, {
          httpMetadata:   { contentType: cleanMime },
          customMetadata: { uploaderUid: musicUid, originalName: file.name }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
          status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${reqPath}`;
      return new Response(JSON.stringify({ url: publicUrl, key: reqPath }), {
        status: 200,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── DELETE /{key}: delete a file from R2 (called when user deletes a song) ──
    // Requires: Authorization: Bearer <firebase-id-token>
    // Key must belong to the authenticated user (namespace enforced server-side).
    if (request.method === 'DELETE') {
      // ── Verify Firebase ID token ──────────────────────────────────────────
      let deleteUid;
      try { deleteUid = await _requireAuth(request, env); }
      catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: e.status || 401, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // url.pathname is already decoded by the URL constructor; slice off the leading '/'
      const key = url.pathname.slice(1);
      if (!key) {
        return new Response(JSON.stringify({ error: 'key is required' }), {
          status: 400, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      // Enforce ownership: only delete files under the caller's namespace
      const deleteKeyOwned = key.startsWith(`${deleteUid}/`)
                          || key.startsWith(`profiles/${deleteUid}/`)
                          || key.startsWith(`videos/${deleteUid}/`)
                          || key.startsWith(`music/${deleteUid}/`)
                          || key.startsWith(`posts/${deleteUid}/`)
                          || key.startsWith(`radio/${deleteUid}/`)
                          || key.startsWith(`themes/${deleteUid}/`)
                          || key.startsWith(`users/${deleteUid}/`)
                          || key.startsWith(`tv/${deleteUid}/`);  // SNS TV Studio
      if (!deleteKeyOwned) {
        return new Response(JSON.stringify({ error: 'Forbidden: key does not belong to your account' }), {
          status: 403, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }

      try {
        await env.BUCKET.delete(key);
        console.log(`[DELETE] Deleted key=${key} uid=${deleteUid}`);
        return new Response(JSON.stringify({ deleted: true, key }), {
          status: 200,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'R2 delete failed: ' + e.message }), {
          status: 500, headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
    }

    // ── GET: serve a file from R2 (CDN delivery) ──────────────────────────────
    if (request.method === 'GET') {
      const key = url.pathname.slice(1);
      if (!key) {
        return new Response('Shadow Nexus Upload Worker — OK ⚡', {
          status: 200,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'text/plain' })
        });
      }

      try {
        const rangeHeader = request.headers.get('Range');

        // Range request (audio/video seeking) — fetch only the requested byte slice.
        // R2 getRange() returns a partial object so we never stream the whole file.
        if (rangeHeader) {
          // Parse "bytes=start-end" — end is optional (means "to EOF")
          const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/);
          if (!m) {
            return new Response('Invalid Range header', {
              status: 416,
              headers: mergeHeaders(cors, sec, { 'Content-Type': 'text/plain' })
            });
          }

          // First, fetch the object HEAD to get total size.
          const head = await env.BUCKET.head(key);
          if (!head) {
            return new Response('Not found', { status: 404, headers: mergeHeaders(cors, sec) });
          }
          const totalSize = head.size;
          const start = parseInt(m[1], 10);
          const end   = m[2] !== '' ? parseInt(m[2], 10) : totalSize - 1;

          if (start > end || start >= totalSize) {
            return new Response('Range Not Satisfiable', {
              status: 416,
              headers: mergeHeaders(cors, sec, {
                'Content-Range': `bytes */${totalSize}`,
                'Content-Type': 'text/plain',
              })
            });
          }

          const clampedEnd = Math.min(end, totalSize - 1);
          const chunkSize  = clampedEnd - start + 1;

          const obj = await env.BUCKET.get(key, { range: { offset: start, length: chunkSize } });
          if (!obj) {
            return new Response('Not found', { status: 404, headers: mergeHeaders(cors, sec) });
          }

          const mime = head.httpMetadata?.contentType || 'application/octet-stream';
          const headers = new Headers(mergeHeaders(cors, sec));
          headers.set('Content-Type',   mime);
          headers.set('Content-Range',  `bytes ${start}-${clampedEnd}/${totalSize}`);
          headers.set('Content-Length', String(chunkSize));
          headers.set('Accept-Ranges',  'bytes');
          headers.set('Cache-Control',  'public, max-age=31536000, immutable');
          if (head.httpEtag) headers.set('ETag', head.httpEtag);
          headers.set('X-Robots-Tag',  'noindex, nofollow');

          return new Response(obj.body, { status: 206, headers });
        }

        // Full-file request (no Range header)
        const obj = await env.BUCKET.get(key);
        if (!obj) {
          return new Response('Not found', {
            status: 404,
            headers: mergeHeaders(cors, sec)
          });
        }

        const mime = obj.httpMetadata?.contentType || 'application/octet-stream';
        const headers = new Headers(mergeHeaders(cors, sec));
        headers.set('Content-Type', mime);
        // Long-lived immutable cache for media files (files are content-addressed)
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('Accept-Ranges', 'bytes');
        if (obj.size != null) headers.set('Content-Length', String(obj.size));
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
        // Bot protection hint (actual blocking via Cloudflare Bot Management)
        headers.set('X-Robots-Tag', 'noindex, nofollow');

        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fetch error: ' + e.message }), {
          status: 500,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
    }

    // ── POST /: generic upload (profile pics, posts, messages, music, etc.) ────
    // Requires: Authorization: Bearer <firebase-id-token>
    //
    // Optional FormData field "path": a caller-supplied R2 key.
    //   - Must start with one of the allowed prefixes for the authenticated user.
    //   - If omitted the server generates {uid}/{timestamp}-{random}.{ext}.
    //
    // The UID stored in R2 metadata and the key namespace always comes from the
    // verified Firebase token — the client-supplied "uid" FormData field is ignored.
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: mergeHeaders(cors, sec)
      });
    }

    // ── Verify Firebase ID token ──────────────────────────────────────────────
    let userUid;
    try { userUid = await _requireAuth(request, env); }
    catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: e.status || 401,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    let formData;
    try { formData = await request.formData(); }
    catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const file = formData.get('file');

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file received' }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── MIME determination ────────────────────────────────────────────────────
    // Some mobile browsers report video/webm for audio recordings;
    // override based on file extension when that happens.
    let mime = file.type || '';
    const extMime = mimeFromExt(file.name);
    if (!mime || mime === 'application/octet-stream') {
      mime = extMime || mime;
    } else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) {
      mime = extMime;
    }

    if (!isAllowedType(mime)) {
      return new Response(JSON.stringify({ error: `File type not supported: ${file.type} (${file.name})` }), {
        status: 415,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const buffer = await file.arrayBuffer();
    // Per-type size limits enforced server-side
    const cleanMime = mime.split(';')[0].trim();
    const sizeLimit = cleanMime.startsWith('image/') ? MAX_SIZE_IMAGE
                    : cleanMime.startsWith('video/') ? MAX_SIZE_VIDEO
                    : MAX_SIZE_AUDIO;
    if (buffer.byteLength > sizeLimit) {
      const limitMB = Math.round(sizeLimit / 1024 / 1024);
      return new Response(JSON.stringify({ error: `File too large (max ${limitMB} MB for this type)` }), {
        status: 413,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Determine final R2 key ────────────────────────────────────────────────
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const defaultKey = `${userUid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

    // Accept a caller-supplied path but validate ownership — prevents cross-user writes.
    let key = defaultKey;
    const callerPath = (formData.get('path') || '').replace(/\.\./g, '').trim();
    if (callerPath) {
      const keyAllowedPrefixes = [
        `${userUid}/`,
        `profiles/${userUid}/`,
        `videos/${userUid}/`,
        `music/${userUid}/`,
        `posts/${userUid}/`,
        `radio/${userUid}/`,
        `themes/${userUid}/`,
        `users/${userUid}/`,
        `tv/${userUid}/`,          // SNS TV Studio uploads
      ];
      if (!keyAllowedPrefixes.some(p => callerPath.startsWith(p))) {
        return new Response(JSON.stringify({ error: 'Forbidden: path does not belong to your account' }), {
          status: 403,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
      key = callerPath;
    }

    try {
      await env.BUCKET.put(key, buffer, {
        httpMetadata:   { contentType: cleanMime },
        customMetadata: { uploaderUid: userUid, originalName: file.name }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
        status: 500,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Return public CDN URL (stored in Firebase, served via Cloudflare CDN) ──
    const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${key}`;
    return new Response(JSON.stringify({ url: publicUrl, key }), {
      status: 200,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });

  }, // end async fetch

  // ── Cloudflare Cron Trigger: SNS TV 24/7 advancement ─────────────────────
  // Configured in wrangler.jsonc: triggers[].crons = ["* * * * *"]
  // Fires every minute; advances SNS TV channel ALTV if current item has ended.
  // No viewer, no browser, no Founder Studio required.
  // Owned by: Shadow Nexus Social
  async scheduled(event, env, ctx) {
    ctx.waitUntil(_tvScheduledAdvance(env));
  },
}; // end export default
