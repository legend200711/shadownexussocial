/**
 * Shadow Nexus Social — SFU Media Layer
 * snx-sfu.js
 *
 * Provides a single, provider-agnostic interface between the live UI
 * (live.js) and the real-time media transport layer.
 *
 * Architecture
 * ────────────
 *
 *   UI layer (live.js)
 *       │  calls snxSfu.*
 *       ▼
 *   snxSfu (this file)          ← provider-agnostic façade
 *       │  delegates to
 *       ▼
 *   Provider: LiveKit            ← default, production
 *    or P2P   (mesh fallback)
 *       │
 *       ▼
 *   RTC media (audio/video tracks)
 *
 * Firebase is NEVER used to carry media.
 * Firebase is used only for:
 *   - liveRooms/{roomId}   room metadata
 *   - boxRequests          join requests
 *   - liveChats            chat messages
 *   - livePresence         viewer count
 *
 * Provider API contract
 * ─────────────────────
 * Every provider must implement:
 *
 *   connect(options)         → Promise<void>
 *   disconnect()             → void
 *   publishLocalStream(stream)  → Promise<void>
 *   unpublishLocalStream()   → void
 *   setMicMuted(muted)       → void
 *   setCamMuted(muted)       → void
 *   getRemoteStream(uid)     → MediaStream | null
 *   getActiveSpeakers()      → string[]  (uids)
 *   destroy()                → void
 *
 * connect() options:
 *   {
 *     sfuUrl:    string,  LiveKit WSS URL
 *     token:     string,  LiveKit JWT access token
 *     roomName:  string,
 *     uid:       string,
 *     role:      'host' | 'guest' | 'viewer',
 *     callbacks: {
 *       onConnected(participantUid),
 *       onDisconnected(),
 *       onParticipantJoined(uid, name),
 *       onParticipantLeft(uid),
 *       onTrackSubscribed(uid, stream),     // called when remote track is ready
 *       onTrackUnsubscribed(uid),
 *       onActiveSpeakersChanged(uids[]),
 *       onConnectionStateChange(state),
 *       onError(err),
 *     }
 *   }
 *
 * Box state contract (enforced by this layer)
 * ─────────────────────────────────────────────
 * A participant box MUST NOT become 'ready' / LIVE until
 * onTrackSubscribed fires with a real MediaStream.
 * No faking.
 */

/* ═══════════════════════════════════════════════════════════
   PUBLIC FAÇADE — window.snxSfu
════════════════════════════════════════════════════════════ */

const _SNX_SFU_VERSION = '1.0.0';
const _WORKER_BASE_SFU  = 'https://yellow-term-11e6.nthntjrn.workers.dev';

// Active provider instance (LiveKit or P2P)
let _provider = null;

// Cached provider type selection
let _providerType = 'livekit';  // 'livekit' | 'p2p'

