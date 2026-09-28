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
  subscribeUserProfile,
  loadReplays,
  publishReplay,
  deleteReplay,
  isFollowingChannel,
  followChannel,
  unfollowChannel,
  setNotificationPref,
  setMainTvFeaturePreference,
  loadUserProfile,
  migrateChannelFollowsToSns,
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
let _myProfile       = null;    // canonical SNS profile for current user (real-time)
let _myUnsub         = null;    // realtime subscription for own channel
let _myProfileUnsub  = null;    // realtime subscription for own SNS profile
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
  _injectLivePreview();
  _startSubscriptions();
  if (user) {
    _ensureMyChannel();
    _subscribeMyProfile();
  }

  // Handle deep-links from notifications / external entry points
  const params = new URLSearchParams(location.search);
  const deepLiveUid   = params.get('live');
  const deepLiveId    = params.get('liveId');
  const deepReplayUid = params.get('replay');
  const deepReplayId  = params.get('replayId');
  // ?channel=uid — deep-link to open a specific creator's channel page
  const deepChannelUid = params.get('channel');

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
    // Phase 2: deep-link opens the native TV Live View shell
    setTimeout(async () => {
      try {
        _ensureTvLiveViewCss();
        const { openTvLiveView } = await import('./snx-tv-live-view.js');
        // Build a minimal channel stub from the URL params
        const chStub = { ownerUid: deepLiveUid, channelName: '', currentLiveId: deepLiveId };
        openTvLiveView(chStub, deepLiveId, {
          onClose: () => { if (_activeTab !== 'live-now') _switchTab('live-now'); },
        });
      } catch (_) {
        // Fallback: navigate to old viewer if shell fails to load
        window.location.href = 'live.html#watch=' + encodeURIComponent(deepLiveId);
      }
    }, 600);
    _switchTab('live-now', true);
    return;
  }

  if (deepChannelUid) {
    // Deep-link to a specific creator's channel (e.g. from VIEW CHANNEL in index.html)
    setTimeout(() => _openChannelView(deepChannelUid), 400);
    _switchTab('channels', true);
    return;
  }

  _switchTab('main-tv', true);
}

/**
 * Programmatically open a specific creator's channel view.
 * Called by index.html's snx:openCreatorChannel handler and the VIEW CHANNEL button.
 * @param {string} uid
 */
export function openChannelForUid(uid) {
  if (!uid) return;
  // Switch to channels tab if not there already
  _switchTab('channels');
  // Give the channels section a moment to render, then open the channel view
  setTimeout(() => _openChannelView(uid), 150);
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
    _subscribeMyProfile();
  } else {
    // Clean up per-user subscriptions on sign-out
    if (_myUnsub)        { try { _myUnsub();        } catch (_) {} _myUnsub        = null; }
    if (_myProfileUnsub) { try { _myProfileUnsub(); } catch (_) {} _myProfileUnsub = null; }
    _myChannel = null;
    _myProfile = null;
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
    <button class="snx-tn-tab active" data-tab="main-tv"    role="tab" aria-selected="true"  aria-controls="ax-hero ax-app">MAIN TV</button>
    <button class="snx-tn-tab snx-tn-tab-live" data-tab="live-now" role="tab" aria-selected="false" aria-controls="snx-tn-live-now"><span class="snx-tn-live-dot" aria-hidden="true"></span> LIVE NOW</button>
    <button class="snx-tn-tab"        data-tab="channels"   role="tab" aria-selected="false" aria-controls="snx-tn-channels">CHANNELS</button>
    <button class="snx-tn-tab"        data-tab="my-channel" role="tab" aria-selected="false" aria-controls="snx-tn-my-channel">MY CHANNEL</button>
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
  // Returning to MAIN TV: resume media ONLY if the TVpage is actually active.
  // Guard: if snxTvTeardown has been called (full SNS navigation away), do NOT
  // restart audio here — snxTvInit will reload the correct item on re-entry.
  if (!wasMainTv && tab === 'main-tv' && window._snxTvPageActive !== false) {
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
  // Update LIVE preview strip visibility when switching tabs
  _updateLivePreview();

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
    <div id="snx-tn-live-now"   class="snx-tn-section" style="display:none;" role="region" aria-label="Live Now"></div>
    <div id="snx-tn-channels"   class="snx-tn-section" style="display:none;" role="region" aria-label="Channel Directory"></div>
    <div id="snx-tn-my-channel" class="snx-tn-section" style="display:none;" role="region" aria-label="My Channel"></div>
  `;
  // Insert immediately after the anchor element so panels appear below the broadcast area
  anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
}

/* Inject compact LIVE NOW preview strip just below the Main TV container */
function _injectLivePreview() {
  if (document.getElementById('snx-tn-live-preview')) return;
  const anchor = document.getElementById('ax-app') || document.getElementById('snxTvApp');
  if (!anchor) return;
  const preview = document.createElement('div');
  preview.id = 'snx-tn-live-preview';
  preview.style.display = 'none';
  anchor.parentNode.insertBefore(preview, anchor.nextSibling);
}

/* Update the compact live preview strip below Main TV */
function _updateLivePreview() {
  const el = document.getElementById('snx-tn-live-preview');
  if (!el) return;
  // Only show when on main-tv tab and there are live channels
  if (_activeTab !== 'main-tv' || !_liveChannels.length) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const chips = _liveChannels.slice(0, 6).map(ch => {
    const uid = ch.id || ch.ownerUid;
    const avatarLetter = (ch.channelName || '?').charAt(0).toUpperCase();
    return `<div class="snx-tn-live-chip" data-uid="${_esc(uid)}" role="button" tabindex="0"
                 aria-label="${_esc(ch.channelName)} — Live">
      <div class="snx-tn-live-chip-avatar">
        ${ch.avatar
          ? `<img src="${_esc(ch.avatar)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display='none'">`
          : avatarLetter}
      </div>
      <div class="snx-tn-live-chip-info">
        <div class="snx-tn-live-chip-name">${_esc(ch.channelName)}</div>
        <div class="snx-tn-live-chip-live">🔴 LIVE</div>
      </div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="snx-tn-live-preview-header">
      <div class="snx-tn-live-preview-title">
        <span class="snx-tn-live-dot" aria-hidden="true"></span>
        CREATORS LIVE NOW
      </div>
      <button class="snx-tn-live-preview-view-all" id="snx-tn-preview-view-all" aria-label="View all live channels">VIEW ALL</button>
    </div>
    <div class="snx-tn-live-preview-scroll" role="list" aria-label="Live creators">
      ${chips}
    </div>`;

  el.querySelector('#snx-tn-preview-view-all')?.addEventListener('click', () => _switchTab('live-now'));
  el.querySelectorAll('.snx-tn-live-chip').forEach(chip => {
    const handler = () => { const uid = chip.dataset.uid; if (uid) _openLiveNowCard(uid); };
    chip.addEventListener('click', handler);
    chip.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
  });
}

/* ════════════════════════════════════
   FEATURE TRANSITION OVERLAY
   Briefly shown when founder features a creator live on Main TV
════════════════════════════════════ */
export function showFeatureTransition(channelName) {
  const existing = document.getElementById('snx-tn-feat-trans');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'snx-tn-feat-trans';
  el.className = 'snx-tn-feature-transition';
  el.innerHTML = `
    <div class="snx-tn-feature-transition-label" aria-live="polite">NOW JOINING LIVE</div>
    <div class="snx-tn-feature-transition-dot" aria-hidden="true"></div>
    <div class="snx-tn-feature-transition-name">${_esc(channelName)}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 400); }, 2200);
}

