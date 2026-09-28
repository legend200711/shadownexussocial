/**
 * SNX TV LIVE VIEW — Phase 2
 * snx-tv-live-view.js
 *
 * Presentation shell for watching a live broadcast inside 24-Hour TV.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ARCHITECTURE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   ONE WebRTC viewer engine:
 *     live.html#watch={roomId}   ← the proven working viewer
 *
 *   This shell:
 *     - Embeds live.html as a same-origin <iframe> inside the TV UI
 *     - Provides Shadow Nexus TV chrome (header, back, creator info)
 *     - Pauses/resumes Main TV media to prevent audio overlap
 *     - Handles "Live Ended" by showing a clean Shadow Nexus screen
 *     - Does NOT create a second RTCPeerConnection
 *     - Does NOT request camera or microphone
 *     - Does NOT modify live.html, live.js, or live.css
 *
 *   Exit path:
 *     BACK TO TV → iframe removed (live.js beforeunload/_viewerLeave runs) → TV restored
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * EXPORTED API
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   openTvLiveView(channel, roomId, opts)  — open the viewer shell
 *   closeTvLiveView()                      — close and restore TV
 */

'use strict';

/* ── state ── */
let _activeOverlay   = null;   // the shell div
let _activeIframe    = null;   // the embedded live.html iframe
let _liveEndedTimer  = null;   // poll interval watching for iframe "Stream Ended" state
let _popStateHandler = null;   // browser back intercept

/* ════════════════════════════════════════════════════
   OPEN TV LIVE VIEW
   @param {object} channel  — creatorChannels doc data
   @param {string} roomId   — RTDB liveRooms key (exact match from old Live system)
   @param {object} [opts]
   @param {function} [opts.onClose]   — called when viewer closes/returns to TV
   @param {function} [opts.onGoLive]  — called if user taps GO LIVE while in Live View
════════════════════════════════════════════════════ */
export function openTvLiveView(channel, roomId, opts = {}) {
  if (!roomId) {
    console.warn('[TV-LIVE-VIEW] openTvLiveView — no roomId');
    return;
  }

  // Close any existing overlay first (e.g. user tapped back then Watch again quickly)
  closeTvLiveView();

  // Pause Main TV media to prevent audio overlap
  _pauseMainTv();

  // Push history state so browser Back triggers our close handler
  history.pushState({ snxTvLiveView: true, roomId }, '');
  _popStateHandler = () => closeTvLiveView(opts.onClose);
  window.addEventListener('popstate', _popStateHandler, { once: true });

  // Build the shell overlay
  const overlay = document.createElement('div');
  overlay.id = 'snx-tv-live-view';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', `${channel?.channelName || 'Creator'} — Live`);

  const name        = _esc(channel?.channelName || 'Creator');
  const title       = _esc(channel?.title || '');
  const avatarLetter = (channel?.channelName || '?').charAt(0).toUpperCase();
  const hasAvatar   = !!channel?.avatar;

  overlay.innerHTML = `
    <div class="snx-tlv-header" id="snx-tlv-header">
      <button class="snx-tlv-back-btn" id="snx-tlv-back" aria-label="Back to Live Now">
        <span aria-hidden="true">←</span> LIVE NOW
      </button>
      <div class="snx-tlv-header-brand">
        <span class="snx-tlv-header-logo" aria-hidden="true">🌑</span>
        SHADOW NEXUS TV
      </div>
      <div class="snx-tlv-live-pill" aria-label="Live broadcast indicator">
        <span class="snx-tlv-live-dot" aria-hidden="true"></span>
        LIVE
      </div>
    </div>

    <div class="snx-tlv-body" id="snx-tlv-body">

      <!-- iframe wrapper — live.html renders the actual video + WebRTC viewer -->
      <div class="snx-tlv-frame-wrap" id="snx-tlv-frame-wrap">
        <iframe
          id="snx-tlv-iframe"
          class="snx-tlv-iframe"
          src="live.html#watch=${encodeURIComponent(roomId)}"
          allow="camera; microphone; autoplay; fullscreen"
          allowfullscreen
          title="${name} — Shadow Nexus Live"
          loading="eager"
        ></iframe>

        <!-- Shown until iframe loads -->
        <div class="snx-tlv-loading" id="snx-tlv-loading" aria-live="polite" role="status">
          <div class="snx-tlv-spinner"></div>
          <div class="snx-tlv-loading-text">Connecting to Live…</div>
        </div>

        <!-- Shown when host ends broadcast -->
        <div class="snx-tlv-ended" id="snx-tlv-ended" style="display:none;" aria-live="assertive" role="alert">
          <div class="snx-tlv-ended-icon" aria-hidden="true">🌑</div>
          <div class="snx-tlv-ended-title">LIVE HAS ENDED</div>
          <div class="snx-tlv-ended-sub">${name} has ended the broadcast.</div>
          <button class="snx-tlv-ended-back-btn" id="snx-tlv-ended-back" aria-label="Return to Live Now">
            ← RETURN TO LIVE NOW
          </button>
        </div>
      </div>

      <!-- Creator info bar (below video) -->
      <div class="snx-tlv-info-bar" id="snx-tlv-info-bar">
        <div class="snx-tlv-creator-row">
          <div class="snx-tlv-creator-avatar" aria-hidden="true">
            ${hasAvatar
              ? `<img src="${_esc(channel.avatar)}" alt="" loading="lazy"
                      style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                      onerror="this.style.display='none'">`
              : avatarLetter}
          </div>
          <div class="snx-tlv-creator-meta">
            <div class="snx-tlv-creator-name">${name}</div>
            ${title ? `<div class="snx-tlv-broadcast-title">${title}</div>` : ''}
          </div>
        </div>
      </div>

    </div><!-- .snx-tlv-body -->
  `;

  document.body.appendChild(overlay);
  _activeOverlay = overlay;

  // Wire iframe ref
  const iframe = overlay.querySelector('#snx-tlv-iframe');
  const loading = overlay.querySelector('#snx-tlv-loading');
  _activeIframe = iframe;

  // Hide loading spinner once iframe starts rendering
  if (iframe) {
    iframe.addEventListener('load', () => {
      if (loading) loading.style.display = 'none';
    }, { once: true });
    // Fallback: hide loading after 8 s regardless
    setTimeout(() => { if (loading) loading.style.display = 'none'; }, 8000);
  }

  // BACK button
  overlay.querySelector('#snx-tlv-back')?.addEventListener('click', () => {
    closeTvLiveView(opts.onClose);
  });

  // Ended-screen back button
  overlay.querySelector('#snx-tlv-ended-back')?.addEventListener('click', () => {
    closeTvLiveView(opts.onClose);
  });

  // Watch for the iframe navigating away or the room ending.
  // live.js shows #liveEndedOverlay when the host ends live.
  // We poll the iframe's document for that element becoming visible.
  _liveEndedTimer = setInterval(() => {
    try {
      const iDoc = iframe?.contentDocument;
      if (!iDoc) return;
      const ended = iDoc.getElementById('liveEndedOverlay');
      if (ended && ended.classList.contains('visible')) {
        _showEndedScreen(overlay);
      }
    } catch (_) {
      // cross-origin access denied — should not happen (same origin) but guard anyway
    }
  }, 1500);
}

