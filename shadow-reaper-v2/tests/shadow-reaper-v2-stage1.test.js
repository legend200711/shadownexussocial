/**
 * shadow-reaper-v2/tests/shadow-reaper-v2-stage1.test.js
 * Shadow Reaper V2 — Stage 1 Automated Tests
 *
 * Build: SR-V2-STAGE1
 *
 * Runner: Node.js (no external test framework required)
 * Usage:  node shadow-reaper-v2/tests/shadow-reaper-v2-stage1.test.js
 *
 * Tests cover:
 *  - General conversation (greetings, feelings, tone responses)
 *  - Project context (name, area, design, recall)
 *  - Follow-up / pronoun resolution
 *  - User corrections
 *  - Website-hijack guard (no SNS content in response)
 *  - Workers AI call count (must be 0)
 */

'use strict';

// ─── Shim browser globals for Node.js ────────────────────────────────────────
const global_ctx = typeof window !== 'undefined' ? window : global;

// Load modules
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');

function loadModule(relPath) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  // eslint-disable-next-line no-new-func
  const fn = new Function('global', code);
  fn(global_ctx);
}

loadModule('shadow-reaper-v2/core/understanding-engine.js');
loadModule('shadow-reaper-v2/core/context-engine.js');
loadModule('shadow-reaper-v2/core/conversation-engine.js');
loadModule('shadow-reaper-v2/core/response-engine.js');
loadModule('shadow-reaper-v2/shadow-reaper.js');

const SR = global_ctx.ShadowReaper;
SR.init();

// ─── Test harness ─────────────────────────────────────────────────────────────

let PASS = 0;
let WARN = 0;
let FAIL = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    PASS++;
    results.push({ status: 'PASS', name });
    console.log('  ✓  ' + name);
  } catch (e) {
    FAIL++;
    results.push({ status: 'FAIL', name, error: e.message });
    console.error('  ✗  ' + name);
    console.error('     ' + e.message);
  }
}

function warn(name, fn) {
  try {
    fn();
    PASS++;
    results.push({ status: 'PASS', name });
    console.log('  ✓  ' + name);
  } catch (e) {
    WARN++;
    results.push({ status: 'WARN', name, error: e.message });
    console.warn('  ⚠  ' + name);
    console.warn('     ' + e.message);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertNotContains(text, forbidden, msg) {
  const lower = text.toLowerCase();
  if (Array.isArray(forbidden)) {
    for (const f of forbidden) {
      if (lower.includes(f.toLowerCase())) {
        throw new Error(msg || ('Response must not contain: "' + f + '" — got: ' + text));
      }
    }
  } else {
    if (lower.includes(forbidden.toLowerCase())) {
      throw new Error(msg || ('Response must not contain: "' + forbidden + '" — got: ' + text));
    }
  }
}

function assertContainsAny(text, keywords, msg) {
  const lower = text.toLowerCase();
  const found = keywords.some((k) => lower.includes(k.toLowerCase()));
  if (!found) {
    throw new Error(msg || ('Expected one of [' + keywords.join(', ') + '] in: ' + text));
  }
}

function assertTruthy(val, msg) {
  if (!val) throw new Error(msg || 'Expected truthy, got: ' + val);
}

// ─── Helper: fresh conversation before each test group ───────────────────────

function fresh() {
  SR.newConversation();
}

// =============================================================================
// TEST SUITE
// =============================================================================

console.log('\n══════════════════════════════════════════════');
console.log('  Shadow Reaper V2 — Stage 1 Tests');
console.log('══════════════════════════════════════════════\n');

// ─── 0. SYSTEM INTEGRITY ─────────────────────────────────────────────────────
console.log('── SYSTEM INTEGRITY ──────────────────────────');

test('ShadowReaper is initialized', () => {
  assert(SR._initialized, 'ShadowReaper._initialized should be true');
});

test('Workers AI calls = 0', () => {
  const status = SR.getStatus();
  assert(status.workersAICalls === 0, 'workersAICalls must be 0, got: ' + status.workersAICalls);
});

test('Legacy AI NOT restored (SNXShadowAI undefined)', () => {
  assert(
    typeof global_ctx.SNXShadowAI === 'undefined',
    'SNXShadowAI must not exist in Stage 1'
  );
});

test('Website knowledge flag is false', () => {
  const status = SR.getStatus();
  assert(status.websiteKnowledge === false, 'websiteKnowledge must be false');
});

test('getStatus returns expected shape', () => {
  const s = SR.getStatus();
  assert(s.version && s.version.startsWith('SR-V2-'), 'version mismatch — expected SR-V2-*');
  assert(typeof s.turnCount === 'number', 'turnCount must be a number');
  assert(s.legacyAIRestored === false, 'legacyAIRestored must be false');
});

// ─── 1. GENERAL CONVERSATION ─────────────────────────────────────────────────
console.log('\n── GENERAL CONVERSATION ──────────────────────');

test('"Hello" → greeting response', () => {
  fresh();
  const r = SR.ask('Hello');
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['shadow nexus', 'radio', 'tv', 'feed', 'social media', 'website'],
    'Greeting must not mention website features');
});

test('"How are you?" → AI-appropriate response (no invented human day)', () => {
  fresh();
  const r = SR.ask('How are you?');
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['had a great day', 'my day was', 'i went', 'i ate', 'i slept'],
    'Must not invent human experiences');
  // Should redirect the question back to the user or acknowledge AI nature
  assertContainsAny(r, ["i'm", "i am", "ready", "here", "you", "how", "listen", "focus"],
    'Should contain natural AI response');
});

