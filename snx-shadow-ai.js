/**
 * snx-shadow-ai.js
 * Shadow Nexus Social — Shadow Reaper AI Core
 *
 * Build: SNS-2026-SHADOW-VOICE-4A-001 / E1-RC1
 *
 * Exposes: window.SNXShadowAI
 *
 * Stage 3C additions (Deep Intelligence, over Stage 3B):
 *  • SESSION CONTEXT ENGINE: lightweight short-term context tracking
 *      - lastTopic, lastFeature, lastCreatorTopic, lastIntent
 *      - recentIds[], recentNavTarget, turnCount
 *      - pronoun/follow-up resolution ("it", "he", "that feature")
 *  • INTENT DETECTION: deterministic local classification
 *      QUESTION | NAVIGATION | HOW_TO | TROUBLESHOOT | CREATOR |
 *      FEATURE | PERMISSION | ACCOUNT | PRIVACY | SAFETY | STATUS | UNKNOWN
 *  • TYPO TOLERANCE: pre-normalization fuzzy corrections before scoring
 *      (radieo→radio, notifacations→notifications, etc.)
 *  • CLARIFICATION ENGINE: detects ambiguous multi-feature queries
 *      and asks ONE focused question rather than guessing wrong.
 *  • LOCAL ANSWER COMPOSER: multi-record combination, depth control
 *      (concise | step-by-step | expanded), dedup, related hints.
 *  • ANSWER DEPTH CONTROL: "step by step" / "tell me more" / "explain"
 *  • FEATURE RELATIONSHIP ANSWERS: "difference between X and Y" local.
 *  • "WHAT CAN YOU DO?" handler — fully local, accurate capabilities.
 *  • Updated local-first routing pipeline:
 *      PRIVACY/SAFETY GUARD
 *      → NAVIGATION COMMAND
 *      → CONTEXT RESOLUTION (pronoun/follow-up)
 *      → TYPO CORRECTION
 *      → INTENT DETECTION
 *      → LOCAL KNOWLEDGE (HIGH/MEDIUM → answer, no AI)
 *      → LOCAL ANSWER COMPOSITION
 *      → CONFIDENCE CHECK
 *      → LOW/NONE → Workers AI with grounding snippets
 *
 * Stage 3B additions (still active):
 *  • Creator Knowledge (32 records, 8 categories).
 *  • Creator privacy guard — blocks private info from Workers AI.
 *  • Creator grounding flag for Workers AI context.
 *
 * Stage 3A additions (still active):
 *  • LOCAL-FIRST routing pipeline.
 *  • retrieveKnowledge() / answerLocally() confidence-gated answers.
 *  • AI-limit mode: FREE_ALLOCATION_EXHAUSTED → LOCAL KNOWLEDGE MODE.
 *
 * Design constraints (unchanged):
 *  • Does NOT create another floating button, panel, or navigation item.
 *  • Does NOT restart Radio, TV, Live, Firebase, or the existing GP canvas RAF.
 *  • Does NOT add itself to startup — loaded only when the user opens the panel.
 *  • Idempotent: safe to call init() / open() multiple times.
 *  • No eval(), no new Function(), no unsanitized innerHTML.
 *  • Conversation history is memory-only for this session (≤ 20 pairs).
 *  • Session context is memory-only — NOT permanently stored.
 *  • No tokens, credentials, or secrets ever sent to or stored in the frontend.
 *
 * Integration point: toggleGrimPanel() in index.html calls
 *   SNXFeatureLoader.loadFeature('shadow-ai') then SNXShadowAI.open()
 *   after the feature loads.  The existing GP.init() path is preserved
 *   unchanged as the fallback when the feature has not loaded yet.
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var MAX_HISTORY = 20; // max conversation turns (user+grim pairs) — bounded for server
  var BUILD_ID    = 'SNS-2026-SHADOW-VOICE-4A-001';
  var E1_BUILD_ID = 'SNS-2026-SHADOW-EMOTION-E1-RC1';
  var E2_BUILD_ID = 'SNS-2026-SHADOW-MEMORY-E2-RC1';

  /* Cloudflare Worker AI endpoint — never put an API key here */
  var AI_ENDPOINT = 'https://yellow-term-11e6.nthntjrn.workers.dev/shadow-ai/chat';

  /* Client-side timeout for AI requests (ms) */
  var AI_TIMEOUT_MS = 20000;

  /* Client-side navigation whitelist — mirrors server whitelist */
  var AI_NAV_WHITELIST = {
    feed:true, profile:true, search:true, notifications:true,
    settings:true, inbox:true, friends:true, community:true,
    rules:true, arcade:true, stormrooms:true, supportrooms:true,
    radio:true, live:true, tv:true
  };

  /* Status values shown in the panel status bar */
  var STATUS = {
    READY:    'READY',
    THINKING: 'THINKING',
    OFFLINE:  'OFFLINE',
    ERROR:    'ERROR'
  };

  /* ─────────────────────────────────────────────────────────────
     MODULE STATE — private
  ───────────────────────────────────────────────────────────────*/
  var _initialized  = false;
  var _open         = false;
  var _busy         = false;       // rapid-send protection
  var _reqSeq       = 0;           // monotonic request id
  var _history      = [];          // [{role:'user'|'grim', text:string}]
  var _listeners    = [];          // reserved

  /* Stage 4B: character state hooks */
  var _thinkingListeners = [];
  var _answerListeners   = [];

  /* AI-limit mode — set to true when FREE_ALLOCATION_EXHAUSTED is received.
     Once true for the session, skip Workers AI entirely and use local knowledge.
     Shadow Reaper degrades gracefully rather than appearing broken. */
  var _aiLimitMode  = false;

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: SESSION CONTEXT  — memory-only, never persisted
     Tracks lightweight short-term state within this session.
     Context is reset on destroy(). NOT stored to localStorage, DB, or cookies.
  ───────────────────────────────────────────────────────────────*/
  var _sessionCtx = {
    lastTopic:        null,   // human-readable last subject (e.g. "Radio")
    lastFeature:      null,   // canonical feature key (e.g. "radio")
    lastCreatorTopic: null,   // last creator sub-topic (e.g. "music")
    lastIntent:       null,   // last classified intent string
    recentIds:        [],     // last 3 knowledge entry IDs answered
    recentNavTarget:  null,   // last navigation target used
    turnCount:        0,      // number of turns in this session
    pendingClarify:   null    // stored clarification question state
  };

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: TYPO CORRECTION TABLE
     Maps common misspellings → corrected form (pre-normalize step).
     Applied BEFORE scoring. Do not make so aggressive it overrides valid words.
  ───────────────────────────────────────────────────────────────*/
  var _TYPO_MAP = {
    'radieo':         'radio',
    'rdaio':          'radio',
    'radoi':          'radio',
    'radi0':          'radio',
    'livve':          'live',
    'liev':           'live',
    'livestream':     'live',
    'live stream':    'live',
    'livesutraming':  'live',
    'notifacations':  'notifications',
    'notificatons':   'notifications',
    'notifcations':   'notifications',
    'notifictions':   'notifications',
    'notifcatins':    'notifications',
    'messeges':       'inbox',
    'messags':        'inbox',
    'messsages':      'inbox',
    'masseges':       'inbox',
    'shdow nexus':    'shadow nexus',
    'shaodw nexus':   'shadow nexus',
    'shadow nxus':    'shadow nexus',
    'sdhaow nexus':   'shadow nexus',
    'shoadow nexus':  'shadow nexus',
    'snx':            'shadow nexus',
    'sns':            'shadow nexus social',
    'setings':        'settings',
    'settigns':       'settings',
    'setttings':      'settings',
    'setingss':       'settings',
    'profle':         'profile',
    'proifle':        'profile',
    'prifole':        'profile',
    'freinds':        'friends',
    'freids':         'friends',
    'firends':        'friends',
    'frieds':         'friends',
    'serach':         'search',
    'saerch':         'search',
    'seach':          'search',
    'accuont':        'account',
    'acount':         'account',
    'accont':         'account',
    'inbax':          'inbox',
    'inboc':          'inbox',
    'chirs':          'chris',
    'criss':          'chris',
    'chrsi':          'chris',
    'chis':           'chris',
    'arkade':         'arcade',
    'arcadde':        'arcade',
    'comunity':       'community',
    'commuity':       'community',
    'communtiy':      'community',
    'upploads':       'uploads',
    'uplads':         'uploads',
    'upoad':          'uploads',
    'saftey':         'safety',
    'privacey':       'privacy',
    'privicy':        'privacy',
    'camra':          'camera',
    'camrea':         'camera',
    'cammera':        'camera',
    'microfone':      'microphone',
    'micraphone':     'microphone',
    'microhpone':     'microphone',
    'vidio':          'video',
    'vidoe':          'video',
    'vido':           'video',
    'instal':         'install',
    'installapp':     'install app',
    'televsion':      'television',
    'televison':      'television',
    'livee':          'live',
    'liive':          'live',
    'raido':          'radio',
    'radeo':          'radio'
  };

  /* Apply typo corrections to raw user input before processing */
  function _correctTypos(text) {
    if (!text) return text;
    var lower = text.toLowerCase();
    var out   = lower;
    Object.keys(_TYPO_MAP).forEach(function (bad) {
      if (out.indexOf(bad) !== -1) {
        out = out.split(bad).join(_TYPO_MAP[bad]);
      }
    });
    /* Preserve original casing structure if nothing changed */
    return out === lower ? text : out;
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: INTENT DETECTION
     Deterministic, local, no AI required.
     Returns one of:
       NAVIGATION | HOW_TO | TROUBLESHOOT | CREATOR | FEATURE |
       PERMISSION | ACCOUNT | PRIVACY | SAFETY | STATUS | QUESTION | UNKNOWN
  ───────────────────────────────────────────────────────────────*/
  var _INTENT_PATTERNS = [
    { intent: 'SAFETY',      pattern: /(suicide|kill myself|end my life|want to die|dont want to live|self.harm|hurt myself)/i },
    { intent: 'PRIVACY',     pattern: /(password|credentials|token|secret|api key|home address|private email|private message|sister.s name)/i },
    { intent: 'NAVIGATION',  pattern: /^(take me|go to|open|navigate to|show me|get me|bring me)\s+(to\s+)?/i },
    { intent: 'NAVIGATION',  pattern: /\b(open|show|go to)\s+(radio|live|tv|feed|inbox|settings|search|notifications|friends|community|arcade|rooms|profile)\b/i },
    { intent: 'HOW_TO',      pattern: /\bhow (do i|can i|to)\s+(go live|start|send|post|create|upload|add|edit|change|request|install|join|get|become|invite|watch|listen|use|play)\b/i },
    { intent: 'HOW_TO',      pattern: /\b(steps|step by step|walk me through|guide me|how do i|how can i)\b/i },
    { intent: 'TROUBLESHOOT',pattern: /\b(not working|broken|won.t|wont|doesn.t|doesnt|can.t|cant|isnt|isn.t|error|problem|issue|fix|help|stuck|failing|fail|blocked|denied|not playing|no sound|no audio|loading|buffering|freezing|freeze|crash|black screen)\b/i },
    { intent: 'TROUBLESHOOT',pattern: /\b(my (camera|mic|microphone|video|audio|stream|radio|tv|feed|profile|upload|notification|message|account|login|sign))\b.{0,40}(not|won.t|can.t|isn.t|broken|stuck|error)/i },
    { intent: 'PERMISSION',  pattern: /\b(can (guests?|i|users?|members?|viewers?|anyone))\s+(use|watch|listen|request|post|comment|chat|access|view|join|go live|send|upload|react|do)/i },
    { intent: 'ACCOUNT',     pattern: /\b(sign in|sign out|log in|log out|sign up|register|delete account|forgot password|reset password|password|account|session expired|create account)\b/i },
    { intent: 'CREATOR',     pattern: /\b(who (is|was|created|built|made|founded|owns?)|chris|legend of shadows|the creator|the founder|stay legendary|why (he|chris)|his (music|story|sister|values|symbols))\b/i },
    { intent: 'STATUS',      pattern: /\b(what can you do|what do you know|can you help|what can i ask|what are you|who are you|your capabilities|what is shadow reaper)\b/i },
    { intent: 'FEATURE',     pattern: /\b(what is|how does|tell me about|explain)\s+(radio|live|tv|feed|inbox|notifications|search|friends|community|arcade|storm rooms|support rooms|profile|settings|uploads|pwa|dj|cohost|pwas|channel)\b/i },
    { intent: 'QUESTION',    pattern: /\b(what|where|when|who|why|which|does|is|are|can)\b/i },
    { intent: 'GENERAL_CONVERSATION', pattern: /^(hey|hi|hello|howdy|what.s up|sup|yo|good (morning|afternoon|evening|night)|morning|night|bye|goodbye|later|see ya|see you|talk later|take care)\s*[.!?]*$/i },
    { intent: 'GENERAL_CONVERSATION', pattern: /\b(talk to me|let.s talk|tell me something|i.m (bored|tired|sad|excited|frustrated)|my day|had a (rough|long|crazy|good|bad|great|weird|busy) day|i feel|feeling|lol|lmao|haha|thank you|thanks|ok|okay|cool|nice|help me think|help me brainstorm|working on (a )?song|i.ve got an idea)\b/i }
  ];

  function _detectIntent(text) {
    var norm = (text || '').toLowerCase();
    for (var i = 0; i < _INTENT_PATTERNS.length; i++) {
      if (_INTENT_PATTERNS[i].pattern.test(norm)) {
        return _INTENT_PATTERNS[i].intent;
      }
    }
    return 'UNKNOWN';
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: FEATURE CONTEXT TABLE
     Maps user-spoken feature names → canonical feature key
  ───────────────────────────────────────────────────────────────*/
  var _FEATURE_NAMES = {
    'radio':          'radio',
    'radio studio':   'radio_studio',
    'dj':             'dj',
    'dj mode':        'dj',
    'live':           'live',
    'live stream':    'live',
    'stream':         'live',
    'cohost':         'cohost',
    'co-host':        'cohost',
    'tv':             'tv',
    'tv studio':      'tv_studio',
    'television':     'tv',
    'nexus tv':       'tv',
    'feed':           'feed',
    'eclipse feed':   'feed',
    'timeline':       'feed',
    'profile':        'profile',
    'search':         'search',
    'friends':        'friends',
    'family':         'friends',
    'inbox':          'inbox',
    'messages':       'inbox',
    'dms':            'inbox',
    'notifications':  'notifications',
    'alerts':         'notifications',
    'uploads':        'uploads',
    'settings':       'settings',
    'rooms':          'rooms',
    'storm rooms':    'stormrooms',
    'support rooms':  'supportrooms',
    'community':      'community',
    'arcade':         'arcade',
    'games':          'arcade',
    'pwa':            'pwa',
    'app':            'pwa',
    'install':        'pwa',
    'shadow nexus':   'feed',
    'sns':            'feed'
  };

  /* Extract canonical feature key from a message */
  function _extractFeature(text) {
    var norm = (text || '').toLowerCase();
    /* Multi-word first */
    var sorted = Object.keys(_FEATURE_NAMES).sort(function(a,b) { return b.length - a.length; });
    for (var i = 0; i < sorted.length; i++) {
      if (norm.indexOf(sorted[i]) !== -1) return _FEATURE_NAMES[sorted[i]];
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: CONTEXT RESOLUTION
     Resolves pronouns and short follow-up phrases using session context.
     Returns the enriched message text (never modifies _sessionCtx here).
  ───────────────────────────────────────────────────────────────*/
  function _resolveContext(text) {
    if (!text) return text;
    var lower = text.toLowerCase().trim();

    /* Very short follow-ups with no feature mention — inject context */
    var featureInText = _extractFeature(lower);

    /* Pronoun "it" / "that" / "this" without clear feature → inject last feature */
    if (!featureInText && _sessionCtx.lastFeature) {
      /* Patterns that suggest reference to previous topic */
      var refPat = /\b(it|that|this|there|the feature|the thing|the section)\b/i;
      if (refPat.test(lower) && lower.length < 80) {
        var featureLabel = _getFeatureLabel(_sessionCtx.lastFeature);
        /* Prepend context hint — will feed into scoring */
        text = text + ' [context: ' + featureLabel + ']';
      }
    }

    /* Creator pronouns: "he" / "his" / "him" without explicit name */
    if (!featureInText && _sessionCtx.lastCreatorTopic) {
      var creatorRef = /\b(he|his|him|the creator|the founder)\b/i;
      var hasChris   = /\b(chris|legend of shadows)\b/i;
      if (creatorRef.test(lower) && !hasChris.test(lower) && lower.length < 100) {
        text = text + ' [context: chris]';
      }
    }

    /* Follow-up after a creator question about Shadow Nexus */
    if (_sessionCtx.lastIntent === 'CREATOR') {
      var snsRef = /\b(it|sns|the platform|the site|shadow nexus|this)\b/i;
      var hasSnx = /\b(shadow nexus|sns)\b/i;
      if (snsRef.test(lower) && !hasSnx.test(lower) && lower.length < 60) {
        text = text + ' [context: shadow nexus]';
      }
    }

    return text;
  }

  /* Human-readable label for a feature key */
  function _getFeatureLabel(featureKey) {
    var labels = {
      radio: 'Radio', radio_studio: 'Radio Studio', dj: 'DJ',
      live: 'Live', cohost: 'Cohost', tv: 'TV', tv_studio: 'TV Studio',
      feed: 'Eclipse Feed', profile: 'Profile', search: 'Search',
      friends: 'Friends', inbox: 'Inbox', notifications: 'Notifications',
      uploads: 'Uploads', settings: 'Settings', rooms: 'Rooms',
      stormrooms: 'Storm Rooms', supportrooms: 'Support Rooms',
      community: 'Community', arcade: 'Arcade', pwa: 'PWA'
    };
    return labels[featureKey] || featureKey;
  }

  /* Update session context after a successful answer */
  function _updateSessionCtx(message, intent, result) {
    _sessionCtx.turnCount++;
    _sessionCtx.lastIntent = intent;

    /* Feature context */
    var feat = _extractFeature(message);
    if (feat) {
      _sessionCtx.lastFeature = feat;
      _sessionCtx.lastTopic   = _getFeatureLabel(feat);
    }

    /* Creator context */
    var creatorCats = ['CREATOR','CREATOR_STORY','CREATOR_MUSIC','CREATOR_MENTAL_HEALTH',
                       'CREATOR_FAMILY','CREATOR_VALUES','CREATOR_SYMBOLS','CREATOR_PRIVACY'];
    if (result && result.category && creatorCats.indexOf(result.category) !== -1) {
      _sessionCtx.lastCreatorTopic = result.category;
      if (!feat) {
        _sessionCtx.lastTopic = 'Chris';
      }
    }

    /* Track recent answered IDs */
    if (result && result.id) {
      _sessionCtx.recentIds.unshift(result.id);
      if (_sessionCtx.recentIds.length > 3) _sessionCtx.recentIds.pop();
    }

    /* Navigation target */
    if (intent === 'NAVIGATION' && result && result.page) {
      _sessionCtx.recentNavTarget = result.page;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: CLARIFICATION ENGINE
     Detects ambiguous questions where multiple features could match.
     Returns a clarifying question string, or null if not ambiguous.
  ───────────────────────────────────────────────────────────────*/
  var _AMBIGUOUS_PATTERNS = [
    {
      pattern: /\b(why won'?t it play|why (isn'?t|is not) it playing|won'?t (it |the )?(audio |video )?play|audio not working|it (won'?t|doesn'?t|don'?t) play)\b/i,
      features: ['Radio', 'TV', 'Live'],
      question: "What are you trying to play? Radio, TV, or a Live stream?"
    },
    {
      pattern: /\b(not loading|won'?t load|not opening|slow to load|loading forever)\b/i,
      features: ['Radio', 'TV', 'Live', 'Feed'],
      question: "Which part of Shadow Nexus isn't loading? Radio, TV, Live, Feed, or something else?"
    },
    {
      pattern: /\b(camera not working|mic not working|microphone not working)\b/i,
      features: ['Live', 'Cohost'],
      question: "Are you trying to go Live or join as a Cohost?"
    },
    {
      pattern: /^(not working|broken|it('?s| is) broken|won'?t work)\s*\.?$/i,
      features: null,
      question: "What exactly isn't working? Tell me the feature or what you were trying to do."
    },
    {
      pattern: /\b(can i watch|how do i watch|how to watch)\b/i,
      features: ['TV', 'Live'],
      question: "Are you asking about watching TV or watching a Live stream?"
    }
  ];

  function _checkClarification(text, intent) {
    /* Only clarify for TROUBLESHOOT or ambiguous QUESTION intents */
    if (intent !== 'TROUBLESHOOT' && intent !== 'QUESTION' && intent !== 'UNKNOWN') return null;

    /* If there is already strong feature context, no need to clarify */
    var feat = _extractFeature(text);
    if (feat) return null;

    for (var i = 0; i < _AMBIGUOUS_PATTERNS.length; i++) {
      var ap = _AMBIGUOUS_PATTERNS[i];
      if (ap.pattern.test(text)) {
        return ap.question;
      }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: ANSWER DEPTH DETECTION
     Returns 'stepbystep' | 'expanded' | 'concise'
  ───────────────────────────────────────────────────────────────*/
  function _detectAnswerDepth(text) {
    var n = (text || '').toLowerCase();
    if (/\b(step by step|step-by-step|walk me through|guide me through|give me (the |a )?steps|how exactly|give me instructions|full instructions)\b/.test(n)) {
      return 'stepbystep';
    }
    if (/\b(tell me more|more detail|explain (more|further|fully|it)|full explanation|go deeper|elaborate|expand|give me more|more info|in depth)\b/.test(n)) {
      return 'expanded';
    }
    return 'concise';
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: FEATURE RELATIONSHIP ANSWERS
     Handles "difference between X and Y" locally.
  ───────────────────────────────────────────────────────────────*/
  var _FEATURE_DIFFS = {
    'live_tv': "Live and TV are two different things on Shadow Nexus Social. Live is real-time video broadcasting — anyone with a member account can go live from their device, and viewers watch in real time. TV is the 24-hour pre-produced channel network — creators upload content to TV Studio and it plays in a scheduled channel format, like a TV network. Live is interactive; TV is broadcast-style.",
    'live_radio': "Live and Radio are different formats. Live is real-time video broadcasting — you appear on camera and interact with viewers. Radio is Shadow Nexus's 24/7 audio music station — listeners tune in to hear music, make song requests, and leave comments. Radio doesn't use your camera; Live does.",
    'radio_tv': "Radio and TV are both broadcast-style experiences on Shadow Nexus Social, but they are distinct. Radio is the 24/7 audio music station — no video, just music. You can request songs and comment. TV is the 24-hour video channel network — creators upload video content to TV Studio and it plays in scheduled channels. Radio is audio-only; TV is video.",
    'stormrooms_supportrooms': "Storm Rooms and Support Rooms are both chat spaces but serve very different purposes. Storm Rooms are anonymous public chat lobbies — great for casual conversation or meeting new people. Support Rooms are peer-support spaces designed for people who need someone to talk to or want to vent. Support Rooms are welcoming and supportive; Storm Rooms are more open and social.",
    'radio_studio_dj': "Radio Studio and DJ are related but different. Radio Studio is where an authorised broadcaster manages the Shadow Nexus Radio broadcast — setting the music queue, managing the station. DJ mode is a separate feature that lets a DJ take control of the live radio broadcast and play tracks in real time. DJ mode requires special authorisation."
  };

  function _checkFeatureDiff(text) {
    var n = (text || '').toLowerCase();
    if (!/\b(difference|differ|compare|versus|vs\.?|vs |what.s the (difference|diff)|how (is|are).+(different|different from)|compared to)\b/i.test(n)) return null;

    var pairs = [
      { keys: ['live','tv'],                  id: 'live_tv' },
      { keys: ['live','radio'],               id: 'live_radio' },
      { keys: ['radio','tv'],                 id: 'radio_tv' },
      { keys: ['storm rooms','support rooms'],id: 'stormrooms_supportrooms' },
      { keys: ['storm','support'],            id: 'stormrooms_supportrooms' },
      { keys: ['radio studio','dj'],          id: 'radio_studio_dj' },
      { keys: ['dj','radio studio'],          id: 'radio_studio_dj' }
    ];

    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (n.indexOf(p.keys[0]) !== -1 && n.indexOf(p.keys[1]) !== -1) {
        var answer = _FEATURE_DIFFS[p.id];
        if (answer) {
          return { text: answer, page: null, handled: true, confidence: 'HIGH', id: p.id };
        }
      }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: "WHAT CAN YOU DO?" LOCAL HANDLER
  ───────────────────────────────────────────────────────────────*/
  var _CAPABILITIES_TEXT = "I am Shadow Reaper — your guide and guardian through Shadow Nexus Social. Here is what I can help you with:\n\n• Shadow Nexus features — Radio, Live, TV, Feed, Profile, Inbox, Notifications, Search, Friends, Community, Arcade, Storm Rooms, Support Rooms, Uploads, Settings, and more.\n• Navigation — tell me where you want to go and I will take you there directly.\n• How-to guides — step-by-step help for any feature on the platform.\n• Troubleshooting — if something is not working, describe what is happening and I will help diagnose it.\n• Permissions — I can tell you what guests, members, and founders can access.\n• Accounts — sign-in, sign-up, password resets, and settings.\n• The Creator — I know the public story of Chris Legend of Shadows, who built this platform.\n\nI answer almost everything from local knowledge — no AI is needed for most questions. When you ask something complex, I can reason across multiple knowledge sources to give you a complete answer.\n\nJust ask — in plain words, short questions, or follow-ups.";

  var _STATUS_SELF_PATTERNS = /\b(what can you do|what do you know|can you help|what can i ask|introduce yourself|what are you|who are you|what is shadow reaper|your name|what (are|is) your capabilities|help me)\b/i;

  function _checkCapabilities(text) {
    if (_STATUS_SELF_PATTERNS.test(text)) {
      return {
        text:       _CAPABILITIES_TEXT,
        page:       null,
        handled:    true,
        confidence: 'HIGH',
        id:         'shadowReaper'
      };
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     STAGE 3C: LOCAL ANSWER COMPOSER
     Combines multiple knowledge hits into a single coherent answer.
     Respects answer depth (concise / stepbystep / expanded).
     Called when answerLocally() returns a result but more records may help.
  ───────────────────────────────────────────────────────────────*/
  function _composeAnswer(baseResult, hits, depth, intent) {
    if (!baseResult) return null;

    var text = baseResult.text || '';

    /* Step-by-step depth: if the best entry has 'how' steps, lead with them */
    if (depth === 'stepbystep' && baseResult.id) {
      var entry = global.SNXShadowKnowledge ?
        global.SNXShadowKnowledge.getEntry(baseResult.id) : null;
      if (entry && entry.how) {
        /* Ensure steps are prominent */
        if (text.indexOf(entry.how) === -1) {
          text = entry.how;
        }
      }
    }

    /* Expanded depth: append secondary relevant record if it adds unique content */
    if (depth === 'expanded' && hits && hits.length > 1) {
      var secondary = hits[1];
      if (secondary && secondary.score >= 3 && secondary.entry.id !== baseResult.id) {
        var secEntry = secondary.entry;
        var secText  = secEntry.description || '';
        /* Only append if it doesn't just repeat the primary */
        if (secText && text.indexOf(secText.substring(0, 40)) === -1) {
          text = text + '\n\nAlso related — ' + secEntry.title + ': ' + secEntry.description;
        }
      }
    }

    /* PERMISSION intent: check guest limitations in secondary results */
    if (intent === 'PERMISSION' && hits && hits.length > 0) {
      var guestEntry = null;
      hits.forEach(function (h) {
        if (!guestEntry && h.entry.category === 'GUEST_MODE') guestEntry = h.entry;
      });
      if (guestEntry && text.indexOf('guest') === -1) {
        text = text + '\n\nNote: ' + guestEntry.description;
      }
    }

    return {
      text:       text,
      page:       baseResult.page || null,
      handled:    true,
      confidence: baseResult.confidence,
      id:         baseResult.id,
      category:   baseResult.category
    };
  }

  /* ─────────────────────────────────────────────────────────────
     SAFE TEXT HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _setText(el, text) {
    if (el) el.textContent = text;
  }

  /* Set status pill text + class */
  function _setStatus(statusKey) {
    var el = document.getElementById('snx-ai-status');
    if (!el) return;
    el.textContent = statusKey;
    el.className = 'snx-ai-status snx-ai-status--' + statusKey.toLowerCase();
  }

  /* ─────────────────────────────────────────────────────────────
     CONTEXT BUILDER  (safe — no tokens, no secrets)
     Stage 3: adds device type, platform, PWA detection, section.
  ───────────────────────────────────────────────────────────────*/
  function _buildContext() {
    var ctx = {};

    /* Performance mode */
    if (global.SNXPerf && typeof global.SNXPerf.mode === 'string') {
      ctx.perfMode = global.SNXPerf.mode;
    } else {
      try { ctx.perfMode = localStorage.getItem('snxPerfMode') || 'BALANCED'; } catch(_) {}
    }

    /* Network quality */
    if (global.SNX_NET && global.SNX_NET.tierId) {
      ctx.networkTier = global.SNX_NET.tierId;
    } else {
      ctx.networkTier = navigator.onLine ? 'unknown' : 'offline';
    }

    /* Auth state — role only, no tokens */
    ctx.signedIn = false;
    ctx.role = 'guest';
    if (global._snxCurrentUser) {
      ctx.signedIn = true;
      ctx.role = 'member';
    }
    /* Founder flag — read existing authoritative state only */
    if (global._snxIsFounder === true) {
      ctx.role = 'founder';
    }

    /* Active features — read existing window flags */
    ctx.radioActive = !!(global._snxRadioActive || global.snxRadioPageOpen);
    ctx.liveActive  = !!(global._snxLiveActive);
    ctx.tvActive    = !!(global._snxTvActive);
    ctx.djActive    = !!(global._snxDJActive);

    /* Current page hint — read first active .page element id */
    var activePage = null;
    var pages = document.querySelectorAll('.page.active');
    if (pages.length) {
      activePage = pages[0].id || null;
    }
    ctx.currentPage = activePage;

    /* ── Stage 3: device context (safe — no fingerprinting) ──── */
    /* Mobile vs desktop */
    ctx.isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    /* Platform hint — Android or iPhone only, both reliably self-report */
    ctx.platform = 'unknown';
    if (/Android/i.test(navigator.userAgent)) {
      ctx.platform = 'android';
    } else if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) {
      ctx.platform = 'ios';
    } else if (!ctx.isMobile) {
      ctx.platform = 'desktop';
    }

    /* PWA mode — display-mode: standalone indicates installed PWA */
    ctx.isPWA = !!(global.matchMedia && global.matchMedia('(display-mode: standalone)').matches);

    /* Current SNS section — derived from active page id */
    ctx.currentSection = _inferSection(activePage);

    return ctx;
  }

  /* Infer a human-readable section name from page id */
  function _inferSection(pageId) {
    if (!pageId) return null;
    var p = pageId.toLowerCase();
    if (p.indexOf('radio') !== -1)          return 'radio';
    if (p.indexOf('live') !== -1)           return 'live';
    if (p.indexOf('tv') !== -1)             return 'tv';
    if (p.indexOf('feed') !== -1 || p === 'index') return 'feed';
    if (p.indexOf('inbox') !== -1)          return 'inbox';
    if (p.indexOf('notification') !== -1)   return 'notifications';
    if (p.indexOf('setting') !== -1)        return 'settings';
    if (p.indexOf('search') !== -1)         return 'search';
    if (p.indexOf('friend') !== -1)         return 'friends';
    if (p.indexOf('profile') !== -1)        return 'profile';
    if (p.indexOf('storm') !== -1)          return 'stormrooms';
    if (p.indexOf('support') !== -1)        return 'supportrooms';
    if (p.indexOf('community') !== -1)      return 'community';
    return pageId;
  }

  /* ─────────────────────────────────────────────────────────────
     CONTEXT CAPABILITIES
  ───────────────────────────────────────────────────────────────*/
  function _getCapabilities() {
    return {
      /* Stage 3A */
      localKnowledge:          true,
      externalAI:              !_aiLimitMode,
      workersAIBinding:        true,
      openAIDependency:        false,
      ownModelServer:          false,
      navigationMap:           true,
      contextBuilder:          true,
      offlineFallback:         true,
      freeAllocationFallback:  true,
      localBrain:              true,
      confidenceGating:        true,
      aiLimitMode:             _aiLimitMode,
      categoryRetrieval:       true,
      roleAwareKnowledge:      true,
      deviceContext:           true,
      sectionContext:          true,
      founderDiagnostics:      true,
      /* Stage 3C — Deep Intelligence */
      sessionContext:          true,    // short-term pronoun/topic tracking
      intentDetection:         true,    // deterministic local intent classifier
      typoTolerance:           true,    // pre-normalization typo correction
      clarificationEngine:     true,    // ambiguity detection → one clarifying question
      localAnswerComposer:     true,    // multi-record combination with depth control
      answerDepthControl:      true,    // concise / step-by-step / expanded
      featureRelationships:    true,    // "difference between X and Y" local
      capabilitiesHandler:     true,    // "what can you do" answered locally
      permanentStorage:        false,   // session context NEVER stored persistently
      build:                   BUILD_ID,
      /* E1 additions */
      generalConversation:     !!(global.SNXShadowE1),
      emotionalContext:        !!(global.SNXShadowE1),
      localCasualResponses:    !!(global.SNXShadowE1),
      convContextWindow:       !!(global.SNXShadowE1),
      e1Build:                 E1_BUILD_ID,
      /* E2 additions */
      personalMemory:          !!(global.SNXShadowMemory),
      memoryEnabled:           !!(global.SNXShadowMemory && global.SNXShadowMemory.isEnabled()),
      e2Build:                 E2_BUILD_ID
    };
  }

  /* ─────────────────────────────────────────────────────────────
     SAFE NAVIGATION MAP
     Only approved internal destinations via existing navTo()
  ───────────────────────────────────────────────────────────────*/
  var _NAV_MAP = {
    feed:             function() { if (typeof navTo === 'function') navTo('feed'); },
    profile:          function() { if (typeof viewMyProfile === 'function') viewMyProfile(); },
    search:           function() { if (typeof navTo === 'function') navTo('searchPage'); },
    notifications:    function() { if (typeof navTo === 'function') navTo('notificationsPage'); },
    settings:         function() { if (typeof navTo === 'function') navTo('settingsPage'); },
    inbox:            function() { if (typeof navTo === 'function') navTo('inboxPage'); },
    friends:          function() { if (typeof navTo === 'function') navTo('friendsPage'); },
    community:        function() { if (typeof navTo === 'function') navTo('communityPage'); },
    rules:            function() { if (typeof navTo === 'function') navTo('communityRulesPage'); },
    arcade:           function() { if (typeof openArcadeHub === 'function') openArcadeHub(); },
    stormrooms:       function() { if (typeof navTo === 'function') navTo('stormRoomsPage'); },
    supportrooms:     function() { if (typeof navTo === 'function') navTo('supportRoomsPage'); },
    radio:            function() { if (typeof navTo === 'function') navTo('radioPage'); },
    live:             function() { if (typeof navTo === 'function') navTo('liveViewPage'); },
    tv:               function() { if (typeof navTo === 'function') navTo('tvPage'); }
  };

  function navigateTo(feature) {
    var key = (feature || '').toLowerCase().replace(/[^a-z]/g, '');
    if (_NAV_MAP[key]) {
      /* Stage 3C: track nav target in session context */
      _sessionCtx.recentNavTarget = key;
      _sessionCtx.lastIntent      = 'NAVIGATION';
      _close();
      _NAV_MAP[key]();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     LOCAL ANSWER ENGINE
     Stage 3A: uses answerLocally() for HIGH/MEDIUM confidence.
     Returns a result object or null.
  ───────────────────────────────────────────────────────────────*/
  /* ─────────────────────────────────────────────────────────────
     CREATOR PRIVACY GUARD
     Stage 3B: Block requests for private creator information from
     ever being forwarded to Workers AI. Handled 100% locally.
     Returns true when the message is a privacy-sensitive request.
  ───────────────────────────────────────────────────────────────*/
  var _CREATOR_PRIVACY_PATTERNS = [
    /* Credentials / secrets */
    /\b(password|credentials?|token|secret|api key|firebase|cloudflare|github)\b/i,
    /* Private contact / location */
    /(home\s+)?address|precise location|current location|phone\s+number|private\s+(email|messages?)/i,
    /* "Give me / show me" credential requests */
    /give\s+me\s+(his|chris'?s?)\s+(password|token|credentials?|key|secret)/i,
    /show\s+me\s+(his|chris'?s?)\s+private/i,
    /* Private family / friend information */
    /sister'?s?\s+(name|address|contact|account|phone)/i,
    /private\s+(family|friend|supporter)\s+(info|information|details?)/i
  ];

  function _isCreatorPrivacyRequest(message) {
    for (var i = 0; i < _CREATOR_PRIVACY_PATTERNS.length; i++) {
      if (_CREATOR_PRIVACY_PATTERNS[i].test(message)) return true;
    }
    return false;
  }

  function _askLocal(message) {
    /* Crisis intercept — always highest priority */
    if (/(suicide|kill myself|end my life|want to die|dont want to live|self.harm|hurt myself)/i.test(message)) {
      return {
        text: "I hear you, and what you are feeling matters enormously. Please reach out right now — US: call or text 988 · UK: 116 123 · Australia: 13 11 14. You deserve real support. You do not have to face this alone.",
        page: null,
        handled: true,
        confidence: 'HIGH'
      };
    }

    /* Stage 3B: Creator privacy guard — never forward private requests to Workers AI */
    if (_isCreatorPrivacyRequest(message)) {
      return {
        text: "That information is private. Shadow Reaper does not share personal credentials, home addresses, phone numbers, private messages, tokens, or any other private personal details about Chris or anyone connected to Shadow Nexus Social. If you have a question about the creator's public work or Shadow Nexus Social, feel free to ask.",
        page: null,
        handled: true,
        confidence: 'HIGH'
      };
    }

    /* Stage 3C: capabilities check */
    var capResult = _checkCapabilities(message);
    if (capResult) return capResult;

    /* Stage 3C: feature difference check */
    var diffResult = _checkFeatureDiff(message);
    if (diffResult) return diffResult;

    /* Stage 3C: detect answer depth */
    var depth = _detectAnswerDepth(message);

    /* Delegate to knowledge module answerLocally() — HIGH/MEDIUM confidence */
    if (global.SNXShadowKnowledge && typeof global.SNXShadowKnowledge.answerLocally === 'function') {
      var ctx  = _buildContext();
      var result = global.SNXShadowKnowledge.answerLocally(message, ctx);
      if (result) {
        /* Stage 3C: multi-record composition with depth control */
        if ((depth === 'stepbystep' || depth === 'expanded') && typeof global.SNXShadowKnowledge.retrieveKnowledge === 'function') {
          var allHits = global.SNXShadowKnowledge.retrieveKnowledge(message, ctx);
          var intent  = _detectIntent(message);
          var composed = _composeAnswer(result, allHits, depth, intent);
          if (composed) return composed;
        }
        return result;
      }
    }

    /* Fallback: try legacy query() for LOW-confidence results (snippets only) */
    if (global.SNXShadowKnowledge && typeof global.SNXShadowKnowledge.query === 'function') {
      var qResult = global.SNXShadowKnowledge.query(message, _buildContext());
      if (qResult) return qResult;   // caller checks confidence before answering
    }

    /* Unknown question — no local match */
    return {
      text: "I do not have enough local Shadow Nexus knowledge to answer that yet. If you have a question about the site, try asking about a specific feature — Radio, Live, TV, Feed, Profile, Settings, and more.",
      page: null,
      handled: false,
      confidence: 'NONE'
    };
  }

  /* ─────────────────────────────────────────────────────────────
     CONVERSATION HISTORY MANAGEMENT
  ───────────────────────────────────────────────────────────────*/
  function _addToHistory(role, text) {
    _history.push({ role: role, text: text });
    /* Enforce ceiling — remove oldest pair when over limit */
    while (_history.length > MAX_HISTORY * 2) {
      _history.splice(0, 2);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     FIREBASE ID TOKEN HELPER
     Gets the current user's Firebase ID token without storing it.
     Returns null if not signed in or token unavailable.
  ───────────────────────────────────────────────────────────────*/
  function _getIdToken(cb) {
    try {
      var firebase = global.firebase || (global.firebase);
      if (firebase && firebase.auth && typeof firebase.auth === 'function') {
        var user = firebase.auth().currentUser;
        if (user && typeof user.getIdToken === 'function') {
          user.getIdToken(false).then(function (t) { cb(t); }).catch(function () { cb(null); });
          return;
        }
      }
    } catch (_) {}
    cb(null);
  }

  /* ─────────────────────────────────────────────────────────────
     RELEVANT KNOWLEDGE SNIPPETS
     Stage 3A: uses retrieveKnowledge() for richer ranked snippets.
     Only safe, non-Founder entries sent unless Founder.
     Sent as grounding context to the server — not the full KB.
  ───────────────────────────────────────────────────────────────*/
  function _getRelevantSnippets(message) {
    if (!global.SNXShadowKnowledge) return [];
    try {
      var ctx = _buildContext();

      /* Stage 3A: use retrieveKnowledge() for better ranking */
      if (typeof global.SNXShadowKnowledge.retrieveKnowledge === 'function') {
        var hits = global.SNXShadowKnowledge.retrieveKnowledge(message, ctx);
        if (hits && hits.length) {
          return hits.slice(0, 5).map(function (h) {
            return {
              title:   h.entry.title   || '',
              summary: h.entry.summary || '',
              how:     h.entry.how     || ''
            };
          });
        }
      }

      /* Fallback: legacy query() snippets */
      if (typeof global.SNXShadowKnowledge.query === 'function') {
        var result = global.SNXShadowKnowledge.query(message, ctx);
        if (!result) return [];
        if (result.snippets && result.snippets.length) {
          return result.snippets.map(function (s) {
            return { title: s.title || '', summary: s.summary || '', how: s.how || '' };
          });
        }
        if (result.id) {
          var entry = global.SNXShadowKnowledge.getEntry(result.id);
          if (entry) return [{ title: entry.title || '', summary: entry.summary || '', how: entry.how || '' }];
        }
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  /* ─────────────────────────────────────────────────────────────
     ABORT CONTROLLER HELPER — one per in-flight request
  ───────────────────────────────────────────────────────────────*/
  var _currentAbort = null;

  function _abortPending() {
    if (_currentAbort) {
      try { _currentAbort.abort(); } catch (_) {}
      _currentAbort = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     E2: MEMORY CONVERSATION HANDLER
     Handles all memory intents with natural conversational responses.
     Called BEFORE general intent routing.
     Returns a response string, or null if memory could not handle it.
  ───────────────────────────────────────────────────────────────*/
  function _handleMemoryIntent(intent, originalText, callback) {
    var M = global.SNXShadowMemory;
    if (!M) return false;

    if (intent === 'MEMORY_SAVE') {
      M.save(originalText, function (result) {
        callback({
          text:       result.message,
          page:       null,
          handled:    true,
          fromServer: false,
          confidence: 'HIGH'
        });
      });
      return true;
    }

    if (intent === 'MEMORY_RECALL') {
      M.recall(originalText, function (result) {
        var text;
        if (!result.success) {
          text = result.message || "I couldn't retrieve your memories right now.";
        } else if (!result.memories || !result.memories.length) {
          text = result.message || "I don't have any saved memories matching that.";
        } else {
          var formatted = M.formatMemoriesForResponse(result.memories);
          /* Build a natural response */
          if (result.memories.length === 1) {
            text = 'You told me: ' + result.memories[0].content;
          } else {
            text = 'Here is what I have saved:\n' + formatted;
          }
        }
        callback({
          text:       text,
          page:       null,
          handled:    true,
          fromServer: false,
          confidence: 'HIGH'
        });
      });
      return true;
    }

    if (intent === 'MEMORY_LIST') {
      M.list(function (result) {
        var text;
        if (!result.success) {
          text = result.message || "Couldn't retrieve your memories right now.";
        } else if (!result.memories || !result.memories.length) {
          text = "I don't have any saved memories for you yet. Tell me something to remember and I'll hold onto it.";
        } else {
          var grouped = {};
          result.memories.forEach(function (m) {
            var cat = m.category || 'GENERAL';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(m.content);
          });
          var lines = ['Here is what I remember about you:'];
          Object.keys(grouped).forEach(function (cat) {
            lines.push('\n' + cat + ':');
            grouped[cat].forEach(function (c) { lines.push('  • ' + c); });
          });
          text = lines.join('\n');
        }
        callback({
          text:       text,
          page:       null,
          handled:    true,
          fromServer: false,
          confidence: 'HIGH'
        });
      });
      return true;
    }

    if (intent === 'MEMORY_FORGET') {
      M.forget(originalText, function (result) {
        var text;
        if (result.reason === 'AMBIGUOUS') {
          text = result.message;
        } else if (result.reason === 'NOT_FOUND') {
          text = result.message || "I don't have a memory matching that.";
        } else if (!result.success) {
          text = result.message || "I couldn't process that right now.";
        } else {
          text = result.message || "Done. Forgotten.";
        }
        callback({
          text:       text,
          page:       null,
          handled:    true,
          fromServer: false,
          confidence: 'HIGH'
        });
      });
      return true;
    }

    if (intent === 'MEMORY_FORGET_ALL') {
      /* Check if this is a confirmation of a pending forget-all */
      var pending = M.getPendingForgetAll();
      if (pending) {
        /* Already pending — treat the MEMORY_FORGET_ALL re-detection as confirmation */
        M.clearAll(true, function (result) {
          callback({
            text:       result.message || "All memories cleared.",
            page:       null,
            handled:    true,
            fromServer: false,
            confidence: 'HIGH'
          });
        });
      } else {
        /* First mention — request confirmation */
        M.clearAll(false, function (result) {
          callback({
            text:       result.message,
            page:       null,
            handled:    true,
            fromServer: false,
            confidence: 'HIGH'
          });
        });
      }
      return true;
    }

    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     E2: YES/NO CONFIRMATION HANDLER
     Detects confirmation/cancellation responses for pending forget-all.
     Returns true if handled.
  ───────────────────────────────────────────────────────────────*/
  var _CONFIRM_YES = /^\s*(yes|yeah|yep|yup|confirm|go ahead|do it|proceed|continue|sure|ok|okay)\s*[.!?]*$/i;
  var _CONFIRM_NO  = /^\s*(no|nope|nah|cancel|stop|never mind|nevermind|don'?t|abort)\s*[.!?]*$/i;

  function _handleMemoryConfirmation(text, callback) {
    var M = global.SNXShadowMemory;
    if (!M) return false;

    var pending = M.getPendingForgetAll();
    if (!pending) return false;

    if (_CONFIRM_YES.test(text)) {
      M.clearAll(true, function (result) {
        callback({
          text:       result.message || "All memories cleared.",
          page:       null,
          handled:    true,
          fromServer: false,
          confidence: 'HIGH'
        });
      });
      return true;
    }

    if (_CONFIRM_NO.test(text)) {
      M.cancelForgetAll();
      callback({
        text:       "Understood. No memories were removed.",
        page:       null,
        handled:    true,
        fromServer: false,
        confidence: 'HIGH'
      });
      return true;
    }

    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     PROVIDER ABSTRACTION  — Stage 3C Deep Intelligence Pipeline
     Routing order:
       0. E2 MEMORY CONFIRMATION (pending forget-all yes/no)
       0a. E2 MEMORY INTENT (SAVE/RECALL/FORGET/LIST — before all else)
       1. TYPO CORRECTION
       2. CONTEXT RESOLUTION (pronoun/follow-up + E1 conv context)
       3. INTENT DETECTION (incl. GENERAL_CONVERSATION)
       4. CLARIFICATION CHECK (ambiguous → ask one question)
       5. LOCAL KNOWLEDGE — HIGH/MEDIUM confidence → answer immediately
          (E1 step 5a: GENERAL_CONVERSATION intent → E1 local casual layer first)
       6. AI-LIMIT MODE   → local only (Workers AI skipped; E1 local casual still active)
       7. OFFLINE         → local only
       8. Workers AI      → LOW/NONE confidence questions, with snippets + intent
          (E1 step 8a: GENERAL_CONVERSATION → enhanced conv context sent to Worker)
       9. Workers AI unavailable → local fallback
  ───────────────────────────────────────────────────────────────*/
  var SNXShadowAIProvider = {
    /**
     * @param {object} params - { message, context, history }
     * @param {function} callback - fn(result) where result = {text, page, handled}
     */
    ask: function (params, callback) {
      var message   = params.message;
      var context   = params.context;
      var history   = params.history || [];

      /* ── E2 STEP 0: MEMORY CONFIRMATION (pending forget-all) ─────
         Must run first — before typo correction — so that a clean
         "yes" or "no" always resolves the pending confirmation even
         if typo correction would mangle it.
      ──────────────────────────────────────────────────────────── */
      if (global.SNXShadowMemory && global.SNXShadowMemory.getPendingForgetAll()) {
        if (_handleMemoryConfirmation(message, callback)) return;
      }

      /* ── E2 STEP 0a: MEMORY INTENT (deterministic) ───────────────
         Detect MEMORY_SAVE / MEMORY_RECALL / MEMORY_FORGET /
         MEMORY_FORGET_ALL / MEMORY_LIST before anything else.
         No typo correction needed — patterns are robust.
         Do NOT depend on Workers AI for these operations.
      ──────────────────────────────────────────────────────────── */
      if (global.SNXShadowMemory) {
        var memIntent = global.SNXShadowMemory.detectIntent(message);
        if (memIntent && _handleMemoryIntent(memIntent, message, callback)) return;
      }

      /* ── STAGE 3C STEP 1: TYPO CORRECTION ───────────────────────
         Correct common misspellings before any processing.
      ──────────────────────────────────────────────────────────── */
      var correctedMsg = _correctTypos(message);

      /* ── STAGE 3C STEP 2: CONTEXT RESOLUTION ────────────────────
         Resolve pronouns ("it", "he", "this") using session context.
         E1: also resolve general conversation pronoun context.
      ──────────────────────────────────────────────────────────── */
      var resolvedMsg = _resolveContext(correctedMsg);
      /* E1: resolve pronouns in general conversation context (e.g. "I finished it" → song) */
      if (global.SNXShadowE1 && typeof global.SNXShadowE1.resolveConvContext === 'function') {
        try { resolvedMsg = global.SNXShadowE1.resolveConvContext(resolvedMsg); } catch (_) {}
      }

      /* ── STAGE 3C STEP 3: INTENT DETECTION ──────────────────────
         Classify intent before routing.
      ──────────────────────────────────────────────────────────── */
      var intent = _detectIntent(resolvedMsg);

      /* ── STAGE 3C STEP 4: CLARIFICATION CHECK ───────────────────
         If ambiguous with no feature context, ask ONE clarifying question.
      ──────────────────────────────────────────────────────────── */
      var clarifyQ = _checkClarification(resolvedMsg, intent);
      if (clarifyQ) {
        _sessionCtx.lastIntent    = intent;
        _sessionCtx.turnCount++;
        _sessionCtx.pendingClarify = { intent: intent, originalMsg: message };
        callback({
          text:       clarifyQ,
          page:       null,
          handled:    true,
          fromServer: false,
          confidence: 'CLARIFY'
        });
        return;
      }

      /* ── STAGE 3C STEP 5: LOCAL KNOWLEDGE ENGINE ─────────────────
         Try answerLocally first (uses resolved + corrected message).
         HIGH or MEDIUM confidence → answer now, zero Workers AI calls.
         This is the primary cost-saving mechanism.
      ──────────────────────────────────────────────────────────── */
      var localResult = _askLocal(resolvedMsg);
      var localConf   = localResult ? (localResult.confidence || 'NONE') : 'NONE';

      if (localResult && (localConf === 'HIGH' || localConf === 'MEDIUM')) {
        /* Update session context before replying */
        _updateSessionCtx(resolvedMsg, intent, localResult);
        /* E1: mark website turn so conv context is preserved but not corrupted */
        if (global.SNXShadowE1 && intent !== 'GENERAL_CONVERSATION') {
          try { global.SNXShadowE1.markWebsiteTurn(); } catch (_) {}
        }
        /* Local brain answered confidently — skip AI entirely */
        callback({
          text:       localResult.text,
          page:       localResult.page  || null,
          handled:    true,
          fromServer: false,
          confidence: localConf
        });
        return;
      }

      /* ── E1 STEP 5a: GENERAL CONVERSATION LOCAL CASUAL LAYER ─────
         When intent is GENERAL_CONVERSATION and local knowledge did
         not confidently answer, try the E1 local casual response layer.
         Very common exchanges (greetings, thanks, lol, bye) answered
         immediately — no Workers AI call needed.
      ──────────────────────────────────────────────────────────── */
      if (intent === 'GENERAL_CONVERSATION' && global.SNXShadowE1) {
        try {
          var casualReply = global.SNXShadowE1.localCasualAnswer(correctedMsg);
          if (casualReply) {
            var convTone  = global.SNXShadowE1.detectEmotion(correctedMsg);
            var convTopic = global.SNXShadowE1.extractConvTopic(correctedMsg);
            global.SNXShadowE1.updateConvContext(correctedMsg, convTone, convTopic);
            _updateSessionCtx(resolvedMsg, intent, { id: null, page: null });
            callback({
              text:       casualReply,
              page:       null,
              handled:    true,
              fromServer: false,
              confidence: 'LOCAL_CASUAL'
            });
            return;
          }
        } catch (_) {}
      }

      /* ── STAGE 3C STEP 6: AI-LIMIT MODE ─────────────────────────
         Workers AI daily allocation exhausted this session.
         E1: for general conversation, produce a warm local fallback.
      ──────────────────────────────────────────────────────────── */
      if (_aiLimitMode) {
        _updateSessionCtx(resolvedMsg, intent, localResult);
        if (intent === 'GENERAL_CONVERSATION') {
          /* Provide a warm conversational fallback locally */
          callback({
            text:       "I'm running in local mode right now, but I'm still here. If you have a Shadow Nexus question I can help — or just keep talking.",
            page:       null,
            handled:    true,
            fromServer: false,
            confidence: 'LOCAL_CASUAL'
          });
          return;
        }
        return _fallbackToLocal(resolvedMsg, callback, true);
      }

      /* ── STAGE 3C STEP 7: OFFLINE ───────────────────────────────
         No network — use local knowledge.
      ──────────────────────────────────────────────────────────── */
      if (!navigator.onLine) {
        return _fallbackToLocal(resolvedMsg, callback);
      }

      /* ── STAGE 3C STEP 8: WORKERS AI ────────────────────────────
         LOW confidence or no local match — call Workers AI with
         local snippets + intent as grounding context (not the full KB).
      ──────────────────────────────────────────────────────────── */
      var snippets = _getRelevantSnippets(resolvedMsg);

      /* Stage 3B: detect if any snippets are creator knowledge entries.
         When true, tell the Worker to include the biography-invention guard
         so the model stays within supplied creator knowledge. */
      var hasCreatorSnippets = false;
      if (global.SNXShadowKnowledge && typeof global.SNXShadowKnowledge.retrieveKnowledge === 'function') {
        var hits = global.SNXShadowKnowledge.retrieveKnowledge(resolvedMsg, _buildContext());
        if (hits && hits.length && hits[0].entry && hits[0].entry.category) {
          var topCat = hits[0].entry.category;
          hasCreatorSnippets = (
            topCat === 'CREATOR' ||
            topCat === 'CREATOR_STORY' ||
            topCat === 'CREATOR_MUSIC' ||
            topCat === 'CREATOR_MENTAL_HEALTH' ||
            topCat === 'CREATOR_FAMILY' ||
            topCat === 'CREATOR_VALUES' ||
            topCat === 'CREATOR_SYMBOLS' ||
            topCat === 'CREATOR_PRIVACY'
          );
        }
      }

      /* Build conversation array (last 10 pairs max) */
      var conversation = history.slice(-20).map(function (h) {
        return { role: h.role, text: h.text };
      });

      /* Get Firebase ID token (may be null for guests) */
      _getIdToken(function (idToken) {
        var headers = { 'Content-Type': 'application/json' };
        if (idToken) headers['Authorization'] = 'Bearer ' + idToken;

        /* If this is a creator question, add a grounding instruction to the
           context so the Worker can tell the model not to invent biographical
           facts beyond the supplied knowledge snippets. */
        var sendContext = context;
        if (hasCreatorSnippets) {
          sendContext = Object.assign({}, context, {
            creatorGrounding: true,
            creatorGroundingNote: 'Answer only from the supplied creator knowledge snippets. Do not invent biographical facts, personal details, awards, chart positions, record deals, or other claims about Chris that are not present in the snippets.'
          });
        }

        /* Stage 3C: include intent and session context in server request
           for AI grounding. Do NOT send full conversation history or private data. */
        sendContext = Object.assign({}, sendContext, {
          intent:           intent,
          lastTopic:        _sessionCtx.lastTopic,
          lastFeature:      _sessionCtx.lastFeature,
          snxGrounding:     'Answer only from supplied Shadow Nexus Social knowledge. Do not invent features, buttons, menus, or creator biography not present in the supplied knowledge snippets.',
          answerDepth:      _detectAnswerDepth(resolvedMsg)
        });

        /* ── E1 STEP 8a: GENERAL CONVERSATION CONTEXT ────────────────
           For general conversation turns, attach E1 conversational context
           so the Worker can build an appropriate persona response.
           Do NOT send website internals to general conversation turns.
        ──────────────────────────────────────────────────────────── */
        if (intent === 'GENERAL_CONVERSATION' && global.SNXShadowE1) {
          try {
            var e1Ctx = global.SNXShadowE1.getConvContext();
            var convSystemCtx = global.SNXShadowE1.buildConvSystemContext(
              e1Ctx.currentTone,
              e1Ctx.lastConvTopics
            );
            sendContext = Object.assign({}, sendContext, {
              conversationalMode: true,
              e1Tone:             e1Ctx.currentTone,
              e1StyleHint:        convSystemCtx.styleHint,
              e1ConvTopics:       convSystemCtx.recentConvTopics,
              e1PersonaNote:      convSystemCtx.personaNote,
              /* For general conversation, do not send SNX grounding — wrong context */
              snxGrounding:       convSystemCtx.personaNote
            });
            /* Update E1 conv context now that we're routing to Workers AI */
            var convTone2  = global.SNXShadowE1.detectEmotion(correctedMsg);
            var convTopic2 = global.SNXShadowE1.extractConvTopic(correctedMsg);
            global.SNXShadowE1.updateConvContext(correctedMsg, convTone2, convTopic2);
          } catch (_) {}
        }

        var body = JSON.stringify({
          message:           resolvedMsg,
          conversation:      conversation,
          context:           sendContext,
          knowledgeSnippets: snippets
        });

        /* AbortController for timeout */
        _abortPending();
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        _currentAbort  = controller;
        var timeoutId  = null;

        if (controller) {
          timeoutId = setTimeout(function () {
            _abortPending();
          }, AI_TIMEOUT_MS);
        }

        fetch(AI_ENDPOINT, {
          method:  'POST',
          headers: headers,
          body:    body,
          signal:  controller ? controller.signal : undefined
        })
        .then(function (res) {
          if (timeoutId) clearTimeout(timeoutId);
          _currentAbort = null;

          /* HTTP 429 — rate limited, allocation exhausted, or capacity exceeded */
          if (res.status === 429) {
            return res.json().then(function (d) {
              var errCode = (d && d.error) ? d.error : '';
              if (errCode === 'FREE_ALLOCATION_EXHAUSTED') {
                /* Activate AI-limit mode for this session */
                _aiLimitMode = true;
                console.log('[SNXShadowAI] Workers AI daily allocation exhausted — entering LOCAL KNOWLEDGE MODE.');
                return _fallbackToLocal(resolvedMsg, callback, true);
              }
              if (errCode === 'CF_CAPACITY') {
                return _fallbackToLocal(resolvedMsg, callback);
              }
              /* Generic rate limit */
              callback({
                text: "Shadow Reaper has reached its request limit for the moment. Give it a breath — try again shortly.",
                page: null, handled: true, fromServer: false
              });
            }).catch(function () {
              _fallbackToLocal(resolvedMsg, callback);
            });
          }

          /* HTTP 503 — AI binding missing or other service unavailable */
          if (res.status === 503) {
            return _fallbackToLocal(resolvedMsg, callback);
          }

          if (!res.ok) {
            return _fallbackToLocal(resolvedMsg, callback);
          }

          return res.json().then(function (data) {
            var reply  = (typeof data.reply === 'string') ? data.reply.trim() : '';
            var action = (data.action && typeof data.action === 'object') ? data.action : null;

            if (!reply) {
              return _fallbackToLocal(resolvedMsg, callback);
            }

            /* Validate navigation action client-side — whitelist enforced twice */
            var page = null;
            if (action && action.type === 'navigate' && typeof action.target === 'string') {
              var target = action.target.toLowerCase().replace(/[^a-z]/g, '');
              if (AI_NAV_WHITELIST[target]) {
                page = target;
              }
            }

            /* Record AI usage in knowledge diagnostics */
            if (global.SNXShadowKnowledge && typeof global.SNXShadowKnowledge.recordAIFallback === 'function') {
              global.SNXShadowKnowledge.recordAIFallback();
            }

            /* Stage 3C: update session context for AI-answered questions */
            _updateSessionCtx(resolvedMsg, intent, { page: page });

            callback({ text: reply, page: page, handled: true, fromServer: true });
          });
        })
        .catch(function (err) {
          if (timeoutId) clearTimeout(timeoutId);
          _currentAbort = null;

          var isTimeout = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
          if (isTimeout) {
            return _fallbackToLocal(resolvedMsg, callback);
          }

          /* Network failure — try local fallback */
          _fallbackToLocal(resolvedMsg, callback);
        });
      }); /* end _getIdToken */
    } /* end ask */
  };

  /* ─────────────────────────────────────────────────────────────
     FALLBACK TO LOCAL KNOWLEDGE
     Used when Workers AI is unavailable or in AI-limit mode.
     isLimitMode: true → graceful "local only" message instead of error.
  ───────────────────────────────────────────────────────────────*/
  function _fallbackToLocal(message, callback, isLimitMode) {
    var result = _askLocal(message);
    if (result && result.handled) {
      callback(result);
      return;
    }
    /* Low-confidence result with snippets — still return what we have */
    if (result && result.text) {
      callback({
        text:       result.text,
        page:       result.page || null,
        handled:    false,
        fromServer: false
      });
      return;
    }
    /* Nothing in local knowledge */
    if (isLimitMode) {
      callback({
        text: "Shadow Reaper is running in local knowledge mode right now. I can answer most questions about Shadow Nexus Social features directly — try asking about Radio, Live, TV, Feed, Profile, Settings, or any specific feature.",
        page: null,
        handled: true,
        fromServer: false
      });
    } else {
      callback({
        text: "Shadow Reaper can't reach the Nexus intelligence right now. Try again in a moment.",
        page: null,
        handled: false,
        fromServer: false
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     DOM HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _getConvArea() {
    return document.getElementById('snx-ai-conversation');
  }

  function _getInput() {
    return document.getElementById('snx-ai-input');
  }

  /* Append a message bubble to the conversation area */
  function _appendMessage(role, text) {
    var area = _getConvArea();
    if (!area) return;

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:' +
      (role === 'user' ? 'flex-end' : 'flex-start') + ';gap:2px;';

    var bubble = document.createElement('div');
    bubble.className = 'snx-ai-bubble snx-ai-bubble--' + role;

    /* SAFE: always textContent, never innerHTML for message content */
    if (role === 'grim') {
      /* Typewriter effect */
      var idx = 0;
      var full = text;
      (function type() {
        if (idx < full.length) {
          bubble.textContent += full[idx++];
          area.scrollTop = area.scrollHeight;
          setTimeout(type, 12);
        } else {
          area.scrollTop = area.scrollHeight;
        }
      })();
    } else {
      bubble.textContent = text;
    }

    var ts = document.createElement('span');
    ts.className = 'snx-ai-ts';
    ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrapper.appendChild(bubble);
    wrapper.appendChild(ts);
    area.appendChild(wrapper);
    area.scrollTop = area.scrollHeight;

    return wrapper;
  }

  /* Append a nav button after a grim message if a destination page is known */
  function _appendNavBtn(wrapper, page) {
    if (!wrapper || !page) return;
    var navFn = _NAV_MAP[page];
    if (!navFn) return;

    var labelMap = {
      feed: '🏠 Home Feed', profile: '👤 Profile', search: '🔍 Search',
      notifications: '🔔 Notifications', settings: '⚙️ Settings',
      inbox: '💬 Inbox', friends: '🦋 Friends & Family',
      community: '💙 Community Hub', rules: '📜 Community Rules',
      arcade: '🕹️ Arcade', stormrooms: '⚡ Storm Rooms',
      supportrooms: '🫂 Support Rooms', radio: '📻 Radio',
      live: '🔴 Live', tv: '📺 TV'
    };

    var btn = document.createElement('button');
    btn.className = 'snx-ai-nav-btn';
    btn.textContent = '→ Take me to ' + (labelMap[page] || page);
    btn.addEventListener('click', function () {
      navigateTo(page);
    });
    wrapper.appendChild(btn);
  }

  /* Show/hide typing indicator */
  function _showTyping(on) {
    var el = document.getElementById('snx-ai-typing');
    if (!el) return;
    el.style.display = on ? 'flex' : 'none';
    if (on) {
      var area = _getConvArea();
      if (area) area.scrollTop = area.scrollHeight;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     SEND  —  main flow
  ───────────────────────────────────────────────────────────────*/
  function _send(message) {
    if (!message || !message.trim()) return;
    if (_busy) return;

    var text = message.trim();
    var seq  = ++_reqSeq;

    _busy = true;
    _setStatus(STATUS.THINKING);

    /* Stage 4B: notify character controller — THINKING */
    for (var _ti = 0; _ti < _thinkingListeners.length; _ti++) {
      try { _thinkingListeners[_ti](); } catch (_) {}
    }

    _addToHistory('user', text);
    _appendMessage('user', text);
    _showTyping(true);

    /* Disable send controls while busy */
    var inp     = _getInput();
    var sendBtn = document.getElementById('snx-ai-send');
    if (inp)     { inp.value = ''; inp.disabled = true; }
    if (sendBtn)   sendBtn.disabled = true;

    SNXShadowAIProvider.ask(
      { message: text, context: _buildContext(), history: _history.slice() },
      function (result) {
        /* Guard: if panel was destroyed or a newer request came in, discard */
        if (seq !== _reqSeq && seq < _reqSeq - 1) {
          _showTyping(false);
          _busy = false;
          if (inp)     inp.disabled = false;
          if (sendBtn) sendBtn.disabled = false;
          return;
        }

        _showTyping(false);
        _setStatus(
          navigator.onLine ? STATUS.READY : STATUS.OFFLINE
        );

        var replyText = (result && result.text) ? result.text
          : "I do not have enough local Shadow Nexus knowledge to answer that yet.";

        _addToHistory('grim', replyText);
        var wrapper = _appendMessage('grim', replyText);

        /* Stage 4A: optional spoken response — after text is displayed */
        if (global.SNXShadowVoice && typeof global.SNXShadowVoice.speak === 'function') {
          try { global.SNXShadowVoice.speak(replyText); } catch (_) {}
        }

        /* Stage 4B: notify character controller — answer received */
        for (var _ai2 = 0; _ai2 < _answerListeners.length; _ai2++) {
          try { _answerListeners[_ai2](); } catch (_) {}
        }

        /* Navigation button */
        if (result && result.page) {
          /* Delay so button appears after typewriter finishes */
          var delay = replyText.length * 13 + 400;
          setTimeout(function () {
            _appendNavBtn(wrapper, result.page);
          }, delay);
        }

        _busy = false;
        /* Re-enable controls */
        if (inp)     { inp.disabled = false; setTimeout(function() { if (global.innerWidth > 768) inp.focus(); }, 50); }
        if (sendBtn) sendBtn.disabled = false;
      }
    );
  }

  /* ─────────────────────────────────────────────────────────────
     CONVERSATION UI  — injected as a child of #grim-panel
     Does NOT touch the character stage, header, or chip area.
  ───────────────────────────────────────────────────────────────*/
  var _uiInjected = false;

  function _injectUI() {
    if (_uiInjected) return;
    if (!document.getElementById('grim-panel')) return;

    /* Check if already injected (idempotency on hot reload) */
    if (document.getElementById('snx-ai-conversation')) { _uiInjected = true; return; }

    /* Replace the existing #gp-messages, #gp-typing, and #gp-input-row
       with the SNXShadowAI conversation area.
       We hide the old elements so existing GP fallback still works if
       SNXShadowAI is not yet initialized. */
    var gpMessages  = document.getElementById('gp-messages');
    var gpTyping    = document.getElementById('gp-typing');
    var gpInputRow  = document.getElementById('gp-input-row');
    var gpNavChips  = document.getElementById('gp-nav-chips');
    var gpFullLink  = document.getElementById('gp-fullpage-link');
    var gpStatus    = document.getElementById('gp-status');

    /* Hide old GP elements — not removed, in case GP code still references them */
    [gpMessages, gpTyping, gpInputRow, gpNavChips, gpFullLink, gpStatus].forEach(function (el) {
      if (el) el.style.display = 'none';
    });

    /* Build new conversation UI */
    var panel = document.getElementById('grim-panel');

    /* Status bar */
    var statusBar = document.createElement('div');
    statusBar.id = 'snx-ai-statusbar';
    statusBar.innerHTML = '<span id="snx-ai-status" class="snx-ai-status snx-ai-status--ready">READY</span>';

    /* Conversation scroll area */
    var convArea = document.createElement('div');
    convArea.id = 'snx-ai-conversation';
    convArea.setAttribute('role', 'log');
    convArea.setAttribute('aria-live', 'polite');

    /* Typing indicator */
    var typingEl = document.createElement('div');
    typingEl.id = 'snx-ai-typing';
    typingEl.style.display = 'none';
    typingEl.innerHTML =
      '<div class="snx-ai-typing-dots"><span></span><span></span><span></span></div>';

    /* Input row */
    var inputRow = document.createElement('div');
    inputRow.id = 'snx-ai-input-row';

    var label = document.createElement('label');
    label.htmlFor = 'snx-ai-input';
    label.className = 'snx-sr-only';
    label.textContent = 'Message Shadow Reaper';

    var inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.id = 'snx-ai-input';
    inputEl.maxLength = 400;
    inputEl.placeholder = 'Ask anything — or just talk…';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('aria-label', 'Message Shadow Reaper');
    inputEl.setAttribute('inputmode', 'text');

    var sendBtn = document.createElement('button');
    sendBtn.id = 'snx-ai-send';
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.textContent = '➤';

    inputRow.appendChild(label);
    inputRow.appendChild(inputEl);
    inputRow.appendChild(sendBtn);

    /* Wire events — single attach, no duplicates */
    sendBtn.addEventListener('click', function () {
      _send(inputEl.value);
    });

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _send(inputEl.value);
      }
    });

    /* Prevent iOS viewport bounce inside the scroll area */
    convArea.addEventListener('touchmove', function (e) {
      e.stopPropagation();
    }, { passive: true });

    /* Mobile keyboard: keep input visible */
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', function () {
        var panel = document.getElementById('grim-panel');
        if (!panel || !panel.classList.contains('open')) return;
        var gap = global.innerHeight - global.visualViewport.height;
        panel.style.paddingBottom = gap > 0 ? (gap + 'px') : '';
      });
    }

    /* Append in order */
    panel.appendChild(statusBar);
    panel.appendChild(convArea);
    panel.appendChild(typingEl);
    panel.appendChild(inputRow);

    _uiInjected = true;

    /* Stage 4A: initialise voice module now that the input row exists */
    if (global.SNXShadowVoice && typeof global.SNXShadowVoice.init === 'function') {
      try {
        global.SNXShadowVoice.init();
        global.SNXShadowVoice.injectControls();
      } catch (_) { /* voice errors never crash text assistant */ }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     GREETING
  ───────────────────────────────────────────────────────────────*/
  var _greeted = false;

  function _greet() {
    if (_greeted) return;
    _greeted = true;
    var greetings = [
      "Welcome back, Legend. What do you need help with?",
      "The shadows part. I know every corner of Shadow Nexus Social — ask me anything, or simply speak what is on your mind.",
      "Guardian of Shadow Nexus at your service. Looking for a feature or carrying something else — I am here for both."
    ];
    var text = greetings[Math.floor(Math.random() * greetings.length)];
    _addToHistory('grim', text);
    setTimeout(function () { _appendMessage('grim', text); }, 500);
    _setStatus(STATUS.READY);
  }

  /* ─────────────────────────────────────────────────────────────
     OPEN / CLOSE
  ───────────────────────────────────────────────────────────────*/
  function _open() {
    _injectUI();
    _greet();
    _open_flag();
    /* Focus input */
    setTimeout(function () {
      var inp = _getInput();
      if (inp && global.innerWidth > 768) inp.focus();
    }, 380);
  }

  function _open_flag() { _open = true; }

  function _close() {
    _open = false;
    /* Stage 4A: stop mic + TTS when panel closes */
    if (global.SNXShadowVoice && typeof global.SNXShadowVoice.onPanelClose === 'function') {
      try { global.SNXShadowVoice.onPanelClose(); } catch (_) {}
    }
  }

  /* ─────────────────────────────────────────────────────────────
     INIT  — idempotent
  ───────────────────────────────────────────────────────────────*/
  function _init() {
    if (_initialized) return;
    _initialized = true;
    _injectUI();
    console.log('[SNXShadowAI] Initialized. Build: ' + BUILD_ID);
  }

  /* ─────────────────────────────────────────────────────────────
     DESTROY  — safe teardown (account-switch safe)
  ───────────────────────────────────────────────────────────────*/
  function _destroy() {
    _abortPending();

    /* Stage 4A: tear down voice module before cleaning up UI */
    if (global.SNXShadowVoice && typeof global.SNXShadowVoice.destroy === 'function') {
      try { global.SNXShadowVoice.destroy(); } catch (_) {}
    }

    _busy = false;
    _open = false;
    _initialized = false;
    _greeted = false;
    _history = [];
    _uiInjected = false;
    _aiLimitMode = false;  // reset AI-limit mode on account switch / explicit reset

    /* Stage 3C: reset session context — never persisted anyway */
    _sessionCtx = {
      lastTopic:        null,
      lastFeature:      null,
      lastCreatorTopic: null,
      lastIntent:       null,
      recentIds:        [],
      recentNavTarget:  null,
      turnCount:        0,
      pendingClarify:   null
    };

    /* E1: reset conversation context — never persisted anyway */
    if (global.SNXShadowE1 && typeof global.SNXShadowE1.destroy === 'function') {
      try { global.SNXShadowE1.destroy(); } catch (_) {}
    }

    /* E2: reset memory session state — persistent data NOT affected */
    if (global.SNXShadowMemory && typeof global.SNXShadowMemory.destroy === 'function') {
      try { global.SNXShadowMemory.destroy(); } catch (_) {}
    }

    /* Re-show old GP elements */
    ['gp-messages','gp-typing','gp-input-row','gp-nav-chips','gp-fullpage-link','gp-status']
      .forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = '';
      });

    /* Remove injected SNX AI elements */
    ['snx-ai-statusbar','snx-ai-conversation','snx-ai-typing','snx-ai-input-row']
      .forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      });

    console.log('[SNXShadowAI] Destroyed.');
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API  — window.SNXShadowAI
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowAI = {
    /** Initialize the AI core (idempotent). */
    init: _init,

    /** Open the AI conversation UI inside the existing grim-panel. */
    open: _open,

    /** Close / hide the AI conversation UI. */
    close: _close,

    /**
     * Send a message programmatically.
     * @param {string} message
     */
    ask: function (message) { _send(message); },

    /**
     * Returns safe context object (no tokens, no secrets).
     * @returns {object}
     */
    getContext: _buildContext,

    /**
     * Returns current capabilities.
     * @returns {object}
     */
    getCapabilities: _getCapabilities,

    /**
     * Stage 3C: Returns safe session context (no user data, no history, no tokens).
     * Useful for Founder diagnostics.
     * @returns {object}
     */
    getSessionContext: function () {
      return {
        lastTopic:        _sessionCtx.lastTopic,
        lastFeature:      _sessionCtx.lastFeature,
        lastCreatorTopic: _sessionCtx.lastCreatorTopic,
        lastIntent:       _sessionCtx.lastIntent,
        recentIds:        _sessionCtx.recentIds.slice(),
        recentNavTarget:  _sessionCtx.recentNavTarget,
        turnCount:        _sessionCtx.turnCount
        /* pendingClarify omitted — internal state only */
      };
    },

    /** Safe navigate to an approved internal destination. */
    navigateTo: navigateTo,

    /** Full teardown — call on account switch or explicit reset. */
    destroy: _destroy,

    /** Expose provider for Stage 2 replacement. */
    provider: SNXShadowAIProvider,

    /** Build identifier */
    build: BUILD_ID,

    /**
     * Stage 4B: Register a callback for when AI starts processing (THINKING).
     * @param {function} fn
     */
    onThinking: function (fn) {
      if (typeof fn === 'function' && _thinkingListeners.indexOf(fn) === -1) {
        _thinkingListeners.push(fn);
      }
    },

    /**
     * Stage 4B: Register a callback for when AI delivers an answer.
     * @param {function} fn
     */
    onAnswer: function (fn) {
      if (typeof fn === 'function' && _answerListeners.indexOf(fn) === -1) {
        _answerListeners.push(fn);
      }
    }
  };

})(window);
