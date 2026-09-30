/**
 * snx-radio-presence.js — Shadow Nexus Radio · Listening Now
 * Version: 1.0.0
 *
 * Tracks how many people are actively inside the Radio listening session.
 *
 * Presence storage:
 *   RTDB path:  /radioPresence/{sessionId}
 *   Fields:     { uid, connectedAt, lastSeen }
 *
 * Lifecycle:
 *   SNXRadioPresence.join()   — called when user enters Radio page + station on-air
 *   SNXRadioPresence.leave()  — called when user leaves Radio page
 *   SNXRadioPresence.destroy()— full teardown
 *
 * Duplicate / stale protection:
 *   - Each page load generates a unique sessionId (does not depend on uid).
 *   - Refreshing creates a new sessionId; the old one is removed via onDisconnect.
 *   - A heartbeat writes lastSeen every HEARTBEAT_MS ms.
 *   - The count query filters out entries where lastSeen < (now - STALE_MS).
 *   - onDisconnect().remove() handles browser close / connection loss.
 *
 * Security:
 *   Normal users can read /radioPresence (listener count) but cannot read UIDs
 *   from the count display — the UI only shows the numeric count.
 *   Write rules should restrict each session node to the owning session
 *   (validated via a server-side rule; sessionId is not guessable).
 *
 * Dependencies:
 *   window._snxLiveDB      — Firebase RTDB instance (set by index.html)
 *   window._snxRtdbApi     — { ref, set, remove, onValue, off }
 *   window._snxRtdbExt     — { onDisconnect, serverTimestamp } (set by index.html)
 *   window._snxCurrentUser — Firebase Auth user (optional; guests get uid=null)
 */

'use strict';

(function () {

const PRESENCE_VERSION = '1.0.0';
const RTDB_PATH        = 'radioPresence';   // /radioPresence/{sessionId}
const HEARTBEAT_MS     = 25000;             // write lastSeen every 25 s
const STALE_MS         = 65000;             // sessions not seen in 65 s are stale

/* ── State ── */
let _sessionId      = null;  // unique id for this browser tab/session
let _presenceRef    = null;  // RTDB ref to /radioPresence/{sessionId}
let _countUnsub     = null;  // onValue unsubscribe for count listener
let _heartbeatTimer = null;
let _joined         = false;
let _connectedAt    = 0;     // timestamp when this session joined
let _onCountChange  = null;  // callback(count: number)

/* ── Public API ── */
window.SNXRadioPresence = {
  join,
  leave,
  destroy,
  setOnCountChange,
  get isJoined() { return _joined; },
  get version()  { return PRESENCE_VERSION; },
};

/* ════════════════════════════════════════════════════════════
   PUBLIC
════════════════════════════════════════════════════════════ */

/**
 * Register a callback that fires with the live listener count.
 * @param {function(number):void} cb
 */
function setOnCountChange(cb) {
  _onCountChange = cb;
}

/**
 * Join the Radio presence.
 * Safe to call multiple times — idempotent if already joined with the same session.
 */
function join() {
  if (_joined) return;

  const rtdb    = _getRtdb();
  const api     = _getApi();
  const ext     = _getExt();
  if (!rtdb || !api || !ext) {
    console.warn('[SNX-PRESENCE] RTDB not ready — will retry');
    setTimeout(join, 800);
    return;
  }

  // Generate a unique session id for this tab load
  if (!_sessionId) {
    _sessionId = _randId();
  }

  const uid = (window._snxCurrentUser && window._snxCurrentUser.uid) || null;
  const now = Date.now();

  _presenceRef = api.ref(rtdb, RTDB_PATH + '/' + _sessionId);
  _connectedAt = now;

  // Write presence entry
  api.set(_presenceRef, {
    uid:          uid,
    connectedAt:  now,
    lastSeen:     now,
  }).catch(e => console.warn('[SNX-PRESENCE] join write error:', e.message));

  // onDisconnect: auto-remove when connection drops
  try {
    ext.onDisconnect(_presenceRef).remove();
  } catch (e) {
    console.warn('[SNX-PRESENCE] onDisconnect setup error:', e.message);
  }

  // Heartbeat — keep lastSeen current
  _heartbeatTimer = setInterval(_heartbeat, HEARTBEAT_MS);

  // Subscribe to count
  _subscribeCount(rtdb, api);

  _joined = true;
  console.log('[SNX-PRESENCE] joined — session:', _sessionId);
}

/**
 * Leave the Radio presence (user navigated away from Radio page).
 */
function leave() {
  if (!_joined) return;
  _cleanup();
  _joined = false;
  console.log('[SNX-PRESENCE] left — session:', _sessionId);
}

/**
 * Full teardown (page unload / Radio destroyed).
 */
function destroy() {
  _cleanup();
  _sessionId   = null;
  _onCountChange = null;
  _joined = false;
}

/* ════════════════════════════════════════════════════════════
   INTERNAL
════════════════════════════════════════════════════════════ */

function _cleanup() {
  // Stop heartbeat
  if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }

  // Unsubscribe count listener
  if (_countUnsub) {
    try { _countUnsub(); } catch (_) {}
    _countUnsub = null;
  }

  // Remove presence node immediately (best-effort; onDisconnect is the safety net)
  if (_presenceRef) {
    const api = _getApi();
    if (api) {
      api.remove(_presenceRef).catch(() => {});
    }
    _presenceRef = null;
  }
}

function _heartbeat() {
  if (!_presenceRef) return;
  const api = _getApi();
  if (!api) return;
  // Only update lastSeen — preserve original connectedAt
  api.set(_presenceRef, {
    uid:         (window._snxCurrentUser && window._snxCurrentUser.uid) || null,
    connectedAt: _connectedAt || Date.now(),
    lastSeen:    Date.now(),
  }).catch(() => {});
}

function _subscribeCount(rtdb, api) {
  // Unsubscribe any existing listener first
  if (_countUnsub) { try { _countUnsub(); } catch (_) {} _countUnsub = null; }

  const path = RTDB_PATH;
  const countRef = api.ref(rtdb, path);

  const handler = (snap) => {
    let count = 0;
    if (snap && snap.exists()) {
      const now = Date.now();
      snap.forEach(child => {
        const v = child.val();
        // Filter stale entries
        if (v && typeof v.lastSeen === 'number' && (now - v.lastSeen) < STALE_MS) {
          count++;
        }
      });
    }
    if (typeof _onCountChange === 'function') {
      try { _onCountChange(count); } catch (_) {}
    }
  };

  // Firebase modular onValue() returns an unsubscribe function directly
  const unsub = api.onValue(countRef, handler);
  _countUnsub = () => {
    if (typeof unsub === 'function') {
      try { unsub(); } catch (_) {}
    } else if (api.off) {
      try { api.off(countRef, 'value', handler); } catch (_) {}
    }
  };
}

/* ── Firebase accessors ── */

function _getRtdb() {
  return window._snxLiveDB || null;
}

function _getApi() {
  return window._snxRtdbApi || null;
}

function _getExt() {
  return window._snxRtdbExt || null;
}

/* ── Utilities ── */

function _randId() {
  const arr = new Uint8Array(12);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Log ── */
console.log('[SNX-PRESENCE] snx-radio-presence.js loaded — version', PRESENCE_VERSION);

})();
