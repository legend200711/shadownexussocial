/**
 * snx-tv-studio.js
 * Shadow Nexus Social — 24-Hour TV Studio
 * Stage 4: Hardened — Validation + Ref-checks + Recovery
 * Build: SNS-2026-TV-STAGE4-001
 *
 * Architecture:
 *
 *   SNS Firestore (profileMusic, videos)
 *       ↓
 *   TV Media Adapter  →  tv_media (Firestore)
 *       ↓
 *   TV Media Library  (Studio UI)
 *       ↓
 *   TV Playlists  →  tv_playlists (Firestore)
 *       ↓
 *   TV Programs  →  tv_programs (Firestore)
 *       ↓
 *   TV Schedule  →  tv_schedule (Firestore)
 *       ↓
 *   SNXTVTimeline (snx-tv-timeline.js) — authoritative resolver
 *       ↓
 *   window.SNXTV (TV Core) — viewer / guide / queue
 *
 * Authorization:
 *   Studio: window._snxRole === 'founder' (existing SNS founder role)
 *   Firestore writes: isFounderEmail() rule (cannot be spoofed)
 *   R2 uploads: Bearer Firebase ID token → upload-worker /upload-music
 *
 * DO NOT TOUCH:
 *   Radio, Live, Feed, Profiles, existing auth, existing SNS media schema
 *
 * EXPOSES: window.SNXTVStudio
 */

'use strict';

(function (global) {

/* ════════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════ */

const STUDIO_VERSION        = 'SNS-2026-TV-STAGE5-001';
const R2_WORKER_URL         = 'https://yellow-term-11e6.nthntjrn.workers.dev';
const COLL_TV_MEDIA         = 'tv_media';
const COLL_TV_PLAYLISTS     = 'tv_playlists';
const COLL_TV_PROGRAMS      = 'tv_programs';
const COLL_TV_SCHEDULE      = 'tv_schedule';
const COLL_TV_SUBMISSIONS   = 'tv_submissions';
const COLL_TV_SETTINGS      = 'tv_settings';
const COLL_PROFILE_MUSIC    = 'profileMusic';
const COLL_VIDEOS           = 'videos';

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */

let _mounted       = false;
let _container     = null;
let _activeTab     = 'dashboard';

// In-memory caches
let _tvMedia         = [];   // tv_media docs
let _tvPlaylists     = [];   // tv_playlists docs
let _snsMusicLib     = [];   // profileMusic docs (SNS source)
let _snsVideoLib     = [];   // videos docs (SNS source)
let _tvSubmissions   = [];   // tv_submissions docs
let _tvSettings      = {};   // tv_settings/channel doc

// Stage 3: programs + schedule (mirrors SNXTVTimeline caches for studio use)
let _tvPrograms    = [];   // tv_programs docs
let _tvSchedule    = [];   // tv_schedule docs

// Live Firestore listeners
let _unsubMedia       = null;
let _unsubPlaylists   = null;
let _unsubPrograms    = null;
let _unsubSchedule    = null;
let _unsubSubmissions = null;

// Active playlist being edited
let _editingPlId    = null;

// Active program being edited (Stage 3)
let _editingProgId  = null;
// Active schedule entry being edited (Stage 3)
let _editingSlotId  = null;

/* ════════════════════════════════════════════════════════════
   FIREBASE HELPERS
════════════════════════════════════════════════════════════ */

function _fs() {
  return global._snxFirestore || {};
}

function _db() {
  const f = _fs();
  return f.db || global._snxDb || null;
}

function _cu() {
  return global._snxCurrentUser || null;
}

function _isFounder() {
  return (global._snxRole || '') === 'founder';
}

async function _getIdToken() {
  const user = (global._snxAuth && global._snxAuth.currentUser)
             ? global._snxAuth.currentUser : (_cu() || null);
  if (!user || typeof user.getIdToken !== 'function') throw new Error('Not authenticated');
  return user.getIdToken(true);
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmtDur(secs) {
  if (!secs || !isFinite(secs)) return '—';
  const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function _ts(ms) {
  if (!ms) return '—';
  const d = new Date(typeof ms === 'object' && ms.seconds ? ms.seconds * 1000 : ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function _toast(msg, type) {
  if (typeof global.toastNotification === 'function') {
    global.toastNotification(msg);
  } else {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#0d2444;border:1px solid rgba(0,212,255,0.4);color:#fff;font-size:13px;padding:10px 18px;border-radius:30px;z-index:99999;pointer-events:none;';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2800);
  }
}

/* ════════════════════════════════════════════════════════════
   MOUNT / UNMOUNT
════════════════════════════════════════════════════════════ */

/**
 * Mount the TV Studio into the given container element.
 * Called by snx-tv.js when the founder opens the Studio.
 */
function mount(parentEl) {
  if (_mounted) return;
  if (!parentEl) return;

  if (!_isFounder()) {
    console.log('[SNX-TV-STUDIO] Not founder — TV Studio not mounted');
    return;
  }

  _container = document.createElement('div');
  _container.id = 'snxTvStudio';
  _buildDOM();
  parentEl.appendChild(_container);
  _bindEvents();
  _mounted = true;

  // Wait one tick for Firestore to be ready
  setTimeout(() => {
    _startLiveListeners();
    _switchTab('dashboard');
  }, 100);

  console.log('[SNX-TV-STUDIO] TV Studio mounted — version', STUDIO_VERSION);
}

function unmount() {
  if (!_mounted) return;
  _teardownListeners();
  if (_container && _container.parentNode) _container.parentNode.removeChild(_container);
  _container = null;
  _tvMedia = [];
  _tvPlaylists = [];
  _tvPrograms = [];
  _tvSchedule = [];
  _tvSubmissions = [];
  _snsMusicLib = [];
  _snsVideoLib = [];
  _tvSettings = {};
  _mounted = false;
  _editingPlId  = null;
  _editingProgId = null;
  _editingSlotId = null;
}

/* ════════════════════════════════════════════════════════════
   BUILD DOM
════════════════════════════════════════════════════════════ */

function _buildDOM() {
  _container.innerHTML = `
<div class="snxtv-studio-wrap">

  <!-- ── STUDIO HEADER ─────────────────────────────────────── -->
  <div class="snxtv-studio-header">
    <span class="snxtv-studio-label">📺 TV STUDIO</span>
    <span class="snxtv-studio-role">FOUNDER</span>
    <button class="snxtv-studio-close" id="snxtvStudioClose" type="button" title="Close Studio">✕</button>
  </div>

  <!-- ── TAB NAV ───────────────────────────────────────────── -->
  <nav class="snxtv-studio-tabs" id="snxtvStudioTabs">
    <button class="snxtv-tab snxtv-tab--active" data-tab="dashboard">DASHBOARD</button>
    <button class="snxtv-tab" data-tab="submissions">SUBMISSIONS</button>
    <button class="snxtv-tab" data-tab="media">MEDIA</button>
    <button class="snxtv-tab" data-tab="playlists">PLAYLISTS</button>
    <button class="snxtv-tab" data-tab="programming">PROGRAMMING</button>
    <button class="snxtv-tab" data-tab="schedule">SCHEDULE</button>
    <button class="snxtv-tab" data-tab="settings">SETTINGS</button>
  </nav>

  <!-- ── PANELS ────────────────────────────────────────────── -->
  <div class="snxtv-panel" id="snxtvPanelDashboard">
    <div id="snxtvDashboardPanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelSubmissions">
    <div id="snxtvSubmissionsPanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelMedia">
    <div id="snxtvMediaPanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelPlaylists">
    <div id="snxtvPlaylistsPanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelProgramming">
    <div id="snxtvProgrammingPanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelSchedule">
    <div id="snxtvSchedulePanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelSettings">
    <div id="snxtvSettingsPanel"></div>
  </div>

</div>
`;
}

/* ════════════════════════════════════════════════════════════
   EVENTS
════════════════════════════════════════════════════════════ */

function _bindEvents() {
  // Close button
  const closeBtn = _container.querySelector('#snxtvStudioClose');
  if (closeBtn) closeBtn.addEventListener('click', () => SNXTVStudio.hide());

  // Tab switching
  const tabs = _container.querySelectorAll('.snxtv-tab');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });
}

function _switchTab(tab) {
  _activeTab = tab;

  const allTabs = _container.querySelectorAll('.snxtv-tab');
  allTabs.forEach(b => b.classList.toggle('snxtv-tab--active', b.dataset.tab === tab));

  const allPanels = _container.querySelectorAll('.snxtv-panel');
  allPanels.forEach(p => p.classList.add('snxtv-panel--hidden'));

  const activePanel = _container.querySelector(`#snxtvPanel${tab.charAt(0).toUpperCase() + tab.slice(1)}`);
  if (activePanel) activePanel.classList.remove('snxtv-panel--hidden');

  if (tab === 'dashboard')   _renderDashboardPanel();
  if (tab === 'submissions') _renderSubmissionsPanel();
  if (tab === 'media')       _renderMediaPanel();
  if (tab === 'playlists')   _renderPlaylistsPanel();
  if (tab === 'programming') _renderProgrammingPanel();
  if (tab === 'schedule')    _renderSchedulePanel();
  if (tab === 'settings')    _renderSettingsPanel();
}

/* ════════════════════════════════════════════════════════════
   FIRESTORE LIVE LISTENERS
════════════════════════════════════════════════════════════ */

function _startLiveListeners() {
  const { collection, onSnapshot, query, orderBy } = _fs();
  const db = _db();
  if (!db || !collection || !onSnapshot) {
    console.warn('[SNX-TV-STUDIO] Firestore not ready — retrying in 1s');
    setTimeout(_startLiveListeners, 1000);
    return;
  }

  // ── tv_media live listener ──
  try {
    const qMedia = query(collection(db, COLL_TV_MEDIA), orderBy('createdAt', 'desc'));
    _unsubMedia = onSnapshot(qMedia, snap => {
      _tvMedia = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_activeTab === 'media') _renderMediaPanel();
      if (_activeTab === 'dashboard') _renderDashboardPanel();
    }, err => {
      console.warn('[SNX-TV-STUDIO] tv_media listener error:', err.message);
    });
  } catch (e) {
    console.warn('[SNX-TV-STUDIO] tv_media listener setup failed:', e.message);
  }

  // ── tv_playlists live listener ──
  try {
    const qPl = query(collection(db, COLL_TV_PLAYLISTS), orderBy('createdAt', 'asc'));
    _unsubPlaylists = onSnapshot(qPl, snap => {
      _tvPlaylists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_activeTab === 'playlists') _renderPlaylistsPanel();
      if (_activeTab === 'dashboard') _renderDashboardPanel();
    }, err => {
      console.warn('[SNX-TV-STUDIO] tv_playlists listener error:', err.message);
    });
  } catch (e) {
    console.warn('[SNX-TV-STUDIO] tv_playlists listener setup failed:', e.message);
  }

  // ── tv_programs live listener ──
  try {
    const qProg = query(collection(db, COLL_TV_PROGRAMS), orderBy('createdAt', 'asc'));
    _unsubPrograms = onSnapshot(qProg, snap => {
      _tvPrograms = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_activeTab === 'programming') _renderProgrammingPanel();
      if (_activeTab === 'schedule')    _renderSchedulePanel();
      if (_activeTab === 'dashboard')   _renderDashboardPanel();
    }, err => {
      console.warn('[SNX-TV-STUDIO] tv_programs listener error:', err.message);
    });
  } catch (e) {
    console.warn('[SNX-TV-STUDIO] tv_programs listener setup failed:', e.message);
  }

  // ── tv_schedule live listener ──
  try {
    const qSched = query(collection(db, COLL_TV_SCHEDULE), orderBy('startTime', 'asc'));
    _unsubSchedule = onSnapshot(qSched, snap => {
      _tvSchedule = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_activeTab === 'schedule')  _renderSchedulePanel();
      if (_activeTab === 'dashboard') _renderDashboardPanel();
    }, err => {
      console.warn('[SNX-TV-STUDIO] tv_schedule listener error:', err.message);
    });
  } catch (e) {
    console.warn('[SNX-TV-STUDIO] tv_schedule listener setup failed:', e.message);
  }

  // ── tv_submissions live listener ──
  try {
    const qSub = query(collection(db, COLL_TV_SUBMISSIONS), orderBy('submittedAt', 'desc'));
    _unsubSubmissions = onSnapshot(qSub, snap => {
      _tvSubmissions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (_activeTab === 'submissions') _renderSubmissionsPanel();
      if (_activeTab === 'dashboard')   _renderDashboardPanel();
    }, err => {
      console.warn('[SNX-TV-STUDIO] tv_submissions listener error:', err.message);
    });
  } catch (e) {
    console.warn('[SNX-TV-STUDIO] tv_submissions listener setup failed:', e.message);
  }
}

