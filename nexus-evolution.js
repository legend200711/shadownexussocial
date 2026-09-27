/**
 * nexus-evolution.js — Shadow Nexus Social Complete Nexus Evolution
 * Implements all 18 systems as one coordinated module.
 *
 * Checkpoints:
 *   A — Presence, Privacy, Vault, AudioCoordinator
 *   B — Nexus Home, Nexus Pulse, Social Connections
 *   C — Messages 2.0 (typing, reactions, voice, status)
 *   D — Music Identity, Mini Player integration
 *   E — Nexus Watch, Live Discovery
 *   F — Search the Nexus (enhanced), The Vault UI
 *   G — Profile Themes (simple), Milestones, Privacy Center UI
 *   H — Mobile Gestures, Onboarding, Empty States, Quick Create
 *
 * Dependencies (set by index.html before this script):
 *   window._snxFirestore  — { db, doc, getDoc, getDocs, setDoc, addDoc,
 *                             updateDoc, deleteDoc, collection, query,
 *                             where, orderBy, limit, onSnapshot,
 *                             serverTimestamp, arrayUnion, arrayRemove }
 *   window._snxCurrentUser — Firebase Auth user object
 *   window._snxUserData    — current user's Firestore doc data
 *   window._snxRole        — 'founder'|'member'|'moderator'|'admin'
 *   window._snxRTDB        — Firebase Realtime Database instance
 *   window.toastNotification(msg)
 *   window.realmNavTo(pageId)
 *   window.navTo(pageId)
 *   window.SNXPerf         — from snx-perf.js
 *   window.SNXPlayer       — from snx-mini-player.js
 *   window.SNXVault        — from snx-vault.js
 *   window.SNXPresence     — from snx-presence.js
 *   window.SNXPrivacy      — from snx-privacy.js
 *   window.SNXAudioCoordinator — from snx-audio-coordinator.js
 */
'use strict';

