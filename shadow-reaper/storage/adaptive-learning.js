/**
 * shadow-reaper/storage/adaptive-learning.js
 * Shadow Reaper AI — Adaptive Learning Wrapper
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Wraps the existing SNXShadowAdaptive module (snx-shadow-adaptive.js)
 * and adapts its API for the unified ShadowReaper Core.
 *
 * DELEGATES to SNXShadowAdaptive when available.
 * Provides LOCAL fallback for isSensitive() so the wrapper works in
 * isolation (test harness, no delegate loaded).
 * The existing module owns Firestore paths, sensitive-data filters,
 * emotion-only blockers, confidence tiers, and bounded storage.
 *
 * Firestore paths (owned by SNXShadowAdaptive):
 *   users/{uid}/shadowReaperLearnedContext/{itemId}
 *
 * What CAN be learned (enforced by SNXShadowAdaptive):
 *   - Response style, project names, recurring tasks, terminology,
 *     stable non-sensitive preferences, user corrections, project decisions.
 *
 * What is NEVER learned (enforced by SNXShadowAdaptive):
 *   - Passwords, tokens, API keys, financial credentials, precise location,
 *     medical diagnoses, political/religious profiling, sexual info,
 *     temporary emotional reactions.
 *
 * Does NOT modify the existing module.
 * Does NOT break _snxDbCompat.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-ADAPTIVE-001';

  /* ─────────────────────────────────────────────────────────────
     LOCAL SENSITIVE DATA DETECTION — mirrors SNXShadowAdaptive
  ───────────────────────────────────────────────────────────────*/
  var _LOCAL_SENSITIVE_PATTERNS = [
    /\b(password|passwd|passw(?:or)?d)\s*(is|=|:)\s*\S+/i,
    /\bapi[\s_-]?key\s*(is|=|:)\s*\S+/i,
    /\btoken\s*(is|=|:)\s*\S+/i,
    /\bsecret\s*(is|=|:)\s*\S+/i,
    /\bcredit\s*card\s*(number|#|no\.?)/i,
    /\bbank\s*(account|routing|credentials?)/i,
    /\b(private key|ssh key|rsa key)/i,
    /\bmy password is\b/i,
    /\bmy api key is\b/i,
    /\bmy token is\b/i,
    /\b(medical|diagnos|prescription|therapy|medication)\b/i,
    /\b(suicide|self.harm|self harm|cutting|overdose)\b/i,
    /\b(political party|my vote|i voted|religious belief|my religion|my faith)\b/i
  ];

  function _localIsSensitive(text) {
    for (var i = 0; i < _LOCAL_SENSITIVE_PATTERNS.length; i++) {
      if (_LOCAL_SENSITIVE_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     DELEGATE to SNXShadowAdaptive
  ───────────────────────────────────────────────────────────────*/
  function _delegate() {
    return global.SNXShadowAdaptive || null;
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
     processTurn(userText, sourceConvId)
     Fire-and-forget learning after each conversation turn.
  ───────────────────────────────────────────────────────────────*/
  function processTurn(userText, sourceConvId) {
    var d = _delegate();
    if (d && typeof d.processTurn === 'function') {
      d.processTurn(userText, sourceConvId);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     retrieveRelevant(text) → [{key, value, category, confidence}]
     Bounded: max 8 relevant items for context injection.
     Synchronous — reads from in-memory session cache.
  ───────────────────────────────────────────────────────────────*/
  function retrieveRelevant(text) {
    var d = _delegate();
    return d && typeof d.retrieveRelevant === 'function' ? d.retrieveRelevant(text) : [];
  }

  /* ─────────────────────────────────────────────────────────────
     detectIntent(text) → 'ADAPTIVE_LIST' | 'ADAPTIVE_CLEAR' | 'ADAPTIVE_FORGET_ONE' | null
  ───────────────────────────────────────────────────────────────*/
  function detectIntent(text) {
    var d = _delegate();
    return d && typeof d.detectIntent === 'function' ? d.detectIntent(text) : null;
  }

  /* ─────────────────────────────────────────────────────────────
     listAll() → [{key, value, category, confidence}]
  ───────────────────────────────────────────────────────────────*/
  function listAll() {
    var d = _delegate();
    return d && typeof d.listAll === 'function' ? d.listAll() : [];
  }

  /* ─────────────────────────────────────────────────────────────
     deleteItem(key, callback)
  ───────────────────────────────────────────────────────────────*/
  function deleteItem(key, callback) {
    var d = _delegate();
    if (d && typeof d.deleteItem === 'function') {
      d.deleteItem(key, callback);
    } else if (typeof callback === 'function') {
      callback({ success: false });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     clearAll(callback)
  ───────────────────────────────────────────────────────────────*/
  function clearAll(callback) {
    var d = _delegate();
    if (d && typeof d.clearAll === 'function') {
      d.clearAll(callback);
    } else if (typeof callback === 'function') {
      callback({ success: false });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     isSensitive(text) → boolean
     Uses local fallback when delegate not available.
  ───────────────────────────────────────────────────────────────*/
  function isSensitive(text) {
    var d = _delegate();
    if (d && typeof d.isSensitive === 'function') return d.isSensitive(text);
    return _localIsSensitive(text);
  }

  /* ─────────────────────────────────────────────────────────────
     ensureLoaded(callback) — lazy-load session cache
  ───────────────────────────────────────────────────────────────*/
  function ensureLoaded(callback) {
    var d = _delegate();
    if (d && typeof d.ensureLoaded === 'function') {
      d.ensureLoaded(callback);
    } else if (typeof callback === 'function') {
      callback();
    }
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
  global.SRAdaptiveLearning = {
    init:            init,
    isEnabled:       isEnabled,
    setEnabled:      setEnabled,
    processTurn:     processTurn,
    retrieveRelevant: retrieveRelevant,
    detectIntent:    detectIntent,
    listAll:         listAll,
    deleteItem:      deleteItem,
    clearAll:        clearAll,
    isSensitive:     isSensitive,
    ensureLoaded:    ensureLoaded,
    destroy:         destroy,
    isAvailable:     isAvailable,
    build:           BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