function _teardownListeners() {
  if (_unsubMedia)       { try { _unsubMedia(); }       catch(_){} _unsubMedia       = null; }
  if (_unsubPlaylists)   { try { _unsubPlaylists(); }   catch(_){} _unsubPlaylists   = null; }
  if (_unsubPrograms)    { try { _unsubPrograms(); }    catch(_){} _unsubPrograms    = null; }
  if (_unsubSchedule)    { try { _unsubSchedule(); }    catch(_){} _unsubSchedule    = null; }
  if (_unsubSubmissions) { try { _unsubSubmissions(); } catch(_){} _unsubSubmissions = null; }
}

/* ════════════════════════════════════════════════════════════
   MEDIA PANEL
   Shows tv_media library + SNS source library for adding.
════════════════════════════════════════════════════════════ */

function _renderMediaPanel() {
  const el = _container && _container.querySelector('#snxtvMediaPanel');
  if (!el) return;

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <span>TV Media Library</span>
    <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnAddFromSNS">+ Add from SNS Media</button>
    <button class="snxtv-btn snxtv-btn--ghost" id="snxtvBtnUploadNew">↑ Upload New</button>
  </div>
  <div id="snxtvMediaGrid" class="snxtv-media-grid"></div>
</div>
<div class="snxtv-section snxtv-section--hidden" id="snxtvSnsLibSection">
  <div class="snxtv-section-header">
    <span>SNS Media — Select to Add to TV</span>
    <button class="snxtv-btn snxtv-btn--ghost" id="snxtvBtnCloseSNS">✕ Close</button>
  </div>
  <div class="snxtv-section-tabs" id="snxtvSnsLibTabs">
    <button class="snxtv-stab snxtv-stab--active" data-lib="music">🎵 Audio</button>
    <button class="snxtv-stab" data-lib="video">🎬 Video</button>
  </div>
  <div id="snxtvSnsLibGrid" class="snxtv-media-grid"></div>
</div>
<div class="snxtv-section snxtv-section--hidden" id="snxtvUploadSection">
  <div class="snxtv-section-header">
    <span>Upload Media to SNS + TV</span>
    <button class="snxtv-btn snxtv-btn--ghost" id="snxtvBtnCloseUpload">✕ Cancel</button>
  </div>
  ${_renderUploadForm()}
</div>
`;

  // Populate media grid and bind its card buttons
  const mediaGrid = el.querySelector('#snxtvMediaGrid');
  if (mediaGrid) {
    mediaGrid.innerHTML = _renderTvMediaGrid();
    _bindMediaCardEvents();
  }

  // Bind add-from-SNS
  el.querySelector('#snxtvBtnAddFromSNS').addEventListener('click', () => _openSnsLib('music'));
  el.querySelector('#snxtvBtnUploadNew').addEventListener('click', () => _openUploadSection());
  el.querySelector('#snxtvBtnCloseSNS').addEventListener('click', () => _closeSnsLib());
  el.querySelector('#snxtvBtnCloseUpload').addEventListener('click', () => _closeUploadSection());

  // SNS lib sub-tabs
  el.querySelectorAll('.snxtv-stab').forEach(btn => {
    btn.addEventListener('click', () => _openSnsLib(btn.dataset.lib));
  });

  // Upload form events
  _bindUploadFormEvents(el);
}

function _renderTvMediaGrid() {
  if (!_tvMedia.length) {
    return '<div class="snxtv-empty">No media in TV library yet. Add from SNS Media or upload new.</div>';
  }
  return _tvMedia.map(item => `
<div class="snxtv-media-card" data-id="${_esc(item.id)}">
  <div class="snxtv-media-thumb">${item.artworkUrl ? `<img src="${_esc(item.artworkUrl)}" alt="">` : (item.mediaType === 'video' ? '🎬' : '🎵')}</div>
  <div class="snxtv-media-info">
    <div class="snxtv-media-title">${_esc(item.title || 'Untitled')}</div>
    <div class="snxtv-media-meta">${item.mediaType === 'video' ? '📹' : '🎵'} ${item.mediaType || '?'} · ${_fmtDur(item.duration)}</div>
  </div>
  <div class="snxtv-media-actions">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm snxtv-btn-addtopl" data-id="${_esc(item.id)}" title="Add to playlist">+PL</button>
    <button class="snxtv-btn snxtv-btn--danger snxtv-btn--sm snxtv-btn-remove" data-id="${_esc(item.id)}" title="Remove from TV library">✕</button>
  </div>
</div>`).join('');
}

function _bindMediaCardEvents() {
  const grid = _container && _container.querySelector('#snxtvMediaGrid');
  if (!grid) return;
  grid.querySelectorAll('.snxtv-btn-remove').forEach(btn => {
    btn.addEventListener('click', () => _removeTvMedia(btn.dataset.id));
  });
  grid.querySelectorAll('.snxtv-btn-addtopl').forEach(btn => {
    btn.addEventListener('click', () => _promptAddToPlaylist(btn.dataset.id));
  });
}

/* ── SNS Library Browser ── */

async function _openSnsLib(libType) {
  const section = _container && _container.querySelector('#snxtvSnsLibSection');
  if (!section) return;
  section.classList.remove('snxtv-section--hidden');

  // Activate tab
  const tabs = _container.querySelectorAll('.snxtv-stab');
  tabs.forEach(t => t.classList.toggle('snxtv-stab--active', t.dataset.lib === libType));

  const grid = _container.querySelector('#snxtvSnsLibGrid');
  grid.innerHTML = '<div class="snxtv-loading">Loading SNS media…</div>';

  try {
    if (libType === 'music') {
      await _loadSnsMusicLib();
      grid.innerHTML = _renderSnsMusicGrid();
    } else {
      await _loadSnsVideoLib();
      grid.innerHTML = _renderSnsVideoGrid();
    }
  } catch (e) {
    grid.innerHTML = `<div class="snxtv-empty">Could not load SNS media: ${_esc(e.message)}</div>`;
    return;
  }

  // Bind select buttons
  grid.querySelectorAll('.snxtv-btn-select').forEach(btn => {
    btn.addEventListener('click', () => {
      const sourceType = btn.dataset.sourceType;
      const sourceId   = btn.dataset.sourceId;
      _addToTvMedia(sourceType, sourceId);
    });
  });
}

function _closeSnsLib() {
  const section = _container && _container.querySelector('#snxtvSnsLibSection');
  if (section) section.classList.add('snxtv-section--hidden');
}

async function _loadSnsMusicLib() {
  const { collection, getDocs, query, orderBy } = _fs();
  const db = _db();
  const cu = _cu();
  if (!db || !cu) return;
  try {
    // Load all profileMusic (Firestore rule allows signed-in users to read)
    const q = query(collection(db, COLL_PROFILE_MUSIC), orderBy('uploadedAt', 'desc'));
    const snap = await getDocs(q);
    _snsMusicLib = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Index fallback
    const snap = await _fs().getDocs(_fs().collection(db, COLL_PROFILE_MUSIC));
    _snsMusicLib = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }
}

async function _loadSnsVideoLib() {
  const { collection, getDocs, query, where, orderBy } = _fs();
  const db = _db();
  if (!db) return;
  try {
    const q = query(
      collection(db, COLL_VIDEOS),
      where('status', '==', 'published'),
      where('visibility', '==', 'public'),
      orderBy('createdAt', 'desc')
    );
    const snap = await getDocs(q);
    _snsVideoLib = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // Fallback: skip ordering
    try {
      const q2 = query(collection(db, COLL_VIDEOS), where('status', '==', 'published'));
      const snap = await _fs().getDocs(q2);
      _snsVideoLib = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e2) {
      _snsVideoLib = [];
    }
  }
}

function _renderSnsMusicGrid() {
  if (!_snsMusicLib.length) {
    return '<div class="snxtv-empty">No audio found in SNS library.</div>';
  }
  // Filter out items already in TV library
  const existingSourceIds = new Set(_tvMedia.map(m => m.sourceId));
  return _snsMusicLib.map(s => {
    const url = s.musicUrl || s.downloadURL || s.url || '';
    if (!url) return ''; // skip items without playable URL
    const inTv = existingSourceIds.has(s.id);
    return `
<div class="snxtv-media-card snxtv-media-card--sns ${inTv ? 'snxtv-media-card--added' : ''}">
  <div class="snxtv-media-thumb">${s.artUrl || s.coverImage ? `<img src="${_esc(s.artUrl || s.coverImage)}" alt="">` : '🎵'}</div>
  <div class="snxtv-media-info">
    <div class="snxtv-media-title">${_esc(s.title || 'Untitled')}</div>
    <div class="snxtv-media-meta">🎵 Audio · ${_fmtDur(s.duration)}</div>
  </div>
  <div class="snxtv-media-actions">
    ${inTv
      ? '<span class="snxtv-badge-added">✓ In TV</span>'
      : `<button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm snxtv-btn-select" data-source-type="music" data-source-id="${_esc(s.id)}">Add</button>`
    }
  </div>
</div>`;
  }).filter(Boolean).join('') || '<div class="snxtv-empty">No audio with playable URLs found.</div>';
}

function _renderSnsVideoGrid() {
  if (!_snsVideoLib.length) {
    return '<div class="snxtv-empty">No published public videos found in SNS library.</div>';
  }
  const existingSourceIds = new Set(_tvMedia.map(m => m.sourceId));
  return _snsVideoLib.map(v => {
    const url = v.videoUrl || v.r2Url || '';
    if (!url) return '';
    const inTv = existingSourceIds.has(v.id);
    return `
<div class="snxtv-media-card snxtv-media-card--sns ${inTv ? 'snxtv-media-card--added' : ''}">
  <div class="snxtv-media-thumb">${v.thumbnailUrl ? `<img src="${_esc(v.thumbnailUrl)}" alt="">` : '🎬'}</div>
  <div class="snxtv-media-info">
    <div class="snxtv-media-title">${_esc(v.title || 'Untitled')}</div>
    <div class="snxtv-media-meta">📹 Video · ${_fmtDur(v.duration)}</div>
  </div>
  <div class="snxtv-media-actions">
    ${inTv
      ? '<span class="snxtv-badge-added">✓ In TV</span>'
      : `<button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm snxtv-btn-select" data-source-type="video" data-source-id="${_esc(v.id)}">Add</button>`
    }
  </div>
</div>`;
  }).filter(Boolean).join('') || '<div class="snxtv-empty">No videos with playable URLs found.</div>';
}

/* ── Add SNS media to TV library (store reference only — no file copy) ── */

async function _addToTvMedia(sourceType, sourceId) {
  const { addDoc, collection, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;

  let sourceDoc = null;
  let mediaUrl  = '';
  let mediaType = '';
  let title     = '';
  let artworkUrl= '';
  let duration  = 0;

  try {
    if (sourceType === 'music') {
      const s = _snsMusicLib.find(x => x.id === sourceId);
      if (!s) { _toast('Source track not found.'); return; }
      mediaUrl  = s.musicUrl || s.downloadURL || s.url || '';
      mediaType = 'audio';
      title     = s.title || 'Untitled';
      artworkUrl= s.artUrl || s.coverImage || '';
      duration  = s.duration || 0;
      sourceDoc = { collection: COLL_PROFILE_MUSIC, id: sourceId };
    } else {
      const v = _snsVideoLib.find(x => x.id === sourceId);
      if (!v) { _toast('Source video not found.'); return; }
      mediaUrl  = v.videoUrl || v.r2Url || '';
      mediaType = 'video';
      title     = v.title || 'Untitled';
      artworkUrl= v.thumbnailUrl || '';
      duration  = v.duration || 0;
      sourceDoc = { collection: COLL_VIDEOS, id: sourceId };
    }
  } catch (e) {
    _toast('Error reading source: ' + e.message);
    return;
  }

  if (!mediaUrl) { _toast('This item has no playable URL.'); return; }

  try {
    await addDoc(collection(db, COLL_TV_MEDIA), {
      title,
      mediaType,
      mediaUrl,
      artworkUrl,
      duration,
      sourceId,                    // Firestore doc ID of the original SNS item
      sourceCollection: sourceDoc.collection, // 'profileMusic' | 'videos'
      sourceType,                  // 'music' | 'video'
      addedBy:   (_cu() || {}).uid || '',
      createdAt: serverTimestamp()
    });
    _toast('✓ Added to TV Media Library');
    // Refresh the SNS lib to update "In TV" badges
    if (sourceType === 'music') {
      const grid = _container && _container.querySelector('#snxtvSnsLibGrid');
      if (grid) {
        await _loadSnsMusicLib();
        grid.innerHTML = _renderSnsMusicGrid();
        grid.querySelectorAll('.snxtv-btn-select').forEach(btn => {
          btn.addEventListener('click', () => _addToTvMedia(btn.dataset.sourceType, btn.dataset.sourceId));
        });
      }
    }
  } catch (e) {
    _toast('Could not add to TV library: ' + e.message);
    console.error('[SNX-TV-STUDIO] addToTvMedia error:', e);
  }
}

/* ── Remove from TV media library ── */

async function _removeTvMedia(mediaId) {
  // Stage 4: warn if media is referenced by any program before deleting
  const referencingPrograms = _tvPrograms.filter(p => p.sourceRef === mediaId && p.sourceType === 'media');
  const inPlaylists = _tvPlaylists.filter(pl => (pl.items || []).some(i => i.mediaId === mediaId));
  let warnMsg = 'Remove this item from the TV Media Library?\nThe original SNS media is NOT deleted.';
  if (referencingPrograms.length) {
    warnMsg += '\n\n⚠ This item is used by ' + referencingPrograms.length + ' program(s): ' +
      referencingPrograms.map(p => p.name || 'Untitled').join(', ');
  }
  if (inPlaylists.length) {
    warnMsg += '\n\n⚠ This item is in ' + inPlaylists.length + ' playlist(s): ' +
      inPlaylists.map(p => p.name || 'Untitled').join(', ');
  }
  if (!confirm(warnMsg)) return;
  const { doc, deleteDoc } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await deleteDoc(doc(db, COLL_TV_MEDIA, mediaId));
    // Also remove from any playlists that reference it
    await _removeMediaFromAllPlaylists(mediaId);
    _toast('Removed from TV library.');
  } catch (e) {
    _toast('Remove failed: ' + e.message);
  }
}

async function _removeMediaFromAllPlaylists(mediaId) {
  const { doc, updateDoc } = _fs();
  const db = _db();
  if (!db) return;
  const affected = _tvPlaylists.filter(pl => (pl.items || []).some(i => i.mediaId === mediaId));
  for (const pl of affected) {
    const newItems = (pl.items || []).filter(i => i.mediaId !== mediaId);
    await updateDoc(doc(db, COLL_TV_PLAYLISTS, pl.id), { items: newItems }).catch(() => {});
  }
}

/* ── Prompt add to playlist (from media card) ── */

function _promptAddToPlaylist(mediaId) {
  if (!_tvPlaylists.length) {
    _toast('No playlists yet. Create one in the Playlists tab first.');
    return;
  }
  // Build a quick pick UI
  const existing = document.getElementById('snxtvAddToPlModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'snxtvAddToPlModal';
  modal.className = 'snxtv-modal-overlay';
  modal.innerHTML = `
<div class="snxtv-modal">
  <div class="snxtv-modal-header">Add to Playlist <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvAddToPlClose">✕</button></div>
  <div class="snxtv-modal-body">
    ${_tvPlaylists.map(pl => `
      <button class="snxtv-pl-pick-btn" data-pl-id="${_esc(pl.id)}">${_esc(pl.name || 'Untitled')}</button>
    `).join('')}
  </div>
</div>`;
  document.body.appendChild(modal);
  modal.querySelector('#snxtvAddToPlClose').addEventListener('click', () => modal.remove());
  modal.querySelectorAll('.snxtv-pl-pick-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await _addItemToPlaylist(btn.dataset.plId, mediaId);
      modal.remove();
    });
  });
}

/* ════════════════════════════════════════════════════════════
   UPLOAD SECTION (uses existing SNS /upload-music pipeline)
════════════════════════════════════════════════════════════ */

function _renderUploadForm() {
  return `
<div class="snxtv-upload-form" id="snxtvUploadForm">
  <p class="snxtv-upload-note">Files are uploaded to SNS storage (R2) using the standard SNS pipeline and immediately added to the TV Media Library.</p>
  <div class="snxtv-form-row">
    <label for="snxtvUploadFile">Audio File (.mp3, .aac, .flac, .wav, .ogg, .m4a)</label>
    <input type="file" id="snxtvUploadFile" accept=".mp3,.aac,.flac,.wav,.ogg,.m4a,audio/*">
  </div>
  <div class="snxtv-form-row">
    <label for="snxtvUploadTitle">Title</label>
    <input type="text" id="snxtvUploadTitle" placeholder="Track title" maxlength="200">
  </div>
  <div class="snxtv-progress-bar-wrap" id="snxtvUploadProgressWrap" style="display:none;">
    <div class="snxtv-progress-bar" id="snxtvUploadProgressBar"></div>
    <span id="snxtvUploadProgressLabel">0%</span>
  </div>
  <div class="snxtv-form-actions">
    <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnDoUpload">Upload &amp; Add to TV</button>
  </div>
  <div class="snxtv-upload-status" id="snxtvUploadStatus"></div>
</div>`;
}

function _openUploadSection() {
  const s = _container && _container.querySelector('#snxtvUploadSection');
  const lib = _container && _container.querySelector('#snxtvSnsLibSection');
  if (s) s.classList.remove('snxtv-section--hidden');
  if (lib) lib.classList.add('snxtv-section--hidden');
}

function _closeUploadSection() {
  const s = _container && _container.querySelector('#snxtvUploadSection');
  if (s) s.classList.add('snxtv-section--hidden');
}

function _bindUploadFormEvents(panelEl) {
  const btn = panelEl.querySelector('#snxtvBtnDoUpload');
  if (!btn) return;
  btn.addEventListener('click', _doUpload);
}

async function _doUpload() {
  const fileInput  = _container && _container.querySelector('#snxtvUploadFile');
  const titleInput = _container && _container.querySelector('#snxtvUploadTitle');
  const statusEl   = _container && _container.querySelector('#snxtvUploadStatus');
  const progressWrap = _container && _container.querySelector('#snxtvUploadProgressWrap');
  const progressBar  = _container && _container.querySelector('#snxtvUploadProgressBar');
  const progressLabel= _container && _container.querySelector('#snxtvUploadProgressLabel');

  if (!fileInput || !fileInput.files.length) { _toast('Choose a file first.'); return; }
  const file = fileInput.files[0];
  const title = (titleInput && titleInput.value.trim()) || file.name.replace(/\.[^.]+$/, '');

  const cu = _cu();
  if (!cu) { _toast('Not signed in.'); return; }

  let idToken;
  try { idToken = await _getIdToken(); }
  catch (e) { _toast('Auth failed: ' + e.message); return; }

  // R2 key in tv/{uid}/ namespace (already in upload-worker allowedPrefixes)
  const ext    = (file.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '');
  const r2Key  = `tv/${cu.uid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

  if (statusEl) statusEl.textContent = 'Uploading…';
  if (progressWrap) progressWrap.style.display = 'flex';

  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('path', r2Key);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = 10 * 60 * 1000;

    xhr.upload.onprogress = e => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      if (progressBar) progressBar.style.width = pct + '%';
      if (progressLabel) progressLabel.textContent = pct + '%';
    };

    xhr.onload = async () => {
      if (progressWrap) progressWrap.style.display = 'none';
      let resp;
      try { resp = JSON.parse(xhr.responseText); } catch { resp = {}; }

      if (xhr.status >= 200 && xhr.status < 300 && resp.url) {
        if (statusEl) statusEl.textContent = '✓ Uploaded. Adding to TV library…';
        // Store Firestore metadata in profileMusic (same as SNS standard upload)
        const { addDoc, collection, serverTimestamp } = _fs();
        const db = _db();
        let firestoreId = null;
        if (db) {
          try {
            const docRef = await addDoc(collection(db, COLL_PROFILE_MUSIC), {
              ownerUid:   cu.uid,
              ownerId:    cu.uid,
              userId:     cu.uid,
              title,
              artist:     (global._snxUserData && global._snxUserData.displayName) || '',
              musicUrl:   resp.url,
              downloadURL:resp.url,
              r2Key,
              duration:   0,
              visibility: 'public',
              isPublic:   true,
              uploadedAt: serverTimestamp(),
              source:     'tv-studio',
            });
            firestoreId = docRef.id;
          } catch (fe) {
            console.warn('[SNX-TV-STUDIO] profileMusic write failed:', fe.message);
          }
        }
        // Add to tv_media immediately
        if (db) {
          try {
            await addDoc(collection(db, COLL_TV_MEDIA), {
              title,
              mediaType:   'audio',
              mediaUrl:    resp.url,
              artworkUrl:  '',
              duration:    0,
              sourceId:    firestoreId || r2Key,
              sourceCollection: COLL_PROFILE_MUSIC,
              sourceType:  'music',
              r2Key,
              addedBy:     cu.uid,
              createdAt:   serverTimestamp()
            });
          } catch (te) {
            console.warn('[SNX-TV-STUDIO] tv_media write failed:', te.message);
          }
        }
        if (statusEl) statusEl.textContent = '✓ Added to TV Media Library!';
        if (fileInput) fileInput.value = '';
        if (titleInput) titleInput.value = '';
        _toast('✓ Upload complete and added to TV.');
        _closeUploadSection();
        resolve();
      } else {
        if (statusEl) statusEl.textContent = '✗ Upload failed: ' + (resp.error || `HTTP ${xhr.status}`);
        _toast('Upload failed.');
        resolve();
      }
    };

    xhr.onerror  = () => { if (statusEl) statusEl.textContent = '✗ Network error.'; _toast('Upload error.'); resolve(); };
    xhr.ontimeout= () => { if (statusEl) statusEl.textContent = '✗ Upload timed out.'; resolve(); };

    xhr.open('POST', R2_WORKER_URL + '/upload-music');
    xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);
    xhr.send(formData);
  });
}

