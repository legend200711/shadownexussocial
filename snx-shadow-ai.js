/**
 * snx-shadow-ai.js
 * Shadow Nexus Social — Shadow Reaper AI Core
 *
 * Build: SNS-2026-SHADOW-AI-STAGE1-001
 *
 * Exposes: window.SNXShadowAI
 *
 * Design constraints:
 *  • Does NOT create another floating button, panel, navigation item, or
 *    Click Here entry point.  All UI lives INSIDE the existing #grim-panel.
 *  • Does NOT restart Radio, TV, Live, Firebase, or the existing GP canvas RAF.
 *  • Does NOT add itself to startup — loaded only when the user opens the panel.
 *  • Idempotent: safe to call init() / open() multiple times.
 *  • No eval(), no new Function(), no unsanitized innerHTML.
 *  • Conversation history is memory-only for this session (≤ 30 pairs).
 *  • Local knowledge only in Stage 1 — no external AI provider or API keys.
 *
 * Integration point: toggleGrimPanel() in index.html calls
 *   SNXFeatureLoader.loadFeature('shadow-ai') then SNXShadowAI.open()
 *   after the feature loads.  The existing GP.init() path is preserved
 *   unchanged as the fallback when the feature has not loaded yet.
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var MAX_HISTORY = 30; // max conversation turns (user+grim pairs)
  var BUILD_ID    = 'SNS-2026-SHADOW-AI-STAGE1-001';

  /* Status values shown in the panel status bar */
  var STATUS = {
    READY:    'READY',
    THINKING: 'THINKING',
    OFFLINE:  'OFFLINE',
    ERROR:    'ERROR'
  };

  /* ─────────────────────────────────────────────────────────────
     MODULE STATE — private
  ───────────────────────────────────────────────────────────────*/
  var _initialized  = false;
  var _open         = false;
  var _busy         = false;       // rapid-send protection
  var _reqSeq       = 0;           // monotonic request id
  var _history      = [];          // [{role:'user'|'grim', text:string}]
  var _listeners    = [];          // unused in Stage 1, reserved for Stage 2

  /* ─────────────────────────────────────────────────────────────
     SAFE TEXT HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _setText(el, text) {
    if (el) el.textContent = text;
  }

  /* Set status pill text + class */
  function _setStatus(statusKey) {
    var el = document.getElementById('snx-ai-status');
    if (!el) return;
    el.textContent = statusKey;
    el.className = 'snx-ai-status snx-ai-status--' + statusKey.toLowerCase();
  }

  /* ─────────────────────────────────────────────────────────────
     CONTEXT BUILDER  (safe — no tokens, no secrets)
  ───────────────────────────────────────────────────────────────*/
  function _buildContext() {
    var ctx = {};

    /* Performance mode */
    if (global.SNXPerf && typeof global.SNXPerf.mode === 'string') {
      ctx.perfMode = global.SNXPerf.mode;
    } else {
      try { ctx.perfMode = localStorage.getItem('snxPerfMode') || 'BALANCED'; } catch(_) {}
    }

    /* Network quality */
    if (global.SNX_NET && global.SNX_NET.tierId) {
      ctx.networkTier = global.SNX_NET.tierId;
    } else {
      ctx.networkTier = navigator.onLine ? 'unknown' : 'offline';
    }

    /* Auth state — role only, no tokens */
    ctx.signedIn = false;
    ctx.role = 'guest';
    if (global._snxCurrentUser) {
      ctx.signedIn = true;
      ctx.role = 'member';
    }
    /* Founder flag — read existing authoritative state only */
    if (global._snxIsFounder === true) {
      ctx.role = 'founder';
    }

    /* Active features — read existing window flags */
    ctx.radioActive = !!(global._snxRadioActive || global.snxRadioPageOpen);
    ctx.liveActive  = !!(global._snxLiveActive);
    ctx.tvActive    = !!(global._snxTvActive);
    ctx.djActive    = !!(global._snxDJActive);

    /* Current page hint */
    var activePage = null;
    var pages = document.querySelectorAll('.page.active');
    if (pages.length) {
      activePage = pages[0].id || null;
    }
    ctx.currentPage = activePage;

    return ctx;
  }

  /* ─────────────────────────────────────────────────────────────
     CONTEXT CAPABILITIES
  ───────────────────────────────────────────────────────────────*/
  function _getCapabilities() {
    return {
      localKnowledge:  true,
      externalAI:      false,   // Stage 2
      navigationMap:   true,
      contextBuilder:  true,
      offlineFallback: true,
      build:           BUILD_ID
    };
  }

  /* ─────────────────────────────────────────────────────────────
     SAFE NAVIGATION MAP
     Only approved internal destinations via existing navTo()
  ───────────────────────────────────────────────────────────────*/
  var _NAV_MAP = {
    feed:             function() { if (typeof navTo === 'function') navTo('feed'); },
    profile:          function() { if (typeof viewMyProfile === 'function') viewMyProfile(); },
    search:           function() { if (typeof navTo === 'function') navTo('searchPage'); },
    notifications:    function() { if (typeof navTo === 'function') navTo('notificationsPage'); },
    settings:         function() { if (typeof navTo === 'function') navTo('settingsPage'); },
    inbox:            function() { if (typeof navTo === 'function') navTo('inboxPage'); },
    friends:          function() { if (typeof navTo === 'function') navTo('friendsPage'); },
    community:        function() { if (typeof navTo === 'function') navTo('communityPage'); },
    rules:            function() { if (typeof navTo === 'function') navTo('communityRulesPage'); },
    arcade:           function() { if (typeof openArcadeHub === 'function') openArcadeHub(); },
    stormrooms:       function() { if (typeof navTo === 'function') navTo('stormRoomsPage'); },
    supportrooms:     function() { if (typeof navTo === 'function') navTo('supportRoomsPage'); },
    radio:            function() { if (typeof navTo === 'function') navTo('radioPage'); },
    live:             function() { if (typeof navTo === 'function') navTo('liveViewPage'); },
    tv:               function() { if (typeof navTo === 'function') navTo('tvPage'); }
  };

  function navigateTo(feature) {
    var key = (feature || '').toLowerCase().replace(/[^a-z]/g, '');
    if (_NAV_MAP[key]) {
      _close();
      _NAV_MAP[key]();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     LOCAL ANSWER ENGINE
     Delegates to SNXShadowKnowledge if loaded, otherwise uses
     inline crisis + unknown fallback.
  ───────────────────────────────────────────────────────────────*/
  function _askLocal(message) {
    /* Crisis intercept — always highest priority */
    if (/(suicide|kill myself|end my life|want to die|dont want to live|self.harm|hurt myself)/i.test(message)) {
      return {
        text: "I hear you, and what you are feeling matters enormously. Please reach out right now — US: call or text 988 · UK: 116 123 · Australia: 13 11 14. You deserve real support. You do not have to face this alone.",
        page: null,
        handled: true
      };
    }

    /* Delegate to knowledge module if available */
    if (global.SNXShadowKnowledge && typeof global.SNXShadowKnowledge.query === 'function') {
      var result = global.SNXShadowKnowledge.query(message, _buildContext());
      if (result) return result;
    }

    /* Unknown question */
    return {
      text: "I do not have enough local Shadow Nexus knowledge to answer that yet. If you have a question about the site, try asking about a specific feature — Radio, Live, TV, Feed, Profile, Settings, and more.",
      page: null,
      handled: false
    };
  }

  /* ─────────────────────────────────────────────────────────────
     CONVERSATION HISTORY MANAGEMENT
  ───────────────────────────────────────────────────────────────*/
  function _addToHistory(role, text) {
    _history.push({ role: role, text: text });
    /* Enforce ceiling — remove oldest pair when over limit */
    while (_history.length > MAX_HISTORY * 2) {
      _history.splice(0, 2);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PROVIDER ABSTRACTION  (Stage 1: local only)
     Stage 2 replaces this with an external provider call.
  ───────────────────────────────────────────────────────────────*/
  var SNXShadowAIProvider = {
    /**
     * @param {object} params - { message, context, history }
     * @param {function} callback - fn(result) where result = {text, page, handled}
     */
    ask: function (params, callback) {
      /* Stage 1: pure local knowledge — synchronous via setTimeout for UX */
      var result = _askLocal(params.message);
      setTimeout(function () { callback(result); }, 600 + Math.random() * 400);
    }
  };

  /* ─────────────────────────────────────────────────────────────
     DOM HELPERS
  ───────────────────────────────────────────────────────────────*/
  function _getConvArea() {
    return document.getElementById('snx-ai-conversation');
  }

  function _getInput() {
    return document.getElementById('snx-ai-input');
  }

  /* Append a message bubble to the conversation area */
  function _appendMessage(role, text) {
    var area = _getConvArea();
    if (!area) return;

    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:' +
      (role === 'user' ? 'flex-end' : 'flex-start') + ';gap:2px;';

    var bubble = document.createElement('div');
    bubble.className = 'snx-ai-bubble snx-ai-bubble--' + role;

    /* SAFE: always textContent, never innerHTML for message content */
    if (role === 'grim') {
      /* Typewriter effect */
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

    var ts = document.createElement('span');
    ts.className = 'snx-ai-ts';
    ts.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    wrapper.appendChild(bubble);
    wrapper.appendChild(ts);
    area.appendChild(wrapper);
    area.scrollTop = area.scrollHeight;

    return wrapper;
  }

  /* Append a nav button after a grim message if a destination page is known */
  function _appendNavBtn(wrapper, page) {
    if (!wrapper || !page) return;
    var navFn = _NAV_MAP[page];
    if (!navFn) return;

    var labelMap = {
      feed: '🏠 Home Feed', profile: '👤 Profile', search: '🔍 Search',
      notifications: '🔔 Notifications', settings: '⚙️ Settings',
      inbox: '💬 Inbox', friends: '🦋 Friends & Family',
      community: '💙 Community Hub', rules: '📜 Community Rules',
      arcade: '🕹️ Arcade', stormrooms: '⚡ Storm Rooms',
      supportrooms: '🫂 Support Rooms', radio: '📻 Radio',
      live: '🔴 Live', tv: '📺 TV'
    };

    var btn = document.createElement('button');
    btn.className = 'snx-ai-nav-btn';
    btn.textContent = '→ Take me to ' + (labelMap[page] || page);
    btn.addEventListener('click', function () {
      navigateTo(page);
    });
    wrapper.appendChild(btn);
  }

  /* Show/hide typing indicator */
  function _showTyping(on) {
    var el = document.getElementById('snx-ai-typing');
    if (!el) return;
    el.style.display = on ? 'flex' : 'none';
    if (on) {
      var area = _getConvArea();
      if (area) area.scrollTop = area.scrollHeight;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     SEND  —  main flow
  ───────────────────────────────────────────────────────────────*/
  function _send(message) {
    if (!message || !message.trim()) return;
    if (_busy) return;

    var text = message.trim();
    var seq  = ++_reqSeq;

    _busy = true;
    _setStatus(STATUS.THINKING);

    _addToHistory('user', text);
    _appendMessage('user', text);
    _showTyping(true);

    /* Clear input */
    var inp = _getInput();
    if (inp) inp.value = '';

    SNXShadowAIProvider.ask(
      { message: text, context: _buildContext(), history: _history.slice() },
      function (result) {
        /* Guard: if panel was destroyed or a newer request came in, discard */
        if (seq !== _reqSeq && seq < _reqSeq - 1) {
          _showTyping(false);
          _busy = false;
          return;
        }

        _showTyping(false);
        _setStatus(
          navigator.onLine ? STATUS.READY : STATUS.OFFLINE
        );

        var replyText = (result && result.text) ? result.text
          : "I do not have enough local Shadow Nexus knowledge to answer that yet.";

        _addToHistory('grim', replyText);
        var wrapper = _appendMessage('grim', replyText);

        /* Navigation button */
        if (result && result.page) {
          /* Delay so button appears after typewriter finishes */
          var delay = replyText.length * 13 + 400;
          setTimeout(function () {
            _appendNavBtn(wrapper, result.page);
          }, delay);
        }

        _busy = false;
      }
    );
  }

  /* ─────────────────────────────────────────────────────────────
     CONVERSATION UI  — injected as a child of #grim-panel
     Does NOT touch the character stage, header, or chip area.
  ───────────────────────────────────────────────────────────────*/
  var _uiInjected = false;

  function _injectUI() {
    if (_uiInjected) return;
    if (!document.getElementById('grim-panel')) return;

    /* Check if already injected (idempotency on hot reload) */
    if (document.getElementById('snx-ai-conversation')) { _uiInjected = true; return; }

    /* Replace the existing #gp-messages, #gp-typing, and #gp-input-row
       with the SNXShadowAI conversation area.
       We hide the old elements so existing GP fallback still works if
       SNXShadowAI is not yet initialized. */
    var gpMessages  = document.getElementById('gp-messages');
    var gpTyping    = document.getElementById('gp-typing');
    var gpInputRow  = document.getElementById('gp-input-row');
    var gpNavChips  = document.getElementById('gp-nav-chips');
    var gpFullLink  = document.getElementById('gp-fullpage-link');
    var gpStatus    = document.getElementById('gp-status');

    /* Hide old GP elements — not removed, in case GP code still references them */
    [gpMessages, gpTyping, gpInputRow, gpNavChips, gpFullLink, gpStatus].forEach(function (el) {
      if (el) el.style.display = 'none';
    });

    /* Build new conversation UI */
    var panel = document.getElementById('grim-panel');

    /* Status bar */
    var statusBar = document.createElement('div');
    statusBar.id = 'snx-ai-statusbar';
    statusBar.innerHTML = '<span id="snx-ai-status" class="snx-ai-status snx-ai-status--ready">READY</span>';

    /* Conversation scroll area */
    var convArea = document.createElement('div');
    convArea.id = 'snx-ai-conversation';
    convArea.setAttribute('role', 'log');
    convArea.setAttribute('aria-live', 'polite');

    /* Typing indicator */
    var typingEl = document.createElement('div');
    typingEl.id = 'snx-ai-typing';
    typingEl.style.display = 'none';
    typingEl.innerHTML =
      '<div class="snx-ai-typing-dots"><span></span><span></span><span></span></div>';

    /* Input row */
    var inputRow = document.createElement('div');
    inputRow.id = 'snx-ai-input-row';

    var label = document.createElement('label');
    label.htmlFor = 'snx-ai-input';
    label.className = 'snx-sr-only';
    label.textContent = 'Message Shadow Reaper';

    var inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.id = 'snx-ai-input';
    inputEl.maxLength = 400;
    inputEl.placeholder = 'Ask anything about Shadow Nexus…';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('aria-label', 'Message Shadow Reaper');
    inputEl.setAttribute('inputmode', 'text');

    var sendBtn = document.createElement('button');
    sendBtn.id = 'snx-ai-send';
    sendBtn.setAttribute('aria-label', 'Send message');
    sendBtn.textContent = '➤';

    inputRow.appendChild(label);
    inputRow.appendChild(inputEl);
    inputRow.appendChild(sendBtn);

    /* Wire events — single attach, no duplicates */
    sendBtn.addEventListener('click', function () {
      _send(inputEl.value);
    });

    inputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _send(inputEl.value);
      }
    });

    /* Prevent iOS viewport bounce inside the scroll area */
    convArea.addEventListener('touchmove', function (e) {
      e.stopPropagation();
    }, { passive: true });

    /* Mobile keyboard: keep input visible */
    if (global.visualViewport) {
      global.visualViewport.addEventListener('resize', function () {
        var panel = document.getElementById('grim-panel');
        if (!panel || !panel.classList.contains('open')) return;
        var gap = global.innerHeight - global.visualViewport.height;
        panel.style.paddingBottom = gap > 0 ? (gap + 'px') : '';
      });
    }

    /* Append in order */
    panel.appendChild(statusBar);
    panel.appendChild(convArea);
    panel.appendChild(typingEl);
    panel.appendChild(inputRow);

    _uiInjected = true;
  }

  /* ─────────────────────────────────────────────────────────────
     GREETING
  ───────────────────────────────────────────────────────────────*/
  var _greeted = false;

  function _greet() {
    if (_greeted) return;
    _greeted = true;
    var greetings = [
      "Welcome back, Legend. What do you need help with?",
      "The shadows part. I know every corner of Shadow Nexus Social — ask me anything, or simply speak what is on your mind.",
      "Guardian of Shadow Nexus at your service. Looking for a feature or carrying something else — I am here for both."
    ];
    var text = greetings[Math.floor(Math.random() * greetings.length)];
    _addToHistory('grim', text);
    setTimeout(function () { _appendMessage('grim', text); }, 500);
    _setStatus(STATUS.READY);
  }

  /* ─────────────────────────────────────────────────────────────
     OPEN / CLOSE
  ───────────────────────────────────────────────────────────────*/
  function _open() {
    _injectUI();
    _greet();
    _open_flag();
    /* Focus input */
    setTimeout(function () {
      var inp = _getInput();
      if (inp && global.innerWidth > 768) inp.focus();
    }, 380);
  }

  function _open_flag() { _open = true; }

  function _close() { _open = false; }

  /* ─────────────────────────────────────────────────────────────
     INIT  — idempotent
  ───────────────────────────────────────────────────────────────*/
  function _init() {
    if (_initialized) return;
    _initialized = true;
    _injectUI();
    console.log('[SNXShadowAI] Initialized. Build: ' + BUILD_ID);
  }

  /* ─────────────────────────────────────────────────────────────
     DESTROY  — safe teardown (account-switch safe)
  ───────────────────────────────────────────────────────────────*/
  function _destroy() {
    _busy = false;
    _open = false;
    _initialized = false;
    _greeted = false;
    _history = [];
    _uiInjected = false;

    /* Re-show old GP elements */
    ['gp-messages','gp-typing','gp-input-row','gp-nav-chips','gp-fullpage-link','gp-status']
      .forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.style.display = '';
      });

    /* Remove injected SNX AI elements */
    ['snx-ai-statusbar','snx-ai-conversation','snx-ai-typing','snx-ai-input-row']
      .forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.parentNode && el.parentNode.removeChild(el);
      });

    console.log('[SNXShadowAI] Destroyed.');
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API  — window.SNXShadowAI
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowAI = {
    /** Initialize the AI core (idempotent). */
    init: _init,

    /** Open the AI conversation UI inside the existing grim-panel. */
    open: _open,

    /** Close / hide the AI conversation UI. */
    close: _close,

    /**
     * Send a message programmatically.
     * @param {string} message
     */
    ask: function (message) { _send(message); },

    /**
     * Returns safe context object (no tokens, no secrets).
     * @returns {object}
     */
    getContext: _buildContext,

    /**
     * Returns current Stage 1 capabilities.
     * @returns {object}
     */
    getCapabilities: _getCapabilities,

    /** Safe navigate to an approved internal destination. */
    navigateTo: navigateTo,

    /** Full teardown — call on account switch or explicit reset. */
    destroy: _destroy,

    /** Expose provider for Stage 2 replacement. */
    provider: SNXShadowAIProvider,

    /** Build identifier */
    build: BUILD_ID
  };

})(window);
