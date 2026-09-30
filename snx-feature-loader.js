/**
 * SNX Feature Loader — snx-feature-loader.js
 * Build: SNS-2026-STAGE2B-001
 *
 * Centralised lazy-loading controller for Shadow Nexus Social.
 * Exposes window.SNXFeatureLoader.
 *
 * Design goals
 * ────────────
 *  • Load each JS/CSS resource ONCE — no duplicate network requests.
 *  • Return a Promise for every loadFeature() call so callers can await readiness.
 *  • Prevent duplicate initialisation even when the same feature is opened
 *    several times in one session.
 *  • Isolate failures: one feature failing must not affect Feed or other features.
 *  • Integrate with Stage 2A performance modes (LITE / BALANCED / FULL).
 *  • Respect existing navigation — does NOT change navTo or realmNavTo.
 *  • Show a visual acknowledgement while resources load (slow connections).
 *
 * Absolute non-goals
 * ──────────────────
 *  • Never rewrites Firebase schemas, security rules, or auth architecture.
 *  • Never creates a second Firebase app instance.
 *  • Never touches Radio timeline, epoch, or synchronisation.
 *  • Never alters Live signalling paths or WebRTC architecture.
 *  • Never activates mediasoup.
 *  • Never modifies the TV backend or broadcast engine.
 *
 * FEATURE MANIFEST
 * ────────────────
 * Each entry defines exactly what must be loaded for a feature, in load order.
 * Entries marked globalRequired:true are already on the page and must not be
 * re-injected.
 *
 * Loader state per feature
 * ────────────────────────
 *   idle       → loading → loaded
 *                        → error   (retryable)
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────────────────
     FEATURE MANIFEST
     Scripts / CSS are loaded in array order.
     globalRequired:true  → already loaded by index.html; never re-inject.
     cssOnly:true         → CSS file, inject as <link>, no eval cost.
  ───────────────────────────────────────────────────────────────────────── */
  var FEATURES = {

    // ── Radio Core (listener player — lightweight, needed for Radio page)
    // snx-audio-coordinator.js already loaded globally; snx-radio.js handles
    // its own Firebase using window globals from firebase-config.js.
    // Stage 2C: snx-radio-track-store.js loads first — provides the shared
    // /radioTracks listener that snx-radio.js and snx-radio-requests.js consume.
    radio: {
      label: 'RADIO',
      css:  ['snx-radio.css?v=SNS-2026-RADIO-PAGE-001'],
      scripts: [
        'snx-radio-track-store.js?v=SNS-2026-STAGE2C-001',
        'snx-radio.js?v=SNS-2026-RADIO-PAGE-001',
        'snx-radio-player.js?v=SNS-2026-RADIO-PAGE-001',
        'snx-radio-comments.js?v=SNS-2026-RADIO-COMMENTS-001',
        'snx-radio-requests.js?v=SNS-2026-RADIO-REQUESTS-001',
        'snx-radio-presence.js?v=SNS-2026-RADIO-PRESENCE-001'
      ],
      // Called after all scripts load; wires up the radio page UI.
      // The actual init is handled by window.snxRadioPageOpen() which already
      // exists and is already called by navTo().  Nothing extra needed here.
      init: null
    },

    // ── Radio Studio (Founder only — add AFTER radio core is loaded)
    // snx-broadcast-engine.js MUST load before snx-radio-studio.js because
    // the Studio BROADCAST tab checks window.SNXBroadcastEngine synchronously
    // inside _loadBroadcastDestinations(), _onBroadcastSave(), _onBroadcastStart(),
    // and _onBroadcastStop().  Loading it here, in script order, guarantees the
    // global is available the moment the Studio is mounted.
    'radio-studio': {
      label: 'RADIO STUDIO',
      css:  [],
      // snx-radio.css already loaded by the 'radio' feature
      scripts: [
        'snx-broadcast-engine.js?v=SNS-2026-BROADCAST-001',
        'snx-radio-studio.js?v=SNS-2026-RADIO-PAGE-001'
      ],
      dependsOn: ['radio'],
      init: null
    },

    // ── DJ Mode (Founder/DJ — add AFTER radio core is loaded)
    dj: {
      label: 'DJ MODE',
      css:  [],
      scripts: [
        'snx-radio-dj.js?v=SNS-2026-RADIO-DJ-001'
      ],
      dependsOn: ['radio'],
      init: null
    },

    // ── Live / cohost stack
    // snx-sfu.js must load before live.js; order is preserved by sequential loading.
    live: {
      label: 'LIVE',
      css:  ['live.css?v=SNS-2026-LIVE-003'],
      scripts: [
        'snx-sfu.js',
        'live.js?v=SNS-2026-LIVE-010'
      ],
      init: null
    },

    // ── 24-Hour TV viewer (adapter + network UI)
    // snx-ch-adapter.js is a type="module" so we preserve that via a
    // dynamic import() rather than a classic script tag.
    tv: {
      label: 'TV',
      css:  ['snx-tv-network.css?v=SHADOW-TV-2026-GLOBAL-UPDATE-01'],
      scripts: [],          // loaded via esModules below
      esModules: [
        'snx-ch-adapter.js',
        // snx-tv-network.js is lazily imported inside the inline module already;
        // we do NOT duplicate that import here.
      ],
      init: null
    },

    // ── Arcade (fully inline in index.html — no external scripts to load)
    // The Arcade JS and CSS are already inlined in index.html (CSS ~13KB inline
    // in <style>, JS IIFE inline in <script>).  Nothing to lazy-load here except
    // the modal itself already exists in the DOM.
    // We keep an entry so the loader state machine can track "loaded" correctly.
    arcade: {
      label: 'ARCADE',
      css:  [],
      scripts: [],
      esModules: [],
      init: null,
      _alreadyInPage: true   // all code already parsed at startup (inline)
    }
  };

  /* ─────────────────────────────────────────────────────────────────────────
     STATE MACHINE
  ───────────────────────────────────────────────────────────────────────── */
  var _state = {};       // featureId → 'idle' | 'loading' | 'loaded' | 'error'
  var _promise = {};     // featureId → Promise (in-flight or resolved)
  var _loadedUrls = {};  // url → true (cross-feature dedup)

  function _getState(id) { return _state[id] || 'idle'; }

  /* ─────────────────────────────────────────────────────────────────────────
     SLOW-CONNECTION UX
     Shows a small status bar while the feature loads, then removes it.
  ───────────────────────────────────────────────────────────────────────── */
  function _showLoading(label) {
    var existing = document.getElementById('snxFeatureLoadingBar');
    if (existing) { existing.textContent = 'LOADING ' + label + '…'; return; }
    var bar = document.createElement('div');
    bar.id = 'snxFeatureLoadingBar';
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:99999;' +
      'background:rgba(0,10,30,0.96);border-bottom:1px solid rgba(0,174,239,0.45);' +
      'color:#00AEEF;font-size:11px;font-weight:700;letter-spacing:1.5px;' +
      'text-transform:uppercase;padding:6px 16px;text-align:center;' +
      'pointer-events:none;animation:snxFLBIn 0.18s ease-out both;';
    bar.textContent = 'LOADING ' + label + '…';
    document.head.insertAdjacentHTML('beforeend',
      '<style id="_snxFLBStyle">@keyframes snxFLBIn{from{opacity:0;transform:translateY(-100%)}to{opacity:1;transform:translateY(0)}}</style>');
    document.body.appendChild(bar);
  }

  function _hideLoading() {
    var bar = document.getElementById('snxFeatureLoadingBar');
    if (bar) bar.remove();
    var st = document.getElementById('_snxFLBStyle');
    if (st) st.remove();
  }

  function _showError(label, msg) {
    _hideLoading();
    if (typeof global.toastNotification === 'function') {
      global.toastNotification('⚠ ' + label + ' failed to load. Tap to retry.');
    }
    console.warn('[SNXFeatureLoader] ' + label + ' load error:', msg);
  }

  /* ─────────────────────────────────────────────────────────────────────────
     RESOURCE INJECTION
  ───────────────────────────────────────────────────────────────────────── */

  /** Inject a <link rel="stylesheet"> once; returns a Promise. */
  function _loadCSS(href) {
    var key = href.split('?')[0];   // dedup by filename (ignore version param)
    if (_loadedUrls[key]) return Promise.resolve();
    _loadedUrls[key] = true;
    // Also check if already in DOM (e.g. loaded by inline HTML)
    if (document.querySelector('link[href*="' + key + '"]')) return Promise.resolve();
    return new Promise(function (resolve) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      link.onload = resolve;
      link.onerror = resolve;   // CSS fail is non-fatal; resolve anyway
      document.head.appendChild(link);
    });
  }

  /** Inject a classic <script src="…"> once; returns a Promise. */
  function _loadScript(src) {
    var key = src.split('?')[0];
    if (_loadedUrls[key]) return Promise.resolve();
    _loadedUrls[key] = true;
    if (document.querySelector('script[src*="' + key + '"]')) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = false;   // preserve load order within the feature group
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Script load failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  /** Dynamically import() an ES module once; returns a Promise. */
  function _loadESModule(src) {
    var key = src.split('?')[0];
    if (_loadedUrls[key]) return Promise.resolve();
    _loadedUrls[key] = true;
    // Check if a type=module script for this src is already in the page
    if (document.querySelector('script[type="module"][src*="' + key + '"]')) {
      return Promise.resolve();
    }
    return import('./' + src).then(function () {}).catch(function (err) {
      console.warn('[SNXFeatureLoader] ES module import failed:', src, err.message);
      // Non-fatal: resolve so the chain continues
    });
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PERFORMANCE MODE INTEGRATION
     LITE     → no speculative preload; load only on demand
     BALANCED → load on demand; optional tiny prefetch after Feed stable
     FULL     → load on demand; optional idle prefetch after Feed usable
  ───────────────────────────────────────────────────────────────────────── */
  function _getPerfMode() {
    // Prefer Stage 2A controller
    if (global.SNXPerformance && typeof global.SNXPerformance.getMode === 'function') {
      return global.SNXPerformance.getMode();
    }
    // Fall back to bootstrap bootstrap decision
    if (global._SNXBootstrap) return global._SNXBootstrap.mode;
    // Fall back to localStorage
    try { return localStorage.getItem('snxAdaptiveMode') || 'BALANCED'; } catch(_) {}
    return 'BALANCED';
  }

  /* ─────────────────────────────────────────────────────────────────────────
     CORE: loadFeature(featureId)
     Returns a Promise that resolves when the feature is ready.
     Safe to call multiple times — only downloads once.
  ───────────────────────────────────────────────────────────────────────── */
  function loadFeature(featureId) {
    var def = FEATURES[featureId];
    if (!def) {
      return Promise.reject(new Error('[SNXFeatureLoader] Unknown feature: ' + featureId));
    }

    // Already loaded or loading — return existing promise
    var st = _getState(featureId);
    if (st === 'loaded')  return Promise.resolve();
    if (st === 'loading') return _promise[featureId];

    // Features that are entirely inline (Arcade) — mark loaded immediately
    if (def._alreadyInPage) {
      _state[featureId] = 'loaded';
      return Promise.resolve();
    }

    _state[featureId] = 'loading';
    _showLoading(def.label);

    var work = Promise.resolve();

    // 1. Resolve dependencies first
    if (def.dependsOn && def.dependsOn.length) {
      def.dependsOn.forEach(function (dep) {
        work = work.then(function () { return loadFeature(dep); });
      });
    }

    // 2. Load CSS (in parallel — non-blocking)
    var cssUrls = def.css || [];
    var cssWork = Promise.all(cssUrls.map(function (href) {
      return _loadCSS(href).catch(function (e) {
        console.warn('[SNXFeatureLoader] CSS failed:', href, e && e.message);
      });
    }));
    work = work.then(function () { return cssWork; });

    // 3. Load classic scripts sequentially (order matters for globals)
    var scripts = def.scripts || [];
    scripts.forEach(function (src) {
      work = work.then(function () { return _loadScript(src); });
    });

    // 4. Load ES modules
    var esModules = def.esModules || [];
    esModules.forEach(function (src) {
      work = work.then(function () { return _loadESModule(src); });
    });

    // 5. Run feature init callback if provided
    if (typeof def.init === 'function') {
      work = work.then(function () {
        try { def.init(); } catch (e) {
          console.warn('[SNXFeatureLoader] init() for ' + featureId + ' threw:', e.message);
        }
      });
    }

    // 6. Settle state
    _promise[featureId] = work
      .then(function () {
        _state[featureId] = 'loaded';
        _hideLoading();
        console.log('[SNXFeatureLoader] ' + def.label + ' ready.');
      })
      .catch(function (err) {
        _state[featureId] = 'error';
        _promise[featureId] = null;   // allow retry next call
        _showError(def.label, err && err.message);
        throw err;
      });

    return _promise[featureId];
  }

  /* ─────────────────────────────────────────────────────────────────────────
     SPECULATIVE PREFETCH
     Called once Feed is stable. Only runs in BALANCED/FULL mode.
     Prefetches only CSS for common features — tiny bandwidth, zero parse cost.
  ───────────────────────────────────────────────────────────────────────── */
  function prefetchAfterFeed() {
    var mode = _getPerfMode();
    if (mode === 'LITE') return;

    // Use requestIdleCallback if available; otherwise defer 4 s
    var schedule = global.requestIdleCallback
      ? function (fn) { global.requestIdleCallback(fn, { timeout: 6000 }); }
      : function (fn) { setTimeout(fn, 4000); };

    if (mode === 'BALANCED') {
      // Only hint the CSS for radio (most common feature) — 56 KB, no JS parse
      schedule(function () {
        if (_getState('radio') === 'idle') {
          _loadCSS('snx-radio.css?v=SNS-2026-RADIO-PAGE-001').catch(function () {});
        }
      });
    } else {
      // FULL — hint CSS for radio + live after a short delay
      schedule(function () {
        if (_getState('radio') === 'idle') {
          _loadCSS('snx-radio.css?v=SNS-2026-RADIO-PAGE-001').catch(function () {});
        }
        if (_getState('live') === 'idle') {
          _loadCSS('live.css?v=SNS-2026-LIVE-003').catch(function () {});
        }
      });
    }
  }

  /* ─────────────────────────────────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────────────────────────────────── */
  global.SNXFeatureLoader = {
    /** Load a feature by id. Returns Promise. Safe to call many times. */
    loadFeature: loadFeature,

    /** Returns current state string for a feature: idle|loading|loaded|error */
    getState: _getState,

    /** Returns true when a feature is fully ready */
    isLoaded: function (id) { return _getState(id) === 'loaded'; },

    /**
     * Mark a resource URL as already loaded (called from index.html migration
     * shim to prevent re-injection of scripts that were originally inline).
     */
    markLoaded: function (featureId) {
      _state[featureId] = 'loaded';
    },

    /** Hint: Feed is now stable — run safe speculative prefetch. */
    feedReady: prefetchAfterFeed,

    /** Read current perf mode */
    getPerfMode: _getPerfMode
  };

})(window);