/* ════════════════════════════════════════════════════════════
   PLAYLISTS PANEL
════════════════════════════════════════════════════════════ */

function _renderPlaylistsPanel() {
  const el = _container && _container.querySelector('#snxtvPlaylistsPanel');
  if (!el) return;

  if (_editingPlId) {
    _renderPlaylistEditor(el, _editingPlId);
    return;
  }

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <span>TV Playlists</span>
    <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnNewPlaylist">+ New Playlist</button>
  </div>
  <div id="snxtvPlaylistList">
    ${_renderPlaylistList()}
  </div>
</div>
`;

  el.querySelector('#snxtvBtnNewPlaylist').addEventListener('click', _createPlaylist);

  el.querySelectorAll('.snxtv-pl-edit').forEach(btn => {
    btn.addEventListener('click', () => { _editingPlId = btn.dataset.id; _renderPlaylistsPanel(); });
  });
  el.querySelectorAll('.snxtv-pl-load').forEach(btn => {
    btn.addEventListener('click', () => _loadPlaylistToTV(btn.dataset.id));
  });
  el.querySelectorAll('.snxtv-pl-delete').forEach(btn => {
    btn.addEventListener('click', () => _deletePlaylist(btn.dataset.id));
  });
}

function _renderPlaylistList() {
  if (!_tvPlaylists.length) {
    return '<div class="snxtv-empty">No playlists yet. Create one to get started.</div>';
  }
  return _tvPlaylists.map(pl => {
    const itemCount = (pl.items || []).length;
    return `
<div class="snxtv-pl-row" data-id="${_esc(pl.id)}">
  <div class="snxtv-pl-info">
    <div class="snxtv-pl-name">${_esc(pl.name || 'Untitled')}</div>
    <div class="snxtv-pl-meta">${itemCount} item${itemCount !== 1 ? 's' : ''} · ${_ts(pl.createdAt?.seconds ? pl.createdAt.seconds * 1000 : pl.createdAt)}</div>
  </div>
  <div class="snxtv-pl-actions">
    <button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm snxtv-pl-load" data-id="${_esc(pl.id)}" title="Load into TV">▶ Load to TV</button>
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm snxtv-pl-edit" data-id="${_esc(pl.id)}" title="Edit playlist">✏ Edit</button>
    <button class="snxtv-btn snxtv-btn--danger snxtv-btn--sm snxtv-pl-delete" data-id="${_esc(pl.id)}" title="Delete playlist">🗑</button>
  </div>
</div>`;
  }).join('');
}

async function _createPlaylist() {
  const name = prompt('Playlist name:');
  if (!name || !name.trim()) { _toast('Playlist name cannot be blank.'); return; }
  const { addDoc, collection, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    const docRef = await addDoc(collection(db, COLL_TV_PLAYLISTS), {
      name:      name.trim(),
      items:     [],
      ownerId:   (_cu() || {}).uid || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    _toast('✓ Playlist created.');
    _editingPlId = docRef.id;
    _renderPlaylistsPanel();
  } catch (e) {
    _toast('Could not create playlist: ' + e.message);
  }
}

async function _deletePlaylist(plId) {
  // Stage 4: warn if this playlist is referenced by any program
  const referencingPrograms = _tvPrograms.filter(p => p.sourceRef === plId && p.sourceType === 'playlist');
  let warnMsg = 'Delete this playlist?\nMedia items are NOT deleted from SNS storage.';
  if (referencingPrograms.length) {
    warnMsg += '\n\n⚠ This playlist is used by ' + referencingPrograms.length + ' program(s): ' +
      referencingPrograms.map(p => p.name || 'Untitled').join(', ');
  }
  if (!confirm(warnMsg)) return;
  const { doc, deleteDoc } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await deleteDoc(doc(db, COLL_TV_PLAYLISTS, plId));
    if (_editingPlId === plId) _editingPlId = null;
    _toast('Playlist deleted.');
  } catch (e) {
    _toast('Delete failed: ' + e.message);
  }
}

/* ── Playlist Editor ── */

function _renderPlaylistEditor(el, plId) {
  const pl = _tvPlaylists.find(p => p.id === plId);
  if (!pl) { _editingPlId = null; _renderPlaylistsPanel(); return; }

  const items = pl.items || [];

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnBackToPl">← Back</button>
    <span id="snxtvPlEditorName" style="flex:1;margin:0 8px;font-weight:600;">${_esc(pl.name || 'Untitled')}</span>
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnRenamePl">✏ Rename</button>
    <button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm" id="snxtvBtnLoadThisPl">▶ Load to TV</button>
  </div>

  <div class="snxtv-pl-editor">
    <div class="snxtv-pl-editor-items" id="snxtvPlItems">
      ${_renderPlaylistEditorItems(items)}
    </div>
    <div class="snxtv-pl-add-section">
      <div class="snxtv-section-header" style="margin-top:16px;">
        <span>Add media from TV Library</span>
      </div>
      <div class="snxtv-pl-add-grid" id="snxtvPlAddGrid">
        ${_renderTvMediaAddGrid(items)}
      </div>
    </div>
  </div>
</div>
`;

  el.querySelector('#snxtvBtnBackToPl').addEventListener('click', () => {
    _editingPlId = null; _renderPlaylistsPanel();
  });
  el.querySelector('#snxtvBtnRenamePl').addEventListener('click', () => _renamePlaylist(plId));
  el.querySelector('#snxtvBtnLoadThisPl').addEventListener('click', () => _loadPlaylistToTV(plId));

  // Remove items
  el.querySelectorAll('.snxtv-pl-item-remove').forEach(btn => {
    btn.addEventListener('click', () => _removePlaylistItem(plId, parseInt(btn.dataset.idx, 10)));
  });

  // Move up/down
  el.querySelectorAll('.snxtv-pl-item-up').forEach(btn => {
    btn.addEventListener('click', () => _movePlaylistItem(plId, parseInt(btn.dataset.idx, 10), -1));
  });
  el.querySelectorAll('.snxtv-pl-item-down').forEach(btn => {
    btn.addEventListener('click', () => _movePlaylistItem(plId, parseInt(btn.dataset.idx, 10), 1));
  });

  // Add items from library
  el.querySelectorAll('.snxtv-pl-add-btn').forEach(btn => {
    btn.addEventListener('click', () => _addItemToPlaylist(plId, btn.dataset.mediaId));
  });
}

