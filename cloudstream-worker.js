/**
 * Shadow Nexus Social — CloudStream Worker  (Stage 2)
 * cloudstream-worker.js
 *
 * Stage 2 additions:
 *   - Full server-side playback clock  (startedAt, pausedPosition, resumedAt)
 *   - Durable Object alarm schedules next-track automatically (no browser needed)
 *   - Repeat modes: off | queue | one
 *   - Shuffle order generated ONCE server-side, stored authoritatively
 *   - Channel recovery after DO restart — catches up on missed transitions
 *   - /api/stream/channel/:id  — full authoritative channel state for viewers
 *   - /api/media/library       — list user's media metadata from KV
 *   - /api/media/delete        — delete media metadata (R2 key returned for client deletion)
 *   - Error-skipping: marks broken tracks, advances safely
 *   - Firestore mirror kept in sync for UI recovery
 *
 * Environment bindings required (wrangler-studio.jsonc):
 *   cloudStreamKV     — KV namespace for stream/music/media state
 *   CloudStreamDO     — Durable Object namespace (CloudStreamScheduler)
 *   FIREBASE_PROJECT_ID, FIREBASE_API_KEY  — Firebase REST credentials
 *   STREAM_SECRET     — optional signing secret
 */

const ALLOWED_ORIGINS = [
  'https://shadownexussocial.online',
  'https://www.shadownexussocial.online',
  'https://chrislegendofshadows.com',
  'https://www.chrislegendofshadows.com',
];

function _corsHeaders(request) {
  const origin  = (request.headers.get('Origin') || '').trim();
  const allowed = ALLOWED_ORIGINS.includes(origin) || /^https?:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin':      allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods':     'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age':           '86400',
    'Vary':                             'Origin',
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  'https://shadownexussocial.online',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
  'Vary':                         'Origin',
};

/* ═══════════════════════════════════════════════════════
   MAIN FETCH HANDLER
═══════════════════════════════════════════════════════ */
export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;
    const cors   = _corsHeaders(request);

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      // Stream lifecycle
      if (method === 'POST' && path === '/api/stream/start')   return handleStart(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/stop')    return handleStop(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/control') return handleControlExtended(request, env, ctx, cors);

      // Stream state reads
      if (method === 'GET'  && path.startsWith('/api/stream/health/'))  return handleHealth(request, env, url, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/sync/'))    return handleStreamSync(request, env, url, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/active/'))  return handleActiveCheck(request, env, url, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/channel/')) return handleChannelState(request, env, url, cors);

      // Admin
      if (method === 'POST' && path === '/api/admin/stream/stop') return handleAdminStop(request, env, ctx, cors);
      if (method === 'GET'  && path === '/api/admin/streams')     return handleAdminList(request, env, cors);

      // Music/queue API
      if (method === 'POST' && path === '/api/stream/music/set')      return handleMusicSet(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/music/control')  return handleMusicControl(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/music/watchdog') return handleMusicWatchdog(request, env, url, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/music/')) return handleMusicGet(request, env, url, cors);

      // Viewer presence
      if (method === 'POST' && path === '/api/stream/listener/join')      return handleListenerJoin(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/listener/heartbeat') return handleListenerHeartbeat(request, env, ctx, cors);
      if (method === 'POST' && path === '/api/stream/listener/leave')     return handleListenerLeave(request, env, ctx, cors);

      // Likes
      if (method === 'POST' && path === '/api/stream/like')             return handleStreamLike(request, env, ctx, cors);
      if (method === 'GET'  && path.startsWith('/api/stream/likes/'))   return handleStreamLikesGet(request, env, url, cors);

      // Destinations
      if (method === 'POST' && path === '/api/destinations/save')   return handleDestinationsSave(request, env, cors);
      if (method === 'POST' && path === '/api/destinations/remove') return handleDestinationsRemove(request, env, cors);
      if (method === 'GET'  && path === '/api/destinations/list')   return handleDestinationsList(request, env, url, cors);

      // Media library metadata (stored in KV, files live in R2)
      if (method === 'POST'   && path === '/api/media/save')    return handleMediaSave(request, env, cors);
      if (method === 'DELETE' && path.startsWith('/api/media/delete/')) return handleMediaDelete(request, env, url, cors);
      if (method === 'GET'    && path.startsWith('/api/media/library/')) return handleMediaLibrary(request, env, url, cors);

      if (method === 'GET' && path === '/health') return jsonOK({ ok: true, worker: 'cloudstream', v: '2.0.0' }, cors);

      return jsonErr('Not found', 404, cors);
    } catch (err) {
      console.error('[CloudStream Worker]', err);
      return jsonErr('Internal worker error: ' + err.message, 500, cors);
    }
  }
};

/* ═══════════════════════════════════════════════════════
   STREAM START
═══════════════════════════════════════════════════════ */
async function handleStart(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const {
    streamId, uid, displayName, streamName, theme, scenePlaylist, durationMinutes,
    musicQueue, musicShuffle, musicRepeat, musicCrossfade, musicVolume, musicPlaylistId
  } = body;

  if (!streamId || !uid) return jsonErr('streamId and uid are required', 400, cors);
  if (!durationMinutes || durationMinutes < 1 || durationMinutes > 1440)
    return jsonErr('durationMinutes must be between 1 and 1440', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid)
        return jsonErr('Unauthorized: token UID does not match request uid', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const now = Date.now();
  const stream = {
    streamId, uid,
    displayName:   displayName || '',
    streamName:    streamName  || 'CloudStream',
    theme:         theme       || 'shadow-nexus',
    scenePlaylist: Array.isArray(scenePlaylist) ? scenePlaylist : [],
    durationMinutes,
    status:        'active',
    startedAt:     now,
    endsAt:        now + durationMinutes * 60 * 1000,
    currentScene:  scenePlaylist?.[0]?.name || 'Starting Soon',
    sceneIndex:    0,
    viewerCount:   0,
    lastHeartbeat: now,
    workerActive:  true,
  };

  // Build server-side authoritative music state
  if (env.cloudStreamKV && Array.isArray(musicQueue) && musicQueue.length) {
    // Determine repeat mode: support 'off'|'queue'|'one' or legacy boolean
    const repeatMode = _normalizeRepeat(musicRepeat);

    // Generate shuffle order server-side (deterministic, one source of truth)
    let shuffleOrder = null;
    if (musicShuffle) {
      shuffleOrder = _generateShuffleOrder(musicQueue.length);
    }

    const musicState = {
      streamId, uid,
      playlistId:     musicPlaylistId || '',
      queue:          musicQueue,
      queueIndex:     0,
      shuffleOrder,
      shuffle:        !!musicShuffle,
      repeat:         repeatMode,
      crossfade:      typeof musicCrossfade === 'number' ? musicCrossfade : 3,
      volume:         typeof musicVolume    === 'number' ? musicVolume   : 80,
      status:         'playing',
      // Server-side playback clock
      startedAt:      now,
      pausedPosition: 0,
      pausedAt:       null,
      lastAdvancedAt: now,
    };

    const ttl = (durationMinutes + 60) * 60;
    await env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState), { expirationTtl: ttl });

    // Schedule Durable Object alarm for first track
    if (env.CloudStreamDO && musicQueue[0] && musicQueue[0].duration) {
      const doId  = env.CloudStreamDO.idFromName(streamId + '_music');
      const doObj = env.CloudStreamDO.get(doId);
      await doObj.fetch('https://do/music-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId, durationMinutes, musicQueue,
          shuffle: !!musicShuffle, shuffleOrder,
          repeat: repeatMode, queueIndex: 0,
        }),
      });
    }
  }

  if (env.cloudStreamKV) {
    const ttl = (durationMinutes + 60) * 60;
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: ttl });
  }

  if (ctx) {
    ctx.waitUntil(Promise.all([
      logStreamEvent(env, streamId, 'stream_started', { streamName: stream.streamName, duration: durationMinutes }),
      markCloudStreamInFirestore(env, streamId, {
        status: 'active',
        startedAt: new Date(stream.startedAt).toISOString(),
        expiresAt: new Date(stream.endsAt).toISOString(),
      }),
    ]));
  }

  return jsonOK({ success: true, stream }, cors);
}

/* ═══════════════════════════════════════════════════════
   STREAM STOP
═══════════════════════════════════════════════════════ */
async function handleStop(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid } = body;
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid)
        return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);

  stream.status       = 'stopped';
  stream.stoppedAt    = Date.now();
  stream.workerActive = false;

  if (env.cloudStreamKV)
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });

  if (ctx) {
    ctx.waitUntil(Promise.all([
      markLiveRoomOffline(env, stream.uid),
      markCloudStreamInFirestore(env, streamId, {
        status: 'stopped', stoppedAt: new Date().toISOString(), stoppedBy: 'creator',
      }),
      writeCloudStreamHistory(env, stream, 'creator_stop'),
    ]));
  }

  return jsonOK({ success: true, message: 'Stream stopped.' }, cors);
}

