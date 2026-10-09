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

const STUDIO_VERSION        = 'SNS-2026-TV-STAGE6-001';
const R2_WORKER_URL         = 'https://yellow-term-11e6.nthntjrn.workers.dev';
const COLL_TV_MEDIA         = 'tv_media';
const COLL_TV_PLAYLISTS     = 'tv_playlists';
const COLL_TV_PROGRAMS      = 'tv_programs';
const COLL_TV_SCHEDULE      = 'tv_schedule';
const COLL_TV_SUBMISSIONS   = 'tv_submissions';
const COLL_TV_SETTINGS      = 'tv_settings';
const COLL_TV_CHANNELS      = 'tv_channels';
const COLL_PROFILE_MUSIC    = 'profileMusic';
const COLL_VIDEOS           = 'videos';

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */

let _mounted       = false;
let _container     = null;
let _activeTab     = 'channels';

// In-memory caches
let _tvMedia         = [];   // tv_media docs (shared library)
let _tvPlaylists     = [];   // tv_playlists docs
let _snsMusicLib     = [];   // profileMusic docs (SNS source)
let _snsVideoLib     = [];   // videos docs (SNS source)
let _tvSubmissions   = [];   // tv_submissions docs
let _tvSettings      = {};   // tv_settings doc for active channel
let _tvChannels      = [];   // tv_channels docs

// Stage 3: programs + schedule (mirrors SNXTVTimeline caches for studio use)
let _tvPrograms    = [];   // tv_programs docs
let _tvSchedule    = [];   // tv_schedule docs

// Multi-channel: active channel context
// null = default channel (backward compat)
let _activeChannelId = null;

// Live Firestore listeners
let _unsubMedia       = null;
let _unsubPlaylists   = null;
let _unsubPrograms    = null;
let _unsubSchedule    = null;
let _unsubSubmissions = null;
let _unsubChannels    = null;

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

/** Format seconds as H:MM:SS (for playlist/total duration display) */
function _fmtDurHMS(secs) {
  if (!secs || !isFinite(secs) || secs <= 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const mm = m < 10 ? '0' + m : '' + m;
  const ss = s < 10 ? '0' + s : '' + s;
  if (h > 0) return h + ':' + mm + ':' + ss;
  return m + ':' + ss;
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
    _switchTab('channels');
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
  _tvChannels = [];
  _snsMusicLib = [];
  _snsVideoLib = [];
  _tvSettings = {};
  _mounted = false;
  _editingPlId  = null;
  _editingProgId = null;
  _editingSlotId = null;
}

/**
 * Switch the Studio's active channel context.
 * Called by snx-tv.js _switchChannel() so Studio operates on the right channel.
 * @param {string|null} channelId
 */
function setChannel(channelId) {
  const newId = channelId || null;
  if (_activeChannelId === newId) return;
  _activeChannelId = newId;
  // Reload live listeners for the new channel
  _teardownListeners();
  if (_mounted) {
    setTimeout(_startLiveListeners, 50);
    // Re-render the channel selector in the header if visible
    _renderChannelSelectorInHeader();
  }
}

/**
 * Get the currently active channel object, or a default channel stub.
 */
function _activeChannel() {
  if (!_activeChannelId) {
    return { id: 'default', name: 'Shadow Nexus TV', description: '24-Hour TV' };
  }
  return _tvChannels.find(c => c.id === _activeChannelId) ||
    { id: _activeChannelId, name: 'Unknown Channel', description: '' };
}

/**
 * Filter a docs array to only those belonging to the active channel.
 * Backward compat: docs without channelId belong to 'default'.
 */
function _channelDocs(arr) {
  const id = _activeChannelId || 'default';
  return arr.filter(d => (d.channelId || 'default') === id);
}

/**
 * Render the channel selector row in the Studio header (idempotent update).
 */
function _renderChannelSelectorInHeader() {
  if (!_container) return;
  const sel = _container.querySelector('#snxtvChannelSel');
  if (!sel) return;
  // Rebuild options
  sel.innerHTML = _buildChannelOptions();
  sel.value = _activeChannelId || 'default';
}

function _buildChannelOptions() {
  const all = _getAllChannels();
  return all.map(c =>
    `<option value="${_esc(c.id)}">${_esc(c.name || c.id)}</option>`
  ).join('');
}

/**
 * Return the merged channel list: preset channels + Firestore channels,
 * deduplicated. Preset channels are always present even before Firestore seeding.
 * The 'default' entry is the legacy alias for snx-ch-shadow-nexus-tv.
 */
function _getAllChannels() {
  // Start with preset channel definitions from the viewer channel system
  const presets = (global.SNXTVChannels && global.SNXTVChannels.PRESET_CHANNELS)
    ? global.SNXTVChannels.PRESET_CHANNELS.slice()
    : [];
  // Merge with Firestore channels (_tvChannels): Firestore data wins for fields
  const seen = new Set();
  const result = [];
  // Add 'default' alias first for backward compatibility
  result.push({ id: 'default', name: 'Shadow Nexus TV', description: '24-Hour TV (Default)' });
  seen.add('default');
  // Presets
  for (const p of presets) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    // If Firestore has an updated version of this preset, use that
    const fsVersion = _tvChannels.find(c => c.id === p.id);
    result.push(fsVersion || p);
  }
  // Any extra Firestore channels not in the preset list (user-created via Studio)
  for (const c of _tvChannels) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    result.push(c);
  }
  return result;
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
    <button class="snxtv-tab snxtv-tab--active" data-tab="channels">CHANNELS</button>
    <button class="snxtv-tab" data-tab="media">MEDIA</button>
    <button class="snxtv-tab" data-tab="submissions">SUBMISSIONS</button>
    <button class="snxtv-tab" data-tab="settings">SETTINGS</button>
  </nav>

  <!-- ── PANELS ────────────────────────────────────────────── -->
  <div class="snxtv-panel" id="snxtvPanelChannels">
    <div id="snxtvChannelsPanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelMedia">
    <div id="snxtvMediaPanel"></div>
  </div>
  <div class="snxtv-panel snxtv-panel--hidden" id="snxtvPanelSubmissions">
    <div id="snxtvSubmissionsPanel"></div>
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
  // Only the four visible tabs are routed. Any legacy tab name (playlists,
  // programming, schedule, dashboard) redirects to channels so openOnTab()
  // calls from external code don't break.
  const validTabs = ['channels', 'media', 'submissions', 'settings'];
  if (!validTabs.includes(tab)) tab = 'channels';

  _activeTab = tab;

  const allTabs = _container.querySelectorAll('.snxtv-tab');
  allTabs.forEach(b => b.classList.toggle('snxtv-tab--active', b.dataset.tab === tab));

  const allPanels = _container.querySelectorAll('.snxtv-panel');
  allPanels.forEach(p => p.classList.add('snxtv-panel--hidden'));

  const cap = tab.charAt(0).toUpperCase() + tab.slice(1);
  const activePanel = _container.querySelector(`#snxtvPanel${cap}`);
  if (activePanel) activePanel.classList.remove('snxtv-panel--hidden');

  if (tab === 'channels')    _renderChannelsPanel();
  if (tab === 'media')       _renderMediaPanel();
  if (tab === 'submissions') _renderSubmissionsPanel();
  if (tab === 'settings')    _renderSettingsPanel();
}

/* ════════════════════════════════════════════════════════════
   FIRESTORE LIVE LISTENERS
════════════════════════════════════════════════════════════ */

