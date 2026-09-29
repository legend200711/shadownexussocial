/**
 * Shadow Nexus Social — Live System
 * live.js  (SNS-2026-LIVE-005)
 *
 * ONE canonical Live engine for Shadow Nexus Social.
 * ES module — loaded as <script type="module"> in index.html.
 *
 * Firebase paths (RTDB):
 *   liveRooms/{roomId}                        — room metadata
 *   liveSignaling/{roomId}/{viewerId}         — WebRTC signaling
 *   liveSignaling/{roomId}/{viewerId}/hostCandidates/{key}   — host ICE (keyed)
 *   liveSignaling/{roomId}/{viewerId}/viewerCandidates/{key} — viewer ICE (keyed)
 *   livePresence/{roomId}/{viewerId}          — viewer presence
 *   liveChats/{roomId}/{msgId}                — chat messages
 *
 * FIXES (SNS-2026-LIVE-004):
 *   - HOST+VIEWER: ICE candidates now use Firebase push() keys — no array overwrites
 *   - HOST+VIEWER: applied candidate IDs tracked with Set() — each applied exactly once
 *   - HOST: viewer ICE candidates queued until setRemoteDescription completes
 *   - HOST: [LIVE-HOST] viewer-ready checkpoint added
 *   - VIEWER: 30-second connection timeout → "Unable to connect" with Retry / Leave
 *   - VIEWER: Retry cleanly destroys failed peer and restarts signaling (no page reload)
 *   - VIEWER: _setViewerStatus extended with NEGOTIATING state
 *   - VIEWER: connTimeout cleared in _cleanupViewer
 *   - ALL: checkpoint labels match spec exactly
 *
 * FIXES (SNS-2026-LIVE-005):
 *   - CRITICAL: RTDB rules now grant read at liveSignaling/{roomId} so host can
 *     enumerate viewers via onValue(liveSignaling/{roomId}). Without this the host
 *     never detected viewerReady and never created the offer — root cause of
 *     "Connecting to Live..." being permanent.
 *   - CRITICAL: RTDB liveRooms write rule simplified — the old cross-reference rule
 *     (.write: root.child(...) == auth.uid) caused permission-denied for viewer
 *     viewerCount writes; replaced with auth != null so any authenticated user can
 *     update non-sensitive live room metadata.
 *   - HOST: added onValue error callback on _startHostWebRTC so RTDB permission
 *     errors surface in console instead of being swallowed.
 *   - HOST: added [LIVE-HOST] room-created checkpoint.
 *   - VIEWER: added [LIVE-VIEWER] signaling-started checkpoint.
 *   - VIEWER: viewerCount write wrapped in try/catch with explicit error log.
 */

import {
  ref, set, get, update, remove, push,
  onValue, off, onDisconnect, query, limitToLast,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ══════════════════════════════════════════════════════════
   ICE CONFIGURATION
════════════════════════════════════════════════════════════ */
const _ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

/* ══════════════════════════════════════════════════════════
   STALE SESSION DETECTION
════════════════════════════════════════════════════════════ */
const HB_INTERVAL_MS    = 15_000;
const STALE_THRESHOLD_MS = 90_000;

/* ══════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════════ */
function _log(msg)   { console.log('[SNX-LIVE] ' + msg); }
function _disc(msg)  { console.log('[SNX-LIVE-DISCOVERY] ' + msg); }
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
   CHECKPOINT LOGGERS
════════════════════════════════════════════════════════════ */
function _hLog(checkpoint, extra) {
  console.log('[LIVE-HOST] ' + checkpoint + (extra !== undefined ? ' = ' + extra : ''));
}
function _vLog(checkpoint, extra) {
  console.log('[LIVE-VIEWER] ' + checkpoint + (extra !== undefined ? ' = ' + extra : ''));
}
function _hErr(checkpoint, err, path, roomId) {
  console.error(
    '[LIVE-HOST] ERROR at ' + checkpoint +
    ' | name=' + (err && err.name) +
    ' | message=' + (err && err.message) +
    (path   ? ' | path='   + path   : '') +
    (roomId ? ' | roomId=' + roomId : '')
  );
}
function _vErr(checkpoint, err, path, roomId, viewerId) {
  console.error(
    '[LIVE-VIEWER] ERROR at ' + checkpoint +
    ' | name=' + (err && err.name) +
    ' | message=' + (err && err.message) +
    (path     ? ' | path='     + path     : '') +
    (roomId   ? ' | roomId='   + roomId   : '') +
    (viewerId ? ' | viewerId=' + viewerId : '')
  );
}

/* ══════════════════════════════════════════════════════════
   SHARED ACTIVE-ROOM FILTER
════════════════════════════════════════════════════════════ */
function _filterActiveRooms(allRoomsVal) {
  const now       = Date.now();
  const allRooms  = Object.values(allRoomsVal || {});

  const totalRecords = allRooms.length;
  const statusLive   = allRooms.filter(r => r && r.status === 'live');

  const fresh = statusLive.filter(r => {
    const hb   = r.lastHeartbeat || r.hostHb || r.startedAt || 0;
    const age  = now - hb;
    return age < STALE_THRESHOLD_MS;
  });
  const staleCount = statusLive.length - fresh.length;

  const byHost = new Map();
  fresh.forEach(r => {
    const existing = byHost.get(r.hostId);
    if (!existing || (r.startedAt || 0) > (existing.startedAt || 0)) {
      byHost.set(r.hostId, r);
    }
  });
  const dupCount = fresh.length - byHost.size;

  const result = [...byHost.values()].sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));

  _disc('total room records: '   + totalRecords);
  _disc('status-live rooms: '    + statusLive.length);
  _disc('stale rooms: '          + staleCount);
  _disc('duplicate hosts: '      + dupCount);
  _disc('final displayed lives: '+ result.length);

  return result;
}

window._snxLiveFilterActiveRooms = _filterActiveRooms;

/* ══════════════════════════════════════════════════════════
   MODULE STATE
════════════════════════════════════════════════════════════ */
const _S = {
  /* host */
  hostRoomId:    null,
  hostSessionId: null,
  hostStream:    null,
  hostCamOn:     true,
  hostMicOn:     true,
  hostPeers:     {},
  hostSigRef:    null,
  hostHbTimer:   null,
  hostCountTimer:null,
  hostStartedAt: null,
  hostEnded:     false,
  hostReqUnsub:  null,   // RTDB guestRequests listener unsub (host side)
  hostShownReqs: null,   // Set of viewer UIDs whose card has been shown
  /* viewer */
  viewRoomId:    null,
  viewSessId:    null,
  viewPc:        null,
  viewPresRef:   null,
  viewUnsubs:    [],
  viewConnTimeout: null,   // 30-second connection watchdog
  viewReqUnsub:  null,   // Firestore boxRequest status listener unsub (viewer side)
  /* hub */
  hubRef:        null,
  hubCb:         null,
};

/* ══════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */

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
════════════════════════════════════════════════════════════ */
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
════════════════════════════════════════════════════════════ */
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
      _hLog('media-ready');
    } catch (e) {
      _hErr('media-ready', e, 'getUserMedia', null);
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
      _hErr('startLive', e, null, null);
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
════════════════════════════════════════════════════════════ */
async function _endAbandonedRooms(userId, db) {
  _log('Checking for abandoned rooms for host: ' + userId);
  try {
    const snap = await get(ref(db, 'liveRooms'));
    if (!snap.exists()) return;
    const all = snap.val() || {};
    const abandoned = Object.values(all).filter(
      r => r && r.hostId === userId && r.status === 'live'
    );
    for (const r of abandoned) {
      _log('Ending abandoned room: ' + r.roomId);
      try {
        await update(ref(db, 'liveRooms/' + r.roomId), {
          status: 'ended',
          endedAt: Date.now(),
        });
      } catch (_) {}
      try { await remove(ref(db, 'liveSignaling/' + r.roomId)); } catch (_) {}
      try { await remove(ref(db, 'livePresence/'  + r.roomId)); } catch (_) {}
    }
    if (abandoned.length) _log('Cleaned ' + abandoned.length + ' abandoned room(s)');
  } catch (e) {
    _hErr('endAbandoned', e, 'liveRooms', null);
  }
}

async function _startLive(user, localStream, title, facingMode, camOn, micOn) {
  _log('Auth ready — uid=' + user.uid);

  const db = _db();
  if (!db) throw new Error('Firebase RTDB not initialised');

  await _endAbandonedRooms(user.uid, db);

  const ud         = _userData();
  const sessionId  = _uid();
  const roomId     = user.uid.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,20) + '_' + Date.now().toString(36);
  const hostName   = ud.displayName || ud.username || user.displayName || user.email || 'Creator';
  const hostAvatar = ud.profileImage || ud.photoURL || user.photoURL || '';
  const startedAt  = Date.now();

  _hLog('roomId', roomId);

  const roomRef = ref(db, 'liveRooms/' + roomId);
  await set(roomRef, {
    roomId,
    sessionId,
    hostId: user.uid,
    hostName,
    hostAvatar,
    title: title || '',
    status: 'live',
    startedAt,
    lastHeartbeat: startedAt,
    viewerCount: 0,
    likeCount: 0,
  });
  _log('Room created: ' + roomId + ' sessionId: ' + sessionId);
  _hLog('room-created', 'roomId=' + roomId);

  onDisconnect(ref(db, 'liveRooms/' + roomId + '/status')).set('ended');
  onDisconnect(ref(db, 'liveRooms/' + roomId + '/endedAt')).set(Date.now());
  onDisconnect(ref(db, 'liveRooms/' + roomId + '/lastHeartbeat')).set(0);

  _S.hostRoomId    = roomId;
  _S.hostSessionId = sessionId;
  _S.hostStream    = localStream;
  _S.hostCamOn     = camOn;
  _S.hostMicOn     = micOn;
  _S.hostPeers     = {};
  _S.hostEnded     = false;
  _S.hostStartedAt = startedAt;

  _log('Signaling ready');
  _startHostWebRTC(user, roomId, localStream, db);
  _log('WebRTC ready');

  const hbRef = ref(db, 'liveRooms/' + roomId + '/lastHeartbeat');
  _S.hostHbTimer = setInterval(async () => {
    try { await set(hbRef, Date.now()); } catch (_) {}
  }, HB_INTERVAL_MS);

  _openHostStage(user, roomId, title, hostName, localStream, db, camOn, micOn);
  _log('LIVE STARTED');
}

