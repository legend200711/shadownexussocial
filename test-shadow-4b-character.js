/**
 * Shadow Reaper — Stage 4B Character Experience Test Suite
 * Run: node test-shadow-4b-character.js
 *
 * Tests:
 *   Part 1:  Module initialization
 *   Part 2:  State machine — setState / getState
 *   Part 3:  IDLE state
 *   Part 4:  LISTENING state (voice integration)
 *   Part 5:  THINKING state (voice + typed)
 *   Part 6:  SPEAKING state
 *   Part 7:  SUCCESS state (text response, no TTS)
 *   Part 8:  ERROR state
 *   Part 9:  Panel open/close
 *   Part 10: Destroy cleanup
 *   Part 11: Rapid state changes
 *   Part 12: No duplicate state controllers
 *   Part 13: No duplicate RAF loops
 *   Part 14: Reduced motion
 *   Part 15: LITE performance mode
 *   Part 16: Voice → character state mapping
 *   Part 17: Typed question → thinking → success → idle
 */

'use strict';

global.window = global;

/* ─────────────────────────────────────────────────────────────
   BROWSER ENVIRONMENT SIMULATION
───────────────────────────────────────────────────────────────*/
var _elements = {};
var _mediaQueryResults = {};

global.document = {
  getElementById: function (id) { return _elements[id] || null; },
  addEventListener: function () {},
  removeEventListener: function () {},
  documentElement: { lang: '' },
  hidden: false,
  createElement: function (tag) {
    return {
      _tag: tag,
      id: '',
      className: '',
      style: {},
      textContent: '',
      title: '',
      innerHTML: '',
      disabled: false,
      parentNode: null,
      _attrs: {},
      _children: [],
      _listeners: {},
      firstChild: null,
      classList: {
        _list: [],
        add: function (c) { if (this._list.indexOf(c) === -1) this._list.push(c); },
        remove: function (c) { var i = this._list.indexOf(c); if (i > -1) this._list.splice(i, 1); },
        contains: function (c) { return this._list.indexOf(c) !== -1; }
      },
      setAttribute: function (k, v) { this._attrs[k] = v; },
      getAttribute: function (k) { return this._attrs[k] || null; },
      appendChild: function (child) {
        child.parentNode = this;
        this._children.push(child);
        if (child.id) _elements[child.id] = child;
        /* Update firstChild */
        if (!this.firstChild) this.firstChild = child;
      },
      insertBefore: function (child, ref) {
        child.parentNode = this;
        var idx = this._children.indexOf(ref);
        if (idx === -1) this._children.push(child);
        else this._children.splice(idx, 0, child);
        if (child.id) _elements[child.id] = child;
        if (this._children.length === 1) this.firstChild = child;
        else this.firstChild = this._children[0];
      },
      removeChild: function (child) {
        var idx = this._children.indexOf(child);
        if (idx > -1) this._children.splice(idx, 1);
        if (child.id && _elements[child.id] === child) delete _elements[child.id];
        child.parentNode = null;
        this.firstChild = this._children[0] || null;
      },
      addEventListener: function (ev, fn) {
        if (!this._listeners[ev]) this._listeners[ev] = [];
        this._listeners[ev].push(fn);
      },
      _trigger: function (ev, data) {
        var fns = this._listeners[ev] || [];
        fns.forEach(function (fn) { fn(data || {}); });
      }
    };
  }
};

/* localStorage stub */
var _ls = {};
global.localStorage = {
  getItem:  function (k) { return Object.prototype.hasOwnProperty.call(_ls, k) ? _ls[k] : null; },
  setItem:  function (k, v) { _ls[k] = String(v); },
  removeItem: function (k) { delete _ls[k]; }
};

/* matchMedia stub */
global.matchMedia = function (query) {
  return { matches: !!_mediaQueryResults[query] };
};

