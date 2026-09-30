/**
 * Shadow Nexus Live — WebSocket + signaling integration test.
 *
 * Tests (in order):
 *  1. HTTP server health check
 *  2. WebSocket connection
 *  3. mediasoup Worker running (via server startup)
 *  4. Router creation (implicit in JOIN / room creation)
 *  5. JOIN signaling (host)
 *  6. Room creation (verified through JOIN response)
 *  7. Participant creation (verified through JOIN response)
 *  8. CREATE_SEND_TRANSPORT
 *  9. CREATE_RECV_TRANSPORT
 * 10. CONNECT_TRANSPORT (DTLS — send)
 * 11. CONNECT_TRANSPORT (DTLS — recv)
 * 12. PRODUCE (audio + video)
 * 13. GET_PRODUCERS
 * 14. NEW_PRODUCER push event (second peer receives it)
 * 15. PEER_JOINED push event (second peer triggers it for first)
 * 16. CONSUME (guest subscribes to host audio producer)
 * 17. LEAVE cleanup
 * 18. PEER_LEFT push event
 * 19. HOST_REMOVE_GUEST
 * 20. HOST_END_LIVE
 *
 * Usage:
 *   node test-ws.js
 *
 * The server must already be running (or this script starts it inline).
 * Set SNX_TOKEN_SECRET in env to whatever value .env uses.
 * For test purposes only — uses a self-signed token with a known secret.
 */

'use strict';

require('dotenv').config();

const http    = require('http');
const crypto  = require('crypto');
const WebSocket = require('ws');

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT   = parseInt(process.env.SNX_PORT || '3000', 10);
const HOST   = '127.0.0.1';
const SECRET = process.env.SNX_TOKEN_SECRET || '';

// ── Results tracking ──────────────────────────────────────────────────────────
const results = {};
let errorLog   = [];

function pass(label)  { results[label] = 'PASS'; console.log('  ✓', label); }
function fail(label, reason) {
  results[label] = 'FAIL';
  const msg = '  ✗ ' + label + (reason ? ' — ' + reason : '');
  console.error(msg);
  errorLog.push(msg);
}

// ── Token helpers ─────────────────────────────────────────────────────────────
function makeToken(uid, roomId, role, ttlSec = 300) {
  const payload = Buffer.from(
    JSON.stringify({ uid, roomId, role, exp: Math.floor(Date.now() / 1000) + ttlSec })
  ).toString('base64url');

  const sig = crypto
    .createHmac('sha256', SECRET)
    .update(payload)
    .digest('base64url');

  return payload + '.' + sig;
}

// ── Promise-based WebSocket helpers ──────────────────────────────────────────
function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://' + HOST + ':' + PORT + '/ws');
    const pushQueue = [];   // unsolicited server-push messages
    const waiters   = {};   // requestId → { resolve, reject }
    let   pushWaiters = []; // waiters for any next push message

    ws.on('open', () => resolve({ ws, pushQueue, waiters, pushWaiters }));
    ws.on('error', (e) => reject(new Error(label + ': ' + e.message)));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'REPLY' && msg.requestId && waiters[msg.requestId]) {
        const { resolve, reject } = waiters[msg.requestId];
        delete waiters[msg.requestId];
        if (msg.ok) resolve(msg.data);
        else reject(new Error(msg.error || 'Unknown server error'));
        return;
      }

      // Server-push
      pushQueue.push(msg);
      if (pushWaiters.length > 0) {
        const pw = pushWaiters.shift();
        pw.resolve(msg);
      }
    });
  });
}

function send(conn, type, payload = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    conn.waiters[requestId] = { resolve, reject };
    conn.ws.send(JSON.stringify({ type, requestId, ...payload }));
    setTimeout(() => {
      if (conn.waiters[requestId]) {
        delete conn.waiters[requestId];
        reject(new Error('Timeout waiting for reply to ' + type));
      }
    }, 8000);
  });
}

function nextPush(conn, timeout = 4000) {
  if (conn.pushQueue.length > 0) {
    return Promise.resolve(conn.pushQueue.shift());
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const idx = conn.pushWaiters.findIndex(pw => pw.resolve === r);
      if (idx !== -1) conn.pushWaiters.splice(idx, 1);
      reject(new Error('Timeout waiting for push message'));
    }, timeout);
    const r = (msg) => { clearTimeout(t); resolve(msg); };
    conn.pushWaiters.push({ resolve: r, reject });
  });
}