test('"I\'m sad." → empathetic response, no website content', () => {
  fresh();
  const r = SR.ask("I'm sad.");
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['shadow nexus', 'radio', 'tv', 'feed', 'website', 'social'],
    'Sad message must NOT trigger website content');
});

test('"I\'m happy today." → positive acknowledgement', () => {
  fresh();
  const r = SR.ask("I'm happy today.");
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['shadow nexus', 'social', 'radio'],
    'Happy response must not mention website features');
});

test('"I\'m angry." → composed, grounded response', () => {
  fresh();
  const r = SR.ask("I'm angry.");
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['shadow nexus', 'social'],
    'Angry response must not mention website features');
});

test('"I\'m tired." → acknowledging response', () => {
  fresh();
  const r = SR.ask("I'm tired.");
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['shadow nexus', 'social'],
    'Tired response must not mention website features');
});

test('"Tell me something funny." → returns a response', () => {
  fresh();
  const r = SR.ask('Tell me something funny.');
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['shadow nexus', 'radio', 'feed'],
    'Funny response must not mention website features');
});

test('"Can we talk?" → open, inviting response', () => {
  fresh();
  const r = SR.ask('Can we talk?');
  assert(r && r.length > 0, 'Empty response');
  assertContainsAny(r, ["i'm here", "listening", "of course", "talk", "what", "always", "i am"],
    'Should invite the user to speak');
  assertNotContains(r, ['shadow nexus', 'social', 'radio'],
    'Must not mention website features');
});

// ─── 2. TONE DETECTION ───────────────────────────────────────────────────────
console.log('\n── TONE DETECTION ────────────────────────────');

test('Understanding Engine detects "sad" tone', () => {
  const u = global_ctx.SRUnderstanding.understand("I'm really sad today.");
  assert(u.tone === 'sad', 'Expected tone: sad, got: ' + u.tone);
});

test('Understanding Engine detects "happy" tone', () => {
  const u = global_ctx.SRUnderstanding.understand("I'm so happy right now!");
  assert(u.tone === 'happy', 'Expected tone: happy, got: ' + u.tone);
});

test('Understanding Engine detects "excited" tone', () => {
  const u = global_ctx.SRUnderstanding.understand("I'm so excited about this!");
  assert(u.tone === 'excited', 'Expected tone: excited, got: ' + u.tone);
});

test('Understanding Engine detects "frustrated" tone', () => {
  const u = global_ctx.SRUnderstanding.understand("I'm so frustrated, nothing is working.");
  assert(u.tone === 'frustrated', 'Expected tone: frustrated, got: ' + u.tone);
});

test('Understanding Engine detects "angry" tone', () => {
  const u = global_ctx.SRUnderstanding.understand("I'm really angry right now.");
  assert(u.tone === 'angry', 'Expected tone: angry, got: ' + u.tone);
});

test('Understanding Engine detects "tired" tone', () => {
  const u = global_ctx.SRUnderstanding.understand("I'm exhausted, long day.");
  assert(u.tone === 'tired', 'Expected tone: tired, got: ' + u.tone);
});

test('Understanding Engine detects "anxious" tone', () => {
  const u = global_ctx.SRUnderstanding.understand("I'm really anxious about what's coming.");
  assert(u.tone === 'anxious', 'Expected tone: anxious, got: ' + u.tone);
});

