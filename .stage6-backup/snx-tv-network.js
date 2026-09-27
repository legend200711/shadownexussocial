/**
 * SNX TV NETWORK — UI Layer
 * snx-tv-network.js
 *
 * Unified SHADOW NEXUS TV tab bar + section router.
 * Works in both channel.html (standalone) and index.html (embedded tvPage) contexts.
 *
 * Tab routing:
 *   main-tv    → shows #ax-hero (channel.html) or #snxTvApp (index.html tvPage)
 *   live-now   → creator channels currently broadcasting
 *   channels   → permanent creator channel directory
 *   my-channel → current user's own creator channel
 *
 * This module NEVER modifies the broadcast engine or its playback state.
 * It only shows/hides the main TV container and injects its own panels beside it.
 */

import {
  doc, getDoc,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

import {
  ensureCreatorChannel,
  loadCreatorChannel,
  updateCreatorChannel,
  subscribeCreatorChannel,
  subscribeChannelDirectory,
  subscribeLiveChannels,
  loadReplays,
  publishReplay,
  deleteReplay,
  isFollowingChannel,
  followChannel,
  unfollowChannel,
  setNotificationPref,
  setMainTvFeaturePreference,
  loadUserProfile,
  getCurrentUser,
  snsDb,
} from './snx-creator-channels.js';

// Lazy-load the live UI module to avoid loading WebRTC code unnecessarily
let _liveModule = null;
async function _getLiveModule() {
  if (!_liveModule) _liveModule = await import('./snx-creator-live-viewer.js');
  return _liveModule;
}

/* ════════════════════════════════════
   STATE
════════════════════════════════════ */
let _activeTab       = 'main-tv';
let _user            = null;
let _myChannel       = null;
let _myUnsub         = null;    // realtime subscription for own channel
let _dirUnsub        = null;    // directory subscription
let _liveUnsub       = null;    // live-now subscription
let _mainTvUnsub     = null;    // Main TV state subscription
let _mainTvState     = null;    // cached mainTvState
let _liveChannels    = [];
let _allChannels     = [];
let _dirSearch       = '';

/* ════════════════════════════════════
   INIT
════════════════════════════════════ */

/**
 * Call from channel.html after auth resolves.
 * @param {object|null} user  — Firebase Auth user, or null if signed out
 */
export function initTvNetwork(user) {
  _user = user;
  _injectTabBar();
  _injectNetworkPanels();
  _startSubscriptions();
  if (user) _ensureMyChannel();

  // Handle deep-links from notifications
  const params = new URLSearchParams(location.search);
  const deepLiveUid   = params.get('live');
  const deepLiveId    = params.get('liveId');
  const deepReplayUid = params.get('replay');
  const deepReplayId  = params.get('replayId');

  if (deepReplayUid && deepReplayId && user) {
    // Open replay player — direct link from notification or feed post
    setTimeout(async () => {
      try {
        let userData = null;
        try {
          const { getDoc: gd, doc: d } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
          const snap = await gd(d(snsDb, 'users', user.uid));
          userData = snap.exists() ? snap.data() : null;
        } catch (_) {}
        const live = await _getLiveModule();
        const isOwner = user.uid === deepReplayUid;
        await live.openReplayPlayer(user, userData, deepReplayUid, deepReplayId, isOwner);
      } catch (e) { console.warn('[SNX TV] replay deep-link failed:', e.message); }
    }, 600);
    _switchTab('channels', true);
    return;
  }

  if (deepLiveUid && deepLiveId && user) {
    // Open viewer stage after a short delay (let auth + subscriptions settle)
    setTimeout(async () => {
      try {
        const ch = await import('./snx-creator-channels.js').then(m => m.loadCreatorChannel(deepLiveUid));
        let userData = null;
        try {
          const { getDoc: gd, doc: d } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
          const snap = await gd(d(snsDb, 'users', user.uid));
          userData = snap.exists() ? snap.data() : null;
        } catch (_) {}
        const live = await _getLiveModule();
        await live.openViewerLiveStage(user, userData, ch, deepLiveId);
      } catch (e) { console.warn('[SNX TV] deep-link open failed:', e.message); }
    }, 600);
    _switchTab('live-now', true);
    return;
  }

  _switchTab('main-tv', true);
}

/**
 * Called when auth state changes (sign in / sign out).
 * @param {object|null} user
 */
export function onTvNetworkAuthChange(user) {
  _user = user;
  const avatarEl = document.getElementById('snx-tn-my-avatar');
  if (avatarEl) {
    avatarEl.textContent = user ? (user.email || '?').charAt(0).toUpperCase() : '?';
  }
  if (user) {
    _ensureMyChannel();
  } else {
    _myChannel = null;
    _renderMyChannelSection();
  }
}

/* ════════════════════════════════════
   TAB BAR
════════════════════════════════════ */
function _injectTabBar() {
  // Don't inject twice
  if (document.getElementById('snx-tn-tabs')) return;

  const tabBar = document.createElement('div');
  tabBar.id = 'snx-tn-tabs';
  tabBar.className = 'snx-tn-tabs';
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', 'Shadow Nexus TV sections');
  tabBar.innerHTML = `
    <button class="snx-tn-tab active" data-tab="main-tv"    role="tab" aria-selected="true">📺 MAIN TV</button>
    <button class="snx-tn-tab"        data-tab="live-now"   role="tab" aria-selected="false"><span class="snx-tn-live-dot"></span> LIVE NOW <span class="snx-tn-live-count" id="snx-tn-live-count" style="display:none;"></span></button>
    <button class="snx-tn-tab"        data-tab="channels"   role="tab" aria-selected="false">📡 CHANNELS</button>
    <button class="snx-tn-tab"        data-tab="my-channel" role="tab" aria-selected="false">🎙 MY CHANNEL</button>
  `;

  // Insert tab bar immediately before the main TV container
  // Supports both channel.html (#ax-app) and index.html (#snxTvApp)
  const anchor = document.getElementById('ax-app') || document.getElementById('snxTvApp');
  if (anchor) {
    anchor.parentNode.insertBefore(tabBar, anchor);
  } else {
    document.body.appendChild(tabBar);
  }

  tabBar.querySelectorAll('.snx-tn-tab').forEach(btn => {
    btn.addEventListener('click', () => _switchTab(btn.dataset.tab));
  });
}

function _switchTab(tab, silent = false) {
  if (_activeTab === tab && !silent) return;

  // Leaving MAIN TV in index.html context: pause scheduled media to prevent
  // duplicate audio while browsing LIVE NOW / CHANNELS / MY CHANNEL.
  // The adapter's tick keeps advancing in the background — playback resumes on return.
  const wasMainTv = _activeTab === 'main-tv';
  if (wasMainTv && tab !== 'main-tv') {
    const vid = document.getElementById('ax-video');
    const aud = document.getElementById('ax-audio');
    if (vid && !vid.paused) { try { vid.pause(); } catch(_) {} }
    if (aud && !aud.paused) { try { aud.pause(); } catch(_) {} }
  }
  // Returning to MAIN TV: resume media
  if (!wasMainTv && tab === 'main-tv') {
    const vid = document.getElementById('ax-video');
    const aud = document.getElementById('ax-audio');
    if (vid && vid.src && vid.paused) { vid.play().catch(() => {}); }
    if (aud && aud.src && aud.paused) { aud.play().catch(() => {}); }
  }

  _activeTab = tab;

  // Update tab button states
  document.querySelectorAll('.snx-tn-tab').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  // Show/hide sections — support both channel.html (#ax-hero) and index.html (#snxTvApp)
  const mainTvEl = document.getElementById('ax-hero') || document.getElementById('snxTvApp');
  const liveNow  = document.getElementById('snx-tn-live-now');
  const channels = document.getElementById('snx-tn-channels');
  const myChannel= document.getElementById('snx-tn-my-channel');

  if (mainTvEl)  mainTvEl.style.display   = tab === 'main-tv'    ? '' : 'none';
  if (liveNow)   liveNow.style.display    = tab === 'live-now'   ? '' : 'none';
  if (channels)  channels.style.display   = tab === 'channels'   ? '' : 'none';
  if (myChannel) myChannel.style.display  = tab === 'my-channel' ? '' : 'none';

  // Render on demand
  if (tab === 'live-now')   _renderLiveNowSection();
  if (tab === 'channels')   _renderChannelsSection();
  if (tab === 'my-channel') _renderMyChannelSection();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ════════════════════════════════════
   NETWORK PANELS (containers)
════════════════════════════════════ */
function _injectNetworkPanels() {
  // Don't inject twice
  if (document.getElementById('snx-tn-wrapper')) return;

  // Support both channel.html (#ax-app) and index.html (#snxTvApp) contexts
  const anchor = document.getElementById('ax-app') || document.getElementById('snxTvApp');
  if (!anchor) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'snx-tn-wrapper';
  wrapper.innerHTML = `
    <div id="snx-tn-live-now"   class="snx-tn-section" style="display:none;"></div>
    <div id="snx-tn-channels"   class="snx-tn-section" style="display:none;"></div>
    <div id="snx-tn-my-channel" class="snx-tn-section" style="display:none;"></div>
  `;
  // Insert immediately after the anchor element so panels appear below the broadcast area
  anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
}

/* ════════════════════════════════════
   SUBSCRIPTIONS
════════════════════════════════════ */
function _startSubscriptions() {
  // Subscribe to live channels (for LIVE NOW badge + section)
  if (_liveUnsub) _liveUnsub();
  _liveUnsub = subscribeLiveChannels(channels => {
    _liveChannels = channels;
    // Expose live count for Network Status panel in snx-ch-adapter.js
    window._snxLiveChannelCount = channels.length;
    _updateLiveBadge();
    if (_activeTab === 'live-now') _renderLiveNowSection();
  });

  // Subscribe to full directory
  if (_dirUnsub) _dirUnsub();
  _dirUnsub = subscribeChannelDirectory(channels => {
    _allChannels = channels;
    if (_activeTab === 'channels') _renderChannelsSection();
  });

  // Subscribe to Main TV state for the LIVE NOW featured label
  if (!_mainTvUnsub) {
    import('./snx-main-tv-feature.js').then(({ subscribeMainTvState }) => {
      if (_mainTvUnsub) return; // double-check
      _mainTvUnsub = subscribeMainTvState(st => {
        _mainTvState = st;
        if (_activeTab === 'live-now') _renderLiveNowSection();
      });
    }).catch(() => {}); // non-critical — Live Now still works without it
  }

  // Handle snx:switchTvTab events from the adapter/broadcast Network Status panel
  window.addEventListener('snx:switchTvTab', e => {
    const tab = e?.detail?.tab;
    if (tab) _switchTab(tab);
  });
}

function _updateLiveBadge() {
  const countEl = document.getElementById('snx-tn-live-count');
  if (!countEl) return;
  const n = _liveChannels.length;
  if (n > 0) {
    countEl.textContent = String(n);
    countEl.style.display = '';
  } else {
    countEl.style.display = 'none';
  }
  // Pulse the dot on the LIVE NOW tab when channels are live
  const liveTab = document.querySelector('.snx-tn-tab[data-tab="live-now"]');
  if (liveTab) liveTab.classList.toggle('snx-tn-tab-live', n > 0);
}

/* ════════════════════════════════════
   MY CHANNEL — ensure + subscribe
════════════════════════════════════ */
async function _ensureMyChannel() {
  if (!_user) return;
  try {
    // Ensure the channel doc exists (idempotent)
    _myChannel = await ensureCreatorChannel(_user);
    // Subscribe to real-time updates
    if (_myUnsub) _myUnsub();
    _myUnsub = subscribeCreatorChannel(_user.uid, ch => {
      _myChannel = ch;
      if (_activeTab === 'my-channel') _renderMyChannelSection();
    });
    if (_activeTab === 'my-channel') _renderMyChannelSection();
  } catch (err) {
    console.warn('[SNX TV Network] ensureCreatorChannel error:', err.message);
  }
}

/* ════════════════════════════════════
   RENDER — LIVE NOW
════════════════════════════════════ */
function _renderLiveNowSection() {
  const el = document.getElementById('snx-tn-live-now');
  if (!el) return;

  if (!_liveChannels.length) {
    el.innerHTML = `
      <div class="snx-tn-page-header">
        <div class="snx-tn-page-title"><span class="snx-tn-live-dot"></span> LIVE NOW</div>
        <div class="snx-tn-page-sub">Creator channels currently broadcasting</div>
      </div>
      <div class="snx-tn-empty">
        <div class="snx-tn-empty-icon">📡</div>
        <div class="snx-tn-empty-title">NO CREATOR CHANNELS ARE LIVE RIGHT NOW</div>
        <div class="snx-tn-empty-sub">When creators go live, they appear here instantly.<br>Shadow Nexus Main TV is always on air.</div>
        <button class="snx-tn-btn-primary" id="snx-tn-watch-main-tv-btn" style="margin-top:14px;">📺 WATCH MAIN TV</button>
      </div>`;
    el.querySelector('#snx-tn-watch-main-tv-btn')?.addEventListener('click', () => _switchTab('main-tv'));
    return;
  }

  const cards = _liveChannels.map(ch => _buildChannelCard(ch, true)).join('');
  el.innerHTML = `
    <div class="snx-tn-page-header">
      <div class="snx-tn-page-title"><span class="snx-tn-live-dot"></span> LIVE NOW</div>
      <div class="snx-tn-page-sub">${_liveChannels.length} channel${_liveChannels.length !== 1 ? 's' : ''} broadcasting</div>
    </div>
    <div class="snx-tn-card-grid">${cards}</div>`;

  el.querySelectorAll('.snx-tn-card').forEach(card => {
    card.addEventListener('click', () => {
      const uid = card.dataset.uid;
      if (uid) _openLiveNowCard(uid);
    });
  });
}

/* ════════════════════════════════════
   LIVE NOW CARD CLICK — open viewer
════════════════════════════════════ */
async function _openLiveNowCard(uid) {
  // Find the channel's current liveId
  const ch = _liveChannels.find(c => (c.id || c.ownerUid) === uid);
  if (!ch) { _openChannelView(uid); return; }
  const liveId = ch.currentLiveId;
  if (!liveId) { _openChannelView(uid); return; }
  if (!_user) { _toast('Sign in to watch'); return; }
  let userData = null;
  try {
    const { getDoc: gd, doc: d } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
    const snap = await gd(d(snsDb, 'users', _user.uid));
    userData = snap.exists() ? snap.data() : null;
  } catch (_) {}
  const live = await _getLiveModule();
  await live.openViewerLiveStage(_user, userData, ch, liveId);
}

/* ════════════════════════════════════
   RENDER — CHANNEL DIRECTORY
════════════════════════════════════ */
function _renderChannelsSection() {
  const el = document.getElementById('snx-tn-channels');
  if (!el) return;

  const filtered = _filterChannels(_allChannels, _dirSearch);

  el.innerHTML = `
    <div class="snx-tn-page-header">
      <div class="snx-tn-page-title">📡 CHANNELS</div>
      <div class="snx-tn-page-sub">Permanent creator channels — browse, follow, and watch</div>
    </div>
    <div class="snx-tn-search-wrap">
      <input class="snx-tn-search" id="snx-tn-dir-search" type="search"
             placeholder="Search by channel name or username…"
             value="${_esc(_dirSearch)}" autocomplete="off">
    </div>
    ${filtered.length
      ? `<div class="snx-tn-card-grid">${filtered.map(ch => _buildChannelCard(ch)).join('')}</div>`
      : `<div class="snx-tn-empty">
           <div class="snx-tn-empty-icon">📡</div>
           <div class="snx-tn-empty-title">${_dirSearch ? 'No channels match your search' : 'No creator channels yet'}</div>
           <div class="snx-tn-empty-sub">${_dirSearch ? 'Try a different search term.' : 'Be the first! Open MY CHANNEL to create yours.'}</div>
         </div>`}
  `;

  document.getElementById('snx-tn-dir-search')?.addEventListener('input', e => {
    _dirSearch = e.target.value.trim();
    _renderChannelsSection();
  });

  el.querySelectorAll('.snx-tn-card').forEach(card => {
    card.addEventListener('click', () => {
      const uid = card.dataset.uid;
      if (uid) _openChannelView(uid);
    });
  });
}

function _filterChannels(channels, search) {
  if (!search) return channels;
  const s = search.toLowerCase();
  return channels.filter(ch =>
    (ch.channelName || '').toLowerCase().includes(s) ||
    (ch.ownerUsername || '').toLowerCase().includes(s),
  );
}

/* ════════════════════════════════════
   RENDER — MY CHANNEL
════════════════════════════════════ */
function _renderMyChannelSection() {
  const el = document.getElementById('snx-tn-my-channel');
  if (!el) return;

  if (!_user) {
    el.innerHTML = `
      <div class="snx-tn-page-header">
        <div class="snx-tn-page-title">🎙 MY CHANNEL</div>
      </div>
      <div class="snx-tn-empty">
        <div class="snx-tn-empty-icon">🔒</div>
        <div class="snx-tn-empty-title">Sign in to access your channel</div>
        <div class="snx-tn-empty-sub">Your permanent creator channel is linked to your Shadow Nexus account.</div>
        <a class="snx-tn-btn-primary" href="index.html">Sign in to Shadow Nexus</a>
      </div>`;
    return;
  }

  if (!_myChannel) {
    el.innerHTML = `
      <div class="snx-tn-page-header">
        <div class="snx-tn-page-title">🎙 MY CHANNEL</div>
      </div>
      <div class="snx-tn-empty">
        <div class="snx-tn-loading-spinner"></div>
        <div class="snx-tn-empty-sub">Loading your channel…</div>
      </div>`;
    return;
  }

  const ch = _myChannel;
  const isLive = ch.status === 'live';
  const avatarLetter = (ch.channelName || _user.email || '?').charAt(0).toUpperCase();

  el.innerHTML = `
    <div class="snx-tn-page-header">
      <div class="snx-tn-page-title">🎙 MY CHANNEL</div>
    </div>

    <div class="snx-tn-my-profile-card">
      <!-- Cover image -->
      <div class="snx-tn-cover" id="snx-tn-cover-wrap"
           style="${ch.coverImage ? `background-image:url('${_esc(ch.coverImage)}');background-size:cover;background-position:center;` : ''}">
        ${!ch.coverImage ? '<div class="snx-tn-cover-placeholder">SHADOW NEXUS TV NETWORK</div>' : ''}
      </div>

      <!-- Profile row -->
      <div class="snx-tn-profile-row">
        <div class="snx-tn-channel-avatar" id="snx-tn-my-avatar">
          ${ch.avatar ? `<img src="${_esc(ch.avatar)}" alt="channel avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : avatarLetter}
        </div>
        <div class="snx-tn-profile-info">
          <div class="snx-tn-channel-name">${_esc(ch.channelName)}</div>
          <div class="snx-tn-channel-handle">@${_esc(ch.ownerUsername || _user.email?.split('@')[0] || 'creator')}</div>
          <div class="snx-tn-status-row">
            <span class="snx-tn-status-badge ${isLive ? 'live' : 'offline'}">
              ${isLive ? '🔴 LIVE' : '⚫ OFF AIR'}
            </span>
            <span class="snx-tn-followers-count">Followers: ${ch.followersCount || 0}</span>
          </div>
        </div>
        <div class="snx-tn-profile-actions">
          <button class="snx-tn-btn-edit" id="snx-tn-edit-btn">✏️ Edit Channel</button>
        </div>
      </div>

      <!-- Go Live / End Live button -->
      <div class="snx-tn-go-live-wrap">
        ${isLive
          ? `<button class="snx-tn-btn-end-live" id="snx-tn-end-live-btn">■ END BROADCAST</button>`
          : `<button class="snx-tn-btn-go-live" id="snx-tn-go-live-btn">🔴 GO LIVE</button>`}
      </div>

      <!-- Stage 4: Main TV Feature opt-out toggle -->
      <div class="snx-tn-inner-section" style="padding:10px 14px;border-top:1px solid rgba(255,255,255,0.05);">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:11px;color:#8a9bc0;user-select:none;">
          <input type="checkbox" id="snx-tn-main-tv-toggle"
                 style="accent-color:#00AEEF;cursor:pointer;"
                 ${ch.allowMainTvFeature !== false ? 'checked' : ''}>
          <span>
            <strong style="color:#c8d0e8;">Allow Main TV Feature</strong>
            <span style="display:block;font-size:10px;margin-top:1px;">
              Let the founder temporarily carry your live broadcast on Shadow Nexus Main TV.
            </span>
          </span>
        </label>
      </div>

      <!-- Channel tabs -->
      <div class="snx-tn-channel-inner-tabs">
        <button class="snx-tn-inner-tab active" data-inner="home">HOME</button>
        <button class="snx-tn-inner-tab" data-inner="replays">REPLAYS</button>
        <button class="snx-tn-inner-tab" data-inner="about">ABOUT</button>
      </div>
      <div id="snx-tn-inner-content"></div>
    </div>
  `;

  // Default inner tab
  _renderMyChannelInner('home', ch, isLive);

  // Inner tab events
  el.querySelectorAll('.snx-tn-inner-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.snx-tn-inner-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _renderMyChannelInner(btn.dataset.inner, ch, isLive);
    });
  });

  // Main TV feature opt-out toggle
  document.getElementById('snx-tn-main-tv-toggle')?.addEventListener('change', async e => {
    try {
      await setMainTvFeaturePreference(_user.uid, e.target.checked);
      _toast(e.target.checked ? '✓ Main TV feature allowed.' : '✓ Main TV feature disabled.');
    } catch (err) {
      _toast('Error saving preference.', 'error');
      e.target.checked = !e.target.checked; // revert
    }
  });

  // Go Live
  document.getElementById('snx-tn-go-live-btn')?.addEventListener('click', () => {
    _showGoLiveDialog(ch);
  });

  // End Live
  document.getElementById('snx-tn-end-live-btn')?.addEventListener('click', () => {
    _confirmEndLive(ch);
  });

  // Edit Channel
  document.getElementById('snx-tn-edit-btn')?.addEventListener('click', () => {
    _showEditChannelDialog(ch);
  });
}

function _renderMyChannelInner(tab, ch, isLive) {
  const content = document.getElementById('snx-tn-inner-content');
  if (!content) return;

  if (tab === 'home') {
    content.innerHTML = `
      <div class="snx-tn-inner-section">
        ${isLive
          ? `<div class="snx-tn-live-banner">
               🔴 You are currently live
               <button class="snx-tn-btn-sm" id="snx-tn-watch-own-live">WATCH YOUR STREAM</button>
             </div>`
          : ''}
        <div class="snx-tn-section-label">Recent Replays</div>
        <div id="snx-tn-recent-replays-home">
          <div class="snx-tn-loading-small">Loading replays…</div>
        </div>
      </div>`;

    // Load recent replays
    loadReplays(_user.uid, true).then(replays => {
      const rEl = document.getElementById('snx-tn-recent-replays-home');
      if (!rEl) return;
      if (!replays.length) {
        rEl.innerHTML = `<div class="snx-tn-empty-small">No replays yet. Go live to create your first replay.</div>`;
      } else {
        rEl.innerHTML = replays.slice(0, 6).map(r => _buildReplayCard(r, true)).join('');
        _wireReplayActions(rEl, _user.uid);
        _wireReplayPlayerOpen(rEl, _user.uid, true);
      }
    });
  }

  if (tab === 'replays') {
    content.innerHTML = `
      <div class="snx-tn-inner-section">
        <div class="snx-tn-section-label">All Replays</div>

        <!-- Status filter tabs -->
        <div class="snx-tn-replay-filter-tabs" id="snx-tn-replay-filter-tabs">
          <button class="snx-tn-replay-filter active" data-filter="all">ALL</button>
          <button class="snx-tn-replay-filter" data-filter="public">PUBLISHED</button>
          <button class="snx-tn-replay-filter" data-filter="private">PRIVATE</button>
          <button class="snx-tn-replay-filter" data-filter="processing">PROCESSING</button>
          <button class="snx-tn-replay-filter" data-filter="failed">FAILED</button>
        </div>

        <div id="snx-tn-replays-list">
          <div class="snx-tn-loading-small">Loading replays…</div>
        </div>
      </div>`;

    loadReplays(_user.uid, true).then(replays => {
      const rEl = document.getElementById('snx-tn-replays-list');
      const filterBar = document.getElementById('snx-tn-replay-filter-tabs');
      if (!rEl) return;

      let activeFilter = 'all';

      function _renderFiltered() {
        let filtered = replays;
        if (activeFilter === 'public') filtered = replays.filter(r => r.visibility === 'public' && r.processingStatus !== 'processing' && r.processingStatus !== 'failed');
        else if (activeFilter === 'private') filtered = replays.filter(r => r.visibility === 'private' && r.processingStatus !== 'processing' && r.processingStatus !== 'failed');
        else if (activeFilter === 'processing') filtered = replays.filter(r => r.processingStatus === 'processing');
        else if (activeFilter === 'failed') filtered = replays.filter(r => r.processingStatus === 'failed');

        if (!filtered.length) {
          rEl.innerHTML = `<div class="snx-tn-empty-small">No replays in this category.</div>`;
          return;
        }
        rEl.innerHTML = filtered.map(r => _buildReplayCard(r, true)).join('');
        _wireReplayActions(rEl, _user.uid);
        _wireReplayPlayerOpen(rEl, _user.uid, true);
      }

      _renderFiltered();

      filterBar?.querySelectorAll('.snx-tn-replay-filter').forEach(btn => {
        btn.addEventListener('click', () => {
          filterBar.querySelectorAll('.snx-tn-replay-filter').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          activeFilter = btn.dataset.filter;
          _renderFiltered();
        });
      });
    });
  }

  if (tab === 'about') {
    content.innerHTML = `
      <div class="snx-tn-inner-section">
        <div class="snx-tn-section-label">About This Channel</div>
        <div class="snx-tn-about-text">${_esc(ch.channelDescription) || '<span style="color:#5a80a8;">No description yet. Edit your channel to add one.</span>'}</div>
        <div class="snx-tn-about-meta">
          <div>Channel created via Shadow Nexus Social account</div>
          <div style="color:#5a80a8;font-size:11px;margin-top:4px;">Channel ID: ${_esc(ch.ownerUid || '')}</div>
        </div>
      </div>`;
  }
}

/* ════════════════════════════════════
   GO LIVE — launches real live stage
════════════════════════════════════ */
async function _showGoLiveDialog(ch) {
  if (!_user) { _toast('Sign in required'); return; }
  // Check the feature gate (mirrors live.html's check)
  try {
    const ctrl = JSON.parse(localStorage.getItem('founderFeatureControls') || '{}');
    if (ctrl.liveEnabled === false) {
      _toast('Live streaming is temporarily disabled by the founder.');
      return;
    }
  } catch (_) {}

  // Load userData
  let userData = null;
  try {
    const { getDoc: gd, doc: d } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
    const snap = await gd(d(snsDb, 'users', _user.uid));
    userData = snap.exists() ? snap.data() : null;
  } catch (_) {}

  const live = await _getLiveModule();
  await live.openHostLiveStage(_user, userData, ch);
}

/* ════════════════════════════════════
   END LIVE — from MY CHANNEL (if already live but stage was closed)
   The live stage has its own END LIVE button.
   This is a fallback for the MY CHANNEL card button.
════════════════════════════════════ */
async function _confirmEndLive(ch) {
  // If the live stage is open, it handles its own confirm dialog.
  // If the host closed the stage without ending, we need a recovery path.
  const overlay = document.getElementById('snx-crl-overlay');
  if (overlay && overlay.style.display !== 'none') {
    // Stage is open — bring it to front and let it handle the end confirm
    overlay.style.zIndex = '1900';
    return;
  }
  // Stage is not open but channel is still live — emergency end
  const existing = document.getElementById('snx-tn-end-live-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'snx-tn-end-live-modal';
  modal.className = 'snx-tn-modal-overlay';
  modal.innerHTML = `
    <div class="snx-tn-modal-box">
      <div class="snx-tn-modal-title">■ END BROADCAST</div>
      <div class="snx-tn-modal-sub">End the active broadcast on <strong>${_esc(ch.channelName)}</strong>?</div>
      <div class="snx-tn-modal-info snx-tn-modal-info-future">
        <div>Your channel will return to OFF AIR status</div>
      </div>
      <div id="snx-tn-end-live-err" style="color:#ff3344;font-size:12px;min-height:18px;"></div>
      <div class="snx-tn-modal-actions">
        <button class="snx-tn-btn-ghost" id="snx-tn-end-live-cancel">CANCEL</button>
        <button class="snx-tn-btn-end-live" id="snx-tn-end-live-confirm">■ END BROADCAST</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('snx-tn-end-live-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('snx-tn-end-live-confirm').addEventListener('click', async () => {
    const errEl = document.getElementById('snx-tn-end-live-err');
    const btn = document.getElementById('snx-tn-end-live-confirm');
    btn.disabled = true; btn.textContent = 'Ending…';
    try {
      const { endCreatorBroadcast } = await import('./snx-creator-live.js');
      await endCreatorBroadcast(_user.uid);
      modal.remove();
      _toast('⚫ Broadcast ended.');
    } catch (err) {
      errEl.textContent = err.message || 'Failed to end broadcast.';
      btn.disabled = false; btn.textContent = '■ END BROADCAST';
    }
  });
}

/* ════════════════════════════════════
   EDIT CHANNEL DIALOG
════════════════════════════════════ */
function _showEditChannelDialog(ch) {
  const existing = document.getElementById('snx-tn-edit-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'snx-tn-edit-modal';
  modal.className = 'snx-tn-modal-overlay';
  modal.innerHTML = `
    <div class="snx-tn-modal-box">
      <div class="snx-tn-modal-title">✏️ EDIT CHANNEL</div>
      <div class="snx-tn-field-group">
        <label class="snx-tn-field-label">Channel Name</label>
        <input class="snx-tn-field-input" id="snx-tn-edit-name" maxlength="60"
               value="${_esc(ch.channelName || '')}">
      </div>
      <div class="snx-tn-field-group">
        <label class="snx-tn-field-label">Channel Description</label>
        <textarea class="snx-tn-field-input" id="snx-tn-edit-desc" rows="3" maxlength="300"
                  style="resize:vertical;">${_esc(ch.channelDescription || '')}</textarea>
      </div>
      <div class="snx-tn-field-group">
        <label class="snx-tn-field-label">Avatar URL <span style="font-size:10px;color:#5a80a8;">(optional)</span></label>
        <input class="snx-tn-field-input" id="snx-tn-edit-avatar" type="url"
               placeholder="https://…" value="${_esc(ch.avatar || '')}">
      </div>
      <div class="snx-tn-field-group">
        <label class="snx-tn-field-label">Cover Image URL <span style="font-size:10px;color:#5a80a8;">(optional)</span></label>
        <input class="snx-tn-field-input" id="snx-tn-edit-cover" type="url"
               placeholder="https://…" value="${_esc(ch.coverImage || '')}">
      </div>
      <div id="snx-tn-edit-err" style="color:#ff3344;font-size:12px;min-height:18px;"></div>
      <div class="snx-tn-modal-actions">
        <button class="snx-tn-btn-ghost" id="snx-tn-edit-cancel">CANCEL</button>
        <button class="snx-tn-btn-primary" id="snx-tn-edit-save">SAVE CHANGES</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  document.getElementById('snx-tn-edit-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  document.getElementById('snx-tn-edit-save').addEventListener('click', async () => {
    const errEl = document.getElementById('snx-tn-edit-err');
    const name = document.getElementById('snx-tn-edit-name')?.value.trim();
    const desc = document.getElementById('snx-tn-edit-desc')?.value.trim();
    const avatar = document.getElementById('snx-tn-edit-avatar')?.value.trim();
    const cover = document.getElementById('snx-tn-edit-cover')?.value.trim();
    const btn = document.getElementById('snx-tn-edit-save');

    if (!name) { errEl.textContent = 'Channel name is required.'; return; }
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      await updateCreatorChannel(_user.uid, {
        channelName: name,
        channelDescription: desc || '',
        avatar: avatar || null,
        coverImage: cover || null,
      });
      modal.remove();
      _toast('Channel updated!');
    } catch (err) {
      errEl.textContent = err.message || 'Save failed.';
      btn.disabled = false; btn.textContent = 'SAVE CHANGES';
    }
  });
}

/* ════════════════════════════════════
   RENDER — CHANNEL VIEW (individual)
════════════════════════════════════ */
function _openChannelView(uid) {
  const el = document.getElementById('snx-tn-live-now') || document.getElementById('snx-tn-channels');
  // Navigate to a dedicated sub-view within the current section
  const targetEl = _activeTab === 'live-now'
    ? document.getElementById('snx-tn-live-now')
    : document.getElementById('snx-tn-channels');
  if (!targetEl) return;

  // Show a loading state while we fetch
  targetEl.innerHTML = `
    <button class="snx-tn-back-btn" id="snx-tn-channel-view-back">← Back</button>
    <div class="snx-tn-loading-spinner" style="margin:60px auto;"></div>`;

  document.getElementById('snx-tn-channel-view-back')?.addEventListener('click', () => {
    if (_activeTab === 'live-now') _renderLiveNowSection();
    else _renderChannelsSection();
  });

  // Fetch channel + user profile
  Promise.all([loadCreatorChannel(uid), loadUserProfile(uid), loadReplays(uid, false)])
    .then(([ch, profile, replays]) => {
      if (!ch) {
        targetEl.innerHTML = `
          <button class="snx-tn-back-btn" id="snx-tn-channel-view-back">← Back</button>
          <div class="snx-tn-empty"><div class="snx-tn-empty-title">Channel not found</div></div>`;
        document.getElementById('snx-tn-channel-view-back')?.addEventListener('click', () => {
          if (_activeTab === 'live-now') _renderLiveNowSection();
          else _renderChannelsSection();
        });
        return;
      }
      _renderChannelView(targetEl, ch, profile, replays);
    })
    .catch(err => {
      console.warn('[SNX TV] Channel view error:', err);
      targetEl.innerHTML = `
        <button class="snx-tn-back-btn" id="snx-tn-channel-view-back">← Back</button>
        <div class="snx-tn-empty"><div class="snx-tn-empty-title">Failed to load channel</div></div>`;
      document.getElementById('snx-tn-channel-view-back')?.addEventListener('click', () => {
        if (_activeTab === 'live-now') _renderLiveNowSection();
        else _renderChannelsSection();
      });
    });
}

function _renderChannelView(el, ch, profile, replays) {
  const isLive = ch.status === 'live';
  const avatarLetter = (ch.channelName || '?').charAt(0).toUpperCase();
  const username = profile?.username || ch.ownerUid?.substring(0, 8) || 'creator';
  const isOwnChannel = _user && _user.uid === ch.ownerUid;

  el.innerHTML = `
    <button class="snx-tn-back-btn" id="snx-tn-channel-view-back">← Back</button>

    <div class="snx-tn-my-profile-card">
      <div class="snx-tn-cover"
           style="${ch.coverImage ? `background-image:url('${_esc(ch.coverImage)}');background-size:cover;background-position:center;` : ''}">
        ${!ch.coverImage ? '<div class="snx-tn-cover-placeholder">SHADOW NEXUS TV NETWORK</div>' : ''}
      </div>

      <div class="snx-tn-profile-row">
        <div class="snx-tn-channel-avatar">
          ${ch.avatar ? `<img src="${_esc(ch.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : avatarLetter}
        </div>
        <div class="snx-tn-profile-info">
          <div class="snx-tn-channel-name">${_esc(ch.channelName)}</div>
          <div class="snx-tn-channel-handle">@${_esc(username)}</div>
          <div class="snx-tn-status-row">
            <span class="snx-tn-status-badge ${isLive ? 'live' : 'offline'}">
              ${isLive ? '🔴 LIVE' : '⚫ OFF AIR'}
            </span>
            <span class="snx-tn-followers-count">Followers: ${ch.followersCount || 0}</span>
          </div>
        </div>
        ${!isOwnChannel && _user ? `
          <div class="snx-tn-profile-actions" id="snx-tn-follow-area">
            <div class="snx-tn-loading-small">…</div>
          </div>` : ''}
      </div>

      ${isLive ? `
        <div class="snx-tn-go-live-wrap">
          <button class="snx-tn-btn-go-live" id="snx-tn-watch-live-btn">🔴 WATCH LIVE</button>
        </div>` : ''}

      <div class="snx-tn-channel-inner-tabs">
        <button class="snx-tn-inner-tab active" data-inner="home">HOME</button>
        <button class="snx-tn-inner-tab" data-inner="replays">REPLAYS</button>
        <button class="snx-tn-inner-tab" data-inner="about">ABOUT</button>
      </div>
      <div id="snx-tn-inner-content"></div>
    </div>`;

  // Back button
  document.getElementById('snx-tn-channel-view-back')?.addEventListener('click', () => {
    if (_activeTab === 'live-now') _renderLiveNowSection();
    else _renderChannelsSection();
  });

  // Watch live — open viewer stage
  document.getElementById('snx-tn-watch-live-btn')?.addEventListener('click', async () => {
    const liveId = ch.currentLiveId;
    if (!liveId) { _toast('Stream not available'); return; }
    if (!_user) { _toast('Sign in to watch'); return; }
    let userData = null;
    try {
      const { getDoc: gd, doc: d } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
      const snap = await gd(d(snsDb, 'users', _user.uid));
      userData = snap.exists() ? snap.data() : null;
    } catch (_) {}
    const live = await _getLiveModule();
    await live.openViewerLiveStage(_user, userData, ch, liveId);
  });

  // Follow area
  if (!isOwnChannel && _user) {
    const followArea = document.getElementById('snx-tn-follow-area');
    isFollowingChannel(ch.ownerUid, _user.uid).then(following => {
      if (!followArea) return;
      followArea.innerHTML = `
        <button class="snx-tn-btn-follow ${following ? 'following' : ''}" id="snx-tn-follow-btn">
          ${following ? '✓ Following' : '+ Follow'}
        </button>
        ${following ? `<div class="snx-tn-notif-pref" id="snx-tn-notif-wrap">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#8a9bc0;">
            <input type="checkbox" id="snx-tn-notif-toggle" style="accent-color:#00AEEF;" checked>
            🔔 Live Notifications
          </label>
        </div>` : ''}`;

      // Load notif pref
      if (following && snsDb) {
        const prefRef = doc(snsDb, 'channelFollows', ch.ownerUid, 'followers', _user.uid);
        getDoc(prefRef).then(snap => {
          const tog = document.getElementById('snx-tn-notif-toggle');
          if (tog && snap.exists()) tog.checked = snap.data().notificationsEnabled !== false;
        }).catch(() => {});
      }

      document.getElementById('snx-tn-follow-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('snx-tn-follow-btn');
        const isNowFollowing = btn.classList.contains('following');
        btn.disabled = true;
        try {
          if (isNowFollowing) {
            await unfollowChannel(ch.ownerUid, _user.uid);
            btn.classList.remove('following');
            btn.textContent = '+ Follow';
            const nw = document.getElementById('snx-tn-notif-wrap');
            if (nw) nw.remove();
          } else {
            await followChannel(ch.ownerUid, _user.uid);
            btn.classList.add('following');
            btn.textContent = '✓ Following';
            followArea.innerHTML += `<div class="snx-tn-notif-pref" id="snx-tn-notif-wrap">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:#8a9bc0;">
                <input type="checkbox" id="snx-tn-notif-toggle" style="accent-color:#00AEEF;" checked>
                🔔 Live Notifications
              </label>
            </div>`;
          }
        } catch (_) {}
        btn.disabled = false;
      });

      document.getElementById('snx-tn-notif-toggle')?.addEventListener('change', async e => {
        try { await setNotificationPref(ch.ownerUid, _user.uid, e.target.checked); } catch (_) {}
      });
    });
  }

  // Inner tabs
  el.querySelectorAll('.snx-tn-inner-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.snx-tn-inner-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _renderViewerInner(btn.dataset.inner, ch, replays);
    });
  });

  _renderViewerInner('home', ch, replays);
}

