/**
 * Shadow Nexus Live — Main media server entry point.
 *
 * Architecture:
 *   Browser ↔ WebSocket (WSS) ↔ this server ↔ mediasoup Routers
 *
 * Signaling uses a simple JSON request/response protocol over WebSocket.
 * Every message has:  { type, requestId?, ...payload }
 * Every response has: { type, requestId, ok, data? | error? }
 *
 * Message flow (abbreviated):
 *
 *   JOIN           → authenticate token, create participant, return rtpCapabilities
 *   CREATE_SEND_TRANSPORT → create mediasoup send transport, return params
 *   CREATE_RECV_TRANSPORT → create mediasoup recv transport, return params
 *   CONNECT_TRANSPORT     → connect transport DTLS
 *   PRODUCE               → create producer, notify other peers
 *   CONSUME               → create consumer for a remote producer
 *   RESUME_CONSUMER       → resume after browser sets srcObject
 *   GET_PRODUCERS         → list existing producers the client can subscribe to
 *   LEAVE                 → clean up participant (graceful)
 *   HOST_REMOVE_GUEST     → host forces a guest to leave
 *   HOST_END_LIVE         → host ends the room
 *
 * Port requirements (must be open in firewall):
 *   TCP  SNX_PORT (default 3000) — WebSocket signaling
 *   UDP  MEDIASOUP_MIN_PORT–MEDIASOUP_MAX_PORT (default 10000–59999) — RTP/RTCP
 *
 * coturn ports (on the TURN server — same or companion VPS):
 *   UDP/TCP  3478  — STUN / TURN plain
 *   UDP/TCP  5349  — TURN TLS
 */

'use strict';

const http    = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { initWorkers }     = require('./mediasoup');
const { getOrCreateRoom, getRoom, closeRoom } = require('./rooms');
const { verifyToken }     = require('./auth');
const { createSendTransport, createRecvTransport, connectTransport } = require('./transports');
const { createProducer }  = require('./producers');
const { createConsumer, resumeConsumer } = require('./consumers');
const { cleanupParticipant, cleanupRoom } = require('./cleanup');
const config              = require('./config');

// ── HTTP server + health check ────────────────────────────────────────────────
const app = express();
app.get('/health', (_, res) => res.json({ ok: true, service: 'snx-live-media-server' }));

const server = http.createServer(app);

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });

// uid → ws (for server-push notifications)
const _sockets = new Map();

wss.on('connection', (ws, req) => {
  // Each connection gets its own session context
  const ctx = {
    ws,
    uid:    null,
    roomId: null,
    role:   null,
  };

  console.log('[SNX-WS] New connection from', req.socket.remoteAddress);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      _send(ws, { type: 'ERROR', error: 'Invalid JSON' });
      return;
    }

    const { type, requestId } = msg;

    try {
      await _handleMessage(ctx, type, msg, requestId);
    } catch (err) {
      console.error('[SNX-WS] Error handling', type, '—', err.message);
      _reply(ws, requestId, false, null, err.message);
    }
  });

  ws.on('close', () => {
    if (ctx.uid) {
      console.log('[SNX-WS] Disconnected —', ctx.uid);
      _sockets.delete(ctx.uid);
      _handleDisconnect(ctx);
    }
  });

  ws.on('error', (err) => {
    console.error('[SNX-WS] Socket error —', ctx.uid || '(unauthenticated)', err.message);
  });
});

// ── Message dispatcher ────────────────────────────────────────────────────────

