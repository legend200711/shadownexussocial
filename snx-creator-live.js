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
export const db     = initializeFirestore(_app, { localCache: memoryLocalCache() });
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
══════════════════════════════════════════════════════════════ */
export async function startCreatorBroadcast(user, userData, opts = {}) {
  if (!user) throw new Error('Not authenticated');
  if (_hostState && !_hostState.endedFlag) throw new Error('Already live');

  const { localStream, camOn = true, micOn = true, facingMode = 'user', title = 'Live Broadcast' } = opts;
  if (!localStream || !localStream.getTracks().length) throw new Error('No media stream');

  // Generate unique RTDB room key (same format as live.js)
  const safeUid    = user.uid.replace(/[.#$/[\]]/g, '_');
  const rtdbRoomId = `${safeUid}_${Date.now().toString(36)}`;

  // Create Firestore liveSessions doc with auto-ID
  const sessionRef = await addDoc(collection(db, 'liveSessions'), {
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
  const liveId = sessionRef.id;
  await updateDoc(sessionRef, { liveId });

  // Write room to RTDB (mirrors live.js startLive)
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
    liveId,       // link back to Firestore doc
    channelId:    user.uid,
  };

  await set(ref(liveDB, `liveRooms/${rtdbRoomId}`), roomData);

  // onDisconnect: mark room ended if host drops
  await onDisconnect(ref(liveDB, `liveRooms/${rtdbRoomId}`)).update({
    status: 'ended', isLive: false, endedAt: Date.now(),
  });

  // Update creator's permanent channel
  await updateDoc(doc(db, 'creatorChannels', user.uid), {
    status:        'live',
    currentLiveId: liveId,
    updatedAt:     serverTimestamp(),
  });

  // Write host presence to liveGuests (mirrors live.js)
  await set(ref(liveDB, `liveGuests/${rtdbRoomId}/_host_`), {
    uid: user.uid, name: roomData.hostName, avatar: roomData.hostAvatar,
    isHost: true, camOn, micOn, joinedAt: Date.now(), hb: Date.now(),
  });
  onDisconnect(ref(liveDB, `liveGuests/${rtdbRoomId}`)).remove().catch(() => {});

  // Send live notifications to channel followers
  _sendLiveNotifications(user.uid, liveId, rtdbRoomId, title, roomData).catch(() => {});

  // Build host state
  _hostState = {
    uid: user.uid, liveId, rtdbRoomId, localStream, camOn, micOn, facingMode,
    roomData, userData,
    viewerPeers: {}, signalUnsub: null, viewerCountUnsub: null,
    roomWatchRef: null, heartbeatInterval: null,
    endedFlag: false, notifSentFlag: true,
    peakViewers: 0,   // tracked by _hostSubscribeViewerCount, written on end
  };

  // Start WebRTC listener for incoming viewers
  _hostStartWebRTC();

  // Viewer count subscription
  _hostSubscribeViewerCount();

  // Host heartbeat (15 s)
  _hostState.heartbeatInterval = setInterval(() => {
    if (_hostState?.endedFlag) return;
    set(ref(liveDB, `liveRooms/${rtdbRoomId}/hostHb`), Date.now()).catch(() => {});
  }, 15000);

  // Camera background recovery
  document.addEventListener('visibilitychange', _hostOnVisibilityChange);

  return liveId;
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
    if (!snap.exists() || !_hostState) return;
    snap.forEach(child => {
      const viewerUid = child.key;
      const d = child.val() || {};
      if (!_hostState.viewerPeers[viewerUid]) {
        _hostCreateViewerPeer(viewerUid);
      } else {
        const peer = _hostState.viewerPeers[viewerUid];
        if (d.answer && peer.pc.remoteDescription === null) {
          peer.pc.setRemoteDescription(new RTCSessionDescription(d.answer)).catch(() => {});
        }
        if (peer.pc.remoteDescription && d.viewerCandidates) {
          for (const [k, c] of Object.entries(d.viewerCandidates)) {
            if (peer.appliedCandKeys.has(k)) continue;
            peer.appliedCandKeys.add(k);
            peer.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          }
        }
        if (d.sessionId && d.sessionId !== peer.sessionId) {
          _hostRebuildViewerPeer(viewerUid);
        }
      }
    });
  });
}

async function _hostCreateViewerPeer(viewerUid) {
  if (!_hostState || _hostState.viewerPeers[viewerUid]) return;
  const { rtdbRoomId, localStream } = _hostState;
  const slotRef = ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${viewerUid}`);
  const pc = new RTCPeerConnection(ICE);

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.getTransceivers().forEach(tc => { tc.direction = 'sendonly'; });

  const peer = { pc, appliedCandKeys: new Set(), sessionId: null };
  _hostState.viewerPeers[viewerUid] = peer;

  const pending = [];
  let offerWritten = false;

  pc.onicecandidate = e => {
    if (!e.candidate) return;
    if (!offerWritten) { pending.push(e.candidate.toJSON()); return; }
    push(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${viewerUid}/hostCandidates`), e.candidate.toJSON()).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'failed') _hostRebuildViewerPeer(viewerUid);
    if (s === 'closed') _hostTeardownViewerPeer(viewerUid);
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch (_) {} }
  };

  let offer;
  try { offer = await pc.createOffer(); await pc.setLocalDescription(offer); }
  catch (_) { _hostTeardownViewerPeer(viewerUid); return; }

  try {
    await set(slotRef, { offer: { type: offer.type, sdp: offer.sdp }, hostCandidates: {}, viewerCandidates: {} });
    offerWritten = true;
  } catch (_) { _hostTeardownViewerPeer(viewerUid); return; }

  // Flush buffered ICE candidates
  for (const c of pending) {
    push(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${viewerUid}/hostCandidates`), c).catch(() => {});
  }
}

function _hostRebuildViewerPeer(viewerUid) {
  const old = _hostState?.viewerPeers[viewerUid];
  if (old?.pc) { try { old.pc.close(); } catch (_) {} }
  if (_hostState) delete _hostState.viewerPeers[viewerUid];
  _hostCreateViewerPeer(viewerUid);
}

function _hostTeardownViewerPeer(viewerUid) {
  const peer = _hostState?.viewerPeers[viewerUid];
  if (!peer) return;
  try { peer.pc.close(); } catch (_) {}
  if (_hostState) delete _hostState.viewerPeers[viewerUid];
  const rtdbRoomId = _hostState?.rtdbRoomId;
  if (rtdbRoomId) remove(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${viewerUid}`)).catch(() => {});
}

