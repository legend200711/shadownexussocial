/**
 * shadow-reaper-v2/adapters/founder-controls.js
 * Shadow Reaper V2 — Founder Control Center
 *
 * Build: SR-V2-FOUNDER-CONTROLS-1
 *
 * Exposes: window.SRFounderControls
 *
 * PURPOSE:
 *   Lets a Founder globally enable/disable Shadow Reaper capabilities.
 *   OFF means capability disabled — NOT data deletion.
 *   This is feature administration, NOT access to private user conversations.
 *
 * ARCHITECTURE:
 *   - Uses existing SNS Founder role architecture (_snxCurrentUser.isFounder).
 *   - Reads/writes Firestore: shadowReaperConfig/globalSettings
 *   - All users see the global capability state.
 *   - Each user's DATA is never read or exposed by Founder controls.
 *   - Founder controls DO NOT create access to private user AI content.
 *
 * CAPABILITIES CONTROLLED:
 *   shadowReaperEnabled, historyEnabled, memoryEnabled, adaptiveEnabled,
 *   knowledgeEnabled, voiceEnabled, translationEnabled, guestAccess
 *   (extensible — add new keys without rebuilding)
 *
 * SECURITY:
 *   - Write access gated by Firestore rules (isFounder claim required).
 *   - This client only provides the UI/API for Founders.
 *   - Rules enforcement is on the server.
 *
 * ZERO EXTERNAL AI CALLS. ZERO POLLING.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-V2-FOUNDER-CONTROLS-1';
  var GLOBAL_CONFIG_PATH  = 'shadowReaperConfig/globalSettings';
  var LOCAL_CACHE_KEY     = 'srFounderControls';

  /* ─────────────────────────────────────────────────────────────
     DEFAULT CAPABILITY STATE
     All capabilities default to ENABLED.
  ───────────────────────────────────────────────────────────────*/
  var DEFAULTS = {
    shadowReaperEnabled: true,
    historyEnabled:      true,
    memoryEnabled:       true,
    adaptiveEnabled:     true,
    knowledgeEnabled:    true,
    voiceEnabled:        true,
    translationEnabled:  true,
    guestAccess:         true,
  };

  /* ─────────────────────────────────────────────────────────────
     IN-MEMORY CACHE
     Loaded from Firestore on init, cached locally for fast reads.
  ───────────────────────────────────────────────────────────────*/
  var _settings = Object.assign({}, DEFAULTS);
  var _loaded   = false;
  var _onChangeCallbacks = [];

  /* ─────────────────────────────────────────────────────────────
     FIREBASE HELPERS — standalone, no SNS globals
  ───────────────────────────────────────────────────────────────*/
  function _fa()  { return global.SRFirebaseAdapter || null; }
  function _uid() {
    var fa = _fa();
    if (fa && typeof fa.getUID === 'function') return fa.getUID();
    return null;
  }

  function _isFounder() {
    /* Client-side pre-check only.
       Real enforcement is via Firestore Security Rules (role custom claim).
       The server-side rule checks: request.auth.token.role == 'founder'.
       We never trust the client for privileged operations. */
    try {
      var fa = _fa();
      if (fa && typeof fa.getCurrentUser === 'function') {
        var user = fa.getCurrentUser();
        /* ID token claims are async; synchronous check is best-effort only */
        if (user && user._founderClaim === true) return true;
      }
    } catch (_) {}
    return false;
  }

  function _configRef() {
    var fa = _fa();
    if (!fa || typeof fa.configDoc !== 'function') return null;
    return fa.configDoc('globalSettings');
  }

  /* ─────────────────────────────────────────────────────────────
     LOAD SETTINGS (non-blocking, async)
     Merges Firestore settings with defaults.
  ───────────────────────────────────────────────────────────────*/
  function load(callback) {
    callback = callback || function () {};

    // Try local cache first for fast reads
    try {
      var cached = global.localStorage && global.localStorage.getItem(LOCAL_CACHE_KEY);
      if (cached) {
        var parsed = JSON.parse(cached);
        _settings = Object.assign({}, DEFAULTS, parsed);
      }
    } catch (_) {}

    var ref = _configRef();
    if (!ref) {
      _loaded = true;
      callback(null, _settings);
      return;
    }

    ref.get().then(function (doc) {
      if (doc && doc.exists) {
        var data = doc.data() || {};
        _settings = Object.assign({}, DEFAULTS, data);
        _cacheLocally();
      } else {
        _settings = Object.assign({}, DEFAULTS);
      }
      _loaded = true;
      callback(null, _settings);
    }).catch(function (err) {
      // Firestore unavailable — use defaults + cache
      _loaded = true;
      callback(err, _settings);
    });
  }

  /* ─────────────────────────────────────────────────────────────
     SAVE SETTINGS (Founder only)
  ───────────────────────────────────────────────────────────────*/
  function save(updates, callback) {
    callback = callback || function () {};

    if (!_isFounder()) {
      callback(new Error('Founder access required.'));
      return;
    }

    var ref = _configRef();
    if (!ref) {
      callback(new Error('Firebase not available.'));
      return;
    }

    // Merge and sanitize — only known capability keys allowed
    var allowed = Object.keys(DEFAULTS);
    var filtered = {};
    allowed.forEach(function (key) {
      if (updates.hasOwnProperty(key) && typeof updates[key] === 'boolean') {
        filtered[key] = updates[key];
      }
    });

    if (!Object.keys(filtered).length) {
      callback(new Error('No valid capability keys provided.'));
      return;
    }

    _settings = Object.assign({}, _settings, filtered);
    _cacheLocally();

    ref.set(_settings, { merge: true }).then(function () {
      _notifyChange(_settings);
      callback(null, _settings);
    }).catch(function (err) {
      callback(err);
    });
  }

  /* ─────────────────────────────────────────────────────────────
     SET SINGLE CAPABILITY (convenience wrapper)
  ───────────────────────────────────────────────────────────────*/
  function setCapability(key, enabled, callback) {
    if (!DEFAULTS.hasOwnProperty(key)) {
      if (typeof callback === 'function') callback(new Error('Unknown capability: ' + key));
      return;
    }
    var update = {};
    update[key] = !!enabled;
    save(update, callback);
  }

  /* ─────────────────────────────────────────────────────────────
     GET CAPABILITY STATE (synchronous, from cache)
  ───────────────────────────────────────────────────────────────*/
  function isEnabled(key) {
    if (!_settings.hasOwnProperty(key)) return true; // Unknown = default ON
    return !!_settings[key];
  }

  function getAll() {
    return Object.assign({}, _settings);
  }

  /* ─────────────────────────────────────────────────────────────
     REAL-TIME LISTENER (optional — for live admin panel updates)
  ───────────────────────────────────────────────────────────────*/
  var _unsubscribe = null;

  function startListening() {
    if (_unsubscribe) return; // Already listening

    var ref = _configRef();
    if (!ref) return;

    try {
      _unsubscribe = ref.onSnapshot(function (doc) {
        if (doc && doc.exists) {
          var data = doc.data() || {};
          _settings = Object.assign({}, DEFAULTS, data);
          _cacheLocally();
          _notifyChange(_settings);
        }
      }, function () {
        // Firestore snapshot error — silently continue
      });
    } catch (_) {}
  }

  function stopListening() {
    if (_unsubscribe) {
      try { _unsubscribe(); } catch (_) {}
      _unsubscribe = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     CHANGE NOTIFICATION
  ───────────────────────────────────────────────────────────────*/
  function onChange(cb) {
    if (typeof cb === 'function') _onChangeCallbacks.push(cb);
  }

  function _notifyChange(settings) {
    _onChangeCallbacks.forEach(function (cb) {
      try { cb(settings); } catch (_) {}
    });
  }

  /* ─────────────────────────────────────────────────────────────
     LOCAL CACHE
  ───────────────────────────────────────────────────────────────*/
  function _cacheLocally() {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(LOCAL_CACHE_KEY, JSON.stringify(_settings));
      }
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     RESET TO DEFAULTS (Founder only)
     Does NOT delete any user data — only resets capability flags.
  ───────────────────────────────────────────────────────────────*/
  function resetDefaults(callback) {
    save(DEFAULTS, callback);
  }

  /* ─────────────────────────────────────────────────────────────
     IS FOUNDER
  ───────────────────────────────────────────────────────────────*/
  function isFounder() {
    return _isFounder();
  }

  /* ─────────────────────────────────────────────────────────────
     DESTROY
  ───────────────────────────────────────────────────────────────*/
  function destroy() {
    stopListening();
    _onChangeCallbacks = [];
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.SRFounderControls
  ───────────────────────────────────────────────────────────────*/
  global.SRFounderControls = {
    build:          BUILD_ID,
    DEFAULTS:       DEFAULTS,
    load:           load,
    save:           save,
    setCapability:  setCapability,
    isEnabled:      isEnabled,
    getAll:         getAll,
    startListening: startListening,
    stopListening:  stopListening,
    onChange:       onChange,
    resetDefaults:  resetDefaults,
    isFounder:      isFounder,
    destroy:        destroy,
  };

})(typeof window !== 'undefined' ? window : global);
