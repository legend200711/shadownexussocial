/**
 * shadow-reaper/storage/personal-memory.js
 * Shadow Reaper AI — Personal Memory Wrapper
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Wraps the existing SNXShadowMemory module (snx-shadow-memory.js)
 * and adapts its API for the unified ShadowReaper Core.
 *
 * DELEGATES to SNXShadowMemory when available.
 * Provides LOCAL fallback implementations for isSecret() and detectIntent()
 * so the wrapper works in isolation (test harness, no delegate loaded).
 *
 * Firestore paths (owned by SNXShadowMemory):
 *   users/{uid}/shadowReaperMemories/{memoryId}
 *
 * Explicit memory only — user must command save/recall/forget.
 * Does NOT auto-convert conversations into memories.
 * Does NOT modify the existing module.
 * Does NOT break _snxDbCompat.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-MEMORY-001';

  /* ─────────────────────────────────────────────────────────────
     LOCAL SECRET DETECTION — mirrors SNXShadowMemory patterns
  ───────────────────────────────────────────────────────────────*/
  var _LOCAL_SECRET_PATTERNS = [
    /\b(password|passwd|passw(?:or)?d)\s*(is|=|:)\s*\S+/i,
    /\bapi[\s_-]?key\s*(is|=|:)\s*\S+/i,
    /\btoken\s*(is|=|:)\s*\S+/i,
    /\bsecret\s*(is|=|:)\s*\S+/i,
    /\bcredit\s*card\s*(number|#|no\.?)\s*(is|=|:)?\s*[\d\s\-]+/i,
    /\b(cvv|cvc|security code)\s*(is|=|:)\s*\d+/i,
    /\bbank\s*(account|routing|credentials?)\s*(is|=|:)/i,
    /\b(private key|ssh key|rsa key)\s*(is|=|:)/i,
    /\bmy password is\b/i,
    /\bpassword[:=]\s*\S+/i,
    /\bmy api key is\b/i,
    /\bmy token is\b/i,
    /\bmy secret is\b/i
  ];

  function _localIsSecret(text) {
    for (var i = 0; i < _LOCAL_SECRET_PATTERNS.length; i++) {
      if (_LOCAL_SECRET_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     LOCAL INTENT DETECTION — mirrors SNXShadowMemory patterns
  ───────────────────────────────────────────────────────────────*/
  var _LOCAL_MEMORY_INTENTS = [
    { intent: 'MEMORY_SAVE',       patterns: [/\b(remember (that|my|this|i|the)|don'?t forget|save (that|this|my)|store (this|that|my)|keep in mind that)\b/i] },
    { intent: 'MEMORY_FORGET_ALL', patterns: [/\b(clear (all|my) memories|forget everything (about me)?|delete (all|my) memories|remove (all|my) memories)\b/i] },
    { intent: 'MEMORY_FORGET',     patterns: [/\b(forget (that|my|this|about)|delete (what you know|my memory|that memory))\b/i] },
    { intent: 'MEMORY_LIST',       patterns: [/\b(show (me )?(my )?memories|list (my )?memories|what (do you |have you )?remember(ed)? (about me)?|my memories)\b/i] },
    { intent: 'MEMORY_RECALL',     patterns: [/\b(recall|what do you (remember|know) (about|of) (me|my)|do you remember)\b/i] }
  ];

  function _localDetectIntent(text) {
    for (var i = 0; i < _LOCAL_MEMORY_INTENTS.length; i++) {
      var entry = _LOCAL_MEMORY_INTENTS[i];
      for (var j = 0; j < entry.patterns.length; j++) {
        if (entry.patterns[j].test(text)) return entry.intent;
      }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     DELEGATE to SNXShadowMemory
  ───────────────────────────────────────────────────────────────*/
  function _delegate() {
    return global.SNXShadowMemory || null;
  }

  /* ─────────────────────────────────────────────────────────────
     init()
  ───────────────────────────────────────────────────────────────*/
  function init() {
    var d = _delegate();
    if (d && typeof d.init === 'function') d.init();
  }

  /* ─────────────────────────────────────────────────────────────
     isEnabled() → boolean
  ───────────────────────────────────────────────────────────────*/
  function isEnabled() {
    var d = _delegate();
    return d && typeof d.isEnabled === 'function' ? d.isEnabled() : false;
  }

  /* ─────────────────────────────────────────────────────────────
     setEnabled(bool)
  ───────────────────────────────────────────────────────────────*/
  function setEnabled(bool) {
    var d = _delegate();
    if (d && typeof d.setEnabled === 'function') d.setEnabled(bool);
  }

  /* ─────────────────────────────────────────────────────────────
     detectIntent(text) → intent string | null
     Uses local fallback when delegate not available.
  ───────────────────────────────────────────────────────────────*/
  function detectIntent(text) {
    var d = _delegate();
    if (d && typeof d.detectIntent === 'function') return d.detectIntent(text);
    return _localDetectIntent(text);
  }

  /* ─────────────────────────────────────────────────────────────
     save(text, callback)
  ───────────────────────────────────────────────────────────────*/
  function save(text, callback) {
    var d = _delegate();
    if (d && typeof d.save === 'function') {
      d.save(text, callback);
    } else if (typeof callback === 'function') {
      callback({ success: false, reason: 'delegate_unavailable' });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     recall(query, callback)
  ───────────────────────────────────────────────────────────────*/
  function recall(query, callback) {
    var d = _delegate();
    if (d && typeof d.recall === 'function') {
      d.recall(query, callback);
    } else if (typeof callback === 'function') {
      callback({ success: false, results: [] });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     list(callback)
  ───────────────────────────────────────────────────────────────*/
  function list(callback) {
    var d = _delegate();
    if (d && typeof d.list === 'function') {
      d.list(callback);
    } else if (typeof callback === 'function') {
      callback({ success: false, results: [] });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     forget(text, callback)
  ───────────────────────────────────────────────────────────────*/
  function forget(text, callback) {
    var d = _delegate();
    if (d && typeof d.forget === 'function') {
      d.forget(text, callback);
    } else if (typeof callback === 'function') {
      callback({ success: false });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     clearAll(confirmed, callback)
  ───────────────────────────────────────────────────────────────*/
  function clearAll(confirmed, callback) {
    var d = _delegate();
    if (d && typeof d.clearAll === 'function') {
      d.clearAll(confirmed, callback);
    } else if (typeof callback === 'function') {
      callback({ success: false });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     getRelevantSnippets(query, callback)
     Bounded: max 3 relevant memories for context injection.
  ───────────────────────────────────────────────────────────────*/
  function getRelevantSnippets(query, callback) {
    var d = _delegate();
    if (d && typeof d.getRelevantSnippets === 'function') {
      d.getRelevantSnippets(query, callback);
    } else if (typeof callback === 'function') {
      callback([]);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     isSecret(text) → boolean
     Uses local fallback when delegate not available.
  ───────────────────────────────────────────────────────────────*/
  function isSecret(text) {
    var d = _delegate();
    if (d && typeof d.isSecret === 'function') return d.isSecret(text);
    return _localIsSecret(text);
  }

  /* ─────────────────────────────────────────────────────────────
     destroy()
  ───────────────────────────────────────────────────────────────*/
  function destroy() {
    var d = _delegate();
    if (d && typeof d.destroy === 'function') d.destroy();
  }

  /* ─────────────────────────────────────────────────────────────
     isAvailable() → boolean
  ───────────────────────────────────────────────────────────────*/
  function isAvailable() {
    return !!_delegate();
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRPersonalMemory = {
    init:                init,
    isEnabled:           isEnabled,
    setEnabled:          setEnabled,
    detectIntent:        detectIntent,
    save:                save,
    recall:              recall,
    list:                list,
    forget:              forget,
    clearAll:            clearAll,
    getRelevantSnippets: getRelevantSnippets,
    isSecret:            isSecret,
    destroy:             destroy,
    isAvailable:         isAvailable,
    build:               BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
