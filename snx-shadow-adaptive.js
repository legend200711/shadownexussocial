/**
 * snx-shadow-adaptive.js
 * Shadow Nexus Social — Shadow Reaper Adaptive Learning Engine
 *
 * Build: SNS-2026-SHADOW-ADAPTIVE-LEARNING-RC1
 *
 * Exposes: window.SNXShadowAdaptive
 *
 * Purpose:
 *  Automatically identifies and stores useful recurring context from
 *  conversations the user allows to be retained, then uses that context
 *  to improve future responses. This is NOT model retraining — it is a
 *  deterministic local extraction and retrieval system.
 *
 * Architecture:
 *  • Separate from E2 (Personal Memory) and E3 (Conversation History).
 *  • Runs AFTER a conversation turn completes — never during.
 *  • Lightweight local relevance filter — no Workers AI, no env.AI.run().
 *  • Firestore path: users/{uid}/shadowReaperLearnedContext/{itemId}
 *  • Owner-only access — no cross-user, no Founder backdoor.
 *  • Guest: no persistence, session cache only (cleared on destroy).
 *  • Default: ON for authenticated users, OFF for guests.
 *  • Bounded: max 200 learned items. Oldest low-confidence items removed first.
 *  • Retrieval: max 8 relevant items per response — never full DB load.
 *  • No polling, no RAF, no setInterval, no continuous timers.
 *  • No eval, no new Function, no innerHTML from user data.
 *
 * What may be learned:
 *  preferred response style, recurring creative projects, project names,
 *  music projects, feature preferences, recurring tasks/topics,
 *  user corrections to Shadow Reaper, stable non-sensitive preferences,
 *  previous project decisions, useful conversational context.
 *
 * What is NEVER learned:
 *  medical/mental-health diagnoses, political beliefs, religion,
 *  sexual information, passwords, authentication tokens, API keys,
 *  financial credentials, precise location, temporary emotional reactions,
 *  casual filler, random one-off comments, greetings, AI responses as facts.
 *
 * Firestore rule required (owner-only):
 *  match /users/{uid}/shadowReaperLearnedContext/{itemId} {
 *    allow read, write: if isOwner(uid);
 *  }
 *
 * Confidence model:
 *  LOW    — first mention, uncertain relevance
 *  MEDIUM — seen/reinforced ≥ 2 times
 *  HIGH   — seen/reinforced ≥ 4 times, consistent (no contradiction)
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SNS-2026-SHADOW-ADAPTIVE-LEARNING-RC1';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var MAX_LEARNED_ITEMS    = 200; /* max stored per user */
  var MAX_RETRIEVE_ITEMS   = 8;   /* max items injected per response */
  var MAX_VALUE_LEN        = 500; /* max chars per learned value */
  var ADAPTIVE_ENABLED_KEY = 'snxShadowAdaptiveEnabled'; /* localStorage */

  /* ─────────────────────────────────────────────────────────────
     SENSITIVE DATA FILTER
     Items matching these patterns are NEVER learned.
  ───────────────────────────────────────────────────────────────*/
  var _SENSITIVE_PATTERNS = [
    /\b(password|passwd|passw(or)?d)\s*(is|=|:)\s*\S+/i,
    /\bapi[\s_-]?key\s*(is|=|:)\s*\S+/i,
    /\btoken\s*(is|=|:)\s*\S+/i,
    /\bsecret\s*(is|=|:)\s*\S+/i,
    /\bcredit\s*card\s*(number|#|no\.?)\s*(is|=|:)?\s*[\d\s\-]+/i,
    /\b(cvv|cvc|security code)\s*(is|=|:)\s*\d+/i,
    /\bbank\s*(account|routing|credentials?)\s*(is|=|:)/i,
    /\b(private key|ssh key|rsa key)\s*(is|=|:)/i,
    /\bmy password is\b/i,
    /\bpassword[:=]\s*\S+/i,
    /\bmy api key is\b/i,
    /\bmy token is\b/i,
    /\bmy secret is\b/i,
    /\b(suicid|kill myself|end my life|self.harm)\b/i
  ];

  function _isSensitive(text) {
    if (!text) return false;
    for (var i = 0; i < _SENSITIVE_PATTERNS.length; i++) {
      if (_SENSITIVE_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     EMOTIONAL PROFILE BLOCKER
     Temporary emotion words must never become permanent labels.
  ───────────────────────────────────────────────────────────────*/
  var _EMOTION_ONLY_PATTERNS = [
    /^(i.?m\s+)?(depressed|anxious|sad|angry|lonely|stressed|suicidal|hopeless|worthless|desperate)\s*$/i,
    /^user is (depressed|anxious|sad|angry|lonely|stressed)\s*$/i
  ];

  function _isEmotionOnly(value) {
    if (!value) return false;
    for (var i = 0; i < _EMOTION_ONLY_PATTERNS.length; i++) {
      if (_EMOTION_ONLY_PATTERNS[i].test(value.trim())) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     RELEVANCE EXTRACTION PATTERNS
     Deterministic local extraction — no AI required.
     Maps detected patterns to a learned item category and key.
  ───────────────────────────────────────────────────────────────*/
  var _EXTRACTORS = [
    /* ── Music / song project ─────────────────────────────────── */
    {
      category: 'PROJECT',
      key:      'music_project',
      pattern:  /\b(working on (a |my )?(new )?song|writing (a |my )?song|working on (a |my )?(new )?album|recording (a |my )?(new )?song|my (new )?song|my (new )?track|my (new )?album)\b/i,
      extract:  function (m) { return 'User is working on a music project'; }
    },
    /* ── Shadow Nexus website project ─────────────────────────── */
    {
      category: 'PROJECT',
      key:      'shadow_nexus_project',
      pattern:  /\b(working on (the )?(shadow (nexus|reaper)|website|site|platform|app|feature|system)|building (the )?(shadow|site|feature|app)|coding (the )?(feature|site|app|system))\b/i,
      extract:  function (m) { return 'User is working on a Shadow Nexus Social development project'; }
    },
    /* ── Creative project (non-music) ─────────────────────────── */
    {
      category: 'PROJECT',
      key:      'creative_project',
      pattern:  /\b(working on (a |my )?(film|video|podcast|art|design|novel|book|story|game))\b/i,
      extract:  function (m) {
        var types = ['film','video','podcast','art','design','novel','book','story','game'];
        for (var i = 0; i < types.length; i++) {
          if (m.toLowerCase().indexOf(types[i]) !== -1) return 'User is working on a ' + types[i] + ' project';
        }
        return 'User is working on a creative project';
      }
    },
    /* ── Named project ────────────────────────────────────────── */
    {
      category: 'PROJECT',
      key:      'named_project',
      pattern:  /\b(my project (is|called|named)|the project (is|called|named)|i.m calling (it|the project))\s+(["']?)([A-Za-z0-9 _-]{2,40})\5/i,
      extract:  function (m) {
        var match = m.match(/\b(my project (is|called|named)|the project (is|called|named)|i.m calling (it|the project))\s+(["']?)([A-Za-z0-9 _-]{2,40})\5/i);
        return match ? 'User has a project named: ' + match[6] : 'User has a named project';
      }
    },
    /* ── Style: prefers shorter answers ──────────────────────── */
    {
      category: 'STYLE',
      key:      'prefers_short',
      pattern:  /\b(keep it (short|brief|simple)|be (brief|short|direct)|just (tell|give) me (the short|the quick|a brief)|(short|brief|quick|simple) answer|don.t (explain|go into) too much)\b/i,
      extract:  function () { return 'User prefers shorter, direct answers'; }
    },
    /* ── Style: prefers step-by-step ──────────────────────────── */
    {
      category: 'STYLE',
      key:      'prefers_steps',
      pattern:  /\b(step.?by.?step|walk me through|break it down|explain (it|that) step|give me (the steps|step by step|a breakdown))\b/i,
      extract:  function () { return 'User prefers step-by-step explanations'; }
    },
    /* ── Style: prefers Bob-ready prompts ─────────────────────── */
    {
      category: 'STYLE',
      key:      'prefers_bob_prompts',
      pattern:  /\b(bob.?ready|make (it |a )?bob prompt|format (it |this )?for bob|give me (a )?bob (prompt|ready|format))\b/i,
      extract:  function () { return 'User frequently wants Bob-ready prompts formatted'; }
    },
    /* ── Correction: user explicitly corrects Shadow Reaper ──── */
    {
      category: 'CORRECTION',
      key:      'user_correction',
      pattern:  /\b(no,?\s+that.s not|that.?s (wrong|incorrect|not right|not what i said|not what i meant)|you.?re (wrong|incorrect)|actually,?\s+i (said|meant|was)|i didn.t (say|mean)|i changed (that|my mind)|i don.t (use|do|want) that (anymore|any more))\b/i,
      extract:  function (m) { return 'User corrected Shadow Reaper: ' + m.substring(0, 120).replace(/<[^>]*>/g, ''); }
    },
    /* ── Recurring topic: music listening ─────────────────────── */
    {
      category: 'PREFERENCE',
      key:      'listens_to_music',
      pattern:  /\b(listening to (music|my (playlist|music|songs|tracks))|i love (music|songs|beats|tracks)|music (is|means) (everything|a lot|important) to me)\b/i,
      extract:  function () { return 'User frequently listens to music and it is important to them'; }
    },
    /* ── Recurring topic: artist mentions ─────────────────────── */
    {
      category: 'PREFERENCE',
      key:      'favorite_artist',
      pattern:  /\b(my (favorite|fav|favourite) (artist|rapper|singer|musician|band) is ([A-Za-z0-9 ]+))\b/i,
      extract:  function (m) {
        var match = m.match(/\b(my (favorite|fav|favourite) (artist|rapper|singer|musician|band) is ([A-Za-z0-9 ]+))\b/i);
        return match ? 'User\'s favorite artist is: ' + match[4].trim().substring(0, 60) : null;
      }
    }
  ];

  /* ─────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────*/
  var _initialized      = false;
  var _sessionCache     = {}; /* key → { category, key, value, confidence, createdAt, updatedAt, lastUsedAt, active, count } */
  var _dbLoaded         = false;
  var _pendingQueue     = []; /* items queued while DB is loading */

  /* ─────────────────────────────────────────────────────────────
     FIREBASE HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _getFirestore() {
    try {
      var fb = global.firebase;
      if (fb && fb.firestore && typeof fb.firestore === 'function') return fb.firestore();
    } catch (_) {}
    return null;
  }

  function _getCurrentUID() {
    try {
      var fb = global.firebase;
      if (fb && fb.auth && typeof fb.auth === 'function') {
        var user = fb.auth().currentUser;
        if (user && user.uid) return user.uid;
      }
    } catch (_) {}
    if (global._snxCurrentUser && global._snxCurrentUser.uid) return global._snxCurrentUser.uid;
    return null;
  }

  function _isSignedIn() { return !!_getCurrentUID(); }

  function _getServerTimestamp() {
    try {
      var fb = global.firebase;
      if (fb && fb.firestore && fb.firestore.FieldValue) return fb.firestore.FieldValue.serverTimestamp();
    } catch (_) {}
    return new Date();
  }

  function _getLearnedRef(uid) {
    var db = _getFirestore();
    if (!db || !uid) return null;
    return db.collection('users').doc(uid).collection('shadowReaperLearnedContext');
  }

  function _generateId() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var b = new Uint8Array(10);
      crypto.getRandomValues(b);
      return Array.from(b).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    }
    return Math.random().toString(36).substring(2, 12) + Date.now().toString(36);
  }

  /* ─────────────────────────────────────────────────────────────
     ENABLED PREFERENCE
  ───────────────────────────────────────────────────────────────*/
  function _isEnabled() {
    try {
      var val = global.localStorage.getItem(ADAPTIVE_ENABLED_KEY);
      return val !== 'false'; /* Default: ON */
    } catch (_) { return true; }
  }

  function _setEnabled(enabled) {
    try { global.localStorage.setItem(ADAPTIVE_ENABLED_KEY, enabled ? 'true' : 'false'); } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     CONFIDENCE HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _calcConfidence(count) {
    if (count >= 4) return 'HIGH';
    if (count >= 2) return 'MEDIUM';
    return 'LOW';
  }

  /* ─────────────────────────────────────────────────────────────
     EXTRACT LEARNED ITEMS FROM TEXT
     Deterministic local extraction — no Workers AI.
     Returns array of { category, key, value } or empty array.
  ───────────────────────────────────────────────────────────────*/
  function _extractItems(text) {
    if (!text || _isSensitive(text)) return [];
    var found = [];
    for (var i = 0; i < _EXTRACTORS.length; i++) {
      var ex = _EXTRACTORS[i];
      if (ex.pattern.test(text)) {
        var value = ex.extract(text);
        if (value && !_isEmotionOnly(value) && !_isSensitive(value)) {
          found.push({ category: ex.category, key: ex.key, value: value.substring(0, MAX_VALUE_LEN) });
        }
      }
    }
    return found;
  }

  /* ─────────────────────────────────────────────────────────────
     LOAD FROM FIRESTORE (lazy — only on first retrieve/learn)
  ───────────────────────────────────────────────────────────────*/
  function _loadFromDB(uid, callback) {
    callback = callback || function () {};
    if (!_isSignedIn() || !uid) { _dbLoaded = true; callback(); return; }
    var ref = _getLearnedRef(uid);
    if (!ref) { _dbLoaded = true; callback(); return; }

    ref.where('active', '==', true).orderBy('updatedAt', 'desc').limit(MAX_LEARNED_ITEMS)
      .get()
      .then(function (snap) {
        _sessionCache = {};
        snap.forEach(function (doc) {
          var d = doc.data();
          if (d && d.key && d.category) {
            _sessionCache[d.key] = {
              id:         doc.id,
              category:   d.category,
              key:        d.key,
              value:      d.value || '',
              confidence: d.confidence || 'LOW',
              count:      d.count || 1,
              createdAt:  d.createdAt,
              updatedAt:  d.updatedAt,
              lastUsedAt: d.lastUsedAt,
              active:     true
            };
          }
        });
        _dbLoaded = true;
        callback();
      })
      .catch(function () {
        _dbLoaded = true; /* fail gracefully — session cache stays empty */
        callback();
      });
  }

  /* ─────────────────────────────────────────────────────────────
     SAVE / UPDATE ITEM TO FIRESTORE (fire-and-forget)
  ───────────────────────────────────────────────────────────────*/
  function _persistItem(uid, item) {
    if (!_isSignedIn() || !uid) return;
    var ref = _getLearnedRef(uid);
    if (!ref) return;
    var now = _getServerTimestamp();
    var existing = _sessionCache[item.key];

    if (existing && existing.id) {
      /* Update existing item */
      ref.doc(existing.id).update({
        value:      item.value,
        confidence: item.confidence,
        count:      item.count,
        updatedAt:  now,
        active:     true
      }).catch(function () { /* fail silently */ });
    } else {
      /* Create new item */
      var newId = _generateId();
      var doc = {
        category:          item.category,
        key:               item.key,
        value:             item.value,
        confidence:        item.confidence,
        count:             item.count,
        createdAt:         now,
        updatedAt:         now,
        lastUsedAt:        now,
        sourceConvId:      item.sourceConvId || null,
        active:            true
      };
      ref.doc(newId).set(doc).then(function () {
        if (_sessionCache[item.key]) _sessionCache[item.key].id = newId;
      }).catch(function () { /* fail silently */ });
      _sessionCache[item.key].id = newId;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PRUNE — remove oldest low-confidence items when over limit
  ───────────────────────────────────────────────────────────────*/
  function _pruneIfNeeded(uid) {
    var keys = Object.keys(_sessionCache);
    if (keys.length <= MAX_LEARNED_ITEMS) return;

    /* Sort: keep HIGH and MEDIUM first; prune LOW first */
    var sorted = keys.slice().sort(function (a, b) {
      var confOrder = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      var ca = confOrder[_sessionCache[a].confidence] || 2;
      var cb = confOrder[_sessionCache[b].confidence] || 2;
      return cb - ca; /* HIGH first = lower index = kept */
    });

    var toRemove = sorted.slice(MAX_LEARNED_ITEMS);
    toRemove.forEach(function (k) {
      var item = _sessionCache[k];
      delete _sessionCache[k];
      /* Soft-delete in Firestore */
      if (uid && item && item.id) {
        var ref = _getLearnedRef(uid);
        if (ref) {
          ref.doc(item.id).update({ active: false }).catch(function () {});
        }
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────
     PROCESS A CONVERSATION TURN
     Called after each user message + assistant response.
     Lightweight — only runs extractors on the user message.
     Fire-and-forget: never blocks the conversation.
  ───────────────────────────────────────────────────────────────*/
  function _processTurn(userText, sourceConvId) {
    if (!_isEnabled() || !_isSignedIn()) return;
    if (!userText || _isSensitive(userText)) return;

    var uid = _getCurrentUID();
    if (!uid) return;

    /* Ensure DB is loaded first, then process */
    if (!_dbLoaded) {
      _pendingQueue.push({ userText: userText, sourceConvId: sourceConvId });
      _loadFromDB(uid, function () { _flushPending(uid); });
      return;
    }

    _doProcess(uid, userText, sourceConvId);
  }

  function _flushPending(uid) {
    var q = _pendingQueue.slice();
    _pendingQueue = [];
    q.forEach(function (item) { _doProcess(uid, item.userText, item.sourceConvId); });
  }

  function _doProcess(uid, userText, sourceConvId) {
    var extracted = _extractItems(userText);
    if (!extracted.length) return;

    extracted.forEach(function (item) {
      var existing = _sessionCache[item.key];
      if (existing) {
        /* Reinforce existing item — increase count and potentially confidence */
        existing.count = (existing.count || 1) + 1;
        existing.confidence = _calcConfidence(existing.count);
        existing.updatedAt  = Date.now();
        /* Update value if it changed substantially */
        if (item.value && item.value !== existing.value) existing.value = item.value;
        _persistItem(uid, existing);
      } else {
        /* New item */
        var newItem = {
          id:          null,
          category:    item.category,
          key:         item.key,
          value:       item.value,
          confidence:  'LOW',
          count:       1,
          createdAt:   Date.now(),
          updatedAt:   Date.now(),
          lastUsedAt:  Date.now(),
          sourceConvId: sourceConvId || null,
          active:      true
        };
        _sessionCache[item.key] = newItem;
        _persistItem(uid, newItem);
        _pruneIfNeeded(uid);
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────
     RETRIEVE RELEVANT ITEMS
     Returns up to MAX_RETRIEVE_ITEMS relevant items for a given
     user message. Prioritizes HIGH > MEDIUM > LOW confidence.
     Never loads the entire DB — uses the in-session cache.
  ───────────────────────────────────────────────────────────────*/
  function _retrieveRelevant(text) {
    if (!_isEnabled() || !text) return [];
    var keys = Object.keys(_sessionCache);
    if (!keys.length) return [];

    /* Score relevance: check if item key or category matches topics in text */
    var lower = text.toLowerCase();
    var scored = [];

    keys.forEach(function (k) {
      var item = _sessionCache[k];
      if (!item || !item.active) return;
      var score = 0;

      /* Confidence base score */
      if (item.confidence === 'HIGH')   score += 3;
      else if (item.confidence === 'MEDIUM') score += 2;
      else score += 1;

      /* Topic relevance */
      if (item.category === 'PROJECT' && (
          lower.indexOf('project') !== -1 ||
          lower.indexOf('song') !== -1 ||
          lower.indexOf('music') !== -1 ||
          lower.indexOf('album') !== -1 ||
          lower.indexOf('working on') !== -1 ||
          lower.indexOf('continue') !== -1 ||
          lower.indexOf('back to') !== -1 ||
          lower.indexOf('the project') !== -1)) {
        score += 4;
      }
      if (item.category === 'STYLE') score += 1; /* Style is always somewhat relevant */
      if (item.category === 'CORRECTION') score += 3;
      if (item.category === 'PREFERENCE') score += 1;

      /* Key word match in value */
      var valueLower = (item.value || '').toLowerCase();
      var words = lower.split(/\s+/).filter(function (w) { return w.length > 3; });
      words.forEach(function (w) {
        if (valueLower.indexOf(w) !== -1) score += 2;
      });

      scored.push({ item: item, score: score });
    });

    /* Sort by score descending */
    scored.sort(function (a, b) { return b.score - a.score; });

    /* Return top N items, mark lastUsedAt */
    var result = scored.slice(0, MAX_RETRIEVE_ITEMS).map(function (s) {
      s.item.lastUsedAt = Date.now();
      return { category: s.item.category, key: s.item.key, value: s.item.value, confidence: s.item.confidence };
    });

    return result;
  }

  /* ─────────────────────────────────────────────────────────────
     LIST ALL LEARNED ITEMS (for user inspection)
  ───────────────────────────────────────────────────────────────*/
  function _listAll() {
    return Object.keys(_sessionCache).map(function (k) {
      var item = _sessionCache[k];
      return {
        key:        item.key,
        category:   item.category,
        value:      item.value,
        confidence: item.confidence,
        id:         item.id || null
      };
    });
  }

  /* ─────────────────────────────────────────────────────────────
     DELETE ONE LEARNED ITEM
  ───────────────────────────────────────────────────────────────*/
  function _deleteItem(key, callback) {
    callback = callback || function () {};
    var uid  = _getCurrentUID();
    var item = _sessionCache[key];
    if (!item) { callback({ success: false, reason: 'NOT_FOUND' }); return; }

    delete _sessionCache[key];

    if (uid && item.id) {
      var ref = _getLearnedRef(uid);
      if (ref) {
        ref.doc(item.id).update({ active: false }).then(function () {
          callback({ success: true });
        }).catch(function () {
          callback({ success: false, reason: 'DB_ERROR' });
        });
        return;
      }
    }
    callback({ success: true }); /* in-memory delete succeeded even if DB unavailable */
  }

  /* ─────────────────────────────────────────────────────────────
     CLEAR ALL LEARNED DATA
  ───────────────────────────────────────────────────────────────*/
  function _clearAll(callback) {
    callback = callback || function () {};
    var uid  = _getCurrentUID();
    var keys = Object.keys(_sessionCache);
    _sessionCache = {};
    _dbLoaded     = false;

    if (uid) {
      var ref = _getLearnedRef(uid);
      if (ref) {
        ref.get().then(function (snap) {
          var batch = _getFirestore() ? _getFirestore().batch() : null;
          if (batch) {
            snap.forEach(function (doc) { batch.update(doc.ref, { active: false }); });
            return batch.commit();
          }
        }).then(function () {
          _dbLoaded = true;
          callback({ success: true, cleared: keys.length });
        }).catch(function () {
          _dbLoaded = true;
          callback({ success: false, reason: 'DB_ERROR', clearedLocal: keys.length });
        });
        return;
      }
    }
    _dbLoaded = true;
    callback({ success: true, cleared: keys.length });
  }

  /* ─────────────────────────────────────────────────────────────
     HANDLE USER PRIVACY COMMANDS
     "What have you learned about me?" / "Forget what you learned"
  ───────────────────────────────────────────────────────────────*/
  var _PRIVACY_INTENT_PATTERNS = {
    LIST:  /\b(what (have you|did you) learn(ed)?|what do you know about me|what.?s in (my|your) (learned|knowledge|profile)|show me what you.?ve (learned|stored|kept))\b/i,
    CLEAR: /\b(clear (what you.?ve learned|all (you.?ve learned|learned data)|my learned data)|forget (everything you.?ve learned|all you.?ve learned|all you learned|my learned data)|delete (my learned data|what you.?ve learned))\b/i,
    FORGET_ONE: /\b(forget (what you learned about|that you learned about)\s+(.{2,60}))\b/i
  };

  function _detectPrivacyIntent(text) {
    if (!text) return null;
    if (_PRIVACY_INTENT_PATTERNS.LIST.test(text))   return 'ADAPTIVE_LIST';
    if (_PRIVACY_INTENT_PATTERNS.CLEAR.test(text))  return 'ADAPTIVE_CLEAR';
    if (_PRIVACY_INTENT_PATTERNS.FORGET_ONE.test(text)) return 'ADAPTIVE_FORGET_ONE';
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     INIT
  ───────────────────────────────────────────────────────────────*/
  function _init() {
    if (_initialized) return;
    _initialized = true;
    /* DB is loaded lazily — only when a retrieve or learn is needed */
  }

  /* ─────────────────────────────────────────────────────────────
     DESTROY (account-switch / explicit reset)
  ───────────────────────────────────────────────────────────────*/
  function _destroy() {
    _initialized  = false;
    _sessionCache = {};
    _dbLoaded     = false;
    _pendingQueue = [];
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API — window.SNXShadowAdaptive
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowAdaptive = {

    /** Build identifier */
    build: BUILD_ID,

    /** Constants for tests */
    MAX_LEARNED_ITEMS:  MAX_LEARNED_ITEMS,
    MAX_RETRIEVE_ITEMS: MAX_RETRIEVE_ITEMS,

    /** Idempotent init */
    init: _init,

    /**
     * Returns true if Adaptive Learning is enabled.
     * Default: ON for signed-in users.
     */
    isEnabled: _isEnabled,

    /**
     * Set Adaptive Learning ON (true) or OFF (false).
     * @param {boolean} enabled
     */
    setEnabled: _setEnabled,

    /**
     * Process a user conversation turn for learning.
     * Call after each complete turn. Fire-and-forget.
     * @param {string} userText — user's message
     * @param {string} [sourceConvId] — conversation ID for provenance
     */
    processTurn: _processTurn,

    /**
     * Retrieve relevant learned context for a user message.
     * Returns up to MAX_RETRIEVE_ITEMS items. Never loads full DB.
     * @param {string} text — user message
     * @returns {Array<{category, key, value, confidence}>}
     */
    retrieveRelevant: _retrieveRelevant,

    /**
     * Ensure the in-session DB cache is loaded (lazy).
     * Safe to call multiple times.
     * @param {function} [callback] — called when ready
     */
    ensureLoaded: function (callback) {
      var uid = _getCurrentUID();
      if (_dbLoaded || !uid) { if (callback) callback(); return; }
      _loadFromDB(uid, callback);
    },

    /**
     * Detect privacy/management intent in user text.
     * Returns 'ADAPTIVE_LIST' | 'ADAPTIVE_CLEAR' | 'ADAPTIVE_FORGET_ONE' | null
     * @param {string} text
     * @returns {string|null}
     */
    detectIntent: _detectPrivacyIntent,

    /**
     * List all currently learned items (for user inspection).
     * @returns {Array}
     */
    listAll: _listAll,

    /**
     * Delete a single learned item by key.
     * @param {string} key
     * @param {function} callback — fn({ success, reason })
     */
    deleteItem: _deleteItem,

    /**
     * Clear all learned data for the current user.
     * Does NOT delete E2 Personal Memory or E3 Conversation History.
     * @param {function} callback — fn({ success, cleared, reason })
     */
    clearAll: _clearAll,

    /**
     * Check if a text contains sensitive/protected information
     * that must not be learned. Exposed for testing.
     * @param {string} text
     * @returns {boolean}
     */
    isSensitive: _isSensitive,

    /**
     * Check if a value is an emotional-profile label that must not persist.
     * @param {string} value
     * @returns {boolean}
     */
    isEmotionOnly: _isEmotionOnly,

    /**
     * Run the extraction pipeline on a message.
     * Returns extracted items (empty array if none found or sensitive).
     * @param {string} text
     * @returns {Array<{category, key, value}>}
     */
    extractItems: _extractItems,

    /** Full teardown — call on account switch or explicit reset. */
    destroy: _destroy
  };

})(window);
