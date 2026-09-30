/**
 * Shadow Nexus Live — server-side token verification.
 *
 * Short-lived SNX session tokens are signed by the Cloudflare Worker using
 * HMAC-SHA256 with a shared secret (SNX_TOKEN_SECRET).
 *
 * Token format (JSON, base64url-encoded, dot-separated payload.signature):
 *   payload: { uid, roomId, role, exp }
 *   signature: HMAC-SHA256(base64url(payload), SNX_TOKEN_SECRET)
 *
 * The browser NEVER sees SNX_TOKEN_SECRET — only the signed token.
 */

'use strict';

const crypto = require('crypto');
const config = require('./config');

/**
 * Verify a SNX session token.
 * @param  {string} token   — token string from browser
 * @returns {{ uid, roomId, role }} on success
 * @throws  {Error}          on invalid / expired token
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') throw new Error('Token missing');

  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Token malformed');

  const [payloadB64, sigB64] = parts;

  // Re-compute expected HMAC
  const expected = crypto
    .createHmac('sha256', config.tokenSecret)
    .update(payloadB64)
    .digest('base64url');

  // Constant-time comparison to prevent timing attacks
  const bufA = Buffer.from(expected, 'utf8');
  const bufB = Buffer.from(sigB64,   'utf8');
  if (bufA.length !== bufB.length || !crypto.timingSafeEqual(bufA, bufB)) {
    throw new Error('Token signature invalid');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Token payload unreadable');
  }

  if (!payload || typeof payload !== 'object') throw new Error('Token payload invalid');
  if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) {
    throw new Error('Token expired');
  }

  const { uid, roomId, role } = payload;
  if (!uid || !roomId || !role) throw new Error('Token missing required fields');

  return { uid, roomId, role };
}

module.exports = { verifyToken };
