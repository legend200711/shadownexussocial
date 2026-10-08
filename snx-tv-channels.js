/**
 * snx-tv-channels.js
 * Shadow Nexus Social — 24-Hour TV Channel Manager
 * Build: SNS-2026-TV-CH-FINAL-001
 *
 * CANONICAL channel system for Shadow Nexus 24-Hour TV.
 *
 * ONE channel state.  ONE init path.  ONE selector.  ONE create path.
 *
 * Architecture:
 *   SNXTVChannels.init()
 *     → loads Firestore tv_channels (signed-in read, all see presets)
 *     → merges user-created channels from localStorage (user-scoped)
 *     → seeds missing preset channels into Firestore (Founder only)
 *     → sets canonical channels[]
 *     → chooses selectedChannelId
 *     → renders selector
 *
 * Preset channel IDs (deterministic, never change):
 *   snx-ch-shadow-nexus-tv   Shadow Nexus TV
 *   snx-ch-legend-music      Legend Music
 *   snx-ch-shadow-music      Shadow Music
 *   snx-ch-legend-videos     Legend Videos
 *   snx-ch-shadow-mix        Shadow Mix
 *
 * User-created channels:
 *   Stored in localStorage under key snxTvUserChannels_<uid> so they
 *   survive refresh within the same browser without touching Firestore rules.
 *   The Firestore tv_channels collection requires isFounderEmail() for writes,
 *   so user channels are stored client-side using a deterministic stable ID
 *   derived from the user UID + channel name.
 *
 * EXPOSES: window.SNXTVChannels
 */

'use strict';

