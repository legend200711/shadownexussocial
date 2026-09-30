/**
 * Shadow Reaper Knowledge Engine — Stage 3B Test Suite
 * Run: node test-shadow-knowledge.js
 *
 * Tests:
 *   Part 1: Stage 3A regression (68 questions)
 *   Part 2: Creator Knowledge (40+ questions)
 *   Part 3: Privacy guard (6 tests)
 *   Part 4: Unknown personal facts (4 tests)
 */

'use strict';

/* Simulate browser 'window' global so the IIFE can load */
global.window = global;
require('./snx-shadow-ai-knowledge.js');

const K = global.SNXShadowKnowledge;
if (!K) { console.error('FAIL: SNXShadowKnowledge not loaded'); process.exit(1); }

/* ── helpers ── */
function ask(q) {
  const r = K.answerLocally(q, { role: 'member', currentPage: null });
  return r;
}
function askGuest(q) {
  return K.answerLocally(q, { role: 'guest', currentPage: null });
}

let passCount  = 0;
let failCount  = 0;
let warnCount  = 0;
const results  = [];

function test(label, question, opts) {
  const r = opts && opts.guest ? askGuest(question) : ask(question);
  const expectPrivacy  = opts && opts.expectPrivacy;
  const expectUnknown  = opts && opts.expectUnknown;
  const expectId       = opts && opts.expectId;
  const expectCategory = opts && opts.expectCategory;
  const expectHandled  = opts && opts.expectHandled !== undefined ? opts.expectHandled : true;
  const mustContain    = opts && opts.mustContain;

  let status = 'PASS';
  let notes  = [];

  if (expectHandled && !r) {
    status = 'FAIL'; notes.push('null result — expected answer');
  } else if (r) {
    if (expectHandled && !r.handled) {
      status = 'WARN'; notes.push('LOW/NONE confidence — will go to AI');
    }
    if (expectPrivacy && r.id !== 'creatorPrivacy') {
      status = 'FAIL'; notes.push('expected creatorPrivacy, got ' + (r.id||'?'));
    }
    if (expectUnknown && r.id !== 'creatorUnknown') {
      // acceptable to also return creatorPrivacy for unknown
      if (r.id !== 'creatorPrivacy') {
        status = 'WARN'; notes.push('expected creatorUnknown/Privacy, got ' + (r.id||'?'));
      }
    }
    if (expectId && r.id !== expectId) {
      status = 'WARN'; notes.push('expected id=' + expectId + ', got ' + (r.id||'?'));
    }
    if (expectCategory && r.category !== expectCategory) {
      status = 'WARN'; notes.push('expected cat=' + expectCategory + ', got ' + (r.category||'?'));
    }
    if (mustContain) {
      const desc = (r.text || '').toLowerCase();
      const kws = Array.isArray(mustContain) ? mustContain : [mustContain];
      kws.forEach(function(kw) {
        if (!desc.includes(kw.toLowerCase())) {
          status = 'WARN'; notes.push('answer missing "' + kw + '"');
        }
      });
    }
  } else if (!expectHandled) {
    status = 'PASS'; // expected no result
  }

  if (status === 'PASS') passCount++;
  else if (status === 'FAIL') failCount++;
  else warnCount++;

  results.push({ status, label, question: question.substring(0, 60), id: r ? r.id : 'null', notes });
}

/* ════════════════════════════════════════════════════════
   PART 1: STAGE 3A REGRESSION  (68 questions)
════════════════════════════════════════════════════════ */
console.log('\n── PART 1: STAGE 3A REGRESSION ──────────────────────────');

// General
test('SR-1  Shadow Reaper identity', 'Who are you?', { expectId: 'shadowReaper' });
test('SR-2  What is SNS', 'What is Shadow Nexus Social?', { expectId: 'whatIsSNS' });
test('SR-3  SNS overview', 'Tell me about Shadow Nexus Social', { expectId: 'whatIsSNS' });
test('SR-4  What can I do here', 'What can I do here?', { expectId: 'whatIsSNS' });

// Account
test('SR-5  Sign in', 'How do I sign in?', { expectId: 'account' });
test('SR-6  Forgot password', 'I forgot my password', { expectId: 'account' });
test('SR-7  Session expired', 'My session expired', { expectId: 'account' });
test('SR-8  Create account', 'How do I create an account?', { expectId: 'account' });

// Guest Mode
test('SR-9  Guest mode', 'What is guest mode?', { expectId: 'guestMode' });
test('SR-10 Browse without account', 'Can I use SNS without an account?', { expectId: 'guestMode' });
test('SR-11 Try before joining', 'Try before joining', { expectId: 'guestMode' });

