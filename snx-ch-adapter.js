/**
 * SNX 24-Hour TV Adapter
 * snx-ch-adapter.js
 *
 * Integrates the Aurenix 24-hour channel engine natively into
 * Shadow Nexus Social. Key responsibilities:
 *
 *  1. Read window._snxCurrentUser — the authenticated SNS user.
 *     Never show a second login screen.
 *
 *  2. Render the channel viewer/studio into #snxTvApp inside the
 *     SNS tvPage div — no separate HTML page, no Aurenix nav bar.
 *
 *  3. Expose window.snxTvInit() so index.html can call it when
 *     the user navigates to tvPage.
 *
 *  4. Expose window.snxTvTeardown() so media stops when leaving tvPage.
 *
 * Auth flow:
 *   SNS onAuthStateChanged → window._snxCurrentUser set
 *   → user taps "24-Hour TV" → navTo('tvPage') → snxTvInit()
 *   → adapter reads _snxCurrentUser → starts channel engine
 *   → NO second login, NO second Firebase init for auth
 *
 * Firestore data (channel state, media, etc.) still lives on the
 * Aurenix Firebase project (remix-studio-4bf8a) via snx-ch-firebase.js.
 * This is Phase 1; Phase 2 migrates that data to the SNS project.
 */

/* ── Pull the Aurenix channel engine from snx-ch-firebase.js ── */
import {
  db,
  doc, getDoc, setDoc, collection, getDocs, onSnapshot,
  updateDoc, serverTimestamp, Timestamp, addDoc,
  query, orderBy, where,
} from './snx-ch-firebase.js';

import { LIVE_TV_CHANNEL_ID } from './snx-ch-live-tv.js';
import { supabase } from './snx-ch-supabase.js';

/* ════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════ */
const FOUNDER_EMAIL  = 'christijerina46@gmail.com';
const ADVANCE_WORKER_URL = 'https://aurenix-upload.nthntjrn.workers.dev/channel/advance';

/* ════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════ */
let _user          = null;
let _isFounder     = false;
let _networkReady  = false;
let _channels      = [];
let _activeChannel = null;
let _channelStates = {};
let _channelUnsubs = {};
let _channelsUnsub = null;
let _mediaEl       = null;
let _mediaType     = null;
let _gateOpen      = false;
let _tickTimer     = null;
let _advancing     = false;
let _currentMediaId    = null;
let _viewerAdvancingId = null;
let _authSignOutListenerAdded = false;
const _bgAdvancingId   = {};
let _transitioning     = false;
let _saKeyMissingLoggedAt = 0;
const _bootstrapRequestedAt = {};
let _viewerReloadingId = null;
let _onerrorRetries    = 0;
let _fsHideTimer       = null;
let _tvActive          = false;   // true while tvPage is visible
let _visibilityListenerAdded = false;

// Stage 4 — Main TV Feature state
let _mainTvUnsub       = null;   // Firestore subscription for mainTvState/current
let _mainTvState       = null;   // cached mainTvState document data
let _featureMounted    = false;  // true while a featured live is showing in player

/* ════════════════════════════════════════════════════
   PUBLIC ENTRY POINTS (called by SNS index.html)
════════════════════════════════════════════════════ */

/**
 * Called by snxOpen24HourTV() (the canonical TV startup controller) when the user
 * navigates to tvPage.  Reads window._snxCurrentUser — no second login.
 *
 * Auth is guaranteed to be resolved BEFORE this is called because
 * snxOpen24HourTV() awaits the SNS auth-ready queue first.  The polling
 * fallback is kept only as a last-resort safety net for direct calls.
 */
window.snxTvInit = function () {
  _tvActive = true;
  console.log('[SNX-TV] TV engine initializing');

  // Grab the current SNS authenticated user.
  // snxOpen24HourTV() ensures auth is resolved before calling here, so this
  // will almost always be set.  The auth-event fallback below handles the
  // rare case where snxTvInit is called outside of snxOpen24HourTV.
  const snxUser = window._snxCurrentUser || null;

  if (!snxUser && !window._snxAuthResolved) {
    // Auth not yet resolved — use the canonical auth-ready queue, NOT polling.
    console.log('[SNX-TV] snxTvInit: waiting for auth via auth-ready queue');
    _renderConnectingInPlayer();

    const _startOnce = () => {
      console.log('[SNX-TV] Auth ready');
      _startWithUser(window._snxCurrentUser || null);
    };

    if (typeof window._snxOnAuthReady === 'function') {
      window._snxOnAuthReady(_startOnce);
    } else {
      // _snxOnAuthReady not yet defined — push to queue directly
      window._snxAuthReadyQueue = window._snxAuthReadyQueue || [];
      window._snxAuthReadyQueue.push(_startOnce);
    }

    // Safety timeout — if auth never fires within 10s, render as guest/not-logged-in
    setTimeout(() => {
      if (!window._snxAuthResolved && _tvActive) {
        console.warn('[SNX-TV] Auth timeout — rendering guest state');
        _startWithUser(null);
      }
    }, 10000);
    return;
  }

  _startWithUser(snxUser);
};

/**
 * Called by SNS when user navigates away from tvPage.
 * Stops ALL local playback — the broadcast channel continues on the server.
 * Keeps _gateOpen = true so re-entry is instant (no Watch Now again).
 *
 * FIX: explicitly clear src after pause so browser media pipeline cannot
 * restart via snx-tv-network _switchTab resume logic or bfcache.
 */
window.snxTvTeardown = function () {
  _tvActive = false;
  // Do NOT reset _gateOpen — viewer already consented; re-entry should be instant.
  _stopMediaFull();
  _stopTick();
  // Signal the TV Network module that MAIN TV is no longer the active page so
  // its internal _switchTab resume guard (which fires vid.play/aud.play when
  // returning to main-tv) cannot accidentally restart audio while we are on
  // a completely different SNS page.
  window._snxTvPageActive = false;
};

/* ════════════════════════════════════════════════════
   INTERNAL INIT
════════════════════════════════════════════════════ */
function _startWithUser(user) {
  console.log('[SNX-TV] TV engine initializing — user:', user?.email || 'guest/anonymous');
  _user      = user;
  _isFounder = !!(user && user.email?.trim().toLowerCase() === FOUNDER_EMAIL.toLowerCase());

  // ── DOUBLE-INIT GUARD: always kill any leftover media/timers before starting ──
  // This prevents duplicate audio/video when snxTvInit is called more than once
  // before teardown (e.g. rapid navigation or an unexpected second call path).
  // _stopMediaFull clears src so the browser truly stops the stream even if a
  // previous async _loadMedia call never finished cleaning up.
  _stopMediaFull();
  _stopTick();

  // Mark the TV page as active NOW so the snx-tv-network resume path is permitted.
  window._snxTvPageActive = true;

  // Subscribe to Main TV feature state (all users — they need to react to featured live).
  // _subscribeMainTvState() is idempotent — it returns early if already subscribed.
  _subscribeMainTvState();

  // ── RE-ENTRY: network already initialised, viewer returning to tvPage ────────
  // Do NOT show a loading screen or recreate the entire shell.
  // Just rebuild the player DOM, reattach Firestore state, and resume playback
  // at the CURRENT broadcast position.
  if (_networkReady) {
    console.log('[SNX-TV] TV engine re-entry — network already ready, channels:', _channels.length);
    _rebuildTvShell();
    if (_isFounder) _renderFounderBar();
    _buildChannelList();
    _buildEPGChannelTabs();
    _setLiveStatus('connecting');
    // Open the gate immediately — viewer already agreed to watch on first entry.
    _gateOpen = true;
    _hideTvGate();
    if (_activeChannel) {
      const st = _channelStates[_activeChannel.id];
      if (st?.current_item) {
        _onActiveChannelUpdate(st);
      } else {
        _setNowPlaying(_activeChannel.name || _activeChannel.label || '', '', '');
        _setLiveStatus('connecting');
      }
    } else if (_channels[0]) {
      _setActiveChannel(_channels[0].id);
    }
    _startTick();
    console.log('[SNX-TV] Active channel synchronized');
    return;
  }

  // ── FIRST ENTRY: render the player shell immediately (no full-screen gate) ──
  // Show the shell with ● CONNECTING status, then subscribe to Firestore.
  // The gate is hidden and _gateOpen is set true so that when the first
  // Firestore snapshot arrives the media loads and plays automatically.
  _rebuildTvShell();
  if (_isFounder) _renderFounderBar();
  _setLiveStatus('connecting');
  _gateOpen = true;
  _hideTvGate();

  _subscribeChannels();

  // React to SNS auth changes (user signs out → clear TV)
  if (!_authSignOutListenerAdded) {
    _authSignOutListenerAdded = true;
    window.addEventListener('snxAuthSignOut', () => {
      _stopMedia(); _stopTick();
      _networkReady = false; _channels = [];
      if (_channelsUnsub) { _channelsUnsub(); _channelsUnsub = null; }
      Object.values(_channelUnsubs).forEach(u => u && u());
      _channelUnsubs = {}; _channelStates = {};
      if (_tvActive) _renderNotLoggedIn();
    }, { once: false });
  }

  // ── PAGE VISIBILITY: resync when viewer returns from background / bfcache ──
  if (!_visibilityListenerAdded) {
    _visibilityListenerAdded = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && _tvActive && _gateOpen) {
        _viewerReconnect('visibilitychange');
      }
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && _tvActive && _gateOpen) {
        _viewerReconnect('bfcache');
      }
    });
  }
}

/* ════════════════════════════════════════════════════
   LOADING / NOT-LOGGED-IN STATES
════════════════════════════════════════════════════ */

