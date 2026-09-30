/**
 * snx-broadcast/src/health.js
 *
 * Stage 4B — Engine health.
 *
 * GET /broadcast/health — lightweight, public-safe status.
 * Never includes stream keys, RTMP URLs, auth tokens, or service account data.
 */

'use strict';

const broadcastMgr   = require('./broadcast-manager');
const { probeFFmpeg } = require('./encoder');
const config         = require('./config');

let _ffmpegProbeCache = null;

/**
 * Return a lightweight health object — safe to expose publicly.
 */
async function getHealth() {
  if (!_ffmpegProbeCache) {
    if (config.dryRun) {
      _ffmpegProbeCache = { ok: true, version: 'dry-run', error: null };
    } else {
      _ffmpegProbeCache = await probeFFmpeg();
    }
  }

  const state    = broadcastMgr.getState();
  const status   = broadcastMgr.getStatus();
  const uptimeSec = status.uptimeSec;

  return {
    service:     'snx-broadcast',
    version:     '4.0.0',
    uptime:      process.uptime(),
    engineState: state,
    ffmpeg:      _ffmpegProbeCache.ok ? ('available v' + _ffmpegProbeCache.version) : 'missing',
    dryRun:      config.dryRun,
    // Safe destination summary (count + names only)
    destinations: {
      count: status.destinations?.count || 0,
      names: status.destinations?.names || [],
    },
    source: status.source ? {
      active:    status.source.active,
      trackTitle: status.source.track?.title || null,
    } : null,
    broadcastUptimeSec: uptimeSec,
    timestamp:  new Date().toISOString(),
  };
}

/** Invalidate the FFmpeg probe cache (useful after PATH changes). */
function invalidateProbeCache() {
  _ffmpegProbeCache = null;
}

module.exports = { getHealth, invalidateProbeCache };
