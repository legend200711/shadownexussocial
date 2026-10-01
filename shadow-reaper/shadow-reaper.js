/**
 * shadow-reaper/shadow-reaper.js
 * Shadow Reaper AI — Unified Core
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Exposes: window.ShadowReaper
 *
 * This is the ONE authoritative entry point for the entire
 * Shadow Reaper AI system.
 *
 * Architecture:
 *
 *   Shadow Reaper Core  (this file)
 *         │
 *         ├── Understanding Engine  (core/understanding-engine.js)
 *         ├── Conversation Engine   (core/conversation-engine.js)
 *         ├── Context Engine        (core/context-engine.js)
 *         ├── Response Engine       (core/response-engine.js)
 *         ├── Knowledge Engine      (data/knowledge-engine.js)
 *         ├── Creator Knowledge     (data/creator-knowledge.js)
 *         ├── Conversation History  (storage/conversation-history.js)
 *         ├── Personal Memory       (storage/personal-memory.js)
 *         ├── Adaptive Learning     (storage/adaptive-learning.js)
 *         ├── Voice Interface       (ui/voice-interface.js)   [Stage 1: contract]
 *         └── Character Interface   (ui/character-interface.js) [Stage 1: contract]
 *
 * Public API:
 *
 *   ShadowReaper.init()
 *   ShadowReaper.open()
 *   ShadowReaper.close()
 *   ShadowReaper.ask(message) → Promise<{ text, signal, navigateTo }>
 *   ShadowReaper.newConversation()
 *   ShadowReaper.getStatus()
 *   ShadowReaper.destroy()
 *
 * RULES:
 *   - Workers AI calls = 0 (normal conversation is entirely local)
 *   - No new Firebase projects (reuses existing SNS project)
 *   - No polling, no RAF loops, no continuous timers
 *   - No database reads on general SNS startup
 *   - Initializes only when needed
 *   - Does NOT replace production Shadow Reaper during Stage 1
 *   - Does NOT modify Live, Radio, TV, Feed, Inbox, Notifications,
 *     Auth, R2, WebRTC, TURN, Mediasoup, or Broadcast Engine
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-CORE-001';

  /* ─────────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────────────*/
  var _initialized  = false;
  var _open         = false;
  var _destroyed    = false;

  /* Subsystem references */
  var _understanding   = null;
  var _context         = null;
  var _response        = null;
  var _conversation    = null;
  var _knowledge       = null;
  var _creatorKnowledge = null;
  var _convHistory     = null;
  var _personalMemory  = null;
  var _adaptive        = null;
  var _voice           = null;
  var _character       = null;

  /* ─────────────────────────────────────────────────────────────
     _loadSubsystems
     Resolves references to all subsystem modules.
     Tolerates partial loading — subsystems that are not yet loaded
     simply won't be available (graceful degradation).
  ───────────────────────────────────────────────────────────────*/
  function _loadSubsystems() {
    _understanding    = global.SRUnderstanding     || null;
    _context          = global.SRContext            || null;
    _response         = global.SRResponse           || null;
    _conversation     = global.SRConversation       || null;
    _knowledge        = global.SRKnowledge          || null;
    _creatorKnowledge = global.SRCreatorKnowledge   || null;
    _convHistory      = global.SRConvHistory        || null;
    _personalMemory   = global.SRPersonalMemory     || null;
    _adaptive         = global.SRAdaptiveLearning   || null;
    _voice            = global.SRVoiceInterface     || null;
    _character        = global.SRCharacterInterface || null;
  }

  /* ─────────────────────────────────────────────────────────────
     init()
     Initializes the Core and all subsystems.
     Idempotent — safe to call multiple times.
  ───────────────────────────────────────────────────────────────*/
  function init() {
    if (_initialized) return;
    if (_destroyed) {
      console.warn('[ShadowReaper] Cannot re-init after destroy(). Create a new instance.');
      return;
    }

    _loadSubsystems();

    // Initialize conversation engine with all subsystem references
    if (_conversation && typeof _conversation.init === 'function') {
      _conversation.init({
        understanding:    _understanding,
        context:          _context,
        response:         _response,
        knowledge:        _knowledge,
        convHistory:      _convHistory,
        personalMemory:   _personalMemory,
        adaptiveLearning: _adaptive
      });
    }

    // Initialize storage subsystems
    if (_convHistory    && typeof _convHistory.init    === 'function') _convHistory.init();
    if (_personalMemory && typeof _personalMemory.init === 'function') _personalMemory.init();
    if (_adaptive       && typeof _adaptive.init       === 'function') _adaptive.init();

    // Initialize UI contracts (no-ops in Stage 1)
    if (_voice     && _voice.getActive)     _voice.getActive().init();
    if (_character && _character.getActive) _character.getActive().init();

    _initialized = true;
  }

  /* ─────────────────────────────────────────────────────────────
     open()
     Opens the Shadow Reaper panel.
     In Stage 1: logical open only (no UI manipulation yet).
     In Stage 2+: will call into the existing Grim Reaper panel.
  ───────────────────────────────────────────────────────────────*/
  function open() {
    if (!_initialized) init();
    _open = true;
    if (_character && _character.getActive) {
      _character.getActive().onPanelOpen();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     close()
     Closes the Shadow Reaper panel.
  ───────────────────────────────────────────────────────────────*/
  function close() {
    _open = false;
    if (_character && _character.getActive) {
      _character.getActive().onPanelClose();
    }
    if (_voice && _voice.getActive) {
      _voice.getActive().onPanelClose();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     ask(message) → Promise<{ text, signal, navigateTo }>
     THE single entry point for all user messages.
     Typed input, voice transcript, or programmatic calls
     MUST all go through this function.
     Workers AI calls = 0.
  ───────────────────────────────────────────────────────────────*/
  function ask(message) {
    if (_destroyed) {
      return Promise.resolve({ text: "Shadow Reaper has been destroyed.", signal: null, navigateTo: null });
    }

    if (!_initialized) init();

    // Signal thinking state to character
    if (_character && _character.getActive) {
      _character.getActive().onAIThinking();
    }

    // Route through conversation engine
    var engine = _conversation;
    var promise;

    if (engine && typeof engine.process === 'function') {
      promise = engine.process(message);
    } else {
      // Minimal fallback when conversation engine not loaded
      promise = Promise.resolve({
        text: _minimalFallback(message),
        signal: null,
        navigateTo: null
      });
    }

    return promise.then(function (result) {
      // Signal answer state to character
      if (_character && _character.getActive) {
        _character.getActive().onAIAnswer();
      }

      // Speak response if voice output is enabled
      if (_voice && _voice.getActive) {
        var activeVoice = _voice.getActive();
        if (activeVoice.isVoiceEnabled() && typeof activeVoice.speak === 'function') {
          activeVoice.speak(result.text);
        }
      }

      return result;
    });
  }

  /* ─────────────────────────────────────────────────────────────
     _minimalFallback — used only if conversation engine not loaded
  ───────────────────────────────────────────────────────────────*/
  function _minimalFallback(message) {
    if (!message) return "I'm ready. What would you like to know?";
    var lower = message.toLowerCase();
    if (/^(hi|hello|hey)/.test(lower)) {
      return "Hey! I'm Shadow Reaper. How can I help you with Shadow Nexus Social today?";
    }
    return "I'm here — what would you like to know about Shadow Nexus Social?";
  }

  /* ─────────────────────────────────────────────────────────────
     newConversation()
     Starts a fresh conversation thread without deleting previous ones.
  ───────────────────────────────────────────────────────────────*/
  function newConversation() {
    if (!_initialized) init();
    if (_conversation && typeof _conversation.newConversation === 'function') {
      _conversation.newConversation();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     getStatus() → status object (safe — no user data, no tokens)
  ───────────────────────────────────────────────────────────────*/
  function getStatus() {
    var convStatus = _conversation && typeof _conversation.getStatus === 'function'
      ? _conversation.getStatus() : {};

    return {
      build:         BUILD_ID,
      initialized:   _initialized,
      open:          _open,
      destroyed:     _destroyed,
      conversation:  convStatus,
      subsystems: {
        understanding:    !!_understanding,
        context:          !!_context,
        response:         !!_response,
        conversation:     !!_conversation,
        knowledge:        !!_knowledge,
        creatorKnowledge: !!_creatorKnowledge,
        convHistory:      !!(_convHistory && _convHistory.isAvailable ? _convHistory.isAvailable() : _convHistory),
        personalMemory:   !!(_personalMemory && _personalMemory.isAvailable ? _personalMemory.isAvailable() : _personalMemory),
        adaptive:         !!(_adaptive && _adaptive.isAvailable ? _adaptive.isAvailable() : _adaptive),
        voice:            !!_voice,
        character:        !!_character
      },
      workersAICalls: 0  // Always 0 — explicitly tracked
    };
  }

  /* ─────────────────────────────────────────────────────────────
     destroy()
     Full teardown. Does NOT destroy existing SNXShadowAI production system.
  ───────────────────────────────────────────────────────────────*/
  function destroy() {
    _open = false;

    if (_conversation    && typeof _conversation.destroy    === 'function') _conversation.destroy();
    if (_convHistory     && typeof _convHistory.destroy     === 'function') _convHistory.destroy();
    if (_personalMemory  && typeof _personalMemory.destroy  === 'function') _personalMemory.destroy();
    if (_adaptive        && typeof _adaptive.destroy        === 'function') _adaptive.destroy();
    if (_voice           && _voice.getActive) _voice.getActive().destroy();
    if (_character       && _character.getActive) _character.getActive().destroy();

    _initialized      = false;
    _destroyed        = true;
    _understanding    = null;
    _context          = null;
    _response         = null;
    _conversation     = null;
    _knowledge        = null;
    _creatorKnowledge = null;
    _convHistory      = null;
    _personalMemory   = null;
    _adaptive         = null;
    _voice            = null;
    _character        = null;
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.ShadowReaper
     The ONE website-facing entry point.
  ───────────────────────────────────────────────────────────────*/
  global.ShadowReaper = {
    init:            init,
    open:            open,
    close:           close,
    ask:             ask,
    newConversation: newConversation,
    getStatus:       getStatus,
    destroy:         destroy,
    build:           BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