window.snxSfu = {

  /* ── Initialise provider type ── */
  setProvider(type) {
    if (type !== 'livekit' && type !== 'p2p') {
      console.warn('[SNX-SFU] Unknown provider:', type, '— ignoring');
      return;
    }
    _providerType = type;
    console.log('[SNX-SFU] Provider set to:', type);
  },

  /* ── Fetch a LiveKit room token from the Cloudflare Worker ── */
  async fetchToken(roomName, participantName, canPublish) {
    const auth = window._snxAuth;
    if (!auth || !auth.currentUser) throw new Error('Not authenticated');
    const idToken = await auth.currentUser.getIdToken();
    const resp = await fetch(_WORKER_BASE_SFU + '/livekit-token', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify({ roomName, participantName, canPublish }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error('Token fetch failed (' + resp.status + '): ' + err);
    }
    const data = await resp.json();
    if (!data.token) throw new Error('Worker returned no token');
    return { token: data.token, url: data.url };
  },

  /* ── Ensure the LiveKit room exists on the server ── */
  async ensureRoom(roomName) {
    const auth = window._snxAuth;
    if (!auth || !auth.currentUser) throw new Error('Not authenticated');
    const idToken = await auth.currentUser.getIdToken();
    const resp = await fetch(_WORKER_BASE_SFU + '/livekit-room', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify({ roomName }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error('Room creation failed (' + resp.status + '): ' + err);
    }
    return await resp.json();
  },

  /* ── Connect to the SFU room ── */
  async connect(options) {
    if (_provider) {
      console.warn('[SNX-SFU] Already connected — disconnecting first');
      _provider.destroy();
      _provider = null;
    }

    const type = _providerType;
    console.log('[SNX-SFU] connect — provider:', type, 'room:', options.roomName, 'role:', options.role);

    if (type === 'livekit') {
      _provider = new _LiveKitProvider();
    } else {
      _provider = new _P2PProvider();
    }

    try {
      await _provider.connect(options);
    } catch (e) {
      console.error('[SNX-SFU] connect failed:', e.message);
      _provider = null;
      throw e;
    }
  },

  /* ── Disconnect from the SFU room ── */
  disconnect() {
    if (_provider) {
      _provider.destroy();
      _provider = null;
    }
    console.log('[SNX-SFU] disconnected');
  },

  /* ── Publish a local MediaStream (host/guest) ── */
  async publishLocalStream(stream) {
    if (!_provider) throw new Error('Not connected to SFU');
    return _provider.publishLocalStream(stream);
  },

  /* ── Stop publishing (but stay connected as subscriber) ── */
  unpublishLocalStream() {
    if (!_provider) return;
    _provider.unpublishLocalStream();
  },

  /* ── Mute/unmute microphone ── */
  setMicMuted(muted) {
    if (!_provider) return;
    _provider.setMicMuted(muted);
  },

  /* ── Mute/unmute camera ── */
  setCamMuted(muted) {
    if (!_provider) return;
    _provider.setCamMuted(muted);
  },

  /* ── Get the MediaStream for a remote participant ── */
  getRemoteStream(uid) {
    if (!_provider) return null;
    return _provider.getRemoteStream(uid);
  },

  /* ── Current active speakers ── */
  getActiveSpeakers() {
    if (!_provider) return [];
    return _provider.getActiveSpeakers();
  },

  /* ── Diagnostics ── */
  get isConnected()    { return !!_provider; },
  get providerType()   { return _providerType; },
  get version()        { return _SNX_SFU_VERSION; },
};

/* ═══════════════════════════════════════════════════════════
   LIVEKIT PROVIDER
   Uses the LiveKit browser SDK (livekit-client) loaded from
   the CDN. The SDK is lazy-imported on first connect so it
   does not block page load.
════════════════════════════════════════════════════════════ */

const _LK_SDK_URL = 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.esm.mjs';

// Cached SDK module (loaded once)
let _lkSdkPromise = null;

async function _loadLkSdk() {
  if (!_lkSdkPromise) {
    _lkSdkPromise = import(_LK_SDK_URL);
  }
  return _lkSdkPromise;
}

class _LiveKitProvider {
  constructor() {
    this._room         = null;    // LiveKit Room instance
    this._callbacks    = {};
    this._localPub     = null;    // local audio publication
    this._localVidPub  = null;    // local video publication
    this._remoteSub    = new Map(); // uid → MediaStream
    this._activeSpeakers = [];
    this._destroyed    = false;
  }

  async connect(options) {
    const { sfuUrl, token, roomName, uid, role, callbacks } = options;
    this._callbacks = callbacks || {};
    this._role = role;
    this._uid  = uid;

    if (!sfuUrl || !token) {
      throw new Error('[SNX-SFU/LiveKit] sfuUrl and token are required');
    }

    // Load LiveKit SDK
    let lk;
    try {
      lk = await _loadLkSdk();
    } catch (e) {
      throw new Error('[SNX-SFU/LiveKit] Failed to load SDK: ' + e.message);
    }

    const { Room, RoomEvent, Track, ConnectionState } = lk;

    this._room = new Room({
      // Adaptive stream: automatically adjusts subscription quality
      adaptiveStream: true,
      // Dynacast: disable unused layers to save upload bandwidth
      dynacast: true,
      // Audio defaults
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      },
      // Video defaults
      videoCaptureDefaults: {
        facingMode: 'user',
        resolution: { width: 640, height: 480, frameRate: 24 },
      },
    });

    const room = this._room;

    // ── Room lifecycle events ──
    room.on(RoomEvent.Connected, () => {
      console.log('[SNX-SFU/LiveKit] Connected to room:', roomName);
      this._emit('onConnected', uid);
      this._emit('onConnectionStateChange', 'connected');
    });

    room.on(RoomEvent.Disconnected, (reason) => {
      console.log('[SNX-SFU/LiveKit] Disconnected from room:', roomName, 'reason:', reason);
      if (!this._destroyed) {
        this._emit('onDisconnected');
        this._emit('onConnectionStateChange', 'disconnected');
      }
    });

    room.on(RoomEvent.Reconnecting, () => {
      console.log('[SNX-SFU/LiveKit] Reconnecting...');
      this._emit('onConnectionStateChange', 'reconnecting');
    });

    room.on(RoomEvent.Reconnected, () => {
      console.log('[SNX-SFU/LiveKit] Reconnected');
      this._emit('onConnectionStateChange', 'connected');
    });

    // ── Participant events ──
    room.on(RoomEvent.ParticipantConnected, (participant) => {
      const pUid = _lkParticipantUid(participant);
      console.log('[SNX-SFU/LiveKit] Participant connected:', pUid, participant.name);
      this._emit('onParticipantJoined', pUid, participant.name || pUid);
      // Subscribe to their existing tracks (if any published before we joined)
      this._subscribeParticipantTracks(participant, lk);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      const pUid = _lkParticipantUid(participant);
      console.log('[SNX-SFU/LiveKit] Participant disconnected:', pUid);
      this._remoteSub.delete(pUid);
      this._emit('onParticipantLeft', pUid);
      this._emit('onTrackUnsubscribed', pUid);
    });

    // ── Track events ──
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      const pUid = _lkParticipantUid(participant);
      console.log('[SNX-SFU/LiveKit] Track subscribed:', pUid, track.kind);
      this._assembleRemoteStream(pUid, track, lk);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      const pUid = _lkParticipantUid(participant);
      console.log('[SNX-SFU/LiveKit] Track unsubscribed:', pUid, track.kind);
      const stream = this._remoteSub.get(pUid);
      if (stream) {
        try { stream.removeTrack(track.mediaStreamTrack); } catch (_) {}
        if (stream.getTracks().length === 0) {
          this._remoteSub.delete(pUid);
          this._emit('onTrackUnsubscribed', pUid);
        }
      }
    });

    room.on(RoomEvent.TrackMuted, (publication, participant) => {
      const pUid = _lkParticipantUid(participant);
      console.log('[SNX-SFU/LiveKit] Track muted:', pUid, publication.kind);
      // Re-emit so UI can show camera-off / mic-off indicator
      this._emit('onTrackMuteChanged', pUid, publication.kind, true);
    });

    room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
      const pUid = _lkParticipantUid(participant);
      console.log('[SNX-SFU/LiveKit] Track unmuted:', pUid, publication.kind);
      this._emit('onTrackMuteChanged', pUid, publication.kind, false);
    });

    // ── Active speakers ──
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      this._activeSpeakers = speakers.map(_lkParticipantUid);
      this._emit('onActiveSpeakersChanged', this._activeSpeakers);
    });

    // ── Connect ──
    try {
      await room.connect(sfuUrl, token, {
        autoSubscribe: true,
      });
    } catch (e) {
      throw new Error('[SNX-SFU/LiveKit] Room.connect failed: ' + e.message);
    }

    // Subscribe to any participants already in the room
    room.remoteParticipants.forEach((participant) => {
      const pUid = _lkParticipantUid(participant);
      this._emit('onParticipantJoined', pUid, participant.name || pUid);
      this._subscribeParticipantTracks(participant, lk);
    });
  }

  /* ── Publish local camera + mic (host or guest) ── */
  async publishLocalStream(stream) {
    const room = this._room;
    if (!room) throw new Error('Not connected');

    // Use the already-captured MediaStream tracks from getUserMedia so we do
    // not start a second camera capture.  LiveKit's publishTrack() accepts a
    // raw MediaStreamTrack with an explicit source hint.
    const lk = await _loadLkSdk();
    const { LocalVideoTrack, LocalAudioTrack, Track, createLocalTracks } = lk;

    const videoTracks = stream ? stream.getVideoTracks() : [];
    const audioTracks = stream ? stream.getAudioTracks() : [];

    for (const t of videoTracks) {
      try {
        const lvt = new LocalVideoTrack(t, { loggerName: 'snx-video' }, false);
        await room.localParticipant.publishTrack(lvt, { source: Track.Source.Camera });
        this._localVidPub = lvt;
        console.log('[SNX-SFU/LiveKit] video track published');
      } catch (e) {
        console.error('[SNX-SFU/LiveKit] publish video track failed:', e.message);
      }
    }

    for (const t of audioTracks) {
      try {
        const lat = new LocalAudioTrack(t, { loggerName: 'snx-audio' }, false);
        await room.localParticipant.publishTrack(lat, { source: Track.Source.Microphone });
        this._localPub = lat;
        console.log('[SNX-SFU/LiveKit] audio track published');
      } catch (e) {
        console.error('[SNX-SFU/LiveKit] publish audio track failed:', e.message);
      }
    }

    // Fallback: if the stream had no tracks, use LiveKit built-in capture
    if (!videoTracks.length && !audioTracks.length) {
      console.warn('[SNX-SFU/LiveKit] no tracks in stream — enabling built-in capture');
      try { await room.localParticipant.setCameraEnabled(true); } catch (_) {}
      try { await room.localParticipant.setMicrophoneEnabled(true); } catch (_) {}
    }

    console.log('[SNX-SFU/LiveKit] Local stream published');
  }

  unpublishLocalStream() {
    const room = this._room;
    if (!room) return;
    if (this._localVidPub) {
      try { room.localParticipant.unpublishTrack(this._localVidPub); } catch (_) {}
      this._localVidPub = null;
    }
    if (this._localPub) {
      try { room.localParticipant.unpublishTrack(this._localPub); } catch (_) {}
      this._localPub = null;
    }
  }

  setMicMuted(muted) {
    const room = this._room;
    if (!room) return;
    // Mute/unmute via LiveKit so the server-side track state is correct
    if (this._localPub) {
      try { this._localPub.muted = muted; } catch (_) {}
    }
    try { room.localParticipant.setMicrophoneEnabled(!muted); } catch (_) {}
  }

  setCamMuted(muted) {
    const room = this._room;
    if (!room) return;
    if (this._localVidPub) {
      try { this._localVidPub.muted = muted; } catch (_) {}
    }
    try { room.localParticipant.setCameraEnabled(!muted); } catch (_) {}
  }

  getRemoteStream(uid) {
    return this._remoteSub.get(uid) || null;
  }

  getActiveSpeakers() {
    return [...this._activeSpeakers];
  }

  destroy() {
    this._destroyed = true;
    if (this._room) {
      try { this._room.disconnect(); } catch (_) {}
      this._room = null;
    }
    this._remoteSub.clear();
    this._callbacks = {};
    this._activeSpeakers = [];
  }

  /* ── Internal: subscribe to a participant's existing tracks ── */
  _subscribeParticipantTracks(participant, lk) {
    participant.trackPublications.forEach((pub) => {
      if (pub.track && pub.isSubscribed) {
        this._assembleRemoteStream(_lkParticipantUid(participant), pub.track, lk);
      }
    });
  }

  /* ── Internal: build or update remote MediaStream for a participant ── */
  _assembleRemoteStream(pUid, track, lk) {
    const { Track } = lk;
    // Skip data tracks
    if (track.kind !== Track.Kind.Audio && track.kind !== Track.Kind.Video) return;

    const mediaTrack = track.mediaStreamTrack;
    if (!mediaTrack) {
      console.warn('[SNX-SFU/LiveKit] track.mediaStreamTrack is null for', pUid);
      return;
    }

    let stream = this._remoteSub.get(pUid);
    if (!stream) {
      stream = new MediaStream();
      this._remoteSub.set(pUid, stream);
    }

    // Avoid duplicate insertion
    if (!stream.getTracks().some(t => t.id === mediaTrack.id)) {
      stream.addTrack(mediaTrack);
    }

    // Only report as ready once a video track is present
    const hasVideo = stream.getVideoTracks().some(t => t.readyState !== 'ended');
    if (hasVideo) {
      console.log('[SNX-SFU/LiveKit] onTrackSubscribed — uid:', pUid,
        'tracks:', stream.getTracks().map(t => t.kind + ':' + t.readyState).join(', '));
      this._emit('onTrackSubscribed', pUid, stream);
    }
  }

  _emit(name, ...args) {
    const fn = this._callbacks[name];
    if (typeof fn === 'function') {
      try { fn(...args); } catch (e) {
        console.error('[SNX-SFU/LiveKit] callback', name, 'threw:', e.message);
      }
    }
  }
}

