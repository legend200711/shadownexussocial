/**
 * Shadow Nexus Social — Live System
 * live.js  (SNS-2026-LIVE-001)
 *
 * ONE canonical Live engine for Shadow Nexus Social.
 * ES module — loaded as <script type="module"> in index.html.
 *
 * Firebase paths (RTDB):
 *   liveRooms/{roomId}                   — room metadata
 *   liveSignaling/{roomId}/{viewerId}    — WebRTC signaling
 *   livePresence/{roomId}/{viewerId}     — viewer presence
 *   liveChats/{roomId}/{msgId}           — chat messages
 *
 * No external broadcaster required. No OBS. No RTMP.
 * No old live.js / Avenora / Wave dependencies.
 */

import {
  ref, set, get, update, remove, push,
  onValue, off, onDisconnect, query, limitToLast,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ══════════════════════════════════════════════════════════
   ICE CONFIGURATION
   Centralised — add TURN credentials here when available.
   DO NOT embed TURN secrets directly in source.
══════════════════════════════════════════════════════════ */
const _ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

/* ══════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════ */
function _log(msg)   { console.log('[SNX-LIVE] ' + msg); }
function _err(stage, service, op, code, msg) {
  console.error('[SNX-LIVE] ERROR | stage=' + stage + ' svc=' + service + ' op=' + op + ' code=' + code + ' | ' + msg);
}
function _uid()      { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function _esc(s)     {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _el(id)     { return document.getElementById(id); }
function _db()       { return window._snxLiveDB || null; }
function _user()     {
  const a = window._snxAuth;
  return (a && a.currentUser) ? a.currentUser : (window._snxCurrentUser || null);
}
function _userData() { return window._snxUserData || {}; }

/* ══════════════════════════════════════════════════════════
   MODULE STATE
══════════════════════════════════════════════════════════ */
const _S = {
  /* host */
  hostRoomId:    null,
  hostStream:    null,
  hostCamOn:     true,
  hostMicOn:     true,
  hostPeers:     {},     // viewerId → RTCPeerConnection
  hostSigRef:    null,   // RTDB ref being listened on
  hostHbTimer:   null,
  hostCountTimer:null,
  hostStartedAt: null,
  hostEnded:     false,
  /* viewer */
  viewRoomId:    null,
  viewSessId:    null,
  viewPc:        null,
  viewPresRef:   null,
  viewUnsubs:    [],     // cleanup fns
  /* hub */
  hubRef:        null,
  hubCb:         null,
};

/* ══════════════════════════════════════════════════════════
   PUBLIC API — registered on window
══════════════════════════════════════════════════════════ */

window.goLiveOrWatch = function() { window.snxLiveOpenGoLive(); };

window.snxLiveOpenGoLive = function() {
  const user = _user();
  if (!user) {
    if (typeof toastNotification === 'function') toastNotification('⛔ Log in to go live.');
    return;
  }
  _openSetupScreen();
};

window.snxLiveOpenViewer = function(roomId) {
  if (!roomId) return;
  const user = _user();
  if (!user) {
    if (typeof toastNotification === 'function') toastNotification('⛔ Log in to watch live.');
    return;
  }
  _openViewerScreen(roomId);
};

window.snxLivePageOpen = function() {
  _log('livePage opened');
  _renderHub();
};

/* ══════════════════════════════════════════════════════════
   OVERLAY
══════════════════════════════════════════════════════════ */
function _getOverlay() {
  let ov = _el('snxLiveOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'snxLiveOverlay';
    document.body.appendChild(ov);
  }
  return ov;
}
function _showOverlay(html) {
  const ov = _getOverlay();
  ov.innerHTML = html;
  ov.classList.add('is-open');
  return ov;
}
function _closeOverlay() {
  const ov = _el('snxLiveOverlay');
  if (ov) { ov.classList.remove('is-open'); ov.innerHTML = ''; }
}

/* ══════════════════════════════════════════════════════════
   STAGE 1 — SETUP / GO LIVE SCREEN
══════════════════════════════════════════════════════════ */
function _openSetupScreen() {
  _log('Opening Go Live setup');
  _showOverlay(_buildSetupHTML());

  const previewVideo = _el('snxLivePreviewVideo');
  const previewOff   = _el('snxLivePreviewOff');
  const camBtn       = _el('snxLiveCamBtn');
  const micBtn       = _el('snxLiveMicBtn');
  const flipBtn      = _el('snxLiveFlipBtn');
  const startBtn     = _el('snxLiveStartBtn');
  const titleInput   = _el('snxLiveTitleInput');
  const errEl        = _el('snxLiveSetupErr');

  let localStream = null;
  let camOn       = true;
  let micOn       = true;
  let facingMode  = 'user';

  function _showErr(msg) { if (errEl) errEl.textContent = msg; }
  function _clearErr()   { if (errEl) errEl.textContent = ''; }

  async function _acquireStream(facing) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (_) {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    }
  }

  async function _startPreview(facing) {
    _clearErr();
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    try {
      localStream = await _acquireStream(facing);
      if (previewVideo) { previewVideo.srcObject = localStream; previewVideo.play().catch(() => {}); }
      if (previewOff)   previewOff.classList.remove('show');
      _log('Media ready');
    } catch (e) {
      _err('setup','getUserMedia','start', e.name, e.message);
      _showErr(
        e.name === 'NotAllowedError'   ? '⛔ Camera/mic permission denied. Allow access and try again.' :
        e.name === 'NotFoundError'     ? '⛔ No camera or microphone found on this device.' :
        e.name === 'NotReadableError'  ? '⛔ Camera or mic is busy. Close other apps and try again.' :
        '⛔ Could not access camera: ' + e.message
      );
      if (previewOff) previewOff.classList.add('show');
    }
  }

  _startPreview(facingMode);

  if (camBtn) camBtn.addEventListener('click', () => {
    camOn = !camOn;
    if (localStream) localStream.getVideoTracks().forEach(t => { t.enabled = camOn; });
    camBtn.classList.toggle('off', !camOn);
    camBtn.textContent = camOn ? '📷' : '🚫';
    if (previewOff) previewOff.classList.toggle('show', !camOn);
    _clearErr();
  });

  if (micBtn) micBtn.addEventListener('click', () => {
    micOn = !micOn;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = micOn; });
    micBtn.classList.toggle('off', !micOn);
    micBtn.textContent = micOn ? '🎤' : '🔇';
  });

  if (flipBtn) flipBtn.addEventListener('click', async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    await _startPreview(facingMode);
  });

  const cancelBtn = _el('snxLiveSetupCancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    _closeOverlay();
  });

  if (startBtn) startBtn.addEventListener('click', async () => {
    if (!localStream) { _showErr('⛔ No camera stream. Allow camera access first.'); return; }
    const user = _user();
    if (!user) { _showErr('⛔ Not authenticated.'); return; }

    startBtn.disabled = true;
    startBtn.textContent = 'GOING LIVE…';
    _clearErr();

    try {
      await _startLive(user, localStream, titleInput ? titleInput.value.trim() : '', facingMode, camOn, micOn);
    } catch (e) {
      _err('start','live','startLive', e.name || 'ERR', e.message);
      _showErr('⛔ Failed to start live: ' + e.message);
      startBtn.disabled = false;
      startBtn.textContent = 'START LIVE';
    }
  });
}