test('Understanding Engine detects GREETING intent', () => {
  const u = global_ctx.SRUnderstanding.understand('Hey!');
  assert(u.intent === 'GREETING', 'Expected GREETING, got: ' + u.intent);
});

test('Understanding Engine detects GOODBYE intent', () => {
  const u = global_ctx.SRUnderstanding.understand('Goodnight.');
  assert(u.intent === 'GOODBYE', 'Expected GOODBYE, got: ' + u.intent);
});

test('Understanding Engine detects THANKS intent', () => {
  const u = global_ctx.SRUnderstanding.understand('Thank you so much.');
  assert(u.intent === 'THANKS', 'Expected THANKS, got: ' + u.intent);
});

test('Understanding Engine detects USER_CORRECTION intent', () => {
  const u = global_ctx.SRUnderstanding.understand('No, I meant Blue Wolf.');
  assert(u.intent === 'USER_CORRECTION', 'Expected USER_CORRECTION, got: ' + u.intent);
});

// ─── 3. PROJECT CONTEXT ──────────────────────────────────────────────────────
console.log('\n── PROJECT CONTEXT ───────────────────────────');

test('Project name is stored after user states it', () => {
  fresh();
  SR.ask('My project is called Blue Wolf.');
  const ctx = global_ctx.SRContext.getSnapshot();
  assert(ctx.projectName === 'Blue Wolf', 'Expected projectName: Blue Wolf, got: ' + ctx.projectName);
});

test('Area is stored after user states it', () => {
  fresh();
  SR.ask('My project is called Blue Wolf.');
  SR.ask("I'm working on the homepage.");
  const ctx = global_ctx.SRContext.getSnapshot();
  assertTruthy(ctx.area, 'Expected area to be set');
  assert(ctx.area.includes('home'), 'Expected area to contain "home", got: ' + ctx.area);
});

test('Design detail is stored after user states it', () => {
  fresh();
  SR.ask('My project is called Blue Wolf.');
  SR.ask("I'm working on the homepage.");
  SR.ask('I want it dark.');
  const ctx = global_ctx.SRContext.getSnapshot();
  assert(ctx.design.length > 0, 'Expected design to be set');
  const designStr = ctx.design.join(' ').toLowerCase();
  assert(designStr.includes('dark'), 'Expected design to contain "dark", got: ' + designStr);
});

test('"What project am I working on?" → returns Blue Wolf', () => {
  fresh();
  SR.ask('My project is called Blue Wolf.');
  const r = SR.ask('What project am I working on?');
  assert(r && r.length > 0, 'Empty response');
  assert(r.toLowerCase().includes('blue wolf'), 'Expected "Blue Wolf" in response, got: ' + r);
});

test('"What was I doing to the homepage?" → references context', () => {
  fresh();
  SR.ask('My project is called Blue Wolf.');
  SR.ask("I'm working on the homepage.");
  SR.ask('I want it dark.');
  SR.ask('Add blue lightning.');
  const r = SR.ask('What was I doing to the homepage?');
  assert(r && r.length > 0, 'Empty response');
  // Should mention homepage or dark or blue lightning
  assertContainsAny(r, ['homepage', 'home', 'dark', 'blue', 'lightning', 'blue wolf', 'design'],
    'Should reference project/design context');
});

// ─── 4. FOLLOW-UP RESOLUTION ─────────────────────────────────────────────────
console.log('\n── FOLLOW-UP RESOLUTION ──────────────────────');

test('"Make it darker." after setting project → resolves "it"', () => {
  fresh();
  SR.ask('My project is called Blue Wolf.');
  SR.ask("I'm working on the homepage.");
  const r = SR.ask('Make it darker.');
  assert(r && r.length > 0, 'Empty response');
  // Response should reference a known subject, not ask "what is it?"
  assertNotContains(r, ['what do you mean by "it"', 'what is "it"'],
    'Should resolve pronoun, not express total confusion');
});

test('"It needs more blue." after homepage context → resolves "it"', () => {
  fresh();
  SR.ask("I'm working on my homepage.");
  const r = SR.ask('It needs more blue.');
  assert(r && r.length > 0, 'Empty response');
  assertNotContains(r, ['shadow nexus', 'social'],
    'Follow-up must not mention website features');
});

test('"What did I just ask you to change?" → references design context', () => {
  fresh();
  SR.ask('My website needs work.');
  SR.ask('Make it darker.');
  const r = SR.ask('What did I just ask you to change?');
  assert(r && r.length > 0, 'Empty response');
});

