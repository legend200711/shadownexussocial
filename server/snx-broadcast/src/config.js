/**
 * snx-broadcast/src/config.js
 *
 * Stage 4D — All configuration from environment variables.
 *
 * Firebase Admin credentials can be supplied in one of two ways:
 *
 *   1. CLOUDFLARE CONTAINER (preferred):
 *      Set FIREBASE_SERVICE_ACCOUNT_JSON to the full service account JSON string.
 *      The Container runtime injects this from Cloudflare Worker Secrets.
 *
 *   2. VPS FALLBACK (preserved):
 *      Set FIREBASE_SERVICE_ACCOUNT to a path to the JSON file on disk.
 *      Defaults to './secrets/firebase-service-account.json'.
 *
 *   Priority: FIREBASE_SERVICE_ACCOUNT_JSON  > FIREBASE_SERVICE_ACCOUNT (file path)
 *
 * Stream keys are stored in Firestore /broadcastDestinations (server-side only).
 */

'use strict';

require('dotenv').config();

module.exports = {

  // ── HTTP control API ────────────────────────────────────────────────────────
  // Inside a Cloudflare Container the server must bind to 0.0.0.0.
  // On VPS (behind Cloudflare Tunnel) bind only to 127.0.0.1.
  port: parseInt(process.env.SNX_BROADCAST_PORT || '3100', 10),
  bindHost: process.env.SNX_BROADCAST_BIND_HOST || '0.0.0.0',

  // ── Authentication (same scheme as snx-live) ───────────────────────────────
  // Verifies short-lived SNX session tokens issued by the Cloudflare Worker.
  tokenSecret: process.env.SNX_TOKEN_SECRET || '',

  // ── Firebase Admin ─────────────────────────────────────────────────────────
  // See module docblock above for credential priority order.
  //
  // firebaseServiceAccountJson: inline JSON string (Cloudflare Container path)
  // firebaseServiceAccount:     file path           (VPS fallback path)
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '',
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT || './secrets/firebase-service-account.json',

  // ── Firestore paths (must match snx-radio.js and firestore.rules) ─────────
  firestore: {
    colSite:          'siteSettings',
    docStation:       'radioStation',    // /siteSettings/radioStation
    docSettings:      'radioSettings',   // /siteSettings/radioSettings
    colTracks:        'radioTracks',
    colMusic:         'music',
    colPlaylists:     'radioPlaylists',
    colPrograms:      'radioPrograms',
    colSchedule:      'radioSchedule',
    colDestinations:  'broadcastDestinations',   // /broadcastDestinations/{id}
  },

  // ── Radio timeline ─────────────────────────────────────────────────────────
  // Minimum track duration in seconds — tracks shorter than this are skipped.
  minTrackDurationSec: 5,

  // How often the broadcast engine polls the radio timeline to detect track transitions.
  tickIntervalMs: 1000,

  // ── FFmpeg encoder ─────────────────────────────────────────────────────────
  encoder: {
    // Override ffmpeg binary location (leave empty to use $PATH).
    ffmpegPath:   process.env.FFMPEG_PATH || '',

    // Output video dimensions
    width:        1280,
    height:       720,
    fps:          30,

    // Video codec settings — H.264 (libx264)
    videoCodec:   'libx264',
    videoBitrate: '2500k',
    videoPreset:  'veryfast',   // balance of quality vs CPU on a VPS
    videoProfile: 'main',
    videoLevel:   '4.1',

    // Audio codec settings — AAC
    audioCodec:   'aac',
    audioBitrate: '160k',
    audioRate:    44100,
    audioChannels: 2,

    // Artwork overlay font for drawtext
    fontFile: process.env.FFMPEG_FONT_FILE
      || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  },

  // ── Broadcast state persistence ────────────────────────────────────────────
  // Path to a JSON file that records engine state across restarts.
  // Only contains safe metadata (no stream keys).
  // Set to '' to disable persistence.
  statePath: process.env.BROADCAST_STATE_FILE || './broadcast-state.json',

  // ── Development / Testing ──────────────────────────────────────────────────
  // Set BROADCAST_DRY_RUN=true to:
  //   - Skip FFmpeg process
  //   - Skip Firestore destination reads (uses mock data)
  //   - Still execute timeline/auth/source logic
  dryRun: process.env.BROADCAST_DRY_RUN === 'true',
};
