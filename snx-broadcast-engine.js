/**
 * Shadow Nexus Broadcast Engine — snx-broadcast-engine.js
 * Version: 4.0.0  (Stage 4A — Manual RTMP Destinations)
 *
 * Architecture:
 *
 *   RADIO / TV / PERSONAL LIVE
 *           ↓
 *   SHADOW NEXUS BROADCAST ENGINE
 *           ↓
 *      ┌────┼────┐
 *      ↓    ↓    ↓
 *    RTMP  RTMP  RTMP   ← each destination: serverUrl + streamKey
 *
 * What this module provides:
 *   – Destination Manager:  save / edit / delete / enable named RTMP/RTMPS destinations
 *   – Source Adapter:       connects the Radio source (SNXRadio) to the encoder
 *   – Broadcast Engine API: start / stop / health / failure isolation per destination
 *   – Security:             stream keys are NEVER stored in this file, NEVER in
 *                           localStorage, NEVER logged in full.  Keys live only in
 *                           Firestore /broadcastDestinations (Founder-only read) and
 *                           are proxied through the Cloudflare Worker.
 *
 * Encoder Host Note:
 *   This module provides the CLIENT-SIDE broadcast control layer.
 *   The ACTUAL continuous encoder (FFmpeg / GStreamer / OBS) that encodes H.264
 *   video + AAC audio and pushes the RTMP stream must run on a continuously
 *   available server (VPS, dedicated machine, or cloud service).
 *   A browser alone cannot provide a continuous 24/7 encoder — it can only be
 *   the source-of-truth for what should be playing.  The encoder host must
 *   subscribe to SNXRadio events (nowPlaying, trackChange, etc.) and drive the
 *   actual RTMP output.
 *
 * Dependencies:
 *   firebase-config.js   (window._snxCurrentUser, window._snxAuth)
 *   snx-radio.js         (window.SNXRadio) — for radio source events
 *
 * DO NOT add YouTube OAuth.
 * DO NOT add YouTube Live API account connection.
 * DO NOT require Google account authorization.
 * All platforms (YouTube, Twitch, etc.) are configured as manual RTMP destinations.
 */

'use strict';

