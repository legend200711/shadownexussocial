/**
 * shadow-reaper/core/response-engine.js
 * Shadow Reaper AI — Response Engine
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Composes the final Shadow Reaper response from context.
 * Handles all conversation types locally — NO Workers AI.
 * Zero env.AI.run() calls.
 *
 * Handles:
 *   - Greetings
 *   - Questions (with knowledge)
 *   - How-to
 *   - Troubleshooting
 *   - Navigation commands
 *   - Memory commands (delegates to storage)
 *   - History commands (delegates to storage)
 *   - Adaptive commands (delegates to storage)
 *   - Continuity requests
 *   - User corrections
 *   - General chat / emotional conversation
 *   - Project discussion
 *   - Follow-ups
 *   - Unknown / graceful fallback
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-RESPONSE-001';

  /* ─────────────────────────────────────────────────────────────
     GREETING RESPONSES
  ───────────────────────────────────────────────────────────────*/
  var _GREETINGS = [
    "Hey! I'm Shadow Reaper, your Shadow Nexus Social assistant. How can I help you today?",
    "Hello! Shadow Reaper here. What's on your mind?",
    "Hey there! What would you like to know or do on Shadow Nexus Social?",
    "Hi! I'm here and ready. Ask me anything about Shadow Nexus Social or just chat.",
    "Hey! Good to see you. What can I help you with today?"
  ];

  /* ─────────────────────────────────────────────────────────────
     GENERAL CHAT RESPONSES (by emotional tone from E1)
  ───────────────────────────────────────────────────────────────*/
  var _GENERAL = [
    "That's interesting — tell me more. I'm all ears.",
    "I hear you. What's on your mind?",
    "Happy to chat. What would you like to talk about?",
    "I'm here for it. What's going on?",
    "Sounds like you've got something on your mind. Go ahead — I'm listening."
  ];

  var _FOLLOW_UP = [
    "Sure, I can continue. What would you like to know next?",
    "Of course — what's your next question?",
    "Go ahead, I'm with you.",
    "I'm here — what else would you like to know?"
  ];

  /* ─────────────────────────────────────────────────────────────
     CORRECTION RESPONSES
  ───────────────────────────────────────────────────────────────*/
  var _CORRECTIONS = [
    "Got it — let me reconsider that. What did you mean?",
    "My apologies for the misunderstanding. Can you clarify?",
    "Thanks for the correction. What would you like me to know?",
    "Understood — I'll adjust. What's the correct way to think about it?"
  ];

  /* ─────────────────────────────────────────────────────────────
     UNKNOWN FALLBACKS
  ───────────────────────────────────────────────────────────────*/
  var _UNKNOWNS = [
    "I don't have information on that just yet, but I'm always learning. Is there something about Shadow Nexus Social I can help with?",
    "That's outside what I know right now. Try asking about a feature or tell me what project you're working on and I'll do my best.",
    "Hmm, I'm not sure about that one. Can you rephrase, or ask me something about the platform?",
    "I genuinely don't know that — I'd rather say so than guess. What else can I help with?"
  ];

  /* ─────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────*/
  var _greetingIdx  = 0;
  var _generalIdx   = 0;
  var _unknownIdx   = 0;

  function _pick(arr, idx) {
    return arr[idx % arr.length];
  }

  function _rot(arr, counter) {
    counter[0] = (counter[0] + 1) % arr.length;
    return arr[counter[0]];
  }

  /* ─────────────────────────────────────────────────────────────
     ROUTING HANDLERS
  ───────────────────────────────────────────────────────────────*/

  function _handleGreeting(ctx) {
    var response = _pick(_GREETINGS, _greetingIdx++);
    if (ctx.hasMemories && ctx.memories && ctx.memories.length > 0) {
      var name = _extractUserName(ctx.memories);
      if (name) response = 'Hey ' + name + '! ' + response.slice(response.indexOf(' ') + 1);
    }
    return response;
  }

  function _extractUserName(memories) {
    for (var i = 0; i < memories.length; i++) {
      var m = memories[i];
      var content = m.content || String(m);
      var match = content.match(/\bmy name is ([A-Za-z]{2,30})\b/i) ||
                  content.match(/\bcall me ([A-Za-z]{2,30})\b/i);
      if (match) return match[1];
    }
    return null;
  }

  function _handleContinuity(ctx) {
    if (!ctx.hasHistory && ctx.sessionTurns.length === 0) {
      return "I don't have any previous conversation context loaded right now. Start a new topic and I'll remember it for the rest of our session.";
    }
    if (ctx.hasHistory && ctx.historyTurns.length > 0) {
      // Find last user turn in history
      var last = null;
      for (var i = ctx.historyTurns.length - 1; i >= 0; i--) {
        if (ctx.historyTurns[i].role === 'user') { last = ctx.historyTurns[i]; break; }
      }
      if (last) {
        return "Based on our previous conversation, you were asking about: \"" + last.text.slice(0, 100) + "\". Would you like to continue from there?";
      }
    }
    if (ctx.sessionTurns.length > 0) {
      var lastSessionUser = null;
      for (var j = ctx.sessionTurns.length - 1; j >= 0; j--) {
        if (ctx.sessionTurns[j].role === 'user') { lastSessionUser = ctx.sessionTurns[j]; break; }
      }
      if (lastSessionUser) {
        return "In this session, you last asked: \"" + lastSessionUser.text.slice(0, 100) + "\". Want to pick up from there?";
      }
    }
    return "I have some context from our current session but nothing earlier. What would you like to continue?";
  }

  function _handleCorrection(ctx) {
    return _CORRECTIONS[Math.floor(Math.random() * _CORRECTIONS.length)];
  }

  function _handleGeneralChat(ctx) {
    if (ctx.isShort) {
      return _FOLLOW_UP[_generalIdx++ % _FOLLOW_UP.length];
    }
    // Check for project context
    if (ctx.project) {
      return "Sounds good! I'm keeping your project (" + ctx.project + ") in mind. What would you like to work on?";
    }
    return _GENERAL[_generalIdx++ % _GENERAL.length];
  }

  function _handleKnowledge(ctx) {
    if (!ctx.hasKnowledge || ctx.knowledgeSnippets.length === 0) {
      return null; // caller should fall through to unknown
    }
    var snippets = ctx.knowledgeSnippets;
    var parts = [];

    for (var i = 0; i < snippets.length; i++) {
      var s = snippets[i];
      if (s.localAnswer) {
        // Full local answer already composed by knowledge engine
        return s.localAnswer;
      }
      if (s.summary) parts.push(s.summary);
      if (s.how) parts.push(s.how);
    }

    if (parts.length === 0) return null;

    var response = parts.join('\n\n');

    // Add context awareness
    if (ctx.project) {
      response += '\n\nFor your project "' + ctx.project + '", keep this in mind as you build.';
    }

    return response.trim();
  }

  function _handleNavigation(ctx) {
    var feature = ctx.feature;
    if (!feature) {
      return "Which section would you like to go to? I can take you to: Radio, Live, TV, Feed, Profile, Inbox, Notifications, Search, Friends, Settings, Community, or Arcade.";
    }
    return "I'll navigate you to " + _capitalize(feature) + " now.";
  }

  function _handleTroubleshoot(ctx) {
    var feature = ctx.feature;
    var base = "Let's work through this together.";
    if (feature) {
      base = "I can help you troubleshoot " + _capitalize(feature) + ".";
    }
    if (ctx.hasKnowledge && ctx.knowledgeSnippets.length > 0) {
      var knowledgeAnswer = _handleKnowledge(ctx);
      if (knowledgeAnswer) return base + '\n\n' + knowledgeAnswer;
    }
    return base + " Can you describe exactly what's happening? What did you try, and what did you expect to happen?";
  }

  function _handleMemoryCommand(ctx) {
    // Delegate to storage layer — response engine returns a signal
    // The Conversation Engine handles actual memory operation
    return '__MEMORY_COMMAND__';
  }

  function _handleHistoryCommand(ctx) {
    return '__HISTORY_COMMAND__';
  }

  function _handleAdaptiveCommand(ctx) {
    return '__ADAPTIVE_COMMAND__';
  }

  function _capitalize(str) {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /* ─────────────────────────────────────────────────────────────
     compose(context) → { text, signal, navigateTo }
     The main composition function. Workers AI calls = 0.
  ───────────────────────────────────────────────────────────────*/
  function compose(ctx) {
    if (!ctx) {
      return { text: _UNKNOWNS[0], signal: null, navigateTo: null };
    }

    var text = null;
    var signal = null;
    var navigateTo = null;

    // ── Route by intent ──

    if (ctx.isGreeting) {
      text = _handleGreeting(ctx);

    } else if (ctx.isContinuity) {
      text = _handleContinuity(ctx);

    } else if (ctx.isCorrection) {
      text = _handleCorrection(ctx);

    } else if (ctx.isMemoryCmd) {
      text = _handleMemoryCommand(ctx);
      signal = 'MEMORY_COMMAND';

    } else if (ctx.isHistoryCmd) {
      text = _handleHistoryCommand(ctx);
      signal = 'HISTORY_COMMAND';

    } else if (ctx.isAdaptiveCmd) {
      text = _handleAdaptiveCommand(ctx);
      signal = 'ADAPTIVE_COMMAND';

    } else if (ctx.isNavigation) {
      text = _handleNavigation(ctx);
      navigateTo = ctx.feature;
      signal = ctx.feature ? 'NAVIGATE' : null;

    } else if (ctx.isTroubleshoot) {
      text = _handleTroubleshoot(ctx);

    } else if (ctx.isGeneralChat && !ctx.hasKnowledge) {
      text = _handleGeneralChat(ctx);

    } else if (ctx.hasKnowledge) {
      // Try knowledge answer first
      text = _handleKnowledge(ctx);
      if (!text) {
        // Knowledge was present but didn't yield an answer — general chat
        if (ctx.isGeneralChat) {
          text = _handleGeneralChat(ctx);
        } else {
          text = _UNKNOWNS[_unknownIdx++ % _UNKNOWNS.length];
        }
      }

    } else if (ctx.isShort && ctx.needsContext) {
      // Short follow-up with context but no knowledge
      text = _FOLLOW_UP[_generalIdx++ % _FOLLOW_UP.length];

    } else {
      // Unknown / no match
      text = _UNKNOWNS[_unknownIdx++ % _UNKNOWNS.length];
    }

    return {
      text:       text,
      signal:     signal,
      navigateTo: navigateTo
    };
  }

  /* ─────────────────────────────────────────────────────────────
     composeMemoryResponse(memoryResult) → string
     Formats a memory operation result into a human-readable response.
  ───────────────────────────────────────────────────────────────*/
  function composeMemoryResponse(memoryResult) {
    if (!memoryResult) return "I couldn't process that memory request. Please try again.";

    switch (memoryResult.operation) {
      case 'SAVE':
        return memoryResult.success
          ? "Got it — I've remembered: " + (memoryResult.content || 'that')
          : (memoryResult.blocked
            ? "I can't store that — it looks like sensitive information (passwords, keys, etc.). I'll never store those."
            : "I couldn't save that memory right now. Try again in a moment.");

      case 'RECALL':
        if (!memoryResult.success || !memoryResult.results || memoryResult.results.length === 0) {
          return "I don't have any memories matching that query yet.";
        }
        return "Here's what I remember:\n" + memoryResult.results.map(function (m, i) {
          return (i + 1) + '. ' + (m.content || m);
        }).join('\n');

      case 'LIST':
        if (!memoryResult.results || memoryResult.results.length === 0) {
          return "I don't have any memories saved for you yet. Say \"remember my favorite color is blue\" to add one.";
        }
        return "Here's everything I remember about you:\n" + memoryResult.results.map(function (m, i) {
          return (i + 1) + '. ' + (m.content || m);
        }).join('\n');

      case 'FORGET':
        return memoryResult.success
          ? "Done — I've forgotten that."
          : "I couldn't find a matching memory to forget. Try being more specific.";

      case 'FORGET_ALL':
        if (memoryResult.pending) {
          return "Are you sure you want to clear all your memories? Say \"yes, clear all my memories\" to confirm.";
        }
        return memoryResult.success
          ? "All your memories have been cleared."
          : "Something went wrong clearing your memories. Please try again.";

      default:
        return "Memory operation completed.";
    }
  }

  /* ─────────────────────────────────────────────────────────────
     composeHistoryResponse(historyResult) → string
  ───────────────────────────────────────────────────────────────*/
  function composeHistoryResponse(historyResult) {
    if (!historyResult) return "I couldn't process that history request.";

    switch (historyResult.operation) {
      case 'TOGGLE_ON':
        return "Conversation history is now ON. I'll remember our conversations across sessions.";
      case 'TOGGLE_OFF':
        return "Conversation history is now OFF. This session will continue but nothing new will be saved.";
      case 'CLEAR':
        return historyResult.success
          ? "Your conversation history has been cleared."
          : "I couldn't clear your history right now. Try again in a moment.";
      case 'NEW':
        return "Starting a fresh conversation. Your previous conversations are still saved — say \"continue where we left off\" to restore them.";
      default:
        return "History operation completed.";
    }
  }

  /* ─────────────────────────────────────────────────────────────
     composeAdaptiveResponse(adaptiveResult) → string
  ───────────────────────────────────────────────────────────────*/
  function composeAdaptiveResponse(adaptiveResult) {
    if (!adaptiveResult) return "I couldn't process that request.";

    switch (adaptiveResult.operation) {
      case 'LIST':
        if (!adaptiveResult.items || adaptiveResult.items.length === 0) {
          return "I haven't learned any context about you yet. I pick up patterns from our conversations over time.";
        }
        return "Here's what I've learned so far:\n" + adaptiveResult.items.map(function (item, i) {
          return (i + 1) + '. ' + (item.key || '') + ': ' + (item.value || '');
        }).join('\n');
      case 'CLEAR':
        return adaptiveResult.success
          ? "Done — I've cleared everything I've learned about your preferences."
          : "I couldn't clear that right now. Try again in a moment.";
      default:
        return "Adaptive learning operation completed.";
    }
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRResponse = {
    compose:                 compose,
    composeMemoryResponse:   composeMemoryResponse,
    composeHistoryResponse:  composeHistoryResponse,
    composeAdaptiveResponse: composeAdaptiveResponse,
    build: BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
