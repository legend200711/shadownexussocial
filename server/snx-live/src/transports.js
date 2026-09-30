/**
 * Shadow Nexus Live — WebRTC transport creation helpers.
 *
 * Creates send and receive transports on the mediasoup Router, stores
 * them on the Participant, and handles browser-side DTLS "connect" events.
 */

'use strict';

const config = require('./config');

/**
 * Create a sendTransport for a publisher (host or guest).
 * Stores the transport on participant.sendTransport.
 *
 * @param {Room}        room
 * @param {Participant} participant
 * @returns {Promise<object>}  transport params to send to the browser
 */
async function createSendTransport(room, participant) {
  if (!participant.canPublish()) {
    throw new Error('Participant role "' + participant.role + '" cannot publish');
  }

  const transport = await room.router.createWebRtcTransport(
    config.mediasoup.webRtcTransport
  );

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'closed') {
      console.log('[SNX-TRANSPORT] sendTransport dtls closed —',
        participant.uid, transport.id);
    }
  });

  transport.on('@close', () => {
    console.log('[SNX-TRANSPORT] sendTransport closed —',
      participant.uid, transport.id);
  });

  participant.sendTransport = transport;

  return {
    id:             transport.id,
    iceParameters:  transport.iceParameters,
    iceCandidates:  transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

/**
 * Create a recvTransport for any participant (host, guest, or viewer).
 * Stores the transport on participant.recvTransport.
 *
 * @param {Room}        room
 * @param {Participant} participant
 * @returns {Promise<object>}  transport params to send to the browser
 */
async function createRecvTransport(room, participant) {
  const transport = await room.router.createWebRtcTransport(
    config.mediasoup.webRtcTransport
  );

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'closed') {
      console.log('[SNX-TRANSPORT] recvTransport dtls closed —',
        participant.uid, transport.id);
    }
  });

  transport.on('@close', () => {
    console.log('[SNX-TRANSPORT] recvTransport closed —',
      participant.uid, transport.id);
  });

  participant.recvTransport = transport;

  return {
    id:             transport.id,
    iceParameters:  transport.iceParameters,
    iceCandidates:  transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

/**
 * Connect a transport after the browser completes its local DTLS handshake.
 * Called for both send and receive transports.
 *
 * @param {Participant}  participant
 * @param {string}       transportId
 * @param {object}       dtlsParameters  — from browser device.connect()
 */
async function connectTransport(participant, transportId, dtlsParameters) {
  const transport =
    (participant.sendTransport && participant.sendTransport.id === transportId)
      ? participant.sendTransport
      : (participant.recvTransport && participant.recvTransport.id === transportId)
        ? participant.recvTransport
        : null;

  if (!transport) {
    throw new Error('Transport not found: ' + transportId);
  }

  await transport.connect({ dtlsParameters });
  console.log('[SNX-TRANSPORT] connected —', participant.uid, transportId);
}

module.exports = { createSendTransport, createRecvTransport, connectTransport };