function _startLiveListeners() {
  const { collection, doc, onSnapshot, query, orderBy } = _fs();
  const db = _db();
  if (!db || !collection || !onSnapshot) {
    console.warn('[SNX-TV-STUDIO] Firestore not ready — retrying in 1s');
    setTimeout(_startLiveListeners, 1000);
    return;
  }

  // ── tv_media live listener (shared library — not filtered by channel) ──
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

  // ── tv_playlists live listener (all channels; _channelDocs filters for active channel) ──
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

  // ── tv_programs live listener (all channels; _channelDocs filters for active channel) ──
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

  // ── tv_schedule live listener (all channels; _channelDocs filters for active channel) ──
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

  // ── tv_channels live listener ──
  try {
    _unsubChannels = onSnapshot(collection(db, COLL_TV_CHANNELS), snap => {
      _tvChannels = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Update the channel selector options whenever channels change
      _renderChannelSelectorInHeader();
      if (_activeTab === 'channels') _renderChannelsPanel();
    }, err => {
      console.warn('[SNX-TV-STUDIO] tv_channels listener error:', err.message);
    });
  } catch (e) {
    console.warn('[SNX-TV-STUDIO] tv_channels listener setup failed:', e.message);
  }
}

function _teardownListeners() {
  if (_unsubMedia)       { try { _unsubMedia(); }       catch(_){} _unsubMedia       = null; }
  if (_unsubPlaylists)   { try { _unsubPlaylists(); }   catch(_){} _unsubPlaylists   = null; }
  if (_unsubPrograms)    { try { _unsubPrograms(); }    catch(_){} _unsubPrograms    = null; }
  if (_unsubSchedule)    { try { _unsubSchedule(); }    catch(_){} _unsubSchedule    = null; }
  if (_unsubSubmissions) { try { _unsubSubmissions(); } catch(_){} _unsubSubmissions = null; }
  if (_unsubChannels)    { try { _unsubChannels(); }    catch(_){} _unsubChannels    = null; }
}

/* ════════════════════════════════════════════════════════════
   MEDIA PANEL
   Shows tv_media library + SNS source library for adding.
════════════════════════════════════════════════════════════ */

function _renderMediaPanel() {
  const el = _container && _container.querySelector('#snxtvMediaPanel');
  if (!el) return;

  // Channel context for this panel
  const ch    = _activeChannel();
  const chLabel = _esc(ch.name || ch.id);

  // Count items for the active channel
  const channelFilter = _activeChannelId || 'default';
  const channelItems  = _tvMedia.filter(m => (m.channelId || 'default') === channelFilter);
  const missingCount  = channelItems.filter(m => !(m.duration > 0)).length;
  const repairBadge   = missingCount > 0 ? ` (${missingCount} missing)` : ' ✓';

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <span>Channel Media — ${chLabel}</span>
    <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnAddFromSNS">+ Add Music / Video</button>
    <button class="snxtv-btn snxtv-btn--ghost" id="snxtvBtnUploadNew">↑ Upload New</button>
    <button class="snxtv-btn snxtv-btn--ghost" id="snxtvBtnRepairDurations" title="Load each item with missing duration and save the real duration">⏱ Repair Durations${_esc(repairBadge)}</button>
  </div>
  <div style="padding:4px 14px 6px;font-size:11px;color:rgba(0,212,255,0.4);">
    Media added here is stored directly in this channel. Switch channels using the selector above.
  </div>
  <div id="snxtvRepairStatus" style="display:none;font-size:11px;color:rgba(0,212,255,0.8);padding:4px 0;"></div>
  <div id="snxtvMediaGrid" class="snxtv-media-grid"></div>
</div>
<div class="snxtv-section snxtv-section--hidden" id="snxtvSnsLibSection">
  <div class="snxtv-section-header">
    <span>SNS Media — Select to Add to ${chLabel}</span>
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
    <span>Upload Media to ${chLabel}</span>
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

  // Repair durations button
  el.querySelector('#snxtvBtnRepairDurations').addEventListener('click', () => _repairMissingDurations());

  // SNS lib sub-tabs
  el.querySelectorAll('.snxtv-stab').forEach(btn => {
    btn.addEventListener('click', () => _openSnsLib(btn.dataset.lib));
  });

  // Upload form events
  _bindUploadFormEvents(el);
}

function _renderTvMediaGrid() {
  // Show only media belonging to the active channel
  const channelFilter = _activeChannelId || 'default';
  const items = _tvMedia.filter(m => (m.channelId || 'default') === channelFilter);

  if (!items.length) {
    const ch = _activeChannel();
    return `<div class="snxtv-empty">No media in ${_esc(ch.name || 'this channel')} yet. Use "+ Add Music / Video" or "↑ Upload New" above.</div>`;
  }
  return items.map(item => `
<div class="snxtv-media-card" data-id="${_esc(item.id)}">
  <div class="snxtv-media-thumb">${item.artworkUrl ? `<img src="${_esc(item.artworkUrl)}" alt="">` : (item.mediaType === 'video' ? '🎬' : '🎵')}</div>
  <div class="snxtv-media-info">
    <div class="snxtv-media-title">${_esc(item.title || 'Untitled')}</div>
    <div class="snxtv-media-meta">${item.mediaType === 'video' ? '📹' : '🎵'} ${item.mediaType || '?'} · ${_fmtDur(item.duration)}</div>
  </div>
  <div class="snxtv-media-actions">
    <button class="snxtv-btn snxtv-btn--danger snxtv-btn--sm snxtv-btn-remove" data-id="${_esc(item.id)}" title="Remove from channel">✕</button>
  </div>
</div>`).join('');
}

function _bindMediaCardEvents() {
  const grid = _container && _container.querySelector('#snxtvMediaGrid');
  if (!grid) return;
  grid.querySelectorAll('.snxtv-btn-remove').forEach(btn => {
    btn.addEventListener('click', () => _removeTvMedia(btn.dataset.id));
  });
}

/* ════════════════════════════════════════════════════════════
   DURATION BACKFILL / REPAIR
   For existing tv_media items that have duration=0 (or missing),
   load them in a hidden HTMLMediaElement, read the real duration,
   and save it back to Firestore.  Does NOT re-upload, delete, or
   change the mediaUrl in any way.
════════════════════════════════════════════════════════════ */

/**
 * Load a media URL into a hidden A/V element and return the real duration (s).
 * @param {string} url
 * @param {string} mediaType  'audio' | 'video'
 * @returns {Promise<number>}
 */
function _detectUrlDuration(url, mediaType) {
  return new Promise(function (resolve) {
    if (!url) { resolve(0); return; }
    const tag  = (mediaType === 'video') ? 'video' : 'audio';
    const el   = document.createElement(tag);
    el.preload = 'metadata';
    el.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(el);
    const cleanup = function () {
      try { document.body.removeChild(el); } catch (_) {}
      el.src = '';
    };
    el.onloadedmetadata = function () {
      const dur = isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : 0;
      cleanup();
      resolve(dur);
    };
    el.onerror = function () { cleanup(); resolve(0); };
    // Safety timeout — CDN latency; give each item up to 15 s
    setTimeout(function () { cleanup(); resolve(0); }, 15000);
    el.src = url;
  });
}

/**
 * Scan all tv_media items with duration ≤ 0.
 * For each, load the mediaUrl, detect real duration, write to Firestore.
 * Shows live progress in the Media panel repair status bar.
 */