function _buildSetupHTML() {
  return `
<div class="snx-live-setup">
  <div class="snx-live-setup-header">
    <span class="snx-live-setup-title">🔴 GO LIVE</span>
    <button class="snx-live-setup-cancel" id="snxLiveSetupCancel">✕ Cancel</button>
  </div>
  <div class="snx-live-preview-wrap">
    <video id="snxLivePreviewVideo" playsinline muted autoplay></video>
    <div class="snx-live-preview-off" id="snxLivePreviewOff">
      <span class="snx-live-preview-off-icon">📷</span>
      <span>Camera off</span>
    </div>
  </div>
  <div class="snx-live-setup-controls">
    <button class="snx-live-ctrl-btn" id="snxLiveCamBtn" title="Toggle Camera">📷</button>
    <button class="snx-live-ctrl-btn" id="snxLiveMicBtn" title="Toggle Mic">🎤</button>
    <button class="snx-live-ctrl-btn" id="snxLiveFlipBtn" title="Flip Camera">🔄</button>
  </div>
  <div class="snx-live-setup-bottom">
    <input id="snxLiveTitleInput" class="snx-live-title-input"
      type="text" maxlength="80" placeholder="Add a title (optional)…" autocomplete="off">
    <button class="snx-live-start-btn" id="snxLiveStartBtn">START LIVE</button>
    <div class="snx-live-setup-err" id="snxLiveSetupErr"></div>
  </div>
</div>`;
}

