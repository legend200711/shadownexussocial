/**
 * shadow-reaper/core/understanding-engine.js
 * Shadow Reaper AI — Understanding Engine
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Deterministic local NLU layer. No Workers AI. No external calls.
 *
 * Responsibilities:
 *  - Intent classification (13 categories)
 *  - Topic extraction
 *  - Feature identification
 *  - Typo correction
 *  - Pronoun / follow-up resolution
 *  - Short reply detection
 *  - Context reference detection
 *  - Memory command detection
 *  - Conversation history command detection
 *  - User correction detection
 *  - Greeting detection
 *  - Troubleshooting detection
 *  - Continuity question detection
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-UNDERSTANDING-001';

  /* ─────────────────────────────────────────────────────────────
     INTENT CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var INTENT = {
    GREETING:           'GREETING',
    QUESTION:           'QUESTION',
    STATEMENT:          'STATEMENT',
    NAVIGATION:         'NAVIGATION',
    HOW_TO:             'HOW_TO',
    TROUBLESHOOT:       'TROUBLESHOOT',
    CREATOR:            'CREATOR',
    FEATURE:            'FEATURE',
    PERMISSION:         'PERMISSION',
    ACCOUNT:            'ACCOUNT',
    PRIVACY:            'PRIVACY',
    SAFETY:             'SAFETY',
    STATUS:             'STATUS',
    MEMORY_COMMAND:     'MEMORY_COMMAND',
    HISTORY_COMMAND:    'HISTORY_COMMAND',
    ADAPTIVE_COMMAND:   'ADAPTIVE_COMMAND',
    CORRECTION:         'CORRECTION',
    CONTINUITY:         'CONTINUITY',
    GENERAL_CHAT:       'GENERAL_CHAT',
    UNKNOWN:            'UNKNOWN'
  };

  /* ─────────────────────────────────────────────────────────────
     TYPO CORRECTION TABLE (extracted from snx-shadow-ai.js)
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
    'upoad':          'uploads'
  };

  /* ─────────────────────────────────────────────────────────────
     FEATURE KEYWORDS
  ───────────────────────────────────────────────────────────────*/
  var _FEATURE_KEYWORDS = {
    radio:          ['radio', 'dj', 'station', 'broadcast', 'stream music', 'radio studio'],
    live:           ['live', 'livestream', 'streaming', 'go live', 'live video', 'cohost'],
    tv:             ['tv', 'television', 'tv network', 'tv studio', 'watch tv', 'channel'],
    feed:           ['feed', 'timeline', 'posts', 'post something', 'home feed'],
    profile:        ['profile', 'my page', 'bio', 'avatar', 'username', 'about me'],
    inbox:          ['inbox', 'messages', 'direct message', 'dm', 'chat', 'message'],
    notifications:  ['notifications', 'alerts', 'notify', 'ping', 'badge'],
    search:         ['search', 'find', 'discover', 'look up', 'find people'],
    friends:        ['friends', 'follow', 'following', 'followers', 'add friend', 'connect'],
    settings:       ['settings', 'preferences', 'account settings', 'privacy settings', 'configure'],
    community:      ['community', 'groups', 'rooms', 'storm rooms', 'support rooms'],
    arcade:         ['arcade', 'games', 'play', 'gaming'],
    uploads:        ['uploads', 'upload', 'file', 'video upload', 'music upload']
  };

  /* ─────────────────────────────────────────────────────────────
     PRONOUN / FOLLOW-UP PATTERNS
  ───────────────────────────────────────────────────────────────*/
  var _PRONOUN_PATTERNS = [
    /\b(it|this|that|those|these|them|they|he|she|the feature|the thing|the page|the section)\b/i,
    /\b(do that again|same thing|like before|as before|again|same)\b/i,
    /\b(more about|tell me more|expand on|what else|anything else)\b/i,
    /\b(what about|how about|and also|also|additionally)\b/i
  ];

  var _FOLLOW_UP_PATTERNS = [
    /^(yes|yeah|yep|yup|sure|ok|okay|right|correct|exactly|go on|continue|and\?|so\?)$/i,
    /^(no|nope|not really|not that|something else)$/i,
    /^(why|how|when|where|what|who|which)\?*$/i,
    /^(got it|i see|makes sense|understood|ok thanks|thanks|thank you)\.?$/i
  ];

  /* ─────────────────────────────────────────────────────────────
     INTENT PATTERNS
  ───────────────────────────────────────────────────────────────*/
  var _GREETING_PATTERNS = [
    /^(hi|hello|hey|howdy|sup|what'?s up|good morning|good afternoon|good evening|greetings|yo|hiya|hi there|hey there|hello there)\b/i,
    /^(how are you|how'?re you|how do you do|how'?s it going|what'?s good)\b/i
  ];

  var _CONTINUITY_PATTERNS = [
    /\b(what were we|where were we|continue where|pick up where|last (time|conversation|session|chat)|what did (i|we) (say|talk|discuss)|what were (we|you) talking|restore|reload|go back to)\b/i,
    /\b(what did i tell you|what do you remember (about me|from last)|from (yesterday|last week|before))\b/i,
    /\b(what project were we|what were we working on)\b/i
  ];

  var _MEMORY_PATTERNS = [
    /\b(remember (that|my|this|i|the)|don'?t forget|save (that|this|my)|store (this|that|my))\b/i,
    /\b(what do you (remember|know) (about|of) (me|my)|recall|my memories|show (me )?my memories|list (my )?memories)\b/i,
    /\b(forget (that|my|this|everything|about)|clear (my )?memories?|delete (what you know|my memory|that memory))\b/i
  ];

  var _HISTORY_PATTERNS = [
    /\b(conversation history|history (is|on|off)|turn (off|on) history|disable history|enable history|clear (my |chat )?history|delete (my |chat )?history)\b/i
  ];

  var _ADAPTIVE_PATTERNS = [
    /\b(what have you learned (about me)?|your (learned|adaptive) (context|knowledge|info)|clear (what you('?ve)? learned|learned context|adaptive)|forget (what you)?('?ve)? learned)\b/i
  ];

  var _CORRECTION_PATTERNS = [
    /\b(no,?\s+(i meant|i said|i was|that'?s not)|that'?s wrong|not (quite|exactly|right)|actually,? (i meant|it'?s|i said)|you misunderstood|let me correct|correct yourself|wrong,? i said)\b/i,
    /\b(i meant|i said|i was saying|to clarify|to be clear|what i meant (was|is))\b/i
  ];

  var _TROUBLESHOOT_PATTERNS = [
    /\b(not working|isn'?t working|doesn'?t work|broken|bug|issue|problem|error|can'?t (access|login|load|open|find)|won'?t (load|open|work)|keeps? (crashing|freezing|failing)|stuck|help me fix|something'?s? wrong|trouble with|having issues?)\b/i,
    /\b(why (isn'?t|doesn'?t|can'?t)|what'?s wrong with|fix (the|my|this)|isn'?t (working|loading|playing|opening))\b/i
  ];

  var _HOWTO_PATTERNS = [
    /\b(how (do|can|to|do i|can i)|step(s| by step)| (walkthrough|tutorial|guide|instructions?|show me how|teach me|help me (do|with|set up|create|make|start|find|use|change|edit|delete|add|remove|enable|disable|turn (on|off))))\b/i
  ];

  var _NAVIGATION_PATTERNS = [
    /\b(go to|take me to|open|navigate to|show me|switch to|bring up)\b.*\b(radio|live|tv|feed|profile|inbox|notifications|settings|search|friends|community|arcade|uploads)\b/i,
    /\b(go to|take me to|open|navigate to|show me|switch to|bring up)\s+\w+\b/i
  ];

  var _QUESTION_PATTERNS = [
    /^(what|who|where|when|why|how|which|can|could|would|should|do|does|is|are|was|were|has|have|had|will|shall|may|might|must|am)\b/i,
    /\?$/
  ];

  var _GENERAL_CHAT_PATTERNS = [
    /\b(i (feel|felt|am feeling|was feeling|think|thought|believe|wonder|love|hate|miss|enjoy|want|need|like|dislike)|my (mood|day|life|story|opinion|view|feeling|experience))\b/i,
    /\b(tell me (a joke|something funny|a story|about yourself)|are you (sentient|conscious|alive|real|an ai)|what('?s| is) your (name|favorite|opinion|view|thought))\b/i,
    /\b(let'?s (chat|talk|discuss)|i want to (chat|talk|discuss|ask you|say|vent|share))\b/i,
    /\b(just (talking|chatting|thinking|wondering|curious)|random(ly)?)\b/i
  ];

  /* ─────────────────────────────────────────────────────────────
     SHORT-REPLY DETECTION
  ───────────────────────────────────────────────────────────────*/
  function _isShortReply(text) {
    return text.trim().split(/\s+/).length <= 4;
  }

  /* ─────────────────────────────────────────────────────────────
     TYPO CORRECTION
  ───────────────────────────────────────────────────────────────*/
  function _correctTypos(text) {
    var lower = text.toLowerCase();
    var result = lower;
    var keys = Object.keys(_TYPO_MAP);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (lower.indexOf(k) !== -1) {
        result = result.split(k).join(_TYPO_MAP[k]);
      }
    }
    return result;
  }

  /* ─────────────────────────────────────────────────────────────
     FEATURE DETECTION
  ───────────────────────────────────────────────────────────────*/
  function _detectFeature(text) {
    var lower = text.toLowerCase();
    var featureKeys = Object.keys(_FEATURE_KEYWORDS);
    for (var i = 0; i < featureKeys.length; i++) {
      var feature = featureKeys[i];
      var keywords = _FEATURE_KEYWORDS[feature];
      for (var j = 0; j < keywords.length; j++) {
        if (lower.indexOf(keywords[j]) !== -1) {
          return feature;
        }
      }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     TOPIC EXTRACTION
  ───────────────────────────────────────────────────────────────*/
  function _extractTopic(text) {
    // Try to find "my project is X" or "working on X" patterns
    var projectMatch = text.match(/\b(?:my project|project name|working on|called|named|project is|it'?s called)\s+([A-Za-z0-9 _\-]{2,40})/i);
    if (projectMatch) return projectMatch[1].trim();

    // Try "about X" pattern
    var aboutMatch = text.match(/\babout\s+([A-Za-z0-9 _\-]{2,30})\b/i);
    if (aboutMatch) return aboutMatch[1].trim();

    // Fall back to detected feature
    var feature = _detectFeature(text);
    if (feature) return feature;

    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     PRONOUN RESOLUTION
     Checks if message has pronouns that need context resolution.
  ───────────────────────────────────────────────────────────────*/
  function _needsContextResolution(text) {
    for (var i = 0; i < _PRONOUN_PATTERNS.length; i++) {
      if (_PRONOUN_PATTERNS[i].test(text)) return true;
    }
    if (_isShortReply(text)) {
      for (var j = 0; j < _FOLLOW_UP_PATTERNS.length; j++) {
        if (_FOLLOW_UP_PATTERNS[j].test(text.trim())) return true;
      }
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     INTENT CLASSIFICATION
  ───────────────────────────────────────────────────────────────*/
  function _classifyIntent(text) {
    var lower = text.toLowerCase().trim();

    // Greetings first
    for (var g = 0; g < _GREETING_PATTERNS.length; g++) {
      if (_GREETING_PATTERNS[g].test(lower)) return INTENT.GREETING;
    }

    // Memory commands
    for (var m = 0; m < _MEMORY_PATTERNS.length; m++) {
      if (_MEMORY_PATTERNS[m].test(lower)) return INTENT.MEMORY_COMMAND;
    }

    // History commands
    for (var h = 0; h < _HISTORY_PATTERNS.length; h++) {
      if (_HISTORY_PATTERNS[h].test(lower)) return INTENT.HISTORY_COMMAND;
    }

    // Adaptive learning commands
    for (var a = 0; a < _ADAPTIVE_PATTERNS.length; a++) {
      if (_ADAPTIVE_PATTERNS[a].test(lower)) return INTENT.ADAPTIVE_COMMAND;
    }

    // Continuity
    for (var c = 0; c < _CONTINUITY_PATTERNS.length; c++) {
      if (_CONTINUITY_PATTERNS[c].test(lower)) return INTENT.CONTINUITY;
    }

    // User correction
    for (var cor = 0; cor < _CORRECTION_PATTERNS.length; cor++) {
      if (_CORRECTION_PATTERNS[cor].test(lower)) return INTENT.CORRECTION;
    }

    // Troubleshooting
    for (var t = 0; t < _TROUBLESHOOT_PATTERNS.length; t++) {
      if (_TROUBLESHOOT_PATTERNS[t].test(lower)) return INTENT.TROUBLESHOOT;
    }

    // Navigation
    for (var n = 0; n < _NAVIGATION_PATTERNS.length; n++) {
      if (_NAVIGATION_PATTERNS[n].test(lower)) return INTENT.NAVIGATION;
    }

    // How-to
    for (var hw = 0; hw < _HOWTO_PATTERNS.length; hw++) {
      if (_HOWTO_PATTERNS[hw].test(lower)) return INTENT.HOW_TO;
    }

    // General chat / emotional
    for (var gc = 0; gc < _GENERAL_CHAT_PATTERNS.length; gc++) {
      if (_GENERAL_CHAT_PATTERNS[gc].test(lower)) return INTENT.GENERAL_CHAT;
    }

    // Question
    for (var q = 0; q < _QUESTION_PATTERNS.length; q++) {
      if (_QUESTION_PATTERNS[q].test(lower)) return INTENT.QUESTION;
    }

    // Statement (has verb or declarative structure)
    if (/^(i |my |we |the |this |that )/.test(lower) && lower.length > 10) {
      return INTENT.STATEMENT;
    }

    return INTENT.UNKNOWN;
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API: understand(text, sessionContext)
     Returns a structured understanding object.
  ───────────────────────────────────────────────────────────────*/
  function understand(rawText, sessionCtx) {
    if (!rawText || typeof rawText !== 'string') {
      return { intent: INTENT.UNKNOWN, topic: null, feature: null,
               needsContext: false, isShort: false, corrected: '', raw: '' };
    }

    var raw = rawText.trim().slice(0, 2000); // hard cap
    var corrected = _correctTypos(raw);
    var intent = _classifyIntent(corrected);
    var feature = _detectFeature(corrected);
    var topic = _extractTopic(corrected);
    var needsContext = _needsContextResolution(corrected);
    var isShort = _isShortReply(corrected);

    // Resolve pronoun context using provided session context
    var resolvedTopic = topic;
    var resolvedFeature = feature;
    if (needsContext && sessionCtx) {
      if (!resolvedTopic && sessionCtx.lastTopic) resolvedTopic = sessionCtx.lastTopic;
      if (!resolvedFeature && sessionCtx.lastFeature) resolvedFeature = sessionCtx.lastFeature;
    }

    return {
      intent:          intent,
      topic:           resolvedTopic,
      feature:         resolvedFeature,
      needsContext:    needsContext,
      isShort:         isShort,
      corrected:       corrected,
      raw:             raw,
      isGreeting:      intent === INTENT.GREETING,
      isMemoryCmd:     intent === INTENT.MEMORY_COMMAND,
      isHistoryCmd:    intent === INTENT.HISTORY_COMMAND,
      isAdaptiveCmd:   intent === INTENT.ADAPTIVE_COMMAND,
      isContinuity:    intent === INTENT.CONTINUITY,
      isCorrection:    intent === INTENT.CORRECTION,
      isTroubleshoot:  intent === INTENT.TROUBLESHOOT,
      isNavigation:    intent === INTENT.NAVIGATION,
      isQuestion:      intent === INTENT.QUESTION || intent === INTENT.HOW_TO,
      isGeneralChat:   intent === INTENT.GENERAL_CHAT
    };
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRUnderstanding = {
    understand:  understand,
    INTENT:      INTENT,
    build:       BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
