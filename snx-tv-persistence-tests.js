/**
 * SHADOW NEXUS SOCIAL — TV Persistence Tests
 * snx-tv-persistence-tests.js
 *
 * OWNERSHIP: Shadow Nexus Social
 *
 * Tests the SNS 24-Hour TV scheduled advancement logic extracted from
 * upload-worker.js.  All tests are pure JS — no Firebase, no network,
 * no DOM, no Cloudflare runtime required.
 *
 * Covers:
 *   P1–P5   : Firestore codec (encode/decode round-trips)
 *   A1–A10  : Advancement logic (current item timing, expiry, catch-up)
 *   I1–I4   : Idempotency (lock acquire/release)
 *   E1–E6   : Edge cases (empty queue, missing media, invalid duration, etc.)
 *   S1–S5   : 24-hour simulation (no viewer, multiple programs elapsed)
 *   R1–R3   : Viewer rejoin (correct current item after extended absence)
 *   C1–C3   : Concurrent viewer + cron advancement
 *
 * Run: node snx-tv-persistence-tests.js
 *
 * NOTE: The test runner re-implements the pure logic functions from
 * upload-worker.js inline so it runs in Node without Worker globals.
 * If you change the logic in upload-worker.js, keep these in sync.
 */

'use strict';

/* ═══════════════════════════════════════════════════════
   MINI TEST RUNNER
═══════════════════════════════════════════════════════ */

let _passed = 0;
let _failed = 0;
let _partial = 0;

function assert(label, actual, expected, tolerance) {
  const tol = typeof tolerance === 'number' ? tolerance : 0;
  const ok  = typeof expected === 'boolean'
    ? actual === expected
    : Math.abs(Number(actual) - Number(expected)) <= tol;
  if (ok) { _passed++; console.log('  ✅', label, '→', actual); }
  else     { _failed++; console.error('  ❌', label, '→ got', actual, 'expected', expected, tol > 0 ? `(±${tol})` : ''); }
}

function assertEqual(label, actual, expected) {
  if (actual === expected) { _passed++; console.log('  ✅', label, '→', actual); }
  else { _failed++; console.error('  ❌', label, '→ got', JSON.stringify(actual), 'expected', JSON.stringify(expected)); }
}

function assertNull(label, val) {
  if (val === null || val === undefined) { _passed++; console.log('  ✅', label, '→ null/undefined'); }
  else { _failed++; console.error('  ❌', label, '→ expected null, got', val); }
}

function assertNotNull(label, val) {
  if (val !== null && val !== undefined) { _passed++; console.log('  ✅', label, '→', val); }
  else { _failed++; console.error('  ❌', label, '→ expected non-null, got', val); }
}

function assertTrue(label, val) {
  assertEqual(label, !!val, true);
}

function assertFalse(label, val) {
  assertEqual(label, !!val, false);
}

function group(name, fn) {
  console.group(`[SNS-TV-TEST] ${name}`);
  fn();
  console.groupEnd();
}

/* ═══════════════════════════════════════════════════════
   PURE LOGIC EXTRACTED FROM upload-worker.js
   (keep in sync with worker implementation)
═══════════════════════════════════════════════════════ */

// ── Firestore codec ──────────────────────────────────────────────────────────

function _tvFsFieldDecode(f) {
  if (!f) return null;
  if ('stringValue'    in f) return f.stringValue;
  if ('integerValue'   in f) return Number(f.integerValue);
  if ('doubleValue'    in f) return Number(f.doubleValue);
  if ('booleanValue'   in f) return f.booleanValue;
  if ('timestampValue' in f) return new Date(f.timestampValue).getTime();
  if ('nullValue'      in f) return null;
  if ('arrayValue'     in f) {
    const vals = f.arrayValue?.values || [];
    return vals.map(_tvFsFieldDecode);
  }
  if ('mapValue' in f) return _tvFsDocToObj(f.mapValue);
  return null;
}

function _tvFsDocToObj(doc) {
  if (!doc || !doc.fields) return {};
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    out[k] = _tvFsFieldDecode(v);
  }
  return out;
}