function _renderPlaylistEditorItems(items) {
  if (!items.length) {
    return '<div class="snxtv-empty">No items yet. Add from the TV Media Library below.</div>';
  }
  return items.map((item, idx) => {
    const media = _tvMedia.find(m => m.id === item.mediaId);
    const title  = media ? (media.title || 'Untitled') : '(Unavailable)';
    const typeIcon = media ? (media.mediaType === 'video' ? '🎬' : '🎵') : '⚠';
    const unavailable = !media;
    return `
<div class="snxtv-pl-item${unavailable ? ' snxtv-pl-item--unavailable' : ''}">
  <span class="snxtv-pl-item-num">${idx + 1}</span>
  <span class="snxtv-pl-item-type">${typeIcon}</span>
  <span class="snxtv-pl-item-title">${_esc(title)}</span>
  ${unavailable ? '<span class="snxtv-badge-unavail">Unavailable</span>' : ''}
  <div class="snxtv-pl-item-btns">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--xs snxtv-pl-item-up" data-idx="${idx}" ${idx === 0 ? 'disabled' : ''}>↑</button>
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--xs snxtv-pl-item-down" data-idx="${idx}" ${idx === items.length - 1 ? 'disabled' : ''}>↓</button>
    <button class="snxtv-btn snxtv-btn--danger snxtv-btn--xs snxtv-pl-item-remove" data-idx="${idx}">✕</button>
  </div>
</div>`;
  }).join('');
}

function _renderTvMediaAddGrid(existingItems) {
  if (!_tvMedia.length) {
    return '<div class="snxtv-empty">TV Media Library is empty. Add media in the Media tab first.</div>';
  }
  const existingMediaIds = new Set(existingItems.map(i => i.mediaId));
  return _tvMedia.map(m => {
    const inPl = existingMediaIds.has(m.id);
    return `
<div class="snxtv-media-card snxtv-media-card--compact">
  <span class="snxtv-media-type-icon">${m.mediaType === 'video' ? '🎬' : '🎵'}</span>
  <span class="snxtv-media-title-sm">${_esc(m.title || 'Untitled')}</span>
  ${inPl
    ? '<span class="snxtv-badge-added">✓ Added</span>'
    : `<button class="snxtv-btn snxtv-btn--primary snxtv-btn--xs snxtv-pl-add-btn" data-media-id="${_esc(m.id)}">+ Add</button>`
  }
</div>`;
  }).join('');
}

async function _renamePlaylist(plId) {
  const pl = _tvPlaylists.find(p => p.id === plId);
  const newName = prompt('New playlist name:', pl ? pl.name : '');
  if (!newName || !newName.trim()) { _toast('Name cannot be blank.'); return; }
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await updateDoc(doc(db, COLL_TV_PLAYLISTS, plId), { name: newName.trim(), updatedAt: serverTimestamp() });
    _toast('✓ Renamed.');
  } catch (e) {
    _toast('Rename failed: ' + e.message);
  }
}

async function _addItemToPlaylist(plId, mediaId) {
  const pl = _tvPlaylists.find(p => p.id === plId);
  if (!pl) return;
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  const items = [...(pl.items || []), { mediaId, order: (pl.items || []).length }];
  try {
    await updateDoc(doc(db, COLL_TV_PLAYLISTS, plId), { items, updatedAt: serverTimestamp() });
    // Re-render editor if we're in it
    if (_editingPlId === plId) _renderPlaylistsPanel();
  } catch (e) {
    _toast('Add failed: ' + e.message);
  }
}