/* ═══════════════════════════════════════════════════════
   CHANNEL STATE — full authoritative state for viewer sync
   GET /api/stream/channel/:streamId
   Returns everything a viewer needs to seek and play correctly.
═══════════════════════════════════════════════════════ */
async function handleChannelState(request, env, url, cors) {
  const streamId = url.pathname.replace('/api/stream/channel/', '');
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const [stream, musicState] = await Promise.all([
    getStream(streamId, env),
    env.cloudStreamKV ? env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' }) : null,
  ]);

  if (!stream) return jsonErr('Stream not found', 404, cors);

  const serverNow = Date.now();

  // Auto-expire if past endsAt
  if (stream.endsAt && serverNow > stream.endsAt && stream.status === 'active') {
    stream.status = 'stopped';
    if (env.cloudStreamKV)
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });
  }

  let media = null;
  let seekPosition = 0; // seconds the viewer should seek to

  if (musicState && musicState.queue && musicState.queue.length) {
    const q   = musicState.queue;
    const idx = musicState.queueIndex || 0;
    const cur = q[idx] || {};

    if (musicState.status === 'paused') {
      seekPosition = musicState.pausedPosition || 0;
    } else {
      // elapsed since this track started
      const trackStartedAt = musicState.lastAdvancedAt || musicState.startedAt || serverNow;
      seekPosition = Math.max(0, (serverNow - trackStartedAt) / 1000);
      // clamp to track duration
      if (cur.duration && seekPosition > cur.duration) seekPosition = Math.max(0, cur.duration - 1);
    }

    // Build upNext (next 5 items accounting for shuffle)
    const upNext = _buildUpNext(q, idx, musicState.shuffleOrder, 5);

    media = {
      currentTrackId:   cur.id         || '',
      currentTitle:     cur.title       || '',
      currentArtist:    cur.artist      || '',
      currentTrackUrl:  cur.url         || '',
      currentDuration:  cur.duration    || 0,
      artworkUrl:       cur.artworkUrl  || '',
      mediaType:        cur.mediaType   || 'music',
      queueIndex:       idx,
      queueLength:      q.length,
      musicStatus:      musicState.status || 'playing',
      seekPosition:     Math.round(seekPosition * 10) / 10, // tenths of a second
      lastAdvancedAt:   musicState.lastAdvancedAt || 0,
      pausedAt:         musicState.pausedAt || null,
      pausedPosition:   musicState.pausedPosition || 0,
      repeat:           musicState.repeat  || 'queue',
      shuffle:          !!musicState.shuffle,
      upNext,
      nextTitle:        upNext[0]?.title  || '',
      nextArtist:       upNext[0]?.artist || '',
    };
  }

  return jsonOK({
    success:     true,
    streamId,
    status:      stream.status,
    streamName:  stream.streamName  || '',
    displayName: stream.displayName || '',
    viewerCount: stream.viewerCount || 0,
    startedAt:   stream.startedAt   || 0,
    endsAt:      stream.endsAt      || 0,
    serverTime:  serverNow,
    media,
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   HEALTH CHECK (legacy, kept for compatibility)
═══════════════════════════════════════════════════════ */
async function handleHealth(request, env, url, cors) {
  const streamId = url.pathname.replace('/api/stream/health/', '');
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);

  if (stream.endsAt && Date.now() > stream.endsAt && stream.status === 'active') {
    stream.status = 'stopped';
    if (env.cloudStreamKV)
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });
  }

  stream.lastHeartbeat = Date.now();

  let musicInfo = {
    currentMusicTitle: '', currentMusicArtist: '', currentMusicUrl: '',
    nextMusicTitle: '', queueIndex: 0, musicStatus: 'no_music',
    lastMusicAdvancedAt: 0, currentMusicDuration: 0, seekPosition: 0,
  };

  if (env.cloudStreamKV) {
    const ms = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
    if (ms && ms.queue && ms.queue.length) {
      const cur = ms.queue[ms.queueIndex || 0] || {};
      const nxt = ms.queue[((ms.queueIndex || 0) + 1) % ms.queue.length] || {};
      const serverNow = Date.now();
      let seekPos = 0;
      if (ms.status === 'paused') {
        seekPos = ms.pausedPosition || 0;
      } else {
        const trackStart = ms.lastAdvancedAt || ms.startedAt || serverNow;
        seekPos = Math.max(0, (serverNow - trackStart) / 1000);
        if (cur.duration) seekPos = Math.min(seekPos, cur.duration - 1);
      }
      musicInfo = {
        currentMusicTitle:    cur.title      || '',
        currentMusicArtist:   cur.artist     || '',
        currentMusicUrl:      cur.url        || '',
        currentMusicId:       cur.id         || '',
        currentMusicDuration: cur.duration   || 0,
        artworkUrl:           cur.artworkUrl || '',
        mediaType:            cur.mediaType  || 'music',
        nextMusicTitle:       nxt.title      || '',
        queueIndex:           ms.queueIndex  || 0,
        musicStatus:          ms.status      || 'playing',
        musicVolume:          ms.volume      || 80,
        lastMusicAdvancedAt:  ms.lastAdvancedAt || 0,
        seekPosition:         Math.round(seekPos * 10) / 10,
        pausedPosition:       ms.pausedPosition || 0,
      };
    }
  }

  return jsonOK({
    success:       true,
    status:        stream.status,
    currentScene:  stream.currentScene,
    viewerCount:   stream.viewerCount,
    uptime:        stream.startedAt ? Math.floor((Date.now() - stream.startedAt) / 60000) : 0,
    lastHeartbeat: stream.lastHeartbeat,
    workerActive:  stream.workerActive,
    serverTime:    Date.now(),
    ...musicInfo,
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   STREAM SYNC (legacy viewer sync — enhanced with seekPosition)
═══════════════════════════════════════════════════════ */
async function handleStreamSync(request, env, url, cors) {
  const streamId = url.pathname.replace('/api/stream/sync/', '');
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);

  const serverNow = Date.now();
  if (stream.endsAt && serverNow > stream.endsAt && stream.status === 'active') {
    stream.status = 'stopped';
    if (env.cloudStreamKV)
      await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });
  }

  let musicInfo = {
    currentMusicTitle: '', currentMusicArtist: '', currentMusicUrl: '',
    currentMusicId: '', currentMusicDuration: 0,
    nextMusicTitle: '', nextMusicArtist: '',
    queueIndex: 0, musicStatus: 'no_music',
    lastAdvancedAt: 0, seekPosition: 0, pausedPosition: 0,
  };

  if (env.cloudStreamKV) {
    const ms = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
    if (ms && ms.queue && ms.queue.length) {
      const cur = ms.queue[ms.queueIndex || 0] || {};
      const nxt = ms.queue[((ms.queueIndex || 0) + 1) % ms.queue.length] || {};
      let seekPos = 0;
      if (ms.status === 'paused') {
        seekPos = ms.pausedPosition || 0;
      } else {
        const trackStart = ms.lastAdvancedAt || ms.startedAt || serverNow;
        seekPos = Math.max(0, (serverNow - trackStart) / 1000);
        if (cur.duration) seekPos = Math.min(seekPos, cur.duration - 1);
      }
      musicInfo = {
        currentMusicTitle:    cur.title      || '',
        currentMusicArtist:   cur.artist     || '',
        currentMusicUrl:      cur.url        || '',
        currentMusicId:       cur.id         || '',
        currentMusicDuration: cur.duration   || 0,
        artworkUrl:           cur.artworkUrl || '',
        mediaType:            cur.mediaType  || 'music',
        nextMusicTitle:       nxt.title      || '',
        nextMusicArtist:      nxt.artist     || '',
        queueIndex:           ms.queueIndex  || 0,
        musicStatus:          ms.status      || 'playing',
        lastAdvancedAt:       ms.lastAdvancedAt || 0,
        seekPosition:         Math.round(seekPos * 10) / 10,
        pausedPosition:       ms.pausedPosition || 0,
        pausedAt:             ms.pausedAt || null,
      };
    }
  }

  return jsonOK({
    success: true, streamId,
    status:      stream.status,
    streamName:  stream.streamName  || '',
    displayName: stream.displayName || '',
    viewerCount: stream.viewerCount || 0,
    startedAt:   stream.startedAt   || 0,
    endsAt:      stream.endsAt      || 0,
    serverTime:  serverNow,
    ...musicInfo,
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   ACTIVE CHECK
═══════════════════════════════════════════════════════ */
async function handleActiveCheck(request, env, url, cors) {
  const uid = url.pathname.replace('/api/stream/active/', '');
  if (!uid) return jsonErr('uid required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (!verified || verified.uid !== uid)
        return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  }

  if (!env.cloudStreamKV) return jsonOK({ active: false, streamId: null }, cors);

  const list = await env.cloudStreamKV.list({ prefix: 'stream:' });
  for (const key of (list.keys || [])) {
    const val = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (val && val.uid === uid && ['active','starting','recovering'].includes(val.status)) {
      return jsonOK({
        active: true,
        streamId: key.name.replace('stream:', ''),
        status: val.status,
        streamName: val.streamName || '',
      }, cors);
    }
  }
  return jsonOK({ active: false, streamId: null }, cors);
}

/* ═══════════════════════════════════════════════════════
   ADMIN: FORCE STOP
═══════════════════════════════════════════════════════ */
async function handleAdminStop(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, adminUid } = body;
  if (!streamId || !adminUid) return jsonErr('streamId and adminUid required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (!idToken) return jsonErr('Unauthorized: Authorization header required', 401, cors);
  try {
    const verified = await verifyFirebaseIdToken(idToken, env);
    if (!verified || verified.uid !== adminUid)
      return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    if (!await _verifyFounderRole(verified.uid, env))
      return jsonErr('Unauthorized: founder role required', 403, cors);
  } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);

  stream.status      = 'stopped';
  stream.stoppedBy   = 'admin';
  stream.stoppedAt   = Date.now();
  stream.workerActive = false;

  if (env.cloudStreamKV)
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: 3600 });

  if (ctx) {
    ctx.waitUntil(Promise.all([
      markLiveRoomOffline(env, stream.uid),
      markCloudStreamInFirestore(env, streamId, {
        status: 'stopped', stoppedAt: new Date().toISOString(), stoppedBy: 'admin',
      }),
    ]));
  }

  return jsonOK({ success: true, message: 'Stream force-stopped by admin.' }, cors);
}