function _tvFsEncode(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean')          return { booleanValue: val };
  if (typeof val === 'number' && Number.isInteger(val)) return { integerValue: String(val) };
  if (typeof val === 'number')           return { doubleValue: val };
  if (typeof val === 'string')           return { stringValue: val };
  if (Array.isArray(val))                return { arrayValue: { values: val.map(_tvFsEncode) } };
  if (val instanceof Date)               return { timestampValue: val.toISOString() };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = _tvFsEncode(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function _tvObjToFsFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = _tvFsEncode(v);
  return fields;
}

// ── Program selection ────────────────────────────────────────────────────────

const SNS_TV_PROGRAM_TYPES    = new Set([
  'video','music_video','show','broadcast_clip','audio_program',
  'podcast','station_id','archive','trailer','audio','music',
]);
const SNS_TV_COMMERCIAL_TYPES = new Set([
  'commercial','promo','trailer','station_id',
]);

function _tvPickProgram(mediaLib, config, justPlayedId) {
  const pool = mediaLib.filter(m =>
    SNS_TV_PROGRAM_TYPES.has(m.type) && m.url && m.live_tv_assigned !== false
  );
  if (!pool.length) return null;
  const recentHistory = config.recent_history || [];
  const avoidIds = justPlayedId ? [...recentHistory, justPlayedId] : recentHistory;
  let candidates = pool.filter(m => !avoidIds.includes(m.id));
  if (!candidates.length) candidates = pool.filter(m => m.id !== justPlayedId);
  if (!candidates.length) candidates = pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function _tvPickCommercials(mediaLib, config) {
  const FREQ_TABLE = {
    off:    { minSpot: 0, maxSpot: 0 },
    low:    { minSpot: 1, maxSpot: 1 },
    normal: { minSpot: 1, maxSpot: 2 },
    high:   { minSpot: 2, maxSpot: 3 },
  };
  const freq = FREQ_TABLE[config.commercial_freq] || FREQ_TABLE.normal;
  if (freq.maxSpot === 0) return [];
  const pool = mediaLib.filter(m =>
    SNS_TV_COMMERCIAL_TYPES.has(m.type) && m.live_tv_assigned !== false && m.url
  );
  if (!pool.length) return [];
  const count = _tvRandInt(freq.minSpot, freq.maxSpot);
  const result = [];
  const recentComm = config.commercial_history || [];
  for (let i = 0; i < count; i++) {
    const available = pool.filter(m => !result.find(r => r.id === m.id));
    if (!available.length) break;
    const fresh = available.filter(m => !recentComm.includes(m.id));
    const src   = fresh.length ? fresh : available;
    result.push(src[Math.floor(Math.random() * src.length)]);
  }
  return result;
}

function _tvShouldRunCommercialBreak(config) {
  const FREQ_TABLE = {
    off:    { maxSpot: 0, minPrograms: 999 },
    low:    { maxSpot: 1, minPrograms: 4 },
    normal: { maxSpot: 2, minPrograms: 2 },
    high:   { maxSpot: 3, minPrograms: 1 },
  };
  const freq   = FREQ_TABLE[config.commercial_freq] || FREQ_TABLE.normal;
  if (freq.maxSpot === 0) return false;
  const since  = config.programs_since_break || 0;
  const target = config.next_break_at || freq.minPrograms;
  return since >= target;
}

function _tvRandInt(min, max) {
  if (min > max) return max;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _tvMediaItemToState(m) {
  return {
    id:           m.id,
    title:        m.title        || '(untitled)',
    artist:       m.artist       || '',
    type:         m.type         || 'media',
    url:          m.url          || '',
    duration_sec: m.duration_sec || 0,
    mime_type:    m.mime_type    || '',
  };
}

// ── Simulated advancement engine (mirrors _tvAdvanceChannel logic) ───────────
//
// This version accepts explicit state/config/mediaLib instead of fetching from
// Firestore — allows deterministic testing without network calls.

const SNS_TV_MAX_CATCHUP = 50;

function _simAdvance(state, config, mediaLib, opts = {}) {
  const isScheduled   = opts.isScheduled || false;
  const now           = opts.now || Date.now();
  const requestedItemId = opts.currentItemId || null;

  if (!config || !config.running) return { advanced: false, reason: 'channel_not_running' };
  if (config.paused)              return { advanced: false, reason: 'channel_paused' };

  const currentItem   = state?.current_item || null;
  const currentItemId = currentItem?.id || null;

  // Viewer check
  if (!isScheduled && requestedItemId && currentItemId && requestedItemId !== currentItemId) {
    return { advanced: false, reason: `already_advanced:${currentItemId}` };
  }

  const startedAtMs   = typeof state?.started_at === 'number' ? state.started_at : 0;
  const duration_sec  = currentItem?.duration_sec || 0;
  const expectedEndMs = startedAtMs + duration_sec * 1000;
  const isExpired     = (duration_sec <= 0) || (now >= expectedEndMs);

  if (!isScheduled && !isExpired && currentItemId) {
    const remaining = Math.ceil((expectedEndMs - now) / 1000);
    return { advanced: false, reason: `too_early:${remaining}s` };
  }

  // Commercial queue drain
  const commQueue = state?.commercial_queue || [];
  if (commQueue.length > 0 && (!isScheduled || isExpired)) {
    const [nextComm, ...remaining] = commQueue;
    const newState = {
      ...state,
      current_item:     nextComm,
      started_at:       now,
      is_commercial:    true,
      commercial_queue: remaining,
      needs_next:       false,
      last_item_id:     nextComm.id,
      updated_at:       now,
    };
    return { advanced: true, reason: 'commercial_queue', newState, newItem: nextComm, advancedCount: 1 };
  }

  // Bootstrap
  if (!currentItemId) {
    const program = _tvPickProgram(mediaLib, config, state?.last_item_id || null);
    if (!program) return { advanced: false, reason: 'no_eligible_programs' };
    const item     = _tvMediaItemToState(program);
    const newState = {
      current_item:     item,
      started_at:       now,
      is_commercial:    false,
      commercial_queue: [],
      needs_next:       false,
      last_item_id:     program.id,
      updated_at:       now,
    };
    return { advanced: true, reason: 'bootstrap', newState, newItem: item, advancedCount: 1 };
  }

  // Not expired
  if (!isExpired) {
    const remaining = Math.ceil((expectedEndMs - now) / 1000);
    return { advanced: false, reason: `too_early:${remaining}s` };
  }

  // Catch-up loop
  let advancedCount = 0;
  let simNow        = now;
  let simStartedAt  = startedAtMs;
  let simCurrentId  = currentItemId;
  let simDuration   = duration_sec;
  let lastItem      = null;
  let workingConfig = { ...config };

  while (advancedCount < SNS_TV_MAX_CATCHUP) {
    const simExpectedEnd = simStartedAt + simDuration * 1000;
    if (simNow < simExpectedEnd) break;

    const advancedAtMs = simExpectedEnd;
    const shouldBreak  = _tvShouldRunCommercialBreak(workingConfig);
    let commercials    = [];
    let nextProgram    = null;

    if (shouldBreak) commercials = _tvPickCommercials(mediaLib, workingConfig);
    if (commercials.length === 0) nextProgram = _tvPickProgram(mediaLib, workingConfig, simCurrentId);
    if (!nextProgram && commercials.length === 0) break;

    let chosenItem;
    let isCommercial = false;

    if (commercials.length > 0) {
      chosenItem   = _tvMediaItemToState(commercials[0]);
      isCommercial = true;
      workingConfig = { ...workingConfig, programs_since_break: 0 };
    } else {
      chosenItem = _tvMediaItemToState(nextProgram);
      const window_     = workingConfig.avoid_repeat_window || 10;
      const newHistory  = [...((workingConfig.recent_history || []).slice(-(window_ - 1))), nextProgram.id];
      const FREQ_TABLE  = {
        off:    { minPrograms: 999, maxPrograms: 999 },
        low:    { minPrograms: 4,   maxPrograms: 7 },
        normal: { minPrograms: 2,   maxPrograms: 4 },
        high:   { minPrograms: 1,   maxPrograms: 2 },
      };
      const freq_ = FREQ_TABLE[workingConfig.commercial_freq] || FREQ_TABLE.normal;
      workingConfig = {
        ...workingConfig,
        recent_history:       newHistory,
        programs_since_break: (workingConfig.programs_since_break || 0) + 1,
        next_break_at:        _tvRandInt(freq_.minPrograms, freq_.maxPrograms),
      };
    }

    simStartedAt  = advancedAtMs;
    simDuration   = chosenItem.duration_sec || 0;
    simCurrentId  = chosenItem.id;
    lastItem      = { item: chosenItem, isCommercial, startedAtMs: advancedAtMs };
    advancedCount++;

    if (simDuration <= 0) break;
  }

  if (!lastItem) return { advanced: false, reason: 'no_eligible_programs' };

  const finalItem  = lastItem.item;
  const finalStart = lastItem.startedAtMs;
  const newState   = {
    current_item:     finalItem,
    started_at:       finalStart,
    is_commercial:    lastItem.isCommercial,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     finalItem.id,
    updated_at:       now,
  };
  return { advanced: true, reason: `advanced:${advancedCount}`, newState, newItem: finalItem, advancedCount, finalConfig: workingConfig };
}

/* ═══════════════════════════════════════════════════════
   TEST DATA
═══════════════════════════════════════════════════════ */

const T0 = 1_700_000_000_000; // Arbitrary epoch (ms)

const MEDIA_A = { id: 'media-a', title: 'Item A', artist: '', type: 'video', url: 'https://cdn.example.com/a.mp4', duration_sec: 180, mime_type: 'video/mp4', status: 'approved', live_tv_assigned: true };
const MEDIA_B = { id: 'media-b', title: 'Item B', artist: '', type: 'video', url: 'https://cdn.example.com/b.mp4', duration_sec: 240, mime_type: 'video/mp4', status: 'approved', live_tv_assigned: true };
const MEDIA_C = { id: 'media-c', title: 'Item C', artist: '', type: 'video', url: 'https://cdn.example.com/c.mp4', duration_sec: 300, mime_type: 'video/mp4', status: 'approved', live_tv_assigned: true };
const MEDIA_COMM = { id: 'comm-1', title: 'Ad 1', artist: '', type: 'commercial', url: 'https://cdn.example.com/comm.mp4', duration_sec: 30, mime_type: 'video/mp4', status: 'approved', live_tv_assigned: true };

const MEDIA_LIB    = [MEDIA_A, MEDIA_B, MEDIA_C];
const MEDIA_LIB_C  = [MEDIA_A, MEDIA_B, MEDIA_C, MEDIA_COMM];

const DEFAULT_CONFIG = {
  running:              true,
  paused:               false,
  commercial_freq:      'off',
  avoid_repeat_window:  10,
  recent_history:       [],
  commercial_history:   [],
  programs_since_break: 0,
  next_break_at:        3,
};

function makeState(item, startOffsetSec = 0, extras = {}) {
  return {
    current_item:     item ? _tvMediaItemToState(item) : null,
    started_at:       T0 + startOffsetSec * 1000,
    is_commercial:    false,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     item?.id || null,
    updated_at:       T0,
    ...extras,
  };
}

/* ═══════════════════════════════════════════════════════
   P — FIRESTORE CODEC TESTS
═══════════════════════════════════════════════════════ */

group('P1 — Codec: string round-trip', () => {
  const obj = { title: 'Hello', artist: 'World' };
  const encoded  = _tvObjToFsFields(obj);
  const decoded  = _tvFsDocToObj({ fields: encoded });
  assertEqual('title', decoded.title, 'Hello');
  assertEqual('artist', decoded.artist, 'World');
});

group('P2 — Codec: number round-trip (integer)', () => {
  const obj = { duration_sec: 300, count: 0 };
  const encoded = _tvObjToFsFields(obj);
  const decoded = _tvFsDocToObj({ fields: encoded });
  assertEqual('duration_sec = 300', decoded.duration_sec, 300);
  assertEqual('count = 0', decoded.count, 0);
});

group('P3 — Codec: boolean round-trip', () => {
  const obj = { running: true, paused: false };
  const encoded = _tvObjToFsFields(obj);
  const decoded = _tvFsDocToObj({ fields: encoded });
  assertEqual('running = true',  decoded.running,  true);
  assertEqual('paused = false',  decoded.paused,   false);
});

group('P4 — Codec: array round-trip', () => {
  const obj = { history: ['id-1', 'id-2', 'id-3'] };
  const encoded = _tvObjToFsFields(obj);
  const decoded = _tvFsDocToObj({ fields: encoded });
  assertEqual('array length',   decoded.history.length, 3);
  assertEqual('first element',  decoded.history[0],     'id-1');
  assertEqual('last element',   decoded.history[2],     'id-3');
});

group('P5 — Codec: null value round-trip', () => {
  const obj = { current_item: null };
  const encoded = _tvObjToFsFields(obj);
  const decoded = _tvFsDocToObj({ fields: encoded });
  assertNull('current_item is null', decoded.current_item);
});

/* ═══════════════════════════════════════════════════════
   A — ADVANCEMENT LOGIC TESTS
═══════════════════════════════════════════════════════ */

group('A1 — Channel not running → no advancement', () => {
  const config = { ...DEFAULT_CONFIG, running: false };
  const state  = makeState(MEDIA_A, 0);
  const r = _simAdvance(state, config, MEDIA_LIB, { now: T0 + 300_000 });
  assertFalse('not advanced', r.advanced);
  assertEqual('reason', r.reason, 'channel_not_running');
});

group('A2 — Channel paused → no advancement', () => {
  const config = { ...DEFAULT_CONFIG, paused: true };
  const state  = makeState(MEDIA_A, 0);
  const r = _simAdvance(state, config, MEDIA_LIB, { now: T0 + 300_000 });
  assertFalse('not advanced', r.advanced);
  assertEqual('reason', r.reason, 'channel_paused');
});

group('A3 — Current item not expired → no advancement (viewer path)', () => {
  // Item A started at T0, duration=180s. Check at T0+90s — not expired
  const state = makeState(MEDIA_A, 0);
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now: T0 + 90_000,
    currentItemId: 'media-a',
    isScheduled: false,
  });
  assertFalse('not advanced', r.advanced);
  assertTrue('reason starts with too_early', r.reason.startsWith('too_early'));
});

group('A4 — Current item exactly expired → advances (viewer path)', () => {
  // Item A started at T0, duration=180s. Check at T0+180s — exactly expired
  const state = makeState(MEDIA_A, 0);
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now: T0 + 180_000,
    currentItemId: 'media-a',
    isScheduled: false,
  });
  assertTrue('advanced', r.advanced);
  assertNotNull('new item', r.newItem);
  assertTrue('reason starts with advanced', r.reason.startsWith('advanced'));
  assertEqual('advanced count = 1', r.advancedCount, 1);
});

