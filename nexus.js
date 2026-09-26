/**
 * SHADOW NEXUS — 24-HOUR NEXUS (nexus.js)
 * ─────────────────────────────────────────
 * Community Streaming Network.
 * ANY authenticated user can discover public streams and create their own channel.
 * Each account gets its own independent channel with Vault, Playlists, Queue, Upload.
 *
 * Firebase collections:
 *   nexusChannels/{channelId}                    — per-user channel metadata (public index)
 *   cloudStreamTracks/{uid}/tracks/{id}          — media vault (per user)
 *   studioPlaylists/{uid}/playlists/{id}         — playlists (per user)
 *   studioCloudStreamMusic/{streamId}            — live Now Playing (worker-owned)
 *   cloudStreams/{streamId}                      — broadcast record
 *   studioCloudStreamQueue/{streamId}/items/{id} — queue
 *   cloudStreamLikes/{channelId}/likes/{uid}     — per-channel likes
 *
 * NO FOUNDER CONTROLS. NO ADMIN CONTROLS. ZERO.
 */
'use strict';

(function() {

/* ═══════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════ */
var _nx = {
  // Auth
  user:          null,
  userData:      null,
  // Navigation
  mainSection:   'discover',  // 'discover' | 'mychannel' | 'publicwatch'
  activeTab:     'watch',
  // My Channel state
  myChannel:     null,        // nexusChannels doc for current user
  myStreamId:    null,        // active cloudStream id for current user
  myStreamData:  null,
  // Own stream player subs
  npUnsub:       null,
  streamUnsub:   null,
  // Public watch state
  watchChannelId: null,       // channel being publicly watched
  watchStreamId:  null,
  pubNpUnsub:    null,
  pubStreamUnsub:null,
  pubViewerUnsub:null,
  pubLiked:      false,
  pubLikeCount:  0,
  pubViewerCount:0,
  // My Channel watch state
  myViewerCount: 0,
  myLikeCount:   0,
  myLiked:       false,
  // Discovery
  liveChannels:  [],
  allChannels:   [],
  // UI
  mediaFilter:   'all',
  uploadType:    'music',
  toastTimer:    null,
  presRef:       null,         // RTDB presence ref for public watch
  // Scenes
  scenes: [
    'ANUBIS CHAMBER','BLOOD PYRAMID','PHARAOH\'S GALAXY',
    'CURSED TOMB','EYE OF THE NEXUS','DESERT AFTER MIDNIGHT',
    'UNDERWORLD','CELESTIAL TEMPLE'
  ]
};

/* ═══════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════ */
function _el(id)    { return document.getElementById(id); }
function _esc(s)    { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
function _fmtDur(s) { if (!s||s<=0) return '0:00'; var m=Math.floor(s/60),ss=Math.floor(s%60); return m+':'+(ss<10?'0':'')+ss; }
function _show(id,v){ var e=_el(id); if(e) e.style.display=v?'':'none'; }

function _stableScene(title) {
  var h=0,str=String(title||'');
  for(var i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))|0;
  return _nx.scenes[Math.abs(h)%_nx.scenes.length];
}

function _toast(msg, type) {
  var el = _el('nxToast');
  if (!el) { if (typeof toastNotification === 'function') toastNotification(msg); return; }
  el.textContent = msg;
  el.className = 'nx-toast show' + (type ? ' '+type : '');
  if (_nx.toastTimer) clearTimeout(_nx.toastTimer);
  _nx.toastTimer = setTimeout(function() { el.classList.remove('show'); }, 3500);
}
function _toastError(msg) { _toast(msg, 'error'); }
function _toastOk(msg)    { _toast(msg, 'success'); }

function _fs() { return window._snxFirestore || null; }

/* ═══════════════════════════════════════════════════════
   INIT — called when nexusPage becomes visible
═══════════════════════════════════════════════════════ */
window.snxNexusInit = function() {
  window._snxOnAuthReady(function() {
    _nx.user     = window._snxCurrentUser || null;
    _nx.userData = window._snxUserData    || null;

    if (!_nx.user) {
      _showAuthGate();
      return;
    }

    _initHeader();
    // Default: show Discover
    _switchMain('discover');
    // Check URL for direct channel watch
    var params = new URLSearchParams(window.location.search);
    var watchCh = params.get('watchChannel');
    if (watchCh) {
      _openPublicWatch(watchCh);
      return;
    }
    // Pre-load discovery
    _loadDiscovery();
    // Pre-load own channel data
    _loadMyChannel();
    // Pre-load studio tracks/playlists for instant Vault
    if (typeof _mlLoadTracks === 'function') _mlLoadTracks();
    if (typeof _csMusicLoadPlaylists === 'function') _csMusicLoadPlaylists();
    if (typeof _sqLoad === 'function') _sqLoad();
  });
};

function _showAuthGate() {
  var body = _el('nxDiscoverSection');
  if (body) body.innerHTML =
    '<div class="nx-empty" style="padding:60px 20px;">' +
      '<div class="nx-empty-icon">𓂀</div>' +
      '<div class="nx-empty-text">Sign in to enter the 24-Hour Nexus.</div>' +
    '</div>';
}

function _initHeader() {
  var nameEl = _el('nxUserBadge');
  if (nameEl) {
    var name = _nx.userData ? (_nx.userData.displayName || _nx.userData.username || '') : '';
    nameEl.textContent = name;
  }
}

/* ═══════════════════════════════════════════════════════
   MAIN SECTION SWITCHING
═══════════════════════════════════════════════════════ */
window.snxNexusSwitchMain = function(section) { _switchMain(section); };

function _switchMain(section) {
  _nx.mainSection = section;

  // Update action bar buttons
  var btnD  = _el('nxActionDiscover');
  var btnMC = _el('nxActionMyChannel');
  if (btnD)  btnD.classList.toggle('active',  section === 'discover');
  if (btnMC) btnMC.classList.toggle('active', section === 'mychannel');

  // Show/hide sections
  _show('nxDiscoverSection',    section === 'discover');
  _show('nxMyChannelSection',   section === 'mychannel');
  _show('nxPublicWatchSection', section === 'publicwatch');

  // Tab bar only visible in My Channel
  var tb = _el('nxTabBar');
  if (tb) tb.style.display = (section === 'mychannel') ? '' : 'none';

  if (section === 'discover') {
    _loadDiscovery();
  } else if (section === 'mychannel') {
    _loadMyChannel();
    _loadActiveTab(_nx.activeTab);
    if (typeof _mlLoadTracks === 'function') _mlLoadTracks();
    if (typeof _csMusicLoadPlaylists === 'function') _csMusicLoadPlaylists();
    if (typeof _sqLoad === 'function') _sqLoad();
    if (typeof _checkActiveCloudStream === 'function') _checkActiveCloudStream();
  }
}

/* ═══════════════════════════════════════════════════════
   TAB SWITCHING (inside MY CHANNEL)
═══════════════════════════════════════════════════════ */
window.snxNexusSwitchTab = function(tab) {
  _nx.activeTab = tab;
  document.querySelectorAll('.nx-tab').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.nxtab === tab);
  });
  document.querySelectorAll('#nxMyChannelSection .nx-panel').forEach(function(panel) {
    panel.classList.toggle('active', panel.dataset.nxtab === tab);
  });
  _loadActiveTab(tab);
};

function _loadActiveTab(tab) {
  if (tab === 'watch')     _loadMyChannelWatch();
  if (tab === 'vault')     _loadVault();
  if (tab === 'playlists') _loadPlaylists();
  if (tab === 'queue')     _loadQueue();
  if (tab === 'upload')    _loadUpload();
  if (tab === 'channel')   _loadChannelSettings();
}

/* ═══════════════════════════════════════════════════════
   DISCOVERY — Public Channel Directory
═══════════════════════════════════════════════════════ */
function _loadDiscovery() {
  var fs = _fs();
  if (!fs) return;

  // Load live channels
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'nexusChannels'),
    fs.where('isLive', '==', true),
    fs.where('isPublic', '==', true),
    fs.orderBy('updatedAt', 'desc'),
    fs.limit(20)
  )).then(function(snap) {
    _nx.liveChannels = (snap && snap.docs) ? snap.docs.map(function(d) { return Object.assign({}, d.data(), {channelId: d.id}); }) : [];
    _renderLiveNow();
    _updateLiveCount();
  }).catch(function(e) {
    console.warn('[NX Discovery] live channels:', e.message);
    _renderLiveNow();
  });

  // Load all public channels (for New Channels section)
  fs.getDocs(fs.query(
    fs.collection(fs.db, 'nexusChannels'),
    fs.where('isPublic', '==', true),
    fs.orderBy('createdAt', 'desc'),
    fs.limit(30)
  )).then(function(snap) {
    _nx.allChannels = (snap && snap.docs) ? snap.docs.map(function(d) { return Object.assign({}, d.data(), {channelId: d.id}); }) : [];
    _renderNewChannels();
    _renderCategories();
  }).catch(function(e) {
    console.warn('[NX Discovery] all channels:', e.message);
    _renderNewChannels();
  });
}

