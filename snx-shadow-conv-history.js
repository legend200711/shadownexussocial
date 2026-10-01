/**
 * snx-shadow-conv-history.js
 * Shadow Nexus Social — Shadow Reaper E3: Persistent Conversation History
 *
 * Build: SNS-2026-SHADOW-CONVERSATION-MEMORY-RC1
 *
 * Exposes: window.SNXShadowConvHistory
 *
 * Design:
 *  • Isolated module — does NOT modify E1, E2, voice, character, or core AI.
 *  • Persistent conversation history for signed-in users ONLY.
 *  • Optional — ON by default, user can turn OFF.
 *  • When OFF: no new turns persisted, no history injected.
 *  • When OFF: existing history retained unless user clears it explicitly.
 *  • Bounded: max 100 turns per user (oldest trimmed automatically).
 *  • AI context window: most recent 10 turns (≤12 max) — never full history.
 *  • Firestore path: users/{uid}/shadowReaperConversations/{convId}/messages/{msgId}
 *  • Guest: session-only, no persistence, no injection.
 *  • Founder does NOT automatically access another user's conversations.
 *  • No polling, no RAF, no setInterval, no continuous timers.
 *  • No eval, no new Function, no innerHTML from user data.
 *  • Local-first: SAVE / LOAD / CLEAR do not require Workers AI.
 *  • Workers AI receives only the bounded AI context window.
 *  • Failure tolerant: if Firestore write fails, current session continues.
 *  • No emotional-profile labels persisted.
 *  • No audio, no system prompts, no API keys stored.
 *
 * What is stored per turn:
 *   role        — 'user' | 'assistant'
 *   text        — sanitized message text (≤1000 chars)
 *   ts          — Unix timestamp (ms)
 *   sessionId   — random session identifier
 *   convId      — conversation identifier
 *
 * What is NOT stored:
 *   detected emotion state / labels
 *   voice audio / recordings
 *   authentication tokens / passwords / API keys
 *   Workers AI internal prompts
 *   hidden system prompts
 *
 * Firestore rule required (owner-only):
 *   match /users/{uid}/shadowReaperConversations/{convId} { ... }
 *   match /users/{uid}/shadowReaperConversations/{convId}/messages/{msgId} { ... }
 *   See firestore.rules for the complete minimal rule.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SNS-2026-SHADOW-CONV-HISTORY-FIX-002';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var MAX_TURNS_STORED   = 100;  /* max turns kept in Firestore per user */
  var AI_CONTEXT_WINDOW  = 10;   /* turns sent to Workers AI (≤12) */
  var MAX_TEXT_LEN       = 1000; /* max characters per turn text */

  var HISTORY_ENABLED_KEY = 'snxShadowConvHistoryEnabled'; /* localStorage */
  var SESSION_ID_KEY      = 'snxShadowConvSessionId';      /* localStorage */

  /* ─────────────────────────────────────────────────────────────
     SECRET / CREDENTIAL DETECTION
     Never store passwords, tokens, API keys, etc.
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
    /\bmy secret is\b/i
  ];

  function _isSecret(text) {
    if (!text) return false;
    for (var i = 0; i < _SECRET_PATTERNS.length; i++) {
      if (_SECRET_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     CONTINUITY INTENT DETECTION
     Detects when the user wants to continue a previous conversation.
  ───────────────────────────────────────────────────────────────*/
  var _CONTINUITY_PATTERNS = [
    /\bwhat (were|was) we (talking|discussing)\b/i,
    /\bwhat .{0,30} were we (talking|discussing)\b/i,
    /\bwhat .{0,30} was (the|our|a) .{0,30} (we were|we've been|i was) (talking|discussing|working on)\b/i,
    /\bcontinue (where|from) (we|we were)\b/i,
    /\bgo back to (what|our|the)\b/i,
    /\bwhat (did i|did we) (tell|talk|say|discuss|mention)\b.*\b(yesterday|earlier|before|last time)\b/i,
    /\bremember what we (talked|discussed|said)\b/i,
    /\bwhere were we\b/i,
    /\bpick up where\b/i,
    /\bcontinue (our|the) (conversation|chat|talk|discussion)\b/i,
    /\bcan we continue (what|where|from|our|the)\b/i,
    /\bwhat (were|was) (i|we) (working on|doing|saying)\b/i,
    /\blet'?s (go back|continue|pick up)\b/i,
    /\bwhat (did i|was i) (tell|talking) you (about|earlier)\b/i,
    /\bwhat did (i|we) (say|talk about) (last|before|earlier|yesterday)\b/i,
    /\bwhat (project|topic|subject|thing) were we (just |recently )?(talking|discussing|working on)\b/i,
    /\bwhat (project|topic|subject|thing) (did i|did we|was i|was we) (tell|talk about|mention|discuss)\b/i,
    /\bwhat was (the )?(project|topic|subject|thing) (we were|i was|we've been)\b/i,
    /\bwhat were (we|you and i) (just |recently )?(talking|discussing|working on)\b/i,
    /\bwhat (was|is) the (name|title|project name|thing) (i|we) (told|gave|called|named|mentioned)\b/i,
    /\bwhat (name|title) did i (tell|give|say|use|pick|choose)\b/i,
    /\bwhat was (it|the project) called\b/i,
    /\bwhat (did i|was i) (call|name|title) (it|the project|the thing)\b/i
  ];

  /**
   * Detect if the user is asking to continue a previous conversation.
   * @param {string} text
   * @returns {boolean}
   */
  function detectContinuityIntent(text) {
    if (!text) return false;
    for (var i = 0; i < _CONTINUITY_PATTERNS.length; i++) {
      if (_CONTINUITY_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     CONTENT SANITIZATION
  ───────────────────────────────────────────────────────────────*/
  function _sanitize(text) {
    if (!text) return '';
    return text
      .replace(/<[^>]*>/g, '')
      .replace(/</g, '')
      .replace(/>/g, '')
      .trim();
  }

  /* ─────────────────────────────────────────────────────────────
     FIREBASE HELPERS
     Uses existing window._snxDbCompat / window._snxAuth globals.
     Does NOT create a new app. Does NOT use window.firebase compat SDK.
   ───────────────────────────────────────────────────────────────*/
  function _getFirestore() {
    /* Primary: use the compat bridge exposed by index.html (modular SDK v12) */
    if (global._snxDbCompat) return global._snxDbCompat;
    /* Fallback: legacy Firebase Compat SDK (kept for safety) */
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
    /* Legacy Firebase Compat SDK (kept for safety) */
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

  /**
   * Run fn() when Firebase auth is resolved.
   * Uses _snxOnAuthReady — the authoritative SNS auth-ready mechanism.
   * No polling. No intervals. No RAF.
   * Safety timeout is ONE-SHOT only (never repeating).
   */
  function _whenAuthReady(fn) {
    /* Already signed in — call immediately */
    if (_isSignedIn()) { fn(); return; }
    /* Auth resolved but user is signed out — call immediately (guest path) */
    if (global._snxAuthResolved) { fn(); return; }
    /* Primary: defer via the existing auth-ready queue (authoritative) */
    if (typeof global._snxOnAuthReady === 'function') {
      global._snxOnAuthReady(fn);
      return;
    }
    /* Secondary: _snxOnAuthReady not yet defined — push directly to the
       underlying queue that index.html always initialises first.
       No polling, no interval. */
    if (Array.isArray(global._snxAuthReadyQueue)) {
      global._snxAuthReadyQueue.push(fn);
      return;
    }
    /* Last-resort: ONE-SHOT timeout — never repeating, never polling.
       This path is only reached if the SNS auth infrastructure has not
       loaded at all (should not occur in normal operation). */
    setTimeout(fn, 4000);
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

  /**
   * Returns the Firestore ref for a user's conversation messages subcollection.
   * Path: users/{uid}/shadowReaperConversations/{convId}/messages
   */
  function _getMessagesRef(uid, convId) {
    var db = _getFirestore();
    if (!db || !uid || !convId) return null;
    return db
      .collection('users').doc(uid)
      .collection('shadowReaperConversations').doc(convId)
      .collection('messages');
  }

  /**
   * Returns the Firestore ref for a user's conversation document.
   * Path: users/{uid}/shadowReaperConversations/{convId}
   */
  function _getConvRef(uid, convId) {
    var db = _getFirestore();
    if (!db || !uid || !convId) return null;
    return db
      .collection('users').doc(uid)
      .collection('shadowReaperConversations').doc(convId);
  }

  /**
   * Returns the parent conversations collection ref.
   * Path: users/{uid}/shadowReaperConversations
   */
  function _getConvsRef(uid) {
    var db = _getFirestore();
    if (!db || !uid) return null;
    return db.collection('users').doc(uid).collection('shadowReaperConversations');
  }

  /* ─────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────*/
  var _initialized = false;

  /* Active conversation ID for this session.
     Loaded from localStorage on init; created fresh on New Conversation. */
  var _currentConvId = null;

  /* In-memory session turn buffer for quick access (not persisted here) */
  var _sessionTurns = []; /* [{ role, text, ts, sessionId, convId }] */

  /* ─────────────────────────────────────────────────────────────
     CONVERSATION ID / SESSION ID HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _generateId() {
    var r = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? (function () {
          var b = new Uint8Array(12);
          crypto.getRandomValues(b);
          return Array.from(b).map(function (x) {
            return x.toString(16).padStart(2, '0');
          }).join('');
        })()
      : Math.random().toString(36).substring(2, 14) + Date.now().toString(36);
    return r;
  }

  function _getOrCreateSessionId() {
    try {
      var existing = global.localStorage.getItem(SESSION_ID_KEY);
      if (existing) return existing;
      var fresh = _generateId();
      global.localStorage.setItem(SESSION_ID_KEY, fresh);
      return fresh;
    } catch (_) {
      return _generateId();
    }
  }

  function _getOrCreateConvId() {
    if (_currentConvId) return _currentConvId;
    try {
      var stored = global.localStorage.getItem('snxShadowConvId');
      if (stored) {
        _currentConvId = stored;
        return _currentConvId;
      }
    } catch (_) {}
    return _startNewConversation();
  }

  function _startNewConversation() {
    _currentConvId = _generateId();
    try {
      global.localStorage.setItem('snxShadowConvId', _currentConvId);
    } catch (_) {}
    _sessionTurns = [];
    return _currentConvId;
  }

  /* ─────────────────────────────────────────────────────────────
     HISTORY ENABLED PREFERENCE
  ───────────────────────────────────────────────────────────────*/
  function _isEnabled() {
    try {
      var val = global.localStorage.getItem(HISTORY_ENABLED_KEY);
      return val !== 'false'; /* Default: ON */
    } catch (_) {
      return true;
    }
  }

  function _setEnabled(enabled) {
    try {
      global.localStorage.setItem(HISTORY_ENABLED_KEY, enabled ? 'true' : 'false');
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     SAVE TURN
     Persists a single conversation turn to Firestore.
     Fails silently — current session is never blocked by storage errors.
  ───────────────────────────────────────────────────────────────*/
  function _saveTurn(role, text, callback) {
    callback = callback || function () {};

    /* History disabled: no persistence */
    if (!_isEnabled()) {
      console.log('[ShadowHistoryDebug] saveTurn skipped — history disabled');
      callback({ success: false, reason: 'DISABLED' });
      return;
    }

    /* Offline: no persistence (do not claim it was saved) */
    if (!global.navigator.onLine) {
      console.log('[ShadowHistoryDebug] saveTurn skipped — offline');
      callback({ success: false, reason: 'OFFLINE' });
      return;
    }

    /* Secret detection: never store credentials */
    if (_isSecret(text)) {
      console.log('[ShadowHistoryDebug] saveTurn skipped — secret detected');
      callback({ success: false, reason: 'SECRET' });
      return;
    }

    /* Sanitize and bound text early so we can catch EMPTY before auth wait */
    var safe = _sanitize(text);
    if (safe.length > MAX_TEXT_LEN) safe = safe.substring(0, MAX_TEXT_LEN);
    if (!safe) {
      callback({ success: false, reason: 'EMPTY' });
      return;
    }

    /* Defer until auth resolves — avoids false GUEST failures on first open */
    _whenAuthReady(function () {
      /* Guest: no persistence */
      if (!_isSignedIn()) {
        console.log('[ShadowHistoryDebug] saveTurn skipped — guest (not signed in)');
        callback({ success: false, reason: 'GUEST' });
        return;
      }

      var uid    = _getCurrentUID();
      var convId = _getOrCreateConvId();
      var ref    = _getMessagesRef(uid, convId);
      if (!ref) {
        console.log('[ShadowHistoryDebug] saveTurn failed — Firestore unavailable');
        callback({ success: false, reason: 'DB_UNAVAILABLE' });
        return;
      }

      var turn = {
        role:      role === 'user' ? 'user' : 'assistant',
        text:      safe,
        ts:        Date.now(),
        sessionId: _getOrCreateSessionId(),
        convId:    convId
      };

      /* Store in session buffer (capped) */
      _sessionTurns.push(turn);
      if (_sessionTurns.length > MAX_TURNS_STORED) {
        _sessionTurns = _sessionTurns.slice(-MAX_TURNS_STORED);
      }

      /* Persist to Firestore */
      console.log('[ShadowHistoryDebug] saveTurn — writing role=' + turn.role + ' convId=' + convId.slice(0, 8) + '…');
      ref.add(Object.assign({}, turn, { savedAt: _getServerTimestamp() }))
        .then(function () {
          /* After saving, enforce bounded storage limit asynchronously */
          _trimHistory(uid, convId);
          /* Update lastTs on the conversation document so cross-device recovery
             can find the most-recent conversation via orderBy('lastTs', 'desc').
             Fire-and-forget — never blocks the current session. */
          var convRef = _getConvRef(uid, convId);
          if (convRef) {
            convRef.set({ lastTs: turn.ts, convId: convId }, { merge: true }).catch(function () {});
          }
          console.log('[ShadowHistoryDebug] saveTurn — write success');
          callback({ success: true });
        })
        .catch(function (err) {
          /* Storage failure — current session continues unaffected */
          console.warn('[ShadowHistoryDebug] saveTurn — write failed:', err && err.message);
          callback({ success: false, reason: 'DB_ERROR' });
        });
    });
  }

  /**
   * Trim conversation to MAX_TURNS_STORED by deleting oldest turns.
   * Fire-and-forget — does not block anything.
   */
  function _trimHistory(uid, convId) {
    var ref = _getMessagesRef(uid, convId);
    if (!ref) return;

    ref.orderBy('ts', 'asc').get()
      .then(function (snapshot) {
        if (!snapshot || snapshot.size <= MAX_TURNS_STORED) return;
        var toDelete = snapshot.size - MAX_TURNS_STORED;
        var count = 0;
        var db = _getFirestore();
        if (!db) return;
        var batch = db.batch();
        snapshot.forEach(function (doc) {
          if (count < toDelete) {
            batch.delete(doc.ref);
            count++;
          }
        });
        if (count > 0) {
          batch.commit().catch(function () { /* silent */ });
        }
      })
      .catch(function () { /* silent */ });
  }

  /* ─────────────────────────────────────────────────────────────
     LOAD RECENT CONTEXT
     Loads the bounded recent turns for AI context injection.
     Returns at most AI_CONTEXT_WINDOW turns.
  ───────────────────────────────────────────────────────────────*/
  function _loadRecentContext(callback) {
    callback = callback || function () {};

    if (!_isEnabled()) {
      console.log('[ShadowHistoryDebug] loadRecentContext — history disabled');
      callback({ turns: [], reason: 'DISABLED' });
      return;
    }

    console.log('[ShadowHistoryDebug] loadRecentContext — waiting for auth…');

    /* Defer until auth resolves — avoids false GUEST returns on first open */
    _whenAuthReady(function () {
      if (!_isSignedIn()) {
        console.log('[ShadowHistoryDebug] loadRecentContext — guest (not signed in)');
        callback({ turns: [], reason: 'GUEST' });
        return;
      }

      var uid    = _getCurrentUID();
      var convId = _getOrCreateConvId();
      var db     = _getFirestore();

      console.log('[ShadowHistoryDebug] loadRecentContext — auth ready, user available: true, Firestore available: ' + !!db + ', convId: ' + convId.slice(0, 8) + '…');

      var ref = _getMessagesRef(uid, convId);
      if (!ref) {
        console.log('[ShadowHistoryDebug] loadRecentContext — Firestore unavailable');
        callback({ turns: [], reason: 'DB_UNAVAILABLE' });
        return;
      }

      /* Fetch only the most recent AI_CONTEXT_WINDOW turns */
      ref.orderBy('ts', 'desc').limit(AI_CONTEXT_WINDOW).get()
        .then(function (snapshot) {
          /* If this convId has no messages, check Firestore for the most-recent
             conversation (handles cross-device / cleared-localStorage scenarios) */
          if (snapshot.size === 0) {
            console.log('[ShadowHistoryDebug] loadRecentContext — convId empty, searching for most recent conversation…');
            var convsRef = _getConvsRef(uid);
            if (!convsRef) {
              console.log('[ShadowHistoryDebug] loadRecentContext — no conversations ref');
              callback({ turns: [] });
              return;
            }
            /* Find the conversation with the latest message (by savedAt descending) */
            convsRef.orderBy('lastTs', 'desc').limit(1).get()
              .then(function (convSnap) {
                if (!convSnap || convSnap.size === 0) {
                  console.log('[ShadowHistoryDebug] loadRecentContext — no previous conversations found');
                  callback({ turns: [] });
                  return;
                }
                var latestConvId = null;
                convSnap.forEach(function (d) { latestConvId = d.id; });
                if (!latestConvId) {
                  callback({ turns: [] });
                  return;
                }
                console.log('[ShadowHistoryDebug] loadRecentContext — found prior conversation: ' + latestConvId.slice(0, 8) + '…');
                /* Adopt this as the active conversation so future turns append to it */
                _currentConvId = latestConvId;
                try { global.localStorage.setItem('snxShadowConvId', latestConvId); } catch (_) {}
                var priorRef = _getMessagesRef(uid, latestConvId);
                if (!priorRef) { callback({ turns: [] }); return; }
                priorRef.orderBy('ts', 'desc').limit(AI_CONTEXT_WINDOW).get()
                  .then(function (msgSnap) {
                    var turns = [];
                    msgSnap.forEach(function (doc) {
                      var d = doc.data();
                      turns.push({ role: d.role, text: d.text, ts: d.ts || 0 });
                    });
                    turns.sort(function (a, b) { return a.ts - b.ts; });
                    console.log('[ShadowHistoryDebug] loadRecentContext — retrieved ' + turns.length + ' turns from prior conversation');
                    callback({ turns: turns });
                  })
                  .catch(function (err) {
                    console.warn('[ShadowHistoryDebug] loadRecentContext — prior conv query failed:', err && err.message);
                    callback({ turns: [], reason: 'DB_ERROR' });
                  });
              })
              .catch(function (err) {
                /* lastTs index may not exist yet — fall back gracefully */
                console.log('[ShadowHistoryDebug] loadRecentContext — lastTs index unavailable, falling back to no context');
                callback({ turns: [] });
              });
            return;
          }

          var turns = [];
          snapshot.forEach(function (doc) {
            var d = doc.data();
            turns.push({
              role: d.role,
              text: d.text,
              ts:   d.ts || 0
            });
          });
          /* Restore chronological order (oldest first) */
          turns.sort(function (a, b) { return a.ts - b.ts; });
          console.log('[ShadowHistoryDebug] loadRecentContext — retrieved ' + turns.length + ' turns, context injected: true');
          callback({ turns: turns });
        })
        .catch(function (err) {
          console.warn('[ShadowHistoryDebug] loadRecentContext — query failed:', err && err.message);
          callback({ turns: [], reason: 'DB_ERROR' });
        });
    });
  }

  /* ─────────────────────────────────────────────────────────────
     CLEAR CONVERSATION HISTORY
     Deletes all conversation history for the current user.
     Does NOT delete E2 Personal Memories or account data.
  ───────────────────────────────────────────────────────────────*/
  function _clearHistory(callback) {
    callback = callback || function () {};

    if (!_isSignedIn()) {
      callback({ success: false, reason: 'GUEST' });
      return;
    }

    var uid    = _getCurrentUID();
    var convsRef = _getConvsRef(uid);
    if (!convsRef) {
      callback({ success: false, reason: 'DB_UNAVAILABLE' });
      return;
    }

    /* Get all conversation docs for this user */
    convsRef.limit(200).get()
      .then(function (snapshot) {
        if (!snapshot || !snapshot.size) {
          _sessionTurns = [];
          _startNewConversation();
          callback({ success: true, count: 0 });
          return;
        }

        /* Delete all messages subcollections and conversation docs */
        var pending = snapshot.size;
        var errors  = 0;
        var total   = 0;

        snapshot.forEach(function (convDoc) {
          var convId = convDoc.id;
          var msgsRef = _getMessagesRef(uid, convId);
          if (!msgsRef) {
            pending--;
            if (pending === 0) {
              _sessionTurns = [];
              _startNewConversation();
              callback({ success: errors === 0, count: total, errors: errors });
            }
            return;
          }

          msgsRef.limit(MAX_TURNS_STORED + 50).get()
            .then(function (msgSnapshot) {
              var db = _getFirestore();
              if (!db || !msgSnapshot || !msgSnapshot.size) {
                /* Delete the conv doc itself */
                convDoc.ref.delete().catch(function () {});
                pending--;
                if (pending === 0) {
                  _sessionTurns = [];
                  _startNewConversation();
                  callback({ success: errors === 0, count: total, errors: errors });
                }
                return;
              }

              var batch = db.batch();
              msgSnapshot.forEach(function (msg) {
                batch.delete(msg.ref);
                total++;
              });
              batch.delete(convDoc.ref);

              batch.commit()
                .then(function () {
                  pending--;
                  if (pending === 0) {
                    _sessionTurns = [];
                    _startNewConversation();
                    callback({ success: errors === 0, count: total, errors: errors });
                  }
                })
                .catch(function () {
                  errors++;
                  pending--;
                  if (pending === 0) {
                    _sessionTurns = [];
                    _startNewConversation();
                    callback({ success: false, count: total, errors: errors, reason: 'DB_ERROR' });
                  }
                });
            })
            .catch(function () {
              errors++;
              pending--;
              if (pending === 0) {
                _sessionTurns = [];
                _startNewConversation();
                callback({ success: false, count: total, errors: errors, reason: 'DB_ERROR' });
              }
            });
        });
      })
      .catch(function () {
        callback({ success: false, reason: 'DB_ERROR' });
      });
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────*/

  /**
   * init() — Idempotent initialization.
   * Loads conversation ID from localStorage.
   */
  function init() {
    if (_initialized) return;
    _initialized = true;
    _getOrCreateConvId(); /* warm up convId from localStorage */
    console.log('[ShadowHistoryDebug] module loaded, history enabled: ' + _isEnabled());
  }

  /**
   * isEnabled() — Returns whether persistent conversation history is ON.
   * @returns {boolean}
   */
  function isEnabled() {
    return _isEnabled();
  }

  /**
   * setEnabled(bool) — Turn conversation history ON or OFF.
   * When OFF: no new turns are persisted and history is not injected.
   * Existing history is retained unless explicitly cleared.
   * @param {boolean} enabled
   */
  function setEnabled(enabled) {
    _setEnabled(!!enabled);
  }

  /**
   * saveTurn(role, text, callback) — Save one conversation turn.
   * role: 'user' | 'assistant'
   * Fails silently on error — session always continues.
   *
   * @param {string}   role
   * @param {string}   text
   * @param {function} [callback]
   */
  function saveTurn(role, text, callback) {
    _saveTurn(role, text, callback || function () {});
  }

  /**
   * loadRecentContext(callback) — Load bounded recent turns for AI context.
   * Returns at most AI_CONTEXT_WINDOW turns in chronological order.
   * Never loads the full history.
   *
   * callback({ turns: [{ role, text, ts }], reason?: string })
   *
   * @param {function} callback
   */
  function loadRecentContext(callback) {
    _loadRecentContext(callback || function () {});
  }

  /**
   * newConversation() — Start a fresh conversation thread.
   * Does NOT delete E2 memories or older conversation history.
   * Returns the new conversation ID.
   * @returns {string}
   */
  function newConversation() {
    return _startNewConversation();
  }

  /**
   * clearHistory(callback) — Delete all persistent conversation history.
   * Does NOT delete E2 Personal Memories or account data.
   *
   * callback({ success, count, reason? })
   *
   * @param {function} callback
   */
  function clearHistory(callback) {
    _clearHistory(callback || function () {});
  }

  /**
   * detectContinuityIntent(text) — Returns true if user wants to continue
   * a previous conversation ("what were we talking about?", etc.).
   * @param {string} text
   * @returns {boolean}
   */
  function detectContinuity(text) {
    return detectContinuityIntent(text);
  }

  /**
   * getCurrentConvId() — Returns the active conversation ID.
   * @returns {string}
   */
  function getCurrentConvId() {
    return _getOrCreateConvId();
  }

  /**
   * getSessionTurns() — Returns the in-memory session turn buffer.
   * Used for quick access without a Firestore round-trip.
   * @returns {Array}
   */
  function getSessionTurns() {
    return _sessionTurns.slice();
  }

  /**
   * destroy() — Teardown session state.
   * Persistent Firestore data is NOT affected.
   */
  function destroy() {
    _initialized  = false;
    _sessionTurns = [];
    _currentConvId = null;
    /* convId is preserved in localStorage so it survives account-switch */
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE PUBLIC API — window.SNXShadowConvHistory
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowConvHistory = {

    /** Build identifier */
    build: 'SNS-2026-SHADOW-CONV-HISTORY-FIX-002',

    /** Maximum turns stored per user */
    MAX_TURNS_STORED: MAX_TURNS_STORED,

    /** AI context window size */
    AI_CONTEXT_WINDOW: AI_CONTEXT_WINDOW,

    /** Initialize (idempotent) */
    init: init,

    /** Returns true if conversation history is enabled */
    isEnabled: isEnabled,

    /** Enable or disable conversation history */
    setEnabled: setEnabled,

    /**
     * Save one conversation turn to persistent storage.
     * @param {string}   role     — 'user' | 'assistant'
     * @param {string}   text     — message text
     * @param {function} [callback]
     */
    saveTurn: saveTurn,

    /**
     * Load recent conversation context (bounded).
     * @param {function} callback — fn({ turns: [], reason? })
     */
    loadRecentContext: loadRecentContext,

    /**
     * Start a fresh conversation thread.
     * Does NOT delete old history or E2 memories.
     * @returns {string} new conversation ID
     */
    newConversation: newConversation,

    /**
     * Clear all persistent conversation history.
     * Does NOT clear E2 memories.
     * @param {function} callback
     */
    clearHistory: clearHistory,

    /**
     * Detect continuity intent ("what were we talking about?").
     * @param {string} text
     * @returns {boolean}
     */
    detectContinuity: detectContinuity,

    /** Returns the current conversation ID */
    getCurrentConvId: getCurrentConvId,

    /** Returns in-memory session turns (read-only copy) */
    getSessionTurns: getSessionTurns,

    /** Teardown session state (persistent data unaffected) */
    destroy: destroy
  };

}(typeof window !== 'undefined' ? window : global));