(function () {

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */
function _fs()   { return window._snxFirestore || {}; }
function _cu()   { return window._snxCurrentUser; }
function _ud()   { return window._snxUserData || {}; }
function _uid()  { return _cu() ? _cu().uid : null; }
function _esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function _el(id) { return document.getElementById(id); }
function _ts(ms) {
  var d = new Date(ms); var now = Date.now();
  var diff = Math.floor((now - ms) / 1000);
  if (diff < 60)  return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return d.toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
function _toast(msg){ if(typeof window.toastNotification==='function') window.toastNotification(msg); }
function _db(){ return (window._snxFirestore&&window._snxFirestore.db)||null; }
function _emptyState(icon,title,sub){
  return '<div class="snx-empty-state"><div class="snx-empty-icon">'+icon+'</div><div class="snx-empty-title">'+_esc(title)+'</div><div class="snx-empty-sub">'+_esc(sub)+'</div></div>';
}

/* ── Lifecycle registry ── */
var _cleanups={};
function _addCleanup(page,fn){ if(!_cleanups[page])_cleanups[page]=[]; _cleanups[page].push(fn); }
function _runCleanup(page){ (_cleanups[page]||[]).forEach(function(fn){try{fn();}catch(e){}}); _cleanups[page]=[]; }

/* ═══ ROUTE HOOK ═══ */
var _prevPage=null;
(function(){
  function _wrap(orig){
    return function(pageId){
      if(_prevPage&&_prevPage!==pageId) _runCleanup(_prevPage);
      _prevPage=pageId;
      var r=orig.call(this,pageId);
      _onPageEnter(pageId);
      return r;
    };
  }
  var _poll=setInterval(function(){
    if(typeof window.navTo==='function'){
      clearInterval(_poll);
      window.navTo=_wrap(window.navTo);
    }
  },100);
})();

function _onPageEnter(p){
  switch(p){
    case 'nexusHomePage':     _initNexusHome();    break;
    case 'nexusPulsePage':    _initNexusPulse();   break;
    case 'nexusWatchPage':    _initNexusWatch();   break;
    case 'liveDiscoverPage':  _initLiveDiscover(); break;
    case 'vaultPage':         _initVault();        break;
    case 'privacyCenterPage': _initPrivacyCenter();break;
    case 'milestonesPage':    _initMilestones();   break;
    case 'connectionsPage':   _initConnections();  break;
    case 'inboxPage':         setTimeout(_enhanceMessages,400); break;
    case 'profile':           setTimeout(_enhanceProfile,300);  break;
  }
}

/* ═══ AUTH READY ═══ */
(function(){
  var _fired=false;
  function _maybeAuth(){
    if(_fired) return;
    var cu=window._snxCurrentUser;
    if(!cu||!window._snxFirestore) return;
    _fired=true;
    var rtdb=window._snxRTDB, db=window._snxFirestore.db;
    if(window.SNXPresence&&rtdb) window.SNXPresence.init(cu.uid,rtdb,db);
    _checkOnboarding(cu,window._snxUserData);
    _initQuickCreate();
    _wireAudioCoordinator();
    try{ document.dispatchEvent(new CustomEvent('snxAuthReady',{detail:{uid:cu.uid,rtdb:rtdb,db:db}})); }catch(_){}
  }
  var _p=setInterval(function(){
    if(window._snxCurrentUser&&window._snxUserData){ clearInterval(_p); _maybeAuth(); }
  },300);
  document.addEventListener('snxUserDataReady',_maybeAuth);
})();

/* ═══ AUDIO COORDINATOR ═══ */
function _wireAudioCoordinator(){
  if(!window.SNXAudioCoordinator) return;
  SNXAudioCoordinator.on('pause',function(src){
    if(src==='miniPlayer'&&window.SNXPlayer) window.SNXPlayer.pause();
  });
  SNXAudioCoordinator.on('duck',function(src){
    if(src==='miniPlayer'&&window.SNXPlayer&&window.SNXPlayer._audio)
      window.SNXPlayer._audio.volume=0.25;
  });
  SNXAudioCoordinator.on('unduck',function(src){
    if(src==='miniPlayer'&&window.SNXPlayer&&window.SNXPlayer._audio)
      window.SNXPlayer._audio.volume=1;
  });
  SNXAudioCoordinator.on('kill',function(src){
    if(src==='welcomeMusic'){
      var a=document.getElementById('nexusWelcomeAudio')||document.getElementById('bgMusic')||document.getElementById('welcomeAudio');
      if(a&&!a.paused) a.pause();
    }
  });
}

/* ══════════════════════════════════════════════════════
   1. NEXUS HOME
══════════════════════════════════════════════════════ */
function _initNexusHome(){
  var page=_el('nexusHomePage');
  if(!page) return;
  var cu=_cu(),ud=_ud();
  if(!cu) return;
  page.innerHTML='<div class="section-card">'
    +'<div class="nh-welcome">'
      +'<div class="nh-avatar" style="'+(ud.avatar?'background-image:url('+_esc(ud.avatar)+');background-size:cover;':'')+'background-size:cover;">'+(ud.avatar?'':_esc((ud.displayName||'?').charAt(0)))+'</div>'
      +'<div><div class="nh-greeting">Welcome back, '+_esc(ud.displayName||'Nexus Member')+' 🌑</div>'
        +'<div class="nh-status"><div class="nh-status-dot"></div><span>'+_esc(ud.presenceCustom||'Online')+'</span></div>'
      +'</div>'
    +'</div>'
    +'<div class="nh-section"><div class="nh-section-title">🔴 Live Now <a onclick="realmNavTo(\'liveDiscoverPage\')" href="#">See all</a></div><div id="nhLive"></div></div>'
    +'<div class="nh-section"><div class="nh-section-title">🟢 Friends Online <a onclick="realmNavTo(\'connectionsPage\')" href="#">View all</a></div><div class="nh-friends-row" id="nhFriends"></div></div>'
    +'<div class="nh-section"><div class="nh-section-title">💬 Messages <a onclick="realmNavTo(\'inboxPage\')" href="#">Open</a></div><div id="nhMsgs"></div></div>'
    +'<div class="nh-section"><div class="nh-section-title">⚡ Nexus Pulse <a onclick="realmNavTo(\'nexusPulsePage\')" href="#">See all</a></div><div id="nhPulse"></div></div>'
    +'<div id="nhNowPlayingWrap" style="display:none;"><div class="nh-section-title">🎵 Now Playing</div><div id="nhNowPlaying"></div></div>'
    +'<div class="nh-quick-create">'
      +'<button class="nh-qc-btn" onclick="window._snxQCAction(\'post\')">✦ Post</button>'
      +'<button class="nh-qc-btn" onclick="window._snxQCAction(\'story\')">📖 Story</button>'
      +'<button class="nh-qc-btn" onclick="window._snxQCAction(\'music\')">🎵 Music</button>'
      +'<button class="nh-qc-btn" onclick="window._snxQCAction(\'video\')">🎬 Video</button>'
      +'<button class="nh-qc-btn" onclick="window._snxQCAction(\'live\')">🔴 Go Live</button>'
    +'</div>'
  +'</div>';
  _nhLoadLive(); _nhLoadFriends(); _nhLoadMsgs(); _nhLoadPulse(); _nhNowPlaying();
}
function _nhLoadLive(){
  var cont=_el('nhLive'),db=_db(),fs=_fs();
  if(!cont||!db) return;
  fs.getDocs(fs.query(fs.collection(db,'liveRooms'),fs.where('isLive','==',true),fs.limit(4)))
  .then(function(s){
    if(!s||s.empty){cont.innerHTML=_emptyState('📡','The Nexus is quiet right now.','');return;}
    var h='<div style="display:flex;gap:10px;overflow-x:auto;scrollbar-width:none;">';
    s.docs.forEach(function(d){var r=d.data();
      h+='<div onclick="realmNavTo(\'liveDiscoverPage\')" style="flex-shrink:0;cursor:pointer;width:150px;">'
        +'<div class="snx-live-disc-card">'
          +'<div class="snx-live-disc-thumb">'+(r.thumbUrl?'<img src="'+_esc(r.thumbUrl)+'" style="width:100%;height:100%;object-fit:cover;" loading="lazy">':'<span style="font-size:28px;">'+_esc((r.hostName||'?').charAt(0))+'</span>')
          +'<div class="snx-live-disc-pill">LIVE</div>'+(r.viewers?'<div class="snx-live-disc-viewers">👁 '+r.viewers+'</div>':'')
          +'</div><div class="snx-live-disc-body"><div class="snx-live-disc-name">'+_esc(r.hostName||'Creator')+'</div></div>'
        +'</div></div>';});
    h+='</div>';cont.innerHTML=h;
  }).catch(function(){});
}
function _nhLoadFriends(){
  var cont=_el('nhFriends'),ud=_ud();
  if(!cont) return;
  var friends=(ud.friends||[]).slice(0,8);
  if(!friends.length){cont.innerHTML='<span style="color:#2a4a6a;font-size:12px;">No friends yet.</span>';return;}
  friends.forEach(function(fuid){
    if(!window.SNXPresence) return;
    var unsub=window.SNXPresence.watchUser(fuid,function(pres){
      if(pres.status==='offline') return;
      var db=_db(),fs=_fs();
      if(!db) return;
      fs.getDoc(fs.doc(db,'users',fuid)).then(function(sn){
        if(!sn.exists()) return;
        var u=sn.data();
        var el=document.createElement('div');
        el.className='nh-friend-bubble';
        el.onclick=function(){window.viewProfile&&window.viewProfile(fuid);};
        el.innerHTML='<div class="nh-friend-av '+_esc(pres.status)+'" style="'+(u.avatar?'background-image:url('+_esc(u.avatar)+');background-size:cover;':'')+'font-size:16px;font-weight:700;">'+(u.avatar?'':_esc((u.displayName||'?').charAt(0)))+'</div>'
          +'<div class="nh-friend-name">'+_esc((u.displayName||'User').slice(0,8))+'</div>';
        cont.appendChild(el);
      }).catch(function(){});
    });
    if(typeof unsub==='function') _addCleanup('nexusHomePage',unsub);
  });
}
function _nhLoadMsgs(){
  var cont=_el('nhMsgs'),cu=_cu(),db=_db(),fs=_fs();
  if(!cont||!cu||!db) return;
  fs.getDocs(fs.query(fs.collection(db,'chats'),fs.where('participants','array-contains',cu.uid),fs.orderBy('lastMsgTs','desc'),fs.limit(3)))
  .then(function(s){
    if(!s||s.empty){cont.innerHTML='<div style="color:#2a4a6a;font-size:12px;">No messages yet.</div>';return;}
    var h='';
    s.docs.forEach(function(d){
      var c=d.data(),oid=(c.participants||[]).filter(function(p){return p!==cu.uid;})[0]||'';
      var unread=c['unread_'+cu.uid]||0;
      var last=c.messages&&c.messages.length?c.messages[c.messages.length-1]:null;
      var prev=last?(last.text||(last.type==='voice'?'🎙 Voice':'📎 Media')):'…';
      h+='<div onclick="realmNavTo(\'inboxPage\')" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(0,50,100,0.15);cursor:pointer;">'
        +'<div style="width:36px;height:36px;border-radius:50%;background:rgba(0,40,100,0.6);border:1.5px solid rgba(0,174,239,0.3);display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#00AEEF;flex-shrink:0;" id="nhMav_'+_esc(oid)+'">?</div>'
        +'<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:'+(unread?'700':'500')+';color:'+(unread?'#e0f0ff':'#8ab0cc')+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" id="nhMn_'+_esc(oid)+'">Loading…</div>'
          +'<div style="font-size:11px;color:#3a5a7a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+_esc(String(prev).slice(0,50))+'</div></div>'
        +(unread?'<div style="min-width:18px;height:18px;background:#00AEEF;color:#001;font-size:10px;font-weight:800;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 3px;">'+unread+'</div>':'')
      +'</div>';
      if(oid&&db){
        fs.getDoc(fs.doc(db,'users',oid)).then(function(sn){
          if(!sn.exists()) return;
          var u=sn.data();
          var ne=_el('nhMn_'+oid),ae=_el('nhMav_'+oid);
          if(ne) ne.textContent=u.displayName||'User';
          if(ae){ if(u.avatar){ae.style.backgroundImage='url('+u.avatar+')';ae.style.backgroundSize='cover';ae.textContent='';}else ae.textContent=(u.displayName||'?').charAt(0); }
        }).catch(function(){});
      }
    });
    cont.innerHTML=h;
  }).catch(function(){cont.innerHTML='<div style="color:#2a4a6a;font-size:12px;">Could not load messages.</div>';});
}
function _nhLoadPulse(){ _loadPulseItems(_el('nhPulse'),4); }
function _nhNowPlaying(){
  if(!window.SNXPlayer) return;
  var wrap=_el('nhNowPlayingWrap'),cont=_el('nhNowPlaying');
  if(!wrap||!cont) return;
  function _r(){
    var t=window.SNXPlayer.current;
    if(t&&window.SNXPlayer.isPlaying()){
      wrap.style.display='';
      cont.innerHTML='<div class="snx-music-post-card" style="margin:0;">'
        +'<div class="snx-music-card-art" style="'+(t.artUrl?'background-image:url('+_esc(t.artUrl)+');background-size:cover;':'')+'"></div>'
        +'<div class="snx-music-card-info"><div class="snx-music-card-title">'+_esc(t.title||'Unknown')+'</div><div class="snx-music-card-artist">'+_esc(t.artist||'')+'</div></div>'
        +'<div class="snx-music-card-actions"><button class="snx-music-play-btn" onclick="SNXPlayer.pause()">⏸</button></div>'
      +'</div>';
    } else { wrap.style.display='none'; }
  }
  _r();
  ['trackChange','pause','play','stop'].forEach(function(ev){ window.SNXPlayer.on(ev,_r); });
  _addCleanup('nexusHomePage',function(){
    ['trackChange','pause','play','stop'].forEach(function(ev){ window.SNXPlayer.off(ev,_r); });
  });
}
/* nexus-evolution.js — Part 2: Pulse, Connections, Messages 2.0, Music, Watch, Live, Vault, Privacy, Milestones, Quick Create, Onboarding, Empty States, Mobile Gestures */

/* ══════════════════════════════════════════════════════
   2. NEXUS PULSE
══════════════════════════════════════════════════════ */
function _initNexusPulse(){
  var page=_el('nexusPulsePage');
  if(!page) return;
  var prefs=_pulseCatPrefs();
  page.innerHTML='<div class="section-card"><h3 style="margin:0 0 14px;color:#00ccff;font-size:16px;">⚡ Nexus Pulse</h3>'
    +'<div class="snx-pulse-filter-row" id="pulseFilters">'+_renderPulseFilters(prefs)+'</div>'
    +'<div id="pulseList"></div>'
  +'</div>';
  _loadPulseItems(_el('pulseList'),25);
  _addCleanup('nexusPulsePage',function(){});
}
function _pulseCatPrefs(){
  try{ return JSON.parse(localStorage.getItem('snxPulseCats')||'{}'); }catch(_){ return {}; }
}
function _pulseCatEnabled(id){ var p=_pulseCatPrefs(); return p[id]!==false; }
function _renderPulseFilters(prefs){
  return [{id:'live',l:'🔴 Live'},{id:'music',l:'🎵 Music'},{id:'post',l:'✦ Posts'},{id:'story',l:'📖 Stories'},{id:'video',l:'🎬 Video'}]
  .map(function(c){ return '<button class="snx-pulse-filter-btn'+(prefs[c.id]!==false?' active':'')+'" onclick="snxPulseFilter(\''+c.id+'\')">'+c.l+'</button>'; }).join('');
}
window.snxPulseFilter=function(id){
  var p=_pulseCatPrefs(); p[id]=!_pulseCatEnabled(id);
  try{localStorage.setItem('snxPulseCats',JSON.stringify(p));}catch(_){}
  var fr=_el('pulseFilters'); if(fr) fr.innerHTML=_renderPulseFilters(p);
  _loadPulseItems(_el('pulseList')||_el('nhPulse'),25);
};
function _loadPulseItems(cont,lim){
  if(!cont) return;
  var cu=_cu(),db=_db(),fs=_fs(),ud=_ud();
  if(!cu||!db){ cont.innerHTML=_emptyState('⚡','Sign in to see Pulse.',''); return; }
  var following=(ud.following||[]).slice(0,10);
  if(!following.length){ cont.innerHTML=_emptyState('⚡','No signals yet.','Follow creators to see their activity here.'); return; }
  var prefs=_pulseCatPrefs();
  var promises=[];
  if(prefs.post!==false||prefs.music!==false||prefs.video!==false){
    promises.push(fs.getDocs(fs.query(fs.collection(db,'posts'),fs.where('uid','in',following),fs.orderBy('ts','desc'),fs.limit(lim||20)))
    .then(function(s){ return (s.docs||[]).map(function(d){var p=d.data(),t=p.mediaType==='audio'?'music':p.mediaType==='video'?'video':'post';return{type:t,name:p.authorName||p.displayName||'Someone',text:p.text||'',ts:p.ts,icon:t==='music'?'🎵':t==='video'?'🎬':'✦'};}).filter(function(i){return prefs[i.type]!==false;}); })
    .catch(function(){return [];}));
  }
  if(prefs.live!==false){
    promises.push(fs.getDocs(fs.query(fs.collection(db,'liveRooms'),fs.where('isLive','==',true),fs.where('hostId','in',following),fs.limit(4)))
    .then(function(s){ return (s.docs||[]).map(function(d){var r=d.data();return{type:'live',name:r.hostName||'Creator',text:r.title||'',ts:r.startedAt||Date.now(),icon:'🔴'};})}).catch(function(){return [];}));
  }
  Promise.all(promises).then(function(res){
    var items=[].concat.apply([],res);
    items.sort(function(a,b){ var ta=a.ts&&a.ts.seconds?a.ts.seconds*1000:(a.ts||0),tb=b.ts&&b.ts.seconds?b.ts.seconds*1000:(b.ts||0); return tb-ta; });
    items=items.slice(0,lim||20);
    if(!items.length){ cont.innerHTML=_emptyState('⚡','No signals yet.','Follow creators to see their activity here.'); return; }
    var map={live:'went Live',music:'shared a track',post:'posted',story:'added a Story',video:'uploaded a video'};
    cont.innerHTML=items.map(function(i){
      var ms=i.ts&&i.ts.seconds?i.ts.seconds*1000:(i.ts||0);
      return '<div class="snx-pulse-item"><div class="snx-pulse-icon">'+_esc(i.icon)+'</div>'
        +'<div class="snx-pulse-body"><div class="snx-pulse-text"><strong>'+_esc(i.name)+'</strong> '+(map[i.type]||'was active')+(i.text?' — <em>'+_esc(i.text.slice(0,60))+'</em>':'')+'</div>'
        +'<div class="snx-pulse-time">'+_ts(ms)+'</div></div></div>';
    }).join('');
  });
}

/* ══════════════════════════════════════════════════════
   3. PRESENCE PROFILE HOOK
══════════════════════════════════════════════════════ */
function _enhanceProfile(){
  if(!window.SNXPresence) return;
  var cu=_cu(),ud=_ud();
  if(!cu) return;
  var activeUid=window.activeProfileUid;
  if(!activeUid||activeUid!==cu.uid) return;
  if(_el('snxPressureTrigger')) return;
  var infoBlock=document.querySelector('.profile-info-block');
  if(!infoBlock) return;
  var status=window.SNXPresence.getStatus();
  var el=document.createElement('div');
  el.id='snxPressureTrigger';
  el.style.cssText='margin-top:8px;';
  el.innerHTML='<button onclick="snxOpenPresencePicker()" style="display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;background:rgba(0,30,70,0.5);border:1px solid rgba(0,174,239,0.3);color:#6a9fc0;font-size:12px;cursor:pointer;">'
    +'<span id="snxPrStatusDot" style="width:8px;height:8px;border-radius:50%;background:'+_statusColor(status)+';flex-shrink:0;"></span>'
    +'<span id="snxPrStatusLabel">'+_esc(status.charAt(0).toUpperCase()+status.slice(1))+'</span></button>'
    +(ud.presenceCustom?'<span style="margin-left:8px;font-size:12px;color:#00ff88;">'+_esc(ud.presenceCustom)+'</span>':'');
  infoBlock.appendChild(el);
  _addCleanup('profile',function(){ var e=_el('snxPressureTrigger'); if(e) e.remove(); var pk=_el('snxPrPicker'); if(pk) pk.remove(); });
}
function _statusColor(s){ return{online:'#00ff88',away:'#ffbb44',busy:'#ff5566',invisible:'#4a6a8a',offline:'#334455'}[s]||'#334455'; }
window.snxOpenPresencePicker=function(){
  var ex=_el('snxPrPicker'); if(ex){ex.remove();return;}
  var trigger=_el('snxPressureTrigger'); if(!trigger) return;
  var pk=document.createElement('div'); pk.id='snxPrPicker';
  pk.style.cssText='position:absolute;z-index:5000;background:#060d1e;border:1px solid rgba(0,174,239,0.4);border-radius:12px;padding:6px;min-width:190px;box-shadow:0 8px 32px rgba(0,0,0,0.7);margin-top:4px;';
  var cur=window.SNXPresence.getStatus();
  var opts=[{id:'online',l:'🟢 Online',c:'#00ff88'},{id:'away',l:'🟡 Away',c:'#ffbb44'},{id:'busy',l:'🔴 Busy',c:'#ff5566'},{id:'invisible',l:'👻 Invisible',c:'#4a6a8a'}];
  pk.innerHTML=opts.map(function(o){return '<button onclick="snxSetPresence(\''+o.id+'\')" style="display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border-radius:8px;cursor:pointer;font-size:13px;color:#c8e0f0;border:none;background:'+(cur===o.id?'rgba(0,80,180,0.2)':'transparent')+';text-align:left;">'
    +'<span style="width:8px;height:8px;border-radius:50%;background:'+o.c+';flex-shrink:0;"></span><span>'+o.l+'</span></button>';}).join('')
    +'<div style="height:1px;background:rgba(0,174,239,0.1);margin:4px 0;"></div>'
    +'<div style="padding:4px 12px 8px;">'
    +'<input id="snxPrCustomIn" placeholder="Custom status…" value="'+_esc((window._snxUserData&&window._snxUserData.presenceCustom)||'')+'" style="font-size:12px;padding:6px 10px;width:100%;box-sizing:border-box;" maxlength="80">'
    +'<button onclick="snxSaveCustomStatus()" style="margin-top:6px;width:100%;font-size:12px;padding:5px;">Save Status</button></div>';
  trigger.style.position='relative'; trigger.appendChild(pk);
  setTimeout(function(){ document.addEventListener('click',function _cl(e){ if(!pk.contains(e.target)&&!trigger.contains(e.target)){pk.remove();document.removeEventListener('click',_cl);} }); },50);
};
window.snxSetPresence=function(s){
  if(!window.SNXPresence) return;
  window.SNXPresence.setStatus(s);
  var dot=_el('snxPrStatusDot'),lbl=_el('snxPrStatusLabel');
  if(dot) dot.style.background=_statusColor(s);
  if(lbl) lbl.textContent=s.charAt(0).toUpperCase()+s.slice(1);
  var pk=_el('snxPrPicker'); if(pk) pk.remove();
  _toast('Status set to '+s);
};
window.snxSaveCustomStatus=function(){
  var inp=_el('snxPrCustomIn'); if(!inp||!window.SNXPresence) return;
  window.SNXPresence.setCustom(inp.value);
  var pk=_el('snxPrPicker'); if(pk) pk.remove();
  _toast('Custom status saved!');
};

/* ══════════════════════════════════════════════════════
   4. CONNECTIONS PAGE
══════════════════════════════════════════════════════ */
function _initConnections(){
  var page=_el('connectionsPage');
  if(!page) return;
  var cu=_cu(),db=_db(),fs=_fs();
  if(!cu||!db) return;
  page.innerHTML='<div class="section-card"><h3 style="margin:0 0 14px;color:#00ccff;font-size:16px;">👥 Connections</h3>'
    +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px;">'
    +'<button class="snx-pulse-filter-btn active" id="cTabFollowers" onclick="snxConnTab(\'followers\')">Followers</button>'
    +'<button class="snx-pulse-filter-btn" id="cTabFollowing" onclick="snxConnTab(\'following\')">Following</button>'
    +'<button class="snx-pulse-filter-btn" id="cTabFriends" onclick="snxConnTab(\'friends\')">Friends</button>'
    +'<button class="snx-pulse-filter-btn" id="cTabMutual" onclick="snxConnTab(\'mutual\')">Mutual</button>'
    +'<button class="snx-pulse-filter-btn" id="cTabSuggested" onclick="snxConnTab(\'suggested\')">Suggested</button>'
    +'</div><div id="connCont"></div></div>';
  window.snxConnTab('followers');
}
window.snxConnTab=function(tab){
  ['Followers','Following','Friends','Mutual','Suggested'].forEach(function(t){
    var b=_el('cTab'+t); if(b) b.classList.remove('active');
  });
  var active=_el('cTab'+tab.charAt(0).toUpperCase()+tab.slice(1));
  if(active) active.classList.add('active');
  var cont=_el('connCont'); if(!cont) return;
  var cu=_cu(),ud=_ud(),db=_db(),fs=_fs();
  if(!cu||!db) return;
  var uids=[];
  if(tab==='followers') uids=ud.followers||[];
  if(tab==='following') uids=ud.following||[];
  if(tab==='friends')   uids=ud.friends||[];
  if(tab==='mutual'){var f=new Set(ud.followers||[]);uids=(ud.following||[]).filter(function(u){return f.has(u);});}
  if(tab==='suggested'){ _loadSuggested(cont); return; }
  if(!uids.length){ cont.innerHTML=_emptyState('👥','No connections here yet.','Start connecting with the Nexus community.'); return; }
  cont.innerHTML='<div style="color:#3a5a7a;font-size:12px;padding:8px;">Loading…</div>';
  var batch=uids.slice(0,10);
  fs.getDocs(fs.query(fs.collection(db,'users'),fs.where(fs.documentId(),'in',batch)))
  .then(function(s){
    var favs=new Set(ud.favoriteContacts||[]);
    var h='';
    s.docs.forEach(function(d){
      var u=d.data(),uid2=d.id,isFav=favs.has(uid2);
      h+='<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid rgba(0,50,100,0.15);">'
        +'<div style="width:44px;height:44px;border-radius:50%;background:rgba(0,40,100,0.6);'+(u.avatar?'background-image:url('+_esc(u.avatar)+');background-size:cover;':'')
        +'border:2px solid rgba(0,174,239,0.4);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#00AEEF;flex-shrink:0;cursor:pointer;" onclick="window.viewProfile&&window.viewProfile(\''+_esc(uid2)+'\')">'
        +(u.avatar?'':_esc((u.displayName||'?').charAt(0)))+'</div>'
        +'<div style="flex:1;min-width:0;cursor:pointer;" onclick="window.viewProfile&&window.viewProfile(\''+_esc(uid2)+'\')">'
        +'<div style="font-size:14px;font-weight:600;color:#e0f0ff;">'+_esc(u.displayName||'User')+'</div>'
        +'<div style="font-size:12px;color:#3a6a9a;">@'+_esc(u.username||u.displayName||'')+'</div>'
        +'</div>'
        +'<button onclick="snxToggleFav(\''+_esc(uid2)+'\')" style="background:none;border:none;font-size:18px;cursor:pointer;color:'+(isFav?'#ffcc44':'#334455')+';" title="'+(isFav?'Remove favorite':'Favorite')+'">★</button>'
        +'</div>';
    });
    if(uids.length>10) h+='<div style="text-align:center;padding:10px;"><button style="font-size:12px;">Load more ('+(uids.length-10)+')</button></div>';
    cont.innerHTML=h||_emptyState('👥','No users found.','');
  }).catch(function(){cont.innerHTML=_emptyState('👥','Could not load.','');});
};
window.snxToggleFav=function(uid2){
  var fs2=_fs(),cu=_cu(),ud=_ud(),db=_db();
  if(!fs2.updateDoc||!cu||!db) return;
  var favs=new Set(ud.favoriteContacts||[]);
  var was=favs.has(uid2);
  if(was) favs.delete(uid2); else favs.add(uid2);
  var newFavs=Array.from(favs);
  if(ud) ud.favoriteContacts=newFavs;
  fs2.updateDoc(fs2.doc(db,'users',cu.uid),{favoriteContacts:newFavs}).catch(function(){});
  _toast(was?'Removed from favorites':'★ Added to favorites');
};
function _loadSuggested(cont){
  cont.innerHTML='<div style="color:#3a5a7a;font-size:12px;padding:8px;">Finding people…</div>';
  var db=_db(),fs=_fs(),ud=_ud(),cu=_cu();
  if(!db) return;
  var following=new Set(ud.following||[]);
  fs.getDocs(fs.query(fs.collection(db,'users'),fs.limit(15))).then(function(s){
    var h='',cnt=0;
    s.docs.forEach(function(d){
      if(d.id===(cu&&cu.uid)||following.has(d.id)||cnt>=8) return;
      cnt++;
      var u=d.data();
      h+='<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(0,50,100,0.15);">'
        +'<div style="width:40px;height:40px;border-radius:50%;background:rgba(0,40,100,0.6);'+(u.avatar?'background-image:url('+_esc(u.avatar)+');background-size:cover;':'')
        +'border:2px solid rgba(0,174,239,0.35);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#00AEEF;flex-shrink:0;cursor:pointer;" onclick="window.viewProfile&&window.viewProfile(\''+_esc(d.id)+'\')">'
        +(u.avatar?'':_esc((u.displayName||'?').charAt(0)))+'</div>'
        +'<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:#e0f0ff;">'+_esc(u.displayName||'User')+'</div></div>'
        +'<button onclick="window.viewProfile&&window.viewProfile(\''+_esc(d.id)+'\')" style="font-size:12px;padding:5px 12px;border-radius:12px;">View</button>'
        +'</div>';
    });
    cont.innerHTML=cnt?h:_emptyState('👥','No suggestions.','');
  }).catch(function(){cont.innerHTML=_emptyState('👥','Could not load.','');});
}

/* ══════════════════════════════════════════════════════
   5. MESSAGES 2.0 — Voice + Reactions
══════════════════════════════════════════════════════ */
function _enhanceMessages(){
  var footer=_el('inboxChatFooter');
  if(!footer||_el('snxVoiceBtn')) return;
  var vBtn=document.createElement('button');
  vBtn.id='snxVoiceBtn'; vBtn.className='inbox-record-btn';
  vBtn.title='Record voice message'; vBtn.innerHTML='🎙';
  vBtn.setAttribute('aria-label','Record voice message');
  vBtn.addEventListener('click',_toggleVoiceRecord);
  var sendBtn=_el('inboxChatSendBtn');
  if(sendBtn) footer.insertBefore(vBtn,sendBtn); else footer.appendChild(vBtn);
  _addCleanup('inboxPage',function(){ var b=_el('snxVoiceBtn'); if(b) b.remove(); _stopVoiceRecord(); });
}
var _vmRec=null,_vmChunks=[],_vmRecording=false,_vmBlob=null,_vmDur=0,_vmTimer=null;
function _toggleVoiceRecord(){ if(_vmRecording) _stopVoiceRecord(); else _startVoiceRecord(); }
function _startVoiceRecord(){
  navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
    if(window.SNXAudioCoordinator) window.SNXAudioCoordinator.request('voiceMessage');
    _vmChunks=[]; _vmRecording=true; _vmDur=0;
    var opts=MediaRecorder.isTypeSupported('audio/webm;codecs=opus')?{mimeType:'audio/webm;codecs=opus'}:{};
    _vmRec=new MediaRecorder(stream,opts);
    _vmRec.ondataavailable=function(e){ if(e.data.size>0) _vmChunks.push(e.data); };
    _vmRec.onstop=function(){
      stream.getTracks().forEach(function(t){t.stop();});
      _vmBlob=new Blob(_vmChunks,{type:_vmRec.mimeType||'audio/webm'});
      _showVoicePreview();
      if(window.SNXAudioCoordinator) window.SNXAudioCoordinator.release('voiceMessage');
    };
    _vmRec.start(200);
    var b=_el('snxVoiceBtn'); if(b) b.classList.add('recording');
    _vmTimer=setInterval(function(){ _vmDur++; var b2=_el('snxVoiceBtn'); if(b2) b2.title='Recording '+_vmDur+'s — tap to stop'; },1000);
    setTimeout(function(){ if(_vmRecording) _stopVoiceRecord(); },120000);
  }).catch(function(e){ _toast('🎙 Microphone access denied.'); console.warn('[SNX Voice]',e); });
}
function _stopVoiceRecord(){
  if(!_vmRec||!_vmRecording) return;
  _vmRecording=false; clearInterval(_vmTimer);
  try{ _vmRec.stop(); }catch(_){}
  var b=_el('snxVoiceBtn'); if(b){ b.classList.remove('recording'); b.title='Record voice message'; }
}
function _showVoicePreview(){
  if(!_vmBlob) return;
  var strip=_el('inboxUploadStrip'); if(!strip) return;
  strip.style.display='flex';
  var ic=_el('inboxUploadIcon'),nm=_el('inboxUploadFilename');
  if(ic) ic.textContent='🎙';
  if(nm) nm.textContent='Voice message ('+_vmDur+'s) — press Send or × to cancel';
  window._snxVoiceBlob=_vmBlob;
  window._snxVoiceDuration=_vmDur;
  _toast('🎙 Voice message ready — press Send');
}
/* Reaction bar — long press / right click */
document.addEventListener('contextmenu',function(e){
  var bub=e.target.closest('.ipc-modal-bubble,.inbox-chat-bubble');
  if(!bub) return; e.preventDefault(); _showReactionBar(e.clientX,e.clientY,bub);
});
var _lpTimer=null;
document.addEventListener('touchstart',function(e){
  var bub=e.target.closest('.ipc-modal-bubble,.inbox-chat-bubble'); if(!bub) return;
  var t=e.touches[0];
  _lpTimer=setTimeout(function(){ _showReactionBar(t.clientX,t.clientY,bub); },500);
},{passive:true});
document.addEventListener('touchend',function(){clearTimeout(_lpTimer);},{passive:true});
document.addEventListener('touchmove',function(){clearTimeout(_lpTimer);},{passive:true});
function _showReactionBar(x,y,bubble){
  var old=_el('snxRxBar'); if(old) old.remove();
  var bar=document.createElement('div'); bar.id='snxRxBar'; bar.className='inbox-reaction-bar';
  bar.style.left=Math.min(x,window.innerWidth-220)+'px';
  bar.style.top=(y-52)+'px';
  ['❤️','😂','😮','😢','🔥','👍'].forEach(function(em){
    var s=document.createElement('span'); s.className='inbox-reaction-opt'; s.textContent=em;
    s.onclick=function(){ _addReaction(bubble,em); bar.remove(); };
    bar.appendChild(s);
  });
  document.body.appendChild(bar);
  setTimeout(function(){ document.addEventListener('click',function _cl(e){ if(!bar.contains(e.target)){bar.remove();document.removeEventListener('click',_cl);} }); },50);
}
function _addReaction(bubble,emoji){
  var strip=bubble.nextElementSibling;
  if(!strip||!strip.classList.contains('snx-reactions')){
    strip=document.createElement('div'); strip.className='snx-reactions';
    strip.style.cssText='display:flex;gap:4px;flex-wrap:wrap;margin-top:3px;';
    if(bubble.parentNode) bubble.parentNode.insertBefore(strip,bubble.nextSibling);
  }
  var ex=strip.querySelector('[data-emoji="'+emoji+'"]');
  if(ex){ var cnt=parseInt(ex.dataset.count||'1')-1; if(cnt<=0) ex.remove(); else{ex.dataset.count=cnt;ex.textContent=emoji+' '+cnt;} }
  else{ var sp=document.createElement('span'); sp.dataset.emoji=emoji; sp.dataset.count='1'; sp.textContent=emoji+' 1';
    sp.style.cssText='font-size:13px;padding:2px 6px;border-radius:10px;background:rgba(0,30,70,0.5);border:1px solid rgba(0,174,239,0.2);cursor:pointer;';
    sp.onclick=function(){_addReaction(bubble,emoji);}; strip.appendChild(sp); }
}

/* ══════════════════════════════════════════════════════
   6. SOCIAL MUSIC IDENTITY
══════════════════════════════════════════════════════ */
window.snxRenderProfileSoundtrack=function(song){
  var cont=_el('snxProfileSoundtrack'); if(!cont) return;
  if(!song){ cont.style.display='none'; return; }
  cont.style.display='';
  window._snxCurrentProfileSoundtrack=song;
  cont.innerHTML='<div class="snx-profile-soundtrack">'
    +'<div class="snx-music-card-art" style="'+(song.artUrl||song.coverImage?'background-image:url('+_esc(song.artUrl||song.coverImage)+');background-size:cover;':'')+'width:52px;height:52px;border-radius:8px;">'+(song.artUrl||song.coverImage?'':'🎵')+'</div>'
    +'<div style="flex:1;min-width:0;">'
    +'<div class="snx-pst-label">🎵 Profile Soundtrack</div>'
    +'<div class="snx-pst-title">'+_esc(song.title||'Track')+'</div>'
    +'<div class="snx-pst-artist">'+_esc(song.artist||'')+'</div>'
    +'</div>'
    +'<button class="snx-music-play-btn" id="snxPstBtn" onclick="snxPlayProfileSoundtrack()">▶</button>'
    +'</div>';
};
window.snxPlayProfileSoundtrack=function(){
  var song=window._snxCurrentProfileSoundtrack;
  if(!song) return;
  var url=song.downloadURL||song.musicUrl||song.url;
  if(!url){ _toast('No playable audio for this track.'); return; }
  if(window.SNXPlayer){
    if(window.SNXAudioCoordinator) window.SNXAudioCoordinator.request('profileSound');
    window.SNXPlayer.play({url:url,title:song.title||'Soundtrack',artist:song.artist||'',artUrl:song.artUrl||song.coverImage||'',id:song.id||'pst'});
  }
};
window.snxShareMusicToFeed=function(songId){
  var db=_db(),fs=_fs(),cu=_cu();
  if(!db||!cu) return;
  fs.getDoc(fs.doc(db,'profileMusic',songId)).then(function(sn){
    if(!sn.exists()){_toast('Track not found.');return;}
    var s=sn.data();
    var post={uid:cu.uid,authorName:_ud().displayName||'',authorHandle:_ud().username||'',avatar:_ud().avatar||'',
      type:'music',musicRefId:songId,musicTitle:s.title||'Track',musicArtist:s.artist||'',
      musicUrl:s.downloadURL||s.musicUrl||s.url||'',musicArtUrl:s.artUrl||s.coverImage||'',
      text:'🎵 '+_esc(s.title||'Check out this track'),ts:fs.serverTimestamp?fs.serverTimestamp():Date.now(),
      likes:0,likedBy:[],comments:[]};
    fs.addDoc(fs.collection(db,'posts'),post).then(function(){_toast('🎵 Track shared to feed!');}).catch(function(e){_toast('Error: '+e.message);});
  }).catch(function(){_toast('Could not load track.');});
};
window.snxSaveMusicToVault=function(songId,title,artUrl,col){
  if(!window.SNXVault){_toast('Vault unavailable.');return;}
  window.SNXVault.save({type:'music',refId:songId,title:title||'Music',artUrl:artUrl||'',collection:col||'listenLater'})
  .then(function(){_toast('🔖 Saved to Vault!');}).catch(function(e){_toast('Could not save: '+(e.message||e));});
};
/* ══════════════════════════════════════════════════════
   8. NEXUS WATCH
══════════════════════════════════════════════════════ */
function _initNexusWatch(){
  var page=_el('nexusWatchPage');
  if(!page) return;
  var cu=_cu(),db=_db(),fs=_fs();
  if(!cu||!db) return;
  page.innerHTML='<div class="section-card">'
    +'<h3 style="margin:0 0 14px;color:#00ccff;font-size:16px;">🎬 Nexus Watch</h3>'
    +'<div style="display:flex;gap:6px;margin-bottom:14px;overflow-x:auto;scrollbar-width:none;">'
    +'<button class="snx-pulse-filter-btn active" id="wTabAll"       onclick="snxWatchTab(\'all\')">All</button>'
    +'<button class="snx-pulse-filter-btn"        id="wTabFollowing" onclick="snxWatchTab(\'following\')">Following</button>'
    +'<button class="snx-pulse-filter-btn"        id="wTabRecent"    onclick="snxWatchTab(\'recent\')">Recent</button>'
    +'</div><div id="watchGrid" class="snx-watch-grid"></div></div>';
  window.snxWatchTab('all');
  _addCleanup('nexusWatchPage',function(){});
}
window.snxWatchTab=function(tab){
  ['All','Following','Recent'].forEach(function(t){ var b=_el('wTab'+t); if(b) b.classList.remove('active'); });
  var ab=_el('wTab'+tab.charAt(0).toUpperCase()+tab.slice(1)); if(ab) ab.classList.add('active');
  var cont=_el('watchGrid'); if(!cont) return;
  var cu=_cu(),db=_db(),fs=_fs(),ud=_ud();
  if(!cu||!db){cont.innerHTML=_emptyState('🎬','The Vault of Videos','Sign in to watch videos.');return;}
  cont.innerHTML='<div style="color:#3a5a7a;font-size:12px;padding:12px;">Loading videos…</div>';
  var q;
  try{
    if(tab==='following'){
      var fol=(ud.following||[]).slice(0,10);
      if(!fol.length){cont.innerHTML=_emptyState('🎬','No videos from following.','Follow creators to see their videos here.');return;}
      q=fs.query(fs.collection(db,'videos'),fs.where('creatorId','in',fol),fs.where('status','==','published'),fs.orderBy('createdAt','desc'),fs.limit(16));
    } else if(tab==='recent'){
      q=fs.query(fs.collection(db,'videos'),fs.where('status','==','published'),fs.where('visibility','==','public'),fs.orderBy('createdAt','desc'),fs.limit(20));
    } else {
      q=fs.query(fs.collection(db,'videos'),fs.where('status','==','published'),fs.where('visibility','==','public'),fs.orderBy('createdAt','desc'),fs.limit(20));
    }
    fs.getDocs(q).then(function(s){
      if(!s||s.empty){cont.innerHTML=_emptyState('🎬','No videos yet.','Be the first to upload!');return;}
      cont.innerHTML=s.docs.map(function(d){
        var v=d.data(),vid=d.id;
        var dur=v.duration?_fmtDur(v.duration):'';
        return '<div class="snx-watch-card" onclick="snxOpenVideo(\''+_esc(vid)+'\')">'
          +'<div class="snx-watch-thumb" style="'+(v.thumbnailUrl?'background-image:url('+_esc(v.thumbnailUrl)+');background-size:cover;':'')+'font-size:32px;">'
          +(v.thumbnailUrl?'':'🎬')+(dur?'<div class="snx-watch-duration">'+_esc(dur)+'</div>':'')+'</div>'
          +'<div class="snx-watch-body"><div class="snx-watch-title">'+_esc(v.title||'Untitled')+'</div>'
          +'<div class="snx-watch-meta">'+_esc(v.creatorName||'Creator')+(v.views?' · '+v.views+' views':'')+'</div></div></div>';
      }).join('');
    }).catch(function(){cont.innerHTML=_emptyState('🎬','Could not load videos.','');});
  }catch(e){cont.innerHTML=_emptyState('🎬','Error loading videos.','');}
};
function _fmtDur(s){ var m=Math.floor(s/60),ss=Math.floor(s%60); return m+':'+(ss<10?'0':'')+ss; }
window.snxOpenVideo=function(videoId){
  var db=_db(),fs=_fs();
  if(!db) return;
  fs.getDoc(fs.doc(db,'videos',videoId)).then(function(sn){
    if(!sn.exists()){ _toast('Video not found.'); return; }
    var v=sn.data();
    if(!v.videoUrl&&!v.r2Url){ _toast('Video URL unavailable.'); return; }
    // Update view count
    fs.updateDoc(fs.doc(db,'videos',videoId),{views:fs.increment?fs.increment(1):(v.views||0)+1}).catch(function(){});
    // Open in fullscreen viewer
    var viewer=_el('snxMediaViewer');
    if(viewer){
      var vid=viewer.querySelector('video')||document.createElement('video');
      vid.src=v.videoUrl||v.r2Url;
      vid.controls=true; vid.style.cssText='max-width:96vw;max-height:85vh;border-radius:8px;';
      if(!viewer.contains(vid)){
        var old=viewer.querySelector('video');
        if(old) old.remove();
        viewer.insertBefore(vid,viewer.firstChild);
      }
      viewer.classList.add('open');
      vid.play().catch(function(){});
      if(window.SNXAudioCoordinator) window.SNXAudioCoordinator.request('videoPlayer');
    }
  }).catch(function(e){ _toast('Could not load video.'); console.warn('[SNX Watch]',e); });
};

/* ══════════════════════════════════════════════════════
   9. LIVE DISCOVERY
══════════════════════════════════════════════════════ */
function _initLiveDiscover(){
  var page=_el('liveDiscoverPage');
  if(!page) return;
  var cu=_cu(),db=_db(),fs=_fs(),ud=_ud();
  if(!cu||!db) return;
  page.innerHTML='<div class="section-card">'
    +'<h3 style="margin:0 0 6px;color:#ff3344;font-size:16px;">🔴 Live Now</h3>'
    +'<p style="font-size:12px;color:#3a6a9a;margin:0 0 14px;">Creators currently live in the Nexus.</p>'
    +'<div id="liveDiscGrid" class="snx-live-discover-grid"></div>'
  +'</div>';
  var cont=_el('liveDiscGrid');
  fs.getDocs(fs.query(fs.collection(db,'liveRooms'),fs.where('isLive','==',true),fs.orderBy('viewers','desc'),fs.limit(20)))
  .then(function(s){
    if(!s||s.empty){ cont.innerHTML=_emptyState('📡','The Nexus is quiet right now.','No one is live at the moment.'); return; }
    var following=new Set(ud.following||[]);
    var friends=new Set(ud.friends||[]);
    // Sort: friends > following > everyone
    var docs=s.docs.slice().sort(function(a,b){
      var ra=a.data(),rb=b.data();
      var pa=friends.has(ra.hostId)?3:following.has(ra.hostId)?2:1;
      var pb=friends.has(rb.hostId)?3:following.has(rb.hostId)?2:1;
      return pb-pa;
    });
    cont.innerHTML=docs.map(function(d){
      var r=d.data(),rid=d.id;
      var label=friends.has(r.hostId)?'👥 Friend':following.has(r.hostId)?'★ Following':'';
      return '<div class="snx-live-disc-card" onclick="snxJoinLive(\''+_esc(rid)+'\',\''+_esc(r.hostId)+'\')">'
        +'<div class="snx-live-disc-thumb">'+(r.thumbUrl?'<img src="'+_esc(r.thumbUrl)+'" style="width:100%;height:100%;object-fit:cover;" loading="lazy">':'<span style="font-size:28px;">'+_esc((r.hostName||'?').charAt(0))+'</span>')
        +'<div class="snx-live-disc-pill">LIVE</div>'+(r.viewers?'<div class="snx-live-disc-viewers">👁 '+_esc(String(r.viewers))+'</div>':'')+'</div>'
        +'<div class="snx-live-disc-body">'
          +'<div class="snx-live-disc-name">'+_esc(r.hostName||'Creator')+(label?' <span style="font-size:10px;color:#5a90b8;">'+label+'</span>':'')+'</div>'
          +'<div class="snx-live-disc-title">'+_esc((r.title||'').slice(0,40))+'</div>'
        +'</div></div>';
    }).join('');
  }).catch(function(){ if(cont) cont.innerHTML=_emptyState('📡','Could not load live rooms.',''); });
  _addCleanup('liveDiscoverPage',function(){});
}
window.snxJoinLive=function(roomId,hostId){
  // Pause mini player
  if(window.SNXPlayer&&window.SNXPlayer.isPlaying()&&window.SNXAudioCoordinator)
    window.SNXAudioCoordinator.request('liveStream');
  // Navigate to live page
  if(typeof window.goLiveOrWatch==='function'){
    window._liveWatchHostId=hostId;
    window.goLiveOrWatch(hostId);
  } else {
    window.open('live.html?host='+encodeURIComponent(hostId),'_blank');
  }
};

/* ══════════════════════════════════════════════════════
   10. SEARCH ENHANCEMENTS
══════════════════════════════════════════════════════ */
(function _enhanceSearchPage(){
  var _searchDebounce=null,_searchCat='all',_searchAbort=false;
  window.snxSearchEnhanced=function(q,cat){
    _searchCat=cat||'all';
    clearTimeout(_searchDebounce);
    _searchDebounce=setTimeout(function(){ _runSearch(q,_searchCat); },300);
  };
  window.snxSetSearchCat=function(cat){
    _searchCat=cat;
    document.querySelectorAll('.snx-search-cat-btn').forEach(function(b){b.classList.remove('active');});
    var ab=document.querySelector('.snx-search-cat-btn[data-cat="'+cat+'"]');
    if(ab) ab.classList.add('active');
    var inp=_el('searchInput'); if(inp&&inp.value.trim()) _runSearch(inp.value.trim(),cat);
  };
  function _runSearch(q,cat){
    if(!q||q.length<2) return;
    _searchAbort=true;
    setTimeout(function(){ _searchAbort=false; _doSearch(q,cat); },10);
  }
  function _doSearch(q,cat){
    var db=_db(),fs=_fs(),cu=_cu();
    if(!db||!cu) return;
    var resCont=_el('searchResults')||_el('snxSearchResultsCont');
    if(!resCont) return;
    resCont.style.display='';
    resCont.innerHTML='<div style="color:#3a5a7a;font-size:12px;padding:12px;">Searching…</div>';
    var ql=q.toLowerCase();
    var promises=[];
    if(cat==='all'||cat==='people'){
      promises.push(fs.getDocs(fs.query(fs.collection(db,'users'),fs.where('username_lower','>=',ql),fs.where('username_lower','<=',ql+'\uf8ff'),fs.limit(8)))
      .then(function(s){ return {type:'people',docs:s.docs||[]}; }).catch(function(){return {type:'people',docs:[]};}));
    }
    if(cat==='all'||cat==='music'){
      promises.push(fs.getDocs(fs.query(fs.collection(db,'profileMusic'),fs.where('title_lower','>=',ql),fs.where('title_lower','<=',ql+'\uf8ff'),fs.limit(6)))
      .then(function(s){ return {type:'music',docs:s.docs||[]}; }).catch(function(){return {type:'music',docs:[]};}));
    }
    if(cat==='all'||cat==='videos'){
      promises.push(fs.getDocs(fs.query(fs.collection(db,'videos'),fs.where('status','==','published'),fs.limit(6)))
      .then(function(s){ return {type:'videos',docs:s.docs.filter(function(d){var t=(d.data().title||'').toLowerCase();return t.includes(ql);})}; })
      .catch(function(){return {type:'videos',docs:[]};}));
    }
    if(cat==='all'||cat==='posts'){
      promises.push(fs.getDocs(fs.query(fs.collection(db,'posts'),fs.orderBy('ts','desc'),fs.limit(20)))
      .then(function(s){ return {type:'posts',docs:s.docs.filter(function(d){var p=d.data();return (p.text||'').toLowerCase().includes(ql);})}; })
      .catch(function(){return {type:'posts',docs:[]};}));
    }
    Promise.all(promises).then(function(res){
      if(_searchAbort) return;
      var html='';
      res.forEach(function(r){
        if(!r.docs.length) return;
        html+='<div class="snx-section-label" style="margin-top:14px;">'+(r.type==='people'?'👤 People':r.type==='music'?'🎵 Music':r.type==='videos'?'🎬 Videos':'✦ Posts')+'</div>';
        r.docs.forEach(function(d){
          var data=d.data(),id=d.id;
          if(r.type==='people'){
            html+='<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid rgba(0,50,100,0.12);cursor:pointer;" onclick="window.viewProfile&&window.viewProfile(\''+_esc(id)+'\')">'
              +'<div style="width:38px;height:38px;border-radius:50%;background:rgba(0,40,100,0.6);'+(data.avatar?'background-image:url('+_esc(data.avatar)+');background-size:cover;':'')
              +'border:1.5px solid rgba(0,174,239,0.35);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#00AEEF;flex-shrink:0;">'
              +(data.avatar?'':_esc((data.displayName||'?').charAt(0)))+'</div>'
              +'<div><div style="font-size:13px;font-weight:600;color:#e0f0ff;">'+_esc(data.displayName||'User')+'</div>'
              +'<div style="font-size:11px;color:#3a6a9a;">@'+_esc(data.username||'')+'</div></div></div>';
          } else if(r.type==='music'){
            html+='<div class="snx-music-post-card" onclick="SNXPlayer&&SNXPlayer.play({url:\''+_esc(data.downloadURL||data.musicUrl||data.url||'')+'\',title:\''+_esc(data.title||'Track')+'\',artist:\''+_esc(data.artist||'')+'\',artUrl:\''+_esc(data.artUrl||data.coverImage||'')+'\',id:\''+_esc(id)+'\'})">'
              +'<div class="snx-music-card-art" style="'+(data.artUrl||data.coverImage?'background-image:url('+_esc(data.artUrl||data.coverImage)+');background-size:cover;':'')+'">'+((data.artUrl||data.coverImage)?'':'🎵')+'</div>'
              +'<div class="snx-music-card-info"><div class="snx-music-card-title">'+_esc(data.title||'Track')+'</div><div class="snx-music-card-artist">'+_esc(data.artist||'')+'</div></div>'
              +'<button class="snx-music-play-btn">▶</button></div>';
          } else if(r.type==='videos'){
            html+='<div class="snx-watch-card" style="display:flex;gap:10px;padding:8px 0;border-radius:0;border:none;border-bottom:1px solid rgba(0,50,100,0.12);" onclick="snxOpenVideo(\''+_esc(id)+'\')">'
              +'<div class="snx-watch-thumb" style="width:80px;height:52px;border-radius:6px;flex-shrink:0;'+(data.thumbnailUrl?'background-image:url('+_esc(data.thumbnailUrl)+');background-size:cover;':'')+'font-size:20px;">'+(data.thumbnailUrl?'':'🎬')+'</div>'
              +'<div class="snx-watch-body"><div class="snx-watch-title" style="-webkit-line-clamp:1;">'+_esc(data.title||'Video')+'</div><div class="snx-watch-meta">'+_esc(data.creatorName||'Creator')+'</div></div></div>';
          } else if(r.type==='posts'){
            html+='<div style="padding:8px 0;border-bottom:1px solid rgba(0,50,100,0.12);">'
              +'<div style="font-size:12px;color:#5a90b8;margin-bottom:2px;">'+_esc(data.authorName||'User')+'</div>'
              +'<div style="font-size:13px;color:#c8e0f0;">'+_esc((data.text||'').slice(0,120))+'</div></div>';
          }
        });
      });
      resCont.innerHTML=html||'<div style="color:#3a5a7a;font-size:13px;padding:12px;">No results found for <strong>'+_esc(q)+'</strong></div>';
    }).catch(function(){ resCont.innerHTML='<div style="color:#3a5a7a;font-size:12px;padding:12px;">Search error.</div>'; });
  }
})();

/* ══════════════════════════════════════════════════════
   11. THE VAULT UI
══════════════════════════════════════════════════════ */
function _initVault(){
  var page=_el('vaultPage');
  if(!page) return;
  if(!window.SNXVault){page.innerHTML=_emptyState('🔖','Vault loading…','');return;}
  var cols=window.SNXVault.getCollections();
  page.innerHTML='<div class="section-card">'
    +'<h3 style="margin:0 0 6px;color:#00ccff;font-size:16px;">🔖 The Vault</h3>'
    +'<p style="font-size:12px;color:#3a6a9a;margin:0 0 14px;">Your private saved content. Only you can see this.</p>'
    +'<div class="vault-tabs" id="vaultTabRow">'+cols.map(function(c,i){
      var labels={favorites:'★ Favorites',watchLater:'👁 Watch Later',listenLater:'🎵 Listen Later'};
      return '<button class="vault-tab-btn'+(i===0?' active':'')+'" data-col="'+_esc(c)+'" onclick="snxVaultTab(\''+_esc(c)+'\')">'+_esc(labels[c]||c)+'</button>';
    }).join('')
    +'<button class="vault-tab-btn" onclick="snxNewVaultCollection()" title="New collection">＋</button>'
    +'</div>'
    +'<div id="vaultItemsCont" class="vault-item-grid"></div>'
  +'</div>';
  window.snxVaultTab(cols[0]||'favorites');
  _addCleanup('vaultPage',function(){});
}
window.snxVaultTab=function(col){
  document.querySelectorAll('.vault-tab-btn').forEach(function(b){b.classList.remove('active');});
  var ab=document.querySelector('.vault-tab-btn[data-col="'+col+'"]'); if(ab) ab.classList.add('active');
  var cont=_el('vaultItemsCont'); if(!cont) return;
  cont.innerHTML='<div style="color:#3a5a7a;font-size:12px;padding:12px;">Loading…</div>';
  if(!window.SNXVault){cont.innerHTML=_emptyState('🔖','Vault unavailable.','');return;}
  window.SNXVault.loadItems(col,40).then(function(items){
    if(!items.length){
      var emptyMap={favorites:'Your Favorites are empty. Save posts, music, and videos here.',
        watchLater:'Your Watch Later list is empty.',listenLater:'Your Listen Later list is empty.'};
      cont.innerHTML=_emptyState('🔖','Your Vault is waiting.',emptyMap[col]||'Nothing saved here yet.');return;
    }
    cont.innerHTML=items.map(function(item){
      var icon=item.type==='music'?'🎵':item.type==='video'?'🎬':item.type==='playlist'?'🎶':'📄';
      return '<div class="vault-item-card" onclick="snxOpenVaultItem(\''+_esc(item.type)+'\',\''+_esc(item.refId)+'\')">'
        +'<div class="vault-item-thumb" style="'+(item.artUrl?'background-image:url('+_esc(item.artUrl)+');background-size:cover;':'')+'font-size:28px;">'+icon+'</div>'
        +'<div class="vault-item-body">'
          +'<div class="vault-item-title">'+_esc(item.title||'Item')+'</div>'
          +'<div class="vault-item-type">'+_esc(item.type)+'</div>'
        +'</div></div>';
    }).join('');
  }).catch(function(){cont.innerHTML=_emptyState('🔖','Could not load Vault.','');});
};
window.snxNewVaultCollection=function(){
  var name=window.prompt('Collection name:','');
  if(!name||!window.SNXVault) return;
  window.SNXVault.createCollection(name).then(function(){
    _toast('Collection "'+name+'" created!');
    _initVault(); // re-render
  }).catch(function(e){_toast('Error: '+(e.message||e));});
};
window.snxOpenVaultItem=function(type,refId){
  if(type==='music') _openVaultMusic(refId);
  else if(type==='video') window.snxOpenVideo&&window.snxOpenVideo(refId);
  else if(type==='post')  _openVaultPost(refId);
};
function _openVaultMusic(id){
  var db=_db(),fs=_fs(); if(!db) return;
  fs.getDoc(fs.doc(db,'profileMusic',id)).then(function(sn){
    if(!sn.exists()){ _toast('Track no longer available.'); return; }
    var s=sn.data(); var url=s.downloadURL||s.musicUrl||s.url;
    if(!url){ _toast('No audio available.'); return; }
    if(window.SNXPlayer) window.SNXPlayer.play({url:url,title:s.title||'Track',artist:s.artist||'',artUrl:s.artUrl||s.coverImage||'',id:id});
  }).catch(function(){_toast('Could not load track.');});
}
function _openVaultPost(id){
  if(typeof window.realmNavTo==='function') window.realmNavTo('feed');
  _toast('Post opened in Feed.');
}

/* ══════════════════════════════════════════════════════
   12. PROFILE THEMES PRESETS
══════════════════════════════════════════════════════ */
window.snxApplyThemePreset=function(presetId){
  var presets={
    nexusBlue: { colorBg:'#0B1F3A',colorCard:'#0d2444',colorAccent:'#00AEEF',colorText:'#ffffff',colorBorder:'#1a3a5c' },
    eclipse:   { colorBg:'#0a0a0f',colorCard:'#12121f',colorAccent:'#9b59b6',colorText:'#e0e0e0',colorBorder:'#2a1a3c' },
    midnightStorm:{ colorBg:'#05071a',colorCard:'#0a0d30',colorAccent:'#3b4fd8',colorText:'#cdd0ff',colorBorder:'#1a1f5c' },
    neonShadow:{ colorBg:'#020b14',colorCard:'#051a28',colorAccent:'#00ffcc',colorText:'#ccffee',colorBorder:'#003328' },
    void:      { colorBg:'#050505',colorCard:'#0f0f0f',colorAccent:'#cc00ff',colorText:'#e0e0e0',colorBorder:'#220033' }
  };
  var preset=presets[presetId]; if(!preset){_toast('Preset not found.');return;}
  // Apply via CSS variables on profileCustomStyle element
  var styleEl=document.getElementById('profileCustomStyle');
  if(styleEl){
    styleEl.textContent=':root.snx-profile-active{--bg-main:'+preset.colorBg+';--bg-card:'+preset.colorCard+';--neon-blue:'+preset.colorAccent+';--text-primary:'+preset.colorText+';--border-color:'+preset.colorBorder+';}';
    document.documentElement.classList.add('snx-profile-active');
  }
  _toast('Theme applied: '+presetId);
  // Persist to Firestore
  var fs=_fs(),cu=_cu(),db=_db();
  if(fs.updateDoc&&cu&&db){
    fs.updateDoc(fs.doc(db,'users',cu.uid),{activeThemePreset:presetId}).catch(function(){});
  }
};

/* ══════════════════════════════════════════════════════
   13. PROFILE MILESTONES
══════════════════════════════════════════════════════ */
var MILESTONES=[
  {id:'founding_member',icon:'🌑',name:'Founding Member',desc:'Joined Shadow Nexus Social early.'},
  {id:'first_post',icon:'✦',name:'First Post',desc:'Created your first post.'},
  {id:'first_live',icon:'🔴',name:'First Live',desc:'Went live for the first time.'},
  {id:'music_creator',icon:'🎵',name:'Music Creator',desc:'Uploaded music to the Nexus.'},
  {id:'video_creator',icon:'🎬',name:'Video Creator',desc:'Uploaded a video.'},
  {id:'posts_100',icon:'📚',name:'100 Posts',desc:'Reached 100 posts.'},
  {id:'anniversary',icon:'🎂',name:'Community Anniversary',desc:'One year in the Nexus.'},
  {id:'profile_complete',icon:'🌟',name:'Complete Profile',desc:'Filled in all profile fields.'}
];
function _initMilestones(){
  var page=_el('milestonesPage');
  if(!page) return;
  var ud=_ud();
  var earned=new Set(ud.milestones||[]);
  page.innerHTML='<div class="section-card">'
    +'<h3 style="margin:0 0 6px;color:#00ccff;font-size:16px;">🏅 Profile Milestones</h3>'
    +'<p style="font-size:12px;color:#3a6a9a;margin:0 0 16px;">Non-monetary achievements earned through activity.</p>'
    +'<div class="snx-milestones-grid">'+MILESTONES.map(function(m){
      var isEarned=earned.has(m.id);
      return '<div class="snx-milestone-card'+(isEarned?' earned':'')+'">'
        +'<div class="snx-milestone-icon">'+m.icon+'</div>'
        +'<div class="snx-milestone-name">'+_esc(m.name)+'</div>'
        +'<div class="snx-milestone-desc">'+_esc(m.desc)+'</div>'
        +(isEarned?'<div style="font-size:10px;color:#00ff88;margin-top:4px;font-weight:700;">EARNED ✓</div>':'')
      +'</div>';
    }).join('')+'</div></div>';
  _addCleanup('milestonesPage',function(){});
}
/* Award milestone */
window.snxAwardMilestone=function(id){
  var fs=_fs(),cu=_cu(),db=_db();
  if(!fs.updateDoc||!cu||!db) return;
  var ud=_ud();
  var milestones=ud.milestones||[];
  if(milestones.includes(id)) return;
  fs.updateDoc(fs.doc(db,'users',cu.uid),{milestones:fs.arrayUnion?fs.arrayUnion(id):[...milestones,id]}).then(function(){
    if(ud) ud.milestones=[...milestones,id];
    _toast('🏅 Milestone unlocked: '+(MILESTONES.find(function(m){return m.id===id;})||{name:id}).name);
  }).catch(function(){});
};
/* ══════════════════════════════════════════════════════
   14. PRIVACY CENTER UI
══════════════════════════════════════════════════════ */
function _initPrivacyCenter(){
  var page=_el('privacyCenterPage');
  if(!page) return;
  var settings=window.SNXPrivacy?window.SNXPrivacy.getSettings():{};
  var OPTIONS=[{v:'everyone',l:'Everyone'},{v:'friends',l:'Friends/Followers'},{v:'nobody',l:'Nobody'}];
  function sel(key){
    return '<select class="priv-select" onchange="snxSavePrivacySetting(\''+key+'\',this.value)">'+OPTIONS.map(function(o){
      return '<option value="'+o.v+'"'+(settings[key]===o.v?' selected':'')+'>'+o.l+'</option>';
    }).join('')+'</select>';
  }
  var rows=[
    {key:'whoCanMessage',label:'Who can message me?',sub:''},
    {key:'whoCanFollow',label:'Who can follow me?',sub:''},
    {key:'whoCanComment',label:'Who can comment on my posts?',sub:''},
    {key:'whoCanSeeActivity',label:'Who can see my activity status?',sub:'Online/Away indicators'},
    {key:'whoCanSeeConnections',label:'Who can see my followers/following?',sub:''},
    {key:'whoCanTagMe',label:'Who can tag/mention me?',sub:''},
    {key:'whoCanPostToProfile',label:'Who can post to my profile?',sub:''}
  ];
  page.innerHTML='<div class="section-card">'
    +'<h3 style="margin:0 0 6px;color:#00ccff;font-size:16px;">🛡️ Privacy Center</h3>'
    +'<p style="font-size:12px;color:#3a6a9a;margin:0 0 16px;">Control who can interact with you across Shadow Nexus Social.</p>'
    +'<div class="priv-section">'+rows.map(function(r){
      return '<div class="priv-row"><div><div class="priv-label">'+_esc(r.label)+'</div>'+(r.sub?'<div class="priv-label-sub">'+_esc(r.sub)+'</div>':'')+'</div>'+sel(r.key)+'</div>';
    }).join('')+'</div>'
    +'<div class="priv-section"><div class="snx-section-label">Blocked Accounts</div><div id="privBlockedList"></div></div>'
    +'<div class="priv-section"><div class="snx-section-label">Muted Accounts</div><div id="privMutedList"></div></div>'
  +'</div>';
  // Load blocked + muted
  if(window.SNXPrivacy){
    window.SNXPrivacy.getBlocked().then(_renderBlockedList).catch(function(){});
    window.SNXPrivacy.getMuted().then(_renderMutedList).catch(function(){});
  }
  _addCleanup('privacyCenterPage',function(){});
}
window.snxSavePrivacySetting=function(key,val){
  if(!window.SNXPrivacy) return;
  var settings=window.SNXPrivacy.getSettings();
  settings[key]=val;
  window.SNXPrivacy.saveSettings(settings).then(function(){_toast('Privacy setting saved.');}).catch(function(e){_toast('Error: '+(e.message||e));});
};
function _renderBlockedList(items){
  var cont=_el('privBlockedList'); if(!cont) return;
  if(!items||!items.length){cont.innerHTML='<div style="color:#2a4a6a;font-size:12px;">No blocked accounts.</div>';return;}
  cont.innerHTML=items.map(function(u){
    return '<div class="priv-blocked-item">'
      +'<div class="priv-user-av">👤</div>'
      +'<div class="priv-user-name">'+_esc(u.name||u.uid)+'</div>'
      +'<button class="priv-unblock-btn" onclick="snxUnblockUser(\''+_esc(u.uid)+'\')">Unblock</button>'
    +'</div>';
  }).join('');
}
function _renderMutedList(items){
  var cont=_el('privMutedList'); if(!cont) return;
  if(!items||!items.length){cont.innerHTML='<div style="color:#2a4a6a;font-size:12px;">No muted accounts.</div>';return;}
  cont.innerHTML=items.map(function(u){
    return '<div class="priv-muted-item">'
      +'<div class="priv-user-av">🔇</div>'
      +'<div class="priv-user-name">'+_esc(u.name||u.uid)+'</div>'
      +'<button class="priv-unmute-btn" onclick="snxUnmuteUser(\''+_esc(u.uid)+'\')">Unmute</button>'
    +'</div>';
  }).join('');
}
window.snxUnblockUser=function(uid2){
  if(!window.SNXPrivacy) return;
  window.SNXPrivacy.unblock(uid2).then(function(){
    _toast('User unblocked.');
    window.SNXPrivacy.getBlocked().then(_renderBlockedList).catch(function(){});
  }).catch(function(e){_toast('Error: '+(e.message||e));});
};
window.snxUnmuteUser=function(uid2){
  if(!window.SNXPrivacy) return;
  window.SNXPrivacy.unmute(uid2).then(function(){
    _toast('User unmuted.');
    window.SNXPrivacy.getMuted().then(_renderMutedList).catch(function(){});
  }).catch(function(e){_toast('Error: '+(e.message||e));});
};
/* Block/mute quick actions (from profile/messages) */
window.snxBlockUser=function(uid2,name){
  if(!window.SNXPrivacy){_toast('Privacy service unavailable.');return;}
  window.SNXPrivacy.block(uid2,name).then(function(){_toast('User blocked.');}).catch(function(e){_toast('Error: '+(e.message||e));});
};
window.snxMuteUser=function(uid2,name){
  if(!window.SNXPrivacy){_toast('Privacy service unavailable.');return;}
  window.SNXPrivacy.mute(uid2,name).then(function(){_toast('User muted.');}).catch(function(e){_toast('Error: '+(e.message||e));});
};

/* ══════════════════════════════════════════════════════
   15. MOBILE GESTURES
══════════════════════════════════════════════════════ */
(function _initMobileGestures(){
  // Pull-to-refresh on feed — only if not in iFrame, only if browser doesn't natively handle
  var _ptStartY=0,_ptPulling=false;
  var PULL_THRESHOLD=80;
  var feedEl=_el('feed');
  if(feedEl){
    feedEl.addEventListener('touchstart',function(e){ _ptStartY=e.touches[0].clientY; },{ passive:true });
    feedEl.addEventListener('touchmove',function(e){
      if(feedEl.scrollTop>0) return;
      var dy=e.touches[0].clientY-_ptStartY;
      if(dy>20&&!_ptPulling){ _ptPulling=true; _showPullRefresh(); }
    },{ passive:true });
    feedEl.addEventListener('touchend',function(){
      if(_ptPulling){
        _ptPulling=false;
        _hidePullRefresh();
        // Trigger feed refresh if available
        if(typeof window.snxRefreshFeed==='function') window.snxRefreshFeed();
        else if(typeof window.loadFeed==='function') window.loadFeed();
      }
    },{ passive:true });
  }
  function _showPullRefresh(){
    var el=_el('snxPullRefresh'); if(!el) return;
    el.className='snx-pull-refresh pulling'; el.textContent='↓ Pull to refresh';
  }
  function _hidePullRefresh(){
    var el=_el('snxPullRefresh'); if(!el) return;
    el.className='snx-pull-refresh refreshing'; el.textContent='⟳ Refreshing…';
    setTimeout(function(){ el.className='snx-pull-refresh'; },1500);
  }
})();

/* ══════════════════════════════════════════════════════
   16. CINEMATIC EMPTY STATES — patch existing
══════════════════════════════════════════════════════ */
(function _patchEmptyStates(){
  // Observe DOM for generic "empty-state" divs and enhance them
  if(!window.MutationObserver) return;
  var _obs=new MutationObserver(function(muts){
    muts.forEach(function(m){
      m.addedNodes.forEach(function(node){
        if(node.nodeType!==1) return;
        node.querySelectorAll('.empty-state').forEach(function(el){
          if(el.dataset.snxEnhanced) return;
          el.dataset.snxEnhanced='1';
          var text=el.textContent||'';
          if(text.includes('no message')||text.includes('No message'))
            el.innerHTML='<div class="snx-empty-icon">💬</div><div class="snx-empty-title">The Nexus is quiet.</div><div class="snx-empty-sub">Send the first message.</div>';
          else if(text.includes('notification'))
            el.innerHTML='<div class="snx-empty-icon">🔔</div><div class="snx-empty-title">No new signals from the Nexus.</div><div class="snx-empty-sub">Notifications appear here.</div>';
          else if(text.includes('no post')||text.includes('No post'))
            el.innerHTML='<div class="snx-empty-icon">✦</div><div class="snx-empty-title">The feed is quiet.</div><div class="snx-empty-sub">Posts from the community appear here.</div>';
        });
      });
    });
  });
  _obs.observe(document.body,{childList:true,subtree:true});
})();

/* ══════════════════════════════════════════════════════
   17. FIRST-TIME ONBOARDING
══════════════════════════════════════════════════════ */
function _checkOnboarding(cu,ud){
  if(!cu||!ud) return;
  // Only show for very new accounts (no displayName or onboardingDone flag)
  if(ud.onboardingDone||ud.displayName) return;
  // Check account age — only trigger for accounts < 10 minutes old
  if(cu.metadata&&cu.metadata.creationTime){
    var created=new Date(cu.metadata.creationTime).getTime();
    if(Date.now()-created>600000) return; // > 10 min old — skip
  }
  setTimeout(_showOnboarding,1500); // delay so main app finishes loading
}
function _showOnboarding(){
  if(_el('snxOnboarding')&&_el('snxOnboarding').classList.contains('open')) return;
  var el=_el('snxOnboarding'); if(!el) return;
  el.classList.add('open');
  window._snxObStep=1;
  _updateObStep(1);
}
function _updateObStep(step){
  if(!_el('snxOnboarding')) return;
  _el('snxOnboarding').querySelectorAll('.snxob-step').forEach(function(s){ s.classList.remove('active'); });
  var s=_el('snxObStep'+step); if(s) s.classList.add('active');
  // Dots
  var dots=_el('snxOnboarding').querySelectorAll('.snxob-dot');
  dots.forEach(function(d,i){
    d.classList.remove('active','done');
    if(i+1<step) d.classList.add('done');
    else if(i+1===step) d.classList.add('active');
  });
}
window.snxObNext=function(){
  var step=window._snxObStep||1;
  if(step>=7){ window.snxObFinish(); return; }
  window._snxObStep=step+1;
  _updateObStep(window._snxObStep);
};
window.snxObSkip=function(){ window.snxObFinish(); };
window.snxObFinish=function(){
  var el=_el('snxOnboarding'); if(el) el.classList.remove('open');
  // Mark onboarding done
  var fs=_fs(),cu=_cu(),db=_db();
  if(fs.updateDoc&&cu&&db){
    fs.updateDoc(fs.doc(db,'users',cu.uid),{onboardingDone:true,onboardingDoneAt:Date.now()}).catch(function(){});
  }
  _toast('Welcome to Shadow Nexus Social! 🌑🔥');
  // Award founding member milestone
  window.snxAwardMilestone&&window.snxAwardMilestone('founding_member');
};
window.snxObSaveInterests=function(){
  var selected=[];
  _el('snxOnboarding').querySelectorAll('.snxob-interest.selected').forEach(function(el){selected.push(el.dataset.interest);});
  var fs=_fs(),cu=_cu(),db=_db();
  if(fs.updateDoc&&cu&&db&&selected.length){
    fs.updateDoc(fs.doc(db,'users',cu.uid),{interests:selected}).catch(function(){});
  }
  window.snxObNext();
};

/* ══════════════════════════════════════════════════════
   18. UNIVERSAL QUICK CREATE
══════════════════════════════════════════════════════ */
function _initQuickCreate(){
  if(_el('snxQuickCreateBtn')) return; // already added
  var btn=document.createElement('button');
  btn.id='snxQuickCreateBtn';
  btn.setAttribute('aria-label','Quick Create');
  btn.setAttribute('title','Create something new');
  btn.innerHTML='⚡';
  btn.addEventListener('click',function(e){ e.stopPropagation(); _openQuickCreate(); });
  document.body.appendChild(btn);
  // Sheet
  if(!_el('snxQuickCreateSheet')){
    var sheet=document.createElement('div');
    sheet.id='snxQuickCreateSheet';
    sheet.innerHTML='<div class="snxqc-inner" id="snxQCInner">'
      +'<div class="snxqc-handle"></div>'
      +'<div class="snxqc-title">Create Something</div>'
      +'<div class="snxqc-grid">'
        +'<div class="snxqc-item" onclick="window._snxQCAction(\'post\')"><div class="snxqc-icon">✦</div><div class="snxqc-label">Post</div></div>'
        +'<div class="snxqc-item" onclick="window._snxQCAction(\'story\')"><div class="snxqc-icon">📖</div><div class="snxqc-label">Story</div></div>'
        +'<div class="snxqc-item" onclick="window._snxQCAction(\'music\')"><div class="snxqc-icon">🎵</div><div class="snxqc-label">Upload Music</div></div>'
        +'<div class="snxqc-item" onclick="window._snxQCAction(\'video\')"><div class="snxqc-icon">🎬</div><div class="snxqc-label">Upload Video</div></div>'
        +'<div class="snxqc-item" onclick="window._snxQCAction(\'live\')"><div class="snxqc-icon">🔴</div><div class="snxqc-label">Go Live</div></div>'
      +'</div></div>';
    sheet.addEventListener('click',function(e){ if(e.target===sheet) _closeQuickCreate(); });
    document.body.appendChild(sheet);
  }
}
function _openQuickCreate(){
  var sheet=_el('snxQuickCreateSheet'); if(sheet) sheet.classList.add('open');
}
function _closeQuickCreate(){
  var sheet=_el('snxQuickCreateSheet'); if(sheet) sheet.classList.remove('open');
}
window._snxQCAction=function(action){
  _closeQuickCreate();
  switch(action){
    case 'post':
      if(typeof window.realmNavTo==='function') window.realmNavTo('feed');
      setTimeout(function(){ var pi=_el('postInput'); if(pi){pi.focus();pi.scrollIntoView({behavior:'smooth'});} },400);
      break;
    case 'story':
      if(typeof window.openCreateStoryModal==='function') window.openCreateStoryModal();
      else if(typeof window.realmNavTo==='function') window.realmNavTo('feed');
      break;
    case 'music':
      if(typeof window.realmNavTo==='function') window.realmNavTo('studioPage');
      else if(typeof window.realmNavTo==='function') window.realmNavTo('nexusPage');
      break;
    case 'video':
      if(typeof window.realmNavTo==='function') window.realmNavTo('studioPage');
      break;
    case 'live':
      if(typeof window.goLiveOrWatch==='function') window.goLiveOrWatch();
      else if(typeof window.realmNavTo==='function') window.realmNavTo('liveHubPage');
      break;
  }
};

/* ══════════════════════════════════════════════════════
   ONBOARDING DOM — injected once on first load
══════════════════════════════════════════════════════ */
(function _injectOnboarding(){
  if(_el('snxOnboarding')) return;
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',_buildOnboarding);
  } else {
    _buildOnboarding();
  }
})();
function _buildOnboarding(){
  if(_el('snxOnboarding')) return;
  var INTERESTS=['Music','Videos','Live Streaming','Art','Gaming','Tech','Photography','Writing','Community','Podcasts'];
  var ob=document.createElement('div'); ob.id='snxOnboarding';
  ob.innerHTML='<div class="snxob-wrap">'
    +'<div class="snxob-progress">'+Array.from({length:7}).map(function(_,i){ return '<div class="snxob-dot'+(i===0?' active':'')+'"></div>'; }).join('')+'</div>'
    // Step 1 — Welcome
    +'<div class="snxob-step active" id="snxObStep1">'
      +'<div class="snxob-header"><div class="snxob-icon">🌑</div><div class="snxob-title">WELCOME TO THE NEXUS</div><div class="snxob-sub">Shadow Nexus Social — a safe space to connect. No judgment. Stay legendary.</div></div>'
      +'<div class="snxob-actions"><button class="snxob-btn-next" onclick="snxObNext()">Begin →</button></div>'
    +'</div>'
    // Step 2 — Username
    +'<div class="snxob-step" id="snxObStep2">'
      +'<div class="snxob-header"><div class="snxob-icon">👤</div><div class="snxob-title">Your Identity</div><div class="snxob-sub">Your display name is how the Nexus knows you.</div></div>'
      +'<input id="snxObName" placeholder="Display Name" style="margin:0 0 12px;">'
      +'<div class="snxob-actions"><button class="snxob-btn-skip" onclick="snxObNext()">Skip</button><button class="snxob-btn-next" onclick="snxObSaveName()">Continue →</button></div>'
    +'</div>'
    // Step 3 — Avatar
    +'<div class="snxob-step" id="snxObStep3">'
      +'<div class="snxob-header"><div class="snxob-icon">🎭</div><div class="snxob-title">Your Avatar</div><div class="snxob-sub">Add a profile picture URL or skip for now.</div></div>'
      +'<input id="snxObAvatar" placeholder="Avatar URL (optional)" style="margin:0 0 12px;">'
      +'<div class="snxob-actions"><button class="snxob-btn-skip" onclick="snxObNext()">Skip</button><button class="snxob-btn-next" onclick="snxObSaveAvatar()">Continue →</button></div>'
    +'</div>'
    // Step 4 — Bio
    +'<div class="snxob-step" id="snxObStep4">'
      +'<div class="snxob-header"><div class="snxob-icon">📝</div><div class="snxob-title">Your Bio</div><div class="snxob-sub">A short bio for your profile.</div></div>'
      +'<textarea id="snxObBio" placeholder="Tell the Nexus about yourself…" rows="3" style="margin:0 0 12px;resize:vertical;"></textarea>'
      +'<div class="snxob-actions"><button class="snxob-btn-skip" onclick="snxObNext()">Skip</button><button class="snxob-btn-next" onclick="snxObSaveBio()">Continue →</button></div>'
    +'</div>'
    // Step 5 — Interests
    +'<div class="snxob-step" id="snxObStep5">'
      +'<div class="snxob-header"><div class="snxob-icon">✨</div><div class="snxob-title">Your Interests</div><div class="snxob-sub">What brings you to the Nexus?</div></div>'
      +'<div class="snxob-interests">'+INTERESTS.map(function(i){ return '<button class="snxob-interest" data-interest="'+_esc(i)+'" onclick="this.classList.toggle(\'selected\')">'+_esc(i)+'</button>'; }).join('')+'</div>'
      +'<div class="snxob-actions"><button class="snxob-btn-skip" onclick="snxObNext()">Skip</button><button class="snxob-btn-next" onclick="snxObSaveInterests()">Continue →</button></div>'
    +'</div>'
    // Step 6 — Find people
    +'<div class="snxob-step" id="snxObStep6">'
      +'<div class="snxob-header"><div class="snxob-icon">👥</div><div class="snxob-title">Find People</div><div class="snxob-sub">Discover the Nexus community.</div></div>'
      +'<div id="snxObSuggestions" style="margin-bottom:12px;"></div>'
      +'<div class="snxob-actions"><button class="snxob-btn-skip" onclick="snxObNext()">Skip</button><button class="snxob-btn-next" onclick="snxObNext()">Continue →</button></div>'
    +'</div>'
    // Step 7 — Enter
    +'<div class="snxob-step" id="snxObStep7">'
      +'<div class="snxob-header"><div class="snxob-icon">🌑🔥</div><div class="snxob-title">ENTER SHADOW NEXUS</div><div class="snxob-sub">You\'re ready. Stay legendary.</div></div>'
      +'<div class="snxob-actions"><button class="snxob-btn-next" style="background:linear-gradient(135deg,#001a55,#003399,#0066cc);font-size:15px;letter-spacing:1px;" onclick="snxObFinish()">ENTER THE NEXUS 🌑</button></div>'
    +'</div>'
  +'</div>';
  document.body.appendChild(ob);
}
window.snxObSaveName=function(){
  var inp=_el('snxObName'); var name=inp?inp.value.trim():'';
  var fs=_fs(),cu=_cu(),db=_db();
  if(name&&fs.updateDoc&&cu&&db){
    fs.updateDoc(fs.doc(db,'users',cu.uid),{displayName:name}).then(function(){ if(window._snxUserData) window._snxUserData.displayName=name; }).catch(function(){});
  }
  window.snxObNext();
};
window.snxObSaveAvatar=function(){
  var inp=_el('snxObAvatar'); var url=inp?inp.value.trim():'';
  var fs=_fs(),cu=_cu(),db=_db();
  if(url&&fs.updateDoc&&cu&&db){
    fs.updateDoc(fs.doc(db,'users',cu.uid),{avatar:url,profileImage:url}).then(function(){ if(window._snxUserData) window._snxUserData.avatar=url; }).catch(function(){});
  }
  window.snxObNext();
};
window.snxObSaveBio=function(){
  var inp=_el('snxObBio'); var bio=inp?inp.value.trim():'';
  var fs=_fs(),cu=_cu(),db=_db();
  if(bio&&fs.updateDoc&&cu&&db){
    fs.updateDoc(fs.doc(db,'users',cu.uid),{bio:bio}).then(function(){ if(window._snxUserData) window._snxUserData.bio=bio; }).catch(function(){});
  }
  window.snxObNext();
};

/* Pull-to-refresh DOM element injected once */
(function(){
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',function(){ _injectPullRefresh(); });
  } else { _injectPullRefresh(); }
})();
function _injectPullRefresh(){
  if(_el('snxPullRefresh')) return;
  var el=document.createElement('div'); el.id='snxPullRefresh'; el.className='snx-pull-refresh';
  var feed=_el('feed'); if(feed&&feed.parentNode) feed.parentNode.insertBefore(el,feed);
}

/* ══════════════════════════════════════════════════════
   FIRESTORE RULES HELPER — expose upgrade rules to admin
══════════════════════════════════════════════════════ */
window.snxGetNewRulesSummary=function(){
  return [
    '/users/{uid}/vault/{itemId} — private, owner-only read/write',
    '/users/{uid}/blocked/{uid2} — private, owner-only read/write',
    '/users/{uid}/muted/{uid2}   — private, owner-only read/write',
    'msgReactions/{docId}         — signed-in create; owner update/delete',
    'presence/{uid} via RTDB     — existing rules updated in database.rules.json'
  ].join('\n');
};

})(); /* end IIFE */
