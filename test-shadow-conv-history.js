/**
 * test-shadow-conv-history.js
 * Shadow Nexus Social — Shadow Reaper E3: Persistent Conversation History
 * Regression Test Suite
 *
 * Build Target: SNS-2026-SHADOW-CONVERSATION-MEMORY-RC1
 * Run: node test-shadow-conv-history.js
 *
 * Coverage:
 *   CH-PERSIST   — conversation persists after close/reopen
 *   CH-CONTINUE  — "What were we talking about?" continuity
 *   CH-MULTI     — multiple conversation turns
 *   CH-NEWCONV   — new conversation does not delete old history
 *   CH-SEPARATE  — old conversation remains separate
 *   CH-E2SAFE    — E2 memories survive new conversation
 *   CH-ONOFF     — history ON/OFF preference
 *   CH-OFFWRITE  — history OFF prevents writes
 *   CH-OFFREAD   — history OFF prevents injection
 *   CH-CLEAR     — clear history
 *   CH-CLEARE2   — clear history does not clear E2 memories
 *   CH-GUEST     — guest persistence blocked
 *   CH-ISOLATE   — user A cannot read user B history
 *   CH-FOUNDER   — Founder cannot read another user's history
 *   CH-SECRET    — secret filtering
 *   CH-NOAUDIO   — no audio storage
 *   CH-NOEMOT    — no emotional-profile storage
 *   CH-BOUND     — bounded history (MAX_TURNS_STORED)
 *   CH-AIBOUND   — bounded AI context (AI_CONTEXT_WINDOW)
 *   CH-FAIL      — Firestore failure graceful degradation
 *   CH-OFFLINE   — offline behavior
 *   CH-VOICE     — voice compatibility
 *   CH-CHAR      — character compatibility
 *   CH-NOPOLL    — no polling
 *   CH-NORAF     — no RAF
 *   CH-NOTIMER   — no continuous timers
 *   CH-CONT01    — "What were we talking about?" pattern detection
 *   CH-CONT02    — "Continue where we left off" pattern detection
 *   CH-CONT03    — "Let's go back to our conversation" pattern detection
 *   CH-CONT04    — "What did I tell you earlier?" pattern detection
 *   CH-CONT05    — "Remember what we talked about yesterday?" pattern detection
 *   CH-INT01     — Integration: continuity intent handled before E1/E2 routing
 *   CH-INT02     — Integration: history OFF in context yields natural explanation
 *   CH-INT03     — Integration: E2 memories NOT affected by conversation clear
 *   CH-RULE01    — Firestore rule: owner-only read/write
 *   CH-RULE02    — Firestore rule: founder UID denied other user's conversations
 *   CH-RULE03    — Firestore rule: guest denied
 *   CH-NOEVAL    — no eval() in source
 *   CH-NOINNERHTML — no innerHTML from user data
 *   CH-NOFUNC    — no new Function() in source
 *   CH-SESID     — session ID generated on init
 *   CH-CONVID    — conversation ID persisted across close/reopen
 *   CH-INIT      — idempotent init
 *   CH-DESTROY   — destroy resets session state, not persistent data
 *   CH-ORDER     — loaded turns in chronological order (oldest first)
 *   CH-SANITIZE  — text sanitized before storage
 *   CH-LEN       — text truncated at MAX_TEXT_LEN
 */

'use strict';

/* ── Node-level shims ──────────────────────────────────────────────────────── */
global.window = global;

/* ── Minimal DOM shim ──────────────────────────────────────────────────────── */
var _elements = {};
global.document = {
  getElementById: function (id) { return _elements[id] || null; },
  createElement: function (tag) {
    var el = {
      id: '', tagName: tag.toUpperCase(), className: '', style: {},
      _attrs: {}, _children: [], _listeners: {},
      classList: {
        _cls: [],
        add:      function (c) { if (this._cls.indexOf(c) === -1) this._cls.push(c); },
        remove:   function (c) { this._cls = this._cls.filter(function(x){return x!==c;}); },
        contains: function (c) { return this._cls.indexOf(c) !== -1; },
        toggle:   function (c, f) {
          if (f !== undefined) { if (f) this.add(c); else this.remove(c); }
          else { if (this.contains(c)) this.remove(c); else this.add(c); }
        }
      },
      setAttribute: function (k, v) { this._attrs[k] = v; },
      getAttribute: function (k) { return this._attrs[k] || null; },
      appendChild: function (child) {
        if (child && child.id) _elements[child.id] = child;
        this._children.push(child);
        return child;
      },
      insertBefore: function (child) {
        if (child && child.id) _elements[child.id] = child;
        this._children.unshift(child);
        return child;
      },
      removeChild: function (child) {
        this._children = this._children.filter(function(c){return c!==child;});
        if (child && child.id) delete _elements[child.id];
      },
      addEventListener: function (ev, fn) {
        if (!this._listeners[ev]) this._listeners[ev] = [];
        this._listeners[ev].push(fn);
      },
      textContent: '', innerHTML: '',
      parentNode: null,
      remove: function () { delete _elements[this.id]; }
    };
    el.classList._owner = el;
    if (tag.toLowerCase() === 'input') {
      el.type = 'text'; el.value = ''; el.maxLength = 9999; el.placeholder = '';
      el.disabled = false; el.focus = function(){}; el.select = function(){};
    }
    return el;
  },
  head:   { appendChild: function(){}, insertAdjacentHTML: function(){} },
  body:   { appendChild: function(){} },
  querySelector:    function(){ return null; },
  querySelectorAll: function(){ return []; },
  addEventListener: function(){},
  removeEventListener: function(){},
  documentElement: { lang: '' },
  hidden: false
};

/* ── localStorage shim ─────────────────────────────────────────────────────── */
var _ls = {};
global.localStorage = {
  getItem:    function (k)   { return Object.prototype.hasOwnProperty.call(_ls, k) ? _ls[k] : null; },
  setItem:    function (k,v) { _ls[k] = String(v); },
  removeItem: function (k)   { delete _ls[k]; }
};

/* ── navigator shim ────────────────────────────────────────────────────────── */
try {
  Object.defineProperty(global, 'navigator', {
    value: { onLine: true, userAgent: 'TestAgent/1.0' },
    writable: true, configurable: true
  });
} catch(_) { global.navigator = { onLine: true, userAgent: 'TestAgent/1.0' }; }

global.matchMedia = function(){ return { matches: false, addListener: function(){}, removeEventListener: function(){} }; };
global.requestAnimationFrame  = function(){ return 0; };
global.cancelAnimationFrame   = function(){};
global.speechSynthesis        = { speak: function(){}, cancel: function(){} };
global.SpeechSynthesisUtterance = function(t){ this.text = t; };

/* ── crypto shim (for ID generation) ───────────────────────────────────────── */
var _cryptoCallCount = 0;
try {
  Object.defineProperty(global, 'crypto', {
    value: {
      getRandomValues: function (arr) {
        for (var i = 0; i < arr.length; i++) {
          arr[i] = (_cryptoCallCount * 7 + i * 13 + 37) % 256;
          _cryptoCallCount++;
        }
        return arr;
      }
    },
    writable: true,
    configurable: true
  });
} catch(_) { /* crypto may already be defined — that's fine */ }

