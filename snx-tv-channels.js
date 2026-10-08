/**
 * snx-tv-channels.js
 * Shadow Nexus Social — 24-Hour TV Channel Seeder
 * Build: SNS-2026-TV-CH-REBUILD-001
 *
 * PURPOSE:
 *   Preload the 5 default SNS TV channels into Firestore (tv_channels)
 *   using deterministic stable IDs. Idempotent — will NOT create duplicates
 *   and will NOT overwrite user-created or existing channels.
 *
 * STABLE IDs:
 *   Shadow Nexus TV  → snx-ch-shadow-nexus-tv
 *   Legend Music     → snx-ch-legend-music
 *   Shadow Music     → snx-ch-shadow-music
 *   Legend Videos    → snx-ch-legend-videos
 *   Shadow Mix       → snx-ch-shadow-mix
 *
 * The 'default' virtual channel remains as the backward-compat fallback.
 * These are additional preloaded channels that map to the viewer selector.
 *
 * EXPOSES: window.SNXTVChannels
 */

'use strict';

(function (global) {

const COLL_TV_CHANNELS = 'tv_channels';
const SEED_VERSION     = 'SNS-2026-TV-CH-REBUILD-001';

/* ════════════════════════════════════════════════════════════
   PRESET CHANNEL DEFINITIONS
   id MUST be stable and unique — never change these.
════════════════════════════════════════════════════════════ */

const PRESET_CHANNELS = [
  {
    id:          'snx-ch-shadow-nexus-tv',
    name:        'Shadow Nexus TV',
    description: 'Main general channel — all content, all day.',
    logoEmoji:   '📺',
    status:      'active',
    sortOrder:   1,
  },
  {
    id:          'snx-ch-legend-music',
    name:        'Legend Music',
    description: 'Music and music-video channel.',
    logoEmoji:   '🎵',
    status:      'active',
    sortOrder:   2,
  },
  {
    id:          'snx-ch-shadow-music',
    name:        'Shadow Music',
    description: 'Music and audio visualizer channel.',
    logoEmoji:   '🎧',
    status:      'active',
    sortOrder:   3,
  },
  {
    id:          'snx-ch-legend-videos',
    name:        'Legend Videos',
    description: 'Video, funny, and entertainment channel.',
    logoEmoji:   '🎬',
    status:      'active',
    sortOrder:   4,
  },
  {
    id:          'snx-ch-shadow-mix',
    name:        'Shadow Mix',
    description: 'Mixed music and video content.',
    logoEmoji:   '🔀',
    status:      'active',
    sortOrder:   5,
  },
];

/* ════════════════════════════════════════════════════════════
   FIREBASE HELPERS
════════════════════════════════════════════════════════════ */

function _fs() { return global._snxFirestore || {}; }
function _db() { const f = _fs(); return f.db || global._snxDb || null; }

/* ════════════════════════════════════════════════════════════
   SEED — idempotent, additive only
════════════════════════════════════════════════════════════ */

/**
 * Seed the preset channels into Firestore.
 * - Uses setDoc with merge:false only if the document does NOT already exist.
 * - Reads all existing channel docs first so we can check before writing.
 * - Never overwrites an existing document.
 * - Only runs when the user is signed in (requires auth for Firestore access).
 *
 * @returns {Promise<{created: number, skipped: number}>}
 */
async function seedChannels() {
  const { collection, doc, getDoc, setDoc, serverTimestamp } = _fs();
  const db = _db();
  if (!db) {
    console.warn('[SNX-TV-CHANNELS] Firestore not ready — seeding deferred.');
    return { created: 0, skipped: 0 };
  }

  let created = 0;
  let skipped = 0;

  for (const ch of PRESET_CHANNELS) {
    try {
      const ref  = doc(db, COLL_TV_CHANNELS, ch.id);
      const snap = await getDoc(ref);

      if (snap.exists()) {
        skipped++;
        continue; // already exists — never overwrite
      }

      // Create the channel document with the deterministic ID
      await setDoc(ref, {
        name:        ch.name,
        description: ch.description,
        logoEmoji:   ch.logoEmoji  || '',
        artworkUrl:  '',
        status:      ch.status     || 'active',
        sortOrder:   ch.sortOrder  || 99,
        isPreset:    true,           // marks it as a built-in preset channel
        seedVersion: SEED_VERSION,
        createdAt:   serverTimestamp(),
        updatedAt:   serverTimestamp(),
      });

      created++;
      console.log('[SNX-TV-CHANNELS] Created preset channel:', ch.name, '(', ch.id, ')');
    } catch (e) {
      // Non-fatal — a viewer without write permission will get a permission error.
      // The channel data still exists from a previous founder-seeded run.
      console.info('[SNX-TV-CHANNELS] Could not seed channel "' + ch.name + '" (non-fatal):', e.message);
      skipped++;
    }
  }

  console.log('[SNX-TV-CHANNELS] Seed complete —', created, 'created,', skipped, 'skipped.');
  return { created, skipped };
}

/* ════════════════════════════════════════════════════════════
   AUTO-SEED TRIGGER
   Runs once per page session after Firebase auth is ready.
   Guards against duplicate seeding within the same session
   using a sessionStorage flag.
════════════════════════════════════════════════════════════ */

var _seedAttempted = false;

function _tryAutoSeed() {
  if (_seedAttempted) return;

  const db = _db();
  if (!db) {
    // Firestore not ready yet — retry after a short delay
    setTimeout(_tryAutoSeed, 1500);
    return;
  }

  _seedAttempted = true;

  // Run seed on every page load (idempotent — getDoc prevents overwrites)
  seedChannels().catch(function (e) {
    console.info('[SNX-TV-CHANNELS] Auto-seed error (non-fatal):', e.message);
  });
}

/* ════════════════════════════════════════════════════════════
   VIEWER CHANNEL SELECTOR — standalone rebuild
   Builds a visible card-based channel list in #snxTvChannelPanel.
   Called by snx-tv.js after channels are loaded.
════════════════════════════════════════════════════════════ */

/**
 * Rebuild the viewer's channel panel UI.
 * Can be called from snx-tv.js whenever the channel list changes.
 *
 * @param {Array}   channels       — array of channel objects [{id, name, description, ...}]
 * @param {string}  activeId       — currently active channel ID
 * @param {function} onSelect      — callback(channelId) when a channel is tapped
 */
function buildChannelPanel(channels, activeId, onSelect) {
  var panel = document.getElementById('snxTvChannelPanel');
  if (!panel) return;

  if (!channels || !channels.length) {
    panel.innerHTML = '<div class="snx-tv-ch-empty">No channels available.</div>';
    return;
  }

  // Always include the 'default' virtual channel first if not already in list
  var list = channels.slice();
  var hasDefault = list.some(function (c) { return c.id === 'default'; });
  if (!hasDefault) {
    list = [{ id: 'default', name: 'Shadow Nexus TV', description: '24-Hour TV', logoEmoji: '📺' }].concat(list);
  }

  // Sort: default first, then by sortOrder, then name
  list.sort(function (a, b) {
    if (a.id === 'default') return -1;
    if (b.id === 'default') return  1;
    if (a.sortOrder !== b.sortOrder) return (a.sortOrder || 99) - (b.sortOrder || 99);
    return (a.name || '').localeCompare(b.name || '');
  });

  var html = '<div class="snx-tv-ch-list">';
  for (var i = 0; i < list.length; i++) {
    var ch        = list[i];
    var isActive  = (ch.id === (activeId || 'default'));
    var emoji     = ch.logoEmoji || '📺';
    var safeName  = _esc(ch.name || ch.id);
    var safeDesc  = _esc(ch.description || '');
    var safeId    = _esc(ch.id);

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

  panel.innerHTML = html;

  // Bind click events
  var buttons = panel.querySelectorAll('.snx-tv-ch-btn');
  for (var j = 0; j < buttons.length; j++) {
    (function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.dataset.channelId;
        if (typeof onSelect === 'function') {
          onSelect(id === 'default' ? null : id);
        }
      });
    })(buttons[j]);
  }
}

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ════════════════════════════════════════════════════════════
   AUTH EVENT — trigger seed when user signs in
════════════════════════════════════════════════════════════ */

// Trigger on auth state change (user signed in)
global.addEventListener('snxAuthStateChanged', function (e) {
  var user = e.detail && e.detail.user;
  if (!user) return;
  // Small delay to let Firestore connection settle after auth
  setTimeout(_tryAutoSeed, 800);
});

// Also try immediately in case Firebase is already initialised
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(_tryAutoSeed, 2000);
  });
} else {
  setTimeout(_tryAutoSeed, 2000);
}

/* ════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */

global.SNXTVChannels = {
  seedChannels:       seedChannels,
  buildChannelPanel:  buildChannelPanel,
  PRESET_CHANNELS:    PRESET_CHANNELS,
  version:            SEED_VERSION,
};

})(window);
