/**
 * Shadow Nexus Social — Live System
 * live.js  (SNS-2026-LIVE-010)
 *
 * ONE canonical Live engine for Shadow Nexus Social.
 * ES module — loaded as <script type="module"> in index.html.
 *
 * Firebase paths (RTDB):
 *   liveRooms/{roomId}                        — room metadata
 *   liveSignaling/{roomId}/{viewerId}         — WebRTC signaling (normal viewers)
 *   liveSignaling/{roomId}/{viewerId}/hostCandidates/{key}   — host ICE (keyed)
 *   liveSignaling/{roomId}/{viewerId}/viewerCandidates/{key} — viewer ICE (keyed)
 *   livePresence/{roomId}/{viewerId}          — viewer presence
 *   liveChats/{roomId}/{msgId}                — chat messages
 *   guestSignaling/{roomId}/{guestUid}        — GUEST BOX WebRTC signaling (separate)
 *   guestSignaling/{roomId}/{guestUid}/offer             — host → guest SDP offer
 *   guestSignaling/{roomId}/{guestUid}/answer            — guest → host SDP answer
 *   guestSignaling/{roomId}/{guestUid}/hostCandidates/{key}  — host ICE for guest
 *   guestSignaling/{roomId}/{guestUid}/guestCandidates/{key} — guest ICE to host
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
 * FIXES (SNS-2026-LIVE-008):
 *   - PART 5 (complete): _fetchTurnConfig() added — fetches short-lived TURN
 *     credentials from /turn-credentials on the Cloudflare Worker (backed by
 *     LiveKit RTCService/GetICEServers). Called once at host _startLive() and
 *     once at guest _guestJoinAsViewer(). Credentials never hardcoded.
 *     Falls back to STUN-only silently if the fetch fails.
 *   - upload-worker.js: /turn-credentials endpoint added (handleTurnCredentials).
 *     Requires LIVEKIT_API_KEY + LIVEKIT_API_SECRET Worker secrets (already set).
 *     Requires Firebase ID token — unauthenticated callers get 401.
 *     Returns short-lived ICE servers with private, max-age=3000 Cache-Control.
 *
 * FIXES (SNS-2026-LIVE-007):
 *   - PART 1:  Production version tag updated to LIVE-006 in index.html.
 *   - PART 3:  Black-box ontrack race fixed. setGuestStream() is now called only
 *              after a live video track (readyState !== 'ended') exists in the
 *              remote stream. Per-UID remote streams are assembled additively as
 *              tracks arrive. Duplicate track insertion prevented. If only audio
 *              arrives first the box stays in CONNECTING state.
 *   - PART 4:  Host-only Remove Guest button added to each guest box.
 *              Uses existing _hostCleanupGuest(). Guests and plain viewers cannot
 *              see or trigger this control.
 *   - PART 5:  TURN configuration hook added to _ICE_CONFIG via window.__snxTurnConfig.
 *              STUN fallback preserved. No credentials hardcoded.
 *   - PART 6:  Guest media constraints already include echoCancellation,
 *              noiseSuppression, autoGainControl. Verified local guest preview
 *              video element is muted. No duplicate remote audio elements.
 *
 * FIXES (SNS-2026-LIVE-006):
 *   - GUEST BOX WEBRTC HANDOFF (SNX-GUEST-001):
 *     Full accepted-guest → media → WebRTC → signaling → host ontrack → box manager
 *     chain implemented. Supports up to 4 simultaneous guests.
 *     Separate guestSignaling path — does NOT touch liveSignaling.
 *     Each guest has isolated RTCPeerConnection, signaling listeners, ICE tracking.
 *     Host creates offer; guest acquires camera/mic, sets remote desc, answers.
 *     ICE candidates queued until remoteDescription ready (no silent drops).
 *     Host ontrack fires → window.snxBoxManager.addGuest / setGuestStream.
 *     Guest cleanup is isolated — other guests/viewers stay connected.
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
 *
 * ARCHITECTURE (SNS-2026-LIVE-010) — SFU MEDIA LAYER:
 *   snx-sfu.js introduces a provider-agnostic SFU façade (window.snxSfu).
 *   When snxSfu is loaded, the host/guest/viewer media paths use LiveKit SFU
 *   instead of direct peer-to-peer RTCPeerConnection.
 *
 *   Firebase/Firestore handles ONLY metadata:
 *     - liveRooms/{roomId}          room metadata + status
 *     - boxRequests                 join requests (Firestore)
 *     - guestRequests/{roomId}      join requests (RTDB backup)
 *     - liveChats/{roomId}          chat messages
 *     - livePresence/{roomId}       viewer presence / count
 *     - guestSignaling/{roomId}     accepted-guest hostEnded signals only
 *
 *   Firebase does NOT carry audio/video.
 *   All WebRTC media goes through the SFU (LiveKit).
 *
 *   SFU provider: LiveKit (wss URL + JWT from Cloudflare Worker)
 *   Fallback: existing direct RTCPeerConnection (P2P) when snxSfu absent.
 */

import {
  ref, set, get, update, remove, push,
  onValue, off, onDisconnect, query, limitToLast,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ══════════════════════════════════════════════════════════
   ICE CONFIGURATION
   STUN servers are always present.
   TURN servers are fetched once per session from the Cloudflare
   Worker endpoint /turn-credentials (backed by LiveKit) and stored
   in window.__snxTurnConfig.  _buildIceConfig() merges them in.
   Short-lived credentials (~1 h TTL) are fetched fresh each Live
   session so they are never stale or hardcoded.
════════════════════════════════════════════════════════════ */
const _STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

// Worker base URL — matches the existing upload worker used by the project.
const _WORKER_BASE = 'https://yellow-term-11e6.nthntjrn.workers.dev';

function _buildIceConfig() {
  const turn = window.__snxTurnConfig;
  const extra = Array.isArray(turn) && turn.length ? turn : [];
  return { iceServers: [..._STUN_SERVERS, ...extra] };
}

// Re-evaluated each time a new RTCPeerConnection is created so that
// a late-arriving __snxTurnConfig is picked up automatically.
const _ICE_CONFIG = { iceServers: _STUN_SERVERS };  // kept for backward compat; peers call _buildIceConfig()

/**
 * Fetch short-lived TURN credentials from the Shadow Nexus Cloudflare Worker
 * and store them in window.__snxTurnConfig.
 *
 * Endpoint: GET /snx-live/turn
 * Authentication: Firebase ID token (Bearer)
 * Returns:  { iceServers: [...] }  — coturn HMAC-time-limited credentials.
 *
 * Silently falls back to STUN-only if the request fails — the session
 * still works on same-network; cross-NAT may fail without TURN.
 *
 * NOTE: This replaced the old /turn-credentials endpoint which sourced
 * TURN credentials from LiveKit Cloud's infrastructure.  Self-hosted
 * coturn is now the only TURN provider.
 */
async function _fetchTurnConfig() {
  try {
    const user = _user();
    if (!user) return;

    let idToken = null;
    try {
      const auth = window._snxAuth;
      if (auth && auth.currentUser && typeof auth.currentUser.getIdToken === 'function') {
        idToken = await auth.currentUser.getIdToken();
      }
    } catch (_) {}

    if (!idToken) {
      _log('TURN: no ID token — skipping, STUN-only');
      return;
    }

    const resp = await fetch(_WORKER_BASE + '/snx-live/turn', {
      method:  'GET',
      headers: { 'Authorization': 'Bearer ' + idToken },
    });

    if (!resp.ok) {
      _log('TURN: worker returned ' + resp.status + ' — STUN-only fallback');
      return;
    }

    const data = await resp.json();
    const servers = data.iceServers;
    if (!Array.isArray(servers) || !servers.length) {
      _log('TURN: empty iceServers from worker — STUN-only fallback');
      return;
    }

    // Accept all entries (STUN + TURN) from our own coturn server
    window.__snxTurnConfig = servers;
    _log('TURN: configured — ' + servers.length + ' ICE server(s) from self-hosted coturn');
  } catch (e) {
    _log('TURN: fetch failed (' + e.message + ') — STUN-only fallback');
  }
}

/* ══════════════════════════════════════════════════════════
   STALE SESSION DETECTION
════════════════════════════════════════════════════════════ */
const HB_INTERVAL_MS    = 15000;
const STALE_THRESHOLD_MS = 90000;

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
  hostRoomId:     null,
  hostSessionId:  null,
  hostStream:     null,
  hostCamOn:      true,
  hostMicOn:      true,
  hostPeers:      {},
  hostSigRef:     null,
  hostHbTimer:    null,
  hostCountTimer: null,
  hostStartedAt:  null,
  hostEnded:      false,
  hostReqUnsub:    null,   // RTDB guestRequests listener unsub (host side)
  hostShownReqs:   null,   // Set of viewer UIDs whose card has been shown
  hostSpeakerTimer: null,  // active-speaker polling timer (host stage)
  hostSfuToken:    null,   // LiveKit JWT for the host (null when SFU unavailable)
  hostSfuUrl:      null,   // LiveKit WSS URL for the host session
  /* viewer */
  viewRoomId:    null,
  viewSessId:    null,
  viewPc:        null,
  viewPresRef:   null,
  viewUnsubs:    [],
  viewConnTimeout: null,  // 30-second connection watchdog
  viewReqUnsub:  null,    // Firestore boxRequest status listener unsub (viewer side)
  viewSfuToken:  null,    // LiveKit JWT when viewer is connected via SFU
  /* guest stage */
  _guestStageOpen: false, // true while guest is active in the multi-box stage
  /* hub */
  hubRef:        null,
  hubCb:         null,
};

/* ══════════════════════════════════════════════════════════
   SFU HELPERS
   Wrapper utilities for the snxSfu media layer.
   All calls are no-ops if snxSfu is not loaded (P2P fallback).
════════════════════════════════════════════════════════════ */

/**
 * True when snx-sfu.js has been loaded and the SNX media server provider is ready.
 * When false, live.js falls back to the P2P mesh — which has known limitations:
 *   - guests CANNOT see other guests
 *   - viewers CANNOT see guests
 *   - host creates one RTCPeerConnection per viewer (does not scale)
 * Never claim multi-guest distribution is working when SFU is unavailable.
 */
function _sfuAvailable() {
  return typeof window.snxSfu === 'object' && window.snxSfu !== null;
}

/**
 * Build the SFU callback object for host-stage participant tracking.
 * Wires SFU track events → snxBoxManager box state (LIVE only on real media).
 */
function _buildHostSfuCallbacks(hostUid) {
  return {
    onConnected(uid) {
      _log('[SFU] host connected to room as: ' + uid);
    },
    onDisconnected() {
      _log('[SFU] host disconnected from room');
    },
    onConnectionStateChange(state) {
      _log('[SFU] connection state: ' + state);
    },
    onParticipantJoined(uid, name) {
      // A guest joined the SFU room — add their box in CONNECTING state.
      // Box becomes LIVE only after onTrackSubscribed fires.
      if (uid === hostUid) return; // skip self
      _log('[SFU] participant joined: ' + uid + ' (' + name + ')');
      window.snxBoxManager.addGuest(uid, name || uid, '');
    },
    onParticipantLeft(uid) {
      if (uid === hostUid) return;
      _log('[SFU] participant left: ' + uid);
      window.snxBoxManager.removeGuest(uid);
    },
    onTrackSubscribed(uid, stream) {
      // Real media arrived — transition box from CONNECTING → LIVE.
      _log('[SFU] track subscribed: ' + uid + ' tracks=' + stream.getTracks().length);
      window.snxBoxManager.setGuestStream(uid, stream);
    },
    onTrackUnsubscribed(uid) {
      _log('[SFU] track unsubscribed: ' + uid);
      window.snxBoxManager.setGuestState(uid, 'disconnected');
    },
    onTrackMuteChanged(uid, kind, muted) {
      if (kind === 'video') {
        const box = _boxState.get(uid);
        if (box) {
          const co = box.el.querySelector('.snx-box-cam-off');
          if (co) co.classList.toggle('show', muted);
        }
      }
    },
    onActiveSpeakersChanged(uids) {
      _boxState.forEach((box, bUid) => {
        box.el.classList.toggle('snx-box-speaking', uids.includes(bUid));
      });
      // Also apply to host box (host uid is host speaking when they're in the list)
      const hostBox = _boxState.get('_host_');
      if (hostBox) {
        hostBox.el.classList.toggle('snx-box-speaking', uids.includes(hostUid));
      }
    },
    onError(err) {
      console.error('[SFU] error:', err);
    },
  };
}

/**
 * Build the SFU callback object for the viewer screen.
 *
 * This handles MULTIPLE publishers (host + guests).  The first publisher's
 * stream is attached to the solo viewer video (which hides the loader and
 * starts playback).  When additional publishers join (guests), we add them
 * into the box grid via snxBoxManager so the viewer sees HOST + GUEST(s).
 *
 * Layout transitions:
 *   1 publisher  → solo video element (snxLiveViewerVideo)
 *   2+ publishers → box grid (host box + guest box(es)) via snxBoxManager
 *
 * The viewer never publishes camera/mic.
 */
