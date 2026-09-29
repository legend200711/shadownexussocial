/**
 * SHADOW NEXUS 24-HOUR TV — Network UI Layer
 * snx-tv-network.js
 *
 * Tab navigation: WATCH | TV STUDIO (founder only)
 *
 * WATCH    → shows the broadcast player (#ax-hero / #snxTvApp)
 * TV STUDIO→ founder-only studio panel (routes to adapter studio mode)
 */

import {
  subscribeLiveChannels,
  setMainTvFeaturePreference,
  getCurrentUser,
  snsDb,
} from './snx-creator-channels.js';

// Theater — lazy-loaded so it doesn't block network init
let _theaterModule = null;
async function _getTheaterModule() {
  if (!_theaterModule) _theaterModule = await import('./snx-theater.js');
  return _theaterModule;
}

/* ════════════════════════════════════
   STATE
════════════════════════════════════ */
const _FOUNDER_EMAIL = 'christijerina46@gmail.com';
function _isFounder() {
  return !!(_user && typeof _user.email === 'string' &&
            _user.email.trim().toLowerCase() === _FOUNDER_EMAIL.toLowerCase());
}

let _activeTab    = 'main-tv';
let _user         = null;
let _liveUnsub    = null;
let _liveChannels = [];

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
  _refreshStudioTab();
  _injectNetworkPanels();
  _injectLivePreview();
  _startSubscriptions();

  // Wire up studio deep-link handler (used by _renderStudioSection buttons)
  window._snxOpenChannelStudio = (pane) => {
    // Switch inner adapter to studio, then trigger pane
    if (window.snxTvSwitchTab) window.snxTvSwitchTab('studio');
    setTimeout(() => {
      const ctrl = document.getElementById('ax-control');
      if (ctrl && typeof window._snxCtrlSwitchPane === 'function') {
        window._snxCtrlSwitchPane(pane);
      }
    }, 80);
  };

  // Mount theater presentation (idempotent — safe to call on auth change)
  _getTheaterModule().then(m => m.mountTheater()).catch(() => {});

  _switchTab('main-tv', true);
}

/**
 * No-op stub — kept so callers (index.html VIEW CHANNEL etc.) don't throw.
 */
export function openChannelForUid(_uid) {
  // Creator channel viewer removed from 24-Hour TV.
}

/**
 * Called when auth state changes (sign in / sign out).
 * @param {object|null} user
 */
export function onTvNetworkAuthChange(user) {
  _user = user;
  _refreshStudioTab();
}