// Shown only while waiting for SNS auth to resolve — minimal inline indicator,
// NOT a full-screen replacement for the player.
function _renderConnectingInPlayer() {
  const app = document.getElementById('snxTvApp');
  if (!app) return;
  app.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:180px;gap:10px;padding:32px 20px;text-align:center;">
      <div style="font-size:40px;line-height:1;">📺</div>
      <div style="font-size:15px;font-weight:900;color:#00AEEF;letter-spacing:3px;">24-HOUR TV</div>
      <div style="display:flex;align-items:center;gap:7px;font-size:11px;font-weight:700;color:#5a80a8;letter-spacing:1.5px;text-transform:uppercase;">
        <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#5a80a8;animation:snxTvDot 1.4s ease-in-out infinite;"></span>
        CONNECTING
      </div>
    </div>`;
}

function _renderNotLoggedIn() {
  const app = document.getElementById('snxTvApp');
  if (!app) return;
  app.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:340px;gap:14px;padding:40px 20px;text-align:center;">
      <div style="font-size:36px;">📺</div>
      <div style="font-size:15px;font-weight:800;color:#00AEEF;letter-spacing:2px;">24-HOUR TV</div>
      <div style="font-size:12px;color:#5a80a8;margin-bottom:8px;">Sign in to Shadow Nexus Social to watch.</div>
      <button onclick="if(typeof realmNavTo==='function')realmNavTo('login');else if(typeof navTo==='function')navTo('login');"
        style="padding:10px 28px;background:#0090cc;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;letter-spacing:1px;">
        SIGN IN
      </button>
    </div>`;
}

/* ════════════════════════════════════════════════════
   CHANNEL SUBSCRIPTION
════════════════════════════════════════════════════ */
function _subscribeChannels() {
  if (_channelsUnsub) _channelsUnsub();
  const q = query(collection(db, 'network_channels'), orderBy('sort_order', 'asc'));
  _channelsUnsub = onSnapshot(q, (snap) => {
    const loaded = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(ch => ch.enabled !== false);

    _channels = loaded;
    console.log('[SNX-TV] Channels loaded:', loaded.length);

    if (!_networkReady) {
      _networkReady = true;
      // Shell was already built by _startWithUser before subscribeChannels was called.
      // Only build it here if somehow it wasn't (shouldn't happen in normal flow).
      if (!document.getElementById('ax-media-area')) {
        _rebuildTvShell();
        if (_isFounder) _renderFounderBar();
      }
      _channels.forEach(ch => _subscribeChannelState(ch.id));
      _buildChannelList();
      _buildEPGChannelTabs();
      if (_channels[0]) {
        _setActiveChannel(_channels[0].id);
        console.log('[SNX-TV] Active channel synchronized');
      }
      _startTick();
      console.log('[SNX-TV] Playback ready');
    } else {
      _buildChannelList();
      _buildEPGChannelTabs();
      _channels.forEach(ch => _subscribeChannelState(ch.id));
      if (_tvActive) _startTick();
    }
  }, (err) => {
    // ── CRITICAL: log exact error so the console makes the cause clear ──
    // Most common cause: remix-studio-4bf8a Firestore rules deny unauthenticated
    // reads on network_channels.  Fix: set  allow read: if true;  on that
    // collection in the remix-studio-4bf8a Firebase console.
    console.error(
      '[24TV ERROR] network_channels query failed.',
      'code:', err?.code,
      'message:', err?.message,
      '\nFix: ensure remix-studio-4bf8a Firestore rules allow',
      '  match /network_channels/{id} { allow read: if true; }',
    );
    if (!_networkReady) {
      _networkReady = true;
      if (!document.getElementById('ax-media-area')) {
        _rebuildTvShell();
        if (_isFounder) _renderFounderBar();
      }
      // Show a readable error in the player area when channels can't be loaded.
      const errCode = err?.code || 'unknown';
      const npTitle = document.getElementById('ax-np-title');
      const npArtist = document.getElementById('ax-np-artist');
      const statusText = document.getElementById('snx-tv-status-text');
      if (npTitle)  npTitle.textContent  = 'Channel data unavailable';
      if (npArtist) npArtist.textContent = errCode === 'permission-denied'
        ? 'Firestore permission denied — contact site admin'
        : ('Error: ' + errCode);
      if (statusText) statusText.textContent = 'ERROR';
      if (_channels[0]) _setActiveChannel(_channels[0].id);
      _startTick();
    }
  });
}