/* ══════════════════════════════════════════════════════════
   STAGE 2 — CREATE FIREBASE LIVE ROOM
══════════════════════════════════════════════════════════ */
async function _startLive(user, localStream, title, facingMode, camOn, micOn) {
  _log('Auth ready — uid=' + user.uid);

  const db = _db();
  if (!db) throw new Error('Firebase RTDB not initialised');

  const ud   = _userData();
  const roomId    = user.uid.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,20) + '_' + Date.now().toString(36);
  const hostName  = ud.displayName || ud.username || user.displayName || user.email || 'Creator';
  const hostAvatar= ud.profileImage || ud.photoURL || user.photoURL || '';
  const startedAt = Date.now();

  const roomRef = ref(db, 'liveRooms/' + roomId);
  await set(roomRef, {
    roomId, hostId: user.uid, hostName, hostAvatar,
    title: title || '', status: 'live',
    startedAt, viewerCount: 0, likeCount: 0,
  });
  _log('Room created: ' + roomId);

  // Auto-end if host disconnects
  onDisconnect(ref(db, 'liveRooms/' + roomId + '/status')).set('ended');

  // Module state
  _S.hostRoomId   = roomId;
  _S.hostStream   = localStream;
  _S.hostCamOn    = camOn;
  _S.hostMicOn    = micOn;
  _S.hostPeers    = {};
  _S.hostEnded    = false;
  _S.hostStartedAt= startedAt;

  _log('Signaling ready');

  // Stage 3: host WebRTC
  _startHostWebRTC(user, roomId, localStream, db);

  _log('WebRTC ready');

  // Heartbeat
  const hbRef = ref(db, 'liveRooms/' + roomId + '/hostHb');
  _S.hostHbTimer = setInterval(async () => {
    try { await set(hbRef, Date.now()); } catch (_) {}
  }, 15000);

  // Open host stage
  _openHostStage(user, roomId, title, hostName, localStream, db, camOn, micOn);

  _log('LIVE STARTED');
}

/* ══════════════════════════════════════════════════════════
   STAGE 3 — HOST WebRTC
══════════════════════════════════════════════════════════ */
function _startHostWebRTC(user, roomId, localStream, db) {
  const sigBase = 'liveSignaling/' + roomId;
  const viewersRef = ref(db, sigBase);

  const cb = onValue(viewersRef, async (snap) => {
    if (!snap.exists()) return;
    const data = snap.val();
    for (const viewerId of Object.keys(data)) {
      if (_S.hostPeers[viewerId]) continue;
      if (data[viewerId] && data[viewerId].viewerReady) {
        await _hostConnectViewer(viewerId, roomId, localStream, db);
      }
    }
  });

  _S.hostSigRef = viewersRef;
  // Store cleanup: off(viewersRef, 'value', cb) — but since we use modular SDK,
  // we store the unsubscribe pattern by wrapping
  _S._hostSigOff = () => off(viewersRef, 'value', cb);
}

async function _hostConnectViewer(viewerId, roomId, localStream, db) {
  _log('Connecting viewer: ' + viewerId);
  const pc = new RTCPeerConnection(_ICE_CONFIG);
  _S.hostPeers[viewerId] = pc;

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  const sigPath = 'liveSignaling/' + roomId + '/' + viewerId;

  // Send host ICE candidates
  const hostCands = [];
  pc.onicecandidate = async ({ candidate }) => {
    if (candidate) {
      hostCands.push(candidate.toJSON());
      try { await set(ref(db, sigPath + '/hostCandidates'), hostCands); } catch (_) {}
    }
  };

  pc.onconnectionstatechange = () => {
    _log('Host peer ' + viewerId + ' → ' + pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      _cleanHostPeer(viewerId, db, roomId);
    }
  };

  // Offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await set(ref(db, sigPath + '/offer'), { type: offer.type, sdp: offer.sdp });

  // Watch for answer
  const ansRef = ref(db, sigPath + '/answer');
  let _ansApplied = false;
  const ansOff = onValue(ansRef, async (snap) => {
    if (!snap.exists() || _ansApplied) return;
    if (pc.signalingState !== 'have-local-offer') return;
    _ansApplied = true;
    try { await pc.setRemoteDescription(new RTCSessionDescription(snap.val())); }
    catch (e) { _err('host','webrtc','setAnswer', e.name, e.message); }
  });

  // Watch viewer ICE
  const vcRef = ref(db, sigPath + '/viewerCandidates');
  const vcApplied = new Set();
  const vcOff = onValue(vcRef, async (snap) => {
    if (!snap.exists()) return;
    const cands = snap.val();
    if (!Array.isArray(cands)) return;
    for (let i = 0; i < cands.length; i++) {
      if (!vcApplied.has(i)) {
        vcApplied.add(i);
        try { await pc.addIceCandidate(new RTCIceCandidate(cands[i])); } catch (_) {}
      }
    }
  });

  // Store cleanup
  _S.hostPeers[viewerId + '_cleanup'] = () => {
    off(ansRef, 'value', ansOff);
    off(vcRef,  'value', vcOff);
  };

  // Update viewer count
  _refreshViewerCount(roomId, db);
}

