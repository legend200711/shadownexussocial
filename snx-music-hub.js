/**
 * snx-music-hub.js — Shadow Nexus Music Hub 2.0
 *
 * Complete rebuild. One runtime. One player. Two storage providers.
 *
 * Architecture:
 *   - ONE Audio instance (window._snxMH2Audio)
 *   - Storage Router: window.MusicStorage (snx-music-storage.js)
 *   - Firebase Auth: window._snxCurrentUser / window._snxAuth
 *   - Firestore collections:
 *       mhTracks/{trackId}                  — canonical track catalog
 *       mhPlaylists/{playlistId}             — playlists
 *       mhQueue/{uid}                        — per-user queue
 *       musicHub/config/featured/{trackId}   — featured tracks (existing)
 *       siteSettings/radioConfig             — radio stream URL (existing)
 *
 * Legacy compatibility:
 *   - Reads cloudStreamTracks/{uid}/tracks/* (existing studio uploads)
 *   - Reads profileMusic/* (existing profile uploads)
 *   - All old tracks still play via getPlaybackUrl() legacy path
 *
 * Founder: christijerina46@gmail.com
 */

'use strict';

(function () {

/* ══════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════ */
var MH2_VERSION        = '2.0.0';
var MH2_FOUNDER_EMAIL  = 'christijerina46@gmail.com';
var MH2_COLL_TRACKS    = 'mhTracks';
var MH2_COLL_PLAYLISTS = 'mhPlaylists';
var MH2_COLL_QUEUE     = 'mhQueue';

/* ══════════════════════════════════════════════════════
   STATE
══════════════════════════════════════════════════════ */
var _s = {
  /* auth */
  user:          null,
  isFounder:     false,

  /* catalog */
  tracks:        [],   // merged catalog (mhTracks + legacy cloudStreamTracks)
  playlists:     [],
  featured:      [],
  queue:         [],   // active playback queue (track objects)

  /* playback */
  queueIndex:    0,
  playing:       false,
  shuffle:       false,
  repeatOne:     false,
  volume:        1.0,
  muted:         false,

  /* radio */
  radioPlaying:  false,
  radioAudio:    null,

  /* upload */
  uploadJobs:    [],
  uploading:     false,

  /* nav */
  activeTab:     'home',   // 'home'|'library'|'playlists'|'queue'|'playing'|'upload'|'radio'

  /* unsubs */
  _unsubTracks:  null,
  _unsubPlaylists: null,

  /* search */
  libraryQuery:  '',
  libraryFilter: 'all',  // 'all'|'cloudflare'|'supabase'|'legacy'
};

/* ══════════════════════════════════════════════════════
   SINGLE AUDIO INSTANCE
══════════════════════════════════════════════════════ */
var _audio = null;
function _getAudio() {
  if (!_audio) {
    _audio = new Audio();
    _audio.preload = 'metadata';
    window._snxMH2Audio = _audio;
    _audio.addEventListener('timeupdate',    _onTimeUpdate);
    _audio.addEventListener('ended',         _onEnded);
    _audio.addEventListener('loadedmetadata',_onMeta);
    _audio.addEventListener('error',         _onAudioError);
    _audio.addEventListener('play',  function(){ _s.playing = true;  _renderPlayer(); });
    _audio.addEventListener('pause', function(){ _s.playing = false; _renderPlayer(); });
  }
  return _audio;
}

/* ══════════════════════════════════════════════════════
   AUTH / FIRESTORE HELPERS
══════════════════════════════════════════════════════ */
function _user()  { return window._snxCurrentUser || null; }
function _uid()   { var u = _user(); return u ? u.uid : null; }
function _fs()    { return window._snxFirestore || null; }
function _isFounder() {
  var u = _user();
  if (!u) return false;
  return (u.email||'').trim().toLowerCase() === MH2_FOUNDER_EMAIL
      || window._snxRole === 'founder';
}

/* ══════════════════════════════════════════════════════
   TRACK MODEL HELPERS
══════════════════════════════════════════════════════ */
function _playbackUrl(track) {
  if (window.MusicStorage) return window.MusicStorage.getPlaybackUrl(track);
  return track.musicUrl || track.downloadURL || track.url || '';
}

function _artworkUrl(track) {
  if (window.MusicStorage) return window.MusicStorage.getArtworkUrl(track);
  return track.artworkUrl || track.coverUrl || track.coverArt || '';
}

function _providerBadge(track) {
  var p = track.storageProvider || (track.r2Key ? 'cloudflare' : 'legacy');
  if (p === 'cloudflare') return '&#9729; R2';
  if (p === 'supabase')   return '&#9670; SUP';
  return '';
}

function _fmt(s) {
  if (!isFinite(s) || s < 0) return '0:00';
  var m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}

function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function _genId() {
  return 'mh2' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ══════════════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════════════ */
function _toast(msg, type) {
  if (typeof window.toastNotification === 'function') { window.toastNotification(msg); return; }
  if (typeof window.snxToast === 'function') { window.snxToast(msg, type || 'info'); return; }
  var el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#0d2444;border:1px solid rgba(0,174,239,0.4);color:#fff;font-size:13px;padding:10px 18px;border-radius:30px;z-index:99999;pointer-events:none;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;';
  document.body.appendChild(el);
  setTimeout(function(){ el.remove(); }, 3000);
}

/* ══════════════════════════════════════════════════════
   LOAD CATALOG
   Merges: mhTracks (new) + cloudStreamTracks (legacy) + profileMusic (legacy)
══════════════════════════════════════════════════════ */
function _loadCatalog() {
  var fs  = _fs();
  var uid = _uid();
  if (!fs || !uid) return;

  var seen = {};
  var all  = [];

  function _merge(docs) {
    docs.forEach(function(d) {
      if (!seen[d.id]) { seen[d.id] = true; all.push(d); }
    });
  }

  // 1. New mhTracks catalog (global — founder uploads go here)
  var p1 = fs.getDocs(fs.query(
    fs.collection(fs.db, MH2_COLL_TRACKS),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(200)
  )).then(function(snap) {
    if (!snap || !snap.docs) return;
    _merge(snap.docs.map(function(d){ return Object.assign({ id: d.id, _catalog: 'mh2' }, d.data()); }));
  }).catch(function(e){ console.warn('[MH2] mhTracks load failed:', e.message); });

  // 2. Legacy: cloudStreamTracks/{uid}/tracks
  var p2 = fs.getDocs(fs.query(
    fs.collection(fs.db, 'cloudStreamTracks', uid, 'tracks'),
    fs.orderBy('uploadedAt', 'desc'),
    fs.limit(300)
  )).then(function(snap) {
    if (!snap || !snap.docs) return;
    _merge(snap.docs.map(function(d){
      var t = Object.assign({ id: d.id, _catalog: 'legacy' }, d.data());
      // normalize field names
      if (!t.storageProvider) t.storageProvider = t.r2Key ? 'cloudflare' : 'legacy';
      if (!t.playbackReference && (t.url || t.musicUrl)) t.playbackReference = t.url || t.musicUrl;
      return t;
    }));
  }).catch(function(){ /* index may not exist */ });

  // 3. Legacy: profileMusic (global collection)
  var p3 = fs.getDocs(fs.query(
    fs.collection(fs.db, 'profileMusic'),
    fs.where('ownerUid', '==', uid),
    fs.limit(100)
  )).then(function(snap) {
    if (!snap || !snap.docs) return;
    _merge(snap.docs.map(function(d){
      var t = Object.assign({ id: d.id, _catalog: 'profile' }, d.data());
      if (!t.storageProvider) t.storageProvider = t.r2Key ? 'cloudflare' : 'legacy';
      if (!t.playbackReference) t.playbackReference = t.musicUrl || t.downloadURL || t.url || '';
      return t;
    }));
  }).catch(function(){});

  Promise.all([p1, p2, p3]).then(function() {
    // Sort by date descending
    all.sort(function(a, b) {
      var ta = (a.createdAt && a.createdAt.seconds) || (a.uploadedAt ? a.uploadedAt / 1000 : 0);
      var tb = (b.createdAt && b.createdAt.seconds) || (b.uploadedAt ? b.uploadedAt / 1000 : 0);
      return tb - ta;
    });
    _s.tracks = all;
    _renderLibrary();
    _renderQueue();
    _renderPlayer();
    _renderRecent();
    console.log('[MH2] Catalog loaded:', all.length, 'tracks');
  });
}

/* ══════════════════════════════════════════════════════
   LOAD PLAYLISTS
══════════════════════════════════════════════════════ */
function _loadPlaylists() {
  var fs  = _fs();
  var uid = _uid();
  if (!fs || !uid) return;

  // New mhPlaylists collection
  var p1 = fs.getDocs(fs.query(
    fs.collection(fs.db, MH2_COLL_PLAYLISTS),
    fs.where('ownerUid', '==', uid),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(100)
  )).then(function(snap) {
    if (!snap || !snap.docs) return [];
    return snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
  }).catch(function(){ return []; });

  // Legacy: studioPlaylists/{uid}/playlists
  var p2 = fs.getDocs(fs.query(
    fs.collection(fs.db, 'studioPlaylists', uid, 'playlists'),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(100)
  )).then(function(snap) {
    if (!snap || !snap.docs) return [];
    return snap.docs.map(function(d){ return Object.assign({ id: d.id, _legacy: true }, d.data()); });
  }).catch(function(){ return []; });

  Promise.all([p1, p2]).then(function(results) {
    var seen = {};
    _s.playlists = [];
    [].concat(results[0], results[1]).forEach(function(pl) {
      if (!seen[pl.id]) { seen[pl.id] = true; _s.playlists.push(pl); }
    });
    _renderPlaylists();
  });
}

/* ══════════════════════════════════════════════════════
   LOAD FEATURED
══════════════════════════════════════════════════════ */
function _loadFeatured() {
  var fs = _fs();
  if (!fs) return;
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'musicHub', 'config', 'featured'),
    fs.orderBy('featuredAt', 'desc'),
    fs.limit(20)
  )).then(function(snap) {
    if (!snap || !snap.docs) return;
    _s.featured = snap.docs.map(function(d){ return Object.assign({ id: d.id }, d.data()); });
    _renderFeatured();
  }).catch(function(){});
}

