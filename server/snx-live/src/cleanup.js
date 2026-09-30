/**
 * Shadow Nexus Live — Resource cleanup helpers.
 *
 * Centralised cleanup so any code path (disconnect, host-remove, host-end-live,
 * room expiry) calls the same teardown logic without duplicating it.
 */

'use strict';

const { closeRoom, removeParticipantFromRoom } = require('./rooms');

/**
 * Clean up a single participant: close transports, producers, consumers.
 * Removes them from their room.  If the room becomes empty, closes the room.
 *
 * @param {string} roomId
 * @param {string} uid
 */
function cleanupParticipant(roomId, uid) {
  console.log('[SNX-CLEANUP] participant —', uid, 'room:', roomId);
  removeParticipantFromRoom(roomId, uid);
}

/**
 * Clean up an entire room (host ended live, or all participants left).
 *
 * @param {string} roomId
 */
function cleanupRoom(roomId) {
  console.log('[SNX-CLEANUP] room —', roomId);
  closeRoom(roomId);
}

module.exports = { cleanupParticipant, cleanupRoom };
