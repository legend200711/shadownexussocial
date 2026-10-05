/**
 * SHADOW NEXUS SOCIAL — SNS TV Core
 * snx-tv-core.js
 *
 * OWNERSHIP: Shadow Nexus Social
 *
 * Canonical TV state engine for the SNS 24-Hour TV.
 * Uses the SNS Firebase project (horr-a08f4) exclusively — no separate
 * Firebase project, no Supabase, no external engine, no service-account JSON.
 *
 * SNS Firestore collections (all in horr-a08f4):
 *   tv_state/ALTV                  — live broadcast state (current item, started_at, queue…)
 *   tv_config/ALTV                 — programming engine config (running, freq, history…)
 *   tv_media/{id}                  — TV media library records (reference SNS R2 URLs)
 *   tv_playlists/{id}              — TV playlists
 *   tv_programs/{id}               — TV programs (reference media or playlists)
 *   tv_schedule/{id}               — TV schedule slots
 *
 * Auth: window._snxAuth (SNS project horr-a08f4) — same session as all other SNS features.
 * Storage: SNS Cloudflare R2 Worker (yellow-term-11e6.nthntjrn.workers.dev) — same as uploads.
 *
 * Server-side advancement:
 *   The Cloudflare Worker (upload-worker.js) advances TV state via cron + /channel/advance.
 *   It reads/writes tv_state/ALTV and tv_config/ALTV in horr-a08f4.
 *   This does NOT require FIREBASE_SERVICE_KEY for the SNS project —
 *   it uses FIREBASE_WEB_API_KEY for auth verification and a Google Firestore
 *   service account for horr-a08f4 if required (or the worker can be configured
 *   to use the Firebase Admin REST API with the existing SNS service account).
 *
 * IMPORTANT NOTE ON TRUE 24/7 ADVANCEMENT:
 *   Without an always-on backend, TV only advances when a viewer has the page open.
 *   The Cloudflare Worker cron trigger (every 1 minute) provides unattended advancement
 *   AS LONG AS FIREBASE_SERVICE_KEY (for horr-a08f4, not remix-studio-4bf8a) is set.
 *   See FINAL REPORT for details.
 */

import {
  db,
  doc, getDoc, setDoc, collection, getDocs, addDoc,
  updateDoc, deleteDoc, onSnapshot, serverTimestamp,
  query, orderBy, where, limit, Timestamp,
} from './firebase-config.js';

/* ════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════ */
export const TV_CHANNEL_ID  = 'ALTV';
export const TV_STATE_COL   = 'tv_state';
export const TV_CONFIG_COL  = 'tv_config';
export const TV_MEDIA_COL   = 'tv_media';
export const TV_PLAYLIST_COL = 'tv_playlists';
export const TV_PROGRAM_COL  = 'tv_programs';
export const TV_SCHEDULE_COL = 'tv_schedule';

/** Worker endpoint for viewer-triggered advancement — SNS infrastructure */
export const TV_ADVANCE_URL = 'https://yellow-term-11e6.nthntjrn.workers.dev/channel/advance';

/** Media types eligible for TV programming */
export const TV_PROGRAM_TYPES = new Set([
  'video', 'music_video', 'show', 'broadcast_clip', 'audio_program',
  'podcast', 'station_id', 'archive', 'trailer', 'audio', 'music',
  'funny_clip', 'short_film',
]);

/** Media types treated as commercials */
export const TV_COMMERCIAL_TYPES = new Set([
  'commercial', 'promo', 'trailer', 'station_id',
]);

/** Commercial frequency presets */
export const TV_COMMERCIAL_FREQ = {
  off:    { label: 'OFF',           minPrograms: 999, maxPrograms: 999, minSpot: 0, maxSpot: 0 },
  low:    { label: 'Low',           minPrograms: 4,   maxPrograms: 7,   minSpot: 1, maxSpot: 1 },
  normal: { label: 'Normal',        minPrograms: 2,   maxPrograms: 4,   minSpot: 1, maxSpot: 2 },
  high:   { label: 'High',          minPrograms: 1,   maxPrograms: 2,   minSpot: 2, maxSpot: 3 },
};

export const DEFAULT_TV_CONFIG = {
  running:              false,
  paused:               false,
  commercial_freq:      'normal',
  avoid_repeat_window:  10,
  recent_history:       [],
  commercial_history:   [],
  programs_since_break: 0,
  next_break_at:        3,
  programming_mode:     'random',
  updated_at:           null,
};

