/**
 * shadow-reaper-v2/core/conversation-engine.js
 * Shadow Reaper V2 — Conversation Engine
 *
 * Build: SR-V2-STAGE1
 *
 * Responsibilities:
 *  - Maintain the ordered turn history for the current session
 *  - Provide recent turns to the Response Engine
 *  - Detect topic continuity vs topic shifts
 *  - No persistence (Stage 1 — session only)
 */

(function (global) {
  'use strict';

  // ─── Session turn history ────────────────────────────────────────────────────

  const MAX_SESSION_TURNS = 50;
  let _turns = [];

  // A turn = { role: 'user'|'assistant', text: string, intent: string, tone: string }

  // ─── Add turn ────────────────────────────────────────────────────────────────

  function addTurn(role, text, intent, tone) {
    _turns.push({ role, text, intent: intent || 'UNKNOWN', tone: tone || 'neutral' });
    if (_turns.length > MAX_SESSION_TURNS) {
      _turns = _turns.slice(-MAX_SESSION_TURNS);
    }
  }

  // ─── Recent turns ────────────────────────────────────────────────────────────

  function getRecentTurns(n) {
    n = n || 10;
    return _turns.slice(-n);
  }

  function getLastUserTurn() {
    for (let i = _turns.length - 1; i >= 0; i--) {
      if (_turns[i].role === 'user') return _turns[i];
    }
    return null;
  }

  function getLastAssistantTurn() {
    for (let i = _turns.length - 1; i >= 0; i--) {
      if (_turns[i].role === 'assistant') return _turns[i];
    }
    return null;
  }

  // ─── Topic continuity ────────────────────────────────────────────────────────

  // Returns true if the last few turns suggest an ongoing topic
  function isInActiveTopic() {
    const recent = getRecentTurns(4);
    if (recent.length < 2) return false;
    const userTurns = recent.filter((t) => t.role === 'user');
    if (userTurns.length < 2) return false;
    // If recent user turns are all follow-ups or project statements, topic is active
    const activeIntents = ['FOLLOW_UP', 'PROJECT_STATEMENT', 'USER_CORRECTION', 'QUESTION'];
    return userTurns.slice(-2).every((t) => activeIntents.includes(t.intent));
  }

  // ─── Turn count ──────────────────────────────────────────────────────────────

  function getTurnCount() {
    return _turns.length;
  }

  // ─── Reset ───────────────────────────────────────────────────────────────────

  function reset() {
    _turns = [];
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  global.SRConversation = {
    addTurn,
    getRecentTurns,
    getLastUserTurn,
    getLastAssistantTurn,
    isInActiveTopic,
    getTurnCount,
    reset,
  };
})(typeof window !== 'undefined' ? window : global);
