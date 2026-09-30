/**
 * snx-radio-studio.js — Shadow Nexus Radio Studio
 * Version: 3.0.0  (Stage 3 — Real Radio Station Features)
 *
 * Founder-only Radio Studio panel.
 * Sections: DASHBOARD · TRACKS · PLAYLISTS · PROGRAMS · SCHEDULE · SETTINGS
 *
 * Rules:
 *   – Uses ONLY existing /upload-music and /upload-artwork Worker endpoints.
 *   – Uses real URLs returned by Worker — never constructs R2 URLs manually.
 *   – Does NOT touch live.js, snx-sfu.js, or any WebRTC / mediasoup path.
 *   – Deleting a track from a playlist NEVER deletes the R2 audio file.
 *   – Deleting a track document requires confirmation and a playlist-reference check.
 *
 * Dependencies:
 *   firebase-config.js   (window._snxFirestore / _getFirestoreMods())
 *   snx-radio.js         (window.SNXRadio)
 *   snx-radio.css
 */

'use strict';

(function () {

const STUDIO_VERSION = '3.0.0';
const WORKER_BASE    = 'https://yellow-term-11e6.nthntjrn.workers.dev';

// Firestore collection names — must match snx-radio.js constants
const COL_TRACKS    = 'radioTracks';
const COL_PLAYLISTS = 'radioPlaylists';
const COL_PROGRAMS  = 'radioPrograms';
const COL_SCHEDULE  = 'radioSchedule';
const COL_SITE      = 'siteSettings';
const DOC_SETTINGS  = 'radioSettings';
const COL_REQUESTS  = 'radioRequests';   // Song Requests (Stage 5)

const MAX_AUDIO_MB  = 200;
const MAX_IMAGE_MB  = 10;

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */

window.SNXRadioStudio = {
  mount,
  unmount,
  get version() { return STUDIO_VERSION; },
};

/* ══════════════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════════════ */

let _container    = null;
let _mounted      = false;
let _tracks       = [];     // all /radioTracks docs
let _playlists    = {};     // map id→{id,name,trackIds,enabled}
let _programs     = {};     // map id→{id,name,artwork,playlistId,enabled}
let _schedule     = [];     // [{slotId,hour,minute,programId,label,enabled,order}]
let _uploading    = false;
let _activeTab    = 'dashboard';

// Live subscription unsubscribers (onSnapshot)
let _unsubTracks    = null;
let _unsubPlaylists = null;
let _unsubPrograms  = null;
let _unsubSchedule  = null;
let _unsubRequests  = null;

/* ══════════════════════════════════════════════════════════════
   MOUNT / UNMOUNT
══════════════════════════════════════════════════════════════ */

function mount(parentEl) {
  if (_mounted) return;
  if (!parentEl) { console.warn('[SNX-STUDIO] mount: no container'); return; }

  const role = window._snxRole || '';
  if (role !== 'founder') {
    console.log('[SNX-STUDIO] Not founder — studio not mounted');
    return;
  }

  _container = document.createElement('div');
  _container.id = 'snxRadioStudio';
  _buildDOM();
  parentEl.appendChild(_container);
  _bindEvents();
  _mounted = true;

  _switchTab('dashboard');
  // Ensure the Firebase Auth token is attached to the Firestore SDK before the
  // first read — auth state is set but the token propagation can lag by one tick.
  _getIdToken().then(() => _loadAll());

  console.log('[SNX-STUDIO] Radio Studio mounted — version', STUDIO_VERSION);
}

function unmount() {
  if (!_mounted) return;
  // Tear down live subscriptions
  if (_unsubTracks)    { try { _unsubTracks(); }    catch(_){} _unsubTracks    = null; }
  if (_unsubPlaylists) { try { _unsubPlaylists(); } catch(_){} _unsubPlaylists = null; }
  if (_unsubPrograms)  { try { _unsubPrograms(); }  catch(_){} _unsubPrograms  = null; }
  if (_unsubSchedule)  { try { _unsubSchedule(); }  catch(_){} _unsubSchedule  = null; }
  if (_unsubRequests)  { try { _unsubRequests(); }  catch(_){} _unsubRequests  = null; }
  if (_container && _container.parentNode) _container.parentNode.removeChild(_container);
  _container = null;
  _tracks    = [];
  _playlists = {};
  _programs  = {};
  _schedule  = [];
  _mounted   = false;
}

/* ══════════════════════════════════════════════════════════════
   BUILD DOM  — tab shell + all section panels
══════════════════════════════════════════════════════════════ */

function _buildDOM() {
  _container.innerHTML = `
<div class="snxrs-wrap">

  <!-- ── STUDIO HEADER ─────────────────────────────────── -->
  <div class="snxrs-header">
    <span class="snxrs-header-label">🎙 RADIO STUDIO</span>
    <span class="snxrs-header-role">FOUNDER</span>
    <button class="snxrs-close-btn" id="snxrsCloseBtn" type="button" title="Close studio">✕</button>
  </div>

  <!-- ── TAB NAV ────────────────────────────────────────── -->
  <nav class="snxrs-tabs" id="snxrsTabs">
    <button class="snxrs-tab snxrs-tab--active" data-tab="dashboard">DASHBOARD</button>
    <button class="snxrs-tab" data-tab="tracks">TRACKS</button>
    <button class="snxrs-tab" data-tab="playlists">PLAYLISTS</button>
    <button class="snxrs-tab" data-tab="programs">PROGRAMS</button>
    <button class="snxrs-tab" data-tab="schedule">SCHEDULE</button>
    <button class="snxrs-tab" data-tab="settings">SETTINGS</button>
    <button class="snxrs-tab" data-tab="requests">REQUESTS</button>
    <button class="snxrs-tab" data-tab="broadcast">BROADCAST</button>
  </nav>

  <!-- ══ DASHBOARD ════════════════════════════════════════ -->
  <div class="snxrs-panel" id="snxrsPanelDashboard">

    <div class="snxrs-dash-grid">
      <!-- Station status card -->
      <div class="snxrs-dash-card">
        <div class="snxrs-dash-card-label">STATION STATUS</div>
        <div class="snxrs-dash-status" id="snxrsDashStatus">CHECKING…</div>
      </div>
      <!-- Current program card -->
      <div class="snxrs-dash-card">
        <div class="snxrs-dash-card-label">CURRENT PROGRAM</div>
        <div class="snxrs-dash-value" id="snxrsDashProgram">—</div>
      </div>
      <!-- Now Playing -->
      <div class="snxrs-dash-card snxrs-dash-card--wide">
        <div class="snxrs-dash-card-label">NOW PLAYING</div>
        <div class="snxrs-dash-value" id="snxrsDashNowPlaying">—</div>
      </div>
      <!-- Up Next -->
      <div class="snxrs-dash-card snxrs-dash-card--wide">
        <div class="snxrs-dash-card-label">UP NEXT</div>
        <div class="snxrs-dash-value" id="snxrsDashUpNext">—</div>
      </div>
      <!-- Stats row -->
      <div class="snxrs-dash-card">
        <div class="snxrs-dash-card-label">TRACKS</div>
        <div class="snxrs-dash-value snxrs-dash-num" id="snxrsDashTrackCount">—</div>
      </div>
      <div class="snxrs-dash-card">
        <div class="snxrs-dash-card-label">PLAYLISTS</div>
        <div class="snxrs-dash-value snxrs-dash-num" id="snxrsDashPlCount">—</div>
      </div>
    </div>

    <!-- Station controls -->
    <div class="snxrs-section" style="margin-top:16px;">
      <div class="snxrs-row">
        <button class="snxrs-btn snxrs-btn--green" id="snxrsDashStartBtn">▶ START RADIO</button>
        <button class="snxrs-btn snxrs-btn--red"   id="snxrsDashStopBtn">■ STOP RADIO</button>
      </div>
      <p class="snxrs-msg" id="snxrsStationMsg"></p>
    </div>
  </div>

  <!-- ══ TRACKS ═══════════════════════════════════════════ -->
  <div class="snxrs-panel snxrs-hidden" id="snxrsPanelTracks">

    <!-- Upload form -->
    <div class="snxrs-section">
      <div class="snxrs-section-title">UPLOAD TRACK</div>

      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsTitle">TITLE *</label>
        <input class="snxrs-input" id="snxrsTitle" type="text" placeholder="Track title" autocomplete="off" />
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsArtist">ARTIST *</label>
        <input class="snxrs-input" id="snxrsArtist" type="text" placeholder="Artist name" autocomplete="off" />
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsAudioFile">AUDIO FILE * <span class="snxrs-hint">(MP3, M4A, AAC, OGG, FLAC, WAV — max 200 MB)</span></label>
        <input class="snxrs-file-input" id="snxrsAudioFile" type="file" accept="audio/*,.mp3,.m4a,.aac,.ogg,.flac,.wav,.opus" />
        <div class="snxrs-file-preview" id="snxrsAudioPreview"></div>
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsArtworkFile">ARTWORK <span class="snxrs-hint">(optional — JPG, PNG, WEBP — max 10 MB)</span></label>
        <input class="snxrs-file-input" id="snxrsArtworkFile" type="file" accept="image/*,.jpg,.jpeg,.png,.webp" />
        <div class="snxrs-file-preview" id="snxrsArtworkPreview"></div>
      </div>

      <button class="snxrs-btn snxrs-btn--primary" id="snxrsUploadBtn" style="margin-top:8px;">⬆ UPLOAD TRACK</button>

      <div class="snxrs-progress-wrap" id="snxrsUploadProgress" style="display:none;">
        <div class="snxrs-progress-bar-bg">
          <div class="snxrs-progress-bar-fill" id="snxrsProgressFill"></div>
        </div>
        <p class="snxrs-upload-status" id="snxrsUploadStatus">Preparing…</p>
      </div>

      <p class="snxrs-msg snxrs-msg--error" id="snxrsUploadError"></p>
      <p class="snxrs-msg snxrs-msg--ok"    id="snxrsUploadOk"></p>
    </div>

    <!-- Track Library -->
    <div class="snxrs-section">
      <div class="snxrs-row snxrs-row--between">
        <div class="snxrs-section-title">TRACK LIBRARY</div>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" id="snxrsRefreshLibBtn">↻ REFRESH</button>
      </div>
      <div id="snxrsTrackLibrary" class="snxrs-library-list">
        <p class="snxrs-empty">Loading tracks…</p>
      </div>
    </div>
  </div>

  <!-- ══ PLAYLISTS ════════════════════════════════════════ -->
  <div class="snxrs-panel snxrs-hidden" id="snxrsPanelPlaylists">

    <!-- Create new playlist -->
    <div class="snxrs-section">
      <div class="snxrs-section-title">CREATE PLAYLIST</div>
      <div class="snxrs-row">
        <input class="snxrs-input" id="snxrsNewPlName" type="text" placeholder="Playlist name" style="flex:1;" />
        <button class="snxrs-btn snxrs-btn--primary" id="snxrsCreatePlBtn">+ CREATE</button>
      </div>
      <p class="snxrs-msg" id="snxrsCreatePlMsg"></p>
    </div>

    <!-- Playlist list -->
    <div class="snxrs-section">
      <div class="snxrs-row snxrs-row--between">
        <div class="snxrs-section-title">ALL PLAYLISTS</div>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" id="snxrsRefreshPlsBtn">↻ REFRESH</button>
      </div>
      <div id="snxrsPlaylistsList" class="snxrs-library-list">
        <p class="snxrs-empty">Loading playlists…</p>
      </div>
    </div>

    <!-- Playlist editor (shown when a playlist is selected) -->
    <div class="snxrs-section snxrs-hidden" id="snxrsPlEditorSection">
      <div class="snxrs-row snxrs-row--between">
        <div class="snxrs-section-title" id="snxrsPlEditorTitle">EDIT PLAYLIST</div>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" id="snxrsPlEditorCloseBtn">✕ CLOSE</button>
      </div>

      <!-- Rename -->
      <div class="snxrs-row" style="margin-bottom:8px;">
        <input class="snxrs-input" id="snxrsPlRenameInput" type="text" placeholder="Rename playlist…" style="flex:1;" />
        <button class="snxrs-btn snxrs-btn--accent snxrs-btn--sm" id="snxrsPlRenameBtn">RENAME</button>
      </div>

      <!-- Add tracks from library -->
      <div class="snxrs-section-title" style="font-size:10px;margin-bottom:4px;">ADD TRACKS FROM LIBRARY</div>
      <div id="snxrsPlAddList" class="snxrs-library-list snxrs-library-list--compact"></div>

      <!-- Current playlist tracks -->
      <div class="snxrs-section-title" style="font-size:10px;margin:10px 0 4px;">PLAYLIST TRACKS</div>
      <div id="snxrsPlTrackList" class="snxrs-library-list"></div>

      <p class="snxrs-msg" id="snxrsPlEditorMsg"></p>
    </div>
  </div>

  <!-- ══ PROGRAMS ══════════════════════════════════════════ -->
  <div class="snxrs-panel snxrs-hidden" id="snxrsPanelPrograms">

    <div class="snxrs-section">
      <div class="snxrs-section-title">CREATE PROGRAM</div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsProgName">PROGRAM NAME *</label>
        <input class="snxrs-input" id="snxrsProgName" type="text" placeholder="Program name" />
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsProgPlaylist">PLAYLIST</label>
        <select class="snxrs-input snxrs-select" id="snxrsProgPlaylist">
          <option value="">— None (use station playlist) —</option>
        </select>
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsProgArtwork">ARTWORK URL <span class="snxrs-hint">(optional)</span></label>
        <input class="snxrs-input" id="snxrsProgArtwork" type="url" placeholder="https://…" />
      </div>
      <button class="snxrs-btn snxrs-btn--primary" id="snxrsCreateProgBtn">+ CREATE PROGRAM</button>
      <p class="snxrs-msg" id="snxrsCreateProgMsg"></p>
    </div>

    <div class="snxrs-section">
      <div class="snxrs-row snxrs-row--between">
        <div class="snxrs-section-title">ALL PROGRAMS</div>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" id="snxrsRefreshProgsBtn">↻ REFRESH</button>
      </div>
      <div id="snxrsProgramsList" class="snxrs-library-list">
        <p class="snxrs-empty">Loading programs…</p>
      </div>
    </div>
  </div>

  <!-- ══ SCHEDULE ══════════════════════════════════════════ -->
  <div class="snxrs-panel snxrs-hidden" id="snxrsPanelSchedule">

    <div class="snxrs-section">
      <div class="snxrs-section-title">ADD SCHEDULE SLOT</div>
      <div class="snxrs-row" style="gap:8px;flex-wrap:wrap;">
        <div class="snxrs-field" style="margin:0;flex:0 0 80px;">
          <label class="snxrs-label" for="snxrsSlotHour">HOUR (UTC)</label>
          <input class="snxrs-input" id="snxrsSlotHour" type="number" min="0" max="23" value="0" />
        </div>
        <div class="snxrs-field" style="margin:0;flex:0 0 80px;">
          <label class="snxrs-label" for="snxrsSlotMin">MINUTE</label>
          <input class="snxrs-input" id="snxrsSlotMin" type="number" min="0" max="59" value="0" />
        </div>
        <div class="snxrs-field" style="margin:0;flex:1;min-width:140px;">
          <label class="snxrs-label" for="snxrsSlotLabel">LABEL</label>
          <input class="snxrs-input" id="snxrsSlotLabel" type="text" placeholder="e.g. Morning Mix" />
        </div>
        <div class="snxrs-field" style="margin:0;flex:1;min-width:140px;">
          <label class="snxrs-label" for="snxrsSlotProgram">PROGRAM</label>
          <select class="snxrs-input snxrs-select" id="snxrsSlotProgram">
            <option value="">— None —</option>
          </select>
        </div>
      </div>
      <button class="snxrs-btn snxrs-btn--primary" id="snxrsAddSlotBtn" style="margin-top:8px;">+ ADD SLOT</button>
      <p class="snxrs-msg" id="snxrsSlotMsg"></p>
    </div>

    <div class="snxrs-section">
      <div class="snxrs-row snxrs-row--between">
        <div class="snxrs-section-title">SCHEDULE</div>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" id="snxrsRefreshSchedBtn">↻ REFRESH</button>
      </div>
      <p class="snxrs-hint" style="margin:0 0 8px;">Times are in UTC. Listeners calculate the active program locally from server time.</p>
      <div id="snxrsScheduleList" class="snxrs-library-list">
        <p class="snxrs-empty">No schedule slots yet.</p>
      </div>
    </div>
  </div>

  <!-- ══ SETTINGS ══════════════════════════════════════════ -->
  <div class="snxrs-panel snxrs-hidden" id="snxrsPanelSettings">

    <div class="snxrs-section">
      <div class="snxrs-section-title">STATION IDENTITY</div>

      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsSetName">STATION NAME</label>
        <input class="snxrs-input" id="snxrsSetName" type="text" placeholder="Shadow Nexus Radio" />
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsSetTagline">TAGLINE</label>
        <input class="snxrs-input" id="snxrsSetTagline" type="text" placeholder="24/7 Music · Live Events · Shadow Nexus" />
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsSetArtwork">DEFAULT ARTWORK URL <span class="snxrs-hint">(optional)</span></label>
        <input class="snxrs-input" id="snxrsSetArtwork" type="url" placeholder="https://…" />
      </div>

      <button class="snxrs-btn snxrs-btn--primary" id="snxrsSaveSettingsBtn">💾 SAVE SETTINGS</button>
      <p class="snxrs-msg" id="snxrsSettingsMsg"></p>
    </div>
  </div>

  <!-- ══ SONG REQUESTS ════════════════════════════════════ -->
  <div class="snxrs-panel snxrs-hidden" id="snxrsPanelRequests">

    <div class="snxrs-section">
      <div class="snxrs-row snxrs-row--between">
        <div class="snxrs-section-title">SONG REQUESTS</div>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" id="snxrsRefreshRequestsBtn">↻ REFRESH</button>
      </div>
      <p class="snxrs-hint" style="margin:0 0 8px;">
        Listener requests below. APPROVE places it in the workflow queue for future playback.
        REJECT removes it from the queue. Neither action interrupts the current broadcast.
      </p>
      <div class="snxrs-row" style="gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm snxrs-rq-filter snxrs-rq-filter--active" data-filter="pending">PENDING</button>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm snxrs-rq-filter" data-filter="approved">APPROVED</button>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm snxrs-rq-filter" data-filter="rejected">REJECTED</button>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm snxrs-rq-filter" data-filter="all">ALL</button>
      </div>
      <div id="snxrsRequestsList" class="snxrs-library-list">
        <p class="snxrs-empty">Loading requests…</p>
      </div>
      <p class="snxrs-msg" id="snxrsRequestsMsg"></p>
    </div>

  </div>

  <!-- ══ BROADCAST ════════════════════════════════════════ -->
  <div class="snxrs-panel snxrs-hidden" id="snxrsPanelBroadcast">

    <!-- Encoder host notice -->
    <div class="snxrs-section" style="border:1px solid #b45309;background:#1c1003;border-radius:6px;padding:10px 12px;margin-bottom:12px;">
      <div class="snxrs-section-title" style="color:#f59e0b;">⚠ ENCODER HOST REQUIRED</div>
      <p class="snxrs-hint" style="margin:4px 0 0;line-height:1.5;">
        RTMP destinations tell the Broadcast Engine <strong>where</strong> to send the stream.
        A continuously-running server-side encoder (FFmpeg, OBS, etc. on a VPS or dedicated machine)
        is required to provide the actual H.264 + AAC → RTMP output.
        A browser alone cannot run a 24/7 encoder.
      </p>
    </div>

    <!-- Add destination form -->
    <div class="snxrs-section">
      <div class="snxrs-section-title" id="snxrsBcFormTitle">ADD RTMP DESTINATION</div>

      <!-- Hidden field: editing destId -->
      <input type="hidden" id="snxrsBcEditId" value="" />

      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsBcName">DESTINATION NAME *</label>
        <input class="snxrs-input" id="snxrsBcName" type="text" placeholder="e.g. YouTube" autocomplete="off" />
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsBcUrl">RTMP / RTMPS SERVER URL *</label>
        <input class="snxrs-input" id="snxrsBcUrl" type="text" placeholder="rtmps://a.rtmps.youtube.com/live2" autocomplete="off" />
        <p class="snxrs-hint" style="margin:2px 0 0;">Must start with rtmp:// or rtmps://</p>
      </div>
      <div class="snxrs-field">
        <label class="snxrs-label" for="snxrsBcKey">STREAM KEY * <span class="snxrs-hint">(secret — stored encrypted, never shown again)</span></label>
        <input class="snxrs-input" id="snxrsBcKey" type="password" placeholder="Enter stream key" autocomplete="new-password" />
        <p class="snxrs-hint" style="margin:2px 0 0;">Leave blank when editing to keep the existing key.</p>
      </div>
      <div class="snxrs-field" style="flex-direction:row;align-items:center;gap:8px;">
        <input type="checkbox" id="snxrsBcEnabled" checked style="width:16px;height:16px;cursor:pointer;" />
        <label class="snxrs-label" for="snxrsBcEnabled" style="margin:0;cursor:pointer;">ENABLED</label>
      </div>

      <div class="snxrs-row" style="margin-top:8px;gap:8px;">
        <button class="snxrs-btn snxrs-btn--primary" id="snxrsBcSaveBtn">💾 SAVE</button>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm snxrs-hidden" id="snxrsBcCancelEditBtn">✕ CANCEL EDIT</button>
      </div>
      <p class="snxrs-msg" id="snxrsBcFormMsg"></p>
    </div>

    <!-- Destination list -->
    <div class="snxrs-section">
      <div class="snxrs-row snxrs-row--between">
        <div class="snxrs-section-title">RTMP DESTINATIONS</div>
        <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" id="snxrsBcRefreshBtn">↻ REFRESH</button>
      </div>
      <div id="snxrsBcList" class="snxrs-library-list">
        <p class="snxrs-empty">Loading destinations…</p>
      </div>
    </div>

    <!-- Broadcast engine status -->
    <div class="snxrs-section">
      <div class="snxrs-section-title">BROADCAST ENGINE</div>
      <p class="snxrs-hint" style="margin:0 0 8px;">
        The engine combines <strong>Server URL + Stream Key</strong> per destination and
        signals the encoder host over the control bus.
      </p>
      <div class="snxrs-row" style="gap:8px;flex-wrap:wrap;">
        <button class="snxrs-btn snxrs-btn--green" id="snxrsBcStartBtn">▶ START BROADCAST</button>
        <button class="snxrs-btn snxrs-btn--red"   id="snxrsBcStopBtn">■ STOP BROADCAST</button>
      </div>
      <div id="snxrsBcStatus" class="snxrs-hint" style="margin-top:8px;">Status: IDLE</div>
      <p class="snxrs-msg" id="snxrsBcEngineMsg"></p>
    </div>
  </div>

</div><!-- end snxrs-wrap -->
  `;
}

/* ══════════════════════════════════════════════════════════════
   TAB SWITCHING
══════════════════════════════════════════════════════════════ */

function _switchTab(tab) {
  _activeTab = tab;

  // Update tab buttons
  const tabs = _container.querySelectorAll('.snxrs-tab');
  tabs.forEach(btn => {
    btn.classList.toggle('snxrs-tab--active', btn.dataset.tab === tab);
  });

  // Show/hide panels
  const panels = ['dashboard', 'tracks', 'playlists', 'programs', 'schedule', 'settings', 'requests', 'broadcast'];
  panels.forEach(p => {
    const el = document.getElementById(`snxrsPanelPanel${_cap(p)}`) ||
               document.getElementById(`snxrsPanel${_cap(p)}`);
    if (!el) return;
    el.classList.toggle('snxrs-hidden', p !== tab);
  });

  // Refresh data when switching to a tab
  if (tab === 'dashboard')  _refreshDashboard();
  if (tab === 'tracks')     _loadTracks();
  if (tab === 'playlists')  _loadPlaylists();
  if (tab === 'programs')   _loadPrograms();
  if (tab === 'schedule')   _loadSchedule();
  if (tab === 'settings')   _loadSettings();
  if (tab === 'requests')   _loadRequests();
  if (tab === 'broadcast')  _loadBroadcastDestinations();
}

function _cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ══════════════════════════════════════════════════════════════
   BIND EVENTS
══════════════════════════════════════════════════════════════ */

function _bindEvents() {
  const $ = id => document.getElementById(id);

  // Close button — also resets the toggle button text in the Founder bar
  $('snxrsCloseBtn').addEventListener('click', () => {
    if (_container) _container.classList.remove('snxrs-open');
    const toggleBtn = document.getElementById('snxrStudioToggleBtn');
    if (toggleBtn) toggleBtn.textContent = '🎙 RADIO STUDIO';
  });

  // Tab nav
  const tabs = _container.querySelectorAll('.snxrs-tab');
  tabs.forEach(btn => btn.addEventListener('click', () => _switchTab(btn.dataset.tab)));

  // ── DASHBOARD ──
  $('snxrsDashStartBtn').addEventListener('click', _onStartRadio);
  $('snxrsDashStopBtn').addEventListener('click',  _onStopRadio);

  // ── TRACKS ──
  $('snxrsUploadBtn').addEventListener('click',       _onUpload);
  $('snxrsAudioFile').addEventListener('change',      _onAudioFileChange);
  $('snxrsArtworkFile').addEventListener('change',    _onArtworkFileChange);
  // Refresh buttons: tear down existing subscription so the guard re-arms.
  $('snxrsRefreshLibBtn').addEventListener('click', () => {
    if (_unsubTracks) { try { _unsubTracks(); } catch(_){} _unsubTracks = null; }
    _loadTracks();
  });

  // ── PLAYLISTS ──
  $('snxrsCreatePlBtn').addEventListener('click',     _onCreatePlaylist);
  $('snxrsRefreshPlsBtn').addEventListener('click',   () => {
    if (_unsubPlaylists) { try { _unsubPlaylists(); } catch(_){} _unsubPlaylists = null; }
    _loadPlaylists();
  });
  $('snxrsPlEditorCloseBtn').addEventListener('click',() => {
    const sec = $('snxrsPlEditorSection');
    if (sec) sec.classList.add('snxrs-hidden');
  });
  $('snxrsPlRenameBtn').addEventListener('click',     _onRenamePlaylist);

  // ── PROGRAMS ──
  $('snxrsCreateProgBtn').addEventListener('click',   _onCreateProgram);
  $('snxrsRefreshProgsBtn').addEventListener('click', () => {
    if (_unsubPrograms) { try { _unsubPrograms(); } catch(_){} _unsubPrograms = null; }
    _loadPrograms();
  });

  // ── SCHEDULE ──
  $('snxrsAddSlotBtn').addEventListener('click',      _onAddSlot);
  $('snxrsRefreshSchedBtn').addEventListener('click', () => {
    if (_unsubSchedule) { try { _unsubSchedule(); } catch(_){} _unsubSchedule = null; }
    _loadSchedule();
  });

  // ── SETTINGS ──
  $('snxrsSaveSettingsBtn').addEventListener('click', _onSaveSettings);

  // ── SONG REQUESTS ──
  $('snxrsRefreshRequestsBtn').addEventListener('click', () => {
    if (_unsubRequests) { try { _unsubRequests(); } catch(_){} _unsubRequests = null; }
    _loadRequests();
  });
  // Filter buttons
  const filterBtns = _container.querySelectorAll('.snxrs-rq-filter');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('snxrs-rq-filter--active'));
      btn.classList.add('snxrs-rq-filter--active');
      _renderRequests();
    });
  });

  // ── BROADCAST ──
  $('snxrsBcSaveBtn').addEventListener('click',      _onBroadcastSave);
  $('snxrsBcCancelEditBtn').addEventListener('click', _onBroadcastCancelEdit);
  $('snxrsBcRefreshBtn').addEventListener('click',   () => _loadBroadcastDestinations());
  $('snxrsBcStartBtn').addEventListener('click',     _onBroadcastStart);
  $('snxrsBcStopBtn').addEventListener('click',      _onBroadcastStop);
}

