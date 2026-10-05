/**
 * SHADOW NEXUS SOCIAL — TV Studio
 * snx-tv-studio.js
 *
 * OWNERSHIP: Shadow Nexus Social
 *
 * Management interface for SNS 24-Hour TV.
 * Sections: MEDIA · PLAYLISTS · PROGRAMMING · SCHEDULE · QUEUE · NOW PLAYING · CHANNEL SETTINGS
 *
 * All data uses SNS systems:
 *   Auth    → window._snxAuth (horr-a08f4)
 *   Storage → SNS Cloudflare R2 (yellow-term-11e6.nthntjrn.workers.dev)
 *   DB      → SNS Firestore (horr-a08f4) via snx-tv-core.js
 *
 * No Supabase. No external Engine. No service-account JSON.
 * No new KV namespace. No new Firebase project.
 */

import {
  TV_CHANNEL_ID, TV_ADVANCE_URL,
  subscribeTvState, loadTvState, loadTvConfig, saveTvConfig,
  subscribeTvMedia, loadTvMedia, addTvMedia, updateTvMedia, deleteTvMedia,
  subscribeTvPlaylists, loadTvPlaylists, createTvPlaylist, updateTvPlaylist, deleteTvPlaylist,
  subscribeTvPrograms, loadTvPrograms, createTvProgram, updateTvProgram, deleteTvProgram,
  subscribeTvSchedule, loadTvSchedule, saveTvSchedule, pushScheduleLive,
  startTv, stopTv, pauseTv, resumeTv, advanceTvNow, requestTvAdvance,
  importSnsMediaToTv, getTvUser, getTvIdToken,
  computeElapsed, fmtTime, esc,
  DEFAULT_TV_CONFIG, TV_PROGRAM_TYPES, TV_COMMERCIAL_FREQ,
} from './snx-tv-core.js';

/* ════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════ */
const FOUNDER_EMAIL    = 'christijerina46@gmail.com';
const UPLOAD_WORKER    = 'https://yellow-term-11e6.nthntjrn.workers.dev';

/* ════════════════════════════════════════════════════
   MODULE STATE
════════════════════════════════════════════════════ */
let _mounted       = false;
let _user          = null;
let _activeSection = 'media';

let _tvState       = null;
let _tvConfig      = null;
let _mediaLib      = [];
let _playlists     = [];
let _programs      = [];
let _schedule      = [];

let _stateUnsub    = null;
let _mediaUnsub    = null;
let _playlistUnsub = null;
let _programUnsub  = null;
let _schedUnsub    = null;

let _nowPlayingTimer = null;

/* ════════════════════════════════════════════════════
   ENTRY POINT
════════════════════════════════════════════════════ */

/**
 * Mount the TV Studio into the given container element.
 * @param {HTMLElement} container
 * @param {object|null} user  SNS Firebase Auth user
 */
export function mountTvStudio(container, user) {
  if (!container) return;
  _user = user;
  if (!_isFounder(user)) {
    container.innerHTML = `<div class="snx-tvs-gate">TV Studio is restricted to authorized users.</div>`;
    return;
  }
  _mounted = true;
  _render(container);
  _subscribeAll();
  window._snxTvStudio = { unmount: () => unmountTvStudio() };
}

/** Unmount the TV Studio and release all subscriptions. */
export function unmountTvStudio() {
  _mounted = false;
  _stateUnsub?.();    _stateUnsub    = null;
  _mediaUnsub?.();    _mediaUnsub    = null;
  _playlistUnsub?.(); _playlistUnsub = null;
  _programUnsub?.();  _programUnsub  = null;
  _schedUnsub?.();    _schedUnsub    = null;
  if (_nowPlayingTimer) { clearInterval(_nowPlayingTimer); _nowPlayingTimer = null; }
}

/* ════════════════════════════════════════════════════
   FOUNDER CHECK
════════════════════════════════════════════════════ */
function _isFounder(user) {
  return !!(user?.email?.trim().toLowerCase() === FOUNDER_EMAIL.toLowerCase());
}

/* ════════════════════════════════════════════════════
   SUBSCRIPTIONS
════════════════════════════════════════════════════ */
function _subscribeAll() {
  _stateUnsub    = subscribeTvState(st => { _tvState = st; _refreshNowPlaying(); _refreshScheduleQueue(); });
  _mediaUnsub    = subscribeTvMedia(items => { _mediaLib = items; _refreshMedia(); _refreshScheduleLib(); });
  _playlistUnsub = subscribeTvPlaylists(pl => { _playlists = pl; _refreshPlaylists(); });
  _programUnsub  = subscribeTvPrograms(pr => { _programs = pr; _refreshPrograms(); });
  _schedUnsub    = subscribeTvSchedule(sl => { _schedule = sl; });

  // Load config once
  loadTvConfig().then(cfg => { _tvConfig = cfg; _refreshChannelSettings(); }).catch(() => {});

  // Now Playing timer — updates elapsed display every second
  _nowPlayingTimer = setInterval(() => _refreshNowPlayingElapsed(), 1000);
}

/* ════════════════════════════════════════════════════
   SHELL RENDER
════════════════════════════════════════════════════ */
function _render(container) {
  container.innerHTML = `
    <div class="snx-tvs" id="snx-tvs-root">
      <div class="snx-tvs-header">
        <div class="snx-tvs-title">TV STUDIO</div>
        <div class="snx-tvs-sub">SHADOW NEXUS 24-HOUR TV · FOUNDER CONTROL</div>
      </div>

      <div class="snx-tvs-nav" role="tablist" aria-label="TV Studio sections">
        ${['media','playlists','programming','schedule','queue','now-playing','guide','settings'].map(s => `
          <button class="snx-tvs-nav-btn ${s === _activeSection ? 'active' : ''}"
                  data-section="${s}" role="tab"
                  aria-selected="${s === _activeSection ? 'true' : 'false'}">
            ${_sectionLabel(s)}
          </button>`).join('')}
      </div>

      <div class="snx-tvs-body" id="snx-tvs-body"></div>
    </div>`;

  container.querySelectorAll('.snx-tvs-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => _switchSection(btn.dataset.section));
  });

  _switchSection(_activeSection, true);
}

