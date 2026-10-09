/**
 * snx-tv.js
 * Shadow Nexus Social — 24-Hour TV Network
 * Build: SNS-2026-TV-REBUILD-001
 *
 * Exposes: window.SNXTv
 *
 * Architecture:
 *   - Channels stored in Firestore /tv_channels/{channelId}
 *   - Media stored in Firestore /tv_media/{mediaId}  (references R2 URLs)
 *   - Playback is entirely client-side: queue is built from channel's media,
 *     advances on <video>/<audio> ended / error events.
 *   - Founder authentication: window._snxRole === 'founder' (set by SNS auth)
 *   - Uploads via POST /tv/upload-media on the Cloudflare Worker (Founder only)
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

  const BUILD     = 'SNS-2026-TV-REBUILD-001';
  const WORKER    = 'https://yellow-term-11e6.nthntjrn.workers.dev';
  const LOG       = '[SNX-TV]';

  /* Firestore collection names */
  const COL_CHANNELS = 'tv_channels';
  const COL_MEDIA    = 'tv_media';

  /* Media kind → emoji */
  const KIND_ICON = { video: '🎬', audio: '🎵', image: '🖼' };

  /* Default channel created if none exist */
  const DEFAULT_CHANNEL = {
    id: 'shadow-nexus-tv',
    name: 'Shadow Nexus TV',
    description: '24-Hour continuous television',
    artworkUrl: '',
    mediaKind: 'video',
    order: 0,
    createdAt: Date.now(),
  };

  /* ════════════════════════════════════════════════════════════
     STATE
  ════════════════════════════════════════════════════════════ */

  let _channels = [];     // Array of channel objects (sorted by order)
  let _activeChannel = null;  // currently selected channel object
  let _mediaQueue    = [];    // ordered media for active channel
  let _queueIdx      = 0;     // current position in queue
  let _playing       = false;
  let _autoplayBlocked = false;
  let _channelsUnsub = null;  // Firestore listener cleanup
  let _mediaUnsub    = null;
  let _studioOpen    = false;
  let _studioTab     = 'channels';
  let _studioChannel = null;  // channel selected inside studio
  let _studioMedia   = [];    // media for _studioChannel
  let _studioMediaUnsub = null;

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

  function _fsOnSnapshot(ref, cb, onError) {
    const { onSnapshot } = _fs();
    if (onSnapshot) return onSnapshot(ref, cb, onError || undefined);
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
    // Use the Firebase auth instance set by SNS main script (window.auth or window._snxAuth)
    const authInst = global.auth || global._snxAuth;
    const user = authInst && authInst.currentUser;
    if (!user) return Promise.reject(new Error('Not authenticated'));
    return user.getIdToken();
  }

  /* ════════════════════════════════════════════════════════════
     DOM HELPERS
  ════════════════════════════════════════════════════════════ */

  function _el(id) { return document.getElementById(id); }

  function _setHtml(id, html) {
    const el = _el(id);
    if (el) el.innerHTML = html;
  }

  function _show(id) { const el = _el(id); if (el) el.style.display = ''; }
  function _hide(id) { const el = _el(id); if (el) el.style.display = 'none'; }

  function _showStatus(id, msg, type) {
    const el = _el(id);
    if (!el) return;
    el.textContent = msg;
    el.className   = 'snx-tv-status visible ' + (type || 'info');
    if (type === 'ok') setTimeout(() => { el.classList.remove('visible'); }, 4000);
  }

  /* ════════════════════════════════════════════════════════════
     CHANNELS — Load & Listen
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
        _renderStudioChannels();
        _updateChannelSelect();          // repopulate Add Media channel picker
        _renderAddMediaChannelPicker();  // refresh tappable channel cards in Add Media tab
        // Auto-select first channel if none selected
        if (!_activeChannel && _channels.length > 0) {
          _selectChannel(_channels[0].id);
        }
      } catch (e) {
        console.warn(LOG, 'channels snapshot error', e);
        _showGuideError('Could not load channels.');
      }
    }, err => {
      console.warn(LOG, 'channels snapshot permission error', err);
      _showGuideError(
        err && err.code === 'permission-denied'
          ? 'Sign in to view channels.'
          : 'Could not load channels. Please refresh.'
      );
    });
  }

  function _showGuideError(msg) {
    const grid = _el('snxTvGuideGrid');
    if (grid) {
      grid.innerHTML =
        '<div style="color:#3a6a9a;font-size:13px;padding:10px 2px;">' + msg + '</div>';
    }
  }

  /* ════════════════════════════════════════════════════════════
     MEDIA — Load for active channel
  ════════════════════════════════════════════════════════════ */

  function _subscribeMedia(channelId) {
    if (_mediaUnsub) { _mediaUnsub(); _mediaUnsub = null; }
    _mediaQueue = [];
    _queueIdx   = 0;

    const col = _fsCollection(COL_MEDIA);
    const q   = _fsQuery(col,
      _fsWhere('channelId', '==', channelId),
      _fsOrderBy('order', 'asc')
    );

    _mediaUnsub = _fsOnSnapshot(q, snap => {
      try {
        _mediaQueue = [];
        snap.forEach(d => _mediaQueue.push({ id: d.id, ...d.data() }));
        _mediaQueue.sort((a, b) => (a.order || 0) - (b.order || 0));
        _onMediaQueueUpdated();
      } catch (e) {
        console.warn(LOG, 'media snapshot error', e);
      }
    });
  }

  function _onMediaQueueUpdated() {
    if (_mediaQueue.length === 0) {
      _showWaiting();
      return;
    }
    // If nothing is playing, start from beginning
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

    // Update guide highlight
    document.querySelectorAll('.snx-tv-channel-card').forEach(el => {
      el.classList.toggle('active-channel', el.dataset.chId === channelId);
    });

    // Update channel badge
    const badge = _el('snxTvChannelBadge');
    if (badge) badge.textContent = ch.name;

    // Subscribe to this channel's media
    _subscribeMedia(channelId);
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
    _hideVisualizer();
  }

  function _playItem(item) {
    if (!item) { _showWaiting(); return; }
    _playing = true;

    const vid = _getVideoEl();
    const aud = _getAudioEl();

    // Update Now Playing
    _renderNowPlaying(item);

    if (item.mediaKind === 'video') {
      // Hide visualizer, show video
      _hideVisualizer();
      if (!vid) return;
      vid.style.display = 'block';
      vid.setAttribute('data-snx-media-exempt', '1');
      vid.src = item.url;
      vid.load();
      _tryPlay(vid);
    } else if (item.mediaKind === 'audio') {
      // Show visualizer, play audio
      if (!aud) return;
      if (vid) vid.style.display = 'none';
      aud.src = item.url;
      aud.load();
      _showVisualizer(item);
      _tryPlay(aud);
    } else if (item.mediaKind === 'image') {
      // Show image as artwork in player
      _stopPlayback();
      _playing = true; // mark as "playing" so UI is happy
      _showImageItem(item);
      // Advance after a fixed duration (e.g. 10 seconds)
      setTimeout(_advanceQueue, 10000);
    }
  }

  function _tryPlay(mediaEl) {
    const p = mediaEl.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        _autoplayBlocked = false;
        _hidePlayOverlay();
      }).catch(err => {
        if (err.name === 'NotAllowedError') {
          _autoplayBlocked = true;
          _showPlayOverlay();
        } else {
          console.warn(LOG, 'play error', err.message);
          // Try without audio
          mediaEl.muted = true;
          mediaEl.play().catch(() => {});
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
    const wrap = _el('snxTvPlayerInner');
    if (wrap) {
      // Remove existing waiting msg
      const old = wrap.querySelector('.snx-tv-waiting');
      if (!old) {
        const w = document.createElement('div');
        w.className = 'snx-tv-waiting';
        w.innerHTML =
          '<div class="snx-tv-waiting-icon">📺</div>' +
          '<div class="snx-tv-waiting-text">No content available on this channel.<br>' +
          (_isFounder() ? 'Open TV Studio to add media.' : 'Check back soon.') + '</div>';
        wrap.appendChild(w);
      }
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
     VISUALIZER (audio without custom artwork)
  ════════════════════════════════════════════════════════════ */

  let _vizCtx = null;
  let _vizAnalyser = null;
  let _vizAudioCtx = null;
  let _vizSource   = null;
  let _vizFrame    = null;
  let _vizRunning  = false;

  function _showVisualizer(item) {
    _clearWaiting();
    _clearImageItem();
    const canvas  = _el('snxTvVisualizer');
    const overlay = _el('snxTvVizOverlay');
    if (!canvas) return;
    canvas.classList.add('active');

    if (item.artworkUrl) {
      // Use artwork image instead of canvas waveform
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
    }

    if (overlay) {
      overlay.querySelector('.snx-tv-viz-title').textContent = item.title  || 'Unknown Track';
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

    try {
      if (!_vizAudioCtx) {
        _vizAudioCtx = new (global.AudioContext || global.webkitAudioContext)();
      }
      if (_vizSource) { try { _vizSource.disconnect(); } catch (_) {} }
      _vizSource   = _vizAudioCtx.createMediaElementSource(aud);
      _vizAnalyser = _vizAudioCtx.createAnalyser();
      _vizAnalyser.fftSize = 128;
      _vizSource.connect(_vizAnalyser);
      _vizAnalyser.connect(_vizAudioCtx.destination);
    } catch (e) {
      console.warn(LOG, 'AudioContext error:', e.message);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) { _vizRunning = false; return; }
    _vizCtx = ctx;

    function draw() {
      if (!_vizRunning) return;
      _vizFrame = requestAnimationFrame(draw);
      const W = canvas.width  = canvas.offsetWidth  || 320;
      const H = canvas.height = canvas.offsetHeight || 180;
      ctx.clearRect(0, 0, W, H);

      // Background
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
        // Idle wave if no analyser
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
     PLAY OVERLAY (autoplay blocked)
  ════════════════════════════════════════════════════════════ */

  function _showPlayOverlay() {
    const ol = _el('snxTvPlayOverlay');
    if (ol) ol.classList.add('visible');
  }
  function _hidePlayOverlay() {
    const ol = _el('snxTvPlayOverlay');
    if (ol) ol.classList.remove('visible');
  }

  function _onPlayOverlayClick() {
    _hidePlayOverlay();
    const item = _mediaQueue[_queueIdx];
    if (!item) return;
    const vid = _getVideoEl();
    const aud = _getAudioEl();
    const el  = (item.mediaKind === 'video') ? vid : aud;
    if (!el) return;
    el.muted = false;
    el.play().catch(() => {});
    if (_vizAudioCtx && _vizAudioCtx.state === 'suspended') {
      _vizAudioCtx.resume().catch(() => {});
    }
  }

  /* ════════════════════════════════════════════════════════════
     NOW PLAYING RENDER
  ════════════════════════════════════════════════════════════ */

  function _renderNowPlaying(item) {
    const npTitle  = _el('snxTvNpTitle');
    const npSub    = _el('snxTvNpSub');
    const npArt    = _el('snxTvNpArt');
    const npChannel= _el('snxTvNpChannel');

    if (!item) {
      if (npTitle) npTitle.textContent = 'Nothing playing';
      if (npSub)   npSub.textContent   = '';
      if (npArt)   { npArt.innerHTML = '📺'; npArt.style.backgroundImage = ''; }
      if (npChannel && _activeChannel) npChannel.textContent = _activeChannel.name;
      return;
    }

    if (npTitle) npTitle.textContent = item.title  || item.fileName || 'Untitled';
    if (npSub)   npSub.textContent   = item.artist || (item.mediaKind === 'video' ? 'Video' : '');
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
     TV GUIDE RENDER
  ════════════════════════════════════════════════════════════ */

  function _renderGuide() {
    const grid = _el('snxTvGuideGrid');
    if (!grid) return;

    if (_channels.length === 0) {
      grid.innerHTML =
        '<div style="color:#3a6a9a;font-size:13px;padding:10px 2px;">' +
        (_isFounder() ? 'No channels yet. Use TV Studio to create one.' : 'No channels available.') +
        '</div>';
      return;
    }

    grid.innerHTML = _channels.map(ch => {
      const isActive  = _activeChannel && _activeChannel.id === ch.id;
      const artStyle  = ch.artworkUrl ? 'background-image:url(' + ch.artworkUrl + ');' : '';
      const artContent= ch.artworkUrl ? '' : '📺';
      const mediaCount= '';  // optional: ch.mediaCount || ''
      return (
        '<div class="snx-tv-channel-card' + (isActive ? ' active-channel' : '') + '" ' +
        'data-ch-id="' + _esc(ch.id) + '" ' +
        'onclick="window.SNXTv.selectChannel(' + _json(ch.id) + ')" ' +
        'role="button" tabindex="0" ' +
        'onkeydown="if(event.key===\'Enter\'||event.key===\' \')window.SNXTv.selectChannel(' + _json(ch.id) + ')">' +
          '<div class="snx-tv-ch-art" style="' + artStyle + '">' + artContent + '</div>' +
          '<div class="snx-tv-ch-info">' +
            '<div class="snx-tv-ch-name">' + _esc(ch.name) + '</div>' +
            '<div class="snx-tv-ch-meta">' + (ch.description || '') + '</div>' +
          '</div>' +
          (isActive
            ? '<span class="snx-tv-ch-badge playing"><span class="snx-tv-onair-dot"></span>ON</span>'
            : '<span class="snx-tv-ch-badge">CH ' + (ch.order !== undefined ? ch.order + 1 : '') + '</span>') +
        '</div>'
      );
    }).join('');
  }

  /* ════════════════════════════════════════════════════════════
     TV STUDIO — only Founder
  ════════════════════════════════════════════════════════════ */

  function _showStudioBar() {
    const bar = _el('snxTvStudioBar');
    if (bar) bar.style.display = '';
  }
  function _hideStudioBar() {
    const bar = _el('snxTvStudioBar');
    if (bar) bar.style.display = 'none';
  }

  function _toggleStudio() {
    _studioOpen = !_studioOpen;
    const panel = _el('snxTvStudioPanel');
    if (panel) panel.classList.toggle('open', _studioOpen);
    const btn = _el('snxTvStudioToggleBtn');
    if (btn) btn.textContent = _studioOpen ? '✕ Close Studio' : '📺 TV Studio';
    if (_studioOpen) _renderStudioChannels();
  }

  function _switchStudioTab(tab) {
    _studioTab = tab;
    document.querySelectorAll('.snx-tv-studio-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    document.querySelectorAll('.snx-tv-studio-pane').forEach(el => {
      el.classList.toggle('active', el.dataset.pane === tab);
    });
  }

  /* ── Studio: Channels tab ── */

  function _renderStudioChannels() {
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
          'onclick="window.SNXTv.studioOpenChannel(' + _json(ch.id) + ')">Manage Media</button>' +
        '<button class="snx-tv-btn snx-tv-btn-danger" ' +
          'onclick="window.SNXTv.studioDeleteChannel(' + _json(ch.id) + ')">Delete</button>' +
      '</li>'
    )).join('');
  }

  /* ── Studio: Create channel ── */

  function _studioCreateChannel() {
    const nameEl = _el('snxTvNewChName');
    const descEl = _el('snxTvNewChDesc');
    const name   = (nameEl ? nameEl.value.trim() : '');
    const desc   = (descEl ? descEl.value.trim() : '');
    if (!name) { _showStatus('snxTvCreateChStatus', 'Channel name is required.', 'err'); return; }

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
               + '-' + Date.now().toString(36);

    const data = {
      id,
      name,
      description: desc,
      artworkUrl: '',
      order: _channels.length,
      createdAt: Date.now(),
    };

    _fsSetDoc(_fsDoc(COL_CHANNELS, id), data)
      .then(() => {
        _showStatus('snxTvCreateChStatus', 'Channel "' + name + '" created!', 'ok');
        if (nameEl) nameEl.value = '';
        if (descEl) descEl.value = '';
      })
      .catch(e => _showStatus('snxTvCreateChStatus', 'Error: ' + e.message, 'err'));
  }

  /* ── Studio: Delete channel (with confirmation) ── */

  function _studioDeleteChannel(channelId) {
    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;
    if (!confirm('Delete channel "' + ch.name + '"? This cannot be undone. Media files remain in storage.')) return;

    _fsDeleteDoc(_fsDoc(COL_CHANNELS, channelId))
      .then(() => {
        if (_studioChannel && _studioChannel.id === channelId) {
          _studioChannel = null;
          _setHtml('snxTvStudioMediaPaneTitle', 'Select a channel above');
          _setHtml('snxTvStudioMediaList', '');
          if (_studioMediaUnsub) { _studioMediaUnsub(); _studioMediaUnsub = null; }
        }
      })
      .catch(e => console.warn(LOG, 'delete channel error', e));
  }

  /* ── Studio: Open channel media ── */

  function _studioOpenChannel(channelId) {
    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;
    _studioChannel = ch;
    _switchStudioTab('media');
    _renderAddMediaChannelPicker();   // highlight selection + refresh label
    _loadStudioMedia(channelId);
  }

  function _loadStudioMedia(channelId) {
    if (_studioMediaUnsub) { _studioMediaUnsub(); _studioMediaUnsub = null; }

    const col = _fsCollection(COL_MEDIA);
    const q   = _fsQuery(col,
      _fsWhere('channelId', '==', channelId),
      _fsOrderBy('order', 'asc')
    );

    _studioMediaUnsub = _fsOnSnapshot(q, snap => {
      _studioMedia = [];
      snap.forEach(d => _studioMedia.push({ id: d.id, ...d.data() }));
      _studioMedia.sort((a, b) => (a.order || 0) - (b.order || 0));
      _renderStudioMedia();
    });
  }

  function _renderStudioMedia() {
    const list = _el('snxTvStudioMediaList');
    if (!list) return;

    if (_studioMedia.length === 0) {
      list.innerHTML = '<li style="color:#4a7a9a;font-size:13px;padding:8px 0;">No media. Upload content above.</li>';
      return;
    }

    list.innerHTML = _studioMedia.map((m, i) => (
      '<li class="snx-tv-media-row">' +
        '<span class="snx-tv-drag-handle" title="Drag to reorder">⠿</span>' +
        '<span class="snx-tv-media-row-icon">' + (KIND_ICON[m.mediaKind] || '📁') + '</span>' +
        '<div class="snx-tv-media-row-info">' +
          '<div class="snx-tv-media-row-title">' + _esc(m.title || m.fileName || 'Untitled') + '</div>' +
          '<div class="snx-tv-media-row-meta">' + (m.artist ? _esc(m.artist) + ' · ' : '') + (m.mediaKind || '') + '</div>' +
        '</div>' +
        '<button class="snx-tv-btn snx-tv-btn-danger" ' +
          'onclick="window.SNXTv.studioDeleteMedia(' + _json(m.id) + ')">Remove</button>' +
      '</li>'
    )).join('');
  }

  /* ── Studio: Delete media ── */

  function _studioDeleteMedia(mediaId) {
    const m = _studioMedia.find(x => x.id === mediaId);
    if (!m) return;
    if (!confirm('Remove "' + (m.title || 'this item') + '" from this channel?')) return;

    // Delete Firestore doc; R2 file is left in place (no accidental deletions)
    _fsDeleteDoc(_fsDoc(COL_MEDIA, mediaId))
      .catch(e => console.warn(LOG, 'delete media error', e));
  }

  /* ── Studio: Upload ── */

  function _studioUploadMedia() {
    const fileInput  = _el('snxTvUploadFile');
    const titleInput = _el('snxTvUploadTitle');
    const artistInput= _el('snxTvUploadArtist');
    const kindSel    = _el('snxTvUploadKind');
    const chIdEl     = _el('snxTvUploadChannelId');

    const file      = fileInput && fileInput.files[0];
    const title     = titleInput  ? titleInput.value.trim()   : '';
    const artist    = artistInput ? artistInput.value.trim()  : '';
    const mediaKind = kindSel     ? kindSel.value             : 'video';
    // Use _studioChannel as the authoritative source; hidden <select> is the fallback
    const channelId = (_studioChannel && _studioChannel.id) ||
                      (chIdEl && chIdEl.value.trim()) || '';

    if (!file)      { _showStatus('snxTvUploadStatus', 'Please select a file.', 'err'); return; }
    if (!channelId) {
      _showStatus('snxTvUploadStatus', '⚠ Tap a channel in Step 1 above to select it first.', 'err');
      return;
    }

    _showStatus('snxTvUploadStatus', 'Uploading…', 'info');
    const prog = _el('snxTvUploadProgressWrap');
    const bar  = _el('snxTvUploadProgressBar');
    if (prog) prog.classList.add('visible');
    if (bar)  bar.style.width = '0%';

    _getIdToken().then(token => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('channelId', channelId);
      fd.append('mediaKind', mediaKind);
      fd.append('title',  title);
      fd.append('artist', artist);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', WORKER + '/tv/upload-media');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token);

      xhr.upload.onprogress = e => {
        if (e.lengthComputable && bar) {
          bar.style.width = Math.round(e.loaded / e.total * 90) + '%';
        }
      };

      xhr.onload = () => {
        if (bar) bar.style.width = '100%';
        let res;
        try { res = JSON.parse(xhr.responseText); } catch (_) { res = {}; }
        if (xhr.status === 200 && res.url) {
          _onUploadSuccess(res, channelId, title, artist, mediaKind);
        } else {
          _showStatus('snxTvUploadStatus', 'Upload failed: ' + (res.error || xhr.status), 'err');
          if (prog) setTimeout(() => prog.classList.remove('visible'), 2000);
        }
      };
      xhr.onerror = () => {
        _showStatus('snxTvUploadStatus', 'Network error during upload.', 'err');
        if (prog) prog.classList.remove('visible');
      };
      xhr.send(fd);
    }).catch(e => _showStatus('snxTvUploadStatus', 'Auth error: ' + e.message, 'err'));
  }

  function _onUploadSuccess(res, channelId, title, artist, mediaKind) {
    const prog = _el('snxTvUploadProgressWrap');

    // Save metadata to Firestore
    const mediaData = {
      channelId,
      url:       res.url,
      key:       res.key,
      mediaKind,
      title:     title  || res.key.split('/').pop() || 'Untitled',
      artist:    artist || '',
      artworkUrl:'',
      fileName:  res.key.split('/').pop() || '',
      order:     _studioMedia.length,
      createdAt: Date.now(),
    };

    _fsAddDoc(_fsCollection(COL_MEDIA), mediaData)
      .then(() => {
        _showStatus('snxTvUploadStatus', '✓ Upload complete! Media added to channel.', 'ok');
        if (prog) setTimeout(() => prog.classList.remove('visible'), 1500);
        const fi = _el('snxTvUploadFile');
        if (fi) fi.value = '';
        const ti = _el('snxTvUploadTitle');
        if (ti) ti.value = '';
        const ai = _el('snxTvUploadArtist');
        if (ai) ai.value = '';
      })
      .catch(e => {
        _showStatus('snxTvUploadStatus', 'Firestore error: ' + e.message, 'err');
        if (prog) prog.classList.remove('visible');
      });
  }

  /* ════════════════════════════════════════════════════════════
     UTILITY
  ════════════════════════════════════════════════════════════ */

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _json(val) {
    return JSON.stringify(val);
  }

  /* ════════════════════════════════════════════════════════════
     PAGE OPEN / CLOSE lifecycle (called by navTo)
  ════════════════════════════════════════════════════════════ */

  function _pageOpen() {
    if (!global._snxFirestore || !global._snxFirestore.db) {
      console.error(LOG, 'Firestore not available — ensure firebase-config.js is loaded');
      return;
    }

    _ensurePageDom();

    // Defer Firestore subscription and founder UI until Firebase Auth has resolved.
    // Without this guard, navigating to tvPage before onAuthStateChanged fires causes
    // all Firestore reads/writes to run as unauthenticated, triggering permission-denied
    // on both the channels snapshot and the create-channel setDoc.
    const _open = () => {
      _subscribeChannels();
      if (_isFounder()) {
        _showStudioBar();
      } else {
        _hideStudioBar();
      }
    };

    if (global._snxOnAuthReady) {
      global._snxOnAuthReady(_open);
    } else {
      // Fallback: _snxOnAuthReady not available (e.g. standalone test), run immediately.
      _open();
    }
  }

  function _pageLeave() {
    // Don't stop playback when leaving — keep audio in background
    // Just unsubscribe non-essential listeners
  }

  function _pageDestroy() {
    _stopPlayback();
    if (_channelsUnsub) { _channelsUnsub(); _channelsUnsub = null; }
    if (_mediaUnsub)    { _mediaUnsub();    _mediaUnsub    = null; }
    if (_studioMediaUnsub) { _studioMediaUnsub(); _studioMediaUnsub = null; }
    _stopVizAnimation();
  }

  /* ════════════════════════════════════════════════════════════
     ENSURE PAGE DOM (idempotent)
  ════════════════════════════════════════════════════════════ */

  function _ensurePageDom() {
    const page = _el('tvPage');
    if (!page || _el('snxTvPlayerWrap')) return; // already built

    page.innerHTML = [
      '<h2 class="eclipse-title" style="margin:0 0 14px;">📺 Shadow Nexus TV</h2>',

      /* ── Player ── */
      '<div class="snx-tv-player-wrap" id="snxTvPlayerWrap">',
        '<div id="snxTvPlayerInner" style="width:100%;height:100%;position:relative;">',
          '<video id="snxTvVideo" data-snx-media-exempt="1" ',
            'playsinline webkit-playsinline preload="metadata" ',
            'style="display:none;"></video>',
          '<audio id="snxTvAudio" preload="none"></audio>',
          '<canvas id="snxTvVisualizer"></canvas>',
          '<div class="snx-tv-viz-overlay" id="snxTvVizOverlay">',
            '<div class="snx-tv-viz-title"></div>',
            '<div class="snx-tv-viz-artist"></div>',
          '</div>',
          '<div class="snx-tv-play-overlay" id="snxTvPlayOverlay">',
            '<button class="snx-tv-play-btn" id="snxTvPlayBtn">▶</button>',
            '<div class="snx-tv-play-label">Tap to enable playback</div>',
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

      /* ── Founder Studio Bar (hidden by default) ── */
      '<div class="snx-tv-studio-bar" id="snxTvStudioBar" style="display:none;">',
        '<span class="snx-tv-studio-label">👑 Founder Tools</span>',
        '<button class="snx-tv-studio-toggle-btn" id="snxTvStudioToggleBtn" ',
          'onclick="window.SNXTv.toggleStudio()">📺 TV Studio</button>',
      '</div>',

      /* ── Studio Panel ── */
      '<div class="snx-tv-studio-panel" id="snxTvStudioPanel">',

        /* Tabs */
        '<div class="snx-tv-studio-tabs">',
          '<button class="snx-tv-studio-tab active" data-tab="channels" ',
            'onclick="window.SNXTv.switchStudioTab(\'channels\')">Channels</button>',
          '<button class="snx-tv-studio-tab" data-tab="media" ',
            'onclick="window.SNXTv.switchStudioTab(\'media\')">Add Media</button>',
        '</div>',

        /* Channels pane */
        '<div class="snx-tv-studio-pane active" data-pane="channels">',
          '<p style="font-size:12px;color:#5a8aaa;margin:0 0 12px;">Create and manage TV channels.</p>',
          '<div class="snx-tv-create-ch-form">',
            '<label for="snxTvNewChName" style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">New Channel Name</label>',
            '<input id="snxTvNewChName" placeholder="e.g. Shadow Nexus TV" style="margin:4px 0 8px;">',
            '<label for="snxTvNewChDesc" style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Description (optional)</label>',
            '<input id="snxTvNewChDesc" placeholder="Short description" style="margin:4px 0 10px;">',
            '<button class="snx-tv-btn snx-tv-btn-success" ',
              'onclick="window.SNXTv.studioCreateChannel()" style="width:100%;padding:8px;">Create Channel</button>',
            '<div class="snx-tv-status" id="snxTvCreateChStatus"></div>',
          '</div>',
          '<p style="font-size:11px;color:#4a7a9a;margin:14px 0 8px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;">Your Channels</p>',
          '<ul class="snx-tv-ch-list" id="snxTvStudioChList"></ul>',
        '</div>',

        /* Media pane */
        '<div class="snx-tv-studio-pane" data-pane="media">',

          /* ── Step 1: Channel picker ── */
          '<p style="font-size:11px;color:#5a8aaa;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin:0 0 8px;">Step 1 — Select a Channel</p>',
          /* Selection status label */
          '<div id="snxTvAddMediaChLabel" style="font-size:13px;font-weight:600;color:#4a7a9a;margin-bottom:10px;padding:8px 10px;background:rgba(0,20,50,0.5);border:1px solid rgba(0,174,239,0.15);border-radius:8px;">',
            'No channels yet — create one on the Channels tab.',
          '</div>',
          /* Tappable channel cards container */
          '<div id="snxTvAddMediaChPicker" style="margin-bottom:16px;"></div>',
          /* Hidden <select> kept for upload fallback */
          '<select id="snxTvUploadChannelId" style="display:none;"></select>',

          /* ── Step 2: Upload form ── */
          '<p style="font-size:11px;color:#5a8aaa;font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin:0 0 8px;">Step 2 — Upload Media</p>',
          '<div class="snx-tv-upload-form">',
            '<label for="snxTvUploadKind" style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Media Type</label>',
            '<select id="snxTvUploadKind" style="margin:4px 0 8px;">',
              '<option value="video">Video</option>',
              '<option value="audio">Music / Audio</option>',
              '<option value="image">Artwork / Image</option>',
            '</select>',
            '<label for="snxTvUploadTitle" style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Title (optional)</label>',
            '<input id="snxTvUploadTitle" placeholder="Title" style="margin:4px 0 8px;">',
            '<label for="snxTvUploadArtist" style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">Artist / Creator (optional)</label>',
            '<input id="snxTvUploadArtist" placeholder="Artist name" style="margin:4px 0 8px;">',
            '<label for="snxTvUploadFile" style="font-size:11px;font-weight:700;color:#5a8aaa;letter-spacing:.5px;text-transform:uppercase;">File</label>',
            '<input type="file" id="snxTvUploadFile" accept="video/*,audio/*,image/*" style="margin:4px 0 10px;color:#c8e8ff;">',
            '<button class="snx-tv-btn snx-tv-btn-success" ',
              'onclick="window.SNXTv.studioUploadMedia()" style="width:100%;padding:8px;">Upload to Channel</button>',
            '<div class="snx-tv-progress-wrap" id="snxTvUploadProgressWrap">',
              '<div class="snx-tv-progress-bar" id="snxTvUploadProgressBar"></div>',
            '</div>',
            '<div class="snx-tv-status" id="snxTvUploadStatus"></div>',
          '</div>',

          /* ── Step 3: Media list for selected channel ── */
          '<p style="font-size:11px;color:#4a7a9a;margin:14px 0 8px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;" id="snxTvStudioMediaPaneTitle">Select a channel above</p>',
          '<ul class="snx-tv-media-list" id="snxTvStudioMediaList"></ul>',
        '</div>',

      '</div>', /* end studio panel */

    ].join('');

    /* Wire media element events */
    const vid = _el('snxTvVideo');
    const aud = _el('snxTvAudio');
    if (vid) {
      vid.addEventListener('ended', _advanceQueue);
      vid.addEventListener('error', () => {
        console.warn(LOG, 'video error — advancing queue');
        setTimeout(_advanceQueue, 1000);
      });
    }
    if (aud) {
      aud.addEventListener('ended', _advanceQueue);
      aud.addEventListener('error', () => {
        console.warn(LOG, 'audio error — advancing queue');
        setTimeout(_advanceQueue, 1000);
      });
    }

    /* Play overlay button */
    const btn = _el('snxTvPlayBtn');
    if (btn) btn.addEventListener('click', _onPlayOverlayClick);

    /* Populate channel select and channel picker in Add Media tab */
    _updateChannelSelect();
    _renderAddMediaChannelPicker();
  }

  /* Populate the hidden channel <select> (kept for upload fallback) */
  function _updateChannelSelect() {
    const sel = _el('snxTvUploadChannelId');
    if (!sel) return;
    sel.innerHTML = _channels.map(ch =>
      '<option value="' + _esc(ch.id) + '">' + _esc(ch.name) + '</option>'
    ).join('');
    if (_studioChannel && _channels.find(c => c.id === _studioChannel.id)) {
      sel.value = _studioChannel.id;
    }
  }

  /* Render tappable channel-selection cards inside the Add Media pane */
  function _renderAddMediaChannelPicker() {
    const container = _el('snxTvAddMediaChPicker');
    const label     = _el('snxTvAddMediaChLabel');
    const mediaTitle= _el('snxTvStudioMediaPaneTitle');

    // Update the selected-channel label above the upload form
    if (label) {
      if (_studioChannel) {
        label.innerHTML =
          '<span style="color:#00AEEF;">✔ Selected Channel:</span> ' +
          '<strong style="color:#e0f0ff;">' + _esc(_studioChannel.name) + '</strong>';
        label.style.color = '#c8e8ff';
      } else {
        label.textContent = _channels.length
          ? '⬆ Tap a channel below to select it before uploading.'
          : 'No channels yet — create one on the Channels tab.';
        label.style.color = '#4a7a9a';
      }
    }

    // Update media pane title (above media list)
    if (mediaTitle) {
      mediaTitle.textContent = _studioChannel
        ? 'Media for: ' + _studioChannel.name
        : 'Select a channel below';
    }

    // Sync hidden <select>
    _updateChannelSelect();

    if (!container) return;

    if (_channels.length === 0) {
      container.innerHTML =
        '<p style="color:#4a7a9a;font-size:13px;margin:0 0 12px;">No channels yet.</p>';
      return;
    }

    container.innerHTML = _channels.map(ch => {
      const selected  = _studioChannel && _studioChannel.id === ch.id;
      const artStyle  = ch.artworkUrl ? 'background-image:url(' + _esc(ch.artworkUrl) + ');background-size:cover;background-position:center;' : '';
      return (
        '<div class="snx-tv-channel-card' + (selected ? ' active-channel snx-tv-amch-selected' : '') + '" ' +
        'data-ch-id="' + _esc(ch.id) + '" ' +
        'role="button" tabindex="0" ' +
        'style="margin-bottom:8px;' + (selected ? 'border-color:rgba(0,174,239,0.90);box-shadow:0 0 18px rgba(0,174,239,0.30);' : '') + '" ' +
        'onclick="window.SNXTv.studioSelectChannel(' + _json(ch.id) + ')" ' +
        'onkeydown="if(event.key===\'Enter\'||event.key===\' \')window.SNXTv.studioSelectChannel(' + _json(ch.id) + ')">' +
          '<div class="snx-tv-ch-art" style="' + artStyle + '">' + (ch.artworkUrl ? '' : '📺') + '</div>' +
          '<div class="snx-tv-ch-info">' +
            '<div class="snx-tv-ch-name">' + _esc(ch.name) + '</div>' +
            '<div class="snx-tv-ch-meta">' + _esc(ch.description || '') + '</div>' +
          '</div>' +
          (selected
            ? '<span class="snx-tv-ch-badge playing">✔ Selected</span>'
            : '<span class="snx-tv-ch-badge">Select</span>') +
        '</div>'
      );
    }).join('');
  }

  /* Studio: Select a channel from the Add Media picker (does NOT navigate away) */
  function _studioSelectChannel(channelId) {
    const ch = _channels.find(c => c.id === channelId);
    if (!ch) return;
    _studioChannel = ch;
    _renderAddMediaChannelPicker();   // re-render highlights + label
    _loadStudioMedia(channelId);      // refresh media list for this channel
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

    /* Studio (founder) */
    toggleStudio:         _toggleStudio,
    switchStudioTab:      _switchStudioTab,
    studioCreateChannel:  _studioCreateChannel,
    studioDeleteChannel:  _studioDeleteChannel,
    studioOpenChannel:    _studioOpenChannel,
    studioSelectChannel:  _studioSelectChannel,
    studioDeleteMedia:    _studioDeleteMedia,
    studioUploadMedia:    _studioUploadMedia,

    /* Diagnostics */
    getBuild:    () => BUILD,
    getChannels: () => _channels,
    getQueue:    () => _mediaQueue,
  };

  _init();

})(window);