/* ══════════════════════════════════════════════════════════════
   LOAD ALL (initial load)
══════════════════════════════════════════════════════════════ */

async function _loadAll() {
  await Promise.allSettled([
    _loadTracks(),
    _loadPlaylists(),
    _loadPrograms(),
    _loadSchedule(),
    _loadSettings(),
    _loadRequests(),
  ]);
  _refreshDashboard();
}

/* ══════════════════════════════════════════════════════════════
   DASHBOARD
══════════════════════════════════════════════════════════════ */

function _refreshDashboard() {
  const $ = id => document.getElementById(id);

  // Station status
  const radio = window.SNXRadio;
  const enabled = radio && radio.stationEnabled;
  const statusEl = $('snxrsDashStatus');
  if (statusEl) {
    statusEl.textContent = enabled ? '● ON AIR' : '○ OFF AIR';
    statusEl.style.color = enabled ? '#39FF14' : '#ef4444';
  }

  // Current program
  const prog = radio && radio.currentProgram;
  const progEl = $('snxrsDashProgram');
  if (progEl) progEl.textContent = prog ? (prog.slotLabel || prog.name || '—') : '—';

  // Now Playing / Up Next
  const nowEl = $('snxrsDashNowPlaying');
  const upEl  = $('snxrsDashUpNext');
  const now   = radio && radio.nowPlaying;
  const up    = radio && radio.upNext;
  if (nowEl) nowEl.textContent = now ? `${now.title} — ${now.artist}` : '—';
  if (upEl)  upEl.textContent  = up  ? `${up.title} — ${up.artist}`   : '—';

  // Stats
  const tcEl = $('snxrsDashTrackCount');
  const pcEl = $('snxrsDashPlCount');
  if (tcEl) tcEl.textContent = _tracks.length;
  if (pcEl) pcEl.textContent = Object.keys(_playlists).length;
}