/* ════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════ */

/** Get the current SNS user from the shared auth session. */
export function getTvUser() {
  return window._snxAuth?.currentUser ?? null;
}

/** Get Firebase ID token for the current SNS user (for Worker auth). */
export async function getTvIdToken() {
  const user = getTvUser();
  if (!user) throw new Error('Not signed in');
  return user.getIdToken();
}

/** Format seconds as mm:ss */
export function fmtTime(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** HTML escape */
export function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/** Compute elapsed seconds for a currently-playing item. */
export function computeElapsed(startedAt) {
  if (!startedAt) return 0;
  let startMs;
  if (startedAt?.toMillis) startMs = startedAt.toMillis();
  else if (typeof startedAt === 'number') startMs = startedAt < 1e10 ? startedAt * 1000 : startedAt;
  else if (startedAt instanceof Date) startMs = startedAt.getTime();
  else return 0;
  return Math.max(0, (Date.now() - startMs) / 1000);
}

/* ════════════════════════════════════════════════════
   TV STATE (canonical — all viewers read from here)
════════════════════════════════════════════════════ */

/**
 * Subscribe to the canonical TV state.
 * Fires immediately with the current value, then on every change.
 * @param {(state: object|null) => void} cb
 * @returns {() => void} unsubscribe
 */
export function subscribeTvState(cb) {
  return onSnapshot(doc(db, TV_STATE_COL, TV_CHANNEL_ID), snap => {
    cb(snap.exists() ? snap.data() : null);
  });
}

/** One-shot read of TV state. */
export async function loadTvState() {
  const snap = await getDoc(doc(db, TV_STATE_COL, TV_CHANNEL_ID));
  return snap.exists() ? snap.data() : null;
}

/** One-shot read of TV config. */
export async function loadTvConfig() {
  const snap = await getDoc(doc(db, TV_CONFIG_COL, TV_CHANNEL_ID));
  return snap.exists() ? snap.data() : null;
}

/* ════════════════════════════════════════════════════
   TV MEDIA LIBRARY
════════════════════════════════════════════════════ */

/**
 * Subscribe to TV media library changes.
 * Returns all media ordered by uploaded_at desc.
 * @param {(items: Array) => void} cb
 * @returns {() => void} unsubscribe
 */
export function subscribeTvMedia(cb) {
  return onSnapshot(
    query(collection(db, TV_MEDIA_COL), orderBy('uploaded_at', 'desc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.warn('[SNX-TV] Media subscription error:', err.message),
  );
}

/** One-shot load of TV media library. */
export async function loadTvMedia() {
  const snap = await getDocs(
    query(collection(db, TV_MEDIA_COL), orderBy('uploaded_at', 'desc')),
  );
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Add a media record to the TV library.
 * This is a REFERENCE — the actual file must already be in SNS R2 storage.
 * @param {object} mediaData
 * @returns {Promise<string>} new document ID
 */
export async function addTvMedia(mediaData) {
  const ref = await addDoc(collection(db, TV_MEDIA_COL), {
    ...mediaData,
    status:      mediaData.status || 'pending_approval',
    uploaded_at: serverTimestamp(),
    updated_at:  serverTimestamp(),
  });
  return ref.id;
}

/**
 * Update a TV media record.
 * @param {string} mediaId
 * @param {object} updates
 */
export async function updateTvMedia(mediaId, updates) {
  await updateDoc(doc(db, TV_MEDIA_COL, mediaId), {
    ...updates,
    updated_at: serverTimestamp(),
  });
}

/**
 * Delete a TV media record.
 * NOTE: This does NOT delete the R2 file — only the metadata reference.
 * @param {string} mediaId
 */
export async function deleteTvMedia(mediaId) {
  await deleteDoc(doc(db, TV_MEDIA_COL, mediaId));
}

/* ════════════════════════════════════════════════════
   TV PLAYLISTS
════════════════════════════════════════════════════ */

/** Subscribe to all TV playlists. */
export function subscribeTvPlaylists(cb) {
  return onSnapshot(
    query(collection(db, TV_PLAYLIST_COL), orderBy('created_at', 'desc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.warn('[SNX-TV] Playlists subscription error:', err.message),
  );
}

/** Load all TV playlists (one-shot). */
export async function loadTvPlaylists() {
  const snap = await getDocs(query(collection(db, TV_PLAYLIST_COL), orderBy('created_at', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Create a new TV playlist. */
export async function createTvPlaylist(name, items = []) {
  const ref = await addDoc(collection(db, TV_PLAYLIST_COL), {
    name,
    items,       // array of { id, title, artist, url, duration_sec, type, mime_type }
    created_at:  serverTimestamp(),
    updated_at:  serverTimestamp(),
  });
  return ref.id;
}

/** Update a TV playlist (name or items). */
export async function updateTvPlaylist(playlistId, updates) {
  await updateDoc(doc(db, TV_PLAYLIST_COL, playlistId), {
    ...updates,
    updated_at: serverTimestamp(),
  });
}

/** Delete a TV playlist. */
export async function deleteTvPlaylist(playlistId) {
  await deleteDoc(doc(db, TV_PLAYLIST_COL, playlistId));
}

/* ════════════════════════════════════════════════════
   TV PROGRAMS
════════════════════════════════════════════════════ */

/** Subscribe to all TV programs. */
export function subscribeTvPrograms(cb) {
  return onSnapshot(
    query(collection(db, TV_PROGRAM_COL), orderBy('created_at', 'desc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.warn('[SNX-TV] Programs subscription error:', err.message),
  );
}

/** Load all TV programs (one-shot). */
export async function loadTvPrograms() {
  const snap = await getDocs(query(collection(db, TV_PROGRAM_COL), orderBy('created_at', 'desc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Create a TV program.
 * A program references either a media item or a playlist.
 * @param {object} programData - { name, type ('media'|'playlist'), ref_id, description? }
 */
export async function createTvProgram(programData) {
  const ref = await addDoc(collection(db, TV_PROGRAM_COL), {
    ...programData,
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });
  return ref.id;
}

/** Update a TV program. */
export async function updateTvProgram(programId, updates) {
  await updateDoc(doc(db, TV_PROGRAM_COL, programId), {
    ...updates,
    updated_at: serverTimestamp(),
  });
}

/** Delete a TV program. */
export async function deleteTvProgram(programId) {
  await deleteDoc(doc(db, TV_PROGRAM_COL, programId));
}

/* ════════════════════════════════════════════════════
   TV SCHEDULE
════════════════════════════════════════════════════ */

/** Subscribe to the TV schedule, ordered by slot order. */
export function subscribeTvSchedule(cb) {
  return onSnapshot(
    query(collection(db, TV_SCHEDULE_COL), orderBy('order', 'asc')),
    snap => cb(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => console.warn('[SNX-TV] Schedule subscription error:', err.message),
  );
}

/** Load the TV schedule (one-shot). */
export async function loadTvSchedule() {
  const snap = await getDocs(query(collection(db, TV_SCHEDULE_COL), orderBy('order', 'asc')));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Save the entire TV schedule as an ordered list of items.
 * Each item: { media_id, title, artist, type, url, duration_sec, mime_type }
 * Stored in tv_state/ALTV as `queue` for live playback.
 * @param {Array} items
 */
export async function saveTvSchedule(items) {
  const stateRef = doc(db, TV_STATE_COL, TV_CHANNEL_ID);
  const snap = await getDoc(stateRef);
  const existing = snap.exists() ? snap.data() : {};
  await setDoc(stateRef, {
    ...existing,
    queue:      items,
    updated_at: serverTimestamp(),
  }, { merge: true });
}

/**
 * Push the schedule live — sets the first item as current and starts playback.
 * @param {Array} items
 * @param {boolean} loop
 */
export async function pushScheduleLive(items, loop = true) {
  if (!items?.length) throw new Error('No items to schedule');
  const stateRef = doc(db, TV_STATE_COL, TV_CHANNEL_ID);
  await setDoc(stateRef, {
    current_item:     items[0],
    started_at:       serverTimestamp(),
    queue:            items,
    loop,
    is_commercial:    false,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     items[0].id,
    updated_at:       serverTimestamp(),
  });
}

/* ════════════════════════════════════════════════════
   TV CONFIG (programming engine)
════════════════════════════════════════════════════ */

/** Save TV config updates. */
export async function saveTvConfig(updates) {
  await setDoc(doc(db, TV_CONFIG_COL, TV_CHANNEL_ID), {
    ...updates,
    updated_at: serverTimestamp(),
  }, { merge: true });
}

/** Start the TV channel (sets running=true). */
export async function startTv(mediaLib) {
  const configRef = doc(db, TV_CONFIG_COL, TV_CHANNEL_ID);
  const snap      = await getDoc(configRef);
  if (!snap.exists()) {
    await setDoc(configRef, { ...DEFAULT_TV_CONFIG, running: true, updated_at: serverTimestamp() });
  } else {
    await setDoc(configRef, { running: true, paused: false, updated_at: serverTimestamp() }, { merge: true });
  }

  // Kick off immediately only if nothing is playing
  const stateSnap = await getDoc(doc(db, TV_STATE_COL, TV_CHANNEL_ID));
  const st = stateSnap.exists() ? stateSnap.data() : null;
  if (!st?.current_item) {
    await advanceTvNow(null);
  }
}

/** Stop the TV channel. */
export async function stopTv() {
  await setDoc(doc(db, TV_CONFIG_COL, TV_CHANNEL_ID), {
    running: false, updated_at: serverTimestamp(),
  }, { merge: true });
  await setDoc(doc(db, TV_STATE_COL, TV_CHANNEL_ID), {
    current_item: null, started_at: serverTimestamp(), updated_at: serverTimestamp(),
  }, { merge: true });
}

/** Pause the TV channel. */
export async function pauseTv() {
  await setDoc(doc(db, TV_CONFIG_COL, TV_CHANNEL_ID), {
    paused: true, updated_at: serverTimestamp(),
  }, { merge: true });
}

/** Resume the TV channel. */
export async function resumeTv() {
  await setDoc(doc(db, TV_CONFIG_COL, TV_CHANNEL_ID), {
    paused: false, updated_at: serverTimestamp(),
  }, { merge: true });
  await advanceTvNow(null);
}

/* ════════════════════════════════════════════════════
   ADVANCEMENT — viewer-triggered via SNS Worker
════════════════════════════════════════════════════ */

/**
 * Request the SNS Worker to advance to the next item.
 * Uses SNS Firebase ID token — no service account required.
 * @param {string|null} currentItemId
 * @returns {Promise<{advanced: boolean, reason: string, newItem?: object}>}
 */
export async function requestTvAdvance(currentItemId) {
  try {
    const idToken = await getTvIdToken();
    const res = await fetch(TV_ADVANCE_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ channelId: TV_CHANNEL_ID, currentItemId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn('[SNX-TV] Advance failed:', res.status, err);
      return { advanced: false, reason: 'worker_error' };
    }
    return res.json();
  } catch (err) {
    console.warn('[SNX-TV] Advance request error:', err.message);
    return { advanced: false, reason: 'network_error' };
  }
}

/**
 * Advance now (browser-side fallback when Worker is unavailable).
 * Picks a program from the media library and writes to Firestore directly.
 * This is the fallback path — the Worker is preferred.
 * @param {string|null} lastItemId
 */
export async function advanceTvNow(lastItemId) {
  // Try Worker first
  const result = await requestTvAdvance(lastItemId).catch(() => ({ advanced: false }));
  if (result.advanced) return result;

  // Fallback: browser-side pick
  const mediaLib = await loadTvMedia();
  const config   = await loadTvConfig();
  const program  = _pickProgram(mediaLib, config, lastItemId);
  if (!program) return { advanced: false, reason: 'no_eligible_programs' };

  const item = _mediaItemToState(program);
  await setDoc(doc(db, TV_STATE_COL, TV_CHANNEL_ID), {
    current_item:     item,
    started_at:       serverTimestamp(),
    is_commercial:    false,
    commercial_queue: [],
    needs_next:       false,
    last_item_id:     program.id,
    updated_at:       serverTimestamp(),
  }, { merge: true });
  return { advanced: true, reason: 'browser_fallback', newItem: item };
}

/* ════════════════════════════════════════════════════
   SNS MEDIA IMPORT
   Reference SNS media (profileMusic, cloudStreamTracks) into TV library.
   Does NOT copy files — just creates a reference record.
════════════════════════════════════════════════════ */

/**
 * Import SNS user media into TV library (by reference — no file copy).
 * @param {string} uid  SNS user UID
 * @param {import('firebase/firestore').Firestore} snsDb  SNS Firestore instance
 * @returns {Promise<{imported: number, skipped: number, failed: number}>}
 */
export async function importSnsMediaToTv(uid, snsDb) {
  const snsItems = [];

  // Load profileMusic
  try {
    const pmSnap = await getDocs(
      query(collection(snsDb, 'profileMusic'), where('ownerUid', '==', uid)),
    );
    pmSnap.docs.forEach(d => {
      const s = d.data();
      const url = s.musicUrl || s.downloadURL || s.url || '';
      if (!url) return;
      snsItems.push({
        sns_source_id:  d.id,
        sns_collection: 'profileMusic',
        title:          s.title || d.id,
        artist:         s.artist || '',
        url,
        storage_path:   s.r2Key || s.audioR2Key || '',
        storage_backend:'shadow_nexus_r2',
        duration_sec:   typeof s.duration === 'number' ? Math.round(s.duration) : 0,
        thumbnail_url:  s.artworkURL || s.artUrl || s.coverImage || '',
        mime_type:      s.fileType || 'audio/mpeg',
        type:           'music',
        owner_uid:      uid,
      });
    });
  } catch (e) {
    console.warn('[SNX-TV] importSns profileMusic error:', e.message);
  }

  // Load cloudStreamTracks
  try {
    const cstSnap = await getDocs(
      query(collection(snsDb, 'cloudStreamTracks', uid, 'tracks')),
    );
    cstSnap.docs.forEach(d => {
      const s = d.data();
      const url = s.url || s.audioUrl || s.downloadURL || '';
      if (!url) return;
      const isVideo = (s.mimeType || '').startsWith('video/');
      snsItems.push({
        sns_source_id:  d.id,
        sns_collection: 'cloudStreamTracks',
        title:          s.title || d.id,
        artist:         s.artist || '',
        url,
        storage_path:   s.r2Key || '',
        storage_backend:'shadow_nexus_r2',
        duration_sec:   typeof s.duration === 'number' ? Math.round(s.duration) :
                        typeof s.durationSec === 'number' ? Math.round(s.durationSec) : 0,
        thumbnail_url:  s.artworkUrl || s.artUrl || s.coverImage || '',
        mime_type:      s.mimeType || s.fileType || 'audio/mpeg',
        type:           isVideo ? 'video' : 'music',
        owner_uid:      uid,
      });
    });
  } catch (e) {
    console.warn('[SNX-TV] importSns cloudStreamTracks error:', e.message);
  }

  if (!snsItems.length) return { imported: 0, skipped: 0, failed: 0 };

  // Load existing TV media to check for already-imported items
  const existing = await loadTvMedia();
  const existingIds = new Set(existing.filter(m => m.sns_source_id).map(m => m.sns_source_id));

  let imported = 0, skipped = 0, failed = 0;
  for (const item of snsItems) {
    if (existingIds.has(item.sns_source_id)) { skipped++; continue; }
    try {
      await addTvMedia({ ...item, status: 'pending_approval', source: 'sns_import' });
      imported++;
    } catch (e) {
      failed++;
      console.warn('[SNX-TV] addTvMedia error:', e.message);
    }
  }
  return { imported, skipped, failed };
}

/* ════════════════════════════════════════════════════
   INTERNAL HELPERS (browser-side fallback path only)
════════════════════════════════════════════════════ */

function _pickProgram(mediaLib, config, lastItemId) {
  const pool = (mediaLib || []).filter(m =>
    m.status === 'approved' &&
    TV_PROGRAM_TYPES.has(m.type) &&
    m.url,
  );
  if (!pool.length) return null;
  const history = config?.recent_history || [];
  const avoid   = lastItemId ? [...history, lastItemId] : history;
  let candidates = pool.filter(m => !avoid.includes(m.id));
  if (!candidates.length) candidates = pool.filter(m => m.id !== lastItemId);
  if (!candidates.length) candidates = pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function _mediaItemToState(m) {
  return {
    id:           m.id,
    title:        m.title || '(untitled)',
    artist:       m.artist   || '',
    type:         m.type     || 'media',
    url:          m.url      || '',
    duration_sec: m.duration_sec || 0,
    mime_type:    m.mime_type    || '',
    thumbnail_url: m.thumbnail_url || '',
  };
}