function _updateLiveCount() {
  var cnt = _nx.liveChannels.length;
  var el = _el('nxViewerCount');
  if (el) el.textContent = cnt + (cnt === 1 ? ' LIVE' : ' LIVE');
  var ce = _el('nxLiveNowCount');
  if (ce) ce.textContent = cnt ? cnt + ' ACTIVE' : '';
}

function _renderLiveNow() {
  var el = _el('nxLiveNowList');
  if (!el) return;
  var channels = _nx.liveChannels;
  if (!channels.length) {
    el.innerHTML = '<div class="nx-discover-empty">𓂀 No streams are live right now.<br><span style="font-size:11px;opacity:0.6;">Be the first — start your channel!</span></div>';
    return;
  }
  el.innerHTML = channels.map(function(ch) { return _renderChannelCard(ch, true); }).join('');
}

function _renderNewChannels() {
  var el = _el('nxNewChannelsList');
  if (!el) return;
  // Exclude channels already shown in Live Now
  var liveIds = _nx.liveChannels.map(function(c){ return c.channelId; });
  var channels = _nx.allChannels.filter(function(c){ return liveIds.indexOf(c.channelId) === -1; });
  if (!channels.length) {
    el.innerHTML = '<div class="nx-discover-empty">𓂀 No channels yet. Create yours!</div>';
    return;
  }
  el.innerHTML = channels.slice(0,12).map(function(ch) { return _renderChannelCard(ch, false); }).join('');
}

function _renderCategories() {
  var el = _el('nxCategorySections');
  if (!el) return;
  var cats = ['Music','Video','Mixed','Talk','Gaming','Art'];
  var icons = {Music:'🎵',Video:'🎬',Mixed:'🌌',Talk:'🎙',Gaming:'🎮',Art:'🎨'};
  var html = '';
  cats.forEach(function(cat) {
    var channels = _nx.allChannels.filter(function(c){ return c.category === cat; });
    if (!channels.length) return;
    html += '<div style="margin-bottom:20px;">' +
      '<div class="nx-section-title">' + (icons[cat]||'') + ' ' + cat.toUpperCase() + '</div>' +
      '<div class="nx-channel-grid">' +
        channels.slice(0,6).map(function(ch){ return _renderChannelCard(ch, ch.isLive); }).join('') +
      '</div>' +
    '</div>';
  });
  el.innerHTML = html || '';
}

