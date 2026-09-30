/**
 * cloudflare/snx-broadcast-worker/broadcast-worker.js
 *
 * Stage 4D — Shadow Nexus Broadcast Worker (entry point).
 *
 * Replaces the old VPS/Tunnel control path.
 *
 * OLD VPS MODEL:
 *   Worker → Cloudflare Tunnel → VPS localhost:3100
 *
 * NEW CLOUDFLARE MODEL:
 *   Worker → Cloudflare Container binding → snx-broadcast
 *
 * Routing:
 *   GET  /broadcast/health           → container (public, no auth)
 *   GET  /broadcast/status           → container (Founder auth required)
 *   POST /broadcast/start            → container (Founder auth required)
 *   POST /broadcast/stop             → container (Founder auth required)
 *   POST /broadcast/destinations/refresh → container (Founder auth required)
 *   *                                → 404
 *
 * Auth:
 *   The Worker forwards the Authorization: Bearer <token> header to the container.
 *   The container (snx-broadcast/src/auth.js) performs the actual token verification.
 *   This avoids duplicating auth logic and keeps SNX_TOKEN_SECRET on the container side.
 *
 *   The Worker adds a pre-flight CORS check and returns appropriate errors for
 *   completely malformed or obviously unauthorised requests before the container
 *   is even started.
 *
 * Security:
 *   - The container port (3100) is never exposed publicly.
 *   - All traffic is routed through this Worker.
 *   - Responses from the container are passed through unchanged.
 *   - The Worker never logs auth tokens or Firebase credentials.
 */

import { getContainer } from '@cloudflare/containers';
export { BroadcastContainer } from './broadcast-container.js';

// ── CORS allowed origins ─────────────────────────────────────────────────────

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
];

// ── Allowed broadcast control paths ─────────────────────────────────────────

const BROADCAST_PATHS = new Set([
  '/broadcast/health',
  '/broadcast/status',
  '/broadcast/start',
  '/broadcast/stop',
  '/broadcast/destinations/refresh',
]);

// ── Worker fetch handler ─────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const origin = request.headers.get('Origin') || '';

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return _corsResponse(origin, 204, null, {});
    }

    // ── Route validation ────────────────────────────────────────────────────
    if (!BROADCAST_PATHS.has(path)) {
      return _json(404, { ok: false, error: 'Not found' }, origin);
    }

    // ── Minimal request validation ──────────────────────────────────────────
    // The container enforces full auth; we only block obviously wrong requests.
    if (path !== '/broadcast/health') {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) {
        return _json(401, { ok: false, error: 'Authorization required' }, origin);
      }
    }

    // ── Route to container ───────────────────────────────────────────────────
    // We use a stable singleton ID ('snx-broadcast') so there is always one
    // broadcast container for the entire system.
    try {
      const container = getContainer(env.BROADCAST_CONTAINER, 'snx-broadcast');
      const containerResp = await container.fetch(request);

      // Copy the response, adding CORS headers
      const body    = await containerResp.arrayBuffer();
      const headers = new Headers(containerResp.headers);
      _applyCorsHeaders(headers, origin);
      return new Response(body, {
        status:  containerResp.status,
        headers,
      });
    } catch (err) {
      console.error('[BROADCAST-WORKER] Container error:', err.message);
      return _json(503, { ok: false, error: 'Broadcast service unavailable' }, origin);
    }
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function _json(status, body, origin) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  _applyCorsHeaders(headers, origin);
  return new Response(JSON.stringify(body), { status, headers });
}

function _corsResponse(origin, status, body, extraHeaders) {
  const headers = new Headers(extraHeaders);
  _applyCorsHeaders(headers, origin);
  return new Response(body, { status, headers });
}

function _applyCorsHeaders(headers, origin) {
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (ALLOWED_ORIGINS.includes(origin) || isLocal) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    headers.set('Access-Control-Max-Age', '86400');
    headers.set('Vary', 'Origin');
  }
}
