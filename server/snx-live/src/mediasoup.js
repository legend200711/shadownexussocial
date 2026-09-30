/**
 * Shadow Nexus Live — mediasoup worker + router management.
 *
 * Creates a pool of mediasoup Workers (one per CPU) and round-robins
 * new Router creation across them.  Routers are per-room; Workers are
 * shared across rooms.
 */

'use strict';

const mediasoup = require('mediasoup');
const config    = require('./config');

let _workers = [];
let _nextWorkerIdx = 0;

/**
 * Initialise mediasoup Worker pool.  Must be called once at server startup.
 */
async function initWorkers() {
  const { numWorkers, worker: workerConfig } = config.mediasoup;

  console.log('[SNX-MS] Starting', numWorkers, 'mediasoup worker(s)…');

  for (let i = 0; i < numWorkers; i++) {
    const w = await mediasoup.createWorker({
      rtcMinPort: workerConfig.rtcMinPort,
      rtcMaxPort: workerConfig.rtcMaxPort,
      logLevel:   workerConfig.logLevel,
      logTags:    workerConfig.logTags,
    });

    w.on('died', (err) => {
      console.error('[SNX-MS] mediasoup worker died — pid:', w.pid, err.message);
      // Remove from pool so subsequent createRouter calls don't use the dead worker.
      _workers = _workers.filter(x => x !== w);
    });

    _workers.push(w);
    console.log('[SNX-MS] Worker started — pid:', w.pid);
  }
}

/**
 * Create a new mediasoup Router on the least-loaded Worker.
 * @returns {Promise<Router>}
 */
async function createRouter() {
  if (_workers.length === 0) {
    throw new Error('[SNX-MS] No mediasoup workers available — was initWorkers() called?');
  }
  // Round-robin across available workers
  const worker = _workers[_nextWorkerIdx % _workers.length];
  _nextWorkerIdx++;

  const router = await worker.createRouter({
    mediaCodecs: config.mediasoup.router.mediaCodecs,
  });

  console.log('[SNX-MS] Router created — id:', router.id);
  return router;
}

module.exports = { initWorkers, createRouter };
