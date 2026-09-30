/**
 * snx-broadcast/src/sources.js
 *
 * Source abstraction layer.
 *
 * A "source" encapsulates one stream of audio/metadata that the Broadcast
 * Engine can encode and send to external destinations.
 *
 * Stage 4A implements: RadioSource
 * Future:              TVSource, PersonalLiveSource
 *
 * Source interface (all sources must implement):
 *   async init()            — connect to Firebase, start listeners
 *   destroy()               — cleanup listeners
 *   getState()              — returns SourceState object (see below)
 *   on(event, handler)      — subscribe to events
 *   off(event, handler)     — unsubscribe
 *
 * Events emitted by any source:
 *   'trackChange'   payload: { track, positionSec }
 *   'stateChange'   payload: 'on-air' | 'off-air' | 'error'
 *   'error'         payload: string message
 *
 * SourceState shape:
 *   {
 *     sourceType:   'RADIO' | 'TV' | 'PERSONAL_LIVE',
 *     active:       boolean,
 *     track:        { id, title, artist, audioUrl, artworkUrl, duration } | null,
 *     positionSec:  number,
 *     nextTrack:    { id, title, artist, artworkUrl, duration } | null,
 *     stationName:  string,
 *     tagline:      string,
 *   }
 */

'use strict';

const config = require('./config');

// ── Source type constants ─────────────────────────────────────────────────────
const SOURCE_RADIO         = 'RADIO';
const SOURCE_TV            = 'TV';
const SOURCE_PERSONAL_LIVE = 'PERSONAL_LIVE';

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a source by type.
 *
 * @param {'RADIO'|'TV'|'PERSONAL_LIVE'} type
 * @param {object} firebaseAdmin  — initialised firebase-admin app
 * @returns {RadioSource}
 */
function createSource(type, firebaseAdmin) {
  switch (type) {
    case SOURCE_RADIO: return new RadioSource(firebaseAdmin);
    default: throw new Error(`Unknown source type: ${type}`);
  }
}

// ── RadioSource ───────────────────────────────────────────────────────────────

/**
 * RadioSource reads the authoritative Shadow Nexus Radio state from Firestore
 * and replicates the exact same deterministic timeline algorithm that the
 * browser client (snx-radio.js) uses.
 *
 * No timeline is invented here — this is a server-side mirror of the same
 * pure-function _timeline() logic.
 */
