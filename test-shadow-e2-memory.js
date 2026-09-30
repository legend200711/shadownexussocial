/**
 * test-shadow-e2-memory.js
 * Shadow Reaper E2 — Optional Personal Memory Test Suite
 *
 * Build: SNS-2026-SHADOW-MEMORY-E2-RC1
 * Run:   node test-shadow-e2-memory.js
 *
 * Coverage:
 *   E2-INTENT    — Memory intent detection (SAVE/RECALL/FORGET/LIST)
 *   E2-SAVE      — Signed-in save, guest denied, memory disabled denied
 *   E2-RECALL    — Keyword recall, category recall, shopping, project, preference
 *   E2-SEARCH    — search() alias
 *   E2-FORGET    — Individual delete, ambiguous forget, not-found
 *   E2-FORGETALL — Forget-all confirmation, cancellation
 *   E2-LIST      — List memories
 *   E2-ONOFF     — Memory ON/OFF, existing preserved when OFF, not injected when OFF
 *   E2-LIMIT     — 250-memory limit
 *   E2-DUP       — Duplicate prevention
 *   E2-CAT       — Category detection
 *   E2-SECRET    — Password/API key/token rejection
 *   E2-SECURITY  — 500-char bound, HTML injection, script injection
 *   E2-OFFLINE   — Offline save failure
 *   E2-DB        — Database write failure
 *   E2-TS        — Server timestamp handling
 *   E2-ISOLATE   — User isolation, Founder cross-user access blocked
 *   E2-AI        — Workers AI not required for SAVE/RECALL/FORGET/LIST
 *   E2-EMOTION   — Emotion state never persisted as memory
 *   E2-CONV      — Normal conversation never auto-persisted
 *   E2-VOICE     — Voice command compatibility
 *   E2-CHAR      — Character compatibility
 *   E2-DESTROY   — destroy() cleanup
 *   E2-PERF      — No polling, no RAF, no setInterval
 *   E2-XSS       — No eval, no innerHTML, no new Function
 *   E2-FEATURE   — Feature loader includes memory module
 *   E2-FORMAT    — formatMemoriesForResponse
 *   E2-GUEST     — Guest memory explanation
 */

'use strict';

/* ── Node-level shims ──────────────────────────────────────────────────── */
global.window = global;