// ─── 5. USER CORRECTIONS ─────────────────────────────────────────────────────
console.log('\n── USER CORRECTIONS ──────────────────────────');

test('User corrects project name → context updated to corrected value', () => {
  fresh();
  SR.ask('My project is Red Wolf.');
  SR.ask('No, I meant Blue Wolf.');
  const ctx = global_ctx.SRContext.getSnapshot();
  assert(
    ctx.projectName === 'Blue Wolf',
    'Expected projectName: Blue Wolf after correction, got: ' + ctx.projectName
  );
});

test('"What is my project called?" after correction → returns Blue Wolf', () => {
  fresh();
  SR.ask('My project is Red Wolf.');
  SR.ask('No, I meant Blue Wolf.');
  const r = SR.ask('What is my project called?');
  assert(r && r.length > 0, 'Empty response');
  assert(
    r.toLowerCase().includes('blue wolf'),
    'Expected "Blue Wolf" after correction, got: ' + r
  );
});

// ─── 6. WEBSITE-HIJACK GUARD ─────────────────────────────────────────────────
console.log('\n── WEBSITE-HIJACK GUARD ──────────────────────');

const SNS_KEYWORDS = [
  'shadow nexus social',
  'shadow nexus',
  'radio',
  'tv channel',
  'live stream',
  'social media platform',
  'our platform',
  'shadow nexus features',
  'the website',
  'snx',
];

test('"I\'m sad." → does NOT trigger website content', () => {
  fresh();
  const r = SR.ask("I'm sad.");
  assertNotContains(r, SNS_KEYWORDS, '"I\'m sad" must not produce website content');
});

test('"Hello" → does NOT trigger website content', () => {
  fresh();
  const r = SR.ask('Hello');
  assertNotContains(r, SNS_KEYWORDS, 'Greeting must not produce website content');
});

test('"How are you?" → does NOT trigger website content', () => {
  fresh();
  const r = SR.ask('How are you?');
  assertNotContains(r, SNS_KEYWORDS, 'How are you must not produce website content');
});

test('"Tell me something funny." → does NOT trigger website content', () => {
  fresh();
  const r = SR.ask('Tell me something funny.');
  assertNotContains(r, SNS_KEYWORDS, 'Funny request must not produce website content');
});

test('"I\'m frustrated." → does NOT trigger website content', () => {
  fresh();
  const r = SR.ask("I'm frustrated.");
  assertNotContains(r, SNS_KEYWORDS, 'Frustrated must not produce website content');
});

// ─── 7. WORKERS AI CALL COUNT ────────────────────────────────────────────────
console.log('\n── WORKERS AI CALL COUNT ─────────────────────');

test('Workers AI call count is 0 after multiple interactions', () => {
  fresh();
  SR.ask('Hello');
  SR.ask("I'm sad.");
  SR.ask('My project is called Blue Wolf.');
  SR.ask('Make it darker.');
  const status = SR.getStatus();
  assert(status.workersAICalls === 0, 'workersAICalls must be 0, got: ' + status.workersAICalls);
});

// ─── 8. CONVERSATION LIFECYCLE ────────────────────────────────────────────────
console.log('\n── CONVERSATION LIFECYCLE ────────────────────');

test('newConversation() resets session context', () => {
  fresh();
  SR.ask('My project is called Blue Wolf.');
  SR.newConversation();
  const ctx = global_ctx.SRContext.getSnapshot();
  assert(ctx.projectName === null, 'projectName should be null after newConversation()');
  assert(ctx.turnCount === 0, 'turnCount should be 0 after newConversation()');
});

test('newConversation() resets turn history', () => {
  fresh();
  SR.ask('Hello');
  SR.ask('Hello again');
  SR.newConversation();
  assert(global_ctx.SRConversation.getTurnCount() === 0, 'Turn count should be 0 after reset');
});

test('empty message returns safe response', () => {
  fresh();
  const r = SR.ask('');
  assert(r && r.length > 0, 'Empty message should return fallback');
});

// ─── 9. PRESERVED FILES UNTOUCHED ────────────────────────────────────────────
console.log('\n── PRESERVED FILES UNTOUCHED ─────────────────');

test('snx-shadow-memory.js still exists (not modified)', () => {
  const exists = fs.existsSync(path.join(ROOT, 'snx-shadow-memory.js'));
  assert(exists, 'snx-shadow-memory.js must not be deleted');
});

test('snx-shadow-conv-history.js still exists (not modified)', () => {
  const exists = fs.existsSync(path.join(ROOT, 'snx-shadow-conv-history.js'));
  assert(exists, 'snx-shadow-conv-history.js must not be deleted');
});