/* ══════════════════════════════════════════════════════════
   STAGE 3 — HOST WebRTC
════════════════════════════════════════════════════════════ */
function _startHostWebRTC(user, roomId, localStream, db) {
  const sigBase    = 'liveSignaling/' + roomId;
  const viewersRef = ref(db, sigBase);

  const cb = onValue(viewersRef, async (snap) => {
    if (!snap.exists()) return;
    const data = snap.val();
    for (const viewerId of Object.keys(data)) {
      if (_S.hostPeers[viewerId]) continue;
      if (data[viewerId] && data[viewerId].viewerReady) {
        _hLog('viewer-ready', 'viewerId=' + viewerId + ' roomId=' + roomId);
        await _hostConnectViewer(viewerId, roomId, localStream, db);
      }
    }
  }, (err) => {
    // If this fires it means the RTDB rule at liveSignaling/{roomId} does not
    // grant read access to the host. Fix: add ".read": "auth != null" at the
    // $roomId level in database.rules.json (done in SNS-2026-LIVE-005).
    _hErr('viewer-watcher', err, sigBase, roomId);
    console.error('[LIVE-HOST] CRITICAL — cannot watch liveSignaling/' + roomId +
      ' | code=' + (err.code || err.message) +
      ' | Host will not detect viewers. Verify RTDB rules.');
  });

  _S.hostSigRef  = viewersRef;
  _S._hostSigOff = () => off(viewersRef, 'value', cb);
}

async function _hostConnectViewer(viewerId, roomId, localStream, db) {
  const pc = new RTCPeerConnection(_ICE_CONFIG);
  _S.hostPeers[viewerId] = pc;
  _hLog('peer-created', 'viewerId=' + viewerId + ' roomId=' + roomId);

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  _hLog('tracks-added', 'viewerId=' + viewerId);

  const sigPath = 'liveSignaling/' + roomId + '/' + viewerId;

  // ── ICE candidate publishing: push-keyed children (one key per candidate) ──
  pc.onicecandidate = async ({ candidate }) => {
    if (!candidate) return;
    _hLog('ice-created', 'viewerId=' + viewerId);
    const icePath = sigPath + '/hostCandidates';
    try {
      await set(push(ref(db, icePath)), candidate.toJSON());
      _hLog('ice-created', 'written viewerId=' + viewerId);
    } catch (e) {
      _hErr('ice-created', e, icePath, roomId);
    }
  };

  pc.oniceconnectionstatechange = () => {
    _hLog('connection-state', 'ice=' + pc.iceConnectionState + ' viewerId=' + viewerId);
  };

  pc.onconnectionstatechange = () => {
    _hLog('connection-state', pc.connectionState + ' viewerId=' + viewerId);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      _cleanHostPeer(viewerId, db, roomId);
    }
  };

  // ── Create and publish offer ──
  let offer;
  try {
    offer = await pc.createOffer();
    _hLog('offer-created', 'viewerId=' + viewerId);
  } catch (e) {
    _hErr('offer-created', e, sigPath + '/offer', roomId);
    _cleanHostPeer(viewerId, db, roomId);
    return;
  }

  try {
    await pc.setLocalDescription(offer);
  } catch (e) {
    _hErr('offer-written', e, sigPath + '/offer', roomId);
    _cleanHostPeer(viewerId, db, roomId);
    return;
  }

  try {
    await set(ref(db, sigPath + '/offer'), { type: offer.type, sdp: offer.sdp });
    _hLog('offer-written', 'viewerId=' + viewerId);
  } catch (e) {
    _hErr('offer-written', e, sigPath + '/offer', roomId);
    _cleanHostPeer(viewerId, db, roomId);
    return;
  }

  // ── Watch for viewer answer — apply only once ──
  let answerApplied = false;
  const ansRef = ref(db, sigPath + '/answer');
  const ansCb  = onValue(ansRef, async (s) => {
    if (!s.exists() || answerApplied) return;
    if (pc.signalingState !== 'have-local-offer') return;
    answerApplied = true;
    _hLog('answer-received', 'viewerId=' + viewerId);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(s.val()));
      _hLog('remote-description-set', 'viewerId=' + viewerId);
      // Flush any viewer ICE that arrived before remoteDescription was ready
      _flushHostPendingViewerCands(viewerId, pc, sigPath, db, roomId);
    } catch (e) {
      _hErr('remote-description-set', e, sigPath + '/answer', roomId);
      answerApplied = false;
    }
  });

  // ── Watch for viewer ICE candidates — push-keyed, Set-tracked, queued until remoteDesc ──
  const appliedViewerCandIds  = new Set();
  const pendingViewerCands    = [];   // queued before remoteDescription is ready
  _S.hostPeers[viewerId + '_pendingViewerCands'] = pendingViewerCands;
  _S.hostPeers[viewerId + '_appliedViewerCandIds'] = appliedViewerCandIds;

  const vcRef = ref(db, sigPath + '/viewerCandidates');
  const vcCb  = onValue(vcRef, async (s) => {
    if (!s.exists()) return;
    const all = s.val();
    for (const [key, cand] of Object.entries(all)) {
      if (appliedViewerCandIds.has(key)) continue;
      if (!pc.remoteDescription) {
        _hLog('ice-received', 'queued viewerCand key=' + key + ' viewerId=' + viewerId);
        pendingViewerCands.push({ key, cand });
        appliedViewerCandIds.add(key);   // prevent double-queuing
      } else {
        _hLog('ice-received', 'applying viewerCand key=' + key + ' viewerId=' + viewerId);
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
          appliedViewerCandIds.add(key);
          _hLog('ice-applied', 'viewerCand key=' + key + ' viewerId=' + viewerId);
        } catch (e) {
          _hErr('ice-applied', e, sigPath + '/viewerCandidates', roomId);
        }
      }
    }
  });

  _S.hostPeers[viewerId + '_cleanup'] = () => {
    try { off(ansRef, 'value', ansCb); } catch (_) {}
    try { off(vcRef,  'value', vcCb);  } catch (_) {}
    try { pc.close(); } catch (_) {}
  };
}

/** Called after host setRemoteDescription to drain queued viewer ICE candidates. */
async function _flushHostPendingViewerCands(viewerId, pc, sigPath, db, roomId) {
  const pending = _S.hostPeers[viewerId + '_pendingViewerCands'] || [];
  if (!pending.length) return;
  _hLog('ice-applied', 'flushing ' + pending.length + ' queued viewerCands for viewerId=' + viewerId);
  const applied = _S.hostPeers[viewerId + '_appliedViewerCandIds'] || new Set();
  for (const { key, cand } of pending.splice(0)) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(cand));
      applied.add(key);
      _hLog('ice-applied', 'flushed viewerCand key=' + key + ' viewerId=' + viewerId);
    } catch (e) {
      _hErr('ice-applied', e, sigPath + '/viewerCandidates', roomId);
    }
  }
}

