/**
 * snx-broadcast/src/broadcast-manager.js
 *
 * Stage 4B — Orchestrates the full broadcast pipeline.
 *
 * Architecture:
 *   RadioSource (Firestore listener)
 *     ↓  track info + position
 *   EncoderProcess (FFmpeg via child_process.spawn)
 *     ↓  H.264/AAC encoded frames
 *     ↓  FFmpeg tee muxer: 1 encode → N RTMP outputs
 *   RTMP destinations (manual, from Firestore /broadcastDestinations)
 *
 * State machine:
 *   ENGINE_OFFLINE → READY → CONNECTING → LIVE → (STOPPING →) READY
 *                                               ↘ ERROR → READY (after stop)
 *
 * Key properties:
 *   – Duplicate START guard: pressing START twice does not launch two encoders
 *   – Multi-destination fan-out: one FFmpeg instance, N outputs
 *   – Auto-recovery: bounded exponential backoff (see encoder.js)
 *   – Persistent broadcast state: written to disk so a VPS reboot knows
 *     whether to resume (but does NOT auto-resume without explicit config)
 *   – No YouTube OAuth — destinations are manual RTMP entries in Firestore
 *   – Stream keys are fetched from Firestore by destinations/store.js and
 *     passed directly to the encoder — never forwarded to the browser
 */

'use strict';

const fs         = require('fs');
const path       = require('path');
const { createSource, SOURCE_RADIO } = require('./sources');
const { EncoderProcess, probeFFmpeg } = require('./encoder');
const destStore  = require('./destinations/store');
const health     = require('./health');
const config     = require('./config');

// ── Engine states ─────────────────────────────────────────────────────────────
const ENGINE_OFFLINE    = 'ENGINE_OFFLINE';
const ENGINE_READY      = 'READY';
const ENGINE_CONNECTING = 'CONNECTING';
const ENGINE_LIVE       = 'LIVE';
const ENGINE_STOPPING   = 'STOPPING';
const ENGINE_ERROR      = 'ERROR';

// ── Singleton state ───────────────────────────────────────────────────────────

let _state           = ENGINE_OFFLINE;
let _lastError       = null;
let _source          = null;
let _sourceType      = SOURCE_RADIO;
let _encoder         = null;
let _firebaseAdmin   = null;
let _startedAt       = null;
let _ffmpegProbe     = null;    // { ok, version }
let _activeDestNames = [];      // destination names (never keys) for status display
let _activeDests     = 0;       // count

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Initialise the broadcast manager.
 * @param {object} firebaseAdmin — initialised firebase-admin app
 */
async function init(firebaseAdmin) {
  _firebaseAdmin = firebaseAdmin;
  const db = firebaseAdmin.firestore();

  // Initialise destination store
  destStore.init(db);

  // Probe ffmpeg availability
  if (!config.dryRun) {
    _ffmpegProbe = await probeFFmpeg();
    if (!_ffmpegProbe.ok) {
      console.warn('[BROADCAST-MGR] FFmpeg not available:', _ffmpegProbe.error);
      console.warn('[BROADCAST-MGR] Install ffmpeg: sudo apt-get install ffmpeg');
    } else {
      console.log('[BROADCAST-MGR] FFmpeg available — version:', _ffmpegProbe.version);
    }
  } else {
    console.log('[BROADCAST-MGR] DRY RUN mode — FFmpeg probe skipped');
    _ffmpegProbe = { ok: true, version: 'dry-run' };
  }

  // Init radio source
  _source = createSource(_sourceType, _firebaseAdmin);
  _source.on('trackChange', _onTrackChange);
  _source.on('stateChange', _onSourceStateChange);
  _source.on('error', msg => {
    _lastError = msg;
    console.error('[BROADCAST-MGR] Source error:', msg);
  });
  await _source.init();

  // Init encoder
  _encoder = new EncoderProcess();
  _encoder.on('started', ({ pid, destinations }) => {
    console.log('[BROADCAST-MGR] Encoder started — pid:', pid,
      '| destinations:', destinations.join(', '));
  });
  _encoder.on('crash', ({ code, signal, restartCount }) => {
    _lastError = `FFmpeg crashed (${signal || 'code ' + code}), restart ${restartCount}/${8}`;
    console.error('[BROADCAST-MGR] Encoder crash:', _lastError);
    if (_state === ENGINE_LIVE) _setState(ENGINE_ERROR);
  });
  _encoder.on('restartScheduled', ({ attempt, backoffMs }) => {
    console.log('[BROADCAST-MGR] Auto-restart scheduled — attempt', attempt,
      '| backoff', (backoffMs/1000).toFixed(1) + 's');
    if (_state === ENGINE_ERROR) _setState(ENGINE_LIVE);  // consider alive again during retry
  });
  _encoder.on('fatal', msg => {
    _lastError = msg;
    _setState(ENGINE_ERROR);
    _startedAt = null;
    console.error('[BROADCAST-MGR] FATAL — encoder gave up:', msg);
    _saveState();
  });
  _encoder.on('stopped', () => {
    if (_state === ENGINE_STOPPING) {
      _setState(ENGINE_READY);
    }
  });

  _setState(ENGINE_READY);
  console.log('[BROADCAST-MGR] Ready — source:', _sourceType,
    '| dry-run:', config.dryRun);

  // Restore persisted state (check if we should resume a broadcast)
  _restoreState();
}

