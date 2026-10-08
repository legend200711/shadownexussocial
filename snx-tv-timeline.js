/**
 * snx-tv-timeline.js
 * Shadow Nexus Social — 24-Hour TV
 * Stage 4: Authoritative TV Timeline Resolver — Hardened
 * Build: SNS-2026-TV-STAGE4-001
 *
 * Architecture:
 *
 *   Firestore (tv_schedule, tv_programs, tv_playlists, tv_media)
 *       ↓
 *   SNXTVTimeline  ←  ONE authoritative resolver
 *       ↓
 *   resolve(now)  →  { program, item, offset, next, queue, upcoming }
 *       ↓
 *   window.SNXTV (TV Core) — loadItem + seek
 *   TV Guide
 *   Now Playing
 *   Up Next
 *
 * Key principles:
 *   - ALL viewers calculate the same timeline from schedule + wall clock
 *   - No independent clocks; no separate queues
 *   - join-in-progress: seek to correct offset on first load / refresh
 *   - Live Firestore subscriptions — schedule changes trigger recalculation
 *   - Clock drift resync every 30 s (soft), immediate resync on end-of-media
 *
 * EXPOSES: window.SNXTVTimeline
 */

'use strict';

(function (global) {

/* ════════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════ */

const VERSION           = 'SNS-2026-TV-STAGE6-001';
const COLL_SCHEDULE     = 'tv_schedule';
const COLL_PROGRAMS     = 'tv_programs';
const COLL_PLAYLISTS    = 'tv_playlists';
const COLL_MEDIA        = 'tv_media';
const COLL_TV_SETTINGS  = 'tv_settings';
const COLL_TV_CHANNELS  = 'tv_channels';

/** Tolerance (seconds) before we seek to correct drift */
const DRIFT_TOLERANCE   = 8;
/** How often to check for drift (ms) */
const RESYNC_INTERVAL   = 30000;
/** Gap message shown when no schedule entry covers current time */
const GAP_LABEL         = 'Programming Resumes Soon';

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */

/** Live schedule array  — [{id, programId, startTime(ms), enabled, channelId, ...}] */
let _schedule   = [];
/** Live programs cache  — {programId: {id, name, sourceType, sourceRef, duration, channelId, ...}} */
let _programs   = {};
/** Live playlists cache — {plId: {id, name, items:[{mediaId}], channelId, ...}} */
let _playlists  = {};
/** Live tv_media cache  — {mediaId: {id, title, mediaType, mediaUrl, artworkUrl, duration}}
 *  NOTE: tv_media is a SHARED library — not channel-specific.
 */
let _media      = {};
/** Live channels cache — {channelId: {id, name, description, artworkUrl, status, ...}} */
let _channels   = {};

/** Firestore unsub handles */
let _unsubSchedule  = null;
let _unsubPrograms  = null;
let _unsubPlaylists = null;
let _unsubMedia     = null;
let _unsubSettings  = null;
let _unsubChannels  = null;

/** Channel settings cache — keyed by channelId: { fallbackMode, fallbackPlaylistId, ... }
 *  For the default (legacy) channel, key is 'default'.
 */
let _settingsMap    = {};
/** Active channel settings (alias for the current channel) */
let _settings       = {};

/**
 * The currently active channel ID.
 * null = default channel (all docs without channelId field = backward compat).
 * 'default' = same as null (the original single-channel setup).
 */
let _activeChannelId = null;

/** Resync interval handle */
let _resyncTimer    = null;

/** Whether live listeners are active */
let _listening      = false;

/** Subscribers for timeline state changes */
let _subscribers    = [];

/** Last resolved timeline state (for change detection) */
let _lastResolved   = null;

/* ════════════════════════════════════════════════════════════
   FIREBASE HELPERS
════════════════════════════════════════════════════════════ */

function _fs() { return global._snxFirestore || {}; }
function _db() { const f = _fs(); return f.db || global._snxDb || null; }
function _isFounder() { return (global._snxRole || '') === 'founder'; }

/* ════════════════════════════════════════════════════════════
   CHANNEL HELPERS
════════════════════════════════════════════════════════════ */

/**
 * Returns true if a Firestore doc belongs to the active channel.
 * Backward compatibility: docs without channelId belong to the default channel.
 * @param {Object} doc  — must have optional .channelId field
 */
function _belongsToActiveChannel(doc) {
  const id = _activeChannelId || 'default';
  const docChannel = doc.channelId || 'default';
  return docChannel === id;
}

/**
 * Switch the active channel.  Tears down listeners and restarts them for the new channel.
 * @param {string|null} channelId  — null / 'default' = original single-channel
 */
function setChannel(channelId) {
  const newId = channelId || 'default';
  if ((_activeChannelId || 'default') === newId) return;
  _activeChannelId = newId === 'default' ? null : newId;

  // Update the active settings from the settings map
  _settings = _settingsMap[_activeChannelId || 'default'] || {};

  // Restart listeners to pick up the new channel's filtered data
  stopListening();
  startListening();

  // Notify subscribers so the viewer re-resolves the new channel
  _notifySubscribers();
  console.log('[SNXTV-TL] Channel switched to:', _activeChannelId || 'default');
}

/**
 * Return all available channels (from tv_channels collection).
 * Always includes a virtual "default" channel representing the original SNS TV.
 * @returns {Array}
 */
function getChannels() {
  const list = Object.values(_channels);
  // Always ensure the default channel appears first
  const hasDefault = list.some(c => c.id === 'default');
  const defaultChannel = {
    id: 'default', name: 'Shadow Nexus TV', description: '24-Hour TV', artworkUrl: '', status: 'active'
  };
  return hasDefault ? list : [defaultChannel, ...list];
}

/* ════════════════════════════════════════════════════════════
   FIRESTORE TIMESTAMP → ms
════════════════════════════════════════════════════════════ */

function _tsToMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.seconds) return v.seconds * 1000 + (v.nanoseconds || 0) / 1e6;
  if (v.toMillis) return v.toMillis();
  return 0;
}

