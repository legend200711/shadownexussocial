/**
 * shadow-reaper/data/knowledge-engine.js
 * Shadow Reaper AI — Knowledge Engine Wrapper
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Wraps the existing SNXShadowKnowledge module and adapts its API
 * for the unified ShadowReaper Core.
 *
 * Reuses ALL logic from snx-shadow-ai-knowledge.js.
 * Does NOT duplicate the 110+ knowledge records.
 * Does NOT reconnect Workers AI (all confidence tiers answer locally).
 * Does NOT destroy the original module.
 *
 * If SNXShadowKnowledge is loaded, delegates to it.
 * If not, provides a minimal direct answer using its public API contract.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-KNOWLEDGE-001';

  /* ─────────────────────────────────────────────────────────────
     DELEGATE TO SNXShadowKnowledge
     The existing module is the authoritative knowledge source.
  ───────────────────────────────────────────────────────────────*/
  function _delegate() {
    return global.SNXShadowKnowledge || null;
  }

  /* ─────────────────────────────────────────────────────────────
     retrieveKnowledge(question, context) → ranked hits
     Delegates to SNXShadowKnowledge.retrieveKnowledge()
  ───────────────────────────────────────────────────────────────*/
  function retrieveKnowledge(question, context) {
    var delegate = _delegate();
    if (delegate && typeof delegate.retrieveKnowledge === 'function') {
      return delegate.retrieveKnowledge(question, context) || [];
    }
    return [];
  }

  /* ─────────────────────────────────────────────────────────────
     answerLocally(question, context) → { text, handled, confidence } | null
     Returns a fully composed local answer for HIGH/MEDIUM confidence queries.
     Zero Workers AI calls.
  ───────────────────────────────────────────────────────────────*/
  function answerLocally(question, context) {
    var delegate = _delegate();
    if (delegate && typeof delegate.answerLocally === 'function') {
      return delegate.answerLocally(question, context) || null;
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     query(message, context) → { text, page, handled, confidence, id, snippets }
     Legacy API for backward compat.
  ───────────────────────────────────────────────────────────────*/
  function query(message, context) {
    var delegate = _delegate();
    if (delegate && typeof delegate.query === 'function') {
      return delegate.query(message, context);
    }
    return { text: null, page: null, handled: false, confidence: 0, id: null, snippets: [] };
  }

  /* ─────────────────────────────────────────────────────────────
     getCategories() → string[]
  ───────────────────────────────────────────────────────────────*/
  function getCategories() {
    var delegate = _delegate();
    if (delegate && typeof delegate.getCategories === 'function') {
      return delegate.getCategories();
    }
    return [];
  }

  /* ─────────────────────────────────────────────────────────────
     getEntry(id) → entry | null
  ───────────────────────────────────────────────────────────────*/
  function getEntry(id) {
    var delegate = _delegate();
    if (delegate && typeof delegate.getEntry === 'function') {
      return delegate.getEntry(id);
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     getDiagnostics() → safe counter object (no user data)
  ───────────────────────────────────────────────────────────────*/
  function getDiagnostics() {
    var delegate = _delegate();
    if (delegate && typeof delegate.getDiagnostics === 'function') {
      return delegate.getDiagnostics();
    }
    return { recordCount: 0, localAnswerCount: 0, aiFallbackCount: 0, noMatchCount: 0, delegated: false };
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
  global.SRKnowledge = {
    retrieveKnowledge: retrieveKnowledge,
    answerLocally:     answerLocally,
    query:             query,
    getCategories:     getCategories,
    getEntry:          getEntry,
    getDiagnostics:    getDiagnostics,
    isAvailable:       isAvailable,
    build:             BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