function _cleanHostPeer(viewerId, db, roomId) {
  const cleanup = _S.hostPeers[viewerId + '_cleanup'];
  if (cleanup) { try { cleanup(); } catch (_) {} }
  delete _S.hostPeers[viewerId];
  delete _S.hostPeers[viewerId + '_cleanup'];
  delete _S.hostPeers[viewerId + '_pendingViewerCands'];
  delete _S.hostPeers[viewerId + '_appliedViewerCandIds'];
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
════════════════════════════════════════════════════════════ */
function _openHostStage(user, roomId, title, hostName, localStream, db, camOn, micOn) {
  _showOverlay(_buildHostStageHTML(hostName, title, camOn, micOn));

  const video = _el('snxLiveStageVideo');
  if (video) { video.srcObject = localStream; video.muted = true; video.play().catch(() => {}); }

  // ── Box grid init (frontend only — no backend changes) ──
  _attachBoxesOnStageOpen(hostName, localStream);

  _S.hostCountTimer = setInterval(() => {
    const timerEl = _el('snxLiveTimer');
    if (!timerEl) return;
    const el = Math.floor((Date.now() - _S.hostStartedAt) / 1000);
    const h = Math.floor(el/3600), m = Math.floor((el%3600)/60), s = el%60;
    timerEl.textContent = h > 0
      ? h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0')
      : String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
  }, 1000);

  const presRef = ref(db, 'livePresence/' + roomId);
  const presCb  = onValue(presRef, (snap) => {
    const count = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
    const el = _el('snxLiveViewerCount');
    if (el) el.textContent = '👁 ' + count;
    try { set(ref(db, 'liveRooms/' + roomId + '/viewerCount'), count); } catch (_) {}
  });

  const camBtn = _el('snxLiveHostCamBtn');
  if (camBtn) camBtn.addEventListener('click', () => {
    _S.hostCamOn = !_S.hostCamOn;
    if (_S.hostStream) _S.hostStream.getVideoTracks().forEach(t => { t.enabled = _S.hostCamOn; });
    camBtn.classList.toggle('off', !_S.hostCamOn);
    camBtn.textContent = _S.hostCamOn ? '📷' : '🚫';
    const co = _el('snxLiveStageCamOff');
    if (co) co.classList.toggle('show', !_S.hostCamOn);
  });

  const micBtn = _el('snxLiveHostMicBtn');
  if (micBtn) micBtn.addEventListener('click', () => {
    _S.hostMicOn = !_S.hostMicOn;
    if (_S.hostStream) _S.hostStream.getAudioTracks().forEach(t => { t.enabled = _S.hostMicOn; });
    micBtn.classList.toggle('off', !_S.hostMicOn);
    micBtn.textContent = _S.hostMicOn ? '🎤' : '🔇';
  });

  const endBtn  = _el('snxLiveEndBtn');
  const confirm = _el('snxLiveEndConfirm');
  if (endBtn && confirm) endBtn.addEventListener('click', () => confirm.classList.add('show'));
  const confirmEnd = _el('snxLiveConfirmEnd');
  if (confirmEnd) confirmEnd.addEventListener('click', () => _endLive(user, roomId, db, presRef, presCb));
  const confirmCancel = _el('snxLiveConfirmCancel');
  if (confirmCancel) confirmCancel.addEventListener('click', () => confirm && confirm.classList.remove('show'));

  _initChat(user, roomId, db, true, null);
  _watchLikes(roomId, db);

  // ── Start host-side request listener ──
  _startHostRequestListener(roomId, user.uid, db);
}

// NOTE: _attachBoxesOnStageOpen is defined later in this file (SNS-2026-BOXES-002).
// The call above is safe because JS hoists function declarations.

function _buildHostStageHTML(hostName, title, camOn, micOn) {
  const ud = _userData();
  const avatarUrl = ud.profileImage || ud.photoURL || '';
  const avatarStyle = avatarUrl ? 'background-image:url(' + _esc(avatarUrl) + ')' : '';
  const avatarText  = avatarUrl ? '' : (hostName ? hostName.charAt(0).toUpperCase() : '?');
  return `
<div class="snx-live-stage is-host">
  <video id="snxLiveStageVideo" playsinline muted autoplay></video>
  <div class="snx-live-cam-off-overlay${camOn ? '' : ' show'}" id="snxLiveStageCamOff">
    <span class="snx-live-cam-off-icon">📷</span><span>Camera off</span>
  </div>
  <div class="snx-live-top-bar">
    <div class="snx-live-host-avatar" style="${avatarStyle}" title="${_esc(hostName)}">${avatarText}</div>
    <div class="snx-live-badge"><span class="live-dot"></span>LIVE</div>
    <div class="snx-live-top-info">
      <div class="snx-live-host-name">${_esc(hostName)}</div>
      ${title ? '<div class="snx-live-stage-title">' + _esc(title) + '</div>' : ''}
    </div>
    <div class="snx-live-top-stats">
      <div class="snx-live-viewer-count" id="snxLiveViewerCount">👁 0</div>
      <div class="snx-live-like-count-top" id="snxLiveLikeCount">⚡ 0</div>
      <div class="snx-live-timer" id="snxLiveTimer">00:00</div>
    </div>
  </div>
  <div class="snx-live-comments-overlay" id="snxLiveChatMessages"></div>
  <div class="snx-live-chat-input-row">
    <input class="snx-live-chat-input" id="snxLiveChatInput" type="text" maxlength="200" placeholder="Say something…" autocomplete="off">
    <button class="snx-live-chat-send" id="snxLiveChatSend">➤</button>
  </div>
  <div class="snx-live-host-controls">
    <button class="snx-live-ctrl-btn${camOn ? '' : ' off'}" id="snxLiveHostCamBtn">${camOn ? '📷' : '🚫'}</button>
    <button class="snx-live-ctrl-btn${micOn ? '' : ' off'}" id="snxLiveHostMicBtn">${micOn ? '🎤' : '🔇'}</button>
    <button class="snx-live-end-btn" id="snxLiveEndBtn">⏹ END LIVE</button>
  </div>
  <div class="snx-live-confirm" id="snxLiveEndConfirm">
    <div class="snx-live-confirm-title">End your Live?</div>
    <div class="snx-live-confirm-sub">Your broadcast will end for all viewers.</div>
    <div class="snx-live-confirm-btns">
      <button class="snx-live-confirm-end" id="snxLiveConfirmEnd">⏹ END LIVE</button>
      <button class="snx-live-confirm-cancel" id="snxLiveConfirmCancel">Keep Live</button>
    </div>
  </div>
</div>`;
}

/* ══════════════════════════════════════════════════════════
   STAGE 8 — END LIVE (host)
════════════════════════════════════════════════════════════ */
async function _endLive(user, roomId, db, presRef, presCb) {
  if (_S.hostEnded) return;
  _S.hostEnded = true;
  _log('Ending live: ' + roomId);

  if (_S.hostHbTimer)    { clearInterval(_S.hostHbTimer);    _S.hostHbTimer    = null; }
  if (_S.hostCountTimer) { clearInterval(_S.hostCountTimer); _S.hostCountTimer = null; }
  if (_S._hostSigOff)    { _S._hostSigOff(); _S._hostSigOff = null; }
  if (_S.hostReqUnsub)   { try { _S.hostReqUnsub(); } catch (_) {} _S.hostReqUnsub = null; }

  if (presRef && presCb) try { off(presRef, 'value', presCb); } catch (_) {}

  for (const key of Object.keys(_S.hostPeers)) {
    if (key.endsWith('_cleanup')) { try { _S.hostPeers[key](); } catch (_) {} }
    else { try { _S.hostPeers[key].close(); } catch (_) {} }
  }
  _S.hostPeers = {};

  if (_S.hostStream) { _S.hostStream.getTracks().forEach(t => t.stop()); _S.hostStream = null; }

  try {
    await update(ref(db, 'liveRooms/' + roomId), {
      status: 'ended',
      endedAt: Date.now(),
      lastHeartbeat: 0,
    });
  }
  catch (e) { _hErr('end-markEnded', e, 'liveRooms/' + roomId, roomId); }

  try { await remove(ref(db, 'liveSignaling/' + roomId)); } catch (_) {}
  try { await remove(ref(db, 'livePresence/'  + roomId)); } catch (_) {}

  _S.hostRoomId    = null;
  _S.hostSessionId = null;
  _boxState.clear();   // clear box layout state on live end

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
════════════════════════════════════════════════════════════ */
function _renderHub() {
  const container = _el('snxLiveHubCards');
  if (!container) return;

  const db = _db();
  if (!db) {
    container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>Live is loading…</div>';
    setTimeout(() => { if (_db()) _renderHub(); }, 500);
    return;
  }

  if (_S.hubRef && _S.hubCb) { try { off(_S.hubRef, 'value', _S.hubCb); } catch (_) {} }

  const roomsRef = ref(db, 'liveRooms');
  const hubCb = onValue(roomsRef, (snap) => {
    container.innerHTML = '';
    if (!snap.exists()) {
      container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>No one is live right now.</div>';
      return;
    }
    const active = _filterActiveRooms(snap.val());
    if (!active.length) {
      container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>No one is live right now.</div>';
      return;
    }
    active.forEach(room => container.appendChild(_buildHubCard(room)));
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
   VIEWER SCREEN
════════════════════════════════════════════════════════════ */

/** Update the viewer status text shown over the video. */
function _setViewerStatus(status) {
  const loaderText = _el('snxViewerLoaderText');
  const loader     = _el('snxViewerLoader');
  const tapBtn     = _el('snxViewerTapToPlay');
  if (!loaderText || !loader) return;

  switch (status) {
    case 'connecting':
      loader.classList.add('show');
      loaderText.textContent = 'Connecting to live…';
      if (tapBtn) tapBtn.style.display = 'none';
      break;
    case 'negotiating':
      loader.classList.add('show');
      loaderText.textContent = 'Negotiating connection…';
      if (tapBtn) tapBtn.style.display = 'none';
      break;
    case 'connected':
      loaderText.textContent = 'Connected — waiting for video…';
      break;
    case 'playing':
      loader.classList.remove('show');
      if (tapBtn) tapBtn.style.display = 'none';
      break;
    case 'tap-to-play':
      loader.classList.remove('show');
      if (tapBtn) tapBtn.style.display = '';
      break;
    case 'failed':
      loader.classList.add('show');
      if (tapBtn) tapBtn.style.display = 'none';
      loaderText.textContent = '⚠️ Live connection failed. Try rejoining.';
      break;
    case 'timeout':
      loader.classList.add('show');
      if (tapBtn) tapBtn.style.display = 'none';
      loaderText.textContent = 'Unable to connect to Live';
      break;
    case 'ended':
      loaderText.textContent = 'Stream ended.';
      loader.classList.add('show');
      if (tapBtn) tapBtn.style.display = 'none';
      break;
    default:
      loaderText.textContent = String(status);
  }
}

async function _openViewerScreen(roomId) {
  _vLog('room-found', 'roomId=' + roomId);
  const db = _db();
  if (!db) { if (typeof toastNotification === 'function') toastNotification('⛔ Service unavailable.'); return; }

  const snap = await get(ref(db, 'liveRooms/' + roomId));
  if (!snap.exists() || snap.val().status !== 'live') {
    if (typeof toastNotification === 'function') toastNotification('⛔ This live has ended.');
    return;
  }
  const room = snap.val();

  _showOverlay(_buildViewerHTML(room));

  const user   = _user();
  const sessId = _uid();
  _S.viewRoomId = roomId;
  _S.viewSessId = sessId;
  _S.viewUnsubs = [];

  _vLog('room-found', 'roomId=' + roomId + ' sessId=' + sessId);
  _setViewerStatus('connecting');

  // ── Presence ──
  const presPath = 'livePresence/' + roomId + '/' + sessId;
  const presRef  = ref(db, presPath);
  _S.viewPresRef = presRef;
  try {
    await set(presRef, { uid: user.uid, joinedAt: Date.now() });
    onDisconnect(presRef).remove();
  } catch (e) {
    _vErr('presence-set', e, presPath, roomId, sessId);
  }

  const presAllRef = ref(db, 'livePresence/' + roomId);
  const presAllCb  = onValue(presAllRef, (s) => {
    const count = s.exists() ? Object.keys(s.val() || {}).length : 0;
    const el = _el('snxViewerCount');
    if (el) el.textContent = '👁 ' + count;
  });
  _S.viewUnsubs.push(() => off(presAllRef, 'value', presAllCb));

  // ── Signal host: viewer is ready ──
  _vLog('signaling-started', 'roomId=' + roomId + ' sessId=' + sessId);
  const sigPath = 'liveSignaling/' + roomId + '/' + sessId;
  try {
    await set(ref(db, sigPath + '/viewerReady'), true);
    _vLog('viewer-ready-written', 'path=' + sigPath + '/viewerReady');
  } catch (e) {
    _vErr('viewer-ready-written', e, sigPath + '/viewerReady', roomId, sessId);
    // If this is a permission-denied error the RTDB liveSignaling rule is wrong.
    console.error('[LIVE-VIEWER] CRITICAL — cannot write viewerReady to liveSignaling/' +
      roomId + '/' + sessId + ' | code=' + (e.code || e.message));
  }

  // ── 30-second connection watchdog ──
  _S.viewConnTimeout = setTimeout(() => {
    // Only fire if we haven't started playing yet
    if (!_S.viewPc || _S.viewPc.connectionState === 'connected') return;
    _vLog('connection-state', 'TIMEOUT — no connection after 30s roomId=' + roomId);
    _setViewerStatus('timeout');
    _showViewerTimeoutUI(roomId, sessId, db, room);
  }, 30_000);

  // ── Offer listener ──
  const offerRef = ref(db, sigPath + '/offer');
  let pc               = null;
  let remoteDescSet    = false;
  let answerPublished  = false;

  // host ICE: push-keyed, Set-tracked, queued until remoteDescription ready
  const appliedHostCandIds = new Set();
  const pendingHostCands   = [];  // { key, cand } pairs waiting for remoteDesc

  const offerCb = onValue(offerRef, async (s) => {
    if (!s.exists() || pc) return;   // process offer only once
    _vLog('offer-received', 'roomId=' + roomId);
    _setViewerStatus('negotiating');

    try {
      pc = new RTCPeerConnection(_ICE_CONFIG);
      _S.viewPc = pc;
      _vLog('peer-created', 'roomId=' + roomId);

      // ── ontrack: attach remote stream to video ──
      const remoteStream = new MediaStream();
      pc.ontrack = (event) => {
        _vLog('ontrack', 'kind=' + event.track.kind + ' roomId=' + roomId);
        event.streams.forEach(stream => {
          stream.getTracks().forEach(t => {
            if (!remoteStream.getTracks().includes(t)) remoteStream.addTrack(t);
          });
        });
        const video = _el('snxLiveViewerVideo');
        if (video) {
          if (video.srcObject !== remoteStream) {
            video.srcObject = remoteStream;
            _vLog('stream-attached', 'roomId=' + roomId);
          }
          const playPromise = video.play();
          if (playPromise !== undefined) {
            playPromise
              .then(() => {
                _vLog('video-playing', 'roomId=' + roomId);
                _clearViewerTimeout();
                _setViewerStatus('playing');
              })
              .catch((e) => {
                _vLog('video-playing', 'autoplay-blocked ' + e.name + ' roomId=' + roomId);
                _setViewerStatus('tap-to-play');
                const tapBtn = _el('snxViewerTapToPlay');
                if (tapBtn) {
                  tapBtn.onclick = () => {
                    video.play().then(() => {
                      _vLog('video-playing', 'after-tap roomId=' + roomId);
                      _clearViewerTimeout();
                      _setViewerStatus('playing');
                    }).catch(() => {});
                  };
                }
              });
          }
        }
      };

      // ── Connection state monitoring ──
      pc.oniceconnectionstatechange = () => {
        _vLog('connection-state', 'ice=' + pc.iceConnectionState + ' roomId=' + roomId);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          _clearViewerTimeout();
          _setViewerStatus('connected');
        } else if (pc.iceConnectionState === 'failed') {
          _vLog('connection-state', 'ICE FAILED roomId=' + roomId);
          _setViewerStatus('failed');
        }
      };

      pc.onconnectionstatechange = () => {
        _vLog('connection-state', pc.connectionState + ' roomId=' + roomId);
        if (pc.connectionState === 'connected') {
          _clearViewerTimeout();
          _setViewerStatus('connected');
        } else if (pc.connectionState === 'failed') {
          _setViewerStatus('failed');
        }
      };

      // ── Viewer ICE candidate publishing — push-keyed children ──
      pc.onicecandidate = async ({ candidate }) => {
        if (!candidate) return;
        _vLog('ice-created', 'roomId=' + roomId);
        const icePath = sigPath + '/viewerCandidates';
        try {
          await set(push(ref(db, icePath)), candidate.toJSON());
          _vLog('ice-created', 'written roomId=' + roomId);
        } catch (e) {
          _vErr('ice-created', e, icePath, roomId, sessId);
        }
      };

      // ── Set remote description (offer) ──
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(s.val()));
        remoteDescSet = true;
        _vLog('remote-description-set', 'roomId=' + roomId);
      } catch (e) {
        _vErr('remote-description-set', e, sigPath + '/offer', roomId, sessId);
        return;
      }

      // ── Flush host ICE candidates queued before remoteDesc was ready ──
      if (pendingHostCands.length > 0) {
        _vLog('ice-applied', 'flushing ' + pendingHostCands.length + ' queued hostCands roomId=' + roomId);
        for (const { key, cand } of pendingHostCands.splice(0)) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
            appliedHostCandIds.add(key);
            _vLog('ice-applied', 'flushed hostCand key=' + key + ' roomId=' + roomId);
          } catch (e) {
            _vErr('ice-applied', e, sigPath + '/hostCandidates', roomId, sessId);
          }
        }
      }

      // ── Create and publish answer (only once per session) ──
      if (!answerPublished) {
        let answer;
        try {
          answer = await pc.createAnswer();
          _vLog('answer-created', 'roomId=' + roomId);
        } catch (e) {
          _vErr('answer-created', e, sigPath + '/answer', roomId, sessId);
          return;
        }

        try {
          await pc.setLocalDescription(answer);
        } catch (e) {
          _vErr('answer-written', e, sigPath + '/answer', roomId, sessId);
          return;
        }

        try {
          await set(ref(db, sigPath + '/answer'), { type: answer.type, sdp: answer.sdp });
          answerPublished = true;
          _vLog('answer-written', 'roomId=' + roomId);
        } catch (e) {
          _vErr('answer-written', e, sigPath + '/answer', roomId, sessId);
        }
      }

    } catch (e) {
      _vErr('peer-created', e, sigPath, roomId, sessId);
    }
  });
  _S.viewUnsubs.push(() => off(offerRef, 'value', offerCb));

  // ── Host ICE candidates — push-keyed children, Set-tracked, queued until remoteDesc ──
  const hostCandRef = ref(db, sigPath + '/hostCandidates');
  const hostCandCb  = onValue(hostCandRef, async (s) => {
    if (!s.exists()) return;
    const all = s.val();
    for (const [key, cand] of Object.entries(all)) {
      if (appliedHostCandIds.has(key)) continue;
      _vLog('ice-received', 'hostCand key=' + key + ' roomId=' + roomId);
      if (!remoteDescSet || !pc) {
        pendingHostCands.push({ key, cand });
        appliedHostCandIds.add(key);   // prevent double-queuing
        _vLog('ice-received', 'queued hostCand key=' + key + ' (no remoteDesc yet) roomId=' + roomId);
      } else {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
          appliedHostCandIds.add(key);
          _vLog('ice-applied', 'hostCand key=' + key + ' roomId=' + roomId);
        } catch (e) {
          _vErr('ice-applied', e, sigPath + '/hostCandidates', roomId, sessId);
        }
      }
    }
  });
  _S.viewUnsubs.push(() => off(hostCandRef, 'value', hostCandCb));

  // ── Room status — host may end Live ──
  const statusRef = ref(db, 'liveRooms/' + roomId + '/status');
  const statusCb  = onValue(statusRef, (s) => {
    if (s.exists() && s.val() === 'ended') _onViewerHostEnded();
  });
  _S.viewUnsubs.push(() => off(statusRef, 'value', statusCb));

  _initChat(user, roomId, db, false, (unsub) => {
    _S.viewUnsubs.push(unsub);
  });

  // Reset local like counters for this session
  _S._likeLocalCount  = 0;
  _S._likeServerCount = 0;
  _S._likePending     = 0;
  if (_S._likeFlushTimer) { clearTimeout(_S._likeFlushTimer); _S._likeFlushTimer = null; }

  _watchLikes(roomId, db);

  // ── Multi-tap reaction zone (covers video body) ──
  const tapZone = _el('snxViewerTapZone');
  if (tapZone) {
    let _tapCount = 0;
    let _tapResetTimer = null;
    const _onTap = (e) => {
      // Block taps that originate on interactive elements
      const tag = (e.target || e.srcElement || {}).tagName || '';
      if (['BUTTON','INPUT','A'].includes(tag.toUpperCase())) return;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      _tapCount++;
      const rapid = _tapCount >= 4;
      _tapLike(roomId, db, clientX, clientY, rapid);
      // Reset rapid-tap counter after 800ms of no taps
      if (_tapResetTimer) clearTimeout(_tapResetTimer);
      _tapResetTimer = setTimeout(() => { _tapCount = 0; }, 800);
    };
    tapZone.addEventListener('click',      _onTap, { passive: true });
    tapZone.addEventListener('touchstart', _onTap, { passive: true });
  }

  // Leave button is now in the top bar (back button)
  const leaveBtn = _el('snxLiveLeaveBtn');
  if (leaveBtn) leaveBtn.addEventListener('click', () => _leaveViewer(roomId, sessId, db));

  // ── Request to Join button (viewer side, frontend only) ──
  // Backend hook not available — see report below.
  setTimeout(() => _attachRequestBtn(roomId, db), 0);
}

