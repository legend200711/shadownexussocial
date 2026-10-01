/**
 * shadow-reaper/tests/run-tests.js
 * Shadow Reaper AI — Node.js Test Runner
 *
 * Run with: node shadow-reaper/tests/run-tests.js
 *
 * Loads all modules in the correct order using the global object
 * (no ES module imports required — same pattern as the browser environment).
 */

'use strict';

// Create a browser-like global environment
var _G = global;
_G.window = _G;

// Minimal browser stubs for Node environment
_G.SpeechRecognition = undefined;
_G.webkitSpeechRecognition = undefined;
_G.speechSynthesis = undefined;
_G.localStorage = {
  _store: {},
  getItem: function (k) { return this._store[k] || null; },
  setItem: function (k, v) { this._store[k] = String(v); },
  removeItem: function (k) { delete this._store[k]; }
};
_G.setTimeout = setTimeout;
_G.clearTimeout = clearTimeout;
_G.Promise = Promise;

// Load modules in order
var path = require('path');
var base = path.join(__dirname, '..');

function load(relPath) {
  try {
    require(path.join(base, relPath));
    console.log('  ✓ Loaded: ' + relPath);
  } catch (e) {
    console.error('  ✗ FAILED to load: ' + relPath + ' — ' + e.message);
  }
}

console.log('\nLoading Shadow Reaper modules...');
load('core/understanding-engine.js');
load('core/context-engine.js');
load('core/response-engine.js');
load('core/conversation-engine.js');
load('data/knowledge-engine.js');
load('data/creator-knowledge.js');
load('storage/conversation-history.js');
load('storage/personal-memory.js');
load('storage/adaptive-learning.js');
load('ui/voice-interface.js');
load('ui/character-interface.js');
load('shadow-reaper.js');
console.log('');

// Run tests
require('./stage1-tests.js');