/* ════════════════════════════════════════════════════
   CLOSE TV LIVE VIEW
   @param {function} [onClose] — optional callback after cleanup
════════════════════════════════════════════════════ */
export function closeTvLiveView(onClose) {
  if (!_activeOverlay) return;

  // Stop ended-state polling
  if (_liveEndedTimer) { clearInterval(_liveEndedTimer); _liveEndedTimer = null; }

  // Remove popstate handler if it hasn't fired yet
  if (_popStateHandler) {
    window.removeEventListener('popstate', _popStateHandler);
    _popStateHandler = null;
  }

  // Remove the iframe — this triggers live.js's beforeunload/_viewerLeave cleanup
  // (viewer presence removed, RTCPeerConnection closed, RTDB listeners detached)
  if (_activeIframe) {
    try {
      // Explicitly navigate away from the watch URL so the iframe fires beforeunload
      _activeIframe.src = 'about:blank';
    } catch (_) {}
    _activeIframe = null;
  }

  // Remove overlay from DOM
  try { _activeOverlay.remove(); } catch (_) {}
  _activeOverlay = null;

  // Resume Main TV media
  _resumeMainTv();

  // Return to live-now tab
  window.dispatchEvent(new CustomEvent('snx:switchTvTab', { detail: { tab: 'live-now' } }));

  if (typeof onClose === 'function') onClose();
}

/* ════════════════════════════════════════════════════
   INTERNAL — show "LIVE HAS ENDED" screen
════════════════════════════════════════════════════ */
function _showEndedScreen(overlay) {
  if (!overlay) return;
  // Only show once
  const ended = overlay.querySelector('#snx-tlv-ended');
  if (!ended || ended.style.display !== 'none') return;

  if (_liveEndedTimer) { clearInterval(_liveEndedTimer); _liveEndedTimer = null; }

  // Hide the iframe (stream is over, no point keeping it)
  const frameWrap = overlay.querySelector('#snx-tlv-frame-wrap');
  const iframe    = overlay.querySelector('#snx-tlv-iframe');
  if (iframe) {
    try { iframe.src = 'about:blank'; } catch (_) {}
    iframe.style.display = 'none';
    _activeIframe = null;
  }

  ended.style.display = '';
  ended.classList.add('visible');
}

/* ════════════════════════════════════════════════════
   MAIN TV PAUSE / RESUME
   Stops Main TV audio+video when entering a live,
   restores it when leaving.
════════════════════════════════════════════════════ */
function _pauseMainTv() {
  const vid = document.getElementById('ax-video');
  const aud = document.getElementById('ax-audio');
  if (vid && !vid.paused) { try { vid.pause(); } catch (_) {} }
  if (aud && !aud.paused) { try { aud.pause(); } catch (_) {} }
}

function _resumeMainTv() {
  // Only resume if the TV page is active and the user is on the main-tv tab
  if (window._snxTvPageActive === false) return;
  const vid = document.getElementById('ax-video');
  const aud = document.getElementById('ax-audio');
  if (vid && vid.src && vid.paused) { vid.play().catch(() => {}); }
  if (aud && aud.src && aud.paused) { aud.play().catch(() => {}); }
}

/* ════════════════════════════════════════════════════
   HTML ESCAPE
════════════════════════════════════════════════════ */
function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