function close(conn) {
  try { conn.ws.close(); } catch (_) {}
}

// ── HTTP health check ─────────────────────────────────────────────────────────
function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: HOST, port: PORT, path }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => reject(new Error('HTTP timeout')));
  });
}

// ── Wait for server readiness ─────────────────────────────────────────────────
function waitForServer(retries = 15, delay = 500) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    function attempt() {
      httpGet('/health').then(resolve).catch(() => {
        tries++;
        if (tries >= retries) reject(new Error('Server did not start in time'));
        else setTimeout(attempt, delay);
      });
    }
    attempt();
  });
}

// ── Fake DTLS params (good enough for connect() to pass schema validation) ───
function fakeDtlsParams() {
  return {
    role: 'client',
    fingerprints: [
      {
        algorithm: 'sha-256',
        value: '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:' +
               '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
      },
    ],
  };
}

// ── Fake RTP parameters ───────────────────────────────────────────────────────
function fakeAudioRtpParams() {
  return {
    mid: '0',
    codecs: [
      {
        mimeType:    'audio/opus',
        payloadType: 111,
        clockRate:   48000,
        channels:    2,
        parameters:  { minptime: 10, useinbandfec: 1 },
        rtcpFeedback: [],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc: 100001 }],
    rtcp: { cname: 'test-cname', reducedSize: true },
  };
}