/* ══════════════════════════════════════════════════════════════
   STATION CONTROLS
══════════════════════════════════════════════════════════════ */

async function _onStartRadio() {
  const msg = document.getElementById('snxrsStationMsg');
  if (!window.SNXRadio) { _setMsg(msg, '✗ SNXRadio engine not loaded', 'error'); return; }

  // Determine which playlist to use — prefer current program's playlist
  const prog = window.SNXRadio.currentProgram;
  const plId = prog && prog.playlistId
    ? prog.playlistId
    : Object.keys(_playlists)[0] || null;

  _setMsg(msg, 'Starting station…', '');
  try {
    await window.SNXRadio.stationStart(plId);
    _setMsg(msg, '✓ Station started — ON AIR', 'ok');
    _refreshDashboard();
  } catch (e) {
    _setMsg(msg, '✗ ' + e.message, 'error');
  }
}

async function _onStopRadio() {
  const msg = document.getElementById('snxrsStationMsg');
  if (!window.SNXRadio) { _setMsg(msg, '✗ SNXRadio engine not loaded', 'error'); return; }
  _setMsg(msg, 'Stopping station…', '');
  try {
    await window.SNXRadio.stationStop();
    _setMsg(msg, '✓ Station stopped — OFF AIR', 'ok');
    _refreshDashboard();
  } catch (e) {
    _setMsg(msg, '✗ ' + e.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   TRACK UPLOAD
══════════════════════════════════════════════════════════════ */

function _onAudioFileChange(e) {
  const file    = e.target.files && e.target.files[0];
  const preview = document.getElementById('snxrsAudioPreview');
  if (!file) { if (preview) preview.textContent = ''; return; }

  const sizeMB = (file.size / 1024 / 1024).toFixed(1);
  if (preview) preview.textContent = `${file.name} (${sizeMB} MB) — detecting duration…`;

  _detectDuration(file).then(sec => {
    const mm = Math.floor(sec / 60);
    const ss = Math.round(sec % 60);
    if (preview) {
      preview.textContent = `${file.name} (${sizeMB} MB) — ${mm}:${String(ss).padStart(2,'0')} (${sec.toFixed(1)}s)`;
      preview.dataset.duration = String(sec);
    }
  }).catch(err => {
    if (preview) {
      preview.textContent = `${file.name} — duration detection failed: ${err.message}`;
      preview.dataset.duration = '';
    }
  });
}

function _onArtworkFileChange(e) {
  const file    = e.target.files && e.target.files[0];
  const preview = document.getElementById('snxrsArtworkPreview');
  if (!file) { if (preview) preview.textContent = ''; return; }
  if (preview) preview.textContent = `${file.name} (${(file.size/1024/1024).toFixed(1)} MB)`;
}

function _detectDuration(file) {
  return new Promise((resolve, reject) => {
    const url   = URL.createObjectURL(file);
    const audio = new Audio();
    let   done  = false;
    function cleanup() { audio.src = ''; URL.revokeObjectURL(url); }

    audio.addEventListener('loadedmetadata', () => {
      if (done) return;
      done = true;
      const dur = audio.duration;
      cleanup();
      if (!isFinite(dur) || dur <= 0) reject(new Error('Cannot determine duration (got: ' + dur + ')'));
      else resolve(dur);
    });
    audio.addEventListener('error', () => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('Audio load error — code: ' + (audio.error ? audio.error.code : 'unknown')));
    });
    setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('Duration detection timed out'));
    }, 30000);

    audio.preload = 'metadata';
    audio.src     = url;
  });
}