function _renderChannelCard(ch, live) {
  var avatar = ch.avatarUrl ? '<img src="' + _esc(ch.avatarUrl) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' : (ch.channelName||'?').charAt(0).toUpperCase();
  var liveBadge = live ? '<div class="nx-card-live-badge">🔴 LIVE</div>' : '';
  var media = ch.currentMedia ? '<div class="nx-card-media">Playing: ' + _esc(ch.currentMedia) + '</div>' : '';
  return '<div class="nx-channel-card" onclick="snxNexusOpenChannel(\'' + _esc(ch.channelId) + '\')">' +
    '<div class="nx-card-avatar-wrap">' +
      '<div class="nx-card-avatar">' + avatar + '</div>' +
      liveBadge +
    '</div>' +
    '<div class="nx-card-info">' +
      '<div class="nx-card-channel-name">' + _esc(ch.channelName || 'Unnamed Channel') + '</div>' +
      '<div class="nx-card-creator">' + _esc(ch.ownerDisplayName || '') + '</div>' +
      media +
      '<div class="nx-card-stats">' +
        (live ? '<span class="nx-card-viewers">👁 ' + _esc(String(ch.viewerCount||0)) + '</span>' : '') +
        '<span class="nx-card-likes">❤ ' + _esc(String(ch.likeCount||0)) + '</span>' +
        (ch.category ? '<span class="nx-card-cat">' + _esc(ch.category) + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<button class="nx-btn nx-btn-sm nx-btn-primary" style="flex-shrink:0;align-self:flex-end;" onclick="event.stopPropagation();snxNexusOpenChannel(\'' + _esc(ch.channelId) + '\')">WATCH</button>' +
  '</div>';
}

/* ═══════════════════════════════════════════════════════
   DISCOVERY SEARCH
═══════════════════════════════════════════════════════ */
window.snxNexusDiscoverSearch = function() {
  var q = (_el('nxDiscoverSearch')||{}).value || '';
  var ql = q.trim().toLowerCase();
  if (!ql) {
    _show('nxSearchResults', false);
    _show('nxLiveNowSection', true);
    _show('nxNewChannelsSection', true);
    _show('nxCategorySections', true);
    return;
  }
  _show('nxSearchResults', true);
  _show('nxLiveNowSection', false);
  _show('nxNewChannelsSection', false);
  _show('nxCategorySections', false);

  var all = _nx.liveChannels.concat(_nx.allChannels);
  // Dedupe
  var seen = {};
  var deduped = all.filter(function(ch) {
    if (seen[ch.channelId]) return false;
    seen[ch.channelId] = true;
    return true;
  });
  var results = deduped.filter(function(ch) {
    return (ch.channelName||'').toLowerCase().includes(ql) ||
           (ch.ownerDisplayName||'').toLowerCase().includes(ql) ||
           (ch.ownerUsername||'').toLowerCase().includes(ql) ||
           (ch.category||'').toLowerCase().includes(ql);
  });

  // Also search Firestore for channels not in local cache
  var fs = _fs();
  if (fs && results.length < 3) {
    // Try display name search
    fs.getDocs(fs.query(
      fs.collection(fs.db, 'nexusChannels'),
      fs.where('isPublic', '==', true),
      fs.orderBy('channelName'),
      fs.startAt(q),
      fs.endAt(q + '\uf8ff'),
      fs.limit(10)
    )).then(function(snap) {
      if (!snap || !snap.docs) return;
      snap.docs.forEach(function(d) {
        var ch = Object.assign({}, d.data(), {channelId: d.id});
        if (!seen[ch.channelId]) { results.push(ch); seen[ch.channelId] = true; }
      });
      _renderSearchResults(results);
    }).catch(function() { _renderSearchResults(results); });
  } else {
    _renderSearchResults(results);
  }
};

function _renderSearchResults(results) {
  var el = _el('nxSearchResultsList');
  if (!el) return;
  if (!results.length) {
    el.innerHTML = '<div class="nx-discover-empty">𓂀 No channels or creators found.</div>';
    return;
  }
  el.innerHTML = results.map(function(ch) { return _renderChannelCard(ch, ch.isLive); }).join('');
}

/* ═══════════════════════════════════════════════════════
   OPEN A CHANNEL (Public Watch)
═══════════════════════════════════════════════════════ */
window.snxNexusOpenChannel = function(channelId) {
  if (!channelId) return;
  // If it's the user's own channel, go to My Channel
  if (_nx.myChannel && _nx.myChannel.channelId === channelId) {
    _switchMain('mychannel');
    return;
  }
  _openPublicWatch(channelId);
};

function _openPublicWatch(channelId) {
  _nx.watchChannelId = channelId;
  _nx.pubLiked = false;
  _nx.pubLikeCount = 0;
  _nx.pubViewerCount = 0;

  // Clean up previous public watch subs
  _cleanupPublicSubs();

  // Load channel doc
  var fs = _fs();
  if (!fs) return;
  fs.getDoc(fs.doc(fs.db, 'nexusChannels', channelId)).then(function(snap) {
    if (!snap || !snap.exists()) {
      _toastError('Channel not found.');
      return;
    }
    var ch = Object.assign({}, snap.data(), {channelId: channelId});
    _renderPublicChannelBranding(ch);
    _switchToPublicWatch();

    // Subscribe to live stream if active
    if (ch.activeStreamId) {
      _nx.watchStreamId = ch.activeStreamId;
      _subscribePublicStream(ch.activeStreamId, channelId);
    } else {
      _show('nxPublicWatchOffline', true);
      _show('nxPublicWatchOnline', false);
    }

    // Join as viewer
    _joinPublicViewer(channelId);
    // Check like
    _checkPublicLike(channelId);
  }).catch(function(e) {
    _toastError('Could not load channel.');
    console.warn('[NX]', e.message);
  });
}

function _switchToPublicWatch() {
  _nx.mainSection = 'publicwatch';
  var btnD  = _el('nxActionDiscover');
  var btnMC = _el('nxActionMyChannel');
  if (btnD)  btnD.classList.remove('active');
  if (btnMC) btnMC.classList.remove('active');
  _show('nxDiscoverSection',    false);
  _show('nxMyChannelSection',   false);
  _show('nxPublicWatchSection', true);
  var tb = _el('nxTabBar');
  if (tb) tb.style.display = 'none';
}

function _renderPublicChannelBranding(ch) {
  var nameEl = _el('nxPublicChannelName');
  var crEl   = _el('nxPublicChannelCreator');
  var avEl   = _el('nxPublicChannelAvatar');
  if (nameEl) nameEl.textContent = ch.channelName || 'Channel';
  if (crEl)   crEl.textContent   = ch.ownerDisplayName || '';
  if (avEl) {
    if (ch.avatarUrl) {
      avEl.innerHTML = '<img src="' + _esc(ch.avatarUrl) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
    } else {
      avEl.textContent = (ch.channelName||'?').charAt(0).toUpperCase();
    }
  }
}

function _subscribePublicStream(streamId, channelId) {
  var fs = _fs();
  if (!fs) return;

  // Subscribe to Now Playing
  if (_nx.pubNpUnsub) { try { _nx.pubNpUnsub(); } catch(_){} }
  _nx.pubNpUnsub = fs.onSnapshot(
    fs.doc(fs.db, 'studioCloudStreamMusic', streamId),
    function(snap) {
      if (!snap || !snap.exists()) return;
      _updatePublicNowTransmitting(snap.data());
    }, function(){}
  );

  // Subscribe to cloudStreams doc for viewer count + status
  if (_nx.pubStreamUnsub) { try { _nx.pubStreamUnsub(); } catch(_){} }
  _nx.pubStreamUnsub = fs.onSnapshot(
    fs.doc(fs.db, 'cloudStreams', streamId),
    function(snap) {
      if (!snap || !snap.exists()) return;
      var d = snap.data();
      if (d.status === 'stopped' || d.status === 'ended') {
        _show('nxPublicWatchOffline', true);
        _show('nxPublicWatchOnline', false);
        _show('nxPublicLiveBadge', false);
        _cleanupPublicSubs();
        return;
      }
      _show('nxPublicWatchOffline', false);
      _show('nxPublicWatchOnline', true);
      _show('nxPublicLiveBadge', true);
      _nx.pubViewerCount = d.viewerCount || 0;
      var vc = _el('nxPublicViewerCount');
      if (vc) vc.textContent = _nx.pubViewerCount;
    }, function(){}
  );
}

function _updatePublicNowTransmitting(d) {
  var title  = d.currentTitle  || '—';
  var artist = d.currentArtist || '';
  var next   = d.nextTitle     || '';
  var el = _el('nxPublicNtTitle');  if (el) el.textContent = title;
  var ae = _el('nxPublicNtArtist'); if (ae) ae.textContent = artist;
  var ne = _el('nxPublicNtNext');   if (ne) ne.textContent = next ? 'UP NEXT: ' + next : '';
  var scene = _stableScene(title);
  var se = _el('nxPublicSceneLabel'); if (se) se.textContent = scene;
  var sn = _el('nxPublicSceneName'); if (sn) sn.textContent = scene;
  _activatePublicScene(title);
  // Queue
  var qList = _el('nxPublicProphecyQueue');
  if (!qList) return;
  var html = '<li class="nx-queue-item nx-queue-current"><span class="nx-queue-num">♪</span><span class="nx-queue-title">' + _esc(title) + '</span><span class="nx-queue-type-badge">NOW</span></li>';
  if (next) html += '<li class="nx-queue-item"><span class="nx-queue-num">2</span><span class="nx-queue-title">' + _esc(next) + '</span></li>';
  qList.innerHTML = html;
}

function _activatePublicScene(title) {
  var canvas = _el('nxPublicSceneCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width  = canvas.offsetWidth  || 360;
  canvas.height = canvas.offsetHeight || 200;
  _drawScene(ctx, canvas.width, canvas.height, title);
}

function _joinPublicViewer(channelId) {
  var rtdbApi = window._snxRtdbApi;
  if (!rtdbApi || !_nx.user) return;
  var sessionKey = sessionStorage.getItem('snx_nx_pub_session') || (function(){
    var id = 'v_' + Math.random().toString(36).slice(2,12) + '_' + Date.now().toString(36);
    sessionStorage.setItem('snx_nx_pub_session', id);
    return id;
  })();
  var presRef = rtdbApi.ref(rtdbApi.getDatabase(), 'nexusViewers/' + channelId + '/' + sessionKey);
  _nx.presRef = presRef;
  rtdbApi.set(presRef, { uid: _nx.user.uid, ts: {'.sv': 'timestamp'}, sessionId: sessionKey });
  if (rtdbApi.onDisconnect) rtdbApi.onDisconnect(presRef).remove();
}

function _cleanupPublicSubs() {
  if (_nx.pubNpUnsub)     { try { _nx.pubNpUnsub(); }     catch(_){} _nx.pubNpUnsub = null; }
  if (_nx.pubStreamUnsub) { try { _nx.pubStreamUnsub(); } catch(_){} _nx.pubStreamUnsub = null; }
  if (_nx.pubViewerUnsub) { try { _nx.pubViewerUnsub(); } catch(_){} _nx.pubViewerUnsub = null; }
  if (_nx.presRef && window._snxRtdbApi) {
    try { window._snxRtdbApi.remove(_nx.presRef); } catch(_){}
    _nx.presRef = null;
  }
}

window.snxNexusClosePublicWatch = function() {
  _cleanupPublicSubs();
  _nx.watchChannelId = null;
  _nx.watchStreamId  = null;
  _switchMain('discover');
};

/* ═══════════════════════════════════════════════════════
   PUBLIC LIKES
═══════════════════════════════════════════════════════ */
function _checkPublicLike(channelId) {
  var fs = _fs();
  if (!fs || !_nx.user || !channelId) return;
  fs.getDoc(fs.doc(fs.db, 'cloudStreamLikes', channelId, 'likes', _nx.user.uid))
    .then(function(snap) { _nx.pubLiked = !!(snap && snap.exists()); _updatePublicLikeBtn(); })
    .catch(function(){});
}

function _updatePublicLikeBtn() {
  var btn = _el('nxPublicLikeBtn');
  if (!btn) return;
  btn.classList.toggle('liked', _nx.pubLiked);
}

window.snxNexusPublicToggleLike = function() {
  if (!_nx.user || !_nx.watchChannelId) { _toastError('Sign in to like.'); return; }
  var fs = _fs();
  if (!fs) return;
  var likeRef = fs.doc(fs.db, 'cloudStreamLikes', _nx.watchChannelId, 'likes', _nx.user.uid);
  if (_nx.pubLiked) {
    fs.deleteDoc(likeRef).then(function() {
      _nx.pubLiked = false;
      _nx.pubLikeCount = Math.max(0, _nx.pubLikeCount - 1);
      _updatePublicLikeBtn();
      var lc = _el('nxPublicLikeCount'); if (lc) lc.textContent = _nx.pubLikeCount;
      fs.updateDoc(fs.doc(fs.db, 'nexusChannels', _nx.watchChannelId), {likeCount: fs.increment(-1)}).catch(function(){});
    }).catch(function(){});
  } else {
    fs.setDoc(likeRef, {uid: _nx.user.uid, ts: fs.serverTimestamp()}).then(function() {
      _nx.pubLiked = true;
      _nx.pubLikeCount++;
      _updatePublicLikeBtn();
      var lc = _el('nxPublicLikeCount'); if (lc) lc.textContent = _nx.pubLikeCount;
      fs.updateDoc(fs.doc(fs.db, 'nexusChannels', _nx.watchChannelId), {likeCount: fs.increment(1)}).catch(function(){});
    }).catch(function(){});
  }
};

/* ═══════════════════════════════════════════════════════
   MY CHANNEL — Load & Setup
═══════════════════════════════════════════════════════ */
function _loadMyChannel() {
  var fs = _fs();
  if (!fs || !_nx.user) return;
  // channelId is keyed by ownerUid
  var channelId = _nx.user.uid;
  fs.getDoc(fs.doc(fs.db, 'nexusChannels', channelId)).then(function(snap) {
    if (snap && snap.exists()) {
      _nx.myChannel = Object.assign({}, snap.data(), {channelId: channelId});
      _onMyChannelLoaded();
    } else {
      _nx.myChannel = null;
      _showCreateChannelForm();
    }
  }).catch(function(e) {
    console.warn('[NX] loadMyChannel:', e.message);
    _showCreateChannelForm();
  });
}

function _onMyChannelLoaded() {
  var ch = _nx.myChannel;
  _show('nxCreateChannelCard', false);
  _show('nxChannelDashboard', true);
  // Populate channel tab fields
  var nm = _el('nxMyChannelName'); if (nm) nm.textContent = ch.channelName || '—';
  var cm = _el('nxMyChannelCategory'); if (cm) cm.textContent = ch.category || '';
  var en = _el('nxEditChannelName'); if (en) en.value = ch.channelName || '';
  var ed = _el('nxEditChannelDesc'); if (ed) ed.value = ch.description || '';
  var ec = _el('nxEditChannelCategory'); if (ec) ec.value = ch.category || 'Music';
  var ep = _el('nxEditChannelPublic'); if (ep) ep.value = String(ch.isPublic !== false);
  // Share URL
  var su = _el('nxChannelShareUrl');
  if (su) su.textContent = window.location.origin + '/?snxPage=nexusPage&watchChannel=' + _nx.user.uid;
  // Subscribe to active stream for My Channel tab
  if (ch.activeStreamId) {
    _nx.myStreamId = ch.activeStreamId;
    _subscribeMyStream(ch.activeStreamId);
  }
  // Subscribe to viewer / like counts for My Channel panel
  _subscribeMyChannelStats();
}

function _showCreateChannelForm() {
  _show('nxCreateChannelCard', true);
  _show('nxChannelDashboard', false);
}

/* ═══════════════════════════════════════════════════════
   CREATE CHANNEL
═══════════════════════════════════════════════════════ */
window.snxNexusCreateChannel = function() {
  var nameEl = _el('nxNewChannelName');
  var descEl = _el('nxNewChannelDesc');
  var catEl  = _el('nxNewChannelCategory');
  var name = (nameEl||{}).value || '';
  if (!name.trim()) { _toastError('Enter a channel name.'); return; }
  var fs = _fs();
  if (!fs || !_nx.user) { _toastError('Not signed in.'); return; }
  var uid = _nx.user.uid;
  var displayName = (_nx.userData && (_nx.userData.displayName || _nx.userData.username)) || '';
  var ch = {
    channelId:        uid,
    ownerUid:         uid,
    ownerDisplayName: displayName,
    ownerUsername:    (_nx.userData && _nx.userData.username) || '',
    channelName:      name.trim(),
    description:      (descEl||{}).value || '',
    category:         (catEl||{}).value || 'Music',
    isPublic:         true,
    isLive:           false,
    activeStreamId:   null,
    currentMedia:     null,
    viewerCount:      0,
    likeCount:        0,
    createdAt:        fs.serverTimestamp(),
    updatedAt:        fs.serverTimestamp()
  };
  fs.setDoc(fs.doc(fs.db, 'nexusChannels', uid), ch)
    .then(function() {
      _nx.myChannel = Object.assign({}, ch, {channelId: uid});
      _toastOk('Channel created: ' + name.trim());
      _onMyChannelLoaded();
    })
    .catch(function(e) { _toastError('Could not create channel: ' + e.message); });
};

/* ═══════════════════════════════════════════════════════
   CHANNEL SETTINGS
═══════════════════════════════════════════════════════ */
function _loadChannelSettings() {
  if (!_nx.myChannel) { _showCreateChannelForm(); return; }
  // Fields already populated in _onMyChannelLoaded
}

window.snxNexusSaveChannelSettings = function() {
  var nameEl = _el('nxEditChannelName');
  var descEl = _el('nxEditChannelDesc');
  var catEl  = _el('nxEditChannelCategory');
  var pubEl  = _el('nxEditChannelPublic');
  var name = (nameEl||{}).value || '';
  if (!name.trim()) { _toastError('Channel name is required.'); return; }
  var fs = _fs();
  if (!fs || !_nx.user) { _toastError('Not signed in.'); return; }
  var uid = _nx.user.uid;
  var update = {
    channelName:  name.trim(),
    description:  (descEl||{}).value || '',
    category:     (catEl||{}).value || 'Music',
    isPublic:     (pubEl||{}).value !== 'false',
    updatedAt:    fs.serverTimestamp()
  };
  fs.updateDoc(fs.doc(fs.db, 'nexusChannels', uid), update)
    .then(function() {
      Object.assign(_nx.myChannel, update);
      var nm = _el('nxMyChannelName'); if (nm) nm.textContent = update.channelName;
      var cm = _el('nxMyChannelCategory'); if (cm) cm.textContent = update.category;
      _toastOk('Channel settings saved.');
    })
    .catch(function(e) { _toastError('Save failed: ' + e.message); });
};

window.snxNexusCopyChannelLink = function() {
  var uid = _nx.user ? _nx.user.uid : '';
  var url = window.location.origin + '/?snxPage=nexusPage&watchChannel=' + uid;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() { _toastOk('Link copied!'); });
  } else {
    _toastOk('Link: ' + url);
  }
};