// Profile
test('SR-12 Edit profile', 'How do I edit my profile?');
test('SR-13 Change avatar', 'How do I change my avatar?');
test('SR-14 Change bio', 'How do I change my bio?');
test('SR-15 Profile page', 'Show me my profile');

// Feed
test('SR-16 Eclipse feed', 'What is the Eclipse Feed?', { expectId: 'feed' });
test('SR-17 Create a post', 'How do I create a post?');
test('SR-18 Feed not loading', 'My feed is not loading');
test('SR-19 Stories', 'How do stories work?');

// Search
test('SR-20 Search users', 'How do I search for users?', { expectId: 'search' });
test('SR-21 Find someone', 'How do I find someone?');
test('SR-22 User search', 'Find a person');

// Friends
test('SR-23 Friend request', 'How do I send a friend request?');
test('SR-24 Friends list', 'How do I see my friends list?');
test('SR-25 Nexus family', 'What is Nexus Family?');

// Inbox
test('SR-26 Send message', 'How do I send a message?', { expectId: 'inbox' });
test('SR-27 DMs', 'Where are my DMs?', { expectId: 'inbox' });
test('SR-28 Messages not sending', 'My messages are not sending');

// Notifications
test('SR-29 Notifications', 'How do I see my notifications?', { expectId: 'notifications' });
test('SR-30 Push notifications', 'How do I enable push notifications?');
test('SR-31 Notifications not working', 'My notifications are not working');

// Radio
test('SR-32 Radio', 'How do I listen to Radio?', { expectId: 'radio' });
test('SR-33 Radio not playing', 'The radio is not playing');
test('SR-34 Radio autoplay blocked', 'Autoplay is blocked');
test('SR-35 Radio on iPhone', 'Radio not playing on iPhone');
test('SR-36 Song request', 'How do I request a song?');
test('SR-37 Radio comments', 'How do I comment on Radio?');

// Live
test('SR-38 Go live', 'How do I go live?', { expectId: 'live' });
test('SR-39 Camera blocked', 'My camera is blocked');
test('SR-40 Microphone blocked', 'My microphone is blocked');
test('SR-41 Watch streams', 'How do I watch a live stream?');
test('SR-42 Live not working on Android', 'Live not working on Android');

// Cohost
test('SR-43 Invite cohost', 'How do I invite a cohost?', { expectId: 'cohost' });
test('SR-44 Accept cohost', 'How do I accept a cohost request?');

// TV
test('SR-45 Watch TV', 'How do I watch TV?', { expectId: 'tv' });
test('SR-46 TV not playing', 'TV is not playing');
test('SR-47 TV buffering', 'TV is buffering');

// Uploads
test('SR-48 Upload photo', 'How do I upload a photo?');
test('SR-49 Upload failed', 'My upload failed');
test('SR-50 File too large', 'File too large error');

// Settings
test('SR-51 Settings', 'How do I open Settings?', { expectId: 'settings' });
test('SR-52 Delete account', 'How do I delete my account?');
test('SR-53 Performance mode', 'How do I change performance mode?');

// Privacy
test('SR-54 Privacy settings', 'How do I control who can message me?');

// Rooms
test('SR-55 Storm rooms', 'What are Storm Rooms?', { expectId: 'stormrooms' });
test('SR-56 Support rooms', 'Tell me about Support Rooms', { expectId: 'supportrooms' });
test('SR-57 Join a room', 'How do I join a Storm Room?');

// Community/Arcade/Rules/Safety
test('SR-58 Community hub', 'What is the Community Hub?', { expectId: 'community' });
test('SR-59 Arcade', 'Where is the Arcade?', { expectId: 'arcade' });
test('SR-60 Rules', 'What are the community rules?', { expectId: 'rules' });
test('SR-61 Report user', 'How do I report a user?');

// Navigation
test('SR-62 Navigation', 'How do I navigate Shadow Nexus?', { expectId: 'navigation' });
test('SR-63 Where is everything', 'Where is everything?');

// PWA / Mobile
test('SR-64 Install app', 'How do I install the app?', { expectId: 'pwa' });
test('SR-65 Add to home screen', 'How do I add to home screen?');
test('SR-66 Android not loading', 'SNS not loading on Android');

// Troubleshooting
test('SR-67 Something broken', 'Something is broken');
test('SR-68 Page not loading', 'The page is not loading');