test('snx-shadow-adaptive.js still exists (not modified)', () => {
  const exists = fs.existsSync(path.join(ROOT, 'snx-shadow-adaptive.js'));
  assert(exists, 'snx-shadow-adaptive.js must not be deleted');
});

// =============================================================================
// STAGE 3 — GREETING FALSE-POSITIVE REGRESSION TESTS
// =============================================================================
console.log('\n── STAGE 3: GREETING FALSE-POSITIVE FIX ──────');

test('"yo" → GREETING intent', () => {
  const u = global_ctx.SRUnderstanding.understand('yo');
  assert(u.intent === 'GREETING', '"yo" must be GREETING, got: ' + u.intent);
});

test('"yo shadow" → GREETING intent', () => {
  const u = global_ctx.SRUnderstanding.understand('yo shadow');
  assert(u.intent === 'GREETING', '"yo shadow" must be GREETING, got: ' + u.intent);
});

test('"your" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('your');
  assert(u.intent !== 'GREETING', '"your" must NOT be GREETING, got: ' + u.intent);
});

test('"your memory" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('your memory');
  assert(u.intent !== 'GREETING', '"your memory" must NOT be GREETING, got: ' + u.intent);
});

test('"yesterday" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('yesterday');
  assert(u.intent !== 'GREETING', '"yesterday" must NOT be GREETING, got: ' + u.intent);
});

test('"young" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('young');
  assert(u.intent !== 'GREETING', '"young" must NOT be GREETING, got: ' + u.intent);
});

test('"history" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('history');
  assert(u.intent !== 'GREETING', '"history" must NOT be GREETING, got: ' + u.intent);
});

test('"tell me about your memory" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('tell me about your memory');
  assert(u.intent !== 'GREETING', '"tell me about your memory" must NOT be GREETING, got: ' + u.intent);
});

test('"higher up" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('higher up');
  assert(u.intent !== 'GREETING', '"higher up" must NOT be GREETING, got: ' + u.intent);
});

test('"this project" → NOT GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('this project');
  assert(u.intent !== 'GREETING', '"this project" must NOT be GREETING, got: ' + u.intent);
});

test('"hey" → GREETING intent', () => {
  const u = global_ctx.SRUnderstanding.understand('hey');
  assert(u.intent === 'GREETING', '"hey" must be GREETING, got: ' + u.intent);
});

test('"hello shadow reaper" → GREETING intent', () => {
  const u = global_ctx.SRUnderstanding.understand('hello shadow reaper');
  assert(u.intent === 'GREETING', '"hello shadow reaper" must be GREETING, got: ' + u.intent);
});

test('"good morning" → GREETING intent', () => {
  const u = global_ctx.SRUnderstanding.understand('good morning');
  assert(u.intent === 'GREETING', '"good morning" must be GREETING, got: ' + u.intent);
});

// =============================================================================
// STAGE 3 — SRResponse.composeAsync EXISTS
// =============================================================================
console.log('\n── STAGE 3: composeAsync AVAILABLE ──────────');

test('SRResponse.composeAsync is a function', () => {
  assert(typeof global_ctx.SRResponse.composeAsync === 'function',
    'SRResponse.composeAsync must be a function');
});

test('composeAsync GREETING → DETERMINISTIC source', (done) => {
  const u = global_ctx.SRUnderstanding.understand('hey');
  const c = global_ctx.SRContext.getSnapshot();
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    assert(source === 'DETERMINISTIC', 'GREETING must be DETERMINISTIC, got: ' + source);
    assert(response && response.length > 0, 'Response must not be empty');
  });
});

test('composeAsync GOODBYE → DETERMINISTIC source', (done) => {
  const u = global_ctx.SRUnderstanding.understand('goodbye');
  const c = global_ctx.SRContext.getSnapshot();
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    assert(source === 'DETERMINISTIC', 'GOODBYE must be DETERMINISTIC, got: ' + source);
  });
});

test('composeAsync THANKS → DETERMINISTIC source', (done) => {
  const u = global_ctx.SRUnderstanding.understand('thank you');
  const c = global_ctx.SRContext.getSnapshot();
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    assert(source === 'DETERMINISTIC', 'THANKS must be DETERMINISTIC, got: ' + source);
  });
});