function _sectionLabel(s) {
  return { media: 'MEDIA', playlists: 'PLAYLISTS', programming: 'PROGRAMMING',
           schedule: 'SCHEDULE', queue: 'QUEUE', 'now-playing': 'NOW PLAYING',
           guide: 'TV GUIDE', settings: 'SETTINGS' }[s] || s.toUpperCase();
}

function _switchSection(section, force = false) {
  if (_activeSection === section && !force) return;
  _activeSection = section;
  document.querySelectorAll('.snx-tvs-nav-btn').forEach(btn => {
    const active = btn.dataset.section === section;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const body = document.getElementById('snx-tvs-body');
  if (!body) return;
  switch (section) {
    case 'media':       _renderMedia(body); break;
    case 'playlists':   _renderPlaylists(body); break;
    case 'programming': _renderProgramming(body); break;
    case 'schedule':    _renderSchedule(body); break;
    case 'queue':       _renderQueue(body); break;
    case 'now-playing': _renderNowPlaying(body); break;
    case 'guide':       _renderGuide(body); break;
    case 'settings':    _renderSettings(body); break;
  }
}

/* ════════════════════════════════════════════════════
   SECTION: MEDIA
════════════════════════════════════════════════════ */
function _renderMedia(container) {
  const approved = _mediaLib.filter(m => m.status === 'approved');
  const pending  = _mediaLib.filter(m => m.status === 'pending_approval');

  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-head">
        <div>
          <div class="snx-tvs-section-title">TV MEDIA</div>
          <div class="snx-tvs-section-meta">${_mediaLib.length} total · ${approved.length} approved · ${pending.length} pending</div>
        </div>
        <div class="snx-tvs-actions">
          <button class="snx-tvs-btn" id="snx-tvs-import-sns">☁ Import SNS Media</button>
          <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-upload-media">⬆ Upload</button>
        </div>
      </div>
      <div id="snx-tvs-import-status" class="snx-tvs-status" style="display:none;"></div>
      <div id="snx-tvs-upload-area" style="display:none;">
        ${_renderUploadForm()}
      </div>
      <div class="snx-tvs-filter-row">
        <input class="snx-tvs-search" id="snx-tvs-media-search" placeholder="Search media…" type="search">
        <select class="snx-tvs-select" id="snx-tvs-media-filter">
          <option value="all">All Status</option>
          <option value="approved">Approved</option>
          <option value="pending_approval">Pending</option>
          <option value="rejected">Rejected</option>
        </select>
      </div>
      <div class="snx-tvs-media-grid" id="snx-tvs-media-grid"></div>
    </div>`;

  _refreshMediaGrid(container);

  container.querySelector('#snx-tvs-import-sns')?.addEventListener('click', () => _importSnsMedia(container));
  container.querySelector('#snx-tvs-upload-media')?.addEventListener('click', () => {
    const area = container.querySelector('#snx-tvs-upload-area');
    if (area) area.style.display = area.style.display === 'none' ? '' : 'none';
  });
  container.querySelector('#snx-tvs-media-search')?.addEventListener('input', () => _refreshMediaGrid(container));
  container.querySelector('#snx-tvs-media-filter')?.addEventListener('change', () => _refreshMediaGrid(container));
  _bindUploadForm(container);
}

function _renderUploadForm() {
  return `
    <div class="snx-tvs-upload-form">
      <div class="snx-tvs-form-row">
        <select class="snx-tvs-select" id="snx-tvs-up-type">
          <option value="music">Music (audio)</option>
          <option value="video">Video</option>
          <option value="podcast">Podcast</option>
          <option value="show">Show</option>
          <option value="broadcast_clip">Broadcast Clip</option>
          <option value="commercial">Commercial</option>
          <option value="station_id">Station ID</option>
        </select>
        <input class="snx-tvs-input" id="snx-tvs-up-title" placeholder="Title" type="text">
        <input class="snx-tvs-input" id="snx-tvs-up-artist" placeholder="Artist (optional)" type="text">
      </div>
      <div class="snx-tvs-form-row">
        <input type="file" id="snx-tvs-up-file" accept="audio/*,video/*,image/*" class="snx-tvs-file-input">
        <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-up-submit">Upload to SNS Storage</button>
      </div>
      <div id="snx-tvs-up-progress" class="snx-tvs-progress-bar" style="display:none;">
        <div class="snx-tvs-progress-fill" id="snx-tvs-up-fill"></div>
      </div>
      <div id="snx-tvs-up-status" class="snx-tvs-status" style="display:none;"></div>
    </div>`;
}

function _bindUploadForm(container) {
  container.querySelector('#snx-tvs-up-submit')?.addEventListener('click', async () => {
    const fileInput  = container.querySelector('#snx-tvs-up-file');
    const titleInput = container.querySelector('#snx-tvs-up-title');
    const typeSelect = container.querySelector('#snx-tvs-up-type');
    const artistInput= container.querySelector('#snx-tvs-up-artist');
    const statusEl   = container.querySelector('#snx-tvs-up-status');
    const progressEl = container.querySelector('#snx-tvs-up-progress');
    const fillEl     = container.querySelector('#snx-tvs-up-fill');

    const file  = fileInput?.files?.[0];
    const title = titleInput?.value?.trim();
    const type  = typeSelect?.value || 'music';

    if (!file)  { _setStatus(statusEl, 'Select a file first.', 'err'); return; }
    if (!title) { _setStatus(statusEl, 'Enter a title.', 'err'); return; }

    const uid    = _user?.uid;
    const path   = `tv/${uid}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const isAudio = file.type.startsWith('audio/');
    const endpoint = isAudio ? `${UPLOAD_WORKER}/upload-music` : UPLOAD_WORKER;

    _setStatus(statusEl, 'Uploading to SNS storage…');
    if (progressEl) { progressEl.style.display = ''; if (fillEl) fillEl.style.width = '0%'; }

    try {
      const idToken = await getTvIdToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('path', path);

      // Use XMLHttpRequest for progress events
      const url = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', endpoint);
        xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
        xhr.upload.onprogress = e => {
          if (e.lengthComputable && fillEl) fillEl.style.width = `${Math.round(e.loaded / e.total * 100)}%`;
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText).url); } catch { reject(new Error('Invalid response')); }
          } else {
            try { reject(new Error(JSON.parse(xhr.responseText).error || `HTTP ${xhr.status}`)); }
            catch { reject(new Error(`HTTP ${xhr.status}`)); }
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        xhr.send(formData);
      });

      // Get duration
      let duration_sec = 0;
      try { duration_sec = await _getMediaDuration(file); } catch (_) {}

      // Write metadata to TV library
      await addTvMedia({
        title,
        artist:        artistInput?.value?.trim() || '',
        type,
        url,
        storage_path:  path,
        storage_backend: 'shadow_nexus_r2',
        duration_sec,
        mime_type:     file.type || '',
        thumbnail_url: '',
        owner_uid:     uid,
        uploaded_by:   uid,
        source:        'tv_upload',
        status:        'pending_approval',
      });

      _setStatus(statusEl, `✓ Uploaded. "${title}" is pending approval.`, 'ok');
      if (fileInput)  fileInput.value  = '';
      if (titleInput) titleInput.value = '';
      if (progressEl) progressEl.style.display = 'none';
      if (fillEl)     fillEl.style.width = '0%';
    } catch (err) {
      _setStatus(statusEl, `Upload failed: ${err.message}`, 'err');
      if (progressEl) progressEl.style.display = 'none';
    }
  });
}