// ── Start broadcast ───────────────────────────────────────────────────────────

/**
 * Start a broadcast.
 * Validates state → fetches destinations → starts encoder.
 * Returns only after the encoder has successfully spawned.
 *
 * @param {object} opts
 * @param {boolean} [opts.forceRefreshDestinations=false]
 * @throws if already running, no destinations, ffmpeg unavailable, radio off-air
 */
async function startBroadcast(opts = {}) {
  if (_state === ENGINE_LIVE || _state === ENGINE_CONNECTING) {
    throw new Error(`Broadcast already ${_state} — stop first`);
  }
  if (_state !== ENGINE_READY && _state !== ENGINE_ERROR) {
    throw new Error(`Cannot start: state is ${_state}`);
  }
  if (!_ffmpegProbe?.ok && !config.dryRun) {
    throw new Error('FFmpeg not available — install ffmpeg on this server');
  }

  _lastError = null;
  _setState(ENGINE_CONNECTING);

  try {
    // ── Get current radio state ──────────────────────────────────────────────
    const srcState = _source.getState();
    if (!srcState.active && !config.dryRun) {
      throw new Error('Radio is off-air — start the radio station first');
    }

    const track       = srcState.track;
    const positionSec = srcState.positionSec || 0;

    console.log('[BROADCAST-MGR] Starting broadcast',
      track ? `| track: ${track.title} | pos: ${positionSec.toFixed(1)}s` : '(dry run)');

    if (config.dryRun) {
      // Dry-run: no FFmpeg, no real destinations
      _startedAt       = Date.now();
      _activeDestNames = ['[dry-run]'];
      _activeDests     = 1;
      _setState(ENGINE_LIVE);
      _saveState();
      console.log('[BROADCAST-MGR] DRY RUN LIVE');
      return { dryRun: true, destinations: 1, track: track?.title, positionSec };
    }

    // ── Fetch enabled destinations (with stream keys — server-side only) ────
    const destinations = await destStore.getEnabledDestinations(opts.forceRefreshDestinations);
    if (destinations.length === 0) {
      throw new Error('No enabled RTMP destinations — add at least one in the Broadcast Studio');
    }

    // ── Start FFmpeg ─────────────────────────────────────────────────────────
    _encoder.start(destinations, track, positionSec);

    _startedAt       = Date.now();
    _activeDestNames = destinations.map(d => d.name);
    _activeDests     = destinations.length;
    _setState(ENGINE_LIVE);
    _saveState();

    console.log('[BROADCAST-MGR] Broadcast LIVE — destinations:', _activeDestNames.join(', '));
    return {
      destinations:     _activeDests,
      destinationNames: _activeDestNames,
      track:            track?.title,
      positionSec,
    };

  } catch (err) {
    _lastError = err.message;
    _setState(ENGINE_ERROR);
    _saveState();
    throw err;
  }
}

// ── Stop broadcast ────────────────────────────────────────────────────────────

/**
 * Stop the current broadcast gracefully.
 */
async function stopBroadcast() {
  if (_state !== ENGINE_LIVE && _state !== ENGINE_CONNECTING &&
      _state !== ENGINE_ERROR && _state !== ENGINE_STOPPING) {
    throw new Error(`Cannot stop: state is ${_state}`);
  }

  _setState(ENGINE_STOPPING);

  if (config.dryRun) {
    _startedAt       = null;
    _activeDestNames = [];
    _activeDests     = 0;
    _setState(ENGINE_READY);
    _saveState();
    console.log('[BROADCAST-MGR] DRY RUN stopped');
    return;
  }

  if (_encoder && _encoder.isRunning) {
    _encoder.stop();
    // ENGINE_READY is set by the 'stopped' event handler
  } else {
    _setState(ENGINE_READY);
  }

  _startedAt       = null;
  _activeDestNames = [];
  _activeDests     = 0;
  _saveState();
  console.log('[BROADCAST-MGR] Broadcast stopped');
}

// ── Status ────────────────────────────────────────────────────────────────────

/**
 * Full engine status — safe to send to the Founder browser.
 * No stream keys, no full RTMP URLs, no auth tokens.
 */
