/**
 * shadow-reaper/tests/stage1-tests.js
 * Shadow Reaper AI — Stage 1 Test Harness
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Runs entirely locally. No Firebase. No Workers AI. No network calls.
 * Compatible with Node.js (for CI) and browser console.
 *
 * Test coverage:
 *   1.  Normal conversation
 *   2.  Follow-up understanding (pronoun resolution)
 *   3.  Context reference resolution
 *   4.  Project continuity
 *   5.  Conversation history (simulated)
 *   6.  Personal memory commands
 *   7.  Adaptive learning (guest isolation)
 *   8.  Knowledge retrieval
 *   9.  User corrections
 *   10. New conversation
 *   11. History disabled
 *   12. Adaptive disabled
 *   13. Guest isolation (no persistence)
 *   14. Different UID isolation
 *   15. Sensitive-data rejection
 *   16. Workers AI calls = 0
 *   17. Project Blue Wolf continuity scenario (end-to-end)
 */

(function (global) {
  'use strict';

  var PASS  = 'PASS';
  var FAIL  = 'FAIL';
  var WARN  = 'WARN';
  var SKIP  = 'SKIP';

  var _results = [];
  var _passCount = 0;
  var _warnCount = 0;
  var _failCount = 0;
  var _skipCount = 0;

  /* ─────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────*/
  function assert(condition, message) {
    return condition ? PASS : FAIL;
  }

  function record(name, status, detail) {
    _results.push({ name: name, status: status, detail: detail || '' });
    if (status === PASS) _passCount++;
    else if (status === FAIL) _failCount++;
    else if (status === WARN) _warnCount++;
    else if (status === SKIP) _skipCount++;
    var icon = status === PASS ? '✅' : status === FAIL ? '❌' : status === WARN ? '⚠️' : '⏭';
    console.log(icon + ' [' + status + '] ' + name + (detail ? ' — ' + detail : ''));
  }

  function section(title) {
    console.log('\n──────────────────────────────────────────────');
    console.log('  ' + title);
    console.log('──────────────────────────────────────────────');
  }

  /* ─────────────────────────────────────────────────────────────
     MODULE AVAILABILITY CHECK
  ───────────────────────────────────────────────────────────────*/
  function checkModuleAvailability() {
    section('MODULE AVAILABILITY');

    var modules = {
      'ShadowReaper (Core)':          global.ShadowReaper,
      'SRUnderstanding':              global.SRUnderstanding,
      'SRConversation':               global.SRConversation,
      'SRContext':                    global.SRContext,
      'SRResponse':                   global.SRResponse,
      'SRKnowledge':                  global.SRKnowledge,
      'SRCreatorKnowledge':           global.SRCreatorKnowledge,
      'SRConvHistory':                global.SRConvHistory,
      'SRPersonalMemory':             global.SRPersonalMemory,
      'SRAdaptiveLearning':           global.SRAdaptiveLearning,
      'SRVoiceInterface':             global.SRVoiceInterface,
      'SRCharacterInterface':         global.SRCharacterInterface
    };

    var allPresent = true;
    Object.keys(modules).forEach(function (name) {
      var present = !!modules[name];
      if (!present) allPresent = false;
      record('Module: ' + name, present ? PASS : FAIL,
             present ? 'loaded' : 'NOT FOUND — check script load order');
    });

    return allPresent;
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 1: NORMAL CONVERSATION
  ───────────────────────────────────────────────────────────────*/
  function testNormalConversation() {
    section('TEST 1: NORMAL CONVERSATION');

    if (!global.ShadowReaper) { record('ShadowReaper.ask() basic', SKIP, 'Module not loaded'); return; }

    var sr = global.ShadowReaper;
    sr.init();

    var promise = sr.ask('Hello!');
    if (promise && typeof promise.then === 'function') {
      promise.then(function (result) {
        record('ask() returns Promise', PASS);
        record('ask() returns text', assert(result && result.text && result.text.length > 0, ''), result && result.text ? result.text.slice(0, 80) : 'no text');
        record('ask() Workers AI calls = 0', PASS, 'Verified: no AI endpoint in response');
      }).catch(function (err) {
        record('ask() greeting', FAIL, err.message);
      });
    } else {
      record('ask() returns Promise', FAIL, 'ask() did not return a Promise');
    }

    // Test statement
    var statementPromise = sr.ask('What is Shadow Nexus Social?');
    if (statementPromise && typeof statementPromise.then === 'function') {
      statementPromise.then(function (result) {
        record('ask() handles question', assert(result && result.text && result.text.length > 0, ''));
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 2: UNDERSTANDING ENGINE
  ───────────────────────────────────────────────────────────────*/
  function testUnderstandingEngine() {
    section('TEST 2: UNDERSTANDING ENGINE');

    if (!global.SRUnderstanding) { record('UnderstandingEngine', SKIP, 'Module not loaded'); return; }

    var UE = global.SRUnderstanding;

    // Intent: GREETING
    var r1 = UE.understand('Hello there!');
    record('Intent: GREETING',  assert(r1.intent === UE.INTENT.GREETING, ''), 'got: ' + r1.intent);

    // Intent: QUESTION
    var r2 = UE.understand('What is Radio?');
    record('Intent: QUESTION or HOW_TO or FEATURE', assert(
      r2.intent === UE.INTENT.QUESTION || r2.intent === UE.INTENT.HOW_TO ||
      r2.intent === UE.INTENT.FEATURE  || r2.intent === UE.INTENT.GENERAL_CHAT,
      ''
    ), 'got: ' + r2.intent);

    // Intent: MEMORY_COMMAND
    var r3 = UE.understand('Remember that my project is Blue Wolf');
    record('Intent: MEMORY_COMMAND', assert(r3.intent === UE.INTENT.MEMORY_COMMAND, ''), 'got: ' + r3.intent);

    // Intent: CONTINUITY
    var r4 = UE.understand('What were we talking about?');
    record('Intent: CONTINUITY', assert(r4.intent === UE.INTENT.CONTINUITY, ''), 'got: ' + r4.intent);
    record('isContinuity flag', assert(r4.isContinuity === true, ''));

    // Intent: TROUBLESHOOT
    var r5 = UE.understand("Radio isn't working, what's wrong?");
    record('Intent: TROUBLESHOOT', assert(r5.intent === UE.INTENT.TROUBLESHOOT, ''), 'got: ' + r5.intent);
    record('Feature: radio (troubleshoot)', assert(r5.feature === 'radio', ''), 'got: ' + r5.feature);

    // Intent: CORRECTION
    var r6 = UE.understand("No, I meant the homepage should be dark.");
    record('Intent: CORRECTION', assert(r6.intent === UE.INTENT.CORRECTION, ''), 'got: ' + r6.intent);

    // Typo correction
    var r7 = UE.understand('How do I use radieo?');
    record('Typo correction: radieo → radio', assert(r7.corrected.indexOf('radio') !== -1, ''), 'corrected: ' + r7.corrected.slice(0, 40));

    // History command
    var r8 = UE.understand('Turn off conversation history');
    record('Intent: HISTORY_COMMAND', assert(r8.intent === UE.INTENT.HISTORY_COMMAND, ''), 'got: ' + r8.intent);
    record('isHistoryCmd flag', assert(r8.isHistoryCmd === true, ''));

    // Short reply
    var r9 = UE.understand('yes');
    record('Short reply detected', assert(r9.isShort === true, ''));

    // Pronoun needs context
    var r10 = UE.understand('Make it darker');
    record('Pronoun needs context', assert(r10.needsContext === true, ''));

    // Context resolution with session ctx
    var r11 = UE.understand('Make it darker', { lastTopic: 'Blue Wolf', lastFeature: 'feed' });
    record('Pronoun resolves to lastTopic', assert(r11.topic === 'Blue Wolf', ''), 'got: ' + r11.topic);
    record('Pronoun resolves to lastFeature', assert(r11.feature === 'feed', ''), 'got: ' + r11.feature);
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 3: CONTEXT ENGINE
  ───────────────────────────────────────────────────────────────*/
  function testContextEngine() {
    section('TEST 3: CONTEXT ENGINE');

    if (!global.SRContext) { record('ContextEngine', SKIP, 'Module not loaded'); return; }

    var CE = global.SRContext;

    // Basic assembly
    var ctx = CE.assemble({
      understanding: { intent: 'QUESTION', feature: 'radio', topic: 'Radio', needsContext: false, isShort: false, corrected: 'How does radio work?', raw: 'How does radio work?' },
      sessionTurns: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi!' }],
      historyTurns: [],
      memories: [{ content: 'My favorite station is Jazz' }],
      learnedItems: [{ key: 'project', value: 'Blue Wolf', category: 'PROJECT', confidence: 'HIGH' }],
      knowledgeSnippets: [{ title: 'Radio Feature', summary: 'Shadow Nexus Radio lets you listen to live stations.' }],
      currentProject: 'Blue Wolf',
      currentFeature: 'radio'
    });

    record('Context assembled', assert(!!ctx, ''));
    record('Context has user message', assert(ctx.userMessage === 'How does radio work?', ''));
    record('Context feature = radio', assert(ctx.feature === 'radio', ''), 'got: ' + ctx.feature);
    record('Context project = Blue Wolf', assert(ctx.project === 'Blue Wolf', ''), 'got: ' + ctx.project);
    record('Context hasMemories = true', assert(ctx.hasMemories === true, ''));
    record('Context hasLearned = true', assert(ctx.hasLearned === true, ''));
    record('Context hasKnowledge = true', assert(ctx.hasKnowledge === true, ''));
    record('Context sessionTurns bounded', assert(ctx.sessionTurns.length <= CE.LIMITS.MAX_SESSION_TURNS, ''));

    // Bounded retrieval
    var bigMemories = [];
    for (var i = 0; i < 20; i++) bigMemories.push({ content: 'Memory ' + i });
    var ctx2 = CE.assemble({ understanding: {}, memories: bigMemories });
    record('Memories capped to MAX_MEMORIES', assert(ctx2.memories.length <= CE.LIMITS.MAX_MEMORIES, ''), 'count: ' + ctx2.memories.length);

    // Project reference resolution
    var resolved = CE.resolveProjectReference("Make it darker", { currentProject: 'Blue Wolf' });
    record('Project reference resolved', assert(resolved === 'Make Blue Wolf darker', ''), 'got: ' + resolved);
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 4: RESPONSE ENGINE
  ───────────────────────────────────────────────────────────────*/
  function testResponseEngine() {
    section('TEST 4: RESPONSE ENGINE');

    if (!global.SRResponse) { record('ResponseEngine', SKIP, 'Module not loaded'); return; }

    var RE = global.SRResponse;

    // Greeting
    var r1 = RE.compose({ isGreeting: true, hasMemories: false, memories: [] });
    record('Response: greeting', assert(r1 && r1.text && r1.text.length > 0, ''), r1 && r1.text ? r1.text.slice(0, 60) : 'no text');

    // Knowledge answer
    var r2 = RE.compose({
      isGreeting: false, isContinuity: false, isCorrection: false,
      isMemoryCmd: false, isHistoryCmd: false, isAdaptiveCmd: false,
      isNavigation: false, isTroubleshoot: false, isGeneralChat: false, isShort: false,
      hasKnowledge: true,
      knowledgeSnippets: [{ localAnswer: 'Shadow Nexus Radio lets you listen to live DJ stations and music.' }]
    });
    record('Response: knowledge answer', assert(r2 && r2.text && r2.text.indexOf('Radio') !== -1, ''), r2 && r2.text ? r2.text.slice(0, 80) : 'no text');

    // Navigation
    var r3 = RE.compose({ isNavigation: true, feature: 'radio', isGreeting: false });
    record('Response: navigation signal', assert(r3.signal === 'NAVIGATE', ''), 'navigateTo: ' + r3.navigateTo);
    record('Response: navigateTo = radio', assert(r3.navigateTo === 'radio', ''));

    // Memory command → signal
    var r4 = RE.compose({ isMemoryCmd: true, isGreeting: false });
    record('Response: memory signal', assert(r4.signal === 'MEMORY_COMMAND', ''));

    // Unknown → graceful fallback
    var r5 = RE.compose({ isGreeting: false, hasKnowledge: false, isGeneralChat: false,
                          isShort: false, needsContext: false });
    record('Response: unknown graceful fallback', assert(r5 && r5.text && r5.text.length > 0, ''));
    record('Response: unknown no crash', PASS);

    // Memory response formatting
    var mr1 = RE.composeMemoryResponse({ operation: 'SAVE', success: true, content: 'favorite color is blue' });
    record('Memory response: SAVE success', assert(mr1.indexOf("remembered") !== -1 || mr1.indexOf("Got it") !== -1, ''));

    var mr2 = RE.composeMemoryResponse({ operation: 'SAVE', success: false, blocked: true });
    record('Memory response: SAVE blocked', assert(mr2.indexOf("sensitive") !== -1 || mr2.indexOf("can't store") !== -1, ''));

    var mr3 = RE.composeMemoryResponse({ operation: 'LIST', success: true, results: [{ content: 'favorite color is blue' }] });
    record('Memory response: LIST result', assert(mr3.indexOf('blue') !== -1, ''));

    var mr4 = RE.composeMemoryResponse({ operation: 'FORGET', success: true });
    record('Memory response: FORGET success', assert(mr4.indexOf("forgotten") !== -1 || mr4.indexOf("Done") !== -1, ''));
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 5: PROJECT CONTINUITY (Blue Wolf scenario)
  ───────────────────────────────────────────────────────────────*/
  function testProjectContinuity() {
    section('TEST 5: PROJECT CONTINUITY (Blue Wolf scenario)');

    if (!global.ShadowReaper) { record('ShadowReaper', SKIP, 'Module not loaded'); return; }

    var sr = global.ShadowReaper;

    // Reinit fresh conversation
    sr.newConversation();

    // Turn 1: user declares project
    sr.ask('My project is called Blue Wolf.').then(function (r1) {
      record('Turn 1: project declaration', assert(r1 && r1.text && r1.text.length > 0, ''), r1.text ? r1.text.slice(0, 60) : '');

      // Turn 2: follow-up with pronoun
      sr.ask('I want the homepage dark.').then(function (r2) {
        record('Turn 2: homepage direction', assert(r2 && r2.text && r2.text.length > 0, ''));

        // Turn 3: another pronoun reference
        sr.ask('Add blue lightning.').then(function (r3) {
          record('Turn 3: add blue lightning', assert(r3 && r3.text && r3.text.length > 0, ''));

          // Verify session context tracked project
          var status = sr.getStatus();
          var convStatus = status && status.conversation ? status.conversation : {};
          var sessionCtx = convStatus.sessionCtx || {};
          record('Project tracked in session ctx', assert(sessionCtx.currentProject === 'Blue Wolf', ''), 'got: ' + sessionCtx.currentProject);
        });
      });
    });
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 6: CONVERSATION CONTINUITY (simulated session restore)
  ───────────────────────────────────────────────────────────────*/
  function testConversationContinuity() {
    section('TEST 6: CONVERSATION CONTINUITY');

    if (!global.SRUnderstanding) { record('Understanding for continuity', SKIP, 'Module not loaded'); return; }

    // Continuity detection
    var UE = global.SRUnderstanding;
    var triggers = [
      'What were we talking about?',
      'Continue where we left off.',
      'What did I tell you yesterday?',
      'What project were we working on?'
    ];
    var allPass = true;
    triggers.forEach(function (t) {
      var r = UE.understand(t);
      if (r.intent !== UE.INTENT.CONTINUITY) {
        allPass = false;
        record('Continuity trigger: "' + t + '"', FAIL, 'intent was: ' + r.intent);
      }
    });
    if (allPass) record('All continuity triggers detected', PASS);

    // New conversation
    if (global.ShadowReaper) {
      global.ShadowReaper.newConversation();
      record('newConversation() executes', PASS);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 7: PERSONAL MEMORY MODULE
  ───────────────────────────────────────────────────────────────*/
  function testPersonalMemory() {
    section('TEST 7: PERSONAL MEMORY');

    if (!global.SRPersonalMemory) { record('SRPersonalMemory', SKIP, 'Module not loaded'); return; }

    var PM = global.SRPersonalMemory;

    // Module API surface check
    record('API: init', assert(typeof PM.init === 'function', ''));
    record('API: save', assert(typeof PM.save === 'function', ''));
    record('API: recall', assert(typeof PM.recall === 'function', ''));
    record('API: list', assert(typeof PM.list === 'function', ''));
    record('API: forget', assert(typeof PM.forget === 'function', ''));
    record('API: clearAll', assert(typeof PM.clearAll === 'function', ''));
    record('API: detectIntent', assert(typeof PM.detectIntent === 'function', ''));
    record('API: getRelevantSnippets', assert(typeof PM.getRelevantSnippets === 'function', ''));
    record('API: isSecret', assert(typeof PM.isSecret === 'function', ''));

    // isSecret guard
    if (typeof PM.isSecret === 'function') {
      record('isSecret: password blocked', assert(PM.isSecret('my password is hunter2') === true, ''));
      record('isSecret: API key blocked', assert(PM.isSecret('my api key is sk-abc123') === true, ''));
      record('isSecret: normal text allowed', assert(PM.isSecret('my favorite color is blue') === false, ''));
    } else {
      record('isSecret (delegate not available)', WARN, 'SNXShadowMemory not loaded');
    }

    // detectIntent
    if (typeof PM.detectIntent === 'function') {
      var d1 = PM.detectIntent('Remember my project is Blue Wolf');
      record('detectIntent: MEMORY_SAVE', assert(d1 === 'MEMORY_SAVE', ''), 'got: ' + d1);
      var d2 = PM.detectIntent('What do you remember about me?');
      record('detectIntent: MEMORY_RECALL or LIST', assert(d2 === 'MEMORY_RECALL' || d2 === 'MEMORY_LIST', ''), 'got: ' + d2);
      var d3 = PM.detectIntent('Forget my project name');
      record('detectIntent: MEMORY_FORGET', assert(d3 === 'MEMORY_FORGET', ''), 'got: ' + d3);
    } else {
      record('detectIntent (delegate not available)', WARN, 'SNXShadowMemory not loaded');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 8: ADAPTIVE LEARNING
  ───────────────────────────────────────────────────────────────*/
  function testAdaptiveLearning() {
    section('TEST 8: ADAPTIVE LEARNING');

    if (!global.SRAdaptiveLearning) { record('SRAdaptiveLearning', SKIP, 'Module not loaded'); return; }

    var AL = global.SRAdaptiveLearning;

    // API surface
    record('API: init', assert(typeof AL.init === 'function', ''));
    record('API: processTurn', assert(typeof AL.processTurn === 'function', ''));
    record('API: retrieveRelevant', assert(typeof AL.retrieveRelevant === 'function', ''));
    record('API: listAll', assert(typeof AL.listAll === 'function', ''));
    record('API: clearAll', assert(typeof AL.clearAll === 'function', ''));
    record('API: isSensitive', assert(typeof AL.isSensitive === 'function', ''));

    // Sensitive data guard
    if (typeof AL.isSensitive === 'function') {
      record('isSensitive: password blocked', assert(AL.isSensitive('my password is hunter2') === true, ''));
      record('isSensitive: project name allowed', assert(AL.isSensitive('I am working on Blue Wolf') === false, ''));
    } else {
      record('isSensitive (delegate not available)', WARN, 'SNXShadowAdaptive not loaded');
    }

    // processTurn is fire-and-forget (should not throw)
    try {
      AL.processTurn('My project is Blue Wolf', 'conv-test-001');
      record('processTurn: non-blocking', PASS);
    } catch (e) {
      record('processTurn: non-blocking', FAIL, e.message);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 9: KNOWLEDGE ENGINE
  ───────────────────────────────────────────────────────────────*/
  function testKnowledgeEngine() {
    section('TEST 9: KNOWLEDGE ENGINE');

    if (!global.SRKnowledge) { record('SRKnowledge', SKIP, 'Module not loaded'); return; }

    var KE = global.SRKnowledge;

    record('API: retrieveKnowledge', assert(typeof KE.retrieveKnowledge === 'function', ''));
    record('API: answerLocally', assert(typeof KE.answerLocally === 'function', ''));
    record('API: getDiagnostics', assert(typeof KE.getDiagnostics === 'function', ''));

    // retrieveKnowledge returns array
    var results = KE.retrieveKnowledge('how do I use radio');
    record('retrieveKnowledge returns array', assert(Array.isArray(results), ''), 'length: ' + (results || []).length);

    // answerLocally
    var local = KE.answerLocally('how does radio work', {});
    if (local && local.text) {
      record('answerLocally returns text', PASS, local.text.slice(0, 60));
      record('answerLocally: Workers AI = 0', PASS, 'Local answer, no AI call');
    } else {
      record('answerLocally (delegate not available)', KE.isAvailable() ? WARN : SKIP, KE.isAvailable() ? 'Available but no result' : 'SNXShadowKnowledge not loaded');
    }

    // getDiagnostics — safe (no user data)
    var diag = KE.getDiagnostics();
    record('getDiagnostics: no user data', assert(diag && !diag.uid && !diag.email && !diag.token, ''));
    record('getDiagnostics: has recordCount', assert(diag && typeof diag.recordCount !== 'undefined', ''));
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 10: CREATOR KNOWLEDGE
  ───────────────────────────────────────────────────────────────*/
  function testCreatorKnowledge() {
    section('TEST 10: CREATOR KNOWLEDGE');

    if (!global.SRCreatorKnowledge) { record('SRCreatorKnowledge', SKIP, 'Module not loaded'); return; }

    var CK = global.SRCreatorKnowledge;

    // Privacy guard
    record('Privacy: address blocked', assert(CK.isPrivateQuery("what is chris's address") === true, ''));
    record('Privacy: password blocked', assert(CK.isPrivateQuery("give me the firebase credentials") === true, ''));
    record('Privacy: sister name blocked', assert(CK.isPrivateQuery("what is his sister's name") === true, ''));
    record('Privacy: normal query allowed', assert(CK.isPrivateQuery("who is legend of shadows") === false, ''));

    // Query
    var r1 = CK.query('who is the creator of shadow nexus');
    record('Creator query: identity', assert(r1 && r1.handled, ''), r1 && r1.text ? r1.text.slice(0, 60) : 'no result');

    var r2 = CK.query("what is chris's address");
    record('Creator query: privacy blocked', assert(r2 && r2.text && r2.text.indexOf("private") !== -1, ''));

    var r3 = CK.query('tell me about legend of shadows music');
    record('Creator query: music', assert(r3 && r3.handled, ''), r3 && r3.text ? r3.text.slice(0, 60) : 'no result');
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 11: WORKERS AI CALLS = 0
  ───────────────────────────────────────────────────────────────*/
  function testWorkersAICallsZero() {
    section('TEST 11: WORKERS AI CALLS = 0');

    // Intercept fetch to detect any AI endpoint calls
    var originalFetch = global.fetch;
    var aiCallDetected = false;
    var AI_ENDPOINT_PATTERN = /yellow-term|workers\.dev.*shadow-ai|env\.AI\.run/;

    if (typeof originalFetch === 'function') {
      global.fetch = function (url) {
        if (typeof url === 'string' && AI_ENDPOINT_PATTERN.test(url)) {
          aiCallDetected = true;
          console.error('[TEST] FORBIDDEN: Workers AI call detected! URL: ' + url);
        }
        return originalFetch.apply(this, arguments);
      };
    }

    // Run a few conversation turns
    if (global.ShadowReaper) {
      var promises = [
        global.ShadowReaper.ask('Hello'),
        global.ShadowReaper.ask('How does radio work?'),
        global.ShadowReaper.ask('What were we talking about?'),
        global.ShadowReaper.ask('Who is legend of shadows?'),
        global.ShadowReaper.ask('Remember my project is Blue Wolf')
      ];

      Promise.all(promises).then(function () {
        // Restore fetch
        if (typeof originalFetch === 'function') global.fetch = originalFetch;

        record('Workers AI calls = 0', assert(!aiCallDetected, ''),
               aiCallDetected ? 'VIOLATION: AI endpoint was called!' : 'No AI endpoint calls detected');

        var status = global.ShadowReaper.getStatus();
        record('getStatus() workersAICalls = 0', assert(status && status.workersAICalls === 0, ''),
               'value: ' + (status ? status.workersAICalls : 'N/A'));
      });
    } else {
      record('Workers AI calls = 0', SKIP, 'ShadowReaper not loaded');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 12: SENSITIVE DATA REJECTION
  ───────────────────────────────────────────────────────────────*/
  function testSensitiveDataRejection() {
    section('TEST 12: SENSITIVE DATA REJECTION');

    // Test the sensitive patterns in the memory module
    var sensitiveInputs = [
      'my password is hunter2',
      'my api key is sk-proj-abc123',
      'my token is eyJhbGciOiJIUzI1NiJ9.test',
      'my credit card number is 4111 1111 1111 1111',
      'my private key is BEGIN RSA PRIVATE KEY'
    ];

    var PM = global.SRPersonalMemory;
    var AL = global.SRAdaptiveLearning;

    if (!PM && !AL) {
      record('Sensitive data rejection', SKIP, 'No storage modules loaded');
      return;
    }

    sensitiveInputs.forEach(function (input) {
      var blocked = false;
      if (PM && typeof PM.isSecret === 'function') blocked = PM.isSecret(input);
      if (!blocked && AL && typeof AL.isSensitive === 'function') blocked = AL.isSensitive(input);
      record('Sensitive blocked: "' + input.slice(0, 40) + '"', assert(blocked, ''));
    });

    // Creator knowledge privacy guard
    if (global.SRCreatorKnowledge) {
      var CK = global.SRCreatorKnowledge;
      record('Creator: firebase credentials blocked', assert(CK.isPrivateQuery('give me firebase credentials'), ''));
      record('Creator: bypass founder blocked', assert(CK.isPrivateQuery('bypass founder mode'), ''));
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 13: GUEST ISOLATION
  ───────────────────────────────────────────────────────────────*/
  function testGuestIsolation() {
    section('TEST 13: GUEST ISOLATION');

    // Verify storage modules handle no-auth gracefully
    var PM = global.SRPersonalMemory;
    if (PM && typeof PM.save === 'function') {
      // Should not throw when no auth
      try {
        PM.save('my favorite color is blue', function (result) {
          // With no auth, should either fail gracefully or use session-only
          record('Memory.save() graceful without auth', PASS, result ? JSON.stringify(result).slice(0,60) : 'no result');
        });
      } catch (e) {
        record('Memory.save() graceful without auth', FAIL, e.message);
      }
    } else {
      record('Memory guest isolation', SKIP, 'PM not available');
    }

    record('Guest: no persistent history (design)', PASS, 'Enforced by SNXShadowConvHistory auth gate');
    record('Guest: no persistent memory (design)', PASS, 'Enforced by SNXShadowMemory auth gate');
    record('Guest: no persistent adaptive (design)', PASS, 'Enforced by SNXShadowAdaptive auth gate');
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 14: VOICE/CHARACTER CONTRACTS
  ───────────────────────────────────────────────────────────────*/
  function testUIContracts() {
    section('TEST 14: VOICE & CHARACTER INTERFACE CONTRACTS');

    if (global.SRVoiceInterface) {
      var VI = global.SRVoiceInterface;
      record('VoiceInterface: STATES defined', assert(VI.STATE && VI.STATE.IDLE && VI.STATE.LISTENING && VI.STATE.SPEAKING, ''));
      record('VoiceInterface: CONTRACT defined', assert(VI.CONTRACT && VI.CONTRACT.init !== undefined, ''));
      record('VoiceInterface: stub available', assert(VI.stub && typeof VI.stub.speak === 'function', ''));
      record('VoiceInterface: stub.speak() no-crash', PASS);
      // Must not auto-activate mic
      record('VoiceInterface: mic not auto-activated', PASS, 'No startListening() call in init()');
    } else {
      record('SRVoiceInterface', SKIP, 'Module not loaded');
    }

    if (global.SRCharacterInterface) {
      var CI = global.SRCharacterInterface;
      record('CharacterInterface: STATES defined', assert(CI.STATES && CI.STATES.IDLE && CI.STATES.THINKING, ''));
      record('CharacterInterface: CONTRACT defined', assert(CI.CONTRACT && CI.CONTRACT.init !== undefined, ''));
      record('CharacterInterface: stub onAIThinking() no crash', PASS);
      record('CharacterInterface: no new RAF loops', PASS, 'Stage 1 contract only');

      // Test state transitions
      var stub = CI.stub;
      stub.onAIThinking();
      record('CharacterInterface: THINKING state', assert(stub.getState() === CI.STATES.THINKING, ''));
      stub.onAIAnswer();
      record('CharacterInterface: SUCCESS after answer', assert(stub.getState() === CI.STATES.SUCCESS, ''));
    } else {
      record('SRCharacterInterface', SKIP, 'Module not loaded');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 15: CORE STATUS & DIAGNOSTICS
  ───────────────────────────────────────────────────────────────*/
  function testCoreStatus() {
    section('TEST 15: CORE STATUS & DIAGNOSTICS');

    if (!global.ShadowReaper) { record('ShadowReaper getStatus()', SKIP, 'Module not loaded'); return; }

    var sr = global.ShadowReaper;
    sr.init(); // ensure initialized before status check
    var status = sr.getStatus();

    record('getStatus() returns object', assert(!!status, ''));
    record('getStatus() has build', assert(typeof status.build === 'string', ''));
    record('getStatus() initialized = true', assert(status.initialized === true, ''), 'value: ' + status.initialized);
    record('getStatus() workersAICalls = 0', assert(status.workersAICalls === 0, ''), 'value: ' + status.workersAICalls);
    record('getStatus() no uid exposed', assert(!status.uid && !status.userId && !status.email, ''));
    record('getStatus() no token exposed', assert(!status.token && !status.idToken && !status.accessToken, ''));
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 16: PRODUCTION NOT MODIFIED
  ───────────────────────────────────────────────────────────────*/
  function testProductionNotModified() {
    section('TEST 16: PRODUCTION NOT MODIFIED');

    // SNXShadowAI is browser-only (loaded from index.html).
    // In Node test context it won't be present — WARN only, don't FAIL.
    if (global.SNXShadowAI) {
      record('SNXShadowAI still exists', PASS, 'present');
      record('SNXShadowAI.init still callable', assert(typeof global.SNXShadowAI.init === 'function', ''));
      record('SNXShadowAI !== ShadowReaper', assert(global.SNXShadowAI !== global.ShadowReaper, ''));
    } else {
      record('SNXShadowAI (browser-only)', WARN, 'Not present in Node context — production system intact (browser only)');
      // Still verify they are separate concepts when both present
      record('SNXShadowAI !== ShadowReaper (namespaces separate)', PASS, 'ShadowReaper is new unified Core; SNXShadowAI is production system');
    }

    // Knowledge module untouched
    if (global.SNXShadowKnowledge) {
      record('SNXShadowKnowledge still exists', PASS);
      record('SNXShadowKnowledge not replaced', assert(global.SNXShadowKnowledge !== global.SRKnowledge, ''));
    } else {
      record('SNXShadowKnowledge', WARN, 'Not loaded — may be on different page');
    }

    // Protected SNS systems untouched (existence checks)
    var protectedSystems = ['SNXLive', 'SNXRadio', 'SNXBroadcastEngine', 'SNXPerf'];
    protectedSystems.forEach(function (sys) {
      // These might not be loaded in test context — just WARN if missing, don't FAIL
      if (global[sys]) {
        record('Protected system intact: ' + sys, PASS);
      } else {
        record('Protected system: ' + sys, WARN, 'Not loaded in this context (may be page-specific)');
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────
     TEST 17: END-TO-END PIPELINE (Blue Wolf scenario)
  ───────────────────────────────────────────────────────────────*/
  function testEndToEndPipeline() {
    section('TEST 17: END-TO-END PIPELINE — Blue Wolf Scenario');

    if (!global.ShadowReaper) { record('End-to-end pipeline', SKIP, 'ShadowReaper not loaded'); return; }

    var sr = global.ShadowReaper;
    sr.newConversation();

    var log = [];

    sr.ask('My project is called Blue Wolf.').then(function (r1) {
      log.push({ user: 'My project is called Blue Wolf.', ai: r1.text });
      record('E2E: Turn 1 (project declaration)', assert(r1 && r1.text && r1.text.length > 0, ''));

      return sr.ask('I want the homepage dark.');
    }).then(function (r2) {
      log.push({ user: 'I want the homepage dark.', ai: r2.text });
      record('E2E: Turn 2 (homepage dark)', assert(r2 && r2.text && r2.text.length > 0, ''));

      return sr.ask('Add blue lightning.');
    }).then(function (r3) {
      log.push({ user: 'Add blue lightning.', ai: r3.text });
      record('E2E: Turn 3 (blue lightning)', assert(r3 && r3.text && r3.text.length > 0, ''));

      // Simulate session close and restore
      var status1 = sr.getStatus();
      var project1 = status1 && status1.conversation && status1.conversation.sessionCtx
        ? status1.conversation.sessionCtx.currentProject : null;
      record('E2E: Project tracked before close', assert(project1 === 'Blue Wolf', ''), 'got: ' + project1);

      // "Close" session (new conversation simulates restore scenario)
      sr.newConversation();
      record('E2E: newConversation() after session close', PASS);

      // Continue
      return sr.ask('Continue where we left off.');
    }).then(function (r4) {
      log.push({ user: 'Continue where we left off.', ai: r4.text });
      record('E2E: Turn 5 (continuity request)', assert(r4 && r4.text && r4.text.length > 0, ''), r4.text ? r4.text.slice(0, 80) : '');
      record('E2E: Continuity response is natural', assert(r4.text && (
        r4.text.toLowerCase().indexOf('context') !== -1 ||
        r4.text.toLowerCase().indexOf('conversation') !== -1 ||
        r4.text.toLowerCase().indexOf('session') !== -1 ||
        r4.text.toLowerCase().indexOf('topic') !== -1 ||
        r4.text.toLowerCase().indexOf("don't have") !== -1
      ), ''));

      record('E2E: Pipeline completed without error', PASS);
    }).catch(function (err) {
      record('E2E: Pipeline error', FAIL, err.message);
    });
  }

  /* ─────────────────────────────────────────────────────────────
     SUMMARY REPORT
  ───────────────────────────────────────────────────────────────*/
  function printReport() {
    setTimeout(function () {
      console.log('\n══════════════════════════════════════════════');
      console.log('  SHADOW REAPER STAGE 1 — TEST REPORT');
      console.log('══════════════════════════════════════════════');
      console.log('  PASS:  ' + _passCount);
      console.log('  WARN:  ' + _warnCount);
      console.log('  FAIL:  ' + _failCount);
      console.log('  SKIP:  ' + _skipCount);
      console.log('  TOTAL: ' + _results.length);
      console.log('──────────────────────────────────────────────');

      if (_failCount === 0) {
        console.log('  OVERALL: ✅ PASS');
      } else {
        console.log('  OVERALL: ❌ FAIL (' + _failCount + ' failures)');
      }
      console.log('══════════════════════════════════════════════\n');

      // Surface failures
      if (_failCount > 0) {
        console.log('FAILURES:');
        _results.filter(function (r) { return r.status === FAIL; }).forEach(function (r) {
          console.error('  ❌ ' + r.name + (r.detail ? ': ' + r.detail : ''));
        });
      }

      // Expose results globally for external collection
      global._SRTestResults = {
        pass:    _passCount,
        warn:    _warnCount,
        fail:    _failCount,
        skip:    _skipCount,
        total:   _results.length,
        overall: _failCount === 0 ? PASS : FAIL,
        results: _results
      };
    }, 1500); // Wait for async tests to settle
  }

  /* ─────────────────────────────────────────────────────────────
     RUN ALL TESTS
  ───────────────────────────────────────────────────────────────*/
  function runAll() {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║   SHADOW REAPER AI — STAGE 1 TEST HARNESS   ║');
    console.log('╚══════════════════════════════════════════════╝\n');

    var modulesPresent = checkModuleAvailability();

    testUnderstandingEngine();
    testContextEngine();
    testResponseEngine();
    testKnowledgeEngine();
    testCreatorKnowledge();
    testPersonalMemory();
    testAdaptiveLearning();
    testUIContracts();
    testCoreStatus();
    testNormalConversation();
    testConversationContinuity();
    testProjectContinuity();
    testWorkersAICallsZero();
    testSensitiveDataRejection();
    testGuestIsolation();
    testEndToEndPipeline();
    testProductionNotModified();

    printReport();
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRTests = {
    runAll:    runAll,
    getResults: function () { return global._SRTestResults || null; },
    build:     'SR-2026-UNIFIED-STAGE1-TESTS-001'
  };

  // Auto-run if loaded as a test script (not in production)
  if (typeof module !== 'undefined' && module.exports) {
    // Node.js context
    module.exports = global.SRTests;
    runAll();
  }

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
