/**
 * SNX CREATOR LIVE VIEWER — Full Live Stage UI
 * snx-creator-live-viewer.js
 *
 * Renders a full-screen live stage (host OR viewer) inside channel.html
 * using #snx-crl-overlay (injected on first use).
 *
 * Does NOT touch the Aurenix broadcast engine.
 * Does NOT create a separate page or navigate away.
 *
 * Entry points:
 *   openHostLiveStage(user, userData, channel)  — creator GO LIVE flow
 *   openViewerLiveStage(user, userData, channel, liveId)  — viewer WATCH flow
 *
 * Both are called from snx-tv-network.js.
 */

import {
  openCreatorSetup,
  startCreatorBroadcast,
  endCreatorBroadcast,
  getHostStream,
  getHostState,
  toggleHostCam,
  toggleHostMic,
  flipHostCamera,
  joinCreatorLive,
  leaveCreatorLive,
  sendViewerChat,
  sendHostChat,
} from './snx-creator-live.js';

import {
  followChannel,
  unfollowChannel,
  isFollowingChannel,
  loadUserProfile,
  loadReplay,
  subscribeReplay,
  createReplayRecord,
  publishReplay,
  deleteReplay,
  updateReplayDetails,
  incrementReplayViews,
  likeReplay,
  unlikeReplay,
  hasLikedReplay,
  addReplayComment,
  subscribeReplayComments,
  deleteReplayComment,
} from './snx-creator-channels.js';

