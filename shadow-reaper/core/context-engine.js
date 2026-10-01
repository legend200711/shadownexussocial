/**
 * shadow-reaper/core/context-engine.js
 * Shadow Reaper AI — Context Engine
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Assembles bounded, relevant context for each AI turn.
 *
 * Receives from caller:
 *   - understanding result (from UnderstandingEngine)
 *   - current conversation session turns
 *   - recent persistent history turns (bounded slice)
 *   - relevant personal memories (bounded slice)
 *   - relevant learned context (bounded slice)
 *   - relevant knowledge snippets (bounded slice)
 *
 * Outputs one clean context object for the Response Engine.
 *
 * NEVER loads entire databases. All input slices must already be bounded.
 * No Firebase calls. No Workers AI calls. No external calls.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-CONTEXT-001';

  /* ─────────────────────────────────────────────────────────────
     LIMITS — defensive caps (callers should already bound inputs)
  ───────────────────────────────────────────────────────────────*/
  var MAX_SESSION_TURNS    = 20;   // from current open-panel session
  var MAX_HISTORY_TURNS    = 10;   // from persistent Firestore history
  var MAX_MEMORIES         = 3;    // personal memory snippets
  var MAX_LEARNED          = 5;    // adaptive learning items
  var MAX_KNOWLEDGE_ITEMS  = 3;    // knowledge engine records

  /* ─────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _cap(arr, limit) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(-limit); // keep most-recent
  }

  function _safeStr(v) {
    if (!v) return '';
    return String(v).slice(0, 500);
  }

  /* ─────────────────────────────────────────────────────────────
     assemble(params) → contextObject
     params: {
       understanding      — UnderstandingEngine.understand() result
       sessionTurns       — [{role, text}] current session
       historyTurns       — [{role, text}] from persistent history (bounded)
       memories           — [{content, category}] personal memories
       learnedItems       — [{key, value, category, confidence}] adaptive items
       knowledgeSnippets  — [{title, summary, how?}] knowledge entries
       currentProject     — string|null  current project name
       currentTopic       — string|null  current topic
       currentFeature     — string|null  current feature key
     }
  ───────────────────────────────────────────────────────────────*/
  function assemble(params) {
    params = params || {};

    var understanding = params.understanding || {};
    var sessionTurns = _cap(params.sessionTurns, MAX_SESSION_TURNS);
    var historyTurns = _cap(params.historyTurns, MAX_HISTORY_TURNS);
    var memories = _cap(params.memories, MAX_MEMORIES);
    var learnedItems = _cap(params.learnedItems, MAX_LEARNED);
    var knowledgeSnippets = _cap(params.knowledgeSnippets, MAX_KNOWLEDGE_ITEMS);

    // Resolve current context — understanding overrides if present
    var currentFeature = understanding.feature || params.currentFeature || null;
    var currentTopic   = understanding.topic || params.currentTopic || null;
    var currentProject = params.currentProject || null;

    // Build narrative context summary
    var contextSummary = _buildSummary(
      currentFeature, currentTopic, currentProject,
      memories, learnedItems, knowledgeSnippets
    );

    return {
      // The original user message (corrected/raw)
      userMessage:      _safeStr(understanding.corrected || understanding.raw || ''),

      // Intent and understanding metadata
      intent:           understanding.intent || 'UNKNOWN',
      feature:          currentFeature,
      topic:            currentTopic,
      project:          currentProject,
      needsContext:     !!understanding.needsContext,
      isShort:          !!understanding.isShort,

      // Conversation data (bounded)
      sessionTurns:     sessionTurns,
      historyTurns:     historyTurns,

      // Storage data (bounded snippets)
      memories:         memories,
      learnedItems:     learnedItems,

      // Knowledge data (bounded)
      knowledgeSnippets: knowledgeSnippets,

      // Narrative summary for response engine
      contextSummary:   contextSummary,

      // Flags for response engine routing
      hasHistory:       historyTurns.length > 0,
      hasMemories:      memories.length > 0,
      hasLearned:       learnedItems.length > 0,
      hasKnowledge:     knowledgeSnippets.length > 0,

      // Pass-through flags from understanding
      isGreeting:       !!understanding.isGreeting,
      isMemoryCmd:      !!understanding.isMemoryCmd,
      isHistoryCmd:     !!understanding.isHistoryCmd,
      isAdaptiveCmd:    !!understanding.isAdaptiveCmd,
      isContinuity:     !!understanding.isContinuity,
      isCorrection:     !!understanding.isCorrection,
      isTroubleshoot:   !!understanding.isTroubleshoot,
      isNavigation:     !!understanding.isNavigation,
      isQuestion:       !!understanding.isQuestion,
      isGeneralChat:    !!understanding.isGeneralChat
    };
  }

  /* ─────────────────────────────────────────────────────────────
     _buildSummary — produce a readable context description
     for the Response Engine. Only non-empty items included.
  ───────────────────────────────────────────────────────────────*/
  function _buildSummary(feature, topic, project, memories, learnedItems, knowledgeSnippets) {
    var parts = [];

    if (project) parts.push('Current project: ' + project);
    if (feature && feature !== topic) parts.push('Current feature: ' + feature);
    if (topic && topic !== feature && topic !== project) parts.push('Current topic: ' + topic);

    if (memories.length > 0) {
      var memStr = memories.map(function (m) { return _safeStr(m.content || m); }).join('; ');
      parts.push('Known about user: ' + memStr);
    }

    if (learnedItems.length > 0) {
      var learnedStr = learnedItems.map(function (l) {
        return _safeStr(l.key) + ': ' + _safeStr(l.value);
      }).join('; ');
      parts.push('Learned context: ' + learnedStr);
    }

    if (knowledgeSnippets.length > 0) {
      var knowledgeStr = knowledgeSnippets.map(function (k) {
        return _safeStr(k.title) + (k.summary ? ' — ' + _safeStr(k.summary) : '');
      }).join(' | ');
      parts.push('Knowledge: ' + knowledgeStr);
    }

    return parts.length > 0 ? parts.join('. ') : '';
  }

  /* ─────────────────────────────────────────────────────────────
     resolveProjectReference(text, sessionContext)
     Resolves "it", "that project", "the app" to actual project name
     when one is in scope.
  ───────────────────────────────────────────────────────────────*/
  function resolveProjectReference(text, sessionCtx) {
    if (!sessionCtx || !sessionCtx.currentProject) return text;
    var project = sessionCtx.currentProject;
    // Replace pronoun-only references with project name
    return text.replace(/\b(it|this project|that project|the project|the app|the site|the website)\b/gi, project);
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRContext = {
    assemble:               assemble,
    resolveProjectReference: resolveProjectReference,
    LIMITS: {
      MAX_SESSION_TURNS:   MAX_SESSION_TURNS,
      MAX_HISTORY_TURNS:   MAX_HISTORY_TURNS,
      MAX_MEMORIES:        MAX_MEMORIES,
      MAX_LEARNED:         MAX_LEARNED,
      MAX_KNOWLEDGE_ITEMS: MAX_KNOWLEDGE_ITEMS
    },
    build: BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