function _hostTeardownAllViewerPeers() {
  if (!_hostState) return;
  for (const uid of Object.keys(_hostState.viewerPeers)) _hostTeardownViewerPeer(uid);
  _hostState.viewerPeers = {};
  if (_hostState.signalUnsub) { try { _hostState.signalUnsub(); } catch (_) {} _hostState.signalUnsub = null; }
}

/* ══════════════════════════════════════════════════════════════
   HOST — viewer count
══════════════════════════════════════════════════════════════ */
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

  // Mark RTDB room ended
  await update(ref(liveDB, `liveRooms/${rtdbRoomId}`), { status: 'ended', isLive: false, endedAt: Date.now() }).catch(() => {});

  // Cleanup RTDB signaling
  await remove(ref(liveDB, `liveConnections/${rtdbRoomId}`)).catch(() => {});
  await remove(ref(liveDB, `liveGuests/${rtdbRoomId}`)).catch(() => {});

  // Schedule RTDB room removal after 5 min
  setTimeout(() => remove(ref(liveDB, `liveRooms/${rtdbRoomId}`)).catch(() => {}), 5 * 60 * 1000);

  // Mark Firestore liveSessions doc ended — capture peak viewers
  const peakViewers = _hostState?.peakViewers || 0;
  await updateDoc(doc(db, 'liveSessions', liveId), {
    status: 'ended', endedAt: serverTimestamp(),
    peakViewers,
  }).catch(() => {});

  // Return creator channel to offline
  await updateDoc(doc(db, 'creatorChannels', uid), {
    status: 'offline', currentLiveId: null, updatedAt: serverTimestamp(),
  }).catch(() => {});

  const finalPeak = peakViewers;
  _hostState = null;
  window.dispatchEvent(new CustomEvent('crl:ended', { detail: { liveId, peakViewers: finalPeak } }));
}

/* ══════════════════════════════════════════════════════════════
   EXPORTED: HOST — current stream (for attaching to video el)
══════════════════════════════════════════════════════════════ */
export function getHostStream() { return _hostState?.localStream || null; }
export function getHostState()  { return _hostState; }