/* ═══════════════════════════════════════════════════════
   ADMIN: LIST ACTIVE STREAMS
═══════════════════════════════════════════════════════ */
async function handleAdminList(request, env, cors) {
  const idToken = _extractBearerToken(request);
  if (!idToken) return jsonErr('Unauthorized: Authorization header required', 401, cors);
  try {
    const verified = await verifyFirebaseIdToken(idToken, env);
    if (!verified) return jsonErr('Unauthorized: invalid token', 403, cors);
    if (!await _verifyFounderRole(verified.uid, env))
      return jsonErr('Unauthorized: founder role required', 403, cors);
  } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }

  if (!env.cloudStreamKV) return jsonOK({ streams: [] }, cors);

  const list = await env.cloudStreamKV.list({ prefix: 'stream:' });
  const streams = [];
  for (const key of (list.keys || [])) {
    const val = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (val) streams.push(val);
  }
  return jsonOK({ streams: streams.filter(s => ['active','starting','recovering'].includes(s.status)) }, cors);
}

/* ═══════════════════════════════════════════════════════
   MUSIC SET
═══════════════════════════════════════════════════════ */
async function handleMusicSet(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid, queue, shuffle, repeat, crossfade, volume, playlistId, queueIndex } = body;
  if (!streamId || !uid) return jsonErr('streamId and uid required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);
  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);

  const existing     = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' }) || {};
  const repeatMode   = _normalizeRepeat(typeof repeat !== 'undefined' ? repeat : existing.repeat);
  const newShuffle   = typeof shuffle === 'boolean' ? shuffle : (existing.shuffle || false);
  const newQueue     = Array.isArray(queue) ? queue : (existing.queue || []);
  const now          = Date.now();

  // Regenerate shuffle order when shuffle toggled on or new queue provided
  let shuffleOrder = existing.shuffleOrder || null;
  if (newShuffle && (Array.isArray(queue) || !shuffleOrder)) {
    shuffleOrder = _generateShuffleOrder(newQueue.length);
  } else if (!newShuffle) {
    shuffleOrder = null;
  }

  const musicState = {
    ...existing,
    streamId, uid,
    playlistId:     playlistId || existing.playlistId || '',
    queue:          newQueue,
    queueIndex:     typeof queueIndex === 'number' ? queueIndex : 0,
    shuffleOrder,
    shuffle:        newShuffle,
    repeat:         repeatMode,
    crossfade:      typeof crossfade === 'number' ? crossfade : (existing.crossfade || 3),
    volume:         typeof volume    === 'number' ? volume    : (existing.volume    || 80),
    status:         'playing',
    lastAdvancedAt: now,
    startedAt:      now,
    pausedPosition: 0,
    pausedAt:       null,
  };

  const ttl = (stream.durationMinutes + 60) * 60;
  await env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState), { expirationTtl: ttl });

  if (env.CloudStreamDO && musicState.queue.length) {
    const curTrack = musicState.queue[musicState.queueIndex];
    if (curTrack && curTrack.duration) {
      const doId  = env.CloudStreamDO.idFromName(streamId + '_music');
      const doObj = env.CloudStreamDO.get(doId);
      await doObj.fetch('https://do/music-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          streamId, durationMinutes: stream.durationMinutes,
          musicQueue: musicState.queue, shuffle: musicState.shuffle,
          shuffleOrder: musicState.shuffleOrder,
          repeat: musicState.repeat, queueIndex: musicState.queueIndex,
        }),
      });
    }
  }

  if (ctx) ctx.waitUntil(pushNowPlayingToFirestore(env, streamId, musicState));

  const cur  = musicState.queue[musicState.queueIndex] || {};
  const next = musicState.queue[(musicState.queueIndex + 1) % (musicState.queue.length || 1)] || {};
  return jsonOK({
    success:       true,
    currentTitle:  cur.title  || '',
    currentArtist: cur.artist || '',
    nextTitle:     next.title || '',
    queueLength:   musicState.queue.length,
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   MUSIC CONTROL — PAUSE/RESUME with server clock
═══════════════════════════════════════════════════════ */
async function handleMusicControl(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid, action } = body;
  if (!streamId || !uid || !action) return jsonErr('streamId, uid and action required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);
  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);

  const musicState = await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });
  if (!musicState) return jsonErr('No music state found', 404, cors);

  const now = Date.now();

  switch (action) {
    case 'musicNext':
    case 'next': {
      const nextIdx = _computeNextIndex(musicState, false);
      if (nextIdx === null) {
        musicState.status = 'ended';
      } else {
        musicState.queueIndex = nextIdx;
        musicState.status     = 'playing';
      }
      musicState.lastAdvancedAt = now;
      musicState.startedAt      = now;
      musicState.pausedPosition = 0;
      musicState.pausedAt       = null;
      // Reschedule DO alarm for new track
      await _rescheduleAlarm(env, streamId, musicState, stream.durationMinutes);
      break;
    }
    case 'musicPrevious':
    case 'previous': {
      const qLen = musicState.queue.length;
      if (qLen > 0) {
        const cur = musicState.queueIndex || 0;
        musicState.queueIndex     = cur === 0 ? (musicState.repeat !== 'off' ? qLen - 1 : 0) : cur - 1;
        musicState.lastAdvancedAt = now;
        musicState.startedAt      = now;
        musicState.pausedPosition = 0;
        musicState.pausedAt       = null;
        musicState.status         = 'playing';
        await _rescheduleAlarm(env, streamId, musicState, stream.durationMinutes);
      }
      break;
    }
    case 'musicPause':
    case 'pause': {
      if (musicState.status !== 'paused') {
        // Calculate how far into the current track we are
        const trackStart   = musicState.lastAdvancedAt || musicState.startedAt || now;
        const elapsedSecs  = Math.max(0, (now - trackStart) / 1000);
        const cur          = musicState.queue[musicState.queueIndex || 0] || {};
        const clampedPos   = cur.duration ? Math.min(elapsedSecs, cur.duration) : elapsedSecs;
        musicState.pausedPosition = clampedPos;
        musicState.pausedAt       = now;
        musicState.status         = 'paused';
        // Cancel the DO alarm while paused
        await _rescheduleAlarm(env, streamId, musicState, stream.durationMinutes);
      }
      break;
    }
    case 'musicResume':
    case 'resume': {
      if (musicState.status === 'paused') {
        const pausedPos = musicState.pausedPosition || 0;
        // Recalculate startedAt so elapsed = pausedPos right now
        musicState.lastAdvancedAt = now - pausedPos * 1000;
        musicState.startedAt      = musicState.lastAdvancedAt;
        musicState.pausedAt       = null;
        musicState.status         = 'playing';
        await _rescheduleAlarm(env, streamId, musicState, stream.durationMinutes);
      }
      break;
    }
    case 'musicShuffle':
      musicState.shuffle = typeof body.value === 'boolean' ? body.value : !musicState.shuffle;
      if (musicState.shuffle) {
        musicState.shuffleOrder = _generateShuffleOrder(musicState.queue.length);
      } else {
        musicState.shuffleOrder = null;
      }
      break;
    case 'musicRepeat':
      if (typeof body.value === 'string' && ['off','queue','one'].includes(body.value)) {
        musicState.repeat = body.value;
      } else if (typeof body.value === 'boolean') {
        musicState.repeat = body.value ? 'queue' : 'off';
      } else {
        // cycle: off → queue → one → off
        const cycle = { off: 'queue', queue: 'one', one: 'off' };
        musicState.repeat = cycle[musicState.repeat || 'queue'] || 'queue';
      }
      break;
    case 'musicVolume':
      musicState.volume = typeof body.value === 'number' ? body.value : musicState.volume;
      break;
    case 'musicCrossfade':
      musicState.crossfade = typeof body.value === 'number' ? body.value : musicState.crossfade;
      break;
    case 'queueAppend': {
      const newItems = Array.isArray(body.items) ? body.items : [];
      if (newItems.length) musicState.queue = (musicState.queue || []).concat(newItems);
      if (musicState.shuffle) {
        musicState.shuffleOrder = _generateShuffleOrder(musicState.queue.length);
      }
      break;
    }
    case 'queueReplace': {
      if (!Array.isArray(body.queue) || !body.queue.length)
        return jsonErr('queue array required for queueReplace', 400, cors);
      musicState.queue          = body.queue;
      musicState.queueIndex     = 0;
      musicState.lastAdvancedAt = now;
      musicState.startedAt      = now;
      musicState.pausedPosition = 0;
      musicState.pausedAt       = null;
      musicState.status         = 'playing';
      if (musicState.shuffle) {
        musicState.shuffleOrder = _generateShuffleOrder(musicState.queue.length);
      }
      await _rescheduleAlarm(env, streamId, musicState, stream.durationMinutes);
      break;
    }
    default:
      return jsonErr('Unknown music action: ' + action, 400, cors);
  }

  const ttl = (stream.durationMinutes + 60) * 60;
  await env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState), { expirationTtl: ttl });

  if (ctx) ctx.waitUntil(pushNowPlayingToFirestore(env, streamId, musicState));

  const cur = musicState.queue[musicState.queueIndex || 0] || {};
  return jsonOK({
    success:        true,
    currentTitle:   cur.title  || '',
    queueIndex:     musicState.queueIndex,
    status:         musicState.status,
    repeat:         musicState.repeat,
    shuffle:        musicState.shuffle,
    seekPosition:   musicState.pausedPosition || 0,
    serverTime:     now,
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   MUSIC GET
═══════════════════════════════════════════════════════ */
async function handleMusicGet(request, env, url, cors) {
  const streamId = url.pathname.replace('/api/stream/music/', '');
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const musicState = env.cloudStreamKV
    ? await env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' })
    : null;

  if (!musicState) return jsonOK({ success: true, status: 'no_music', currentTitle: '', currentArtist: '', nextTitle: '' }, cors);

  const cur  = musicState.queue[musicState.queueIndex] || {};
  const next = musicState.queue[(musicState.queueIndex + 1) % (musicState.queue.length || 1)] || {};
  return jsonOK({
    success:       true,
    status:        musicState.status || 'playing',
    playlistId:    musicState.playlistId || '',
    currentTitle:  cur.title   || '',
    currentArtist: cur.artist  || '',
    nextTitle:     next.title  || '',
    nextArtist:    next.artist || '',
    queueIndex:    musicState.queueIndex,
    queueLength:   musicState.queue.length,
    shuffle:       musicState.shuffle,
    repeat:        musicState.repeat,
    volume:        musicState.volume,
    crossfade:     musicState.crossfade,
  }, cors);
}

/* ═══════════════════════════════════════════════════════
   MUSIC WATCHDOG
═══════════════════════════════════════════════════════ */
async function handleMusicWatchdog(request, env, url, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, uid } = body;
  if (!streamId) return jsonErr('streamId required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (!verified || verified.uid !== uid) return jsonErr('Unauthorized', 403, cors);
    } catch(e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  }

  if (!env.CloudStreamDO) return jsonErr('DO not configured', 503, cors);
  const doId  = env.CloudStreamDO.idFromName(streamId + '_music');
  const doObj = env.CloudStreamDO.get(doId);
  const res   = await doObj.fetch('https://do/music-watchdog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streamId }),
  });
  const data = await res.json().catch(() => ({}));
  return jsonOK(data, cors);
}

