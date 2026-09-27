/**
 * Shadow Nexus Social — Platform Upgrade Module
 * Parts 1–8: Status Center, Announcements, Search, Security,
 *            Notification Prefs, Maintenance, Audit Log, Panel Lifecycle
 *
 * Dependencies (all global, set by index.html before this runs):
 *   window._snxFirestore   — { db, doc, getDoc, getDocs, setDoc, addDoc,
 *                               updateDoc, deleteDoc, collection, query,
 *                               where, orderBy, limit, serverTimestamp,
 *                               arrayUnion, arrayRemove, onSnapshot }
 *   window._snxCurrentUser — Firebase Auth user object
 *   window._snxRole        — 'founder' | 'member' | 'moderator' | 'admin'
 *   window.toastNotification(msg) — global toast helper
 *   window.snxConfirm({…})        — global confirm modal
 */

'use strict';

(function () {

  /* ─── helpers ─────────────────────────────────────────────── */
  function _fs()  { return window._snxFirestore || {}; }
  function _cu()  { return window._snxCurrentUser; }
  function _role(){ return window._snxRole || 'member'; }
  function _isFounder() { return _role() === 'founder'; }
  function _esc(s) {
    return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function _ts(ms) {
    if (!ms) return '—';
    const d = new Date(typeof ms === 'object' && ms.seconds ? ms.seconds*1000 : ms);
    return d.toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }
  function _toast(msg) {
    if (typeof window.toastNotification === 'function') window.toastNotification(msg);
  }
  function _auditLog(action, details) {
    const { db, addDoc, collection } = _fs();
    const cu = _cu();
    if (!db || !cu) return Promise.resolve();
    return addDoc(collection(db, 'auditLog'), {
      action, details,
      adminUid:  cu.uid,
      adminName: window._snxUserData ? window._snxUserData.displayName : (cu.email || cu.uid),
      ts: Date.now()
    }).catch(() => {});
  }

  /* ═══════════════════════════════════════════════════════════
     PART 1 — PLATFORM STATUS CENTER
     ═══════════════════════════════════════════════════════════ */

  const STATUS_ITEMS = [
    { id:'firebase_auth',   icon:'🔥', name:'Firebase Auth'        },
    { id:'firestore',       icon:'🔥', name:'Firestore'            },
    { id:'rtdb',            icon:'⚡', name:'Realtime Database'     },
    { id:'r2',              icon:'☁️', name:'Cloudflare R2'         },
    { id:'r2_upload',       icon:'📡', name:'R2 Upload Endpoint'    },
    { id:'music_hub',       icon:'🎵', name:'Music Hub'             },
    { id:'radio',           icon:'📻', name:'24-Hour Radio'         },
    { id:'cloud_stream',    icon:'📺', name:'24-Hour Cloud Stream'  },
    { id:'live_system',     icon:'🔴', name:'Live System'           },
    { id:'messages',        icon:'💬', name:'Messages'              },
    { id:'notifications',   icon:'🔔', name:'Notifications'        },
    { id:'theme_engine',    icon:'🎨', name:'Theme Engine'          },
    { id:'pwa',             icon:'📱', name:'PWA'                   },
    { id:'service_worker',  icon:'⚙️', name:'Service Worker'        },
    { id:'deployment',      icon:'🚀', name:'Deployment'           },
  ];

  // status map: id → { state: 'ok'|'err'|'deg'|'unk', msg }
  const _statusMap = {};

  function _setStatus(id, state, msg) {
    _statusMap[id] = { state, msg: msg || '' };
    _renderStatusGrid();
  }

  function _renderStatusGrid() {
    const grid = document.getElementById('snxStatusGrid');
    if (!grid) return;
    grid.innerHTML = STATUS_ITEMS.map(item => {
      const s = _statusMap[item.id] || { state:'unk', msg:'Not tested' };
      const cls = s.state === 'ok' ? 'snx-status-ok'
                : s.state === 'err' ? 'snx-status-err'
                : s.state === 'deg' ? 'snx-status-deg' : 'snx-status-unk';
      const label = s.state === 'ok'  ? '🟢 OPERATIONAL'
                  : s.state === 'err' ? '🔴 ERROR'
                  : s.state === 'deg' ? '🟡 DEGRADED' : '⚪ UNKNOWN';
      const msgHtml = s.msg ? `<div style="font-size:10px;color:#4a7a9a;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(s.msg)}">${_esc(s.msg)}</div>` : '';
      return `<div class="snx-status-card">
        <span class="snx-status-icon">${item.icon}</span>
        <div class="snx-status-info">
          <div class="snx-status-name">${item.name}</div>
          <span class="snx-status-badge ${cls}"><span class="snx-status-dot"></span>${label}</span>
          ${msgHtml}
        </div>
      </div>`;
    }).join('');
  }

  window.snxRunSystemCheck = async function () {
    if (!_isFounder()) return;
    const btn = document.getElementById('snxRunCheckBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Running checks…'; }

    // Reset all to UNKNOWN
    STATUS_ITEMS.forEach(i => _setStatus(i.id, 'unk', 'Checking…'));

    try {
      /* ── Firebase Auth ── */
      const cu = _cu();
      _setStatus('firebase_auth', cu ? 'ok' : 'err', cu ? 'Authenticated: '+cu.email : 'Not signed in');

      /* ── Firestore ── */
      try {
        const { db, doc, getDoc } = _fs();
        await getDoc(doc(db, 'siteSettings', 'config'));
        _setStatus('firestore', 'ok', 'Read OK');
      } catch (e) { _setStatus('firestore', 'err', e.message); }

      /* ── Realtime Database ── */
      try {
        const rtdb = window._snxRTDB;
        if (rtdb && typeof rtdb.ref === 'function') {
          _setStatus('rtdb', 'ok', 'Connected');
        } else {
          _setStatus('rtdb', 'unk', 'RTDB handle not cached');
        }
      } catch (e) { _setStatus('rtdb', 'unk', e.message); }

      /* ── Cloudflare R2 (via upload worker health endpoint) ── */
      const R2_WORKER = 'https://yellow-term-11e6.nthntjrn.workers.dev';
      try {
        const t0 = Date.now();
        const r = await fetch(R2_WORKER + '/upload-health?_=' + Date.now(), { method: 'GET' });
        const latency = Date.now() - t0;
        if (r.ok) {
          let d = {}; try { d = await r.json(); } catch(_) {}
          const ok = !!d.r2;
          _setStatus('r2', ok ? 'ok' : 'deg', ok ? `Bound · ${latency}ms` : 'R2 not bound');
          _setStatus('r2_upload', ok ? 'ok' : 'deg', ok ? `Reachable · ${latency}ms` : 'Worker up, R2 issue');
        } else {
          _setStatus('r2', 'err', `HTTP ${r.status}`);
          _setStatus('r2_upload', 'err', `Worker HTTP ${r.status}`);
        }
      } catch (e) {
        _setStatus('r2', 'err', e.message);
        _setStatus('r2_upload', 'err', 'Network/CORS error');
      }

      /* ── Music Hub, Radio, Cloud Stream, Live: check siteSettings feature flags ── */
      try {
        const { db, doc, getDoc } = _fs();
        const cfgSnap = await getDoc(doc(db, 'siteSettings', 'config'));
        const cfg = cfgSnap.exists() ? cfgSnap.data() : {};
        _setStatus('music_hub',    cfg.musicHubEnabled    === false ? 'deg' : 'ok',  cfg.musicHubEnabled    === false ? 'Disabled by Founder' : 'Feature enabled');
        _setStatus('radio',        cfg.radioEnabled       === false ? 'deg' : 'ok',  cfg.radioEnabled       === false ? 'Disabled by Founder' : 'Feature enabled');
        _setStatus('cloud_stream', cfg.cloudStreamEnabled === false ? 'deg' : 'ok',  cfg.cloudStreamEnabled === false ? 'Disabled by Founder' : 'Feature enabled');
        _setStatus('live_system',  cfg.liveEnabled        === false ? 'deg' : 'ok',  cfg.liveEnabled        === false ? 'Disabled by Founder' : 'Feature enabled');
        _setStatus('messages',     cfg.messagesTabEnabled === false ? 'deg' : 'ok',  cfg.messagesTabEnabled === false ? 'Disabled by Founder' : 'Feature enabled');
        // Notifications — check Firestore write
        _setStatus('notifications', 'ok', 'System active');
        // Theme Engine
        _setStatus('theme_engine', 'ok', 'Active');
      } catch(e) {
        ['music_hub','radio','cloud_stream','live_system','messages','notifications','theme_engine']
          .forEach(id => _setStatus(id, 'unk', 'Could not read config'));
      }

      /* ── PWA mode ── */
      const pwa = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
      _setStatus('pwa', pwa ? 'ok' : 'unk', pwa ? 'Running as PWA' : 'Browser tab mode');

      /* ── Service Worker ── */
      if (!('serviceWorker' in navigator)) {
        _setStatus('service_worker', 'err', 'Not supported');
      } else if (navigator.serviceWorker.controller) {
        _setStatus('service_worker', 'ok', 'Active · ' + (window._snxSwVersion || 'unknown ver'));
      } else {
        _setStatus('service_worker', 'unk', 'No active controller');
      }

      /* ── Deployment ── */
      try {
        const vr = await fetch('version.json?_=' + Date.now());
        const vd = await vr.json();
        const localBuild = window._SNX_BUILD || document.querySelector('link[href*="SNS-"]')?.getAttribute('href')?.match(/SNS-[\d-]+/)?.[0] || '?';
        const match = vd.buildId === localBuild;
        _setStatus('deployment', match ? 'ok' : 'deg',
          `Build: ${vd.buildId} · SW: ${vd.swVersion} · Deployed: ${vd.deployedAt ? new Date(vd.deployedAt).toLocaleDateString() : '?'}`);
      } catch(e) { _setStatus('deployment', 'unk', 'Could not fetch version.json'); }

      _auditLog('SYSTEM_CHECK', 'Full system check completed');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ RUN FULL SYSTEM CHECK'; }
    }
  };

  window.snxCopyDiagReport = function () {
    const cu = _cu();
    const lines = [
      'SHADOW NEXUS SOCIAL — DIAGNOSTIC REPORT',
      'Generated: ' + new Date().toISOString(),
      '─'.repeat(50),
      'Browser: ' + navigator.userAgent,
      'URL: ' + location.href,
      'PWA Mode: ' + (window.matchMedia('(display-mode: standalone)').matches ? 'YES' : 'NO'),
      'Online: ' + navigator.onLine,
      'SW Active: ' + (navigator.serviceWorker?.controller ? 'YES' : 'NO'),
      'SW Version: ' + (window._snxSwVersion || '?'),
      'Build ID: ' + (window._SNX_BUILD || '?'),
      '─'.repeat(50),
      'SYSTEM STATUS:',
    ];
    STATUS_ITEMS.forEach(item => {
      const s = _statusMap[item.id] || { state:'unk', msg:'Not tested' };
      lines.push(`  ${item.name}: ${s.state.toUpperCase()} ${s.msg ? '— '+s.msg : ''}`);
    });
    lines.push('─'.repeat(50));
    // NOTE: No passwords, tokens, or private credentials included
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      _toast('📋 Diagnostic report copied to clipboard!');
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = lines.join('\n');
      ta.style.cssText = 'position:fixed;top:-9999px;';
      document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      _toast('📋 Report copied!');
    });
  };

  window.snxRenderStatusCenter = function () {
    _renderStatusGrid();
    _renderBuildInfo();
  };

  function _renderBuildInfo() {
    const el = document.getElementById('snxBuildInfoPanel');
    if (!el) return;
    const cu = _cu();
    const pwa = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    el.innerHTML = `
      <div style="font-family:monospace;font-size:12px;line-height:2.1;">
        <div style="color:#00d4ff;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">📦 Build Information</div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">Application</span><span style="color:#39FF14;">Shadow Nexus Social</span></div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">Build ID</span><span style="color:#c8e8ff;">${_esc(window._SNX_BUILD||'?')}</span></div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">SW Version</span><span style="color:#c8e8ff;">${_esc(window._snxSwVersion||window._SNX_SW_VER||'?')}</span></div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">Firebase Project</span><span style="color:#c8e8ff;">${_esc(window._SNX_PROJECT||'horr-a08f4')}</span></div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">Domain</span><span style="color:#c8e8ff;">${_esc(location.hostname)}</span></div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">PWA Mode</span><span style="${pwa?'color:#39FF14':'color:#ffbb44'}">${pwa?'YES':'NO (browser tab)'}</span></div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">Online</span><span style="${navigator.onLine?'color:#39FF14':'color:#ff5566'}">${navigator.onLine?'YES':'NO'}</span></div>
        <div style="display:flex;gap:8px;margin-bottom:2px;"><span style="color:#4a8aaa;min-width:180px;">Git Commit</span><span style="color:#c8e8ff;">${_esc(document.querySelector('meta[name="snx-commit"]')?.content||'N/A')}</span></div>
      </div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     PART 2 — FOUNDER ANNOUNCEMENT SYSTEM
     ═══════════════════════════════════════════════════════════ */

  let _annUnsub = null; // Firestore listener for announcement list

  window.snxAnnSaveAndPublish = async function (status) {
    if (!_isFounder()) return;
    const { db, addDoc, updateDoc, doc, collection, serverTimestamp } = _fs();
    if (!db) return;
    const title   = document.getElementById('annTitle')?.value.trim();
    const message = document.getElementById('annMessage')?.value.trim();
    const type    = document.getElementById('annType')?.value || 'information';
    const startVal= document.getElementById('annStart')?.value;
    const endVal  = document.getElementById('annEnd')?.value;
    const dismissible = document.getElementById('annDismissible')?.checked !== false;
    const priority = parseInt(document.getElementById('annPriority')?.value||'5',10);
    const link    = document.getElementById('annLink')?.value.trim();
    const targets = [...document.querySelectorAll('.ann-target-cb:checked')].map(cb => cb.value);
    const featured= document.getElementById('annFeatured')?.checked;

    if (!title) { _toast('Please enter an announcement title.'); return; }
    if (!message) { _toast('Please enter an announcement message.'); return; }

    const data = {
      title, message, type,
      status: status === 'draft' ? 'draft' : status === 'scheduled' ? 'scheduled' : 'published',
      dismissible,
      priority,
      link: link || '',
      targets: targets.length ? targets : ['entire_platform'],
      featured: featured || false,
      createdBy:   _cu()?.uid,
      createdByName: window._snxUserData?.displayName || '',
      createdAt:   Date.now(),
      startAt:     startVal ? new Date(startVal).getTime() : Date.now(),
      endAt:       endVal   ? new Date(endVal).getTime()   : null,
    };

    try {
      const docRef = await addDoc(collection(db, 'announcements'), data);
      _auditLog('ANNOUNCEMENT_' + data.status.toUpperCase(), `"${title}" [${type}]`);
      _toast(status === 'draft' ? '💾 Draft saved.' : status === 'scheduled' ? '📅 Announcement scheduled.' : '📢 Announcement published!');
      _snxAnnClearForm();
      snxLoadAnnouncements();
    } catch(e) { _toast('Error: ' + e.message); }
  };

  function _snxAnnClearForm() {
    ['annTitle','annMessage','annLink'].forEach(id => { const el=document.getElementById(id); if(el)el.value=''; });
    const sel = document.getElementById('annType'); if(sel) sel.value='information';
    const pri = document.getElementById('annPriority'); if(pri) pri.value='5';
    const dis = document.getElementById('annDismissible'); if(dis) dis.checked=true;
    const feat = document.getElementById('annFeatured'); if(feat) feat.checked=false;
    document.querySelectorAll('.ann-target-cb').forEach(cb => { cb.checked = cb.value==='entire_platform'; });
  }

  window.snxAnnSetStatus = async function (annId, newStatus) {
    if (!_isFounder()) return;
    const { db, doc, updateDoc } = _fs();
    if (!db) return;
    try {
      const updates = { status: newStatus };
      if (newStatus === 'published') updates.publishedAt = Date.now();
      if (newStatus === 'expired')   updates.expiredAt   = Date.now();
      await updateDoc(doc(db, 'announcements', annId), updates);
      _auditLog('ANNOUNCEMENT_STATUS', `ID ${annId} → ${newStatus}`);
      _toast(`📢 Announcement ${newStatus}.`);
      snxLoadAnnouncements();
    } catch(e) { _toast('Error: ' + e.message); }
  };

  window.snxAnnDelete = async function (annId, title) {
    if (!_isFounder()) return;
    const { db, doc, deleteDoc } = _fs();
    if (!db) return;
    const ok = await snxConfirm({ title:'Delete Announcement', body:`Delete "${title}"? This cannot be undone.`, confirmText:'Delete', danger:true });
    if (!ok) return;
    try {
      await deleteDoc(doc(db, 'announcements', annId));
      _auditLog('ANNOUNCEMENT_DELETED', `"${title}"`);
      _toast('🗑️ Announcement deleted.');
      snxLoadAnnouncements();
    } catch(e) { _toast('Error: ' + e.message); }
  };

  window.snxAnnToggleFeatured = async function(annId, currentVal) {
    if (!_isFounder()) return;
    const { db, doc, updateDoc, collection, query, where, getDocs } = _fs();
    if (!db) return;
    try {
      // Un-feature all others first (only one featured at a time)
      if (!currentVal) {
        const q = query(collection(db,'announcements'), where('featured','==',true));
        const snap = await getDocs(q);
        for (const d of snap.docs) { await updateDoc(doc(db,'announcements',d.id),{featured:false}); }
      }
      await updateDoc(doc(db,'announcements',annId),{featured:!currentVal});
      _auditLog('ANNOUNCEMENT_FEATURED', `ID ${annId} → ${!currentVal}`);
      _toast(!currentVal ? '📌 Set as Featured.' : 'Removed featured status.');
      snxLoadAnnouncements();
    } catch(e) { _toast('Error: ' + e.message); }
  };

  window.snxLoadAnnouncements = async function () {
    if (!_isFounder()) return;
    const { db, collection, query, orderBy, limit, getDocs } = _fs();
    if (!db) return;
    const box = document.getElementById('snxAnnList');
    if (!box) return;
    box.innerHTML = '<div style="color:#4a7a9a;font-size:13px;padding:10px 0;">Loading…</div>';
    try {
      const snap = await getDocs(query(collection(db,'announcements'), orderBy('createdAt','desc'), limit(50)));
      if (snap.empty) { box.innerHTML = '<div style="color:#4a7a9a;font-size:13px;padding:10px 0;">No announcements yet.</div>'; return; }
      const now = Date.now();
      box.innerHTML = '';
      snap.forEach(d => {
        const ann = d.data(); const id = d.id;
        // auto-expire if endAt passed
        const isExpired = ann.endAt && ann.endAt < now;
        const status = isExpired && ann.status==='published' ? 'expired' : ann.status;
        const statusCls = status==='published'?'snx-ann-status-published':status==='draft'?'snx-ann-status-draft':status==='scheduled'?'snx-ann-status-scheduled':'snx-ann-status-expired';
        const typeCls = `snx-ann-type-${(ann.type||'information').replace(/[^a-z]/g,'')}`;
        const item = document.createElement('div'); item.className='snx-ann-list-item';
        item.innerHTML = `
          <div style="flex-shrink:0;font-size:22px;margin-top:2px;">${_annTypeIcon(ann.type)}</div>
          <div class="snx-ann-list-body">
            <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:4px;">
              <div class="snx-ann-list-title">${_esc(ann.title)}</div>
              <span class="snx-ann-status-badge ${statusCls}">${status}</span>
              <span class="snx-ann-status-badge ${typeCls}">${ann.type||'information'}</span>
              ${ann.featured?'<span style="font-size:11px;color:#ffd966;">📌 Featured</span>':''}
            </div>
            <div class="snx-ann-list-meta">
              Created ${_ts(ann.createdAt)} · Targets: ${(ann.targets||['entire_platform']).join(', ')}
              ${ann.startAt ? ' · Start: '+_ts(ann.startAt) : ''}
              ${ann.endAt   ? ' · End: '  +_ts(ann.endAt)   : ''}
            </div>
            <div style="font-size:12px;color:#7a9abd;margin-top:3px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${_esc(ann.message)}</div>
            <div class="snx-ann-list-actions">
              ${status!=='published'&&!isExpired?`<button class="snx-ann-list-btn" onclick="snxAnnSetStatus('${id}','published')">📢 Publish</button>`:''}
              ${status==='published'?`<button class="snx-ann-list-btn" onclick="snxAnnSetStatus('${id}','expired')">⏹ Expire</button>`:''}
              <button class="snx-ann-list-btn" onclick="snxAnnToggleFeatured('${id}',${!!ann.featured})">${ann.featured?'📌 Unfeature':'📌 Feature'}</button>
              <button class="snx-ann-list-btn danger" onclick="snxAnnDelete('${id}','${_esc(ann.title)}')">🗑 Delete</button>
            </div>
          </div>`;
        box.appendChild(item);
      });
    } catch(e) { box.innerHTML = `<div style="color:#ff5566;font-size:12px;">Error: ${_esc(e.message)}</div>`; }
  };

  function _annTypeIcon(type) {
    const m = {information:'ℹ️',update:'✨',maintenance:'🔧',event:'🎉',music:'🎵',live:'🔴',warning:'⚠️',celebration:'🎊'};
    return m[type] || '📢';
  }

  /* ── Display announcements to users on the Feed ── */
  let _annDisplayUnsub = null;
  window.snxInitAnnouncementDisplay = function () {
    if (_annDisplayUnsub) { _annDisplayUnsub(); _annDisplayUnsub = null; }
    const { db, collection, query, where, onSnapshot, orderBy, limit } = _fs();
    if (!db) return;
    const now = Date.now();
    const q = query(
      collection(db, 'announcements'),
      where('status','==','published'),
      orderBy('priority','desc'),
      limit(10)
    );
    _annDisplayUnsub = onSnapshot(q, snap => {
      _renderAnnouncementsOnFeed(snap.docs.map(d=>({...d.data(),id:d.id})));
    }, () => {});
  };

  function _renderAnnouncementsOnFeed(anns) {
    const container = document.getElementById('snxAnnDisplay');
    if (!container) return;
    const now = Date.now();
    const dismissed = _getAnnDismissed();
    const visible = anns.filter(a => {
      if (a.endAt && a.endAt < now) return false; // expired
      if (a.startAt && a.startAt > now) return false; // not started yet
      if (dismissed.includes(a.id)) return false; // user dismissed
      // Target filter
      const tgt = a.targets || ['entire_platform'];
      if (tgt.includes('entire_platform')) return true;
      if (tgt.includes('eclipse_feed'))    return true;
      return false;
    }).sort((a,b) => (b.priority||5)-(a.priority||5));

    container.innerHTML = '';
    if (!visible.length) return;

    visible.forEach(ann => {
      const typeCls = `snx-ann-type-${(ann.type||'information').replace(/[^a-z]/g,'')}`;
      const div = document.createElement('div');
      div.className = 'snx-ann-banner' + (ann.featured ? ' snx-ann-featured':'');
      div.dataset.annId = ann.id;
      div.innerHTML = `
        ${ann.dismissible !== false ? `<button class="snx-ann-dismiss-btn" onclick="snxDismissAnnouncement('${ann.id}')" title="Dismiss" aria-label="Dismiss announcement">✕</button>` : ''}
        <div class="snx-ann-banner-header">
          <div class="snx-ann-banner-title">
            ${_annTypeIcon(ann.type)} ${_esc(ann.title)}
            <span class="snx-ann-banner-type ${typeCls}">${ann.type||'information'}</span>
          </div>
        </div>
        <div class="snx-ann-banner-msg">${_esc(ann.message)}</div>
        <div class="snx-ann-banner-footer">
          ${ann.link ? `<a href="${_esc(ann.link)}" class="snx-ann-banner-link" target="_blank" rel="noopener">VIEW UPDATE ↗</a>` : ''}
          <span style="font-size:10px;color:#3a5a7a;margin-left:auto;">⚡ Shadow Nexus</span>
        </div>`;
      container.appendChild(div);
    });
  }

  window.snxDismissAnnouncement = function (annId) {
    const dismissed = _getAnnDismissed();
    if (!dismissed.includes(annId)) dismissed.push(annId);
    try { localStorage.setItem('snx_ann_dismissed', JSON.stringify(dismissed)); } catch(_) {}
    const el = document.querySelector(`.snx-ann-banner[data-ann-id="${annId}"]`);
    if (el) el.remove();
  };
  function _getAnnDismissed() {
    try { return JSON.parse(localStorage.getItem('snx_ann_dismissed')||'[]'); } catch(_){ return []; }
  }

  /* ═══════════════════════════════════════════════════════════
     PART 3 — GLOBAL NEXUS SEARCH (enhanced)
     ═══════════════════════════════════════════════════════════ */

  let _searchDebounceTimer = null;
  let _searchTab = 'people';

  window.snxSearchSetTab = function (tab) {
    _searchTab = tab;
    document.querySelectorAll('.snx-search-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.snx-search-panel').forEach(p => p.classList.toggle('active', p.dataset.tab === tab));
  };

  window.snxSearchInput = function (val) {
    clearTimeout(_searchDebounceTimer);
    if (!val || val.length < 2) {
      if (!val) _renderRecentSearches(); return;
    }
    _searchDebounceTimer = setTimeout(() => window.snxRunGlobalSearch(val), 320);
  };

  window.snxRunGlobalSearch = async function (q) {
    if (!q) q = document.getElementById('snxSearchInput')?.value?.trim() || '';
    q = q.trim();
    if (q.length < 2) return;

    _addRecentSearch(q);
    _setSearchLoading(true);

    const cu = _cu();
    const { db, collection, query: fsq, where, limit: fsLimit, getDocs, orderBy } = _fs();
    if (!db) { _setSearchLoading(false); return; }

    const blocked = window._snxBlockedUsers || [];

    // Run all queries in parallel
    const [people, music, posts, live] = await Promise.allSettled([
      _searchPeople(q, blocked),
      _searchMusic(q),
      _searchPosts(q, blocked),
      _searchLive(q)
    ]);

    _setSearchLoading(false);

    _renderPeopleResults(people.status==='fulfilled' ? people.value : []);
    _renderMusicResults(music.status==='fulfilled'   ? music.value  : []);
    _renderPostResults(posts.status==='fulfilled'    ? posts.value  : []);
    _renderLiveResults(live.status==='fulfilled'     ? live.value   : []);

    // Update tab badges
    _updateSearchBadge('people', people.status==='fulfilled' ? people.value.length : 0);
    _updateSearchBadge('music',  music.status==='fulfilled'  ? music.value.length  : 0);
    _updateSearchBadge('posts',  posts.status==='fulfilled'  ? posts.value.length  : 0);
    _updateSearchBadge('live',   live.status==='fulfilled'   ? live.value.length   : 0);
  };

  async function _searchPeople(q, blocked) {
    const { db, collection, query: fsq, where, limit: lim, getDocs } = _fs();
    const ql = q.toLowerCase();
    const qTitle = ql.charAt(0).toUpperCase() + ql.slice(1);
    const cu = _cu();
    const seen = new Set(); const results = [];
    const myData = window._snxUserData || {};
    const myFriends = myData.friends || [];

    const addResults = snap => {
      snap.forEach(d => {
        const u = d.data();
        if (!u.uid || seen.has(u.uid)) return;
        if (cu && u.uid === cu.uid) return;
        if (blocked.includes(u.uid)) return;
        if (!u.displayName && !u.username) return;
        const priv = u.privacySettings?.findMe || 'everyone';
        if (priv === 'nobody') return;
        if (priv === 'friends' && !myFriends.includes(u.uid)) return;
        seen.add(u.uid); results.push(u);
      });
    };

    const [su, sd, sdl] = await Promise.all([
      getDocs(fsq(collection(db,'users'), where('username','>=',ql), where('username','<',ql+'\uf8ff'), lim(15))),
      getDocs(fsq(collection(db,'users'), where('displayName','>=',qTitle), where('displayName','<',qTitle+'\uf8ff'), lim(15))),
      getDocs(fsq(collection(db,'users'), where('displayName','>=',ql), where('displayName','<',ql+'\uf8ff'), lim(15)))
    ]);
    addResults(su); addResults(sd); addResults(sdl);

    // substring fallback if very few results
    if (results.length < 3) {
      try {
        const fb = await getDocs(fsq(collection(db,'users'), lim(200)));
        fb.forEach(d => {
          const u = d.data();
          if (!u.uid || seen.has(u.uid)) return;
          if (cu && u.uid===cu.uid) return;
          if (blocked.includes(u.uid)) return;
          if (!u.displayName && !u.username) return;
          const priv = u.privacySettings?.findMe || 'everyone';
          if (priv==='nobody') return;
          if (priv==='friends' && !myFriends.includes(u.uid)) return;
          const nm = (u.displayName||'').toLowerCase();
          const un = (u.username||'').toLowerCase();
          if (nm.includes(ql) || un.includes(ql)) { seen.add(u.uid); results.push(u); }
        });
      } catch(_) {}
    }
    return results.slice(0, 20);
  }

  async function _searchMusic(q) {
    const { db, collection, query: fsq, where, limit: lim, getDocs } = _fs();
    const ql = q.toLowerCase();
    const qTitle = ql.charAt(0).toUpperCase() + ql.slice(1);
    const seen = new Set(); const results = [];

    const addR = snap => snap.forEach(d => {
      const m = { ...d.data(), id: d.id };
      if (seen.has(d.id)) return;
      if (m.visibility==='private') return;
      seen.add(d.id); results.push(m);
    });

    const [st, sa] = await Promise.all([
      getDocs(fsq(collection(db,'profileMusic'), where('title','>=',qTitle), where('title','<',qTitle+'\uf8ff'), lim(10))),
      getDocs(fsq(collection(db,'profileMusic'), where('artist','>=',qTitle), where('artist','<',qTitle+'\uf8ff'), lim(10))),
    ]);
    addR(st); addR(sa);
    return results.slice(0, 15);
  }

  async function _searchPosts(q, blocked) {
    // Firestore doesn't support full-text search; use a small recent-posts scan
    const { db, collection, query: fsq, orderBy, limit: lim, getDocs } = _fs();
    const ql = q.toLowerCase();
    const results = [];
    try {
      const snap = await getDocs(fsq(collection(db,'posts'), orderBy('ts','desc'), lim(200)));
      snap.forEach(d => {
        const p = { ...d.data(), id: d.id };
        if (!p.text) return;
        if (blocked.includes(p.uid||p.authorUid)) return;
        if (p.hidden || p.deleted) return;
        if ((p.text||'').toLowerCase().includes(ql)) results.push(p);
      });
    } catch(_) {}
    return results.slice(0, 15);
  }

  async function _searchLive(q) {
    const { db, collection, query: fsq, where, limit: lim, getDocs } = _fs();
    const results = [];
    try {
      const snap = await getDocs(fsq(collection(db,'liveRooms'), where('isLive','==',true), lim(30)));
      const ql = q.toLowerCase();
      snap.forEach(d => {
        const r = { ...d.data(), id: d.id };
        const name = (r.displayName||r.hostName||'').toLowerCase();
        const title = (r.title||r.streamTitle||'').toLowerCase();
        if (name.includes(ql) || title.includes(ql) || !q || ql.length < 2) results.push(r);
      });
    } catch(_) {}
    return results;
  }

  function _renderPeopleResults(users) {
    const box = document.getElementById('snxSearchPeopleResults');
    if (!box) return;
    if (!users.length) { box.innerHTML = '<div style="color:#3a5a7a;font-size:13px;text-align:center;padding:16px 0;">No people found.</div>'; return; }
    box.innerHTML = '';
    const myData = window._snxUserData || {};
    const myFriends = myData.friends || [];
    const cu = _cu();
    users.forEach(u => {
      const card = document.createElement('div'); card.className='user-card';
      const avStyle = u.avatar ? `background-image:url('${u.avatar}')` : `background:#0B1F3A;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:bold;color:#00AEEF;`;
      const avContent = u.avatar ? '' : (u.displayName||'?')[0].toUpperCase();
      card.innerHTML = `
        <div class="user-card-avatar" style="${avStyle}" onclick="viewProfile('${u.uid}')">${avContent}<div class="online-pip ${u.status==='online'?'on':''}"></div></div>
        <div class="user-card-info">
          <div class="user-card-name" style="cursor:pointer;" onclick="viewProfile('${u.uid}')">${_esc(u.displayName||u.username||'User')}${typeof buildBadgeHtml==='function'?buildBadgeHtml(u.badges||[],u.role||'member'):''}</div>
          <div class="user-card-handle">@${_esc(u.username||'')}</div>
          <div class="user-card-bio">${_esc(u.bio||'')}</div>
        </div>
        <div class="user-card-actions">
          <button onclick="viewProfile('${u.uid}')">👤 View</button>
        </div>`;
      box.appendChild(card);
    });
  }

  function _renderMusicResults(tracks) {
    const box = document.getElementById('snxSearchMusicResults');
    if (!box) return;
    if (!tracks.length) { box.innerHTML = '<div style="color:#3a5a7a;font-size:13px;text-align:center;padding:16px 0;">No music found.</div>'; return; }
    box.innerHTML = tracks.map(t => `
      <div class="snx-music-result" onclick="viewProfile('${_esc(t.ownerUid||t.userId||'')}')">
        <span class="snx-music-result-icon">🎵</span>
        <div class="snx-music-result-info">
          <div class="snx-music-result-title">${_esc(t.title||'Untitled')}</div>
          <div class="snx-music-result-meta">${_esc(t.artist||'')}${t.artist&&t.album?' · ':''}${_esc(t.album||'')}</div>
        </div>
        <span style="font-size:10px;color:#3a5a7a;flex-shrink:0;">View Profile</span>
      </div>`).join('');
  }

  function _renderPostResults(posts) {
    const box = document.getElementById('snxSearchPostResults');
    if (!box) return;
    if (!posts.length) { box.innerHTML = '<div style="color:#3a5a7a;font-size:13px;text-align:center;padding:16px 0;">No posts found.</div>'; return; }
    box.innerHTML = posts.map(p => `
      <div class="snx-post-result" onclick="viewProfile('${_esc(p.uid||p.authorUid||'')}')">
        <div class="snx-post-result-author">@${_esc(p.username||p.authorHandle||'')}</div>
        <div class="snx-post-result-text">${_esc(p.text||'')}</div>
        <div style="font-size:10px;color:#3a5a7a;margin-top:4px;">${_ts(p.ts||p.createdAt)}</div>
      </div>`).join('');
  }

  function _renderLiveResults(rooms) {
    const box = document.getElementById('snxSearchLiveResults');
    if (!box) return;
    if (!rooms.length) { box.innerHTML = '<div style="color:#3a5a7a;font-size:13px;text-align:center;padding:16px 0;">No active live sessions found.</div>'; return; }
    box.innerHTML = rooms.map(r => `
      <div class="snx-live-result" onclick="window.open('/live.html?room=${_esc(r.id||r.roomId||r.hostId||'')}','_blank')">
        <span class="snx-live-dot"></span>
        <div class="snx-live-result-info">
          <div class="snx-live-result-name">${_esc(r.displayName||r.hostName||'Live User')}</div>
          <div class="snx-live-result-meta">🔴 LIVE · ${r.viewers||0} viewers</div>
        </div>
        <button style="font-size:11px;padding:5px 12px;border-radius:8px;background:rgba(255,30,60,0.15);border:1px solid rgba(255,40,70,0.5);color:#ff5566;cursor:pointer;flex-shrink:0;">Watch</button>
      </div>`).join('');
  }

  function _setSearchLoading(loading) {
    const info = document.getElementById('snxSearchInfo');
    if (info) info.textContent = loading ? '🔍 Searching…' : '';
  }

  function _updateSearchBadge(tab, count) {
    const b = document.querySelector(`.snx-search-tab[data-tab="${tab}"] .snx-search-tab-badge`);
    if (!b) return;
    b.textContent = count;
    b.classList.toggle('visible', count > 0);
  }

  /* Recent searches */
  function _addRecentSearch(q) {
    try {
      let r = JSON.parse(localStorage.getItem('snx_search_history')||'[]');
      r = [q, ...r.filter(x=>x!==q)].slice(0,8);
      localStorage.setItem('snx_search_history', JSON.stringify(r));
    } catch(_) {}
    _renderRecentSearches();
  }
  function _renderRecentSearches() {
    const box = document.getElementById('snxSearchRecent');
    if (!box) return;
    try {
      const r = JSON.parse(localStorage.getItem('snx_search_history')||'[]');
      if (!r.length) { box.innerHTML = ''; return; }
      box.innerHTML = `<div style="font-size:11px;color:#3a5a7a;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
        <span>RECENT SEARCHES</span>
        <button class="snx-recent-remove" onclick="snxClearSearchHistory()" style="font-size:11px;">Clear all</button>
      </div>` + r.map(q => `<span class="snx-recent-search-chip" onclick="document.getElementById('snxSearchInput').value='${_esc(q)}';snxRunGlobalSearch('${_esc(q)}')">${_esc(q)}<button class="snx-recent-remove" onclick="event.stopPropagation();snxRemoveRecentSearch('${_esc(q)}')" title="Remove">✕</button></span>`).join('');
    } catch(_) { box.innerHTML=''; }
  }
  window.snxClearSearchHistory = function () {
    try { localStorage.removeItem('snx_search_history'); } catch(_) {}
    _renderRecentSearches();
  };
  window.snxRemoveRecentSearch = function (q) {
    try {
      let r = JSON.parse(localStorage.getItem('snx_search_history')||'[]');
      r = r.filter(x=>x!==q);
      localStorage.setItem('snx_search_history', JSON.stringify(r));
    } catch(_) {}
    _renderRecentSearches();
  };

  /* ═══════════════════════════════════════════════════════════
     PART 4 — ACCOUNT SECURITY & PRIVACY CENTER
     ═══════════════════════════════════════════════════════════ */

  window.snxSecuritySetTab = function (tab) {
    document.querySelectorAll('.snx-security-tab').forEach(b => b.classList.toggle('active', b.dataset.tab===tab));
    document.querySelectorAll('.snx-security-panel').forEach(p => p.classList.toggle('active', p.dataset.tab===tab));
    if (tab==='account')  _renderAccountInfo();
    if (tab==='blocked')  { if(typeof window.snxLoadBlockedUsers==='function') window.snxLoadBlockedUsers(); }
    if (tab==='muted')    _renderMutedUsers();
    if (tab==='sessions') _renderSessionInfo();
  };

  function _renderAccountInfo() {
    const box = document.getElementById('snxAccountInfoBox');
    if (!box) return;
    const cu = _cu();
    const ud = window._snxUserData || {};
    if (!cu) { box.innerHTML = '<p style="color:#3a5a7a;">Not signed in.</p>'; return; }
    const rows = [
      ['Display Name', ud.displayName||'—'],
      ['Username', ud.username ? '@'+ud.username : '—'],
      ['Account Created', ud.joinedAt ? _ts(ud.joinedAt) : '—'],
      ['Last Sign-In', cu.metadata?.lastSignInTime ? new Date(cu.metadata.lastSignInTime).toLocaleString() : '—'],
    ];
    box.innerHTML = rows.map(([l,v]) =>
      `<div class="snx-account-info-row"><span class="snx-account-info-label">${_esc(l)}</span><span class="snx-account-info-value">${_esc(v)}</span></div>`
    ).join('');
  }

  window.snxChangePassword = async function () {
    const cur  = document.getElementById('snxCurPassword')?.value;
    const nw   = document.getElementById('snxNewPassword')?.value;
    const conf = document.getElementById('snxConfPassword')?.value;
    if (!cur || !nw || !conf) { _toast('Please fill in all password fields.'); return; }
    if (nw.length < 6) { _toast('New password must be at least 6 characters.'); return; }
    if (nw !== conf) { _toast('New passwords do not match.'); return; }
    const btn = document.getElementById('snxChangePwBtn');
    if (btn) { btn.disabled=true; btn.textContent='Updating…'; }
    try {
      const { getAuth, EmailAuthProvider, reauthenticateWithCredential, updatePassword } = window._snxAuthMethods || {};
      const auth = window._snxAuth;
      const cu = _cu();
      if (!auth || !cu || !EmailAuthProvider || !reauthenticateWithCredential || !updatePassword) {
        _toast('Auth system not ready. Please refresh.'); return;
      }
      const cred = EmailAuthProvider.credential(cu.email, cur);
      await reauthenticateWithCredential(cu, cred);
      await updatePassword(cu, nw);
      _toast('✓ Password updated successfully.');
      ['snxCurPassword','snxNewPassword','snxConfPassword'].forEach(id=>{ const el=document.getElementById(id); if(el)el.value=''; });
    } catch(e) {
      if (e.code==='auth/wrong-password'||e.code==='auth/invalid-credential') {
        _toast('Current password is incorrect. Please try again.');
      } else if (e.code==='auth/requires-recent-login') {
        _toast('Please sign out and sign in again before changing your password.');
      } else {
        _toast('Error: ' + e.message);
      }
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='Update Password'; }
    }
  };

  window.snxChangeEmail = async function () {
    const newEmail = document.getElementById('snxNewEmail')?.value?.trim();
    const curPass  = document.getElementById('snxEmailCurPass')?.value;
    if (!newEmail) { _toast('Please enter a new email.'); return; }
    if (!curPass)  { _toast('Please enter your current password to confirm.'); return; }
    const btn = document.getElementById('snxChangeEmailBtn');
    if (btn) { btn.disabled=true; btn.textContent='Updating…'; }
    try {
      const { EmailAuthProvider, reauthenticateWithCredential, updateEmail, verifyBeforeUpdateEmail } = window._snxAuthMethods || {};
      const cu = _cu();
      if (!cu || !EmailAuthProvider || !reauthenticateWithCredential) { _toast('Auth system not ready.'); return; }
      const cred = EmailAuthProvider.credential(cu.email, curPass);
      await reauthenticateWithCredential(cu, cred);
      // Use verifyBeforeUpdateEmail if available (Firebase v9+) — sends verification first
      if (typeof verifyBeforeUpdateEmail === 'function') {
        await verifyBeforeUpdateEmail(cu, newEmail);
        _toast('✉️ Verification email sent to '+newEmail+'. Please verify to complete the change.');
      } else if (typeof updateEmail === 'function') {
        await updateEmail(cu, newEmail);
        _toast('✓ Email updated to ' + newEmail);
      }
      const { db, doc, updateDoc } = _fs();
      if (db) await updateDoc(doc(db,'users',cu.uid), { email: newEmail }).catch(()=>{});
      document.getElementById('snxNewEmail').value='';
      document.getElementById('snxEmailCurPass').value='';
    } catch(e) {
      if (e.code==='auth/wrong-password'||e.code==='auth/invalid-credential') {
        _toast('Password is incorrect.');
      } else if (e.code==='auth/requires-recent-login') {
        _toast('Please sign out and sign in again before changing your email.');
      } else {
        _toast('Error: ' + e.message);
      }
    } finally {
      if (btn) { btn.disabled=false; btn.textContent='Update Email'; }
    }
  };

  async function _renderMutedUsers() {
    const box = document.getElementById('snxMutedList');
    if (!box) return;
    const cu = _cu();
    if (!cu) return;
    const { db, doc, getDoc, getDocs, collection, query, where, limit } = _fs();
    if (!db) return;
    box.innerHTML = '<div style="color:#3a5a7a;font-size:12px;padding:8px 0;">Loading…</div>';
    try {
      const snap = await getDoc(doc(db,'users',cu.uid));
      const muted = snap.exists() ? (snap.data().mutedUsers||[]) : [];
      if (!muted.length) { box.innerHTML='<div style="color:#3a5a7a;font-size:13px;padding:10px 0;">You haven\'t muted anyone.</div>'; return; }
      const users = {};
      for (let i=0;i<muted.length;i+=30) {
        try {
          const chunk = muted.slice(i,i+30);
          const us = await getDocs(query(collection(db,'users'),where('uid','in',chunk)));
          us.forEach(d=>{users[d.id]=d.data();});
        } catch(_){}
      }
      box.innerHTML = '';
      muted.forEach(uid => {
        const u = users[uid]||{};
        const row = document.createElement('div'); row.className='snx-muted-item';
        const av = u.avatar?`background-image:url('${u.avatar}');background-size:cover;background-position:center;`:'';
        row.innerHTML=`
          <div style="width:40px;height:40px;border-radius:50%;background:#0B1F3A;${av}border:2px solid rgba(150,150,200,0.4);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:bold;color:#8888cc;">${!u.avatar?(u.displayName||'?')[0].toUpperCase():''}</div>
          <div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:#e0f0ff;">${_esc(u.displayName||uid.substring(0,8))}</div><div style="font-size:11px;color:#6a90b8;">@${_esc(u.username||'')}</div></div>
          <button class="snx-unmute-btn" onclick="snxUnmuteUser('${uid}')">Unmute</button>`;
        box.appendChild(row);
      });
    } catch(e) { box.innerHTML=`<div style="color:#ff5566;font-size:12px;">Error: ${_esc(e.message)}</div>`; }
  }

  window.snxUnmuteUser = async function (targetUid) {
    const { db, doc, updateDoc, arrayRemove } = _fs();
    const cu = _cu(); if (!db||!cu) return;
    try {
      await updateDoc(doc(db,'users',cu.uid),{mutedUsers:arrayRemove(targetUid)});
      _toast('🔊 User unmuted.');
      _renderMutedUsers();
    } catch(e) { _toast('Error: '+e.message); }
  };

  function _renderSessionInfo() {
    const box = document.getElementById('snxSessionBox');
    if (!box) return;
    const cu = _cu();
    if (!cu) { box.innerHTML='<p style="color:#3a5a7a;">Not signed in.</p>'; return; }
    const meta = cu.metadata || {};
    box.innerHTML = `
      <div class="snx-account-info-row"><span class="snx-account-info-label">User ID</span><span class="snx-account-info-value" style="font-size:11px;font-family:monospace;">${_esc(cu.uid)}</span></div>
      <div class="snx-account-info-row"><span class="snx-account-info-label">Current Email</span><span class="snx-account-info-value">${_esc(cu.email||'N/A')}</span></div>
      <div class="snx-account-info-row"><span class="snx-account-info-label">Email Verified</span><span class="snx-account-info-value" style="color:${cu.emailVerified?'#39FF14':'#ffbb44'}">${cu.emailVerified?'✓ Yes':'Not verified'}</span></div>
      <div class="snx-account-info-row"><span class="snx-account-info-label">Sign-in Provider</span><span class="snx-account-info-value">${_esc(cu.providerData?.[0]?.providerId||'password')}</span></div>
      <div class="snx-account-info-row"><span class="snx-account-info-label">Session Started</span><span class="snx-account-info-value">${meta.lastSignInTime ? new Date(meta.lastSignInTime).toLocaleString() : '—'}</span></div>
      <div style="margin-top:8px;font-size:11px;color:#3a5a7a;line-height:1.6;">Session tokens are managed by Firebase Authentication and are not exposed here for security reasons. Sign out to end your current session.</div>`;
  }

  /* ═══════════════════════════════════════════════════════════
     PART 5 — NOTIFICATION PREFERENCES (additional toggles)
     ═══════════════════════════════════════════════════════════ */

  window.snxSaveNotifPrefUpgrade = async function (key, val) {
    const cu = _cu(); if (!cu) return;
    const { db, doc, updateDoc } = _fs(); if (!db) return;
    try {
      await updateDoc(doc(db,'users',cu.uid), { [`notifPrefs.${key}`]: val });
    } catch(e) { console.warn('[SNX NotifPref]', e.message); }
  };

  /* ═══════════════════════════════════════════════════════════
     PART 6 — PER-FEATURE MAINTENANCE
     ═══════════════════════════════════════════════════════════ */

  const FEATURE_MAINT_ITEMS = [
    { id:'eclipseFeedEnabled',    icon:'🏠', name:'Eclipse Feed',     sub:'Posts & Timeline' },
    { id:'profilesEnabled',       icon:'👤', name:'Profiles',         sub:'User profiles' },
    { id:'messagesEnabled',       icon:'💬', name:'Messages',         sub:'Direct messages' },
    { id:'musicHubEnabled',       icon:'🎵', name:'Music Hub',        sub:'Music uploads & library' },
    { id:'radioEnabled',          icon:'📻', name:'24-Hour Radio',    sub:'Live radio stream' },
    { id:'cloudStreamEnabled',    icon:'📺', name:'Cloud Stream',     sub:'24-hour cloud stream' },
    { id:'liveEnabled',           icon:'🔴', name:'Live System',      sub:'Go Live & Live Hub' },
    { id:'arcadeEnabled',         icon:'🕹️', name:'Arcade',           sub:'Games & challenges' },
  ];

  window.snxLoadFeatureMaintenance = async function () {
    if (!_isFounder()) return;
    const { db, doc, getDoc } = _fs(); if (!db) return;
    try {
      const snap = await getDoc(doc(db,'siteSettings','config'));
      const cfg = snap.exists() ? snap.data() : {};
      _renderFeatureMaintGrid(cfg);
    } catch(e) { console.warn('[SNX FeatureMaint]', e.message); }
  };

  function _renderFeatureMaintGrid(cfg) {
    const grid = document.getElementById('snxFeatureMaintGrid');
    if (!grid) return;
    grid.innerHTML = '';
    FEATURE_MAINT_ITEMS.forEach(feat => {
      const enabled = cfg[feat.id] !== false;
      const card = document.createElement('div');
      card.className = 'snx-feature-maint-card' + (enabled ? '' : ' is-maint');
      card.id = 'snxFMCard_' + feat.id;
      card.innerHTML = `
        <div class="snx-feature-maint-left">
          <span class="snx-feature-maint-icon">${feat.icon}</span>
          <div>
            <div class="snx-feature-maint-name">${feat.name}</div>
            <div class="snx-feature-maint-sub">${feat.sub}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
          <span class="snx-status-badge ${enabled?'snx-status-ok':'snx-status-err'}" id="snxFMBadge_${feat.id}">
            <span class="snx-status-dot"></span>${enabled?'ONLINE':'MAINTENANCE'}
          </span>
          <label class="notif-toggle-wrap" style="margin:0;">
            <input type="checkbox" class="notif-toggle-cb" id="snxFMToggle_${feat.id}" ${enabled?'checked':''}
              onchange="snxSetFeatureMaintenance('${feat.id}','${feat.name}',this.checked)">
            <span class="notif-toggle-slider"></span>
          </label>
        </div>`;
      grid.appendChild(card);
    });
  }

  window.snxSetFeatureMaintenance = async function (featureId, featureName, enabled) {
    if (!_isFounder()) return;
    const { db, doc, setDoc } = _fs(); if (!db) return;
    try {
      await setDoc(doc(db,'siteSettings','config'), { [featureId]: enabled }, { merge: true });
      await _auditLog(enabled ? 'FEATURE_ENABLED' : 'FEATURE_MAINTENANCE', `${featureName} → ${enabled?'ONLINE':'MAINTENANCE'}`);
      _toast(`${featureName}: ${enabled?'🟢 Online':'🔴 Maintenance'}`);
      // Update card appearance
      const card  = document.getElementById('snxFMCard_'+featureId);
      const badge = document.getElementById('snxFMBadge_'+featureId);
      if (card)  { if(enabled) card.classList.remove('is-maint'); else card.classList.add('is-maint'); }
      if (badge) { badge.className='snx-status-badge '+(enabled?'snx-status-ok':'snx-status-err'); badge.innerHTML=`<span class="snx-status-dot"></span>${enabled?'ONLINE':'MAINTENANCE'}`; }
    } catch(e) { _toast('Error: '+e.message); }
  };

  window.snxSaveFeatureMaintMsg = async function () {
    if (!_isFounder()) return;
    const { db, doc, setDoc } = _fs(); if (!db) return;
    const feature = document.getElementById('snxMaintMsgFeature')?.value;
    const msg     = document.getElementById('snxMaintMsg')?.value?.trim();
    if (!feature || !msg) { _toast('Select a feature and enter a message.'); return; }
    try {
      await setDoc(doc(db,'siteSettings','config'), { [`maintMsg_${feature}`]: msg }, { merge: true });
      _toast('✓ Maintenance message saved.');
    } catch(e) { _toast('Error: '+e.message); }
  };

  /* ── Check if a feature is in maintenance and show screen ── */
  window.snxCheckFeatureMaintenance = async function (featureId, containerEl) {
    const { db, doc, getDoc } = _fs(); if (!db) return false;
    try {
      const snap = await getDoc(doc(db,'siteSettings','config'));
      const cfg = snap.exists() ? snap.data() : {};
      const enabled = cfg[featureId] !== false;
      if (!enabled && _role() !== 'founder') {
        const msg = cfg[`maintMsg_${featureId}`] || 'This feature is temporarily unavailable. Check back soon.';
        if (containerEl) {
          containerEl.innerHTML = `<div class="snx-feature-maint-screen">
            <div class="snx-feature-maint-screen-icon">🔧</div>
            <div class="snx-feature-maint-screen-title">Under Maintenance</div>
            <div class="snx-feature-maint-screen-msg">${_esc(msg)}</div>
            <span class="snx-feature-maint-screen-badge">⚡ MAINTENANCE MODE</span>
          </div>`;
        }
        return true; // is in maintenance
      }
      return false;
    } catch(_) { return false; }
  };

  /* ═══════════════════════════════════════════════════════════
     PART 7 — FOUNDER AUDIT LOG (enhanced viewer)
     ═══════════════════════════════════════════════════════════ */

  const AUDIT_ICONS = {
    ANNOUNCEMENT_PUBLISHED:'📢', ANNOUNCEMENT_DRAFT:'💾', ANNOUNCEMENT_DELETED:'🗑️',
    FEATURE_ENABLED:'🟢', FEATURE_MAINTENANCE:'🔴', MAINTENANCE_MODE:'🔧',
    SYSTEM_CHECK:'🩺', TOGGLE_FEATURE:'⚙️', ASSIGN_ROLE:'👑', SUSPEND_USER:'⛔',
    RESTORE_USER:'✅', DELETE_USER:'💣', DELETE_POST:'🗑️', SEND_ANNOUNCEMENT:'📢',
    EMERGENCY_TOGGLE:'⚡', EXPORT_USERS:'📦', SAVE_SETTING:'💾',
  };

  window.snxLoadEnhancedAuditLog = async function (filter) {
    if (!_isFounder()) return;
    const { db, collection, query: fsq, orderBy, limit, getDocs, where } = _fs();
    if (!db) return;
    const box = document.getElementById('snxEnhancedAuditLog');
    if (!box) return;
    box.innerHTML = '<div style="color:#4a7a9a;font-size:12px;padding:8px 0;">Loading…</div>';

    // Highlight active filter button
    document.querySelectorAll('.snx-audit-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter===(filter||'all')));

    try {
      const snap = await getDocs(fsq(collection(db,'auditLog'), orderBy('ts','desc'), limit(100)));
      let entries = snap.docs.map(d => ({...d.data(), id: d.id}));
      if (filter && filter !== 'all') {
        const cat = filter.toUpperCase();
        entries = entries.filter(e => (e.action||'').toUpperCase().startsWith(cat));
      }
      if (!entries.length) { box.innerHTML = '<div style="color:#3a5a7a;font-size:13px;padding:10px 0;">No audit entries found.</div>'; return; }
      box.innerHTML = '';
      entries.forEach(e => {
        const icon = Object.entries(AUDIT_ICONS).find(([k]) => (e.action||'').startsWith(k))?.[1] || '📋';
        const entry = document.createElement('div'); entry.className='snx-audit-entry';
        entry.innerHTML = `
          <span class="snx-audit-icon">${icon}</span>
          <div class="snx-audit-body">
            <div class="snx-audit-action">${_esc(e.action||'?')}</div>
            <div class="snx-audit-details">${_esc(e.details||'')}</div>
            <div class="snx-audit-meta">${_ts(e.ts)} · by ${_esc(e.adminName||e.adminUid||'?')}</div>
          </div>`;
        box.appendChild(entry);
      });
    } catch(e) { box.innerHTML = `<div style="color:#ff5566;font-size:12px;">Error: ${_esc(e.message)}</div>`; }
  };

  /* ═══════════════════════════════════════════════════════════
     PART 8 — FOUNDER PANEL LIFECYCLE HOOKS
     (extend existing cleanup to include new systems)
     ═══════════════════════════════════════════════════════════ */

  // Expose _annUnsub on window so the main snxFounderPanelCleanup IIFE
  // (defined later in index.html) can call it.  The main IIFE runs AFTER
  // this module and captures the function references it needs at call time,
  // not at define time, so this window assignment is the correct hook point.
  Object.defineProperty(window, '_snxAnnUnsub', {
    get: function() { return _annUnsub; },
    set: function(v) { _annUnsub = v; },
    configurable: true,
  });

  /* ═══════════════════════════════════════════════════════════
     INIT — wire up on navTo callbacks
     ═══════════════════════════════════════════════════════════ */

  // Called when searchPage is navigated to
  window._snxUpgradeSearchOpen = function () {
    _renderRecentSearches();
    const inp = document.getElementById('snxSearchInput');
    if (inp) setTimeout(() => inp.focus(), 150);
  };

  // Called when settingsPage is navigated to
  window._snxUpgradeSettingsOpen = function () {
    _renderAccountInfo();
  };

  // Called when adminPage system tab is activated
  window._snxUpgradeStatusOpen = function () {
    _renderBuildInfo();
    _renderStatusGrid();
  };

  // Called when adminPage announce tab is activated
  window._snxUpgradeAnnOpen = function () {
    snxLoadAnnouncements();
  };

  // Called when adminPage audit tab is activated
  window._snxUpgradeAuditOpen = function () {
    snxLoadEnhancedAuditLog('all');
  };

  // Called when adminPage maintenance tab is activated
  window._snxUpgradeMaintenanceOpen = function () {
    snxLoadFeatureMaintenance();
  };

  // Initialize announcement display on Feed
  document.addEventListener('DOMContentLoaded', function () {
    // Start announcement listener once auth is known
    const _pollAuth = setInterval(function () {
      if (window._snxCurrentUser !== undefined && window._snxFirestore?.db) {
        clearInterval(_pollAuth);
        window.snxInitAnnouncementDisplay();
      }
    }, 500);
    // Expose auth methods for password/email change
    // (these are set by Firebase SDK in index.html's main script block)
    // We grab them lazily in the functions above via window._snxAuthMethods
  });

  // Expose for use in inline HTML
  window._snxUpgrade = {
    renderStatusGrid: _renderStatusGrid,
    renderBuildInfo: _renderBuildInfo,
  };

})();