function _buildViewerSfuCallbacks(roomId) {
  // Track the first UID whose stream was attached to the solo video.
  // When a second participant arrives we must switch to box-grid mode.
  let _soloUid = null;

  function _attachSoloVideo(stream) {
    const video = _el('snxLiveViewerVideo');
    if (!video) return;
    video.srcObject = stream;
    const p = video.play();
    if (p) {
      p.then(() => {
        _clearViewerTimeout();
        _setViewerStatus('playing');
      }).catch(() => _setViewerStatus('tap-to-play'));
    }
  }

  function _ensureViewerBoxGrid(hostUid, hostStream) {
    // Lazily build the box grid on the viewer stage when guests appear.
    // Only call this once — guard with _boxState.
    if (_boxState.has('_host_')) return;  // already built

    // Hide solo video; box grid will cover it
    const viewerVid = _el('snxLiveViewerVideo');
    if (viewerVid) viewerVid.style.display = 'none';

    // Build host box using the stream we already have
    _ensureBoxGrid();
    const hostBox = _buildBox('_host_', 'HOST', 'host');
    const grid = document.querySelector('.snx-live-boxes');
    if (grid) grid.appendChild(hostBox.el);
    _boxState.set('_host_', hostBox);
    if (hostStream) {
      hostBox.videoEl.srcObject = hostStream;
      hostBox.videoEl.muted = false;
      hostBox.videoEl.play().catch(() => {});
      _setBxState('_host_', 'ready');
    }
    _recalcLayout();
  }

  return {
    onConnected(uid) {
      _log('[SFU] viewer connected: ' + uid);
      _setViewerStatus('connected');
      _clearViewerTimeout();
    },
    onDisconnected() {
      _log('[SFU] viewer disconnected');
    },
    onConnectionStateChange(state) {
      _log('[SFU] viewer connection state: ' + state);
      if (state === 'reconnecting') _setViewerStatus('connecting');
      if (state === 'connected')    _setViewerStatus('connected');
      if (state === 'removed')      _setViewerStatus('ended');
      if (state === 'ended')        _setViewerStatus('ended');
    },
    onParticipantJoined(uid, name) {
      _log('[SFU] viewer sees participant: ' + uid);
      // If we are already in box-grid mode (2+ participants), add a guest box.
      if (_boxState.size > 0 && uid !== _soloUid) {
        window.snxBoxManager.addGuest(uid, name || uid, '');
      }
    },
    onParticipantLeft(uid) {
      _log('[SFU] viewer: participant left: ' + uid);
      if (uid === _soloUid) {
        // Host left — clear solo video
        const video = _el('snxLiveViewerVideo');
        if (video) { video.srcObject = null; video.style.display = ''; }
        _soloUid = null;
        _setViewerStatus('ended');
      } else if (_boxState.has(uid)) {
        window.snxBoxManager.removeGuest(uid);
        // If only the host box remains, collapse back to solo video
        if (_boxState.size === 1 && _boxState.has('_host_')) {
          const hostBox = _boxState.get('_host_');
          const hostStream = hostBox ? hostBox.videoEl.srcObject : null;
          // Remove the box grid and go back to solo video
          _boxState.forEach(b => { if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el); });
          _boxState.clear();
          const viewerVid = _el('snxLiveViewerVideo');
          if (viewerVid && hostStream) {
            viewerVid.srcObject = hostStream;
            viewerVid.style.display = '';
            viewerVid.play().catch(() => {});
          }
          const stage = _getStage();
          if (stage) { delete stage.dataset.boxes; delete stage.dataset.layout; }
        }
      }
    },
    onTrackSubscribed(uid, stream) {
      _log('[SFU] viewer track subscribed from: ' + uid + ' tracks=' + stream.getTracks().length);

      if (!_soloUid) {
        // ── First publisher (host) — attach to solo video ──
        _soloUid = uid;
        _attachSoloVideo(stream);

      } else if (uid === _soloUid) {
        // ── Same publisher, stream updated (new track added) ──
        if (_boxState.has('_host_')) {
          // In box-grid mode: update host box stream
          const hostBox = _boxState.get('_host_');
          if (hostBox) {
            hostBox.videoEl.srcObject = stream;
            hostBox.videoEl.play().catch(() => {});
            _setBxState('_host_', 'ready');
          }
        } else {
          // Still solo mode: update solo video
          _attachSoloVideo(stream);
        }

      } else {
        // ── Second+ publisher (guest joined) ──
        // Transition from solo to box grid if not already in grid mode.
        if (!_boxState.has('_host_')) {
          // Grab the existing solo video stream for the host box
          const soloVideo = _el('snxLiveViewerVideo');
          const existingHostStream = soloVideo ? soloVideo.srcObject : null;
          _ensureViewerBoxGrid(_soloUid, existingHostStream);
        }
        // Add or update guest box
        if (!_boxState.has(uid)) {
          window.snxBoxManager.addGuest(uid, uid, '');
        }
        window.snxBoxManager.setGuestStream(uid, stream);
      }
    },
    onTrackUnsubscribed(uid) {
      _log('[SFU] viewer track unsubscribed: ' + uid);
      if (uid === _soloUid && !_boxState.has('_host_')) {
        // Solo host stream lost
        const video = _el('snxLiveViewerVideo');
        if (video) video.srcObject = null;
      } else if (_boxState.has(uid)) {
        window.snxBoxManager.setGuestState(uid, 'disconnected');
      }
    },
    onTrackMuteChanged() {},
    onActiveSpeakersChanged(uids) {
      // Apply speaking indicator to boxes if in grid mode
      _boxState.forEach((box, bUid) => {
        const mappedUid = (bUid === '_host_') ? _soloUid : bUid;
        box.el.classList.toggle('snx-box-speaking', uids.includes(mappedUid));
      });
    },
    onError(err) {
      console.error('[SFU] viewer error:', err);
      _setViewerStatus('failed');
    },
  };
}

/**
 * Build the SFU callback object for a guest who has been accepted.
 * Drives the guest-side two-box stage (HOST + YOU).
 */
function _buildGuestSfuCallbacks(roomId, localStream) {
  return {
    onConnected(uid) {
      _log('[SFU] guest connected as: ' + uid);
    },
    onDisconnected() {
      _log('[SFU] guest SFU disconnected');
      _guestLeaveStage(false);
    },
    onConnectionStateChange(state) {
      _log('[SFU] guest connection state: ' + state);
      if (state === 'reconnecting') {
        // Update host box to show reconnecting state
        const hostBox = _boxState.get('_host_');
        if (hostBox) _setBxState('_host_', 'connecting');
      }
    },
    onParticipantJoined(uid, name) {
      _log('[SFU] guest sees participant: ' + uid);
    },
    onParticipantLeft(uid) {
      _log('[SFU] guest: participant left: ' + uid);
    },
    onTrackSubscribed(uid, stream) {
      // Host's stream arrived — update the host box.
      _log('[SFU] guest received host track — uid:', uid);
      const hostBox = _boxState.get('_host_');
      if (hostBox) {
        hostBox.videoEl.srcObject = stream;
        hostBox.videoEl.muted = false;
        hostBox.videoEl.play().catch(() => {});
        _setBxState('_host_', 'ready');
      }
    },
    onTrackUnsubscribed() {},
    onTrackMuteChanged() {},
    onActiveSpeakersChanged(uids) {
      const hostBox = _boxState.get('_host_');
      if (hostBox) hostBox.el.classList.toggle('snx-box-speaking', uids.length > 0);
    },
    onError(err) {
      console.error('[SFU] guest error:', err);
    },
  };
}

/* ══════════════════════════════════════════════════════════
   PUBLIC API
════════════════════════════════════════════════════════════ */

window.goLiveOrWatch = function() { window.snxLiveOpenGoLive(); };

