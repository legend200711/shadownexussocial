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
    // snx-sfu.js is a classic (non-module) script — must load first.
    // live.js is an ES module (top-level import) — must be loaded via
    // dynamic import(), NOT as a classic <script> tag.  Loading it with
    // _loadScript() causes a SyntaxError at parse time and prevents
    // window.snxLivePageOpen / window.snxLiveOpenGoLive from ever being
    // defined, which is the root cause of the stuck "Loading live streams…"
    // and the dead GO LIVE button on physical devices.
    live: {
      label: 'LIVE',
      css:  ['live.css?v=SNS-2026-LIVE-003'],
      scripts: [
        'snx-sfu.js'
      ],
      esModules: [
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
    },

    // ── Shadow Reaper AI — Stage 2: real AI connection
    // NOT loaded at startup. NOT preloaded on 2G/save-data/LITE.
    // Loaded on demand when user clicks the existing "Click Here" entry point.
    // Optional idle prefetch of CSS only in FULL mode + good/excellent connection
    // is handled in prefetchAfterFeed() below.
    'shadow-ai-e1': {
      /* E1: loaded as part of shadow-ai feature */
      css:     [],
      scripts: ['snx-shadow-ai-e1.js?v=SNS-2026-SHADOW-EMOTION-E1-RC1'],
      init:    null
    },
    'shadow-ai': {
      label: 'SHADOW REAPER AI',
      css:  [
        'snx-shadow-ai.css?v=SNS-2026-SHADOW-AI-STAGE2-001',
        'snx-shadow-voice.css?v=SNS-2026-SHADOW-VOICE-4A-001',
        'snx-shadow-character.css?v=SNS-2026-SHADOW-CHARACTER-4B-001'
      ],
      scripts: [
        'snx-shadow-ai-knowledge.js?v=SNS-2026-SHADOW-AI-STAGE2-001',
        'snx-shadow-ai-e1.js?v=SNS-2026-SHADOW-EMOTION-E1-RC1',
        'snx-shadow-memory.js?v=SNS-2026-SHADOW-MEMORY-E2-RC2',
        'snx-shadow-conv-history.js?v=SNS-2026-SHADOW-ADAPTIVE-LEARNING-FINAL-002',
        'snx-shadow-adaptive.js?v=SNS-2026-SHADOW-ADAPTIVE-LEARNING-FINAL-002',
        'snx-shadow-ai.js?v=SNS-2026-SHADOW-ADAPTIVE-LEARNING-FINAL-002',
        'snx-shadow-voice.js?v=SNS-2026-SHADOW-VOICE-4A-001',
        'snx-shadow-character.js?v=SNS-2026-SHADOW-CHARACTER-4B-001'
      ],
      esModules: [],
      init: null   // SNXShadowAI.init() + SNXShadowVoice.init() + SNXShadowCharacter.init() called by toggleGrimPanel after load
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
      // Re-throw with full diagnostic metadata so the loadFeature() catch
      // receives the original exception (name, message, stack) and can log
      // it properly. Swallowing the error here caused "snxLivePageOpen
      // undefined after feature load" on Android — the module had failed
      // to parse but the loader reported success.
      console.error('[SNXFeatureLoader] ES module import FAILED:', {
        src: src,
        name: err && err.name,
        message: err && err.message,
        stack: err && err.stack
      });
      // Attach src to the error so the loadFeature catch can surface the URL.
      if (err) { err._snxSrc = src; }
      throw err;
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

    var isLive = (featureId === 'live');
    if (isLive) console.log('[LIVE] 1 feature requested');

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
      var isSfu = (src.split('?')[0] === 'snx-sfu.js');
      if (isSfu) work = work.then(function () {
        console.log('[LIVE] 2 snx-sfu requested');
        return _loadScript(src).then(function () {
          console.log('[LIVE] 3 snx-sfu loaded');
        });
      });
      else work = work.then(function () { return _loadScript(src); });
    });

    // 4. Load ES modules
    var esModules = def.esModules || [];
    esModules.forEach(function (src) {
      var isLiveJs = (src.split('?')[0] === 'live.js');
      if (isLiveJs) {
        work = work.then(function () {
          console.log('[LIVE] 4 live.js import starting');
          return _loadESModule(src).then(function () {
            console.log('[LIVE] 5 live.js import resolved');
            if (typeof global.snxLivePageOpen === 'function') {
              console.log('[LIVE] 6 snxLivePageOpen exists');
            } else {
              console.warn('[LIVE] 6 snxLivePageOpen NOT defined after live.js resolved');
            }
          });
        });
      } else {
        work = work.then(function () { return _loadESModule(src); });
      }
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
        // Full diagnostic for Android troubleshooting — never log tokens.
        console.error('[LIVE INIT ERROR]', {
          name: err && err.name,
          message: err && err.message,
          stack: err && err.stack,
          src: err && err._snxSrc,
          error: err
        });
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
      // Also hint shadow-ai CSS only on FULL mode + good/excellent connection + idle.
      schedule(function () {
        if (_getState('radio') === 'idle') {
          _loadCSS('snx-radio.css?v=SNS-2026-RADIO-PAGE-001').catch(function () {});
        }
        if (_getState('live') === 'idle') {
          _loadCSS('live.css?v=SNS-2026-LIVE-003').catch(function () {});
        }
        // Optional shadow-ai CSS prefetch: FULL + good/excellent connection only.
        // Never prefetch JS — that waits for the user's first Click Here.
        var tier = global.SNX_NET ? global.SNX_NET.tierId : 'unknown';
        if (_getState('shadow-ai') === 'idle' &&
            (tier === 'good' || tier === 'excellent' || tier === 'unknown')) {
          _loadCSS('snx-shadow-ai.css?v=SNS-2026-SHADOW-AI-STAGE2-001').catch(function () {});
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