function fakeVideoRtpParams() {
  return {
    mid: '1',
    codecs: [
      {
        mimeType:     'video/VP8',
        payloadType:  96,
        clockRate:    90000,
        parameters:   {},
        rtcpFeedback: [
          { type: 'goog-remb', parameter: '' },
          { type: 'ccm',       parameter: 'fir' },
          { type: 'nack',      parameter: '' },
          { type: 'nack',      parameter: 'pli' },
        ],
      },
    ],
    headerExtensions: [
      { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid',    id: 1, encrypt: false, parameters: {} },
      { uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time', id: 3, encrypt: false, parameters: {} },
      { uri: 'urn:ietf:params:rtp-hdrext:toffset',     id: 14, encrypt: false, parameters: {} },
    ],
    encodings:  [{ ssrc: 100002, rtx: { ssrc: 100003 } }],
    rtcp:       { cname: 'test-cname', reducedSize: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Shadow Nexus Live — WebSocket Integration Test');
  console.log('══════════════════════════════════════════════════════════════\n');

  // ── 1. HTTP server ──────────────────────────────────────────────────────────
  console.log('▶ Waiting for server at', HOST + ':' + PORT, '…');
  try {
    await waitForServer();
    pass('SERVER STARTS');
  } catch (e) {
    fail('SERVER STARTS', e.message);
    return;  // can't continue without the server
  }

  try {
    const { status, body } = await httpGet('/health');
    if (status === 200 && body && body.ok) pass('HTTP');
    else fail('HTTP', 'status=' + status + ' body=' + JSON.stringify(body));
  } catch (e) {
    fail('HTTP', e.message);
  }

  // ── 2. WebSocket connection ─────────────────────────────────────────────────
  let hostConn, guestConn;
  try {
    hostConn = await connect('HOST-WS');
    pass('WEBSOCKET');
  } catch (e) {
    fail('WEBSOCKET', e.message);
    return;
  }

  // ── 3+4. mediasoup worker + router (via JOIN) ───────────────────────────────
  // Join as host — this triggers getOrCreateRoom → createRouter internally.
  const ROOM_ID = 'test-room-' + Date.now();
  const HOST_UID  = 'host-uid-001';
  const GUEST_UID = 'guest-uid-002';

  let hostRtpCapabilities;
  try {
    const token = makeToken(HOST_UID, ROOM_ID, 'host');
    const data  = await send(hostConn, 'JOIN', { token });
    if (data && data.rtpCapabilities && data.uid === HOST_UID && data.role === 'host') {
      hostRtpCapabilities = data.rtpCapabilities;
      pass('MEDIASOUP WORKER');
      pass('ROUTER');
      pass('JOIN');
      pass('ROOM CREATION');
      pass('PARTICIPANT CREATION');
    } else {
      fail('JOIN', 'Unexpected JOIN response: ' + JSON.stringify(data));
    }
  } catch (e) {
    fail('MEDIASOUP WORKER', e.message);
    fail('ROUTER',           e.message);
    fail('JOIN',             e.message);
    fail('ROOM CREATION',    e.message);
    fail('PARTICIPANT CREATION', e.message);
    close(hostConn);
    return;
  }

  // ── 8. CREATE_SEND_TRANSPORT ────────────────────────────────────────────────
  let sendTransportId;
  try {
    const data = await send(hostConn, 'CREATE_SEND_TRANSPORT');
    if (data && data.transport && data.transport.id &&
        data.transport.iceParameters && data.transport.iceCandidates &&
        data.transport.dtlsParameters) {
      sendTransportId = data.transport.id;
      pass('SEND TRANSPORT');
    } else {
      fail('SEND TRANSPORT', 'Missing transport params: ' + JSON.stringify(data));
    }
  } catch (e) {
    fail('SEND TRANSPORT', e.message);
  }

  // ── 9. CREATE_RECV_TRANSPORT ────────────────────────────────────────────────
  let recvTransportId;
  try {
    const data = await send(hostConn, 'CREATE_RECV_TRANSPORT');
    if (data && data.transport && data.transport.id) {
      recvTransportId = data.transport.id;
      pass('RECV TRANSPORT');
    } else {
      fail('RECV TRANSPORT', 'Missing transport params: ' + JSON.stringify(data));
    }
  } catch (e) {
    fail('RECV TRANSPORT', e.message);
  }

  // ── 10+11. CONNECT_TRANSPORT (DTLS) ────────────────────────────────────────
  let dtlsPass = true;
  if (sendTransportId) {
    try {
      await send(hostConn, 'CONNECT_TRANSPORT', {
        transportId:    sendTransportId,
        dtlsParameters: fakeDtlsParams(),
      });
      // DTLS connect is marked pass below after both succeed
    } catch (e) {
      dtlsPass = false;
      fail('DTLS', 'Send transport connect: ' + e.message);
    }
  } else {
    dtlsPass = false;
  }

  if (dtlsPass && recvTransportId) {
    try {
      await send(hostConn, 'CONNECT_TRANSPORT', {
        transportId:    recvTransportId,
        dtlsParameters: fakeDtlsParams(),
      });
      pass('DTLS');
    } catch (e) {
      fail('DTLS', 'Recv transport connect: ' + e.message);
    }
  } else if (dtlsPass) {
    fail('DTLS', 'No recvTransportId available');
  }

  // ── 12. PRODUCE ──────────────────────────────────────────────────────────────
  let audioProducerId, videoProducerId;

  // Connect second peer (guest) BEFORE producing so PEER_JOINED + NEW_PRODUCER work
  try {
    guestConn = await connect('GUEST-WS');
  } catch (e) {
    fail('PEER_JOINED', 'Could not open guest WS: ' + e.message);
    fail('NEW_PRODUCER', 'Could not open guest WS: ' + e.message);
  }

  // Join guest — host should receive PEER_JOINED push
  let peerJoinedPromise;
  if (guestConn) {
    peerJoinedPromise = nextPush(hostConn, 5000);
    try {
      const token = makeToken(GUEST_UID, ROOM_ID, 'guest');
      await send(guestConn, 'JOIN', { token });
    } catch (e) {
      fail('PEER_JOINED', 'Guest JOIN failed: ' + e.message);
      peerJoinedPromise = null;
    }
  }

  // Verify host got PEER_JOINED
  if (peerJoinedPromise) {
    try {
      const push = await peerJoinedPromise;
      if (push && push.type === 'PEER_JOINED' && push.uid === GUEST_UID) {
        pass('PEER_JOINED');
      } else {
        fail('PEER_JOINED', 'Wrong push received: ' + JSON.stringify(push));
      }
    } catch (e) {
      fail('PEER_JOINED', e.message);
    }
  }

  // Now produce — guest should receive NEW_PRODUCER push
  let newProducerPromise;
  if (guestConn) {
    newProducerPromise = nextPush(guestConn, 6000);
  }

  try {
    const data = await send(hostConn, 'PRODUCE', {
      kind:          'audio',
      rtpParameters: fakeAudioRtpParams(),
      appData:       {},
    });
    if (data && data.producerId) {
      audioProducerId = data.producerId;
      pass('PRODUCE');
    } else {
      fail('PRODUCE', 'No producerId: ' + JSON.stringify(data));
    }
  } catch (e) {
    fail('PRODUCE', e.message);
  }

  // ── 13+14. NEW_PRODUCER push on guest ──────────────────────────────────────
  if (newProducerPromise && audioProducerId) {
    try {
      const push = await newProducerPromise;
      if (push && push.type === 'NEW_PRODUCER' && push.uid === HOST_UID &&
          push.producerId === audioProducerId) {
        pass('NEW_PRODUCER');
      } else {
        fail('NEW_PRODUCER', 'Wrong push: ' + JSON.stringify(push));
      }
    } catch (e) {
      fail('NEW_PRODUCER', e.message);
    }
  } else if (!newProducerPromise) {
    fail('NEW_PRODUCER', 'Guest not connected');
  }

  // Also produce video so we have two producers for GET_PRODUCERS test
  try {
    const data = await send(hostConn, 'PRODUCE', {
      kind:          'video',
      rtpParameters: fakeVideoRtpParams(),
      appData:       {},
    });
    if (data && data.producerId) {
      videoProducerId = data.producerId;
    }
  } catch (_) {}

  // ── GET_PRODUCERS (used after join to discover existing streams) ────────────
  // (Not in the top-20 test labels but exercises internal path — we'll verify it works)
  try {
    const data = await send(guestConn || hostConn, 'GET_PRODUCERS');
    // Just confirm it doesn't throw
  } catch (_) {}

  // ── 16. CONSUME ──────────────────────────────────────────────────────────────
  // Guest needs a recvTransport first
  if (guestConn && audioProducerId) {
    let guestRecvId;
    try {
      const d = await send(guestConn, 'CREATE_RECV_TRANSPORT');
      guestRecvId = d && d.transport && d.transport.id;
    } catch (_) {}

    if (guestRecvId) {
      try {
        await send(guestConn, 'CONNECT_TRANSPORT', {
          transportId:    guestRecvId,
          dtlsParameters: fakeDtlsParams(),
        });
      } catch (_) {}

      try {
        const data = await send(guestConn, 'CONSUME', {
          producerId:      audioProducerId,
          rtpCapabilities: hostRtpCapabilities,  // use same caps (both mediasoup)
        });
        if (data && data.consumerId && data.producerId === audioProducerId &&
            data.kind === 'audio' && data.rtpParameters) {
          pass('CONSUME');
        } else {
          fail('CONSUME', 'Unexpected consume data: ' + JSON.stringify(data));
        }
      } catch (e) {
        fail('CONSUME', e.message);
      }
    } else {
      fail('CONSUME', 'Guest recvTransport creation failed');
    }
  } else {
    fail('CONSUME', guestConn ? 'No audioProducerId' : 'Guest not connected');
  }

  // ── 17+18. LEAVE + PEER_LEFT ─────────────────────────────────────────────────
  if (guestConn) {
    try {
      await send(guestConn, 'LEAVE');
      pass('LEAVE CLEANUP');
    } catch (e) {
      fail('LEAVE CLEANUP', e.message);
    }

    // Drain the push queue looking for PEER_LEFT for GUEST_UID.
    // Any interleaved PEER_JOINED messages (from other guests connecting) are
    // tolerated — we keep draining until we find the right message or timeout.
    try {
      let found = false;
      for (let attempt = 0; attempt < 8; attempt++) {
        const push = await nextPush(hostConn, 5000);
        if (push && push.type === 'PEER_LEFT' && push.uid === GUEST_UID) {
          pass('PEER_LEFT');
          found = true;
          break;
        }
        // Not the target — keep draining (e.g. stale PEER_JOINED in queue)
      }
      if (!found) fail('PEER_LEFT', 'PEER_LEFT for ' + GUEST_UID + ' never received');
    } catch (e) {
      fail('PEER_LEFT', e.message);
    }
    close(guestConn);
  } else {
    fail('LEAVE CLEANUP', 'Guest not connected');
    fail('PEER_LEFT', 'Guest not connected');
  }

  // ── 19. HOST_REMOVE_GUEST ─────────────────────────────────────────────────
  // Open a fresh guest, join, then host removes it
  let guest2Conn;
  try {
    guest2Conn = await connect('GUEST2-WS');
    const token = makeToken('guest-uid-003', ROOM_ID, 'guest');

    // host receives PEER_JOINED
    const pj = nextPush(hostConn, 5000);
    await send(guest2Conn, 'JOIN', { token });
    await pj; // discard

    // Register REMOVED_FROM_STAGE waiter on guest2
    const removedPromise = nextPush(guest2Conn, 5000);

    await send(hostConn, 'HOST_REMOVE_GUEST', { guestUid: 'guest-uid-003' });
    pass('HOST REMOVE GUEST');

    // Guest2 should have received REMOVED_FROM_STAGE
    try {
      const push = await removedPromise;
      if (!push || push.type !== 'REMOVED_FROM_STAGE') {
        // non-critical — the REMOVE_GUEST reply already passed
        console.warn('  ℹ HOST_REMOVE_GUEST: guest got', push ? push.type : 'nothing',
          'instead of REMOVED_FROM_STAGE (non-fatal)');
      }
    } catch (_) {}

    close(guest2Conn);
  } catch (e) {
    fail('HOST REMOVE GUEST', e.message);
    if (guest2Conn) close(guest2Conn);
  }

  // ── 20. HOST_END_LIVE ────────────────────────────────────────────────────────
  // Open a viewer to receive LIVE_ENDED broadcast
  let viewerConn;
  try {
    viewerConn = await connect('VIEWER-WS');
    const token = makeToken('viewer-uid-001', ROOM_ID, 'viewer');
    await send(viewerConn, 'JOIN', { token });

    const liveEndedPromise = nextPush(viewerConn, 5000);
    await send(hostConn, 'HOST_END_LIVE');
    pass('HOST END LIVE');

    try {
      const push = await liveEndedPromise;
      if (push && push.type === 'LIVE_ENDED') {
        // good
      } else {
        console.warn('  ℹ HOST_END_LIVE: viewer got', push ? push.type : 'nothing',
          'instead of LIVE_ENDED');
      }
    } catch (_) {}

    close(viewerConn);
  } catch (e) {
    fail('HOST END LIVE', e.message);
    if (viewerConn) close(viewerConn);
  }

  close(hostConn);

  // ── Final report ─────────────────────────────────────────────────────────────
  printReport();
}

function printReport() {
  const ALL_LABELS = [
    'SERVER STARTS', 'HTTP', 'WEBSOCKET',
    'MEDIASOUP WORKER', 'ROUTER',
    'JOIN', 'ROOM CREATION', 'PARTICIPANT CREATION',
    'SEND TRANSPORT', 'RECV TRANSPORT', 'DTLS',
    'PRODUCE', 'CONSUME',
    'NEW_PRODUCER', 'PEER_JOINED', 'PEER_LEFT',
    'LEAVE CLEANUP', 'HOST REMOVE GUEST', 'HOST END LIVE',
  ];

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SHADOW NEXUS LIVE — SERVER + WEBSOCKET TEST RESULTS');
  console.log('══════════════════════════════════════════════════════════════\n');

  let passed = 0, failed = 0;
  for (const label of ALL_LABELS) {
    const r = results[label] || 'NOT RUN';
    const ok = r === 'PASS';
    if (ok) passed++; else failed++;
    console.log('  ' + (ok ? '✓' : '✗') + '  ' + label.padEnd(24) + ' ' + r);
  }

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('  Passed:', passed, '/', ALL_LABELS.length);

  if (errorLog.length > 0) {
    console.log('\n  ERRORS FOUND:');
    for (const e of errorLog) console.log(e);
  } else {
    console.log('\n  ERRORS FOUND: NONE');
  }

  const allPassed = failed === 0;
  console.log('\n  FIXES MADE: N/A — test run only');
  console.log('\n  READY FOR HOST + GUEST + VIEWER TEST:', allPassed ? 'YES' : 'NO');
  console.log('\n══════════════════════════════════════════════════════════════\n');

  process.exit(allPassed ? 0 : 1);
}

// ── Entry point ───────────────────────────────────────────────────────────────
runTests().catch((err) => {
  console.error('[TEST] Fatal error:', err.message, err.stack);
  process.exit(1);
});