/* ═══════════════════════════════════════════════════════
   MEDIA LIBRARY METADATA — save after R2 upload succeeds
   POST /api/media/save
═══════════════════════════════════════════════════════ */
async function handleMediaSave(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { uid, mediaId, filename, title, mediaType, mimeType, r2Key, publicUrl,
          duration, fileSize, artworkUrl } = body;
  if (!uid || !mediaId || !r2Key) return jsonErr('uid, mediaId and r2Key required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);

  const metadata = {
    mediaId, ownerUid: uid, filename: filename || '',
    title: title || filename || 'Untitled',
    mediaType: mediaType || 'music',
    mimeType: mimeType || '',
    r2Key, publicUrl: publicUrl || '',
    duration: duration || 0,
    fileSize: fileSize || 0,
    artworkUrl: artworkUrl || '',
    uploadStatus: 'ready',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await env.cloudStreamKV.put(`media:${uid}:${mediaId}`, JSON.stringify(metadata), { expirationTtl: 86400 * 365 });

  return jsonOK({ success: true, mediaId, metadata }, cors);
}

/* ═══════════════════════════════════════════════════════
   MEDIA LIBRARY — list user media from KV
   GET /api/media/library/:uid
═══════════════════════════════════════════════════════ */
async function handleMediaLibrary(request, env, url, cors) {
  const uid = url.pathname.replace('/api/media/library/', '');
  if (!uid) return jsonErr('uid required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (!verified || verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  }

  if (!env.cloudStreamKV) return jsonOK({ items: [] }, cors);

  const prefix = `media:${uid}:`;
  const list   = await env.cloudStreamKV.list({ prefix });
  const items  = [];
  for (const key of (list.keys || [])) {
    const val = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (val) items.push(val);
  }
  items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return jsonOK({ items }, cors);
}

/* ═══════════════════════════════════════════════════════
   MEDIA DELETE — remove metadata (client should also DELETE from R2)
   DELETE /api/media/delete/:uid/:mediaId
═══════════════════════════════════════════════════════ */
async function handleMediaDelete(request, env, url, cors) {
  const parts   = url.pathname.replace('/api/media/delete/', '').split('/');
  const uid     = parts[0];
  const mediaId = parts[1];
  if (!uid || !mediaId) return jsonErr('uid and mediaId required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);

  const kvKey  = `media:${uid}:${mediaId}`;
  const record = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  if (!record) return jsonErr('Media not found', 404, cors);

  await env.cloudStreamKV.delete(kvKey);
  return jsonOK({ success: true, r2Key: record.r2Key, artworkR2Key: record.artworkR2Key || null }, cors);
}

/* ═══════════════════════════════════════════════════════
   CONTROL EXTENDED
═══════════════════════════════════════════════════════ */
async function handleControlExtended(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }

  const { streamId, uid, action } = body;
  if (!streamId || !uid || !action) return jsonErr('streamId, uid and action required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const musicActions = [
    'musicNext','musicPrevious','musicPause','musicResume',
    'musicShuffle','musicRepeat','musicVolume','musicCrossfade',
    'next','previous','pause','resume','queueAppend','queueReplace',
  ];
  if (musicActions.includes(action)) {
    return _handleMusicControlBody(body, request, env, ctx, cors);
  }

  return _handleControlBody(body, request, env, ctx, cors);
}

async function _handleMusicControlBody(body, request, env, ctx, cors) {
  // Re-use handleMusicControl logic with already-parsed body
  const fakeRequest = {
    json: async () => body,
    headers: request.headers,
  };
  return handleMusicControl(fakeRequest, env, ctx, cors);
}

async function _handleControlBody(body, request, env, ctx, cors) {
  const { streamId, uid, action } = body;
  const stream = await getStream(streamId, env);
  if (!stream) return jsonErr('Stream not found', 404, cors);
  if (stream.uid !== uid) return jsonErr('Unauthorized', 403, cors);
  if (!['active','recovering'].includes(stream.status))
    return jsonErr('Stream is not active. Status: ' + stream.status, 409, cors);

  switch (action) {
    case 'setScene':      stream.currentScene      = body.sceneId  || stream.currentScene; break;
    case 'setTheme':      stream.theme             = body.themeId  || stream.theme;        break;
    case 'setVolume':     stream.musicVolume       = typeof body.volume === 'number' ? body.volume : stream.musicVolume; break;
    case 'announce':      stream.lastAnnouncement  = { text: body.text || '', ts: Date.now() }; break;
    case 'nextScene':
      if (stream.scenePlaylist && stream.scenePlaylist.length) {
        stream.sceneIndex   = (stream.sceneIndex + 1) % stream.scenePlaylist.length;
        stream.currentScene = stream.scenePlaylist[stream.sceneIndex].name;
      }
      break;
    case 'setSchedule':   stream.musicSchedule     = body.schedule || []; break;
    case 'setVisualizer': stream.visualizerPreset  = body.preset   || 'bars'; break;
    default: return jsonErr('Unknown action: ' + action, 400, cors);
  }

  stream.lastControlAt = Date.now();
  if (env.cloudStreamKV)
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: (stream.durationMinutes + 60) * 60 });

  return jsonOK({ success: true, stream }, cors);
}

/* ═══════════════════════════════════════════════════════
   DURABLE OBJECT — CloudStreamScheduler  (Stage 2)
   One instance per channel: "{streamId}_music"
   Owns the authoritative playback clock via alarms.
═══════════════════════════════════════════════════════ */
export class CloudStreamScheduler {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  async fetch(request) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && path === '/schedule') {
      return this._handleSchedule(request);
    }
    if (request.method === 'POST' && path === '/music-schedule') {
      return this._handleMusicSchedule(request);
    }
    if (request.method === 'POST' && path === '/music-watchdog') {
      return this._handleMusicWatchdog(request);
    }
    if (request.method === 'POST' && path === '/music-pause') {
      return this._handleMusicPause(request);
    }
    if (request.method === 'POST' && path === '/music-resume') {
      return this._handleMusicResume(request);
    }
    return jsonErr('Not found', 404);
  }

  /* ── Scene scheduling (legacy) ── */
  async _handleSchedule(request) {
    let body;
    try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400); }
    const { streamId, scenePlaylist, durationMinutes } = body;
    if (!streamId) return jsonErr('streamId required', 400);

    await this.state.storage.put('streamId',       streamId);
    await this.state.storage.put('scenePlaylist',  JSON.stringify(scenePlaylist || []));
    await this.state.storage.put('sceneIndex',     0);
    await this.state.storage.put('startedAt',      Date.now());
    await this.state.storage.put('durationMinutes',durationMinutes || 1440);
    await this.state.storage.put('mode',           'scene');

    if (scenePlaylist && scenePlaylist.length > 0) {
      const first = (scenePlaylist[0].duration || 1200) * 1000;
      await this.state.storage.setAlarm(Date.now() + first);
    }
    return jsonOK({ scheduled: true, streamId });
  }

  /* ── Music scheduling ── */
  async _handleMusicSchedule(request) {
    let body;
    try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400); }

    const { streamId, durationMinutes, musicQueue, shuffle, shuffleOrder, repeat, queueIndex } = body;
    if (!streamId || !Array.isArray(musicQueue) || !musicQueue.length)
      return jsonOK({ scheduled: false, reason: 'empty queue' });

    const now = Date.now();
    await this.state.storage.put('m_streamId',      streamId);
    await this.state.storage.put('m_queue',         JSON.stringify(musicQueue));
    await this.state.storage.put('m_queueIndex',    queueIndex || 0);
    await this.state.storage.put('m_shuffle',       shuffle ? 1 : 0);
    await this.state.storage.put('m_shuffleOrder',  JSON.stringify(shuffleOrder || null));
    await this.state.storage.put('m_repeat',        repeat || 'queue');
    await this.state.storage.put('m_startedAt',     now);
    await this.state.storage.put('m_lastAlarmAt',   now);
    await this.state.storage.put('m_durationMin',   durationMinutes || 1440);
    await this.state.storage.put('mode',            'music');

    const idx   = queueIndex || 0;
    const track = musicQueue[idx];
    const dur   = track && track.duration ? track.duration * 1000 : 240000;
    await this.state.storage.setAlarm(now + dur);

    return jsonOK({ scheduled: true, streamId, firstTrack: track ? track.title : '' });
  }

  /* ── Pause: cancel alarm ── */
  async _handleMusicPause(request) {
    await this.state.storage.deleteAlarm();
    return jsonOK({ ok: true, action: 'alarm_cancelled' });
  }

  /* ── Resume: reschedule alarm for remaining duration ── */
  async _handleMusicResume(request) {
    let body;
    try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400); }

    const { remainingMs } = body;
    if (!remainingMs || remainingMs <= 0) return jsonOK({ ok: true, reason: 'no_remaining' });

    const fireAt = Date.now() + Math.max(1000, Math.min(remainingMs, 6 * 60 * 60 * 1000));
    await this.state.storage.setAlarm(fireAt);
    return jsonOK({ ok: true, action: 'alarm_rescheduled', fireAt });
  }

  /* ── Watchdog ── */
  async _handleMusicWatchdog(request) {
    const streamId = await this.state.storage.get('m_streamId');
    if (!streamId) return jsonOK({ ok: true, reason: 'no_stream' });

    const mode = (await this.state.storage.get('mode')) || 'scene';
    if (mode !== 'music') return jsonOK({ ok: true, reason: 'not_music_mode' });

    let musicState = null;
    if (this.env.cloudStreamKV)
      musicState = await this.env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });

    if (!musicState) return jsonOK({ ok: true, reason: 'kv_no_state' });
    if (['stopped','ended'].includes(musicState.status))
      return jsonOK({ ok: true, reason: 'stream_ended' });

    if (musicState.status === 'paused') return jsonOK({ ok: true, reason: 'paused' });

    const lastAdvanced  = musicState.lastAdvancedAt || 0;
    const cur           = musicState.queue && musicState.queue[musicState.queueIndex || 0];
    const trackDurMs    = (cur && cur.duration ? cur.duration : 240) * 1000;
    const staleness     = Date.now() - lastAdvanced;

    if (staleness > trackDurMs + 10 * 60 * 1000) {
      await this.state.storage.put('m_lastAlarmAt', Date.now());
      await this.state.storage.setAlarm(Date.now() + 1000);
      await logStreamEvent(this.env, streamId, 'music_watchdog_triggered', { staleness, trackDurMs });
      return jsonOK({ ok: true, reason: 'alarm_rescheduled', staleness });
    }

    return jsonOK({ ok: true, reason: 'alarm_healthy', staleness });
  }

  /* ════════════════════════════════════════════
     ALARM HANDLER — fires when a track ends
  ════════════════════════════════════════════ */
  async alarm() {
    const mode = (await this.state.storage.get('mode')) || 'scene';
    if (mode === 'music') {
      await this._handleMusicAlarm();
    } else {
      await this._handleSceneAlarm();
    }
  }

  async _handleMusicAlarm() {
    const streamId    = await this.state.storage.get('m_streamId');
    const durationMin = (await this.state.storage.get('m_durationMin')) || 1440;
    const startedAt   = (await this.state.storage.get('m_startedAt'))   || Date.now();

    if (!streamId) return;

    // Authoritative state lives in KV
    let musicState = null;
    if (this.env.cloudStreamKV)
      musicState = await this.env.cloudStreamKV.get(`music:${streamId}`, { type: 'json' });

    if (!musicState) {
      await logStreamEvent(this.env, streamId, 'music_alarm_no_state', { reason: 'kv_missing' });
      return;
    }

    // Check stream expiry
    const streamRec = this.env.cloudStreamKV
      ? await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' })
      : null;
    if (streamRec && streamRec.endsAt && Date.now() > streamRec.endsAt) {
      await this._endStream(streamId);
      return;
    }
    const elapsed = (Date.now() - startedAt) / 60000;
    if (elapsed >= durationMin) { await this._endStream(streamId); return; }

    // Paused — reschedule check in 30s
    if (musicState.status === 'paused') {
      await this.state.storage.setAlarm(Date.now() + 30000);
      return;
    }

    if (!musicState.queue || !musicState.queue.length) {
      musicState.status = 'paused';
      await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
      await logStreamEvent(this.env, streamId, 'music_queue_empty', {});
      await this.state.storage.setAlarm(Date.now() + 60000);
      return;
    }

    // ── Channel recovery: check if we're behind (DO restarted) ──────────────
    // If the alarm fires late, we may need to skip multiple tracks
    const now         = Date.now();
    let queueIndex    = musicState.queueIndex || 0;
    let lastAdvanced  = musicState.lastAdvancedAt || now;
    const q           = musicState.queue;
    const qLen        = q.length;

    // Catch up: if more than one track-duration has passed since lastAdvanced, skip forward
    let catchupSafe = 0;
    while (catchupSafe < qLen) {
      const candidateTrack = q[queueIndex];
      const candidateDur   = (candidateTrack && candidateTrack.duration ? candidateTrack.duration : 240) * 1000;
      if (now - lastAdvanced < candidateDur) break; // we're within the current track

      // This track should already have ended — skip it
      lastAdvanced = lastAdvanced + candidateDur;
      const nextIdx = _computeNextIndexFromState(queueIndex, musicState.shuffle, musicState.shuffleOrder, musicState.repeat, qLen);
      if (nextIdx === null) {
        musicState.status = 'ended';
        await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
        await logStreamEvent(this.env, streamId, 'music_ended', { reason: 'repeat_off_catchup' });
        return;
      }
      queueIndex = nextIdx;
      catchupSafe++;
    }

    musicState.queueIndex     = queueIndex;
    musicState.lastAdvancedAt = now;
    musicState.startedAt      = now;
    musicState.status         = 'playing';
    musicState.pausedPosition = 0;
    musicState.pausedAt       = null;

    // Compute next index for scheduling purposes
    const nextIdx = _computeNextIndexFromState(queueIndex, musicState.shuffle, musicState.shuffleOrder, musicState.repeat, qLen);

    if (nextIdx === null && musicState.repeat === 'off') {
      // Advance to last track, play it, then end
      await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));
      const curTrack = q[queueIndex] || {};
      const curDur   = Math.max(5000, Math.min((curTrack.duration || 240) * 1000, 6 * 3600 * 1000));
      await this.state.storage.setAlarm(now + curDur);
      await pushNowPlayingToFirestore(this.env, streamId, musicState);
      return;
    }

    // Skip tracks with no URL
    let finalIndex = queueIndex;
    let skipped = 0;
    while (skipped < qLen) {
      const candidate = q[finalIndex];
      if (candidate && candidate.url) break;
      await logStreamEvent(this.env, streamId, 'track_skipped', { reason: 'no_url', index: finalIndex, title: (candidate && candidate.title) || '' });
      finalIndex = _computeNextIndexFromState(finalIndex, musicState.shuffle, musicState.shuffleOrder, musicState.repeat, qLen);
      if (finalIndex === null) { finalIndex = 0; break; }
      skipped++;
    }
    musicState.queueIndex = finalIndex;

    if (this.env.cloudStreamKV)
      await this.env.cloudStreamKV.put(`music:${streamId}`, JSON.stringify(musicState));

    await this.state.storage.put('m_queueIndex',  finalIndex);
    await this.state.storage.put('m_lastAlarmAt', now);

    await pushNowPlayingToFirestore(this.env, streamId, musicState);

    const playingTrack = q[finalIndex] || {};
    await logStreamEvent(this.env, streamId, 'track_advanced', {
      title: playingTrack.title || '', artist: playingTrack.artist || '', index: finalIndex,
    });

    const rawDur  = playingTrack.duration ? playingTrack.duration * 1000 : 240000;
    const nextDur = Math.max(5000, Math.min(rawDur, 6 * 3600 * 1000));
    await this.state.storage.setAlarm(now + nextDur);
  }

  async _handleSceneAlarm() {
    const streamId     = await this.state.storage.get('streamId');
    const sceneJson    = await this.state.storage.get('scenePlaylist');
    const sceneIndex   = (await this.state.storage.get('sceneIndex')) || 0;
    const startedAt    = (await this.state.storage.get('startedAt')) || Date.now();
    const durationMin  = (await this.state.storage.get('durationMinutes')) || 1440;

    if (!streamId) return;

    const scenePlaylist = sceneJson ? JSON.parse(sceneJson) : [];
    const elapsed = (Date.now() - startedAt) / 60000;
    if (elapsed >= durationMin) { await this._endStream(streamId); return; }

    const nextIndex = (sceneIndex + 1) % scenePlaylist.length;
    await this.state.storage.put('sceneIndex', nextIndex);

    if (this.env.cloudStreamKV) {
      const streamData = await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
      if (streamData && streamData.status === 'active') {
        const nextScene = scenePlaylist[nextIndex];
        streamData.currentScene = nextScene ? nextScene.name : streamData.currentScene;
        streamData.sceneIndex   = nextIndex;
        await this.env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(streamData));
      }
    }

    const nextScene = scenePlaylist[nextIndex];
    const nextDur   = (nextScene && nextScene.duration ? nextScene.duration : 1200) * 1000;
    await this.state.storage.setAlarm(Date.now() + nextDur);
  }

  async _endStream(streamId) {
    let uid = null;
    if (this.env.cloudStreamKV) {
      const streamData = await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
      if (streamData) {
        uid = streamData.uid;
        streamData.status    = 'stopped';
        streamData.stoppedAt = Date.now();
        streamData.reason    = 'scheduled_end';
        await this.env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(streamData), { expirationTtl: 3600 });
      }
    }
    await logStreamEvent(this.env, streamId, 'stream_ended', { reason: 'scheduled_end' });
    const stoppedData = this.env.cloudStreamKV
      ? (await this.env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' })) || {}
      : {};
    await Promise.all([
      uid ? markLiveRoomOffline(this.env, uid) : Promise.resolve(),
      markCloudStreamInFirestore(this.env, streamId, {
        status: 'stopped', stoppedAt: new Date().toISOString(), stoppedBy: 'scheduled_end',
      }),
      writeCloudStreamHistory(this.env, Object.assign({ streamId }, stoppedData), 'scheduled_end'),
    ]);
  }
}