/* ════════════════════════════════════════════════════════════
   DURATION HELPERS
════════════════════════════════════════════════════════════ */

/**
 * Calculate the total duration (seconds) of a program.
 * For media programs: the media item duration.
 * For playlist programs: sum of all valid media item durations.
 * Returns { duration, hasUnknown } — hasUnknown if any item is missing duration.
 */
function _calcProgramDuration(program) {
  if (!program) return { duration: 0, hasUnknown: true };

  if (program.sourceType === 'media') {
    const m = _media[program.sourceRef];
    if (!m) return { duration: 0, hasUnknown: true };
    const d = m.duration || 0;
    return { duration: d, hasUnknown: d <= 0 };
  }

  if (program.sourceType === 'playlist') {
    const pl = _playlists[program.sourceRef];
    if (!pl) return { duration: 0, hasUnknown: true };
    let total = 0;
    let hasUnknown = false;
    for (const item of (pl.items || [])) {
      const m = _media[item.mediaId];
      if (!m || !m.mediaUrl) continue; // skip unavailable
      const d = m.duration || 0;
      if (d <= 0) { hasUnknown = true; continue; }
      total += d;
    }
    return { duration: total, hasUnknown };
  }

  return { duration: 0, hasUnknown: true };
}

/* ════════════════════════════════════════════════════════════
   BUILD FLAT ITEM LIST FOR A PROGRAM
   Returns [{mediaId, title, mediaType, mediaUrl, artwork, duration}]
   Invalid items (no URL) are skipped.
════════════════════════════════════════════════════════════ */