/* ════════════════════════════════════
   RETURN TO PROGRAMMING OVERLAY
   Briefly shown when featured live ends and Main TV resumes schedule
════════════════════════════════════ */
export function showReturnToProgramming() {
  const existing = document.getElementById('snx-tn-return-prog');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'snx-tn-return-prog';
  el.className = 'snx-tn-return-overlay';
  el.setAttribute('aria-live', 'polite');
  el.textContent = '↩ RETURNING TO MAIN TV';
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 400); }, 2200);
}

/* ════════════════════════════════════
   SUBSCRIPTIONS
════════════════════════════════════ */
let _liveSubErrorShown = false;

function _startSubscriptions() {
  // Subscribe to live channels — read-only discovery, no WebRTC involvement
  if (_liveUnsub) _liveUnsub();
  _liveSubErrorShown = false;
  _liveUnsub = subscribeLiveChannels(
    channels => {
      _liveChannels = channels;
      _liveSubErrorShown = false;
      if (_activeTab === 'live-now') _renderLiveNowSection();
      _updateLivePreview();
      _updateLiveBadge();
    },
    err => {
      console.error('[SNX TV] subscribeLiveChannels error:', err.code, err.message);
      _liveSubErrorShown = true;
      if (_activeTab === 'live-now') _renderLiveNowError();
    },
  );

  // Subscribe to full directory
  if (_dirUnsub) _dirUnsub();
  _dirUnsub = subscribeChannelDirectory(channels => {
    _allChannels = channels;
    if (_activeTab === 'channels') _renderChannelsSection();
  });

  // [PHASE-2-DISABLED] subscribeMainTvState — Main TV featured-live subscription.
  // Disconnected for Phase 1 standalone WebRTC reset.
  // Restore this block in Phase 2 when reconnecting TV + Creator Live.
  //
  // if (!_mainTvUnsub) {
  //   import('./snx-main-tv-feature.js').then(({ subscribeMainTvState }) => { ... });
  // }

  // Handle snx:switchTvTab events from the adapter/broadcast Network Status panel.
  // Use a named handler stored on window so repeated initTvNetwork calls don't
  // accumulate duplicate listeners.
  if (!window._snxTvTabSwitchHandler) {
    window._snxTvTabSwitchHandler = e => {
      const tab = e?.detail?.tab;
      if (tab) _switchTab(tab);
    };
    window.addEventListener('snx:switchTvTab', window._snxTvTabSwitchHandler);
  }

  // Handle snx:openCreatorChannel — fired by the VIEW CHANNEL button in index.html
  // Works in both index.html (embedded) and channel.html (standalone) contexts.
  if (!window._snxTvOpenChannelHandler) {
    window._snxTvOpenChannelHandler = e => {
      const uid = e?.detail?.uid;
      if (uid) openChannelForUid(uid);
    };
    window.addEventListener('snx:openCreatorChannel', window._snxTvOpenChannelHandler);
  }
}

function _updateLiveBadge() {
  // Update the LIVE NOW tab visual indicator dot (already present via snx-tn-tab-live class)
  const liveTab = document.querySelector('.snx-tn-tab[data-tab="live-now"]');
  if (!liveTab) return;
  if (_liveChannels.length > 0) {
    liveTab.classList.add('snx-tn-tab-has-live');
  } else {
    liveTab.classList.remove('snx-tn-tab-has-live');
  }
}