async function _onUpload() {
  if (_uploading) return;

  const errEl = document.getElementById('snxrsUploadError');
  const okEl  = document.getElementById('snxrsUploadOk');
  _setMsg(errEl, '', '');
  _setMsg(okEl,  '', '');

  const title        = (document.getElementById('snxrsTitle').value  || '').trim();
  const artist       = (document.getElementById('snxrsArtist').value || '').trim();
  const audioInput   = document.getElementById('snxrsAudioFile');
  const artInput     = document.getElementById('snxrsArtworkFile');
  const audioPreview = document.getElementById('snxrsAudioPreview');
  const audioFile    = audioInput.files && audioInput.files[0];
  const artworkFile  = artInput.files  && artInput.files[0];

  if (!title)     { _setMsg(errEl, 'Title is required', 'error'); return; }
  if (!artist)    { _setMsg(errEl, 'Artist is required', 'error'); return; }
  if (!audioFile) { _setMsg(errEl, 'Audio file is required', 'error'); return; }

  if (audioFile.size > MAX_AUDIO_MB * 1024 * 1024) {
    _setMsg(errEl, `Audio file too large (max ${MAX_AUDIO_MB} MB)`, 'error'); return;
  }
  if (artworkFile && artworkFile.size > MAX_IMAGE_MB * 1024 * 1024) {
    _setMsg(errEl, `Artwork too large (max ${MAX_IMAGE_MB} MB)`, 'error'); return;
  }

  let durationRaw = audioPreview ? parseFloat(audioPreview.dataset.duration || '') : NaN;
  if (!isFinite(durationRaw) || durationRaw <= 0) {
    _setMsg(errEl, 'Detecting duration…', '');
    try { durationRaw = await _detectDuration(audioFile); }
    catch (e) { _setMsg(errEl, 'Cannot detect duration: ' + e.message, 'error'); return; }
  }

  const duration = durationRaw;
  if (!isFinite(duration) || duration <= 0) {
    _setMsg(errEl, 'Invalid duration — cannot upload', 'error'); return;
  }

  const idToken = await _getIdToken();
  if (!idToken) { _setMsg(errEl, 'Not authenticated', 'error'); return; }

  const uid = _getCurrentUid();
  if (!uid)  { _setMsg(errEl, 'Cannot determine UID', 'error'); return; }

  _uploading = true;
  _setUploadUI(true);

  try {
    // Step 1: Upload audio
    _setProgress(10, 'Uploading audio…');
    const audioExt = (audioFile.name.split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '');
    const audioKey = `radio/${uid}/audio/${Date.now()}-${_randHex()}.${audioExt}`;
    const audioFd  = new FormData();
    audioFd.append('file', audioFile);
    audioFd.append('path', audioKey);

    const audioResp = await fetch(`${WORKER_BASE}/upload-music`, {
      method: 'POST', headers: { 'Authorization': 'Bearer ' + idToken }, body: audioFd,
    });
    _setProgress(50, 'Processing audio…');
    if (!audioResp.ok) {
      let errMsg = audioResp.statusText;
      try { const j = await audioResp.json(); errMsg = j.error || errMsg; } catch (_) {}
      throw new Error('Audio upload failed (' + audioResp.status + '): ' + errMsg);
    }
    const audioData = await audioResp.json();
    if (!audioData.url) throw new Error('Worker did not return an audio URL');
    const audioUrl = audioData.url;

    // Step 2: Upload artwork (optional)
    let artworkUrl = null;
    if (artworkFile) {
      _setProgress(60, 'Uploading artwork…');
      const artExt = (artworkFile.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const artKey = `radio/${uid}/artwork/${Date.now()}-${_randHex()}.${artExt}`;
      const artFd  = new FormData();
      artFd.append('file', artworkFile);
      artFd.append('path', artKey);
      const artResp = await fetch(`${WORKER_BASE}/upload-artwork`, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + idToken }, body: artFd,
      });
      _setProgress(75, 'Processing artwork…');
      if (artResp.ok) {
        const artData = await artResp.json();
        artworkUrl = artData.url || null;
      } else {
        console.warn('[SNX-STUDIO] Artwork upload failed — using default artwork');
      }
    }

    // Step 3: Verify audio URL
    _setProgress(80, 'Verifying playback URL…');
    await _verifyAudioUrl(audioUrl, duration);

    // Step 4: Write track doc
    _setProgress(90, 'Saving track…');
    const trackId = await _writeTrackDoc({ title, artist, audioUrl, artworkUrl, duration, uid });

    _setProgress(100, 'Done!');
    _clearUploadForm();
    _setMsg(okEl, `✓ Track uploaded — ID: ${trackId} — ${_fmtDuration(duration)}`, 'ok');
    await _loadTracks();

  } catch (e) {
    _setMsg(errEl, '✗ ' + e.message, 'error');
    console.error('[SNX-STUDIO] Upload error:', e);
  } finally {
    _uploading = false;
    _setUploadUI(false);
  }
}

function _verifyAudioUrl(url, expectedDuration) {
  return new Promise((resolve, reject) => {
    const audio = new Audio();
    let   done  = false;
    function cleanup() { audio.src = ''; }

    audio.addEventListener('loadedmetadata', () => {
      if (done) return;
      const actualDur = audio.duration;
      if (!isFinite(actualDur) || actualDur <= 0) {
        done = true; cleanup();
        reject(new Error('Playback URL loaded but duration is invalid (' + actualDur + ')'));
        return;
      }
      const diff = Math.abs(actualDur - expectedDuration);
      if (diff > Math.max(5, expectedDuration * 0.05)) {
        console.warn('[SNX-STUDIO] Duration mismatch: stored=' + expectedDuration.toFixed(1) + 's, remote=' + actualDur.toFixed(1) + 's');
      }
      audio.currentTime = actualDur * 0.1;
    });
    audio.addEventListener('seeked', () => {
      if (done) return;
      done = true; cleanup(); resolve();
    });
    audio.addEventListener('error', () => {
      if (done) return;
      done = true; cleanup();
      // Log the failure but resolve rather than reject — the file is already in R2
      // (the upload succeeded) so a browser playback probe error should not block
      // the track from being saved.  CORS / autoplay / codec errors are not fatal.
      console.warn('[SNX-STUDIO] Audio probe failed (code: ' +
        (audio.error ? audio.error.code : 'unknown') + ') — continuing anyway');
      resolve();
    });
    setTimeout(() => { if (done) return; done = true; cleanup(); resolve(); }, 20000);

    // crossOrigin must be set BEFORE src to avoid CORS cache taint
    audio.crossOrigin = 'anonymous';
    audio.preload     = 'metadata';
    audio.src         = url;
  });
}

async function _writeTrackDoc({ title, artist, audioUrl, artworkUrl, duration, uid }) {
  if (window.SNXRadio && window.SNXRadio.trackAdd) {
    return window.SNXRadio.trackAdd({ title, artist, audioUrl, artworkUrl: artworkUrl || null, duration, enabled: true, createdBy: uid });
  }
  const db   = _getFirestore();
  const mods = _getFirestoreMods();
  const ts   = mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date();
  const doc  = { title, artist, audioUrl, artworkUrl: artworkUrl || null, duration, enabled: true, createdAt: ts, createdBy: uid };
  if (mods && mods.collection && mods.addDoc) {
    const ref = await mods.addDoc(mods.collection(db, COL_TRACKS), doc);
    return ref.id;
  } else if (db && db.collection) {
    const ref = await db.collection(COL_TRACKS).add(doc);
    return ref.id;
  }
  throw new Error('No Firestore write API available');
}

/* ══════════════════════════════════════════════════════════════
   TRACK LIBRARY — load + render
══════════════════════════════════════════════════════════════ */

