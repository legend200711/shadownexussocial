/**
 * shadow-reaper/ui/character-interface.js
 * Shadow Reaper AI — Character Interface Contract
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * STAGE 1: CONTRACT ONLY. No visual reconstruction. No new RAF loops.
 *
 * This defines the interface that the Character subsystem must conform to
 * when connected to the unified ShadowReaper Core.
 *
 * The character system (Grim Reaper visuals) receives state signals
 * from the Core and applies them visually. It NEVER drives conversation.
 *
 * In Stage 2+: this file will connect to snx-shadow-character.js,
 * which applies CSS class states to the existing Grim Reaper panel
 * using the existing RAF loop (no new loops created).
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-CHARACTER-CONTRACT-001';

  /* ─────────────────────────────────────────────────────────────
     CHARACTER STATES — contract definition
  ───────────────────────────────────────────────────────────────*/
  var STATES = {
    IDLE:      'idle',      // default state — character at rest
    LISTENING: 'listening', // voice input active
    THINKING:  'thinking',  // AI pipeline processing
    SPEAKING:  'speaking',  // TTS output active
    SUCCESS:   'success',   // brief success flash (1.4s then idle)
    ERROR:     'error'      // error state
  };

  /* ─────────────────────────────────────────────────────────────
     CONTRACT — required methods a Character implementation must provide
  ───────────────────────────────────────────────────────────────*/
  var CONTRACT = {
    /**
     * init() — initialize the character subsystem.
     * Must be idempotent. Must NOT create new RAF loops.
     * Must NOT restart or conflict with grim-reaper-character-widget.js.
     */
    init: null,

    /**
     * setState(state) — set the visual state.
     * state: one of STATES values.
     * Applies CSS class snx-char-{state} to #grim-panel.
     * Respects prefers-reduced-motion and LITE/MINIMAL perf modes.
     */
    setState: null,

    /**
     * getState() → STATES string — current state.
     */
    getState: null,

    /**
     * reset() — return to IDLE state.
     */
    reset: null,

    /**
     * onAIThinking() — signal that AI pipeline started processing.
     * Sets state to THINKING.
     */
    onAIThinking: null,

    /**
     * onAIAnswer() — signal that AI response is ready.
     * Sets state to SUCCESS briefly, then returns to IDLE.
     */
    onAIAnswer: null,

    /**
     * onVoiceStateChange(voiceState) — receive voice state changes.
     * Maps voice states to character states:
     *   IDLE      → idle
     *   LISTENING → listening
     *   PROCESSING → thinking
     *   SPEAKING  → speaking
     *   MIC_BLOCKED / MIC_ERROR → error
     *   MIC_UNSUPPORTED → idle
     */
    onVoiceStateChange: null,

    /**
     * onPanelOpen() — panel opened.
     */
    onPanelOpen: null,

    /**
     * onPanelClose() — panel closed.
     */
    onPanelClose: null,

    /**
     * destroy() — full teardown.
     */
    destroy: null
  };

  /* ─────────────────────────────────────────────────────────────
     STUB IMPLEMENTATION
     Minimal no-op implementation used during Stage 1.
     Replaced by snx-shadow-character.js binding in Stage 2+.
  ───────────────────────────────────────────────────────────────*/
  var _currentState = STATES.IDLE;
  var _successTimer = null;

  var _stub = {
    init: function () { /* no-op in Stage 1 */ },

    setState: function (state) {
      if (!STATES[state.toUpperCase ? state.toUpperCase() : state] &&
          Object.values(STATES).indexOf(state) === -1) return;
      _currentState = state;
      // No-op visually in Stage 1 — contract only
    },

    getState: function () { return _currentState; },

    reset: function () { _currentState = STATES.IDLE; },

    onAIThinking: function () { _currentState = STATES.THINKING; },

    onAIAnswer: function () {
      _currentState = STATES.SUCCESS;
      if (_successTimer) clearTimeout(_successTimer);
      _successTimer = setTimeout(function () {
        _currentState = STATES.IDLE;
        _successTimer = null;
      }, 1400);
    },

    onVoiceStateChange: function (voiceState) {
      var voiceToChar = {
        'IDLE':            STATES.IDLE,
        'LISTENING':       STATES.LISTENING,
        'PROCESSING':      STATES.THINKING,
        'SPEAKING':        STATES.SPEAKING,
        'MIC_BLOCKED':     STATES.ERROR,
        'MIC_ERROR':       STATES.ERROR,
        'MIC_UNSUPPORTED': STATES.IDLE
      };
      if (voiceToChar[voiceState]) _currentState = voiceToChar[voiceState];
    },

    onPanelOpen: function () { _currentState = STATES.IDLE; },

    onPanelClose: function () {
      _currentState = STATES.IDLE;
      if (_successTimer) { clearTimeout(_successTimer); _successTimer = null; }
    },

    destroy: function () {
      _currentState = STATES.IDLE;
      if (_successTimer) { clearTimeout(_successTimer); _successTimer = null; }
    }
  };

  /* ─────────────────────────────────────────────────────────────
     connectToExisting() — binds to snx-shadow-character.js if loaded
  ───────────────────────────────────────────────────────────────*/
  function connectToExisting() {
    if (global.SNXShadowCharacter) {
      return global.SNXShadowCharacter;
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     getActive() — returns the active implementation
  ───────────────────────────────────────────────────────────────*/
  function getActive() {
    return connectToExisting() || _stub;
  }

  /* ─────────────────────────────────────────────────────────────
     Integration note for Stage 2+:
     Connect by replacing calls in shadow-reaper.js Core from:
       _character.stub.onAIThinking()
     to:
       SNXShadowCharacter.onAIThinking()
     
     No new RAF loops. No visual reconstruction in Stage 1.
  ───────────────────────────────────────────────────────────────*/

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRCharacterInterface = {
    STATES:            STATES,
    CONTRACT:          CONTRACT,
    getActive:         getActive,
    connectToExisting: connectToExisting,
    stub:              _stub,
    build:             BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