function _cleanHostPeer(viewerId, db, roomId) {
  const cleanup = _S.hostPeers[viewerId + '_cleanup'];
  if (cleanup) { try { cleanup(); } catch (_) {} }
  const pc = _S.hostPeers[viewerId];
  if (pc) { try { pc.close(); } catch (_) {} }
  delete _S.hostPeers[viewerId];
  delete _S.hostPeers[viewerId + '_cleanup'];
  try { remove(ref(db, 'liveSignaling/' + roomId + '/' + viewerId)); } catch (_) {}
}

function _refreshViewerCount(roomId, db) {
  get(ref(db, 'livePresence/' + roomId)).then(snap => {
    const count = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
    const el = _el('snxLiveViewerCount');
    if (el) el.textContent = '👁 ' + count;
    try { set(ref(db, 'liveRooms/' + roomId + '/viewerCount'), count); } catch (_) {}
  }).catch(() => {});
}

/* ══════════════════════════════════════════════════════════
   HOST LIVE STAGE UI
══════════════════════════════════════════════════════════ */
function _openHostStage(user, roomId, title, hostName, localStream, db, camOn, micOn) {
  _showOverlay(_buildHostStageHTML(hostName, title, camOn, micOn));

  // Attach local stream
  const video = _el('snxLiveStageVideo');
  if (video) { video.srcObject = localStream; video.muted = true; video.play().catch(() => {}); }

  // Timer
  _S.hostCountTimer = setInterval(() => {
    const timerEl = _el('snxLiveTimer');
    if (!timerEl) return;
    const el = Math.floor((Date.now() - _S.hostStartedAt) / 1000);
    const h = Math.floor(el/3600), m = Math.floor((el%3600)/60), s = el%60;
    timerEl.textContent = h > 0
      ? h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0')
      : String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }, 1000);

  // Viewer count (live presence)
  const presRef = ref(db, 'livePresence/' + roomId);
  const presCb = onValue(presRef, (snap) => {
    const count = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
    const el = _el('snxLiveViewerCount');
    if (el) el.textContent = '👁 ' + count;
    try { set(ref(db, 'liveRooms/' + roomId + '/viewerCount'), count); } catch (_) {}
  });

  // Cam toggle
  const camBtn = _el('snxLiveHostCamBtn');
  if (camBtn) camBtn.addEventListener('click', () => {
    _S.hostCamOn = !_S.hostCamOn;
    if (_S.hostStream) _S.hostStream.getVideoTracks().forEach(t => { t.enabled = _S.hostCamOn; });
    camBtn.classList.toggle('off', !_S.hostCamOn);
    camBtn.textContent = _S.hostCamOn ? '📷' : '🚫';
    const co = _el('snxLiveStageCamOff');
    if (co) co.classList.toggle('show', !_S.hostCamOn);
  });

  // Mic toggle
  const micBtn = _el('snxLiveHostMicBtn');
  if (micBtn) micBtn.addEventListener('click', () => {
    _S.hostMicOn = !_S.hostMicOn;
    if (_S.hostStream) _S.hostStream.getAudioTracks().forEach(t => { t.enabled = _S.hostMicOn; });
    micBtn.classList.toggle('off', !_S.hostMicOn);
    micBtn.textContent = _S.hostMicOn ? '🎤' : '🔇';
  });

  // End Live
  const endBtn  = _el('snxLiveEndBtn');
  const confirm = _el('snxLiveEndConfirm');
  if (endBtn && confirm) endBtn.addEventListener('click', () => confirm.classList.add('show'));
  const confirmEnd = _el('snxLiveConfirmEnd');
  if (confirmEnd) confirmEnd.addEventListener('click', () => _endLive(user, roomId, db, presRef, presCb));
  const confirmCancel = _el('snxLiveConfirmCancel');
  if (confirmCancel) confirmCancel.addEventListener('click', () => confirm && confirm.classList.remove('show'));

  // Chat
  _initChat(user, roomId, db, true, null);

  // Likes
  _watchLikes(roomId, db);
}

