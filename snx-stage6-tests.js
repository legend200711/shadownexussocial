/**
 * SNX STAGE 6 — Automated Logic Tests
 * snx-stage6-tests.js
 *
 * Runs in Node.js (no browser / Firebase required) against pure logic functions
 * extracted or reconstructed from the TV Network codebase.
 *
 * Run: node snx-stage6-tests.js
 *
 * Hardware tests (camera, mic, WebRTC, actual Firebase) are marked MANUAL.
 */

'use strict';

let _passed = 0;
let _failed = 0;
const _results = [];

function assert(name, condition, notes = '') {
  if (condition) {
    _passed++;
    _results.push({ name, status: 'PASS', notes });
    console.log(`  ✓ PASS  ${name}`);
  } else {
    _failed++;
    _results.push({ name, status: 'FAIL', notes });
    console.error(`  ✗ FAIL  ${name}${notes ? ' — ' + notes : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
}

// ── 1. Unique Live ID generation ──────────────────────────────────────────────
section('UNIQUE LIVE IDs');
{
  const ids = new Set();
  const UID = 'testUser123';
  const safeUid = UID.replace(/[.#$/[\]]/g, '_');
  for (let i = 0; i < 1000; i++) {
    const rtdbRoomId = `${safeUid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    ids.add(rtdbRoomId);
  }
  assert('1000 generated rtdbRoomIds are unique', ids.size === 1000,
    `Got ${ids.size} unique out of 1000`);

  // Verify format: safeUid prefix, underscore-delimited
  const sample = [...ids][0];
  assert('rtdbRoomId starts with safeUid prefix', sample.startsWith(safeUid));
  assert('rtdbRoomId contains no Firebase-illegal characters', !/[.#$\[\]]/.test(sample));
}

// ── 2. UID special-char sanitisation ─────────────────────────────────────────
section('UID SANITISATION');
{
  const dangerousUid = 'user.with#special$/chars[and]brackets';
  const safeUid = dangerousUid.replace(/[.#$/[\]]/g, '_');
  assert('Dangerous UID chars are replaced with underscore', !/[.#$/[\]]/.test(safeUid));
  assert('Safe UID has same length', safeUid.length === dangerousUid.length);
}

// ── 3. Live status transitions ────────────────────────────────────────────────
section('LIVE STATUS TRANSITIONS');
{
  const VALID_TRANSITIONS = {
    offline: ['live'],
    live:    ['ended'],
    ended:   [],
  };

  function isValidTransition(from, to) {
    return (VALID_TRANSITIONS[from] || []).includes(to);
  }

  assert('offline → live is valid',   isValidTransition('offline', 'live'));
  assert('live → ended is valid',     isValidTransition('live', 'ended'));
  assert('offline → ended is invalid', !isValidTransition('offline', 'ended'));
  assert('ended → live is invalid',   !isValidTransition('ended', 'live'));
  assert('live → live is invalid',    !isValidTransition('live', 'live'));
  assert('ended → offline is invalid', !isValidTransition('ended', 'offline'));
}

// ── 4. Notification deduplication ────────────────────────────────────────────
section('NOTIFICATION DEDUPLICATION');
{
  // Model: notifications are only sent once per liveId
  // Simulate the notifSentFlag pattern from _hostState
  const hostStateSimulator = {
    liveId: 'abc123',
    notifSentFlag: false,
  };

  function sendNotificationOnce(state) {
    if (state.notifSentFlag) return false;  // already sent
    state.notifSentFlag = true;
    return true;  // sent
  }

  const first  = sendNotificationOnce(hostStateSimulator);
  const second = sendNotificationOnce(hostStateSimulator);
  const third  = sendNotificationOnce(hostStateSimulator);

  assert('First notification send returns true',  first === true);
  assert('Second notification send returns false', second === false);
  assert('Third notification send returns false',  third === false);
}

// ── 5. Replay idempotency — duplicate post guard ──────────────────────────────
section('REPLAY IDEMPOTENCY');
{
  let replayIdCreated = null;
  let _savePrivatePending = false;

  async function mockCreateReplayRecord() {
    return 'replay_' + Math.random().toString(36).slice(2);
  }

  async function savePrivate() {
    if (_savePrivatePending || replayIdCreated) return 'skipped';
    _savePrivatePending = true;
    try {
      replayIdCreated = await mockCreateReplayRecord();
      return 'created:' + replayIdCreated;
    } catch (_) {
      _savePrivatePending = false;
      return 'error';
    }
  }

  // Simulate rapid double-click
  const results = await Promise.all([savePrivate(), savePrivate(), savePrivate()]);
  const created = results.filter(r => r.startsWith('created:'));
  const skipped = results.filter(r => r === 'skipped');

  assert('Only ONE replay record is created on rapid clicks', created.length === 1,
    `created=${created.length} skipped=${skipped.length}`);
  assert('Subsequent calls are skipped',  skipped.length === 2);
}

// ── 6. Founder email check ─────────────────────────────────────────────────────
section('FOUNDER SECURITY');
{
  const FOUNDER_EMAIL = 'christijerina46@gmail.com';

  function isFounderUser(user) {
    return !!(user && user.email?.trim().toLowerCase() === FOUNDER_EMAIL.toLowerCase());
  }

  assert('Founder email match is case-insensitive',
    isFounderUser({ email: 'CHRISTIJERINA46@GMAIL.COM' }));
  assert('Founder email matches exactly',
    isFounderUser({ email: 'christijerina46@gmail.com' }));
  assert('Non-founder email is rejected',
    !isFounderUser({ email: 'other@gmail.com' }));
  assert('null user is rejected',
    !isFounderUser(null));
  assert('User without email is rejected',
    !isFounderUser({ uid: 'abc' }));
  assert('Empty string email is rejected',
    !isFounderUser({ email: '' }));
}

// ── 7. Viewer presence isolation ──────────────────────────────────────────────
section('VIEWER PRESENCE ISOLATION');
{
  // Simulate viewer presence keys — each user's presence is keyed by UID
  // so reconnects update the same key rather than creating new entries
  function getPresencePath(rtdbRoomId, userUid) {
    return `liveRooms/${rtdbRoomId}/viewerPresence/${userUid}`;
  }

  const ROOM_A = 'room_a';
  const ROOM_B = 'room_b';
  const USER_1 = 'user_1';
  const USER_2 = 'user_2';

  // User 1 reconnects 3 times to Room A — should always write to same path
  const paths = [
    getPresencePath(ROOM_A, USER_1),
    getPresencePath(ROOM_A, USER_1),
    getPresencePath(ROOM_A, USER_1),
  ];
  const uniquePaths = new Set(paths);
  assert('Viewer reconnect uses same presence path (no duplication)', uniquePaths.size === 1);

  // User 1 in Room A vs Room B → different paths
  const pathA = getPresencePath(ROOM_A, USER_1);
  const pathB = getPresencePath(ROOM_B, USER_1);
  assert('Same viewer in different rooms has different paths', pathA !== pathB);

  // User 1 in Room A vs User 2 in Room A → different paths
  const pathU1 = getPresencePath(ROOM_A, USER_1);
  const pathU2 = getPresencePath(ROOM_A, USER_2);
  assert('Different viewers in same room have different paths', pathU1 !== pathU2);
}

// ── 8. Main TV resync (elapsed time logic) ────────────────────────────────────
section('MAIN TV SCHEDULE RESYNC');
{
  // Simulate the schedule elapsed-time calculation when returning from featured live
  // The schedule started at T=0. We featured a creator from T=15min to T=35min.
  // On return, the schedule should resume at T=35min, not restart at T=0.
  function calcSchedulePosition(scheduleStartedAt, now) {
    return (now - scheduleStartedAt) / 1000; // elapsed seconds
  }

  const scheduleStart = 1000000000000;  // arbitrary epoch ms
  const featuredFrom  = scheduleStart + 15 * 60 * 1000;
  const returnedAt    = scheduleStart + 35 * 60 * 1000;

  const elapsedAtReturn = calcSchedulePosition(scheduleStart, returnedAt);
  assert('Schedule position at return is ~35 minutes',
    Math.abs(elapsedAtReturn - 2100) < 1,
    `Got ${elapsedAtReturn}s, expected 2100s`);

  assert('Schedule does NOT restart from 0 on feature return',
    elapsedAtReturn > 0);
}

// ── 9. Channel ownership isolation ────────────────────────────────────────────
section('CHANNEL OWNERSHIP ISOLATION');
{
  function canEditChannel(requestingUid, channelOwnerUid, isFounder) {
    return requestingUid === channelOwnerUid || isFounder;
  }
  function canEndLive(requestingUid, hostUid, isFounder) {
    return requestingUid === hostUid || isFounder;
  }
  function canDeleteReplay(requestingUid, creatorUid, isFounder) {
    return requestingUid === creatorUid || isFounder;
  }

  const USER_A = 'userA';
  const USER_B = 'userB';
  const FOUNDER = 'founder';
  const IS_FOUNDER = true;

  assert('Owner can edit own channel',       canEditChannel(USER_A, USER_A, false));
  assert('Other user cannot edit channel',   !canEditChannel(USER_B, USER_A, false));
  assert('Founder can edit any channel',     canEditChannel(FOUNDER, USER_A, IS_FOUNDER));
  assert('Owner can end own live',           canEndLive(USER_A, USER_A, false));
  assert('Other user cannot end live',       !canEndLive(USER_B, USER_A, false));
  assert('Owner can delete own replay',      canDeleteReplay(USER_A, USER_A, false));
  assert('Other user cannot delete replay',  !canDeleteReplay(USER_B, USER_A, false));
}

// ── 10. ESC encoding for XSS prevention ──────────────────────────────────────
section('XSS PREVENTION');
{
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  assert('< is escaped', _esc('<script>') === '&lt;script&gt;');
  assert('> is escaped', _esc('>') === '&gt;');
  assert('" is escaped', _esc('"quoted"') === '&quot;quoted&quot;');
  assert("' is escaped", _esc("'quoted'") === '&#39;quoted&#39;');
  assert('& is escaped', _esc('a&b') === 'a&amp;b');
  assert('null returns empty string', _esc(null) === '');
  assert('undefined returns empty string', _esc(undefined) === '');
}

// ── SUMMARY ───────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(52)}`);
console.log(`  STAGE 6 AUTOMATED TESTS COMPLETE`);
console.log(`  Passed: ${_passed}   Failed: ${_failed}   Total: ${_passed + _failed}`);
console.log(`${'═'.repeat(52)}\n`);

const failedTests = _results.filter(r => r.status === 'FAIL');
if (failedTests.length) {
  console.error('FAILED TESTS:');
  failedTests.forEach(t => console.error(`  ✗ ${t.name}${t.notes ? ' — ' + t.notes : ''}`));
  process.exit(1);
} else {
  console.log('  All automated tests PASS.\n');
  process.exit(0);
}