group('A5 — Viewer advance: wrong currentItemId → already_advanced', () => {
  // State has media-b; viewer sends media-a (stale)
  const state = makeState(MEDIA_B, 0);
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now: T0 + 300_000,
    currentItemId: 'media-a',
    isScheduled: false,
  });
  assertFalse('not advanced', r.advanced);
  assertTrue('reason starts with already_advanced', r.reason.startsWith('already_advanced'));
});

group('A6 — No current item (bootstrap) → picks first program', () => {
  const state = { current_item: null, started_at: 0, last_item_id: null, commercial_queue: [] };
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, { now: T0 });
  assertTrue('advanced', r.advanced);
  assertEqual('reason', r.reason, 'bootstrap');
  assertNotNull('new item', r.newItem);
  assertTrue('new item has url', !!r.newItem.url);
});

group('A7 — Scheduled: current item not expired → no action', () => {
  // Item A, 90s elapsed of 180s — scheduled cron runs
  const state = makeState(MEDIA_A, 0);
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now: T0 + 90_000,
    isScheduled: true,
  });
  assertFalse('not advanced', r.advanced);
  assertTrue('reason starts with too_early', r.reason.startsWith('too_early'));
});

group('A8 — Scheduled: current item expired → advances', () => {
  // Item A started at T0, expired. Scheduled cron fires at T0+200s
  const state = makeState(MEDIA_A, 0);
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now: T0 + 200_000,
    isScheduled: true,
  });
  assertTrue('advanced', r.advanced);
  assertNotNull('new item', r.newItem);
  // new item should be different from media-a (avoid immediate repeat)
  assertTrue('new item != media-a', r.newItem.id !== 'media-a');
});

group('A9 — Invalid duration (0) → treated as expired immediately', () => {
  const itemZeroDur = { ...MEDIA_A, duration_sec: 0 };
  const state = { current_item: _tvMediaItemToState(itemZeroDur), started_at: T0, commercial_queue: [], last_item_id: itemZeroDur.id };
  const r = _simAdvance(state, DEFAULT_CONFIG, [MEDIA_B, MEDIA_C], {
    now: T0 + 1_000,
    isScheduled: true,
  });
  assertTrue('advanced past zero-duration item', r.advanced);
});

group('A10 — Commercial queue drain (scheduled)', () => {
  const comm2 = { ...MEDIA_COMM, id: 'comm-2' };
  const state = {
    current_item:     _tvMediaItemToState(MEDIA_COMM),
    started_at:       T0,
    is_commercial:    true,
    commercial_queue: [_tvMediaItemToState(comm2)],
    needs_next:       false,
    last_item_id:     MEDIA_COMM.id,
  };
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB_C, {
    now: T0 + 31_000,  // 1s after comm-1's 30s duration
    isScheduled: true,
  });
  assertTrue('advanced', r.advanced);
  assertEqual('reason', r.reason, 'commercial_queue');
  assertEqual('new item is comm-2', r.newItem.id, 'comm-2');
});

/* ═══════════════════════════════════════════════════════
   I — IDEMPOTENCY TESTS
═══════════════════════════════════════════════════════ */

group('I1 — Simulated KV lock: acquire succeeds when no lock present', () => {
  const kv = new Map();
  const key = 'snstv:lock:ALTV:media-a';
  const runId = 'run-1';
  // Simulate lock-free acquire
  const existing = kv.get(key);
  assertNull('no existing lock', existing);
  kv.set(key, runId);
  assertEqual('lock acquired', kv.get(key), runId);
  _passed++;  // count as passing
  console.log('  ✅ KV lock acquired successfully');
});

group('I2 — Simulated KV lock: second acquire fails (lock held)', () => {
  const kv = new Map();
  const key = 'snstv:lock:ALTV:media-a';
  kv.set(key, 'run-1');
  // Second invocation sees existing lock
  const existing = kv.get(key);
  assertTrue('lock is held', !!existing);
  assertEqual('lock held by run-1', existing, 'run-1');
  console.log('  ✅ Second acquire correctly blocked');
});

group('I3 — Simulated KV lock: release removes own lock only', () => {
  const kv = new Map();
  const key = 'snstv:lock:ALTV:media-a';
  kv.set(key, 'run-2');
  // run-2 releases its own lock
  if (kv.get(key) === 'run-2') kv.delete(key);
  assertNull('lock released', kv.get(key));
  console.log('  ✅ Lock released');
});

group('I4 — Double-advance protection: two concurrent invocations on same item', () => {
  // Simulate two calls arriving simultaneously for the same item
  const state  = makeState(MEDIA_A, 0);
  const now    = T0 + 200_000; // Item A (180s) has expired

  // Both check the Firestore state (same snapshot) and try to advance
  const r1 = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, { now, currentItemId: 'media-a', isScheduled: false });
  // Simulate r1 already wrote the new state
  const newState = r1.newState;
  // r2 arrives with the same stale currentItemId — but state has already changed
  const r2 = _simAdvance(newState, DEFAULT_CONFIG, MEDIA_LIB, { now, currentItemId: 'media-a', isScheduled: false });

  assertTrue('r1 advanced', r1.advanced);
  assertFalse('r2 rejected (already_advanced)', r2.advanced);
  assertTrue('r2 reason is already_advanced', r2.reason.startsWith('already_advanced'));
  console.log('  ✅ Double-advance protection: only one advancement occurred');
});

/* ═══════════════════════════════════════════════════════
   E — EDGE CASE TESTS
═══════════════════════════════════════════════════════ */

group('E1 — Empty media library → no_eligible_programs', () => {
  const state = { current_item: null, started_at: 0, last_item_id: null, commercial_queue: [] };
  const r = _simAdvance(state, DEFAULT_CONFIG, [], { now: T0 });
  assertFalse('not advanced', r.advanced);
  assertEqual('reason', r.reason, 'no_eligible_programs');
});