/* ════════════════════════════════════
   TAB BAR
════════════════════════════════════ */
function _injectTabBar() {
  if (document.getElementById('snx-tn-tabs')) return;

  const tabBar = document.createElement('div');
  tabBar.id = 'snx-tn-tabs';
  tabBar.className = 'snx-tn-tabs';
  tabBar.setAttribute('role', 'tablist');
  tabBar.setAttribute('aria-label', 'Shadow Nexus 24-Hour TV sections');
  tabBar.innerHTML = `
    <button class="snx-tn-tab active" data-tab="main-tv" role="tab" aria-selected="true">WATCH</button>
  `;
  // Studio tab injected by _refreshStudioTab (called right after)

  // Insert tab bar immediately before the main TV container
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

/** Rebuild the TV Studio tab button when auth state changes (sign-in/out). */
function _refreshStudioTab() {
  const bar = document.getElementById('snx-tn-tabs');
  if (!bar) return;
  // Remove any existing studio tab first
  bar.querySelector('[data-tab="tv-studio"]')?.remove();
  if (_isFounder()) {
    const btn = document.createElement('button');
    btn.className = 'snx-tn-tab snx-tn-tab-studio';
    btn.dataset.tab = 'tv-studio';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', 'false');
    btn.textContent = 'TV STUDIO';
    btn.addEventListener('click', () => _switchTab('tv-studio'));
    bar.appendChild(btn);
  } else {
    if (_activeTab === 'tv-studio') _switchTab('main-tv', true);
  }
}

function _switchTab(tab, silent = false) {
  // Hard-gate: non-founders cannot navigate to tv-studio through any path.
  if (tab === 'tv-studio' && !_isFounder()) return;

  if (_activeTab === tab && !silent) return;

  // Leaving WATCH: pause scheduled media to prevent duplicate audio.
  const wasMainTvArea = _activeTab === 'main-tv' || _activeTab === 'tv-studio';
  const isMainTvArea  = tab === 'main-tv' || tab === 'tv-studio';

  if (wasMainTvArea && !isMainTvArea) {
    const vid = document.getElementById('ax-video');
    const aud = document.getElementById('ax-audio');
    if (vid && !vid.paused) { try { vid.pause(); } catch(_) {} }
    if (aud && !aud.paused) { try { aud.pause(); } catch(_) {} }
  }
  // Returning to WATCH: resume media if TV page is active
  if (!wasMainTvArea && tab === 'main-tv' && window._snxTvPageActive !== false) {
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

  // Show/hide sections
  const mainTvEl  = document.getElementById('ax-hero') || document.getElementById('snxTvApp');
  const studioEl  = document.getElementById('snx-tn-studio');

  if (mainTvEl) mainTvEl.style.display  = isMainTvArea ? '' : 'none';
  if (studioEl) studioEl.style.display  = tab === 'tv-studio' ? '' : 'none';

  // Route the inner adapter panel (Watch vs Studio).
  if (tab === 'tv-studio') {
    // The TV Studio tab now renders our own panel + still calls the inner adapter for compatibility
    if (window.snxTvSwitchTab) window.snxTvSwitchTab('studio');
  } else if (tab === 'main-tv') {
    if (window.snxTvSwitchTab) window.snxTvSwitchTab('watch');
  }

  // Render on demand
  if (tab === 'tv-studio') _renderStudioSection();

  // Update live preview strip
  _updateLivePreview();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ════════════════════════════════════
   NETWORK PANELS (containers)
════════════════════════════════════ */
function _injectNetworkPanels() {
  if (document.getElementById('snx-tn-wrapper')) return;

  const anchor = document.getElementById('ax-app') || document.getElementById('snxTvApp');
  if (!anchor) return;

  const wrapper = document.createElement('div');
  wrapper.id = 'snx-tn-wrapper';
  wrapper.innerHTML = `
    <div id="snx-tn-studio" class="snx-tn-section" style="display:none;" role="region" aria-label="TV Studio"></div>
  `;
  anchor.parentNode.insertBefore(wrapper, anchor.nextSibling);
}

/* Inject compact LIVE preview strip just below the main TV container */
function _injectLivePreview() {
  if (document.getElementById('snx-tn-live-preview')) return;
  const anchor = document.getElementById('ax-app') || document.getElementById('snxTvApp');
  if (!anchor) return;
  const preview = document.createElement('div');
  preview.id = 'snx-tn-live-preview';
  preview.style.display = 'none';
  anchor.parentNode.insertBefore(preview, anchor.nextSibling);
}

/* Update the compact live preview strip below Watch tab */
function _updateLivePreview() {
  const el = document.getElementById('snx-tn-live-preview');
  if (!el) return;
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
        LIVE ACROSS THE NEXUS
      </div>
    </div>
    <div class="snx-tn-live-preview-scroll" role="list" aria-label="Live creators">
      ${chips}
    </div>`;
}

/* ════════════════════════════════════
   FEATURE TRANSITION OVERLAY
════════════════════════════════════ */
export function showFeatureTransition(channelName) {
  const existing = document.getElementById('snx-tn-feat-trans');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'snx-tn-feat-trans';
  el.className = 'snx-tn-feature-transition';
  el.innerHTML = `
    <div class="snx-tn-feature-transition-label" aria-live="polite">JOINING THE NEXUS LIVE</div>
    <div class="snx-tn-feature-transition-dot" aria-hidden="true"></div>
    <div class="snx-tn-feature-transition-name">${_esc(channelName)}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 400); }, 2200);
}

/* ════════════════════════════════════
   RETURN TO PROGRAMMING OVERLAY
════════════════════════════════════ */
export function showReturnToProgramming() {
  const existing = document.getElementById('snx-tn-return-prog');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'snx-tn-return-prog';
  el.className = 'snx-tn-return-overlay';
  el.setAttribute('aria-live', 'polite');
  el.textContent = '↩ RETURNING TO THE MAIN SIGNAL';
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('visible'));
  setTimeout(() => { el.classList.remove('visible'); setTimeout(() => el.remove(), 400); }, 2200);
}