/* ══════════════════════════════════════════════════════
   PLAYBACK
══════════════════════════════════════════════════════ */
function _loadTrack(idx, autoPlay) {
  if (!_s.queue.length) return;
  if (idx < 0) idx = _s.queue.length - 1;
  if (idx >= _s.queue.length) idx = 0;
  _s.queueIndex = idx;

  var track = _s.queue[idx];
  var url   = _playbackUrl(track);

  var a = _getAudio();
  a.pause();
  a.src = '';

  if (!url) {
    _toast('Track unavailable — no playable URL found.');
    _renderPlayer();
    return;
  }

  // Coordinate with other audio sources
  if (window.SNXAudioCoordinator) window.SNXAudioCoordinator.request('musicHub');

  a.src = url;
  a.volume = _s.muted ? 0 : _s.volume;
  a.load();

  if (autoPlay) {
    a.play().catch(function(e){ console.warn('[MH2] Autoplay blocked:', e.message); });
  }

  _renderPlayer();
  _renderQueue();
}

function _togglePlay() {
  var a = _getAudio();
  if (_s.playing) { a.pause(); }
  else {
    if (!a.src && _s.queue.length) { _loadTrack(_s.queueIndex, true); return; }
    if (window.SNXAudioCoordinator) window.SNXAudioCoordinator.request('musicHub');
    a.play().catch(function(e){ console.warn('[MH2] Play failed:', e.message); });
  }
}

function _next() {
  if (!_s.queue.length) return;
  var idx;
  if (_s.shuffle) {
    idx = Math.floor(Math.random() * _s.queue.length);
  } else {
    idx = (_s.queueIndex + 1) % _s.queue.length;
  }
  _loadTrack(idx, _s.playing);
}

function _prev() {
  if (!_s.queue.length) return;
  var a = _getAudio();
  if (a.currentTime > 3) { a.currentTime = 0; return; }
  var idx = (_s.queueIndex - 1 + _s.queue.length) % _s.queue.length;
  _loadTrack(idx, _s.playing);
}

function _onEnded() {
  if (_s.repeatOne) {
    var a = _getAudio();
    a.currentTime = 0;
    a.play().catch(function(){});
    return;
  }
  _next();
}

function _onTimeUpdate() {
  _updateProgress();
}

function _onMeta() {
  var a = _getAudio();
  var durEl = document.getElementById('snxMH2Duration');
  if (durEl) durEl.textContent = _fmt(a.duration || 0);
}

function _onAudioError() {
  var a = _audio;
  var track = _s.queue[_s.queueIndex];
  var title = track ? (track.title || track.id) : '(unknown)';
  console.error('[MH2] Audio error on track:', title, a && a.error);
  _toast('\u26A0 Track unavailable: ' + title + '. Skipping…');
  if (_s.queue.length > 1) {
    setTimeout(_next, 800);
  } else {
    _s.playing = false;
    _renderPlayer();
  }
}

function _updateProgress() {
  var a = _getAudio();
  var cur = a.currentTime || 0;
  var dur = (isFinite(a.duration) && a.duration > 0) ? a.duration : 0;
  var pct = dur > 0 ? (cur / dur) * 100 : 0;

  var fillEl = document.getElementById('snxMH2ProgressFill');
  var curEl  = document.getElementById('snxMH2CurrentTime');
  var durEl  = document.getElementById('snxMH2Duration');

  if (fillEl) fillEl.style.width = pct.toFixed(2) + '%';
  if (curEl)  curEl.textContent  = _fmt(cur);
  if (durEl && dur > 0) durEl.textContent = _fmt(dur);
}

/* ══════════════════════════════════════════════════════
   QUEUE MANAGEMENT
══════════════════════════════════════════════════════ */
function _addToQueue(track, playNow) {
  if (!track) return;
  var already = _s.queue.findIndex(function(q){ return q.id === track.id; });
  if (already !== -1 && !playNow) { _toast('"' + (track.title||'Track') + '" is already in the queue.'); return; }
  if (already === -1) _s.queue.push(track);
  if (playNow) {
    var idx = _s.queue.findIndex(function(q){ return q.id === track.id; });
    _loadTrack(idx, true);
  }
  _renderQueue();
}

function _playFromLibrary(trackId) {
  var track = _s.tracks.find(function(t){ return t.id === trackId; });
  if (!track) return;
  _addToQueue(track, true);
}

/* ══════════════════════════════════════════════════════
   RENDER: PLAYER
══════════════════════════════════════════════════════ */
function _artFallbackHTML(size) {
  return '<div class="mh2-art-fallback" style="width:' + (size||42) + 'px;height:' + (size||42) + 'px;">' +
    '<span class="mh2-art-fallback-icon">&#9835;</span></div>';
}

function _renderPlayer() {
  var el = document.getElementById('snxMH2PlayerBar');
  if (!el) return;

  var track  = _s.queue[_s.queueIndex] || null;
  var art    = track ? _artworkUrl(track) : '';
  var title  = track ? (track.title  || 'Untitled') : 'Nothing playing';
  var artist = track ? (track.artist || '') : '';

  el.innerHTML =
    '<div class="mh2-player">' +
      '<div class="mh2-player-top-row">' +
        '<div class="mh2-player-art" onclick="snxMH2SwitchTab(\'playing\')" title="Open full player">' +
          (art
            ? '<img src="' + _esc(art) + '" alt="cover" style="width:100%;height:100%;object-fit:cover;" onerror="this.style.display=\'none\'">'
            : _artFallbackHTML(42)) +
        '</div>' +
        '<div class="mh2-player-info" onclick="snxMH2SwitchTab(\'playing\')">' +
          '<div class="mh2-player-title">' + _esc(title) + '</div>' +
          '<div class="mh2-player-artist">' + _esc(artist) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mh2-player-progress-row">' +
        '<span class="mh2-player-time" id="snxMH2CurrentTime">0:00</span>' +
        '<div class="mh2-player-seek" id="snxMH2SeekBar" onclick="snxMH2Seek(event,this)" role="progressbar" aria-label="Seek">' +
          '<div class="mh2-player-seek-fill" id="snxMH2ProgressFill"></div>' +
        '</div>' +
        '<span class="mh2-player-time" id="snxMH2Duration">0:00</span>' +
      '</div>' +
      '<div class="mh2-player-controls">' +
        '<button class="mh2-ctrl-btn' + (_s.shuffle ? ' active' : '') + '" onclick="snxMH2ToggleShuffle()" title="Shuffle" aria-label="Shuffle">&#128256;</button>' +
        '<button class="mh2-ctrl-btn" onclick="snxMH2Prev()" title="Previous" aria-label="Previous">&#9198;</button>' +
        '<button class="mh2-ctrl-btn mh2-ctrl-play" onclick="snxMH2PlayPause()" title="Play/Pause" aria-label="' + (_s.playing ? 'Pause' : 'Play') + '">' +
          (_s.playing ? '&#9646;&#9646;' : '&#9654;') +
        '</button>' +
        '<button class="mh2-ctrl-btn" onclick="snxMH2Next()" title="Next" aria-label="Next">&#9197;</button>' +
        '<button class="mh2-ctrl-btn' + (_s.repeatOne ? ' active' : '') + '" onclick="snxMH2ToggleRepeat()" title="Repeat" aria-label="Repeat">&#9854;</button>' +
        '<button class="mh2-ctrl-btn" onclick="snxMH2ToggleMute()" title="Volume" aria-label="' + (_s.muted ? 'Unmute' : 'Mute') + '">' +
          (_s.muted ? '&#128263;' : '&#128266;') +
        '</button>' +
      '</div>' +
    '</div>';

  _updateHomeNPCard();
}

/* ══════════════════════════════════════════════════════
   HOME: Update Now Playing card
   No new audio — UI only
══════════════════════════════════════════════════════ */
function _updateHomeNPCard() {
  var npEmptyEl  = document.getElementById('snxMH2NPEmpty');
  var npActiveEl = document.getElementById('snxMH2NPActive');
  var artGlow    = document.getElementById('snxMH2NPArtGlow');
  if (!npEmptyEl || !npActiveEl) return;

  var track = _s.queue[_s.queueIndex] || null;
  var isActive = (_s.playing || _s.radioPlaying) && (track || _s.radioPlaying);

  if (isActive) {
    npEmptyEl.style.display  = 'none';
    npActiveEl.style.display = '';

    var npTitle  = document.getElementById('snxMH2NPTitle');
    var npArtist = document.getElementById('snxMH2NPArtist');
    var npCover  = document.getElementById('snxMH2NPCover');

    if (_s.radioPlaying) {
      if (npTitle)  npTitle.textContent  = 'SHADOW NEXUS RADIO';
      if (npArtist) npArtist.textContent = '\uD83D\uDD34 ON AIR';
      if (npCover)  npCover.innerHTML    = '<div class="mh2-art-fallback"><span class="mh2-art-fallback-icon">&#128251;</span></div>';
      if (artGlow)  artGlow.style.backgroundImage = 'none';
    } else if (track) {
      if (npTitle)  npTitle.textContent  = track.title  || 'Now Playing';
      if (npArtist) npArtist.textContent = track.artist || '';
      var art = _artworkUrl(track);
      if (npCover) {
        if (art) {
          npCover.innerHTML = '<img src="' + _esc(art) + '" alt="cover" style="width:100%;height:100%;object-fit:cover;display:block;" onerror="this.parentElement.innerHTML=\'<div class=&quot;mh2-art-fallback&quot;><span class=&quot;mh2-art-fallback-icon&quot;>&#9835;</span></div>\'">';
        } else {
          npCover.innerHTML = '<div class="mh2-art-fallback"><span class="mh2-art-fallback-icon">&#9835;</span></div>';
        }
        if (artGlow) artGlow.style.backgroundImage = art ? 'url(' + art + ')' : 'none';
      }
    }
    // Update home radio dot
    _updateHomeDot();
  } else {
    npEmptyEl.style.display  = '';
    npActiveEl.style.display = 'none';
    if (artGlow) artGlow.style.backgroundImage = 'none';
  }
}