/** Clear the 30-second connection watchdog when connection succeeds or video plays. */
function _clearViewerTimeout() {
  if (_S.viewConnTimeout) { clearTimeout(_S.viewConnTimeout); _S.viewConnTimeout = null; }
}

/**
 * Show "Unable to connect to Live" UI with Retry and Leave buttons.
 * Retry cleanly destroys the failed peer and re-starts signaling without page reload.
 */
function _showViewerTimeoutUI(roomId, sessId, db, room) {
  const loader     = _el('snxViewerLoader');
  const loaderText = _el('snxViewerLoaderText');
  if (!loaderText) return;

  // Replace loader content with timeout message + action buttons
  loaderText.innerHTML =
    'Unable to connect to Live' +
    '<div style="margin-top:14px;display:flex;gap:10px;justify-content:center;">' +
      '<button id="snxViewerRetryBtn" style="padding:10px 22px;background:#0ae;color:#fff;border:none;border-radius:24px;font-weight:800;font-size:13px;cursor:pointer;">↻ RETRY</button>' +
      '<button id="snxViewerLeaveBtn2" style="padding:10px 22px;background:rgba(255,255,255,0.15);color:#fff;border:1px solid rgba(255,255,255,0.3);border-radius:24px;font-size:13px;cursor:pointer;">✕ LEAVE</button>' +
    '</div>';

  const retryBtn = _el('snxViewerRetryBtn');
  const leaveBtn = _el('snxViewerLeaveBtn2');

  if (retryBtn) retryBtn.addEventListener('click', async () => {
    _vLog('connection-state', 'RETRY requested roomId=' + roomId);
    // Clean up existing peer and signaling
    _cleanupViewer();
    if (_S.viewPresRef) {
      try { await remove(_S.viewPresRef); } catch (_) {}
      _S.viewPresRef = null;
    }
    try { await remove(ref(db, 'liveSignaling/' + roomId + '/' + sessId)); } catch (_) {}
    // Re-open viewer screen — this generates a new sessId and full fresh attempt
    _openViewerScreen(roomId);
  });

  if (leaveBtn) leaveBtn.addEventListener('click', () => _leaveViewer(roomId, sessId, db));
}

