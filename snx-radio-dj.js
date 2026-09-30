/**
 * snx-radio-dj.js — Shadow Nexus Radio · DJ Mode
 * Version: 1.0.0
 *
 * Adds live microphone-to-listeners DJ capability inside the existing Radio system.
 *
 * Architecture:
 *   - DJ state: Firestore /siteSettings/radioDj
 *     { active, hostUid, hostDisplayName, startedAt, sessionId }
 *   - Signaling: RTDB /radioDjSessions/{sessionId}/listeners/{listenerId}
 *     { offer }  and  /radioDjSessions/{sessionId}/listeners/{listenerId}/answer
 *     { answer } and  ICE candidate exchange via
 *     /radioDjSessions/{sessionId}/djCandidates/{key}  (DJ → listeners)
 *     /radioDjSessions/{sessionId}/listeners/{listenerId}/candidates/{key} (listener → DJ)
 *   - Actual audio: WebRTC PeerConnection per listener (browser-to-browser)
 *   - Music ducking: temporary volume multiplier on the Radio audio element
 *   - Disconnect safety: RTDB session node + onDisconnect().remove() + 30s heartbeat
 *     monitored by listener side (auto-ends after 65 s with no heartbeat)
 *
 * ISOLATION GUARANTEE:
 *   - Uses RTDB paths: radioDjSessions/, radioDjSignaling/ only
 *   - Uses Firestore path: /siteSettings/radioDj only
 *   - Does NOT touch: liveRooms, liveSignaling, guestSignaling, mediasoup, TV, live.js
 *   - Window export: window.SNXRadioDJ only
 *   - Does NOT modify the Radio timeline, epochMs, or playlist
 *
 * Security:
 *   - Only Founder (window._snxRole === 'founder') can call djStart() / djEnd()
 *   - Firestore rules: /siteSettings/radioDj write requires Founder auth
 *   - RTDB rules: /radioDjSessions write requires auth; read is open for listeners
 *
 * Music ducking:
 *   - Reads the current audio element volume as userVolume
 *   - Applies a duck multiplier (0.2) over a 1.5s ramp
 *   - On DJ end: ramps back to userVolume over 2s
 *   - Never permanently changes user volume preference
 *
 * Dependencies:
 *   window._snxLiveDB         — Firebase RTDB instance
 *   window._snxRtdbApi        — { ref, set, remove, onValue, off, push }
 *   window._snxRtdbExt        — { onDisconnect }
 *   window._snxFirestore      — modular Firestore helpers
 *   window._snxCurrentUser    — Firebase Auth user
 *   window._snxRole           — 'founder' | 'member' | ...
 *   window.SNXRadio            — Radio engine
 */

'use strict';

