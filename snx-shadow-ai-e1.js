/**
 * snx-shadow-ai-e1.js
 * Shadow Nexus Social — Shadow Reaper E1: Everyday Conversation & Emotional Intelligence
 *
 * Build: SNS-2026-SHADOW-EMOTION-E1-RC1
 *
 * Exposes: window.SNXShadowE1
 *
 * E1 Enhancement (layered ON TOP of the locked production core):
 *  • GENERAL_CONVERSATION intent classification
 *  • Lightweight emotional-context detection (11 tone states)
 *  • Local casual conversation layer (common exchanges — no Workers AI)
 *  • Conversation context window for pronoun/topic continuity across general turns
 *  • Topic switch detection: website question mid-conversation correctly routes to core
 *  • Creative brainstorming, music discussion, humor-aware tone
 *  • Response style adaptation per detected emotional tone
 *  • Persona instructions for Workers AI general conversation pass-through
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

  var BUILD_ID = 'SNS-2026-SHADOW-EMOTION-E1-RC1';

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