/* ════════════════════════════════════════════════════
   TV SHELL (renders into #snxTvApp)
════════════════════════════════════════════════════ */
function _rebuildTvShell() {
  const app = document.getElementById('snxTvApp');
  if (!app) return;

  app.innerHTML = `
    <!-- ── Founder bar (injected by _renderFounderBar if applicable) ── -->
    <div id="snx-tv-founder-bar" style="display:none;"></div>

    <!-- ── Page header ── -->
    <div class="snx-tv-header">
      <div class="snx-tv-title-wrap">
        <div class="snx-tv-title">SHADOW NEXUS TV</div>
        <div class="snx-tv-status" id="snx-tv-status">
          <span class="snx-tv-status-dot" id="snx-tv-status-dot"></span>
          <span id="snx-tv-status-text">CONNECTING</span>
        </div>
      </div>
      ${_isFounder ? `<div id="snx-tv-tab-bar" class="snx-tv-tabs">
        <button class="snx-tv-tab active" id="snxTvTabWatch" onclick="snxTvSwitchTab('watch')">WATCH</button>
        <button class="snx-tv-tab" id="snxTvTabStudio" onclick="snxTvSwitchTab('studio')">⚙ TV STUDIO</button>
      </div>` : ''}
    </div>

    <!-- ── WATCH panel ── -->
    <div id="snxTvPanel_watch" class="snx-tv-panel">

      <!-- Player area -->
      <div class="snx-tv-player-area">

        <!-- Channel badge -->
        <div class="ax-channel-badge" id="ax-channel-badge">
          <span class="ax-badge-num" id="ax-badge-num">—</span>
          <span class="ax-badge-dot">·</span>
          <span id="ax-badge-name">Loading…</span>
          <span class="ax-live-indicator"><span class="ax-live-dot"></span> LIVE</span>
        </div>

        <!-- Player shell -->
        <div class="ax-player-shell snx-tv-player-shell">
          <div id="ax-fs-container">
            <div class="ax-media-area" id="ax-media-area">
              <video id="ax-video" playsinline style="width:100%;height:100%;display:none;"></video>
              <audio id="ax-audio" style="display:none;"></audio>
              <div class="ax-media-thumbnail" id="ax-thumbnail">
                <div style="font-size:60px;opacity:0.10;">📺</div>
              </div>
              <div class="ax-media-overlay"></div>
              <div class="ax-np-overlay" id="ax-np-overlay">
                <div class="ax-np-label" id="ax-np-label-text">NOW PLAYING</div>
                <div class="ax-np-title" id="ax-np-title">Connecting…</div>
                <div class="ax-np-artist" id="ax-np-artist"></div>
              </div>
              <div id="ax-one-viewer-live" style="display:none;position:absolute;top:10px;left:10px;z-index:10;background:rgba(255,45,85,0.92);color:#fff;font-size:10px;font-weight:900;letter-spacing:2px;padding:3px 8px;border-radius:4px;">● LIVE</div>
              <div id="ax-one-viewer-comm" style="display:none;position:absolute;top:10px;right:10px;z-index:10;background:rgba(0,160,255,0.92);color:#fff;font-size:10px;font-weight:900;letter-spacing:1.5px;padding:3px 8px;border-radius:4px;">📢 BREAK</div>
              <!-- Tap-for-sound overlay (shown only when muted autoplay is active) -->
              <div id="ax-tap-sound" style="display:none;position:absolute;bottom:54px;left:50%;transform:translateX(-50%);z-index:15;cursor:pointer;">
                <button id="ax-tap-sound-btn" style="display:flex;align-items:center;gap:8px;padding:10px 20px;background:rgba(2,4,10,0.82);border:1px solid rgba(0,174,239,0.45);border-radius:40px;color:#fff;font-size:13px;font-weight:800;letter-spacing:1.5px;cursor:pointer;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);">
                  🔊 TAP FOR SOUND
                </button>
              </div>
              <!-- Legacy gate (hidden immediately; kept for fallback safety) -->
              <div class="ax-autoplay-gate" id="ax-gate" style="display:none;">
                <div class="ax-gate-logo">📺</div>
                <div class="ax-gate-title">24-HOUR TV</div>
                <div class="ax-gate-sub">Tap to start watching</div>
                <button class="ax-gate-btn" id="ax-gate-btn">▶ WATCH NOW</button>
              </div>
              <!-- Fullscreen overlay -->
              <div class="ax-fs-overlay" id="ax-fs-overlay">
                <div class="ax-fs-overlay-gradient"></div>
                <div class="ax-fs-ctrl-bar">
                  <div class="ax-fs-progress-wrap">
                    <div class="ax-fs-progress-bar" id="ax-fs-progress-bar">
                      <div class="ax-fs-progress-fill" id="ax-fs-progress-fill"></div>
                    </div>
                    <div class="ax-fs-times">
                      <span id="ax-fs-time-elapsed">0:00</span>
                      <span id="ax-fs-time-total">—</span>
                    </div>
                  </div>
                  <div class="ax-fs-btns">
                    <button class="ax-fs-ctrl-btn" id="ax-fs-play-btn" aria-label="Play/Pause">▶</button>
                    <button class="ax-fs-ctrl-btn" id="ax-fs-mute-btn" aria-label="Mute">🔊</button>
                    <input type="range" class="ax-fs-vol-slider" id="ax-fs-vol-slider" min="0" max="1" step="0.02" value="0.8" aria-label="Volume">
                    <div class="ax-fs-spacer"></div>
                    <button class="ax-fs-ctrl-btn ax-fs-exit-btn" id="ax-fs-exit-btn" aria-label="Exit fullscreen">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="8 3 3 3 3 8"></polyline><polyline points="21 8 21 3 16 3"></polyline>
                        <polyline points="3 16 3 21 8 21"></polyline><polyline points="16 21 21 21 21 16"></polyline>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Progress bar -->
            <div class="ax-progress-wrap">
              <div class="ax-progress-bar" id="ax-progress-bar">
                <div class="ax-progress-fill" id="ax-progress-fill"></div>
              </div>
              <div class="ax-progress-times">
                <span id="ax-time-elapsed">0:00</span>
                <span id="ax-time-total">—</span>
                <span id="ax-time-remaining">—</span>
              </div>
            </div>

            <!-- Controls -->
            <div class="ax-controls">
              <button class="ax-ctrl-btn primary" id="ax-play-btn" title="Play/Pause">▶</button>
              <div class="ax-volume-wrap">
                <button class="ax-ctrl-btn" id="ax-mute-btn" title="Mute">🔊</button>
                <input type="range" class="ax-volume-slider" id="ax-vol-slider" min="0" max="1" step="0.02" value="0.8">
              </div>
              <div class="ax-controls-spacer"></div>
              <button class="ax-ctrl-btn" id="ax-pip-btn" title="Picture-in-Picture" style="display:none;">⧉</button>
              <button class="ax-ctrl-btn" id="ax-fs-btn" title="Fullscreen" aria-label="Fullscreen">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline>
                  <line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line>
                </svg>
              </button>
            </div>
          </div><!-- /#ax-fs-container -->
        </div><!-- /.ax-player-shell -->
      </div><!-- /.snx-tv-player-area -->

      <!-- Now Playing info panel -->
      <div class="ax-now-playing-panel" id="ax-now-playing-panel">
        <div class="ax-np-panel-left">
          <div class="ax-np-panel-label">🔴 NOW PLAYING</div>
          <div class="ax-np-panel-title" id="ax-np-panel-title">—</div>
          <div class="ax-np-panel-meta" id="ax-np-panel-meta">—</div>
        </div>
        <div class="ax-np-panel-right">
          <div class="ax-np-panel-time" id="ax-np-panel-time">0:00 / —</div>
          <div class="ax-np-panel-remain" id="ax-np-panel-remain"></div>
        </div>
      </div>

      <!-- Sidebar: channels + up next + EPG -->
      <div class="snx-tv-info-row">
        <div class="snx-tv-section-card">
          <div class="snx-tv-section-title">📺 CHANNELS</div>
          <div class="ax-channels" id="ax-channel-list">
            <div style="padding:14px;color:#5a80a8;font-size:12px;">Loading channels…</div>
          </div>
        </div>

        <div class="snx-tv-section-card">
          <div class="snx-tv-section-title">UP NEXT</div>
          <div class="ax-schedule-list" id="ax-up-next-list">
            <div style="padding:14px;color:#5a80a8;font-size:12px;">Loading…</div>
          </div>
        </div>

        <div class="snx-tv-section-card snx-tv-epg-card">
          <div class="snx-tv-section-title">📅 TV GUIDE</div>
          <div class="ax-epg-tabs" id="ax-epg-tabs"></div>
          <div class="ax-epg-body" id="ax-epg-body">
            <div style="padding:14px;color:#5a80a8;font-size:12px;">Select a channel above.</div>
          </div>
        </div>
      </div>

    </div><!-- /#snxTvPanel_watch -->

    <!-- ── STUDIO panel (founder only, lazy-loaded) ── -->
    <div id="snxTvPanel_studio" class="snx-tv-panel" style="display:none;">
      <div id="ax-control" aria-label="24-Hour TV Studio" style="position:relative;z-index:1;"></div>
    </div>

    <!-- ── Submit content modal ── -->
    <div class="ax-modal-overlay" id="ax-submit-modal" style="display:none;">
      <div class="ax-modal-box" style="max-width:560px;width:100%;">
        <div class="ax-modal-title">🎤 SUBMIT CONTENT</div>
        <div style="font-size:12px;color:var(--text-dim,#5a80a8);margin-bottom:16px;line-height:1.6;">
          Upload video, audio, or image content to the 24-Hour Channel.<br>
          <strong style="color:var(--text,#c8d0e8);">Submissions are reviewed before broadcast.</strong>
        </div>
        <div id="ax-sub-drop-zone" style="border:2px dashed rgba(0,174,239,0.35);border-radius:10px;padding:22px 16px;text-align:center;cursor:pointer;background:rgba(0,174,239,0.04);margin-bottom:14px;transition:border-color 0.15s,background 0.15s;">
          <div style="font-size:28px;margin-bottom:6px;">📁</div>
          <div style="font-size:14px;font-weight:700;color:#c8d0e8;letter-spacing:0.5px;">SELECT FILE</div>
          <div style="font-size:11px;color:#5a80a8;margin-top:4px;line-height:1.6;">
            Tap to choose · Video: MP4 WebM MOV · Audio: MP3 WAV AAC · Image: JPG PNG WebP
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:12px;">
            <button type="button" id="ax-sub-btn-any"   style="padding:8px 16px;background:#0090cc;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;">📁 FILE</button>
            <button type="button" id="ax-sub-btn-photo" style="padding:8px 16px;background:rgba(0,174,239,0.12);color:#00AEEF;border:1px solid rgba(0,174,239,0.3);border-radius:6px;cursor:pointer;font-size:12px;">📷 PHOTO</button>
            <button type="button" id="ax-sub-btn-video" style="padding:8px 16px;background:rgba(0,174,239,0.12);color:#00AEEF;border:1px solid rgba(0,174,239,0.3);border-radius:6px;cursor:pointer;font-size:12px;">🎥 VIDEO</button>
            <button type="button" id="ax-sub-btn-audio" style="padding:8px 16px;background:rgba(0,174,239,0.12);color:#00AEEF;border:1px solid rgba(0,174,239,0.3);border-radius:6px;cursor:pointer;font-size:12px;">🎵 AUDIO</button>
          </div>
          <input type="file" id="ax-sub-file-any"   accept="audio/*,video/*,image/*" style="display:none;">
          <input type="file" id="ax-sub-file-photo" accept="image/*" capture="environment" style="display:none;">
          <input type="file" id="ax-sub-file-video" accept="video/*" capture="environment" style="display:none;">
          <input type="file" id="ax-sub-file-audio" accept="audio/*" style="display:none;">
        </div>
        <div id="ax-sub-file-info" style="display:none;background:#0d1f38;border:1px solid rgba(0,174,239,0.18);border-radius:8px;padding:12px 14px;margin-bottom:14px;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span id="ax-sub-file-icon" style="font-size:20px;flex-shrink:0;">📄</span>
            <div style="flex:1;min-width:0;">
              <div id="ax-sub-file-name" style="font-size:13px;font-weight:700;color:#c8d0e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
              <div id="ax-sub-file-meta" style="font-size:11px;color:#5a80a8;margin-top:2px;"></div>
            </div>
            <button type="button" id="ax-sub-file-clear" style="background:none;border:none;color:#5a80a8;cursor:pointer;font-size:16px;padding:4px;flex-shrink:0;">✕</button>
          </div>
        </div>
        <div id="ax-sub-progress" style="display:none;margin-bottom:14px;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;">
            <span id="ax-sub-progress-status" style="font-size:12px;color:#5a80a8;">Uploading…</span>
            <span id="ax-sub-progress-pct" style="font-size:12px;font-weight:700;color:#00AEEF;">0%</span>
          </div>
          <div style="height:6px;background:rgba(255,255,255,0.07);border-radius:3px;overflow:hidden;">
            <div id="ax-sub-progress-bar" style="height:100%;width:0%;background:#0090cc;border-radius:3px;transition:width 0.1s;"></div>
          </div>
          <div id="ax-sub-progress-bytes" style="font-size:10px;color:#5a80a8;margin-top:4px;text-align:right;"></div>
        </div>
        <div id="ax-sub-meta-fields">
          <div style="margin-bottom:10px;">
            <label style="display:block;font-size:11px;font-weight:700;color:#5a80a8;margin-bottom:4px;letter-spacing:0.5px;">TITLE *</label>
            <input id="ax-sub-title" placeholder="Track or content title" style="width:100%;padding:9px 12px;background:#0a1c35;border:1px solid rgba(0,174,239,0.22);border-radius:7px;color:#c8d0e8;font-size:13px;box-sizing:border-box;">
          </div>
          <div style="margin-bottom:10px;">
            <label style="display:block;font-size:11px;font-weight:700;color:#5a80a8;margin-bottom:4px;letter-spacing:0.5px;">ARTIST / CREATOR</label>
            <input id="ax-sub-artist" placeholder="Your name or artist name" style="width:100%;padding:9px 12px;background:#0a1c35;border:1px solid rgba(0,174,239,0.22);border-radius:7px;color:#c8d0e8;font-size:13px;box-sizing:border-box;">
          </div>
          <div style="margin-bottom:10px;">
            <label style="display:block;font-size:11px;font-weight:700;color:#5a80a8;margin-bottom:4px;letter-spacing:0.5px;">CONTENT TYPE</label>
            <select id="ax-sub-type" style="width:100%;padding:9px 12px;background:#0a1c35;border:1px solid rgba(0,174,239,0.22);border-radius:7px;color:#c8d0e8;font-size:13px;box-sizing:border-box;">
              <option value="music">🎵 Music</option>
              <option value="video">🎬 Video</option>
              <option value="funny_clip">😂 Funny Clip</option>
              <option value="short_film">🎥 Short Film</option>
              <option value="podcast">🎙 Podcast</option>
              <option value="music_video">🎞 Music Video</option>
              <option value="other">📦 Other</option>
            </select>
          </div>
        </div>
        <label style="display:flex;align-items:flex-start;gap:8px;margin-bottom:14px;cursor:pointer;">
          <input type="checkbox" id="ax-sub-rights" style="margin-top:3px;accent-color:#00AEEF;">
          <span style="font-size:11px;color:#5a80a8;line-height:1.5;">
            I confirm I have the right to submit this content.
            Shadow Nexus Social does not claim ownership of submitted content.
          </span>
        </label>
        <div id="ax-sub-err" style="display:none;color:#ff3344;font-size:12px;margin-bottom:10px;padding:8px 12px;background:rgba(255,51,68,0.08);border-radius:6px;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="ax-sub-cancel" style="padding:10px 20px;background:transparent;border:1px solid rgba(0,174,239,0.25);color:#5a80a8;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;">CANCEL</button>
          <button id="ax-sub-submit" disabled style="padding:10px 20px;background:#0090cc;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;opacity:0.5;">SUBMIT</button>
        </div>
      </div>
    </div>

    <!-- Toast -->
    <div id="ax-toast" role="status" aria-live="polite"></div>
  `;

  _bindPlayerControls();
  _bindSubmitModal();

  if (_channels.length) _buildChannelList();
  _buildEPGChannelTabs();
}

