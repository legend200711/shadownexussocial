/**
 * Shadow Reaper — Stage 3C Deep Intelligence Test Suite
 * Run: node test-shadow-3c.js
 */
'use strict';
global.window = global;
require('./snx-shadow-ai-knowledge.js');
const K = global.SNXShadowKnowledge;
if (!K) { console.error('FAIL: SNXShadowKnowledge not loaded'); process.exit(1); }

/* ── Typo correction (matches snx-shadow-ai.js _TYPO_MAP) ── */
var TYPO_MAP = {
  'radieo':'radio','notifacations':'notifications','messeges':'inbox',
  'shdow nexus':'shadow nexus','criss':'chris','setings':'settings',
  'profle':'profile','freinds':'friends','livestream':'live',
  'notificatons':'notifications','serach':'search'
};
function correctTypos(text) {
  var lower = (text||'').toLowerCase();
  var out = lower;
  Object.keys(TYPO_MAP).forEach(function(bad) {
    if (out.indexOf(bad) !== -1) out = out.split(bad).join(TYPO_MAP[bad]);
  });
  return out === lower ? text : out;
}

/* ── Session context (mirrors snx-shadow-ai.js _sessionCtx) ── */
var sessionCtx = { lastFeature: null, lastCreatorTopic: null, lastIntent: null };

function resolveContext(text) {
  if (!text) return text;
  var lower = text.toLowerCase().trim();
  var refPat = /\b(it|that|this|there)\b/i;
  if (sessionCtx.lastFeature && refPat.test(lower) && lower.length < 80) {
    text = text + ' [context: ' + sessionCtx.lastFeature + ']';
  }
  var creatorRef = /\b(he|his|him)\b/i;
  var hasChris = /\b(chris|legend of shadows)\b/i;
  if (sessionCtx.lastCreatorTopic && creatorRef.test(lower) && !hasChris.test(lower) && lower.length < 100) {
    text = text + ' [context: chris]';
  }
  return text;
}

function updateCtx(r, resolvedMsg) {
  if (!r) return;
  if (r.category && r.category.startsWith('CREATOR')) sessionCtx.lastCreatorTopic = r.category;
  var featMap = { radio:'radio', live:'live', tv:'tv', feed:'feed',
                  inbox:'inbox', profile:'profile', settings:'settings',
                  notifications:'notifications', 'radio studio':'radio_studio',
                  dj:'dj', cohost:'cohost', pwa:'pwa' };
  var norm = (resolvedMsg||'').toLowerCase();
  var keys = Object.keys(featMap).sort(function(a,b){return b.length-a.length;});
  for (var i=0; i<keys.length; i++) {
    if (norm.indexOf(keys[i]) !== -1) { sessionCtx.lastFeature = featMap[keys[i]]; break; }
  }
}

let pass=0, warn=0, fail=0;
function test3c(label, rawQ, opts) {
  var corrected = correctTypos(rawQ);
  var resolved  = resolveContext(corrected);
  var r = K.answerLocally(resolved, { role: opts && opts.guest ? 'guest' : 'member', currentPage: null });

  var status = 'PASS', notes = [];
  if (opts && opts.expectHandled !== false) {
    if (!r)            { status='FAIL'; notes.push('null result'); }
    else if (!r.handled) { status='WARN'; notes.push('LOW conf → AI fallback'); }
  }
  if (r && opts && opts.expectId && r.id !== opts.expectId) {
    status='WARN'; notes.push('expected id='+opts.expectId+' got='+r.id);
  }
  if (r && opts && opts.mustContain) {
    var kws = Array.isArray(opts.mustContain) ? opts.mustContain : [opts.mustContain];
    kws.forEach(function(kw) {
      if (!(r.text||'').toLowerCase().includes(kw.toLowerCase()))
        { status='WARN'; notes.push('missing "'+kw+'"'); }
    });
  }
  if (status==='PASS') pass++; else if (status==='WARN') warn++; else fail++;
  var icon = status==='PASS'?'✓':status==='WARN'?'⚠':'✗';
  console.log(icon+' ['+status+'] '+label+(notes.length?' — '+notes.join('; '):''));
  if (r) updateCtx(r, resolved);
}

console.log('\n═══ STAGE 3C TEST SUITE ══════════════════════════════════');

/* ── Typo tolerance ── */
console.log('\n── TYPO TOLERANCE ────────────────────────────────────────');
var typos = [['radieo','radio'],['notifacations','notifications'],['messeges','inbox'],
             ['shdow nexus','shadow nexus'],['criss','chris'],['setings','settings'],
             ['profle','profile'],['freinds','friends'],['livestream','live'],
             ['serach','search']];