function _updateHomeDot() {
  var dot   = document.getElementById('snxMH2HomeDot');
  var label = document.getElementById('snxMH2HomeAirLabel');
  var btn   = document.getElementById('snxMH2HomeRadioBtn');
  if (dot) dot.className = 'mh2-radio-dot' + (_s.radioPlaying ? ' live' : '');
  if (label) label.textContent = _s.radioPlaying ? 'ON AIR' : 'OFF AIR';
  if (btn) {
    btn.className = 'mh2-radio-btn-sm' + (_s.radioPlaying ? ' listening' : '');
    btn.textContent = _s.radioPlaying ? 'STOP RADIO' : 'ENTER RADIO';
    if (_s.radioPlaying) {
      btn.onclick = function(e){ e.stopPropagation(); snxMH2RadioToggle(); };
    } else {
      btn.onclick = function(){ snxMH2SwitchTab('radio'); };
    }
  }
}

/* ══════════════════════════════════════════════════════
   RENDER: NEXUS PLAYER FULL SCREEN (Playing tab)
   Connects to the ONE audio engine — no new Audio()
══════════════════════════════════════════════════════ */
function _renderPlayingScreen() {
  var el = document.getElementById('snxMH2Tab_playing');
  if (!el) return;

  var track  = _s.queue[_s.queueIndex] || null;
  var art    = track ? _artworkUrl(track) : '';
  var title  = track ? (track.title  || 'Untitled') : 'Nothing playing';
  var artist = track ? (track.artist || '') : '';
  var album  = track ? (track.album  || '') : '';
  var isFounder = _isFounder();

  var artHTML = art
    ? '<img src="' + _esc(art) + '" alt="cover" class="mh2-ps-cover" onerror="this.parentElement.querySelector(\'.mh2-ps-art-glow\').style.display=\'none\';this.style.display=\'none\';">'
    : '';
  var glowStyle = art ? 'background-image:url(' + _esc(art) + ');' : 'display:none;';

  el.innerHTML =
    '<div class="mh2-playing-screen">' +
      '<div class="mh2-ps-art">' +
        '<div class="mh2-ps-art-glow" style="' + glowStyle + '"></div>' +
        (artHTML || '<div class="mh2-art-fallback" style="width:100%;height:100%;position:relative;z-index:1;"><span class="mh2-art-fallback-icon" style="font-size:64px;">&#9835;</span></div>') +
      '</div>' +
      '<div class="mh2-ps-meta">' +
        '<div class="mh2-ps-title">' + _esc(title) + '</div>' +
        '<div class="mh2-ps-artist">' + _esc(artist) + (album ? ' &mdash; ' + _esc(album) : '') + '</div>' +
        (track && isFounder ? '<div class="mh2-ps-badge">' + _providerBadge(track) + '</div>' : '') +
      '</div>' +
      '<div class="mh2-ps-progress">' +
        '<span id="snxMH2PSCurrentTime">0:00</span>' +
        '<div class="mh2-ps-seek" onclick="snxMH2Seek(event,this)" role="progressbar" aria-label="Seek">' +
          '<div class="mh2-ps-seek-fill" id="snxMH2PSFill"></div>' +
        '</div>' +
        '<span id="snxMH2PSDuration">0:00</span>' +
      '</div>' +
      '<div class="mh2-ps-controls">' +
        '<button class="mh2-ps-btn' + (_s.shuffle ? ' active' : '') + '" onclick="snxMH2ToggleShuffle()" aria-label="Shuffle">&#128256;</button>' +
        '<button class="mh2-ps-btn" onclick="snxMH2Prev()" aria-label="Previous">&#9198;</button>' +
        '<button class="mh2-ps-btn mh2-ps-play" onclick="snxMH2PlayPause()" aria-label="' + (_s.playing ? 'Pause' : 'Play') + '">' +
          (_s.playing ? '&#9646;&#9646;' : '&#9654;') +
        '</button>' +
        '<button class="mh2-ps-btn" onclick="snxMH2Next()" aria-label="Next">&#9197;</button>' +
        '<button class="mh2-ps-btn' + (_s.repeatOne ? ' active' : '') + '" onclick="snxMH2ToggleRepeat()" aria-label="Repeat">&#9854;</button>' +
      '</div>' +
      '<div class="mh2-ps-vol-row">' +
        '<span aria-hidden="true">&#128263;</span>' +
        '<input type="range" min="0" max="1" step="0.02" value="' + _s.volume + '" class="mh2-vol-slider" oninput="snxMH2SetVolume(this.value)" aria-label="Volume">' +
        '<span aria-hidden="true">&#128266;</span>' +
      '</div>' +
      '<div class="mh2-ps-queue-label">UP NEXT</div>' +
      '<div id="snxMH2PSQueue">' + _buildQueueHTML(true) + '</div>' +
    '</div>';

  _updatePlayingScreenProgress();
}

function _updatePlayingScreenProgress() {
  var a   = _getAudio();
  var cur = a.currentTime || 0;
  var dur = (isFinite(a.duration) && a.duration > 0) ? a.duration : 0;
  var pct = dur > 0 ? (cur / dur) * 100 : 0;

  var fillEl = document.getElementById('snxMH2PSFill');
  var curEl  = document.getElementById('snxMH2PSCurrentTime');
  var durEl  = document.getElementById('snxMH2PSDuration');
  if (fillEl) fillEl.style.width = pct.toFixed(2) + '%';
  if (curEl)  curEl.textContent  = _fmt(cur);
  if (durEl && dur > 0) durEl.textContent = _fmt(dur);
}