/* ══════════════════════════════════════════════════════════════
   EXPORTED: VIEWER — join a creator live
   Returns a viewer handle object, or null if stream not found.
══════════════════════════════════════════════════════════════ */
export async function joinCreatorLive(user, liveId, videoEl, onEvent) {
  if (!user || !liveId || !videoEl) return null;

  // Clean up any previous viewer session
  await leaveCreatorLive();

  // Load liveSessions doc to get rtdbRoomId
  const sessionSnap = await getDoc(doc(db, 'liveSessions', liveId));
  if (!sessionSnap.exists()) { onEvent?.({ type: 'not_found' }); return null; }
  const session = sessionSnap.data();
  if (session.status === 'ended') { onEvent?.({ type: 'ended' }); return null; }
  const rtdbRoomId = session.rtdbRoomId;
  if (!rtdbRoomId) { onEvent?.({ type: 'not_found' }); return null; }

  // Confirm RTDB room is live
  const roomSnap = await get(ref(liveDB, `liveRooms/${rtdbRoomId}`));
  if (!roomSnap.exists() || roomSnap.val().status !== 'live') {
    onEvent?.({ type: 'ended' }); return null;
  }
  const roomData = roomSnap.val();

  _viewerState = {
    uid: user.uid, liveId, rtdbRoomId, rtcPc: null,
    signalUnsub: null, chatUnsub: null, roomWatchRef: null,
    presRef: null, hbInterval: null,
    leftFlag: false, reconnectTimer: null, reconnectAttempt: 0,
    frozenInterval: null, videoEl,
  };

  onEvent?.({ type: 'connecting', roomData });

  // Register viewer presence
  const presRef = ref(liveDB, `liveRooms/${rtdbRoomId}/viewerPresence/${user.uid}`);
  _viewerState.presRef = presRef;
  await set(presRef, { joinedAt: Date.now(), hb: Date.now() }).catch(() => {});
  onDisconnect(presRef).remove().catch(() => {});

  // Heartbeat every 30 s
  _viewerState.hbInterval = setInterval(() => {
    if (_viewerState?.leftFlag) return;
    set(presRef, { joinedAt: Date.now(), hb: Date.now() }).catch(() => {});
  }, 30000);

  // Watch room for stream end
  const roomWatchRef = ref(liveDB, `liveRooms/${rtdbRoomId}`);
  _viewerState.roomWatchRef = roomWatchRef;
  let firstWatch = true;
  // Store the unsubscribe handle so leaveCreatorLive can remove it properly
  _viewerState.roomWatchUnsub = onValue(roomWatchRef, snap => {
    if (firstWatch) { firstWatch = false; return; }
    if (!snap.exists() || snap.val().status === 'ended') {
      onEvent?.({ type: 'ended', hostName: roomData.hostName });
    }
    const d = snap.val() || {};
    onEvent?.({ type: 'counts', viewers: d.viewers || 0, likes: d.likes || 0 });
  });

  // Subscribe chat
  _viewerSubscribeChat(rtdbRoomId, user.uid, onEvent);

  // Subscribe Firestore liveSessions for viewer count updates
  const liveSessionUnsub = onSnapshot(doc(db, 'liveSessions', liveId), snap => {
    if (snap.exists()) onEvent?.({ type: 'sessionUpdate', data: snap.data() });
  });
  _viewerState.sessionUnsub = liveSessionUnsub;

  // Start WebRTC
  await _viewerStartWebRTC(roomData, onEvent);

  // Frozen video watchdog
  _viewerState.frozenInterval = setInterval(() => {
    if (_viewerState?.leftFlag) return;
    const v = videoEl;
    if (!v || !v.srcObject) return;
    const ok = !v.paused && v.readyState >= 2 && v.srcObject.getVideoTracks().some(t => t.readyState === 'live');
    if (!ok) {
      v.play().catch(() => {});
      setTimeout(() => {
        const stillBad = v.paused || v.readyState < 2;
        if (stillBad) _viewerScheduleReconnect(roomData, onEvent);
      }, 2000);
    }
  }, 12000);

  return _viewerState;
}