window.snxLiveOpenGoLive = function() {
  _log('[LIVE] GO LIVE clicked');
  const user = _user();
  if (!user) {
    _log('[LIVE] GO LIVE — no auth user, aborting');
    if (typeof toastNotification === 'function') toastNotification('⛔ Log in to go live.');
    return;
  }
  _log('[LIVE] GO LIVE — auth OK, opening setup screen');
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
  console.log('[LIVE] 7 snxLivePageOpen called');
  _log('[LIVE] init started — snxLivePageOpen');
  _log('[LIVE] auth ready — user=' + (_user() ? _user().uid.slice(0,8) + '…' : 'null'));
  _log('[LIVE] db ready — _db()=' + (!!_db()));
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
  _log('[LIVE] host startup entered');
  _log('[LIVE] requesting media');
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

  // Fetch fresh TURN credentials before creating any peer connections.
  // Non-blocking: if it fails we fall back to STUN-only transparently.
  await _fetchTurnConfig();

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

  _S.hostRoomId     = roomId;
  _S.hostSessionId  = sessionId;
  _S.hostStream     = localStream;
  _S.hostCamOn      = camOn;
  _S.hostMicOn      = micOn;
  _S.hostPeers      = {};
  _S.hostEnded      = false;
  _S.hostStartedAt  = startedAt;
  _S.hostSfuToken   = null;
  _S.hostSfuUrl     = null;

  // ── SFU media path (mediasoup) ────────────────────────────────────────────
  // When snxSfu is loaded, connect to the SNX mediasoup server and publish.
  // On failure, fall through silently to the P2P path.
  if (_sfuAvailable()) {
    _log('[SFU] Host: connecting — provider: ' + window.snxSfu.providerType + ' roomId: ' + roomId);
    console.log('[SNX LIVE] Media provider:', window.snxSfu.providerType);
    try {
      await window.snxSfu.ensureRoom(roomId);
      const ud2 = _userData();
      const { token, url: sfuUrl } = await window.snxSfu.fetchToken(
        roomId, user.uid, /* canPublish */ true
      );
      _S.hostSfuToken = token;
      _S.hostSfuUrl   = sfuUrl;
      await window.snxSfu.connect({
        sfuUrl,
        token,
        roomName:  roomId,
        uid:       user.uid,
        role:      'host',
        callbacks: _buildHostSfuCallbacks(user.uid),
      });
      await window.snxSfu.publishLocalStream(localStream);
      _log('[SFU] Host connected and publishing');
    } catch (sfuErr) {
      console.error('[SFU] Host connect failed — falling back to P2P:', sfuErr.message);
      window.snxSfu.disconnect();
      _S.hostSfuToken = null;
      _S.hostSfuUrl   = null;
    }
  }

  // ── P2P path — direct RTCPeerConnection to each viewer ───────────────────
  // Always active: handles viewers who join without SFU,
  // and acts as the sole transport when SFU is unavailable.
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
  const pc = new RTCPeerConnection(_buildIceConfig());
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
    // Update local track enabled state (affects P2P viewers immediately)
    if (_S.hostStream) _S.hostStream.getVideoTracks().forEach(t => { t.enabled = _S.hostCamOn; });
    // Also notify SFU (mutes the published track at the SFU level)
    if (_sfuAvailable()) window.snxSfu.setCamMuted(!_S.hostCamOn);
    camBtn.classList.toggle('off', !_S.hostCamOn);
    camBtn.textContent = _S.hostCamOn ? '📷' : '🚫';
    const co = _el('snxLiveStageCamOff');
    if (co) co.classList.toggle('show', !_S.hostCamOn);
  });

  const micBtn = _el('snxLiveHostMicBtn');
  if (micBtn) micBtn.addEventListener('click', () => {
    _S.hostMicOn = !_S.hostMicOn;
    // Update local track enabled state
    if (_S.hostStream) _S.hostStream.getAudioTracks().forEach(t => { t.enabled = _S.hostMicOn; });
    // Also notify SFU
    if (_sfuAvailable()) window.snxSfu.setMicMuted(!_S.hostMicOn);
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

  // ── Active speaker detection — host stage ──
  // Polls inbound-rtp audio levels from each guest peer every 1.5 s.
  // Adds .snx-box-speaking to the corresponding guest box.
  // Host box is tracked by local mic enabled state.
  const SPEAKER_INTERVAL = 1500;
  const SPEAKER_THRESHOLD = 0.01;
  _S.hostSpeakerTimer = setInterval(async () => {
    for (const [guestUid, peer] of _guestPeers) {
      const box = _boxState.get(guestUid);
      if (!box || !peer.pc || !peer.pc.getStats) continue;
      try {
        const stats = await peer.pc.getStats();
        let level = 0;
        stats.forEach(r => {
          if (r.type === 'inbound-rtp' && r.kind === 'audio') {
            level = Math.max(level, r.audioLevel || 0);
          }
        });
        box.el.classList.toggle('snx-box-speaking', level > SPEAKER_THRESHOLD);
      } catch (_) {}
    }
    // Host self — reflect mic enabled state
    const hostBox = _boxState.get('_host_');
    if (hostBox && _S.hostStream) {
      const at = _S.hostStream.getAudioTracks();
      hostBox.el.classList.toggle('snx-box-speaking', at.length > 0 && at[0].enabled && _S.hostMicOn);
    }
  }, SPEAKER_INTERVAL);

  // ── Shadow Chat Bot AI moderation panel (host only) ──
  _initLiveModerationPanel(roomId);
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

  if (_S.hostHbTimer)       { clearInterval(_S.hostHbTimer);       _S.hostHbTimer       = null; }
  if (_S.hostCountTimer)    { clearInterval(_S.hostCountTimer);    _S.hostCountTimer    = null; }
  if (_S.hostSpeakerTimer)  { clearInterval(_S.hostSpeakerTimer);  _S.hostSpeakerTimer  = null; }
  if (_S._hostSigOff)       { _S._hostSigOff(); _S._hostSigOff = null; }
  if (_S.hostReqUnsub)      { try { _S.hostReqUnsub(); } catch (_) {} _S.hostReqUnsub = null; }

  if (presRef && presCb) try { off(presRef, 'value', presCb); } catch (_) {}

  for (const key of Object.keys(_S.hostPeers)) {
    if (key.endsWith('_cleanup')) { try { _S.hostPeers[key](); } catch (_) {} }
    else { try { _S.hostPeers[key].close(); } catch (_) {} }
  }
  _S.hostPeers = {};

  // ── Tear down all guest peer connections ──
  _hostCleanupAllGuests(roomId, db);

  // ── Disconnect SFU ──
  if (_sfuAvailable()) {
    try { window.snxSfu.disconnect(); } catch (_) {}
  }
  _S.hostSfuToken = null;
  _S.hostSfuUrl   = null;

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
  _destroyLiveModerationPanel();

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
  console.log('[LIVE] 8 Live RTDB listener attaching');
  _log('[LIVE] list subscription attaching');
  const container = _el('snxLiveHubCards');
  if (!container) {
    _log('[LIVE] list subscription — snxLiveHubCards not found in DOM');
    return;
  }

  const db = _db();
  if (!db) {
    _log('[LIVE] list subscription — _db() null, retrying in 500ms');
    container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>Live is loading…</div>';
    setTimeout(() => { if (_db()) _renderHub(); }, 500);
    return;
  }

  if (_S.hubRef && _S.hubCb) { try { off(_S.hubRef, 'value', _S.hubCb); } catch (_) {} }

  const roomsRef = ref(db, 'liveRooms');
  _log('[LIVE] list subscription ready — listening to liveRooms');
  const hubCb = onValue(roomsRef, (snap) => {
    console.log('[LIVE] 9 Live RTDB first callback');
    container.innerHTML = '';
    if (!snap.exists()) {
      _log('[LIVE] list subscription ready — 0 rooms (snap does not exist)');
      container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>No one is live right now.</div>';
      return;
    }
    const active = _filterActiveRooms(snap.val());
    _log('[LIVE] list subscription ready — active rooms: ' + active.length);
    if (!active.length) {
      container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>No one is live right now.</div>';
      return;
    }
    active.forEach(room => container.appendChild(_buildHubCard(room)));
  }, (err) => {
    _log('[LIVE] list subscription error — ' + err.code + ': ' + err.message);
    container.innerHTML = '<div class="live-hub-empty"><span class="live-hub-empty-icon">📡</span>Unable to load live streams.</div>';
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
  // When the guest stage is open the loader must stay hidden regardless of
  // P2P viewer PC state changes that would otherwise re-show it.
  if (_S._guestStageOpen) return;
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

  // ── SFU viewer path ───────────────────────────────────────────────────────
  // When snxSfu is available, the viewer connects to the mediasoup room as a
  // subscriber.  The SFU streams all publisher tracks — no P2P signaling needed.
  if (_sfuAvailable()) {
    console.log('[SNX LIVE] Media provider:', window.snxSfu.providerType);
    _log('[SFU] Viewer: connecting to room ' + roomId + ' provider: ' + window.snxSfu.providerType);
    try {
      const { token, url: sfuUrl } = await window.snxSfu.fetchToken(
        roomId, user.uid, /* canPublish */ false
      );
      _S.viewSfuToken = token;
      await window.snxSfu.connect({
        sfuUrl,
        token,
        roomName:  roomId,
        uid:       user.uid,
        role:      'viewer',
        callbacks: _buildViewerSfuCallbacks(roomId),
      });
      _log('[SFU] Viewer connected — room: ' + roomId);
      // SFU handles track delivery; no P2P signaling needed for this viewer.
      // We still run presence + chat below (Firebase metadata only).
    } catch (sfuErr) {
      console.error('[SFU] Viewer connect failed — falling back to P2P:', sfuErr.message);
      if (_sfuAvailable()) window.snxSfu.disconnect();
      _S.viewSfuToken = null;
      // Fall through to P2P path
    }
  }

  // ── P2P fallback path — signal host that viewer is ready ─────────────────
  // Runs when SFU is unavailable. The host creates a P2P offer for this viewer.
  _vLog('signaling-started', 'roomId=' + roomId + ' sessId=' + sessId);
  const sigPath = 'liveSignaling/' + roomId + '/' + sessId;
  if (!_S.viewSfuToken) {
    // Only write viewerReady when NOT using SFU (avoids unnecessary host P2P overhead)
    try {
      await set(ref(db, sigPath + '/viewerReady'), true);
      _vLog('viewer-ready-written', 'path=' + sigPath + '/viewerReady');
    } catch (e) {
      _vErr('viewer-ready-written', e, sigPath + '/viewerReady', roomId, sessId);
      console.error('[LIVE-VIEWER] CRITICAL — cannot write viewerReady to liveSignaling/' +
        roomId + '/' + sessId + ' | code=' + (e.code || e.message));
    }
  }

  // ── 30-second connection watchdog (P2P path only) ──
  _S.viewConnTimeout = setTimeout(() => {
    // Fire only if no SFU connection and no P2P connection established
    if (_S.viewSfuToken) return;
    if (!_S.viewPc || _S.viewPc.connectionState === 'connected') return;
    _vLog('connection-state', 'TIMEOUT — no connection after 30s roomId=' + roomId);
    _setViewerStatus('timeout');
    _showViewerTimeoutUI(roomId, sessId, db, room);
  }, 30000);

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
      pc = new RTCPeerConnection(_buildIceConfig());
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
  // Disconnect viewer from SFU
  if (_S.viewSfuToken && _sfuAvailable()) {
    try { window.snxSfu.disconnect(); } catch (_) {}
  }
  _S.viewSfuToken = null;
  // Clean up any pending Request-to-Join status listener
  if (_S.viewReqUnsub) { try { _S.viewReqUnsub(); } catch (_) {} _S.viewReqUnsub = null; }
  // Stop guest stage (does NOT recurse — _guestViewerCleanup is called below)
  if (_guestStageActive) {
    _guestStageActive = false;
    _S._guestStageOpen = false;
    _stopGuestSpeakerDetection();
    const stage = _getStage();
    if (stage) {
      stage.classList.remove('is-guest-stage');
      const dock = stage.querySelector('.snx-guest-controls');
      if (dock) dock.remove();
      delete stage.dataset.boxes;
      delete stage.dataset.layout;
    }
  } else {
    _S._guestStageOpen = false;
  }
  // Clean up guest connection if viewer was in a guest box
  _guestViewerCleanup();
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
const _CHAT_MSG_TTL_MS  = 15000;

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

    // ── Shadow Chat Bot AI moderation — asynchronous, non-blocking ──────────
    // Runs AFTER the comment is cleared from the input so there is no
    // perceptible delay. snxAIScan writes to aiModerationLog, issues warnings,
    // and may return true (blocked) for hard violations.
    // If AI is unavailable Live continues normally — this is fire-and-forget.
    let _aiBlocked = false;
    if (typeof window.snxAIScan === 'function' && window._aiModerationEnabled !== false) {
      try {
        _aiBlocked = await window.snxAIScan(text, 'live comment');
      } catch (_) { /* AI failure never blocks Live */ }
    }
    if (_aiBlocked) return;   // hard-blocked by AI (e.g. threats) — do not send

    try {
      await set(push(chatRef), { uid: user.uid, username, text, createdAt: Date.now() });
    } catch (e) { _err('chat','RTDB','push', e.name, e.message); }

    // ── Notify host moderation panel of any flag ──────────────────────────
    // _aiBlocked is already false here (returned above if true).
    // snxAIScan warns for warn-severity content but still returns false —
    // surface those flags in the host panel via the moderation log listener.
  }

  if (sendBtn) sendBtn.addEventListener('click', _sendMsg);
  if (inputEl) inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _sendMsg(); } });
}

/* ══════════════════════════════════════════════════════════
   STAGE 7 — LIKES
════════════════════════════════════════════════════════════ */
/* ── Like count display helper ── */
function _fmtLikes(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
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
  // Host box is always muted (prevents local echo).
  // Guest boxes are NOT muted — host must hear guest audio.
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

  // HOST-ONLY: Remove Guest button
  // Visible only when the stage has class .is-host (CSS) AND only present
  // in the DOM when role === 'guest' — host cannot remove themselves.
  if (role === 'guest') {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'snx-box-remove-btn';
    removeBtn.setAttribute('aria-label', 'Remove guest');
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Double-check we are on the host stage before acting
      const stage = _getStage();
      if (!stage || !stage.classList.contains('is-host')) return;
      // Use existing backend cleanup
      const roomId = _S.hostRoomId;
      const db     = _db();
      if (roomId && db) {
        _hostCleanupGuest(uid, roomId, db);
      }
      window.snxBoxManager.removeGuest(uid);
    });
    el.appendChild(removeBtn);
  }

  return { uid, name, role, state: 'connecting', el, videoEl };
}

// ── Set box visual state ──
// state: 'connecting' | 'ready' | 'disconnected' | 'failed'
function _setBxState(uid, state) {
  const box = _boxState.get(uid);
  if (!box) return;
  box.state = state;
  box.el.dataset.state = state;
  const conn = box.el.querySelector('.snx-box-connecting');
  const disc = box.el.querySelector('.snx-box-disconnected');
  if (conn) conn.classList.toggle('show', state === 'connecting');
  if (disc) {
    if (state === 'disconnected') {
      disc.classList.add('show');
      const txt = disc.querySelector('.snx-box-disconnected-text');
      if (txt) txt.textContent = 'Connection lost…';
    } else if (state === 'failed') {
      disc.classList.add('show');
      const txt = disc.querySelector('.snx-box-disconnected-text');
      if (txt) txt.textContent = 'CONNECTION FAILED';
    } else {
      disc.classList.remove('show');
    }
  }
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
      // ── GUEST BOX HANDOFF ──
      console.log('[SNX-GUEST] accepted — starting guest media + signaling');
      _guestJoinAsViewer(roomId, db, btn);

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
            // ── GUEST BOX HANDOFF ──
            console.log('[SNX-HOST-GUEST] accept complete — starting host guest peer for uid:', uid);
            _hostAcceptGuest(uid, { name: d.viewerName || 'Guest', avatar: d.viewerProfileImage || '' }, roomId, db);
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
            console.log('[SNX-HOST-GUEST] accept (RTDB fallback) — starting host guest peer for uid:', uid);
            _hostAcceptGuest(uid, { name: req.name || 'Guest', avatar: req.avatar || '' }, roomId, db);
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

  /**
   * Add a guest box in CONNECTING state.
   * Stream is attached later via setGuestStream() once WebRTC tracks arrive.
   * @param {string} uid
   * @param {string} name
   * @param {string} [avatarUrl]  — optional avatar URL for camera-off placeholder
   */
  addGuest(uid, name, avatarUrl) {
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

    _recalcLayout();
    _log('Box added uid=' + uid + ' total=' + _boxState.size);
  },

  /** Attach a MediaStream to an existing guest box once WebRTC track arrives. */
  setGuestStream(uid, stream) {
    const box = _boxState.get(uid);
    if (!box || !stream) {
      console.error('[DIAG-31] setGuestStream — box or stream missing uid:', uid,
        'box:', !!box, 'stream:', !!stream);
      return;
    }
    // ── DIAG STEP 31 — VIDEO srcObject ASSIGNED ──
    console.log('[DIAG-31] VIDEO srcObject ASSIGNED — uid:', uid,
      'stream.id:', stream.id,
      'tracks:', stream.getTracks().map(t => t.kind + ':' + t.readyState).join(', '),
      'autoplay:', box.videoEl.autoplay,
      'playsInline:', box.videoEl.playsInline,
      'muted:', box.videoEl.muted);
    box.videoEl.srcObject = stream;
    // ── DIAG STEP 32 — VIDEO play() ──
    box.videoEl.play().then(() => {
      console.log('[DIAG-32] VIDEO play() SUCCESS — uid:', uid);
    }).catch(err => {
      console.error('[DIAG-32] VIDEO play() FAILED — uid:', uid, err.name, err.message);
    });
    _setBxState(uid, 'ready');
    _log('Box stream ready uid=' + uid);
  },

  /** Update guest box visual state: 'connecting' | 'ready' | 'disconnected' | 'failed' */
  setGuestState(uid, state) {
    _setBxState(uid, state);
    if (state === 'disconnected') {
      // Auto-remove after brief visible "Connection lost" period
      setTimeout(() => {
        if (_boxState.has(uid)) window.snxBoxManager.removeGuest(uid);
      }, 2000);
    }
    // 'failed' state: keep box visible with CONNECTION FAILED text.
    // Host can remove manually via the ✕ button.
    // Do NOT auto-remove so the host can see which connection failed.
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
    }, 30000);
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