(function () {

const DJ_VERSION      = '1.0.0';

/* ── Firestore ── */
const COL_SITE        = 'siteSettings';
const DOC_DJ          = 'radioDj';

/* ── RTDB paths ── */
const RTDB_DJ_SESSIONS = 'radioDjSessions';  // /radioDjSessions/{sessionId}/...
// /radioDjSessions/{sessionId}/heartbeat      — DJ heartbeat timestamp
// /radioDjSessions/{sessionId}/djCandidates/  — DJ ICE candidates
// /radioDjSessions/{sessionId}/listeners/{id}/offer
// /radioDjSessions/{sessionId}/listeners/{id}/answer
// /radioDjSessions/{sessionId}/listeners/{id}/candidates/

/* ── Music ducking ── */
const DUCK_LEVEL      = 0.2;   // multiply user volume by this during DJ
const DUCK_RAMP_MS    = 1500;  // fade down duration
const UNDUCK_RAMP_MS  = 2000;  // fade up duration

/* ── Stale detection (listener side) ── */
const HEARTBEAT_MS    = 20000; // DJ writes heartbeat every 20 s
const STALE_TIMEOUT   = 65000; // listener removes DJ if no heartbeat in 65 s

/* ── ICE servers ── */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/* ════════════════════════════════════════════════════════════
   STATE
════════════════════════════════════════════════════════════ */

/* Shared state */
let _djState          = null;  // Firestore /siteSettings/radioDj snapshot
let _djStateUnsub     = null;  // Firestore onSnapshot unsubscribe

/* Founder / DJ state */
let _djActive         = false;
let _djSessionId      = null;
let _djStream         = null;  // MediaStream from getUserMedia
let _djSessionRef     = null;  // RTDB /radioDjSessions/{sessionId}
let _djHeartbeatTimer = null;
let _peerConnections  = {};    // listenerId → RTCPeerConnection (DJ side)
let _djListenersUnsub = null;  // onValue for new listener joins
let _djCandidateBuf   = {};    // listenerId → buffered ICE candidates

/* Listener state */
let _listenerPc       = null;  // RTCPeerConnection (listener side)
let _listenerRemoteStream = null;
let _listenerAudio    = null;  // <audio> for DJ microphone
let _listenerSessionId = null; // session being listened to
let _listenerNodeId   = null;  // my listener node id in RTDB
let _listenerAnswerUnsub = null;
let _staleTimer       = null;

/* Ducking state */
let _userVolume       = 0.9;   // captured before ducking
let _duckRamp         = null;  // requestAnimationFrame handle

/* ════════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */

window.SNXRadioDJ = {
  init,
  djStart,
  djEnd,
  destroy,
  get isActive()      { return _djActive; },
  get djState()       { return _djState; },
  get version()       { return DJ_VERSION; },
};

/* ════════════════════════════════════════════════════════════
   INIT
   Subscribe to Firestore DJ state for all users (Founder + listeners).
════════════════════════════════════════════════════════════ */

function init() {
  _subscribeDjState();
}

/* ════════════════════════════════════════════════════════════
   FIRESTORE DJ STATE SUBSCRIPTION
════════════════════════════════════════════════════════════ */

function _subscribeDjState() {
  const fs = _getFirestore();
  if (!fs) {
    setTimeout(_subscribeDjState, 800);
    return;
  }

  const mods = _getFirestoreMods();
  if (!mods) { setTimeout(_subscribeDjState, 800); return; }

  try {
    const ref = mods.doc(fs, COL_SITE, DOC_DJ);
    _djStateUnsub = mods.onSnapshot(ref, (snap) => {
      _djState = snap.exists() ? snap.data() : null;
      _onDjStateChange(_djState);
    }, (err) => {
      console.warn('[SNX-DJ] DJ state listener error:', err.message);
    });
  } catch (e) {
    console.warn('[SNX-DJ] _subscribeDjState error:', e.message);
  }
}

function _onDjStateChange(state) {
  // Notify player UI about DJ state
  if (typeof window.snxRadioDjStateChanged === 'function') {
    try { window.snxRadioDjStateChanged(state); } catch (_) {}
  }

  const isActive = !!(state && state.active);

  if (!isActive) {
    // DJ went off air — if we were listening, disconnect and unduck
    if (_listenerPc) {
      _listenerDisconnect();
    }
    _unduckMusic();
    return;
  }

  // DJ is active
  const sessionId = state.sessionId;
  const myUid     = window._snxCurrentUser && window._snxCurrentUser.uid;

  // If I am the DJ, do nothing (DJ manages its own connections)
  if (state.hostUid && myUid && state.hostUid === myUid) return;

  // Listener: connect to DJ session if not already connected to this session
  if (_listenerSessionId !== sessionId) {
    _listenerSessionId = null;
    if (_listenerPc) _listenerDisconnect();
    _listenerConnect(sessionId);
  }
}

/* ════════════════════════════════════════════════════════════
   DJ START / END  (Founder only)
════════════════════════════════════════════════════════════ */

/**
 * Start DJ Mode. Requests microphone, then activates the DJ session.
 * @param {function({error?:string, active?:boolean}):void} [onResult]
 */
async function djStart(onResult) {
  // Security: Founder only
  if (window._snxRole !== 'founder') {
    console.warn('[SNX-DJ] djStart() called by non-founder');
    if (onResult) onResult({ error: 'Not authorized' });
    return;
  }

  if (_djActive) {
    if (onResult) onResult({ active: true });
    return;
  }

  // Step 1: Request microphone
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
      video: false,
    });
  } catch (e) {
    console.warn('[SNX-DJ] Microphone error:', e.name, e.message);
    if (onResult) onResult({ error: 'Microphone error: ' + (e.message || e.name) });
    // Radio state is untouched — do not proceed
    return;
  }

  // Step 2: Create RTDB session node
  const rtdb = _getRtdb();
  const api  = _getApi();
  const ext  = _getExt();
  if (!rtdb || !api || !ext) {
    stream.getTracks().forEach(t => t.stop());
    if (onResult) onResult({ error: 'RTDB not available' });
    return;
  }

  _djSessionId = _randId();
  _djStream    = stream;
  _djActive    = true;

  const sessionPath = RTDB_DJ_SESSIONS + '/' + _djSessionId;
  _djSessionRef = api.ref(rtdb, sessionPath);

  // Write session node — onDisconnect removes it if browser closes
  const uid         = window._snxCurrentUser && window._snxCurrentUser.uid;
  const displayName = (window._snxCurrentUser && window._snxCurrentUser.displayName) || 'DJ';
  await api.set(_djSessionRef, {
    active:      true,
    hostUid:     uid,
    startedAt:   Date.now(),
    heartbeat:   Date.now(),
  }).catch(e => console.warn('[SNX-DJ] session write error:', e.message));

  try {
    ext.onDisconnect(_djSessionRef).remove();
  } catch (_) {}

  // Step 3: Write Firestore DJ state (authoritative)
  await _writeDjState({
    active:          true,
    hostUid:         uid,
    hostDisplayName: displayName,
    startedAt:       _serverTimestamp(),
    sessionId:       _djSessionId,
  });

  // Step 4: Listen for new peers joining and send offers
  _djListenForListeners();

  // Step 5: Heartbeat
  _djHeartbeatTimer = setInterval(_djHeartbeat, HEARTBEAT_MS);

  // Step 6: Duck radio music for DJ (DJ themselves does not need to duck)
  // Founder's own music is ducked so they can hear themselves through monitor
  _duckMusic();

  console.log('[SNX-DJ] DJ Mode started — session:', _djSessionId);
  if (onResult) onResult({ active: true });
}