/* ══════════════════════════════════════════════════════════════
   VIEWER — WebRTC
══════════════════════════════════════════════════════════════ */
async function _viewerStartWebRTC(roomData, onEvent) {
  if (!_viewerState) return;
  const { uid, rtdbRoomId, videoEl } = _viewerState;
  const slotRef   = ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${uid}`);
  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);

  await set(slotRef, { sessionId, viewerCandidates: {} }).catch(() => {});

  // Poll for offer (up to 15 s)
  let slotSnap = null;
  for (let i = 0; i < 30; i++) {
    try { slotSnap = await get(slotRef); } catch (_) {}
    if (slotSnap?.exists() && slotSnap.val().offer) break;
    slotSnap = null;
    await new Promise(r => setTimeout(r, 500));
  }

  if (!slotSnap) {
    onEvent?.({ type: 'waiting' });
    // Wait with a one-shot listener; store unsubscribe so leaveCreatorLive can cancel it
    const waitUnsub = onValue(slotRef, async snap => {
      if (!snap.exists() || !snap.val().offer) return;
      try { waitUnsub(); } catch (_) {}
      if (_viewerState) _viewerState.waitUnsub = null;
      if (!_viewerState?.leftFlag) await _viewerStartWebRTC(roomData, onEvent);
    });
    if (_viewerState) _viewerState.waitUnsub = waitUnsub;
    return;
  }

  if (_viewerState.rtcPc) {
    _viewerState.rtcPc.ontrack = null;
    _viewerState.rtcPc.onconnectionstatechange = null;
    _viewerState.rtcPc.onicecandidate = null;
    try { _viewerState.rtcPc.close(); } catch (_) {}
    _viewerState.rtcPc = null;
  }
  if (_viewerState.signalUnsub) { try { _viewerState.signalUnsub(); } catch (_) {} _viewerState.signalUnsub = null; }

  const pc = new RTCPeerConnection(ICE);
  _viewerState.rtcPc = pc;

  pc.ontrack = e => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    videoEl.srcObject = stream;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.play().catch(() => {});
    onEvent?.({ type: 'stream', stream });
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') {
      _viewerState && (_viewerState.reconnectAttempt = 0);
      onEvent?.({ type: 'connected' });
    } else if (s === 'disconnected' || s === 'failed') {
      onEvent?.({ type: 'reconnecting' });
      setTimeout(() => {
        if (_viewerState?.rtcPc?.connectionState === 'disconnected' || _viewerState?.rtcPc?.connectionState === 'failed') {
          _viewerScheduleReconnect(roomData, onEvent);
        }
      }, 3000);
    }
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') { try { pc.restartIce(); } catch (_) {} }
  };

  const slotData = slotSnap.val();
  try { await pc.setRemoteDescription(new RTCSessionDescription(slotData.offer)); }
  catch (_) { onEvent?.({ type: 'waiting' }); return; }

  const pending = [];
  let answerWritten = false;
  pc.onicecandidate = e => {
    if (!e.candidate) return;
    if (!answerWritten) { pending.push(e.candidate.toJSON()); return; }
    push(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${uid}/viewerCandidates`), e.candidate.toJSON()).catch(() => {});
  };

  let answer;
  try { answer = await pc.createAnswer(); await pc.setLocalDescription(answer); }
  catch (_) { onEvent?.({ type: 'waiting' }); return; }

  try {
    await update(slotRef, { answer: { type: answer.type, sdp: answer.sdp }, viewerCandidates: {} });
    answerWritten = true;
  } catch (_) { onEvent?.({ type: 'waiting' }); return; }

  // Flush pending ICE
  for (const c of pending) {
    push(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${uid}/viewerCandidates`), c).catch(() => {});
  }

  // Apply existing host ICE candidates
  const appliedCands = new Set();
  const existing = slotData.hostCandidates || {};
  for (const [k, c] of Object.entries(existing)) {
    appliedCands.add(k);
    pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }

  // Listen for new host ICE candidates
  let lastOfferSdp = slotData.offer?.sdp || null;
  _viewerState.signalUnsub = onValue(slotRef, async snap => {
    if (!snap.exists() || !_viewerState) return;
    const d = snap.val();
    if (d.offer?.sdp && d.offer.sdp !== lastOfferSdp) {
      lastOfferSdp = d.offer.sdp;
      pc.ontrack = null; pc.onconnectionstatechange = null; pc.onicecandidate = null;
      try { pc.close(); } catch (_) {}
      if (_viewerState.signalUnsub) { try { _viewerState.signalUnsub(); } catch (_) {} _viewerState.signalUnsub = null; }
      _viewerStartWebRTC(roomData, onEvent);
      return;
    }
    if (d.hostCandidates) {
      for (const [k, c] of Object.entries(d.hostCandidates)) {
        if (appliedCands.has(k)) continue;
        appliedCands.add(k);
        _viewerState?.rtcPc?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      }
    }
  });

  // 8 s black-screen watchdog
  setTimeout(() => {
    if (_viewerState?.leftFlag || _viewerState?.rtcPc !== pc) return;
    const v = videoEl;
    const hasVideo = v?.srcObject?.getVideoTracks().some(t => t.readyState === 'live');
    if (!hasVideo) _viewerScheduleReconnect(roomData, onEvent);
  }, 8000);
}

function _viewerScheduleReconnect(roomData, onEvent) {
  if (!_viewerState || _viewerState.leftFlag) return;
  if (_viewerState.reconnectTimer) clearTimeout(_viewerState.reconnectTimer);
  const delay = Math.min(2000 * Math.pow(1.5, Math.min(_viewerState.reconnectAttempt, 7)), 15000);
  _viewerState.reconnectAttempt++;
  onEvent?.({ type: 'reconnecting', attempt: _viewerState.reconnectAttempt });
  _viewerState.reconnectTimer = setTimeout(async () => {
    _viewerState.reconnectTimer = null;
    if (_viewerState?.leftFlag) return;
    // Verify stream still live
    try {
      const snap = await get(ref(liveDB, `liveRooms/${_viewerState.rtdbRoomId}`));
      if (!snap.exists() || snap.val().status !== 'live') {
        onEvent?.({ type: 'ended' }); return;
      }
    } catch (_) {}
    if (_viewerState?.videoEl) _viewerState.videoEl.srcObject = null;
    await _viewerStartWebRTC(roomData, onEvent);
  }, delay);
}

/* ══════════════════════════════════════════════════════════════
   VIEWER — chat subscription
══════════════════════════════════════════════════════════════ */
function _viewerSubscribeChat(rtdbRoomId, callerUid, onEvent) {
  if (!_viewerState) return;
  if (_viewerState.chatUnsub) { try { _viewerState.chatUnsub(); } catch (_) {} }
  const q = query(
    collection(db, 'liveRooms', rtdbRoomId, 'liveMessages'),
    orderBy('createdAt', 'asc'),
    limit(80),
  );
  _viewerState.chatUnsub = onSnapshot(q, snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === 'added') {
        onEvent?.({ type: 'chat', message: { id: ch.doc.id, ...ch.doc.data() } });
      }
    });
  }, err => {
    console.warn('[CRL chat]', err.message);
    setTimeout(() => { if (_viewerState && !_viewerState.leftFlag) _viewerSubscribeChat(rtdbRoomId, callerUid, onEvent); }, 5000);
  });
}

/* ══════════════════════════════════════════════════════════════
   EXPORTED: VIEWER — send chat message
══════════════════════════════════════════════════════════════ */
export async function sendViewerChat(user, userData, text) {
  if (!_viewerState?.rtdbRoomId || !text?.trim()) return;
  await addDoc(collection(db, 'liveRooms', _viewerState.rtdbRoomId, 'liveMessages'), {
    userId:    user.uid,
    userName:  userData?.displayName || 'Viewer',
    text:      text.trim().slice(0, 200),
    type:      'chat',
    createdAt: serverTimestamp(),
  });
}

/* ══════════════════════════════════════════════════════════════
   EXPORTED: VIEWER — send chat from host side
══════════════════════════════════════════════════════════════ */
export async function sendHostChat(user, userData, text) {
  if (!_hostState?.rtdbRoomId || !text?.trim()) return;
  await addDoc(collection(db, 'liveRooms', _hostState.rtdbRoomId, 'liveMessages'), {
    userId:    user.uid,
    userName:  userData?.displayName || 'Host',
    text:      text.trim().slice(0, 200),
    type:      'chat',
    createdAt: serverTimestamp(),
  });
}

/* ══════════════════════════════════════════════════════════════
   EXPORTED: VIEWER — leave stream
══════════════════════════════════════════════════════════════ */
export async function leaveCreatorLive() {
  if (!_viewerState) return;
  _viewerState.leftFlag = true;

  if (_viewerState.reconnectTimer)  { clearTimeout(_viewerState.reconnectTimer); }
  if (_viewerState.frozenInterval)  { clearInterval(_viewerState.frozenInterval); }
  if (_viewerState.hbInterval)      { clearInterval(_viewerState.hbInterval); }
  if (_viewerState.waitUnsub)       { try { _viewerState.waitUnsub(); } catch (_) {} }
  if (_viewerState.chatUnsub)       { try { _viewerState.chatUnsub(); } catch (_) {} }
  if (_viewerState.sessionUnsub)    { try { _viewerState.sessionUnsub(); } catch (_) {} }
  // Use the stored onValue unsubscribe function when available; fall back to off()
  if (_viewerState.roomWatchUnsub)  { try { _viewerState.roomWatchUnsub(); } catch (_) {} }
  else if (_viewerState.roomWatchRef) { try { off(_viewerState.roomWatchRef); } catch (_) {} }
  if (_viewerState.signalUnsub)     { try { _viewerState.signalUnsub(); } catch (_) {} }

  if (_viewerState.rtcPc) {
    _viewerState.rtcPc.ontrack = null;
    _viewerState.rtcPc.onconnectionstatechange = null;
    _viewerState.rtcPc.onicecandidate = null;
    try { _viewerState.rtcPc.close(); } catch (_) {}
  }

  const { rtdbRoomId, uid, presRef } = _viewerState;
  if (presRef) {
    onDisconnect(presRef).cancel().catch(() => {});
    remove(presRef).catch(() => {});
  }
  if (rtdbRoomId && uid) {
    remove(ref(liveDB, `liveConnections/${rtdbRoomId}/viewers/${uid}`)).catch(() => {});
  }

  if (_viewerState.videoEl) _viewerState.videoEl.srcObject = null;
  _viewerState = null;
}

/* ══════════════════════════════════════════════════════════════
   LIVE NOTIFICATIONS
══════════════════════════════════════════════════════════════ */
async function _sendLiveNotifications(uid, liveId, rtdbRoomId, title, roomData) {
  try {
    const channelSnap = await getDoc(doc(db, 'creatorChannels', uid));
    if (!channelSnap.exists()) return;
    const channel = channelSnap.data();

    const followersSnap = await getDocs ? null : null; // import below
    const { getDocs: gds, query: q2, where: w2, collection: col2, limit: lim2 } =
      await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');

    const fSnap = await gds(q2(
      col2(db, 'channelFollows', uid, 'followers'),
      w2('notificationsEnabled', '==', true),
      lim2(500),
    ));

    const notif = {
      type:        'creator_live',
      fromUid:     uid,
      channelName: channel.channelName || 'A creator',
      liveId,
      rtdbRoomId,
      title,
      text:        `🔴 ${channel.channelName || 'A creator'} is LIVE on Shadow Nexus TV`,
      subtitle:    `"${title}"`,
      deepLink:    `channel.html?live=${uid}&liveId=${liveId}`,
      timestamp:   serverTimestamp(),
      read:        false,
    };

    await Promise.allSettled(fSnap.docs.map(fDoc => {
      const fUid = fDoc.data().followerUid;
      if (fUid === uid) return Promise.resolve(); // don't notify self
      return addDoc(col2(db, 'notifications', fUid, 'items'), notif);
    }));
  } catch (err) {
    console.warn('[CRL notifications]', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   SETUP SCREEN HTML
══════════════════════════════════════════════════════════════ */
function _buildSetupHTML(userData) {
  return `
    <div class="crl-setup">
      <div class="crl-setup-header">
        <div class="crl-setup-title">🔴 GO LIVE</div>
        <div class="crl-setup-sub">Preview before broadcasting on <strong>${_esc(userData?.displayName || 'your channel')}</strong></div>
      </div>

      <div class="crl-preview-wrap">
        <video id="crl-setup-preview" autoplay muted playsinline style="width:100%;height:100%;object-fit:cover;display:none;border-radius:inherit;"></video>
        <div id="crl-setup-preview-off" class="crl-preview-off">
          <div style="font-size:36px;margin-bottom:6px;">📷</div>
          <div style="font-size:12px;color:#5a80a8;">Camera off</div>
        </div>
      </div>

      <div class="crl-setup-controls">
        <button class="crl-ctrl-btn" id="crl-setup-cam-btn">
          <span class="crl-ctrl-icon">📷</span>
          <span class="crl-ctrl-label">Camera</span>
        </button>
        <button class="crl-ctrl-btn" id="crl-setup-mic-btn">
          <span class="crl-ctrl-icon">🎤</span>
          <span class="crl-ctrl-label">Mic</span>
        </button>
        <button class="crl-ctrl-btn" id="crl-setup-flip-btn">
          <span class="crl-ctrl-icon">🔄</span>
          <span class="crl-ctrl-label">Flip</span>
        </button>
      </div>

      <input class="crl-title-input" id="crl-setup-title"
             type="text" placeholder="What are you broadcasting today? (optional)"
             maxlength="80">

      <div id="crl-setup-err" class="crl-setup-err"></div>

      <div class="crl-setup-actions">
        <button class="crl-btn-cancel" id="crl-setup-cancel">CANCEL</button>
        <button class="crl-btn-go-live" id="crl-go-live-btn">
          <span class="crl-live-dot"></span> GO LIVE
        </button>
      </div>
    </div>`;
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
