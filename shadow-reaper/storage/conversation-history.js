/**
 * shadow-reaper/storage/conversation-history.js
 * Shadow Reaper AI — Conversation History Wrapper
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Wraps the existing SNXShadowConvHistory module (snx-shadow-conv-history.js)
 * and adapts its API for the unified ShadowReaper Core.
 *
 * DELEGATES ALL LOGIC to SNXShadowConvHistory — no duplicate implementation.
 * The existing module owns Firestore paths, secret detection, bounded history,
 * session management, and continuity detection.
 *
 * Firestore paths (owned by SNXShadowConvHistory):
 *   users/{uid}/shadowReaperConversations/{convId}/messages/{msgId}
 *
 * Does NOT modify the existing module.
 * Does NOT create new Firestore collections.
 * Does NOT break _snxDbCompat.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-CONVHISTORY-001';

  /* ─────────────────────────────────────────────────────────────
     DELEGATE to SNXShadowConvHistory
  ───────────────────────────────────────────────────────────────*/
  function _delegate() {
    return global.SNXShadowConvHistory || null;
  }

  /* ─────────────────────────────────────────────────────────────
     init() — idempotent
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
     saveTurn(role, text, callback?)
     role: 'user' | 'assistant'
  ───────────────────────────────────────────────────────────────*/
  function saveTurn(role, text, callback) {
    var d = _delegate();
    if (d && typeof d.saveTurn === 'function') {
      d.saveTurn(role, text, callback);
    } else if (typeof callback === 'function') {
      callback({ success: false, reason: 'delegate_unavailable' });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     loadRecentContext(callback)
     Returns bounded recent turns for AI context injection.
  ───────────────────────────────────────────────────────────────*/
  function loadRecentContext(callback) {
    var d = _delegate();
    if (d && typeof d.loadRecentContext === 'function') {
      d.loadRecentContext(callback);
    } else if (typeof callback === 'function') {
      callback([]);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     getSessionTurns() → [{role, text}]
     In-memory session buffer — no Firestore read.
  ───────────────────────────────────────────────────────────────*/
  function getSessionTurns() {
    var d = _delegate();
    return d && typeof d.getSessionTurns === 'function' ? d.getSessionTurns() : [];
  }

  /* ─────────────────────────────────────────────────────────────
     newConversation() — start fresh thread
  ───────────────────────────────────────────────────────────────*/
  function newConversation() {
    var d = _delegate();
    if (d && typeof d.newConversation === 'function') d.newConversation();
  }

  /* ─────────────────────────────────────────────────────────────
     clearHistory(callback)
  ───────────────────────────────────────────────────────────────*/
  function clearHistory(callback) {
    var d = _delegate();
    if (d && typeof d.clearHistory === 'function') {
      d.clearHistory(callback);
    } else if (typeof callback === 'function') {
      callback({ success: false, reason: 'delegate_unavailable' });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     detectContinuity(text) → boolean
  ───────────────────────────────────────────────────────────────*/
  function detectContinuity(text) {
    var d = _delegate();
    return d && typeof d.detectContinuity === 'function' ? d.detectContinuity(text) : false;
  }

  /* ─────────────────────────────────────────────────────────────
     getCurrentConvId() → string | null
  ───────────────────────────────────────────────────────────────*/
  function getCurrentConvId() {
    var d = _delegate();
    return d && typeof d.getCurrentConvId === 'function' ? d.getCurrentConvId() : null;
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
  global.SRConvHistory = {
    init:               init,
    isEnabled:          isEnabled,
    setEnabled:         setEnabled,
    saveTurn:           saveTurn,
    loadRecentContext:  loadRecentContext,
    getSessionTurns:    getSessionTurns,
    newConversation:    newConversation,
    clearHistory:       clearHistory,
    detectContinuity:   detectContinuity,
    getCurrentConvId:   getCurrentConvId,
    destroy:            destroy,
    isAvailable:        isAvailable,
    build:              BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