/* ═══════════════════════════════════════════════════════
   FIREBASE REST HELPERS
═══════════════════════════════════════════════════════ */
async function _getAnonToken(env) {
  if (!env.FIREBASE_API_KEY) return null;
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) }
  );
  if (!res.ok) return null;
  const { idToken } = await res.json();
  return idToken || null;
}

async function pushNowPlayingToFirestore(env, streamId, musicState) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !musicState) return;

  const q      = musicState.queue || [];
  const idx    = musicState.queueIndex || 0;
  const cur    = q[idx] || {};
  const upNext = _buildUpNext(q, idx, musicState.shuffleOrder, 5);

  try {
    const idToken = await _getAnonToken(env);
    if (!idToken) return;

    const firestoreUrl =
      `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/studioCloudStreamMusic/${streamId}`;

    const serverNow = Date.now();
    let seekPos = 0;
    if (musicState.status === 'paused') {
      seekPos = musicState.pausedPosition || 0;
    } else {
      const trackStart = musicState.lastAdvancedAt || musicState.startedAt || serverNow;
      seekPos = Math.max(0, (serverNow - trackStart) / 1000);
      if (cur.duration) seekPos = Math.min(seekPos, cur.duration - 1);
    }

    const res = await fetch(firestoreUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: {
          cloudStreamId:    { stringValue:  streamId },
          uid:              { stringValue:  musicState.uid  || '' },
          currentTrackId:   { stringValue:  cur.id         || '' },
          currentTitle:     { stringValue:  cur.title       || '' },
          currentArtist:    { stringValue:  cur.artist      || '' },
          currentTrackUrl:  { stringValue:  cur.url         || '' },
          currentDuration:  { integerValue: String(cur.duration || 0) },
          artworkUrl:       { stringValue:  cur.artworkUrl  || '' },
          mediaType:        { stringValue:  cur.mediaType   || 'music' },
          queueIndex:       { integerValue: String(idx) },
          status:           { stringValue:  musicState.status || 'playing' },
          lastAdvancedAt:   { integerValue: String(musicState.lastAdvancedAt || serverNow) },
          seekPosition:     { doubleValue:  Math.round(seekPos * 10) / 10 },
          pausedPosition:   { doubleValue:  musicState.pausedPosition || 0 },
          repeat:           { stringValue:  musicState.repeat || 'queue' },
          shuffle:          { booleanValue: !!musicState.shuffle },
          upNext: {
            arrayValue: {
              values: upNext.map(item => ({
                mapValue: { fields: {
                  title:     { stringValue: item.title     || '' },
                  artist:    { stringValue: item.artist    || '' },
                  mediaType: { stringValue: item.mediaType || 'music' },
                  artworkUrl:{ stringValue: item.artworkUrl|| '' },
                  duration:  { integerValue: String(item.duration || 0) },
                }}
              }))
            }
          },
          updatedAt: { timestampValue: new Date().toISOString() },
        }
      }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.warn('[CloudStream Worker] pushNowPlaying HTTP', res.status, errBody.slice(0, 200));
    }
  } catch(e) {
    console.warn('[CloudStream Worker] pushNowPlaying error:', e.message);
  }
}