/* ══════════════════════════════════════════════════════
   RENDER: LIBRARY
══════════════════════════════════════════════════════ */
function _renderLibrary() {
  var el = document.getElementById('snxMH2LibraryList');
  if (!el) return;

  var q   = (_s.libraryQuery || '').toLowerCase();
  var fil = _s.libraryFilter;

  var tracks = _s.tracks.filter(function(t) {
    if (fil !== 'all') {
      var p = t.storageProvider || (t.r2Key ? 'cloudflare' : 'legacy');
      if (p !== fil) return false;
    }
    if (!q) return true;
    return (t.title  || '').toLowerCase().includes(q)
        || (t.artist || '').toLowerCase().includes(q)
        || (t.album  || '').toLowerCase().includes(q)
        || (t.genre  || '').toLowerCase().includes(q);
  });

  var countEl = document.getElementById('snxMH2LibCount');
  if (countEl) countEl.textContent = tracks.length + ' track' + (tracks.length !== 1 ? 's' : '');

  if (!tracks.length) {
    el.innerHTML = '<div class="mh2-empty"><div class="mh2-empty-icon">&#127925;</div>' +
      (q ? 'No tracks match "' + _esc(q) + '".' : 'No tracks yet.') + '</div>';
    return;
  }

  var isFounder = _isFounder();
  el.innerHTML = tracks.map(function(t) {
    var isCurrent = _s.queue[_s.queueIndex] && _s.queue[_s.queueIndex].id === t.id && _s.playing;
    var art = _artworkUrl(t);
    var badge = isFounder ? _providerBadge(t) : '';
    var artInner = art
      ? '<img src="' + _esc(art) + '" alt="" style="width:100%;height:100%;object-fit:cover;" onerror="this.parentElement.innerHTML=\'<div class=&quot;mh2-art-fallback&quot; style=&quot;width:100%;height:100%;&quot;><span class=&quot;mh2-art-fallback-icon&quot; style=&quot;font-size:14px;&quot;>&#9835;</span></div>\'">'
      : '<div class="mh2-art-fallback" style="width:100%;height:100%;"><span class="mh2-art-fallback-icon" style="font-size:14px;">&#9835;</span></div>';
    return '<div class="mh2-track-item' + (isCurrent ? ' mh2-track-playing' : '') + '" data-tid="' + _esc(t.id) + '">' +
      '<div class="mh2-track-art" onclick="snxMH2PlayFromLibrary(\'' + _esc(t.id) + '\')">' +
        artInner +
        '<div class="mh2-track-play-overlay">' + (isCurrent ? '&#9646;&#9646;' : '&#9654;') + '</div>' +
      '</div>' +
      '<div class="mh2-track-info" onclick="snxMH2PlayFromLibrary(\'' + _esc(t.id) + '\')">' +
        '<div class="mh2-track-title">' + _esc(t.title || 'Untitled') +
          (isCurrent ? '<span class="mh2-eq-inline" aria-hidden="true"><span></span><span></span><span></span></span>' : '') +
        '</div>' +
        '<div class="mh2-track-meta-line">' +
          _esc(t.artist || '') +
          (t.album ? ' &bull; ' + _esc(t.album) : '') +
          (t.duration ? ' &bull; ' + _fmt(t.duration) : '') +
          (badge ? ' <span class="mh2-provider-badge">' + badge + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<button class="mh2-act-btn" onclick="event.stopPropagation();snxMH2ShowTrackMenu(\'' + _esc(t.id) + '\')" aria-label="Track options">&#8942;</button>' +
    '</div>';
  }).join('');
}

/* ══════════════════════════════════════════════════════
   RENDER: QUEUE
══════════════════════════════════════════════════════ */
function _buildQueueHTML(compact) {
  if (!_s.queue.length) {
    return '<div class="mh2-empty" style="padding:16px 0;">Queue is empty. Add tracks from the Library.</div>';
  }
  return _s.queue.map(function(t, i) {
    var isCur = (i === _s.queueIndex);
    return '<div class="mh2-track-item' + (isCur ? ' mh2-track-playing' : '') + '">' +
      '<div class="mh2-track-art mh2-track-art-sm" onclick="snxMH2QueueJump(' + i + ')" style="font-size:12px;color:#5a90b8;">' +
        (isCur
          ? '<span class="mh2-eq-inline" aria-hidden="true"><span></span><span></span><span></span></span>'
          : '<span style="font-size:11px;color:#4a7a9a;">' + (i + 1) + '</span>') +
      '</div>' +
      '<div class="mh2-track-info" onclick="snxMH2QueueJump(' + i + ')">' +
        '<div class="mh2-track-title">' + _esc(t.title || 'Untitled') + '</div>' +
        '<div class="mh2-track-meta-line">' + _esc(t.artist || '') + (t.duration ? ' &bull; ' + _fmt(t.duration) : '') + '</div>' +
      '</div>' +
      (compact ? '' :
        '<button class="mh2-act-btn" onclick="snxMH2QueueRemove(' + i + ')" title="Remove from queue" aria-label="Remove from queue" style="color:#ff3355;">&#10005;</button>'
      ) +
    '</div>';
  }).join('');
}

function _renderQueue() {
  var el = document.getElementById('snxMH2QueueList');
  if (!el) return;
  el.innerHTML = _buildQueueHTML(false);

  // Also update playing screen queue if visible
  var psq = document.getElementById('snxMH2PSQueue');
  if (psq) psq.innerHTML = _buildQueueHTML(true);
}

/* ══════════════════════════════════════════════════════
   RENDER: PLAYLISTS
══════════════════════════════════════════════════════ */
function _renderPlaylists() {
  var el = document.getElementById('snxMH2PlaylistGrid');
  var isFounder = _isFounder();

  if (el) {
    if (!_s.playlists.length) {
      el.innerHTML = '<div class="mh2-empty"><span class="mh2-empty-icon">&#127756;</span>' +
        (isFounder ? 'No playlists yet. Create your first one.' : 'No playlists available.') + '</div>';
    } else {
      el.innerHTML = _s.playlists.map(function(pl) {
        var count = pl.trackIds ? pl.trackIds.length : 0;
        return '<div class="mh2-pl-card" onclick="snxMH2OpenPlaylist(\'' + _esc(pl.id) + '\')" role="listitem">' +
          '<div class="mh2-pl-art">&#127756;</div>' +
          '<div class="mh2-pl-name">' + _esc(pl.name || 'Untitled Playlist') + '</div>' +
          '<div class="mh2-pl-count">' + count + ' track' + (count !== 1 ? 's' : '') + '</div>' +
          (isFounder ?
            '<div class="mh2-pl-actions">' +
              '<button class="mh2-act-btn" onclick="event.stopPropagation();snxMH2PlaylistPlayAll(\'' + _esc(pl.id) + '\')" aria-label="Play all" title="Play All" style="font-size:14px;">&#9654;</button>' +
              '<button class="mh2-act-btn" onclick="event.stopPropagation();snxMH2DeletePlaylist(\'' + _esc(pl.id) + '\')" aria-label="Delete playlist" title="Delete" style="color:#ff3355;font-size:14px;">&#128465;</button>' +
            '</div>' : '') +
        '</div>';
      }).join('');
    }
  }

  // Keep home playlist scroll in sync
  _renderHomePlaylists();
}

/* ══════════════════════════════════════════════════════
   RENDER: FEATURED IN THE NEXUS
   Hero track + smaller rows for remaining
══════════════════════════════════════════════════════ */
function _renderFeatured() {
  var el = document.getElementById('snxMH2FeaturedList');
  if (!el) return;

  var isFounder = _isFounder();

  if (!_s.featured.length) {
    el.innerHTML = '<div class="mh2-empty"><span class="mh2-empty-icon">&#11088;</span>No featured tracks yet.</div>';
    return;
  }

  var hero = _s.featured[0];
  var heroArt = hero.artworkUrl || hero.coverUrl || hero.coverArt || '';

  var heroHtml =
    '<div class="mh2-featured-hero" onclick="snxMH2PlayFeatured(\'' + _esc(hero.id) + '\')" aria-label="Play ' + _esc(hero.title || 'featured track') + '">' +
      '<div class="mh2-featured-hero-inner">' +
        '<div class="mh2-featured-hero-art">' +
          (heroArt
            ? '<img src="' + _esc(heroArt) + '" alt="cover" onerror="this.parentElement.innerHTML=\'&#11088;\'">'
            : '&#11088;') +
        '</div>' +
        '<div class="mh2-featured-hero-info">' +
          '<div class="mh2-featured-hero-badge">FEATURED</div>' +
          '<div class="mh2-featured-hero-title">' + _esc(hero.title || 'Untitled') + '</div>' +
          '<div class="mh2-featured-hero-artist">' + _esc(hero.artist || '') + '</div>' +
        '</div>' +
        '<div class="mh2-featured-hero-action">' +
          '<button class="mh2-featured-play-btn" onclick="event.stopPropagation();snxMH2PlayFeatured(\'' + _esc(hero.id) + '\')" aria-label="Play">&#9654;</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  var restHtml = _s.featured.slice(1).map(function(f) {
    var art = f.artworkUrl || f.coverUrl || f.coverArt || '';
    return '<div class="mh2-featured-item" onclick="snxMH2PlayFeatured(\'' + _esc(f.id) + '\')">' +
      '<div class="mh2-featured-art">' +
        (art ? '<img src="' + _esc(art) + '" alt="" onerror="this.style.display=\'none\'">' : '&#9835;') +
      '</div>' +
      '<div class="mh2-featured-info">' +
        '<div class="mh2-featured-title">' + _esc(f.title || 'Untitled') + '</div>' +
        '<div class="mh2-featured-artist">' + _esc(f.artist || '') + '</div>' +
      '</div>' +
      (isFounder ? '<button class="mh2-unfeature-btn" onclick="event.stopPropagation();snxMH2UnfeatureTrack(\'' + _esc(f.id) + '\')" aria-label="Remove from featured">&#10005;</button>' : '') +
    '</div>';
  }).join('');

  el.innerHTML = heroHtml + restHtml;

  // Founder can unfeature the hero too — add the button after rendering
  if (isFounder) {
    var heroEl = el.querySelector('.mh2-featured-hero');
    if (heroEl) {
      var ufBtn = document.createElement('button');
      ufBtn.className = 'mh2-unfeature-btn';
      ufBtn.setAttribute('aria-label', 'Remove from featured');
      ufBtn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:2;';
      ufBtn.innerHTML = '&#10005;';
      ufBtn.onclick = function(e){ e.stopPropagation(); snxMH2UnfeatureTrack(hero.id); };
      heroEl.style.position = 'relative';
      heroEl.appendChild(ufBtn);
    }
  }
}

/* ══════════════════════════════════════════════════════
   RENDER: HOME TAB SECTIONS
══════════════════════════════════════════════════════ */
function _renderRecent() {
  var el = document.getElementById('snxMH2RecentList');
  if (!el) return;
  var recent = _s.tracks.slice(0, 8);
  if (!recent.length) {
    el.innerHTML = '<div class="mh2-empty"><span class="mh2-empty-icon">&#127925;</span>No music added yet.</div>';
    return;
  }
  var curId = _s.queue[_s.queueIndex] && _s.queue[_s.queueIndex].id;
  el.innerHTML = recent.map(function(t) {
    var art = _artworkUrl(t);
    var isCurrent = t.id === curId && _s.playing;
    return '<div class="mh2-track-item' + (isCurrent ? ' mh2-track-playing' : '') + '" onclick="snxMH2PlayFromLibrary(\'' + _esc(t.id) + '\')">' +
      '<div class="mh2-track-art mh2-track-art-sm">' +
        (art ? '<img src="' + _esc(art) + '" alt="" onerror="this.parentElement.innerHTML=\'<div class=&quot;mh2-art-fallback&quot; style=&quot;width:100%;height:100%;&quot;><span class=&quot;mh2-art-fallback-icon&quot; style=&quot;font-size:13px;&quot;>&#9835;</span></div>\'">'
             : '<div class="mh2-art-fallback" style="width:100%;height:100%;"><span class="mh2-art-fallback-icon" style="font-size:13px;">&#9835;</span></div>') +
        '<div class="mh2-track-play-overlay">' + (isCurrent ? '&#9646;&#9646;' : '&#9654;') + '</div>' +
      '</div>' +
      '<div class="mh2-track-info">' +
        '<div class="mh2-track-title">' + _esc(t.title || 'Untitled') +
          (isCurrent ? '<span class="mh2-eq-inline" aria-hidden="true"><span></span><span></span><span></span></span>' : '') +
        '</div>' +
        '<div class="mh2-track-meta-line">' + _esc(t.artist || '') + (t.duration ? ' &bull; ' + _fmt(t.duration) : '') + '</div>' +
      '</div>' +
      '<button class="mh2-act-btn" onclick="event.stopPropagation();snxMH2ShowTrackMenu(\'' + _esc(t.id) + '\')" aria-label="More options">&#8942;</button>' +
    '</div>';
  }).join('');
}

