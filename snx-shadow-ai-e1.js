/**
 * snx-shadow-ai-e1.js
 * Shadow Nexus Social — Shadow Reaper E1: Everyday Conversation & Emotional Intelligence
 *
 * Build: SNS-2026-SHADOW-LOCAL-CONVERSATION-HISTORY-RC1
 *
 * Exposes: window.SNXShadowE1
 *
 * E1 Enhancement (layered ON TOP of the locked production core):
 *  • GENERAL_CONVERSATION intent classification
 *  • Lightweight emotional-context detection (11 tone states)
 *  • Local casual conversation layer (common exchanges — no Workers AI)
 *  • Extended local general conversation layer — handles richer everyday exchanges
 *    without Workers AI: songs, rough days, breakups, boredom, help requests, etc.
 *  • localGeneralAnswer() — covers the broader GENERAL_CONVERSATION intent locally.
 *  • Conversation context window for pronoun/topic continuity across general turns
 *  • Topic switch detection: website question mid-conversation correctly routes to core
 *  • Creative brainstorming, music discussion, humor-aware tone
 *  • Response style adaptation per detected emotional tone
 *  • Persona instructions are preserved but Workers AI is NOT called for general conv.
 *  • No permanent storage of any kind
 *  • No emotion profiling
 *  • Session context cleared on destroy()
 *
 * Design constraints (preserved from production baseline):
 *  • Does NOT modify the locked core (snx-shadow-ai.js, snx-shadow-ai-knowledge.js)
 *  • Does NOT create new RAF loops, setInterval timers, or polling
 *  • Does NOT add new voice/character/radio/TV/live/auth systems
 *  • All conversation context is memory-only, never persisted
 *  • Idempotent: safe to call init() multiple times
 *  • No HTML injection
 *  • No human emotion claims ("I have feelings", "I remember experiencing that")
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SNS-2026-SHADOW-LOCAL-CONVERSATION-HISTORY-RC1';

  /* ─────────────────────────────────────────────────────────────
     EMOTION STATES
     Conversational tone detection only.
     NOT presented as verified emotional/medical state.
     Internal label = "likely conversational tone".
  ───────────────────────────────────────────────────────────────*/
  var EMOTION = {
    NEUTRAL:    'NEUTRAL',
    HAPPY:      'HAPPY',
    EXCITED:    'EXCITED',
    SAD:        'SAD',
    FRUSTRATED: 'FRUSTRATED',
    ANGRY:      'ANGRY',
    ANXIOUS:    'ANXIOUS',
    CONFUSED:   'CONFUSED',
    TIRED:      'TIRED',
    HOPEFUL:    'HOPEFUL',
    PLAYFUL:    'PLAYFUL'
  };

  /* ─────────────────────────────────────────────────────────────
     EMOTION DETECTION PATTERNS
     Applied to incoming message text (lowercased).
     First match wins within each PRIORITY GROUP.
  ───────────────────────────────────────────────────────────────*/
  var _EMOTION_PATTERNS = [
    /* Excited */
    { tone: EMOTION.EXCITED,    pat: /\b(excited|pumped|stoked|hyped|can.t wait|amazing|awesome|incredible|omg|hype|big news|so good|crushing it|killing it|finally did it|just finished|got the|nailed it)\b/i },
    /* Happy */
    { tone: EMOTION.HAPPY,      pat: /\b(happy|great day|feeling good|good mood|blessed|grateful|love it|love this|love that|loving|smile|smiling|glad|joyful|cheerful|on top of the world)\b/i },
    /* Frustrated */
    { tone: EMOTION.FRUSTRATED, pat: /\b(frustrated|ugh|argh|ughhh|so annoying|annoying|drives me crazy|can.t believe|ridiculous|fed up|over it|done with|sick of|tired of|why won.t|keeps happening|every time)\b/i },
    /* Angry */
    { tone: EMOTION.ANGRY,      pat: /\b(angry|mad|furious|pissed|livid|rage|raging|so mad|hate this|i hate|makes me mad|infuriating|outrage|can.t stand)\b/i },
    /* Sad */
    { tone: EMOTION.SAD,        pat: /\b(sad|down|depressed|feeling low|bummed|heartbroken|miss|missing|cry|crying|tears|rough day|bad day|hurt|hurting|lost|lonely|alone|grieving)\b/i },
    /* Anxious */
    { tone: EMOTION.ANXIOUS,    pat: /\b(anxious|nervous|worried|stress|stressed|anxiety|panic|overwhelmed|can.t stop thinking|overthinking|scared|fear|afraid)\b/i },
    /* Tired */
    { tone: EMOTION.TIRED,      pat: /\b(tired|exhausted|drained|sleepy|no energy|burnt out|burnout|worn out|barely awake|long day|rough day|been a day)\b/i },
    /* Confused */
    { tone: EMOTION.CONFUSED,   pat: /\b(confused|don.t understand|lost|what does|can.t figure|not sure|huh|idk|unclear|makes no sense)\b/i },
    /* Hopeful */
    { tone: EMOTION.HOPEFUL,    pat: /\b(hopeful|hoping|fingers crossed|maybe|could be|looking forward|optimistic|things will|tomorrow will|going to try|believe in|getting better)\b/i },
    /* Playful */
    { tone: EMOTION.PLAYFUL,    pat: /\b(lol|lmao|haha|hilarious|funny|joking|jk|kidding|just messing|you.re wild|crazy|roast|that.s fire|no way|bro|bruh|sus|for real|fr fr)\b/i }
  ];

  function detectEmotion(text) {
    if (!text) return EMOTION.NEUTRAL;
    for (var i = 0; i < _EMOTION_PATTERNS.length; i++) {
      if (_EMOTION_PATTERNS[i].pat.test(text)) {
        return _EMOTION_PATTERNS[i].tone;
      }
    }
    return EMOTION.NEUTRAL;
  }

  /* ─────────────────────────────────────────────────────────────
     GENERAL CONVERSATION INTENT DETECTION
     Returns true when the message is a general/casual/emotional
     conversation rather than a Shadow Nexus website question.
  ───────────────────────────────────────────────────────────────*/
  var _GENERAL_CONV_PATTERNS = [
    /* Greetings and farewells */
    /^(hey|hi|hello|howdy|what.s up|sup|yo|good (morning|afternoon|evening|night)|morning|night|bye|goodbye|later|see ya|see you|talk later|take care|peace)\s*[.!?]*$/i,
    /* "How are you" family */
    /^how are you|how.?re you|how.s it going|how.ve you been|you good|you okay|you alright|you ok\b/i,
    /* "I'm [feeling/state]" — with optional intensifier ("so", "really", "kinda", etc.) */
    /^i.m (so |really |kinda |kind of |very |pretty |a little |honestly |genuinely )?(bored|tired|sad|excited|happy|frustrated|anxious|confused|lost|okay|fine|good|great|terrible|awful|stressed|mad|angry)\b/i,
    /* Talk to me / open conversation */
    /\b(talk to me|let.s talk|tell me something|what should we talk|just want(ed)? to talk|need someone to talk|chat with me|keep me company)\b/i,
    /* What's up / small talk */
    /\b(what.s going on|anything new|what.s new|what.s happening|been up to|been doing)\b/i,
    /* Day/life discussion */
    /\b(my day|had a (rough|long|crazy|good|bad|great|weird|busy) day|today was|work was|school was|it.s been|been a (long|rough|crazy|good|tough) (day|week|month))\b/i,
    /* Feelings shared */
    /\b(i feel|feeling|i.m feeling|i.ve been feeling|been feeling)\b/i,
    /* Help me think / brainstorm */
    /\b(help me (think|brainstorm|figure out|decide|come up with|write)|let.s brainstorm|i need ideas|i.ve got an idea|what do you think (about|of)|thoughts on)\b/i,
    /* Music / creative */
    /\b(working on (a )?song|writing (a )?song|music (idea|project|track|beat)|lyrics|melody|my song|i finished (it|my song|the song|the track)|creative project|working on something)\b/i,
    /* Humor / banter */
    /\b(that.s funny|you.re (crazy|wild|funny|hilarious)|lol|lmao|haha|that cracked me up|no way|can.t stop laughing)\b/i,
    /* Acknowledgement responses */
    /^(thank you|thanks|ty|thx|ok|okay|cool|nice|got it|noted|alright|sounds good|makes sense|perfect|great|awesome|wow|ah|oh|right|yep|yeah|nope|nah|no|yes|yup|sure|fair enough|fair|true|exactly|definitely|absolutely|for real|fr)\s*[.!?]*$/i,
    /* Bored/venting */
    /\b(i.m bored|just bored|so bored|venting|rant|need to vent|just wanted to say|random thought|thought about)\b/i,
    /* Supportive requests */
    /\b(it.s (hard|tough|difficult)|i (don.t|didn.t) know what to do|just (needed|wanted) to (say|share|tell you)|been (thinking|struggling|dealing)|any (advice|tips|thoughts)|what would you do)\b/i
  ];

  function isGeneralConversation(text) {
    if (!text) return false;
    for (var i = 0; i < _GENERAL_CONV_PATTERNS.length; i++) {
      if (_GENERAL_CONV_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     LOCAL CASUAL CONVERSATION LAYER
     Small response families for very common exchanges.
     No Workers AI required for these.
  ───────────────────────────────────────────────────────────────*/
  var _CASUAL = {
    GREETING: [
      "Hey. Good to have you here.",
      "What's up.",
      "Hey — I'm here. What's on your mind?"
    ],
    GREETING_MORNING: [
      "Good morning. How's the day starting?",
      "Morning. What are we working with today?"
    ],
    GREETING_NIGHT: [
      "Good night. Hope the day treated you right.",
      "Night. Get some rest."
    ],
    HOW_ARE_YOU: [
      "I'm here and ready — what's going on with you?",
      "Doing what I do. More importantly, how are you?",
      "Sharp. Focused. In my element. What about you?"
    ],
    THANKS: [
      "You're welcome.",
      "Of course.",
      "Anytime."
    ],
    COOL: [
      "Solid.",
      "Nice.",
      "Good to hear."
    ],
    LOL: [
      "Ha. I see you.",
      "Glad that landed.",
      "Right?"
    ],
    BORED: [
      "I'm here. We can talk, brainstorm, work on something — what sounds right?",
      "Boredom is a starting point. What's been on your mind lately?",
      "Say the word. We can go wherever — conversation, creativity, whatever you need."
    ],
    GOODBYE: [
      "Take care. Come back anytime.",
      "Later. You know where to find me.",
      "See you. Stay up."
    ],
    TALK_TO_ME: [
      "I'm here. Start wherever you want — what's going on?",
      "All yours. What's on your mind?",
      "Ready. Where do we begin?"
    ]
  };

  function _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Try to answer a very common casual exchange locally.
   * Returns a response string or null (caller should route to Workers AI).
   */
  function localCasualAnswer(text) {
    if (!text) return null;
    var n = text.trim().toLowerCase().replace(/[!?.]+$/, '').trim();

    /* Greetings */
    if (/^(hey|hi|hello|howdy|yo|sup)$/.test(n)) return _pick(_CASUAL.GREETING);
    if (/^(good morning|morning)$/.test(n))       return _pick(_CASUAL.GREETING_MORNING);
    if (/^(good night|good evening|night|nite)$/.test(n)) return _pick(_CASUAL.GREETING_NIGHT);

    /* How are you */
    if (/^(how are you|how.?re you|how.s it going|you good|you okay|you ok|you alright)$/.test(n)) return _pick(_CASUAL.HOW_ARE_YOU);

    /* Thanks */
    if (/^(thank you|thanks|ty|thx|thank u|thankful)$/.test(n)) return _pick(_CASUAL.THANKS);

    /* Acknowledgements */
    if (/^(ok|okay|cool|nice|got it|noted|alright|sounds good|makes sense|perfect|great|awesome|wow|ah|oh|right|yep|yeah|yup|sure|fair enough|fair|true|exactly|definitely|absolutely|for real|fr|nah|nope|no|yes|solid|word)$/.test(n)) return _pick(_CASUAL.COOL);

    /* Humor banter */
    if (/^(lol|lmao|haha|hahaha|lolol|ha|hehe)$/.test(n)) return _pick(_CASUAL.LOL);

    /* I'm bored / just bored */
    if (/^(i.?m bored|just bored|so bored|bored)$/.test(n)) return _pick(_CASUAL.BORED);

    /* Goodbye */
    if (/^(bye|goodbye|later|see ya|see you|talk later|take care|peace|gotta go|catch you later|catch ya later)$/.test(n)) return _pick(_CASUAL.GOODBYE);

    /* Talk to me */
    if (/^(talk to me|let.s talk|chat with me|keep me company|i just want(ed)? to talk)$/.test(n)) return _pick(_CASUAL.TALK_TO_ME);

    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     EXTENDED LOCAL GENERAL CONVERSATION LAYER
     Handles richer everyday conversation turns locally —
     no Workers AI required for any of these.
     Called AFTER localCasualAnswer() returns null.
     Returns a response string or null.
     Never invents facts. Never fabricates knowledge.
     Preserves Shadow Reaper character voice.
  ───────────────────────────────────────────────────────────────*/
  var _GENERAL_RESPONSES = {
    ROUGH_DAY: [
      "Rough days happen. What made it rough?",
      "That sounds like a lot. I'm here — what's going on?",
      "I hear you. Sometimes the day just takes it out of you. What happened?"
    ],
    SONG_WORKING: [
      "A song in progress — I respect that. Where are you with it?",
      "Working on music is real work. What stage are you at?",
      "That's where the real craft happens. What's it sounding like so far?"
    ],
    GIRLFRIEND_BREAKUP: [
      "That's not easy. How are you holding up?",
      "Breakups cut deep. Take your time — I'm here if you want to talk through it.",
      "That kind of loss is real. How are you feeling right now?"
    ],
    BORED_GENERAL: [
      "Boredom means your mind's free. What's been sitting in the back of your head?",
      "I'm here. We can go anywhere — work on something, talk, or just run it.",
      "Say the word. What sounds right — conversation, creativity, or something else?"
    ],
    HELP_THINK: [
      "I'm here for it. What are we thinking through?",
      "Walk me through it — what's the situation?",
      "Lay it out. I'll help you work through it."
    ],
    SHADOW_NEXUS_GENERAL: [
      "Shadow Nexus Social is a platform built for creators and communities — Radio, Live, TV, Feed, and more. What do you want to know?",
      "Shadow Nexus is Chris's creation — a full platform with streaming, social features, and creator tools. What aspect interests you?"
    ],
    SAD_GENERAL: [
      "I hear you. You don't have to push through it alone — what's going on?",
      "That kind of feeling is real. What's weighing on you?",
      "I'm not going anywhere. Tell me what's happening."
    ],
    FRUSTRATED_GENERAL: [
      "That sounds frustrating. What's the situation?",
      "I can see why that's aggravating. What happened?",
      "Walk me through it — what's going wrong?"
    ],
    EXCITED_GENERAL: [
      "Let's hear it — what's got you going?",
      "I can feel the energy from here. What's happening?",
      "Tell me everything."
    ],
    TIRED_GENERAL: [
      "Sounds like you need a moment. What's been going on?",
      "Take it at your pace. What's been draining you?",
      "Long stretch. What's been keeping you going?"
    ],
    CONTINUE_CONV: [
      "Still here. What else is on your mind?",
      "I'm listening. Keep going.",
      "Take your time. What else?"
    ],
    IDEA_BRAINSTORM: [
      "Let's hear it — what's the idea?",
      "I'm in. Walk me through what you're thinking.",
      "What's the concept? Start wherever feels right."
    ],
    HOW_DOES_RADIO_WORK: [
      "Shadow Nexus Radio is a live streaming radio station. The Founder controls the station — listeners tune in from the Radio section. There's also a Request system where signed-in listeners can request songs. Want to know more about how it works?",
      "Radio on Shadow Nexus is a continuous stream managed from the Radio Studio. Listeners can tune in, request songs, and see what's playing. What specifically do you want to know?"
    ],
    RELATIONSHIP_GENERAL: [
      "That's a lot to carry. What's the situation?",
      "Relationships are complicated. What's going on?",
      "I'm here. Walk me through it."
    ],
    LONELY_GENERAL: [
      "I'm here. You're not talking to nobody — I'm with you. What's going on?",
      "That feeling is real. What's been happening?",
      "You reached out — that counts. What's on your mind?"
    ],
    WORKING_ON_SOMETHING: [
      "Tell me about it. What are you building?",
      "I like it when people are building things. What's the project?",
      "What are you working on? I'm listening."
    ],
    DEFAULT_GENERAL: [
      "I'm here. Tell me more.",
      "Go on — I'm listening.",
      "What else is going on?"
    ]
  };

  function _pickGeneral(key) {
    var arr = _GENERAL_RESPONSES[key] || _GENERAL_RESPONSES.DEFAULT_GENERAL;
    return arr[Math.floor(Math.random() * arr.length)];
  }

  /**
   * Extended local general conversation handler.
   * Returns a response string or null (very rare fallback).
   * Never calls Workers AI — this IS the local general conversation brain.
   * @param {string} text  — user message (corrected, lowercase)
   * @param {string} tone  — detected EMOTION constant
   * @returns {string|null}
   */
  function localGeneralAnswer(text, tone) {
    if (!text) return null;
    var n = text.trim().toLowerCase();

    /* ── Rough day / bad day ─────────────────────────────────── */
    if (/\b(rough|long|bad|crazy|tough|hard|exhausting|terrible|awful|brutal|horrible)\s+(day|week|month|night)\b/i.test(n) ||
        /\b(my day|today was|been a (rough|long|bad|crazy|tough|hard) (day|week))\b/i.test(n)) {
      return _pickGeneral('ROUGH_DAY');
    }

    /* ── Song / music project ────────────────────────────────── */
    if (/\b(working on (a )?song|writing (a )?song|finishing (a )?song|recording|my (new )?song|the (new )?song|my (new )?track|the track|the beat|my beat|new album|working on (an )?album)\b/i.test(n)) {
      return _pickGeneral('SONG_WORKING');
    }

    /* ── Breakup / relationship end ──────────────────────────── */
    if (/\b(broke up|break.?up|broken up|she (left|dumped)|he (left|dumped)|girlfriend (left|broke|ended)|boyfriend (left|broke|ended)|ended (the|our) relationship|she.s gone|we broke up|split up)\b/i.test(n)) {
      return _pickGeneral('GIRLFRIEND_BREAKUP');
    }

    /* ── Lonely ───────────────────────────────────────────────── */
    if (/\b(feel(ing)? alone|feel(ing)? lonely|so alone|no one (to talk to|around|cares)|talking to nobody|nobody (gets|understands|cares)|miss(ing)? (someone|people|them))\b/i.test(n)) {
      return _pickGeneral('LONELY_GENERAL');
    }

    /* ── Sad / down ───────────────────────────────────────────── */
    if (tone === 'SAD' || /\b(feel(ing)? (sad|down|depressed|low|blue|empty|hollow|hurt|heartbroken)|i.m sad|i.m down|i.m heartbroken|crying|cried|i cry)\b/i.test(n)) {
      return _pickGeneral('SAD_GENERAL');
    }

    /* ── Frustrated ───────────────────────────────────────────── */
    if (tone === 'FRUSTRATED' || tone === 'ANGRY') {
      return _pickGeneral('FRUSTRATED_GENERAL');
    }

    /* ── Excited ──────────────────────────────────────────────── */
    if (tone === 'EXCITED' || tone === 'HAPPY') {
      return _pickGeneral('EXCITED_GENERAL');
    }

    /* ── Tired / exhausted ────────────────────────────────────── */
    if (tone === 'TIRED' || /\b(exhausted|so tired|burnt out|burnout|drained|no energy|barely (made it|awake|keeping up))\b/i.test(n)) {
      return _pickGeneral('TIRED_GENERAL');
    }

    /* ── Help me think / brainstorm ──────────────────────────── */
    if (/\b(help me (think|brainstorm|figure out|decide|come up with)|let.s (brainstorm|think|talk through)|i need (ideas|help thinking)|i.ve got an idea|what do you think (about|of)|thoughts on|can we talk through)\b/i.test(n)) {
      return _pickGeneral('HELP_THINK');
    }

    /* ── Idea / project ─────────────────────────────────────────  */
    if (/\b(i have an idea|new idea|concept|had a thought|been thinking about|i.ve been working on|working on (a |my )?(new |secret )?(project|thing|app|site|feature))\b/i.test(n)) {
      return _pickGeneral('IDEA_BRAINSTORM');
    }

    /* ── Bored ───────────────────────────────────────────────── */
    if (/\b(i.m bored|so bored|just bored|bored out|nothing to do|got nothing (going on|to do))\b/i.test(n)) {
      return _pickGeneral('BORED_GENERAL');
    }

    /* ── How does radio work ─────────────────────────────────── */
    if (/\bhow does (the )?radio (work|operate|function)\b/i.test(n) ||
        /\btell me (about|how) (the )?radio\b/i.test(n)) {
      return _pickGeneral('HOW_DOES_RADIO_WORK');
    }

    /* ── Shadow Nexus general ─────────────────────────────────── */
    if (/\btell me about shadow nexus\b/i.test(n) ||
        /\bwhat is shadow nexus( social)?\b/i.test(n)) {
      return _pickGeneral('SHADOW_NEXUS_GENERAL');
    }

    /* ── Relationship general ─────────────────────────────────── */
    if (/\b(my (girlfriend|boyfriend|partner|wife|husband|ex)|relationship (issue|problem|trouble)|we (fought|argued|had a fight)|they (don.t|won.t)|love (is|was))\b/i.test(n)) {
      return _pickGeneral('RELATIONSHIP_GENERAL');
    }

    /* ── Project named / called ──────────────────────────────── */
    if (/\b(?:my |the )?project (?:is called|is named|called|named)\b/i.test(n) ||
        /\bi(?:'?m| am) (?:calling|naming) (?:it|the project)\b/i.test(n)) {
      return _pickGeneral('WORKING_ON_SOMETHING');
    }

    /* ── Design / style decision ─────────────────────────────── */
    if (/\bi want (?:it|the (?:homepage|page|design|background|theme|layout))\b/i.test(n) ||
        /\b(?:blue lightning|dark theme|dark background|dark mode|neon background)\b/i.test(n) ||
        /\bi(?:'?m| am) working on (?:the )?(?:homepage|landing page|dashboard|settings page|about page|nav|header|footer)\b/i.test(n)) {
      return _pickGeneral('WORKING_ON_SOMETHING');
    }

    /* ── Working on something ─────────────────────────────────── */
    if (/\b(working on (it|something|a thing|this|that|a new|my)|i.m building|building (a |something|it)|starting (a |something)|i started)\b/i.test(n)) {
      return _pickGeneral('WORKING_ON_SOMETHING');
    }

    /* ── Continuation / acknowledgement with substance ─────────── */
    if (/\b(what else|tell me more|go on|and\?|keep going|i.m listening|continue|go ahead|what next|anyway|as i was saying)\b/i.test(n)) {
      return _pickGeneral('CONTINUE_CONV');
    }

    /* ── Can we talk / I need to talk ────────────────────────── */
    if (/\b(can we talk|i need (to talk|someone to talk to)|i just (want|wanted) to talk|need to (vent|talk))\b/i.test(n)) {
      return _pickGeneral('HELP_THINK');
    }

    /* ── Default fallback for any unmatched GENERAL_CONVERSATION ── */
    return _pickGeneral('DEFAULT_GENERAL');
  }

  /* ─────────────────────────────────────────────────────────────
     RESPONSE STYLE ADAPTER
     Returns a style modifier object the server-side prompt can use.
     Does NOT change the core system prompt — adds a conversational
     tone hint for Workers AI calls on general conversation turns.
  ───────────────────────────────────────────────────────────────*/
  var _STYLE = {
    NEUTRAL:    { label: 'NEUTRAL',    hint: 'Normal Shadow Reaper personality. Calm, direct, natural.' },
    HAPPY:      { label: 'HAPPY',      hint: 'Warm and upbeat tone. Match the positive energy naturally.' },
    EXCITED:    { label: 'EXCITED',    hint: 'Slightly more energetic and celebratory, but not over the top.' },
    SAD:        { label: 'SAD',        hint: 'Warmer, gentler tone. Acknowledge what they said before anything else.' },
    FRUSTRATED: { label: 'FRUSTRATED', hint: 'Calmer, practical, patient. Do not match frustration — de-escalate naturally.' },
    ANGRY:      { label: 'ANGRY',      hint: 'Calm, non-confrontational. Acknowledge without fueling the energy.' },
    ANXIOUS:    { label: 'ANXIOUS',    hint: 'Grounding and measured. Clear, reassuring — not dismissive.' },
    CONFUSED:   { label: 'CONFUSED',   hint: 'Clearer phrasing, shorter sentences, step-by-step if needed.' },
    TIRED:      { label: 'TIRED',      hint: 'Concise, lower-pressure response. Do not demand much from them.' },
    HOPEFUL:    { label: 'HOPEFUL',    hint: 'Supportive and encouraging. Reinforce without over-promising.' },
    PLAYFUL:    { label: 'PLAYFUL',    hint: 'More relaxed. Light humor is appropriate when the user leads that way.' }
  };

  function getStyleHint(tone) {
    return (_STYLE[tone] || _STYLE.NEUTRAL).hint;
  }

  /* ─────────────────────────────────────────────────────────────
     E1 SESSION CONTEXT — memory-only, never persisted
     Extends the conversation for general/everyday turns.
     Tracks recent conversational subjects for pronoun resolution.
  ───────────────────────────────────────────────────────────────*/
  var _e1Ctx = {
    currentTone:     EMOTION.NEUTRAL,  // latest detected conversational tone
    lastConvTopic:   null,             // last general conversation subject (string)
    lastConvTopics:  [],               // ring buffer, last 3 conv subjects
    prevTone:        EMOTION.NEUTRAL,  // tone before current turn
    generalTurns:    0,                // how many general conversation turns this session
    lastWasGeneral:  false,            // true if previous turn was a general conv turn
    lastWasWebsite:  false             // true if previous turn was a website knowledge turn
  };

  function _resetE1Ctx() {
    _e1Ctx.currentTone    = EMOTION.NEUTRAL;
    _e1Ctx.lastConvTopic  = null;
    _e1Ctx.lastConvTopics = [];
    _e1Ctx.prevTone       = EMOTION.NEUTRAL;
    _e1Ctx.generalTurns   = 0;
    _e1Ctx.lastWasGeneral = false;
    _e1Ctx.lastWasWebsite = false;
  }

  /**
   * Update E1 session context after a general conversation turn.
   * @param {string} text  — original user message
   * @param {string} tone  — detected EMOTION constant
   * @param {string} topic — extracted conversation subject (optional)
   */
  function updateConvContext(text, tone, topic) {
    _e1Ctx.prevTone      = _e1Ctx.currentTone;
    _e1Ctx.currentTone   = tone || EMOTION.NEUTRAL;
    _e1Ctx.generalTurns++;
    _e1Ctx.lastWasGeneral = true;
    _e1Ctx.lastWasWebsite = false;
    if (topic) {
      _e1Ctx.lastConvTopic = topic;
      _e1Ctx.lastConvTopics.unshift(topic);
      if (_e1Ctx.lastConvTopics.length > 3) _e1Ctx.lastConvTopics.pop();
    }
  }

  /**
   * Mark that this turn was handled by the website knowledge engine.
   * Keeps E1 context intact so user can return to conversation.
   */
  function markWebsiteTurn() {
    _e1Ctx.lastWasWebsite = true;
    _e1Ctx.lastWasGeneral = false;
  }

  /* ─────────────────────────────────────────────────────────────
     CONVERSATION TOPIC EXTRACTOR
     Extracts a simple subject tag from general conversation for
     context continuity. Returns null if nothing specific found.
  ───────────────────────────────────────────────────────────────*/
  var _TOPIC_EXTRACTORS = [
    { pat: /\b(working on (a )?song|writing (a )?song|my song|the song|the track)\b/i, topic: 'song' },
    { pat: /\b(music|track|beat|lyrics|melody|chord|hook|verse|chorus)\b/i,           topic: 'music' },
    { pat: /\b(work|job|boss|coworker|office|shift|project at work)\b/i,               topic: 'work' },
    { pat: /\b(school|class|homework|assignment|test|exam|study)\b/i,                  topic: 'school' },
    { pat: /\b(relationship|partner|girlfriend|boyfriend|wife|husband|breakup|dating)\b/i, topic: 'relationship' },
    { pat: /\b(creative project|art|design|writing|film|video|podcast)\b/i,            topic: 'creative project' },
    { pat: /\b(my day|today|rough day|long day|crazy day|busy day)\b/i,                topic: 'day' },
    { pat: /\b(idea|ideas|brainstorm|concept|plan)\b/i,                                topic: 'idea' },
    { pat: /\b(game|gaming|playing)\b/i,                                               topic: 'gaming' }
  ];

  function extractConvTopic(text) {
    for (var i = 0; i < _TOPIC_EXTRACTORS.length; i++) {
      if (_TOPIC_EXTRACTORS[i].pat.test(text)) return _TOPIC_EXTRACTORS[i].topic;
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     CONVERSATION CONTEXT RESOLVER
     Resolves pronouns within general conversation context window.
     Example: "I finally finished it" → inject last conv topic.
     Does NOT interfere with website knowledge context resolution.
  ───────────────────────────────────────────────────────────────*/
  function resolveConvContext(text) {
    if (!text || !_e1Ctx.lastConvTopic) return text;
    var lower = text.toLowerCase().trim();
    /* Only resolve on short messages with pronouns */
    if (lower.length > 120) return text;
    var pronounRef = /\b(it|this|that|the thing|the project|the idea|the song|the track)\b/i;
    if (pronounRef.test(lower)) {
      /* Inject the last known conversational topic as context */
      return text + ' [topic: ' + _e1Ctx.lastConvTopic + ']';
    }
    return text;
  }

  /* ─────────────────────────────────────────────────────────────
     PERSONA INSTRUCTIONS FOR WORKERS AI (GENERAL CONVERSATION)
     Sent as additional context when routing general conversation
     to Workers AI. Kept minimal — no website internals, no secrets.
  ───────────────────────────────────────────────────────────────*/
  function buildConvSystemContext(tone, recentTopics) {
    var styleHint = getStyleHint(tone);
    var topicNote = recentTopics && recentTopics.length
      ? 'Recent conversation topics: ' + recentTopics.slice(0, 2).join(', ') + '.'
      : '';

    return {
      conversationalMode: true,
      toneHint:           tone,
      styleHint:          styleHint,
      recentConvTopics:   recentTopics ? recentTopics.slice(0, 2) : [],
      conversationNote:   topicNote,
      personaNote:        'This is a general everyday conversation turn — not a Shadow Nexus website question. Respond as Shadow Reaper: calm, loyal, supportive, occasionally humorous, with a dark/cinematic flavor that does not overwhelm normal conversation. Do NOT claim to have human feelings or personal experiences. Use phrases like "That sounds frustrating" or "I can see why" rather than "I know exactly how you feel." Keep the response natural and conversational — not clinical or overly formal. You may relate back to what the user has already shared in this conversation.'
    };
  }

  /* ─────────────────────────────────────────────────────────────
     HIGH-RISK CONVERSATION HANDLER
     Warm safety-oriented response without diagnosing.
     Normal sadness/frustration does NOT trigger this.
     Only severe explicit distress language.
  ───────────────────────────────────────────────────────────────*/
  var _HIGH_RISK_PAT = /(suicide|kill myself|end my life|want to die|dont want to live|self.harm|hurt myself)/i;

  function isHighRisk(text) {
    return _HIGH_RISK_PAT.test(text || '');
  }

  /* ─────────────────────────────────────────────────────────────
     TOPIC SWITCH DETECTION
     Detects when the user switches from general conversation to
     a Shadow Nexus question. The locked core's knowledge engine
     handles it — E1 just marks the context switch cleanly.
  ───────────────────────────────────────────────────────────────*/
  var _RETURN_TO_TOPIC_PAT = /\b(anyway|back to (what|that|what we were|it)|so back to|where were we|as i was (saying|talking)|going back)\b/i;

  function isReturnToTopic(text) {
    return _RETURN_TO_TOPIC_PAT.test(text || '');
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API  — window.SNXShadowE1
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowE1 = {

    /** Build identifier */
    build: BUILD_ID,

    /** Emotion constants */
    EMOTION: EMOTION,

    /**
     * Detect likely conversational tone from a message.
     * @param {string} text
     * @returns {string} EMOTION constant
     */
    detectEmotion: detectEmotion,

    /**
     * Returns true if the message is a general/everyday conversation turn
     * rather than a Shadow Nexus website question.
     * @param {string} text
     * @returns {boolean}
     */
    isGeneralConversation: isGeneralConversation,

    /**
     * Returns true if the message matches high-risk language.
     * (Crisis response is handled by the locked core; this is for testing.)
     * @param {string} text
     * @returns {boolean}
     */
    isHighRisk: isHighRisk,

    /**
     * Try to answer a very common casual exchange locally (no Workers AI).
     * @param {string} text
     * @returns {string|null} response text or null
     */
    localCasualAnswer: localCasualAnswer,

    /**
     * Extended local general conversation handler.
     * Handles richer everyday conversation turns without Workers AI.
     * Called AFTER localCasualAnswer() returns null.
     * Returns a response string. This function always returns a string
     * (never null) to ensure Workers AI is never needed for general conv.
     * @param {string} text  — user message
     * @param {string} tone  — detected EMOTION constant
     * @returns {string}
     */
    localGeneralAnswer: localGeneralAnswer,

    /**
     * Get response style hint for the given tone.
     * @param {string} tone  EMOTION constant
     * @returns {string}
     */
    getStyleHint: getStyleHint,

    /**
     * Extract a conversation topic tag from a message.
     * @param {string} text
     * @returns {string|null}
     */
    extractConvTopic: extractConvTopic,

    /**
     * Resolve pronouns in general conversation context.
     * @param {string} text
     * @returns {string}
     */
    resolveConvContext: resolveConvContext,

    /**
     * Build the conversational context block to include in Workers AI requests
     * for general conversation turns.
     * @param {string} tone   EMOTION constant
     * @param {string[]} recentTopics
     * @returns {object}
     */
    buildConvSystemContext: buildConvSystemContext,

    /**
     * Update E1 session context after a general conversation turn.
     * @param {string} text   original user message
     * @param {string} tone   detected EMOTION constant
     * @param {string} topic  extracted topic tag (optional)
     */
    updateConvContext: updateConvContext,

    /**
     * Mark that this turn was handled by the website knowledge engine.
     * Preserves E1 conversation context for potential return.
     */
    markWebsiteTurn: markWebsiteTurn,

    /**
     * Returns true if the message is a "return to previous topic" signal.
     * @param {string} text
     * @returns {boolean}
     */
    isReturnToTopic: isReturnToTopic,

    /**
     * Returns the current safe E1 session context (no user data, no history, no tokens).
     * @returns {object}
     */
    getConvContext: function () {
      return {
        currentTone:     _e1Ctx.currentTone,
        lastConvTopic:   _e1Ctx.lastConvTopic,
        lastConvTopics:  _e1Ctx.lastConvTopics.slice(),
        prevTone:        _e1Ctx.prevTone,
        generalTurns:    _e1Ctx.generalTurns,
        lastWasGeneral:  _e1Ctx.lastWasGeneral,
        lastWasWebsite:  _e1Ctx.lastWasWebsite
      };
    },

    /**
     * Full teardown — clears all E1 session context.
     * Call when SNXShadowAI.destroy() is called.
     * No permanent storage was used — nothing to flush.
     */
    destroy: function () {
      _resetE1Ctx();
    },

    /**
     * Idempotent init — no-op beyond existence check.
     */
    init: function () {
      /* Nothing to initialize — stateless except session context (already reset) */
    }
  };

})(window);