(function (global) {

/* ════════════════════════════════════════════════════════════
   CONSTANTS
════════════════════════════════════════════════════════════ */

const BUILD              = 'SNS-2026-TV-CH-FINAL-001';
const COLL_TV_CHANNELS   = 'tv_channels';
const LS_USER_CHANNELS   = 'snxTvUserChannels';   // + '_' + uid
const LS_ACTIVE_CHANNEL  = 'snxTvActiveChannel';  // selected channel id

/* ════════════════════════════════════════════════════════════
   PRESET CHANNEL DEFINITIONS
   IDs are stable and deterministic — NEVER change them.
════════════════════════════════════════════════════════════ */

const PRESET_CHANNELS = [
  {
    id:          'snx-ch-shadow-nexus-tv',
    name:        'Shadow Nexus TV',
    description: 'Main general channel — all content, all day.',
    logoEmoji:   '📺',
    sortOrder:   1,
    isPreset:    true,
  },
  {
    id:          'snx-ch-legend-music',
    name:        'Legend Music',
    description: 'Music and music-video channel.',
    logoEmoji:   '🎵',
    sortOrder:   2,
    isPreset:    true,
  },
  {
    id:          'snx-ch-shadow-music',
    name:        'Shadow Music',
    description: 'Music and audio visualizer channel.',
    logoEmoji:   '🎧',
    sortOrder:   3,
    isPreset:    true,
  },
  {
    id:          'snx-ch-legend-videos',
    name:        'Legend Videos',
    description: 'Video, funny, and entertainment channel.',
    logoEmoji:   '🎬',
    sortOrder:   4,
    isPreset:    true,
  },
  {
    id:          'snx-ch-shadow-mix',
    name:        'Shadow Mix',
    description: 'Mixed music and video content.',
    logoEmoji:   '🔀',
    sortOrder:   5,
    isPreset:    true,
  },
];

/* ════════════════════════════════════════════════════════════
   CANONICAL STATE
   ONE place that owns the channel list.
════════════════════════════════════════════════════════════ */

/** All available channels — populated by init(), updated on create */
var _channels         = [];

/** Currently selected channel ID */
var _selectedId       = null;

/** Whether init has completed at least once */
var _initDone         = false;

/** Whether init is currently in progress (prevents double-init) */
var _initInProgress   = false;

/** Callback registered by snx-tv.js for channel selection */
var _onSelectCallback = null;

/** Unsubscribe handle for Firestore tv_channels listener */
var _unsubChannels    = null;

/* ════════════════════════════════════════════════════════════
   FIREBASE HELPERS
════════════════════════════════════════════════════════════ */

function _fs() { return global._snxFirestore || {}; }
function _db() { var f = _fs(); return f.db || global._snxDb || null; }
function _cu() { return global._snxCurrentUser || null; }
function _uid() { var u = _cu(); return u ? u.uid : null; }

/* ════════════════════════════════════════════════════════════
   LOCAL STORAGE HELPERS — user-created channels
════════════════════════════════════════════════════════════ */

function _lsKey() {
  var uid = _uid();
  return uid ? (LS_USER_CHANNELS + '_' + uid) : null;
}

function _loadUserChannels() {
  var key = _lsKey();
  if (!key) return [];
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function _saveUserChannels(list) {
  var key = _lsKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(list || []));
  } catch (e) {}
}

/* ════════════════════════════════════════════════════════════
   ACTIVE CHANNEL PREFERENCE
════════════════════════════════════════════════════════════ */

function _loadSelectedId() {
  try { return localStorage.getItem(LS_ACTIVE_CHANNEL) || null; } catch (e) { return null; }
}

function _saveSelectedId(id) {
  try { localStorage.setItem(LS_ACTIVE_CHANNEL, id || 'snx-ch-shadow-nexus-tv'); } catch (e) {}
}

/* ════════════════════════════════════════════════════════════
   STABLE CHANNEL ID GENERATOR
   Produces a deterministic ID from uid + channel name.
   Ensures no duplicates across page loads.
════════════════════════════════════════════════════════════ */

function _generateChannelId(name) {
  var uid  = _uid() || 'anon';
  var slug = (name || '').toLowerCase()
               .replace(/[^a-z0-9]+/g, '-')
               .replace(/^-+|-+$/g, '')
               .slice(0, 40);
  // Simple deterministic hash component: uid prefix + slug + timestamp truncated
  // We truncate uid to first 8 chars for brevity
  var uidPrefix = uid.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  return 'uch-' + uidPrefix + '-' + slug;
}

/* ════════════════════════════════════════════════════════════
   FIRESTORE SEED — idempotent, additive only
   Only fires when Founder is signed in; silently skips for others.
════════════════════════════════════════════════════════════ */

async function _seedPresetsIfFounder() {
  var role = global._snxRole || '';
  if (role !== 'founder') return; // only founder can write tv_channels

  var fs = _fs();
  var db = _db();
  if (!db || !fs.doc || !fs.getDoc || !fs.setDoc || !fs.serverTimestamp) return;

  var created = 0;
  for (var i = 0; i < PRESET_CHANNELS.length; i++) {
    var ch  = PRESET_CHANNELS[i];
    var ref = fs.doc(db, COLL_TV_CHANNELS, ch.id);
    try {
      var snap = await fs.getDoc(ref);
      if (snap.exists()) continue; // already there — never overwrite
      await fs.setDoc(ref, {
        name:        ch.name,
        description: ch.description,
        logoEmoji:   ch.logoEmoji || '',
        artworkUrl:  '',
        status:      'active',
        sortOrder:   ch.sortOrder,
        isPreset:    true,
        seedBuild:   BUILD,
        createdAt:   fs.serverTimestamp(),
        updatedAt:   fs.serverTimestamp(),
      });
      created++;
      console.log('[SNX-TV-CH] Seeded preset channel:', ch.name, '(' + ch.id + ')');
    } catch (e) {
      console.info('[SNX-TV-CH] Could not seed "' + ch.name + '" (non-fatal):', e.message);
    }
  }
  if (created > 0) {
    console.log('[SNX-TV-CH] Seeded', created, 'preset channel(s).');
  }
}

/* ════════════════════════════════════════════════════════════
   NORMALISE AND MERGE CHANNEL LIST
   Combines Firestore channels + preset definitions (for cases where
   Firestore is empty or the user isn't the Founder) + user-created channels.
   Produces a deduplicated, sorted, authoritative list.
════════════════════════════════════════════════════════════ */

/**
 * Build the canonical channel list from all sources.
 * @param {Array} firestoreChannels  — docs from tv_channels Firestore snapshot
 * @param {Array} userChannels       — from localStorage (user-created)
 * @returns {Array}                  — sorted, deduplicated channel objects
 */
function _buildChannelList(firestoreChannels, userChannels) {
  var merged = {};

  // 1. Start with the 5 preset definitions (always present regardless of Firestore)
  for (var i = 0; i < PRESET_CHANNELS.length; i++) {
    var p = PRESET_CHANNELS[i];
    merged[p.id] = {
      id:          p.id,
      name:        p.name,
      description: p.description,
      logoEmoji:   p.logoEmoji,
      sortOrder:   p.sortOrder,
      isPreset:    true,
      source:      'preset',
    };
  }

  // 2. Overlay with Firestore data (if a preset doc exists in Firestore, use that version;
  //    if a non-preset doc exists, add it)
  for (var j = 0; j < (firestoreChannels || []).length; j++) {
    var fc = firestoreChannels[j];
    if (!fc || !fc.id) continue;
    if (merged[fc.id]) {
      // Existing preset — merge Firestore fields on top (preserves any edits made via Studio)
      Object.assign(merged[fc.id], {
        name:        fc.name        || merged[fc.id].name,
        description: fc.description || merged[fc.id].description,
        logoEmoji:   fc.logoEmoji   || merged[fc.id].logoEmoji,
        sortOrder:   (fc.sortOrder !== undefined) ? fc.sortOrder : merged[fc.id].sortOrder,
        isPreset:    fc.isPreset !== undefined ? fc.isPreset : merged[fc.id].isPreset,
        source:      'firestore',
      });
    } else {
      // New non-preset channel from Firestore
      merged[fc.id] = {
        id:          fc.id,
        name:        fc.name        || fc.id,
        description: fc.description || '',
        logoEmoji:   fc.logoEmoji   || '📡',
        sortOrder:   fc.sortOrder   || 50,
        isPreset:    false,
        source:      'firestore',
      };
    }
  }

  // 3. Add user-created channels from localStorage (do not overwrite Firestore/preset)
  for (var k = 0; k < (userChannels || []).length; k++) {
    var uc = userChannels[k];
    if (!uc || !uc.id) continue;
    if (!merged[uc.id]) {
      merged[uc.id] = {
        id:          uc.id,
        name:        uc.name        || uc.id,
        description: uc.description || '',
        logoEmoji:   uc.logoEmoji   || '📡',
        sortOrder:   uc.sortOrder   || 99,
        isPreset:    false,
        source:      'user',
      };
    }
  }

  // 4. Sort: presets first by sortOrder, then user channels by name
  var list = Object.values(merged);
  list.sort(function (a, b) {
    if (a.isPreset && !b.isPreset) return -1;
    if (!a.isPreset && b.isPreset) return  1;
    var so = (a.sortOrder || 99) - (b.sortOrder || 99);
    if (so !== 0) return so;
    return (a.name || '').localeCompare(b.name || '');
  });

  return list;
}

/* ════════════════════════════════════════════════════════════
   CANONICAL INIT
   Single entry point.  Called by snx-tv.js pageOpen().
   Guards against double-init and race conditions.
════════════════════════════════════════════════════════════ */

/**
 * Initialize the TV channel system.
 *
 * Flow:
 *   1. Start Firestore live listener for tv_channels
 *   2. Load user channels from localStorage
 *   3. Build canonical channel list
 *   4. Seed missing preset channels (Founder only)
 *   5. Choose selectedChannelId (restore from pref, default = snx-ch-shadow-nexus-tv)
 *   6. Render selector
 *
 * @param {function} onSelect  — called with (channelId) when user picks a channel
 */
function init(onSelect) {
  if (typeof onSelect === 'function') {
    _onSelectCallback = onSelect;
  }

  if (_initInProgress) return;
  _initInProgress = true;

  // Restore selected channel preference
  var savedId = _loadSelectedId();

  var db  = _db();
  var fs  = _fs();

  if (!db || !fs.collection || !fs.onSnapshot) {
    // Firestore not ready — build from preset+user only, retry subscription
    _channels   = _buildChannelList([], _loadUserChannels());
    _selectedId = _resolveSelectedId(savedId);
    _initDone   = true;
    _initInProgress = false;
    _renderChannelPanel();
    // Retry when Firebase is ready
    setTimeout(function () { _initInProgress = false; init(); }, 1200);
    return;
  }

  // Tear down any existing listener to avoid duplicates
  if (_unsubChannels) {
    try { _unsubChannels(); } catch (_) {}
    _unsubChannels = null;
  }

  // Start live Firestore listener — fires immediately with current data
  try {
    _unsubChannels = fs.onSnapshot(
      fs.collection(db, COLL_TV_CHANNELS),
      function (snap) {
        var firestoreChannels = snap.docs.map(function (d) {
          return Object.assign({ id: d.id }, d.data());
        });
        _channels   = _buildChannelList(firestoreChannels, _loadUserChannels());
        _selectedId = _resolveSelectedId(_selectedId || _loadSelectedId());

        if (!_initDone) {
          _initDone = true;
          _initInProgress = false;
          // Seed presets for Founder (idempotent)
          _seedPresetsIfFounder().catch(function (e) {
            console.info('[SNX-TV-CH] Seed error (non-fatal):', e.message);
          });
        }

        // Re-render the panel every time channel list changes
        _renderChannelPanel();
      },
      function (err) {
        console.warn('[SNX-TV-CH] tv_channels listener error:', err.message);
        // Fall back to preset+user channels if Firestore fails
        _channels   = _buildChannelList([], _loadUserChannels());
        _selectedId = _resolveSelectedId(_selectedId || savedId);
        _initDone   = true;
        _initInProgress = false;
        _renderChannelPanel();
      }
    );
  } catch (e) {
    console.warn('[SNX-TV-CH] Could not start tv_channels listener:', e.message);
    _channels   = _buildChannelList([], _loadUserChannels());
    _selectedId = _resolveSelectedId(savedId);
    _initDone   = true;
    _initInProgress = false;
    _renderChannelPanel();
  }
}

/**
 * Validate a channel ID — ensure it exists in the current channel list.
 * Falls back to the first preset if not found.
 * @param {string|null} id
 * @returns {string}
 */
function _resolveSelectedId(id) {
  if (id && _channels.some(function (c) { return c.id === id; })) return id;
  // Default to Shadow Nexus TV
  return 'snx-ch-shadow-nexus-tv';
}

/* ════════════════════════════════════════════════════════════
   CREATE CHANNEL
   Called by the + Create Channel button in the viewer.
   Persists to localStorage (scoped to the user UID so it
   survives refresh on the same device).
════════════════════════════════════════════════════════════ */

/**
 * Create a new user channel.
 * @param {string}   name         — channel display name (required, 1–80 chars)
 * @param {function} onSuccess    — called with the new channel object on success
 * @param {function} onError      — called with an error message string on failure
 */
function createChannel(name, onSuccess, onError) {
  var trimmed = (name || '').trim();
  if (!trimmed) {
    if (typeof onError === 'function') onError('Channel name is required.');
    return;
  }
  if (trimmed.length > 80) {
    if (typeof onError === 'function') onError('Channel name is too long (max 80 characters).');
    return;
  }
  if (!_uid()) {
    if (typeof onError === 'function') onError('You must be signed in to create a channel.');
    return;
  }

  var id = _generateChannelId(trimmed);

  // Check for duplicates
  if (_channels.some(function (c) { return c.id === id; })) {
    if (typeof onError === 'function') onError('A channel with a similar name already exists.');
    return;
  }

  var newChannel = {
    id:          id,
    name:        trimmed,
    description: '',
    logoEmoji:   '📡',
    sortOrder:   99,
    isPreset:    false,
    source:      'user',
    createdAt:   Date.now(),
  };

  // Persist to localStorage
  var existing = _loadUserChannels();
  // Deduplicate just in case
  var updated  = existing.filter(function (c) { return c.id !== id; });
  updated.push(newChannel);
  _saveUserChannels(updated);

  // Update canonical list
  _channels = _buildChannelList(
    _channels.filter(function (c) { return c.source === 'firestore' || c.source === 'preset'; }),
    updated
  );

  // Rebuild also incorporating all Firestore-sourced channels already in _channels
  _renderChannelPanel();

  console.log('[SNX-TV-CH] Created user channel:', trimmed, '(' + id + ')');

  if (typeof onSuccess === 'function') onSuccess(newChannel);
}

/* ════════════════════════════════════════════════════════════
   CHANNEL SELECTOR PANEL RENDERER
   Renders the #snxTvChannelPanel element.
════════════════════════════════════════════════════════════ */

/**
 * Rebuild the #snxTvChannelPanel DOM.
 * Called after every channel list change.
 */
function _renderChannelPanel() {
  var panel = document.getElementById('snxTvChannelPanel');
  if (!panel) return;

  var channels = _channels;
  var activeId = _selectedId || 'snx-ch-shadow-nexus-tv';

  if (!channels || channels.length === 0) {
    panel.innerHTML = '<div class="snx-tv-ch-loading">Loading channels…</div>';
    return;
  }

  var html = '<div class="snx-tv-ch-list">';
  for (var i = 0; i < channels.length; i++) {
    var ch       = channels[i];
    var isActive = (ch.id === activeId);
    var emoji    = ch.logoEmoji || '📺';
    var safeName = _esc(ch.name || ch.id);
    var safeDesc = _esc(ch.description || '');
    var safeId   = _esc(ch.id);

    html += '<button class="snx-tv-ch-btn' + (isActive ? ' snx-tv-ch-btn--active' : '') + '"'
      + ' data-channel-id="' + safeId + '"'
      + ' type="button"'
      + ' aria-label="Switch to ' + safeName + '">'
      + '<span class="snx-tv-ch-emoji">' + emoji + '</span>'
      + '<span class="snx-tv-ch-info">'
      +   '<span class="snx-tv-ch-name">' + safeName + '</span>'
      +   (safeDesc ? '<span class="snx-tv-ch-desc">' + safeDesc + '</span>' : '')
      + '</span>'
      + (isActive ? '<span class="snx-tv-ch-active-dot"></span>' : '')
      + '</button>';
  }
  html += '</div>';
  html += '<div class="snx-tv-ch-create-row">'
    + '<button class="snx-tv-ch-create-btn" id="snxTvChCreateBtn" type="button">'
    + '+ Create Channel'
    + '</button>'
    + '</div>';

  panel.innerHTML = html;

  // Bind channel buttons
  var buttons = panel.querySelectorAll('.snx-tv-ch-btn');
  for (var j = 0; j < buttons.length; j++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.channelId;
        _selectChannel(id);
      });
    })(buttons[j]);
  }

  // Bind create channel button
  var createBtn = panel.querySelector('#snxTvChCreateBtn');
  if (createBtn) {
    createBtn.addEventListener('click', _openCreateChannelModal);
  }
}