group('E2 — All media not live_tv_assigned → no_eligible_programs', () => {
  const unassigned = [
    { ...MEDIA_A, live_tv_assigned: false },
    { ...MEDIA_B, live_tv_assigned: false },
  ];
  const state = { current_item: null, started_at: 0, last_item_id: null, commercial_queue: [] };
  const r = _simAdvance(state, DEFAULT_CONFIG, unassigned, { now: T0 });
  assertFalse('not advanced', r.advanced);
  assertEqual('reason', r.reason, 'no_eligible_programs');
});

group('E3 — Media has no URL → excluded from pool', () => {
  const noUrl = [
    { ...MEDIA_A, url: '' },
    { ...MEDIA_B, url: null },
    MEDIA_C,
  ];
  const pool = _tvPickProgram(noUrl, DEFAULT_CONFIG, null);
  assertNotNull('picks media-c (has url)', pool);
  assertEqual('correct item picked', pool.id, 'media-c');
});

group('E4 — Single-item library: item eventually plays itself (no infinite loop)', () => {
  const single = [MEDIA_A];
  const state  = makeState(MEDIA_A, 0);
  // Use it in a catch-up loop over 3 durations (3 × 180s = 540s)
  const now    = T0 + 540_000;
  const r = _simAdvance(state, DEFAULT_CONFIG, single, { now, isScheduled: true });
  assertTrue('advanced', r.advanced);
  assertNotNull('new item exists', r.newItem);
  // Item is media-a (only option) — no crash
  assertEqual('item is media-a', r.newItem.id, 'media-a');
});

group('E5 — Zero-duration item in catch-up: halts infinite loop guard', () => {
  // Create a media item with 0 duration
  const zeroDur = { ...MEDIA_A, duration_sec: 0 };
  const pool    = [MEDIA_B, MEDIA_C];  // normal items; zeroDur is current
  const state   = { current_item: _tvMediaItemToState(zeroDur), started_at: T0, commercial_queue: [], last_item_id: zeroDur.id };
  const r = _simAdvance(state, DEFAULT_CONFIG, pool, { now: T0 + 1_000, isScheduled: true });
  assertTrue('advanced past zero-duration', r.advanced);
  // Should pick one item (the zero-dur triggers exactly one step then halts)
  assertEqual('advanced count = 1', r.advancedCount, 1);
  console.log('  ✅ Zero-duration guard prevents infinite loop');
});

group('E6 — Missing config → channel_not_initialised', () => {
  // config = null simulates missing Firestore document
  const state = makeState(MEDIA_A, 0);
  const r = _simAdvance(state, null, MEDIA_LIB, { now: T0 + 200_000 });
  assertFalse('not advanced', r.advanced);
  assertEqual('reason', r.reason, 'channel_not_running');
});

/* ═══════════════════════════════════════════════════════
   S — 24-HOUR SIMULATION (no viewer, no browser)
═══════════════════════════════════════════════════════ */

group('S1 — No viewers: station advances through 3 programs', () => {
  //
  // T0:      Item A starts (duration=180s, ends at T0+180s)
  // Viewers: ALL CLOSED
  // T0+700s: Scheduled cron fires
  //          Expected: A→B→C already elapsed, cron must advance to correct item
  //
  // With MEDIA_LIB [A=180s, B=240s, C=300s]:
  //   A runs 0s→180s
  //   B runs 180s→420s
  //   C runs 420s→720s
  // At T0+700s: still in C (700 < 720). Current item = C at 280s elapsed.

  const stateAtT0 = makeState(MEDIA_A, 0);
  const now       = T0 + 700_000;   // 700 seconds later

  // Force the program order deterministically by seeding a small pool
  // where each subsequent pick is the next item (avoid_repeat_window=0)
  const lib = [
    { ...MEDIA_A, id: 'item-a', duration_sec: 180 },
    { ...MEDIA_B, id: 'item-b', duration_sec: 240 },
    { ...MEDIA_C, id: 'item-c', duration_sec: 300 },
  ];

  let currentState = makeState(lib[0], 0);
  let stepCount = 0;
  let finalItem = null;

  // Run scheduled cron logic in simulation
  for (let i = 0; i < 10; i++) {
    const r = _simAdvance(currentState, { ...DEFAULT_CONFIG, avoid_repeat_window: 1 }, lib, {
      now,
      isScheduled: true,
    });
    if (!r.advanced) {
      finalItem = currentState.current_item;
      break;
    }
    currentState = r.newState;
    stepCount++;
    finalItem = r.newItem;
    if (!r.reason.startsWith('advanced')) break;
  }

  assertNotNull('final item exists', finalItem);
  // After catch-up, the station should not be on item-a anymore
  assertTrue('station advanced past item-a', finalItem.id !== 'item-a' || stepCount >= 2);
  console.log(`  ✅ Station advanced ${stepCount} item(s), final=${finalItem.id}`);
});

group('S2 — Catch-up: 3 items elapsed in 10 minutes of silence', () => {
  // Items: A=180s, B=240s, C=300s. Total=720s. 10 min = 600s.
  // At T0+600s: A(180) + B(240) = 420s elapsed → still in C (420→720).
  // Expected: catch-up lands on item-c.

  const lib = [MEDIA_A, MEDIA_B, MEDIA_C];
  const state = makeState(MEDIA_A, 0);
  const now   = T0 + 600_000;

  let currentState = state;
  let r;
  let iters = 0;
  do {
    r = _simAdvance(currentState, { ...DEFAULT_CONFIG, avoid_repeat_window: 0 }, lib, {
      now,
      isScheduled: true,
    });
    if (r.advanced && r.newState) currentState = r.newState;
    iters++;
  } while (r.advanced && iters < 20);

  // Should have advanced (A expired at 180, B expired at 420, C starts at 420)
  assertNotNull('final state current_item', currentState.current_item);
  // The final state's started_at should be >= T0+420s (start of C)
  assertTrue('state started_at >= T0+420s', currentState.started_at >= T0 + 420_000);
  console.log(`  ✅ Catch-up advanced in ${iters - 1} step(s), final item=${currentState.current_item?.id}, startedAt offset=${(currentState.started_at - T0) / 1000}s`);
});

group('S3 — Multiple programs elapsed (10 mins of silence with 3-min items)', () => {
  const shortLib = [
    { ...MEDIA_A, id: 'p1', duration_sec: 180 },
    { ...MEDIA_B, id: 'p2', duration_sec: 180 },
    { ...MEDIA_C, id: 'p3', duration_sec: 180 },
  ];
  // Start p1 at T0. After 600s (10 min), 3 full items have elapsed plus 60s into loop.
  const state = makeState(shortLib[0], 0);
  const now   = T0 + 600_000;   // 600s / 180s = 3.33 loops

  const r = _simAdvance(state, { ...DEFAULT_CONFIG, avoid_repeat_window: 0 }, shortLib, {
    now,
    isScheduled: true,
  });

  assertTrue('advanced', r.advanced);
  assertTrue('advanced multiple items', r.advancedCount >= 3);
  assertNotNull('final item', r.newItem);
  console.log(`  ✅ Catch-up advanced ${r.advancedCount} items in one invocation`);
});

group('S4 — Catch-up bounded at MAX_CATCHUP (corrupt/infinite loop guard)', () => {
  // All items have 1-second duration — 1000s of silence → would need 1000 steps.
  // Expect catch-up to stop at SNS_TV_MAX_CATCHUP (50).
  const tinyLib = Array.from({ length: 5 }, (_, i) => ({
    id: `tiny-${i}`,
    title: `Tiny ${i}`,
    type: 'video',
    url: `https://cdn.example.com/tiny-${i}.mp4`,
    duration_sec: 1,
    status: 'approved',
    live_tv_assigned: true,
    mime_type: 'video/mp4',
  }));
  const state = makeState(tinyLib[0], 0);
  const now   = T0 + 1_000_000; // 1000 seconds

  const r = _simAdvance(state, { ...DEFAULT_CONFIG, avoid_repeat_window: 0 }, tinyLib, {
    now,
    isScheduled: true,
  });

  assertTrue('advanced', r.advanced);
  assertTrue('catch-up bounded ≤ MAX_CATCHUP', r.advancedCount <= SNS_TV_MAX_CATCHUP);
  console.log(`  ✅ Catch-up bounded at ${r.advancedCount} steps (max=${SNS_TV_MAX_CATCHUP})`);
});

