/**
 * cloudflare/snx-broadcast-worker/broadcast-container.js
 *
 * Stage 4D — BroadcastContainer Durable Object.
 *
 * Wraps the snx-broadcast Node.js application inside a Cloudflare Container.
 * Extends the Container class for lifecycle management:
 *
 *   BROADCAST STOPPED:
 *     sleepAfter = "5m"  — container may sleep after 5 minutes of no requests
 *
 *   BROADCAST ACTIVE:
 *     onActivityExpired() checks broadcast state before sleeping.
 *     If /broadcast/health reports LIVE, renewActivityTimeout() is called to
 *     prevent the container from sleeping.  A DO alarm fires every 2 minutes
 *     while a broadcast is LIVE to keep the activity timer alive.
 *
 * Restart recovery:
 *   When onStart() fires (container (re)started), if DO storage records that
 *   a broadcast was LIVE, the broadcast is automatically restarted via
 *   POST /broadcast/start.  The snx-broadcast application then:
 *     1. Reads current Firestore Radio state
 *     2. Calculates current timeline position
 *     3. Restarts FFmpeg at the correct offset
 *     4. Reconnects all enabled RTMP/RTMPS destinations
 *
 * Security:
 *   The container HTTP port is NOT publicly exposed.
 *   All traffic routes through the Worker, which enforces auth.
 *   Health endpoint is public-safe (no secrets in response).
 *
 * @module broadcast-container
 */

import { Container } from '@cloudflare/containers';

// ── Constants ────────────────────────────────────────────────────────────────

const CONTAINER_PORT  = 3100;
const SLEEP_AFTER_IDLE = '5m';        // sleep when no broadcast is active
const KEEP_ALIVE_ALARM_SEC = 120;     // alarm interval (sec) while broadcast LIVE

// Keys for DO SQLite storage
const STORAGE_BROADCAST_LIVE = 'broadcastLive';     // boolean: was a broadcast running?
const STORAGE_LAST_HEARTBEAT = 'lastHeartbeat';     // ISO timestamp

// ── BroadcastContainer ───────────────────────────────────────────────────────

export class BroadcastContainer extends Container {
  defaultPort    = CONTAINER_PORT;
  sleepAfter     = SLEEP_AFTER_IDLE;
  enableInternet = true;     // required: Firebase, R2, RTMP/RTMPS outbound

  // envVars is a plain class field — set from the constructor so that Worker
  // Secrets (env.xxx) are resolved at instantiation time, not statically.
  envVars = {};

  constructor(ctx, _env) {
    super(ctx, _env);
    // Inject Worker Secrets into the container as environment variables.
    // Secrets are never logged or returned in responses.
    this.envVars = {
      // ── Required secrets ─────────────────────────────────────────────────
      SNX_TOKEN_SECRET:               _env.SNX_TOKEN_SECRET               || '',
      FIREBASE_SERVICE_ACCOUNT_JSON:  _env.FIREBASE_SERVICE_ACCOUNT_JSON  || '',

      // ── Static configuration ─────────────────────────────────────────────
      SNX_BROADCAST_PORT:      String(CONTAINER_PORT),
      SNX_BROADCAST_BIND_HOST: '0.0.0.0',
      NODE_ENV:                'production',
      BROADCAST_DRY_RUN:       'false',
      BROADCAST_STATE_FILE:    '',   // state held in DO storage, not a file

      // ── FFmpeg paths (baked into image, here for explicitness) ───────────
      FFMPEG_PATH:      '/usr/bin/ffmpeg',
      FFMPEG_FONT_FILE: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    };
  }

  // ── Lifecycle: container started ──────────────────────────────────────────

  /**
   * Called after the container process starts.
   * If DO storage records a previous LIVE broadcast, restart it automatically.
   * This implements the restart/recovery requirement.
   */
  async onStart() {
    console.log('[BROADCAST-CONTAINER] Container started');

    const wasLive = await this.ctx.storage.get(STORAGE_BROADCAST_LIVE);
    if (wasLive) {
      console.log('[BROADCAST-CONTAINER] Previous broadcast was LIVE — auto-restarting');
      // Give snx-broadcast a few seconds to fully initialise before we poke it.
      await _sleep(5_000);
      await this._restartBroadcast();
    }

    // Schedule the keep-alive alarm.  The alarm only matters while LIVE; it
    // auto-cancels itself in the alarm handler when the broadcast is stopped.
    await this._scheduleKeepAliveAlarm();
  }