function _refreshMediaGrid(container) {
  const grid    = container?.querySelector('#snx-tvs-media-grid') || document.getElementById('snx-tvs-media-grid');
  if (!grid) return;
  const search  = (container?.querySelector('#snx-tvs-media-search') || document.getElementById('snx-tvs-media-search'))?.value?.toLowerCase() || '';
  const filter  = (container?.querySelector('#snx-tvs-media-filter') || document.getElementById('snx-tvs-media-filter'))?.value || 'all';
  let items = _mediaLib;
  if (filter !== 'all') items = items.filter(m => m.status === filter);
  if (search) items = items.filter(m => (m.title || '').toLowerCase().includes(search) || (m.artist || '').toLowerCase().includes(search));
  if (!items.length) { grid.innerHTML = '<div class="snx-tvs-empty">No media.</div>'; return; }
  grid.innerHTML = items.map(m => `
    <div class="snx-tvs-media-card" data-id="${esc(m.id)}">
      <div class="snx-tvs-media-card-icon">${_typeIcon(m.type)}</div>
      <div class="snx-tvs-media-card-info">
        <div class="snx-tvs-media-card-title">${esc(m.title)}</div>
        <div class="snx-tvs-media-card-meta">${esc(m.artist || '')}${m.artist ? ' · ' : ''}${m.type || 'media'} · ${fmtTime(m.duration_sec)}</div>
        <div class="snx-tvs-media-card-status snx-tvs-status-${m.status}">${_statusLabel(m.status)}</div>
      </div>
      <div class="snx-tvs-media-card-actions">
        ${m.status === 'pending_approval' ? `<button class="snx-tvs-btn-sm snx-tvs-btn-ok" data-approve="${esc(m.id)}">✓</button>` : ''}
        ${m.status === 'approved' ? `<button class="snx-tvs-btn-sm" data-reject="${esc(m.id)}">✗</button>` : ''}
        <button class="snx-tvs-btn-sm snx-tvs-btn-del" data-delete="${esc(m.id)}">🗑</button>
      </div>
    </div>`).join('');

  grid.querySelectorAll('[data-approve]').forEach(btn => btn.addEventListener('click', async () => {
    await updateTvMedia(btn.dataset.approve, { status: 'approved' });
    _toast('Media approved.');
  }));
  grid.querySelectorAll('[data-reject]').forEach(btn => btn.addEventListener('click', async () => {
    await updateTvMedia(btn.dataset.reject, { status: 'rejected' });
    _toast('Media rejected.');
  }));
  grid.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this media record? (The R2 file is not deleted)')) return;
    await deleteTvMedia(btn.dataset.delete);
    _toast('Media deleted.');
  }));
}

function _refreshMedia() {
  if (_activeSection === 'media') {
    const grid = document.getElementById('snx-tvs-media-grid');
    if (grid) _refreshMediaGrid(null);
  }
}