async function _handleMessage(ctx, type, msg, requestId) {
  switch (type) {

    // ── JOIN — authenticate, register participant ──────────────────────────
    case 'JOIN': {
      const { token } = msg;
      const claims = verifyToken(token);   // throws on invalid/expired
      const { uid, roomId, role } = claims;

      ctx.uid    = uid;
      ctx.roomId = roomId;
      ctx.role   = role;

      _sockets.set(uid, ctx.ws);

      const room        = await getOrCreateRoom(roomId);
      const participant = room.addParticipant(uid, role);

      console.log('[SNX-WS] JOIN —', uid, role, 'room:', roomId);

      // Notify existing participants that a new peer joined
      _broadcastToRoom(roomId, uid, {
        type: 'PEER_JOINED',
        uid,
        role,
      });

      _reply(ctx.ws, requestId, true, {
        rtpCapabilities: room.getRtpCapabilities(),
        uid,
        role,
      });
      break;
    }

    // ── GET_PRODUCERS — return list of existing producers for this room ────
    case 'GET_PRODUCERS': {
      _requireJoined(ctx);
      const room = _requireRoom(ctx.roomId);
      const producers = room.getActiveProducers(ctx.uid);
      _reply(ctx.ws, requestId, true, { producers });
      break;
    }

    // ── CREATE_SEND_TRANSPORT ───────────────────────────────────────────────
    case 'CREATE_SEND_TRANSPORT': {
      _requireJoined(ctx);
      const room        = _requireRoom(ctx.roomId);
      const participant = _requireParticipant(room, ctx.uid);
      const params      = await createSendTransport(room, participant);
      _reply(ctx.ws, requestId, true, { transport: params });
      break;
    }

    // ── CREATE_RECV_TRANSPORT ───────────────────────────────────────────────
    case 'CREATE_RECV_TRANSPORT': {
      _requireJoined(ctx);
      const room        = _requireRoom(ctx.roomId);
      const participant = _requireParticipant(room, ctx.uid);
      const params      = await createRecvTransport(room, participant);
      _reply(ctx.ws, requestId, true, { transport: params });
      break;
    }

    // ── CONNECT_TRANSPORT — browser completed DTLS ─────────────────────────
    case 'CONNECT_TRANSPORT': {
      _requireJoined(ctx);
      const room        = _requireRoom(ctx.roomId);
      const participant = _requireParticipant(room, ctx.uid);
      const { transportId, dtlsParameters } = msg;
      await connectTransport(participant, transportId, dtlsParameters);
      _reply(ctx.ws, requestId, true, {});
      break;
    }

    // ── PRODUCE — publisher starts sending a track ─────────────────────────
    case 'PRODUCE': {
      _requireJoined(ctx);
      const room        = _requireRoom(ctx.roomId);
      const participant = _requireParticipant(room, ctx.uid);
      const { kind, rtpParameters, appData } = msg;

      const { producerId } = await createProducer(participant, kind, rtpParameters, appData);

      // Notify all OTHER participants in the room so they can subscribe
      _broadcastToRoom(ctx.roomId, ctx.uid, {
        type: 'NEW_PRODUCER',
        uid:        ctx.uid,
        producerId,
        kind,
      });

      _reply(ctx.ws, requestId, true, { producerId });
      break;
    }

    // ── CONSUME — subscribe to a remote producer ───────────────────────────
    case 'CONSUME': {
      _requireJoined(ctx);
      const room        = _requireRoom(ctx.roomId);
      const participant = _requireParticipant(room, ctx.uid);
      const { producerId, rtpCapabilities } = msg;

      // Wire up producer-closed callback so we can notify browser
      const consumer = await _consumeAndHookClose(
        room, participant, producerId, rtpCapabilities, ctx.ws
      );

      _reply(ctx.ws, requestId, true, consumer);
      break;
    }

    // ── RESUME_CONSUMER — browser has the track in a MediaStream ──────────
    case 'RESUME_CONSUMER': {
      _requireJoined(ctx);
      const room        = _requireRoom(ctx.roomId);
      const participant = _requireParticipant(room, ctx.uid);
      const { consumerId } = msg;
      await resumeConsumer(participant, consumerId);
      _reply(ctx.ws, requestId, true, {});
      break;
    }

    // ── LEAVE — graceful self-exit ─────────────────────────────────────────
    case 'LEAVE': {
      if (!ctx.uid) { _reply(ctx.ws, requestId, true, {}); break; }
      _reply(ctx.ws, requestId, true, {});
      _broadcastToRoom(ctx.roomId, ctx.uid, {
        type: 'PEER_LEFT',
        uid:  ctx.uid,
      });
      cleanupParticipant(ctx.roomId, ctx.uid);
      _sockets.delete(ctx.uid);
      ctx.uid    = null;
      ctx.roomId = null;
      break;
    }

    // ── HOST_REMOVE_GUEST — host forces a guest off the stage ─────────────
    case 'HOST_REMOVE_GUEST': {
      _requireJoined(ctx);
      if (ctx.role !== 'host') throw new Error('Only host can remove guests');
      const { guestUid } = msg;
      const room = _requireRoom(ctx.roomId);

      // Notify the guest to leave
      const guestWs = _sockets.get(guestUid);
      if (guestWs) {
        _send(guestWs, { type: 'REMOVED_FROM_STAGE' });
      }

      // Notify everyone else
      _broadcastToRoom(ctx.roomId, guestUid, {
        type: 'PEER_LEFT',
        uid:  guestUid,
      });

      cleanupParticipant(ctx.roomId, guestUid);
      _reply(ctx.ws, requestId, true, {});
      break;
    }

    // ── HOST_END_LIVE — host ends the entire room ─────────────────────────
    case 'HOST_END_LIVE': {
      _requireJoined(ctx);
      if (ctx.role !== 'host') throw new Error('Only host can end Live');

      // Notify everyone
      _broadcastToRoom(ctx.roomId, ctx.uid, { type: 'LIVE_ENDED' });

      cleanupRoom(ctx.roomId);
      _reply(ctx.ws, requestId, true, {});
      break;
    }

    default:
      _reply(ctx.ws, requestId, false, null, 'Unknown message type: ' + type);
  }
}