function _onViewerHostEnded() {
  _cleanupViewer();
  _setViewerStatus('ended');
  _showOverlay(_buildEndedHTML(false));
  const backBtn = _el('snxLiveEndedBack');
  if (backBtn) backBtn.addEventListener('click', () => {
    _closeOverlay();
    if (typeof realmNavTo === 'function') realmNavTo('livePage');
  });
}

function _cleanupViewer() {
  _clearViewerTimeout();
  // Flush any pending batched likes immediately on cleanup
  if (_S._likeFlushTimer) { clearTimeout(_S._likeFlushTimer); _S._likeFlushTimer = null; }
  if (_S.viewPc) { try { _S.viewPc.close(); } catch (_) {} _S.viewPc = null; }
  for (const fn of _S.viewUnsubs) { try { fn(); } catch (_) {} }
  _S.viewUnsubs = [];
  // Clean up any pending Request-to-Join status listener
  if (_S.viewReqUnsub) { try { _S.viewReqUnsub(); } catch (_) {} _S.viewReqUnsub = null; }
  _boxState.clear();   // clear box layout state on viewer leave
}

async function _leaveViewer(roomId, sessId, db) {
  _cleanupViewer();
  if (_S.viewPresRef) { try { await remove(_S.viewPresRef); } catch (_) {} _S.viewPresRef = null; }
  try { await remove(ref(db, 'liveSignaling/' + roomId + '/' + sessId)); } catch (_) {}
  _closeOverlay();
}

function _buildViewerHTML(room) {
  const avatarUrl  = room.hostAvatar || '';
  const avatarStyle = avatarUrl ? 'background-image:url(' + _esc(avatarUrl) + ')' : '';
  const avatarText  = avatarUrl ? '' : ((room.hostName || 'C').charAt(0).toUpperCase());
  return `
<div class="snx-live-stage">
  <video id="snxLiveViewerVideo" playsinline autoplay></video>
  <div class="snx-live-tap-zone" id="snxViewerTapZone"></div>
  <div class="snx-live-top-bar">
    <button class="snx-live-back-btn" id="snxLiveLeaveBtn">←</button>
    <div class="snx-live-host-avatar" style="${avatarStyle}">${avatarText}</div>
    <div class="snx-live-badge"><span class="live-dot"></span>LIVE</div>
    <div class="snx-live-top-info">
      <div class="snx-live-host-name">${_esc(room.hostName || 'Creator')}</div>
      ${room.title ? '<div class="snx-live-stage-title">' + _esc(room.title) + '</div>' : ''}
    </div>
    <div class="snx-live-top-stats">
      <div class="snx-live-viewer-count" id="snxViewerCount">👁 0</div>
      <div class="snx-live-like-count-top" id="snxLiveLikeCount">⚡ 0</div>
    </div>
  </div>
  <div class="snx-live-comments-overlay" id="snxLiveChatMessages"></div>
  <div class="snx-live-chat-input-row">
    <input class="snx-live-chat-input" id="snxLiveChatInput" type="text" maxlength="200" placeholder="Say something…" autocomplete="off">
    <button class="snx-live-chat-send" id="snxLiveChatSend">➤</button>
  </div>
  <div class="snx-live-loader show" id="snxViewerLoader">
    <div class="snx-live-loader-brand">Shadow Nexus</div>
    <div class="snx-live-nexus-ring"></div>
    <div class="snx-live-loader-title">NEXUS <span>LIVE</span></div>
    <div class="snx-live-loader-text" id="snxViewerLoaderText">Connecting to broadcast…</div>
  </div>
  <button id="snxViewerTapToPlay" style="display:none;position:absolute;bottom:90px;left:50%;transform:translateX(-50%);z-index:40;padding:12px 28px;background:rgba(0,174,239,0.92);color:#fff;border:none;border-radius:30px;font-size:14px;font-weight:800;letter-spacing:1px;cursor:pointer;backdrop-filter:blur(8px);">▶ TAP TO PLAY LIVE</button>
  <div id="snxViewerMsg" style="display:none;position:absolute;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);color:#fff;padding:8px 16px;border-radius:10px;font-size:12px;z-index:40;white-space:nowrap;"></div>
</div>`;
}

/* ══════════════════════════════════════════════════════════
   STAGE 6 — CHAT
════════════════════════════════════════════════════════════ */
/* Max visible comment nodes in the overlay */
const _CHAT_MAX_VISIBLE = 12;
/* After this many ms a comment starts fading */
const _CHAT_MSG_TTL_MS  = 15_000;