async function _importSnsMedia(container) {
  const btn      = container?.querySelector('#snx-tvs-import-sns');
  const statusEl = container?.querySelector('#snx-tvs-import-status');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Importing…'; }
  _setStatus(statusEl, 'Reading SNS media library…');
  if (statusEl) statusEl.style.display = '';

  try {
    // Use the SNS Firestore instance (horr-a08f4)
    const { snsDb } = await import('./snx-creator-channels.js');
    const result = await importSnsMediaToTv(_user.uid, snsDb);
    const parts = [];
    if (result.imported) parts.push(`✓ ${result.imported} imported (pending approval)`);
    if (result.skipped)  parts.push(`${result.skipped} already exist`);
    if (result.failed)   parts.push(`${result.failed} failed`);
    _setStatus(statusEl, parts.join(' · ') || 'Nothing new to import.', result.failed ? 'warn' : 'ok');
  } catch (err) {
    _setStatus(statusEl, `Import error: ${err.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '☁ Import SNS Media'; }
  }
}

/* ════════════════════════════════════════════════════
   SECTION: PLAYLISTS
════════════════════════════════════════════════════ */
function _renderPlaylists(container) {
  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-head">
        <div class="snx-tvs-section-title">PLAYLISTS</div>
        <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-new-pl">+ New Playlist</button>
      </div>
      <div id="snx-tvs-pl-list" class="snx-tvs-pl-list"></div>
    </div>`;
  _refreshPlaylistsIn(container);
  container.querySelector('#snx-tvs-new-pl')?.addEventListener('click', () => _promptNewPlaylist(container));
}

function _refreshPlaylistsIn(container) {
  const list = container?.querySelector('#snx-tvs-pl-list') || document.getElementById('snx-tvs-pl-list');
  if (!list) return;
  if (!_playlists.length) { list.innerHTML = '<div class="snx-tvs-empty">No playlists yet.</div>'; return; }
  list.innerHTML = _playlists.map(pl => `
    <div class="snx-tvs-pl-row" data-pl="${esc(pl.id)}">
      <div class="snx-tvs-pl-info">
        <div class="snx-tvs-pl-name">${esc(pl.name)}</div>
        <div class="snx-tvs-pl-meta">${(pl.items || []).length} items</div>
      </div>
      <div class="snx-tvs-pl-actions">
        <button class="snx-tvs-btn-sm" data-pl-edit="${esc(pl.id)}">Edit</button>
        <button class="snx-tvs-btn-sm snx-tvs-btn-del" data-pl-del="${esc(pl.id)}">Delete</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('[data-pl-edit]').forEach(btn => btn.addEventListener('click', () => _editPlaylist(btn.dataset.plEdit, container)));
  list.querySelectorAll('[data-pl-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this playlist?')) return;
    await deleteTvPlaylist(btn.dataset.plDel);
    _toast('Playlist deleted.');
  }));
}

function _refreshPlaylists() {
  if (_activeSection === 'playlists') {
    const list = document.getElementById('snx-tvs-pl-list');
    if (list) _refreshPlaylistsIn(null);
  }
}

async function _promptNewPlaylist(container) {
  const name = prompt('Playlist name:');
  if (!name?.trim()) return;
  const id = await createTvPlaylist(name.trim());
  _toast(`Playlist "${name.trim()}" created.`);
  _editPlaylist(id, container);
}

function _editPlaylist(playlistId, container) {
  const pl = _playlists.find(p => p.id === playlistId);
  if (!pl) return;
  const body = document.getElementById('snx-tvs-body');
  if (!body) return;

  const approved = _mediaLib.filter(m => m.status === 'approved' && m.url);
  const items    = pl.items || [];

  body.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-head">
        <div>
          <div class="snx-tvs-section-title">✏ ${esc(pl.name)}</div>
          <div class="snx-tvs-section-meta">${items.length} items</div>
        </div>
        <div class="snx-tvs-actions">
          <button class="snx-tvs-btn" id="snx-tvs-pl-rename">Rename</button>
          <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-pl-save">Save</button>
          <button class="snx-tvs-btn" id="snx-tvs-pl-back">← Back</button>
        </div>
      </div>
      <div class="snx-tvs-pl-editor">
        <div class="snx-tvs-pl-col">
          <div class="snx-tvs-col-label">PLAYLIST ITEMS</div>
          <div id="snx-tvs-pl-items"></div>
        </div>
        <div class="snx-tvs-pl-col">
          <div class="snx-tvs-col-label">ADD FROM LIBRARY</div>
          <input class="snx-tvs-search" id="snx-tvs-pl-lib-search" placeholder="Search…" type="search">
          <div id="snx-tvs-pl-lib"></div>
        </div>
      </div>
    </div>`;

  let editItems = [...items];

  const renderItems = () => {
    const el = document.getElementById('snx-tvs-pl-items');
    if (!el) return;
    el.innerHTML = editItems.length
      ? editItems.map((it, i) => `
          <div class="snx-tvs-pl-item" data-i="${i}">
            <span class="snx-tvs-pl-item-pos">${i + 1}</span>
            <div class="snx-tvs-pl-item-info">
              <div>${esc(it.title)}</div>
              <div class="snx-tvs-pl-item-meta">${esc(it.artist || '')} · ${fmtTime(it.duration_sec)}</div>
            </div>
            <button class="snx-tvs-btn-sm snx-tvs-btn-del" data-rm="${i}">✕</button>
          </div>`).join('')
      : '<div class="snx-tvs-empty">No items.</div>';
    el.querySelectorAll('[data-rm]').forEach(btn => btn.addEventListener('click', () => {
      editItems.splice(parseInt(btn.dataset.rm), 1);
      renderItems();
    }));
  };

  const renderLib = (search = '') => {
    const el = document.getElementById('snx-tvs-pl-lib');
    if (!el) return;
    const shown = search ? approved.filter(m => (m.title || '').toLowerCase().includes(search) || (m.artist || '').toLowerCase().includes(search)) : approved;
    el.innerHTML = shown.map(m => `
      <div class="snx-tvs-pl-lib-item" data-mid="${esc(m.id)}">
        <div class="snx-tvs-pl-lib-info">
          <div>${esc(m.title)}</div>
          <div class="snx-tvs-pl-item-meta">${esc(m.artist || '')} · ${fmtTime(m.duration_sec)}</div>
        </div>
        <button class="snx-tvs-btn-sm" data-add="${esc(m.id)}">+</button>
      </div>`).join('');
    el.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', () => {
      const m = _mediaLib.find(x => x.id === btn.dataset.add);
      if (!m) return;
      editItems.push({ id: m.id, title: m.title, artist: m.artist || '', url: m.url, duration_sec: m.duration_sec || 0, type: m.type, mime_type: m.mime_type || '' });
      renderItems();
    }));
  };

  renderItems();
  renderLib();
  document.getElementById('snx-tvs-pl-lib-search')?.addEventListener('input', e => renderLib(e.target.value.toLowerCase()));
  document.getElementById('snx-tvs-pl-back')?.addEventListener('click', () => _switchSection('playlists', true));
  document.getElementById('snx-tvs-pl-rename')?.addEventListener('click', async () => {
    const name = prompt('New name:', pl.name);
    if (!name?.trim()) return;
    await updateTvPlaylist(playlistId, { name: name.trim() });
    _toast('Playlist renamed.');
  });
  document.getElementById('snx-tvs-pl-save')?.addEventListener('click', async () => {
    await updateTvPlaylist(playlistId, { items: editItems });
    _toast('Playlist saved.');
    _switchSection('playlists', true);
  });
}

