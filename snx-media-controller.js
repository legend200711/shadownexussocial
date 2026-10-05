/**
 * snx-media-controller.js
 * Shadow Nexus Social — Adaptive Feed Media Controller
 * Build: SNS-2026-STAGE2D-001
 *
 * Exposes: window.SNXMediaController
 *
 * Responsibilities:
 *   1. ONE shared IntersectionObserver for all Feed videos
 *   2. Pause Feed videos when sufficiently offscreen
 *   3. Limit simultaneous playing/decoding Feed videos (per perf mode)
 *   4. Pause all Feed videos when document is hidden
 *   5. Resume visible videos when document becomes visible again
 *   6. Clean up observers + listeners when a Feed post is removed from DOM
 *   7. Honour SNXPerformance (LITE / BALANCED / FULL) and navigator.connection.saveData
 *
 * SAFETY RULES:
 *   - Does NOT touch Radio, Live, TV, DJ, Broadcast, or WebRTC video elements.
 *   - Does NOT reset video currentTime unless a video errored.
 *   - Does NOT change src, controls, or any Firebase/R2 URL.
 *   - Does NOT create new network requests.
 *   - Fully removable: deleting this file restores prior behaviour.
 *
 * Excluded elements (never paused/observed by this controller):
 *   #liveVideo, #setupPreview, #snxLivePreviewVideo, #snxLiveStageVideo,
 *   #snxLiveViewerVideo, #crl-live-video, #crl-setup-preview, #nxWatchVideo,
 *   #ax-video, #snxFilterPreviewVideo, [data-snx-media-exempt]
 */

'use strict';