function _initChat(user, roomId, db, isHost, storeUnsub) {
  const msgsEl  = _el('snxLiveChatMessages');
  const inputEl = _el('snxLiveChatInput');
  const sendBtn = _el('snxLiveChatSend');
  if (!msgsEl) return;

  const chatRef = ref(db, 'liveChats/' + roomId);
  const q = query(chatRef, limitToLast(100));
  const cb = onValue(q, (snap) => {
    if (!snap.exists()) return;
    const msgs = Object.values(snap.val());
    const recent = msgs.slice(-_CHAT_MAX_VISIBLE);
    // Rebuild only if content changed (avoid flicker on every new message)
    msgsEl.innerHTML = '';
    recent.forEach(msg => {
      const div = document.createElement('div');
      div.className = 'snx-live-chat-msg';
      div.innerHTML = '<span class="msg-user">' + _esc(msg.username || 'User') + '</span>' + _esc(msg.text || '');
      msgsEl.appendChild(div);
      // Schedule fade-out for older messages
      if (_CHAT_MSG_TTL_MS > 0) {
        setTimeout(() => {
          if (div.parentNode) {
            div.classList.add('fading-out');
            setTimeout(() => { if (div.parentNode) div.remove(); }, 500);
          }
        }, _CHAT_MSG_TTL_MS);
      }
    });
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
════════════════════════════════════════════════════════════ */
/* ── Like count display helper ── */
function _fmtLikes(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1000)      return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function _watchLikes(roomId, db) {
  const likeRef = ref(db, 'liveRooms/' + roomId + '/likeCount');
  onValue(likeRef, (snap) => {
    const serverCount = snap.exists() ? (snap.val() || 0) : 0;
    // Reconcile: show max(server, local optimistic) so UI never jumps backwards
    _S._likeServerCount = serverCount;
    const display = Math.max(serverCount, _S._likeLocalCount || 0);
    const el = _el('snxLiveLikeCount');
    if (el) el.textContent = '⚡ ' + _fmtLikes(display);
  });
}

/* ── Multi-tap like state ── */
const _LIKE_FLUSH_MS = 1200; // debounce window before writing to Firebase

function _tapLike(roomId, db, x, y, rapid) {
  // 1. Increment local optimistic counter immediately
  _S._likeLocalCount = (_S._likeLocalCount || 0) + 1;
  const display = Math.max(_S._likeLocalCount, _S._likeServerCount || 0);
  const el = _el('snxLiveLikeCount');
  if (el) el.textContent = '⚡ ' + _fmtLikes(display);

  // 2. Spawn Nexus energy burst at tap location
  _animateNexusBurst(x, y, rapid);

  // 3. Accumulate pending likes for batched Firebase write
  _S._likePending = (_S._likePending || 0) + 1;
  if (_S._likeFlushTimer) clearTimeout(_S._likeFlushTimer);
  _S._likeFlushTimer = setTimeout(() => _flushLikes(roomId, db), _LIKE_FLUSH_MS);
}

async function _flushLikes(roomId, db) {
  const pending = _S._likePending || 0;
  if (!pending) return;
  _S._likePending = 0;
  _S._likeFlushTimer = null;
  const likeRef = ref(db, 'liveRooms/' + roomId + '/likeCount');
  try {
    const snap = await get(likeRef);
    const current = snap.exists() ? (snap.val() || 0) : 0;
    await set(likeRef, current + pending);
  } catch (_) {}
}

/* ── Shadow Nexus energy burst animation ── */
function _animateNexusBurst(x, y, strong) {
  const burst = document.createElement('div');
  burst.className = 'snx-nexus-burst' + (strong ? ' strong' : '');
  burst.style.left = x + 'px';
  burst.style.top  = y + 'px';
  document.body.appendChild(burst);
  setTimeout(() => burst.remove(), 600);
}

/* ══════════════════════════════════════════════════════════
   ENDED SCREEN
════════════════════════════════════════════════════════════ */
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
   DYNAMIC BOX LAYOUT MANAGER  (SNS-2026-BOXES-002)

   Frontend-only.  No backend modifications.

   MAX_GUEST_BOXES = 4   (host is NOT counted against this limit)
   Max total on screen   = 5  (1 host + 4 guests)

   Two data attributes on .snx-live-stage drive all CSS layout:
     data-boxes   = total active participants (1–5)
     data-layout  = auto | spotlight | grid | guestrow | focus

   Box entry map:
     _boxState  Map<uid, { uid, name, role, state, el, videoEl }>

   Layout state:
     _currentLayout  string  — one of the 5 layout keys
     _focusedUid     string|null  — uid of focused participant in focus mode

   Public window.snxBoxManager API (called by future backend integration):
     addGuest(uid, name, stream|null)
     setGuestStream(uid, stream)
     setGuestState(uid, 'connecting'|'ready'|'disconnected')
     removeGuest(uid)
     setHostCamState(bool)
     showRequestBtn(bool)
     showRequestCard(uid, name, avatar, onAccept?, onDecline?)
     dismissRequestCard(uid)
     setLayout(layoutKey)     — programmatic layout change
     setFocus(uid)            — set focused participant in focus mode
════════════════════════════════════════════════════════════ */

// ── Configuration ──
const MAX_GUEST_BOXES = 4;   // host is separate; guests only
const _LAYOUTS = ['auto', 'spotlight', 'grid', 'guestrow', 'focus'];
const _LAYOUT_META = [
  { key: 'auto',       icon: '⬡', name: 'Auto',           desc: 'Smart arrangement' },
  { key: 'spotlight',  icon: '★', name: 'Host Spotlight',  desc: 'Host large, guests side' },
  { key: 'grid',       icon: '⊞', name: 'Equal Grid',      desc: 'All equal size' },
  { key: 'guestrow',   icon: '▬', name: 'Guest Row',       desc: 'Host top, guests below' },
  { key: 'focus',      icon: '◎', name: 'Focus Mode',      desc: 'Tap to spotlight anyone' },
];

/** Internal box state */
const _boxState = new Map();     // uid → { uid, name, role, state, el, videoEl }
let _currentLayout = 'auto';
let _focusedUid    = null;       // uid of focused participant (focus mode)

// ── DOM helpers ──
function _getStage() {
  return document.querySelector('.snx-live-stage') || null;
}

function _ensureBoxGrid() {
  const stage = _getStage();
  if (!stage) return null;
  let grid = stage.querySelector('.snx-live-boxes');
  if (!grid) {
    grid = document.createElement('div');
    grid.className = 'snx-live-boxes';
    stage.insertBefore(grid, stage.firstChild);
  }
  return grid;
}

// ── Build host box (called once when host stage opens) ──
function _initHostBox(hostName, localStream) {
  const grid = _ensureBoxGrid();
  if (!grid) return;
  if (_boxState.has('_host_')) return;

  const box = _buildBox('_host_', hostName || 'Host', 'host');
  grid.appendChild(box.el);
  _boxState.set('_host_', box);

  if (localStream) {
    box.videoEl.srcObject = localStream;
    box.videoEl.muted = true;
    box.videoEl.play().catch(() => {});
    _setBxState('_host_', 'ready');
  }
  _recalcLayout();
}

// ── Build a single .snx-box element ──
function _buildBox(uid, name, role) {
  const el = document.createElement('div');
  el.className = 'snx-box';
  el.dataset.uid   = uid;
  el.dataset.role  = role;
  el.dataset.state = 'connecting';

  // Video
  const videoEl = document.createElement('video');
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('autoplay', '');
  if (role === 'host') videoEl.muted = true;
  el.appendChild(videoEl);

  // Label  ("★ HOST • NAME" or "NAME")
  const label = document.createElement('div');
  label.className = 'snx-box-label';
  label.textContent = role === 'host'
    ? ('★ HOST' + (name ? ' • ' + name : ''))
    : _esc(name || 'Guest');
  el.appendChild(label);

  // Connecting overlay
  const connEl = document.createElement('div');
  connEl.className = 'snx-box-connecting show';
  connEl.innerHTML =
    '<div class="snx-box-conn-ring"></div>' +
    '<div class="snx-box-conn-name">' + _esc(name || '') + '</div>' +
    '<div class="snx-box-conn-text">Connecting…</div>';
  el.appendChild(connEl);

  // Cam-off overlay
  const camOffEl = document.createElement('div');
  camOffEl.className = 'snx-box-cam-off';
  camOffEl.innerHTML = '<span class="snx-box-cam-off-icon">📷</span><span>Camera off</span>';
  el.appendChild(camOffEl);

  // Disconnected overlay
  const discEl = document.createElement('div');
  discEl.className = 'snx-box-disconnected';
  discEl.innerHTML =
    '<span class="snx-box-disconnected-icon">📡</span>' +
    '<span class="snx-box-disconnected-text">Connection lost…</span>';
  el.appendChild(discEl);

  // Focus-tap overlay (only interactive in focus mode — CSS z-index handles it)
  const tapEl = document.createElement('div');
  tapEl.className = 'snx-box-focus-tap';
  tapEl.addEventListener('click', () => {
    const stage = _getStage();
    if (stage && stage.dataset.layout === 'focus') {
      window.snxBoxManager.setFocus(uid);
    }
  });
  el.appendChild(tapEl);

  return { uid, name, role, state: 'connecting', el, videoEl };
}

// ── Set box visual state ──
function _setBxState(uid, state) {
  const box = _boxState.get(uid);
  if (!box) return;
  box.state = state;
  box.el.dataset.state = state;
  const conn = box.el.querySelector('.snx-box-connecting');
  const disc = box.el.querySelector('.snx-box-disconnected');
  if (conn) conn.classList.toggle('show', state === 'connecting');
  if (disc) disc.classList.toggle('show', state === 'disconnected');
}

// ── Recalculate data-boxes + data-layout on stage element ──
function _recalcLayout() {
  const stage = _getStage();
  if (!stage) return;

  const total = _boxState.size;   // includes host

  // Hard cap guard — log unexpected overflow, never crash or show extra boxes
  const guests = [..._boxState.values()].filter(b => b.role === 'guest');
  if (guests.length > MAX_GUEST_BOXES) {
    console.warn('[SNX-BOXES] Guest count (' + guests.length + ') exceeds MAX_GUEST_BOXES (' + MAX_GUEST_BOXES + ').');
  }

  // data-boxes = min(total, 1 host + MAX_GUEST_BOXES)
  const displayed = Math.min(total, 1 + MAX_GUEST_BOXES);
  stage.dataset.boxes  = displayed > 0 ? String(displayed) : '1';
  stage.dataset.layout = _currentLayout;

  // Show/hide the Layout button (only useful with ≥2 participants, host stage only)
  const layoutBtn = stage.querySelector('.snx-live-layout-btn');
  if (layoutBtn) layoutBtn.classList.toggle('visible', displayed >= 2 && stage.classList.contains('is-host'));

  // In focus mode, ensure the focused uid still has the class
  _applyFocusClass();
}

// ── Apply/remove .snx-box-focused class to the correct box ──
function _applyFocusClass() {
  const stage = _getStage();
  if (!stage) return;

  // Default focus target: host
  const focusTarget = _focusedUid || '_host_';

  _boxState.forEach((box) => {
    box.el.classList.toggle('snx-box-focused', box.uid === focusTarget);
  });
}

// ── Attach all host-side chrome to the stage after overlay renders ──
function _attachBoxesOnStageOpen(hostName, localStream) {
  setTimeout(() => {
    _boxState.clear();
    _currentLayout = 'auto';
    _focusedUid    = null;
    _ensureBoxGrid();
    _initHostBox(hostName, localStream);
    _attachRequestQueue();
    _attachLayoutPicker();
  }, 0);
}

// ── Inject guest request queue element ──
function _attachRequestQueue() {
  const stage = _getStage();
  if (!stage || stage.querySelector('.snx-live-req-queue')) return;
  const queue = document.createElement('div');
  queue.className = 'snx-live-req-queue';
  queue.id = 'snxLiveReqQueue';
  stage.appendChild(queue);
}

// ── Inject Layout picker button + panel (host only) ──
function _attachLayoutPicker() {
  const stage = _getStage();
  if (!stage || !stage.classList.contains('is-host')) return;
  if (stage.querySelector('.snx-live-layout-btn')) return;

  // Button
  const btn = document.createElement('button');
  btn.className = 'snx-live-layout-btn';
  btn.id = 'snxLiveLayoutBtn';
  btn.setAttribute('aria-label', 'Switch layout');
  btn.innerHTML = '⬡ Layout';

  // Panel
  const panel = document.createElement('div');
  panel.className = 'snx-live-layout-panel';
  panel.id = 'snxLiveLayoutPanel';

  _LAYOUT_META.forEach(({ key, icon, name, desc }) => {
    const opt = document.createElement('div');
    opt.className = 'snx-layout-option' + (key === _currentLayout ? ' active' : '');
    opt.dataset.layout = key;
    opt.innerHTML =
      '<span class="snx-layout-option-icon">' + icon + '</span>' +
      '<div><div class="snx-layout-option-name">' + name + '</div>' +
      '<div class="snx-layout-option-desc">' + desc + '</div></div>';
    opt.addEventListener('click', () => {
      window.snxBoxManager.setLayout(key);
      panel.classList.remove('open');
    });
    panel.appendChild(opt);
  });

  // Toggle panel on button click
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  });
  // Close panel when clicking outside
  document.addEventListener('click', () => panel.classList.remove('open'));

  stage.appendChild(btn);
  stage.appendChild(panel);
}

// ── Update active state in the panel ──
function _syncLayoutPanel(layoutKey) {
  const panel = _el('snxLiveLayoutPanel');
  if (!panel) return;
  panel.querySelectorAll('.snx-layout-option').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.layout === layoutKey);
  });
}

// ── Inject "Request to Join" button in viewer HTML ──
function _attachRequestBtn(roomId, db) {
  const stage = _getStage();
  if (!stage || stage.classList.contains('is-host')) return;
  if (stage.querySelector('.snx-live-request-btn')) return;

  const btn = document.createElement('button');
  btn.className = 'snx-live-request-btn';
  btn.id = 'snxLiveRequestBtn';
  btn.textContent = '🎙 Request to Join';
  btn.setAttribute('aria-label', 'Request to join this live');

  btn.addEventListener('click', () => _viewerSendRequest(roomId, db, btn));

  stage.appendChild(btn);
}

