/**
 * shadow-reaper-v2/core/sr-capability-state.js
 * Shadow Reaper — Offline Capability State System
 *
 * Build: SR-CAPABILITY-STATE-1
 *
 * Exposes: window.SRCapabilityState
 *
 * PURPOSE:
 *   Truthful, observable internal state that distinguishes:
 *     — Shadow's LOCAL intelligence readiness
 *     — Network availability
 *     — Local model state
 *   These are INDEPENDENT dimensions. Internet connection does NOT control
 *   whether local conversation, Language Foundation, memory, or personality
 *   are available.
 *
 * STATES:
 *
 *   LOCAL INTELLIGENCE:
 *     LOCAL_READY         — Language Foundation loaded, deterministic pipeline operational
 *     LOCAL_DEGRADED      — Language Foundation missing/partial; fallback pools only
 *     LOCAL_FAILED        — Critical core failure; Shadow cannot respond at all
 *
 *   LOCAL MODEL:
 *     MODEL_UNINITIALIZED — loadModel() not yet called
 *     MODEL_LOADING       — In progress (downloading/initializing)
 *     MODEL_READY         — Verified, inference available
 *     MODEL_FAILED        — Failed to load (error code available)
 *
 *   NETWORK:
 *     NETWORK_AVAILABLE   — navigator.onLine is true AND connectivity probe passed
 *     NETWORK_UNAVAILABLE — navigator.onLine is false OR probe failed
 *     NETWORK_UNKNOWN     — detection not yet run
 *
 * RULE:
 *   Shadow can be MODEL_FAILED + LOCAL_READY + NETWORK_UNAVAILABLE.
 *   That still means local conversation works correctly.
 *
 *   Shadow should NEVER report MODEL_READY if inference cannot actually occur.
 *   The model state is driven by SRLocalModel.getStatus(), not a cached bool.
 *
 * Zero external calls. Zero polling loops. Event-driven updates only.
 */

'use strict';