  // ── Lifecycle: container stopped ─────────────────────────────────────────

  async onStop() {
    console.log('[BROADCAST-CONTAINER] Container stopped');
    await this.ctx.storage.set(STORAGE_LAST_HEARTBEAT, new Date().toISOString());
  }

  // ── Lifecycle: activity timer expired ─────────────────────────────────────

  /**
   * Called when sleepAfter expires with no incoming requests.
   * Before sleeping, check if a broadcast is actually running.
   * If LIVE: renew the activity timer instead of sleeping.
   * If idle: allow the container to sleep.
   */
  async onActivityExpired() {
    const live = await this._checkBroadcastLive();
    if (live) {
      console.log('[BROADCAST-CONTAINER] Activity expired but broadcast is LIVE — keeping alive');
      this.renewActivityTimeout();
      return;
    }
    console.log('[BROADCAST-CONTAINER] Activity expired, broadcast idle — sleeping');
    await this.stop();
  }

  // ── Durable Object alarm ──────────────────────────────────────────────────

  /**
   * DO alarm fires every KEEP_ALIVE_ALARM_SEC seconds while a broadcast is LIVE.
   * Renews the Container activity timer so the container does not sleep.
   */
  async alarm() {
    const live = await this._checkBroadcastLive();
    if (live) {
      this.renewActivityTimeout();
      await this._scheduleKeepAliveAlarm();
      console.log('[BROADCAST-CONTAINER] Keep-alive alarm: broadcast LIVE — timer renewed');
    } else {
      // Broadcast stopped — cancel keep-alive alarm, allow container to sleep naturally.
      console.log('[BROADCAST-CONTAINER] Keep-alive alarm: broadcast idle — alarm cancelled');
      // No rescheduling: alarm will not fire again until onStart reschedules it.
    }
  }

  // ── HTTP request handler ───────────────────────────────────────────────────

  /**
   * Proxy all requests to the snx-broadcast HTTP API inside the container.
   * The Worker validates auth before routing here, so the container itself
   * does its own auth check as a second layer.
   */
  async fetch(request) {
    await this.startAndWaitForPorts([CONTAINER_PORT]);
    return this.containerFetch(request);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  async _checkBroadcastLive() {
    try {
      const resp = await this.containerFetch(
        new Request(`http://localhost:${CONTAINER_PORT}/broadcast/health`, { method: 'GET' }),
      );
      if (!resp.ok) return false;
      const body = await resp.json();
      const engineState = body.engineState || '';
      const isLive = engineState === 'LIVE' || engineState === 'CONNECTING';
      // Persist current live state to DO storage for restart recovery.
      await this.ctx.storage.put(STORAGE_BROADCAST_LIVE, isLive);
      return isLive;
    } catch {
      return false;
    }
  }

  async _restartBroadcast() {
    try {
      // Use the internal route in server.js which only accepts localhost connections.
      // No Bearer token required — the call originates from within the container.
      const resp = await this.containerFetch(
        new Request(`http://localhost:${CONTAINER_PORT}/broadcast/_internal/start`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ forceRefreshDestinations: false }),
        }),
      );
      if (resp.ok) {
        const body = await resp.json();
        console.log('[BROADCAST-CONTAINER] Auto-restart succeeded —', body);
        await this.ctx.storage.put(STORAGE_BROADCAST_LIVE, true);
        await this.ctx.storage.put(STORAGE_LAST_HEARTBEAT, new Date().toISOString());
      } else {
        const text = await resp.text();
        console.warn('[BROADCAST-CONTAINER] Auto-restart response:', resp.status, text);
      }
    } catch (err) {
      console.error('[BROADCAST-CONTAINER] Auto-restart failed:', err.message);
    }
  }

  async _scheduleKeepAliveAlarm() {
    const alarmTime = Date.now() + KEEP_ALIVE_ALARM_SEC * 1_000;
    await this.ctx.storage.setAlarm(alarmTime);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
