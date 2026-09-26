/**
 * Shadow Nexus Social — 24-Hour Cloud Stream
 * cloud-stream.js  (redesigned)
 *
 * Viewer features:
 *   - Cinematic player: Music Visual Mode / Video Mode / Picture Mode
 *   - Audio Visualizer (Web Audio API, falls back gracefully)
 *   - Smooth fade transitions between media types
 *   - Like system (Firebase, one per UID per stream)
 *   - Viewer presence + heartbeat
 *   - Up Next queue (next 3-5 items)
 *   - Fullscreen support
 *   - No monetization in this section
 *
 * Channel owner features (any authenticated user who owns the stream):
 *   - Start / stop / skip broadcast
 *   - Playlist management
 *   - Broadcast history
 *
 * Architecture unchanged:
 *   cloudStreams/{streamId}               — broadcast record
 *   studioCloudStreamMusic/{streamId}     — live Now Playing (worker-owned)
 *   studioPlaylists/{uid}/playlists/{plId}
 *   cloudStreamTracks/{uid}/tracks/{id}
 *   liveRooms/{uid}
 *   cloudStreamLikes/{streamId}/likes/{uid} — per-track like (Firestore)
 */

'use strict';

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, browserLocalPersistence, setPersistence
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, orderBy, limit, where, onSnapshot,
  serverTimestamp, documentId, increment
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import {
  getDatabase, ref as rtdbRef, set as rtdbSet, remove as rtdbRemove,
  onDisconnect, onValue, serverTimestamp as rtdbServerTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ── Firebase config ─────────────────────────────────────────────────── */
const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

const _app   = getApps().length ? getApp() : initializeApp(_CFG);
const _auth  = getAuth(_app);
const _db    = getFirestore(_app);
const _rtdb  = getDatabase(_app);

setPersistence(_auth, browserLocalPersistence).catch(() => {});

const WORKER_URL = 'https://snx-cloudstream.nthntjrn.workers.dev';

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
let _user     = null;
let _userData = null;

/* Creator/admin state */
let _streamId   = null;
let _streamData = null;
let _artworkDataUrl = null;
let _creator = {
  playlists: [], selectedPl: null, queue: [],
  healthInterval: null, expiryInterval: null,
};

/* Viewer/player state */
let _player = {
  audio:           null,    // single stable HTMLAudioElement
  video:           null,    // reference to #csrVideoEl
  playing:         false,
  mediaType:       'music', // 'music' | 'video' | 'picture'
  trackId:         null,
  trackUrl:        null,
  trackDur:        0,
  artworkUrl:      null,
  trackStartedAt:  0,
  volume:          0.8,
  progressRaf:     null,
  unsub:           null,    // Firestore snapshot unsubscribe
  _streamId:       null,
  _heartbeatTimer: null,
  _watchdogTimer:  null,
  _audioStallAt:   0,
  _userInteracted: false,
  _liked:          false,
  listenerCount:   0,
  // picture-mode timer
  _pictureTimer:   null,
  // queue for Up Next
  _queue:          [],
  _queueIndex:     0,
};

/* RTDB Presence state */
let _presence = {
  sessionId:        null,  // unique tab session ID
  streamId:         null,  // which stream we're present in
  rtdbRef:          null,  // RTDB node ref for this session
  unsub:            null,  // onValue unsubscribe for viewer count
  heartbeatTimer:   null,  // stale-session heartbeat
  staleTimeout:     75000, // ms — sessions older than this are excluded
};

/* Audio Visualizer state */
let _viz = {
  ctx:      null,  // AudioContext
  analyser: null,
  source:   null,
  raf:      null,
  canvas:   null,
  canvasCtx: null,
};

let _confirmCallback = null;

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */
function _el(id)       { return document.getElementById(id); }
function _show(id, v)  { const e = _el(id); if (e) e.style.display = v ? '' : 'none'; }
function _setText(id,t){ const e = _el(id); if (e) e.textContent = t || ''; }
function _sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function _esc(s)       { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _fmtDur(s)    { if (!s||s<=0) return '0:00'; const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=Math.floor(s%60); return h>0?`${h}:${_p(m)}:${_p(ss)}`:`${m}:${_p(ss)}`; }
function _p(n)         { return n<10?'0'+n:''+n; }
function _fmtTime(ms)  { return new Date(ms).toLocaleString(); }
function _fmtDate(ms)  { return new Date(ms).toLocaleDateString(); }

function _setAuthBadge(name) {
  const e = _el('csrAuthBadge');
  if (e) e.textContent = name;
}

function _toast(msg, type) {
  const el = _el('csrToast');
  if (!el) return;
  el.innerHTML = msg;
  el.className = 'csr-toast csr-toast-show'
    + (type === 'success' ? ' csr-toast-success' : type === 'error' ? ' csr-toast-error' : '');
  el.style.display = '';
  if (el._t) clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.remove('csr-toast-show');
    setTimeout(() => { el.style.display = 'none'; }, 300);
  }, 4000);
}

function _showError(id, msg) {
  const el = _el(id);
  if (!el) return;
  el.style.display = msg ? '' : 'none';
  el.textContent = msg || '';
}

function _getSessionId() {
  // Always use a stable per-tab key (NOT uid), so refreshing the same tab
  // replaces the same RTDB presence slot rather than creating a new one.
  const TAB_KEY = 'snx_csr_tab_session';
  let id = sessionStorage.getItem(TAB_KEY);
  if (!id) {
    id = (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 20);
    sessionStorage.setItem(TAB_KEY, id);
  }
  return id;
}

/* ═══════════════════════════════════════════════════════
   BOOT — Auth state
═══════════════════════════════════════════════════════ */
onAuthStateChanged(_auth, async user => {
  _show('csrLoading', false);

  if (!user) {
    _show('csrAuthGate', true);
    _show('csrApp',      false);
    _setAuthBadge('Sign In');
    return;
  }

  _user = user;
  try {
    const snap = await getDoc(doc(_db, 'users', user.uid));
    if (snap.exists()) _userData = snap.data();
  } catch(_) {}

  _setAuthBadge(_userData ? (_userData.displayName || _userData.username || 'You') : 'You');

  const params  = new URLSearchParams(window.location.search);
  const watchId = params.get('id') || params.get('watch') || params.get('stream');

  _show('csrApp', true);

  if (watchId) {
    // Direct listener link — show viewer section
    _show('csrViewerSection', true);
    await _initListenerMode(watchId);
  } else {
    // Could be creator or general visitor
    await _initCreatorMode();
  }
});

/* ═══════════════════════════════════════════════════════
   CREATOR MODE
═══════════════════════════════════════════════════════ */
async function _initCreatorMode() {
  // Always show the viewer section
  _show('csrViewerSection', true);

  // Show channel management section to the stream owner (any authenticated user)
  _show('csrAdminSection', true);
  _show('csrAdminDivider', true);

  // Check for an active stream belonging to this user
  try {
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      where('status', 'in', ['active', 'starting', 'recovering']),
      limit(1)
    ));
    if (snap.docs.length) {
      const d = snap.docs[0];
      _streamId   = d.id;
      _streamData = d.data();
      _showActiveStream();
    } else {
      _showCreateForm();
    }
  } catch (e) {
    console.error('[CSR] initCreatorMode error:', e);
    _showCreateForm();
  }

  _loadPlaylists();
  _loadHistory();

  // Also join as a viewer of the most-recent active stream
  _discoverAndJoinStream();
}

/* Find the most recently active cloud stream for the viewer panel */
async function _discoverAndJoinStream() {
  try {
    // If we already have a stream (creator's own), use it
    if (_streamId) {
      await _initListenerForStream(_streamId, _streamData || {});
      return;
    }
    // Otherwise look for any active stream
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('status', 'in', ['active', 'recovering']),
      orderBy('startedAt', 'desc'),
      limit(1)
    ));
    if (snap.docs.length) {
      const d = snap.docs[0];
      await _initListenerForStream(d.id, d.data());
    } else {
      // No active stream — show offline state
      _setOfflineMsg('No broadcast is currently running.');
    }
  } catch(e) {
    console.warn('[CSR] discoverAndJoinStream:', e.message);
    _setOfflineMsg('Could not connect to stream.');
  }
}

function _setOfflineMsg(msg) {
  _setText('csrOfflineMsg', msg);
  // Make sure offline panel is visible and others are hidden
  const offline = _el('csrModeOffline');
  if (offline) offline.classList.remove('hidden');
}

/* ── ADMIN: show active stream ── */
function _showActiveStream() {
  _show('csrStatusPanel', true);
  _show('csrActiveBanner', true);
  _show('csrCreatePanel', false);
  _renderStatusPanel();
  _startHealthMonitor();
  _startExpiryCountdown();
  _subscribeAdminNowPlaying(_streamId);
}

function _showCreateForm() {
  _show('csrStatusPanel', false);
  _show('csrActiveBanner', false);
  _show('csrCreatePanel', true);
  _renderCreateForm();
  _show('csrHistoryPanel', true);
}

/* ── Status panel ── */
function _renderStatusPanel() {
  if (!_streamData) return;
  const d = _streamData;
  _setStatusBadge(d.status || 'unknown');
  _el('csrStreamId').textContent      = 'ID: ' + (_streamId || '—');
  _el('csrInfoTitle').textContent     = d.streamName     || '—';
  _el('csrInfoHost').textContent      = d.displayName    || (_userData && (_userData.displayName || _userData.username)) || '—';
  _el('csrInfoCategory').textContent  = d.category       || '—';
  _el('csrInfoStarted').textContent   = d.startedAt ? _fmtTime(d.startedAt.toMillis ? d.startedAt.toMillis() : d.startedAt) : '—';
  _el('csrInfoExpires').textContent   = d.expiresAt ? new Date(d.expiresAt).toLocaleString() : '—';
  _el('csrInfoListeners').textContent = d.viewerCount || '0';
  _el('csrInfoWorker').textContent    = d.workerStatus || 'active';
}