/* ════════════════════════════════════════════════════
   SECTION: PROGRAMMING
════════════════════════════════════════════════════ */
function _renderProgramming(container) {
  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-head">
        <div class="snx-tvs-section-title">PROGRAMS</div>
        <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-new-prog">+ New Program</button>
      </div>
      <div id="snx-tvs-prog-list"></div>
    </div>`;
  _refreshProgramsIn(container);
  container.querySelector('#snx-tvs-new-prog')?.addEventListener('click', () => _openProgramModal(null));
}

function _refreshProgramsIn(container) {
  const list = container?.querySelector('#snx-tvs-prog-list') || document.getElementById('snx-tvs-prog-list');
  if (!list) return;
  if (!_programs.length) { list.innerHTML = '<div class="snx-tvs-empty">No programs yet.</div>'; return; }
  list.innerHTML = _programs.map(pr => {
    const ref = pr.type === 'playlist'
      ? (_playlists.find(p => p.id === pr.ref_id)?.name || 'Unknown playlist')
      : (_mediaLib.find(m => m.id === pr.ref_id)?.title || 'Unknown media');
    return `
      <div class="snx-tvs-prog-row">
        <div class="snx-tvs-prog-info">
          <div class="snx-tvs-prog-name">${esc(pr.name)}</div>
          <div class="snx-tvs-prog-meta">${pr.type === 'playlist' ? '▶ Playlist' : '🎬 Media'}: ${esc(ref)}</div>
          ${pr.description ? `<div class="snx-tvs-prog-desc">${esc(pr.description)}</div>` : ''}
        </div>
        <div class="snx-tvs-pl-actions">
          <button class="snx-tvs-btn-sm" data-prog-edit="${esc(pr.id)}">Edit</button>
          <button class="snx-tvs-btn-sm snx-tvs-btn-del" data-prog-del="${esc(pr.id)}">Delete</button>
        </div>
      </div>`;
  }).join('');
  list.querySelectorAll('[data-prog-edit]').forEach(btn => btn.addEventListener('click', () => _openProgramModal(btn.dataset.progEdit)));
  list.querySelectorAll('[data-prog-del]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this program?')) return;
    await deleteTvProgram(btn.dataset.progDel);
    _toast('Program deleted.');
  }));
}

function _refreshPrograms() {
  if (_activeSection === 'programming') {
    const list = document.getElementById('snx-tvs-prog-list');
    if (list) _refreshProgramsIn(null);
  }
}

function _openProgramModal(programId) {
  const existing = programId ? _programs.find(p => p.id === programId) : null;
  const modal = document.createElement('div');
  modal.className = 'snx-tvs-modal-overlay';
  modal.innerHTML = `
    <div class="snx-tvs-modal">
      <div class="snx-tvs-modal-title">${existing ? 'Edit Program' : 'New Program'}</div>
      <label class="snx-tvs-label">Name</label>
      <input class="snx-tvs-input" id="snx-tvs-pm-name" value="${esc(existing?.name || '')}">
      <label class="snx-tvs-label">Type</label>
      <select class="snx-tvs-select" id="snx-tvs-pm-type">
        <option value="media" ${existing?.type === 'media' || !existing ? 'selected' : ''}>Media Item</option>
        <option value="playlist" ${existing?.type === 'playlist' ? 'selected' : ''}>Playlist</option>
      </select>
      <label class="snx-tvs-label">Reference</label>
      <select class="snx-tvs-select" id="snx-tvs-pm-ref">
        <option value="">— select —</option>
        ${_mediaLib.filter(m => m.status === 'approved').map(m => `<option value="${esc(m.id)}" ${existing?.type === 'media' && existing?.ref_id === m.id ? 'selected' : ''}>${esc(m.title)}</option>`).join('')}
        ${_playlists.map(pl => `<option value="${esc(pl.id)}" ${existing?.type === 'playlist' && existing?.ref_id === pl.id ? 'selected' : ''}>[Playlist] ${esc(pl.name)}</option>`).join('')}
      </select>
      <label class="snx-tvs-label">Description (optional)</label>
      <input class="snx-tvs-input" id="snx-tvs-pm-desc" value="${esc(existing?.description || '')}">
      <div id="snx-tvs-pm-err" class="snx-tvs-err" style="display:none;"></div>
      <div class="snx-tvs-modal-actions">
        <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-pm-save">Save</button>
        <button class="snx-tvs-btn" id="snx-tvs-pm-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#snx-tvs-pm-cancel')?.addEventListener('click', () => modal.remove());
  modal.querySelector('#snx-tvs-pm-save')?.addEventListener('click', async () => {
    const name = modal.querySelector('#snx-tvs-pm-name')?.value.trim();
    const type = modal.querySelector('#snx-tvs-pm-type')?.value;
    const refId= modal.querySelector('#snx-tvs-pm-ref')?.value;
    const desc = modal.querySelector('#snx-tvs-pm-desc')?.value.trim();
    const errEl= modal.querySelector('#snx-tvs-pm-err');
    if (!name) { _setStatus(errEl, 'Name required.', 'err'); errEl.style.display = ''; return; }
    if (!refId){ _setStatus(errEl, 'Select a reference.', 'err'); errEl.style.display = ''; return; }
    if (existing) await updateTvProgram(programId, { name, type, ref_id: refId, description: desc });
    else          await createTvProgram({ name, type, ref_id: refId, description: desc });
    modal.remove();
    _toast(`Program ${existing ? 'updated' : 'created'}.`);
  });
}

