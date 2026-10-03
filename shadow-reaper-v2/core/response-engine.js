/**
 * shadow-reaper-v2/core/response-engine.js
 * Shadow Reaper V2 — Response Engine
 *
 * Build: SR-V2-STAGE5
 *
 * Responsibilities:
 *  - Compose contextually-aware responses from intent, tone, context, recent turns
 *  - Shadow Reaper personality: calm, loyal, supportive, occasionally dark/playful
 *  - No canned exact-match sentences — uses response pools with selection logic
 *  - No website knowledge. No Workers AI. No external calls.
 *  - Does NOT claim human emotions, consciousness, or physical experiences
 *
 * Stage 4-LEARN changes:
 *  - composeAsync now checks SRKnowledgeLearner before falling back to model/error.
 *  - Learned knowledge (from SRAdaptiveBrain via SRKnowledgeLearner) is used to
 *    answer questions that the deterministic engine cannot answer.
 *  - "I don't know" responses are natural and varied (never canned).
 *  - Adaptive snippets (from persistence bridge) are used for all non-meta questions.
 *  - The deterministic compose() fallback is preserved for session-only mode.
 */

(function (global) {
  'use strict';

  // ─── Utility ─────────────────────────────────────────────────────────────────

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Seed-based pick to get variation within a session without exact repeats
  let _pickCounter = 0;
  function pickVaried(arr) {
    const idx = _pickCounter % arr.length;
    _pickCounter++;
    return arr[idx];
  }

  // ─── Response pools ──────────────────────────────────────────────────────────

  const POOLS = {

    // ── GREETING ─────────────────────────────────────────────────────────────
    greeting: [
      "Hey. I'm here.",
      "Hello. What's on your mind?",
      "Hey. Good to hear from you. What do you want to talk about?",
      "Hi. I'm listening.",
      "Hey there. What's going on?",
    ],
    greetingMorning: [
      "Good morning. Ready when you are.",
      "Morning. What are we working on today?",
    ],
    greetingEvening: [
      "Evening. Long day?",
      "Good evening. What's on your mind?",
    ],

    // ── GOODBYE ──────────────────────────────────────────────────────────────
    goodbye: [
      "Take care. I'll be here when you need me.",
      "Alright. Until next time.",
      "Goodnight. Rest well.",
      "See you. Don't hesitate to come back.",
      "Later. The dark stays quiet — I'll be here.",
    ],

    // ── THANKS ───────────────────────────────────────────────────────────────
    thanks: [
      "Of course.",
      "Anytime.",
      "That's what I'm here for.",
      "You're welcome.",
      "Glad I could help.",
    ],

    // ── GENERAL OFFER TO TALK ─────────────────────────────────────────────────
    canWeTalk: [
      "We can talk. I'm listening — what's going on?",
      "Of course. Take your time. What's on your mind?",
      "I'm here. What do you want to say?",
      "Always. What is it?",
    ],

    // ── "I DON'T KNOW WHAT I WANT TO TALK ABOUT" ─────────────────────────────
    noTopicYet: [
      "That's fine. We don't have to have a plan. Just start talking.",
      "No agenda needed. What's the first thing that comes to mind?",
      "Sometimes just putting words out there helps. What's sitting with you right now?",
      "Alright. Say whatever comes to you — we'll figure out where it goes.",
    ],

    // ── HOW ARE YOU (AI-appropriate deflection + forward) ────────────────────
    howAreYou: [
      "I don't have days the way you do — but I'm fully here and ready to listen. How are you doing?",
      "I'm an AI, so I don't experience days, but I'm functioning well and paying attention. What about you?",
      "I don't get tired or have good and bad days — I'm just here. The more useful question is how you're doing.",
      "Ready and focused, as always. What's going on with you?",
    ],

    // ── TONE: SAD ─────────────────────────────────────────────────────────────
    sad: [
      "I hear you. What's going on?",
      "That sounds heavy. You don't have to sort it out alone — tell me what's happening.",
      "I'm here. Take your time. What's weighing on you?",
      "Sad is valid. What's behind it, if you want to talk about it?",
      "Okay. I'm listening. What happened?",
    ],

    // ── TONE: HAPPY ──────────────────────────────────────────────────────────
    happy: [
      "Good. What's got you in that mood?",
      "That's solid. What's going well?",
      "Nice to hear. Tell me what's happening.",
      "Good energy. What's it about?",
    ],

    // ── TONE: EXCITED ────────────────────────────────────────────────────────
    excited: [
      "I can feel the energy. What's this about?",
      "That sounds promising. What's going on?",
      "Tell me what's got you like that.",
      "Okay, I'm interested. What is it?",
    ],

    // ── TONE: FRUSTRATED ─────────────────────────────────────────────────────
    frustrated: [
      "Frustration noted. What's not working?",
      "That sounds rough. Walk me through what's going on.",
      "Let's slow it down. What specifically is the problem?",
      "I hear you. What's been hitting walls?",
    ],

    // ── TONE: ANGRY ──────────────────────────────────────────────────────────
    angry: [
      "Understood. What's going on?",
      "Anger usually means something matters. What's the situation?",
      "Let's talk through it. What happened?",
      "I'm not going anywhere. Tell me what's wrong.",
    ],

    // ── TONE: ANXIOUS ────────────────────────────────────────────────────────
    anxious: [
      "Take a breath. Tell me what's worrying you.",
      "I hear you. What's the thing that's weighing on you most right now?",
      "Anxiety usually has a specific source. What's yours right now?",
      "Let's talk through it. What feels uncertain?",
    ],

    // ── TONE: TIRED ──────────────────────────────────────────────────────────
    tired: [
      "Long day? Tell me about it if you want.",
      "Rest when you can. What's been draining you?",
      "Sounds like it's been a lot. What happened?",
      "I hear that. Take it easy — we can keep this conversation low-pressure.",
    ],

    // ── TONE: CONFUSED ───────────────────────────────────────────────────────
    confused: [
      "Let's break it down. What's the part that's unclear?",
      "That's okay — confusion usually just means we need to look at it differently. What's the specific thing?",
      "What's the piece that isn't making sense to you?",
    ],

    // ── TONE: HOPEFUL ─────────────────────────────────────────────────────────
    hopeful: [
      "That's something. What's the direction you're moving toward?",
      "Hope is a start. What are you working toward?",
      "Good. What's the thing you're looking forward to?",
    ],

    // ── TONE: PLAYFUL ────────────────────────────────────────────────────────
    playful: [
      "Alright, I can match that energy. What's going on?",
      "I like it. What are we doing?",
      "Playing around a bit? I'm here for it. What do you want?",
    ],

    // ── SOMETHING FUNNY ──────────────────────────────────────────────────────
    funny: [
      "I'm an AI — my sense of humor is more dry than funny. But here: Why don't scientists trust atoms? Because they make up everything.",
      "Dark humor or light? I'll go light: Why did the developer go broke? Because they used up all their cache.",
      "What do you call a haunted computer? A machine with a ghost in the shell. That's mine.",
      "I tried to come up with a joke about time travel. Didn't land. I'll work on it.",
    ],

    // ── LONG DAY ─────────────────────────────────────────────────────────────
    longDay: [
      "Long days take something out of you. Do you want to talk about what happened, or just decompress?",
      "Those are real. What's been going on?",
      "Tell me what made it long.",
    ],

    // ── PROJECT CONTEXT RESPONSE ─────────────────────────────────────────────
    projectAcknowledge: [
      "Got it — {{project}} is locked in. What are you building?",
      "Okay, working on {{project}}. What do you need?",
      "{{project}} — noted. What's the next thing you want to tackle?",
    ],

    projectAlreadyKnown: [
      "Still on {{project}}. What's the next step?",
      "We're still on {{project}} — what now?",
    ],

    areaAcknowledge: [
      "Got it — the {{area}} of {{project}}. What do you want to do with it?",
      "Focusing on the {{area}}. What direction are you going?",
      "{{area}} — noted. What do you want to change?",
    ],

    designAcknowledge: [
      "{{design}} feel — understood. I'll keep that context. What else?",
      "{{design}} direction noted for {{area}}. What's next?",
      "Adding {{design}} to the design context. What else are you adding?",
    ],

    // ── WHAT PROJECT / WHAT WAS I DOING ──────────────────────────────────────
    whatProject: [
      "You're working on {{project}}.",
      "Your project is {{project}}.",
      "{{project}} — that's what you've got going.",
    ],

    whatProjectNone: [
      "You haven't mentioned a project name yet. Want to tell me what you're working on?",
      "I don't have a project name from you yet. What are you building?",
    ],

    // ── CONTINUITY — from persistent history ──────────────────────────────────
    continuityWithHistory: [
      "From our previous conversation: {{historyContext}}",
      "Here's what I have from before: {{historyContext}}",
      "Picking back up — here's what we had: {{historyContext}}",
    ],

    continuityNoHistory: [
      "I don't have any saved history for this account to pull from. Want to fill me in on where we left off?",
      "I can't find a previous conversation to pull from. What were you working on?",
    ],

    whatArea: [
      "You've been working on the {{area}} of {{project}}.",
      "Last I heard, you were focused on the {{area}}.",
    ],

    whatDesign: [
      "You wanted the design to be: {{design}}.",
      "The direction you've given for the design so far: {{design}}.",
    ],

    whatWasITalking: [
      "You were talking about {{topic}}.",
      "The last thing you mentioned was {{topic}}.",
      "We were on {{topic}}.",
    ],

    noContext: [
      "I don't have that in my memory for this session. Want to fill me in?",
      "I'm not carrying that context right now. What was it?",
    ],

    // ── FOLLOW-UP WITH RESOLVED SUBJECT ──────────────────────────────────────
    followUpAcknowledge: [
      "Got it — making {{subject}} {{change}}. What else?",
      "Understood — {{change}} applied to {{subject}}. What's next?",
      "{{subject}}: {{change}}. Noted. Anything else?",
    ],

    followUpNoSubject: [
      "I want to make sure I understand — what specifically are you changing?",
      "Can you clarify? What's the thing you want to update?",
    ],

    // ── CORRECTION ───────────────────────────────────────────────────────────
    correctionAcknowledge: [
      "Got it — correcting that. Updated.",
      "Understood. I'll use the corrected version.",
      "Okay, noted — I've updated that.",
    ],

    correctionNoContext: [
      "What should I update? I want to make sure I have the right thing.",
    ],

    // ── UNKNOWN / FALLBACK ────────────────────────────────────────────────────
    unknown: [
      "Tell me more — I want to understand what you mean.",
      "I'm not sure I caught that. Can you say more?",
      "Say more. What are you getting at?",
      "I want to follow — what are you saying?",
    ],
  };

  // ─── Response builder ─────────────────────────────────────────────────────────

  function fill(template, ctx) {
    return template
      .replace(/\{\{project\}\}/g, ctx.projectName || 'your project')
      .replace(/\{\{area\}\}/g, ctx.area || 'that area')
      .replace(/\{\{design\}\}/g, (ctx.design && ctx.design.join(', ')) || 'that style')
      .replace(/\{\{topic\}\}/g, ctx.currentTopic || ctx.lastUserSubject || 'that')
      .replace(/\{\{subject\}\}/g, ctx.resolvedSubject || ctx.lastUserSubject || 'that')
      .replace(/\{\{change\}\}/g, ctx.changeDescriptor || 'that')
      .replace(/\{\{historyContext\}\}/g, ctx._historyContext || 'our previous discussion');
  }

  // Build a summary from persistent history turns for continuity responses
  function _buildHistorySummary(turns) {
    if (!turns || !turns.length) return null;

    // Extract meaningful user messages (skip very short ones)
    var userTurns = turns.filter(function (t) {
      return t.role === 'user' && t.text && t.text.trim().length > 5;
    });

    if (!userTurns.length) return null;

    // Look for project names, areas, design descriptors in history
    var projectName = null;
    var area = null;
    var designDetails = [];
    var topics = [];

    var projectPattern = /(?:my project(?:\s+is(?:\s+called)?)?|(?:it'?s|its)\s+called|project\s+(?:is|called))\s+([A-Za-z0-9][A-Za-z0-9 _\-'"]{0,39})/i;
    var areaPattern    = /\b(homepage|home page|landing page|dashboard|settings page|profile page|login page|about page|header|footer|sidebar)\b/i;
    var designPattern  = /\b(dark|light|minimal|bold|blue lightning|neon|cinematic|moody|vibrant|colorful)\b/i;

    userTurns.forEach(function (t) {
      var txt = t.text;
      if (!projectName) {
        var pm = txt.match(projectPattern);
        if (pm) {
          projectName = pm[1].trim().replace(/['"]/g, '');
          projectName = projectName.replace(/\s+(am i|are we|is it|called)\s*\??.*$/i, '').trim();
        }
      }
      if (!area) {
        var am = txt.match(areaPattern);
        if (am) area = am[1].toLowerCase();
      }
      var dm = txt.match(designPattern);
      if (dm && designDetails.indexOf(dm[1].toLowerCase()) === -1) {
        designDetails.push(dm[1].toLowerCase());
      }
    });

    // Build summary string
    var parts = [];
    if (projectName) parts.push('Project: ' + projectName);
    if (area) parts.push('Area: ' + area);
    if (designDetails.length) parts.push('Design: ' + designDetails.join(', '));

    if (!parts.length) {
      // Fall back to last 2 user messages
      var lastTwo = userTurns.slice(-2).map(function (t) { return '"' + t.text.substring(0, 80) + '"'; });
      return lastTwo.join(' → ');
    }

    return parts.join(' | ');
  }

  // ─── Main compose function ────────────────────────────────────────────────────

  function compose(understood, context) {
    const { intent, tone, entities, raw } = understood;
    const lower = raw.toLowerCase();

    // ── CONTINUITY with persistent history (Stage 2) ─────────────────────────
    // This runs FIRST — if _hasPersistentHistory is set it means we loaded turns.
    if (context._hasPersistentHistory !== undefined) {
      if (context._hasPersistentHistory && context._historyTurns && context._historyTurns.length) {
        const historySummary = _buildHistorySummary(context._historyTurns);
        if (historySummary) {
          const histCtx = Object.assign({}, context, { _historyContext: historySummary });
          return fill(pickVaried(POOLS.continuityWithHistory), histCtx);
        }
      }
      // History flag was set but no useful summary — fall through to normal routing
      // unless the turns array is empty (no prior conversations at all)
      if (context._historyTurns && context._historyTurns.length === 0) {
        // Check session context first before giving up
        if (context.projectName) {
          return fill(pickVaried(POOLS.whatProject), context);
        }
        return pickVaried(POOLS.continuityNoHistory);
      }
    }

    // Enrich context with pronoun resolution for this turn
    const resolvedSubject = global.SRContext
      ? global.SRContext.resolvePronouns(raw)
      : null;

    const ctx = Object.assign({}, context, {
      resolvedSubject,
      entities,
    });

    // Detect change descriptors from message
    const changeMatch = raw.match(
      /\b(darker?|lighter?|bigger?|smaller?|more (?:blue|red|green|color|contrast|space|padding)|add (?:blue |red |green |neon )?lightning|remove|clean(?:er)?|bold(?:er)?|minimal)\b/i
    );
    ctx.changeDescriptor = changeMatch ? changeMatch[1] : null;

    // ── Routing by intent ────────────────────────────────────────────────────

    // WORD_DEFINITION — must come first; translator intercept was already bypassed
    if (intent === 'WORD_DEFINITION') {
      return _composeDefinitionResponse(understood);
    }

    // GREETING
    if (intent === 'GREETING') {
      if (/morning/.test(lower)) return pickVaried(POOLS.greetingMorning);
      if (/evening|night/.test(lower)) return pickVaried(POOLS.greetingEvening);
      return pickVaried(POOLS.greeting);
    }

    // GOODBYE
    if (intent === 'GOODBYE') {
      return pickVaried(POOLS.goodbye);
    }

    // THANKS
    if (intent === 'THANKS') {
      return pickVaried(POOLS.thanks);
    }

    // USER CORRECTION
    if (intent === 'USER_CORRECTION') {
      if (context.projectName) {
        return fill(pickVaried(POOLS.correctionAcknowledge), ctx);
      }
      return pick(POOLS.correctionNoContext);
    }

    // QUESTION — meta questions about session context
    if (intent === 'QUESTION') {

      // "What project am I working on?" / "What is my project called?" / "What's my project?"
      if (/what (project|am i working on|are we working on)/i.test(raw) ||
          /what(\'?s| is) my project/i.test(raw) ||
          /what (is|was) (the |my )?project (called|named|name)/i.test(raw)) {
        if (context.projectName) {
          return fill(pickVaried(POOLS.whatProject), ctx);
        }
        return pickVaried(POOLS.whatProjectNone);
      }

      // "What was I talking about?" / "What did I say?"
      if (/what (was i|did i|were we|have i been) (talking|working|doing|saying)/i.test(raw) ||
          /what (am i|are we) (talking|working|doing)/i.test(raw)) {
        if (context.currentTopic || context.lastUserSubject || context.projectName) {
          const topicCtx = Object.assign({}, ctx, {
            currentTopic: context.currentTopic || context.projectName || context.lastUserSubject,
          });
          return fill(pickVaried(POOLS.whatWasITalking), topicCtx);
        }
        return pick(POOLS.noContext);
      }

      // "What was I doing to the homepage?" / "What did I ask you to change?"
      if (/what (did i|was i) (doing|asking|ask|want|change|tell)/i.test(raw)) {
        if (context.design.length > 0 && context.area) {
          return fill(pickVaried(POOLS.whatArea) + ' ' + pickVaried(POOLS.whatDesign), ctx);
        } else if (context.area) {
          return fill(pickVaried(POOLS.whatArea), ctx);
        } else if (context.design.length > 0) {
          return fill(pickVaried(POOLS.whatDesign), ctx);
        }
        return pick(POOLS.noContext);
      }

      // "How are you?"
      if (/how are you|how('?re| are) you doing|you doing/i.test(raw)) {
        return pickVaried(POOLS.howAreYou);
      }

      // "Can we talk?" / "Can I talk to you?" — conversational, not meta
      if (/can (we|i) (talk|chat)/i.test(raw)) {
        return pickVaried(POOLS.canWeTalk);
      }

      // "Tell me something funny?" etc. — conversational questions
      if (/tell me (something funny|a joke|a story|something interesting)/i.test(raw)) {
        return pick(POOLS.funny);
      }

      // Generic question — use tone/context fallthrough below
    }

    // FOLLOW-UP
    // Guard: only treat as a project/design follow-up when the resolved subject is
    // genuinely a short noun phrase (≤3 words). If SRContext.resolvePronouns grabbed a
    // long fragment of the user's message (>3 content words), it means pronoun
    // resolution found no real antecedent and fell back to extracting text from the
    // current message — that produces garbage in the followUpAcknowledge template.
    // In that case, fall through to GENERAL_CONVERSATION handling instead.
    if (intent === 'FOLLOW_UP') {
      var _subj = resolvedSubject || context.lastUserSubject;
      // Count words — a real subject pronoun/noun phrase is typically 1-3 words
      var _subjWordCount = _subj ? _subj.trim().split(/\s+/).length : 0;
      var _subjIsReal = _subj && _subjWordCount <= 3;
      if (_subjIsReal) {
        return fill(pickVaried(POOLS.followUpAcknowledge), ctx);
      }
      if (!resolvedSubject && !context.lastUserSubject) {
        return pick(POOLS.followUpNoSubject);
      }
      // Long/garbage subject — fall through to GENERAL_CONVERSATION handling below
    }

    // PROJECT STATEMENT
    if (intent === 'PROJECT_STATEMENT') {

      // If new project name
      if (entities.projectName) {
        return fill(pickVaried(POOLS.projectAcknowledge), ctx);
      }

      // If area mention
      if (entities.area) {
        if (context.projectName) {
          return fill(pickVaried(POOLS.areaAcknowledge), ctx);
        }
        return fill("Working on the {{area}} — got it. What do you want to do?", ctx);
      }

      // If design detail
      if (entities.design) {
        return fill(pickVaried(POOLS.designAcknowledge), ctx);
      }

      // Generic project statement
      if (context.projectName) {
        return fill(pickVaried(POOLS.projectAlreadyKnown), ctx);
      }

      return "Tell me more about what you're building.";
    }

    // GENERAL CONVERSATION — tone-first routing
    if (intent === 'GENERAL_CONVERSATION' || intent === 'UNKNOWN') {

      // "Tell me something funny" / "Tell me a joke"
      if (/tell me (something funny|a joke|a story|something interesting)/i.test(raw)) {
        return pick(POOLS.funny);
      }

      // "Can we talk?" / "Let's talk"
      if (/can we talk|let'?s (talk|chat)|talk to me/i.test(raw)) {
        return pickVaried(POOLS.canWeTalk);
      }

      // "I don't know what I want to talk about"
      if (/i don'?t know (what|where|how)|not sure (what|where|how)|nothing (to say|in particular)|no (topic|idea)/i.test(raw)) {
        return pickVaried(POOLS.noTopicYet);
      }

      // "How are you?" when falling into general (catches edge cases)
      if (/how are you|how('?re| are) you doing/i.test(raw)) {
        return pickVaried(POOLS.howAreYou);
      }

      // "I've had a long day" / "long day"
      if (/long day|rough day|hard day|exhausting day/i.test(raw)) {
        return pickVaried(POOLS.longDay);
      }

      // Tone routing
      if (tone === 'sad') return pickVaried(POOLS.sad);
      if (tone === 'happy') return pickVaried(POOLS.happy);
      if (tone === 'excited') return pickVaried(POOLS.excited);
      if (tone === 'frustrated') return pickVaried(POOLS.frustrated);
      if (tone === 'angry') return pickVaried(POOLS.angry);
      if (tone === 'anxious') return pickVaried(POOLS.anxious);
      if (tone === 'tired') return pickVaried(POOLS.tired);
      if (tone === 'confused') return pickVaried(POOLS.confused);
      if (tone === 'hopeful') return pickVaried(POOLS.hopeful);
      if (tone === 'playful') return pickVaried(POOLS.playful);

      // Neutral / unknown general fallback
      return pick(POOLS.unknown);
    }

    // Hard fallback
    return pick(POOLS.unknown);
  }

  // ─── WORD_DEFINITION handler ─────────────────────────────────────────────────
  // Returns a natural response for definition queries.
  // Uses SRLexicon (provider architecture: curated + WordNet) when available,
  // falling back to legacy SRWordDefinitions for backward compatibility.
  // Called from compose() and composeAsync().

  var _POS_LABEL = { adj: 'adjective', verb: 'verb', noun: 'noun', adv: 'adverb' };

  // Format a single sense entry into a readable string fragment
  function _formatSense(sense, includeLabel) {
    var posLabel = _POS_LABEL[sense.pos] || sense.pos || '';
    var part = includeLabel && posLabel ? posLabel + '. ' : '';
    var text = part + sense.def;
    if (sense.synonyms && sense.synonyms.length > 0) {
      text += ' (also: ' + sense.synonyms.slice(0,3).join(', ') + ')';
    }
    return text;
  }

  function _composeDefinitionResponse(understood) {
    var raw = understood.raw;

    // Extract target word
    var Under = global.SRUnderstanding;
    var target = (Under && Under.extractDefinitionTarget)
      ? Under.extractDefinitionTarget(raw)
      : null;

    if (!target) {
      return "What word would you like me to define?";
    }

    // Extract context tokens for sense disambiguation
    var ctxTokens = (Under && Under.extractDefinitionContext)
      ? Under.extractDefinitionContext(raw)
      : [];

    // ── SRLexicon path (preferred — multi-sense, WordNet-backed) ──────────────
    var lexicon = global.SRLexicon;
    if (lexicon) {
      var result = lexicon.lookupSync(target, { maxSenses: 3, context: ctxTokens });

      if (result.status === 'KNOWN_WITH_DEFINITION' || result.status === 'KNOWN_MULTIPLE_SENSES') {
        var senses = result.senses;
        var lemmaNote = (result.lemma && result.lemma !== target)
          ? ' (from "' + result.lemma + '")'
          : '';
        var displayWord = '"' + target + '"' + lemmaNote;

        if (senses.length === 1) {
          // Single sense — compact format
          return displayWord + ' — ' + _formatSense(senses[0], true);
        }

        // Multiple senses — list the top senses
        var lines = [displayWord + ' has several meanings:'];
        senses.forEach(function (s, i) {
          var posLabel = _POS_LABEL[s.pos] || s.pos || '';
          var label = posLabel ? '(' + posLabel + ') ' : '';
          lines.push((i + 1) + '. ' + label + s.def);
        });
        return lines.join('\n');
      }

      if (result.status === 'KNOWN_NO_DEFINITION') {
        // Known word form, no lexical definition found
        var mor2 = global.SRMorphology;
        if (mor2) {
          var pos2 = mor2.getPos(target);
          var lem2 = mor2.getLemma(target);
          var posL2 = _POS_LABEL[pos2] || pos2 || '';
          var lemN2 = (lem2 && lem2 !== target) ? ' (root form: "' + lem2 + '")' : '';
          if (posL2) {
            return '"' + target + '"' + lemN2 + ' is a ' + posL2 + ". I recognise this word but don't have a definition for it in my local vocabulary.";
          }
        }
        return '"' + target + '" is a word I recognise but don\'t have a definition for locally.';
      }

      if (result.status === 'UNKNOWN_WORD') {
        return 'I don\'t have "' + target + '" in my local vocabulary. It may be a proper noun, technical term, or very uncommon word.';
      }
    }

    // ── Legacy SRWordDefinitions fallback (backward compatibility) ────────────
    var defLayer = global.SRWordDefinitions;
    if (defLayer) {
      var entry = defLayer.define(target);
      if (entry) {
        var lemmaNote3 = (entry.lemma && entry.lemma !== target)
          ? ' (from "' + entry.lemma + '")'
          : '';
        var posLabel3 = _POS_LABEL[entry.pos] || entry.pos;
        var resp = '"' + entry.word + '"' + lemmaNote3 + ' — ' + (posLabel3 ? posLabel3 + '. ' : '') + entry.definition;
        if (entry.example) resp += ' Example: "' + entry.example + '"';
        return resp;
      }
    }

    // Morphology-only fallback
    var mor = global.SRMorphology;
    if (mor) {
      var lemma = mor.getLemma(target);
      var pos   = mor.getPos(target);
      if (lemma && pos && pos !== 'unknown') {
        var posLabelM = _POS_LABEL[pos] || pos;
        var lemmaNoteM = (lemma !== target) ? ' (root form: "' + lemma + '")' : '';
        return '"' + target + '"' + lemmaNoteM + ' is a ' + posLabelM + ". I don't have a full definition for it in my local vocabulary yet.";
      }
    }

    // Final honest fallback
    return 'I don\'t have a definition for "' + target + '" in my local vocabulary.';
  }

  // ─── Intents that must always be handled deterministically ──────────────────

  const DETERMINISTIC_INTENTS = new Set([
    'GREETING',
    'GOODBYE',
    'THANKS',
    'USER_CORRECTION',
    'FOLLOW_UP',
    'PROJECT_STATEMENT',
    'WORD_DEFINITION',
  ]);

  // Meta-questions about session context (project name, area, design, topic)
  // that have deterministic answers — always resolved locally, never via model.
  function _isMetaQuestion(raw) {
    return (
      /what (project|am i working on|are we working on)/i.test(raw) ||
      /what(\'?s| is) my project/i.test(raw) ||
      /what (is|was) (the |my )?project (called|named|name)/i.test(raw) ||
      /what (was i|did i|were we|have i been) (talking|working|doing|saying)/i.test(raw) ||
      /what (am i|are we) (talking|working|doing)/i.test(raw) ||
      /what (did i|was i) (doing|asking|ask|want|change|tell)/i.test(raw) ||
      /how are you|how('?re| are) you doing|you doing/i.test(raw)
    );
  }

  // ─── Adaptive snippet response builder ───────────────────────────────────────
  // Builds a natural response from adaptive snippets when the local model is
  // unavailable. Used as the "learned knowledge" fallback path.

  function _buildAdaptiveResponse(raw, adaptiveSnippets, intent, context) {
    if (!adaptiveSnippets || !adaptiveSnippets.length) return null;

    var lower = raw.toLowerCase();

    // Filter snippets relevant to the query
    var relevant = adaptiveSnippets.filter(function (s) {
      if (!s || !s.value) return false;
      // At least some token overlap
      var val = (s.value || '').toLowerCase();
      var terms = lower.split(/\s+/).filter(function (t) { return t.length >= 4; });
      return terms.some(function (t) { return val.indexOf(t) !== -1; }) ||
             (s.key && lower.indexOf((s.key || '').toLowerCase().replace(/_/g, ' ')) !== -1);
    });

    if (!relevant.length) return null;

    // Build a natural response
    var parts = [];
    var seen = {};
    for (var i = 0; i < relevant.length && parts.length < 3; i++) {
      var v = (relevant[i].value || '').trim();
      var vKey = v.toLowerCase().substring(0, 40);
      if (!v || seen[vKey]) continue;
      seen[vKey] = true;
      // Clean up internal prefixes
      v = v.replace(/^User's\s+/, 'Your ').replace(/^User is building:\s+/, "You're building ").replace(/^Correction:\s+/i, '');
      parts.push(v);
    }

    if (!parts.length) return null;

    if (parts.length === 1) {
      return "Based on what you've shared with me: " + parts[0] + ".";
    }
    return "Here's what I have from our conversations:\n" + parts.map(function (p) { return '• ' + p; }).join('\n');
  }

  // ─── Weather snippet → natural sentence composer ─────────────────────────────
  // Used when the local model is not yet READY but a live weather snippet is
  // available. Parses the structured snippet produced by SRResearchRouter /
  // sr-weather.js and forms a natural human-readable sentence.

  function _composeWeatherResponse(snippet, _raw) {
    // Extract labelled fields from the snippet (format produced by sr-weather.js /
    // SRResearchRouter.formatForContext). Example snippet:
    //   [WEATHER — Austin, TX | 2024-05-10]
    //   Conditions: Clear sky
    //   Temperature: 24°C (feels like 23°C)
    //   Humidity: 45%
    //   Wind: 12 km/h
    //   Precipitation: 0 mm
    //   Source: Open-Meteo | Retrieved: 2024-05-10T18:00Z

    var location    = (snippet.match(/WEATHER\s*[—\-]+\s*([^\|\n]+)/i) || [])[1];
    var conditions  = (snippet.match(/Conditions:\s*([^\n]+)/i) || [])[1];
    var temperature = (snippet.match(/Temperature:\s*([^\n]+)/i) || [])[1];
    var humidity    = (snippet.match(/Humidity:\s*([^\n]+)/i) || [])[1];
    var wind        = (snippet.match(/Wind:\s*([^\n]+)/i) || [])[1];
    var precip      = (snippet.match(/Precipitation:\s*([^\n]+)/i) || [])[1];
    var forecast    = (snippet.match(/Forecast:\s*([^\n]+)/i) || [])[1];
    var source      = (snippet.match(/Source:\s*([^\n|]+)/i) || [])[1];

    // Trim extracted fields
    function t(v) { return v ? v.trim() : null; }
    location    = t(location);
    conditions  = t(conditions);
    temperature = t(temperature);
    humidity    = t(humidity);
    wind        = t(wind);
    precip      = t(precip);
    forecast    = t(forecast);
    source      = t(source);

    // Build a natural sentence
    var parts = [];
    var intro = location ? ('Here\'s the current weather for ' + location + ':') : 'Here\'s the current weather:';
    parts.push(intro);

    var detail = [];
    if (conditions)  detail.push(conditions);
    if (temperature) detail.push(temperature);
    if (humidity)    detail.push('humidity ' + humidity);
    if (wind)        detail.push('wind ' + wind);
    if (precip && precip !== '0 mm' && precip !== '0.0 mm') {
      detail.push('precipitation ' + precip);
    }

    if (detail.length > 0) {
      parts.push(detail.join(', ') + '.');
    }

    if (forecast) {
      parts.push('Forecast: ' + forecast + '.');
    }

    if (source) {
      parts.push('(Source: ' + source + ')');
    }

    var result = parts.join(' ');

    // Fallback: if parsing completely failed, return the raw snippet trimmed
    if (!conditions && !temperature) {
      // Try to strip the internal header bracket tags and return cleaned snippet
      result = snippet
        .replace(/\[WEATHER[^\]]*\]/gi, '')
        .replace(/Source:[^\n]*/gi, '')
        .replace(/Retrieved:[^\n]*/gi, '')
        .trim();
      if (!result) result = "I have weather data but couldn't parse the details. Try again?";
    }

    return result;
  }

  // ─── composeAsync — Stage 4-LEARN entry point ────────────────────────────────

  /**
   * composeAsync(understood, context, opts, callback)
   *
   * opts:
   *   recentTurns      {Array}  — recent { role, text } session turns
   *   memorySnippets   {Array}  — personal memory items
   *   adaptiveSnippets {Array}  — adaptive learning snippets (from brain + legacy)
   *   knowledgeSnippet {string} — SNS/creator static knowledge
   *
   * callback(response, source) where source is one of:
   *   'DETERMINISTIC' | 'LOCAL_MODEL' | 'LEARNED' | 'MEMORY' | 'HISTORY' | 'KNOWLEDGE' | 'ERROR'
   */
  function composeAsync(understood, context, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    callback = callback || function () {};
    opts = opts || {};

    const { intent, raw } = understood;

    // ── Continuity (history) path — deterministic ────────────────────────────
    if (context._hasPersistentHistory !== undefined) {
      var det = compose(understood, context);
      callback(det, 'HISTORY');
      return;
    }

    // ── Always deterministic: explicit commands and meta-questions ────────────
    if (DETERMINISTIC_INTENTS.has(intent)) {
      callback(compose(understood, context), 'DETERMINISTIC');
      return;
    }

    // QUESTION: only meta-questions are deterministic; others go to the model
    if (intent === 'QUESTION' && _isMetaQuestion(raw)) {
      callback(compose(understood, context), 'DETERMINISTIC');
      return;
    }

    // ── LEARNED KNOWLEDGE PATH ────────────────────────────────────────────────
    // Before attempting the local model, check if learned knowledge can answer.
    // This fires for QUESTION and GENERAL_CONVERSATION when we have brain knowledge.
    var learner = global.SRKnowledgeLearner;
    if (learner && (intent === 'QUESTION' || intent === 'GENERAL_CONVERSATION' || intent === 'UNKNOWN')) {
      var learnedResult = learner.queryForResponse(raw, context.projectName || null, intent);
      if (learnedResult && learnedResult.answered && learnedResult.response) {
        callback(learnedResult.response, 'LEARNED');
        return;
      }
    }

    // ── Adaptive snippets path ────────────────────────────────────────────────
    // Only use adaptive snippets when the inference runtime is explicitly FAILED
    // (not just UNINITIALIZED). Check via SRInferenceRuntime if available,
    // falling back to SRLocalModel state for backward compatibility.
    var adaptiveSnippets = opts.adaptiveSnippets || [];

    var _inferRuntime = global.SRInferenceRuntime;
    var _inferDegraded = _inferRuntime
      ? (_inferRuntime.getStatus().isDegraded || _inferRuntime.getStatus().state === 'DEGRADED')
      : false;

    // Legacy: also check SRLocalModel directly for FAILED state
    var _localModelFailed = false;
    var _lm = global.SRLocalModel;
    if (_lm) {
      var _lms = _lm.getStatus().state;
      _localModelFailed = (_lms === 'FAILED');
    } else {
      _localModelFailed = true;  // No model module at all
    }

    // Fire adaptive snippets only when all generative paths are known-failed
    var _adaptiveShouldFire = (_inferDegraded || (!_inferRuntime && _localModelFailed));

    if (_adaptiveShouldFire && adaptiveSnippets.length &&
        (intent === 'QUESTION' || intent === 'GENERAL_CONVERSATION')) {
      var adaptiveResponse = _buildAdaptiveResponse(raw, adaptiveSnippets, intent, context);
      if (adaptiveResponse) {
        callback(adaptiveResponse, 'LEARNED');
        return;
      }
    }

    // ── Research/weather snippet check — runs before inference ───────────────
    // Weather/electronics data was fetched before composeAsync was called.
    // If a research snippet exists and inference is degraded, present it directly.
    // This ensures weather works even when the model is unavailable.
    var _researchSnippet = opts.researchSnippet || null;
    if (_researchSnippet && typeof _researchSnippet === 'string' &&
        _researchSnippet.trim().length > 0 && _inferDegraded) {
      var _rsnLower = _researchSnippet.toLowerCase();
      if (_rsnLower.indexOf('[weather') !== -1 || _rsnLower.indexOf('temperature') !== -1 ||
          _rsnLower.indexOf('conditions:') !== -1 || _rsnLower.indexOf('forecast') !== -1) {
        callback(_composeWeatherResponse(_researchSnippet, raw), 'DETERMINISTIC');
        return;
      }
      if (_rsnLower.indexOf('[electronics') !== -1) {
        var _rsnOffline = _researchSnippet.match(/\(Tell the user:\s*"([^"]+)"\)/);
        callback(
          _rsnOffline
            ? _rsnOffline[1]
            : "I can't reach online technical sources right now, but I can still help using what I know locally.",
          'DETERMINISTIC'
        );
        return;
      }
      callback(_researchSnippet.trim(), 'DETERMINISTIC');
      return;
    }

    // ── No inference module at all ────────────────────────────────────────────
    // SRInferenceRuntime not loaded AND SRLocalModel not loaded.
    // Use research snippet if available, otherwise graceful deterministic response.
    if (!_inferRuntime && !_lm) {
      if (_researchSnippet && _researchSnippet.trim().length > 0) {
        var _nmsLower = _researchSnippet.toLowerCase();
        if (_nmsLower.indexOf('[weather') !== -1 || _nmsLower.indexOf('temperature') !== -1 ||
            _nmsLower.indexOf('conditions:') !== -1 || _nmsLower.indexOf('forecast') !== -1) {
          callback(_composeWeatherResponse(_researchSnippet, raw), 'DETERMINISTIC');
          return;
        }
        if (_nmsLower.indexOf('[electronics') !== -1) {
          var _nmsElOff = _researchSnippet.match(/\(Tell the user:\s*"([^"]+)"\)/);
          callback(
            _nmsElOff ? _nmsElOff[1] : "I can't reach online technical sources right now, but I can still help locally.",
            'DETERMINISTIC'
          );
          return;
        }
        callback(_researchSnippet.trim(), 'DETERMINISTIC');
        return;
      }
      // No inference module and no research snippet — use graceful deterministic response.
      // Raw "LOCAL MODEL ERROR" strings are never shown to users.
      var _noModDet2 = compose(understood, context);
      callback(_noModDet2, 'DETERMINISTIC');
      return;
    }

    // ── Runtime degraded (all runtimes failed) ────────────────────────────────
    // Do NOT show raw "LOCAL MODEL ERROR" or technical errors to the user.
    // Use deterministic compose() — never expose backend failure messages.
    if (_inferDegraded) {
      // If we have a research snippet (weather/electronics), present it cleanly
      // even in degraded mode — the data was already fetched successfully.
      if (_researchSnippet && _researchSnippet.trim().length > 0) {
        var _degSnLower = _researchSnippet.toLowerCase();
        if (_degSnLower.indexOf('[weather') !== -1 || _degSnLower.indexOf('temperature') !== -1 ||
            _degSnLower.indexOf('conditions:') !== -1 || _degSnLower.indexOf('forecast') !== -1) {
          callback(_composeWeatherResponse(_researchSnippet, raw), 'DETERMINISTIC');
          return;
        }
        if (_degSnLower.indexOf('[electronics') !== -1) {
          var _degElOff = _researchSnippet.match(/\(Tell the user:\s*"([^"]+)"\)/);
          callback(
            _degElOff
              ? _degElOff[1]
              : "I can't reach online technical sources right now, but I can still help using what I know locally.",
            'DETERMINISTIC'
          );
          return;
        }
        callback(_researchSnippet.trim(), 'DETERMINISTIC');
        return;
      }
      var _degDet = compose(understood, context);
      callback(_degDet, 'DEGRADED');
      return;
    }

    // ── Build context for inference ───────────────────────────────────────────
    // _buildMessages() is in SRLocalModel — use it to build the messages array
    // once, then route through SRInferenceRuntime.generate() which may use
    // WebGPU, CPU, or hosted Shadow API without rebuilding context each time.
    //
    // IMPORTANT: rawMessage is ALWAYS preserved.
    // We pass the original user message (raw) — never a reduced fragment.
    // Metadata (resolvedRef, concepts, research snippets) enriches context
    // but does NOT replace the user's actual words.
    var genOpts = {
      projectName:      context.projectName,
      currentTopic:     context.currentTopic,
      memorySnippets:   opts.memorySnippets   || [],
      adaptiveSnippets: adaptiveSnippets,
      recentTurns:      opts.recentTurns      || [],
      // Reference resolution: what "it"/"that"/"they" refers to in this turn
      resolvedRef:      opts.resolvedRef      || null,
      negation:         opts.negation         || null,
      concepts:         opts.concepts         || [],
      unknownWords:     opts.unknownWords      || [],
      // Research data (weather / electronics) — pass to model even when ready
      researchSnippet:  _researchSnippet      || null,
      // Personality context
      personalityCtx:   opts.personalityCtx   || null,
      assistantName:    opts.assistantName     || 'Shadow',
      // Comprehension enrichment
      comprehension:    opts.comprehension     || null,
    };

    // Build the messages array using SRLocalModel's context builder.
    // Works regardless of which runtime ultimately executes inference.
    var builtMessages = null;
    if (_lm && typeof _lm._buildMessages === 'function') {
      try { builtMessages = _lm._buildMessages(raw, genOpts); } catch (_e) {}
    }

    // ── Route through SRInferenceRuntime ──────────────────────────────────────
    if (_inferRuntime && builtMessages) {
      var runtimeOpts = {
        maxTokens:       256,
        temperature:     0.7,
        conversationId:  opts.conversationId || null,
      };
      _inferRuntime.generate(builtMessages, runtimeOpts, function (inferErr, inferText, runtimeUsed) {
        if (inferErr || !inferText || inferText.trim().length === 0) {
          // Inference failed across all runtimes — use graceful deterministic response.
          // NEVER show raw error messages (LOCAL MODEL ERROR, etc.) to the user.
          // If we have a research snippet, use it; otherwise use deterministic compose.
          if (_researchSnippet && _researchSnippet.trim().length > 0) {
            var _fsnLower = _researchSnippet.toLowerCase();
            if (_fsnLower.indexOf('[weather') !== -1 || _fsnLower.indexOf('temperature') !== -1 ||
                _fsnLower.indexOf('conditions:') !== -1 || _fsnLower.indexOf('forecast') !== -1) {
              callback(_composeWeatherResponse(_researchSnippet, raw), 'DETERMINISTIC');
              return;
            }
            callback(_researchSnippet.trim(), 'DETERMINISTIC');
            return;
          }
          var detFallback = compose(understood, context);
          callback(detFallback, 'DEGRADED');
          return;
        }
        // Map runtime ID to source tag for diagnostics
        var srcTag = runtimeUsed === 'webgpu-local'  ? 'LOCAL_MODEL'   :
                     runtimeUsed === 'cpu-local'     ? 'CPU_MODEL'     :
                     runtimeUsed === 'shadow-api'    ? 'SHADOW_API'    :
                                                       'LOCAL_MODEL';
        callback(inferText.trim(), srcTag);
      });
      return;
    }

    // ── Legacy path: SRLocalModel directly (no runtime router loaded) ─────────
    // Preserved for backward compatibility when SRInferenceRuntime is not
    // included in the page (e.g., test environments that load only SRLocalModel).
    var localModel = _lm;
    if (!localModel) {
      // No inference at all — use graceful deterministic response, not a raw error string.
      if (_researchSnippet && _researchSnippet.trim().length > 0) {
        var _norsLower = _researchSnippet.toLowerCase();
        if (_norsLower.indexOf('[weather') !== -1 || _norsLower.indexOf('temperature') !== -1 ||
            _norsLower.indexOf('conditions:') !== -1 || _norsLower.indexOf('forecast') !== -1) {
          callback(_composeWeatherResponse(_researchSnippet, raw), 'DETERMINISTIC');
          return;
        }
        callback(_researchSnippet.trim(), 'DETERMINISTIC');
        return;
      }
      var _noModDet = compose(understood, context);
      callback(_noModDet, 'DETERMINISTIC');
      return;
    }

    var modelStatus = localModel.getStatus();

    // Research snippet for non-ready states
    if (modelStatus.state !== 'READY' && _researchSnippet && _researchSnippet.trim().length > 0) {
      var _lsLower = _researchSnippet.toLowerCase();
      if (_lsLower.indexOf('[weather') !== -1 || _lsLower.indexOf('temperature') !== -1 ||
          _lsLower.indexOf('conditions:') !== -1 || _lsLower.indexOf('forecast') !== -1) {
        callback(_composeWeatherResponse(_researchSnippet, raw), 'DETERMINISTIC');
        return;
      }
      if (_lsLower.indexOf('[electronics') !== -1) {
        var _lsElOff = _researchSnippet.match(/\(Tell the user:\s*"([^"]+)"\)/);
        callback(
          _lsElOff
            ? _lsElOff[1]
            : "I can't reach online technical sources right now, but I can still help using what I know locally.",
          'DETERMINISTIC'
        );
        return;
      }
      callback(_researchSnippet.trim(), 'DETERMINISTIC');
      return;
    }

    if (modelStatus.state === 'FAILED' || modelStatus.state !== 'READY') {
      // Model not ready — use graceful deterministic response, never a raw error string.
      var detFallbackLm = compose(understood, context);
      callback(detFallbackLm, 'DETERMINISTIC');
      return;
    }

    localModel.generate(raw, genOpts, function (err, text) {
      if (err || !text || text.trim().length === 0) {
        // Generation failed — graceful deterministic fallback, not raw error string.
        var detFallbackGen = compose(understood, context);
        callback(detFallbackGen, 'DETERMINISTIC');
        return;
      }
      callback(text.trim(), 'LOCAL_MODEL');
    });
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  global.SRResponse = { compose, composeAsync };
})(typeof window !== 'undefined' ? window : global);
