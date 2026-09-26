/**
 * snx-presence.js — Shadow Nexus Social Presence System
 *
 * Manages:
 *   - Online / Away / Busy / Invisible / Offline status
 *   - Custom status text (e.g. "🎵 Making music")
 *   - Firebase RTDB onDisconnect for reliable offline detection
 *   - Invisible mode: stored in Firestore but appears offline to others
 *   - Read presence for other users
 *
 * RTDB path: /presence/{uid}
 *   { status, customStatus, lastSeen, invisible }
 *
 * Firestore: users/{uid}.presenceStatus / .presenceCustom / .presenceInvisible
 *
 * Writes are throttled — no write every few seconds.
 * onDisconnect handles offline transitions server-side.
 */

'use strict';

(function () {

  var RTDB_PATH = 'presence';

  var _uid = null;
  var _db  = null;   // RTDB
  var _fdb = null;   // Firestore db
  var _presRef = null;
  var _heartbeatTimer = null;
  var _currentStatus  = 'online';
  var _customStatus   = '';
  var _invisible      = false;
  var _awayTimer      = null;
  var _listeners      = {};  // uid → unsubscribe callback

  /* ── Expose public API ── */
  window.SNXPresence = {
    init:           init,
    setStatus:      setStatus,
    setCustom:      setCustom,
    setInvisible:   setInvisible,
    getStatus:      getStatus,
    watchUser:      watchUser,
    unwatchUser:    unwatchUser,
    goOffline:      goOffline,
    STATUSES:       ['online', 'away', 'busy', 'invisible', 'offline']
  };

  /* ════════════════════════════════════════════════
     INIT — called once after auth resolves
  ════════════════════════════════════════════════ */
  function init(uid, rtdb, firestoreDb) {
    if (_uid === uid) return; // already initialised for this user
    _uid = uid;
    _db  = rtdb;
    _fdb = firestoreDb;

    // Read saved prefs
    try {
      var stored = JSON.parse(localStorage.getItem('snxPresencePref') || '{}');
      _invisible     = !!stored.invisible;
      _customStatus  = stored.customStatus || '';
      _currentStatus = stored.status || 'online';
    } catch(_) {}

    _attachRTDB();
    _startAwayDetection();

    // Listen for page unload
    window.addEventListener('beforeunload', _onUnload);
    document.addEventListener('visibilitychange', _onVisibilityChange);
  }

  /* ════════════════════════════════════════════════
     RTDB SETUP + onDisconnect
  ════════════════════════════════════════════════ */
  function _attachRTDB() {
    if (!_db || !_uid) return;
    try {
      var firebase = window.firebase || (window._snxFirebaseApp && window._snxFirebaseApp._firebase);
      // Access RTDB via the global helpers the main app exposes
      var refFn  = window._snxRTDB_ref  || (function(p){ return _db.ref(p); });
      _presRef   = refFn(RTDB_PATH + '/' + _uid);

      var onlinePayload  = _buildPayload(true);
      var offlinePayload = { status: 'offline', lastSeen: { '.sv': 'timestamp' }, invisible: false };

      // Server-side disconnect handler
      _presRef.onDisconnect().set(offlinePayload);
      // Write online now
      _presRef.set(onlinePayload);

      // Heartbeat every 90s to keep RTDB connection alive (not presence spam)
      _heartbeatTimer = setInterval(function() {
        if (!document.hidden) {
          _presRef.update({ lastSeen: { '.sv': 'timestamp' } });
        }
      }, 90000);
    } catch(e) {
      console.warn('[SNXPresence] RTDB attach failed:', e);
    }
  }

  function _buildPayload(online) {
    return {
      status:       (_invisible ? 'offline' : (online ? _currentStatus : 'offline')),
      customStatus: _invisible ? '' : _customStatus,
      lastSeen:     { '.sv': 'timestamp' },
      invisible:    _invisible
    };
  }

  /* ════════════════════════════════════════════════
     PUBLIC: setStatus
  ════════════════════════════════════════════════ */
  function setStatus(status) {
    if (!window.SNXPresence.STATUSES.includes(status)) return;
    var wasInvisible = _invisible;
    _invisible = (status === 'invisible');
    _currentStatus = _invisible ? 'online' : status; // internal real status
    _savePref();
    if (_presRef) _presRef.set(_buildPayload(true)).catch(function(){});
    // Persist to Firestore for profile display
    _syncFirestore();
    // Announce to listeners
    _emit('statusChange', { status: getStatus(), customStatus: _customStatus });
  }

  /* ════════════════════════════════════════════════
     PUBLIC: setCustom
  ════════════════════════════════════════════════ */
  function setCustom(text) {
    _customStatus = String(text || '').slice(0, 80);
    _savePref();
    if (_presRef && !_invisible) {
      _presRef.update({ customStatus: _customStatus }).catch(function(){});
    }
    _syncFirestore();
  }

  /* ════════════════════════════════════════════════
     PUBLIC: setInvisible
  ════════════════════════════════════════════════ */
  function setInvisible(on) {
    setStatus(on ? 'invisible' : (_currentStatus === 'online' ? 'online' : _currentStatus));
  }

  /* ════════════════════════════════════════════════
     PUBLIC: getStatus — returns what THIS user sees
  ════════════════════════════════════════════════ */
  function getStatus() {
    if (_invisible) return 'invisible';
    return _currentStatus;
  }

  /* ════════════════════════════════════════════════
     PUBLIC: goOffline — cleanup on logout
  ════════════════════════════════════════════════ */
  function goOffline() {
    clearInterval(_heartbeatTimer);
    clearTimeout(_awayTimer);
    window.removeEventListener('beforeunload', _onUnload);
    document.removeEventListener('visibilitychange', _onVisibilityChange);
    if (_presRef) {
      _presRef.onDisconnect().cancel();
      _presRef.set({ status: 'offline', lastSeen: { '.sv': 'timestamp' } }).catch(function(){});
    }
    _uid = null;
    _presRef = null;
  }

  /* ════════════════════════════════════════════════
     PUBLIC: watchUser — RTDB listener for another uid
  ════════════════════════════════════════════════ */
  function watchUser(uid, callback) {
    if (!_db || !uid) return function(){};
    try {
      var refFn = window._snxRTDB_ref || (function(p){ return _db.ref(p); });
      var ref   = refFn(RTDB_PATH + '/' + uid);
      var handler = function(snap) {
        var val = snap ? snap.val() : null;
        if (!val) { callback({ status: 'offline', customStatus: '', lastSeen: 0 }); return; }
        // Invisible users appear offline to others
        callback({
          status:       val.invisible ? 'offline' : (val.status || 'offline'),
          customStatus: val.invisible ? '' : (val.customStatus || ''),
          lastSeen:     val.lastSeen || 0
        });
      };
      ref.on('value', handler);
      _listeners[uid] = function() { ref.off('value', handler); };
      return _listeners[uid];
    } catch(e) {
      return function(){};
    }
  }

  /* ════════════════════════════════════════════════
     PUBLIC: unwatchUser
  ════════════════════════════════════════════════ */
  function unwatchUser(uid) {
    if (_listeners[uid]) { _listeners[uid](); delete _listeners[uid]; }
  }

  /* ════════════════════════════════════════════════
     AWAY DETECTION — tab visibility + inactivity
  ════════════════════════════════════════════════ */
  function _startAwayDetection() {
    var _lastActivity = Date.now();
    var AWAY_AFTER_MS = 5 * 60 * 1000; // 5 min

    function _resetActivity() { _lastActivity = Date.now(); }

    ['mousemove','keydown','touchstart','click'].forEach(function(evt) {
      document.addEventListener(evt, _resetActivity, { passive: true });
    });

    _awayTimer = setInterval(function() {
      if (_invisible || _currentStatus === 'busy' || _currentStatus === 'offline') return;
      var idle = Date.now() - _lastActivity;
      if (idle > AWAY_AFTER_MS && _currentStatus === 'online') {
        if (_presRef) _presRef.update({ status: 'away' }).catch(function(){});
      } else if (idle < AWAY_AFTER_MS && _currentStatus === 'online') {
        // Restore from auto-away (only if was auto-set, not manual)
        if (_presRef) _presRef.update({ status: 'online' }).catch(function(){});
      }
    }, 60000);
  }

  /* ════════════════════════════════════════════════
     VISIBILITY CHANGE
  ════════════════════════════════════════════════ */
  function _onVisibilityChange() {
    if (!_presRef || _invisible) return;
    if (document.hidden) {
      _presRef.update({ status: 'away' }).catch(function(){});
    } else {
      _presRef.update({ status: _currentStatus, lastSeen: { '.sv': 'timestamp' } }).catch(function(){});
    }
  }

  function _onUnload() {
    // Synchronous — best effort
    if (_presRef) {
      _presRef.set({ status: 'offline', lastSeen: Date.now() });
    }
  }

  /* ════════════════════════════════════════════════
     SYNC TO FIRESTORE — for profile display
  ════════════════════════════════════════════════ */
  var _firestoreDebounce = null;
  function _syncFirestore() {
    clearTimeout(_firestoreDebounce);
    _firestoreDebounce = setTimeout(function() {
      if (!_fdb || !_uid) return;
      var fs = window._snxFirestore;
      if (!fs) return;
      try {
        var updateData = {
          presenceStatus:   _invisible ? 'invisible' : _currentStatus,
          presenceCustom:   _customStatus,
          presenceInvisible:_invisible,
          presenceUpdatedAt:Date.now()
        };
        fs.updateDoc(fs.doc(_fdb, 'users', _uid), updateData).catch(function(){});
      } catch(e) {}
    }, 2000);
  }

  function _savePref() {
    try {
      localStorage.setItem('snxPresencePref', JSON.stringify({
        status:       _currentStatus,
        customStatus: _customStatus,
        invisible:    _invisible
      }));
    } catch(_) {}
  }

  /* Simple event emitter */
  function _emit(event, data) {
    try { document.dispatchEvent(new CustomEvent('snxPresence:' + event, { detail: data })); } catch(_) {}
  }

  /* ════════════════════════════════════════════════
     AUTO-INIT — hook into app auth flow
  ════════════════════════════════════════════════ */
  document.addEventListener('snxAuthReady', function(e) {
    var detail = e.detail || {};
    if (detail.uid && detail.rtdb && detail.db) {
      init(detail.uid, detail.rtdb, detail.db);
    }
  });

})();