function _loadTracks() {
  // Prevent duplicate subscriptions
  if (_unsubTracks) return;

  const db   = _getFirestore();
  const mods = _getFirestoreMods();
  if (!db || !mods) return;

  const listEl = document.getElementById('snxrsTrackLibrary');
  if (listEl) listEl.innerHTML = '<p class="snxrs-empty">Loading…</p>';

  try {
    let q;
    if (mods.collection && mods.onSnapshot && mods.query && mods.orderBy) {
      q = mods.query(mods.collection(db, COL_TRACKS), mods.orderBy('createdAt', 'desc'));
      _unsubTracks = mods.onSnapshot(q, (snap) => {
        let docs = [];
        snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
        _tracks = docs;
        const el = document.getElementById('snxrsTrackLibrary');
        if (el) _renderTrackLibrary(el, docs);
        _populatePlaylistSelects(); // keep selects current
        _refreshDashboard();
      }, (err) => {
        console.error('[SNX-STUDIO] tracks snapshot error:', err.message);
        _unsubTracks = null;
      });
    } else if (db.collection) {
      // Compat SDK fallback — one-time read
      db.collection(COL_TRACKS).orderBy('createdAt', 'desc').get()
        .then(snap => {
          let docs = [];
          snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
          _tracks = docs;
          const el = document.getElementById('snxrsTrackLibrary');
          if (el) _renderTrackLibrary(el, docs);
          _refreshDashboard();
        })
        .catch(e => { if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`; });
    }
  } catch (e) {
    if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`;
  }
}

function _renderTrackLibrary(listEl, docs) {
  if (!docs.length) {
    listEl.innerHTML = '<p class="snxrs-empty">No tracks yet. Upload your first track above.</p>';
    return;
  }

  listEl.innerHTML = docs.map(t => {
    const dur    = _fmtDuration(t.duration);
    const art    = t.artworkUrl || '';
    const enStr  = t.enabled !== false ? 'ENABLED' : 'DISABLED';
    const enCls  = t.enabled !== false ? 'snxrs-badge--green' : 'snxrs-badge--grey';
    const artImg = art
      ? `<img class="snxrs-track-art" src="${_esc(art)}" alt="" loading="lazy" />`
      : `<div class="snxrs-track-art snxrs-track-art--placeholder">🎵</div>`;
    const dateStr = t.createdAt
      ? new Date(t.createdAt.seconds ? t.createdAt.seconds * 1000 : t.createdAt).toLocaleDateString()
      : '';

    return `
<div class="snxrs-track-row" data-id="${_esc(t.id)}">
  ${artImg}
  <div class="snxrs-track-info">
    <div class="snxrs-track-title">${_esc(t.title || 'Untitled')}</div>
    <div class="snxrs-track-artist">${_esc(t.artist || 'Unknown')}</div>
    <div class="snxrs-track-meta">${_esc(dur)}${dateStr ? ' · ' + _esc(dateStr) : ''}</div>
  </div>
  <div class="snxrs-track-actions">
    <span class="snxrs-badge ${enCls}" id="snxrsBadge_${_esc(t.id)}">${enStr}</span>
    <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm"
            onclick="SNXRadioStudio._toggleTrack('${_esc(t.id)}', ${t.enabled !== false})">
      ${t.enabled !== false ? 'DISABLE' : 'ENABLE'}
    </button>
    <button class="snxrs-btn snxrs-btn--red snxrs-btn--sm"
            onclick="SNXRadioStudio._deleteTrack('${_esc(t.id)}', '${_esc(t.title || '')}')">
      🗑 DELETE
    </button>
  </div>
</div>`;
  }).join('');
}

/* Track enable/disable */
window.SNXRadioStudio._toggleTrack = async function(trackId, currentEnabled) {
  try {
    const newVal = !currentEnabled;
    if (window.SNXRadio && window.SNXRadio.trackUpdate) {
      await window.SNXRadio.trackUpdate(trackId, { enabled: newVal });
    } else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      if (mods && mods.doc && mods.updateDoc)
        await mods.updateDoc(mods.doc(db, COL_TRACKS, trackId), { enabled: newVal });
      else if (db && db.collection)
        await db.collection(COL_TRACKS).doc(trackId).update({ enabled: newVal });
    }
    _loadTracks();
  } catch (e) { console.error('[SNX-STUDIO] toggleTrack:', e); alert('Error: ' + e.message); }
};

/* Track delete — requires confirmation + playlist reference check */
window.SNXRadioStudio._deleteTrack = async function(trackId, title) {
  if (!confirm(`Delete track "${title}"?\n\nThis removes the Firestore document only. The R2 audio file is NOT deleted.\nThe track will be removed from all playlists automatically.\n\nAre you sure?`)) return;

  try {
    // Remove from all playlists first
    const db = _getFirestore(), mods = _getFirestoreMods();
    for (const plId of Object.keys(_playlists)) {
      const pl = _playlists[plId];
      if (pl.trackIds && pl.trackIds.includes(trackId)) {
        const newIds = pl.trackIds.filter(id => id !== trackId);
        await _updatePlaylistDoc(plId, { trackIds: newIds });
      }
    }
    // Delete the track document
    if (window.SNXRadio && window.SNXRadio.trackDelete) {
      await window.SNXRadio.trackDelete(trackId);
    } else {
      if (mods && mods.doc && mods.deleteDoc)
        await mods.deleteDoc(mods.doc(db, COL_TRACKS, trackId));
      else if (db && db.collection)
        await db.collection(COL_TRACKS).doc(trackId).delete();
    }
    _loadTracks();
    _loadPlaylists();
  } catch (e) { console.error('[SNX-STUDIO] deleteTrack:', e); alert('Delete failed: ' + e.message); }
};

/* ══════════════════════════════════════════════════════════════
   PLAYLISTS — load + render
══════════════════════════════════════════════════════════════ */

function _loadPlaylists() {
  if (_unsubPlaylists) return; // already subscribed

  const db   = _getFirestore();
  const mods = _getFirestoreMods();
  if (!db || !mods) return;

  const listEl = document.getElementById('snxrsPlaylistsList');
  if (listEl) listEl.innerHTML = '<p class="snxrs-empty">Loading…</p>';

  try {
    if (mods.collection && mods.onSnapshot) {
      const colRef = mods.collection(db, COL_PLAYLISTS);
      _unsubPlaylists = mods.onSnapshot(colRef, (snap) => {
        let docs = [];
        snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
        _playlists = {};
        docs.forEach(d => { _playlists[d.id] = d; });
        const el = document.getElementById('snxrsPlaylistsList');
        if (el) _renderPlaylistsList(el, docs);
        _populatePlaylistSelects();
        _populateProgramSelects();
        _refreshDashboard();
      }, (err) => {
        console.error('[SNX-STUDIO] playlists snapshot error:', err.message);
        _unsubPlaylists = null;
      });
    } else if (db.collection) {
      db.collection(COL_PLAYLISTS).get()
        .then(snap => {
          let docs = [];
          snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
          _playlists = {};
          docs.forEach(d => { _playlists[d.id] = d; });
          const el = document.getElementById('snxrsPlaylistsList');
          if (el) _renderPlaylistsList(el, docs);
          _populatePlaylistSelects();
          _refreshDashboard();
        })
        .catch(e => { if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`; });
    }
  } catch (e) {
    if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`;
  }
}

function _renderPlaylistsList(listEl, docs) {
  if (!docs.length) {
    listEl.innerHTML = '<p class="snxrs-empty">No playlists yet.</p>';
    return;
  }
  listEl.innerHTML = docs.map(pl => {
    const count  = (pl.trackIds || []).length;
    const enStr  = pl.enabled !== false ? 'ENABLED' : 'DISABLED';
    const enCls  = pl.enabled !== false ? 'snxrs-badge--green' : 'snxrs-badge--grey';
    return `
<div class="snxrs-track-row" data-id="${_esc(pl.id)}">
  <div class="snxrs-track-info">
    <div class="snxrs-track-title">${_esc(pl.name || pl.id)}</div>
    <div class="snxrs-track-meta">${count} track${count !== 1 ? 's' : ''}</div>
  </div>
  <div class="snxrs-track-actions">
    <span class="snxrs-badge ${enCls}">${enStr}</span>
    <button class="snxrs-btn snxrs-btn--accent snxrs-btn--sm"
            onclick="SNXRadioStudio._openPlaylistEditor('${_esc(pl.id)}')">
      ✏ EDIT
    </button>
    <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm"
            onclick="SNXRadioStudio._togglePlaylist('${_esc(pl.id)}', ${pl.enabled !== false})">
      ${pl.enabled !== false ? 'DISABLE' : 'ENABLE'}
    </button>
    <button class="snxrs-btn snxrs-btn--red snxrs-btn--sm"
            onclick="SNXRadioStudio._deletePlaylist('${_esc(pl.id)}', '${_esc(pl.name || pl.id)}')">
      🗑
    </button>
  </div>
</div>`;
  }).join('');
}

async function _onCreatePlaylist() {
  const nameEl = document.getElementById('snxrsNewPlName');
  const msgEl  = document.getElementById('snxrsCreatePlMsg');
  const name   = (nameEl ? nameEl.value : '').trim();
  if (!name) { _setMsg(msgEl, 'Enter a playlist name', 'error'); return; }

  _setMsg(msgEl, 'Creating…', '');
  try {
    let id;
    if (window.SNXRadio && window.SNXRadio.playlistCreate) {
      id = await window.SNXRadio.playlistCreate({ name, trackIds: [], enabled: true });
    } else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      const ts = mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date();
      const data = { name, trackIds: [], enabled: true, createdAt: ts, updatedAt: ts };
      if (mods && mods.collection && mods.addDoc) {
        const ref = await mods.addDoc(mods.collection(db, COL_PLAYLISTS), data);
        id = ref.id;
      } else if (db && db.collection) {
        const ref = await db.collection(COL_PLAYLISTS).add(data);
        id = ref.id;
      }
    }
    if (nameEl) nameEl.value = '';
    _setMsg(msgEl, `✓ Playlist "${name}" created`, 'ok');
    await _loadPlaylists();
    if (id) window.SNXRadioStudio._openPlaylistEditor(id);
  } catch (e) {
    _setMsg(msgEl, '✗ ' + e.message, 'error');
  }
}

/* Playlist editor */
let _editingPlId = null;

window.SNXRadioStudio._openPlaylistEditor = function(plId) {
  _editingPlId = plId;
  const pl = _playlists[plId];
  if (!pl) return;

  const sec = document.getElementById('snxrsPlEditorSection');
  if (sec) sec.classList.remove('snxrs-hidden');

  const titleEl = document.getElementById('snxrsPlEditorTitle');
  if (titleEl) titleEl.textContent = `EDIT — ${pl.name || plId}`;

  const renameEl = document.getElementById('snxrsPlRenameInput');
  if (renameEl) renameEl.value = pl.name || '';

  _renderPlAddList();
  _renderPlTrackList();

  sec && sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function _renderPlAddList() {
  const listEl = document.getElementById('snxrsPlAddList');
  if (!listEl) return;
  const pl = _playlists[_editingPlId];
  const currentIds = (pl && pl.trackIds) ? pl.trackIds : [];

  const available = _tracks.filter(t => !currentIds.includes(t.id));
  if (!available.length) {
    listEl.innerHTML = '<div class="snxrs-empty" style="font-size:11px;">All tracks already in playlist</div>';
    return;
  }
  listEl.innerHTML = available.map(t => `
<div class="snxrs-track-row snxrs-track-row--compact" data-id="${_esc(t.id)}">
  <div class="snxrs-track-info">
    <span class="snxrs-track-title" style="font-size:12px;">${_esc(t.title || 'Untitled')}</span>
    <span class="snxrs-track-meta">${_esc(t.artist || '')} · ${_fmtDuration(t.duration)}</span>
  </div>
  <button class="snxrs-btn snxrs-btn--accent snxrs-btn--sm"
          onclick="SNXRadioStudio._plAdd('${_esc(t.id)}')">+ ADD</button>
</div>`).join('');
}

function _renderPlTrackList() {
  const listEl = document.getElementById('snxrsPlTrackList');
  if (!listEl) return;
  const pl = _playlists[_editingPlId];
  const ids = (pl && pl.trackIds) ? pl.trackIds : [];

  if (!ids.length) {
    listEl.innerHTML = '<div class="snxrs-empty" style="font-size:11px;">No tracks in playlist yet</div>';
    return;
  }

  const totalDur = ids.reduce((s, id) => {
    const t = _tracks.find(x => x.id === id);
    return s + (t ? (t.duration || 0) : 0);
  }, 0);

  listEl.innerHTML = ids.map((tid, idx) => {
    const t = _tracks.find(x => x.id === tid);
    const title  = t ? _esc(t.title || 'Unknown') : `<em>${_esc(tid)}</em>`;
    const artist = t ? _esc(t.artist || '') : '';
    const dur    = t ? _fmtDuration(t.duration) : '';
    const disabledBadge = (t && t.enabled === false)
      ? '<span class="snxrs-badge snxrs-badge--grey" style="font-size:9px;">DISABLED</span>' : '';
    return `
<div class="snxrs-track-row snxrs-pl-row" data-id="${_esc(tid)}" data-idx="${idx}">
  <span class="snxrs-pl-num">${idx + 1}</span>
  <div class="snxrs-track-info">
    <div class="snxrs-track-title" style="font-size:12px;">${title} ${disabledBadge}</div>
    <div class="snxrs-track-meta">${artist}${dur ? ' · ' + dur : ''}</div>
  </div>
  <div class="snxrs-track-actions">
    ${idx > 0 ? `<button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" onclick="SNXRadioStudio._plMove('${_esc(tid)}',${idx},-1)">▲</button>` : ''}
    ${idx < ids.length - 1 ? `<button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" onclick="SNXRadioStudio._plMove('${_esc(tid)}',${idx},1)">▼</button>` : ''}
    <button class="snxrs-btn snxrs-btn--red snxrs-btn--sm"
            onclick="SNXRadioStudio._plRemove('${_esc(tid)}')">✕</button>
  </div>
</div>`;
  }).join('') + `<div class="snxrs-pl-footer">${ids.length} track${ids.length !== 1 ? 's' : ''} · ${_fmtDuration(totalDur)}</div>`;
}

window.SNXRadioStudio._plAdd = async function(trackId) {
  const pl = _playlists[_editingPlId];
  if (!pl) return;
  const msgEl = document.getElementById('snxrsPlEditorMsg');

  // Verify the track's audioUrl is valid before adding
  const track = _tracks.find(t => t.id === trackId);
  if (!track || !track.audioUrl) {
    _setMsg(msgEl, '✗ Track has no audio URL', 'error'); return;
  }
  _setMsg(msgEl, 'Verifying…', '');
  try { await _verifyAudioUrl(track.audioUrl, track.duration || 0); }
  catch (e) { _setMsg(msgEl, '✗ Verification failed: ' + e.message, 'error'); return; }

  const ids = [...(pl.trackIds || [])];
  if (ids.includes(trackId)) { _setMsg(msgEl, '⚠ Already in playlist', ''); return; }
  ids.push(trackId);

  try {
    await _updatePlaylistDoc(_editingPlId, { trackIds: ids });
    _setMsg(msgEl, `✓ Added — ${ids.length} tracks`, 'ok');
    _renderPlAddList();
    _renderPlTrackList();
  } catch (e) { _setMsg(msgEl, '✗ ' + e.message, 'error'); }
};

window.SNXRadioStudio._plMove = async function(trackId, idx, dir) {
  const pl = _playlists[_editingPlId];
  if (!pl) return;
  const ids = [...(pl.trackIds || [])];
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= ids.length) return;
  [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
  const msgEl = document.getElementById('snxrsPlEditorMsg');
  try {
    await _updatePlaylistDoc(_editingPlId, { trackIds: ids });
    _renderPlTrackList();
  } catch (e) { _setMsg(msgEl, '✗ Reorder failed: ' + e.message, 'error'); }
};

window.SNXRadioStudio._plRemove = async function(trackId) {
  const pl = _playlists[_editingPlId];
  if (!pl) return;
  const ids   = (pl.trackIds || []).filter(id => id !== trackId);
  const msgEl = document.getElementById('snxrsPlEditorMsg');
  try {
    await _updatePlaylistDoc(_editingPlId, { trackIds: ids });
    _setMsg(msgEl, `Track removed — ${ids.length} remaining`, '');
    _renderPlAddList();
    _renderPlTrackList();
  } catch (e) { _setMsg(msgEl, '✗ ' + e.message, 'error'); }
};

async function _onRenamePlaylist() {
  if (!_editingPlId) return;
  const nameEl = document.getElementById('snxrsPlRenameInput');
  const msgEl  = document.getElementById('snxrsPlEditorMsg');
  const name   = (nameEl ? nameEl.value : '').trim();
  if (!name) { _setMsg(msgEl, 'Enter a name', 'error'); return; }
  try {
    await _updatePlaylistDoc(_editingPlId, { name });
    const titleEl = document.getElementById('snxrsPlEditorTitle');
    if (titleEl) titleEl.textContent = `EDIT — ${name}`;
    _setMsg(msgEl, '✓ Renamed', 'ok');
    await _loadPlaylists();
  } catch (e) { _setMsg(msgEl, '✗ ' + e.message, 'error'); }
}

window.SNXRadioStudio._togglePlaylist = async function(plId, currentEnabled) {
  try {
    await _updatePlaylistDoc(plId, { enabled: !currentEnabled });
    _loadPlaylists();
  } catch (e) { alert('Error: ' + e.message); }
};

window.SNXRadioStudio._deletePlaylist = async function(plId, name) {
  if (!confirm(`Delete playlist "${name}"?\n\nThis does NOT delete the audio tracks.\n\nAre you sure?`)) return;
  try {
    if (window.SNXRadio && window.SNXRadio.playlistDelete) {
      await window.SNXRadio.playlistDelete(plId);
    } else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      if (mods && mods.doc && mods.deleteDoc) await mods.deleteDoc(mods.doc(db, COL_PLAYLISTS, plId));
      else if (db && db.collection) await db.collection(COL_PLAYLISTS).doc(plId).delete();
    }
    if (_editingPlId === plId) {
      _editingPlId = null;
      const sec = document.getElementById('snxrsPlEditorSection');
      if (sec) sec.classList.add('snxrs-hidden');
    }
    _loadPlaylists();
  } catch (e) { alert('Delete failed: ' + e.message); }
};

async function _updatePlaylistDoc(plId, fields) {
  // Update local cache
  if (_playlists[plId]) Object.assign(_playlists[plId], fields);
  else _playlists[plId] = { id: plId, ...fields };

  if (window.SNXRadio && window.SNXRadio.playlistUpdate) {
    await window.SNXRadio.playlistUpdate(plId, fields);
    return;
  }
  const db = _getFirestore(), mods = _getFirestoreMods();
  const ts = mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date();
  const payload = { ...fields, updatedAt: ts };
  if (mods && mods.doc && mods.setDoc) {
    await mods.setDoc(mods.doc(db, COL_PLAYLISTS, plId), payload, { merge: true });
  } else if (db && db.collection) {
    await db.collection(COL_PLAYLISTS).doc(plId).set(payload, { merge: true });
  }
}

/* ══════════════════════════════════════════════════════════════
   PROGRAMS — load + render
══════════════════════════════════════════════════════════════ */

function _loadPrograms() {
  if (_unsubPrograms) return;

  const db   = _getFirestore();
  const mods = _getFirestoreMods();
  if (!db || !mods) return;

  const listEl = document.getElementById('snxrsProgramsList');
  if (listEl) listEl.innerHTML = '<p class="snxrs-empty">Loading…</p>';

  try {
    if (mods.collection && mods.onSnapshot) {
      const colRef = mods.collection(db, COL_PROGRAMS);
      _unsubPrograms = mods.onSnapshot(colRef, (snap) => {
        let docs = [];
        snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
        _programs = {};
        docs.forEach(d => { _programs[d.id] = d; });
        const el = document.getElementById('snxrsProgramsList');
        if (el) _renderProgramsList(el, docs);
        _populatePlaylistSelects();
        _populateProgramSelects();
      }, (err) => {
        console.error('[SNX-STUDIO] programs snapshot error:', err.message);
        _unsubPrograms = null;
      });
    } else if (db.collection) {
      db.collection(COL_PROGRAMS).get()
        .then(snap => {
          let docs = [];
          snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
          _programs = {};
          docs.forEach(d => { _programs[d.id] = d; });
          const el = document.getElementById('snxrsProgramsList');
          if (el) _renderProgramsList(el, docs);
          _populatePlaylistSelects();
          _populateProgramSelects();
        })
        .catch(e => { if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`; });
    }
  } catch (e) {
    if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`;
  }
}

function _renderProgramsList(listEl, docs) {
  if (!docs.length) {
    listEl.innerHTML = '<p class="snxrs-empty">No programs yet.</p>';
    return;
  }
  listEl.innerHTML = docs.map(prog => {
    const pl     = prog.playlistId ? (_playlists[prog.playlistId] || { name: prog.playlistId }) : null;
    const plName = pl ? _esc(pl.name || pl.id) : '(none)';
    const enStr  = prog.enabled !== false ? 'ENABLED' : 'DISABLED';
    const enCls  = prog.enabled !== false ? 'snxrs-badge--green' : 'snxrs-badge--grey';
    return `
<div class="snxrs-track-row" data-id="${_esc(prog.id)}">
  ${prog.artwork ? `<img class="snxrs-track-art" src="${_esc(prog.artwork)}" alt="" />` : '<div class="snxrs-track-art snxrs-track-art--placeholder">📻</div>'}
  <div class="snxrs-track-info">
    <div class="snxrs-track-title">${_esc(prog.name || prog.id)}</div>
    <div class="snxrs-track-meta">Playlist: ${plName}</div>
  </div>
  <div class="snxrs-track-actions">
    <span class="snxrs-badge ${enCls}">${enStr}</span>
    <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm"
            onclick="SNXRadioStudio._toggleProgram('${_esc(prog.id)}', ${prog.enabled !== false})">
      ${prog.enabled !== false ? 'DISABLE' : 'ENABLE'}
    </button>
    <button class="snxrs-btn snxrs-btn--red snxrs-btn--sm"
            onclick="SNXRadioStudio._deleteProgram('${_esc(prog.id)}', '${_esc(prog.name || '')}')">
      🗑
    </button>
  </div>
</div>`;
  }).join('');
}

async function _onCreateProgram() {
  const nameEl    = document.getElementById('snxrsProgName');
  const plEl      = document.getElementById('snxrsProgPlaylist');
  const artEl     = document.getElementById('snxrsProgArtwork');
  const msgEl     = document.getElementById('snxrsCreateProgMsg');
  const name      = (nameEl ? nameEl.value : '').trim();
  const plId      = plEl ? plEl.value : '';
  const artwork   = artEl ? artEl.value.trim() : '';

  if (!name) { _setMsg(msgEl, 'Program name is required', 'error'); return; }
  _setMsg(msgEl, 'Creating…', '');

  try {
    const data = { name, playlistId: plId || null, artwork: artwork || null, enabled: true };
    if (window.SNXRadio && window.SNXRadio.programCreate) {
      await window.SNXRadio.programCreate(data);
    } else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      const ts = mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date();
      const doc = { ...data, createdAt: ts, updatedAt: ts };
      if (mods && mods.collection && mods.addDoc) await mods.addDoc(mods.collection(db, COL_PROGRAMS), doc);
      else if (db && db.collection) await db.collection(COL_PROGRAMS).add(doc);
    }
    if (nameEl) nameEl.value = '';
    if (artEl)  artEl.value  = '';
    _setMsg(msgEl, `✓ Program "${name}" created`, 'ok');
    await _loadPrograms();
  } catch (e) { _setMsg(msgEl, '✗ ' + e.message, 'error'); }
}

window.SNXRadioStudio._toggleProgram = async function(progId, currentEnabled) {
  try {
    const db = _getFirestore(), mods = _getFirestoreMods();
    const fields = { enabled: !currentEnabled };
    if (window.SNXRadio && window.SNXRadio.programUpdate) await window.SNXRadio.programUpdate(progId, fields);
    else if (mods && mods.doc && mods.setDoc)
      await mods.setDoc(mods.doc(db, COL_PROGRAMS, progId), fields, { merge: true });
    else if (db && db.collection)
      await db.collection(COL_PROGRAMS).doc(progId).set(fields, { merge: true });
    _loadPrograms();
  } catch (e) { alert('Error: ' + e.message); }
};

window.SNXRadioStudio._deleteProgram = async function(progId, name) {
  if (!confirm(`Delete program "${name}"?\n\nSchedule slots referencing this program will show "—".\n\nAre you sure?`)) return;
  try {
    if (window.SNXRadio && window.SNXRadio.programDelete) await window.SNXRadio.programDelete(progId);
    else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      if (mods && mods.doc && mods.deleteDoc) await mods.deleteDoc(mods.doc(db, COL_PROGRAMS, progId));
      else if (db && db.collection) await db.collection(COL_PROGRAMS).doc(progId).delete();
    }
    _loadPrograms();
  } catch (e) { alert('Delete failed: ' + e.message); }
};

/* ══════════════════════════════════════════════════════════════
   SCHEDULE — load + render
══════════════════════════════════════════════════════════════ */

function _loadSchedule() {
  if (_unsubSchedule) return;

  const db   = _getFirestore();
  const mods = _getFirestoreMods();
  if (!db || !mods) return;

  const listEl = document.getElementById('snxrsScheduleList');
  if (listEl) listEl.innerHTML = '<p class="snxrs-empty">Loading…</p>';

  try {
    if (mods.collection && mods.onSnapshot && mods.query && mods.orderBy) {
      const q = mods.query(mods.collection(db, COL_SCHEDULE), mods.orderBy('order', 'asc'));
      _unsubSchedule = mods.onSnapshot(q, (snap) => {
        let docs = [];
        snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
        _schedule = docs.map(d => ({ slotId: d.id, ...d }));
        const el = document.getElementById('snxrsScheduleList');
        if (el) _renderScheduleList(el, docs);
      }, (err) => {
        console.error('[SNX-STUDIO] schedule snapshot error:', err.message);
        _unsubSchedule = null;
      });
    } else if (db.collection) {
      db.collection(COL_SCHEDULE).orderBy('order', 'asc').get()
        .then(snap => {
          let docs = [];
          snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
          _schedule = docs.map(d => ({ slotId: d.id, ...d }));
          const el = document.getElementById('snxrsScheduleList');
          if (el) _renderScheduleList(el, docs);
        })
        .catch(e => { if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`; });
    }
  } catch (e) {
    if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`;
  }
}

function _renderScheduleList(listEl, docs) {
  if (!docs.length) {
    listEl.innerHTML = '<p class="snxrs-empty">No schedule slots. Add one above.</p>';
    return;
  }

  // Sort by startMinutes
  const sorted = docs
    .map(d => ({ ...d, startMin: (Number(d.hour) || 0) * 60 + (Number(d.minute) || 0) }))
    .sort((a, b) => a.startMin - b.startMin);

  listEl.innerHTML = sorted.map(slot => {
    const prog  = slot.programId ? (_programs[slot.programId] || { name: slot.programId }) : null;
    const label = slot.label || (prog ? prog.name : '—');
    const hh    = String(slot.hour   || 0).padStart(2, '0');
    const mm    = String(slot.minute || 0).padStart(2, '0');
    const enStr = slot.enabled !== false ? 'ON' : 'OFF';
    const enCls = slot.enabled !== false ? 'snxrs-badge--green' : 'snxrs-badge--grey';
    return `
<div class="snxrs-track-row snxrs-sched-row" data-id="${_esc(slot.id)}">
  <span class="snxrs-sched-time">${hh}:${mm}</span>
  <div class="snxrs-track-info">
    <div class="snxrs-track-title">${_esc(label)}</div>
    <div class="snxrs-track-meta">${prog ? _esc(prog.name || prog.id) : '(no program)'}</div>
  </div>
  <div class="snxrs-track-actions">
    <span class="snxrs-badge ${enCls}">${enStr}</span>
    <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm"
            onclick="SNXRadioStudio._toggleSlot('${_esc(slot.id)}', ${slot.enabled !== false})">
      ${slot.enabled !== false ? 'DISABLE' : 'ENABLE'}
    </button>
    <button class="snxrs-btn snxrs-btn--red snxrs-btn--sm"
            onclick="SNXRadioStudio._deleteSlot('${_esc(slot.id)}')">
      🗑
    </button>
  </div>
</div>`;
  }).join('');
}

async function _onAddSlot() {
  const hourEl  = document.getElementById('snxrsSlotHour');
  const minEl   = document.getElementById('snxrsSlotMin');
  const labelEl = document.getElementById('snxrsSlotLabel');
  const progEl  = document.getElementById('snxrsSlotProgram');
  const msgEl   = document.getElementById('snxrsSlotMsg');

  const hour    = parseInt(hourEl ? hourEl.value : 0, 10);
  const minute  = parseInt(minEl  ? minEl.value  : 0, 10);
  const label   = (labelEl ? labelEl.value : '').trim();
  const progId  = progEl ? progEl.value : '';

  if (isNaN(hour) || hour < 0 || hour > 23) { _setMsg(msgEl, 'Hour must be 0–23', 'error'); return; }
  if (isNaN(minute) || minute < 0 || minute > 59) { _setMsg(msgEl, 'Minute must be 0–59', 'error'); return; }

  _setMsg(msgEl, 'Adding slot…', '');

  try {
    const order = (hour * 60 + minute);
    const data = { hour, minute, label, programId: progId || null, enabled: true, order };
    if (window.SNXRadio && window.SNXRadio.scheduleSlotCreate) {
      await window.SNXRadio.scheduleSlotCreate(data);
    } else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      const ts = mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date();
      const doc = { ...data, createdAt: ts, updatedAt: ts };
      if (mods && mods.collection && mods.addDoc) await mods.addDoc(mods.collection(db, COL_SCHEDULE), doc);
      else if (db && db.collection) await db.collection(COL_SCHEDULE).add(doc);
    }
    const timeStr = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;
    _setMsg(msgEl, `✓ Slot added at ${timeStr} UTC`, 'ok');
    if (labelEl) labelEl.value = '';
    await _loadSchedule();
  } catch (e) { _setMsg(msgEl, '✗ ' + e.message, 'error'); }
}

window.SNXRadioStudio._toggleSlot = async function(slotId, currentEnabled) {
  try {
    const fields = { enabled: !currentEnabled };
    if (window.SNXRadio && window.SNXRadio.scheduleSlotUpdate) await window.SNXRadio.scheduleSlotUpdate(slotId, fields);
    else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      if (mods && mods.doc && mods.setDoc)
        await mods.setDoc(mods.doc(db, COL_SCHEDULE, slotId), fields, { merge: true });
      else if (db && db.collection)
        await db.collection(COL_SCHEDULE).doc(slotId).set(fields, { merge: true });
    }
    _loadSchedule();
  } catch (e) { alert('Error: ' + e.message); }
};

window.SNXRadioStudio._deleteSlot = async function(slotId) {
  if (!confirm('Delete this schedule slot?')) return;
  try {
    if (window.SNXRadio && window.SNXRadio.scheduleSlotDelete) await window.SNXRadio.scheduleSlotDelete(slotId);
    else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      if (mods && mods.doc && mods.deleteDoc) await mods.deleteDoc(mods.doc(db, COL_SCHEDULE, slotId));
      else if (db && db.collection) await db.collection(COL_SCHEDULE).doc(slotId).delete();
    }
    _loadSchedule();
  } catch (e) { alert('Delete failed: ' + e.message); }
};

/* ══════════════════════════════════════════════════════════════
   SONG REQUESTS — load, render, approve, reject
   /radioRequests/{requestId}
     trackId, trackTitle, trackArtist,
     requestedByUid, requestedByUsername,
     requestCount, requesterUids,
     lastRequestedByUsername, lastRequestedByUid, lastRequestedAt,
     requestedAt, status
══════════════════════════════════════════════════════════════ */

let _requests        = [];   // cached request docs
let _requestsFilter  = 'pending';  // pending | approved | rejected | all

function _loadRequests() {
  if (_unsubRequests) return;

  const db   = _getFirestore();
  const mods = _getFirestoreMods();
  if (!db || !mods) return;

  const listEl = document.getElementById('snxrsRequestsList');
  if (listEl) listEl.innerHTML = '<p class="snxrs-empty">Loading…</p>';

  try {
    if (mods.collection && mods.onSnapshot && mods.query && mods.orderBy) {
      const q = mods.query(
        mods.collection(db, COL_REQUESTS),
        mods.orderBy('requestedAt', 'desc')
      );
      _unsubRequests = mods.onSnapshot(q, (snap) => {
        let docs = [];
        snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
        _requests = docs;
        _renderRequests();
      }, (err) => {
        console.error('[SNX-STUDIO] requests snapshot error:', err.message);
        _unsubRequests = null;
      });
    } else if (db.collection) {
      db.collection(COL_REQUESTS).orderBy('requestedAt', 'desc').get()
        .then(snap => {
          let docs = [];
          snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
          _requests = docs;
          _renderRequests();
        })
        .catch(e => {
          console.error('[SNX-STUDIO] loadRequests error:', e.message);
          if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`;
        });
    }
  } catch (e) {
    if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-empty--error">Error: ${_esc(e.message)}</p>`;
    console.error('[SNX-STUDIO] loadRequests error:', e.message);
  }
}