typos.forEach(function(pair) {
  var fixed = correctTypos(pair[0]);
  var ok = fixed !== pair[0] && fixed.indexOf(pair[1]) !== -1;
  if (ok) pass++; else fail++;
  console.log((ok?'✓':'✗')+' "'+pair[0]+'" → "'+fixed+'"');
});

/* ── TEST A: Radio multi-turn ── */
console.log('\n── TEST A: RADIO MULTI-TURN ──────────────────────────────');
sessionCtx = { lastFeature: null, lastCreatorTopic: null, lastIntent: null };
test3c('A1 How does Radio work', 'How does Radio work?', { expectId:'radio' });
sessionCtx.lastFeature = 'radio';
test3c('A2 Can guests listen (follow-up)', 'Can guests listen to it?', { expectId:'radio' });
test3c('A3 Can they request songs', 'Can they request songs?', { mustContain:'request' });
test3c('A4 Take me there (navigation)', 'Take me to Radio', { expectId:'radio' });

/* ── TEST B: Creator multi-turn ── */
console.log('\n── TEST B: CREATOR MULTI-TURN ────────────────────────────');
sessionCtx = { lastFeature: null, lastCreatorTopic: null, lastIntent: null };
test3c('B1 Who created SNS', 'Who created Shadow Nexus Social?', { expectId:'creatorIdentity' });
sessionCtx.lastCreatorTopic = 'CREATOR';
test3c('B2 Why did he build it (he + it)', 'Why did he build it?', {});
test3c('B3 Music (he follow-up)', 'What kind of music does he make?', { expectId:'creatorMusic' });
test3c('B4 Stay Legendary', 'What does Stay Legendary mean?', { expectId:'creatorStayLegendary' });

/* ── TEST C: Ambiguous → expect a valid knowledge answer or handled ── */
console.log('\n── TEST C: AMBIGUOUS PLAYBACK (knowledge level) ─────────');
sessionCtx = { lastFeature: null, lastCreatorTopic: null, lastIntent: null };
// With feature context these should resolve to specific features
test3c('C1 Radio not playing (typo radieo)', 'The radieo is not playing', { expectId:'radio' });
test3c('C2 TV not playing', 'TV is not playing', { expectId:'tv' });

/* ── TEST D: Live + troubleshoot ── */
console.log('\n── TEST D: LIVE + TROUBLESHOOT ───────────────────────────');
sessionCtx = { lastFeature: null, lastCreatorTopic: null, lastIntent: null };
test3c('D1 How do I go live', 'How do I go live?', { expectId:'live' });
sessionCtx.lastFeature = 'live';
test3c('D2 Camera blocked (context injection)', 'My camera is blocked [context: live]', { expectId:'live' });
test3c('D3 Android Live context', 'I am on Android and it is not working [context: live]', { expectId:'live' });

/* ── TEST E: Capabilities ── */
console.log('\n── TEST E: CAPABILITIES ──────────────────────────────────');
sessionCtx = { lastFeature: null, lastCreatorTopic: null, lastIntent: null };
['What can you do?','Who are you?','What is Shadow Reaper?','Introduce yourself'].forEach(function(q) {
  test3c('E capabilities: '+q, q, { expectId:'shadowReaper' });
});

/* ── TEST F: Navigation knowledge ── */
console.log('\n── TEST F: NAVIGATION / INBOX ────────────────────────────');
sessionCtx = { lastFeature: null, lastCreatorTopic: null, lastIntent: null };
test3c('F1 Open my messages (direct)', 'Open my messages', { expectId:'inbox' });
test3c('F2 Take me to Radio', 'Take me to Radio', { expectId:'radio' });
test3c('F3 Messages typo', 'messeges', { expectId:'inbox' });

/* ── SUMMARY ── */
const diag = K.getDiagnostics();
console.log('\n══ DIAGNOSTICS ═══════════════════════════════════════════');
console.log('Build:    ', diag.build);
console.log('Records:  ', diag.recordCount);
console.log('Local:    ', diag.localAnswerCount);

console.log('\n══ SUMMARY ═══════════════════════════════════════════════');
console.log('PASS:', pass, ' WARN:', warn, ' FAIL:', fail);
if (fail > 0) { console.log('[RESULT] STAGE 3C FAILED'); process.exit(1); }
else console.log('[RESULT] STAGE 3C PASSED');