/**
 * End DJ Mode.
 */
async function djEnd() {
  if (window._snxRole !== 'founder') return;
  if (!_djActive) return;

  console.log('[SNX-DJ] DJ Mode ending…');

  // Stop heartbeat
  if (_djHeartbeatTimer) { clearInterval(_djHeartbeatTimer); _djHeartbeatTimer = null; }

  // Stop listening for new peers
  if (_djListenersUnsub) {
    try { _djListenersUnsub(); } catch (_) {}
    _djListenersUnsub = null;
  }

  // Close all peer connections
  Object.keys(_peerConnections).forEach(id => {
    try { _peerConnections[id].close(); } catch (_) {}
  });
  _peerConnections = {};

  // Stop microphone tracks
  if (_djStream) {
    _djStream.getTracks().forEach(t => t.stop());
    _djStream = null;
  }

  // Remove RTDB session
  const api = _getApi();
  if (_djSessionRef && api) {
    api.remove(_djSessionRef).catch(() => {});
    _djSessionRef = null;
  }

  // Clear Firestore DJ state
  await _writeDjState({
    active:          false,
    hostUid:         null,
    hostDisplayName: null,
    startedAt:       null,
    sessionId:       null,
    endedAt:         _serverTimestamp(),
  }).catch(() => {});

  _djActive    = false;
  _djSessionId = null;
  _djCandidateBuf = {};

  // Unduck music for founder
  _unduckMusic();

  console.log('[SNX-DJ] DJ Mode ended');
}