function _renderRequests() {
  const listEl = document.getElementById('snxrsRequestsList');
  if (!listEl) return;

  // Read active filter from the filter buttons
  const activeBtn = _container
    ? _container.querySelector('.snxrs-rq-filter--active')
    : null;
  _requestsFilter = activeBtn ? (activeBtn.dataset.filter || 'pending') : _requestsFilter;

  const filtered = _requestsFilter === 'all'
    ? _requests.slice()
    : _requests.filter(r => r.status === _requestsFilter);

  if (!_requests.length) {
    listEl.innerHTML = '<p class="snxrs-empty">No song requests yet.</p>';
    return;
  }
  if (!filtered.length) {
    listEl.innerHTML = `<p class="snxrs-empty">No ${_requestsFilter} requests.</p>`;
    return;
  }

  listEl.innerHTML = filtered.map(r => {
    const count    = r.requestCount || 1;
    const username = r.requestedByUsername || r.lastRequestedByUsername || 'Listener';
    const when     = r.requestedAt
      ? new Date(r.requestedAt.seconds ? r.requestedAt.seconds * 1000 : r.requestedAt).toLocaleString()
      : '—';
    const statusBadgeMap = {
      pending:  'snxrs-badge--yellow',
      approved: 'snxrs-badge--green',
      rejected: 'snxrs-badge--grey',
    };
    const badgeCls  = statusBadgeMap[r.status] || 'snxrs-badge--grey';
    const statusLbl = (r.status || 'pending').toUpperCase();
    const isPending = r.status === 'pending' || !r.status;

    return `
<div class="snxrs-track-row" data-id="${_esc(r.id)}" style="flex-wrap:wrap;gap:6px;">
  <div class="snxrs-track-info" style="min-width:0;flex:1;">
    <div class="snxrs-track-title">
      ${count > 1 ? `<span style="color:#f59e0b;font-size:12px;margin-right:4px;">🔥 ${count} REQUESTS</span>` : ''}
      ${_esc(r.trackTitle || 'Unknown')}
    </div>
    <div class="snxrs-track-artist">${_esc(r.trackArtist || '')}</div>
    <div class="snxrs-track-meta">Requested by ${_esc(username)} · ${_esc(when)}</div>
  </div>
  <div class="snxrs-track-actions" style="align-items:center;">
    <span class="snxrs-badge ${badgeCls}">${statusLbl}</span>
    ${isPending ? `
      <button class="snxrs-btn snxrs-btn--green snxrs-btn--sm"
              onclick="SNXRadioStudio._approveRequest('${_esc(r.id)}')">APPROVE</button>
      <button class="snxrs-btn snxrs-btn--red snxrs-btn--sm"
              onclick="SNXRadioStudio._rejectRequest('${_esc(r.id)}')">REJECT</button>
    ` : ''}
  </div>
</div>`;
  }).join('');
}

