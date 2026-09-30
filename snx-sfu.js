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
 *   Provider: _SnxMediasoupProvider   ← PRODUCTION (self-hosted mediasoup)
 *    or P2P   (mesh fallback — limited, does not support multi-guest)
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
 *   connect(options)            → Promise<void>
 *   disconnect()                → void
 *   publishLocalStream(stream)  → Promise<void>
 *   unpublishLocalStream()      → void
 *   setMicMuted(muted)          → void
 *   setCamMuted(muted)          → void
 *   getRemoteStream(uid)        → MediaStream | null
 *   getActiveSpeakers()         → string[]  (uids)
 *   destroy()                   → void
 *
 * connect() options:
 *   {
 *     sfuUrl:    string,  SNX media server WSS URL
 *     token:     string,  SNX session token (signed by Cloudflare Worker)
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

const _SNX_SFU_VERSION  = '2.0.0';
const _WORKER_BASE_SFU  = 'https://yellow-term-11e6.nthntjrn.workers.dev';

// Active provider instance
let _provider = null;

// Cached provider type selection.
// 'mediasoup' = production self-hosted SNX media server (default)
// 'p2p'       = legacy host-centric mesh — does NOT support multi-guest or viewer distribution
// 'livekit'   = DEPRECATED — kept for emergency rollback only; requires LiveKit credentials
let _providerType = 'mediasoup';

/* ─────────────────────────────────────────────────────────────────────────────
   DEVELOPMENT URL OVERRIDE
   ─────────────────────────────────────────────────────────────────────────────
   Set window._snxSfuDevUrl BEFORE this script loads (or any time before
   snxSfu.connect() is called) to bypass the Cloudflare Worker's
   SNX_MEDIA_SERVER_URL and connect directly to a local or staging server.

   Examples:
     window._snxSfuDevUrl = 'ws://192.168.1.10:3099';   // LAN dev
     window._snxSfuDevUrl = 'ws://localhost:3099';        // local dev
     window._snxSfuDevUrl = 'wss://your-vps.example.com:3099'; // staging

   In production this must be left unset (undefined / null) — the URL
   issued by the Worker (SNX_MEDIA_SERVER_URL secret) is used instead.
   NEVER hardcode a production wss:// URL here.
   ───────────────────────────────────────────────────────────────────────── */

window.snxSfu = {

  /* ── Initialise provider type ── */
  setProvider(type) {
    if (type !== 'mediasoup' && type !== 'p2p' && type !== 'livekit') {
      console.warn('[SNX-SFU] Unknown provider:', type, '— ignoring');
      return;
    }
    _providerType = type;
    console.log('[SNX-SFU] Provider set to:', type);
  },

  /**
   * Fetch a short-lived SNX session token from the Cloudflare Worker.
   * Replaces the old LiveKit token fetch.
   * Returns { token, url } where url is the SNX media server WSS endpoint.
   *
   * @param {string}  roomName          — Firebase roomId
   * @param {string}  participantName   — Firebase UID
   * @param {boolean} canPublish        — true for host/guest, false for viewer
   */
  async fetchToken(roomName, participantName, canPublish) {
    const auth = window._snxAuth;
    if (!auth || !auth.currentUser) throw new Error('Not authenticated');
    const idToken = await auth.currentUser.getIdToken();
    const resp = await fetch(_WORKER_BASE_SFU + '/snx-live/token', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify({ roomName, participantName, canPublish }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error('SNX token fetch failed (' + resp.status + '): ' + err);
    }
    const data = await resp.json();
    if (!data.token) throw new Error('Worker returned no token');

    // ── Dev URL override ──────────────────────────────────────────────────────
    // window._snxSfuDevUrl overrides whatever the Worker returns.
    // Use this for local/LAN/staging testing only.
    // Production: leave window._snxSfuDevUrl unset — Worker URL is used.
    const devUrl = (typeof window._snxSfuDevUrl === 'string' && window._snxSfuDevUrl.trim())
      ? window._snxSfuDevUrl.trim()
      : null;

    const resolvedUrl = devUrl || data.url;
    if (!resolvedUrl) {
      throw new Error(
        'SNX media server URL not configured. ' +
        'Set SNX_MEDIA_SERVER_URL in Cloudflare Worker secrets, ' +
        'or set window._snxSfuDevUrl for local development.'
      );
    }
    if (devUrl) {
      console.log('[SNX-SFU] Using dev URL override:', devUrl);
    }
    return { token: data.token, url: resolvedUrl };
  },

  /**
   * Notify the backend that a room is starting (host only).
   * With mediasoup the room is created on first participant JOIN, so this
   * is a lightweight pre-registration that allows the Worker to record the
   * roomId → hostId mapping for authorization checks.
   */
  async ensureRoom(roomName) {
    const auth = window._snxAuth;
    if (!auth || !auth.currentUser) throw new Error('Not authenticated');
    const idToken = await auth.currentUser.getIdToken();
    const resp = await fetch(_WORKER_BASE_SFU + '/snx-live/room', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + idToken,
      },
      body: JSON.stringify({ roomName }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error('Room registration failed (' + resp.status + '): ' + err);
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
    console.log('[SNX LIVE] Media provider:', type);
    console.log('[SNX-SFU] connect — provider:', type, 'room:', options.roomName, 'role:', options.role);
    if (type !== 'mediasoup') {
      console.warn('[SNX LIVE] ⚠ ACTIVE PROVIDER = ' + type.toUpperCase() +
        ' — mediasoup is NOT active. Multi-guest/viewer distribution will NOT work.');
    }

    if (type === 'mediasoup') {
      _provider = new _SnxMediasoupProvider();
    } else if (type === 'livekit') {
      // DEPRECATED — LiveKit Cloud.  Kept for emergency rollback only.
      // Requires LIVEKIT_API_KEY / LIVEKIT_API_SECRET to be configured.
      // WARNING: This path does NOT satisfy the SNX self-hosted requirement.
      console.warn('[SNX-SFU] ⚠ LiveKit provider is DEPRECATED and should not be used in production.');
      _provider = new _LiveKitProvider();
    } else {
      // p2p fallback — limited: no guest-to-guest visibility, no viewer-sees-guests
      console.warn('[SNX-SFU] ⚠ P2P provider does NOT support multi-guest or viewer distribution.');
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

  /**
   * Host removes a guest from the stage.
   * Sends HOST_REMOVE_GUEST via the active provider's WebSocket.
   * Also used by live.js to delegate guest removal to the media server.
   *
   * @param {string} guestUid
   */
  async removeGuest(guestUid) {
    if (!_provider || typeof _provider.removeGuest !== 'function') {
      console.warn('[SNX-SFU] removeGuest: provider does not support this method');
      return;
    }
    return _provider.removeGuest(guestUid);
  },

  /**
   * Host ends the entire Live.  Closes the media room for all participants.
   */
  async endLive() {
    if (!_provider || typeof _provider.endLive !== 'function') {
      console.warn('[SNX-SFU] endLive: provider does not support this method');
      return;
    }
    return _provider.endLive();
  },

  /* ── Diagnostics ── */
  get isConnected()    { return !!_provider; },
  get providerType()   { return _providerType; },
  get version()        { return _SNX_SFU_VERSION; },
};

/* ═══════════════════════════════════════════════════════════
   SNX MEDIASOUP PROVIDER  (PRODUCTION)
   ─────────────────────────────────────────────────────────
   Connects to the Shadow Nexus self-hosted mediasoup media
   server over a plain WebSocket (WSS in production).

   Protocol: JSON request/response over WebSocket.
   Every request:  { type, requestId, ...payload }
   Every response: { type: 'REPLY', requestId, ok, data, error }
   Server pushes:  { type: 'NEW_PRODUCER' | 'PEER_JOINED' | 'PEER_LEFT' | ... }

   mediasoup-client SDK is loaded from CDN lazily on first connect.
   No LiveKit SDK is required.
════════════════════════════════════════════════════════════ */

const _MS_CLIENT_SDK_URL = 'https://cdn.jsdelivr.net/npm/mediasoup-client@3/dist/mediasoup-client.min.js';

// Cached SDK (loaded once as a global script injection — mediasoup-client uses UMD)
let _msClientLoaded = false;
let _msClientLoadPromise = null;

async function _loadMsClient() {
  if (_msClientLoaded && typeof window.mediasoupClient !== 'undefined') return;
  if (!_msClientLoadPromise) {
    _msClientLoadPromise = new Promise((resolve, reject) => {
      if (typeof window.mediasoupClient !== 'undefined') {
        _msClientLoaded = true;
        resolve();
        return;
      }
      const s = document.createElement('script');
      s.src = _MS_CLIENT_SDK_URL;
      s.onload  = () => { _msClientLoaded = true; resolve(); };
      s.onerror = () => reject(new Error('Failed to load mediasoup-client SDK'));
      document.head.appendChild(s);
    });
  }
  return _msClientLoadPromise;
}

class _SnxMediasoupProvider {
  constructor() {
    this._ws              = null;   // WebSocket to SNX media server
    this._device          = null;   // mediasoup-client Device
    this._sendTransport   = null;   // mediasoup-client SendTransport
    this._recvTransport   = null;   // mediasoup-client RecvTransport
    this._localStream     = null;   // local camera/mic MediaStream (publishers only)
    this._callbacks       = {};
    this._uid             = null;
    this._roomName        = null;
    this._role            = null;
    this._destroyed       = false;
    this._reqId           = 0;
    this._pending         = new Map();   // requestId → { resolve, reject }
    this._remoteStreams    = new Map();   // uid → MediaStream
    this._activeSpeakers  = [];
    this._speakerTimer    = null;
    this._producers       = new Map();   // kind → Producer object
  }

  // ── Public provider API ──────────────────────────────────────────────────

  async connect(options) {
    const { sfuUrl, token, roomName, uid, role, callbacks } = options;
    this._callbacks = callbacks || {};
    this._uid       = uid;
    this._roomName  = roomName;
    this._role      = role;

    if (!sfuUrl || !token) {
      throw new Error('[SNX-MS] sfuUrl and token are required');
    }

    // Load mediasoup-client SDK
    await _loadMsClient();
    if (typeof window.mediasoupClient === 'undefined') {
      throw new Error('[SNX-MS] mediasoup-client SDK not available');
    }

    // Open WebSocket connection to SNX media server
    await this._openWebSocket(sfuUrl);

    // JOIN the room — server returns rtpCapabilities
    const joinResp = await this._request('JOIN', { token });
    const { rtpCapabilities } = joinResp;

    // Load mediasoup-client Device with server's RTP capabilities
    this._device = new window.mediasoupClient.Device();
    await this._device.load({ routerRtpCapabilities: rtpCapabilities });

    this._emit('onConnected', uid);
    this._emit('onConnectionStateChange', 'connected');
    console.log('[SNX-MS] Connected to room:', roomName, 'as:', role);

    // Get existing producers in the room and subscribe to them
    const { producers } = await this._request('GET_PRODUCERS', {});
    for (const { uid: pUid, producerId, kind } of producers) {
      // Subscribe to all existing publishers
      await this._subscribeToProducer(pUid, producerId, kind);
    }

    // Start active speaker polling (getStats-based, no server push needed)
    this._startSpeakerDetection();
  }

  disconnect() {
    this._destroyed = true;
    this._stopSpeakerDetection();
    // Send LEAVE (best-effort)
    try { this._sendNoWait('LEAVE', {}); } catch (_) {}
    this._closeWebSocket();
    this._cleanup();
  }

  async publishLocalStream(stream) {
    if (!stream) return;
    this._localStream = stream;

    // Create send transport if not already created
    if (!this._sendTransport) {
      await this._createSendTransport();
    }

    for (const track of stream.getTracks()) {
      if (this._producers.has(track.kind)) continue;  // already published
      const producer = await this._sendTransport.produce({
        track,
        encodings: track.kind === 'video'
          ? [
              { maxBitrate:  96_000, scaleResolutionDownBy: 4 },   // low (thumbnail)
              { maxBitrate: 500_000, scaleResolutionDownBy: 2 },   // medium
              { maxBitrate: 900_000, scaleResolutionDownBy: 1 },   // full
            ]
          : undefined,
        codecOptions: track.kind === 'audio'
          ? { opusStereo: false, opusDtx: true }
          : undefined,
      });
      this._producers.set(track.kind, producer);

      producer.on('transportclose', () => {
        this._producers.delete(track.kind);
      });

      producer.on('trackended', () => {
        console.log('[SNX-MS] Track ended —', track.kind);
        this._producers.delete(track.kind);
      });

      console.log('[SNX-MS] Published', track.kind, 'producer:', producer.id);
    }
  }

  unpublishLocalStream() {
    for (const [kind, producer] of this._producers) {
      try { producer.close(); } catch (_) {}
    }
    this._producers.clear();
  }

  setMicMuted(muted) {
    const audioProducer = this._producers.get('audio');
    if (audioProducer) {
      if (muted) audioProducer.pause();
      else        audioProducer.resume();
    }
    if (this._localStream) {
      this._localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    }
  }

  setCamMuted(muted) {
    const videoProducer = this._producers.get('video');
    if (videoProducer) {
      if (muted) videoProducer.pause();
      else        videoProducer.resume();
    }
    if (this._localStream) {
      this._localStream.getVideoTracks().forEach(t => { t.enabled = !muted; });
    }
  }

  getRemoteStream(uid) {
    return this._remoteStreams.get(uid) || null;
  }

  getActiveSpeakers() {
    return [...this._activeSpeakers];
  }

  /** Host removes a guest. Sends HOST_REMOVE_GUEST to server. */
  async removeGuest(guestUid) {
    await this._request('HOST_REMOVE_GUEST', { guestUid });
  }

  /** Host ends the live. Sends HOST_END_LIVE to server. */
  async endLive() {
    await this._request('HOST_END_LIVE', {});
  }

  destroy() {
    this.disconnect();
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  _openWebSocket(sfuUrl) {
    return new Promise((resolve, reject) => {
      // Convert http(s):// → ws(s):// if needed
      const wsUrl = sfuUrl
        .replace(/^https:\/\//, 'wss://')
        .replace(/^http:\/\//, 'ws://');
      const url = wsUrl.endsWith('/ws') ? wsUrl : wsUrl.replace(/\/$/, '') + '/ws';

      const ws = new WebSocket(url);
      this._ws = ws;

      const timeout = setTimeout(() => {
        reject(new Error('[SNX-MS] WebSocket connection timeout'));
        ws.close();
      }, 10_000);

      ws.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };

      ws.onerror = (e) => {
        clearTimeout(timeout);
        reject(new Error('[SNX-MS] WebSocket error'));
      };

      ws.onclose = (e) => {
        console.log('[SNX-MS] WebSocket closed — code:', e.code);
        if (!this._destroyed) {
          this._emit('onDisconnected');
          this._emit('onConnectionStateChange', 'disconnected');
          this._rejectAllPending('WebSocket closed');
        }
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        this._onServerMessage(msg);
      };
    });
  }

  _closeWebSocket() {
    if (this._ws) {
      try { this._ws.close(); } catch (_) {}
      this._ws = null;
    }
  }

  // ── Server message handler ───────────────────────────────────────────────

  _onServerMessage(msg) {
    const { type, requestId, ok, data, error } = msg;

    // ── Reply to a pending request ──
    if (type === 'REPLY' && requestId !== undefined) {
      const pending = this._pending.get(requestId);
      if (pending) {
        this._pending.delete(requestId);
        if (ok) pending.resolve(data || {});
        else    pending.reject(new Error(error || 'Server error'));
      }
      return;
    }

    // ── Server push notifications ──
    switch (type) {

      case 'NEW_PRODUCER':
        // A participant started publishing a new track — subscribe to it
        if (msg.uid !== this._uid) {
          this._subscribeToProducer(msg.uid, msg.producerId, msg.kind)
            .catch(e => console.error('[SNX-MS] subscribe to NEW_PRODUCER failed:', e.message));
        }
        break;

      case 'PEER_JOINED':
        if (msg.uid !== this._uid) {
          this._emit('onParticipantJoined', msg.uid, msg.uid);
        }
        break;

      case 'PEER_LEFT':
        this._remoteStreams.delete(msg.uid);
        this._emit('onParticipantLeft', msg.uid);
        this._emit('onTrackUnsubscribed', msg.uid);
        break;

      case 'CONSUMER_CLOSED': {
        // A remote producer closed — remove from stream map if empty
        const stream = this._remoteStreams.get(msg.producerUid);
        if (stream) {
          // Remove the specific consumer's track — we don't have it here so
          // just check if the stream is now empty after a short delay.
          setTimeout(() => {
            const s = this._remoteStreams.get(msg.producerUid);
            if (s && s.getTracks().filter(t => t.readyState !== 'ended').length === 0) {
              this._remoteStreams.delete(msg.producerUid);
              this._emit('onTrackUnsubscribed', msg.producerUid);
            }
          }, 200);
        }
        break;
      }

      case 'REMOVED_FROM_STAGE':
        // Server told this participant they were removed by the host
        console.log('[SNX-MS] Removed from stage by host');
        this._emit('onConnectionStateChange', 'removed');
        break;

      case 'LIVE_ENDED':
        console.log('[SNX-MS] Host ended the live');
        this._emit('onConnectionStateChange', 'ended');
        break;

      default:
        break;
    }
  }

  // ── Subscribe to a remote producer ──────────────────────────────────────

  async _subscribeToProducer(pUid, producerId, kind) {
    if (!this._recvTransport) {
      await this._createRecvTransport();
    }

    let consumerData;
    try {
      consumerData = await this._request('CONSUME', {
        producerId,
        rtpCapabilities: this._device.rtpCapabilities,
      });
    } catch (e) {
      console.warn('[SNX-MS] CONSUME failed for', pUid, producerId, '—', e.message);
      return;
    }

    const { consumerId, kind: consKind, rtpParameters } = consumerData;

    const consumer = await this._recvTransport.consume({
      id:            consumerId,
      producerId,
      kind:          consKind,
      rtpParameters,
    });

    // Resume consumer on server side
    await this._request('RESUME_CONSUMER', { consumerId });

    // Build or update remote MediaStream for this uid
    let stream = this._remoteStreams.get(pUid);
    if (!stream) {
      stream = new MediaStream();
      this._remoteStreams.set(pUid, stream);
    }
    if (!stream.getTracks().some(t => t.id === consumer.track.id)) {
      stream.addTrack(consumer.track);
    }

    consumer.on('transportclose', () => {
      this._remoteStreams.delete(pUid);
      this._emit('onTrackUnsubscribed', pUid);
    });

    consumer.on('producerclose', () => {
      this._remoteStreams.delete(pUid);
      this._emit('onTrackUnsubscribed', pUid);
    });

    // Only fire onTrackSubscribed once we have a video track (same rule as LiveKit provider)
    const hasVideo = stream.getVideoTracks().some(t => t.readyState !== 'ended');
    if (hasVideo) {
      console.log('[SNX-MS] onTrackSubscribed —', pUid, 'tracks:', stream.getTracks().length);
      this._emit('onTrackSubscribed', pUid, stream);
    } else if (kind === 'audio') {
      // Audio arrived first — wait for video (it will trigger onTrackSubscribed when ready)
      console.log('[SNX-MS] Audio track received for', pUid, '— waiting for video');
    }
  }

  // ── Create mediasoup-client transports ───────────────────────────────────

  async _createSendTransport() {
    const { transport: params } = await this._request('CREATE_SEND_TRANSPORT', {});

    this._sendTransport = this._device.createSendTransport(params);

    this._sendTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this._request('CONNECT_TRANSPORT', {
          transportId:    this._sendTransport.id,
          dtlsParameters,
        });
        callback();
      } catch (e) { errback(e); }
    });

    this._sendTransport.on('produce', async ({ kind, rtpParameters, appData }, callback, errback) => {
      try {
        const { producerId } = await this._request('PRODUCE', { kind, rtpParameters, appData });
        callback({ id: producerId });
      } catch (e) { errback(e); }
    });

    this._sendTransport.on('connectionstatechange', (state) => {
      console.log('[SNX-MS] sendTransport state:', state);
      if (state === 'failed') {
        this._emit('onError', new Error('sendTransport connection failed'));
      }
    });
  }

  async _createRecvTransport() {
    const { transport: params } = await this._request('CREATE_RECV_TRANSPORT', {});

    this._recvTransport = this._device.createRecvTransport(params);

    this._recvTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this._request('CONNECT_TRANSPORT', {
          transportId:    this._recvTransport.id,
          dtlsParameters,
        });
        callback();
      } catch (e) { errback(e); }
    });

    this._recvTransport.on('connectionstatechange', (state) => {
      console.log('[SNX-MS] recvTransport state:', state);
      if (state === 'failed') {
        this._emit('onError', new Error('recvTransport connection failed'));
      }
    });
  }

  // ── Active speaker detection ─────────────────────────────────────────────

  _startSpeakerDetection() {
    const INTERVAL  = 1500;
    const THRESHOLD = 0.01;

    this._speakerTimer = setInterval(async () => {
      const speakers = [];

      if (this._recvTransport) {
        try {
          const stats = await this._recvTransport.getStats();
          for (const [uid, stream] of this._remoteStreams) {
            // Check inbound-rtp audio level from the transport stats
            let level = 0;
            stats.forEach(r => {
              if (r.type === 'inbound-rtp' && r.kind === 'audio') {
                level = Math.max(level, r.audioLevel || 0);
              }
            });
            if (level > THRESHOLD) speakers.push(uid);
          }
        } catch (_) {}
      }

      this._activeSpeakers = speakers;
      this._emit('onActiveSpeakersChanged', speakers);
    }, INTERVAL);
  }

  _stopSpeakerDetection() {
    if (this._speakerTimer) {
      clearInterval(this._speakerTimer);
      this._speakerTimer = null;
    }
  }

  // ── Request/response over WebSocket ─────────────────────────────────────

  _request(type, data) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        reject(new Error('[SNX-MS] WebSocket not open'));
        return;
      }
      const requestId = ++this._reqId;
      this._pending.set(requestId, { resolve, reject });

      const timeout = setTimeout(() => {
        if (this._pending.has(requestId)) {
          this._pending.delete(requestId);
          reject(new Error('[SNX-MS] Request timeout: ' + type));
        }
      }, 15_000);

      // Wrap resolve/reject to also clear the timeout
      const origResolve = resolve;
      const origReject  = reject;
      this._pending.set(requestId, {
        resolve: (v) => { clearTimeout(timeout); origResolve(v); },
        reject:  (e) => { clearTimeout(timeout); origReject(e); },
      });

      try {
        this._ws.send(JSON.stringify({ type, requestId, ...data }));
      } catch (e) {
        this._pending.delete(requestId);
        clearTimeout(timeout);
        reject(e);
      }
    });
  }

  _sendNoWait(type, data) {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) {
      try { this._ws.send(JSON.stringify({ type, ...data })); } catch (_) {}
    }
  }

  _rejectAllPending(reason) {
    for (const [, { reject }] of this._pending) {
      try { reject(new Error(reason)); } catch (_) {}
    }
    this._pending.clear();
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  _cleanup() {
    for (const producer of this._producers.values()) {
      try { producer.close(); } catch (_) {}
    }
    this._producers.clear();

    if (this._sendTransport) {
      try { this._sendTransport.close(); } catch (_) {}
      this._sendTransport = null;
    }
    if (this._recvTransport) {
      try { this._recvTransport.close(); } catch (_) {}
      this._recvTransport = null;
    }

    this._remoteStreams.clear();
    this._pending.clear();
    this._localStream  = null;
    this._device       = null;
    this._callbacks    = {};
    this._activeSpeakers = [];
  }

  // ── Event emitter ────────────────────────────────────────────────────────

  _emit(name, ...args) {
    const fn = this._callbacks[name];
    if (typeof fn === 'function') {
      try { fn(...args); } catch (e) {
        console.error('[SNX-MS] callback', name, 'threw:', e.message);
      }
    }
  }
}


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