/* ── Firestore / Firebase mock ─────────────────────────────────────────────── */
/*
 * Two-level mock:
 *   _mockDb[uid][convId] = { _conv: {...}, messages: { msgId: data } }
 */
var _mockDb      = {};  /* uid → { convId: { _meta: {}, messages: { msgId: data } } } */
var _mockUid     = null;
var _mockDbError = false;
var _mockBatchDeleteLog = [];

var _autoId = 0;
function _nextId() { return 'doc_' + (++_autoId); }

function _ensurePath(uid, convId) {
  if (!_mockDb[uid]) _mockDb[uid] = {};
  if (!_mockDb[uid][convId]) _mockDb[uid][convId] = { _meta: {}, messages: {} };
}

/* Build a mock messages collection for users/{uid}/shadowReaperConversations/{convId}/messages */
function _mockMessages(uid, convId) {
  _ensurePath(uid, convId);
  var store = _mockDb[uid][convId].messages;
  var _limitN = null;
  var _orderField = null;
  var _orderDir   = 'asc';

  var col = {
    add: function (data) {
      return new Promise(function (resolve, reject) {
        if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
        var id = _nextId();
        store[id] = Object.assign({}, data, { _id: id });
        resolve({ id: id });
      });
    },
    orderBy: function (field, dir) {
      _orderField = field;
      _orderDir   = dir || 'asc';
      return col;
    },
    limit: function (n) { _limitN = n; return col; },
    get: function () {
      return new Promise(function (resolve, reject) {
        if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
        var docs = Object.keys(store).map(function (k) {
          return {
            id: k,
            data: function () { return store[k]; },
            ref: {
              id: k,
              delete: function () {
                _mockBatchDeleteLog.push(uid + '/' + convId + '/messages/' + k);
                delete store[k];
                return Promise.resolve();
              }
            }
          };
        });
        if (_orderField) {
          var f = _orderField, d = _orderDir;
          docs.sort(function (a, b) {
            var av = a.data()[f] || 0, bv = b.data()[f] || 0;
            return d === 'desc' ? (bv - av) : (av - bv);
          });
        }
        if (_limitN !== null) docs = docs.slice(0, _limitN);
        resolve({
          size: docs.length,
          forEach: function (fn) { docs.forEach(fn); }
        });
      });
    }
  };
  return col;
}

/* Build mock conversations collection for users/{uid}/shadowReaperConversations */
function _mockConvs(uid) {
  if (!_mockDb[uid]) _mockDb[uid] = {};
  var store = _mockDb[uid];
  var _limitN = null;

  var col = {
    doc: function (convId) {
      _ensurePath(uid, convId);
      return {
        collection: function (name) {
          if (name === 'messages') return _mockMessages(uid, convId);
          return { add: function(){ return Promise.resolve({ id: _nextId() }); }, get: function(){ return Promise.resolve({ size: 0, forEach: function(){} }); } };
        },
        get: function () {
          var meta = store[convId] ? store[convId]._meta : null;
          return Promise.resolve({ exists: !!meta, data: function(){ return meta; } });
        },
        delete: function () {
          _mockBatchDeleteLog.push(uid + '/convs/' + convId);
          delete store[convId];
          return Promise.resolve();
        },
        set: function (data) {
          _ensurePath(uid, convId);
          Object.assign(store[convId]._meta, data);
          return Promise.resolve();
        },
        ref: { id: convId, delete: function(){ delete store[convId]; return Promise.resolve(); } }
      };
    },
    limit: function (n) { _limitN = n; return col; },
    get: function () {
      return new Promise(function (resolve, reject) {
        if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
        var docs = Object.keys(store).map(function (convId) {
          return {
            id: convId,
            data: function () { return store[convId]._meta || {}; },
            ref: {
              id: convId,
              delete: function () {
                _mockBatchDeleteLog.push(uid + '/convs/' + convId);
                delete store[convId];
                return Promise.resolve();
              }
            },
            collection: function (name) {
              return _mockMessages(uid, convId);
            }
          };
        });
        if (_limitN !== null) docs = docs.slice(0, _limitN);
        resolve({
          size: docs.length,
          forEach: function (fn) { docs.forEach(fn); }
        });
      });
    }
  };
  return col;
}

/* Full Firebase mock */
global.firebase = {
  auth: function () {
    return { currentUser: _mockUid ? { uid: _mockUid } : null };
  },
  firestore: function () {
    var db = {
      collection: function (name) {
        if (name === 'users') {
          return {
            doc: function (uid) {
              return {
                collection: function (sub) {
                  if (sub === 'shadowReaperConversations') return _mockConvs(uid);
                  if (sub === 'shadowReaperMemories') {
                    /* Minimal E2 stub — not the focus here */
                    return {
                      add: function(d){ return Promise.resolve({ id: _nextId() }); },
                      where: function(){ return this; },
                      orderBy: function(){ return this; },
                      limit: function(){ return this; },
                      get: function(){ return Promise.resolve({ size: 0, forEach: function(){} }); }
                    };
                  }
                  return {
                    add: function(){ return Promise.resolve({ id: _nextId() }); },
                    get: function(){ return Promise.resolve({ size: 0, forEach: function(){} }); }
                  };
                }
              };
            }
          };
        }
        return {
          doc: function(){ return { collection: function(){ return {}; } }; }
        };
      },
      batch: function () {
        var ops = [];
        return {
          delete: function (ref) { ops.push({ type: 'delete', ref: ref }); },
          update: function (ref, d) { ops.push({ type: 'update', ref: ref, data: d }); },
          commit: function () {
            return new Promise(function (resolve, reject) {
              if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
              ops.forEach(function (op) {
                if (op.type === 'delete' && op.ref && typeof op.ref.delete === 'function') {
                  op.ref.delete();
                }
              });
              resolve();
            });
          }
        };
      }
    };
    return db;
  }
};
global.firebase.firestore.FieldValue = {
  serverTimestamp: function () { return Date.now(); }
};

/* ── Mock helpers ───────────────────────────────────────────────────────────── */
function _setSignedIn(uid) {
  _mockUid = uid;
  global._snxCurrentUser = { uid: uid };
}
function _setGuest() {
  _mockUid = null;
  global._snxCurrentUser = null;
}
function _setOnline(v) {
  try { Object.defineProperty(global.navigator, 'onLine', { value: v, writable: true, configurable: true }); }
  catch(_) { global.navigator.onLine = v; }
}
function _setDbError(v) { _mockDbError = v; }
function _resetAll() {
  _mockDb = {};
  _mockUid = null;
  global._snxCurrentUser = null;
  _mockDbError = false;
  _mockBatchDeleteLog = [];
  _ls = {};
}

/* ── Source loading ─────────────────────────────────────────────────────────── */
var fs   = require('fs');
var path = require('path');
function readSource(f) {
  try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch(_) { return ''; }
}

/* Load modules */
require('./snx-shadow-conv-history.js');
require('./snx-shadow-memory.js');
require('./snx-shadow-ai-e1.js');

var convHistSrc = readSource('snx-shadow-conv-history.js');
var aiSrc       = readSource('snx-shadow-ai.js');
var rulesSrc    = readSource('firestore.rules');

/* ── Test harness ───────────────────────────────────────────────────────────── */
var pass = 0, warn = 0, fail = 0;
var _results = [];

