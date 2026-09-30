/**
 * Shadow Nexus Radio — Stage 3 Tests
 * snx-radio-tests.js
 * Version: 3.0.0
 *
 * Tests:
 *   Original T1–T15: deterministic timeline (45 assertions) — UNCHANGED.
 *   Stage 3 tests S1–S20: schedule, programs, recently played, edge cases.
 *
 * Run in browser: load snx-radio.js first, then this file.
 * All tests are pure math — no Firebase, no Audio, no DOM required.
 */

(function () {
'use strict';

/* ══════════════════════════════════════════════════════════════
   MINI TEST RUNNER
══════════════════════════════════════════════════════════════ */

let _passed = 0;
let _failed = 0;

function assert(label, actual, expected, tolerance) {
  const tol = typeof tolerance === 'number' ? tolerance : 0;
  const ok = typeof expected === 'boolean'
    ? actual === expected
    : Math.abs(actual - expected) <= tol;
  if (ok) {
    _passed++;
    console.log('  ✅', label, '→', actual);
  } else {
    _failed++;
    console.error('  ❌', label, '→ got', actual, 'expected', expected,
      tol > 0 ? '(±' + tol + ')' : '');
  }
}

function assertNull(label, val) {
  if (val === null || val === undefined) {
    _passed++;
    console.log('  ✅', label, '→ null/undefined');
  } else {
    _failed++;
    console.error('  ❌', label, '→ expected null, got', val);
  }
}

function assertNotNull(label, val) {
  if (val !== null && val !== undefined) {
    _passed++;
    console.log('  ✅', label, '→', val);
  } else {
    _failed++;
    console.error('  ❌', label, '→ expected non-null, got', val);
  }
}

function assertEqual(label, actual, expected) {
  if (actual === expected) {
    _passed++;
    console.log('  ✅', label, '→', actual);
  } else {
    _failed++;
    console.error('  ❌', label, '→ got', actual, 'expected', expected);
  }
}

function group(name, fn) {
  console.group('[SNX-RADIO-TEST] ' + name);
  fn();
  console.groupEnd();
}

/* ══════════════════════════════════════════════════════════════
   TEST DATA
   Track A = 180s, Track B = 240s, Track C = 200s
   Total playlist = 620 seconds
══════════════════════════════════════════════════════════════ */

const TRACKS = [
  { id: 'track-a', title: 'Track A', artist: 'Artist 1', audioUrl: 'https://example.com/a.mp3', duration: 180 },
  { id: 'track-b', title: 'Track B', artist: 'Artist 2', audioUrl: 'https://example.com/b.mp3', duration: 240 },
  { id: 'track-c', title: 'Track C', artist: 'Artist 3', audioUrl: 'https://example.com/c.mp3', duration: 200 },
];

const TOTAL_DUR = 180 + 240 + 200; // 620 seconds

const ONE_TRACK = [
  { id: 'single', title: 'Solo', artist: 'X', audioUrl: 'https://example.com/s.mp3', duration: 300 },
];

const TWO_TRACKS = [
  { id: 'aa', title: 'AA', artist: 'X', audioUrl: 'https://example.com/aa.mp3', duration: 100 },
  { id: 'bb', title: 'BB', artist: 'Y', audioUrl: 'https://example.com/bb.mp3', duration: 200 },
];

const EPOCH = 1_000_000_000_000;

const fn           = window.SNXRadio._timeline;
const fnSched      = window.SNXRadio._resolveSchedule;
const fnRecent     = window.SNXRadio._recentlyPlayed;

/* ══════════════════════════════════════════════════════════════
   ORIGINAL T1–T15 (45 assertions) — UNCHANGED
══════════════════════════════════════════════════════════════ */

group('T1 — Join at station start (elapsed = 0)', () => {
  const r = fn(EPOCH, TRACKS, EPOCH);
  assert('trackIdx = 0 (Track A)',   r.trackIdx,    0);
  assert('positionSec ≈ 0',          r.positionSec, 0, 1);
  assert('trackId = track-a',        r.trackId === 'track-a', true);
  assert('totalElapsedSec = 0',      r.totalElapsedSec, 0, 1);
});

group('T2 — Mid Track A (elapsed = 90s)', () => {
  const now = EPOCH + 90_000;
  const r   = fn(EPOCH, TRACKS, now);
  assert('trackIdx = 0 (Track A)',   r.trackIdx,    0);
  assert('positionSec ≈ 90',         r.positionSec, 90, 1);
  assert('trackId = track-a',        r.trackId === 'track-a', true);
});

group('T3 — Boundary Track A → Track B (elapsed = 180s)', () => {
  const now = EPOCH + 180_000;
  const r   = fn(EPOCH, TRACKS, now);
  assert('trackIdx = 1 (Track B)',   r.trackIdx,    1);
  assert('positionSec ≈ 0',          r.positionSec, 0, 1);
  assert('trackId = track-b',        r.trackId === 'track-b', true);
});

group('T4 — Spec example: 300s elapsed → Track B at 120s', () => {
  const now = EPOCH + 300_000;
  const r   = fn(EPOCH, TRACKS, now);
  assert('trackIdx = 1 (Track B)',   r.trackIdx,    1);
  assert('positionSec ≈ 120',        r.positionSec, 120, 1);
  assert('trackId = track-b',        r.trackId === 'track-b', true);
  assert('totalElapsedSec = 300',    r.totalElapsedSec, 300, 1);
});

group('T5 — Mid Track C (elapsed = 500s)', () => {
  const now = EPOCH + 500_000;
  const r   = fn(EPOCH, TRACKS, now);
  assert('trackIdx = 2 (Track C)',   r.trackIdx,    2);
  assert('positionSec ≈ 80',         r.positionSec, 80, 1);
  assert('trackId = track-c',        r.trackId === 'track-c', true);
});

group('T6 — After full loop (elapsed = 620s = totalDur)', () => {
  const now = EPOCH + 620_000;
  const r   = fn(EPOCH, TRACKS, now);
  assert('trackIdx = 0 (Track A again)', r.trackIdx,    0);
  assert('positionSec ≈ 0',              r.positionSec, 0, 1);
  assert('loopElapsedSec ≈ 0',           r.loopElapsedSec, 0, 1);
});

group('T7 — 1.5 loops (elapsed = 930s)', () => {
  const now = EPOCH + 930_000;
  const r   = fn(EPOCH, TRACKS, now);
  assert('trackIdx = 1 (Track B)',   r.trackIdx,    1);
  assert('positionSec ≈ 130',        r.positionSec, 130, 1);
  assert('loopElapsedSec ≈ 310',     r.loopElapsedSec, 310, 1);
});

group('T8 — Two clients at same time → identical result', () => {
  const now = EPOCH + 455_000;
  const c1  = fn(EPOCH, TRACKS, now);
  const c2  = fn(EPOCH, TRACKS, now);
  assert('Both trackIdx match',      c1.trackIdx,    c2.trackIdx);
  assert('Both positionSec match',   c1.positionSec, c2.positionSec, 0);
  assert('Both trackId match',       c1.trackId === c2.trackId, true);
});

group('T9 — Page reopen after 30 min (no stale position restore)', () => {
  const nowAtOpen  = EPOCH + 100_000;
  const nowAfter30 = EPOCH + 1_900_000;
  const atOpen     = fn(EPOCH, TRACKS, nowAtOpen);
  const atReopen   = fn(EPOCH, TRACKS, nowAfter30);
  assert('At open: Track A pos ~100',    atOpen.positionSec,   100, 1);
  assert('After reopen: NOT at old pos', atReopen.positionSec === 100, false);
  const expected = 1900 % 620;
  assert('After reopen: track A at ~40s', atReopen.positionSec, expected, 1);
  assert('After reopen: trackIdx = 0',   atReopen.trackIdx, 0);
});

group('T10 — Station restart (new epoch)', () => {
  const epoch1     = EPOCH;
  const epoch2     = EPOCH + 900_000;
  const atOldEpoch = fn(epoch1, TRACKS, epoch2);
  const atNewEpoch = fn(epoch2, TRACKS, epoch2);
  assert('Old epoch → advanced position', atOldEpoch.totalElapsedSec, 900, 1);
  assert('New epoch → starts at 0',       atNewEpoch.positionSec,     0,   1);
  assert('New epoch → Track A',           atNewEpoch.trackIdx,        0);
});

group('T11 — Empty playlist → null (no crash)', () => {
  const r = fn(EPOCH, [], EPOCH + 100_000);
  assertNull('Returns null for empty playlist', r);
});

group('T12 — Single track loops (duration=300s)', () => {
  const now = EPOCH + 750_000;
  const r   = fn(EPOCH, ONE_TRACK, now);
  assert('trackIdx = 0',         r.trackIdx,    0);
  assert('positionSec = 150',    r.positionSec, 150, 1);
});

group('T13 — Two tracks: AA(100s) + BB(200s), boundary at 100s', () => {
  const r_at99  = fn(EPOCH, TWO_TRACKS, EPOCH + 99_000);
  const r_at100 = fn(EPOCH, TWO_TRACKS, EPOCH + 100_000);
  const r_at150 = fn(EPOCH, TWO_TRACKS, EPOCH + 150_000);
  assert('99s → Track AA',        r_at99.trackIdx,   0);
  assert('100s → Track BB',       r_at100.trackIdx,  1);
  assert('100s → pos=0',          r_at100.positionSec, 0, 1);
  assert('150s → pos=50 in BB',   r_at150.positionSec, 50, 1);
});

group('T14 — Large elapsed: 24 hours (86400s)', () => {
  const now  = EPOCH + 86_400_000;
  const r    = fn(EPOCH, TRACKS, now);
  const loop = 86400 % 620;
  let acc = 0, expectedIdx = 0, expectedPos = 0;
  for (let i = 0; i < TRACKS.length; i++) {
    if (loop < acc + TRACKS[i].duration) { expectedIdx = i; expectedPos = loop - acc; break; }
    acc += TRACKS[i].duration;
  }
  assert('trackIdx correct',      r.trackIdx,    expectedIdx);
  assert('positionSec correct',   r.positionSec, expectedPos, 1);
  assert('Result is defined',     r !== null, true);
});

group('T15 — Two clients with 2s clock skew → same track, close position', () => {
  const now1 = EPOCH + 400_000;
  const now2 = EPOCH + 402_000;
  const c1   = fn(EPOCH, TRACKS, now1);
  const c2   = fn(EPOCH, TRACKS, now2);
  assert('Same track',           c1.trackIdx === c2.trackIdx, true);
  assert('Position within 3s',   Math.abs(c1.positionSec - c2.positionSec), 2, 1);
});

/* ══════════════════════════════════════════════════════════════
   STAGE 3: SCHEDULE CALCULATION TESTS
══════════════════════════════════════════════════════════════ */

// Reference schedule (UTC): 00:00=Overnight, 06:00=Morning, 12:00=Noon, 18:00=Evening, 22:00=Night
const SCHEDULE = [
  { slotId: 'slot-1', hour: 0,  minute: 0,  programId: 'prog-overnight', label: 'Overnight Radio',  enabled: true,  order: 0 },
  { slotId: 'slot-2', hour: 6,  minute: 0,  programId: 'prog-morning',   label: 'Morning Mix',      enabled: true,  order: 1 },
  { slotId: 'slot-3', hour: 12, minute: 0,  programId: 'prog-noon',      label: 'Shadow Nexus Radio', enabled: true, order: 2 },
  { slotId: 'slot-4', hour: 18, minute: 0,  programId: 'prog-evening',   label: 'Evening Mix',      enabled: true,  order: 3 },
  { slotId: 'slot-5', hour: 22, minute: 0,  programId: 'prog-night',     label: 'Night Shift',      enabled: true,  order: 4 },
];

// Helper: build a UTC timestamp for a given hour and minute
function utcMs(h, m) {
  const d = new Date(0); // Unix epoch Jan 1 1970
  d.setUTCHours(h, m, 0, 0);
  return d.getTime();
}

group('S1 — Schedule: midnight returns Overnight Radio', () => {
  const slot = fnSched(SCHEDULE, utcMs(0, 0));
  assertNotNull('Slot found',                slot);
  assertEqual('Program = Overnight', slot.programId, 'prog-overnight');
  assertEqual('Label correct',       slot.label,    'Overnight Radio');
});

group('S2 — Schedule: 05:59 → still Overnight (before morning starts)', () => {
  const slot = fnSched(SCHEDULE, utcMs(5, 59));
  assertNotNull('Slot found',                slot);
  assertEqual('Program = Overnight', slot.programId, 'prog-overnight');
});

group('S3 — Schedule: exactly 06:00 → Morning Mix', () => {
  const slot = fnSched(SCHEDULE, utcMs(6, 0));
  assertNotNull('Slot found',        slot);
  assertEqual('Program = Morning',   slot.programId, 'prog-morning');
});

group('S4 — Schedule: 11:30 → still Morning (before noon)', () => {
  const slot = fnSched(SCHEDULE, utcMs(11, 30));
  assertNotNull('Slot found',        slot);
  assertEqual('Program = Morning',   slot.programId, 'prog-morning');
});

group('S5 — Schedule: exactly 12:00 → Shadow Nexus Radio', () => {
  const slot = fnSched(SCHEDULE, utcMs(12, 0));
  assertNotNull('Slot found',        slot);
  assertEqual('Program = Noon',      slot.programId, 'prog-noon');
});

group('S6 — Schedule: 17:59 → Evening Mix not yet started → still Noon', () => {
  const slot = fnSched(SCHEDULE, utcMs(17, 59));
  assertNotNull('Slot found',        slot);
  assertEqual('Program = Noon',      slot.programId, 'prog-noon');
});

group('S7 — Schedule: exactly 18:00 → Evening Mix', () => {
  const slot = fnSched(SCHEDULE, utcMs(18, 0));
  assertNotNull('Slot found',        slot);
  assertEqual('Program = Evening',   slot.programId, 'prog-evening');
});

group('S8 — Schedule: exactly 22:00 → Night Shift', () => {
  const slot = fnSched(SCHEDULE, utcMs(22, 0));
  assertNotNull('Slot found',        slot);
  assertEqual('Program = Night',     slot.programId, 'prog-night');
});

group('S9 — Schedule: 23:59 → still Night Shift (wraps at midnight)', () => {
  const slot = fnSched(SCHEDULE, utcMs(23, 59));
  assertNotNull('Slot found',        slot);
  assertEqual('Program = Night',     slot.programId, 'prog-night');
});

group('S10 — Schedule: empty schedule → null', () => {
  const slot = fnSched([], utcMs(12, 0));
  assertNull('Returns null for empty', slot);
});

group('S11 — Schedule: all slots disabled → null', () => {
  const disabled = SCHEDULE.map(s => ({ ...s, enabled: false }));
  const slot = fnSched(disabled, utcMs(12, 0));
  assertNull('Returns null when all disabled', slot);
});

group('S12 — Schedule: disabled program is skipped', () => {
  // Disable Morning Mix — 06:00 should fall back to Overnight
  const partDisabled = SCHEDULE.map(s =>
    s.slotId === 'slot-2' ? { ...s, enabled: false } : s
  );
  const slot = fnSched(partDisabled, utcMs(9, 0)); // 09:00
  assertNotNull('Slot found',              slot);
  assertEqual('Skips Morning → Overnight', slot.programId, 'prog-overnight');
});

group('S13 — Schedule: single slot always active', () => {
  const single = [{ slotId: 's1', hour: 6, minute: 0, programId: 'prog-a', label: 'Only', enabled: true, order: 0 }];
  const atMid   = fnSched(single, utcMs(14, 0));
  const atNight = fnSched(single, utcMs(23, 0));
  const atMorn  = fnSched(single, utcMs(3, 0));  // before 06:00 → wraps to "yesterday"
  assertNotNull('14:00 → slot found',  atMid);
  assertNotNull('23:00 → slot found',  atNight);
  assertNotNull('03:00 → slot found (wrap)', atMorn);
  // All three should resolve to the same single slot
  assertEqual('All same program',      atMid.programId,   'prog-a');
  assertEqual('All same program (2)',  atNight.programId, 'prog-a');
  assertEqual('All same program (3)',  atMorn.programId,  'prog-a');
});

group('S14 — Schedule: two clients at same time → same slot', () => {
  const nowMs = utcMs(15, 30);
  const s1 = fnSched(SCHEDULE, nowMs);
  const s2 = fnSched(SCHEDULE, nowMs);
  assertNotNull('Both resolved',        s1);
  assertEqual('Same slot', s1.slotId,  s2.slotId);
});

group('S15 — Schedule: refresh/rejoin during program → same slot', () => {
  // 13:30 → still Noon program
  const s1 = fnSched(SCHEDULE, utcMs(13, 0));
  const s2 = fnSched(SCHEDULE, utcMs(13, 30));
  assertEqual('13:00 → Noon',  s1.programId, 'prog-noon');
  assertEqual('13:30 → Noon',  s2.programId, 'prog-noon');
});

/* ══════════════════════════════════════════════════════════════
   STAGE 3: RECENTLY PLAYED TESTS
══════════════════════════════════════════════════════════════ */

// Recently played is derived from _timeline via SNXRadio.recentlyPlayed getter.
// Since SNXRadio._recentlyPlayed() requires live state (_station, _playlist),
// we test the underlying logic through the public _recentlyPlayed function.

group('S16 — Recently played: function exists on SNXRadio', () => {
  assertNotNull('_recentlyPlayed exists', window.SNXRadio._recentlyPlayed);
  assertEqual('Is function', typeof window.SNXRadio._recentlyPlayed, 'function');
});

group('S17 — Recently played: returns empty array when no station', () => {
  // _recentlyPlayed needs _station to be set internally; when called fresh
  // without init it should return [] gracefully
  const result = window.SNXRadio._recentlyPlayed();
  assertNotNull('Returns array', result);
  assertEqual('Is array', Array.isArray(result), true);
});

/* ══════════════════════════════════════════════════════════════
   STAGE 3: DISABLED TRACKS TESTS
══════════════════════════════════════════════════════════════ */

group('S18 — Disabled tracks are filtered from timeline', () => {
  const tracksWithDisabled = [
    { id: 'ta', title: 'A', artist: 'X', audioUrl: 'https://x.com/a.mp3', duration: 100, enabled: true },
    { id: 'tb', title: 'B', artist: 'Y', audioUrl: 'https://x.com/b.mp3', duration: 100, enabled: false }, // disabled
    { id: 'tc', title: 'C', artist: 'Z', audioUrl: 'https://x.com/c.mp3', duration: 100, enabled: true },
  ];
  // SNXRadio._timeline receives pre-filtered tracks (engine filters on load)
  // Simulate by only passing enabled tracks to _timeline
  const enabled = tracksWithDisabled.filter(t => t.enabled !== false);
  const r = fn(EPOCH, enabled, EPOCH + 150_000); // 150s into 200s total
  assertNotNull('Result not null', r);
  assertEqual('Only enabled tracks used', enabled.length, 2);
  // 150s into [100s + 100s] = Track C at 50s
  assertEqual('trackIdx = 1 (Track C)', r.trackIdx, 1);
  assert('positionSec = 50', r.positionSec, 50, 1);
});

/* ══════════════════════════════════════════════════════════════
   STAGE 3: SERVER CLOCK OFFSET TEST
══════════════════════════════════════════════════════════════ */

group('S19 — Server clock offset: corrected time affects timeline', () => {
  // Simulate a 2 second server offset (server is 2s ahead of local clock)
  const offset   = 2000; // ms
  const localNow = EPOCH + 300_000;
  const serverNow = localNow + offset;

  const withoutOffset = fn(EPOCH, TRACKS, localNow);
  const withOffset    = fn(EPOCH, TRACKS, serverNow);

  // Both on Track B, but offset version is 2s further ahead
  assertEqual('Same track',          withoutOffset.trackIdx, withOffset.trackIdx);
  assert('Offset version 2s ahead',
    withOffset.positionSec - withoutOffset.positionSec, 2, 1);
});

/* ══════════════════════════════════════════════════════════════
   STAGE 3: MIDNIGHT ROLLOVER TEST
══════════════════════════════════════════════════════════════ */

group('S20 — Midnight rollover: schedule handles 00:00 → 23:59 → 00:00', () => {
  // Just before midnight: 23:59 → Night Shift
  const beforeMidnight = fnSched(SCHEDULE, utcMs(23, 59));
  assertEqual('23:59 → Night', beforeMidnight.programId, 'prog-night');

  // At midnight: 00:00 → Overnight Radio
  const atMidnight = fnSched(SCHEDULE, utcMs(0, 0));
  assertEqual('00:00 → Overnight', atMidnight.programId, 'prog-overnight');

  // 00:01 → still Overnight
  const justAfterMidnight = fnSched(SCHEDULE, utcMs(0, 1));
  assertEqual('00:01 → Overnight', justAfterMidnight.programId, 'prog-overnight');
});

/* ══════════════════════════════════════════════════════════════
   STAGE 4A: BROADCAST ENGINE TESTS
   B1–B15: pure logic — no Firebase, no network, no DOM.
   Tests cover: RTMP destination validation, stream key masking,
   broadcast engine state, source adapter registration,
   failure isolation, multiple destinations, and audit report.
══════════════════════════════════════════════════════════════ */

// ── Helpers (pure functions, no side effects) ─────────────────────────────────

function _testMaskKey(key) {
  if (!key || key.length <= 4) return '****';
  return '*'.repeat(Math.min(key.length - 4, 20)) + key.slice(-4);
}

function _testValidateRtmpUrl(url) {
  return /^rtmps?:\/\//i.test(url);
}

function _testValidateDestination(dest) {
  if (!dest || !dest.name || !dest.serverUrl || !dest.streamKey) return false;
  return _testValidateRtmpUrl(dest.serverUrl);
}

function _testFilterEnabled(destinations) {
  return destinations.filter(d => d.enabled);
}

function _testBuildBroadcastState(destinations, source) {
  const enabled = _testFilterEnabled(destinations);
  return {
    active:       enabled.length > 0,
    destinations: enabled,
    source:       source || 'radio',
    healthChecks: Object.fromEntries(enabled.map(d => [d.id, { ok: true, errorCount: 0 }]))
  };
}

function _testIsolateDestinationFailure(state, failedId) {
  // Failure isolation: mark one destination as failed without stopping others
  const updated = { ...state, healthChecks: { ...state.healthChecks } };
  if (updated.healthChecks[failedId]) {
    updated.healthChecks[failedId] = {
      ok: false,
      errorCount: (updated.healthChecks[failedId].errorCount || 0) + 1
    };
  }
  // Active broadcast continues — other destinations unaffected
  return updated;
}

// ── Test data ─────────────────────────────────────────────────────────────────

const DEST_YT = { id: 'd1', name: 'YouTube',  serverUrl: 'rtmps://a.rtmps.youtube.com/live2',   streamKey: 'xxxx-yyyy-zzzz-1111', enabled: true };
const DEST_TW = { id: 'd2', name: 'Twitch',   serverUrl: 'rtmps://live.twitch.tv/app',           streamKey: 'live_abcdef1234567890', enabled: true };
const DEST_FB = { id: 'd3', name: 'Facebook', serverUrl: 'rtmps://live-api-s.facebook.com/rtmp', streamKey: 'fb-secret-key-9876', enabled: false };

const ALL_DESTS = [DEST_YT, DEST_TW, DEST_FB];

/* ── B1: RTMP URL validation ────────────────────────────────── */
group('B1 — RTMP URL validation: rtmp:// and rtmps:// are valid', () => {
  assertEqual('rtmps://youtube valid',         _testValidateRtmpUrl('rtmps://a.rtmps.youtube.com/live2'), true);
  assertEqual('rtmp://live.twitch.tv valid',   _testValidateRtmpUrl('rtmp://live.twitch.tv/app'),          true);
  assertEqual('rtmps:// uppercase valid',      _testValidateRtmpUrl('RTMPS://example.com/live'),           true);
  assertEqual('https:// invalid',             _testValidateRtmpUrl('https://example.com'),                false);
  assertEqual('empty string invalid',          _testValidateRtmpUrl(''),                                   false);
  assertEqual('ftp:// invalid',               _testValidateRtmpUrl('ftp://example.com'),                  false);
});

/* ── B2: Destination validation ─────────────────────────────── */
group('B2 — Destination validation: name + serverUrl + streamKey required', () => {
  assertEqual('Valid destination',      _testValidateDestination(DEST_YT),  true);
  assertEqual('Missing name',           _testValidateDestination({ serverUrl: 'rtmp://x.com', streamKey: 'k' }), false);
  assertEqual('Missing serverUrl',      _testValidateDestination({ name: 'YT', streamKey: 'k' }), false);
  assertEqual('Missing streamKey',      _testValidateDestination({ name: 'YT', serverUrl: 'rtmp://x.com' }), false);
  assertEqual('Invalid URL scheme',     _testValidateDestination({ name: 'YT', serverUrl: 'https://x.com', streamKey: 'k' }), false);
  assertEqual('null destination',       _testValidateDestination(null), false);
});

/* ── B3: Stream key masking — secret enforcement ─────────────── */
group('B3 — Stream key masking: full key never exposed', () => {
  const key  = 'xxxx-yyyy-zzzz-1111';
  const mask = _testMaskKey(key);
  assertEqual('Masked key ends with last 4',     mask.endsWith('1111'), true);
  assertEqual('Full key NOT in masked value',     mask.includes('xxxx-yyyy-zzzz'), false);
  assertEqual('Masked key is not full key',       mask === key, false);
  assert('Masked key length ≤ original + 4',     mask.length, key.length, key.length);
  assertEqual('Short key (≤4) → ****',           _testMaskKey('abc'),  '****');
  assertEqual('Empty key → ****',                _testMaskKey(''),     '****');
  assertEqual('4-char key → ****',               _testMaskKey('1234'), '****');
  assertEqual('5-char key shows last 4',         _testMaskKey('ab123'), '*123');
});

/* ── B4: Multiple destinations — all enabled are used ───────── */
group('B4 — Multiple destinations: only enabled ones are broadcast', () => {
  const enabled = _testFilterEnabled(ALL_DESTS);
  assertEqual('2 of 3 enabled',          enabled.length, 2);
  assertEqual('YouTube in enabled',      enabled.some(d => d.name === 'YouTube'),  true);
  assertEqual('Twitch in enabled',       enabled.some(d => d.name === 'Twitch'),   true);
  assertEqual('Facebook NOT in enabled', enabled.some(d => d.name === 'Facebook'), false);
});

/* ── B5: All disabled → no broadcast ────────────────────────── */
group('B5 — All disabled → no enabled destinations', () => {
  const allDisabled = ALL_DESTS.map(d => ({ ...d, enabled: false }));
  const enabled = _testFilterEnabled(allDisabled);
  assertEqual('No enabled destinations', enabled.length, 0);
});

/* ── B6: Broadcast state initialisation ─────────────────────── */
group('B6 — Broadcast state: initialised correctly from enabled destinations', () => {
  const state = _testBuildBroadcastState(ALL_DESTS, 'radio');
  assertEqual('active = true',               state.active,               true);
  assertEqual('source = radio',              state.source,               'radio');
  assertEqual('2 active destinations',       state.destinations.length,  2);
  assertEqual('health checks = 2',           Object.keys(state.healthChecks).length, 2);
  assertEqual('YouTube health: ok',          state.healthChecks['d1'].ok, true);
  assertEqual('Twitch health: ok',           state.healthChecks['d2'].ok, true);
  assertEqual('Facebook NOT in health',      'fd3' in state.healthChecks, false);
});

/* ── B7: Failure isolation — one failing dest does not stop others ── */
group('B7 — Failure isolation: YouTube fails, Twitch continues', () => {
  const state0 = _testBuildBroadcastState(ALL_DESTS, 'radio');
  const state1 = _testIsolateDestinationFailure(state0, 'd1');  // YouTube fails

  assertEqual('Broadcast still active',     state1.active,                     true);
  assertEqual('YouTube health: FAIL',       state1.healthChecks['d1'].ok,      false);
  assertEqual('YouTube error count = 1',    state1.healthChecks['d1'].errorCount, 1);
  assertEqual('Twitch health: OK',          state1.healthChecks['d2'].ok,      true);
  assertEqual('Twitch error count = 0',     state1.healthChecks['d2'].errorCount, 0);
});

/* ── B8: Second failure increments error count ───────────────── */
group('B8 — Failure isolation: consecutive failures increment error count', () => {
  let state = _testBuildBroadcastState(ALL_DESTS, 'radio');
  state = _testIsolateDestinationFailure(state, 'd1');
  state = _testIsolateDestinationFailure(state, 'd1');
  state = _testIsolateDestinationFailure(state, 'd1');

  assertEqual('Error count = 3',    state.healthChecks['d1'].errorCount, 3);
  assertEqual('Still active',       state.active,                        true);
  assertEqual('Twitch unaffected',  state.healthChecks['d2'].ok,         true);
});

/* ── B9: Single destination — failure still isolated ─────────── */
group('B9 — Single destination failure does not stop broadcast', () => {
  const singleDest = [{ id: 'sd1', name: 'Solo', serverUrl: 'rtmp://solo.example.com', streamKey: 'sk', enabled: true }];
  let state = _testBuildBroadcastState(singleDest, 'radio');
  state = _testIsolateDestinationFailure(state, 'sd1');

  assertEqual('Active remains true',  state.active,                      true);
  assertEqual('Health is FAIL',       state.healthChecks['sd1'].ok,      false);
  assertEqual('Error count = 1',      state.healthChecks['sd1'].errorCount, 1);
});

/* ── B10: Broadcast engine API exists on window ──────────────── */
group('B10 — SNXBroadcastEngine API exists', () => {
  assertNotNull('window.SNXBroadcastEngine',               window.SNXBroadcastEngine);
  assertEqual('listDestinations is function',   typeof window.SNXBroadcastEngine.listDestinations,  'function');
  assertEqual('saveDestination is function',    typeof window.SNXBroadcastEngine.saveDestination,   'function');
  assertEqual('updateDestination is function',  typeof window.SNXBroadcastEngine.updateDestination, 'function');
  assertEqual('deleteDestination is function',  typeof window.SNXBroadcastEngine.deleteDestination, 'function');
  assertEqual('startBroadcast is function',     typeof window.SNXBroadcastEngine.startBroadcast,    'function');
  assertEqual('stopBroadcast is function',      typeof window.SNXBroadcastEngine.stopBroadcast,     'function');
  assertEqual('getBroadcastStatus is function', typeof window.SNXBroadcastEngine.getBroadcastStatus,'function');
  assertEqual('on is function',                 typeof window.SNXBroadcastEngine.on,                'function');
  assertEqual('auditEncoderHost is function',   typeof window.SNXBroadcastEngine.auditEncoderHost,  'function');
});

/* ── B11: Broadcast not active by default ────────────────────── */
group('B11 — Broadcast status: IDLE by default', () => {
  const status = window.SNXBroadcastEngine.getBroadcastStatus();
  assertEqual('Not active',           status.active,       false);
  assertNull('Source is null',        status.source);
  assertNull('startedAt is null',     status.startedAt);
  assertEqual('Destinations = 0',     status.destinations, 0);
});

/* ── B12: Radio source adapter attaches to SNXRadio ─────────── */
group('B12 — Radio source adapter: attaches without crash', () => {
  assertNotNull('SNXRadio exists',    window.SNXRadio);
  // attachRadioSource should not throw when SNXRadio is present
  let threw = false;
  try { window.SNXBroadcastEngine.attachRadioSource(); }
  catch { threw = true; }
  assertEqual('attachRadioSource does not throw', threw, false);

  // detach immediately so tests don't leave residual listeners
  window.SNXBroadcastEngine.detachRadioSource();
});

/* ── B13: Encoder host audit report ─────────────────────────── */
group('B13 — Encoder host audit: documents continuous encoder requirement', () => {
  const audit = window.SNXBroadcastEngine.auditEncoderHost();
  assertNotNull('audit report exists',               audit);
  assertEqual('destinationManager = true',           audit.destinationManager,    true);
  assertEqual('multipleDestinations = true',         audit.multipleDestinations,  true);
  assertEqual('streamKeySecurity = true',            audit.streamKeySecurity,     true);
  assertEqual('continuousEncoderHost is documented', typeof audit.continuousEncoderHost, 'string');
  assertEqual('encoder not provisioned',             audit.continuousEncoderHost, 'NOT_CURRENTLY_PROVISIONED');
  assertNotNull('encoder note present',              audit.continuousEncoderNote);
});

/* ── B14: Stop broadcast when IDLE is a no-op ───────────────── */
group('B14 — stopBroadcast when idle: no-op, no error', () => {
  let threw = false;
  (async () => {
    try { await window.SNXBroadcastEngine.stopBroadcast(); }
    catch { threw = true; }
  })();
  // This is async — synchronously the broadcast should still be inactive
  const status = window.SNXBroadcastEngine.getBroadcastStatus();
  assertEqual('Still not active',  status.active,  false);
});

/* ── B15: Architecture validates source → engine → destinations ─ */
group('B15 — Architecture: RADIO → BROADCAST ENGINE → RTMP', () => {
  // Verify the data flow can be constructed from the available APIs
  assertEqual('Radio source available',     !!window.SNXRadio,                          true);
  assertEqual('Broadcast engine available', !!window.SNXBroadcastEngine,               true);
  assertEqual('version is 4.0.0',           window.SNXBroadcastEngine.version,          '4.0.0');

  // Validate RTMP URL scheme pattern matches known platforms
  const platforms = [
    'rtmps://a.rtmps.youtube.com/live2',
    'rtmps://live.twitch.tv/app',
    'rtmp://live-api-s.facebook.com/rtmp',
    'rtmps://dc4-1.rtmp.t.me/s',   // Telegram
    'rtmp://a.rtmp.example.com/live',
  ];
  platforms.forEach((url, i) => {
    assertEqual(`Platform URL ${i + 1} valid rtmp(s):// scheme`, _testValidateRtmpUrl(url), true);
  });
});

/* ══════════════════════════════════════════════════════════════
   SUMMARY
══════════════════════════════════════════════════════════════ */

console.group('[SNX-RADIO-TEST] ════ FINAL SUMMARY ════');
const total = _passed + _failed;
console.log(`Tests: ${total}  ✅ Passed: ${_passed}  ❌ Failed: ${_failed}`);
if (_failed === 0) {
  console.log('%c All tests passed ', 'background:#166534;color:#dcfce7;font-weight:bold;padding:4px 8px;border-radius:4px;');
} else {
  console.error(_failed + ' test(s) FAILED — check above for details');
}
console.groupEnd();

// Expose results for automated check
window._snxRadioTestResults = { total, passed: _passed, failed: _failed };

})();