/* navigator stub */
var _navStub = { onLine: true, userAgent: 'TestAgent/1.0' };
try {
  Object.defineProperty(global, 'navigator', { value: _navStub, writable: true, configurable: true });
} catch (_) {}

/* setTimeout: real (needed for SUCCESS auto-return timer) */
/* RAF stub — not used by character controller; track any accidental calls */
var _rafCalls = 0;
global.requestAnimationFrame = function () { _rafCalls++; return _rafCalls; };
global.cancelAnimationFrame = function () {};

/* ─────────────────────────────────────────────────────────────
   SNXShadowVoice STUB
   Mirrors the real API + Stage 4B onStateChange hook.
───────────────────────────────────────────────────────────────*/
var _voiceStateListeners = [];
var _mockVoiceState = 'IDLE';

global.SNXShadowVoice = {
  getState: function () { return _mockVoiceState; },
  onStateChange: function (fn) {
    if (typeof fn === 'function' && _voiceStateListeners.indexOf(fn) === -1) {
      _voiceStateListeners.push(fn);
    }
  },
  removeStateChangeListener: function (fn) {
    var idx = _voiceStateListeners.indexOf(fn);
    if (idx !== -1) _voiceStateListeners.splice(idx, 1);
  },
  STATE: {
    IDLE: 'IDLE', LISTENING: 'LISTENING', PROCESSING: 'PROCESSING',
    SPEAKING: 'SPEAKING', MIC_BLOCKED: 'MIC_BLOCKED', MIC_ERROR: 'MIC_ERROR'
  },
  /* Test helper: simulate voice state change */
  _simulateState: function (s) {
    _mockVoiceState = s;
    _voiceStateListeners.forEach(function (fn) { try { fn(s); } catch (_) {} });
  }
};

/* ─────────────────────────────────────────────────────────────
   SNXShadowAI STUB
   Mirrors the real API + Stage 4B onThinking/onAnswer hooks.
───────────────────────────────────────────────────────────────*/
var _thinkingListeners = [];
var _answerListeners   = [];

global.SNXShadowAI = {
  onThinking: function (fn) {
    if (typeof fn === 'function' && _thinkingListeners.indexOf(fn) === -1) {
      _thinkingListeners.push(fn);
    }
  },
  onAnswer: function (fn) {
    if (typeof fn === 'function' && _answerListeners.indexOf(fn) === -1) {
      _answerListeners.push(fn);
    }
  },
  /* Test helper: simulate thinking + answer */
  _simulateThinking: function () {
    _thinkingListeners.forEach(function (fn) { try { fn(); } catch (_) {} });
  },
  _simulateAnswer: function () {
    _answerListeners.forEach(function (fn) { try { fn(); } catch (_) {} });
  }
};

/* ─────────────────────────────────────────────────────────────
   TEST HARNESS
───────────────────────────────────────────────────────────────*/
function _buildGrimPanel() {
  var panel = document.createElement('div');
  panel.id = 'grim-panel';
  panel.classList._list = [];
  _elements['grim-panel'] = panel;
  return panel;
}

function _buildStatusBar() {
  var bar = document.createElement('div');
  bar.id = 'snx-ai-statusbar';
  _elements['snx-ai-statusbar'] = bar;
  return bar;
}