/* ════════════════════════════════════════════════════════════
   SELECT CHANNEL
════════════════════════════════════════════════════════════ */

/**
 * Select a channel — updates state, persists pref, re-renders panel, notifies snx-tv.js.
 * @param {string} channelId
 */
function _selectChannel(channelId) {
  if (!channelId) channelId = 'snx-ch-shadow-nexus-tv';

  // Validate
  if (!_channels.some(function (c) { return c.id === channelId; })) {
    console.warn('[SNX-TV-CH] Unknown channel:', channelId, '— ignoring.');
    return;
  }

  _selectedId = channelId;
  _saveSelectedId(channelId);
  _renderChannelPanel(); // re-render to show active dot on new channel

  // Notify TV core
  if (typeof _onSelectCallback === 'function') {
    _onSelectCallback(channelId);
  }
}

/* ════════════════════════════════════════════════════════════
   CREATE CHANNEL MODAL
   Simple inline modal — no new page.
════════════════════════════════════════════════════════════ */

var _createModalOpen = false;

function _openCreateChannelModal() {
  if (_createModalOpen) return;
  if (!_uid()) {
    _showCreateStatus('You must be signed in to create a channel.', true);
    return;
  }

  _createModalOpen = true;

  // Build modal
  var overlay = document.createElement('div');
  overlay.id        = 'snxTvChCreateOverlay';
  overlay.className = 'snx-tv-ch-modal-overlay';
  overlay.innerHTML =
    '<div class="snx-tv-ch-modal">'
    + '<div class="snx-tv-ch-modal-header">'
    +   '<span class="snx-tv-ch-modal-title">CREATE CHANNEL</span>'
    +   '<button class="snx-tv-ch-modal-close" id="snxTvChModalClose" type="button">✕</button>'
    + '</div>'
    + '<div class="snx-tv-ch-modal-body">'
    +   '<label class="snx-tv-ch-modal-label">Channel Name</label>'
    +   '<input class="snx-tv-ch-modal-input" id="snxTvChNameInput" type="text"'
    +     ' maxlength="80" placeholder="e.g. Chris Test TV" autocomplete="off">'
    +   '<div class="snx-tv-ch-modal-status" id="snxTvChModalStatus" style="display:none;"></div>'
    + '</div>'
    + '<div class="snx-tv-ch-modal-footer">'
    +   '<button class="snx-tv-ch-modal-cancel" id="snxTvChModalCancel" type="button">Cancel</button>'
    +   '<button class="snx-tv-ch-modal-submit" id="snxTvChModalSubmit" type="button">Create Channel</button>'
    + '</div>'
    + '</div>';

  document.body.appendChild(overlay);

  var input    = document.getElementById('snxTvChNameInput');
  var statusEl = document.getElementById('snxTvChModalStatus');
  var submitBtn = document.getElementById('snxTvChModalSubmit');

  function _close() {
    _createModalOpen = false;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function _setStatus(msg, isError) {
    if (!statusEl) return;
    statusEl.style.display  = 'block';
    statusEl.style.color    = isError ? '#ff7070' : '#00d45a';
    statusEl.textContent    = msg;
  }

  document.getElementById('snxTvChModalClose').addEventListener('click', _close);
  document.getElementById('snxTvChModalCancel').addEventListener('click', _close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) _close(); });

  if (input) {
    input.focus();
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitBtn && submitBtn.click();
      if (e.key === 'Escape') _close();
    });
  }

  submitBtn.addEventListener('click', function () {
    var name = input ? input.value : '';
    submitBtn.disabled = true;

    createChannel(
      name,
      function (newChannel) {
        // Success
        _setStatus('✓ Channel "' + _esc(newChannel.name) + '" created!', false);
        // Select the new channel
        _selectChannel(newChannel.id);
        // Close modal after short delay
        setTimeout(_close, 1400);
      },
      function (errMsg) {
        // Failure
        _setStatus('✗ ' + errMsg, true);
        submitBtn.disabled = false;
      }
    );
  });
}