window.SNXRadioStudio._approveRequest = async function(requestId) {
  const msgEl = document.getElementById('snxrsRequestsMsg');
  try {
    const db = _getFirestore(), mods = _getFirestoreMods();
    const fields = { status: 'approved' };
    if (mods && mods.doc && mods.updateDoc)
      await mods.updateDoc(mods.doc(db, COL_REQUESTS, requestId), fields);
    else if (db && db.collection)
      await db.collection(COL_REQUESTS).doc(requestId).update(fields);

    _setMsg(msgEl, '✓ Request approved — queued for future playback', 'ok');
    await _loadRequests();
  } catch (e) {
    _setMsg(document.getElementById('snxrsRequestsMsg'), '✗ ' + e.message, 'error');
    console.error('[SNX-STUDIO] approveRequest error:', e.message);
  }
};

window.SNXRadioStudio._rejectRequest = async function(requestId) {
  const msgEl = document.getElementById('snxrsRequestsMsg');
  try {
    const db = _getFirestore(), mods = _getFirestoreMods();
    const fields = { status: 'rejected' };
    if (mods && mods.doc && mods.updateDoc)
      await mods.updateDoc(mods.doc(db, COL_REQUESTS, requestId), fields);
    else if (db && db.collection)
      await db.collection(COL_REQUESTS).doc(requestId).update(fields);

    _setMsg(msgEl, '✓ Request rejected', 'ok');
    await _loadRequests();
  } catch (e) {
    _setMsg(document.getElementById('snxrsRequestsMsg'), '✗ ' + e.message, 'error');
    console.error('[SNX-STUDIO] rejectRequest error:', e.message);
  }
};

/* ══════════════════════════════════════════════════════════════
   SETTINGS — load + save
══════════════════════════════════════════════════════════════ */

async function _loadSettings() {
  try {
    const db   = _getFirestore();
    const mods = _getFirestoreMods();
    let   data = null;

    if (mods && mods.doc && mods.getDoc) {
      const snap = await mods.getDoc(mods.doc(db, COL_SITE, DOC_SETTINGS));
      if (snap.exists()) data = snap.data();
    } else if (db && db.collection) {
      const snap = await db.collection(COL_SITE).doc(DOC_SETTINGS).get();
      if (snap.exists) data = snap.data();
    }

    if (data) {
      const n = document.getElementById('snxrsSetName');
      const t = document.getElementById('snxrsSetTagline');
      const a = document.getElementById('snxrsSetArtwork');
      if (n) n.value = data.stationName || '';
      if (t) t.value = data.tagline     || '';
      if (a) a.value = data.defaultArtwork || '';
    }
  } catch (e) {
    console.warn('[SNX-STUDIO] loadSettings error:', e.message);
  }
}

async function _onSaveSettings() {
  const nameEl = document.getElementById('snxrsSetName');
  const tagEl  = document.getElementById('snxrsSetTagline');
  const artEl  = document.getElementById('snxrsSetArtwork');
  const msgEl  = document.getElementById('snxrsSettingsMsg');

  const fields = {
    stationName:    (nameEl ? nameEl.value : '').trim() || 'Shadow Nexus Radio',
    tagline:        (tagEl  ? tagEl.value  : '').trim() || '24/7 Music · Live Events · Shadow Nexus',
    defaultArtwork: (artEl  ? artEl.value  : '').trim() || null,
  };

  _setMsg(msgEl, 'Saving…', '');
  try {
    if (window.SNXRadio && window.SNXRadio.settingsUpdate) {
      await window.SNXRadio.settingsUpdate(fields);
    } else {
      const db = _getFirestore(), mods = _getFirestoreMods();
      const ts = mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date();
      const payload = { ...fields, updatedAt: ts };
      if (mods && mods.doc && mods.setDoc)
        await mods.setDoc(mods.doc(db, COL_SITE, DOC_SETTINGS), payload, { merge: true });
      else if (db && db.collection)
        await db.collection(COL_SITE).doc(DOC_SETTINGS).set(payload, { merge: true });
    }
    _setMsg(msgEl, '✓ Settings saved', 'ok');
  } catch (e) { _setMsg(msgEl, '✗ ' + e.message, 'error'); }
}