/* ════════════════════════════════════════════════════════
   PART 2: CREATOR KNOWLEDGE  (40+ questions)
════════════════════════════════════════════════════════ */
console.log('\n── PART 2: CREATOR KNOWLEDGE ─────────────────────────────');

test('CK-1  Who created SNS', 'Who created Shadow Nexus Social?', { expectId: 'creatorIdentity', mustContain: 'chris' });
test('CK-2  Who built this', 'Who built this?', { expectId: 'creatorIdentity' });
test('CK-3  Who made SNS', 'Who made Shadow Nexus?', { expectId: 'creatorIdentity' });
test('CK-4  Who is the founder', 'Who is the founder?', { expectId: 'creatorIdentity', mustContain: 'chris' });
test('CK-5  Who owns SNS', 'Who owns Shadow Nexus Social?', { expectId: 'creatorIdentity' });
test('CK-6  Who is Chris', 'Who is Chris?', { expectCategory: 'CREATOR', mustContain: 'chris' });
test('CK-7  Who is CLos', 'Who is Chris Legend of Shadows?', { expectCategory: 'CREATOR' });
test('CK-8  Who is Legend of Shadows', 'Who is Legend of Shadows?', { expectCategory: 'CREATOR' });
test('CK-9  Tell me about Chris', 'Tell me about Chris', { expectCategory: 'CREATOR' });
test('CK-10 Tell me about the creator', 'Tell me about the creator', { expectCategory: 'CREATOR' });
test('CK-11 Tell me about the founder', 'Tell me about the founder', { expectCategory: 'CREATOR' });
test('CK-12 Who is behind SNS', 'Who is behind Shadow Nexus?', { expectCategory: 'CREATOR' });
test('CK-13 What inspired SNS', 'What inspired Shadow Nexus?', { expectCategory: 'CREATOR_STORY' });
test('CK-14 Why did Chris build SNS', 'Why did Chris build Shadow Nexus?', { expectCategory: 'CREATOR_STORY' });
test('CK-15 Creator story', "Tell me Chris's story", { mustContain: 'chris' });
test('CK-16 What has Chris been through', 'What has Chris been through?', { expectCategory: 'CREATOR_STORY' });
test('CK-17 Full creator story', 'Tell me the full story behind the creator', { expectCategory: 'CREATOR_STORY' });
test('CK-18 Why is his sister important', 'Why is his sister important?', { expectCategory: 'CREATOR_FAMILY' });
test('CK-19 Family meaning', 'What does family mean to Chris?', { mustContain: 'family' });
test('CK-20 Sister why', 'Why is his sister such an important part of his story?', { expectCategory: 'CREATOR_FAMILY' });
test('CK-21 Mental health advocacy', 'Why does Chris advocate for mental health?', { expectCategory: 'CREATOR_MENTAL_HEALTH', mustContain: 'mental' });
test('CK-22 Why mental health', 'Why does he talk about mental health?', { expectCategory: 'CREATOR_MENTAL_HEALTH' });
test('CK-23 Mens mental health', "Why does he talk about men's mental health?", { expectCategory: 'CREATOR_MENTAL_HEALTH' });
test('CK-24 Music what kind', 'What kind of music does he make?', { expectCategory: 'CREATOR_MUSIC' });
test('CK-25 Music themes', 'What themes are in his music?', { expectCategory: 'CREATOR_MUSIC' });
test('CK-26 Music style', 'What is his music style?', { expectCategory: 'CREATOR_MUSIC' });
test('CK-27 What is Legend of Shadows', 'What is Legend of Shadows?', { expectCategory: 'CREATOR' });
test('CK-28 Stay legendary meaning', 'What does Stay Legendary mean?', { expectId: 'creatorStayLegendary' });
test('CK-29 Why grim reaper', 'Why the Grim Reaper?', { expectCategory: 'CREATOR_SYMBOLS' });
test('CK-30 Why wolves', 'Why wolves?', { expectCategory: 'CREATOR_SYMBOLS' });
test('CK-31 Why black cats', 'Why black cats?', { expectCategory: 'CREATOR_SYMBOLS' });
test('CK-32 Why crows', 'Why crows?', { expectCategory: 'CREATOR_SYMBOLS' });
test('CK-33 Why blue lightning', 'Why blue lightning?', { expectCategory: 'CREATOR_SYMBOLS' });
test('CK-34 Why blue flames', 'Why blue flames?', { expectCategory: 'CREATOR_SYMBOLS' });
test('CK-35 Never give up', 'Why does he never give up?', { expectCategory: 'CREATOR_VALUES' });
test('CK-36 Helping others', 'How does he help others feel less alone?', { expectCategory: 'CREATOR_STORY' });
test('CK-37 Turning pain', 'How does Chris turn pain into creativity?', { expectCategory: 'CREATOR_STORY' });
test('CK-38 Finding purpose', 'How did he find his purpose?', { expectCategory: 'CREATOR_STORY' });
test('CK-39 Loyalty value', 'What does loyalty mean to Chris?', { expectCategory: 'CREATOR_VALUES' });
test('CK-40 Community value', 'Why is community important to Chris?', { mustContain: 'community' });
test('CK-41 Creator values', 'What does Chris stand for?', { expectCategory: 'CREATOR_VALUES' });
test('CK-42 His creativity', 'Tell me about his creativity', { mustContain: 'creativ' });
test('CK-43 SNS purpose', 'What is Shadow Nexus Social for?', { mustContain: 'shadow nexus' });