/* ═══════════════════════════════════════════════════════
   MY CHANNEL — WATCH TAB (own stream viewer)
═══════════════════════════════════════════════════════ */
function _loadMyChannelWatch() {
  // Subscribe to own stream if active
  if (_nx.myChannel && _nx.myChannel.activeStreamId) {
    _subscribeMyStream(_nx.myChannel.activeStreamId);
  } else {
    _show('nxWatchOffline', true);
    _show('nxWatchOnline', false);
    var el = _el('nxNtTitle'); if (el) el.textContent = 'YOUR ETERNAL STREAM AWAITS';
    var ae = _el('nxNtArtist'); if (ae) ae.textContent = 'Start your channel in the CHANNEL tab';
  }
}

function _subscribeMyStream(streamId) {
  var fs = _fs();
  if (!fs) return;
  if (_nx.npUnsub) { try { _nx.npUnsub(); } catch(_){} }
  _nx.npUnsub = fs.onSnapshot(
    fs.doc(fs.db, 'studioCloudStreamMusic', streamId),
    function(snap) {
      if (!snap || !snap.exists()) return;
      _updateMyNowTransmitting(snap.data());
    }, function(){}
  );
  if (_nx.streamUnsub) { try { _nx.streamUnsub(); } catch(_){} }
  _nx.streamUnsub = fs.onSnapshot(
    fs.doc(fs.db, 'cloudStreams', streamId),
    function(snap) {
      if (!snap || !snap.exists()) return;
      var d = snap.data();
      if (d.status === 'stopped' || d.status === 'ended') {
        _show('nxWatchOffline', true);
        _show('nxWatchOnline', false);
        // Update channel doc
        var fs2 = _fs();
        if (fs2 && _nx.user) {
          fs2.updateDoc(fs2.doc(fs2.db, 'nexusChannels', _nx.user.uid), {isLive: false, activeStreamId: null, updatedAt: fs2.serverTimestamp()}).catch(function(){});
        }
        return;
      }
      _show('nxWatchOffline', false);
      _show('nxWatchOnline', true);
      _nx.myViewerCount = d.viewerCount || 0;
      var wv = _el('nxWatchViewers'); if (wv) wv.textContent = _nx.myViewerCount;
      var mv = _el('nxMyChannelViewers'); if (mv) mv.textContent = _nx.myViewerCount;
    }, function(){}
  );
}