/* ══════════════════════════════════════════════════════════
   GUEST BOX WEBRTC ENGINE  (SNX-GUEST-001)

   Architecture:
     HOST side  — _hostAcceptGuest(), _hostCleanupGuest(), _hostCleanupAllGuests()
     VIEWER side — _guestJoinAsViewer(), _guestViewerCleanup()

   Signaling path (SEPARATE from liveSignaling):
     guestSignaling/{roomId}/{guestUid}/offer
     guestSignaling/{roomId}/{guestUid}/answer
     guestSignaling/{roomId}/{guestUid}/hostCandidates/{key}
     guestSignaling/{roomId}/{guestUid}/guestCandidates/{key}

   State:
     _guestPeers              Map<uid, { pc, sigUnsub, name, avatar }>
     _guestViewerPc           RTCPeerConnection|null   (viewer-side guest PC)
     _guestViewerStream       MediaStream|null          (viewer local cam/mic)
     _guestViewerSigUnsub     Function|null             (viewer host-ICE listener)
     _guestViewerReconnTimer  number|null               (reconnect timer)
════════════════════════════════════════════════════════════ */

/* ── Guest state (module-level) ── */
const _guestPeers = new Map();    // host side: uid → { pc, sigUnsub, name, avatar }

let _guestViewerPc           = null;   // viewer side: their RTCPeerConnection
let _guestViewerStream       = null;   // viewer side: camera/mic MediaStream
let _guestViewerSigUnsub     = null;   // viewer side: host ICE listener
let _guestViewerReconnTimer  = null;   // viewer side: reconnect/cleanup timer
let _guestViewerRoomId       = null;   // viewer side: roomId for cleanup
let _guestViewerUid          = null;   // viewer side: own uid for cleanup

// Guest stage state (viewer who was accepted as a guest)
let _guestStageActive        = false;  // true when guest multi-box stage is open
let _guestStageSpeakerTimer  = null;   // active-speaker polling timer
let _guestStageHostStream    = null;   // remote stream from host (received on guest's viewPc)

const _MAX_GUEST_PEERS = 4;            // host: max simultaneous guest connections

/* ──────────────────────────────────────────────────────────
   HOST SIDE
────────────────────────────────────────────────────────── */

/**
 * Called when host presses Accept on a guest request.
 * Creates an isolated RTCPeerConnection for this guest,
 * writes the offer to guestSignaling, and listens for answer + ICE.
 */
async function _hostAcceptGuest(guestUid, req, roomId, db) {
  if (!roomId || !guestUid || !db) return;

  // ── 4-guest cap ──
  if (_guestPeers.size >= _MAX_GUEST_PEERS) {
    console.warn('[SNX-HOST-GUEST] ALL GUEST BOXES ARE IN USE — max', _MAX_GUEST_PEERS, 'guests');
    if (typeof toastNotification === 'function') toastNotification('⚠️ All guest boxes are in use.');
    return;
  }

  // ── Guard against duplicate ──
  if (_guestPeers.has(guestUid)) {
    console.warn('[SNX-HOST-GUEST] Already have peer for guestUid:', guestUid);
    return;
  }

  console.log('[DIAG-1] HOST ACCEPTS — roomId:', roomId, 'guestUid:', guestUid);

  // ── SFU path: guest connects directly to LiveKit room ───────────────────
  // The SFU handles all media distribution.  The host's onParticipantJoined
  // callback fires when the guest actually joins the room, and onTrackSubscribed
  // fires when their media is ready.  We add the box in CONNECTING state here
  // so the host sees it immediately; the SFU callbacks will update it to LIVE.
  // No RTCPeerConnection or Firebase signaling offer/answer is needed.
  if (_sfuAvailable() && _S.hostSfuToken) {
    console.log('[SFU] hostAcceptGuest — SFU active; adding box, skipping P2P offer for:', guestUid);
    // Add box in connecting state (idempotent — onParticipantJoined may also call this)
    window.snxBoxManager.addGuest(guestUid, req.name || 'Guest', req.avatar || '');
    // Track the guest so _hostCleanupGuest and the cap check work correctly
    _guestPeers.set(guestUid, { pc: null, sigUnsub: null, connectTimer: null, name: req.name, avatar: req.avatar });
    // Clean up Firestore boxRequest doc after short delay
    const fs = window._snxFirestore;
    const reqId = roomId + '_' + guestUid;
    if (fs && fs.deleteDoc && fs.doc && fs.db) {
      setTimeout(async () => {
        try { await fs.deleteDoc(fs.doc(fs.db, 'boxRequests', reqId)); } catch (_) {}
      }, 3000);
    }
    return;
  }

  // ── P2P path (fallback when SFU is not active) ───────────────────────────
  const sigRef  = ref(db, 'guestSignaling/' + roomId + '/' + guestUid);
  const pc      = new RTCPeerConnection(_buildIceConfig());

  // ── DIAG STEP 7 — HOST GUEST PEER CREATED ──
  console.log('[DIAG-7] HOST GUEST PEER CREATED — roomId:', roomId, 'guestUid:', guestUid,
    'signalingState:', pc.signalingState, 'iceConnectionState:', pc.iceConnectionState);

  // ── FIX: Explicitly create recvonly transceivers BEFORE createOffer.
  //    Do NOT rely on deprecated offerToReceiveVideo / offerToReceiveAudio.
  //    These transceivers tell the browser to include both audio and video
  //    m-lines in the offer SDP so the guest's tracks have a negotiated channel.
  //    The host guest peer is RECEIVE-ONLY — we do not add host camera/mic here.
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });
  console.log('[DIAG-7] HOST recvonly TRANSCEIVERS ADDED — video: PASS, audio: PASS');

  // Add to box manager immediately (connecting state — no stream yet)
  window.snxBoxManager.addGuest(guestUid, req.name || 'Guest', req.avatar || '');
  console.log('[SNX-HOST-GUEST] guest added to box (connecting) — roomId:', roomId, 'guestUid:', guestUid);

  // ── CONNECTING timeout — 35 s: if still no connected state, mark as failed ──
  let _connectTimer = setTimeout(() => {
    _connectTimer = null;
    if (_guestPeers.has(guestUid) && pc.connectionState !== 'connected') {
      console.error('[DIAG] HOST CONNECTING TIMEOUT — roomId:', roomId, 'guestUid:', guestUid,
        'connectionState:', pc.connectionState, 'iceConnectionState:', pc.iceConnectionState,
        'signalingState:', pc.signalingState);
      window.snxBoxManager.setGuestState(guestUid, 'failed');
      _hostCleanupGuest(guestUid, roomId, db);
    }
  }, 35000);

  // ── ICE candidate publishing — push-keyed, queued until offer written ──
  const pendingHostCands = [];
  let offerWritten = false;

  pc.onicecandidate = async ({ candidate }) => {
    if (!candidate) return;
    // ── DIAG STEP 18 — HOST ICE CANDIDATE WRITTEN ──
    console.log('[DIAG-18] HOST ICE CANDIDATE WRITTEN — roomId:', roomId, 'guestUid:', guestUid,
      'protocol:', candidate.protocol, 'type:', candidate.type);
    if (!offerWritten) {
      pendingHostCands.push(candidate.toJSON());
      return;
    }
    try {
      await set(push(ref(db, 'guestSignaling/' + roomId + '/' + guestUid + '/hostCandidates')), candidate.toJSON());
    } catch (e) {
      console.error('[DIAG-18] HOST ICE WRITE ERROR — roomId:', roomId, 'guestUid:', guestUid, e.message);
    }
  };

  // ── ontrack: guest stream arrived ──
  // Each UID has its own persistent remoteStream so tracks from different
  // guests are never mixed. Tracks are added additively — audio and video
  // may arrive in separate ontrack events.
  //
  // setGuestStream() is called ONLY after a live video track exists.
  // If only an audio track has arrived so far the box stays in CONNECTING
  // state (no unexplained black rectangle).
  const remoteStream = new MediaStream();
  let   videoReadyTimer = null;

  function _trySetGuestStream() {
    // Require at least one video track that is not ended
    const videoTracks = remoteStream.getVideoTracks().filter(t => t.readyState !== 'ended');
    if (!videoTracks.length) {
      // ── DIAG STEP 29 — VIDEO TRACK NOT READY YET ──
      console.log('[DIAG-29] VIDEO TRACK NOT READY — waiting, roomId:', roomId, 'guestUid:', guestUid,
        'current tracks:', remoteStream.getTracks().map(t => t.kind + ':' + t.readyState).join(', '));
      return;
    }
    // ── DIAG STEP 29 — VIDEO TRACK READY ──
    console.log('[DIAG-29] VIDEO TRACK READY — roomId:', roomId, 'guestUid:', guestUid,
      'videoTracks:', videoTracks.length,
      'all tracks:', remoteStream.getTracks().map(t => t.kind + ':' + t.readyState).join(', '));
    // ── DIAG STEP 30 — setGuestStream CALLED ──
    console.log('[DIAG-30] setGuestStream CALLED — roomId:', roomId, 'guestUid:', guestUid,
      'stream.id:', remoteStream.id, 'tracks:', remoteStream.getTracks().length);
    window.snxBoxManager.setGuestStream(guestUid, remoteStream);
    console.log('[DIAG-30] setGuestStream COMPLETE — roomId:', roomId, 'guestUid:', guestUid);
  }

  pc.ontrack = (e) => {
    const track = e.track;
    // Prevent duplicate track insertion into this guest's remote stream
    if (remoteStream.getTracks().some(t => t.id === track.id)) return;
    remoteStream.addTrack(track);

    if (track.kind === 'audio') {
      // ── DIAG STEP 26 — HOST ontrack AUDIO ──
      console.log('[DIAG-26] HOST ontrack AUDIO — roomId:', roomId, 'guestUid:', guestUid,
        'readyState:', track.readyState, 'muted:', track.muted, 'enabled:', track.enabled);
    } else if (track.kind === 'video') {
      // ── DIAG STEP 27 — HOST ontrack VIDEO ──
      console.log('[DIAG-27] HOST ontrack VIDEO — roomId:', roomId, 'guestUid:', guestUid,
        'readyState:', track.readyState, 'muted:', track.muted, 'enabled:', track.enabled);
    }
    // ── DIAG STEP 28 — REMOTE STREAM ASSEMBLED ──
    console.log('[DIAG-28] REMOTE STREAM ASSEMBLED — roomId:', roomId, 'guestUid:', guestUid,
      'tracks:', remoteStream.getTracks().map(t => t.kind + ':' + t.readyState).join(', '));

    // Re-evaluate readiness on a short debounce so that audio + video
    // tracks arriving close together are both present before we attach.
    if (videoReadyTimer) clearTimeout(videoReadyTimer);
    videoReadyTimer = setTimeout(() => {
      videoReadyTimer = null;
      _trySetGuestStream();
    }, 150);

    // Also re-evaluate if the video track's readyState changes
    if (track.kind === 'video') {
      track.addEventListener('unmute', () => {
        if (videoReadyTimer) clearTimeout(videoReadyTimer);
        videoReadyTimer = setTimeout(() => { videoReadyTimer = null; _trySetGuestStream(); }, 50);
      });
    }
  };

  // ── Connection state ──
  let dcTimer = null;
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    // ── DIAG STEP 24 — HOST CONNECTION STATE ──
    console.log('[DIAG-24] HOST CONNECTION STATE:', state, '— roomId:', roomId, 'guestUid:', guestUid,
      'iceConnectionState:', pc.iceConnectionState, 'signalingState:', pc.signalingState);
    if (state === 'connected') {
      if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
      if (dcTimer) { clearTimeout(dcTimer); dcTimer = null; }
    } else if (state === 'disconnected') {
      if (!dcTimer) {
        dcTimer = setTimeout(() => {
          dcTimer = null;
          if (pc.connectionState !== 'connected' && _guestPeers.has(guestUid)) {
            console.log('[DIAG-24] HOST disconnected grace period expired — roomId:', roomId, 'guestUid:', guestUid);
            window.snxBoxManager.setGuestState(guestUid, 'disconnected');
            _hostCleanupGuest(guestUid, roomId, db);
          }
        }, 2000);
      }
    } else if (state === 'failed' || state === 'closed') {
      if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
      if (dcTimer) { clearTimeout(dcTimer); dcTimer = null; }
      if (_guestPeers.has(guestUid)) {
        window.snxBoxManager.setGuestState(guestUid, 'disconnected');
        _hostCleanupGuest(guestUid, roomId, db);
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    // ── DIAG STEP 22 — HOST ICE CONNECTION STATE ──
    console.log('[DIAG-22] HOST ICE CONNECTION STATE:', pc.iceConnectionState,
      '— roomId:', roomId, 'guestUid:', guestUid,
      'iceGatheringState:', pc.iceGatheringState, 'connectionState:', pc.connectionState);
    if (pc.iceConnectionState === 'failed') {
      console.error('[DIAG-22] HOST ICE FAILED — roomId:', roomId, 'guestUid:', guestUid,
        'This indicates ICE/NAT connectivity failure. If devices are on different networks, TURN is required.');
      if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
      if (_guestPeers.has(guestUid)) {
        window.snxBoxManager.setGuestState(guestUid, 'failed');
        _hostCleanupGuest(guestUid, roomId, db);
      }
    }
  };

  // ── Create offer ──
  // NOTE: offerToReceiveVideo/offerToReceiveAudio are NOT passed — transceivers
  //       were already added above with direction:'recvonly'.
  let offer;
  try {
    offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // ── DIAG STEP 8 — VERIFY OFFER SDP M-LINES (no full SDP logged) ──
    const sdpLines  = offer.sdp || '';
    const hasAudio  = /^m=audio/m.test(sdpLines);
    const hasVideo  = /^m=video/m.test(sdpLines);
    console.log('[DIAG-8] HOST GUEST OFFER:');
    console.log('[DIAG-8] AUDIO M-LINE:', hasAudio ? 'YES' : 'NO');
    console.log('[DIAG-8] VIDEO M-LINE:', hasVideo ? 'YES' : 'NO');
    console.log('[DIAG-8] HOST OFFER CREATED — roomId:', roomId, 'guestUid:', guestUid,
      'type:', offer.type, 'sdp lines:', sdpLines.split('\n').length);

    if (!hasAudio || !hasVideo) {
      console.error('[DIAG-8] OFFER M-LINE FAILURE — audio:', hasAudio, 'video:', hasVideo,
        '— roomId:', roomId, 'guestUid:', guestUid,
        '— Connection cannot proceed: offer is missing required media section(s).');
      if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
      try { pc.close(); } catch (_) {}
      window.snxBoxManager.removeGuest(guestUid);
      return;
    }
  } catch (e) {
    console.error('[DIAG-8] HOST OFFER CREATION FAILED — roomId:', roomId, 'guestUid:', guestUid, e.name, e.message);
    if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
    try { pc.close(); } catch (_) {}
    window.snxBoxManager.removeGuest(guestUid);
    return;
  }

  // ── Write offer to guestSignaling ──
  try {
    await set(sigRef, {
      offer: { type: offer.type, sdp: offer.sdp },
    });
    offerWritten = true;
    // ── DIAG STEP 9 — HOST OFFER WRITTEN TO guestSignaling ──
    console.log('[DIAG-9] HOST OFFER WRITTEN — path: guestSignaling/' + roomId + '/' + guestUid);
  } catch (e) {
    console.error('[DIAG-9] HOST OFFER WRITE FAILED — roomId:', roomId, 'guestUid:', guestUid,
      'error:', e.code, e.message);
    if (_connectTimer) { clearTimeout(_connectTimer); _connectTimer = null; }
    try { pc.close(); } catch (_) {}
    window.snxBoxManager.removeGuest(guestUid);
    return;
  }

  // ── Flush any ICE candidates that were generated before offerWritten ──
  for (const cand of pendingHostCands.splice(0)) {
    try {
      await set(push(ref(db, 'guestSignaling/' + roomId + '/' + guestUid + '/hostCandidates')), cand);
      console.log('[DIAG-18] HOST ICE FLUSHED (pending) — roomId:', roomId, 'guestUid:', guestUid);
    } catch (e) {
      console.error('[DIAG-18] HOST ICE FLUSH FAILED — roomId:', roomId, 'guestUid:', guestUid, e.message);
    }
  }

  // ── Watch for guest answer + ICE ──
  const appliedGuestCandIds = new Set();
  const pendingGuestCands   = [];  // queued before remoteDescription ready

  const sigUnsub = onValue(sigRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();

    // Apply answer (once only)
    if (d.answer && pc.remoteDescription === null) {
      // ── DIAG STEP 16 — HOST ANSWER RECEIVED ──
      console.log('[DIAG-16] HOST ANSWER RECEIVED — roomId:', roomId, 'guestUid:', guestUid);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(d.answer));
        // ── DIAG STEP 17 — HOST setRemoteDescription SUCCESS ──
        console.log('[DIAG-17] HOST setRemoteDescription SUCCESS — roomId:', roomId, 'guestUid:', guestUid,
          'signalingState:', pc.signalingState);
        // Flush queued guest ICE
        for (const { key, cand } of pendingGuestCands.splice(0)) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
            appliedGuestCandIds.add(key);
            console.log('[DIAG-21] HOST ICE CANDIDATE RECEIVED + APPLIED (queued) — key:', key,
              'roomId:', roomId, 'guestUid:', guestUid);
          } catch (e) {
            console.error('[DIAG-21] HOST addIceCandidate (queued) FAILED — key:', key,
              'roomId:', roomId, 'guestUid:', guestUid, e.message);
          }
        }
      } catch (e) {
        // ── DIAG STEP 17 — HOST setRemoteDescription FAIL ──
        console.error('[DIAG-17] HOST setRemoteDescription FAILED — roomId:', roomId, 'guestUid:', guestUid,
          e.name, e.message);
      }
    }

    // Apply guest ICE candidates
    if (d.guestCandidates) {
      for (const [key, cand] of Object.entries(d.guestCandidates)) {
        if (appliedGuestCandIds.has(key)) continue;
        if (!pc.remoteDescription) {
          pendingGuestCands.push({ key, cand });
          appliedGuestCandIds.add(key);  // prevent double-queuing
          console.log('[DIAG-21] HOST ICE CANDIDATE RECEIVED — queued (no remoteDesc yet) key:', key,
            'roomId:', roomId, 'guestUid:', guestUid);
        } else {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
            appliedGuestCandIds.add(key);
            // ── DIAG STEP 21 — HOST ICE CANDIDATE RECEIVED + APPLIED ──
            console.log('[DIAG-21] HOST ICE CANDIDATE RECEIVED + APPLIED — key:', key,
              'roomId:', roomId, 'guestUid:', guestUid);
          } catch (e) {
            console.error('[DIAG-21] HOST addIceCandidate FAILED — key:', key,
              'roomId:', roomId, 'guestUid:', guestUid, e.message);
          }
        }
      }
    }
  });

  // ── Store peer ──
  _guestPeers.set(guestUid, { pc, sigUnsub, connectTimer: _connectTimer, name: req.name, avatar: req.avatar });

  const fs = window._snxFirestore;

  // ── Clean up Firestore boxRequest doc once accepted ──
  const reqId = roomId + '_' + guestUid;
  if (fs && fs.deleteDoc && fs.doc && fs.db) {
    setTimeout(async () => {
      try { await fs.deleteDoc(fs.doc(fs.db, 'boxRequests', reqId)); } catch (_) {}
    }, 3000);
  }
}