/* ════════════════════════════════════
   MY CHANNEL — ensure + subscribe
════════════════════════════════════ */
async function _ensureMyChannel() {
  if (!_user) return;
  try {
    // Ensure the channel doc exists (idempotent) — also syncs identity from SNS profile
    _myChannel = await ensureCreatorChannel(_user);
    // One-time migration: merge any legacy channelFollows into SNS canonical follow system
    migrateChannelFollowsToSns(_user.uid).catch(() => {});
    // Subscribe to real-time updates for the channel doc
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

/* Subscribe to the current user's SNS profile in real time.
   When the user changes their avatar/username/displayName on their main profile,
   the TV channel identity updates automatically — no manual re-entry required. */
function _subscribeMyProfile() {
  if (!_user) return;
  if (_myProfileUnsub) { try { _myProfileUnsub(); } catch (_) {} }
  _myProfileUnsub = subscribeUserProfile(_user.uid, async profile => {
    _myProfile = profile;
    if (!profile) return;

    // Sync identity fields to creatorChannels so Live Now / Channels cards
    // display the updated avatar and username in real time.
    try {
      const {
        doc: docFn, updateDoc, serverTimestamp,
      } = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
      await updateDoc(docFn(snsDb, 'creatorChannels', _user.uid), {
        avatar:        profile.avatar       || null,
        ownerUsername: profile.username     || '',
        followersCount: profile.followers.length,
        updatedAt:     serverTimestamp(),
      });
    } catch (_) { /* channel may not exist yet — ensureCreatorChannel will handle it */ }

    if (_activeTab === 'my-channel') _renderMyChannelSection();
  });
}

/* ════════════════════════════════════
   RENDER — LIVE NOW
════════════════════════════════════ */
function _renderLiveNowSection() {
  const el = document.getElementById('snx-tn-live-now');
  if (!el) return;

  if (_liveSubErrorShown) { _renderLiveNowError(); return; }

  if (!_liveChannels.length) {
    el.innerHTML = `
      <div class="snx-tn-page-header">
        <div class="snx-tn-page-title"><span class="snx-tn-live-dot" aria-hidden="true"></span> LIVE NOW</div>
        <div class="snx-tn-page-sub">No creators are live right now</div>
      </div>
      <div class="snx-tn-live-now-empty" role="status" aria-live="polite">
        <div class="snx-tn-live-now-empty-icon" aria-hidden="true">📡</div>
        <div class="snx-tn-live-now-empty-title">THE NEXUS IS QUIET</div>
        <div class="snx-tn-live-now-empty-sub">No creators are Live right now.</div>
        <button class="snx-tn-btn-go-live snx-tn-live-now-go-live-btn" id="snx-tn-lnow-go-live-btn"
                aria-label="Go Live — start your own broadcast">🔴 GO LIVE</button>
      </div>`;
    document.getElementById('snx-tn-lnow-go-live-btn')?.addEventListener('click', () => {
      // GO LIVE → existing working live.html (broadcaster unchanged)
      window.location.href = 'live.html';
    });
    return;
  }

  const cards = _liveChannels.map(ch => _buildLiveNowCard(ch)).join('');
  el.innerHTML = `
    <div class="snx-tn-page-header">
      <div class="snx-tn-page-title"><span class="snx-tn-live-dot" aria-hidden="true"></span> LIVE NOW</div>
      <div class="snx-tn-page-sub">${_liveChannels.length} creator${_liveChannels.length !== 1 ? 's' : ''} broadcasting</div>
    </div>
    <div class="snx-tn-live-now-grid" role="list" aria-label="Live channels">${cards}</div>`;

  el.querySelectorAll('.snx-tn-live-now-card').forEach(card => {
    // WATCH LIVE button
    card.querySelector('.snx-tn-live-now-watch-btn')?.addEventListener('click', async e => {
      e.stopPropagation();
      const uid = card.dataset.uid;
      if (uid) await _openLiveNowCard(uid);
    });
    // Card body click → watch
    card.addEventListener('click', async () => {
      const uid = card.dataset.uid;
      if (uid) await _openLiveNowCard(uid);
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const uid = card.dataset.uid; if (uid) _openLiveNowCard(uid); }
    });
  });
}

function _renderLiveNowError() {
  const el = document.getElementById('snx-tn-live-now');
  if (!el) return;
  el.innerHTML = `
    <div class="snx-tn-page-header">
      <div class="snx-tn-page-title"><span class="snx-tn-live-dot" aria-hidden="true"></span> LIVE NOW</div>
    </div>
    <div class="snx-tn-live-now-empty" role="alert" aria-live="assertive">
      <div class="snx-tn-live-now-empty-icon" aria-hidden="true">⚡</div>
      <div class="snx-tn-live-now-empty-title">LIVE SIGNAL UNAVAILABLE</div>
      <div class="snx-tn-live-now-empty-sub">Could not reach the live discovery service.</div>
      <button class="snx-tn-btn-primary snx-tn-live-now-retry-btn" id="snx-tn-lnow-retry-btn"
              aria-label="Retry live discovery">Retry</button>
    </div>`;
  document.getElementById('snx-tn-lnow-retry-btn')?.addEventListener('click', () => {
    _liveSubErrorShown = false;
    _startSubscriptions();
    _renderLiveNowSection();
  });
}

/* Build a Shadow Nexus styled LIVE NOW creator card */
function _buildLiveNowCard(ch) {
  const uid = ch.id || ch.ownerUid;
  const name = ch.channelName || 'Creator';
  const avatarLetter = name.charAt(0).toUpperCase();
  const viewers = ch.currentViewerCount > 0 ? ch.currentViewerCount : null;
  return `
    <div class="snx-tn-live-now-card" data-uid="${_esc(uid)}" role="listitem" tabindex="0"
         aria-label="${_esc(name)} — Live${viewers ? ', ' + viewers + ' watching' : ''}">
      <div class="snx-tn-live-now-avatar-wrap">
        <div class="snx-tn-live-now-avatar">
          ${ch.avatar
            ? `<img src="${_esc(ch.avatar)}" alt="" loading="lazy"
                    style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                    onerror="this.style.display='none'">`
            : `<span>${avatarLetter}</span>`}
        </div>
        <div class="snx-tn-live-now-live-badge" aria-hidden="true">LIVE</div>
      </div>
      <div class="snx-tn-live-now-info">
        <div class="snx-tn-live-now-name">${_esc(name)}</div>
        ${viewers !== null ? `<div class="snx-tn-live-now-viewers">👁 ${viewers} watching</div>` : ''}
      </div>
      <button class="snx-tn-live-now-watch-btn" aria-label="Watch ${_esc(name)} live">
        WATCH LIVE
      </button>
    </div>`;
}

/* ════════════════════════════════════
   LIVE NOW CARD CLICK — open viewer
════════════════════════════════════ */
/* Ensure snx-tv-live-view.css is loaded (once) before showing the shell */
function _ensureTvLiveViewCss() {
  if (document.getElementById('snx-tv-live-view-css')) return;
  const link = document.createElement('link');
  link.id   = 'snx-tv-live-view-css';
  link.rel  = 'stylesheet';
  link.href = 'snx-tv-live-view.css';
  document.head.appendChild(link);
}

async function _openLiveNowCard(uid) {
  // Find the channel in the live list
  const ch = _liveChannels.find(c => (c.id || c.ownerUid) === uid);
  if (!ch) { _openChannelView(uid); return; }

  // currentLiveId is the RTDB roomId (set by broadcastStarted in snx-live-adapter.js)
  const roomId = ch.currentLiveId;
  if (!roomId) { _openChannelView(uid); return; }

  if (!_user) { _toast('Sign in to watch'); return; }

  // Load CSS and shell module together
  _ensureTvLiveViewCss();
  const { openTvLiveView } = await import('./snx-tv-live-view.js');

  // Open the native TV Live View shell — wraps live.html#watch=roomId (exact same roomId)
  openTvLiveView(ch, roomId, {
    onClose: () => {
      // Return to live-now tab (shell already dispatches snx:switchTvTab, but guard here too)
      if (_activeTab !== 'live-now') _switchTab('live-now');
    },
  });
}

/* ════════════════════════════════════
   RENDER — CHANNEL DIRECTORY
════════════════════════════════════ */
function _renderChannelsSection() {
  const el = document.getElementById('snx-tn-channels');
  if (!el) return;

  // Sort: live channels first, then alphabetically
  const sorted = [..._allChannels].sort((a, b) => {
    if (a.status === 'live' && b.status !== 'live') return -1;
    if (b.status === 'live' && a.status !== 'live') return 1;
    return (a.channelName || '').localeCompare(b.channelName || '');
  });
  const filtered = _filterChannels(sorted, _dirSearch);

  const emptyMsg = _dirSearch
    ? `<div class="snx-tn-empty" role="status">
         <div class="snx-tn-empty-icon" aria-hidden="true">🔍</div>
         <div class="snx-tn-empty-title">No channels found.</div>
         <div class="snx-tn-empty-sub">Try a different name or username.</div>
       </div>`
    : `<div class="snx-tn-empty" role="status">
         <div class="snx-tn-empty-icon" aria-hidden="true">📡</div>
         <div class="snx-tn-empty-title">No creator channels yet.</div>
         <div class="snx-tn-empty-sub">Open MY CHANNEL to create yours and start broadcasting.</div>
       </div>`;

  el.innerHTML = `
    <div class="snx-tn-page-header">
      <div class="snx-tn-page-title">CHANNELS</div>
      <div class="snx-tn-page-sub">Browse creator channels, follow, and watch</div>
    </div>
    <div class="snx-tn-search-wrap">
      <input class="snx-tn-search" id="snx-tn-dir-search" type="search"
             placeholder="Search by channel name or username…"
             value="${_esc(_dirSearch)}" autocomplete="off"
             aria-label="Search channels">
    </div>
    ${filtered.length
      ? `<div class="snx-tn-card-grid" role="list" aria-label="Channel directory">${filtered.map(ch => _buildChannelCard(ch)).join('')}</div>`
      : emptyMsg}
  `;

  const searchEl = document.getElementById('snx-tn-dir-search');
  if (searchEl) {
    searchEl.addEventListener('input', e => {
      _dirSearch = e.target.value.trim();
      _renderChannelsSection();
      // Restore focus to search box after re-render
      const newSearch = document.getElementById('snx-tn-dir-search');
      if (newSearch) { newSearch.focus(); newSearch.setSelectionRange(newSearch.value.length, newSearch.value.length); }
    });
  }

  _wireCardClicks(el, uid => _openChannelView(uid));
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
      <div class="snx-tn-empty">
        <div class="snx-tn-empty-icon">🔒</div>
        <div class="snx-tn-empty-title">Sign in to access your channel</div>
        <div class="snx-tn-empty-sub">Your permanent creator channel is linked to your Shadow Nexus account.</div>
        <a class="snx-tn-btn-primary" href="index.html">Sign In</a>
      </div>`;
    return;
  }

  if (!_myChannel) {
    el.innerHTML = `
      <div class="snx-tn-empty">
        <div class="snx-tn-loading-spinner"></div>
        <div class="snx-tn-empty-sub" style="margin-top:10px;">Loading your channel…</div>
      </div>`;
    return;
  }

  const ch = _myChannel;
  const isLive = ch.status === 'live';
  // Always use the canonical SNS profile for identity display
  const snsAvatar    = _myProfile?.avatar    || ch.avatar    || null;
  const snsUsername  = _myProfile?.username  || ch.ownerUsername || _user.email?.split('@')[0] || 'creator';
  const followerCount = _myProfile?.followers?.length ?? ch.followersCount ?? 0;
  const avatarLetter = (ch.channelName || _user.email || '?').charAt(0).toUpperCase();

  el.innerHTML = `
    <div class="snx-tn-my-profile-card">
      <!-- Cover image -->
      <div class="snx-tn-cover" id="snx-tn-cover-wrap"
           style="${ch.coverImage ? `background-image:url('${_esc(ch.coverImage)}');background-size:cover;background-position:center;` : ''}">
        ${!ch.coverImage ? '<div class="snx-tn-cover-placeholder">SHADOW NEXUS TV NETWORK</div>' : ''}
      </div>

      <!-- Profile row -->
      <div class="snx-tn-profile-row">
        <div class="snx-tn-channel-avatar" id="snx-tn-my-avatar">
          ${snsAvatar ? `<img src="${_esc(snsAvatar)}" alt="channel avatar" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display='none'">` : avatarLetter}
        </div>
        <div class="snx-tn-profile-info">
          <div class="snx-tn-channel-name">${_esc(ch.channelName)}</div>
          <div class="snx-tn-channel-handle">@${_esc(snsUsername)}</div>
          <div class="snx-tn-status-row">
            <span class="snx-tn-status-badge ${isLive ? 'live' : 'offline'}">
              ${isLive ? '🔴 LIVE' : '⚫ OFF AIR'}
            </span>
            <span class="snx-tn-followers-count">Followers: ${followerCount}</span>
          </div>
        </div>
        <div class="snx-tn-profile-actions">
          <button class="snx-tn-btn-edit" id="snx-tn-edit-btn" aria-label="Edit channel settings">Edit</button>
        </div>
      </div>

      <!-- Live stats bar (shown only when live) -->
      ${isLive ? `
      <div class="snx-tn-live-stats-bar" id="snx-tn-live-stats-bar">
        <div class="snx-tn-live-stat-item">
          <span class="snx-tn-live-stat-label">Status</span>
          <span class="snx-tn-live-stat-value live-red">🔴 LIVE</span>
        </div>
        <div class="snx-tn-live-stat-item">
          <span class="snx-tn-live-stat-label">Viewers</span>
          <span class="snx-tn-live-stat-value" id="snx-tn-my-live-viewers">${ch.currentViewerCount || 0}</span>
        </div>
        <div class="snx-tn-live-stat-item">
          <span class="snx-tn-live-stat-label">Duration</span>
          <span class="snx-tn-live-stat-value" id="snx-tn-my-live-duration">—</span>
        </div>
      </div>` : ''}

      <!-- Actions — show only what's relevant to current state -->
      <div class="snx-tn-go-live-wrap">
        ${isLive ? `
          <button class="snx-tn-btn-end-live" id="snx-tn-watch-own-live-btn" aria-label="Manage your live broadcast">Manage Live</button>
          <button class="snx-tn-btn-ghost" id="snx-tn-end-live-btn" aria-label="End your live broadcast" style="color:var(--snx-red);border-color:var(--snx-red-rim);">■ End Broadcast</button>
        ` : `<button class="snx-tn-btn-go-live" id="snx-tn-go-live-btn" aria-label="Start a live broadcast">🔴 Go Live</button>`}
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

  // Live duration timer for MY CHANNEL (counts up from startedAt)
  if (isLive && ch.currentStartedAt) {
    _startMyChannelLiveDuration(ch.currentStartedAt);
  }

  // Default inner tab
  _renderMyChannelInner('home', ch, isLive);
  // Wire Main TV feature toggle from ABOUT tab

  // Inner tab events
  el.querySelectorAll('.snx-tn-inner-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.snx-tn-inner-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _renderMyChannelInner(btn.dataset.inner, ch, isLive);
    });
  });

  // Go Live
  document.getElementById('snx-tn-go-live-btn')?.addEventListener('click', () => {
    _showGoLiveDialog(ch);
  });

  // Manage Live — returns host to live.html (the working broadcast engine)
  // The host is already live; this just navigates back to the live stage.
  document.getElementById('snx-tn-watch-own-live-btn')?.addEventListener('click', () => {
    if (!ch.currentLiveId || !_user) return;
    // Open live.html — the host is already broadcasting there.
    // live.html will detect the existing RTDB room and rejoin the creator stage.
    window.open('live.html', '_blank', 'noopener');
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

/* ════════════════════════════════════
   MY CHANNEL LIVE DURATION TIMER
   Counts up from startedAt — does not reset on page refresh
════════════════════════════════════ */
let _myChannelLiveDurationTimer = null;
function _startMyChannelLiveDuration(startedAt) {
  if (_myChannelLiveDurationTimer) clearInterval(_myChannelLiveDurationTimer);
  const startMs = startedAt?.toMillis ? startedAt.toMillis()
    : startedAt?.seconds ? startedAt.seconds * 1000
    : startedAt ? new Date(startedAt).getTime() : null;
  if (!startMs) return;
  function _update() {
    const el = document.getElementById('snx-tn-my-live-duration');
    if (!el) { clearInterval(_myChannelLiveDurationTimer); return; }
    const elapsed = Math.floor((Date.now() - startMs) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    el.textContent = h > 0
      ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  _update();
  _myChannelLiveDurationTimer = setInterval(_update, 1000);
}

function _renderMyChannelInner(tab, ch, isLive) {
  const content = document.getElementById('snx-tn-inner-content');
  if (!content) return;

  if (tab === 'home') {
    content.innerHTML = `
      <div class="snx-tn-inner-section">
        <div class="snx-tn-section-label">Recent Replays</div>
        <div id="snx-tn-recent-replays-home" role="status">
          <div class="snx-tn-loading-small" aria-live="polite">Loading replays…</div>
        </div>
      </div>`;

    // Load recent replays
    loadReplays(_user.uid, true).then(replays => {
      const rEl = document.getElementById('snx-tn-recent-replays-home');
      if (!rEl) return;
      if (!replays.length) {
        rEl.innerHTML = `
          <div class="snx-tn-channel-ready-banner">
            <div class="snx-tn-channel-ready-title">Your channel is ready.</div>
            Start your first broadcast to create replays your followers can watch.
          </div>`;
      } else {
        rEl.innerHTML = replays.slice(0, 6).map(r => _buildReplayCard(r, true)).join('');
        _wireReplayActions(rEl, _user.uid);
        _wireReplayPlayerOpen(rEl, _user.uid, true);
      }
    }).catch(() => {
      const rEl = document.getElementById('snx-tn-recent-replays-home');
      if (rEl) rEl.innerHTML = `<div class="snx-tn-empty-small">Could not load replays.</div>`;
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
        <div class="snx-tn-section-label">About</div>
        <div class="snx-tn-about-text">${_esc(ch.channelDescription) || '<span style="color:#5a80a8;">No description yet. Tap Edit to add one.</span>'}</div>
        <div class="snx-tn-about-meta">
          Creator channel on Shadow Nexus Social
        </div>
        <div class="snx-tn-feature-toggle-wrap" style="margin-top:14px;">
          <label class="snx-tn-feature-toggle-label">
            <input type="checkbox" id="snx-tn-main-tv-toggle"
                   ${ch.allowMainTvFeature !== false ? 'checked' : ''}>
            <span>
              <span class="snx-tn-feature-toggle-name">Allow Main TV Feature</span>
              <span class="snx-tn-feature-toggle-desc">Let the founder carry your live on Shadow Nexus Main TV.</span>
            </span>
          </label>
        </div>
      </div>`;
    // Wire toggle
    content.querySelector('#snx-tn-main-tv-toggle')?.addEventListener('change', async e => {
      try {
        await setMainTvFeaturePreference(_user.uid, e.target.checked);
        _toast(e.target.checked ? '✓ Main TV feature allowed.' : '✓ Main TV feature disabled.');
      } catch (err) {
        _toast('Error saving preference.');
        e.target.checked = !e.target.checked; // revert
      }
    });
  }
}

/* ════════════════════════════════════
   GO LIVE — navigates to working live.html
════════════════════════════════════ */
function _showGoLiveDialog(ch) {
  if (!_user) { _toast('Sign in required'); return; }
  // Check the feature gate (mirrors live.html's check)
  try {
    const ctrl = JSON.parse(localStorage.getItem('founderFeatureControls') || '{}');
    if (ctrl.liveEnabled === false) {
      _toast('Live streaming is temporarily disabled by the founder.');
      return;
    }
  } catch (_) {}

  // [OLD-LIVE] Phase 1: navigate directly to live.html — standalone WebRTC engine.
  // No Creator Channel adapter needed for Phase 1.
  window.location.href = 'live.html';
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
      // endActiveBroadcast: marks RTDB room ended + clears creatorChannels offline.
      // This is the correct emergency path when live.html is not open.
      const { endActiveBroadcast } = await import('./snx-live-adapter.js');
      await endActiveBroadcast(_user.uid, ch?.currentLiveId || null);
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
   NOTE: Avatar is NOT editable here — it comes from the user's
   Shadow Nexus Social profile. To change your avatar, edit your
   SNS profile. This dialog only controls TV-specific display fields.
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
      <div class="snx-tn-modal-info" style="font-size:11px;color:#5a80a8;margin-bottom:12px;padding:8px;background:rgba(0,174,239,0.05);border-radius:6px;border:1px solid rgba(0,174,239,0.12);">
        Your avatar and username are automatically synced from your Shadow Nexus profile.
        To update them, <a href="index.html#profile" style="color:#00AEEF;text-decoration:underline;">edit your SNS profile</a>.
      </div>
      <div class="snx-tn-field-group">
        <label class="snx-tn-field-label">Channel Name <span style="font-size:10px;color:#5a80a8;">(your TV broadcast name)</span></label>
        <input class="snx-tn-field-input" id="snx-tn-edit-name" maxlength="60"
               value="${_esc(ch.channelName || '')}">
      </div>
      <div class="snx-tn-field-group">
        <label class="snx-tn-field-label">Channel Description</label>
        <textarea class="snx-tn-field-input" id="snx-tn-edit-desc" rows="3" maxlength="300"
                  style="resize:vertical;">${_esc(ch.channelDescription || '')}</textarea>
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
    const cover = document.getElementById('snx-tn-edit-cover')?.value.trim();
    const btn = document.getElementById('snx-tn-edit-save');

    if (!name) { errEl.textContent = 'Channel name is required.'; return; }
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
      await updateCreatorChannel(_user.uid, {
        channelName: name,
        channelDescription: desc || '',
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
  // Avatar: prefer SNS profile image (canonical) over channel avatar
  const displayAvatar = profile?.avatar || profile?.profileImage || ch.avatar || null;
  const avatarLetter  = (ch.channelName || '?').charAt(0).toUpperCase();
  const username      = profile?.username || ch.ownerUsername || ch.ownerUid?.substring(0, 8) || 'creator';
  // Follower count from canonical SNS profile
  const followerCount = profile?.followers?.length ?? ch.followersCount ?? 0;
  const isOwnChannel  = _user && _user.uid === ch.ownerUid;

  el.innerHTML = `
    <button class="snx-tn-back-btn" id="snx-tn-channel-view-back">← Back</button>

    <div class="snx-tn-my-profile-card">
      <div class="snx-tn-cover"
           style="${ch.coverImage ? `background-image:url('${_esc(ch.coverImage)}');background-size:cover;background-position:center;` : ''}">
        ${!ch.coverImage ? '<div class="snx-tn-cover-placeholder">SHADOW NEXUS TV NETWORK</div>' : ''}
      </div>

      <div class="snx-tn-profile-row">
        <div class="snx-tn-channel-avatar" role="button" tabindex="0" title="View ${_esc(username)}'s profile"
             id="snx-tn-cv-avatar" style="cursor:pointer;" aria-label="View ${_esc(username)}'s Shadow Nexus profile">
          ${displayAvatar ? `<img src="${_esc(displayAvatar)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" onerror="this.style.display='none'">` : avatarLetter}
        </div>
        <div class="snx-tn-profile-info">
          <div class="snx-tn-channel-name">${_esc(ch.channelName)}</div>
          <div class="snx-tn-channel-handle" id="snx-tn-cv-handle"
               style="cursor:pointer;" title="View ${_esc(username)}'s profile">@${_esc(username)}</div>
          <div class="snx-tn-status-row">
            <span class="snx-tn-status-badge ${isLive ? 'live' : 'offline'}">
              ${isLive ? '🔴 LIVE' : '⚫ OFF AIR'}
            </span>
            <span class="snx-tn-followers-count">Followers: ${followerCount}</span>
          </div>
        </div>
        ${!isOwnChannel && _user ? `
          <div class="snx-tn-profile-actions" id="snx-tn-follow-area">
            <div class="snx-tn-loading-small">…</div>
          </div>` : ''}
      </div>

      <!-- VIEW PROFILE link — opens creator's main SNS profile -->
      <div style="padding:0 16px 10px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="snx-tn-btn-ghost" id="snx-tn-view-profile-btn"
                style="font-size:11px;padding:5px 12px;"
                aria-label="View ${_esc(username)}'s Shadow Nexus profile">
          👤 VIEW PROFILE
        </button>
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

  // VIEW PROFILE — opens the creator's main SNS profile
  const _openCreatorProfile = () => {
    if (typeof window.viewProfile === 'function') {
      // We are inside index.html — use the native profile viewer
      window.viewProfile(ch.ownerUid);
    } else {
      // We are in channel.html (standalone) — navigate to index.html with the profile param
      window.location.href = `index.html?profile=${ch.ownerUid}`;
    }
  };
  document.getElementById('snx-tn-view-profile-btn')?.addEventListener('click', _openCreatorProfile);
  document.getElementById('snx-tn-cv-avatar')?.addEventListener('click', _openCreatorProfile);
  document.getElementById('snx-tn-cv-avatar')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _openCreatorProfile(); }
  });
  document.getElementById('snx-tn-cv-handle')?.addEventListener('click', _openCreatorProfile);

  // Watch live — opens old working viewer via the adapter
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
    // Route through adapter — opens live.html#watch=rtdbRoomId (old working viewer)
    const { watchLive } = await import('./snx-live-adapter.js');
    await watchLive(_user, userData, ch, liveId);
  });

  // Follow area
  if (!isOwnChannel && _user) {
    const followArea = document.getElementById('snx-tn-follow-area');
    isFollowingChannel(ch.ownerUid, _user.uid).then(async following => {
      if (!followArea) return;

      // Determine notification pref
      let notifsOn = true;
      if (following && snsDb) {
        try {
          const prefRef = doc(snsDb, 'channelFollows', ch.ownerUid, 'followers', _user.uid);
          const snap = await getDoc(prefRef);
          if (snap.exists()) notifsOn = snap.data().notificationsEnabled !== false;
        } catch (_) {}
      }

      function _renderFollowArea(isFollowing, notifEnabled) {
        followArea.innerHTML = `
          <button class="snx-tn-btn-follow ${isFollowing ? 'following' : ''}" id="snx-tn-follow-btn"
                  aria-label="${isFollowing ? 'Unfollow this channel' : 'Follow this channel'}"
                  aria-pressed="${isFollowing ? 'true' : 'false'}">
            ${isFollowing ? '✓ Following' : '+ Follow'}
          </button>
          ${isFollowing ? `
          <button class="snx-tn-notif-btn ${notifEnabled ? 'enabled' : ''}" id="snx-tn-notif-btn"
                  aria-label="Live notifications ${notifEnabled ? 'on' : 'off'}"
                  aria-pressed="${notifEnabled ? 'true' : 'false'}">
            ${notifEnabled ? '🔔 Notifications On' : '🔕 Notifications Off'}
          </button>` : ''}`;

        // Follow toggle
        document.getElementById('snx-tn-follow-btn')?.addEventListener('click', async () => {
          const btn = document.getElementById('snx-tn-follow-btn');
          if (btn) btn.disabled = true;
          try {
            if (isFollowing) {
              await unfollowChannel(ch.ownerUid, _user.uid);
              _renderFollowArea(false, false);
            } else {
              await followChannel(ch.ownerUid, _user.uid);
              _renderFollowArea(true, true);
            }
          } catch (_) { if (btn) btn.disabled = false; }
        });

        // Notification toggle
        document.getElementById('snx-tn-notif-btn')?.addEventListener('click', async () => {
          const newState = !notifEnabled;
          try {
            await setNotificationPref(ch.ownerUid, _user.uid, newState);
            _renderFollowArea(true, newState);
          } catch (_) {}
        });
      }

      _renderFollowArea(following, notifsOn);
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
        const { watchLive } = await import('./snx-live-adapter.js');
        await watchLive(_user, userData, ch, liveId);
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
  const statusText = isLive ? 'Live' : 'Off Air';
  const viewerText = isLive && ch.currentViewerCount > 0 ? `${ch.currentViewerCount} watching` : '';
  const followers  = (ch.followersCount || 0).toLocaleString();
  // Action label: WATCH for live, VIEW CHANNEL for directory
  const actionLabel = isLive ? 'WATCH' : 'VIEW CHANNEL';
  const actionClass = isLive ? 'snx-tn-card-action watch' : 'snx-tn-card-action';
  return `
    <div class="snx-tn-card ${isLive ? 'snx-tn-card-live' : ''} ${isFeatured ? 'snx-tn-card-featured' : ''}"
         data-uid="${_esc(uid)}" role="listitem" tabindex="0"
         aria-label="${_esc(ch.channelName)} — ${statusText}${viewerText ? ', ' + viewerText : ''}">
      <div class="snx-tn-card-avatar">
        ${ch.avatar
          ? `<img src="${_esc(ch.avatar)}" alt="" loading="lazy" class="snx-tn-avatar-img"
                  style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                  onerror="this.style.display='none'">`
          : avatarLetter}
        ${isLive ? '<span class="snx-tn-card-live-ring" aria-hidden="true"></span>' : ''}
      </div>
      <div class="snx-tn-card-info">
        <div class="snx-tn-card-name">${_esc(ch.channelName)}</div>
        <div class="snx-tn-card-handle">@${_esc(ch.ownerUsername || ch.ownerUid?.substring(0, 8) || 'creator')}</div>
        <div class="snx-tn-card-meta">
          <span class="snx-tn-status-badge-sm ${isLive ? 'live' : 'offline'}" aria-label="${statusText}">
            ${isLive ? '🔴 LIVE' : '⚫ OFF AIR'}
          </span>
          ${isFeatured ? '<span class="snx-tn-featured-badge" aria-label="Featured on Main TV">📺 MAIN TV</span>' : ''}
          ${viewerText ? `<span class="snx-tn-card-followers">${_esc(viewerText)}</span>` : ''}
          <span class="snx-tn-card-followers">${_esc(followers)} followers</span>
        </div>
      </div>
      <span class="${actionClass}" aria-hidden="true">${actionLabel}</span>
    </div>`;
}

/* Helper: wire click + keyboard Enter/Space on card elements */
function _wireCardClicks(container, onUid) {
  container.querySelectorAll('.snx-tn-card').forEach(card => {
    card.addEventListener('click', () => { const uid = card.dataset.uid; if (uid) onUid(uid); });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const uid = card.dataset.uid; if (uid) onUid(uid); }
    });
  });
}

function _buildReplayCard(replay, isOwner) {
  const visLabel  = { public: 'Public', followers: 'Followers Only', private: 'Private' };
  const procLabel = { processing: 'Processing', failed: 'Failed', ready: '' };
  const rId       = replay.replayId || replay.id;
  const proc      = replay.processingStatus || 'ready';
  const isPlayable = proc !== 'failed' && proc !== 'processing' && replay.visibility !== 'private' || isOwner;
  const broadcastDate = replay.createdAt?.toDate
    ? replay.createdAt.toDate().toLocaleDateString(undefined, { year:'numeric', month:'short', day:'numeric' })
    : '';
  const views = (replay.replayViews || replay.viewCount || 0).toLocaleString();
  return `
    <div class="snx-tn-replay-card ${isPlayable ? 'snx-tn-replay-playable' : ''}"
         data-replay-id="${_esc(rId)}"
         data-creator-uid="${_esc(replay.creatorUid || '')}"
         data-vis="${_esc(replay.visibility || 'private')}"
         role="${isPlayable ? 'button' : 'article'}"
         tabindex="${isPlayable ? '0' : '-1'}"
         aria-label="${_esc(replay.title || 'Live Replay')} — ${views} views">
      <div class="snx-tn-replay-thumb">
        ${replay.thumbnail
          ? `<img src="${_esc(replay.thumbnail)}" alt="" loading="lazy"
                  style="width:100%;height:100%;object-fit:cover;"
                  onerror="this.parentNode.innerHTML='<div class=snx-tn-replay-thumb-placeholder>▶</div>'">`
          : '<div class="snx-tn-replay-thumb-placeholder" aria-hidden="true">▶</div>'}
        ${replay.duration ? `<span class="snx-tn-replay-duration">${_fmtDuration(replay.duration)}</span>` : ''}
        ${proc === 'processing' ? '<div class="snx-tn-replay-proc-overlay" aria-hidden="true">⏳</div>' : ''}
        ${proc === 'failed' ? '<div class="snx-tn-replay-proc-overlay snx-tn-replay-proc-failed" aria-hidden="true">⚠</div>' : ''}
      </div>
      <div class="snx-tn-replay-info">
        <div class="snx-tn-replay-title">${_esc(replay.title || 'Live Replay')}</div>
        <div class="snx-tn-replay-meta">
          <span class="snx-tn-replay-badge-label">LIVE REPLAY</span>
          ${isOwner ? `<span class="snx-tn-replay-vis snx-tn-vis-${replay.visibility || 'private'}" aria-label="Visibility: ${visLabel[replay.visibility] || 'Private'}">${visLabel[replay.visibility] || 'Private'}</span>` : ''}
          ${proc !== 'ready' ? `<span class="snx-tn-replay-proc-badge snx-tn-proc-${proc}" role="status">${procLabel[proc] || ''}</span>` : ''}
          ${broadcastDate ? `<span title="Original broadcast date">${broadcastDate}</span>` : ''}
          <span>${views} views</span>
        </div>
        ${isOwner ? `
        <div class="snx-tn-replay-actions">
          ${proc === 'failed' ? `<button class="snx-tn-replay-action-btn snx-tn-replay-delete-btn" data-replay-id="${_esc(rId)}" aria-label="Delete failed recording">Delete</button>` : `
          ${(replay.visibility !== 'public') ? `<button class="snx-tn-replay-action-btn snx-tn-replay-publish-btn" data-replay-id="${_esc(rId)}" aria-label="Post replay publicly">Post Replay</button>` : ''}
          ${(replay.visibility !== 'private') ? `<button class="snx-tn-replay-action-btn snx-tn-replay-private-btn" data-replay-id="${_esc(rId)}" aria-label="Make replay private">Make Private</button>` : ''}
          <button class="snx-tn-replay-action-btn snx-tn-replay-delete-btn" data-replay-id="${_esc(rId)}" aria-label="Delete replay">Delete</button>`}
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
