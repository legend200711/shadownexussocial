/**
 * SNX CREATOR LIVE — Orchestration Layer
 * snx-creator-live.js
 *
 * Connects Creator Channels (snx-creator-channels.js) to the existing
 * Shadow Nexus Live WebRTC engine (live.js / live.html).
 *
 * Architecture:
 *   - Each Creator Channel GO LIVE gets a unique RTDB roomId AND a Firestore
 *     liveSessions/{liveId} document.  Both are per-creator so simultaneous
 *     broadcasts never collide.
 *   - The existing live.js engine handles ALL WebRTC: camera, mic, signaling,
 *     viewer connections, chat, reconnect, adaptive quality.  We DO NOT rebuild it.
 *   - We drive it by opening a dedicated creator-live viewer in channel.html itself
 *     (no page navigation) — the live stage renders inside #snx-tn-wrapper.
 *   - For the HOST we call the live engine via postMessage / a shared RTDB room.
 *   - For VIEWERS we render the live stage inside channel.html directly.
 *
 * RTDB room key format (mirrors live.js):
 *   {safeUid}_{timestamp36}   e.g. "abc123_m7z4k9"
 *
 * Firestore liveSessions/{liveId} stores:
 *   liveId, hostUid, channelId, title, status,
 *   rtdbRoomId,           ← the RTDB key viewers need to connect
 *   startedAt, endedAt, viewerCount
 *
 * Heartbeat:
 *   Host writes liveRooms/{rtdbRoomId}/hostHb (timestamp) every 15 s.
 *   A stale heartbeat (>45 s) means the host disconnected unexpectedly.
 *   We use RTDB onDisconnect to mark the room ended if the host drops.
 *
 * Chat:
 *   Each live uses its own Firestore path:
 *   liveRooms/{rtdbRoomId}/liveMessages  (same path live.js already uses)
 *   → already isolated per room, per creator, per session.
 */

import {
  initializeApp, getApps, getApp,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, limit,
  onSnapshot, serverTimestamp, increment,
  initializeFirestore, memoryLocalCache,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import {
  getDatabase,
  ref, set, get, update, remove, push, onDisconnect, onValue, off,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ══════════════════════════════════════════════════════════════
   FIREBASE — SNS project (horr-a08f4)
   Reuse existing [DEFAULT] app already initialised by channel.html
══════════════════════════════════════════════════════════════ */
const _snsCfg = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};
const _app    = getApps().find(a => a.name === '[DEFAULT]') || initializeApp(_snsCfg);

// Initialise Firestore with memory cache if we are first; fall back to
// getFirestore() if index.html or snx-creator-channels.js already did it.
let db;
try {
  db = initializeFirestore(_app, { localCache: memoryLocalCache() });
} catch (_initErr) {
  db = getFirestore(_app);
}
export { db };
export const liveDB = getDatabase(_app);

/* ══════════════════════════════════════════════════════════════
   ICE SERVERS (mirrors live.js)
══════════════════════════════════════════════════════════════ */
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

/* ══════════════════════════════════════════════════════════════
   HOST STATE
══════════════════════════════════════════════════════════════ */
let _hostState = null;  // null when not live
// peakViewers is tracked here and written to liveSessions on endCreatorBroadcast
// _hostState shape:
// { uid, liveId, rtdbRoomId, localStream, camOn, micOn, facingMode,
//   heartbeatInterval, viewerPeers:{uid->{pc,appliedCandKeys}},
//   signalUnsub, viewerCountUnsub, roomWatchRef,
//   endedFlag, notifSentFlag }

/* ══════════════════════════════════════════════════════════════
   VIEWER STATE
══════════════════════════════════════════════════════════════ */
let _viewerState = null;
// _viewerState shape:
// { uid, liveId, rtdbRoomId, rtcPc, signalUnsub, chatUnsub,
//   roomWatchRef, presRef, hbInterval, leftFlag, reconnectTimer,
//   reconnectAttempt, frozenInterval }

/* ══════════════════════════════════════════════════════════════
   EXPORTED: HOST — SETUP SCREEN
   Opens the setup UI inside the provided container element.
   Does NOT start broadcasting until the user taps GO LIVE.
══════════════════════════════════════════════════════════════ */
export async function openCreatorSetup(user, userData, container, onDone) {
  if (!user || !container) return;

  // Release any leftover stream from a previous session
  if (_hostState?.localStream) {
    _hostState.localStream.getTracks().forEach(t => t.stop());
  }

  container.innerHTML = _buildSetupHTML(userData);

  const previewVideo = container.querySelector('#crl-setup-preview');
  const previewOff   = container.querySelector('#crl-setup-preview-off');
  const titleInput   = container.querySelector('#crl-setup-title');
  const camBtn       = container.querySelector('#crl-setup-cam-btn');
  const micBtn       = container.querySelector('#crl-setup-mic-btn');
  const flipBtn      = container.querySelector('#crl-setup-flip-btn');
  const goLiveBtn    = container.querySelector('#crl-go-live-btn');
  const cancelBtn    = container.querySelector('#crl-setup-cancel');
  const errEl        = container.querySelector('#crl-setup-err');

  let localStream = null;
  let camOn       = true;
  let micOn       = true;
  let facingMode  = 'user';

  async function acquireStream(facing) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      return s;
    } catch (_) {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      } catch (_) { return null; }
    }
  }

  function updatePreviewState(hasVideo) {
    if (previewVideo) previewVideo.style.display = hasVideo ? 'block' : 'none';
    if (previewOff)   previewOff.style.display   = hasVideo ? 'none'  : 'flex';
  }

  // Acquire initial stream
  localStream = await acquireStream(facingMode);
  if (!localStream) {
    if (errEl) errEl.textContent = 'Camera & mic access denied. Please allow access in browser settings, then retry.';
    updatePreviewState(false);
    if (goLiveBtn) goLiveBtn.disabled = true;
  } else {
    const hasVideo = localStream.getVideoTracks().length > 0;
    if (previewVideo) {
      previewVideo.srcObject = localStream;
      previewVideo.play().catch(() => {});
    }
    updatePreviewState(hasVideo);
  }

  // Camera toggle
  camBtn?.addEventListener('click', () => {
    camOn = !camOn;
    if (localStream) localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    updatePreviewState(camOn && !!(localStream?.getVideoTracks().length));
    camBtn.classList.toggle('crl-btn-off', !camOn);
    camBtn.querySelector('.crl-ctrl-label').textContent = camOn ? 'Camera' : 'Cam Off';
  });

  // Mic toggle
  micBtn?.addEventListener('click', () => {
    micOn = !micOn;
    if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    micBtn.classList.toggle('crl-btn-off', !micOn);
    micBtn.querySelector('.crl-ctrl-label').textContent = micOn ? 'Mic' : 'Mic Off';
    micBtn.querySelector('.crl-ctrl-icon').textContent = micOn ? '🎤' : '🔇';
  });

  // Flip camera
  flipBtn?.addEventListener('click', async () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = await acquireStream(facingMode);
    if (!localStream) return;
    if (previewVideo) { previewVideo.srcObject = localStream; previewVideo.play().catch(() => {}); }
    updatePreviewState(localStream.getVideoTracks().length > 0);
  });

  // Cancel
  cancelBtn?.addEventListener('click', () => {
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    container.innerHTML = '';
    onDone?.({ action: 'cancelled' });
  });

  // GO LIVE
  goLiveBtn?.addEventListener('click', async () => {
    if (!localStream) { if (errEl) errEl.textContent = 'Camera/mic required.'; return; }
    const title = (titleInput?.value || '').trim() || `${userData?.displayName || 'Creator'}'s Live`;
    goLiveBtn.disabled = true;
    goLiveBtn.textContent = 'Starting…';
    if (errEl) errEl.textContent = '';

    // Stop preview before handing stream to broadcast
    if (previewVideo) { previewVideo.srcObject = null; }

    onDone?.({ action: 'go_live', localStream, camOn, micOn, facingMode, title });
  });
}