function _updateMyNowTransmitting(d) {
  var title  = d.currentTitle  || 'THE ETERNAL SILENCE';
  var artist = d.currentArtist || '';
  var next   = d.nextTitle     || '';
  var el = _el('nxNtTitle');  if (el) el.textContent = title;
  var ae = _el('nxNtArtist'); if (ae) ae.textContent = artist;
  var ne = _el('nxNtNext');   if (ne) ne.textContent = next ? 'UP NEXT: ' + next : '';
  var scene = _stableScene(title);
  var se = _el('nxSceneLabel'); if (se) se.textContent = scene;
  var sn = _el('nxSceneName'); if (sn) sn.textContent = scene;
  // My Channel panel NP
  var mt = _el('nxMyChannelNPTitle'); if (mt) mt.textContent = title;
  var ma = _el('nxMyChannelNPArtist'); if (ma) ma.textContent = artist;
  _renderProphecyQueueFromNP(d);
  _activateVisualScene(title);
  // Update nexusChannels doc with current media
  var fs = _fs();
  if (fs && _nx.user) {
    fs.updateDoc(fs.doc(fs.db, 'nexusChannels', _nx.user.uid), {currentMedia: title, updatedAt: fs.serverTimestamp()}).catch(function(){});
  }
}

function _renderProphecyQueueFromNP(d) {
  var el = _el('nxProphecyQueueList');
  if (!el) return;
  var current = d.currentTitle || 'Untitled';
  var next1   = d.nextTitle    || '';
  var html = '<li class="nx-queue-item nx-queue-current">' +
    '<span class="nx-queue-num">♪</span>' +
    '<span class="nx-queue-title">' + _esc(current) + '</span>' +
    '<span class="nx-queue-type-badge">NOW</span>' +
  '</li>';
  if (next1) {
    html += '<li class="nx-queue-item">' +
      '<span class="nx-queue-num">2</span>' +
      '<span class="nx-queue-title">' + _esc(next1) + '</span>' +
    '</li>';
  }
  el.innerHTML = html;
}

function _subscribeMyChannelStats() {
  var fs = _fs();
  if (!fs || !_nx.user) return;
  // Subscribe to nexusChannels doc for live viewer/like updates
  fs.onSnapshot(
    fs.doc(fs.db, 'nexusChannels', _nx.user.uid),
    function(snap) {
      if (!snap || !snap.exists()) return;
      var d = snap.data();
      _nx.myViewerCount = d.viewerCount || 0;
      _nx.myLikeCount   = d.likeCount   || 0;
      var wv = _el('nxWatchViewers'); if (wv) wv.textContent = _nx.myViewerCount;
      var mv = _el('nxMyChannelViewers'); if (mv) mv.textContent = _nx.myViewerCount;
      var ml = _el('nxMyChannelLikes'); if (ml) ml.textContent = _nx.myLikeCount;
      var lc = _el('nxLikeCount'); if (lc) lc.textContent = _nx.myLikeCount;
      var lb = _el('nxMyChannelLiveBadge');
      if (lb) lb.style.display = d.isLive ? '' : 'none';
      var sb = _el('nxChannelStopBtn');
      if (sb) sb.style.display = d.isLive ? '' : 'none';
    }, function(){}
  );
}

/* ═══════════════════════════════════════════════════════
   MY CHANNEL LIKE (own stream)
═══════════════════════════════════════════════════════ */
window.snxNexusToggleLike = function() {
  if (!_nx.user || !_nx.user.uid) { _toastError('Sign in to like.'); return; }
  var channelId = _nx.user.uid; // watching own channel in this tab
  var fs = _fs();
  if (!fs) return;
  var likeRef = fs.doc(fs.db, 'cloudStreamLikes', channelId, 'likes', _nx.user.uid);
  if (_nx.myLiked) {
    fs.deleteDoc(likeRef).then(function() {
      _nx.myLiked = false;
      _nx.myLikeCount = Math.max(0, _nx.myLikeCount - 1);
      var btn = _el('nxLikeBtn'); if (btn) btn.classList.remove('liked');
      var lc = _el('nxLikeCount'); if (lc) lc.textContent = _nx.myLikeCount;
      fs.updateDoc(fs.doc(fs.db, 'nexusChannels', channelId), {likeCount: fs.increment(-1)}).catch(function(){});
    }).catch(function(){});
  } else {
    fs.setDoc(likeRef, {uid: _nx.user.uid, ts: fs.serverTimestamp()}).then(function() {
      _nx.myLiked = true;
      _nx.myLikeCount++;
      var btn = _el('nxLikeBtn'); if (btn) btn.classList.add('liked');
      var lc = _el('nxLikeCount'); if (lc) lc.textContent = _nx.myLikeCount;
      fs.updateDoc(fs.doc(fs.db, 'nexusChannels', channelId), {likeCount: fs.increment(1)}).catch(function(){});
    }).catch(function(){});
  }
};

/* ═══════════════════════════════════════════════════════
   CHANNEL CONTROLS (user's own channel — NOT founder controls)
═══════════════════════════════════════════════════════ */
window.snxNexusChannelPlayPause = function() {
  if (typeof snxCSMusicPlayPause === 'function') snxCSMusicPlayPause();
};

window.snxNexusChannelSkip = function() {
  if (typeof snxCSMusicNext === 'function') snxCSMusicNext();
  _toast('Skipped to next track.');
};

window.snxNexusChannelStop = function() {
  if (!confirm('Stop your channel?\nThis will end the broadcast for all viewers.')) return;
  if (typeof snxCSStop === 'function') snxCSStop();
  var fs = _fs();
  if (fs && _nx.user) {
    fs.updateDoc(fs.doc(fs.db, 'nexusChannels', _nx.user.uid), {
      isLive: false, activeStreamId: null, updatedAt: fs.serverTimestamp()
    }).catch(function(){});
  }
  _toastOk('Channel stopped.');
};

window.snxNexusStartStream = function() {
  var titleEl = _el('nxChannelStreamTitle');
  var name = (titleEl||{}).value || (_nx.myChannel && _nx.myChannel.channelName) || 'My Channel — Now Live';
  var nameEl = _el('snxCSStreamName');
  if (nameEl) nameEl.value = name;
  if (typeof snxStartCloudStream === 'function') {
    snxStartCloudStream();
    // After starting, update nexusChannels to mark as live
    setTimeout(function() {
      var fs = _fs();
      if (!fs || !_nx.user) return;
      // Find the active stream
      fs.getDocs(fs.query(
        fs.collection(fs.db, 'cloudStreams'),
        fs.where('uid', '==', _nx.user.uid),
        fs.where('status', 'in', ['active','starting']),
        fs.limit(1)
      )).then(function(snap) {
        if (!snap || !snap.docs || !snap.docs.length) return;
        var streamId = snap.docs[0].id;
        _nx.myStreamId = streamId;
        fs.updateDoc(fs.doc(fs.db, 'nexusChannels', _nx.user.uid), {
          isLive: true,
          activeStreamId: streamId,
          updatedAt: fs.serverTimestamp()
        }).catch(function(){});
        _subscribeMyStream(streamId);
      }).catch(function(){});
    }, 3000);
    _toastOk('Starting your Eternal Stream…');
  } else {
    _toastError('Stream system not ready. Try the Studio page first.');
  }
};