function _renderViewerInner(tab, ch, replays) {
  const content = document.getElementById('snx-tn-inner-content');
  if (!content) return;

  if (tab === 'home') {
    // Show LIVE NOW banner above replays if creator is currently live (spec §9)
    const isLive = ch.status === 'live';
    content.innerHTML = `
      <div class="snx-tn-inner-section">
        ${isLive ? `
          <div class="snx-tn-live-banner" style="margin-bottom:12px;">
            🔴 LIVE NOW
            <button class="snx-tn-btn-sm" id="snx-tn-watch-live-inner">WATCH LIVE</button>
          </div>
          <div class="snx-tn-section-label">Recent Replays</div>
        ` : '<div class="snx-tn-section-label">Recent Replays</div>'}
        ${replays.length
          ? replays.slice(0, 4).map(r => _buildReplayCard(r, false)).join('')
          : '<div class="snx-tn-empty-small">No replays yet.</div>'}
      </div>`;
    if (isLive) {
      content.querySelector('#snx-tn-watch-live-inner')?.addEventListener('click', async () => {
        const liveId = ch.currentLiveId;
        if (!liveId || !_user) return;
        let userData = null;
        try {
          const { getDoc: gd, doc: d } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
          const snap = await gd(d(snsDb, 'users', _user.uid));
          userData = snap.exists() ? snap.data() : null;
        } catch (_) {}
        const live = await _getLiveModule();
        await live.openViewerLiveStage(_user, userData, ch, liveId);
      });
    }
    _wireReplayPlayerOpen(content, ch.ownerUid, false);
  }
  if (tab === 'replays') {
    content.innerHTML = `
      <div class="snx-tn-inner-section">
        <div class="snx-tn-section-label">All Replays</div>
        ${replays.length
          ? replays.map(r => _buildReplayCard(r, false)).join('')
          : '<div class="snx-tn-empty-small">No replays available.</div>'}
      </div>`;
    _wireReplayPlayerOpen(content, ch.ownerUid, false);
  }
  if (tab === 'about') {
    content.innerHTML = `
      <div class="snx-tn-inner-section">
        <div class="snx-tn-section-label">About</div>
        <div class="snx-tn-about-text">${_esc(ch.channelDescription) || '<span style="color:#5a80a8;">No description.</span>'}</div>
      </div>`;
  }
}

