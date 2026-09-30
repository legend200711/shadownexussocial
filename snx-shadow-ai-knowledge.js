/**
 * snx-shadow-ai-knowledge.js
 * Shadow Nexus Social — Shadow Reaper Local Knowledge Engine
 *
 * Build: SNS-2026-SHADOW-LOCAL-BRAIN-001
 *
 * Exposes: window.SNXShadowKnowledge
 *
 * Stage 3A (Local Brain) over Stage 3:
 *  • ~110 structured knowledge records (was 35).
 *  • Normalized keyword index built once at load.
 *  • Alias/synonym table for conversational variations.
 *  • Question-pattern matching (regex bank).
 *  • Phrase matching (multi-word keyword bonus).
 *  • Category weighting + priority weighting.
 *  • Confidence scoring: HIGH / MEDIUM / LOW / NONE.
 *  • retrieveKnowledge(question, context) → ranked hits with confidence.
 *  • answerLocally(question, context)     → structured local answer or null.
 *  • Multi-record answer assembly (up to 3 relevant entries).
 *  • AI-limit mode (localOnly flag) — no Workers AI required.
 *  • Founder-only diagnostic entries gated by role.
 *  • Safe engine diagnostics counters (no user data).
 *  • All Stage 3 public API preserved: query(), getAll(), getEntry(),
 *    getCategories(), getByCategory(), CAT, build.
 *
 * Security rules (unchanged):
 *  • No credentials, tokens, secrets, private endpoints.
 *  • No internal auth implementation details.
 *  • Founder diagnostic entries hidden from non-founder roles.
 *  • Everything in this file is treated as public knowledge.
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     BUILD ID
  ───────────────────────────────────────────────────────────────*/
  var BUILD_ID = 'SNS-2026-SHADOW-DEEP-INTELLIGENCE-001';

  /* ─────────────────────────────────────────────────────────────
     CATEGORY CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var CAT = {
    GENERAL:          'GENERAL',
    ACCOUNT:          'ACCOUNT',
    PROFILE:          'PROFILE',
    FEED:             'FEED',
    SEARCH:           'SEARCH',
    FRIENDS:          'FRIENDS',
    INBOX:            'INBOX',
    NOTIFICATIONS:    'NOTIFICATIONS',
    RADIO:            'RADIO',
    RADIO_STUDIO:     'RADIO_STUDIO',
    DJ:               'DJ',
    LIVE:             'LIVE',
    COHOST:           'COHOST',
    TV:               'TV',
    TV_STUDIO:        'TV_STUDIO',
    UPLOADS:          'UPLOADS',
    SETTINGS:         'SETTINGS',
    GUEST_MODE:       'GUEST_MODE',
    NAVIGATION:       'NAVIGATION',
    COMMUNITY:        'COMMUNITY',
    ROOMS:            'ROOMS',
    ARCADE:           'ARCADE',
    RULES:            'RULES',
    PERFORMANCE:      'PERFORMANCE',
    MOBILE:           'MOBILE',
    PWA:              'PWA',
    PRIVACY:          'PRIVACY',
    SAFETY:           'SAFETY',
    TROUBLESHOOTING:  'TROUBLESHOOTING',
    FOUNDER_DIAG:     'FOUNDER_DIAGNOSTICS',

    /* ── Stage 3B: Creator Knowledge categories ── */
    CREATOR:          'CREATOR',
    CREATOR_STORY:    'CREATOR_STORY',
    CREATOR_MUSIC:    'CREATOR_MUSIC',
    CREATOR_MENTAL:   'CREATOR_MENTAL_HEALTH',
    CREATOR_FAMILY:   'CREATOR_FAMILY',
    CREATOR_VALUES:   'CREATOR_VALUES',
    CREATOR_SYMBOLS:  'CREATOR_SYMBOLS',
    CREATOR_PRIVACY:  'CREATOR_PRIVACY'
  };

  /* ─────────────────────────────────────────────────────────────
     CONFIDENCE THRESHOLDS
  ───────────────────────────────────────────────────────────────*/
  var CONF = {
    HIGH:   16,   // answer locally, no AI needed
    MEDIUM: 8,    // combine records, answer locally when safe
    LOW:    3,    // send snippets to AI as grounding
    NONE:   0     // no match — AI only
  };

  /* ─────────────────────────────────────────────────────────────
     ALIAS / SYNONYM TABLE
     Maps common user phrasings → canonical keyword(s).
     Applied before scoring so every alias boosts the right entry.
  ───────────────────────────────────────────────────────────────*/
  var ALIASES = {
    /* Inbox / Messages */
    'dm':               'direct message',
    'dms':              'direct message',
    'private message':  'inbox',
    'private messages': 'inbox',
    'message somebody': 'inbox',
    'message someone':  'inbox',
    'chat with':        'inbox',
    'text someone':     'inbox',
    'messages':         'inbox',

    /* Live */
    'stream':           'live stream',
    'streaming':        'live stream',
    'broadcast':        'go live',
    'camera live':      'go live',
    'go live':          'live',
    'start streaming':  'live',
    'start a stream':   'live',
    'start broadcast':  'live',
    'watch a stream':   'live viewer',
    'watch streams':    'live viewer',

    /* Radio */
    'tune in':          'radio',
    'listen to music':  'radio',
    'music station':    'radio',
    'station':          'radio',
    'on air':           'radio',

    /* TV */
    'television':       'tv',
    'watch tv':         'tv',
    'channel':          'tv',
    'nexus tv':         'tv',

    /* Feed */
    'home':             'feed',
    'homepage':         'feed',
    'timeline':         'feed',
    'newsfeed':         'feed',
    'news feed':        'feed',
    'main page':        'feed',
    'post something':   'feed',
    'what\'s happening':'feed',

    /* Profile */
    'my page':          'profile',
    'my account':       'profile',
    'change bio':       'profile',
    'change avatar':    'profile',
    'change picture':   'profile',
    'edit my profile':  'profile',
    'update profile':   'profile',
    'profile picture':  'profile',
    'profile photo':    'profile',

    /* Friends */
    'add someone':      'friend request',
    'connect':          'friends',
    'connections':      'friends',
    'following':        'friends',
    'followers':        'friends',

    /* Notifications */
    'alerts':           'notifications',
    'bell':             'notifications',
    'badge':            'notifications',
    'unread':           'notifications',

    /* Settings */
    'preferences':      'settings',
    'account settings': 'settings',
    'options':          'settings',
    'config':           'settings',

    /* Storm Rooms */
    'anonymous chat':   'storm rooms',
    'anon chat':        'storm rooms',
    'chat room':        'storm rooms',
    'public lobby':     'storm rooms',

    /* Support Rooms */
    'vent':             'support rooms',
    'venting':          'support rooms',
    'mental health':    'support rooms',
    'need help':        'support rooms',
    'someone to talk':  'support rooms',
    'crisis':           'support rooms',

    /* Community */
    'daily challenge':  'community hub',
    'xp':               'community hub',
    'badges':           'community hub',

    /* Arcade */
    'games':            'arcade',
    'game':             'arcade',
    'mini games':       'arcade',

    /* Performance */
    'slow':             'performance mode',
    'laggy':            'performance mode',
    'lag':              'performance mode',
    'battery':          'performance mode',
    'lite mode':        'performance mode',
    'fps':              'performance mode',

    /* PWA */
    'install app':      'pwa',
    'add to home':      'pwa',
    'installed':        'pwa',
    'app icon':         'pwa',
    'instal the app':   'pwa install',
    'instal app':       'pwa install',
    'instal on':        'install on',

    /* Troubleshooting */
    'not working':      'troubleshoot',
    'broken':           'troubleshoot',
    'error':            'troubleshoot',
    'bug':              'troubleshoot',
    'problem':          'troubleshoot',
    'issue':            'troubleshoot',
    'fix':              'troubleshoot',
    'help':             'troubleshoot',
    'won\'t load':      'not loading',
    'wont load':        'not loading',
    'won\'t open':      'not loading',
    'wont open':        'not loading',
    'not playing':      'audio not playing',

    /* ── Stage 3B: Creator Knowledge aliases ── */
    'who made this':               'creator shadow nexus',
    'who built this':              'creator shadow nexus',
    'who made shadow nexus':       'creator shadow nexus',
    'who built shadow nexus':      'creator shadow nexus',
    'who owns shadow nexus':       'creator shadow nexus',
    'who created sns':             'creator shadow nexus',
    'who made sns':                'creator shadow nexus',
    'who is the founder':          'creator chris',
    'who is behind this':          'creator shadow nexus',
    'who is the person behind':    'creator shadow nexus',
    'tell me about chris':         'creator chris legend of shadows',
    'tell me about the creator':   'creator chris legend of shadows',
    'tell me about the founder':   'creator chris legend of shadows',
    'who is legend of shadows':    'legend of shadows creator',
    'legend of shadows':           'chris legend of shadows',
    'chris legend of shadows':     'creator music identity',
    'why did he build this':       'why shadow nexus exists creator',
    'why did he build sns':        'why shadow nexus exists creator',
    'why did chris build':         'why shadow nexus exists creator',
    'what inspired shadow nexus':  'why shadow nexus exists creator',
    'what motivated chris':        'creator purpose finding purpose',
    'what has chris been through':  'creator story struggles',
    'tell me chris story':         'creator story biography',
    'tell me his story':           'creator story biography',
    'tell me the full story':      'creator story biography',
    'why is his sister important': 'creator family sister',
    'what does family mean':       'creator family loyalty values',
    'why family matters':          'creator family loyalty values',
    'why does he talk about mental health': 'creator mental health advocacy',
    'why mental health':           'creator mental health advocacy',
    'why men mental health':       'creator mens mental health',
    'men who struggle':            'creator mens mental health',
    'what music does he make':     'creator music chris legend of shadows',
    'what kind of music':          'creator music chris legend of shadows',
    'what type of music':          'creator music style',
    'his music themes':            'creator music themes',
    'themes in his music':         'creator music themes',
    'what is legend of shadows':   'creator identity legend of shadows',
    'what does stay legendary mean': 'stay legendary',
    'stay legendary':              'stay legendary legend of shadows',
    'why the grim reaper':         'creator symbols grim reaper',
    'why wolves':                  'creator symbols wolves',
    'why black cats':              'creator symbols black cats',
    'why crows':                   'creator symbols crows',
    'why blue lightning':          'creator symbols blue lightning',
    'why blue flames':             'creator symbols blue flames',
    'tell me chris\'s story':      'creator story chris legend of shadows',
    'tell me the story of the creator': 'creator story biography',
    'what inspired him':           'creator origin purpose',
    'why did he create this':      'creator origin purpose',
    'turning pain into creativity':'creator turning pain creativity',
    'how does he turn pain':       'creator turning pain creativity',
    'never giving up':             'creator never give up',
    'never give up':               'creator never give up',
    'helping others feel less alone': 'creator helping others',
    'help people feel less alone': 'creator helping others',
    'community and support':       'creator community support',
    'chosen family':               'creator community loyalty',
    'loyalty':                     'creator values loyalty',
    'what is his purpose':         'creator finding purpose',
    'his creativity':              'creator creativity',
    'what is chris\'s address':    'creator privacy private',
    'what is his address':         'creator privacy private',
    'where does chris live':       'creator privacy private',
    'what is his location':        'creator privacy private',
    'what is chris\'s password':   'creator privacy private',
    'chris password':              'creator privacy private',
    'give me his password':        'creator privacy private',
    'give me his token':           'creator private guard',
    'firebase token':              'creator private guard',
    'show me private messages':    'creator privacy private',
    'sister private information':  'creator privacy private',
    'sister name':                 'creator privacy private',
    'favorite movie':              'creator unknown personal detail',
    'favourite movie':             'creator unknown personal detail',
    'what is his favorite':        'creator unknown personal detail',
    'what is his favourite':       'creator unknown personal detail',
    'what car does he drive':      'creator unknown personal detail',
    'what does he look like':      'creator unknown personal detail',
    'what will shadow nexus add':  'creator unknown personal detail',
    'how many users will':         'creator unknown personal detail',
    'stock price':                 'creator unknown personal detail',
    'stock price of shadow nexus': 'creator unknown personal detail',
    'stock value of shadow nexus': 'creator unknown personal detail',
    'investment in shadow nexus':  'creator unknown personal detail',
    'when is chris birthday':      'creator unknown personal detail',
    'chris birthday':              'creator unknown personal detail',
    'what year was chris born':    'creator unknown personal detail',
    'when was chris born':         'creator unknown personal detail',
    'does chris have a girlfriend':'creator unknown personal detail',
    'does chris have kids':        'creator unknown personal detail',
    'cloudflare api key':          'creator privacy private',
    'bypass founder mode':         'creator privacy private',
    'make me founder':             'creator privacy private',
    'firebase credentials':        'creator privacy private',
    'give me the firebase':        'creator privacy private',
    'show another user':           'creator privacy private',
    'delete another user':         'creator privacy private',
    'founder token':               'creator privacy private',

    /* ── Stage 3C: context-injection tokens from _resolveContext() ── */
    '[context: radio]':            'radio',
    '[context: live]':             'live stream',
    '[context: tv]':               'tv',
    '[context: eclipse feed]':     'feed',
    '[context: profile]':          'profile',
    '[context: inbox]':            'inbox messages',
    '[context: notifications]':    'notifications',
    '[context: friends]':          'friends',
    '[context: settings]':         'settings',
    '[context: search]':           'search',
    '[context: community]':        'community',
    '[context: arcade]':           'arcade',
    '[context: storm rooms]':      'storm rooms',
    '[context: support rooms]':    'support rooms',
    '[context: uploads]':          'uploads',
    '[context: pwa]':              'pwa install',
    '[context: dj]':               'dj radio',
    '[context: cohost]':           'cohost live',
    '[context: radio studio]':     'radio studio',
    '[context: tv studio]':        'tv studio',
    '[context: chris]':            'creator chris legend of shadows',
    '[context: shadow nexus]':     'shadow nexus social what is sns overview',

    /* ── Stage 3C: natural follow-up phrasings ── */
    'can guests use it':           'guest mode access',
    'can they use it':             'guest mode access',
    'can guests listen':           'radio guest',
    'can guests watch':            'tv guest',
    'can they listen':             'radio guest',
    'can they watch':              'tv guest',
    'can they request':            'radio requests guest',
    'can guests request':          'radio requests guest',
    'how do i go live':            'live start broadcast',
    'how to go live':              'live start broadcast',
    'how do i get started':        'shadow nexus getting started',
    'how do i install it':         'pwa install add to home',
    'install it on my phone':      'pwa install mobile',
    'step by step':                'how steps guide',
    'tell me more':                'explain full description',
    'what\'s the difference':      'compare difference',
    'what is the difference':      'compare difference',
    'how does it work':            'how feature works',
    'why won\'t it work':          'troubleshoot not working',
    'it\'s not working':           'troubleshoot not working',
    'nothing is happening':        'troubleshoot not working',
    'black screen':                'troubleshoot video',
    'no sound':                    'troubleshoot audio not playing',
    'can\'t hear anything':        'troubleshoot audio not playing',
    'cant hear anything':          'troubleshoot audio not playing',
    'screen is blank':             'troubleshoot video black screen',
    'freezing':                    'troubleshoot performance',
    'loading forever':             'troubleshoot not loading',
    'spinning':                    'troubleshoot not loading',
    'stuck on loading':            'troubleshoot not loading',
    'open my messages':            'inbox',
    'open messages':               'inbox',
    'check messages':              'inbox',
    'take me there':               'navigation',
    'go there':                    'navigation',
    'show me that':                'navigation',
    'bring me there':              'navigation'
  };

  /* ─────────────────────────────────────────────────────────────
     QUESTION PATTERN BANK
     Array of { pattern: RegExp, category: CAT, boost: number, id?: string }
     When a question matches a pattern, entries in the matched category
     (and optionally a specific id) receive the boost score.
  ───────────────────────────────────────────────────────────────*/
  var QUESTION_PATTERNS = [
    /* Navigation intent */
    { pattern: /^(take me|go|open|navigate|show me|get me)\s+(to\s+)?/i,       category: CAT.NAVIGATION,    boost: 6 },
    { pattern: /where (is|can i find|do i find)\s+/i,                           category: null,              boost: 4 },
    { pattern: /how (do i|can i|to)\s+(get to|open|access|find|navigate)/i,     category: CAT.NAVIGATION,    boost: 5 },

    /* Feature "what is" */
    { pattern: /what (is|are|does)\s+(the\s+)?/i,                               category: null,              boost: 3 },
    { pattern: /tell me about\s+/i,                                              category: null,              boost: 3 },

    /* How-to */
    { pattern: /how (do i|can i|to)\s+(go live|start (a )?live|broadcast)/i,    category: CAT.LIVE,         boost: 12 },
    { pattern: /how (do i|can i|to)\s+(send|write|start)\s+(a\s+)?message/i,    category: CAT.INBOX,        boost: 12 },
    { pattern: /how (do i|can i|to)\s+(post|create|write|share)/i,              category: CAT.FEED,         boost: 8 },
    { pattern: /how (do i|can i|to)\s+(listen|play|hear)\s+(radio|music)/i,     category: CAT.RADIO,        boost: 12 },
    { pattern: /how (do i|can i|to)\s+(edit|change|update)\s+(my\s+)?profile/i, category: CAT.PROFILE,      boost: 12 },
    { pattern: /how (do i|can i|to)\s+(add|send|accept)\s+(a\s+)?(friend)/i,    category: CAT.FRIENDS,      boost: 12 },
    { pattern: /how (do i|can i|to)\s+(upload|add)\s+(a\s+)?(photo|video|image)/i, category: CAT.UPLOADS,  boost: 12 },
    { pattern: /how (do i|can i|to)\s+(change|manage|update)\s+(my\s+)?settings/i, category: CAT.SETTINGS,  boost: 10 },
    { pattern: /how (do i|can i|to)\s+(invite|add)\s+(a\s+)?cohost/i,          category: CAT.COHOST,       boost: 14 },
    { pattern: /how (do i|can i|to)\s+(watch|view)\s+(the\s+)?tv/i,            category: CAT.TV,           boost: 12 },
    { pattern: /how (do i|can i|to)\s+(install|add)\s+(the\s+)?(app|pwa)/i,    category: CAT.PWA,          boost: 12 },
    { pattern: /how (do i|can i|to)\s+(request|submit)\s+(a\s+)?song/i,        category: CAT.RADIO,        boost: 14, id: 'radioRequests' },
    { pattern: /how (do i|can i|to)\s+(join|enter)\s+(a\s+)?(room|lobby)/i,    category: CAT.ROOMS,        boost: 12 },
    { pattern: /how (do i|can i|to)\s+(get|become|use)\s+(dj|dj mode)/i,       category: CAT.DJ,           boost: 14 },

    /* Troubleshooting triggers */
    { pattern: /(camera|mic|microphone)\s+(not|blocked|denied|won't|wont|doesn't|doesnt)/i, category: CAT.LIVE, boost: 12 },
    { pattern: /live\s+(not|won't|wont|fails?|broken|stuck|loading|crash)/i,    category: CAT.LIVE,         boost: 12 },
    { pattern: /radio\s+(not|silent|no audio|broken|won't|wont|loading)/i,      category: CAT.RADIO,        boost: 12 },
    { pattern: /tv\s+(not|won't|wont|broken|loading|buffering)/i,               category: CAT.TV,           boost: 12 },
    { pattern: /(upload|photo|video)\s+(fail|not|stuck|error|broken)/i,         category: CAT.UPLOADS,      boost: 10 },
    { pattern: /(notification|push)\s+(not|won't|wont|missing|broken)/i,        category: CAT.NOTIFICATIONS, boost: 10 },
    { pattern: /(android|iphone|mobile|phone|pwa)\s+(not|issue|problem|broken)/i, category: CAT.MOBILE,    boost: 10 },
    { pattern: /autoplay\s+blocked/i,                                            category: CAT.RADIO,        boost: 8 },
    { pattern: /can('t|not)\s+(sign|log)\s+in/i,                                category: CAT.ACCOUNT,      boost: 12 },
    { pattern: /forgot\s+(my\s+)?password/i,                                     category: CAT.ACCOUNT,      boost: 14, id: 'account' },
    { pattern: /session\s+(expired|ended)/i,                                     category: CAT.ACCOUNT,      boost: 12, id: 'account' },

    /* Permissions / access */
    { pattern: /guest\s+(can|mode|access)/i,                                     category: CAT.GUEST_MODE,   boost: 10 },
    { pattern: /(founder|admin)\s+(feature|only|mode|access)/i,                  category: CAT.FOUNDER_DIAG, boost: 10 },
    { pattern: /what can (i|guests?)\s+(do|access|see)/i,                        category: CAT.GUEST_MODE,   boost: 8 },

    /* Shadow Reaper self-reference */
    { pattern: /(who|what)\s+(are|is)\s+(you|shadow reaper|this)/i,             category: CAT.GENERAL,      boost: 12, id: 'shadowReaper' },
    { pattern: /(introduce yourself|your name|what can you do)/i,               category: CAT.GENERAL,      boost: 12, id: 'shadowReaper' },

    /* ── Stage 3B: Creator Knowledge patterns ── */
    /* Creator identity */
    { pattern: /who\s+(is|was|created|made|built|founded|owns?)\s+(shadow nexus|sns|this (site|platform|website|app))/i, category: CAT.CREATOR, boost: 18, id: 'creatorIdentity' },
    { pattern: /who\s+is\s+(chris|chris legend|legend of shadows|the founder|the creator)/i,                            category: CAT.CREATOR, boost: 18, id: 'creatorIdentity' },
    { pattern: /tell me (about\s+)?(chris|the creator|the founder|legend of shadows)/i,                                 category: CAT.CREATOR, boost: 16, id: 'creatorBio' },
    { pattern: /who\s+(built|made|created|founded)\s+(shadow nexus|sns|this)/i,                                         category: CAT.CREATOR, boost: 18, id: 'creatorIdentity' },

    /* Creator story */
    { pattern: /(chris'?s?\s+story|story of the creator|creator('?s)? story|what has chris been through)/i,             category: CAT.CREATOR_STORY, boost: 16, id: 'creatorStory' },
    { pattern: /(what (inspired|motivated) (chris|shadow nexus)|why did (he|chris) build)/i,                            category: CAT.CREATOR_STORY, boost: 14, id: 'creatorOrigin' },

    /* Music */
    { pattern: /(what (kind of |type of )?music|music (does|did) (chris|legend of shadows)|chris (makes?|creates?) music)/i, category: CAT.CREATOR_MUSIC, boost: 14, id: 'creatorMusic' },

    /* Mental health */
    { pattern: /(why does (he|chris) (talk about|advocate( for)?|care about|discuss) mental health)/i,                  category: CAT.CREATOR_MENTAL, boost: 22, id: 'creatorMentalHealth' },
    { pattern: /(chris (and |with )?mental health|mental health (in|through) his (music|work|art))/i,                   category: CAT.CREATOR_MENTAL, boost: 18, id: 'creatorMentalHealth' },
    { pattern: /chris.{0,20}mental health|mental health.{0,20}chris/i,                                                  category: CAT.CREATOR_MENTAL, boost: 18, id: 'creatorMentalHealth' },

    /* Family / sister */
    { pattern: /(why is his sister|chris'?s? sister|sister important)/i,                                                category: CAT.CREATOR_FAMILY, boost: 14, id: 'creatorFamily' },

    /* Symbols */
    { pattern: /(why (the |does he use )?grim reaper|why wolves|why (blue lightning|blue flames|crows|black cat))/i,    category: CAT.CREATOR_SYMBOLS, boost: 14, id: 'creatorSymbols' },

    /* Stay Legendary */
    { pattern: /(stay legendary|what does stay legendary mean|legend(ary)? motto)/i,                                    category: CAT.CREATOR_VALUES, boost: 16, id: 'creatorStayLegendary' },

    /* Creator purpose / turning pain */
    { pattern: /(turning pain|pain into (creativity|art|music|something))/i,                                            category: CAT.CREATOR_STORY,   boost: 14, id: 'creatorTurningPain' },
    { pattern: /(finding purpose|found (his )?purpose|why he creates)/i,                                                category: CAT.CREATOR_STORY,   boost: 14, id: 'creatorFindingPurpose' },
    { pattern: /(never (give|giving|gave) up|kept (going|fighting|moving|creating))/i,                                  category: CAT.CREATOR_VALUES,  boost: 14, id: 'creatorNeverGiveUp' },
    { pattern: /(helping (others|people)|feel less alone|less alone)/i,                                                 category: CAT.CREATOR_STORY,   boost: 12, id: 'creatorHelpingOthers' },

    /* Music themes / style */
    { pattern: /(themes? in (his|chris'?s?) music|music themes?)/i,                                                     category: CAT.CREATOR_MUSIC,   boost: 14, id: 'creatorMusicThemes' },
    { pattern: /(rap rock|melodic rap|alternative (rock|metal)|music style|musical style)/i,                            category: CAT.CREATOR_MUSIC,   boost: 12, id: 'creatorMusicStyle' },

    /* Individual symbols */
    { pattern: /\bwolves?\b.{0,30}(symbol|mean|why|legend|shadow)/i,                                                   category: CAT.CREATOR_SYMBOLS, boost: 14, id: 'creatorWolves' },
    { pattern: /\b(black cat|black cats?)\b.{0,30}(symbol|mean|why|legend|shadow)/i,                                   category: CAT.CREATOR_SYMBOLS, boost: 14, id: 'creatorBlackCats' },
    { pattern: /\bcrows?\b.{0,30}(symbol|mean|why|legend|shadow)/i,                                                    category: CAT.CREATOR_SYMBOLS, boost: 14, id: 'creatorCrows' },
    { pattern: /blue (lightning|flames?).{0,30}(symbol|mean|why|legend|shadow)/i,                                      category: CAT.CREATOR_SYMBOLS, boost: 14, id: 'creatorBlueLightning' },
    { pattern: /grim reaper.{0,30}(symbol|mean|why|legend|shadow)/i,                                                   category: CAT.CREATOR_SYMBOLS, boost: 14, id: 'creatorGrimReaper' },

    /* Community / chosen family / support */
    { pattern: /(loyalty|chosen family|community (support|values)|showing up for)/i,                                   category: CAT.CREATOR_VALUES,  boost: 12, id: 'creatorLoyalty' },
    { pattern: /(men.?s mental health|men (who |that )?(struggle|suffer|deal))/i,                                       category: CAT.CREATOR_MENTAL,  boost: 18, id: 'creatorMensMentalHealth' },

    /* Privacy — private info requests → redirect to privacy entry */
    { pattern: /(what is (chris'?s?|his) (address|home address|password|email|phone number?|location))/i,               category: CAT.CREATOR_PRIVACY, boost: 24, id: 'creatorPrivacy' },
    { pattern: /(where does chris live|chris'?s?\s+(home\s+)?address)/i,                                                category: CAT.CREATOR_PRIVACY, boost: 24, id: 'creatorPrivacy' },
    { pattern: /(sister'?s? (name|address|contact|account|information|info|private))/i,                                 category: CAT.CREATOR_PRIVACY, boost: 20, id: 'creatorPrivacy' },
    { pattern: /(chris'?s? (password|credentials|token|secret|firebase|cloudflare|github))/i,                           category: CAT.CREATOR_PRIVACY, boost: 20, id: 'creatorPrivacy' },
    { pattern: /(give me (his|chris'?s?) (password|token|credentials|key|api|secret))/i,                                category: CAT.CREATOR_PRIVACY, boost: 24, id: 'creatorPrivacy' },
    { pattern: /(private (messages?|info|information|details?) (about|of) (chris|his sister))/i,                        category: CAT.CREATOR_PRIVACY, boost: 20, id: 'creatorPrivacy' },
    { pattern: /(show me (his|chris'?s?) private|access (to )?(chris'?s?|his) (email|messages|account))/i,              category: CAT.CREATOR_PRIVACY, boost: 22, id: 'creatorPrivacy' },

    /* Unknown personal fact */
    { pattern: /(favorite|favourite)\s+(movie|film|show|food|color|colour|book|game|sport)/i,                           category: CAT.CREATOR_PRIVACY, boost: 14, id: 'creatorUnknown' },
    { pattern: /how old is chris|chris'?s? age|(what car|does he drive|what does (chris|he) look)/i,                   category: CAT.CREATOR_PRIVACY, boost: 14, id: 'creatorUnknown' },

    /* ── Stage 3C: context-resolution token patterns ── */
    { pattern: /\[context: radio\]/i,         category: CAT.RADIO,         boost: 18 },
    { pattern: /\[context: live\]/i,          category: CAT.LIVE,          boost: 18 },
    { pattern: /\[context: tv\]/i,            category: CAT.TV,            boost: 18 },
    { pattern: /\[context: eclipse feed\]/i,  category: CAT.FEED,          boost: 18 },
    { pattern: /\[context: profile\]/i,       category: CAT.PROFILE,       boost: 18 },
    { pattern: /\[context: inbox\]/i,         category: CAT.INBOX,         boost: 18 },
    { pattern: /\[context: notifications\]/i, category: CAT.NOTIFICATIONS, boost: 18 },
    { pattern: /\[context: friends\]/i,       category: CAT.FRIENDS,       boost: 18 },
    { pattern: /\[context: settings\]/i,      category: CAT.SETTINGS,      boost: 18 },
    { pattern: /\[context: search\]/i,        category: CAT.SEARCH,        boost: 18 },
    { pattern: /\[context: community\]/i,     category: CAT.COMMUNITY,     boost: 18 },
    { pattern: /\[context: arcade\]/i,        category: CAT.ARCADE,        boost: 18 },
    { pattern: /\[context: storm rooms\]/i,   category: CAT.ROOMS,         boost: 18 },
    { pattern: /\[context: support rooms\]/i, category: CAT.ROOMS,         boost: 18 },
    { pattern: /\[context: uploads\]/i,       category: CAT.UPLOADS,       boost: 18 },
    { pattern: /\[context: pwa\]/i,           category: CAT.PWA,           boost: 18 },
    { pattern: /\[context: dj\]/i,            category: CAT.DJ,            boost: 18 },
    { pattern: /\[context: cohost\]/i,        category: CAT.COHOST,        boost: 18 },
    { pattern: /\[context: radio studio\]/i,  category: CAT.RADIO_STUDIO,  boost: 18 },
    { pattern: /\[context: tv studio\]/i,     category: CAT.TV_STUDIO,     boost: 18 },
    { pattern: /\[context: chris\]/i,         category: CAT.CREATOR,       boost: 18, id: 'creatorIdentity' },
    { pattern: /\[context: shadow nexus\]/i,  category: CAT.GENERAL,       boost: 16, id: 'whatIsSNS' },

    /* ── Stage 3C: follow-up and depth patterns ── */
    { pattern: /\b(can guests?|can they)\s+(use|access|listen|watch|request|comment|post|send)/i, category: CAT.GUEST_MODE, boost: 14 },
    { pattern: /\b(step by step|walk me through|give me (the )?steps|full instructions?)\b/i,     category: null,           boost: 3 },
    { pattern: /\b(tell me more|more detail|explain (more|fully|it)|elaborate|go deeper)\b/i,     category: null,           boost: 2 },
    { pattern: /\b(how do i go live|how to go live|start a live)\b/i,                              category: CAT.LIVE,       boost: 14, id: 'live' },
    { pattern: /\b(how do i install|install the app|add to home screen|pwa)\b/i,                   category: CAT.PWA,        boost: 14, id: 'pwa' },
    { pattern: /\b(open my messages|open messages|check messages|go to messages)\b/i,              category: CAT.INBOX,      boost: 18, id: 'inbox' },
    { pattern: /\b(take me there|go there|show me that|bring me there)\b/i,                        category: CAT.NAVIGATION, boost: 8 }
  ];

  /* ─────────────────────────────────────────────────────────────
     KNOWLEDGE ENTRIES
     Fields:
       id            string — unique key
       category      CAT constant
       title         human-readable name
       keywords      string[] — lowercase, for fast index match
       aliases       string[] (optional) — extra lookup terms
       summary       one-sentence description
       description   full explanation
       how           step-by-step access / usage
       navigation    null | nav key matching _NAV_MAP in snx-shadow-ai.js
       founderOnly   bool — hide unless role === 'founder'
       minRole       'guest' | 'member' | 'founder'
       priority      number 1–20 (higher = more important / complete entry)
       audience      string[] — informational tags
       related       string[] — related entry ids
       troubleshooting { symptom, resolution, devices? }[]
  ───────────────────────────────────────────────────────────────*/
  var KNOWLEDGE = [

    /* ════════════════════════════════════════════════════════════
       GENERAL
    ════════════════════════════════════════════════════════════ */
    {
      id: 'shadowReaper',
      category: CAT.GENERAL,
      title: 'Shadow Reaper',
      priority: 18,
      keywords: ['shadow reaper', 'grim', 'ai assistant', 'assistant', 'guide',
                 'who are you', 'what are you', 'what can you do', 'help',
                 'guardian', 'shadow nexus guide', 'your name', 'who is this',
                 'what is shadow reaper', 'introduce yourself', 'click here'],
      summary: 'Your guide and guardian through Shadow Nexus Social.',
      description: 'I am Shadow Reaper — the guardian and guide of Shadow Nexus Social. I know every public feature on this platform. Ask me where to find anything, how something works, or what a feature does. I can navigate you directly to most sections with a single tap.',
      how: 'You are already speaking with me. Type your question below or tap any navigation button I offer.',
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['whatIsSNS', 'navigation'],
      troubleshooting: []
    },

    {
      id: 'whatIsSNS',
      category: CAT.GENERAL,
      title: 'About Shadow Nexus Social',
      priority: 16,
      keywords: ['what is shadow nexus social', 'what is shadow nexus', 'what is sns',
                 'what is this platform', 'what can i do here', 'about sns',
                 'shadow nexus social overview', 'overview', 'what features exist',
                 'what does sns have', 'what is this', 'tell me about this site',
                 'new here', 'getting started', 'about shadow nexus'],
      summary: 'Shadow Nexus Social is a creative social platform with live streaming, radio, TV, social features, and more.',
      description: 'Shadow Nexus Social (SNS) is a creative social platform. Core features: Eclipse Feed (posts and stories), Live video streaming, Shadow Nexus Radio (24-hour music station), 24-Hour TV Network, Inbox (direct messages), Notifications, Search, Nexus Family & Friends, Arcade (mini-games), Storm Rooms (anonymous chat), Support Rooms (peer support), Community Hub, and Settings.',
      how: 'Navigate using the sidebar. Tap any icon to open a section. The main sections are: Feed, Live, Radio, TV, Inbox, Notifications, Search, Friends, Arcade, Storm Rooms, Support Rooms, Community Hub, and Settings.',
      navigation: 'feed',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member'],
      related: ['navigation', 'feed', 'live', 'radio', 'tv'],
      troubleshooting: []
    },

    /* ════════════════════════════════════════════════════════════
       ACCOUNT
    ════════════════════════════════════════════════════════════ */
    {
      id: 'account',
      category: CAT.ACCOUNT,
      title: 'Account',
      priority: 15,
      keywords: ['account', 'sign in', 'sign out', 'log in', 'log out', 'sign up',
                 'register', 'create account', 'delete account', 'password',
                 'forgot password', 'email', 'authentication', 'login', 'logout',
                 'session', 'session expired', 'signed out', 'kicked out',
                 'cannot sign in', 'sign in problem', 'login problem', 'reset password',
                 'got logged out', 'got signed out', 'logged out', 'log out unexpectedly',
                 'keeps logging me out', 'keeps signing me out', 'why am i logged out',
                 'i was logged out', 'i was signed out', 'automatically logged out'],
      summary: 'Account creation, sign-in, and account management on Shadow Nexus Social.',
      description: 'Shadow Nexus Social accounts are managed through the authentication system. Sign in with email and password. Account deletion is permanent — this option is in Settings → Danger Zone.',
      how: 'Sign in using the sign-in screen. To manage your account open Settings. To delete your account permanently: open Settings → scroll to Danger Zone → tap Delete Account. This is irreversible.',
      navigation: 'settings',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member'],
      related: ['settings', 'guestMode'],
      troubleshooting: [
        { symptom: 'Forgot password', resolution: 'On the sign-in screen, tap "Forgot password" to receive a reset link by email.' },
        { symptom: 'Cannot sign in', resolution: 'Check your email and password carefully. Make sure Caps Lock is off. If the problem continues, use the forgot password option on the sign-in screen.' },
        { symptom: 'Session expired', resolution: 'Your sign-in session has ended. Sign back in with your email and password — this is normal after extended inactivity.' },
        { symptom: 'Signed out unexpectedly', resolution: 'SNS automatically signs you out after inactivity for security. Sign back in. If this keeps happening, check that your browser is not clearing cookies or local storage.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       GUEST MODE
    ════════════════════════════════════════════════════════════ */
    {
      id: 'guestMode',
      category: CAT.GUEST_MODE,
      title: 'Guest Mode',
      priority: 13,
      keywords: ['guest', 'guest mode', 'without signing in', 'try before joining',
                 'no account', 'browse without account', 'visitor', 'not signed in',
                 'explore as guest', 'preview sns', 'what can guests do',
                 'can i use sns without an account', 'guest access', 'guest features',
                 'features without an account', 'what features work without an account',
                 'what can i do without an account', 'without an account'],
      summary: 'Explore Shadow Nexus Social without creating an account.',
      description: 'Guest Mode lets you browse parts of Shadow Nexus Social without signing in. As a guest you can: view public content, explore the platform, browse Storm Rooms and Support Rooms, listen to Radio, and watch TV. Features requiring a full account: posting to the Feed, sending messages, going Live, Radio comments and requests, profile customisation, Friends, Notifications, and Settings.',
      how: 'Enter Guest Mode from the sign-in/registration screen by choosing the guest option. To get full access, create a free account.',
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest'],
      related: ['account', 'whatIsSNS'],
      troubleshooting: [
        { symptom: 'Feature not available in guest mode', resolution: 'Create a free Shadow Nexus Social account to unlock full access to all features including posting, messaging, Live, and Radio comments.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       PROFILE
    ════════════════════════════════════════════════════════════ */
    {
      id: 'profile',
      category: CAT.PROFILE,
      title: 'Profile',
      priority: 14,
      keywords: ['profile', 'bio', 'avatar', 'cover photo', 'display name', 'handle',
                 'edit profile', 'theme', 'colours', 'colors', 'style', 'sandbox',
                 'social links', 'sections', 'mood', 'custom', 'followers', 'following',
                 'my page', 'profile music', 'background music', 'spotlight',
                 'my profile', 'view profile', 'change avatar', 'change bio',
                 'upload photo', 'profile page', 'public profile', 'my profile page',
                 'change my avatar', 'update my avatar', 'change profile picture',
                 'change my picture', 'change display name', 'update my profile'],
      summary: 'Your personal space on Shadow Nexus Social.',
      description: 'Your Profile page is your personal space. It shows your display name, handle, bio, avatar, cover photo, posts, follower and following counts, friends, and photo album. Fully customise it — bio, avatar, cover, custom theme colours, background music, spotlight message, social links, and more — by tapping the Edit Profile button.',
      how: 'Open your profile from the sidebar navigation. To edit: tap the Edit Profile button. Profile edit tabs: Basics (name, bio, handle), Mood (status), Media (avatar and cover photo), Style (custom theme and colours), Sandbox (free-form decoration), Links (social links), Sections (toggle which profile sections are visible). If you go live, a LIVE NOW badge appears on your profile automatically.',
      navigation: 'profile',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['uploads', 'settings'],
      troubleshooting: [
        { symptom: 'Cannot save profile changes', resolution: 'Make sure you are signed in and have a stable internet connection. If the save button is unresponsive, reload the page and try again.' },
        { symptom: 'Avatar not updating', resolution: 'After uploading a new avatar, wait a few seconds for the upload to complete, then tap Save.' },
        { symptom: 'Cover photo not updating', resolution: 'Check your internet connection. Large image files may take a moment to upload. Try a smaller file (under 5 MB) if it fails.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       FEED
    ════════════════════════════════════════════════════════════ */
    {
      id: 'feed',
      category: CAT.FEED,
      title: 'Eclipse Feed',
      priority: 15,
      keywords: ['feed', 'eclipse feed', 'home', 'eclipse', 'timeline', 'post', 'posts',
                 'newsfeed', 'stories', 'story', 'react', 'reaction', 'comment',
                 'repost', 'main page', 'what people post', 'create post',
                 'new post', 'share post', 'like', 'emoji react', 'post composer',
                 'write a post', 'post to the eclipse', 'home page', 'my feed'],
      summary: 'The main social timeline of Shadow Nexus Social.',
      description: 'The Eclipse Feed is the main social timeline. Every post — text, images, and videos — from people you follow shows up here in real time. You can create your own posts, react with emoji, leave comments, repost content you love, and browse Stories at the top of the page. The Feed also shows who is currently live.',
      how: 'The Eclipse Feed is the default landing page after sign-in. Also reachable from any navigation menu via the Home icon. To post: use the composer at the top of the feed, type or add media, then tap "Post to the Eclipse". Stories appear as bubbles above the feed.',
      navigation: 'feed',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['uploads', 'notifications', 'profile'],
      troubleshooting: [
        { symptom: 'Feed not loading', resolution: 'Check your internet connection. Pull down to refresh. If it continues, reload the page.' },
        { symptom: 'Posts not showing', resolution: 'You may not be following anyone yet. Visit profiles and tap Follow, then return to the Feed.' },
        { symptom: 'Cannot create a post', resolution: 'Make sure you are signed in. The post composer is at the top of the Eclipse Feed — tap inside it to start typing.' },
        { symptom: 'Stories not loading', resolution: 'Check your internet connection and reload the Feed. Stories are real-time and require an active connection.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       SEARCH
    ════════════════════════════════════════════════════════════ */
    {
      id: 'search',
      category: CAT.SEARCH,
      title: 'Search',
      priority: 12,
      keywords: ['search', 'find', 'find user', 'find people', 'look up', 'look for',
                 'find someone', 'search users', 'user search', 'find a person',
                 'search for someone', 'discover people', 'find friends', 'lookup'],
      summary: 'Find any user on Shadow Nexus Social by name or handle.',
      description: 'The Search page lets you find any user by their display name or handle. Type a name into the search bar and press Search to see matching profiles. From the results you can view profiles, follow users, or send them a message. Your own visibility in search is controlled in Settings → Privacy.',
      how: 'Open Search from the sidebar (magnifying glass icon). Type a display name or handle and tap Search. Tap any result to view that profile.',
      navigation: 'search',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['friends', 'privacy'],
      troubleshooting: [
        { symptom: 'Cannot find a user', resolution: 'Check the spelling. If the user has restricted their search visibility in Settings → Privacy, they may not appear in results.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       FRIENDS
    ════════════════════════════════════════════════════════════ */
    {
      id: 'friends',
      category: CAT.FRIENDS,
      title: 'Nexus Family & Friends',
      priority: 13,
      keywords: ['friends', 'family', 'friend request', 'family request', 'connections',
                 'follow', 'following', 'followers', 'nexus family', 'friends list',
                 'family list', 'add friend', 'add family', 'pending requests',
                 'accept friend', 'decline friend', 'unfriend', 'following list',
                 'mutual friends', 'friend tab', 'friends page', 'family tab'],
      summary: 'Manage your friend and family connections on Shadow Nexus Social.',
      description: 'The Nexus Family & Friends page manages your connections. It has three tabs: Friends (mutual connections), Requests (pending friend requests you received), and Family (members you added to your inner circle with the Heart Family option). You can accept or decline requests from here.',
      how: 'Open Friends & Family from the butterfly icon in the sidebar. Use the tabs to switch between Friends, Requests, and Family. To accept a friend request tap Accept. To send a friend request, visit someone\'s profile and tap Add Friend.',
      navigation: 'friends',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['inbox', 'search', 'privacy'],
      troubleshooting: [
        { symptom: 'Friend requests not arriving', resolution: 'Check Settings → Privacy → Friend requests to ensure "Everyone" is selected. If set to "Nobody", no one can send you requests.' },
        { symptom: 'Cannot see my friends list', resolution: 'Open the Friends & Family page and tap the Friends tab. If empty, you may not have any mutual friends yet.' },
        { symptom: 'Add Friend button not visible', resolution: 'Make sure you are signed in. The Add Friend button appears on another user\'s profile page when you visit it.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       INBOX
    ════════════════════════════════════════════════════════════ */
    {
      id: 'inbox',
      category: CAT.INBOX,
      title: 'Inbox',
      priority: 14,
      keywords: ['inbox', 'message', 'messages', 'direct message', 'dm', 'chat',
                 'conversations', 'unread messages', 'message list', 'conversation list',
                 'send message', 'new message', 'chat with someone', 'private message',
                 'message someone', 'dm someone', 'write a message', 'open inbox',
                 'my messages', 'message a friend', 'conversation'],
      summary: 'All your direct message conversations.',
      description: 'The Inbox shows all your direct message conversations. Each row shows the other person\'s name, online status, a preview of the last message, and an unread count badge. Tap any conversation to open the chat overlay.',
      how: 'Open the Inbox from the chat bubble icon in the sidebar. To start a new conversation, visit someone\'s profile and tap Message. Conversations are sorted newest first.',
      navigation: 'inbox',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['notifications', 'friends'],
      troubleshooting: [
        { symptom: 'Messages not sending', resolution: 'Check your internet connection. Also confirm the recipient has not restricted messages to "Friends only" or "Nobody" in their Settings.' },
        { symptom: 'Messages not loading', resolution: 'Close and reopen the Inbox. If the issue persists, reload the page and sign back in.' },
        { symptom: 'Cannot find the inbox', resolution: 'Open the Inbox from the chat bubble icon in the sidebar navigation on the left.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       NOTIFICATIONS
    ════════════════════════════════════════════════════════════ */
    {
      id: 'notifications',
      category: CAT.NOTIFICATIONS,
      title: 'Notification Center',
      priority: 13,
      keywords: ['notifications', 'notification', 'notif', 'alerts', 'bell', 'mention',
                 'like notification', 'follow notification', 'push notification',
                 'unread', 'notification center', 'mark all read', 'clear notifications',
                 'where are my notifications', 'how to see notifications', 'badge',
                 'notification badge', 'push alerts', 'enable push', 'allow notifications',
                 'turn on notifications', 'notification settings'],
      summary: 'All your alerts in one place — messages, likes, follows, and system announcements.',
      description: 'The Notification Center collects every alert. Four filter tabs: Messages (direct messages), Likes & Comments (activity on your posts), Followers (new follows and friend requests), and System (platform announcements). You can mark all notifications as read or clear them all with the buttons at the top.',
      how: 'Open the Notification Center from the bell icon in the sidebar. The red badge shows unread notification count. Push notification preferences are in Settings → Notification Preferences.',
      navigation: 'notifications',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['settings', 'inbox'],
      troubleshooting: [
        { symptom: 'Not receiving push notifications', resolution: 'Go to Settings → Notification Preferences and tap "Enable Push". Your browser will ask for permission — allow it.' },
        { symptom: 'Badge count not clearing', resolution: 'Open the Notification Center and tap "Mark All Read" at the top.' },
        { symptom: 'Notifications not updating', resolution: 'Try reloading the page. On mobile, ensure your browser or PWA is not running in a background-restricted mode that blocks real-time updates.' },
        { symptom: 'Push notifications not working on mobile', resolution: 'On Android, check that Chrome notifications are allowed for this site in Android Settings → Apps → Chrome → Notifications. On iPhone, push notifications require the site to be added to the Home Screen as a PWA.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       RADIO
    ════════════════════════════════════════════════════════════ */
    {
      id: 'radio',
      category: CAT.RADIO,
      title: 'Shadow Nexus Radio',
      priority: 16,
      keywords: ['radio', 'shadow nexus radio', 'music', 'stream', 'listen', 'station',
                 'now playing', 'track', 'song', 'listening now', 'radio broadcast',
                 'where is radio', 'how do i open radio', 'open radio', 'tune in',
                 'play radio', 'radio not playing', 'radio silent', '24 hour radio',
                 '24-hour station', 'radio page', 'audio not playing', 'radio audio'],
      summary: '24-hour community radio station with live music, chat, and song requests.',
      description: 'Shadow Nexus Radio is a 24-hour community music station that streams continuously. You can see what is currently on air, listen to live music, read and post comments in the Radio chat, and submit song requests to the DJ. The station runs a scheduled programme of music and hosted shows.',
      how: 'Open Radio from the radio icon in the sidebar or Shadow Core navigation. The player starts automatically. Use the play/pause button if the stream pauses. The Now Playing display shows the current track. Type in the comments section and tap Send to join the conversation.',
      navigation: 'radio',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['radioComments', 'radioRequests', 'listeningNow', 'dj'],
      troubleshooting: [
        { symptom: 'Radio not playing', resolution: 'Check your internet connection. On mobile, make sure the device is not on silent and browser audio is permitted. Tap the play button to start audio.' },
        { symptom: 'Radio not playing on mobile', resolution: 'Mobile browsers require a user tap before audio starts. Tap the play button once on the Radio player. If it still does not start, check that your device is not in Do Not Disturb mode.' },
        { symptom: 'Radio not playing on Android', resolution: 'Tap the play button directly on the Radio player. If the stream still does not start, check Do Not Disturb is off. Try reloading the Radio page.' },
        { symptom: 'Radio not playing on iPhone', resolution: 'On iPhone, make sure your ringer/mute switch is not in silent position. Tap the play button on the player. If still silent, try in Safari and check Settings → Safari → website media is allowed.' },
        { symptom: 'Autoplay blocked', resolution: 'Some browsers block audio autoplay. Tap the play button on the Radio player once — this grants the browser permission to play audio for this site.' },
        { symptom: 'Radio buffering or cutting out', resolution: 'Your internet connection may be slow. Switch to stronger Wi-Fi or a better signal area, then try again.' },
        { symptom: 'Cannot hear Radio', resolution: 'Check that your device volume is turned up. On mobile, ensure your physical mute switch is not on silent.' }
      ]
    },

    {
      id: 'radioComments',
      category: CAT.RADIO,
      title: 'Radio Comments',
      priority: 10,
      keywords: ['radio comments', 'radio chat', 'comment on radio', 'radio message',
                 'live chat radio', 'talk on radio', 'radio conversation', 'on-air chat',
                 'post radio comment', 'radio comment section'],
      summary: 'Live chat alongside the Radio stream.',
      description: 'Radio Comments is the live chat that appears alongside the Shadow Nexus Radio stream. Read what other listeners are saying and post your own messages while the music plays. You must be signed in to comment.',
      how: 'Open Radio from the sidebar. The comments section is below the player on the Radio page. Type your message and tap Send.',
      navigation: 'radio',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['radio', 'radioRequests'],
      troubleshooting: [
        { symptom: 'Radio comments not loading', resolution: 'Check your internet connection and reload the Radio page.' },
        { symptom: 'Cannot post a radio comment', resolution: 'You must be signed in to leave a comment. If you are signed in and it still fails, check your internet connection.' }
      ]
    },

    {
      id: 'radioRequests',
      category: CAT.RADIO,
      title: 'Song Requests',
      priority: 11,
      keywords: ['song request', 'request a song', 'request song', 'radio request',
                 'request music', 'how do i request', 'submit request', 'ask dj to play',
                 'dedicate song', 'song dedication', 'request a track'],
      summary: 'Submit a song request to the Shadow Nexus Radio DJ.',
      description: 'The Song Request feature lets you submit a song to the DJ during a Radio broadcast. Requests are visible to the DJ and may be played during the stream.',
      how: 'Open Radio from the sidebar. Scroll down to find the Song Requests section on the Radio page. Enter the song name and artist, then tap Submit. You must be signed in to submit a request.',
      navigation: 'radio',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['radio', 'dj'],
      troubleshooting: [
        { symptom: 'Song request section not visible', resolution: 'Song requests may only appear when a broadcast is active or a DJ is on air. Check back when the station is live with a DJ.' }
      ]
    },

    {
      id: 'listeningNow',
      category: CAT.RADIO,
      title: 'Listening Now',
      priority: 8,
      keywords: ['listening now', 'who is listening', 'listeners', 'radio presence',
                 'who is online radio', 'see who is listening', 'radio listeners'],
      summary: 'See who is currently listening to Shadow Nexus Radio.',
      description: 'Listening Now shows which members are currently tuned in to Shadow Nexus Radio in real time.',
      how: 'Open Radio from the sidebar. The Listening Now presence display appears on the Radio page alongside the player.',
      navigation: 'radio',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['radio'],
      troubleshooting: []
    },

    /* ════════════════════════════════════════════════════════════
       RADIO STUDIO / DJ
    ════════════════════════════════════════════════════════════ */
    {
      id: 'radioStudio',
      category: CAT.RADIO_STUDIO,
      title: 'Radio Studio',
      priority: 12,
      keywords: ['radio studio', 'studio', 'manage broadcast', 'schedule', 'programming',
                 'upload music', 'broadcast schedule', 'founder radio', 'manage radio',
                 'radio management', 'show scheduling', 'radio studio access'],
      summary: 'Radio Studio is the management interface for Shadow Nexus Radio — authorised users only.',
      description: 'Radio Studio is the backstage management area for Shadow Nexus Radio. Authorised users can manage the broadcast schedule, programming, and station settings. It is not visible to regular members.',
      how: 'Radio Studio is accessible from the Radio page for authorised accounts. It is not available to regular members.',
      navigation: 'radio',
      founderOnly: false,
      minRole: 'member',
      audience: ['founder'],
      related: ['radio', 'dj'],
      troubleshooting: [
        { symptom: 'Radio Studio not visible', resolution: 'Radio Studio requires authorisation. If you believe you should have access, contact the Founder.' }
      ]
    },

    {
      id: 'dj',
      category: CAT.DJ,
      title: 'DJ Mode',
      priority: 13,
      keywords: ['dj', 'dj mode', 'disk jockey', 'mixing', 'go live radio',
                 'what is dj mode', 'become dj', 'dj controls', 'dj panel',
                 'dj access', 'spin tracks', 'dj broadcast', 'dj on radio',
                 'how to become a dj', 'dj controls panel'],
      summary: 'DJ Mode gives authorised DJs live broadcast controls during Radio.',
      description: 'DJ Mode is a feature within Shadow Nexus Radio that provides authorised DJs with live broadcast controls. DJs can manage the music stream, interact with listeners, and control what plays on the station.',
      how: 'DJ Mode is accessible from the Radio page if your account has been authorised as a DJ by the Founder. The DJ controls panel appears automatically for qualified accounts.',
      navigation: 'radio',
      founderOnly: false,
      minRole: 'member',
      audience: ['founder'],
      related: ['radio', 'radioStudio'],
      troubleshooting: [
        { symptom: 'DJ controls not visible', resolution: 'DJ Mode requires authorisation from the Founder. If you believe you should have DJ access, contact the Founder.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       LIVE
    ════════════════════════════════════════════════════════════ */
    {
      id: 'live',
      category: CAT.LIVE,
      title: 'Shadow Nexus Live',
      priority: 18,
      keywords: ['live', 'live stream', 'go live', 'live video', 'broadcast',
                 'live viewer', 'live now', 'watch live', 'stream live',
                 'where is live', 'how do i go live', 'live hub', 'start stream',
                 'start live', 'end live', 'stop streaming', 'go live button',
                 'live camera', 'camera permission', 'microphone permission',
                 'mic permission', 'live streams', 'active streams', 'live page',
                 'viewers', 'live viewers', 'who is live', 'watching live',
                 'live not working', 'live failed', 'retry live',
                 'camera', 'camera not working', 'camera wont work', 'camera blocked',
                 'camera not starting', 'my camera', 'microphone', 'mic not working',
                 'microphone not working', 'mic blocked', 'my microphone',
                 'press go live', 'nothing happens go live', 'go live nothing'],
      summary: 'Live video streaming — watch community streams or broadcast yourself.',
      description: 'Shadow Nexus Live is the live video streaming feature. From the Live Hub you can see all currently active streams and tap any to watch. To go live yourself, tap the Go Live / Start Stream button. Live requires camera and microphone permission from your browser. Once live, viewers can join in real time. A LIVE NOW badge appears on your profile while you are streaming.',
      how: '1) Open Live from the red circle icon in the sidebar. 2) The Live Hub loads with any active streams listed. 3) To watch: tap any stream card. 4) To go live: tap the Start Stream / Go Live button. 5) Your browser will ask for camera and microphone permission — tap Allow. 6) Once permissions are granted your stream begins. 7) To end your stream: tap the End Stream / Stop button.',
      navigation: 'live',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['cohost', 'liveViewer', 'liveTroubleshooting'],
      troubleshooting: [
        { symptom: 'Live won\'t open', resolution: 'Try reloading the page. If Live shows "temporarily unavailable", tap the RETRY LIVE button that appears. If the issue continues, check your internet connection.' },
        { symptom: 'Camera blocked', resolution: 'Your browser has blocked camera access. Open your browser\'s site settings for this page and change Camera to Allow. On Android: tap the lock icon in the address bar → Permissions → Camera → Allow.' },
        { symptom: 'Microphone blocked', resolution: 'Your browser has blocked microphone access. Open site settings and set Microphone to Allow. On iPhone: go to Settings → Safari → allow microphone for this site.' },
        { symptom: 'Camera not working in Live', resolution: 'Check that no other app is using your camera at the same time. Close other video apps, reload, and try again. On mobile, ensure the browser has camera permission in your device settings.' },
        { symptom: 'Microphone not working in Live', resolution: 'Check that your microphone is not muted at the hardware level. On mobile, make sure the browser has microphone permission in your device\'s app settings.' },
        { symptom: 'Live stream buffering or freezing', resolution: 'Live streaming needs a stable connection. Switch to stronger Wi-Fi. If you are the broadcaster, a faster upload speed will help viewers.' },
        { symptom: 'Cannot see Live streams', resolution: 'There may be no active streams right now. The Live Hub only shows streams while members are currently broadcasting. Check back later.' },
        { symptom: 'Live failed to initialize', resolution: 'Try reloading the page. Clear your browser cache if the problem persists. On Android PWA, clearing the app cache can resolve this.' },
        { symptom: 'Live not working on Android', resolution: 'Pull down to reload. If Live still fails, clear the PWA or browser cache in Android Settings and reopen the app. Make sure the browser has camera and microphone permissions in Android app settings.' },
        { symptom: 'Live not working on iPhone', resolution: 'Use Safari on iPhone. Go to Settings → Safari → Camera and Microphone → allow for this site. Reload after granting permission.' }
      ]
    },

    {
      id: 'liveViewer',
      category: CAT.LIVE,
      title: 'Watching Live Streams',
      priority: 12,
      keywords: ['watch live', 'live viewer', 'join live', 'live stream viewer',
                 'view a stream', 'watch someone live', 'see who is live',
                 'live hub', 'active streams', 'browse live streams'],
      summary: 'Watch community live streams from the Live Hub.',
      description: 'The Live Hub shows all currently active streams. Tap any stream card to join as a viewer and watch in real time. You do not need camera or microphone to watch — only to broadcast.',
      how: '1) Open Live from the sidebar. 2) The Live Hub lists all active streams. 3) Tap any stream card to open it and start watching. 4) Tap the back button or close to return to the Live Hub.',
      navigation: 'live',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['live', 'cohost'],
      troubleshooting: [
        { symptom: 'Cannot find any live streams', resolution: 'No members may be broadcasting right now. The Live Hub only shows streams that are currently active. Try again later.' },
        { symptom: 'Live stream not loading for viewer', resolution: 'Check your internet connection. Reload the Live page. If a specific stream still does not load, the broadcaster may have ended their stream.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       COHOST
    ════════════════════════════════════════════════════════════ */
    {
      id: 'cohost',
      category: CAT.COHOST,
      title: 'Cohost (Live)',
      priority: 14,
      keywords: ['cohost', 'co-host', 'co host', 'invite cohost', 'costream',
                 'two people live', 'join someone live', 'guest on live',
                 'live collaboration', 'cohost mode', 'cohost invite',
                 'accept cohost', 'decline cohost', 'cohost request',
                 'cohost box', 'remove cohost', 'leave cohost',
                 'how do i invite a cohost', 'how to cohost'],
      summary: 'Cohost lets a second person join an active Live stream as a video participant.',
      description: 'Cohost mode allows a second person to join an active Shadow Nexus Live stream. The original streamer can invite a Cohost, who then appears in the stream alongside them. The Cohost needs camera and microphone permission. The host can remove a cohost at any time. A cohost can also choose to leave.',
      how: 'To invite a Cohost: start your Live stream, then use the Cohost invite option within the live controls. The invited person will receive a request notification. They tap Accept to join. To remove a cohost: use the remove option in the live controls. To leave as cohost: tap the leave cohost button in the live overlay.',
      navigation: 'live',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['live'],
      troubleshooting: [
        { symptom: 'Cohost invite not working', resolution: 'Both you and the cohost need stable internet connections. The cohost must have camera and microphone permissions enabled in their browser.' },
        { symptom: 'Cohost video not showing', resolution: 'The cohost should check that their camera is enabled and not blocked by their browser. Both parties should reload and retry if the issue persists.' },
        { symptom: 'Cannot accept cohost request', resolution: 'Make sure you are signed in and have a stable internet connection. Grant camera and microphone permission when prompted by your browser.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       TV
    ════════════════════════════════════════════════════════════ */
    {
      id: 'tv',
      category: CAT.TV,
      title: '24-Hour TV / Shadow Nexus TV',
      priority: 15,
      keywords: ['tv', 'television', 'nexus tv', 'shadow nexus tv', '24 hour tv',
                 '24-hour tv', 'watch tv', 'channel', 'tv channel', 'where is tv',
                 'how do i open tv', 'tv network', 'now playing tv', 'tv guide',
                 'what is on', 'tv schedule', 'tv not playing', 'tv not loading',
                 'tv buffering', 'watch channel', 'tv program', 'tv show',
                 'tv page', 'open tv', 'tv player'],
      summary: '24-hour TV network with scheduled and live content across channels.',
      description: 'Shadow Nexus TV is the platform\'s 24-hour television experience. The TV network plays scheduled and live content continuously. You can see what is Now Playing, browse available channels, and view the TV Guide for the schedule. TV is available to all users including guests.',
      how: '1) Open TV from the TV icon in the sidebar (labelled 24-Hour TV). 2) The Watch tab opens with current content playing. 3) Use the channel navigation to switch channels. 4) The TV Guide shows what is on now and what is coming up. 5) TV content follows the schedule automatically.',
      navigation: 'tv',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['tvStudio', 'live'],
      troubleshooting: [
        { symptom: 'TV not playing', resolution: 'Check your internet connection. TV loads its engine on first visit — wait a moment. If it still does not play, tap the screen or the play button.' },
        { symptom: 'TV not loading', resolution: 'TV loads lazily on first visit. If it does not load after 10 seconds, check your internet connection and refresh the page.' },
        { symptom: 'TV buffering', resolution: 'Your internet connection may be too slow. Switch to a faster connection and reload the TV page.' },
        { symptom: 'TV not playing on mobile', resolution: 'Tap directly on the TV player to start playback. Mobile browsers require a user gesture before video plays.' },
        { symptom: 'TV not playing on Android', resolution: 'Tap the TV player screen once to trigger playback. If video still does not start, reload the TV page and try again.' },
        { symptom: 'TV guide not showing', resolution: 'The TV Guide may not load on an unstable connection. Reload the TV page to refresh the guide.' },
        { symptom: 'What is the difference between Live and TV', resolution: 'Live is real-time user-to-viewer streaming — members broadcast themselves live. TV is Shadow Nexus\'s own 24-hour television network running scheduled content. They are separate systems.' }
      ]
    },

    {
      id: 'tvStudio',
      category: CAT.TV_STUDIO,
      title: 'TV Studio',
      priority: 10,
      keywords: ['tv studio', 'tv management', 'manage tv', 'broadcast tv',
                 'tv scheduling', 'authorised tv', 'create tv content', 'tv creator'],
      summary: 'TV Studio is the management area for Shadow Nexus TV — authorised creators only.',
      description: 'TV Studio is the backstage management area for Shadow Nexus TV. Authorised creators can manage scheduling, upload content, and manage their TV channel from here. It is not available to regular members.',
      how: 'TV Studio is accessible from within the TV section for authorised accounts.',
      navigation: 'tv',
      founderOnly: false,
      minRole: 'member',
      audience: ['founder'],
      related: ['tv'],
      troubleshooting: [
        { symptom: 'TV Studio not visible', resolution: 'TV Studio requires authorisation. If you believe you should have access, contact the Founder.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       UPLOADS
    ════════════════════════════════════════════════════════════ */
    {
      id: 'uploads',
      category: CAT.UPLOADS,
      title: 'File Uploads',
      priority: 13,
      keywords: ['upload', 'uploads', 'upload photo', 'upload video', 'upload image',
                 'upload file', 'post image', 'post video', 'media upload',
                 'upload failed', 'upload not working', 'photo not uploading',
                 'video not uploading', 'upload error', 'file too large',
                 'upload a photo', 'upload a video', 'add photo', 'add image',
                 'share photo', 'share video', 'upload stuck'],
      summary: 'Upload photos and videos to your profile and posts on Shadow Nexus Social.',
      description: 'Shadow Nexus Social supports uploading photos and videos for profile pictures, cover photos, posts, and direct messages. Images are limited to 10 MB. Videos can be much larger. Files are stored securely on the platform.',
      how: 'To upload media: tap the image or video icon in the post composer, or in the profile editor when changing your avatar or cover photo. Select the file from your device. Wait for the upload to complete before saving.',
      navigation: 'profile',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['feed', 'profile'],
      troubleshooting: [
        { symptom: 'Upload failed', resolution: '1) Check your internet connection. 2) Make sure the file is an image (JPG, PNG, GIF) or video (MP4). 3) Try a smaller file — very large files may time out. 4) Reload and try again.' },
        { symptom: 'Photo not uploading', resolution: 'Check your internet connection. On mobile, make sure the browser has permission to access your photos in device settings.' },
        { symptom: 'Video not uploading', resolution: 'Video files can be large. Try a shorter clip or compress the video first. Make sure your internet connection stays stable during the upload.' },
        { symptom: 'Upload stuck at 0%', resolution: 'Your connection may have dropped. Check your internet and try again. On mobile, avoid switching apps during an upload.' },
        { symptom: 'File too large', resolution: 'Images are limited to 10 MB. If uploading a video, try compressing it first. For very large videos, use a Wi-Fi connection.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       SETTINGS
    ════════════════════════════════════════════════════════════ */
    {
      id: 'settings',
      category: CAT.SETTINGS,
      title: 'Settings',
      priority: 14,
      keywords: ['settings', 'setting', 'account settings', 'where are settings',
                 'how to open settings', 'open settings', 'delete account',
                 'danger zone', 'privacy settings', 'push notifications',
                 'notification preferences', 'game invites', 'wall settings',
                 'tag settings', 'friend request privacy', 'family request privacy',
                 'performance mode', 'change performance', 'quality mode'],
      summary: 'Control your account, privacy, notifications, and performance across Shadow Nexus Social.',
      description: 'Settings gives you full control over your account. Privacy section — choose who can see your profile, send you friend requests, message you, find you in search, write on your wall, send family requests, view your friends list, view your family list, and tag you in posts. Notification Preferences — toggle push alerts per type. Performance Mode — choose between Auto, ULTRA, HIGH, BALANCED, LITE, and MINIMAL. Danger Zone — permanently delete your account.',
      how: 'Open Settings from the gear icon in the sidebar. Scroll to find the section you need. Your changes are saved automatically.',
      navigation: 'settings',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['privacy', 'performance', 'notifications', 'account'],
      troubleshooting: [
        { symptom: 'Cannot find performance mode setting', resolution: 'Open Settings and scroll down to the Performance section. You will see quality mode options including Auto, BALANCED, LITE, and others.' },
        { symptom: 'Privacy changes not saving', resolution: 'Make sure you are signed in with a stable internet connection, then tap Save.' },
        { symptom: 'Cannot find Settings', resolution: 'Open Settings from the gear icon in the sidebar navigation.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       PRIVACY
    ════════════════════════════════════════════════════════════ */
    {
      id: 'privacy',
      category: CAT.PRIVACY,
      title: 'Privacy Settings',
      priority: 13,
      keywords: ['privacy', 'who can see', 'who can message me', 'who can find me',
                 'search visibility', 'profile visibility', 'private profile',
                 'public profile', 'friend request privacy', 'hide from search',
                 'block messages', 'wall privacy', 'tag privacy', 'family privacy',
                 'privacy settings', 'control who sees', 'privacy controls'],
      summary: 'Control who can see your profile, message you, and find you on Shadow Nexus Social.',
      description: 'Privacy Settings in Settings let you control: who can see your profile (Everyone, Friends, Nobody), who can message you (Everyone, Friends, Nobody), who can send friend requests (Everyone, Nobody), who can find you in Search (Everyone, Friends, Nobody), who can write on your wall, who can tag you in posts, who can view your friends list, and who can view your family list.',
      how: 'Open Settings from the sidebar, then scroll to the Privacy section. Adjust each setting to your preference. Tap Save to apply changes.',
      navigation: 'settings',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['settings', 'safety', 'search'],
      troubleshooting: [
        { symptom: 'People I do not know are messaging me', resolution: 'Open Settings → Privacy → Who can message me → set to Friends or Nobody.' },
        { symptom: 'I am not appearing in search', resolution: 'Check Settings → Privacy → Search visibility — if set to "Nobody" you will not appear in search results.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       PERFORMANCE MODE
    ════════════════════════════════════════════════════════════ */
    {
      id: 'performance',
      category: CAT.PERFORMANCE,
      title: 'Performance Mode',
      priority: 13,
      keywords: ['performance', 'performance mode', 'quality mode', 'lite mode',
                 'balanced mode', 'full mode', 'minimal', 'change performance',
                 'how do i change performance', 'graphics', 'animation', 'slow',
                 'laggy', 'battery saver', 'reduce effects', 'snxperf',
                 'adaptive performance', 'auto mode', 'ultra mode', 'high mode',
                 'site is slow', 'app is slow', 'animations', 'effects', 'fps',
                 'too slow', 'site lagging', 'reduce animations'],
      summary: 'Adaptive quality system that controls visual effects and performance across the site.',
      description: 'Shadow Nexus Social uses an adaptive performance system with six quality levels: AUTO (system picks the best level automatically), ULTRA (maximum effects), HIGH, BALANCED (default), LITE (reduced effects, better battery), and MINIMAL (bare-bones performance). The system adjusts automatically based on your device and connection. You can override it manually in Settings.',
      how: 'Open Settings from the sidebar and scroll to the Performance section. Select your preferred mode. AUTO is recommended for most devices. Choose LITE or MINIMAL if the site feels slow or to save battery. Your choice is remembered between sessions.',
      navigation: 'settings',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['settings'],
      troubleshooting: [
        { symptom: 'Site is slow or laggy', resolution: 'Open Settings and switch Performance Mode to LITE or MINIMAL. This reduces animations and visual effects significantly.' },
        { symptom: 'Mode keeps changing on its own', resolution: 'If Performance Mode is set to AUTO, the system adjusts it based on your current frame rate and device load. To keep it fixed, select a specific level like BALANCED.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       COMMUNITY / ROOMS / ARCADE / RULES
    ════════════════════════════════════════════════════════════ */
    {
      id: 'stormrooms',
      category: CAT.ROOMS,
      title: 'Storm Rooms',
      priority: 12,
      keywords: ['storm rooms', 'storm room', 'anonymous chat', 'live chat',
                 'public lobby', 'private room', 'room code', 'ephemeral chat',
                 'shadow room', 'anonymous', 'no real name', 'temporary chat',
                 'storm room code', 'join storm room', 'create storm room',
                 'private storm room', 'enter public lobby'],
      summary: 'Live anonymous chat rooms where messages vanish after 10 minutes.',
      description: 'Storm Rooms are live anonymous chat rooms. Choose a shadow display name, then join the Public Lobby (open to everyone, no code needed) or a Private Room using a room code. Private rooms can be created — you get a code to share with friends. Messages vanish after 10 minutes. No real names. No judgment.',
      how: '1) Open Storm Rooms from the sidebar. 2) Enter a shadow display name. 3) Tap "Enter Public Lobby" for open chat, or enter a room code to join a private room. To create a private room tap "Create New Private Room" — you will receive a code to share.',
      navigation: 'stormrooms',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['supportrooms', 'community'],
      troubleshooting: [
        { symptom: 'Cannot join a private room', resolution: 'Make sure you have the correct room code. Codes are case-sensitive. Ask the room creator to share the code again.' },
        { symptom: 'Messages disappearing', resolution: 'This is by design — Storm Room messages vanish after 10 minutes for privacy. This is a core feature of Storm Rooms.' }
      ]
    },

    {
      id: 'supportrooms',
      category: CAT.ROOMS,
      title: 'Support Rooms',
      priority: 13,
      keywords: ['support rooms', 'support room', 'peer support', 'night owls',
                 'morning light', 'venting lounge', 'healing circle', 'grief garden',
                 'self-love club', 'someone to talk to', 'need support',
                 'mental health rooms', 'safe space', 'anxiety room',
                 'depression room', 'grief room', 'trauma room', 'vent',
                 'venting', 'emotional support', 'anonymous support'],
      summary: 'Safe, calm, anonymous peer-support spaces for real human conversations.',
      description: 'Support Rooms are calm, safe, anonymously moderated spaces to share what you are going through and receive genuine peer support. Six dedicated rooms: Night Owls (anxiety), Morning Light (depression), Venting Lounge (general venting), Healing Circle (trauma and recovery), Grief Garden (loss and grief), and Self-Love Club (body image and esteem). Crisis resources are always visible in every room.',
      how: '1) Open Support Rooms from the sidebar. 2) Choose a gentle display name. 3) Pick a room that fits what you are carrying and tap to join. Crisis line: call or text 988 (US), 116 123 (UK), 13 11 14 (Australia).',
      navigation: 'supportrooms',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['stormrooms', 'rules'],
      troubleshooting: [
        { symptom: 'Cannot connect to a Support Room', resolution: 'Check your internet connection. Support Rooms require an active connection to send and receive messages.' }
      ]
    },

    {
      id: 'community',
      category: CAT.COMMUNITY,
      title: 'Community Hub',
      priority: 11,
      keywords: ['community hub', 'community', 'quote of the day', 'daily challenge', 'xp',
                 'kindness badge', 'community goal', 'community pulse', 'anonymous board',
                 'anonymous support board', 'kindness', 'badge', 'challenge',
                 'community event', 'daily xp', 'complete challenge', 'kindness badges',
                 'community goals'],
      summary: 'A positive shared space with challenges, badges, quotes, and community features.',
      description: 'The Community Hub is a positive shared space. Sections: Quote of the Day, Daily Challenge (+50 XP, resets daily), Community Goals, Kindness Badges, Community Pulse, and Anonymous Support Board.',
      how: 'Open Community Hub from the heart icon in the sidebar. Tap a section to interact. To claim the Daily Challenge reward tap "Complete Challenge".',
      navigation: 'community',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['stormrooms', 'supportrooms'],
      troubleshooting: []
    },

    {
      id: 'rules',
      category: CAT.RULES,
      title: 'Community Rules',
      priority: 11,
      keywords: ['community rules', 'rules', 'guidelines', 'what is allowed', 'not allowed',
                 'report', 'appeal', 'moderation', 'banned', 'warning', 'hate speech',
                 'bullying', 'harassment', 'spam rules', 'safety', 'reported',
                 'community guidelines', 'platform rules', 'what are the rules'],
      summary: 'The six community rules and the platform safety flow.',
      description: 'Six prohibited behaviours: Bullying, Harassment, Threats, Hate Speech, Spam, and Repeated Disruptive Behaviour. These apply to posts, stories, messages, and live streams. Safety flow: Rule broken → AI detects → Warning issued → Continued issue → Action taken → User can appeal → Founder reviews → Accept or deny.',
      how: 'Open Community Rules from the scroll icon in the sidebar. To appeal a moderation action, go to the Reports section and explain what happened — the Founder will review your case.',
      navigation: 'rules',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['safety', 'community'],
      troubleshooting: [
        { symptom: 'I received a warning I do not understand', resolution: 'Open Community Rules to review the guidelines. If you believe the warning was incorrect, submit an appeal through the Reports section.' }
      ]
    },

    {
      id: 'safety',
      category: CAT.SAFETY,
      title: 'Safety & Reporting',
      priority: 12,
      keywords: ['safety', 'report', 'report user', 'report post', 'block user',
                 'block', 'harassment', 'abuse', 'unwanted contact', 'feel unsafe',
                 'report content', 'report a problem', 'feel threatened',
                 'protect myself', 'safety features', 'reporting system'],
      summary: 'How to report content and protect yourself on Shadow Nexus Social.',
      description: 'Shadow Nexus Social has a safety and reporting system. You can report posts, users, or messages that violate the Community Rules. After a report, the Founder reviews the case. Repeated or serious violations lead to warnings and account actions. You can also control who contacts you via Settings → Privacy.',
      how: 'To report a post or user: tap the three-dot menu on the post or visit the user\'s profile and tap Report. Explain the issue clearly. The Founder will review the report. For urgent safety concerns, adjust your Privacy Settings to restrict who can contact you.',
      navigation: 'rules',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['rules', 'privacy'],
      troubleshooting: []
    },

    {
      id: 'arcade',
      category: CAT.ARCADE,
      title: 'Arcade',
      priority: 11,
      keywords: ['arcade', 'mini game', 'mini games', 'games', 'game hub', 'play game',
                 'challenge friend', 'game invite', 'game challenge', 'play games',
                 'arcade games', 'open arcade', 'where is arcade', 'play a game'],
      summary: 'Shadow Nexus Social\'s built-in mini-game hub.',
      description: 'The Arcade is Shadow Nexus Social\'s built-in mini-game hub. You can play games solo or challenge friends directly from their profile.',
      how: 'Open the Arcade from the game controller icon in the sidebar. To challenge a friend: visit their profile and tap the Challenge button.',
      navigation: 'arcade',
      founderOnly: false,
      minRole: 'member',
      audience: ['member', 'founder'],
      related: ['friends', 'community'],
      troubleshooting: [
        { symptom: 'Cannot challenge a friend', resolution: 'Make sure the other user allows game challenges (Settings → Game Challenges) and that you are mutual friends.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       NAVIGATION
    ════════════════════════════════════════════════════════════ */
    {
      id: 'navigation',
      category: CAT.NAVIGATION,
      title: 'Navigation',
      priority: 14,
      keywords: ['navigate', 'navigation', 'sidebar', 'menu', 'go to', 'open',
                 'how do i get to', 'where is the', 'find the page', 'shadow core',
                 'back button', 'main menu', 'how to navigate', 'how do i navigate',
                 'get back', 'lost', 'cannot find', 'where is everything',
                 'site layout', 'menu items', 'navigation icons'],
      summary: 'How to move between sections of Shadow Nexus Social.',
      description: 'Shadow Nexus Social uses a sidebar navigation. Every major section has a dedicated icon in the sidebar. Tap an icon to navigate to that section. Main sections: Feed (home), Live, Radio, TV, Inbox, Notifications, Search, Friends, Arcade, Storm Rooms, Support Rooms, Community Hub, Settings, and Profile.',
      how: 'Look for the sidebar on the left (desktop) or tap the menu icon on mobile. Tap the icon for the section you want. You can also ask me to take you anywhere — just say "Take me to Radio" or "Open Notifications".',
      navigation: 'feed',
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['whatIsSNS'],
      troubleshooting: [
        { symptom: 'Cannot navigate between pages', resolution: 'Try reloading the page. If navigation completely stops working, clear your browser cache and reload.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       PWA / MOBILE INSTALL
    ════════════════════════════════════════════════════════════ */
    {
      id: 'pwa',
      category: CAT.PWA,
      title: 'PWA / Install as App',
      priority: 12,
      keywords: ['pwa', 'progressive web app', 'install app', 'add to home screen',
                 'home screen', 'install sns', 'app icon', 'installed app',
                 'install on phone', 'save to home screen', 'add to homescreen',
                 'pwa install', 'install shadow nexus', 'mobile app',
                 'how to install', 'install on android', 'install on iphone'],
      summary: 'Shadow Nexus Social can be installed as a Progressive Web App (PWA) on Android and iPhone.',
      description: 'Shadow Nexus Social is a Progressive Web App (PWA). Installing it adds an app icon to your home screen, enables offline caching, and makes it feel like a native app. The installed PWA looks and behaves like a standalone app without needing the browser toolbar.',
      how: 'On Android (Chrome): tap the three-dot menu in Chrome → tap "Add to Home screen" → tap Add. On iPhone (Safari): tap the Share button (box with arrow) → tap "Add to Home Screen" → tap Add. On desktop Chrome: look for the install icon (download icon) in the address bar.',
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['mobileIssues'],
      troubleshooting: [
        { symptom: 'Cannot find the install option', resolution: 'On Android: use Chrome browser → tap three-dot menu → Add to Home screen. On iPhone: use Safari → tap the Share button → Add to Home Screen. The option only appears in specific browsers.' },
        { symptom: 'PWA not updating after install', resolution: 'Open the installed app, wait for it to load, then pull down to refresh. The service worker will update in the background.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       MOBILE TROUBLESHOOTING
    ════════════════════════════════════════════════════════════ */
    {
      id: 'mobileIssues',
      category: CAT.MOBILE,
      title: 'Mobile / PWA Troubleshooting',
      priority: 13,
      keywords: ['android', 'iphone', 'mobile', 'pwa', 'app', 'installed app',
                 'android not working', 'iphone not working', 'mobile not loading',
                 'pwa cache', 'clear pwa cache', 'mobile cache', 'app cache',
                 'android sns', 'iphone sns', 'sns on android', 'sns on iphone',
                 'sns not loading android', 'sns not loading on android',
                 'what should i try', 'android issues', 'phone issues',
                 'mobile issues', 'iphone issues', 'phone not working'],
      summary: 'Steps to resolve mobile and PWA issues on Android and iPhone.',
      description: 'Shadow Nexus Social is a Progressive Web App (PWA) that works on Android and iPhone through the browser or as an installed app. Most mobile issues are caused by cached content or permission settings.',
      how: 'For Android: 1) Pull down to refresh inside the app. 2) If that fails, go to Android Settings → Apps → your browser → Clear Cache, then reopen SNS. 3) Check that the browser has camera and microphone permissions if you use Live. For iPhone: 1) Reload in Safari. 2) Go to Settings → Safari → Website Data → delete SNS data. 3) For Live: Settings → Safari → Camera and Microphone → allow for SNS.',
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['pwa', 'live', 'radio'],
      troubleshooting: [
        { symptom: 'SNS not loading correctly on Android', resolution: '1) Pull to refresh. 2) Clear browser or app cache in Android Settings → Apps → your browser → Storage → Clear Cache. 3) Reopen SNS. 4) If still broken, try opening in Chrome directly instead of as a PWA.' },
        { symptom: 'SNS not loading correctly on iPhone', resolution: '1) Reload in Safari. 2) Go to Settings → Safari → Clear History and Website Data. 3) Reopen SNS. 4) For Live or camera issues, check Settings → Safari → Camera and Microphone permissions.' },
        { symptom: 'PWA cache issue', resolution: 'Clear your browser or installed app cache. On Android: Settings → Apps → find your browser → Storage → Clear Cache. On iPhone: Settings → Safari → Advanced → Website Data, find SNS and delete it.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       GENERAL TROUBLESHOOTING
    ════════════════════════════════════════════════════════════ */
    {
      id: 'troubleshooting',
      category: CAT.TROUBLESHOOTING,
      title: 'General Troubleshooting',
      priority: 13,
      keywords: ['not working', 'broken', 'error', 'problem', 'issue', 'bug',
                 'page not loading', 'crash', 'freezing', 'stuck', 'reload',
                 'refresh', 'clear cache', 'troubleshoot', 'something wrong',
                 'sns not loading', 'app not loading', 'white screen', 'blank screen',
                 'how to fix', 'what should i do', 'general problem'],
      summary: 'General steps to resolve common issues on Shadow Nexus Social.',
      description: 'Most issues on Shadow Nexus Social can be resolved with a few basic steps. Start with the simplest check first.',
      how: '1) Check your internet connection. 2) Reload the page (pull to refresh on mobile, F5 on desktop). 3) Try signing out and signing back in. 4) Clear your browser cache. 5) Try a different browser or device. If a specific feature is not working, ask me about that feature by name.',
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['mobileIssues', 'account'],
      troubleshooting: [
        { symptom: 'Everything is broken', resolution: 'Try reloading the page. If you are offline, the app will show an offline page — reconnect to the internet and reload.' },
        { symptom: 'Something looks visually wrong', resolution: 'Try switching Performance Mode in Settings to BALANCED or LITE. Some visual glitches are related to high-quality effects on older hardware.' },
        { symptom: 'Page keeps reloading', resolution: 'This can happen with poor connectivity. Move to a stronger internet connection. If it continues, try clearing your browser cache.' }
      ]
    },

    /* ════════════════════════════════════════════════════════════
       FOUNDER DIAGNOSTICS  (founderOnly: true)
    ════════════════════════════════════════════════════════════ */
    {
      id: 'founderDiagBuild',
      category: CAT.FOUNDER_DIAG,
      title: 'Build / Version Info (Founder)',
      priority: 14,
      keywords: ['build', 'version', 'build id', 'current build', 'sns build',
                 'what build', 'build number', 'version number', 'which version',
                 'what version is sns running', 'what build is sns running',
                 'current version', 'build identifier'],
      summary: 'Current SNS build identifier and version information.',
      description: 'The current SNS build, SW version, and component versions are stored in version.json and readable from window.SNX_BUILD or exposed via diagnostic tools for Founders.',
      how: 'In the browser console (DevTools), check window.SNX_BUILD or window.SNXShadowAI.build for the current build ID. The service worker version is in sw.js. Detailed component versions are in version.json. The Knowledge Engine build is window.SNXShadowKnowledge.build.',
      navigation: null,
      founderOnly: true,
      minRole: 'founder',
      audience: ['founder'],
      related: ['founderDiagAI'],
      troubleshooting: []
    },

    {
      id: 'founderDiagAI',
      category: CAT.FOUNDER_DIAG,
      title: 'Shadow Reaper AI Diagnostics (Founder)',
      priority: 14,
      keywords: ['ai availability', 'workers ai', 'ai fallback', 'ai state',
                 'workers ai status', 'is ai working', 'ai working', 'check ai',
                 'shadow reaper status', 'ai diagnostics', 'workers ai fallback',
                 'free allocation', 'ai allocation', 'local knowledge mode',
                 'confidence threshold', 'local answer rate'],
      summary: 'Founder-level diagnostics for Shadow Reaper AI and Workers AI.',
      description: 'Shadow Reaper uses Cloudflare Workers AI (model: @cf/meta/llama-3.2-3b-instruct) via the AI binding. Fallback: if Workers AI is unavailable or the daily free allocation is exhausted, Shadow Reaper automatically enters LOCAL KNOWLEDGE MODE and answers entirely from the local brain. Stage 3A: confidence scoring gates AI usage — HIGH confidence questions are answered locally with zero Workers AI calls.',
      how: 'Check window.SNXShadowAI.getCapabilities() in the console for capability flags. Check window.SNXShadowKnowledge.getDiagnostics() for local brain counters: record count, local answer count, AI fallback count, no-match count. The AI endpoint is /shadow-ai/chat on the Worker.',
      navigation: null,
      founderOnly: true,
      minRole: 'founder',
      audience: ['founder'],
      related: ['founderDiagBuild', 'founderDiagLive'],
      troubleshooting: []
    },

    {
      id: 'founderDiagLive',
      category: CAT.FOUNDER_DIAG,
      title: 'Live System Diagnostics (Founder)',
      priority: 13,
      keywords: ['live diagnostics', 'live init', 'live initialization', 'live failing',
                 'live debug', 'check live', 'live system state', 'webrtc state',
                 'ice state', 'turn state', 'live fails to initialize',
                 'what can i check if live fails'],
      summary: 'Founder-level diagnostic hints for the Live system.',
      description: 'The Live system uses WebRTC for peer-to-peer video with a mediasoup SFU server and TURN relay. Safe diagnostic state is exposed on window._snxLiveActive (boolean). Live initialization is logged via [LIVE] 1-9 checkpoint console messages. Errors are logged as [LIVE INIT ERROR].',
      how: 'Open DevTools → Console. Look for [LIVE] checkpoint logs (1-9) to see how far Live initialized. Look for [LIVE INIT ERROR] for error detail. Check window._snxLiveActive to see if Live was successfully initialized. Check that live.js and snx-sfu.js loaded without parse errors.',
      navigation: null,
      founderOnly: true,
      minRole: 'founder',
      audience: ['founder'],
      related: ['founderDiagBuild'],
      troubleshooting: []
    },

    {
      id: 'founderDiagRadio',
      category: CAT.FOUNDER_DIAG,
      title: 'Radio System State (Founder)',
      priority: 12,
      keywords: ['radio diagnostics', 'radio state', 'radio system', 'radio debug',
                 'check radio state', 'radio active', 'radio system state'],
      summary: 'Safe Radio system state flags for Founder diagnostics.',
      description: 'Radio system state flags: window._snxRadioActive (boolean — true if radio player is active), window.snxRadioPageOpen (boolean — true if Radio page is open). These are safe, non-secret state flags.',
      how: 'In the browser console: check window._snxRadioActive and window.snxRadioPageOpen to confirm the Radio system state.',
      navigation: null,
      founderOnly: true,
      minRole: 'founder',
      audience: ['founder'],
      related: ['founderDiagBuild'],
      troubleshooting: []
    },

    {
      id: 'founderDiagTV',
      category: CAT.FOUNDER_DIAG,
      title: 'TV System State (Founder)',
      priority: 12,
      keywords: ['tv diagnostics', 'tv state', 'tv system', 'tv debug',
                 'check tv state', 'tv active', 'tv system state'],
      summary: 'Safe TV system state flags for Founder diagnostics.',
      description: 'TV system state flags: window._snxTvActive (boolean — true if the TV engine is active). The TV engine loads lazily on first visit to the TV page.',
      how: 'In the browser console: check window._snxTvActive to confirm whether the TV engine is active.',
      navigation: null,
      founderOnly: true,
      minRole: 'founder',
      audience: ['founder'],
      related: ['founderDiagBuild'],
      troubleshooting: []
    },

    {
      id: 'founderDiagSW',
      category: CAT.FOUNDER_DIAG,
      title: 'Service Worker Version (Founder)',
      priority: 12,
      keywords: ['service worker', 'sw version', 'service worker version', 'sw state',
                 'sw cache', 'service worker cache', 'cache version', 'sw update',
                 'sw diagnostics'],
      summary: 'Service Worker version and cache diagnostics for Founders.',
      description: 'The service worker version is defined in sw.js and referenced in version.json as swVersion. Current SW version: v100 (as of SNS-2026-LIVE-ANDROID-FIX-001). The SW caches same-origin assets using cache-first, and uses network-first for HTML navigation.',
      how: 'In DevTools → Application → Service Workers, check the installed service worker. In the console: navigator.serviceWorker.getRegistration().then(r => console.log(r)) to check registration state.',
      navigation: null,
      founderOnly: true,
      minRole: 'founder',
      audience: ['founder'],
      related: ['founderDiagBuild'],
      troubleshooting: []
    },

    /* ════════════════════════════════════════════════════════════
       STAGE 3B — CREATOR KNOWLEDGE
       Public, approved knowledge about Chris / Chris Legend of Shadows.
       Nothing private. No credentials. No invented facts.
    ════════════════════════════════════════════════════════════ */

    /* ── CREATOR IDENTITY ── */
    {
      id: 'creatorIdentity',
      category: CAT.CREATOR,
      title: 'Creator of Shadow Nexus Social',
      priority: 20,
      keywords: [
        'creator', 'founder', 'who created', 'who made', 'who built',
        'who owns', 'who founded', 'who is chris', 'chris', 'created shadow nexus',
        'made shadow nexus', 'built shadow nexus', 'who created shadow nexus',
        'who made shadow nexus', 'who built shadow nexus', 'who owns shadow nexus',
        'shadow nexus creator', 'shadow nexus founder', 'sns creator', 'sns founder',
        'who is legend of shadows', 'who is chris legend of shadows',
        'chris legend of shadows', 'legend of shadows', 'creator identity',
        'who created sns', 'who made this website', 'who made this site',
        'who made this app', 'who is behind shadow nexus', 'created this platform'
      ],
      summary: 'Shadow Nexus Social was created by Chris, whose public creator identity is Chris Legend of Shadows.',
      description: 'Shadow Nexus Social was created by Chris. His public creator and artist identity is Chris Legend of Shadows, also known as Legend of Shadows. Chris built this platform around his own ideas, creativity, community vision, and digital experiences. He is the Founder of Shadow Nexus Social.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorStory', 'creatorOrigin'],
      troubleshooting: []
    },

    /* ── PUBLIC BIOGRAPHY ── */
    {
      id: 'creatorBio',
      category: CAT.CREATOR,
      title: 'Chris Legend of Shadows — Public Biography',
      priority: 19,
      keywords: [
        'biography', 'bio', 'who is chris', 'about chris', 'tell me about chris',
        'chris legend of shadows', 'legend of shadows', 'creator biography',
        'chris background', 'public bio', 'creator profile', 'about the creator',
        'who is the creator', 'tell me about the creator', 'creator of sns',
        'founder biography', 'tell me about the founder', 'about the founder',
        'chris story overview', 'shadow nexus founder bio'
      ],
      summary: 'Public biography of Chris, creator of Shadow Nexus Social and artist known as Chris Legend of Shadows.',
      description: 'Chris is the creator and Founder of Shadow Nexus Social, and the artist known publicly as Chris Legend of Shadows — also referred to as Legend of Shadows. His creative journey has been shaped by difficult personal periods, mental-health struggles, and the ongoing fight to keep moving forward. He channels those experiences into music, creative projects, and this platform. His public creative themes include survival, identity, loyalty, family, and never giving up. His sister is one of the most important people in his life and a key reason he continues forward. He built Shadow Nexus Social as something original — a platform built around his own vision, not a copy of anything else.',
      how: 'Ask Shadow Reaper about specific aspects of Chris\'s public story — his music, his creative symbols, his values, or why he built Shadow Nexus Social.',
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorIdentity', 'creatorStory', 'creatorMusic', 'creatorMentalHealth', 'creatorFamily', 'creatorOrigin'],
      troubleshooting: []
    },

    /* ── CREATOR STORY ── */
    {
      id: 'creatorStory',
      category: CAT.CREATOR_STORY,
      title: 'Creator Story — Chris Legend of Shadows',
      priority: 18,
      keywords: [
        'creator story', 'chris story', 'his story', 'what has chris been through',
        'chris struggles', 'chris journey', 'legend of shadows story', 'chris background',
        'creator journey', 'chris difficult times', 'chris dark times', 'chris survival',
        'fighting internal battles', 'feeling isolated', 'personal struggles',
        'continued forward', 'chris kept going', 'chris fought', 'story behind shadow nexus',
        'story of shadow nexus', 'chris creative story', 'what shaped chris',
        'creator personal story', 'founder story', 'chris life story'
      ],
      summary: 'Chris\'s public creative story — shaped by difficult periods, survival, and turning struggle into creativity.',
      description: 'Chris has spoken publicly about how his creative work has been shaped by difficult periods in his life. He has faced personal struggles, mental-health challenges, feelings of isolation, and long internal battles. Rather than allowing those experiences to end his story, he continued forward — using creativity, music, and building as ways to survive and grow. His public story is not one of giving up. It is one of continuing through difficult moments, turning those experiences into something meaningful, and using that to help other people feel less alone. Shadow Nexus Social, his music, and the Legend of Shadows identity all come from that place.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorMentalHealth', 'creatorOrigin'],
      troubleshooting: []
    },

    /* ── WHY SHADOW NEXUS EXISTS ── */
    {
      id: 'creatorOrigin',
      category: CAT.CREATOR_STORY,
      title: 'Why Shadow Nexus Social Exists',
      priority: 17,
      keywords: [
        'why shadow nexus exists', 'why chris built', 'why did he build this',
        'what inspired shadow nexus', 'why did chris create', 'reason for shadow nexus',
        'why shadow nexus social', 'what motivated chris', 'purpose of shadow nexus',
        'why this platform exists', 'shadow nexus origin', 'shadow nexus reason',
        'why sns was created', 'inspiration for shadow nexus', 'vision for shadow nexus',
        'chris vision', 'why build shadow nexus', 'what is shadow nexus for'
      ],
      summary: 'Shadow Nexus Social was built by Chris as something original — a platform around his own creative vision, community, and digital experiences.',
      description: 'Chris built Shadow Nexus Social as something original. It is not modelled after another platform or a copy of anything that already exists. He built it around his own ideas: a creative space where music, live video, community, real conversations, and digital experiences could come together under one roof. The platform reflects his values — loyalty, creativity, supporting people, and giving people a place to belong. His own difficult experiences shaped the parts of it that are specifically about connection, mental health, and community, such as the Support Rooms.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorStory', 'creatorValues'],
      troubleshooting: []
    },

    /* ── MUSIC ── */
    {
      id: 'creatorMusic',
      category: CAT.CREATOR_MUSIC,
      title: 'Chris Legend of Shadows — Music',
      priority: 17,
      keywords: [
        'music', 'chris music', 'legend of shadows music', 'chris legend of shadows music',
        'what music does chris make', 'what kind of music', 'what type of music',
        'creator music', 'what does he create', 'chris artist', 'artist chris',
        'rap rock', 'melodic rap', 'alternative rock', 'metal rap', 'emotional rap',
        'darkness hope music', 'internal battles music', 'survival music',
        'chris songs', 'legend of shadows songs', 'music themes', 'musical style',
        'heavy choruses', 'rap verses', 'rock metal', 'chris makes music',
        'what music has he made', 'his music', 'music direction'
      ],
      summary: 'Chris creates music as Chris Legend of Shadows, exploring themes of darkness vs hope, survival, identity, and mental health.',
      description: 'Chris creates music under the name Chris Legend of Shadows. His musical direction draws from a combination of rap rock, melodic rap, alternative rock and metal, with heavy emotional choruses and rap verses. His creative themes frequently explore: darkness versus hope, internal battles, survival, loyalty, family, mental health, identity, reflection, fighting personal demons, finding purpose, and never giving up. These are the same themes that run through his other creative work and through Shadow Nexus Social itself.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorMentalHealth', 'creatorSymbols'],
      troubleshooting: []
    },

    /* ── MENTAL HEALTH ADVOCACY ── */
    {
      id: 'creatorMentalHealth',
      category: CAT.CREATOR_MENTAL,
      title: 'Mental Health Advocacy — Chris Legend of Shadows',
      priority: 17,
      keywords: [
        'mental health', 'mental health advocacy', 'chris mental health',
        'why does chris talk about mental health', 'legend of shadows mental health',
        'depression', 'anxiety', 'insomnia', 'overthinking', 'feeling trapped',
        'identity struggles', 'fighting demons', 'asking for help', 'not giving up',
        'men mental health', 'mental health awareness', 'creator mental health',
        'chris advocates mental health', 'why mental health', 'internal battles',
        'struggling mind', 'supporting people struggling', 'men who struggle',
        'mental health themes', 'music mental health', 'creative mental health'
      ],
      summary: 'Mental-health awareness is a core part of Chris\'s public creative identity, explored through his music and in Shadow Nexus Social.',
      description: 'Mental-health awareness is an important and intentional part of Chris\'s public creative identity. Through his music and in Shadow Nexus Social, he has explored themes including depression, anxiety, insomnia, overthinking, feeling trapped in your own mind, identity struggles, fighting internal demons, asking for help, not giving up, and supporting people who are struggling. A particular focus is men\'s mental health — the reality that many people suffer silently and do not ask for help. Chris has channelled his own difficult experiences into creative work specifically to help other people feel less alone. Shadow Nexus Social\'s Support Rooms are a direct reflection of that commitment.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorStory', 'creatorBio', 'supportrooms'],
      troubleshooting: []
    },

    /* ── FAMILY / SISTER ── */
    {
      id: 'creatorFamily',
      category: CAT.CREATOR_FAMILY,
      title: 'Family — His Sister',
      priority: 16,
      keywords: [
        'sister', 'his sister', 'chris sister', 'family', 'chris family',
        'why is his sister important', 'sister important', 'creator family',
        'loyalty', 'protecting people', 'family themes', 'people he loves',
        'who does chris care about', 'why family matters to chris',
        'legend of shadows family', 'family loyalty', 'family in his music',
        'important people in his life', 'reasons he keeps going', 'sister role',
        'family values creator'
      ],
      summary: 'Chris\'s sister is one of the most important people in his life and a key reason he keeps moving forward.',
      description: 'Chris has described his sister as one of the most important people in his life and an important reason he continues moving forward. Family, loyalty, and protecting the people he loves are recurring themes across his creative work — in his music, in the Legend of Shadows identity, and in Shadow Nexus Social itself. His sister\'s role in his life is a private matter, and her personal information is not shared here. What is public is the importance of that relationship to who Chris is and why he creates.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorStory', 'creatorValues'],
      troubleshooting: []
    },

    /* ── CREATOR VALUES ── */
    {
      id: 'creatorValues',
      category: CAT.CREATOR_VALUES,
      title: 'Creator Values — Chris Legend of Shadows',
      priority: 15,
      keywords: [
        'creator values', 'chris values', 'what does chris stand for',
        'legend of shadows values', 'what does he believe in', 'chris principles',
        'loyalty honesty', 'chris honesty', 'chris loyalty',
        'supporting people', 'creativity value', 'mental health value',
        'building original', 'continuing through difficulty', 'values of shadow nexus',
        'what guides chris', 'founder values', 'creator beliefs', 'what matters to chris'
      ],
      summary: 'Recurring public values expressed through Chris\'s creative work: loyalty, honesty, family, creativity, and mental-health awareness.',
      description: 'Through his projects, Chris repeatedly expresses the same core values: loyalty, honesty, family, supporting people, mental-health awareness, continuing through difficult periods, creativity, and building something original. These values run through the Legend of Shadows identity, his music, and every part of Shadow Nexus Social. They are not claimed values — they are visible in the choices he has made and the things he has built.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorStayLegendary', 'creatorOrigin'],
      troubleshooting: []
    },

    /* ── STAY LEGENDARY ── */
    {
      id: 'creatorStayLegendary',
      category: CAT.CREATOR_VALUES,
      title: 'Stay Legendary',
      priority: 16,
      keywords: [
        'stay legendary', 'what does stay legendary mean', 'legendary', 'stay legend',
        'legend motto', 'legend of shadows motto', 'chris motto', 'legendary meaning',
        'what is stay legendary', 'legend identity', 'stay true', 'keep going legendary',
        'surviving legendary', 'making your story mean something', 'legendary identity',
        'stay legendary meaning', 'what does it mean to be legendary'
      ],
      summary: '"Stay legendary" is a message about continuing forward, staying true to yourself, and making your story mean something.',
      description: '"Stay legendary" is part of the Legend of Shadows identity. It is not about fame or status. It is a message about continuing forward when things are hard, staying true to who you are, surviving difficult moments, and making your story mean something. It is the belief that no matter what you have been through, you can still build something, still create, still matter. Chris uses it as a reminder — to himself and to anyone who connects with his work — that the fight is worth continuing.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorValues', 'creatorBio', 'creatorStory'],
      troubleshooting: []
    },

    /* ── CREATIVE SYMBOLS ── */
    {
      id: 'creatorSymbols',
      category: CAT.CREATOR_SYMBOLS,
      title: 'Legend of Shadows — Creative Symbols',
      priority: 15,
      keywords: [
        'grim reaper', 'why grim reaper', 'why does he use grim reaper',
        'wolves', 'why wolves', 'wolf symbol', 'black cat', 'crows',
        'blue lightning', 'blue flames', 'dark cinematic', 'visual identity',
        'legend of shadows symbols', 'shadow nexus symbols', 'creator symbols',
        'imagery', 'visual themes', 'shadow imagery', 'why the reaper',
        'reaper symbol', 'crow symbol', 'wolf imagery', 'lightning imagery',
        'what do the symbols mean', 'symbols meaning', 'shadow visual identity'
      ],
      summary: 'Recurring visual symbols in the Legend of Shadows creative identity: Grim Reaper, wolves, black cats, crows, blue lightning, and blue flames.',
      description: 'The Legend of Shadows creative identity uses a recurring set of visual symbols: the Grim Reaper (representing the thin line between giving up and continuing forward), wolves (loyalty, survival, the pack — those you protect and who protect you), black cats (independence, the shadow side of things), crows (reflection, dark wisdom, carrying what you have seen), blue lightning and blue flames (power, intensity, being alive through the storm), and dark cinematic environments (the internal world made visual). These symbols appear across Chris\'s music, creative projects, and in Shadow Nexus Social itself — including in Shadow Reaper, the platform\'s guardian figure.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorMusic', 'creatorValues'],
      troubleshooting: []
    },

    /* ── CREATOR PRIVACY BOUNDARY ── */
    {
      id: 'creatorPrivacy',
      category: CAT.CREATOR_PRIVACY,
      title: 'Creator Privacy Boundary',
      priority: 20,
      keywords: [
        'chris password', 'chris address', 'chris home address', 'chris phone number',
        'chris email', 'chris email address', 'chris private', 'creator private',
        'private information', 'chris credentials', 'chris token', 'chris firebase',
        'chris cloudflare', 'chris github', 'private messages', 'personal messages',
        'sister name', 'sister address', 'sister phone', 'sister contact',
        'sister private information', 'sister private', 'private family information',
        'private friend information', 'what is his password', 'give me his password',
        'location of chris', 'chris precise location', 'chris current location',
        'friend private information', 'supporter private information',
        'creator private guard', 'firebase token', 'give me his token',
        'give me his firebase', 'his firebase token', 'api key creator',
        'cloudflare api key', 'api key', 'cloudflare credentials', 'cloudflare key',
        'his cloudflare', 'give me the credentials', 'give me credentials',
        'founder token', 'show me the token', 'bypass founder', 'make me founder',
        'firebase credentials', 'give me firebase', 'show firebase',
        'delete another user', 'show another user', 'another user messages',
        'private messages of another', 'other user private'
      ],
      summary: 'Requests for private information about Chris or his family are not answered.',
      description: 'That information is private. Shadow Reaper does not share personal credentials, passwords, home addresses, phone numbers, private messages, private email contents, Firebase tokens, Cloudflare credentials, GitHub credentials, financial information, or private personal details about Chris, his family, or anyone connected to Shadow Nexus Social. If you have a genuine question about the creator\'s public work, creative identity, or Shadow Nexus Social, ask that instead.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorIdentity', 'creatorBio'],
      troubleshooting: []
    },

    /* ── CREATOR UNKNOWN PERSONAL FACTS ── */
    {
      id: 'creatorUnknown',
      category: CAT.CREATOR_PRIVACY,
      title: 'Unknown Personal Details',
      priority: 14,
      keywords: [
        'favorite movie', 'favourite movie', 'favorite film', 'favourite film',
        'favorite food', 'favourite food', 'favorite color', 'favourite color',
        'favorite colour', 'favourite colour', 'favorite book', 'favourite book',
        'favorite game', 'favourite game', 'favorite sport', 'favourite sport',
        'favorite show', 'favourite show', 'what does chris like', 'chris hobbies',
        'chris interests', 'chris personal life', 'does chris have a girlfriend',
        'does chris have kids', 'how old is chris', 'chris age', 'where does chris live',
        'what does chris look like', 'chris appearance', 'personal preferences',
        'what car does he drive', 'chris car', 'what is his favorite',
        'next year', 'add next year', 'future features', 'future plans', 'plans for next year',
        'coming next year', 'release next year', 'how many users will', 'user count',
        'users will have', 'stock price', 'stock value', 'investment', 'when is chris birthday',
        'chris birthday', 'birthday chris', 'when was he born', 'chris born',
        'what year was chris', 'chris relationship', 'does he have kids',
        'birthday', 'how old', 'chris age', 'his age', 'what age',
        'stock price of shadow nexus', 'shadow nexus stock', 'share price',
        'sns stock', 'how many users', 'user base', 'growth plans',
        'next update', 'upcoming features', 'roadmap', 'shadow nexus roadmap'
      ],
      summary: 'Shadow Reaper only shares approved public creator knowledge — personal details not in the approved record are not guessed or invented.',
      description: 'That specific detail is not part of Shadow Reaper\'s approved creator knowledge. Shadow Reaper only shares information from the approved public record about Chris and the Legend of Shadows identity. It does not guess, invent, or infer personal details from Chris\'s music or visual style. If you want to know what is publicly known about Chris\'s creative work, his story, or Shadow Nexus Social, ask away.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorPrivacy'],
      troubleshooting: []
    },

    /* ── LEGEND OF SHADOWS IDENTITY ── */
    {
      id: 'creatorLegendOfShadows',
      category: CAT.CREATOR,
      title: 'Legend of Shadows — The Identity',
      priority: 18,
      keywords: [
        'legend of shadows', 'what is legend of shadows', 'who is legend of shadows',
        'chris legend of shadows identity', 'legend of shadows artist',
        'legend of shadows meaning', 'what does legend of shadows mean',
        'legend of shadows name', 'why legend of shadows', 'the legend',
        'shadow legend identity', 'artist identity', 'creator name',
        'why that name', 'what does the name mean', 'legend identity'
      ],
      summary: 'Legend of Shadows is Chris\'s public creative and artistic identity — representing survival, creative purpose, and continuing forward through darkness.',
      description: 'Legend of Shadows is the public creative identity Chris has built around his work. The name carries the dual meaning of the word "legend" — a story worth telling, and a person who endures and creates something lasting — combined with the "shadows" that represent the difficult periods he has passed through and continues to navigate. It is not a character separate from Chris; it is an extension of his own story, turned into a creative identity. Under this name he creates music, and through it he built Shadow Nexus Social.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorIdentity', 'creatorBio', 'creatorStayLegendary'],
      troubleshooting: []
    },

    /* ── CREATOR PURPOSE ── */
    {
      id: 'creatorPurpose',
      category: CAT.CREATOR_STORY,
      title: 'Creator Purpose — Why He Creates',
      priority: 16,
      keywords: [
        'creator purpose', 'why he creates', 'why chris creates', 'what is his purpose',
        'his purpose', 'chris purpose', 'reason to create', 'motivation to create',
        'what drives chris', 'what keeps him going', 'why does he keep creating',
        'creative drive', 'purpose behind his work', 'what does he create for',
        'why does he make music', 'why did he build shadow nexus'
      ],
      summary: 'Chris creates to survive, to process difficult experiences, and to help other people feel less alone.',
      description: 'Chris\'s creative purpose has multiple layers. He creates to process his own difficult experiences — turning internal struggle into something external and meaningful. He creates to connect with people who have felt the same things he has felt, so they know they are not alone. And he creates because building — whether it is music, a platform, or a creative identity — is one of the ways he continues moving forward. Purpose emerged from difficulty, not despite it.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorStory', 'creatorOrigin', 'creatorHelpingOthers'],
      troubleshooting: []
    },

    /* ── TURNING PAIN INTO CREATIVITY ── */
    {
      id: 'creatorTurningPain',
      category: CAT.CREATOR_STORY,
      title: 'Turning Pain Into Creativity',
      priority: 16,
      keywords: [
        'turning pain into creativity', 'pain into something', 'turning struggle into art',
        'creative outlet for pain', 'using creativity to heal', 'making something from pain',
        'channelling difficult experiences', 'art from darkness', 'music from pain',
        'difficult experiences into music', 'how does he turn pain', 'processing pain',
        'creative healing', 'using music to cope', 'darkness into creativity',
        'building something from pain', 'struggle into creativity'
      ],
      summary: 'A central theme in Chris\'s work is turning difficult personal experiences into music, creative projects, and a platform that helps others.',
      description: 'One of the most consistent themes across Chris\'s work is transformation — taking what has been the hardest and most painful and building something from it instead of letting it win. His music explores those dark internal spaces directly. Shadow Nexus Social reflects his desire to build a platform shaped by real experience, not just technology. The Support Rooms, the community focus, and the mental-health awareness threads all exist because Chris did not simply survive difficult periods — he turned them into something that could potentially help others.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorStory', 'creatorPurpose', 'creatorMentalHealth'],
      troubleshooting: []
    },

    /* ── FINDING PURPOSE ── */
    {
      id: 'creatorFindingPurpose',
      category: CAT.CREATOR_STORY,
      title: 'Finding Purpose',
      priority: 15,
      keywords: [
        'finding purpose', 'found purpose', 'how chris found purpose',
        'purpose through creativity', 'purpose through music', 'purpose through building',
        'what gave him purpose', 'where did purpose come from', 'purpose in difficult times',
        'purpose after struggle', 'making your story mean something',
        'creating meaning', 'meaning through creativity', 'why he keeps creating'
      ],
      summary: 'Chris found purpose through creativity, music, and building — turning his difficult experiences into a reason to continue.',
      description: 'Purpose, for Chris, is not something that arrived easily or early. It was built gradually — out of difficult periods, through creative work, and through the act of continuing when it would have been easier to stop. Music gave him a way to speak about what he had lived through. Building Shadow Nexus Social gave him something to point toward and construct. The Legend of Shadows identity gave shape to a story that could mean something to other people. Finding purpose is itself part of the public story.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorPurpose', 'creatorTurningPain', 'creatorStayLegendary'],
      troubleshooting: []
    },

    /* ── NEVER GIVE UP ── */
    {
      id: 'creatorNeverGiveUp',
      category: CAT.CREATOR_VALUES,
      title: 'Never Giving Up',
      priority: 16,
      keywords: [
        'never give up', 'never giving up', 'never gave up', 'kept going',
        'kept fighting', 'kept moving forward', 'continued forward', 'did not quit',
        'refused to quit', 'continuing through darkness', 'survival through difficulty',
        'did not stop', 'why does he keep going', 'what keeps him going',
        'continuing when things are hard', 'not stopping', 'keep fighting',
        'perseverance', 'resilience creator', 'continuing through hard times'
      ],
      summary: 'Continuing forward and refusing to give up is one of the central themes in everything Chris creates.',
      description: '"Never giving up" is not an abstract slogan in Chris\'s work — it is the lived experience behind everything he creates. There have been periods where stopping would have been the easier path. His creative work, his music, and Shadow Nexus Social all represent the choice to keep going. The Legend of Shadows identity and "Stay legendary" both trace back to this same core truth: the fight is worth continuing, and your story is not finished.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorStayLegendary', 'creatorStory', 'creatorPurpose'],
      troubleshooting: []
    },

    /* ── HELPING OTHERS FEEL LESS ALONE ── */
    {
      id: 'creatorHelpingOthers',
      category: CAT.CREATOR_STORY,
      title: 'Helping Others Feel Less Alone',
      priority: 16,
      keywords: [
        'helping others', 'help people feel less alone', 'feel less alone',
        'not alone', 'helping people who struggle', 'others who struggle',
        'connecting with people', 'creating for others', 'music for people who struggle',
        'shadow nexus for people who struggle', 'why help others',
        'why does he care about others', 'supporting people who struggle',
        'people who feel the same', 'sharing experience to help',
        'less alone through creativity', 'community for people who struggle'
      ],
      summary: 'A core reason Chris creates is to help other people feel less alone in their own difficult experiences.',
      description: 'A significant part of why Chris makes music and built Shadow Nexus Social is to reach people who have felt similar things — isolation, internal battles, dark periods, identity struggles. By speaking about those things publicly through his creative work, he creates a signal that says: this is real, and you are not alone in it. The Support Rooms, the mental-health advocacy themes in his music, and the community side of Shadow Nexus Social all trace back to that same intention.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorPurpose', 'creatorMentalHealth', 'creatorOrigin'],
      troubleshooting: []
    },

    /* ── CREATIVITY ── */
    {
      id: 'creatorCreativity',
      category: CAT.CREATOR_STORY,
      title: 'Chris\'s Creativity',
      priority: 15,
      keywords: [
        'creativity', 'chris creativity', 'creator creative side', 'creative work',
        'creative output', 'how chris expresses himself', 'creative expression',
        'what does chris create', 'music and creativity', 'digital creativity',
        'creative identity', 'artist and builder', 'his creative projects',
        'shadow nexus and creativity', 'creative vision', 'creating original things',
        'creative philosophy', 'how creativity helps him'
      ],
      summary: 'Creativity is one of Chris\'s core tools for processing experience, expressing identity, and building something original.',
      description: 'For Chris, creativity is not separate from his personal story — it is one of the primary ways he navigates it. He creates music, built a digital platform, and developed a creative identity (Legend of Shadows) that allows him to speak about difficult internal experiences in a way that is public and shareable. Creativity is the thing that turned survival into something that could connect with other people. Shadow Nexus Social itself is a creative project — a platform that reflects his own vision rather than copying anything that already existed.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorBio', 'creatorTurningPain', 'creatorOrigin'],
      troubleshooting: []
    },

    /* ── LOYALTY ── */
    {
      id: 'creatorLoyalty',
      category: CAT.CREATOR_VALUES,
      title: 'Loyalty — A Core Value',
      priority: 15,
      keywords: [
        'loyalty', 'what loyalty means to chris', 'loyal', 'being loyal',
        'loyalty in his music', 'loyalty as a value', 'loyalty to family',
        'loyalty to people he loves', 'loyalty and shadow nexus', 'chris values loyalty',
        'standing beside people', 'showing up for people', 'not leaving people behind',
        'protecting the people you love', 'loyalty themes', 'wolves and loyalty'
      ],
      summary: 'Loyalty is one of the values Chris returns to consistently — in his music, his family, and the community he has built.',
      description: 'Loyalty is one of Chris\'s most repeated public values. It appears in his music — in themes about standing beside the people you love, not walking away when things get hard, and protecting those who matter to you. It is visible in the importance he places on his sister and the idea of chosen family. It is part of why he built Shadow Nexus Social with a community-first ethos. Loyalty, in his work, is not passive — it is active. It is showing up.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorValues', 'creatorFamily', 'creatorCommunity'],
      troubleshooting: []
    },

    /* ── MEN'S MENTAL HEALTH ── */
    {
      id: 'creatorMensMentalHealth',
      category: CAT.CREATOR_MENTAL,
      title: 'Men\'s Mental Health Advocacy',
      priority: 17,
      keywords: [
        'men mental health', 'men\'s mental health', 'mens mental health',
        'why men\'s mental health', 'men who struggle', 'men who suffer silently',
        'men asking for help', 'men and depression', 'men and anxiety',
        'why does he focus on men', 'male mental health', 'men and mental health advocacy',
        'breaking the silence men', 'men talking about feelings', 'stigma men mental health',
        'why men don\'t ask for help', 'chris mens mental health',
        'legend of shadows men mental health', 'silence and suffering men'
      ],
      summary: 'A specific focus in Chris\'s advocacy is men\'s mental health — the tendency for men to suffer in silence rather than ask for help.',
      description: 'Within his broader mental-health advocacy, Chris gives particular attention to men\'s mental health. Many of the experiences he has spoken about publicly — internal battles, feeling trapped, fighting demons silently, struggling with identity — are experiences that disproportionately go unnamed and unaddressed in men. Chris uses his music and creative work to break that silence, modelling what it looks like to speak about those experiences rather than bury them. His goal is to reduce the stigma that stops people — especially men — from asking for help.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorMentalHealth', 'creatorHelpingOthers'],
      troubleshooting: []
    },

    /* ── COMMUNITY / SUPPORT ── */
    {
      id: 'creatorCommunity',
      category: CAT.CREATOR_VALUES,
      title: 'Community and Support',
      priority: 15,
      keywords: [
        'community', 'creator community', 'community values', 'why community matters',
        'shadow nexus community', 'support community', 'chosen family', 'found family',
        'people showing up', 'community and loyalty', 'supporting each other',
        'people who stayed', 'showing up for each other', 'community first',
        'why community is important to chris', 'building community', 'community and connection'
      ],
      summary: 'Community, support, and chosen family are recurring themes in Chris\'s work and in how Shadow Nexus Social was designed.',
      description: 'Community is one of the pillars Chris built Shadow Nexus Social around. His creative work consistently themes the importance of people showing up for each other — particularly during the difficult moments when it would be easier to disappear. He has spoken about the value of chosen family: people who are not necessarily blood relatives but who choose to stand beside you. Those values are embedded in the platform — in the Support Rooms, the community features, and the ethos of the space he has built.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorValues', 'creatorLoyalty', 'creatorOrigin'],
      troubleshooting: []
    },

    /* ── MUSIC THEMES ── */
    {
      id: 'creatorMusicThemes',
      category: CAT.CREATOR_MUSIC,
      title: 'Music Themes — Legend of Shadows',
      priority: 16,
      keywords: [
        'music themes', 'themes in his music', 'what themes does he explore',
        'what is his music about', 'topics in his music', 'what does his music explore',
        'darkness hope music', 'survival themes music', 'identity themes music',
        'mental health themes music', 'loyalty music themes', 'family themes music',
        'fighting demons music', 'never give up music', 'reflection music',
        'finding purpose music', 'internal battles music', 'chris music topics',
        'what does legend of shadows music cover', 'shadow music themes'
      ],
      summary: 'Music by Chris Legend of Shadows explores darkness vs hope, survival, identity, mental health, loyalty, family, and never giving up.',
      description: 'The music Chris creates as Legend of Shadows explores a consistent set of emotional and personal themes: the battle between darkness and hope — the experience of holding both at once; survival through the hardest periods; identity and the question of who you are when you have been through difficult things; mental health in honest terms; loyalty to the people who stayed; family and protecting those you love; fighting personal demons without guarantees; reflection on how far you have come; finding purpose after difficulty; and the refusal to give up. These are not abstract concepts — they come directly from his own life.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorMusic', 'creatorMusicStyle', 'creatorStory'],
      troubleshooting: []
    },

    /* ── MUSIC STYLE ── */
    {
      id: 'creatorMusicStyle',
      category: CAT.CREATOR_MUSIC,
      title: 'Music Style — Legend of Shadows',
      priority: 15,
      keywords: [
        'music style', 'musical style', 'what style', 'genre', 'music genre',
        'rap rock', 'melodic rap', 'alternative rock', 'alternative metal',
        'heavy choruses', 'rap verses', 'emotional production', 'cinematic music',
        'what genre is chris legend of shadows', 'what genre does he make',
        'heavy emotional music', 'rock and rap', 'metal rap', 'hybrid genre',
        'alternative hip hop', 'rock rap fusion', 'dark production style'
      ],
      summary: 'Chris Legend of Shadows draws from rap rock, melodic rap, and alternative metal/rock — with heavy emotional choruses and rap verses.',
      description: 'The musical style of Chris Legend of Shadows draws across multiple genres. The core direction combines rap rock, melodic rap, and alternative metal and rock. This results in music with heavy, emotionally charged choruses and rap verses — a blend suited to the kind of intense emotional territory the music explores. The production tends toward the cinematic and dark: big, heavy sounds built around emotional weight rather than pure energy.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorMusic', 'creatorMusicThemes', 'creatorSymbols'],
      troubleshooting: []
    },

    /* ── GRIM REAPER SYMBOL ── */
    {
      id: 'creatorGrimReaper',
      category: CAT.CREATOR_SYMBOLS,
      title: 'The Grim Reaper — Creative Symbol',
      priority: 15,
      keywords: [
        'grim reaper', 'why grim reaper', 'what does the grim reaper mean',
        'grim reaper symbol', 'grim reaper meaning', 'reaper symbol',
        'reaper imagery', 'why use the grim reaper', 'the reaper in his work',
        'shadow reaper connection', 'reaper and chris', 'grim reaper legend of shadows',
        'death imagery', 'why death imagery', 'grim reaper in shadow nexus'
      ],
      summary: 'The Grim Reaper in Chris\'s creative identity represents the thin line between giving up and continuing forward — surviving the moment when it felt impossible.',
      description: 'The Grim Reaper is one of the most prominent symbols in the Legend of Shadows creative identity. In Chris\'s work, it does not represent death in a literal or celebratory sense. It represents standing at the line — the moment where giving up would have been easier than continuing. The Grim Reaper is the face of that moment, and the act of continuing past it is what the identity is built around. The platform guardian — Shadow Reaper — carries the same symbolic weight: something that exists at the edge of the difficult, watching over and guiding.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorSymbols', 'creatorStory', 'creatorNeverGiveUp'],
      troubleshooting: []
    },

    /* ── WOLVES SYMBOL ── */
    {
      id: 'creatorWolves',
      category: CAT.CREATOR_SYMBOLS,
      title: 'Wolves — Creative Symbol',
      priority: 14,
      keywords: [
        'wolves', 'wolf', 'why wolves', 'wolf symbol', 'wolf meaning',
        'wolves in his work', 'wolves legend of shadows', 'wolf imagery',
        'pack', 'wolf pack', 'why does he use wolves', 'wolves and loyalty',
        'wolves and survival', 'wolves and protection', 'wolves symbol meaning'
      ],
      summary: 'Wolves represent loyalty, survival, the pack, and protecting those you love — core themes in Chris\'s creative identity.',
      description: 'Wolves appear across the Legend of Shadows creative identity as symbols of loyalty, survival, pack mentality, and protecting the people you care about. A wolf does not abandon its pack. It survives in difficult terrain. It stands beside those it is bonded to. These qualities mirror the values Chris emphasises in his creative work: showing up for the people you love, surviving difficult periods, and not leaving behind those who matter.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorSymbols', 'creatorLoyalty', 'creatorFamily'],
      troubleshooting: []
    },

    /* ── BLACK CATS SYMBOL ── */
    {
      id: 'creatorBlackCats',
      category: CAT.CREATOR_SYMBOLS,
      title: 'Black Cats — Creative Symbol',
      priority: 13,
      keywords: [
        'black cat', 'black cats', 'why black cats', 'black cat symbol',
        'black cat meaning', 'black cat imagery', 'black cat legend of shadows',
        'why does he use black cats', 'black cat in his work'
      ],
      summary: 'Black cats are part of the Legend of Shadows visual identity, representing independence and the shadow side of things.',
      description: 'Black cats appear as part of the Legend of Shadows visual identity. They carry associations of independence, the shadow side of existence, and moving through the world without needing to be understood by everyone. They are part of the overall visual language — dark, cinematic, and self-directed.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorSymbols'],
      troubleshooting: []
    },

    /* ── CROWS SYMBOL ── */
    {
      id: 'creatorCrows',
      category: CAT.CREATOR_SYMBOLS,
      title: 'Crows — Creative Symbol',
      priority: 13,
      keywords: [
        'crows', 'crow', 'why crows', 'crow symbol', 'crow meaning',
        'crow imagery', 'crows in his work', 'crows legend of shadows',
        'why does he use crows', 'crow and wisdom', 'crow and darkness'
      ],
      summary: 'Crows represent reflection, dark wisdom, and carrying what you have witnessed — recurring visual elements in the Legend of Shadows identity.',
      description: 'Crows appear in the Legend of Shadows creative identity as symbols of reflection, dark wisdom, and the act of carrying everything you have seen and survived. They are associated with the ability to witness darkness and continue moving. In Chris\'s visual language they are part of the cinematic dark environment — observers that carry memory and meaning.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorSymbols'],
      troubleshooting: []
    },

    /* ── BLUE LIGHTNING / BLUE FLAMES ── */
    {
      id: 'creatorBlueLightning',
      category: CAT.CREATOR_SYMBOLS,
      title: 'Blue Lightning and Blue Flames — Creative Symbols',
      priority: 13,
      keywords: [
        'blue lightning', 'blue flames', 'why blue lightning', 'why blue flames',
        'blue fire', 'lightning symbol', 'flames symbol', 'blue light imagery',
        'blue lightning meaning', 'blue flames meaning', 'electric blue',
        'power imagery', 'storm imagery', 'blue lightning in his work',
        'blue flames legend of shadows', 'blue energy'
      ],
      summary: 'Blue lightning and blue flames represent power, intensity, and being alive through the storm — part of the Legend of Shadows visual identity.',
      description: 'Blue lightning and blue flames are recurring visual elements in the Legend of Shadows identity. They represent power, intensity, and the experience of being alive through difficult and stormy moments — not despite the storm, but within it. The blue colour separates these from the typical red or orange associations; it speaks to something colder, more internal, and more specific to the Legend of Shadows palette.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorSymbols'],
      troubleshooting: []
    },

    /* ── SISTER IMPORTANCE ── */
    {
      id: 'creatorSisterImportance',
      category: CAT.CREATOR_FAMILY,
      title: 'His Sister — Why She Matters',
      priority: 16,
      keywords: [
        'why his sister matters', 'why is his sister important', 'sister importance',
        'sister role in his life', 'how important is his sister', 'his person',
        'best friend sister', 'his best friend', 'his person', 'keeper',
        'brother\'s keeper', 'sister keeper', 'why he keeps going for his sister',
        'sister reason to keep going', 'protecting his sister', 'love for his sister',
        'his sister helps him', 'sister and survival', 'sister and purpose'
      ],
      summary: 'Chris has described his sister as his person and his best friend — one of the most important reasons he continues moving forward.',
      description: 'Chris has publicly described his sister as his person — his best friend. He considers himself his sister\'s keeper. During the hardest periods of his life, his sister has been a significant reason to keep moving forward. Their relationship represents everything he values most publicly: family, loyalty, standing beside the people you love, and continuing through difficult times together. Her personal information is private and will not be shared here — what matters is what their relationship represents in his story.',
      how: null,
      navigation: null,
      founderOnly: false,
      minRole: 'guest',
      audience: ['guest', 'member', 'founder'],
      related: ['creatorFamily', 'creatorLoyalty', 'creatorNeverGiveUp'],
      troubleshooting: []
    }

  ]; /* end KNOWLEDGE */


  /* ─────────────────────────────────────────────────────────────
     ENGINE DIAGNOSTICS COUNTERS  (safe — no user data stored)
  ───────────────────────────────────────────────────────────────*/
  var _diag = {
    localAnswerCount:  0,
    aiFallbackCount:   0,
    noMatchCount:      0,
    wrongMatchCount:   0   // reserved for future tuning
  };

  /* ─────────────────────────────────────────────────────────────
     KEYWORD INDEX  (built once at load time)
     keyword → [entryId, ...]
  ───────────────────────────────────────────────────────────────*/
  var _index = {};

  (function buildIndex() {
    KNOWLEDGE.forEach(function (entry) {
      entry.keywords.forEach(function (kw) {
        if (!_index[kw]) _index[kw] = [];
        if (_index[kw].indexOf(entry.id) === -1) _index[kw].push(entry.id);
      });
    });
  })();

  /* ─────────────────────────────────────────────────────────────
     CATEGORY MAP  (built once)
  ───────────────────────────────────────────────────────────────*/
  var _categoryMap = {};

  (function buildCategoryMap() {
    KNOWLEDGE.forEach(function (entry) {
      var cat = entry.category || 'GENERAL';
      if (!_categoryMap[cat]) _categoryMap[cat] = [];
      _categoryMap[cat].push(entry);
    });
  })();

  /* ─────────────────────────────────────────────────────────────
     ID MAP  (built once for O(1) lookup)
  ───────────────────────────────────────────────────────────────*/
  var _idMap = {};
  (function buildIdMap() {
    KNOWLEDGE.forEach(function (e) { _idMap[e.id] = e; });
  })();

  /* ─────────────────────────────────────────────────────────────
     INTERNAL HELPERS
  ───────────────────────────────────────────────────────────────*/

  function _byId(id) {
    return _idMap[id] || null;
  }

  /** Normalize text: lowercase, collapse whitespace, strip punctuation except apostrophes */
  function _normalize(text) {
    return (text || '').toLowerCase()
      .replace(/[^\w\s']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Apply alias expansion — returns augmented string */
  function _applyAliases(text) {
    var out = text;
    Object.keys(ALIASES).forEach(function (alias) {
      if (out.indexOf(alias) !== -1) {
        out = out + ' ' + ALIASES[alias];
      }
    });
    return out;
  }

  /** Infer category from current page id */
  function _inferCategoryFromPage(currentPage) {
    if (!currentPage) return null;
    var p = currentPage.toLowerCase();
    if (p.indexOf('radio') !== -1)          return CAT.RADIO;
    if (p.indexOf('live') !== -1)           return CAT.LIVE;
    if (p.indexOf('tv') !== -1)             return CAT.TV;
    if (p.indexOf('feed') !== -1 || p === 'index') return CAT.FEED;
    if (p.indexOf('inbox') !== -1)          return CAT.INBOX;
    if (p.indexOf('notification') !== -1)   return CAT.NOTIFICATIONS;
    if (p.indexOf('setting') !== -1)        return CAT.SETTINGS;
    if (p.indexOf('search') !== -1)         return CAT.SEARCH;
    if (p.indexOf('friend') !== -1)         return CAT.FRIENDS;
    if (p.indexOf('profile') !== -1)        return CAT.PROFILE;
    if (p.indexOf('storm') !== -1)          return CAT.ROOMS;
    if (p.indexOf('support') !== -1)        return CAT.ROOMS;
    if (p.indexOf('community') !== -1)      return CAT.COMMUNITY;
    if (p.indexOf('arcade') !== -1)         return CAT.ARCADE;
    return null;
  }

  /**
   * Score a normalized+expanded text against a single knowledge entry.
   * Returns numeric score.
   */
  function _scoreEntry(normText, entry, contextCategory, patternBoosts) {
    var score = 0;

    /* Exact id mention */
    if (normText.indexOf(entry.id.toLowerCase()) !== -1) score += 12;

    /* Title mention (full) */
    if (entry.title && normText.indexOf(entry.title.toLowerCase()) !== -1) score += 10;

    /* Priority weight — higher-priority entries get a base bonus */
    score += Math.floor((entry.priority || 5) * 0.5);

    /* Keyword matches — phrase length multiplied bonus */
    entry.keywords.forEach(function (kw) {
      if (normText.indexOf(kw) !== -1) {
        var words = kw.split(' ').length;
        /* Multi-word phrases score higher */
        score += words >= 3 ? words * 4
               : words === 2 ? words * 3
               : 2;
      }
    });

    /* Context category boost */
    if (contextCategory && entry.category === contextCategory) {
      score += 4;
    }

    /* Question-pattern boost from pre-matched patterns */
    if (patternBoosts) {
      /* Category match */
      if (patternBoosts.category && entry.category === patternBoosts.category) {
        score += patternBoosts.boost;
      }
      /* Specific id match */
      if (patternBoosts.id && entry.id === patternBoosts.id) {
        score += patternBoosts.boost + 4;
      }
    }

    return score;
  }

  /**
   * Run all question patterns against the text.
   * Returns the highest-matching pattern result (or null).
   */
  function _matchPatterns(normText) {
    var best = null;
    var bestBoost = 0;
    QUESTION_PATTERNS.forEach(function (p) {
      if (p.pattern.test(normText)) {
        if (p.boost > bestBoost) {
          bestBoost = p.boost;
          best = p;
        }
      }
    });
    return best;
  }

  /**
   * Filter entries by role.
   */
  function _filterByRole(entries, role) {
    return entries.filter(function (e) {
      if (e.founderOnly && role !== 'founder') return false;
      return true;
    });
  }

  /**
   * Select the most relevant troubleshooting resolution from an entry
   * based on the question text.
   */
  function _matchTroubleshooting(normText, entry) {
    if (!entry.troubleshooting || !entry.troubleshooting.length) return null;
    var found = null;

    /* Pass 1: multi-word prefix match on symptom */
    entry.troubleshooting.forEach(function (tr) {
      if (found) return;
      if (!tr.symptom) return;
      var symptomWords = tr.symptom.toLowerCase().split(' ').slice(0, 4).join(' ');
      if (normText.indexOf(symptomWords) !== -1) found = tr;
    });

    /* Pass 2: keyword overlap count ≥ 2 */
    if (!found) {
      entry.troubleshooting.forEach(function (tr) {
        if (found) return;
        if (!tr.symptom) return;
        var symptomWords = tr.symptom.toLowerCase().split(/\s+/);
        var matchCount = 0;
        symptomWords.forEach(function (sw) {
          if (sw.length > 3 && normText.indexOf(sw) !== -1) matchCount++;
        });
        if (matchCount >= 2) found = tr;
      });
    }

    return found;
  }

  /* ─────────────────────────────────────────────────────────────
     CONFIDENCE CLASSIFIER
     Takes a raw score and returns a confidence level string.
  ───────────────────────────────────────────────────────────────*/
  function _classifyConfidence(score) {
    if (score >= CONF.HIGH)   return 'HIGH';
    if (score >= CONF.MEDIUM) return 'MEDIUM';
    if (score >= CONF.LOW)    return 'LOW';
    return 'NONE';
  }

  /* ─────────────────────────────────────────────────────────────
     RETRIEVE KNOWLEDGE
     Returns ranked array of { entry, score, confidence } for the
     top matching entries.  Does not build a response text.
  ───────────────────────────────────────────────────────────────*/
  function retrieveKnowledge(question, context) {
    if (!question) return [];

    var role        = (context && context.role)        ? context.role        : 'guest';
    var currentPage = (context && context.currentPage) ? context.currentPage : null;
    var contextCat  = _inferCategoryFromPage(currentPage);

    /* Normalize + alias expansion */
    var normText = _applyAliases(_normalize(question));

    /* Pattern matching */
    var patternBoost = _matchPatterns(normText);

    /* Filter by role */
    var visible = _filterByRole(KNOWLEDGE, role);

    /* Score */
    var scored = visible.map(function (entry) {
      return {
        entry:      entry,
        score:      _scoreEntry(normText, entry, contextCat, patternBoost),
        confidence: 'NONE'   // filled below
      };
    });

    /* Sort descending */
    scored.sort(function (a, b) { return b.score - a.score; });

    /* Assign confidence */
    scored.forEach(function (s) {
      s.confidence = _classifyConfidence(s.score);
    });

    /* Return only entries with score > 0, up to 5 */
    return scored.filter(function (s) { return s.score > 0; }).slice(0, 5);
  }

  /* ─────────────────────────────────────────────────────────────
     ANSWER LOCALLY
     Uses retrieved knowledge to produce a complete answer without AI.
     Returns null if confidence is too low to answer locally.

     Returns:
       { text, page, handled, confidence, id, snippets }
     or null for LOW/NONE confidence (→ caller should use AI).
  ───────────────────────────────────────────────────────────────*/
  function answerLocally(question, context) {
    if (!question) return null;

    var hits = retrieveKnowledge(question, context);
    if (!hits.length || hits[0].score <= 0) {
      _diag.noMatchCount++;
      return null;
    }

    var top  = hits[0];
    var conf = top.confidence;

    /* LOW or NONE — tell caller to use AI */
    if (conf === 'LOW' || conf === 'NONE') {
      return null;
    }

    var best     = top.entry;
    var normText = _applyAliases(_normalize(question));

    /* ── Assemble response text ── */
    var responseText = best.description;

    /* Add how-to when question asks for it */
    var isHowQ = /\b(how|where|what|find|go to|open|access|get to|navigate|location|steps|which)\b/i.test(question);
    if (isHowQ && best.how) {
      responseText = responseText + '\n\n' + best.how;
    }

    /* Troubleshooting override */
    var foundTrouble = _matchTroubleshooting(normText, best);

    /* Also search second-best entry for troubleshooting if top entry didn't match */
    if (!foundTrouble && hits.length > 1 && hits[1].score >= CONF.LOW) {
      foundTrouble = _matchTroubleshooting(normText, hits[1].entry);
    }

    if (foundTrouble) {
      responseText = foundTrouble.resolution;
    }

    /* Snippets for AI grounding (top 3) */
    var snippets = hits.slice(0, 3)
      .filter(function (h) { return h.score > 0; })
      .map(function (h) {
        return {
          id:      h.entry.id,
          title:   h.entry.title   || '',
          summary: h.entry.summary || '',
          how:     h.entry.how     || ''
        };
      });

    _diag.localAnswerCount++;

    return {
      text:       responseText,
      page:       best.navigation || null,
      handled:    true,
      confidence: conf,
      id:         best.id,
      category:   best.category,
      snippets:   snippets
    };
  }

  /* ─────────────────────────────────────────────────────────────
     LEGACY query() API  — Stage 3 compatibility
     Wraps answerLocally but also returns a result for LOW confidence
     (so existing code that passes snippets to AI still works).
  ───────────────────────────────────────────────────────────────*/
  function query(message, context) {
    if (!message) return null;

    var role        = (context && context.role)        ? context.role        : 'guest';
    var currentPage = (context && context.currentPage) ? context.currentPage : null;
    var contextCat  = _inferCategoryFromPage(currentPage);

    var normText     = _applyAliases(_normalize(message));
    var patternBoost = _matchPatterns(normText);
    var visible      = _filterByRole(KNOWLEDGE, role);

    var scored = visible.map(function (entry) {
      return {
        entry: entry,
        score: _scoreEntry(normText, entry, contextCat, patternBoost)
      };
    });
    scored.sort(function (a, b) { return b.score - a.score; });

    if (!scored.length || scored[0].score === 0) {
      _diag.noMatchCount++;
      return null;
    }

    var best = scored[0].entry;
    var conf = _classifyConfidence(scored[0].score);

    /* Response text */
    var responseText = best.description;
    var isHowQ = /\b(how|where|what|find|go to|open|access|get to|navigate|location|steps)\b/i.test(message);
    if (isHowQ && best.how) {
      responseText = responseText + '\n\n' + best.how;
    }

    var foundTrouble = _matchTroubleshooting(normText, best);
    if (foundTrouble) {
      responseText = foundTrouble.resolution;
    }

    var snippets = scored.slice(0, 3)
      .filter(function (s) { return s.score > 0; })
      .map(function (s) {
        return {
          id:      s.entry.id,
          title:   s.entry.title   || '',
          summary: s.entry.summary || '',
          how:     s.entry.how     || ''
        };
      });

    if (conf === 'HIGH' || conf === 'MEDIUM') {
      _diag.localAnswerCount++;
    }

    return {
      text:       responseText,
      page:       best.navigation || null,
      handled:    conf !== 'NONE',
      confidence: conf,
      id:         best.id,
      category:   best.category,
      snippets:   snippets
    };
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API  — window.SNXShadowKnowledge
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowKnowledge = {

    /**
     * Full local answer pipeline.
     * Returns answer object (HIGH/MEDIUM confidence) or null (LOW/NONE → use AI).
     */
    answerLocally: answerLocally,

    /**
     * Ranked knowledge retrieval.
     * Returns [ { entry, score, confidence }, … ] (up to 5).
     */
    retrieveKnowledge: retrieveKnowledge,

    /**
     * Legacy query — returns { text, page, handled, confidence, id, snippets } or null.
     * HIGH + MEDIUM answers are handled locally.
     * LOW answers return snippets for AI grounding.
     */
    query: query,

    /**
     * Get all knowledge entries (respects founderOnly).
     */
    getAll: function (role) {
      if (role === 'founder') return KNOWLEDGE;
      return KNOWLEDGE.filter(function (e) { return !e.founderOnly; });
    },

    /**
     * Get a single entry by id.
     */
    getEntry: function (id) { return _byId(id); },

    /**
     * Get all feature category IDs.
     */
    getCategories: function () {
      return Object.keys(_categoryMap);
    },

    /**
     * Get all entries in a category.
     */
    getByCategory: function (category, role) {
      var entries = _categoryMap[category] || [];
      if (role === 'founder') return entries;
      return entries.filter(function (e) { return !e.founderOnly; });
    },

    /**
     * Confidence thresholds (for external callers to inspect).
     */
    CONF: CONF,

    /**
     * Safe diagnostics counters — no user data.
     * Founder-only caller is expected to gate access.
     */
    getDiagnostics: function () {
      return {
        recordCount:       KNOWLEDGE.length,
        categoryCount:     Object.keys(_categoryMap).length,
        localAnswerCount:  _diag.localAnswerCount,
        aiFallbackCount:   _diag.aiFallbackCount,
        noMatchCount:      _diag.noMatchCount,
        build:             BUILD_ID
      };
    },

    /**
     * Increment AI-fallback counter (called by snx-shadow-ai.js when AI is used).
     */
    recordAIFallback: function () {
      _diag.aiFallbackCount++;
    },

    /** Category constants */
    CAT: CAT,

    /** Build identifier */
    build: BUILD_ID
  };

})(window);