/* Render home playlist scroll (Playlist Universe) */
function _renderHomePlaylists() {
  var el = document.getElementById('snxMH2HomePlaylistScroll');
  if (!el) return;
  if (!_s.playlists.length) {
    el.innerHTML = '<div class="mh2-empty" style="padding:16px;">No playlists yet.</div>';
    return;
  }
  el.innerHTML = _s.playlists.slice(0, 10).map(function(pl) {
    var count = pl.trackIds ? pl.trackIds.length : 0;
    return '<div class="mh2-pl-portal" onclick="snxMH2OpenPlaylist(\'' + _esc(pl.id) + '\')" role="listitem">' +
      '<span class="mh2-pl-portal-icon">&#127756;</span>' +
      '<div class="mh2-pl-portal-name">' + _esc(pl.name || 'Playlist') + '</div>' +
      '<div class="mh2-pl-portal-count">' + count + ' track' + (count !== 1 ? 's' : '') + '</div>' +
      '<button class="mh2-pl-portal-play" onclick="event.stopPropagation();snxMH2PlaylistPlayAll(\'' + _esc(pl.id) + '\')" aria-label="Play playlist">&#9654; PLAY</button>' +
    '</div>';
  }).join('');
}

function _renderHome() {
  var isFounder = _isFounder();

  // Upload tab visibility
  var uploadTabBtn = document.getElementById('snxMH2TabBtn_upload');
  if (uploadTabBtn) uploadTabBtn.style.display = isFounder ? '' : 'none';

  // Create playlist button
  var plCreateBtn = document.getElementById('snxMH2CreatePlBtn');
  if (plCreateBtn) plCreateBtn.style.display = isFounder ? '' : 'none';

  // Founder management section
  var mgmtSection = document.getElementById('snxMH2MgmtSection');
  if (mgmtSection) mgmtSection.style.display = isFounder ? '' : 'none';

  // Update NP card
  _updateHomeNPCard();
  _updateHomeDot();

  // Render content sections
  _loadFeatured();
  _renderHomePlaylists();
  _renderRecent();
}

