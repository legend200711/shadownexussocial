/**
 * nexus-intro.js  v3
 * Shadow Nexus Social — Cinematic Welcome Experience + Founder Music System
 *
 * Self-contained. Reads Firestore /siteSettings/welcomeConfig (public read)
 * for music/screen config. All music writes are Founder-only (enforced by
 * Firestore rules + Firebase token verification).
 *
 * Does NOT touch auth, feed, inbox, or any existing SNS module.
 *
 * v3 changes:
 *  - Global single-init guard (window.__shadowNexusIntroStarted)
 *  - Mobile-safe exit: no scale/zoom transition on mobile, opacity-only fade
 *  - Mobile scroll restoration after exit
 *  - 100dvh / 100svh viewport support
 *  - Touch-safe button wiring (pointerup, no double activation)
 *  - Exit timer cleanup
 *  - Lightweight mobile rendering mode (JS side)
 */

(function () {
    'use strict';

    // ── GLOBAL SINGLE-INIT GUARD ─────────────────────────────────────────────
    // Prevents duplicate initialization if this script is ever evaluated twice
    // (e.g. browser quirks, hot-reload in development, replay API, etc.)
    if (window.__shadowNexusIntroStarted) return;
    window.__shadowNexusIntroStarted = true;

    // ── Constants ────────────────────────────────────────────────────────────
    var WELCOME_DOC     = 'welcomeConfig';   // /siteSettings/welcomeConfig
    var DEFAULT_VOLUME  = 0.45;
    // Minimum time (ms) the intro must be visible before exiting.
    // Prevents the intro from flashing for only a fraction of a second
    // on very fast devices or cached loads.
    var MIN_DISPLAY_MS  = 2500;

    // ── State ─────────────────────────────────────────────────────────────────
    var _cfg              = null;   // welcomeConfig from Firestore
    var _audio            = null;   // HTMLAudioElement
    var _muted            = false;  // visitor mute state
    var _audioStarted     = false;  // whether audio has ever been started
    var _overlay          = null;   // the overlay DOM element
    var _exiting          = false;  // guard against double-exit
    var _exitTimers       = [];     // all exit-sequence setTimeout IDs (for cleanup)
    var _founderPreviewActive = false; // true ONLY while snxwmPreviewFullIntro is running
    // Timestamp when the intro was first shown — used to enforce MIN_DISPLAY_MS
    var _introStartTime   = Date.now();
    // Whether the user has pressed Enter/Skip — we hold here if app is not ready
    var _exitRequested    = false;
    var _exitFast         = false;

    // ── Mobile detection ──────────────────────────────────────────────────────
    var _isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
                    window.innerWidth < 768;

    // ── Session helpers ───────────────────────────────────────────────────────
    // Uses a window-scoped flag so the intro plays on every genuine new browser/PWA
    // session (window is always cleared on session end) but never replays during
    // normal SPA navigation within the same running session.
    function _shouldShow() {
        if (sessionStorage.getItem('snxIntroReplay') === '1') {
            sessionStorage.removeItem('snxIntroReplay');
            return true;
        }
        return !window.__snxIntroDoneThisSession;
    }

    // ── Public API ────────────────────────────────────────────────────────────
    window.replayNexusIntro = function () {
        sessionStorage.setItem('snxIntroReplay', '1');
        window.__snxIntroDoneThisSession = false;
        var old = document.getElementById('snxIntroOverlay');
        if (old) old.remove();
        _stopAudio();
        _exiting        = false;
        _exitRequested  = false;
        _exitFast       = false;
        _introStartTime = Date.now();
        _clearExitTimers();
        // Reset guard so replay works
        window.__shadowNexusIntroStarted = false;
        window.__shadowNexusIntroStarted = true; // re-set immediately
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

        // On mobile, mark the overlay so CSS can target it
        if (_isMobile) {
            el.setAttribute('data-snxi-mobile', 'true');
        }

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
            // Cat (hidden on mobile — saves compositing layers)
            '<div id="snxIntroCat" aria-hidden="true">' + (_isMobile ? '' : _catSVG()) + '</div>' +
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
        // On mobile only show 2 crows to save performance
        var maxCrows = _isMobile ? 2 : data.length;
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

    // ── Timer helpers ─────────────────────────────────────────────────────────
    function _addTimer(id) {
        _exitTimers.push(id);
        return id;
    }
    function _clearExitTimers() {
        for (var i = 0; i < _exitTimers.length; i++) {
            clearTimeout(_exitTimers[i]);
        }
        _exitTimers = [];
    }

    // ── Restore scroll after intro exits ──────────────────────────────────────
    function _restoreScroll() {
        document.body.style.overflow = '';
        document.body.style.overflowY = '';
        document.documentElement.style.overflow = '';
        document.documentElement.style.overflowY = '';
        document.body.classList.remove('intro-open', 'no-scroll', 'snxi-no-scroll');
        document.documentElement.classList.remove('intro-open', 'no-scroll', 'snxi-no-scroll');
    }

    // ── Exit sequence ─────────────────────────────────────────────────────────

    // Check whether the app is ready enough to allow the intro to exit.
    // "Ready" means Firebase auth has resolved at least once.
    function _isAppReady() {
        return window.__shadowNexusAppReady === true;
    }

    // Perform the actual cinematic exit sequence.
    // Called only when BOTH conditions are met:
    //   1. Minimum display time has elapsed
    //   2. window.__shadowNexusAppReady is true
    function _doExit(fast) {
        if (_exiting) return;
        _exiting = true;
        // Mark intro as played for this window/session lifetime.
        // window-scoped so it resets on every genuine new browser/PWA session.
        window.__snxIntroDoneThisSession = true;

        // Disable enter button immediately to prevent double-tap
        var enterBtn = document.getElementById('snxIntroEnterBtn');
        if (enterBtn) {
            enterBtn.disabled = true;
            enterBtn.setAttribute('aria-disabled', 'true');
            enterBtn.style.pointerEvents = 'none';
        }

        var ov = document.getElementById('snxIntroOverlay');
        if (!ov) {
            _restoreScroll();
            if (typeof window.snxIntroCompleted === 'function') window.snxIntroCompleted();
            return;
        }

        // Mark as exiting so CSS can respond
        ov.dataset.exiting = 'true';

        // ── MOBILE EXIT: lightweight opacity fade only (no scale, no zoom) ────
        if (_isMobile) {
            _stopAudio();

            // Energy glow flash then fade
            var energy = document.getElementById('snxIntroEnergy');
            if (energy) energy.classList.add('snxi-energy-burst');

            // Short delay then fade out
            _addTimer(setTimeout(function(){
                ov.classList.add('snxi-exit');
            }, 180));

            // Remove from DOM — mobile total: ~700ms
            _addTimer(setTimeout(function(){
                ov.style.visibility = 'hidden';
                ov.style.pointerEvents = 'none';
                if (ov.parentNode) ov.parentNode.removeChild(ov);
                _restoreScroll();
                if (typeof window.snxIntroCompleted === 'function') window.snxIntroCompleted();
            }, 700));

            return;
        }

        // ── DESKTOP EXIT: full cinematic sequence ─────────────────────────────
        if (fast) {
            _stopAudio();
            ov.classList.add('snxi-exit');
            _addTimer(setTimeout(function(){
                ov.classList.add('snxi-gone');
                _restoreScroll();
                if (typeof window.snxIntroCompleted==='function') window.snxIntroCompleted();
            }, 1700));
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

        // 5. Camera zoom — CSS scale on overlay (DESKTOP ONLY)
        _addTimer(setTimeout(function(){
            if (ov) ov.classList.add('snxi-enter-travel');
        }, 400));

        // 6. Blue energy burst fills screen
        var energyD = document.getElementById('snxIntroEnergy');
        if (energyD) {
            _addTimer(setTimeout(function(){ energyD.classList.add('snxi-energy-burst'); }, 800));
        }

        // 7. Fade music
        _fadeOutAudio(function(){});

        // 8. Fade overlay
        _addTimer(setTimeout(function(){ ov.classList.add('snxi-exit'); }, 1000));

        // 9. Remove from DOM
        _addTimer(setTimeout(function(){
            ov.classList.add('snxi-gone');
            _restoreScroll();
            if (typeof window.snxIntroCompleted === 'function') window.snxIntroCompleted();
        }, 2800));
    }

    // Public exit entry-point.
    // Enforces:
    //  - minimum display time (MIN_DISPLAY_MS) — prevents instant flash on fast devices
    //  - app readiness (window.__shadowNexusAppReady) — prevents exiting before auth resolves
    // If either condition is not met, the intro stays visible (no separate loading screen)
    // and the exit happens automatically once both conditions are satisfied.
    function _exit(fast) {
        if (_exiting) return;
        if (_exitRequested) return; // already waiting

        _exitRequested = true;
        _exitFast      = fast;

        // Disable enter button to prevent double-tap while waiting
        var enterBtn = document.getElementById('snxIntroEnterBtn');
        if (enterBtn) {
            enterBtn.disabled = true;
            enterBtn.setAttribute('aria-disabled', 'true');
            enterBtn.style.pointerEvents = 'none';
        }

        // Calculate how long the intro has been shown
        var elapsed   = Date.now() - _introStartTime;
        var remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);

        function _tryExit() {
            if (_exiting) return;
            if (!_isAppReady()) {
                // App not ready yet — register a one-time callback and wait.
                // The intro remains fully visible (no extra loading screen).
                window.__shadowNexusAppReadyCb = function() {
                    // App just became ready — attempt exit again on next tick
                    setTimeout(_tryExit, 0);
                };
                return;
            }
            // Both conditions met — perform the cinematic exit
            _doExit(_exitFast);
        }

        if (remaining > 0) {
            // Minimum display time not yet elapsed — wait for it
            _addTimer(setTimeout(_tryExit, remaining));
        } else {
            _tryExit();
        }
    }

    // ── Wire buttons ──────────────────────────────────────────────────────────
    function _wireButtons() {
        var enterBtn      = document.getElementById('snxIntroEnterBtn');
        var skipBtn       = document.getElementById('snxIntroSkipBtn');
        var soundBtn      = document.getElementById('snxIntroSoundBtn');
        var startMusicBtn = document.getElementById('snxIntroStartMusicBtn');

        // Single activation guard for pointer events
        var _enterFired = false;
        var _skipFired  = false;

        function _onEnter(e) {
            if (e) e.preventDefault();
            if (_enterFired || _exiting || _exitRequested) return;
            _enterFired = true;
            _exit(false);
        }
        function _onSkip(e) {
            if (e) e.preventDefault();
            if (_skipFired || _exiting || _exitRequested) return;
            _skipFired = true;
            _exit(true);
        }

        if (enterBtn) {
            // Use pointerup for unified mouse/touch — prevents double firing
            enterBtn.addEventListener('pointerup', _onEnter);
            enterBtn.addEventListener('keydown', function(e){
                if(e.key==='Enter'||e.key===' '){ e.preventDefault(); _onEnter(e); }
            });
            // Fallback click for browsers without Pointer Events
            enterBtn.addEventListener('click', function(e){
                // Only fire click if pointerup hasn't already fired
                if (!_enterFired) _onEnter(e);
            });
        }
        if (skipBtn) {
            skipBtn.addEventListener('pointerup', _onSkip);
            skipBtn.addEventListener('keydown', function(e){
                if(e.key==='Enter'||e.key===' '){ e.preventDefault(); _onSkip(e); }
            });
            skipBtn.addEventListener('click', function(e){
                if (!_skipFired) _onSkip(e);
            });
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

        // Escape = skip (desktop)
        var _escHandler = function(e){
            if(e.key==='Escape'){ document.removeEventListener('keydown', _escHandler); _onSkip(e); }
        };
        document.addEventListener('keydown', _escHandler);

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
        // Default focus — skip button (non-mobile) or enter button (mobile)
        setTimeout(function(){
            var focusTarget = _isMobile
                ? document.getElementById('snxIntroEnterBtn')
                : document.getElementById('snxIntroSkipBtn');
            if (focusTarget) focusTarget.focus();
        }, 80);
    }

    // ── Main build + run ──────────────────────────────────────────────────────
    function _buildAndRun() {
        // Extra guard: if overlay already exists in DOM, don't add another
        if (document.getElementById('snxIntroOverlay')) return;

        // Record the actual start time when the overlay is inserted
        _introStartTime = Date.now();

        _overlay = _buildOverlay();
        document.body.insertBefore(_overlay, document.body.firstChild);
        _injectCrows(document.getElementById('snxIntroCrows'));
        _wireButtons();

        // Load config; show music info when ready
        _loadConfig(function(cfg){
            if (!cfg) return;
            // If welcome screen is disabled by Founder, skip directly
            // (bypass app-readiness check — founder admin action)
            if (cfg.screenEnabled === false) { _doExit(true); return; }
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
        var d = _db(), f = _fns();
        if (!d || !f) return null;
        return f.doc(d, 'siteSettings', WELCOME_DOC);
    }

    async function _fetchConfig() {
        var ref = _docRef(), fns = _fns();
        if (!ref || !fns) return null;
        var snap = await fns.getDoc(ref);
        return snap.exists() ? snap.data() : {};
    }

    async function _saveConfig(fields) {
        var ref = _docRef(), fns = _fns();
        if (!ref || !fns) return;
        await fns.setDoc(ref, fields, { merge: true });
    }

    function _refreshUI(cfg) {
        var screenDot = document.getElementById('snxwmScreenDot');
        var screenLbl = document.getElementById('snxwmScreenLbl');
        var musicDot  = document.getElementById('snxwmMusicDot');
        var musicLbl  = document.getElementById('snxwmMusicLbl');
        var loopDot   = document.getElementById('snxwmLoopDot');
        var loopLbl   = document.getElementById('snxwmLoopLbl');
        var npDot     = document.getElementById('snxwmNpDot');
        var npLbl     = document.getElementById('snxwmNpLbl');
        var volEl     = document.getElementById('snxwmVolSlider');
        var volVal    = document.getElementById('snxwmVolVal');
        var artEl     = document.getElementById('snxwmArtThumb');
        var titleEl   = document.getElementById('snxwmSongTitle');
        var artistEl  = document.getElementById('snxwmSongArtist');
        var metaEl    = document.getElementById('snxwmSongMeta');
        var urlEl     = document.getElementById('snxwmSongUrl');

        function _dot(el, lbl, on, onText, offText) {
            if (!el || !lbl) return;
            el.className = 'snxwm-status-dot ' + (on ? 'on' : 'off');
            lbl.textContent = on ? onText : offText;
        }

        _dot(screenDot, screenLbl, cfg.screenEnabled !== false, 'Enabled', 'Disabled');
        _dot(musicDot,  musicLbl,  !!cfg.musicEnabled, 'Enabled', 'Disabled');
        _dot(loopDot,   loopLbl,   cfg.loop !== false,   'On',     'Off');
        _dot(npDot,     npLbl,     !!cfg.showNowPlaying, 'Shown',  'Hidden');

        var pct = Math.round((cfg.volume != null ? cfg.volume : DEFAULT_VOLUME) * 100);
        if (volEl)  volEl.value = pct;
        if (volVal) volVal.textContent = pct + '%';

        var hasArt = cfg.artUrl && cfg.artUrl.trim();
        if (artEl)    artEl.innerHTML = hasArt
            ? '<img src="'+ cfg.artUrl +'" alt="Art" style="width:100%;height:100%;object-fit:cover;border-radius:8px">'
            : '🎵';
        if (titleEl)  titleEl.textContent  = cfg.songTitle  || '—';
        if (artistEl) artistEl.textContent = cfg.songArtist || '—';
        var dur = cfg.durationSec ? Math.floor(cfg.durationSec/60)+':'+(cfg.durationSec%60<10?'0':'')+cfg.durationSec%60 : '';
        if (metaEl)   metaEl.textContent   = [cfg.fileSize ? (cfg.fileSize/1048576).toFixed(1)+' MB' : '', dur].filter(Boolean).join(' · ') || '—';
        if (urlEl)    urlEl.textContent    = cfg.audioUrl ? '✓ Audio file loaded' : '—';
    }

    window.snxwmOpen = async function () {
        var cfg = await _fetchConfig();
        if (!cfg) { alert('Firestore not ready — try again.'); return; }
        _refreshUI(cfg);
    };

    window.snxwmToggleScreen = async function (enabled) {
        await _saveConfig({ screenEnabled: !!enabled });
        var cfg = await _fetchConfig();
        if (cfg) { _cfg = cfg; _refreshUI(cfg); }
    };

    window.snxwmToggleMusic = async function (enabled) {
        await _saveConfig({ musicEnabled: !!enabled });
        var cfg = await _fetchConfig();
        if (cfg) { _cfg = cfg; _refreshUI(cfg); }
    };

    window.snxwmToggleLoop = async function (on) {
        await _saveConfig({ loop: !!on });
        if (_audio) _audio.loop = !!on;
        var cfg = await _fetchConfig();
        if (cfg) _refreshUI(cfg);
    };

    window.snxwmToggleNowPlaying = async function (on) {
        await _saveConfig({ showNowPlaying: !!on });
        var cfg = await _fetchConfig();
        if (cfg) _refreshUI(cfg);
    };

    window.snxwmSaveVolume = async function (pct) {
        var vol = Math.max(0, Math.min(100, parseInt(pct,10)||0)) / 100;
        await _saveConfig({ volume: vol });
        _setVolume(vol);
        var valEl = document.getElementById('snxwmVolVal');
        if (valEl) valEl.textContent = Math.round(vol*100) + '%';
    };

    window.snxwmSaveMeta = async function () {
        var titleEl  = document.getElementById('snxwmMetaTitle');
        var artistEl = document.getElementById('snxwmMetaArtist');
        var artUrlEl = document.getElementById('snxwmMetaArtUrl');
        var title  = titleEl  ? titleEl.value.trim()  : '';
        var artist = artistEl ? artistEl.value.trim() : '';
        var artUrl = artUrlEl ? artUrlEl.value.trim() : '';
        var fields = {};
        if (title)  fields.songTitle  = title;
        if (artist) fields.songArtist = artist;
        if (artUrl) fields.artUrl     = artUrl;
        if (!Object.keys(fields).length) { alert('Nothing to save.'); return; }
        await _saveConfig(fields);
        var cfg = await _fetchConfig();
        if (cfg) { _cfg = cfg; _refreshUI(cfg); }
        alert('Metadata saved!');
    };

    window.snxwmUploadSong = async function (input, replacing) {
        var file = input && input.files && input.files[0];
        if (!file) return;

        // Check the file is actually playable before uploading
        await new Promise(function(resolve, reject) {
            var tmp = new Audio();
            var objUrl = URL.createObjectURL(file);
            tmp.src = objUrl;
            tmp.oncanplaythrough = function(){ resolve(); try{tmp.src='';}catch(_){} URL.revokeObjectURL(objUrl); }
            tmp.onerror = function(){ reject(new Error('Uploaded audio file is not playable.')); URL.revokeObjectURL(objUrl); }
        });

        var a = _auth();
        var token = a && a.currentUser ? await a.currentUser.getIdToken() : null;
        if (!token) { alert('Not authenticated — cannot upload.'); return; }

        // Show progress UI
        var prog = document.getElementById('snxwmUploadProg');
        var bar  = document.getElementById('snxwmUploadBar');
        if (prog) prog.style.display = 'block';
        if (bar)  bar.style.width = '0%';

        var workerBase = 'https://yellow-term-11e6.nthntjrn.workers.dev';
        var chunkSize  = 20 * 1024 * 1024; // 20 MB
        var totalSize  = file.size;
        var audioUrl;

        if (replacing) {
            var oldCfg = await _fetchConfig();
            if (oldCfg && oldCfg.audioUrl) {
                var oldKey = oldCfg.audioUrl.split('/').slice(-2).join('/');
                try {
                    await fetch(workerBase + '/delete', {
                        method: 'DELETE',
                        headers: { 'Authorization': 'Bearer ' + token, 'X-Key': oldKey }
                    });
                } catch(_) {}
            }
        }

        if (totalSize <= chunkSize) {
            // Single upload
            var fd = new FormData();
            fd.append('file', file);
            fd.append('folder', 'welcome-music');
            var res = await fetch(workerBase + '/upload', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                body: fd
            });
            var json = await res.json();
            audioUrl = json.url || json.publicUrl;
        } else {
            // Chunked upload
            var uploadId = Date.now().toString(36) + Math.random().toString(36).slice(2);
            var totalChunks = Math.ceil(totalSize / chunkSize);
            for (var ci = 0; ci < totalChunks; ci++) {
                var start = ci * chunkSize;
                var end   = Math.min(start + chunkSize, totalSize);
                var chunk = file.slice(start, end);
                var cfd   = new FormData();
                cfd.append('chunk', chunk);
                cfd.append('uploadId',    uploadId);
                cfd.append('chunkIndex',  ci);
                cfd.append('totalChunks', totalChunks);
                cfd.append('filename',    file.name);
                cfd.append('folder',      'welcome-music');
                var cres = await fetch(workerBase + '/upload-chunk', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                    body: cfd
                });
                var cjson = await cres.json();
                if (bar) bar.style.width = Math.round(((ci+1)/totalChunks)*100) + '%';
                if (cjson.url || cjson.publicUrl) {
                    audioUrl = cjson.url || cjson.publicUrl;
                }
            }
        }

        if (bar)  bar.style.width = '100%';
        if (!audioUrl) { alert('Upload failed — no URL returned.'); if (prog) prog.style.display = 'none'; return; }

        var dur = 0;
        try {
            var tmpA = new Audio();
            tmpA.src = audioUrl;
            await new Promise(function(r){ tmpA.onloadedmetadata=function(){ dur=Math.round(tmpA.duration||0); try{tmpA.src='';}catch(_){} r(); }; setTimeout(r,4000); });
        } catch(_) {}

        var sizeLabel = totalSize < 1048576
            ? (totalSize/1024).toFixed(0)+' KB'
            : (totalSize/1048576).toFixed(1)+' MB';

        await _saveConfig({
            audioUrl:    audioUrl,
            fileSize:    totalSize,
            durationSec: dur,
            musicEnabled: true
        });

        if (prog) setTimeout(function(){ prog.style.display='none'; if(bar) bar.style.width='0%'; }, 1200);
        var cfg = await _fetchConfig();
        if (cfg) { _cfg = cfg; _refreshUI(cfg); }
        alert('Upload complete! ' + sizeLabel + (dur ? ' · ' + Math.floor(dur/60) + ':' + (dur%60<10?'0':'') + dur%60 : ''));
    };

    window.snxwmRemoveSong = async function () {
        var cfg = await _fetchConfig();
        if (!cfg || !cfg.audioUrl) { alert('No audio file to remove.'); return; }
        if (!confirm('Remove the current welcome song? This cannot be undone.')) return;

        var a = _auth();
        var token = a && a.currentUser ? await a.currentUser.getIdToken() : null;
        if (token) {
            var key = cfg.audioUrl.split('/').slice(-2).join('/');
            try {
                await fetch('https://yellow-term-11e6.nthntjrn.workers.dev/delete', {
                    method: 'DELETE',
                    headers: { 'Authorization': 'Bearer ' + token, 'X-Key': key }
                });
            } catch(_) {}
        }

        await _saveConfig({ audioUrl: '', fileSize: 0, durationSec: 0, musicEnabled: false });
        var updated = await _fetchConfig();
        if (updated) { _cfg = updated; _refreshUI(updated); }
        _stopAudio();
        alert('Song removed.');
    };

    window.snxwmPreviewAudio = async function () {
        var cfg = await _fetchConfig();
        if (!cfg || !cfg.audioUrl) { alert('No audio file configured.'); return; }
        _stopAudio();
        _audio = new Audio();
        _audio.src = cfg.audioUrl;
        _audio.volume = cfg.volume != null ? cfg.volume : DEFAULT_VOLUME;
        _audio.loop   = false;
        _audioStarted = false;
        _audio.play().then(function(){
            _audioStarted = true;
        }).catch(function(e){ alert('Preview failed: ' + e.message); });
    };

    window.snxwmPausePreview = function () {
        if (_audio && !_audio.paused) {
            _audio.pause();
        }
    };

    window.snxwmPreviewFullIntro = function () {
        if (_founderPreviewActive) return;
        _founderPreviewActive = true;

        // Remove any existing overlay
        var existing = document.getElementById('snxIntroOverlay');
        if (existing) existing.remove();

        _exiting = false;
        _clearExitTimers();
        var overlay = _buildOverlay();
        document.body.insertBefore(overlay, document.body.firstChild);
        _injectCrows(document.getElementById('snxIntroCrows'));

        // Wire skip button for preview
        var skipBtn  = document.getElementById('snxIntroSkipBtn');
        var enterBtn = document.getElementById('snxIntroEnterBtn');

        function _previewExit(fast) {
            if (overlay.dataset.exiting === 'true') return;
            overlay.dataset.exiting = 'true';

            // Clear any lingering escape listener
            if (window._snxwmCancelEscapeListener) {
                window._snxwmCancelEscapeListener();
                window._snxwmCancelEscapeListener = null;
            }

            _founderPreviewActive = false;

            if (_isMobile || fast) {
                // Mobile or fast skip: simple fade
                _stopAudio();
                overlay.classList.add('snxi-exit');
                setTimeout(function(){
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                    _restoreScroll();
                }, 700);
            } else {
                // Desktop: full cinematic
                var portal2 = document.getElementById('snxIntroPortal');
                if (portal2) portal2.classList.add('snxi-portal-expand');
                document.querySelectorAll('.snxi-flame').forEach(function(f){ f.classList.add('snxi-flame-react'); });
                document.querySelectorAll('.snxi-fog').forEach(function(f){ f.classList.add('snxi-fog-expand'); });
                var title2 = document.getElementById('snxIntroTitle');
                if (title2) title2.classList.add('snxi-title-exit');

                setTimeout(function(){ if (overlay && !overlay.dataset.removed) overlay.classList.add('snxi-enter-travel'); }, 400);
                var energy2 = document.getElementById('snxIntroEnergy');
                if (energy2) setTimeout(function(){ energy2.classList.add('snxi-energy-burst'); }, 800);
                _fadeOutAudio(function(){});
                setTimeout(function(){ overlay.classList.add('snxi-exit'); }, 1000);
                setTimeout(function(){
                    overlay.dataset.removed = 'true';
                    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
                    _restoreScroll();
                }, 2800);
            }
        }

        if (skipBtn)  skipBtn.addEventListener('pointerup',  function(e){ e.preventDefault(); _previewExit(true);  });
        if (skipBtn)  skipBtn.addEventListener('click', function(e){ _previewExit(true); });
        if (enterBtn) enterBtn.addEventListener('pointerup', function(e){ e.preventDefault(); _previewExit(false); });
        if (enterBtn) enterBtn.addEventListener('click', function(e){ _previewExit(false); });

        // ESC to exit preview
        var _escPreviewHandler = function(e) {
            if (e.key === 'Escape') {
                if (_escPreviewHandler) document.removeEventListener('keydown', _escPreviewHandler);
                _previewExit(true);
            }
        };
        document.addEventListener('keydown', _escPreviewHandler);

        window._snxwmCancelEscapeListener = function() {
            document.removeEventListener('keydown', _escPreviewHandler);
        };

        // Load config and start audio for preview
        _loadConfig(function(cfg) {
            if (!cfg) return;
            _showNowPlaying(cfg);
            if (cfg.musicEnabled && cfg.audioUrl) {
                var vol = (cfg.volume != null) ? cfg.volume : DEFAULT_VOLUME;
                _setupAudio(cfg.audioUrl, vol, cfg.loop !== false);
            }
        });
    };

    window.snxwmCleanup = function () {
        _stopAudio();
        _clearExitTimers();
        _founderPreviewActive = false;
        var ov = document.getElementById('snxIntroOverlay');
        if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
        _restoreScroll();
    };

}());
