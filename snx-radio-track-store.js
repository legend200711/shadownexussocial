/**
 * snx-radio-track-store.js — Shadow Nexus Radio · Shared Track Store
 * Build: SNS-2026-STAGE2C-001
 *
 * PURPOSE
 *   Maintains ONE Firestore onSnapshot listener for /radioTracks.
 *   SNXRadio, SNXRadioRequests, and SNXRadioStudio all previously opened
 *   independent listeners for the same collection.  This module replaces
 *   all three with a single shared listener, reducing Firestore reads on
 *   every live update.
 *
 * Architecture:
 *   Firebase /radioTracks
 *       ↓
 *   ONE onSnapshot  (this module)
 *       ↓
 *   window.SNXRadioTrackStore  (in-memory cache + local pub/sub)
 *       ↓
 *   SNXRadio  ·  SNXRadioRequests  ·  SNXRadioStudio  (local callbacks only)
 *
 * Public API (window.SNXRadioTrackStore):
 *   subscribe(callback)   — register a local subscriber; returns unsubscribe fn
 *                           callback receives an array of normalised track docs
 *   getTracks()           — synchronous: returns current cached tracks (may be [])
 *   start()               — ensure the Firebase listener is running (idempotent)
 *   stop()                — tear down the Firebase listener (call on full app destroy)
 *
 * Guarantees:
 *   - At most ONE active onSnapshot for /radioTracks at any time
 *   - New subscribers immediately receive the current cache (no extra read)
 *   - Subscriber unsubscribes do NOT tear down the Firebase listener
 *   - Firebase listener is only stopped when stop() is called explicitly or
 *     when there are zero subscribers AND the listener was idle for > 5 min
 *   - Safe to call start() from multiple modules — idempotent
 *   - No writes to /radioTracks (read-only store)
 *   - No audio/playback logic
 *
 * DO NOT TOUCH:
 *   /radioTracks schema · document structure · permissions
 *   playback logic · playlist logic · request logic
 *   Radio epoch · timeline math · server clock
 */

'use strict';

(function () {

  /* ════════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════════ */
  const COL_TRACKS    = 'radioTracks';
  const IDLE_STOP_MS  = 5 * 60 * 1000;  // stop Firebase listener after 5 min with no subscribers

  /* ════════════════════════════════════════════════════════════
     STATE
  ════════════════════════════════════════════════════════════ */
  let _unsub        = null;    // Firebase onSnapshot unsubscribe
  let _cache        = [];      // latest array of raw track docs { id, ...data }
  let _subscribers  = {};      // id → callback
  let _nextSubId    = 1;
  let _idleTimer    = null;    // setTimeout to stop listener when no subscribers
  let _started      = false;

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */
  window.SNXRadioTrackStore = {
    subscribe,
    getTracks,
    start,
    stop,
  };

  /* ────────────────────────────────────────────────────────────
     subscribe(callback) → unsubscribeFn
     callback(tracks) — called immediately with current cache,
     then on every live update from Firebase.
  ──────────────────────────────────────────────────────────── */
  function subscribe(callback) {
    if (typeof callback !== 'function') return function () {};

    const id = _nextSubId++;
    _subscribers[id] = callback;

    // Cancel any pending idle-stop
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }

    // Ensure the Firebase listener is running
    start();

    // Immediately deliver current cache to new subscriber
    try { callback(_cache.slice()); } catch (e) { /* subscriber error — do not crash store */ }

    return function unsubscribe() {
      delete _subscribers[id];
      _scheduleIdleStop();
    };
  }

  /* ────────────────────────────────────────────────────────────
     getTracks() — synchronous snapshot of current cache
  ──────────────────────────────────────────────────────────── */
  function getTracks() {
    return _cache.slice();
  }

  /* ────────────────────────────────────────────────────────────
     start() — ensure Firebase listener is running (idempotent)
  ──────────────────────────────────────────────────────────── */
  function start() {
    if (_unsub) return; // already running

    const mods = window._snxFirestore;
    if (!mods || !mods.db || !mods.collection || !mods.onSnapshot) {
      // Firebase not ready yet — retry after a short delay
      if (!_started) {
        _started = true;
        setTimeout(function () { _started = false; start(); }, 1200);
      }
      return;
    }
    _started = false;

    try {
      const { db, collection, onSnapshot } = mods;
      const colRef = collection(db, COL_TRACKS);

      _unsub = onSnapshot(colRef, function (snap) {
        // Build raw doc array
        const docs = [];
        snap.forEach(function (d) { docs.push({ id: d.id, _data: d.data() }); });

        // Flatten to { id, ...data } format expected by consumers
        _cache = docs.map(function (d) {
          return Object.assign({ id: d.id }, d._data);
        });

        console.log('[SNXRadioTrackStore] /radioTracks update —', _cache.length, 'docs');
        _notifyAll(_cache.slice());

      }, function (err) {
        console.warn('[SNXRadioTrackStore] onSnapshot error:', err.message);
        _unsub = null; // allow re-start on next subscriber
      });

      console.log('[SNXRadioTrackStore] Firebase listener started');
    } catch (e) {
      console.warn('[SNXRadioTrackStore] start() error:', e.message);
    }
  }

  /* ────────────────────────────────────────────────────────────
     stop() — tear down Firebase listener; clears cache
     Only call from full app destroy or explicit cleanup.
     Normal subscriber unsubscribes do NOT call this directly —
     idle-stop handles graceful teardown.
  ──────────────────────────────────────────────────────────── */
  function stop() {
    if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
    if (_unsub) {
      try { _unsub(); } catch (_) {}
      _unsub = null;
      console.log('[SNXRadioTrackStore] Firebase listener stopped');
    }
    _cache = [];
    _subscribers = {};
  }

  /* ════════════════════════════════════════════════════════════
     INTERNALS
  ════════════════════════════════════════════════════════════ */

  function _notifyAll(tracks) {
    Object.keys(_subscribers).forEach(function (id) {
      try { _subscribers[id](tracks); } catch (e) { /* subscriber error — isolated */ }
    });
  }

  function _scheduleIdleStop() {
    // Only stop if truly no subscribers remain
    if (Object.keys(_subscribers).length > 0) return;
    if (_idleTimer) return;
    _idleTimer = setTimeout(function () {
      _idleTimer = null;
      if (Object.keys(_subscribers).length === 0 && _unsub) {
        try { _unsub(); } catch (_) {}
        _unsub = null;
        console.log('[SNXRadioTrackStore] Firebase listener stopped (idle — no subscribers)');
      }
    }, IDLE_STOP_MS);
  }

  /* ════════════════════════════════════════════════════════════
     AUTO-START — begin listening as soon as Firebase is ready
  ════════════════════════════════════════════════════════════ */
  // Defer slightly so firebase-config.js has set window._snxFirestore
  setTimeout(start, 800);

})();
