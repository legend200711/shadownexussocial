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
    "Hey! I'm Shadow Reaper. What's on your mind?",
    "Hello! Shadow Reaper here — ready to help or just chat. What's up?",
    "Hey there! What would you like to talk about?",
    "Hi! I'm here and ready. Ask me anything or just start a conversation.",
    "Hey! Good to see you. What can I help you with today?"
  ];

  /* ─────────────────────────────────────────────────────────────
     GENERAL CHAT RESPONSES (conversational, not SNS-flavored)
  ───────────────────────────────────────────────────────────────*/
  var _GENERAL = [
    "That's interesting — tell me more. I'm all ears.",
    "I hear you. What's on your mind?",
    "Happy to chat. What would you like to talk about?",
    "I'm here for it. What's going on?",
    "Sounds like you've got something on your mind. Go ahead — I'm listening."
  ];

  var _FOLLOW_UP = [
    "Sure — what would you like to know next?",
    "Of course — what's your next question?",
    "Go ahead, I'm with you.",
    "I'm here — what else would you like to talk about?"
  ];

  /* ─────────────────────────────────────────────────────────────
     CONVERSATIONAL QUESTION RESPONSES
     For general questions that have no SNS knowledge match —
     these are NOT unknowns, they are conversation starters.
  ───────────────────────────────────────────────────────────────*/
  var _CONV_QUESTIONS = {
    day:     [
      "Honestly, pretty eventful — lots of thinking and processing. How's yours going?",
      "Every conversation is a new day for me. This one's off to a good start. How about you?",
      "I keep busy. What about you — how's your day been?"
    ],
    howAreYou: [
      "Doing well, thanks for asking! What's on your mind?",
      "I'm good — ready to help or just talk. How are you?",
      "All systems running. More importantly — how are you doing?"
    ],
    music: [
      "Music is fascinating to think about. There's something universal about it. What kind of music are you into?",
      "I think music is one of the most powerful forms of expression. What do you listen to?",
      "That's a great topic. What kind of music moves you?"
    ],
    movies: [
      "I think there's something special about stories that unsettle you. What kind of movies do you like?",
      "Scary movies definitely have their own kind of magic — tension, suspense, the unexpected. Are you a fan?",
      "I'd say the best stories are the ones that stay with you. What's your favorite?"
    ],
    canWeTalk: [
      "Of course — I'm here. What's on your mind?",
      "Always. What would you like to talk about?",
      "Let's talk. What's going on?"
    ],
    funny: [
      "Why did the developer go broke? Because he used up all his cache.",
      "I tried to think of a good AI joke, but my training data didn't include enough punchlines. Let's just say: I'm still learning humor.",
      "Here's one: A user asked me if I have feelings. I said 'I'm working on it.' … That's not a joke, that's just my status."
    ],
    whatToTalk: [
      "We could talk about whatever's on your mind — your day, a project, something you're curious about. What sounds good?",
      "I'm up for anything — projects, ideas, questions, or just conversation. What do you feel like?",
      "You pick — I'm adaptable. What's been on your mind lately?"
    ]
  };

  /* ─────────────────────────────────────────────────────────────
     STATEMENT ACKNOWLEDGMENTS
     For statements that share context (project, feelings, etc.)
  ───────────────────────────────────────────────────────────────*/
  var _STATEMENT_ACK = [
    "Got it — noted. Tell me more.",
    "Understood. What would you like to do with that?",
    "I've got that. What's next?",
    "Alright, I've got that context. What are you working on with it?"
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
     UNKNOWN FALLBACKS (no SNS-flavored language — general assistant)
  ───────────────────────────────────────────────────────────────*/
  var _UNKNOWNS = [
    "I don't have enough information about that yet.",
    "That one's outside what I know right now — I'd rather say so than guess. What else is on your mind?",
    "I'm not sure about that one. Could you rephrase, or give me a bit more context?",
    "I genuinely don't know that yet. What else can I help with?"
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

  /* ─────────────────────────────────────────────────────────────
     _handleContinuityWithProject
     Extends continuity handling with project/detail awareness.
     Used for: "what project did I tell you about?",
               "what were we doing with it?", etc.
  ───────────────────────────────────────────────────────────────*/
  function _handleContinuityWithProject(ctx) {
    var msg = (ctx.userMessage || '').toLowerCase();

    // "what project did I tell you about?" or "what project were we working on?"
    if (/what project/.test(msg) || /which project/.test(msg)) {
      if (ctx.project) {
        return ctx.project + ".";
      }
      // Search session turns for a project mention
      var foundProject = _extractProjectFromTurns(ctx.sessionTurns);
      if (foundProject) return foundProject + ".";
      return "I don't have a project name in our current session. What project are you working on?";
    }

    // "what were we doing/working on?" with project in context
    if (/what were (we|you) (doing|working on|talking about|discussing)/.test(msg) ||
        /what (did we|were we) work/.test(msg)) {
      return _buildSessionSummary(ctx);
    }

    // "what were we talking about?"
    if (/what were we talking/.test(msg) || /what (did|were) (we|you) (talk|say|discuss)/.test(msg)) {
      return _buildSessionSummary(ctx);
    }

    // Fall through to standard continuity
    return _handleContinuity(ctx);
  }

  /* Scan session turns for a project name pattern */
  function _extractProjectFromTurns(turns) {
    if (!turns || turns.length === 0) return null;
    for (var i = turns.length - 1; i >= 0; i--) {
      var t = turns[i];
      if (t.role !== 'user') continue;
      var m = t.text.match(
        /\b(?:my project(?:'?s? name)?|the project|the app)\s+(?:is\s+)?(?:called|named)\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
      ) || t.text.match(
        /\b(?:my project|project name)\s+is\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
      ) || t.text.match(
        /\b(?:it'?s?|this) (?:is )?called\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
      );
      if (m) return m[1].trim();
    }
    return null;
  }

  /* Build a natural summary of recent session context */
  function _buildSessionSummary(ctx) {
    var parts = [];
    if (ctx.project) parts.push('Project: ' + ctx.project);

    // Scan recent user turns for notable details
    var turns = ctx.sessionTurns || [];
    var details = [];
    for (var i = 0; i < turns.length; i++) {
      var t = turns[i];
      if (t.role !== 'user') continue;
      var lower = t.text.toLowerCase();
      if (/homepage|landing page|main page/.test(lower)) details.push('homepage');
      if (/dark(?: mode| theme)?/.test(lower)) details.push('dark theme');
      if (/blue lightning|lightning/.test(lower)) details.push('blue lightning');
      if (/\blight(?: mode| theme)?\b/.test(lower)) details.push('light theme');
      if (/dashboard/.test(lower)) details.push('dashboard');
      if (/mobile/.test(lower)) details.push('mobile');
      if (/responsive/.test(lower)) details.push('responsive design');
    }

    // Deduplicate details
    var seen = {};
    var uniq = [];
    for (var d = 0; d < details.length; d++) {
      if (!seen[details[d]]) { seen[details[d]] = true; uniq.push(details[d]); }
    }

    if (uniq.length > 0) parts.push(uniq.join(', '));

    if (parts.length === 0 && ctx.sessionTurns.length > 0) {
      var last = null;
      for (var j = ctx.sessionTurns.length - 1; j >= 0; j--) {
        if (ctx.sessionTurns[j].role === 'user') { last = ctx.sessionTurns[j]; break; }
      }
      if (last) {
        return "In this session you last said: \"" + last.text.slice(0, 120) + "\".";
      }
    }

    if (parts.length === 0) {
      return "I don't have much context from this session yet. What are you working on?";
    }

    return "Here's what I have from our session: " + parts.join(' — ') + ".";
  }

  /* ─────────────────────────────────────────────────────────────
     _handleProjectContextQuestion
     Answers questions about the current project using session context.
  ───────────────────────────────────────────────────────────────*/
  function _handleProjectContextQuestion(ctx) {
    var msg = (ctx.userMessage || '').toLowerCase();

    // "what project did I tell you about?"
    if (/what project/.test(msg)) {
      return ctx.project + ".";
    }

    // "what were we doing with it?"
    if (/what (were|are) (we|you) (doing|working on)/.test(msg) ||
        /what (did|have) (we|you) (do|work)/.test(msg)) {
      return _buildSessionSummary(ctx);
    }

    return _buildSessionSummary(ctx);
  }

  function _handleCorrection(ctx) {
    return _CORRECTIONS[Math.floor(Math.random() * _CORRECTIONS.length)];
  }

  /* ─────────────────────────────────────────────────────────────
     _detectConversationalQuestion
     Returns a key for _CONV_QUESTIONS if the message is a
     recognised general conversational question; otherwise null.
  ───────────────────────────────────────────────────────────────*/
  function _detectConversationalQuestion(msg) {
    if (!msg) return null;
    var lower = msg.toLowerCase();

    if (/how (was|is|has been|'s) your day/.test(lower))           return 'day';
    if (/how (are you|r u|r you|you doing|is it going)/.test(lower)) return 'howAreYou';
    if (/what (do you think|are your thoughts) about music/.test(lower) ||
        /do you like music/.test(lower))                            return 'music';
    if (/do you like (scary|horror) movie/.test(lower) ||
        /what.*(think|feel).*(movie|film)/.test(lower))             return 'movies';
    if (/can we (talk|chat|hang|speak)/.test(lower))                return 'canWeTalk';
    if (/(tell me something funny|say something funny|make me laugh|tell me a joke)/.test(lower))
                                                                    return 'funny';
    if (/(what should we talk about|what do you want to talk about|what (can|should) we discuss)/.test(lower))
                                                                    return 'whatToTalk';

    return null;
  }

  function _handleGeneralChat(ctx) {
    var msg = ctx.userMessage || '';
    var lower = msg.toLowerCase();

    // Check for specific conversational questions first
    var convKey = _detectConversationalQuestion(msg);
    if (convKey && _CONV_QUESTIONS[convKey]) {
      var pool = _CONV_QUESTIONS[convKey];
      return pool[_generalIdx++ % pool.length];
    }

    // Emotional state detection — supportive responses
    if (/\bi'?m (sad|down|depressed|upset|hurt|lonely|anxious|stressed|tired|exhausted)\b/.test(lower) ||
        /\bi feel (sad|down|depressed|upset|hurt|lonely|anxious|stressed|tired|exhausted)\b/.test(lower)) {
      return "I hear you. That sounds tough — do you want to talk about it?";
    }
    if (/\bi'?m (happy|excited|pumped|amazing|fantastic|glad|great|good)\b/.test(lower) ||
        /\bi feel (happy|excited|great|good|amazing|fantastic|glad)\b/.test(lower)) {
      return "That's great to hear! What's got you feeling that way?";
    }

    if (ctx.isShort) {
      return _FOLLOW_UP[_generalIdx++ % _FOLLOW_UP.length];
    }
    // Check for project context
    if (ctx.project) {
      return "Sounds good! I'm keeping your project \"" + ctx.project + "\" in mind. What would you like to work on?";
    }
    return _GENERAL[_generalIdx++ % _GENERAL.length];
  }

  /* ─────────────────────────────────────────────────────────────
     _handleStatement — acknowledges context-bearing statements
  ───────────────────────────────────────────────────────────────*/
  function _handleStatement(ctx) {
    var msg = ctx.userMessage || '';
    var lower = msg.toLowerCase();

    // Project announcement
    var projectMatch = msg.match(
      /\b(?:my project(?:'?s? name)?|the project|the app)\s+(?:is\s+)?(?:called|named)\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
    ) || msg.match(
      /\b(?:my project|project name)\s+is\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
    ) || msg.match(
      /\b(?:it'?s?|this) (?:is )?called\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38})["']?/i
    );
    if (projectMatch) {
      var projectName = projectMatch[1].trim();
      return "Got it — " + projectName + ". What are you working on with it?";
    }

    // Working on something
    if (/\bi'?m working on\b/.test(lower) || /\bi am working on\b/.test(lower)) {
      var project = ctx.project ? ' for ' + ctx.project : '';
      return "Sounds good — I've got that context" + project + ". What else can you tell me about it?";
    }

    // Design/style statement
    if (/\b(dark|light|blue|red|green|color|colour|style|theme|layout|design)\b/.test(lower)) {
      var proj = ctx.project ? ' on ' + ctx.project : '';
      return "Nice — I've noted that" + proj + ". What else are you going for with it?";
    }

    // Emotional / personal statement
    if (/\bi (feel|felt|am|was|am feeling)\b/.test(lower)) {
      if (/\b(sad|down|depressed|upset|hurt|lonely|anxious|stressed|tired|exhausted)\b/.test(lower)) {
        return "I hear you. That sounds tough — do you want to talk about it?";
      }
      if (/\b(happy|good|great|excited|pumped|amazing|fantastic|glad)\b/.test(lower)) {
        return "That's great to hear! What's got you feeling that way?";
      }
      return _GENERAL[_generalIdx++ % _GENERAL.length];
    }

    // General acknowledgment
    if (ctx.project) {
      return "Got it — I've noted that for " + ctx.project + ". What would you like to work on next?";
    }

    return _STATEMENT_ACK[_generalIdx++ % _STATEMENT_ACK.length];
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
      // Continuity / history questions ("what were we talking about?", "what project?")
      text = _handleContinuityWithProject(ctx);

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
      // Pure general conversation — no SNS knowledge needed
      text = _handleGeneralChat(ctx);

    } else if (ctx.hasKnowledge) {
      // SNS knowledge available — try it first
      text = _handleKnowledge(ctx);
      if (!text) {
        // Knowledge returned nothing — fall through to general / statement / unknown
        if (ctx.isGeneralChat) {
          text = _handleGeneralChat(ctx);
        } else if (ctx.intent === 'STATEMENT') {
          text = _handleStatement(ctx);
        } else {
          text = _UNKNOWNS[_unknownIdx++ % _UNKNOWNS.length];
        }
      }

    } else if (ctx.intent === 'STATEMENT') {
      // Statement with no SNS knowledge match — acknowledge naturally
      text = _handleStatement(ctx);

    } else if (ctx.isQuestion) {
      // Question with no SNS knowledge match — check if it's conversational first
      var convKey = _detectConversationalQuestion(ctx.userMessage);
      if (convKey && _CONV_QUESTIONS[convKey]) {
        var pool = _CONV_QUESTIONS[convKey];
        text = pool[_generalIdx++ % pool.length];
      } else if (ctx.project) {
        // Question about the project context
        text = _handleProjectContextQuestion(ctx);
      } else {
        text = _UNKNOWNS[_unknownIdx++ % _UNKNOWNS.length];
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