async function _removePlaylistItem(plId, idx) {
  const pl = _tvPlaylists.find(p => p.id === plId);
  if (!pl) return;
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  const items = (pl.items || []).filter((_, i) => i !== idx)
                                .map((item, i) => ({ ...item, order: i }));
  try {
    await updateDoc(doc(db, COLL_TV_PLAYLISTS, plId), { items, updatedAt: serverTimestamp() });
  } catch (e) {
    _toast('Remove failed: ' + e.message);
  }
}

async function _movePlaylistItem(plId, idx, direction) {
  const pl = _tvPlaylists.find(p => p.id === plId);
  if (!pl) return;
  const items = [...(pl.items || [])];
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= items.length) return;
  [items[idx], items[newIdx]] = [items[newIdx], items[idx]];
  const updated = items.map((item, i) => ({ ...item, order: i }));
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await updateDoc(doc(db, COLL_TV_PLAYLISTS, plId), { items: updated, updatedAt: serverTimestamp() });
  } catch (e) {
    _toast('Move failed: ' + e.message);
  }
}

/* ════════════════════════════════════════════════════════════
   LOAD PLAYLIST → SNXTV
   Converts tv_playlists items into TVItem[] and feeds to TV Core.
════════════════════════════════════════════════════════════ */

async function _loadPlaylistToTV(plId) {
  const pl = _tvPlaylists.find(p => p.id === plId);
  if (!pl) { _toast('Playlist not found.'); return; }

  const items = (pl.items || []);
  if (!items.length) { _toast('Playlist is empty.'); return; }

  // Resolve each item against tv_media
  const tvItems = [];
  for (const item of items) {
    const media = _tvMedia.find(m => m.id === item.mediaId);
    if (!media || !media.mediaUrl) {
      // Skip unavailable items gracefully
      console.warn('[SNX-TV-STUDIO] Skipping unavailable item:', item.mediaId);
      continue;
    }
    tvItems.push({
      id:        media.id,
      title:     media.title || 'Untitled',
      mediaType: media.mediaType === 'video' ? 'video' : 'audio',
      mediaUrl:  media.mediaUrl,
      artwork:   media.artworkUrl || '',
      duration:  media.duration || 0,
      _sourceId: media.sourceId || null,
      _plId:     plId
    });
  }

  if (!tvItems.length) {
    _toast('No available media in this playlist.');
    return;
  }

  // Feed into SNXTV via the adapter
  if (global.SNXTV && typeof global.SNXTV._loadPlaylistQueue === 'function') {
    global.SNXTV._loadPlaylistQueue(tvItems, pl.name || 'TV Playlist');
    _toast('▶ Playlist loaded into TV.');
    // Navigate to TV viewer
    if (typeof global.realmNavTo === 'function') global.realmNavTo('tvPage');
  } else {
    _toast('TV Core not ready.');
  }
}

/* ════════════════════════════════════════════════════════════
   SNS MEDIA ADAPTER — called by _getQueue() in snx-tv.js
   Returns the current live tv_media queue as TVItems.
   Called synchronously so we return the cached array.
════════════════════════════════════════════════════════════ */

function getAdapterQueue() {
  // Return currently loaded playlist queue if set,
  // otherwise fall back to all tv_media in order.
  if (_currentPlaylistQueue && _currentPlaylistQueue.length) {
    return _currentPlaylistQueue.slice();
  }
  return _tvMedia
    .filter(m => m.mediaUrl)
    .map(m => ({
      id:        m.id,
      title:     m.title || 'Untitled',
      mediaType: m.mediaType === 'video' ? 'video' : 'audio',
      mediaUrl:  m.mediaUrl,
      artwork:   m.artworkUrl || '',
      duration:  m.duration || 0,
    }));
}

let _currentPlaylistQueue = null;

function setPlaylistQueue(tvItems) {
  _currentPlaylistQueue = tvItems && tvItems.length ? tvItems : null;
}

/* ════════════════════════════════════════════════════════════
   PROGRAMMING PANEL — Stage 3
   tv_programs: each references a tv_media item or tv_playlist.
════════════════════════════════════════════════════════════ */

function _renderProgrammingPanel() {
  const el = _container && _container.querySelector('#snxtvProgrammingPanel');
  if (!el) return;

  if (_editingProgId) {
    _renderProgramEditor(el, _editingProgId);
    return;
  }

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <span>TV Programs</span>
    <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnNewProgram">+ New Program</button>
  </div>
  <div id="snxtvProgramList">
    ${_renderProgramList()}
  </div>
</div>
`;

  el.querySelector('#snxtvBtnNewProgram').addEventListener('click', _createProgram);

  el.querySelectorAll('.snxtv-prog-edit').forEach(btn => {
    btn.addEventListener('click', () => { _editingProgId = btn.dataset.id; _renderProgrammingPanel(); });
  });
  el.querySelectorAll('.snxtv-prog-delete').forEach(btn => {
    btn.addEventListener('click', () => _deleteProgram(btn.dataset.id));
  });
}

function _renderProgramList() {
  if (!_tvPrograms.length) {
    return '<div class="snxtv-empty">No programs yet. Create one to get started.</div>';
  }
  return _tvPrograms.map(prog => {
    const dur = _calcStudioProgramDuration(prog);
    const src = prog.sourceType === 'playlist'
      ? ('PL: ' + (_tvPlaylists.find(p => p.id === prog.sourceRef)?.name || prog.sourceRef))
      : ('Media: ' + (_tvMedia.find(m => m.id === prog.sourceRef)?.title || prog.sourceRef));
    return `
<div class="snxtv-pl-row" data-id="${_esc(prog.id)}">
  <div class="snxtv-pl-info">
    <div class="snxtv-pl-name">${_esc(prog.name || 'Untitled')}</div>
    <div class="snxtv-pl-meta">${_esc(src)} · ${dur.hasUnknown ? '⚠ duration unknown' : _fmtDur(dur.duration)}</div>
  </div>
  <div class="snxtv-pl-actions">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm snxtv-prog-edit" data-id="${_esc(prog.id)}">✏ Edit</button>
    <button class="snxtv-btn snxtv-btn--danger snxtv-btn--sm snxtv-prog-delete" data-id="${_esc(prog.id)}">🗑</button>
  </div>
</div>`;
  }).join('');
}

function _renderProgramEditor(el, progId) {
  const prog = _tvPrograms.find(p => p.id === progId);
  if (!prog) { _editingProgId = null; _renderProgrammingPanel(); return; }

  const dur = _calcStudioProgramDuration(prog);
  const sourceLabel = prog.sourceType === 'playlist'
    ? ('Playlist: ' + (_tvPlaylists.find(p => p.id === prog.sourceRef)?.name || prog.sourceRef))
    : ('Media: ' + (_tvMedia.find(m => m.id === prog.sourceRef)?.title || prog.sourceRef));

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnBackToProgs">← Back</button>
    <span style="flex:1;margin:0 8px;font-weight:600;">${_esc(prog.name || 'Untitled')}</span>
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnRenameProgram">✏ Rename</button>
  </div>
  <div class="snxtv-pl-editor">
    <div class="snxtv-prog-detail-row"><span class="snxtv-prog-detail-label">Source:</span> <span>${_esc(sourceLabel)}</span></div>
    <div class="snxtv-prog-detail-row"><span class="snxtv-prog-detail-label">Duration:</span>
      <span>${dur.hasUnknown ? '<span class="snxtv-dur-warn">⚠ Unknown duration — some items missing duration metadata. Cannot schedule accurately.</span>' : _fmtDur(dur.duration)}</span>
    </div>
    <div class="snxtv-prog-detail-row"><span class="snxtv-prog-detail-label">Description:</span>
      <span>${_esc(prog.description || '—')}</span>
    </div>
    <div style="margin-top:12px;">
      <div class="snxtv-section-header" style="margin-bottom:8px;"><span>Change Source</span></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvProgPickMedia">Set Media Source</button>
        <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvProgPickPlaylist">Set Playlist Source</button>
      </div>
      <div id="snxtvProgPickGrid" style="margin-top:8px;"></div>
    </div>
    <div style="margin-top:12px;">
      <label style="display:block;font-size:11px;color:rgba(255,255,255,0.5);margin-bottom:4px;">Description (optional)</label>
      <input type="text" id="snxtvProgDescInput" value="${_esc(prog.description || '')}" maxlength="300" style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.3);border:1px solid rgba(0,212,255,0.2);color:#fff;padding:7px 10px;border-radius:6px;font-size:12px;">
      <button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm" id="snxtvProgSaveDesc" style="margin-top:6px;">Save Description</button>
    </div>
  </div>
</div>
`;

  el.querySelector('#snxtvBtnBackToProgs').addEventListener('click', () => {
    _editingProgId = null; _renderProgrammingPanel();
  });
  el.querySelector('#snxtvBtnRenameProgram').addEventListener('click', () => _renameProgram(progId));
  el.querySelector('#snxtvProgSaveDesc').addEventListener('click', async () => {
    const desc = el.querySelector('#snxtvProgDescInput').value.trim();
    await _updateProgramField(progId, { description: desc });
    _toast('✓ Description saved.');
  });
  el.querySelector('#snxtvProgPickMedia').addEventListener('click', () => _renderProgPickGrid(el, progId, 'media'));
  el.querySelector('#snxtvProgPickPlaylist').addEventListener('click', () => _renderProgPickGrid(el, progId, 'playlist'));
}

function _renderProgPickGrid(el, progId, sourceType) {
  const grid = el.querySelector('#snxtvProgPickGrid');
  if (!grid) return;

  if (sourceType === 'media') {
    if (!_tvMedia.length) { grid.innerHTML = '<div class="snxtv-empty">No TV media available.</div>'; return; }
    grid.innerHTML = _tvMedia.map(m => `
<div class="snxtv-media-card snxtv-media-card--compact">
  <span class="snxtv-media-type-icon">${m.mediaType === 'video' ? '🎬' : '🎵'}</span>
  <span class="snxtv-media-title-sm">${_esc(m.title || 'Untitled')}</span>
  <button class="snxtv-btn snxtv-btn--primary snxtv-btn--xs snxtv-prog-set-source"
    data-prog-id="${_esc(progId)}" data-source-type="media" data-source-ref="${_esc(m.id)}">Select</button>
</div>`).join('');
  } else {
    if (!_tvPlaylists.length) { grid.innerHTML = '<div class="snxtv-empty">No playlists available.</div>'; return; }
    grid.innerHTML = _tvPlaylists.map(pl => `
<div class="snxtv-media-card snxtv-media-card--compact">
  <span class="snxtv-media-type-icon">📋</span>
  <span class="snxtv-media-title-sm">${_esc(pl.name || 'Untitled')}</span>
  <button class="snxtv-btn snxtv-btn--primary snxtv-btn--xs snxtv-prog-set-source"
    data-prog-id="${_esc(progId)}" data-source-type="playlist" data-source-ref="${_esc(pl.id)}">Select</button>
</div>`).join('');
  }

  grid.querySelectorAll('.snxtv-prog-set-source').forEach(btn => {
    btn.addEventListener('click', async () => {
      await _updateProgramField(btn.dataset.progId, {
        sourceType: btn.dataset.sourceType,
        sourceRef:  btn.dataset.sourceRef,
      });
      _toast('✓ Source updated.');
      _editingProgId = btn.dataset.progId;
      _renderProgrammingPanel();
    });
  });
}

