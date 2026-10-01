/**
 * shadow-reaper/core/conversation-engine.js
 * Shadow Reaper AI — Conversation Engine
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * The single authoritative conversation pipeline.
 * EVERY message — typed or voice — goes through this pipeline:
 *
 *   USER MESSAGE
 *   ↓
 *   Understanding Engine
 *   ↓
 *   Context Engine
 *   ↓
 *   Memory/History retrieval
 *   ↓
 *   Knowledge retrieval
 *   ↓
 *   Response Engine
 *   ↓
 *   ASSISTANT RESPONSE
 *   ↓
 *   Conversation History save
 *   ↓
 *   Adaptive Learning processing
 *
 * No parallel conversation pipelines.
 * No Workers AI calls.
 * No polling or continuous timers.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-CONVERSATION-001';

  /* ─────────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────────────*/
  var _initialized   = false;
  var _busy          = false;
  var _sessionTurns  = [];   // [{role:'user'|'assistant', text:string}]
  var _turnCount     = 0;

  /* Session-level context tracking */
  var _sessionCtx = {
    lastTopic:       null,
    lastFeature:     null,
    lastIntent:      null,
    currentProject:  null,
    recentIds:       [],
    turnCount:       0
  };

  /* Subsystem references (injected by ShadowReaper Core) */
  var _understanding = null;
  var _contextEngine = null;
  var _responseEngine = null;
  var _knowledgeEngine = null;
  var _convHistory   = null;  // storage/conversation-history.js
  var _personalMemory = null; // storage/personal-memory.js
  var _adaptiveLearning = null; // storage/adaptive-learning.js

  var MAX_SESSION_TURNS = 40; // in-memory session cap

  /* ─────────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────────────*/
  function init(subsystems) {
    if (_initialized) return;
    subsystems = subsystems || {};
    _understanding    = subsystems.understanding    || global.SRUnderstanding    || null;
    _contextEngine    = subsystems.context          || global.SRContext           || null;
    _responseEngine   = subsystems.response         || global.SRResponse          || null;
    _knowledgeEngine  = subsystems.knowledge        || global.SRKnowledge         || null;
    _convHistory      = subsystems.convHistory      || global.SRConvHistory       || null;
    _personalMemory   = subsystems.personalMemory   || global.SRPersonalMemory    || null;
    _adaptiveLearning = subsystems.adaptiveLearning || global.SRAdaptiveLearning  || null;

    _sessionTurns = [];
    _turnCount    = 0;
    _resetSessionCtx();
    _initialized  = true;
  }

  function _resetSessionCtx() {
    _sessionCtx = {
      lastTopic:      null,
      lastFeature:    null,
      lastIntent:     null,
      currentProject: null,
      recentIds:      [],
      turnCount:      0
    };
  }

  /* ─────────────────────────────────────────────────────────────
     PROCESS — main pipeline
     Returns Promise resolving to { text, signal, navigateTo }
  ───────────────────────────────────────────────────────────────*/
  function process(userMessage, options) {
    return new Promise(function (resolve, reject) {
      if (!_initialized) {
        resolve({ text: "Shadow Reaper is initializing — please try again in a moment.", signal: null, navigateTo: null });
        return;
      }

      if (_busy) {
        resolve({ text: "I'm still thinking — one moment please.", signal: null, navigateTo: null });
        return;
      }

      if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
        resolve({ text: "I didn't catch that. Could you try again?", signal: null, navigateTo: null });
        return;
      }

      _busy = true;
      options = options || {};

      // ── Step 1: Understanding ──
      var understanding = _understanding
        ? _understanding.understand(userMessage, _sessionCtx)
        : _fallbackUnderstand(userMessage);

      // ── DIAGNOSTIC: log pipeline entry ──
      console.log('[SRConversation] ACTIVE BRAIN: ShadowReaper unified core');
      console.log('[SRConversation] Intent: ' + understanding.intent +
        ' | Feature: ' + (understanding.feature || 'none') +
        ' | Topic: ' + (understanding.topic || 'none') +
        ' | GeneralChat: ' + understanding.isGeneralChat);

      // ── Step 2: Update session context from understanding ──
      if (understanding.feature) _sessionCtx.lastFeature = understanding.feature;
      if (understanding.topic)   _sessionCtx.lastTopic   = understanding.topic;
      if (understanding.intent)  _sessionCtx.lastIntent  = understanding.intent;

      // Track project name from explicit statements
      // Patterns: "my project is called Blue Wolf", "my project is Blue Wolf",
      //           "the project is called Blue Wolf", "it's called Blue Wolf"
      var projectMatch = userMessage.match(
        /\b(?:my project(?:'?s? name)?|the project|the app)\s+(?:is\s+)?(?:called|named)\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
      ) || userMessage.match(
        /\b(?:my project|project name)\s+is\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
      ) || userMessage.match(
        /\b(?:it'?s?|this) (?:is )?called\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
      );
      if (projectMatch) {
        _sessionCtx.currentProject = projectMatch[1].trim();
      }

      _sessionCtx.turnCount++;

      // ── Step 3: Load context from storage subsystems ──
      _loadStorageContext(understanding, function (storageCtx) {
        // ── Step 4: Load knowledge ──
        _loadKnowledge(understanding, function (knowledgeSnippets) {
          // ── Step 5: Assemble context ──
          var fullContext = _contextEngine
            ? _contextEngine.assemble({
                understanding:     understanding,
                sessionTurns:      _sessionTurns.slice(-20),
                historyTurns:      storageCtx.historyTurns,
                memories:          storageCtx.memories,
                learnedItems:      storageCtx.learnedItems,
                knowledgeSnippets: knowledgeSnippets,
                currentProject:    _sessionCtx.currentProject,
                currentTopic:      _sessionCtx.lastTopic,
                currentFeature:    _sessionCtx.lastFeature
              })
            : _fallbackContext(understanding, storageCtx, knowledgeSnippets);

          // ── Step 6: Compose response ──
          var result = { text: null, signal: null, navigateTo: null };

          // Handle special signals first
          if (fullContext.isMemoryCmd && _personalMemory) {
            _handleMemoryCommand(understanding.corrected || userMessage, fullContext, function (memResult) {
              var responseText = (_responseEngine && _responseEngine.composeMemoryResponse)
                ? _responseEngine.composeMemoryResponse(memResult)
                : (memResult.text || "Memory operation completed.");
              _finalize(userMessage, responseText, null, null, resolve);
            });
            return;
          }

          if (fullContext.isHistoryCmd && _convHistory) {
            _handleHistoryCommand(understanding.corrected || userMessage, fullContext, function (histResult) {
              var responseText = (_responseEngine && _responseEngine.composeHistoryResponse)
                ? _responseEngine.composeHistoryResponse(histResult)
                : (histResult.text || "History operation completed.");
              _finalize(userMessage, responseText, null, null, resolve);
            });
            return;
          }

          if (fullContext.isAdaptiveCmd && _adaptiveLearning) {
            _handleAdaptiveCommand(understanding.corrected || userMessage, fullContext, function (adaptResult) {
              var responseText = (_responseEngine && _responseEngine.composeAdaptiveResponse)
                ? _responseEngine.composeAdaptiveResponse(adaptResult)
                : (adaptResult.text || "Adaptive operation completed.");
              _finalize(userMessage, responseText, null, null, resolve);
            });
            return;
          }

          // Normal compose
          if (_responseEngine) {
            result = _responseEngine.compose(fullContext);
          } else {
            result = { text: _fallbackResponse(fullContext), signal: null, navigateTo: null };
          }

          console.log('[SRConversation] Response Engine → routing to _finalize()');
          _finalize(userMessage, result.text, result.signal, result.navigateTo, resolve);
        });
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────
     _finalize — save turn, update adaptive, return
  ───────────────────────────────────────────────────────────────*/
  function _finalize(userMessage, responseText, signal, navigateTo, resolve) {
    var finalText = responseText || "I'm not sure how to respond to that. Could you try rephrasing?";
    var finalSignal = signal || null;
    console.log('[SRConversation] _finalize() → History save | Adaptive processing | WORKERS AI CALLS: 0');

    // Save session turns
    _sessionTurns.push({ role: 'user',      text: userMessage });
    _sessionTurns.push({ role: 'assistant', text: finalText });
    if (_sessionTurns.length > MAX_SESSION_TURNS * 2) {
      _sessionTurns = _sessionTurns.slice(-MAX_SESSION_TURNS * 2);
    }
    _turnCount++;

    // Persist to history (async, non-blocking)
    if (_convHistory && typeof _convHistory.saveTurn === 'function') {
      _convHistory.saveTurn('user', userMessage);
      _convHistory.saveTurn('assistant', finalText);
    }

    // Adaptive learning (fire-and-forget)
    if (_adaptiveLearning && typeof _adaptiveLearning.processTurn === 'function') {
      _adaptiveLearning.processTurn(userMessage, _convHistory && _convHistory.getCurrentConvId
        ? _convHistory.getCurrentConvId() : null);
    }

    _busy = false;

    resolve({ text: finalText, signal: finalSignal, navigateTo: navigateTo });
  }

  /* ─────────────────────────────────────────────────────────────
     _loadStorageContext — async, bounded retrieval from storage subsystems
  ───────────────────────────────────────────────────────────────*/
  function _loadStorageContext(understanding, callback) {
    var historyTurns = [];
    var memories = [];
    var learnedItems = [];

    var pending = 3;
    function done() { if (--pending === 0) callback({ historyTurns: historyTurns, memories: memories, learnedItems: learnedItems }); }

    // Load conversation history — on continuity intent OR when history query detected
    var needsHistory = understanding.isContinuity ||
      /what (were we|did we|have we|project|were you) (talk|say|discuss|work|do|tell)/i.test(understanding.corrected || '');
    if (_convHistory && typeof _convHistory.loadRecentContext === 'function' && needsHistory) {
      _convHistory.loadRecentContext(function (turns) {
        historyTurns = turns || [];
        done();
      });
    } else {
      done();
    }

    // Load personal memories
    if (_personalMemory && typeof _personalMemory.getRelevantSnippets === 'function') {
      _personalMemory.getRelevantSnippets(understanding.corrected || '', function (mems) {
        memories = mems || [];
        done();
      });
    } else {
      done();
    }

    // Load adaptive context
    if (_adaptiveLearning && typeof _adaptiveLearning.retrieveRelevant === 'function') {
      var items = _adaptiveLearning.retrieveRelevant(understanding.corrected || '');
      learnedItems = items || [];
      done();
    } else {
      done();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     _loadKnowledge — retrieve bounded knowledge snippets
  ───────────────────────────────────────────────────────────────*/
  function _loadKnowledge(understanding, callback) {
    if (!_knowledgeEngine) { callback([]); return; }

    var text = understanding.corrected || understanding.raw || '';
    var ctx  = { feature: understanding.feature, topic: understanding.topic, intent: understanding.intent };

    // Try full local answer first
    if (typeof _knowledgeEngine.answerLocally === 'function') {
      var localAnswer = _knowledgeEngine.answerLocally(text, ctx);
      if (localAnswer && localAnswer.text) {
        callback([{ localAnswer: localAnswer.text, title: 'Local Answer', summary: '' }]);
        return;
      }
    }

    // Fall back to snippets
    if (typeof _knowledgeEngine.retrieveKnowledge === 'function') {
      var results = _knowledgeEngine.retrieveKnowledge(text, ctx);
      callback(results ? results.slice(0, 3) : []);
      return;
    }

    callback([]);
  }

  /* ─────────────────────────────────────────────────────────────
     SPECIAL COMMAND HANDLERS
  ───────────────────────────────────────────────────────────────*/
  function _handleMemoryCommand(text, ctx, callback) {
    if (!_personalMemory) { callback({ operation: 'SAVE', success: false }); return; }

    var intent = typeof _personalMemory.detectIntent === 'function'
      ? _personalMemory.detectIntent(text) : null;

    if (!intent) { callback({ operation: 'SAVE', success: false }); return; }

    switch (intent) {
      case 'MEMORY_SAVE':
        _personalMemory.save(text, function (result) { callback(Object.assign({ operation: 'SAVE' }, result)); });
        break;
      case 'MEMORY_RECALL':
        _personalMemory.recall(text, function (result) { callback(Object.assign({ operation: 'RECALL' }, result)); });
        break;
      case 'MEMORY_LIST':
        _personalMemory.list(function (result) { callback(Object.assign({ operation: 'LIST' }, result)); });
        break;
      case 'MEMORY_FORGET':
        _personalMemory.forget(text, function (result) { callback(Object.assign({ operation: 'FORGET' }, result)); });
        break;
      case 'MEMORY_FORGET_ALL':
        _personalMemory.clearAll(false, function (result) { callback(Object.assign({ operation: 'FORGET_ALL', pending: true }, result)); });
        break;
      default:
        callback({ operation: intent, success: false });
    }
  }

  function _handleHistoryCommand(text, ctx, callback) {
    if (!_convHistory) { callback({ operation: 'TOGGLE', success: false }); return; }

    var lower = text.toLowerCase();
    if (/turn off|disable/.test(lower)) {
      _convHistory.setEnabled(false);
      callback({ operation: 'TOGGLE_OFF', success: true });
    } else if (/turn on|enable/.test(lower)) {
      _convHistory.setEnabled(true);
      callback({ operation: 'TOGGLE_ON', success: true });
    } else if (/clear|delete/.test(lower)) {
      _convHistory.clearHistory(function (res) { callback({ operation: 'CLEAR', success: res && res.success }); });
    } else if (/new conversation|start fresh|new chat/.test(lower)) {
      _convHistory.newConversation();
      callback({ operation: 'NEW', success: true });
    } else {
      callback({ operation: 'STATUS', success: true, enabled: _convHistory.isEnabled() });
    }
  }

  function _handleAdaptiveCommand(text, ctx, callback) {
    if (!_adaptiveLearning) { callback({ operation: 'LIST', success: false, items: [] }); return; }

    var intent = typeof _adaptiveLearning.detectIntent === 'function'
      ? _adaptiveLearning.detectIntent(text) : null;

    if (intent === 'ADAPTIVE_LIST') {
      callback({ operation: 'LIST', success: true, items: _adaptiveLearning.listAll() || [] });
    } else if (intent === 'ADAPTIVE_CLEAR') {
      _adaptiveLearning.clearAll(function (res) { callback({ operation: 'CLEAR', success: !!(res && res.success) }); });
    } else {
      callback({ operation: 'LIST', success: true, items: _adaptiveLearning.listAll() || [] });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     FALLBACKS (when subsystems not loaded)
  ───────────────────────────────────────────────────────────────*/
  function _fallbackUnderstand(text) {
    return { intent: 'UNKNOWN', topic: null, feature: null, needsContext: false,
             isShort: false, corrected: text, raw: text };
  }

  function _fallbackContext(understanding, storageCtx, knowledgeSnippets) {
    return {
      userMessage: understanding.corrected || understanding.raw || '',
      intent: understanding.intent || 'UNKNOWN',
      feature: understanding.feature || null,
      topic: understanding.topic || null,
      project: _sessionCtx.currentProject,
      needsContext: !!understanding.needsContext,
      isShort: !!understanding.isShort,
      sessionTurns: _sessionTurns.slice(-20),
      historyTurns: storageCtx.historyTurns || [],
      memories: storageCtx.memories || [],
      learnedItems: storageCtx.learnedItems || [],
      knowledgeSnippets: knowledgeSnippets || [],
      contextSummary: '',
      hasHistory: (storageCtx.historyTurns || []).length > 0,
      hasMemories: (storageCtx.memories || []).length > 0,
      hasLearned: (storageCtx.learnedItems || []).length > 0,
      hasKnowledge: (knowledgeSnippets || []).length > 0,
      isGreeting: false, isMemoryCmd: false, isHistoryCmd: false,
      isAdaptiveCmd: false, isContinuity: false, isCorrection: false,
      isTroubleshoot: false, isNavigation: false, isQuestion: false,
      isGeneralChat: true
    };
  }

  function _fallbackResponse(ctx) {
    return "I'm here! What would you like to know about Shadow Nexus Social?";
  }

  /* ─────────────────────────────────────────────────────────────
     newConversation — start fresh thread
  ───────────────────────────────────────────────────────────────*/
  function newConversation() {
    _sessionTurns = [];
    _turnCount    = 0;
    _resetSessionCtx();
    if (_convHistory && typeof _convHistory.newConversation === 'function') {
      _convHistory.newConversation();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     destroy
  ───────────────────────────────────────────────────────────────*/
  function destroy() {
    _sessionTurns = [];
    _turnCount    = 0;
    _busy         = false;
    _initialized  = false;
    _resetSessionCtx();
    _understanding    = null;
    _contextEngine    = null;
    _responseEngine   = null;
    _knowledgeEngine  = null;
    _convHistory      = null;
    _personalMemory   = null;
    _adaptiveLearning = null;
  }

  /* ─────────────────────────────────────────────────────────────
     STATUS
  ───────────────────────────────────────────────────────────────*/
  function getStatus() {
    return {
      initialized:       _initialized,
      busy:              _busy,
      sessionTurnCount:  _turnCount,
      sessionTurns:      _sessionTurns.length,
      sessionCtx:        Object.assign({}, _sessionCtx),
      subsystems: {
        understanding:    !!_understanding,
        context:          !!_contextEngine,
        response:         !!_responseEngine,
        knowledge:        !!_knowledgeEngine,
        convHistory:      !!_convHistory,
        personalMemory:   !!_personalMemory,
        adaptiveLearning: !!_adaptiveLearning
      }
    };
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRConversation = {
    init:            init,
    process:         process,
    newConversation: newConversation,
    getStatus:       getStatus,
    destroy:         destroy,
    getSessionTurns: function () { return _sessionTurns.slice(); },
    build:           BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