function _setStatusBadge(status) {
  const el = _el('csrStatusBadge');
  if (!el) return;
  const map = {
    active:    ['csr-status-live',    '&#128308; LIVE'],
    starting:  ['csr-status-starting','&#9203; STARTING'],
    recovering:['csr-status-warn',    '&#9888; RECOVERING'],
    stopping:  ['csr-status-warn',    '&#9209; STOPPING'],
    stopped:   ['csr-status-offline', '&#9209; ENDED'],
    ended:     ['csr-status-offline', '&#9209; ENDED'],
    failed:    ['csr-status-error',   '&#10060; ERROR'],
    offline:   ['csr-status-offline', '&#9898; OFFLINE'],
    unknown:   ['csr-status-offline', '&#9898; OFFLINE'],
  };
  const [cls, label] = map[status] || map.unknown;
  el.className = 'csr-status-badge ' + cls;
  el.innerHTML = label;
}

/* Admin Now Playing subscription (updates admin strip only) */
function _subscribeAdminNowPlaying(streamId) {
  onSnapshot(
    doc(_db, 'studioCloudStreamMusic', streamId),
    snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      _setText('csrAdminNpTitle',  d.currentTitle  || '—');
      _setText('csrAdminNpArtist', d.currentArtist || '');
      _setText('csrAdminNpNext',   d.nextTitle ? 'Next: ' + d.nextTitle : '');
    },
    err => console.warn('[CSR] adminNP error:', err.message)
  );
}

/* ── Health monitor ── */
function _startHealthMonitor() {
  if (_creator.healthInterval) clearInterval(_creator.healthInterval);
  _creator.healthInterval = setInterval(_checkHealth, 30000);
  _checkHealth();
}
function _stopHealthMonitor() {
  if (_creator.healthInterval) { clearInterval(_creator.healthInterval); _creator.healthInterval = null; }
}
async function _checkHealth() {
  if (!_streamId) return;
  try {
    const r    = await fetch(WORKER_URL + '/api/stream/health/' + _streamId);
    const data = await r.json();
    if (data.success) {
      if (_streamData) { _streamData.status = data.status; _streamData.viewerCount = data.viewerCount || 0; }
      _setStatusBadge(data.status);
      _setText('csrInfoWorker',    data.workerActive ? 'active' : 'offline');
      _setText('csrInfoListeners', String(data.viewerCount || 0));
    }
    if (_streamData && _streamData.expiresAt && _streamData.expiresAt - Date.now() <= 0) _streamExpired();
  } catch(_) {}
}

/* ── Expiry countdown ── */
function _startExpiryCountdown() {
  if (_creator.expiryInterval) clearInterval(_creator.expiryInterval);
  _creator.expiryInterval = setInterval(_tickExpiry, 1000);
  _tickExpiry();
}
function _tickExpiry() {
  if (!_streamData || !_streamData.expiresAt) return;
  const remain = _streamData.expiresAt - Date.now();
  const el = _el('csrInfoRemaining');
  if (remain <= 0) { if (el) el.textContent = 'EXPIRED'; _streamExpired(); return; }
  if (el) el.textContent = _fmtDur(Math.floor(remain / 1000));
}
function _streamExpired() {
  if (_creator.expiryInterval) { clearInterval(_creator.expiryInterval); _creator.expiryInterval = null; }
  _setStatusBadge('ended');
  _toast('Your 24-hour cloud broadcast has ended.', 'info');
}

/* ═══════════════════════════════════════════════════════
   LISTENER / VIEWER MODE
═══════════════════════════════════════════════════════ */
async function _initListenerMode(streamId) {
  try {
    const r    = await fetch(WORKER_URL + '/api/stream/sync/' + streamId);
    const data = await r.json();

    if (!r.ok || !data.success) {
      _setOfflineMsg(data.error || 'Broadcast not found or offline.');
      return;
    }
    if (!['active','recovering','starting'].includes(data.status)) {
      _setOfflineMsg('This broadcast has ended.');
      return;
    }

    const streamData = {
      streamName:  data.streamName  || 'Shadow Nexus Cloud Stream',
      displayName: data.displayName || '',
      viewerCount: data.viewerCount || 0,
      startedAt:   data.startedAt   || 0,
      expiresAt:   data.endsAt      || 0,
      status:      data.status,
    };
    _player.trackStartedAt = data.lastAdvancedAt || data.startedAt || Date.now();
    await _initListenerForStream(streamId, streamData);

    if (data.currentMusicUrl) {
      _syncToNowPlaying({
        currentTitle:    data.currentMusicTitle    || '',
        currentArtist:   data.currentMusicArtist   || '',
        currentTrackUrl: data.currentMusicUrl,
        currentTrackId:  data.currentMusicId       || '',
        currentDuration: data.currentMusicDuration || 0,
        artworkUrl:      data.artworkUrl           || '',
        mediaType:       data.mediaType            || 'music',
        nextTitle:       data.nextMusicTitle       || '',
        nextArtist:      data.nextMusicArtist      || '',
        updatedAt:       { toMillis: () => data.lastAdvancedAt || Date.now() },
      });
    }
  } catch (e) {
    console.warn('[CSR] Worker sync failed, using Firestore only:', e.message);
    await _initListenerForStream(streamId, { streamName: 'Shadow Nexus Cloud Stream', displayName: '' });
  }
}

async function _initListenerForStream(streamId, streamData) {
  _player._streamId = streamId;

  // Hide offline panel — we have a stream
  const offline = _el('csrModeOffline');
  if (offline) offline.classList.add('hidden');

  // iOS gate check before subscribing
  _maybeShowTapOverlay();

  // Subscribe to Firestore Now Playing
  if (_player.unsub) { try { _player.unsub(); } catch(_) {} }
  _player.unsub = onSnapshot(
    doc(_db, 'studioCloudStreamMusic', streamId),
    snap => {
      if (!snap.exists()) { _setOfflineMsg('Broadcast ended.'); return; }
      const d = snap.data();
      if (d.status === 'stopped' || d.status === 'ended') { _setOfflineMsg('Broadcast ended.'); return; }
      _syncToNowPlaying(d);
    },
    err => console.warn('[CSR] nowPlaying snapshot error:', err.message)
  );

  // Initial fetch
  try {
    const np = await getDoc(doc(_db, 'studioCloudStreamMusic', streamId));
    if (np.exists()) _syncToNowPlaying(np.data());
  } catch(_) {}

  _joinAsListener(streamId);
  _startListenerHeartbeat(streamId);
  _startRtdbPresence(streamId);  // accurate RTDB viewer count
  _fetchLikes(streamId);
  _startAudioWatchdog(streamId);
}

/* ═══════════════════════════════════════════════════════
   MUSIC SCENE SYSTEM — 8 deterministic visual themes
   Each track gets a stable scene based on hash of its ID.
═══════════════════════════════════════════════════════ */
const _SCENES = [
  { id: 'anubis',    name: 'ANUBIS CHAMBER',     bg: ['#0a0602','#0d0804'],     accent: '#c5a41d', energy: '#1a6fcc', particle: '#c5a41d' },
  { id: 'pyramid',   name: 'BLOOD PYRAMID',      bg: ['#0e0000','#0a0000'],     accent: '#8b0000', energy: '#c5a41d', particle: '#8b0000' },
  { id: 'galaxy',    name: "PHARAOH'S GALAXY",   bg: ['#0d0820','#060215'],     accent: '#c5a41d', energy: '#5b2d8e', particle: '#c5a41d' },
  { id: 'tomb',      name: 'CURSED TOMB',        bg: ['#1a1205','#0d0a04'],     accent: '#ff8c00', energy: '#00a86b', particle: '#ff8c00' },
  { id: 'eye',       name: 'EYE OF THE NEXUS',   bg: ['#020e12','#010810'],     accent: '#00c8c8', energy: '#c5a41d', particle: '#00aeef' },
  { id: 'desert',    name: 'DESERT AFTER MIDNIGHT', bg: ['#080604','#040302'],  accent: '#c5a41d', energy: '#1a6fcc', particle: '#c5a41d' },
  { id: 'underworld',name: 'UNDERWORLD',         bg: ['#050000','#020000'],     accent: '#c5a41d', energy: '#8b0000', particle: '#cc1111' },
  { id: 'celestial', name: 'CELESTIAL TEMPLE',   bg: ['#04080d','#02050a'],     accent: '#c5a41d', energy: '#00aeef', particle: '#e8c84a' },
];

/* Simple stable hash of a string → integer */
function _hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; }
  return Math.abs(h);
}

/* Get the scene for a track */
function _getScene(trackId) {
  if (!trackId) return _SCENES[0];
  return _SCENES[_hashStr(String(trackId)) % _SCENES.length];
}

/* Current scene state */
let _currentScene = _SCENES[0];
let _sceneCanvas = null;
let _sceneCtx    = null;
let _sceneRaf    = null;
let _sceneParticles = [];

/* Apply a scene to the music mode stage */
function _applyMusicScene(scene) {
  if (_currentScene === scene && _sceneRaf) return; // already active, no change
  _currentScene = scene;

  // Update scene badge
  const badge = _el('csrSceneBadge');
  if (badge) badge.textContent = scene.name;

  // Update blurred bg tint
  const stageBg = _el('csrStageBg');
  if (stageBg) {
    stageBg.style.background = `radial-gradient(ellipse at center, ${scene.bg[0]} 0%, ${scene.bg[1]} 100%)`;
    stageBg.style.backgroundImage = 'none'; // override artwork bg while in music mode
  }

  // Update orbit ring color via filter
  const orbit1 = _el('csrOrbit1');
  const orbit2 = _el('csrOrbit2');
  // Visual tint handled by scene canvas below

  // Start scene canvas animation
  _startSceneCanvas(scene);
}