function _programItems(program) {
  if (!program) return [];

  if (program.sourceType === 'media') {
    const m = _media[program.sourceRef];
    if (!m || !m.mediaUrl) return [];
    return [{
      id:        m.id,
      title:     m.title || 'Untitled',
      artist:    m.artist || '',
      mediaType: m.mediaType || 'video',
      mediaUrl:  m.mediaUrl,
      artwork:   m.artworkUrl || '',
      duration:  m.duration || 0,
    }];
  }

  if (program.sourceType === 'playlist') {
    const pl = _playlists[program.sourceRef];
    if (!pl) return [];
    const out = [];
    for (const item of (pl.items || [])) {
      const m = _media[item.mediaId];
      if (!m || !m.mediaUrl) continue;
      out.push({
        id:        m.id,
        title:     m.title || 'Untitled',
        artist:    m.artist || '',
        mediaType: m.mediaType || 'video',
        mediaUrl:  m.mediaUrl,
        artwork:   m.artworkUrl || '',
        duration:  m.duration || 0,
      });
    }
    return out;
  }

  return [];
}

/* ════════════════════════════════════════════════════════════
   ACTIVE SCHEDULE — sorted, enabled entries with computed endTime
════════════════════════════════════════════════════════════ */

function _activeSchedule() {
  const out = [];
  for (const entry of _schedule) {
    if (entry.enabled === false) continue;
    // ── Channel isolation: only include entries belonging to the active channel ──
    if (!_belongsToActiveChannel(entry)) continue;
    const prog = _programs[entry.programId];
    if (!prog) continue;
    const startMs = _tsToMs(entry.startTime);
    if (!startMs) continue;
    // scheduledDuration overrides the sum-of-media calculation.
    // This is the PROGRAM BLOCK duration set by the studio — independent of media length.
    const scheduledDuration = (typeof entry.scheduledDuration === 'number' && entry.scheduledDuration > 0)
      ? entry.scheduledDuration
      : null;
    const { duration: mediaDuration } = _calcProgramDuration(prog);
    // Effective duration: prefer scheduled, then fall back to media-derived.
    const duration = scheduledDuration !== null ? scheduledDuration : mediaDuration;
    out.push({
      entry,
      program:          prog,
      startMs,
      endMs:            startMs + duration * 1000,
      duration,
      scheduledDuration, // non-null when the studio set an explicit block duration
      mediaDuration,
    });
  }
  // Sort by start time ascending
  out.sort((a, b) => a.startMs - b.startMs);
  return out;
}

/* ════════════════════════════════════════════════════════════
   CONFLICT DETECTION
   Returns array of conflict pairs: [{a, b}]
════════════════════════════════════════════════════════════ */

function detectConflicts() {
  const slots = _activeSchedule();
  const conflicts = [];
  for (let i = 0; i < slots.length - 1; i++) {
    const a = slots[i];
    const b = slots[i + 1];
    if (b.startMs < a.endMs) {
      conflicts.push({ a, b });
    }
  }
  return conflicts;
}

/* ════════════════════════════════════════════════════════════
   CORE RESOLVER
   Given nowMs (wall clock), returns the authoritative TV state.
════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} TimelineState
 * @property {'playing'|'gap'|'noSchedule'} mode
 * @property {Object|null}  scheduleEntry  — the active tv_schedule entry
 * @property {Object|null}  program        — the active tv_program
 * @property {Object|null}  currentItem    — the TVItem currently on air
 * @property {number}       itemOffset     — seconds into currentItem
 * @property {Object|null}  nextItem       — next TVItem in program
 * @property {Object|null}  nextProgram    — next scheduled program
 * @property {Object|null}  nextEntry      — next schedule entry
 * @property {Array}        queue          — [{item, offsetIntoProgram}] for upcoming items in program
 * @property {Array}        upcoming       — next N schedule slots [{entry, program, startMs, endMs}]
 * @property {number}       programElapsed — seconds elapsed since program start
 * @property {number}       programDuration
 * @property {string}       gapLabel
 */