/* ── Helper: extract a stable UID from a LiveKit participant ──
   LiveKit participant.identity is the 'sub' claim in the JWT
   which we set to the user's Firebase UID.                    */
function _lkParticipantUid(participant) {
  return participant.identity || participant.sid || String(participant.name || 'unknown');
}

/* ═══════════════════════════════════════════════════════════
   P2P PROVIDER  (host-centric mesh fallback)
   Used when LiveKit is unavailable or for simple 1:1 testing.
   Wraps the existing direct RTCPeerConnection approach so the
   UI layer never needs to know which transport is in use.

   NOTE: This provider does NOT give guest-to-guest visibility
         (host-centric only). For full multi-guest visibility
         use the LiveKit provider.
════════════════════════════════════════════════════════════ */

class _P2PProvider {
  constructor() {
    this._peers      = new Map();  // uid → RTCPeerConnection
    this._streams    = new Map();  // uid → MediaStream
    this._localStream = null;
    this._callbacks  = {};
    this._activeSpeakers = [];
    this._destroyed  = false;
    this._speakerTimer = null;
  }

  async connect(options) {
    const { uid, role, callbacks } = options;
    this._callbacks = callbacks || {};
    this._role = role;
    this._uid  = uid;
    this._options = options;
    // P2P "connection" is implicit — peers are added lazily via addPeer()
    this._emit('onConnected', uid);
    this._emit('onConnectionStateChange', 'connected');
    this._startSpeakerDetection();
    console.log('[SNX-SFU/P2P] Provider ready — uid:', uid, 'role:', role);
  }