async function markLiveRoomOffline(env, hostUid) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !hostUid) return;
  try {
    const idToken = await _getAnonToken(env);
    if (!idToken) return;
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/liveRooms/${hostUid}` +
      `?updateMask.fieldPaths=isLive&updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: {
          isLive:    { booleanValue: false },
          status:    { stringValue: 'ended' },
          updatedAt: { timestampValue: new Date().toISOString() },
        }
      }),
    });
  } catch (e) {
    console.warn('[CloudStream Worker] markLiveRoomOffline error:', e.message);
  }
}

async function markCloudStreamInFirestore(env, streamId, fields) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !streamId) return;
  try {
    const idToken = await _getAnonToken(env);
    if (!idToken) return;

    const firestoreFields = {};
    if (fields.status)    firestoreFields.status    = { stringValue: fields.status };
    if (fields.stoppedAt) firestoreFields.stoppedAt = { stringValue: fields.stoppedAt };
    if (fields.stoppedBy) firestoreFields.stoppedBy = { stringValue: fields.stoppedBy };
    if (fields.startedAt) firestoreFields.startedAt = { stringValue: fields.startedAt };
    if (fields.expiresAt) firestoreFields.expiresAt = { stringValue: fields.expiresAt };
    firestoreFields.updatedAt = { timestampValue: new Date().toISOString() };

    const maskParams = Object.keys(firestoreFields)
      .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');

    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/cloudStreams/${streamId}?${maskParams}`;
    await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({ fields: firestoreFields }),
    });
  } catch (e) {
    console.warn('[CloudStream Worker] markCloudStreamInFirestore error:', e.message);
  }
}

async function writeCloudStreamHistory(env, streamData, reason) {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY || !streamData) return;
  try {
    const idToken = await _getAnonToken(env);
    if (!idToken) return;
    const histId = `${streamData.streamId || 'unknown'}_${Date.now()}`;
    const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/cloudStreamHistory/${histId}`;
    const now  = new Date().toISOString();
    const startedMs = streamData.startedAt || 0;
    const stoppedMs = streamData.stoppedAt || Date.now();
    const durSecs   = startedMs ? Math.max(0, Math.floor((stoppedMs - startedMs) / 1000)) : 0;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: {
          historyId:     { stringValue:  histId },
          streamId:      { stringValue:  streamData.streamId    || '' },
          uid:           { stringValue:  streamData.uid         || '' },
          displayName:   { stringValue:  streamData.displayName || '' },
          streamName:    { stringValue:  streamData.streamName  || '' },
          startedAt:     { stringValue:  startedMs ? new Date(startedMs).toISOString() : now },
          stoppedAt:     { stringValue:  new Date(stoppedMs).toISOString() },
          durationSecs:  { integerValue: String(durSecs) },
          peakListeners: { integerValue: String(streamData.viewerCount || 0) },
          finalStatus:   { stringValue:  streamData.status      || 'stopped' },
          stopReason:    { stringValue:  reason                 || 'unknown' },
          createdAt:     { timestampValue: now },
        }
      }),
    });
  } catch (e) {
    console.warn('[CloudStream Worker] writeCloudStreamHistory error:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════
   FIREBASE TOKEN VERIFICATION
═══════════════════════════════════════════════════════ */
async function verifyFirebaseIdToken(idToken, env) {
  if (!env.FIREBASE_PROJECT_ID) return null;
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_API_KEY || ''}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error('Token verification failed: ' + (err.error?.message || res.status));
  }
  const data  = await res.json();
  const users = data.users;
  if (!Array.isArray(users) || !users.length) throw new Error('Token verification failed: no user record');
  const record = users[0];
  if (!record.localId) throw new Error('Token verification failed: missing localId');
  return { uid: record.localId };
}

