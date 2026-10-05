/**
 * snx-tv.js
 * Shadow Nexus Social — 24-Hour TV
 * Stage 4: Reliability + Recovery + Mobile/PWA Hardening
 * Build: SNS-2026-TV-STAGE4-001
 *
 * ════════════════════════════════════════════════════════════════════════
 *  SHADOW NEXUS SOCIAL 24-HOUR TV IS SNS-NATIVE.
 *  It does NOT use the separate 24-Hour Engine.
 *  It does NOT use Supabase, new KV, new storage, or new service accounts.
 *
 *  Architecture (canonical — do not reconnect to the old Engine):
 *
 *    SNS R2 Media (via Firestore tv_media)
 *          ↓
 *    tv_media   →  tv_playlists  →  tv_programs  →  tv_schedule
 *          ↓
 *    SNXTVTimeline  (snx-tv-timeline.js)
 *    ONE authoritative resolver — resolve(nowMs) → current item + offset
 *          ↓
 *    window.SNXTV  (this file)
 *    ├── TV Core  — state machine
 *    ├── Viewer   — <video> element + overlays
 *    ├── Now Playing / Up Next
 *    └── TV Guide
 *
 *  SNXTVStudio (snx-tv-studio.js) manages the Firestore collections above.
 *  It exposes getAdapterQueue() for adapter/playlist mode (no schedule).
 *
 *  Join-in-progress:
 *    loadItemAt(item, offsetSeconds) → seeks to authoritative offset on load.
 *
 *  Failure recovery:
 *    Media error / stall → bounded retry → re-resolve timeline → advance.
 *    Offline / online   → preserve last state / re-resolve on reconnect.
 *    Tab sleep / resume → visibilitychange + pageshow → re-resolve timeline.
 *
 *  This file replaces snx-tv.js Stage 3. No other file is required.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Exposes: window.SNXTV
 */

'use strict';

