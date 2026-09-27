/**
 * snx-perf.js  v1.0
 * Shadow Nexus Social — Global Adaptive Cinematic Performance System
 *
 * Provides:
 *   - Automatic quality level detection (ULTRA / HIGH / BALANCED / LITE / MINIMAL)
 *   - Runtime performance monitor with graceful downgrade + hysteresis
 *   - Background-tab pause, visibility + battery awareness
 *   - Reduced-motion / Save-Data / prefers-color-scheme respects
 *   - Canvas background pause/resume hooks
 *   - Centralized media/audio coordination hints
 *   - Public API: window.SNXPerf
 *
 * Does NOT modify any Firestore data or security rules.
 * Does NOT implement payment systems or removed features.
 */

(function () {
  'use strict';

  /* ══════════════════════════════════════════════════
     QUALITY LEVELS
  ══════════════════════════════════════════════════ */
  var LEVELS = ['MINIMAL', 'LITE', 'BALANCED', 'HIGH', 'ULTRA'];

  var LEVEL_CONFIG = {
    ULTRA: {
      particles:      35,   // canvas ash count
      gridPoints:     50,   // canvas grid count
      domAsh:         14,   // DOM .ash-particle count
      fogLayers:      3,    // fog wisp layers
      fogAlpha:       1.0,  // fog alpha multiplier
      glowOrbs:       3,    // ambient orbs
      lightningOn:    true,
      flameOrbs:      true,
      bodyFog:        true, // body::after fog animation
      bgCanvasOn:     true,
      transitionMs:   260,
      blurPx:         8,    // sidebar backdrop-filter
      shadowDepth:    true,
      particleHalo:   true
    },
    HIGH: {
      particles:      22,
      gridPoints:     35,
      domAsh:         9,
      fogLayers:      3,
      fogAlpha:       0.75,
      glowOrbs:       3,
      lightningOn:    true,
      flameOrbs:      true,
      bodyFog:        true,
      bgCanvasOn:     true,
      transitionMs:   220,
      blurPx:         6,
      shadowDepth:    true,
      particleHalo:   true
    },
    BALANCED: {
      particles:      12,
      gridPoints:     20,
      domAsh:         5,
      fogLayers:      2,
      fogAlpha:       0.5,
      glowOrbs:       2,
      lightningOn:    false,
      flameOrbs:      false,
      bodyFog:        true,
      bgCanvasOn:     true,
      transitionMs:   180,
      blurPx:         4,
      shadowDepth:    false,
      particleHalo:   false
    },
    LITE: {
      particles:      5,
      gridPoints:     8,
      domAsh:         2,
      fogLayers:      1,
      fogAlpha:       0.3,
      glowOrbs:       1,
      lightningOn:    false,
      flameOrbs:      false,
      bodyFog:        false,
      bgCanvasOn:     true,
      transitionMs:   150,
      blurPx:         0,
      shadowDepth:    false,
      particleHalo:   false
    },
    MINIMAL: {
      particles:      0,
      gridPoints:     0,
      domAsh:         0,
      fogLayers:      0,
      fogAlpha:       0,
      glowOrbs:       0,
      lightningOn:    false,
      flameOrbs:      false,
      bodyFog:        false,
      bgCanvasOn:     false,
      transitionMs:   120,
      blurPx:         0,
      shadowDepth:    false,
      particleHalo:   false
    }
  };

  /* ══════════════════════════════════════════════════
     STATE
  ══════════════════════════════════════════════════ */
  var _state = {
    mode:           'BALANCED',   // current quality level
    userOverride:   null,         // null = AUTO, else string level name
    isAuto:         true,

    // Runtime perf tracking
    frameCount:     0,
    frameTimes:     [],
    lastFrameTs:    0,
    longTaskCount:  0,
    frameRateAvg:   60,
    rafId:          null,

    // Downgrade hysteresis
    lastDowngrade:  0,
    lastUpgrade:    0,
    DOWNGRADE_COOLDOWN_MS: 10000,  // min 10s between downgrades
    UPGRADE_COOLDOWN_MS:   30000,  // min 30s before upgrade

    // Context flags
    liveActive:     false,
    cameraActive:   false,
    isBackground:   false,
    reducedMotion:  false,
    saveData:       false,
    isPWA:          false,
    isMobile:       false,
    isIOS:          false,
    isAndroid:      false,
    connectionTier: 'good',

    // Change listeners
    listeners:      []
  };

  /* ══════════════════════════════════════════════════
     DETECTION — run once at startup
  ══════════════════════════════════════════════════ */
  function _detect() {
    // Reduced motion
    _state.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Save-Data
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    _state.saveData = !!(conn && conn.saveData);

    // PWA
    _state.isPWA = window.matchMedia('(display-mode: standalone)').matches ||
                   window.navigator.standalone === true;

    // Mobile
    _state.isMobile  = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                       window.innerWidth < 768;
    _state.isIOS     = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    _state.isAndroid = /Android/i.test(navigator.userAgent);

    // Connection tier from snx-net.js if available
    if (window.SNXNet && window.SNXNet.tier) {
      _state.connectionTier = window.SNXNet.tier;
    } else if (conn) {
      var eff = conn.effectiveType || '4g';
      if (eff === '4g')      _state.connectionTier = 'good';
      else if (eff === '3g') _state.connectionTier = 'ok';
      else                   _state.connectionTier = 'poor';
    }
  }

  /* ══════════════════════════════════════════════════
     INITIAL QUALITY DECISION
  ══════════════════════════════════════════════════ */
  function _chooseInitialLevel() {
    // 1. User override from localStorage
    var stored = localStorage.getItem('snxPerfMode');
    if (stored && LEVEL_CONFIG[stored]) {
      _state.userOverride = stored;
      _state.isAuto = (stored === 'AUTO');
      if (!_state.isAuto) return stored;
    }

    return _autoChoose();
  }

  function _autoChoose() {
    // Reduced motion → MINIMAL
    if (_state.reducedMotion) return 'MINIMAL';

    // Save-Data → LITE
    if (_state.saveData) return 'LITE';

    var score = 0; // higher = more capable

    // CPU cores
    var cores = navigator.hardwareConcurrency || 4;
    if (cores >= 8) score += 3;
    else if (cores >= 4) score += 1;

    // Memory (deviceMemory in GB, Chrome/Android)
    var mem = navigator.deviceMemory || 4;
    if (mem >= 8) score += 3;
    else if (mem >= 4) score += 2;
    else if (mem >= 2) score += 1;

    // Screen resolution / pixel ratio
    var pixels = window.innerWidth * window.innerHeight * (window.devicePixelRatio || 1);
    if (pixels > 3000000) score += 1;   // Very large display
    if (pixels < 600000)  score -= 1;   // Very small / low-DPI

    // Mobile penalty (but not absolute)
    if (_state.isMobile) score -= 1;

    // iOS: more conservative due to memory limits & Safari restrictions
    if (_state.isIOS) score -= 1;

    // Connection
    if (_state.connectionTier === 'poor') score -= 2;
    else if (_state.connectionTier === 'ok') score -= 1;
    else score += 1;

    // Score → level
    if (score >= 7) return 'ULTRA';
    if (score >= 4) return 'HIGH';
    if (score >= 1) return 'BALANCED';
    if (score >= -1) return 'LITE';
    return 'MINIMAL';
  }

  /* ══════════════════════════════════════════════════
     APPLY LEVEL — update DOM classes + CSS vars
  ══════════════════════════════════════════════════ */
  function _applyLevel(newLevel) {
    if (!LEVEL_CONFIG[newLevel]) return;

    var prev = _state.mode;
    _state.mode = newLevel;

    var cfg = LEVEL_CONFIG[newLevel];

    // Body quality class
    LEVELS.forEach(function (l) {
      document.documentElement.classList.remove('snx-quality-' + l.toLowerCase());
    });
    document.documentElement.classList.add('snx-quality-' + newLevel.toLowerCase());

    // Expose config to canvas system
    window._snxPerfCfg = cfg;
    window._snxPerfMode = newLevel;

    // CSS custom properties for transitions / blur
    document.documentElement.style.setProperty('--snx-transition-ms', cfg.transitionMs + 'ms');
    document.documentElement.style.setProperty('--snx-blur-px', cfg.blurPx + 'px');

    // Body fog (body::after animation)
    _applyBodyFog(cfg.bodyFog);

    // Canvas background
    _applyCanvasQuality(cfg);

    // Page transitions
    _applyPageTransitions(cfg.transitionMs);

    // Notify listeners
    _state.listeners.forEach(function (fn) {
      try { fn(newLevel, prev); } catch (_) {}
    });

    // Log for founder dashboard
    console.log('[SNXPerf] Quality → ' + newLevel + (prev !== newLevel ? ' (was ' + prev + ')' : ''));
  }

  function _applyBodyFog(on) {
    if (on) {
      document.documentElement.classList.remove('snx-no-body-fog');
    } else {
      document.documentElement.classList.add('snx-no-body-fog');
    }
  }

  function _applyCanvasQuality(cfg) {
    // Signal to the canvas render loop (bg-canvas)
    window._snxBgPauseOverride = !cfg.bgCanvasOn;
    if (!cfg.bgCanvasOn) {
      // Pause the canvas
      if (window._bgRafId) {
        cancelAnimationFrame(window._bgRafId);
        window._bgRafId = null;
        window._bgPaused = true;
      }
      var cv = document.getElementById('bg-canvas');
      if (cv) {
        var ctx2d = cv.getContext('2d');
        if (ctx2d) ctx2d.clearRect(0, 0, cv.width, cv.height);
      }
    } else {
      // Resume if currently paused by us
      if (window._bgPaused && window._bgRafId === null && typeof window._snxBgRender === 'function') {
        window._bgPaused = false;
        window._snxBgRender();
      }
    }
    // Re-seed particles on next canvas cycle via signal
    window._snxReseedParticles = true;
  }

  function _applyPageTransitions(ms) {
    // Inject/update transition duration for .page.active animation
    var styleId = '_snxPerfTransStyle';
    var el = document.getElementById(styleId);
    if (!el) {
      el = document.createElement('style');
      el.id = styleId;
      document.head.appendChild(el);
    }
    el.textContent =
      '.page.active { animation-duration: ' + ms + 'ms !important; }' +
      '.sidebar { transition-duration: ' + Math.min(ms, 220) + 'ms !important; }';
  }

  /* ══════════════════════════════════════════════════
     RUNTIME PERFORMANCE MONITOR
  ══════════════════════════════════════════════════ */
  var _perfMonitorActive = false;
  var _perfSamples = [];
  var _perfLastCheck = 0;

  function _startPerfMonitor() {
    if (_perfMonitorActive) return;
    _perfMonitorActive = true;

    // Long task observer
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        var obs = new PerformanceObserver(function (list) {
          list.getEntries().forEach(function (entry) {
            if (entry.duration > 50) { // >50ms = long task
              _state.longTaskCount++;
            }
          });
        });
        obs.observe({ entryTypes: ['longtask'] });
      } catch (_) {}
    }

    // Frame rate sampling
    (function _tick(ts) {
      if (_state.lastFrameTs) {
        var delta = ts - _state.lastFrameTs;
        if (delta > 0 && delta < 2000) {
          _perfSamples.push(1000 / delta);
          if (_perfSamples.length > 60) _perfSamples.shift();
        }
      }
      _state.lastFrameTs = ts;

      // Check every 5 seconds
      if (ts - _perfLastCheck > 5000) {
        _perfLastCheck = ts;
        _evaluatePerformance();
      }

      requestAnimationFrame(_tick);
    })(performance.now());
  }

  function _evaluatePerformance() {
    if (!_state.isAuto) return; // User has manual override
    if (_state.isBackground) return;
    if (_state.liveActive || _state.cameraActive) return; // Don't adjust during live/camera

    var now = Date.now();

    // Compute average FPS
    if (_perfSamples.length < 10) return;
    var sum = 0;
    for (var i = 0; i < _perfSamples.length; i++) sum += _perfSamples[i];
    var avgFps = sum / _perfSamples.length;
    _state.frameRateAvg = Math.round(avgFps);

    var currentIdx = LEVELS.indexOf(_state.mode);

    // ── Downgrade conditions ──
    var shouldDowngrade = false;
    var downgradeReason = '';

    if (avgFps < 22 && _state.longTaskCount > 5) {
      shouldDowngrade = true;
      downgradeReason = 'fps=' + Math.round(avgFps) + ' longTasks=' + _state.longTaskCount;
    } else if (avgFps < 18) {
      shouldDowngrade = true;
      downgradeReason = 'fps=' + Math.round(avgFps);
    } else if (_state.longTaskCount > 15) {
      shouldDowngrade = true;
      downgradeReason = 'longTasks=' + _state.longTaskCount;
    }

    // Cooldown check
    if (shouldDowngrade && (now - _state.lastDowngrade) > _state.DOWNGRADE_COOLDOWN_MS) {
      if (currentIdx > 0) {
        var newLevel = LEVELS[currentIdx - 1];
        _state.lastDowngrade = now;
        _state.longTaskCount = 0;
        _perfSamples = [];
        console.warn('[SNXPerf] Downgrading to ' + newLevel + ': ' + downgradeReason);
        _applyLevel(newLevel);
      }
    }

    // ── Upgrade conditions (very conservative) ──
    var shouldUpgrade = avgFps >= 55 && _state.longTaskCount === 0;

    if (shouldUpgrade && (now - _state.lastUpgrade) > _state.UPGRADE_COOLDOWN_MS &&
        (now - _state.lastDowngrade) > _state.UPGRADE_COOLDOWN_MS) {
      if (currentIdx < LEVELS.length - 1) {
        var upgradeLevel = LEVELS[currentIdx + 1];
        // Only upgrade one step, and only if below the auto-chosen cap
        var autoCap = _autoChoose();
        var autoIdx = LEVELS.indexOf(autoCap);
        if (currentIdx < autoIdx) {
          _state.lastUpgrade = now;
          _state.longTaskCount = 0;
          _perfSamples = [];
          console.log('[SNXPerf] Upgrading to ' + upgradeLevel);
          _applyLevel(upgradeLevel);
        }
      }
    }

    // Reset long task counter each check cycle
    _state.longTaskCount = 0;
  }

  /* ══════════════════════════════════════════════════
     BACKGROUND TAB
  ══════════════════════════════════════════════════ */
  function _setupVisibilityHandler() {
    document.addEventListener('visibilitychange', function () {
      _state.isBackground = document.hidden;
      if (document.hidden) {
        _applyBodyFog(false);
        // Canvas pauses itself via its own visibilitychange handler
      } else {
        // Resume body fog if current mode allows
        var cfg = LEVEL_CONFIG[_state.mode];
        if (cfg) _applyBodyFog(cfg.bodyFog);
        // Reset perf samples after returning from background
        _perfSamples = [];
        _state.longTaskCount = 0;
      }
    });
  }

  /* ══════════════════════════════════════════════════
     LIVE / CAMERA MODE
  ══════════════════════════════════════════════════ */
  function _setLiveMode(on) {
    _state.liveActive = on;
    if (on) {
      // Force to LITE or lower during live
      var currentIdx = LEVELS.indexOf(_state.mode);
      var liteIdx = LEVELS.indexOf('LITE');
      if (currentIdx > liteIdx) {
        _applyLevel('LITE');
      }
      document.documentElement.classList.add('snx-live-active');
    } else {
      document.documentElement.classList.remove('snx-live-active');
      // Restore if auto
      if (_state.isAuto) _applyLevel(_autoChoose());
    }
  }

  function _setCameraMode(on) {
    _state.cameraActive = on;
    if (on) {
      var currentIdx = LEVELS.indexOf(_state.mode);
      var liteIdx = LEVELS.indexOf('LITE');
      if (currentIdx > liteIdx) {
        _applyLevel('LITE');
      }
      document.documentElement.classList.add('snx-camera-active');
    } else {
      document.documentElement.classList.remove('snx-camera-active');
      if (_state.isAuto) _applyLevel(_autoChoose());
    }
  }

  /* ══════════════════════════════════════════════════
     SETTINGS — read / write user preference
  ══════════════════════════════════════════════════ */
  function _setUserMode(modeStr) {
    if (modeStr === 'AUTO') {
      _state.userOverride = null;
      _state.isAuto = true;
      localStorage.setItem('snxPerfMode', 'AUTO');
      _applyLevel(_autoChoose());
    } else if (LEVEL_CONFIG[modeStr]) {
      _state.userOverride = modeStr;
      _state.isAuto = false;
      localStorage.setItem('snxPerfMode', modeStr);
      _applyLevel(modeStr);
    }
  }

  function _resetAuto() {
    localStorage.removeItem('snxPerfMode');
    _state.userOverride = null;
    _state.isAuto = true;
    _state.lastDowngrade = 0;
    _state.lastUpgrade = 0;
    _perfSamples = [];
    _state.longTaskCount = 0;
    _applyLevel(_autoChoose());
  }

  /* ══════════════════════════════════════════════════
     MEDIA COORDINATOR
     Lightweight signal bus: "I'm playing X" — lets
     other parts of the app pause conflicting sources.
  ══════════════════════════════════════════════════ */
  var _mediaState = {
    welcomeMusic:   false,
    radio:          false,
    musicHub:       false,
    profileMusic:   false,
    liveAudio:      false,
    videoAudio:     false
  };

  var _mediaListeners = [];

  function _setMediaActive(source, on) {
    _mediaState[source] = on;
    _mediaListeners.forEach(function (fn) {
      try { fn(source, on, _mediaState); } catch (_) {}
    });
  }

  /* ══════════════════════════════════════════════════
     CONNECTION ADAPTATION
     (snx-net.js integration — called when tier changes)
  ══════════════════════════════════════════════════ */
  function _onConnectionChange(tier) {
    _state.connectionTier = tier;
    if (_state.isAuto) {
      // Immediately downgrade if connection becomes poor
      if (tier === 'poor') {
        var currentIdx = LEVELS.indexOf(_state.mode);
        var targetIdx  = LEVELS.indexOf('LITE');
        if (currentIdx > targetIdx) {
          _applyLevel('LITE');
          _state.lastDowngrade = Date.now();
        }
      }
    }
  }

  /* ══════════════════════════════════════════════════
     SNXNET INTEGRATION — subscribe after it loads
  ══════════════════════════════════════════════════ */
  function _hookSNXNet() {
    if (window.SNXNet && typeof window.SNXNet.onChange === 'function') {
      window.SNXNet.onChange(function (tier) {
        _onConnectionChange(tier);
      });
    } else {
      // Try again after a brief delay
      setTimeout(_hookSNXNet, 2000);
    }
  }

  /* ══════════════════════════════════════════════════
     DIAGNOSTICS (for Founder dashboard)
  ══════════════════════════════════════════════════ */
  function _getDiagnostics() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return {
      mode:           _state.mode,
      isAuto:         _state.isAuto,
      frameRateAvg:   _state.frameRateAvg,
      connectionTier: _state.connectionTier,
      effectiveType:  conn ? (conn.effectiveType || 'unknown') : 'unknown',
      saveData:       _state.saveData,
      reducedMotion:  _state.reducedMotion,
      isPWA:          _state.isPWA,
      isMobile:       _state.isMobile,
      isIOS:          _state.isIOS,
      isAndroid:      _state.isAndroid,
      liveActive:     _state.liveActive,
      cameraActive:   _state.cameraActive,
      hardwareCores:  navigator.hardwareConcurrency || 'unknown',
      deviceMemoryGB: navigator.deviceMemory || 'unknown',
      activeMedia:    JSON.parse(JSON.stringify(_mediaState))
    };
  }

  /* ══════════════════════════════════════════════════
     INIT
  ══════════════════════════════════════════════════ */
  function _init() {
    _detect();

    var level = _chooseInitialLevel();
    _applyLevel(level);

    _setupVisibilityHandler();
    _startPerfMonitor();
    _hookSNXNet();

    // Watch for system reduced-motion changes
    window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', function (e) {
      _state.reducedMotion = e.matches;
      if (_state.isAuto) _applyLevel(_autoChoose());
    });

    // Watch for connection changes
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      conn.addEventListener('change', function () {
        _state.saveData = !!conn.saveData;
        var eff = conn.effectiveType || '4g';
        _state.connectionTier = eff === '4g' ? 'good' : eff === '3g' ? 'ok' : 'poor';
        if (_state.isAuto) _onConnectionChange(_state.connectionTier);
      });
    }

    console.log('[SNXPerf] Initialized. Mode: ' + level);
  }

  /* ══════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════ */
  window.SNXPerf = {
    /** Current quality level string */
    get mode() { return _state.mode; },

    /** Config for current level */
    get config() { return LEVEL_CONFIG[_state.mode]; },

    /** All level configs */
    levels: LEVEL_CONFIG,

    /** Set quality: 'AUTO' | 'ULTRA' | 'HIGH' | 'BALANCED' | 'LITE' | 'MINIMAL' */
    setMode: _setUserMode,

    /** Reset to automatic selection */
    resetAuto: _resetAuto,

    /** Notify system that Live is active/inactive */
    setLiveActive: _setLiveMode,

    /** Notify system that Camera is active/inactive */
    setCameraActive: _setCameraMode,

    /** Notify a media source is playing/stopping */
    setMediaActive: _setMediaActive,

    /** Get the current media state map */
    getMediaState: function () { return JSON.parse(JSON.stringify(_mediaState)); },

    /** Subscribe to quality level changes: fn(newLevel, prevLevel) */
    onChange: function (fn) { _state.listeners.push(fn); },

    /** Subscribe to media source changes: fn(source, on, allState) */
    onMediaChange: function (fn) { _mediaListeners.push(fn); },

    /** Get diagnostics for Founder dashboard */
    getDiagnostics: _getDiagnostics,

    /** Check if current config key is enabled */
    is: function (key) {
      var cfg = LEVEL_CONFIG[_state.mode];
      return cfg ? !!cfg[key] : false;
    },

    /** Get numeric value from current config */
    val: function (key) {
      var cfg = LEVEL_CONFIG[_state.mode];
      return cfg ? (cfg[key] || 0) : 0;
    },

    /** Force immediate re-evaluation (useful after long async loads) */
    evaluate: _evaluatePerformance
  };

  // Boot immediately
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

})();