/**
 * Clean up one guest's host-side resources.
 * Does NOT affect other guests or the normal Live broadcast.
 */
/**
 * @param {string}  guestUid
 * @param {string}  roomId
 * @param {object}  db
 * @param {string}  [signal]  – value to write to hostEnded ('removed' | 'ended').
 *                              Pass null to skip writing (when caller already wrote it).
 */
function _hostCleanupGuest(guestUid, roomId, db, signal) {
  const peer = _guestPeers.get(guestUid);
  if (!peer) return;
  _guestPeers.delete(guestUid);

  if (peer.connectTimer) { clearTimeout(peer.connectTimer); }
  if (peer.sigUnsub) { try { peer.sigUnsub(); } catch (_) {} }
  if (peer.pc) {
    try { peer.pc.ontrack = null; } catch (_) {}
    try { peer.pc.onicecandidate = null; } catch (_) {}
    try { peer.pc.onconnectionstatechange = null; } catch (_) {}
    try { peer.pc.oniceconnectionstatechange = null; } catch (_) {}
    try { peer.pc.close(); } catch (_) {}
  }

  // Signal guest client to leave stage BEFORE removing data so the guest's
  // hostEnded listener has time to fire.
  // Default: 'removed' (live continues, only this guest was removed).
  // Pass null to skip (e.g. when _hostCleanupAllGuests already wrote 'ended').
  const sig = (signal === undefined) ? 'removed' : signal;
  if (sig !== null) {
    try { set(ref(db, 'guestSignaling/' + roomId + '/' + guestUid + '/hostEnded'), sig); } catch (_) {}
  }

  // Remove signaling data after brief delay so guest client can read it
  setTimeout(() => {
    try { remove(ref(db, 'guestSignaling/' + roomId + '/' + guestUid)); } catch (_) {}
    try { remove(ref(db, 'guestRequests/' + roomId + '/' + guestUid)); } catch (_) {}
  }, 3000);

  console.log('[SNX-HOST-GUEST] guest cleaned up — guestUid:', guestUid, 'remaining peers:', _guestPeers.size);
}

/**
 * Clean up ALL guest peers — called when host ends Live.
 */
function _hostCleanupAllGuests(roomId, db) {
  if (!_guestPeers.size) return;
  console.log('[SNX-HOST-GUEST] cleaning all', _guestPeers.size, 'guest peer(s) on Live end');
  for (const guestUid of [..._guestPeers.keys()]) {
    // Pass 'ended' explicitly — entire Live has ended
    _hostCleanupGuest(guestUid, roomId, db, 'ended');
    window.snxBoxManager.removeGuest(guestUid);
  }
}

/* ──────────────────────────────────────────────────────────
   VIEWER / GUEST SIDE
────────────────────────────────────────────────────────── */

/**
 * Called after the host accepts the viewer as a guest.
 * Acquires camera + microphone, waits for the host's offer,
 * creates answer, exchanges ICE.
 */
