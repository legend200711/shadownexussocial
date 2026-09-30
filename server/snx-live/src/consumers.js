/**
 * Shadow Nexus Live — Consumer management (mediasoup → browser subscribe).
 *
 * A Consumer represents one incoming media track delivered to a subscriber
 * (host receiving a guest, guest receiving host/other guests, viewer).
 * Stored on the participant.consumers Map.
 */

'use strict';

/**
 * Create a Consumer on the participant's recvTransport for the given producerId.
 * The participant's device must have already loaded the router's RTP capabilities.
 *
 * @param {Room}        room
 * @param {Participant} subscriber       — the participant who will receive
 * @param {string}      producerId       — the producer to subscribe to
 * @param {object}      rtpCapabilities  — from browser device.rtpCapabilities
 * @returns {Promise<object>}  consumer params to send to the browser
 */
async function createConsumer(room, subscriber, producerId, rtpCapabilities) {
  const recvTransport = subscriber.recvTransport;
  if (!recvTransport) {
    throw new Error('No recvTransport on subscriber ' + subscriber.uid);
  }

  // Check that the router can consume this producer with subscriber's capabilities
  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    throw new Error('Router cannot consume producerId ' + producerId +
      ' for subscriber ' + subscriber.uid + ' (incompatible RTP caps)');
  }

  const consumer = await recvTransport.consume({
    producerId,
    rtpCapabilities,
    paused: false,   // start unpaused — browser resumes after setting srcObject
  });

  consumer.on('transportclose', () => {
    console.log('[SNX-CONSUMER] transport closed —', subscriber.uid, consumer.id);
    subscriber.consumers.delete(consumer.id);
  });

  consumer.on('producerclose', () => {
    console.log('[SNX-CONSUMER] producer closed — notifying subscriber',
      subscriber.uid, consumer.id);
    subscriber.consumers.delete(consumer.id);
    // The WebSocket handler emits 'consumerClosed' to the browser
    if (typeof consumer._onProducerClosed === 'function') {
      consumer._onProducerClosed(consumer.id, consumer.appData && consumer.appData.producerUid);
    }
  });

  subscriber.consumers.set(consumer.id, consumer);

  console.log('[SNX-CONSUMER] created —', subscriber.uid, '←', producerId,
    consumer.kind, consumer.id);

  return {
    consumerId:    consumer.id,
    producerId:    consumer.producerId,
    kind:          consumer.kind,
    rtpParameters: consumer.rtpParameters,
  };
}

/**
 * Resume a paused consumer (called after browser has set up the MediaStream).
 */
async function resumeConsumer(participant, consumerId) {
  const consumer = participant.consumers.get(consumerId);
  if (!consumer) throw new Error('Consumer not found: ' + consumerId);
  await consumer.resume();
}

/**
 * Close and remove a consumer.
 */
function closeConsumer(participant, consumerId) {
  const consumer = participant.consumers.get(consumerId);
  if (!consumer) return;
  try { consumer.close(); } catch (_) {}
  participant.consumers.delete(consumerId);
}

module.exports = { createConsumer, resumeConsumer, closeConsumer };