function resolve(nowMs) {
  if (typeof nowMs !== 'number') nowMs = Date.now();

  const slots = _activeSchedule();

  if (!slots.length) {
    return _gapState(null, slots);
  }

  // Find the active slot (started before now, ends after now)
  const active = slots.find(s => s.startMs <= nowMs && s.endMs > nowMs);

  if (!active) {
    return _gapState(_nextSlot(slots, nowMs), slots);
  }

  return _resolveActive(active, nowMs, slots);
}

function _gapState(nextSlot, slots) {
  // ── Attempt fallback playlist if configured ──────────────────────────────
  if (_settings.fallbackMode === 'playlist' && _settings.fallbackPlaylistId) {
    const fbState = _resolveFallback(nextSlot, slots);
    if (fbState) return fbState;
    // fallback configured but unusable — fall through to standby
  }

  return {
    mode:            'gap',
    scheduleEntry:   null,
    program:         null,
    currentItem:     null,
    itemOffset:      0,
    nextItem:        null,
    nextProgram:     nextSlot ? nextSlot.program : null,
    nextEntry:       nextSlot ? nextSlot.entry   : null,
    queue:           [],
    upcoming:        slots.slice(0, 8),
    programElapsed:  0,
    programDuration: 0,
    gapLabel:        GAP_LABEL,
    isFallback:      false,
  };
}

/**
 * Resolve a fallback-playlist state for gap periods.
 *
 * Uses the wall clock to calculate a deterministic position within the
 * looping fallback playlist so all viewers share the same position.
 * The epoch anchor is Unix epoch / playlist total duration — every viewer
 * calculates identically from Date.now() with no shared state required.
 *
 * Returns a TimelineState-compatible object (mode:'fallback') or null if
 * the fallback playlist is invalid / empty / has no playable items.
 *
 * @param {Object|null} nextSlot
 * @param {Array}       slots
 * @returns {Object|null}
 */
function _resolveFallback(nextSlot, slots) {
  const plId = _settings.fallbackPlaylistId;
  const pl   = _playlists[plId];
  if (!pl) return null;                                   // playlist deleted

  // Build flat, playable item list (same filter logic as _programItems)
  const items = [];
  for (const entry of (pl.items || [])) {
    const m = _media[entry.mediaId];
    if (!m || !m.mediaUrl) continue;
    items.push({
      id:        m.id,
      title:     m.title || 'Untitled',
      artist:    m.artist || '',
      mediaType: m.mediaType || 'video',
      mediaUrl:  m.mediaUrl,
      artwork:   m.artworkUrl || '',
      duration:  m.duration || 0,
    });
  }
  if (!items.length) return null;                         // no usable items

  // Calculate total playlist duration
  // Items with duration <= 0 are treated as zero for position purposes;
  // they will play from the start when encountered.
  let totalDuration = 0;
  for (const it of items) {
    if (it.duration > 0) totalDuration += it.duration;
  }
  // If all durations are unknown, we cannot calculate a deterministic
  // position — play the first item from the start and let the viewer
  // advance naturally.
  const nowMs = Date.now();
  let currentItem = null;
  let itemOffset  = 0;
  let nextItem    = null;
  const queue     = [];

  if (totalDuration <= 0) {
    currentItem = items[0];
    itemOffset  = 0;
    nextItem    = items[1] || null;
    for (let i = 2; i < items.length; i++) queue.push(items[i]);
  } else {
    // Deterministic position: seconds elapsed since epoch, modulo total
    const elapsedInCycle = (Math.floor(nowMs / 1000) % totalDuration);
    let accum = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const dur  = item.duration > 0 ? item.duration : 0;
      if (dur <= 0) {
        if (accum <= elapsedInCycle) {
          currentItem = item;
          itemOffset  = 0;
          nextItem    = items[i + 1] || items[0];
          for (let j = i + 1; j < items.length; j++) queue.push(items[j]);
          break;
        }
      } else if (accum + dur > elapsedInCycle || i === items.length - 1) {
        currentItem = item;
        itemOffset  = Math.max(0, elapsedInCycle - accum);
        nextItem    = items[i + 1] || items[0];
        for (let j = i + 1; j < items.length; j++) queue.push(items[j]);
        break;
      }
      accum += dur;
    }
  }

  if (!currentItem) return null;

  return {
    mode:            'fallback',
    scheduleEntry:   null,
    program:         null,
    currentItem,
    itemOffset,
    nextItem,
    nextProgram:     nextSlot ? nextSlot.program : null,
    nextEntry:       nextSlot ? nextSlot.entry   : null,
    queue,
    upcoming:        slots.slice(0, 8),
    programElapsed:  itemOffset,
    programDuration: currentItem.duration || 0,
    gapLabel:        GAP_LABEL,
    isFallback:      true,
    fallbackPlaylist: { id: plId, name: pl.name || 'Fallback' },
  };
}

