/**
 * snx-broadcast/src/server.js
 *
 * Stage 4D — HTTP control API for the Shadow Nexus Broadcast Engine.
 *
 * Endpoints:
 *
 *   PUBLIC (no auth):
 *     GET  /broadcast/health          — lightweight engine health
 *
 *   FOUNDER ONLY (Bearer SNX session token required):
 *     GET  /broadcast/status          — full engine status (no secrets)
 *     POST /broadcast/start           — start broadcast
 *     POST /broadcast/stop            — stop broadcast
 *     POST /broadcast/destinations/refresh — force-refresh destination cache
 *
 * Auth scheme:
 *   Same SNX session token as snx-live (HMAC-SHA256 signed, role=founder).
 *   Token issued by the Cloudflare Worker and sent as "Authorization: Bearer <token>".
 *
 * NEVER return stream keys, RTMP URLs, or Firebase credentials in responses.
 */

'use strict';

require('dotenv').config();

const express     = require('express');
const admin       = require('firebase-admin');
const config      = require('./config');
const { requireFounder } = require('./auth');
const broadcastMgr = require('./broadcast-manager');
const destStore   = require('./destinations/store');
const health      = require('./health');

const app = express();
app.use(express.json());

// ── Firebase Admin init ───────────────────────────────────────────────────────
//
// Priority:
//   1. FIREBASE_SERVICE_ACCOUNT_JSON (inline JSON string — Cloudflare Container)
//   2. FIREBASE_SERVICE_ACCOUNT      (file path — VPS fallback)

let _adminApp = null;

function _initFirebase() {
  if (_adminApp) return _adminApp;
  try {
    let serviceAccount;

    if (config.firebaseServiceAccountJson) {
      // Cloudflare Container path: inline JSON injected as Worker Secret
      serviceAccount = JSON.parse(config.firebaseServiceAccountJson);
      console.log('[BROADCAST-SERVER] Firebase Admin: using inline JSON credentials (container mode)');
    } else {
      // VPS fallback: JSON file on disk
      const serviceAccountPath = require('path').resolve(config.firebaseServiceAccount);
      serviceAccount = require(serviceAccountPath);
      console.log('[BROADCAST-SERVER] Firebase Admin: using file credentials (VPS mode)');
    }

    _adminApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('[BROADCAST-SERVER] Firebase Admin initialized');
  } catch (err) {
    console.error('[BROADCAST-SERVER] Firebase Admin init failed:', err.message);
    if (!config.firebaseServiceAccountJson) {
      console.error('  → Container mode: set FIREBASE_SERVICE_ACCOUNT_JSON env var');
    }
    console.error('  → VPS mode: set FIREBASE_SERVICE_ACCOUNT to a valid service account JSON path');
    process.exit(1);
  }
  return _adminApp;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Public health — no auth required.
// Returns safe operational status only.
app.get('/broadcast/health', async (req, res) => {
  try {
    const h = await health.getHealth();
    res.json({ ok: true, ...h });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Full status — Founder only.
// Returns detailed engine + source + encoder state.
// No stream keys, no RTMP URLs.
app.get('/broadcast/status', requireFounder, (req, res) => {
  try {
    res.json({ ok: true, ...broadcastMgr.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start broadcast — Founder only.
// Validates state → fetches destinations from Firestore → spawns FFmpeg.
// Returns LIVE only after FFmpeg has successfully started.
app.post('/broadcast/start', requireFounder, async (req, res) => {
  const forceRefresh = !!(req.body?.forceRefreshDestinations);
  try {
    const result = await broadcastMgr.startBroadcast({ forceRefreshDestinations: forceRefresh });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Stop broadcast — Founder only.
// Gracefully terminates FFmpeg, updates state.
app.post('/broadcast/stop', requireFounder, async (req, res) => {
  try {
    await broadcastMgr.stopBroadcast();
    res.json({ ok: true, message: 'Broadcast stopped' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Internal start — called by the Durable Object restart recovery (localhost only).
// This bypasses Founder auth because the DO itself originates the call.
// Bound to loopback: only 127.0.0.1 source is accepted.
app.post('/broadcast/_internal/start', (req, res, next) => {
  // Only allow calls from within the container (loopback)
  const src = req.socket?.remoteAddress || req.ip || '';
  const isLocal = src === '127.0.0.1' || src === '::1' || src === '::ffff:127.0.0.1';
  if (!isLocal) {
    return res.status(403).json({ ok: false, error: 'Internal route — localhost only' });
  }
  next();
}, async (req, res) => {
  const forceRefresh = !!(req.body?.forceRefreshDestinations);
  try {
    const result = await broadcastMgr.startBroadcast({ forceRefreshDestinations: forceRefresh });
    res.json({ ok: true, internal: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Force-refresh destination cache — Founder only.
// Use after adding/editing/deleting destinations in Firestore.
app.post('/broadcast/destinations/refresh', requireFounder, async (req, res) => {
  try {
    destStore.invalidateCache();
    const destinations = await destStore.getEnabledDestinations(true);
    // Return names only — never keys
    res.json({
      ok: true,
      destinations: destinations.map(d => ({ id: d.id, name: d.name })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function start() {
  const firebaseApp = _initFirebase();
  await broadcastMgr.init(firebaseApp);

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`[BROADCAST-SERVER] Listening on ${config.bindHost}:${config.port}`);
    console.log(`[BROADCAST-SERVER] Health: http://${config.bindHost}:${config.port}/broadcast/health`);
    if (config.dryRun) {
      console.log('[BROADCAST-SERVER] *** DRY RUN MODE — no FFmpeg, no real destinations ***');
    }
  });

  // Graceful shutdown
  process.on('SIGTERM', () => _shutdown(server));
  process.on('SIGINT',  () => _shutdown(server));
}

async function _shutdown(server) {
  console.log('[BROADCAST-SERVER] Shutting down…');
  try {
    if (broadcastMgr.isLive()) {
      await broadcastMgr.stopBroadcast().catch(() => {});
    }
  } finally {
    server.close(() => {
      console.log('[BROADCAST-SERVER] Shutdown complete');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5_000);  // hard kill after 5s
  }
}

start().catch(err => {
  console.error('[BROADCAST-SERVER] Fatal startup error:', err.message);
  process.exit(1);
});

module.exports = app;