/* ════════════════════════════════════════════════════════════
   DJ — WEBRTC: LISTEN FOR LISTENERS AND SEND OFFERS
════════════════════════════════════════════════════════════ */

function _djListenForListeners() {
  const rtdb = _getRtdb();
  const api  = _getApi();
  if (!rtdb || !api) return;

  const listenersPath = RTDB_DJ_SESSIONS + '/' + _djSessionId + '/listeners';
  const listenersRef  = api.ref(rtdb, listenersPath);

  const handler = (snap) => {
    if (!snap || !snap.exists()) return;
    snap.forEach(child => {
      const id   = child.key;
      const data = child.val();
      if (!data) return;

      // If we have a request (offer field = empty string or missing) but no existing PC, create one
      if (!_peerConnections[id]) {
        _djCreateOffer(id);
      }

      // If listener sent us an answer, set it as remote description
      if (data.answer && _peerConnections[id]) {
        const pc = _peerConnections[id];
        if (pc.signalingState === 'have-local-offer') {
          const desc = new RTCSessionDescription(JSON.parse(data.answer));
          pc.setRemoteDescription(desc).then(() => {
            // Flush buffered ICE candidates from listener
            (_djCandidateBuf[id] || []).forEach(c => {
              pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
            });
            delete _djCandidateBuf[id];
          }).catch(e => console.warn('[SNX-DJ] setRemoteDescription error:', e.message));
        }
      }

      // Listener ICE candidates
      if (data.candidates && _peerConnections[id]) {
        const pc = _peerConnections[id];
        Object.values(data.candidates).forEach(cStr => {
          if (!cStr) return;
          const c = JSON.parse(cStr);
          if (pc.remoteDescription) {
            pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
          } else {
            if (!_djCandidateBuf[id]) _djCandidateBuf[id] = [];
            _djCandidateBuf[id].push(c);
          }
        });
      }
    });
  };

  const unsub = api.onValue(listenersRef, handler);
  _djListenersUnsub = () => {
    if (typeof unsub === 'function') { try { unsub(); } catch (_) {} }
    else if (api.off) { try { api.off(listenersRef, 'value', handler); } catch (_) {} }
  };
}

async function _djCreateOffer(listenerId) {
  const rtdb = _getRtdb();
  const api  = _getApi();
  if (!rtdb || !api || !_djStream) return;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  _peerConnections[listenerId] = pc;

  // Add microphone track
  _djStream.getTracks().forEach(track => {
    pc.addTrack(track, _djStream);
  });

  // ICE candidates — send to RTDB for listener
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const candPath = RTDB_DJ_SESSIONS + '/' + _djSessionId + '/djCandidates/' + listenerId + '/' + _randId();
    const ref = api.ref(rtdb, candPath);
    api.set(ref, JSON.stringify(e.candidate.toJSON())).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log('[SNX-DJ] peer', listenerId, 'connection state:', state);
    if (state === 'failed' || state === 'disconnected' || state === 'closed') {
      pc.close();
      delete _peerConnections[listenerId];
    }
  };

  // Create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // Write offer to RTDB for listener
  const offerPath = RTDB_DJ_SESSIONS + '/' + _djSessionId + '/listeners/' + listenerId + '/offer';
  const offerRef  = api.ref(rtdb, offerPath);
  await api.set(offerRef, JSON.stringify(pc.localDescription.toJSON())).catch(() => {});
}

function _djHeartbeat() {
  if (!_djSessionRef) return;
  const api = _getApi();
  if (!api) return;
  const hbRef = _getApi().ref(_getRtdb(), RTDB_DJ_SESSIONS + '/' + _djSessionId + '/heartbeat');
  api.set(hbRef, Date.now()).catch(() => {});
}