async function _createProgram() {
  const name = prompt('Program name:');
  if (!name || !name.trim()) { _toast('Program name cannot be blank.'); return; }
  const { addDoc, collection, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;

  // Default to first media item if available
  const firstMedia = _tvMedia[0] || null;
  try {
    const docRef = await addDoc(collection(db, COLL_TV_PROGRAMS), {
      name:        name.trim(),
      description: '',
      sourceType:  firstMedia ? 'media' : '',
      sourceRef:   firstMedia ? firstMedia.id : '',
      ownerId:     (_cu() || {}).uid || '',
      createdAt:   serverTimestamp(),
      updatedAt:   serverTimestamp(),
    });
    _toast('✓ Program created.');
    _editingProgId = docRef.id;
    _renderProgrammingPanel();
  } catch (e) {
    _toast('Could not create program: ' + e.message);
  }
}

async function _deleteProgram(progId) {
  // Stage 4: warn about schedule entries that reference this program
  const referencingSlots = _tvSchedule.filter(s => s.programId === progId);
  let warnMsg = 'Delete this program?';
  if (referencingSlots.length) {
    warnMsg += '\n\n⚠ This program has ' + referencingSlots.length + ' schedule entr' +
      (referencingSlots.length === 1 ? 'y' : 'ies') + ' that will become orphaned.';
  }
  if (!confirm(warnMsg)) return;
  const { doc, deleteDoc } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await deleteDoc(doc(db, COLL_TV_PROGRAMS, progId));
    if (_editingProgId === progId) _editingProgId = null;
    _toast('Program deleted.');
  } catch (e) {
    _toast('Delete failed: ' + e.message);
  }
}

async function _renameProgram(progId) {
  const prog = _tvPrograms.find(p => p.id === progId);
  const newName = prompt('New program name:', prog ? prog.name : '');
  if (!newName || !newName.trim()) { _toast('Name cannot be blank.'); return; }
  await _updateProgramField(progId, { name: newName.trim() });
  _toast('✓ Renamed.');
}

async function _updateProgramField(progId, fields) {
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await updateDoc(doc(db, COLL_TV_PROGRAMS, progId), { ...fields, updatedAt: serverTimestamp() });
  } catch (e) {
    _toast('Update failed: ' + e.message);
    console.error('[SNX-TV-STUDIO] updateProgramField:', e);
  }
}

/**
 * Calculate duration of a program using the studio's local caches.
 * Mirrors SNXTVTimeline._calcProgramDuration but uses _tvMedia/_tvPlaylists.
 */
function _calcStudioProgramDuration(program) {
  if (!program || !program.sourceType) return { duration: 0, hasUnknown: true };

  if (program.sourceType === 'media') {
    const m = _tvMedia.find(x => x.id === program.sourceRef);
    if (!m) return { duration: 0, hasUnknown: true };
    const d = m.duration || 0;
    return { duration: d, hasUnknown: d <= 0 };
  }

  if (program.sourceType === 'playlist') {
    const pl = _tvPlaylists.find(x => x.id === program.sourceRef);
    if (!pl) return { duration: 0, hasUnknown: true };
    let total = 0;
    let hasUnknown = false;
    for (const item of (pl.items || [])) {
      const m = _tvMedia.find(x => x.id === item.mediaId);
      if (!m || !m.mediaUrl) continue;
      const d = m.duration || 0;
      if (d <= 0) { hasUnknown = true; continue; }
      total += d;
    }
    return { duration: total, hasUnknown };
  }

  return { duration: 0, hasUnknown: true };
}

/* ════════════════════════════════════════════════════════════
   SCHEDULE PANEL — Stage 3
   tv_schedule: each entry references a tv_program + startTime.
════════════════════════════════════════════════════════════ */

function _renderSchedulePanel() {
  const el = _container && _container.querySelector('#snxtvSchedulePanel');
  if (!el) return;

  if (_editingSlotId) {
    _renderSlotEditor(el, _editingSlotId);
    return;
  }

  // Detect conflicts using SNXTVTimeline if available
  let conflicts = [];
  if (global.SNXTVTimeline && typeof global.SNXTVTimeline.detectConflicts === 'function') {
    conflicts = global.SNXTVTimeline.detectConflicts();
  }
  const conflictEntryIds = new Set();
  conflicts.forEach(c => { conflictEntryIds.add(c.a.entry.id); conflictEntryIds.add(c.b.entry.id); });

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <span>TV Schedule</span>
    <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnAddSlot">+ Add Entry</button>
  </div>
  ${conflicts.length ? `<div class="snxtv-conflict-banner">⚠ ${conflicts.length} scheduling conflict${conflicts.length>1?'s':''} detected. Overlapping entries are highlighted.</div>` : ''}
  <div id="snxtvScheduleList">
    ${_renderScheduleList(conflictEntryIds)}
  </div>
</div>
`;

  el.querySelector('#snxtvBtnAddSlot').addEventListener('click', _addScheduleSlot);

  el.querySelectorAll('.snxtv-slot-edit').forEach(btn => {
    btn.addEventListener('click', () => { _editingSlotId = btn.dataset.id; _renderSchedulePanel(); });
  });
  el.querySelectorAll('.snxtv-slot-delete').forEach(btn => {
    btn.addEventListener('click', () => _deleteScheduleSlot(btn.dataset.id));
  });
  el.querySelectorAll('.snxtv-slot-toggle').forEach(btn => {
    btn.addEventListener('click', () => _toggleScheduleSlot(btn.dataset.id, btn.dataset.enabled === 'true'));
  });
}

function _tsMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.seconds) return v.seconds * 1000 + ((v.nanoseconds || 0) / 1e6);
  if (v.toMillis) return v.toMillis();
  return 0;
}

function _renderScheduleList(conflictEntryIds) {
  if (!_tvSchedule.length) {
    return '<div class="snxtv-empty">No schedule entries yet. Add one to begin programming.</div>';
  }

  const sorted = _tvSchedule.slice().sort((a, b) => _tsMs(a.startTime) - _tsMs(b.startTime));
  const now = Date.now();

  return sorted.map(slot => {
    const prog = _tvPrograms.find(p => p.id === slot.programId);
    const progName = prog ? (prog.name || 'Untitled') : '(Program missing)';
    const startMs = _tsMs(slot.startTime);
    const dur = prog ? _calcStudioProgramDuration(prog) : { duration: 0, hasUnknown: true };
    const endMs = startMs + (dur.duration > 0 ? dur.duration * 1000 : 0);
    const isConflict = conflictEntryIds.has(slot.id);
    const isEnabled = slot.enabled !== false;
    const isOnAir = startMs <= now && endMs > now && isEnabled;

    return `
<div class="snxtv-pl-row${isConflict ? ' snxtv-slot--conflict' : ''}${!isEnabled ? ' snxtv-slot--disabled' : ''}" data-id="${_esc(slot.id)}">
  <div class="snxtv-pl-info">
    <div class="snxtv-pl-name">
      ${isOnAir ? '<span class="snxtv-onair-pill">ON AIR</span> ' : ''}
      ${_esc(progName)}
      ${isConflict ? ' <span class="snxtv-conflict-pill">CONFLICT</span>' : ''}
    </div>
    <div class="snxtv-pl-meta">
      ${startMs ? _fmtDateTime(startMs) : '—'}
      ${endMs > startMs ? ' → ' + _fmtDateTime(endMs) : ''}
      · ${dur.hasUnknown ? '⚠ unknown dur' : _fmtDur(dur.duration)}
      ${!isEnabled ? ' · DISABLED' : ''}
    </div>
  </div>
  <div class="snxtv-pl-actions">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--xs snxtv-slot-toggle" data-id="${_esc(slot.id)}" data-enabled="${isEnabled}">${isEnabled ? 'Disable' : 'Enable'}</button>
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm snxtv-slot-edit" data-id="${_esc(slot.id)}">✏</button>
    <button class="snxtv-btn snxtv-btn--danger snxtv-btn--sm snxtv-slot-delete" data-id="${_esc(slot.id)}">🗑</button>
  </div>
</div>`;
  }).join('');
}

function _renderSlotEditor(el, slotId) {
  const slot = _tvSchedule.find(s => s.id === slotId);
  if (!slot) { _editingSlotId = null; _renderSchedulePanel(); return; }

  const startMs = _tsMs(slot.startTime);
  const prog = _tvPrograms.find(p => p.id === slot.programId);
  const dur = prog ? _calcStudioProgramDuration(prog) : { duration: 0, hasUnknown: true };
  const endMs = startMs + (dur.duration > 0 ? dur.duration * 1000 : 0);

  // Format for datetime-local input
  const startLocal = startMs ? new Date(startMs - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnBackToSched">← Back</button>
    <span style="flex:1;margin:0 8px;font-weight:600;">Edit Schedule Entry</span>
  </div>
  <div class="snxtv-pl-editor" style="display:flex;flex-direction:column;gap:12px;">
    <div>
      <label class="snxtv-form-label">Program</label>
      <select id="snxtvSlotProgSelect" class="snxtv-select">
        ${_tvPrograms.map(p => `<option value="${_esc(p.id)}" ${p.id === slot.programId ? 'selected' : ''}>${_esc(p.name || 'Untitled')}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="snxtv-form-label">Start Date &amp; Time (local)</label>
      <input type="datetime-local" id="snxtvSlotStartInput" value="${_esc(startLocal)}" class="snxtv-datetime-input">
    </div>
    <div id="snxtvSlotCalcEnd" class="snxtv-slot-calc-end">
      ${endMs > startMs ? 'Ends: ' + _fmtDateTime(endMs) + ' (' + _fmtDur(dur.duration) + ')' : dur.hasUnknown ? '⚠ End time unknown — program has missing durations.' : '—'}
    </div>
    <div>
      <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnSaveSlot">Save</button>
    </div>
  </div>
</div>
`;

  const progSel = el.querySelector('#snxtvSlotProgSelect');
  const startInput = el.querySelector('#snxtvSlotStartInput');
  const calcEnd = el.querySelector('#snxtvSlotCalcEnd');

  function _updateCalcEnd() {
    const selProg = _tvPrograms.find(p => p.id === progSel.value);
    const selDur = selProg ? _calcStudioProgramDuration(selProg) : { duration: 0, hasUnknown: true };
    const inMs = startInput.value ? new Date(startInput.value).getTime() : 0;
    const enMs = inMs && selDur.duration > 0 ? inMs + selDur.duration * 1000 : 0;
    calcEnd.textContent = enMs > inMs
      ? 'Ends: ' + _fmtDateTime(enMs) + ' (' + _fmtDur(selDur.duration) + ')'
      : selDur.hasUnknown ? '⚠ End time unknown — program has missing durations.' : '—';
  }

  progSel.addEventListener('change', _updateCalcEnd);
  startInput.addEventListener('input', _updateCalcEnd);

  el.querySelector('#snxtvBtnBackToSched').addEventListener('click', () => { _editingSlotId = null; _renderSchedulePanel(); });
  // Stage 4: prevent double-submit by disabling button while saving
  let _slotSaving = false;
  el.querySelector('#snxtvBtnSaveSlot').addEventListener('click', async () => {
    if (_slotSaving) return;
    const selProgId = progSel.value;
    const rawDate = startInput.value;
    if (!selProgId || !rawDate) { _toast('Choose a program and start time.'); return; }
    const startDate = new Date(rawDate);
    if (isNaN(startDate.getTime())) { _toast('Invalid date/time.'); return; }
    const saveBtn = el.querySelector('#snxtvBtnSaveSlot');
    _slotSaving = true;
    if (saveBtn) saveBtn.disabled = true;
    await _saveScheduleSlot(slotId, selProgId, startDate);
    _slotSaving = false;
    if (saveBtn) saveBtn.disabled = false;
  });
}

async function _addScheduleSlot() {
  if (!_tvPrograms.length) {
    _toast('Create a program first in the Programming tab.');
    return;
  }
  const { addDoc, collection, serverTimestamp, Timestamp } = _fs();
  const db = _db();
  if (!db) return;
  const firstProg = _tvPrograms[0];
  const startDate = new Date(Date.now() + 60 * 60 * 1000); // default: 1 hour from now

  try {
    const docRef = await addDoc(collection(db, COLL_TV_SCHEDULE), {
      programId: firstProg.id,
      startTime: startDate.getTime(),
      enabled:   true,
      ownerId:   (_cu() || {}).uid || '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    _toast('✓ Schedule entry added.');
    _editingSlotId = docRef.id;
    _renderSchedulePanel();
  } catch (e) {
    _toast('Could not add entry: ' + e.message);
  }
}

async function _saveScheduleSlot(slotId, programId, startDate) {
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await updateDoc(doc(db, COLL_TV_SCHEDULE, slotId), {
      programId,
      startTime: startDate.getTime(),
      updatedAt: serverTimestamp(),
    });
    _toast('✓ Saved.');
    _editingSlotId = null;
    _renderSchedulePanel();
  } catch (e) {
    _toast('Save failed: ' + e.message);
  }
}

async function _deleteScheduleSlot(slotId) {
  if (!confirm('Remove this schedule entry?')) return;
  const { doc, deleteDoc } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await deleteDoc(doc(db, COLL_TV_SCHEDULE, slotId));
    if (_editingSlotId === slotId) _editingSlotId = null;
    _toast('Entry removed.');
  } catch (e) {
    _toast('Delete failed: ' + e.message);
  }
}

async function _toggleScheduleSlot(slotId, currentEnabled) {
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await updateDoc(doc(db, COLL_TV_SCHEDULE, slotId), {
      enabled:   !currentEnabled,
      updatedAt: serverTimestamp(),
    });
  } catch (e) {
    _toast('Toggle failed: ' + e.message);
  }
}

/** Format ms timestamp as "Jan 5, 2026 7:00 PM" (local time) */
function _fmtDateTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/* ════════════════════════════════════════════════════════════
   DASHBOARD PANEL
   Shows a quick summary of TV state without duplicating editors.
════════════════════════════════════════════════════════════ */

function _renderDashboardPanel() {
  const el = _container && _container.querySelector('#snxtvDashboardPanel');
  if (!el) return;

  const nowMs = Date.now();
  const pendingCount   = _tvSubmissions.filter(s => s.status === 'pending').length;
  const approvedCount  = _tvSubmissions.filter(s => s.status === 'approved').length;

  // Find current on-air program from schedule
  let onAirLabel = '—';
  let onAirSub   = '';
  if (global.SNXTVTimeline) {
    const resolved = global.SNXTVTimeline.resolve(nowMs);
    if (resolved && resolved.mode === 'playing' && resolved.program) {
      onAirLabel = resolved.program.name || 'Untitled';
      if (resolved.currentItem) onAirSub = resolved.currentItem.title || '';
    } else if (resolved && resolved.nextProgram) {
      onAirLabel = 'Gap';
      onAirSub = 'Next: ' + (resolved.nextProgram.name || 'Untitled');
    }
  }

  const tvState = global.SNXTV ? global.SNXTV.getState() : {};
  const statusBadge = tvState.onAir
    ? '<span style="color:#00d4ff;font-weight:700;">● ON AIR</span>'
    : '<span style="color:rgba(255,255,255,0.4);">○ Off Air</span>';

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header"><span>TV Dashboard</span></div>
  <div style="padding:10px 12px;display:flex;flex-direction:column;gap:10px;">

    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <div style="flex:1;min-width:120px;background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.18);border-radius:8px;padding:12px;">
        <div style="font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:1px;margin-bottom:4px;">STATUS</div>
        <div style="font-size:13px;">${statusBadge}</div>
      </div>
      <div style="flex:1;min-width:120px;background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.18);border-radius:8px;padding:12px;">
        <div style="font-size:10px;color:rgba(255,255,255,0.4);letter-spacing:1px;margin-bottom:4px;">NOW PLAYING</div>
        <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(onAirLabel)}</div>
        ${onAirSub ? `<div style="font-size:10px;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(onAirSub)}</div>` : ''}
      </div>
    </div>

    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <div style="flex:1;min-width:80px;background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.18);border-radius:8px;padding:10px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#00d4ff;">${_tvMedia.length}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.4);">MEDIA</div>
      </div>
      <div style="flex:1;min-width:80px;background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.18);border-radius:8px;padding:10px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#00d4ff;">${_tvPlaylists.length}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.4);">PLAYLISTS</div>
      </div>
      <div style="flex:1;min-width:80px;background:rgba(0,212,255,0.07);border:1px solid rgba(0,212,255,0.18);border-radius:8px;padding:10px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#00d4ff;">${_tvPrograms.length}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.4);">PROGRAMS</div>
      </div>
      <div style="flex:1;min-width:80px;background:${pendingCount > 0 ? 'rgba(255,200,0,0.1)' : 'rgba(0,212,255,0.07)'};border:1px solid ${pendingCount > 0 ? 'rgba(255,200,0,0.4)' : 'rgba(0,212,255,0.18)'};border-radius:8px;padding:10px;text-align:center;cursor:pointer;" id="snxtvDashSubBadge">
        <div style="font-size:22px;font-weight:700;color:${pendingCount > 0 ? '#ffc800' : '#00d4ff'};">${pendingCount}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.4);">PENDING</div>
      </div>
    </div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
      <button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm" id="snxtvDashGoSubmissions">View Submissions</button>
      <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvDashGoMedia">Media Library</button>
      <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvDashGoSchedule">Schedule</button>
    </div>

  </div>