async function _verifyFounderRole(uid, env) {
  if (!uid || !env.FIREBASE_PROJECT_ID || !env.FIREBASE_API_KEY) return false;
  try {
    const idToken = await _getAnonToken(env);
    if (!idToken) return false;
    const docUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`;
    const docRes = await fetch(docUrl, { headers: { 'Authorization': `Bearer ${idToken}` } });
    if (!docRes.ok) return false;
    const doc  = await docRes.json();
    const role = doc.fields?.role?.stringValue || '';
    return role === 'founder';
  } catch { return false; }
}

function _extractBearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

/* ═══════════════════════════════════════════════════════
   LISTENER PRESENCE
═══════════════════════════════════════════════════════ */
const LISTENER_STALE_MS = 90 * 1000;

async function _recomputeViewerCount(streamId, env) {
  if (!env.cloudStreamKV) return 0;
  const list  = await env.cloudStreamKV.list({ prefix: `listener:${streamId}:` });
  const now   = Date.now();
  let count   = 0;
  for (const key of (list.keys || [])) {
    const rec = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (rec && rec.active && (now - (rec.lastSeen || 0)) < LISTENER_STALE_MS) count++;
  }
  await env.cloudStreamKV.put(`listenerCount:${streamId}`, String(count), { expirationTtl: 300 });
  const stream = await env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
  if (stream) {
    stream.viewerCount = count;
    await env.cloudStreamKV.put(`stream:${streamId}`, JSON.stringify(stream), { expirationTtl: (stream.durationMinutes + 60) * 60 });
  }
  return count;
}

async function handleListenerJoin(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, sessionId, uid, displayName } = body;
  if (!streamId || !sessionId) return jsonErr('streamId and sessionId required', 400, cors);
  if (!env.cloudStreamKV) return jsonOK({ success: true, viewerCount: 0 }, cors);

  const kvKey   = `listener:${streamId}:${sessionId}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  const now = Date.now();
  const record = {
    sessionId, uid: uid || null, displayName: displayName || '', streamId,
    joinedAt: existing ? (existing.joinedAt || now) : now,
    lastSeen: now, active: true,
  };
  await env.cloudStreamKV.put(kvKey, JSON.stringify(record), { expirationTtl: 7200 });
  if (ctx) ctx.waitUntil(_recomputeViewerCount(streamId, env));
  else await _recomputeViewerCount(streamId, env);
  const cached     = await env.cloudStreamKV.get(`listenerCount:${streamId}`);
  const viewerCount = cached ? parseInt(cached, 10) : 0;
  return jsonOK({ success: true, viewerCount }, cors);
}

async function handleListenerHeartbeat(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, sessionId } = body;
  if (!streamId || !sessionId) return jsonErr('streamId and sessionId required', 400, cors);
  if (!env.cloudStreamKV) return jsonOK({ success: true, viewerCount: 0 }, cors);

  const kvKey   = `listener:${streamId}:${sessionId}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  if (!existing) return jsonOK({ success: false, rejoin: true, viewerCount: 0 }, cors);

  existing.lastSeen = Date.now();
  existing.active   = true;
  await env.cloudStreamKV.put(kvKey, JSON.stringify(existing), { expirationTtl: 7200 });

  if (Math.random() < 0.2) {
    if (ctx) ctx.waitUntil(_recomputeViewerCount(streamId, env));
    else await _recomputeViewerCount(streamId, env);
  }
  const cached     = await env.cloudStreamKV.get(`listenerCount:${streamId}`);
  const viewerCount = cached ? parseInt(cached, 10) : 0;
  return jsonOK({ success: true, viewerCount }, cors);
}

async function handleListenerLeave(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonOK({ success: true }, cors); }
  const { streamId, sessionId } = body;
  if (!streamId || !sessionId) return jsonOK({ success: true }, cors);
  if (!env.cloudStreamKV) return jsonOK({ success: true, viewerCount: 0 }, cors);

  const kvKey   = `listener:${streamId}:${sessionId}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  if (existing) {
    existing.active = false;
    existing.leftAt = Date.now();
    await env.cloudStreamKV.put(kvKey, JSON.stringify(existing), { expirationTtl: 300 });
  }
  if (ctx) ctx.waitUntil(_recomputeViewerCount(streamId, env));
  else await _recomputeViewerCount(streamId, env);
  const cached     = await env.cloudStreamKV.get(`listenerCount:${streamId}`);
  const viewerCount = cached ? parseInt(cached, 10) : 0;
  return jsonOK({ success: true, viewerCount }, cors);
}

/* ═══════════════════════════════════════════════════════
   LIKES
═══════════════════════════════════════════════════════ */
async function _recomputeLikeCount(streamId, env) {
  if (!env.cloudStreamKV) return 0;
  const list  = await env.cloudStreamKV.list({ prefix: `like:${streamId}:` });
  let count   = 0;
  for (const key of (list.keys || [])) {
    const rec = await env.cloudStreamKV.get(key.name, { type: 'json' });
    if (rec && rec.liked) count++;
  }
  await env.cloudStreamKV.put(`likeCount:${streamId}`, String(count), { expirationTtl: 3600 });
  return count;
}