function _nextSlot(slots, nowMs) {
  return slots.find(s => s.startMs > nowMs) || null;
}

function _resolveActive(active, nowMs, slots) {
  const programElapsedMs = nowMs - active.startMs;
  const programElapsed   = programElapsedMs / 1000;
  const items            = _programItems(active.program);

  if (!items.length) {
    // Program exists but has no playable items — treat as gap
    return _gapState(_nextSlot(slots, nowMs), slots);
  }

  // Total media duration (sum of all items with known duration)
  let totalMediaDuration = 0;
  let allUnknown = true;
  for (const it of items) {
    if (it.duration > 0) { totalMediaDuration += it.duration; allUnknown = false; }
  }

  // When the program has a fixed scheduled block duration and the media has a
  // known total, support looping: map programElapsed onto [0, totalMediaDuration).
  let effectiveElapsed = programElapsed;
  let loopCount = 0;
  if (!allUnknown && totalMediaDuration > 0 && programElapsed >= totalMediaDuration) {
    loopCount        = Math.floor(programElapsed / totalMediaDuration);
    effectiveElapsed = programElapsed % totalMediaDuration;
  }

  // All-unknown-duration fast path: when no item has a known duration we cannot
  // calculate a wall-clock position.  Return item[0] at offset 0 — the TV Core's
  // _advanceByQueue() handles sequential advancement in this case, so the resolver
  // is only called for initial load and join-in-progress (both of which start at
  // item[0] anyway).
  if (allUnknown) {
    const firstItem = items[0];
    return {
      mode:            'playing',
      scheduleEntry:   active.entry,
      program:         active.program,
      currentItem:     firstItem,
      itemOffset:      0,
      nextItem:        items[1] || null,
      nextProgram:     slots.length > slots.indexOf(active) + 1 ? slots[slots.indexOf(active) + 1].program : null,
      nextEntry:       slots.length > slots.indexOf(active) + 1 ? slots[slots.indexOf(active) + 1].entry   : null,
      queue:           items.slice(1),
      upcoming:        slots.slice(slots.indexOf(active) + 1, slots.indexOf(active) + 9),
      programElapsed,
      programDuration: active.duration,
      gapLabel:        '',
      loopCount:       0,
    };
  }

  // Walk items to find which one is playing and the offset within it.
  //
  // Items with known duration are positioned by wall-clock elapsed time.
  // Items with unknown duration (dur === 0) cannot be positioned by time, so they
  // are treated as "play next in sequence after all positioned items" — they act as
  // placeholders that consume their real duration only once it is discovered.
  //
  // Algorithm:
  //   1. Walk items in order.
  //   2. For items with known duration: advance accum, select when accum+dur > elapsed.
  //   3. For items with dur=0: record as candidate but do NOT break — keep walking to
  //      see if a later known-duration item should have already started.
  //   4. If we run off the end of the list without a definitive match, use the last
  //      candidate (which may be a zero-duration item or the last item in the list).
  let accum = 0;
  let currentItem   = null;
  let itemOffset    = 0;
  let nextItem      = null;
  let currentIndex  = -1;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const dur  = item.duration > 0 ? item.duration : 0;

    if (dur <= 0) {
      // Unknown duration — use as candidate only if we have not yet placed accum past elapsed.
      // Do NOT break: a subsequent item with known duration might be the correct one.
      if (currentItem === null) {
        // First zero-duration item encountered — tentative candidate.
        currentItem  = item;
        itemOffset   = 0;
        currentIndex = i;
        nextItem     = items[i + 1] || (loopCount > 0 ? items[0] : null) || _firstItemOfNext(slots, nowMs);
      }
      // accum does not advance for zero-duration items (we don't know how long they ran)
      continue;
    }

    // Known-duration item: does the elapsed time fall within [accum, accum+dur)?
    if (accum + dur > effectiveElapsed) {
      // This is the definitive item.
      currentItem  = item;
      itemOffset   = Math.max(0, effectiveElapsed - accum);
      currentIndex = i;
      nextItem     = items[i + 1] || (loopCount > 0 ? items[0] : null) || _firstItemOfNext(slots, nowMs);
      break;
    }
    accum += dur;

    // If elapsed has passed this item's range, clear any zero-duration candidate
    // that was set before this item — we've moved past it.
    if (currentItem !== null && currentItem.duration <= 0) {
      // A zero-duration candidate was set earlier. If a known-duration item has
      // already been exhausted (accum has advanced past it), the zero-duration item
      // is no longer valid — clear and keep walking.
      // Exception: keep it if no known-duration item has been found yet.
      currentItem  = null;
      currentIndex = -1;
    }
  }

  // If no definitive match found, fall back to the last item in the list.
  if (currentItem === null) {
    currentItem  = items[items.length - 1];
    currentIndex = items.length - 1;
    itemOffset   = 0;
    nextItem     = (loopCount > 0 ? items[0] : null) || _firstItemOfNext(slots, nowMs);
  }

  // Build queue: remaining items in program (after currentItem, wrapping if looping)
  const queue = [];
  let foundCurrent = false;
  for (const it of items) {
    if (!foundCurrent) {
      if (it === currentItem) foundCurrent = true;
      continue;
    }
    queue.push(it);
  }
  // If we're looping and at the tail, add a rotation of items for visibility
  if (loopCount > 0 && queue.length === 0 && items.length > 1) {
    const curIdx = items.indexOf(currentItem);
    for (let j = 1; j < items.length; j++) {
      queue.push(items[(curIdx + j) % items.length]);
    }
  }

  // Upcoming schedule (next 8 entries after current)
  const currentIdx = slots.indexOf(active);
  const upcoming = slots.slice(currentIdx + 1, currentIdx + 9);

  return {
    mode:            'playing',
    scheduleEntry:   active.entry,
    program:         active.program,
    currentItem,
    itemOffset,
    nextItem,
    nextProgram:     upcoming.length ? upcoming[0].program : null,
    nextEntry:       upcoming.length ? upcoming[0].entry   : null,
    queue,
    upcoming,
    programElapsed,
    programDuration: active.duration,
    gapLabel:        '',
    loopCount,
  };
}

