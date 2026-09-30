/**
 * snx-shadow-voice.js
 * Shadow Nexus Social — Shadow Reaper Voice Interface (Stage 4A)
 *
 * Build: SNS-2026-SHADOW-VOICE-4A-001
 *
 * Exposes: window.SNXShadowVoice
 *
 * Stage 4A — EXPERIENCE LAYER ONLY.
 * Does NOT modify the Stage 3A–3D intelligence pipeline.
 * Voice input is an alternate entry to SNXShadowAI.ask().
 * Voice output uses browser-native speechSynthesis.
 *
 * Privacy rules (absolute):
 *  • Microphone is NEVER activated automatically.
 *  • No audio is recorded, stored, or uploaded.
 *  • Only the text transcript enters the existing ask() pipeline.
 *  • Voice transcript goes through the same Stage 3 guards.
 *
 * Browser speech:
 *  • SpeechRecognition (or webkitSpeechRecognition) — free, on-device.
 *  • speechSynthesis — free, on-device.
 *  • No paid speech API. No Cloudflare AI for STT.
 *
 * Design constraints:
 *  • Does NOT touch Live/WebRTC/Cohost/DJ/Radio/TV microphone.
 *  • Does NOT restart any existing animation loop.
 *  • Voice response defaults OFF — user must explicitly enable.
 *  • Errors in voice NEVER crash Shadow Reaper text mode.
 *  • Loaded only when Shadow Reaper is opened (via feature loader).
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var BUILD_ID = 'SNS-2026-SHADOW-VOICE-4A-001';

  /* ─────────────────────────────────────────────────────────────
     VOICE STATES
  ───────────────────────────────────────────────────────────────*/
  var STATE = {
    IDLE:        'IDLE',
    LISTENING:   'LISTENING',
    PROCESSING:  'PROCESSING',
    SPEAKING:    'SPEAKING',
    MIC_BLOCKED: 'MIC_BLOCKED',
    MIC_UNSUP:   'MIC_UNSUPPORTED',
    MIC_ERROR:   'MIC_ERROR'
  };

  /* ─────────────────────────────────────────────────────────────
     MODULE STATE
  ───────────────────────────────────────────────────────────────*/
  var _initialized       = false;
  var _state             = STATE.IDLE;
  var _recognition       = null;   // SpeechRecognition instance (one-shot per use)
  var _voiceEnabled      = false;  // TTS response — default OFF (conservative)
  var _voiceInputSupported = false;
  var _destroyed         = false;

  /* Stage 4B: state-change listeners — called after every _setState() */
  var _stateListeners = [];

  /* Pref persistence key */
  var PREF_KEY = 'snxVoiceResponseEnabled';

  /* ─────────────────────────────────────────────────────────────
     CAPABILITY DETECTION
     Done once at init — never blocks module load.
  ───────────────────────────────────────────────────────────────*/
  var _SpeechRecognitionCtor = (function () {
    try {
      return global.SpeechRecognition || global.webkitSpeechRecognition || null;
    } catch (_) {
      return null;
    }
  })();

  var _speechSynthSupported = (function () {
    try { return !!global.speechSynthesis; } catch (_) { return false; }
  })();

  /* ─────────────────────────────────────────────────────────────
     STATE MACHINE
  ───────────────────────────────────────────────────────────────*/
  function _setState(newState) {
    if (_state === newState) return;
    _state = newState;
    _updateMicButton();
    _updateCharacterClass();
    /* Stage 4B: notify character controller */
    for (var _i = 0; _i < _stateListeners.length; _i++) {
      try { _stateListeners[_i](newState); } catch (_) {}
    }
  }

  /* ─────────────────────────────────────────────────────────────
     UI: MIC BUTTON  — appended inside #snx-ai-input-row
  ───────────────────────────────────────────────────────────────*/
  var _micBtn   = null;
  var _voiceBtn = null;  // voice response toggle

  function _injectControls() {
    var inputRow = document.getElementById('snx-ai-input-row');
    if (!inputRow) return;
    if (document.getElementById('snx-voice-mic')) return; // idempotent

    /* ── Microphone button ── */
    var micBtn = document.createElement('button');
    micBtn.id = 'snx-voice-mic';
    micBtn.setAttribute('aria-label', 'Start voice input');
    micBtn.setAttribute('tabindex', '0');
    micBtn.setAttribute('type', 'button');
    micBtn.title = 'Voice input';

    if (!_SpeechRecognitionCtor) {
      micBtn.disabled = true;
      micBtn.setAttribute('aria-label', 'Voice input not supported in this browser');
      micBtn.setAttribute('aria-disabled', 'true');
      _setState(STATE.MIC_UNSUP);
    }

    micBtn.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" focusable="false">' +
      '<path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>' +
      '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
      '<line x1="12" y1="19" x2="12" y2="23"/>' +
      '<line x1="8" y1="23" x2="16" y2="23"/>' +
      '</svg>';

    micBtn.addEventListener('click', function () {
      _onMicClick();
    });

    micBtn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _onMicClick();
      }
    });

    /* ── Voice response toggle ── */
    var voiceToggle = document.createElement('button');
    voiceToggle.id = 'snx-voice-toggle';
    voiceToggle.setAttribute('type', 'button');
    voiceToggle.setAttribute('aria-label', 'Toggle voice response (currently OFF)');
    voiceToggle.setAttribute('tabindex', '0');
    voiceToggle.title = 'Voice response: OFF';

    voiceToggle.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true" focusable="false">' +
      '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
      '<line x1="23" y1="9" x2="17" y2="15"/>' +
      '<line x1="17" y1="9" x2="23" y2="15"/>' +
      '</svg>';

    voiceToggle.addEventListener('click', function () {
      _toggleVoiceResponse();
    });

    voiceToggle.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        _toggleVoiceResponse();
      }
    });

    /* Append before the send button (last child) */
    var sendBtn = document.getElementById('snx-ai-send');
    if (sendBtn) {
      inputRow.insertBefore(voiceToggle, sendBtn);
      inputRow.insertBefore(micBtn, voiceToggle);
    } else {
      inputRow.appendChild(micBtn);
      inputRow.appendChild(voiceToggle);
    }

    _micBtn   = micBtn;
    _voiceBtn = voiceToggle;

    _updateMicButton();
    _updateVoiceToggle();

    /* Status bar: inject voice status indicator */
    _injectVoiceStatus();
  }

  function _injectVoiceStatus() {
    var statusBar = document.getElementById('snx-ai-statusbar');
    if (!statusBar || document.getElementById('snx-voice-status')) return;
    var vs = document.createElement('span');
    vs.id = 'snx-voice-status';
    vs.setAttribute('aria-live', 'assertive');
    vs.setAttribute('aria-atomic', 'true');
    vs.style.display = 'none';
    statusBar.insertBefore(vs, statusBar.firstChild);
  }

  function _setVoiceStatus(text) {
    var el = document.getElementById('snx-voice-status');
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.style.display = '';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     MIC BUTTON STATE RENDERING
  ───────────────────────────────────────────────────────────────*/
  function _updateMicButton() {
    if (!_micBtn) return;
    var s = _state;

    /* Remove all state classes */
    _micBtn.className = _micBtn.className
      .replace(/\bsnx-voice-mic--\S+/g, '')
      .trim();

    if (s === STATE.LISTENING) {
      _micBtn.classList.add('snx-voice-mic--listening');
      _micBtn.setAttribute('aria-label', 'Stop listening');
      _micBtn.setAttribute('aria-pressed', 'true');
      _setVoiceStatus('LISTENING');
    } else if (s === STATE.PROCESSING) {
      _micBtn.classList.add('snx-voice-mic--processing');
      _micBtn.setAttribute('aria-label', 'Processing…');
      _micBtn.setAttribute('aria-pressed', 'false');
      _setVoiceStatus('THINKING');
    } else if (s === STATE.SPEAKING) {
      _micBtn.classList.add('snx-voice-mic--speaking');
      _micBtn.setAttribute('aria-label', 'Stop speaking');
      _micBtn.setAttribute('aria-pressed', 'false');
      _setVoiceStatus('SPEAKING');
    } else if (s === STATE.MIC_BLOCKED) {
      _micBtn.classList.add('snx-voice-mic--blocked');
      _micBtn.disabled = true;
      _micBtn.setAttribute('aria-label', 'Microphone blocked. You can still type.');
      _micBtn.setAttribute('aria-disabled', 'true');
      _setVoiceStatus('MIC BLOCKED');
    } else if (s === STATE.MIC_UNSUP) {
      _micBtn.classList.add('snx-voice-mic--unsupported');
      _micBtn.disabled = true;
      _micBtn.setAttribute('aria-label', 'Voice input not supported in this browser');
      _micBtn.setAttribute('aria-disabled', 'true');
      _setVoiceStatus('');
    } else if (s === STATE.MIC_ERROR) {
      _micBtn.classList.add('snx-voice-mic--error');
      _micBtn.setAttribute('aria-label', 'Microphone error. Tap to retry.');
      _micBtn.setAttribute('aria-pressed', 'false');
      _setVoiceStatus('MIC ERROR');
    } else {
      /* IDLE */
      _micBtn.disabled = (_SpeechRecognitionCtor == null);
      _micBtn.setAttribute('aria-label', 'Start voice input');
      _micBtn.setAttribute('aria-pressed', 'false');
      _setVoiceStatus('');
    }
  }

  function _updateVoiceToggle() {
    if (!_voiceBtn) return;
    if (_voiceEnabled) {
      _voiceBtn.classList.add('snx-voice-toggle--on');
      _voiceBtn.setAttribute('aria-label', 'Voice response is ON. Tap to turn off.');
      _voiceBtn.title = 'Voice response: ON';
      /* Swap icon to speaker-on */
      _voiceBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true" focusable="false">' +
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
        '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>' +
        '<path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>' +
        '</svg>';
    } else {
      _voiceBtn.classList.remove('snx-voice-toggle--on');
      _voiceBtn.setAttribute('aria-label', 'Voice response is OFF. Tap to turn on.');
      _voiceBtn.title = 'Voice response: OFF';
      /* Muted speaker icon */
      _voiceBtn.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
        'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true" focusable="false">' +
        '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
        '<line x1="23" y1="9" x2="17" y2="15"/>' +
        '<line x1="17" y1="9" x2="23" y2="15"/>' +
        '</svg>';
    }
  }

  /* ─────────────────────────────────────────────────────────────
     CHARACTER CSS STATE CLASSES
     Applied to #grim-panel so the existing character can react.
     Uses lightweight CSS classes only — never rebuilds the character.
  ───────────────────────────────────────────────────────────────*/
  var _CHAR_STATES = ['snx-voice-idle','snx-voice-listening','snx-voice-thinking','snx-voice-speaking'];

  function _updateCharacterClass() {
    var panel = document.getElementById('grim-panel');
    if (!panel) return;
    _CHAR_STATES.forEach(function (c) { panel.classList.remove(c); });
    if (_state === STATE.LISTENING)   panel.classList.add('snx-voice-listening');
    else if (_state === STATE.PROCESSING) panel.classList.add('snx-voice-thinking');
    else if (_state === STATE.SPEAKING)   panel.classList.add('snx-voice-speaking');
    else                                   panel.classList.add('snx-voice-idle');
  }

  /* ─────────────────────────────────────────────────────────────
     MIC CLICK HANDLER
  ───────────────────────────────────────────────────────────────*/
  function _onMicClick() {
    if (_destroyed) return;
    if (!_SpeechRecognitionCtor) {
      _setState(STATE.MIC_UNSUP);
      _showVoiceFeedback(
        "Voice input isn't supported in this browser. You can still type to Shadow Reaper."
      );
      return;
    }

    /* If currently listening, stop */
    if (_state === STATE.LISTENING) {
      _stopListening();
      return;
    }

    /* If currently speaking, cancel speech and start listening */
    if (_state === STATE.SPEAKING) {
      _stopSpeaking();
    }

    /* If blocked, do not re-request permission */
    if (_state === STATE.MIC_BLOCKED) return;

    _startListening();
  }

  /* ─────────────────────────────────────────────────────────────
     SPEECH RECOGNITION  — START
  ───────────────────────────────────────────────────────────────*/
  function _startListening() {
    if (_destroyed) return;
    /* Abort any existing recognition instance first */
    _stopListening();

    var SR = _SpeechRecognitionCtor;
    if (!SR) {
      /* Checked again at call time in case the module was loaded before the
         browser API was available (should not normally happen). */
      _setState(STATE.MIC_UNSUP);
      _showVoiceFeedback(
        "Voice input isn't supported in this browser. You can still type to Shadow Reaper."
      );
      return;
    }
    var rec;
    try {
      rec = new SR();
    } catch (e) {
      console.warn('[SNXShadowVoice] SpeechRecognition construction failed:', e.message);
      _setState(STATE.MIC_ERROR);
      return;
    }

    rec.continuous    = false;   // single-utterance — no continuous stream
    rec.interimResults = false;  // we only want the final transcript
    rec.maxAlternatives = 1;
    rec.lang = _getRecognitionLang();

    rec.onstart = function () {
      if (_destroyed) { try { rec.abort(); } catch(_) {} return; }
      _setState(STATE.LISTENING);
    };

    rec.onresult = function (e) {
      if (_destroyed) return;
      _setState(STATE.PROCESSING);
      _recognition = null; // consumed

      var transcript = '';
      try {
        if (e.results && e.results.length > 0) {
          transcript = e.results[0][0].transcript || '';
        }
      } catch (_) {}

      transcript = transcript.trim();
      if (!transcript) {
        /* Empty or unusable — back to IDLE, let user try again */
        _setState(STATE.IDLE);
        _showVoiceFeedback("Didn't catch that — please try again or type your question.");
        return;
      }

      /* Show transcript in input field momentarily */
      var inp = document.getElementById('snx-ai-input');
      if (inp) {
        inp.value = transcript;
        /* Clear after short delay (ask() will clear it via send flow) */
        setTimeout(function () { if (inp) inp.value = ''; }, 200);
      }

      /* Route through the SAME ask pipeline as typed questions */
      _setState(STATE.IDLE);
      if (global.SNXShadowAI && typeof global.SNXShadowAI.ask === 'function') {
        global.SNXShadowAI.ask(transcript);
      }
    };

    rec.onerror = function (e) {
      if (_destroyed) return;
      _recognition = null;
      var err = (e && e.error) ? e.error : 'unknown';

      if (err === 'not-allowed' || err === 'permission-denied') {
        _setState(STATE.MIC_BLOCKED);
        _showVoiceFeedback('Microphone access is blocked. You can still type your question.');
        return;
      }
      if (err === 'no-speech') {
        _setState(STATE.IDLE);
        _showVoiceFeedback("No speech detected — please try again or type your question.");
        return;
      }
      /* Other errors: network, aborted, service-not-allowed, etc. */
      _setState(STATE.MIC_ERROR);
      console.warn('[SNXShadowVoice] Recognition error:', err);
    };

    rec.onend = function () {
      /* If we're still in LISTENING state when recognition ends without a
         result (e.g. user said nothing and browser timed out), reset to IDLE */
      if (!_destroyed && (_state === STATE.LISTENING)) {
        _setState(STATE.IDLE);
      }
      _recognition = null;
    };

    _recognition = rec;
    try {
      rec.start();
    } catch (e) {
      _recognition = null;
      /* Security error = permission denied in some browsers */
      if (e && e.name === 'SecurityError') {
        _setState(STATE.MIC_BLOCKED);
        _showVoiceFeedback('Microphone access is blocked. You can still type your question.');
      } else {
        _setState(STATE.MIC_ERROR);
        console.warn('[SNXShadowVoice] rec.start() failed:', e.message);
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     SPEECH RECOGNITION  — STOP
  ───────────────────────────────────────────────────────────────*/
  function _stopListening() {
    if (_recognition) {
      try { _recognition.stop(); } catch (_) {}
      try { _recognition.abort(); } catch (_) {}
      _recognition = null;
    }
    if (_state === STATE.LISTENING) {
      _setState(STATE.IDLE);
    }
  }

  /* ─────────────────────────────────────────────────────────────
     LANGUAGE
  ───────────────────────────────────────────────────────────────*/
  function _getRecognitionLang() {
    /* Respect document language if set, otherwise default to English */
    try {
      var lang = document.documentElement.lang;
      if (lang && /^[a-z]{2}/i.test(lang)) return lang;
    } catch (_) {}
    return 'en-US';
  }

  /* ─────────────────────────────────────────────────────────────
     VOICE RESPONSE (TTS)
  ───────────────────────────────────────────────────────────────*/
  function _toggleVoiceResponse() {
    _voiceEnabled = !_voiceEnabled;
    try { localStorage.setItem(PREF_KEY, _voiceEnabled ? '1' : '0'); } catch (_) {}
    if (!_voiceEnabled) {
      _stopSpeaking();
    }
    _updateVoiceToggle();
  }

  function _setVoiceEnabled(enabled) {
    _voiceEnabled = !!enabled;
    try { localStorage.setItem(PREF_KEY, _voiceEnabled ? '1' : '0'); } catch (_) {}
    if (!_voiceEnabled) _stopSpeaking();
    _updateVoiceToggle();
  }

  function _loadVoicePref() {
    try {
      var stored = localStorage.getItem(PREF_KEY);
      /* If no pref saved yet, default is OFF — conservative */
      _voiceEnabled = (stored === '1');
    } catch (_) {
      _voiceEnabled = false;
    }
  }

  /**
   * Speak a Shadow Reaper answer via speechSynthesis.
   * Called AFTER text is displayed — voice never replaces text.
   * Only speaks if _voiceEnabled is true.
   * Silently ignored if speechSynthesis is unsupported.
   *
   * @param {string} text — the answer text
   */
  function _speak(text) {
    if (_destroyed) return;
    if (!_voiceEnabled) return;
    if (!_speechSynthSupported) return;
    if (!text || !text.trim()) return;

    /* Do not speak: debug info, raw errors, tokens, large diagnostic dumps */
    var stripped = text.trim();
    if (stripped.length > 600) {
      /* Speak truncated version for very long answers */
      stripped = stripped.substring(0, 580) + '…';
    }

    /* Cancel any ongoing speech before starting new */
    _stopSpeaking();

    var utter;
    try {
      utter = new global.SpeechSynthesisUtterance(stripped);
    } catch (e) {
      return;
    }

    utter.lang = _getRecognitionLang();
    utter.rate  = 0.95;  // slightly slower for clarity
    utter.pitch = 0.9;   // slightly lower — more Shadow Reaper
    utter.volume = 1.0;

    utter.onstart = function () {
      if (_destroyed) {
        try { global.speechSynthesis.cancel(); } catch (_) {}
        return;
      }
      _setState(STATE.SPEAKING);
    };

    utter.onend = function () {
      if (_state === STATE.SPEAKING) _setState(STATE.IDLE);
    };

    utter.onerror = function () {
      if (_state === STATE.SPEAKING) _setState(STATE.IDLE);
    };

    try {
      global.speechSynthesis.speak(utter);
    } catch (_) {
      /* Speech synthesis failed — text answer remains visible, no crash */
      if (_state === STATE.SPEAKING) _setState(STATE.IDLE);
    }
  }

  function _stopSpeaking() {
    if (!_speechSynthSupported) return;
    try { global.speechSynthesis.cancel(); } catch (_) {}
    if (_state === STATE.SPEAKING) _setState(STATE.IDLE);
  }

  /* ─────────────────────────────────────────────────────────────
     IN-CONVERSATION VOICE FEEDBACK
     Appends a small info line inside the conversation — not a
     bubble from Shadow Reaper, just a voice-state note.
  ───────────────────────────────────────────────────────────────*/
  function _showVoiceFeedback(msg) {
    var area = document.getElementById('snx-ai-conversation');
    if (!area) return;
    var note = document.createElement('div');
    note.className = 'snx-voice-note';
    note.textContent = msg;
    area.appendChild(note);
    area.scrollTop = area.scrollHeight;
    /* Auto-remove after 6 s */
    setTimeout(function () {
      if (note.parentNode) note.parentNode.removeChild(note);
    }, 6000);
  }

  /* ─────────────────────────────────────────────────────────────
     PAGE VISIBILITY — stop listening when tab hidden
  ───────────────────────────────────────────────────────────────*/
  function _onVisibilityChange() {
    if (document.hidden) {
      if (_state === STATE.LISTENING) _stopListening();
      if (_state === STATE.SPEAKING)  _stopSpeaking();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     PANEL CLOSE HOOK
     Called by SNXShadowAI when the panel closes.
  ───────────────────────────────────────────────────────────────*/
  function _onPanelClose() {
    _stopListening();
    _stopSpeaking();
    _setState(STATE.IDLE);
  }

  /* ─────────────────────────────────────────────────────────────
     INIT  — idempotent, lightweight
  ───────────────────────────────────────────────────────────────*/
  function _init() {
    if (_initialized || _destroyed) return;
    _initialized = true;

    _loadVoicePref();

    _voiceInputSupported = !!_SpeechRecognitionCtor;

    /* Inject controls only if the AI UI is already in the DOM */
    if (document.getElementById('snx-ai-input-row')) {
      _injectControls();
    }

    /* Page visibility listener — stop mic on tab hide */
    document.addEventListener('visibilitychange', _onVisibilityChange);

    console.log('[SNXShadowVoice] Initialized. Build: ' + BUILD_ID +
      ' | STT: ' + (_voiceInputSupported ? 'SUPPORTED' : 'UNSUPPORTED') +
      ' | TTS: ' + (_speechSynthSupported ? 'SUPPORTED' : 'UNSUPPORTED') +
      ' | VoiceResponse: ' + (_voiceEnabled ? 'ON' : 'OFF'));
  }

  /* ─────────────────────────────────────────────────────────────
     DESTROY  — safe teardown
  ───────────────────────────────────────────────────────────────*/
  function _destroy() {
    _destroyed = true;
    _stopListening();
    _stopSpeaking();

    document.removeEventListener('visibilitychange', _onVisibilityChange);

    /* Remove injected UI elements */
    ['snx-voice-mic', 'snx-voice-toggle', 'snx-voice-status'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });

    /* Remove character state classes */
    var panel = document.getElementById('grim-panel');
    if (panel) {
      _CHAR_STATES.forEach(function (c) { panel.classList.remove(c); });
    }

    _micBtn      = null;
    _voiceBtn    = null;
    _recognition = null;
    _initialized = false;
    _destroyed   = false; // allow re-init after destroy
    _state       = STATE.IDLE;

    console.log('[SNXShadowVoice] Destroyed.');
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API  — window.SNXShadowVoice
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowVoice = {
    /** Initialize the voice module (idempotent). */
    init: _init,

    /** Start listening. Only called after explicit user action. */
    startListening: _startListening,

    /** Stop listening. */
    stopListening: _stopListening,

    /**
     * Speak a text response via speechSynthesis.
     * Called by Shadow Reaper after displaying text.
     * Silently no-ops if voice response is OFF or unsupported.
     * @param {string} text
     */
    speak: _speak,

    /** Cancel current speech synthesis. */
    stopSpeaking: _stopSpeaking,

    /**
     * Enable or disable voice response (TTS).
     * @param {boolean} enabled
     */
    setVoiceEnabled: _setVoiceEnabled,

    /** Returns true if TTS voice response is currently on. */
    isVoiceEnabled: function () { return _voiceEnabled; },

    /**
     * Returns current voice state string.
     * @returns {string}
     */
    getState: function () { return _state; },

    /**
     * Call when Shadow Reaper panel is closed.
     * Stops mic and TTS.
     */
    onPanelClose: _onPanelClose,

    /**
     * Inject voice controls into the existing input row.
     * Safe to call after SNXShadowAI.init() — idempotent.
     */
    injectControls: _injectControls,

    /** Full teardown. */
    destroy: _destroy,

    /** Build identifier. */
    build: BUILD_ID,

    /** True if browser SpeechRecognition is supported. */
    inputSupported: function () { return _voiceInputSupported; },

    /** True if browser speechSynthesis is supported. */
    outputSupported: function () { return _speechSynthSupported; },

    /** Exposed state constants for external reference. */
    STATE: STATE,

    /**
     * Stage 4B: Register a callback for voice state changes.
     * Called after every state transition with the new state string.
     * @param {function} fn
     */
    onStateChange: function (fn) {
      if (typeof fn === 'function' && _stateListeners.indexOf(fn) === -1) {
        _stateListeners.push(fn);
      }
    },

    /**
     * Stage 4B: Remove a previously registered state-change listener.
     * @param {function} fn
     */
    removeStateChangeListener: function (fn) {
      var idx = _stateListeners.indexOf(fn);
      if (idx !== -1) _stateListeners.splice(idx, 1);
    }
  };

})(window);
