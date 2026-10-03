/**
 * shadow-reaper-v2/voice/voice-engine.js
 * Shadow Reaper V2 — Voice Engine
 *
 * Build: SR-V2-VOICE-2
 *
 * Exposes: window.SRVoice
 *
 * ARCHITECTURE:
 *   - Uses browser Web Speech API (SpeechRecognition + SpeechSynthesis).
 *   - Recognized text is passed through the SAME Shadow Reaper V2 pipeline.
 *   - There is NO separate voice brain.
 *   - Microphone must be EXPLICITLY activated by the user.
 *   - Raw audio is NEVER stored.
 *   - Voice must NOT interfere with SNS Live, DJ, Cohost, or camera.
 *   - Resources are cleaned up when voice is stopped/destroyed.
 *
 * V2 ADDITIONS:
 *   - Male / Female voice selection (presentation only — no intelligence change)
 *   - Voice preference persisted to localStorage / SRWakeName prefs
 *   - Conversation session integration (SRConvSession)
 *   - Interrupt support: user speech while TTS is playing cancels TTS
 *   - Echo protection: Shadow's own TTS is not re-processed as input
 *   - Improved speech-end handling (interimResults + soundend)
 *   - graceful STT error recovery
 *
 * STATES: IDLE | LISTENING | PROCESSING | SPEAKING | UNSUPPORTED | ERROR
 *
 * ZERO EXTERNAL AI CALLS.
 * ZERO POLLING. ZERO RAF. ZERO setInterval.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-V2-VOICE-2';
  var VOICE_ENABLED_KEY  = 'srVoiceEnabled';
  var TTS_ENABLED_KEY    = 'srTTSEnabled';
  var VOICE_GENDER_KEY   = 'srVoiceGender';   // 'male' | 'female'

  // ── Helpers ──────────────────────────────────────────────────────────────
  function _wakeModule()    { return global.SRWakeName    || null; }
  function _sessionModule() { return global.SRConvSession || null; }

  /* ─────────────────────────────────────────────────────────────
     STATE
  ───────────────────────────────────────────────────────────────*/
  var STATE = {
    IDLE:        'IDLE',
    LISTENING:   'LISTENING',
    PROCESSING:  'PROCESSING',
    SPEAKING:    'SPEAKING',
    UNSUPPORTED: 'UNSUPPORTED',
    ERROR:       'ERROR',
  };

  var _state         = STATE.IDLE;
  var _recognition   = null;
  var _synthesis     = global.speechSynthesis || null;
  var _onResultCb    = null;   // called with (text, normalized)
  var _onStateCb     = null;   // called when state changes
  var _onErrorCb     = null;   // called on error
  var _voiceEnabled  = _readPref(VOICE_ENABLED_KEY, true);
  var _ttsEnabled    = _readPref(TTS_ENABLED_KEY, true);
  var _voiceGender   = _readStringPref(VOICE_GENDER_KEY, 'female');  // default female
  var _isSupported   = !!(
    (global.SpeechRecognition || global.webkitSpeechRecognition) &&
    global.speechSynthesis
  );

  // Cached browser voices for Male/Female selection
  var _cachedVoices  = [];
  var _voicesCached  = false;

  function _readPref(key, defaultVal) {
    try {
      var v = global.localStorage && global.localStorage.getItem(key);
      if (v === null || v === undefined) return defaultVal;
      return v !== 'false';
    } catch (_) { return defaultVal; }
  }

  function _readStringPref(key, defaultVal) {
    try {
      var v = global.localStorage && global.localStorage.getItem(key);
      return (v !== null && v !== undefined) ? v : defaultVal;
    } catch (_) { return defaultVal; }
  }

  function _savePref(key, val) {
    try {
      if (global.localStorage) global.localStorage.setItem(key, val ? 'true' : 'false');
    } catch (_) {}
  }

  function _saveStringPref(key, val) {
    try {
      if (global.localStorage) global.localStorage.setItem(key, String(val));
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     STATE MANAGEMENT
  ───────────────────────────────────────────────────────────────*/
  function _setState(newState) {
    _state = newState;
    if (typeof _onStateCb === 'function') {
      try { _onStateCb(newState); } catch (_) {}
    }
  }

  /* ─────────────────────────────────────────────────────────────
     VOICE GENDER SELECTION
     Male / Female only. Affects TTS voice selection only.
     Does NOT change intelligence, personality, memory, or history.
  ───────────────────────────────────────────────────────────────*/

  /**
   * setVoiceGender(gender)
   * gender: 'male' | 'female'
   * Persists to localStorage and SRWakeName prefs if available.
   * Voice change NEVER resets the Shadow Reaper brain.
   */
  function setVoiceGender(gender) {
    var normalized = (typeof gender === 'string') ? gender.toLowerCase().trim() : 'female';
    if (normalized !== 'male' && normalized !== 'female') normalized = 'female';
    _voiceGender = normalized;
    _saveStringPref(VOICE_GENDER_KEY, normalized);

    // Also persist via SRWakeName if it supports voice prefs
    var wm = _wakeModule();
    if (wm && typeof wm.save === 'function') {
      wm.save({ voiceGender: normalized }, function () {});
    }
  }

  function getVoiceGender() {
    return _voiceGender;
  }

  /**
   * _selectVoice(utterance)
   * Picks the best available browser voice for the selected gender.
   * Falls back gracefully if no gender-specific voice is available.
   */
  function _selectVoice(utterance) {
    if (!_synthesis) return;

    // Cache voices on first use
    if (!_voicesCached && _synthesis.getVoices) {
      _cachedVoices = _synthesis.getVoices() || [];
      _voicesCached = _cachedVoices.length > 0;
    }

    if (!_cachedVoices.length) return;  // No voices yet — browser will pick default

    var isMale = (_voiceGender === 'male');

    // Scoring function: prefer en-US, prefer gender-matching name keywords
    var maleKeywords   = ['male', 'man', 'guy', 'david', 'mark', 'daniel', 'alex', 'tom', 'james', 'john', 'george', 'fred', 'bruce'];
    var femaleKeywords = ['female', 'woman', 'girl', 'samantha', 'karen', 'lisa', 'victoria', 'susan', 'kate', 'emma', 'zira', 'google us english female', 'fiona', 'alice', 'amelie'];

    var keywords = isMale ? maleKeywords : femaleKeywords;

    var best = null;
    var bestScore = -1;

    _cachedVoices.forEach(function (voice) {
      var score = 0;
      var nameLow = (voice.name || '').toLowerCase();
      var langLow = (voice.lang || '').toLowerCase();

      // English preference
      if (langLow.indexOf('en-us') !== -1) score += 3;
      else if (langLow.indexOf('en') !== -1) score += 1;

      // Gender keyword match
      var hasGenderKeyword = keywords.some(function (kw) {
        return nameLow.indexOf(kw) !== -1;
      });
      if (hasGenderKeyword) score += 10;

      // Penalise obviously opposite gender
      var oppositeKw = isMale ? femaleKeywords : maleKeywords;
      var hasOppositeKeyword = oppositeKw.some(function (kw) {
        return nameLow.indexOf(kw) !== -1;
      });
      if (hasOppositeKeyword) score -= 8;

      // Local voices preferred over remote
      if (voice.localService) score += 2;

      if (score > bestScore) {
        bestScore = score;
        best = voice;
      }
    });

    if (best) {
      utterance.voice = best;
      // Set pitch/rate based on gender for naturalness
      if (_voiceGender === 'male') {
        utterance.rate  = 0.92;
        utterance.pitch = 0.75;
      } else {
        utterance.rate  = 0.95;
        utterance.pitch = 1.05;
      }
    }
  }

  /* ─────────────────────────────────────────────────────────────
     START LISTENING
     Explicit user activation only — never called automatically.
  ───────────────────────────────────────────────────────────────*/
  function startListening(onResult, onError) {
    if (!_isSupported) {
      _setState(STATE.UNSUPPORTED);
      var msg = 'Speech recognition is not supported in this browser.';
      if (typeof onError === 'function') onError(msg);
      return false;
    }

    if (!_voiceEnabled) {
      var disabled = 'Voice is currently disabled.';
      if (typeof onError === 'function') onError(disabled);
      return false;
    }

    if (_state === STATE.LISTENING) {
      return true; // Already listening
    }

    // If currently speaking in a session, note an interrupt attempt
    var session = _sessionModule();
    if (session && _state === STATE.SPEAKING) {
      session.onUserSpeechStart();
    }

    try {
      var SpeechRec = global.SpeechRecognition || global.webkitSpeechRecognition;
      _recognition = new SpeechRec();
      _recognition.lang           = 'en-US';
      _recognition.continuous     = false;
      _recognition.interimResults = false;
      _recognition.maxAlternatives = 1;

      _onResultCb = onResult;
      _onErrorCb  = onError;

      _recognition.onstart = function () {
        _setState(STATE.LISTENING);
      };

      _recognition.onspeechstart = function () {
        // User started speaking — notify session for interrupt detection
        if (session) session.onUserSpeechStart();
      };

      _recognition.onresult = function (event) {
        _setState(STATE.PROCESSING);
        try {
          var rawTranscript = event.results[0][0].transcript;

          // ── Session echo/end-command check ────────────────────────────
          if (session) {
            var check = session.onSpeechResult(rawTranscript);
            if (!check.process) {
              // Echo or session-end — do not pass to intent pipeline
              _cleanupRecognition();
              _setState(STATE.IDLE);
              return;
            }
          }

          // ── Route through SRWakeName pipeline ─────────────────────────
          var wm = _wakeModule();
          if (wm && typeof wm.processTranscript === 'function') {
            wm.processTranscript(rawTranscript, function (normalized) {
              if (typeof _onResultCb === 'function') {
                _onResultCb(normalized.command, normalized);
              }
            });
          } else {
            if (typeof _onResultCb === 'function') {
              _onResultCb(rawTranscript);
            }
          }
        } catch (e) {
          _setState(STATE.ERROR);
          if (typeof _onErrorCb === 'function') _onErrorCb('Voice recognition error: ' + (e.message || 'unknown'));
        }
        _cleanupRecognition();
        _setState(STATE.IDLE);
      };

      _recognition.onerror = function (event) {
        var errCode = event.error || 'unknown';

        // Notify session for graceful handling
        if (session) session.onRecognitionError(errCode);

        // no-speech and aborted are normal — don't fire error callback
        if (errCode === 'no-speech' || errCode === 'aborted') {
          _cleanupRecognition();
          _setState(STATE.IDLE);
          return;
        }

        var msg = 'Voice error: ' + errCode;
        _setState(STATE.ERROR);
        if (typeof _onErrorCb === 'function') _onErrorCb(msg);
        _cleanupRecognition();
        _setState(STATE.IDLE);
      };

      _recognition.onend = function () {
        if (_state === STATE.LISTENING) {
          _setState(STATE.IDLE);
        }
        _cleanupRecognition();
      };

      _recognition.start();
      return true;

    } catch (e) {
      _setState(STATE.ERROR);
      if (typeof onError === 'function') onError('Failed to start speech recognition: ' + (e.message || 'unknown'));
      return false;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     STOP LISTENING
  ───────────────────────────────────────────────────────────────*/
  function stopListening() {
    if (_recognition) {
      try { _recognition.stop(); } catch (_) {}
    }
    _cleanupRecognition();
    _setState(STATE.IDLE);
  }

  /* ─────────────────────────────────────────────────────────────
     SPEAK (Text-to-Speech)
     Optional — only if TTS is enabled and supported.
     NEVER stores raw audio. Only uses synthesis API.
     Integrates with SRConvSession for interrupt handling.
  ───────────────────────────────────────────────────────────────*/
  function speak(text, onEnd) {
    if (!_ttsEnabled || !_synthesis) {
      var session0 = _sessionModule();
      if (session0) session0.onSpeakingError();
      if (typeof onEnd === 'function') onEnd();
      return;
    }

    try {
      // Cancel any current speech (handles mid-session re-speaks)
      _synthesis.cancel();

      var utterance = new global.SpeechSynthesisUtterance(text);
      utterance.volume = 1.0;

      // Apply gender-specific voice selection
      _selectVoice(utterance);

      // Notify session that TTS is starting
      var session = _sessionModule();
      if (session) session.onSpeakingStart(text);

      utterance.onstart = function () {
        _setState(STATE.SPEAKING);
      };

      utterance.onend = function () {
        _setState(STATE.IDLE);
        if (session) session.onSpeakingEnd();
        if (typeof onEnd === 'function') onEnd();
      };

      utterance.onerror = function () {
        _setState(STATE.IDLE);
        if (session) session.onSpeakingError();
        if (typeof onEnd === 'function') onEnd();
      };

      // Voices may not be loaded yet on first call — reload cache
      if (!_voicesCached && _synthesis.getVoices) {
        _cachedVoices = _synthesis.getVoices() || [];
        _voicesCached = _cachedVoices.length > 0;
        if (_voicesCached) _selectVoice(utterance); // re-apply now that voices loaded
      }

      _synthesis.speak(utterance);

    } catch (e) {
      _setState(STATE.IDLE);
      var sessionErr = _sessionModule();
      if (sessionErr) sessionErr.onSpeakingError();
      if (typeof onEnd === 'function') onEnd();
    }
  }

  /* ─────────────────────────────────────────────────────────────
     STOP SPEAKING
     Cancels current TTS. Can be called during an interrupt.
  ───────────────────────────────────────────────────────────────*/
  function stopSpeaking() {
    if (_synthesis) {
      try { _synthesis.cancel(); } catch (_) {}
    }
    _setState(STATE.IDLE);
  }

  /* ─────────────────────────────────────────────────────────────
     CLEANUP
  ───────────────────────────────────────────────────────────────*/
  function _cleanupRecognition() {
    if (_recognition) {
      try { _recognition.onstart        = null; } catch (_) {}
      try { _recognition.onresult       = null; } catch (_) {}
      try { _recognition.onerror        = null; } catch (_) {}
      try { _recognition.onend          = null; } catch (_) {}
      try { _recognition.onspeechstart  = null; } catch (_) {}
      _recognition = null;
    }
  }

  function destroy() {
    stopListening();
    stopSpeaking();
    _onResultCb  = null;
    _onStateCb   = null;
    _onErrorCb   = null;
    _voicesCached = false;
    _cachedVoices = [];
    _setState(STATE.IDLE);
  }

  /* ─────────────────────────────────────────────────────────────
     SETTINGS
  ───────────────────────────────────────────────────────────────*/
  function setVoiceEnabled(val) {
    _voiceEnabled = !!val;
    _savePref(VOICE_ENABLED_KEY, _voiceEnabled);
    if (!_voiceEnabled) stopListening();
  }

  function setTTSEnabled(val) {
    _ttsEnabled = !!val;
    _savePref(TTS_ENABLED_KEY, _ttsEnabled);
    if (!_ttsEnabled) stopSpeaking();
  }

  function isVoiceEnabled()    { return _voiceEnabled; }
  function isTTSEnabled()      { return _ttsEnabled; }
  function isSupported()       { return _isSupported; }
  function getState()          { return _state; }

  function onStateChange(cb)   { _onStateCb = cb; }

  function getStatus() {
    var wm = _wakeModule();
    return {
      supported:    _isSupported,
      state:        _state,
      voiceEnabled: _voiceEnabled,
      ttsEnabled:   _ttsEnabled,
      voiceGender:  _voiceGender,
      isListening:  _state === STATE.LISTENING,
      isSpeaking:   _state === STATE.SPEAKING,
      // Wake Name status (from SRWakeName if loaded)
      wakeName:      wm ? wm.getWakeName()     : null,
      wakeListening: wm ? wm.isWakeListening()  : null,
      wakeAvailable: !!wm,
      // Session status
      sessionActive: !!(global.SRConvSession && global.SRConvSession.isActive()),
    };
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.SRVoice
  ───────────────────────────────────────────────────────────────*/
  global.SRVoice = {
    build:           BUILD_ID,
    STATE:           STATE,
    startListening:  startListening,
    stopListening:   stopListening,
    speak:           speak,
    stopSpeaking:    stopSpeaking,
    destroy:         destroy,
    setVoiceEnabled: setVoiceEnabled,
    setTTSEnabled:   setTTSEnabled,
    setVoiceGender:  setVoiceGender,
    getVoiceGender:  getVoiceGender,
    isVoiceEnabled:  isVoiceEnabled,
    isTTSEnabled:    isTTSEnabled,
    isSupported:     isSupported,
    getState:        getState,
    getStatus:       getStatus,
    onStateChange:   onStateChange,
    // Wake Name convenience accessors (delegates to SRWakeName)
    getWakeName:     function () { var wm = _wakeModule(); return wm ? wm.getWakeName() : null; },
    isWakeListening: function () { var wm = _wakeModule(); return wm ? wm.isWakeListening() : false; },
  };

})(typeof window !== 'undefined' ? window : global);
