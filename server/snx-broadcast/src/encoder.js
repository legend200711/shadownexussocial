/**
 * snx-broadcast/src/encoder.js
 *
 * FFmpeg-based encoder/compositor — Stage 4B.
 *
 * Produces a continuous 1280×720 30fps H.264 / AAC stereo stream.
 * Supports multiple RTMP/RTMPS destinations simultaneously via the
 * FFmpeg `tee` muxer: one encode, N outputs.
 *
 * Auto-recovery:
 *   - If FFmpeg exits unexpectedly, the encoder attempts a bounded restart.
 *   - Restarts use exponential backoff (1s, 2s, 4s, 8s, 16s, max 60s).
 *   - After MAX_RESTARTS consecutive failures the encoder stops trying and
 *     emits 'fatal'.
 *   - A successful run resets the restart counter.
 *
 * Multiple destinations:
 *   - All enabled destinations receive the SAME encoded stream.
 *   - Output uses FFmpeg -f tee with pipe-separated destination URLs.
 *   - If one destination fails at the RTMP level FFmpeg reports an error;
 *     the encoder will restart and retry all destinations.
 *
 * Track transitions:
 *   - When the Radio source advances a track, updateTrack() is called.
 *   - The encoder spawns a new FFmpeg process seeked to the correct position.
 *   - The RTMP connections are re-established per-track (< 1s gap typical).
 *   - The broadcast does NOT stop between songs.
 *
 * Video:
 *   H.264 (libx264), 1280×720, 30fps, 2500k, preset veryfast
 *   Visual layer: dark brand background + album artwork overlay + drawtext
 *
 * Audio:
 *   AAC, 160k, 44100 Hz, stereo
 *   Source: HTTP audio URL seeked to current position
 *
 * SECURITY:
 *   RTMP URLs (containing stream keys) are passed to FFmpeg as process
 *   arguments — they appear in /proc/{pid}/cmdline on Linux.
 *   We use FFMPEG_PATH env to locate ffmpeg; the process is managed
 *   entirely server-side and never exposed to the browser.
 *   Stream keys are NEVER logged (not even masked) in encoder.js.
 */

'use strict';

const { spawn }   = require('child_process');
const path        = require('path');
const { EventEmitter } = require('events');
const config      = require('./config');

const enc = config.encoder;

// Auto-recovery constants
const MAX_RESTARTS      = 8;
const BASE_BACKOFF_MS   = 1_000;
const MAX_BACKOFF_MS    = 60_000;

// ── EncoderProcess ────────────────────────────────────────────────────────────