function _firstItemOfNext(slots, nowMs) {
  const next = _nextSlot(slots, nowMs);
  if (!next) return null;
  const items = _programItems(next.program);
  return items[0] || null;
}

/* ════════════════════════════════════════════════════════════
   LIVE LISTENERS
════════════════════════════════════════════════════════════ */

const COLL_TV_PLAYLISTS_COLL = 'tv_playlists';

function startListening() {
  if (_listening) return;
  const { collection, doc, onSnapshot, query, orderBy } = _fs();
  const db = _db();
  if (!db || !collection || !onSnapshot) {
    setTimeout(startListening, 1000);
    return;
  }
  _listening = true;

  // ── tv_schedule — all channels loaded; _activeSchedule() filters by channel ──
  try {
    const q = query(collection(db, COLL_SCHEDULE), orderBy('startTime', 'asc'));
    _unsubSchedule = onSnapshot(q, snap => {
      _schedule = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _notifySubscribers();
    }, e => {
      console.warn('[SNXTV-TL] schedule listener error (auto-retry):', e.message);
    });
  } catch (e) { console.warn('[SNXTV-TL] schedule setup:', e.message); }

  // ── tv_programs — all channels loaded; _activeSchedule() resolves correct programs ──
  try {
    _unsubPrograms = onSnapshot(collection(db, COLL_PROGRAMS), snap => {
      _programs = {};
      snap.docs.forEach(d => { _programs[d.id] = { id: d.id, ...d.data() }; });
      _notifySubscribers();
    }, e => {
      console.warn('[SNXTV-TL] programs listener error (auto-retry):', e.message);
    });
  } catch (e) { console.warn('[SNXTV-TL] programs setup:', e.message); }

  // ── tv_playlists — shared library, all channels see all playlists ──
  try {
    _unsubPlaylists = onSnapshot(collection(db, COLL_TV_PLAYLISTS_COLL), snap => {
      _playlists = {};
      snap.docs.forEach(d => { _playlists[d.id] = { id: d.id, ...d.data() }; });
      _notifySubscribers();
    }, e => {
      console.warn('[SNXTV-TL] playlists listener error (auto-retry):', e.message);
    });
  } catch (e) { console.warn('[SNXTV-TL] playlists setup:', e.message); }

  // ── tv_media — shared library (not channel-specific) ──
  try {
    _unsubMedia = onSnapshot(collection(db, COLL_MEDIA), snap => {
      _media = {};
      snap.docs.forEach(d => { _media[d.id] = { id: d.id, ...d.data() }; });
      _notifySubscribers();
    }, e => {
      console.warn('[SNXTV-TL] media listener error (auto-retry):', e.message);
    });
  } catch (e) { console.warn('[SNXTV-TL] media setup:', e.message); }

  // ── tv_settings — per-channel settings document (keyed by channelId or 'channel' for default) ──
  // For the default channel we read 'channel'; for named channels we read their channelId doc.
  try {
    const settingsDocId = _activeChannelId || 'channel';
    _unsubSettings = onSnapshot(doc(db, COLL_TV_SETTINGS, settingsDocId), snap => {
      const data = snap.exists() ? snap.data() : {};
      _settingsMap[_activeChannelId || 'default'] = data;
      _settings = data;
      _notifySubscribers();
    }, e => {
      console.warn('[SNXTV-TL] settings listener error (auto-retry):', e.message);
    });
  } catch (e) { console.warn('[SNXTV-TL] settings setup:', e.message); }

  // ── tv_channels — channel registry (all channels) ──
  try {
    _unsubChannels = onSnapshot(collection(db, COLL_TV_CHANNELS), snap => {
      _channels = {};
      snap.docs.forEach(d => { _channels[d.id] = { id: d.id, ...d.data() }; });
      // Notify subscribers — channel list changed (e.g. new channel created)
      _notifySubscribers();
    }, e => {
      console.warn('[SNXTV-TL] channels listener error (auto-retry):', e.message);
    });
  } catch (e) { console.warn('[SNXTV-TL] channels setup:', e.message); }

  // ── Periodic resync ──
  _resyncTimer = setInterval(_periodicResync, RESYNC_INTERVAL);

  console.log('[SNXTV-TL] Live listeners started — version', VERSION, '— channel:', _activeChannelId || 'default');
}

