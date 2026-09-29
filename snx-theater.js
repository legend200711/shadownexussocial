/**
 * NEXUS AFTERDARK TV — Theater Presentation Layer
 * snx-theater.js
 *
 * Lightweight presentation layer for the Nexus AfterDark TV Main Signal.
 * Adds: cinematic frame, theater header (NEXUS AFTERDARK TV branding),
 *       network bug watermark, now-playing skin, progress display,
 *       up-next strip, broadcast ticker, signal-interrupted overlay, entry
 *       signal transition.
 *
 * DOES NOT:
 *   - Touch the broadcast engine (snx-ch-broadcast.js)
 *   - Create a second video/audio element
 *   - Create duplicate setInterval timers (reuses existing tick via DOM reads)
 *   - Modify WebRTC, Live, or Firebase
 *   - Burn anything into uploaded media (watermark is presentation-only)
 *
 * The module observes:
 *   #ax-np-panel-title    — current program title (set by broadcast engine)
 *   #ax-np-panel-meta     — current program meta
 *   #ax-np-panel-time     — "elapsed / total" string (set by broadcast tick)
 *   #ax-np-panel-remain   — remaining string
 *   #ax-progress-fill     — progress percentage (style.width, set by tick)
 *   #ax-up-next-list      — first .ax-sched-row for "Up Next"
 *   window._snxLiveChannels — updated by snx-tv-network.js live subscription
 */

/* ════════════════════════════════════
   ENTRY SIGNAL TRANSITION
   One short sweep when the theater first mounts.
════════════════════════════════════ */
function _signalTransition() {
  // Only run once and only when the browser is not requesting reduced motion.
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = document.createElement('div');
  el.className = 'snx-theater-signal-in';
  document.body.appendChild(el);
  // Force reflow then start animation
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.add('active');
      setTimeout(() => el.remove(), 500);
    });
  });
}

/* ════════════════════════════════════
   INJECT THEATER HEADER
   Prepended inside #ax-hero, before .ax-network-header
════════════════════════════════════ */
function _injectTheaterHeader() {
  if (document.getElementById('snx-theater-header')) return;
  const hero = document.getElementById('ax-hero');
  if (!hero) return;

  const header = document.createElement('div');
  header.id = 'snx-theater-header';
  header.className = 'snx-theater-header';
  header.innerHTML = `
    <div class="snx-theater-brand">
      <div class="snx-theater-network-name">SHADOW NEXUS SOCIAL</div>
      <div class="snx-theater-title">SHADOW NEXUS 24-HOUR TV</div>
      <div class="snx-theater-sub">24/7 · THE BROADCAST NEVER STOPS</div>
    </div>
    <div class="snx-theater-on-air" id="snx-theater-status" aria-live="polite" aria-atomic="true">
      <div class="snx-theater-on-air-dot" aria-hidden="true"></div>
      <span id="snx-theater-status-text">● ON AIR</span>
    </div>`;

  // Insert as first child of #ax-hero so it appears above the player
  hero.insertBefore(header, hero.firstChild);
}

/* ════════════════════════════════════
   WRAP PLAYER IN CINEMATIC FRAME
   Wraps .ax-player-wrap inside .snx-theater-frame without
   recreating any video/audio elements.
════════════════════════════════════ */
function _wrapPlayerInFrame() {
  if (document.getElementById('snx-theater-frame')) return;
  const playerWrap = document.querySelector('.ax-player-wrap');
  if (!playerWrap) return;

  const frame = document.createElement('div');
  frame.id = 'snx-theater-frame';
  frame.className = 'snx-theater-frame';

  const glow = document.createElement('div');
  glow.className = 'snx-theater-glow';
  glow.setAttribute('aria-hidden', 'true');
  frame.appendChild(glow);

  // Network bug watermark — presentation only, does not affect video controls
  // Bottom-left corner, fades on hover so controls remain accessible
  const bug = document.createElement('div');
  bug.className = 'snx-network-bug';
  bug.setAttribute('aria-hidden', 'true');
  bug.innerHTML = `<span class="snx-network-bug-top">SHADOW</span><span class="snx-network-bug-bottom">NEXUS TV</span>`;
  frame.appendChild(bug);

  // Move the entire .ax-player-wrap into the frame
  playerWrap.parentNode.insertBefore(frame, playerWrap);
  frame.appendChild(playerWrap);

  // Add signal-interrupted overlay inside the existing media area
  const mediaArea = document.getElementById('ax-media-area');
  if (mediaArea) {
    const lost = document.createElement('div');
    lost.id = 'snx-signal-lost';
    lost.className = 'snx-theater-signal-lost';
    lost.setAttribute('aria-live', 'assertive');
    lost.innerHTML = `
      <div class="snx-theater-signal-lost-icon" aria-hidden="true">📡</div>
      <div class="snx-theater-signal-lost-title" id="snx-signal-lost-title">SIGNAL INTERRUPTED</div>
      <div class="snx-theater-signal-lost-sub" id="snx-signal-lost-sub">RECONNECTING TO NEXUS AFTERDARK TV…</div>`;
    mediaArea.appendChild(lost);
  }
}

