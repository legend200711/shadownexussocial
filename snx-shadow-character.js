/**
 * snx-shadow-character.js
 * Shadow Nexus Social — Shadow Reaper Character State Controller (Stage 4B)
 *
 * Build: SNS-2026-SHADOW-CHARACTER-4B-001
 *
 * Exposes: window.SNXShadowCharacter
 *
 * Stage 4B — CHARACTER EXPERIENCE / VISUAL POLISH ONLY.
 * Does NOT modify Stage 3 intelligence, Stage 4A voice logic, or any
 * existing animation loop (grim-reaper-widget.js / grim-reaper-character-widget.js).
 *
 * Design constraints:
 *  • ZERO new requestAnimationFrame loops.
 *  • ZERO new polling or continuous timers.
 *  • Uses ONLY CSS class changes on #grim-panel and a lightweight
 *    state variable window.SNXShadowCharacterState.
 *  • The existing _gcwRafId loop in grim-reaper-character-widget.js
 *    can read window.SNXShadowCharacterState to optionally modulate
 *    aura intensity — no RAF is created here.
 *  • All effects respect prefers-reduced-motion and LITE/MINIMAL perf modes.
 *  • Presentation states only — NEVER change AI logic.
 *  • Idempotent init/destroy.
 *  • Does NOT touch Live/WebRTC/Cohost/DJ/Radio/TV.
 *
 * State mapping from SNXShadowVoice:
 *   IDLE        → idle
 *   LISTENING   → listening
 *   PROCESSING  → thinking
 *   SPEAKING (TTS start) → speaking
 *   SPEAKING (TTS end)   → idle
 *   MIC_BLOCKED → error
 *   MIC_ERROR   → error
 *
 * Typed question flow (from SNXShadowAI):
 *   _send() start  → thinking
 *   answer display → success (brief) → idle
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var BUILD_ID = 'SNS-2026-SHADOW-CHARACTER-4B-001';

  /* All state names */
  var STATES = {
    IDLE:      'idle',
    LISTENING: 'listening',
    THINKING:  'thinking',
    SPEAKING:  'speaking',
    SUCCESS:   'success',
    ERROR:     'error'
  };

  /* CSS class prefix on #grim-panel */
  var CLASS_PREFIX = 'snx-char-';

  /* All CSS state classes — used for cleanup */
  var ALL_CLASSES = [
    CLASS_PREFIX + 'idle',
    CLASS_PREFIX + 'listening',
    CLASS_PREFIX + 'thinking',
    CLASS_PREFIX + 'speaking',
    CLASS_PREFIX + 'success',
    CLASS_PREFIX + 'error'
  ];

  /* Duration (ms) SUCCESS stays before auto-returning to IDLE */
  var SUCCESS_HOLD_MS = 1400;

  /* ─────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────*/
  var _initialized = false;
  var _destroyed   = false;
  var _state       = STATES.IDLE;
  var _successTimer = null;

  /* ─────────────────────────────────────────────────────────────
     SHARED STATE VARIABLE
     The existing canvas animation loop can read this to optionally
     modulate glow/aura intensity without any new RAF loop.
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowCharacterState = STATES.IDLE;

  /* ─────────────────────────────────────────────────────────────
     PERFORMANCE MODE HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _getPerfMode() {
    if (global.SNXPerf && typeof global.SNXPerf.mode === 'string') {
      return global.SNXPerf.mode.toUpperCase();
    }
    try { return (global.localStorage.getItem('snxPerfMode') || 'BALANCED').toUpperCase(); } catch (_) {}
    return 'BALANCED';
  }

  function _isReducedMotion() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) { return false; }
  }

  /* Returns true when visual effects should be suppressed */
  function _effectsSuppressed() {
    var mode = _getPerfMode();
    return _isReducedMotion() || mode === 'LITE' || mode === 'MINIMAL';
  }

  /* ─────────────────────────────────────────────────────────────
     PANEL REFERENCE
  ───────────────────────────────────────────────────────────────*/
  function _getPanel() {
    return global.document ? global.document.getElementById('grim-panel') : null;
  }

  /* ─────────────────────────────────────────────────────────────
     STATE INDICATOR ELEMENT
     A small, accessible text label inside the status bar that
     shows the current character state — visible even when animations
     are suppressed.
  ───────────────────────────────────────────────────────────────*/
  function _getOrCreateIndicator() {
    if (!global.document) return null;
    var el = global.document.getElementById('snx-char-state-label');
    if (el) return el;

    var statusBar = global.document.getElementById('snx-ai-statusbar');
    if (!statusBar) return null;

    el = global.document.createElement('span');
    el.id = 'snx-char-state-label';
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.setAttribute('role', 'status');
    /* Insert before existing status pill so it appears on the left */
    statusBar.insertBefore(el, statusBar.firstChild);
    return el;
  }

  /* ─────────────────────────────────────────────────────────────
     LABEL TEXT PER STATE
  ───────────────────────────────────────────────────────────────*/
  var _STATE_LABELS = {
    idle:      '',           // no label in idle
    listening: 'Listening',
    thinking:  'Thinking',
    speaking:  'Speaking',
    success:   '',           // no label — brief visual only
    error:     'Error'
  };

  /* ─────────────────────────────────────────────────────────────
     APPLY STATE — core setter
  ───────────────────────────────────────────────────────────────*/
  function _applyState(newState) {
    if (_state === newState) return;
    _state = newState;

    /* Update shared global */
    global.SNXShadowCharacterState = newState;

    /* Update panel CSS classes */
    var panel = _getPanel();
    if (panel) {
      ALL_CLASSES.forEach(function (c) { panel.classList.remove(c); });
      if (!_effectsSuppressed() || newState === 'error') {
        /* In suppressed mode, still apply error class (no animation, just color) */
        panel.classList.add(CLASS_PREFIX + newState);
      }
    }

    /* Update accessible state label */
    var label = _getOrCreateIndicator();
    if (label) {
      label.textContent = _STATE_LABELS[newState] || '';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC setState
  ───────────────────────────────────────────────────────────────*/
  function _setState(newState) {
    if (_destroyed) return;
    if (!STATES[newState.toUpperCase()] && Object.keys(STATES).map(function(k){return STATES[k];}).indexOf(newState) === -1) {
      return; // unknown state — ignore silently
    }

    /* Cancel any pending SUCCESS → IDLE auto-timer */
    if (_successTimer) {
      clearTimeout(_successTimer);
      _successTimer = null;
    }

    _applyState(newState);

    /* SUCCESS: auto-return to IDLE after hold duration */
    if (newState === STATES.SUCCESS) {
      _successTimer = setTimeout(function () {
        _successTimer = null;
        if (!_destroyed && _state === STATES.SUCCESS) {
          _applyState(STATES.IDLE);
        }
      }, SUCCESS_HOLD_MS);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     VOICE INTEGRATION
     Listen to SNXShadowVoice state changes via polling or direct hook.
     We use a SINGLE short-lived connection check — no polling loop.
     SNXShadowVoice already calls _updateCharacterClass() on its own
     state changes; Stage 4B supplements this by adding a callback hook.
  ───────────────────────────────────────────────────────────────*/
  function _mapVoiceState(voiceState) {
    switch (voiceState) {
      case 'IDLE':           return STATES.IDLE;
      case 'LISTENING':      return STATES.LISTENING;
      case 'PROCESSING':     return STATES.THINKING;
      case 'SPEAKING':       return STATES.SPEAKING;
      case 'MIC_BLOCKED':    return STATES.ERROR;
      case 'MIC_ERROR':      return STATES.ERROR;
      case 'MIC_UNSUPPORTED':return STATES.IDLE;
      default:               return STATES.IDLE;
    }
  }

  /* Called from SNXShadowVoice hook after each voice state transition */
  function _onVoiceStateChange(voiceState) {
    if (_destroyed) return;
    _setState(_mapVoiceState(voiceState));
  }

  /* Register the hook into SNXShadowVoice if available */
  function _hookVoice() {
    var V = global.SNXShadowVoice;
    if (!V) return;
    /* Install our callback — SNXShadowVoice calls this after every setState */
    if (typeof V.onStateChange === 'function') {
      V.onStateChange(_onVoiceStateChange);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TYPED QUESTION INTEGRATION
     SNXShadowAI notifies us via hooks registered in _init().
  ───────────────────────────────────────────────────────────────*/
  function _onAIThinking() {
    if (_destroyed) return;
    /* Only move to thinking if not already in a voice-driven state */
    var cur = _state;
    if (cur === STATES.IDLE || cur === STATES.SUCCESS || cur === STATES.ERROR) {
      _setState(STATES.THINKING);
    }
  }

  function _onAIAnswer() {
    if (_destroyed) return;
    /* Move to success unless voice is currently driving the state */
    var V = global.SNXShadowVoice;
    var voiceState = V ? V.getState() : 'IDLE';
    if (voiceState === 'IDLE' || voiceState === 'MIC_UNSUPPORTED') {
      _setState(STATES.SUCCESS);
    }
    /* If voice is speaking we leave it in SPEAKING — voice onend will return to IDLE */
  }

  /* Register hooks into SNXShadowAI if available */
  function _hookAI() {
    var AI = global.SNXShadowAI;
    if (!AI) return;
    if (typeof AI.onThinking === 'function') AI.onThinking(_onAIThinking);
    if (typeof AI.onAnswer  === 'function') AI.onAnswer(_onAIAnswer);
  }

  /* ─────────────────────────────────────────────────────────────
     PANEL OPEN / CLOSE
  ───────────────────────────────────────────────────────────────*/
  function _onPanelOpen() {
    if (_destroyed) return;
    _setState(STATES.IDLE);
  }

  function _onPanelClose() {
    if (_destroyed) return;
    /* Cancel timers, return to idle */
    if (_successTimer) { clearTimeout(_successTimer); _successTimer = null; }
    _applyState(STATES.IDLE);
  }

  /* ─────────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────────────*/
  function _init() {
    if (_initialized || _destroyed) return;
    _initialized = true;

    /* Apply initial idle state */
    _applyState(STATES.IDLE);

    /* Connect to voice module if already loaded */
    _hookVoice();

    /* Connect to AI module if already loaded */
    _hookAI();

    console.log('[SNXShadowCharacter] Initialized. Build: ' + BUILD_ID);
  }

  /* ─────────────────────────────────────────────────────────────
     DESTROY
  ───────────────────────────────────────────────────────────────*/
  function _destroy() {
    _destroyed = true;

    if (_successTimer) { clearTimeout(_successTimer); _successTimer = null; }

    /* Remove all character state classes from panel */
    var panel = _getPanel();
    if (panel) {
      ALL_CLASSES.forEach(function (c) { panel.classList.remove(c); });
    }

    /* Remove state label element */
    if (global.document) {
      var label = global.document.getElementById('snx-char-state-label');
      if (label && label.parentNode) label.parentNode.removeChild(label);
    }

    /* Reset shared global */
    global.SNXShadowCharacterState = STATES.IDLE;

    /* Remove hooks from voice module */
    var V = global.SNXShadowVoice;
    if (V && typeof V.removeStateChangeListener === 'function') {
      V.removeStateChangeListener(_onVoiceStateChange);
    }

    _state = STATES.IDLE;
    _initialized = false;
    _destroyed   = false; // allow re-init after destroy

    console.log('[SNXShadowCharacter] Destroyed.');
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API  — window.SNXShadowCharacter
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowCharacter = {
    /** Initialize the character controller (idempotent). */
    init: _init,

    /**
     * Set character visual state.
     * @param {string} state — 'idle'|'listening'|'thinking'|'speaking'|'success'|'error'
     */
    setState: _setState,

    /** Returns current character state string. */
    getState: function () { return _state; },

    /** Reset to idle state. */
    reset: function () { _setState(STATES.IDLE); },

    /** Called when AI starts processing a typed question. */
    onAIThinking: _onAIThinking,

    /** Called when AI delivers an answer. */
    onAIAnswer: _onAIAnswer,

    /** Called when voice state changes. */
    onVoiceStateChange: _onVoiceStateChange,

    /** Called when Shadow Reaper panel opens. */
    onPanelOpen: _onPanelOpen,

    /** Called when Shadow Reaper panel closes. */
    onPanelClose: _onPanelClose,

    /** Full teardown. */
    destroy: _destroy,

    /** Allowed state constants. */
    STATES: STATES,

    /** Build identifier. */
    build: BUILD_ID
  };

})(window);