</div>
`;

  el.querySelector('#snxtvDashGoSubmissions') && el.querySelector('#snxtvDashGoSubmissions').addEventListener('click', () => _switchTab('submissions'));
  el.querySelector('#snxtvDashSubBadge')      && el.querySelector('#snxtvDashSubBadge').addEventListener('click', () => _switchTab('submissions'));
  el.querySelector('#snxtvDashGoMedia')       && el.querySelector('#snxtvDashGoMedia').addEventListener('click', () => _switchTab('media'));
  el.querySelector('#snxtvDashGoSchedule')    && el.querySelector('#snxtvDashGoSchedule').addEventListener('click', () => _switchTab('schedule'));
}

/* ════════════════════════════════════════════════════════════
   SUBMISSIONS PANEL
   Submission inbox for TV management (founder only).
   Workflow:  PENDING → APPROVED (→ tv_media) | REJECTED
════════════════════════════════════════════════════════════ */

function _renderSubmissionsPanel() {
  const el = _container && _container.querySelector('#snxtvSubmissionsPanel');
  if (!el) return;

  const pending  = _tvSubmissions.filter(s => s.status === 'pending');
  const approved = _tvSubmissions.filter(s => s.status === 'approved');
  const rejected = _tvSubmissions.filter(s => s.status === 'rejected');

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <span>Submission Inbox</span>
    <span style="font-size:11px;color:rgba(255,255,255,0.4);">${pending.length} pending · ${approved.length} approved · ${rejected.length} rejected</span>
  </div>

  <div class="snxtv-section-tabs" id="snxtvSubTabs">
    <button class="snxtv-stab snxtv-stab--active" data-stype="pending">Pending (${pending.length})</button>
    <button class="snxtv-stab" data-stype="approved">Approved (${approved.length})</button>
    <button class="snxtv-stab" data-stype="rejected">Rejected (${rejected.length})</button>
  </div>
  <div id="snxtvSubList" style="padding:0 12px 12px;">
    ${_renderSubmissionList(pending)}
  </div>
</div>
`;

  let _activeStype = 'pending';
  const lists = { pending, approved, rejected };

  el.querySelectorAll('.snxtv-stab[data-stype]').forEach(btn => {
    btn.addEventListener('click', () => {
      _activeStype = btn.dataset.stype;
      el.querySelectorAll('.snxtv-stab[data-stype]').forEach(b => b.classList.toggle('snxtv-stab--active', b.dataset.stype === _activeStype));
      el.querySelector('#snxtvSubList').innerHTML = _renderSubmissionList(lists[_activeStype] || []);
      _bindSubListEvents(el, _activeStype);
    });
  });
  _bindSubListEvents(el, 'pending');
}