/* ══════════════════════════════════════════════════════════════
   OVERLAY HELPERS
══════════════════════════════════════════════════════════════ */
function _getOrCreateOverlay() {
  let el = document.getElementById('snx-crl-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'snx-crl-overlay';
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  return el;
}

function _hideOverlay() {
  const el = document.getElementById('snx-crl-overlay');
  if (el) {
    // Clean up all subscriptions/handlers stored on the overlay before wiping it
    if (el._founderStateUnsub)    { try { el._founderStateUnsub();    } catch (_) {} el._founderStateUnsub    = null; }
    if (el._crlHostChatUnsub)     { try { el._crlHostChatUnsub();     } catch (_) {} el._crlHostChatUnsub     = null; }
    if (el._crlRpCommentUnsub)    { try { el._crlRpCommentUnsub();    } catch (_) {} el._crlRpCommentUnsub    = null; }
    if (el._crlRpReplayUnsub)     { try { el._crlRpReplayUnsub();     } catch (_) {} el._crlRpReplayUnsub     = null; }
    if (el._crlPopStateHandler)   { window.removeEventListener('popstate',    el._crlPopStateHandler);   el._crlPopStateHandler   = null; }
    if (el._crlBeforeUnloadHandler){ window.removeEventListener('beforeunload', el._crlBeforeUnloadHandler); el._crlBeforeUnloadHandler = null; }
    el.style.display = 'none';
    el.innerHTML = '';
  }
}

/* ══════════════════════════════════════════════════════════════
   HOST LIVE STAGE
══════════════════════════════════════════════════════════════ */
export async function openHostLiveStage(user, userData, channel) {
  const overlay = _getOrCreateOverlay();

  // ── Re-entry guard: if already live, reconnect to the existing broadcast ──
  const existingState = getHostState();
  if (existingState && !existingState.endedFlag) {
    // Host is already broadcasting — show the live stage instead of setup
    overlay.innerHTML = _buildLiveStageHTML(true, channel, null);
    const videoEl = overlay.querySelector('#crl-live-video');
    const existingStream = getHostStream();
    if (videoEl && existingStream) {
      videoEl.srcObject = existingStream;
      videoEl.muted = true;
      videoEl.play().catch(() => {});
    }
    _wireHostStage(overlay, user, userData, channel, {
      action:      'go_live',
      localStream: existingStream,
      camOn:       existingState.camOn,
      micOn:       existingState.micOn,
      facingMode:  existingState.facingMode,
      title:       existingState.roomData?.title || channel?.channelName || 'Live Broadcast',
      _reconnect:  true,  // flag: skip startCreatorBroadcast
    });
    return;
  }

  // Show setup inside the overlay
  overlay.innerHTML = `<div id="crl-setup-container" style="flex:1;overflow-y:auto;background:var(--crl-void,#02040a);"></div>`;
  const setupContainer = overlay.querySelector('#crl-setup-container');

  await openCreatorSetup(user, userData, setupContainer, async result => {
    if (result.action === 'cancelled') {
      _hideOverlay();
      return;
    }
    if (result.action === 'go_live') {
      // Transition from setup to live stage
      overlay.innerHTML = _buildLiveStageHTML(true, channel, null);
      _wireHostStage(overlay, user, userData, channel, result);
    }
  });
}

async function _wireHostStage(overlay, user, userData, channel, setupResult) {
  const videoEl  = overlay.querySelector('#crl-live-video');
  const camOff   = overlay.querySelector('.crl-cam-off-overlay');
  const timerEl  = overlay.querySelector('#crl-timer');
  const timerTxt = overlay.querySelector('#crl-timer-text');
  const vcEl     = overlay.querySelector('#crl-viewer-count');
  const chatMsgs = overlay.querySelector('#crl-chat-messages');
  const chatInput= overlay.querySelector('#crl-chat-input');
  const chatSend = overlay.querySelector('#crl-chat-send');

  // Attach local stream to video element immediately
  if (videoEl && setupResult.localStream) {
    videoEl.srcObject = setupResult.localStream;
    videoEl.muted = true;
    videoEl.play().catch(() => {});
  }

  if (camOff) camOff.classList.toggle('visible', !setupResult.camOn);

  let liveId = null;
  let timerInterval = null;
  let timerStartTs = null;
  let chatSending = false;

  if (setupResult._reconnect) {
    // Re-entry: already broadcasting — recover liveId from existing state
    liveId = getHostState()?.liveId || null;
    if (!liveId) { _hideOverlay(); return; }
  } else {
    // Start fresh broadcast — ALL 10 steps must succeed before declaring LIVE
    try {
      liveId = await startCreatorBroadcast(user, userData, {
        localStream: setupResult.localStream,
        camOn:       setupResult.camOn,
        micOn:       setupResult.micOn,
        facingMode:  setupResult.facingMode,
        title:       setupResult.title,
      });
      // Only reach here if creatorChannels.status === 'live' was confirmed
      _toast('🔴 You are LIVE!', 'live');
    } catch (err) {
      console.error('[SNX LIVE] _wireHostStage — startCreatorBroadcast FAILED:', err);
      _toast('❌ Failed to start broadcast: ' + err.message, 'error');
      setTimeout(() => _hideOverlay(), 3000);
      return;
    }
  }

  // Patch title display
  const titleEl = overlay.querySelector('#crl-live-title');
  if (titleEl) titleEl.textContent = setupResult.title;

  // Listen for events from the broadcast engine
  function _onCrl(e) {
    const { type, detail } = e;
    if (type === 'crl:viewerCount') {
      if (vcEl && detail.liveId === liveId) vcEl.textContent = `👁 ${detail.count}`;
    }
    if (type === 'crl:camToggle') {
      if (camOff) camOff.classList.toggle('visible', !detail.camOn);
      const btn = overlay.querySelector('#crl-host-cam-btn');
      if (btn) { btn.classList.toggle('off', !detail.camOn); btn.textContent = detail.camOn ? '📷' : '🚫'; }
    }
    if (type === 'crl:micToggle') {
      const btn = overlay.querySelector('#crl-host-mic-btn');
      if (btn) { btn.classList.toggle('off', !detail.micOn); btn.textContent = detail.micOn ? '🎤' : '🔇'; }
    }
    if (type === 'crl:streamFlipped' || type === 'crl:streamRestored') {
      if (videoEl) { videoEl.srcObject = detail.stream; videoEl.play().catch(() => {}); }
    }
  }

  const evtTypes = ['crl:viewerCount','crl:camToggle','crl:micToggle','crl:streamFlipped','crl:streamRestored'];
  evtTypes.forEach(t => window.addEventListener(t, _onCrl));

  // Timer
  function _startTimer() {
    timerStartTs = Date.now();
    if (timerEl) timerEl.classList.add('visible');
    timerInterval = setInterval(() => {
      if (!timerStartTs) return;
      const elapsed = Math.floor((Date.now() - timerStartTs) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      if (timerTxt) timerTxt.textContent =
        `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    }, 1000);
  }
  _startTimer();

  // Chat subscription (host reads own room)
  const hostState = getHostState();
  if (hostState?.rtdbRoomId) {
    const { onSnapshot: onSnap, collection: col, query: q, orderBy: ob, limit: lim } =
      await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
    const { db: crlDb } = await import('./snx-creator-live.js');
    const chatQ = q(col(crlDb, 'liveRooms', hostState.rtdbRoomId, 'liveMessages'), ob('createdAt', 'asc'), lim(80));
    const chatUnsub = onSnap(chatQ, snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'added') _appendChatMsg(chatMsgs, ch.doc.data(), user.uid);
      });
    });
    overlay._crlHostChatUnsub = chatUnsub;
  }

  // Chat send
  async function _sendChat() {
    if (chatSending) return;
    const text = chatInput?.value?.trim();
    if (!text) return;
    chatSending = true;
    if (chatInput) chatInput.value = '';
    try { await sendHostChat(user, userData, text); } catch (_) {}
    chatSending = false;
    chatInput?.focus();
  }
  chatSend?.addEventListener('click', _sendChat);
  chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendChat(); } });

  // Host control buttons
  overlay.querySelector('#crl-host-cam-btn')?.addEventListener('click', () => toggleHostCam());
  overlay.querySelector('#crl-host-mic-btn')?.addEventListener('click', () => toggleHostMic());
  overlay.querySelector('#crl-host-flip-btn')?.addEventListener('click', () => flipHostCamera());

  // End Live button → confirm dialog
  overlay.querySelector('#crl-end-live-btn')?.addEventListener('click', () => {
    const confirm = overlay.querySelector('.crl-confirm-overlay');
    if (confirm) confirm.classList.add('visible');
  });

  // Confirm end
  overlay.querySelector('#crl-confirm-end-btn')?.addEventListener('click', async () => {
    await _cleanupHostStage(overlay, user, liveId, timerInterval, evtTypes, _onCrl);
  });

  // Cancel confirm
  overlay.querySelector('#crl-confirm-cancel-btn')?.addEventListener('click', () => {
    const confirm = overlay.querySelector('.crl-confirm-overlay');
    if (confirm) confirm.classList.remove('visible');
  });

  // Close/X button — while live, show confirm instead of just closing
  overlay.querySelector('.crl-close-btn')?.addEventListener('click', () => {
    const confirm = overlay.querySelector('.crl-confirm-overlay');
    if (confirm) confirm.classList.add('visible');
  });

  // ── Browser/mobile back guard ────────────────────────────────────────────
  // Push a history state so we intercept the back button.
  history.pushState({ crlLive: true }, '');
  function _onPopState(e) {
    if (!getHostState() || getHostState()?.endedFlag) {
      window.removeEventListener('popstate', _onPopState);
      return;
    }
    // Push state again to keep the guard in place
    history.pushState({ crlLive: true }, '');
    const confirm = overlay.querySelector('.crl-confirm-overlay');
    if (confirm) confirm.classList.add('visible');
  }
  window.addEventListener('popstate', _onPopState);
  overlay._crlPopStateHandler = _onPopState;

  // ── beforeunload guard ───────────────────────────────────────────────────
  function _onBeforeUnload(e) {
    if (!getHostState() || getHostState()?.endedFlag) return;
    e.preventDefault();
    e.returnValue = '';
  }
  window.addEventListener('beforeunload', _onBeforeUnload);
  overlay._crlBeforeUnloadHandler = _onBeforeUnload;

  // Listen for external crl:ended event (e.g. RTDB disconnect cleanup)
  window.addEventListener('crl:ended', function onEnded(e) {
    window.removeEventListener('crl:ended', onEnded);
    if (overlay._crlEndingFlag) return;  // already being ended via confirm button
    overlay._crlEndingFlag = true;
    if (timerInterval) clearInterval(timerInterval);
    evtTypes.forEach(t => window.removeEventListener(t, _onCrl));
    if (overlay._crlHostChatUnsub) { try { overlay._crlHostChatUnsub(); } catch (_) {} overlay._crlHostChatUnsub = null; }
    if (overlay._crlPopStateHandler) { window.removeEventListener('popstate', overlay._crlPopStateHandler); overlay._crlPopStateHandler = null; }
    if (overlay._crlBeforeUnloadHandler) { window.removeEventListener('beforeunload', overlay._crlBeforeUnloadHandler); overlay._crlBeforeUnloadHandler = null; }
    // Capture stats from event detail
    const peakViewers = e.detail?.peakViewers || 0;
    const timerTxtEl = overlay.querySelector('#crl-timer-text');
    const durationStr = timerTxtEl?.textContent || null;
    const durationSec = durationStr ? _parseTimerToSeconds(durationStr) : null;
    const titleEl2 = overlay.querySelector('#crl-live-title');
    const liveTitle = titleEl2?.textContent?.trim() || 'Live Replay';
    _showEndLiveReplayModal(overlay, user, e.detail?.liveId || liveId, liveTitle, durationSec, peakViewers);
  });
}

async function _cleanupHostStage(overlay, user, liveId, timerInterval, evtTypes, _onCrl) {
  // Idempotency guard: prevent double-end from double-click or duplicate calls
  if (overlay._crlEndingFlag) return;
  overlay._crlEndingFlag = true;
  console.log('[SNX LIVE] END_BUTTON_CLICKED — _cleanupHostStage entered, liveId:', liveId);

  const endBtn = overlay.querySelector('#crl-confirm-end-btn');
  if (endBtn) { endBtn.disabled = true; endBtn.textContent = 'Ending…'; }

  console.log('[SNX LIVE] END_CONFIRM_OPENED — confirmed, proceeding to teardown');

  if (timerInterval) clearInterval(timerInterval);
  evtTypes.forEach(t => window.removeEventListener(t, _onCrl));
  if (overlay._crlHostChatUnsub) { try { overlay._crlHostChatUnsub(); } catch (_) {} overlay._crlHostChatUnsub = null; }
  if (overlay._crlPopStateHandler) { window.removeEventListener('popstate', overlay._crlPopStateHandler); overlay._crlPopStateHandler = null; }
  if (overlay._crlBeforeUnloadHandler) { window.removeEventListener('beforeunload', overlay._crlBeforeUnloadHandler); overlay._crlBeforeUnloadHandler = null; }

  // Capture elapsed duration before tearing down
  const timerTxt = overlay.querySelector('#crl-timer-text');
  const durationStr = timerTxt?.textContent || null;
  const durationSec = durationStr ? _parseTimerToSeconds(durationStr) : null;

  // Get title from stage UI
  const titleEl = overlay.querySelector('#crl-live-title');
  const liveTitle = titleEl?.textContent?.trim() || 'Live Replay';

  // Get viewer stats before ending (peak viewers from hostState)
  const { getHostState: ghs } = await import('./snx-creator-live.js');
  const peakViewers = ghs()?.peakViewers || 0;

  // Note: live.js is the authoritative broadcast engine.
  // If this cleanup path is reached (legacy snx-creator-live.js host path),
  // end the broadcast via the adapter which handles creatorChannels offline.
  console.log('[SNX LIVE] END_CONFIRMED — calling endActiveBroadcast for uid:', user.uid);
  try {
    const { endActiveBroadcast } = await import('./snx-live-adapter.js');
    await endActiveBroadcast(user.uid);
    console.log('[SNX LIVE] END_ACTIVE_BROADCAST_FINISHED — success');
  } catch (_endErr) {
    console.error('[SNX LIVE] END_ACTIVE_BROADCAST_FAILED:', _endErr);
    // Still proceed to replay modal
  }

  // Show "YOUR LIVE HAS ENDED" replay decision modal
  // Navigation back to channel happens inside the replay modal (no window.close / logout)
  _showEndLiveReplayModal(overlay, user, liveId, liveTitle, durationSec, peakViewers);
}

/* ══════════════════════════════════════════════════════════════
   END-LIVE REPLAY MODAL  (Stage 3)
   Shown to the host immediately after endCreatorBroadcast completes.

   Flow:
     1. Screen shows YOUR LIVE HAS ENDED with stats (duration, peak viewers)
     2. Creator chooses: POST REPLAY / SAVE PRIVATE / DELETE
     3. POST REPLAY opens a publishing sub-screen with title/desc/visibility/feed
     4. DELETE shows an explicit confirmation before removing
     5. SAVE PRIVATE saves immediately as private
══════════════════════════════════════════════════════════════ */
function _showEndLiveReplayModal(overlay, user, liveId, liveTitle, durationSec, peakViewers = 0) {
  const durationFmt = durationSec ? _fmtDuration(durationSec) : '—';
  const peakFmt     = peakViewers > 0 ? peakViewers.toLocaleString() : '0';

  overlay.innerHTML = `
    <div class="crl-end-replay-screen">
      <div class="crl-end-replay-header">
        <div class="crl-end-replay-icon">🌑</div>
        <div class="crl-end-replay-title">YOUR LIVE HAS ENDED</div>
        <div class="crl-end-replay-sub">Your channel is now OFF AIR.</div>
      </div>

      <div class="crl-end-stats-row">
        <div class="crl-end-stat">
          <div class="crl-end-stat-label">Broadcast Duration</div>
          <div class="crl-end-stat-value">${_esc(durationFmt)}</div>
        </div>
        <div class="crl-end-stat">
          <div class="crl-end-stat-label">Peak Viewers</div>
          <div class="crl-end-stat-value">${_esc(peakFmt)}</div>
        </div>
      </div>

      <div class="crl-end-recording-status" id="crl-end-rec-status">
        <span class="crl-rec-dot crl-rec-dot-proc"></span>
        Recording: Processing…
      </div>

      <div id="crl-end-replay-status" class="crl-end-replay-status"></div>

      <!-- Choice buttons -->
      <div class="crl-end-replay-actions" id="crl-end-choice-btns">

        <button class="crl-replay-btn crl-replay-btn-post" id="crl-replay-post-btn">
          <span class="crl-replay-btn-icon">📡</span>
          <span class="crl-replay-btn-text-group">
            <span class="crl-replay-btn-label">POST REPLAY</span>
            <span class="crl-replay-btn-desc">Publish to your channel for viewers to watch</span>
          </span>
        </button>

        <button class="crl-replay-btn crl-replay-btn-private" id="crl-replay-save-btn">
          <span class="crl-replay-btn-icon">🔒</span>
          <span class="crl-replay-btn-text-group">
            <span class="crl-replay-btn-label">SAVE PRIVATE</span>
            <span class="crl-replay-btn-desc">Only you can access — publish anytime later</span>
          </span>
        </button>

        <button class="crl-replay-btn crl-replay-btn-delete" id="crl-replay-delete-btn">
          <span class="crl-replay-btn-icon">🗑</span>
          <span class="crl-replay-btn-text-group">
            <span class="crl-replay-btn-label">DELETE</span>
            <span class="crl-replay-btn-desc">Remove this broadcast permanently</span>
          </span>
        </button>

      </div>

      <!-- POST REPLAY publish sub-screen (hidden until post is clicked) -->
      <div class="crl-publish-screen" id="crl-publish-screen" style="display:none;">
        <div class="crl-publish-title">PUBLISH REPLAY</div>

        <div class="crl-end-replay-title-field">
          <label class="crl-end-replay-label">Replay Title</label>
          <input class="crl-end-replay-input" id="crl-replay-title-input"
                 type="text" maxlength="80"
                 value="${_esc(liveTitle)}"
                 placeholder="Give your replay a title…">
        </div>

        <div class="crl-end-replay-title-field">
          <label class="crl-end-replay-label">Description <span style="font-size:10px;color:#5a80a8;">(optional)</span></label>
          <textarea class="crl-end-replay-input" id="crl-replay-desc-input"
                    rows="2" maxlength="300"
                    placeholder="Tell viewers what this replay is about…"></textarea>
        </div>

        <div class="crl-end-replay-title-field">
          <label class="crl-end-replay-label">Thumbnail URL <span style="font-size:10px;color:#5a80a8;">(optional)</span></label>
          <input class="crl-end-replay-input" id="crl-replay-thumb-input"
                 type="url" placeholder="https://…">
        </div>

        <div class="crl-end-replay-title-field">
          <label class="crl-end-replay-label">Visibility</label>
          <div class="crl-vis-options">
            <label class="crl-vis-opt">
              <input type="radio" name="crl-vis" value="public" checked>
              <span class="crl-vis-opt-label">🌐 PUBLIC</span>
              <span class="crl-vis-opt-desc">Anyone can watch</span>
            </label>
            <label class="crl-vis-opt">
              <input type="radio" name="crl-vis" value="followers">
              <span class="crl-vis-opt-label">👥 FOLLOWERS ONLY</span>
              <span class="crl-vis-opt-desc">Only your followers</span>
            </label>
          </div>
        </div>

        <div class="crl-end-replay-title-field">
          <label class="crl-feed-check">
            <input type="checkbox" id="crl-post-to-feed-chk">
            <span>Also share to Shadow Nexus Feed</span>
          </label>
        </div>

        <div id="crl-publish-err" class="crl-end-replay-status"></div>

        <div class="crl-publish-actions">
          <button class="crl-btn-cancel" id="crl-publish-back-btn">← Back</button>
          <button class="crl-replay-btn crl-replay-btn-post" id="crl-publish-confirm-btn" style="flex:1;">
            <span class="crl-replay-btn-label" style="font-size:13px;">📡 POST REPLAY</span>
          </button>
        </div>
      </div>

      <!-- DELETE confirm sub-screen (hidden until delete is clicked) -->
      <div class="crl-delete-confirm-screen" id="crl-delete-screen" style="display:none;">
        <div class="crl-publish-title" style="color:var(--crl-red);">DELETE RECORDING</div>
        <div class="crl-delete-confirm-text">
          Delete this Live recording?<br>
          <strong>This cannot be undone.</strong>
        </div>
        <div id="crl-delete-err" class="crl-end-replay-status"></div>
        <div class="crl-publish-actions">
          <button class="crl-btn-cancel" id="crl-delete-back-btn">CANCEL</button>
          <button class="crl-replay-btn crl-replay-btn-delete" id="crl-delete-confirm-btn" style="flex:1;">
            <span class="crl-replay-btn-label" style="font-size:13px;">🗑 DELETE</span>
          </button>
        </div>
      </div>

    </div>
  `;

  // ── shared refs ──
  const statusEl      = overlay.querySelector('#crl-end-replay-status');
  const choiceBtns    = overlay.querySelector('#crl-end-choice-btns');
  const publishScreen = overlay.querySelector('#crl-publish-screen');
  const deleteScreen  = overlay.querySelector('#crl-delete-screen');

  // Simulate processing → ready after 2 s (no real video pipeline yet)
  let replayIdCreated = null;   // populated when record is first created
  let processingDone  = false;

  function _showChoiceOnly()   { choiceBtns.style.display = ''; publishScreen.style.display = 'none'; deleteScreen.style.display = 'none'; }
  function _showPublishScreen(){ choiceBtns.style.display = 'none'; publishScreen.style.display = ''; deleteScreen.style.display = 'none'; }
  function _showDeleteScreen() { choiceBtns.style.display = 'none'; publishScreen.style.display = 'none'; deleteScreen.style.display = ''; }

  function _setStatus(msg, isError = false) {
    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = isError ? 'var(--crl-red)' : 'var(--crl-blue)'; }
  }

  function _setBtnsDisabled(screen, on) {
    screen.querySelectorAll('button').forEach(b => { b.disabled = on; });
  }

  // Simulate processing completion after 2 s
  setTimeout(() => {
    processingDone = true;
    const recEl = overlay.querySelector('#crl-end-rec-status');
    if (recEl) {
      recEl.innerHTML = '<span class="crl-rec-dot crl-rec-dot-ready"></span> Recording: Ready';
    }
  }, 2000);

  // ── SAVE PRIVATE ──
  let _savePrivatePending = false;
  overlay.querySelector('#crl-replay-save-btn')?.addEventListener('click', async () => {
    if (_savePrivatePending || replayIdCreated) return;
    _savePrivatePending = true;
    _setBtnsDisabled(choiceBtns, true);
    _setStatus('Saving privately…');
    try {
      replayIdCreated = await createReplayRecord(user.uid, liveId, {
        title:          liveTitle,
        duration:       durationSec,
        livePeakViewers: peakViewers,
        recordingUrl:   null,
      });
      // stays as private (default from createReplayRecord)
      _setStatus('✓ Saved privately. You can publish anytime from MY CHANNEL → REPLAYS.');
      setTimeout(() => _returnHostToChannel(), 3000);
    } catch (err) {
      _setStatus('Error: ' + (err.message || 'Could not save.'), true);
      _savePrivatePending = false;
      _setBtnsDisabled(choiceBtns, false);
    }
  });

  // ── POST REPLAY → open publish screen ──
  overlay.querySelector('#crl-replay-post-btn')?.addEventListener('click', () => {
    _showPublishScreen();
  });

  overlay.querySelector('#crl-publish-back-btn')?.addEventListener('click', () => {
    _showChoiceOnly();
    const errEl = overlay.querySelector('#crl-publish-err');
    if (errEl) errEl.textContent = '';
  });

  // ── PUBLISH CONFIRM ──
  let _publishPending = false;
  overlay.querySelector('#crl-publish-confirm-btn')?.addEventListener('click', async () => {
    if (_publishPending) return;
    _publishPending = true;

    const title       = overlay.querySelector('#crl-replay-title-input')?.value.trim() || liveTitle;
    const description = overlay.querySelector('#crl-replay-desc-input')?.value.trim() || '';
    const thumbnail   = overlay.querySelector('#crl-replay-thumb-input')?.value.trim() || null;
    const visibility  = overlay.querySelector('input[name="crl-vis"]:checked')?.value || 'public';
    const postToFeed  = overlay.querySelector('#crl-post-to-feed-chk')?.checked || false;
    const errEl       = overlay.querySelector('#crl-publish-err');

    _setBtnsDisabled(publishScreen, true);
    if (errEl) { errEl.textContent = 'Publishing…'; errEl.style.color = 'var(--crl-blue)'; }

    try {
      // Create the record first (if not already created via save-private)
      if (!replayIdCreated) {
        replayIdCreated = await createReplayRecord(user.uid, liveId, {
          title, description, thumbnail,
          duration:        durationSec,
          livePeakViewers: peakViewers,
          recordingUrl:    null,
        });
      }

      await publishReplay(user.uid, replayIdCreated, visibility, {
        title, description, thumbnail, postToFeed,
      });

      if (errEl) { errEl.textContent = '✓ Replay published!'; errEl.style.color = 'var(--crl-blue)'; }
      setTimeout(() => _returnHostToChannel(), 2200);
    } catch (err) {
      if (errEl) { errEl.textContent = 'Error: ' + (err.message || 'Publish failed.'); errEl.style.color = 'var(--crl-red)'; }
      _publishPending = false;
      _setBtnsDisabled(publishScreen, false);
    }
  });

  // ── DELETE → show confirm screen ──
  overlay.querySelector('#crl-replay-delete-btn')?.addEventListener('click', () => {
    _showDeleteScreen();
  });

  overlay.querySelector('#crl-delete-back-btn')?.addEventListener('click', () => {
    _showChoiceOnly();
    const errEl = overlay.querySelector('#crl-delete-err');
    if (errEl) errEl.textContent = '';
  });

  overlay.querySelector('#crl-delete-confirm-btn')?.addEventListener('click', async () => {
    const errEl = overlay.querySelector('#crl-delete-err');
    _setBtnsDisabled(deleteScreen, true);
    if (errEl) { errEl.textContent = 'Deleting…'; errEl.style.color = 'var(--crl-blue)'; }

    try {
      if (replayIdCreated) {
        // Record already created — delete it
        await deleteReplay(user.uid, replayIdCreated);
      }
      // If no record yet, nothing to delete — just close
      if (errEl) errEl.textContent = '';
      _returnHostToChannel();
    } catch (err) {
      if (errEl) { errEl.textContent = 'Error: ' + (err.message || 'Delete failed.'); errEl.style.color = 'var(--crl-red)'; }
      _setBtnsDisabled(deleteScreen, false);
    }
  });
}

/* Navigate host back to MY CHANNEL tab after end-live flow completes */
function _returnHostToChannel() {
  _hideOverlay();
  // Switch the TV Network to MY CHANNEL tab
  window.dispatchEvent(new CustomEvent('snx:switchTvTab', { detail: { tab: 'my-channel' } }));
}

/* Parse "HH:MM:SS" timer string to seconds */
function _parseTimerToSeconds(str) {
  if (!str) return null;
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

/* ══════════════════════════════════════════════════════════════
   VIEWER LIVE STAGE
══════════════════════════════════════════════════════════════ */
export async function openViewerLiveStage(user, userData, channel, liveId) {
  const overlay = _getOrCreateOverlay();
  overlay.innerHTML = _buildLiveStageHTML(false, channel, null);

  // Show connecting state
  _showConnBanner(overlay, 'Connecting to Live…', '');

  const videoEl  = overlay.querySelector('#crl-live-video');
  const chatMsgs = overlay.querySelector('#crl-chat-messages');
  const chatInput= overlay.querySelector('#crl-chat-input');
  const chatSend = overlay.querySelector('#crl-chat-send');
  const vcEl     = overlay.querySelector('#crl-viewer-count');
  const likeBtn  = overlay.querySelector('#crl-like-btn');

  // ── Live duration timer from startedAt ───────────────────────
  let _viewerDurationTimer = null;
  function _startViewerDuration(startedAt) {
    if (_viewerDurationTimer) clearInterval(_viewerDurationTimer);
    const startMs = startedAt?.toMillis ? startedAt.toMillis()
      : startedAt?.seconds ? startedAt.seconds * 1000
      : startedAt ? new Date(startedAt).getTime() : null;
    if (!startMs) return;
    function _tick() {
      const el = overlay.querySelector('#crl-viewer-duration');
      if (!el) { clearInterval(_viewerDurationTimer); return; }
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = elapsed % 60;
      const fmt = h > 0
        ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
        : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
      el.textContent = `LIVE • ${fmt}`;
    }
    _tick();
    _viewerDurationTimer = setInterval(_tick, 1000);
  }

  // ── FOUNDER: Feature on Main TV control (Stage 4) ─────────────────────────
  // Injected only when the viewer is the founder. Not rendered for anyone else.
  // Protected both here (client hide) AND by Firestore rules (server enforce).
  try {
    const { isFounderUser, featureCreatorOnMainTv, removeCreatorFromMainTv,
            loadMainTvState, subscribeMainTvState } =
      await import('./snx-main-tv-feature.js');

    if (isFounderUser(user)) {
      _injectFounderFeatureControl(overlay, user, channel, liveId,
        { featureCreatorOnMainTv, removeCreatorFromMainTv,
          loadMainTvState, subscribeMainTvState });
    }
  } catch (e) {
    // Module load failure: silently skip founder controls — do not break viewer
    console.warn('[SNX TV Viewer] Feature bridge load failed:', e.message);
  }

  // Update channel info
  if (channel) {
    const nameEl = overlay.querySelector('#crl-creator-name');
    if (nameEl) nameEl.textContent = channel.channelName || 'Creator';
    const avatarEl = overlay.querySelector('#crl-creator-avatar');
    if (avatarEl) {
      if (channel.avatar) avatarEl.style.backgroundImage = `url('${channel.avatar}')`;
      else avatarEl.textContent = (channel.channelName || '?')[0].toUpperCase();
    }
  }

  // Follow button state
  if (user && channel?.ownerUid && user.uid !== channel.ownerUid) {
    isFollowingChannel(channel.ownerUid, user.uid).then(following => {
      const btn = overlay.querySelector('#crl-follow-btn');
      if (btn) {
        btn.classList.toggle('following', following);
        btn.textContent = following ? '✓ Following' : '+ Follow';
      }
    }).catch(() => {});
  }

  let chatSending = false;

  // ── Diagnostic panel state ────────────────────────────────────────────────
  // Injected as a floating overlay so it's visible on mobile without DevTools.
  let _diagEl = null;
  const _diagState = {
    roomId: '…', viewerId: '…',
    offerState: 'WAITING', remoteDescState: 'WAITING',
    answerState: 'WAITING',
    hostIce: 0, viewerIce: 0,
    iceState: '…', connState: '…',
    trackKinds: [], videoPlay: 'WAITING',
  };

  function _renderDiag() {
    if (!_diagEl) return;
    const trackStr = _diagState.trackKinds.length
      ? _diagState.trackKinds.join(', ')
      : 'WAITING';
    _diagEl.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px;letter-spacing:.05em;">📡 WebRTC Diagnostics</div>
      <div>ROOM ID: <b>${_diagEl.__roomId || _diagState.roomId}</b></div>
      <div>VIEWER ID: <b>${_diagEl.__viewerId || _diagState.viewerId}</b></div>
      <div>OFFER: <b style="color:${_diagState.offerState==='RECEIVED'?'#4ade80':'#fbbf24'}">${_diagState.offerState}</b></div>
      <div>REMOTE DESC: <b style="color:${_diagState.remoteDescState==='SET'?'#4ade80':'#fbbf24'}">${_diagState.remoteDescState}</b></div>
      <div>ANSWER: <b style="color:${_diagState.answerState==='SENT'?'#4ade80':'#fbbf24'}">${_diagState.answerState}</b></div>
      <div>HOST ICE: <b>${_diagState.hostIce}</b></div>
      <div>VIEWER ICE: <b>${_diagState.viewerIce}</b></div>
      <div>ICE STATE: <b>${_diagState.iceState}</b></div>
      <div>CONN STATE: <b style="color:${_diagState.connState==='connected'?'#4ade80':_diagState.connState==='failed'?'#f87171':'#fbbf24'}">${_diagState.connState}</b></div>
      <div>REMOTE TRACK: <b style="color:${trackStr!=='WAITING'?'#4ade80':'#fbbf24'}">${trackStr}</b></div>
      <div>VIDEO PLAY: <b style="color:${_diagState.videoPlay==='PLAYING'?'#4ade80':_diagState.videoPlay.startsWith('ERR')?'#f87171':'#fbbf24'}">${_diagState.videoPlay}</b></div>
    `.trim();
  }

  function _injectDiagPanel() {
    if (_diagEl) return;
    _diagEl = document.createElement('div');
    _diagEl.id = 'snx-webrtc-diag';
    _diagEl.style.cssText = [
      'position:fixed', 'top:8px', 'left:8px', 'z-index:99999',
      'background:rgba(0,0,0,0.82)', 'color:#e2e8f0',
      'font-family:monospace', 'font-size:11px', 'line-height:1.55',
      'padding:8px 10px', 'border-radius:8px',
      'border:1px solid rgba(255,255,255,0.15)',
      'max-width:92vw', 'pointer-events:none',
      'white-space:nowrap',
    ].join(';');
    document.body.appendChild(_diagEl);
    _renderDiag();
  }

  function _removeDiagPanel() {
    if (_diagEl) { _diagEl.remove(); _diagEl = null; }
  }

  _injectDiagPanel();

  async function _onLiveEvent(event) {
    const { type } = event;

    // ── Diagnostic events (internal — update panel only) ────────────────
    if (type === '_diag') {
      _diagState.roomId   = event.roomId   || '…';
      _diagState.viewerId = event.viewerId || '…';
      if (_diagEl) { _diagEl.__roomId = event.roomId; _diagEl.__viewerId = event.viewerId; }
      _renderDiag();
      return;
    }
    if (type === '_diagOffer') {
      if (event.state === 'RECEIVED') _diagState.offerState = 'RECEIVED';
      if (event.state === 'SET')      _diagState.remoteDescState = 'SET';
      _renderDiag();
      return;
    }
    if (type === '_diagAnswer') {
      if (event.state === 'CREATED') _diagState.answerState = 'CREATED';
      if (event.state === 'SENT')    _diagState.answerState = 'SENT';
      _renderDiag();
      return;
    }
    if (type === '_diagHostIce') {
      _diagState.hostIce = event.count;
      _renderDiag();
      return;
    }
    if (type === '_diagViewerIce') {
      _diagState.viewerIce = event.count;
      _renderDiag();
      return;
    }
    if (type === '_diagIceState') {
      _diagState.iceState = event.iceConnectionState;
      _renderDiag();
      return;
    }
    if (type === '_diagConn') {
      _diagState.connState = event.connectionState;
      _diagState.iceState  = event.iceConnectionState;
      _renderDiag();
      return;
    }
    if (type === '_diagTrack') {
      if (!_diagState.trackKinds.includes(event.kind)) {
        _diagState.trackKinds.push(event.kind);
      }
      _renderDiag();
      return;
    }
    if (type === '_diagError') {
      console.error('[SNX-WEBRTC VIEWER DIAG] Step', event.step, 'ERROR:', event.error);
      if (_diagEl) {
        const errEl = document.createElement('div');
        errEl.style.cssText = 'color:#f87171;margin-top:4px;white-space:normal;';
        errEl.textContent = `❌ Step ${event.step}: ${event.error}`;
        _diagEl.appendChild(errEl);
      }
      return;
    }

    // ── Normal live events ────────────────────────────────────────────────
    if (type === 'not_found') {
      _removeDiagPanel();
      _hideConnBanner(overlay);
      _showOffAirScreen(overlay, channel?.channelName || 'Creator', false, channel?.ownerUid || channel?.id);
      if (_viewerDurationTimer) clearInterval(_viewerDurationTimer);
      return;
    }
    if (type === 'ended') {
      _removeDiagPanel();
      _hideConnBanner(overlay);
      _showOffAirScreen(overlay, channel?.channelName || 'Creator', true, channel?.ownerUid || channel?.id);
      if (_viewerDurationTimer) clearInterval(_viewerDurationTimer);
      return;
    }
    if (type === 'connecting') {
      _showConnBanner(overlay, 'Connecting to Live…', '');
      // Update channel info from roomData if available
      if (event.roomData) {
        const nameEl = overlay.querySelector('#crl-creator-name');
        if (nameEl) nameEl.textContent = event.roomData.hostName || 'Creator';
        const titleEl = overlay.querySelector('#crl-live-title');
        if (titleEl) titleEl.textContent = event.roomData.title || '';
      }
    }
    if (type === 'stream') {
      if (videoEl && event.stream) {
        videoEl.srcObject = event.stream;
        videoEl.autoplay  = true;
        videoEl.playsInline = true;
        _diagState.videoPlay = 'ATTEMPTING';
        _renderDiag();
        videoEl.play().then(() => {
          console.log('[SNX-WEBRTC VIEWER] STEP 11 — video.play() resolved — VIDEO PLAYING ✅');
          _diagState.videoPlay = 'PLAYING';
          _renderDiag();
          _hideConnBanner(overlay);
          const unmuteEl = overlay.querySelector('.crl-unmute-prompt');
          if (unmuteEl) unmuteEl.style.display = 'block';
        }).catch(err => {
          console.warn('[SNX-WEBRTC VIEWER] STEP 11 — video.play() error:', err.name, err.message);
          _diagState.videoPlay = `ERR: ${err.name}`;
          _renderDiag();
          if (err.name === 'NotAllowedError') {
            // Autoplay blocked — show tap-to-play instead of "Connecting"
            _hideConnBanner(overlay);
            _showConnBanner(overlay, 'TAP TO PLAY LIVE', 'Browser blocked autoplay');
            const tapBtn = document.createElement('button');
            tapBtn.textContent = '▶ TAP TO PLAY LIVE';
            tapBtn.style.cssText = 'margin-top:12px;padding:12px 28px;font-size:16px;font-weight:700;border-radius:8px;border:none;background:#e11d48;color:#fff;cursor:pointer;letter-spacing:.05em;';
            tapBtn.onclick = () => {
              videoEl.play().then(() => {
                console.log('[SNX-WEBRTC VIEWER] STEP 11 — video.play() resolved (tap) — VIDEO PLAYING ✅');
                _diagState.videoPlay = 'PLAYING (tap)';
                _renderDiag();
                _hideConnBanner(overlay);
                const unmuteEl = overlay.querySelector('.crl-unmute-prompt');
                if (unmuteEl) unmuteEl.style.display = 'block';
              }).catch(() => {});
              tapBtn.remove();
            };
            const banner = overlay.querySelector('.crl-conn-banner');
            if (banner) banner.appendChild(tapBtn);
          } else {
            console.warn('[SNX-WEBRTC VIEWER] video.play() error:', err.name, err.message);
            _hideConnBanner(overlay);
          }
        });
      } else {
        _hideConnBanner(overlay);
      }
    }
    if (type === 'connected') {
      _hideConnBanner(overlay);
    }
    if (type === 'connState') {
      if (event.state === 'connected') _diagState.connState = 'connected';
      _renderDiag();
    }
    if (type === 'timeout') {
      _showConnBanner(overlay, 'Unable to connect to this Live.', 'Connection timed out');
      // Retry button
      const retryBtn = document.createElement('button');
      retryBtn.textContent = '↺ Retry';
      retryBtn.style.cssText = 'margin-top:12px;padding:10px 24px;font-size:15px;border-radius:8px;border:none;background:#3b82f6;color:#fff;cursor:pointer;';
      retryBtn.onclick = async () => {
        retryBtn.disabled = true;
        await leaveCreatorLive();
        retryBtn.remove();
        _showConnBanner(overlay, 'Connecting to Live…', '');
        joinCreatorLive(user, liveId, videoEl, _onLiveEvent).catch(() => {});
      };
      const banner = overlay.querySelector('.crl-conn-banner');
      if (banner) banner.appendChild(retryBtn);
    }
    if (type === 'waiting') {
      _showConnBanner(overlay, 'Waiting for stream…', '');
    }
    if (type === 'reconnecting') {
      _showConnBanner(overlay, 'Reconnecting…', `Attempt ${event.attempt || ''}…`);
    }
    if (type === 'counts') {
      if (vcEl) vcEl.textContent = `👁 ${event.viewers || 0}`;
    }
    if (type === 'sessionUpdate') {
      if (vcEl && event.data?.viewerCount != null) vcEl.textContent = `👁 ${event.data.viewerCount}`;
      const titleEl = overlay.querySelector('#crl-live-title');
      if (titleEl && event.data?.title) titleEl.textContent = event.data.title;
      // Start duration timer from startedAt if available and not already running
      if (event.data?.startedAt && !_viewerDurationTimer) {
        _startViewerDuration(event.data.startedAt);
      }
    }
    if (type === 'chat') {
      _appendChatMsg(chatMsgs, event.message, user.uid);
    }
  }

  const handle = await joinCreatorLive(user, liveId, videoEl, _onLiveEvent);

  // Unmute on tap
  const unmuteEl = overlay.querySelector('.crl-unmute-prompt');
  if (unmuteEl) {
    unmuteEl.addEventListener('click', () => {
      if (videoEl) videoEl.muted = false;
      unmuteEl.style.display = 'none';
    });
  }

  // Chat
  async function _sendChat() {
    if (chatSending) return;
    const text = chatInput?.value?.trim();
    if (!text) return;
    chatSending = true;
    if (chatInput) chatInput.value = '';
    try { await sendViewerChat(user, userData, text); } catch (_) {}
    chatSending = false;
    chatInput?.focus();
  }
  chatSend?.addEventListener('click', _sendChat);
  chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendChat(); } });

  // Close/leave
  overlay.querySelector('.crl-close-btn')?.addEventListener('click', async () => {
    if (_viewerDurationTimer) clearInterval(_viewerDurationTimer);
    _removeDiagPanel();
    await leaveCreatorLive();
    _hideOverlay();
  });

  // Like button
  let hasLiked = false;
  likeBtn?.addEventListener('click', async () => {
    if (hasLiked) return;
    hasLiked = true;
    likeBtn.classList.add('liked');
    // Increment like in RTDB (viewer side — same as live.js)
    try {
      const { getDatabase: gdb, ref: r, runTransaction: rt } =
        await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js');
      const { db: crlDb, liveDB: crlLiveDB } = await import('./snx-creator-live.js');
      // Get the rtdbRoomId from the session
      const { doc: fDoc, getDoc: fGetDoc, getFirestore } =
        await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
      const sessionSnap = await fGetDoc(fDoc(crlDb, 'liveSessions', liveId));
      if (sessionSnap.exists()) {
        const rtdbRoomId = sessionSnap.data().rtdbRoomId;
        await rt(r(crlLiveDB, `liveRooms/${rtdbRoomId}/likes`), curr => (curr || 0) + 1);
      }
    } catch (_) {}
    setTimeout(() => { hasLiked = false; likeBtn?.classList.remove('liked'); }, 5000);
  });

  // Follow/unfollow
  overlay.querySelector('#crl-follow-btn')?.addEventListener('click', async () => {
    if (!user || !channel?.ownerUid || user.uid === channel.ownerUid) return;
    const btn = overlay.querySelector('#crl-follow-btn');
    const isFollowing = btn?.classList.contains('following');
    if (btn) btn.disabled = true;
    try {
      if (isFollowing) {
        await unfollowChannel(channel.ownerUid, user.uid);
        btn && btn.classList.remove('following');
        btn && (btn.textContent = '+ Follow');
      } else {
        await followChannel(channel.ownerUid, user.uid);
        btn && btn.classList.add('following');
        btn && (btn.textContent = '✓ Following');
      }
    } catch (_) {}
    if (btn) btn.disabled = false;
  });

  // Share
  overlay.querySelector('#crl-share-btn')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?live=${channel?.ownerUid}&liveId=${liveId}`;
    if (navigator.share) {
      navigator.share({ title: channel?.channelName + ' is LIVE', url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => _toast('Link copied!')).catch(() => {});
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   FOUNDER FEATURE CONTROL — Stage 4
   Injected inside the viewer live overlay for the founder only.
   Shows the FEATURE ON MAIN TV / RETURN TO MAIN TV button.
══════════════════════════════════════════════════════════════ */
async function _injectFounderFeatureControl(overlay, user, channel, liveId, bridge) {
  const { featureCreatorOnMainTv, removeCreatorFromMainTv,
          loadMainTvState, subscribeMainTvState } = bridge;

  // Fetch current Main TV state to know if this live is already featured
  let currentState = null;
  try { currentState = await loadMainTvState(); } catch (_) {}

  const isAlreadyFeatured = currentState?.mode === 'featured_live'
    && currentState?.featuredLiveId === liveId;

  // Build the founder feature bar
  const bar = document.createElement('div');
  bar.id = 'crl-founder-feature-bar';
  bar.style.cssText = [
    'position:absolute;bottom:64px;left:0;right:0;z-index:50;',
    'display:flex;align-items:center;justify-content:center;',
    'padding:6px 12px;gap:8px;pointer-events:none;',
  ].join('');

  function _renderBar(state) {
    const isFeatured = state?.mode === 'featured_live' && state?.featuredLiveId === liveId;
    const otherFeatured = state?.mode === 'featured_live' && state?.featuredLiveId !== liveId;
    bar.innerHTML = `
      <div style="pointer-events:all;display:flex;flex-direction:column;align-items:center;gap:6px;width:100%;max-width:360px;">
        ${isFeatured ? `
          <div style="font-size:10px;font-weight:900;letter-spacing:1.5px;color:#39FF14;padding:2px 8px;background:rgba(57,255,20,0.12);border:1px solid rgba(57,255,20,0.3);border-radius:4px;">
            ⚡ CURRENTLY FEATURED ON MAIN TV
          </div>
          <button id="crl-founder-remove-btn" style="width:100%;padding:8px 16px;background:rgba(255,45,85,0.15);border:1px solid rgba(255,45,85,0.5);color:#ff4d6a;border-radius:8px;cursor:pointer;font-size:12px;font-weight:800;letter-spacing:1px;">
            📺 RETURN MAIN TV TO SCHEDULE
          </button>
        ` : otherFeatured ? `
          <div style="font-size:10px;color:#f0a500;padding:2px 8px;background:rgba(240,165,0,0.12);border:1px solid rgba(240,165,0,0.3);border-radius:4px;">
            📺 ${_esc(state.featuredChannelName || 'Another creator')} is currently featured on Main TV
          </div>
          <button id="crl-founder-feature-btn" style="width:100%;padding:8px 16px;background:rgba(255,45,85,0.15);border:1px solid rgba(255,45,85,0.4);color:#ff4d6a;border-radius:8px;cursor:pointer;font-size:12px;font-weight:800;letter-spacing:1px;">
            📺 SWITCH MAIN TV TO THIS LIVE
          </button>
        ` : `
          <button id="crl-founder-feature-btn" style="width:100%;padding:8px 16px;background:rgba(255,45,85,0.92);border:none;color:#fff;border-radius:8px;cursor:pointer;font-size:12px;font-weight:800;letter-spacing:1px;">
            📺 FEATURE ON MAIN TV
          </button>
        `}
      </div>
    `;

    // Wire FEATURE button
    bar.querySelector('#crl-founder-feature-btn')?.addEventListener('click', async () => {
      await _showFeatureConfirmModal(user, channel, liveId, currentState, bridge, () => {
        // Refresh bar state after action
        loadMainTvState().then(s => { currentState = s; _renderBar(s); }).catch(() => {});
      });
    });

    // Wire REMOVE button
    bar.querySelector('#crl-founder-remove-btn')?.addEventListener('click', async () => {
      await _showRemoveFeatureModal(user, bridge, () => {
        loadMainTvState().then(s => { currentState = s; _renderBar(s); }).catch(() => {});
      });
    });
  }

  _renderBar(currentState);

  // Insert the bar in the video wrap
  const videoWrap = overlay.querySelector('.crl-video-wrap');
  if (videoWrap) videoWrap.appendChild(bar);

  // Subscribe to state changes to update the bar in real time
  const unsub = subscribeMainTvState(state => {
    currentState = state;
    _renderBar(state);
  });

  // Clean up subscription when the overlay is torn down
  const origHide = _hideOverlay;
  overlay._founderStateUnsub = unsub;
}

async function _showFeatureConfirmModal(user, channel, liveId, currentState, bridge, onDone) {
  const { featureCreatorOnMainTv, loadLiveSession: _lls } = bridge;

  // Check creator opt-out
  try {
    const { loadCreatorChannel } = await import('./snx-creator-channels.js');
    const ch = await loadCreatorChannel(channel.ownerUid || channel.id || '');
    if (ch && ch.allowMainTvFeature === false) {
      _toast('⚠ This creator has opted out of Main TV featuring.', 'error');
      return;
    }
  } catch (_) {}

  const isSwitch = currentState?.mode === 'featured_live'
    && currentState?.featuredLiveId !== liveId;
  const currentName = isSwitch ? (currentState?.featuredChannelName || 'Another creator') : null;

  const modal = document.createElement('div');
  modal.className = 'snx-tn-modal-overlay';
  modal.style.zIndex = '9999';
  modal.innerHTML = `
    <div class="snx-tn-modal-box">
      <div class="snx-tn-modal-title">📺 FEATURE ON MAIN TV</div>
      ${isSwitch ? `
        <div class="snx-tn-modal-sub" style="color:#f0a500;">
          <strong>${_esc(currentName)}</strong> is currently featured.<br>
          Switch to <strong>${_esc(channel.channelName || 'this creator')}</strong>?
        </div>
      ` : `
        <div class="snx-tn-modal-sub">
          Feature <strong>${_esc(channel.channelName || 'this creator')}</strong>'s live on Shadow Nexus Main TV?
        </div>
      `}
      <div style="font-size:11px;color:#5a80a8;margin:8px 0 14px;line-height:1.6;">
        Their original channel will stay live and unaffected.
        Main TV will carry this stream simultaneously.
      </div>
      <div id="snx-feat-modal-err" style="color:#ff3344;font-size:12px;min-height:18px;"></div>
      <div class="snx-tn-modal-actions">
        <button class="snx-tn-btn-ghost" id="snx-feat-cancel">CANCEL</button>
        <button class="snx-tn-btn-primary" id="snx-feat-confirm" style="background:rgba(255,45,85,0.92);border:none;">
          ${isSwitch ? '↔ SWITCH LIVE' : '📺 FEATURE LIVE'}
        </button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#snx-feat-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#snx-feat-confirm').addEventListener('click', async () => {
    const errEl = modal.querySelector('#snx-feat-modal-err');
    const btn   = modal.querySelector('#snx-feat-confirm');
    btn.disabled = true; btn.textContent = 'Featuring…';

    try {
      // Load current live session for title
      const { loadLiveSession } = await import('./snx-creator-channels.js');
      const session = await loadLiveSession(liveId);
      await featureCreatorOnMainTv(user, liveId, channel, session);
      modal.remove();
      _toast('📺 Now featuring on Main TV!');
      onDone?.();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Feature failed.';
      btn.disabled = false;
      btn.textContent = isSwitch ? '↔ SWITCH LIVE' : '📺 FEATURE LIVE';
    }
  });
}