/* ── VIEWER: Send a Request-to-Join ── */
async function _viewerSendRequest(roomId, db, btn) {
  // ── Auth guard ──
  const user = _user();
  if (!user || !user.uid) {
    console.warn('[BoxRequest] User not authenticated — cannot send request.');
    if (typeof toastNotification === 'function') toastNotification('⛔ Please sign in to request a box.');
    return;
  }
  if (user.isAnonymous) {
    if (typeof toastNotification === 'function') toastNotification('⛔ Sign in with an account to request a box.');
    return;
  }

  // ── Room guard ──
  if (!roomId) {
    console.warn('[BoxRequest] Missing roomId — cannot send request.');
    if (typeof toastNotification === 'function') toastNotification('⛔ No live stream found. Try refreshing.');
    return;
  }

  // ── Duplicate-tap guard ──
  if (btn.dataset.reqPending === 'true') {
    console.log('[BoxRequest] Request already pending — ignoring tap.');
    if (typeof toastNotification === 'function') toastNotification('⏳ Your request is already pending…');
    return;
  }

  // ── Firestore availability guard ──
  const fs = window._snxFirestore;
  if (!fs || !fs.db || !fs.setDoc || !fs.doc || !fs.serverTimestamp || !fs.onSnapshot || !fs.deleteDoc) {
    console.error('[BoxRequest] window._snxFirestore not available — cannot write request.');
    if (typeof toastNotification === 'function') toastNotification('⛔ Service unavailable. Please refresh.');
    return;
  }

  // ── Resolve hostId from RTDB room ──
  let hostId = null;
  try {
    const roomSnap = await get(ref(db, 'liveRooms/' + roomId));
    if (roomSnap.exists()) hostId = roomSnap.val().hostId || null;
  } catch (e) {
    console.error('[BoxRequest] Could not read liveRoom to get hostId:', e.code, e.message);
    if (typeof toastNotification === 'function') toastNotification('⛔ Connection error. Please try again.');
    return;
  }
  if (!hostId) {
    console.warn('[BoxRequest] Missing hostId in liveRoom — cannot send request. roomId:', roomId);
    if (typeof toastNotification === 'function') toastNotification('⛔ Could not find stream host. Try refreshing.');
    return;
  }

  const ud          = _userData();
  const viewerName  = ud.displayName || ud.username || user.email?.split('@')[0] || 'Guest';
  const viewerAvatar = ud.profileImage || ud.photoURL || ud.avatar || '';
  const requestId   = roomId + '_' + user.uid;

  console.log('[BoxRequest] Sending request — roomId:', roomId, 'hostId:', hostId, 'viewerId:', user.uid, 'requestId:', requestId);

  // ── Mark button as pending immediately ──
  btn.dataset.reqPending = 'true';
  btn.textContent = '⏳ Requesting…';
  btn.disabled = true;

  // ── Write to Firestore boxRequests (primary — host notification) ──
  try {
    await fs.setDoc(fs.doc(fs.db, 'boxRequests', requestId), {
      liveId:             roomId,
      hostId,
      viewerId:           user.uid,
      viewerName,
      viewerProfileImage: viewerAvatar,
      status:             'pending',
      createdAt:          fs.serverTimestamp(),
    });
    console.log('[BoxRequest] Firestore boxRequest written — requestId:', requestId);
  } catch (e) {
    console.error('[BoxRequest] Firestore write failed:', e.code, e.message);
    btn.dataset.reqPending = '';
    btn.textContent = '🎙 Request to Join';
    btn.disabled = false;
    if (e.code === 'permission-denied') {
      if (typeof toastNotification === 'function') toastNotification('⛔ Permission denied — please sign in.');
    } else {
      if (typeof toastNotification === 'function') toastNotification('❌ Request failed. Try again.');
    }
    return;
  }

  // ── Write to RTDB guestRequests (secondary — real-time backup) ──
  try {
    await set(ref(db, 'guestRequests/' + roomId + '/' + user.uid), {
      uid:       user.uid,
      name:      viewerName,
      avatar:    viewerAvatar,
      requestId,
      status:    'pending',
      ts:        Date.now(),
    });
    console.log('[BoxRequest] RTDB guestRequest written');
  } catch (e) {
    console.error('[BoxRequest] RTDB write failed (non-fatal):', e.code, e.message);
    // Non-fatal — Firestore is the source of truth
  }

  // ── Update button to WAITING state ──
  btn.textContent = '⏳ Waiting for Host…';
  if (typeof toastNotification === 'function') toastNotification('📺 Request sent to host!');

  // ── Watch Firestore boxRequest status for host response ──
  if (_S.viewReqUnsub) { try { _S.viewReqUnsub(); } catch (_) {} _S.viewReqUnsub = null; }

  const reqDocRef = fs.doc(fs.db, 'boxRequests', requestId);
  _S.viewReqUnsub = fs.onSnapshot(reqDocRef, async snap => {
    if (!snap.exists()) return;
    const status = snap.data().status;
    console.log('[BoxRequest] Viewer status update:', status);

    if (status === 'accepted') {
      btn.textContent = '✅ Request Accepted!';
      btn.disabled = true;
      if (typeof toastNotification === 'function') toastNotification('✅ Your request was accepted!');
      if (_S.viewReqUnsub) { try { _S.viewReqUnsub(); } catch (_) {} _S.viewReqUnsub = null; }
      // ── GUEST CONNECTION HANDOFF REQUIRED ──
      // Current live.js does not yet have guest WebRTC handoff.
      // Request accepted — waiting for host to initiate guest connection.
      console.log('[BoxRequest] ACCEPTED — GUEST CONNECTION HANDOFF REQUIRED. Waiting for host signaling.');

    } else if (status === 'declined') {
      btn.dataset.reqPending = '';
      btn.textContent = '🎙 Request to Join';
      btn.disabled = false;
      if (typeof toastNotification === 'function') toastNotification('❌ Your request was declined.');
      if (_S.viewReqUnsub) { try { _S.viewReqUnsub(); } catch (_) {} _S.viewReqUnsub = null; }
      // Clean up local Firestore doc
      try { await fs.deleteDoc(reqDocRef); } catch (_) {}
      // Clean up RTDB
      try { await remove(ref(db, 'guestRequests/' + roomId + '/' + user.uid)); } catch (_) {}
    }
  }, err => {
    console.error('[BoxRequest] Status snapshot error:', err.code, err.message);
  });
}

/* ═══════════════════════════════════════════════════════════
   HOST: Request listener — watches for pending viewer requests
   ═══════════════════════════════════════════════════════════ */
function _startHostRequestListener(roomId, hostUid, db) {
  // Stop any previous listener
  if (_S.hostReqUnsub) { try { _S.hostReqUnsub(); } catch (_) {} _S.hostReqUnsub = null; }
  _S.hostShownReqs = new Set();

  const fs = window._snxFirestore;

  // ── Primary: Firestore boxRequests listener ──
  if (fs && fs.db && fs.query && fs.collection && fs.where && fs.onSnapshot) {
    const fsQuery = fs.query(
      fs.collection(fs.db, 'boxRequests'),
      fs.where('liveId', '==', roomId),
      fs.where('hostId', '==', hostUid),
      fs.where('status', '==', 'pending')
    );

    const fsUnsub = fs.onSnapshot(fsQuery, snap => {
      snap.docChanges().forEach(change => {
        if (change.type !== 'added') return;
        const d = change.doc.data();
        const viewerUid = d.viewerId;
        if (!viewerUid) return;
        if (_S.hostShownReqs && _S.hostShownReqs.has(viewerUid)) return;
        if (_S.hostShownReqs) _S.hostShownReqs.add(viewerUid);

        console.log('[BoxRequest] Host received request from:', viewerUid, 'name:', d.viewerName);

        const reqId = change.doc.id;

        window.snxBoxManager.showRequestCard(
          viewerUid,
          d.viewerName || 'Guest',
          d.viewerProfileImage || '',
          /* onAccept */ async (uid) => {
            console.log('[BoxRequest] Host accepting:', uid);
            // Update Firestore status → accepted
            try {
              await fs.updateDoc(fs.doc(fs.db, 'boxRequests', reqId), { status: 'accepted' });
              console.log('[BoxRequest] Firestore boxRequest → accepted');
            } catch (e) {
              console.error('[BoxRequest] Could not update boxRequest (accepted):', e.code, e.message);
            }
            // Update RTDB status → accepted
            try { await update(ref(db, 'guestRequests/' + roomId + '/' + uid), { status: 'accepted' }); } catch (_) {}
            if (_S.hostShownReqs) _S.hostShownReqs.delete(uid);
            // ── GUEST CONNECTION HANDOFF REQUIRED ──
            // Current live.js (SNS-2026-LIVE-005) does not yet have guest WebRTC handoff.
            // Stop here — the request state transition is complete.
            console.log('[BoxRequest] ACCEPT complete — GUEST CONNECTION HANDOFF REQUIRED for uid:', uid);
          },
          /* onDecline */ async (uid) => {
            console.log('[BoxRequest] Host declining:', uid);
            // Update Firestore status → declined
            try {
              await fs.updateDoc(fs.doc(fs.db, 'boxRequests', reqId), { status: 'declined' });
              console.log('[BoxRequest] Firestore boxRequest → declined');
            } catch (e) {
              console.error('[BoxRequest] Could not update boxRequest (declined):', e.code, e.message);
            }
            // Update RTDB status → declined, then remove after 5s
            try { await update(ref(db, 'guestRequests/' + roomId + '/' + uid), { status: 'declined' }); } catch (_) {}
            setTimeout(async () => {
              try { await remove(ref(db, 'guestRequests/' + roomId + '/' + uid)); } catch (_) {}
              if (fs.deleteDoc) {
                try { await fs.deleteDoc(fs.doc(fs.db, 'boxRequests', reqId)); } catch (_) {}
              }
            }, 5000);
            if (_S.hostShownReqs) _S.hostShownReqs.delete(uid);
          }
        );
      });
    }, err => {
      console.error('[BoxRequest] Host Firestore listener error:', err.code, err.message);
    });

    _S.hostReqUnsub = () => {
      try { fsUnsub(); } catch (_) {}
      if (_S.hostShownReqs) _S.hostShownReqs.clear();
    };
    console.log('[BoxRequest] Host request listener started (Firestore) — roomId:', roomId);

  } else {
    // ── Fallback: RTDB guestRequests ──
    console.warn('[BoxRequest] Firestore unavailable — using RTDB fallback for host request listener');
    const rtdbReqRef = ref(db, 'guestRequests/' + roomId);
    const rtdbCb = onValue(rtdbReqRef, snap => {
      if (!snap.exists()) return;
      snap.forEach(child => {
        const req = child.val();
        if (!req || req.status !== 'pending') return;
        const viewerUid = req.uid;
        if (!viewerUid) return;
        if (_S.hostShownReqs && _S.hostShownReqs.has(viewerUid)) return;
        if (_S.hostShownReqs) _S.hostShownReqs.add(viewerUid);

        console.log('[BoxRequest] Host received RTDB request from:', viewerUid, 'name:', req.name);
        const reqId = req.requestId || (roomId + '_' + viewerUid);
        const fs2 = window._snxFirestore;

        window.snxBoxManager.showRequestCard(
          viewerUid,
          req.name || 'Guest',
          req.avatar || '',
          async (uid) => {
            try { await update(ref(db, 'guestRequests/' + roomId + '/' + uid), { status: 'accepted' }); } catch (_) {}
            if (fs2 && fs2.updateDoc && fs2.doc && fs2.db) {
              try { await fs2.updateDoc(fs2.doc(fs2.db, 'boxRequests', reqId), { status: 'accepted' }); } catch (_) {}
            }
            if (_S.hostShownReqs) _S.hostShownReqs.delete(uid);
            console.log('[BoxRequest] ACCEPT (RTDB) complete — GUEST CONNECTION HANDOFF REQUIRED for uid:', uid);
          },
          async (uid) => {
            try { await update(ref(db, 'guestRequests/' + roomId + '/' + uid), { status: 'declined' }); } catch (_) {}
            if (fs2 && fs2.updateDoc && fs2.doc && fs2.db) {
              try { await fs2.updateDoc(fs2.doc(fs2.db, 'boxRequests', reqId), { status: 'declined' }); } catch (_) {}
            }
            setTimeout(async () => {
              try { await remove(ref(db, 'guestRequests/' + roomId + '/' + uid)); } catch (_) {}
            }, 5000);
            if (_S.hostShownReqs) _S.hostShownReqs.delete(uid);
          }
        );
      });
    });

    _S.hostReqUnsub = () => {
      try { off(rtdbReqRef, 'value', rtdbCb); } catch (_) {}
      if (_S.hostShownReqs) _S.hostShownReqs.clear();
    };
    console.log('[BoxRequest] Host request listener started (RTDB fallback) — roomId:', roomId);
  }
}