function _showCreateStatus(msg, isError) {
  console[isError ? 'warn' : 'log']('[SNX-TV-CH]', msg);
}

/* ════════════════════════════════════════════════════════════
   UTILITY
════════════════════════════════════════════════════════════ */

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════
   AUTH EVENT — re-init when user signs in (gets uid for localStorage)
════════════════════════════════════════════════════════════ */

global.addEventListener('snxAuthStateChanged', function (e) {
  var user = e.detail && e.detail.user;
  if (!user) return;
  // Re-run init on sign-in so user channels from localStorage are loaded
  _initInProgress = false;
  _initDone       = false;
  // init() will be called by snx-tv.js pageOpen() after auth
  // But also trigger here in case pageOpen() already ran
  if (_unsubChannels === null) {
    setTimeout(function () { init(_onSelectCallback); }, 600);
  }
});

/* ════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */

global.SNXTVChannels = {
  /** Initialize the channel system. Call once from snx-tv.js pageOpen(). */
  init: init,

  /** Get the current canonical channel list. */
  getChannels: function () { return _channels.slice(); },

  /** Get the currently selected channel ID. */
  getSelectedId: function () { return _selectedId; },

  /** Programmatically select a channel (used by snx-tv.js _switchChannel). */
  setSelectedId: function (id) {
    _selectedId = id;
    _saveSelectedId(id);
    _renderChannelPanel();
  },

  /** Re-render the channel panel (called by snx-tv.js after switchChannel). */
  refresh: function () { _renderChannelPanel(); },

  /** Create a new channel (called by external code if needed). */
  createChannel: createChannel,

  /** Expose PRESET_CHANNELS for reference. */
  PRESET_CHANNELS: PRESET_CHANNELS,

  version: BUILD,
};

})(window);