(function (global) {

/* ════════════════════════════════════════════════════════════
   ── TV CORE — CANONICAL STATE ──────────────────────────────
════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} TVItem
 * @property {string}  id           — unique item identifier
 * @property {string}  title        — display title
 * @property {string}  mediaType    — 'video' | 'audio'
 * @property {string}  mediaUrl     — playback URL (R2 CDN or external)
 * @property {string}  [artwork]    — artwork image URL (optional)
 * @property {number}  [duration]   — total duration in seconds (0 = unknown)
 */

/**
 * @typedef {Object} TVState
 * @property {'idle'|'loading'|'playing'|'paused'|'error'|'offline'} status
 * @property {TVItem|null}  current      — currently loaded item
 * @property {TVItem|null}  next         — up-next item
 * @property {number}       elapsed      — current elapsed time in seconds
 * @property {number}       duration     — current item duration in seconds
 * @property {boolean}      onAir        — true when a real item is loaded/playing
 * @property {string|null}  error        — last error message
 * @property {boolean}      needsUserGesture — browser blocked autoplay
 * @property {Object|null}  program      — currently-scheduled program (or null)
 * @property {Object|null}  scheduleEntry— currently-scheduled entry (or null)
 * @property {boolean}      isScheduled  — true when playing from timeline
 * @property {boolean}      isGap        — true when schedule exists but nothing on air now
 * @property {string}       gapLabel
 * @property {boolean}      isOffline    — true when device is offline
 */

var _state = {
  status:           'idle',
  current:          null,
  next:             null,
  elapsed:          0,
  duration:         0,
  onAir:            false,
  error:            null,
  needsUserGesture: false,
  program:          null,
  scheduleEntry:    null,
  isScheduled:      false,
  isGap:            false,
  gapLabel:         '',
  isOffline:        false,
};

/** Subscribers: functions called on every state change */
var _subscribers = [];

/** Queue cursor */
var _queueIndex = 0;

/** Loaded playlist queue — set by _loadPlaylistQueue() */
var _playlistQueue = null;

/* ── Stage 3/4: Timeline integration ── */

/** True when scheduled mode is active (SNXTVTimeline is driving) */
var _scheduleMode     = false;

/** Unsubscribe handle for SNXTVTimeline */
var _unsubTimeline    = null;

/** The item URL we last loaded via timeline (to avoid double-loading) */
var _tlMediaLoaded    = null;

/** Flag to prevent re-entrancy in _onTimelineChange */
var _tlChanging       = false;

/* ── Stage 4: Media failure / stall recovery ── */

/**
 * Bounded retry counter for media errors.
 * Reset when a new item is loaded successfully.
 */
var _mediaErrorCount  = 0;
var MAX_MEDIA_RETRIES = 3;

/** Stall detection timer */
var _stallTimer       = null;
var STALL_TIMEOUT_MS  = 15000; // 15 s of stall = recovery attempt

/** Whether we're currently in a media recovery attempt */
var _recovering       = false;

/* ── State helpers ── */

function _setState(patch) {
  Object.assign(_state, patch);
  _notifySubscribers();
}

function _notifySubscribers() {
  var snapshot = Object.assign({}, _state);
  for (var i = 0; i < _subscribers.length; i++) {
    try { _subscribers[i](snapshot); } catch (e) { /* never crash TV on subscriber error */ }
  }
}

/* ── Public Core API ── */

/**
 * Subscribe to TV state changes.
 * @param {function} fn  Called with the current TVState on every change.
 * @returns {function}   Unsubscribe function.
 */
function subscribe(fn) {
  _subscribers.push(fn);
  try { fn(Object.assign({}, _state)); } catch (e) {}
  return function unsubscribe() {
    _subscribers = _subscribers.filter(function (s) { return s !== fn; });
  };
}

/**
 * Read the current TV state snapshot.
 * @returns {TVState}
 */
function getState() {
  return Object.assign({}, _state);
}

/**
 * Load a specific TV item into the Core.
 * @param {TVItem} item
 */
function loadItem(item) {
  if (!item || !item.mediaUrl) {
    _setState({ status: 'error', error: 'No media URL', onAir: false });
    return;
  }
  _clearStallTimer();
  _mediaErrorCount = 0;
  _recovering = false;
  _setState({
    status:           'loading',
    current:          item,
    elapsed:          0,
    duration:         item.duration || 0,
    onAir:            false,
    error:            null,
    needsUserGesture: false
  });
}

/**
 * Load an item and seek to the given offset (seconds).
 * Used by the timeline for join-in-progress / resync.
 * @param {TVItem} item
 * @param {number} offsetSeconds
 */
function loadItemAt(item, offsetSeconds) {
  if (!item || !item.mediaUrl) {
    _setState({ status: 'error', error: 'No media URL', onAir: false });
    return;
  }
  _clearStallTimer();
  _mediaErrorCount = 0;
  _recovering = false;
  _tlMediaLoaded = item.mediaUrl;
  _setState({
    status:           'loading',
    current:          item,
    elapsed:          offsetSeconds || 0,
    duration:         item.duration || 0,
    onAir:            false,
    error:            null,
    needsUserGesture: false
  });

  var v = _el.video;
  if (!v) return;

  var doSeek = function () {
    if (offsetSeconds > 0) {
      v.currentTime = offsetSeconds;
    }
    var playP = v.play();
    if (playP !== undefined) {
      playP.catch(function (err) {
        if (err.name === 'NotAllowedError') onAutoplayBlocked();
        else onMediaError(err.message);
      });
    }
  };

  if (v.src !== item.mediaUrl) {
    v.src     = item.mediaUrl;
    v.preload = 'auto';
    v.oncanplay = function () {
      v.oncanplay = null;
      doSeek();
    };
  } else {
    doSeek();
  }
}

/**
 * Advance to the next queued item (adapter/playlist mode).
 */
function advance() {
  var queue = _getQueue();
  if (!queue.length) {
    _setState({ status: 'idle', current: null, next: null, onAir: false });
    return;
  }
  _queueIndex = (_queueIndex + 1) % queue.length;
  var item = queue[_queueIndex];
  var nextItem = queue[(_queueIndex + 1) % queue.length];
  _setState({ next: nextItem });
  loadItem(item);
}

/**
 * Called by the Viewer's media element on 'canplay'.
 */
function onMediaReady() {
  _clearStallTimer();
  _setState({ status: 'loading', onAir: true });
}

/**
 * Called by the Viewer when playback actually starts.
 */
function onPlaybackStarted() {
  _clearStallTimer();
  _mediaErrorCount = 0;
  _recovering = false;
  _setState({ status: 'playing', onAir: true, needsUserGesture: false });
}

/**
 * Called by the Viewer when playback is paused (not ended).
 */
function onPlaybackPaused() {
  _clearStallTimer();
  _setState({ status: 'paused' });
}

/**
 * Called by the Viewer on media 'timeupdate'.
 * @param {number} elapsed
 * @param {number} duration
 */
function onTimeUpdate(elapsed, duration) {
  _state.elapsed  = elapsed;
  _state.duration = duration;
  _notifySubscribers();
  // Reset stall timer on progress
  if (_state.status === 'playing') {
    _resetStallTimer();
  }
  // Update duration in state if we now know it
  if (duration > 0 && _state.duration !== duration) {
    _state.duration = duration;
    if (_state.current) _state.current.duration = duration;
  }
}

/**
 * Called when media playback ends.
 * Re-resolve from timeline (Stage 3) or advance (adapter mode).
 */
function onMediaEnded() {
  _clearStallTimer();
  _mediaErrorCount = 0;
  _recovering = false;
  if (_scheduleMode && global.SNXTVTimeline) {
    var resolved = global.SNXTVTimeline.resolve(Date.now());
    _applyTimelineState(resolved, true);
  } else {
    advance();
  }
}

/**
 * Called when the browser blocks autoplay.
 */
function onAutoplayBlocked() {
  _clearStallTimer();
  _setState({ status: 'paused', needsUserGesture: true, onAir: true });
}

/**
 * Called on media error.
 * Stage 4: bounded retry / timeline re-resolve.
 * @param {string} msg
 */
function onMediaError(msg) {
  _clearStallTimer();
  _mediaErrorCount++;

  // If we haven't exceeded retries and we're in schedule mode, re-resolve
  if (_scheduleMode && global.SNXTVTimeline && _mediaErrorCount <= MAX_MEDIA_RETRIES) {
    console.warn('[SNX TV] Media error (' + _mediaErrorCount + '/' + MAX_MEDIA_RETRIES + '):', msg, '— re-resolving timeline');
    var resolved = global.SNXTVTimeline.resolve(Date.now());
    // If another item should be playing, move to it
    if (resolved && resolved.mode === 'playing' && resolved.currentItem &&
        resolved.currentItem.mediaUrl !== (_state.current && _state.current.mediaUrl)) {
      _applyTimelineState(resolved, true);
      return;
    }
    // Same item failed: try a single reload after a short delay
    if (_mediaErrorCount < MAX_MEDIA_RETRIES) {
      setTimeout(function () {
        if (_state.current && _state.current.mediaUrl) {
          var v = _el.video;
          if (v) {
            v.load();
            v.play().catch(function () {});
          }
        }
      }, 2000 * _mediaErrorCount);
      _setState({ status: 'loading', error: null });
      return;
    }
    // Exhausted retries — show unavailable and let schedule advance naturally
    _mediaErrorCount = 0;
    _applyTimelineState(resolved, true);
    return;
  }

  // Adapter/playlist mode or retries exhausted
  _setState({ status: 'error', error: msg || 'Playback error', onAir: false });
}

/* ── Stage 4: Stall detection ── */

function _clearStallTimer() {
  if (_stallTimer) {
    clearTimeout(_stallTimer);
    _stallTimer = null;
  }
}

function _resetStallTimer() {
  _clearStallTimer();
  if (_state.status !== 'playing') return;
  _stallTimer = setTimeout(_onStallTimeout, STALL_TIMEOUT_MS);
}

function _onStallTimeout() {
  _stallTimer = null;
  if (_state.status !== 'playing' && _state.status !== 'loading') return;
  if (_recovering) {
    // Already tried — give up gracefully
    _recovering = false;
    onMediaError('Playback stalled — could not recover');
    return;
  }
  _recovering = true;
  console.warn('[SNX TV] Stall detected — attempting recovery');

  if (_scheduleMode && global.SNXTVTimeline) {
    // Re-resolve — seek to authoritative position
    var resolved = global.SNXTVTimeline.resolve(Date.now());
    if (resolved && resolved.mode === 'playing' && resolved.currentItem) {
      var v = _el.video;
      if (v) {
        var target = resolved.itemOffset || 0;
        // Try seek first
        try {
          if (isFinite(v.duration) && v.duration > 0) {
            v.currentTime = Math.min(target, v.duration - 0.5);
          }
          v.play().catch(function () {});
        } catch (e) {}
        _recovering = false;
        return;
      }
    }
    // Can't recover — re-resolve
    _applyTimelineState(resolved, true);
    _recovering = false;
  } else {
    // Adapter mode — reload current
    var v2 = _el.video;
    if (v2 && _state.current && _state.current.mediaUrl) {
      v2.load();
      v2.play().catch(function () {});
    }
    _recovering = false;
  }
}

/* ════════════════════════════════════════════════════════════
   ── TV MEDIA ADAPTER ──────────────────────────────────────
   Delegates to SNXTVStudio (snx-tv-studio.js).
   TV Core and Viewer never query Firestore directly.
════════════════════════════════════════════════════════════ */

function _getQueue() {
  if (global.SNXTVStudio && typeof global.SNXTVStudio.getAdapterQueue === 'function') {
    return global.SNXTVStudio.getAdapterQueue();
  }
  return [];
}

/* ════════════════════════════════════════════════════════════
   ── TV VIEWER ──────────────────────────────────────────────
   Reads TV Core state and updates the #tvPage DOM.
   Uses one <video> element for both video and audio media.
════════════════════════════════════════════════════════════ */

/** References to DOM elements, populated once on init */
var _el = {
  page:               null,
  video:              null,
  artwork:            null,
  artworkImg:         null,
  artworkBg:          null,
  artworkGlow:        null,
  artworkTitle:       null,
  artworkArtist:      null,
  visualizer:         null,
  fallback:           null,
  fallbackLabel:      null,
  tapOverlay:         null,
  tapBtn:             null,
  loadingOverlay:     null,
  unavailableOverlay: null,
  unavailableMsg:     null,
  onairBadge:         null,
  onairDot:           null,
  onairText:          null,
  npTitle:            null,
  npArtist:           null,
  npTypeBadge:        null,
  progressFill:       null,
  timeDisplay:        null,
  unTitle:            null,
  unSub:              null,
  unThumb:            null,
  unEmpty:            null,
  fullscreenBtn:      null,
  guideList:          null,
  guideToggle:        null,
  guideContent:       null,
};

var _viewerReady = false;
var _mediaLoaded = false;  // last media URL loaded into the element (adapter mode)

function _initViewer() {
  // Idempotent — only run once per DOM lifecycle
  if (_viewerReady) return;

  _el.page              = document.getElementById('tvPage');
  _el.video             = document.getElementById('snxTvVideo');
  _el.artwork           = document.getElementById('snxTvArtwork');
  _el.artworkImg        = document.getElementById('snxTvArtworkImg');
  _el.artworkBg         = document.getElementById('snxTvArtworkBg');
  _el.artworkGlow       = document.getElementById('snxTvArtworkGlow');
  _el.artworkTitle      = document.getElementById('snxTvArtworkTitle');
  _el.artworkArtist     = document.getElementById('snxTvArtworkArtist');
  _el.visualizer        = document.getElementById('snxTvVisualizer');
  _el.fallback          = document.getElementById('snxTvFallback');
  _el.fallbackLabel     = document.getElementById('snxTvFallbackLabel');
  _el.tapOverlay        = document.getElementById('snxTvTapOverlay');
  _el.tapBtn            = document.getElementById('snxTvTapBtn');
  _el.loadingOverlay    = document.getElementById('snxTvLoadingOverlay');
  _el.unavailableOverlay= document.getElementById('snxTvUnavailableOverlay');
  _el.unavailableMsg    = document.getElementById('snxTvUnavailableMsg');
  _el.onairBadge        = document.getElementById('snxTvOnAirBadge');
  _el.onairDot          = document.getElementById('snxTvOnAirDot');
  _el.onairText         = document.getElementById('snxTvOnAirText');
  _el.npTitle           = document.getElementById('snxTvNpTitle');
  _el.npArtist          = document.getElementById('snxTvNpArtist');
  _el.npTypeBadge       = document.getElementById('snxTvNpTypeBadge');
  _el.progressFill      = document.getElementById('snxTvProgressFill');
  _el.timeDisplay       = document.getElementById('snxTvTimeDisplay');
  _el.unTitle           = document.getElementById('snxTvUnTitle');
  _el.unSub             = document.getElementById('snxTvUnSub');
  _el.unThumb           = document.getElementById('snxTvUnThumb');
  _el.unEmpty           = document.getElementById('snxTvUnEmpty');
  _el.fullscreenBtn     = document.getElementById('snxTvFullscreenBtn');
  _el.guideList         = document.getElementById('snxTvGuideList');
  _el.guideToggle       = document.getElementById('snxTvGuideToggle');
  _el.guideContent      = document.getElementById('snxTvGuideContent');

  if (!_el.video) {
    console.warn('[SNX TV] Viewer elements not found — is #tvPage in the DOM?');
    return;
  }

  _attachMediaListeners();
  _attachTapOverlay();
  _attachFullscreen();
  _attachGuideToggle();

  // Subscribe the viewer to TV Core state
  subscribe(_renderState);

  _viewerReady = true;
}

/* ── TV Guide toggle ── */

function _attachGuideToggle() {
  var btn = _el.guideToggle;
  var content = _el.guideContent;
  if (!btn || !content) return;
  btn.addEventListener('click', function () {
    var open = content.classList.toggle('snx-tv-guide-content--open');
    btn.textContent = open ? '▲' : '▼';
    if (open) _renderGuide();
  });
}

/* ── Wire up the HTML media element ── */

function _attachMediaListeners() {
  var v = _el.video;
  if (!v) return;

  v.addEventListener('canplay', function () {
    onMediaReady();
  });

  v.addEventListener('playing', function () {
    onPlaybackStarted();
  });

  v.addEventListener('pause', function () {
    // Don't fire paused if the element has ended — that's handled by 'ended'
    if (!v.ended) onPlaybackPaused();
  });

  v.addEventListener('timeupdate', function () {
    var elapsed  = isFinite(v.currentTime)  ? v.currentTime  : 0;
    var duration = isFinite(v.duration)     ? v.duration     : 0;
    onTimeUpdate(elapsed, duration);
    if (duration > 0 && _state.duration !== duration) {
      _state.duration = duration;
      if (_state.current) _state.current.duration = duration;
    }
  });

  v.addEventListener('ended', function () {
    onMediaEnded();
  });

  v.addEventListener('error', function () {
    var msg = 'Media unavailable';
    if (v.error) {
      switch (v.error.code) {
        case 1: msg = 'Media loading aborted'; break;
        case 2: msg = 'Network error while loading media'; break;
        case 3: msg = 'Media format not supported'; break;
        case 4: msg = 'Media source not supported'; break;
      }
    }
    onMediaError(msg);
  });

  v.addEventListener('waiting', function () {
    if (_state.status === 'playing') {
      _setState({ status: 'loading' });
      // Start stall timer when buffering begins
      _resetStallTimer();
    }
  });

  v.addEventListener('stalled', function () {
    // Stalled event — start stall timer if playing/loading
    if (_state.status === 'playing' || _state.status === 'loading') {
      _resetStallTimer();
    }
  });

  v.addEventListener('playing', function () {
    // Clear stall timer on resume after buffering
    _clearStallTimer();
  });
}

function _attachTapOverlay() {
  var btn = _el.tapBtn;
  if (!btn) return;
  btn.addEventListener('click', function () {
    _hideTapOverlay();
    var v = _el.video;
    if (!v) return;

    // Stage 4: after user gesture, re-calculate the correct offset before playing.
    // Autoplay may have been blocked for seconds/minutes; time has passed.
    if (_scheduleMode && global.SNXTVTimeline) {
      var resolved = global.SNXTVTimeline.resolve(Date.now());
      if (resolved && resolved.mode === 'playing' && resolved.currentItem) {
        var offset = resolved.itemOffset || 0;
        if (resolved.currentItem.mediaUrl !== (v.src || '')) {
          // Different item should be on air now
          _applyTimelineState(resolved, true);
          return;
        }
        // Seek to correct offset, then play
        try {
          if (isFinite(v.duration) && v.duration > 0) {
            v.currentTime = Math.min(offset, v.duration - 0.5);
          } else if (offset > 0) {
            v.currentTime = offset;
          }
        } catch (e) {}
        v.play().catch(function (e) {
          console.warn('[SNX TV] Play after tap rejected:', e.message);
          onMediaError('Playback could not start');
        });
        return;
      }
      // Gap or no schedule
      _applyTimelineState(resolved, false);
      return;
    }

    // Adapter mode — just play from current position
    v.play().catch(function (e) {
      console.warn('[SNX TV] Play after tap rejected:', e.message);
      onMediaError('Playback could not start');
    });
  });
}

function _attachFullscreen() {
  var btn = _el.fullscreenBtn;
  if (!btn) return;
  btn.addEventListener('click', function () {
    var wrap = document.getElementById('snxTvPlayerWrap');
    if (!wrap) return;
    try {
      if (wrap.requestFullscreen) {
        wrap.requestFullscreen().catch(function (e) {
          console.info('[SNX TV] Fullscreen request denied:', e.message);
        });
      } else if (wrap.webkitRequestFullscreen) {
        wrap.webkitRequestFullscreen();
      } else {
        console.info('[SNX TV] Fullscreen not supported on this device.');
      }
    } catch (e) {
      console.info('[SNX TV] Fullscreen error (non-fatal):', e.message);
    }
  });
}

/* ── Render: reflect TV Core state into the DOM ── */

function _renderState(state) {
  if (!_viewerReady) return;

  _renderOnAir(state);
  _renderPlayer(state);
  _renderNowPlaying(state);
  _renderUpNext(state);
  // Update guide only if it's open (performance)
  if (_el.guideContent && _el.guideContent.classList.contains('snx-tv-guide-content--open')) {
    _renderGuide();
  }
}

function _renderOnAir(state) {
  var badge = _el.onairBadge;
  var text  = _el.onairText;
  if (!badge) return;
  if (state.onAir && state.status !== 'error') {
    badge.classList.remove('offline');
    if (text) text.textContent = 'ON AIR';
  } else {
    badge.classList.add('offline');
    if (text) text.textContent = state.isOffline ? 'OFFLINE' : (state.status === 'idle' ? 'OFF AIR' : 'LOADING');
  }
}

function _renderPlayer(state) {
  var v           = _el.video;
  var artworkWrap = _el.artwork;
  var artImg      = _el.artworkImg;
  var visualizer  = _el.visualizer;
  var fallback    = _el.fallback;
  var loading     = _el.loadingOverlay;
  var unavail     = _el.unavailableOverlay;
  var unavailMsg  = _el.unavailableMsg;
  var tap         = _el.tapOverlay;

  if (!v) return;

  var item = state.current;

  // ── Load media into element if URL changed (adapter/playlist mode only) ──
  // In scheduled mode, loadItemAt() handles the load+seek.
  if (!_scheduleMode && item && item.mediaUrl && item.mediaUrl !== _mediaLoaded) {
    _mediaLoaded = item.mediaUrl;
    v.src     = item.mediaUrl;
    v.preload = 'auto';
    var playPromise = v.play();
    if (playPromise !== undefined) {
      playPromise.catch(function (err) {
        if (err.name === 'NotAllowedError') {
          onAutoplayBlocked();
        } else {
          onMediaError(err.message);
        }
      });
    }
  }

  // ── Determine display mode ──
  // audioVisualMode from channel settings: 'auto' | 'artwork' | 'visualizer'
  var avMode   = _getAudioVisualMode();
  var isVideo  = item && item.mediaType === 'video';
  var isAudio  = item && item.mediaType === 'audio';
  var hasArtwork = item && item.artwork;

  // Priority: video → video player. Audio: per mode.
  var showVideo      = !!(item && isVideo);
  var showArtwork    = false;
  var showVisualizer = false;

  if (isAudio) {
    if (avMode === 'visualizer') {
      showVisualizer = true;
    } else if (avMode === 'artwork') {
      // Artwork preferred; fall back to visualizer only if truly no artwork
      if (hasArtwork) {
        showArtwork = true;
      } else {
        showVisualizer = true;
      }
    } else {
      // AUTO (default): artwork if available, visualizer if not
      if (hasArtwork) {
        showArtwork = true;
      } else {
        showVisualizer = true;
      }
    }
  }

  var showFallback = !item || (!isVideo && !isAudio);

  _setVisible(v,           showVideo);
  _setVisible(artworkWrap, showArtwork);
  _setVisible(visualizer,  showVisualizer);
  _setVisible(fallback,    showFallback);

  // ── Update artwork presentation ──
  if (showArtwork && artImg) {
    if (artImg.dataset.snxSrc !== item.artwork) {
      artImg.dataset.snxSrc = item.artwork;
      artImg.src = item.artwork;
      _updateArtworkPresentation(item);
    }
  }

  // ── Update artwork overlay metadata ──
  if (showArtwork) {
    if (_el.artworkTitle) _el.artworkTitle.textContent = item.title || '';
    if (_el.artworkArtist) _el.artworkArtist.textContent = item.artist || '';
  }

  // ── Drive the audio visual engine ──
  if (showVisualizer) {
    _snxViz.start(v, item);
  } else {
    _snxViz.stop();
  }

  if (showArtwork) {
    _snxArtwork.start(item, state);
  } else {
    _snxArtwork.stop();
  }

  // ── Overlays ──
  var showLoading = (state.status === 'loading') && !state.needsUserGesture;
  var showUnavail = state.status === 'error' || state.status === 'offline' ||
                   (state.status === 'idle' && !item) || state.isOffline;
  var showTap     = state.needsUserGesture;

  _setOverlayVisible(loading,  showLoading && !showUnavail && !showTap);
  _setOverlayVisible(unavail,  showUnavail && !showLoading && !showTap);
  _setOverlayVisible(tap,      showTap);

  if (unavailMsg) {
    if (state.isOffline) {
      unavailMsg.textContent = 'No internet connection — please reconnect to watch.';
    } else if (state.status === 'error') {
      unavailMsg.textContent = state.error || 'Media unavailable';
    } else if (state.status === 'offline') {
      unavailMsg.textContent = 'No media in TV library. Open TV Studio to add media.';
    } else if (state.status === 'idle' && state.isGap) {
      unavailMsg.textContent = state.gapLabel || 'Programming Resumes Soon';
    } else if (state.status === 'idle') {
      unavailMsg.textContent = 'Shadow Nexus TV is warming up…';
    }
  }
}

/** Get channel audio-visual mode from TV settings (cached in SNXTVTimeline or Studio) */
function _getAudioVisualMode() {
  // Try timeline settings cache first, then studio settings cache
  var cfg = null;
  if (global.SNXTVTimeline && typeof global.SNXTVTimeline.getSettings === 'function') {
    cfg = global.SNXTVTimeline.getSettings();
  }
  if (!cfg && global.SNXTVStudio && typeof global.SNXTVStudio.getSettings === 'function') {
    cfg = global.SNXTVStudio.getSettings();
  }
  if (!cfg && global._snxTvSettings) {
    cfg = global._snxTvSettings;
  }
  return (cfg && cfg.audioVisualMode) || 'auto';
}

/** Apply artwork cinematic presentation — blurred bg + glow color */
function _updateArtworkPresentation(item) {
  if (!item || !item.artwork) return;
  var bg   = _el.artworkBg;
  var glow = _el.artworkGlow;
  if (bg)   bg.style.backgroundImage = 'url(' + _esc(item.artwork) + ')';
  if (glow) glow.style.setProperty('--snx-glow-src', 'url(' + _esc(item.artwork) + ')');
}

function _renderNowPlaying(state) {
  var title  = _el.npTitle;
  var artist = _el.npArtist;
  var badge  = _el.npTypeBadge;
  var fill   = _el.progressFill;
  var time   = _el.timeDisplay;

  var item  = state.current;

  if (title) {
    if (item) {
      var progName = (state.program && state.program.name) ? state.program.name : null;
      title.textContent = (progName && progName !== item.title)
        ? progName + ' — ' + (item.title || 'Loading…')
        : (item.title || 'Loading…');
    } else if (state.isGap) {
      title.textContent = state.gapLabel || 'Programming Resumes Soon';
    } else {
      title.textContent = '—';
    }
  }

  // Artist line — shown for audio items with an artist field
  if (artist) {
    var artistName = (item && item.mediaType === 'audio' && item.artist) ? item.artist : '';
    artist.textContent  = artistName;
    artist.style.display = artistName ? '' : 'none';
  }

  if (badge) {
    var type = (item && item.mediaType) || '';
    badge.textContent   = type ? type.toUpperCase() : (state.isGap ? 'SCHEDULED' : 'TV');
    badge.className     = 'snx-tv-np-type-badge' + (type === 'audio' ? ' audio' : '');
  }

  // Progress
  var elapsed  = state.elapsed  || 0;
  var duration = state.duration || 0;
  var pct = (duration > 0) ? Math.min(100, (elapsed / duration) * 100) : 0;
  if (fill) fill.style.width = pct + '%';
  if (time) time.textContent = _fmtTime(elapsed) + ' / ' + (duration > 0 ? _fmtTime(duration) : '--:--');
}

function _renderUpNext(state) {
  var item    = state.next;
  var title   = _el.unTitle;
  var sub     = _el.unSub;
  var empty   = _el.unEmpty;
  var thumbEl = _el.unThumb;

  var show = !!item;
  if (title)   { title.style.display   = show ? '' : 'none'; title.textContent = item ? item.title : ''; }
  if (sub)     { sub.style.display     = show ? '' : 'none'; sub.textContent   = item ? _mediaTypeLabel(item.mediaType) : ''; }
  if (empty)   { empty.style.display   = show ? 'none' : ''; }
  if (thumbEl) {
    if (show && item.artwork) {
      thumbEl.innerHTML = '<img src="' + _esc(item.artwork) + '" alt="">';
    } else {
      thumbEl.innerHTML = '📺';
    }
  }
}

/* ── Viewer helpers ── */

function _setVisible(el, visible) {
  if (!el) return;
  el.classList.toggle('visible', !!visible);
}

function _setOverlayVisible(el, visible) {
  if (!el) return;
  el.classList.toggle('visible', !!visible);
}

function _hideTapOverlay() {
  _setState({ needsUserGesture: false });
}

function _fmtTime(secs) {
  if (!isFinite(secs) || secs < 0) return '0:00';
  var s = Math.floor(secs % 60);
  var m = Math.floor(secs / 60);
  var h = Math.floor(m / 60);
  m = m % 60;
  if (h > 0) return h + ':' + _pad(m) + ':' + _pad(s);
  return m + ':' + _pad(s);
}

function _pad(n) { return n < 10 ? '0' + n : '' + n; }

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _mediaTypeLabel(type) {
  if (type === 'video') return 'VIDEO';
  if (type === 'audio') return 'AUDIO';
  return 'MEDIA';
}

/* ════════════════════════════════════════════════════════════
   ── STAGE 3/4: TV GUIDE ─────────────────────────────────────
   Reads from SNXTVTimeline (same data as timeline resolver).
   One guide — no duplicate schedule data.
════════════════════════════════════════════════════════════ */

function _renderGuide() {
  var el = _el.guideList;
  if (!el) return;

  if (!global.SNXTVTimeline) {
    el.innerHTML = '<div class="snx-tv-guide-empty">TV Guide not available.</div>';
    return;
  }

  var upcoming = global.SNXTVTimeline.getUpcoming(10);

  if (!upcoming.length) {
    el.innerHTML = '<div class="snx-tv-guide-empty">No schedule. Add programs in TV Studio → Schedule.</div>';
    return;
  }

  var nowMs = Date.now();
  var html  = '';

  for (var i = 0; i < upcoming.length; i++) {
    var slot   = upcoming[i];
    var prog   = slot.program;
    var title  = prog ? (prog.name || 'Untitled') : 'Unknown';
    var startMs= slot.startMs;
    var endMs  = slot.endMs;
    var isOnAir= startMs <= nowMs && endMs > nowMs;

    var startLabel = startMs ? _fmtGuideTime(startMs) : '—';
    var endLabel   = (endMs > startMs) ? _fmtGuideTime(endMs) : '';

    var progressHtml = '';
    if (isOnAir && endMs > startMs) {
      var pct = Math.min(100, ((nowMs - startMs) / (endMs - startMs)) * 100);
      progressHtml = '<div class="snx-tv-guide-progress"><div class="snx-tv-guide-progress-fill" style="width:' + pct.toFixed(1) + '%"></div></div>';
    }

    html += '<div class="snx-tv-guide-row' + (isOnAir ? ' snx-tv-guide-row--onair' : '') + '">'
      + '<div class="snx-tv-guide-time">' + _esc(startLabel) + (endLabel ? '<br>' + _esc(endLabel) : '') + '</div>'
      + '<div class="snx-tv-guide-info">'
      + '<div class="snx-tv-guide-title">' + (isOnAir ? '<span class="snx-tv-guide-pill">ON AIR</span> ' : '') + _esc(title) + '</div>'
      + (prog && prog.description ? '<div class="snx-tv-guide-desc">' + _esc(prog.description) + '</div>' : '')
      + progressHtml
      + '</div>'
      + '</div>';
  }

  el.innerHTML = html;
}

function _fmtGuideTime(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  var h = d.getHours();
  var m = d.getMinutes();
  var ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
}

/* ════════════════════════════════════════════════════════════
   ── LIFECYCLE — PAGE OPEN / CLOSE ─────────────────────────
   Called by navTo() when user navigates to/from #tvPage.
════════════════════════════════════════════════════════════ */

var _opened = false;

/**
 * Called when the TV page becomes active.
 */
function pageOpen() {
  if (!_viewerReady) _initViewer();

  // Inject Studio button / overlay (Founder only, once)
  _initStudio();

  // Show Submit Content button for any signed-in user
  _initSubmitArea();

  // Start timeline listener and try scheduled mode
  _startTimelineMode();

  if (!_opened && _state.status === 'idle') {
    _opened = true;
    // _startQueue() will be called if timeline has no schedule
  }

  if (_state.needsUserGesture) {
    _notifySubscribers();
  }

  // Stage 4: if returning to TV after being away, resync immediately
  if (_scheduleMode && _viewerReady && global.SNXTVTimeline) {
    _timelineResync();
  }
}

/**
 * Called when the user navigates away from TV.
 * Stage 4: pause video but preserve ALL state — viewer may return.
 */
function pageLeave() {
  var v = _el.video;
  if (v && !v.paused) {
    v.pause();
  }
  _clearStallTimer();
  // Stop visual engines while TV is not visible (saves CPU/battery)
  _snxViz.stop();
  _snxArtwork.stop();
  // Note: DO NOT stop the timeline listener here.
  // The timeline subscription keeps schedule data fresh while the user is elsewhere,
  // so rejoining is instant. Timeline data (stations) is global, not viewer-specific.
}

/* ════════════════════════════════════════════════════════════
   ── STAGE 3/4: TIMELINE INTEGRATION ────────────────────────
   SNXTVTimeline drives scheduled playback.
   _getQueue() / advance() remain for adapter mode.
════════════════════════════════════════════════════════════ */

/**
 * Start timeline mode.
 * Idempotent: safe to call on every pageOpen().
 */
function _startTimelineMode() {
  if (!global.SNXTVTimeline) {
    if (!_opened && _state.status === 'idle') {
      _opened = true;
      _startQueue();
    }
    return;
  }

  // Start live listeners (guarded internally by _listening flag)
  global.SNXTVTimeline.startListening();

  // Re-subscribe: always create a fresh subscription to get the current resolved state.
  // Unsub old one first to avoid double-handlers.
  if (_unsubTimeline) { try { _unsubTimeline(); } catch(_){} _unsubTimeline = null; }
  _unsubTimeline = global.SNXTVTimeline.subscribe(_onTimelineChange);
}

/**
 * Called whenever SNXTVTimeline data changes.
 * Also called once on subscribe (initial resolve).
 */
function _onTimelineChange(resolved) {
  if (_tlChanging) return;
  _tlChanging = true;
  try {
    _applyTimelineState(resolved, false);
  } finally {
    _tlChanging = false;
  }
}

/**
 * Apply a resolved timeline state to the TV core.
 * @param {Object}  resolved     — result of SNXTVTimeline.resolve()
 * @param {boolean} forceReload  — true when called from onMediaEnded to force next item
 */
function _applyTimelineState(resolved, forceReload) {
  if (!resolved) return;

  if (resolved.mode === 'gap' || resolved.mode === 'noSchedule') {
    if (!global.SNXTVTimeline.hasSchedule()) {
      // No schedule → fall back to adapter/playlist mode
      _scheduleMode = false;
      if (!_opened && _state.status === 'idle') {
        _opened = true;
        _startQueue();
      }
      return;
    }

    // Schedule exists but current time is a gap, and no usable fallback
    _scheduleMode = true;
    _scheduleGap(resolved);
    return;
  }

  // ── Fallback playlist mode ────────────────────────────────────────────────
  // Treat 'fallback' identically to 'playing' for load/seek/advance, but mark
  // the state as fallback so the UI can show it appropriately.
  if (resolved.mode === 'fallback') {
    _scheduleMode = true;

    var fbItem   = resolved.currentItem;
    var fbNext   = resolved.nextItem;
    var fbOffset = resolved.itemOffset || 0;

    if (!fbItem || !fbItem.mediaUrl) {
      // Fallback has no playable items — show standby gap
      _scheduleGap(resolved);
      return;
    }

    _setState({
      next:          fbNext || null,
      program:       null,
      scheduleEntry: null,
      isScheduled:   true,
      isGap:         false,
      gapLabel:      '',
    });

    var fbAlreadyLoaded = (_state.current && _state.current.mediaUrl === fbItem.mediaUrl);

    if (forceReload || !fbAlreadyLoaded || _tlMediaLoaded !== fbItem.mediaUrl) {
      _tlMediaLoaded = fbItem.mediaUrl;
      if (!_viewerReady) return;
      loadItemAt(fbItem, fbOffset);
      _opened = true;
    } else {
      // Already on the correct fallback item — check drift
      var fbDrift = Math.abs(_state.elapsed - fbOffset);
      if (fbDrift > 8) {
        var vfb = _el.video;
        if (vfb && isFinite(vfb.duration)) {
          vfb.currentTime = Math.min(fbOffset, vfb.duration - 0.5);
          console.log('[SNX TV] Fallback drift resync:', Math.round(fbDrift) + 's → seeking to', Math.round(fbOffset));
        }
      }
    }
    return;
  }

  // ── Active scheduled program ──────────────────────────────────────────────
  _scheduleMode = true;

  var item  = resolved.currentItem;
  var next  = resolved.nextItem;
  var offset = resolved.itemOffset || 0;

  if (!item || !item.mediaUrl) {
    // Program has no playable items right now
    _scheduleGap(resolved);
    return;
  }

  // Update state fields for program/entry
  _setState({
    next:          next || null,
    program:       resolved.program || null,
    scheduleEntry: resolved.scheduleEntry || null,
    isScheduled:   true,
    isGap:         false,
    gapLabel:      '',
  });

  // Check if we need to load/seek
  var alreadyLoaded = (_state.current && _state.current.mediaUrl === item.mediaUrl);

  if (forceReload || !alreadyLoaded || _tlMediaLoaded !== item.mediaUrl) {
    // Load this item with offset for join-in-progress / resync
    _tlMediaLoaded = item.mediaUrl;
    if (!_viewerReady) return;
    loadItemAt(item, offset);
    _opened = true;
  } else {
    // Already playing the right item — check drift
    var expectedPos = offset;
    var actualPos   = _state.elapsed;
    var drift       = Math.abs(actualPos - expectedPos);
    if (drift > 8) { // DRIFT_TOLERANCE seconds
      var v = _el.video;
      if (v && isFinite(v.duration)) {
        v.currentTime = Math.min(expectedPos, v.duration - 0.5);
        console.log('[SNX TV] Clock drift resync:', Math.round(drift) + 's → seeking to', Math.round(expectedPos));
      }
    }
  }
}

function _scheduleGap(resolved) {
  var label = (resolved && resolved.gapLabel) || 'Programming Resumes Soon';
  _setState({
    status:        'idle',
    current:       null,
    next:          resolved ? (resolved.nextItem || null) : null,
    onAir:         false,
    isScheduled:   true,
    isGap:         true,
    gapLabel:      label,
    program:       null,
    scheduleEntry: null,
  });
  _mediaLoaded = null;
  _tlMediaLoaded = null;
  _clearStallTimer();

  // Pause any playing video
  var v = _el.video;
  if (v && !v.paused) v.pause();
}

/**
 * Resynchronise against the live timeline.
 * Called by SNXTVTimeline._periodicResync() every 30s.
 * Also called on visibility restore and online restore.
 * Public so the timeline module can call it.
 */
function _timelineResync() {
  if (!_scheduleMode || !global.SNXTVTimeline) return;
  var resolved = global.SNXTVTimeline.resolve(Date.now());
  _applyTimelineState(resolved, false);
}

function _startQueue() {
  var queue = _getQueue();
  if (!queue.length) {
    _setState({ status: 'offline', onAir: false, current: null, next: null });
    return;
  }
  _queueIndex = 0;
  var item     = queue[0];
  var nextItem = queue.length > 1 ? queue[1] : null;
  _setState({ next: nextItem });
  loadItem(item);
}

/**
 * Load a playlist queue into the TV Core.
 * Called by SNXTVStudio when the Founder clicks "Load to TV".
 * Stage 4: disables schedule mode so manual playlist takes control.
 * @param {TVItem[]} tvItems
 * @param {string}   [name]
 */
function _loadPlaylistQueue(tvItems, name) {
  if (!tvItems || !tvItems.length) return;
  var valid = tvItems.filter(function (i) { return i && i.mediaUrl; });
  if (!valid.length) {
    _setState({ status: 'offline', onAir: false, current: null, next: null });
    return;
  }
  if (global.SNXTVStudio && typeof global.SNXTVStudio.setPlaylistQueue === 'function') {
    global.SNXTVStudio.setPlaylistQueue(valid);
  }
  // Disengage schedule mode — playlist takes manual control
  _scheduleMode  = false;
  _tlMediaLoaded = null;
  _playlistQueue = valid;
  _opened = true;
  _queueIndex = 0;
  var nextItem = valid.length > 1 ? valid[1] : null;
  _setState({
    next:          nextItem,
    isScheduled:   false,
    isGap:         false,
    gapLabel:      '',
    program:       null,
    scheduleEntry: null,
  });
  loadItem(valid[0]);
  console.log('[SNX TV] Playlist loaded:', name || 'unnamed', '|', valid.length, 'items');
}

/* ════════════════════════════════════════════════════════════
   ── STAGE 4: PAGE LIFECYCLE EVENTS ──────────────────────────
   Tab sleep / device sleep / offline / online recovery.
════════════════════════════════════════════════════════════ */

var _lifecycleAttached = false;

function _attachLifecycleEvents() {
  if (_lifecycleAttached) return;
  _lifecycleAttached = true;

  // ── visibilitychange — tab backgrounded/foregrounded, screen off/on ──
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      // Page became visible — re-resolve timeline to correct stale position
      if (_scheduleMode && global.SNXTVTimeline && _viewerReady) {
        // Small delay to let browser stabilise after visibility restore
        setTimeout(function () {
          _timelineResync();
          // If guide is open, refresh it
          if (_el.guideContent && _el.guideContent.classList.contains('snx-tv-guide-content--open')) {
            _renderGuide();
          }
        }, 300);
      }
    } else {
      // Page hidden — clear stall timer to avoid spurious recovery while backgrounded
      _clearStallTimer();
      // Pause canvas animation while backgrounded
      _snxViz.stop();
      _snxArtwork.stop();
    }
  });

  // ── pageshow — BFCache restore (iOS Safari, Android Chrome) ──
  global.addEventListener('pageshow', function (e) {
    if (!e.persisted) return; // not a BFCache restore
    if (_scheduleMode && global.SNXTVTimeline && _viewerReady) {
      setTimeout(function () {
        _timelineResync();
      }, 400);
    }
  });

  // ── focus — window refocused (desktop) ──
  global.addEventListener('focus', function () {
    if (_scheduleMode && global.SNXTVTimeline && _viewerReady) {
      // Only resync if we were away long enough to drift
      setTimeout(function () {
        var v = _el.video;
        if (v && _state.status === 'playing' && global.SNXTVTimeline) {
          var resolved = global.SNXTVTimeline.resolve(Date.now());
          if (resolved && resolved.mode === 'playing' && resolved.currentItem) {
            var drift = Math.abs(_state.elapsed - (resolved.itemOffset || 0));
            if (drift > 10) _timelineResync();
          }
        }
      }, 500);
    }
  });

  // ── offline — network lost ──
  global.addEventListener('offline', function () {
    _clearStallTimer();
    _setState({ isOffline: true });
    var v = _el.video;
    // Don't destroy state; if buffered, let browser play on.
    // If currently loading (no buffer), show offline state.
    if (v && _state.status === 'loading') {
      _setState({ status: 'idle', current: null, onAir: false,
                  isGap: _state.isScheduled, gapLabel: 'No internet connection — reconnecting…' });
    }
    console.log('[SNX TV] Network offline.');
  });

  // ── online — network restored ──
  global.addEventListener('online', function () {
    _setState({ isOffline: false });
    console.log('[SNX TV] Network online — refreshing schedule.');
    if (_scheduleMode && global.SNXTVTimeline) {
      // Give Firestore a moment to reconnect, then re-resolve
      setTimeout(function () {
        if (global.SNXTVTimeline) {
          _timelineResync();
        }
      }, 2000);
    } else if (!_scheduleMode && _state.status === 'idle') {
      // Adapter mode — try to restart queue
      _startQueue();
    }
  });
}