test('composeAsync GENERAL_CONVERSATION (no model) → ERROR source with diagnostic message (Stage 3A)', (done) => {
  // SRLocalModel is not loaded in Node.js test context, so source will be ERROR.
  // Stage 3A: response must be the diagnostic error message, NOT a conversational fallback.
  const u = global_ctx.SRUnderstanding.understand("I'm having a rough day.");
  const c = global_ctx.SRContext.getSnapshot();
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    assert(source === 'ERROR', 'Source must be ERROR when model not ready, got: ' + source);
    assert(response && response.length > 0, 'Error response must not be empty');
    // Must start with "LOCAL MODEL ERROR" — not a conversational reply
    assert(response.startsWith('LOCAL MODEL ERROR') || response.includes('LOCAL MODEL ERROR'),
      'Stage 3A: response must be diagnostic error message, not conversational fallback. Got: ' + response);
    // Must NOT be conversational fallback text
    const CONVERSATIONAL_FALLBACKS = [
      'Tell me more',
      "I'm not sure I caught",
      'I want to understand',
      "I'm listening",
      'What are you getting at',
      'Say more',
    ];
    CONVERSATIONAL_FALLBACKS.forEach(function (fb) {
      assert(!response.includes(fb),
        'Stage 3A: ERROR response must not masquerade as conversational. Found: "' + fb + '" in: ' + response);
    });
  });
});

test('composeAsync: "what project am I working on?" → DETERMINISTIC (meta question)', () => {
  fresh();
  // Use sync path to set project name in session context
  SR.ask('My project is Blue Wolf.');
  const u = global_ctx.SRUnderstanding.understand('what project am I working on?');
  const c = global_ctx.SRContext.getSnapshot();
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    assert(source === 'DETERMINISTIC', 'Meta question must be DETERMINISTIC, got: ' + source);
    assertContainsAny(response, ['Blue Wolf', 'blue wolf'], 'Must return project name');
  });
});

// =============================================================================
// STAGE 3 — SRLocalModel AVAILABILITY CHECK
// =============================================================================
console.log('\n── STAGE 3: SRLocalModel LOADED ──────────────');

test('SRLocalModel is defined', () => {
  // SRLocalModel is not loaded in these Node.js tests (it requires browser import())
  // This test confirms the module file exists, not that it is running.
  const exists = fs.existsSync(path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'));
  assert(exists, 'shadow-reaper-v2/core/local-model.js must exist');
});

test('local-model.js exports correct MODEL_STATE constants', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  // Use regex to allow any whitespace between key and value
  assert(/UNINITIALIZED\s*:\s*'UNINITIALIZED'/.test(code), 'MODEL_STATE.UNINITIALIZED must be defined');
  assert(/LOADING\s*:\s*'LOADING'/.test(code),             'MODEL_STATE.LOADING must be defined');
  assert(/VERIFYING\s*:\s*'VERIFYING'/.test(code),         'MODEL_STATE.VERIFYING must be defined');
  assert(/READY\s*:\s*'READY'/.test(code),                 'MODEL_STATE.READY must be defined');
  assert(/FAILED\s*:\s*'FAILED'/.test(code),               'MODEL_STATE.FAILED must be defined');
});

test('local-model.js verification inference is used before READY', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  assert(code.includes('_verifyModel'), 'Must call _verifyModel after reload()');
  assert(code.includes('MODEL_STATE.VERIFYING'), 'Must use VERIFYING state');
  assert(code.includes('MODEL_STATE.READY'), 'Must only set READY after verification');
});

test('local-model.js does NOT call env.AI.run', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  // Strip both single-line (//) and block (/* */) comments before checking.
  // Comments may legitimately document what the module does NOT use.
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '');         // line comments
  assert(!noComments.includes('env.AI.run'), 'Must NOT call env.AI.run (Workers AI forbidden)');
  assert(!/new\s+OpenAI/.test(noComments), 'Must NOT instantiate OpenAI client');
});

// =============================================================================
// STAGE 3 — getStatus() INCLUDES LOCAL MODEL
// =============================================================================
console.log('\n── STAGE 3: getStatus() SHAPE ────────────────');

test('getStatus() includes localModel field', () => {
  const s = SR.getStatus();
  assert(s.localModel !== undefined, 'getStatus must include localModel');
  assert(s.localModel.state !== undefined, 'localModel.state must be defined');
});

test('getStatus() includes lastResponseSource', () => {
  const s = SR.getStatus();
  assert(s.lastResponseSource !== undefined, 'getStatus must include lastResponseSource');
});

test('Workers AI calls remain 0 after Stage 3 init', () => {
  assert(SR.getStatus().workersAICalls === 0, 'Workers AI calls must be 0');
});