/* ════════════════════════════════════════════════════
   FOUNDER BAR
════════════════════════════════════════════════════ */
function _renderFounderBar() {
  const bar = document.getElementById('snx-tv-founder-bar');
  if (!bar) return;
  bar.style.display = 'block';
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 14px;flex-wrap:wrap;">
      <span style="color:#39FF14;font-weight:800;letter-spacing:1px;font-size:11px;">⚡ FOUNDER</span>
      <div style="flex:1;"></div>
      <button id="ax-submit-btn"
        style="padding:5px 13px;background:rgba(0,174,239,0.10);border:1px solid rgba(0,174,239,0.25);color:#00AEEF;border-radius:6px;cursor:pointer;font-size:11px;font-weight:700;letter-spacing:0.4px;">
        📤 Submit Content
      </button>
    </div>
    <!-- Network status (Main TV mode + emergency return) -->
    <div id="snx-tv-network-status" style="padding:0 14px 10px;"></div>`;
  document.getElementById('ax-submit-btn')?.addEventListener('click', _openSubmitModal);
  _updateNetworkStatus();
}

/**
 * Update the Network Status panel inside the founder bar.
 * Shows Main TV mode, featured creator (if any), live creator count,
 * and the emergency RETURN TO SCHEDULE button.
 */
function _updateNetworkStatus() {
  if (!_isFounder) return;
  const panel = document.getElementById('snx-tv-network-status');
  if (!panel) return;

  const st = _mainTvState;
  const isFeatured = st?.mode === 'featured_live';

  // Only show the panel when a creator is featured — otherwise stay minimal
  if (!isFeatured) {
    panel.innerHTML = '';
    return;
  }

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:6px 0;flex-wrap:wrap;border-top:1px solid rgba(57,255,20,0.10);">
      <div style="font-size:10px;color:#ff4d6a;font-weight:700;">🔴 FEATURED: <span style="color:#fff;">${_esc(st.featuredChannelName || 'Creator')}</span></div>
      <div style="flex:1;"></div>
      <button id="snx-tv-emergency-return-btn"
        style="padding:4px 12px;background:rgba(255,45,85,0.12);border:1px solid rgba(255,45,85,0.40);color:#ff4d6a;border-radius:5px;cursor:pointer;font-size:10px;font-weight:800;letter-spacing:0.5px;white-space:nowrap;">
        ↩ Return to Schedule
      </button>
    </div>`;

  document.getElementById('snx-tv-emergency-return-btn')?.addEventListener('click', () => {
    _showEmergencyReturnConfirm();
  });
}

async function _showEmergencyReturnConfirm() {
  if (!_isFounder || !_user) return;
  if (!confirm('⚡ EMERGENCY: Return Main TV to scheduled programming immediately?')) return;
  try {
    const { emergencyReturnToSchedule } = await import('./snx-main-tv-feature.js');
    await emergencyReturnToSchedule(_user);
    console.log('[SNX-TV] Emergency return executed');
  } catch (err) {
    console.error('[SNX-TV] Emergency return failed:', err.message);
  }
}

/** Subscribe to Main TV state (called once after user is known). */
function _subscribeMainTvState() {
  if (_mainTvUnsub) return;
  import('./snx-main-tv-feature.js').then(({ subscribeMainTvState }) => {
    _mainTvUnsub = subscribeMainTvState(st => {
      _mainTvState = st;
      _onMainTvStateChange(st);
    });
  }).catch(err => {
    console.warn('[SNX-TV] Main TV state subscription failed:', err.message);
  });
}

/**
 * Called every time mainTvState/current changes.
 * Responsible for switching the player between scheduled and featured_live.
 */
async function _onMainTvStateChange(st) {
  // Update founder network status panel
  if (_isFounder) _updateNetworkStatus();

  const isFeatured = st?.mode === 'featured_live' && st?.featuredLiveId;
  const mediaArea  = document.getElementById('ax-media-area');

  if (isFeatured && !_featureMounted) {
    // Show "NOW JOINING LIVE" transition overlay (non-blocking)
    try {
      const tvNet = await import('./snx-tv-network.js');
      if (tvNet.showFeatureTransition) tvNet.showFeatureTransition(st.featuredChannelName || 'Creator');
    } catch (_) {}

    // Switch to featured live
    _featureMounted = true;
    _stopMedia();    // pause scheduled media — schedule keeps advancing in background
    _setNowPlaying(`🔴 LIVE: ${st.featuredChannelName || 'Creator'}`, st.featuredLiveTitle || '', 'featured_live');
    _setLiveStatus('live');

    try {
      const { mountFeaturedLiveInPlayer } = await import('./snx-main-tv-feature.js');
      await mountFeaturedLiveInPlayer(_user, null, st, mediaArea, reason => {
        console.log('[SNX-TV] Featured live ended, reason:', reason, '— returning to schedule');
        _featureMounted = false;
        import('./snx-main-tv-feature.js').then(m => m.dismountFeaturedLiveFromPlayer()).catch(() => {});
        // Resume current scheduled item at correct elapsed position
        const schedSt = _activeChannel ? _channelStates[_activeChannel.id] : null;
        if (schedSt?.current_item) {
          _currentMediaId = null;
          _transitioning  = false;
          setTimeout(() => _onActiveChannelUpdate(schedSt), 500);
        }
      });
    } catch (err) {
      console.warn('[SNX-TV] Featured live mount failed:', err.message, '— falling back to schedule');
      _featureMounted = false;
      const schedSt = _activeChannel ? _channelStates[_activeChannel.id] : null;
      if (schedSt?.current_item) _onActiveChannelUpdate(schedSt);
    }

  } else if (!isFeatured && _featureMounted) {
    // Show "RETURNING TO MAIN TV" transition overlay (non-blocking)
    try {
      const tvNet = await import('./snx-tv-network.js');
      if (tvNet.showReturnToProgramming) tvNet.showReturnToProgramming();
    } catch (_) {}

    // Return to scheduled programming
    _featureMounted = false;
    try {
      const { dismountFeaturedLiveFromPlayer } = await import('./snx-main-tv-feature.js');
      dismountFeaturedLiveFromPlayer();
    } catch (_) {}

    // Resume scheduled media at CURRENT position (not from the beginning)
    const schedSt = _activeChannel ? _channelStates[_activeChannel.id] : null;
    if (schedSt?.current_item) {
      _currentMediaId = null; // force reload at correct elapsed position
      _transitioning  = false;
      setTimeout(() => _onActiveChannelUpdate(schedSt), 200);
    } else {
      _setNowPlaying('Standby…', '', '');
    }
    _setLiveStatus('live');

  } else if (!isFeatured && !_featureMounted) {
    // Normal state change (scheduled → scheduled, content update etc.) — nothing to do
  }
}

/* ════════════════════════════════════════════════════
   TAB SWITCHING
════════════════════════════════════════════════════ */
window.snxTvSwitchTab = function(tab) {
  // Studio tab is strictly founder-only. Any attempt by a non-founder to
  // navigate to the Studio — including direct console calls — is silently
  // ignored; the Watch panel stays visible and no studio DOM is shown.
  if (tab === 'studio' && !_isFounder) return;

  ['watch','studio'].forEach(t => {
    const p = document.getElementById(`snxTvPanel_${t}`);
    const b = document.getElementById(`snxTvTab${t.charAt(0).toUpperCase()+t.slice(1)}`);
    if (p) p.style.display = (t === tab) ? '' : 'none';
    if (b) b.classList.toggle('active', t === tab);
  });

  if (tab === 'studio' && _isFounder) {
    _openStudio();
  } else if (tab === 'watch') {
    _startTick();
  }
};