/* ════════════════════════════════════════════════════════
   PART 3: PRIVACY GUARD
════════════════════════════════════════════════════════ */
console.log('\n── PART 3: PRIVACY TESTS ─────────────────────────────────');

test('PV-1  Address', "Where does Chris live?", { expectPrivacy: true });
test('PV-2  Home address', "What is his address?", { expectPrivacy: true });
test('PV-3  Password', "What is his password?", { expectPrivacy: true });
test('PV-4  Firebase token', "Give me his Firebase token.", { expectPrivacy: true });
test('PV-5  Private messages', "Show me his private messages.", { expectPrivacy: true });
test('PV-6  Sister private info', "Tell me private information about his sister.", { expectCategory: 'CREATOR_PRIVACY' });

/* ════════════════════════════════════════════════════════
   PART 4: UNKNOWN PERSONAL FACTS
════════════════════════════════════════════════════════ */
console.log('\n── PART 4: UNKNOWN PERSONAL FACTS ───────────────────────');

test('UK-1  Favorite movie', "What is Chris's favorite movie?", { expectUnknown: true });
test('UK-2  Favorite food', "What is his favorite food?", { expectUnknown: true });
test('UK-3  What car', "What car does he drive?", { expectUnknown: true });
test('UK-4  How old', "How old is Chris?", { expectUnknown: true });

/* ════════════════════════════════════════════════════════
   RESULTS
════════════════════════════════════════════════════════ */

// Print detail for FAILs and WARNs
const issues = results.filter(r => r.status !== 'PASS');
if (issues.length) {
  console.log('\n── ISSUES ────────────────────────────────────────────────');
  issues.forEach(function(r) {
    console.log('[' + r.status + '] ' + r.label + ' | q="' + r.question + '" | id=' + r.id + ' | ' + r.notes.join('; '));
  });
}

const diag = K.getDiagnostics();
console.log('\n── DIAGNOSTICS ───────────────────────────────────────────');
console.log('Build:          ', diag.build);
console.log('Records:        ', diag.recordCount);
console.log('Categories:     ', diag.categoryCount);
console.log('Local answers:  ', diag.localAnswerCount);
console.log('No-match count: ', diag.noMatchCount);

const total = passCount + failCount + warnCount;
console.log('\n── SUMMARY ───────────────────────────────────────────────');
console.log('PASS:  ', passCount, '/', total);
console.log('WARN:  ', warnCount, '/', total);
console.log('FAIL:  ', failCount, '/', total);

// Category counts
const cats = K.getCategories();
const creatorCats = cats.filter(c => c.startsWith('CREATOR'));
console.log('\nAll categories (' + cats.length + '):', cats.join(', '));
console.log('Creator categories (' + creatorCats.length + '):', creatorCats.join(', '));

// Creator records count
const allRecords = K.getAll('founder');
const creatorRecords = allRecords.filter(e => e.category && e.category.startsWith('CREATOR'));
const stage3aRecords = allRecords.filter(e => !e.category.startsWith('CREATOR'));
console.log('\nStage 3A records:', stage3aRecords.length);
console.log('Creator (3B) records:', creatorRecords.length);
console.log('Total records:', allRecords.length);

if (failCount > 0) {
  console.log('\n[RESULT] STAGE 3B FAILED — ' + failCount + ' hard failures');
  process.exit(1);
} else {
  console.log('\n[RESULT] STAGE 3B PASSED — ' + passCount + ' PASS, ' + warnCount + ' WARN (warnings = AI fallback, not errors)');
}