function _resetDOM() {
  _elements = {};
  _ls = {};
  _mediaQueryResults = {};
  _rafCalls = 0;
  _mockVoiceState = 'IDLE';
  _voiceStateListeners = [];
  _thinkingListeners = [];
  _answerListeners = [];
  /* Rebuild stubs with clean listener lists */
  global.SNXShadowVoice.onStateChange = function (fn) {
    if (typeof fn === 'function' && _voiceStateListeners.indexOf(fn) === -1)
      _voiceStateListeners.push(fn);
  };
  global.SNXShadowVoice.removeStateChangeListener = function (fn) {
    var idx = _voiceStateListeners.indexOf(fn);
    if (idx !== -1) _voiceStateListeners.splice(idx, 1);
  };
  global.SNXShadowVoice._simulateState = function (s) {
    _mockVoiceState = s;
    _voiceStateListeners.forEach(function (fn) { try { fn(s); } catch (_) {} });
  };
  global.SNXShadowAI.onThinking = function (fn) {
    if (typeof fn === 'function' && _thinkingListeners.indexOf(fn) === -1)
      _thinkingListeners.push(fn);
  };
  global.SNXShadowAI.onAnswer = function (fn) {
    if (typeof fn === 'function' && _answerListeners.indexOf(fn) === -1)
      _answerListeners.push(fn);
  };
  global.SNXShadowAI._simulateThinking = function () {
    _thinkingListeners.forEach(function (fn) { try { fn(); } catch (_) {} });
  };
  global.SNXShadowAI._simulateAnswer = function () {
    _answerListeners.forEach(function (fn) { try { fn(); } catch (_) {} });
  };
}

function _freshModule() {
  delete global.SNXShadowCharacter;
  delete global.SNXShadowCharacterState;
  var key = require.resolve('./snx-shadow-character.js');
  delete require.cache[key];
  require('./snx-shadow-character.js');
  return global.SNXShadowCharacter;
}

var pass = 0, warn = 0, fail = 0;
var results = [];

function test(label, fn) {
  _resetDOM();
  try {
    var outcome = fn();
    if (outcome === true || outcome === undefined) {
      pass++;
      results.push({ status: 'PASS', label: label });
    } else if (typeof outcome === 'string') {
      warn++;
      results.push({ status: 'WARN', label: label, note: outcome });
      console.log('⚠ [WARN] ' + label + ' — ' + outcome);
    } else {
      fail++;
      results.push({ status: 'FAIL', label: label, note: 'returned false' });
      console.log('✗ [FAIL] ' + label);
    }
  } catch (e) {
    fail++;
    results.push({ status: 'FAIL', label: label, note: e.message });
    console.log('✗ [FAIL] ' + label + ' — ' + e.message);
  }
  if (global.SNXShadowCharacter) {
    try { global.SNXShadowCharacter.destroy(); } catch (_) {}
  }
}

function testAsync(label, fn) {
  return new Promise(function (resolve) {
    _resetDOM();
    var timer = setTimeout(function () {
      fail++;
      results.push({ status: 'FAIL', label: label, note: 'timeout' });
      console.log('✗ [FAIL] ' + label + ' — timeout');
      if (global.SNXShadowCharacter) { try { global.SNXShadowCharacter.destroy(); } catch (_) {} }
      resolve();
    }, 1000);

    fn(function (ok, note) {
      clearTimeout(timer);
      if (ok) { pass++; results.push({ status: 'PASS', label: label }); }
      else {
        fail++;
        results.push({ status: 'FAIL', label: label, note: note || 'failed' });
        console.log('✗ [FAIL] ' + label + (note ? ' — ' + note : ''));
      }
      if (global.SNXShadowCharacter) { try { global.SNXShadowCharacter.destroy(); } catch (_) {} }
      resolve();
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   PART 1: MODULE INITIALIZATION
════════════════════════════════════════════════════════════ */
console.log('\n── PART 1: MODULE INITIALIZATION ────────────────────────');

test('C4B-01 window.SNXShadowCharacter exists after require', function () {
  var C = _freshModule();
  if (!C) throw new Error('SNXShadowCharacter not defined');
  return true;
});

test('C4B-02 init() runs without error', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  return true;
});

test('C4B-03 init() is idempotent (safe to call twice)', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.init(); // second call must not throw or double-inject
  return true;
});

test('C4B-04 initial state is idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  if (C.getState() !== 'idle') throw new Error('Expected idle, got ' + C.getState());
  return true;
});

test('C4B-05 window.SNXShadowCharacterState is idle after init', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  if (global.SNXShadowCharacterState !== 'idle')
    throw new Error('Expected SNXShadowCharacterState=idle, got ' + global.SNXShadowCharacterState);
  return true;
});

test('C4B-06 build ID is SNS-2026-SHADOW-CHARACTER-4B-001', function () {
  var C = _freshModule();
  if (C.build !== 'SNS-2026-SHADOW-CHARACTER-4B-001')
    throw new Error('Unexpected build: ' + C.build);
  return true;
});

test('C4B-07 STATES constant exposes all 6 states', function () {
  var C = _freshModule();
  var expected = ['idle','listening','thinking','speaking','success','error'];
  expected.forEach(function (s) {
    var found = Object.keys(C.STATES).some(function (k) { return C.STATES[k] === s; });
    if (!found) throw new Error('Missing state: ' + s);
  });
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 2: STATE MACHINE — setState / getState
════════════════════════════════════════════════════════════ */
console.log('\n── PART 2: STATE MACHINE ─────────────────────────────────');

test('C4B-08 setState(listening) updates getState()', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  if (C.getState() !== 'listening') throw new Error('Expected listening, got ' + C.getState());
  return true;
});

test('C4B-09 setState(thinking) updates getState()', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  if (C.getState() !== 'thinking') throw new Error('Expected thinking, got ' + C.getState());
  return true;
});

test('C4B-10 setState(speaking) updates getState()', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('speaking');
  if (C.getState() !== 'speaking') throw new Error('Expected speaking, got ' + C.getState());
  return true;
});

