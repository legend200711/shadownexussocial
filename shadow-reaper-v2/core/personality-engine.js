/**
 * shadow-reaper-v2/core/personality-engine.js
 * Shadow Reaper — Personality Engine
 *
 * Build: SR-V2-PERSONALITY-1
 *
 * Exposes: window.SRPersonality
 *
 * PURPOSE:
 *   Persistent Shadow Reaper personality layer.
 *   Adapts response tone, humor, formality, and style to the user
 *   through actual conversation — NOT a canned personality database.
 *
 * WHAT THIS MODULE DOES:
 *   - Maintains a lightweight "conversational preference profile" for each user.
 *   - Signals the appropriate response personality mode per-turn.
 *   - Tracks and adapts to: humor frequency, sarcasm tolerance, response length
 *     preference, formality level, casual language, correction patterns,
 *     playfulness, and topic-specific tone.
 *   - Detects when humor is appropriate or inappropriate given context.
 *   - Provides a per-turn "personality context" object that the response/model
 *     layer can use to shape responses naturally.
 *
 * WHAT THIS MODULE DOES NOT DO:
 *   - Does not replace ShadowReaper.ask() or any pipeline stage.
 *   - Does not create a second AI brain.
 *   - Does not store sensitive data.
 *   - Does not override internet rules.
 *   - Does not hardcode specific responses.
 *
 * PERSONALITY PROFILE FIELDS:
 *   humorFrequency      float 0-1  — how often humor is appropriate
 *   sarcasmTolerance    float 0-1  — willingness to use sarcasm
 *   casualness          float 0-1  — casual vs formal register
 *   preferredLength     'short'|'medium'|'long'
 *   playfulness         float 0-1
 *   directness          float 0-1  — direct vs elaborate answers
 *   technicalDepth      float 0-1  — surface vs deep technical detail
 *   correctionCount     int        — how many times user corrected Shadow
 *   jokeCount           int        — times user engaged positively with humor
 *   seriousTurnCount    int        — recent serious turns (suppress humor)
 *
 * STORAGE:
 *   Firestore: users/{uid}/shadowReaperPreferences/personality
 *   localStorage fallback: srPersonalityPrefs_{uid}
 *   Guest fallback: srPersonalityPrefs_guest
 *
 * One-brain rule: always ONE Shadow Reaper. This module is a pure
 * signal/preference layer — it never routes to a different AI.
 *
 * ZERO EXTERNAL AI CALLS. ZERO POLLING. ZERO setInterval.
 */

'use strict';