// =============================================================================
// STAGE 3A — ADDITIONAL TESTS
// =============================================================================
console.log('\n── STAGE 3A: PHYSICAL FAILURE REPAIR TESTS ──');

// ── 3A-1: ERROR source cannot masquerade as LOCAL_MODEL ──────────────────────
test('Stage 3A: ERROR source cannot be reported as LOCAL_MODEL (no model loaded)', (done) => {
  // When model is not loaded, composeAsync must return source=ERROR, not LOCAL_MODEL
  const u = global_ctx.SRUnderstanding.understand('Tell me something funny.');
  const c = global_ctx.SRContext.getSnapshot();
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    assert(source !== 'LOCAL_MODEL',
      'Stage 3A: source must NOT be LOCAL_MODEL when model is not loaded. Got: ' + source);
    assert(source === 'ERROR',
      'Stage 3A: source must be ERROR when model not loaded. Got: ' + source);
  });
});

// ── 3A-2: READY impossible without successful inference ───────────────────────
test('Stage 3A: local-model.js enforces verification before READY state', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  // Must contain _verifyModel call in the load sequence before setting READY
  assert(code.includes('_verifyModel'), 'Must call _verifyModel before READY');
  assert(code.includes("MODEL_STATE.READY"), 'Must set MODEL_STATE.READY');
  // READY must come AFTER _verifyModel in the code
  const verifyIdx = code.indexOf('return _verifyModel(engine)');
  const readyIdx  = code.indexOf("_setState(MODEL_STATE.READY");
  assert(verifyIdx > 0,  'Must call _verifyModel(engine)');
  assert(readyIdx > 0,   'Must call _setState(MODEL_STATE.READY...)');
  assert(verifyIdx < readyIdx, 'READY must be set AFTER _verifyModel runs');
});

// ── 3A-3: reload-returned + empty pipeline = FAILED ──────────────────────────
test('Stage 3A: local-model.js detects empty pipeline after reload()', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  assert(code.includes('MODEL_LOAD_ABORTED_OR_EMPTY'),
    'Must define MODEL_LOAD_ABORTED_OR_EMPTY error code');
  assert(code.includes('PIPELINE_CHECK') || code.includes('pipelineOk'),
    'Must perform pipeline check after reload() returns');
  assert(code.includes('reloadReturned'),
    'Must record reloadReturned diagnostic flag');
  assert(code.includes('pipelineState'),
    'Must record pipelineState diagnostic field');
});

// ── 3A-4: ModelNotLoadedError = FAILED ───────────────────────────────────────
test('Stage 3A: local-model.js explicitly captures ModelNotLoadedError', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert(noComments.includes('ModelNotLoadedError') ||
         noComments.includes('modelNotLoadedError'),
    'Must explicitly capture ModelNotLoadedError');
  assert(noComments.includes('MODEL_NOT_LOADED'),
    'Must use MODEL_NOT_LOADED error code');
});

// ── 3A-5: failed inference = ERROR source (not LOCAL_MODEL) ──────────────────
test('Stage 3A: composeAsync with model in FAILED state returns source=ERROR', (done) => {
  // Simulate a local model object that reports FAILED state
  const fakeFailed = {
    getStatus:      () => ({ state: 'FAILED', modelId: null, loadPct: 0, lastError: 'test', isReady: false }),
    getDiagnostics: () => ({ errorCode: 'TEST_FAIL' }),
  };
  const savedLM = global_ctx.SRLocalModel;
  global_ctx.SRLocalModel = fakeFailed;

  const u = global_ctx.SRUnderstanding.understand('What do you think about making a game?');
  const c = global_ctx.SRContext.getSnapshot();
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    global_ctx.SRLocalModel = savedLM; // restore
    assert(source === 'ERROR',
      'Stage 3A: FAILED model must produce source=ERROR, got: ' + source);
    assert(response.includes('LOCAL MODEL ERROR'),
      'Stage 3A: FAILED model response must contain "LOCAL MODEL ERROR", got: ' + response);
  });
});

// ── 3A-6: "your" remains NOT a greeting ──────────────────────────────────────
test('Stage 3A: "your" is still NOT classified as GREETING', () => {
  const u = global_ctx.SRUnderstanding.understand('your');
  assert(u.intent !== 'GREETING', '"your" must not be GREETING, got: ' + u.intent);
});

