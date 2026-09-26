/**
 * nexus-intro.js  v2
 * Shadow Nexus Social — Cinematic Welcome Experience + Founder Music System
 *
 * Self-contained. Reads Firestore /siteSettings/welcomeConfig (public read)
 * for music/screen config. All music writes are Founder-only (enforced by
 * Firestore rules + Firebase token verification).
 *
 * Does NOT touch auth, feed, inbox, or any existing SNS module.
 */

(function () {
    'use strict';

    // ── Constants ────────────────────────────────────────────────────────────
    var SESSION_KEY     = 'snxIntroDone';
    var WELCOME_DOC     = 'welcomeConfig';   // /siteSettings/welcomeConfig
    var DEFAULT_VOLUME  = 0.45;

    // ── State ─────────────────────────────────────────────────────────────────
    var _cfg              = null;   // welcomeConfig from Firestore
    var _audio            = null;   // HTMLAudioElement
    var _muted            = false;  // visitor mute state
    var _audioStarted     = false;  // whether audio has ever been started
    var _overlay          = null;   // the overlay DOM element
    var _exiting          = false;  // guard against double-exit
    var _founderPreviewActive = false; // true ONLY while snxwmPreviewFullIntro is running

    // ── Session helpers ───────────────────────────────────────────────────────
    function _shouldShow() {
        if (sessionStorage.getItem('snxIntroReplay') === '1') {
            sessionStorage.removeItem('snxIntroReplay');
            return true;
        }
        return !sessionStorage.getItem(SESSION_KEY);
    }

    // ── Public API ────────────────────────────────────────────────────────────
    window.replayNexusIntro = function () {
        sessionStorage.setItem('snxIntroReplay', '1');
        sessionStorage.removeItem(SESSION_KEY);
        var old = document.getElementById('snxIntroOverlay');
        if (old) old.remove();
        _stopAudio();
        _exiting = false;
        _buildAndRun();
    };

    // Called by index.html — no-op here, auth flow already handles navigation
    window.snxIntroCompleted = function () {};

    // ── SVG inlines (no external requests) ───────────────────────────────────
    function _wolfSVG() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 110" fill="#000" aria-hidden="true">' +
            '<path d="M10,105C10,105 0,85 8,70C14,58 28,55 28,55L18,38C18,38 28,44 36,42C44,40 46,30 52,26C58,22 68,28 68,28L62,10C62,10 72,20 78,20C84,20 90,12 90,12L88,30C88,30 98,22 110,24C122,26 130,36 134,44C138,52 136,60 140,64C144,68 158,68 166,72C174,76 180,88 180,88L188,76C188,76 194,90 190,100C186,110 170,110 170,110L140,110C140,110 136,96 130,92C124,88 114,90 108,90C102,90 96,96 92,100C88,104 82,110 82,110L52,110C52,110 44,104 38,100C32,96 26,98 22,102C18,106 10,105 10,105Z"/>' +
            '<path d="M170,110C178,90 200,82 198,70C196,58 188,62 182,68" stroke="#000" stroke-width="4" fill="none"/>' +
            '</svg>';
    }
    function _catSVG() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 70" fill="#000" aria-hidden="true">' +
            '<ellipse cx="60" cy="45" rx="38" ry="18"/>' +
            '<circle cx="28" cy="30" r="15"/>' +
            '<polygon points="18,18 14,4 26,16"/>' +
            '<polygon points="32,18 38,4 26,16"/>' +
            '<path d="M98,45Q118,30 112,14" stroke="#000" stroke-width="5" fill="none" stroke-linecap="round"/>' +
            '<rect x="22" y="56" width="8" height="12" rx="3"/>' +
            '<rect x="34" y="56" width="8" height="12" rx="3"/>' +
            '<rect x="64" y="56" width="8" height="12" rx="3"/>' +
            '<rect x="76" y="56" width="8" height="12" rx="3"/>' +
            '</svg>';
    }
    function _crowSVG() {
        return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 28" fill="#000" aria-hidden="true">' +
            '<ellipse cx="32" cy="18" rx="14" ry="6"/>' +
            '<path d="M18,18Q4,4 0,8Q8,12 18,18Z"/>' +
            '<path d="M46,18Q60,4 64,8Q56,12 46,18Z"/>' +
            '<circle cx="20" cy="15" r="5"/>' +
            '<path d="M16,14L8,12L16,16Z"/>' +
            '</svg>';
    }

    // ── Build overlay HTML ────────────────────────────────────────────────────
    function _buildOverlay() {
        var el = document.createElement('div');
        el.id = 'snxIntroOverlay';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-label', 'Shadow Nexus Social cinematic welcome');

        el.innerHTML =
            // Atmospheric blue glow (emerges slowly)
            '<div id="snxIntroGlow" aria-hidden="true"></div>' +
            '<div id="snxIntroStars" aria-hidden="true"></div>' +
            // Lightning (6 bolts for depth) + environmental glow
            '<div id="snxIntroLightning" aria-hidden="true">' +
            '<div class="snxi-bolt"></div><div class="snxi-bolt"></div>' +
            '<div class="snxi-bolt"></div><div class="snxi-bolt"></div>' +
            '<div class="snxi-bolt"></div><div class="snxi-bolt"></div>' +
            '</div>' +
            '<div id="snxIntroLightGlow" aria-hidden="true"></div>' +
            // Fog (4 layers: background, midground, foreground, high-depth)
            '<div id="snxIntroFog" aria-hidden="true">' +
            '<div class="snxi-fog"></div><div class="snxi-fog"></div>' +
            '<div class="snxi-fog"></div><div class="snxi-fog"></div>' +
            '</div>' +
            // Portal (5 rings: 4 rings + 1 particle ring + core)
            '<div id="snxIntroPortal" aria-hidden="true">' +
            '<div class="snxi-pring"></div><div class="snxi-pring"></div>' +
            '<div class="snxi-pring"></div><div class="snxi-pring"></div>' +
            '<div class="snxi-pring"></div>' +
            '<div class="snxi-pcore"></div>' +
            '</div>' +
            // Forest
            '<div id="snxIntroForest" aria-hidden="true">' +
            Array(11).fill('<div class="snxi-tree"></div>').join('') +
            '</div>' +
            // Wolf
            '<div id="snxIntroWolf" aria-hidden="true">' + _wolfSVG() + '</div>' +
            // Crows
            '<div id="snxIntroCrows" aria-hidden="true"></div>' +
            // Cat
            '<div id="snxIntroCat" aria-hidden="true">' + _catSVG() + '</div>' +
            // Flames + ground glow
            '<div id="snxIntroFlames" aria-hidden="true">' +
            Array(10).fill('<div class="snxi-flame"></div>').join('') +
            '</div>' +
            '<div id="snxIntroFlameGlow" aria-hidden="true"></div>' +
            // Blue energy burst (enter transition layer)
            '<div id="snxIntroEnergy" aria-hidden="true"></div>' +
            // Title (welcome-to animates in separately before main title)
            '<div id="snxIntroTitle">' +
            '<div class="snxi-welcome-to">Welcome to</div>' +
            '<div class="snxi-main-title">SHADOW <span class="snxi-accent">NEXUS</span> SOCIAL</div>' +
            '<div class="snxi-tagline">Stay Legendary</div>' +
            '</div>' +
            // Now Playing (populated when config loads)
            '<div id="snxIntroNowPlaying" aria-live="polite" aria-label="Now Playing">' +
            '<div class="snxi-np-art" id="snxiNpArt">♪</div>' +
            '<div class="snxi-np-info">' +
            '<div class="snxi-np-label">♫ Now Playing</div>' +
            '<div class="snxi-np-title" id="snxiNpTitle">—</div>' +
            '<div class="snxi-np-artist" id="snxiNpArtist">—</div>' +
            '</div>' +
            '</div>' +
            // Button group
            '<div id="snxIntroBtns">' +
            '<button id="snxIntroEnterBtn" type="button" aria-label="Enter the Nexus">ENTER THE NEXUS</button>' +
            '<button id="snxIntroStartMusicBtn" type="button" aria-label="Start welcome music">🔊 START MUSIC</button>' +
            '</div>' +
            // Sound + Skip
            '<button id="snxIntroSoundBtn" type="button" aria-pressed="true" aria-label="Mute welcome music">🔊 Sound</button>' +
            '<button id="snxIntroSkipBtn"  type="button" aria-label="Skip intro">Skip Intro ›</button>' +
            // Music unavailable
            '<div id="snxIntroMusicStatus"></div>';

        return el;
    }

    function _injectCrows(container) {
        // Varied sizes, speeds, paths — some far, some closer to foreground
        var data = [
            {top:'11%', dur:'17s', delay:'2s',   size:'28px'},   // distant, fast
            {top:'18%', dur:'22s', delay:'6s',   size:'34px'},   // mid
            {top:'8%',  dur:'15s', delay:'10s',  size:'22px'},   // very distant
            {top:'22%', dur:'20s', delay:'14s',  size:'38px'},   // closer
            {top:'13%', dur:'25s', delay:'3.5s', size:'26px'},   // slow, distant
            {top:'6%',  dur:'18s', delay:'19s',  size:'20px'},   // very far
        ];
        // On mobile only show 3 crows to save performance
        var maxCrows = (window.innerWidth < 640) ? 3 : data.length;
        for (var i = 0; i < maxCrows; i++) {
            var c = data[i];
            var d = document.createElement('div');
            d.className = 'snxi-crow';
            d.style.setProperty('--cy', c.top);
            d.style.setProperty('--cdur', c.dur);
            d.style.setProperty('--cdelay', c.delay);
            d.style.setProperty('--csz', c.size);
            d.innerHTML = _crowSVG();
            container.appendChild(d);
        }
    }

    // ── Audio helpers ─────────────────────────────────────────────────────────
    function _stopAudio() {
        if (_audio) {
            try { _audio.pause(); _audio.src=''; } catch(_) {}
            _audio = null;
        }
        _audioStarted = false;
    }

    function _setVolume(vol) {
        if (_audio) {
            try { _audio.volume = Math.max(0, Math.min(1, vol)); } catch(_) {}
        }
    }

    function _startAudio() {
        if (_audioStarted || !_cfg || !_cfg.audioUrl || _muted) return;
        if (!_audio) return;
        _audioStarted = true;
        _audio.play().then(function(){
            var btn = document.getElementById('snxIntroStartMusicBtn');
            if (btn) btn.style.display = 'none';
            var status = document.getElementById('snxIntroMusicStatus');
            if (status) status.textContent = '';
        }).catch(function(e){
            _audioStarted = false;
            // Autoplay blocked — show START MUSIC button
            var btn = document.getElementById('snxIntroStartMusicBtn');
            if (btn) { btn.style.display = ''; btn.style.animationDelay = '0s'; }
            var status = document.getElementById('snxIntroMusicStatus');
            if (status && e.name === 'NotAllowedError') status.textContent = '';
        });
    }

    function _setupAudio(url, volume, loop) {
        _stopAudio();
        if (!url) return;
        _audio = new Audio();
        _audio.preload = 'none'; // Don't block visual
        _audio.loop    = loop !== false;
        _audio.volume  = Math.max(0, Math.min(1, volume != null ? volume : DEFAULT_VOLUME));
        _audio.src     = url;
        _audio.load();
        // Try autoplay after a tiny delay (lets visuals render first)
        setTimeout(_startAudio, 800);
    }

    function _fadeOutAudio(cb) {
        if (!_audio || _audio.paused) { if (cb) cb(); return; }
        var vol = _audio.volume;
        var steps = 20;
        var t = setInterval(function(){
            vol = Math.max(0, vol - vol / steps);
            if (_audio) _audio.volume = vol;
            if (vol <= 0.01) {
                clearInterval(t);
                _stopAudio();
                if (cb) cb();
            }
        }, 60);
    }

    // ── Load welcome config from Firestore ────────────────────────────────────
    function _loadConfig(callback) {
        // Use the Firebase/Firestore instance the main app already has
        try {
            var _db = window._snxFirestoreDB || (typeof db !== 'undefined' ? db : null);
            var _fns = window._snxFirestoreFns; // set by main app in onAuthStateChanged
            if (!_db || !_fns) {
                // Firestore not ready yet — retry shortly
                setTimeout(function(){ _loadConfig(callback); }, 400);
                return;
            }
            _fns.getDoc(_fns.doc(_db, 'siteSettings', WELCOME_DOC)).then(function(snap){
                if (snap.exists()) {
                    _cfg = snap.data();
                } else {
                    _cfg = { screenEnabled: true, musicEnabled: false };
                }
                callback(_cfg);
            }).catch(function(){
                _cfg = { screenEnabled: true, musicEnabled: false };
                callback(_cfg);
            });
        } catch(e) {
            _cfg = { screenEnabled: true, musicEnabled: false };
            callback(_cfg);
        }
    }

    // ── Show Now Playing strip ────────────────────────────────────────────────
    function _showNowPlaying(cfg) {
        if (!cfg || !cfg.musicEnabled || !cfg.audioUrl || !cfg.showNowPlaying) return;
        var np = document.getElementById('snxIntroNowPlaying');
        var titleEl  = document.getElementById('snxiNpTitle');
        var artistEl = document.getElementById('snxiNpArtist');
        var artEl    = document.getElementById('snxiNpArt');
        if (!np) return;
        if (titleEl)  titleEl.textContent  = cfg.songTitle  || 'Unknown Title';
        if (artistEl) artistEl.textContent = cfg.songArtist || 'Unknown Artist';
        if (artEl && cfg.artUrl) {
            artEl.innerHTML = '<img src="' + cfg.artUrl + '" alt="Album art" loading="lazy">';
        }
        np.classList.add('snxi-np-visible');
    }

    // ── Exit sequence ─────────────────────────────────────────────────────────
    function _exit(fast) {
        if (_exiting) return;
        _exiting = true;
        sessionStorage.setItem(SESSION_KEY, '1');

        var ov = document.getElementById('snxIntroOverlay');
        if (!ov) { if (typeof window.snxIntroCompleted === 'function') window.snxIntroCompleted(); return; }

        if (fast) {
            _stopAudio();
            ov.classList.add('snxi-exit');
            setTimeout(function(){ ov.classList.add('snxi-gone'); if (typeof window.snxIntroCompleted==='function') window.snxIntroCompleted(); }, 1700);
            return;
        }

        // Cinematic exit — camera zooms into the portal:
        // 1. Portal expand
        var portal = document.getElementById('snxIntroPortal');
        if (portal) portal.classList.add('snxi-portal-expand');

        // 2. Flames react faster (portal is pulling energy)
        document.querySelectorAll('.snxi-flame').forEach(function(f){ f.classList.add('snxi-flame-react'); });

        // 3. Fog bursts outward (portal push)
        document.querySelectorAll('.snxi-fog').forEach(function(f){ f.classList.add('snxi-fog-expand'); });

        // 4. Title dissolves
        var title = document.getElementById('snxIntroTitle');
        if (title) title.classList.add('snxi-title-exit');

        // 5. Camera zoom — CSS scale on overlay
        setTimeout(function(){
            if (ov) ov.classList.add('snxi-enter-travel');
        }, 400);

        // 6. Blue energy burst fills screen
        var energy = document.getElementById('snxIntroEnergy');
        if (energy) {
            setTimeout(function(){ energy.classList.add('snxi-energy-burst'); }, 800);
        }

        // 7. Fade music
        _fadeOutAudio(function(){});

        // 8. Fade overlay
        setTimeout(function(){ ov.classList.add('snxi-exit'); }, 1000);

        // 9. Remove from DOM
        setTimeout(function(){
            ov.classList.add('snxi-gone');
            if (typeof window.snxIntroCompleted === 'function') window.snxIntroCompleted();
        }, 2800);
    }

    // ── Wire buttons ──────────────────────────────────────────────────────────
    function _wireButtons() {
        var enterBtn      = document.getElementById('snxIntroEnterBtn');
        var skipBtn       = document.getElementById('snxIntroSkipBtn');
        var soundBtn      = document.getElementById('snxIntroSoundBtn');
        var startMusicBtn = document.getElementById('snxIntroStartMusicBtn');

        function _onEnter() { _exit(false); }
        function _onSkip()  { _exit(true);  }

        if (enterBtn) {
            enterBtn.addEventListener('click', _onEnter);
            enterBtn.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); _onEnter(); } });
        }
        if (skipBtn) {
            skipBtn.addEventListener('click', _onSkip);
            skipBtn.addEventListener('keydown', function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); _onSkip(); } });
        }
        if (soundBtn) {
            soundBtn.addEventListener('click', function(){
                _muted = !_muted;
                if (_muted) {
                    if (_audio) _audio.volume = 0;
                    soundBtn.textContent = '🔇 Sound';
                    soundBtn.setAttribute('aria-pressed', 'false');
                } else {
                    var vol = (_cfg && _cfg.volume != null) ? _cfg.volume : DEFAULT_VOLUME;
                    if (_audio) _audio.volume = vol;
                    soundBtn.textContent = '🔊 Sound';
                    soundBtn.setAttribute('aria-pressed', 'true');
                    if (!_audioStarted) _startAudio();
                }
            });
        }
        if (startMusicBtn) {
            startMusicBtn.addEventListener('click', function(){
                _muted = false;
                if (_audio && !_audioStarted) {
                    _audioStarted = true;
                    _audio.play().then(function(){
                        startMusicBtn.style.display='none';
                        var sb=document.getElementById('snxIntroSoundBtn');
                        if(sb){sb.textContent='🔊 Sound';sb.setAttribute('aria-pressed','true');}
                    }).catch(function(){});
                }
            });
        }

        // Escape = skip
        document.addEventListener('keydown', function _esc(e){
            if(e.key==='Escape'){ document.removeEventListener('keydown',_esc); _onSkip(); }
        });

        // Focus trap
        var ov = document.getElementById('snxIntroOverlay');
        if (ov) {
            ov.addEventListener('keydown', function(e){
                if(e.key!=='Tab') return;
                var els = Array.from(ov.querySelectorAll('button,[tabindex]:not([tabindex="-1"])')).filter(function(el){return !el.disabled&&el.offsetParent!==null;});
                if(!els.length) return;
                var first=els[0], last=els[els.length-1];
                if(e.shiftKey){ if(document.activeElement===first){last.focus();e.preventDefault();} }
                else          { if(document.activeElement===last){first.focus();e.preventDefault();} }
            });
        }
        // Default focus
        setTimeout(function(){ var s=document.getElementById('snxIntroSkipBtn'); if(s) s.focus(); }, 80);
    }

    // ── Main build + run ──────────────────────────────────────────────────────
    function _buildAndRun() {
        _overlay = _buildOverlay();
        document.body.insertBefore(_overlay, document.body.firstChild);
        _injectCrows(document.getElementById('snxIntroCrows'));
        _wireButtons();

        // Load config; show music info when ready
        _loadConfig(function(cfg){
            if (!cfg) return;
            // If welcome screen is disabled by Founder, exit immediately
            if (cfg.screenEnabled === false) { _exit(true); return; }
            // Show Now Playing strip
            _showNowPlaying(cfg);
            // Start music
            if (cfg.musicEnabled && cfg.audioUrl) {
                var vol = (cfg.volume != null) ? cfg.volume : DEFAULT_VOLUME;
                _setupAudio(cfg.audioUrl, vol, cfg.loop !== false);
            }
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    function _init() {
        if (!_shouldShow()) return;
        _buildAndRun();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        _init();
    }


    /* ═══════════════════════════════════════════════════════════
       FOUNDER WELCOME MUSIC CONTROL CENTER
       All functions prefixed snxwm_ are Founder-only.
       Security is enforced by Firestore rules + Firebase token —
       these functions simply fail silently if the caller is not
       the authenticated Founder.
       ═══════════════════════════════════════════════════════════ */

    // Internal Firestore helpers — resolve lazily so we don't race with main app load
    function _db()  { return window._snxFirestoreDB  || (typeof db  !== 'undefined' ? db  : null); }
    function _fns() { return window._snxFirestoreFns || null; }
    function _auth(){ return (typeof auth !== 'undefined' ? auth : null); }
    function _docRef() {
        var fns = _fns(), database = _db();
        if (!fns || !database) return null;
        return fns.doc(database, 'siteSettings', WELCOME_DOC);
    }

    // Read latest config from Firestore
    async function _fetchConfig() {
        var ref = _docRef(), fns = _fns();
        if (!ref || !fns) throw new Error('Firestore not ready');
        var snap = await fns.getDoc(ref);
        return snap.exists() ? snap.data() : {};
    }

    // Write config (Founder-only — Firestore rules enforce this)
    async function _saveConfig(fields) {
        var ref = _docRef(), fns = _fns(), database = _db();
        if (!ref || !fns || !database) throw new Error('Firestore not ready');
        await fns.setDoc(ref, Object.assign({ updatedAt: Date.now() }, fields), { merge: true });
    }

    // Update the Founder Control Center UI
    function _refreshUI(cfg) {
        cfg = cfg || {};
        // Screen toggle
        var screenDot = document.getElementById('snxwmScreenDot');
        var screenLbl = document.getElementById('snxwmScreenLbl');
        if (screenDot) screenDot.className = 'snxwm-status-dot ' + (cfg.screenEnabled !== false ? 'on' : 'off');
        if (screenLbl) screenLbl.textContent = cfg.screenEnabled !== false ? 'Enabled' : 'Disabled';

        // Music toggle
        var musicDot = document.getElementById('snxwmMusicDot');
        var musicLbl = document.getElementById('snxwmMusicLbl');
        if (musicDot) musicDot.className = 'snxwm-status-dot ' + (cfg.musicEnabled ? 'on' : 'off');
        if (musicLbl) musicLbl.textContent = cfg.musicEnabled ? 'Enabled' : 'Disabled';

        // Song info
        var artEl    = document.getElementById('snxwmArtEl');
        var titleEl  = document.getElementById('snxwmTitleEl');
        var artistEl = document.getElementById('snxwmArtistEl');
        var metaEl   = document.getElementById('snxwmMetaEl');
        if (cfg.audioUrl) {
            if (artEl)    { if (cfg.artUrl) artEl.innerHTML='<img src="'+cfg.artUrl+'" alt="Art">'; else artEl.textContent='♪'; }
            if (titleEl)  titleEl.textContent  = cfg.songTitle  || 'Untitled';
            if (artistEl) artistEl.textContent = cfg.songArtist || 'Unknown Artist';
            if (metaEl)   metaEl.textContent   = cfg.fileName ? '📁 ' + cfg.fileName : '';
        } else {
            if (artEl)    artEl.textContent    = '♪';
            if (titleEl)  titleEl.textContent  = 'No song uploaded';
            if (artistEl) artistEl.textContent = '';
            if (metaEl)   metaEl.textContent   = '';
        }

        // Volume
        var volSlider = document.getElementById('snxwmVolSlider');
        var volVal    = document.getElementById('snxwmVolVal');
        if (volSlider) { volSlider.value = Math.round((cfg.volume != null ? cfg.volume : DEFAULT_VOLUME) * 100); }
        if (volVal)    { volVal.textContent = Math.round((cfg.volume != null ? cfg.volume : DEFAULT_VOLUME) * 100) + '%'; }

        // Loop
        var loopDot = document.getElementById('snxwmLoopDot');
        var loopLbl = document.getElementById('snxwmLoopLbl');
        if (loopDot) loopDot.className = 'snxwm-status-dot ' + (cfg.loop !== false ? 'on' : 'off');
        if (loopLbl) loopLbl.textContent = cfg.loop !== false ? 'On' : 'Off';

        // Now Playing
        var npDot = document.getElementById('snxwmNpDot');
        var npLbl = document.getElementById('snxwmNpLbl');
        if (npDot) npDot.className = 'snxwm-status-dot ' + (cfg.showNowPlaying !== false ? 'on' : 'off');
        if (npLbl) npLbl.textContent = cfg.showNowPlaying !== false ? 'Showing' : 'Hidden';
    }

    // Open/refresh the Welcome Music tab
    window.snxwmOpen = async function () {
        try {
            var cfg = await _fetchConfig();
            _refreshUI(cfg);
        } catch(e) { console.warn('[SNX Welcome Music] load error:', e.message); }
    };

    // Toggle Welcome Screen on/off
    window.snxwmToggleScreen = async function (enabled) {
        try {
            await _saveConfig({ screenEnabled: enabled });
            _refreshUI(await _fetchConfig());
            if (typeof toastNotification === 'function') toastNotification(enabled ? '✅ Welcome Screen enabled.' : '⛔ Welcome Screen disabled.');
        } catch(e) { if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message); }
    };

    // Toggle music on/off
    window.snxwmToggleMusic = async function (enabled) {
        try {
            await _saveConfig({ musicEnabled: enabled });
            _refreshUI(await _fetchConfig());
            if (typeof toastNotification === 'function') toastNotification(enabled ? '🎵 Welcome music enabled.' : '🔇 Welcome music disabled.');
        } catch(e) { if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message); }
    };

    // Toggle loop
    window.snxwmToggleLoop = async function (on) {
        try {
            await _saveConfig({ loop: on });
            _refreshUI(await _fetchConfig());
            if (typeof toastNotification === 'function') toastNotification(on ? '🔁 Loop enabled.' : '▶ Loop disabled.');
        } catch(e) { if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message); }
    };

    // Toggle Now Playing strip
    window.snxwmToggleNowPlaying = async function (on) {
        try {
            await _saveConfig({ showNowPlaying: on });
            _refreshUI(await _fetchConfig());
            if (typeof toastNotification === 'function') toastNotification(on ? '🎵 Now Playing visible.' : 'Now Playing hidden.');
        } catch(e) { if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message); }
    };

    // Save volume
    window.snxwmSaveVolume = async function (pct) {
        try {
            var vol = Math.max(0, Math.min(1, pct / 100));
            await _saveConfig({ volume: vol });
            var vv = document.getElementById('snxwmVolVal');
            if (vv) vv.textContent = pct + '%';
        } catch(e) { console.warn('[SNX WM] volume save:', e.message); }
    };

    // Save song metadata (title/artist)
    window.snxwmSaveMeta = async function () {
        var title  = (document.getElementById('snxwmSongTitle')  || {}).value || '';
        var artist = (document.getElementById('snxwmSongArtist') || {}).value || '';
        if (!title && !artist) return;
        try {
            await _saveConfig({ songTitle: title.trim(), songArtist: artist.trim() });
            _refreshUI(await _fetchConfig());
            if (typeof toastNotification === 'function') toastNotification('✅ Song info saved.');
        } catch(e) { if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message); }
    };

    // Upload welcome song (uses existing uploadToR2)
    window.snxwmUploadSong = async function (input, replacing) {
        var file = input && input.files && input.files[0];
        if (!file) return;

        // Validate audio type
        var audioExts = ['mp3','m4a','aac','wav','ogg','flac','opus'];
        var ext = (file.name.split('.').pop() || '').toLowerCase();
        var isMimeAudio = file.type.startsWith('audio/') || file.type === 'application/octet-stream';
        var isExtAudio  = audioExts.includes(ext);
        if (!isMimeAudio && !isExtAudio) {
            if (typeof toastNotification === 'function') toastNotification('❌ Please select an audio file (MP3, M4A, WAV, OGG).');
            input.value = '';
            return;
        }

        // Show progress
        var progWrap = document.getElementById('snxwmProgressWrap');
        var progBar  = document.getElementById('snxwmProgressBar');
        if (progWrap) { progWrap.style.display = 'block'; }
        if (progBar)  { progBar.style.width = '0%'; }

        try {
            if (typeof uploadToR2 !== 'function') throw new Error('Upload service not available.');
            var url = await uploadToR2(file, 'snxwmProgressBar', 'snxwmProgressWrap', { mediaKind: 'music' });

            // Verify the file is accessible before making it live
            await new Promise(function(resolve, reject){
                var tmp = new Audio();
                tmp.src = url;
                tmp.oncanplaythrough = function(){ resolve(); try{tmp.src='';}catch(_){} };
                tmp.onerror = function(){ reject(new Error('Uploaded audio file is not playable.')); };
                setTimeout(function(){ resolve(); }, 6000); // 6-s grace period
            });

            // Optionally delete old file if replacing (best-effort, non-blocking)
            if (replacing) {
                try {
                    var oldCfg = await _fetchConfig();
                    if (oldCfg.r2Key && typeof uploadToR2 !== 'undefined') {
                        // Old R2 key deletion not exposed client-side; skip silently
                    }
                } catch(_) {}
            }

            var updates = {
                audioUrl:  url,
                fileName:  file.name,
                r2Key:     '',  // Stored by uploadToR2's own mediaFiles metadata
                musicEnabled: true,
            };
            // Prefill title/artist from filename if not already set
            var nameParts = file.name.replace(/\.[^.]+$/, '').split('-');
            if (nameParts.length >= 2) {
                updates.songArtist = nameParts[0].trim();
                updates.songTitle  = nameParts.slice(1).join('-').trim();
            } else {
                updates.songTitle = nameParts[0].trim();
            }
            await _saveConfig(updates);

            // Populate metadata fields in UI
            var titleInput  = document.getElementById('snxwmSongTitle');
            var artistInput = document.getElementById('snxwmSongArtist');
            if (titleInput  && !titleInput.value)  titleInput.value  = updates.songTitle  || '';
            if (artistInput && !artistInput.value) artistInput.value = updates.songArtist || '';

            _refreshUI(await _fetchConfig());
            if (typeof toastNotification === 'function') toastNotification('🎵 Welcome song uploaded and activated!');
        } catch(e) {
            if (typeof toastNotification === 'function') toastNotification('❌ Upload failed: ' + e.message);
        } finally {
            var progWrapFin = document.getElementById('snxwmProgressWrap');
            if (progWrapFin) progWrapFin.style.display = 'none';
            input.value = '';
        }
    };

    // Remove current song
    window.snxwmRemoveSong = async function () {
        if (typeof snxConfirm !== 'function') {
            if (!confirm('Remove the current Nexus Welcome song?')) return;
        } else {
            var ok = await snxConfirm({ title: 'Remove Welcome Song', body: 'Remove the current Nexus Welcome song?  The cinematic intro will continue without music.', confirmText: 'Remove Song', danger: true });
            if (!ok) return;
        }
        try {
            await _saveConfig({ audioUrl:'', fileName:'', songTitle:'', songArtist:'', artUrl:'', musicEnabled:false });
            _refreshUI(await _fetchConfig());
            if (typeof toastNotification === 'function') toastNotification('🗑 Welcome song removed.');
        } catch(e) { if (typeof toastNotification === 'function') toastNotification('❌ ' + e.message); }
    };

    // Preview audio in the Founder Control Center
    var _previewAudio = null;
    window.snxwmPreviewAudio = async function () {
        try {
            var cfg = await _fetchConfig();
            if (!cfg.audioUrl) { if (typeof toastNotification === 'function') toastNotification('No song uploaded.'); return; }
            if (_previewAudio) { _previewAudio.pause(); _previewAudio = null; }
            _previewAudio = new Audio(cfg.audioUrl);
            _previewAudio.volume = cfg.volume != null ? cfg.volume : DEFAULT_VOLUME;
            _previewAudio.play().catch(function(e){ if (typeof toastNotification === 'function') toastNotification('Preview blocked: ' + e.message); });
            var pbtn = document.getElementById('snxwmPreviewBtn');
            var ppbtn = document.getElementById('snxwmPauseBtn');
            if (pbtn)  pbtn.style.display  = 'none';
            if (ppbtn) ppbtn.style.display = '';
        } catch(e) { if (typeof toastNotification === 'function') toastNotification('❌ Preview error: ' + e.message); }
    };
    window.snxwmPausePreview = function () {
        if (_previewAudio) { _previewAudio.pause(); _previewAudio = null; }
        var pbtn = document.getElementById('snxwmPreviewBtn');
        var ppbtn = document.getElementById('snxwmPauseBtn');
        if (pbtn)  pbtn.style.display  = '';
        if (ppbtn) ppbtn.style.display = 'none';
    };

    // Founder full intro preview — launches cinematic WITHOUT resetting session key.
    // The preview overlay is injected at document.body (position:fixed) and removed
    // when the Founder exits (Enter/Skip) OR when snxwmCleanup is called on navigation.
    window.snxwmPreviewFullIntro = function () {
        // Stop any existing preview overlay or cinematic audio first
        window.snxwmPausePreview();
        var old = document.getElementById('snxIntroOverlay');
        if (old) old.remove();
        _stopAudio();
        _exiting = false;
        _founderPreviewActive = true;  // mark: a Founder-preview overlay is now live

        var ov = _buildOverlay();
        document.body.insertBefore(ov, document.body.firstChild);
        _injectCrows(document.getElementById('snxIntroCrows'));

        // Wire buttons — override _exit so it:
        //  1. Does NOT set the session key (not a real "done")
        //  2. Returns the Founder to the Founder Control Center ONLY if we're
        //     still on the adminPage (prevents spurious back-navigation after cleanup)
        var _previewExiting = false;

        // Escape key listener reference kept so snxwmCleanup can remove it
        var _escPreviewHandler = null;

        function _previewExit(fast) {
            if (_previewExiting) return;
            _previewExiting = true;
            _founderPreviewActive = false; // preview is ending
            // Remove the Escape key listener so it cannot fire after navigation
            if (_escPreviewHandler) {
                document.removeEventListener('keydown', _escPreviewHandler);
                _escPreviewHandler = null;
            }
            // Stop audio started by the preview
            _stopAudio();
            var ov2 = document.getElementById('snxIntroOverlay');
            // Only navigate back to adminPage if it is currently the active page.
            // This prevents _previewExit (triggered by keyboard/cleanup) from
            // navigating the Founder back to adminPage after they have already
            // moved to another page.
            var _adminIsActive = (function() {
                var ap = document.getElementById('adminPage');
                return !!(ap && ap.classList.contains('active'));
            })();
            if (!ov2) {
                if (_adminIsActive && typeof navTo === 'function') navTo('adminPage');
                return;
            }
            if (fast) {
                ov2.style.transition = 'opacity 0.3s';
                ov2.style.opacity = '0';
                setTimeout(function(){
                    if (ov2.parentNode) ov2.parentNode.removeChild(ov2);
                    if (_adminIsActive && typeof navTo === 'function') navTo('adminPage');
                }, 320);
            } else {
                ov2.style.transition = 'opacity 0.8s';
                ov2.style.opacity = '0';
                setTimeout(function(){
                    if (ov2.parentNode) ov2.parentNode.removeChild(ov2);
                    if (_adminIsActive && typeof navTo === 'function') navTo('adminPage');
                }, 850);
            }
        }

        // Wire buttons manually (bypass _wireButtons which uses the global _exit)
        var enterBtn = document.getElementById('snxIntroEnterBtn');
        var skipBtn  = document.getElementById('snxIntroSkipBtn');
        var soundBtn = document.getElementById('snxIntroSoundBtn');
        var startBtn = document.getElementById('snxIntroStartMusicBtn');
        if (enterBtn) enterBtn.addEventListener('click', function(){ _previewExit(false); });
        if (skipBtn)  skipBtn.addEventListener('click',  function(){ _previewExit(true);  });
        if (soundBtn) {
            soundBtn.addEventListener('click', function(){
                _muted = !_muted;
                if (_audio) _audio.muted = _muted;
                soundBtn.textContent = _muted ? '🔇 Sound' : '🔊 Sound';
                soundBtn.setAttribute('aria-pressed', String(!_muted));
            });
        }
        if (startBtn) {
            startBtn.addEventListener('click', function(){
                if (!_audio || _audio.paused) {
                    _muted = false;
                    _startAudio();
                    startBtn.style.display = 'none';
                }
            });
        }
        // Escape key — store reference so snxwmCleanup can remove it on navigation
        _escPreviewHandler = function(e){
            if (e.key === 'Escape') { _previewExit(true); }
        };
        document.addEventListener('keydown', _escPreviewHandler);

        // Expose handler removal to snxwmCleanup (assigned below)
        window._snxwmCancelEscapeListener = function() {
            if (_escPreviewHandler) {
                document.removeEventListener('keydown', _escPreviewHandler);
                _escPreviewHandler = null;
            }
        };

        // Load music config and start audio for the preview
        _loadConfig(function(cfg){
            _showNowPlaying(cfg);
            if (cfg && cfg.musicEnabled && cfg.audioUrl) {
                _setupAudio(cfg.audioUrl, cfg.volume != null ? cfg.volume : DEFAULT_VOLUME, cfg.loop !== false);
            }
        });
    };

    // ── Cleanup hook — called by snxFounderPanelCleanup on navigation away ──
    window.snxwmCleanup = function () {
        // Cancel any live Escape-key listener from a running full-intro preview.
        // This prevents _previewExit from firing (and calling navTo('adminPage'))
        // after the Founder has already navigated to another page.
        if (typeof window._snxwmCancelEscapeListener === 'function') {
            try { window._snxwmCancelEscapeListener(); } catch(_) {}
            window._snxwmCancelEscapeListener = null;
        }
        // Stop preview audio (short clip played from the Current Song panel)
        if (_previewAudio) {
            try { _previewAudio.pause(); _previewAudio.src = ''; } catch(_) {}
            _previewAudio = null;
        }
        // Remove the Founder-preview overlay ONLY if a Founder preview is
        // actually running.  Do NOT touch the real visitor cinematic intro —
        // that has already been dismissed before the app became visible, and
        // a fresh _buildAndRun() overlay must NOT be destroyed by cleanup.
        if (_founderPreviewActive) {
            _founderPreviewActive = false;
            _stopAudio(); // stop preview cinematic audio
            var previewOv = document.getElementById('snxIntroOverlay');
            if (previewOv) {
                previewOv.style.display = 'none';
                if (previewOv.parentNode) previewOv.parentNode.removeChild(previewOv);
            }
            _exiting = false; // allow a future preview to start clean
        }
        // Reset preview button states
        var pbtn  = document.getElementById('snxwmPreviewBtn');
        var ppbtn = document.getElementById('snxwmPauseBtn');
        if (pbtn)  pbtn.style.display  = '';
        if (ppbtn) ppbtn.style.display = 'none';
        // Hide progress bar
        var progWrap = document.getElementById('snxwmProgressWrap');
        if (progWrap) progWrap.style.display = 'none';
    };

})();