/* ════════════════════════════════════════════════════
   SECTION: SCHEDULE
════════════════════════════════════════════════════ */
function _renderSchedule(container) {
  const queue = _tvState?.queue || [];
  const approved = _mediaLib.filter(m => m.status === 'approved' && m.url);
  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-head">
        <div>
          <div class="snx-tvs-section-title">SCHEDULE / QUEUE</div>
          <div class="snx-tvs-section-meta">${queue.length} items queued</div>
        </div>
        <div class="snx-tvs-actions">
          <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-push-live">▶ Push Schedule Live</button>
          <button class="snx-tvs-btn" id="snx-tvs-clear-sched">Clear</button>
        </div>
      </div>
      <div class="snx-tvs-sched-layout">
        <div class="snx-tvs-sched-queue">
          <div class="snx-tvs-col-label">SCHEDULE ORDER</div>
          <div id="snx-tvs-sched-items"></div>
        </div>
        <div class="snx-tvs-sched-lib">
          <div class="snx-tvs-col-label">ADD MEDIA</div>
          <input class="snx-tvs-search" id="snx-tvs-sched-search" placeholder="Search…" type="search">
          <div id="snx-tvs-sched-lib"></div>
        </div>
      </div>
    </div>`;

  _refreshScheduleQueue();
  _refreshScheduleLib('');

  container.querySelector('#snx-tvs-sched-search')?.addEventListener('input', e => _refreshScheduleLib(e.target.value.toLowerCase()));
  container.querySelector('#snx-tvs-push-live')?.addEventListener('click', async () => {
    const q = _tvState?.queue || [];
    if (!q.length) { _toast('Add media to the schedule first.', 'err'); return; }
    await pushScheduleLive(q);
    _toast('Schedule is now LIVE!');
  });
  container.querySelector('#snx-tvs-clear-sched')?.addEventListener('click', async () => {
    if (!confirm('Clear the schedule?')) return;
    await saveTvSchedule([]);
    _toast('Schedule cleared.');
  });
}

function _refreshScheduleQueue() {
  if (_activeSection !== 'schedule') return;
  const el = document.getElementById('snx-tvs-sched-items');
  if (!el) return;
  const queue  = _tvState?.queue || [];
  const curId  = _tvState?.current_item?.id;
  if (!queue.length) { el.innerHTML = '<div class="snx-tvs-empty">No items — add from library →</div>'; return; }
  el.innerHTML = queue.map((item, idx) => `
    <div class="snx-tvs-sched-item ${item.id === curId ? 'is-current' : ''}" data-idx="${idx}">
      <span class="snx-tvs-sched-pos">${item.id === curId ? '▶' : idx + 1}</span>
      <div class="snx-tvs-sched-info">
        <div>${esc(item.title)}</div>
        <div class="snx-tvs-sched-meta">${esc(item.artist || '')} · ${fmtTime(item.duration_sec)}</div>
      </div>
      <button class="snx-tvs-btn-sm snx-tvs-btn-del" data-rm-sched="${idx}">✕</button>
    </div>`).join('');
  el.querySelectorAll('[data-rm-sched]').forEach(btn => btn.addEventListener('click', async () => {
    const newQueue = [...queue];
    newQueue.splice(parseInt(btn.dataset.rmSched), 1);
    await saveTvSchedule(newQueue);
  }));
}

function _refreshScheduleLib(search = '') {
  const el = document.getElementById('snx-tvs-sched-lib');
  if (!el) return;
  const items = search
    ? _mediaLib.filter(m => m.status === 'approved' && ((m.title || '').toLowerCase().includes(search) || (m.artist || '').toLowerCase().includes(search)))
    : _mediaLib.filter(m => m.status === 'approved');
  el.innerHTML = items.map(m => `
    <div class="snx-tvs-sched-lib-item">
      <div class="snx-tvs-pl-lib-info">
        <div>${esc(m.title)}</div>
        <div class="snx-tvs-pl-item-meta">${esc(m.artist || '')} · ${fmtTime(m.duration_sec)}</div>
      </div>
      <button class="snx-tvs-btn-sm" data-add-sched="${esc(m.id)}">+</button>
    </div>`).join('') || '<div class="snx-tvs-empty">No approved media.</div>';
  el.querySelectorAll('[data-add-sched]').forEach(btn => btn.addEventListener('click', async () => {
    const m = _mediaLib.find(x => x.id === btn.dataset.addSched);
    if (!m) return;
    const queue = [...(_tvState?.queue || [])];
    queue.push({ id: m.id, title: m.title, artist: m.artist || '', url: m.url, duration_sec: m.duration_sec || 0, type: m.type, mime_type: m.mime_type || '' });
    await saveTvSchedule(queue);
  }));
}

/* ════════════════════════════════════════════════════
   SECTION: QUEUE (live playback view)
════════════════════════════════════════════════════ */
function _renderQueue(container) {
  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-head">
        <div class="snx-tvs-section-title">ACTIVE QUEUE</div>
        <div class="snx-tvs-actions">
          <button class="snx-tvs-btn" id="snx-tvs-skip">⏭ Skip</button>
        </div>
      </div>
      <div id="snx-tvs-queue-list"></div>
    </div>`;
  _renderQueueList(container);
  container.querySelector('#snx-tvs-skip')?.addEventListener('click', async () => {
    await advanceTvNow(_tvState?.current_item?.id || null);
    _toast('Skipped to next item.');
  });
}