/* ══════════════════════════════════════════════════════════════
   EXPORTED: HOST — START BROADCAST
   Called after setup confirms GO LIVE.
   Returns liveId on success, throws on failure.

   10-STEP DIAGNOSTIC SEQUENCE:
     STEP 1  AUTH USER         — verify UID consistency
     STEP 2  CREATE liveSessions
     STEP 3  SET liveId
     STEP 4  CREATE RTDB ROOM
     STEP 5  onDisconnect
     STEP 6  UPDATE creatorChannels  ← REQUIRED before declaring LIVE
     STEP 7  HOST PRESENCE
     STEP 8  WEBRTC START
     STEP 9  VIEWER COUNT
     STEP 10 HEARTBEAT

   Only after all required steps pass is 🔴 YOU ARE LIVE displayed.
   On any failure a full rollback is performed (no ghost sessions).
══════════════════════════════════════════════════════════════ */
export async function startCreatorBroadcast(user, userData, opts = {}) {
  // ── AUTH CONSISTENCY CHECK ──────────────────────────────────────────────
  // window._snxCurrentUser is the canonical SNS auth reference.
  // If there is a mismatch between caller uid and window._snxCurrentUser,
  // abort to prevent ghost records under a stale UID.
  const _canonicalUser = window._snxCurrentUser || null;
  if (_canonicalUser && _canonicalUser.uid !== user.uid) {
    const _msg = `[SNX LIVE] STEP 1 AUTH USER — UID MISMATCH: caller=${user.uid} canonical=${_canonicalUser.uid}`;
    console.error(_msg);
    throw new Error('Auth UID mismatch — please reload and sign in again.');
  }

  console.log('[SNX LIVE] STEP 1 AUTH USER — uid:', user.uid, 'email:', user.email);

  if (!user) throw new Error('Not authenticated');
  if (_hostState && !_hostState.endedFlag) throw new Error('Already live');

  const { localStream, camOn = true, micOn = true, facingMode = 'user', title = 'Live Broadcast' } = opts;
  if (!localStream || !localStream.getTracks().length) throw new Error('No media stream');

  // Generate unique RTDB room key (same format as live.js)
  const safeUid    = user.uid.replace(/[.#$/[\]]/g, '_');
  const rtdbRoomId = `${safeUid}_${Date.now().toString(36)}`;

  // Track partial state for rollback
  let _sessionRef     = null;
  let _liveId         = null;
  let _rtdbWritten    = false;
  let _channelWritten = false;

  try {
    // ── STEP 2: CREATE liveSessions ─────────────────────────────────────
    console.log('[SNX LIVE] STEP 2 CREATE liveSessions — rtdbRoomId:', rtdbRoomId);
    _sessionRef = await addDoc(collection(db, 'liveSessions'), {
      liveId:      '',
      hostUid:     user.uid,
      channelId:   user.uid,
      title,
      status:      'live',
      rtdbRoomId,
      startedAt:   serverTimestamp(),
      endedAt:     null,
      viewerCount: 0,
      peakViewers: 0,
      streamInfo:  null,
      featuredOnMainTv: false,
    });

    // ── STEP 3: SET liveId ──────────────────────────────────────────────
    _liveId = _sessionRef.id;
    console.log('[SNX LIVE] STEP 3 SET liveId — liveId:', _liveId);
    await updateDoc(_sessionRef, { liveId: _liveId });

    // ── STEP 4: CREATE RTDB ROOM ────────────────────────────────────────
    const roomData = {
      roomId:       rtdbRoomId,
      hostId:       user.uid,
      hostName:     userData?.displayName || user.email?.split('@')[0] || 'Creator',
      hostUsername: userData?.username || '',
      hostAvatar:   userData?.avatar || userData?.profilePicture || '',
      title,
      status:       'live',
      isLive:       true,
      viewers:      0,
      likes:        0,
      createdAt:    Date.now(),
      liveId:       _liveId,
      channelId:    user.uid,
    };
    console.log('[SNX LIVE] STEP 4 CREATE RTDB ROOM — liveRooms/', rtdbRoomId);
    await set(ref(liveDB, `liveRooms/${rtdbRoomId}`), roomData);
    _rtdbWritten = true;

    // ── STEP 5: onDisconnect ────────────────────────────────────────────
    console.log('[SNX LIVE] STEP 5 onDisconnect — registering for:', rtdbRoomId);
    await onDisconnect(ref(liveDB, `liveRooms/${rtdbRoomId}`)).update({
      status: 'ended', isLive: false, endedAt: Date.now(),
    });

    // ── STEP 6: UPDATE creatorChannels ──────────────────────────────────
    // CRITICAL: This MUST succeed before we declare the host LIVE.
    // A live broadcast is NOT registered on the platform until this write
    // completes — only then will it appear in Live Now / Creator Channel.
    console.log('[SNX LIVE] STEP 6 UPDATE creatorChannels — uid:', user.uid);
    await updateDoc(doc(db, 'creatorChannels', user.uid), {
      status:           'live',
      currentLiveId:    _liveId,
      currentStartedAt: serverTimestamp(),
      updatedAt:        serverTimestamp(),
    });
    _channelWritten = true;
    console.log('[SNX LIVE] STEP 6 creatorChannels — WRITE CONFIRMED ✓  status=live  currentLiveId=' + _liveId);

    // ── STEP 7: HOST PRESENCE ───────────────────────────────────────────
    console.log('[SNX LIVE] STEP 7 HOST PRESENCE — liveGuests/', rtdbRoomId, '/_host_');
    await set(ref(liveDB, `liveGuests/${rtdbRoomId}/_host_`), {
      uid: user.uid, name: roomData.hostName, avatar: roomData.hostAvatar,
      isHost: true, camOn, micOn, joinedAt: Date.now(), hb: Date.now(),
    });
    onDisconnect(ref(liveDB, `liveGuests/${rtdbRoomId}`)).remove().catch(() => {});

    // Send live notifications to channel followers (non-critical — fire-and-forget)
    _sendLiveNotifications(user.uid, _liveId, rtdbRoomId, title, roomData).catch(() => {});

    // Build host state ONLY after all required writes succeed
    _hostState = {
      uid: user.uid, liveId: _liveId, rtdbRoomId, localStream, camOn, micOn, facingMode,
      roomData, userData,
      viewerPeers: {}, signalUnsub: null, viewerCountUnsub: null,
      roomWatchRef: null, heartbeatInterval: null,
      endedFlag: false, notifSentFlag: true,
      peakViewers: 0,   // tracked by _hostSubscribeViewerCount, written on end
    };

    // ── STEP 8: WEBRTC START ────────────────────────────────────────────
    console.log('[SNX LIVE] STEP 8 WEBRTC START');
    _hostStartWebRTC();

    // ── STEP 9: VIEWER COUNT ────────────────────────────────────────────
    console.log('[SNX LIVE] STEP 9 VIEWER COUNT — subscribing');
    _hostSubscribeViewerCount();

    // ── STEP 10: HEARTBEAT ──────────────────────────────────────────────
    console.log('[SNX LIVE] STEP 10 HEARTBEAT — starting 15s interval');
    _hostState.heartbeatInterval = setInterval(() => {
      if (_hostState?.endedFlag) return;
      set(ref(liveDB, `liveRooms/${rtdbRoomId}/hostHb`), Date.now()).catch(() => {});
    }, 15000);

    document.addEventListener('visibilitychange', _hostOnVisibilityChange);

    console.log('[SNX LIVE] 🔴 ALL STEPS COMPLETE — host is LIVE. liveId:', _liveId, ' rtdbRoomId:', rtdbRoomId);
    return _liveId;

  } catch (_startErr) {
    // ── STARTUP ROLLBACK ────────────────────────────────────────────────
    // Surface the exact failure so it is NEVER silently swallowed.
    console.error('[SNX LIVE] ❌ STARTUP FAILED — rolling back partial state.', _startErr);

    // Stop camera/mic immediately — broadcast cannot proceed
    if (localStream) {
      try { localStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }

    // Cancel any onDisconnect that was registered and clean up RTDB
    if (_rtdbWritten) {
      try { onDisconnect(ref(liveDB, `liveRooms/${rtdbRoomId}`)).cancel().catch(() => {}); } catch (_) {}
      try { await update(ref(liveDB, `liveRooms/${rtdbRoomId}`), { status: 'ended', isLive: false, endedAt: Date.now() }); } catch (_) {}
      setTimeout(() => remove(ref(liveDB, `liveRooms/${rtdbRoomId}`)).catch(() => {}), 2000);
      try { remove(ref(liveDB, `liveGuests/${rtdbRoomId}`)).catch(() => {}); } catch (_) {}
      try { remove(ref(liveDB, `liveConnections/${rtdbRoomId}`)).catch(() => {}); } catch (_) {}
    }

    // Mark liveSessions failed / delete it so no ghost session remains
    if (_sessionRef) {
      try {
        await updateDoc(_sessionRef, { status: 'failed', endedAt: serverTimestamp() });
      } catch (_) {
        try { await deleteDoc(_sessionRef); } catch (_) {}
      }
    }

    // Return creatorChannels to offline only if we managed to write it
    if (_channelWritten) {
      try {
        await updateDoc(doc(db, 'creatorChannels', user.uid), {
          status: 'offline', currentLiveId: null, currentStartedAt: null, updatedAt: serverTimestamp(),
        });
      } catch (_rollbackErr) {
        console.error('[SNX LIVE] ROLLBACK creatorChannels ALSO FAILED:', _rollbackErr);
      }
    }

    // Clear any partial host state
    _hostState = null;

    // Re-throw the real error so _wireHostStage displays the exact message
    throw _startErr;
  }
}

/* ══════════════════════════════════════════════════════════════
   HOST — WebRTC: listen for viewers
══════════════════════════════════════════════════════════════ */
function _hostStartWebRTC() {
  if (!_hostState) return;
  const { rtdbRoomId } = _hostState;
  const viewersRef = ref(liveDB, `liveConnections/${rtdbRoomId}/viewers`);

  if (_hostState.signalUnsub) { try { _hostState.signalUnsub(); } catch (_) {} }

  _hostState.signalUnsub = onValue(viewersRef, async snap => {
    if (!_hostState || _hostState.endedFlag) return;
    if (!snap.exists()) return;
    const viewers = snap.val() || {};
    for (const [viewerUid, viewerData] of Object.entries(viewers)) {
      if (!viewerData || _hostState.viewerPeers[viewerUid]) continue;
      await _hostCreateViewerPeer(viewerUid).catch(err => {
        console.warn('[SNX LIVE] Failed to create viewer peer for', viewerUid, err);
      });
    }
  });
}

async function _hostCreateViewerPeer(viewerUid) {
  if (!_hostState) return;
  const { rtdbRoomId, liveId, localStream } = _hostState;

  const pc = new RTCPeerConnection(ICE);
  _hostState.viewerPeers[viewerUid] = { pc, appliedCandKeys: new Set() };

  // Add all tracks from local stream
  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = e => {
    if (!e.candidate) return;
    const candRef = ref(liveDB, `liveConnections/${rtdbRoomId}/hostCandidates/${viewerUid}/${Date.now()}`);
    set(candRef, e.candidate.toJSON()).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed' || s === 'disconnected' || s === 'closed') {
      _hostRebuildViewerPeer(viewerUid);
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      try { pc.restartIce(); } catch (_) {}
    }
  };

  // Read viewer offer
  const offerRef  = ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${viewerUid}/offer`);
  const offerSnap = await get(offerRef);
  if (!offerSnap.exists()) { _hostTeardownViewerPeer(viewerUid); return; }

  await pc.setRemoteDescription(new RTCSessionDescription(offerSnap.val()));

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  const answerRef = ref(liveDB, `liveConnections/${rtdbRoomId}/answers/${viewerUid}`);
  await set(answerRef, { type: answer.type, sdp: answer.sdp });

  // Subscribe to viewer ICE candidates
  const vCandRef = ref(liveDB, `liveConnections/${rtdbRoomId}/viewerCandidates/${viewerUid}`);
  onValue(vCandRef, snap => {
    if (!snap.exists()) return;
    const cands = snap.val() || {};
    for (const [key, cand] of Object.entries(cands)) {
      if (_hostState?.viewerPeers[viewerUid]?.appliedCandKeys?.has(key)) continue;
      _hostState?.viewerPeers[viewerUid]?.appliedCandKeys?.add(key);
      pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
    }
  });
}

function _hostRebuildViewerPeer(viewerUid) {
  if (!_hostState || _hostState.endedFlag) return;
  _hostTeardownViewerPeer(viewerUid);
  setTimeout(() => {
    if (_hostState && !_hostState.endedFlag) _hostCreateViewerPeer(viewerUid).catch(() => {});
  }, 2000);
}

function _hostTeardownViewerPeer(viewerUid) {
  if (!_hostState) return;
  const peer = _hostState.viewerPeers[viewerUid];
  if (!peer) return;
  try { peer.pc.close(); } catch (_) {}
  delete _hostState.viewerPeers[viewerUid];
}

function _hostTeardownAllViewerPeers() {
  if (!_hostState) return;
  for (const uid of Object.keys(_hostState.viewerPeers)) {
    _hostTeardownViewerPeer(uid);
  }
}

function _hostSubscribeViewerCount() {
  if (!_hostState) return;
  const { rtdbRoomId, liveId } = _hostState;
  const presRef = ref(liveDB, `liveRooms/${rtdbRoomId}/viewerPresence`);
  let lastMirror = -1;
  _hostState.viewerCountUnsub = onValue(presRef, snap => {
    const v = snap.exists() ? Object.keys(snap.val() || {}).length : 0;
    set(ref(liveDB, `liveRooms/${rtdbRoomId}/viewers`), v).catch(() => {});
    if (v !== lastMirror) {
      lastMirror = v;
      // Track peak viewer count in _hostState for recording on end
      if (v > (_hostState.peakViewers || 0)) _hostState.peakViewers = v;
      updateDoc(doc(db, 'liveSessions', liveId), {
        viewerCount: v,
        peakViewers: _hostState.peakViewers,
      }).catch(() => {});
    }
    // Dispatch event so the host UI can update
    window.dispatchEvent(new CustomEvent('crl:viewerCount', { detail: { count: v, liveId } }));
  });
}

/* ══════════════════════════════════════════════════════════════
   HOST — camera/mic controls
══════════════════════════════════════════════════════════════ */
export function toggleHostCam() {
  if (!_hostState) return;
  _hostState.camOn = !_hostState.camOn;
  _hostState.localStream.getVideoTracks().forEach(t => t.enabled = _hostState.camOn);
  update(ref(liveDB, `liveGuests/${_hostState.rtdbRoomId}/_host_`), { camOn: _hostState.camOn }).catch(() => {});
  window.dispatchEvent(new CustomEvent('crl:camToggle', { detail: { camOn: _hostState.camOn } }));
}

export function toggleHostMic() {
  if (!_hostState) return;
  _hostState.micOn = !_hostState.micOn;
  _hostState.localStream.getAudioTracks().forEach(t => t.enabled = _hostState.micOn);
  update(ref(liveDB, `liveGuests/${_hostState.rtdbRoomId}/_host_`), { micOn: _hostState.micOn }).catch(() => {});
  window.dispatchEvent(new CustomEvent('crl:micToggle', { detail: { micOn: _hostState.micOn } }));
}

export async function flipHostCamera() {
  if (!_hostState) return;
  _hostState.facingMode = _hostState.facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _hostState.localStream;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _hostState.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    _hostState.localStream = newStream;
    // Replace tracks in all viewer peers
    const newVid = newStream.getVideoTracks()[0];
    const newAud = newStream.getAudioTracks()[0];
    for (const { pc } of Object.values(_hostState.viewerPeers)) {
      if (newVid) { const s = pc.getSenders().find(s => s.track?.kind === 'video'); if (s) s.replaceTrack(newVid).catch(() => {}); }
      if (newAud) { const s = pc.getSenders().find(s => s.track?.kind === 'audio'); if (s) s.replaceTrack(newAud).catch(() => {}); }
    }
    if (oldStream) oldStream.getTracks().forEach(t => t.stop());
    window.dispatchEvent(new CustomEvent('crl:streamFlipped', { detail: { stream: newStream } }));
  } catch (_) {}
}

async function _hostOnVisibilityChange() {
  if (document.visibilityState !== 'visible' || !_hostState || _hostState.endedFlag) return;
  const tracks = _hostState.localStream?.getVideoTracks() || [];
  if (tracks.length && tracks.every(t => t.readyState === 'live')) return;
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _hostState.facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (_hostState.localStream) _hostState.localStream.getTracks().forEach(t => t.stop());
    _hostState.localStream = fresh;
    const newVid = fresh.getVideoTracks()[0];
    const newAud = fresh.getAudioTracks()[0];
    for (const { pc } of Object.values(_hostState.viewerPeers)) {
      if (newVid) { const s = pc.getSenders().find(s => s.track?.kind === 'video'); if (s) s.replaceTrack(newVid).catch(() => {}); }
      if (newAud) { const s = pc.getSenders().find(s => s.track?.kind === 'audio'); if (s) s.replaceTrack(newAud).catch(() => {}); }
    }
    window.dispatchEvent(new CustomEvent('crl:streamRestored', { detail: { stream: fresh } }));
  } catch (_) {}
}

/* ══════════════════════════════════════════════════════════════
   EXPORTED: HOST — END BROADCAST
══════════════════════════════════════════════════════════════ */
export async function endCreatorBroadcast(uid) {
  if (!_hostState || _hostState.endedFlag) return;
  _hostState.endedFlag = true;

  const { liveId, rtdbRoomId } = _hostState;
  console.log('[SNX LIVE] endCreatorBroadcast — liveId:', liveId, ' rtdbRoomId:', rtdbRoomId);

  // Cancel onDisconnect triggers
  onDisconnect(ref(liveDB, `liveRooms/${rtdbRoomId}`)).cancel().catch(() => {});

  // Stop heartbeat
  if (_hostState.heartbeatInterval) { clearInterval(_hostState.heartbeatInterval); _hostState.heartbeatInterval = null; }

  // Teardown WebRTC
  _hostTeardownAllViewerPeers();

  // Stop viewer count listener
  if (_hostState.viewerCountUnsub) { try { _hostState.viewerCountUnsub(); } catch (_) {} }

  // Stop camera/mic tracks
  if (_hostState.localStream) {
    _hostState.localStream.getTracks().forEach(t => t.stop());
    _hostState.localStream = null;
  }

  // Remove camera recovery listener
  document.removeEventListener('visibilitychange', _hostOnVisibilityChange);

  // Mark RTDB room ended — expose failure
  try {
    await update(ref(liveDB, `liveRooms/${rtdbRoomId}`), { status: 'ended', isLive: false, endedAt: Date.now() });
  } catch (_rtdbEndErr) {
    console.error('[SNX LIVE] endCreatorBroadcast — RTDB room mark-ended FAILED:', _rtdbEndErr);
  }

  // Cleanup RTDB signaling
  await remove(ref(liveDB, `liveConnections/${rtdbRoomId}`)).catch(() => {});
  await remove(ref(liveDB, `liveGuests/${rtdbRoomId}`)).catch(() => {});

  // Schedule RTDB room removal after 5 min
  setTimeout(() => remove(ref(liveDB, `liveRooms/${rtdbRoomId}`)).catch(() => {}), 5 * 60 * 1000);

  // Mark Firestore liveSessions doc ended — CRITICAL: expose failure
  const peakViewers = _hostState?.peakViewers || 0;
  try {
    await updateDoc(doc(db, 'liveSessions', liveId), {
      status: 'ended', endedAt: serverTimestamp(),
      peakViewers,
    });
    console.log('[SNX LIVE] endCreatorBroadcast — liveSessions marked ended ✓');
  } catch (_sessionEndErr) {
    console.error('[SNX LIVE] endCreatorBroadcast — liveSessions mark-ended FAILED:', _sessionEndErr);
  }

  // Return creator channel to offline — CRITICAL: expose failure
  try {
    await updateDoc(doc(db, 'creatorChannels', uid), {
      status: 'offline', currentLiveId: null, currentStartedAt: null, updatedAt: serverTimestamp(),
    });
    console.log('[SNX LIVE] endCreatorBroadcast — creatorChannels set offline ✓');
  } catch (_channelEndErr) {
    console.error('[SNX LIVE] endCreatorBroadcast — creatorChannels set-offline FAILED:', _channelEndErr);
  }

  const finalPeak = peakViewers;
  _hostState = null;
  window.dispatchEvent(new CustomEvent('crl:ended', { detail: { liveId, peakViewers: finalPeak } }));
  console.log('[SNX LIVE] endCreatorBroadcast — ⚫ broadcast ended. liveId:', liveId);
}

/* ══════════════════════════════════════════════════════════════
   EXPORTED: HOST — current stream (for attaching to video el)
══════════════════════════════════════════════════════════════ */
export function getHostStream() { return _hostState?.localStream || null; }
export function getHostState()  { return _hostState; }

/* ══════════════════════════════════════════════════════════════
   EXPORTED: VIEWER — join an active creator live
══════════════════════════════════════════════════════════════ */
export async function joinCreatorLive(user, liveId, videoEl, onEvent) {
  if (_viewerState && !_viewerState.leftFlag) await leaveCreatorLive();

  // Resolve liveId → rtdbRoomId.
  // Two cases:
  //   A) liveId is a liveSessions doc ID (overlay path via snx-creator-live.js)
  //   B) liveId IS the rtdbRoomId directly (live.html bridge path — currentLiveId = rtdbRoomId)
  let rtdbRoomId = null;
  let roomData = null;

  // Try case A first: look up liveSessions
  const sessionSnap = await getDoc(doc(db, 'liveSessions', liveId)).catch(() => null);
  if (sessionSnap && sessionSnap.exists()) {
    const sessionData = sessionSnap.data();
    if (sessionData.status !== 'live') throw new Error('This live has ended');
    rtdbRoomId = sessionData.rtdbRoomId;
    if (!rtdbRoomId) throw new Error('No RTDB room id in session');
  } else {
    // Case B: liveId may be the rtdbRoomId itself
    rtdbRoomId = liveId;
  }

  // Check RTDB room is still live
  const roomSnap = await get(ref(liveDB, `liveRooms/${rtdbRoomId}`));
  if (!roomSnap.exists()) throw new Error('Live room not found in RTDB');
  roomData = roomSnap.val();
  if (!roomData.isLive) throw new Error('Live room is no longer active');

  _viewerState = {
    uid: user.uid, liveId, rtdbRoomId, rtcPc: null,
    signalUnsub: null, chatUnsub: null,
    roomWatchRef: null, presRef: null,
    hbInterval: null, leftFlag: false,
    reconnectTimer: null, reconnectAttempt: 0,
    frozenInterval: null,
  };

  // Write viewer presence
  const presRef = ref(liveDB, `liveRooms/${rtdbRoomId}/viewerPresence/${user.uid}`);
  _viewerState.presRef = presRef;
  await set(presRef, { uid: user.uid, joinedAt: Date.now(), hb: Date.now() }).catch(() => {});
  onDisconnect(presRef).remove().catch(() => {});

  // Heartbeat every 20 s
  _viewerState.hbInterval = setInterval(() => {
    if (_viewerState?.leftFlag) return;
    set(presRef, { uid: user.uid, joinedAt: Date.now(), hb: Date.now() }).catch(() => {});
  }, 20000);

  // Watch for room ending
  _viewerState.roomWatchRef = ref(liveDB, `liveRooms/${rtdbRoomId}/status`);
  onValue(_viewerState.roomWatchRef, snap => {
    if (snap.val() === 'ended' && !_viewerState?.leftFlag) {
      onEvent?.({ type: 'ended' });
    }
  });

  // Start WebRTC
  await _viewerStartWebRTC(roomData, onEvent);
  // Subscribe to chat
  _viewerSubscribeChat(rtdbRoomId, user.uid, onEvent);

  return rtdbRoomId;
}

async function _viewerStartWebRTC(roomData, onEvent) {
  if (!_viewerState) return;
  const { uid, rtdbRoomId } = _viewerState;

  const pc = new RTCPeerConnection(ICE);
  _viewerState.rtcPc = pc;

  pc.ontrack = e => {
    if (e.streams?.[0]) onEvent?.({ type: 'stream', stream: e.streams[0] });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    onEvent?.({ type: 'connState', state: s });
    if (s === 'failed' || s === 'disconnected') {
      _viewerScheduleReconnect(roomData, onEvent);
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      try { pc.restartIce(); } catch (_) {}
    }
  };

  pc.onicecandidate = e => {
    if (!e.candidate) return;
    const key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    set(ref(liveDB, `liveConnections/${rtdbRoomId}/viewerCandidates/${uid}/${key}`), e.candidate.toJSON()).catch(() => {});
  };

  // Create offer
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);

  // Write offer to RTDB
  await set(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${uid}/offer`), { type: offer.type, sdp: offer.sdp });

  // Wait for answer
  const answerRef = ref(liveDB, `liveConnections/${rtdbRoomId}/answers/${uid}`);
  const appliedHostCandKeys = new Set();

  const answerUnsub = onValue(answerRef, async snap => {
    if (!snap.exists() || !_viewerState || _viewerState.leftFlag) return;
    if (pc.remoteDescription) return; // already applied
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(snap.val()));
    } catch (_) {}
  });

  // Subscribe to host ICE candidates
  const hCandRef = ref(liveDB, `liveConnections/${rtdbRoomId}/hostCandidates/${uid}`);
  const hCandUnsub = onValue(hCandRef, snap => {
    if (!snap.exists()) return;
    const cands = snap.val() || {};
    for (const [key, cand] of Object.entries(cands)) {
      if (appliedHostCandKeys.has(key)) continue;
      appliedHostCandKeys.add(key);
      if (pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      }
    }
  });

  _viewerState.signalUnsub = () => { try { answerUnsub(); } catch (_) {} try { hCandUnsub(); } catch (_) {} };
}