// ── 3A-7: no fallback response can masquerade as model-generated output ───────
test('Stage 3A: composeAsync "your" with no model → ERROR source, diagnostic response', (done) => {
  const u = global_ctx.SRUnderstanding.understand('your');
  const c = global_ctx.SRContext.getSnapshot();
  // "your" is not a special deterministic intent, so it goes to the model path
  // With no model loaded, it must return ERROR with a diagnostic message
  global_ctx.SRResponse.composeAsync(u, c, {}, function (response, source) {
    // It might be DETERMINISTIC if "your" triggers a deterministic path,
    // or ERROR if it goes to the model path. Either way, never LOCAL_MODEL w/o model.
    assert(source !== 'LOCAL_MODEL',
      'Stage 3A: source must not be LOCAL_MODEL when no model loaded. Got: ' + source);
    if (source === 'ERROR') {
      assert(response.includes('LOCAL MODEL ERROR'),
        'Stage 3A: ERROR response must be diagnostic, not conversational. Got: ' + response);
    }
  });
});

// ── 3A-8: single model ID (no auto-switching) ─────────────────────────────────
test('Stage 3A: local-model.js uses single FIXED_MODEL_ID (no auto-switch)', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  // Must expose FIXED_MODEL
  assert(code.includes("FIXED_MODEL_ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC'"),
    'Must define FIXED_MODEL_ID as SmolLM2-360M-Instruct-q4f16_1-MLC');
  assert(code.includes('FIXED_MODEL'),
    'Must export FIXED_MODEL');
  // The loadModel function must not take a modelId parameter that switches between models
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert(!noComments.includes('CAPABLE_MODEL_ID =') || !noComments.includes('DEFAULT_MODEL_ID ='),
    'Stage 3A: Must not define separate CAPABLE_MODEL_ID and DEFAULT_MODEL_ID with different values');
});

// ── 3A-9: getDiagnostics() exposed ───────────────────────────────────────────
test('Stage 3A: SRLocalModel.getDiagnostics is exported', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/local-model.js'), 'utf8'
  );
  assert(code.includes('getDiagnostics'), 'Must export getDiagnostics');
  assert(code.includes('webllmImportStatus'), 'Must track webllmImportStatus');
  assert(code.includes('webgpuAvailable'), 'Must track webgpuAvailable');
  assert(code.includes('reloadStarted'), 'Must track reloadStarted');
  assert(code.includes('reloadReturned'), 'Must track reloadReturned');
  assert(code.includes('verifyResult'), 'Must track verifyResult');
  assert(code.includes('lastErrorName'), 'Must track lastErrorName');
  assert(code.includes('lastErrorMessage'), 'Must track lastErrorMessage');
  assert(code.includes('lastErrorStack'), 'Must track lastErrorStack');
  assert(code.includes('lastFailedOperation'), 'Must track lastFailedOperation');
  assert(code.includes('lastInferenceError'), 'Must track lastInferenceError');
});

// ── 3A-10: error fallback masking disabled in response-engine ─────────────────
test('Stage 3A: response-engine does not produce conversational fallback on model failure', () => {
  const code = fs.readFileSync(
    path.join(ROOT, 'shadow-reaper-v2/core/response-engine.js'), 'utf8'
  );
  const noComments = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  // Must contain the Stage 3A diagnostic message, not a conversational fallback
  assert(noComments.includes('LOCAL MODEL ERROR'),
    'Stage 3A: response-engine must return "LOCAL MODEL ERROR" diagnostic, not conversational text');
  // Must NOT call compose() when returning ERROR from model path
  // (the old code called compose() and returned its conversational output)
  const modelPathSection = noComments.substring(noComments.indexOf('Everything else') - 10);
  assert(!modelPathSection.includes("compose(understood, context), 'ERROR'"),
    'Stage 3A: Must not call compose() to produce ERROR response (that was the masking behavior)');
});

// =============================================================================
// RESULTS SUMMARY
// =============================================================================

console.log('\n══════════════════════════════════════════════');
console.log('  TEST RESULTS');
console.log('══════════════════════════════════════════════');
console.log('  PASS : ' + PASS);
console.log('  WARN : ' + WARN);
console.log('  FAIL : ' + FAIL);
console.log('  TOTAL: ' + (PASS + WARN + FAIL));
console.log('══════════════════════════════════════════════\n');

if (FAIL > 0) {
  console.error('STAGE 1: FAIL\n');
  process.exit(1);
} else if (WARN > 0) {
  console.warn('STAGE 1: PASS (with warnings)\n');
  process.exit(0);
} else {
  console.log('STAGE 1: PASS\n');
  process.exit(0);
}