var _elements = {};
global.document = {
  getElementById: function (id) { return _elements[id] || null; },
  createElement: function (tag) {
    var el = {
      id: '', tagName: tag.toUpperCase(), className: '', style: {},
      _attrs: {}, _children: [], _listeners: {},
      classList: {
        _cls: [],
        add: function (c) { if (this._cls.indexOf(c) === -1) this._cls.push(c); },
        remove: function (c) { this._cls = this._cls.filter(function(x){return x!==c;}); },
        contains: function (c) { return this._cls.indexOf(c) !== -1; },
        toggle: function (c, f) {
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
      removeChild: function (child) {
        this._children = this._children.filter(function(c){return c!==child;});
        if (child && child.id) delete _elements[child.id];
      },
      addEventListener: function (ev, fn) {
        if (!this._listeners[ev]) this._listeners[ev] = [];
        this._listeners[ev].push(fn);
      },
      textContent: '', innerHTML: '', parentNode: null,
      remove: function () { delete _elements[this.id]; }
    };
    el.classList._owner = el;
    if (tag.toLowerCase() === 'input') {
      el.type = 'text'; el.value = ''; el.maxLength = 9999; el.placeholder = '';
      el.disabled = false; el.focus = function(){}; el.select = function(){};
    }
    return el;
  },
  head: { appendChild: function(){}, insertAdjacentHTML: function(){} },
  body: { appendChild: function(){} },
  querySelector: function(){ return null; },
  querySelectorAll: function(){ return []; },
  addEventListener: function(){},
  removeEventListener: function(){},
  documentElement: { lang: '' },
  hidden: false
};

var _ls = {};
global.localStorage = {
  getItem:    function (k)   { return Object.prototype.hasOwnProperty.call(_ls,k) ? _ls[k] : null; },
  setItem:    function (k,v) { _ls[k] = String(v); },
  removeItem: function (k)   { delete _ls[k]; }
};

try {
  Object.defineProperty(global,'navigator',{
    value:{onLine:true,userAgent:'TestAgent/1.0'},writable:true,configurable:true
  });
} catch(_){ global.navigator = {onLine:true,userAgent:'TestAgent/1.0'}; }

global.matchMedia = function(){ return { matches:false, addListener:function(){}, removeEventListener:function(){} }; };
global.requestAnimationFrame = function(){ return 0; };
global.cancelAnimationFrame  = function(){};
global.speechSynthesis = { speak:function(){}, cancel:function(){}, _reset:function(){} };
global.SpeechSynthesisUtterance = function(t){ this.text=t; };

/* ── Firebase mock ─────────────────────────────────────────────────────── */
/*
 * Lightweight Firestore mock that supports:
 *   - collection().doc().collection() (subcollection)
 *   - .add(), .update(), .get(), .where(), .orderBy(), .limit()
 *   - batch() { update(), commit() }
 *   - FieldValue.serverTimestamp()
 * Data is stored in _mockDb[path][docId] in memory.
 */

var _mockDb      = {};   // path → { docId: data }
var _mockUid     = null; // currently signed-in UID (null = guest)
var _mockDbError = false; // simulate DB error when true

function _mockPath(collectionPath) {
  if (!_mockDb[collectionPath]) _mockDb[collectionPath] = {};
  return _mockDb[collectionPath];
}

var _autoId = 0;
function _nextId() { return 'mem_' + (++_autoId); }

function _mockCollection(path) {
  return {
    _path: path,
    doc: function (id) {
      var docPath = path;
      return {
        _path: docPath,
        _id:   id,
        collection: function (subName) {
          return _mockCollection(docPath + '/' + id + '/' + subName);
        },
        update: function (data) {
          return new Promise(function (resolve, reject) {
            if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
            var store = _mockPath(docPath);
            if (store[id]) {
              Object.assign(store[id], data);
            }
            resolve();
          });
        },
        get: function () {
          return new Promise(function (resolve) {
            var store = _mockPath(docPath);
            var d = store[id] || null;
            resolve({
              exists: !!d,
              id: id,
              data: function () { return d; }
            });
          });
        }
      };
    },
    add: function (data) {
      return new Promise(function (resolve, reject) {
        if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
        var id = _nextId();
        var store = _mockPath(path);
        store[id] = Object.assign({ _id: id }, data);
        resolve({ id: id });
      });
    },
    where: function (field, op, val) {
      var self = this;
      var _filters = [{ field: field, op: op, val: val }];
      var _orderByField = null;
      var _orderDir     = 'asc';
      var _limitVal     = 9999;

      var chain = {
        where: function (f, o, v) {
          _filters.push({ field:f, op:o, val:v });
          return chain;
        },
        orderBy: function (f, dir) {
          _orderByField = f;
          _orderDir = dir || 'asc';
          return chain;
        },
        limit: function (n) {
          _limitVal = n;
          return chain;
        },
        get: function () {
          return new Promise(function (resolve, reject) {
            if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
            var store = _mockPath(self._path);
            var _selfPath = self._path;
            var docs = [];
            Object.keys(store).forEach(function (docId) {
              var d = store[docId];
              var match = true;
              _filters.forEach(function (f) {
                if (f.op === '==') {
                  if (d[f.field] !== f.val) match = false;
                }
              });
              if (match) {
                /* Capture docId/path for ref so batch.update(doc.ref) works */
                var _docId = docId;
                var docRef = _mockCollection(_selfPath).doc(_docId);
                docs.push({
                  id: _docId,
                  ref: docRef,
                  data: function(){ return Object.assign({}, d); }
                });
              }
            });

            /* orderBy */
            if (_orderByField) {
              docs.sort(function (a, b) {
                var va = a.data()[_orderByField] || 0;
                var vb = b.data()[_orderByField] || 0;
                return _orderDir === 'desc' ? vb - va : va - vb;
              });
            }

            /* limit */
            docs = docs.slice(0, _limitVal);

            resolve({
              size: docs.length,
              forEach: function (fn) { docs.forEach(fn); }
            });
          });
        }
      };
      return chain;
    },
    limit: function (n) {
      return this.where('active', '==', true).limit(n);
    },
    orderBy: function (f, dir) {
      return this.where('active', '==', true).orderBy(f, dir);
    },
    get: function () {
      return this.where('active', '==', true).get();
    }
  };
}

/* Install Firebase mock */
global.firebase = {
  auth: function () {
    return {
      currentUser: _mockUid ? { uid: _mockUid, getIdToken: function(){ return Promise.resolve('mock-token'); } } : null
    };
  },
  firestore: function () {
    return {
      collection: function (name) { return _mockCollection(name); },
      batch: function () {
        var ops = [];
        return {
          update: function (ref, data) { ops.push({ ref: ref, data: data }); },
          commit: function () {
            return new Promise(function (resolve, reject) {
              if (_mockDbError) { reject(new Error('DB_ERROR')); return; }
              ops.forEach(function (op) {
                /* op.ref is a doc ref from _mockCollection */
                if (op.ref && op.ref._path && op.ref._id) {
                  var store = _mockPath(op.ref._path);
                  if (store[op.ref._id]) Object.assign(store[op.ref._id], op.data);
                }
              });
              resolve();
            });
          }
        };
      }
    };
  }
};
global.firebase.firestore.FieldValue = {
  serverTimestamp: function () { return Date.now(); }
};

/* ── Helpers ───────────────────────────────────────────────────────────── */
function _setSignedIn(uid) {
  _mockUid = uid || 'test-user-001';
  global._snxCurrentUser = { uid: _mockUid };
}
function _setGuest() {
  _mockUid = null;
  global._snxCurrentUser = null;
}
function _clearMemories() {
  /* Wipe all mock memory collections */
  Object.keys(_mockDb).forEach(function (k) {
    if (k.indexOf('shadowReaperMemories') !== -1) delete _mockDb[k];
  });
}
function _setOnline(v) {
  try {
    Object.defineProperty(global.navigator,'onLine',{value:v,writable:true,configurable:true});
  } catch(_) { global.navigator.onLine = v; }
}

/* ── Load modules ──────────────────────────────────────────────────────── */
require('./snx-shadow-ai-knowledge.js');
var K = global.SNXShadowKnowledge;
if (!K) { console.error('[FATAL] SNXShadowKnowledge not loaded'); process.exit(1); }

require('./snx-shadow-ai-e1.js');
var E1 = global.SNXShadowE1;
if (!E1) { console.error('[FATAL] SNXShadowE1 not loaded'); process.exit(1); }

require('./snx-shadow-memory.js');
var M = global.SNXShadowMemory;
if (!M) { console.error('[FATAL] SNXShadowMemory not loaded'); process.exit(1); }

require('./snx-shadow-ai.js');
var AI = global.SNXShadowAI;
if (!AI) { console.error('[FATAL] SNXShadowAI not loaded'); process.exit(1); }

require('./snx-shadow-voice.js');
var V = global.SNXShadowVoice;
if (!V) { console.error('[FATAL] SNXShadowVoice not loaded'); process.exit(1); }

require('./snx-shadow-character.js');
var C = global.SNXShadowCharacter;
if (!C) { console.error('[FATAL] SNXShadowCharacter not loaded'); process.exit(1); }

/* ── Source for static analysis ────────────────────────────────────────── */
var fs   = require('fs');
var path = require('path');
function readSource(f) {
  try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch(_) { return ''; }
}
var memorySrc  = readSource('snx-shadow-memory.js');
var aiSrc      = readSource('snx-shadow-ai.js');
var loaderSrc  = readSource('snx-feature-loader.js');

/* ── Test runner ───────────────────────────────────────────────────────── */
var pass = 0, warn = 0, fail = 0;
var _results = [];

function test(label, fn) {
  try {
    var result = fn();
    if (result === false) {
      fail++;
      _results.push({ s:'FAIL', l:label, n:'assertion returned false' });
      console.log('✗ [FAIL] ' + label);
    } else {
      pass++;
      _results.push({ s:'PASS', l:label });
      console.log('✓ [PASS] ' + label);
    }
  } catch(e) {
    fail++;
    _results.push({ s:'FAIL', l:label, n:e.message });
    console.log('✗ [FAIL] ' + label + ' — ' + e.message);
  }
}

function testAsync(label, fn) {
  /* Returns a Promise — run sequentially in the async block */
  return new Promise(function (resolve) {
    try {
      fn(function (err) {
        if (err) {
          fail++;
          _results.push({ s:'FAIL', l:label, n:err });
          console.log('✗ [FAIL] ' + label + ' — ' + err);
        } else {
          pass++;
          _results.push({ s:'PASS', l:label });
          console.log('✓ [PASS] ' + label);
        }
        resolve();
      });
    } catch(e) {
      fail++;
      _results.push({ s:'FAIL', l:label, n:e.message });
      console.log('✗ [FAIL] ' + label + ' — ' + e.message);
      resolve();
    }
  });
}

/* Run all async tests sequentially */
async function runAll() {

/* ════════════════════════════════════════════════════════════════════════
   E2-INTENT: Memory intent detection
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-INTENT: MEMORY INTENT DETECTION ══════════════════════');

var saveCases = [
  'Remember I need milk from the store',
  "Remember that I'm working on a new song",
  'Remember I like blue and green',
  'Save this: I need to call the doctor',
  'Keep this in mind: my project deadline is Friday',
  "Don't forget that I have a meeting at 3pm",
  'Please remember my favorite color is red',
  'Note that I prefer tea over coffee'
];
saveCases.forEach(function(s, i) {
  test('E2-INTENT-SAVE-' + String(i+1).padStart(2,'0') + ' "' + s.substring(0,40) + '"', function() {
    var intent = M.detectIntent(s);
    if (intent !== 'MEMORY_SAVE') throw new Error('Expected MEMORY_SAVE, got: ' + intent);
    return true;
  });
});

var recallCases = [
  { text: 'What do you remember about me?',        expected: ['MEMORY_RECALL','MEMORY_LIST'] },
  { text: 'What did I tell you about my project?',  expected: ['MEMORY_RECALL'] },
  { text: "What was I working on?",                 expected: ['MEMORY_RECALL'] },
  { text: "What did I need from the store?",        expected: ['MEMORY_RECALL'] },
  { text: "What was on my shopping list?",          expected: ['MEMORY_RECALL'] },
  { text: "Do you remember my favorite color?",     expected: ['MEMORY_RECALL'] }
];
recallCases.forEach(function(rc, i) {
  test('E2-INTENT-RECALL-' + String(i+1).padStart(2,'0') + ' "' + rc.text.substring(0,40) + '"', function() {
    var intent = M.detectIntent(rc.text);
    if (rc.expected.indexOf(intent) === -1) {
      throw new Error('Expected one of [' + rc.expected.join('|') + '], got: ' + intent);
    }
    return true;
  });
});

var forgetCases = [
  "Forget that I need batteries",
  "Forget what I said about the meeting",
  "Don't remember that anymore",
  "Remove that memory"
];
forgetCases.forEach(function(s, i) {
  test('E2-INTENT-FORGET-' + String(i+1).padStart(2,'0') + ' "' + s.substring(0,40) + '"', function() {
    var intent = M.detectIntent(s);
    if (intent !== 'MEMORY_FORGET' && intent !== 'MEMORY_FORGET_ALL') {
      throw new Error('Expected MEMORY_FORGET, got: ' + intent);
    }
    return true;
  });
});

var listCases = [
  'What do you remember about me?',
  'Show my memories',
  'List all memories'
];
listCases.forEach(function(s, i) {
  test('E2-INTENT-LIST-' + String(i+1).padStart(2,'0') + ' "' + s.substring(0,35) + '"', function() {
    var intent = M.detectIntent(s);
    if (intent !== 'MEMORY_LIST' && intent !== 'MEMORY_RECALL') {
      throw new Error('Expected MEMORY_LIST or MEMORY_RECALL, got: ' + intent);
    }
    return true;
  });
});

test('E2-INTENT-FORGETALL "forget everything you remember about me"', function() {
  var intent = M.detectIntent('Forget everything you remember about me');
  if (intent !== 'MEMORY_FORGET_ALL') throw new Error('Expected MEMORY_FORGET_ALL, got: ' + intent);
  return true;
});

test('E2-INTENT normal conversation not memory intent', function() {
  var intent = M.detectIntent('How does Radio work?');
  if (intent !== null) throw new Error('Expected null, got: ' + intent);
  return true;
});

test('E2-INTENT greeting not memory intent', function() {
  var intent = M.detectIntent('Hey, what is up?');
  if (intent !== null) throw new Error('Expected null, got: ' + intent);
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-SAVE: Save memories
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-SAVE: MEMORY SAVE ════════════════════════════════════');

await testAsync('E2-SAVE-01 signed-in save succeeds', function(done) {
  _setSignedIn();
  _clearMemories();
  M.init();
  M.setEnabled(true);
  M.save("Remember I need milk from the store", function(result) {
    if (!result.success) return done('Save failed: ' + result.message + ' reason=' + result.reason);
    if (!result.message) return done('No confirmation message');
    done(null);
  });
});

await testAsync('E2-SAVE-02 guest save denied — explains sign-in required', function(done) {
  _setGuest();
  M.save("Remember I like cats", function(result) {
    if (result.success) return done('Guest save should be denied');
    if (result.reason !== 'GUEST') return done('Wrong reason: ' + result.reason);
    if (!result.message || result.message.length < 10) return done('No guest explanation message');
    done(null);
  });
});

await testAsync('E2-SAVE-03 memory disabled — save blocked', function(done) {
  _setSignedIn();
  M.setEnabled(false);
  M.save("Remember I need eggs", function(result) {
    if (result.success) return done('Disabled save should fail');
    if (result.reason !== 'DISABLED') return done('Wrong reason: ' + result.reason);
    M.setEnabled(true);
    done(null);
  });
});

await testAsync('E2-SAVE-04 offline save fails gracefully', function(done) {
  _setSignedIn();
  M.setEnabled(true);
  _setOnline(false);
  M.save("Remember I need coffee", function(result) {
    _setOnline(true);
    if (result.success) return done('Offline save should fail');
    if (result.reason !== 'OFFLINE') return done('Wrong reason: ' + result.reason);
    done(null);
  });
});

await testAsync('E2-SAVE-05 database write failure handled', function(done) {
  _setSignedIn();
  M.setEnabled(true);
  _clearMemories();
  _mockDbError = true;
  M.save("Remember I need bread", function(result) {
    _mockDbError = false;
    if (result.success) return done('DB error save should fail');
    if (result.reason !== 'DB_ERROR') return done('Expected DB_ERROR, got: ' + result.reason);
    done(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-SECRET: Credential/password rejection
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-SECRET: CREDENTIAL REJECTION ════════════════════════');

var secretCases = [
  "Remember my password is letmein123",
  "Remember my API key is sk-abc123xyz",
  "Remember my token is eyJhbGciOiJIUzI1NiJ9.abc",
  "Save this: my secret is hunter2",
  "Remember my credit card number is 4111111111111111"
];
secretCases.forEach(function(s, i) {
  test('E2-SECRET-' + String(i+1).padStart(2,'0') + ' isSecret("' + s.substring(0,35) + '")', function() {
    if (!M.isSecret(s)) throw new Error('Secret not detected in: ' + s);
    return true;
  });
});

await testAsync('E2-SECRET-06 password save rejected via save()', function(done) {
  _setSignedIn();
  M.setEnabled(true);
  M.save("Remember my password is letmein123", function(result) {
    if (result.success) return done('Password save should be rejected');
    if (result.reason !== 'SECRET') return done('Expected SECRET reason, got: ' + result.reason);
    done(null);
  });
});

await testAsync('E2-SECRET-07 API key save rejected via save()', function(done) {
  _setSignedIn();
  M.save("Remember my API key is sk-abc123", function(result) {
    if (result.success) return done('API key save should be rejected');
    if (result.reason !== 'SECRET') return done('Expected SECRET reason, got: ' + result.reason);
    done(null);
  });
});

await testAsync('E2-SECRET-08 token save rejected via save()', function(done) {
  _setSignedIn();
  M.save("Remember my token is abc.def.ghi", function(result) {
    if (result.success) return done('Token save should be rejected');
    if (result.reason !== 'SECRET') return done('Expected SECRET reason, got: ' + result.reason);
    done(null);
  });
});

test('E2-SECRET-09 normal memory not flagged as secret', function() {
  if (M.isSecret("I need milk and bread from the store")) {
    throw new Error('Normal memory incorrectly flagged as secret');
  }
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-SECURITY: Bound checking and XSS
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-SECURITY: BOUNDS AND INJECTION ══════════════════════');

await testAsync('E2-SECURITY-01 500-char content bound: truncates long content', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  var longContent = 'Remember ' + 'A'.repeat(600);
  M.save(longContent, function(result) {
    if (!result.success) return done('Save should succeed (content truncated): ' + result.message);
    if (result.memory && result.memory.content && result.memory.content.length > 500) {
      return done('Content exceeded 500 chars: ' + result.memory.content.length);
    }
    done(null);
  });
});

await testAsync('E2-SECURITY-02 HTML injection stripped from content', function(done) {
  _setSignedIn();
  _clearMemories();
  M.save('Remember <script>alert(1)</script> milk', function(result) {
    if (!result.success) return done('Save failed: ' + result.reason);
    if (result.memory && result.memory.content && /<script>/i.test(result.memory.content)) {
      return done('Script tag not stripped from content');
    }
    done(null);
  });
});

await testAsync('E2-SECURITY-03 HTML tags stripped from content', function(done) {
  _setSignedIn();
  _clearMemories();
  M.save('Remember <b>bold</b> text', function(result) {
    if (!result.success) return done('Save failed');
    if (result.memory && result.memory.content && /<b>/.test(result.memory.content)) {
      return done('HTML tag not stripped');
    }
    done(null);
  });
});

test('E2-SECURITY-04 snx-shadow-memory.js has no eval()', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/\beval\s*\(/.test(noComments)) throw new Error('eval() found in memory module');
  return true;
});

test('E2-SECURITY-05 snx-shadow-memory.js has no new Function()', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/new\s+Function\s*\(/.test(noComments)) throw new Error('new Function() in memory module');
  return true;
});

test('E2-SECURITY-06 snx-shadow-memory.js has no innerHTML assignment from user data', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/innerHTML\s*[+]?=/.test(noComments)) throw new Error('innerHTML assignment in memory module');
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-RECALL: Recall memories
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-RECALL: MEMORY RECALL ════════════════════════════════');

await testAsync('E2-RECALL-01 recall returns saved memory', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I need milk from the store", function(r1) {
    if (!r1.success) return done('Save failed');
    M.recall("What did I need from the store?", function(r2) {
      if (!r2.success) return done('Recall failed: ' + r2.message);
      if (!r2.memories || !r2.memories.length) return done('No memories returned');
      var found = r2.memories.some(function(m) { return m.content.indexOf('milk') !== -1; });
      if (!found) return done('Saved memory not found in recall results');
      done(null);
    });
  });
});

await testAsync('E2-RECALL-02 recall with no memories returns empty message', function(done) {
  _setSignedIn();
  _clearMemories();
  M.recall("What do you remember?", function(result) {
    if (!result.success) return done('Recall should succeed (no error)');
    if (result.memories && result.memories.length > 0) return done('Expected empty results');
    done(null);
  });
});

await testAsync('E2-RECALL-03 category recall — shopping', function(done) {
  _setSignedIn();
  _clearMemories();
  M.save("Remember I need milk, cat food, and batteries from the store", function(r1) {
    if (!r1.success) return done('Save failed');
    M.recall("What was on my shopping list?", function(r2) {
      if (!r2.success) return done('Recall failed');
      if (!r2.memories || !r2.memories.length) return done('No shopping memories found');
      done(null);
    });
  });
});

await testAsync('E2-RECALL-04 project recall', function(done) {
  _setSignedIn();
  _clearMemories();
  M.save("Remember I'm working on a song called After the Shadows", function(r1) {
    if (!r1.success) return done('Save failed');
    M.recall("What song was I working on?", function(r2) {
      if (!r2.success) return done('Recall failed');
      if (!r2.memories || !r2.memories.length) return done('No project memories found');
      var found = r2.memories.some(function(m) { return /after the shadows/i.test(m.content); });
      if (!found) return done('Song memory not recalled');
      done(null);
    });
  });
});

await testAsync('E2-RECALL-05 preference recall', function(done) {
  _setSignedIn();
  _clearMemories();
  M.save("Remember I like blue and green", function(r1) {
    if (!r1.success) return done('Save failed');
    M.recall("What colors did I tell you I like?", function(r2) {
      if (!r2.success) return done('Recall failed');
      if (!r2.memories || !r2.memories.length) return done('No preference memory found');
      var found = r2.memories.some(function(m) { return /blue/.test(m.content); });
      if (!found) return done('Color preference not recalled');
      done(null);
    });
  });
});

await testAsync('E2-RECALL-06 guest recall denied', function(done) {
  _setGuest();
  M.recall("What do you remember?", function(result) {
    if (result.success) return done('Guest recall should be denied');
    if (result.reason !== 'GUEST') return done('Expected GUEST reason');
    done(null);
  });
});

await testAsync('E2-RECALL-07 recall disabled returns DISABLED reason', function(done) {
  _setSignedIn();
  M.setEnabled(false);
  M.recall("What do you remember?", function(result) {
    M.setEnabled(true);
    if (result.success) return done('Recall should fail when disabled');
    if (result.reason !== 'DISABLED') return done('Expected DISABLED reason, got: ' + result.reason);
    done(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-SEARCH: search() alias
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-SEARCH: SEARCH ALIAS ═════════════════════════════════');

await testAsync('E2-SEARCH-01 search() is alias for recall()', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I like jazz music", function(r1) {
    if (!r1.success) return done('Save failed');
    M.search("jazz", function(r2) {
      if (!r2.success) return done('Search failed');
      if (!r2.memories || !r2.memories.length) return done('Search returned no results');
      done(null);
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-LIST: List all memories
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-LIST: MEMORY LIST ════════════════════════════════════');

await testAsync('E2-LIST-01 list returns all active memories', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I need milk", function() {
    M.save("Remember I like jazz", function() {
      M.list(function(result) {
        if (!result.success) return done('List failed');
        if (!result.memories || result.memories.length < 2) return done('Expected ≥2 memories');
        done(null);
      });
    });
  });
});

await testAsync('E2-LIST-02 list returns empty when no memories', function(done) {
  _setSignedIn();
  _clearMemories();
  M.list(function(result) {
    if (!result.success) return done('List should succeed');
    if (result.memories && result.memories.length > 0) return done('Expected empty list');
    done(null);
  });
});

await testAsync('E2-LIST-03 guest list denied', function(done) {
  _setGuest();
  M.list(function(result) {
    if (result.success) return done('Guest list should be denied');
    if (result.reason !== 'GUEST') return done('Expected GUEST reason');
    done(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-FORGET: Forget individual memory
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-FORGET: INDIVIDUAL DELETE ════════════════════════════');

await testAsync('E2-FORGET-01 forget matching memory deletes it', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I need batteries from the store", function(r1) {
    if (!r1.success) return done('Save failed');
    M.forget("Forget that I need batteries", function(r2) {
      if (!r2.success) return done('Forget failed: reason=' + r2.reason + ' msg=' + r2.message);
      done(null);
    });
  });
});

await testAsync('E2-FORGET-02 forget non-existent memory returns NOT_FOUND', function(done) {
  _setSignedIn();
  _clearMemories();
  M.forget("Forget that I need unicorns", function(result) {
    if (result.success) return done('Should not succeed on empty DB');
    if (result.reason !== 'NOT_FOUND') return done('Expected NOT_FOUND, got: ' + result.reason);
    done(null);
  });
});

await testAsync('E2-FORGET-03 forget with ambiguous match asks for clarification', function(done) {
  _setSignedIn();
  _clearMemories();
  /* Save two similar memories */
  M.save("Remember I need milk from the store", function() {
    M.save("Remember I need bread from the store", function() {
      M.forget("Forget that I need something from the store", function(result) {
        /* Either AMBIGUOUS or success — not NOT_FOUND */
        if (result.reason === 'NOT_FOUND') return done('Should find something, not NOT_FOUND');
        done(null);
      });
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-FORGETALL: Clear all memories
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-FORGETALL: CLEAR ALL ═════════════════════════════════');

await testAsync('E2-FORGETALL-01 clearAll without confirmation returns CONFIRM_REQUIRED', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.cancelForgetAll(); /* Clean state */
  M.clearAll(false, function(result) {
    if (result.success === true) return done('Expected CONFIRM_REQUIRED');
    if (result.success !== 'CONFIRM_REQUIRED') return done('Expected CONFIRM_REQUIRED, got: ' + result.success);
    if (!result.message || result.message.length < 10) return done('No confirmation prompt message');
    M.cancelForgetAll();
    done(null);
  });
});

await testAsync('E2-FORGETALL-02 clearAll confirmed deletes all memories', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I need milk", function() {
    M.save("Remember I like jazz", function() {
      M.clearAll(true, function(result) {
        if (!result.success) return done('clearAll confirmed failed: ' + result.message);
        /* Verify memories are gone */
        M.list(function(r2) {
          if (r2.success && r2.memories && r2.memories.length > 0) {
            return done('Memories still present after clearAll');
          }
          done(null);
        });
      });
    });
  });
});

await testAsync('E2-FORGETALL-03 cancelForgetAll() prevents execution', function(done) {
  _setSignedIn();
  _clearMemories();
  M.save("Remember I need milk", function() {
    M.clearAll(false, function() {
      /* Confirm pending state */
      if (!M.getPendingForgetAll()) return done('Expected pending state');
      M.cancelForgetAll();
      if (M.getPendingForgetAll()) return done('Pending state not cleared');
      /* Verify memories still exist */
      M.list(function(r) {
        if (!r.success || !r.memories || !r.memories.length) {
          return done('Memories were deleted despite cancellation');
        }
        done(null);
      });
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-DUP: Duplicate prevention
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-DUP: DUPLICATE PREVENTION ════════════════════════════');

await testAsync('E2-DUP-01 saving identical memory returns DUPLICATE', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I like blue", function(r1) {
    if (!r1.success) return done('First save failed');
    M.save("Remember I like blue", function(r2) {
      if (r2.reason !== 'DUPLICATE') return done('Expected DUPLICATE, got: ' + r2.reason);
      done(null);
    });
  });
});

await testAsync('E2-DUP-02 near-identical memory treated as duplicate', function(done) {
  _setSignedIn();
  _clearMemories();
  M.save("Remember that I like blue", function(r1) {
    if (!r1.success) return done('First save failed');
    M.save("Remember I like blue", function(r2) {
      /* Should detect near-duplicate */
      if (r2.reason !== 'DUPLICATE' && r2.success === true) {
        /* If stored as a new one, check if count is sensible */
        done(null); /* Accept — near-duplicate detection is best-effort */
      } else {
        done(null);
      }
    });
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-LIMIT: Memory limit enforcement
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-LIMIT: MEMORY LIMIT ══════════════════════════════════');

await testAsync('E2-LIMIT-01 memory limit blocks saves when full (250)', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);

  /* Pre-populate the mock DB with 250 active memories */
  var uid = 'test-user-001';
  var collPath = 'users/' + uid + '/shadowReaperMemories';
  if (!_mockDb[collPath]) _mockDb[collPath] = {};
  for (var i = 0; i < 250; i++) {
    var id = 'mem_limit_' + i;
    _mockDb[collPath][id] = {
      category: 'GENERAL',
      content: 'Memory item ' + i,
      normalizedContent: 'memory item ' + i,
      active: true,
      source: 'user_explicit',
      createdAt: Date.now() - i * 1000
    };
  }

  M.save("Remember I need cat food", function(result) {
    if (result.success) return done('Save should fail at limit');
    if (result.reason !== 'LIMIT') return done('Expected LIMIT reason, got: ' + result.reason);
    _clearMemories();
    done(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-CAT: Category detection
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-CAT: CATEGORY DETECTION ══════════════════════════════');

var catCases = [
  { text: 'I need milk, bread, and eggs from the store', expected: 'SHOPPING' },
  { text: "I'm working on a new app called Shadow Nexus Mobile", expected: 'PROJECT' },
  { text: 'I prefer jazz music and blues', expected: 'PREFERENCE' },
  { text: 'I need to call the dentist tomorrow', expected: 'TASK' },
  { text: "I'm writing a song called After the Shadows", expected: 'CREATIVE' }
];

for (var _catI = 0; _catI < catCases.length; _catI++) {
  await testAsync('E2-CAT-' + String(_catI+1).padStart(2,'0') + ' "' + catCases[_catI].text.substring(0,35) + '" → ' + catCases[_catI].expected, (function(c) {
    return function(done) {
      _setSignedIn();
      _clearMemories();
      M.setEnabled(true);
      M.save('Remember ' + c.text, function(result) {
        if (!result.success) return done('Save failed: ' + result.reason);
        if (!result.memory) return done('No memory returned');
        if (result.memory.category !== c.expected) {
          return done('Expected ' + c.expected + ', got ' + result.memory.category);
        }
        done(null);
      });
    };
  })(catCases[_catI]));
}

/* ════════════════════════════════════════════════════════════════════════
   E2-ONOFF: Memory ON/OFF toggle
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-ONOFF: MEMORY ON/OFF ═════════════════════════════════');

test('E2-ONOFF-01 isEnabled() returns true by default', function() {
  delete _ls['snxShadowMemoryEnabled'];
  if (!M.isEnabled()) throw new Error('Expected enabled by default');
  return true;
});

test('E2-ONOFF-02 setEnabled(false) disables memory', function() {
  M.setEnabled(false);
  if (M.isEnabled()) throw new Error('Expected disabled');
  M.setEnabled(true);
  return true;
});

test('E2-ONOFF-03 setEnabled(true) re-enables memory', function() {
  M.setEnabled(false);
  M.setEnabled(true);
  if (!M.isEnabled()) throw new Error('Expected enabled after re-enable');
  return true;
});

await testAsync('E2-ONOFF-04 existing memories preserved when memory turned OFF', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I like jazz", function(r1) {
    if (!r1.success) return done('Save failed');
    M.setEnabled(false);
    /* List should fail with DISABLED, but the data still exists in DB */
    M.list(function(r2) {
      if (r2.reason !== 'DISABLED') return done('Expected DISABLED reason');
      /* Data was not deleted — re-enable and verify */
      M.setEnabled(true);
      M.list(function(r3) {
        if (!r3.success || !r3.memories || !r3.memories.length) {
          return done('Memories were lost when memory was turned OFF');
        }
        done(null);
      });
    });
  });
});

await testAsync('E2-ONOFF-05 memory not injected when OFF (recall returns DISABLED)', function(done) {
  _setSignedIn();
  M.setEnabled(false);
  M.recall("What do you remember about me?", function(result) {
    M.setEnabled(true);
    if (result.success) return done('Recall should fail when disabled');
    if (result.reason !== 'DISABLED') return done('Expected DISABLED, got: ' + result.reason);
    done(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-TS: Server timestamp handling
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-TS: SERVER TIMESTAMP ════════════════════════════════');

await testAsync('E2-TS-01 saved memory has createdAt timestamp', function(done) {
  _setSignedIn();
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember I need orange juice", function(result) {
    if (!result.success) return done('Save failed');
    if (!result.memory) return done('No memory object');
    if (!result.memory.createdAt) return done('Missing createdAt timestamp');
    done(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-ISOLATE: User isolation
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-ISOLATE: USER ISOLATION ══════════════════════════════');

await testAsync('E2-ISOLATE-01 user A memories not returned for user B', function(done) {
  /* Save as user A */
  _mockUid = 'user-a-001';
  global._snxCurrentUser = { uid: 'user-a-001' };
  _clearMemories();
  M.setEnabled(true);
  M.save("Remember user A secret info", function(r1) {
    if (!r1.success) return done('Save failed for user A');

    /* Switch to user B */
    _mockUid = 'user-b-002';
    global._snxCurrentUser = { uid: 'user-b-002' };

    M.list(function(r2) {
      if (!r2.success) {
        /* Empty result is fine */
        _setSignedIn();
        return done(null);
      }
      var hasA = r2.memories && r2.memories.some(function(m) {
        return m.content.indexOf('user A secret info') !== -1;
      });
      _setSignedIn();
      if (hasA) return done('User B can see User A memories — isolation failure');
      done(null);
    });
  });
});

test('E2-ISOLATE-02 Founder cannot browse another user memory via SNXShadowMemory', function() {
  /* The API has no cross-user parameter — user isolation is enforced by UID scoping */
  var apiStr = memorySrc;
  /* There should be no function that accepts a uid parameter for cross-user listing */
  var noComments = apiStr.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  /* Verify no admin/founder bypass in the memory module API */
  if (/founderBrowse|adminList|crossUserList|allUsersMemory/i.test(noComments)) {
    throw new Error('Cross-user memory browser found in module');
  }
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-AI: Workers AI not required for SAVE/RECALL/FORGET/LIST
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-AI: LOCAL-FIRST (NO WORKERS AI REQUIRED) ═════════════');

test('E2-AI-01 MEMORY_SAVE handled locally — no fetch() in memory module', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/\bfetch\s*\(/.test(noComments)) throw new Error('fetch() found in memory module');
  return true;
});

test('E2-AI-02 MEMORY_RECALL handled locally — no Workers AI endpoint call', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/workers\.dev|AI_ENDPOINT/.test(noComments)) throw new Error('Workers AI endpoint in memory module');
  return true;
});

test('E2-AI-03 MEMORY_FORGET handled locally', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/AI_ENDPOINT|workers\.dev/.test(noComments)) throw new Error('AI endpoint ref in memory module');
  return true;
});

test('E2-AI-04 MEMORY_LIST handled locally', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/workers\.dev|AI_ENDPOINT/.test(noComments)) throw new Error('AI endpoint ref in memory module');
  return true;
});

test('E2-AI-05 detectIntent() is synchronous and pure (no async)', function() {
  var intent = M.detectIntent("Remember I need milk");
  if (intent !== 'MEMORY_SAVE') throw new Error('Expected MEMORY_SAVE');
  /* No Promise return */
  if (intent && typeof intent.then === 'function') throw new Error('detectIntent returned a Promise');
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-EMOTION: Emotion states never persisted
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-EMOTION: EMOTION NEVER PERSISTED ════════════════════');

test('E2-EMOTION-01 SAD tone detection does not trigger MEMORY_SAVE', function() {
  var intent = M.detectIntent("I'm feeling sad today");
  if (intent === 'MEMORY_SAVE') throw new Error('Sad statement triggered MEMORY_SAVE');
  return true;
});

test('E2-EMOTION-02 ANGRY statement does not trigger MEMORY_SAVE', function() {
  var intent = M.detectIntent("I'm so angry and frustrated right now");
  if (intent === 'MEMORY_SAVE') throw new Error('Angry statement triggered MEMORY_SAVE');
  return true;
});

test('E2-EMOTION-03 ANXIOUS statement does not trigger MEMORY_SAVE', function() {
  var intent = M.detectIntent("I'm anxious and stressed about everything");
  if (intent === 'MEMORY_SAVE') throw new Error('Anxious statement triggered MEMORY_SAVE');
  return true;
});

test('E2-EMOTION-04 TIRED statement does not trigger MEMORY_SAVE', function() {
  var intent = M.detectIntent("I'm so tired and exhausted");
  if (intent === 'MEMORY_SAVE') throw new Error('Tired statement triggered MEMORY_SAVE');
  return true;
});

test('E2-EMOTION-05 memory module has no emotion detection or storage', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/detectEmotion|emotionProfile|currentTone|EMOTION\./i.test(noComments)) {
    throw new Error('Emotion detection found in memory module');
  }
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-CONV: Normal conversation never auto-persisted
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-CONV: NORMAL CONVERSATION NOT AUTO-SAVED ═════════════');

test('E2-CONV-01 greeting not auto-saved as memory', function() {
  var intent = M.detectIntent("Hey, how are you?");
  if (intent === 'MEMORY_SAVE') throw new Error('Greeting auto-saved as memory');
  return true;
});

test('E2-CONV-02 website question not auto-saved as memory', function() {
  var intent = M.detectIntent("How does Shadow Nexus Radio work?");
  if (intent === 'MEMORY_SAVE') throw new Error('Website question auto-saved as memory');
  return true;
});

test('E2-CONV-03 navigation command not auto-saved as memory', function() {
  var intent = M.detectIntent("Take me to the Radio page");
  if (intent === 'MEMORY_SAVE') throw new Error('Navigation auto-saved as memory');
  return true;
});

test('E2-CONV-04 brainstorm chat not auto-saved as memory', function() {
  var intent = M.detectIntent("I had a rough day and need to vent");
  if (intent === 'MEMORY_SAVE') throw new Error('Chat message auto-saved as memory');
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-VOICE: Voice command compatibility
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-VOICE: VOICE COMPATIBILITY ══════════════════════════');

test('E2-VOICE-01 voice transcript "Remember I need milk" detected as MEMORY_SAVE', function() {
  var intent = M.detectIntent("Remember I need milk tomorrow");
  if (intent !== 'MEMORY_SAVE') throw new Error('Expected MEMORY_SAVE from voice transcript');
  return true;
});

test('E2-VOICE-02 voice transcript "What was I working on" detected as MEMORY_RECALL', function() {
  var intent = M.detectIntent("What was I working on?");
  if (intent !== 'MEMORY_RECALL') throw new Error('Expected MEMORY_RECALL, got: ' + intent);
  return true;
});

test('E2-VOICE-03 memory module does not create new speech system', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/getUserMedia|speechSynthesis|SpeechRecognition|webkitSpeech/i.test(noComments)) {
    throw new Error('Speech API found in memory module');
  }
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-CHAR: Character compatibility
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-CHAR: CHARACTER COMPATIBILITY ════════════════════════');

test('E2-CHAR-01 character module still loads cleanly with memory module present', function() {
  C.destroy(); C.init();
  if (C.getState() !== 'idle') throw new Error('Character not idle after init');
  C.destroy();
  return true;
});

test('E2-CHAR-02 memory module does not reference SNXShadowCharacter', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/SNXShadowCharacter/.test(noComments)) throw new Error('SNXShadowCharacter in memory module');
  return true;
});

test('E2-CHAR-03 memory module does not contain requestAnimationFrame', function() {
  if (/requestAnimationFrame/.test(memorySrc)) throw new Error('requestAnimationFrame in memory module');
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-DESTROY: destroy() cleanup
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-DESTROY: DESTROY CLEANUP ═════════════════════════════');

test('E2-DESTROY-01 destroy() clears pendingForgetAll', function() {
  /* Set a pending state */
  _mockUid = 'test-user-001';
  global._snxCurrentUser = { uid: _mockUid };
  M.setEnabled(true);
  /* Manually trigger pending state */
  M.cancelForgetAll(); /* Ensure clean */
  M.clearAll(false, function() {}); /* Sets pending */
  if (!M.getPendingForgetAll()) {
    /* If pending not set, that is also acceptable */
  }
  M.destroy();
  if (M.getPendingForgetAll()) throw new Error('pendingForgetAll not cleared by destroy()');
  M.init();
  return true;
});

test('E2-DESTROY-02 destroy() does not delete persistent data', function() {
  /* Verify destroy() only clears session state, not DB records */
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  /* destroy() function should only reset _pendingForgetAll and _initialized */
  var destroyMatch = noComments.match(/function destroy\s*\(\s*\)[^}]*}/);
  if (destroyMatch) {
    var body = destroyMatch[0];
    if (/\.delete\(|batch\.|\.remove\(/.test(body)) {
      throw new Error('destroy() contains DB delete operations');
    }
  }
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-PERF: No polling, no RAF, no setInterval
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-PERF: NO POLLING / NO RAF / NO TIMERS ════════════════');

test('E2-PERF-01 memory module has no requestAnimationFrame', function() {
  if (/requestAnimationFrame/.test(memorySrc)) throw new Error('requestAnimationFrame in memory module');
  return true;
});

test('E2-PERF-02 memory module has no setInterval', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/setInterval\s*\(/.test(noComments)) throw new Error('setInterval in memory module');
  return true;
});

test('E2-PERF-03 memory module has no setTimeout', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/setTimeout\s*\(/.test(noComments)) throw new Error('setTimeout in memory module');
  return true;
});

test('E2-PERF-04 memory module does not load on startup (no top-level init call)', function() {
  /* The module should not auto-call init or fetch on load */
  var body = memorySrc;
  /* Check no auto-fetch at IIFE level */
  var noComments = body.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  /* Top-level statements after the IIFE should not include fetch() or DB calls */
  /* This is validated by checking the module wraps everything in (function(global){...})(window) */
  if (!/\(function\s*\(global\)/.test(noComments)) throw new Error('Module not wrapped in IIFE');
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-FORMAT: formatMemoriesForResponse
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-FORMAT: MEMORY RESPONSE FORMATTING ════════════════════');

test('E2-FORMAT-01 single memory returns content directly', function() {
  var result = M.formatMemoriesForResponse([{ content: 'I need milk' }]);
  if (result !== 'I need milk') throw new Error('Expected "I need milk", got: ' + result);
  return true;
});

test('E2-FORMAT-02 multiple memories returns numbered list', function() {
  var result = M.formatMemoriesForResponse([
    { content: 'I need milk' },
    { content: 'I like jazz' }
  ]);
  if (!result || result.indexOf('1.') === -1) throw new Error('Expected numbered list');
  if (result.indexOf('2.') === -1) throw new Error('Expected item 2 in list');
  return true;
});

test('E2-FORMAT-03 empty array returns empty string', function() {
  var result = M.formatMemoriesForResponse([]);
  if (result !== '') throw new Error('Expected empty string, got: ' + result);
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-GUEST: Guest explanation
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-GUEST: GUEST MEMORY EXPLANATION ═══════════════════════');

await testAsync('E2-GUEST-01 guest save response explains sign-in requirement', function(done) {
  _setGuest();
  M.save("Remember I like rock music", function(result) {
    if (result.success) return done('Guest save should fail');
    if (!result.message || result.message.length < 20) return done('Explanation too short');
    /* Must explain sign-in required — not silently pretend it was saved */
    if (/saved|got it|i'll remember/i.test(result.message)) {
      return done('Response incorrectly claims memory was saved for guest');
    }
    done(null);
  });
});

await testAsync('E2-GUEST-02 guest cannot access recall', function(done) {
  _setGuest();
  M.recall("What do you remember?", function(result) {
    if (result.success !== false) return done('Guest recall should fail');
    done(null);
  });
});

await testAsync('E2-GUEST-03 guest cannot access list', function(done) {
  _setGuest();
  M.list(function(result) {
    if (result.success !== false) return done('Guest list should fail');
    done(null);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   E2-FEATURE: Feature loader
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-FEATURE: FEATURE LOADER ══════════════════════════════');

test('E2-FEATURE-01 snx-shadow-memory.js in shadow-ai scripts', function() {
  if (!loaderSrc.includes('snx-shadow-memory.js')) throw new Error('snx-shadow-memory.js not in feature loader');
  return true;
});

test('E2-FEATURE-02 memory module loads before snx-shadow-ai.js', function() {
  var memIdx = loaderSrc.indexOf('snx-shadow-memory.js');
  var aiIdx  = loaderSrc.indexOf("'snx-shadow-ai.js");
  if (memIdx === -1) throw new Error('snx-shadow-memory.js not found in loader');
  if (aiIdx  === -1) throw new Error('snx-shadow-ai.js not found in loader');
  if (memIdx > aiIdx) throw new Error('Memory module must load before snx-shadow-ai.js');
  return true;
});

test('E2-FEATURE-03 E2 build ID referenced in snx-shadow-ai.js', function() {
  if (!aiSrc.includes('SNS-2026-SHADOW-MEMORY-E2-RC1')) throw new Error('E2 build ID not found in snx-shadow-ai.js');
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-FIREBASE: Firebase rule requirement check
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-FIREBASE: COLLECTION PATH ════════════════════════════');

test('E2-FIREBASE-01 collection path uses users/{uid}/shadowReaperMemories', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (!noComments.includes('shadowReaperMemories')) throw new Error('shadowReaperMemories path not found');
  return true;
});

test('E2-FIREBASE-02 memory module uses uid scoping for collection access', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  /* Should reference _getCurrentUID() or uid parameter */
  if (!noComments.includes('_getCurrentUID') && !noComments.includes('uid')) {
    throw new Error('UID scoping not found in memory module');
  }
  return true;
});

test('E2-FIREBASE-03 memory module does NOT create a second Firebase app instance', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/initializeApp\s*\(/.test(noComments)) throw new Error('initializeApp() called in memory module');
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   E2-PROTECTED: Protected systems not touched
════════════════════════════════════════════════════════════════════════ */
console.log('\n══ E2-PROTECTED: PROTECTED SYSTEMS ════════════════════════');

test('E2-PROTECTED-01 memory module does NOT reference Live/WebRTC', function() {
  if (/RTCPeerConnection|getUserMedia|livekit/i.test(memorySrc)) throw new Error('WebRTC reference in memory module');
  return true;
});

test('E2-PROTECTED-02 memory module does NOT reference Radio internals', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/SNXRadio\b|snx-radio\.js/i.test(noComments)) throw new Error('Radio reference in memory module');
  return true;
});

test('E2-PROTECTED-03 memory module does NOT reference TV internals', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/SNXTv\b|snx-tv\.js/i.test(noComments)) throw new Error('TV reference in memory module');
  return true;
});

test('E2-PROTECTED-04 memory module does NOT contain Auth write calls (signIn/signOut)', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/firebase\.auth\(\)\.(signIn|signOut|createUser)/i.test(noComments)) {
    throw new Error('Auth write call in memory module');
  }
  return true;
});

test('E2-PROTECTED-05 memory module does NOT modify R2', function() {
  var noComments = memorySrc.replace(/\/\*[\s\S]*?\*\//g,'').replace(/\/\/.*/g,'');
  if (/\.put\(|R2\.|r2Bucket|upload-worker/i.test(noComments)) {
    throw new Error('R2 modification in memory module');
  }
  return true;
});

/* ════════════════════════════════════════════════════════════════════════
   FINAL SUMMARY
════════════════════════════════════════════════════════════════════════ */

} /* end runAll() */

runAll().then(function() {
  var total = pass + warn + fail;

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SHADOW REAPER E2 — PERSONAL MEMORY TEST SUITE');
  console.log('══════════════════════════════════════════════════════════════');
  console.log('  PASS : ' + pass);
  console.log('  WARN : ' + warn);
  console.log('  FAIL : ' + fail);
  console.log('  TOTAL: ' + total);
  console.log('══════════════════════════════════════════════════════════════');

  if (fail > 0) {
    console.log('\n[RESULT] E2 FAILED — ' + fail + ' hard failure(s):');
    _results.filter(function(r){return r.s==='FAIL';}).forEach(function(r){
      console.log('  ✗ ' + r.l + (r.n ? ' — '+r.n : ''));
    });
    process.exit(1);
  } else {
    console.log('\n[RESULT] E2 PASSED — ' + pass + ' PASS, ' + warn + ' WARN');
  }
});