function _renderQueueList(container) {
  const el = container?.querySelector('#snx-tvs-queue-list') || document.getElementById('snx-tvs-queue-list');
  if (!el) return;
  const queue = _tvState?.queue || [];
  const curId = _tvState?.current_item?.id;
  if (!queue.length && !_tvState?.current_item) { el.innerHTML = '<div class="snx-tvs-empty">No active queue.</div>'; return; }

  const items = _tvState?.current_item
    ? [{ ..._tvState.current_item, _isCurrent: true }, ...queue.filter(q => q.id !== curId)]
    : queue;
  el.innerHTML = items.map((item, idx) => `
    <div class="snx-tvs-queue-item ${item._isCurrent ? 'is-current' : ''}">
      <span class="snx-tvs-queue-pos">${item._isCurrent ? '▶ ON AIR' : idx}</span>
      <div>
        <div>${esc(item.title)}</div>
        <div class="snx-tvs-pl-item-meta">${esc(item.artist || '')} · ${fmtTime(item.duration_sec)}</div>
      </div>
    </div>`).join('');
}

/* ════════════════════════════════════════════════════
   SECTION: NOW PLAYING
════════════════════════════════════════════════════ */
function _renderNowPlaying(container) {
  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-title">NOW PLAYING</div>
      <div id="snx-tvs-np-panel" class="snx-tvs-np-panel"></div>
    </div>`;
  _refreshNowPlaying();
}

function _refreshNowPlaying() {
  if (_activeSection !== 'now-playing' && _activeSection !== 'guide') return;
  const panel = document.getElementById('snx-tvs-np-panel');
  if (!panel) return;
  const item     = _tvState?.current_item;
  const elapsed  = item ? computeElapsed(_tvState?.started_at) : 0;
  const duration = item?.duration_sec || 0;
  const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;

  const queue  = (_tvState?.queue || []).filter(q => q?.id && q?.url);
  const curIdx = queue.findIndex(q => q.id === item?.id);
  const upNext = queue[curIdx + 1] || null;

  panel.innerHTML = item ? `
    <div class="snx-tvs-np-title">${esc(item.title)}</div>
    ${item.artist ? `<div class="snx-tvs-np-artist">${esc(item.artist)}</div>` : ''}
    <div class="snx-tvs-np-type">${esc(item.type || 'media')} ${_tvState?.is_commercial ? '· COMMERCIAL' : ''}</div>
    <div class="snx-tvs-np-progress-wrap">
      <div class="snx-tvs-np-elapsed">${fmtTime(elapsed)}</div>
      <div class="snx-tvs-np-bar"><div class="snx-tvs-np-fill" style="width:${progress.toFixed(1)}%"></div></div>
      <div class="snx-tvs-np-dur">${fmtTime(duration)}</div>
    </div>
    ${upNext ? `<div class="snx-tvs-np-upnext">UP NEXT: <strong>${esc(upNext.title)}</strong></div>` : ''}
    <div class="snx-tvs-np-actions">
      <button class="snx-tvs-btn" id="snx-tvs-np-skip">⏭ Skip</button>
      <button class="snx-tvs-btn" id="snx-tvs-np-pause">${_tvConfig?.paused ? '▶ Resume' : '⏸ Pause'}</button>
    </div>` : '<div class="snx-tvs-empty">Nothing playing.</div>';

  document.getElementById('snx-tvs-np-skip')?.addEventListener('click', async () => {
    await advanceTvNow(_tvState?.current_item?.id || null);
    _toast('Skipped.');
  });
  document.getElementById('snx-tvs-np-pause')?.addEventListener('click', async () => {
    if (_tvConfig?.paused) { await resumeTv(); _toast('TV resumed.'); }
    else { await pauseTv(); _toast('TV paused.'); }
    _tvConfig = await loadTvConfig();
    _refreshNowPlaying();
  });
}

function _refreshNowPlayingElapsed() {
  if (_activeSection !== 'now-playing') return;
  const fillEl   = document.querySelector('.snx-tvs-np-fill');
  const elapsedEl = document.querySelector('.snx-tvs-np-elapsed');
  const item = _tvState?.current_item;
  if (!item || !fillEl || !elapsedEl) return;
  const elapsed  = computeElapsed(_tvState?.started_at);
  const duration = item.duration_sec || 0;
  const progress = duration > 0 ? Math.min(100, (elapsed / duration) * 100) : 0;
  fillEl.style.width = `${progress.toFixed(1)}%`;
  elapsedEl.textContent = fmtTime(elapsed);
}

/* ════════════════════════════════════════════════════
   SECTION: TV GUIDE
════════════════════════════════════════════════════ */
function _renderGuide(container) {
  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-title">TV GUIDE</div>
      <div id="snx-tvs-guide-panel"></div>
    </div>`;
  _refreshGuide();
}