(function (global) {

  var BUILD_ID = 'SR-V2-PERSONALITY-1';

  // ─── Default profile ──────────────────────────────────────────────────────

  var DEFAULT_PROFILE = {
    humorFrequency:   0.35,   // moderate humor by default
    sarcasmTolerance: 0.25,   // light sarcasm only initially
    casualness:       0.60,   // conversational, not stiff
    playfulness:      0.30,
    directness:       0.65,   // lean direct but not blunt
    technicalDepth:   0.50,   // balanced
    preferredLength:  'medium',
    correctionCount:  0,
    jokeCount:        0,
    seriousTurnCount: 0,
    totalTurns:       0,
  };

  // ─── Humor suppression thresholds ────────────────────────────────────────
  // If recent serious turns >= this, suppress humor for the current turn.
  var SERIOUS_TURN_SUPPRESS_THRESHOLD = 2;

  // After this many turns of low-engagement, reduce humor frequency
  var HUMOR_DECAY_THRESHOLD = 5;

  // ─── Sensitivity patterns — topics where humor is NEVER appropriate ───────
  // These are checked in the turn text before issuing any humor signal.
  var SERIOUS_TOPIC_PATTERNS = [
    /\b(suicid|kill\s+myself|end\s+my\s+life|self.harm|depressed|depression|anxiety)\b/i,
    /\b(cancer|died|death|funeral|grieving|grief|loss of|passed away|dead)\b/i,
    /\b(abuse|assault|trauma|ptsd|domestic violence|rape|harassed)\b/i,
    /\b(fired|lost my job|got fired|evicted|homeless|bankrupt|court|arrested)\b/i,
    /\b(emergency|urgent|help me|need help|can.?t breathe|panic attack)\b/i,
    /\b(heartbroken|breakup|break up|divorce|cheated on|betrayed)\b/i,
  ];

  // Frustration signals — reduce humor but do NOT suppress entirely
  var FRUSTRATION_PATTERNS = [
    /\b(stupid|broken|not working|doesn.?t work|piece of|why the hell|wtf|what the)\b/i,
    /\b(frustrated|annoying|annoyed|pissed|fed up|giving up|stuck|can.?t figure)\b/i,
    /\b(crashed|error|bug|broke|failing|keeps failing|still not|again)\b/i,
  ];

  // Playful/casual signals — increase humor signal
  var PLAYFUL_PATTERNS = [
    /\b(lol|lmao|haha|hehe|funny|hilarious|that.?s great|nice one|good one)\b/i,
    /\b(joking|kidding|just messing|jk|sarcasm|sarcastic|banter|roast)\b/i,
    /\b(smartass|wise(ass|guy)|oh come on|seriously though|for real|come on now)\b/i,
  ];

  // Technical/focused signals — reduce humor, increase directness
  var TECHNICAL_PATTERNS = [
    /\b(error|exception|stack trace|undefined|null pointer|console|terminal|deploy|build)\b/i,
    /\b(firebase|react|node|python|javascript|typescript|css|html|api|endpoint|database)\b/i,
    /\b(circuit|resistor|capacitor|voltage|microcontroller|arduino|raspberry|gpio|solder)\b/i,
    /\b(code|function|variable|class|import|export|module|package|library|framework)\b/i,
  ];

  // ─── State ────────────────────────────────────────────────────────────────

  var _profile = Object.assign({}, DEFAULT_PROFILE);
  var _loaded  = false;

  // Track recent turn tones for humor context
  var _recentTones = [];  // last 6 turn tones
  var MAX_RECENT_TONES = 6;

  // ─── Firebase / storage helpers ───────────────────────────────────────────

  function _fa()  { return global.SRFirebaseAdapter || null; }

  function _uid() {
    var fa = _fa();
    return (fa && typeof fa.getUID === 'function') ? fa.getUID() : null;
  }

  function _localKey() {
    var uid = _uid();
    return uid ? ('srPersonalityPrefs_' + uid) : 'srPersonalityPrefs_guest';
  }

  function _readLocal() {
    try {
      var raw = global.localStorage && global.localStorage.getItem(_localKey());
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function _writeLocal(prefs) {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(_localKey(), JSON.stringify(prefs));
      }
    } catch (_) {}
  }

  function _firestoreRef() {
    var fa = _fa();
    var uid = _uid();
    if (!fa || !uid) return null;
    try {
      if (fa._db && typeof fa._db.doc === 'function') {
        return fa._db.doc('users/' + uid + '/shadowReaperPreferences/personality');
      }
    } catch (_) {}
    return null;
  }

  // ─── Load ─────────────────────────────────────────────────────────────────

  function load(callback) {
    callback = callback || function () {};

    // OFFLINE-FIRST: always apply local profile immediately.
    // Personality must work without waiting for a Firestore round-trip.
    // If Firestore is unreachable, the locally-stored profile is used.
    var local = _readLocal();
    if (local) _applyProfile(local);

    // Mark loaded immediately from local data — personality is now operational.
    // Firestore sync is a background enrichment, NOT a requirement.
    _loaded = true;

    // Report to SROfflineState
    var offState = global.SROfflineState;
    if (offState && typeof offState.setPersonalityLoaded === 'function') {
      try { offState.setPersonalityLoaded(true); } catch (_) {}
    }

    var ref = _firestoreRef();
    if (!ref) {
      callback(null, _getProfile());
      return;
    }

    // Background Firestore sync — does NOT block personality use.
    // On success, enriches the local profile and saves it for next offline use.
    ref.get().then(function (doc) {
      if (doc && doc.exists) {
        _applyProfile(doc.data() || {});
        _writeLocal(_getProfile());
      }
      callback(null, _getProfile());
    }).catch(function () {
      // Firestore unreachable — that is fine, local profile is already applied.
      callback(null, _getProfile());
    });
  }

  function _applyProfile(data) {
    if (!data || typeof data !== 'object') return;
    var keys = Object.keys(DEFAULT_PROFILE);
    keys.forEach(function (k) {
      if (data[k] !== undefined && data[k] !== null) {
        _profile[k] = data[k];
      }
    });
  }

  function _getProfile() {
    return Object.assign({}, _profile);
  }

  // ─── Save ─────────────────────────────────────────────────────────────────

  function _save() {
    var prefs = _getProfile();
    _writeLocal(prefs);

    var ref = _firestoreRef();
    if (ref) {
      ref.set(prefs, { merge: true }).catch(function () {});
    }
  }

  // ─── Analyze turn for personality signals ─────────────────────────────────
  /**
   * analyzeTurn(text, understood)
   *
   * Classifies the turn for personality context signals.
   * Returns a personality context object for use by the response layer.
   *
   * Returns:
   *   {
   *     humorAppropriate:   boolean
   *     sarcasmAppropriate: boolean
   *     playfulMode:        boolean
   *     seriousMode:        boolean
   *     technicalMode:      boolean
   *     frustratedMode:     boolean
   *     preferredLength:    'short'|'medium'|'long'
   *     directness:         float
   *     humorLevel:         float
   *     casualness:         float
   *   }
   */
  function analyzeTurn(text, understood) {
    if (!text) text = '';
    var lower = text.toLowerCase();
    var intent = (understood && understood.intent) || 'UNKNOWN';
    var tone   = (understood && understood.tone)   || 'neutral';

    // ── Absolute suppression check ────────────────────────────────────────
    var isAbsolutelySerious = SERIOUS_TOPIC_PATTERNS.some(function (p) { return p.test(lower); });
    if (isAbsolutelySerious) {
      _recordTone('serious');
      return _buildContext({ seriousMode: true, humorAppropriate: false, sarcasmAppropriate: false });
    }

    // ── Signal detection ──────────────────────────────────────────────────
    var isFrustrated = FRUSTRATION_PATTERNS.some(function (p) { return p.test(lower); }) ||
                       tone === 'frustrated' || tone === 'angry';
    var isPlayful    = PLAYFUL_PATTERNS.some(function (p) { return p.test(lower); }) ||
                       tone === 'playful';
    var isTechnical  = TECHNICAL_PATTERNS.some(function (p) { return p.test(lower); });

    // Intent-based seriousness
    var isIntentSerious = (intent === 'USER_CORRECTION' || tone === 'sad' ||
                           tone === 'anxious' || tone === 'angry');

    // Track tone for context window
    if (isPlayful) {
      _recordTone('playful');
    } else if (isFrustrated || isTechnical) {
      _recordTone('focused');
    } else if (isIntentSerious) {
      _recordTone('serious');
    } else {
      _recordTone(tone || 'neutral');
    }

    // Count recent serious turns from tone window
    var recentSeriousCount = _recentTones.slice(-4).filter(function (t) {
      return t === 'serious' || t === 'sad' || t === 'anxious' || t === 'angry';
    }).length;

    // ── Humor logic ───────────────────────────────────────────────────────
    // Humor is appropriate when:
    //   - profile says it's ok (humorFrequency > threshold)
    //   - no recent serious turns
    //   - not currently frustrated
    //   - not a technical deep-work turn (small allowance for technical turns)
    var humorThreshold = isTechnical ? 0.60 : (isFrustrated ? 0.75 : 0.25);
    var humorSuppressed = (recentSeriousCount >= SERIOUS_TURN_SUPPRESS_THRESHOLD) ||
                          isIntentSerious;
    var humorAppropriate = !humorSuppressed &&
                           (_profile.humorFrequency >= humorThreshold) &&
                           !isFrustrated;

    // If user is explicitly being playful, boost
    if (isPlayful && !humorSuppressed) {
      humorAppropriate = true;
    }

    var sarcasmAppropriate = humorAppropriate &&
                             _profile.sarcasmTolerance >= 0.30 &&
                             isPlayful;

    return _buildContext({
      humorAppropriate:   humorAppropriate,
      sarcasmAppropriate: sarcasmAppropriate,
      playfulMode:        isPlayful,
      seriousMode:        isIntentSerious || recentSeriousCount >= SERIOUS_TURN_SUPPRESS_THRESHOLD,
      technicalMode:      isTechnical,
      frustratedMode:     isFrustrated,
    });
  }

  function _buildContext(overrides) {
    var ctx = {
      humorAppropriate:   false,
      sarcasmAppropriate: false,
      playfulMode:        false,
      seriousMode:        false,
      technicalMode:      false,
      frustratedMode:     false,
      preferredLength:    _profile.preferredLength,
      directness:         _profile.directness,
      humorLevel:         _profile.humorFrequency,
      casualness:         _profile.casualness,
    };
    return Object.assign(ctx, overrides);
  }

  function _recordTone(tone) {
    _recentTones.push(tone);
    if (_recentTones.length > MAX_RECENT_TONES) {
      _recentTones = _recentTones.slice(-MAX_RECENT_TONES);
    }
  }

  // ─── Learn from turn outcome ──────────────────────────────────────────────
  /**
   * learnFromTurn(userText, understood, assistantResponse, feedback)
   *
   * Called after each completed turn to adaptively update the personality profile.
   * feedback is optional: { positive: bool } when explicit feedback is available.
   *
   * Learning signals:
   *   - User says something playful after Shadow responded → humor resonated
   *   - User says "that's not what I meant" / correction → directness issue
   *   - User sends very short messages consistently → prefer shorter responses
   *   - User asks for more detail → increase technical depth
   *   - User jokes back → increase humor frequency
   */
  function learnFromTurn(userText, understood, assistantResponse) {
    if (!userText) return;
    var lower = userText.toLowerCase();
    var intent = (understood && understood.intent) || 'UNKNOWN';
    var tone   = (understood && understood.tone)   || 'neutral';

    _profile.totalTurns++;

    // ── Humor engagement ──────────────────────────────────────────────────
    if (PLAYFUL_PATTERNS.some(function (p) { return p.test(lower); })) {
      _profile.jokeCount++;
      // Gradually raise humor frequency when user engages positively
      if (_profile.humorFrequency < 0.80) {
        _profile.humorFrequency = Math.min(0.80,
          _profile.humorFrequency + 0.04);
      }
    }

    // ── Sarcasm tolerance ─────────────────────────────────────────────────
    // If user uses sarcasm/banter, they likely tolerate it from Shadow too
    if (/\b(smartass|wise(ass|guy)|oh come on|sarcasm|sarcastic|banter)\b/i.test(lower)) {
      if (_profile.sarcasmTolerance < 0.80) {
        _profile.sarcasmTolerance = Math.min(0.80,
          _profile.sarcasmTolerance + 0.05);
      }
    }

    // ── Correction → directness signal ───────────────────────────────────
    if (intent === 'USER_CORRECTION' ||
        /\b(no[,.]?\s*(i meant|that.?s not|that wasn.?t)|actually[,.]|correction[:]?|wait[,.]?\s+i meant)\b/i.test(lower)) {
      _profile.correctionCount++;
      // More corrections → Shadow needs to be more direct and precise
      if (_profile.directness < 0.90) {
        _profile.directness = Math.min(0.90, _profile.directness + 0.03);
      }
    }

    // ── Response length preference ────────────────────────────────────────
    // Very short user messages suggest they prefer concise exchanges
    var wordCount = userText.trim().split(/\s+/).length;
    if (wordCount <= 4 && _profile.totalTurns > 10) {
      // User communicates in short bursts — prefer short responses
      if (_profile.preferredLength !== 'short') {
        // Soft push toward short after many brief turns
        var shortSignals = _recentTones.filter(function (t) { return t; }).length;
        if (shortSignals >= 4) {
          _profile.preferredLength = 'short';
        }
      }
    } else if (wordCount >= 20 && _profile.preferredLength === 'short') {
      // User wrote a detailed message — maybe they want detailed responses
      _profile.preferredLength = 'medium';
    }

    // ── Casual language ───────────────────────────────────────────────────
    if (/\b(gonna|wanna|gotta|ain.?t|kinda|sorta|ya|yep|nah|nope)\b/i.test(lower)) {
      if (_profile.casualness < 0.90) {
        _profile.casualness = Math.min(0.90, _profile.casualness + 0.02);
      }
    }

    // ── Technical depth ───────────────────────────────────────────────────
    if (TECHNICAL_PATTERNS.some(function (p) { return p.test(lower); })) {
      if (_profile.technicalDepth < 0.90) {
        _profile.technicalDepth = Math.min(0.90, _profile.technicalDepth + 0.02);
      }
    }

    // ── Serious-mode tracking ─────────────────────────────────────────────
    if (tone === 'sad' || tone === 'anxious' || SERIOUS_TOPIC_PATTERNS.some(function (p) { return p.test(lower); })) {
      _profile.seriousTurnCount++;
    }

    // Save periodically — every 5 turns to avoid excessive writes
    if (_profile.totalTurns % 5 === 0) {
      _save();
    }
  }

  // ─── Build system prompt personality addendum ────────────────────────────
  /**
   * getPersonalityPromptAddendum(personalityCtx)
   *
   * Returns a short instruction string to inject into the local model's
   * system prompt, shaping the personality of the response.
   *
   * This is specifically for the local model path. The deterministic path
   * uses the personality context object directly via analyzeTurn().
   */
  function getPersonalityPromptAddendum(personalityCtx) {
    if (!personalityCtx) return '';

    var parts = [];

    // Tone direction
    if (personalityCtx.seriousMode) {
      parts.push('Be direct and supportive. No humor right now.');
    } else if (personalityCtx.frustratedMode) {
      parts.push('The user is frustrated. Acknowledge it briefly, then focus on the problem. Light humor only if it naturally fits.');
    } else if (personalityCtx.technicalMode) {
      parts.push('Focus on the technical topic. Be clear and precise.');
    } else if (personalityCtx.playfulMode && personalityCtx.humorAppropriate) {
      parts.push('Match the user\'s relaxed energy. Conversational, smart, a little witty if it fits naturally.');
    } else {
      parts.push('Conversational, direct, and real — not robotic.');
    }

    // Length preference
    if (personalityCtx.preferredLength === 'short') {
      parts.push('Keep the response concise.');
    } else if (personalityCtx.preferredLength === 'long' || personalityCtx.technicalMode) {
      parts.push('Provide enough detail to actually be useful.');
    }

    // Humor
    if (personalityCtx.humorAppropriate && !personalityCtx.seriousMode) {
      parts.push('A light, natural touch of humor is welcome if the moment genuinely calls for it.');
    }

    // Casualness
    if (personalityCtx.casualness >= 0.70) {
      parts.push('The user communicates casually — match that register.');
    }

    return parts.join(' ');
  }

  // ─── Get assistant display name for current session ───────────────────────
  /**
   * getAssistantName()
   * Returns the currently selected assistant profile name.
   * Falls back to 'Shadow' if no profile is selected.
   */
  function getAssistantName() {
    var wm = global.SRWakeName;
    if (wm && typeof wm.getWakeName === 'function') {
      return wm.getWakeName();
    }
    return 'Shadow';
  }

  // ─── Reset profile ────────────────────────────────────────────────────────

  function resetProfile(callback) {
    _profile = Object.assign({}, DEFAULT_PROFILE);
    _recentTones = [];
    _writeLocal(_profile);
    var ref = _firestoreRef();
    if (ref) {
      ref.set(_profile, { merge: false }).then(function () {
        if (callback) callback(null);
      }).catch(function (err) {
        if (callback) callback(err);
      });
    } else {
      if (callback) callback(null);
    }
  }

  // ─── Status ───────────────────────────────────────────────────────────────

  function getStatus() {
    return {
      build:         BUILD_ID,
      loaded:        _loaded,
      profile:       _getProfile(),
      recentTones:   _recentTones.slice(),
      assistantName: getAssistantName(),
    };
  }

  // ─── Expose ───────────────────────────────────────────────────────────────

  global.SRPersonality = {
    build:                      BUILD_ID,
    load:                       load,
    analyzeTurn:                analyzeTurn,
    learnFromTurn:              learnFromTurn,
    getPersonalityPromptAddendum: getPersonalityPromptAddendum,
    getAssistantName:           getAssistantName,
    getProfile:                 _getProfile,
    resetProfile:               resetProfile,
    getStatus:                  getStatus,
  };

})(typeof window !== 'undefined' ? window : global);