/* ════════════════════════════════════
   SUBSCRIPTIONS
════════════════════════════════════ */
function _startSubscriptions() {
  // Subscribe to live channels for the preview strip
  if (_liveUnsub) _liveUnsub();
  _liveUnsub = subscribeLiveChannels(
    channels => {
      _liveChannels = channels;
      _updateLivePreview();
      _getTheaterModule().then(m => m.notifyLiveChannels(channels)).catch(() => {});
    },
    err => {
      console.warn('[SNX TV] subscribeLiveChannels error:', err.code, err.message);
    },
  );

  // Handle snx:switchTvTab events from the adapter / broadcast Network Status panel.
  if (!window._snxTvTabSwitchHandler) {
    window._snxTvTabSwitchHandler = e => {
      const tab = e?.detail?.tab;
      if (tab) _switchTab(tab);
    };
    window.addEventListener('snx:switchTvTab', window._snxTvTabSwitchHandler);
  }

  // Handle snx:openCreatorChannel — no-op stub kept so callers don't throw.
  if (!window._snxTvOpenChannelHandler) {
    window._snxTvOpenChannelHandler = () => {};
    window.addEventListener('snx:openCreatorChannel', window._snxTvOpenChannelHandler);
  }
}

/* ════════════════════════════════════
   RENDER — STUDIO (Network-level cosmetic panel)
   The actual channel studio controls are in snx-ch-control.js
   and are accessed via the CHANNEL STUDIO button in the nav.
   This panel is a clean cosmetic overview for the TV Studio tab.
════════════════════════════════════ */
function _renderStudioSection() {
  const el = document.getElementById('snx-tn-studio');
  if (!el) return;

  // Read current now-playing from theater module's synced elements
  const nowTitle = document.getElementById('snx-tnp-title')?.textContent?.trim() ||
                   document.getElementById('ax-np-panel-title')?.textContent?.trim() || '—';
  const nowSub   = document.getElementById('snx-tnp-meta')?.textContent?.trim() ||
                   document.getElementById('ax-np-panel-meta')?.textContent?.trim() || '';
  const upNext   = document.getElementById('snx-tnx-title')?.textContent?.trim() || '—';

  // Determine channel status
  const mediaEl   = document.getElementById('ax-video') || document.getElementById('ax-audio');
  const isOnAir   = !!(mediaEl && (mediaEl.src || mediaEl.currentSrc) && !mediaEl.paused);

  el.innerHTML = `
    <div class="snx-tn-studio-header">
      <div class="snx-tn-studio-title">TV STUDIO</div>
      <div class="snx-tn-studio-sub">SHADOW NEXUS 24-HOUR TV · FOUNDER CONTROL</div>
    </div>

    <div class="snx-tn-studio-on-air">
      <span class="snx-tn-studio-on-air-dot" aria-hidden="true"></span>
      ${isOnAir ? 'ON AIR' : 'STANDBY'}
    </div>

    <div class="snx-tn-studio-card">
      <div class="snx-tn-studio-card-label">CURRENT PROGRAM</div>
      <div class="snx-tn-studio-card-value">${_esc(nowTitle)}</div>
      ${nowSub ? `<div class="snx-tn-studio-card-sub">${_esc(nowSub)}</div>` : ''}
    </div>

    <div class="snx-tn-studio-card">
      <div class="snx-tn-studio-card-label">UP NEXT</div>
      <div class="snx-tn-studio-card-value">${_esc(upNext)}</div>
    </div>

    <div class="snx-tn-studio-card">
      <div class="snx-tn-studio-card-label">CHANNEL STATUS</div>
      <div class="snx-tn-studio-card-value" style="color:${isOnAir ? 'var(--snx-green)' : 'var(--snx-text-muted)'}">
        ${isOnAir ? '● BROADCASTING' : '○ STANDBY'}
      </div>
    </div>

    <div class="snx-tn-studio-section-label">PROGRAMMING</div>
    <button class="snx-tn-studio-link-btn" onclick="if(window._snxOpenChannelStudio)window._snxOpenChannelStudio('live-tv')">
      <span>Playlists &amp; Programs</span>
      <span class="snx-tn-studio-link-btn-arrow">›</span>
    </button>
    <button class="snx-tn-studio-link-btn" onclick="if(window._snxOpenChannelStudio)window._snxOpenChannelStudio('library')">
      <span>Media Library</span>
      <span class="snx-tn-studio-link-btn-arrow">›</span>
    </button>

    <div class="snx-tn-studio-section-label">SCHEDULE</div>
    <button class="snx-tn-studio-link-btn" onclick="if(window._snxOpenChannelStudio)window._snxOpenChannelStudio('schedule')">
      <span>Manage Schedule</span>
      <span class="snx-tn-studio-link-btn-arrow">›</span>
    </button>

    <div class="snx-tn-studio-section-label">SYSTEM</div>
    <button class="snx-tn-studio-link-btn" onclick="if(window._snxOpenChannelStudio)window._snxOpenChannelStudio('dashboard')">
      <span>Open Full Channel Studio</span>
      <span class="snx-tn-studio-link-btn-arrow">›</span>
    </button>
  `;
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