function _renderSubmissionList(subs) {
  if (!subs.length) {
    return '<div class="snxtv-empty">No submissions in this category.</div>';
  }
  return subs.map(sub => {
    const isPending = sub.status === 'pending';
    const isApproved = sub.status === 'approved';
    const date = sub.submittedAt
      ? new Date(typeof sub.submittedAt === 'object' && sub.submittedAt.seconds ? sub.submittedAt.seconds * 1000 : sub.submittedAt).toLocaleDateString()
      : '—';
    const typeIcon = sub.mediaType === 'video' ? '🎬' : '🎵';
    return `
<div class="snxtv-pl-row" data-sub-id="${_esc(sub.id)}" style="margin-top:8px;">
  <div class="snxtv-pl-info" style="min-width:0;">
    <div class="snxtv-pl-name" style="display:flex;align-items:center;gap:6px;">
      <span>${typeIcon}</span>
      <span>${_esc(sub.title || 'Untitled')}</span>
      <span style="font-size:9px;padding:2px 7px;border-radius:20px;font-weight:700;letter-spacing:0.5px;background:${
        isPending ? 'rgba(255,200,0,0.18)' : isApproved ? 'rgba(0,200,80,0.18)' : 'rgba(255,60,60,0.18)'
      };color:${
        isPending ? '#ffc800' : isApproved ? '#00d45a' : '#ff5050'
      };">${sub.status ? sub.status.toUpperCase() : 'PENDING'}</span>
    </div>
    <div class="snxtv-pl-meta">
      ${_esc(sub.category || '')}${sub.category && sub.submitterName ? ' · ' : ''}${_esc(sub.submitterName || sub.submitterUid || '')} · ${date}
    </div>
    ${sub.description ? `<div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:3px;">${_esc(sub.description)}</div>` : ''}
  </div>
  <div class="snxtv-pl-actions">
    ${sub.mediaUrl ? `<button class="snxtv-btn snxtv-btn--ghost snxtv-btn--xs snxtv-sub-preview" data-url="${_esc(sub.mediaUrl)}" data-type="${_esc(sub.mediaType||'video')}" title="Preview">▶</button>` : ''}
    ${isPending ? `
      <button class="snxtv-btn snxtv-btn--primary snxtv-btn--xs snxtv-sub-approve" data-id="${_esc(sub.id)}" title="Approve">✓ Approve</button>
      <button class="snxtv-btn snxtv-btn--danger  snxtv-btn--xs snxtv-sub-reject"  data-id="${_esc(sub.id)}" title="Reject">✕ Reject</button>
    ` : ''}
  </div>
</div>`;
  }).join('');
}

function _bindSubListEvents(el, stype) {
  // Preview
  el.querySelectorAll('.snxtv-sub-preview').forEach(btn => {
    btn.addEventListener('click', () => {
      const url  = btn.dataset.url;
      const type = btn.dataset.type;
      if (!url) return;
      _previewSubmission(url, type);
    });
  });
  // Approve
  el.querySelectorAll('.snxtv-sub-approve').forEach(btn => {
    btn.addEventListener('click', () => _approveSubmission(btn.dataset.id));
  });
  // Reject
  el.querySelectorAll('.snxtv-sub-reject').forEach(btn => {
    btn.addEventListener('click', () => _rejectSubmission(btn.dataset.id));
  });
}

function _previewSubmission(url, type) {
  const existing = document.getElementById('snxtvSubPreviewModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'snxtvSubPreviewModal';
  modal.className = 'snxtv-modal-overlay';
  modal.innerHTML = `
<div class="snxtv-modal" style="max-width:480px;width:90vw;">
  <div class="snxtv-modal-header">
    Preview
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvPreviewClose">✕</button>
  </div>
  <div class="snxtv-modal-body" style="padding:8px;">
    ${type === 'video'
      ? `<video src="${_esc(url)}" controls playsinline style="width:100%;max-height:280px;background:#000;" preload="metadata"></video>`
      : `<audio src="${_esc(url)}" controls style="width:100%;margin:8px 0;" preload="metadata"></audio>`
    }
  </div>
</div>`;
  document.body.appendChild(modal);
  modal.querySelector('#snxtvPreviewClose').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function _approveSubmission(subId) {
  const sub = _tvSubmissions.find(s => s.id === subId);
  if (!sub) { _toast('Submission not found.'); return; }
  if (!confirm('Approve this submission?\nIt will be added to the TV Media Library.')) return;

  const { doc, updateDoc, addDoc, collection, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;

  try {
    // 1. Add to tv_media
    await addDoc(collection(db, COLL_TV_MEDIA), {
      title:       sub.title     || 'Untitled',
      mediaType:   sub.mediaType || 'video',
      mediaUrl:    sub.mediaUrl  || '',
      artworkUrl:  sub.artworkUrl || '',
      duration:    sub.duration  || 0,
      sourceId:    sub.id,
      sourceCollection: COLL_TV_SUBMISSIONS,
      sourceType:  'submission',
      addedBy:     (_cu() || {}).uid || '',
      submittedBy: sub.submitterUid || '',
      createdAt:   serverTimestamp(),
    });

    // 2. Mark submission as approved
    await updateDoc(doc(db, COLL_TV_SUBMISSIONS, subId), {
      status:     'approved',
      reviewedAt: serverTimestamp(),
      reviewedBy: (_cu() || {}).uid || '',
    });

    _toast('✓ Approved — added to TV Media Library.');
  } catch (e) {
    _toast('Approval failed: ' + e.message);
    console.error('[SNX-TV-STUDIO] approveSubmission:', e);
  }
}

async function _rejectSubmission(subId) {
  if (!confirm('Reject this submission?')) return;
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await updateDoc(doc(db, COLL_TV_SUBMISSIONS, subId), {
      status:     'rejected',
      reviewedAt: serverTimestamp(),
      reviewedBy: (_cu() || {}).uid || '',
    });
    _toast('Submission rejected.');
  } catch (e) {
    _toast('Reject failed: ' + e.message);
  }
}

/* ════════════════════════════════════════════════════════════
   CHANNEL SETTINGS PANEL
════════════════════════════════════════════════════════════ */

function _renderSettingsPanel() {
  const el = _container && _container.querySelector('#snxtvSettingsPanel');
  if (!el) return;

  // Load current settings from Firestore (one-time read is fine here)
  const { doc, getDoc, setDoc, serverTimestamp } = _fs();
  const db = _db();

  el.innerHTML = '<div class="snxtv-loading">Loading settings…</div>';

  if (!db) { el.innerHTML = '<div class="snxtv-empty">Firestore not ready.</div>'; return; }

  getDoc(doc(db, COLL_TV_SETTINGS, 'channel')).then(snap => {
    const cfg = snap.exists() ? snap.data() : {};
    _tvSettings = cfg;

    el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header"><span>Channel Settings</span></div>
  <div style="padding:10px 12px;display:flex;flex-direction:column;gap:14px;">

    <div>
      <label class="snxtv-form-label">Channel Name</label>
      <input type="text" id="snxtvCfgName" value="${_esc(cfg.channelName || '24-Hour TV')}" maxlength="80"
        style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.3);border:1px solid rgba(0,212,255,0.2);color:#fff;padding:7px 10px;border-radius:6px;font-size:12px;">
    </div>

    <div>
      <label class="snxtv-form-label">Channel Tagline / Sub-title</label>
      <input type="text" id="snxtvCfgTagline" value="${_esc(cfg.tagline || 'Shadow Nexus Social')}" maxlength="120"
        style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.3);border:1px solid rgba(0,212,255,0.2);color:#fff;padding:7px 10px;border-radius:6px;font-size:12px;">
    </div>

    <div>
      <label class="snxtv-form-label">Fallback Behavior (when schedule is empty)</label>
      <select id="snxtvCfgFallback" class="snxtv-select">
        <option value="standby"   ${(cfg.fallbackMode || 'standby') === 'standby'   ? 'selected' : ''}>Standby Slate — show "Programming Resumes Soon"</option>
        <option value="playlist"  ${cfg.fallbackMode === 'playlist'  ? 'selected' : ''}>Loop Fallback Playlist</option>
      </select>
    </div>

    <div id="snxtvCfgFallbackPl" style="display:${(cfg.fallbackMode || 'standby') === 'playlist' ? 'block' : 'none'};">
      <label class="snxtv-form-label">Fallback Playlist</label>
      <select id="snxtvCfgFallbackPlSelect" class="snxtv-select">
        <option value="">— none —</option>
        ${_tvPlaylists.map(pl => `<option value="${_esc(pl.id)}" ${cfg.fallbackPlaylistId === pl.id ? 'selected' : ''}>${_esc(pl.name || 'Untitled')}</option>`).join('')}
      </select>
    </div>

    <div>
      <label class="snxtv-form-label">Allow Content Submissions (from viewers)</label>
      <select id="snxtvCfgSubmissionsEnabled" class="snxtv-select">
        <option value="1" ${cfg.submissionsEnabled !== false ? 'selected' : ''}>Enabled</option>
        <option value="0" ${cfg.submissionsEnabled === false ? 'selected' : ''}>Disabled</option>
      </select>
    </div>

    <div>
      <button class="snxtv-btn snxtv-btn--primary" id="snxtvCfgSave">Save Settings</button>
    </div>
    <div id="snxtvCfgStatus" style="font-size:12px;color:rgba(255,255,255,0.5);"></div>

  </div>
</div>
`;

    // Show/hide fallback playlist selector
    const fallbackSel = el.querySelector('#snxtvCfgFallback');
    const fallbackPlRow = el.querySelector('#snxtvCfgFallbackPl');
    fallbackSel.addEventListener('change', () => {
      fallbackPlRow.style.display = fallbackSel.value === 'playlist' ? 'block' : 'none';
    });

    el.querySelector('#snxtvCfgSave').addEventListener('click', async () => {
      const statusEl = el.querySelector('#snxtvCfgStatus');
      const saveBtn  = el.querySelector('#snxtvCfgSave');
      saveBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Saving…';
      try {
        await setDoc(doc(db, COLL_TV_SETTINGS, 'channel'), {
          channelName:         el.querySelector('#snxtvCfgName').value.trim() || '24-Hour TV',
          tagline:             el.querySelector('#snxtvCfgTagline').value.trim(),
          fallbackMode:        el.querySelector('#snxtvCfgFallback').value,
          fallbackPlaylistId:  el.querySelector('#snxtvCfgFallbackPlSelect') ? el.querySelector('#snxtvCfgFallbackPlSelect').value : '',
          submissionsEnabled:  el.querySelector('#snxtvCfgSubmissionsEnabled').value === '1',
          updatedAt:           serverTimestamp(),
          updatedBy:           (_cu() || {}).uid || '',
        }, { merge: true });
        if (statusEl) statusEl.textContent = '✓ Saved.';
        _toast('✓ Channel settings saved.');
      } catch (e) {
        if (statusEl) statusEl.textContent = '✗ ' + e.message;
        _toast('Save failed: ' + e.message);
      }
      saveBtn.disabled = false;
    });

  }).catch(e => {
    el.innerHTML = `<div class="snxtv-empty">Could not load settings: ${_esc(e.message)}</div>`;
  });
}

/* ════════════════════════════════════════════════════════════
   CONTENT SUBMISSION — callable by any signed-in user
   Does NOT automatically put content ON AIR.
   Sets status = 'pending' — requires founder review.
════════════════════════════════════════════════════════════ */

/**
 * Submit content for TV review.
 * @param {Object} data  { title, description, category, mediaType, mediaUrl, artworkUrl, duration }
 * @returns {Promise<{id: string}>}
 */
async function submitContent(data) {
  if (!data || !data.mediaUrl) throw new Error('No media URL provided.');
  if (!data.title || !data.title.trim()) throw new Error('Title is required.');

  const { addDoc, collection, serverTimestamp } = _fs();
  const db  = _db();
  const cu  = _cu();
  if (!db)  throw new Error('Firestore not ready.');
  if (!cu)  throw new Error('Not signed in.');

  const docRef = await addDoc(collection(db, COLL_TV_SUBMISSIONS), {
    title:         data.title.trim(),
    description:   (data.description || '').trim(),
    category:      data.category   || 'general',
    mediaType:     data.mediaType  || 'video',
    mediaUrl:      data.mediaUrl,
    artworkUrl:    data.artworkUrl || '',
    duration:      data.duration   || 0,
    status:        'pending',                     // NEVER auto-approved
    submitterUid:  cu.uid,
    submitterName: (global._snxUserData && global._snxUserData.displayName) || cu.displayName || '',
    submittedAt:   serverTimestamp(),
  });

  console.log('[SNX-TV-STUDIO] Content submitted:', docRef.id);
  return { id: docRef.id };
}

/* ════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */

const SNXTVStudio = {
  mount,
  unmount,
  getAdapterQueue,
  setPlaylistQueue,
  isFounder: _isFounder,
  // Public submission API (any signed-in user)
  submitContent,
  // Stage 5: expose for debugging
  _getPrograms: () => _tvPrograms.slice(),
  _getSchedule: () => _tvSchedule.slice(),
  _getSubmissions: () => _tvSubmissions.slice(),

  /** Show the studio overlay (called from TV page) */
  show() {
    const overlay = document.getElementById('snxtvStudioOverlay');
    if (overlay) overlay.classList.add('snxtv-studio-overlay--open');
  },

  /** Hide the studio overlay */
  hide() {
    const overlay = document.getElementById('snxtvStudioOverlay');
    if (overlay) overlay.classList.remove('snxtv-studio-overlay--open');
  },

  version:   STUDIO_VERSION,
  buildId:   'SNS-2026-TV-STAGE5-001'
};

global.SNXTVStudio = SNXTVStudio;

})(window);