function _buildHostStageHTML(hostName, title, camOn, micOn) {
  return `
<div class="snx-live-stage">
  <div class="snx-live-stage-video-wrap">
    <video id="snxLiveStageVideo" playsinline muted autoplay></video>
    <div class="snx-live-cam-off-overlay${camOn ? '' : ' show'}" id="snxLiveStageCamOff">
      <span class="snx-live-cam-off-icon">📷</span><span>Camera off</span>
    </div>
    <div class="snx-live-top-bar">
      <div class="snx-live-badge"><span class="live-dot"></span>LIVE</div>
      <div class="snx-live-top-info">
        <div class="snx-live-host-name">${_esc(hostName)}</div>
        ${title ? '<div class="snx-live-stage-title">' + _esc(title) + '</div>' : ''}
      </div>
      <div class="snx-live-viewer-count" id="snxLiveViewerCount">👁 0</div>
      <div class="snx-live-timer" id="snxLiveTimer">00:00</div>
    </div>
    <div class="snx-live-host-controls">
      <button class="snx-live-ctrl-btn${camOn ? '' : ' off'}" id="snxLiveHostCamBtn">${camOn ? '📷' : '🚫'}</button>
      <button class="snx-live-ctrl-btn${micOn ? '' : ' off'}" id="snxLiveHostMicBtn">${micOn ? '🎤' : '🔇'}</button>
      <button class="snx-live-end-btn" id="snxLiveEndBtn">⏹ END LIVE</button>
    </div>
    <div class="snx-live-like-zone">
      <div class="snx-live-like-count" id="snxLiveLikeCount">0</div>
    </div>
    <div class="snx-live-confirm" id="snxLiveEndConfirm">
      <div class="snx-live-confirm-title">End your Live?</div>
      <div class="snx-live-confirm-sub">Your broadcast will end for all viewers.</div>
      <div class="snx-live-confirm-btns">
        <button class="snx-live-confirm-end" id="snxLiveConfirmEnd">⏹ END LIVE</button>
        <button class="snx-live-confirm-cancel" id="snxLiveConfirmCancel">Keep Live</button>
      </div>
    </div>
  </div>
  <div class="snx-live-chat">
    <div class="snx-live-chat-messages" id="snxLiveChatMessages"></div>
    <div class="snx-live-chat-input-row">
      <input class="snx-live-chat-input" id="snxLiveChatInput" type="text" maxlength="200" placeholder="Say something…" autocomplete="off">
      <button class="snx-live-chat-send" id="snxLiveChatSend">➤</button>
    </div>
  </div>
</div>`;
}

/* ══════════════════════════════════════════════════════════
   STAGE 8 — END LIVE (host)
══════════════════════════════════════════════════════════ */
async function _endLive(user, roomId, db, presRef, presCb) {
  if (_S.hostEnded) return;
  _S.hostEnded = true;
  _log('Ending live: ' + roomId);

  if (_S.hostHbTimer)    { clearInterval(_S.hostHbTimer);    _S.hostHbTimer    = null; }
  if (_S.hostCountTimer) { clearInterval(_S.hostCountTimer); _S.hostCountTimer = null; }
  if (_S._hostSigOff)    { _S._hostSigOff(); _S._hostSigOff = null; }

  // Presence listener
  if (presRef && presCb) try { off(presRef, 'value', presCb); } catch (_) {}

  // Close peer connections
  for (const key of Object.keys(_S.hostPeers)) {
    if (key.endsWith('_cleanup')) { try { _S.hostPeers[key](); } catch (_) {} }
    else { try { _S.hostPeers[key].close(); } catch (_) {} }
  }
  _S.hostPeers = {};

  // Stop local stream
  if (_S.hostStream) { _S.hostStream.getTracks().forEach(t => t.stop()); _S.hostStream = null; }

  // Mark room ended
  try { await update(ref(db, 'liveRooms/' + roomId), { status: 'ended', endedAt: Date.now() }); }
  catch (e) { _err('end','RTDB','markEnded', e.name, e.message); }

  // Cleanup RTDB
  try { await remove(ref(db, 'liveSignaling/' + roomId)); } catch (_) {}
  try { await remove(ref(db, 'livePresence/' + roomId)); } catch (_) {}

  _S.hostRoomId = null;

  _showOverlay(_buildEndedHTML(true));
  const backBtn = _el('snxLiveEndedBack');
  if (backBtn) backBtn.addEventListener('click', () => {
    _closeOverlay();
    if (typeof realmNavTo === 'function') realmNavTo('livePage');
  });

  _log('Live ended cleanly');
}