class EncoderProcess extends EventEmitter {
  constructor() {
    super();
    this._proc           = null;     // ChildProcess
    this._running        = false;
    this._currentTrack   = null;
    this._destinations   = [];       // [{ id, name, serverUrl, streamKey }]
    this._restartCount   = 0;
    this._restartTimer   = null;
    this._debounceTimer  = null;
    this._pid            = null;
    this._startedAt      = null;
    this._lastError      = null;
    this._lastExitCode   = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start encoding to all provided destinations.
   * @param {Array<{id,name,serverUrl,streamKey}>} destinations
   * @param {object} track   { title, artist, audioUrl, artworkUrl, duration }
   * @param {number} positionSec
   */
  start(destinations, track, positionSec = 0) {
    if (this._running) this._kill();
    if (!destinations || destinations.length === 0) {
      throw new Error('No destinations provided to encoder');
    }
    this._destinations = destinations;
    this._currentTrack = track;
    this._running      = true;
    this._restartCount = 0;
    this._lastError    = null;
    this._spawn(track, positionSec);
  }

  /**
   * Update the current track (called on track transitions).
   * Debounced 200ms to avoid rapid double-triggers.
   */
  updateTrack(track, positionSec = 0) {
    if (!this._running) return;
    this._currentTrack = track;
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (this._running) {
        console.log('[ENCODER] Track transition →',
          track.title, 'by', track.artist,
          '| seek:', positionSec.toFixed(1) + 's');
        this._spawn(track, positionSec);
      }
    }, 200);
  }

  /**
   * Stop the encoder cleanly.
   */
  stop() {
    this._running = false;
    this._cancelRetry();
    this._kill();
    this._pid       = null;
    this._startedAt = null;
    this._destinations = [];
    console.log('[ENCODER] Stopped');
    this.emit('stopped');
  }

  get isRunning()    { return this._running; }
  get pid()          { return this._pid; }
  get startedAt()    { return this._startedAt; }
  get restartCount() { return this._restartCount; }
  get lastError()    { return this._lastError; }

  /**
   * Return a safe status object (no stream keys, no URLs with keys).
   */
  getStatus() {
    return {
      running:        this._running,
      pid:            this._pid,
      startedAt:      this._startedAt,
      restartCount:   this._restartCount,
      lastError:      this._lastError,
      lastExitCode:   this._lastExitCode,
      destinationCount: this._destinations.length,
      destinationNames: this._destinations.map(d => d.name),
      currentTrack: this._currentTrack ? {
        title:  this._currentTrack.title,
        artist: this._currentTrack.artist,
      } : null,
    };
  }

  // ── Private: spawn ──────────────────────────────────────────────────────────

  _spawn(track, positionSec) {
    this._kill();   // kill any existing process first

    const { title, artist, audioUrl, artworkUrl } = track || {};
    const seek = Math.max(0, positionSec || 0);

    if (!audioUrl) {
      this._lastError = 'Track has no audioUrl';
      console.error('[ENCODER] Cannot spawn: track has no audioUrl');
      this._scheduleRestart(track, 0);
      return;
    }

    // ── Build FFmpeg arguments directly (not fluent-ffmpeg) ──────────────────
    // We use child_process.spawn so stream keys never appear in logged strings.

    const args = [];

    // Global flags
    args.push('-hide_banner', '-loglevel', 'warning');

    // ── Inputs ──────────────────────────────────────────────────────────────

    // Audio input: HTTP URL seeked to current position
    if (seek > 1) {
      args.push('-ss', seek.toFixed(3));
    }
    args.push('-reconnect', '1', '-reconnect_streamed', '1',
              '-reconnect_delay_max', '5');
    args.push('-i', audioUrl);

    // Artwork image input (if available)
    if (artworkUrl) {
      args.push('-loop', '1', '-r', String(enc.fps), '-i', artworkUrl);
    }

    // Lavfi background
    args.push('-f', 'lavfi',
              '-i', `color=c=0x0d0d1a:s=${enc.width}x${enc.height}:r=${enc.fps}`);

    // ── Video filter graph ─────────────────────────────────────────────────

    const safeTitle  = _escapeDrawtext(title  || 'Unknown');
    const safeArtist = _escapeDrawtext(artist || '');
    const safeName   = 'SHADOW NEXUS RADIO';
    const fontFile   = enc.fontFile;

    // Input indices:
    //   0 = audio (HTTP)
    //   1 = artwork image (if present)
    //   N = lavfi background
    const bgIdx = artworkUrl ? 2 : 1;

    let vf;
    if (artworkUrl) {
      // artwork at [1], bg at [2]
      vf = [
        `[1:v]scale=400:400:force_original_aspect_ratio=decrease,` +
        `pad=400:400:(ow-iw)/2:(oh-ih)/2:color=0x1a1a2e[art]`,
        `[${bgIdx}:v]` +
        `drawtext=fontfile='${fontFile}':text='${safeName}':` +
        `fontcolor=0x00aeef:fontsize=28:x=(w-text_w)/2:y=80:` +
        `shadowcolor=0x000000aa:shadowx=2:shadowy=2` +
        `[bgtext]`,
        `[bgtext][art]overlay=440:160[withArt]`,
        `[withArt]` +
        `drawtext=fontfile='${fontFile}':text='NOW PLAYING':` +
        `fontcolor=0xaaaaaa:fontsize=16:x=(w-text_w)/2:y=590:` +
        `shadowcolor=0x000000aa:shadowx=1:shadowy=1,` +
        `drawtext=fontfile='${fontFile}':text='${safeTitle}':` +
        `fontcolor=0xffffff:fontsize=34:x=(w-text_w)/2:y=622:` +
        `shadowcolor=0x000000cc:shadowx=2:shadowy=2,` +
        `drawtext=fontfile='${fontFile}':text='${safeArtist}':` +
        `fontcolor=0xcccccc:fontsize=22:x=(w-text_w)/2:y=668:` +
        `shadowcolor=0x000000aa:shadowx=1:shadowy=1` +
        `[v]`,
      ].join(';');
    } else {
      vf = [
        `[${bgIdx}:v]` +
        `drawtext=fontfile='${fontFile}':text='${safeName}':` +
        `fontcolor=0x00aeef:fontsize=32:x=(w-text_w)/2:y=240:` +
        `shadowcolor=0x000000aa:shadowx=2:shadowy=2,` +
        `drawtext=fontfile='${fontFile}':text='\\u266a':` +
        `fontcolor=0x004488:fontsize=180:x=(w-text_w)/2:y=260,` +
        `drawtext=fontfile='${fontFile}':text='NOW PLAYING':` +
        `fontcolor=0xaaaaaa:fontsize=16:x=(w-text_w)/2:y=590:` +
        `shadowcolor=0x000000aa:shadowx=1:shadowy=1,` +
        `drawtext=fontfile='${fontFile}':text='${safeTitle}':` +
        `fontcolor=0xffffff:fontsize=34:x=(w-text_w)/2:y=622:` +
        `shadowcolor=0x000000cc:shadowx=2:shadowy=2,` +
        `drawtext=fontfile='${fontFile}':text='${safeArtist}':` +
        `fontcolor=0xcccccc:fontsize=22:x=(w-text_w)/2:y=668:` +
        `shadowcolor=0x000000aa:shadowx=1:shadowy=1` +
        `[v]`,
      ].join(';');
    }

    args.push('-filter_complex', vf);

    // ── Output mapping + codec ──────────────────────────────────────────────

    args.push(
      '-map', '[v]',
      '-map', '0:a',
      '-c:v', enc.videoCodec,
      '-b:v', enc.videoBitrate,
      '-preset', enc.videoPreset,
      '-profile:v', enc.videoProfile,
      '-level:v', enc.videoLevel,
      '-r', String(enc.fps),
      '-g', String(enc.fps * 2),
      '-keyint_min', String(enc.fps),
      '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p',
      '-c:a', enc.audioCodec,
      '-b:a', enc.audioBitrate,
      '-ar', String(enc.audioRate),
      '-ac', String(enc.audioChannels),
      '-bufsize', '4000k',
      '-maxrate', enc.videoBitrate,
    );

    // ── Multi-destination output using FFmpeg tee muxer ─────────────────────
    //
    // Format: -f tee "[f=flv]rtmp://dest1|[f=flv]rtmp://dest2"
    // Each destination gets its full URL (serverUrl/streamKey).
    // Stream keys are passed only as process arguments — never logged.

    if (this._destinations.length === 1) {
      // Single destination — plain FLV output
      const d   = this._destinations[0];
      const url = d.serverUrl.replace(/\/+$/, '') + '/' + d.streamKey;
      args.push('-f', 'flv', url);
    } else {
      // Multiple destinations — tee muxer
      const teeSpec = this._destinations
        .map(d => `[f=flv]${d.serverUrl.replace(/\/+$/, '')}/${d.streamKey}`)
        .join('|');
      args.push('-f', 'tee', teeSpec);
    }

    // ── Spawn ──────────────────────────────────────────────────────────────

    const bin = enc.ffmpegPath || 'ffmpeg';
    console.log('[ENCODER] Spawning FFmpeg — destinations:', this._destinations.map(d => d.name).join(', '));
    // NOTE: We intentionally do NOT log the full args array because it
    //       contains stream keys in the output URLs.

    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this._proc      = proc;
    this._pid       = proc.pid;
    this._startedAt = Date.now();

    proc.stdout.on('data', () => {});  // suppress stdout (ffmpeg writes stats to stderr)

    proc.stderr.on('data', buf => {
      const line = buf.toString().trim();
      if (!line) return;
      // Only log non-key FFmpeg lines (avoid logging mux URLs)
      if (line.includes('Output #') || line.includes('Stream mapping') ||
          line.includes('frame=') || line.includes('fps=') ||
          line.includes('bitrate=') || line.includes('[error]') ||
          line.includes('[warning]') || line.includes('Connection refused') ||
          line.includes('broken pipe') || line.includes('Invalid data') ||
          line.includes('No such file') || line.includes('Error')) {
        // Sanitize: remove any line that might contain a stream key
        const safe = _sanitizeLogLine(line);
        if (safe) console.log('[ENCODER/ffmpeg]', safe);
      }
    });

    proc.on('spawn', () => {
      console.log('[ENCODER] FFmpeg spawned — pid:', proc.pid);
      this.emit('started', { pid: proc.pid, destinations: this._destinations.map(d => d.name) });
    });

    proc.on('error', err => {
      this._lastError = err.message;
      console.error('[ENCODER] FFmpeg spawn error:', err.message);
      this.emit('error', err.message);
      if (this._running) this._scheduleRestart(this._currentTrack, 0);
    });

    proc.on('close', (code, signal) => {
      this._lastExitCode = code;
      this._proc = null;
      this._pid  = null;

      if (!this._running) return;  // intentional stop

      if (code === 0) {
        // Clean exit (track ended naturally)
        // The broadcast-manager tick will call updateTrack() for the next track.
        // If not called within 3s, restart the same track from pos 0.
        console.log('[ENCODER] FFmpeg exited cleanly (code 0) — awaiting next track signal');
        setTimeout(() => {
          if (this._running && !this._proc && this._currentTrack) {
            console.log('[ENCODER] No track update received — restarting current track');
            this._restartCount = 0;  // clean exit resets backoff
            this._spawn(this._currentTrack, 0);
          }
        }, 3_000);
      } else {
        // Unexpected exit
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        this._lastError = `FFmpeg exited: ${reason}`;
        console.error('[ENCODER] FFmpeg unexpected exit:', reason, '— restart', this._restartCount + 1, '/', MAX_RESTARTS);
        this.emit('crash', { code, signal, restartCount: this._restartCount });
        this._scheduleRestart(this._currentTrack, 0);
      }
    });
  }

  // ── Private: auto-recovery ──────────────────────────────────────────────────

  _scheduleRestart(track, positionSec) {
    if (!this._running) return;
    this._restartCount++;

    if (this._restartCount > MAX_RESTARTS) {
      this._running   = false;
      this._lastError = `Max restarts (${MAX_RESTARTS}) exceeded — encoder stopped`;
      console.error('[ENCODER] FATAL:', this._lastError);
      this.emit('fatal', this._lastError);
      return;
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s cap
    const backoffMs = Math.min(BASE_BACKOFF_MS * Math.pow(2, this._restartCount - 1), MAX_BACKOFF_MS);
    console.log('[ENCODER] Auto-restart', this._restartCount, '/', MAX_RESTARTS,
      'in', (backoffMs / 1000).toFixed(1) + 's');

    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._running && track) {
        this._spawn(track, positionSec);
      }
    }, backoffMs);

    this.emit('restartScheduled', { attempt: this._restartCount, backoffMs });
  }

  _cancelRetry() {
    if (this._restartTimer)  { clearTimeout(this._restartTimer);  this._restartTimer  = null; }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); this._debounceTimer = null; }
  }

  _kill() {
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch (_) {}
      // Give SIGTERM 2s then force kill
      const p = this._proc;
      setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 2_000);
      this._proc = null;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Escape a string for use inside ffmpeg drawtext filter value.
 * Characters that must be escaped: ' : \ , [ ]
 */