async function _guestJoinAsViewer(roomId, db, btn) {
  const user = _user();
  if (!user || !roomId || !db) return;

  // ── DIAG STEP 2 — GUEST RECEIVED ACCEPTED ──
  console.log('[DIAG-2] GUEST RECEIVED ACCEPTED — roomId:', roomId, 'guestUid:', user.uid);
  console.log('[DIAG-2] guestSignaling path will be: guestSignaling/' + roomId + '/' + user.uid);

  // Fetch fresh TURN credentials for the guest peer connection.
  await _fetchTurnConfig();

  // ── DIAG STEP 3 — GUEST getUserMedia START ──
  console.log('[DIAG-3] GUEST getUserMedia START — roomId:', roomId, 'guestUid:', user.uid);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('[DIAG-3] GUEST getUserMedia UNAVAILABLE — not in secure context or API missing',
      'location.protocol:', location.protocol, 'roomId:', roomId, 'guestUid:', user.uid);
    if (typeof toastNotification === 'function')
      toastNotification('⛔ Camera access requires HTTPS. Please use a secure connection.');
    if (btn) { btn.textContent = '🎙 Request to Join'; btn.disabled = false; btn.dataset.reqPending = ''; }
    return;
  }

  // ── Request camera + microphone ──
  let guestStream;
  try {
    guestStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // ── DIAG STEP 4 — GUEST getUserMedia SUCCESS ──
    console.log('[DIAG-4] GUEST getUserMedia SUCCESS — roomId:', roomId, 'guestUid:', user.uid,
      'tracks:', guestStream.getTracks().length);
    // ── DIAG STEP 5 — GUEST CAMERA TRACK ──
    const vt = guestStream.getVideoTracks();
    console.log('[DIAG-5] GUEST CAMERA TRACK —', vt.length ? 'OK' : 'NONE',
      '— roomId:', roomId, 'guestUid:', user.uid,
      vt.length ? ('label: ' + vt[0].label + ' readyState: ' + vt[0].readyState) : '');
    // ── DIAG STEP 6 — GUEST MICROPHONE TRACK ──
    const at = guestStream.getAudioTracks();
    console.log('[DIAG-6] GUEST MICROPHONE TRACK —', at.length ? 'OK' : 'NONE',
      '— roomId:', roomId, 'guestUid:', user.uid,
      at.length ? ('label: ' + at[0].label + ' readyState: ' + at[0].readyState) : '');
  } catch (e) {
    // ── DIAG STEP 4 — GUEST getUserMedia FAIL ──
    console.error('[DIAG-4] GUEST getUserMedia FAILED — roomId:', roomId, 'guestUid:', user.uid,
      'errorName:', e.name, 'errorMessage:', e.message);
    const msg =
      (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')
        ? '⛔ CAMERA/MICROPHONE PERMISSION REQUIRED — allow access in browser settings.'
        : e.name === 'NotFoundError'
          ? '⛔ No camera/microphone found on this device.'
          : e.name === 'NotReadableError'
            ? '⛔ Camera is already in use by another app.'
            : e.name === 'OverconstrainedError'
              ? '⛔ Camera constraints could not be satisfied on this device.'
              : e.name === 'AbortError'
                ? '⛔ Camera access was aborted.'
                : '⛔ Could not access camera: ' + e.name + ' — ' + e.message;
    if (typeof toastNotification === 'function') toastNotification(msg);
    // Restore button
    if (btn) { btn.textContent = '🎙 Request to Join'; btn.disabled = false; btn.dataset.reqPending = ''; }
    return;
  }

  _guestViewerStream  = guestStream;
  _guestViewerRoomId  = roomId;
  _guestViewerUid     = user.uid;

  // ── SFU guest media path ──────────────────────────────────────────────────
  // When snxSfu is available, the guest connects to the LiveKit room directly
  // and publishes their camera/mic. The SFU distributes their stream to the
  // host and all other participants automatically.
  // Firebase is used only to signal acceptance (already done above in
  // _viewerSendRequest → boxRequest update).
  if (_sfuAvailable()) {
    console.log('[SFU] Guest: connecting to room — roomId:', roomId, 'guestUid:', user.uid);
    try {
      const { token, url: sfuUrl } = await window.snxSfu.fetchToken(
        roomId, user.uid, /* canPublish */ true
      );
      // Disconnect any existing viewer-mode SFU connection before joining as guest
      if (_S.viewSfuToken) {
        try { window.snxSfu.disconnect(); } catch (_) {}
        _S.viewSfuToken = null;
      }

      // ── Open the guest stage UI BEFORE connecting to SFU ──
      // This ensures _boxState has the '_host_' entry registered before
      // _buildGuestSfuCallbacks.onTrackSubscribed fires during connect().
      if (typeof toastNotification === 'function') toastNotification('🎙 You are now LIVE!');
      _openGuestStageView(roomId, db, guestStream);

      await window.snxSfu.connect({
        sfuUrl,
        token,
        roomName:  roomId,
        uid:       user.uid,
        role:      'guest',
        callbacks: _buildGuestSfuCallbacks(roomId, guestStream),
      });
      await window.snxSfu.publishLocalStream(guestStream);
      console.log('[SFU] Guest connected and publishing — roomId:', roomId);

      // ── Listen for hostEnded signal on guestSignaling ──
      // (host uses this to signal removal or live end)
      const hostEndedRef = ref(db, 'guestSignaling/' + roomId + '/' + user.uid + '/hostEnded');
      const hostEndedUnsub = onValue(hostEndedRef, snap => {
        if (!snap.exists() || !snap.val()) return;
        const signal = snap.val();
        console.log('[SNX-GUEST/SFU] hostEnded signal:', signal);
        try { hostEndedUnsub(); } catch (_) {}
        const liveEnded = (signal === true || signal === 'ended');
        _guestLeaveStage(liveEnded);
      });
      return;   // SFU path complete — skip P2P handshake below

    } catch (sfuErr) {
      console.error('[SFU] Guest connect failed — falling back to P2P:', sfuErr.message);
      try { window.snxSfu.disconnect(); } catch (_) {}
      // If the guest stage was already opened, clean it up before the P2P fallback
      // re-opens it with a fresh state.
      if (_guestStageActive) {
        _guestStageActive = false;
        _S._guestStageOpen = false;
        const _sfuStage = _getStage();
        if (_sfuStage) {
          _sfuStage.classList.remove('is-guest-stage');
          const _sfuDock = _sfuStage.querySelector('.snx-guest-controls');
          if (_sfuDock) _sfuDock.remove();
          _boxState.forEach(b => { if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el); });
          _boxState.clear();
          delete _sfuStage.dataset.boxes;
          delete _sfuStage.dataset.layout;
        }
        const _sfuLoader = _el('snxViewerLoader');
        if (_sfuLoader) _sfuLoader.style.display = '';
        const _sfuVid = _el('snxLiveViewerVideo');
        if (_sfuVid) _sfuVid.style.display = '';
      }
      // Fall through to P2P path
    }
  }

  // ── P2P guest media path (fallback) ──────────────────────────────────────
  // Wait for host's SDP offer on guestSignaling, exchange ICE, connect.
  const sigRef   = ref(db, 'guestSignaling/' + roomId + '/' + user.uid);
  const offerRef = ref(db, 'guestSignaling/' + roomId + '/' + user.uid + '/offer');

  console.log('[SNX-GUEST/P2P] waiting for offer — path: guestSignaling/' + roomId + '/' + user.uid);

  // ── Wait for host offer (max 15 s) ──
  // onValue fires immediately if the offer is already present, so there is no
  // miss-window even if the host wrote the offer before we attached this listener.
  let offerData = null;
  const offerWait = new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try { unsub(); } catch (_) {}
      reject(new Error('offer-timeout'));
    }, 15000);
    const unsub = onValue(offerRef, snap => {
      if (!snap.exists()) return;
      clearTimeout(t);
      try { unsub(); } catch (_) {}
      resolve(snap.val());
    });
  });

  try {
    offerData = await offerWait;
    // ── DIAG STEP 10 — GUEST OFFER RECEIVED ──
    console.log('[DIAG-10] GUEST OFFER RECEIVED — roomId:', roomId, 'guestUid:', user.uid,
      'type:', offerData && offerData.type);
  } catch (e) {
    console.error('[DIAG-10] GUEST OFFER WAIT TIMED OUT — roomId:', roomId, 'guestUid:', user.uid,
      'error:', e.message,
      'CHECK: Did host write offer to guestSignaling/' + roomId + '/' + user.uid + '/offer ?');
    if (typeof toastNotification === 'function') toastNotification('⚠️ Host did not respond in time. Please try again.');
    guestStream.getTracks().forEach(t => t.stop());
    _guestViewerStream = null;
    if (btn) { btn.textContent = '🎙 Request to Join'; btn.disabled = false; btn.dataset.reqPending = ''; }
    return;
  }

  // ── Create peer connection ──
  const pc = new RTCPeerConnection(_buildIceConfig());
  _guestViewerPc = pc;

  // Add local tracks to send to host
  guestStream.getTracks().forEach(t => {
    pc.addTrack(t, guestStream);
    console.log('[DIAG-12] GUEST TRACKS ADDED — kind:', t.kind, 'roomId:', roomId, 'guestUid:', user.uid);
  });

  // ── ICE candidate publishing — push-keyed, queued until answer written ──
  const pendingGuestCands = [];
  let answerWritten = false;

  pc.onicecandidate = async ({ candidate }) => {
    if (!candidate) return;
    // ── DIAG STEP 20 — GUEST ICE CANDIDATE WRITTEN ──
    console.log('[DIAG-20] GUEST ICE CANDIDATE WRITTEN — roomId:', roomId, 'guestUid:', user.uid,
      'protocol:', candidate.protocol, 'type:', candidate.type);
    if (!answerWritten) {
      pendingGuestCands.push(candidate.toJSON());
      return;
    }
    try {
      await set(push(ref(db, 'guestSignaling/' + roomId + '/' + user.uid + '/guestCandidates')), candidate.toJSON());
    } catch (e) {
      console.error('[DIAG-20] GUEST ICE WRITE ERROR — roomId:', roomId, 'guestUid:', user.uid, e.message);
    }
  };

  // ── Connection state monitoring ──
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    // ── DIAG STEP 25 — GUEST CONNECTION STATE ──
    console.log('[DIAG-25] GUEST CONNECTION STATE:', state, '— roomId:', roomId, 'guestUid:', user.uid,
      'iceConnectionState:', pc.iceConnectionState, 'signalingState:', pc.signalingState);
    if (state === 'connected') {
      if (_guestViewerReconnTimer) { clearTimeout(_guestViewerReconnTimer); _guestViewerReconnTimer = null; }
    } else if (state === 'disconnected') {
      if (!_guestViewerReconnTimer) {
        _guestViewerReconnTimer = setTimeout(() => {
          _guestViewerReconnTimer = null;
          if (_guestViewerPc === pc && pc.connectionState !== 'connected') {
            console.log('[DIAG-25] GUEST disconnected grace expired — roomId:', roomId, 'guestUid:', user.uid);
            _guestLeaveStage(false);
          }
        }, 4000);
      }
    } else if (state === 'failed' || state === 'closed') {
      if (_guestViewerReconnTimer) { clearTimeout(_guestViewerReconnTimer); _guestViewerReconnTimer = null; }
      if (_guestViewerPc === pc) {
        console.log('[DIAG-25] GUEST connection', state, '— roomId:', roomId, 'guestUid:', user.uid);
        _guestLeaveStage(false);
      }
    }
  };

  pc.oniceconnectionstatechange = () => {
    // ── DIAG STEP 23 — GUEST ICE CONNECTION STATE ──
    console.log('[DIAG-23] GUEST ICE CONNECTION STATE:', pc.iceConnectionState,
      '— roomId:', roomId, 'guestUid:', user.uid,
      'iceGatheringState:', pc.iceGatheringState, 'connectionState:', pc.connectionState);
    if (pc.iceConnectionState === 'failed') {
      console.error('[DIAG-23] GUEST ICE FAILED — roomId:', roomId, 'guestUid:', user.uid,
        'This indicates ICE/NAT connectivity failure. If devices are on different networks, TURN is required.');
    }
  };

  // ── Set remote description (offer) ──
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offerData));
    // ── DIAG STEP 11 — GUEST setRemoteDescription SUCCESS ──
    console.log('[DIAG-11] GUEST setRemoteDescription SUCCESS — roomId:', roomId, 'guestUid:', user.uid,
      'signalingState:', pc.signalingState);
  } catch (e) {
    // ── DIAG STEP 11 — GUEST setRemoteDescription FAIL ──
    console.error('[DIAG-11] GUEST setRemoteDescription FAILED — roomId:', roomId, 'guestUid:', user.uid,
      e.name, e.message);
    try { pc.close(); } catch (_) {}
    guestStream.getTracks().forEach(t => t.stop());
    _guestViewerPc = null;
    _guestViewerStream = null;
    if (btn) { btn.textContent = '🎙 Request to Join'; btn.disabled = false; btn.dataset.reqPending = ''; }
    return;
  }

  // ── Apply any host ICE candidates already in signaling AND attach live listener
  //    in one atomic step — this prevents the race where candidates arrive between
  //    the get() call and the onValue() subscription.
  // ── DIAG STEP 19 — GUEST ICE CANDIDATE RECEIVED ──
  const appliedHostCandIds = new Set();
  const hostCandRef = ref(db, 'guestSignaling/' + roomId + '/' + user.uid + '/hostCandidates');
  let hostCandUnsub;
  await new Promise(resolve => {
    hostCandUnsub = onValue(hostCandRef, async snap => {
      if (!snap.exists()) { resolve(); return; }
      for (const [key, cand] of Object.entries(snap.val())) {
        if (appliedHostCandIds.has(key)) continue;
        appliedHostCandIds.add(key);
        console.log('[DIAG-19] GUEST ICE CANDIDATE RECEIVED — key:', key,
          'roomId:', roomId, 'guestUid:', user.uid);
        try {
          await pc.addIceCandidate(new RTCIceCandidate(cand));
          console.log('[DIAG-19] GUEST addIceCandidate SUCCESS — key:', key,
            'roomId:', roomId, 'guestUid:', user.uid);
        } catch (e) {
          console.error('[DIAG-19] GUEST addIceCandidate FAILED — key:', key,
            'roomId:', roomId, 'guestUid:', user.uid, e.message);
        }
      }
      resolve();
    });
  });
  // Keep _guestViewerSigUnsub pointing to the host-candidate listener so
  // cleanup unsubscribes it correctly.
  _guestViewerSigUnsub = hostCandUnsub;

  // ── Create answer ──
  let answer;
  try {
    answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // ── DIAG STEP 13 — GUEST ANSWER CREATED ──
    // ── DIAG STEP 14 — GUEST setLocalDescription SUCCESS ──
    console.log('[DIAG-13] GUEST ANSWER CREATED — roomId:', roomId, 'guestUid:', user.uid,
      'type:', answer.type);
    console.log('[DIAG-14] GUEST setLocalDescription SUCCESS — roomId:', roomId, 'guestUid:', user.uid,
      'signalingState:', pc.signalingState);
  } catch (e) {
    console.error('[DIAG-13/14] GUEST createAnswer/setLocalDescription FAILED — roomId:', roomId,
      'guestUid:', user.uid, e.name, e.message);
    try { pc.close(); } catch (_) {}
    guestStream.getTracks().forEach(t => t.stop());
    _guestViewerPc = null;
    _guestViewerStream = null;
    return;
  }

  // ── Write answer to guestSignaling ──
  try {
    await update(sigRef, { answer: { type: answer.type, sdp: answer.sdp } });
    answerWritten = true;
    // ── DIAG STEP 15 — GUEST ANSWER WRITTEN ──
    console.log('[DIAG-15] GUEST ANSWER WRITTEN — path: guestSignaling/' + roomId + '/' + user.uid);
  } catch (e) {
    console.error('[DIAG-15] GUEST ANSWER WRITE FAILED — roomId:', roomId, 'guestUid:', user.uid,
      'error:', e.code, e.message);
    try { pc.close(); } catch (_) {}
    guestStream.getTracks().forEach(t => t.stop());
    _guestViewerPc = null;
    _guestViewerStream = null;
    return;
  }

  // ── Flush pending local ICE candidates that accumulated before answer was written ──
  for (const cand of pendingGuestCands.splice(0)) {
    try {
      await set(push(ref(db, 'guestSignaling/' + roomId + '/' + user.uid + '/guestCandidates')), cand);
      console.log('[DIAG-20] GUEST ICE FLUSHED (pending) — roomId:', roomId, 'guestUid:', user.uid);
    } catch (e) {
      console.error('[DIAG-20] GUEST ICE FLUSH FAILED — roomId:', roomId, 'guestUid:', user.uid, e.message);
    }
  }

  // ── Listen for hostEnded signal ──
  // Value: 'ended' = host ended entire live; 'removed' = host removed this guest; true = legacy
  const hostEndedRef = ref(db, 'guestSignaling/' + roomId + '/' + user.uid + '/hostEnded');
  const hostEndedUnsub = onValue(hostEndedRef, snap => {
    if (!snap.exists() || !snap.val()) return;
    const signal = snap.val();
    console.log('[SNX-GUEST] host ended signal received:', signal, '— roomId:', roomId, 'guestUid:', user.uid);
    try { hostEndedUnsub(); } catch (_) {}
    // 'removed' = host removed just this guest (live continues); they return to viewer
    // 'ended' or true = host ended the entire live
    const liveEnded = (signal === true || signal === 'ended');
    _guestLeaveStage(liveEnded);
  });

  // ── Open the guest participant stage ──
  // The guest's viewPc (liveSignaling connection) already carries the host's
  // broadcast stream.  We wire up the GUEST-SIDE stage so the guest sees:
  //   [ HOST box — remote stream from _S.viewPc ]
  //   [ YOU  box — local camera, muted           ]
  console.log('[SNX-GUEST] signaling complete — opening guest stage — roomId:', roomId, 'guestUid:', user.uid);
  if (typeof toastNotification === 'function') toastNotification('🎙 You are now LIVE!');
  _openGuestStageView(roomId, db, guestStream);
}

