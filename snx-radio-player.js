/**
 * Shadow Nexus Radio — snx-radio-player.js
 * Version: 3.0.0  (Stage 3 — Real Radio Station Features)
 *
 * Radio Player UI component — full redesign.
 * Renders the listener-facing player: Now Playing, Up Next, Recently Played,
 * Program info, and listener controls.
 *
 * Usage:
 *   SNXRadioPlayer.mount(document.getElementById('myContainer'));
 *   SNXRadioPlayer.unmount();
 *
 * Dependencies:
 *   snx-radio.css  — must be loaded first
 *   snx-radio.js   — window.SNXRadio must exist
 */

'use strict';

(function () {

const PLAYER_VERSION = '3.0.0';

let _container = null;
let _el        = null;
let _mounted   = false;
let _tickTimer = null;
let _eqTimer   = null;
let _paused    = false;
let _muted     = false;
let _lastVol   = 0.9;
let _isOnAir   = false;

// DOM element cache
const E = {};

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */

window.SNXRadioPlayer = {
  mount,
  unmount,
  get isMounted() { return _mounted; },
  get version()   { return PLAYER_VERSION; },
};

/* ══════════════════════════════════════════════════════════════
   MOUNT
══════════════════════════════════════════════════════════════ */

function mount(container) {
  if (_mounted) unmount();
  if (!container) { console.warn('[SNX-RP] mount: no container'); return; }
  _container = container;
  _buildDOM();
  _bindEvents();
  _initRadio();
  _mounted = true;
  console.log('[SNX-RP] Player mounted — version', PLAYER_VERSION);
}

/* ══════════════════════════════════════════════════════════════
   UNMOUNT
══════════════════════════════════════════════════════════════ */

function unmount() {
  if (!_mounted) return;
  if (window.SNXRadio) {
    window.SNXRadio.off('nowPlaying');
    window.SNXRadio.off('upNext');
    window.SNXRadio.off('stateChange');
    window.SNXRadio.off('autoplayBlocked');
    window.SNXRadio.off('error');
    window.SNXRadio.off('programChange');
    window.SNXRadio.off('settingsChange');
    window.SNXRadio.off('tracksChange');
    window.SNXRadio.destroy();
  }
  if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
  if (_eqTimer)   { cancelAnimationFrame(_eqTimer); _eqTimer = null; }
  _el = null;
  Object.keys(E).forEach(k => { delete E[k]; });
  _mounted  = false;
  _paused   = false;
  _muted    = false;
  _isOnAir  = false;
}

/* ══════════════════════════════════════════════════════════════
   BUILD DOM
══════════════════════════════════════════════════════════════ */

function _buildDOM() {
  const div = document.createElement('div');
  div.id = 'snxRadioPlayer';
  div.innerHTML = `

    <!-- ─── Station header ───────────────────────────────── -->
    <div class="snxr-station-header">
      <div class="snxr-station-header-left">
        <span class="snxr-station-title" id="snxrStationTitle">Shadow Nexus Radio</span>
        <span class="snxr-station-tagline" id="snxrStationTagline">24/7 Music · Live Events · Shadow Nexus</span>
      </div>
      <div class="snxr-station-status snxr-status--off" id="snxrStationStatus">
        <span class="snxr-station-dot" id="snxrStationDot"></span>
        <span id="snxrStationStatusText">OFF AIR</span>
      </div>
    </div>

    <!-- ─── Current Program badge ────────────────────────── -->
    <div class="snxr-program-bar snxr-hidden" id="snxrProgramBar">
      <span class="snxr-program-icon">📻</span>
      <span class="snxr-program-name" id="snxrProgramName">Shadow Nexus Radio</span>
    </div>

    <!-- ─── Loading indicator ────────────────────────────── -->
    <div class="snxr-loading snxr-hidden" id="snxrLoading">
      <span class="snxr-loading-dot"></span>
      <span class="snxr-loading-dot"></span>
      <span class="snxr-loading-dot"></span>
    </div>

    <!-- ─── OFF AIR state ─────────────────────────────────── -->
    <div class="snxr-off-air-wrap" id="snxrOffAir">
      <span class="snxr-off-air-icon">📻</span>
      <p class="snxr-off-air-title" id="snxrOffAirTitle">Shadow Nexus Radio</p>
      <span class="snxr-off-air-sub">OFF AIR</span>
      <p class="snxr-off-air-msg">The station will return soon.<br>Stay legendary. 🌑🔥</p>
    </div>

    <!-- ─── PERSONAL LIVE overlay ─────────────────────────── -->
    <div class="snxr-personal-live snxr-hidden" id="snxrPersonalLive">
      <div class="snxr-personal-live-badge">
        <span style="width:7px;height:7px;border-radius:50%;background:#ef4444;flex-shrink:0;display:inline-block;animation:snxr-pulse 1.6s ease-in-out infinite;"></span>
        LIVE NOW
      </div>
    </div>

    <!-- ─── Now Playing card ──────────────────────────────── -->
    <div class="snxr-now-playing-card snxr-hidden" id="snxrNowCard">

      <p class="snxr-now-playing-label">Now Playing</p>

      <!-- Artwork -->
      <div class="snxr-artwork-wrap">
        <div class="snxr-artwork-square" id="snxrArtSquare">
          <div class="snxr-artwork-default" id="snxrArtDefault">
            <span class="snxr-artwork-default-icon">🎵</span>
            <svg class="snxr-artwork-wave" viewBox="0 0 200 40" preserveAspectRatio="none" aria-hidden="true">
              <polyline points="0,20 10,10 20,28 30,8 40,24 50,14 60,30 70,6 80,22 90,12 100,26 110,8 120,20 130,30 140,10 150,24 160,14 170,28 180,10 190,22 200,20" fill="none" stroke="rgba(0,174,239,0.6)" stroke-width="2"/>
            </svg>
          </div>
          <img class="snxr-artwork-img snxr-hidden" id="snxrArtImg" alt="Album artwork" />
          <canvas class="snxr-eq-canvas" id="snxrEqCanvas" aria-hidden="true"></canvas>
        </div>
      </div>

      <!-- Track info -->
      <div class="snxr-track-info">
        <p class="snxr-track-title"  id="snxrTitle">—</p>
        <p class="snxr-track-artist" id="snxrArtist">—</p>
      </div>

      <!-- Progress strip: time ──●── time -->
      <div class="snxr-progress-strip" id="snxrProgressStrip">
        <span class="snxr-time snxr-time-start" id="snxrTimeStart">0:00</span>
        <div class="snxr-progress-bar" id="snxrProgressBar">
          <div class="snxr-progress-fill" id="snxrProgressFill"></div>
        </div>
        <span class="snxr-time snxr-time-end" id="snxrTimeEnd">—</span>
      </div>

      <!-- Listener controls: play/pause · mute · volume -->
      <div class="snxr-controls">
        <!-- TAP TO LISTEN (shown when autoplay blocked) -->
        <button class="snxr-tap-btn snxr-hidden" id="snxrTapBtn" type="button">▶ TAP TO LISTEN</button>

        <!-- Play / Pause local audio -->
        <button class="snxr-play-btn snxr-hidden" id="snxrPlayBtn" type="button"
                title="Play / Pause local audio" aria-label="Play or pause">▶</button>

        <!-- Mute toggle -->
        <button class="snxr-mute-btn snxr-hidden" id="snxrMuteBtn" type="button"
                title="Mute / Unmute" aria-label="Mute or unmute">🔊</button>

        <!-- Volume -->
        <div class="snxr-vol-wrap snxr-hidden" id="snxrVolWrap">
          <input class="snxr-vol-slider" id="snxrVol" type="range"
                 min="0" max="1" step="0.02" value="0.9" aria-label="Volume" />
        </div>
      </div>

      <!-- Status text -->
      <p class="snxr-status-text" id="snxrStatus"></p>

    </div><!-- end now-playing-card -->

    <!-- ─── Up Next card ──────────────────────────────────── -->
    <div class="snxr-up-next-card snxr-hidden" id="snxrUpNextCard">
      <div class="snxr-up-next-art-wrap">
        <div class="snxr-up-next-art-default" id="snxrNextArtDefault">🎵</div>
        <img class="snxr-up-next-art snxr-hidden" id="snxrNextArtImg" alt="" />
      </div>
      <div class="snxr-up-next-text">
        <span class="snxr-up-next-label">Up Next</span>
        <span class="snxr-up-next-title"  id="snxrNextTitle">—</span>
        <span class="snxr-up-next-artist" id="snxrNextArtist"></span>
      </div>
      <span class="snxr-up-next-dur" id="snxrNextDur"></span>
    </div>

    <!-- ─── Recently Played ───────────────────────────────── -->
    <div class="snxr-recent-section snxr-hidden" id="snxrRecentSection">
      <div class="snxr-recent-header">Recently Played</div>
      <div class="snxr-recent-list" id="snxrRecentList"></div>
    </div>

    <!-- ─── Request a Song button ────────────────────────── -->
    <div class="snxr-request-wrap" id="snxrRequestWrap">
      <button class="snxr-request-btn" id="snxrRequestBtn" type="button">
        🎵 REQUEST A SONG
      </button>
    </div>

    <!-- ─── Info strip ───────────────────────────────────── -->
    <div class="snxr-info-strip">
      <span class="snxr-info-strip-text" id="snxrInfoStrip">Shadow Nexus Radio · 24/7 Music · Live Events · Shadow Nexus</span>
    </div>

  `;

  _container.appendChild(div);
  _el = div;

  // Cache DOM references
  const ids = [
    'snxrStationTitle', 'snxrStationTagline',
    'snxrStationStatus', 'snxrStationDot', 'snxrStationStatusText',
    'snxrProgramBar', 'snxrProgramName',
    'snxrLoading',
    'snxrOffAir', 'snxrOffAirTitle',
    'snxrPersonalLive',
    'snxrNowCard',
    'snxrArtSquare', 'snxrArtDefault', 'snxrArtImg',
    'snxrEqCanvas',
    'snxrTitle', 'snxrArtist',
    'snxrProgressStrip', 'snxrProgressBar', 'snxrProgressFill',
    'snxrTimeStart', 'snxrTimeEnd',
    'snxrTapBtn', 'snxrPlayBtn', 'snxrMuteBtn', 'snxrVolWrap', 'snxrVol',
    'snxrStatus',
    'snxrUpNextCard',
    'snxrNextArtDefault', 'snxrNextArtImg',
    'snxrNextTitle', 'snxrNextArtist', 'snxrNextDur',
    'snxrRecentSection', 'snxrRecentList',
    'snxrInfoStrip',
    'snxrRequestWrap', 'snxrRequestBtn',
  ];
  ids.forEach(id => { E[id] = document.getElementById(id); });
}

/* ══════════════════════════════════════════════════════════════
   BIND EVENTS
══════════════════════════════════════════════════════════════ */

function _bindEvents() {
  // TAP TO LISTEN
  if (E.snxrTapBtn) {
    E.snxrTapBtn.addEventListener('click', () => {
      _hide('snxrTapBtn');
      _setStatus('Connecting…');
      if (window.SNXRadio) window.SNXRadio.tapToListen();
    });
  }

  // Play / Pause local audio
  if (E.snxrPlayBtn) {
    E.snxrPlayBtn.addEventListener('click', () => {
      const audio = _getAudio();
      if (!audio) return;
      if (_paused) {
        audio.play().catch(() => {});
        _paused = false;
        E.snxrPlayBtn.textContent = '⏸';
        _setStatus('');
        if (E.snxrArtSquare) E.snxrArtSquare.classList.add('snxr-playing');
        _startEQ();
      } else {
        audio.pause();
        _paused = true;
        E.snxrPlayBtn.textContent = '▶';
        _setStatus('Paused');
        if (E.snxrArtSquare) E.snxrArtSquare.classList.remove('snxr-playing');
        _stopEQ();
      }
    });
  }

  // Mute toggle
  if (E.snxrMuteBtn) {
    E.snxrMuteBtn.addEventListener('click', () => {
      const audio = _getAudio();
      _muted = !_muted;
      if (audio) audio.muted = _muted;
      if (_muted) {
        E.snxrMuteBtn.textContent = '🔇';
        E.snxrMuteBtn.classList.add('snxr-muted');
      } else {
        E.snxrMuteBtn.textContent = '🔊';
        E.snxrMuteBtn.classList.remove('snxr-muted');
      }
    });
  }

  // Volume slider
  if (E.snxrVol) {
    E.snxrVol.addEventListener('input', () => {
      const v = parseFloat(E.snxrVol.value);
      _lastVol = v;
      if (window.SNXRadio) window.SNXRadio.setVolume(v);
    });
  }

  // REQUEST A SONG button — opens SNXRadioRequests modal
  if (E.snxrRequestBtn) {
    E.snxrRequestBtn.addEventListener('click', () => {
      if (window.SNXRadioRequests) {
        window.SNXRadioRequests.openModal();
      }
    });
  }

  // Progress + recently played update every second
  _tickTimer = setInterval(_tick, 1000);
}

/* ══════════════════════════════════════════════════════════════
   INIT RADIO ENGINE
══════════════════════════════════════════════════════════════ */

function _initRadio() {
  if (!window.SNXRadio) {
    console.error('[SNX-RP] SNXRadio not loaded');
    _setStatus('Radio module not loaded');
    return;
  }

  window.SNXRadio.init({
    onNowPlaying:      _onNowPlaying,
    onUpNext:          _onUpNext,
    onStateChange:     _onStateChange,
    onAutoplayBlocked: _onAutoplayBlocked,
    onError:           _onError,
    onProgramChange:   _onProgramChange,
    onSettingsChange:  _onSettingsChange,
    onTracksChange:    _onTracksChange,
  });
}

/* ══════════════════════════════════════════════════════════════
   RADIO CALLBACKS
══════════════════════════════════════════════════════════════ */

function _onNowPlaying(track) {
  if (!track) {
    if (E.snxrTitle)  E.snxrTitle.textContent  = '—';
    if (E.snxrArtist) E.snxrArtist.textContent = '—';
    _setArtwork(null);
    return;
  }
  if (E.snxrTitle)  E.snxrTitle.textContent  = track.title  || 'Unknown';
  if (E.snxrArtist) E.snxrArtist.textContent = track.artist || '';
  _setArtwork(track.artworkUrl);
  if (track.duration && E.snxrTimeEnd) {
    E.snxrTimeEnd.textContent = _fmtTime(track.duration);
  }
  // Refresh recently played whenever track changes
  _renderRecentlyPlayed();
}

function _onUpNext(track) {
  if (!track) { _hide('snxrUpNextCard'); return; }
  if (E.snxrNextTitle)  E.snxrNextTitle.textContent  = track.title  || 'Unknown';
  if (E.snxrNextArtist) E.snxrNextArtist.textContent = track.artist || '';
  if (E.snxrNextDur)    E.snxrNextDur.textContent    = track.duration ? _fmtTime(track.duration) : '';
  _setNextArtwork(track.artworkUrl);
  _show('snxrUpNextCard');
}

function _onStateChange(state) {
  _hide('snxrLoading');
  _hide('snxrOffAir');
  _hide('snxrNowCard');
  _hide('snxrPersonalLive');
  _hide('snxrPlayBtn');
  _hide('snxrMuteBtn');
  _hide('snxrVolWrap');
  _hide('snxrTapBtn');
  _hide('snxrUpNextCard');
  _hide('snxrRecentSection');
  _setOnAir(false);
  _isOnAir = false;

  switch (state) {
    case 'loading':
      _show('snxrLoading');
      _setStatus('Loading station…');
      break;

    case 'on-air':
      _setOnAir(true);
      _isOnAir = true;
      _show('snxrNowCard');
      _show('snxrPlayBtn');
      _show('snxrMuteBtn');
      _show('snxrVolWrap');
      _show('snxrRecentSection');
      _setStatus('');
      if (E.snxrPlayBtn) E.snxrPlayBtn.textContent = _paused ? '▶' : '⏸';
      if (!_paused) {
        if (E.snxrArtSquare) E.snxrArtSquare.classList.add('snxr-playing');
        _startEQ();
      }
      if (E.snxrProgressStrip) E.snxrProgressStrip.classList.add('snxr-progress-active');
      _renderRecentlyPlayed();
      break;

    case 'tap-to-listen':
      _show('snxrNowCard');
      _show('snxrTapBtn');
      _setStatus('');
      break;

    case 'off-air':
      _show('snxrOffAir');
      _setStatus('');
      if (E.snxrArtSquare) E.snxrArtSquare.classList.remove('snxr-playing');
      _stopEQ();
      if (E.snxrProgressStrip) E.snxrProgressStrip.classList.remove('snxr-progress-active');
      break;

    case 'personal-live':
      _show('snxrPersonalLive');
      _setStatus('Live broadcast in progress');
      if (E.snxrArtSquare) E.snxrArtSquare.classList.remove('snxr-playing');
      _stopEQ();
      break;

    case 'paused':
      _show('snxrNowCard');
      _show('snxrPlayBtn');
      _show('snxrMuteBtn');
      _show('snxrVolWrap');
      _show('snxrRecentSection');
      _isOnAir = true;
      _setOnAir(true);
      _paused = true;
      if (E.snxrPlayBtn) E.snxrPlayBtn.textContent = '▶';
      if (E.snxrArtSquare) E.snxrArtSquare.classList.remove('snxr-playing');
      _stopEQ();
      _setStatus('Paused');
      break;

    case 'error':
      _show('snxrOffAir');
      _setStatus('Could not connect to station');
      break;

    default:
      break;
  }
}

function _onAutoplayBlocked() {
  _show('snxrNowCard');
  _show('snxrTapBtn');
  _hide('snxrPlayBtn');
  _hide('snxrMuteBtn');
  _hide('snxrVolWrap');
  _setOnAir(false);
  _setStatus('');
}

function _onError(msg) {
  _setStatus(msg || 'An error occurred');
}

function _onTracksChange(/* tracks */) {
  // Track library changed — refresh recently played (metadata may have updated)
  _renderRecentlyPlayed();
}

function _onProgramChange(program) {
  if (!program) {
    _hide('snxrProgramBar');
    return;
  }
  const name = program.slotLabel || program.name || 'On Air';
  if (E.snxrProgramName) E.snxrProgramName.textContent = name;
  _show('snxrProgramBar');
}

function _onSettingsChange(settings) {
  if (!settings) return;
  const name    = settings.stationName || 'Shadow Nexus Radio';
  const tagline = settings.tagline     || '24/7 Music · Live Events · Shadow Nexus';
  if (E.snxrStationTitle)   E.snxrStationTitle.textContent   = name;
  if (E.snxrStationTagline) E.snxrStationTagline.textContent = tagline;
  if (E.snxrOffAirTitle)    E.snxrOffAirTitle.textContent    = name;
  if (E.snxrInfoStrip)      E.snxrInfoStrip.textContent      = `${name} · ${tagline}`;
}

/* ══════════════════════════════════════════════════════════════
   TICK — progress bar + time display + recently played refresh
══════════════════════════════════════════════════════════════ */

function _tick() {
  const audio = _getAudio();
  if (!audio || !audio.duration || isNaN(audio.duration)) return;

  const pos = audio.currentTime;
  const dur = audio.duration;
  const pct = Math.min(100, (pos / dur) * 100);

  if (E.snxrProgressFill) E.snxrProgressFill.style.width = pct.toFixed(2) + '%';
  if (E.snxrTimeStart) E.snxrTimeStart.textContent = _fmtTime(pos);
  if (E.snxrTimeEnd)   E.snxrTimeEnd.textContent   = _fmtTime(dur);
}

/* ══════════════════════════════════════════════════════════════
   RECENTLY PLAYED
══════════════════════════════════════════════════════════════ */

function _renderRecentlyPlayed() {
  if (!E.snxrRecentList) return;
  if (!window.SNXRadio) return;

  const tracks = window.SNXRadio.recentlyPlayed;
  if (!tracks || tracks.length === 0) {
    E.snxrRecentList.innerHTML = '<div class="snxr-recent-empty">No history yet</div>';
    return;
  }

  E.snxrRecentList.innerHTML = tracks.map(t => {
    const artHtml = t.artworkUrl
      ? `<img class="snxr-recent-art" src="${_esc(t.artworkUrl)}" alt="" loading="lazy" />`
      : `<div class="snxr-recent-art snxr-recent-art-default">🎵</div>`;
    return `
<div class="snxr-recent-row">
  ${artHtml}
  <div class="snxr-recent-info">
    <span class="snxr-recent-title">${_esc(t.title || 'Unknown')}</span>
    <span class="snxr-recent-artist">${_esc(t.artist || '')}</span>
  </div>
  <span class="snxr-recent-dur">${t.duration ? _fmtTime(t.duration) : ''}</span>
</div>`;
  }).join('');
}

/* ══════════════════════════════════════════════════════════════
   EQUALIZER — pure CSS/canvas visual (no audio chain)
══════════════════════════════════════════════════════════════ */

const _EQ_BARS  = 24;
const _eqPhases = Array.from({ length: _EQ_BARS }, () => Math.random() * Math.PI * 2);
const _eqSpeeds = Array.from({ length: _EQ_BARS }, () => 1.4 + Math.random() * 2.2);
let   _eqT      = 0;
let   _eqRunning = false;
let   _eqCanvas = null;

function _startEQ() {
  if (_eqRunning) return;
  _eqRunning = true;
  _eqCanvas = E.snxrEqCanvas;
  if (_eqCanvas) {
    _eqCanvas.classList.add('snxr-playing');
    _renderEQ();
  }
}

function _stopEQ() {
  _eqRunning = false;
  if (_eqTimer) { cancelAnimationFrame(_eqTimer); _eqTimer = null; }
  if (E.snxrEqCanvas) {
    E.snxrEqCanvas.classList.remove('snxr-playing');
    const ctx = E.snxrEqCanvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, E.snxrEqCanvas.width, E.snxrEqCanvas.height);
  }
}

function _renderEQ() {
  if (!_eqRunning) return;
  const canvas = E.snxrEqCanvas;
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    canvas.width  = rect.width;
    canvas.height = rect.height;
  }

  const ctx  = canvas.getContext('2d');
  const W    = canvas.width;
  const H    = canvas.height;
  const barW = W / (_EQ_BARS * 1.6);
  const gap  = W / _EQ_BARS;

  ctx.clearRect(0, 0, W, H);
  _eqT += 0.04;

  for (let i = 0; i < _EQ_BARS; i++) {
    const h = (
      Math.abs(Math.sin(_eqT * _eqSpeeds[i] + _eqPhases[i])) * 0.65 +
      Math.abs(Math.sin(_eqT * 0.6 + i * 0.4)) * 0.35
    ) * H;

    const x = i * gap + (gap - barW) / 2;
    const y = H - h;

    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, 'rgba(0,100,180,0.8)');
    grad.addColorStop(0.6, 'rgba(0,174,239,0.9)');
    grad.addColorStop(1, 'rgba(0,220,255,0.5)');

    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, barW, h, 1) : ctx.rect(x, y, barW, h);
    ctx.fill();
  }

  _eqTimer = requestAnimationFrame(_renderEQ);
}