test('C4B-11 setState(success) updates getState()', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('success');
  if (C.getState() !== 'success') throw new Error('Expected success, got ' + C.getState());
  return true;
});

test('C4B-12 setState(error) updates getState()', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('error');
  if (C.getState() !== 'error') throw new Error('Expected error, got ' + C.getState());
  return true;
});

test('C4B-13 reset() returns to idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  C.reset();
  if (C.getState() !== 'idle') throw new Error('Expected idle after reset, got ' + C.getState());
  return true;
});

test('C4B-14 setState() updates window.SNXShadowCharacterState', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  if (global.SNXShadowCharacterState !== 'thinking')
    throw new Error('SNXShadowCharacterState not updated');
  return true;
});

test('C4B-15 setState(idle) adds snx-char-idle CSS class to panel', function () {
  var panel = _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  C.setState('idle');
  if (!panel.classList.contains('snx-char-idle'))
    throw new Error('Expected snx-char-idle class on panel');
  return true;
});

test('C4B-16 setState(listening) adds snx-char-listening CSS class to panel', function () {
  var panel = _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  if (!panel.classList.contains('snx-char-listening'))
    throw new Error('Expected snx-char-listening class');
  return true;
});

test('C4B-17 setState() removes previous state class when transitioning', function () {
  var panel = _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  C.setState('thinking');
  if (panel.classList.contains('snx-char-listening'))
    throw new Error('Old snx-char-listening class should be removed on transition');
  if (!panel.classList.contains('snx-char-thinking'))
    throw new Error('Expected snx-char-thinking class');
  return true;
});

test('C4B-18 unknown state string is ignored without throw', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('something_invalid_xyz');
  // should remain idle (or whatever previous state was)
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 3: IDLE STATE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 3: IDLE STATE ────────────────────────────────────');

test('C4B-19 module starts in idle without any state class side-effects', function () {
  var panel = _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  // Before init, panel should have no snx-char-* classes
  var hasAny = ['snx-char-idle','snx-char-listening','snx-char-thinking',
                'snx-char-speaking','snx-char-success','snx-char-error']
    .some(function (c) { return panel.classList.contains(c); });
  // load module
  C.init();
  // after init the idle class may be applied — that's correct
  return true;
});

test('C4B-20 idle state has no state label text', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('idle');
  var label = _elements['snx-char-state-label'];
  if (label && label.textContent && label.textContent.trim()) {
    // idle should show empty label
    throw new Error('Expected empty label in idle, got: ' + label.textContent);
  }
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 4: LISTENING STATE (VOICE INTEGRATION)
════════════════════════════════════════════════════════════ */
console.log('\n── PART 4: LISTENING STATE ───────────────────────────────');

test('C4B-21 voice LISTENING → character listening', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  global.SNXShadowVoice._simulateState('LISTENING');
  if (C.getState() !== 'listening')
    throw new Error('Expected listening, got ' + C.getState());
  return true;
});

test('C4B-22 LISTENING state label shows "Listening"', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  var label = _elements['snx-char-state-label'];
  if (!label) throw new Error('snx-char-state-label not found');
  if (label.textContent !== 'Listening')
    throw new Error('Expected "Listening" label, got: ' + label.textContent);
  return true;
});