/* Scene canvas — lightweight particle field */
function _startSceneCanvas(scene) {
  _stopSceneCanvas();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  _sceneCanvas = _el('csrSceneCanvas');
  if (!_sceneCanvas) return;
  _sceneCtx = _sceneCanvas.getContext('2d');
  if (!_sceneCtx) return;

  // Seed particles
  _sceneParticles = [];
  const N = 30;
  for (let i = 0; i < N; i++) {
    _sceneParticles.push({
      x:   Math.random(),
      y:   Math.random(),
      vx:  (Math.random() - 0.5) * 0.0004,
      vy: -(Math.random() * 0.0006 + 0.0001),
      r:   Math.random() * 1.8 + 0.5,
      a:   Math.random() * 0.6 + 0.2,
      life: Math.random(),
    });
  }

  let W = 0, H = 0;
  function draw() {
    _sceneRaf = requestAnimationFrame(draw);
    const cW = _sceneCanvas.clientWidth;
    const cH = _sceneCanvas.clientHeight;
    if (cW !== W || cH !== H) {
      _sceneCanvas.width  = cW;
      _sceneCanvas.height = cH;
      W = cW; H = cH;
    }
    if (!W || !H) return;

    _sceneCtx.clearRect(0, 0, W, H);

    // Scene-specific background tint overlay
    _sceneCtx.fillStyle = scene.bg[0] + '18'; // subtle tint
    _sceneCtx.fillRect(0, 0, W, H);

    // Draw particles
    for (const p of _sceneParticles) {
      p.x += p.vx;
      p.y += p.vy;
      p.life += 0.004;
      // Reset when off top
      if (p.y < -0.02 || p.life > 1) {
        p.x = Math.random();
        p.y = 1 + Math.random() * 0.1;
        p.life = 0;
        p.vx = (Math.random() - 0.5) * 0.0004;
        p.vy = -(Math.random() * 0.0006 + 0.0001);
      }
      const px = p.x * W;
      const py = p.y * H;
      const alpha = p.a * Math.sin(p.life * Math.PI);
      _sceneCtx.beginPath();
      _sceneCtx.arc(px, py, p.r, 0, Math.PI * 2);
      _sceneCtx.fillStyle = scene.particle + _alphaHex(alpha * 0.5);
      _sceneCtx.fill();
    }

    // Scene-specific energy crack effect (subtle lines at bottom)
    _drawSceneEnergy(_sceneCtx, scene, W, H);
  }
  draw();
}

function _alphaHex(a) {
  return Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, '0');
}

function _drawSceneEnergy(ctx, scene, W, H) {
  // Draw faint horizontal energy line at bottom
  ctx.save();
  const grad = ctx.createLinearGradient(0, H, W, H);
  grad.addColorStop(0, 'transparent');
  grad.addColorStop(0.3, scene.energy + '30');
  grad.addColorStop(0.5, scene.energy + '60');
  grad.addColorStop(0.7, scene.energy + '30');
  grad.addColorStop(1, 'transparent');
  ctx.fillStyle = grad;
  ctx.fillRect(0, H - 2, W, 2);
  ctx.restore();
}

function _stopSceneCanvas() {
  if (_sceneRaf) { cancelAnimationFrame(_sceneRaf); _sceneRaf = null; }
}

/* ── Sync viewer UI to a Now Playing document ── */
function _syncToNowPlaying(d) {
  if (!d) return;

  const url       = d.currentTrackUrl || '';
  const title     = d.currentTitle    || '—';
  const artist    = d.currentArtist   || '';
  const dur       = d.currentDuration || 0;
  const artwork   = d.artworkUrl      || d.coverArtUrl || '';
  const mediaType = d.mediaType       || 'music';
  const nextTitle = d.nextTitle       || '';
  const trackId   = d.currentTrackId  || '';

  // Update Now Playing artifact plaque
  _setText('csrNpTitle',   title);
  _setText('csrNpArtist',  artist);
  _setText('csrTotalTime', _fmtDur(dur));

  // Also update music-stage title/artist overlay
  _setText('csrMusicTitle',  title);
  _setText('csrMusicArtist', artist);

  // Type badge (rune)
  const typeBadge = _el('csrNpTypeBadge');
  if (typeBadge) {
    typeBadge.textContent =
      mediaType === 'video'   ? '𓆙 Video'   :
      mediaType === 'picture' ? '𓇳 Picture'  :
                                '𓆣 Music';
  }

  // Thumbnail in plaque
  _setNpThumb(artwork);

  // Up Next → Prophecy Queue
  if (d.upNext && Array.isArray(d.upNext)) {
    _player._queue = d.upNext;
    _renderUpNext(d.upNext);
    _renderTimeline(d.upNext);
  } else if (nextTitle) {
    const items = [{ title: nextTitle, artist: d.nextArtist || '', mediaType: d.nextMediaType || 'music', artworkUrl: d.nextArtworkUrl || '' }];
    _renderUpNext(items);
    _renderTimeline(items);
  } else {
    _renderUpNext([]);
    _renderTimeline([]);
  }

  // Assign music scene based on track ID
  if (mediaType === 'music') {
    const scene = _getScene(trackId || title);
    // Only transition scene if track changed
    if (scene !== _currentScene || !_sceneRaf) {
      _applyMusicScene(scene);
    }
  } else {
    _stopSceneCanvas();
    const badge = _el('csrSceneBadge');
    if (badge) badge.textContent = '';
  }

  // Load new media if URL changed
  if (url && url !== _player.trackUrl) {
    _player.trackUrl      = url;
    _player.trackId       = trackId;
    _player.trackDur      = dur;
    _player.artworkUrl    = artwork;
    _player.mediaType     = mediaType;
    _player.trackStartedAt = d.updatedAt?.toMillis ? d.updatedAt.toMillis() : Date.now();
    _loadMedia(url, dur, mediaType, artwork, title, artist);
  }
}

/* ── Set Now Playing thumbnail ── */
function _setNpThumb(artworkUrl) {
  const img  = _el('csrNpThumb');
  const def  = _el('csrNpThumbDefault');
  if (!img) return;
  if (artworkUrl) {
    img.onload  = () => { img.classList.add('loaded'); if (def) def.style.display = 'none'; };
    img.onerror = () => { img.classList.remove('loaded'); if (def) def.style.display = ''; };
    img.src = artworkUrl;
  } else {
    img.classList.remove('loaded');
    img.src = '';
    if (def) def.style.display = '';
  }
}

