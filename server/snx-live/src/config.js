/**
 * Shadow Nexus Live — mediasoup server configuration
 * All values come from environment variables (see .env.example).
 */

'use strict';

require('dotenv').config();

module.exports = {
  // ── HTTP / WebSocket server ────────────────────────────────────────────────
  http: {
    listenIp:   process.env.SNX_LISTEN_IP || '0.0.0.0',
    listenPort: parseInt(process.env.SNX_PORT || '3000', 10),
  },

  // ── Authentication ─────────────────────────────────────────────────────────
  // Shared secret used to verify short-lived SNX session tokens issued by the
  // Cloudflare Worker.  Never expose this value to browser clients.
  tokenSecret: process.env.SNX_TOKEN_SECRET || '',

  // ── mediasoup ─────────────────────────────────────────────────────────────
  mediasoup: {
    // Number of mediasoup Worker processes.  One per logical CPU is reasonable.
    numWorkers: Math.max(1, require('os').cpus().length),

    // Worker settings
    worker: {
      rtcMinPort:    parseInt(process.env.MEDIASOUP_MIN_PORT || '10000', 10),
      rtcMaxPort:    parseInt(process.env.MEDIASOUP_MAX_PORT || '59999', 10),
      logLevel:      'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },

    // Router media codecs.  Browsers on Android Chrome + Safari support both.
    router: {
      mediaCodecs: [
        {
          kind:      'audio',
          mimeType:  'audio/opus',
          clockRate: 48000,
          channels:  2,
        },
        {
          kind:       'video',
          mimeType:   'video/VP8',
          clockRate:  90000,
          parameters: {
            'x-google-start-bitrate': 1000,
          },
        },
        // VP9 optional — keeps compatibility broad without adding complexity
        {
          kind:       'video',
          mimeType:   'video/VP9',
          clockRate:  90000,
          parameters: {
            'profile-id': 2,
            'x-google-start-bitrate': 1000,
          },
        },
      ],
    },

    // WebRtcTransport options applied to every new transport (send or receive).
    webRtcTransport: {
      listenIps: [
        {
          ip:          process.env.SNX_LISTEN_IP     || '0.0.0.0',
          announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
        },
      ],
      maxIncomingBitrate: 1_500_000,   // 1.5 Mbps per publisher — suitable for 640×480 mobile
      initialAvailableOutgoingBitrate: 1_000_000,
    },
  },
};