/* ══════════════════════════════════════════════════════════════
   HELPER — populate <select> with playlists / programs
══════════════════════════════════════════════════════════════ */

function _populatePlaylistSelects() {
  const selects = ['snxrsProgPlaylist'];
  const pls = Object.values(_playlists);
  selects.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = '<option value="">— None —</option>';
    pls.forEach(pl => {
      const opt = document.createElement('option');
      opt.value = pl.id;
      opt.textContent = pl.name || pl.id;
      if (pl.id === current) opt.selected = true;
      el.appendChild(opt);
    });
  });
}

function _populateProgramSelects() {
  const selects = ['snxrsSlotProgram'];
  const progs = Object.values(_programs);
  selects.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    el.innerHTML = '<option value="">— None —</option>';
    progs.forEach(prog => {
      const opt = document.createElement('option');
      opt.value = prog.id;
      opt.textContent = prog.name || prog.id;
      if (prog.id === current) opt.selected = true;
      el.appendChild(opt);
    });
  });
}

/* ══════════════════════════════════════════════════════════════
   UPLOAD UI HELPERS
══════════════════════════════════════════════════════════════ */

function _setUploadUI(uploading) {
  const btn      = document.getElementById('snxrsUploadBtn');
  const progress = document.getElementById('snxrsUploadProgress');
  if (btn)      { btn.disabled = uploading; btn.textContent = uploading ? 'Uploading…' : '⬆ UPLOAD TRACK'; }
  if (progress) { progress.style.display = uploading ? '' : 'none'; }
  if (!uploading) _setProgress(0, '');
}

function _setProgress(pct, status) {
  const fill    = document.getElementById('snxrsProgressFill');
  const statusEl = document.getElementById('snxrsUploadStatus');
  if (fill)    fill.style.width = Math.min(100, pct) + '%';
  if (statusEl) statusEl.textContent = status || '';
}

function _clearUploadForm() {
  ['snxrsTitle', 'snxrsArtist'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['snxrsAudioFile', 'snxrsArtworkFile'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['snxrsAudioPreview', 'snxrsArtworkPreview'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = ''; el.dataset.duration = ''; }
  });
}

/* ══════════════════════════════════════════════════════════════
   SHARED HELPERS
══════════════════════════════════════════════════════════════ */

function _setMsg(el, text, type) {
  if (!el) return;
  el.textContent = text || '';
  el.className = 'snxrs-msg' + (type === 'error' ? ' snxrs-msg--error' : type === 'ok' ? ' snxrs-msg--ok' : '');
}

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _fmtDuration(sec) {
  if (!sec || !isFinite(sec) || sec <= 0) return '–';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

function _randHex() { return Math.random().toString(16).slice(2, 10); }

function _getFirestore() {
  // window._snxFirestore is the modular bundle { db, collection, ... }; extract .db
  if (window._snxFirestore && window._snxFirestore.db) return window._snxFirestore.db;
  // compat SDK fallback
  return (window.firebase && window.firebase.firestore && window.firebase.firestore()) || null;
}

function _getFirestoreMods() {
  // window._snxFirestore already contains all modular functions; use it as mods
  return window._snxFirestore || window._snxFirestoreModules || null;
}

async function _getIdToken() {
  const auth = window._snxAuth || (window.firebase && window.firebase.auth && window.firebase.auth());
  if (!auth) return null;
  const user = window._snxCurrentUser || (auth.currentUser);
  if (!user) return null;
  try { return await user.getIdToken(false); } catch (_) { return null; }
}

function _getCurrentUid() {
  const auth = window._snxAuth || (window.firebase && window.firebase.auth && window.firebase.auth());
  if (!auth) return null;
  const user = window._snxCurrentUser || (auth.currentUser);
  return user ? user.uid : null;
}

/* ══════════════════════════════════════════════════════════════
   BROADCAST — DESTINATION MANAGER (Stage 4A)
   All stream key handling goes through the Worker proxy.
   Keys are NEVER stored in this file, NEVER in localStorage,
   NEVER logged in full.
══════════════════════════════════════════════════════════════ */

let _bcDestinations = [];    // cached list (keys already masked by Worker)
let _bcEditingId    = null;  // destId being edited, or null

async function _loadBroadcastDestinations() {
  const listEl = document.getElementById('snxrsBcList');
  if (listEl) listEl.innerHTML = '<p class="snxrs-empty">Loading…</p>';

  if (!window.SNXBroadcastEngine) {
    if (listEl) listEl.innerHTML = '<p class="snxrs-empty snxrs-msg--error">Broadcast Engine not loaded (snx-broadcast-engine.js)</p>';
    return;
  }

  try {
    _bcDestinations = await window.SNXBroadcastEngine.listDestinations();
    _renderBroadcastList(listEl);
  } catch (e) {
    if (listEl) listEl.innerHTML = `<p class="snxrs-empty snxrs-msg--error">✗ ${_esc(e.message)}</p>`;
  }
}

function _renderBroadcastList(listEl) {
  if (!listEl) return;
  if (!_bcDestinations.length) {
    listEl.innerHTML = '<p class="snxrs-empty">No RTMP destinations yet. Add one above.</p>';
    return;
  }

  listEl.innerHTML = _bcDestinations.map(d => `
    <div class="snxrs-lib-item" style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid #1e2533;">
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;color:${d.enabled ? '#e8eaf6' : '#57606a'};">${_esc(d.name)}</div>
        <div style="font-size:11px;color:#7c8cad;word-break:break-all;">${_esc(d.serverUrl)}</div>
        <div style="font-size:11px;color:#57606a;">Key: ${_esc(d.streamKeyMasked || '****')}</div>
      </div>
      <span style="font-size:10px;padding:2px 6px;border-radius:10px;background:${d.enabled ? '#14532d' : '#374151'};color:${d.enabled ? '#4ade80' : '#9ca3af'};">${d.enabled ? 'ENABLED' : 'DISABLED'}</span>
      <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" onclick="window.SNXRadioStudio._bcEdit(${JSON.stringify(d._id)})">EDIT</button>
      <button class="snxrs-btn snxrs-btn--ghost snxrs-btn--sm" style="color:#ef4444;" onclick="window.SNXRadioStudio._bcDelete(${JSON.stringify(d._id)}, ${JSON.stringify(d.name)})">DEL</button>
    </div>
  `).join('');
}

async function _onBroadcastSave() {
  const $ = id => document.getElementById(id);
  const msg = $('snxrsBcFormMsg');
  const name      = ($('snxrsBcName').value || '').trim();
  const serverUrl = ($('snxrsBcUrl').value  || '').trim();
  const streamKey = ($('snxrsBcKey').value  || '').trim();
  const enabled   = $('snxrsBcEnabled').checked;
  const editId    = _bcEditingId;

  if (!name)      { _setMsg(msg, '✗ Destination name is required', 'error'); return; }
  if (!serverUrl) { _setMsg(msg, '✗ Server URL is required', 'error'); return; }
  if (!/^rtmps?:\/\//i.test(serverUrl)) { _setMsg(msg, '✗ URL must start with rtmp:// or rtmps://', 'error'); return; }
  if (!editId && !streamKey) { _setMsg(msg, '✗ Stream key is required for new destinations', 'error'); return; }

  if (!window.SNXBroadcastEngine) { _setMsg(msg, '✗ Broadcast Engine not loaded', 'error'); return; }

  _setMsg(msg, 'Saving…', '');
  try {
    if (editId) {
      // Update — only include streamKey if a new one was entered
      const fields = { name, serverUrl, enabled };
      if (streamKey) fields.streamKey = streamKey;
      await window.SNXBroadcastEngine.updateDestination(editId, fields);
      _setMsg(msg, '✓ Destination updated', 'ok');
    } else {
      await window.SNXBroadcastEngine.saveDestination({ name, serverUrl, streamKey, enabled });
      _setMsg(msg, '✓ Destination saved', 'ok');
    }
    _onBroadcastCancelEdit();
    await _loadBroadcastDestinations();
  } catch (e) {
    _setMsg(msg, '✗ ' + e.message, 'error');
  }
}

window.SNXRadioStudio._bcEdit = function(destId) {
  const dest = _bcDestinations.find(d => d._id === destId);
  if (!dest) return;

  _bcEditingId = destId;
  const $ = id => document.getElementById(id);
  $('snxrsBcFormTitle').textContent  = 'EDIT DESTINATION';
  $('snxrsBcName').value             = dest.name    || '';
  $('snxrsBcUrl').value              = dest.serverUrl || '';
  $('snxrsBcKey').value              = '';          // never pre-fill — key is secret
  $('snxrsBcKey').placeholder        = 'Leave blank to keep existing key';
  $('snxrsBcEnabled').checked        = dest.enabled !== false;
  $('snxrsBcCancelEditBtn').classList.remove('snxrs-hidden');
  $('snxrsBcSaveBtn').textContent    = '💾 UPDATE';
  $('snxrsBcFormMsg').textContent    = '';

  // Scroll the form into view
  const form = $('snxrsBcFormTitle');
  if (form) form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

function _onBroadcastCancelEdit() {
  _bcEditingId = null;
  const $ = id => document.getElementById(id);
  $('snxrsBcFormTitle').textContent  = 'ADD RTMP DESTINATION';
  $('snxrsBcName').value             = '';
  $('snxrsBcUrl').value              = '';
  $('snxrsBcKey').value              = '';
  $('snxrsBcKey').placeholder        = 'Enter stream key';
  $('snxrsBcEnabled').checked        = true;
  $('snxrsBcCancelEditBtn').classList.add('snxrs-hidden');
  $('snxrsBcSaveBtn').textContent    = '💾 SAVE';
  $('snxrsBcFormMsg').textContent    = '';
}

window.SNXRadioStudio._bcDelete = async function(destId, name) {
  if (!confirm(`Delete destination "${name}"?\n\nThis cannot be undone.`)) return;
  if (!window.SNXBroadcastEngine) { alert('Broadcast Engine not loaded'); return; }
  try {
    await window.SNXBroadcastEngine.deleteDestination(destId);
    await _loadBroadcastDestinations();
  } catch (e) {
    alert('Delete failed: ' + e.message);
  }
};

async function _onBroadcastStart() {
  const msg = document.getElementById('snxrsBcEngineMsg');
  const statusEl = document.getElementById('snxrsBcStatus');
  if (!window.SNXBroadcastEngine) { _setMsg(msg, '✗ Broadcast Engine not loaded', 'error'); return; }

  _setMsg(msg, 'Starting…', '');
  try {
    const status = await window.SNXBroadcastEngine.startBroadcast({ source: 'radio' });
    _setMsg(msg, `✓ Broadcast started — ${status.destinations} destination(s)`, 'ok');
    if (statusEl) statusEl.textContent = `Status: ACTIVE — ${status.destinations} destination(s)`;
  } catch (e) {
    _setMsg(msg, '✗ ' + e.message, 'error');
  }
}

async function _onBroadcastStop() {
  const msg = document.getElementById('snxrsBcEngineMsg');
  const statusEl = document.getElementById('snxrsBcStatus');
  if (!window.SNXBroadcastEngine) { _setMsg(msg, '✗ Broadcast Engine not loaded', 'error'); return; }

  try {
    await window.SNXBroadcastEngine.stopBroadcast();
    _setMsg(msg, '✓ Broadcast stopped', 'ok');
    if (statusEl) statusEl.textContent = 'Status: IDLE';
  } catch (e) {
    _setMsg(msg, '✗ ' + e.message, 'error');
  }
}

/* ══════════════════════════════════════════════════════════════
   STARTUP LOG
══════════════════════════════════════════════════════════════ */

console.log('[SNX-STUDIO] snx-radio-studio.js loaded — version', STUDIO_VERSION);

})(); // end IIFE