/* ── Render Prophecy Queue (Up Next) ── */
function _renderUpNext(items) {
  const list = _el('csrUpNextList');
  if (!list) return;
  if (!items || !items.length) {
    list.innerHTML = '<div class="csr-prophecy-empty">THE QUEUE IS EMPTY</div>';
    return;
  }
  const shown = items.slice(0, 5);
  list.innerHTML = shown.map(item => {
    const icon = item.mediaType === 'video' ? '𓆙' : item.mediaType === 'picture' ? '𓇳' : '𓆣';
    const typeLabel = item.mediaType === 'video' ? 'Video' : item.mediaType === 'picture' ? 'Picture' : 'Music';
    const thumbHtml = item.artworkUrl
      ? `<img src="${_esc(item.artworkUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : icon;
    const durStr = item.duration ? `<span style="font-size:9px;color:var(--snx-text-dim);margin-left:auto">${_fmtDur(item.duration)}</span>` : '';
    return `<div class="csr-prophecy-item" role="listitem">
      <div class="csr-prophecy-thumb" aria-hidden="true">${thumbHtml}</div>
      <div class="csr-prophecy-info">
        <div class="csr-prophecy-title">${_esc(item.title || 'Untitled')}</div>
        <div class="csr-prophecy-type">${icon} ${_esc(typeLabel)}</div>
      </div>
      ${durStr}
    </div>`;
  }).join('');
}

/* ── Render Channel Timeline ── */
function _renderTimeline(upNext) {
  const track = _el('csrTimelineTrack');
  if (!track) return;
  if (!upNext || !upNext.length) {
    track.innerHTML = '<div class="csr-timeline-line"></div>';
    return;
  }
  const shown = upNext.slice(0, 3);
  const positions = shown.map((_, i) => 25 + (i * 28));
  const dots = shown.map((item, i) => {
    const pos = positions[i];
    return `<div class="csr-timeline-node" style="left:${pos}%">
      <div class="csr-timeline-node-dot"></div>
      <div class="csr-timeline-node-label">${_esc((item.title || '').slice(0, 12))}</div>
    </div>`;
  }).join('');
  track.innerHTML = `<div class="csr-timeline-line"></div>${dots}`;
}

/* ═══════════════════════════════════════════════════════
   MEDIA LOADING — stable single controller
   Never recreates the <audio> element for track changes;
   swaps src instead. Keeps Web Audio connections alive.
═══════════════════════════════════════════════════════ */
function _loadMedia(url, dur, mediaType, artworkUrl, title, artist) {
  if (!url) { _player._audioStallAt = _player._audioStallAt || Date.now(); return; }

  // Fade transition between modes
  _fadeTransition(() => {
    if (mediaType === 'video') {
      _activateVideoMode(url, dur);
    } else if (mediaType === 'picture') {
      _activatePictureMode(url, dur, title);
    } else {
      _activateMusicMode(url, dur, artworkUrl);
    }
  });
}

/* ── Fade transition helper ── */
function _fadeTransition(cb) {
  const overlay = _el('csrFadeOverlay');
  if (!overlay || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cb();
    return;
  }
  overlay.classList.add('fading');
  setTimeout(() => {
    cb();
    overlay.classList.remove('fading');
  }, 420);
}

/* ── Show/hide stage modes ── */
function _setStageMode(mode) {
  // mode: 'music' | 'video' | 'picture'
  const modes = ['csrModeMusic', 'csrModeVideo', 'csrModePicture'];
  const map   = { music: 'csrModeMusic', video: 'csrModeVideo', picture: 'csrModePicture' };
  modes.forEach(id => {
    const el = _el(id);
    if (el) {
      el.classList.toggle('active', id === map[mode]);
      el.setAttribute('aria-hidden', id !== map[mode] ? 'true' : 'false');
    }
  });
  // Hide offline panel whenever we have real content
  const offline = _el('csrModeOffline');
  if (offline) offline.classList.add('hidden');
  _player.mediaType = mode;
}

/* ── MUSIC MODE — TOMB OF SOUND ── */
function _activateMusicMode(url, dur, artworkUrl) {
  _setStageMode('music');
  _stopPictureTimer();

  // Let scene system control the bg; only set artwork bg if we have art
  const bg = _el('csrStageBg');
  if (bg) {
    if (artworkUrl) {
      bg.style.backgroundImage = `url('${_esc(artworkUrl)}')`;
      bg.style.background = '';
    } else {
      bg.style.backgroundImage = 'none';
      bg.style.background = `radial-gradient(ellipse at center, ${_currentScene.bg[0]} 0%, ${_currentScene.bg[1]} 100%)`;
    }
  }

  // Update artwork image
  const img = _el('csrMusicArtwork');
  const def = _el('csrMusicArtworkDefault');
  if (img) {
    img.classList.remove('loaded');
    if (artworkUrl) {
      img.alt = 'Album artwork';
      img.onload  = () => { img.classList.add('loaded'); if (def) def.style.display = 'none'; };
      img.onerror = () => { img.classList.remove('loaded'); img.src = ''; if (def) def.style.display = ''; };
      img.src = artworkUrl;
    } else {
      img.src = '';
      if (def) def.style.display = '';
    }
  }

  // Ensure scene canvas is running
  if (!_sceneRaf) _startSceneCanvas(_currentScene);

  // Show music info div in stage
  const info = _el('csrMusicInfo');
  if (info) info.style.display = '';

  _loadAndPlayAudio(url, dur);
}

/* ── VIDEO MODE — PHARAOH'S SCREEN ── */
function _activateVideoMode(url, dur) {
  _setStageMode('video');
  _stopPictureTimer();
  _stopAudio();
  _stopSceneCanvas();

  // Clear any blurred bg
  const bg = _el('csrStageBg');
  if (bg) { bg.style.backgroundImage = 'none'; bg.style.background = '#000'; }

  const video = _el('csrVideoEl');
  if (!video) return;
  _player.video = video;

  // Remove old handlers before setting new src
  video.onended  = null;
  video.onerror  = null;

  video.volume = _player.volume;
  video.src    = url;
  video.load();

  video.onended = () => {
    _stopProgressRaf();
    _player._audioStallAt = Date.now(); // triggers watchdog to advance
    _setPlayBtn(false);
  };
  video.onerror = () => {
    console.warn('[CSR] video error for url:', url);
    _player._audioStallAt = _player._audioStallAt || Date.now();
  };
  video.addEventListener('timeupdate', _updateProgress, { passive: true });

  const tapOverlay = _el('csrTapOverlay');
  const tapVisible = tapOverlay && tapOverlay.style.display !== 'none';
  if (_player.playing && !tapVisible) {
    video.play().catch(err => {
      if (err.name === 'NotAllowedError') { _player.playing = false; _showTapOverlay(); }
    });
    _startProgressRaf();
  }
  _setPlayBtn(_player.playing && !tapVisible);
  _show('csrProgressFill', true);
}

/* ── PICTURE MODE — HALL OF VISIONS ── */
function _activatePictureMode(url, duration, title) {
  _setStageMode('picture');
  _stopPictureTimer();
  _stopAudio();
  _stopSceneCanvas();

  const img = _el('csrPictureImg');
  const bg  = _el('csrPictureBg'); // .csr-vision-bg in new HTML
  if (img) { img.alt = _esc(title || 'Hall of Visions'); img.src = url; }
  if (bg)  { bg.style.backgroundImage = `url('${_esc(url)}')`; }

  const bgStage = _el('csrStageBg');
  if (bgStage) { bgStage.style.backgroundImage = `url('${_esc(url)}')`; bgStage.style.background = ''; }

  // Auto-advance after duration (default 30s if not specified)
  const displayMs = ((duration || 30)) * 1000;
  _player._pictureTimer = setTimeout(() => {
    _player._audioStallAt = Date.now(); // watchdog will re-sync
  }, displayMs);

  _setPlayBtn(false); // no play/pause for pictures
  _setText('csrCurrentTime', '');
  _setText('csrTotalTime', _fmtDur(duration || 30) + ' display');
}

function _stopPictureTimer() {
  if (_player._pictureTimer) { clearTimeout(_player._pictureTimer); _player._pictureTimer = null; }
}

/* ── AUDIO playback (stable element, swap src) ── */
function _loadAndPlayAudio(url, dur) {
  if (!url) return;

  // Create audio element once; reuse thereafter
  if (!_player.audio) {
    const audio = new Audio();
    audio.volume  = _player.volume;
    audio.preload = 'auto';
    audio.setAttribute('playsinline', '');
    audio.setAttribute('webkit-playsinline', '');
    audio.setAttribute('x-webkit-airplay', 'allow');
    audio.addEventListener('timeupdate', _updateProgress, { passive: true });
    audio.addEventListener('ended',      _onAudioEnded);
    audio.addEventListener('stalled',    () => { if (!_player._audioStallAt) _player._audioStallAt = Date.now(); });
    audio.addEventListener('waiting',    () => { if (!_player._audioStallAt) _player._audioStallAt = Date.now(); });
    audio.addEventListener('canplay',    () => { _player._audioStallAt = 0; });
    audio.addEventListener('playing',    () => { _player._audioStallAt = 0; });
    audio.addEventListener('error',      () => { _player._audioStallAt = _player._audioStallAt || Date.now(); });
    _player.audio = audio;
  }

  const audio = _player.audio;
  audio.pause();
  audio.src  = url;
  audio.load();
  _player.trackDur      = dur;
  _player._audioStallAt = 0;

  // Synchronized seek (skip ahead to match server clock)
  const elapsed = Math.max(0, (Date.now() - _player.trackStartedAt) / 1000);
  if (elapsed > 2 && dur > 0 && elapsed < dur - 2) {
    audio.addEventListener('loadedmetadata', () => {
      if (isFinite(audio.duration) && audio.duration > 0) {
        try { audio.currentTime = Math.min(elapsed, audio.duration - 1); } catch(_) {}
      }
    }, { once: true });
  }

  // Connect to Web Audio for visualizer (only on music mode)
  _connectVisualizer(audio);

  const tapOverlay = _el('csrTapOverlay');
  const tapVisible = tapOverlay && tapOverlay.style.display !== 'none';

  if (_player.playing && !tapVisible) {
    const p = audio.play();
    if (p !== undefined) {
      p.catch(err => {
        if (err.name === 'NotAllowedError' || err.name === 'AbortError') {
          _player.playing = false;
          _setPlayBtn(false);
          _showTapOverlay();
        } else {
          _player._audioStallAt = _player._audioStallAt || Date.now();
        }
      });
    }
    _startProgressRaf();
  }
  _setPlayBtn(_player.playing && !tapVisible);
}

function _onAudioEnded() {
  _stopProgressRaf();
  _player._audioStallAt = Date.now();
  _setPlayBtn(false);
  _vizStop();
}

function _stopAudio() {
  const audio = _player.audio;
  if (!audio) return;
  try { audio.pause(); } catch(_) {}
  _stopProgressRaf();
  _vizStop();
}

/* ═══════════════════════════════════════════════════════
   AUDIO VISUALIZER — Web Audio API
═══════════════════════════════════════════════════════ */
function _connectVisualizer(audioEl) {
  if (!audioEl) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  try {
    if (!_viz.ctx) {
      _viz.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Disconnect previous source
    if (_viz.source) { try { _viz.source.disconnect(); } catch(_) {} }

    const analyser = _viz.ctx.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.8;

    const source = _viz.ctx.createMediaElementSource(audioEl);
    source.connect(analyser);
    analyser.connect(_viz.ctx.destination);

    _viz.analyser = analyser;
    _viz.source   = source;

    if (!_viz.canvas) {
      _viz.canvas    = _el('csrVisualizerCanvas');
      _viz.canvasCtx = _viz.canvas ? _viz.canvas.getContext('2d') : null;
    }
    _vizStart();
  } catch(e) {
    // Web Audio not available — visualizer simply won't show
    console.warn('[CSR] Visualizer setup failed:', e.message);
  }
}

function _vizStart() {
  _vizStop();
  if (!_viz.analyser || !_viz.canvasCtx) return;

  function draw() {
    _viz.raf = requestAnimationFrame(draw);
    const analyser  = _viz.analyser;
    const canvas    = _viz.canvas;
    const ctx       = _viz.canvasCtx;
    if (!analyser || !canvas || !ctx) return;

    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width  = W;
      canvas.height = H;
    }

    const bufLen = analyser.frequencyBinCount;
    const data   = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(data);

    ctx.clearRect(0, 0, W, H);

    const barCount = Math.min(bufLen, 40);
    const barW     = (W / barCount) * 0.65;
    const gap      = (W / barCount) * 0.35;
    const scene    = _currentScene;

    for (let i = 0; i < barCount; i++) {
      const val    = data[i] / 255;
      const barH   = val * H * 0.92;
      const x      = i * (barW + gap) + gap / 2;
      const y      = H - barH;

      // Egyptian gold at low energy, scene accent/energy at high
      const t = val;
      // Parse scene energy color (assumed hex #rrggbb)
      const er = parseInt(scene.energy.slice(1,3),16);
      const eg = parseInt(scene.energy.slice(3,5),16);
      const eb = parseInt(scene.energy.slice(5,7),16);
      // Gold base: r=197,g=164,b=29
      const r = Math.round(197 + (er - 197) * t);
      const g = Math.round(164 + (eg - 164) * t);
      const b = Math.round(29  + (eb - 29) * t);
      ctx.fillStyle = `rgba(${r},${g},${b},${0.6 + val * 0.4})`;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x, y, barW, barH, 1) : ctx.rect(x, y, barW, barH);
      ctx.fill();

      // Glow on tall bars
      if (val > 0.6) {
        ctx.fillStyle = `rgba(${r},${g},${b},0.15)`;
        ctx.beginPath();
        ctx.roundRect ? ctx.roundRect(x - 1, y - 2, barW + 2, barH + 4, 2) : ctx.rect(x - 1, y - 2, barW + 2, barH + 4);
        ctx.fill();
      }
    }
  }
  draw();
}

function _vizStop() {
  if (_viz.raf) { cancelAnimationFrame(_viz.raf); _viz.raf = null; }
  // Clear canvas to flat bars (settled look)
  if (_viz.canvasCtx && _viz.canvas) {
    _viz.canvasCtx.clearRect(0, 0, _viz.canvas.width, _viz.canvas.height);
    // Draw flat minimal bars to indicate paused/stopped state
    _drawFlatBars();
  }
}

function _drawFlatBars() {
  const ctx    = _viz.canvasCtx;
  const canvas = _viz.canvas;
  if (!ctx || !canvas) return;
  const W = canvas.clientWidth || 300;
  const H = canvas.clientHeight || 40;
  canvas.width  = W;
  canvas.height = H;
  ctx.clearRect(0, 0, W, H);
  const barCount = 40;
  const barW     = (W / barCount) * 0.65;
  const gap      = (W / barCount) * 0.35;
  for (let i = 0; i < barCount; i++) {
    const x = i * (barW + gap) + gap / 2;
    ctx.fillStyle = 'rgba(197,164,29,0.18)';
    ctx.fillRect(x, H - 2, barW, 2);
  }
}

/* ═══════════════════════════════════════════════════════
   PROGRESS
═══════════════════════════════════════════════════════ */
function _updateProgress() {
  const media = _player.mediaType === 'video' ? _player.video : _player.audio;
  if (!media) return;
  const pos = media.currentTime || 0;
  const dur = (isFinite(media.duration) && media.duration > 0)
    ? media.duration
    : _player.trackDur;
  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const fill = _el('csrProgressFill');
  if (fill) {
    fill.style.width = pct.toFixed(2) + '%';
    const bar = _el('csrProgressBar');
    if (bar) bar.setAttribute('aria-valuenow', Math.round(pct));
  }
  _setText('csrCurrentTime', _fmtDur(Math.floor(pos)));
}

function _startProgressRaf() {
  _stopProgressRaf();
  function tick() { _updateProgress(); _player.progressRaf = requestAnimationFrame(tick); }
  _player.progressRaf = requestAnimationFrame(tick);
}
function _stopProgressRaf() {
  if (_player.progressRaf) { cancelAnimationFrame(_player.progressRaf); _player.progressRaf = null; }
}

/* ═══════════════════════════════════════════════════════
   IOS / AUTOPLAY GATE
═══════════════════════════════════════════════════════ */
function _isAutoplayBlocked() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) && !window.MSStream
    || (/Safari/.test(ua) && !/Chrome/.test(ua))
    || window.navigator.standalone === true;
}
function _maybeShowTapOverlay() {
  if (_isAutoplayBlocked()) { _showTapOverlay(); _player.playing = false; }
}
function _showTapOverlay() {
  _show('csrTapOverlay', true);
  _player.playing = false;
  _setPlayBtn(false);
}

window.csrStartListening = function() {
  _show('csrTapOverlay', false);
  _player._userInteracted = true;
  _player.playing = true;

  // Resume AudioContext if suspended (required by browser autoplay policy)
  if (_viz.ctx && _viz.ctx.state === 'suspended') {
    _viz.ctx.resume().catch(() => {});
  }

  const media = _player.mediaType === 'video' ? _player.video : _player.audio;
  if (media) {
    const p = media.play();
    if (p) p.catch(err => {
      console.warn('[CSR] csrStartListening play() failed:', err.message);
      if (_player.trackUrl) _loadAndPlayAudio(_player.trackUrl, _player.trackDur);
    });
    _setPlayBtn(true);
    _startProgressRaf();
    if (_player.mediaType === 'music') _vizStart();
  } else if (_player.trackUrl) {
    _loadMedia(_player.trackUrl, _player.trackDur, _player.mediaType, _player.artworkUrl, '', '');
  }
};

/* ── Play/Pause toggle ── */
window.csrTogglePlay = function() {
  const tapOverlay = _el('csrTapOverlay');
  if (tapOverlay && tapOverlay.style.display !== 'none') {
    window.csrStartListening();
    return;
  }

  const media = _player.mediaType === 'video' ? _player.video : _player.audio;

  if (_player.mediaType === 'picture') return; // pictures aren't pause-able

  if (!media) {
    if (_player.trackUrl) {
      _player.playing = true;
      _loadMedia(_player.trackUrl, _player.trackDur, _player.mediaType, _player.artworkUrl, '', '');
    }
    return;
  }

  if (_player.playing) {
    try { media.pause(); } catch(_) {}
    _player.playing = false;
    _stopProgressRaf();
    _vizStop();
  } else {
    // Resume AudioContext on user gesture
    if (_viz.ctx && _viz.ctx.state === 'suspended') _viz.ctx.resume().catch(() => {});
    const p = media.play();
    if (p) p.catch(err => { if (err.name === 'NotAllowedError') _showTapOverlay(); });
    _player.playing = true;
    _startProgressRaf();
    if (_player.mediaType === 'music') _vizStart();
  }
  _setPlayBtn(_player.playing);
};

function _setPlayBtn(playing) {
  const btn  = _el('csrPlayerPlayBtn');
  const icon = _el('csrPlayBtnIcon');
  if (btn)  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (icon) icon.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
}

window.csrSetVolume = function(val) {
  _player.volume = parseInt(val, 10) / 100;
  if (_player.audio) _player.audio.volume = _player.volume;
  const vid = _el('csrVideoEl');
  if (vid) vid.volume = _player.volume;
};

/* ── Retry connect ── */
window.csrRetryConnect = function() {
  _discoverAndJoinStream();
};

/* ═══════════════════════════════════════════════════════
   RTDB PRESENCE — accurate active viewer count
   Path: presence/cloudStream/{streamId}/{sessionId}
   Each tab gets one slot; onDisconnect removes it immediately.
   Heartbeat updates lastSeen so stale sessions (crashed tabs)
   are excluded from the live count after STALE_MS.
═══════════════════════════════════════════════════════ */
const PRESENCE_STALE_MS = 75000; // sessions not seen in 75s are stale

async function _startRtdbPresence(streamId) {
  if (!streamId) return;
  if (_presence.streamId === streamId && _presence.rtdbRef) return; // already tracking

  // Clean up previous presence slot (different stream or stale ref)
  await _stopRtdbPresence(false);

  const sessionId = _getSessionId();
  _presence.sessionId = sessionId;
  _presence.streamId  = streamId;

  const presencePath = `presence/cloudStream/${streamId}/${sessionId}`;
  const myRef = rtdbRef(_rtdb, presencePath);
  _presence.rtdbRef = myRef;

  const presenceData = {
    uid:       _user ? _user.uid : null,
    joinedAt:  Date.now(),
    lastSeen:  Date.now(),
  };

  try {
    // Write presence; schedule automatic cleanup on disconnect
    await rtdbSet(myRef, presenceData);
    await onDisconnect(myRef).remove();
  } catch (e) {
    console.warn('[CSR RTDB] presence write failed:', e.message);
    return;
  }

  // Heartbeat — updates lastSeen periodically to prove liveness
  if (_presence.heartbeatTimer) clearInterval(_presence.heartbeatTimer);
  _presence.heartbeatTimer = setInterval(async () => {
    try {
      await rtdbSet(myRef, { ...presenceData, lastSeen: Date.now() });
    } catch (_) {}
  }, 30000);

  // Subscribe to viewer count
  _subscribeRtdbViewerCount(streamId);

  // Remove presence on page unload
  window.addEventListener('beforeunload', () => {
    // sendBeacon can't hit RTDB directly; just best-effort remove
    try { rtdbRemove(myRef); } catch (_) {}
  }, { once: true });
}

async function _stopRtdbPresence(alsoUnsubCount = true) {
  if (_presence.heartbeatTimer) {
    clearInterval(_presence.heartbeatTimer);
    _presence.heartbeatTimer = null;
  }
  if (_presence.rtdbRef) {
    try { await rtdbRemove(_presence.rtdbRef); } catch (_) {}
    _presence.rtdbRef = null;
  }
  if (alsoUnsubCount && _presence.unsub) {
    try { _presence.unsub(); } catch (_) {}
    _presence.unsub = null;
  }
  _presence.sessionId = null;
  _presence.streamId  = null;
}

function _subscribeRtdbViewerCount(streamId) {
  if (!streamId) return;
  if (_presence.unsub) { try { _presence.unsub(); } catch (_) {} }

  const countPath = `presence/cloudStream/${streamId}`;
  const countRef  = rtdbRef(_rtdb, countPath);

  const unsub = onValue(countRef, snap => {
    if (!snap.exists()) {
      _updateViewerDisplay(0);
      return;
    }
    const sessions = snap.val();
    const now = Date.now();
    let active = 0;
    for (const [, data] of Object.entries(sessions)) {
      if (data && typeof data.lastSeen === 'number') {
        if (now - data.lastSeen < PRESENCE_STALE_MS) active++;
      } else if (data && data.joinedAt) {
        // legacy: no lastSeen, count if joined recently
        if (now - data.joinedAt < PRESENCE_STALE_MS) active++;
      }
    }
    _updateViewerDisplay(active);
  }, err => console.warn('[CSR RTDB] viewer count error:', err.message));

  _presence.unsub = unsub;
}

function _updateViewerDisplay(count) {
  _player.listenerCount = count;
  const countStr = String(count);
  _setText('csrViewerCount',       countStr); // Artifact plaque
  _setText('csrHeaderViewerCount', countStr); // Header pill
  _setText('csrInfoListeners',     countStr); // Admin panel
  // Legacy element — may not exist in new layout, ignore gracefully
  try { _setText('csrWatchingCount', countStr); } catch(_) {}
}

/* ═══════════════════════════════════════════════════════
   WORKER PRESENCE — heartbeat (kept for worker-side listener tracking)
═══════════════════════════════════════════════════════ */
async function _joinAsListener(streamId) {
  if (!streamId) return;
  const sessionId = _getSessionId();
  try {
    await fetch(WORKER_URL + '/api/stream/listener/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        streamId, sessionId,
        uid:         _user ? _user.uid : null,
        displayName: _user ? (_userData?.displayName || _userData?.username || '') : 'Guest',
      }),
    });
  } catch(e) { console.warn('[CSR] join failed:', e.message); }
}

function _startListenerHeartbeat(streamId) {
  if (!streamId) return;
  if (_player._heartbeatTimer) { clearInterval(_player._heartbeatTimer); _player._heartbeatTimer = null; }
  const sessionId = _getSessionId();

  const _beat = async () => {
    try {
      const r = await fetch(WORKER_URL + '/api/stream/listener/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streamId, sessionId }),
      });
      const d = await r.json().catch(() => ({}));
      if (d.rejoin) { await _joinAsListener(streamId); return; }
      // NOTE: viewer count display is now driven by RTDB presence (_subscribeRtdbViewerCount).
      // We only update here as a fallback if RTDB is unavailable.
      if (typeof d.viewerCount === 'number' && _player.listenerCount === 0) {
        _updateViewerDisplay(d.viewerCount);
      }
    } catch(_) {}
  };

  _beat();
  _player._heartbeatTimer = setInterval(_beat, 25000);

  window.addEventListener('beforeunload', () => _leaveAsListener(streamId), { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      _joinAsListener(streamId);
      _beat();
      // Re-register RTDB presence in case tab was sleeping
      _startRtdbPresence(streamId);
    }
  });
}

async function _leaveAsListener(streamId) {
  if (!streamId) return;
  const sessionId = _getSessionId();
  try {
    navigator.sendBeacon
      ? navigator.sendBeacon(WORKER_URL + '/api/stream/listener/leave', JSON.stringify({ streamId, sessionId }))
      : await fetch(WORKER_URL + '/api/stream/listener/leave', {
          method: 'POST', keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ streamId, sessionId }),
        });
  } catch(_) {}
}

/* ═══════════════════════════════════════════════════════
   LIKES — one per authenticated user per stream track.
   Stored in Firestore: cloudStreamLikes/{streamId}/likes/{uid}
   Falls back to worker API if Firestore rules block it.
═══════════════════════════════════════════════════════ */
async function _fetchLikes(streamId) {
  if (!streamId) return;
  try {
    // Try worker endpoint first (same as before)
    const uid = _user ? _user.uid : null;
    const url = uid
      ? WORKER_URL + '/api/stream/likes/' + streamId + '/' + uid
      : WORKER_URL + '/api/stream/likes/' + streamId;
    const r = await fetch(url);
    if (!r.ok) throw new Error('worker likes unavailable');
    const d = await r.json();
    _setText('csrLikeCount', _fmtLikeCount(d.likeCount || 0));
    _player._liked = !!d.liked;
    _updateLikeBtn();
    return;
  } catch(_) {}

  // Fallback: Firestore cloudStreamLikes
  try {
    const likeSnap = await getDoc(doc(_db, 'cloudStreamLikes', streamId));
    const total = likeSnap.exists() ? (likeSnap.data().count || 0) : 0;
    _setText('csrLikeCount', _fmtLikeCount(total));
    if (_user) {
      const myLike = await getDoc(doc(_db, 'cloudStreamLikes', streamId, 'likes', _user.uid));
      _player._liked = myLike.exists();
    }
    _updateLikeBtn();
  } catch(e) {
    console.warn('[CSR] fetchLikes fallback failed:', e.message);
  }
}

function _fmtLikeCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

function _updateLikeBtn() {
  const btn  = _el('csrLikeBtn');
  const heart = _el('csrLikeHeart');
  if (!btn) return;
  if (_player._liked) {
    btn.classList.add('liked');
    btn.setAttribute('aria-pressed', 'true');
    if (heart) heart.textContent = '♥';
  } else {
    btn.classList.remove('liked');
    btn.setAttribute('aria-pressed', 'false');
    if (heart) heart.textContent = '♡';
  }
}

window.csrToggleLike = async function() {
  if (!_user) { _toast('Sign in to like.', 'info'); return; }
  const streamId = _player._streamId;
  if (!streamId) return;

  const wasLiked = _player._liked;
  // Optimistic UI
  _player._liked = !wasLiked;
  _updateLikeBtn();
  const countEl = _el('csrLikeCount');
  const cur = _parseLikeCount(countEl?.textContent || '0');
  if (countEl) countEl.textContent = _fmtLikeCount(Math.max(0, cur + (_player._liked ? 1 : -1)));

  try {
    const idToken = await _user.getIdToken(true);
    const r = await fetch(WORKER_URL + '/api/stream/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ streamId, uid: _user.uid, action: _player._liked ? 'like' : 'unlike' }),
    });
    const d = await r.json();
    if (r.ok && typeof d.likeCount === 'number') {
      _setText('csrLikeCount', _fmtLikeCount(d.likeCount));
      _player._liked = !!d.liked;
      _updateLikeBtn();
    } else {
      throw new Error(d.error || 'rejected');
    }
  } catch(_workerErr) {
    // Fallback: Firestore cloudStreamLikes
    try {
      const likeRef  = doc(_db, 'cloudStreamLikes', streamId, 'likes', _user.uid);
      const countRef = doc(_db, 'cloudStreamLikes', streamId);
      if (_player._liked) {
        await setDoc(likeRef, { uid: _user.uid, likedAt: serverTimestamp() });
        await setDoc(countRef, { count: increment(1) }, { merge: true });
      } else {
        await deleteDoc(likeRef);
        await setDoc(countRef, { count: increment(-1) }, { merge: true });
      }
    } catch(e) {
      // Roll back on full failure
      _player._liked = wasLiked;
      _updateLikeBtn();
      if (countEl) countEl.textContent = _fmtLikeCount(cur);
      _toast('Could not update like.', 'error');
    }
  }
};

function _parseLikeCount(s) {
  if (!s) return 0;
  const clean = String(s).trim();
  if (clean.endsWith('K')) return Math.round(parseFloat(clean) * 1000);
  return parseInt(clean, 10) || 0;
}

/* ═══════════════════════════════════════════════════════
   AUDIO WATCHDOG
═══════════════════════════════════════════════════════ */
const WATCHDOG_MS    = 15000;
const STALL_RELOAD_MS = 20000;

function _startAudioWatchdog(streamId) {
  if (_player._watchdogTimer) { clearInterval(_player._watchdogTimer); _player._watchdogTimer = null; }

  _player._watchdogTimer = setInterval(async () => {
    // Don't interfere with tap-to-listen gate
    const tapOverlay = _el('csrTapOverlay');
    if (tapOverlay && tapOverlay.style.display !== 'none') return;

    if (!_player.playing || !_player.trackUrl) return;
    if (_player.mediaType === 'picture') return; // pictures advance by timer

    const stallAge = _player._audioStallAt ? Date.now() - _player._audioStallAt : 0;
    const media    = _player.mediaType === 'video' ? _player.video : _player.audio;

    if (!media || stallAge > STALL_RELOAD_MS) {
      // Re-sync from Firestore
      if (streamId) {
        try {
          const np = await getDoc(doc(_db, 'studioCloudStreamMusic', streamId));
          if (np.exists()) {
            const d = np.data();
            if (d.currentTrackUrl && d.currentTrackUrl !== _player.trackUrl) {
              _syncToNowPlaying(d);
              return;
            }
          }
        } catch(_) {}
      }
      // Same track — reload
      if (_player.trackUrl) {
        console.warn('[CSR] watchdog: reloading stalled media');
        _loadMedia(_player.trackUrl, _player.trackDur, _player.mediaType, _player.artworkUrl, '', '');
      }
    } else if (media && !media.paused && media.readyState >= 3) {
      _player._audioStallAt = 0;
    }
  }, WATCHDOG_MS);
}

/* ═══════════════════════════════════════════════════════
   FULLSCREEN
═══════════════════════════════════════════════════════ */
window.csrToggleFullscreen = function() {
  const stage = _el('csrStage');
  if (!stage) return;
  const isFs = document.fullscreenElement || document.webkitFullscreenElement;
  if (isFs) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  } else {
    const req = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (req) req.call(stage).catch(() => {});
  }
};

document.addEventListener('fullscreenchange',       _onFsChange);
document.addEventListener('webkitfullscreenchange', _onFsChange);
function _onFsChange() {
  const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  const icon = _el('csrFullscreenIcon');
  if (icon) icon.innerHTML = isFs ? '&#x2715;' : '&#x26F6;';
}

/* ═══════════════════════════════════════════════════════
   ADMIN — CREATE BROADCAST FORM
═══════════════════════════════════════════════════════ */
function _renderCreateForm() {
  // Show test mode option for all users
  const dur = _el('csrFormDuration');
  if (dur) {
    const testOpt = dur.querySelector('option[value="5"]');
    if (testOpt) testOpt.style.display = '';
  }
  const hint = _el('csrTestModeHint');
  if (hint && dur) {
    dur.addEventListener('change', () => {
      hint.style.display = dur.value === '5' ? '' : 'none';
    });
  }
}

async function _loadPlaylists() {
  const el = _el('csrPlaylistSelector');
  if (!el || !_user) return;
  try {
    const snap = await getDocs(query(
      collection(_db, 'studioPlaylists', _user.uid, 'playlists'),
      orderBy('createdAt', 'desc'), limit(50)
    ));
    _creator.playlists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _renderPlaylistSelector();
  } catch(e) {
    el.innerHTML = '<div class="csr-hint">Could not load playlists.</div>';
  }
}

function _renderPlaylistSelector() {
  const el = _el('csrPlaylistSelector');
  if (!el) return;
  if (!_creator.playlists.length) {
    el.innerHTML = '<div class="csr-hint">No playlists found. <a class="csr-link" href="/?snxPage=studioPage">Go to 24-Hour Studio</a> to create a playlist.</div>';
    return;
  }
  el.innerHTML = _creator.playlists.map(pl => {
    const sel = _creator.selectedPl && _creator.selectedPl.id === pl.id;
    return `<button class="csr-pl-btn${sel ? ' selected' : ''}" onclick="csrSelectPlaylist('${_esc(pl.id)}')">
      <span class="csr-pl-name">${_esc(pl.name)}</span>
      <span class="csr-pl-count">${(pl.trackIds || []).length} tracks</span>
    </button>`;
  }).join('');
}

window.csrSelectPlaylist = async function(plId) {
  const pl = _creator.playlists.find(p => p.id === plId);
  if (!pl) return;
  _creator.selectedPl = pl;
  _renderPlaylistSelector();
  _creator.queue = [];
  const el = _el('csrQueuePreview');
  if (el) { el.style.display = ''; el.innerHTML = '<div class="csr-hint">Loading tracks…</div>'; }
  try {
    const ids = pl.trackIds || [];
    if (!ids.length) { if (el) el.innerHTML = '<div class="csr-hint">This playlist has no tracks.</div>'; return; }
    const chunks = [];
    for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
    const results = [];
    for (const chunk of chunks) {
      const snap = await getDocs(query(
        collection(_db, 'cloudStreamTracks', _user.uid, 'tracks'),
        where(documentId(), 'in', chunk)
      ));
      snap.docs.forEach(d => results.push({ id: d.id, ...d.data() }));
    }
    _creator.queue = ids.map(id => results.find(r => r.id === id)).filter(Boolean);
    _renderQueuePreview();
  } catch(e) {
    if (el) el.innerHTML = '<div class="csr-hint">Could not load tracks: ' + _esc(e.message) + '</div>';
  }
};

function _renderQueuePreview() {
  const el = _el('csrQueuePreview');
  if (!el) return;
  const q = _creator.queue;
  if (!q.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const totalSecs = q.reduce((a, t) => a + (t.duration || 0), 0);
  el.innerHTML =
    `<div class="csr-queue-header">${q.length} tracks · ${_fmtDur(totalSecs)} total</div>` +
    `<div class="csr-queue-list">` +
    q.slice(0, 10).map((t, i) =>
      `<div class="csr-queue-item">
        <span class="csr-queue-num">${i + 1}</span>
        <div class="csr-queue-info">
          <div class="csr-queue-title">${_esc(t.title || 'Untitled')}</div>
          <div class="csr-queue-artist">${_esc(t.artist || '')}</div>
        </div>
        <span class="csr-queue-dur">${_fmtDur(t.duration || 0)}</span>
      </div>`
    ).join('') +
    (q.length > 10 ? `<div class="csr-queue-more">+ ${q.length - 10} more</div>` : '') +
    `</div>`;
}

/* ── Start Broadcast ── */
window.csrStartBroadcast = async function() {
  const btn = _el('csrStartBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Starting…'; }
  try {
    if (!_user) throw new Error('Authentication required.');
    if (!_creator.selectedPl) throw new Error('Please select a playlist first.');
    const validTracks = _creator.queue.filter(t => t.url || t.downloadURL || t.musicUrl);
    if (!validTracks.length) throw new Error('No playable audio tracks found.');

    const durEl = _el('csrFormDuration');
    let durationMinutes = parseInt(durEl ? durEl.value : '1440', 10);
    // All authenticated users may use all duration options
    if (durationMinutes > 1440) durationMinutes = 1440;

    const dupSnap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      where('status', 'in', ['active', 'starting', 'recovering']),
      limit(1)
    ));
    if (dupSnap.docs.length) {
      _show('csrDuplicateWarn', true);
      _streamId   = dupSnap.docs[0].id;
      _streamData = dupSnap.docs[0].data();
      throw new Error('Broadcast already active.');
    }

    const streamId = _user.uid + '_' + Date.now();
    _streamId = streamId;
    const title   = (_el('csrFormTitle')    || {}).value?.trim() || 'CloudStream by ' + (_userData?.displayName || _user.uid);
    const desc    = (_el('csrFormDesc')     || {}).value?.trim() || '';
    const cat     = (_el('csrFormCategory') || {}).value || 'Music';
    const shuffle = (_el('csrFormShuffle')  || {}).checked || false;
    const repeat  = (_el('csrFormRepeat')   || {}).checked !== false;

    _show('csrStartingProgress', true);
    _show('csrValidationError', false);
    _renderHandoffStep(0, 'Preparing broadcast…');

    await setDoc(doc(_db, 'cloudStreams', streamId), {
      uid: _user.uid,
      displayName: _userData?.displayName || _userData?.username || '',
      streamName: title, description: desc, category: cat,
      theme: 'shadow-nexus', durationMinutes,
      status: 'starting', viewerCount: 0,
      coverArt: _artworkDataUrl || '',
      createdAt: serverTimestamp(), startedAt: null, expiresAt: null,
      workerStatus: 'pending', lastHeartbeat: null,
      musicPlaylistId: _creator.selectedPl.id,
    });
    _streamData = { uid: _user.uid, streamName: title, status: 'starting', durationMinutes };
    _renderHandoffStep(1, 'Saving configuration…');
    await _sleep(400);

    _renderHandoffStep(2, 'Starting cloud worker…');
    const musicQueue = validTracks.map(t => ({
      id: t.id,
      title:    t.title    || t.name   || 'Untitled',
      artist:   t.artist   || '',
      url:      t.url      || t.downloadURL || t.musicUrl || '',
      duration: t.duration || t.durationSecs || 0,
      artworkUrl: t.artworkUrl || t.artwork || '',
      mediaType:  t.mediaType  || 'music',
    }));

    const idToken  = await _user.getIdToken(true);
    const startRes = await fetch(WORKER_URL + '/api/stream/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({
        streamId, uid: _user.uid,
        displayName:  _userData?.displayName || '',
        streamName:   title, theme: 'shadow-nexus',
        scenePlaylist: [],
        durationMinutes, musicQueue,
        musicShuffle: shuffle, musicRepeat: repeat,
        musicCrossfade: 3, musicVolume: 80,
        musicPlaylistId: _creator.selectedPl.id,
      }),
    });
    if (!startRes.ok) {
      const errData = await startRes.json().catch(() => ({}));
      throw new Error(errData.error || 'Cloud worker failed to start (HTTP ' + startRes.status + ').');
    }
    await startRes.json();
    _renderHandoffStep(3, 'Verifying worker…');
    await _sleep(600);

    const expiresAt = Date.now() + durationMinutes * 60 * 1000;
    await updateDoc(doc(_db, 'cloudStreams', streamId), {
      status: 'active', startedAt: serverTimestamp(), expiresAt,
    });
    await setDoc(doc(_db, 'liveRooms', _user.uid), {
      creatorId: _user.uid, creatorSource: 'shadow_nexus_social',
      roomId: _user.uid, hostId: _user.uid,
      hostName: _userData?.displayName || _userData?.username || '',
      hostUsername: _userData?.username || '',
      hostAvatar: _userData?.avatar || _userData?.profilePicture || _user.photoURL || '',
      title, description: desc, category: cat,
      coverArt: _artworkDataUrl || '',
      status: 'live', isLive: true, type: '24hour_cloudstream',
      cloudStreamId: streamId, startedAt: serverTimestamp(),
      expiresAt: new Date(expiresAt).toISOString(),
      viewers: 0, likes: 0,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });

    _streamData = { uid: _user.uid, streamName: title, status: 'active', durationMinutes, expiresAt, category: cat, displayName: _userData?.displayName || '' };

    if (musicQueue.length) {
      const first = musicQueue[0];
      await setDoc(doc(_db, 'studioCloudStreamMusic', streamId), {
        cloudStreamId: streamId, uid: _user.uid,
        playlistId: _creator.selectedPl.id,
        currentTrackId: first.id, currentTitle: first.title,
        currentArtist: first.artist,
        currentTrackUrl: first.url, currentDuration: first.duration || 0,
        artworkUrl: first.artworkUrl || '',
        mediaType: first.mediaType || 'music',
        nextTrackId: musicQueue[1]?.id    || '',
        nextTitle:   musicQueue[1]?.title || '',
        nextArtist:  musicQueue[1]?.artist || '',
        upNext: musicQueue.slice(1, 6).map(t => ({
          title: t.title, artist: t.artist,
          mediaType: t.mediaType || 'music', artworkUrl: t.artworkUrl || '',
        })),
        queueIndex: 0, status: 'playing', updatedAt: serverTimestamp(),
      }, { merge: true });
    }

    _renderHandoffStep(4, 'Broadcast is LIVE!');
    await _sleep(800);
    _show('csrStartingProgress', false);
    _show('csrCreatePanel', false);
    _showActiveStream();
    _toast('&#9925; Cloud Stream is now LIVE!', 'success');
  } catch(e) {
    console.error('[CSR] startBroadcast error:', e);
    _show('csrStartingProgress', false);
    if (btn) { btn.disabled = false; btn.innerHTML = '&#128308; GO LIVE FOR 24 HOURS'; }
    if (_streamId && e.message && e.message.includes('already active')) {
      _showActiveStream();
    } else {
      _showError('csrValidationError', e.message || 'Could not start broadcast.');
      if (_streamId) updateDoc(doc(_db, 'cloudStreams', _streamId), { status: 'failed' }).catch(() => {});
    }
    _streamId = null;
  }
};

function _renderHandoffStep(step, label) {
  const el = _el('csrHandoffSteps');
  if (!el) return;
  const steps = ['Preparing broadcast…','Saving configuration…','Starting cloud worker…','Verifying worker…','Broadcast is LIVE!'];
  el.innerHTML = steps.map((s, i) => {
    const done = i < step, active = i === step;
    const icon = done ? '&#10003;' : active ? '&#9203;' : '&#9675;';
    return `<div class="csr-handoff-step${done?' done':active?' active':''}">
      <span class="csr-handoff-icon">${icon}</span>
      <span>${_esc(i === step ? label : s)}</span>
    </div>`;
  }).join('');
}

/* ── Stop Broadcast ── */
window.csrConfirmStop = function() {
  _showConfirm('End Cloud Stream?', 'This will stop the broadcast for all viewers. Cannot be undone.', _stopBroadcast);
};

async function _stopBroadcast() {
  const btn = _el('csrStopBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Stopping…'; }
  _stopHealthMonitor();
  try {
    const idToken = await _user.getIdToken(true);
    await fetch(WORKER_URL + '/api/stream/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ streamId: _streamId, uid: _user.uid }),
    });
  } catch(_) {}
  try {
    if (_streamId) {
      await updateDoc(doc(_db, 'cloudStreams', _streamId), { status: 'stopped', stoppedAt: serverTimestamp() });
      await updateDoc(doc(_db, 'studioCloudStreamMusic', _streamId), { status: 'stopped', stoppedAt: serverTimestamp() }).catch(() => {});
    }
    await updateDoc(doc(_db, 'liveRooms', _user.uid), { isLive: false, status: 'ended', updatedAt: serverTimestamp() }).catch(() => {});
  } catch(_) {}

  if (_player.unsub) { try { _player.unsub(); } catch(_) {} _player.unsub = null; }
  _stopAudio();
  _streamId = _streamData = null;
  _show('csrStatusPanel', false);
  _show('csrActiveBanner', false);
  _show('csrCreatePanel', true);
  _renderCreateForm();
  _toast('Broadcast ended.', 'info');
}

/* ── Skip Track ── */
window.csrSkipTrack = async function() {
  if (!_streamId || !_user) return;
  try {
    const idToken = await _user.getIdToken(true);
    await fetch(WORKER_URL + '/api/stream/music/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
      body: JSON.stringify({ streamId: _streamId, uid: _user.uid, action: 'next' }),
    });
    _toast('Skipping…', 'info');
    setTimeout(_checkHealth, 1500);
  } catch(e) {
    _toast('Could not skip: ' + e.message, 'error');
  }
};

/* ── Broadcast History ── */
async function _loadHistory() {
  const el = _el('csrHistoryList');
  if (!el || !_user) return;
  try {
    const snap = await getDocs(query(
      collection(_db, 'cloudStreams'),
      where('uid', '==', _user.uid),
      orderBy('createdAt', 'desc'), limit(10)
    ));
    if (!snap.docs.length) { _show('csrHistoryPanel', false); return; }
    _show('csrHistoryPanel', true);
    el.innerHTML = snap.docs.map(d => {
      const data = d.data();
      const started = data.startedAt?.toMillis ? data.startedAt.toMillis() : null;
      const stopped = data.stoppedAt?.toMillis ? data.stoppedAt.toMillis() : null;
      const duration = (started && stopped) ? _fmtDur(Math.floor((stopped - started) / 1000)) : '—';
      const colors = { active: '#39ff14', stopped: '#5a80a8', failed: '#ff3355', ended: '#5a80a8' };
      const color = colors[data.status] || '#5a80a8';
      return `<div class="csr-history-item">
        <div class="csr-history-name">${_esc(data.streamName || 'Untitled')}</div>
        <div class="csr-history-meta">
          <span style="color:${color}">${_esc((data.status || '').toUpperCase())}</span>
          <span>·</span><span>${started ? _fmtDate(started) : '—'}</span>
          <span>·</span><span>${duration}</span>
        </div>
      </div>`;
    }).join('');
  } catch(_) { el.innerHTML = '<div class="csr-hint">Could not load history.</div>'; }
}

/* ── Artwork (broadcast cover) ── */
// Uploads the chosen image to Cloudflare R2 and stores the permanent URL.
// Falls back to a local blob URL for the preview while the upload is in flight.
const _R2_UPLOAD_WORKER = 'https://yellow-term-11e6.nthntjrn.workers.dev';
window.csrLoadArtwork = function(evt) {
  const file = evt.target.files?.[0];
  if (!file || !file.type.startsWith('image/')) return;

  // Show local preview immediately while we upload to R2
  const blobUrl = URL.createObjectURL(file);
  const img = _el('csrArtworkImg');
  if (img) img.src = blobUrl;
  _show('csrArtworkPreview', true);
  const btn = _el('csrArtworkBtn');
  if (btn) btn.textContent = '🖼 Uploading…';

  // Require auth
  if (!_user || typeof _user.getIdToken !== 'function') {
    _artworkDataUrl = blobUrl; // fallback — no permanent URL
    if (btn) btn.textContent = '🖼 Change Image';
    return;
  }

  _user.getIdToken(true).then(function(idToken) {
    const uid = _user.uid;
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const r2Key = 'cloud-stream/' + uid + '/artwork/' + Date.now() + '_' + safeName;

    const form = new FormData();
    form.append('file', file, file.name);
    form.append('path', r2Key);

    const xhr = new XMLHttpRequest();
    xhr.timeout = 3 * 60 * 1000; // 3 min

    xhr.onload = function() {
      URL.revokeObjectURL(blobUrl);
      if (xhr.status === 200) {
        try {
          const res = JSON.parse(xhr.responseText);
          if (res.url) {
            _artworkDataUrl = res.url; // permanent R2 URL
            if (img) img.src = res.url;
            if (btn) btn.textContent = '🖼 Change Image';
            return;
          }
        } catch(_) {}
      }
      // Upload failed — keep the blob url as a local fallback
      console.warn('[CloudStream] Artwork R2 upload failed. HTTP', xhr.status, xhr.responseText);
      _artworkDataUrl = ''; // do not store data URL in Firestore
      if (btn) btn.textContent = '🖼 Retry Image';
    };
    xhr.onerror = xhr.ontimeout = function() {
      URL.revokeObjectURL(blobUrl);
      console.warn('[CloudStream] Artwork upload network error.');
      _artworkDataUrl = '';
      if (btn) btn.textContent = '🖼 Retry Image';
    };

    xhr.open('POST', _R2_UPLOAD_WORKER + '/');
    xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);
    xhr.send(form);
  }).catch(function(e) {
    console.warn('[CloudStream] Artwork upload auth error:', e.message);
    _artworkDataUrl = '';
    if (btn) btn.textContent = '🖼 Change Image';
  });
};
window.csrRemoveArtwork = function() {
  _artworkDataUrl = null;
  _show('csrArtworkPreview', false);
  const btn = _el('csrArtworkBtn');
  if (btn) btn.textContent = '🖼 Choose Image';
};

/* ── Scroll helpers ── */
window.csrScrollToAdmin  = function() {
  const el = _el('csrAdminSection');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
};
window.csrScrollToPlaylist = function() { window.location.href = '/?snxPage=studioPage'; };
window.csrOpenExistingStream = function() { _show('csrDuplicateWarn', false); _showActiveStream(); };

/* ── Confirmation dialog ── */
function _showConfirm(title, body, cb) {
  _confirmCallback = cb;
  _setText('csrConfirmTitle', title);
  _setText('csrConfirmBody', body);
  _show('csrConfirmOverlay', true);
}
window.csrConfirmCancel  = function() { _show('csrConfirmOverlay', false); _confirmCallback = null; };
window.csrConfirmProceed = function() { _show('csrConfirmOverlay', false); if (_confirmCallback) _confirmCallback(); _confirmCallback = null; };

/* ── SPA re-init ── */
window.csrSpaInit = async function() {
  if (!_user) return;
  _show('csrLoading', false);
  _show('csrAuthGate', false);
  _show('csrApp', true);
  _show('csrViewerSection', false);
  await _initCreatorMode();
};

window.csrRefreshPlaylists = function() {
  if (_user) _loadPlaylists();
};