async function _repairMissingDurations() {
  const channelFilter = _activeChannelId || 'default';
  const missing = _tvMedia.filter(m => !(m.duration > 0) && m.mediaUrl && (m.channelId || 'default') === channelFilter);
  if (!missing.length) {
    _toast('✓ All media items for this channel already have duration metadata.');
    return;
  }

  const { doc, updateDoc } = _fs();
  const db = _db();
  if (!db) { _toast('Firestore not ready.'); return; }

  const statusEl = _container && _container.querySelector('#snxtvRepairStatus');
  if (statusEl) statusEl.style.display = 'block';

  const report = [];
  for (let i = 0; i < missing.length; i++) {
    const item = missing[i];
    if (statusEl) {
      statusEl.textContent = `⏱ Detecting duration for "${item.title || 'Untitled'}" (${i + 1}/${missing.length})…`;
    }
    const dur = await _detectUrlDuration(item.mediaUrl, item.mediaType || 'audio');
    if (dur > 0) {
      try {
        await updateDoc(doc(db, COLL_TV_MEDIA, item.id), { duration: dur });
        report.push(`✓ "${item.title || 'Untitled'}" → ${_fmtDur(dur)}`);
      } catch (e) {
        report.push(`✗ "${item.title || 'Untitled'}" — save failed: ${e.message}`);
      }
    } else {
      report.push(`⚠ "${item.title || 'Untitled'}" — duration unavailable (media may not support metadata loading)`);
    }
  }

  if (statusEl) {
    statusEl.textContent = `✓ Duration repair complete. ${report.length} items processed.`;
    setTimeout(() => { if (statusEl) statusEl.style.display = 'none'; }, 8000);
  }
  _toast(`✓ Duration repair done — ${missing.length} items checked.`);
  console.log('[SNX-TV-STUDIO] Duration repair report:\n' + report.join('\n'));
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
      sourceDoc = { collection: COLL_PROFILE_MUSIC, id: sourceId, artist: s.artist || '' };
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
      artist:    sourceDoc.artist || '',
      mediaType,
      mediaUrl,
      artworkUrl,
      duration,
      channelId: _activeChannelId || 'default',  // direct-to-channel assignment
      sourceId,                    // Firestore doc ID of the original SNS item
      sourceCollection: sourceDoc.collection, // 'profileMusic' | 'videos'
      sourceType,                  // 'music' | 'video'
      addedBy:   (_cu() || {}).uid || '',
      createdAt: serverTimestamp()
    });
    const ch = _activeChannel();
    _toast('✓ Added to ' + (ch.name || 'channel'));
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
    <label for="snxtvUploadFile">Video or Audio File (.mp4, .webm, .mov, .m4v, .mp3, .aac, .flac, .wav, .ogg, .m4a)</label>
    <input type="file" id="snxtvUploadFile" accept=".mp4,.webm,.mov,.m4v,.avi,.mkv,.mp3,.aac,.flac,.wav,.ogg,.m4a,video/*,audio/*">
  </div>
  <div class="snxtv-form-row">
    <label for="snxtvUploadTitle">Title</label>
    <input type="text" id="snxtvUploadTitle" placeholder="Title" maxlength="200">
  </div>
  <div class="snxtv-form-row" id="snxtvUploadArtistRow" style="display:none;">
    <label for="snxtvUploadArtist">Artist (optional)</label>
    <input type="text" id="snxtvUploadArtist" placeholder="Artist name" maxlength="200">
  </div>
  <div class="snxtv-form-row">
    <label for="snxtvUploadDesc">Description (optional)</label>
    <input type="text" id="snxtvUploadDesc" placeholder="Description" maxlength="400">
  </div>
  <div class="snxtv-form-row" id="snxtvUploadThumbRow" style="display:none;">
    <label for="snxtvUploadThumb">Artwork / Cover Image (optional, .jpg/.png/.webp)</label>
    <input type="file" id="snxtvUploadThumb" accept=".jpg,.jpeg,.png,.webp,image/*">
  </div>
  <div class="snxtv-upload-type-badge" id="snxtvUploadTypeBadge" style="display:none;margin-bottom:8px;font-size:11px;padding:4px 10px;border-radius:20px;display:inline-block;"></div>
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

  // Show/hide artwork/artist fields and type badge when file is chosen
  const fileInput = panelEl.querySelector('#snxtvUploadFile');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      const thumbRow  = panelEl.querySelector('#snxtvUploadThumbRow');
      const artistRow = panelEl.querySelector('#snxtvUploadArtistRow');
      const typeBadge = panelEl.querySelector('#snxtvUploadTypeBadge');
      if (!f) {
        if (thumbRow)  thumbRow.style.display  = 'none';
        if (artistRow) artistRow.style.display = 'none';
        if (typeBadge) typeBadge.style.display = 'none';
        return;
      }
      const isVideo = f.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(f.name);
      // Artwork field shown for both audio and video; artist only for audio
      if (thumbRow)  thumbRow.style.display  = '';
      if (artistRow) artistRow.style.display = isVideo ? 'none' : '';
      if (typeBadge) {
        typeBadge.textContent = isVideo ? '🎬 Video file detected' : '🎵 Audio file detected';
        typeBadge.style.cssText = isVideo
          ? 'display:inline-block;margin-bottom:8px;font-size:11px;padding:4px 10px;border-radius:20px;background:rgba(0,180,120,0.15);border:1px solid rgba(0,180,120,0.35);color:#00c878;'
          : 'display:inline-block;margin-bottom:8px;font-size:11px;padding:4px 10px;border-radius:20px;background:rgba(0,120,255,0.12);border:1px solid rgba(0,120,255,0.3);color:#6baaff;';
      }
    });
  }
}

/**
 * Detect the real duration (seconds) of a local audio/video File using
 * HTMLMediaElement.loadedmetadata.  Returns 0 if detection fails or the
 * file is not A/V media.
 *
 * @param {File} file
 * @returns {Promise<number>}  duration in seconds (0 = unknown)
 */
function _detectFileDuration(file) {
  return new Promise(function (resolve) {
    const isAV = file.type.startsWith('audio/') || file.type.startsWith('video/');
    if (!isAV) { resolve(0); return; }
    const url = URL.createObjectURL(file);
    const el  = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio');
    el.preload = 'metadata';
    const cleanup = function () { URL.revokeObjectURL(url); el.src = ''; };
    el.onloadedmetadata = function () {
      const dur = isFinite(el.duration) && el.duration > 0 ? Math.round(el.duration) : 0;
      cleanup();
      resolve(dur);
    };
    el.onerror = function () { cleanup(); resolve(0); };
    // Safety timeout — if metadata never fires, give up after 10 s
    setTimeout(function () { cleanup(); resolve(0); }, 10000);
    el.src = url;
  });
}

