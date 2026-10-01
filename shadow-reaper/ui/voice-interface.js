/**
 * shadow-reaper/ui/voice-interface.js
 * Shadow Reaper AI — Voice Interface Contract
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * STAGE 1: CONTRACT ONLY. No voice reconstruction.
 *
 * This defines the interface that the Voice subsystem must conform to
 * when connected to the unified ShadowReaper Core.
 *
 * ARCHITECTURE RULE: Voice transcript ALWAYS enters via ShadowReaper.ask().
 * There must NEVER be a separate voice brain or parallel conversation path.
 *
 *   Voice input transcript
 *       ↓
 *   ShadowReaper.ask(transcript)
 *       ↓
 *   Same conversation pipeline as typed input
 *
 * Voice output (TTS) receives the final response text from the pipeline.
 *
 * In Stage 2+: this file will connect to snx-shadow-voice.js,
 * which handles SpeechRecognition and speechSynthesis (browser APIs only —
 * no paid STT/TTS, no audio stored, no audio recorded).
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-VOICE-CONTRACT-001';

  /* ─────────────────────────────────────────────────────────────
     VOICE STATES — contract definition
  ───────────────────────────────────────────────────────────────*/
  var STATE = {
    IDLE:             'IDLE',
    LISTENING:        'LISTENING',
    PROCESSING:       'PROCESSING',
    SPEAKING:         'SPEAKING',
    MIC_BLOCKED:      'MIC_BLOCKED',
    MIC_UNSUPPORTED:  'MIC_UNSUPPORTED',
    MIC_ERROR:        'MIC_ERROR'
  };

  /* ─────────────────────────────────────────────────────────────
     CONTRACT — required methods that a Voice implementation must provide
  ───────────────────────────────────────────────────────────────*/
  var CONTRACT = {
    /**
     * init() — initialize voice subsystem.
     * Must be idempotent (safe to call multiple times).
     */
    init: null,

    /**
     * startListening() — begin microphone capture.
     * MUST require explicit user gesture. Never auto-activate.
     * Transcript is delivered via the onTranscript callback.
     */
    startListening: null,

    /**
     * stopListening() — stop microphone capture.
     */
    stopListening: null,

    /**
     * speak(text) — read aloud the given text using TTS.
     * Uses browser speechSynthesis only. No paid API.
     * Voice output is OFF by default.
     */
    speak: null,

    /**
     * stopSpeaking() — interrupt current TTS output.
     */
    stopSpeaking: null,

    /**
     * isVoiceEnabled() → boolean — is TTS (output) enabled?
     */
    isVoiceEnabled: null,

    /**
     * setVoiceEnabled(bool) — enable/disable TTS output.
     * Persisted to localStorage.
     */
    setVoiceEnabled: null,

    /**
     * getState() → STATE string
     */
    getState: null,

    /**
     * onTranscript(callback) — register handler for voice transcript.
     * callback(transcriptText: string) → void
     * REQUIRED: callback must call ShadowReaper.ask(transcriptText)
     * to enter the unified conversation pipeline.
     */
    onTranscript: null,

    /**
     * onStateChange(callback) — register handler for state changes.
     * callback(newState: STATE) → void
     */
    onStateChange: null,

    /**
     * inputSupported() → boolean — is speech recognition available?
     */
    inputSupported: null,

    /**
     * outputSupported() → boolean — is speech synthesis available?
     */
    outputSupported: null,

    /**
     * onPanelClose() — cleanup when the AI panel closes.
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
     Replaced by snx-shadow-voice.js binding in Stage 2+.
  ───────────────────────────────────────────────────────────────*/
  var _state = STATE.IDLE;
  var _stateListeners = [];
  var _transcriptListeners = [];
  var _voiceEnabled = false;

  var _stub = {
    init: function () { /* no-op in Stage 1 */ },
    startListening: function () { console.warn('[SRVoice] Voice not connected yet — Stage 1 contract only.'); },
    stopListening: function () { /* no-op */ },
    speak: function (text) { console.log('[SRVoice] speak() called (no-op, Stage 1):', text ? text.slice(0, 60) : ''); },
    stopSpeaking: function () { /* no-op */ },
    isVoiceEnabled: function () { return _voiceEnabled; },
    setVoiceEnabled: function (bool) { _voiceEnabled = !!bool; },
    getState: function () { return _state; },
    onTranscript: function (cb) { if (typeof cb === 'function') _transcriptListeners.push(cb); },
    onStateChange: function (cb) { if (typeof cb === 'function') _stateListeners.push(cb); },
    removeStateChangeListener: function (cb) { _stateListeners = _stateListeners.filter(function (l) { return l !== cb; }); },
    inputSupported: function () { return !!(global.SpeechRecognition || global.webkitSpeechRecognition); },
    outputSupported: function () { return !!(global.speechSynthesis); },
    onPanelClose: function () { _state = STATE.IDLE; },
    destroy: function () { _state = STATE.IDLE; _stateListeners = []; _transcriptListeners = []; }
  };

  /* ─────────────────────────────────────────────────────────────
     connectToExisting() — binds to snx-shadow-voice.js if loaded
     Delegates to the existing, working voice implementation.
  ───────────────────────────────────────────────────────────────*/
  function connectToExisting() {
    if (global.SNXShadowVoice) {
      return global.SNXShadowVoice;
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
     When connecting the voice system to the Core, the only required
     change is to route the transcript through ShadowReaper.ask():
     
       SNXShadowVoice.onTranscript(function(text) {
         window.ShadowReaper.ask(text);
       });
     
     No other voice logic should change.
  ───────────────────────────────────────────────────────────────*/

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRVoiceInterface = {
    STATE:           STATE,
    CONTRACT:        CONTRACT,
    getActive:       getActive,
    connectToExisting: connectToExisting,
    stub:            _stub,
    build:           BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