function stopListening() {
  if (_unsubSchedule)  { try { _unsubSchedule();  } catch(_){} _unsubSchedule  = null; }
  if (_unsubPrograms)  { try { _unsubPrograms();  } catch(_){} _unsubPrograms  = null; }
  if (_unsubPlaylists) { try { _unsubPlaylists(); } catch(_){} _unsubPlaylists = null; }
  if (_unsubMedia)     { try { _unsubMedia();     } catch(_){} _unsubMedia     = null; }
  if (_unsubSettings)  { try { _unsubSettings();  } catch(_){} _unsubSettings  = null; }
  if (_unsubChannels)  { try { _unsubChannels();  } catch(_){} _unsubChannels  = null; }
  if (_resyncTimer)    { clearInterval(_resyncTimer); _resyncTimer = null; }
  _listening = false;
  console.log('[SNXTV-TL] Listeners stopped.');
}

/* ════════════════════════════════════════════════════════════
   SUBSCRIBERS
════════════════════════════════════════════════════════════ */

/**
 * Subscribe to timeline data changes.
 * Called whenever schedule/program/media data updates.
 * Subscribers receive the resolved timeline state.
 */
function subscribe(fn) {
  _subscribers.push(fn);
  return function unsubscribe() {
    _subscribers = _subscribers.filter(s => s !== fn);
  };
}