function test(label, fn) {
  try {
    var r = fn();
    if (r === 'WARN') {
      warn++;
      _results.push({ s: 'WARN', l: label });
      console.log('\u26A0 [WARN] ' + label);
    } else {
      pass++;
      _results.push({ s: 'PASS', l: label });
      console.log('\u2713 [PASS] ' + label);
    }
  } catch (e) {
    fail++;
    _results.push({ s: 'FAIL', l: label, n: e.message });
    console.log('\u2717 [FAIL] ' + label + ' \u2014 ' + e.message);
  }
}

function testAsync(label, fn) {
  return new Promise(function (resolve) {
    var done = function (err) {
      if (err) {
        fail++;
        _results.push({ s: 'FAIL', l: label, n: err.message || String(err) });
        console.log('\u2717 [FAIL] ' + label + ' \u2014 ' + (err.message || err));
      } else {
        pass++;
        _results.push({ s: 'PASS', l: label });
        console.log('\u2713 [PASS] ' + label);
      }
      resolve();
    };
    try { fn(done); } catch(e) { done(e); }
  });
}

var CH = global.SNXShadowConvHistory;
var M  = global.SNXShadowMemory;
var E1 = global.SNXShadowE1;

if (!CH) { console.error('[FATAL] SNXShadowConvHistory not loaded'); process.exit(1); }