/* ════════════════════════════════════════════════════════════
   LISTENER — CONNECT TO DJ SESSION
════════════════════════════════════════════════════════════ */

async function _listenerConnect(sessionId) {
  const rtdb = _getRtdb();
  const api  = _getApi();
  const ext  = _getExt();
  if (!rtdb || !api) return;

  _listenerSessionId = sessionId;
  _listenerNodeId    = _randId();

  console.log('[SNX-DJ] Listener connecting to DJ session:', sessionId);

  // Write my listener node so DJ knows to create an offer for me
  const listenerPath = RTDB_DJ_SESSIONS + '/' + sessionId + '/listeners/' + _listenerNodeId;
  const listenerRef  = api.ref(rtdb, listenerPath);
  await api.set(listenerRef, { joinedAt: Date.now() }).catch(() => {});

  // onDisconnect: remove my listener node
  if (ext) {
    try { ext.onDisconnect(listenerRef).remove(); } catch (_) {}
  }

  // Watch for offer from DJ
  const offerPath = RTDB_DJ_SESSIONS + '/' + sessionId + '/listeners/' + _listenerNodeId + '/offer';
  const offerRef  = api.ref(rtdb, offerPath);

  let _offerUnsub = null;
  const offerHandler = async (snap) => {
    const offerStr = snap && snap.val && snap.val();
    if (!offerStr) return;

    // Already have a PC for this offer, skip
    if (_listenerPc && _listenerPc.signalingState !== 'closed') return;

    // Stop watching for offer (one-time)
    if (_offerUnsub) { try { _offerUnsub(); } catch (_) {} _offerUnsub = null; }

    await _listenerCreateAnswer(sessionId, offerStr);
  };

  const offerOnValUnsub = api.onValue(offerRef, offerHandler);
  _offerUnsub = () => {
    if (typeof offerOnValUnsub === 'function') { try { offerOnValUnsub(); } catch (_) {} }
    else if (api.off) { try { api.off(offerRef, 'value', offerHandler); } catch (_) {} }
  };
  _listenerAnswerUnsub = _offerUnsub;

  // Watch DJ heartbeat for stale detection
  _startStaleTimer(sessionId);
}

async function _listenerCreateAnswer(sessionId, offerStr) {
  const rtdb = _getRtdb();
  const api  = _getApi();
  if (!rtdb || !api) return;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  _listenerPc = pc;

  // Remote stream received
  pc.ontrack = (e) => {
    if (!_listenerAudio) {
      _listenerAudio = document.createElement('audio');
      _listenerAudio.autoplay = true;
      _listenerAudio.setAttribute('playsinline', '');
      document.body.appendChild(_listenerAudio);
    }
    _listenerRemoteStream = e.streams[0] || new MediaStream([e.track]);
    _listenerAudio.srcObject = _listenerRemoteStream;
    _listenerAudio.play().catch(() => {});
    console.log('[SNX-DJ] Listener: DJ audio track received');

    // Duck music now that DJ audio is flowing
    _duckMusic();
  };

  // ICE candidates — send to RTDB for DJ
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    const candPath = RTDB_DJ_SESSIONS + '/' + sessionId + '/listeners/' + _listenerNodeId + '/candidates/' + _randId();
    const ref = api.ref(rtdb, candPath);
    api.set(ref, JSON.stringify(e.candidate.toJSON())).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    console.log('[SNX-DJ] Listener connection state:', state);
    if (state === 'disconnected' || state === 'failed') {
      // Try to reconnect once
      setTimeout(() => {
        if (_djState && _djState.active && _djState.sessionId === sessionId) {
          _listenerPc = null;
          _listenerConnect(sessionId);
        }
      }, 2000);
    }
  };

  // Set remote description (offer from DJ)
  const offer = new RTCSessionDescription(JSON.parse(offerStr));
  await pc.setRemoteDescription(offer);

  // Listen for DJ ICE candidates
  const djCandPath = RTDB_DJ_SESSIONS + '/' + sessionId + '/djCandidates/' + _listenerNodeId;
  const djCandRef  = api.ref(rtdb, djCandPath);
  const candHandler = (snap) => {
    if (!snap || !snap.exists()) return;
    snap.forEach(child => {
      const cStr = child.val();
      if (!cStr) return;
      try {
        const c = JSON.parse(cStr);
        pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      } catch (_) {}
    });
  };
  api.onValue(djCandRef, candHandler);

  // Create answer
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  // Write answer to RTDB for DJ
  const answerPath = RTDB_DJ_SESSIONS + '/' + sessionId + '/listeners/' + _listenerNodeId + '/answer';
  const answerRef  = api.ref(rtdb, answerPath);
  await api.set(answerRef, JSON.stringify(pc.localDescription.toJSON())).catch(() => {});

  console.log('[SNX-DJ] Listener: answer sent to DJ');
}