async function handleStreamLike(request, env, ctx, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { streamId, uid, action } = body;
  if (!streamId || !uid) return jsonErr('streamId and uid required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (!verified || verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (!idToken && env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }
  if (!env.cloudStreamKV) return jsonErr('KV not configured', 503, cors);

  const kvKey    = `like:${streamId}:${uid}`;
  const existing = await env.cloudStreamKV.get(kvKey, { type: 'json' });
  const liked    = action !== 'unlike';

  if (existing && existing.liked === liked) {
    const cached    = await env.cloudStreamKV.get(`likeCount:${streamId}`);
    const likeCount = cached ? parseInt(cached, 10) : await _recomputeLikeCount(streamId, env);
    return jsonOK({ success: true, liked, likeCount, unchanged: true }, cors);
  }

  const record = { uid, streamId, liked, likedAt: liked ? Date.now() : null, unlikedAt: !liked ? Date.now() : (existing ? existing.unlikedAt : null) };
  const ttl    = liked ? 86400 * 30 : 3600;
  await env.cloudStreamKV.put(kvKey, JSON.stringify(record), { expirationTtl: ttl });

  let likeCount = 0;
  if (ctx) ctx.waitUntil(_recomputeLikeCount(streamId, env));
  else likeCount = await _recomputeLikeCount(streamId, env);
  const cached    = await env.cloudStreamKV.get(`likeCount:${streamId}`);
  likeCount = cached ? parseInt(cached, 10) : likeCount;
  return jsonOK({ success: true, liked, likeCount }, cors);
}

async function handleStreamLikesGet(request, env, url, cors) {
  const parts    = url.pathname.replace('/api/stream/likes/', '').split('/');
  const streamId = parts[0];
  const uid      = parts[1] || null;
  if (!streamId) return jsonErr('streamId required', 400, cors);
  if (!env.cloudStreamKV) return jsonOK({ likeCount: 0, liked: false }, cors);

  const cached    = await env.cloudStreamKV.get(`likeCount:${streamId}`);
  const likeCount = cached ? parseInt(cached, 10) : await _recomputeLikeCount(streamId, env);
  let liked = false;
  if (uid) {
    const rec = await env.cloudStreamKV.get(`like:${streamId}:${uid}`, { type: 'json' });
    liked = !!(rec && rec.liked);
  }
  return jsonOK({ likeCount, liked }, cors);
}

/* ═══════════════════════════════════════════════════════
   DESTINATIONS
═══════════════════════════════════════════════════════ */
async function handleDestinationsSave(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { uid, type, rtmpUrl, streamKey } = body;
  if (!uid || !type || !rtmpUrl || !streamKey) return jsonErr('uid, type, rtmpUrl and streamKey required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  const ALLOWED_TYPES = ['youtube', 'facebook', 'custom'];
  if (!ALLOWED_TYPES.includes(type)) return jsonErr('Unknown destination type: ' + type, 400, cors);
  if (!/^rtmps?:\/\//i.test(rtmpUrl)) return jsonErr('rtmpUrl must start with rtmp:// or rtmps://', 400, cors);
  if (!env.cloudStreamKV) return jsonErr('KV not configured', 500, cors);

  const kvKey  = `dest:${uid}:${type}`;
  const record = { uid, type, rtmpUrl, streamKeyHash: await hashKey(streamKey), status: 'active', updatedAt: Date.now() };
  await env.cloudStreamKV.put(`destkey:${uid}:${type}`, streamKey, { expirationTtl: 86400 * 365 });
  await env.cloudStreamKV.put(kvKey, JSON.stringify(record), { expirationTtl: 86400 * 365 });
  return jsonOK({ success: true, message: type + ' destination saved.' }, cors);
}

async function handleDestinationsRemove(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return jsonErr('Invalid JSON', 400, cors); }
  const { uid, type } = body;
  if (!uid || !type) return jsonErr('uid and type required', 400, cors);

  const idToken = _extractBearerToken(request);
  if (idToken) {
    try {
      const verified = await verifyFirebaseIdToken(idToken, env);
      if (verified && verified.uid !== uid) return jsonErr('Unauthorized: token UID mismatch', 403, cors);
    } catch (e) { return jsonErr('Unauthorized: ' + e.message, 401, cors); }
  } else if (env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY) {
    return jsonErr('Unauthorized: Authorization header required', 401, cors);
  }

  if (env.cloudStreamKV) {
    await env.cloudStreamKV.delete(`dest:${uid}:${type}`);
    await env.cloudStreamKV.delete(`destkey:${uid}:${type}`);
  }
  return jsonOK({ success: true, message: type + ' destination removed.' }, cors);
}

async function handleDestinationsList(request, env, url, cors) {
  const uid = url.searchParams.get('uid');
  if (!uid) return jsonErr('uid required', 400, cors);
  if (!env.cloudStreamKV) return jsonOK({ destinations: [] }, cors);

  const destinations = [];
  for (const type of ['youtube', 'facebook', 'custom']) {
    const val = await env.cloudStreamKV.get(`dest:${uid}:${type}`, { type: 'json' });
    if (val) destinations.push({ type: val.type, rtmpUrl: '[configured]', streamKey: '[saved]', status: val.status || 'active', updatedAt: val.updatedAt });
  }
  return jsonOK({ destinations }, cors);
}

/* ═══════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════ */
async function getStream(streamId, env) {
  if (!env.cloudStreamKV) return null;
  return await env.cloudStreamKV.get(`stream:${streamId}`, { type: 'json' });
}

async function logStreamEvent(env, streamId, event, data) {
  if (!env.cloudStreamKV) return;
  const key = `event:${streamId}:${Date.now()}:${event}`;
  await env.cloudStreamKV.put(key, JSON.stringify({ streamId, event, data, timestamp: Date.now() }), { expirationTtl: 86400 * 7 });
}

function jsonOK(data, cors) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...(cors || CORS_HEADERS), 'Content-Type': 'application/json' },
  });
}
function jsonErr(message, status, cors) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status: status || 400,
    headers: { ...(cors || CORS_HEADERS), 'Content-Type': 'application/json' },
  });
}

async function hashKey(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* ── Repeat mode normalizer ── */
function _normalizeRepeat(v) {
  if (v === 'off' || v === 'queue' || v === 'one') return v;
  if (v === false || v === 0) return 'off';
  if (v === true || v === 1) return 'queue';
  return 'queue'; // safe default
}

/* ── Shuffle order generator ── */
function _generateShuffleOrder(len) {
  const arr = Array.from({ length: len }, (_, i) => i);
  for (let i = len - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* ── Compute next queue index (uses stored shuffle order) ── */
function _computeNextIndex(musicState, fromAlarm) {
  return _computeNextIndexFromState(
    musicState.queueIndex || 0,
    musicState.shuffle,
    musicState.shuffleOrder,
    musicState.repeat,
    musicState.queue ? musicState.queue.length : 0
  );
}

function _computeNextIndexFromState(currentIdx, shuffle, shuffleOrder, repeat, qLen) {
  if (qLen === 0) return null;
  if (repeat === 'one') return currentIdx; // repeat same track

  if (shuffle && Array.isArray(shuffleOrder) && shuffleOrder.length === qLen) {
    // Find current position in shuffle order and return next
    const pos = shuffleOrder.indexOf(currentIdx);
    const nextPos = pos + 1;
    if (nextPos >= qLen) {
      if (repeat === 'off') return null;
      return shuffleOrder[0]; // repeat queue: wrap around
    }
    return shuffleOrder[nextPos];
  }

  // Sequential
  const next = currentIdx + 1;
  if (next >= qLen) {
    if (repeat === 'off') return null;
    return 0; // repeat queue
  }
  return next;
}

/* ── Build upNext list accounting for shuffle order ── */
function _buildUpNext(queue, currentIdx, shuffleOrder, count) {
  if (!queue || !queue.length) return [];
  const len    = queue.length;
  const result = [];
  let   pos    = currentIdx;

  for (let i = 0; i < Math.min(count, len - 1); i++) {
    if (shuffleOrder && Array.isArray(shuffleOrder) && shuffleOrder.length === len) {
      const shufflePos = shuffleOrder.indexOf(pos);
      const nextShuffle = shufflePos + 1;
      if (nextShuffle >= len) break;
      pos = shuffleOrder[nextShuffle];
    } else {
      pos = (pos + 1) % len;
      if (pos === 0 && i > 0) break; // avoid infinite loop
    }
    const item = queue[pos];
    if (item) result.push({ title: item.title || '', artist: item.artist || '', mediaType: item.mediaType || 'music', artworkUrl: item.artworkUrl || '', duration: item.duration || 0 });
  }
  return result;
}

/* ── Reschedule the DO alarm after a manual track change ── */
async function _rescheduleAlarm(env, streamId, musicState, durationMinutes) {
  if (!env.CloudStreamDO) return;
  try {
    const doId  = env.CloudStreamDO.idFromName(streamId + '_music');
    const doObj = env.CloudStreamDO.get(doId);

    if (musicState.status === 'paused') {
      // Cancel alarm while paused
      await doObj.fetch('https://do/music-pause', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      return;
    }

    if (musicState.status === 'playing') {
      const cur          = musicState.queue && musicState.queue[musicState.queueIndex || 0];
      const dur          = cur && cur.duration ? cur.duration : 240;
      const elapsed      = musicState.lastAdvancedAt ? Math.max(0, (Date.now() - musicState.lastAdvancedAt) / 1000) : 0;
      const remainingSecs = Math.max(1, dur - elapsed);
      await doObj.fetch('https://do/music-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remainingMs: remainingSecs * 1000 }),
      });
    }
  } catch (e) {
    console.warn('[CloudStream Worker] _rescheduleAlarm error:', e.message);
  }
}