/* ── Submit Content Area — Stage 5 ── */
var _submitAreaInited = false;

function _initSubmitArea() {
  // Show the submit button for any signed-in user
  var cu = global._snxCurrentUser || null;
  var submitArea = document.getElementById('snxTvSubmitArea');
  if (!submitArea) return;

  submitArea.style.display = cu ? 'block' : 'none';
  if (_submitAreaInited || !cu) return;
  _submitAreaInited = true;

  var submitBtn   = document.getElementById('snxTvSubmitBtn');
  var modal       = document.getElementById('snxTvSubmitModal');
  var closeBtn    = document.getElementById('snxTvSubmitClose');
  var cancelBtn   = document.getElementById('snxTvSubCancelBtn');
  var sendBtn     = document.getElementById('snxTvSubSendBtn');
  var statusEl    = document.getElementById('snxTvSubStatus');

  if (!modal) return;

  function openModal() {
    // Clear previous form state
    var titleInput = document.getElementById('snxTvSubTitle');
    var urlInput   = document.getElementById('snxTvSubUrl');
    var descInput  = document.getElementById('snxTvSubDesc');
    if (titleInput) titleInput.value = '';
    if (urlInput)   urlInput.value   = '';
    if (descInput)  descInput.value  = '';
    if (statusEl)   { statusEl.style.display = 'none'; statusEl.textContent = ''; }
    if (sendBtn)    sendBtn.disabled = false;
    modal.style.display = 'flex';
  }

  function closeModal() {
    modal.style.display = 'none';
  }

  if (submitBtn) submitBtn.addEventListener('click', openModal);
  if (closeBtn)  closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });

  if (sendBtn) {
    sendBtn.addEventListener('click', async function () {
      var titleVal    = (document.getElementById('snxTvSubTitle') || {}).value || '';
      var urlVal      = (document.getElementById('snxTvSubUrl')   || {}).value || '';
      var descVal     = (document.getElementById('snxTvSubDesc')  || {}).value || '';
      var catVal      = (document.getElementById('snxTvSubCategory') || {}).value || 'general';
      var typeVal     = (document.getElementById('snxTvSubMediaType') || {}).value || 'video';

      if (!titleVal.trim()) {
        if (statusEl) { statusEl.style.display = 'block'; statusEl.style.color = '#ff7070'; statusEl.textContent = 'Title is required.'; }
        return;
      }
      if (!urlVal.trim() || !urlVal.match(/^https?:\/\//)) {
        if (statusEl) { statusEl.style.display = 'block'; statusEl.style.color = '#ff7070'; statusEl.textContent = 'A valid HTTPS media URL is required.'; }
        return;
      }

      if (statusEl) { statusEl.style.display = 'block'; statusEl.style.color = 'rgba(255,255,255,0.5)'; statusEl.textContent = 'Submitting…'; }
      sendBtn.disabled = true;

      try {
        if (!global.SNXTVStudio || typeof global.SNXTVStudio.submitContent !== 'function') {
          throw new Error('TV submission service not ready. Try again in a moment.');
        }
        await global.SNXTVStudio.submitContent({
          title:       titleVal.trim(),
          description: descVal.trim(),
          category:    catVal,
          mediaType:   typeVal,
          mediaUrl:    urlVal.trim(),
        });
        if (statusEl) { statusEl.style.color = '#00d45a'; statusEl.textContent = '✓ Submitted for review! Thank you.'; }
        setTimeout(closeModal, 2200);
      } catch (err) {
        if (statusEl) { statusEl.style.color = '#ff7070'; statusEl.textContent = '✗ ' + (err.message || 'Submission failed.'); }
        sendBtn.disabled = false;
      }
    });
  }
}