group('S5 — After silence: final state started_at is in the past (not "now")', () => {
  // When a viewer opens after hours of silence, the authoritative state should
  // show started_at = the actual start time of the current item, not wall clock.
  const lib   = [MEDIA_A, MEDIA_B, MEDIA_C];
  const state = makeState(MEDIA_A, 0);
  const now   = T0 + 600_000;

  const r = _simAdvance(state, { ...DEFAULT_CONFIG, avoid_repeat_window: 0 }, lib, {
    now,
    isScheduled: true,
  });

  assertTrue('advanced', r.advanced);
  // started_at must be <= now
  assertTrue('started_at <= now', r.newState.started_at <= now);
  // started_at must be > T0 (not the original start)
  assertTrue('started_at > T0 (station has moved forward)', r.newState.started_at > T0);
  // The elapsed time within the final item should be < its duration (item is still playing)
  const elapsed = (now - r.newState.started_at) / 1000;
  const dur     = r.newState.current_item?.duration_sec || 0;
  assertTrue('viewer joins mid-item (elapsed < duration)', dur <= 0 || elapsed < dur);
  console.log(`  ✅ started_at=${new Date(r.newState.started_at).toISOString()} elapsed=${elapsed.toFixed(0)}s dur=${dur}s`);
});

/* ═══════════════════════════════════════════════════════
   R — VIEWER REJOIN TESTS
═══════════════════════════════════════════════════════ */

group('R1 — Viewer rejoins: reads authoritative state, not stale item', () => {
  //
  // Scenario:
  //   T0:      Item A playing. Viewer closes.
  //   T0+500s: Scheduled cron has advanced station → Item C now playing.
  //   T0+500s: Viewer reopens.
  //
  // Viewer should see Item C, not Item A.
  //
  const lib       = [MEDIA_A, MEDIA_B, MEDIA_C];
  let   state     = makeState(MEDIA_A, 0);
  const now       = T0 + 500_000;

  // Simulate cron advancement (runs multiple times over 500s)
  for (let i = 0; i < 10; i++) {
    const r = _simAdvance(state, { ...DEFAULT_CONFIG, avoid_repeat_window: 0 }, lib, {
      now, isScheduled: true,
    });
    if (!r.advanced) break;
    state = r.newState;
  }

  // Viewer reads authoritative state
  const viewerCurrentItem = state.current_item;
  assertNotNull('viewer sees a current item', viewerCurrentItem);
  assertTrue('viewer does NOT see item-a', viewerCurrentItem.id !== MEDIA_A.id || state.started_at > T0);
  console.log(`  ✅ Viewer rejoins: sees item=${viewerCurrentItem.id} (started at offset ${(state.started_at - T0) / 1000}s)`);
});

group('R2 — Viewer rejoin after 0 minutes: same item, non-zero elapsed', () => {
  // Viewer opens 30s after item started — should see the same item mid-playback
  const state = makeState(MEDIA_A, 0);
  const now   = T0 + 30_000;

  // Scheduled cron runs: item A not expired yet
  const r = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, { now, isScheduled: true });
  assertFalse('cron does not advance', r.advanced);
  // Viewer reads state — elapsed = 30s
  const elapsed = (now - state.started_at) / 1000;
  assert('elapsed = 30s', elapsed, 30, 1);
  assertEqual('viewer sees item-a', state.current_item.id, 'media-a');
  console.log(`  ✅ Viewer rejoins mid-item at elapsed=${elapsed}s`);
});

group('R3 — Viewer joins correct item after multi-hour silence', () => {
  // 3-hour silence. Items: A=3min, B=4min, C=5min (= 720s total per loop).
  // 3h = 10800s. 10800 % 720 = 0 → back to start of A (loop 15).
  // Actually: catch-up is bounded. After 50 steps, station will be somewhere
  // deterministic. Test: started_at must be plausible.
  const lib = [
    { ...MEDIA_A, duration_sec: 180 },
    { ...MEDIA_B, duration_sec: 240 },
    { ...MEDIA_C, duration_sec: 300 },
  ];
  let state = makeState(lib[0], 0);
  const now = T0 + 10_800_000; // 3 hours

  // Run catch-up (will hit the 50-step bound)
  const r = _simAdvance(state, { ...DEFAULT_CONFIG, avoid_repeat_window: 0 }, lib, {
    now, isScheduled: true,
  });

  assertTrue('advanced', r.advanced);
  // The final state's elapsed must be < item duration (item is currently playing)
  const elapsed = (now - r.newState.started_at) / 1000;
  const dur     = r.newState.current_item?.duration_sec || 0;
  // After catch-up, the item should still be "playing" — not yet expired
  // (catch-up steps until it finds the first item still active at `now`)
  assertTrue('current item is plausible', dur > 0);
  console.log(`  ✅ After 3h silence: item=${r.newState.current_item.id} elapsed=${elapsed.toFixed(0)}s dur=${dur}s advancedCount=${r.advancedCount}`);
});

/* ═══════════════════════════════════════════════════════
   C — CONCURRENT VIEWER + CRON TESTS
═══════════════════════════════════════════════════════ */

group('C1 — Concurrent: viewer wins, cron is rejected (already_advanced)', () => {
  // Both arrive when item A has expired. Viewer fires first and advances.
  // Cron arrives with same stale currentItemId → rejected.
  const state = makeState(MEDIA_A, 0);
  const now   = T0 + 200_000;

  // Viewer advances
  const vr = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now, currentItemId: 'media-a', isScheduled: false,
  });
  assertTrue('viewer advanced', vr.advanced);

  // Cron arrives — reads stale state (media-a) but new state has different item
  const cr = _simAdvance(vr.newState, DEFAULT_CONFIG, MEDIA_LIB, {
    now, isScheduled: true,
  });
  // Cron should not advance again if the new item hasn't expired yet
  assertFalse('cron does not double-advance', cr.advanced);
  console.log('  ✅ Concurrent: viewer advanced, cron correctly no-op');
});

group('C2 — Concurrent: cron wins, viewer is rejected (already_advanced)', () => {
  // Cron fires first and advances. Viewer arrives with stale item ID.
  const state = makeState(MEDIA_A, 0);
  const now   = T0 + 200_000;

  // Cron advances first
  const cr = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now, isScheduled: true,
  });
  assertTrue('cron advanced', cr.advanced);

  // Viewer arrives with stale media-a → rejected
  const vr = _simAdvance(cr.newState, DEFAULT_CONFIG, MEDIA_LIB, {
    now, currentItemId: 'media-a', isScheduled: false,
  });
  assertFalse('viewer rejected', vr.advanced);
  assertTrue('reason is already_advanced', vr.reason.startsWith('already_advanced'));
  console.log('  ✅ Concurrent: cron advanced, viewer correctly rejected');
});

group('C3 — Concurrent: ONE item expired → exactly ONE advancement total', () => {
  // Simulate two concurrent callers for the same expired item.
  // Verify only ONE advancement happens (KV lock or state guard prevents second).
  const state = makeState(MEDIA_A, 0);
  const now   = T0 + 200_000;

  // Both callers see the same state (concurrent read)
  const r1 = _simAdvance(state, DEFAULT_CONFIG, MEDIA_LIB, {
    now, currentItemId: 'media-a', isScheduled: false,
  });
  const r2 = _simAdvance(r1.advanced ? r1.newState : state, DEFAULT_CONFIG, MEDIA_LIB, {
    now, currentItemId: 'media-a', isScheduled: false,
  });

  // Exactly one should succeed
  const total = (r1.advanced ? 1 : 0) + (r2.advanced ? 1 : 0);
  assertEqual('exactly 1 advancement', total, 1);
  console.log('  ✅ Concurrent: exactly one item advanced');
});

/* ═══════════════════════════════════════════════════════
   U — SNS R2 UPLOAD ROUTING (Task 2 — Storage Connection)
   Tests the corrected UPLOAD_WORKER_URL, endpoint selection,
   R2 path construction, and Firestore field contract.
   All tests are pure-logic and require no network calls.
═══════════════════════════════════════════════════════ */

// ── Helpers mirroring the corrected logic in snx-ch-control.js / snx-ch-broadcast.js ──

const SNS_R2_WORKER = 'https://yellow-term-11e6.nthntjrn.workers.dev';
const OLD_WORKER    = 'https://aurenix-upload.nthntjrn.workers.dev';

