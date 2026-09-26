/**
 * snx-mini-player.js — Shadow Nexus Social Persistent Mini Player
 *
 * ONE global audio player that persists across page navigation.
 * Uses a single <audio> element. Pages reference this via window.SNXPlayer.
 *
 * API:
 *   SNXPlayer.play(track)    — track: { url, title, artist, artUrl, id }
 *   SNXPlayer.pause()
 *   SNXPlayer.resume()
 *   SNXPlayer.stop()
 *   SNXPlayer.next()         — if queue set
 *   SNXPlayer.setQueue(arr, idx)
 *   SNXPlayer.show()
 *   SNXPlayer.hide()
 *   SNXPlayer.isPlaying()
 *   SNXPlayer.current        — current track object
 *   SNXPlayer.on(event, cb)  — 'play','pause','end','trackChange'
 *
 * Coordinates with SNXAudioCoordinator to prevent competing audio.
 */

'use strict';

(function () {

  /* ── State ── */
  var _audio    = null;
  var _current  = null;
  var _queue    = [];
  var _queueIdx = 0;
  var _visible  = false;
  var _cbs      = {};
  var _progRAF  = null;
  var _el       = null;  // mini player DOM element

  /* ── Expose API ── */
  window.SNXPlayer = {
    play:       play,
    pause:      pause,
    resume:     resume,
    stop:       stop,
    next:       next,
    prev:       prev,
    setQueue:   setQueue,
    show:       show,
    hide:       hide,
    isPlaying:  isPlaying,
    on:         on,
    off:        off,
    get current() { return _current; },
    get queue()   { return _queue; }
  };

  /* ════════════════════════════════════════════════
     DOM BUILD — creates the persistent mini-player
  ════════════════════════════════════════════════ */
  function _buildDOM() {
    if (document.getElementById('snxMiniPlayer')) return; // already built

    var div = document.createElement('div');
    div.id = 'snxMiniPlayer';
    div.innerHTML =
      '<div class="snxmp-inner">' +
        '<div class="snxmp-art" id="snxmpArt"></div>' +
        '<div class="snxmp-info">' +
          '<div class="snxmp-title" id="snxmpTitle">—</div>' +
          '<div class="snxmp-artist" id="snxmpArtist">—</div>' +
        '</div>' +
        '<div class="snxmp-controls">' +
          '<button class="snxmp-btn" id="snxmpPrev" aria-label="Previous" onclick="SNXPlayer.prev()">⏮</button>' +
          '<button class="snxmp-btn snxmp-play" id="snxmpPlay" aria-label="Play/Pause" onclick="SNXPlayer.togglePlay()">▶</button>' +
          '<button class="snxmp-btn" id="snxmpNext" aria-label="Next" onclick="SNXPlayer.next()">⏭</button>' +
        '</div>' +
        '<div class="snxmp-progress-wrap">' +
          '<div class="snxmp-progress-bar" id="snxmpBar"><div class="snxmp-progress-fill" id="snxmpFill"></div></div>' +
          '<div class="snxmp-time" id="snxmpTime">0:00</div>' +
        '</div>' +
        '<button class="snxmp-close" id="snxmpClose" aria-label="Close player" onclick="SNXPlayer.stop()">✕</button>' +
      '</div>';
    document.body.appendChild(div);
    _el = div;

    // Progress bar click seek
    var bar = document.getElementById('snxmpBar');
    if (bar) {
      bar.addEventListener('click', function(e) {
        if (!_audio || !_audio.duration) return;
        var rect = bar.getBoundingClientRect();
        var pct  = (e.clientX - rect.left) / rect.width;
        _audio.currentTime = pct * _audio.duration;
      });
    }

    // Expose togglePlay
    window.SNXPlayer.togglePlay = function() {
      if (isPlaying()) pause(); else resume();
    };
  }

  /* ════════════════════════════════════════════════
     AUDIO ENGINE
  ════════════════════════════════════════════════ */
  function _ensureAudio() {
    if (_audio) return;
    _audio = new Audio();
    _audio.preload = 'none';

    _audio.addEventListener('play',   function() { _updateBtn(true);  _emit('play',  _current); _startProgress(); });
    _audio.addEventListener('pause',  function() { _updateBtn(false); _emit('pause', _current); _stopProgress();  });
    _audio.addEventListener('ended',  function() { _emit('end', _current); _autoNext(); });
    _audio.addEventListener('error',  function() { console.warn('[SNXPlayer] audio error', _audio.error); });
    _audio.addEventListener('loadedmetadata', function() { _updateProgress(); });
  }

  /* ════════════════════════════════════════════════
     PUBLIC: play
  ════════════════════════════════════════════════ */
  function play(track) {
    if (!track || !track.url) return;

    // Ask coordinator to yield other audio
    if (window.SNXAudioCoordinator) {
      window.SNXAudioCoordinator.request('miniPlayer');
    }

    _buildDOM();
    _ensureAudio();

    // Stop if same track already playing (toggle)
    if (_current && _current.id && _current.id === track.id && !_audio.paused) {
      pause(); return;
    }

    _current = track;
    _audio.src = track.url;
    _audio.load();
    _audio.play().catch(function(e) {
      console.warn('[SNXPlayer] play failed:', e);
    });

    _updateInfo();
    show();
    _emit('trackChange', track);
  }

  function pause() {
    if (_audio) _audio.pause();
  }

  function resume() {
    if (!_audio) return;
    if (_audio.src) {
      _audio.play().catch(function(){});
    }
  }

  function stop() {
    if (_audio) { _audio.pause(); _audio.src = ''; }
    _current = null;
    _stopProgress();
    hide();
    _emit('stop', null);
  }

  function next() {
    if (!_queue.length) return;
    _queueIdx = (_queueIdx + 1) % _queue.length;
    play(_queue[_queueIdx]);
  }

  function prev() {
    if (!_queue.length) return;
    _queueIdx = (_queueIdx - 1 + _queue.length) % _queue.length;
    play(_queue[_queueIdx]);
  }

  function setQueue(arr, startIdx) {
    _queue    = Array.isArray(arr) ? arr : [];
    _queueIdx = typeof startIdx === 'number' ? startIdx : 0;
  }

  function isPlaying() {
    return _audio && !_audio.paused && !_audio.ended;
  }

  function show() {
    _buildDOM();
    if (_el) _el.classList.add('snxmp-visible');
    _visible = true;
  }

  function hide() {
    if (_el) _el.classList.remove('snxmp-visible');
    _visible = false;
  }

  /* ── Event emitter ── */
  function on(event, cb) {
    if (!_cbs[event]) _cbs[event] = [];
    _cbs[event].push(cb);
  }

  function off(event, cb) {
    if (!_cbs[event]) return;
    _cbs[event] = _cbs[event].filter(function(f) { return f !== cb; });
  }

  function _emit(event, data) {
    (_cbs[event] || []).forEach(function(cb) { try { cb(data); } catch(_) {} });
    try { document.dispatchEvent(new CustomEvent('snxPlayer:' + event, { detail: data })); } catch(_) {}
  }

  /* ── DOM helpers ── */
  function _updateInfo() {
    if (!_current) return;
    var t = document.getElementById('snxmpTitle');
    var a = document.getElementById('snxmpArtist');
    var art = document.getElementById('snxmpArt');
    if (t) t.textContent = _current.title || 'Unknown';
    if (a) a.textContent = _current.artist || '';
    if (art) {
      if (_current.artUrl) {
        art.style.backgroundImage = 'url(' + _current.artUrl + ')';
        art.textContent = '';
      } else {
        art.style.backgroundImage = '';
        art.textContent = '🎵';
      }
    }
  }

  function _updateBtn(playing) {
    var btn = document.getElementById('snxmpPlay');
    if (btn) btn.textContent = playing ? '⏸' : '▶';
  }

  function _startProgress() {
    _stopProgress();
    function _tick() {
      _updateProgress();
      _progRAF = requestAnimationFrame(_tick);
    }
    _progRAF = requestAnimationFrame(_tick);
  }

  function _stopProgress() {
    if (_progRAF) { cancelAnimationFrame(_progRAF); _progRAF = null; }
  }

  function _updateProgress() {
    if (!_audio) return;
    var fill = document.getElementById('snxmpFill');
    var time = document.getElementById('snxmpTime');
    var dur  = _audio.duration || 0;
    var cur  = _audio.currentTime || 0;
    if (fill) fill.style.width = (dur ? (cur / dur * 100) : 0) + '%';
    if (time) time.textContent = _fmtTime(cur) + (dur ? ' / ' + _fmtTime(dur) : '');
  }

  function _autoNext() {
    if (_queue.length > 1) next();
  }

  function _fmtTime(s) {
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  /* ════════════════════════════════════════════════
     INIT — build DOM when ready
  ════════════════════════════════════════════════ */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _buildDOM);
  } else {
    _buildDOM();
  }

})();