/* ── TV Studio injection ── */
var _studioInjected = false;

function _initStudio() {
  if (_studioInjected) return;
  if ((global._snxRole || '') !== 'founder') return;
  _studioInjected = true;

  var tvPage = document.getElementById('tvPage');
  if (!tvPage) return;

  // Inject Studio toggle button into TV header
  var header = tvPage.querySelector('.snx-tv-header');
  if (header && !document.getElementById('snxtvStudioBtn')) {
    var btn = document.createElement('button');
    btn.id = 'snxtvStudioBtn';
    btn.type = 'button';
    btn.className = 'snxtv-studio-open-btn';
    btn.textContent = '🎬 TV Studio';
    btn.addEventListener('click', function () {
      if (global.SNXTVStudio) global.SNXTVStudio.show();
    });
    header.appendChild(btn);
  }

  // Create studio overlay
  if (!document.getElementById('snxtvStudioOverlay')) {
    var overlay = document.createElement('div');
    overlay.id = 'snxtvStudioOverlay';
    overlay.className = 'snxtv-studio-overlay';
    document.body.appendChild(overlay);

    function _tryMount() {
      if (global.SNXTVStudio && typeof global.SNXTVStudio.mount === 'function') {
        global.SNXTVStudio.mount(overlay);
      } else {
        setTimeout(_tryMount, 500);
      }
    }
    _tryMount();
  }
}