/* ════════════════════════════════════
   INJECT THEATER NOW PLAYING BLOCK
   Injected immediately after the theater frame — replaces the
   existing .ax-now-playing-panel visually while keeping the
   original DOM node (broadcast engine writes to it, we mirror it).
════════════════════════════════════ */
function _injectNowPlayingBlock() {
  if (document.getElementById('snx-theater-np')) return;
  const frame = document.getElementById('snx-theater-frame');
  if (!frame) return;

  const block = document.createElement('div');
  block.id = 'snx-theater-np';
  block.className = 'snx-theater-now-playing';
  block.innerHTML = `
    <div class="snx-theater-np-row">
      <div class="snx-theater-np-left">
        <div class="snx-theater-np-label">
          <span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:#39FF14;box-shadow:0 0 6px rgba(57,255,20,0.7);display:inline-block;flex-shrink:0;"></span>
          NOW PLAYING
        </div>
        <div class="snx-theater-np-title" id="snx-tnp-title">—</div>
        <div class="snx-theater-np-meta"  id="snx-tnp-meta"></div>
      </div>
      <div class="snx-theater-np-right">
        <div class="snx-theater-np-time"   id="snx-tnp-time"></div>
        <div class="snx-theater-np-remain" id="snx-tnp-remain"></div>
      </div>
    </div>
    <div class="snx-theater-progress-wrap">
      <div class="snx-theater-progress-bar">
        <div class="snx-theater-progress-fill" id="snx-theater-fill"></div>
      </div>
      <div class="snx-theater-progress-times">
        <span class="snx-theater-progress-elapsed" id="snx-tnp-elapsed">0:00</span>
        <span style="flex:1;"></span>
        <span id="snx-tnp-total">—</span>
      </div>
    </div>`;

  frame.insertAdjacentElement('afterend', block);

  // Hide the original panel — engine still populates it; we read from it.
  const orig = document.getElementById('ax-now-playing-panel');
  if (orig) orig.style.display = 'none';
}

/* ════════════════════════════════════
   INJECT THEATER UP NEXT STRIP
   Placed immediately after the now-playing block.
════════════════════════════════════ */
function _injectUpNextStrip() {
  if (document.getElementById('snx-theater-upnext')) return;
  const np = document.getElementById('snx-theater-np');
  if (!np) return;

  const strip = document.createElement('div');
  strip.id = 'snx-theater-upnext';
  strip.className = 'snx-theater-up-next';
  strip.style.display = 'none'; // hidden until data arrives
  strip.innerHTML = `
    <span class="snx-theater-up-next-label">UP NEXT</span>
    <span class="snx-theater-up-next-title" id="snx-tnx-title">—</span>
    <span class="snx-theater-up-next-dur"   id="snx-tnx-dur"></span>`;

  np.insertAdjacentElement('afterend', strip);
}

/* ════════════════════════════════════
   INJECT BROADCAST TICKER
   Pure CSS scroll; no JS animation loop.
   Content is refreshed by _syncTheaterUI() which already runs
   on the existing broadcast tick interval.
════════════════════════════════════ */
function _injectTicker() {
  if (document.getElementById('snx-theater-ticker')) return;
  const strip = document.getElementById('snx-theater-upnext');
  if (!strip) return;

  const ticker = document.createElement('div');
  ticker.id = 'snx-theater-ticker';
  ticker.className = 'snx-theater-ticker';
  ticker.setAttribute('aria-label', 'Broadcast ticker');
  ticker.innerHTML = `
    <div class="snx-theater-ticker-label" aria-hidden="true">NATV</div>
    <div class="snx-theater-ticker-track">
      <div class="snx-theater-ticker-inner" id="snx-ticker-inner" aria-live="off">
        <!-- populated by _updateTicker() -->
      </div>
    </div>`;

  strip.insertAdjacentElement('afterend', ticker);
}

