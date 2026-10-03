/**
 * shadow-reaper-v2/core/persistence-bridge.js
 * Shadow Reaper V2 — Persistence Bridge
 *
 * Build: SR-V2-BRAIN-1
 *
 * Exposes: window.SRPersistence
 *
 * Purpose:
 *   Thin wiring layer that connects the four persistence modules into the V2
 *   pipeline. This file does NOT modify those modules — it only delegates to
 *   their public APIs.
 *
 * Context priority order (highest → lowest):
 *   1. Current user message (always wins)
 *   2. Explicit user correction (USER_CORRECTION intent in V2 context engine)
 *   3. Current session context (SRContext — already handled in V2 pipeline)
 *   4. Relevant Conversation History  ← injected from SNXShadowConvHistory
 *   5. Brain concepts (SRAdaptiveBrain — concept graph, relationships)
 *   6. Relevant SNXShadowAdaptive (legacy adaptive snippets)
 *   7. Relevant Personal Memory (explicit only)
 *   8. General V2 conversation logic (SRResponse)
 *
 * Rules:
 *   • 0 Workers AI calls.  0 env.AI.run() calls.  0 polling.
 *   • Only initializes when V2 is opened/initialized — NOT on SNS startup.
 *   • Guest users get no persistent context (modules handle this internally).
 *   • History ON/OFF and Adaptive ON/OFF are delegated to the modules.
 *   • SNXShadowMemory is always explicit-only (user must say "remember …").
 *   • Sensitive data filtering is handled inside each module.
 *
 * Module dependency (must load before this file):
 *   window.SNXShadowConvHistory   — snx-shadow-conv-history.js
 *   window.SNXShadowMemory        — snx-shadow-memory.js
 *   window.SNXShadowAdaptive      — snx-shadow-adaptive.js
 *   window.SRAdaptiveBrain        — core/adaptive-brain.js
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     MODULE AVAILABILITY HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _hist()     { return global.SNXShadowConvHistory || null; }
  function _mem()      { return global.SNXShadowMemory      || null; }
  function _adaptive() { return global.SNXShadowAdaptive    || null; }
  function _brain()    { return global.SRAdaptiveBrain      || null; }

  /* ─────────────────────────────────────────────────────────────
     INIT
     Called once when ShadowReaper.init() succeeds.
  ───────────────────────────────────────────────────────────────*/
  function init() {
    if (_hist())     _hist().init();
    if (_mem())      _mem().init();
    if (_adaptive()) _adaptive().init();

    /* Ensure adaptive cache is loaded lazily (no DB call if guest) */
    if (_adaptive()) _adaptive().ensureLoaded();

    /* Ensure brain concept map is loaded lazily */
    if (_brain()) _brain().ensureLoaded();

    console.log('[SRPersistence] Brain-1 bridge initialized.',
      'history=' + !!_hist(),
      'memory='  + !!_mem(),
      'adaptive='+ !!_adaptive(),
      'brain='   + !!_brain()
    );
  }

  /* ─────────────────────────────────────────────────────────────
     SAVE TURN
     Called AFTER a successful V2 response for both roles.
     Fire-and-forget — never blocks the pipeline.
  ───────────────────────────────────────────────────────────────*/
  function saveTurn(role, text) {
    if (!_hist()) return;
    _hist().saveTurn(role, text);
  }

  /* ─────────────────────────────────────────────────────────────
     PROCESS TURN FOR ADAPTIVE LEARNING
     Called AFTER a successful user+assistant turn pair.
     Fire-and-forget — never blocks the pipeline.
  ───────────────────────────────────────────────────────────────*/
  function processAdaptiveTurn(userText, sessionContext) {
    var convId      = _hist() ? _hist().getCurrentConvId() : null;
    var projectName = (sessionContext && sessionContext.projectName) ? sessionContext.projectName : null;

    /* Legacy SNXShadowAdaptive — preserve existing behavior */
    if (_adaptive()) {
      _adaptive().processTurn(userText, convId);
    }

    /* New SRAdaptiveBrain — concept graph learning */
    if (_brain()) {
      _brain().learn({
        text:        userText,
        role:        'user',
        convId:      convId,
        projectName: projectName,
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     LOAD PERSISTENT CONTEXT
     Called when Shadow Reaper detects a continuity-intent question
     ("what were we talking about?", etc.) OR on V2 init to warm up.
     Async callback pattern — never blocks the synchronous pipeline.
  ───────────────────────────────────────────────────────────────*/
  function loadHistoryContext(callback) {
    callback = callback || function () {};
    if (!_hist()) { callback({ turns: [] }); return; }
    _hist().loadRecentContext(callback);
  }

  /* ─────────────────────────────────────────────────────────────
     GET ADAPTIVE CONTEXT SNIPPETS
     Returns synchronously from in-session cache (no extra DB call).
     Called before composing a response to inject stable learned context.
  ───────────────────────────────────────────────────────────────*/
  function getAdaptiveSnippets(userText, sessionContext) {
    var results = [];

    /* Legacy SNXShadowAdaptive snippets */
    if (_adaptive()) {
      var legacy = _adaptive().retrieveRelevant(userText);
      if (legacy && legacy.length) results = results.concat(legacy);
    }

    /* New SRAdaptiveBrain concept snippets */
    if (_brain()) {
      var projectName = (sessionContext && sessionContext.projectName) ? sessionContext.projectName : null;
      var brainItems = _brain().retrieve({
        text:        userText,
        projectName: projectName,
        topic:       sessionContext ? sessionContext.currentTopic : null,
      });
      if (brainItems && brainItems.length) {
        brainItems.forEach(function (item) {
          results.push({
            category:   item.type,
            key:        item.concept,
            value:      item.value,
            confidence: item.confidence,
          });
        });
      }
    }

    /* Deduplicate by value */
    var seen = {};
    return results.filter(function (r) {
      if (!r || !r.value) return false;
      if (seen[r.value]) return false;
      seen[r.value] = true;
      return true;
    });
  }

  /* ─────────────────────────────────────────────────────────────
     DETECT MEMORY INTENT
     Returns 'MEMORY_SAVE' | 'MEMORY_RECALL' | 'MEMORY_FORGET' |
             'MEMORY_FORGET_ALL' | 'MEMORY_LIST' | null
  ───────────────────────────────────────────────────────────────*/
  function detectMemoryIntent(text) {
    if (!_mem()) return null;
    return _mem().detectIntent(text);
  }

  /* ─────────────────────────────────────────────────────────────
     DETECT CONTINUITY INTENT
     Returns true if user is asking to recall a previous conversation.
  ───────────────────────────────────────────────────────────────*/
  function detectContinuityIntent(text) {
    if (!_hist()) return false;
    return _hist().detectContinuity(text);
  }

  /* ─────────────────────────────────────────────────────────────
     DETECT ADAPTIVE PRIVACY INTENT
     Returns 'ADAPTIVE_LIST' | 'ADAPTIVE_CLEAR' | 'ADAPTIVE_FORGET_ONE' | null
  ───────────────────────────────────────────────────────────────*/
  function detectAdaptiveIntent(text) {
    if (!_adaptive()) return null;
    return _adaptive().detectIntent(text);
  }

  /* ─────────────────────────────────────────────────────────────
     HANDLE MEMORY COMMAND
     Async — calls callback(responseString) when done.
  ───────────────────────────────────────────────────────────────*/
  function handleMemoryCommand(intent, text, callback) {
    callback = callback || function () {};
    var mem = _mem();
    if (!mem) { callback("Personal memory isn't available right now."); return; }

    if (intent === 'MEMORY_SAVE') {
      mem.save(text, function (r) { callback(r.message || "Got it."); });
      return;
    }
    if (intent === 'MEMORY_RECALL') {
      mem.recall(text, function (r) {
        if (!r.success) { callback(r.message || "I couldn't retrieve that."); return; }
        if (!r.memories || !r.memories.length) {
          callback("I don't have anything saved matching that.");
          return;
        }
        var snippets = r.memories.slice(0, 3).map(function (m) { return m.content; });
        callback("Here's what I have saved: " + snippets.join('; ') + '.');
      });
      return;
    }
    if (intent === 'MEMORY_LIST') {
      mem.list(function (r) {
        if (!r.success) { callback(r.message || "I couldn't retrieve that."); return; }
        if (!r.memories || !r.memories.length) {
          callback("I don't have any saved memories for you yet.");
          return;
        }
        var lines = r.memories.slice(0, 10).map(function (m, i) {
          return (i + 1) + '. ' + m.content;
        });
        callback("Here's what I remember about you:\n" + lines.join('\n'));
      });
      return;
    }
    if (intent === 'MEMORY_FORGET') {
      mem.forget(text, function (r) { callback(r.message || "Done."); });
      return;
    }
    if (intent === 'MEMORY_FORGET_ALL') {
      /* Check for pending confirmation */
      var pending = mem.getPendingForgetAll();
      if (pending) {
        /* Second call — confirmed */
        mem.clearAll(true, function (r) { callback(r.message || "All memories cleared."); });
      } else {
        /* First call — request confirmation */
        mem.clearAll(false, function (r) { callback(r.message || "Are you sure?"); });
      }
      return;
    }
    callback("I didn't understand that memory command.");
  }

  /* ─────────────────────────────────────────────────────────────
     HANDLE ADAPTIVE COMMAND
     Async — calls callback(responseString) when done.
  ───────────────────────────────────────────────────────────────*/
  function handleAdaptiveCommand(intent, text, callback) {
    callback = callback || function () {};
    var ad = _adaptive();
    if (!ad) { callback("Adaptive learning isn't available right now."); return; }

    if (intent === 'ADAPTIVE_LIST') {
      var items = ad.listAll();
      if (!items.length) {
        callback("I haven't learned any stable context about you yet.");
        return;
      }
      var lines = items.map(function (it, i) {
        return (i + 1) + '. [' + it.confidence + '] ' + it.value;
      });
      callback("Here's what I've learned from our conversations:\n" + lines.join('\n'));
      return;
    }
    if (intent === 'ADAPTIVE_CLEAR') {
      ad.clearAll(function (r) {
        callback(r.success
          ? "Done. I've cleared all learned context about you."
          : "Couldn't clear learned data right now.");
      });
      return;
    }
    callback(null); /* not handled — fall through to normal response */
  }

  /* ─────────────────────────────────────────────────────────────
     NEW CONVERSATION
     Starts a new conversation thread in history.
     Does NOT delete memory, adaptive data, or firebase history.
  ───────────────────────────────────────────────────────────────*/
  function newConversation() {
    if (_hist()) _hist().newConversation();
  }

  /* ─────────────────────────────────────────────────────────────
     DESTROY
     Tears down session state in all persistence modules.
     Does NOT delete any persistent Firebase data.
  ───────────────────────────────────────────────────────────────*/
  function destroy() {
    if (_hist())     _hist().destroy();
    if (_mem())      _mem().destroy();
    if (_adaptive()) _adaptive().destroy();
    if (_brain())    _brain().destroy();
  }

  /* ─────────────────────────────────────────────────────────────
     STATUS
  ───────────────────────────────────────────────────────────────*/
  function getStatus() {
    var histMod   = _hist();
    var memMod    = _mem();
    var adMod     = _adaptive();
    var brainMod  = _brain();
    return {
      historyConnected:  !!histMod,
      memoryConnected:   !!memMod,
      adaptiveConnected: !!adMod,
      brainConnected:    !!brainMod,
      historyEnabled:    histMod  ? histMod.isEnabled()   : false,
      memoryEnabled:     memMod   ? memMod.isEnabled()    : false,
      adaptiveEnabled:   adMod    ? adMod.isEnabled()     : false,
      currentConvId:     histMod  ? histMod.getCurrentConvId() : null,
      adaptiveItemCount: adMod    ? adMod.listAll().length : 0,
      brainConceptCount: brainMod ? brainMod.listAll().length : 0,
    };
  }

  /* ─────────────────────────────────────────────────────────────
     ENABLE / DISABLE CONTROLS
  ───────────────────────────────────────────────────────────────*/
  function setHistoryEnabled(val) {
    if (_hist()) _hist().setEnabled(!!val);
  }
  function setMemoryEnabled(val) {
    if (_mem()) _mem().setEnabled(!!val);
  }
  function setAdaptiveEnabled(val) {
    if (_adaptive()) _adaptive().setEnabled(!!val);
  }

  /* ─────────────────────────────────────────────────────────────
     GET RELATED CONCEPTS (brain delegation)
  ───────────────────────────────────────────────────────────────*/
  function getRelatedConcepts(conceptName) {
    if (!_brain()) return [];
    return _brain().getRelated(conceptName);
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.SRPersistence
  ───────────────────────────────────────────────────────────────*/
  global.SRPersistence = {
    build: 'SR-V2-BRAIN-1',

    init:                    init,
    saveTurn:                saveTurn,
    processAdaptiveTurn:     processAdaptiveTurn,
    loadHistoryContext:      loadHistoryContext,
    getRelatedConcepts:      getRelatedConcepts,
    getAdaptiveSnippets:     getAdaptiveSnippets,
    detectMemoryIntent:      detectMemoryIntent,
    detectContinuityIntent:  detectContinuityIntent,
    detectAdaptiveIntent:    detectAdaptiveIntent,
    handleMemoryCommand:     handleMemoryCommand,
    handleAdaptiveCommand:   handleAdaptiveCommand,
    newConversation:         newConversation,
    destroy:                 destroy,
    getStatus:               getStatus,
    setHistoryEnabled:       setHistoryEnabled,
    setMemoryEnabled:        setMemoryEnabled,
    setAdaptiveEnabled:      setAdaptiveEnabled,
  };

})(typeof window !== 'undefined' ? window : global);