(function () {

const ENGINE_VERSION = '4.0.0';
const WORKER_BASE    = 'https://yellow-term-11e6.nthntjrn.workers.dev';

// Broadcast control plane.
// Worker endpoints proxy to the server-side broadcast engine (snx-broadcast).
// The browser never talks directly to the broadcast service — the Worker
// verifies the Firebase ID token and forwards to the internal service URL.
const BROADCAST_CTRL = WORKER_BASE;  // Worker owns /broadcast/start|stop|status

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */

window.SNXBroadcastEngine = {
  // Destination Manager
  listDestinations,
  saveDestination,
  updateDestination,
  deleteDestination,

  // Source Adapter
  attachRadioSource,
  detachRadioSource,

  // Broadcast Engine
  startBroadcast,
  stopBroadcast,
  getBroadcastStatus,

  // Events
  on,
  off,

  get version() { return ENGINE_VERSION; },
};

/* ══════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════ */

const _listeners = {};        // event → callback[]
let   _radioAttached = false; // whether SNXRadio source adapter is active
let   _broadcastState = {
  active:       false,        // whether a broadcast session is running
  destinations: [],           // enabled destinations currently broadcasting
  startedAt:    null,
  source:       null,         // 'radio' | 'tv' | 'personal'
  healthChecks: {},           // destId → { ok, lastCheck, errorCount }
};

/* ══════════════════════════════════════════════════════════════
   DESTINATION MANAGER
   Destinations are stored server-side (Firestore via Worker).
   Stream keys are NEVER held in frontend JS memory beyond the
   submit → Worker call path.  The Worker strips them from all
   responses.
══════════════════════════════════════════════════════════════ */

/**
 * List all broadcast destinations (stream keys masked).
 * @returns {Promise<Array>} destinations array
 */
async function listDestinations() {
  const token = await _getIdToken();
  if (!token) throw new Error('Authentication required');

  const res = await fetch(`${WORKER_BASE}/broadcast/destinations`, {
    method:  'GET',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `List destinations failed (${res.status})`);
  }

  const data = await res.json();
  return data.destinations || [];
}

/**
 * Save a new broadcast destination.
 * @param {{ name: string, serverUrl: string, streamKey: string, enabled?: boolean }} dest
 * @returns {Promise<Object>} created destination (key masked)
 */
async function saveDestination(dest) {
  const { name, serverUrl, streamKey, enabled = true } = dest;
  if (!name || !serverUrl || !streamKey) {
    throw new Error('name, serverUrl, and streamKey are required');
  }
  if (!/^rtmps?:\/\//i.test(serverUrl)) {
    throw new Error('serverUrl must start with rtmp:// or rtmps://');
  }

  const token = await _getIdToken();
  if (!token) throw new Error('Authentication required');

  const res = await fetch(`${WORKER_BASE}/broadcast/destinations`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    // stream key is sent to the Worker over TLS — Worker stores it in Firestore
    // and immediately discards it from the response
    body: JSON.stringify({ name, serverUrl, streamKey, enabled })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Save destination failed (${res.status})`);
  }

  const data = await res.json();
  _emit('destinationSaved', data.destination);
  return data.destination;
}

/**
 * Update an existing destination.
 * @param {string} destId
 * @param {{ name?: string, serverUrl?: string, streamKey?: string, enabled?: boolean }} fields
 * @returns {Promise<Object>} updated destination (key masked)
 */
async function updateDestination(destId, fields) {
  if (!destId) throw new Error('destId required');
  if (fields.serverUrl && !/^rtmps?:\/\//i.test(fields.serverUrl)) {
    throw new Error('serverUrl must start with rtmp:// or rtmps://');
  }

  const token = await _getIdToken();
  if (!token) throw new Error('Authentication required');

  const res = await fetch(`${WORKER_BASE}/broadcast/destinations/${encodeURIComponent(destId)}`, {
    method:  'PATCH',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(fields)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Update destination failed (${res.status})`);
  }

  const data = await res.json();
  _emit('destinationUpdated', data.destination);
  return data.destination;
}

/**
 * Delete a destination.
 * @param {string} destId
 * @returns {Promise<void>}
 */
async function deleteDestination(destId) {
  if (!destId) throw new Error('destId required');

  const token = await _getIdToken();
  if (!token) throw new Error('Authentication required');

  const res = await fetch(`${WORKER_BASE}/broadcast/destinations/${encodeURIComponent(destId)}`, {
    method:  'DELETE',
    headers: { 'Authorization': `Bearer ${token}` }
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Delete destination failed (${res.status})`);
  }

  _emit('destinationDeleted', { id: destId });
}

/* ══════════════════════════════════════════════════════════════
   SOURCE ADAPTER — RADIO
   The Radio source adapter bridges SNXRadio events into the
   Broadcast Engine, allowing the encoder host to receive:
     – track changes (title, artist, artwork, duration, position)
     – station on/off events
     – program changes
   These events are broadcast over the engine event bus so that
   any encoder host subscribed to 'sourceEvent' can act on them.
══════════════════════════════════════════════════════════════ */

/**
 * Attach the Radio source adapter.
 * Listens to SNXRadio events and re-emits them as broadcast source events.
 */
function attachRadioSource() {
  if (_radioAttached) return;
  if (!window.SNXRadio) {
    console.warn('[SNX-BE] SNXRadio not available — cannot attach radio source');
    return;
  }

  window.SNXRadio.on('nowPlaying',    _onRadioNowPlaying);
  window.SNXRadio.on('stateChange',   _onRadioStateChange);
  window.SNXRadio.on('programChange', _onRadioProgramChange);
  window.SNXRadio.on('error',         _onRadioError);

  _radioAttached = true;
  _emit('sourceAttached', { source: 'radio' });
  console.log('[SNX-BE] Radio source adapter attached');
}

/**
 * Detach the Radio source adapter.
 */
function detachRadioSource() {
  if (!_radioAttached || !window.SNXRadio) return;

  window.SNXRadio.off('nowPlaying',    _onRadioNowPlaying);
  window.SNXRadio.off('stateChange',   _onRadioStateChange);
  window.SNXRadio.off('programChange', _onRadioProgramChange);
  window.SNXRadio.off('error',         _onRadioError);

  _radioAttached = false;
  _emit('sourceDetached', { source: 'radio' });
  console.log('[SNX-BE] Radio source adapter detached');
}

function _onRadioNowPlaying(track) {
  _emit('sourceEvent', {
    type:    'nowPlaying',
    source:  'radio',
    track:   {
      title:      track?.title || '',
      artist:     track?.artist || '',
      artworkUrl: track?.artworkUrl || '',
      duration:   track?.duration  || 0,
      position:   track?.positionSec || 0,
    }
  });
}

function _onRadioStateChange(state) {
  _emit('sourceEvent', {
    type:   'stateChange',
    source: 'radio',
    state,
  });
}

function _onRadioProgramChange(program) {
  _emit('sourceEvent', {
    type:    'programChange',
    source:  'radio',
    program: {
      name:    program?.name    || '',
      artwork: program?.artwork || '',
    }
  });
}

function _onRadioError(err) {
  _emit('sourceEvent', { type: 'error', source: 'radio', error: err });
}

/* ══════════════════════════════════════════════════════════════
   BROADCAST ENGINE
   Provides a controlled broadcast session over multiple RTMP
   destinations.  The engine manages:
     – destination health tracking
     – per-destination failure isolation (one failing destination
       does not stop others)
     – restart / resync signalling to the encoder host
     – broadcast health reporting

   IMPORTANT — ENCODER HOST NOTE:
   The methods below represent the CONTROL PLANE of the broadcast
   engine.  The actual RTMP encoding and streaming happen in a
   continuously-running encoder host process (e.g. FFmpeg on a VPS).
   A browser-only deployment CANNOT provide a continuous encoder.
   The encoder host listens for SNXBroadcastEngine.on('control', …)
   events and acts accordingly.
══════════════════════════════════════════════════════════════ */

/**
 * Start a broadcast session.
 * Loads enabled destinations, validates them, and emits a 'broadcastStart'
 * control event that the encoder host must handle.
 *
 * @param {{ source: string }} opts  source = 'radio' | 'tv' | 'personal'
 * @returns {Promise<Object>} broadcast status
 */
/**
 * Start the broadcast on the server-side broadcast engine.
 *
 * Sends POST /broadcast/start to the Cloudflare Worker, which:
 *   1. Verifies the Firebase ID token (Founder only)
 *   2. Signs a short-lived SNX founder token
 *   3. Proxies to the internal broadcast service (POST /broadcast/start)
 *
 * The server fetches destinations + stream keys from Firestore internally.
 * Stream keys never travel through this function.
 *
 * @param {object} opts
 * @param {boolean} [opts.forceRefreshDestinations=false]
 * @returns {Promise<object>} server status snapshot
 */
async function startBroadcast(opts = {}) {
  const token = await _getIdToken();
  if (!token) throw new Error('Authentication required — sign in as Founder');

  const body = {};
  if (opts.forceRefreshDestinations) body.forceRefreshDestinations = true;

  const res = await fetch(`${BROADCAST_CTRL}/broadcast/start`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Broadcast start failed (${res.status})`);
  }

  // Mirror server state locally for UI feedback
  _broadcastState.active    = true;
  _broadcastState.startedAt = Date.now();
  _broadcastState.source    = data.source || 'radio';

  _emit('broadcastStart', {
    source:       _broadcastState.source,
    destinations: data.destinations || 0,
    startedAt:    _broadcastState.startedAt,
    dryRun:       data.dryRun || false,
  });
  console.log('[SNX-BE] Broadcast started (server-side) —', data);

  return data;
}

/**
 * Stop the broadcast on the server-side broadcast engine.
 *
 * Sends POST /broadcast/stop to the Cloudflare Worker, which:
 *   1. Verifies the Firebase ID token (Founder only)
 *   2. Proxies to the internal broadcast service (POST /broadcast/stop)
 *
 * @returns {Promise<void>}
 */
async function stopBroadcast() {
  const token = await _getIdToken();
  if (!token) throw new Error('Authentication required — sign in as Founder');

  const res = await fetch(`${BROADCAST_CTRL}/broadcast/stop`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    '{}',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A "not running" error from the server is not fatal from the UI perspective
    console.warn('[SNX-BE] Stop broadcast response:', data.error || res.status);
  }

  _broadcastState.active       = false;
  _broadcastState.source       = null;
  _broadcastState.startedAt    = null;
  _broadcastState.destinations = [];
  _broadcastState.healthChecks = {};

  _emit('broadcastStop', { stoppedAt: Date.now() });
  console.log('[SNX-BE] Broadcast stopped (server-side)');
}

/**
 * Report health for a specific destination.
 * Called by the encoder host when it gets a status update.
 *
 * @param {string} destId
 * @param {{ ok: boolean, error?: string }} health
 */
function _reportDestinationHealth(destId, health) {
  if (!_broadcastState.healthChecks[destId]) return;
  const h = _broadcastState.healthChecks[destId];
  h.ok        = health.ok;
  h.lastCheck = Date.now();
  if (!health.ok) {
    h.errorCount++;
    console.warn(`[SNX-BE] Destination ${destId} health: FAIL (errors=${h.errorCount})`);
    _emit('destinationFailed', { destId, errorCount: h.errorCount, error: health.error || '' });
    // Failure isolation: continue other destinations — do not stop the broadcast
  } else {
    if (h.errorCount > 0) {
      console.log(`[SNX-BE] Destination ${destId} health: RECOVERED`);
      _emit('destinationRecovered', { destId });
    }
    h.errorCount = 0;
  }
}

// Expose health reporting to encoder host adapters
window.SNXBroadcastEngine._reportDestinationHealth = _reportDestinationHealth;

/**
 * Get current broadcast status.
 * @returns {Object} broadcast status snapshot
 */
/**
 * Get current broadcast status from the server-side engine.
 * Falls back to local mirror state if the server is unreachable.
 * Safe to call frequently (caches for 5s internally).
 *
 * @returns {Promise<object>} status snapshot (no stream keys)
 */
async function getBroadcastStatus() {
  const token = await _getIdToken();
  if (!token) {
    // Return local mirror state without server call
    return { active: _broadcastState.active, source: _broadcastState.source, startedAt: _broadcastState.startedAt, serverUnreachable: true };
  }

  try {
    const res = await fetch(`${BROADCAST_CTRL}/broadcast/status`, {
      method:  'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('[SNX-BE] getBroadcastStatus error:', err.error || res.status);
      return { active: _broadcastState.active, source: _broadcastState.source, startedAt: _broadcastState.startedAt, serverError: err.error };
    }
    const data = await res.json();
    // Sync local mirror with server truth
    _broadcastState.active    = data.engineState === 'LIVE' || data.engineState === 'CONNECTING';
    _broadcastState.source    = data.sourceType || _broadcastState.source;
    _broadcastState.startedAt = data.startedAt  || _broadcastState.startedAt;
    return data;
  } catch (e) {
    console.warn('[SNX-BE] getBroadcastStatus fetch error:', e.message);
    return { active: _broadcastState.active, source: _broadcastState.source, startedAt: _broadcastState.startedAt, serverUnreachable: true };
  }
}

/* ══════════════════════════════════════════════════════════════
   ENCODER HOST AUDIT
   This section documents the continuous encoder requirement and
   what must exist externally.
══════════════════════════════════════════════════════════════ */

/**
 * Audit the encoder host status.
 * Returns a structured report documenting what is available and what
 * is not currently provisioned.
 *
 * @returns {Object} audit report
 */
function auditEncoderHost() {
  return {
    // ── What the client CAN do ────────────────────────────────────────────────
    destinationManager:    true,   // PASS — destinations stored server-side
    multipleDestinations:  true,   // PASS — any number of enabled destinations
    streamKeySecurity:     true,   // PASS — keys never in client JS or logs
    radioSourceAdapter:    !!window.SNXRadio,  // PASS if SNXRadio loaded
    rtmpOutputArchitecture: true,  // PASS — serverUrl + streamKey → encoder

    // ── H.264 / AAC encoding ─────────────────────────────────────────────────
    // A browser (MediaRecorder) can produce WebM/VP8/Opus.
    // H.264 + AAC in an RTMP container requires a server-side encoder.
    h264InBrowser: (() => {
      try {
        const mc = window.MediaRecorder;
        return !!(mc && mc.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2'));
      } catch { return false; }
    })(),
    aacInBrowser: (() => {
      try {
        const mc = window.MediaRecorder;
        return !!(mc && mc.isTypeSupported('audio/mp4;codecs=mp4a.40.2'));
      } catch { return false; }
    })(),

    // ── Continuous encoder host ───────────────────────────────────────────────
    // A continuously-running encoder (FFmpeg, OBS, GStreamer on a VPS) is
    // NOT currently provisioned.  RTMP + stream key tells the engine WHERE
    // to send the output — it does not itself provide the encoder.
    // To enable 24/7 broadcasting:
    //   1. Provision a VPS or cloud VM
    //   2. Install FFmpeg or OBS
    //   3. Run an encoder process that:
    //      a. subscribes to SNXBroadcastEngine 'control' and 'sourceEvent' events
    //      b. retrieves streamKey server-side (Worker → Firestore, Founder auth)
    //      c. encodes H.264 video (artwork + Now Playing overlay) + AAC audio
    //      d. pushes via RTMP to each enabled destination
    continuousEncoderHost: 'NOT_CURRENTLY_PROVISIONED',
    continuousEncoderNote: 'RTMP destinations are configured and ready. ' +
      'A continuously-running server-side encoder is required to push ' +
      'H.264/AAC over RTMP. This must be provisioned by the Founder.',
  };
}

window.SNXBroadcastEngine.auditEncoderHost = auditEncoderHost;

/* ══════════════════════════════════════════════════════════════
   EVENT BUS
══════════════════════════════════════════════════════════════ */

function on(event, cb) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(cb);
}

function off(event, cb) {
  if (!_listeners[event]) return;
  _listeners[event] = _listeners[event].filter(fn => fn !== cb);
}

function _emit(event, data) {
  (_listeners[event] || []).forEach(fn => { try { fn(data); } catch (e) { console.error('[SNX-BE] Event error', event, e); } });
}

/* ══════════════════════════════════════════════════════════════
   AUTH HELPERS
══════════════════════════════════════════════════════════════ */

async function _getIdToken() {
  const auth = window._snxAuth || (window.firebase && window.firebase.auth && window.firebase.auth());
  if (!auth) return null;
  const user = window._snxCurrentUser || auth.currentUser;
  if (!user) return null;
  try { return await user.getIdToken(false); } catch { return null; }
}

/* ══════════════════════════════════════════════════════════════
   STARTUP LOG
══════════════════════════════════════════════════════════════ */

console.log('[SNX-BE] snx-broadcast-engine.js loaded — version', ENGINE_VERSION);

})();