function _viewerScheduleReconnect(roomData, onEvent) {
  if (!_viewerState || _viewerState.leftFlag) return;
  if (_viewerState.reconnectTimer) return;
  _viewerState.reconnectAttempt = (_viewerState.reconnectAttempt || 0) + 1;
  const delay = Math.min(2000 * _viewerState.reconnectAttempt, 15000);
  onEvent?.({ type: 'reconnecting', attempt: _viewerState.reconnectAttempt });
  _viewerState.reconnectTimer = setTimeout(async () => {
    _viewerState.reconnectTimer = null;
    if (!_viewerState || _viewerState.leftFlag) return;
    if (_viewerState.rtcPc) { try { _viewerState.rtcPc.close(); } catch (_) {} _viewerState.rtcPc = null; }
    if (_viewerState.signalUnsub) { try { _viewerState.signalUnsub(); } catch (_) {} _viewerState.signalUnsub = null; }
    await _viewerStartWebRTC(roomData, onEvent).catch(() => {});
  }, delay);
}

function _viewerSubscribeChat(rtdbRoomId, callerUid, onEvent) {
  if (!_viewerState) return;
  // Chat is stored in Firestore: liveRooms/{rtdbRoomId}/liveMessages
  // We use a dynamic import to avoid a hard dependency on Firestore chat helpers here
  import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js').then(({ onSnapshot, collection: col, query: q, orderBy: ob, limit: lim }) => {
    const chatQ = q(col(db, 'liveRooms', rtdbRoomId, 'liveMessages'), ob('createdAt', 'asc'), lim(80));
    const unsub = onSnapshot(chatQ, snap => {
      snap.docChanges().forEach(ch => {
        if (ch.type === 'added') onEvent?.({ type: 'chat', msg: ch.doc.data() });
      });
    });
    if (_viewerState) _viewerState.chatUnsub = unsub;
  }).catch(() => {});
}