function _escapeDrawtext(str) {
  if (!str) return '';
  return String(str)
    .slice(0, 60)
    .replace(/\\/g, '\\\\')
    .replace(/'/g,  "\\'")
    .replace(/:/g,  '\\:')
    .replace(/,/g,  '\\,')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

/**
 * Sanitize a log line to ensure it cannot contain stream keys.
 * We redact anything that looks like a URL path that follows /live2/ or /app/
 * to prevent key leakage if FFmpeg ever echoes its own output arguments.
 */
function _sanitizeLogLine(line) {
  // Redact URLs that might contain stream keys
  let s = line.replace(/(rtmps?:\/\/[^\s'"]*\/[^\s'"]{4,})/gi, '[rtmp-url-redacted]');
  // Redact long alphanumeric strings that look like stream keys (>16 chars, no spaces)
  s = s.replace(/\b([a-zA-Z0-9_-]{20,})\b/g, (m) => {
    // Keep known safe patterns (hex, timestamps)
    if (/^\d+$/.test(m)) return m;
    return '[redacted]';
  });
  return s;
}

/**
 * Probe whether ffmpeg is available on this system.
 * @returns {Promise<{ok:boolean, version:string|null, error:string|null}>}
 */
function probeFFmpeg() {
  return new Promise((resolve) => {
    const bin  = config.encoder.ffmpegPath || 'ffmpeg';
    const proc = spawn(bin, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });

    let output = '';
    proc.stdout.on('data', buf => { output += buf.toString(); });

    proc.on('error', err => resolve({ ok: false, version: null, error: err.message }));
    proc.on('close', code => {
      if (code === 0 && output) {
        const match = output.match(/ffmpeg version ([^\s]+)/);
        resolve({ ok: true, version: match ? match[1] : 'unknown', error: null });
      } else {
        resolve({ ok: false, version: null, error: `exit code ${code}` });
      }
    });
  });
}

module.exports = { EncoderProcess, probeFFmpeg };