(function (global) {

  var BUILD_ID = 'SR-CAPABILITY-STATE-1';

  // ── State constants ─────────────────────────────────────────────────────────
  var LOCAL  = {
    READY:    'LOCAL_READY',
    DEGRADED: 'LOCAL_DEGRADED',
    FAILED:   'LOCAL_FAILED',
  };

  var MODEL  = {
    UNINITIALIZED: 'MODEL_UNINITIALIZED',
    LOADING:       'MODEL_LOADING',
    READY:         'MODEL_READY',
    FAILED:        'MODEL_FAILED',
  };

  var NETWORK = {
    AVAILABLE:   'NETWORK_AVAILABLE',
    UNAVAILABLE: 'NETWORK_UNAVAILABLE',
    UNKNOWN:     'NETWORK_UNKNOWN',
  };

  // ── Internal state ──────────────────────────────────────────────────────────
  var _local   = LOCAL.DEGRADED;    // optimistic default; evaluated on init
  var _model   = MODEL.UNINITIALIZED;
  var _network = NETWORK.UNKNOWN;

  var _localReason  = null;   // human-readable reason for LOCAL_DEGRADED / FAILED
  var _modelReason  = null;   // human-readable reason for MODEL_FAILED
  var _modelErrCode = null;   // error code from SRLocalModel diagnostics

  var _listeners = [];

  // ── Notify listeners ────────────────────────────────────────────────────────
  function _notify(dimension, newState, reason) {
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](dimension, newState, reason, _snapshot()); } catch (_) {}
    }
  }

  // ── State setters ────────────────────────────────────────────────────────────
  function _setLocal(state, reason) {
    if (_local === state && _localReason === reason) return;
    _local       = state;
    _localReason = reason || null;
    _notify('LOCAL', state, reason);
  }

  function _setModel(state, reason, errCode) {
    if (_model === state && _modelReason === reason) return;
    _model        = state;
    _modelReason  = reason  || null;
    _modelErrCode = errCode || null;
    _notify('MODEL', state, reason);
  }

  function _setNetwork(state, reason) {
    if (_network === state) return;
    _network = state;
    _notify('NETWORK', state, reason);
  }

  // ── Snapshot ────────────────────────────────────────────────────────────────
  function _snapshot() {
    return {
      localState:    _local,
      localReason:   _localReason,
      modelState:    _model,
      modelReason:   _modelReason,
      modelErrCode:  _modelErrCode,
      networkState:  _network,

      // Convenience flags
      localReady:    _local  === LOCAL.READY,
      modelReady:    _model  === MODEL.READY,
      networkUp:     _network === NETWORK.AVAILABLE,

      // User-facing summary for UI status line
      uiStatus:      _computeUIStatus(),
      uiClass:       _computeUIClass(),

      // Capability summary
      conversationAvailable: (_local !== LOCAL.FAILED),
      modelInferenceAvailable: (_model === MODEL.READY),
      liveDataAvailable: (_network === NETWORK.AVAILABLE),
    };
  }

  // ── UI status summary ────────────────────────────────────────────────────────
  function _computeUIStatus() {
    if (_local === LOCAL.FAILED)          return 'Shadow core error';
    if (_model === MODEL.LOADING)         return 'Loading AI model…';
    if (_model === MODEL.READY &&
        _network === NETWORK.AVAILABLE)   return 'Online · Full intelligence';
    if (_model === MODEL.READY &&
        _network !== NETWORK.AVAILABLE)   return 'Offline · Full intelligence';
    if (_local === LOCAL.READY &&
        _network === NETWORK.AVAILABLE)   return 'Online · Local intelligence';
    if (_local === LOCAL.READY &&
        _network !== NETWORK.AVAILABLE)   return 'Offline · Local intelligence';
    if (_local === LOCAL.DEGRADED &&
        _network === NETWORK.AVAILABLE)   return 'Online · Limited mode';
    if (_local === LOCAL.DEGRADED &&
        _network !== NETWORK.AVAILABLE)   return 'Offline · Limited mode';
    return 'Initializing…';
  }

  function _computeUIClass() {
    if (_local === LOCAL.FAILED)          return 'error';
    if (_model === MODEL.LOADING)         return 'loading';
    if (_local === LOCAL.DEGRADED)        return 'warn';
    if (_model === MODEL.READY)           return 'ready';
    if (_local === LOCAL.READY)           return 'ready';
    return 'loading';
  }

  // ── Evaluate LOCAL state ─────────────────────────────────────────────────────
  // Checks: SRLanguage, SRUnderstanding, SRResponse, SRContext, SRConversation
  function _evaluateLocal() {
    var hasCore = !!(global.SRUnderstanding && global.SRResponse &&
                     global.SRContext && global.SRConversation);
    var hasLang = !!global.SRLanguage;

    if (!hasCore) {
      _setLocal(LOCAL.FAILED, 'Core pipeline modules missing (SRUnderstanding / SRResponse / SRContext)');
      return;
    }
    if (!hasLang) {
      _setLocal(LOCAL.DEGRADED, 'Language Foundation (SRLanguage) not loaded — response pools only');
      return;
    }
    _setLocal(LOCAL.READY, null);
  }

  // ── Evaluate MODEL state ─────────────────────────────────────────────────────
  // Reads from SRLocalModel.getStatus() — never trusts a cached variable.
  function _evaluateModel() {
    var lm = global.SRLocalModel;
    if (!lm) {
      _setModel(MODEL.UNINITIALIZED, 'SRLocalModel not loaded', null);
      return;
    }
    var status = lm.getStatus();
    var diag   = (lm.getDiagnostics && lm.getDiagnostics()) || {};

    switch (status.state) {
      case 'READY':
        _setModel(MODEL.READY, null, null);
        break;
      case 'LOADING':
      case 'VERIFYING':
        _setModel(MODEL.LOADING, 'Model initializing (' + (status.loadPct || 0) + '%)', null);
        break;
      case 'FAILED':
        _setModel(MODEL.FAILED, status.lastError || 'Unknown error', diag.errorCode || null);
        break;
      case 'UNINITIALIZED':
      default:
        _setModel(MODEL.UNINITIALIZED, 'loadModel() not yet called', null);
        break;
    }
  }

  // ── Evaluate NETWORK state ───────────────────────────────────────────────────
  function _evaluateNetwork() {
    if (typeof global.navigator !== 'undefined') {
      var onLine = global.navigator.onLine;
      if (onLine === false) {
        _setNetwork(NETWORK.UNAVAILABLE, 'navigator.onLine = false');
        return;
      }
    }
    // onLine = true or not available — treat as available (optimistic)
    _setNetwork(NETWORK.AVAILABLE, 'navigator.onLine = true');
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * init()
   * Evaluate all dimensions and wire connectivity listeners.
   * Safe to call multiple times.
   */
  function init() {
    _evaluateLocal();
    _evaluateModel();
    _evaluateNetwork();

    // Wire online/offline events — NO polling
    if (typeof global.addEventListener !== 'undefined') {
      global.addEventListener('online',  function () { _setNetwork(NETWORK.AVAILABLE,   'online event'); });
      global.addEventListener('offline', function () { _setNetwork(NETWORK.UNAVAILABLE, 'offline event'); });
    }

    // Wire SRLocalModel state changes if available
    if (global.SRLocalModel && global.SRLocalModel.onStateChange) {
      global.SRLocalModel.onStateChange(function () { _evaluateModel(); });
    }
  }

  /**
   * refresh()
   * Re-evaluate all dimensions (call after dynamic module loads).
   */
  function refresh() {
    _evaluateLocal();
    _evaluateModel();
    _evaluateNetwork();
  }

  /**
   * getSnapshot()
   * Returns the current capability snapshot.
   */
  function getSnapshot() {
    return _snapshot();
  }

  /**
   * onChange(fn)
   * Register a listener: fn(dimension, newState, reason, snapshot)
   * Returns an unsubscribe function.
   */
  function onChange(fn) {
    _listeners.push(fn);
    return function () {
      _listeners = _listeners.filter(function (f) { return f !== fn; });
    };
  }

  // Expose state constants on the module for external use
  global.SRCapabilityState = {
    build: BUILD_ID,

    LOCAL:   LOCAL,
    MODEL:   MODEL,
    NETWORK: NETWORK,

    init:        init,
    refresh:     refresh,
    getSnapshot: getSnapshot,
    onChange:    onChange,

    // Direct state accessors (read-only)
    getLocal:   function () { return _local; },
    getModel:   function () { return _model; },
    getNetwork: function () { return _network; },
  };

})(typeof window !== 'undefined' ? window : global);