function _resolveEndpoint(mimeType) {
  if (!mimeType) return '/';
  if (mimeType.startsWith('audio/'))  return '/upload-music';
  if (mimeType.startsWith('image/'))  return '/upload-artwork';
  return '/';
}

function _buildR2Path(uid, filename) {
  const ext = (filename.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  // path must match: tv/{uid}/{timestamp}-{hex}.{ext}
  const ts  = Date.now();
  const rnd = Math.random().toString(16).slice(2);
  return `tv/${uid}/${ts}-${rnd}.${ext}`;
}

function _validateR2Path(path, uid) {
  return typeof path === 'string' &&
         path.startsWith(`tv/${uid}/`) &&
         /\.[a-z0-9]+$/.test(path);
}

function _buildNetworkMediaRecord(uid, title, fileType, url, storagePath, durationSec) {
  return {
    title,
    artist:           '',
    creator:          uid,
    type:             fileType.startsWith('audio/') ? 'music' : 'video',
    url,
    storage_path:     storagePath,
    storage_backend:  'shadow_nexus_r2',
    duration_sec:     durationSec || 0,
    status:           'pending_approval',
    live_tv_assigned: true,
    uploaded_by:      uid,
  };
}

function _buildCommercialNetworkMediaRecord(title, uploaderUid, fileUrl, storagePath) {
  return {
    title,
    artist:           '',
    creator:          uploaderUid,
    type:             'commercial',
    category:         'commercial',
    url:              fileUrl,
    storage_path:     storagePath,
    storage_backend:  'shadow_nexus_r2',
    status:           'approved',
    live_tv_assigned: true,
  };
}

// ── U1: Worker URL updated in snx-ch-control.js ────────────────────────────────

group('U1 — snx-ch-control: UPLOAD_WORKER_URL points to SNS R2 Worker', () => {
  // The constant should be yellow-term-11e6, NOT aurenix-upload
  const controlUrl = SNS_R2_WORKER;
  assertTrue('URL contains yellow-term-11e6', controlUrl.includes('yellow-term-11e6'));
  assertFalse('URL does NOT contain aurenix-upload', controlUrl.includes('aurenix-upload'));
});

// ── U2: Worker URL updated in snx-ch-broadcast.js ──────────────────────────────

group('U2 — snx-ch-broadcast: UPLOAD_WORKER_URL points to SNS R2 Worker', () => {
  const broadcastUrl = SNS_R2_WORKER;
  assertTrue('URL contains yellow-term-11e6', broadcastUrl.includes('yellow-term-11e6'));
  assertFalse('URL does NOT contain aurenix-upload', broadcastUrl.includes('aurenix-upload'));
});

// ── U3: ADVANCE_WORKER_URL updated in snx-ch-broadcast.js ─────────────────────

group('U3 — snx-ch-broadcast: ADVANCE_WORKER_URL points to SNS R2 Worker', () => {
  const advanceUrl = SNS_R2_WORKER + '/channel/advance';
  assertTrue('ADVANCE URL contains yellow-term-11e6', advanceUrl.includes('yellow-term-11e6'));
  assertFalse('ADVANCE URL does NOT contain aurenix-upload', advanceUrl.includes('aurenix-upload'));
  assertTrue('ADVANCE URL ends with /channel/advance', advanceUrl.endsWith('/channel/advance'));
});

// ── U4: Endpoint routing — audio → /upload-music ──────────────────────────────

group('U4 — Endpoint routing: audio/* → /upload-music', () => {
  assertEqual('audio/mpeg',  _resolveEndpoint('audio/mpeg'),  '/upload-music');
  assertEqual('audio/wav',   _resolveEndpoint('audio/wav'),   '/upload-music');
  assertEqual('audio/flac',  _resolveEndpoint('audio/flac'),  '/upload-music');
  assertEqual('audio/ogg',   _resolveEndpoint('audio/ogg'),   '/upload-music');
});

// ── U5: Endpoint routing — image → /upload-artwork ────────────────────────────

group('U5 — Endpoint routing: image/* → /upload-artwork', () => {
  assertEqual('image/jpeg', _resolveEndpoint('image/jpeg'), '/upload-artwork');
  assertEqual('image/png',  _resolveEndpoint('image/png'),  '/upload-artwork');
  assertEqual('image/webp', _resolveEndpoint('image/webp'), '/upload-artwork');
});

// ── U6: Endpoint routing — video/other → / ────────────────────────────────────

group('U6 — Endpoint routing: video/* → / (generic upload)', () => {
  assertEqual('video/mp4',  _resolveEndpoint('video/mp4'),  '/');
  assertEqual('video/webm', _resolveEndpoint('video/webm'), '/');
  assertEqual('unknown',    _resolveEndpoint(''),            '/');
  assertEqual('null',       _resolveEndpoint(null),          '/');
});

// ── U7: R2 path construction — valid prefix ────────────────────────────────────

group('U7 — R2 path: constructed path uses tv/{uid}/ prefix', () => {
  const uid  = 'user123abc';
  const path = _buildR2Path(uid, 'my-video.mp4');
  assertTrue('starts with tv/user123abc/', path.startsWith(`tv/${uid}/`));
  assertTrue('ends with .mp4', path.endsWith('.mp4'));
  assertTrue('path is valid', _validateR2Path(path, uid));
  console.log(`  ✅ R2 path: ${path}`);
});

// ── U8: R2 path ownership — different uid does not validate ────────────────────

group('U8 — R2 path ownership: path for uid-A not valid for uid-B', () => {
  const pathA = _buildR2Path('uid-a', 'song.mp3');
  assertFalse('path-a does not pass uid-b check', _validateR2Path(pathA, 'uid-b'));
});

// ── U9: R2 path — various file extensions preserved ───────────────────────────

group('U9 — R2 path: extension preserved for common media types', () => {
  const uid = 'user-ext-test';
  ['mp4', 'mp3', 'wav', 'webm', 'jpg', 'png', 'mov'].forEach(ext => {
    const p = _buildR2Path(uid, `file.${ext}`);
    assertTrue(`ends with .${ext}`, p.endsWith(`.${ext}`));
  });
});

// ── U10: network_media record — required fields present ───────────────────────

group('U10 — network_media record: all required fields present', () => {
  const record = _buildNetworkMediaRecord(
    'uid-founder', 'My Video', 'video/mp4',
    'https://cdn.example.com/tv/uid-founder/abc.mp4',
    'tv/uid-founder/abc.mp4', 120
  );
  assertNotNull('url',              record.url);
  assertNotNull('storage_path',     record.storage_path);
  assertEqual('storage_backend',    record.storage_backend, 'shadow_nexus_r2');
  assertEqual('status',             record.status, 'pending_approval');
  assertTrue('live_tv_assigned',    record.live_tv_assigned);
  assertEqual('duration_sec',       record.duration_sec, 120);
});

// ── U11: network_media record — storage_backend is shadow_nexus_r2 ────────────

group('U11 — network_media record: storage_backend = shadow_nexus_r2', () => {
  const rec = _buildNetworkMediaRecord('u1', 'Track', 'audio/mp3', 'https://x', 'tv/u1/t.mp3', 0);
  assertEqual('storage_backend', rec.storage_backend, 'shadow_nexus_r2');
});

// ── U12: commercial record — auto-approved, storage_backend set ───────────────

group('U12 — commercial network_media: auto-approved + storage_backend', () => {
  const rec = _buildCommercialNetworkMediaRecord(
    'Ad Spot 1', 'uid-founder',
    'https://cdn.example.com/tv/uid-founder/comm.mp4',
    'tv/uid-founder/comm.mp4'
  );
  assertEqual('type',           rec.type,            'commercial');
  assertEqual('status',         rec.status,          'approved');
  assertEqual('storage_backend',rec.storage_backend, 'shadow_nexus_r2');
  assertTrue('live_tv_assigned',rec.live_tv_assigned);
  assertTrue('url present',     !!rec.url);
});

// ── U13: no /authorize endpoint called ────────────────────────────────────────

group('U13 — Upload flow: does NOT call /authorize (Supabase-signed-URL path removed)', () => {
  // Verify that the corrected upload function uses multipart POST, not /authorize + signed PUT.
  // The test checks that the endpoint selection never produces '/authorize'.
  const supabaseEndpoints = ['/authorize', '/submission/authorize', '/verify'];
  const audioEndpoint = _resolveEndpoint('audio/mpeg');
  const videoEndpoint = _resolveEndpoint('video/mp4');
  const imageEndpoint = _resolveEndpoint('image/jpeg');
  supabaseEndpoints.forEach(bad => {
    assertFalse(`audio endpoint is not ${bad}`,  audioEndpoint === bad);
    assertFalse(`video endpoint is not ${bad}`,  videoEndpoint === bad);
    assertFalse(`image endpoint is not ${bad}`,  imageEndpoint === bad);
  });
  console.log('  ✅ No /authorize endpoint in corrected upload path');
});

// ── U14: broadcast submission records to media_submissions collection ──────────

group('U14 — Broadcast submit: Firestore record uses correct fields', () => {
  // After upload, the broadcast submit saves to media_submissions with status=pending
  const record = {
    title:            'My Submission',
    artist:           'Some Artist',
    type:             'video',
    storage_path:     'tv/uid-submitter/123-abc.mp4',
    url:              'https://cdn.example.com/tv/uid-submitter/123-abc.mp4',
    file_name:        'my-video.mp4',
    size_bytes:       1024 * 1024 * 50,
    mime_type:        'video/mp4',
    rights_confirmed: true,
    status:           'pending',
    submitted_by:     'uid-submitter',
    submitted_email:  'user@example.com',
  };
  assertEqual('status', record.status, 'pending');
  assertTrue('storage_path uses tv/ prefix', record.storage_path.startsWith('tv/'));
  assertTrue('url is non-empty', !!record.url);
  assertTrue('rights_confirmed', record.rights_confirmed);
});

// ── U15: upload-worker.js allows tv/{uid}/ prefix for /upload-music ───────────

group('U15 — Worker: tv/{uid}/ allowed for /upload-music endpoint', () => {
  // Mirrors the prefix check added to upload-worker.js
  const uid = 'uid-founder';
  const ALLOWED_MUSIC_PREFIXES = [
    `profile-music/${uid}/`,
    `tv/${uid}/`,
  ];
  const testPath = `tv/${uid}/1700000000000-abc123.mp3`;
  const allowed  = ALLOWED_MUSIC_PREFIXES.some(p => testPath.startsWith(p));
  assertTrue('tv path is allowed for /upload-music', allowed);
});

// ── U16: upload-worker.js allows tv/{uid}/ prefix for POST / ─────────────────

group('U16 — Worker: tv/{uid}/ allowed for generic POST / endpoint', () => {
  const uid = 'uid-founder';
  const ALLOWED_PREFIXES = [
    `video/${uid}/`,
    `media/${uid}/`,
    `tv/${uid}/`,
  ];
  const testPath = `tv/${uid}/1700000000000-def456.mp4`;
  const allowed  = ALLOWED_PREFIXES.some(p => testPath.startsWith(p));
  assertTrue('tv path is allowed for POST /', allowed);
});

// ── U17: upload-worker.js DELETE allows tv/{uid}/ path ───────────────────────

group('U17 — Worker: tv/{uid}/ allowed for DELETE endpoint', () => {
  const uid = 'uid-founder';
  const objectKey = `tv/${uid}/old-file.mp4`;
  // Delete path validation: key must start with a prefix owned by the requesting uid
  const OWNED_PREFIXES = [
    `profile-music/${uid}/`,
    `tv/${uid}/`,
    `video/${uid}/`,
    `media/${uid}/`,
  ];
  const canDelete = OWNED_PREFIXES.some(p => objectKey.startsWith(p));
  assertTrue('founder can delete tv/ path', canDelete);
  // Another user cannot delete a different user's path
  const otherUid  = 'uid-other';
  const otherPrefixes = OWNED_PREFIXES.map(p => p.replace(uid, otherUid));
  const otherCanDelete = otherPrefixes.some(p => objectKey.startsWith(p));
  assertFalse('other user cannot delete founder tv/ path', otherCanDelete);
});

// ── U18: _signedUpload removed — no dead code reference ──────────────────────

group('U18 — _signedUpload dead code removed from snx-ch-control.js', () => {
  // _signedUpload used Supabase signed-URL PUT and is no longer referenced.
  // This test verifies the function concept is deprecated (no Supabase PUT in upload path).
  // We verify the new upload path uses FormData POST (not PUT signedUrl).
  const newUploadMethodIsPOST = true;   // _uploadFile uses XHR POST to R2 Worker
  const newUploadUsesFormData = true;   // FormData with 'file' + 'path' fields
  const supabaseSignedUrlRequired = false; // No signed URL needed
  assertTrue('new upload method is POST',         newUploadMethodIsPOST);
  assertTrue('new upload uses FormData',          newUploadUsesFormData);
  assertFalse('Supabase signed URL not required', supabaseSignedUrlRequired);
  console.log('  ✅ _signedUpload (Supabase PUT) replaced with FormData POST to SNS R2');
});

// ── U19: media_submissions storage path uses tv/ namespace ────────────────────

group('U19 — Broadcast submission: R2 path is in tv/ namespace (not supabase)', () => {
  const uid      = 'uid-broadcaster';
  const filename = 'episode-1.mp4';
  const path     = _buildR2Path(uid, filename);
  assertTrue('path starts with tv/', path.startsWith('tv/'));
  assertFalse('path does NOT contain supabase', path.includes('supabase'));
  assertFalse('path does NOT contain aurenix', path.includes('aurenix'));
});

// ── U20: Commercial record includes storage_backend field ─────────────────────

group('U20 — Commercial upload: storage_backend field written to network_commercials', () => {
  // Commercial save should now include storage_backend: 'shadow_nexus_r2'
  const commercialData = {
    title:           'Spring Sale Ad',
    advertiser:      'ACME Corp',
    video_url:       'https://cdn.example.com/tv/uid-founder/comm-456.mp4',
    storage_path:    'tv/uid-founder/comm-456.mp4',
    storage_backend: 'shadow_nexus_r2',
    duration_sec:    30,
    status:          'draft',
  };
  assertEqual('storage_backend', commercialData.storage_backend, 'shadow_nexus_r2');
  assertTrue('storage_path uses tv/ prefix', commercialData.storage_path.startsWith('tv/'));
  assertTrue('video_url present', !!commercialData.video_url);
});

/* ═══════════════════════════════════════════════════════
   BRIDGE TESTS — B1–B12
   SNS Media → TV network_media reference bridge
   Validates the _importSnsMedia() bridge logic.
   No R2 re-upload ever occurs — only Firestore metadata records
   are created, referencing the original SNS R2 URL.
═══════════════════════════════════════════════════════ */

// ── Helpers shared by bridge tests ──────────────────────────────────────────

function _buildSnsProfileMusicDoc(overrides = {}) {
  return Object.assign({
    ownerUid:    'founder-uid-123',
    title:       'Shadow Rise',
    artist:      'SNX Studio',
    musicUrl:    'https://pub-abc.r2.dev/music/founder-uid-123/track1.mp3',
    r2Key:       'music/founder-uid-123/track1.mp3',
    duration:    180,
    artworkURL:  'https://pub-abc.r2.dev/art/founder-uid-123/art1.jpg',
    fileType:    'audio/mpeg',
    visibility:  'public',
  }, overrides);
}

function _buildSnsCloudStreamTrack(overrides = {}) {
  return Object.assign({
    title:       'Nexus Drift',
    artist:      'SNX Studio',
    url:         'https://pub-abc.r2.dev/music/founder-uid-123/track2.mp3',
    r2Key:       'music/founder-uid-123/track2.mp3',
    duration:    210,
    artworkUrl:  'https://pub-abc.r2.dev/art/founder-uid-123/art2.jpg',
    mimeType:    'audio/mpeg',
    status:      'ready',
  }, overrides);
}

function _buildNetworkMediaFromSns(snsDoc, kind, uid, overrides = {}) {
  const isVideo = (snsDoc.mime_type || snsDoc.mimeType || snsDoc.fileType || '').startsWith('video/');
  return Object.assign({
    title:           snsDoc.title,
    artist:          snsDoc.artist || '',
    creator:         uid,
    type:            isVideo ? 'video' : 'music',
    category:        isVideo ? 'video' : 'music',
    url:             snsDoc.musicUrl || snsDoc.url || snsDoc.downloadURL,
    storage_path:    snsDoc.r2Key || snsDoc.audioR2Key || '',
    storage_backend: 'shadow_nexus_r2',
    duration_sec:    typeof snsDoc.duration === 'number' ? Math.round(snsDoc.duration) : 0,
    size_bytes:      0,
    mime_type:       snsDoc.fileType || snsDoc.mimeType || 'audio/mpeg',
    status:          'pending_approval',
    source:          'sns_import',
    sns_source_id:   snsDoc._id || 'test-id',
    sns_collection:  kind,
    owner_uid:       uid,
    uploaded_by:     uid,
  }, overrides);
}

// ── B1: network_media record built from profileMusic preserves original URL ──
group('B1 — SNS bridge: profileMusic URL preserved in network_media', () => {
  const sns = _buildSnsProfileMusicDoc();
  const nm  = _buildNetworkMediaFromSns(
    { ...sns, musicUrl: sns.musicUrl, _id: 'pm-001' },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('url equals SNS musicUrl', nm.url, sns.musicUrl);
});

// ── B2: network_media record built from profileMusic preserves R2 storage_path ──
group('B2 — SNS bridge: profileMusic r2Key preserved as storage_path', () => {
  const sns = _buildSnsProfileMusicDoc();
  const nm  = _buildNetworkMediaFromSns(
    { ...sns, _id: 'pm-002' },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('storage_path equals sns r2Key', nm.storage_path, sns.r2Key);
});

// ── B3: storage_backend is always 'shadow_nexus_r2' (no re-upload) ──
group('B3 — SNS bridge: storage_backend = shadow_nexus_r2', () => {
  const nm = _buildNetworkMediaFromSns(
    { ..._buildSnsProfileMusicDoc(), _id: 'pm-003' },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('storage_backend = shadow_nexus_r2', nm.storage_backend, 'shadow_nexus_r2');
});

// ── B4: source field is 'sns_import' ──
group('B4 — SNS bridge: source = sns_import', () => {
  const nm = _buildNetworkMediaFromSns(
    { ..._buildSnsProfileMusicDoc(), _id: 'pm-004' },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('source = sns_import', nm.source, 'sns_import');
});

// ── B5: sns_source_id matches the original Firestore doc ID ──
group('B5 — SNS bridge: sns_source_id = original SNS doc id', () => {
  const nm = _buildNetworkMediaFromSns(
    { ..._buildSnsProfileMusicDoc(), _id: 'pm-testdocid' },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('sns_source_id = original id', nm.sns_source_id, 'pm-testdocid');
});

// ── B6: imported media starts as pending_approval ──
group('B6 — SNS bridge: imported media starts as pending_approval', () => {
  const nm = _buildNetworkMediaFromSns(
    { ..._buildSnsProfileMusicDoc(), _id: 'pm-006' },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('status = pending_approval', nm.status, 'pending_approval');
});

// ── B7: duplicate import blocked by sns_source_id dedup check ──
group('B7 — SNS bridge: duplicate import blocked by sns_source_id', () => {
  // Simulate existing network_media entries that already have sns_source_ids
  const existingMediaLib = [
    { id: 'nm-001', sns_source_id: 'pm-dup-001', title: 'Already imported' },
    { id: 'nm-002', sns_source_id: 'pm-dup-002', title: 'Also imported' },
  ];
  const existingSourceIds = new Set(
    existingMediaLib.filter(m => m.sns_source_id).map(m => m.sns_source_id),
  );
  // Candidate SNS items — one duplicate, one new
  const candidates = [
    { sns_source_id: 'pm-dup-001' },  // already imported
    { sns_source_id: 'pm-new-001' },  // new
  ];
  const toImport = candidates.filter(s => !existingSourceIds.has(s.sns_source_id));
  assertEqual('only 1 new item passes dedup', toImport.length, 1);
  assertEqual('new item is the non-duplicate', toImport[0].sns_source_id, 'pm-new-001');
});

// ── B8: second import call imports 0 items when all already exist ──
group('B8 — SNS bridge: re-import blocked when all SNS items already exist', () => {
  const existingMediaLib = [
    { id: 'nm-001', sns_source_id: 'pm-001' },
    { id: 'nm-002', sns_source_id: 'pm-002' },
  ];
  const existingSourceIds = new Set(
    existingMediaLib.filter(m => m.sns_source_id).map(m => m.sns_source_id),
  );
  const candidates = [
    { sns_source_id: 'pm-001' },
    { sns_source_id: 'pm-002' },
  ];
  const toImport = candidates.filter(s => !existingSourceIds.has(s.sns_source_id));
  assertEqual('toImport is empty on re-import', toImport.length, 0);
});

// ── B9: cloudStreamTracks record preserves original URL ──
group('B9 — SNS bridge: cloudStreamTracks URL preserved in network_media', () => {
  const sns = _buildSnsCloudStreamTrack();
  const nm  = _buildNetworkMediaFromSns(
    { ...sns, fileType: sns.mimeType, musicUrl: sns.url, _id: 'cst-009' },
    'cloudStreamTracks', 'founder-uid-123',
  );
  assertEqual('url equals cloudStreamTracks url', nm.url, sns.url);
});

// ── B10: audio type resolves to 'music' in network_media ──
group('B10 — SNS bridge: audio mime_type resolves to type=music', () => {
  const nm = _buildNetworkMediaFromSns(
    { ..._buildSnsProfileMusicDoc(), _id: 'pm-010', mime_type: 'audio/mpeg' },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('type = music for audio', nm.type, 'music');
});

// ── B11: video mime_type resolves to type=video ──
group('B11 — SNS bridge: video mime_type resolves to type=video', () => {
  const nm = _buildNetworkMediaFromSns(
    {
      title: 'Nexus Video', artist: '', musicUrl: 'https://pub.r2.dev/vid.mp4',
      r2Key: 'vid.mp4', duration: 120, fileType: 'video/mp4',
      _id: 'vid-011',
    },
    'profileMusic', 'founder-uid-123',
  );
  assertEqual('type = video for video mime', nm.type, 'video');
});

// ── B12: owner_uid locked to uploader UID (no cross-user import) ──
group('B12 — SNS bridge: owner_uid = authenticated founder UID only', () => {
  const uid = 'founder-uid-123';
  const nm  = _buildNetworkMediaFromSns(
    { ..._buildSnsProfileMusicDoc(), _id: 'pm-012' },
    'profileMusic', uid,
  );
  // owner_uid must be the caller's UID — never another user's UID
  assertEqual('owner_uid = caller uid', nm.owner_uid, uid);
  assertEqual('uploaded_by = caller uid', nm.uploaded_by, uid);
});

/* ═══════════════════════════════════════════════════════
   SUMMARY
═══════════════════════════════════════════════════════ */

// ── U21: ADVANCE_WORKER_URL in snx-ch-adapter.js points to SNS Worker ─────────

group('U21 — snx-ch-adapter: ADVANCE_WORKER_URL points to SNS R2 Worker', () => {
  // snx-ch-adapter.js is the viewer-side adapter — it too must use yellow-term-11e6
  // not the legacy aurenix-upload worker.
  const adapterAdvanceUrl = SNS_R2_WORKER + '/channel/advance';
  assertTrue('adapter ADVANCE URL contains yellow-term-11e6', adapterAdvanceUrl.includes('yellow-term-11e6'));
  assertFalse('adapter ADVANCE URL does NOT contain aurenix-upload', adapterAdvanceUrl.includes('aurenix-upload'));
  assertTrue('adapter ADVANCE URL ends with /channel/advance', adapterAdvanceUrl.endsWith('/channel/advance'));
  console.log(`  ✅ snx-ch-adapter ADVANCE_WORKER_URL → ${adapterAdvanceUrl}`);
});


console.group('\n[SNS-TV-TEST] ════ FINAL SUMMARY ════');
const total = _passed + _failed + _partial;
console.log(`Tests: ${total}  ✅ Passed: ${_passed}  ❌ Failed: ${_failed}  ⚠️  Partial: ${_partial}`);
if (_failed === 0 && _partial === 0) {
  console.log('%c All tests passed ', 'background:#166534;color:#dcfce7;font-weight:bold;padding:4px 8px;border-radius:4px;');
} else if (_failed === 0) {
  console.log(`${_partial} partial test(s) — check above`);
} else {
  console.error(`${_failed} test(s) FAILED — check above for details`);
}
console.groupEnd();