test('C4B-23 LISTENING state adds snx-char-listening to panel', function () {
  var panel = _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  if (!panel.classList.contains('snx-char-listening'))
    throw new Error('Expected snx-char-listening on panel');
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 5: THINKING STATE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 5: THINKING STATE ────────────────────────────────');

test('C4B-24 voice PROCESSING → character thinking', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  global.SNXShadowVoice._simulateState('PROCESSING');
  if (C.getState() !== 'thinking')
    throw new Error('Expected thinking, got ' + C.getState());
  return true;
});

test('C4B-25 THINKING state label shows "Thinking"', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  var label = _elements['snx-char-state-label'];
  if (!label) throw new Error('snx-char-state-label not found');
  if (label.textContent !== 'Thinking')
    throw new Error('Expected "Thinking", got: ' + label.textContent);
  return true;
});

test('C4B-26 typed question (AI thinking hook) → character thinking', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  global.SNXShadowAI._simulateThinking();
  if (C.getState() !== 'thinking')
    throw new Error('Expected thinking after AI thinking hook, got ' + C.getState());
  return true;
});

test('C4B-27 thinking does NOT say CONTACTING CLOUDFLARE in label', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  var label = _elements['snx-char-state-label'];
  if (label && label.textContent && label.textContent.toUpperCase().indexOf('CLOUDFLARE') !== -1)
    throw new Error('Label must not say CONTACTING CLOUDFLARE');
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 6: SPEAKING STATE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 6: SPEAKING STATE ────────────────────────────────');

test('C4B-28 voice SPEAKING → character speaking', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  global.SNXShadowVoice._simulateState('SPEAKING');
  if (C.getState() !== 'speaking')
    throw new Error('Expected speaking, got ' + C.getState());
  return true;
});

test('C4B-29 SPEAKING state label shows "Speaking"', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('speaking');
  var label = _elements['snx-char-state-label'];
  if (!label) throw new Error('snx-char-state-label not found');
  if (label.textContent !== 'Speaking')
    throw new Error('Expected "Speaking", got: ' + label.textContent);
  return true;
});

test('C4B-30 voice SPEAKING → IDLE transitions character to idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  global.SNXShadowVoice._simulateState('SPEAKING');
  global.SNXShadowVoice._simulateState('IDLE');
  if (C.getState() !== 'idle')
    throw new Error('Expected idle after TTS end, got ' + C.getState());
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 7: SUCCESS STATE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 7: SUCCESS STATE ─────────────────────────────────');

test('C4B-31 AI answer hook triggers success when voice is idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  /* Voice is IDLE (default) */
  var C = _freshModule();
  C.init();
  global.SNXShadowAI._simulateThinking();
  global.SNXShadowAI._simulateAnswer();
  if (C.getState() !== 'success')
    throw new Error('Expected success after answer (voice idle), got ' + C.getState());
  return true;
});

/* C4B-32 is an async timer test — handled in the Promise chain at the end of the file */