/* ══════════════════════════════════════════════════════════
   STAGE 4 — LIVE HUB
══════════════════════════════════════════════════════════ */
function _renderHub() {
  const container = _el('snxLiveHubCards');
  if (!container) return;

  const db = _db();
  if (!db) {
    container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>Live is loading…</div>';
    // Retry once RTDB ready
    setTimeout(() => { if (_db()) _renderHub(); }, 500);
    return;
  }

  // Detach previous listener
  if (_S.hubRef && _S.hubCb) { try { off(_S.hubRef, 'value', _S.hubCb); } catch (_) {} }

  const roomsRef = ref(db, 'liveRooms');
  const hubCb = onValue(roomsRef, (snap) => {
    container.innerHTML = '';
    if (!snap.exists()) {
      container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>No one is live right now.</div>';
      return;
    }
    const all = snap.val();
    const live = Object.values(all).filter(r => r && r.status === 'live');
    if (live.length === 0) {
      container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>No one is live right now.</div>';
      return;
    }
    live.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
    live.forEach(room => container.appendChild(_buildHubCard(room)));
  });

  _S.hubRef = roomsRef;
  _S.hubCb  = hubCb;
}

function _buildHubCard(room) {
  const card = document.createElement('div');
  card.className = 'live-hub-card';
  const avatar = room.hostAvatar || '';
  const initial = (room.hostName || '?')[0].toUpperCase();
  const avatarStyle = avatar
    ? 'background-image:url(\'' + _esc(avatar) + '\');background-size:cover;background-position:center;'
    : '';
  card.innerHTML = `
    <div class="live-hub-card-thumb">
      <div class="live-hub-card-avatar" style="${avatarStyle}">${avatar ? '' : initial}</div>
      <div class="live-hub-card-badge"><span class="live-dot"></span>LIVE</div>
      <div class="live-hub-card-viewers">👁 ${room.viewerCount || 0}</div>
    </div>
    <div class="live-hub-card-body">
      <div class="live-hub-card-name">${_esc(room.hostName || 'Creator')}</div>
      <div class="live-hub-card-title">${_esc(room.title || 'Shadow Nexus Live')}</div>
    </div>`;
  card.addEventListener('click', () => window.snxLiveOpenViewer(room.roomId));
  return card;
}