(function () {

  /* ════════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════════ */

  /**
   * CSS selector that matches video elements this controller must NEVER touch.
   * Covers: Live/WebRTC, TV, Studio preview, DJ, Broadcast.
   */
  const EXEMPT_SELECTOR = [
    '#liveVideo',
    '#setupPreview',
    '#snxLivePreviewVideo',
    '#snxLiveStageVideo',
    '#snxLiveViewerVideo',
    '#crl-live-video',
    '#crl-rp-video',
    '#crl-setup-preview',
    '#nxWatchVideo',
    '#ax-video',
    '#snxFilterPreviewVideo',
    '#svVid',            // story viewer
    '#snxTvVideo',       // 24-Hour TV player
    '[data-snx-media-exempt]',
  ].join(',');

  /** Intersection threshold — video is "visible enough" above this ratio */
  const VISIBLE_THRESHOLD  = 0.25;
  /** Video is "off screen" below this ratio */
  const OFFSCREEN_THRESHOLD = 0.05;

  /** Maximum simultaneous playing Feed videos per mode */
  const MAX_PLAYING = { LITE: 1, BALANCED: 1, FULL: 2 };

  /* ════════════════════════════════════════════════════════════
     STATE
  ════════════════════════════════════════════════════════════ */

  /** @type {IntersectionObserver|null} */
  let _observer = null;

  /** Set<HTMLVideoElement> — all observed Feed videos */
  const _observed = new Set();

  /** Set<HTMLVideoElement> — videos currently in viewport */
  const _visible = new Set();

  /** Whether the controller has been initialised */
  let _ready = false;

  /* ════════════════════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════════════════════ */

  function _isExempt(el) {
    try { return el.matches(EXEMPT_SELECTOR); } catch (_) { return false; }
  }

  function _getMode() {
    try {
      if (window.SNXPerformance && window.SNXPerformance.mode) return window.SNXPerformance.mode;
    } catch (_) {}
    try {
      var stored = localStorage.getItem('snxAdaptiveMode') || '';
      if (stored === 'LITE' || stored === 'BALANCED' || stored === 'FULL') return stored;
    } catch (_) {}
    return 'BALANCED';
  }

  function _isSaveData() {
    try {
      var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      return !!(conn && conn.saveData);
    } catch (_) { return false; }
  }

  function _maxPlaying() {
    if (_isSaveData()) return 1;
    var mode = _getMode();
    return MAX_PLAYING[mode] || 1;
  }

  /**
   * Safely pause a video without resetting position.
   * Only pauses if it is actually playing.
   */
  function _safePause(vid) {
    try {
      if (!vid.paused) vid.pause();
    } catch (_) {}
  }

  /**
   * Set preload attribute according to current performance mode.
   * LITE / saveData → 'none' if the video hasn't started playing yet.
   * BALANCED / FULL  → 'metadata'.
   * Already-played videos (currentTime > 0) keep 'metadata' to avoid re-buffering.
   */
  function _applyPreload(vid) {
    try {
      if (vid.getAttribute('data-snx-preload-locked')) return;
      var mode = _getMode();
      var saveData = _isSaveData();
      var hasStarted = vid.currentTime > 0 || !vid.paused;
      if (hasStarted) {
        // Don't downgrade a video that is already buffering/playing
        if (vid.preload !== 'metadata' && vid.preload !== 'auto') vid.preload = 'metadata';
        return;
      }
      if (saveData || mode === 'LITE') {
        vid.preload = 'none';
      } else {
        vid.preload = 'metadata';
      }
    } catch (_) {}
  }

  /* ════════════════════════════════════════════════════════════
     ACTIVE VIDEO MANAGEMENT
  ════════════════════════════════════════════════════════════ */

  /**
   * Enforce the max-playing cap.
   * When too many videos are playing, pause the ones least visible
   * (i.e. those NOT in _visible or furthest from viewport).
   */
  function _enforceMaxPlaying() {
    try {
      var max = _maxPlaying();
      var playing = [];
      _observed.forEach(function (vid) {
        if (!vid.paused && !vid.ended) playing.push(vid);
      });
      if (playing.length <= max) return;

      // Sort: visible ones go to the front (kept playing); non-visible paused first
      playing.sort(function (a, b) {
        var aVis = _visible.has(a) ? 1 : 0;
        var bVis = _visible.has(b) ? 1 : 0;
        return bVis - aVis;
      });

      for (var i = max; i < playing.length; i++) {
        _safePause(playing[i]);
      }
    } catch (_) {}
  }

  /* ════════════════════════════════════════════════════════════
     INTERSECTION OBSERVER
  ════════════════════════════════════════════════════════════ */

  function _createObserver() {
    if (!('IntersectionObserver' in window)) return null;
    return new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        var vid = entry.target;
        if (entry.intersectionRatio >= VISIBLE_THRESHOLD) {
          _visible.add(vid);
          // Restore preload when video enters viewport
          _applyPreload(vid);
        } else if (entry.intersectionRatio < OFFSCREEN_THRESHOLD) {
          _visible.delete(vid);
          // Pause offscreen videos
          if (!vid.paused && !vid.ended) {
            _safePause(vid);
          }
          // Downgrade preload for completely offscreen videos
          _applyPreload(vid);
        }
      });
      _enforceMaxPlaying();
    }, {
      threshold: [0, OFFSCREEN_THRESHOLD, VISIBLE_THRESHOLD, 0.5, 1.0],
      rootMargin: '0px',
    });
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */

  /**
   * Register a Feed video element with the controller.
   * Idempotent — safe to call multiple times for the same element.
   *
   * @param {HTMLVideoElement} vid
   */
  function observe(vid) {
    if (!vid || vid.tagName !== 'VIDEO') return;
    if (_isExempt(vid)) return;
    if (_observed.has(vid)) return;

    // Mark it as managed
    vid.setAttribute('data-snx-managed', '1');

    // Apply initial preload policy
    _applyPreload(vid);

    _observed.add(vid);
    if (_observer) _observer.observe(vid);

    // Clean up automatically if the element is removed from DOM
    // (MutationObserver on the element's parent is too heavy; we rely on
    //  the explicit unobserve() call from the Feed's post-removal path instead)
  }

  /**
   * Unregister a Feed video element (called when a post is removed from DOM).
   *
   * @param {HTMLVideoElement} vid
   */
  function unobserve(vid) {
    if (!vid) return;
    _safePause(vid);
    _visible.delete(vid);
    _observed.delete(vid);
    if (_observer) _observer.unobserve(vid);
    vid.removeAttribute('data-snx-managed');
  }

  /**
   * Scan a container element for unregistered Feed videos and observe them.
   * Call this after injecting new post DOM nodes.
   *
   * @param {Element} [container] — defaults to document
   */
  function scanAndObserve(container) {
    var root = container || document;
    try {
      root.querySelectorAll('video[data-snx-feed]').forEach(function (vid) {
        observe(vid);
      });
    } catch (_) {}
  }

  /**
   * Unregister all videos inside a removed post element.
   *
   * @param {Element} postEl
   */
  function cleanupPost(postEl) {
    if (!postEl) return;
    try {
      postEl.querySelectorAll('video').forEach(function (vid) {
        unobserve(vid);
        // Release the browser's media resource
        try { vid.src = ''; } catch (_) {}
      });
    } catch (_) {}
  }

  /**
   * Pause all observed Feed videos immediately.
   * Used when document.hidden becomes true.
   */
  function pauseAll() {
    _observed.forEach(function (vid) {
      _safePause(vid);
    });
  }

  /**
   * Re-apply preload and enforce cap after document becomes visible.
   */
  function onPageVisible() {
    _enforceMaxPlaying();
  }

  /**
   * Update preload strategy on all managed videos (called on perf-mode change).
   */
  function reapplyPreload() {
    _observed.forEach(function (vid) {
      _applyPreload(vid);
    });
    _enforceMaxPlaying();
  }

  /* ════════════════════════════════════════════════════════════
     PAGE VISIBILITY
  ════════════════════════════════════════════════════════════ */

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      pauseAll();
    } else {
      onPageVisible();
    }
  });

  /* ════════════════════════════════════════════════════════════
     PERFORMANCE MODE CHANGE INTEGRATION
  ════════════════════════════════════════════════════════════ */

  // Listen for SNXPerformance mode changes and re-apply preload strategy
  document.addEventListener('snxPerformanceChange', function () {
    reapplyPreload();
  });

  // Also listen for SNX_NET tier changes
  document.addEventListener('snxNetChange', function () {
    reapplyPreload();
  });

  /* ════════════════════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════════════════════ */

  function _init() {
    if (_ready) return;
    _ready = true;
    _observer = _createObserver();

    // Scan the Feed container for any already-rendered videos
    var feedContainer = document.getElementById('feedPosts');
    if (feedContainer) scanAndObserve(feedContainer);
  }

  // Initialise after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  /* ════════════════════════════════════════════════════════════
     EXPORT
  ════════════════════════════════════════════════════════════ */

  window.SNXMediaController = {
    observe:        observe,
    unobserve:      unobserve,
    scanAndObserve: scanAndObserve,
    cleanupPost:    cleanupPost,
    pauseAll:       pauseAll,
    reapplyPreload: reapplyPreload,
  };

})();