/* ════════════════════════════════════════════════════════════
   ── AUTH INTEGRATION ──────────────────────────────────────
   Observes SNS auth events.
════════════════════════════════════════════════════════════ */

global.addEventListener('snxAuthStateChanged', function (e) {
  var user = e.detail && e.detail.user;
  if (!user) return;
  // Ensure Studio is available for founder, and attach lifecycle events once
  _attachLifecycleEvents();
  if ((global._snxRole || '') === 'founder' && _viewerReady) {
    _initStudio();
  }
});

// Also attach lifecycle events on DOM ready (does not depend on auth)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _attachLifecycleEvents);
} else {
  _attachLifecycleEvents();
}

global.addEventListener('snxAuthSignOut', function () {
  pageLeave();
  _clearStallTimer();
  _setState({
    status: 'idle', current: null, next: null, onAir: false,
    elapsed: 0, duration: 0, program: null, scheduleEntry: null,
    isScheduled: false, isGap: false, gapLabel: '', isOffline: false,
    error: null, needsUserGesture: false
  });
  _mediaLoaded      = null;
  _tlMediaLoaded    = null;
  _opened           = false;
  _queueIndex       = 0;
  _playlistQueue    = null;
  _scheduleMode     = false;
  _mediaErrorCount  = 0;
  _recovering       = false;
  _submitAreaInited = false;   // reset so it re-inits on next sign-in
  // Hide submit area
  var sa = document.getElementById('snxTvSubmitArea');
  if (sa) sa.style.display = 'none';

  // Stop timeline listener and subscriber
  if (_unsubTimeline) { try { _unsubTimeline(); } catch(_){} _unsubTimeline = null; }
  if (global.SNXTVTimeline && typeof global.SNXTVTimeline.stopListening === 'function') {
    global.SNXTVTimeline.stopListening();
  }

  _snxViz.stop();
  _snxArtwork.stop();

  if (global.SNXTVStudio && typeof global.SNXTVStudio.unmount === 'function') {
    global.SNXTVStudio.unmount();
  }
  _studioInjected = false;

  // Reset viewer ready flag so it re-initialises on next sign-in if page is navigated to
  // Note: keep _el populated — DOM is still in place; just reset the subscription guard
  // so that _attachMediaListeners is not called twice
  // _viewerReady stays true: the video element is still in the DOM and listeners are attached.
  // We just cleared playing state. The viewer will render idle on next state snapshot.
});

