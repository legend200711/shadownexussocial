/**
 * snx-broadcast/src/auth.js
 *
 * Token verification for the broadcast control API.
 * Reuses the same SNX session token scheme as snx-live.
 *
 * Only accepts tokens where role === 'founder'.
 * This means the Cloudflare Worker must issue a founder token and the browser
 * sends it as "Authorization: Bearer <token>" on every control request.
 */

'use strict';

const crypto = require('crypto');
const config = require('./config');

/**
 * Verify an SNX session token and assert founder role.
 *
 * Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256 signature)
 * Payload: { uid, roomId, role, exp }
 *
 * @param  {string} token
 * @returns {{ uid, role }}
 * @throws  Error on invalid / expired / non-founder token
 */
function verifyFounderToken(token) {
  if (!token || typeof token !== 'string') throw new Error('Token missing');

  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('Token malformed');

  const [payloadB64, sigB64] = parts;

  if (!config.tokenSecret) throw new Error('SNX_TOKEN_SECRET not configured');

  const expected = crypto
    .createHmac('sha256', config.tokenSecret)
    .update(payloadB64)
    .digest('base64url');

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

  const { uid, role } = payload;
  if (!uid || !role) throw new Error('Token missing required fields');

  if (role !== 'founder') throw new Error('Founder role required');

  return { uid, role };
}

/**
 * Express middleware — requires a valid founder token.
 * Attaches req.snxAuth = { uid, role } on success.
 */
function requireFounder(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  try {
    req.snxAuth = verifyFounderToken(token);
    next();
  } catch (err) {
    res.status(401).json({ ok: false, error: err.message });
  }
}

module.exports = { verifyFounderToken, requireFounder };
