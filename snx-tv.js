/**
 * snx-tv.js
 * Shadow Nexus Social — 24-Hour TV Network
 * Build: SNS-2026-TV-LIBRARY-001
 *
 * Exposes: window.SNXTv
 *
 * Architecture:
 *   - Channels stored in Firestore /tv_channels/{channelId}
 *   - Central media library in Firestore /tv_library/{mediaId}  (no channelId)
 *   - Channel assignments in Firestore /tv_channel_items/{itemId}
 *       { channelId, mediaId, order, addedAt }
 *   - Legacy /tv_media/{mediaId} docs still played if present (backward compat)
 *   - Playback: builds queue from tv_channel_items → resolves via tv_library
 *   - Uploads via POST /tv/upload-media-library on the Cloudflare Worker
 *   - Founder authentication: window._snxRole === 'founder'
 *
 * Safety:
 *   - Does NOT touch Radio, Live, Shadow Reaper, or any other SNS feature.
 *   - Does NOT create a second Firebase app.
 *   - Does NOT pause/interfere with Feed media (data-snx-media-exempt on TV video).
 *   - Fully removable without affecting anything else.
 */

'use strict';

(function (global) {

  /* ════════════════════════════════════════════════════════════
     CONSTANTS
  ════════════════════════════════════════════════════════════ */

  const BUILD  = 'SNS-2026-TV-STATION-001';
  const WORKER = 'https://yellow-term-11e6.nthntjrn.workers.dev';
  const LOG    = '[SNX-TV]';

  /* Firestore collection names */
  const COL_CHANNELS     = 'tv_channels';
  const COL_LIBRARY      = 'tv_library';        // central media library
  const COL_CH_ITEMS     = 'tv_channel_items';  // channel ↔ media assignments
  const COL_MEDIA_LEGACY = 'tv_media';          // legacy — read-only for backward compat

  /* Media kind → emoji */
  const KIND_ICON = { video: '🎬', audio: '🎵', image: '🖼' };

  /* ════════════════════════════════════════════════════════════
     STATE
  ════════════════════════════════════════════════════════════ */

  let _channels      = [];
  let _activeChannel = null;
  let _mediaQueue    = [];   // resolved media objects for active channel
  let _queueIdx      = 0;
  let _playing       = false;
  let _autoplayBlocked = false;
  let _channelsUnsub   = null;
  let _chItemsUnsub    = null;  // assignment listener for active channel
  let _libraryCache    = {};    // mediaId → media doc (avoids redundant reads)

  /* HUD / playback state */
  // States: 'waiting' | 'loading' | 'playing' | 'paused' | 'blocked' | 'ended' | 'failed'
  let _playState = 'waiting';

  /* Studio state */
  let _studioOpen    = false;
  let _studioTab     = 'library';  // 'library' | 'channels'
  let _studioChannel = null;       // channel selected inside channel-content tab
  let _libraryAll    = [];         // all tv_library docs (real-time)
  let _libraryUnsub  = null;
  let _libFilter     = 'all';      // 'all' | 'audio' | 'video' | 'image'
  let _libSearch     = '';
  let _libSelected   = new Set();  // selected mediaIds in library
  let _chContentItems = [];        // tv_channel_items for _studioChannel
  let _chContentUnsub = null;
  let _studioMediaUnsub = null;    // alias kept for legacy cleanup

  /* Preview */
  let _previewOpen = false;

  /* ════════════════════════════════════════════════════════════
     FIREBASE HELPERS — wraps window._snxFirestore (modular v12)
  ════════════════════════════════════════════════════════════ */

  function _fs() { return global._snxFirestore || {}; }

  function _fsCollection(colName) {
    const { db, collection } = _fs();
    return collection(db, colName);
  }

  function _fsDoc(colName, id) {
    const { db, doc } = _fs();
    return doc(db, colName, id);
  }

  function _fsQuery(col, ...constraints) {
    const { query } = _fs();
    return query(col, ...constraints);
  }

  function _fsOrderBy(field, dir) {
    const { orderBy } = _fs();
    return orderBy(field, dir || 'asc');
  }

  function _fsWhere(field, op, val) {
    const { where } = _fs();
    return where(field, op, val);
  }

  async function _fsGetDocs(q) {
    const { getDocs } = _fs();
    return getDocs(q);
  }

  async function _fsSetDoc(ref, data, opts) {
    const { setDoc } = _fs();
    return setDoc(ref, data, opts || {});
  }

  async function _fsUpdateDoc(ref, data) {
    const { updateDoc } = _fs();
    return updateDoc(ref, data);
  }

  async function _fsDeleteDoc(ref) {
    const { deleteDoc } = _fs();
    return deleteDoc(ref);
  }

  async function _fsAddDoc(col, data) {
    const { addDoc } = _fs();
    return addDoc(col, data);
  }

  function _fsOnSnapshot(ref, cb, onErr) {
    const { onSnapshot } = _fs();
    if (onSnapshot) return onSnapshot(ref, cb, onErr || undefined);
    return () => {};
  }

  function _fsServerTimestamp() {
    const { serverTimestamp } = _fs();
    return serverTimestamp ? serverTimestamp() : Date.now();
  }

  /* ════════════════════════════════════════════════════════════
     AUTH HELPERS
  ════════════════════════════════════════════════════════════ */

  function _isFounder() {
    return global._snxRole === 'founder';
  }

  function _getIdToken() {
    const authInst = global.auth || global._snxAuth;
    const user = authInst && authInst.currentUser;
    if (!user) return Promise.reject(new Error('Not authenticated'));
    return user.getIdToken();
  }

  /* ════════════════════════════════════════════════════════════
     DOM HELPERS
  ════════════════════════════════════════════════════════════ */

  function _el(id) { return document.getElementById(id); }
  function _setHtml(id, html) { const e = _el(id); if (e) e.innerHTML = html; }
  function _show(id) { const e = _el(id); if (e) e.style.display = ''; }
  function _hide(id) { const e = _el(id); if (e) e.style.display = 'none'; }

  function _showStatus(id, msg, type) {
    const el = _el(id);
    if (!el) return;
    el.textContent = msg;
    el.className = 'snx-tv-status visible ' + (type || 'info');
    if (type === 'ok') setTimeout(() => el.classList.remove('visible'), 4000);
  }

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* HTML-attribute-safe JSON: embeds a value inside a double-quoted onclick/onchange
     attribute.  JSON.stringify wraps strings in ", which would break the HTML parser.
     Replacing " with &quot; lets the parser decode it correctly back to ". */
  function _json(val) { return JSON.stringify(val).replace(/"/g, '&quot;'); }

  /* ════════════════════════════════════════════════════════════
     CHANNELS — subscribe & render guide
  ════════════════════════════════════════════════════════════ */

  function _subscribeChannels() {
    if (_channelsUnsub) { _channelsUnsub(); _channelsUnsub = null; }

    const col = _fsCollection(COL_CHANNELS);
    const q   = _fsQuery(col, _fsOrderBy('order', 'asc'));

    _channelsUnsub = _fsOnSnapshot(q, snap => {
      try {
        _channels = [];
        snap.forEach(d => _channels.push({ id: d.id, ...d.data() }));
        _channels.sort((a, b) => (a.order || 0) - (b.order || 0));
        _renderGuide();
        _renderStudioChannelList();
        _renderChContentChannelPicker();
        if (!_activeChannel && _channels.length > 0) {
          _selectChannel(_channels[0].id);
        }
      } catch (e) {
        console.warn(LOG, 'channels snapshot error', e);
        _showGuideError('Could not load channels.');
      }
    }, err => {
      console.warn(LOG, 'channels snapshot error', err);
      _showGuideError(
        err && err.code === 'permission-denied'
          ? 'Sign in to view channels.'
          : 'Could not load channels. Please refresh.'
      );
    });
  }

  function _showGuideError(msg) {
    const grid = _el('snxTvGuideGrid');
    if (grid) grid.innerHTML = '<div style="color:#3a6a9a;font-size:13px;padding:10px 2px;">' + msg + '</div>';
  }

  /* ════════════════════════════════════════════════════════════
     CENTRAL MEDIA LIBRARY — subscribe (founder only)
  ════════════════════════════════════════════════════════════ */

  function _subscribeLibrary() {
    if (_libraryUnsub) return; // already subscribed

    const col = _fsCollection(COL_LIBRARY);
    const q   = _fsQuery(col, _fsOrderBy('createdAt', 'desc'));

    _libraryUnsub = _fsOnSnapshot(q, snap => {
      _libraryAll = [];
      snap.forEach(d => {
        const item = { id: d.id, ...d.data() };
        _libraryAll.push(item);
        _libraryCache[item.id] = item; // keep cache fresh
      });
      _renderLibrary();
    }, err => {
      console.warn(LOG, 'library snapshot error', err);
    });
  }

  function _unsubscribeLibrary() {
    if (_libraryUnsub) { _libraryUnsub(); _libraryUnsub = null; }
  }

  /* ════════════════════════════════════════════════════════════
     PLAYBACK — subscribe to channel items, resolve library docs
  ════════════════════════════════════════════════════════════ */

  function _subscribeChannelItems(channelId) {
    if (_chItemsUnsub) { _chItemsUnsub(); _chItemsUnsub = null; }
    _mediaQueue = [];
    _queueIdx   = 0;

    const col = _fsCollection(COL_CH_ITEMS);
    const q   = _fsQuery(col,
      _fsWhere('channelId', '==', channelId),
      _fsOrderBy('order', 'asc')
    );

    _chItemsUnsub = _fsOnSnapshot(q, async snap => {
      try {
        const items = [];
        snap.forEach(d => items.push({ _assignId: d.id, ...d.data() }));
        items.sort((a, b) => (a.order || 0) - (b.order || 0));

        // Resolve each assignment to its full media doc
        const resolved = [];
        for (const item of items) {
          const mediaId = item.mediaId;
          if (!mediaId) continue;
          let media = _libraryCache[mediaId];
          if (!media) {
            // fetch once and cache
            try {
              const { getDoc } = _fs();
              const docSnap = await getDoc(_fsDoc(COL_LIBRARY, mediaId));
              if (docSnap.exists()) {
                media = { id: docSnap.id, ...docSnap.data() };
                _libraryCache[mediaId] = media;
              }
            } catch (_) { /* skip unresolvable */ }
          }
          if (media) {
            resolved.push({ ...media, _assignId: item._assignId, _order: item.order });
          }
        }

        // If no new-style items, try legacy tv_media for backward compat
        if (resolved.length === 0) {
          _subscribeLegacyMedia(channelId);
          return;
        }

        _mediaQueue = resolved;
        _onMediaQueueUpdated();
      } catch (e) {
        console.warn(LOG, 'channel items snapshot error', e);
      }
    }, err => {
      console.warn(LOG, 'channel items error', err);
      // Fall back to legacy collection
      _subscribeLegacyMedia(channelId);
    });
  }

  /* Legacy fallback: reads tv_media where channelId == channelId */
  function _subscribeLegacyMedia(channelId) {
    if (_studioMediaUnsub) { _studioMediaUnsub(); _studioMediaUnsub = null; }

    const col = _fsCollection(COL_MEDIA_LEGACY);
    const q   = _fsQuery(col,
      _fsWhere('channelId', '==', channelId),
      _fsOrderBy('order', 'asc')
    );

    _studioMediaUnsub = _fsOnSnapshot(q, snap => {
      const items = [];
      snap.forEach(d => items.push({ id: d.id, ...d.data() }));
      items.sort((a, b) => (a.order || 0) - (b.order || 0));
      _mediaQueue = items;
      _onMediaQueueUpdated();
    });
  }

  function _onMediaQueueUpdated() {
    if (_mediaQueue.length === 0) { _showWaiting(); return; }
    _clearWaiting();
    if (!_playing) {
      _queueIdx = 0;
      _playItem(_mediaQueue[0]);
    }
  }

  /* ════════════════════════════════════════════════════════════
     CHANNEL SELECTION
  ════════════════════════════════════════════════════════════ */

  function _selectChannel(channelId) {
    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;

    _stopPlayback();
    _activeChannel = ch;

    document.querySelectorAll('.snx-tv-channel-card').forEach(el => {
      el.classList.toggle('active-channel', el.dataset.chId === channelId);
    });

    const badge = _el('snxTvChannelBadge');
    if (badge) badge.textContent = ch.name;

    _subscribeChannelItems(channelId);
  }

  /* ════════════════════════════════════════════════════════════
     PLAYBACK ENGINE
  ════════════════════════════════════════════════════════════ */

  function _getVideoEl() { return _el('snxTvVideo'); }
  function _getAudioEl() { return _el('snxTvAudio'); }

  function _stopPlayback() {
    _playing = false;
    const vid = _getVideoEl();
    const aud = _getAudioEl();
    if (vid) { try { vid.pause(); vid.removeAttribute('src'); vid.load(); } catch (_) {} }
    if (aud) { try { aud.pause(); aud.removeAttribute('src'); aud.load(); } catch (_) {} }

    // CRITICAL: aud.removeAttribute('src') + aud.load() internally resets the
    // browser's media pipeline.  The existing MediaElementAudioSourceNode
    // (_vizSource) becomes stale — its internal connection to the element is
    // broken.  If we reuse it on the next track, the audio plays into a dead
    // graph and produces silence.  Null it out so _startVizAnimation always
    // creates a fresh source node for the next track.
    if (_vizSource) { try { _vizSource.disconnect(); } catch (_) {} }
    _vizSource = null;

    _hideVisualizer();
    _setPlayState('waiting');
    _resetHud();
  }

  function _playItem(item) {
    if (!item) { _showWaiting(); return; }
    _playing = true;
    _clearWaiting();
    _resetHud();
    _setPlayState('loading');

    const vid = _getVideoEl();
    const aud = _getAudioEl();

    _renderNowPlaying(item);

    if (item.mediaKind === 'video') {
      _hideVisualizer();
      if (!vid) return;
      vid.style.display = 'block';
      vid.setAttribute('data-snx-media-exempt', '1');
      vid.muted = false;
      vid.src = item.url;
      vid.load();
      console.log(LOG, 'playing video', item.title || item.fileName, item.url);
      _tryPlay(vid);
    } else if (item.mediaKind === 'audio') {
      if (!aud) return;
      if (vid) vid.style.display = 'none';
      aud.muted = false;
      aud.volume = aud.volume > 0 ? aud.volume : 1;
      // crossOrigin must be set BEFORE src — required for createMediaElementSource
      // to receive cross-origin audio data through the Web Audio graph.
      // Without this the browser fetches the file as an opaque non-CORS response
      // and the AudioContext cannot read its decoded audio, producing silence.
      aud.crossOrigin = 'anonymous';
      aud.src = item.url;
      aud.load();
      console.log(LOG, 'playing audio', item.title || item.fileName, item.url);
      _showVisualizer(item);
      _tryPlay(aud);
    } else if (item.mediaKind === 'image') {
      _stopPlayback();
      _playing = true;
      _showImageItem(item);
      _setPlayState('playing');
      setTimeout(_advanceQueue, 10000);
    }
  }

  function _tryPlay(mediaEl) {
    // Resume a suspended AudioContext in a play attempt (may be inside a user gesture)
    if (_vizAudioCtx && _vizAudioCtx.state === 'suspended') {
      _vizAudioCtx.resume().catch(() => {});
    }
    const p = mediaEl.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        _autoplayBlocked = false;
        _hidePlayOverlay();
        // state transitions via the 'playing' event listener
      }).catch(err => {
        if (err.name === 'NotAllowedError') {
          _autoplayBlocked = true;
          _setPlayState('blocked');
          _showPlayOverlay();
        } else {
          // Do NOT mute — log the error and show the overlay so the user can retry
          console.warn(LOG, 'play error', err.name, err.message);
          _autoplayBlocked = true;
          _setPlayState('blocked');
          _showPlayOverlay();
        }
      });
    }
  }

  function _advanceQueue() {
    if (_mediaQueue.length === 0) { _showWaiting(); return; }
    _queueIdx = (_queueIdx + 1) % _mediaQueue.length;
    _playItem(_mediaQueue[_queueIdx]);
  }

  function _showWaiting() {
    _playing = false;
    const vid = _getVideoEl();
    if (vid) vid.style.display = 'none';
    _hideVisualizer();
    _setPlayState('waiting');
    _resetHud();
    const wrap = _el('snxTvPlayerInner');
    if (wrap && !wrap.querySelector('.snx-tv-waiting')) {
      const w = document.createElement('div');
      w.className = 'snx-tv-waiting';
      w.innerHTML =
        '<div class="snx-tv-waiting-icon">📺</div>' +
        '<div class="snx-tv-waiting-text">No content on this channel.<br>' +
        (_isFounder() ? 'Open TV Studio → Media Library to add media.' : 'Check back soon.') +
        '</div>';
      wrap.appendChild(w);
    }
    _renderNowPlaying(null);
  }

  function _clearWaiting() {
    const wrap = _el('snxTvPlayerInner');
    if (!wrap) return;
    const w = wrap.querySelector('.snx-tv-waiting');
    if (w) w.remove();
  }

  function _showImageItem(item) {
    const vid = _getVideoEl();
    if (vid) vid.style.display = 'none';
    _hideVisualizer();
    _clearWaiting();
    const wrap = _el('snxTvPlayerInner');
    if (!wrap) return;
    let img = wrap.querySelector('.snx-tv-image-item');
    if (!img) {
      img = document.createElement('img');
      img.className = 'snx-tv-image-item';
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
      wrap.appendChild(img);
    }
    img.src = item.url;
    img.alt = item.title || 'TV artwork';
  }

  function _clearImageItem() {
    const wrap = _el('snxTvPlayerInner');
    if (!wrap) return;
    const img = wrap.querySelector('.snx-tv-image-item');
    if (img) img.remove();
  }

  /* ════════════════════════════════════════════════════════════
     VISUALIZER
  ════════════════════════════════════════════════════════════ */

  let _vizAudioCtx = null;
  let _vizSource   = null;
  let _vizAnalyser = null;
  let _vizFrame    = null;
  let _vizRunning  = false;

  function _showVisualizer(item) {
    _clearWaiting();
    _clearImageItem();
    const canvas  = _el('snxTvVisualizer');
    const overlay = _el('snxTvVizOverlay');
    if (!canvas) return;

    if (item.artworkUrl) {
      canvas.classList.remove('active');
      const wrap = _el('snxTvPlayerInner');
      if (wrap) {
        let img = wrap.querySelector('.snx-tv-image-item');
        if (!img) {
          img = document.createElement('img');
          img.className = 'snx-tv-image-item';
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
          wrap.appendChild(img);
        }
        img.src = item.artworkUrl;
        img.alt = item.title || 'Album artwork';
      }
    } else {
      canvas.classList.add('active');
    }

    if (overlay) {
      overlay.querySelector('.snx-tv-viz-title').textContent  = item.title  || 'Unknown Track';
      overlay.querySelector('.snx-tv-viz-artist').textContent = item.artist || '';
    }

    _startVizAnimation(canvas);
  }

  function _hideVisualizer() {
    const canvas = _el('snxTvVisualizer');
    if (canvas) canvas.classList.remove('active');
    _stopVizAnimation();
    _clearImageItem();
  }

  function _startVizAnimation(canvas) {
    if (_vizRunning) return;
    _vizRunning = true;
    const aud = _getAudioEl();
    if (!canvas || !aud) return;

    // Wire up Web Audio only once per audio element instance.
    // createMediaElementSource() can only be called once per element per context —
    // _vizSource is nulled by _stopPlayback on every channel/track switch, so
    // needsWire is true on every new track.  This ensures createMediaElementSource
    // is called exactly once per playback session, never twice on the same element.
    const needsWire = !_vizSource;
    console.log(LOG, 'viz wire check: needsWire=' + needsWire + ' src=' + (!!_vizSource) + ' aud.src=' + (aud.src || '(none)'));
    if (needsWire) {
      try {
        if (!_vizAudioCtx) {
          _vizAudioCtx = new (global.AudioContext || global.webkitAudioContext)();
        }
        // Clean up any orphaned analyser from a failed previous wire
        if (_vizAnalyser) { try { _vizAnalyser.disconnect(); } catch (_) {} _vizAnalyser = null; }

        _vizSource   = _vizAudioCtx.createMediaElementSource(aud);
        _vizAnalyser = _vizAudioCtx.createAnalyser();
        _vizAnalyser.fftSize = 128;
        // source → analyser → destination (speakers).  Both visualizer bars AND
        // audio output flow through this graph.
        _vizSource.connect(_vizAnalyser);
        _vizAnalyser.connect(_vizAudioCtx.destination);
        console.log(LOG, 'Web Audio graph wired. ctx.state=' + _vizAudioCtx.state
          + ' src.mediaElement==aud=' + (_vizSource.mediaElement === aud));
      } catch (e) {
        // createMediaElementSource threw (e.g. already connected in another context).
        // Null everything — HTML5 audio continues without Web Audio; visualizer
        // shows the fallback sine-wave animation instead of frequency bars.
        console.warn(LOG, 'AudioContext setup error (visualizer disabled):', e.message);
        _vizSource   = null;
        _vizAnalyser = null;
      }
    }

    // Resume a suspended context (browsers start AudioContext suspended until a
    // user gesture has occurred).
    if (_vizAudioCtx && _vizAudioCtx.state === 'suspended') {
      console.log(LOG, 'AudioContext suspended — resuming...');
      _vizAudioCtx.resume().then(() => {
        console.log(LOG, 'AudioContext resumed; state=' + _vizAudioCtx.state);
      }).catch(err => {
        console.warn(LOG, 'AudioContext resume failed:', err.message);
      });
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) { _vizRunning = false; return; }

    function draw() {
      if (!_vizRunning) return;
      _vizFrame = requestAnimationFrame(draw);
      const W = canvas.width  = canvas.offsetWidth  || 320;
      const H = canvas.height = canvas.offsetHeight || 180;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#020812';
      ctx.fillRect(0, 0, W, H);
      if (_vizAnalyser) {
        const data = new Uint8Array(_vizAnalyser.frequencyBinCount);
        _vizAnalyser.getByteFrequencyData(data);
        const barW = W / data.length * 2.5;
        data.forEach((v, i) => {
          const h = (v / 255) * H * 0.85;
          const x = i * (barW + 1);
          const alpha = 0.3 + (v / 255) * 0.7;
          ctx.fillStyle = `rgba(0,${100 + v * 0.6},${200 + v * 0.2},${alpha})`;
          ctx.fillRect(x, H - h, barW, h);
        });
      } else {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(0,174,239,0.3)';
        ctx.lineWidth = 2;
        const t = Date.now() / 1000;
        for (let x = 0; x < W; x++) {
          const y = H / 2 + Math.sin(x * 0.04 + t * 2) * 20 + Math.sin(x * 0.02 + t) * 10;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    draw();
  }

  function _stopVizAnimation() {
    _vizRunning = false;
    if (_vizFrame) { cancelAnimationFrame(_vizFrame); _vizFrame = null; }
  }

  /* ════════════════════════════════════════════════════════════
     PLAYBACK STATE MACHINE
  ════════════════════════════════════════════════════════════ */

  function _setPlayState(state) {
    _playState = state;
    _updateHudState(state);
  }

  /* ════════════════════════════════════════════════════════════
     HUD — elapsed / progress / duration / remaining
  ════════════════════════════════════════════════════════════ */

  function _fmtTime(secs) {
    if (!isFinite(secs) || isNaN(secs) || secs < 0) return '--:--';
    const s = Math.floor(secs);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    if (h > 0) {
      return h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
    }
    return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }

  function _resetHud() {
    const el = _el('snxTvHud');
    if (!el) return;
    _el('snxTvHudElapsed')  && (_el('snxTvHudElapsed').textContent  = '00:00');
    _el('snxTvHudDuration') && (_el('snxTvHudDuration').textContent = '--:--');
    _el('snxTvHudRemaining')&& (_el('snxTvHudRemaining').textContent= '');
    const bar = _el('snxTvHudBar');
    if (bar) bar.style.width = '0%';
  }

  function _tickHud(mediaEl) {
    if (!mediaEl) return;
    const cur = mediaEl.currentTime;
    const dur = mediaEl.duration;

    const elEl  = _el('snxTvHudElapsed');
    const durEl = _el('snxTvHudDuration');
    const remEl = _el('snxTvHudRemaining');
    const bar   = _el('snxTvHudBar');

    if (elEl)  elEl.textContent  = _fmtTime(cur);
    if (durEl) durEl.textContent = isFinite(dur) ? _fmtTime(dur) : '--:--';
    if (remEl) {
      const rem = isFinite(dur) ? Math.max(0, dur - cur) : null;
      remEl.textContent = rem !== null ? '-' + _fmtTime(rem) : '';
    }
    if (bar) {
      const pct = (isFinite(dur) && dur > 0) ? Math.min(100, (cur / dur) * 100) : 0;
      bar.style.width = pct + '%';
    }
  }

  function _updateHudState(state) {
    const indicator = _el('snxTvHudState');
    if (!indicator) return;
    const labels = {
      waiting:  '',
      loading:  '⏳',
      playing:  '',      // keep clean when playing
      paused:   '⏸',
      blocked:  '🔇',
      ended:    '',
      failed:   '⚠',
    };
    indicator.textContent = labels[state] || '';
    indicator.title = state;
  }

  /* ════════════════════════════════════════════════════════════
     PLAY OVERLAY  (small, shown only when autoplay is blocked)
  ════════════════════════════════════════════════════════════ */

  function _showPlayOverlay() { const o = _el('snxTvPlayOverlay'); if (o) o.classList.add('visible'); }
  function _hidePlayOverlay() { const o = _el('snxTvPlayOverlay'); if (o) o.classList.remove('visible'); }

  function _onPlayOverlayClick() {
    _hidePlayOverlay();
    _autoplayBlocked = false;

    // Resume suspended AudioContext first (must happen in a genuine user gesture)
    if (_vizAudioCtx && _vizAudioCtx.state === 'suspended') {
      _vizAudioCtx.resume().catch(() => {});
    }

    const item = _mediaQueue[_queueIdx];
    if (!item) return;

    // Re-play the current item from scratch so src, load, and play all
    // happen in the user-gesture callback, satisfying autoplay policy.
    _playItem(item);
  }

  /* ════════════════════════════════════════════════════════════
     NOW PLAYING
  ════════════════════════════════════════════════════════════ */

  function _renderNowPlaying(item) {
    const npTitle   = _el('snxTvNpTitle');
    const npSub     = _el('snxTvNpSub');
    const npArt     = _el('snxTvNpArt');
    const npChannel = _el('snxTvNpChannel');

    if (!item) {
      if (npTitle) npTitle.textContent = 'Nothing playing';
      if (npSub)   npSub.textContent   = '';
      if (npArt)   { npArt.innerHTML = '📺'; npArt.style.backgroundImage = ''; }
      if (npChannel && _activeChannel) npChannel.textContent = _activeChannel.name;
      return;
    }

    if (npTitle)   npTitle.textContent   = item.title  || item.fileName || 'Untitled';
    // Sub line: "Artist · duration" or just artist or just duration
    if (npSub) {
      const artist   = item.artist || (item.mediaKind === 'video' ? 'Video' : '');
      const durStr   = (item.duration && isFinite(item.duration))
                        ? _fmtTime(item.duration)
                        : '';
      npSub.textContent = [artist, durStr].filter(Boolean).join(' · ');
    }
    if (npChannel && _activeChannel) npChannel.textContent = _activeChannel.name;
    if (npArt) {
      const art = item.artworkUrl || (_activeChannel && _activeChannel.artworkUrl) || '';
      if (art) {
        npArt.style.backgroundImage = 'url(' + art + ')';
        npArt.innerHTML = '';
      } else {
        npArt.style.backgroundImage = '';
        npArt.innerHTML = KIND_ICON[item.mediaKind] || '🎬';
      }
    }
  }

  /* ════════════════════════════════════════════════════════════
     TV GUIDE RENDER (public viewers)
  ════════════════════════════════════════════════════════════ */

  function _renderGuide() {
    const grid = _el('snxTvGuideGrid');
    if (!grid) return;

    if (_channels.length === 0) {
      grid.innerHTML =
        '<div style="color:#3a6a9a;font-size:13px;padding:10px 2px;">' +
        (_isFounder() ? 'No channels yet. Open TV Studio to create one.' : 'No channels available.') +
        '</div>';
      return;
    }

    grid.innerHTML = _channels.map(ch => {
      const isActive   = _activeChannel && _activeChannel.id === ch.id;
      const artStyle   = ch.artworkUrl ? 'background-image:url(' + _esc(ch.artworkUrl) + ');' : '';
      const artContent = ch.artworkUrl ? '' : '📺';
      return (
        '<div class="snx-tv-channel-card' + (isActive ? ' active-channel' : '') + '" ' +
        'data-ch-id="' + _esc(ch.id) + '" ' +
        'onclick="window.SNXTv.selectChannel(' + _json(ch.id) + ')" ' +
        'role="button" tabindex="0" ' +
        'onkeydown="if(event.key===\'Enter\'||event.key===\' \')window.SNXTv.selectChannel(' + _json(ch.id) + ')">' +
          '<div class="snx-tv-ch-art" style="' + artStyle + '">' + artContent + '</div>' +
          '<div class="snx-tv-ch-info">' +
            '<div class="snx-tv-ch-name">' + _esc(ch.name) + '</div>' +
            '<div class="snx-tv-ch-meta">' + _esc(ch.description || '') + '</div>' +
          '</div>' +
          (isActive
            ? '<span class="snx-tv-ch-badge playing"><span class="snx-tv-onair-dot"></span>ON</span>'
            : '<span class="snx-tv-ch-badge">CH ' + ((ch.order !== undefined ? ch.order + 1 : '')) + '</span>') +
        '</div>'
      );
    }).join('');
  }

  /* ════════════════════════════════════════════════════════════
     TV STUDIO BAR & PANEL (founder only)
  ════════════════════════════════════════════════════════════ */

  function _showStudioBar() { _show('snxTvStudioBar'); }
  function _hideStudioBar() { _hide('snxTvStudioBar'); }

  function _toggleStudio() {
    _studioOpen = !_studioOpen;
    const panel = _el('snxTvStudioPanel');
    if (panel) panel.classList.toggle('open', _studioOpen);
    const btn = _el('snxTvStudioToggleBtn');
    if (btn) btn.textContent = _studioOpen ? '✕ Close Studio' : '📺 TV Studio';
    if (_studioOpen) {
      _subscribeLibrary();
      _switchStudioTab(_studioTab || 'library');
    }
  }

  function _switchStudioTab(tab) {
    _studioTab = tab;
    document.querySelectorAll('.snx-tv-studio-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.querySelectorAll('.snx-tv-studio-pane').forEach(el => {
      el.classList.toggle('active', el.dataset.pane === tab);
    });
    if (tab === 'library') _renderLibrary();
    if (tab === 'channels') _renderStudioChannelList();
    if (tab === 'channel-content') _renderChContentChannelPicker();
  }

  /* ════════════════════════════════════════════════════════════
     MEDIA LIBRARY — render
  ════════════════════════════════════════════════════════════ */

  function _filteredLibrary() {
    let items = _libraryAll.slice();
    if (_libFilter !== 'all') {
      items = items.filter(m => m.mediaKind === _libFilter);
    }
    if (_libSearch) {
      const q = _libSearch.toLowerCase();
      items = items.filter(m =>
        (m.title  || '').toLowerCase().includes(q) ||
        (m.artist || '').toLowerCase().includes(q) ||
        (m.fileName || '').toLowerCase().includes(q)
      );
    }
    return items;
  }

  function _renderLibrary() {
    const list = _el('snxTvLibraryList');
    if (!list) return;

    const items = _filteredLibrary();

    if (items.length === 0) {
      list.innerHTML =
        '<li style="color:#4a7a9a;font-size:13px;padding:12px 0;text-align:center;">' +
        (_libraryAll.length === 0
          ? 'No media yet. Use Upload Music/Audio or Upload Video above.'
          : 'No results match your filter or search.') +
        '</li>';
      return;
    }

    list.innerHTML = items.map(m => {
      const sel = _libSelected.has(m.id);
      // Build channel assignment badges
      const chNames = _getChannelsForMedia(m.id);
      const chBadges = chNames.length
        ? chNames.map(n => '<span class="snx-tv-lib-ch-badge">' + _esc(n) + '</span>').join('')
        : '<span style="color:#3a5a7a;font-size:11px;">Not assigned</span>';

      return (
        '<li class="snx-tv-lib-row' + (sel ? ' selected' : '') + '" data-media-id="' + _esc(m.id) + '">' +
          '<label class="snx-tv-lib-check" title="Select">' +
            '<input type="checkbox" ' + (sel ? 'checked' : '') + ' ' +
              'onchange="window.SNXTv.libToggleSelect(' + _json(m.id) + ',this.checked)">' +
          '</label>' +
          '<span class="snx-tv-media-row-icon">' + (KIND_ICON[m.mediaKind] || '📁') + '</span>' +
          '<div class="snx-tv-media-row-info">' +
            '<div class="snx-tv-media-row-title">' + _esc(m.title || m.fileName || 'Untitled') + '</div>' +
            '<div class="snx-tv-media-row-meta">' +
              (m.artist ? _esc(m.artist) + ' · ' : '') +
              _esc(m.mediaKind || '') +
              (m.duration ? ' · ' + _formatDuration(m.duration) : '') +
            '</div>' +
            '<div class="snx-tv-lib-ch-tags">' + chBadges + '</div>' +
          '</div>' +
          '<div class="snx-tv-lib-row-actions">' +
            '<button class="snx-tv-btn snx-tv-btn-xs" ' +
              'onclick="window.SNXTv.libPreview(' + _json(m.id) + ')" title="Preview">▶</button>' +
            '<button class="snx-tv-btn snx-tv-btn-xs snx-tv-btn-primary" ' +
              'onclick="window.SNXTv.libEditTitle(' + _json(m.id) + ')" title="Edit">✏</button>' +
            '<button class="snx-tv-btn snx-tv-btn-xs snx-tv-btn-success" ' +
              'onclick="window.SNXTv.libAddToChannel(' + _json(m.id) + ')" title="Add to Channel">+Ch</button>' +
            '<button class="snx-tv-btn snx-tv-btn-xs snx-tv-btn-danger" ' +
              'onclick="window.SNXTv.libDeleteMedia(' + _json(m.id) + ')" title="Delete from library">🗑</button>' +
          '</div>' +
        '</li>'
      );
    }).join('');

    // Update bulk-action bar
    _renderLibBulkBar();
  }

  function _renderLibBulkBar() {
    const bar = _el('snxTvLibBulkBar');
    if (!bar) return;
    if (_libSelected.size === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    const countEl = _el('snxTvLibSelCount');
    if (countEl) countEl.textContent = _libSelected.size + ' selected';
  }

  function _getChannelsForMedia(mediaId) {
    // Scan loaded channel items (all channels) — we keep a global map
    return _allChItemChannelNames[mediaId] || [];
  }

  // Map of mediaId → [channelName, ...] populated by _subscribeAllChItems
  let _allChItemChannelNames = {};
  let _allChItemsUnsub = null;

  function _subscribeAllChItems() {
    if (_allChItemsUnsub) return;
    const col = _fsCollection(COL_CH_ITEMS);
    _allChItemsUnsub = _fsOnSnapshot(col, snap => {
      _allChItemChannelNames = {};
      snap.forEach(d => {
        const data = d.data();
        const ch = _channels.find(c => c.id === data.channelId);
        if (!ch) return;
        if (!_allChItemChannelNames[data.mediaId]) _allChItemChannelNames[data.mediaId] = [];
        if (!_allChItemChannelNames[data.mediaId].includes(ch.name)) {
          _allChItemChannelNames[data.mediaId].push(ch.name);
        }
      });
      _renderLibrary(); // refresh badges
    }, () => {});
  }

  function _formatDuration(secs) {
    if (!secs || isNaN(secs)) return '';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  /* ── Library: select / deselect ── */

  function _libToggleSelect(mediaId, checked) {
    if (checked) _libSelected.add(mediaId);
    else _libSelected.delete(mediaId);
    _renderLibBulkBar();
  }

  /* ── Library: filter / search ── */

  function _libSetFilter(filter) {
    _libFilter = filter;
    document.querySelectorAll('.snx-tv-lib-filter-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.filter === filter);
    });
    _renderLibrary();
  }

  function _libSetSearch(val) {
    _libSearch = val.trim();
    _renderLibrary();
  }

  /* ── Library: edit title / artist ── */

  function _libEditTitle(mediaId) {
    const m = _libraryAll.find(x => x.id === mediaId);
    if (!m) return;
    const newTitle = prompt('Edit title:', m.title || '');
    if (newTitle === null) return;
    const newArtist = prompt('Edit artist:', m.artist || '');
    if (newArtist === null) return;
    _fsUpdateDoc(_fsDoc(COL_LIBRARY, mediaId), {
      title:  newTitle.trim().slice(0, 200),
      artist: newArtist.trim().slice(0, 200),
    }).catch(e => alert('Update failed: ' + e.message));
  }

  /* ── Library: preview ── */

  function _libPreview(mediaId) {
    const m = _libraryAll.find(x => x.id === mediaId);
    if (!m || !m.url) return;

    const overlay = _el('snxTvPreviewOverlay');
    if (!overlay) return;

    overlay.style.display = 'flex';
    _previewOpen = true;

    const title = _el('snxTvPreviewTitle');
    const body  = _el('snxTvPreviewBody');
    if (title) title.textContent = m.title || m.fileName || 'Preview';
    if (body) {
      if (m.mediaKind === 'video') {
        body.innerHTML = '<video src="' + _esc(m.url) + '" controls autoplay style="width:100%;max-height:60vh;"></video>';
      } else if (m.mediaKind === 'audio') {
        body.innerHTML =
          (m.artworkUrl ? '<img src="' + _esc(m.artworkUrl) + '" style="width:100%;max-height:200px;object-fit:contain;margin-bottom:10px;">' : '') +
          '<audio src="' + _esc(m.url) + '" controls autoplay style="width:100%;"></audio>';
      } else {
        body.innerHTML = '<img src="' + _esc(m.url) + '" style="width:100%;max-height:60vh;object-fit:contain;">';
      }
    }
  }

  function _closePreview() {
    const overlay = _el('snxTvPreviewOverlay');
    if (overlay) {
      overlay.style.display = 'none';
      const body = _el('snxTvPreviewBody');
      if (body) body.innerHTML = '';
    }
    _previewOpen = false;
  }

  /* ── Library: delete ── */

  function _libDeleteMedia(mediaId) {
    const m = _libraryAll.find(x => x.id === mediaId);
    if (!m) return;
    // Check if still assigned to any channel
    const assigned = _allChItemChannelNames[mediaId] || [];
    const msg = assigned.length
      ? 'This media is currently assigned to: ' + assigned.join(', ') + '.\n\nDeleting it from the library will NOT remove the file from storage, but it will disappear from those channels.\n\nContinue?'
      : 'Delete "' + (m.title || m.fileName || 'this item') + '" from the library? The R2 file is kept in storage.';
    if (!confirm(msg)) return;
    _fsDeleteDoc(_fsDoc(COL_LIBRARY, mediaId))
      .then(() => {
        _libSelected.delete(mediaId);
        _renderLibBulkBar();
      })
      .catch(e => alert('Delete failed: ' + e.message));
  }

  /* ── Library: Add to Channel (single item) ── */

  function _libAddToChannel(mediaId) {
    _libSelected.clear();
    _libSelected.add(mediaId);
    _openAddToChannelDialog([mediaId]);
  }

  /* ── Library: Bulk Add to Channel ── */

  function _libBulkAddToChannel() {
    if (_libSelected.size === 0) return;
    _openAddToChannelDialog(Array.from(_libSelected));
  }

  /* ── Add to Channel dialog ── */

  function _openAddToChannelDialog(mediaIds) {
    if (_channels.length === 0) { alert('No channels exist yet. Create a channel first.'); return; }

    const overlay = _el('snxTvAssignOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    const list = _el('snxTvAssignChList');
    if (list) {
      list.innerHTML = _channels.map(ch => (
        '<label class="snx-tv-assign-ch-label">' +
          '<input type="checkbox" value="' + _esc(ch.id) + '"> ' +
          '<span>' + _esc(ch.name) + '</span>' +
        '</label>'
      )).join('');
    }

    const confirmBtn = _el('snxTvAssignConfirmBtn');
    if (confirmBtn) {
      confirmBtn.onclick = () => _confirmAddToChannel(mediaIds);
    }

    const cancelBtn = _el('snxTvAssignCancelBtn');
    if (cancelBtn) {
      cancelBtn.onclick = _closeAssignDialog;
    }

    const countEl = _el('snxTvAssignMediaCount');
    if (countEl) countEl.textContent = mediaIds.length + ' item' + (mediaIds.length > 1 ? 's' : '');
  }

  function _closeAssignDialog() {
    const overlay = _el('snxTvAssignOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function _confirmAddToChannel(mediaIds) {
    const list  = _el('snxTvAssignChList');
    const status = _el('snxTvAssignStatus');
    if (!list) return;

    const checked = Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map(el => el.value);
    if (checked.length === 0) {
      if (status) { status.textContent = 'Select at least one channel.'; status.style.color = '#ff6655'; }
      return;
    }

    if (status) { status.textContent = 'Assigning…'; status.style.color = '#00AEEF'; }

    let added = 0;
    let dupes  = 0;

    for (const channelId of checked) {
      // Get existing assignments for this channel to check order + duplicates
      let maxOrder = -1;
      try {
        const col = _fsCollection(COL_CH_ITEMS);
        const q   = _fsQuery(col, _fsWhere('channelId', '==', channelId), _fsOrderBy('order', 'desc'));
        const snap = await _fsGetDocs(q);
        snap.forEach(d => {
          const ord = d.data().order || 0;
          if (ord > maxOrder) maxOrder = ord;
        });
        // Build set of already-assigned mediaIds for duplicate check
        const assignedSet = new Set();
        snap.forEach(d => assignedSet.add(d.data().mediaId));

        for (const mediaId of mediaIds) {
          if (assignedSet.has(mediaId)) { dupes++; continue; }
          maxOrder++;
          await _fsAddDoc(_fsCollection(COL_CH_ITEMS), {
            channelId,
            mediaId,
            order:    maxOrder,
            addedAt:  Date.now(),
          });
          added++;
        }
      } catch (e) {
        console.warn(LOG, 'assign error', e);
        if (status) { status.textContent = 'Error: ' + e.message; status.style.color = '#ff6655'; }
        return;
      }
    }

    let msg = '✓ Added ' + added + ' assignment' + (added !== 1 ? 's' : '');
    if (dupes > 0) msg += ' (' + dupes + ' duplicate' + (dupes !== 1 ? 's' : '') + ' skipped)';
    if (status) { status.textContent = msg; status.style.color = '#44dd88'; }
    setTimeout(_closeAssignDialog, 2000);
  }

  /* ── Library: Upload Music/Audio ── */

  function _libUploadAudio() {
    _libUploadFile('audio');
  }

  function _libUploadVideo() {
    _libUploadFile('video');
  }

  function _libUploadFile(defaultKind) {
    const overlay = _el('snxTvUploadOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';

    // Authoritative kind for this action — set select and restrict accept
    const kindSel = _el('snxTvLibUploadKind');
    if (kindSel && defaultKind) kindSel.value = defaultKind;

    const fi = _el('snxTvLibUploadFile');
    if (fi) {
      fi.value = '';
      // Restrict the file picker to the correct media type so the user cannot
      // accidentally choose the wrong kind (e.g. an audio file from the Video
      // upload button).  Fall back to all three types if defaultKind is unknown.
      fi.accept = defaultKind === 'video' ? 'video/*'
                : defaultKind === 'audio' ? 'audio/*'
                : defaultKind === 'image' ? 'image/*'
                : 'video/*,audio/*,image/*';
    }

    // Reset remaining form fields
    const ti = _el('snxTvLibUploadTitle');
    if (ti) ti.value = '';
    const ai = _el('snxTvLibUploadArtist');
    if (ai) ai.value = '';
    const prog = _el('snxTvLibUploadProgressWrap');
    if (prog) prog.classList.remove('visible');
    const bar = _el('snxTvLibUploadProgressBar');
    if (bar) bar.style.width = '0%';
    _showStatus('snxTvLibUploadStatus', '', '');
  }

  function _closeUploadOverlay() {
    const overlay = _el('snxTvUploadOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  /* Map a MIME type string to the canonical mediaKind value.
     Returns 'video', 'audio', 'image', or null for unknown/unsupported types. */
  function _kindFromMime(mime) {
    if (!mime) return null;
    if (mime.startsWith('video/'))                                     return 'video';
    if (mime.startsWith('audio/'))                                     return 'audio';
    if (mime.startsWith('image/'))                                     return 'image';
    // application/octet-stream can legitimately be audio (some browsers report
    // this for MP3/AAC downloads) — treat it as unknown so the caller can fall
    // back to the select value rather than silently misclassifying.
    return null;
  }

  function _libDoUpload() {
    const fileInput   = _el('snxTvLibUploadFile');
    const titleInput  = _el('snxTvLibUploadTitle');
    const artistInput = _el('snxTvLibUploadArtist');
    const kindSel     = _el('snxTvLibUploadKind');

    const file   = fileInput  && fileInput.files[0];
    const title  = titleInput  ? titleInput.value.trim()  : '';
    const artist = artistInput ? artistInput.value.trim() : '';

    if (!file) { _showStatus('snxTvLibUploadStatus', 'Select a file first.', 'err'); return; }

    // Derive mediaKind from the file's MIME type (authoritative).
    // Fall back to the <select> value only when the browser reports an ambiguous
    // MIME (e.g. application/octet-stream).  This prevents stale select state
    // from causing a mediaKind/file-type mismatch on the server.
    const mimeKind    = _kindFromMime(file.type);
    const selectKind  = kindSel ? kindSel.value : 'audio';
    const mediaKind   = mimeKind || selectKind;

    if (!['video', 'audio', 'image'].includes(mediaKind)) {
      _showStatus('snxTvLibUploadStatus',
        'Unsupported file type "' + (file.type || 'unknown') + '". Please choose a video, audio, or image file.',
        'err');
      return;
    }

    // Keep the <select> in sync so the user sees what kind will be uploaded.
    if (kindSel) kindSel.value = mediaKind;

    _showStatus('snxTvLibUploadStatus', 'Uploading…', 'info');
    const prog = _el('snxTvLibUploadProgressWrap');
    const bar  = _el('snxTvLibUploadProgressBar');
    if (prog) prog.classList.add('visible');
    if (bar)  bar.style.width = '0%';

    _getIdToken().then(token => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mediaKind', mediaKind);
      fd.append('title',  title);
      fd.append('artist', artist);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', WORKER + '/tv/upload-media-library');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);

      xhr.upload.onprogress = e => {
        if (e.lengthComputable && bar) bar.style.width = Math.round(e.loaded / e.total * 90) + '%';
      };

      xhr.onload = () => {
        if (bar) bar.style.width = '100%';
        let res;
        try { res = JSON.parse(xhr.responseText); } catch (_) { res = {}; }
        if (xhr.status === 200 && res.url) {
          _onLibraryUploadSuccess(res, title, artist, mediaKind);
        } else {
          _showStatus('snxTvLibUploadStatus', 'Upload failed: ' + (res.error || xhr.status), 'err');
          if (prog) setTimeout(() => prog.classList.remove('visible'), 2000);
        }
      };
      xhr.onerror = () => {
        _showStatus('snxTvLibUploadStatus', 'Network error during upload.', 'err');
        if (prog) prog.classList.remove('visible');
      };
      xhr.send(fd);
    }).catch(e => _showStatus('snxTvLibUploadStatus', 'Auth error: ' + e.message, 'err'));
  }

  function _onLibraryUploadSuccess(res, title, artist, mediaKind) {
    const prog = _el('snxTvLibUploadProgressWrap');

    const mediaData = {
      url:       res.url,
      key:       res.key,
      mediaKind,
      title:     title  || res.key.split('/').pop() || 'Untitled',
      artist:    artist || '',
      artworkUrl:'',
      fileName:  res.key.split('/').pop() || '',
      createdAt: Date.now(),
    };

    _fsAddDoc(_fsCollection(COL_LIBRARY), mediaData)
      .then(() => {
        _showStatus('snxTvLibUploadStatus', '✓ Upload complete! Media saved to library.', 'ok');
        if (prog) setTimeout(() => prog.classList.remove('visible'), 1500);
        setTimeout(_closeUploadOverlay, 2200);
      })
      .catch(e => {
        _showStatus('snxTvLibUploadStatus', 'Firestore error: ' + e.message, 'err');
        if (prog) prog.classList.remove('visible');
      });
  }

  /* ════════════════════════════════════════════════════════════
     CHANNELS TAB (create / delete channels)
  ════════════════════════════════════════════════════════════ */

  function _renderStudioChannelList() {
    const list = _el('snxTvStudioChList');
    if (!list) return;

    if (_channels.length === 0) {
      list.innerHTML = '<li style="color:#4a7a9a;font-size:13px;padding:8px 0;">No channels yet.</li>';
      return;
    }

    list.innerHTML = _channels.map(ch => (
      '<li class="snx-tv-ch-row">' +
        '<span class="snx-tv-ch-row-name">' + _esc(ch.name) + '</span>' +
        '<button class="snx-tv-btn snx-tv-btn-primary" ' +
          'onclick="window.SNXTv.studioOpenChannelContent(' + _json(ch.id) + ')">Manage Content</button>' +
        '<button class="snx-tv-btn snx-tv-btn-danger" ' +
          'onclick="window.SNXTv.studioDeleteChannel(' + _json(ch.id) + ')">Delete</button>' +
      '</li>'
    )).join('');
  }

  function _studioCreateChannel() {
    const nameEl = _el('snxTvNewChName');
    const descEl = _el('snxTvNewChDesc');
    const name   = nameEl ? nameEl.value.trim() : '';
    const desc   = descEl ? descEl.value.trim() : '';
    if (!name) { _showStatus('snxTvCreateChStatus', 'Channel name is required.', 'err'); return; }

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
               + '-' + Date.now().toString(36);

    _fsSetDoc(_fsDoc(COL_CHANNELS, id), {
      id, name, description: desc, artworkUrl: '', order: _channels.length, createdAt: Date.now(),
    })
      .then(() => {
        _showStatus('snxTvCreateChStatus', 'Channel "' + name + '" created!', 'ok');
        if (nameEl) nameEl.value = '';
        if (descEl) descEl.value = '';
      })
      .catch(e => _showStatus('snxTvCreateChStatus', 'Error: ' + e.message, 'err'));
  }

  function _studioDeleteChannel(channelId) {
    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;
    // Show a custom in-page confirmation overlay instead of window.confirm(),
    // which some browsers silently suppress (returns false) in certain contexts.
    _openDeleteConfirmDialog(ch);
  }

  /* Custom delete-confirmation overlay — avoids window.confirm() suppression */
  function _openDeleteConfirmDialog(ch) {
    const overlay = _el('snxTvDeleteConfirmOverlay');
    if (!overlay) return;

    const nameEl = _el('snxTvDeleteConfirmChName');
    if (nameEl) nameEl.textContent = ch.name;

    overlay.style.display = 'flex';

    // Wire buttons — replace handlers each time so stale channelId never fires
    const confirmBtn = _el('snxTvDeleteConfirmBtn');
    const cancelBtn  = _el('snxTvDeleteCancelBtn');
    if (confirmBtn) confirmBtn.onclick = () => { _closeDeleteConfirmDialog(); _doDeleteChannel(ch); };
    if (cancelBtn)  cancelBtn.onclick  = _closeDeleteConfirmDialog;
  }

  function _closeDeleteConfirmDialog() {
    const overlay = _el('snxTvDeleteConfirmOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  function _doDeleteChannel(ch) {
    const channelId = ch.id;
    _showStatus('snxTvDeleteChStatus', 'Deleting "' + ch.name + '"…', 'info');

    _fsDeleteDoc(_fsDoc(COL_CHANNELS, channelId))
      .then(() => {
        _showStatus('snxTvDeleteChStatus', '✓ Channel "' + ch.name + '" deleted.', 'ok');

        // If this was the active playback channel, stop and switch to another
        if (_activeChannel && _activeChannel.id === channelId) {
          _stopPlayback();
          _activeChannel = null;
          if (_chItemsUnsub)    { _chItemsUnsub();    _chItemsUnsub    = null; }
          if (_studioMediaUnsub){ _studioMediaUnsub(); _studioMediaUnsub = null; }
          // Pick any remaining channel (snapshot will have already removed this one)
          const remaining = _channels.filter(c => c.id !== channelId);
          if (remaining.length > 0) {
            _selectChannel(remaining[0].id);
          } else {
            _showWaiting();
          }
        }

        // Clean up studio channel state
        if (_studioChannel && _studioChannel.id === channelId) {
          _studioChannel = null;
          if (_chContentUnsub) { _chContentUnsub(); _chContentUnsub = null; }
          _chContentItems = [];
          _renderChContent();
          _renderChContentChannelPicker();
        }

        // Best-effort: remove tv_channel_items for this channel
        const col = _fsCollection(COL_CH_ITEMS);
        const q   = _fsQuery(col, _fsWhere('channelId', '==', channelId));
        _fsGetDocs(q).then(snap => {
          snap.forEach(d => _fsDeleteDoc(d.ref).catch(() => {}));
        }).catch(() => {});
      })
      .catch(e => {
        console.warn(LOG, 'delete channel error', e);
        const msg = (e && e.code === 'permission-denied')
          ? '✗ Permission denied. Ensure Firestore rules are deployed and you are signed in as founder.'
          : '✗ Delete failed: ' + (e && e.message ? e.message : String(e));
        _showStatus('snxTvDeleteChStatus', msg, 'err');
      });
  }

  /* ════════════════════════════════════════════════════════════
     CHANNEL CONTENT TAB (ordered list of assignments)
  ════════════════════════════════════════════════════════════ */

  function _renderChContentChannelPicker() {
    const container = _el('snxTvChContentPicker');
    const label     = _el('snxTvChContentLabel');

    if (label) {
      if (_studioChannel) {
        label.innerHTML = '<span style="color:#00AEEF;">✔ Channel:</span> <strong style="color:#e0f0ff;">' + _esc(_studioChannel.name) + '</strong>';
      } else {
        label.textContent = _channels.length ? 'Select a channel below.' : 'No channels yet — create one on the Channels tab.';
      }
    }

    if (!container) return;
    if (_channels.length === 0) {
      container.innerHTML = '<p style="color:#4a7a9a;font-size:13px;margin:0 0 12px;">No channels yet.</p>';
      return;
    }

    container.innerHTML = _channels.map(ch => {
      const sel = _studioChannel && _studioChannel.id === ch.id;
      return (
        '<div class="snx-tv-channel-card' + (sel ? ' active-channel' : '') + '" ' +
        'data-ch-id="' + _esc(ch.id) + '" role="button" tabindex="0" ' +
        'style="margin-bottom:8px;' + (sel ? 'border-color:rgba(0,174,239,0.90);box-shadow:0 0 18px rgba(0,174,239,0.30);' : '') + '" ' +
        'onclick="window.SNXTv.studioSelectChannelContent(' + _json(ch.id) + ')" ' +
        'onkeydown="if(event.key===\'Enter\'||event.key===\' \')window.SNXTv.studioSelectChannelContent(' + _json(ch.id) + ')">' +
          '<div class="snx-tv-ch-art">' + (ch.artworkUrl ? '' : '📺') + '</div>' +
          '<div class="snx-tv-ch-info">' +
            '<div class="snx-tv-ch-name">' + _esc(ch.name) + '</div>' +
            '<div class="snx-tv-ch-meta">' + _esc(ch.description || '') + '</div>' +
          '</div>' +
          (sel ? '<span class="snx-tv-ch-badge playing">✔ Selected</span>' : '<span class="snx-tv-ch-badge">Select</span>') +
        '</div>'
      );
    }).join('');
  }

  function _studioSelectChannelContent(channelId) {
    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;
    _studioChannel = ch;
    _renderChContentChannelPicker();
    _loadChContent(channelId);
  }

  function studioOpenChannelContent(channelId) {
    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;
    _studioChannel = ch;
    _switchStudioTab('channel-content');
    _renderChContentChannelPicker();
    _loadChContent(channelId);
  }

  function _loadChContent(channelId) {
    if (_chContentUnsub) { _chContentUnsub(); _chContentUnsub = null; }
    _chContentItems = [];
    _renderChContent();

    const col = _fsCollection(COL_CH_ITEMS);
    const q   = _fsQuery(col,
      _fsWhere('channelId', '==', channelId),
      _fsOrderBy('order', 'asc')
    );

    _chContentUnsub = _fsOnSnapshot(q, async snap => {
      const items = [];
      snap.forEach(d => items.push({ _assignId: d.id, ...d.data() }));
      items.sort((a, b) => (a.order || 0) - (b.order || 0));

      // Resolve media titles from library cache or fetch
      for (const item of items) {
        if (!_libraryCache[item.mediaId]) {
          try {
            const { getDoc } = _fs();
            const docSnap = await getDoc(_fsDoc(COL_LIBRARY, item.mediaId));
            if (docSnap.exists()) _libraryCache[item.mediaId] = { id: docSnap.id, ...docSnap.data() };
          } catch (_) {}
        }
      }

      _chContentItems = items;
      _renderChContent();
    }, err => {
      console.warn(LOG, 'ch content error', err);
    });
  }

  function _renderChContent() {
    const list = _el('snxTvChContentList');
    if (!list) return;

    const titleEl = _el('snxTvChContentTitle');
    if (titleEl) titleEl.textContent = _studioChannel ? 'Content for: ' + _studioChannel.name : 'Select a channel above';

    // Show/hide the "Add from Library" button based on whether a channel is selected
    const addBtn = _el('snxTvChContentAddBtn');
    if (addBtn) addBtn.style.display = _studioChannel ? '' : 'none';

    // Clear status on re-render
    _showStatus('snxTvChContentStatus', '', '');

    if (!_studioChannel) {
      list.innerHTML = '';
      return;
    }

    if (_chContentItems.length === 0) {
      list.innerHTML = '<li style="color:#4a7a9a;font-size:13px;padding:8px 0;">No media assigned yet. Use the "+ Add from Library" button above or go to Media Library → Add to Channel.</li>';
      return;
    }

    list.innerHTML = _chContentItems.map((item, idx) => {
      const media = _libraryCache[item.mediaId] || {};
      const title = media.title || media.fileName || item.mediaId || 'Unknown';
      const kind  = media.mediaKind || '';
      return (
        '<li class="snx-tv-media-row">' +
          '<span class="snx-tv-drag-handle" title="Drag to reorder">⠿</span>' +
          '<span class="snx-tv-media-row-icon">' + (KIND_ICON[kind] || '📁') + '</span>' +
          '<div class="snx-tv-media-row-info">' +
            '<div class="snx-tv-media-row-title">' + _esc(title) + '</div>' +
            '<div class="snx-tv-media-row-meta">' + (media.artist ? _esc(media.artist) + ' · ' : '') + _esc(kind) + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:4px;">' +
            (idx > 0
              ? '<button class="snx-tv-btn snx-tv-btn-xs" onclick="window.SNXTv.chContentMoveUp(' + _json(item._assignId) + ')">↑</button>'
              : '<span style="width:28px;"></span>') +
            (idx < _chContentItems.length - 1
              ? '<button class="snx-tv-btn snx-tv-btn-xs" onclick="window.SNXTv.chContentMoveDown(' + _json(item._assignId) + ')">↓</button>'
              : '<span style="width:28px;"></span>') +
            '<button class="snx-tv-btn snx-tv-btn-xs snx-tv-btn-danger" ' +
              'onclick="window.SNXTv.chContentRemove(' + _json(item._assignId) + ')">Remove</button>' +
          '</div>' +
        '</li>'
      );
    }).join('');
  }

  /* Move up / down (swap order values) */
  function _chContentMoveUp(assignId) {
    const idx = _chContentItems.findIndex(x => x._assignId === assignId);
    if (idx <= 0) return;
    _swapChItemOrder(idx, idx - 1);
  }

  function _chContentMoveDown(assignId) {
    const idx = _chContentItems.findIndex(x => x._assignId === assignId);
    if (idx < 0 || idx >= _chContentItems.length - 1) return;
    _swapChItemOrder(idx, idx + 1);
  }

  function _swapChItemOrder(idxA, idxB) {
    const a = _chContentItems[idxA];
    const b = _chContentItems[idxB];
    const orderA = a.order;
    const orderB = b.order;
    Promise.all([
      _fsUpdateDoc(_fsDoc(COL_CH_ITEMS, a._assignId), { order: orderB }),
      _fsUpdateDoc(_fsDoc(COL_CH_ITEMS, b._assignId), { order: orderA }),
    ]).catch(e => console.warn(LOG, 'reorder error', e));
  }

  /* Remove from channel (does NOT delete from library) */
  function _chContentRemove(assignId) {
    const item  = _chContentItems.find(x => x._assignId === assignId);
    const media = item && _libraryCache[item.mediaId];
    const name  = media ? (media.title || media.fileName || 'this item') : 'this item';
    // Direct remove — no native confirm() needed since the Remove button is a
    // deliberate action inside the content editor and the operation is reversible
    // (the founder can re-add the item from the library).
    _fsDeleteDoc(_fsDoc(COL_CH_ITEMS, assignId))
      .then(() => {
        _showStatus('snxTvChContentStatus', '✓ "' + name + '" removed from channel.', 'ok');
      })
      .catch(e => {
        console.warn(LOG, 'remove ch item error', e);
        _showStatus('snxTvChContentStatus', '✗ Remove failed: ' + (e && e.message ? e.message : String(e)), 'err');
      });
  }

  /* Add library items to the currently-selected channel from within the
     Channel Content pane.  Reuses the existing assign-to-channel dialog but
     pre-selects the current channel so the founder only has to confirm. */
  function _chContentAddFromLibrary() {
    if (!_studioChannel) {
      _showStatus('snxTvChContentStatus', 'Select a channel first.', 'err');
      return;
    }
    if (_libraryAll.length === 0) {
      _showStatus('snxTvChContentStatus', 'No items in the Media Library yet. Upload some first.', 'err');
      return;
    }
    // Show a library picker in the existing assign overlay.  We open it and
    // pre-tick the currently-selected channel so the founder just picks items.
    _openLibraryPickerForChannel(_studioChannel.id);
  }

  /* Opens a media-picker overlay so the founder can select items from the
     library and add them directly to the given channel. */
  function _openLibraryPickerForChannel(channelId) {
    const overlay = _el('snxTvLibPickerOverlay');
    if (!overlay) return;

    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;

    const chNameEl = _el('snxTvLibPickerChName');
    if (chNameEl) chNameEl.textContent = ch.name;

    // Populate list — exclude items already assigned to this channel
    const alreadyAssigned = new Set(_chContentItems.map(i => i.mediaId));
    const list = _el('snxTvLibPickerList');
    if (list) {
      if (_libraryAll.length === 0) {
        list.innerHTML = '<p style="color:#4a7a9a;font-size:13px;">No items in library.</p>';
      } else {
        list.innerHTML = _libraryAll.map(m => {
          const disabled = alreadyAssigned.has(m.id);
          return (
            '<label class="snx-tv-assign-ch-label" style="' + (disabled ? 'opacity:.45;' : '') + '">' +
              '<input type="checkbox" value="' + _esc(m.id) + '"' + (disabled ? ' disabled' : '') + '> ' +
              '<span>' + (KIND_ICON[m.mediaKind] || '📁') + ' ' + _esc(m.title || m.fileName || m.id) + '</span>' +
            '</label>'
          );
        }).join('');
      }
    }

    overlay.style.display = 'flex';

    const confirmBtn = _el('snxTvLibPickerConfirmBtn');
    const cancelBtn  = _el('snxTvLibPickerCancelBtn');
    const statusEl   = _el('snxTvLibPickerStatus');

    if (statusEl) { statusEl.textContent = ''; statusEl.style.color = ''; }

    if (cancelBtn) cancelBtn.onclick = () => {
      overlay.style.display = 'none';
    };

    if (confirmBtn) confirmBtn.onclick = async () => {
      const checked = list
        ? Array.from(list.querySelectorAll('input[type=checkbox]:checked')).map(el => el.value)
        : [];
      if (checked.length === 0) {
        if (statusEl) { statusEl.textContent = 'Select at least one item.'; statusEl.style.color = '#ff6655'; }
        return;
      }
      confirmBtn.disabled = true;
      if (statusEl) { statusEl.textContent = 'Adding…'; statusEl.style.color = '#00AEEF'; }

      // Determine highest current order
      let maxOrder = _chContentItems.reduce((m, i) => Math.max(m, i.order || 0), -1);
      let added = 0;
      const alreadySet = new Set(_chContentItems.map(i => i.mediaId));

      for (const mediaId of checked) {
        if (alreadySet.has(mediaId)) continue;
        maxOrder++;
        try {
          await _fsAddDoc(_fsCollection(COL_CH_ITEMS), {
            channelId,
            mediaId,
            order:   maxOrder,
            addedAt: Date.now(),
          });
          alreadySet.add(mediaId);
          added++;
        } catch (e) {
          console.warn(LOG, 'lib picker add error', e);
          if (statusEl) { statusEl.textContent = '✗ Error: ' + (e && e.message ? e.message : String(e)); statusEl.style.color = '#ff6655'; }
          confirmBtn.disabled = false;
          return;
        }
      }

      if (statusEl) { statusEl.textContent = '✓ Added ' + added + ' item' + (added !== 1 ? 's' : '') + ' to channel.'; statusEl.style.color = '#44dd88'; }
      confirmBtn.disabled = false;
      setTimeout(() => { overlay.style.display = 'none'; }, 1500);
    };
  }

  /* ════════════════════════════════════════════════════════════
     OPEN CHANNEL CONTENT FROM CHANNELS TAB
  ════════════════════════════════════════════════════════════ */
  // Public shim to allow inline onclick from _renderStudioChannelList
  function _studioOpenChannelContent(channelId) {
    studioOpenChannelContent(channelId);
  }

  /* ════════════════════════════════════════════════════════════
     PAGE DOM (idempotent builder)
  ════════════════════════════════════════════════════════════ */

  function _ensurePageDom() {
    const page = _el('tvPage');
    if (!page || _el('snxTvPlayerWrap')) return;

    page.innerHTML = [

      '<h2 class="eclipse-title" style="margin:0 0 14px;">📺 Shadow Nexus TV</h2>',

      /* ── Player ── */
      '<div class="snx-tv-player-wrap" id="snxTvPlayerWrap">',
        '<div id="snxTvPlayerInner" style="width:100%;height:100%;position:relative;">',
          '<video id="snxTvVideo" data-snx-media-exempt="1" playsinline webkit-playsinline preload="metadata" style="display:none;"></video>',
          '<audio id="snxTvAudio" preload="none" crossorigin="anonymous"></audio>',
          '<canvas id="snxTvVisualizer"></canvas>',
          '<div class="snx-tv-viz-overlay" id="snxTvVizOverlay">',
            '<div class="snx-tv-viz-title"></div>',
            '<div class="snx-tv-viz-artist"></div>',
          '</div>',
          /* HUD — real playback timeline, always visible at bottom of player */
          '<div class="snx-tv-hud" id="snxTvHud">',
            '<span class="snx-tv-hud-elapsed" id="snxTvHudElapsed">00:00</span>',
            '<div class="snx-tv-hud-track">',
              '<div class="snx-tv-hud-bar-wrap">',
                '<div class="snx-tv-hud-bar" id="snxTvHudBar"></div>',
              '</div>',
              '<div class="snx-tv-hud-times">',
                '<span id="snxTvHudDuration">--:--</span>',
                '<span id="snxTvHudRemaining" class="snx-tv-hud-remaining"></span>',
              '</div>',
            '</div>',
            '<span class="snx-tv-hud-state" id="snxTvHudState"></span>',
          '</div>',
          /* Autoplay-blocked prompt — small, only shown when browser requires interaction */
          '<div class="snx-tv-play-overlay" id="snxTvPlayOverlay">',
            '<button class="snx-tv-play-btn" id="snxTvPlayBtn">▶ Enable Sound</button>',
          '</div>',
        '</div>',
        '<span class="snx-tv-channel-badge" id="snxTvChannelBadge">TV</span>',
      '</div>',

      /* ── Now Playing ── */
      '<div class="snx-tv-now-playing">',
        '<div class="snx-tv-np-art" id="snxTvNpArt">📺</div>',
        '<div class="snx-tv-np-info">',
          '<div class="snx-tv-np-title" id="snxTvNpTitle">Loading…</div>',
          '<div class="snx-tv-np-sub"   id="snxTvNpSub"></div>',
        '</div>',
        '<div class="snx-tv-np-channel" id="snxTvNpChannel"></div>',
      '</div>',

      /* ── TV Guide ── */
      '<div class="snx-tv-guide">',
        '<p class="snx-tv-guide-title">📡 Channel Guide</p>',
        '<div class="snx-tv-guide-grid" id="snxTvGuideGrid">',
          '<div style="color:#3a6a9a;font-size:13px;padding:10px 2px;">Loading channels…</div>',
        '</div>',
      '</div>',

      /* ── Founder Studio Bar ── */
      '<div class="snx-tv-studio-bar" id="snxTvStudioBar" style="display:none;">',
        '<span class="snx-tv-studio-label">👑 Founder Tools</span>',
        '<button class="snx-tv-studio-toggle-btn" id="snxTvStudioToggleBtn" onclick="window.SNXTv.toggleStudio()">📺 TV Studio</button>',
      '</div>',

      /* ── Studio Panel ── */
      '<div class="snx-tv-studio-panel" id="snxTvStudioPanel">',

        /* Tabs */
        '<div class="snx-tv-studio-tabs">',
          '<button class="snx-tv-studio-tab active" data-tab="library" onclick="window.SNXTv.switchStudioTab(\'library\')">📚 Media Library</button>',
          '<button class="snx-tv-studio-tab" data-tab="channel-content" onclick="window.SNXTv.switchStudioTab(\'channel-content\')">📋 Channel Content</button>',
          '<button class="snx-tv-studio-tab" data-tab="channels" onclick="window.SNXTv.switchStudioTab(\'channels\')">📺 Channels</button>',
        '</div>',

        /* ══ MEDIA LIBRARY PANE ══ */
        '<div class="snx-tv-studio-pane active" data-pane="library">',

          /* Upload buttons */
          '<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">',
            '<button class="snx-tv-btn snx-tv-btn-success" onclick="window.SNXTv.libUploadAudio()">🎵 Upload Music / Audio</button>',
            '<button class="snx-tv-btn snx-tv-btn-primary" onclick="window.SNXTv.libUploadVideo()">🎬 Upload Video</button>',
          '</div>',

          /* Filter & search bar */
          '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap;align-items:center;">',
            '<button class="snx-tv-lib-filter-btn active" data-filter="all" onclick="window.SNXTv.libSetFilter(\'all\')">All</button>',
            '<button class="snx-tv-lib-filter-btn" data-filter="audio" onclick="window.SNXTv.libSetFilter(\'audio\')">🎵 Music</button>',
            '<button class="snx-tv-lib-filter-btn" data-filter="video" onclick="window.SNXTv.libSetFilter(\'video\')">🎬 Video</button>',
            '<input id="snxTvLibSearch" placeholder="Search…" style="flex:1;min-width:120px;" ' +
              'oninput="window.SNXTv.libSetSearch(this.value)">',
          '</div>',

          /* Bulk action bar (hidden when nothing selected) */
          '<div id="snxTvLibBulkBar" style="display:none;background:rgba(0,174,239,0.08);border:1px solid rgba(0,174,239,0.25);border-radius:8px;padding:8px 12px;margin-bottom:10px;align-items:center;gap:10px;">',
            '<span id="snxTvLibSelCount" style="font-size:13px;color:#c8e8ff;"></span>',
            '<button class="snx-tv-btn snx-tv-btn-success" onclick="window.SNXTv.libBulkAddToChannel()">+ Add to Channel</button>',
          '</div>',

          /* Library list */
          '<ul class="snx-tv-media-list" id="snxTvLibraryList" style="max-height:480px;overflow-y:auto;"></ul>',
        '</div>',

        /* ══ CHANNEL CONTENT PANE ══ */
        '<div class="snx-tv-studio-pane" data-pane="channel-content">',
          '<p style="font-size:12px;color:#5a8aaa;margin:0 0 10px;">Select a channel to view and reorder its assigned media.</p>',
          '<div id="snxTvChContentLabel" style="font-size:13px;font-weight:600;color:#4a7a9a;margin-bottom:10px;padding:8px 10px;background:rgba(0,20,50,0.5);border:1px solid rgba(0,174,239,0.15);border-radius:8px;">',
            'Select a channel below.',
          '</div>',
          '<div id="snxTvChContentPicker" style="margin-bottom:14px;"></div>',
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap;">',
            '<p style="font-size:11px;color:#4a7a9a;margin:0;font-weight:700;letter-spacing:.5px;text-transform:uppercase;flex:1;" id="snxTvChContentTitle">Select a channel above</p>',
            '<button class="snx-tv-btn snx-tv-btn-success" id="snxTvChContentAddBtn" style="display:none;" onclick="window.SNXTv.chContentAddFromLibrary()">+ Add from Library</button>',
          '</div>',
          '<div class="snx-tv-status" id="snxTvChContentStatus"></div>',
          '<ul class="snx-tv-media-list" id="snxTvChContentList"></ul>',
        '</div>',

        /* ══ CHANNELS MANAGEMENT PANE ══ */
        '<div class="snx-tv-studio-pane" data-pane="channels">',
          '<p style="font-size:12px;color:#5a8aaa;margin:0 0 12px;">Create and manage TV channels.</p>',
          '<div class="snx-tv-create-ch-form">',
            '<label style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">New Channel Name</label>',
            '<input id="snxTvNewChName" placeholder="e.g. Shadow Nexus TV" style="margin:4px 0 8px;">',
            '<label style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Description (optional)</label>',
            '<input id="snxTvNewChDesc" placeholder="Short description" style="margin:4px 0 10px;">',
            '<button class="snx-tv-btn snx-tv-btn-success" onclick="window.SNXTv.studioCreateChannel()" style="width:100%;padding:8px;">Create Channel</button>',
            '<div class="snx-tv-status" id="snxTvCreateChStatus"></div>',
          '</div>',
          '<p style="font-size:11px;color:#4a7a9a;margin:14px 0 8px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">Your Channels</p>',
          '<ul class="snx-tv-ch-list" id="snxTvStudioChList"></ul>',
          '<div class="snx-tv-status" id="snxTvDeleteChStatus"></div>',
        '</div>',

      '</div>', /* end studio panel */

      /* ══ UPLOAD OVERLAY ══ */
      '<div id="snxTvUploadOverlay" style="display:none;position:fixed;inset:0;z-index:9998;background:rgba(2,8,18,0.88);align-items:center;justify-content:center;">',
        '<div style="background:#06101e;border:1px solid rgba(0,174,239,0.35);border-radius:14px;padding:24px;width:100%;max-width:440px;box-sizing:border-box;position:relative;">',
          '<button onclick="window.SNXTv.closeUploadOverlay()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:#5a8aaa;font-size:18px;cursor:pointer;">✕</button>',
          '<h3 style="color:#c8e8ff;margin:0 0 16px;font-size:15px;">Upload to Media Library</h3>',
          '<label style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Media Type</label>',
          '<select id="snxTvLibUploadKind" style="margin:4px 0 10px;">',
            '<option value="audio">Music / Audio</option>',
            '<option value="video">Video</option>',
            '<option value="image">Artwork / Image</option>',
          '</select>',
          '<label style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Title (optional)</label>',
          '<input id="snxTvLibUploadTitle" placeholder="Title" style="margin:4px 0 8px;">',
          '<label style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Artist / Creator (optional)</label>',
          '<input id="snxTvLibUploadArtist" placeholder="Artist name" style="margin:4px 0 8px;">',
          '<label style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">File</label>',
          '<input type="file" id="snxTvLibUploadFile" accept="video/*,audio/*,image/*" style="margin:4px 0 10px;color:#c8e8ff;">',
          '<button class="snx-tv-btn snx-tv-btn-success" onclick="window.SNXTv.libDoUpload()" style="width:100%;padding:8px;">Upload to Library</button>',
          '<div class="snx-tv-progress-wrap" id="snxTvLibUploadProgressWrap">',
            '<div class="snx-tv-progress-bar" id="snxTvLibUploadProgressBar"></div>',
          '</div>',
          '<div class="snx-tv-status" id="snxTvLibUploadStatus"></div>',
        '</div>',
      '</div>',

      /* ══ ASSIGN TO CHANNEL OVERLAY ══ */
      '<div id="snxTvAssignOverlay" style="display:none;position:fixed;inset:0;z-index:9998;background:rgba(2,8,18,0.88);align-items:center;justify-content:center;">',
        '<div style="background:#06101e;border:1px solid rgba(0,174,239,0.35);border-radius:14px;padding:24px;width:100%;max-width:400px;box-sizing:border-box;position:relative;">',
          '<button onclick="window.SNXTv.closeAssignDialog()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:#5a8aaa;font-size:18px;cursor:pointer;">✕</button>',
          '<h3 style="color:#c8e8ff;margin:0 0 6px;font-size:15px;">Add to Channel</h3>',
          '<p style="color:#5a8aaa;font-size:13px;margin:0 0 14px;">Adding <strong id="snxTvAssignMediaCount" style="color:#c8e8ff;"></strong> to:</p>',
          '<div id="snxTvAssignChList" style="max-height:260px;overflow-y:auto;margin-bottom:14px;display:flex;flex-direction:column;gap:8px;"></div>',
          '<div style="display:flex;gap:8px;">',
            '<button class="snx-tv-btn snx-tv-btn-success" id="snxTvAssignConfirmBtn" style="flex:1;padding:8px;">Confirm</button>',
            '<button class="snx-tv-btn" id="snxTvAssignCancelBtn" style="padding:8px 14px;">Cancel</button>',
          '</div>',
          '<div id="snxTvAssignStatus" style="margin-top:8px;font-size:13px;min-height:18px;"></div>',
        '</div>',
      '</div>',

      /* ══ PREVIEW OVERLAY ══ */
      '<div id="snxTvPreviewOverlay" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(2,8,18,0.92);align-items:center;justify-content:center;">',
        '<div style="background:#06101e;border:1px solid rgba(0,174,239,0.35);border-radius:14px;padding:20px;width:100%;max-width:640px;box-sizing:border-box;position:relative;">',
          '<button onclick="window.SNXTv.closePreview()" style="position:absolute;top:12px;right:14px;background:none;border:none;color:#5a8aaa;font-size:18px;cursor:pointer;">✕</button>',
          '<h3 id="snxTvPreviewTitle" style="color:#c8e8ff;margin:0 0 14px;font-size:14px;padding-right:30px;"></h3>',
          '<div id="snxTvPreviewBody"></div>',
        '</div>',
      '</div>',

      /* ══ DELETE CHANNEL CONFIRM OVERLAY ══ */
      '<div id="snxTvDeleteConfirmOverlay" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(2,8,18,0.92);align-items:center;justify-content:center;">',
        '<div style="background:#06101e;border:1px solid rgba(255,51,68,0.45);border-radius:14px;padding:24px;width:100%;max-width:380px;box-sizing:border-box;position:relative;text-align:center;">',
          '<div style="font-size:32px;margin-bottom:12px;">⚠️</div>',
          '<h3 style="color:#ff5577;margin:0 0 10px;font-size:15px;">Delete Channel?</h3>',
          '<p style="color:#c8e8ff;font-size:13px;margin:0 0 6px;">You are about to delete:</p>',
          '<p style="color:#fff;font-size:14px;font-weight:700;margin:0 0 14px;" id="snxTvDeleteConfirmChName"></p>',
          '<p style="color:#5a8aaa;font-size:12px;margin:0 0 18px;">This removes the channel and all its assignments. Media files in the Library are never deleted.</p>',
          '<div style="display:flex;gap:10px;justify-content:center;">',
            '<button class="snx-tv-btn snx-tv-btn-danger" id="snxTvDeleteConfirmBtn" style="padding:8px 20px;">Yes, Delete</button>',
            '<button class="snx-tv-btn" id="snxTvDeleteCancelBtn" style="padding:8px 20px;">Cancel</button>',
          '</div>',
        '</div>',
      '</div>',

      /* ══ LIBRARY PICKER OVERLAY (add items to channel from Channel Content tab) ══ */
      '<div id="snxTvLibPickerOverlay" style="display:none;position:fixed;inset:0;z-index:10000;background:rgba(2,8,18,0.92);align-items:center;justify-content:center;">',
        '<div style="background:#06101e;border:1px solid rgba(0,174,239,0.35);border-radius:14px;padding:24px;width:100%;max-width:440px;box-sizing:border-box;position:relative;">',
          '<h3 style="color:#c8e8ff;margin:0 0 6px;font-size:15px;">Add from Library</h3>',
          '<p style="color:#5a8aaa;font-size:13px;margin:0 0 14px;">Adding to: <strong id="snxTvLibPickerChName" style="color:#c8e8ff;"></strong></p>',
          '<div id="snxTvLibPickerList" style="max-height:320px;overflow-y:auto;margin-bottom:14px;display:flex;flex-direction:column;gap:8px;"></div>',
          '<div style="display:flex;gap:8px;">',
            '<button class="snx-tv-btn snx-tv-btn-success" id="snxTvLibPickerConfirmBtn" style="flex:1;padding:8px;">Add Selected</button>',
            '<button class="snx-tv-btn" id="snxTvLibPickerCancelBtn" style="padding:8px 14px;">Cancel</button>',
          '</div>',
          '<div id="snxTvLibPickerStatus" style="margin-top:8px;font-size:13px;min-height:18px;"></div>',
        '</div>',
      '</div>',

    ].join('');

    /* ── Wire media element events ── */
    const vid = _el('snxTvVideo');
    const aud = _el('snxTvAudio');

    function _wireMediaEl(el) {
      el.addEventListener('loadedmetadata', () => {
        // Duration is now known — update HUD immediately
        _tickHud(el);
      });
      el.addEventListener('durationchange', () => {
        _tickHud(el);
      });
      el.addEventListener('timeupdate', () => {
        _tickHud(el);
        // Clear loading state once time starts moving
        if (_playState === 'loading' && el.currentTime > 0) {
          _setPlayState('playing');
        }
      });
      el.addEventListener('play', () => {
        // 'play' fires when play() is called — not yet necessarily audible
      });
      el.addEventListener('playing', () => {
        // 'playing' fires when media actually starts rendering frames/audio
        _setPlayState('playing');
        _autoplayBlocked = false;
        _hidePlayOverlay();
      });
      el.addEventListener('pause', () => {
        if (_playState !== 'blocked' && _playState !== 'waiting') {
          _setPlayState('paused');
        }
      });
      el.addEventListener('ended', () => {
        _setPlayState('ended');
        _advanceQueue();
      });
      el.addEventListener('error', () => {
        const err = el.error;
        console.warn(LOG, el.tagName, 'media error',
          err ? 'code=' + err.code + ' ' + err.message : '(unknown)');
        _setPlayState('failed');
        setTimeout(_advanceQueue, 2000);
      });
      el.addEventListener('waiting', () => {
        // Buffering stall — keep showing what state we were in unless loading
        if (_playState === 'playing') _setPlayState('loading');
      });
      el.addEventListener('canplay', () => {
        if (_playState === 'loading') _setPlayState('playing');
      });
    }

    if (vid) _wireMediaEl(vid);
    if (aud) _wireMediaEl(aud);

    const btn = _el('snxTvPlayBtn');
    if (btn) btn.addEventListener('click', _onPlayOverlayClick);

    /* Wire upload file-input onchange: auto-sync the Media Type <select>
       whenever a file is chosen so the UI always reflects the actual file kind.
       The <select> can still be overridden manually for application/octet-stream
       files that browsers report without a specific MIME. */
    const uploadFile = _el('snxTvLibUploadFile');
    const uploadKind = _el('snxTvLibUploadKind');
    if (uploadFile && uploadKind) {
      uploadFile.addEventListener('change', () => {
        const f = uploadFile.files && uploadFile.files[0];
        if (!f) return;
        const detected = _kindFromMime(f.type);
        if (detected) {
          uploadKind.value = detected;
        } else if (f.type && f.type !== 'application/octet-stream') {
          // MIME present but not recognised — warn but don't block yet
          _showStatus('snxTvLibUploadStatus',
            'Warning: unrecognised file type "' + f.type + '". Verify the Media Type above is correct.',
            'err');
        }
      });
    }
  }

  /* ════════════════════════════════════════════════════════════
     PAGE LIFECYCLE
  ════════════════════════════════════════════════════════════ */

  function _pageOpen() {
    if (!global._snxFirestore || !global._snxFirestore.db) {
      console.error(LOG, 'Firestore not available — ensure firebase-config.js is loaded');
      return;
    }

    _ensurePageDom();

    const _open = () => {
      _subscribeChannels();
      if (_isFounder()) {
        _showStudioBar();
        _subscribeLibrary();
        _subscribeAllChItems();
      } else {
        _hideStudioBar();
      }
    };

    if (global._snxOnAuthReady) {
      global._snxOnAuthReady(_open);
    } else {
      _open();
    }
  }

  function _pageLeave() {
    // Keep playback running in background — don't stop
  }

  function _pageDestroy() {
    _stopPlayback();
    if (_channelsUnsub)   { _channelsUnsub();   _channelsUnsub   = null; }
    if (_chItemsUnsub)    { _chItemsUnsub();    _chItemsUnsub    = null; }
    if (_libraryUnsub)    { _libraryUnsub();    _libraryUnsub    = null; }
    if (_chContentUnsub)  { _chContentUnsub();  _chContentUnsub  = null; }
    if (_allChItemsUnsub) { _allChItemsUnsub(); _allChItemsUnsub = null; }
    if (_studioMediaUnsub){ _studioMediaUnsub(); _studioMediaUnsub = null; }
    _stopVizAnimation();
  }

  /* ════════════════════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════════════════════ */

  function _init() {
    console.log(LOG, 'module loaded', BUILD);
  }

  /* ════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════ */

  global.SNXTv = {
    /* Navigation lifecycle */
    pageOpen:    _pageOpen,
    pageLeave:   _pageLeave,
    pageDestroy: _pageDestroy,

    /* Viewer */
    selectChannel: _selectChannel,

    /* Studio top-level */
    toggleStudio:    _toggleStudio,
    switchStudioTab: _switchStudioTab,

    /* Library tab */
    libUploadAudio:       _libUploadAudio,
    libUploadVideo:       _libUploadVideo,
    libDoUpload:          _libDoUpload,
    libSetFilter:         _libSetFilter,
    libSetSearch:         _libSetSearch,
    libToggleSelect:      _libToggleSelect,
    libPreview:           _libPreview,
    libEditTitle:         _libEditTitle,
    libAddToChannel:      _libAddToChannel,
    libBulkAddToChannel:  _libBulkAddToChannel,
    libDeleteMedia:       _libDeleteMedia,
    closeUploadOverlay:   _closeUploadOverlay,
    closePreview:         _closePreview,

    /* Assign dialog */
    closeAssignDialog: _closeAssignDialog,

    /* Channel content tab */
    studioSelectChannelContent: _studioSelectChannelContent,
    studioOpenChannelContent:   _studioOpenChannelContent,
    chContentMoveUp:          _chContentMoveUp,
    chContentMoveDown:        _chContentMoveDown,
    chContentRemove:          _chContentRemove,
    chContentAddFromLibrary:  _chContentAddFromLibrary,

    /* Channels tab */
    studioCreateChannel:       _studioCreateChannel,
    studioDeleteChannel:       _studioDeleteChannel,
    closeDeleteConfirmDialog:  _closeDeleteConfirmDialog,

    /* Diagnostics */
    getBuild:    () => BUILD,
    getChannels: () => _channels,
    getQueue:    () => _mediaQueue,
    getLibrary:  () => _libraryAll,

    /**
     * SNXTv.diag() — run from the browser console to get the full audio
     * pipeline state without exposing sensitive URL tokens.
     *
     * Usage:  copy(JSON.stringify(SNXTv.diag(), null, 2))
     */
    diag() {
      const aud = _el('snxTvAudio');
      const vid = _el('snxTvVideo');

      function redactUrl(u) {
        if (!u) return '(empty)';
        try {
          const url = new URL(u);
          // Remove any query-string tokens (e.g. Supabase signed URLs)
          if (url.search) url.search = '?[redacted]';
          return url.toString();
        } catch (_) { return u.slice(0, 80) + (u.length > 80 ? '…' : ''); }
      }

      function elDiag(el, name) {
        if (!el) return { error: name + ' element not found in DOM' };
        return {
          tag:          el.tagName,
          src:          redactUrl(el.src),
          currentSrc:   redactUrl(el.currentSrc),
          readyState:   el.readyState,    // 0=HAVE_NOTHING 1=HAVE_METADATA 2=HAVE_CURRENT_DATA 3=HAVE_FUTURE_DATA 4=HAVE_ENOUGH_DATA
          networkState: el.networkState,  // 0=EMPTY 1=IDLE 2=LOADING 3=NO_SOURCE
          currentTime:  el.currentTime,
          duration:     el.duration,
          paused:       el.paused,
          ended:        el.ended,
          muted:        el.muted,
          volume:       el.volume,
          error:        el.error ? { code: el.error.code, message: el.error.message } : null,
        };
      }

      const report = {
        build:          BUILD,
        playState:      _playState,
        playing:        _playing,
        autoplayBlocked: _autoplayBlocked,
        queueLength:    _mediaQueue.length,
        queueIdx:       _queueIdx,
        currentItem:    _mediaQueue[_queueIdx]
          ? { title: _mediaQueue[_queueIdx].title, mediaKind: _mediaQueue[_queueIdx].mediaKind,
              url: redactUrl(_mediaQueue[_queueIdx].url) }
          : null,
        activeChannel:  _activeChannel ? { id: _activeChannel.id, name: _activeChannel.name } : null,
        audioEl:        elDiag(aud, 'snxTvAudio'),
        videoEl:        elDiag(vid, 'snxTvVideo'),
        webAudio: {
          contextState:  _vizAudioCtx ? _vizAudioCtx.state : 'not created',
          sourceNode:    _vizSource   ? 'present (mediaElement==aud: ' + (_vizSource.mediaElement === aud) + ')' : 'null',
          analyserNode:  _vizAnalyser ? 'present' : 'null',
          vizRunning:    _vizRunning,
        },
      };

      console.log(LOG, 'DIAGNOSTIC REPORT:\n' + JSON.stringify(report, null, 2));
      return report;
    },
  };

  _init();

})(window);