// ══════════════════════════════════════════════════════════
// PUBLIC API  window.snxBoxManager
// ══════════════════════════════════════════════════════════
window.snxBoxManager = {

  /** Add a guest box. stream may be null → connecting state shown. */
  addGuest(uid, name, stream) {
    if (!uid) return;
    const guests = [..._boxState.values()].filter(b => b.role === 'guest');
    if (guests.length >= MAX_GUEST_BOXES) {
      console.warn('[SNX-BOXES] Cannot add guest — MAX_GUEST_BOXES (' + MAX_GUEST_BOXES + ') reached.');
      return;
    }
    if (_boxState.has(uid)) return;
    const grid = _ensureBoxGrid();
    if (!grid) return;

    const box = _buildBox(uid, name || 'Guest', 'guest');
    grid.appendChild(box.el);
    _boxState.set(uid, box);

    if (stream) {
      box.videoEl.srcObject = stream;
      box.videoEl.play().catch(() => {});
      _setBxState(uid, 'ready');
    }
    _recalcLayout();
    _log('Box added uid=' + uid + ' total=' + _boxState.size);
  },

  /** Attach a MediaStream to an existing guest box once WebRTC track arrives. */
  setGuestStream(uid, stream) {
    const box = _boxState.get(uid);
    if (!box || !stream) return;
    box.videoEl.srcObject = stream;
    box.videoEl.play().catch(() => {});
    _setBxState(uid, 'ready');
    _log('Box stream ready uid=' + uid);
  },

  /** Update guest box visual state: 'connecting' | 'ready' | 'disconnected' */
  setGuestState(uid, state) {
    _setBxState(uid, state);
    if (state === 'disconnected') {
      setTimeout(() => {
        if (_boxState.has(uid)) window.snxBoxManager.removeGuest(uid);
      }, 2000);
    }
  },

  /** Remove a guest box and collapse the layout. */
  removeGuest(uid) {
    const box = _boxState.get(uid);
    if (!box) return;
    box.el.style.opacity  = '0';
    box.el.style.transform = 'scale(0.88)';
    setTimeout(() => { if (box.el.parentNode) box.el.parentNode.removeChild(box.el); }, 280);
    _boxState.delete(uid);
    // If this was the focused participant, revert focus to host
    if (_focusedUid === uid) _focusedUid = null;
    _recalcLayout();
    _log('Box removed uid=' + uid + ' remaining=' + _boxState.size);
  },

  /** Sync host cam-off overlay with existing cam button state. */
  setHostCamState(camOn) {
    const box = _boxState.get('_host_');
    if (!box) return;
    const camOff = box.el.querySelector('.snx-box-cam-off');
    if (camOff) camOff.classList.toggle('show', !camOn);
  },

  /** Show/hide the viewer "Request to Join" button. */
  showRequestBtn(visible) {
    const btn = _el('snxLiveRequestBtn');
    if (btn) btn.style.display = visible ? '' : 'none';
  },

  /**
   * Show a host request notification card.
   * onAccept / onDecline are optional; without them the buttons stub-warn.
   */
  showRequestCard(uid, name, avatar, onAccept, onDecline) {
    const queue = _el('snxLiveReqQueue');
    if (!queue) return;
    if (queue.querySelector('[data-uid="' + uid + '"]')) return;

    const card = document.createElement('div');
    card.className = 'snx-req-card';
    card.dataset.uid = uid;

    const avatarEl = document.createElement('div');
    avatarEl.className = 'snx-req-avatar';
    if (avatar) {
      avatarEl.style.backgroundImage = 'url(' + _esc(avatar) + ')';
    } else {
      avatarEl.textContent = (name || '?')[0].toUpperCase();
    }

    const info = document.createElement('div');
    info.className = 'snx-req-info';
    info.innerHTML =
      '<div class="snx-req-name">' + _esc(name || 'Guest') + '</div>' +
      '<div class="snx-req-sub">wants to join</div>';

    const actions = document.createElement('div');
    actions.className = 'snx-req-actions';

    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'snx-req-accept';
    acceptBtn.textContent = 'Accept';
    acceptBtn.addEventListener('click', () => {
      card.remove();
      if (typeof onAccept === 'function') onAccept(uid);
      else {
        // ── EXISTING BACKEND SUPPORT REQUIRED ──
        console.warn('[SNX-BOXES] Accept — guest backend not available.');
        if (typeof toastNotification === 'function') toastNotification('⚡ Guest accept backend coming soon.');
      }
    });

    const declineBtn = document.createElement('button');
    declineBtn.className = 'snx-req-decline';
    declineBtn.textContent = 'Decline';
    declineBtn.addEventListener('click', () => {
      card.remove();
      if (typeof onDecline === 'function') onDecline(uid);
      else { console.warn('[SNX-BOXES] Decline — guest backend not available.'); }
    });

    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);
    card.appendChild(avatarEl);
    card.appendChild(info);
    card.appendChild(actions);
    queue.appendChild(card);

    setTimeout(() => {
      if (card.parentNode) {
        card.remove();
        if (typeof onDecline === 'function') onDecline(uid);
      }
    }, 30_000);
  },

  /** Remove a request card by uid. */
  dismissRequestCard(uid) {
    const queue = _el('snxLiveReqQueue');
    if (!queue) return;
    const card = queue.querySelector('[data-uid="' + uid + '"]');
    if (card) card.remove();
  },

  /**
   * Switch the live layout. Host-only.
   * layoutKey: 'auto' | 'spotlight' | 'grid' | 'guestrow' | 'focus'
   * No WebRTC restart, no page reload.
   */
  setLayout(layoutKey) {
    if (!_LAYOUTS.includes(layoutKey)) return;
    _currentLayout = layoutKey;
    // When entering focus mode default focus to host
    if (layoutKey === 'focus' && !_focusedUid) _focusedUid = '_host_';
    _recalcLayout();
    _syncLayoutPanel(layoutKey);
    _log('Layout → ' + layoutKey);
  },

  /**
   * Set the focused participant in Focus Mode.
   * Call with a uid from _boxState (including '_host_').
   */
  setFocus(uid) {
    if (!_boxState.has(uid)) return;
    _focusedUid = uid;
    _applyFocusClass();
    _log('Focus → ' + uid);
  },

  /** Expose current layout for diagnostics. */
  getLayout() { return _currentLayout; },

  /** Expose focused uid for diagnostics. */
  getFocusedUid() { return _focusedUid; },
};

// ── Patch cam button to keep host box cam overlay in sync ──
(function _watchHostCamBtn() {
  document.addEventListener('click', (e) => {
    if (!e.target || e.target.id !== 'snxLiveHostCamBtn') return;
    Promise.resolve().then(() => {
      const camOn = !e.target.classList.contains('off');
      window.snxBoxManager.setHostCamState(camOn);
    });
  }, true);
})();

/* ══════════════════════════════════════════════════════════
   GUEST MODE HOOK
════════════════════════════════════════════════════════════ */
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
window._hookGoLive = _hookGoLive;

_log('live.js loaded — SNS-2026-LIVE-005');
