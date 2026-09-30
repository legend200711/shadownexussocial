/**
 * snx-broadcast/src/destinations/store.js
 *
 * Secure server-side stream key store.
 *
 * Reads RTMP destination credentials from Firestore /broadcastDestinations
 * using the Firebase Admin SDK.  Stream keys are:
 *   - NEVER logged in full
 *   - NEVER returned to the browser
 *   - NEVER stored in process memory longer than needed for the current FFmpeg spawn
 *   - Accessed only by the server-side encoder process
 *
 * The Firestore collection is guarded by isFounderEmail() rules AND the
 * Firebase Admin SDK bypasses client security rules — so this is doubly
 * protected.
 */

'use strict';

const config = require('../config');

// ── Cache ─────────────────────────────────────────────────────────────────────
// Destinations are cached for CACHE_TTL_MS to avoid hammering Firestore.
// The cache is refreshed on each startBroadcast() call.

const CACHE_TTL_MS = 30_000;
let _cache     = null;   // { destinations: [...], fetchedAt: number }
let _db        = null;   // Firestore instance (set by init)

/**
 * Initialise the store with a Firestore instance.
 * @param {FirebaseFirestore.Firestore} db
 */
function init(db) {
  _db = db;
  console.log('[DEST-STORE] Initialized — Firestore destination store ready');
}

/**
 * Fetch all enabled destinations from Firestore.
 * Returns full objects including streamKey (server-side only).
 *
 * @param {boolean} [forceRefresh=false]  bypass cache
 * @returns {Promise<Array<{id, name, serverUrl, streamKey, enabled}>>}
 */
async function getEnabledDestinations(forceRefresh = false) {
  if (!_db) throw new Error('Destination store not initialized — call init(db) first');

  const now = Date.now();
  if (!forceRefresh && _cache && (now - _cache.fetchedAt) < CACHE_TTL_MS) {
    return _cache.destinations;
  }

  const snap = await _db.collection(config.firestore.colDestinations).get();

  const destinations = [];
  snap.docs.forEach(doc => {
    const d = doc.data();
    if (!d.enabled) return;
    if (!d.serverUrl || !d.streamKey) {
      console.warn('[DEST-STORE] Destination', doc.id, 'missing serverUrl or streamKey — skipped');
      return;
    }
    destinations.push({
      id:        doc.id,
      name:      d.name      || doc.id,
      serverUrl: d.serverUrl,
      streamKey: d.streamKey,   // only held here — never forwarded to browser
      enabled:   true,
    });
  });

  _cache = { destinations, fetchedAt: now };

  // Log only count + names — never keys or URLs
  console.log('[DEST-STORE] Loaded', destinations.length, 'enabled destinations:',
    destinations.map(d => d.name).join(', ') || '(none)');

  return destinations;
}

/**
 * Invalidate the cache (call after a destination is added/updated/deleted).
 */
function invalidateCache() {
  _cache = null;
}

/**
 * Build the full RTMP push URL from a destination object.
 * Format: <serverUrl>/<streamKey>
 * (Some platforms use server/key as separate args to FFmpeg — this
 *  combines them for single-URL use.)
 *
 * NEVER log the return value of this function in full.
 */
function buildRtmpUrl(dest) {
  const url = dest.serverUrl.replace(/\/+$/, '') + '/' + dest.streamKey;
  return url;
}

module.exports = { init, getEnabledDestinations, invalidateCache, buildRtmpUrl };