// ── Consume helper — hooks producer-closed callback so browser is notified ───
async function _consumeAndHookClose(room, subscriber, producerId, rtpCapabilities, ws) {
  const params = await createConsumer(room, subscriber, producerId, rtpCapabilities);

  // Find the consumer we just created to hook the producerclose event
  const consumer = subscriber.consumers.get(params.consumerId);
  if (consumer) {
    consumer._onProducerClosed = (consumerId, producerUid) => {
      _send(ws, {
        type:       'CONSUMER_CLOSED',
        consumerId,
        producerUid,
      });
    };
  }

  return params;
}

// ── Disconnect handler ────────────────────────────────────────────────────────
function _handleDisconnect(ctx) {
  const { uid, roomId, role } = ctx;
  if (!uid || !roomId) return;

  _broadcastToRoom(roomId, uid, {
    type: 'PEER_LEFT',
    uid,
  });

  cleanupParticipant(roomId, uid);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _requireJoined(ctx) {
  if (!ctx.uid) throw new Error('Not joined — send JOIN first');
}

function _requireRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) throw new Error('Room not found: ' + roomId);
  return room;
}

function _requireParticipant(room, uid) {
  const p = room.participants.get(uid);
  if (!p) throw new Error('Participant not in room: ' + uid);
  return p;
}

function _send(ws, data) {
  if (ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(data)); } catch (_) {}
  }
}

function _reply(ws, requestId, ok, data, error) {
  _send(ws, { type: 'REPLY', requestId, ok, data: data || null, error: error || null });
}

/**
 * Broadcast a message to all participants in a room EXCEPT the sender.
 * @param {string} roomId
 * @param {string} exceptUid  — skip this uid (usually the sender)
 * @param {object} msg
 */
function _broadcastToRoom(roomId, exceptUid, msg) {
  const room = getRoom(roomId);
  if (!room) return;
  for (const uid of room.participants.keys()) {
    if (uid === exceptUid) continue;
    const ws = _sockets.get(uid);
    if (ws) _send(ws, msg);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  await initWorkers();

  const { listenIp, listenPort } = config.http;
  server.listen(listenPort, listenIp, () => {
    console.log('[SNX-LIVE] Media server running on', listenIp + ':' + listenPort);
    console.log('[SNX-LIVE] WebSocket endpoint: ws(s)://<host>:' + listenPort + '/ws');
  });
}

start().catch((err) => {
  console.error('[SNX-LIVE] Startup failed:', err.message);
  process.exit(1);
});
