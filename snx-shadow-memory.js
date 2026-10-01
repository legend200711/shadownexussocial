/**
 * snx-shadow-memory.js
 * Shadow Nexus Social — Shadow Reaper E2: Optional Personal Memory
 *
 * Build: SNS-2026-SHADOW-MEMORY-E2-RC2
 *
 * Exposes: window.SNXShadowMemory
 *
 * Design:
 *  • Isolated module — does NOT modify the locked core or E1.
 *  • Persistent personal memory for signed-in users ONLY.
 *  • Explicit user-controlled storage. Nothing automatic.
 *  • Firebase path: users/{uid}/shadowReaperMemories/{memoryId}
 *  • 250 active memory limit per user.
 *  • 500-char maximum per memory content.
 *  • Deterministic SAVE / RECALL / FORGET / LIST — no Workers AI required.
 *  • Secret / credential detection — refuses to store sensitive info.
 *  • Memory ON/OFF per user (stored in localStorage — preference only).
 *  • Guest mode: persistent memory not available; explains naturally.
 *  • No polling, no RAF, no setInterval, no continuous timers.
 *  • No eval, no new Function, no innerHTML from user data.
 *  • Server-authoritative timestamps via Firebase serverTimestamp().
 *
 * Categories: PREFERENCE | PROJECT | TASK | SHOPPING | CREATIVE | PERSONAL | GENERAL
 *
 * Firebase rule required (minimal addition — see spec §30):
 *   match /users/{uid}/shadowReaperMemories/{memoryId} {
 *     allow read, write: if request.auth != null && request.auth.uid == uid;
 *   }
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SNS-2026-SHADOW-MEMORY-E2-RC2';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var MAX_MEMORIES     = 250;   // per-user active memory limit
  var MAX_CONTENT_LEN  = 500;   // max characters per memory content
  var MAX_RESULTS      = 10;    // max recall results returned

  var MEMORY_ENABLED_KEY = 'snxShadowMemoryEnabled'; // localStorage key

  /* Memory categories */
  var CATEGORY = {
    PREFERENCE: 'PREFERENCE',
    PROJECT:    'PROJECT',
    TASK:       'TASK',
    SHOPPING:   'SHOPPING',
    CREATIVE:   'CREATIVE',
    PERSONAL:   'PERSONAL',
    GENERAL:    'GENERAL'
  };

  /* ─────────────────────────────────────────────────────────────
     SECRET / CREDENTIAL DETECTION
     Refuses to save passwords, tokens, API keys, etc.
  ───────────────────────────────────────────────────────────────*/
  var _SECRET_PATTERNS = [
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
    /\bmy (auth|authentication) (token|key|credential)/i,
    /\bsecurity (question|answer)\s*(is|=|:)/i
  ];

  function _isSecret(text) {
    if (!text) return false;
    for (var i = 0; i < _SECRET_PATTERNS.length; i++) {
      if (_SECRET_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     MEMORY INTENT DETECTION
     Deterministic — no Workers AI required.
     Returns: MEMORY_SAVE | MEMORY_RECALL | MEMORY_FORGET | MEMORY_LIST | null
  ───────────────────────────────────────────────────────────────*/
  var _SAVE_PATTERNS = [
    /^\s*(remember\s+(that\s+|about\s+)?|save this[:\s]|keep this in mind[:\s]?)/i,
    /^\s*don'?t forget (that\s+)/i,
    /\bremember (that |about )?i\b/i,
    /\bremember (that )?my\b/i,
    /\bremember (that )?i('m| am| need| have| want| like| love| hate| prefer| work)/i,
    /\bplease remember\b/i,
    /\bmake a note (that|:)/i,
    /\bnote (that|:)/i
  ];

  var _RECALL_PATTERNS = [
    /\bwhat (do you remember|did i (tell|say|mention)|was (i|on my)|were (we|on))\b/i,
    /\bdo you remember (about|what|my|if)\b/i,
    /\bwhat('s| is| was)? (on my shopping list|i (working on|supposed to (get|buy|do))|my (project|task|reminder|note|preference|shopping)|i said about)\b/i,
    /\bwhat (colors?|colour?) did i (tell|say|mention|like)/i,
    /\bwhat (songs?|track|album|music) (was|were|am) i working on\b/i,
    /\bwhat did i need (from (the )?store|to (get|buy|do))\b/i,
    /\bwhat (do|did) i (like|prefer|want|need|have)\b/i,
    /\bremind me (what|about)\b/i,
    /\bwhat (have|did) (you remember|i told you)\b/i
  ];

  var _FORGET_ALL_PATTERNS = [
    /\bforget everything (you remember about me|i('?ve)? told you|about me)\b/i,
    /\bclear all (my )?memories\b/i,
    /\bdelete all (my )?memories\b/i,
    /\bremove all (my )?memories\b/i,
    /\bwipe (my )?(shadow reaper )?memory\b/i,
    /\breset (my )?(shadow reaper )?memory\b/i
  ];

  var _FORGET_PATTERNS = [
    /\bforget (that\s+)?i (said|told you|mentioned)\b/i,
    /\bforget (that|what i said about|about)\b/i,
    /\bdon'?t remember (that|what)\b/i,
    /\bremove (that |the )?memory\b/i,
    /\bdelete (that |the )?memory\b/i,
    /^forget\b/i
  ];

  var _LIST_PATTERNS = [
    /\bwhat do you remember about me\b/i,
    /\bshow (my|all) memories\b/i,
    /\blist (my|all) memories\b/i,
    /\bwhat (have you |do you )?remember(ed)?\b.*\bme\b/i,
    /\bshow me what you (know|remember) about me\b/i
  ];

  /**
   * Detect memory intent from a message.
   * Returns: 'MEMORY_SAVE' | 'MEMORY_RECALL' | 'MEMORY_FORGET_ALL' |
   *          'MEMORY_FORGET' | 'MEMORY_LIST' | null
   */
  /* Explicit forget-command patterns that must be checked BEFORE RECALL,
     because "forget what I said about X" contains "what I said" which
     would otherwise match a RECALL pattern. */
  var _FORGET_EXPLICIT = [
    /^\s*forget\b/i,                         /* Starts with "forget" */
    /\bforget (that|what i said about|about)\b/i,
    /\bdon'?t remember (that|what)\b/i,
    /\bremove (that |the )?memory\b/i,
    /\bdelete (that |the )?memory\b/i,
    /\bforget (that\s+)?i (said|told you|mentioned)\b/i
  ];

  function detectMemoryIntent(text) {
    if (!text) return null;
    var t = text.trim();

    /* FORGET_ALL checked first */
    for (var i = 0; i < _FORGET_ALL_PATTERNS.length; i++) {
      if (_FORGET_ALL_PATTERNS[i].test(t)) return 'MEMORY_FORGET_ALL';
    }

    /* "Don't forget that [content]" = SAVE (must run before FORGET_EXPLICIT) */
    if (/^\s*don'?t forget (that\s+)/i.test(t)) return 'MEMORY_SAVE';

    /* FORGET_EXPLICIT before RECALL — "forget what I said about X",
       "forget that I need batteries", "remove that memory", etc. */
    for (var fe = 0; fe < _FORGET_EXPLICIT.length; fe++) {
      if (_FORGET_EXPLICIT[fe].test(t)) return 'MEMORY_FORGET';
    }

    /* LIST before RECALL — "What do you remember about me?" */
    for (var l = 0; l < _LIST_PATTERNS.length; l++) {
      if (_LIST_PATTERNS[l].test(t)) return 'MEMORY_LIST';
    }

    /* RECALL before SAVE — interrogative "Do you remember..." must not match SAVE */
    for (var m = 0; m < _RECALL_PATTERNS.length; m++) {
      if (_RECALL_PATTERNS[m].test(t)) return 'MEMORY_RECALL';
    }

    /* SAVE — "Remember...", "Save this...", "Keep this in mind...", "Note that..." */
    for (var k = 0; k < _SAVE_PATTERNS.length; k++) {
      if (_SAVE_PATTERNS[k].test(t)) return 'MEMORY_SAVE';
    }

    /* FORGET — remaining patterns */
    for (var j = 0; j < _FORGET_PATTERNS.length; j++) {
      if (_FORGET_PATTERNS[j].test(t)) return 'MEMORY_FORGET';
    }

    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     CATEGORY DETECTION
     Lightweight deterministic category selection.
  ───────────────────────────────────────────────────────────────*/
  var _CATEGORY_PATTERNS = [
    /* TASK before SHOPPING — "need to call" is a task, not shopping */
    { cat: CATEGORY.TASK,       pat: /\b(need to|have to|must|todo|to do|task|appointment|meeting|deadline|due|call|reminder)\b/i },
    /* PREFERENCE before CREATIVE — "prefer jazz music" is a preference */
    { cat: CATEGORY.PREFERENCE, pat: /\b(like|love|prefer|favorite|favourite|enjoy|hate|dislike|rather|color|colour|food|music genre|style)\b/i },
    { cat: CATEGORY.SHOPPING,   pat: /\b(get|buy|pick up|grab|grocery|groceries|shopping (list|trip)|from the store|at the store)\b/i },
    { cat: CATEGORY.PROJECT,    pat: /\b(working on|project|building|developing|making|creating|my (app|site|website|game|book|album|film|show|series))\b/i },
    { cat: CATEGORY.CREATIVE,   pat: /\b(song|track|album|lyrics|melody|beat|art|design|drawing|writing|poem|painting|creative)\b/i },
    { cat: CATEGORY.PERSONAL,   pat: /\b(my name|i('m| am)|my (age|birthday|job|work|family|partner|dog|cat|pet|home|city|country))\b/i }
  ];

  function _detectCategory(content) {
    if (!content) return CATEGORY.GENERAL;
    for (var i = 0; i < _CATEGORY_PATTERNS.length; i++) {
      if (_CATEGORY_PATTERNS[i].pat.test(content)) {
        return _CATEGORY_PATTERNS[i].cat;
      }
    }
    return CATEGORY.GENERAL;
  }

  /* ─────────────────────────────────────────────────────────────
     CONTENT EXTRACTION
     Extract the memory content from a save command.
  ───────────────────────────────────────────────────────────────*/
  var _SAVE_PREFIXES = [
    /^\s*remember that\s*/i,
    /^\s*remember about\s*/i,
    /^\s*remember\s*/i,
    /^\s*save this:\s*/i,
    /^\s*save this\s*/i,
    /^\s*keep this in mind:\s*/i,
    /^\s*keep this in mind\s*/i,
    /^\s*don'?t forget that\s*/i,
    /^\s*don'?t forget\s*/i,
    /^\s*please remember\s*/i,
    /^\s*make a note that\s*/i,
    /^\s*make a note:\s*/i,
    /^\s*note that\s*/i,
    /^\s*note:\s*/i
  ];

  function _extractContent(text) {
    var t = text.trim();
    for (var i = 0; i < _SAVE_PREFIXES.length; i++) {
      if (_SAVE_PREFIXES[i].test(t)) {
        var extracted = t.replace(_SAVE_PREFIXES[i], '').trim();
        if (extracted.length > 0) return extracted;
      }
    }
    return t;
  }

  /* ─────────────────────────────────────────────────────────────
     CONTENT NORMALIZATION
     For duplicate detection and keyword search.
  ───────────────────────────────────────────────────────────────*/
  function _normalize(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .replace(/['''""]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ─────────────────────────────────────────────────────────────
     CONTENT SANITIZATION
     Sanitize content to prevent script injection.
     Returns safe text — no HTML, no executable content.
  ───────────────────────────────────────────────────────────────*/
  function _sanitize(text) {
    if (!text) return '';
    /* Strip any HTML tags */
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/</g, '')
      .replace(/>/g, '')
      .trim();
  }

  /* ─────────────────────────────────────────────────────────────
     FIREBASE HELPERS
     Get Firestore instance from existing window globals.
     Does NOT create a new Firebase app.
  ───────────────────────────────────────────────────────────────*/
  function _getFirestore() {
    /* Primary: use the compat bridge exposed by index.html (modular SDK v12) */
    if (global._snxDbCompat) return global._snxDbCompat;
    /* Fallback: legacy Firebase Compat SDK (not present in this project, kept for safety) */
    try {
      var fb = global.firebase;
      if (fb && fb.firestore && typeof fb.firestore === 'function') {
        return fb.firestore();
      }
    } catch (_) {}
    return null;
  }

  function _getCurrentUID() {
    /* Primary: modular Auth instance exposed by index.html */
    try {
      if (global._snxAuth && global._snxAuth.currentUser && global._snxAuth.currentUser.uid) {
        return global._snxAuth.currentUser.uid;
      }
    } catch (_) {}
    /* Fallback: SNS auth state global */
    if (global._snxCurrentUser && global._snxCurrentUser.uid) {
      return global._snxCurrentUser.uid;
    }
    /* Legacy Firebase Compat SDK (not present in this project, kept for safety) */
    try {
      var fb = global.firebase;
      if (fb && fb.auth && typeof fb.auth === 'function') {
        var user = fb.auth().currentUser;
        if (user && user.uid) return user.uid;
      }
    } catch (_) {}
    return null;
  }

  function _isSignedIn() {
    return !!_getCurrentUID();
  }

  function _getMemoriesRef(uid) {
    var db = _getFirestore();
    if (!db || !uid) return null;
    return db.collection('users').doc(uid).collection('shadowReaperMemories');
  }

  function _getServerTimestamp() {
    /* Primary: compat bridge exposes FieldValue via _snxDbCompat.firestore.FieldValue */
    try {
      if (global._snxDbCompat && global._snxDbCompat.firestore &&
          global._snxDbCompat.firestore.FieldValue) {
        return global._snxDbCompat.firestore.FieldValue.serverTimestamp();
      }
    } catch (_) {}
    /* Fallback: modular serverTimestamp from _snxFirestore */
    try {
      if (global._snxFirestore && typeof global._snxFirestore.serverTimestamp === 'function') {
        return global._snxFirestore.serverTimestamp();
      }
    } catch (_) {}
    /* Legacy Firebase Compat SDK (not present in this project, kept for safety) */
    try {
      var fb = global.firebase;
      if (fb && fb.firestore && fb.firestore.FieldValue) {
        return fb.firestore.FieldValue.serverTimestamp();
      }
    } catch (_) {}
    return new Date();
  }

  /* ─────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────*/
  var _initialized      = false;

  /* Pending FORGET_ALL confirmation: { pending: true, uid: string } */
  var _pendingForgetAll = null;

  /* ─────────────────────────────────────────────────────────────
     MEMORY ENABLED PREFERENCE
     Stored in localStorage as a user preference flag.
     Not auth-sensitive — just a preference.
  ───────────────────────────────────────────────────────────────*/
  function _isEnabled() {
    try {
      var val = global.localStorage.getItem(MEMORY_ENABLED_KEY);
      /* Default: enabled (null → true) */
      return val !== 'false';
    } catch (_) {
      return true;
    }
  }

  function _setEnabled(enabled) {
    try {
      global.localStorage.setItem(MEMORY_ENABLED_KEY, enabled ? 'true' : 'false');
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     DUPLICATE DETECTION
     Returns true if a memory with identical/near-identical
     normalized content already exists in the provided list.
  ───────────────────────────────────────────────────────────────*/
  function _isDuplicate(normalizedContent, memories) {
    if (!memories || !memories.length) return false;
    for (var i = 0; i < memories.length; i++) {
      var m = memories[i];
      if (!m.active) continue;
      if (m.normalizedContent === normalizedContent) return true;
      /* Near-duplicate: one is a substring of the other */
      if (normalizedContent.length > 8 && m.normalizedContent &&
          (m.normalizedContent.indexOf(normalizedContent) !== -1 ||
           normalizedContent.indexOf(m.normalizedContent) !== -1)) {
        return true;
      }
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     KEYWORD SEARCH
     Lightweight relevance scoring for recall.
  ───────────────────────────────────────────────────────────────*/
  function _scoreMemory(memory, queryNorm, queryWords, category) {
    if (!memory || !memory.active) return 0;
    var score = 0;
    var nc = memory.normalizedContent || '';

    /* Category match */
    if (category && memory.category === category) score += 5;

    /* Exact phrase in normalized content */
    if (queryNorm.length > 3 && nc.indexOf(queryNorm) !== -1) score += 10;

    /* Word-level matching */
    for (var i = 0; i < queryWords.length; i++) {
      var w = queryWords[i];
      if (w.length < 3) continue; /* Skip very short words */
      if (nc.indexOf(w) !== -1) score += 2;
    }

    return score;
  }

  /* Extract category hint from a recall query */
  function _queryCategory(text) {
    var lower = text.toLowerCase();
    if (/shopping|store|grocery|groceries|need (to get|to buy)/.test(lower)) return CATEGORY.SHOPPING;
    if (/song|music|track|album|creative|art/.test(lower)) return CATEGORY.CREATIVE;
    if (/project|working on|building/.test(lower)) return CATEGORY.PROJECT;
    if (/task|todo|need to do|appointment/.test(lower)) return CATEGORY.TASK;
    if (/prefer|favorite|favourite|like|color|colour/.test(lower)) return CATEGORY.PREFERENCE;
    if (/personal|about me/.test(lower)) return CATEGORY.PERSONAL;
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     FORGET MATCH
     Find the best matching memory for a forget command.
  ───────────────────────────────────────────────────────────────*/
  function _extractForgetSubject(text) {
    var t = text.trim();
    var cleaned = t
      .replace(/^\s*forget (that\s+|about\s+|what i said about\s+)?/i, '')
      .replace(/^\s*don'?t remember (that\s+)?/i, '')
      .replace(/^\s*remove (that |the )?memory\s*/i, '')
      .replace(/^\s*delete (that |the )?memory\s*/i, '')
      .trim();
    if (cleaned.length < 2) return null;
    return cleaned;
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────*/

  /**
   * init() — Idempotent. Safe to call multiple times.
   */
  function init() {
    if (_initialized) return;
    _initialized = true;
    /* [ShadowMemoryDebug] initialization started */
    console.log('[ShadowMemoryDebug] initialization started');
    var _dbOk  = !!_getFirestore();
    var _uidOk = !!_getCurrentUID();
    console.log('[ShadowMemoryDebug] SNXShadowMemory exists: true');
    console.log('[ShadowMemoryDebug] init function exists: true');
    console.log('[ShadowMemoryDebug] Firebase app available: ' + !!(global._snxApp || global.firebase));
    console.log('[ShadowMemoryDebug] Auth available: ' + !!(global._snxAuth || (global.firebase && global.firebase.auth)));
    console.log('[ShadowMemoryDebug] auth.currentUser available: ' + !!(global._snxAuth && global._snxAuth.currentUser));
    console.log('[ShadowMemoryDebug] UID available: ' + _uidOk);
    console.log('[ShadowMemoryDebug] Firestore available: ' + _dbOk);
    if (!_dbOk) {
      console.error('[ShadowMemoryDebug] _getFirestore() returned null — _snxDbCompat=' + (typeof global._snxDbCompat) + ', window.firebase=' + (typeof global.firebase));
    }
    if (!_uidOk) {
      console.error('[ShadowMemoryDebug] _getCurrentUID() returned null — _snxAuth.currentUser=' + (global._snxAuth && global._snxAuth.currentUser ? 'SET' : 'NULL') + ', _snxCurrentUser=' + (global._snxCurrentUser ? 'SET' : 'NULL'));
    }
    console.log('[ShadowMemoryDebug] initialization completed');
  }

  /**
   * isEnabled() — Returns whether persistent memory is currently ON.
   * @returns {boolean}
   */
  function isEnabled() {
    return _isEnabled();
  }

  /**
   * setEnabled(bool) — Turn persistent memory ON or OFF.
   * When OFF: new saves blocked; existing memories not deleted; recall disabled.
   * @param {boolean} enabled
   */
  function setEnabled(enabled) {
    _setEnabled(!!enabled);
  }

  /**
   * save(text, callback) — Save a memory for the current signed-in user.
   *
   * callback(result) where result:
   *   { success: true, message: string, memory: object }
   *   { success: false, message: string, reason: string }
   *
   * @param {string}   text     — raw user message (the "Remember..." command)
   * @param {function} callback
   */
  function save(text, callback) {
    callback = callback || function () {};

    /* Guest check */
    if (!_isSignedIn()) {
      callback({
        success: false,
        message: "Persistent memory requires being signed in. I can hold context for this conversation, but I won't be able to save it permanently until you're signed in.",
        reason: 'GUEST'
      });
      return;
    }

    /* Memory disabled check */
    if (!_isEnabled()) {
      callback({
        success: false,
        message: "Memory is currently turned off. You can turn it back on in my settings.",
        reason: 'DISABLED'
      });
      return;
    }

    /* Offline check */
    if (!global.navigator.onLine) {
      callback({
        success: false,
        message: "I can't save that memory right now — you appear to be offline. Persistent memory requires a connection.",
        reason: 'OFFLINE'
      });
      return;
    }

    /* Extract content */
    var content = _sanitize(_extractContent(text));
    if (!content || content.length < 2) {
      callback({
        success: false,
        message: "I couldn't find anything to save from that.",
        reason: 'EMPTY'
      });
      return;
    }

    /* Length bound */
    if (content.length > MAX_CONTENT_LEN) {
      content = content.substring(0, MAX_CONTENT_LEN);
    }

    /* Secret / credential detection */
    if (_isSecret(text) || _isSecret(content)) {
      callback({
        success: false,
        message: "I won't save that — Shadow Reaper personal memory shouldn't be used to store passwords, tokens, API keys, or other sensitive credentials. For password management, use a dedicated password manager.",
        reason: 'SECRET'
      });
      return;
    }

    var uid = _getCurrentUID();
    var ref = _getMemoriesRef(uid);
    if (!ref) {
      callback({
        success: false,
        message: "I couldn't save that memory right now. Please try again.",
        reason: 'DB_UNAVAILABLE'
      });
      return;
    }

    var normalizedContent = _normalize(content);
    var category = _detectCategory(content);

    /* Check limit and duplicates — query active memories */
    ref.where('active', '==', true).limit(MAX_MEMORIES + 1).get()
      .then(function (snapshot) {
        var memories = [];
        snapshot.forEach(function (doc) {
          memories.push(Object.assign({ id: doc.id }, doc.data()));
        });

        /* Duplicate check */
        if (_isDuplicate(normalizedContent, memories)) {
          callback({
            success: true,
            message: "I already have that saved.",
            reason: 'DUPLICATE',
            duplicate: true
          });
          return;
        }

        /* Limit check */
        if (memories.length >= MAX_MEMORIES) {
          callback({
            success: false,
            message: "Your memory storage is full (" + MAX_MEMORIES + " memories). To save new ones, remove some old ones first.",
            reason: 'LIMIT'
          });
          return;
        }

        /* Save the memory */
        var memDoc = {
          category:         category,
          content:          content,
          normalizedContent: normalizedContent,
          createdAt:        _getServerTimestamp(),
          updatedAt:        _getServerTimestamp(),
          source:           'user_explicit',
          active:           true
        };

        ref.add(memDoc)
          .then(function (docRef) {
            var saved = Object.assign({ id: docRef.id }, memDoc);
            /* Build confirmation message */
            var msg = _buildSaveConfirmation(content, category);
            callback({ success: true, message: msg, memory: saved });
          })
          .catch(function (err) {
            callback({
              success: false,
              message: "I couldn't save that memory right now. Please try again.",
              reason: 'DB_ERROR',
              error: err ? err.message : 'unknown'
            });
          });
      })
      .catch(function (err) {
        callback({
          success: false,
          message: "I couldn't save that memory right now. Please try again.",
          reason: 'DB_ERROR',
          error: err ? err.message : 'unknown'
        });
      });
  }

  function _buildSaveConfirmation(content, category) {
    var lower = content.toLowerCase();
    /* Tailor the response to what was saved */
    if (category === CATEGORY.SHOPPING) {
      return "Got it. I'll remember that for your shopping list.";
    }
    if (category === CATEGORY.PROJECT || category === CATEGORY.CREATIVE) {
      return "Saved. I'll remember that you're working on that.";
    }
    if (content.length < 60) {
      return "Got it. I'll remember that.";
    }
    return "Saved.";
  }

  /**
   * recall(query, callback) — Search memories for the current user.
   *
   * callback(result):
   *   { success: true, memories: array, message: string }
   *   { success: false, message: string, reason: string }
   *
   * @param {string}   query
   * @param {function} callback
   */
  function recall(query, callback) {
    callback = callback || function () {};

    if (!_isSignedIn()) {
      callback({ success: false, message: "You need to be signed in to access saved memories.", reason: 'GUEST' });
      return;
    }

    if (!_isEnabled()) {
      callback({ success: false, message: "Memory is currently turned off.", reason: 'DISABLED' });
      return;
    }

    var uid = _getCurrentUID();
    var ref = _getMemoriesRef(uid);
    if (!ref) {
      callback({ success: false, message: "Memory unavailable right now.", reason: 'DB_UNAVAILABLE' });
      return;
    }

    ref.where('active', '==', true).limit(MAX_MEMORIES).get()
      .then(function (snapshot) {
        var memories = [];
        snapshot.forEach(function (doc) {
          memories.push(Object.assign({ id: doc.id }, doc.data()));
        });

        if (!memories.length) {
          callback({ success: true, memories: [], message: "I don't have any saved memories for you yet." });
          return;
        }

        var queryNorm  = _normalize(query || '');
        var queryWords = queryNorm.split(' ').filter(function (w) { return w.length >= 3; });
        var queryCat   = _queryCategory(query || '');

        /* Score and sort */
        var scored = memories.map(function (m) {
          return { memory: m, score: _scoreMemory(m, queryNorm, queryWords, queryCat) };
        });
        scored.sort(function (a, b) { return b.score - a.score; });

        /* Return top relevant results */
        var topScored = scored.filter(function (s) { return s.score > 0; }).slice(0, MAX_RESULTS);
        var results = topScored.map(function (s) { return s.memory; });

        if (!results.length) {
          /* No keyword match — return most recent memories */
          var recent = memories.slice().sort(function (a, b) {
            var ta = a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : a.createdAt) : 0;
            var tb = b.createdAt ? (b.createdAt.toMillis ? b.createdAt.toMillis() : b.createdAt) : 0;
            return tb - ta;
          }).slice(0, 5);
          callback({ success: true, memories: recent, message: null, noMatch: true });
          return;
        }

        callback({ success: true, memories: results, message: null });
      })
      .catch(function (err) {
        callback({ success: false, message: "Couldn't retrieve memories right now.", reason: 'DB_ERROR' });
      });
  }

  /**
   * search(query, callback) — alias for recall; used by conversation engine.
   */
  function search(query, callback) {
    return recall(query, callback);
  }

  /**
   * list(callback) — List all active memories for the current user.
   *
   * callback(result):
   *   { success: true, memories: array, message: string }
   *   { success: false, ... }
   */
  function list(callback) {
    callback = callback || function () {};

    if (!_isSignedIn()) {
      callback({ success: false, message: "You need to be signed in to view saved memories.", reason: 'GUEST' });
      return;
    }

    if (!_isEnabled()) {
      callback({ success: false, message: "Memory is currently turned off.", reason: 'DISABLED' });
      return;
    }

    var uid = _getCurrentUID();
    var ref = _getMemoriesRef(uid);
    if (!ref) {
      callback({ success: false, message: "Memory unavailable right now.", reason: 'DB_UNAVAILABLE' });
      return;
    }

    ref.where('active', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(MAX_MEMORIES)
      .get()
      .then(function (snapshot) {
        var memories = [];
        snapshot.forEach(function (doc) {
          memories.push(Object.assign({ id: doc.id }, doc.data()));
        });
        callback({ success: true, memories: memories, count: memories.length });
      })
      .catch(function (err) {
        callback({ success: false, message: "Couldn't retrieve memories right now.", reason: 'DB_ERROR' });
      });
  }

  /**
   * forget(text, callback) — Remove a specific memory matching the given subject.
   *
   * callback(result):
   *   { success: true, message: string, deleted: array }
   *   { success: false, message: string, reason: string }
   *   { success: false, reason: 'AMBIGUOUS', candidates: array, message: string }
   */
  function forget(text, callback) {
    callback = callback || function () {};

    if (!_isSignedIn()) {
      callback({ success: false, message: "You need to be signed in to manage memories.", reason: 'GUEST' });
      return;
    }

    var uid = _getCurrentUID();
    var ref = _getMemoriesRef(uid);
    if (!ref) {
      callback({ success: false, message: "Memory unavailable right now.", reason: 'DB_UNAVAILABLE' });
      return;
    }

    var subject = _extractForgetSubject(text);
    if (!subject) {
      callback({ success: false, message: "I'm not sure what you want me to forget. Could you be more specific?", reason: 'NO_SUBJECT' });
      return;
    }

    var subjectNorm  = _normalize(subject);
    var subjectWords = subjectNorm.split(' ').filter(function (w) { return w.length >= 3; });

    ref.where('active', '==', true).limit(MAX_MEMORIES).get()
      .then(function (snapshot) {
        var memories = [];
        snapshot.forEach(function (doc) {
          memories.push(Object.assign({ id: doc.id }, doc.data()));
        });

        /* Score against subject */
        var scored = memories.map(function (m) {
          return { memory: m, score: _scoreMemory(m, subjectNorm, subjectWords, null) };
        }).filter(function (s) { return s.score > 0; });

        scored.sort(function (a, b) { return b.score - a.score; });

        if (!scored.length) {
          callback({ success: false, message: "I don't have any memory matching that.", reason: 'NOT_FOUND' });
          return;
        }

        /* Single strong match → delete immediately */
        var topScore = scored[0].score;
        var topMatches = scored.filter(function (s) {
          return s.score >= topScore * 0.8 && s.score >= 4;
        });

        if (topMatches.length === 1) {
          /* Single unambiguous match */
          var docId = topMatches[0].memory.id;
          ref.doc(docId).update({
            active:    false,
            updatedAt: _getServerTimestamp()
          })
            .then(function () {
              callback({
                success: true,
                message: "Done. I've forgotten that.",
                deleted: [topMatches[0].memory]
              });
            })
            .catch(function () {
              callback({ success: false, message: "Couldn't remove that memory right now.", reason: 'DB_ERROR' });
            });
          return;
        }

        /* Multiple ambiguous matches — ask which one */
        var candidates = topMatches.slice(0, 4).map(function (s) { return s.memory; });
        callback({
          success:    false,
          reason:     'AMBIGUOUS',
          candidates: candidates,
          message:    "I found a few memories that could match. Which one did you mean? " +
                      candidates.map(function (m, i) { return (i + 1) + '. ' + m.content; }).join('  |  ')
        });
      })
      .catch(function () {
        callback({ success: false, message: "Couldn't process that right now.", reason: 'DB_ERROR' });
      });
  }

  /**
   * clearAll(confirmed, callback) — Delete all memories for the current user.
   * If confirmed is false, asks for confirmation.
   * Only deletes shadowReaperMemories — nothing else.
   *
   * callback(result):
   *   { success: 'CONFIRM_REQUIRED', message: string }
   *   { success: true, message: string, count: number }
   *   { success: false, ... }
   */
  function clearAll(confirmed, callback) {
    callback = callback || function () {};

    if (!_isSignedIn()) {
      callback({ success: false, message: "You need to be signed in to clear memories.", reason: 'GUEST' });
      return;
    }

    var uid = _getCurrentUID();

    if (!confirmed) {
      /* Set pending state and request confirmation */
      _pendingForgetAll = { uid: uid };
      callback({
        success: 'CONFIRM_REQUIRED',
        message: "That will remove all of your saved Shadow Reaper memories. Do you want me to continue? (Say yes to confirm, or no to cancel.)"
      });
      return;
    }

    /* Confirmed — proceed with deletion */
    _pendingForgetAll = null;

    var ref = _getMemoriesRef(uid);
    if (!ref) {
      callback({ success: false, message: "Memory unavailable right now.", reason: 'DB_UNAVAILABLE' });
      return;
    }

    ref.where('active', '==', true).limit(MAX_MEMORIES).get()
      .then(function (snapshot) {
        if (!snapshot || !snapshot.size) {
          callback({ success: true, message: "You don't have any memories saved. Nothing to clear.", count: 0 });
          return;
        }

        var batch = _getFirestore().batch();
        var count = 0;
        snapshot.forEach(function (doc) {
          batch.update(doc.ref, { active: false, updatedAt: _getServerTimestamp() });
          count++;
        });

        batch.commit()
          .then(function () {
            callback({ success: true, message: "Done. All " + count + " Shadow Reaper memories have been cleared.", count: count });
          })
          .catch(function () {
            callback({ success: false, message: "Couldn't clear memories right now. Please try again.", reason: 'DB_ERROR' });
          });
      })
      .catch(function () {
        callback({ success: false, message: "Couldn't clear memories right now. Please try again.", reason: 'DB_ERROR' });
      });
  }

  /**
   * getPendingForgetAll() — Returns pending clearAll state or null.
   * Used by the conversation engine to detect a pending confirmation.
   */
  function getPendingForgetAll() {
    return _pendingForgetAll ? Object.assign({}, _pendingForgetAll) : null;
  }

  /**
   * cancelForgetAll() — Cancel a pending clearAll confirmation.
   */
  function cancelForgetAll() {
    _pendingForgetAll = null;
  }

  /**
   * deleteOne(memoryId, callback) — Hard delete a specific memory by ID.
   * Used by the Memory UI management panel.
   */
  function deleteOne(memoryId, callback) {
    callback = callback || function () {};

    if (!_isSignedIn()) {
      callback({ success: false, reason: 'GUEST' });
      return;
    }

    var uid = _getCurrentUID();
    var ref = _getMemoriesRef(uid);
    if (!ref) {
      callback({ success: false, reason: 'DB_UNAVAILABLE' });
      return;
    }

    ref.doc(memoryId).update({ active: false, updatedAt: _getServerTimestamp() })
      .then(function () { callback({ success: true }); })
      .catch(function () { callback({ success: false, reason: 'DB_ERROR' }); });
  }

  /**
   * formatMemoriesForResponse(memories) — Format memories as readable text
   * for injection into Shadow Reaper responses.
   * Returns a concise string safe for textContent use.
   * @param {array} memories
   * @returns {string}
   */
  function formatMemoriesForResponse(memories) {
    if (!memories || !memories.length) return '';
    if (memories.length === 1) return memories[0].content;
    return memories.map(function (m, i) {
      return (i + 1) + '. ' + m.content;
    }).join('\n');
  }

  /**
   * getRelevantSnippets(query, callback) — Get a short list of relevant
   * memory snippets for contextual injection into a conversation.
   * Never returns more than 3 items — minimum necessary for context.
   * Called only when a memory-relevant question is detected.
   *
   * @param {string}   query
   * @param {function} callback — fn({ snippets: string[] })
   */
  function getRelevantSnippets(query, callback) {
    callback = callback || function () {};

    if (!_isSignedIn() || !_isEnabled()) {
      callback({ snippets: [] });
      return;
    }

    recall(query, function (result) {
      if (!result.success || !result.memories || !result.memories.length) {
        callback({ snippets: [] });
        return;
      }
      /* Return max 3 most relevant content strings */
      var snippets = result.memories.slice(0, 3).map(function (m) {
        return m.content;
      });
      callback({ snippets: snippets });
    });
  }

  /**
   * destroy() — Teardown. Clears pending state.
   * No persistent data is affected — only in-memory session state.
   */
  function destroy() {
    _pendingForgetAll = null;
    _initialized      = false;
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE PUBLIC API — window.SNXShadowMemory
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowMemory = {

    /** Build identifier */
    build: BUILD_ID,

    /** Memory categories */
    CATEGORY: CATEGORY,

    /** Initialize (idempotent) */
    init: init,

    /** Returns true if persistent memory is enabled */
    isEnabled: isEnabled,

    /** Enable or disable persistent memory */
    setEnabled: setEnabled,

    /**
     * Detect memory intent from a message.
     * @param {string} text
     * @returns {string|null} 'MEMORY_SAVE'|'MEMORY_RECALL'|'MEMORY_FORGET'|
     *                        'MEMORY_FORGET_ALL'|'MEMORY_LIST'|null
     */
    detectIntent: detectMemoryIntent,

    /**
     * Save a memory from an explicit user command.
     * @param {string}   text      — raw user message
     * @param {function} callback
     */
    save: save,

    /**
     * Recall memories matching a query.
     * @param {string}   query
     * @param {function} callback
     */
    recall: recall,

    /**
     * Search memories (alias for recall).
     * @param {string}   query
     * @param {function} callback
     */
    search: search,

    /**
     * List all active memories.
     * @param {function} callback
     */
    list: list,

    /**
     * Forget a specific memory by subject text.
     * @param {string}   text      — the forget command text
     * @param {function} callback
     */
    forget: forget,

    /**
     * Clear all memories. Requires confirmation on first call.
     * @param {boolean}  confirmed — false to request confirmation, true to execute
     * @param {function} callback
     */
    clearAll: clearAll,

    /** Returns pending clearAll state or null */
    getPendingForgetAll: getPendingForgetAll,

    /** Cancel a pending clearAll */
    cancelForgetAll: cancelForgetAll,

    /**
     * Delete one memory by ID (for UI management).
     * @param {string}   memoryId
     * @param {function} callback
     */
    deleteOne: deleteOne,

    /**
     * Format a memories array as a readable string for responses.
     * @param {array} memories
     * @returns {string}
     */
    formatMemoriesForResponse: formatMemoriesForResponse,

    /**
     * Get relevant memory snippets for contextual injection (max 3).
     * @param {string}   query
     * @param {function} callback
     */
    getRelevantSnippets: getRelevantSnippets,

    /**
     * Check if text contains a secret/credential that should not be stored.
     * @param {string} text
     * @returns {boolean}
     */
    isSecret: _isSecret,

    /**
     * Full teardown — called when SNXShadowAI.destroy() is called.
     * Clears session state only; no persistent data is affected.
     */
    destroy: destroy
  };

  /* [ShadowMemoryDebug] script loaded */
  console.log('[ShadowMemoryDebug] script loaded — build: ' + BUILD_ID);
  console.log('[ShadowMemoryDebug] SNXShadowMemory exists: true');
  console.log('[ShadowMemoryDebug] init function exists: ' + (typeof init === 'function'));

})(window);