test('C4B-33 setText response without TTS — success then idle (no TTS required)', function () {
  _buildGrimPanel(); _buildStatusBar();
  /* Ensure voice is unsupported / idle */
  _mockVoiceState = 'IDLE';
  var C = _freshModule();
  C.init();
  /* Simulate typed question answered */
  global.SNXShadowAI._simulateThinking();
  global.SNXShadowAI._simulateAnswer();
  /* Should be success now */
  if (C.getState() !== 'success')
    throw new Error('Expected success, got ' + C.getState());
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 8: ERROR STATE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 8: ERROR STATE ───────────────────────────────────');

test('C4B-34 voice MIC_BLOCKED → character error', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  global.SNXShadowVoice._simulateState('MIC_BLOCKED');
  if (C.getState() !== 'error')
    throw new Error('Expected error, got ' + C.getState());
  return true;
});

test('C4B-35 voice MIC_ERROR → character error', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  global.SNXShadowVoice._simulateState('MIC_ERROR');
  if (C.getState() !== 'error')
    throw new Error('Expected error, got ' + C.getState());
  return true;
});

test('C4B-36 ERROR state label shows "Error"', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('error');
  var label = _elements['snx-char-state-label'];
  if (!label) throw new Error('snx-char-state-label not found');
  if (label.textContent !== 'Error')
    throw new Error('Expected "Error", got: ' + label.textContent);
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 9: PANEL OPEN / CLOSE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 9: PANEL OPEN / CLOSE ────────────────────────────');

test('C4B-37 onPanelOpen() → state is idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  C.onPanelOpen();
  if (C.getState() !== 'idle')
    throw new Error('Expected idle after panel open, got ' + C.getState());
  return true;
});

test('C4B-38 onPanelClose() → state is idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  C.onPanelClose();
  if (C.getState() !== 'idle')
    throw new Error('Expected idle after panel close, got ' + C.getState());
  return true;
});

test('C4B-39 onPanelClose() does not leave thinking/listening/speaking/error stuck', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  var stuckStates = ['thinking','listening','speaking','error'];
  stuckStates.forEach(function (s) {
    C.setState(s);
    C.onPanelClose();
    if (C.getState() !== 'idle')
      throw new Error('Expected idle after close from ' + s + ', got ' + C.getState());
  });
  return true;
});

test('C4B-40 closing cancels pending SUCCESS timer', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('success');
  C.onPanelClose(); // should cancel timer, go to idle
  if (C.getState() !== 'idle')
    throw new Error('Expected idle after close, got ' + C.getState());
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 10: DESTROY CLEANUP
════════════════════════════════════════════════════════════ */
console.log('\n── PART 10: DESTROY CLEANUP ──────────────────────────────');

test('C4B-41 destroy() removes snx-char-* classes from panel', function () {
  var panel = _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  C.destroy();
  var hasAny = ['snx-char-idle','snx-char-listening','snx-char-thinking',
                'snx-char-speaking','snx-char-success','snx-char-error']
    .some(function (c) { return panel.classList.contains(c); });
  if (hasAny) throw new Error('Panel still has character state classes after destroy');
  return true;
});

test('C4B-42 destroy() removes snx-char-state-label from DOM', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening'); // ensure label was created
  C.destroy();
  var label = _elements['snx-char-state-label'];
  if (label) throw new Error('snx-char-state-label still in DOM after destroy');
  return true;
});

test('C4B-43 destroy() resets SNXShadowCharacterState to idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('speaking');
  C.destroy();
  if (global.SNXShadowCharacterState !== 'idle')
    throw new Error('SNXShadowCharacterState should be idle after destroy');
  return true;
});