export async function sendViewerChat(user, userData, text) {
  if (!_viewerState || _viewerState.leftFlag) return;
  const { rtdbRoomId } = _viewerState;
  const { addDoc: ad, collection: col, serverTimestamp: sts } =
    await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
  await ad(col(db, 'liveRooms', rtdbRoomId, 'liveMessages'), {
    uid: user.uid, name: userData?.displayName || user.email?.split('@')[0] || 'Viewer',
    avatar: userData?.avatar || userData?.profilePicture || '',
    text, isHost: false, createdAt: sts(),
  });
}

export async function sendHostChat(user, userData, text) {
  if (!_hostState || _hostState.endedFlag) return;
  const { rtdbRoomId } = _hostState;
  const { addDoc: ad, collection: col, serverTimestamp: sts } =
    await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
  await ad(col(db, 'liveRooms', rtdbRoomId, 'liveMessages'), {
    uid: user.uid, name: userData?.displayName || user.email?.split('@')[0] || 'Host',
    avatar: userData?.avatar || userData?.profilePicture || '',
    text, isHost: true, createdAt: sts(),
  });
}

export async function leaveCreatorLive() {
  if (!_viewerState || _viewerState.leftFlag) return;
  _viewerState.leftFlag = true;

  if (_viewerState.hbInterval) clearInterval(_viewerState.hbInterval);
  if (_viewerState.reconnectTimer) clearTimeout(_viewerState.reconnectTimer);
  if (_viewerState.frozenInterval) clearInterval(_viewerState.frozenInterval);
  if (_viewerState.signalUnsub) { try { _viewerState.signalUnsub(); } catch (_) {} }
  if (_viewerState.chatUnsub)   { try { _viewerState.chatUnsub(); } catch (_) {} }
  if (_viewerState.rtcPc) { try { _viewerState.rtcPc.close(); } catch (_) {} }

  // Remove viewer presence
  if (_viewerState.presRef) {
    onDisconnect(_viewerState.presRef).cancel().catch(() => {});
    remove(_viewerState.presRef).catch(() => {});
  }

  // Remove signaling data
  const { uid, rtdbRoomId } = _viewerState;
  remove(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${uid}`)).catch(() => {});
  remove(ref(liveDB, `liveConnections/${rtdbRoomId}/viewerCandidates/${uid}`)).catch(() => {});
  remove(ref(liveDB, `liveConnections/${rtdbRoomId}/answers/${uid}`)).catch(() => {});

  _viewerState = null;
}

async function _sendLiveNotifications(uid, liveId, rtdbRoomId, title, roomData) {
  try {
    const { _writeLiveNotification } = await import('./snx-creator-channels.js').catch(() => ({}));
    if (typeof _writeLiveNotification === 'function') {
      await _writeLiveNotification(uid, liveId);
    }
  } catch (_) {}
}

function _buildSetupHTML(userData) {
  const name = userData?.displayName || userData?.username || 'Creator';
  return `
    <div class="crl-setup" style="padding:20px;max-width:480px;margin:0 auto;color:#fff;font-family:system-ui,sans-serif;">
      <div style="font-size:22px;font-weight:700;margin-bottom:16px;text-align:center;">📡 Go Live</div>

      <!-- Video preview -->
      <div style="position:relative;width:100%;aspect-ratio:16/9;background:#111;border-radius:12px;overflow:hidden;margin-bottom:16px;">
        <video id="crl-setup-preview" autoplay playsinline muted
               style="width:100%;height:100%;object-fit:cover;display:none;"></video>
        <div id="crl-setup-preview-off"
             style="display:flex;align-items:center;justify-content:center;height:100%;color:#666;font-size:32px;">📷</div>
      </div>

      <!-- Title -->
      <input id="crl-setup-title" type="text" placeholder="Add a title…"
             style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:14px;box-sizing:border-box;margin-bottom:12px;"
             maxlength="80" autocomplete="off">

      <!-- Controls row -->
      <div style="display:flex;gap:10px;justify-content:center;margin-bottom:16px;">
        <button id="crl-setup-cam-btn" class="crl-setup-ctrl-btn"
                style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 16px;border-radius:10px;border:1px solid #333;background:#1a1a1a;color:#fff;cursor:pointer;font-size:12px;min-width:72px;">
          <span class="crl-ctrl-icon" style="font-size:20px;">📷</span>
          <span class="crl-ctrl-label">Camera</span>
        </button>
        <button id="crl-setup-mic-btn" class="crl-setup-ctrl-btn"
                style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 16px;border-radius:10px;border:1px solid #333;background:#1a1a1a;color:#fff;cursor:pointer;font-size:12px;min-width:72px;">
          <span class="crl-ctrl-icon" style="font-size:20px;">🎤</span>
          <span class="crl-ctrl-label">Mic</span>
        </button>
        <button id="crl-setup-flip-btn" class="crl-setup-ctrl-btn"
                style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 16px;border-radius:10px;border:1px solid #333;background:#1a1a1a;color:#fff;cursor:pointer;font-size:12px;min-width:72px;">
          <span class="crl-ctrl-icon" style="font-size:20px;">🔄</span>
          <span class="crl-ctrl-label">Flip</span>
        </button>
      </div>

      <!-- Error -->
      <div id="crl-setup-err" style="color:#ff4455;font-size:12px;min-height:18px;text-align:center;margin-bottom:8px;"></div>

      <!-- Action buttons -->
      <button id="crl-go-live-btn"
              style="width:100%;padding:14px;border-radius:10px;border:none;background:linear-gradient(135deg,#cc0022,#ff2244);color:#fff;font-size:16px;font-weight:700;cursor:pointer;margin-bottom:10px;letter-spacing:0.5px;">
        🔴 GO LIVE
      </button>
      <button id="crl-setup-cancel"
              style="width:100%;padding:12px;border-radius:10px;border:1px solid #333;background:transparent;color:#aaa;font-size:14px;cursor:pointer;">
        Cancel
      </button>
    </div>
  `;
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
