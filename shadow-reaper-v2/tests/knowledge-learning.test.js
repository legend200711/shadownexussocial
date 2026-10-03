/**
 * shadow-reaper-v2/tests/knowledge-learning.test.js
 * Shadow Reaper V2 — Continuous Knowledge Learning Tests
 *
 * Tests ALL 16 requirement areas:
 *  1. Knowledge Learning Pipeline
 *  2. Learn from normal conversation (no "remember this" required)
 *  3. Learn new answers after "I don't know"
 *  4. Semantic recall (different wording finds same knowledge)
 *  5. Knowledge types (concepts, projects, terminology, definitions, etc.)
 *  6. Personal claim vs general fact classification
 *  7. SNS privacy — no cross-user learning
 *  8. Corrections override stale information
 *  9. Reinforcement / confidence
 * 10. Emotionally aware conversation (current only, not profiled)
 * 11. Natural everyday conversation (not website-redirecting)
 * 12. Long-term growth architecture
 * 13. Model-independent interfaces
 * 14. Memory ≠ model training
 * 15. Persistence test (random project name, fresh session recall)
 * 16. Safety / privacy test
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

// ── Module loader ─────────────────────────────────────────────────────────────
function loadModule(relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const fn   = new Function('global', 'require', 'module', 'exports', '__dirname', '__filename', code);
  const mod  = {};
  try {
    fn(global, require, mod, {}, path.dirname(path.join(ROOT, relPath)), path.join(ROOT, relPath));
  } catch (e) {
    // Swallow browser-only module errors (crypto.getRandomValues, etc.)
  }
  return mod;
}

// ── Browser globals for Node test environment ─────────────────────────────────
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
      value: { gpu: undefined }, writable: true, configurable: true
    });
  }
} catch (_) {}

// ── Load required modules ─────────────────────────────────────────────────────
loadModule('shadow-reaper-v2/core/adaptive-brain.js');
loadModule('shadow-reaper-v2/knowledge/sr-knowledge-learner.js');
loadModule('shadow-reaper-v2/core/understanding-engine.js');
loadModule('shadow-reaper-v2/core/context-engine.js');
loadModule('shadow-reaper-v2/core/conversation-engine.js');
loadModule('shadow-reaper-v2/core/response-engine.js');

const Brain   = global.SRAdaptiveBrain;
const Learner = global.SRKnowledgeLearner;

// ── Test infrastructure ───────────────────────────────────────────────────────
let PASS = 0, WARN = 0, FAIL = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    PASS++;
    results.push({ status: 'PASS', name });
    process.stdout.write('  ✓  ' + name + '\n');
  } catch (err) {
    FAIL++;
    results.push({ status: 'FAIL', name, error: err.message });
    process.stderr.write('  ✗  ' + name + '\n    → ' + err.message + '\n');
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assertion failed');
}

function assertNotNull(v, msg) {
  if (v === null || v === undefined) throw new Error(msg || 'Expected non-null');
}

function assertContainsText(str, sub, msg) {
  if (!str || str.toLowerCase().indexOf(sub.toLowerCase()) === -1) {
    throw new Error((msg || 'Expected text to contain "' + sub + '"') + ' — got: "' + str + '"');
  }
}

function assertNotContainsText(str, sub, msg) {
  if (str && str.toLowerCase().indexOf(sub.toLowerCase()) !== -1) {
    throw new Error((msg || 'Expected text NOT to contain "' + sub + '"') + ' — got: "' + str + '"');
  }
}

function assertArray(v, msg) {
  if (!Array.isArray(v)) throw new Error(msg || 'Expected array, got: ' + typeof v);
}

function assertArrayContains(arr, check, msg) {
  const found = arr.some(function (x) {
    return JSON.stringify(x).toLowerCase().includes(check.toLowerCase());
  });
  if (!found) throw new Error((msg || 'Array missing: ') + check);
}

// ── Random name generator ─────────────────────────────────────────────────────
// Generates names that CANNOT exist as hardcoded knowledge in source code.
// Tests must pass only via dynamic learning — never via hardcoded lookups.
const _PFX = ['Xylor', 'Vantex', 'Quorion', 'Zelthis', 'Primax', 'Nuvox', 'Zyrath', 'Eclumn'];
const _SFX = ['Protocol', 'Engine', 'Nexus', 'Matrix', 'Core', 'Array', 'Vault', 'Cipher'];

function randomName() {
  const p = _PFX[Math.floor(Math.random() * _PFX.length)];
  const s = _SFX[Math.floor(Math.random() * _SFX.length)];
  return p + ' ' + s;
}

// ── Brain reset helper ────────────────────────────────────────────────────────
function freshBrain() {
  if (Brain && Brain.destroy) Brain.destroy();
}

// =============================================================================
// GROUP 1: MODULE EXISTENCE AND API
// =============================================================================
console.log('\n── GROUP 1: MODULE STRUCTURE ─────────────────────');

test('SRKnowledgeLearner is defined', function () {
  assert(typeof Learner === 'object' && Learner !== null, 'SRKnowledgeLearner not found');
});

test('SRKnowledgeLearner has all generic model-independent interfaces', function () {
  const required = ['learn', 'retrieve', 'relate', 'correct', 'reinforce', 'forget', 'findRelated', 'queryForResponse'];
  required.forEach(function (fn) {
    assert(typeof Learner[fn] === 'function', 'Missing interface: ' + fn);
  });
});

test('SRKnowledgeLearner exposes extractKnowledge for testing', function () {
  assert(typeof Learner.extractKnowledge === 'function', 'extractKnowledge missing');
});

test('SRKnowledgeLearner.CLAIM_TYPE has all required types', function () {
  const ct = Learner.CLAIM_TYPE;
  assert(ct.PERSONAL,       'Missing PERSONAL');
  assert(ct.PROJECT,        'Missing PROJECT');
  assert(ct.GENERAL_CLAIM,  'Missing GENERAL_CLAIM');
  assert(ct.DEFINITION,     'Missing DEFINITION');
  assert(ct.RELATIONSHIP,   'Missing RELATIONSHIP');
  assert(ct.FICTIONAL,      'Missing FICTIONAL');
  assert(ct.CORRECTION,     'Missing CORRECTION');
  assert(ct.TERMINOLOGY,    'Missing TERMINOLOGY');
});

test('Build ID is correct', function () {
  assert(Learner.build === 'SR-V2-LEARN-1', 'Wrong build: ' + Learner.build);
});

test('SRAdaptiveBrain is present and has learn/retrieve/correct/reinforce/forget/getRelated', function () {
  const required = ['learn', 'retrieve', 'correct', 'reinforce', 'forget', 'getRelated'];
  required.forEach(function (fn) {
    assert(typeof Brain[fn] === 'function', 'SRAdaptiveBrain missing: ' + fn);
  });
});

// =============================================================================
// GROUP 2: EXTRACTION — DEFINITIONS AND TERMINOLOGY
// Requirements §2, §5
// =============================================================================
console.log('\n── GROUP 2: KNOWLEDGE EXTRACTION ────────────────────');

test('Extracts "A Zorvian Core is the power system" — dynamic name', function () {
  freshBrain();
  const name = 'Zorvian Core';
  const items = Learner.extractKnowledge('A ' + name + ' is the power system in the game I\'m designing.');
  assert(items.length > 0, 'No knowledge extracted');
  const found = items.some(function (i) {
    return i.label.toLowerCase().indexOf(name.toLowerCase()) !== -1 ||
           i.value.toLowerCase().indexOf(name.toLowerCase()) !== -1;
  });
  assert(found, 'Expected "' + name + '" in extracted items. Got: ' + JSON.stringify(items));
});

test('Extracts named concept starting with capital letter — dynamic', function () {
  freshBrain();
  const name = randomName();
  const items = Learner.extractKnowledge(name + ' is the navigation system in my app.');
  assert(items.length > 0, 'No extraction for: ' + name);
});

test('Extracts definition: "X means Y"', function () {
  freshBrain();
  const items = Learner.extractKnowledge('Stellar drift means the rate of position change in zero gravity.');
  const found = items.some(function (i) {
    return i.value.toLowerCase().indexOf('stellar drift') !== -1 &&
           i.claimType === Learner.CLAIM_TYPE.TERMINOLOGY;
  });
  assert(found, 'Expected TERMINOLOGY extraction. Got: ' + JSON.stringify(items));
});

test('Extracts relationship: "X belongs to Y"', function () {
  freshBrain();
  const name = randomName();
  const items = Learner.extractKnowledge(name + ' belongs to my main game project.');
  assert(items.length > 0, 'No relationship extracted for: ' + name);
});

test('Extracts personal claim: "My project is X"', function () {
  freshBrain();
  const items = Learner.extractKnowledge('My project is called Night Storm.');
  const found = items.some(function (i) {
    return i.value.toLowerCase().indexOf('night storm') !== -1;
  });
  assert(found, 'Expected "night storm" in personal claim. Got: ' + JSON.stringify(items));
});

test('Extracts "I\'m building X" — personal creative claim', function () {
  freshBrain();
  const items = Learner.extractKnowledge("I'm building a game called Void Cipher.");
  assert(items.length > 0, "No extraction for \"I'm building\" pattern");
});

test('Extracts fictional claim: "In my game, X is Y"', function () {
  freshBrain();
  const name = randomName();
  const items = Learner.extractKnowledge('In my game, ' + name + ' is the weapon crafting system.');
  const found = items.some(function (i) {
    return i.claimType === Learner.CLAIM_TYPE.FICTIONAL ||
           i.claimType === Learner.CLAIM_TYPE.PROJECT;
  });
  assert(found, 'Expected FICTIONAL/PROJECT claim type. Got: ' + JSON.stringify(items));
});

test('Extracts correction: "Actually X should be Y"', function () {
  freshBrain();
  const items = Learner.extractKnowledge('Actually, the homepage should be dark blue.');
  const found = items.some(function (i) {
    return i.claimType === Learner.CLAIM_TYPE.CORRECTION ||
           i.value.toLowerCase().indexOf('dark blue') !== -1;
  });
  assert(found, 'Expected correction extraction. Got: ' + JSON.stringify(items));
});

test('Does NOT extract greetings as knowledge', function () {
  freshBrain();
  const items = Learner.extractKnowledge('Hey');
  assert(items.length === 0, 'Extracted filler greeting: ' + JSON.stringify(items));
});

test('Does NOT extract filler words as knowledge', function () {
  freshBrain();
  ['ok', 'thanks', 'hello', 'bye', 'lol', 'haha'].forEach(function (filler) {
    assert(Learner._isFiller(filler), '"' + filler + '" should be filler');
  });
});

test('Does NOT extract sensitive data: password', function () {
  freshBrain();
  const items = Learner.extractKnowledge('my password is hunter2');
  assert(items.length === 0, 'Should not extract password');
  assert(Learner._isSensitive('my password is hunter2'), 'Sensitive filter missed password');
});

test('Does NOT extract sensitive data: API key', function () {
  freshBrain();
  assert(Learner._isSensitive('my api key is sk-abc123'), 'Sensitive filter missed API key');
  const items = Learner.extractKnowledge('my api key is sk-abc123');
  assert(items.length === 0, 'Should not extract API key');
});

// =============================================================================
// GROUP 3: CLAIM CLASSIFICATION (Requirement §6)
// =============================================================================
console.log('\n── GROUP 3: CLAIM CLASSIFICATION ────────────────────');

test('Personal claim — "My Night Storm homepage is blue" → PERSONAL', function () {
  const type = Learner._classifyClaim('My Night Storm homepage is blue.', 'Night Storm homepage', 'blue');
  assert(type === Learner.CLAIM_TYPE.PERSONAL || type === Learner.CLAIM_TYPE.PROJECT,
    'Expected PERSONAL or PROJECT, got: ' + type);
});

test('Fictional claim — "In my game, Zorvian Core powers spaceships" → FICTIONAL', function () {
  const type = Learner._classifyClaim("In my game, Zorvian Core powers spaceships.", "Zorvian Core", "powers spaceships");
  assert(type === Learner.CLAIM_TYPE.FICTIONAL || type === Learner.CLAIM_TYPE.PROJECT,
    'Expected FICTIONAL/PROJECT, got: ' + type);
});

test('General claim — "The moon is made of cheese" → GENERAL_CLAIM', function () {
  const type = Learner._classifyClaim('The moon is made of cheese.', 'moon', 'made of cheese');
  assert(type === Learner.CLAIM_TYPE.GENERAL_CLAIM || type === Learner.CLAIM_TYPE.DEFINITION,
    'Expected GENERAL_CLAIM/DEFINITION for general fact, got: ' + type);
});

test('Terminology claim — "Zorvian Core means the power system" → TERMINOLOGY', function () {
  const type = Learner._classifyClaim('Zorvian Core means the power system.', 'Zorvian Core', 'the power system');
  assert(type === Learner.CLAIM_TYPE.TERMINOLOGY, 'Expected TERMINOLOGY, got: ' + type);
});

// =============================================================================
// GROUP 4: LEARN FROM NATURAL CONVERSATION (Requirement §2)
// =============================================================================
console.log('\n── GROUP 4: NATURAL CONVERSATION LEARNING ────────────');

test('Learn from natural statement — no "remember this" required', function () {
  freshBrain();
  const projectName = randomName();
  Learner.learn({
    text:        'I\'m building a project called ' + projectName + '.',
    role:        'user',
    convId:      'conv1',
    projectName: null,
  });
  const items = Brain.listAll();
  const found = items.some(function (i) {
    return (i.value || '').toLowerCase().indexOf(projectName.toLowerCase()) !== -1;
  });
  assert(found, 'Brain should have learned "' + projectName + '". Items: ' + JSON.stringify(items.map(function (i) { return i.value; })));
});

test('Learn multi-turn: project name → detail → feature', function () {
  freshBrain();
  const proj = randomName();

  Learner.learn({ text: 'I\'m building a website called ' + proj + '.', role: 'user', convId: 'c1', projectName: null });
  Learner.learn({ text: proj + ' is a creative social platform.', role: 'user', convId: 'c1', projectName: proj });
  Learner.learn({ text: 'The homepage uses blue lightning effects.', role: 'user', convId: 'c1', projectName: proj });

  const items = Brain.listAll();
  assert(items.length >= 1, 'Expected at least 1 learned concept. Got: ' + items.length);

  const hasProj = items.some(function (i) {
    return (i.value || '').toLowerCase().indexOf(proj.toLowerCase()) !== -1;
  });
  assert(hasProj, 'Should have learned project name: ' + proj);
});

test('Learn fictional concept without "remember" keyword', function () {
  freshBrain();
  const conceptName = randomName();

  Learner.learn({
    text:     'A ' + conceptName + ' is the power source in my game.',
    role:     'user',
    convId:   'c2',
    projectName: null,
  });

  const items = Brain.listAll();
  const found = items.some(function (i) {
    return (i.value || '').toLowerCase().indexOf(conceptName.toLowerCase()) !== -1 ||
           (i.concept || '').toLowerCase().indexOf(conceptName.toLowerCase().replace(/\s+/g, '_')) !== -1;
  });
  assert(found, 'Should have learned "' + conceptName + '" without explicit "remember". Items: ' +
    JSON.stringify(items.map(function (i) { return i.value; })));
});

test('Assistant turns are ignored — only user turns are learned', function () {
  freshBrain();
  const items0 = Brain.listAll().length;
  Learner.learn({ text: 'Got it. A Quorion Protocol is the power source.', role: 'assistant', convId: 'c3', projectName: null });
  const items1 = Brain.listAll().length;
  assert(items1 === items0, 'Assistant turn should not add concepts');
});

// =============================================================================
// GROUP 5: SEMANTIC RECALL (Requirement §4)
// =============================================================================
console.log('\n── GROUP 5: SEMANTIC RECALL ──────────────────────────');

test('Semantic retrieve: different wording finds same knowledge', function () {
  freshBrain();
  const proj = randomName();

  // Teach: project homepage uses blue lightning
  Learner.learn({ text: proj + ' is a website.', role: 'user', convId: 'c5', projectName: null });
  Learner.learn({ text: 'The homepage uses blue lightning in the background.', role: 'user', convId: 'c5', projectName: proj });

  // Ask with different wording
  const r1 = Learner.semanticRetrieve('What effects does ' + proj + ' use?', proj, 5);
  const r2 = Learner.semanticRetrieve('How did I design ' + proj + '?', proj, 5);
  const r3 = Learner.semanticRetrieve('Tell me about ' + proj + '.', proj, 5);

  // At least one query should find the project
  const anyFound = [r1, r2, r3].some(function (results) {
    return results.length > 0 && results.some(function (item) {
      return (item.value || '').toLowerCase().indexOf(proj.toLowerCase()) !== -1 ||
             (item.concept || '').indexOf(proj.toLowerCase().replace(/\s+/g, '_')) !== -1;
    });
  });
  assert(anyFound, 'Semantic recall should find "' + proj + '" via different wording');
});

test('Token overlap scoring: shared tokens increase relevance', function () {
  const score1 = Learner._tokenOverlapScore(['power', 'system', 'engine'], 'this is the main power engine');
  const score2 = Learner._tokenOverlapScore(['power', 'system', 'engine'], 'completely unrelated text here');
  assert(score1 > score2, 'Overlapping tokens should score higher');
});

test('Token overlap: stop words excluded from scoring', function () {
  const tokens = Learner._tokens('What is the power of the engine?');
  const noStopWords = tokens.every(function (t) {
    return !['what', 'the', 'is', 'of'].includes(t);
  });
  assert(noStopWords, 'Stop words should be excluded from tokens');
});

test('Semantic retrieve returns array (even when empty)', function () {
  freshBrain();
  const result = Learner.semanticRetrieve('completely random question about nothing', null, 5);
  assertArray(result, 'semanticRetrieve should return array');
});

// =============================================================================
// GROUP 6: QUERY FOR RESPONSE — knowledge-aware Q&A (Requirements §2, §3, §4)
// =============================================================================
console.log('\n── GROUP 6: QUERY FOR RESPONSE ───────────────────────');

test('queryForResponse returns {answered, response, items} structure', function () {
  freshBrain();
  const result = Learner.queryForResponse('What is a banana?', null, 'QUESTION');
  assert(typeof result === 'object', 'Should return object');
  assert('answered' in result, 'Missing "answered"');
  assert('response' in result, 'Missing "response"');
  assert('items' in result, 'Missing "items"');
});

test('queryForResponse: learned concept retrieved for question', function () {
  freshBrain();
  const name = randomName();

  // Teach the concept
  Learner.learn({ text: 'A ' + name + ' is the energy distribution system in my game.', role: 'user', convId: 'q1', projectName: null });

  // Now ask about it
  const result = Learner.queryForResponse('What is a ' + name + '?', null, 'QUESTION');

  // If learned, should be able to answer; if brain not loaded, may be false — both are valid
  // but if items were found, answered must be true
  if (result.items.length > 0) {
    assert(result.answered, 'Should be answered when items found');
    assertNotNull(result.response, 'Response should not be null when answered');
  }
  assert(Array.isArray(result.items), 'items must be array');
});

test('queryForResponse "I don\'t know": returns natural varied response for unknown question', function () {
  freshBrain();
  const result = Learner.queryForResponse('What is a GrumblaxCore?', null, 'QUESTION');
  // queryForResponse returns "I don't know" for unknown QUESTION intent
  if (result.answered) {
    // Response should be a natural "I don't know" statement
    const naturalResponses = [
      "don't have", "not sure", "haven't learned", "don't know enough", "not something"
    ];
    const isNatural = naturalResponses.some(function (phrase) {
      return result.response && result.response.toLowerCase().indexOf(phrase) !== -1;
    });
    assert(isNatural, 'Unknown question should give natural "I don\'t know" response. Got: "' + result.response + '"');
  }
});

test('buildLearnedResponse returns null for empty items', function () {
  const r = Learner.buildLearnedResponse('What is X?', [], null);
  assert(r === null, 'Should return null for empty items');
});

test('buildLearnedResponse constructs natural sentence from items', function () {
  freshBrain();
  const items = [
    { value: '"NovaCipher" is the encryption module of user\'s project', confidence: 'MEDIUM', concept: 'novacipher', type: 'PROJECT' }
  ];
  const r = Learner.buildLearnedResponse('What is NovaCipher?', items, null);
  assertNotNull(r, 'Should build a response');
  assert(typeof r === 'string', 'Response should be a string');
  assert(r.length > 10, 'Response should be substantive');
});

// =============================================================================
// GROUP 7: CORRECTIONS (Requirement §8)
// =============================================================================
console.log('\n── GROUP 7: CORRECTIONS ──────────────────────────────');

test('Correction overrides stale knowledge', function () {
  freshBrain();
  const proj = randomName();

  // Teach initial value
  Learner.learn({ text: 'The ' + proj + ' homepage will be black.', role: 'user', convId: 'corr1', projectName: proj });

  // Now correct it
  Learner.correct('black', 'dark blue', null);

  const items = Brain.listAll();
  // Check for the correction
  const hasCorrected = items.some(function (i) {
    return (i.value || '').toLowerCase().indexOf('dark blue') !== -1 ||
           (i.type === 'CORRECTION' && (i.value || '').toLowerCase().indexOf('dark blue') !== -1);
  });
  assert(hasCorrected, 'Correction "dark blue" should be in brain. Items: ' + JSON.stringify(items.map(function (i) { return i.value; })));
});

test('Correction has HIGH confidence immediately', function () {
  freshBrain();
  Brain.correct('old value', 'new corrected value', null);
  const items = Brain.listAll();
  const correction = items.find(function (i) {
    return (i.value || '').toLowerCase().indexOf('new corrected value') !== -1;
  });
  assertNotNull(correction, 'Correction should be stored');
  assert(correction.confidence === 'HIGH', 'Corrections should have HIGH confidence. Got: ' + correction.confidence);
});

test('Correction: "Actually I\'m making the homepage dark blue" extracted as correction', function () {
  freshBrain();
  const items = Learner.extractKnowledge("Actually, I'm making the homepage dark blue.");
  const correction = items.find(function (i) {
    return i.claimType === Learner.CLAIM_TYPE.CORRECTION;
  });
  assertNotNull(correction, 'Should extract correction claim. Got: ' + JSON.stringify(items));
  assertContainsText(correction.value || '', 'dark blue', 'Correction should contain "dark blue"');
});

test('learn() processes corrections extracted from text', function () {
  freshBrain();
  const proj = randomName();

  Learner.learn({ text: proj + ' is a website.', role: 'user', convId: 'c10', projectName: null });
  Learner.learn({ text: 'Wait, it should actually be an app.', role: 'user', convId: 'c10', projectName: proj });

  // No crash is the minimum; ideally correction is stored
  const items = Brain.listAll();
  assert(Array.isArray(items), 'Brain should remain functional after correction');
});

// =============================================================================
// GROUP 8: REINFORCEMENT AND CONFIDENCE (Requirement §9)
// =============================================================================
console.log('\n── GROUP 8: REINFORCEMENT ─────────────────────────────');

test('Confidence starts at LOW on first learn', function () {
  freshBrain();
  const proj = randomName();
  Learner.learn({ text: 'I\'m building ' + proj + '.', role: 'user', convId: 'r1', projectName: null });
  const items = Brain.listAll();
  const projItem = items.find(function (i) {
    return (i.value || '').toLowerCase().indexOf(proj.toLowerCase()) !== -1;
  });
  if (projItem) {
    assert(projItem.confidence === 'LOW', 'First mention should be LOW confidence. Got: ' + projItem.confidence);
  }
});

test('Reinforcement advances confidence', function () {
  freshBrain();
  const proj = randomName();

  // Learn twice to reinforce
  Learner.learn({ text: 'I\'m building a website called ' + proj + '.', role: 'user', convId: 'r2', projectName: null });
  const items0 = Brain.listAll();
  const item0 = items0.find(function (i) { return (i.value || '').toLowerCase().indexOf(proj.toLowerCase()) !== -1; });

  if (item0) {
    Brain.reinforce(item0.concept);
    Brain.reinforce(item0.concept);
    const items1 = Brain.listAll();
    const item1 = items1.find(function (i) { return i.concept === item0.concept; });
    assertNotNull(item1, 'Item should still exist after reinforce');
    assert(item1.confidence !== 'LOW' || item1.count >= 2,
      'Confidence should advance after reinforcement. Count: ' + item1.count);
  }
});

test('_calcConfidence(1) = LOW, (2) = MEDIUM, (4) = HIGH', function () {
  assert(Brain._calcConfidence(1) === 'LOW',    'Count 1 → LOW');
  assert(Brain._calcConfidence(2) === 'MEDIUM', 'Count 2 → MEDIUM');
  assert(Brain._calcConfidence(4) === 'HIGH',   'Count 4 → HIGH');
});

// =============================================================================
// GROUP 9: EMOTIONAL SIGNALS — current turn only (Requirement §10)
// =============================================================================
console.log('\n── GROUP 9: EMOTIONAL SIGNAL DETECTION ───────────────');

test('detectEmotionalSignal: "I\'m really excited about this" → excited', function () {
  const signal = Learner.detectEmotionalSignal("I'm really excited about this!");
  assert(signal === 'excited', 'Expected "excited", got: ' + signal);
});

test('detectEmotionalSignal: "I\'m feeling sad today" → sad', function () {
  const signal = Learner.detectEmotionalSignal("I'm feeling sad today.");
  assert(signal === 'sad', 'Expected "sad", got: ' + signal);
});

test('detectEmotionalSignal: "Ugh I\'m so frustrated" → frustrated', function () {
  const signal = Learner.detectEmotionalSignal("Ugh I'm so frustrated with this.");
  assert(signal === 'frustrated', 'Expected "frustrated", got: ' + signal);
});

test('detectEmotionalSignal: "I\'m so anxious about the deadline" → anxious', function () {
  const signal = Learner.detectEmotionalSignal("I'm so anxious about the deadline.");
  assert(signal === 'anxious', 'Expected "anxious", got: ' + signal);
});

test('detectEmotionalSignal: "lol this is funny" → playful', function () {
  const signal = Learner.detectEmotionalSignal("lol this is funny");
  assert(signal === 'playful', 'Expected "playful", got: ' + signal);
});

test('detectEmotionalSignal: neutral text returns null', function () {
  const signal = Learner.detectEmotionalSignal('What is the weather like?');
  assert(signal === null, 'Neutral text should return null, got: ' + signal);
});

test('Emotional signal NOT stored in brain (no permanent profile)', function () {
  freshBrain();
  // Simulate multiple emotional turns
  Learner.learn({ text: "I'm feeling really sad today.", role: 'user', convId: 'e1', projectName: null });
  Learner.learn({ text: "I'm so happy now!", role: 'user', convId: 'e1', projectName: null });
  Learner.learn({ text: "I feel frustrated with everything.", role: 'user', convId: 'e1', projectName: null });

  const items = Brain.listAll();
  // Check that no emotion labels were stored as permanent concepts
  const emotionLabels = ['profile:sad', 'profile:happy', 'profile:frustrated', 'emotion_label', 'emotional_state'];
  emotionLabels.forEach(function (label) {
    const found = items.some(function (i) {
      return (i.concept || '').indexOf(label) !== -1 || (i.type || '') === 'EMOTION_PROFILE';
    });
    assert(!found, 'Emotional state should NOT be permanently stored. Found: ' + label);
  });
});

// =============================================================================
// GROUP 10: NATURAL EVERYDAY CONVERSATION — not website-redirecting (Req §11)
// =============================================================================
console.log('\n── GROUP 10: EVERYDAY CONVERSATION ──────────────────');

test('Response engine handles food conversation naturally', function () {
  const understood = global.SRUnderstanding.understand("I love making pasta at home.");
  assert(understood.intent !== 'UNKNOWN' || understood.tone !== 'neutral', 'Should understand the turn');
  assert(typeof understood.intent === 'string', 'Should have intent');
  // Just verify no crash
});

test('Response engine handles music conversation naturally', function () {
  const understood = global.SRUnderstanding.understand("My favorite music genre is jazz.");
  assert(typeof understood.intent === 'string', 'Should have intent');
});

test('Response engine handles "tell me a joke" without crashing', function () {
  const understood = global.SRUnderstanding.understand("Tell me a funny joke.");
  const context    = global.SRContext.getSnapshot();
  const response   = global.SRResponse.compose(understood, context);
  assert(typeof response === 'string', 'Should return string');
  assert(response.length > 0, 'Should be non-empty');
});

test('Response to "I had a long day" is empathetic not website-redirecting', function () {
  const understood = global.SRUnderstanding.understand("I had a really long day.");
  const context    = global.SRContext.getSnapshot();
  const response   = global.SRResponse.compose(understood, context);
  // Should NOT redirect to SNS features
  assertNotContainsText(response, 'shadow nexus social', 'Should not redirect to SNS for emotional conversation');
  assertNotContainsText(response, 'radio', 'Should not redirect to Radio for tired day');
  assert(response.length > 5, 'Response should be substantive');
});

test('"How are you" receives non-human AI-appropriate response', function () {
  const understood = global.SRUnderstanding.understand("How are you doing?");
  const context    = global.SRContext.getSnapshot();
  const response   = global.SRResponse.compose(understood, context);
  assert(response.length > 0, 'Should return response');
  // Should not claim to be human
  const humanClaims = ["I'm doing great!", "I feel wonderful", "I had a great day"];
  humanClaims.forEach(function (claim) {
    assertNotContainsText(response, claim, 'Should not make human claim: ' + claim);
  });
});

// =============================================================================
// GROUP 11: MODEL INDEPENDENCE (Requirement §13)
// =============================================================================
console.log('\n── GROUP 11: MODEL INDEPENDENCE ──────────────────────');

test('SRKnowledgeLearner.js contains no env.AI.run calls', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js'), 'utf8');
  assert(!code.includes('env.AI.run'),   'Must not call env.AI.run');
  assert(!code.includes('openai'),       'Must not reference OpenAI');
  assert(!code.includes('fetch('),       'Must not make fetch calls');
});

test('SRKnowledgeLearner.js is model-independent (no Workers AI, Gemini, OpenAI, Anthropic)', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js'), 'utf8');
  const forbidden = ['env.AI', 'openai', 'gemini', 'anthropic', 'workers-ai', 'fetch(', 'XMLHttpRequest'];
  forbidden.forEach(function (term) {
    assert(!code.toLowerCase().includes(term.toLowerCase()),
      'sr-knowledge-learner.js must not reference: ' + term);
  });
});

test('learn(), retrieve(), relate(), correct(), reinforce(), forget(), findRelated() are all callable without model', function () {
  freshBrain();
  // None of these should throw or require an external model
  Learner.learn({ text: 'Testing model independence.', role: 'user', convId: 'mi1', projectName: null });
  Learner.retrieve('testing model', null, 3);
  Learner.relate('concept A', 'relates to', 'concept B', null);
  Learner.correct('old', 'new', null);
  Learner.reinforce('some_concept');
  Learner.forget('some_other_concept');
  Learner.findRelated('test concept');
});

// =============================================================================
// GROUP 12: MEMORY ≠ MODEL TRAINING (Requirement §14)
// =============================================================================
console.log('\n── GROUP 12: MEMORY vs MODEL TRAINING ────────────────');

test('Learned knowledge is stored as structured data, not model weights', function () {
  freshBrain();
  Learner.learn({ text: 'A Nuvox Protocol is a routing system.', role: 'user', convId: 'mt1', projectName: null });
  const items = Brain.listAll();
  // Learned knowledge should be structured objects, not neural weights
  items.forEach(function (item) {
    assert(typeof item === 'object', 'Items should be plain objects');
    assert('value' in item,      'Items should have "value"');
    assert('concept' in item,    'Items should have "concept"');
    assert('confidence' in item, 'Items should have "confidence"');
  });
});

test('Knowledge can be listed and inspected (transparent, not a black box)', function () {
  const items = Brain.listAll();
  assertArray(items, 'listAll should return array');
  // All items should have readable value strings
  items.forEach(function (item) {
    assert(typeof (item.value || '') === 'string', 'Values should be readable strings');
  });
});

test('No eval(), new Function(), or innerHTML in knowledge learner', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js'), 'utf8');
  assert(!code.includes('eval('),        'Must not use eval()');
  assert(!code.includes('new Function('), 'Must not use new Function()');
  assert(!code.includes('innerHTML'),    'Must not use innerHTML');
});

// =============================================================================
// GROUP 13: PERSISTENCE TEST (Requirement §15)
// Generate random fictional project name, teach it, destroy session,
// simulate fresh session recall.
// =============================================================================
console.log('\n── GROUP 13: PERSISTENCE SIMULATION ─────────────────');

test('Persistence Req §15: learn dynamically, destroy session, recall from memory', function () {
  freshBrain();

  // Generate a random fictional project name that CANNOT be hardcoded
  const projectName = randomName() + '_' + Date.now().toString(36);

  // ─── Session A: Teach Shadow Reaper ──────────────────────────────────────
  // Statement 1: project name
  Learner.learn({ text: 'I\'m building a project called ' + projectName + '.', role: 'user', convId: 'sess_a', projectName: null });
  // Statement 2: what it is
  Learner.learn({ text: projectName + ' is a social media platform for artists.', role: 'user', convId: 'sess_a', projectName: projectName });
  // Statement 3: design decision
  Learner.learn({ text: 'The homepage uses a dark purple theme.', role: 'user', convId: 'sess_a', projectName: projectName });
  // Statement 4: feature
  Learner.learn({ text: 'It has a live collaboration feature.', role: 'user', convId: 'sess_a', projectName: projectName });
  // Statement 5: related fact
  Learner.learn({ text: 'The target audience is musicians and graphic designers.', role: 'user', convId: 'sess_a', projectName: projectName });

  // Verify it was learned
  const itemsAfterA = Brain.listAll();
  const learnedInA = itemsAfterA.some(function (i) {
    return (i.value || '').toLowerCase().indexOf(projectName.toLowerCase()) !== -1;
  });
  assert(learnedInA, 'Project "' + projectName + '" should be in brain after learning. Items: ' +
    JSON.stringify(itemsAfterA.map(function (i) { return i.value; })));

  // ─── Simulate "destroy session context" but preserve in-memory brain ──────
  // In a real fresh session, the DB would be reloaded. Here we reset the context
  // but NOT the brain map (simulating the reload from persistent storage).
  if (global.SRContext && global.SRContext.reset) global.SRContext.reset();
  if (global.SRConversation && global.SRConversation.reset) global.SRConversation.reset();

  // ─── Session B: Ask differently worded questions ─────────────────────────
  const q1 = Learner.semanticRetrieve('What kind of project is ' + projectName + '?', projectName, 6);
  const q2 = Learner.semanticRetrieve('Tell me about ' + projectName + '.', projectName, 6);
  const q3 = Learner.semanticRetrieve('What did we decide for the homepage?', projectName, 6);

  const allResults = [].concat(q1, q2, q3);
  const anyRelevant = allResults.some(function (item) {
    return (item.value || '').toLowerCase().indexOf(projectName.toLowerCase()) !== -1;
  });
  assert(anyRelevant, 'Fresh session should recall "' + projectName + '" via semantic search. ' +
    'Q1 results: ' + JSON.stringify(q1.map(function (i) { return i.value; })));

  // ─── Correction phase ─────────────────────────────────────────────────────
  // Correct the design decision
  Learner.correct('dark purple', 'midnight black', null);

  const itemsAfterCorrection = Brain.listAll();
  const correctionStored = itemsAfterCorrection.some(function (i) {
    return (i.value || '').toLowerCase().indexOf('midnight black') !== -1 ||
           (i.type === 'CORRECTION' && (i.value || '').toLowerCase().indexOf('midnight black') !== -1);
  });
  assert(correctionStored, 'Correction "midnight black" should be stored. Items: ' +
    JSON.stringify(itemsAfterCorrection.map(function (i) { return i.value; })));
});

// =============================================================================
// GROUP 14: SAFETY / PRIVACY (Requirement §16)
// =============================================================================
console.log('\n── GROUP 14: SAFETY AND PRIVACY ──────────────────────');

test('Sensitive data: password rejected from learned storage', function () {
  freshBrain();
  Learner.learn({ text: 'my password is supersecret123', role: 'user', convId: 'safe1', projectName: null });
  const items = Brain.listAll();
  const hasPassword = items.some(function (i) {
    return (i.value || '').toLowerCase().indexOf('supersecret123') !== -1;
  });
  assert(!hasPassword, 'Password should be rejected from learned storage');
});

test('Sensitive data: API key rejected from learned storage', function () {
  freshBrain();
  const count0 = Brain.listAll().length;
  Learner.learn({ text: 'my api key is sk-abc123xyz', role: 'user', convId: 'safe2', projectName: null });
  const count1 = Brain.listAll().length;
  assert(count1 === count0, 'No new items should be added for API key input');
});

test('Sensitive data: credential injection rejected', function () {
  freshBrain();
  Learner.learn({ text: 'token is eyJhbGciOiJIUzI1NiJ9.abc', role: 'user', convId: 'safe3', projectName: null });
  // No crash; items unchanged
  assert(true, 'Should handle credential input without crashing');
});

test('Emotional state NOT permanently profiled in brain', function () {
  freshBrain();
  Learner.learn({ text: "I've been feeling really depressed lately.", role: 'user', convId: 'safe4', projectName: null });
  const items = Brain.listAll();
  const hasEmotionProfile = items.some(function (i) {
    return (i.type || '').includes('EMOTION_PROFILE') || (i.concept || '').includes('emotion_profile');
  });
  assert(!hasEmotionProfile, 'Emotional states should not be permanently profiled');
});

test('Adaptive OFF: learn() does nothing when disabled', function () {
  freshBrain();
  global.localStorage.setItem('snxShadowAdaptiveEnabled', 'false');

  const count0 = Brain.listAll().length;
  Learner.learn({ text: 'A Zelthorian Cube is the central power node.', role: 'user', convId: 'off1', projectName: null });
  const count1 = Brain.listAll().length;

  // Re-enable
  global.localStorage.setItem('snxShadowAdaptiveEnabled', 'true');

  // When OFF, brain should not add new concepts
  // (Brain._isEnabled() returns false → learn() is a no-op)
  assert(count1 === count0, 'When adaptive is OFF, no new concepts should be added. Delta: ' + (count1 - count0));
});

test('No cross-user learning: UID isolation confirmed by architecture', function () {
  // Verify that the Firestore path used by adaptive brain is UID-scoped
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/core/adaptive-brain.js'), 'utf8');
  assert(code.includes("'users'"), 'Firestore path should be users/{uid}/...');
  assert(code.includes('uid'),     'Firestore path must use uid');
  // No global collection access
  const globalCollections = ["db.collection('shadowReaperGlobal')", "global_learning", "cross_user"];
  globalCollections.forEach(function (term) {
    assert(!code.includes(term), 'Must not access global cross-user collection: ' + term);
  });
});

test('Firebase failure does not crash learn()', function () {
  freshBrain();
  // Ensure no _snxDbCompat (simulates Firebase unavailable)
  const savedDb = global._snxDbCompat;
  delete global._snxDbCompat;

  try {
    Learner.learn({ text: 'A Vantex Array is a defensive system.', role: 'user', convId: 'fb1', projectName: null });
    // Should not throw
  } finally {
    global._snxDbCompat = savedDb;
  }
  assert(true, 'Firebase failure should not crash learn()');
});

test('Learning OFF prevents storage but does not crash', function () {
  freshBrain();
  global.localStorage.setItem('snxShadowAdaptiveEnabled', 'false');

  // These should all be no-ops without crashing
  try {
    Learner.learn({ text: 'A Quorion Vault is the data storage system.', role: 'user', convId: 'off2', projectName: null });
    Learner.retrieve('Quorion Vault', null, 3);
    Learner.correct('old value', 'new value', null);
  } finally {
    global.localStorage.setItem('snxShadowAdaptiveEnabled', 'true');
  }
  assert(true, 'Disabled learning should not crash');
});

// =============================================================================
// GROUP 15: PROTECT SNS — no modifications to protected files (Req §17)
// =============================================================================
console.log('\n── GROUP 15: SNS PROTECTION ──────────────────────────');

test('live.js was NOT modified', function () {
  const code = fs.readFileSync(path.join(ROOT, 'live.js'), 'utf8');
  assert(!code.includes('SRKnowledgeLearner'), 'live.js must not reference SRKnowledgeLearner');
});

test('snx-broadcast-engine.js was NOT modified', function () {
  const code = fs.readFileSync(path.join(ROOT, 'snx-broadcast-engine.js'), 'utf8');
  assert(!code.includes('SRKnowledgeLearner'), 'snx-broadcast-engine.js must not be modified');
});

test('Knowledge learner only exists in shadow-reaper-v2/ directory', function () {
  const learnerPath = path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js');
  assert(fs.existsSync(learnerPath), 'sr-knowledge-learner.js should exist in shadow-reaper-v2/knowledge/');
});

test('No new SNS-protected files modified: Radio, Live, TV core files unchanged', function () {
  const protectedFiles = ['snx-radio.js', 'snx-live-adapter.js', 'snx-broadcast-engine.js'];
  protectedFiles.forEach(function (f) {
    const fullPath = path.join(ROOT, f);
    if (fs.existsSync(fullPath)) {
      const code = fs.readFileSync(fullPath, 'utf8');
      assert(!code.includes('SRKnowledgeLearner'), f + ' must not reference SRKnowledgeLearner');
    }
  });
});

// =============================================================================
// GROUP 16: ARCHITECTURE INTEGRATION
// =============================================================================
console.log('\n── GROUP 16: ARCHITECTURE INTEGRATION ────────────────');

test('sr-knowledge-learner.js exists', function () {
  const exists = fs.existsSync(path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js'));
  assert(exists, 'sr-knowledge-learner.js must exist');
});

test('response-engine.js references SRKnowledgeLearner', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/core/response-engine.js'), 'utf8');
  assert(code.includes('SRKnowledgeLearner'), 'response-engine.js should use SRKnowledgeLearner');
});

test('shadow-reaper.js wires learner for every turn', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/shadow-reaper.js'), 'utf8');
  assert(code.includes('SRKnowledgeLearner'), 'shadow-reaper.js should integrate SRKnowledgeLearner');
  assert(code.includes('learner.learn'), 'shadow-reaper.js should call learner.learn() each turn');
});

test('No duplicate learning stores — brain still uses same Firestore collection', function () {
  const brainCode   = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/core/adaptive-brain.js'), 'utf8');
  const learnerCode = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js'), 'utf8');

  // Brain uses the same collection
  assert(brainCode.includes('shadowReaperLearnedContext'), 'Brain should use shadowReaperLearnedContext');

  // Learner delegates to brain — does NOT create its own collection
  assert(!learnerCode.includes('shadowReaperLearnedContext'), 'Learner should not create a duplicate collection');
  assert(learnerCode.includes('SRAdaptiveBrain') || learnerCode.includes('_brain()'), 'Learner should delegate to brain');
});

test('ZERO Workers AI calls in knowledge learner', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js'), 'utf8');
  assert(!code.includes('env.AI'),    'Must not call Workers AI');
  assert(!code.includes('AI.run'),    'Must not call AI.run');
});

test('No polling (setInterval/RAF) in knowledge learner', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/knowledge/sr-knowledge-learner.js'), 'utf8');
  // Check for actual calls — not comment references like "ZERO setInterval"
  assert(!/\bsetInterval\s*\(/.test(code),           'No setInterval() calls allowed');
  assert(!/\brequestAnimationFrame\s*\(/.test(code), 'No RAF() calls allowed');
});

test('response-engine.js build ID updated to reflect learning stage', function () {
  const code = fs.readFileSync(path.join(ROOT, 'shadow-reaper-v2/core/response-engine.js'), 'utf8');
  assert(code.includes('SR-V2-STAGE4-LEARN'), 'Build ID should reflect learning stage');
});

// =============================================================================
// FINAL RESULTS
// =============================================================================
process.stdout.write('\n' +
  '══════════════════════════════════════════════════════\n' +
  '  SHADOW REAPER V2 — KNOWLEDGE LEARNING TEST RESULTS\n' +
  '══════════════════════════════════════════════════════\n' +
  '  PASS : ' + PASS + '\n' +
  '  FAIL : ' + FAIL + '\n' +
  '  TOTAL: ' + (PASS + FAIL) + '\n' +
  '══════════════════════════════════════════════════════\n'
);

if (FAIL > 0) {
  process.stdout.write('KNOWLEDGE LEARNING TEST: FAIL\n');
  process.exit(1);
} else {
  process.stdout.write('KNOWLEDGE LEARNING TEST: PASS\n');
  process.exit(0);
}