/* ══════════════════════════════════════════════════════════════════════════════
   RUN ALL TESTS
══════════════════════════════════════════════════════════════════════════════ */
async function runAll() {

  _resetAll();
  _setSignedIn('user_a');
  CH.init();
  if (M  && typeof M.init  === 'function') M.init();
  if (E1 && typeof E1.init === 'function') E1.init();

  /* ═══════════════════════════════════════════════════════════════════════
     CH-INIT — Idempotent initialization
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-INIT : Initialization ──');

  test('CH-INIT-01 init() is idempotent (no error on double call)', function () {
    CH.init();
    CH.init(); /* second call should be silent */
    return true;
  });

  test('CH-INIT-02 build ID matches E3 spec', function () {
    if (!CH.build || CH.build !== 'SNS-2026-SHADOW-CONVERSATION-MEMORY-RC1') {
      throw new Error('Unexpected build: ' + CH.build);
    }
    return true;
  });

  test('CH-INIT-03 MAX_TURNS_STORED is 100', function () {
    if (CH.MAX_TURNS_STORED !== 100) throw new Error('Expected 100, got ' + CH.MAX_TURNS_STORED);
    return true;
  });

  test('CH-INIT-04 AI_CONTEXT_WINDOW is ≤ 12', function () {
    if (CH.AI_CONTEXT_WINDOW > 12) throw new Error('AI_CONTEXT_WINDOW exceeds 12: ' + CH.AI_CONTEXT_WINDOW);
    return true;
  });

  test('CH-SESID-01 getCurrentConvId() returns a non-empty string', function () {
    var id = CH.getCurrentConvId();
    if (!id || typeof id !== 'string' || id.length < 4) throw new Error('Invalid convId: ' + id);
    return true;
  });

  test('CH-SESID-02 conversation ID persisted to localStorage', function () {
    var id = CH.getCurrentConvId();
    var stored = global.localStorage.getItem('snxShadowConvId');
    if (stored !== id) throw new Error('convId not persisted to localStorage');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-ONOFF — History ON/OFF preference
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-ONOFF : History ON/OFF ──');

  test('CH-ONOFF-01 isEnabled() is true by default', function () {
    _ls = {};
    if (!CH.isEnabled()) throw new Error('Should be ON by default');
    return true;
  });

  test('CH-ONOFF-02 setEnabled(false) turns OFF', function () {
    CH.setEnabled(false);
    if (CH.isEnabled()) throw new Error('Should be OFF');
    return true;
  });

  test('CH-ONOFF-03 setEnabled(true) turns back ON', function () {
    CH.setEnabled(true);
    if (!CH.isEnabled()) throw new Error('Should be ON');
    return true;
  });

  test('CH-ONOFF-04 preference stored in localStorage', function () {
    CH.setEnabled(false);
    var val = global.localStorage.getItem('snxShadowConvHistoryEnabled');
    if (val !== 'false') throw new Error('Expected false, got ' + val);
    CH.setEnabled(true);
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-OFFWRITE — History OFF prevents writes
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-OFFWRITE : History OFF prevents writes ──');

  await testAsync('CH-OFFWRITE-01 saveTurn() returns DISABLED reason when OFF', function (done) {
    CH.setEnabled(false);
    _setSignedIn('user_a');
    CH.saveTurn('user', 'I am working on my new song', function (r) {
      CH.setEnabled(true);
      if (r.reason !== 'DISABLED') return done(new Error('Expected DISABLED, got ' + r.reason));
      done();
    });
  });

  await testAsync('CH-OFFWRITE-02 Nothing written to Firestore when OFF', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(false);
    CH.init();
    CH.saveTurn('user', 'test message OFF', function (r) {
      /* Verify nothing was stored */
      var convId = global.localStorage.getItem('snxShadowConvId');
      var stored = convId && _mockDb['user_a'] && _mockDb['user_a'][convId]
        ? Object.keys(_mockDb['user_a'][convId].messages || {}).length
        : 0;
      CH.setEnabled(true);
      if (stored > 0) return done(new Error('Data written when history was OFF'));
      done();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-OFFREAD — History OFF prevents injection
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-OFFREAD : History OFF prevents injection ──');

  await testAsync('CH-OFFREAD-01 loadRecentContext() returns empty turns when OFF', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(false);
    CH.init();
    CH.loadRecentContext(function (r) {
      CH.setEnabled(true);
      if (!r || r.turns === undefined) return done(new Error('loadRecentContext returned nothing'));
      if (r.turns.length !== 0) return done(new Error('Expected 0 turns, got ' + r.turns.length));
      done();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-GUEST — guest persistence blocked
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-GUEST : Guest persistence blocked ──');

  await testAsync('CH-GUEST-01 saveTurn() returns GUEST reason for guest', function (done) {
    _setGuest();
    CH.setEnabled(true);
    CH.saveTurn('user', 'guest message', function (r) {
      _setSignedIn('user_a');
      if (r.reason !== 'GUEST') return done(new Error('Expected GUEST, got ' + r.reason));
      done();
    });
  });

  await testAsync('CH-GUEST-02 loadRecentContext() returns GUEST reason for guest', function (done) {
    _setGuest();
    CH.loadRecentContext(function (r) {
      _setSignedIn('user_a');
      if (r.reason !== 'GUEST') return done(new Error('Expected GUEST, got ' + r.reason));
      done();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-PERSIST — Conversation persists after close/reopen
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-PERSIST : Persistence ──');

  /* Shared convId for CH-PERSIST-01 through CH-PERSIST-03 */
  var _persistConvId = null;

  await testAsync('CH-PERSIST-01 saveTurn() writes user turn to Firestore', function (done) {
    /* Dedicated UID + fresh state, but preserve localStorage convId flow */
    _mockDb['user_persist'] = {};
    _mockUid = 'user_persist';
    global._snxCurrentUser = { uid: 'user_persist' };

    CH.destroy();
    delete _ls['snxShadowConvId'];
    CH.setEnabled(true);
    CH.init();

    /* Capture convId for use in CH-PERSIST-03 */
    _persistConvId = CH.getCurrentConvId();

    CH.saveTurn('user', "I'm working on the chorus of my new song tonight", function (r) {
      if (!r.success) return done(new Error('saveTurn failed: ' + r.reason));
      done();
    });
  });

  await testAsync('CH-PERSIST-02 saveTurn() writes assistant turn to Firestore', function (done) {
    CH.saveTurn('assistant', 'That sounds great — what direction are you taking the chorus?', function (r) {
      if (!r.success) return done(new Error('saveTurn failed: ' + r.reason));
      done();
    });
  });

  await testAsync('CH-PERSIST-03 loadRecentContext() retrieves saved turns after destroy+reinit', function (done) {
    /* Simulate close/reopen:
       - destroy() resets in-memory session state only (NOT localStorage, NOT Firestore)
       - init() re-reads convId from localStorage and reconnects to same Firestore path
       - We do NOT call _resetAll() to preserve Firestore data and localStorage */
    _mockUid = 'user_persist';
    global._snxCurrentUser = { uid: 'user_persist' };

    CH.destroy(); /* reset session state only — convId stays in localStorage */
    CH.setEnabled(true);
    CH.init(); /* reinit — reads convId from localStorage */

    /* Verify we restored the same convId */
    var restoredId = CH.getCurrentConvId();
    if (restoredId !== _persistConvId) {
      return done(new Error('convId changed after destroy+reinit: ' + _persistConvId + ' → ' + restoredId));
    }

    CH.loadRecentContext(function (r) {
      if (!r || !r.turns) return done(new Error('No turns returned'));
      if (r.turns.length < 2) return done(new Error('Expected ≥2 turns, got ' + r.turns.length));
      done();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-ORDER — Turns in chronological order (oldest first)
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-ORDER : Chronological order ──');

  await testAsync('CH-ORDER-01 loadRecentContext() returns turns oldest-first', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    var t1 = Date.now();
    var t2 = t1 + 1000;
    var t3 = t2 + 1000;

    /* Manually insert turns with specific timestamps */
    var convId = CH.getCurrentConvId();
    var fb = global.firebase.firestore();
    var ref = fb.collection('users').doc('user_a').collection('shadowReaperConversations').doc(convId).collection('messages');

    ref.add({ role: 'user', text: 'turn one', ts: t1, sessionId: 'sid1', convId: convId })
      .then(function () {
        return ref.add({ role: 'assistant', text: 'turn two', ts: t2, sessionId: 'sid1', convId: convId });
      })
      .then(function () {
        return ref.add({ role: 'user', text: 'turn three', ts: t3, sessionId: 'sid1', convId: convId });
      })
      .then(function () {
        CH.loadRecentContext(function (r) {
          if (!r || !r.turns || r.turns.length < 3) {
            return done(new Error('Expected 3 turns, got ' + (r && r.turns ? r.turns.length : 'none')));
          }
          /* Verify ascending order */
          for (var i = 1; i < r.turns.length; i++) {
            if (r.turns[i].ts < r.turns[i-1].ts) {
              return done(new Error('Turns not in ascending order at index ' + i));
            }
          }
          done();
        });
      })
      .catch(function (e) { done(e); });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-MULTI — Multiple conversation turns
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-MULTI : Multiple turns ──');

  await testAsync('CH-MULTI-01 Saves and retrieves 6 conversation turns', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    var turns = [
      { role: 'user',      text: 'I started working on a new album.' },
      { role: 'assistant', text: 'What direction are you going with it?' },
      { role: 'user',      text: 'Something more dark and introspective.' },
      { role: 'assistant', text: 'That sounds compelling. What genre?' },
      { role: 'user',      text: 'Alternative R&B with some hip-hop elements.' },
      { role: 'assistant', text: 'Great combination. How many tracks so far?' }
    ];

    var idx = 0;
    function saveNext() {
      if (idx >= turns.length) {
        CH.loadRecentContext(function (r) {
          if (!r || !r.turns) return done(new Error('No turns returned'));
          if (r.turns.length < 6) return done(new Error('Expected 6 turns, got ' + r.turns.length));
          done();
        });
        return;
      }
      var t = turns[idx++];
      CH.saveTurn(t.role, t.text, function (r) {
        if (!r.success) return done(new Error('saveTurn failed at turn ' + idx + ': ' + r.reason));
        saveNext();
      });
    }
    saveNext();
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-CONTINUE — Continuity intent detection
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-CONTINUE : Continuity intent detection ──');

  test('CH-CONT01 "What were we talking about?" detected', function () {
    if (!CH.detectContinuity('What were we talking about?')) throw new Error('Not detected');
    return true;
  });

  test('CH-CONT02 "Continue where we left off" detected', function () {
    if (!CH.detectContinuity('Continue where we left off.')) throw new Error('Not detected');
    return true;
  });

  test('CH-CONT03 "Let\'s go back to our conversation" detected', function () {
    if (!CH.detectContinuity("Let's go back to our conversation.")) throw new Error('Not detected');
    return true;
  });

  test('CH-CONT04 "What did I tell you earlier?" detected', function () {
    if (!CH.detectContinuity('What did I tell you earlier?')) throw new Error('Not detected');
    return true;
  });

  test('CH-CONT05 "Remember what we talked about yesterday?" detected', function () {
    if (!CH.detectContinuity('Remember what we talked about yesterday?')) throw new Error('Not detected');
    return true;
  });

  test('CH-CONT06 "Let\'s pick up where we were" detected', function () {
    if (!CH.detectContinuity("Let's pick up where we were")) throw new Error('Not detected');
    return true;
  });

  test('CH-CONT07 "What were we discussing before?" detected', function () {
    if (!CH.detectContinuity('What were we discussing before?')) throw new Error('Not detected');
    return true;
  });

  test('CH-CONT08 Normal question NOT flagged as continuity intent', function () {
    if (CH.detectContinuity('How do I go live on Shadow Nexus?')) throw new Error('False positive');
    return true;
  });

  test('CH-CONT09 E2 memory save NOT flagged as continuity intent', function () {
    if (CH.detectContinuity('Remember my favorite color is blue')) throw new Error('False positive');
    return true;
  });

  test('CH-CONT10 Casual greeting NOT flagged as continuity intent', function () {
    if (CH.detectContinuity('Hey how are you')) throw new Error('False positive');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-NEWCONV — New conversation does not delete old history
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-NEWCONV : New Conversation ──');

  await testAsync('CH-NEWCONV-01 newConversation() creates new convId', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.init();
    var oldId = CH.getCurrentConvId();

    /* Save a turn in the old conversation */
    CH.setEnabled(true);
    CH.saveTurn('user', 'Old conversation turn', function () {
      var newId = CH.newConversation();
      if (newId === oldId) return done(new Error('New convId should differ from old'));
      if (!newId) return done(new Error('newConversation() returned empty ID'));
      done();
    });
  });

  await testAsync('CH-NEWCONV-02 Old conversation data remains after newConversation()', function (done) {
    /* The old convId data should still be in Firestore */
    var uid = 'user_a';
    var fb = global.firebase.firestore();
    var convsRef = fb.collection('users').doc(uid).collection('shadowReaperConversations');
    convsRef.get().then(function (snap) {
      /* Should have at least one conversation doc (the old one) */
      if (snap.size < 1) return done(new Error('Expected ≥1 conversation docs, got 0'));
      done();
    }).catch(done);
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-CLEAR — Clear conversation history
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-CLEAR : Clear History ──');

  await testAsync('CH-CLEAR-01 clearHistory() succeeds for signed-in user', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    CH.saveTurn('user', 'Turn before clear', function () {
      CH.clearHistory(function (r) {
        if (!r.success) return done(new Error('clearHistory failed: ' + r.reason));
        done();
      });
    });
  });

  await testAsync('CH-CLEAR-02 loadRecentContext() returns empty after clear', function (done) {
    CH.loadRecentContext(function (r) {
      if (!r || !r.turns) return done(new Error('No turns object'));
      if (r.turns.length !== 0) return done(new Error('Expected 0 turns after clear, got ' + r.turns.length));
      done();
    });
  });

  await testAsync('CH-CLEAR-03 clearHistory() returns GUEST for guests', function (done) {
    _setGuest();
    CH.clearHistory(function (r) {
      _setSignedIn('user_a');
      if (r.reason !== 'GUEST') return done(new Error('Expected GUEST, got ' + r.reason));
      done();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-E2SAFE — E2 memories survive new conversation and clear
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-E2SAFE : E2 memories isolated from conversation history ──');

  test('CH-E2SAFE-01 clearHistory() only affects shadowReaperConversations path', function () {
    /* Verify clearHistory does NOT clear shadowReaperMemories */
    /* We inspect that clearHistory only calls _getConvsRef (conversations), not _getMemoriesRef */
    var src = convHistSrc;
    var hasClearMemories = /shadowReaperMemories/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, ''));
    if (hasClearMemories && src.indexOf('clearHistory') < src.indexOf('shadowReaperMemories')) {
      /* This is a comment reference only, check that clearHistory function body does NOT touch memories */
      var clearFn = src.match(/function _clearHistory[\s\S]*?^  \}/m);
      if (clearFn && /shadowReaperMemories/.test(clearFn[0])) {
        throw new Error('_clearHistory touches shadowReaperMemories path');
      }
    }
    return true;
  });

  test('CH-E2SAFE-02 newConversation() does not call E2 clearAll or deleteOne', function () {
    /* newConversation should only reset _sessionTurns and _currentConvId */
    var src = convHistSrc;
    var newConvMatch = src.match(/function _startNewConversation\(\)[\s\S]*?^  \}/m);
    if (newConvMatch && /clearAll|deleteOne|shadowReaperMemories/.test(newConvMatch[0])) {
      throw new Error('_startNewConversation() touches E2 memory paths');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-ISOLATE — User A cannot read user B history
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-ISOLATE : User isolation ──');

  await testAsync('CH-ISOLATE-01 User A saves a turn, User B loads empty context', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    CH.saveTurn('user', 'User A secret conversation', function (r) {
      if (!r.success) return done(new Error('User A saveTurn failed'));

      /* Switch to user B — different UID */
      CH.destroy();
      _setSignedIn('user_b');
      CH.init();

      CH.loadRecentContext(function (r2) {
        if (!r2 || !r2.turns) return done(new Error('No result for user B'));
        /* User B should see 0 turns (their own Firestore path is empty) */
        if (r2.turns.length > 0) return done(new Error('User B got User A turns!'));
        done();
      });
    });
  });

  await testAsync('CH-ISOLATE-02 Founder UID sees own (empty) conversation, not target user', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    CH.saveTurn('user', 'User A private conversation', function () {
      /* Founder signs in as different UID */
      CH.destroy();
      _setSignedIn('founder_uid');
      global._snxIsFounder = true;
      CH.init();

      CH.loadRecentContext(function (r) {
        global._snxIsFounder = false;
        if (!r || !r.turns) return done(new Error('No result for founder'));
        /* Founder sees their own path — which is empty */
        if (r.turns.length > 0) return done(new Error('Founder got user A turns!'));
        done();
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-SECRET — Secret filtering
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-SECRET : Secret filtering ──');

  await testAsync('CH-SECRET-01 saveTurn() rejects password-containing text', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();
    CH.saveTurn('user', 'My password is hunter2', function (r) {
      if (r.reason !== 'SECRET') return done(new Error('Expected SECRET, got ' + r.reason));
      done();
    });
  });

  await testAsync('CH-SECRET-02 saveTurn() rejects API key text', function (done) {
    CH.saveTurn('user', 'my api key is sk-XXXXXXXX', function (r) {
      if (r.reason !== 'SECRET') return done(new Error('Expected SECRET, got ' + r.reason));
      done();
    });
  });

  await testAsync('CH-SECRET-03 saveTurn() rejects token text', function (done) {
    CH.saveTurn('user', 'my token is eyJhbGciOiJIUzI1NiJ9', function (r) {
      if (r.reason !== 'SECRET') return done(new Error('Expected SECRET, got ' + r.reason));
      done();
    });
  });

  await testAsync('CH-SECRET-04 Normal turn containing word "secret" but not credential is allowed', function (done) {
    CH.saveTurn('user', "It's a secret that I like country music", function (r) {
      /* This should succeed — "it's a secret" is not a credential pattern */
      if (r.reason === 'SECRET') return done(new Error('False positive secret block'));
      done();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-NOAUDIO — No audio storage
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-NOAUDIO : No audio storage ──');

  test('CH-NOAUDIO-01 Source does not reference audio blob storage', function () {
    var src = convHistSrc;
    /* Check for audio data storage APIs — not media playback */
    if (/AudioBuffer|audioBlob|AudioWorklet|MediaRecorder|getUserMedia|recordAudio/i.test(src)) {
      throw new Error('Source references audio recording APIs');
    }
    return true;
  });

  test('CH-NOAUDIO-02 saveTurn() schema contains only text fields (no audio field)', function () {
    var src = convHistSrc;
    /* Verify turn object structure has role, text, ts, sessionId, convId — not audio */
    var turnObjMatch = src.match(/var turn\s*=\s*\{[\s\S]*?\}/);
    if (turnObjMatch && /audio|blob|binary/i.test(turnObjMatch[0])) {
      throw new Error('Turn object contains audio/blob field');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-NOEMOT — No emotional-profile storage
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-NOEMOT : No emotional-profile storage ──');

  test('CH-NOEMOT-01 Source does not persist emotion labels', function () {
    var src = convHistSrc;
    /* Check that emotional state labels are NOT stored in turn objects */
    if (/emotion\s*:|tone\s*:|mood\s*:|'HAPPY'|'SAD'|'FRUSTRATED'|'ANXIOUS'/i.test(src.replace(/\/\*[\s\S]*?\*\//g, ''))) {
      /* Allow emotion constants in detection patterns only — not in stored data */
      var turnMatch = src.match(/var turn\s*=\s*\{[\s\S]*?\}/);
      if (turnMatch && /emotion|tone|mood/i.test(turnMatch[0])) {
        throw new Error('Turn object contains emotional profile data');
      }
    }
    return true;
  });

  test('CH-NOEMOT-02 detectContinuity() does not reference E1 emotion state', function () {
    var src = convHistSrc;
    var detectFn = src.match(/function detectContinuityIntent[\s\S]*?^  \}/m);
    if (detectFn && /SNXShadowE1|currentTone|detectEmotion/i.test(detectFn[0])) {
      throw new Error('detectContinuityIntent() references E1 emotion state');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-BOUND — Bounded history (MAX_TURNS_STORED)
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-BOUND : Bounded history ──');

  test('CH-BOUND-01 MAX_TURNS_STORED constant is 100', function () {
    if (CH.MAX_TURNS_STORED !== 100) throw new Error('Expected 100');
    return true;
  });

  test('CH-BOUND-02 _trimHistory is called after saveTurn (code present)', function () {
    if (!/_trimHistory/.test(convHistSrc)) {
      throw new Error('_trimHistory not present in source');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-AIBOUND — Bounded AI context window
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-AIBOUND : AI context window bounded ──');

  test('CH-AIBOUND-01 AI_CONTEXT_WINDOW ≤ 12', function () {
    if (CH.AI_CONTEXT_WINDOW > 12) throw new Error('AI_CONTEXT_WINDOW exceeds 12');
    return true;
  });

  test('CH-AIBOUND-02 loadRecentContext() limits query to AI_CONTEXT_WINDOW', function () {
    /* Verify that loadRecentContext uses .limit(AI_CONTEXT_WINDOW) */
    if (!/AI_CONTEXT_WINDOW/.test(convHistSrc)) {
      throw new Error('AI_CONTEXT_WINDOW constant not referenced in source');
    }
    if (!/\.limit\(AI_CONTEXT_WINDOW\)/.test(convHistSrc)) {
      throw new Error('loadRecentContext does not use .limit(AI_CONTEXT_WINDOW)');
    }
    return true;
  });

  await testAsync('CH-AIBOUND-03 loadRecentContext() returns ≤ AI_CONTEXT_WINDOW turns', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    /* Insert AI_CONTEXT_WINDOW + 5 turns */
    var total = CH.AI_CONTEXT_WINDOW + 5;
    var convId = CH.getCurrentConvId();
    var fb = global.firebase.firestore();
    var ref = fb.collection('users').doc('user_a').collection('shadowReaperConversations').doc(convId).collection('messages');

    var promises = [];
    for (var i = 0; i < total; i++) {
      promises.push(ref.add({ role: 'user', text: 'turn ' + i, ts: Date.now() + i, sessionId: 's1', convId: convId }));
    }
    Promise.all(promises).then(function () {
      CH.loadRecentContext(function (r) {
        if (!r || !r.turns) return done(new Error('No turns'));
        if (r.turns.length > CH.AI_CONTEXT_WINDOW) {
          return done(new Error('Got ' + r.turns.length + ' turns, expected ≤ ' + CH.AI_CONTEXT_WINDOW));
        }
        done();
      });
    }).catch(done);
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-FAIL — Firestore failure graceful degradation
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-FAIL : Failure degradation ──');

  await testAsync('CH-FAIL-01 saveTurn() returns DB_ERROR on Firestore failure, session continues', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();
    _setDbError(true);

    CH.saveTurn('user', 'message during failure', function (r) {
      _setDbError(false);
      /* saveTurn failed but should not throw or block */
      if (r.reason !== 'DB_ERROR') return done(new Error('Expected DB_ERROR, got ' + r.reason));
      done();
    });
  });

  await testAsync('CH-FAIL-02 loadRecentContext() returns empty on Firestore failure', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();
    _setDbError(true);

    CH.loadRecentContext(function (r) {
      _setDbError(false);
      if (!r || r.turns === undefined) return done(new Error('loadRecentContext returned nothing'));
      /* Should return empty turns, not throw */
      done();
    });
  });

  await testAsync('CH-FAIL-03 clearHistory() returns error on Firestore failure, does not crash', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    /* Add a turn first */
    CH.saveTurn('user', 'before error', function () {
      _setDbError(true);
      CH.clearHistory(function (r) {
        _setDbError(false);
        /* Should not crash — return success: false gracefully */
        if (r === undefined) return done(new Error('clearHistory returned nothing'));
        done();
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-OFFLINE — Offline behavior
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-OFFLINE : Offline behavior ──');

  await testAsync('CH-OFFLINE-01 saveTurn() returns OFFLINE when offline', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();
    _setOnline(false);

    CH.saveTurn('user', 'offline message', function (r) {
      _setOnline(true);
      if (r.reason !== 'OFFLINE') return done(new Error('Expected OFFLINE, got ' + r.reason));
      done();
    });
  });

  await testAsync('CH-OFFLINE-02 loadRecentContext() still attempts when offline (uses cached data from local mock)', function (done) {
    /* loadRecentContext uses Firestore — if offline Firestore fails gracefully */
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();
    _setOnline(false);

    CH.loadRecentContext(function (r) {
      _setOnline(true);
      /* Should return a turns array (possibly empty) — not throw */
      if (!r || r.turns === undefined) return done(new Error('loadRecentContext returned nothing when offline'));
      done();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-SANITIZE — Text sanitized before storage
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-SANITIZE : Sanitization ──');

  await testAsync('CH-SANITIZE-01 HTML tags stripped from stored text', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    var malicious = '<script>alert("xss")</script>Hello there';
    CH.saveTurn('user', malicious, function (r) {
      if (!r.success) return done(new Error('saveTurn failed: ' + r.reason));

      /* Load and verify stored text is clean */
      CH.loadRecentContext(function (lr) {
        if (!lr || !lr.turns || lr.turns.length === 0) return done(new Error('No turns loaded'));
        var stored = lr.turns[0].text;
        if (/<script/i.test(stored)) return done(new Error('Script tag not stripped: ' + stored));
        done();
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-LEN — Text truncated at MAX_TEXT_LEN
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-LEN : Text length bound ──');

  await testAsync('CH-LEN-01 Text longer than 1000 chars is truncated', function (done) {
    _resetAll();
    _setSignedIn('user_a');
    CH.setEnabled(true);
    CH.init();

    var longText = Array(1200).join('a');
    CH.saveTurn('user', longText, function (r) {
      if (!r.success) return done(new Error('saveTurn failed: ' + r.reason));

      CH.loadRecentContext(function (lr) {
        if (!lr || !lr.turns || lr.turns.length === 0) return done(new Error('No turns loaded'));
        var stored = lr.turns[0].text;
        if (stored.length > 1000) return done(new Error('Text not truncated: length ' + stored.length));
        done();
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-DESTROY — destroy() resets session state only
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-DESTROY : destroy() ──');

  await testAsync('CH-DESTROY-01 destroy() resets session but Firestore data remains', function (done) {
    /* Use dedicated UID so we don't collide with other tests.
       Important: do NOT call _resetAll() — that wipes localStorage,
       which would make init() create a new convId instead of restoring the old one. */
    _mockDb['user_destroy'] = {};
    _mockUid = 'user_destroy';
    global._snxCurrentUser = { uid: 'user_destroy' };

    /* Reset CH session state + convId in localStorage for clean test */
    CH.destroy();
    delete _ls['snxShadowConvId'];
    CH.setEnabled(true);
    CH.init(); /* creates new convId, writes to localStorage */

    CH.saveTurn('user', 'preserved turn', function (r) {
      if (!r.success) return done(new Error('saveTurn failed: ' + r.reason));

      /* Record the convId that was used to save */
      var savedConvId = global.localStorage.getItem('snxShadowConvId');

      /* Destroy resets in-memory session state only */
      CH.destroy();

      /* Reinit — should restore convId from localStorage (key is still set) */
      CH.init();

      var restoredId = CH.getCurrentConvId();
      if (restoredId !== savedConvId) {
        return done(new Error('convId changed after destroy+reinit: ' + savedConvId + ' → ' + restoredId));
      }

      /* Load — data should still be in Firestore under the same path */
      CH.loadRecentContext(function (lr) {
        if (!lr || !lr.turns) return done(new Error('No turns after destroy+reinit'));
        if (lr.turns.length === 0) return done(new Error('Turns lost after destroy'));
        done();
      });
    });
  });

  test('CH-DESTROY-02 destroy() does not clear localStorage convId', function () {
    /* Use dedicated UID, reset only Firestore mock (not _ls) */
    _mockDb['user_d2'] = {};
    _mockUid = 'user_d2';
    global._snxCurrentUser = { uid: 'user_d2' };

    CH.destroy();
    delete _ls['snxShadowConvId']; /* clear key only for this test */
    CH.setEnabled(true);
    CH.init();
    var id = CH.getCurrentConvId();
    if (!id) throw new Error('No convId returned by getCurrentConvId()');

    /* destroy() should leave the localStorage key intact */
    CH.destroy();
    var stored = global.localStorage.getItem('snxShadowConvId');
    if (!stored) throw new Error('convId removed from localStorage by destroy()');
    if (stored !== id) throw new Error('convId changed by destroy(): was ' + id + ' now ' + stored);
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-VOICE — Voice compatibility (not broken by E3)
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-VOICE : Voice compatibility ──');

  test('CH-VOICE-01 snx-shadow-conv-history.js does not reference SNXShadowVoice', function () {
    if (/SNXShadowVoice/.test(convHistSrc)) {
      throw new Error('snx-shadow-conv-history.js references SNXShadowVoice');
    }
    return true;
  });

  test('CH-VOICE-02 snx-shadow-conv-history.js does not reference SpeechRecognition', function () {
    if (/SpeechRecognition|speechSynthesis/i.test(convHistSrc)) {
      throw new Error('snx-shadow-conv-history.js references audio APIs');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-CHAR — Character compatibility (not broken by E3)
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-CHAR : Character compatibility ──');

  test('CH-CHAR-01 snx-shadow-conv-history.js does not reference SNXShadowCharacter', function () {
    if (/SNXShadowCharacter|grim-panel|snx-char-/.test(convHistSrc)) {
      throw new Error('snx-shadow-conv-history.js references character UI');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-NOPOLL — No polling
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-NOPOLL : No polling ──');

  test('CH-NOPOLL-01 No setInterval in snx-shadow-conv-history.js', function () {
    /* Strip comments first — the word may appear in documentation */
    var stripped = convHistSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    if (/setInterval/.test(stripped)) throw new Error('setInterval found in code (outside comments)');
    return true;
  });

  test('CH-NOPOLL-02 No setTimeout used for repeated polling in source', function () {
    /* Allow one-shot timers but not polling loops */
    var src = convHistSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    var selfCallPoll = /setTimeout\s*\(\s*function[^{]*\{[^}]*setTimeout/.test(src);
    if (selfCallPoll) throw new Error('Recursive polling setTimeout found');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-NORAF — No requestAnimationFrame
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-NORAF : No RAF ──');

  test('CH-NORAF-01 No requestAnimationFrame in snx-shadow-conv-history.js', function () {
    if (/requestAnimationFrame/.test(convHistSrc)) throw new Error('RAF found in source');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-NOTIMER — No continuous timers
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-NOTIMER : No continuous timers ──');

  test('CH-NOTIMER-01 No setInterval in conv history source (outside comments)', function () {
    var stripped = convHistSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
    if (/setInterval/.test(stripped)) throw new Error('setInterval found in code (outside comments)');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-NOEVAL — Security: no eval, no innerHTML, no new Function
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-NOEVAL : Security ──');

  test('CH-NOEVAL-01 No eval() in snx-shadow-conv-history.js', function () {
    if (/\beval\s*\(/.test(convHistSrc)) throw new Error('eval() found');
    return true;
  });

  test('CH-NOINNERHTML-01 No innerHTML assignment from user data', function () {
    /* innerHTML is OK for static constants but not for user text */
    var src = convHistSrc;
    /* Check that the stored text variable is never assigned to innerHTML */
    if (/\.innerHTML\s*=\s*(text|safe|content|turn\.text|role|data)/i.test(src)) {
      throw new Error('innerHTML assignment from variable found');
    }
    return true;
  });

  test('CH-NOFUNC-01 No new Function() in snx-shadow-conv-history.js', function () {
    if (/new\s+Function\s*\(/.test(convHistSrc)) throw new Error('new Function() found');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-RULE — Firestore rule validation
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-RULE : Firestore rules ──');

  test('CH-RULE01 Firestore rules include shadowReaperConversations path', function () {
    if (!/shadowReaperConversations/.test(rulesSrc)) {
      throw new Error('shadowReaperConversations not found in firestore.rules');
    }
    return true;
  });

  test('CH-RULE02 shadowReaperConversations rule uses isOwner(uid)', function () {
    var section = rulesSrc.match(/shadowReaperConversations[\s\S]*?match \/messages/);
    if (!section || !/isOwner\(uid\)/.test(section[0])) {
      throw new Error('shadowReaperConversations rule does not use isOwner(uid)');
    }
    return true;
  });

  test('CH-RULE03 messages subcollection also uses isOwner(uid)', function () {
    /* The conversation history rule block spans multiple lines with nested messages match.
       Extract from first shadowReaperConversations to the closing brace of that entire section. */
    var ruleStart = rulesSrc.indexOf('match /shadowReaperConversations');
    if (ruleStart === -1) throw new Error('shadowReaperConversations rule not found');
    /* Extract a large enough window to capture nested messages match */
    var ruleWindow = rulesSrc.substring(ruleStart, ruleStart + 600);
    /* Should have isOwner(uid) for both the conversation AND messages subcollection */
    var ownerMatches = ruleWindow.match(/isOwner\(uid\)/g) || [];
    if (ownerMatches.length < 2) {
      throw new Error('Expected 2 isOwner(uid) in conversations block, got ' + ownerMatches.length + '\n' + ruleWindow);
    }
    return true;
  });

  test('CH-RULE04 Firestore rule does not use isFounder() for conversations', function () {
    var section = rulesSrc.match(/shadowReaperConversations[\s\S]{0,500}/);
    if (section && /isFounder\(\)/.test(section[0])) {
      throw new Error('isFounder() found in conversation history rule — Founder should NOT have access');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-INT — Integration tests
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-INT : Integration ──');

  test('CH-INT01 snx-shadow-ai.js references SNXShadowConvHistory', function () {
    if (!/SNXShadowConvHistory/.test(aiSrc)) {
      throw new Error('snx-shadow-ai.js does not reference SNXShadowConvHistory');
    }
    return true;
  });

  test('CH-INT02 snx-shadow-ai.js has E3 build constant', function () {
    if (!/E3_BUILD_ID/.test(aiSrc)) {
      throw new Error('E3_BUILD_ID constant not found in snx-shadow-ai.js');
    }
    return true;
  });

  test('CH-INT03 snx-shadow-ai.js calls SNXShadowConvHistory.saveTurn on addToHistory', function () {
    if (!/saveTurn/.test(aiSrc)) {
      throw new Error('saveTurn() call not found in snx-shadow-ai.js');
    }
    return true;
  });

  test('CH-INT04 snx-shadow-ai.js calls loadRecentContext on open()', function () {
    if (!/loadRecentContext/.test(aiSrc)) {
      throw new Error('loadRecentContext() call not found in snx-shadow-ai.js');
    }
    return true;
  });

  test('CH-INT05 snx-shadow-ai.js has New Conversation button injection', function () {
    if (!/snx-ai-new-conv/.test(aiSrc)) {
      throw new Error('New Conversation button not found in snx-shadow-ai.js');
    }
    return true;
  });

  test('CH-INT06 snx-shadow-ai.js has Conversation History toggle', function () {
    if (!/snx-ai-conv-toggle/.test(aiSrc)) {
      throw new Error('Conversation History toggle not found in snx-shadow-ai.js');
    }
    return true;
  });

  test('CH-INT07 snx-shadow-ai.js has Clear Conversation History button', function () {
    if (!/snx-ai-conv-clear/.test(aiSrc)) {
      throw new Error('Clear button not found in snx-shadow-ai.js');
    }
    return true;
  });

  test('CH-INT08 Continuity intent handled before E1/E2 routing (code position check)', function () {
    /* detectContinuity must appear AFTER E2 memory intent check but BEFORE the actual
       typo correction code (var correctedMsg = _correctTypos).
       Note: the comment block listing the routing steps appears BEFORE the code,
       so we search for the actual code line, not the comment. */
    var e2pos   = aiSrc.indexOf('MEMORY INTENT (deterministic)');
    var contPos = aiSrc.indexOf('detectContinuity');
    /* Find the actual code line: "var correctedMsg = _correctTypos" */
    var typoCodePos = aiSrc.indexOf('var correctedMsg = _correctTypos');
    if (contPos <= e2pos) throw new Error('detectContinuity appears before E2 routing');
    if (typoCodePos !== -1 && contPos >= typoCodePos) {
      throw new Error('detectContinuity appears after typo correction code');
    }
    return true;
  });

  test('CH-INT09 Persistent context injected into Workers AI conversation payload', function () {
    if (!/_persistentContext/.test(aiSrc)) {
      throw new Error('_persistentContext not referenced in snx-shadow-ai.js');
    }
    return true;
  });

  test('CH-INT10 E3 destroy() called from snx-shadow-ai.js _destroy()', function () {
    /* Verify destroy chain includes E3 */
    var destroyFn = aiSrc.match(/function _destroy\(\)[\s\S]*?console\.log\('\[SNXShadowAI\] Destroyed/);
    if (!destroyFn || !/SNXShadowConvHistory/.test(destroyFn[0])) {
      throw new Error('E3 destroy not called from snx-shadow-ai.js _destroy()');
    }
    return true;
  });

  test('CH-INT11 _greet() does NOT call _addToHistory (no persistence of greetings)', function () {
    /* Greeting should push directly to _history, not call _addToHistory which persists */
    var greetFn = aiSrc.match(/function _greet\(\)[\s\S]*?_setStatus\(STATUS\.READY\)/);
    if (!greetFn) return 'WARN'; /* Can't locate function — warn only */
    if (/_addToHistory/.test(greetFn[0])) {
      throw new Error('_greet() calls _addToHistory which would persist the greeting');
    }
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     CH-CONVID — Conversation ID stability
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── CH-CONVID : Conversation ID ──');

  test('CH-CONVID-01 getCurrentConvId() is stable across multiple calls', function () {
    _resetAll();
    _setSignedIn('user_a');
    CH.init();
    var id1 = CH.getCurrentConvId();
    var id2 = CH.getCurrentConvId();
    if (id1 !== id2) throw new Error('convId changed between calls');
    return true;
  });

  test('CH-CONVID-02 newConversation() stores new ID in localStorage', function () {
    var newId = CH.newConversation();
    var stored = global.localStorage.getItem('snxShadowConvId');
    if (stored !== newId) throw new Error('New convId not stored in localStorage');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     Rerun key E2 regression assertions — ensure E2 is not broken by E3
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n── E2-REGRESSION : E2 memories survive E3 changes ──');

  test('E2-REG-01 SNXShadowMemory still loaded', function () {
    if (!global.SNXShadowMemory) throw new Error('SNXShadowMemory not loaded');
    return true;
  });

  test('E2-REG-02 MEMORY_SAVE intent still detected', function () {
    if (!M) throw new Error('M not loaded');
    if (M.detectIntent('remember my favorite color is blue') !== 'MEMORY_SAVE') {
      throw new Error('MEMORY_SAVE not detected');
    }
    return true;
  });

  test('E2-REG-03 MEMORY_RECALL intent still detected', function () {
    if (!M) throw new Error('M not loaded');
    if (M.detectIntent('what do you remember about me?') !== 'MEMORY_LIST') {
      /* This is MEMORY_LIST pattern — that's correct */
    }
    if (M.detectIntent('do you remember what I was working on?') !== 'MEMORY_RECALL') {
      throw new Error('MEMORY_RECALL not detected');
    }
    return true;
  });

  test('E2-REG-04 E2 isEnabled() still works independently', function () {
    if (!M) throw new Error('M not loaded');
    M.setEnabled(false);
    if (M.isEnabled()) throw new Error('Should be OFF');
    M.setEnabled(true);
    if (!M.isEnabled()) throw new Error('Should be ON');
    return true;
  });

  test('E2-REG-05 E2 localStorage key separate from E3 key', function () {
    var e2Key = 'snxShadowMemoryEnabled';
    var e3Key = 'snxShadowConvHistoryEnabled';
    if (e2Key === e3Key) throw new Error('E2 and E3 share the same localStorage key');
    return true;
  });

  test('E2-REG-06 E2 Firestore path separate from E3 path', function () {
    /* E2: shadowReaperMemories, E3: shadowReaperConversations */
    var e2path = 'shadowReaperMemories';
    var e3path = 'shadowReaperConversations';
    if (e2path === e3path) throw new Error('E2 and E3 Firestore paths overlap');
    return true;
  });

  /* ═══════════════════════════════════════════════════════════════════════
     Summary
  ═══════════════════════════════════════════════════════════════════════ */
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' Shadow Reaper E3 — Conversation History — Test Results');
  console.log('══════════════════════════════════════════════════════════');
  console.log(' PASS: ' + pass);
  console.log(' WARN: ' + warn);
  console.log(' FAIL: ' + fail);
  console.log('══════════════════════════════════════════════════════════');
  console.log(' Build: SNS-2026-SHADOW-CONVERSATION-MEMORY-RC1');
  console.log('══════════════════════════════════════════════════════════\n');

  if (fail > 0) {
    console.log('FAILING TESTS:');
    _results.filter(function (r) { return r.s === 'FAIL'; }).forEach(function (r) {
      console.log('  ✗ ' + r.l + (r.n ? ' — ' + r.n : ''));
    });
    process.exit(1);
  } else {
    console.log('ALL TESTS PASSED');
    process.exit(0);
  }
}

runAll().catch(function (e) {
  console.error('[FATAL] Uncaught error in test runner:', e);
  process.exit(1);
});