function _listenerDisconnect() {
  if (_listenerAnswerUnsub) {
    try { _listenerAnswerUnsub(); } catch (_) {}
    _listenerAnswerUnsub = null;
  }
  if (_listenerPc) {
    try { _listenerPc.close(); } catch (_) {}
    _listenerPc = null;
  }
  if (_listenerAudio) {
    try {
      _listenerAudio.pause();
      _listenerAudio.srcObject = null;
      if (_listenerAudio.parentNode) _listenerAudio.parentNode.removeChild(_listenerAudio);
    } catch (_) {}
    _listenerAudio = null;
  }
  _listenerRemoteStream = null;

  // Remove my listener node from RTDB
  const api = _getApi();
  const rtdb = _getRtdb();
  if (api && rtdb && _listenerSessionId && _listenerNodeId) {
    const ref = api.ref(rtdb, RTDB_DJ_SESSIONS + '/' + _listenerSessionId + '/listeners/' + _listenerNodeId);
    api.remove(ref).catch(() => {});
  }

  _listenerNodeId    = null;
  _listenerSessionId = null;
  _stopStaleTimer();
  _unduckMusic();
}

/* ════════════════════════════════════════════════════════════
   STALE DETECTION (LISTENER SIDE)
   If DJ's heartbeat is not updated in STALE_TIMEOUT ms, force end.
════════════════════════════════════════════════════════════ */

let _hbUnsub = null;   // unsubscribe for heartbeat onValue

function _startStaleTimer(sessionId) {
  _stopStaleTimer();

  const rtdb = _getRtdb();
  const api  = _getApi();
  if (!rtdb || !api) return;

  const hbPath = RTDB_DJ_SESSIONS + '/' + sessionId + '/heartbeat';
  const hbRef  = api.ref(rtdb, hbPath);

  let lastSeen = Date.now();
  const hbHandler = (snap) => {
    if (snap && snap.val && typeof snap.val() === 'number') {
      lastSeen = snap.val();
    }
  };
  const hbOnValUnsub = api.onValue(hbRef, hbHandler);
  _hbUnsub = () => {
    if (typeof hbOnValUnsub === 'function') { try { hbOnValUnsub(); } catch (_) {} }
    else if (api.off) { try { api.off(hbRef, 'value', hbHandler); } catch (_) {} }
    _hbUnsub = null;
  };

  _staleTimer = setInterval(() => {
    if (Date.now() - lastSeen > STALE_TIMEOUT) {
      console.log('[SNX-DJ] DJ heartbeat stale — auto-ending DJ mode for listener');
      _stopStaleTimer();
      // Force end: simulate DJ went off-air
      _listenerDisconnect();
      _unduckMusic();
      // Notify UI
      if (typeof window.snxRadioDjStateChanged === 'function') {
        try { window.snxRadioDjStateChanged(null); } catch (_) {}
      }
    }
  }, 5000);
}

