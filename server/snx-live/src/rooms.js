/**
 * Shadow Nexus Live — Room management.
 *
 * A Room wraps a mediasoup Router and tracks all participants.
 * One Room per active Shadow Nexus Live session (roomId = Firebase roomId).
 *
 * Participant roles:
 *   host    — publishes camera/mic; controls the room
 *   guest   — publishes camera/mic; max 4 simultaneous
 *   viewer  — consumes only; unlimited
 *
 * Publishers (host + guests) create a sendTransport + producers.
 * All participants (including viewers) create a recvTransport + consumers.
 */

'use strict';

const { createRouter } = require('./mediasoup');

const MAX_GUESTS = 4;

// Active rooms — roomId → Room instance
const _rooms = new Map();

class Room {
  constructor(roomId, router) {
    this.roomId       = roomId;
    this.router       = router;
    this.createdAt    = Date.now();
    // uid → Participant
    this.participants = new Map();
  }

  /**
   * Add a participant to this room.
   * @param {string} uid
   * @param {string} role   — 'host' | 'guest' | 'viewer'
   * @returns {Participant}
   * @throws  if guest cap exceeded or uid already in room
   */
  addParticipant(uid, role) {
    if (this.participants.has(uid)) {
      return this.participants.get(uid);
    }

    if (role === 'guest') {
      const guestCount = [...this.participants.values()]
        .filter(p => p.role === 'guest').length;
      if (guestCount >= MAX_GUESTS) {
        throw new Error('Guest cap reached (max ' + MAX_GUESTS + ')');
      }
    }

    const p = new Participant(uid, role, this.roomId);
    this.participants.set(uid, p);
    console.log('[SNX-ROOM]', this.roomId, '— participant added:', uid, role,
      '| total:', this.participants.size);
    return p;
  }

  /**
   * Remove a participant and close their transports/producers/consumers.
   * @param {string} uid
   */
  removeParticipant(uid) {
    const p = this.participants.get(uid);
    if (!p) return;
    p.close();
    this.participants.delete(uid);
    console.log('[SNX-ROOM]', this.roomId, '— participant removed:', uid,
      '| remaining:', this.participants.size);
  }

  /**
   * Get RTP capabilities of this room's Router (sent to clients for device loading).
   */
  getRtpCapabilities() {
    return this.router.rtpCapabilities;
  }

  /**
   * Create a new WebRTC send transport for a publisher (host or guest).
   * @param {object} options — mediasoup WebRtcTransport options
   * @returns {Promise<WebRtcTransport>}
   */
  async createSendTransport(options) {
    return this.router.createWebRtcTransport(options);
  }

  /**
   * Create a new WebRTC receive transport for any participant (including viewers).
   * @param {object} options — mediasoup WebRtcTransport options
   * @returns {Promise<WebRtcTransport>}
   */
  async createRecvTransport(options) {
    return this.router.createWebRtcTransport(options);
  }

  /**
   * Collect all active producers from all publishers except the given uid.
   * Used when a new participant joins and needs to subscribe to existing streams.
   * @param {string} exceptUid — skip producers from this participant (self)
   * @returns {{ uid, producerId, kind }[]}
   */
  getActiveProducers(exceptUid) {
    const result = [];
    for (const [uid, p] of this.participants) {
      if (uid === exceptUid) continue;
      for (const [producerId, producer] of p.producers) {
        if (!producer.closed) {
          result.push({ uid, producerId, kind: producer.kind });
        }
      }
    }
    return result;
  }

  /**
   * Close the room — close router and all participants.
   */
  close() {
    for (const p of this.participants.values()) {
      p.close();
    }
    this.participants.clear();
    try { this.router.close(); } catch (_) {}
    console.log('[SNX-ROOM]', this.roomId, '— room closed');
  }
}

class Participant {
  constructor(uid, role, roomId) {
    this.uid       = uid;
    this.role      = role;
    this.roomId    = roomId;
    // mediasoup transport objects
    this.sendTransport = null;   // WebRtcTransport (publishers only)
    this.recvTransport = null;   // WebRtcTransport (all)
    // Map<producerId, Producer>
    this.producers = new Map();
    // Map<consumerId, Consumer>
    this.consumers = new Map();
  }

  canPublish() {
    return this.role === 'host' || this.role === 'guest';
  }

  close() {
    for (const c of this.consumers.values()) {
      try { c.close(); } catch (_) {}
    }
    this.consumers.clear();
    for (const p of this.producers.values()) {
      try { p.close(); } catch (_) {}
    }
    this.producers.clear();
    if (this.recvTransport) {
      try { this.recvTransport.close(); } catch (_) {}
      this.recvTransport = null;
    }
    if (this.sendTransport) {
      try { this.sendTransport.close(); } catch (_) {}
      this.sendTransport = null;
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get or create a Room for the given roomId.
 * @returns {Promise<Room>}
 */
async function getOrCreateRoom(roomId) {
  if (_rooms.has(roomId)) return _rooms.get(roomId);
  const router = await createRouter();
  const room   = new Room(roomId, router);
  _rooms.set(roomId, room);
  console.log('[SNX-ROOMS] Created room:', roomId);
  return room;
}

/**
 * Get an existing room, or null if not found.
 * @returns {Room|null}
 */
function getRoom(roomId) {
  return _rooms.get(roomId) || null;
}

/**
 * Close and delete a room.
 */
function closeRoom(roomId) {
  const room = _rooms.get(roomId);
  if (!room) return;
  room.close();
  _rooms.delete(roomId);
  console.log('[SNX-ROOMS] Room closed and deleted:', roomId);
}

/**
 * Remove a specific participant from their room.
 * Used by host-remove-guest and disconnect cleanup.
 */
function removeParticipantFromRoom(roomId, uid) {
  const room = getRoom(roomId);
  if (!room) return;
  room.removeParticipant(uid);
  // If the room has no publishers left and no viewers, close it
  if (room.participants.size === 0) {
    closeRoom(roomId);
  }
}

module.exports = { getOrCreateRoom, getRoom, closeRoom, removeParticipantFromRoom, Room };