/* ════════════════════════════════════════════════════════════
   ── SHADOW NEXUS MUSIC VISUALIZER ─────────────────────────
   Canvas-based audio visualizer for audio-only TV content.
   Connects to the existing <video> element via Web Audio API.
   No second audio playback engine — we only analyse, not play.
════════════════════════════════════════════════════════════ */

var _snxViz = (function () {

  var _canvas    = null;
  var _ctx       = null;
  var _raf       = null;
  var _analyser  = null;
  var _srcNode   = null;
  var _audioCtx  = null;
  var _connected = false;
  var _active    = false;
  var _lastVideo = null;

  // Particle field
  var _particles = [];
  var PARTICLE_COUNT = 55;

  // Frequency data buffer
  var _freqData  = null;
  var _timeData  = null;

  function _initParticles(w, h) {
    _particles = [];
    for (var i = 0; i < PARTICLE_COUNT; i++) {
      _particles.push({
        x:  Math.random() * w,
        y:  Math.random() * h,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        r:  Math.random() * 2 + 0.5,
        a:  Math.random() * 0.4 + 0.05,
      });
    }
  }

  function _connectAnalyser(videoEl) {
    if (_connected && _lastVideo === videoEl) return;
    _disconnectAnalyser();
    _lastVideo = videoEl;
    if (!videoEl) return;
    try {
      if (!_audioCtx) {
        var AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        _audioCtx = new AudioCtx();
      }
      if (_audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(function(){});
      }
      _srcNode  = _audioCtx.createMediaElementSource(videoEl);
      _analyser = _audioCtx.createAnalyser();
      _analyser.fftSize = 256;
      _analyser.smoothingTimeConstant = 0.82;
      // Signal path: source → analyser → destination (speakers remain active)
      _srcNode.connect(_analyser);
      _analyser.connect(_audioCtx.destination);
      _freqData = new Uint8Array(_analyser.frequencyBinCount);
      _timeData = new Uint8Array(_analyser.frequencyBinCount);
      _connected = true;
    } catch (e) {
      // Element already captured by another AudioContext or browser restriction
      console.info('[SNX-VIZ] Web Audio connect skipped (non-fatal):', e.message);
      _connected = false;
      _analyser  = null;
      _srcNode   = null;
    }
  }

  function _disconnectAnalyser() {
    try {
      if (_srcNode)  { _srcNode.disconnect();  _srcNode  = null; }
      if (_analyser) { _analyser.disconnect(); _analyser = null; }
    } catch(e) {}
    _connected = false;
    _lastVideo = null;
    _freqData  = null;
    _timeData  = null;
  }

  function _bandEnergy(data, lo, hi) {
    if (!data) return 0;
    var sum = 0, n = hi - lo;
    for (var i = lo; i < hi && i < data.length; i++) sum += data[i];
    return n > 0 ? (sum / n) / 255 : 0;
  }

  function _draw() {
    if (!_active || !_canvas || !_ctx) return;
    _raf = requestAnimationFrame(_draw);

    var w = _canvas.width;
    var h = _canvas.height;
    if (w < 2 || h < 2) return;

    if (_analyser && _freqData) {
      _analyser.getByteFrequencyData(_freqData);
    }
    if (_analyser && _timeData) {
      _analyser.getByteTimeDomainData(_timeData);
    }

    var freq = _freqData;
    var time = _timeData;

    var bass   = _bandEnergy(freq, 0,  4);
    var mid    = _bandEnergy(freq, 4,  16);
    var treble = _bandEnergy(freq, 16, 32);
    var energy = bass * 0.5 + mid * 0.3 + treble * 0.2;

    // Trail fade
    _ctx.fillStyle = 'rgba(2, 4, 15, 0.55)';
    _ctx.fillRect(0, 0, w, h);

    // Deep radial background gradient, energy-reactive
    var gAlpha = 0.08 + energy * 0.12;
    var bgGrad = _ctx.createRadialGradient(w * 0.5, h * 0.55, 0, w * 0.5, h * 0.5, w * 0.7);
    bgGrad.addColorStop(0,   'rgba(0,40,100,' + gAlpha + ')');
    bgGrad.addColorStop(0.5, 'rgba(0,10,40,'  + (gAlpha * 0.5) + ')');
    bgGrad.addColorStop(1,   'rgba(0,0,0,0)');
    _ctx.fillStyle = bgGrad;
    _ctx.fillRect(0, 0, w, h);

    // Spectrum bars
    if (freq) {
      var barCount = 48;
      var barW     = w / barCount;
      var barGap   = barW * 0.35;
      var maxBarH  = h * 0.38;
      var centerY  = h * 0.72;

      for (var bi = 0; bi < barCount; bi++) {
        var idx   = Math.floor((bi / barCount) * (freq.length * 0.6));
        var val   = freq[idx] / 255;
        var barH  = val * maxBarH;
        var bx    = bi * barW + barGap * 0.5;
        var bw    = barW - barGap;
        var hue   = 195 + (bi / barCount) * 40;
        var sat   = 80  + val * 20;
        var lit   = 35  + val * 45;
        var alp   = 0.2 + val * 0.75;

        var barGrad = _ctx.createLinearGradient(0, centerY - barH, 0, centerY);
        barGrad.addColorStop(0, 'hsla(' + hue + ',' + sat + '%,' + (lit + 15) + '%,' + alp + ')');
        barGrad.addColorStop(1, 'hsla(' + hue + ',' + sat + '%,' + lit + '%,0.05)');
        _ctx.fillStyle = barGrad;
        _ctx.fillRect(bx, centerY - barH, bw, barH);

        // Mirror bars (subtle)
        _ctx.fillStyle = 'hsla(' + hue + ',' + sat + '%,' + lit + '%,' + (alp * 0.12) + ')';
        _ctx.fillRect(bx, centerY, bw, barH * 0.28);
      }
    }

    // Waveform line
    if (time) {
      _ctx.beginPath();
      _ctx.strokeStyle = 'rgba(0,174,239,' + (0.3 + energy * 0.55) + ')';
      _ctx.lineWidth   = 1.5 + energy * 2.5;
      _ctx.shadowBlur  = 8 + energy * 18;
      _ctx.shadowColor = 'rgba(0,174,239,0.8)';
      var sliceW = w / time.length;
      var xw = 0;
      for (var wi = 0; wi < time.length; wi++) {
        var wv = time[wi] / 128 - 1;
        var wy = h * 0.5 + wv * h * 0.12 * (1 + energy * 0.8);
        if (wi === 0) _ctx.moveTo(xw, wy);
        else          _ctx.lineTo(xw, wy);
        xw += sliceW;
      }
      _ctx.stroke();
      _ctx.shadowBlur  = 0;
      _ctx.shadowColor = 'transparent';
    }

    // Floating particles
    for (var pi = 0; pi < _particles.length; pi++) {
      var p = _particles[pi];
      p.x += p.vx * (1 + energy * 2.5);
      p.y += p.vy * (1 + energy * 1.5);
      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;
      var pa = p.a * (0.4 + bass * 0.8);
      _ctx.beginPath();
      _ctx.arc(p.x, p.y, p.r * (1 + energy * 0.6), 0, Math.PI * 2);
      _ctx.fillStyle = 'rgba(0,174,239,' + pa + ')';
      _ctx.fill();
    }

    // Bass-reactive central glow
    var glowR = w * (0.08 + bass * 0.18);
    var glowG = _ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, glowR);
    glowG.addColorStop(0, 'rgba(0,174,239,' + (bass * 0.3) + ')');
    glowG.addColorStop(1, 'rgba(0,174,239,0)');
    _ctx.fillStyle = glowG;
    _ctx.fillRect(0, 0, w, h);

    // Channel label
    _ctx.globalAlpha   = 0.15 + energy * 0.1;
    _ctx.font          = 'bold ' + Math.max(8, Math.round(w * 0.018)) + 'px system-ui,sans-serif';
    _ctx.fillStyle     = '#00AEEF';
    _ctx.textAlign     = 'center';
    _ctx.fillText('SHADOW NEXUS TV', w * 0.5, h * 0.89);
    _ctx.globalAlpha   = 1;
    _ctx.textAlign     = 'left';
  }

  function _resizeCanvas() {
    if (!_canvas) return;
    var wrap = _canvas.parentElement;
    if (!wrap) return;
    var w = wrap.offsetWidth  || 640;
    var h = wrap.offsetHeight || 360;
    if (_canvas.width !== w || _canvas.height !== h) {
      _canvas.width  = w;
      _canvas.height = h;
      _initParticles(w, h);
    }
  }

  function start(videoEl) {
    _canvas = document.getElementById('snxTvVisualizer');
    if (!_canvas) return;
    _ctx = _canvas.getContext('2d');
    if (!_ctx) return;
    _resizeCanvas();
    _connectAnalyser(videoEl);
    if (!_active) {
      _active = true;
      _raf = requestAnimationFrame(_draw);
    }
  }

  function stop() {
    _active = false;
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
    if (_canvas && _ctx) {
      _ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    }
    // Keep analyser connected — audio still plays; we just stop drawing
  }

  function destroy() {
    stop();
    _disconnectAnalyser();
    if (_audioCtx) {
      try { _audioCtx.close(); } catch(e) {}
      _audioCtx = null;
    }
  }

  return { start: start, stop: stop, destroy: destroy };
})();