function _notifySubscribers() {
  const state = resolve(Date.now());
  for (const fn of _subscribers) {
    try { fn(state); } catch (e) { /* never crash */ }
  }
}

/* ════════════════════════════════════════════════════════════
   PERIODIC RESYNC — called every RESYNC_INTERVAL
════════════════════════════════════════════════════════════ */

function _periodicResync() {
  // Notify TV core to check drift
  if (global.SNXTV && typeof global.SNXTV._timelineResync === 'function') {
    global.SNXTV._timelineResync();
  }
}

/* ════════════════════════════════════════════════════════════
   UTILITY — for TV Guide
════════════════════════════════════════════════════════════ */

function getUpcoming(count) {
  const slots = _activeSchedule();
  const nowMs = Date.now();
  // Include currently active and all future
  return slots.filter(s => s.endMs > nowMs).slice(0, count || 10);
}

function hasSchedule() {
  return _activeSchedule().length > 0;
}

/** Return a copy of the raw schedule for Studio */
function getRawSchedule() {
  return _schedule.slice();
}

/** Return a copy of the programs map for Studio */
function getPrograms() {
  return Object.assign({}, _programs);
}

/** Return a copy of the media map for Studio */
function getMediaMap() {
  return Object.assign({}, _media);
}

/** Return a copy of the playlists map for Studio */
function getPlaylistsMap() {
  return Object.assign({}, _playlists);
}

/* ════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */

const SNXTVTimeline = {
  version: VERSION,
  buildId: 'SNS-2026-TV-STAGE6-001',

  // Lifecycle
  startListening,
  stopListening,

  // Core resolver
  resolve,

  // Subscribe to data changes (triggers resolve)
  subscribe,

  // Conflict detection (for Studio)
  detectConflicts,

  // Duration calculator (for Studio)
  calcProgramDuration: _calcProgramDuration,

  // Item list builder (for Studio/Guide preview)
  programItems: _programItems,

  // Active schedule (for Guide)
  activeSchedule: _activeSchedule,
  getUpcoming,
  hasSchedule,

  // Raw data accessors (for Studio)
  getRawSchedule,
  getPrograms,
  getMediaMap,
  getPlaylistsMap,

  // Channel settings (audioVisualMode, fallbackMode, etc.)
  getSettings: function () { return Object.assign({}, _settings); },

  // ── Multi-channel API ──────────────────────────────────────────────────
  // Switch the active channel (reloads timeline for new channel)
  setChannel,
  // Return all available channels
  getChannels,
  // Get current active channel ID
  getActiveChannelId: function () { return _activeChannelId || 'default'; },
  // Optimistically inject a newly-created channel into the local cache so
  // getChannels() returns it immediately, before the Firestore onSnapshot fires.
  injectChannel: function (ch) {
    if (!ch || !ch.id) return;
    if (!_channels[ch.id]) {
      _channels[ch.id] = Object.assign({}, ch);
      _notifySubscribers();
    }
  },
};

global.SNXTVTimeline = SNXTVTimeline;

})(window);