/**
 * Open the two-person (or N-person) stage view for an accepted guest.
 *
 * The guest's normal viewer WebRTC connection (_S.viewPc) delivers the host
 * broadcast stream.  We capture that stream, build a mini box-stage, and add
 * the guest's own local camera as a muted "YOU" preview tile.
 */
function _openGuestStageView(roomId, db, localStream) {
  // Reset stale active flag so a previously crashed session doesn't block re-entry.
  // _guestLeaveStage always sets this to false; guard only true re-entrancy within
  // the same acceptance flow.
  if (_guestStageActive) {
    console.warn('[SNX-GUEST-STAGE] Re-entry blocked — already active. Resetting first.');
    _guestStageActive = false;
  }
  _guestStageActive = true;

  const stage = _getStage();
  if (!stage) {
    console.warn('[SNX-GUEST-STAGE] No stage element found');
    _guestStageActive = false;
    return;
  }

  // ── Kill the connecting loader immediately and permanently for this session ──
  // Loader has z-index:60 and covers everything. We forcibly hide it and prevent
  // _setViewerStatus() callbacks from the underlying P2P viewer PC from re-showing it.
  const loader = _el('snxViewerLoader');
  if (loader) {
    loader.classList.remove('show');
    loader.style.display = 'none';    // belt-and-suspenders — block CSS .show re-adds
  }

  // Silence the underlying viewer status callbacks so they cannot re-show the loader
  // or stomp guest-stage state once we are live as a guest.
  _S._guestStageOpen = true;

  // Mark stage as guest participant stage (enables guest-specific CSS)
  stage.classList.add('is-guest-stage');

  // ── Build or reuse the box grid ──
  _boxState.clear();
  _ensureBoxGrid();

  // ── HOST box ──
  // P2P path: _S.viewPc already carries the host broadcast stream.
  // SFU path:  _S.viewPc is null; host stream arrives later via
  //            _buildGuestSfuCallbacks → onTrackSubscribed which calls
  //            snxBoxManager.setGuestStream / directly updates _boxState.
  //            We therefore register the box in _boxState NOW so the SFU
  //            callback can find it regardless of timing.
  const hostBox = _buildGuestBox('_host_', 'HOST', 'host');
  const grid = stage.querySelector('.snx-live-boxes');
  if (grid) grid.appendChild(hostBox.el);
  _boxState.set('_host_', hostBox);

  // Collect existing tracks from the viewer P2P PC (no-op when SFU is in use)
  function _attachHostStream() {
    const vpc = _S.viewPc;
    if (!vpc) return;
    // Build a fresh MediaStream from all current receiver tracks
    const hostStream = new MediaStream(
      vpc.getReceivers()
         .map(r => r.track)
         .filter(t => t && t.readyState !== 'ended')
    );
    if (hostStream.getTracks().length > 0) {
      _guestStageHostStream = hostStream;
      hostBox.videoEl.srcObject = hostStream;
      hostBox.videoEl.muted = false;
      hostBox.videoEl.play().catch(() => {});
      _setBxState('_host_', 'ready');
    }
  }
  _attachHostStream();

  // Also hook ontrack so late-arriving P2P tracks are captured
  const origViewPcOntrack = _S.viewPc ? _S.viewPc.ontrack : null;
  if (_S.viewPc) {
    _S.viewPc.ontrack = (e) => {
      if (typeof origViewPcOntrack === 'function') origViewPcOntrack(e);
      _attachHostStream();
    };
  }

  // ── YOU box — local camera preview, ALWAYS muted ──
  const youBox = _buildGuestBox('_you_', 'YOU', 'you');
  if (grid) grid.appendChild(youBox.el);
  _boxState.set('_you_', youBox);

  if (localStream) {
    youBox.videoEl.srcObject = localStream;
    youBox.videoEl.muted = true;      // must be muted — no echo
    youBox.videoEl.play().catch(() => {});
    _setBxState('_you_', 'ready');
  }

  // ── Layout — set data-boxes BEFORE data-layout so CSS grid activates correctly ──
  _recalcGuestLayout();

  // ── Hide the solo viewer video (CSS already hides it via data-boxes; JS belt-and-suspenders) ──
  const viewerVid = _el('snxLiveViewerVideo');
  if (viewerVid) viewerVid.style.display = 'none';

  // ── Inject guest controls dock ──
  _attachGuestControls(roomId, db, localStream);

  // ── Active speaker detection ──
  _startGuestSpeakerDetection();

  console.log('[SNX-GUEST-STAGE] Stage opened — roomId:', roomId);
}

/**
 * Build a minimal box element for the guest stage.
 * role: 'host' | 'you' | 'guest'
 */
function _buildGuestBox(uid, name, role) {
  const el = document.createElement('div');
  el.className = 'snx-box';
  el.dataset.uid   = uid;
  el.dataset.role  = role;
  el.dataset.state = 'connecting';

  const videoEl = document.createElement('video');
  videoEl.setAttribute('playsinline', '');
  videoEl.setAttribute('autoplay', '');
  videoEl.muted = (role === 'you');   // YOU box is always muted
  el.appendChild(videoEl);

  const label = document.createElement('div');
  label.className = 'snx-box-label';
  if (role === 'host')    label.textContent = '★ HOST';
  else if (role === 'you') label.textContent = 'YOU';
  else label.textContent = _esc(name || 'Guest');
  el.appendChild(label);

  // Connecting overlay
  const connEl = document.createElement('div');
  connEl.className = 'snx-box-connecting show';
  connEl.innerHTML =
    '<div class="snx-box-conn-ring"></div>' +
    '<div class="snx-box-conn-name">' + (role === 'host' ? 'HOST' : 'YOU') + '</div>' +
    '<div class="snx-box-conn-text">Connecting…</div>';
  el.appendChild(connEl);

  // Cam-off overlay
  const camOffEl = document.createElement('div');
  camOffEl.className = 'snx-box-cam-off';
  camOffEl.innerHTML =
    '<span class="snx-box-cam-off-icon">📷</span>' +
    '<span class="snx-box-cam-off-name">' + (role === 'you' ? 'YOU' : 'Camera off') + '</span>';
  el.appendChild(camOffEl);

  return { uid, name, role, state: 'connecting', el, videoEl };
}

/**
 * Recalculate data-boxes on the stage for the guest-side two-box layout.
 */
function _recalcGuestLayout() {
  const stage = _getStage();
  if (!stage) return;
  const count = _boxState.size;
  stage.dataset.boxes  = String(Math.max(1, count));
  stage.dataset.layout = 'auto';
}

/**
 * Inject the guest controls (mic / cam / leave) into the stage.
 */
function _attachGuestControls(roomId, db, localStream) {
  const stage = _getStage();
  if (!stage || stage.querySelector('.snx-guest-controls')) return;

  const dock = document.createElement('div');
  dock.className = 'snx-guest-controls';

  // Mic button
  let micOn = true;
  const micBtn = document.createElement('button');
  micBtn.className = 'snx-guest-ctrl-btn';
  micBtn.id = 'snxGuestMicBtn';
  micBtn.setAttribute('aria-label', 'Toggle microphone');
  micBtn.textContent = '🎤';
  micBtn.addEventListener('click', () => {
    micOn = !micOn;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = micOn; });
    // Notify SFU — pauses/resumes the audio producer at the server so all
    // participants (host, viewers) immediately stop/restart receiving guest audio.
    if (_sfuAvailable() && window.snxSfu.isConnected) window.snxSfu.setMicMuted(!micOn);
    micBtn.textContent = micOn ? '🎤' : '🔇';
    micBtn.classList.toggle('off', !micOn);
  });

  // Cam button
  let camOn = true;
  const camBtn = document.createElement('button');
  camBtn.className = 'snx-guest-ctrl-btn';
  camBtn.id = 'snxGuestCamBtn';
  camBtn.setAttribute('aria-label', 'Toggle camera');
  camBtn.textContent = '📷';
  camBtn.addEventListener('click', () => {
    camOn = !camOn;
    if (localStream) localStream.getVideoTracks().forEach(t => { t.enabled = camOn; });
    // Notify SFU — pauses/resumes the video producer at the server so all
    // participants (host, viewers) immediately stop/restart receiving guest video.
    if (_sfuAvailable() && window.snxSfu.isConnected) window.snxSfu.setCamMuted(!camOn);
    camBtn.textContent = camOn ? '📷' : '🚫';
    camBtn.classList.toggle('off', !camOn);
    // Update YOU box cam-off overlay
    const youBox = _boxState.get('_you_');
    if (youBox) {
      const co = youBox.el.querySelector('.snx-box-cam-off');
      if (co) co.classList.toggle('show', !camOn);
    }
  });

  // Leave button
  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'snx-guest-leave-btn';
  leaveBtn.id = 'snxGuestLeaveBtn';
  leaveBtn.setAttribute('aria-label', 'Leave stage');
  leaveBtn.textContent = '← LEAVE';
  leaveBtn.addEventListener('click', () => _guestLeaveStage(false));

  dock.appendChild(micBtn);
  dock.appendChild(camBtn);
  dock.appendChild(leaveBtn);
  stage.appendChild(dock);
}

/**
 * Poll active speaker state using getStats() on the guest peer connection.
 * Adds/removes .snx-box-speaking on the host and you boxes.
 * Runs every 1.5 s. Only starts if audiocontext-free stats are available.
 */
function _startGuestSpeakerDetection() {
  if (_guestStageSpeakerTimer) return;
  const INTERVAL = 1500;
  const THRESHOLD = 0.01;   // audio level threshold (0–1 scale)

  async function _poll() {
    const vpc = _S.viewPc;
    if (!vpc || !vpc.getStats) return;
    try {
      const stats = await vpc.getStats();
      let hostLevel = 0;
      stats.forEach(r => {
        if (r.type === 'inbound-rtp' && r.kind === 'audio') {
          hostLevel = Math.max(hostLevel, r.audioLevel || 0);
        }
      });
      const hostBox = _boxState.get('_host_');
      if (hostBox) hostBox.el.classList.toggle('snx-box-speaking', hostLevel > THRESHOLD);
    } catch (_) {}

    // YOU box — check local mic track via captureStream or just reflect enabled state
    // We can't easily measure local mic level without AudioContext, so just
    // highlight when mic is unmuted (track.enabled).
    const guestStream = _guestViewerStream;
    const youBox = _boxState.get('_you_');
    if (youBox && guestStream) {
      const atracks = guestStream.getAudioTracks();
      const micActive = atracks.length > 0 && atracks[0].enabled;
      youBox.el.classList.toggle('snx-box-speaking', micActive);
    }
  }

  _guestStageSpeakerTimer = setInterval(_poll, INTERVAL);
}