/* ════════════════════════════════════════════════════════════
   ── ARTWORK CINEMATIC MODE ────────────────────────────────
   Ken Burns slow pan + glow pulse animation for artwork panel.
════════════════════════════════════════════════════════════ */

var _snxArtwork = (function () {

  var _active = false;
  var _raf    = null;
  var _t      = 0;

  function _tick() {
    if (!_active) return;
    _raf = requestAnimationFrame(_tick);
    _t  += 0.0008;

    var bg = document.getElementById('snxTvArtworkBg');
    if (bg) {
      var px = 50 + Math.sin(_t * 0.7) * 3;
      var py = 50 + Math.cos(_t * 0.5) * 3;
      var sc = 1.08 + Math.sin(_t * 0.3) * 0.04;
      bg.style.backgroundPosition = px + '% ' + py + '%';
      bg.style.transform          = 'scale(' + sc + ')';
    }

    var glow = document.getElementById('snxTvArtworkGlow');
    if (glow) {
      glow.style.opacity = (0.3 + Math.sin(_t * 1.8) * 0.12).toFixed(3);
    }
  }

  function start() {
    if (!_active) {
      _active = true;
      _raf    = requestAnimationFrame(_tick);
    }
  }

  function stop() {
    _active = false;
    if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
  }

  return { start: start, stop: stop };
})();

/* ════════════════════════════════════════════════════════════
   ── PUBLIC API ────────────────────────────────────────────
   Exposed as window.SNXTV
════════════════════════════════════════════════════════════ */

global.SNXTV = {
  // Lifecycle
  pageOpen:  pageOpen,
  pageLeave: pageLeave,

  // Core read/subscribe
  getState:  getState,
  subscribe: subscribe,

  // Media Adapter — delegates to SNXTVStudio
  _adapter:  { getQueue: _getQueue },

  // Playlist loader (called by SNXTVStudio)
  _loadPlaylistQueue: _loadPlaylistQueue,

  // Timeline resync hook (called by SNXTVTimeline)
  _timelineResync: _timelineResync,

  // Version
  version: 'SNS-2026-TV-STAGE4-001'
};

})(window);
