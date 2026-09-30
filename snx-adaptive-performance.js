/**
 * snx-adaptive-performance.js
 * Shadow Nexus Social — Authoritative Adaptive Performance Controller
 * Build: SNS-2026-STAGE2A-001
 *
 * Exposes: window.SNXPerformance
 *
 * Modes (user-facing):
 *   AUTO      — detect from device/network signals, default
 *   LITE      — minimal rendering, slow connections / weak devices
 *   BALANCED  — reduced effects, mid-range devices / 3G
 *   FULL      — cinematic quality, fast devices / fast connections
 *
 * Integration:
 *   Reads SNXPerf (snx-perf.js) for the existing 6-level system and
 *   SNX_NET (snx-net.js) for network tier data.
 *   Maps SNXPerformance 4-mode → SNXPerf level internally.
 *   Does NOT replace or duplicate SNXPerf. Thin translation layer only.
 *
 * Guarantees:
 *   - No Firebase reads / writes
 *   - No Radio/Live/TV timeline disruption
 *   - No page reload on mode change
 *   - Detection failure falls back to BALANCED
 *   - No mode bouncing: upgrade hysteresis enforced
 *   - User preference stored in localStorage only
 *   - Page hidden → decorative animation work paused
 */

'use strict';

(function () {

  /* ────────────────────────────────────────────────────────────
     CONSTANTS
  ──────────────────────────────────────────────────────────── */

  var MODES = ['LITE', 'BALANCED', 'FULL'];

  /** Map SNXPerformance mode → SNXPerf level */
  var MODE_TO_PERF = {
    LITE:     'LITE',
    BALANCED: 'BALANCED',
    FULL:     'HIGH'         // FULL uses HIGH; ULTRA reserved for future
  };

  var STORAGE_KEY = 'snxAdaptiveMode';   // localStorage key for user override

  /* Upgrade hysteresis: must hold stable for this long before upgrading */
  var UPGRADE_HOLD_MS = 45000;           // 45 s
  var DOWNGRADE_HOLD_MS = 12000;         // 12 s

  /* ────────────────────────────────────────────────────────────
     STATE
  ──────────────────────────────────────────────────────────── */

  var _state = {
    mode:         'BALANCED',   // current effective mode
    userOverride: null,         // null = AUTO, else 'LITE'|'BALANCED'|'FULL'
    isAuto:       true,
    lastDowngrade: 0,
    lastUpgrade:   0,
    listeners:    []
  };

  /* ────────────────────────────────────────────────────────────
     DETECTION — run once, safe on all browsers incl. iOS Safari
  ──────────────────────────────────────────────────────────── */

  function _detect() {
    var score = 0; // higher = stronger device/network

    // ── Network ──
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      if (conn.saveData) {
        // Save-Data header: immediate LITE
        return 'LITE';
      }
      var eff = conn.effectiveType || '4g';
      if (eff === 'slow-2g' || eff === '2g') { score -= 3; }
      else if (eff === '3g')                  { score -= 1; }
      else if (eff === '4g')                  { score += 1; }
    } else if (window.SNX_NET && window.SNX_NET.tier) {
      var t = window.SNX_NET.tier.id || '';
      if (t === 'offline' || t === 'poor') { score -= 3; }
      else if (t === 'fair')               { score -= 1; }
      else if (t === 'good' || t === 'excellent') { score += 1; }
    }

    // ── Hardware ──
    var cores = navigator.hardwareConcurrency;
    if (cores) {
      if (cores >= 8)      score += 2;
      else if (cores >= 4) score += 1;
      else if (cores <= 2) score -= 1;
    }

    var mem = navigator.deviceMemory;
    if (mem) {
      if (mem >= 8)       score += 2;
      else if (mem >= 4)  score += 1;
      else if (mem <= 1)  score -= 2;
      else if (mem <= 2)  score -= 1;
    }

    // ── System preferences ──
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      // Reduced motion = never go above BALANCED
      return score <= 0 ? 'LITE' : 'BALANCED';
    }

    // ── Screen ──
    var pixels = (window.innerWidth || 0) * (window.innerHeight || 0);
    if (pixels < 200000) score -= 1;   // very small screen = likely low-power

    // ── iOS penalty (conservative due to memory limits) ──
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) score -= 1;

    // ── SNXPerf may have already done a detailed detect ──
    if (window.SNXPerf) {
      var d = typeof SNXPerf.getDiagnostics === 'function' ? SNXPerf.getDiagnostics() : null;
      if (d) {
        var perfMode = d.mode || 'BALANCED';
        // Translate existing SNXPerf level to our 3-tier
        if (perfMode === 'MINIMAL' || perfMode === 'LITE') score -= 1;
        else if (perfMode === 'HIGH' || perfMode === 'ULTRA') score += 1;
      }
    }

    // ── Score → mode (conservative bias) ──
    if (score >= 3)  return 'FULL';
    if (score >= 0)  return 'BALANCED';
    return 'LITE';
  }

  /* ────────────────────────────────────────────────────────────
     INITIAL MODE CHOICE
  ──────────────────────────────────────────────────────────── */

  function _chooseInitialMode() {
    // 1. User explicit override
    var stored = _safeLocalGet(STORAGE_KEY);
    if (stored === 'LITE' || stored === 'BALANCED' || stored === 'FULL') {
      _state.userOverride = stored;
      _state.isAuto = false;
      return stored;
    }
    if (stored === 'AUTO') {
      _state.isAuto = true;
    }

    // 2. Auto detect (safe fallback to BALANCED on any error)
    try {
      return _detect();
    } catch (_) {
      return 'BALANCED';
    }
  }

  /* ────────────────────────────────────────────────────────────
     APPLY MODE — update SNXPerf + CSS classes + background
  ──────────────────────────────────────────────────────────── */

  function _applyMode(newMode, fromAuto) {
    if (MODES.indexOf(newMode) === -1) newMode = 'BALANCED';

    var prev = _state.mode;
    _state.mode = newMode;

    // 1. Forward to SNXPerf (existing system) if available
    var snxPerfLevel = MODE_TO_PERF[newMode] || 'BALANCED';
    if (window.SNXPerf && typeof SNXPerf.setMode === 'function') {
      // Only push if it wouldn't re-trigger our listener (SNXPerf uses its own localStorage key)
      var current = window.SNXPerf.mode;
      if (current !== snxPerfLevel) {
        SNXPerf.setMode(snxPerfLevel);
      }
    }

    // 2. Apply CSS quality class on <html>
    _applyQualityClass(newMode);

    // 3. Apply background for this mode
    _applyBackground(newMode);

    // 4. Notify listeners
    _state.listeners.forEach(function (fn) {
      try { fn(newMode, prev); } catch (_) {}
    });

    console.log('[SNXAdaptive] Mode → ' + newMode + (fromAuto ? ' (AUTO)' : ' (MANUAL)') +
      (prev !== newMode ? ' was ' + prev : ''));
  }

  function _applyQualityClass(mode) {
    // Map our 3-tier to the snx-quality-* classes used throughout CSS
    var classMap = {
      LITE:     'snx-quality-lite',
      BALANCED: 'snx-quality-balanced',
      FULL:     'snx-quality-high'
    };
    var target = classMap[mode] || 'snx-quality-balanced';

    var html = document.documentElement;
    // Remove all quality classes
    html.className = html.className
      .replace(/\bsnx-quality-\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    html.classList.add(target);
    // Also mark the 4-mode for CSS targeting
    html.setAttribute('data-snx-mode', mode.toLowerCase());
  }

  /* ────────────────────────────────────────────────────────────
     BACKGROUND SELECTION — deferred, non-blocking
  ──────────────────────────────────────────────────────────── */

  var _bgImages = {
    FULL:     'assets/images/shadow-nexus-global-bg.png',
    BALANCED: 'assets/images/shadow-nexus-global-bg-balanced.webp',
    LITE:     'assets/images/shadow-nexus-global-bg-lite.webp'
  };

  var _bgApplied = null;  // track what's currently loaded

  function _applyBackground(mode) {
    var src = _bgImages[mode] || _bgImages['BALANCED'];

    // Stage 2A.1: If the cold-start bootstrap already applied this exact src,
    // adopt it immediately without re-fetching — the image is already in cache.
    if (window._SNXBootstrap && window._SNXBootstrap.src === src) {
      _bgApplied = src;
      // Still call _setBgSrc so #snx-global-world-bg div gets the correct image
      // (html was already set by bootstrap; the div needs it too).
      _setBgSrc(src);
      return;
    }

    if (_bgApplied === src) return;

    // Preload into browser cache, then swap — avoids flash on swap
    var img = new Image();
    img.onload = function () {
      _bgApplied = src;
      _setBgSrc(src);
    };
    img.onerror = function () {
      // Fallback to balanced silently (not the full 2.90 MB PNG)
      var fallback = _bgImages['BALANCED'];
      if (src !== fallback) {
        _bgApplied = fallback;
        _setBgSrc(fallback);
      }
    };
    img.src = src;
  }

  var _cssGrad = 'linear-gradient(to bottom, rgba(2,4,14,0.30) 0%, rgba(2,4,14,0.25) 30%, rgba(2,4,14,0.28) 60%, rgba(2,4,14,0.35) 100%)';

  function _setBgSrc(src) {
    var bgVal = _cssGrad + ', url("' + src + '")';

    // Primary: #snx-global-world-bg div
    var div = document.getElementById('snx-global-world-bg');
    if (div) {
      div.style.backgroundImage = bgVal;
    }

    // Secondary: html::before cannot be set via JS; we use a dynamic <style>
    var styleId = '_snxAdaptiveBgStyle';
    var el = document.getElementById(styleId);
    if (!el) {
      el = document.createElement('style');
      el.id = styleId;
      document.head.appendChild(el);
    }
    // Escape the URL for CSS
    var escaped = src.replace(/"/g, '\\"');
    el.textContent =
      'html::before { background-image: ' + _cssGrad + ', url("' + escaped + '") !important; }';
  }

  /* ────────────────────────────────────────────────────────────
     PAGE VISIBILITY — pause decorative work when hidden
  ──────────────────────────────────────────────────────────── */

  function _setupVisibility() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        document.documentElement.classList.add('snx-page-hidden');
      } else {
        document.documentElement.classList.remove('snx-page-hidden');
      }
    });
  }

  /* ────────────────────────────────────────────────────────────
     RUNTIME DOWNGRADE — watch for persistent low FPS
     Only active in AUTO mode. Minimal, conservative.
  ──────────────────────────────────────────────────────────── */

  function _setupRuntimeMonitor() {
    if (typeof requestAnimationFrame === 'undefined') return;

    var samples = [];
    var lastTs = 0;
    var checkInterval = 10000; // check every 10s
    var lastCheck = 0;

    (function tick(ts) {
      if (lastTs && !document.hidden) {
        var delta = ts - lastTs;
        if (delta > 0 && delta < 2000) {
          samples.push(1000 / delta);
          if (samples.length > 90) samples.shift();
        }
      }
      lastTs = ts;

      if (ts - lastCheck > checkInterval) {
        lastCheck = ts;
        _runtimeEval(samples);
      }

      requestAnimationFrame(tick);
    })(performance.now());
  }

  function _runtimeEval(samples) {
    if (!_state.isAuto) return;
    if (samples.length < 20) return;

    var sum = 0;
    for (var i = 0; i < samples.length; i++) sum += samples[i];
    var avg = sum / samples.length;

    var now = Date.now();
    var modeIdx = MODES.indexOf(_state.mode);

    // Downgrade if FPS is clearly terrible
    if (avg < 20 && (now - _state.lastDowngrade) > DOWNGRADE_HOLD_MS) {
      if (modeIdx > 0) {
        _state.lastDowngrade = now;
        samples.length = 0;
        _applyMode(MODES[modeIdx - 1], true);
      }
    }
  }

  /* ────────────────────────────────────────────────────────────
     USER OVERRIDE API
  ──────────────────────────────────────────────────────────── */

  function _setUserMode(modeStr) {
    if (modeStr === 'AUTO') {
      _state.userOverride = null;
      _state.isAuto = true;
      _safeLocalSet(STORAGE_KEY, 'AUTO');
      var detected;
      try { detected = _detect(); } catch (_) { detected = 'BALANCED'; }
      _applyMode(detected, true);
    } else if (MODES.indexOf(modeStr) !== -1) {
      _state.userOverride = modeStr;
      _state.isAuto = false;
      _safeLocalSet(STORAGE_KEY, modeStr);
      _applyMode(modeStr, false);
    }
  }

  /* ────────────────────────────────────────────────────────────
     SAFE localStorage HELPERS (iOS private mode safe)
  ──────────────────────────────────────────────────────────── */

  function _safeLocalGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }

  function _safeLocalSet(key, val) {
    try { localStorage.setItem(key, val); } catch (_) {}
  }

  /* ────────────────────────────────────────────────────────────
     SNX_NET INTEGRATION
  ──────────────────────────────────────────────────────────── */

  function _hookSNXNet() {
    if (window.SNX_NET && typeof SNX_NET.onChange === 'function') {
      SNX_NET.onChange(function (tier) {
        if (!_state.isAuto) return;
        var tierId = (tier && tier.id) ? tier.id : tier;
        var now = Date.now();
        if ((tierId === 'poor' || tierId === 'offline') &&
            (now - _state.lastDowngrade) > DOWNGRADE_HOLD_MS) {
          if (_state.mode !== 'LITE') {
            _state.lastDowngrade = now;
            _applyMode('LITE', true);
          }
        }
      });
    } else {
      setTimeout(_hookSNXNet, 2500);
    }
  }

  /* ────────────────────────────────────────────────────────────
     DIAGNOSTICS
  ──────────────────────────────────────────────────────────── */

  function _getDiagnostics() {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return {
      snxAdaptiveMode: _state.mode,
      isAuto:          _state.isAuto,
      userOverride:    _state.userOverride,
      effectiveType:   conn ? (conn.effectiveType || 'unknown') : 'unknown',
      saveData:        conn ? !!conn.saveData : false,
      bgFile:          _bgImages[_state.mode] || 'unknown',
      reducedMotion:   window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      hardwareCores:   navigator.hardwareConcurrency || 'unknown',
      deviceMemory:    navigator.deviceMemory || 'unknown',
      pageHidden:      document.hidden
    };
  }

  /* ────────────────────────────────────────────────────────────
     INIT
  ──────────────────────────────────────────────────────────── */

  function _init() {
    // Stage 2A.1: If the cold-start bootstrap already committed a mode, honour it.
    // The bootstrap and _chooseInitialMode() use the same localStorage key and the
    // same detection logic, so they should agree. We trust bootstrap's decision and
    // skip a redundant background swap when the modes match.
    if (window._SNXBootstrap && window._SNXBootstrap.mode) {
      var bootstrapMode = window._SNXBootstrap.mode;
      // Seed _bgApplied so _applyBackground skips re-fetching the same file
      _bgApplied = window._SNXBootstrap.src;
      _state.mode = bootstrapMode;
      _state.userOverride = (bootstrapMode !== 'BALANCED' || window._SNXBootstrap.src !== _bgImages['BALANCED'])
        ? null : null; // isAuto determined below
      // Reload stored pref for isAuto flag
      var stored2 = _safeLocalGet(STORAGE_KEY);
      if (stored2 === 'LITE' || stored2 === 'BALANCED' || stored2 === 'FULL') {
        _state.userOverride = stored2;
        _state.isAuto = false;
      }
      // Apply CSS quality class and forward to SNXPerf — but skip background (already done)
      _applyQualityClass(bootstrapMode);
      var snxPerfLevel = MODE_TO_PERF[bootstrapMode] || 'BALANCED';
      if (window.SNXPerf && typeof SNXPerf.setMode === 'function') {
        if (window.SNXPerf.mode !== snxPerfLevel) SNXPerf.setMode(snxPerfLevel);
      }
      // Apply the div background (html was already set by bootstrap style)
      _setBgSrc(window._SNXBootstrap.src);
      _state.listeners.forEach(function (fn) {
        try { fn(bootstrapMode, bootstrapMode); } catch (_) {}
      });
      console.log('[SNXAdaptive] Stage 2A.1 — adopted bootstrap mode: ' + bootstrapMode);
      _setupVisibility();
      _setupRuntimeMonitor();
      _hookSNXNet();
      // Watch network API changes
      var conn2 = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn2) {
        conn2.addEventListener('change', function () {
          if (_state.isAuto) {
            var detected2;
            try { detected2 = _detect(); } catch (_) { detected2 = _state.mode; }
            var now2 = Date.now();
            var curIdx2 = MODES.indexOf(_state.mode);
            var newIdx2 = MODES.indexOf(detected2);
            if (newIdx2 < curIdx2 && (now2 - _state.lastDowngrade) > DOWNGRADE_HOLD_MS) {
              _state.lastDowngrade = now2;
              _applyMode(detected2, true);
            } else if (newIdx2 > curIdx2 && (now2 - _state.lastUpgrade) > UPGRADE_HOLD_MS) {
              _state.lastUpgrade = now2;
              _applyMode(detected2, true);
            }
          }
        });
      }
      return;
    }

    var mode = _chooseInitialMode();
    _applyMode(mode, _state.isAuto);
    _setupVisibility();
    _setupRuntimeMonitor();
    _hookSNXNet();

    // Watch for network API changes
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) {
      conn.addEventListener('change', function () {
        if (_state.isAuto) {
          var detected;
          try { detected = _detect(); } catch (_) { detected = _state.mode; }
          var now = Date.now();
          // Only downgrade immediately; upgrades are deferred
          var curIdx = MODES.indexOf(_state.mode);
          var newIdx = MODES.indexOf(detected);
          if (newIdx < curIdx && (now - _state.lastDowngrade) > DOWNGRADE_HOLD_MS) {
            _state.lastDowngrade = now;
            _applyMode(detected, true);
          } else if (newIdx > curIdx && (now - _state.lastUpgrade) > UPGRADE_HOLD_MS) {
            _state.lastUpgrade = now;
            _applyMode(detected, true);
          }
        }
      });
    }

    console.log('[SNXAdaptive] Stage 2A initialized. Mode: ' + mode);
  }

  /* ────────────────────────────────────────────────────────────
     PUBLIC API  —  window.SNXPerformance
  ──────────────────────────────────────────────────────────── */

  window.SNXPerformance = {
    /** Current effective mode: 'LITE' | 'BALANCED' | 'FULL' */
    get mode() { return _state.mode; },

    /** true when running in AUTO */
    get isAuto() { return _state.isAuto; },

    /** Set mode: 'AUTO' | 'LITE' | 'BALANCED' | 'FULL' */
    setMode: _setUserMode,

    /** Subscribe to mode changes: fn(newMode, prevMode) */
    onChange: function (fn) { _state.listeners.push(fn); },

    /** Diagnostic snapshot */
    getDiagnostics: _getDiagnostics,

    /** Background image map (for telemetry) */
    backgrounds: _bgImages
  };

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

})();