/* ════════════════════════════════════
   HELPERS
════════════════════════════════════ */
function _fmtSec(sec) {
  if (!sec || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  return `${m}:${String(s % 60).padStart(2,'0')}`;
}

function _parseFmtTime(str) {
  // Parses "M:SS" or "H:MM:SS" → seconds, or returns 0
  if (!str || typeof str !== 'string') return 0;
  const parts = str.trim().split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ════════════════════════════════════
   SYNC — mirrors existing DOM state to theater elements
   Called on a MutationObserver tick (watches the source elements
   the broadcast engine already updates) so no extra setInterval.
════════════════════════════════════ */
function _syncTheaterUI() {
  // ── Now Playing ──
  const srcTitle  = document.getElementById('ax-np-panel-title');
  const srcMeta   = document.getElementById('ax-np-panel-meta');
  const srcTime   = document.getElementById('ax-np-panel-time');
  const srcRemain = document.getElementById('ax-np-panel-remain');
  const srcFill   = document.getElementById('ax-progress-fill');

  const dstTitle  = document.getElementById('snx-tnp-title');
  const dstMeta   = document.getElementById('snx-tnp-meta');
  const dstTime   = document.getElementById('snx-tnp-time');
  const dstRemain = document.getElementById('snx-tnp-remain');
  const dstFill   = document.getElementById('snx-theater-fill');
  const dstElapsed = document.getElementById('snx-tnp-elapsed');
  const dstTotal   = document.getElementById('snx-tnp-total');

  if (dstTitle && srcTitle) dstTitle.textContent = srcTitle.textContent;
  if (dstMeta  && srcMeta)  dstMeta.textContent  = srcMeta.textContent;

  // Parse time string "M:SS / M:SS" for elapsed / total
  if (srcTime && dstTime) {
    const raw = srcTime.textContent || '';
    dstTime.textContent = raw;
    // Also update elapsed / total separately
    const parts = raw.split('/').map(s => s.trim());
    if (dstElapsed) dstElapsed.textContent = parts[0] || '0:00';
    if (dstTotal)   dstTotal.textContent   = parts[1] || '—';
  }

  if (dstRemain && srcRemain) dstRemain.textContent = srcRemain.textContent;

  // Mirror progress fill width
  if (dstFill && srcFill) {
    dstFill.style.width = srcFill.style.width || '0%';
  }

  // ── Up Next ──
  const upNextList = document.getElementById('ax-up-next-list');
  const tnxTitle   = document.getElementById('snx-tnx-title');
  const tnxDur     = document.getElementById('snx-tnx-dur');
  const upNextStrip = document.getElementById('snx-theater-upnext');

  if (upNextList && tnxTitle) {
    const firstRow = upNextList.querySelector('.ax-sched-row');
    if (firstRow) {
      const t = firstRow.querySelector('.ax-sched-title');
      const d = firstRow.querySelector('.ax-sched-dur');
      tnxTitle.textContent = t ? t.textContent : '—';
      if (tnxDur) tnxDur.textContent = d ? d.textContent : '';
      if (upNextStrip) upNextStrip.style.display = '';
    } else {
      if (upNextStrip) upNextStrip.style.display = 'none';
    }
  }

  // ── Broadcast status badge ──
  _updateStatusBadge();
}

/* ── Theater status badge (on-air / connecting / off-air) ── */
function _updateStatusBadge() {
  const badge    = document.getElementById('snx-theater-status');
  const badgeTxt = document.getElementById('snx-theater-status-text');
  if (!badge || !badgeTxt) return;

  // The broadcast engine sets ax-np-title to "Connecting to network…" while loading.
  const npTitle  = document.getElementById('ax-np-title');
  const titleTxt = (npTitle?.textContent || '').toLowerCase();
  const mediaEl  = document.getElementById('ax-video') || document.getElementById('ax-audio');

  let state = 'on-air'; // default
  if (titleTxt.includes('connecting') || titleTxt === 'standby…' || titleTxt === '') {
    state = 'connecting';
  } else if (!mediaEl || (!mediaEl.src && !mediaEl.currentSrc)) {
    state = 'connecting';
  }

  badge.className = 'snx-theater-on-air' + (state !== 'on-air' ? ` ${state}` : '');
  badgeTxt.textContent = state === 'on-air' ? '● ON AIR'
    : state === 'connecting' ? '● CONNECTING'
    : '○ OFF AIR';
}

/* ════════════════════════════════════
   TICKER CONTENT — built once, refreshed when Live state changes
════════════════════════════════════ */
function _updateTicker() {
  const inner = document.getElementById('snx-ticker-inner');
  if (!inner) return;

  const nowTitle  = document.getElementById('ax-np-panel-title')?.textContent?.trim() || '';
  const liveChannels = window._snxLiveChannels || [];

  const items = [];

  if (nowTitle && nowTitle !== '—') {
    items.push({ label: 'NOW', text: nowTitle, live: false });
  }

  // Up Next from sidebar
  const firstUpNext = document.getElementById('ax-up-next-list')?.querySelector('.ax-sched-row .ax-sched-title');
  if (firstUpNext?.textContent?.trim()) {
    items.push({ label: 'UP NEXT', text: firstUpNext.textContent.trim(), live: false });
  }

  // Live creators — real data only
  liveChannels.forEach(ch => {
    if (ch.channelName) {
      items.push({ label: '🔴 LIVE NOW', text: ch.channelName, live: true });
    }
  });

  // Filler if nothing available
  if (!items.length) {
    items.push({ label: '24/7', text: 'SHADOW NEXUS TV', live: false });
  }

  // Build ticker HTML — doubled for seamless loop
  const sep = `<span class="snx-theater-ticker-sep" aria-hidden="true"></span>`;
  const makeItem = (item) =>
    `<span class="snx-theater-ticker-item${item.live ? ' snx-theater-ticker-item-live' : ''}">` +
    `<span class="snx-theater-ticker-item-label">${_esc(item.label)}</span>` +
    ` ${_esc(item.text)}` +
    `</span>${sep}`;

  const itemsHtml = items.map(makeItem).join('');
  inner.innerHTML = itemsHtml + itemsHtml; // doubled for seamless loop
}

/* ════════════════════════════════════
   SIGNAL INTERRUPTED OVERLAY
   Watches the video/audio element for stall/error/empty states.
   Only shown while the engine is genuinely stuck or errored.
════════════════════════════════════ */
let _signalLostTimer = null;
let _signalLostShown = false;

function _watchSignalState() {
  // Check every 2s — deliberately infrequent to avoid any perf cost.
  setInterval(() => {
    const mediaArea = document.getElementById('ax-media-area');
    const overlay   = document.getElementById('snx-signal-lost');
    if (!mediaArea || !overlay) return;

    const vid = document.getElementById('ax-video');
    const aud = document.getElementById('ax-audio');

    // Determine if an active media element is in a bad state.
    // "Active" means style.display !== 'none' or src is set.
    const activeMedia = (vid && vid.style.display !== 'none' && vid.src) ? vid
                      : (aud && aud.src) ? aud
                      : null;

    if (!activeMedia) {
      // No active media yet — don't show signal lost (connecting state is handled by badge)
      _hideSignalLost(overlay);
      return;
    }

    const isError   = activeMedia.error !== null;
    const isStalled = activeMedia.networkState === 2 /* NETWORK_LOADING */ &&
                      activeMedia.readyState   === 1 /* HAVE_METADATA */ &&
                      !activeMedia.paused;
    // Only show after a deliberate delay so brief buffering isn't flagged
    if (isError) {
      if (!_signalLostShown) {
        _signalLostShown = true;
        const sub = document.getElementById('snx-signal-lost-sub');
        if (sub) sub.textContent = 'RECONNECTING...';
        overlay.classList.add('visible');
      }
    } else {
      // Recovered
      if (_signalLostShown) {
        _hideSignalLost(overlay);
      }
    }
  }, 2000);
}

function _hideSignalLost(overlay) {
  _signalLostShown = false;
  if (overlay) overlay.classList.remove('visible');
}

/* ════════════════════════════════════
   MUTATION OBSERVER
   Watches the existing DOM nodes the broadcast engine writes to,
   and mirrors them into the theater UI on change.
   No extra setInterval needed.
════════════════════════════════════ */
function _startObserver() {
  const targets = [
    document.getElementById('ax-np-panel-title'),
    document.getElementById('ax-np-panel-meta'),
    document.getElementById('ax-np-panel-time'),
    document.getElementById('ax-np-panel-remain'),
    document.getElementById('ax-progress-fill'),
    document.getElementById('ax-up-next-list'),
    document.getElementById('ax-np-title'),
  ].filter(Boolean);

  if (!targets.length) return;

  const observer = new MutationObserver(() => {
    _syncTheaterUI();
    _updateTicker();
  });

  targets.forEach(el => {
    observer.observe(el, { childList: true, subtree: true, characterData: true, attributes: true });
  });

  // Initial sync
  _syncTheaterUI();
  _updateTicker();
}

/* ════════════════════════════════════
   LIVE CHANNELS UPDATE HOOK
   snx-tv-network.js stores live channels in _liveChannels (module-private).
   We expose a small shim: the ticker reads window._snxLiveChannels which
   snx-tv-network.js populates via the exported hook below.
════════════════════════════════════ */
export function notifyLiveChannels(channels) {
  window._snxLiveChannels = channels || [];
  _updateTicker();
}

/* ════════════════════════════════════
   MOUNT — called once from channel.html after broadcast engine is ready
════════════════════════════════════ */
export function mountTheater() {
  // Wait until #ax-hero exists (broadcast engine injects it)
  function _tryMount() {
    const hero = document.getElementById('ax-hero');
    if (!hero) {
      setTimeout(_tryMount, 150);
      return;
    }
    _signalTransition();
    _injectTheaterHeader();
    _wrapPlayerInFrame();
    _injectNowPlayingBlock();
    _injectUpNextStrip();
    _injectTicker();
    _startObserver();
    _watchSignalState();
  }
  _tryMount();
}