function _refreshGuide() {
  if (_activeSection !== 'guide') return;
  const panel = document.getElementById('snx-tvs-guide-panel');
  if (!panel) return;
  const queue   = _tvState?.queue || [];
  const curItem = _tvState?.current_item;
  const startMs = _tvState?.started_at
    ? (typeof _tvState.started_at?.toMillis === 'function'
        ? _tvState.started_at.toMillis()
        : typeof _tvState.started_at === 'number'
          ? (_tvState.started_at < 1e10 ? _tvState.started_at * 1000 : _tvState.started_at)
          : Date.now())
    : Date.now();

  if (!curItem && !queue.length) {
    panel.innerHTML = '<div class="snx-tvs-empty">No programming scheduled.</div>';
    return;
  }

  // Build a timeline starting from current item
  let t = startMs;
  const rows = [];
  if (curItem) {
    rows.push({ item: curItem, startMs: t, endMs: t + (curItem.duration_sec || 0) * 1000, isCurrent: true });
    t += (curItem.duration_sec || 0) * 1000;
  }
  const curIdx = queue.findIndex(q => q.id === curItem?.id);
  const upcoming = curIdx >= 0 ? queue.slice(curIdx + 1) : queue;
  for (const item of upcoming.slice(0, 12)) {
    rows.push({ item, startMs: t, endMs: t + (item.duration_sec || 0) * 1000, isCurrent: false });
    t += (item.duration_sec || 0) * 1000;
  }

  panel.innerHTML = rows.map(row => {
    const start = new Date(row.startMs);
    const timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const endStr  = new Date(row.endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="snx-tvs-guide-row ${row.isCurrent ? 'is-current' : ''}">
        <div class="snx-tvs-guide-time">${timeStr}–${endStr}</div>
        <div class="snx-tvs-guide-info">
          <div>${esc(row.item.title)}${row.isCurrent ? ' <span class="snx-tvs-on-air-pill">ON AIR</span>' : ''}</div>
          <div class="snx-tvs-guide-meta">${esc(row.item.artist || '')}${row.item.artist ? ' · ' : ''}${fmtTime(row.item.duration_sec)}</div>
        </div>
      </div>`;
  }).join('');
}

/* ════════════════════════════════════════════════════
   SECTION: CHANNEL SETTINGS
════════════════════════════════════════════════════ */
function _renderSettings(container) {
  const cfg = _tvConfig || DEFAULT_TV_CONFIG;
  container.innerHTML = `
    <div class="snx-tvs-section">
      <div class="snx-tvs-section-title">CHANNEL SETTINGS</div>

      <div class="snx-tvs-settings-group">
        <div class="snx-tvs-settings-label">CHANNEL CONTROL</div>
        <div class="snx-tvs-actions">
          <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-start-tv">▶ Start TV</button>
          <button class="snx-tvs-btn" id="snx-tvs-pause-tv">${cfg.paused ? '▶ Resume TV' : '⏸ Pause TV'}</button>
          <button class="snx-tvs-btn snx-tvs-btn-del" id="snx-tvs-stop-tv">■ Stop TV</button>
        </div>
        <div id="snx-tvs-ctrl-status" class="snx-tvs-status" style="margin-top:8px;display:none;"></div>
      </div>

      <div class="snx-tvs-settings-group">
        <div class="snx-tvs-settings-label">COMMERCIAL FREQUENCY</div>
        <select class="snx-tvs-select" id="snx-tvs-comm-freq">
          ${Object.entries(TV_COMMERCIAL_FREQ).map(([k, v]) => `
            <option value="${k}" ${cfg.commercial_freq === k ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>

      <div class="snx-tvs-settings-group">
        <div class="snx-tvs-settings-label">REPEAT AVOIDANCE (items before repeating)</div>
        <input type="number" class="snx-tvs-input" id="snx-tvs-repeat-window"
               value="${cfg.avoid_repeat_window || 10}" min="1" max="50" style="width:80px;">
      </div>

      <button class="snx-tvs-btn snx-tvs-btn-primary" id="snx-tvs-save-settings" style="margin-top:16px;">Save Settings</button>
      <div id="snx-tvs-settings-status" class="snx-tvs-status" style="display:none;"></div>
    </div>`;

  const statusEl = container.querySelector('#snx-tvs-ctrl-status');
  const settingsStatus = container.querySelector('#snx-tvs-settings-status');

  container.querySelector('#snx-tvs-start-tv')?.addEventListener('click', async () => {
    _setStatus(statusEl, 'Starting TV…'); statusEl.style.display = '';
    try { await startTv(_mediaLib); _setStatus(statusEl, '✓ TV started.', 'ok'); _toast('TV started.'); }
    catch (e) { _setStatus(statusEl, `Error: ${e.message}`, 'err'); }
  });
  container.querySelector('#snx-tvs-pause-tv')?.addEventListener('click', async () => {
    if (cfg.paused) { await resumeTv(); _toast('TV resumed.'); }
    else { await pauseTv(); _toast('TV paused.'); }
    _tvConfig = await loadTvConfig(); _renderSettings(container);
  });
  container.querySelector('#snx-tvs-stop-tv')?.addEventListener('click', async () => {
    if (!confirm('Stop TV and clear current playback?')) return;
    await stopTv(); _toast('TV stopped.');
  });
  container.querySelector('#snx-tvs-save-settings')?.addEventListener('click', async () => {
    const freq   = container.querySelector('#snx-tvs-comm-freq')?.value || 'normal';
    const window = parseInt(container.querySelector('#snx-tvs-repeat-window')?.value) || 10;
    try {
      await saveTvConfig({ commercial_freq: freq, avoid_repeat_window: window });
      _tvConfig = await loadTvConfig();
      _setStatus(settingsStatus, '✓ Settings saved.', 'ok'); settingsStatus.style.display = '';
      _toast('Settings saved.');
    } catch (e) {
      _setStatus(settingsStatus, `Error: ${e.message}`, 'err'); settingsStatus.style.display = '';
    }
  });
}

function _refreshChannelSettings() {
  if (_activeSection === 'settings') {
    const body = document.getElementById('snx-tvs-body');
    if (body) _renderSettings(body);
  }
}

/* ════════════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════════════ */
function _setStatus(el, msg, type = '') {
  if (!el) return;
  el.textContent = msg;
  el.className   = `snx-tvs-status ${type ? 'snx-tvs-status-' + type : ''}`;
}

function _toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `snx-tvs-toast${type ? ' snx-tvs-toast-' + type : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 400); }, 3000);
}

function _typeIcon(type) {
  const icons = { video: '🎬', music: '🎵', audio: '🎵', podcast: '🎙', show: '📺',
                  broadcast_clip: '🎥', station_id: '📢', commercial: '📣',
                  trailer: '🎞', archive: '📼', music_video: '🎞', thumbnail: '🖼' };
  return icons[type] || '🎬';
}

function _statusLabel(status) {
  return { approved: '✓ Approved', pending_approval: '⏳ Pending', rejected: '✗ Rejected' }[status] || status;
}

function _getMediaDuration(file) {
  return new Promise(resolve => {
    const el = file.type.startsWith('video/') ? document.createElement('video') : document.createElement('audio');
    el.preload = 'metadata';
    const url = URL.createObjectURL(file);
    el.src = url;
    const cleanup = (dur) => { URL.revokeObjectURL(url); resolve(dur); };
    el.onloadedmetadata = () => cleanup(isFinite(el.duration) ? Math.round(el.duration) : 0);
    el.onerror = () => cleanup(0);
  });
}