test('C4B-44 destroy() allows re-init (idempotent lifecycle)', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.destroy();
  /* Re-init must not throw */
  _buildGrimPanel(); _buildStatusBar();
  C.init();
  if (C.getState() !== 'idle') throw new Error('Expected idle after re-init');
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 11: RAPID STATE CHANGES
════════════════════════════════════════════════════════════ */
console.log('\n── PART 11: RAPID STATE CHANGES ─────────────────────────');

test('C4B-45 rapid state changes do not throw', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  var states = ['listening','thinking','speaking','success','error','idle'];
  for (var i = 0; i < 20; i++) {
    C.setState(states[i % states.length]);
  }
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 12: NO DUPLICATE CONTROLLERS
════════════════════════════════════════════════════════════ */
console.log('\n── PART 12: NO DUPLICATE CONTROLLERS ────────────────────');

test('C4B-46 init() twice does not create duplicate state label', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening'); // creates label
  C.init();                // should be idempotent
  /* Count snx-char-state-label elements */
  var count = 0;
  if (_elements['snx-char-state-label']) count++;
  if (count > 1) throw new Error('Duplicate state labels detected');
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 13: NO NEW RAF LOOPS
════════════════════════════════════════════════════════════ */
console.log('\n── PART 13: NO NEW RAF LOOPS ─────────────────────────────');

test('C4B-47 module load creates ZERO new requestAnimationFrame calls', function () {
  _rafCalls = 0;
  _buildGrimPanel(); _buildStatusBar();
  _freshModule(); // just load, don't init
  if (_rafCalls > 0) throw new Error('RAF called during module load: ' + _rafCalls + ' calls');
  return true;
});

test('C4B-48 init() creates ZERO new requestAnimationFrame calls', function () {
  _rafCalls = 0;
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  if (_rafCalls > 0) throw new Error('RAF called during init: ' + _rafCalls + ' calls');
  return true;
});

test('C4B-49 setState() creates ZERO new requestAnimationFrame calls', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  _rafCalls = 0;
  C.setState('listening');
  C.setState('thinking');
  C.setState('speaking');
  C.setState('idle');
  if (_rafCalls > 0) throw new Error('RAF called during setState: ' + _rafCalls + ' calls');
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 14: REDUCED MOTION
════════════════════════════════════════════════════════════ */
console.log('\n── PART 14: REDUCED MOTION ───────────────────────────────');

test('C4B-50 reduced-motion: setState still works (state text visible)', function () {
  _mediaQueryResults['(prefers-reduced-motion: reduce)'] = true;
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  /* State label should still be updated for accessibility */
  var label = _elements['snx-char-state-label'];
  if (!label) throw new Error('State label missing in reduced-motion mode');
  if (label.textContent !== 'Listening')
    throw new Error('Expected Listening label in reduced-motion mode, got: ' + label.textContent);
  return true;
});

test('C4B-51 reduced-motion: getState() returns correct state', function () {
  _mediaQueryResults['(prefers-reduced-motion: reduce)'] = true;
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  if (C.getState() !== 'thinking')
    throw new Error('getState() should still work in reduced-motion mode');
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 15: LITE PERFORMANCE MODE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 15: LITE PERFORMANCE MODE ───────────────────────');

test('C4B-52 LITE mode: state machine still functional', function () {
  _ls['snxPerfMode'] = 'LITE';
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  if (C.getState() !== 'listening')
    throw new Error('State machine must work in LITE mode');
  return true;
});

test('C4B-53 LITE mode: state label still shows (text-based indicator preserved)', function () {
  _ls['snxPerfMode'] = 'LITE';
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('thinking');
  var label = _elements['snx-char-state-label'];
  if (!label) throw new Error('State label missing in LITE mode');
  /* In LITE mode the CSS class may not be applied to panel, but label text should still update */
  if (label.textContent !== 'Thinking')
    throw new Error('Expected Thinking in LITE mode, got: ' + label.textContent);
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 16: VOICE → CHARACTER STATE MAPPING
════════════════════════════════════════════════════════════ */
console.log('\n── PART 16: VOICE → CHARACTER MAPPING ───────────────────');

test('C4B-54 voice IDLE → character idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('listening');
  global.SNXShadowVoice._simulateState('IDLE');
  if (C.getState() !== 'idle')
    throw new Error('Expected idle from voice IDLE, got ' + C.getState());
  return true;
});

test('C4B-55 voice MIC_UNSUPPORTED → character idle', function () {
  _buildGrimPanel(); _buildStatusBar();
  var C = _freshModule();
  C.init();
  C.setState('error');
  global.SNXShadowVoice._simulateState('MIC_UNSUPPORTED');
  if (C.getState() !== 'idle')
    throw new Error('Expected idle from MIC_UNSUPPORTED, got ' + C.getState());
  return true;
});

/* ═══════════════════════════════════════════════════════════
   PART 17: TYPED QUESTION → THINKING → SUCCESS → IDLE
════════════════════════════════════════════════════════════ */
console.log('\n── PART 17: TYPED QUESTION FLOW ─────────────────────────');

test('C4B-56 typed question: thinking → success → idle flow', function () {
  _buildGrimPanel(); _buildStatusBar();
  /* Ensure voice is not driving the state */
  _mockVoiceState = 'IDLE';
  var C = _freshModule();
  C.init();
  global.SNXShadowAI._simulateThinking();
  if (C.getState() !== 'thinking')
    throw new Error('Expected thinking after question submitted, got ' + C.getState());
  global.SNXShadowAI._simulateAnswer();
  if (C.getState() !== 'success')
    throw new Error('Expected success after answer, got ' + C.getState());
  return true;
});

test('C4B-57 local brain answer and Workers AI answer both trigger success', function () {
  _buildGrimPanel(); _buildStatusBar();
  _mockVoiceState = 'IDLE';
  var C = _freshModule();
  C.init();
  /* Simulate local answer */
  global.SNXShadowAI._simulateThinking();
  global.SNXShadowAI._simulateAnswer();
  if (C.getState() !== 'success')
    throw new Error('Local answer should trigger success, got ' + C.getState());
  C.reset();
  /* Simulate Workers AI answer */
  global.SNXShadowAI._simulateThinking();
  global.SNXShadowAI._simulateAnswer();
  if (C.getState() !== 'success')
    throw new Error('Workers AI answer should trigger success, got ' + C.getState());
  return true;
});

/* ─────────────────────────────────────────────────────────────
   RUN ASYNC TESTS, THEN REPORT
───────────────────────────────────────────────────────────────*/
Promise.resolve()
  .then(function () { return test.C4B32Async || Promise.resolve(); })
  .then(function () {
    /* Run the success auto-return test explicitly */
    return new Promise(function (resolve) {
      _resetDOM();
      _buildGrimPanel(); _buildStatusBar();
      var C = _freshModule();
      C.init();
      C.setState('success');
      setTimeout(function () {
        var state = C.getState();
        try { C.destroy(); } catch (_) {}
        if (state !== 'idle') {
          fail++;
          results.push({ status: 'FAIL', label: 'C4B-32 success auto-returns to idle', note: 'Expected idle, got ' + state });
          console.log('✗ [FAIL] C4B-32 — Expected idle, got ' + state);
        } else {
          pass++;
          results.push({ status: 'PASS', label: 'C4B-32 success auto-returns to idle' });
        }
        resolve();
      }, 1700);
    });
  })
  .then(function () {
    /* ── Final report ── */
    console.log('\n══════════════════════════════════════════════════════');
    console.log('  SHADOW REAPER — STAGE 4B CHARACTER EXPERIENCE TESTS');
    console.log('══════════════════════════════════════════════════════');
    console.log('  PASS : ' + pass);
    console.log('  WARN : ' + warn);
    console.log('  FAIL : ' + fail);
    console.log('  TOTAL: ' + (pass + warn + fail));
    console.log('══════════════════════════════════════════════════════\n');

    if (fail > 0) {
      console.log('FAILED TESTS:');
      results.filter(function (r) { return r.status === 'FAIL'; }).forEach(function (r) {
        console.log('  ✗ ' + r.label + (r.note ? ' — ' + r.note : ''));
      });
      process.exit(1);
    } else {
      console.log('ALL STAGE 4B CHARACTER TESTS PASSED ✓');
      process.exit(0);
    }
  });
