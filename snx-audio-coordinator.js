/**
 * snx-audio-coordinator.js — Shadow Nexus Audio Coordinator
 *
 * Prevents competing audio sources from playing simultaneously.
 *
 * Sources (by priority, lowest wins when exclusive):
 *   welcomeMusic   — cinematic intro (stops after Enter)
 *   radio          — 24-hour cloud radio
 *   musicHub       — profile music hub player
 *   miniPlayer     — persistent mini player (cross-page)
 *   profileSound   — profile soundtrack (visitor-triggered)
 *   voiceMessage   — voice message playback
 *   videoPlayer    — in-feed video with audio
 *   liveStream     — live viewing
 *
 * Rules:
 *   - welcomeMusic stops on Enter (always)
 *   - Only ONE non-radio source plays at a time
 *   - radio can persist when intentionally selected
 *   - voice message preview pauses miniPlayer temporarily
 */

'use strict';

(function () {

  var _activeSources = {};
  var _paused  = {};   // paused-by-coordinator tracks
  var _cbs = {};

  window.SNXAudioCoordinator = {
    request:        request,
    release:        release,
    isActive:       isActive,
    pauseAll:       pauseAll,
    on:             on
  };

  /* ════════════════════════════════════════════════
     request(source) — called by a source before it starts
  ════════════════════════════════════════════════ */
  function request(source) {
    // welcomeMusic is always killed first
    if (source !== 'welcomeMusic') {
      _kill('welcomeMusic');
    }

    // voiceMessage just ducks miniPlayer temporarily
    if (source === 'voiceMessage') {
      _duck('miniPlayer');
      _activeSources[source] = true;
      return;
    }

    // radioPlayer can coexist with liveStream but not others
    if (source === 'radio') {
      // radio requested: pause musicHub / miniPlayer / profileSound
      ['musicHub','miniPlayer','profileSound','videoPlayer'].forEach(_pause);
      _activeSources[source] = true;
      return;
    }

    // liveStream takes priority — pause everything else
    if (source === 'liveStream') {
      ['radio','musicHub','miniPlayer','profileSound','videoPlayer'].forEach(_pause);
      _activeSources[source] = true;
      return;
    }

    // miniPlayer / musicHub / profileSound: pause each other
    if (source === 'miniPlayer' || source === 'musicHub' || source === 'profileSound') {
      var others = ['miniPlayer','musicHub','profileSound','videoPlayer'].filter(function(s){ return s !== source; });
      others.forEach(_pause);
    }

    // videoPlayer: pause miniPlayer if playing
    if (source === 'videoPlayer') {
      _pause('miniPlayer');
    }

    _activeSources[source] = true;
    _emit('request', source);
  }

  /* ════════════════════════════════════════════════
     release(source) — called when a source stops
  ════════════════════════════════════════════════ */
  function release(source) {
    delete _activeSources[source];

    // Resume miniPlayer after voice message ends
    if (source === 'voiceMessage') {
      _unduck('miniPlayer');
    }

    _emit('release', source);
  }

  function isActive(source) {
    return !!_activeSources[source];
  }

  function pauseAll() {
    Object.keys(_activeSources).forEach(function(s) { _pause(s); });
  }

  /* ── Internal helpers ── */
  function _kill(source) {
    delete _activeSources[source];
    _emit('kill', source);
  }

  function _pause(source) {
    // Emit pause event so the source can handle it
    if (_activeSources[source]) {
      _emit('pause', source);
    }
  }

  function _duck(source) {
    _emit('duck', source);
  }

  function _unduck(source) {
    _emit('unduck', source);
  }

  function on(event, cb) {
    if (!_cbs[event]) _cbs[event] = [];
    _cbs[event].push(cb);
  }

  function _emit(event, source) {
    (_cbs[event] || []).forEach(function(cb) { try { cb(source); } catch(_) {} });
    try {
      document.dispatchEvent(new CustomEvent('snxAudio:' + event, { detail: source }));
    } catch(_) {}
  }

})();