class RadioSource {
  constructor(firebaseAdmin) {
    this._admin       = firebaseAdmin;
    this._db          = null;
    this._station     = null;     // { enabled, mode, epochMs, playlistId }
    this._playlist    = [];       // ordered array of normalised track objects
    this._settings    = null;     // { stationName, tagline, defaultArtwork }
    this._handlers    = {};       // event name → Set of handlers
    this._stationUnsub = null;
    this._settingsUnsub = null;
    this._tickTimer   = null;
    this._lastTrackIdx = -1;
    this._timeOffset  = 0;        // server time correction (ms) — from RTDB if available
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async init() {
    const cfg = config.firestore;

    // Resolve Firestore
    this._db = this._admin.firestore();

    // Attempt RTDB server-time correction
    await this._syncServerTime().catch(() => {});

    // Subscribe to station state
    await this._subscribeStation();

    // Subscribe to station settings (name, tagline, artwork)
    await this._subscribeSettings();

    // Start tick — checks for track transitions every second
    this._tickTimer = setInterval(() => this._tick(), config.tickIntervalMs);

    console.log('[BROADCAST-SOURCE-RADIO] Initialized');
  }

  destroy() {
    if (this._stationUnsub)  { try { this._stationUnsub(); }  catch (_) {} this._stationUnsub  = null; }
    if (this._settingsUnsub) { try { this._settingsUnsub(); } catch (_) {} this._settingsUnsub = null; }
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    this._station  = null;
    this._playlist = [];
    this._settings = null;
    this._handlers = {};
    console.log('[BROADCAST-SOURCE-RADIO] Destroyed');
  }

  /**
   * Returns the current source state — safe to call at any time.
   */
  getState() {
    if (!this._station || !this._station.enabled || this._playlist.length === 0) {
      return {
        sourceType:  SOURCE_RADIO,
        active:      false,
        track:       null,
        positionSec: 0,
        nextTrack:   null,
        stationName: this._settings?.stationName || 'Shadow Nexus Radio',
        tagline:     this._settings?.tagline     || '24/7 Music · Live Events · Shadow Nexus',
        defaultArtwork: this._settings?.defaultArtwork || null,
      };
    }

    const result = this._calcTimeline();
    if (!result) {
      return {
        sourceType: SOURCE_RADIO,
        active:     false,
        track:      null,
        positionSec: 0,
        nextTrack:  null,
        stationName: this._settings?.stationName || 'Shadow Nexus Radio',
        tagline:    this._settings?.tagline || '24/7 Music · Live Events · Shadow Nexus',
        defaultArtwork: this._settings?.defaultArtwork || null,
      };
    }

    const track    = this._playlist[result.trackIdx];
    const nextIdx  = (result.trackIdx + 1) % this._playlist.length;
    const nextTrack = this._playlist[nextIdx] || null;

    return {
      sourceType:  SOURCE_RADIO,
      active:      true,
      track,
      positionSec: result.positionSec,
      nextTrack,
      stationName: this._settings?.stationName   || 'Shadow Nexus Radio',
      tagline:     this._settings?.tagline        || '24/7 Music · Live Events · Shadow Nexus',
      defaultArtwork: this._settings?.defaultArtwork || null,
      // Additional diagnostic fields
      totalElapsedSec: result.totalElapsedSec,
      loopElapsedSec:  result.loopElapsedSec,
      totalDurSec:     result.totalDurSec,
      epochMs:         this._station.epochMs,
    };
  }

  on(event, handler) {
    if (!this._handlers[event]) this._handlers[event] = new Set();
    this._handlers[event].add(handler);
  }

  off(event, handler) {
    if (this._handlers[event]) this._handlers[event].delete(handler);
  }

  // ── Deterministic Timeline Engine ──────────────────────────────────────────
  //
  // This is the IDENTICAL algorithm to snx-radio.js _timeline().
  // Pure function — do not introduce side effects.
  //
  // Given:
  //   epochMs  — when the station "started" (server time in ms)
  //   tracks   — ordered array with .duration (seconds)
  //   nowMs    — current server time ms
  //
  // Returns: { trackIdx, positionSec, trackId, totalElapsedSec, loopElapsedSec, totalDurSec }
  //

  static timeline(epochMs, tracks, nowMs) {
    const MIN = config.minTrackDurationSec;
    const valid = tracks.filter(t => t.duration >= MIN);
    if (valid.length === 0) return null;

    const elapsed    = Math.max(0, (nowMs - epochMs) / 1000);
    const totalDur   = valid.reduce((s, t) => s + t.duration, 0);
    if (totalDur <= 0) return null;

    const loopElapsed = elapsed % totalDur;

    let acc = 0;
    for (let i = 0; i < valid.length; i++) {
      const dur = valid[i].duration;
      if (loopElapsed < acc + dur) {
        return {
          trackIdx:        i,
          positionSec:     loopElapsed - acc,
          trackId:         valid[i].id,
          totalElapsedSec: elapsed,
          loopElapsedSec:  loopElapsed,
          totalDurSec:     totalDur,
        };
      }
      acc += dur;
    }

    // Edge: exactly at boundary
    return {
      trackIdx:        0,
      positionSec:     0,
      trackId:         valid[0].id,
      totalElapsedSec: elapsed,
      loopElapsedSec:  loopElapsed,
      totalDurSec:     totalDur,
    };
  }

  // ── Private: timeline helpers ───────────────────────────────────────────────

  _serverNow() {
    return Date.now() + this._timeOffset;
  }

  _calcTimeline() {
    if (!this._station?.epochMs || this._playlist.length === 0) return null;
    return RadioSource.timeline(this._station.epochMs, this._playlist, this._serverNow());
  }

  _tick() {
    if (!this._station?.enabled || this._playlist.length === 0) return;

    const result = this._calcTimeline();
    if (!result) return;

    // Detect track transition
    if (result.trackIdx !== this._lastTrackIdx) {
      this._lastTrackIdx = result.trackIdx;
      const track = this._playlist[result.trackIdx];
      console.log('[BROADCAST-SOURCE-RADIO] Track change →',
        track.title, 'by', track.artist,
        '| pos:', result.positionSec.toFixed(1) + 's');
      this._emit('trackChange', { track, positionSec: result.positionSec });
    }
  }

  _emit(event, payload) {
    const handlers = this._handlers[event];
    if (!handlers) return;
    handlers.forEach(h => {
      try { h(payload); } catch (e) { console.error('[BROADCAST-SOURCE-RADIO] handler error:', e.message); }
    });
  }

  // ── Private: Firebase subscriptions ────────────────────────────────────────

  async _syncServerTime() {
    // Firebase Admin SDK does not need RTDB time offset — server clock is authoritative.
    // The server's Date.now() IS server time. Offset stays 0.
    this._timeOffset = 0;
  }

  async _subscribeStation() {
    const cfg = config.firestore;
    const stationRef = this._db.collection(cfg.colSite).doc(cfg.docStation);

    this._stationUnsub = stationRef.onSnapshot(
      snap => this._onStationSnapshot(snap.exists ? snap.data() : null),
      err  => {
        console.error('[BROADCAST-SOURCE-RADIO] station snapshot error:', err.message);
        this._emit('error', 'Firestore station error: ' + err.message);
        this._emit('stateChange', 'error');
      }
    );
  }

  async _onStationSnapshot(data) {
    const prev = this._station ? { ...this._station } : null;

    this._station = data ? {
      enabled:    !!data.enabled,
      mode:       data.mode || 'RADIO',
      epochMs:    this._toMs(data.epochMs || data.epoch || data.startedAt),
      playlistId: data.playlistId || data.currentPlaylistId || null,
    } : null;

    if (!this._station || !this._station.enabled || this._station.mode === 'OFF_AIR') {
      this._playlist     = [];
      this._lastTrackIdx = -1;
      this._emit('stateChange', 'off-air');
      return;
    }

    if (this._station.mode === 'PERSONAL_LIVE') {
      this._emit('stateChange', 'personal-live');
      return;
    }

    // Load playlist if changed
    const playlistChanged = !prev || prev.playlistId !== this._station.playlistId;
    if (playlistChanged) {
      await this._loadPlaylist(this._station.playlistId);
    }

    if (this._playlist.length === 0) {
      this._emit('stateChange', 'off-air');
      this._emit('error', 'No tracks in playlist');
      return;
    }

    // Reset track tracking on playlist/epoch change so transition fires immediately
    const epochChanged = prev && prev.epochMs !== this._station.epochMs;
    if (playlistChanged || epochChanged) {
      this._lastTrackIdx = -1;
    }

    this._emit('stateChange', 'on-air');
  }

  async _subscribeSettings() {
    const cfg = config.firestore;
    const ref = this._db.collection(cfg.colSite).doc(cfg.docSettings);

    this._settingsUnsub = ref.onSnapshot(
      snap => {
        const d = snap.exists ? snap.data() : {};
        this._settings = {
          stationName:    d.stationName    || 'Shadow Nexus Radio',
          tagline:        d.tagline        || '24/7 Music · Live Events · Shadow Nexus',
          defaultArtwork: d.defaultArtwork || null,
        };
      },
      err => console.warn('[BROADCAST-SOURCE-RADIO] settings error:', err.message)
    );
  }

  // ── Private: playlist / track loading ──────────────────────────────────────

  async _loadPlaylist(playlistId) {
    const cfg = config.firestore;

    if (!playlistId) {
      this._playlist = await this._fetchAllRadioTracks();
      return;
    }

    try {
      const plSnap = await this._db.collection(cfg.colPlaylists).doc(playlistId).get();
      if (!plSnap.exists || plSnap.data()?.enabled === false) {
        console.warn('[BROADCAST-SOURCE-RADIO] Playlist not found or disabled:', playlistId);
        this._playlist = [];
        return;
      }

      const plData  = plSnap.data();
      const trackIds = plData.trackIds || plData.tracks || [];
      if (trackIds.length === 0) { this._playlist = []; return; }

      const tracks = await this._fetchTracks(trackIds);
      this._playlist = tracks.filter(t => this._isValidTrack(t));
      console.log('[BROADCAST-SOURCE-RADIO] Playlist loaded:', this._playlist.length, 'tracks');
    } catch (err) {
      console.error('[BROADCAST-SOURCE-RADIO] loadPlaylist error:', err.message);
      this._playlist = [];
    }
  }

  async _fetchTracks(trackIds) {
    const cfg     = config.firestore;
    const results = [];
    for (let i = 0; i < trackIds.length; i += 10) {
      const batch = trackIds.slice(i, i + 10);
      const settled = await Promise.allSettled(batch.map(async (id) => {
        let snap = await this._db.collection(cfg.colTracks).doc(id).get();
        if (!snap.exists) snap = await this._db.collection(cfg.colMusic).doc(id).get();
        if (!snap.exists) return null;
        return this._normaliseTrack(id, snap.data());
      }));
      settled.forEach(r => { if (r.status === 'fulfilled' && r.value) results.push(r.value); });
    }
    return results;
  }

  async _fetchAllRadioTracks() {
    const cfg = config.firestore;
    try {
      const snap = await this._db
        .collection(cfg.colTracks)
        .where('enabled', '==', true)
        .orderBy('createdAt', 'asc')
        .get();
      return snap.docs
        .map(d => this._normaliseTrack(d.id, d.data()))
        .filter(t => this._isValidTrack(t));
    } catch (e) {
      console.error('[BROADCAST-SOURCE-RADIO] fetchAllRadioTracks:', e.message);
      return [];
    }
  }

  _normaliseTrack(id, data) {
    return {
      id,
      title:      data.title      || data.name       || 'Unknown',
      artist:     data.artist     || data.artistName  || 'Unknown Artist',
      album:      data.album      || null,
      audioUrl:   data.audioUrl   || data.musicUrl    || data.downloadURL || data.url || null,
      artworkUrl: data.artworkUrl || data.artUrl      || data.coverImage  || data.coverUrl || null,
      duration:   Number(data.duration || data.durationSec || 0),
      enabled:    data.enabled !== false,
    };
  }

  _isValidTrack(t) {
    return t && t.audioUrl && t.duration >= config.minTrackDurationSec && t.enabled !== false;
  }

  _toMs(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (v._seconds !== undefined) return v._seconds * 1000 + Math.round((v._nanoseconds || 0) / 1e6);
    if (v.toMillis) return v.toMillis();
    if (v.seconds !== undefined) return v.seconds * 1000;
    return Number(v) || 0;
  }
}

module.exports = { createSource, RadioSource, SOURCE_RADIO, SOURCE_TV, SOURCE_PERSONAL_LIVE };