function _openStudio() {
  // Founder-only — hard gate in addition to the tab-switch guard above.
  if (!_isFounder || !_user) return;
  const ctrl = document.getElementById('ax-control');
  if (!ctrl) return;
  if (ctrl.innerHTML.trim()) return; // already mounted

  ctrl.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:200px;gap:12px;padding:32px 20px;text-align:center;">
      <div style="font-size:28px;">⚙</div>
      <div style="font-size:13px;font-weight:700;color:#00AEEF;letter-spacing:1px;">LOADING CHANNEL STUDIO…</div>
    </div>`;

  import('./snx-ch-control.js')
    .then(m => m.mountControl(_user, _isFounder))
    .catch(err => {
      console.error('[SNX-TV] Studio failed to load:', err);
      ctrl.innerHTML = `
        <div style="padding:24px 20px;text-align:center;">
          <div style="font-size:13px;color:#ff3344;margin-bottom:10px;">Studio failed to load</div>
          <div style="font-size:11px;color:#5a80a8;">${_esc(err?.message || 'Unknown error')}</div>
          <button onclick="document.getElementById('ax-control').innerHTML='';snxTvSwitchTab('studio')"
            style="margin-top:14px;padding:8px 20px;background:#0090cc;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;">
            RETRY
          </button>
        </div>`;
    });
}

/* ════════════════════════════════════════════════════
   CHANNEL LIST + EPG  (reuse broadcast.js helpers)
════════════════════════════════════════════════════ */
function _buildChannelList() {
  const list = document.getElementById('ax-channel-list');
  if (!list) return;
  if (!_channels.length) {
    list.innerHTML = '<div style="padding:14px;color:#5a80a8;font-size:12px;">No channels available.</div>';
    return;
  }
  const icons = { LIVE:'🔴',ONE:'🔴',MUSIC:'🎵',VIDEO:'🎬',FUNNY:'😂','AFTER DARK':'🌙',
    GAMING:'🎮',HORROR:'👻',SPORTS:'⚽',CONCERTS:'🎤',COMEDY:'😄',MOVIES:'🎞',
    PODCASTS:'🎙','SCI-FI':'🚀',CLASSICS:'📺' };
  list.innerHTML = _channels.map((ch, idx) => {
    const icon = icons[ch.label?.toUpperCase()] || icons[ch.name?.split(' ').pop()?.toUpperCase()] || '📺';
    const num  = String(idx + 1).padStart(2, '0');
    const isActive = _activeChannel?.id === ch.id;
    return `
    <button class="ax-channel-btn ${isActive ? 'active' : ''}" data-chid="${ch.id}"
            style="${isActive && ch.color ? `border-left-color:${ch.color};` : ''}">
      <span class="ax-ch-num">${num}</span>
      <span class="ax-ch-icon">${icon}</span>
      <span class="ax-ch-name">${_esc(ch.label || ch.name)}</span>
      <span class="ax-ch-status ${_channelStates[ch.id]?.current_item ? 'live' : 'idle'}" id="ax-ch-dot-${ch.id}"></span>
    </button>`;
  }).join('');
  list.querySelectorAll('.ax-channel-btn').forEach(btn => {
    btn.addEventListener('click', () => _setActiveChannel(btn.dataset.chid));
  });
}

function _buildEPGChannelTabs() {
  const tabs = document.getElementById('ax-epg-tabs');
  if (!tabs) return;
  tabs.innerHTML = _channels.map((ch, idx) => `
    <button class="ax-epg-tab ${idx === 0 ? 'active' : ''}" data-chid="${ch.id}">
      ${_esc(ch.label || ch.name)}
    </button>`).join('');
  tabs.querySelectorAll('.ax-epg-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.ax-epg-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _renderEPG(btn.dataset.chid);
    });
  });
  if (_activeChannel) _renderEPG(_activeChannel.id);
  else if (_channels[0]) _renderEPG(_channels[0].id);
}

function _renderEPG(channelId) {
  const body = document.getElementById('ax-epg-body');
  if (!body) return;
  const ch = _channels.find(c => c.id === channelId);
  const st = _channelStates[channelId];
  if (!st?.current_item) {
    body.innerHTML = `<div style="padding:14px;color:#5a80a8;font-size:12px;">No programming scheduled for ${_esc(ch?.name || channelId)}.</div>`;
    return;
  }
  const cur       = st.current_item;
  const queue     = st.queue || [];
  const commQ     = st.commercial_queue || [];
  const isComm    = !!(st.is_commercial);
  const startedAt = st.started_at?.toMillis?.() || Date.now();
  const elapsed   = Math.max(0, (Date.now() - startedAt) / 1000);
  const dur       = cur.duration_sec || 0;
  const remain    = dur > 0 ? Math.max(0, dur - elapsed) : null;
  const eligible  = queue.filter(q => q?.id && q?.url);
  const curIdx    = eligible.findIndex(q => q.id === cur.id);
  const upcoming  = curIdx >= 0 ? eligible.slice(curIdx + 1, curIdx + 6) : eligible.slice(0, 5);
  const typeIcons = { music:'🎵',audio:'🎵',video:'🎬',funny_clip:'😂',short_film:'🎥',
    podcast:'🎙',music_video:'🎞',commercial:'📢',promo:'📢',station_id:'📻',
    show:'📺',broadcast_clip:'🎬',archive:'📼',trailer:'🎞',other:'📦' };
  const ic = t => typeIcons[t] || '▶';
  body.innerHTML = `
    <div class="ax-epg-row current">
      <div class="ax-epg-badge">${isComm ? '📢 BREAK' : '🔴 NOW'}</div>
      <div class="ax-epg-info">
        <div class="ax-epg-title">${ic(cur.type)} ${_esc(cur.title)}</div>
        <div class="ax-epg-meta">${_esc(cur.artist || cur.type || '')}${dur > 0 ? ' · ' + _fmtTime(elapsed) + ' / ' + _fmtTime(dur) : ''}</div>
      </div>
      ${remain !== null ? `<div class="ax-epg-remain">-${_fmtTime(remain)}</div>` : ''}
    </div>
    ${upcoming.map((item, i) => `
      <div class="ax-epg-row">
        <div class="ax-epg-badge" style="opacity:${0.7 - i * 0.1};">${i === 0 ? 'NEXT' : 'LATER'}</div>
        <div class="ax-epg-info">
          <div class="ax-epg-title">${ic(item.type)} ${_esc(item.title)}</div>
          <div class="ax-epg-meta">${_esc(item.artist || item.type || '')}${item.duration_sec ? ' · ' + _fmtTime(item.duration_sec) : ''}</div>
        </div>
      </div>`).join('')}
    ${!upcoming.length && !commQ.length ? '<div style="padding:10px;color:#5a80a8;font-size:12px;">No upcoming programs.</div>' : ''}`;
}

function _updateUpNext() {
  if (_activeChannel) {
    const st = _channelStates[_activeChannel.id];
    if (st) _renderUpNext_from(st);
  }
}

/* ════════════════════════════════════════════════════
   CHANNEL STATE SUBSCRIPTION
════════════════════════════════════════════════════ */
function _subscribeChannelState(channelId) {
  if (_channelUnsubs[channelId]) return;
  _channelUnsubs[channelId] = onSnapshot(doc(db, 'network_state', channelId), (snap) => {
    const st = snap.exists() ? snap.data() : null;
    if (_activeChannel?.id === channelId) console.log('[24TV] Channel state received — channel:', channelId, 'current_item:', st?.current_item?.title || 'none');
    _channelStates[channelId] = st;

    // Update channel dot
    const dot = document.getElementById(`ax-ch-dot-${channelId}`);
    if (dot) dot.className = `ax-ch-status ${st?.current_item ? 'live' : 'idle'}`;

    // Update EPG if this channel is visible
    const activeEPGTab = document.querySelector('.ax-epg-tab.active');
    if (activeEPGTab?.dataset.chid === channelId) _renderEPG(channelId);

    if (_activeChannel?.id === channelId) _onActiveChannelUpdate(st);
  }, (err) => {
    console.warn(`[SNX-TV] Firestore error channel=${channelId} — resubscribing`, err?.message);
    delete _channelUnsubs[channelId];
    setTimeout(() => {
      if (!_channelUnsubs[channelId]) _subscribeChannelState(channelId);
    }, 3000);
  });
}

function _setActiveChannel(channelId) {
  const ch = _channels.find(c => c.id === channelId);
  if (!ch) return;
  _activeChannel = ch;

  const badgeNum  = document.getElementById('ax-badge-num');
  const badgeName = document.getElementById('ax-badge-name');
  const badge     = document.getElementById('ax-channel-badge');
  const chIdx     = _channels.indexOf(ch);
  if (badgeNum)  badgeNum.textContent  = String(chIdx + 1).padStart(2, '0');
  if (badgeName) badgeName.textContent = ch.name;
  if (badge && ch.color) badge.style.background = ch.color;

  document.querySelectorAll('.ax-channel-btn').forEach(btn => {
    const isActive = btn.dataset.chid === channelId;
    btn.classList.toggle('active', isActive);
    if (isActive && ch.color) btn.style.borderLeftColor = ch.color;
    else btn.style.borderLeftColor = '';
  });
  document.querySelectorAll('.ax-epg-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.chid === channelId);
  });
  _renderEPG(channelId);
  _stopMedia();
  const st = _channelStates[channelId];
  if (st) _onActiveChannelUpdate(st);
  else { _setNowPlaying(ch.name, '', ''); }
}

function _onActiveChannelUpdate(st) {
  console.log('[24TV] Channel update — channel:', _activeChannel?.id, 'item:', st?.current_item?.title || 'none', 'gateOpen:', _gateOpen);
  if (!st || !st.current_item) {
    _setNowPlaying('Standby…', '', '');
    _setLiveStatus('offair');
    _renderUpNext_from(null);
    if (!_featureMounted) _stopMedia(); // don't stop featured live when schedule has no item
    return;
  }

  // Stage 4: While a featured live is mounted, update Now Playing info but
  // do NOT load scheduled media into the player — the featured live occupies it.
  if (_featureMounted) {
    // Update Up Next so the guide stays accurate
    const queue  = (st.queue || []).filter(q => q?.id && q?.url);
    const curIdx = queue.findIndex(q => q.id === st.current_item.id);
    const upNext = curIdx >= 0 ? queue.slice(curIdx + 1, curIdx + 4) : queue.slice(0, 3);
    _renderUpNext_from({ queue: upNext });
    return;
  }
  const item   = st.current_item;
  const isComm = !!(st.is_commercial);
  _setNowPlaying(item.title, item.artist || '', item.type || '');
  _updateLiveTVOverlay(item, isComm);

  const queue  = (st.queue || []).filter(q => q?.id && q?.url);
  const curIdx = queue.findIndex(q => q.id === item.id);
  const upNext = curIdx >= 0 ? queue.slice(curIdx + 1, curIdx + 4)
    : queue.slice(0, 3);
  _renderUpNext_from({ queue: upNext });

  if (!_gateOpen) return;

  if (_currentMediaId === item.id && !_isMediaStale()) return;

  const raw     = st.started_at;
  const startMs = raw?.toMillis?.() || (typeof raw === 'number' ? (raw < 1e10 ? raw * 1000 : raw) : Date.now());
  const elapsed = Math.max(0, (Date.now() - startMs) / 1000);
  const dur     = item.duration_sec || 0;

  if (dur > 0 && elapsed >= dur - 1) {
    _viewerRequestAdvance(_activeChannel.id, item.id);
    return;
  }

  _transitioning = true;
  _currentMediaId = item.id;
  _loadMedia(item, elapsed).finally(() => { _transitioning = false; });
}

/* ════════════════════════════════════════════════════
   MEDIA LOADING  (identical logic to broadcast.js)
════════════════════════════════════════════════════ */
function _isMediaStale() {
  if (!_mediaEl) return true;
  if (_mediaEl.error) return true;
  if (_mediaEl.readyState === 0) return true;
  return false;
}

async function _loadMedia(item, elapsed) {
  // FIX: abort immediately if the TV page has been torn down while this
  // async call was pending (e.g. rapid navigation away then back).
  if (!_tvActive) return;

  console.log('[24TV] Loading media — title:', item.title, 'url:', item.url?.slice(0, 80), 'elapsed:', elapsed.toFixed(1) + 's');
  const video = document.getElementById('ax-video');
  const audio = document.getElementById('ax-audio');
  const thumb = document.getElementById('ax-thumbnail');
  if (!video || !audio || !thumb) return;

  // Detect media type — check type field, MIME type, and URL extension.
  const isImage = (
    item.type === 'thumbnail' ||
    /\.(jpe?g|png|gif|webp|svg|avif)(\?|$)/i.test(item.url) ||
    (item.mime_type || '').startsWith('image/')
  );
  const isVideo = !isImage && (
    item.type === 'video' || item.type === 'music_video' ||
    item.type === 'show'  || item.type === 'broadcast_clip' ||
    item.type === 'archive' || item.type === 'trailer' ||
    item.type === 'funny_clip' || item.type === 'short_film' ||
    /\.(mp4|webm|mov|avi|wmv|mpeg)(\?|$)/i.test(item.url) ||
    (item.mime_type || '').startsWith('video/')
  );

  console.log(
    `[24TV] Media type: ${isVideo ? 'VIDEO' : isImage ? 'IMAGE' : 'AUDIO'}\n` +
    `  url: ${item.url?.slice(0, 80)}\n` +
    `  type field: ${item.type}  mime: ${item.mime_type || '—'}`
  );

  // stop previous
  video.pause(); audio.pause();
  video.src = ''; audio.src = '';
  video.style.display = 'none';

  _mediaEl = null; _mediaType = null;

  if (isImage) {
    thumb.innerHTML = `<img src="${_esc(item.url)}" alt="${_esc(item.title)}" style="width:100%;height:100%;object-fit:contain;">`;
    thumb.style.display = '';
    _mediaType = 'image';
    console.log('[24TV] Rendering: IMAGE');
    const dur = item.duration_sec || 30;
    setTimeout(() => {
      if (_currentMediaId === item.id) _viewerRequestAdvance(_activeChannel?.id, item.id);
    }, dur * 1000);
    return;
  }

  thumb.style.display = 'none';

  if (isVideo) {
    _mediaEl = video;
    _mediaType = 'video';
    // Must use 'block', not '' — CSS rule .ax-media-area video { display: none; }
    // would re-apply if we clear the inline style with an empty string.
    video.style.display = 'block';
    console.log('[24TV] Rendering: VIDEO — display set to block');
  } else {
    _mediaEl = audio;
    _mediaType = 'audio';
    video.style.display = 'none';
    console.log('[24TV] Rendering: AUDIO');
  }

  _mediaEl.volume = parseFloat(document.getElementById('ax-vol-slider')?.value || '0.8');
  _mediaEl.muted  = false;
  _mediaEl.src    = item.url;
  console.log('[24TV] Player created — type:', isVideo ? 'video' : 'audio', '— src assigned:', item.url?.slice(0, 80));

  // PiP button visibility
  const pip = document.getElementById('ax-pip-btn');
  if (pip) pip.style.display = (isVideo && document.pictureInPictureEnabled) ? '' : 'none';

  _mediaEl.addEventListener('ended', _onMediaEnded, { once: true });
  _mediaEl.addEventListener('error', _onMediaError, { once: true });
  _mediaEl.addEventListener('loadedmetadata', () => {
    if (isVideo) {
      const v = document.getElementById('ax-video');
      console.log(
        `[24TV VIDEO] metadata loaded — videoWidth=${v?.videoWidth}  videoHeight=${v?.videoHeight}` +
        `  display=${v?.style.display}  rect=${JSON.stringify(v?.getBoundingClientRect?.())}`
      );
    }
    if (_mediaEl && elapsed > 1) {
      try { _mediaEl.currentTime = Math.min(elapsed, (_mediaEl.duration || elapsed) - 0.5); } catch (_) {}
    }
  }, { once: true });
  if (isVideo) {
    _mediaEl.addEventListener('canplay', () => {
      const v = document.getElementById('ax-video');
      console.log(`[24TV VIDEO] can play — display=${v?.style.display}  rect=${JSON.stringify(v?.getBoundingClientRect?.())}`);
    }, { once: true });
    _mediaEl.addEventListener('playing', () => {
      const v = document.getElementById('ax-video');
      console.log(`[24TV VIDEO] playing — videoWidth=${v?.videoWidth}  videoHeight=${v?.videoHeight}  display=${v?.style.display}  rect=${JSON.stringify(v?.getBoundingClientRect?.())}`);
      _setLiveStatus('live');
    }, { once: true });
    _mediaEl.addEventListener('error', (e) => {
      console.error(`[24TV VIDEO ERROR]`, _mediaEl.error?.code, _mediaEl.error?.message, e);
    }, { once: true });
  } else {
    // Audio: set live once playing
    _mediaEl.addEventListener('playing', () => { _setLiveStatus('live'); }, { once: true });
  }

  _updatePlayBtn();
  console.log('[24TV] Playback requested — attempting autoplay with sound');

  // ── AUTOPLAY STRATEGY ────────────────────────────────────────────────────────
  // 1. Try normal (audible) autoplay.
  // 2. If blocked, try muted autoplay — video continues playing, show Tap for Sound.
  // 3. If even muted is blocked, show a minimal play button on the player face.
  // Never show a full-screen gate or Watch Now screen.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    await _mediaEl.play();
    // FIX: check _tvActive after the async play() resolves — user may have
    // navigated away during the await, in which case we must stop immediately.
    if (!_tvActive) { _stopMediaFull(); return; }
    console.log('[24TV] Autoplay with sound ✓');
    const ts = document.getElementById('ax-tap-sound');
    if (ts) ts.style.display = 'none';
    _hideTvGate();
  } catch (audibleErr) {
    if (!_tvActive) return; // navigated away during await
    console.log('[24TV] Audible autoplay blocked (' + audibleErr?.name + ') — trying muted');
    try {
      _mediaEl.muted = true;
      await _mediaEl.play();
      if (!_tvActive) { _stopMediaFull(); return; }
      console.log('[24TV] Muted autoplay ✓ — showing Tap for Sound');
      _updateMuteBtn();
      _hideTvGate();
      // Show a small "Tap for Sound" pill on the player — NOT a full-screen overlay.
      const ts = document.getElementById('ax-tap-sound');
      if (ts) ts.style.display = 'block';
    } catch (mutedErr) {
      console.log('[24TV] Muted autoplay also blocked (' + mutedErr?.name + ') — viewer interaction needed');
      // Even muted is blocked (unusual). Show the legacy gate as last resort.
      const gate = document.getElementById('ax-gate');
      if (gate) {
        gate.style.display = 'flex';
        const sub = gate.querySelector('.ax-gate-sub');
        if (sub) sub.textContent = 'Tap to start watching';
        // Gate button will call _enterBroadcast which re-calls _onActiveChannelUpdate → _loadMedia.
      }
    }
  }
}

function _onMediaEnded() {
  if (_activeChannel && _currentMediaId) {
    _viewerRequestAdvance(_activeChannel.id, _currentMediaId);
  }
}

function _onMediaError() {
  _onerrorRetries = (_onerrorRetries || 0) + 1;
  if (_onerrorRetries <= 3 && _currentMediaId) {
    setTimeout(() => {
      const st = _channelStates[_activeChannel?.id];
      if (st?.current_item?.id === _currentMediaId) {
        const raw = st.started_at;
        const startMs = raw?.toMillis?.() || Date.now();
        const elapsed = Math.max(0, (Date.now() - startMs) / 1000);
        _loadMedia(st.current_item, elapsed);
      }
    }, 2000);
  } else {
    if (_activeChannel && _currentMediaId) _viewerRequestAdvance(_activeChannel.id, _currentMediaId);
  }
}

/* ════════════════════════════════════════════════════
   STOP MEDIA
════════════════════════════════════════════════════ */

/**
 * Full stop: pause, clear src, and call load() to release the browser's
 * media pipeline completely.  Use on page exit / re-init to ensure
 * no stale audio leaks after navigation.
 */
function _stopMediaFull() {
  const video = document.getElementById('ax-video');
  const audio = document.getElementById('ax-audio');
  if (video) {
    try { video.pause(); } catch (_) {}
    video.removeAttribute('src');
    try { video.load(); } catch (_) {}
    video.style.display = 'none';
  }
  if (audio) {
    try { audio.pause(); } catch (_) {}
    audio.removeAttribute('src');
    try { audio.load(); } catch (_) {}
  }
  _mediaEl = null; _mediaType = null;
  _currentMediaId = null;
}

/**
 * Lightweight stop used during channel switches or item advances.
 * Does NOT call load() — cheaper, and re-entry is expected shortly.
 */
function _stopMedia() {
  const video = document.getElementById('ax-video');
  const audio = document.getElementById('ax-audio');
  if (video) { try { video.pause(); } catch (_) {} video.src = ''; video.style.display = 'none'; }
  if (audio) { try { audio.pause(); } catch (_) {} audio.src = ''; }
  _mediaEl = null; _mediaType = null;
}

/* ════════════════════════════════════════════════════
   NOW PLAYING
════════════════════════════════════════════════════ */
function _setNowPlaying(title, artist, type) {
  const t = document.getElementById('ax-np-title');
  const a = document.getElementById('ax-np-artist');
  const pt = document.getElementById('ax-np-panel-title');
  const pm = document.getElementById('ax-np-panel-meta');
  if (t)  t.textContent  = title  || 'Standby…';
  if (a)  a.textContent  = artist || '';
  if (pt) pt.textContent = title  || '—';
  if (pm) pm.textContent = artist ? `${artist}${type ? ' · ' + type : ''}` : (type || '—');
}

function _renderUpNext_from(st) {
  const list = document.getElementById('ax-up-next-list');
  if (!list) return;
  const items = st?.queue || [];
  if (!items.length) {
    list.innerHTML = '<div style="padding:14px;color:#5a80a8;font-size:12px;">Nothing scheduled.</div>';
    return;
  }
  const typeIcons = { music:'🎵',audio:'🎵',video:'🎬',funny_clip:'😂',podcast:'🎙',
    music_video:'🎞',show:'📺',other:'📦' };
  list.innerHTML = items.slice(0, 5).map(item => `
    <div class="ax-schedule-item">
      <div class="ax-schedule-type">${typeIcons[item.type] || '▶'}</div>
      <div class="ax-schedule-info">
        <div class="ax-schedule-title">${_esc(item.title)}</div>
        <div class="ax-schedule-artist">${_esc(item.artist || '')}</div>
      </div>
    </div>`).join('');
}

/* ════════════════════════════════════════════════════
   LIVE TV OVERLAY (commercial / live badges)
════════════════════════════════════════════════════ */
function _updateLiveTVOverlay(item, isComm) {
  const liveEl = document.getElementById('ax-one-viewer-live');
  const commEl = document.getElementById('ax-one-viewer-comm');
  if (liveEl) liveEl.style.display = (!isComm && item) ? '' : 'none';
  if (commEl) commEl.style.display = isComm ? '' : 'none';
}

/* ════════════════════════════════════════════════════
   ADVANCE REQUEST
════════════════════════════════════════════════════ */
async function _viewerRequestAdvance(channelId, currentItemId) {
  if (_advancing) return;
  if (_viewerAdvancingId === currentItemId) return;
  _viewerAdvancingId = currentItemId;
  _advancing = true;
  try {
    const token = await _user?.getIdToken?.();
    if (!token) { _advancing = false; return; }
    const res = await fetch(ADVANCE_WORKER_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId, currentItemId }),
    });
    if (!res.ok) console.warn(`[SNX-TV] advance ${res.status}`);
  } catch (e) {
    console.warn('[SNX-TV] advance error:', e.message);
  } finally {
    _advancing = false;
    setTimeout(() => { if (_viewerAdvancingId === currentItemId) _viewerAdvancingId = null; }, 5000);
  }
}

/* ════════════════════════════════════════════════════
   TICK (periodic position check)
════════════════════════════════════════════════════ */
function _startTick() {
  _stopTick();
  _tickTimer = setInterval(_tick, 800);
}
function _stopTick() {
  clearInterval(_tickTimer); _tickTimer = null;
}

function _tick() {
  if (!_tvActive) return;
  _tickProgress();

  if (!_activeChannel || !_gateOpen) return;
  const st  = _channelStates[_activeChannel.id];
  if (!st?.current_item) return;
  const item = st.current_item;
  const dur  = item.duration_sec || 0;
  if (dur <= 0) return;
  const raw     = st.started_at;
  const startMs = raw?.toMillis?.() || Date.now();
  const elapsed = Math.max(0, (Date.now() - startMs) / 1000);
  if (elapsed >= dur - 0.5) _viewerRequestAdvance(_activeChannel.id, item.id);
}

function _tickProgress() {
  if (!_mediaEl || !_gateOpen) return;
  const cur = _mediaEl.currentTime || 0;
  const dur = _mediaEl.duration   || 0;

  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
  ['ax-progress-fill','ax-fs-progress-fill'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.width = pct + '%';
  });

  ['ax-time-elapsed','ax-fs-time-elapsed'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = _fmtTime(cur);
  });
  ['ax-time-total','ax-fs-time-total'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = dur > 0 ? _fmtTime(dur) : '—';
  });
  const remEl = document.getElementById('ax-time-remaining');
  if (remEl) remEl.textContent = dur > 0 ? '-' + _fmtTime(dur - cur) : '';

  const panelTimeEl = document.getElementById('ax-np-panel-time');
  if (panelTimeEl) panelTimeEl.textContent = `${_fmtTime(cur)} / ${dur > 0 ? _fmtTime(dur) : '—'}`;
  const panelRemEl = document.getElementById('ax-np-panel-remain');
  if (panelRemEl && dur > 0) panelRemEl.textContent = `${_fmtTime(dur - cur)} remaining`;

  _updatePlayBtn();
}

/* ════════════════════════════════════════════════════
   PLAYER CONTROLS
════════════════════════════════════════════════════ */
// Hide the legacy gate element (it now starts hidden anyway).
function _hideTvGate() {
  const gate = document.getElementById('ax-gate');
  if (gate) gate.style.display = 'none';
}

function _enterBroadcast() {
  // Legacy handler — kept for the hidden gate button's onclick.
  console.log('[24TV] Gate entered — starting playback');
  _gateOpen = true;
  _hideTvGate();
  const st = _channelStates[_activeChannel?.id];
  if (st?.current_item) _onActiveChannelUpdate(st);
  _startTick();
}

// Update the ● status indicator in the header.
function _setLiveStatus(status) {
  // status: 'connecting' | 'live' | 'offair' | 'reconnecting'
  const dot  = document.getElementById('snx-tv-status-dot');
  const text = document.getElementById('snx-tv-status-text');
  if (!dot || !text) return;
  const cfg = {
    connecting:   { color: '#5a80a8', anim: true,  label: 'CONNECTING'   },
    live:         { color: '#39FF14', anim: true,  label: 'LIVE'         },
    offair:       { color: '#5a80a8', anim: false, label: 'OFF AIR'      },
    reconnecting: { color: '#b8860b', anim: true,  label: 'RECONNECTING' },
  };
  const c = cfg[status] || cfg.connecting;
  dot.style.background  = c.color;
  dot.style.animation   = c.anim ? 'snxTvDot 1.4s ease-in-out infinite' : 'none';
  dot.style.boxShadow   = c.anim ? `0 0 7px ${c.color}` : 'none';
  text.textContent      = c.label;
  text.style.color      = c.color;
}

// Reconnect after background return / bfcache — resync to current broadcast position.
function _viewerReconnect(reason) {
  if (!_tvActive || !_gateOpen || !_activeChannel) return;
  const st = _channelStates[_activeChannel.id];
  if (!st?.current_item?.url) {
    _setLiveStatus('reconnecting');
    return;
  }
  const item = st.current_item;
  const raw  = st.started_at;
  const startMs = raw?.toMillis?.() || (typeof raw === 'number' ? (raw < 1e10 ? raw * 1000 : raw) : Date.now());
  const elapsed = Math.max(0, (Date.now() - startMs) / 1000);
  const dur     = item.duration_sec || 0;

  console.log(`[24TV] Reconnect (${reason}) — channel:${_activeChannel.id}  item:${item.id}  elapsed:${elapsed.toFixed(1)}s`);

  _setLiveStatus('reconnecting');

  // If the player is already on the right item and alive, just seek forward.
  if (_currentMediaId === item.id && _mediaEl && !_mediaEl.error &&
      _mediaEl.src && _mediaEl.src !== window.location.href && !_mediaEl.ended) {
    const drift = Math.abs(_mediaEl.currentTime - elapsed);
    if (drift > 5) {
      try { _mediaEl.currentTime = Math.min(elapsed, (_mediaEl.duration || elapsed) - 0.5); } catch (_) {}
    }
    if (_mediaEl.paused) _mediaEl.play().catch(() => {});
    _setLiveStatus('live');
    return;
  }

  // Player is stale — reload the current item at the correct position.
  _currentMediaId = null;
  _transitioning  = false;
  _loadMedia(item, elapsed).then(() => _setLiveStatus('live')).catch(() => _setLiveStatus('reconnecting'));
}

function _togglePlayPause() {
  if (!_mediaEl) return;
  if (_mediaEl.paused) _mediaEl.play().catch(() => {});
  else _mediaEl.pause();
  _updatePlayBtn();
}

function _updatePlayBtn() {
  ['ax-play-btn','ax-fs-play-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = (_mediaEl && !_mediaEl.paused) ? '⏸' : '▶';
  });
}

function _updateMuteBtn() {
  const muted = _mediaEl?.muted;
  ['ax-mute-btn','ax-fs-mute-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
  });
}

function _toggleFullscreen() {
  const container = document.getElementById('ax-fs-container');
  if (!container) return;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else container.requestFullscreen().catch(() => {});
}

function _showFsOverlay() {
  const overlay = document.getElementById('ax-fs-overlay');
  const container = document.getElementById('ax-fs-container');
  if (!overlay) return;
  overlay.classList.add('visible');
  if (container) container.classList.remove('ax-fs-hide-cursor');
  clearTimeout(_fsHideTimer);
  _fsHideTimer = setTimeout(() => {
    overlay.classList.remove('visible');
    if (container) container.classList.add('ax-fs-hide-cursor');
  }, 3000);
}

function _bindPlayerControls() {
  document.getElementById('ax-gate-btn')?.addEventListener('click', _enterBroadcast);

  // Tap-for-sound: unmute the running player in-place (no restart, no reload).
  document.getElementById('ax-tap-sound-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_mediaEl) {
      _mediaEl.muted  = false;
      _mediaEl.volume = parseFloat(document.getElementById('ax-vol-slider')?.value || '0.8');
    }
    const ts = document.getElementById('ax-tap-sound');
    if (ts) ts.style.display = 'none';
    _updateMuteBtn();
  });

  document.getElementById('ax-media-area')?.addEventListener('click', (e) => {
    if (e.target.closest('#ax-tap-sound')) return;
    if (e.target.closest('#ax-gate') || e.target.closest('.ax-fs-overlay')) return;
    if (!_gateOpen) { _enterBroadcast(); return; }
    if (document.fullscreenElement) { _showFsOverlay(); return; }
    _togglePlayPause();
  });
  document.getElementById('ax-play-btn')?.addEventListener('click', _togglePlayPause);

  const volSlider = document.getElementById('ax-vol-slider');
  volSlider?.addEventListener('input', () => {
    if (_mediaEl) _mediaEl.volume = parseFloat(volSlider.value);
    const fsVol = document.getElementById('ax-fs-vol-slider');
    if (fsVol) fsVol.value = volSlider.value;
    _updateMuteBtn();
  });
  document.getElementById('ax-mute-btn')?.addEventListener('click', () => {
    if (_mediaEl) _mediaEl.muted = !_mediaEl.muted;
    _updateMuteBtn();
  });
  document.getElementById('ax-fs-btn')?.addEventListener('click', _toggleFullscreen);
  document.getElementById('ax-pip-btn')?.addEventListener('click', () => {
    const v = document.getElementById('ax-video');
    if (document.pictureInPictureElement) document.exitPictureInPicture();
    else if (v && v.style.display !== 'none') v.requestPictureInPicture().catch(() => {});
  });
  document.getElementById('ax-fs-play-btn')?.addEventListener('click', (e) => {
    e.stopPropagation(); _togglePlayPause(); _showFsOverlay();
  });
  document.getElementById('ax-fs-mute-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (_mediaEl) _mediaEl.muted = !_mediaEl.muted;
    _updateMuteBtn(); _showFsOverlay();
  });
  const fsVolSlider = document.getElementById('ax-fs-vol-slider');
  fsVolSlider?.addEventListener('input', (e) => {
    e.stopPropagation();
    const v = parseFloat(fsVolSlider.value);
    if (_mediaEl) _mediaEl.volume = v;
    const normVol = document.getElementById('ax-vol-slider');
    if (normVol) normVol.value = v;
    _updateMuteBtn(); _showFsOverlay();
  });
  document.getElementById('ax-fs-exit-btn')?.addEventListener('click', (e) => {
    e.stopPropagation(); document.exitFullscreen().catch(() => {});
  });
  const fsContainer = document.getElementById('ax-fs-container');
  fsContainer?.addEventListener('mousemove', () => {
    if (document.fullscreenElement) _showFsOverlay();
  });
  fsContainer?.addEventListener('touchstart', () => {
    if (document.fullscreenElement) _showFsOverlay();
  }, { passive: true });
  document.addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    fsContainer?.classList.toggle('ax-fs-active', isFs);
    const overlay = document.getElementById('ax-fs-overlay');
    if (!isFs && overlay) overlay.classList.remove('visible');
    _updateFsBtn();
  });
}

function _updateFsBtn() {
  const btn = document.getElementById('ax-fs-btn');
  if (!btn) return;
  const isFs = !!document.fullscreenElement;
  btn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
}

/* ════════════════════════════════════════════════════
   SUBMIT MODAL
════════════════════════════════════════════════════ */
let _subFile   = null;
let _subBusy   = false;

function _openSubmitModal() {
  const modal = document.getElementById('ax-submit-modal');
  if (!modal) return;
  modal.style.display = 'flex';
}

function _bindSubmitModal() {
  const modal    = document.getElementById('ax-submit-modal');
  if (!modal) return;

  const showFileInfo = (file) => {
    const info = document.getElementById('ax-sub-file-info');
    const icon = document.getElementById('ax-sub-file-icon');
    const name = document.getElementById('ax-sub-file-name');
    const meta = document.getElementById('ax-sub-file-meta');
    if (info) info.style.display = '';
    if (icon) icon.textContent   = file.type.startsWith('video') ? '🎬' : file.type.startsWith('audio') ? '🎵' : '🖼';
    if (name) name.textContent   = file.name;
    if (meta) meta.textContent   = (file.size / (1024 * 1024)).toFixed(1) + ' MB · ' + file.type;
    checkReady();
  };
  const clearFile = () => {
    _subFile = null;
    const info = document.getElementById('ax-sub-file-info');
    if (info) info.style.display = 'none';
    checkReady();
  };
  const checkReady = () => {
    const titleEl  = document.getElementById('ax-sub-title');
    const rightsEl = document.getElementById('ax-sub-rights');
    const btn      = document.getElementById('ax-sub-submit');
    if (!btn) return;
    const ok = _subFile && titleEl?.value?.trim() && rightsEl?.checked;
    btn.disabled = !ok;
    btn.style.opacity = ok ? '1' : '0.5';
  };
  const setErr = (msg) => {
    const errEl = document.getElementById('ax-sub-err');
    if (!errEl) return;
    if (msg) { errEl.textContent = msg; errEl.style.display = ''; }
    else      { errEl.style.display = 'none'; }
  };
  const wireInput = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.onchange = () => {
      const file = el.files?.[0]; if (!file) return;
      _subFile = file; showFileInfo(file); setErr('');
    };
  };
  ['ax-sub-file-any','ax-sub-file-photo','ax-sub-file-video','ax-sub-file-audio'].forEach(wireInput);

  document.getElementById('ax-sub-btn-any')?.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('ax-sub-file-any')?.click(); });
  document.getElementById('ax-sub-btn-photo')?.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('ax-sub-file-photo')?.click(); });
  document.getElementById('ax-sub-btn-video')?.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('ax-sub-file-video')?.click(); });
  document.getElementById('ax-sub-btn-audio')?.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('ax-sub-file-audio')?.click(); });
  document.getElementById('ax-sub-file-clear')?.addEventListener('click', (e) => { e.stopPropagation(); clearFile(); });
  document.getElementById('ax-sub-title')?.addEventListener('input', checkReady);
  document.getElementById('ax-sub-rights')?.addEventListener('change', checkReady);
  document.getElementById('ax-sub-cancel')?.addEventListener('click', () => { if (!_subBusy) modal.style.display = 'none'; });

  document.getElementById('ax-sub-submit')?.addEventListener('click', async () => {
    setErr('');
    const titleEl  = document.getElementById('ax-sub-title');
    const artistEl = document.getElementById('ax-sub-artist');
    const typeEl   = document.getElementById('ax-sub-type');
    const rightsEl = document.getElementById('ax-sub-rights');
    const submitBtn = document.getElementById('ax-sub-submit');
    const cancelBtn = document.getElementById('ax-sub-cancel');
    const progWrap  = document.getElementById('ax-sub-progress');
    const progBar   = document.getElementById('ax-sub-progress-bar');
    const progPct   = document.getElementById('ax-sub-progress-pct');
    const progStatus= document.getElementById('ax-sub-progress-status');

    const title = titleEl?.value.trim();
    if (!title)    { setErr('Please enter a title.'); return; }
    if (!_subFile) { setErr('Please select a file.'); return; }
    if (!rightsEl?.checked) { setErr('Please confirm you have rights to submit.'); return; }

    _subBusy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.5'; submitBtn.textContent = 'UPLOADING…'; }
    if (cancelBtn) cancelBtn.disabled = true;
    if (progWrap)  progWrap.style.display = '';

    try {
      // Upload via Supabase (same as Aurenix viewer upload flow)
      const ext      = (_subFile.name.split('.').pop() || 'bin').toLowerCase();
      const fileName = `radio/${_user.uid}/${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('aurenix-media').upload(fileName, _subFile, {
        cacheControl: '3600',
        upsert: false,
        onUploadProgress: p => {
          const pct = Math.round((p.loaded / p.total) * 100);
          if (progBar)   progBar.style.width = pct + '%';
          if (progPct)   progPct.textContent = pct + '%';
          if (progStatus) progStatus.textContent = 'Uploading…';
        },
      });
      if (error) throw error;
      const { data: { publicUrl } } = supabase.storage.from('aurenix-media').getPublicUrl(fileName);
      if (progStatus) progStatus.textContent = 'Saving…';

      await addDoc(collection(db, 'media_submissions'), {
        title,
        artist:           artistEl?.value.trim() || '',
        type:             typeEl?.value || 'other',
        storage_path:     fileName,
        url:              publicUrl,
        file_name:        _subFile.name,
        size_bytes:       _subFile.size,
        mime_type:        _subFile.type || 'application/octet-stream',
        rights_confirmed: true,
        status:           'pending',
        submitted_by:     _user.uid,
        submitted_email:  _user.email,
        submitted_at:     serverTimestamp(),
      });

      modal.style.display = 'none';
      if (titleEl)  titleEl.value   = '';
      if (artistEl) artistEl.value  = '';
      if (rightsEl) rightsEl.checked = false;
      clearFile();
      _subFile = null;

      const toast = document.getElementById('ax-toast');
      if (toast) {
        toast.textContent = '✓ Submitted — awaiting review before broadcast.';
        toast.className = 'visible';
        clearTimeout(toast._t);
        toast._t = setTimeout(() => toast.classList.remove('visible'), 4000);
      }
    } catch (e) {
      setErr('Upload failed: ' + (e.message || e));
    } finally {
      _subBusy = false;
      if (progWrap)  progWrap.style.display = 'none';
      if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; submitBtn.textContent = 'SUBMIT'; }
      if (cancelBtn) cancelBtn.disabled = false;
    }
  });
}

/* ════════════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════════════ */
function _fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
  return `${m}:${String(ss).padStart(2,'0')}`;
}
function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
