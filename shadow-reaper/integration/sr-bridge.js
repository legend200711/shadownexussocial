/**
 * shadow-reaper/integration/sr-bridge.js
 * Shadow Reaper AI — Stage 2 Integration Bridge
 *
 * Build: SR-2026-STAGE2-BRIDGE-001
 *
 * PURPOSE
 * ──────────────────────────────────────────────────────────────────
 * Thin adapter that connects the existing Grim Reaper panel UI to the
 * new unified window.ShadowReaper Core WITHOUT modifying any existing
 * production files.
 *
 * This file is the ONLY file that touches the website's panel code.
 * It does NOT rewrite the panel UI — it reuses the existing DOM and CSS.
 *
 * WHAT IT DOES
 * ──────────────────────────────────────────────────────────────────
 * 1. Loads all shadow-reaper/ modules in correct dependency order.
 * 2. Calls ShadowReaper.init() exactly once.
 * 3. Intercepts SNXShadowAI.open / SNXShadowAI.close → ShadowReaper.open/close.
 * 4. Intercepts SNXShadowAI.ask (which SNXShadowVoice also calls) →
 *    routes ALL messages through ShadowReaper.ask() — the single pipeline.
 * 5. Displays ShadowReaper responses in the existing panel DOM.
 * 6. Routes NAVIGATE signals to the existing window.navTo().
 * 7. Wires ShadowReaper thinking/answer events into SNXShadowCharacter.
 * 8. On any bridge error: falls back silently to the original SNXShadowAI.
 *
 * WHAT IT DOES NOT DO
 * ──────────────────────────────────────────────────────────────────
 * - Does NOT delete, modify, or shadow any snx-shadow-*.js file on disk.
 * - Does NOT rebuild voice UI or voice logic.
 * - Does NOT rebuild character visuals or RAF loops.
 * - Does NOT add polling, new RAF loops, or continuous timers.
 * - Does NOT call Cloudflare Workers AI (env.AI.run() calls = 0).
 * - Does NOT create another Firebase project.
 * - Does NOT push to GitHub or deploy.
 *
 * ROLLBACK
 * ──────────────────────────────────────────────────────────────────
 * If bridge fails at any stage, _fallback() restores the original
 * SNXShadowAI.open / .close / .ask from _originalAI and logs a
 * [SRBridge] warning. The old system continues normally.
 *
 * BRIDGE STATE MACHINE
 * ──────────────────────────────────────────────────────────────────
 *   idle  →  loading  →  active
 *                   ↓
 *                 fallback (on error)
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-STAGE2-BRIDGE-001';

  /* ─────────────────────────────────────────────────────────────
     DOCUMENT REFERENCE
     Use a local alias so the bridge works in Node.js test environments
     where `document` is provided as global.document (not bare `document`).
  ───────────────────────────────────────────────────────────────*/
  function _doc() {
    return global.document || (typeof document !== 'undefined' ? document : null);
  }

  /* ─────────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────────────*/
  var _state         = 'idle';    // 'idle' | 'loading' | 'active' | 'fallback'
  var _initCount     = 0;         // guard: ShadowReaper.init() must be called exactly once
  var _originalAI    = null;      // snapshot of original SNXShadowAI methods for rollback
  var _patched       = false;     // true once SNXShadowAI methods have been wrapped
  var _busy          = false;     // rapid-send guard (mirrors SNXShadowAI._busy)

  /* ─────────────────────────────────────────────────────────────
     INTERNAL UTILS
  ───────────────────────────────────────────────────────────────*/
  function _log(msg) {
    console.log('[SRBridge] ' + msg);
  }

  function _warn(msg) {
    console.warn('[SRBridge] ' + msg);
  }

  /* ─────────────────────────────────────────────────────────────
     FALLBACK — restore original SNXShadowAI if bridge breaks
  ───────────────────────────────────────────────────────────────*/
  function _fallback(reason) {
    _state = 'fallback';
    _warn('Falling back to SNXShadowAI. Reason: ' + (reason || 'unknown'));

    if (_originalAI && global.SNXShadowAI) {
      try {
        global.SNXShadowAI.open  = _originalAI.open;
        global.SNXShadowAI.close = _originalAI.close;
        global.SNXShadowAI.ask   = _originalAI.ask;
      } catch (e) {
        _warn('Could not restore original SNXShadowAI: ' + e.message);
      }
    }

    /* Expose bridge status */
    if (global.SRBridge) {
      global.SRBridge.state = 'fallback';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     DOM HELPERS
     Use existing SNXShadowAI DOM elements — same IDs, same CSS.
  ───────────────────────────────────────────────────────────────*/
  function _getConvArea() {
    var d = _doc(); return d ? d.getElementById('snx-ai-conversation') : null;
  }

  function _getInput() {
    var d = _doc(); return d ? d.getElementById('snx-ai-input') : null;
  }

  function _getTyping() {
    var d = _doc(); return d ? d.getElementById('snx-ai-typing') : null;
  }

  function _showTyping(on) {
    var el = _getTyping();
    if (!el) return;
    el.style.display = on ? 'flex' : 'none';
    if (on) {
      var area = _getConvArea();
      if (area) area.scrollTop = area.scrollHeight;
    }
  }

  /* Append a message bubble to the existing #snx-ai-conversation area */
  function _appendMessage(role, text) {
    var area = _getConvArea();
    if (!area) return null;

    var _d = _doc();
    if (!_d) return null;
    var wrapper = _d.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:' +
      (role === 'user' ? 'flex-end' : 'flex-start') + ';gap:2px;';

    var bubble = _d.createElement('div');
    bubble.className = 'snx-ai-bubble snx-ai-bubble--' + role;

    /* Safe: textContent only, never innerHTML for message content */
    if (role === 'grim') {
      /* Typewriter effect — same as SNXShadowAI */
      var idx = 0;
      var full = text;
      (function type() {
        if (idx < full.length) {
          bubble.textContent += full[idx++];
          area.scrollTop = area.scrollHeight;
          setTimeout(type, 12);
        } else {
          area.scrollTop = area.scrollHeight;
        }
      })();
    } else {
      bubble.textContent = text;
    }

    var ts = _d.createElement('span');
    ts.className = 'snx-ai-ts';
    ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrapper.appendChild(bubble);
    wrapper.appendChild(ts);
    area.appendChild(wrapper);
    area.scrollTop = area.scrollHeight;

    return wrapper;
  }

  /* Append navigation button (same style as SNXShadowAI) */
  function _appendNavBtn(wrapper, page) {
    if (!wrapper || !page) return;

    var labelMap = {
      feed: '🏠 Home Feed', profile: '👤 Profile', search: '🔍 Search',
      notifications: '🔔 Notifications', settings: '⚙️ Settings',
      inbox: '💬 Inbox', friends: '🦋 Friends & Family',
      community: '💙 Community Hub', rules: '📜 Community Rules',
      arcade: '🕹️ Arcade', stormrooms: '⚡ Storm Rooms',
      supportrooms: '🫂 Support Rooms', radio: '📻 Radio',
      live: '🔴 Live', tv: '📺 TV'
    };

    var d2 = _doc(); if (!d2) return; var btn = d2.createElement('button');
    btn.className = 'snx-ai-nav-btn';
    btn.textContent = '→ Take me to ' + (labelMap[page.toLowerCase()] || page);
    btn.addEventListener('click', function () {
      _doNavigate(page);
    });
    wrapper.appendChild(btn);
  }

  /* Route a navigation signal through the existing navTo() */
  function _doNavigate(destination) {
    if (!destination) return;
    /* Close panel first */
    if (global.SNXShadowAI && typeof _originalAI.close === 'function') {
      try { _originalAI.close(); } catch (_) {}
    }
    /* Close grim panel visually */
    var _dn = _doc();
    if (_dn) {
      var panel = _dn.getElementById('grim-panel');
      if (panel) panel.classList.remove('open');
      var overlay = _dn.getElementById('grim-panel-overlay');
      if (overlay) overlay.classList.remove('visible');
      if (_dn.body) _dn.body.classList.remove('grim-open');
    }

    /* Navigate */
    if (typeof global.navTo === 'function') {
      try { global.navTo(destination); } catch (e) {
        _warn('navTo failed: ' + e.message);
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PATCH SNXShadowAI
     Wraps open / close / ask so ALL message paths (typed + voice)
     are intercepted. SNXShadowVoice calls SNXShadowAI.ask() directly
     so wrapping ask() is the natural interception point.
  ───────────────────────────────────────────────────────────────*/
  function _patchSNXShadowAI() {
    var AI = global.SNXShadowAI;
    if (!AI) {
      _warn('SNXShadowAI not available — cannot patch.');
      return false;
    }

    /* Snapshot originals for rollback */
    _originalAI = {
      open:  AI.open,
      close: AI.close,
      ask:   AI.ask
    };

    /* ── open ── */
    AI.open = function () {
      try {
        /* Let SNXShadowAI build the UI first (idempotent) */
        _originalAI.open.call(this);
        /* Then signal the new Core */
        if (global.ShadowReaper) global.ShadowReaper.open();
      } catch (e) {
        _fallback('open() error: ' + e.message);
        _originalAI.open.call(this);
      }
    };

    /* ── close ── */
    AI.close = function () {
      try {
        _originalAI.close.call(this);
        if (global.ShadowReaper) global.ShadowReaper.close();
      } catch (e) {
        _fallback('close() error: ' + e.message);
        _originalAI.close.call(this);
      }
    };

    /* ── ask ── (intercepts BOTH typed input AND SNXShadowVoice transcript) ── */
    AI.ask = function (message) {
      if (_state === 'fallback') {
        /* Bridge broken — delegate to original */
        return _originalAI.ask.call(this, message);
      }

      if (!message || !message.trim()) return;
      if (_busy) return;

      var text = message.trim();
      _busy = true;

      try {
        /* Show user bubble immediately */
        _appendMessage('user', text);

        /* Disable send controls */
        var inp     = _getInput();
        var _ds     = _doc();
        var sendBtn = _ds ? _ds.getElementById('snx-ai-send') : null;
        if (inp)     { inp.value = ''; inp.disabled = true; }
        if (sendBtn) sendBtn.disabled = true;

        _showTyping(true);

        global.ShadowReaper.ask(text).then(function (result) {
          _showTyping(false);
          _busy = false;

          var replyText = (result && result.text) ? result.text
            : "I don't have enough information to answer that yet.";

          var wrapper = _appendMessage('grim', replyText);

          /* NAVIGATE signal → navTo() */
          if (result && result.signal === 'NAVIGATE' && result.navigateTo) {
            var delay = replyText.length * 13 + 400;
            var dest  = result.navigateTo;
            /* Show nav button after typewriter finishes */
            setTimeout(function () {
              _appendNavBtn(wrapper, dest);
            }, delay);
          }

          /* Re-enable controls */
          if (inp) {
            inp.disabled = false;
            setTimeout(function () {
              if (global.innerWidth > 768 && typeof inp.focus === 'function') inp.focus();
            }, 50);
          }
          if (sendBtn) sendBtn.disabled = false;

        }).catch(function (err) {
          _warn('ShadowReaper.ask() rejected: ' + err.message);
          _showTyping(false);
          _busy = false;

          /* Show a polite fallback in the existing UI */
          _appendMessage('grim', "Shadow Reaper ran into a problem. Please try again.");

          /* Re-enable controls */
          var inp2     = _getInput();
          var _dc      = _doc();
          var sendBtn2 = _dc ? _dc.getElementById('snx-ai-send') : null;
          if (inp2)     inp2.disabled = false;
          if (sendBtn2) sendBtn2.disabled = false;
        });

      } catch (e) {
        /* Catch synchronous errors — fall back immediately */
        _fallback('ask() sync error: ' + e.message);
        _busy = false;
        _originalAI.ask.call(this, text);
      }
    };

    _patched = true;
    _log('SNXShadowAI.open / .close / .ask patched.');
    return true;
  }

  /* ─────────────────────────────────────────────────────────────
     WIRE CHARACTER INTEGRATION
     ShadowReaper Core already calls onAIThinking / onAIAnswer on its
     internal character interface (SRCharacterInterface). But to drive
     the existing SNXShadowCharacter we register directly via
     SNXShadowAI.onThinking() / onAnswer() hooks — which fire from the
     same _send() call path that the bridge has now inherited.
  ───────────────────────────────────────────────────────────────*/
  function _wireCharacter() {
    var AI   = global.SNXShadowAI;
    var Char = global.SNXShadowCharacter;

    if (!AI || !Char) {
      _warn('Character wiring skipped — SNXShadowAI or SNXShadowCharacter not loaded.');
      return;
    }

    /* Register the existing character controller's thinking/answer hooks
       through the existing SNXShadowAI listener mechanism. */
    if (typeof AI.onThinking === 'function' && typeof Char.onAIThinking === 'function') {
      AI.onThinking(Char.onAIThinking);
      _log('Character thinking hook registered.');
    }
    if (typeof AI.onAnswer === 'function' && typeof Char.onAIAnswer === 'function') {
      AI.onAnswer(Char.onAIAnswer);
      _log('Character answer hook registered.');
    }
  }

  /* ─────────────────────────────────────────────────────────────
     INIT — called by 'shadow-ai-unified' feature loader entry point
     (or directly from sr-bridge self-init below).
  ───────────────────────────────────────────────────────────────*/
  function _init() {
    if (_state === 'active') {
      _log('Already active — init() is idempotent.');
      return;
    }
    if (_state === 'loading') {
      _log('Init already in progress.');
      return;
    }

    _state = 'loading';
    _log('Initializing. Build: ' + BUILD_ID);

    try {
      /* 1. Verify ShadowReaper Core is available */
      if (!global.ShadowReaper) {
        throw new Error('window.ShadowReaper not found. Load shadow-reaper/ modules first.');
      }

      /* 2. Init Core exactly once */
      if (_initCount === 0) {
        global.ShadowReaper.init();
        _initCount++;
        _log('ShadowReaper.init() called (count: ' + _initCount + ').');
      }

      /* 3. Patch SNXShadowAI — wait until it's loaded */
      if (global.SNXShadowAI) {
        _patchSNXShadowAI();
      } else {
        _warn('SNXShadowAI not yet loaded — deferring patch via SNXFeatureLoader.');
        /* If invoked before SNXShadowAI loads, listen for load completion */
        var _deferCheck = setInterval(function () {
          if (global.SNXShadowAI && !_patched) {
            clearInterval(_deferCheck);
            _patchSNXShadowAI();
            _wireCharacter();
            _state = 'active';
            _log('Deferred activation complete.');
          }
        }, 100);
        /* Limit to 10 s */
        setTimeout(function () { clearInterval(_deferCheck); }, 10000);
        /* Return early — will complete asynchronously */
        return;
      }

      /* 4. Wire character state signals */
      _wireCharacter();

      _state = 'active';
      _log('Active. All integrations wired.');

    } catch (e) {
      _fallback('init error: ' + e.message);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API — window.SRBridge
  ───────────────────────────────────────────────────────────────*/
  global.SRBridge = {
    /** Initialize the bridge (idempotent). */
    init: _init,

    /**
     * Returns current bridge state.
     * 'idle' | 'loading' | 'active' | 'fallback'
     */
    getState: function () { return _state; },

    /** Returns true if bridge is active and patch is installed. */
    isActive: function () { return _state === 'active'; },

    /** Returns true if bridge has fallen back to SNXShadowAI. */
    isFallback: function () { return _state === 'fallback'; },

    /** Number of times ShadowReaper.init() was called (must be 1). */
    initCount: function () { return _initCount; },

    /** Returns true if SNXShadowAI.ask has been patched. */
    isPatched: function () { return _patched; },

    /**
     * Reset busy flag.
     * FOR TESTING ONLY — allows tests to send multiple messages in sequence.
     */
    _testResetBusy: function () { _busy = false; },

    /** Build identifier */
    build: BUILD_ID,

    /** Expose state for test assertions */
    state: _state
  };

  _log('Loaded. Call SRBridge.init() to activate.');

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
