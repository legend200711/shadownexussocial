/**
 * Shadow Nexus Radio — snx-radio.js
 * Version: 1.0.0
 *
 * Architecture:
 *   Pure client-side schedule/timeline engine.
 *   No persistent server process required.
 *   No VPS required.
 *
 * How it works:
 *   1. Station state (enabled, epoch, current playlist) lives in Firestore
 *      /siteSettings/radioStation  — public read, Founder-only write.
 *   2. Tracks live in Firestore /music/{trackId} (existing Founder-managed
 *      public catalogue) or /radioTracks/{trackId} (radio-specific additions).
 *   3. Playlists live in /radioPlaylists/{playlistId}.
 *   4. Audio/artwork files are in R2 (legend bucket) or Supabase aurenix-radio bucket.
 *   5. On connect the engine:
 *        a. Fetches server time offset via Firebase RTDB /.info/serverTimeOffset
 *        b. Reads station state from /siteSettings/radioStation
 *        c. Loads the active playlist tracks
 *        d. Calculates WHICH track should be playing and WHERE
 *        e. Seeks to that position and plays
 *   6. Two listeners open simultaneously for zero-downtime:
 *        – Firestore onSnapshot on radioStation (detects START/STOP/mode changes)
 *        – setInterval tick that advances tracks locally when the current one ends
 *
 * Deterministic timeline:
 *   Given: epoch (station start time in ms), playlist tracks with durations
 *   elapsed = serverNow() - epoch
 *   Walk playlist (looping) accumulating durations until sum > elapsed
 *   → current track index + position within that track
 *
 * Firebase paths used:
 *   /siteSettings/radioStation   — station state (public read, Founder write)
 *   /music/{trackId}             — public music catalogue (existing, reused)
 *   /radioTracks/{trackId}       — radio-specific tracks (new, optional)
 *   /radioPlaylists/{plId}       — station playlists (new)
 *
 * R2 paths used (legend bucket via Worker):
 *   radio/{uid}/audio/...        — audio files (existing Worker prefix)
 *   radio/{uid}/artwork/...      — artwork files (existing Worker prefix)
 *
 * Supabase paths (aurenix-radio bucket — existing):
 *   radio/{uid}/...              — channel audio (existing)
 *
 * Dependencies:
 *   – firebase-config.js  (window._snxFirestore / window._snxLiveDB)
 *   – snx-audio-coordinator.js (window.SNXAudioCoordinator)
 *   – No other SNX module is touched
 *
 * Isolation:
 *   Radio failure never touches Live.
 *   Live failure never touches Radio.
 *   This file defines and exports window.SNXRadio only.
 */

'use strict';

