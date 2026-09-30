/**
 * snx-shadow-ai.js
 * Shadow Nexus Social — Shadow Reaper AI Core
 *
 * Build: SNS-2026-SHADOW-AI-STAGE2B-CF-AI-001
 *
 * Exposes: window.SNXShadowAI
 *
 * Stage 2B changes (over Stage 2A):
 *  • Workers AI binding replaces the external model server adapter.
 *    Shadow Reaper now calls Cloudflare Workers AI directly via env.AI.run().
 *  • Model: @cf/meta/llama-3.2-3b-instruct — current, free-plan compatible.
 *  • No OpenAI API. No SHADOW_MODEL_ENDPOINT. No SHADOW_MODEL_AUTH.
 *    No external GPU server. No laptop server. No Hugging Face.
 *  • New error codes handled: FREE_ALLOCATION_EXHAUSTED, CF_CAPACITY.
 *    Both fall back immediately to local knowledge — no retry on allocation errors.
 *  • AI binding is server-side only. No AI credentials in frontend code.
 *  • All Stage 2A capabilities preserved: conversation history, rate limiting
 *    (KV-backed + in-process fallback), navigation whitelist, Founder
 *    verification, safe text rendering, 20-second timeout, lazy loading,
 *    mobile support.
 *
 * Stage 2A changes (still active):
 *  • OpenAI dependency REMOVED. No SHADOW_AI_API_KEY required.
 *  • MODEL_NOT_CONFIGURED fallback preserved for compatibility.
 *
 * Stage 2 additions (over Stage 1 — still active):
 *  • Real AI connection via POST /shadow-ai/chat (Cloudflare Worker endpoint).
 *  • Provider abstraction: frontend only knows the endpoint, never model secrets.
 *  • Multi-turn conversation sent to server (history bounded to 10 pairs).
 *  • Stage 1 local knowledge used as relevance-matched grounding snippets.
 *  • Stage 1 local knowledge remains as fallback if server is unavailable.
 *  • 20-second client-side timeout with friendly error message.
 *  • HTTP 429 → friendly retry message.
 *  • Network failure → Stage 1 local knowledge fallback.
 *  • Loading/thinking state with duplicate-send protection.
 *  • Navigation intents: server returns {action:{type:"navigate",target}} —
 *    target is whitelisted server-side AND client-side before navigateTo().
 *  • No API keys, provider URLs, or secrets ever leave the server.
 *  • All AI text rendered with textContent (never innerHTML).
 *
 * Design constraints (unchanged from Stage 1):
 *  • Does NOT create another floating button, panel, navigation item, or
 *    Click Here entry point.  All UI lives INSIDE the existing #grim-panel.
 *  • Does NOT restart Radio, TV, Live, Firebase, or the existing GP canvas RAF.
 *  • Does NOT add itself to startup — loaded only when the user opens the panel.
 *  • Idempotent: safe to call init() / open() multiple times.
 *  • No eval(), no new Function(), no unsanitized innerHTML.
 *  • Conversation history is memory-only for this session (≤ 20 pairs).
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
  var MAX_HISTORY = 20; // max conversation turns (user+grim pairs) — bounded for server
  var BUILD_ID    = 'SNS-2026-SHADOW-AI-STAGE2B-CF-AI-001';

  /* Cloudflare Worker AI endpoint — never put an API key here */
  var AI_ENDPOINT = 'https://yellow-term-11e6.nthntjrn.workers.dev/shadow-ai/chat';

  /* Client-side timeout for AI requests (ms) */
  var AI_TIMEOUT_MS = 20000;

  /* Client-side navigation whitelist — mirrors server whitelist */
  var AI_NAV_WHITELIST = {
    feed:true, profile:true, search:true, notifications:true,
    settings:true, inbox:true, friends:true, community:true,
    rules:true, arcade:true, stormrooms:true, supportrooms:true,
    radio:true, live:true, tv:true
  };

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
      localKnowledge:          true,
      externalAI:              true,   // Stage 2B — Cloudflare Workers AI
      workersAIBinding:        true,   // Stage 2B — env.AI.run()
      openAIDependency:        false,  // Stage 2A/2B — removed
      ownModelServer:          false,  // Stage 2B — no external server
      navigationMap:           true,
      contextBuilder:          true,
      offlineFallback:         true,
      freeAllocationFallback:  true,   // Stage 2B — fallback on 3036/3040
      build:                   BUILD_ID
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
     FIREBASE ID TOKEN HELPER
     Gets the current user's Firebase ID token without storing it.
     Returns null if not signed in or token unavailable.
  ───────────────────────────────────────────────────────────────*/
  function _getIdToken(cb) {
    try {
      var firebase = global.firebase || (global.firebase);
      if (firebase && firebase.auth && typeof firebase.auth === 'function') {
        var user = firebase.auth().currentUser;
        if (user && typeof user.getIdToken === 'function') {
          user.getIdToken(false).then(function (t) { cb(t); }).catch(function () { cb(null); });
          return;
        }
      }
    } catch (_) {}
    cb(null);
  }

  /* ─────────────────────────────────────────────────────────────
     RELEVANT KNOWLEDGE SNIPPETS
     Gather up to 3 knowledge entries relevant to the user message.
     Sent as grounding context to the server — not the full 23 entries.
  ───────────────────────────────────────────────────────────────*/
  function _getRelevantSnippets(message) {
    if (!global.SNXShadowKnowledge || typeof global.SNXShadowKnowledge.query !== 'function') {
      return [];
    }
    try {
      /* query() returns the best-matching result; we also check nearby entries */
      var result = global.SNXShadowKnowledge.query(message, _buildContext());
      if (!result || !result.id) return [];
      /* Return the matched entry's summary+how as a snippet object */
      var entry = global.SNXShadowKnowledge.getEntry(result.id);
      if (!entry) return [];
      return [{
        title:   entry.title   || '',
        summary: entry.summary || '',
        how:     entry.how     || ''
      }];
    } catch (_) {
      return [];
    }
  }

  /* ─────────────────────────────────────────────────────────────
     ABORT CONTROLLER HELPER — one per in-flight request
  ───────────────────────────────────────────────────────────────*/
  var _currentAbort = null;

  function _abortPending() {
    if (_currentAbort) {
      try { _currentAbort.abort(); } catch (_) {}
      _currentAbort = null;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PROVIDER ABSTRACTION  (Stage 2: server AI + local fallback)
  ───────────────────────────────────────────────────────────────*/
  var SNXShadowAIProvider = {
    /**
     * @param {object} params - { message, context, history }
     * @param {function} callback - fn(result) where result = {text, page, handled}
     */
    ask: function (params, callback) {
      var message   = params.message;
      var context   = params.context;
      var history   = params.history || [];
      var snippets  = _getRelevantSnippets(message);

      /* Build conversation array (last 10 pairs max — keep bandwidth low) */
      var conversation = history.slice(-20).map(function (h) {
        return { role: h.role, text: h.text };
      });

      /* Get Firebase ID token (may be null for guests) */
      _getIdToken(function (idToken) {
        var headers = { 'Content-Type': 'application/json' };
        if (idToken) headers['Authorization'] = 'Bearer ' + idToken;

        var body = JSON.stringify({
          message:          message,
          conversation:     conversation,
          context:          context,
          knowledgeSnippets: snippets
        });

        /* AbortController for timeout */
        _abortPending();
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        _currentAbort  = controller;
        var timeoutId  = null;

        if (controller) {
          timeoutId = setTimeout(function () {
            _abortPending();
          }, AI_TIMEOUT_MS);
        }

        fetch(AI_ENDPOINT, {
          method:  'POST',
          headers: headers,
          body:    body,
          signal:  controller ? controller.signal : undefined
        })
        .then(function (res) {
          if (timeoutId) clearTimeout(timeoutId);
          _currentAbort = null;

          /* HTTP 429 — rate limited, allocation exhausted, or capacity exceeded */
          if (res.status === 429) {
            return res.json().then(function (d) {
              var errCode = (d && d.error) ? d.error : '';
              if (errCode === 'FREE_ALLOCATION_EXHAUSTED') {
                /* Daily neurons exhausted — use local fallback immediately, no retry */
                return _fallbackToLocal(message, callback);
              }
              if (errCode === 'CF_CAPACITY') {
                /* Cloudflare capacity temporarily exceeded — use local fallback */
                return _fallbackToLocal(message, callback);
              }
              /* Generic rate limit (our own RL or other 429) — friendly message */
              callback({
                text: "Shadow Reaper has reached its request limit for the moment. Give it a breath — try again shortly.",
                page: null, handled: true, fromServer: false
              });
            }).catch(function () {
              _fallbackToLocal(message, callback);
            });
          }

          /* HTTP 503 — AI binding missing or other service unavailable */
          if (res.status === 503) {
            return _fallbackToLocal(message, callback);
          }

          if (!res.ok) {
            return _fallbackToLocal(message, callback);
          }

          return res.json().then(function (data) {
            var reply  = (typeof data.reply === 'string') ? data.reply.trim() : '';
            var action = (data.action && typeof data.action === 'object') ? data.action : null;

            if (!reply) {
              return _fallbackToLocal(message, callback);
            }

            /* Validate navigation action client-side — whitelist enforced twice */
            var page = null;
            if (action && action.type === 'navigate' && typeof action.target === 'string') {
              var target = action.target.toLowerCase().replace(/[^a-z]/g, '');
              if (AI_NAV_WHITELIST[target]) {
                page = target;
              }
            }

            callback({ text: reply, page: page, handled: true, fromServer: true });
          });
        })
        .catch(function (err) {
          if (timeoutId) clearTimeout(timeoutId);
          _currentAbort = null;

          var isTimeout = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
          if (isTimeout) {
            /* Timeout — try local fallback silently */
            return _fallbackToLocal(message, callback);
          }

          /* Network failure — try local fallback */
          _fallbackToLocal(message, callback);
        });
      }); /* end _getIdToken */
    } /* end ask */
  };

  /* ─────────────────────────────────────────────────────────────
     FALLBACK TO LOCAL KNOWLEDGE
     Used when the server AI endpoint is unavailable.
  ───────────────────────────────────────────────────────────────*/
  function _fallbackToLocal(message, callback) {
    var result = _askLocal(message);
    if (result && result.handled) {
      callback(result);
    } else {
      callback({
        text: "Shadow Reaper can't reach the Nexus intelligence right now. Try again in a moment.",
        page: null,
        handled: false,
        fromServer: false
      });
    }
  }

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

    /* Disable send controls while busy */
    var inp     = _getInput();
    var sendBtn = document.getElementById('snx-ai-send');
    if (inp)     { inp.value = ''; inp.disabled = true; }
    if (sendBtn)   sendBtn.disabled = true;

    SNXShadowAIProvider.ask(
      { message: text, context: _buildContext(), history: _history.slice() },
      function (result) {
        /* Guard: if panel was destroyed or a newer request came in, discard */
        if (seq !== _reqSeq && seq < _reqSeq - 1) {
          _showTyping(false);
          _busy = false;
          if (inp)     inp.disabled = false;
          if (sendBtn) sendBtn.disabled = false;
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
        /* Re-enable controls */
        if (inp)     { inp.disabled = false; setTimeout(function() { if (global.innerWidth > 768) inp.focus(); }, 50); }
        if (sendBtn) sendBtn.disabled = false;
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
    _abortPending();
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