/* ══════════════════════════════════════════════════════════════
   DOM HELPERS
══════════════════════════════════════════════════════════════ */

function _show(id) {
  const el = E[id];
  if (el) el.classList.remove('snxr-hidden');
}

function _hide(id) {
  const el = E[id];
  if (el) el.classList.add('snxr-hidden');
}

function _setOnAir(active) {
  const el = E.snxrStationStatus;
  if (!el) return;
  if (active) {
    el.classList.replace('snxr-status--off', 'snxr-status--on');
    if (E.snxrStationStatusText) E.snxrStationStatusText.textContent = 'ON AIR';
  } else {
    el.classList.replace('snxr-status--on', 'snxr-status--off');
    if (E.snxrStationStatusText) E.snxrStationStatusText.textContent = 'OFF AIR';
  }
  // Notify integration layer (index.html) to update Founder status bar
  if (typeof window.snxRadioUpdateFounderStatus === 'function') {
    window.snxRadioUpdateFounderStatus(active);
  }
}

function _setStatus(msg) {
  if (E.snxrStatus) E.snxrStatus.textContent = msg || '';
}

function _setArtwork(url) {
  if (!E.snxrArtImg) return;
  if (!url) {
    E.snxrArtImg.classList.add('snxr-hidden');
    E.snxrArtImg.src = '';
    if (E.snxrArtDefault) E.snxrArtDefault.style.display = '';
    return;
  }
  const img = new Image();
  img.onload = () => {
    E.snxrArtImg.src = url;
    E.snxrArtImg.classList.remove('snxr-hidden');
    if (E.snxrArtDefault) E.snxrArtDefault.style.display = 'none';
  };
  img.onerror = () => {
    E.snxrArtImg.classList.add('snxr-hidden');
    if (E.snxrArtDefault) E.snxrArtDefault.style.display = '';
  };
  img.src = url;
}

function _setNextArtwork(url) {
  if (!E.snxrNextArtImg) return;
  if (!url) {
    E.snxrNextArtImg.classList.add('snxr-hidden');
    if (E.snxrNextArtDefault) E.snxrNextArtDefault.style.display = '';
    return;
  }
  const img = new Image();
  img.onload = () => {
    E.snxrNextArtImg.src = url;
    E.snxrNextArtImg.classList.remove('snxr-hidden');
    if (E.snxrNextArtDefault) E.snxrNextArtDefault.style.display = 'none';
  };
  img.onerror = () => {
    E.snxrNextArtImg.classList.add('snxr-hidden');
    if (E.snxrNextArtDefault) E.snxrNextArtDefault.style.display = '';
  };
  img.src = url;
}

function _getAudio() {
  return document.querySelector('audio[crossorigin="anonymous"]');
}

function _fmtTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════════════════
   LOG
══════════════════════════════════════════════════════════════ */

console.log('[SNX-RP] snx-radio-player.js loaded — version', PLAYER_VERSION);

})(); // end IIFE