/* ════════════════════════════════════
   CARD BUILDERS
════════════════════════════════════ */
function _buildChannelCard(ch, forceShowLive = false) {
  const isLive = ch.status === 'live';
  const uid = ch.id || ch.ownerUid;
  const isFeatured = _mainTvState?.mode === 'featured_live'
    && _mainTvState?.featuredCreatorUid === uid;
  const avatarLetter = (ch.channelName || '?').charAt(0).toUpperCase();
  return `
    <div class="snx-tn-card ${isLive ? 'snx-tn-card-live' : ''} ${isFeatured ? 'snx-tn-card-featured' : ''}" data-uid="${_esc(uid)}" role="button" tabindex="0">
      <div class="snx-tn-card-avatar">
        ${ch.avatar ? `<img src="${_esc(ch.avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">` : avatarLetter}
        ${isLive ? '<span class="snx-tn-card-live-ring"></span>' : ''}
      </div>
      <div class="snx-tn-card-info">
        <div class="snx-tn-card-name">${_esc(ch.channelName)}</div>
        <div class="snx-tn-card-handle">@${_esc(ch.ownerUsername || ch.ownerUid?.substring(0, 8) || 'creator')}</div>
        <div class="snx-tn-card-meta">
          <span class="snx-tn-status-badge-sm ${isLive ? 'live' : 'offline'}">${isLive ? '🔴 LIVE' : '⚫ OFF AIR'}</span>
          ${isFeatured ? '<span class="snx-tn-featured-badge">📺 FEATURED ON MAIN TV</span>' : ''}
          <span class="snx-tn-card-followers">${ch.followersCount || 0} followers</span>
        </div>
      </div>
    </div>`;
}