/* ═══════════════════════════════════════════════════════
   VISUAL SCENE ENGINE — TOMB OF SOUND
═══════════════════════════════════════════════════════ */
function _activateVisualScene(title) {
  var canvas = _el('nxSceneCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width  = canvas.offsetWidth  || 360;
  canvas.height = canvas.offsetHeight || 200;
  _drawScene(ctx, canvas.width, canvas.height, title);
}

function _drawScene(ctx, W, H, title) {
  var scene = _stableScene(title);
  var palettes = {
    'ANUBIS CHAMBER':       ['#c5a41d','#1a2a1a','#8a6f0d'],
    'BLOOD PYRAMID':        ['#8a0a14','#c5a41d','#2a0a0a'],
    'PHARAOH\'S GALAXY':   ['#1a0a3a','#c5a41d','#7c3acf'],
    'CURSED TOMB':          ['#1a1a0a','#8a6f0d','#3a0a0a'],
    'EYE OF THE NEXUS':     ['#1ad3d3','#c5a41d','#0a1a2a'],
    'DESERT AFTER MIDNIGHT':['#c5a41d','#0a0a1a','#3a2a0a'],
    'UNDERWORLD':           ['#3a0a0a','#c5a41d','#0a0a0a'],
    'CELESTIAL TEMPLE':     ['#7c3acf','#c5a41d','#1a0a3a']
  };
  var pal = palettes[scene] || palettes['ANUBIS CHAMBER'];
  var grd = ctx.createLinearGradient(0,0,W,H);
  grd.addColorStop(0, pal[1]);
  grd.addColorStop(0.5, pal[2] + '66');
  grd.addColorStop(1, '#000');
  ctx.fillStyle = grd;
  ctx.fillRect(0,0,W,H);
  var bars = 24;
  var bw   = (W - 20) / bars;
  for (var i = 0; i < bars; i++) {
    var h  = 8 + Math.random() * (H * 0.55);
    var x  = 10 + i * bw;
    var alpha = 0.3 + Math.random() * 0.5;
    ctx.fillStyle = pal[0] + Math.floor(alpha * 255).toString(16).padStart(2,'0');
    ctx.fillRect(x, H - h, bw * 0.65, h);
  }
  ctx.font = 'bold ' + Math.floor(H * 0.28) + 'px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = pal[0];
  ctx.fillText('𓂀', W/2, H/2);
  ctx.globalAlpha = 1;
  ctx.font = '700 11px "Segoe UI", sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = pal[0] + 'cc';
  ctx.fillText(scene, W - 10, H - 6);
}

/* ═══════════════════════════════════════════════════════
   VAULT
═══════════════════════════════════════════════════════ */
function _loadVault() { _renderVault(); }

function _renderVault() {
  var el = _el('nxVaultList');
  if (!el) return;
  var tracks = (window._snxNexusTracks) ? window._snxNexusTracks
             : (window._music && window._music.tracks) ? window._music.tracks
             : [];
  if (!tracks || !tracks.length) {
    el.innerHTML = '<div class="nx-empty"><div class="nx-empty-icon">𓂀</div><div class="nx-empty-text">The Vault is empty.<br>Upload music, video, or pictures.</div></div>';
    if (typeof _mlLoadTracks === 'function') _mlLoadTracks();
    return;
  }
  var filter = _nx.mediaFilter;
  var q = (_el('nxVaultSearch') || {}).value || '';
  var filtered = tracks.filter(function(t) {
    var typeMatch = filter === 'all' || (t.mediaType || 'music') === filter;
    if (!typeMatch) return false;
    if (!q) return true;
    var ql = q.toLowerCase();
    return (t.title||'').toLowerCase().includes(ql) || (t.artist||'').toLowerCase().includes(ql);
  });
  var count = _el('nxVaultCount');
  if (count) count.textContent = filtered.length + ' ITEMS';
  if (!filtered.length) {
    el.innerHTML = '<div class="nx-empty"><div class="nx-empty-icon">🔍</div><div class="nx-empty-text">No items found.</div></div>';
    return;
  }
  el.innerHTML = filtered.map(function(t) {
    var type     = t.mediaType || 'music';
    var typeIcon = type === 'video' ? '🎬' : type === 'picture' ? '🖼️' : '🎵';
    var dur      = t.duration ? _fmtDur(t.duration) : '—';
    var art      = t.artworkUrl || t.thumbnailUrl || '';
    var inSQ     = (window._sq && window._sq.queue && window._sq.queue.some(function(q) { return q.id === t.id; }));
    return '<div class="nx-track-item" data-tid="' + _esc(t.id) + '">' +
      '<div class="nx-track-artwork">' + (art ? '<img src="' + _esc(art) + '" alt="" loading="lazy">' : typeIcon) + '</div>' +
      '<div class="nx-track-info">' +
        '<div class="nx-track-title">' + _esc(t.title || 'Untitled') + '</div>' +
        '<div class="nx-track-artist">' + _esc(t.artist || t.creator || '') + '</div>' +
      '</div>' +
      '<span class="nx-track-dur">' + _esc(dur) + '</span>' +
      '<div class="nx-track-actions">' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusPreviewTrack(\'' + _esc(t.id) + '\')" title="Play">▶</button>' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusAddToQueue(\'' + _esc(t.id) + '\')" title="Add to Queue" style="color:' + (inSQ ? 'var(--nx-gold)' : '') + ';">' + (inSQ ? '✓' : '+Q') + '</button>' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusAddToPlaylistModal(\'' + _esc(t.id) + '\')" title="Add to Playlist">+PL</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxNexusVaultFilter = function(filter) {
  _nx.mediaFilter = filter;
  document.querySelectorAll('.nx-media-filter-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  _renderVault();
};
window.snxNexusVaultSearch = function() { _renderVault(); };

window.snxNexusPreviewTrack = function(trackId) {
  var tracks = (window._music && window._music.tracks) ? window._music.tracks : [];
  var t = tracks.find(function(x){ return x.id === trackId; });
  if (!t || !t.url) { _toastError('Track not ready yet.'); return; }
  if (typeof snxCSMusicPlayTrack === 'function') { snxCSMusicPlayTrack(trackId); _toast('Playing: ' + (t.title || 'Untitled')); }
};

window.snxNexusAddToQueue = function(trackId) {
  if (typeof snxSQAddToQueue === 'function') {
    snxSQAddToQueue(trackId);
    _toastOk('Added to queue.');
    _renderVault();
    if (_nx.activeTab === 'queue') _loadQueue();
  }
};

window.snxNexusAddToPlaylistModal = function(trackId) {
  var playlists = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists : [];
  if (!playlists.length) { _toast('Create a playlist first in PLAYLISTS tab.'); return; }
  var names = playlists.map(function(p,i){ return (i+1)+'. '+p.name; }).join('\n');
  var choice = prompt('Add to which playlist? (enter number)\n\n' + names);
  if (!choice) return;
  var idx = parseInt(choice, 10) - 1;
  if (idx < 0 || idx >= playlists.length) { _toastError('Invalid selection.'); return; }
  var pl = playlists[idx];
  if (typeof snxCSMusicAddSingleTrack === 'function') snxCSMusicAddSingleTrack(pl.id, trackId);
};

window.snxNexusOnTracksLoaded = function() { if (_nx.activeTab === 'vault') _renderVault(); };

/* ═══════════════════════════════════════════════════════
   PLAYLISTS
═══════════════════════════════════════════════════════ */
function _loadPlaylists() {
  if (typeof _csMusicLoadPlaylists === 'function') _csMusicLoadPlaylists();
  _renderPlaylists();
}

function _renderPlaylists() {
  var el = _el('nxPlaylistsList');
  if (!el) return;
  var playlists = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists : [];
  if (!playlists.length) {
    el.innerHTML = '<div class="nx-empty"><div class="nx-empty-icon">𓂀</div><div class="nx-empty-text">No Prophecy Playlists yet.<br>Create one to begin.</div></div>';
    return;
  }
  el.innerHTML = playlists.map(function(pl) {
    var count = (pl.trackIds && pl.trackIds.length) || 0;
    var isSel = window._csMusic && window._csMusic.selectedId === pl.id;
    return '<div class="nx-playlist-card' + (isSel ? ' selected' : '') + '" onclick="snxNexusOpenPlaylist(\'' + _esc(pl.id) + '\')">' +
      '<div class="nx-playlist-art">𓂀</div>' +
      '<div class="nx-playlist-info">' +
        '<div class="nx-playlist-name">' + _esc(pl.name) + '</div>' +
        '<div class="nx-playlist-count">' + count + ' ITEM' + (count !== 1 ? 'S' : '') + '</div>' +
      '</div>' +
      '<div class="nx-playlist-actions" onclick="event.stopPropagation();">' +
        '<button class="nx-btn nx-btn-sm" onclick="snxNexusSendToStream(\'' + _esc(pl.id) + '\')" title="Send to Stream">▶ STREAM</button>' +
        '<button class="nx-btn nx-btn-sm nx-btn-danger" onclick="snxNexusDeletePlaylist(\'' + _esc(pl.id) + '\')" title="Delete">🗑</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxNexusCreatePlaylist = function() {
  var name = prompt('𓂀 Name your Prophecy Playlist:');
  if (!name || !name.trim()) return;
  _nxCreatePlaylist(name.trim());
};

function _nxCreatePlaylist(name) {
  var fs = _fs();
  if (!fs || !_nx.user) { _toastError('Not signed in.'); return; }
  var uid = _nx.user.uid;
  var id  = 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  var pl  = { id: id, name: name, trackIds: [], shuffle: false, repeat: true, crossfade: 3, volume: 80, createdAt: fs.serverTimestamp() };
  fs.setDoc(fs.doc(fs.db, 'studioPlaylists', uid, 'playlists', id), pl)
    .then(function() {
      if (window._csMusic) window._csMusic.playlists.unshift(Object.assign({}, pl, { id: id, createdAt: Date.now() }));
      _toastOk('Playlist created: ' + name);
      _renderPlaylists();
    })
    .catch(function(e) { _toastError('Could not create: ' + e.message); });
}

window.snxNexusOpenPlaylist     = function(plId) { if (typeof snxCSMusicSelectPlaylist === 'function') snxCSMusicSelectPlaylist(plId); _showPlaylistEditor(plId); };
window.snxNexusDeletePlaylist   = function(plId) { if (!confirm('Delete this playlist?')) return; if (typeof snxCSMusicDeletePlaylist === 'function') { snxCSMusicDeletePlaylist(plId); setTimeout(_renderPlaylists, 400); } };
window.snxNexusSendToStream     = function(plId) { var modal = _el('nxStreamModal'); if (!modal) return; modal.dataset.plid = plId; modal.classList.add('open'); };
window.snxNexusStreamModalClose = function() { var modal = _el('nxStreamModal'); if (modal) modal.classList.remove('open'); };

window.snxNexusStreamPlayNow = function() {
  var modal = _el('nxStreamModal');
  if (!modal) return;
  var plId = modal.dataset.plid;
  modal.classList.remove('open');
  if (!plId) return;
  if (typeof snxCSMusicSelectPlaylist === 'function') snxCSMusicSelectPlaylist(plId);
  if (typeof snxCSMusicPlayPause === 'function') { setTimeout(function() { if (!window._csMusic || !window._csMusic.playing) snxCSMusicPlayPause(); }, 500); }
  _toastOk('Playlist sent to Eternal Stream — Playing Now.');
  snxNexusSwitchTab('watch');
};

window.snxNexusStreamAddToQueue = function() {
  var modal = _el('nxStreamModal');
  if (!modal) return;
  var plId = modal.dataset.plid;
  modal.classList.remove('open');
  if (!plId) return;
  if (typeof snxCSMusicSelectPlaylist === 'function') {
    snxCSMusicSelectPlaylist(plId);
    setTimeout(function() {
      if (window._csMusic && window._csMusic.queue && typeof snxSQAddToQueue === 'function') {
        window._csMusic.queue.forEach(function(t) { snxSQAddToQueue(t.id); });
      }
      _toastOk('Playlist added to Prophecy Queue.');
    }, 800);
  }
};

window.snxNexusStreamAddNext = function() { snxNexusStreamAddToQueue(); _toastOk('Added next in queue.'); };

function _showPlaylistEditor(plId) {
  var editorEl = _el('nxPlaylistEditor');
  if (!editorEl) return;
  editorEl.style.display = '';
  _renderPlaylistEditor(plId);
  editorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

window.snxNexusCloseEditor = function() { var el = _el('nxPlaylistEditor'); if (el) el.style.display = 'none'; };

function _renderPlaylistEditor(plId) {
  var el = _el('nxPlaylistEditorInner');
  if (!el) return;
  var playlists = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists : [];
  var pl = playlists.find(function(p){ return p.id === plId; });
  if (!pl) return;
  var queue = (window._csMusic && window._csMusic.selectedId === plId) ? window._csMusic.queue : [];
  var count = pl.trackIds ? pl.trackIds.length : 0;
  var html = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
    '<div><div class="nx-section-title" style="margin-bottom:2px;">𓂀 ' + _esc(pl.name) + '</div><div style="font-size:11px;color:var(--nx-text2);">' + count + ' ITEMS</div></div>' +
    '<div style="display:flex;gap:6px;"><button class="nx-btn nx-btn-primary" onclick="snxNexusSendToStream(\'' + _esc(plId) + '\')">▶ STREAM</button><button class="nx-btn nx-btn-sm" onclick="snxNexusCloseEditor()">✕</button></div>' +
  '</div>';
  if (queue.length) {
    html += '<div id="nxPlEditorTracks">' +
      queue.map(function(t, i) {
        return '<div class="nx-pl-edit-item">' +
          '<span class="nx-pl-num">' + (i+1) + '</span>' +
          '<div class="nx-pl-move-btns"><button class="nx-pl-move-btn" onclick="snxCSMusicMoveTrack(\'' + _esc(plId) + '\',' + i + ',-1)" ' + (i===0?'disabled':'') + '>▲</button><button class="nx-pl-move-btn" onclick="snxCSMusicMoveTrack(\'' + _esc(plId) + '\',' + i + ',1)" ' + (i===queue.length-1?'disabled':'') + '>▼</button></div>' +
          '<div class="nx-track-info" style="flex:1;min-width:0;"><div class="nx-track-title">' + _esc(t.title||'Untitled') + '</div><div class="nx-track-artist">' + _esc(t.artist||'') + '</div></div>' +
          (t.duration ? '<span class="nx-track-dur">' + _fmtDur(t.duration) + '</span>' : '') +
          '<button class="nx-btn nx-btn-sm nx-btn-danger" onclick="snxCSMusicRemoveTrackFromPlaylist(\'' + _esc(plId) + '\',\'' + _esc(t.id) + '\');snxNexusOpenPlaylist(\'' + _esc(plId) + '\')">×</button>' +
        '</div>';
      }).join('') +
    '</div>';
  } else if (count > 0) {
    html += '<div style="color:var(--nx-text2);font-size:12px;padding:12px 0;">Loading ' + count + ' tracks…</div>';
  } else {
    html += '<div class="nx-empty"><div class="nx-empty-icon">𓂀</div><div class="nx-empty-text">No tracks yet. Add from the Vault.</div></div>';
  }
  html += '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--nx-border);"><div class="nx-section-title">+ ADD FROM VAULT</div><input class="nx-input" type="search" placeholder="Search Vault…" id="nxPlEditorSearch" oninput="snxNexusPlEditorSearch(\'' + _esc(plId) + '\')" style="margin-bottom:8px;"><div id="nxPlEditorVault" style="max-height:260px;overflow-y:auto;"></div></div>';
  el.innerHTML = html;
  _renderPlEditorVault(plId, '');
}

window.snxNexusPlEditorSearch = function(plId) { _renderPlEditorVault(plId, (_el('nxPlEditorSearch')||{}).value || ''); };

function _renderPlEditorVault(plId, q) {
  var el = _el('nxPlEditorVault');
  if (!el) return;
  var tracks = (window._music && window._music.tracks) ? window._music.tracks : [];
  if (!tracks.length) { el.innerHTML = '<div style="color:var(--nx-text3);font-size:12px;padding:8px 0;">No tracks in library yet.</div>'; return; }
  var pl = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists.find(function(p){ return p.id===plId; }) : null;
  var inPl = pl && pl.trackIds ? pl.trackIds : [];
  var ql = q.toLowerCase();
  var filtered = tracks.filter(function(t) { if (!ql) return true; return (t.title||'').toLowerCase().includes(ql)||(t.artist||'').toLowerCase().includes(ql); });
  if (!filtered.length) { el.innerHTML = '<div style="color:var(--nx-text3);font-size:12px;padding:8px 0;">No results.</div>'; return; }
  el.innerHTML = filtered.map(function(t) {
    var added = inPl.indexOf(t.id) !== -1;
    return '<div class="nx-track-item"><div class="nx-track-info" style="flex:1;min-width:0;"><div class="nx-track-title">' + _esc(t.title||'Untitled') + '</div><div class="nx-track-artist">' + _esc(t.artist||'') + '</div></div><button class="nx-btn nx-btn-sm' + (added ? ' nx-btn-danger' : '') + '" onclick="snxNexusPlEditorToggle(\'' + _esc(plId) + '\',\'' + _esc(t.id) + '\',this)">' + (added ? '✓ ADDED' : '+ ADD') + '</button></div>';
  }).join('');
}

window.snxNexusPlEditorToggle = function(plId, trackId, btn) {
  var pl = (window._csMusic && window._csMusic.playlists) ? window._csMusic.playlists.find(function(p){ return p.id===plId; }) : null;
  if (!pl) return;
  var inPl = pl.trackIds && pl.trackIds.indexOf(trackId) !== -1;
  if (inPl) { if (typeof snxCSMusicRemoveTrackFromPlaylist === 'function') snxCSMusicRemoveTrackFromPlaylist(plId, trackId); if (btn) { btn.textContent = '+ ADD'; btn.classList.remove('nx-btn-danger'); } }
  else { if (typeof snxCSMusicAddSingleTrack === 'function') snxCSMusicAddSingleTrack(plId, trackId); if (btn) { btn.textContent = '✓ ADDED'; btn.classList.add('nx-btn-danger'); } }
};

window.snxNexusOnPlaylistsLoaded = function() { if (_nx.activeTab === 'playlists') _renderPlaylists(); };

/* ═══════════════════════════════════════════════════════
   QUEUE
═══════════════════════════════════════════════════════ */
function _loadQueue()  { _renderQueue(); }

function _renderQueue() {
  var el = _el('nxQueueList');
  if (!el) return;
  var npTitle  = (window._csMusic && window._csMusic.nowPlayingTitle)  || '—';
  var npArtist = (window._csMusic && window._csMusic.nowPlayingArtist) || '';
  var npEl = _el('nxNPTitle');  if (npEl) npEl.textContent  = npTitle;
  var naEl = _el('nxNPArtist'); if (naEl) naEl.textContent = npArtist;
  var ntEl = _el('nxNPNext');   if (ntEl) ntEl.textContent = (window._csMusic && window._csMusic.nextTitle) ? 'NEXT: ' + window._csMusic.nextTitle : '';
  var sq    = (window._sq && window._sq.queue) ? window._sq.queue : [];
  var sqIdx = (window._sq && window._sq.queueIndex) || 0;
  if (!sq.length) { el.innerHTML = '<div class="nx-empty"><div class="nx-empty-icon">𓂀</div><div class="nx-empty-text">The Prophecy Queue is empty.<br>Add tracks from the Vault or Playlists.</div></div>'; return; }
  el.innerHTML = sq.map(function(t, i) {
    var isCur = i === sqIdx;
    return '<div class="nx-sq-item' + (isCur ? ' nx-sq-current' : '') + '">' +
      '<span style="width:20px;text-align:center;font-size:12px;color:var(--nx-text3);flex-shrink:0;">' + (isCur ? '♪' : (i+1)) + '</span>' +
      '<div class="nx-track-info" style="flex:1;min-width:0;"><div class="nx-track-title">' + _esc(t.title||'Untitled') + '</div><div class="nx-track-artist">' + _esc(t.artist||'') + '</div></div>' +
      (t.duration ? '<span class="nx-track-dur">' + _fmtDur(t.duration) + '</span>' : '') +
      '<div style="display:flex;gap:4px;">' +
        (i > 0 ? '<button class="nx-btn nx-btn-sm" onclick="snxNexusQueueMoveNext(' + i + ')" title="Move to Next">⬆</button>' : '') +
        '<button class="nx-btn nx-btn-sm nx-btn-danger" onclick="snxNexusQueueRemove(' + i + ')" title="Remove">×</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

window.snxNexusQueuePlayPause = function() { if (typeof snxSQPlayPause === 'function') snxSQPlayPause(); _renderQueue(); };
window.snxNexusQueueSkip      = function() { if (typeof snxSQSkip     === 'function') snxSQSkip();     setTimeout(_renderQueue, 300); };
window.snxNexusQueueClear     = function() { if (!confirm('Clear the Prophecy Queue?')) return; if (typeof snxSQClear === 'function') snxSQClear(); setTimeout(_renderQueue, 300); };

window.snxNexusQueueRemove = function(idx) {
  if (window._sq && window._sq.queue) { window._sq.queue.splice(idx, 1); if (typeof snxSQRenderQueue === 'function') snxSQRenderQueue(); _renderQueue(); }
};

window.snxNexusQueueMoveNext = function(idx) {
  if (!window._sq || !window._sq.queue) return;
  var q = window._sq.queue;
  var cur = window._sq.queueIndex || 0;
  var insertAt = cur + 1;
  if (insertAt >= q.length) insertAt = q.length - 1;
  if (idx === insertAt) return;
  var item = q.splice(idx, 1)[0];
  q.splice(insertAt, 0, item);
  if (typeof snxSQRenderQueue === 'function') snxSQRenderQueue();
  _renderQueue();
};

window.snxNexusOnQueueUpdate = function() { if (_nx.activeTab === 'queue') _renderQueue(); };

/* ═══════════════════════════════════════════════════════
   UPLOAD
═══════════════════════════════════════════════════════ */
function _loadUpload() { _renderUploadTypeBar(); }

function _renderUploadTypeBar() {
  document.querySelectorAll('.nx-upload-type-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.type === _nx.uploadType);
  });
  var fileInput = _el('nxUploadFileInput');
  if (!fileInput) return;
  var accepts = { music: 'audio/*,.mp3,.m4a,.aac,.ogg,.wav,.flac,.opus', video: 'video/*,.mp4,.mov,.webm,.mkv', picture: 'image/*,.jpg,.jpeg,.png,.gif,.webp' };
  fileInput.accept = accepts[_nx.uploadType] || accepts.music;
}

window.snxNexusSetUploadType = function(type) { _nx.uploadType = type; _renderUploadTypeBar(); };
window.snxNexusOpenFilePicker = function() { var inp = _el('nxUploadFileInput'); if (inp) inp.click(); };

window.snxNexusFilesSelected = function(event) {
  var files = event && event.target && event.target.files;
  if (!files || !files.length) return;
  if (_nx.uploadType === 'music' && typeof snxMusicFilesSelected === 'function') { snxMusicFilesSelected(event); }
  else { _nxUploadFiles(files); }
};

function _nxUploadFiles(files) {
  Array.from(files).forEach(function(file) { _nxUploadSingleFile(file); });
}

function _nxUploadSingleFile(file) {
  var progressEl = _el('nxUploadProgress');
  var barEl      = _el('nxUploadProgressBar');
  if (progressEl) progressEl.style.display = '';
  var ext    = file.name.split('.').pop().toLowerCase();
  var type   = _nx.uploadType;
  var uid    = _nx.user ? _nx.user.uid : 'anon';
  var fname  = uid + '/' + type + '/' + Date.now() + '_' + file.name.replace(/[^a-zA-Z0-9._-]/g,'_');
  var UPLOAD_URL = 'https://yellow-term-11e6.nthntjrn.workers.dev';
  var form = new FormData();
  form.append('file', file, fname);
  form.append('path', fname);
  form.append('uid',  uid);
  var xhr = new XMLHttpRequest();
  xhr.open('POST', UPLOAD_URL + '/upload', true);
  var token = _nx.user ? _nx.user.accessToken : null;
  if (token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  xhr.upload.onprogress = function(e) { if (e.lengthComputable && barEl) barEl.style.width = Math.round((e.loaded/e.total)*100) + '%'; };
  xhr.onload = function() {
    if (progressEl) progressEl.style.display = 'none';
    if (barEl) barEl.style.width = '0%';
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var res = JSON.parse(xhr.responseText);
        _nxSaveMediaToFirestore(file, res.url || res.publicUrl || '', type);
        _toastOk('Upload complete: ' + file.name);
      } catch(e) { _toastError('Upload failed: bad response'); }
    } else { _toastError('Upload failed: ' + xhr.status); }
  };
  xhr.onerror = function() { if (progressEl) progressEl.style.display = 'none'; _toastError('Upload error.'); };
  xhr.send(form);
}

function _nxSaveMediaToFirestore(file, url, type) {
  var fs  = _fs();
  var uid = _nx.user ? _nx.user.uid : null;
  if (!fs || !uid) return;
  var id   = 'nx_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  var data = {
    id: id, title: file.name.replace(/\.[^.]+$/, '').replace(/_/g,' '),
    artist: (_nx.userData && (_nx.userData.displayName || _nx.userData.username)) || '',
    mediaType: type, url: url, status: 'ready', size: file.size,
    uploadedAt: fs.serverTimestamp(), uid: uid
  };
  fs.setDoc(fs.doc(fs.db, 'cloudStreamTracks', uid, 'tracks', id), data)
    .then(function() { if (typeof _mlLoadTracks === 'function') _mlLoadTracks(); })
    .catch(function(e) { console.warn('[NX Upload]', e.message); });
}

/* ═══════════════════════════════════════════════════════
   PUBLIC API — studio.js hooks
═══════════════════════════════════════════════════════ */
window.snxNexusRefreshTab = function() { if (_nx.activeTab) _loadActiveTab(_nx.activeTab); };

var _origRenderCSPlaylistPanel = null;
function _hookStudioFunctions() {
  if (typeof window._renderCSPlaylistPanel === 'function' && !_origRenderCSPlaylistPanel) {
    _origRenderCSPlaylistPanel = window._renderCSPlaylistPanel;
    window._renderCSPlaylistPanel = function() {
      _origRenderCSPlaylistPanel.apply(this, arguments);
      if (_nx.activeTab === 'playlists') _renderPlaylists();
    };
  }
}
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', _hookStudioFunctions); }
else { _hookStudioFunctions(); }

})(); // end IIFE