(function () {

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════ */

const RADIO_VERSION    = '3.0.0';
const WORKER_BASE      = 'https://yellow-term-11e6.nthntjrn.workers.dev';

// Firestore collection names
const COL_SITE         = 'siteSettings';
const DOC_STATION      = 'radioStation';   // /siteSettings/radioStation
const DOC_SETTINGS     = 'radioSettings';  // /siteSettings/radioSettings  (Stage 3)
const COL_TRACKS       = 'radioTracks';    // /radioTracks/{trackId}
const COL_MUSIC        = 'music';          // /music/{trackId}  (existing catalogue)
const COL_PLAYLISTS    = 'radioPlaylists'; // /radioPlaylists/{plId}
const COL_PROGRAMS     = 'radioPrograms';  // /radioPrograms/{programId}    (Stage 3)
const COL_SCHEDULE     = 'radioSchedule';  // /radioSchedule/{slotId}       (Stage 3)

// Time sync: Firebase RTDB /.info/serverTimeOffset gives offset in ms
const RTDB_TIME_PATH   = '.info/serverTimeOffset';

// Minimum track duration — tracks without a known duration are skipped
const MIN_DURATION_S   = 5;

// How often the tick runs to check for track advance
const TICK_MS          = 1000;

// Station mode values
const MODE_RADIO        = 'RADIO';
const MODE_PERSONAL_LIVE = 'PERSONAL_LIVE';
const MODE_OFF_AIR      = 'OFF_AIR';

// Recently played: how many historical tracks to surface
const RECENTLY_PLAYED_COUNT = 5;

/* ══════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════ */

let _station      = null;    // { enabled, mode, epochMs, playlistId, updatedAt }
let _playlist     = [];      // [{ id, title, artist, audioUrl, artworkUrl, duration, ... }]
let _trackIdx     = -1;      // current track index in _playlist
let _trackPos     = 0;       // current position in seconds within track
let _playing      = false;
let _audioEl      = null;    // single <audio> element
let _tickTimer    = null;
let _stationUnsub = null;    // Firestore listener unsubscribe
let _timeOffset   = 0;       // ms offset: serverTimeMs = Date.now() + _timeOffset
let _timeOffsetReady = false;
let _userInteracted = false; // has the user clicked TAP TO LISTEN?
let _destroyed    = false;

// Stage 3: Schedule / Programs / Settings state
let _schedule         = [];   // sorted array of { slotId, hour, minute, programId, label, enabled }
let _programs         = {};   // map programId → { name, artwork, playlistId, enabled, ... }
let _stationSettings  = null; // { stationName, tagline, defaultArtwork }
let _currentProgram   = null; // resolved program for now
let _scheduleUnsub    = null; // Firestore listener unsubscribe for schedule
let _programsUnsub    = null; // Firestore listener unsubscribe for programs
let _settingsUnsub    = null; // Firestore listener unsubscribe for settings

// Live playlist / track subscriptions
let _playlistUnsub    = null; // onSnapshot for active playlist doc
let _tracksUnsub      = null; // onSnapshot for /radioTracks collection
let _subscribedPlId   = null; // which playlistId is currently subscribed

// Callbacks registered by the player UI
const _cbs = {};

// Firebase handles (lazy-resolved from window globals)
let _firestore  = null;
let _liveDB     = null;

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */

window.SNXRadio = {
  init,
  destroy,
  tapToListen,
  stop,
  pageLeave,
  pageEnter,
  setVolume,
  on,
  off,
  get version()    { return RADIO_VERSION; },
  get isPlaying()  { return _playing; },
  get nowPlaying() { return _playlist[_trackIdx] || null; },
  get upNext()     { return _playlist[(_trackIdx + 1) % Math.max(_playlist.length, 1)] || null; },
  get stationEnabled() { return !!(_station && _station.enabled); },
  get mode()       { return (_station && _station.mode) || MODE_OFF_AIR; },

  // Stage 3: schedule / programs / settings getters
  get currentProgram()    { return _currentProgram; },
  get schedule()          { return _schedule.slice(); },
  get stationSettings()   { return _stationSettings; },
  get recentlyPlayed()    { return _recentlyPlayed(); },

  // Test harness — exposed for timeline unit tests
  _timeline,
  _serverNow,
  _resolveSchedule,
  _recentlyPlayed,
};

/* ══════════════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════════════ */

/**
 * Initialise the radio engine.
 * Safe to call multiple times — idempotent after first call.
 *
 * @param {object} [opts]
 * @param {Function} [opts.onNowPlaying]     cb(track)
 * @param {Function} [opts.onUpNext]         cb(track)
 * @param {Function} [opts.onStateChange]    cb(state)  state: 'on-air'|'off-air'|'loading'|'error'
 * @param {Function} [opts.onAutoplayBlocked] cb()
 * @param {Function} [opts.onError]          cb(msg)
 */
async function init(opts = {}) {
  if (_destroyed) { console.warn('[SNX-RADIO] destroyed — call SNXRadio again to rebuild'); return; }

  // Register callbacks
  if (opts.onNowPlaying)      on('nowPlaying',      opts.onNowPlaying);
  if (opts.onUpNext)          on('upNext',           opts.onUpNext);
  if (opts.onStateChange)     on('stateChange',      opts.onStateChange);
  if (opts.onAutoplayBlocked) on('autoplayBlocked',  opts.onAutoplayBlocked);
  if (opts.onError)           on('error',            opts.onError);
  // Stage 3 callbacks
  if (opts.onProgramChange)   on('programChange',    opts.onProgramChange);
  if (opts.onScheduleChange)  on('scheduleChange',   opts.onScheduleChange);
  if (opts.onSettingsChange)  on('settingsChange',   opts.onSettingsChange);
  if (opts.onRecentlyPlayed)  on('recentlyPlayed',   opts.onRecentlyPlayed);
  // Live data callbacks
  if (opts.onTracksChange)    on('tracksChange',     opts.onTracksChange);

  _emit('stateChange', 'loading');

  try {
    // Step 1 — resolve Firebase handles
    _resolveFirebase();

    // Step 2 — sync server time (non-blocking; falls back to local clock)
    _syncServerTime().catch(() => {});

    // Step 3 — subscribe to station state (starts playback when data arrives)
    _subscribeStation();

    // Step 4 — subscribe to schedule, programs, settings (Stage 3)
    _subscribeSchedule();
    _subscribePrograms();
    _subscribeSettings();

  } catch (err) {
    console.error('[SNX-RADIO] init error:', err.message);
    _emit('error', err.message);
    _emit('stateChange', 'error');
  }
}

/**
 * User tapped "TAP TO LISTEN" — unlock audio and join current timeline position.
 */
async function tapToListen() {
  _userInteracted = true;
  if (_playing) return;
  if (_station && _station.enabled && _playlist.length > 0) {
    await _joinTimeline();
  }
}

/**
 * Pause the local audio (does not affect other listeners' state).
 */
function stop() {
  _stopAudio();
  _playing = false;
  _emit('stateChange', 'paused');
}

/**
 * pageLeave() — called when the listener navigates AWAY from the Radio page.
 *
 * Pauses local browser audio immediately.
 * Does NOT touch global station state, epochMs, playlist, or Firestore.
 * The deterministic timeline continues running globally.
 */
function pageLeave() {
  if (_audioEl && !_audioEl.paused) {
    _audioEl.pause();
  }
  _playing = false;
  // Release coordinator ownership so other audio sources are not blocked
  if (window.SNXAudioCoordinator) {
    window.SNXAudioCoordinator.release('radio');
  }
  _stopTick();
  console.log('[SNX-RADIO] pageLeave — local audio paused, global station unchanged');
}

/**
 * pageEnter() — called when the listener returns to the Radio page.
 *
 * Re-joins the live deterministic timeline from the current on-air position.
 * Does NOT resume from the position where the user left — always syncs to
 * the authoritative server-time-based position.
 *
 * If the engine has not been initialised yet, this is a no-op (init() handles it).
 */
async function pageEnter() {
  if (_destroyed) return;
  // Engine not ready yet — init() will handle the first join
  if (!_station || !_playlist.length) return;
  // Station is off-air — nothing to resume
  if (!_station.enabled || _station.mode === MODE_OFF_AIR) return;
  // Re-register with coordinator (ensures other audio is ducked)
  if (window.SNXAudioCoordinator) {
    window.SNXAudioCoordinator.request('radio');
  }
  console.log('[SNX-RADIO] pageEnter — resyncing to live timeline');
  await _joinTimeline();
}

/**
 * Set audio volume 0.0–1.0.
 */
function setVolume(v) {
  if (_audioEl) _audioEl.volume = Math.max(0, Math.min(1, v));
}

/* ══════════════════════════════════════════════════════════════
   DESTROY
══════════════════════════════════════════════════════════════ */

function destroy() {
  _destroyed = true;
  _stopTick();
  _stopAudio();
  if (_stationUnsub)  { try { _stationUnsub(); }  catch (_) {} _stationUnsub  = null; }
  if (_scheduleUnsub) { try { _scheduleUnsub(); } catch (_) {} _scheduleUnsub = null; }
  if (_programsUnsub) { try { _programsUnsub(); } catch (_) {} _programsUnsub = null; }
  if (_settingsUnsub) { try { _settingsUnsub(); } catch (_) {} _settingsUnsub = null; }
  if (_playlistUnsub) { try { _playlistUnsub(); } catch (_) {} _playlistUnsub = null; }
  if (_tracksUnsub)   { try { _tracksUnsub(); }   catch (_) {} _tracksUnsub   = null; }
  _subscribedPlId = null;
  _station  = null;
  _playlist = [];
  _trackIdx = -1;
  _schedule = [];
  _programs = {};
  _stationSettings = null;
  _currentProgram  = null;
  Object.keys(_cbs).forEach(k => { delete _cbs[k]; });
  console.log('[SNX-RADIO] destroyed');
}

/* ══════════════════════════════════════════════════════════════
   FIREBASE RESOLUTION
══════════════════════════════════════════════════════════════ */

function _resolveFirebase() {
  // Prefer the shared SNS firebase-config.js exports via window globals
  // window._snxFirestore is the modular bundle { db, collection, ... }; extract .db
  if (!_firestore) {
    _firestore = (window._snxFirestore && window._snxFirestore.db)
      || (window.firebase && window.firebase.firestore && window.firebase.firestore());
    if (!_firestore) throw new Error('Firestore not available — ensure firebase-config.js is loaded');
  }
  if (!_liveDB) {
    _liveDB = window._snxLiveDB || null;
    // If window._snxLiveDB not set, try the SNX exposed liveDB
    if (!_liveDB && window._snxFirebaseApp) {
      try {
        const { getDatabase } = window._snxFirebaseModules || {};
        if (getDatabase) _liveDB = getDatabase(window._snxFirebaseApp);
      } catch (_) {}
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   SERVER TIME SYNC
   Uses Firebase RTDB /.info/serverTimeOffset (ms).
   If RTDB not available, falls back to local clock (offset = 0).
══════════════════════════════════════════════════════════════ */

async function _syncServerTime() {
  return new Promise((resolve) => {
    try {
      // Prefer window._snxLiveDB which is set by firebase-config.js
      const db = window._snxLiveDB || _liveDB;
      if (!db) { _timeOffsetReady = true; resolve(); return; }

      // Firebase SDK path depends on version
      // Try modern modular SDK first, then compat
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) { _timeOffsetReady = true; resolve(); }
      }, 4000);

      const _handleOffset = (snapshot) => {
        resolved = true;
        clearTimeout(timeout);
        const offset = snapshot.val();
        if (typeof offset === 'number') {
          _timeOffset = offset;
          console.log('[SNX-RADIO] Server time offset:', offset, 'ms');
        }
        _timeOffsetReady = true;
        resolve();
      };

      // Try modular SDK (Firebase 9+)
      if (window._snxFirebaseModules && window._snxFirebaseModules.ref && window._snxFirebaseModules.onValue) {
        const { ref, onValue } = window._snxFirebaseModules;
        const offsetRef = ref(db, RTDB_TIME_PATH);
        const unsub = onValue(offsetRef, (snap) => {
          _handleOffset(snap);
          unsub(); // one-time read
        }, () => { _timeOffsetReady = true; resolve(); });
      } else if (db.ref) {
        // Compat SDK
        db.ref(RTDB_TIME_PATH).once('value').then(_handleOffset).catch(() => {
          _timeOffsetReady = true; resolve();
        });
      } else {
        _timeOffsetReady = true;
        resolve();
      }
    } catch (e) {
      _timeOffsetReady = true;
      resolve();
    }
  });
}

/**
 * Returns current authoritative server time in ms.
 * Corrected by Firebase RTDB serverTimeOffset when available.
 */
function _serverNow() {
  return Date.now() + _timeOffset;
}

/* ══════════════════════════════════════════════════════════════
   STATION SUBSCRIPTION
   Listens to /siteSettings/radioStation for real-time state.
══════════════════════════════════════════════════════════════ */

function _subscribeStation() {
  if (!_firestore) return;

  // Use modular Firestore SDK helpers — loaded in same session as firebase-config.js
  const mods = window._snxFirestore || window._snxFirestoreModules;
  if (mods && mods.doc && mods.onSnapshot) {
    const { doc, onSnapshot } = mods;
    const stationRef = doc(_firestore, COL_SITE, DOC_STATION);
    _stationUnsub = onSnapshot(stationRef, (snap) => {
      _onStationSnapshot(snap.exists() ? snap.data() : null);
    }, (err) => {
      console.error('[SNX-RADIO] station snapshot error:', err.message);
      _emit('stateChange', 'error');
    });
  } else if (_firestore.collection) {
    // Compat SDK
    const unsub = _firestore.collection(COL_SITE).doc(DOC_STATION).onSnapshot(
      (snap) => _onStationSnapshot(snap.exists ? snap.data() : null),
      (err) => { console.error('[SNX-RADIO] station error:', err.message); }
    );
    _stationUnsub = unsub;
  }
}

async function _onStationSnapshot(data) {
  if (_destroyed) return;

  const prev = _station ? { ..._station } : null;
  _station = data ? {
    enabled:    !!data.enabled,
    mode:       data.mode || MODE_RADIO,
    epochMs:    _toMs(data.epochMs || data.epoch || data.startedAt),
    playlistId: data.playlistId || data.currentPlaylistId || null,
    updatedAt:  _toMs(data.updatedAt),
  } : null;

  // OFF AIR
  if (!_station || !_station.enabled || _station.mode === MODE_OFF_AIR) {
    _stopAudio();
    _stopTick();
    _playing  = false;
    _playlist = [];
    _trackIdx = -1;
    _emit('stateChange', 'off-air');
    _emit('nowPlaying',  null);
    _emit('upNext',      null);
    return;
  }

  // PERSONAL_LIVE mode — radio yields; do not start audio
  if (_station.mode === MODE_PERSONAL_LIVE) {
    _stopAudio();
    _playing = false;
    _emit('stateChange', 'personal-live');
    return;
  }

  // RADIO mode — live-subscribe to playlist + tracks if not already
  const playlistChanged = !prev || prev.playlistId !== _station.playlistId;
  const epochChanged    = prev && prev.epochMs !== _station.epochMs;

  // Ensure /radioTracks collection is subscribed (metadata live updates)
  if (!_tracksUnsub) _subscribeRadioTracks();

  if (playlistChanged) {
    _emit('stateChange', 'loading');
    // Subscribe to playlist doc for live updates (replaces one-time load)
    await _subscribePlaylistLive(_station.playlistId);
  }

  if (_playlist.length === 0) {
    _emit('stateChange', 'off-air');
    _emit('error', 'No tracks in playlist');
    return;
  }

  // New epoch = station was restarted — resync from start
  if (epochChanged || playlistChanged || _trackIdx < 0) {
    await _joinTimeline();
  }
}

/* ══════════════════════════════════════════════════════════════
   PLAYLIST LOADING
   Reads /radioPlaylists/{plId} which contains trackIds[],
   then fetches each track from /radioTracks or /music.
══════════════════════════════════════════════════════════════ */

async function _loadPlaylist(playlistId) {
  if (!playlistId) {
    // No specific playlist — try loading all enabled radioTracks
    _playlist = await _fetchAllRadioTracks();
    return;
  }

  try {
    const plData = await _getDoc(COL_PLAYLISTS, playlistId);
    if (!plData || !plData.enabled) {
      console.warn('[SNX-RADIO] Playlist not found or disabled:', playlistId);
      _playlist = [];
      return;
    }

    const trackIds = plData.trackIds || plData.tracks || [];
    if (trackIds.length === 0) {
      _playlist = [];
      return;
    }

    const tracks = await _fetchTracks(trackIds);
    _playlist = tracks.filter(t => _isValidTrack(t));
    console.log('[SNX-RADIO] Playlist loaded:', _playlist.length, 'tracks');
  } catch (err) {
    console.error('[SNX-RADIO] loadPlaylist error:', err.message);
    _playlist = [];
  }
}

async function _fetchTracks(trackIds) {
  const results = [];
  // Batch in groups of 10 to avoid large Promise.all
  for (let i = 0; i < trackIds.length; i += 10) {
    const batch = trackIds.slice(i, i + 10);
    const settled = await Promise.allSettled(
      batch.map(async (id) => {
        // Try radioTracks first, then public music catalogue
        let data = await _getDoc(COL_TRACKS, id);
        if (!data) data = await _getDoc(COL_MUSIC, id);
        if (!data) return null;
        return _normaliseTrack(id, data);
      })
    );
    settled.forEach(r => { if (r.status === 'fulfilled' && r.value) results.push(r.value); });
  }
  return results;
}

async function _fetchAllRadioTracks() {
  // Fallback: load all enabled radioTracks.
  // No orderBy in the Firestore query — single-field equality needs no composite index.
  // Sort by createdAt client-side after fetch.
  try {
    const mods = window._snxFirestore || window._snxFirestoreModules;
    let docs = [];
    if (mods && mods.collection && mods.query && mods.where && mods.getDocs) {
      const { collection, query, where, getDocs } = mods;
      const q = query(
        collection(_firestore, COL_TRACKS),
        where('enabled', '==', true)
      );
      const snap = await getDocs(q);
      snap.forEach(d => { docs.push({ id: d.id, ...d.data() }); });
    } else if (_firestore.collection) {
      const snap = await _firestore.collection(COL_TRACKS)
        .where('enabled', '==', true)
        .get();
      snap.forEach(d => { docs.push({ id: d.id, ...d.data() }); });
    }
    // Sort by createdAt ascending (matches original intent) — client-side, no index needed
    docs.sort((a, b) => {
      const ta = a.createdAt ? (a.createdAt.seconds || a.createdAt / 1000 || 0) : 0;
      const tb = b.createdAt ? (b.createdAt.seconds || b.createdAt / 1000 || 0) : 0;
      return ta - tb;
    });
    return docs.map(d => _normaliseTrack(d.id, d)).filter(_isValidTrack);
  } catch (e) {
    console.error('[SNX-RADIO] fetchAllRadioTracks:', e.message);
    return [];
  }
}

/* ══════════════════════════════════════════════════════════════
   LIVE PLAYLIST SUBSCRIPTION
   Watches /radioPlaylists/{playlistId} for changes to trackIds.
   Updates _playlist WITHOUT restarting the current song.
   Called from _onStationSnapshot when playlistId is set/changed.
══════════════════════════════════════════════════════════════ */

async function _subscribePlaylistLive(playlistId) {
  // Tear down any existing playlist subscription
  if (_playlistUnsub) {
    try { _playlistUnsub(); } catch (_) {}
    _playlistUnsub   = null;
    _subscribedPlId  = null;
  }

  if (!playlistId) {
    // No playlist doc — subscribe to all enabled radioTracks directly
    _subscribeAllTracksFallback();
    return;
  }

  if (!_firestore) return;
  const mods = window._snxFirestore || window._snxFirestoreModules;
  if (!mods || !mods.doc || !mods.onSnapshot) {
    // Fall back to one-time load
    await _loadPlaylist(playlistId);
    return;
  }

  _subscribedPlId = playlistId;

  return new Promise((resolve) => {
    let resolved = false;
    const plRef = mods.doc(_firestore, COL_PLAYLISTS, playlistId);
    const unsub = mods.onSnapshot(plRef, async (snap) => {
      if (_destroyed) return;

      const data = snap.exists() ? snap.data() : null;
      if (!data || !data.enabled) {
        _playlist = [];
        if (!resolved) { resolved = true; resolve(); }
        if (_playing) {
          _emit('stateChange', 'off-air');
          _emit('nowPlaying', null);
          _emit('upNext', null);
        }
        return;
      }

      const newTrackIds = data.trackIds || data.tracks || [];

      // Identify which track IDs are new / changed vs already in _playlist
      const existingIds  = new Set(_playlist.map(t => t.id));
      const newIds       = new Set(newTrackIds);

      // Fetch only tracks not already in memory
      const toFetch = newTrackIds.filter(id => !existingIds.has(id));
      let   fetched = [];
      if (toFetch.length > 0) {
        fetched = await _fetchTracks(toFetch);
      }

      // Build merged map: existing tracks + newly fetched
      const trackMap = {};
      _playlist.forEach(t => { trackMap[t.id] = t; });
      fetched.forEach(t => { if (t) trackMap[t.id] = t; });

      // Rebuild playlist in the order Founder specified
      const newPlaylist = newTrackIds
        .map(id => trackMap[id])
        .filter(t => _isValidTrack(t));

      // --- PLAYBACK PROTECTION ---
      // Find whether the currently playing track is still in the new playlist
      const currentTrack = _playlist[_trackIdx] || null;
      const currentStillPresent = currentTrack
        ? newPlaylist.some(t => t.id === currentTrack.id)
        : false;

      // Update playlist in-place
      _playlist = newPlaylist;

      if (!resolved) {
        resolved = true;
        resolve();
        return; // First snapshot handled by _onStationSnapshot → _joinTimeline
      }

      // Subsequent snapshots = Founder changed playlist while station is running
      if (_playlist.length === 0) {
        _stopAudio();
        _playing = false;
        _emit('stateChange', 'off-air');
        _emit('nowPlaying', null);
        _emit('upNext', null);
        return;
      }

      // Update track index to match current track in new order
      if (currentStillPresent && currentTrack) {
        const newIdx = _playlist.findIndex(t => t.id === currentTrack.id);
        if (newIdx !== -1) _trackIdx = newIdx;
      } else if (_trackIdx >= _playlist.length) {
        // Current index out of bounds — resync gently
        _trackIdx = Math.max(0, _playlist.length - 1);
      }

      // Always re-emit upNext (it may have changed)
      _notifyUpNext();
      // Re-emit nowPlaying metadata if current track's metadata changed
      _notifyNowPlaying();

      console.log('[SNX-RADIO] Playlist live update — tracks:', _playlist.length,
        currentStillPresent ? '(current song preserved)' : '(current song removed — resyncing)');

      // If current song was removed, resync to timeline
      if (!currentStillPresent && _playing) {
        await _joinTimeline();
      }
    }, (err) => {
      console.warn('[SNX-RADIO] playlist snapshot error:', err.message);
      if (!resolved) { resolved = true; resolve(); }
    });

    _playlistUnsub = unsub;
  });
}

/**
 * Fallback when no playlistId is configured.
 * Subscribes to all enabled /radioTracks documents.
 */
function _subscribeAllTracksFallback() {
  if (_playlistUnsub) { try { _playlistUnsub(); } catch (_) {} _playlistUnsub = null; }
  if (!_firestore) return;
  const mods = window._snxFirestore || window._snxFirestoreModules;
  if (!mods || !mods.collection || !mods.onSnapshot || !mods.query || !mods.where) {
    _fetchAllRadioTracks().then(tracks => { _playlist = tracks; }).catch(() => {});
    return;
  }

  const { collection, query, where, onSnapshot } = mods;
  const q = query(collection(_firestore, COL_TRACKS), where('enabled', '==', true));

  const unsub = onSnapshot(q, (snap) => {
    if (_destroyed) return;
    let docs = [];
    snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
    docs.sort((a, b) => {
      const ta = a.createdAt ? (a.createdAt.seconds || a.createdAt / 1000 || 0) : 0;
      const tb = b.createdAt ? (b.createdAt.seconds || b.createdAt / 1000 || 0) : 0;
      return ta - tb;
    });
    const newPlaylist = docs.map(d => _normaliseTrack(d.id, d)).filter(_isValidTrack);

    const currentTrack = _playlist[_trackIdx] || null;
    _playlist = newPlaylist;

    if (currentTrack) {
      const newIdx = _playlist.findIndex(t => t.id === currentTrack.id);
      if (newIdx !== -1) _trackIdx = newIdx;
    }
    _notifyNowPlaying();
    _notifyUpNext();
    _emit('tracksChange', null);
  }, (err) => {
    console.warn('[SNX-RADIO] all-tracks snapshot error:', err.message);
  });

  _playlistUnsub = unsub;
}

/* ══════════════════════════════════════════════════════════════
   LIVE RADIOTRACK COLLECTION SUBSCRIPTION
   Watches /radioTracks for metadata changes (title, artist,
   artwork, enabled status). Updates _playlist entries in-place.
   Never restarts audio — only refreshes display metadata.
   Also emits 'tracksChange' for Track Library / Request modal.
══════════════════════════════════════════════════════════════ */

function _subscribeRadioTracks() {
  if (_tracksUnsub) return; // already subscribed
  if (!_firestore) return;

  const mods = window._snxFirestore || window._snxFirestoreModules;
  if (!mods || !mods.collection || !mods.onSnapshot) return;

  const { collection, onSnapshot } = mods;
  const colRef = collection(_firestore, COL_TRACKS);

  const unsub = onSnapshot(colRef, (snap) => {
    if (_destroyed) return;

    // Build a map of all current radioTracks
    const trackMap = {};
    snap.forEach(d => { trackMap[d.id] = { id: d.id, ...d.data() }; });

    // Update any matching entries in _playlist (metadata only)
    let metaChanged = false;
    _playlist.forEach((t, i) => {
      const fresh = trackMap[t.id];
      if (!fresh) return;
      const norm = _normaliseTrack(fresh.id, fresh);
      // Detect actual metadata changes before overwriting
      if (norm.title !== t.title || norm.artist !== t.artist ||
          norm.artworkUrl !== t.artworkUrl || norm.enabled !== t.enabled) {
        _playlist[i] = norm;
        metaChanged = true;
      }
    });

    if (metaChanged) {
      _notifyNowPlaying();
      _notifyUpNext();
    }

    // Always notify track library / request modal listeners
    _emit('tracksChange', Object.values(trackMap));

    console.log('[SNX-RADIO] /radioTracks live update —', snap.size, 'tracks');
  }, (err) => {
    console.warn('[SNX-RADIO] radioTracks snapshot error:', err.message);
    _tracksUnsub = null; // allow re-subscription on next attempt
  });

  _tracksUnsub = unsub;
}

/* ══════════════════════════════════════════════════════════════
   TRACK NORMALISATION
   Accepts both /music and /radioTracks field schemas.
══════════════════════════════════════════════════════════════ */

function _normaliseTrack(id, data) {
  return {
    id:         id,
    title:      data.title       || data.name       || 'Unknown',
    artist:     data.artist      || data.artistName  || 'Unknown Artist',
    album:      data.album       || null,
    audioUrl:   data.audioUrl    || data.musicUrl    || data.downloadURL || data.url || null,
    artworkUrl: data.artworkUrl  || data.artUrl      || data.coverImage  || data.coverUrl || null,
    duration:   Number(data.duration || data.durationSec || 0),
    enabled:    data.enabled !== false,
    explicit:   !!data.explicit,
    createdAt:  _toMs(data.createdAt || data.uploadedAt),
  };
}

function _isValidTrack(t) {
  return t && t.audioUrl && t.duration >= MIN_DURATION_S && t.enabled !== false;
}

/* ══════════════════════════════════════════════════════════════
   DETERMINISTIC TIMELINE ENGINE
   Core algorithm — pure function, fully testable.

   Given:
     epochMs    — when station "started" (server time ms)
     tracks     — ordered array with .duration (seconds)
     nowMs      — current server time ms

   Returns:
     { trackIdx, positionSec, trackId, totalElapsedSec }

   Algorithm:
     1. elapsed = (nowMs - epochMs) / 1000
     2. totalDuration = sum of all track durations (one full loop)
     3. loopElapsed = elapsed % totalDuration  (handles loops)
     4. Walk tracks accumulating durations until acc > loopElapsed
     5. trackIdx = that index, positionSec = loopElapsed - accBefore
══════════════════════════════════════════════════════════════ */

function _timeline(epochMs, tracks, nowMs) {
  if (!tracks || tracks.length === 0) return null;

  const validTracks = tracks.filter(t => t.duration >= MIN_DURATION_S);
  if (validTracks.length === 0) return null;

  const elapsed     = Math.max(0, (nowMs - epochMs) / 1000);
  const totalDur    = validTracks.reduce((s, t) => s + t.duration, 0);

  if (totalDur <= 0) return null;

  const loopElapsed = elapsed % totalDur;

  let acc = 0;
  for (let i = 0; i < validTracks.length; i++) {
    const dur = validTracks[i].duration;
    if (loopElapsed < acc + dur) {
      return {
        trackIdx:        i,
        positionSec:     loopElapsed - acc,
        trackId:         validTracks[i].id,
        totalElapsedSec: elapsed,
        loopElapsedSec:  loopElapsed,
        totalDurSec:     totalDur,
      };
    }
    acc += dur;
  }

  // Edge case: exactly at boundary — start of first track (next loop)
  return {
    trackIdx:        0,
    positionSec:     0,
    trackId:         validTracks[0].id,
    totalElapsedSec: elapsed,
    loopElapsedSec:  loopElapsed,
    totalDurSec:     totalDur,
  };
}

/* ══════════════════════════════════════════════════════════════
   JOIN TIMELINE
   Called when: init, station restart, playlist change, page reload
══════════════════════════════════════════════════════════════ */

async function _joinTimeline() {
  if (!_station || !_station.enabled || _playlist.length === 0) return;

  const epoch = _station.epochMs;
  if (!epoch || epoch <= 0) {
    // Station has no epoch yet — play from the beginning
    _trackIdx = 0;
    _trackPos = 0;
  } else {
    const result = _timeline(epoch, _playlist, _serverNow());
    if (!result) return;
    _trackIdx = result.trackIdx;
    _trackPos = result.positionSec;
  }

  console.log('[SNX-RADIO] Join timeline — track:', _trackIdx,
    '(' + (_playlist[_trackIdx]?.title || '?') + ')',
    'pos:', _trackPos.toFixed(1) + 's');

  _notifyNowPlaying();
  _notifyUpNext();

  if (!_userInteracted) {
    // Try autoplay — if it fails, notify the UI to show TAP TO LISTEN
    const blocked = await _tryPlay(_trackIdx, _trackPos);
    if (blocked) {
      _emit('autoplayBlocked', null);
      _emit('stateChange', 'tap-to-listen');
      console.log('[SNX-RADIO] Autoplay blocked — showing TAP TO LISTEN');
    }
  } else {
    await _loadAndPlay(_trackIdx, _trackPos);
  }

  _startTick();
}

/* ══════════════════════════════════════════════════════════════
   AUDIO ENGINE
══════════════════════════════════════════════════════════════ */

function _ensureAudio() {
  if (_audioEl) return;
  _audioEl = document.createElement('audio');
  _audioEl.preload    = 'auto';
  _audioEl.crossOrigin = 'anonymous';
  _audioEl.volume     = 0.9;

  _audioEl.addEventListener('play',  () => {
    _playing = true;
    _emit('stateChange', 'on-air');
    if (window.SNXAudioCoordinator) window.SNXAudioCoordinator.request('radio');
  });
  _audioEl.addEventListener('pause', () => {
    // Only mark not-playing if we didn't initiate a track change
    if (!_transitioning) {
      _playing = false;
    }
  });
  _audioEl.addEventListener('ended', () => {
    _onTrackEnded();
  });
  _audioEl.addEventListener('error', (e) => {
    const msg = _audioEl.error ? _audioEl.error.message : 'Audio error';
    console.warn('[SNX-RADIO] Audio error:', msg);
    // Try next track after a brief delay
    setTimeout(() => _advanceTrack(), 1500);
  });

  document.body.appendChild(_audioEl);
}

let _transitioning = false;

async function _tryPlay(idx, positionSec) {
  _ensureAudio();
  const track = _playlist[idx];
  if (!track || !track.audioUrl) return false;

  _audioEl.src = track.audioUrl;
  // Do NOT set currentTime before load() — browser resets it automatically on src change.
  _audioEl.load();

  return new Promise((resolve) => {
    let _resolved = false;  // guard: only resolve once

    const doPlay = () => {
      if (positionSec > 1) {
        try { _audioEl.currentTime = Math.min(positionSec, (_audioEl.duration || positionSec) - 0.1); } catch (_) {}
      }
      _audioEl.play()
        .then(() => { if (!_resolved) { _resolved = true; resolve(false); } })  // false = NOT blocked
        .catch(() => { if (!_resolved) { _resolved = true; resolve(true);  } }); // true  = blocked
    };

    const onCanPlay = () => {
      clearTimeout(fallbackTimer);
      doPlay();
    };

    _audioEl.addEventListener('canplay', onCanPlay, { once: true });

    // Timeout in case canplay never fires (e.g. slow network or bad URL)
    const fallbackTimer = setTimeout(() => {
      _audioEl.removeEventListener('canplay', onCanPlay);
      if (!_resolved) doPlay();
    }, 3000);
  });
}

async function _loadAndPlay(idx, positionSec) {
  _ensureAudio();
  const track = _playlist[idx];
  if (!track || !track.audioUrl) return;

  _transitioning = true;
  _audioEl.src = track.audioUrl;
  // Do NOT set currentTime before load() — browser resets it automatically on src change.
  _audioEl.load();

  await new Promise((resolve) => {
    const onReady = () => {
      _audioEl.removeEventListener('canplay', onReady);
      resolve();
    };
    _audioEl.addEventListener('canplay', onReady, { once: true });
    setTimeout(resolve, 5000); // fallback if canplay never fires
  });

  if (positionSec > 1) {
    try { _audioEl.currentTime = Math.min(positionSec, (_audioEl.duration || positionSec) - 0.1); } catch (_) {}
  }

  _transitioning = false;

  try {
    await _audioEl.play();
    // play() resolved → 'play' event fired or is about to fire → _playing set to true
  } catch (e) {
    // play() was rejected — most commonly NotAllowedError (autoplay blocked) on
    // page return or mobile browsers.  Reset _userInteracted so the next call to
    // _joinTimeline() will go through _tryPlay and show TAP TO LISTEN properly.
    console.warn('[SNX-RADIO] _loadAndPlay: play() rejected:', e.name, e.message);
    _userInteracted = false;
    _emit('autoplayBlocked', null);
    _emit('stateChange', 'tap-to-listen');
  }
}

function _stopAudio() {
  if (_audioEl) {
    _audioEl.pause();
    _audioEl.src = '';
  }
}

/* ══════════════════════════════════════════════════════════════
   TRACK ADVANCE
══════════════════════════════════════════════════════════════ */

function _onTrackEnded() {
  _advanceTrack();
}

function _advanceTrack() {
  if (!_playlist.length) return;
  _trackIdx = (_trackIdx + 1) % _playlist.length;
  _trackPos = 0;
  _notifyNowPlaying();
  _notifyUpNext();
  _loadAndPlay(_trackIdx, 0).catch(err => console.warn('[SNX-RADIO] advance play error:', err.message));
}

/* ══════════════════════════════════════════════════════════════
   TICK
   Runs every second to:
   – detect drift vs authoritative timeline (re-sync if >5s off)
   – keep UI Now Playing / Up Next current
══════════════════════════════════════════════════════════════ */

function _startTick() {
  _stopTick();
  _tickTimer = setInterval(_tick, TICK_MS);
}

function _stopTick() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

function _tick() {
  if (_destroyed || !_station || !_station.enabled) return;
  if (!_playing) return;
  if (!_audioEl || _audioEl.paused) return;
  if (_playlist.length === 0) return;

  const epoch = _station.epochMs;
  if (!epoch || epoch <= 0) return;

  const result = _timeline(epoch, _playlist, _serverNow());
  if (!result) return;

  const authoritative = result.positionSec;
  const actual        = _audioEl.currentTime;

  // Update Now Playing / Up Next if track changed (e.g. very fast forward)
  if (result.trackIdx !== _trackIdx) {
    _trackIdx = result.trackIdx;
    _trackPos = result.positionSec;
    _notifyNowPlaying();
    _notifyUpNext();
    _loadAndPlay(_trackIdx, _trackPos).catch(() => {});
    return;
  }

  // Drift correction: if actual position is more than 5s off, seek
  const drift = Math.abs(actual - authoritative);
  if (drift > 5 && !_transitioning) {
    console.log('[SNX-RADIO] Drift correction:', drift.toFixed(1) + 's');
    try { _audioEl.currentTime = Math.min(authoritative, (_audioEl.duration || authoritative) - 0.1); } catch (_) {}
  }
}

/* ══════════════════════════════════════════════════════════════
   NOTIFICATIONS
══════════════════════════════════════════════════════════════ */

function _notifyNowPlaying() {
  const track = _playlist[_trackIdx] || null;
  _emit('nowPlaying', track);
}

function _notifyUpNext() {
  if (_playlist.length < 2) { _emit('upNext', null); return; }
  const next = _playlist[(_trackIdx + 1) % _playlist.length];
  _emit('upNext', next || null);
}

/* ══════════════════════════════════════════════════════════════
   FIRESTORE HELPERS
══════════════════════════════════════════════════════════════ */

async function _getDoc(collection, id) {
  try {
    const mods = window._snxFirestore || window._snxFirestoreModules;
    if (mods && mods.doc && mods.getDoc) {
      const ref  = mods.doc(_firestore, collection, id);
      const snap = await mods.getDoc(ref);
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    } else if (_firestore.collection) {
      const snap = await _firestore.collection(collection).doc(id).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    }
  } catch (e) {
    console.warn('[SNX-RADIO] getDoc error', collection, id, e.message);
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════════════════════ */

function _toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.toMillis) return v.toMillis();   // Firestore Timestamp
  if (v.seconds)  return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  if (v instanceof Date) return v.getTime();
  const parsed = Number(v);
  return isNaN(parsed) ? 0 : parsed;
}

/* ══════════════════════════════════════════════════════════════
   EVENT EMITTER
══════════════════════════════════════════════════════════════ */

function on(event, cb) {
  if (!_cbs[event]) _cbs[event] = [];
  _cbs[event].push(cb);
}

function off(event, cb) {
  if (!_cbs[event]) return;
  if (cb) { _cbs[event] = _cbs[event].filter(f => f !== cb); }
  else    { delete _cbs[event]; }
}

function _emit(event, data) {
  (_cbs[event] || []).forEach(cb => { try { cb(data); } catch (e) { console.error('[SNX-RADIO] cb error:', e.message); } });
  try { document.dispatchEvent(new CustomEvent('snxRadio:' + event, { detail: data })); } catch (_) {}
}

/* ══════════════════════════════════════════════════════════════
   AUDIO COORDINATOR INTEGRATION
   Listen for coordinator commands to pause/resume radio
   (e.g. when a Live stream starts, radio yields gracefully)
══════════════════════════════════════════════════════════════ */

(function _hookCoordinator() {
  if (!window.SNXAudioCoordinator) {
    // Retry once after DOM ready in case coordinator loads after this script
    document.addEventListener('DOMContentLoaded', _hookCoordinator, { once: true });
    return;
  }
  window.SNXAudioCoordinator.on('pause', function (source) {
    if (source === 'radio' && _audioEl && !_audioEl.paused) {
      _audioEl.pause();
    }
  });
  window.SNXAudioCoordinator.on('kill', function (source) {
    if (source === 'radio') {
      _stopAudio();
      _playing = false;
    }
  });
})();

/* ══════════════════════════════════════════════════════════════
   STATION ADMIN HELPERS
   Used by the founder/admin UI — not part of the playback engine.
   These functions write to Firestore.
══════════════════════════════════════════════════════════════ */

/**
 * Start the station. Sets enabled=true and records a new epoch.
 * Only call this if the current user is the Founder (Firestore rule enforces it).
 *
 * @param {string} playlistId
 * @returns {Promise<void>}
 */
async function stationStart(playlistId) {
  await _writeStationDoc({
    enabled:    true,
    mode:       MODE_RADIO,
    playlistId: playlistId || null,
    epochMs:    _serverNow(),
    updatedAt:  _serverTimestamp(),
  });
}

/**
 * Stop the station (set enabled=false).
 * @returns {Promise<void>}
 */
async function stationStop() {
  await _writeStationDoc({
    enabled:   false,
    mode:      MODE_OFF_AIR,
    updatedAt: _serverTimestamp(),
  });
}

/**
 * Set station mode (RADIO | PERSONAL_LIVE | OFF_AIR).
 */
async function stationSetMode(mode) {
  await _writeStationDoc({ mode, updatedAt: _serverTimestamp() });
}

async function _writeStationDoc(fields) {
  try {
    const mods = window._snxFirestore || window._snxFirestoreModules;
    if (mods && mods.doc && mods.setDoc) {
      const ref = mods.doc(_firestore, COL_SITE, DOC_STATION);
      await mods.setDoc(ref, fields, { merge: true });
    } else if (_firestore.collection) {
      await _firestore.collection(COL_SITE).doc(DOC_STATION).set(fields, { merge: true });
    }
  } catch (e) {
    console.error('[SNX-RADIO] writeStationDoc error:', e.message);
    throw e;
  }
}

function _serverTimestamp() {
  const mods = window._snxFirestore || window._snxFirestoreModules;
  if (mods && mods.serverTimestamp) return mods.serverTimestamp();
  return new Date();
}

// Expose admin helpers
window.SNXRadio.stationStart  = stationStart;
window.SNXRadio.stationStop   = stationStop;
window.SNXRadio.stationSetMode = stationSetMode;

/* ══════════════════════════════════════════════════════════════
   PLAYLIST ADMIN HELPERS
   Create, update, delete playlists in /radioPlaylists/.
══════════════════════════════════════════════════════════════ */

/**
 * Create a new playlist.
 * @param {{ name, trackIds, enabled }} data
 * @returns {Promise<string>} new playlistId
 */
async function playlistCreate(data) {
  return _writeNewDoc(COL_PLAYLISTS, {
    name:      data.name || 'Untitled Playlist',
    trackIds:  data.trackIds || [],
    enabled:   data.enabled !== false,
    createdAt: _serverTimestamp(),
    updatedAt: _serverTimestamp(),
  });
}

/**
 * Update an existing playlist (merge).
 */
async function playlistUpdate(playlistId, fields) {
  await _mergeDoc(COL_PLAYLISTS, playlistId, { ...fields, updatedAt: _serverTimestamp() });
}

/**
 * Delete a playlist.
 */
async function playlistDelete(playlistId) {
  await _deleteDoc(COL_PLAYLISTS, playlistId);
}

/* ══════════════════════════════════════════════════════════════
   TRACK ADMIN HELPERS
   Add, update, delete tracks in /radioTracks/.
══════════════════════════════════════════════════════════════ */

/**
 * Add a track to /radioTracks/.
 * @param {{ title, artist, audioUrl, artworkUrl, duration, album, explicit }} data
 * @returns {Promise<string>} new trackId
 */
async function trackAdd(data) {
  return _writeNewDoc(COL_TRACKS, {
    title:      data.title      || 'Untitled',
    artist:     data.artist     || 'Unknown',
    album:      data.album      || null,
    audioUrl:   data.audioUrl   || null,
    artworkUrl: data.artworkUrl || null,
    duration:   Number(data.duration || 0),
    explicit:   !!data.explicit,
    enabled:    data.enabled !== false,
    createdAt:  _serverTimestamp(),
    createdBy:  data.createdBy  || null,
  });
}

/**
 * Update a track (merge).
 */
async function trackUpdate(trackId, fields) {
  await _mergeDoc(COL_TRACKS, trackId, { ...fields, updatedAt: _serverTimestamp() });
}

/**
 * Delete a track.
 */
async function trackDelete(trackId) {
  await _deleteDoc(COL_TRACKS, trackId);
}

// Expose admin helpers
Object.assign(window.SNXRadio, {
  playlistCreate, playlistUpdate, playlistDelete,
  trackAdd,       trackUpdate,    trackDelete,
});

/* ══════════════════════════════════════════════════════════════
   FIRESTORE WRITE HELPERS
══════════════════════════════════════════════════════════════ */

async function _writeNewDoc(col, data) {
  try {
    const mods = window._snxFirestore || window._snxFirestoreModules;
    if (mods && mods.collection && mods.addDoc) {
      const ref = await mods.addDoc(mods.collection(_firestore, col), data);
      return ref.id;
    } else if (_firestore.collection) {
      const ref = await _firestore.collection(col).add(data);
      return ref.id;
    }
  } catch (e) {
    console.error('[SNX-RADIO] writeNewDoc error:', e.message);
    throw e;
  }
}

async function _mergeDoc(col, id, data) {
  const mods = window._snxFirestore || window._snxFirestoreModules;
  if (mods && mods.doc && mods.setDoc) {
    await mods.setDoc(mods.doc(_firestore, col, id), data, { merge: true });
  } else if (_firestore.collection) {
    await _firestore.collection(col).doc(id).set(data, { merge: true });
  }
}

async function _deleteDoc(col, id) {
  const mods = window._snxFirestore || window._snxFirestoreModules;
  if (mods && mods.doc && mods.deleteDoc) {
    await mods.deleteDoc(mods.doc(_firestore, col, id));
  } else if (_firestore.collection) {
    await _firestore.collection(col).doc(id).delete();
  }
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — SCHEDULE SUBSCRIPTION
   Listens to /radioSchedule collection in real-time.
   Each doc: { hour, minute, programId, label, enabled, order }
══════════════════════════════════════════════════════════════ */

function _subscribeSchedule() {
  if (!_firestore) return;
  const mods = window._snxFirestore || window._snxFirestoreModules;
  try {
    if (mods && mods.collection && mods.onSnapshot && mods.query && mods.orderBy) {
      const { collection, query, onSnapshot, orderBy } = mods;
      const q = query(collection(_firestore, COL_SCHEDULE), orderBy('order', 'asc'));
      _scheduleUnsub = onSnapshot(q, (snap) => {
        _schedule = [];
        snap.forEach(d => {
          const data = d.data();
          _schedule.push({ slotId: d.id, ...data });
        });
        _schedule.sort((a, b) => (a.order || 0) - (b.order || 0));
        _onScheduleUpdated();
      }, (err) => console.warn('[SNX-RADIO] schedule listener error:', err.message));
    } else if (_firestore.collection) {
      const unsub = _firestore.collection(COL_SCHEDULE).orderBy('order', 'asc').onSnapshot((snap) => {
        _schedule = [];
        snap.forEach(d => _schedule.push({ slotId: d.id, ...d.data() }));
        _onScheduleUpdated();
      }, (err) => console.warn('[SNX-RADIO] schedule listener error:', err.message));
      _scheduleUnsub = unsub;
    }
  } catch (e) {
    console.warn('[SNX-RADIO] _subscribeSchedule error:', e.message);
  }
}

function _onScheduleUpdated() {
  _emit('scheduleChange', _schedule.slice());
  // Re-resolve current program if schedule changed
  _resolveCurrentProgram();
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — PROGRAMS SUBSCRIPTION
   Listens to /radioPrograms collection.
══════════════════════════════════════════════════════════════ */

function _subscribePrograms() {
  if (!_firestore) return;
  const mods = window._snxFirestore || window._snxFirestoreModules;
  try {
    if (mods && mods.collection && mods.onSnapshot) {
      const { collection, onSnapshot } = mods;
      _programsUnsub = onSnapshot(collection(_firestore, COL_PROGRAMS), (snap) => {
        _programs = {};
        snap.forEach(d => { _programs[d.id] = { id: d.id, ...d.data() }; });
        _resolveCurrentProgram();
      }, (err) => console.warn('[SNX-RADIO] programs listener error:', err.message));
    } else if (_firestore.collection) {
      const unsub = _firestore.collection(COL_PROGRAMS).onSnapshot((snap) => {
        _programs = {};
        snap.forEach(d => { _programs[d.id] = { id: d.id, ...d.data() }; });
        _resolveCurrentProgram();
      }, (err) => console.warn('[SNX-RADIO] programs listener error:', err.message));
      _programsUnsub = unsub;
    }
  } catch (e) {
    console.warn('[SNX-RADIO] _subscribePrograms error:', e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — SETTINGS SUBSCRIPTION
   Listens to /siteSettings/radioSettings.
══════════════════════════════════════════════════════════════ */

function _subscribeSettings() {
  if (!_firestore) return;
  const mods = window._snxFirestore || window._snxFirestoreModules;
  try {
    if (mods && mods.doc && mods.onSnapshot) {
      const { doc, onSnapshot } = mods;
      const ref = doc(_firestore, COL_SITE, DOC_SETTINGS);
      _settingsUnsub = onSnapshot(ref, (snap) => {
        _stationSettings = snap.exists() ? snap.data() : null;
        _emit('settingsChange', _stationSettings);
      }, (err) => console.warn('[SNX-RADIO] settings listener error:', err.message));
    } else if (_firestore.collection) {
      const unsub = _firestore.collection(COL_SITE).doc(DOC_SETTINGS).onSnapshot((snap) => {
        _stationSettings = snap.exists ? snap.data() : null;
        _emit('settingsChange', _stationSettings);
      }, (err) => console.warn('[SNX-RADIO] settings listener error:', err.message));
      _settingsUnsub = unsub;
    }
  } catch (e) {
    console.warn('[SNX-RADIO] _subscribeSettings error:', e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — SCHEDULE RESOLUTION
   Given the authoritative server time, returns the current
   schedule slot (program) that should be playing.

   Algorithm:
     1. Convert serverNow to minutes-of-day (0–1439)
     2. Walk schedule slots sorted by (hour*60 + minute) descending
     3. The last slot whose start time ≤ current minutes wins
     4. If none, wrap to the last slot of the previous day (last in list)

   Deterministic: same inputs always produce same result.
   Pure function — no side effects. Exposed for testing.

   @param {Array}  schedule   [{hour, minute, programId, label, enabled}]
   @param {number} serverNowMs  authoritative server time in milliseconds
   @returns {{ slotId, programId, label, hour, minute } | null}
══════════════════════════════════════════════════════════════ */

function _resolveSchedule(schedule, serverNowMs) {
  if (!schedule || schedule.length === 0) return null;

  const enabledSlots = schedule.filter(s => s.enabled !== false);
  if (enabledSlots.length === 0) return null;

  // Convert serverNowMs to minutes-since-midnight in UTC
  // (All schedule times are stored in UTC hours/minutes)
  const d             = new Date(serverNowMs);
  const nowMinutes    = d.getUTCHours() * 60 + d.getUTCMinutes();

  // Sort slots by start time ascending (normalise to 0–1439)
  const sorted = enabledSlots
    .map(s => ({ ...s, startMin: (Number(s.hour) || 0) * 60 + (Number(s.minute) || 0) }))
    .sort((a, b) => a.startMin - b.startMin);

  // Find the last slot whose start ≤ nowMinutes
  let active = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].startMin <= nowMinutes) { active = sorted[i]; break; }
  }

  // Midnight wrap: if no slot found for today's minutes, use the last slot of "yesterday"
  if (!active) active = sorted[sorted.length - 1];

  return active || null;
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — RESOLVE CURRENT PROGRAM
   Called when schedule or programs update.
   Determines which program is active; if its playlistId differs
   from the current one, triggers a playlist reload.
══════════════════════════════════════════════════════════════ */

function _resolveCurrentProgram() {
  const slot = _resolveSchedule(_schedule, _serverNow());
  if (!slot) {
    if (_currentProgram !== null) {
      _currentProgram = null;
      _emit('programChange', null);
    }
    return;
  }

  const prog = _programs[slot.programId];
  const prev = _currentProgram;

  _currentProgram = prog
    ? { ...prog, slotLabel: slot.label || prog.name, hour: slot.hour, minute: slot.minute }
    : { id: slot.programId, name: slot.label || 'Program', slotLabel: slot.label, hour: slot.hour, minute: slot.minute };

  // Notify UI if program changed
  const programChanged = !prev || prev.id !== slot.programId;
  if (programChanged) {
    _emit('programChange', _currentProgram);

    // If station is running and the new program has a different playlist,
    // trigger a playlist reload via the station snapshot handler.
    if (_station && _station.enabled && prog && prog.playlistId && prog.playlistId !== _station.playlistId) {
      console.log('[SNX-RADIO] Program changed → new playlist:', prog.playlistId);
      _loadPlaylist(prog.playlistId).then(() => {
        if (_playlist.length > 0) _joinTimeline();
      }).catch(e => console.warn('[SNX-RADIO] program playlist load error:', e.message));
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — RECENTLY PLAYED
   Calculates the N tracks that played before the current one,
   using the deterministic timeline. Pure math — no Firestore read.

   @returns {Array<{ title, artist, artworkUrl, duration, endedSecondsAgo }>}
══════════════════════════════════════════════════════════════ */

function _recentlyPlayed() {
  if (!_station || !_station.enabled || _playlist.length === 0) return [];
  if (!_station.epochMs || _station.epochMs <= 0) return [];

  const now   = _serverNow();
  const tl    = _timeline(_station.epochMs, _playlist, now);
  if (!tl) return [];

  const result = [];
  let   idx    = tl.trackIdx;
  let   posInTrack = tl.positionSec;  // how far into current track

  // Walk backwards through tracks
  for (let i = 0; i < RECENTLY_PLAYED_COUNT; i++) {
    // Go to previous track
    idx = (idx - 1 + _playlist.length) % _playlist.length;
    const t = _playlist[idx];
    if (!t) break;

    result.push({
      id:          t.id,
      title:       t.title,
      artist:      t.artist,
      artworkUrl:  t.artworkUrl || null,
      duration:    t.duration,
    });
  }

  return result;
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — ADMIN HELPERS: PROGRAMS
══════════════════════════════════════════════════════════════ */

async function programCreate(data) {
  return _writeNewDoc(COL_PROGRAMS, {
    name:       data.name       || 'Untitled Program',
    artwork:    data.artwork    || null,
    playlistId: data.playlistId || null,
    enabled:    data.enabled    !== false,
    createdAt:  _serverTimestamp(),
    updatedAt:  _serverTimestamp(),
  });
}

async function programUpdate(programId, fields) {
  await _mergeDoc(COL_PROGRAMS, programId, { ...fields, updatedAt: _serverTimestamp() });
}

async function programDelete(programId) {
  await _deleteDoc(COL_PROGRAMS, programId);
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — ADMIN HELPERS: SCHEDULE SLOTS
══════════════════════════════════════════════════════════════ */

async function scheduleSlotCreate(data) {
  return _writeNewDoc(COL_SCHEDULE, {
    hour:      Number(data.hour)      || 0,
    minute:    Number(data.minute)    || 0,
    programId: data.programId         || null,
    label:     data.label             || '',
    enabled:   data.enabled           !== false,
    order:     Number(data.order)     || 0,
    createdAt: _serverTimestamp(),
    updatedAt: _serverTimestamp(),
  });
}

async function scheduleSlotUpdate(slotId, fields) {
  await _mergeDoc(COL_SCHEDULE, slotId, { ...fields, updatedAt: _serverTimestamp() });
}

async function scheduleSlotDelete(slotId) {
  await _deleteDoc(COL_SCHEDULE, slotId);
}

/* ══════════════════════════════════════════════════════════════
   STAGE 3 — ADMIN HELPERS: STATION SETTINGS
══════════════════════════════════════════════════════════════ */

async function settingsUpdate(fields) {
  const mods = window._snxFirestore || window._snxFirestoreModules;
  try {
    if (mods && mods.doc && mods.setDoc) {
      const ref = mods.doc(_firestore, COL_SITE, DOC_SETTINGS);
      await mods.setDoc(ref, { ...fields, updatedAt: _serverTimestamp() }, { merge: true });
    } else if (_firestore && _firestore.collection) {
      await _firestore.collection(COL_SITE).doc(DOC_SETTINGS).set(
        { ...fields, updatedAt: _serverTimestamp() }, { merge: true }
      );
    }
  } catch (e) {
    console.error('[SNX-RADIO] settingsUpdate error:', e.message);
    throw e;
  }
}

// Expose Stage 3 admin helpers
Object.assign(window.SNXRadio, {
  programCreate, programUpdate, programDelete,
  scheduleSlotCreate, scheduleSlotUpdate, scheduleSlotDelete,
  settingsUpdate,
});

/* ══════════════════════════════════════════════════════════════
   FUTURE LIVE INTEGRATION — placeholder interface
   These are clean event hooks / stubs for future source-switching.
   DO NOT build fake functionality — these exist only to define
   the interface boundary.
══════════════════════════════════════════════════════════════ */

window.SNXRadio._sourceInterface = {
  /**
   * Notify the radio engine that a live source became active.
   * The engine will yield (PERSONAL_LIVE mode) automatically via
   * the station document — this is a UI-layer convenience hook only.
   * @param {string} sourceType 'PERSONAL_LIVE' | 'MEDIA_SERVER'
   */
  notifySourceActive(sourceType) {
    console.log('[SNX-RADIO] Future source-active notification received:', sourceType);
    // Real implementation: update /siteSettings/radioStation mode via stationSetMode()
    // when the external source system is built.
  },

  /**
   * Notify the radio engine that the live source ended.
   * Radio will resume normal playback when station mode returns to RADIO.
   */
  notifySourceEnded(sourceType) {
    console.log('[SNX-RADIO] Future source-ended notification received:', sourceType);
  },
};

/* ══════════════════════════════════════════════════════════════
   STARTUP LOG
══════════════════════════════════════════════════════════════ */

console.log('[SNX-RADIO] snx-radio.js loaded — version', RADIO_VERSION);

})(); // end IIFE