function getStatus() {
  const srcState   = _source ? _source.getState() : null;
  const encStatus  = _encoder ? _encoder.getStatus() : null;
  const uptimeSec  = _startedAt ? Math.floor((Date.now() - _startedAt) / 1000) : null;

  return {
    engineState:      _state,
    dryRun:           config.dryRun,
    ffmpeg: {
      available:      _ffmpegProbe?.ok || false,
      version:        _ffmpegProbe?.version || null,
    },
    sourceType:       _sourceType,
    lastError:        _lastError,
    uptimeSec,
    startedAt:        _startedAt,
    // Destination summary — names only, no URLs, no keys
    destinations: {
      count:          _activeDests,
      names:          _activeDestNames,
    },
    // Radio source state
    source: srcState ? {
      active:          srcState.active,
      stationName:     srcState.stationName,
      track:           srcState.track ? {
        id:            srcState.track.id,
        title:         srcState.track.title,
        artist:        srcState.track.artist,
        artworkUrl:    srcState.track.artworkUrl,
        duration:      srcState.track.duration,
        // audioUrl intentionally omitted
      } : null,
      positionSec:     srcState.positionSec,
      nextTrack:       srcState.nextTrack ? {
        title:         srcState.nextTrack.title,
        artist:        srcState.nextTrack.artist,
      } : null,
      totalElapsedSec: srcState.totalElapsedSec,
    } : null,
    // Encoder process status
    encoder: encStatus ? {
      running:         encStatus.running,
      pid:             encStatus.pid,
      restartCount:    encStatus.restartCount,
      lastError:       encStatus.lastError,
      lastExitCode:    encStatus.lastExitCode,
      destinationCount: encStatus.destinationCount,
      destinationNames: encStatus.destinationNames,
    } : null,
  };
}

// ── Source event handlers ─────────────────────────────────────────────────────

function _onTrackChange({ track, positionSec }) {
  if (_state !== ENGINE_LIVE) return;
  if (config.dryRun) {
    console.log('[BROADCAST-MGR] DRY RUN track change →', track.title);
    return;
  }
  if (_encoder && _encoder.isRunning) {
    _encoder.updateTrack(track, positionSec);
  }
}

function _onSourceStateChange(newState) {
  console.log('[BROADCAST-MGR] Source state →', newState);
  // If radio goes off-air while we're broadcasting, stop the broadcast.
  if (newState === 'off-air' && (_state === ENGINE_LIVE || _state === ENGINE_CONNECTING)) {
    console.warn('[BROADCAST-MGR] Radio went off-air — stopping broadcast');
    stopBroadcast().catch(e => console.error('[BROADCAST-MGR] stop error:', e.message));
  }
}

// ── Persist state ─────────────────────────────────────────────────────────────
//
// We write a minimal state file so a VPS reboot can check whether a broadcast
// was running.  We do NOT auto-resume — the operator must explicitly restart.
// The file contains only engine state, timestamps, and destination count/names.
// NO stream keys are ever written to disk.

function _saveState() {
  if (!config.statePath) return;
  const safe = {
    engineState:     _state,
    startedAt:       _startedAt,
    destinationCount: _activeDests,
    destinationNames: _activeDestNames,
    savedAt:         new Date().toISOString(),
  };
  try {
    fs.writeFileSync(config.statePath, JSON.stringify(safe, null, 2), 'utf8');
  } catch (e) {
    console.warn('[BROADCAST-MGR] Could not save state file:', e.message);
  }
}

function _restoreState() {
  if (!config.statePath) return;
  try {
    if (!fs.existsSync(config.statePath)) return;
    const saved = JSON.parse(fs.readFileSync(config.statePath, 'utf8'));
    if (saved.engineState === ENGINE_LIVE) {
      console.warn('[BROADCAST-MGR] Persisted state shows LIVE — broadcast was interrupted.');
      console.warn('[BROADCAST-MGR] Auto-resume is disabled — use POST /broadcast/start to restart.');
      _lastError = 'Broadcast interrupted by process restart — manual resume required';
    }
  } catch (e) {
    // Corrupt state file — ignore
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setState(s) {
  _state = s;
  console.log('[BROADCAST-MGR] State →', s);
}

function getState()    { return _state; }
function getSource()   { return _source; }
function isLive()      { return _state === ENGINE_LIVE; }

module.exports = {
  init,
  startBroadcast,
  stopBroadcast,
  getStatus,
  getState,
  getSource,
  isLive,
  ENGINE_OFFLINE,
  ENGINE_READY,
  ENGINE_CONNECTING,
  ENGINE_LIVE,
  ENGINE_STOPPING,
  ENGINE_ERROR,
};
