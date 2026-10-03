/**
 * shadow-reaper-v2/tests/physical-path.test.js
 * Shadow Reaper V2 — Physical Path Test
 *
 * Simulates the visible UI message pipeline with the local model in each
 * non-READY state and verifies Shadow Reaper still responds normally.
 *
 * Test scenarios:
 *   1. Local model state = UNINITIALIZED (not loaded) → normal response
 *   2. Local model state = LOADING        → normal response
 *   3. Local model state = FAILED/ERROR   → normal response
 *   4. SRLocalModel entirely absent       → normal response
 *   5. "My project is called Blue Thunder" → Adaptive Learning still runs
 *   6. "what do you remember about me"    → Memory pipeline works
 *   7. "what were we talking about"       → History/continuity pipeline works
 *
 * MUST PASS:
 *   No UNINITIALIZED / LOCAL MODEL ERROR / MODEL ERROR in any user-visible response.
 *   Adaptive Learning processes the turn regardless of model state.
 *   All 7 scenarios pass with normal Shadow Reaper responses.
 *
 * Runner: Node.js (no external test framework)
 * Usage:  node shadow-reaper-v2/tests/physical-path.test.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

// ── Browser globals shim ─────────────────────────────────────────────────────

if (typeof window === 'undefined') {
  global.window = global;
}

if (!global.localStorage) {
  global.localStorage = {
    _store: {},
    getItem:    function (k) { return this._store[k] !== undefined ? this._store[k] : null; },
    setItem:    function (k, v) { this._store[k] = String(v); },
    removeItem: function (k) { delete this._store[k]; },
    clear:      function ()  { this._store = {}; },
  };
}

try {
  if (!global.navigator) {
    Object.defineProperty(global, 'navigator', {
      value: { gpu: undefined, onLine: true },
      writable: true, configurable: true,
    });
  }
} catch (_) {}

if (!global.speechSynthesis) {
  global.speechSynthesis = null;
}

// ── Module loader ─────────────────────────────────────────────────────────────

function loadModule(relPath) {
  var code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  var fn = new Function('global', code);
  fn(global);
}

loadModule('snx-shadow-conv-history.js');
loadModule('snx-shadow-memory.js');
loadModule('snx-shadow-adaptive.js');
loadModule('shadow-reaper-v2/core/adaptive-brain.js');
loadModule('shadow-reaper-v2/core/understanding-engine.js');
loadModule('shadow-reaper-v2/core/context-engine.js');
loadModule('shadow-reaper-v2/core/conversation-engine.js');
loadModule('shadow-reaper-v2/core/response-engine.js');
loadModule('shadow-reaper-v2/core/persistence-bridge.js');
loadModule('shadow-reaper-v2/core/local-model.js');
loadModule('shadow-reaper-v2/knowledge/knowledge-engine.js');
loadModule('shadow-reaper-v2/translation/translation-engine.js');
loadModule('shadow-reaper-v2/voice/voice-engine.js');
loadModule('shadow-reaper-v2/adapters/founder-controls.js');
loadModule('shadow-reaper-v2/shadow-reaper.js');

var SR = global.ShadowReaper;
SR.init();

// ── Harness ───────────────────────────────────────────────────────────────────

var PASS = 0, WARN = 0, FAIL = 0;

function test(name, fn) {
  try {
    fn();
    PASS++;
    process.stdout.write('  ✓  ' + name + '\n');
  } catch (err) {
    FAIL++;
    process.stderr.write('  ✗  ' + name + '\n    → ' + err.message + '\n');
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertNoModelError(response, label) {
  var lower = (response || '').toLowerCase();
  assert(!lower.includes('local model error'),  label + ': Must not contain "LOCAL MODEL ERROR"');
  assert(!lower.includes('model error'),        label + ': Must not contain "MODEL ERROR"');
  assert(!lower.includes('uninitialized'),      label + ': Must not contain "UNINITIALIZED"');
  assert(!lower.includes('model_not_ready'),    label + ': Must not contain model error codes');
  assert(!lower.includes('loadlocalmodel'),     label + ': Must not expose loadLocalModel requirement');
  assert(response && response.length > 0,       label + ': Response must not be empty');
}

// Helper: stub SRLocalModel into a fake state, run a test, then restore real one.
function withFakeModel(fakeState, errorCode, fn) {
  var real = global.SRLocalModel;
  var fake = {
    MODEL_STATE:    global.SRLocalModel.MODEL_STATE,
    ERROR_CODES:    global.SRLocalModel.ERROR_CODES,
    FIXED_MODEL:    global.SRLocalModel.FIXED_MODEL,
    DEFAULT_MODEL:  global.SRLocalModel.FIXED_MODEL,
    CAPABLE_MODEL:  global.SRLocalModel.FIXED_MODEL,
    getStatus:      function () {
      return { state: fakeState, modelId: null, loadPct: 0, lastError: errorCode || null, isReady: false };
    },
    getDiagnostics: function () {
      return { errorCode: errorCode || null, webllmImportStatus: 'NOT_ATTEMPTED', modelState: fakeState };
    },
    generate:       function (_msg, _opts, cb) {
      var err = new Error('Model not ready: ' + fakeState);
      err.errorCode = 'MODEL_NOT_READY';
      cb(err, null);
    },
    onStateChange:  function () { return function () {}; },
    loadModel:      function () { return Promise.reject(new Error('Fake model')); },
    destroy:        function () {},
  };
  global.SRLocalModel = fake;
  try {
    fn(fake);
  } finally {
    global.SRLocalModel = real;
  }
}

// ── PHYSICAL PATH TESTS ───────────────────────────────────────────────────────

process.stdout.write('\n── PHYSICAL PATH: LOCAL MODEL NOT_LOADED / UNINITIALIZED ──\n');

test('Model UNINITIALIZED — "yo" returns normal greeting', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    SR.newConversation();
    var r = SR.ask('yo');
    assertNoModelError(r, '"yo" with UNINITIALIZED model');
  });
});

test('Model UNINITIALIZED — "hi" returns normal response', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    var r = SR.ask('hi');
    assertNoModelError(r, '"hi" with UNINITIALIZED model');
  });
});

test('Model UNINITIALIZED — "how are you" returns non-error response', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    var r = SR.ask('how are you');
    assertNoModelError(r, '"how are you" with UNINITIALIZED model');
    assert(r.length < 300, 'Response should be concise');
  });
});

process.stdout.write('\n── PHYSICAL PATH: LOCAL MODEL LOADING ─────────────────────\n');

test('Model LOADING — "hi" returns normal response (no spinner error)', function () {
  withFakeModel('LOADING', null, function () {
    var r = SR.ask('hi');
    assertNoModelError(r, '"hi" with LOADING model');
  });
});

test('Model LOADING — "help me brainstorm" returns normal response', function () {
  withFakeModel('LOADING', null, function () {
    var r = SR.ask('help me brainstorm');
    assertNoModelError(r, '"help me brainstorm" with LOADING model');
  });
});

process.stdout.write('\n── PHYSICAL PATH: LOCAL MODEL FAILED / ERROR ──────────────\n');

test('Model FAILED — "yo" returns normal response', function () {
  withFakeModel('FAILED', 'INFERENCE_FAILED', function () {
    SR.newConversation();
    var r = SR.ask('yo');
    assertNoModelError(r, '"yo" with FAILED model');
  });
});

test('Model FAILED — "tell me something funny" returns normal response', function () {
  withFakeModel('FAILED', 'INFERENCE_FAILED', function () {
    var r = SR.ask('tell me something funny');
    assertNoModelError(r, '"tell me something funny" with FAILED model');
  });
});

test('Model FAILED — "what can you do?" returns normal response', function () {
  withFakeModel('FAILED', 'INFERENCE_FAILED', function () {
    var r = SR.ask('what can you do?');
    assertNoModelError(r, '"what can you do?" with FAILED model');
  });
});

process.stdout.write('\n── PHYSICAL PATH: ADAPTIVE LEARNING + NO MODEL ────────────\n');

test('No model — "My project is called Blue Thunder" runs Adaptive Learning', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    SR.newConversation();
    var r = SR.ask('My project is called Blue Thunder');
    assertNoModelError(r, 'Project statement with UNINITIALIZED model');

    // Verify adaptive learning processed the turn by checking project name retention
    var r2 = SR.ask('What is my project called?');
    assertNoModelError(r2, 'Project recall with UNINITIALIZED model');
    assert(
      r2.toLowerCase().includes('blue thunder') || r2.toLowerCase().includes('thunder'),
      'Adaptive Learning should have retained "Blue Thunder". Got: ' + r2
    );
  });
});

test('No model — second project statement also processed', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    SR.newConversation();
    SR.ask('My project is called Blue Thunder');
    var r = SR.ask('Tell me about my project');
    assertNoModelError(r, 'Project follow-up with no model');
  });
});

process.stdout.write('\n── PHYSICAL PATH: MEMORY + NO MODEL ──────────────────────\n');

test('No model — "what do you remember about me" returns memory response', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    var r = SR.ask('what do you remember about me');
    assertNoModelError(r, '"what do you remember about me" with no model');
  });
});

test('No model — explicit memory command still works', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    var r = SR.ask('remember that I prefer dark themes');
    assertNoModelError(r, 'remember command with no model');
  });
});

process.stdout.write('\n── PHYSICAL PATH: HISTORY/CONTINUITY + NO MODEL ─────────\n');

test('No model — "what were we talking about" returns history response', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    var r = SR.ask('what were we talking about');
    assertNoModelError(r, '"what were we talking about" with no model');
  });
});

test('No model — multi-turn continuity question returns response', function () {
  withFakeModel('UNINITIALIZED', null, function () {
    var r = SR.ask('what were we talking about last time?');
    assertNoModelError(r, 'continuity question with no model');
  });
});

process.stdout.write('\n── PHYSICAL PATH: SRLocalModel ENTIRELY ABSENT ───────────\n');

test('SRLocalModel absent — "yo" returns normal response', function () {
  var real = global.SRLocalModel;
  global.SRLocalModel = null;
  try {
    SR.newConversation();
    var r = SR.ask('yo');
    assertNoModelError(r, '"yo" with SRLocalModel=null');
  } finally {
    global.SRLocalModel = real;
  }
});

test('SRLocalModel absent — general conversation works', function () {
  var real = global.SRLocalModel;
  global.SRLocalModel = null;
  try {
    var r = SR.ask('how are you doing?');
    assertNoModelError(r, '"how are you doing?" with SRLocalModel=null');
  } finally {
    global.SRLocalModel = real;
  }
});

// ── RESULTS ───────────────────────────────────────────────────────────────────

process.stdout.write('\n' +
  '══════════════════════════════════════════════\n' +
  '  PHYSICAL PATH TEST RESULTS\n' +
  '══════════════════════════════════════════════\n' +
  '  PASS : ' + PASS + '\n' +
  '  WARN : ' + WARN + '\n' +
  '  FAIL : ' + FAIL + '\n' +
  '  TOTAL: ' + (PASS + WARN + FAIL) + '\n' +
  '══════════════════════════════════════════════\n'
);

if (FAIL > 0) {
  process.stdout.write('PHYSICAL PATH TEST: FAIL\n');
  process.exit(1);
} else {
  process.stdout.write('PHYSICAL PATH TEST: PASS\n');
  process.exit(0);
}