async function _showRemoveFeatureModal(user, bridge, onDone) {
  const { removeCreatorFromMainTv } = bridge;
  const modal = document.createElement('div');
  modal.className = 'snx-tn-modal-overlay';
  modal.style.zIndex = '9999';
  modal.innerHTML = `
    <div class="snx-tn-modal-box">
      <div class="snx-tn-modal-title">📺 RETURN TO SCHEDULE</div>
      <div class="snx-tn-modal-sub">Return Main TV to scheduled programming?</div>
      <div id="snx-rmfeat-err" style="color:#ff3344;font-size:12px;min-height:18px;"></div>
      <div class="snx-tn-modal-actions">
        <button class="snx-tn-btn-ghost" id="snx-rmfeat-cancel">CANCEL</button>
        <button class="snx-tn-btn-primary" id="snx-rmfeat-confirm">↩ RETURN</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector('#snx-rmfeat-cancel').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  modal.querySelector('#snx-rmfeat-confirm').addEventListener('click', async () => {
    const errEl = modal.querySelector('#snx-rmfeat-err');
    const btn   = modal.querySelector('#snx-rmfeat-confirm');
    btn.disabled = true; btn.textContent = 'Returning…';
    try {
      await removeCreatorFromMainTv(user);
      modal.remove();
      _toast('↩ Main TV returned to scheduled programming.');
      onDone?.();
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Return failed.';
      btn.disabled = false; btn.textContent = '↩ RETURN';
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   SHARED HTML BUILDER
══════════════════════════════════════════════════════════════ */
function _buildLiveStageHTML(isHost, channel, roomData) {
  const avatarLetter = (channel?.channelName || '?')[0].toUpperCase();
  const channelName  = _esc(channel?.channelName || 'Creator');
  const isOwnChannel = isHost; // viewer is never the owner in this context

  return `
    <div class="crl-stage">
      <!-- Video -->
      <div class="crl-video-wrap">
        <video id="crl-live-video" autoplay playsinline ${isHost ? 'muted' : ''}
               style="width:100%;height:100%;object-fit:cover;background:#000;display:block;"></video>

        <!-- Cam-off overlay (host only) -->
        ${isHost ? '<div class="crl-cam-off-overlay"><div style="font-size:40px;">📷</div></div>' : ''}

        <!-- Connection banner -->
        <div class="crl-conn-banner" id="crl-conn-banner">
          <div class="crl-conn-spinner"></div>
          <div class="crl-conn-title" id="crl-conn-title">Connecting…</div>
          <div class="crl-conn-sub"   id="crl-conn-sub"></div>
        </div>

        <!-- Unmute prompt (viewer) -->
        ${!isHost ? '<div class="crl-unmute-prompt" style="display:none;">🔊 Tap to unmute</div>' : ''}

        <!-- Top bar -->
        <div class="crl-top-bar">
          <div class="crl-live-badge"><span class="crl-live-badge-dot"></span> LIVE</div>
          <div class="crl-creator-pill">
            <div class="crl-creator-avatar" id="crl-creator-avatar">${avatarLetter}</div>
            <div>
              <div class="crl-creator-name" id="crl-creator-name">${channelName}</div>
              <div class="crl-live-title"   id="crl-live-title"></div>
            </div>
          </div>
          ${!isHost ? `
            <button class="crl-follow-btn" id="crl-follow-btn"
                    style="${!channel?.ownerUid ? 'display:none;' : ''}">+ Follow</button>
          ` : ''}
          <div class="crl-viewer-count" id="crl-viewer-count">👁 0</div>
          ${isHost ? `
            <div class="crl-timer" id="crl-timer">
              <span class="crl-timer-dot" aria-hidden="true"></span>
              <span id="crl-timer-text">00:00:00</span>
            </div>
          ` : `
            <div id="crl-viewer-duration" aria-live="off" aria-label="Live duration"></div>
          `}
          <button class="crl-close-btn" aria-label="${isHost ? 'End stream' : 'Leave stream'}">✕</button>
        </div>

        <!-- Chat panel -->
        <div class="crl-chat-panel">
          <div class="crl-chat-messages" id="crl-chat-messages"></div>
          <div class="crl-chat-input-row">
            <input class="crl-chat-input" id="crl-chat-input"
                   type="text" placeholder="Say something…"
                   maxlength="200" autocomplete="off" autocorrect="off">
            <button class="crl-chat-send" id="crl-chat-send">➤</button>
          </div>
        </div>

        <!-- Viewer actions (viewer only) -->
        ${!isHost ? `
          <div class="crl-viewer-actions">
            <button class="crl-action-btn" id="crl-like-btn">
              <span>❤️</span><span>Like</span>
            </button>
            <button class="crl-action-btn" id="crl-share-btn">
              <span>📤</span><span>Share</span>
            </button>
          </div>
        ` : ''}

        <!-- Host bottom bar (host only) -->
        ${isHost ? `
          <div class="crl-bottom-bar">
            <button class="crl-host-btn" id="crl-host-cam-btn"  title="Camera">📷</button>
            <button class="crl-host-btn" id="crl-host-mic-btn"  title="Mic">🎤</button>
            <button class="crl-host-btn" id="crl-host-flip-btn" title="Flip">🔄</button>
            <button class="crl-end-live-btn" id="crl-end-live-btn">■ END LIVE</button>
          </div>
        ` : ''}

        <!-- Ended overlay -->
        <div class="crl-ended-overlay" id="crl-ended-overlay">
          <div class="crl-ended-icon">🌑</div>
          <div class="crl-ended-title" id="crl-ended-title">Stream Ended</div>
          <div class="crl-ended-sub"   id="crl-ended-sub">This live stream has ended.</div>
          <button class="crl-btn-cancel" id="crl-ended-back-btn" style="margin-top:8px;">← Back</button>
        </div>

        <!-- End confirm dialog (host only) -->
        ${isHost ? `
          <div class="crl-confirm-overlay" id="crl-confirm-overlay">
            <div class="crl-confirm-box">
              <div class="crl-confirm-title">End your live broadcast?</div>
              <div class="crl-confirm-sub">This will end the stream and return your channel to OFF AIR.</div>
              <div class="crl-confirm-actions">
                <button class="crl-btn-cancel" id="crl-confirm-cancel-btn">CANCEL</button>
                <button class="crl-end-live-btn" id="crl-confirm-end-btn">END LIVE</button>
              </div>
            </div>
          </div>
        ` : ''}

      </div><!-- .crl-video-wrap -->
    </div><!-- .crl-stage -->
  `;
}

/* ══════════════════════════════════════════════════════════════
   UI HELPERS
══════════════════════════════════════════════════════════════ */
function _showConnBanner(overlay, title, sub) {
  const b = overlay.querySelector('#crl-conn-banner');
  if (!b) return;
  b.classList.add('visible');
  const t = b.querySelector('#crl-conn-title');
  const s = b.querySelector('#crl-conn-sub');
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
}
function _hideConnBanner(overlay) {
  const b = overlay?.querySelector('#crl-conn-banner') ||
            document.querySelector('#snx-crl-overlay #crl-conn-banner');
  if (b) b.classList.remove('visible');
}

function _showEndedOverlay(overlay, title, sub, isHost) {
  const el = overlay.querySelector('#crl-ended-overlay');
  if (!el) return;
  el.classList.add('visible');
  const t = el.querySelector('#crl-ended-title');
  const s = el.querySelector('#crl-ended-sub');
  if (t) t.textContent = title;
  if (s) s.textContent = sub;
  el.querySelector('#crl-ended-back-btn')?.addEventListener('click', () => {
    _hideOverlay();
  });
}

/**
 * Show the off-air screen when a viewer is watching and the creator ends live.
 * Does NOT immediately close the overlay — gives viewer time to react.
 * @param {HTMLElement} overlay
 * @param {string} channelName
 * @param {boolean} wasLive  — true: broadcast ended; false: not found
 * @param {string} [ownerUid]  — creator UID for View Channel navigation
 */
function _showOffAirScreen(overlay, channelName, wasLive, ownerUid) {
  // Remove any existing off-air screen to avoid duplicates
  overlay.querySelector('.crl-off-air-screen')?.remove();

  const el = document.createElement('div');
  el.className = 'crl-off-air-screen visible';
  el.innerHTML = `
    <div class="crl-off-air-icon" aria-hidden="true">⚫</div>
    <div class="crl-off-air-label">OFF AIR</div>
    <div class="crl-off-air-title">${wasLive ? 'This broadcast has ended.' : 'This broadcast is not available.'}</div>
    <div style="font-size:13px;color:#5a80a8;max-width:260px;line-height:1.6;">
      ${wasLive ? `<strong style="color:#c8d0e8;">${_esc(channelName)}</strong> has ended their live.` : ''}
    </div>
    <div class="crl-off-air-actions">
      <button class="crl-off-air-view-channel" id="crl-off-air-view-channel"
              aria-label="View ${_esc(channelName)}'s channel">View Channel</button>
      <button class="crl-btn-cancel" id="crl-off-air-back">← Back to Live Now</button>
    </div>`;

  const videoWrap = overlay.querySelector('.crl-video-wrap') || overlay;
  videoWrap.appendChild(el);

  // "Back to Live Now" — close overlay and switch to live-now tab
  el.querySelector('#crl-off-air-back')?.addEventListener('click', () => {
    _hideOverlay();
    window.dispatchEvent(new CustomEvent('snx:switchTvTab', { detail: { tab: 'live-now' } }));
  });

  // "View Channel" — navigate to the creator's channel page
  el.querySelector('#crl-off-air-view-channel')?.addEventListener('click', () => {
    _hideOverlay();
    if (ownerUid) {
      // Use the canonical event the TV network already listens for
      window.dispatchEvent(new CustomEvent('snx:openCreatorChannel', { detail: { uid: ownerUid } }));
    } else {
      // Fallback: switch to channels tab
      window.dispatchEvent(new CustomEvent('snx:switchTvTab', { detail: { tab: 'channels' } }));
    }
  });
}

function _appendChatMsg(container, data, callerUid) {
  if (!container) return;
  const isHost = !!(data.userId && data.userId === callerUid);
  const el = document.createElement('div');
  el.className = 'crl-chat-msg';
  const author = document.createElement('span');
  author.className = 'crl-chat-author' + (isHost ? ' is-host' : '');
  author.textContent = data.userName || 'Guest';
  const text = document.createElement('span');
  text.className = 'crl-chat-text';
  text.textContent = data.text || '';
  el.appendChild(author);
  el.appendChild(text);
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  container.appendChild(el);
  while (container.children.length > 70) container.removeChild(container.firstChild);
  if (atBottom) container.scrollTop = container.scrollHeight;
}

function _toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.textContent = msg;
  const color = type === 'error' ? '#ff3344' : type === 'live' ? '#ff2244' : '#00AEEF';
  el.style.cssText = `
    position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
    background:rgba(5,9,26,0.92);color:${color};
    border:1px solid rgba(0,174,239,0.3);
    border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;
    letter-spacing:0.5px;z-index:9999;white-space:nowrap;
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function _fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════════════════
   REPLAY PLAYER
   Opens a full-screen replay viewer for a published Live Replay.
   Clearly labelled LIVE REPLAY — never shows 🔴 LIVE.
   Called from snx-tv-network.js when a user taps a replay card.

   @param {object} user         — Firebase Auth user (may be null)
   @param {object} userData     — SNS user profile data
   @param {string} creatorUid   — replay owner UID
   @param {string} replayId     — replay document ID
   @param {boolean} isOwner     — true if viewer is the replay creator
══════════════════════════════════════════════════════════════ */
export async function openReplayPlayer(user, userData, creatorUid, replayId, isOwner = false) {
  const overlay = _getOrCreateOverlay();

  // Load replay record
  let replay = null;
  try {
    replay = await loadReplay(creatorUid, replayId);
  } catch (_) {}

  if (!replay) {
    overlay.innerHTML = `
      <div class="crl-rp-screen">
        <div class="crl-rp-header">
          <button class="crl-close-btn" id="crl-rp-close">✕</button>
        </div>
        <div class="crl-rp-empty">Replay not found.</div>
      </div>`;
    overlay.querySelector('#crl-rp-close')?.addEventListener('click', () => _hideOverlay());
    return;
  }

  // Visibility enforcement — if followers-only, check follow status
  if (replay.visibility === 'followers' && !isOwner && user) {
    try {
      const follows = await isFollowingChannel(creatorUid, user.uid);
      if (!follows) {
        overlay.innerHTML = `
          <div class="crl-rp-screen">
            <div class="crl-rp-header"><button class="crl-close-btn" id="crl-rp-close">✕</button></div>
            <div class="crl-rp-empty">🔒 This replay is for followers only.<br>Follow the creator to watch.</div>
          </div>`;
        overlay.querySelector('#crl-rp-close')?.addEventListener('click', () => _hideOverlay());
        return;
      }
    } catch (_) {}
  }
  if (replay.visibility === 'private' && !isOwner) {
    overlay.innerHTML = `
      <div class="crl-rp-screen">
        <div class="crl-rp-header"><button class="crl-close-btn" id="crl-rp-close">✕</button></div>
        <div class="crl-rp-empty">🔒 This replay is private.</div>
      </div>`;
    overlay.querySelector('#crl-rp-close')?.addEventListener('click', () => _hideOverlay());
    return;
  }

  const createdDate  = replay.createdAt?.toDate ? replay.createdAt.toDate().toLocaleDateString() : '';
  const durationFmt  = replay.duration ? _fmtDuration(replay.duration) : '';
  const replayViews  = replay.replayViews || 0;
  const likeCount    = replay.likeCount || 0;
  const commentCount = replay.commentCount || 0;

  overlay.innerHTML = `
    <div class="crl-rp-screen">

      <!-- Header bar -->
      <div class="crl-rp-header">
        <div class="crl-rp-replay-badge">▶ LIVE REPLAY</div>
        <button class="crl-close-btn" id="crl-rp-close" aria-label="Close replay">✕</button>
      </div>

      <!-- Video area -->
      <div class="crl-rp-video-wrap">
        ${replay.recordingUrl
          ? `<video id="crl-rp-video" src="${_esc(replay.recordingUrl)}" controls playsinline
                   style="width:100%;height:100%;object-fit:contain;background:#000;display:block;"></video>`
          : `<div class="crl-rp-no-video">
               <div class="crl-rp-no-video-icon">▶</div>
               <div class="crl-rp-no-video-title">Video Not Yet Available</div>
               <div class="crl-rp-no-video-sub">Recording is being processed or not yet uploaded.</div>
             </div>`}
      </div>

      <!-- Info panel -->
      <div class="crl-rp-info" id="crl-rp-info">
        <div class="crl-rp-title" id="crl-rp-title">${_esc(replay.title || 'Live Replay')}</div>
        <div class="crl-rp-meta">
          ${createdDate ? `<span>${_esc(createdDate)}</span>` : ''}
          ${durationFmt ? `<span>${_esc(durationFmt)}</span>` : ''}
          <span id="crl-rp-views">${replayViews.toLocaleString()} views</span>
        </div>

        <!-- Like + Share row -->
        <div class="crl-rp-actions-row">
          <button class="crl-rp-action-btn" id="crl-rp-like-btn">
            <span id="crl-rp-like-icon">❤️</span>
            <span id="crl-rp-like-count">${likeCount.toLocaleString()}</span>
          </button>
          <button class="crl-rp-action-btn" id="crl-rp-share-btn">
            <span>📤</span><span>Share</span>
          </button>
          ${isOwner ? `
          <button class="crl-rp-action-btn crl-rp-manage-btn" id="crl-rp-manage-btn">
            <span>⚙</span><span>Manage</span>
          </button>` : ''}
        </div>

        <!-- Stats row: peak viewers vs replay views -->
        <div class="crl-rp-stats-row">
          ${replay.livePeakViewers ? `<div class="crl-rp-stat"><span class="crl-rp-stat-label">Live Peak Viewers</span><span class="crl-rp-stat-value">${replay.livePeakViewers.toLocaleString()}</span></div>` : ''}
          <div class="crl-rp-stat"><span class="crl-rp-stat-label">Replay Views</span><span class="crl-rp-stat-value" id="crl-rp-stat-views">${replayViews.toLocaleString()}</span></div>
          ${likeCount ? `<div class="crl-rp-stat"><span class="crl-rp-stat-label">Likes</span><span class="crl-rp-stat-value">${likeCount.toLocaleString()}</span></div>` : ''}
        </div>

        <!-- Comments -->
        <div class="crl-rp-comments-section">
          <div class="crl-rp-comments-title">Comments <span id="crl-rp-comment-count">(${commentCount})</span></div>
          <div class="crl-rp-comments-list" id="crl-rp-comments-list">
            <div class="crl-rp-loading">Loading comments…</div>
          </div>
          ${user ? `
          <div class="crl-rp-comment-input-row">
            <input class="crl-rp-comment-input" id="crl-rp-comment-input"
                   type="text" placeholder="Add a comment…" maxlength="300" autocomplete="off">
            <button class="crl-rp-comment-send" id="crl-rp-comment-send">➤</button>
          </div>` : '<div class="crl-rp-sign-in-note">Sign in to comment and like.</div>'}
        </div>

      </div><!-- .crl-rp-info -->

      <!-- Owner manage panel (hidden by default) -->
      ${isOwner ? `
      <div class="crl-rp-manage-panel" id="crl-rp-manage-panel" style="display:none;">
        <div class="crl-rp-manage-title">MANAGE REPLAY</div>
        <div class="crl-rp-manage-actions">
          <button class="crl-rp-manage-action" id="crl-rp-edit-btn">✏️ Edit Details</button>
          <button class="crl-rp-manage-action" id="crl-rp-vis-btn">🔒 Change Visibility</button>
          <button class="crl-rp-manage-action crl-rp-manage-delete" id="crl-rp-delete-btn">🗑 Delete Replay</button>
        </div>
        <button class="crl-btn-cancel" id="crl-rp-manage-close" style="margin-top:12px;width:100%;">Close</button>
      </div>` : ''}

    </div>
  `;

  // ── Close ──
  overlay.querySelector('#crl-rp-close')?.addEventListener('click', () => {
    if (overlay._crlRpCommentUnsub) { try { overlay._crlRpCommentUnsub(); } catch (_) {} }
    if (overlay._crlRpReplayUnsub)  { try { overlay._crlRpReplayUnsub(); } catch (_) {} }
    _hideOverlay();
  });

  // ── Increment view count (once per open) ──
  incrementReplayViews(creatorUid, replayId).catch(() => {});

  // ── Subscribe to replay for live like/comment count updates ──
  overlay._crlRpReplayUnsub = subscribeReplay(creatorUid, replayId, updated => {
    if (!updated) return;
    const likeEl    = overlay.querySelector('#crl-rp-like-count');
    const viewsEl   = overlay.querySelector('#crl-rp-views');
    const statViews = overlay.querySelector('#crl-rp-stat-views');
    const cmtEl     = overlay.querySelector('#crl-rp-comment-count');
    if (likeEl)    likeEl.textContent    = (updated.likeCount || 0).toLocaleString();
    if (viewsEl)   viewsEl.textContent   = `${(updated.replayViews || 0).toLocaleString()} views`;
    if (statViews) statViews.textContent = (updated.replayViews || 0).toLocaleString();
    if (cmtEl)     cmtEl.textContent     = `(${updated.commentCount || 0})`;
  });

  // ── Like button ──
  if (user) {
    let liked = false;
    hasLikedReplay(user.uid, replayId).then(has => {
      liked = has;
      const likeBtn = overlay.querySelector('#crl-rp-like-btn');
      if (likeBtn) likeBtn.classList.toggle('crl-rp-liked', liked);
      const icon = overlay.querySelector('#crl-rp-like-icon');
      if (icon) icon.textContent = liked ? '❤️' : '🤍';
    }).catch(() => {});

    overlay.querySelector('#crl-rp-like-btn')?.addEventListener('click', async () => {
      const likeBtn = overlay.querySelector('#crl-rp-like-btn');
      if (likeBtn) likeBtn.disabled = true;
      try {
        if (liked) {
          await unlikeReplay(user.uid, creatorUid, replayId);
          liked = false;
        } else {
          await likeReplay(user.uid, creatorUid, replayId);
          liked = true;
        }
        const icon = overlay.querySelector('#crl-rp-like-icon');
        if (icon) icon.textContent = liked ? '❤️' : '🤍';
        if (likeBtn) likeBtn.classList.toggle('crl-rp-liked', liked);
      } catch (_) {}
      if (likeBtn) likeBtn.disabled = false;
    });
  }

  // ── Share ──
  overlay.querySelector('#crl-rp-share-btn')?.addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?replay=${creatorUid}&replayId=${replayId}`;
    if (navigator.share) {
      navigator.share({ title: replay.title || 'Live Replay', url }).catch(() => {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => _toast('Link copied!')).catch(() => {});
    }
  });

  // ── Comments ──
  const commentsList = overlay.querySelector('#crl-rp-comments-list');
  overlay._crlRpCommentUnsub = subscribeReplayComments(creatorUid, replayId, comments => {
    if (!commentsList) return;
    if (!comments.length) {
      commentsList.innerHTML = '<div class="crl-rp-empty-comments">No comments yet. Be the first!</div>';
      return;
    }
    commentsList.innerHTML = comments.map(c => {
      const ts = c.createdAt?.toDate ? c.createdAt.toDate().toLocaleDateString() : '';
      const canDelete = user && (user.uid === c.authorUid || user.uid === creatorUid);
      return `
        <div class="crl-rp-comment" data-comment-id="${_esc(c.id)}">
          <div class="crl-rp-comment-author">${_esc(c.authorName || 'User')}</div>
          <div class="crl-rp-comment-text">${_esc(c.text)}</div>
          <div class="crl-rp-comment-meta">
            ${ts ? `<span>${ts}</span>` : ''}
            ${canDelete ? `<button class="crl-rp-comment-del" data-id="${_esc(c.id)}">🗑</button>` : ''}
          </div>
        </div>`;
    }).join('');

    // Wire delete buttons
    commentsList.querySelectorAll('.crl-rp-comment-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await deleteReplayComment(creatorUid, replayId, btn.dataset.id); }
        catch (_) { btn.disabled = false; }
      });
    });
  });

  // ── Comment submit ──
  if (user) {
    const commentInput = overlay.querySelector('#crl-rp-comment-input');
    const commentSend  = overlay.querySelector('#crl-rp-comment-send');
    let sending = false;

    async function _submitComment() {
      if (sending) return;
      const text = commentInput?.value?.trim();
      if (!text) return;
      sending = true;
      if (commentInput) commentInput.value = '';
      try {
        await addReplayComment(creatorUid, replayId, {
          uid:         user.uid,
          displayName: userData?.displayName || user.email?.split('@')[0] || 'User',
          avatar:      userData?.profileImage || null,
        }, text);
      } catch (_) {}
      sending = false;
      commentInput?.focus();
    }

    commentSend?.addEventListener('click', _submitComment);
    commentInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _submitComment(); }
    });
  }

  // ── Owner manage panel ──
  if (isOwner) {
    const manageBtn   = overlay.querySelector('#crl-rp-manage-btn');
    const managePanel = overlay.querySelector('#crl-rp-manage-panel');
    const manageClose = overlay.querySelector('#crl-rp-manage-close');

    manageBtn?.addEventListener('click', () => {
      if (managePanel) managePanel.style.display = managePanel.style.display === 'none' ? '' : 'none';
    });
    manageClose?.addEventListener('click', () => {
      if (managePanel) managePanel.style.display = 'none';
    });

    // Edit details
    overlay.querySelector('#crl-rp-edit-btn')?.addEventListener('click', () => {
      _showReplayEditModal(creatorUid, replayId, replay, overlay);
    });

    // Change visibility
    overlay.querySelector('#crl-rp-vis-btn')?.addEventListener('click', () => {
      _showReplayVisibilityModal(creatorUid, replayId, replay.visibility || 'private', overlay);
    });

    // Delete
    overlay.querySelector('#crl-rp-delete-btn')?.addEventListener('click', () => {
      _showReplayDeleteModal(creatorUid, replayId, overlay);
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   REPLAY PLAYER — OWNER MODALS
══════════════════════════════════════════════════════════════ */

function _showReplayEditModal(creatorUid, replayId, replay, overlay) {
  const existing = document.getElementById('crl-rp-edit-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'crl-rp-edit-modal';
  modal.className = 'crl-rp-modal-overlay';
  modal.innerHTML = `
    <div class="crl-rp-modal-box">
      <div class="crl-rp-modal-title">✏️ EDIT REPLAY</div>
      <div class="crl-end-replay-title-field">
        <label class="crl-end-replay-label">Title</label>
        <input class="crl-end-replay-input" id="crl-rp-edit-title" maxlength="80"
               value="${_esc(replay.title || '')}">
      </div>
      <div class="crl-end-replay-title-field">
        <label class="crl-end-replay-label">Description</label>
        <textarea class="crl-end-replay-input" id="crl-rp-edit-desc" rows="2" maxlength="300">${_esc(replay.description || '')}</textarea>
      </div>
      <div class="crl-end-replay-title-field">
        <label class="crl-end-replay-label">Thumbnail URL</label>
        <input class="crl-end-replay-input" id="crl-rp-edit-thumb" type="url"
               placeholder="https://…" value="${_esc(replay.thumbnail || '')}">
      </div>
      <div id="crl-rp-edit-err" style="color:var(--crl-red);font-size:12px;min-height:18px;"></div>
      <div class="crl-publish-actions">
        <button class="crl-btn-cancel" id="crl-rp-edit-cancel">CANCEL</button>
        <button class="crl-replay-btn crl-replay-btn-post" id="crl-rp-edit-save" style="flex:1;">
          <span class="crl-replay-btn-label" style="font-size:13px;">SAVE</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('crl-rp-edit-cancel')?.addEventListener('click', () => modal.remove());
  document.getElementById('crl-rp-edit-save')?.addEventListener('click', async () => {
    const errEl = document.getElementById('crl-rp-edit-err');
    const title = document.getElementById('crl-rp-edit-title')?.value.trim();
    const desc  = document.getElementById('crl-rp-edit-desc')?.value.trim();
    const thumb = document.getElementById('crl-rp-edit-thumb')?.value.trim();
    const btn = document.getElementById('crl-rp-edit-save');
    btn.disabled = true; btn.querySelector('.crl-replay-btn-label').textContent = 'Saving…';
    try {
      await updateReplayDetails(creatorUid, replayId, { title, description: desc, thumbnail: thumb || null });
      // Update display in player
      const titleEl = overlay.querySelector('#crl-rp-title');
      if (titleEl && title) titleEl.textContent = title;
      modal.remove();
      _toast('Replay updated!');
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Save failed.';
      btn.disabled = false; btn.querySelector('.crl-replay-btn-label').textContent = 'SAVE';
    }
  });
}

function _showReplayVisibilityModal(creatorUid, replayId, currentVis, overlay) {
  const existing = document.getElementById('crl-rp-vis-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'crl-rp-vis-modal';
  modal.className = 'crl-rp-modal-overlay';
  modal.innerHTML = `
    <div class="crl-rp-modal-box">
      <div class="crl-rp-modal-title">🔒 CHANGE VISIBILITY</div>
      <div class="crl-vis-options">
        <label class="crl-vis-opt">
          <input type="radio" name="crl-rp-vis" value="public" ${currentVis === 'public' ? 'checked' : ''}>
          <span class="crl-vis-opt-label">🌐 PUBLIC</span>
          <span class="crl-vis-opt-desc">Anyone can watch</span>
        </label>
        <label class="crl-vis-opt">
          <input type="radio" name="crl-rp-vis" value="followers" ${currentVis === 'followers' ? 'checked' : ''}>
          <span class="crl-vis-opt-label">👥 FOLLOWERS ONLY</span>
        </label>
        <label class="crl-vis-opt">
          <input type="radio" name="crl-rp-vis" value="private" ${currentVis === 'private' ? 'checked' : ''}>
          <span class="crl-vis-opt-label">🔒 PRIVATE</span>
          <span class="crl-vis-opt-desc">Only you can see this</span>
        </label>
      </div>
      <div id="crl-rp-vis-err" style="color:var(--crl-red);font-size:12px;min-height:18px;"></div>
      <div class="crl-publish-actions">
        <button class="crl-btn-cancel" id="crl-rp-vis-cancel">CANCEL</button>
        <button class="crl-replay-btn crl-replay-btn-post" id="crl-rp-vis-save" style="flex:1;">
          <span class="crl-replay-btn-label" style="font-size:13px;">SAVE</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('crl-rp-vis-cancel')?.addEventListener('click', () => modal.remove());
  document.getElementById('crl-rp-vis-save')?.addEventListener('click', async () => {
    const errEl = document.getElementById('crl-rp-vis-err');
    const vis = modal.querySelector('input[name="crl-rp-vis"]:checked')?.value;
    if (!vis) return;
    const btn = document.getElementById('crl-rp-vis-save');
    btn.disabled = true; btn.querySelector('.crl-replay-btn-label').textContent = 'Saving…';
    try {
      await updateReplayDetails(creatorUid, replayId, { visibility: vis });
      modal.remove();
      _toast('Visibility updated.');
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Save failed.';
      btn.disabled = false; btn.querySelector('.crl-replay-btn-label').textContent = 'SAVE';
    }
  });
}

function _showReplayDeleteModal(creatorUid, replayId, overlay) {
  const existing = document.getElementById('crl-rp-del-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'crl-rp-del-modal';
  modal.className = 'crl-rp-modal-overlay';
  modal.innerHTML = `
    <div class="crl-rp-modal-box">
      <div class="crl-rp-modal-title" style="color:var(--crl-red);">🗑 DELETE REPLAY</div>
      <div class="crl-delete-confirm-text">Delete this replay?<br><strong>This cannot be undone.</strong></div>
      <div id="crl-rp-del-err" style="color:var(--crl-red);font-size:12px;min-height:18px;"></div>
      <div class="crl-publish-actions">
        <button class="crl-btn-cancel" id="crl-rp-del-cancel">CANCEL</button>
        <button class="crl-replay-btn crl-replay-btn-delete" id="crl-rp-del-confirm" style="flex:1;">
          <span class="crl-replay-btn-label" style="font-size:13px;">DELETE</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  document.getElementById('crl-rp-del-cancel')?.addEventListener('click', () => modal.remove());
  document.getElementById('crl-rp-del-confirm')?.addEventListener('click', async () => {
    const errEl = document.getElementById('crl-rp-del-err');
    const btn = document.getElementById('crl-rp-del-confirm');
    btn.disabled = true; btn.querySelector('.crl-replay-btn-label').textContent = 'Deleting…';
    try {
      const { deleteReplay: dr } = await import('./snx-creator-channels.js');
      await dr(creatorUid, replayId);
      modal.remove();
      if (overlay._crlRpCommentUnsub) { try { overlay._crlRpCommentUnsub(); } catch (_) {} }
      if (overlay._crlRpReplayUnsub)  { try { overlay._crlRpReplayUnsub(); } catch (_) {} }
      _hideOverlay();
      _toast('Replay deleted.');
    } catch (err) {
      if (errEl) errEl.textContent = err.message || 'Delete failed.';
      btn.disabled = false; btn.querySelector('.crl-replay-btn-label').textContent = 'DELETE';
    }
  });
}
