/**
 * Shadow Nexus Live — Producer management (browser publish → mediasoup).
 *
 * A Producer represents one outgoing media track (audio or video) from
 * a publisher (host or guest).  Stored on the participant.producers Map.
 */

'use strict';

/**
 * Create a Producer on the participant's sendTransport.
 * Called when the browser fires device.sendTransport.produce().
 *
 * @param {Participant} participant
 * @param {string}      kind            — 'audio' | 'video'
 * @param {object}      rtpParameters   — from browser
 * @param {string}      [appData]
 * @returns {Promise<{ producerId: string }>}
 */
async function createProducer(participant, kind, rtpParameters, appData) {
  if (!participant.canPublish()) {
    throw new Error('Viewer participants cannot produce');
  }

  const sendTransport = participant.sendTransport;
  if (!sendTransport) {
    throw new Error('No sendTransport on participant ' + participant.uid);
  }

  const producer = await sendTransport.produce({
    kind,
    rtpParameters,
    appData: appData || {},
  });

  producer.on('transportclose', () => {
    console.log('[SNX-PRODUCER] transport closed —', participant.uid, producer.id);
    participant.producers.delete(producer.id);
  });

  producer.on('score', (score) => {
    // RTP score diagnostics — log at debug level only
  });

  participant.producers.set(producer.id, producer);

  console.log('[SNX-PRODUCER] created —', participant.uid, kind, producer.id);

  return { producerId: producer.id };
}

/**
 * Pause or resume a producer (mic/cam mute — track disabled on browser side
 * sets enabled=false, but mediasoup still needs to know about it to avoid
 * unnecessary forwarding).
 *
 * @param {Participant} participant
 * @param {string}      producerId
 * @param {boolean}     paused
 */
async function setProducerPaused(participant, producerId, paused) {
  const producer = participant.producers.get(producerId);
  if (!producer) throw new Error('Producer not found: ' + producerId);
  if (paused) {
    await producer.pause();
  } else {
    await producer.resume();
  }
}

/**
 * Close and remove a producer by id.
 */
function closeProducer(participant, producerId) {
  const producer = participant.producers.get(producerId);
  if (!producer) return;
  try { producer.close(); } catch (_) {}
  participant.producers.delete(producerId);
  console.log('[SNX-PRODUCER] closed —', participant.uid, producerId);
}

module.exports = { createProducer, setProducerPaused, closeProducer };