/* ══════════════════════════════════════════════════════
   RENDER: UPLOAD FORM
══════════════════════════════════════════════════════ */
function _renderUploadForm() {
  var el = document.getElementById('snxMH2UploadForm');
  if (!el) return;

  el.innerHTML =
    '<div class="mh2-upload-form">' +
      '<div class="mh2-upload-dropzone" id="snxMH2DropZone" onclick="document.getElementById(\'snxMH2FileInput\').click()">' +
        '<div class="mh2-upload-icon">&#127925;</div>' +
        '<div class="mh2-upload-label">Drop audio files here<br><span>or click to browse</span></div>' +
      '</div>' +
      '<input type="file" id="snxMH2FileInput" accept="audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac,.opus" multiple style="display:none;" onchange="snxMH2FilesSelected(event)">' +

      '<div id="snxMH2UploadFields" style="display:none;">' +
        '<div class="mh2-field-row">' +
          '<div class="mh2-field"><label>Title</label><input type="text" id="snxMH2UpTitle" placeholder="Track title"></div>' +
          '<div class="mh2-field"><label>Artist</label><input type="text" id="snxMH2UpArtist" placeholder="Artist name"></div>' +
        '</div>' +
        '<div class="mh2-field-row">' +
          '<div class="mh2-field"><label>Album</label><input type="text" id="snxMH2UpAlbum" placeholder="Album (optional)"></div>' +
          '<div class="mh2-field"><label>Genre</label><input type="text" id="snxMH2UpGenre" placeholder="Genre (optional)"></div>' +
        '</div>' +
        '<div class="mh2-field-row">' +
          '<div class="mh2-field"><label>Cover Art</label><input type="file" id="snxMH2UpArt" accept="image/*,.jpg,.jpeg,.png,.webp"></div>' +
          '<div class="mh2-field"><label>Visibility</label>' +
            '<select id="snxMH2UpVis"><option value="public">Public</option><option value="followers">Followers</option><option value="private">Private</option></select>' +
          '</div>' +
        '</div>' +
        '<div class="mh2-field-row">' +
          '<div class="mh2-field mh2-field-full"><label>Storage Provider</label>' +
            '<select id="snxMH2UpProvider">' +
              '<option value="auto">AUTO (Cloudflare R2 preferred)</option>' +
              '<option value="cloudflare">&#9729; Cloudflare R2</option>' +
              '<option value="supabase">&#9670; Supabase Storage</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="mh2-rights-row">' +
          '<label class="mh2-rights-label">' +
            '<input type="checkbox" id="snxMH2RightsCB" onchange="snxMH2RightsChange()">' +
            ' I confirm that I own this content or have permission to upload and share it.' +
          '</label>' +
        '</div>' +
        '<button class="mh2-upload-btn" id="snxMH2UploadBtn" onclick="snxMH2SubmitUpload()" disabled style="opacity:0.45;pointer-events:none;">&#11014; UPLOAD MUSIC</button>' +
      '</div>' +

      '<div id="snxMH2UploadProgress" style="display:none;"></div>' +
    '</div>';

  // Wire drag-and-drop
  var zone = document.getElementById('snxMH2DropZone');
  if (zone) {
    zone.addEventListener('dragover', function(e){ e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', function(){ zone.classList.remove('drag-over'); });
    zone.addEventListener('drop', function(e){
      e.preventDefault(); zone.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files.length) {
        snxMH2FilesSelected({ target: { files: e.dataTransfer.files }});
      }
    });
  }
}

/* ══════════════════════════════════════════════════════
   RENDER: RADIO TAB
══════════════════════════════════════════════════════ */
function _renderRadio() {
  var el = document.getElementById('snxMH2Tab_radio');
  if (!el) return;
  el.innerHTML =
    '<div class="mh2-radio-screen">' +
      '<div class="mh2-radio-logo" aria-hidden="true">&#128251;</div>' +
      '<div class="mh2-radio-title">SHADOW NEXUS RADIO</div>' +
      '<div class="mh2-radio-subtitle">24-HOUR SOUND REALM</div>' +
      '<div class="mh2-radio-status">' +
        '<div class="mh2-radio-dot' + (_s.radioPlaying ? ' live' : '') + '" id="snxMH2RadioDot" aria-hidden="true"></div>' +
        '<span id="snxMH2RadioAirLabel">' + (_s.radioPlaying ? 'ON AIR' : 'OFF AIR') + '</span>' +
      '</div>' +
      '<button class="mh2-radio-btn' + (_s.radioPlaying ? ' listening' : '') + '" id="snxMH2RadioBtn" onclick="snxMH2RadioToggle()" aria-label="' + (_s.radioPlaying ? 'Stop radio' : 'Listen live') + '">' +
        (_s.radioPlaying ? '&#9209; STOP RADIO' : '&#9654; LISTEN LIVE') +
      '</button>' +
      '<div class="mh2-station-note">Founder-curated 24-hour stream from the Shadow Nexus catalog.</div>' +
    '</div>';
}

/* ══════════════════════════════════════════════════════
   RENDER: STORAGE HEALTH (Founder only)
══════════════════════════════════════════════════════ */
function _renderStorageHealth() {
  var el = document.getElementById('snxMH2StorageHealth');
  if (!el || !_isFounder()) return;
  el.innerHTML = '<div class="mh2-health-row"><span>Checking\u2026</span></div>';
  if (!window.MusicStorage) { el.innerHTML = '<div class="mh2-health-row">MusicStorage not loaded.</div>'; return; }
  window.MusicStorage.checkHealth().then(function(h) {
    el.innerHTML =
      '<div class="mh2-health-row">' +
        '<span class="mh2-health-provider">&#9729; Cloudflare R2</span>' +
        '<span class="mh2-health-status ' + (h.cloudflare === 'ok' ? 'ok' : 'err') + '">' +
          (h.cloudflare === 'ok' ? 'CONNECTED' : 'ERROR') +
        '</span>' +
      '</div>' +
      '<div class="mh2-health-row">' +
        '<span class="mh2-health-provider">&#9670; Supabase</span>' +
        '<span class="mh2-health-status ' + (h.supabase === 'ok' ? 'ok' : 'err') + '">' +
          (h.supabase === 'ok' ? 'CONNECTED' : 'ERROR / NOT CONFIGURED') +
        '</span>' +
      '</div>';
  });
}

/* ══════════════════════════════════════════════════════
   TAB NAVIGATION
══════════════════════════════════════════════════════ */
function _switchTab(tab) {
  var tabs = ['home','library','playlists','queue','playing','upload','radio'];
  tabs.forEach(function(t) {
    var contentEl = document.getElementById('snxMH2Tab_' + t);
    var btnEl     = document.getElementById('snxMH2TabBtn_' + t);
    if (contentEl) contentEl.style.display = (t === tab) ? '' : 'none';
    if (btnEl) {
      btnEl.classList.toggle('active', t === tab);
      btnEl.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
  });
  _s.activeTab = tab;

  if (tab === 'home')      _renderHome();
  if (tab === 'library')   _renderLibrary();
  if (tab === 'playlists') _renderPlaylists();
  if (tab === 'queue')     _renderQueue();
  if (tab === 'playing')   _renderPlayingScreen();
  if (tab === 'upload')    { if (_isFounder()) _renderUploadForm(); }
  if (tab === 'radio')     _renderRadio();
}

/* ══════════════════════════════════════════════════════
   UPLOAD PIPELINE
══════════════════════════════════════════════════════ */
window.snxMH2FilesSelected = function(e) {
  var files = e.target.files;
  if (!files || !files.length) return;
  // Show fields for first file metadata
  var fieldsEl = document.getElementById('snxMH2UploadFields');
  if (fieldsEl) fieldsEl.style.display = '';
  // Pre-fill title from filename
  var titleEl = document.getElementById('snxMH2UpTitle');
  if (titleEl) {
    var name = files[0].name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    var parts = name.split(' - ');
    titleEl.value = parts.length > 1 ? parts.slice(1).join(' - ').trim() : name;
    var artistEl = document.getElementById('snxMH2UpArtist');
    if (artistEl && parts.length > 1) artistEl.value = parts[0].trim();
  }
};

window.snxMH2RightsChange = function() {
  var cb  = document.getElementById('snxMH2RightsCB');
  var btn = document.getElementById('snxMH2UploadBtn');
  if (!btn) return;
  if (cb && cb.checked) {
    btn.removeAttribute('disabled');
    btn.style.opacity = '1';
    btn.style.pointerEvents = '';
  } else {
    btn.setAttribute('disabled', '');
    btn.style.opacity = '0.45';
    btn.style.pointerEvents = 'none';
  }
};

window.snxMH2SubmitUpload = function() {
  if (!_isFounder()) { _toast('\u26D4 Only the founder can upload music.'); return; }
  var cb = document.getElementById('snxMH2RightsCB');
  if (!cb || !cb.checked) { _toast('Confirm the rights statement first.'); return; }
  if (!window.MusicStorage) { _toast('Storage not ready. Refresh the page.'); return; }

  var fileInput = document.getElementById('snxMH2FileInput');
  var files = fileInput && fileInput.files;
  if (!files || !files.length) { _toast('No files selected.'); return; }

  var title    = (document.getElementById('snxMH2UpTitle')    ||{}).value || '';
  var artist   = (document.getElementById('snxMH2UpArtist')   ||{}).value || '';
  var album    = (document.getElementById('snxMH2UpAlbum')    ||{}).value || '';
  var genre    = (document.getElementById('snxMH2UpGenre')    ||{}).value || '';
  var vis      = (document.getElementById('snxMH2UpVis')      ||{}).value || 'public';
  var provider = (document.getElementById('snxMH2UpProvider') ||{}).value || 'auto';
  var artFile  = document.getElementById('snxMH2UpArt') && document.getElementById('snxMH2UpArt').files[0];
  var uid      = _uid();
  if (!uid) { _toast('Not signed in.'); return; }

  var trackId  = _genId();
  var file     = files[0];

  var progressEl = document.getElementById('snxMH2UploadProgress');
  if (progressEl) {
    progressEl.style.display = '';
    progressEl.innerHTML = '<div class="mh2-upload-prog"><div class="mh2-upload-prog-bar" id="snxMH2PBar" style="width:0%"></div></div><div id="snxMH2PStatus" class="mh2-upload-status">Uploading to ' + (provider === 'supabase' ? 'Supabase' : 'Cloudflare R2') + '\u2026</div>';
  }

  function setStatus(msg) {
    var s = document.getElementById('snxMH2PStatus');
    if (s) s.textContent = msg;
  }
  function setProgress(pct) {
    var b = document.getElementById('snxMH2PBar');
    if (b) b.style.width = pct + '%';
  }

  // Upload audio
  window.MusicStorage.uploadTrack(file, {
    provider:   provider,
    trackId:    trackId,
    onProgress: function(pct) { setProgress(pct); }
  }).then(function(result) {
    setStatus('Saved to ' + result.provider + '. Saving metadata\u2026');
    setProgress(90);

    var trackDoc = {
      trackId:          result.trackId,
      ownerUid:         uid,
      title:            title || file.name.replace(/\.[^.]+$/, ''),
      artist:           artist,
      album:            album,
      genre:            genre,
      duration:         0,
      mimeType:         file.type || 'audio/mpeg',
      fileSize:         file.size,
      storageProvider:  result.provider,
      storageKey:       result.storageKey,
      playbackReference: result.playbackUrl,
      artworkProvider:  null,
      artworkKey:       null,
      createdAt:        null,  // server timestamp filled below
      updatedAt:        null,
      rightsConfirmed:  true,
      visibility:       vis,
      featured:         false,
      status:           'ready'
    };

    // Detect duration
    _detectDuration(file, function(dur) {
      trackDoc.duration = dur;
    });

    // Upload artwork if provided
    var artPromise = artFile
      ? window.MusicStorage.uploadArtwork(artFile, result.trackId, { provider: provider })
          .then(function(ar) {
            trackDoc.artworkProvider = ar.provider;
            trackDoc.artworkKey      = ar.storageKey;
          }).catch(function(){})
      : Promise.resolve();

    artPromise.then(function() {
      return _saveTrackDoc(trackDoc);
    }).then(function() {
      setProgress(100);
      setStatus('\u2713 Upload complete! Track added to the library.');
      // Add to in-memory catalog
      _s.tracks.unshift(Object.assign({}, trackDoc, { id: trackDoc.trackId }));
      _renderLibrary();
      _toast('\u2713 "' + (trackDoc.title || 'Track') + '" uploaded to Music Hub.');
    }).catch(function(e) {
      setStatus('\u26A0 Metadata save failed: ' + e.message);
      _toast('Upload succeeded but metadata save failed: ' + e.message);
    });
  }).catch(function(err) {
    setProgress(0);
    var isR2Fail = err._r2Failed;
    if (isR2Fail) {
      setStatus('\u26A0 Cloudflare R2 upload failed. Try Supabase or retry.');
      // Show retry options
      if (progressEl) {
        progressEl.innerHTML += '<div class="mh2-upload-retry">' +
          '<button onclick="document.getElementById(\'snxMH2UpProvider\').value=\'supabase\';snxMH2SubmitUpload()">Use Supabase Instead</button>' +
          '<button onclick="snxMH2SubmitUpload()">Retry R2</button>' +
        '</div>';
      }
    } else {
      setStatus('\u26A0 Upload failed: ' + err.message);
    }
    _toast('Upload failed: ' + err.message);
  });
};

function _saveTrackDoc(doc) {
  var fs = _fs();
  if (!fs) return Promise.reject(new Error('Firestore not ready'));
  var data = Object.assign({}, doc, {
    id:        doc.trackId,
    createdAt: fs.serverTimestamp(),
    updatedAt: fs.serverTimestamp()
  });
  return fs.setDoc(
    fs.doc(fs.db, MH2_COLL_TRACKS, doc.trackId),
    data,
    { merge: false }
  );
}

function _detectDuration(file, cb) {
  try {
    var url = URL.createObjectURL(file);
    var a   = new Audio();
    var done = false;
    var cleanup = function(dur) {
      if (done) return; done = true;
      try { URL.revokeObjectURL(url); } catch(_){}
      cb(dur || 0);
    };
    a.addEventListener('loadedmetadata', function(){ cleanup(isFinite(a.duration) ? a.duration : 0); });
    a.addEventListener('error', function(){ cleanup(0); });
    setTimeout(function(){ cleanup(0); }, 6000);
    a.preload = 'metadata';
    a.src = url;
  } catch(_) { cb(0); }
}

/* ══════════════════════════════════════════════════════
   RADIO
══════════════════════════════════════════════════════ */
window.snxMH2RadioToggle = function() {
  if (_s.radioPlaying) {
    if (_s.radioAudio) { try { _s.radioAudio.pause(); } catch(_){} _s.radioAudio = null; }
    _s.radioPlaying = false;
    _renderRadio();
    _updateHomeDot();
    _updateHomeNPCard();
    if (window.SNXAudioCoordinator) window.SNXAudioCoordinator.release('radio');
    return;
  }

  if (_s.radioAudio) { try { _s.radioAudio.pause(); } catch(_){} _s.radioAudio = null; }

  var fs = _fs();
  function _startStream(url, name) {
    if (!url) {
      _toast(_isFounder()
        ? '\uD83D\uDCFB No radio stream configured. Use Manage Radio to set the stream URL.'
        : '\uD83D\uDCFB The station is being prepared. Check back soon.');
      return;
    }
    if (window.SNXAudioCoordinator) window.SNXAudioCoordinator.request('radio');
    _s.radioAudio = new Audio(url);
    _s.radioAudio.crossOrigin = 'anonymous';
    _s.radioAudio.play().then(function() {
      _s.radioPlaying = true;
      _renderRadio();
      _updateHomeDot();
      _updateHomeNPCard();
    }).catch(function(e) {
      _s.radioAudio = null;
      _toast('Cannot start radio: ' + (e.message || 'unknown error'));
    });
    _s.radioAudio.onended = function() {
      _s.radioPlaying = false; _s.radioAudio = null;
      _renderRadio(); _updateHomeDot(); _updateHomeNPCard();
    };
  }

  if (fs) {
    fs.getDoc(fs.doc(fs.db, 'siteSettings', 'radioConfig')).then(function(snap) {
      var d = snap.exists() ? snap.data() : null;
      _startStream(d ? (d.streamUrl || null) : null, d ? (d.stationName || null) : null);
    }).catch(function(){ _startStream(null); });
  } else {
    _startStream(null);
  }
};

/* ══════════════════════════════════════════════════════
   FEATURED
══════════════════════════════════════════════════════ */
window.snxMH2PlayFeatured = function(featuredId) {
  var feat = _s.featured.find(function(f){ return f.id === featuredId; });
  if (!feat) return;
  // Try to find the track in catalog first
  var track = _s.tracks.find(function(t){ return t.id === featuredId || t.trackId === featuredId; });
  if (track) { _addToQueue(track, true); return; }
  // Fallback: create a minimal track object from featured doc
  var synth = {
    id:               feat.id,
    trackId:          feat.id,
    title:            feat.title || 'Untitled',
    artist:           feat.artist || '',
    storageProvider:  feat.storageProvider || 'legacy',
    storageKey:       feat.storageKey || null,
    playbackReference: feat.url || feat.playbackReference || feat.url || '',
    url:              feat.url || ''
  };
  _addToQueue(synth, true);
};

window.snxMH2UnfeatureTrack = function(trackId) {
  if (!_isFounder()) { _toast('\u26D4 Founder access required.'); return; }
  var fs = _fs();
  if (!fs || !trackId) return;
  if (!confirm('Remove this track from Featured Music?')) return;
  fs.deleteDoc(fs.doc(fs.db, 'musicHub', 'config', 'featured', trackId))
    .then(function(){ _loadFeatured(); _toast('Track removed from Featured.'); })
    .catch(function(e){ _toast('Failed: ' + e.message); });
};

window.snxMH2FeatureTrack = function(trackId) {
  if (!_isFounder()) { _toast('\u26D4 Founder access required.'); return; }
  var fs  = _fs();
  var uid = _uid();
  if (!fs || !uid) return;
  var track = _s.tracks.find(function(t){ return t.id === trackId; });
  if (!track) { _toast('Track not found in library.'); return; }
  fs.setDoc(
    fs.doc(fs.db, 'musicHub', 'config', 'featured', trackId),
    { trackId: trackId, title: track.title||'Untitled', artist: track.artist||'',
      url: _playbackUrl(track), storageProvider: track.storageProvider||'legacy',
      storageKey: track.storageKey||null, playbackReference: _playbackUrl(track),
      featuredAt: fs.serverTimestamp(), featuredBy: uid },
    { merge: false }
  ).then(function(){ _loadFeatured(); _toast('\u2728 Featured: ' + (track.title||'Track')); })
  .catch(function(e){ _toast('Feature failed: ' + e.message); });
};

/* ══════════════════════════════════════════════════════
   PLAYLISTS
══════════════════════════════════════════════════════ */
window.snxMH2CreatePlaylist = function() {
  if (!_isFounder()) return;
  var name = prompt('Playlist name:');
  if (!name || !name.trim()) return;
  var fs  = _fs();
  var uid = _uid();
  if (!fs || !uid) return;
  var id = _genId();
  var pl = { id: id, ownerUid: uid, name: name.trim(), description: '', cover: null,
             visibility: 'public', trackIds: [], createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() };
  fs.setDoc(fs.doc(fs.db, MH2_COLL_PLAYLISTS, id), pl, { merge: false })
    .then(function(){
      _s.playlists.unshift(Object.assign({}, pl, { createdAt: Date.now() }));
      _renderPlaylists();
      _toast('Playlist "' + name.trim() + '" created.');
    }).catch(function(e){ _toast('Could not create: ' + e.message); });
};

window.snxMH2OpenPlaylist = function(plId) {
  var pl = _s.playlists.find(function(p){ return p.id === plId; });
  if (!pl) return;
  var tracks = (pl.trackIds || []).map(function(id){
    return _s.tracks.find(function(t){ return t.id === id; });
  }).filter(Boolean);
  if (!tracks.length) { _toast('Playlist is empty.'); return; }
  _s.queue = tracks;
  _s.queueIndex = 0;
  _loadTrack(0, false);
  _switchTab('queue');
  _toast('Playlist "' + (pl.name||'Untitled') + '" loaded (' + tracks.length + ' tracks).');
};

window.snxMH2PlaylistPlayAll = function(plId) {
  var pl = _s.playlists.find(function(p){ return p.id === plId; });
  if (!pl) return;
  var tracks = (pl.trackIds || []).map(function(id){
    return _s.tracks.find(function(t){ return t.id === id; });
  }).filter(Boolean);
  if (!tracks.length) { _toast('Playlist is empty.'); return; }
  _s.queue = tracks;
  _s.queueIndex = 0;
  _loadTrack(0, true);
  _switchTab('playing');
};

window.snxMH2DeletePlaylist = function(plId) {
  if (!_isFounder()) return;
  if (!confirm('Delete this playlist? Tracks are not deleted.')) return;
  var fs  = _fs();
  var uid = _uid();
  var pl  = _s.playlists.find(function(p){ return p.id === plId; });
  if (!fs || !uid || !pl) return;
  // Try new collection first; fall back to legacy path
  var docPath = pl._legacy
    ? fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', plId)
    : fs.doc(fs.db, MH2_COLL_PLAYLISTS, plId);
  fs.deleteDoc(docPath).then(function(){
    _s.playlists = _s.playlists.filter(function(p){ return p.id !== plId; });
    _renderPlaylists();
    _toast('Playlist deleted.');
  }).catch(function(e){ _toast('Delete failed: ' + e.message); });
};

/* ══════════════════════════════════════════════════════
   DELETE TRACK
══════════════════════════════════════════════════════ */
window.snxMH2DeleteTrack = function(trackId) {
  if (!_isFounder()) { _toast('\u26D4 Founder access required.'); return; }
  var track = _s.tracks.find(function(t){ return t.id === trackId; });
  if (!track) return;
  if (!confirm('Delete "' + (track.title||'Untitled') + '" permanently? This cannot be undone.')) return;

  var fs  = _fs();
  var uid = _uid();
  if (!fs || !uid) return;

  // Remove from in-memory
  _s.tracks = _s.tracks.filter(function(t){ return t.id !== trackId; });
  _s.queue  = _s.queue.filter(function(t){ return t.id !== trackId; });
  if (_s.queueIndex >= _s.queue.length) _s.queueIndex = Math.max(0, _s.queue.length - 1);

  // Remove playlist references
  var fsOps = [];
  _s.playlists.forEach(function(pl) {
    if (pl.trackIds && pl.trackIds.indexOf(trackId) !== -1) {
      pl.trackIds = pl.trackIds.filter(function(id){ return id !== trackId; });
      var docPath = pl._legacy
        ? fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', pl.id)
        : fs.doc(fs.db, MH2_COLL_PLAYLISTS, pl.id);
      fsOps.push(fs.updateDoc(docPath, { trackIds: pl.trackIds }).catch(function(){}));
    }
  });

  // Delete Firestore doc (try both collections)
  var delDoc = track._catalog === 'mh2'
    ? fs.deleteDoc(fs.doc(fs.db, MH2_COLL_TRACKS, trackId))
    : track._catalog === 'legacy'
      ? fs.deleteDoc(fs.doc(fs.db, 'cloudStreamTracks', uid, 'tracks', trackId))
      : track._catalog === 'profile'
        ? fs.deleteDoc(fs.doc(fs.db, 'profileMusic', trackId))
        : Promise.resolve();
  fsOps.push(delDoc.catch(function(){}));

  Promise.all(fsOps).then(function(){
    _renderLibrary(); _renderQueue(); _renderPlaylists();
    _toast('Track deleted.');
    // Delete storage object
    if (window.MusicStorage) window.MusicStorage.deleteTrack(track);
  });
};

/* ══════════════════════════════════════════════════════
   TRACK CONTEXT MENU
══════════════════════════════════════════════════════ */
window.snxMH2ShowTrackMenu = function(trackId) {
  var old = document.getElementById('snxMH2TrackMenu');
  if (old) old.remove();

  var track     = _s.tracks.find(function(t){ return t.id === trackId; });
  if (!track) return;
  var isFounder = _isFounder();

  var menu = document.createElement('div');
  menu.id = 'snxMH2TrackMenu';
  menu.className = 'mh2-track-menu-overlay';
  menu.innerHTML =
    '<div class="mh2-track-menu">' +
      '<div class="mh2-menu-title">' + _esc(track.title || 'Track Options') + '</div>' +
      '<button class="mh2-menu-btn" onclick="snxMH2PlayFromLibrary(\'' + _esc(trackId) + '\');snxMH2CloseMenu()">&#9654; Play Now</button>' +
      '<button class="mh2-menu-btn" onclick="snxMH2AddToQueue(\'' + _esc(trackId) + '\');snxMH2CloseMenu()">+ Add to Queue</button>' +
      '<button class="mh2-menu-btn" onclick="snxMH2ShowAddToPlaylist(\'' + _esc(trackId) + '\')">&#128203; Add to Playlist</button>' +
      (isFounder ?
        '<button class="mh2-menu-btn" onclick="snxMH2FeatureTrack(\'' + _esc(trackId) + '\');snxMH2CloseMenu()">&#10024; Feature</button>' +
        '<button class="mh2-menu-btn mh2-menu-danger" onclick="snxMH2DeleteTrack(\'' + _esc(trackId) + '\');snxMH2CloseMenu()">&#128465; Delete</button>'
        : '') +
      '<button class="mh2-menu-btn mh2-menu-cancel" onclick="snxMH2CloseMenu()">Cancel</button>' +
    '</div>';
  menu.addEventListener('click', function(e){ if (e.target === menu) menu.remove(); });
  document.body.appendChild(menu);
};

window.snxMH2CloseMenu = function() {
  var el = document.getElementById('snxMH2TrackMenu');
  if (el) el.remove();
};

window.snxMH2ShowAddToPlaylist = function(trackId) {
  snxMH2CloseMenu();
  var old = document.getElementById('snxMH2PLPicker');
  if (old) old.remove();

  var overlay = document.createElement('div');
  overlay.id = 'snxMH2PLPicker';
  overlay.className = 'mh2-track-menu-overlay';
  var options = _s.playlists.map(function(pl) {
    return '<button class="mh2-menu-btn" onclick="snxMH2AddTrackToPlaylist(\'' + _esc(pl.id) + '\',\'' + _esc(trackId) + '\');document.getElementById(\'snxMH2PLPicker\').remove()">' +
      _esc(pl.name || 'Untitled') + ' (' + (pl.trackIds ? pl.trackIds.length : 0) + ')</button>';
  }).join('');
  overlay.innerHTML = '<div class="mh2-track-menu">' +
    '<div class="mh2-menu-title">Add to Playlist</div>' +
    (options || '<div style="padding:8px;color:#4a7a9a;font-size:12px;">No playlists yet.</div>') +
    '<button class="mh2-menu-btn mh2-menu-cancel" onclick="document.getElementById(\'snxMH2PLPicker\').remove()">Cancel</button>' +
  '</div>';
  overlay.addEventListener('click', function(e){ if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
};

window.snxMH2AddTrackToPlaylist = function(plId, trackId) {
  var pl = _s.playlists.find(function(p){ return p.id === plId; });
  if (!pl) return;
  if (pl.trackIds && pl.trackIds.indexOf(trackId) !== -1) { _toast('Already in this playlist.'); return; }
  if (!pl.trackIds) pl.trackIds = [];
  pl.trackIds.push(trackId);
  var fs  = _fs();
  var uid = _uid();
  if (!fs || !uid) return;
  var docPath = pl._legacy
    ? fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', plId)
    : fs.doc(fs.db, MH2_COLL_PLAYLISTS, plId);
  fs.updateDoc(docPath, { trackIds: pl.trackIds })
    .then(function(){ _renderPlaylists(); _toast('Added to "' + (pl.name||'Playlist') + '"'); })
    .catch(function(e){ _toast('Failed: ' + e.message); });
};

/* ══════════════════════════════════════════════════════
   NEW UI API — Music Realms & Management Panel
══════════════════════════════════════════════════════ */

/* Music Realms filter: highlights selected realm pill,
   filters Recently Added/Library by genre mapping.
   Does NOT duplicate audio or create new tracks. */
window.snxMH2FilterRealm = function(realm) {
  // Update pill UI
  var pills = document.querySelectorAll('.mh2-realm-pill');
  pills.forEach(function(p) {
    p.classList.toggle('active', p.getAttribute('data-realm') === realm);
  });

  // Map realm → genre keywords for library filter
  var genreMap = {
    'rock':   ['rock','metal','punk','hardcore','grunge','alternative'],
    'dark':   ['dark','emotional','gothic','ambient','atmospheric','emo','sad'],
    'hiphop': ['hip','hop','rap','trap','r&b','rnb','urban'],
    'chill':  ['chill','lofi','lo-fi','ambient','acoustic','calm','relax'],
    'beats':  ['beats','instrumental','electronic','edm','dance','house','techno']
  };

  if (realm === 'all') {
    // Show all recently added
    _renderRecent();
    return;
  }

  var keywords = genreMap[realm] || [realm];
  var el = document.getElementById('snxMH2RecentList');
  if (!el) return;

  var filtered = _s.tracks.filter(function(t) {
    var g = (t.genre || '').toLowerCase();
    return keywords.some(function(k) { return g.indexOf(k) !== -1; });
  }).slice(0, 8);

  if (!filtered.length) {
    el.innerHTML = '<div class="mh2-empty" style="padding:20px;">No tracks in this realm yet.</div>';
    return;
  }

  var curId = _s.queue[_s.queueIndex] && _s.queue[_s.queueIndex].id;
  el.innerHTML = filtered.map(function(t) {
    var art = _artworkUrl(t);
    var isCurrent = t.id === curId && _s.playing;
    return '<div class="mh2-track-item' + (isCurrent ? ' mh2-track-playing' : '') + '" onclick="snxMH2PlayFromLibrary(\'' + _esc(t.id) + '\')">' +
      '<div class="mh2-track-art mh2-track-art-sm">' +
        (art ? '<img src="' + _esc(art) + '" alt="" style="width:100%;height:100%;object-fit:cover;">'
             : '<div class="mh2-art-fallback" style="width:100%;height:100%;"><span class="mh2-art-fallback-icon" style="font-size:13px;">&#9835;</span></div>') +
        '<div class="mh2-track-play-overlay">' + (isCurrent ? '&#9646;&#9646;' : '&#9654;') + '</div>' +
      '</div>' +
      '<div class="mh2-track-info">' +
        '<div class="mh2-track-title">' + _esc(t.title || 'Untitled') +
          (isCurrent ? '<span class="mh2-eq-inline" aria-hidden="true"><span></span><span></span><span></span></span>' : '') +
        '</div>' +
        '<div class="mh2-track-meta-line">' + _esc(t.artist || '') + (t.duration ? ' &bull; ' + _fmt(t.duration) : '') + '</div>' +
      '</div>' +
      '<button class="mh2-act-btn" onclick="event.stopPropagation();snxMH2ShowTrackMenu(\'' + _esc(t.id) + '\')" aria-label="More options">&#8942;</button>' +
    '</div>';
  }).join('');
};

/* Toggle founder Music Management panel */
window.snxMH2ToggleMgmt = function() {
  var toggle = document.getElementById('snxMH2MgmtToggle');
  var panel  = document.getElementById('snxMH2MgmtPanel');
  if (!toggle || !panel) return;
  var isOpen = panel.classList.contains('open');
  toggle.classList.toggle('open', !isOpen);
  panel.classList.toggle('open', !isOpen);
  toggle.setAttribute('aria-expanded', !isOpen ? 'true' : 'false');
};

/* ══════════════════════════════════════════════════════
   PUBLIC API (window functions)
══════════════════════════════════════════════════════ */
window.snxMH2PlayPause   = function() { _togglePlay(); };
window.snxMH2Next        = function() { _next(); };
window.snxMH2Prev        = function() { _prev(); };
window.snxMH2PlayFromLibrary = function(id) { _playFromLibrary(id); };
window.snxMH2AddToQueue  = function(id) {
  var t = _s.tracks.find(function(x){ return x.id === id; });
  if (t) _addToQueue(t, false);
};
window.snxMH2QueueJump   = function(idx) { _loadTrack(idx, true); };
window.snxMH2QueueRemove = function(idx) {
  _s.queue.splice(idx, 1);
  if (_s.queueIndex >= _s.queue.length) _s.queueIndex = Math.max(0, _s.queue.length - 1);
  _renderQueue();
};
window.snxMH2QueueClear  = function() {
  if (!confirm('Clear the queue?')) return;
  _s.queue = []; _s.queueIndex = 0;
  var a = _getAudio(); a.pause(); a.src = '';
  _s.playing = false;
  _renderQueue(); _renderPlayer();
};
window.snxMH2Seek = function(e, bar) {
  var rect  = bar.getBoundingClientRect();
  var ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  var a     = _getAudio();
  if (isFinite(a.duration) && a.duration > 0) a.currentTime = ratio * a.duration;
};
window.snxMH2SetVolume = function(v) {
  _s.volume = parseFloat(v);
  var a = _getAudio();
  a.volume = _s.muted ? 0 : _s.volume;
};
window.snxMH2ToggleMute = function() {
  _s.muted = !_s.muted;
  var a = _getAudio();
  a.volume = _s.muted ? 0 : _s.volume;
  _renderPlayer();
};
window.snxMH2ToggleShuffle = function() {
  _s.shuffle = !_s.shuffle; _renderPlayer();
  if (_s.activeTab === 'playing') _renderPlayingScreen();
};
window.snxMH2ToggleRepeat  = function() {
  _s.repeatOne = !_s.repeatOne; _renderPlayer();
  if (_s.activeTab === 'playing') _renderPlayingScreen();
};
window.snxMH2SwitchTab = function(tab) { _switchTab(tab); };
window.snxMH2LibSearch = function(q) { _s.libraryQuery = q; _renderLibrary(); };
window.snxMH2LibFilter = function(f) { _s.libraryFilter = f; _renderLibrary(); };
window.snxMH2RefreshStorageHealth = function() { _renderStorageHealth(); };

/* ══════════════════════════════════════════════════════
   INIT
══════════════════════════════════════════════════════ */
window.snxMH2Init = function() {
  window._snxOnAuthReady(function() {
    _s.user      = _user();
    _s.isFounder = _isFounder();

    if (!_s.user) {
      var el = document.getElementById('snxMH2Container');
      if (el) el.innerHTML = '<div class="mh2-empty" style="padding:40px;"><div class="mh2-empty-icon">&#128274;</div>Sign in to access Music Hub.</div>';
      return;
    }

    // Register audio coordinator listener
    if (window.SNXAudioCoordinator) {
      window.SNXAudioCoordinator.on('pause', function(src) {
        if (src === 'musicHub' && _s.playing) { _getAudio().pause(); }
      });
      window.SNXAudioCoordinator.on('kill', function(src) {
        if (src === 'musicHub') {
          var a = _getAudio(); a.pause(); a.src = ''; _s.playing = false;
        }
      });
    }

    // Connect timeupdate to playing screen when visible
    _getAudio().addEventListener('timeupdate', function() {
      if (_s.activeTab === 'playing') _updatePlayingScreenProgress();
    });

    // Load data
    _loadCatalog();
    _loadPlaylists();
    _loadFeatured();

    // Render initial tab
    _renderHome();
    _renderPlayer();

    console.log('[MH2] Music Hub 2.0 initialized. Version:', MH2_VERSION);
  });
};

window.snxMH2Stop = function() {
  if (_s.radioPlaying) {
    try { if (_s.radioAudio) _s.radioAudio.pause(); } catch(_){}
    _s.radioAudio    = null;
    _s.radioPlaying  = false;
  }
  if (_audio && _s.playing) {
    try { _audio.pause(); } catch(_){}
    _s.playing = false;
  }
  if (window.SNXAudioCoordinator) {
    window.SNXAudioCoordinator.release('musicHub');
    window.SNXAudioCoordinator.release('radio');
  }
};

/* Bridge for legacy compatibility */
window.snxMHStopRadio = window.snxMH2Stop;

/* Expose state read for audio coordinator */
window._snxMH2Playing = function() { return _s.playing || _s.radioPlaying; };

})();