/* ══════════════════════════════════════════════════════════
   VIEWER SCREEN (Stage 3 viewer + 5 presence + 6 chat + 7 likes)
══════════════════════════════════════════════════════════ */
async function _openViewerScreen(roomId) {
  _log('Opening viewer for room: ' + roomId);
  const db = _db();
  if (!db) { if (typeof toastNotification === 'function') toastNotification('⛔ Service unavailable.'); return; }

  const snap = await get(ref(db, 'liveRooms/' + roomId));
  if (!snap.exists() || snap.val().status !== 'live') {
    if (typeof toastNotification === 'function') toastNotification('⛔ This live has ended.');
    return;
  }
  const room = snap.val();

  _showOverlay(_buildViewerHTML(room));

  const user     = _user();
  const sessId   = _uid();
  _S.viewRoomId  = roomId;
  _S.viewSessId  = sessId;
  _S.viewUnsubs  = [];

  // Stage 5 — presence
  const presPath = 'livePresence/' + roomId + '/' + sessId;
  const presRef  = ref(db, presPath);
  _S.viewPresRef = presRef;
  await set(presRef, { uid: user.uid, joinedAt: Date.now() });
  onDisconnect(presRef).remove();

  // Watch total viewer count
  const presAllRef = ref(db, 'livePresence/' + roomId);
  const presAllCb  = onValue(presAllRef, (s) => {
    const count = s.exists() ? Object.keys(s.val() || {}).length : 0;
    const el = _el('snxViewerCount');
    if (el) el.textContent = '👁 ' + count;
  });
  _S.viewUnsubs.push(() => off(presAllRef, 'value', presAllCb));

  // Signal host: viewer is ready
  const sigPath = 'liveSignaling/' + roomId + '/' + sessId;
  await set(ref(db, sigPath + '/viewerReady'), true);

  // Wait for host offer then create peer connection
  const sigRef = ref(db, sigPath);
  let pc = null;
  const sigCb = onValue(sigRef, async (s) => {
    if (!s.exists()) return;
    const sig = s.val();

    if (sig.offer && !pc) {
      pc = new RTCPeerConnection(_ICE_CONFIG);
      _S.viewPc = pc;

      pc.ontrack = ({ streams }) => {
        const video = _el('snxLiveViewerVideo');
        if (video && streams[0]) {
          video.srcObject = streams[0];
          video.play().catch(() => {});
          const loader = _el('snxViewerLoader');
          if (loader) loader.classList.remove('show');
        }
        _log('Viewer receiving stream');
      };

      pc.onconnectionstatechange = () => {
        _log('Viewer peer → ' + pc.connectionState);
        if (pc.connectionState === 'failed') {
          const msg = _el('snxViewerMsg');
          if (msg) { msg.textContent = '⚠️ Connection lost.'; msg.style.display = 'block'; }
        }
      };

      const viewerCands = [];
      pc.onicecandidate = async ({ candidate }) => {
        if (candidate) {
          viewerCands.push(candidate.toJSON());
          try { await set(ref(db, sigPath + '/viewerCandidates'), viewerCands); } catch (_) {}
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sig.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await set(ref(db, sigPath + '/answer'), { type: answer.type, sdp: answer.sdp });
    }

    // Apply host ICE candidates
    if (pc && sig.hostCandidates && Array.isArray(sig.hostCandidates)) {
      for (const c of sig.hostCandidates) {
        try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
      }
    }
  });
  _S.viewUnsubs.push(() => off(sigRef, 'value', sigCb));

  // Watch room status — host may end Live
  const statusRef = ref(db, 'liveRooms/' + roomId + '/status');
  const statusCb  = onValue(statusRef, (s) => {
    if (s.exists() && s.val() === 'ended') _onViewerHostEnded();
  });
  _S.viewUnsubs.push(() => off(statusRef, 'value', statusCb));

  // Chat
  _initChat(user, roomId, db, false, (unsub) => {
    _S.viewUnsubs.push(unsub);
  });

  // Likes
  _watchLikes(roomId, db);
  const likeBtn = _el('snxViewerLikeBtn');
  if (likeBtn) likeBtn.addEventListener('click', () => _sendLike(roomId, db));

  // Leave
  const leaveBtn = _el('snxLiveLeaveBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', () => _leaveViewer(roomId, sessId, db));
}

function _onViewerHostEnded() {
  _cleanupViewer();
  _showOverlay(_buildEndedHTML(false));
  const backBtn = _el('snxLiveEndedBack');
  if (backBtn) backBtn.addEventListener('click', () => {
    _closeOverlay();
    if (typeof realmNavTo === 'function') realmNavTo('livePage');
  });
}

function _cleanupViewer() {
  if (_S.viewPc) { try { _S.viewPc.close(); } catch (_) {} _S.viewPc = null; }
  for (const fn of _S.viewUnsubs) { try { fn(); } catch (_) {} }
  _S.viewUnsubs = [];
}

async function _leaveViewer(roomId, sessId, db) {
  _cleanupViewer();
  if (_S.viewPresRef) { try { await remove(_S.viewPresRef); } catch (_) {} _S.viewPresRef = null; }
  try { await remove(ref(db, 'liveSignaling/' + roomId + '/' + sessId)); } catch (_) {}
  _closeOverlay();
}

function _buildViewerHTML(room) {
  return `
<div class="snx-live-stage">
  <div class="snx-live-stage-video-wrap">
    <video id="snxLiveViewerVideo" playsinline autoplay></video>
    <div class="snx-live-top-bar">
      <div class="snx-live-badge"><span class="live-dot"></span>LIVE</div>
      <div class="snx-live-top-info">
        <div class="snx-live-host-name">${_esc(room.hostName || 'Creator')}</div>
        ${room.title ? '<div class="snx-live-stage-title">' + _esc(room.title) + '</div>' : ''}
      </div>
      <div class="snx-live-viewer-count" id="snxViewerCount">👁 0</div>
    </div>
    <div class="snx-live-host-controls">
      <button class="snx-live-leave-btn" id="snxLiveLeaveBtn">↩ Leave</button>
    </div>
    <div class="snx-live-like-zone">
      <button class="snx-live-like-btn" id="snxViewerLikeBtn">❤️</button>
      <div class="snx-live-like-count" id="snxLiveLikeCount">0</div>
    </div>
    <div class="snx-live-loader show" id="snxViewerLoader">
      <div class="snx-live-spinner"></div>
      <div class="snx-live-loader-text">Connecting to live…</div>
    </div>
    <div id="snxViewerMsg" style="display:none;position:absolute;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:#fff;padding:8px 16px;border-radius:10px;font-size:12px;z-index:40;white-space:nowrap;"></div>
  </div>
  <div class="snx-live-chat">
    <div class="snx-live-chat-messages" id="snxLiveChatMessages"></div>
    <div class="snx-live-chat-input-row">
      <input class="snx-live-chat-input" id="snxLiveChatInput" type="text" maxlength="200" placeholder="Say something…" autocomplete="off">
      <button class="snx-live-chat-send" id="snxLiveChatSend">➤</button>
    </div>
  </div>
</div>`;
}

/* ══════════════════════════════════════════════════════════
   STAGE 6 — CHAT
══════════════════════════════════════════════════════════ */
function _initChat(user, roomId, db, isHost, storeUnsub) {
  const msgsEl  = _el('snxLiveChatMessages');
  const inputEl = _el('snxLiveChatInput');
  const sendBtn = _el('snxLiveChatSend');
  if (!msgsEl) return;

  const chatRef = ref(db, 'liveChats/' + roomId);
  const q = query(chatRef, limitToLast(100));
  const cb = onValue(q, (snap) => {
    msgsEl.innerHTML = '';
    if (!snap.exists()) return;
    Object.values(snap.val()).forEach(msg => {
      const div = document.createElement('div');
      div.className = 'snx-live-chat-msg';
      div.innerHTML = '<span class="msg-user">' + _esc(msg.username || 'User') + '</span>' + _esc(msg.text || '');
      msgsEl.appendChild(div);
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  });

  if (!isHost && storeUnsub) storeUnsub(() => off(q, 'value', cb));

  async function _sendMsg() {
    const text = inputEl ? inputEl.value.trim() : '';
    if (!text) return;
    if (inputEl) inputEl.value = '';
    const ud = _userData();
    const username = ud.displayName || ud.username || user.displayName || 'User';
    try {
      await set(push(chatRef), { uid: user.uid, username, text, createdAt: Date.now() });
    } catch (e) { _err('chat','RTDB','push', e.name, e.message); }
  }

  if (sendBtn) sendBtn.addEventListener('click', _sendMsg);
  if (inputEl) inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _sendMsg(); } });
}

/* ══════════════════════════════════════════════════════════
   STAGE 7 — LIKES
══════════════════════════════════════════════════════════ */
function _watchLikes(roomId, db) {
  const likeRef = ref(db, 'liveRooms/' + roomId + '/likeCount');
  onValue(likeRef, (snap) => {
    const count = snap.exists() ? (snap.val() || 0) : 0;
    const el = _el('snxLiveLikeCount');
    if (el) el.textContent = count >= 1000 ? (count/1000).toFixed(1) + 'k' : String(count);
  });
}

async function _sendLike(roomId, db) {
  _animateHeart();
  const likeRef = ref(db, 'liveRooms/' + roomId + '/likeCount');
  try {
    const snap = await get(likeRef);
    await set(likeRef, (snap.exists() ? (snap.val() || 0) : 0) + 1);
  } catch (_) {}
}

function _animateHeart() {
  const heart = document.createElement('div');
  heart.className = 'snx-live-heart';
  heart.textContent = '❤️';
  heart.style.cssText = 'position:fixed;right:' + (20 + Math.random()*20) + 'px;bottom:200px;z-index:10010;pointer-events:none;font-size:20px;animation:heartFloat 1.4s ease-out forwards;';
  document.body.appendChild(heart);
  setTimeout(() => heart.remove(), 1500);
}

/* ══════════════════════════════════════════════════════════
   ENDED SCREEN
══════════════════════════════════════════════════════════ */
function _buildEndedHTML(isHost) {
  return `
<div class="snx-live-ended">
  <span class="snx-live-ended-icon">📴</span>
  <div class="snx-live-ended-title">${isHost ? 'Live Ended' : 'Stream Ended'}</div>
  <div class="snx-live-ended-sub">${isHost
    ? 'Your broadcast has ended. Your viewers have been notified.'
    : 'This live stream has ended. Thanks for watching!'}</div>
  <button class="snx-live-ended-back" id="snxLiveEndedBack">← Back to Live Hub</button>
</div>`;
}

/* ══════════════════════════════════════════════════════════
   GUEST MODE HOOK
══════════════════════════════════════════════════════════ */
// _hookGoLive is referenced by guest mode — provide it
function _hookGoLive() {
  if (window._snxGuestGoLiveHooked) return;
  const orig = window.snxLiveOpenGoLive;
  if (!orig) return;
  window._snxGuestGoLiveHooked = true;
  window.snxLiveOpenGoLive = function() {
    if (typeof window._isAuthUser === 'function' && !window._isAuthUser() && window.snxIsGuest && window.snxIsGuest()) {
      if (typeof window.snxJoinOpen === 'function') window.snxJoinOpen();
      return;
    }
    return orig.apply(this, arguments);
  };
}
// Expose for guest mode script
window._hookGoLive = _hookGoLive;

_log('live.js loaded — SNS-2026-LIVE-001');