async function _doUpload() {
  const fileInput    = _container && _container.querySelector('#snxtvUploadFile');
  const titleInput   = _container && _container.querySelector('#snxtvUploadTitle');
  const artistInput  = _container && _container.querySelector('#snxtvUploadArtist');
  const descInput    = _container && _container.querySelector('#snxtvUploadDesc');
  const thumbInput   = _container && _container.querySelector('#snxtvUploadThumb');
  const statusEl     = _container && _container.querySelector('#snxtvUploadStatus');
  const progressWrap = _container && _container.querySelector('#snxtvUploadProgressWrap');
  const progressBar  = _container && _container.querySelector('#snxtvUploadProgressBar');
  const progressLabel= _container && _container.querySelector('#snxtvUploadProgressLabel');

  if (!fileInput || !fileInput.files.length) { _toast('Choose a file first.'); return; }
  const file      = fileInput.files[0];
  const title     = (titleInput && titleInput.value.trim()) || file.name.replace(/\.[^.]+$/, '');
  const artistVal = (artistInput && artistInput.value.trim()) || '';
  const desc      = (descInput  && descInput.value.trim())  || '';
  const thumbFile = (thumbInput && thumbInput.files && thumbInput.files[0]) || null;

  // Detect media type from MIME or extension
  const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(file.name);
  const mediaType = isVideo ? 'video' : 'audio';

  const cu = _cu();
  if (!cu) { _toast('Not signed in.'); return; }

  let idToken;
  try { idToken = await _getIdToken(); }
  catch (e) { _toast('Auth failed: ' + e.message); return; }

  // R2 key in tv/{uid}/ namespace (allowed by upload-worker for both audio and video)
  const ext   = (file.name.split('.').pop() || (isVideo ? 'mp4' : 'mp3')).toLowerCase().replace(/[^a-z0-9]/g, '');
  const r2Key = `tv/${cu.uid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

  // ── Detect real media duration before upload ──────────────────────────────
  if (statusEl) statusEl.textContent = 'Reading media metadata…';
  const detectedDuration = await _detectFileDuration(file);

  if (statusEl) statusEl.textContent = 'Uploading…';
  if (progressWrap) progressWrap.style.display = 'flex';

  const formData = new FormData();
  formData.append('file', file, file.name);
  formData.append('path', r2Key);

  return new Promise((resolveOuter) => {
    const xhr = new XMLHttpRequest();
    xhr.timeout = 30 * 60 * 1000; // 30 min for large video files

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

        const { addDoc, collection, serverTimestamp } = _fs();
        const db = _db();
        let firestoreId = null;
        let artworkUrl  = '';

        // ── Upload thumbnail if provided (image upload via same endpoint) ──
        if (thumbFile && db) {
          try {
            const thumbExt  = (thumbFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
            const thumbKey  = `tv/${cu.uid}/thumb-${Date.now()}-${Math.random().toString(16).slice(2)}.${thumbExt}`;
            const thumbForm = new FormData();
            thumbForm.append('file', thumbFile, thumbFile.name);
            thumbForm.append('path', thumbKey);
            const thumbXhr = new XMLHttpRequest();
            await new Promise((res) => {
              thumbXhr.onload = () => {
                try {
                  const tr = JSON.parse(thumbXhr.responseText);
                  if (thumbXhr.status >= 200 && thumbXhr.status < 300 && tr.url) artworkUrl = tr.url;
                } catch {}
                res();
              };
              thumbXhr.onerror = () => res();
              thumbXhr.open('POST', R2_WORKER_URL + '/upload-music');
              thumbXhr.setRequestHeader('Authorization', 'Bearer ' + idToken);
              thumbXhr.send(thumbForm);
            });
          } catch (te) {
            console.warn('[SNX-TV-STUDIO] thumb upload failed:', te);
          }
        }

        // ── Store Firestore source record ──
        // Videos go into COLL_VIDEOS; audio goes into profileMusic.
        if (db) {
          try {
            if (isVideo) {
              const docRef = await addDoc(collection(db, COLL_VIDEOS), {
                ownerUid:     cu.uid,
                userId:       cu.uid,
                title,
                description:  desc,
                videoUrl:     resp.url,
                r2Url:        resp.url,
                thumbnailUrl: artworkUrl,
                r2Key,
                duration:     detectedDuration,
                status:       'published',
                visibility:   'public',
                isPublic:     true,
                uploadedAt:   serverTimestamp(),
                source:       'tv-studio',
              });
              firestoreId = docRef.id;
            } else {
              const docRef = await addDoc(collection(db, COLL_PROFILE_MUSIC), {
                ownerUid:    cu.uid,
                ownerId:     cu.uid,
                userId:      cu.uid,
                title,
                description: desc,
                artist:      artistVal || (global._snxUserData && global._snxUserData.displayName) || '',
                musicUrl:    resp.url,
                downloadURL: resp.url,
                artUrl:      artworkUrl,
                r2Key,
                duration:    detectedDuration,
                visibility:  'public',
                isPublic:    true,
                uploadedAt:  serverTimestamp(),
                source:      'tv-studio',
              });
              firestoreId = docRef.id;
            }
          } catch (fe) {
            console.warn('[SNX-TV-STUDIO] source doc write failed:', fe.message);
          }
        }

        // ── Add to tv_media (direct-to-channel) ──
        if (db) {
          try {
            await addDoc(collection(db, COLL_TV_MEDIA), {
              title,
              description:      desc,
              artist:           isVideo ? '' : (artistVal || (global._snxUserData && global._snxUserData.displayName) || ''),
              mediaType,
              mediaUrl:         resp.url,
              artworkUrl,
              duration:         detectedDuration,
              channelId:        _activeChannelId || 'default',  // direct-to-channel
              sourceId:         firestoreId || r2Key,
              sourceCollection: isVideo ? COLL_VIDEOS : COLL_PROFILE_MUSIC,
              sourceType:       isVideo ? 'video' : 'music',
              r2Key,
              addedBy:          cu.uid,
              createdAt:        serverTimestamp()
            });
          } catch (te) {
            console.warn('[SNX-TV-STUDIO] tv_media write failed:', te.message);
          }
        }

        const chUpload = _activeChannel();
        if (statusEl) statusEl.textContent = `✓ ${isVideo ? 'Video' : 'Audio'} added to ${chUpload.name || 'channel'}!`;
        if (fileInput)   fileInput.value   = '';
        if (titleInput)  titleInput.value  = '';
        if (artistInput) artistInput.value = '';
        if (descInput)   descInput.value   = '';
        if (thumbInput)  thumbInput.value  = '';
        _toast(`✓ ${isVideo ? 'Video' : 'Audio'} upload complete and added to TV.`);
        _closeUploadSection();
        resolveOuter();
      } else {
        if (statusEl) statusEl.textContent = '✗ Upload failed: ' + (resp.error || `HTTP ${xhr.status}`);
        _toast('Upload failed: ' + (resp.error || `HTTP ${xhr.status}`));
        resolveOuter();
      }
    };

    xhr.onerror   = () => { if (statusEl) statusEl.textContent = '✗ Network error.'; _toast('Upload error.'); resolveOuter(); };
    xhr.ontimeout = () => { if (statusEl) statusEl.textContent = '✗ Upload timed out.'; _toast('Upload timed out.'); resolveOuter(); };

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
  const channelPlaylists = _channelDocs(_tvPlaylists);
  if (!channelPlaylists.length) {
    return '<div class="snxtv-empty">No playlists yet for this channel. Create one to get started.</div>';
  }
  return channelPlaylists.map(pl => {
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
      channelId: _activeChannelId || 'default',
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

  // ── Calculate playlist total duration ────────────────────────────────────
  let plTotal = 0;
  let plMissingDur = 0;
  for (const item of items) {
    const m = _tvMedia.find(x => x.id === item.mediaId);
    if (!m || !m.mediaUrl) continue;
    if (m.duration > 0) { plTotal += m.duration; }
    else { plMissingDur++; }
  }
  const plDurLabel = items.length === 0
    ? '—'
    : (plMissingDur > 0
        ? (_fmtDurHMS(plTotal) + ` <span class="snxtv-dur-warn" style="font-size:11px;">⚠ ${plMissingDur} item${plMissingDur > 1 ? 's' : ''} missing duration — use ⏱ Repair Durations in Media tab</span>`)
        : _fmtDurHMS(plTotal));

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnBackToPl">← Back</button>
    <span id="snxtvPlEditorName" style="flex:1;margin:0 8px;font-weight:600;">${_esc(pl.name || 'Untitled')}</span>
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnRenamePl">✏ Rename</button>
    <button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm" id="snxtvBtnLoadThisPl">▶ Load to TV</button>
  </div>
  <div style="font-size:12px;color:rgba(255,255,255,0.6);padding:4px 0 8px 0;">
    Playlist Duration: <strong style="color:#fff;">${plDurLabel}</strong>
    &nbsp;·&nbsp; ${items.length} item${items.length !== 1 ? 's' : ''}
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
    // Per-item duration display
    const durStr = media
      ? (media.duration > 0 ? _fmtDur(media.duration) : '<span style="color:rgba(255,120,80,0.9);" title="Duration unavailable — use ⏱ Repair Durations in Media tab">?:??</span>')
      : '';
    return `
<div class="snxtv-pl-item${unavailable ? ' snxtv-pl-item--unavailable' : ''}">
  <span class="snxtv-pl-item-num">${idx + 1}</span>
  <span class="snxtv-pl-item-type">${typeIcon}</span>
  <span class="snxtv-pl-item-title">${_esc(title)}</span>
  ${unavailable ? '<span class="snxtv-badge-unavail">Unavailable</span>' : `<span style="font-size:11px;color:rgba(255,255,255,0.5);margin-left:auto;margin-right:6px;">${durStr}</span>`}
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
      artist:    media.artist || '',
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
  // otherwise fall back to tv_media filtered by active channel.
  if (_currentPlaylistQueue && _currentPlaylistQueue.length) {
    return _currentPlaylistQueue.slice();
  }

  // Filter media by active channel so each channel plays its own content.
  // tv_media docs without a channelId field belong to the 'default' channel
  // for backward compatibility.
  const channelFilter = _activeChannelId || 'default';
  const filtered = _tvMedia.filter(m => {
    if (!m.mediaUrl) return false;
    const docChannel = m.channelId || 'default';
    return docChannel === channelFilter;
  });

  // If the current channel has no media of its own, fall back to the shared
  // default library so the viewer is never left with a completely empty player.
  const source = filtered.length > 0 ? filtered : _tvMedia.filter(m => m.mediaUrl);

  return source.map(m => ({
    id:        m.id,
    title:     m.title || 'Untitled',
    artist:    m.artist || '',
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
  const channelPrograms = _channelDocs(_tvPrograms);
  if (!channelPrograms.length) {
    return '<div class="snxtv-empty">No programs yet for this channel. Create one to get started.</div>';
  }
  return channelPrograms.map(prog => {
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

  // ── For playlist sources, show playlist total duration as a dedicated row ──
  let plDurRow = '';
  if (prog.sourceType === 'playlist') {
    const pl = _tvPlaylists.find(p => p.id === prog.sourceRef);
    if (pl) {
      let plTotal = 0, plMissing = 0, plCount = 0;
      for (const item of (pl.items || [])) {
        const m = _tvMedia.find(x => x.id === item.mediaId);
        if (!m || !m.mediaUrl) continue;
        plCount++;
        if (m.duration > 0) plTotal += m.duration; else plMissing++;
      }
      const plDurDisplay = plMissing > 0
        ? `${_fmtDurHMS(plTotal)} <span class="snxtv-dur-warn" style="font-size:11px;">⚠ ${plMissing} item${plMissing > 1 ? 's' : ''} missing duration — click ⏱ Repair Durations in Media tab to fix</span>`
        : (plCount === 0 ? '—' : _fmtDurHMS(plTotal));
      plDurRow = `<div class="snxtv-prog-detail-row"><span class="snxtv-prog-detail-label">Playlist Duration:</span>
        <span>${plDurDisplay}</span>
      </div>
      <div class="snxtv-prog-detail-row" style="font-size:11px;color:rgba(255,255,255,0.45);">
        <span>Playback: ${plCount} item${plCount !== 1 ? 's' : ''} will loop sequentially for the full scheduled program block duration.</span>
      </div>`;
    }
  }

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header">
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnBackToProgs">← Back</button>
    <span style="flex:1;margin:0 8px;font-weight:600;">${_esc(prog.name || 'Untitled')}</span>
    <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm" id="snxtvBtnRenameProgram">✏ Rename</button>
  </div>
  <div class="snxtv-pl-editor">
    <div class="snxtv-prog-detail-row"><span class="snxtv-prog-detail-label">Source:</span> <span>${_esc(sourceLabel)}</span></div>
    ${plDurRow}
    <div class="snxtv-prog-detail-row"><span class="snxtv-prog-detail-label">Content Duration:</span>
      <span>${dur.hasUnknown && dur.duration === 0 ? '<span class="snxtv-dur-warn">⚠ Unknown duration — some items missing duration metadata. Use ⏱ Repair Durations in Media tab to fix.</span>' : _fmtDurHMS(dur.duration)}</span>
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
      channelId:   _activeChannelId || 'default',
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

/**
 * Resolve the effective duration for a schedule slot.
 * Uses slot.scheduledDuration (program block duration) when explicitly set;
 * falls back to the sum of media durations.
 */
function _slotEffectiveDuration(slot, prog) {
  if (typeof slot.scheduledDuration === 'number' && slot.scheduledDuration > 0) {
    return { duration: slot.scheduledDuration, hasUnknown: false, isScheduled: true };
  }
  if (!prog) return { duration: 0, hasUnknown: true, isScheduled: false };
  const d = _calcStudioProgramDuration(prog);
  return { ...d, isScheduled: false };
}

function _renderScheduleList(conflictEntryIds) {
  const channelSchedule = _channelDocs(_tvSchedule);
  if (!channelSchedule.length) {
    return '<div class="snxtv-empty">No schedule entries yet for this channel. Add one to begin programming.</div>';
  }

  const sorted = channelSchedule.slice().sort((a, b) => _tsMs(a.startTime) - _tsMs(b.startTime));
  const now = Date.now();

  return sorted.map(slot => {
    const prog = _tvPrograms.find(p => p.id === slot.programId);
    const progName = prog ? (prog.name || 'Untitled') : '(Program missing)';
    const startMs = _tsMs(slot.startTime);
    const dur = _slotEffectiveDuration(slot, prog);
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
      ${startMs ? _fmtDateTime(startMs) : '—'}${endMs > startMs ? ' – ' + _fmtDateTime(endMs) : ''}
      · ${dur.hasUnknown ? '⚠ unknown dur' : _fmtDur(dur.duration)}${dur.isScheduled ? ' (scheduled)' : ''}
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

/* ── Duration selector options (value = seconds, 0 = use-media-duration) ── */
const _DURATION_PRESETS = [
  { label: 'Auto (use media duration)',  value: 0 },
  { label: '5 minutes',                  value: 300 },
  { label: '10 minutes',                 value: 600 },
  { label: '15 minutes',                 value: 900 },
  { label: '30 minutes',                 value: 1800 },
  { label: '45 minutes',                 value: 2700 },
  { label: '1 hour',                     value: 3600 },
  { label: '1 hour 30 minutes',          value: 5400 },
  { label: '2 hours',                    value: 7200 },
  { label: '3 hours',                    value: 10800 },
  { label: 'Custom…',                    value: -1 },
];

/** Convert seconds to a string like "1h 30m" */
function _fmtDurLong(secs) {
  if (!secs || !isFinite(secs) || secs <= 0) return '—';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0 && m > 0) return h + 'h ' + m + 'm';
  if (h > 0) return h + 'h';
  return m + 'm';
}

function _renderSlotEditor(el, slotId) {
  const slot = _tvSchedule.find(s => s.id === slotId);
  if (!slot) { _editingSlotId = null; _renderSchedulePanel(); return; }

  const startMs  = _tsMs(slot.startTime);
  const prog     = _tvPrograms.find(p => p.id === slot.programId);
  const dur      = _slotEffectiveDuration(slot, prog);
  const endMs    = startMs + (dur.duration > 0 ? dur.duration * 1000 : 0);

  // The stored scheduledDuration, if any (0 = auto)
  const storedSchedDur = (typeof slot.scheduledDuration === 'number' && slot.scheduledDuration > 0)
    ? slot.scheduledDuration : 0;

  // Determine whether it matches a preset (for the select default value)
  const isCustom     = storedSchedDur > 0 && !_DURATION_PRESETS.some(p => p.value === storedSchedDur);
  const selectedPresetValue = isCustom ? -1 : storedSchedDur;

  // Custom hours/minutes if stored
  const customH = storedSchedDur > 0 ? Math.floor(storedSchedDur / 3600) : 0;
  const customM = storedSchedDur > 0 ? Math.floor((storedSchedDur % 3600) / 60) : 0;

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
        ${_channelDocs(_tvPrograms).map(p => `<option value="${_esc(p.id)}" ${p.id === slot.programId ? 'selected' : ''}>${_esc(p.name || 'Untitled')}</option>`).join('')}
      </select>
    </div>
    <div>
      <label class="snxtv-form-label">Start Date &amp; Time (local)</label>
      <input type="datetime-local" id="snxtvSlotStartInput" value="${_esc(startLocal)}" class="snxtv-datetime-input">
    </div>
    <div>
      <label class="snxtv-form-label">Program Block Duration</label>
      <select id="snxtvSlotDurSelect" class="snxtv-select">
        ${_DURATION_PRESETS.map(p => `<option value="${p.value}" ${p.value === selectedPresetValue ? 'selected' : ''}>${_esc(p.label)}</option>`).join('')}
      </select>
      <div id="snxtvSlotCustomDurRow" style="display:${isCustom ? 'flex' : 'none'};gap:8px;align-items:center;margin-top:8px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.5);">Hours:</label>
        <input type="number" id="snxtvSlotCustomH" min="0" max="23" value="${customH}" style="width:60px;background:rgba(0,0,0,0.3);border:1px solid rgba(0,212,255,0.2);color:#fff;padding:6px 8px;border-radius:6px;font-size:12px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.5);">Minutes:</label>
        <input type="number" id="snxtvSlotCustomM" min="0" max="59" value="${customM}" style="width:60px;background:rgba(0,0,0,0.3);border:1px solid rgba(0,212,255,0.2);color:#fff;padding:6px 8px;border-radius:6px;font-size:12px;">
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:4px;">
        Sets how long this program block occupies the schedule, independent of media length.
        If longer than the media, the playlist will loop.
      </div>
    </div>
    <div id="snxtvSlotCalcEnd" class="snxtv-slot-calc-end">
      ${endMs > startMs ? 'Ends: ' + _fmtDateTime(endMs) + ' (' + _fmtDurLong(dur.duration) + ')' : dur.hasUnknown ? '⚠ End time unknown — set a program duration above.' : '—'}
    </div>
    <div>
      <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnSaveSlot">Save</button>
    </div>
  </div>
</div>
`;

  const progSel    = el.querySelector('#snxtvSlotProgSelect');
  const startInput = el.querySelector('#snxtvSlotStartInput');
  const durSelect  = el.querySelector('#snxtvSlotDurSelect');
  const customRow  = el.querySelector('#snxtvSlotCustomDurRow');
  const customH_el = el.querySelector('#snxtvSlotCustomH');
  const customM_el = el.querySelector('#snxtvSlotCustomM');
  const calcEnd    = el.querySelector('#snxtvSlotCalcEnd');

  /** Return the currently selected scheduledDuration in seconds (0 = auto) */
  function _getSelectedDur() {
    const v = parseInt(durSelect.value, 10);
    if (v === -1) {
      // Custom
      const h = parseInt(customH_el.value, 10) || 0;
      const m = parseInt(customM_el.value, 10) || 0;
      return h * 3600 + m * 60;
    }
    return v; // 0 = auto, or a preset value in seconds
  }

  function _updateCalcEnd() {
    const selProg  = _tvPrograms.find(p => p.id === progSel.value);
    const schedSec = _getSelectedDur();
    let effectiveDur, hasUnknown;
    if (schedSec > 0) {
      effectiveDur = schedSec; hasUnknown = false;
    } else {
      const d = selProg ? _calcStudioProgramDuration(selProg) : { duration: 0, hasUnknown: true };
      effectiveDur = d.duration; hasUnknown = d.hasUnknown;
    }
    const inMs = startInput.value ? new Date(startInput.value).getTime() : 0;
    const enMs = inMs && effectiveDur > 0 ? inMs + effectiveDur * 1000 : 0;
    calcEnd.textContent = enMs > inMs
      ? 'Ends: ' + _fmtDateTime(enMs) + ' (' + _fmtDurLong(effectiveDur) + ')'
      : hasUnknown ? '⚠ End time unknown — set a duration above.' : '—';
  }

  durSelect.addEventListener('change', () => {
    const v = parseInt(durSelect.value, 10);
    customRow.style.display = (v === -1) ? 'flex' : 'none';
    _updateCalcEnd();
  });
  customH_el.addEventListener('input', _updateCalcEnd);
  customM_el.addEventListener('input', _updateCalcEnd);
  progSel.addEventListener('change', _updateCalcEnd);
  startInput.addEventListener('input', _updateCalcEnd);

  el.querySelector('#snxtvBtnBackToSched').addEventListener('click', () => { _editingSlotId = null; _renderSchedulePanel(); });
  // Prevent double-submit by disabling button while saving
  let _slotSaving = false;
  el.querySelector('#snxtvBtnSaveSlot').addEventListener('click', async () => {
    if (_slotSaving) return;
    const selProgId = progSel.value;
    const rawDate   = startInput.value;
    if (!selProgId || !rawDate) { _toast('Choose a program and start time.'); return; }
    const startDate = new Date(rawDate);
    if (isNaN(startDate.getTime())) { _toast('Invalid date/time.'); return; }
    const scheduledDurationSec = _getSelectedDur();
    if (scheduledDurationSec < 0 || (parseInt(durSelect.value,10) === -1 && scheduledDurationSec === 0)) {
      _toast('Enter a valid custom duration (hours and/or minutes).');
      return;
    }
    // Overlap check before saving
    const startMs2 = startDate.getTime();
    const endMs2   = scheduledDurationSec > 0 ? startMs2 + scheduledDurationSec * 1000 : 0;
    if (endMs2 > startMs2) {
      const overlaps = _tvSchedule.filter(s => {
        if (s.id === slotId || s.enabled === false) return false;
        const sMs  = _tsMs(s.startTime);
        const sProg = _tvPrograms.find(p => p.id === s.programId);
        const sDur  = _slotEffectiveDuration(s, sProg);
        const eMs  = sMs + (sDur.duration > 0 ? sDur.duration * 1000 : 0);
        if (!sMs || eMs <= sMs) return false;
        return startMs2 < eMs && endMs2 > sMs;
      });
      if (overlaps.length) {
        const names = overlaps.map(s => {
          const p = _tvPrograms.find(x => x.id === s.programId);
          return (p && p.name) || 'Untitled';
        }).join(', ');
        if (!confirm(`⚠ This schedule entry overlaps with: ${names}\n\nSave anyway?`)) return;
      }
    }
    const saveBtn = el.querySelector('#snxtvBtnSaveSlot');
    _slotSaving = true;
    if (saveBtn) saveBtn.disabled = true;
    await _saveScheduleSlot(slotId, selProgId, startDate, scheduledDurationSec);
    _slotSaving = false;
    if (saveBtn) saveBtn.disabled = false;
  });
}

async function _addScheduleSlot() {
  const channelPrograms = _channelDocs(_tvPrograms);
  if (!channelPrograms.length) {
    _toast('Create a program for this channel first in the Programming tab.');
    return;
  }
  const { addDoc, collection, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  const firstProg = channelPrograms[0];
  const startDate = new Date(Date.now() + 60 * 60 * 1000); // default: 1 hour from now

  try {
    const docRef = await addDoc(collection(db, COLL_TV_SCHEDULE), {
      programId:         firstProg.id,
      startTime:         startDate.getTime(),
      scheduledDuration: 0,   // 0 = auto (derived from media durations)
      enabled:           true,
      channelId:         _activeChannelId || 'default',
      ownerId:           (_cu() || {}).uid || '',
      createdAt:         serverTimestamp(),
      updatedAt:         serverTimestamp(),
    });
    _toast('✓ Schedule entry added.');
    _editingSlotId = docRef.id;
    _renderSchedulePanel();
  } catch (e) {
    _toast('Could not add entry: ' + e.message);
  }
}

/**
 * @param {string} slotId
 * @param {string} programId
 * @param {Date}   startDate
 * @param {number} scheduledDurationSec  — 0 = auto (use media duration)
 */
async function _saveScheduleSlot(slotId, programId, startDate, scheduledDurationSec) {
  const { doc, updateDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  const dur = (typeof scheduledDurationSec === 'number' && scheduledDurationSec > 0)
    ? scheduledDurationSec : 0;
  try {
    await updateDoc(doc(db, COLL_TV_SCHEDULE, slotId), {
      programId,
      startTime:         startDate.getTime(),
      scheduledDuration: dur,
      updatedAt:         serverTimestamp(),
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

// _renderDashboardPanel kept for compatibility — redirects to channels tab.
function _renderDashboardPanel() {
  if (_mounted) _switchTab('channels');
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
  <div class="snxtv-section-header"><span>TV Settings</span></div>
  <div style="padding:10px 12px;display:flex;flex-direction:column;gap:14px;">

    <div>
      <label class="snxtv-form-label">Audio-Only Display Mode</label>
      <select id="snxtvCfgAudioVisual" class="snxtv-select">
        <option value="auto"      ${(!cfg.audioVisualMode || cfg.audioVisualMode === 'auto') ? 'selected' : ''}>AUTO — Artwork when available, Visualizer when not</option>
        <option value="artwork"   ${cfg.audioVisualMode === 'artwork'   ? 'selected' : ''}>Artwork Preferred — always show artwork (visualizer if none)</option>
        <option value="visualizer"${cfg.audioVisualMode === 'visualizer'? 'selected' : ''}>Visualizer — always show music visualizer</option>
      </select>
      <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:4px;line-height:1.5;">AUTO is recommended. Video content always overrides to the video player.</div>
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

    el.querySelector('#snxtvCfgSave').addEventListener('click', async () => {
      const statusEl = el.querySelector('#snxtvCfgStatus');
      const saveBtn  = el.querySelector('#snxtvCfgSave');
      saveBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Saving…';
      try {
        await setDoc(doc(db, COLL_TV_SETTINGS, 'channel'), {
          audioVisualMode:     el.querySelector('#snxtvCfgAudioVisual').value,
          submissionsEnabled:  el.querySelector('#snxtvCfgSubmissionsEnabled').value === '1',
          updatedAt:           serverTimestamp(),
          updatedBy:           (_cu() || {}).uid || '',
        }, { merge: true });
        if (statusEl) statusEl.textContent = '✓ Saved.';
        _toast('✓ Settings saved.');
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
   CHANNELS PANEL — Create / Edit / Delete TV Channels
════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════
   CHANNELS PANEL — primary Studio landing panel.
   Shows all channels with an inline "Open & Manage Media"
   button per channel, plus an inline Create Channel form.
════════════════════════════════════════════════════════════ */

function _renderChannelsPanel() {
  const el = _container && _container.querySelector('#snxtvChannelsPanel');
  if (!el) return;

  // Merged list: preset definitions + Firestore channels (no 'default' alias shown)
  const channels = _getAllChannels().filter(ch => ch.id !== 'default');

  // Count media per channel for display
  const mediaCountMap = {};
  _tvMedia.forEach(m => {
    const cid = m.channelId || 'default';
    mediaCountMap[cid] = (mediaCountMap[cid] || 0) + 1;
  });

  el.innerHTML = `
<div class="snxtv-section">
  <div class="snxtv-section-header" style="justify-content:space-between;">
    <span>TV Channels</span>
  </div>

  <!-- Channel list -->
  <div id="snxtvChannelList" style="padding:0 0 4px;">
    ${channels.map(ch => {
      const isActive  = ch.id === (_activeChannelId || 'snx-ch-shadow-nexus-tv');
      const mediaCount = mediaCountMap[ch.id] || 0;
      const emoji     = ch.logoEmoji || '📺';
      const isPresetChannel = !!ch.isPreset;
      return `<div class="snxtv-ch-row${isActive ? ' snxtv-ch-row--active' : ''}" data-ch-id="${_esc(ch.id)}">
        <div class="snxtv-ch-row-left">
          <span class="snxtv-ch-row-emoji">${emoji}</span>
          <div class="snxtv-ch-row-info">
            <div class="snxtv-ch-row-name">${_esc(ch.name || ch.id)}</div>
            <div class="snxtv-ch-row-meta">${mediaCount} item${mediaCount !== 1 ? 's' : ''}${ch.description ? ' · ' + _esc(ch.description) : ''}${isPresetChannel ? ' · Built-in' : ''}</div>
          </div>
        </div>
        <div class="snxtv-ch-row-actions">
          <button class="snxtv-btn snxtv-btn--primary snxtv-btn--sm snxtv-ch-open-media" data-id="${_esc(ch.id)}" title="Open this channel and manage its media">📺 Open &amp; Add Media</button>
          <button class="snxtv-btn snxtv-btn--ghost snxtv-btn--sm snxtv-ch-edit" data-id="${_esc(ch.id)}" title="Rename channel">✏</button>
          ${!isPresetChannel ? `<button class="snxtv-btn snxtv-btn--danger snxtv-btn--sm snxtv-ch-delete" data-id="${_esc(ch.id)}" title="Delete channel">🗑</button>` : ''}
        </div>
      </div>`;
    }).join('')}
    ${channels.length === 0 ? '<div class="snxtv-empty" style="padding:16px;">No channels yet. Create one below.</div>' : ''}
  </div>

</div>

<!-- ── Create Channel Form (inline, always visible) ── -->
<div class="snxtv-section" style="margin-top:14px;" id="snxtvCreateChSection">
  <div class="snxtv-section-header"><span>Create New Channel</span></div>
  <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px;">
    <div>
      <label class="snxtv-form-label">Channel Name *</label>
      <input type="text" id="snxtvNewChName" maxlength="80" placeholder="e.g. Legend Music"
        style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.35);border:1px solid rgba(0,212,255,0.22);border-radius:6px;color:#fff;padding:9px 12px;font-size:13px;">
    </div>
    <div>
      <label class="snxtv-form-label">Description (optional)</label>
      <input type="text" id="snxtvNewChDesc" maxlength="200" placeholder="What plays on this channel?"
        style="width:100%;box-sizing:border-box;background:rgba(0,0,0,0.35);border:1px solid rgba(0,212,255,0.22);border-radius:6px;color:#fff;padding:9px 12px;font-size:13px;">
    </div>
    <div id="snxtvNewChStatus" style="font-size:12px;color:rgba(255,255,255,0.5);min-height:16px;"></div>
    <div>
      <button class="snxtv-btn snxtv-btn--primary" id="snxtvBtnCreateCh" style="min-width:140px;">+ Create Channel</button>
    </div>
  </div>
</div>
`;

  // "Open & Add Media" — switch active channel in Studio + viewer, then go to Media tab
  el.querySelectorAll('.snxtv-ch-open-media').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      // Switch internal Studio channel context
      const newId = (id === 'snx-ch-shadow-nexus-tv') ? null : id;
      setChannel(newId);
      // Also switch the viewer + timeline
      if (global.SNXTVTimeline && typeof global.SNXTVTimeline.setChannel === 'function') {
        global.SNXTVTimeline.setChannel(newId);
      }
      if (global.SNXTV && typeof global.SNXTV.switchChannel === 'function') {
        global.SNXTV.switchChannel(id);  // viewer uses the full preset ID
      }
      _switchTab('media');
    });
  });

  el.querySelectorAll('.snxtv-ch-edit').forEach(btn => {
    btn.addEventListener('click', () => _openEditChannelModal(btn.dataset.id));
  });
  el.querySelectorAll('.snxtv-ch-delete').forEach(btn => {
    btn.addEventListener('click', () => _deleteChannel(btn.dataset.id));
  });

  // Create Channel submit
  const createBtn = el.querySelector('#snxtvBtnCreateCh');
  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      const nameInput = el.querySelector('#snxtvNewChName');
      const descInput = el.querySelector('#snxtvNewChDesc');
      const statusEl  = el.querySelector('#snxtvNewChStatus');
      const name = (nameInput && nameInput.value.trim()) || '';
      if (!name) {
        if (statusEl) { statusEl.style.color = '#ff7070'; statusEl.textContent = 'Channel name is required.'; }
        if (nameInput) nameInput.focus();
        return;
      }
      const desc = (descInput && descInput.value.trim()) || '';
      createBtn.disabled = true;
      if (statusEl) { statusEl.style.color = 'rgba(255,255,255,0.5)'; statusEl.textContent = 'Creating…'; }
      try {
        await _createChannelDirect(name, desc);
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        if (statusEl) { statusEl.style.color = '#00d45a'; statusEl.textContent = '✓ Channel created!'; }
        setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
      } catch (e) {
        if (statusEl) { statusEl.style.color = '#ff7070'; statusEl.textContent = '✗ ' + e.message; }
      }
      createBtn.disabled = false;
    });
  }
}

/**
 * Create a new channel in Firestore and update all live caches.
 * Shared between the inline form and any programmatic calls.
 */
async function _createChannelDirect(name, desc) {
  const { addDoc, collection, serverTimestamp } = _fs();
  const db = _db();
  if (!db) throw new Error('Firestore not ready.');
  if (!name || !name.trim()) throw new Error('Channel name is required.');

  const docRef = await addDoc(collection(db, COLL_TV_CHANNELS), {
    name:        name.trim(),
    description: desc ? desc.trim() : '',
    status:      'active',
    artworkUrl:  '',
    createdBy:   (_cu() || {}).uid || '',
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  });

  // Optimistic local cache update (Firestore snapshot will confirm shortly)
  const newChannel = {
    id:          docRef.id,
    name:        name.trim(),
    description: desc ? desc.trim() : '',
    status:      'active',
    artworkUrl:  '',
    isPreset:    false,
    createdBy:   (_cu() || {}).uid || '',
  };
  if (!_tvChannels.find(c => c.id === docRef.id)) {
    _tvChannels = _tvChannels.concat([newChannel]);
  }

  // Inject into Timeline cache for immediate viewer selector update
  if (global.SNXTVTimeline && typeof global.SNXTVTimeline.injectChannel === 'function') {
    global.SNXTVTimeline.injectChannel(newChannel);
  }

  _toast('✓ Channel created: ' + name.trim());

  // Refresh viewer channel selector
  if (global.SNXTV && typeof global.SNXTV._refreshChannelSelector === 'function') {
    global.SNXTV._refreshChannelSelector();
  }
  if (global.SNXTVChannels && typeof global.SNXTVChannels.refresh === 'function') {
    global.SNXTVChannels.refresh();
  }

  // Re-render channels panel so the new channel appears immediately
  if (_activeTab === 'channels') _renderChannelsPanel();
}

async function _openEditChannelModal(channelId) {
  if (!channelId || channelId === 'default') {
    _toast('This channel cannot be edited here.');
    return;
  }
  const allChannels = _getAllChannels();
  const ch = allChannels.find(c => c.id === channelId) || _tvChannels.find(c => c.id === channelId);
  if (!ch) { _toast('Channel not found.'); return; }

  const newName = prompt('Channel Name:', ch.name || '');
  if (newName === null) return; // cancelled
  const newDesc = prompt('Description:', ch.description || '');
  if (newDesc === null) return; // cancelled

  const { doc, setDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await setDoc(doc(db, COLL_TV_CHANNELS, channelId), {
      name:        newName.trim() || ch.name,
      description: newDesc.trim(),
      updatedAt:   serverTimestamp(),
    }, { merge: true });
    _toast('✓ Channel updated.');
    if (_activeTab === 'channels') _renderChannelsPanel();
    if (global.SNXTVChannels && typeof global.SNXTVChannels.refresh === 'function') {
      global.SNXTVChannels.refresh();
    }
  } catch (e) {
    _toast('Update failed: ' + e.message);
  }
}

async function _deleteChannel(channelId) {
  if (!channelId || channelId === 'default') {
    _toast('The default channel cannot be deleted.');
    return;
  }
  const ch = _tvChannels.find(c => c.id === channelId);
  if (!confirm(`Delete channel "${ch ? ch.name : channelId}"?\n\nThe channel definition will be removed.\nAll media items added to this channel remain in the TV Media library.`)) return;

  const { doc, deleteDoc } = _fs();
  const db = _db();
  if (!db) return;
  try {
    await deleteDoc(doc(db, COLL_TV_CHANNELS, channelId));
    _toast('Channel deleted.');
    if (_activeChannelId === channelId) {
      setChannel(null);
      if (global.SNXTVTimeline && typeof global.SNXTVTimeline.setChannel === 'function') {
        global.SNXTVTimeline.setChannel(null);
      }
      if (global.SNXTV && typeof global.SNXTV.switchChannel === 'function') {
        global.SNXTV.switchChannel(null);
      }
    }
    if (_activeTab === 'channels') _renderChannelsPanel();
  } catch (e) {
    _toast('Delete failed: ' + e.message);
  }
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
  // Channel settings accessor (used by TV viewer for audio-visual mode)
  getSettings: () => Object.assign({}, _tvSettings),
  // Public submission API (any signed-in user)
  submitContent,
  // Multi-channel API
  setChannel,
  getActiveChannelId: () => _activeChannelId || 'default',
  getChannels: () => _getAllChannels(),
  // Stage 5: expose for founder debugging only
  _getPrograms:     () => _isFounder() ? _tvPrograms.slice()    : null,
  _getSchedule:     () => _isFounder() ? _tvSchedule.slice()    : null,
  _getSubmissions:  () => _isFounder() ? _tvSubmissions.slice() : null,

  /** Show the studio overlay (called from TV page — founder only) */
  show() {
    if (!_isFounder()) return;
    const overlay = document.getElementById('snxtvStudioOverlay');
    if (overlay) overlay.classList.add('snxtv-studio-overlay--open');
  },

  /** Show the studio overlay and immediately navigate to the given tab (founder only) */
  openOnTab(tab) {
    if (!_isFounder()) return;
    const overlay = document.getElementById('snxtvStudioOverlay');
    if (overlay) overlay.classList.add('snxtv-studio-overlay--open');
    if (_mounted && tab) {
      // Small delay so the overlay is visible before we switch tab
      setTimeout(() => _switchTab(tab), 60);
    }
  },

  /** Hide the studio overlay */
  hide() {
    if (!_isFounder()) return;
    const overlay = document.getElementById('snxtvStudioOverlay');
    if (overlay) overlay.classList.remove('snxtv-studio-overlay--open');
  },

  version:   STUDIO_VERSION,
  buildId:   'SNS-2026-TV-STAGE6-001'
};

global.SNXTVStudio = SNXTVStudio;

})(window);