function _stopStaleTimer() {
  if (_staleTimer) { clearInterval(_staleTimer); _staleTimer = null; }
  if (_hbUnsub) { try { _hbUnsub(); } catch (_) {} _hbUnsub = null; }
}

/* ════════════════════════════════════════════════════════════
   MUSIC DUCKING
════════════════════════════════════════════════════════════ */

function _duckMusic() {
  const audio = _getRadioAudio();
  if (!audio) return;

  // Capture user's chosen volume before ducking
  _userVolume = audio.volume;

  const target = _userVolume * DUCK_LEVEL;
  _rampVolume(audio, audio.volume, target, DUCK_RAMP_MS);
}

function _unduckMusic() {
  const audio = _getRadioAudio();
  if (!audio) return;

  const cur = audio.volume;

  // If audio is at or near full user volume already, no need to ramp
  if (Math.abs(cur - _userVolume) < 0.02) return;

  _rampVolume(audio, cur, _userVolume, UNDUCK_RAMP_MS);
}

function _rampVolume(audio, from, to, durationMs) {
  if (_duckRamp) { cancelAnimationFrame(_duckRamp); _duckRamp = null; }

  const start    = performance.now();
  const fromVol  = Math.max(0, Math.min(1, from));
  const toVol    = Math.max(0, Math.min(1, to));

  const step = () => {
    const elapsed = performance.now() - start;
    const t       = Math.min(1, elapsed / durationMs);
    // Ease in-out cubic
    const ease    = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const vol     = fromVol + (toVol - fromVol) * ease;
    try { audio.volume = Math.max(0, Math.min(1, vol)); } catch (_) {}

    if (t < 1) {
      _duckRamp = requestAnimationFrame(step);
    } else {
      try { audio.volume = toVol; } catch (_) {}
      _duckRamp = null;
    }
  };

  _duckRamp = requestAnimationFrame(step);
}

function _getRadioAudio() {
  // Use the single Radio audio element
  return document.querySelector('audio[crossorigin="anonymous"]') || null;
}

/* ════════════════════════════════════════════════════════════
   FIRESTORE HELPERS
════════════════════════════════════════════════════════════ */

async function _writeDjState(fields) {
  const fs   = _getFirestore();
  const mods = _getFirestoreMods();
  if (!fs || !mods) return;

  try {
    const ref = mods.doc(fs, COL_SITE, DOC_DJ);
    await mods.setDoc(ref, fields, { merge: true });
  } catch (e) {
    console.error('[SNX-DJ] writeDjState error:', e.message);
    throw e;
  }
}

function _serverTimestamp() {
  const mods = _getFirestoreMods();
  if (mods && mods.serverTimestamp) return mods.serverTimestamp();
  return new Date();
}

/* ════════════════════════════════════════════════════════════
   DESTROY
════════════════════════════════════════════════════════════ */

function destroy() {
  if (_djActive) djEnd().catch(() => {});
  if (_listenerPc) _listenerDisconnect();
  if (_djStateUnsub) { try { _djStateUnsub(); } catch (_) {} _djStateUnsub = null; }
  _unduckMusic();
}

/* ════════════════════════════════════════════════════════════
   UTILITIES
════════════════════════════════════════════════════════════ */

function _getRtdb()       { return window._snxLiveDB    || null; }
function _getApi()        { return window._snxRtdbApi   || null; }
function _getExt()        { return window._snxRtdbExt   || null; }
function _getFirestore()  {
  return (window._snxFirestore && window._snxFirestore.db) ||
         (window.firebase && window.firebase.firestore && window.firebase.firestore()) || null;
}
function _getFirestoreMods() { return window._snxFirestore || null; }

function _randId() {
  const arr = new Uint8Array(10);
  (window.crypto || window.msCrypto).getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Log ── */
console.log('[SNX-DJ] snx-radio-dj.js loaded — version', DJ_VERSION);

})();