function _stopGuestSpeakerDetection() {
  if (_guestStageSpeakerTimer) {
    clearInterval(_guestStageSpeakerTimer);
    _guestStageSpeakerTimer = null;
  }
}

/**
 * Guest leaves the stage (tap LEAVE or host ended the Live).
 * @param {boolean} hostEnded  – true when the host ended Live (vs guest tapping Leave)
 */
function _guestLeaveStage(hostEnded) {
  if (!_guestStageActive) {
    _guestViewerCleanup();
    return;
  }
  _guestStageActive = false;
  _S._guestStageOpen = false;
  _stopGuestSpeakerDetection();

  // Remove guest-stage chrome
  const stage = _getStage();
  if (stage) {
    stage.classList.remove('is-guest-stage');
    const dock = stage.querySelector('.snx-guest-controls');
    if (dock) dock.remove();
    // Remove box grid guest boxes
    _boxState.forEach(b => {
      if (b.el && b.el.parentNode) b.el.parentNode.removeChild(b.el);
    });
    _boxState.clear();
    // Restore dataset so CSS reverts to solo-video mode
    delete stage.dataset.boxes;
    delete stage.dataset.layout;
  }

  // Restore loader element so the re-opened viewer screen can show it again
  const _leaveLoader = _el('snxViewerLoader');
  if (_leaveLoader) _leaveLoader.style.display = '';

  // Restore solo viewer video visibility
  const _leaveVid = _el('snxLiveViewerVideo');
  if (_leaveVid) _leaveVid.style.display = '';
  _guestStageHostStream = null;
  _stopGuestSpeakerDetection();

  // Disconnect SFU guest connection
  if (_sfuAvailable()) {
    try { window.snxSfu.disconnect(); } catch (_) {}
  }

  // Clean up P2P WebRTC + media (no-op when SFU was used)
  _guestViewerCleanup();

  if (hostEnded) {
    // Host ended the live — show ended screen
    _onViewerHostEnded();
  } else {
    // Guest chose to leave — return to normal viewer mode
    const roomId = _S.viewRoomId;
    if (roomId) {
      if (typeof toastNotification === 'function') toastNotification('👋 You left the stage.');
      // Close the existing viewer broadcast connection and state cleanly,
      // then re-open viewer screen with a fresh session.
      // Small delay so cleanup can complete before re-opening.
      setTimeout(() => {
        // Close old viewer PC and unsubs (does NOT show ended screen)
        if (_S.viewPc) { try { _S.viewPc.close(); } catch (_) {} _S.viewPc = null; }
        for (const fn of _S.viewUnsubs) { try { fn(); } catch (_) {} }
        _S.viewUnsubs = [];
        if (_S.viewPresRef) { try { remove(_S.viewPresRef); } catch (_) {} _S.viewPresRef = null; }
        _openViewerScreen(roomId);
      }, 400);
    } else {
      _closeOverlay();
    }
  }
}

/**
 * Clean up the viewer-side guest connection.
 * Called on leave, disconnect, or host cleanup.
 * Does NOT affect normal viewer playback or other features.
 */
function _guestViewerCleanup() {
  if (_guestViewerReconnTimer) {
    clearTimeout(_guestViewerReconnTimer);
    _guestViewerReconnTimer = null;
  }

  if (_guestViewerSigUnsub) {
    try { _guestViewerSigUnsub(); } catch (_) {}
    _guestViewerSigUnsub = null;
  }

  const pc = _guestViewerPc;
  _guestViewerPc = null;
  if (pc) {
    try { pc.ontrack = null; } catch (_) {}
    try { pc.onicecandidate = null; } catch (_) {}
    try { pc.onconnectionstatechange = null; } catch (_) {}
    try { pc.close(); } catch (_) {}
  }

  const stream = _guestViewerStream;
  _guestViewerStream = null;
  if (stream) {
    try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  }

  // Clean up signaling data
  const roomId = _guestViewerRoomId;
  const uid    = _guestViewerUid;
  if (roomId && uid) {
    const db = _db();
    if (db) {
      setTimeout(() => {
        try { remove(ref(db, 'guestSignaling/' + roomId + '/' + uid)); } catch (_) {}
        try { remove(ref(db, 'guestRequests/' + roomId + '/' + uid)); } catch (_) {}
      }, 1000);
    }
    const fs = window._snxFirestore;
    if (fs && fs.deleteDoc && fs.doc && fs.db) {
      const reqId = roomId + '_' + uid;
      setTimeout(async () => {
        try { await fs.deleteDoc(fs.doc(fs.db, 'boxRequests', reqId)); } catch (_) {}
      }, 1000);
    }
  }

  _guestViewerRoomId = null;
  _guestViewerUid    = null;

  console.log('[SNX-GUEST] viewer guest cleanup complete');
}

/* ══════════════════════════════════════════════════════════
   SHADOW CHAT BOT — LIVE AI MODERATION PANEL
   Host-only compact moderation status panel.

   Architecture:
   • Reads window._aiModerationEnabled (set by Firestore siteSettings listener
     in index.html — same global used by all other snxAIScan call sites).
   • Polls the existing Firestore aiModerationLog collection (limit 8, desc)
     to show recent Live-comment flags surfaced by snxAIScan.
   • Injected into .snx-live-stage.is-host — invisible on viewer/guest stage.
   • No new Firebase paths. No new AI system. Uses existing snxAIScan only.
   • Live media path (WebRTC, ICE, signaling, boxes) is completely untouched.
   • AI failure never blocks Live.
════════════════════════════════════════════════════════════ */

let _liveModPanelEl     = null;   // DOM element
let _liveModPollTimer   = null;   // setInterval for log refresh
let _liveModPanelOpen   = false;  // toggle state
const _LIVE_MOD_POLL_MS = 20000; // refresh every 20 s

/** Inject the panel into the host stage and start polling. */
function _initLiveModerationPanel(roomId) {
  // Destroy any stale panel from a previous session
  _destroyLiveModerationPanel();

  // Defer until the stage DOM is ready (same pattern as _attachBoxesOnStageOpen)
  setTimeout(() => {
    const stage = _getStage();
    if (!stage || !stage.classList.contains('is-host')) return;
    if (stage.querySelector('.snx-live-mod-panel')) return;

    const panel = document.createElement('div');
    panel.className = 'snx-live-mod-panel';
    panel.id = 'snxLiveModPanel';
    panel.innerHTML = _buildModPanelHTML();
    stage.appendChild(panel);
    _liveModPanelEl = panel;

    // Toggle button
    const toggleBtn = panel.querySelector('.snx-mod-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _liveModPanelOpen = !_liveModPanelOpen;
        _renderModPanelState(panel);
      });
    }

    // Initial render
    _renderModPanelState(panel);

    // Poll moderation log
    _liveModPollTimer = setInterval(() => _refreshModPanelLog(panel, roomId), _LIVE_MOD_POLL_MS);
    // Immediate first load
    _refreshModPanelLog(panel, roomId);

    _log('Live mod panel initialised');
  }, 150);
}

/** Tear down the panel and stop polling. */
function _destroyLiveModerationPanel() {
  if (_liveModPollTimer) { clearInterval(_liveModPollTimer); _liveModPollTimer = null; }
  if (_liveModPanelEl)   { try { _liveModPanelEl.remove(); } catch (_) {} _liveModPanelEl = null; }
  _liveModPanelOpen = false;
}

/** Build the initial static HTML skeleton for the panel. */
function _buildModPanelHTML() {
  return `
<button class="snx-mod-toggle-btn" aria-label="AI Moderation Panel">
  <span class="snx-mod-btn-icon">🤖</span>
  <span class="snx-mod-btn-label">AI MOD</span>
  <span class="snx-mod-status-dot" id="snxModStatusDot"></span>
</button>
<div class="snx-mod-drawer" id="snxModDrawer">
  <div class="snx-mod-header">
    <span class="snx-mod-title">🤖 AI Moderation</span>
    <span class="snx-mod-badge" id="snxModBadge">—</span>
  </div>
  <div class="snx-mod-flags" id="snxModFlags">
    <div class="snx-mod-empty">No flags in this session.</div>
  </div>
  <div class="snx-mod-footer">AI assists — host retains control.</div>
</div>`;
}

/** Sync the panel's open/closed state and AI on/off status. */
function _renderModPanelState(panel) {
  if (!panel) return;
  const drawer = panel.querySelector('#snxModDrawer');
  const dot    = panel.querySelector('#snxModStatusDot');
  const badge  = panel.querySelector('#snxModBadge');
  const isOn   = window._aiModerationEnabled !== false;

  if (drawer) drawer.classList.toggle('open', _liveModPanelOpen);
  if (dot) {
    dot.className = 'snx-mod-status-dot ' + (isOn ? 'on' : 'off');
    dot.title     = isOn ? 'AI Moderation ON' : 'AI Moderation OFF';
  }
  if (badge) {
    badge.textContent  = isOn ? '🟢 ON' : '🔴 OFF';
    badge.style.color  = isOn ? '#39FF14' : '#ff5566';
  }
}

/** Refresh the recent flags list from the existing aiModerationLog. */
async function _refreshModPanelLog(panel, roomId) {
  if (!panel) return;
  const flagsEl = panel.querySelector('#snxModFlags');
  if (!flagsEl) return;

  // Sync status badge in case AI was toggled externally
  _renderModPanelState(panel);

  // If AI is off, show a clear note and stop
  if (window._aiModerationEnabled === false) {
    flagsEl.innerHTML = '<div class="snx-mod-unavail">⚠️ AI Moderation is OFF</div>';
    return;
  }

  // Use the existing window._snxFirestore (same as the rest of the app)
  const fs = window._snxFirestore;
  if (!fs || !fs.db || !fs.collection || !fs.query || !fs.orderBy || !fs.limit || !fs.getDocs) {
    flagsEl.innerHTML = '<div class="snx-mod-unavail">AI MODERATION TEMPORARILY UNAVAILABLE</div>';
    return;
  }

  try {
    const { db, collection, query, orderBy, limit, getDocs } = fs;
    // Read the last 8 entries from the shared aiModerationLog — same path used by
    // the Founder dashboard and moderator panel. No new collection.
    const snap = await getDocs(
      query(collection(db, 'aiModerationLog'), orderBy('createdAt', 'desc'), limit(8))
    );

    if (snap.empty) {
      flagsEl.innerHTML = '<div class="snx-mod-empty">No recent flags.</div>';
      return;
    }

    const rows = [];
    snap.forEach(doc => {
      const d = doc.data();
      // Show Live-comment flags first, then any other recent flags
      const isLive = (d.context || '').includes('live');
      const tsMs = d.createdAt && typeof d.createdAt.toMillis === 'function'
        ? d.createdAt.toMillis()
        : (d.ts || 0);
      const age = _fmtModAge(tsMs);
      const sevClass = d.type === 'action' ? 'snx-mod-flag-block' : 'snx-mod-flag-warn';
      const icon = d.type === 'escalated' ? '🚨' : d.type === 'action' ? '🚫' : '⚠️';
      rows.push({ isLive, html:
        `<div class="snx-mod-flag-row ${sevClass}">
          <span class="snx-mod-flag-icon">${icon}</span>
          <div class="snx-mod-flag-body">
            <div class="snx-mod-flag-cat">${_esc(d.category || d.type || '—')}</div>
            <div class="snx-mod-flag-user">${_esc(d.username || d.authorName || d.uid || '—')}${isLive ? ' · 🔴 Live' : ''}</div>
            <div class="snx-mod-flag-age">${age}</div>
          </div>
        </div>` });
    });

    // Live flags first
    rows.sort((a, b) => (b.isLive ? 1 : 0) - (a.isLive ? 1 : 0));
    flagsEl.innerHTML = rows.map(r => r.html).join('');
  } catch (e) {
    flagsEl.innerHTML = '<div class="snx-mod-unavail">AI MODERATION TEMPORARILY UNAVAILABLE</div>';
    _log('Live mod panel: Firestore read failed (' + e.message + ') — Live unaffected');
  }
}

/** Format a Firestore timestamp into a human-readable age string. */
function _fmtModAge(tsMs) {
  if (!tsMs) return '';
  const diff = Date.now() - tsMs;
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return Math.floor(diff / 60000) + 'm ago';
  return Math.floor(diff / 3600000) + 'h ago';
}

_log('live.js loaded — SNS-2026-LIVE-008');