  /* ── P2P-only: called by live.js to add a remote peer ── */
  addPeer(remoteUid, pc) {
    if (this._peers.has(remoteUid)) return;
    this._peers.set(remoteUid, pc);

    const remoteStream = new MediaStream();
    this._streams.set(remoteUid, remoteStream);

    pc.ontrack = (e) => {
      const track = e.track;
      if (remoteStream.getTracks().some(t => t.id === track.id)) return;
      remoteStream.addTrack(track);

      // Only become LIVE when video track is present and live
      const hasVideo = remoteStream.getVideoTracks().some(t => t.readyState !== 'ended');
      if (hasVideo || track.kind === 'audio') {
        if (hasVideo) {
          this._emit('onTrackSubscribed', remoteUid, remoteStream);
        }
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log('[SNX-SFU/P2P] Peer', remoteUid, 'connectionState:', state);
      if (state === 'connected') {
        this._emit('onParticipantJoined', remoteUid, remoteUid);
      } else if (state === 'failed' || state === 'closed') {
        this.removePeer(remoteUid);
      }
    };
  }

  removePeer(uid) {
    const pc = this._peers.get(uid);
    if (pc) {
      try { pc.close(); } catch (_) {}
      this._peers.delete(uid);
    }
    this._streams.delete(uid);
    this._emit('onParticipantLeft', uid);
    this._emit('onTrackUnsubscribed', uid);
  }

  async publishLocalStream(stream) {
    this._localStream = stream;
    // Tracks are added to peer connections externally (live.js manages this for P2P)
  }

  unpublishLocalStream() {
    this._localStream = null;
  }

  setMicMuted(muted) {
    if (!this._localStream) return;
    this._localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }

  setCamMuted(muted) {
    if (!this._localStream) return;
    this._localStream.getVideoTracks().forEach(t => { t.enabled = !muted; });
  }

  getRemoteStream(uid) {
    return this._streams.get(uid) || null;
  }

  getActiveSpeakers() {
    return [...this._activeSpeakers];
  }

  _startSpeakerDetection() {
    const INTERVAL  = 1500;
    const THRESHOLD = 0.01;
    this._speakerTimer = setInterval(async () => {
      const speakers = [];
      for (const [uid, pc] of this._peers) {
        if (!pc.getStats) continue;
        try {
          const stats = await pc.getStats();
          let level = 0;
          stats.forEach(r => {
            if (r.type === 'inbound-rtp' && r.kind === 'audio') {
              level = Math.max(level, r.audioLevel || 0);
            }
          });
          if (level > THRESHOLD) speakers.push(uid);
        } catch (_) {}
      }
      this._activeSpeakers = speakers;
      if (speakers.length || this._lastSpeakers) {
        this._emit('onActiveSpeakersChanged', speakers);
      }
      this._lastSpeakers = speakers.length > 0;
    }, INTERVAL);
  }

  destroy() {
    this._destroyed = true;
    if (this._speakerTimer) { clearInterval(this._speakerTimer); this._speakerTimer = null; }
    for (const [uid, pc] of this._peers) {
      try { pc.close(); } catch (_) {}
    }
    this._peers.clear();
    this._streams.clear();
    this._callbacks = {};
    this._localStream = null;
  }

  _emit(name, ...args) {
    const fn = this._callbacks[name];
    if (typeof fn === 'function') {
      try { fn(...args); } catch (e) {
        console.error('[SNX-SFU/P2P] callback', name, 'threw:', e.message);
      }
    }
  }
}

console.log('[SNX-SFU] snx-sfu.js loaded — version', _SNX_SFU_VERSION);