function _buildReplayCard(replay, isOwner) {
  const visLabel  = { public: '📡 Public', followers: '👥 Followers', private: '🔒 Private' };
  const procLabel = { processing: '⏳ Processing', failed: '⚠ Failed', ready: '' };
  const rId       = replay.replayId || replay.id;
  const proc      = replay.processingStatus || 'ready';
  const isPlayable = proc !== 'failed' && proc !== 'processing';
  return `
    <div class="snx-tn-replay-card ${isPlayable ? 'snx-tn-replay-playable' : ''}"
         data-replay-id="${_esc(rId)}"
         data-creator-uid="${_esc(replay.creatorUid || '')}"
         data-vis="${_esc(replay.visibility || 'private')}"
         role="${isPlayable ? 'button' : 'article'}"
         tabindex="${isPlayable ? '0' : '-1'}">
      <div class="snx-tn-replay-thumb">
        ${replay.thumbnail ? `<img src="${_esc(replay.thumbnail)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : '<div class="snx-tn-replay-thumb-placeholder">▶</div>'}
        ${replay.duration ? `<span class="snx-tn-replay-duration">${_fmtDuration(replay.duration)}</span>` : ''}
        ${proc === 'processing' ? '<div class="snx-tn-replay-proc-overlay">⏳</div>' : ''}
        ${proc === 'failed' ? '<div class="snx-tn-replay-proc-overlay snx-tn-replay-proc-failed">⚠</div>' : ''}
      </div>
      <div class="snx-tn-replay-info">
        <div class="snx-tn-replay-title">${_esc(replay.title || 'Live Replay')}</div>
        <div class="snx-tn-replay-meta">
          ${isOwner ? `<span class="snx-tn-replay-vis snx-tn-vis-${replay.visibility || 'private'}">${visLabel[replay.visibility] || '🔒 Private'}</span>` : ''}
          ${proc !== 'ready' ? `<span class="snx-tn-replay-proc-badge snx-tn-proc-${proc}">${procLabel[proc] || ''}</span>` : ''}
          <span>${(replay.replayViews || replay.viewCount || 0).toLocaleString()} views</span>
        </div>
        ${isOwner ? `
        <div class="snx-tn-replay-actions">
          ${proc === 'failed' ? `<button class="snx-tn-replay-action-btn snx-tn-replay-delete-btn" data-replay-id="${_esc(rId)}" title="Delete failed recording">🗑 DELETE</button>` : `
          ${(replay.visibility !== 'public') ? `<button class="snx-tn-replay-action-btn snx-tn-replay-publish-btn" data-replay-id="${_esc(rId)}" title="Post as public">📡 POST</button>` : ''}
          ${(replay.visibility !== 'private') ? `<button class="snx-tn-replay-action-btn snx-tn-replay-private-btn" data-replay-id="${_esc(rId)}" title="Make private">🔒 PRIVATE</button>` : ''}
          <button class="snx-tn-replay-action-btn snx-tn-replay-delete-btn" data-replay-id="${_esc(rId)}" title="Delete replay">🗑 DELETE</button>`}
        </div>` : ''}
      </div>
    </div>`;
}

/**
 * Wire replay card click → open replay player.
 * Only wires playable cards (not processing or failed).
 * @param {HTMLElement} container
 * @param {string} creatorUid
 * @param {boolean} isOwner
 */
function _wireReplayPlayerOpen(container, creatorUid, isOwner) {
  if (!container) return;
  container.querySelectorAll('.snx-tn-replay-playable').forEach(card => {
    card.addEventListener('click', async e => {
      // Don't open player if an action button was clicked
      if (e.target.closest('.snx-tn-replay-actions')) return;
      const rId = card.dataset.replayId;
      const cUid = card.dataset.creatorUid || creatorUid;
      if (!rId) return;
      let userData = null;
      if (_user) {
        try {
          const { getDoc: gd, doc: d } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
          const snap = await gd(d(snsDb, 'users', _user.uid));
          userData = snap.exists() ? snap.data() : null;
        } catch (_) {}
      }
      const live = await _getLiveModule();
      await live.openReplayPlayer(_user, userData, cUid, rId, isOwner);
    });
  });
}

/**
 * Wire up owner replay action buttons (POST / PRIVATE / DELETE) in a container.
 * Call after injecting replay card HTML into the DOM.
 * @param {HTMLElement} container
 * @param {string} ownerUid
 */
function _wireReplayActions(container, ownerUid) {
  if (!container || !ownerUid) return;

  async function _doAction(replayId, action, btn) {
    if (!replayId) return;
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      if (action === 'publish') {
        await publishReplay(ownerUid, replayId, 'public');
        _toast('📡 Replay posted publicly!');
      } else if (action === 'private') {
        await publishReplay(ownerUid, replayId, 'private');
        _toast('🔒 Replay set to private.');
      } else if (action === 'delete') {
        await deleteReplay(ownerUid, replayId);
        _toast('🗑 Replay deleted.');
      }
      // Refresh the active inner tab after any action
      const activeInnerTab = document.querySelector('.snx-tn-inner-tab.active');
      if (activeInnerTab) activeInnerTab.click();
    } catch (err) {
      _toast('Error: ' + (err.message || 'Action failed.'));
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  container.querySelectorAll('.snx-tn-replay-publish-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _doAction(btn.dataset.replayId, 'publish', btn);
    });
  });
  container.querySelectorAll('.snx-tn-replay-private-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _doAction(btn.dataset.replayId, 'private', btn);
    });
  });
  container.querySelectorAll('.snx-tn-replay-delete-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      _showDeleteReplayConfirm(ownerUid, btn.dataset.replayId, btn);
    });
  });
}

/**
 * Show an inline confirmation before deleting a replay.
 */
function _showDeleteReplayConfirm(ownerUid, replayId, triggerBtn) {
  const existing = document.getElementById('snx-tn-delete-replay-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'snx-tn-delete-replay-modal';
  modal.className = 'snx-tn-modal-overlay';
  modal.innerHTML = `
    <div class="snx-tn-modal-box">
      <div class="snx-tn-modal-title">🗑 DELETE REPLAY</div>
      <div class="snx-tn-modal-sub">This will permanently remove the replay record. This action cannot be undone.</div>
      <div id="snx-tn-del-replay-err" style="color:#ff3344;font-size:12px;min-height:18px;"></div>
      <div class="snx-tn-modal-actions">
        <button class="snx-tn-btn-ghost" id="snx-tn-del-replay-cancel">CANCEL</button>
        <button class="snx-tn-btn-end-live" id="snx-tn-del-replay-confirm">DELETE</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  document.getElementById('snx-tn-del-replay-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('snx-tn-del-replay-confirm').addEventListener('click', async () => {
    const errEl = document.getElementById('snx-tn-del-replay-err');
    const btn = document.getElementById('snx-tn-del-replay-confirm');
    btn.disabled = true; btn.textContent = 'Deleting…';
    try {
      await deleteReplay(ownerUid, replayId);
      modal.remove();
      _toast('🗑 Replay deleted.');
      // Refresh active inner tab
      const activeInnerTab = document.querySelector('.snx-tn-inner-tab.active');
      if (activeInnerTab) activeInnerTab.click();
    } catch (err) {
      errEl.textContent = err.message || 'Delete failed.';
      btn.disabled = false; btn.textContent = 'DELETE';
    }
  });
}

/* ════════════════════════════════════
   UTILITIES
════════════════════════════════════ */
function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function _toast(msg) {
  const t = document.getElementById('ax-toast') || document.body;
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = `
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:rgba(5,5,7,0.92);color:#c8d0e8;border:1px solid rgba(0,174,239,0.3);
    border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;
    letter-spacing:0.5px;z-index:9999;
    animation:snxTnToastIn 0.2s ease;
  `;
  if (!document.getElementById('snx-tn-toast-style')) {
    const s = document.createElement('style');
    s.id = 'snx-tn-toast-style';
    s.textContent = '@keyframes snxTnToastIn{from{opacity:0;transform:translateX(-50%) translateY(8px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}';
    document.head.appendChild(s);
  }
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
