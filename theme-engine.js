/**
 * Shadow Nexus Social — theme-engine.js
 * NEXUS GLOBAL THEME ENGINE
 *
 * Architecture:
 *   Firebase siteConfig/globalTheme  →  ThemeLoader
 *   →  ThemeValidator  →  TokenManager (CSS vars)
 *   →  Existing Shadow Nexus UI  +  Optional EffectsLayer
 *
 * Security:
 *   - Regular users: READ activeTheme only (via siteConfig/globalTheme & themes/)
 *   - Founder: WRITE all theme operations (enforced in Firestore rules)
 *   - No frontend-only access control — Firestore rules are the gate
 *
 * Usage:
 *   import { ThemeEngine } from './theme-engine.js';
 *   ThemeEngine.init(db, auth);   // called after Firebase init
 */

import {
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, addDoc, query, orderBy, limit, getDocs, onSnapshot,
  serverTimestamp, writeBatch, where
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

/* ═══════════════════════════════════════════════════════════════════
   §1  PREBUILT THEME DEFINITIONS
   Each entry is a full set of CSS variable values.
   The Founder can publish these instantly or use them as starting points.
   ═══════════════════════════════════════════════════════════════════ */
const PREBUILT_THEMES = {
  'shadow-nexus-default': {
    name: 'Shadow Nexus Default',
    description: 'The original dark electric identity. Neon blue & green.',
    swatch: '#0B1F3A',
    tokens: {
      '--theme-primary':      '#00AEEF',
      '--theme-secondary':    '#39FF14',
      '--theme-accent':       '#0066FF',
      '--theme-background':   '#0B1F3A',
      '--theme-surface':      '#0d2444',
      '--theme-card':         '#0d2444',
      '--theme-navbar':       '#071428',
      '--theme-menu':         '#050f1e',
      '--theme-input':        '#0a1c35',
      '--theme-text':         '#ffffff',
      '--theme-muted-text':   '#6a90b8',
      '--theme-button':       '#00AEEF',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#00AEEF',
      '--theme-border':       '#1a3a5c',
      '--theme-danger':       '#ff4455',
      '--theme-success':      '#39FF14',
      '--theme-warning':      '#ffaa00',
      '--theme-glow':         'rgba(0,174,239,0.40)',
      '--theme-shadow':       'rgba(0,0,0,0.80)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(0,0,0,0)',
    },
    effects: [],
    scrollbarColor: 'rgba(0,174,239,0.38)',
  },

  'halloween': {
    name: 'Halloween',
    description: 'Black, orange & dark purple. Fog and spooky atmosphere.',
    swatch: '#1a0a00',
    tokens: {
      '--theme-primary':      '#FF6600',
      '--theme-secondary':    '#9900cc',
      '--theme-accent':       '#ff8800',
      '--theme-background':   '#0d0500',
      '--theme-surface':      '#1a0800',
      '--theme-card':         '#200a00',
      '--theme-navbar':       '#0a0300',
      '--theme-menu':         '#070200',
      '--theme-input':        '#150600',
      '--theme-text':         '#ffd5aa',
      '--theme-muted-text':   '#885533',
      '--theme-button':       '#cc4400',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#FF6600',
      '--theme-border':       '#4d1a00',
      '--theme-danger':       '#ff2200',
      '--theme-success':      '#44bb00',
      '--theme-warning':      '#ff8800',
      '--theme-glow':         'rgba(255,100,0,0.45)',
      '--theme-shadow':       'rgba(0,0,0,0.90)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(30,0,0,0.30)',
    },
    effects: ['fog', 'leaves'],
    fogRgb: '60,20,0',
  },

  'haunted-midnight': {
    name: 'Haunted Midnight',
    description: 'Black, deep blue, purple. Moonlight and fog.',
    swatch: '#050318',
    tokens: {
      '--theme-primary':      '#8855ff',
      '--theme-secondary':    '#4488ff',
      '--theme-accent':       '#aa44dd',
      '--theme-background':   '#04021a',
      '--theme-surface':      '#0a0530',
      '--theme-card':         '#0c0635',
      '--theme-navbar':       '#030115',
      '--theme-menu':         '#020010',
      '--theme-input':        '#080428',
      '--theme-text':         '#ddd8ff',
      '--theme-muted-text':   '#6655aa',
      '--theme-button':       '#6633cc',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#9966ff',
      '--theme-border':       '#2a1566',
      '--theme-danger':       '#ff3366',
      '--theme-success':      '#44ffaa',
      '--theme-warning':      '#ffaa33',
      '--theme-glow':         'rgba(130,80,255,0.45)',
      '--theme-shadow':       'rgba(0,0,0,0.92)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(10,0,30,0.40)',
    },
    effects: ['fog', 'stars'],
    fogRgb: '20,10,60',
  },

  'christmas': {
    name: 'Christmas / Winter',
    description: 'Dark winter with green, red and snow.',
    swatch: '#051a08',
    tokens: {
      '--theme-primary':      '#00cc44',
      '--theme-secondary':    '#ff2222',
      '--theme-accent':       '#aaddff',
      '--theme-background':   '#040e06',
      '--theme-surface':      '#071a0c',
      '--theme-card':         '#091f10',
      '--theme-navbar':       '#030a04',
      '--theme-menu':         '#020603',
      '--theme-input':        '#051408',
      '--theme-text':         '#eeffee',
      '--theme-muted-text':   '#669966',
      '--theme-button':       '#00aa33',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#00dd55',
      '--theme-border':       '#1a4422',
      '--theme-danger':       '#ff2222',
      '--theme-success':      '#00cc44',
      '--theme-warning':      '#ffcc00',
      '--theme-glow':         'rgba(0,200,60,0.40)',
      '--theme-shadow':       'rgba(0,0,0,0.85)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(0,10,5,0.25)',
    },
    effects: ['snow'],
  },

  'new-year': {
    name: 'New Year',
    description: 'Black, gold, silver. Celebration confetti.',
    swatch: '#0d0800',
    tokens: {
      '--theme-primary':      '#ffd700',
      '--theme-secondary':    '#c0c0c0',
      '--theme-accent':       '#ffaa00',
      '--theme-background':   '#080500',
      '--theme-surface':      '#130c00',
      '--theme-card':         '#170e00',
      '--theme-navbar':       '#050300',
      '--theme-menu':         '#030200',
      '--theme-input':        '#100900',
      '--theme-text':         '#fffde8',
      '--theme-muted-text':   '#aa8833',
      '--theme-button':       '#cc9900',
      '--theme-button-text':  '#000000',
      '--theme-link':         '#ffd700',
      '--theme-border':       '#4d3800',
      '--theme-danger':       '#ff3333',
      '--theme-success':      '#00dd44',
      '--theme-warning':      '#ffcc00',
      '--theme-glow':         'rgba(255,215,0,0.45)',
      '--theme-shadow':       'rgba(0,0,0,0.88)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(10,6,0,0.30)',
    },
    effects: ['confetti', 'stars'],
  },

  'valentine': {
    name: "Valentine's",
    description: 'Black, deep red, pink. Floating hearts.',
    swatch: '#150008',
    tokens: {
      '--theme-primary':      '#ff2266',
      '--theme-secondary':    '#ff88aa',
      '--theme-accent':       '#dd0044',
      '--theme-background':   '#0e0005',
      '--theme-surface':      '#1a000c',
      '--theme-card':         '#200010',
      '--theme-navbar':       '#0a0003',
      '--theme-menu':         '#060002',
      '--theme-input':        '#140008',
      '--theme-text':         '#ffe8f0',
      '--theme-muted-text':   '#aa4466',
      '--theme-button':       '#cc0044',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#ff4488',
      '--theme-border':       '#550020',
      '--theme-danger':       '#ff0033',
      '--theme-success':      '#00cc88',
      '--theme-warning':      '#ffaa33',
      '--theme-glow':         'rgba(255,30,100,0.45)',
      '--theme-shadow':       'rgba(0,0,0,0.88)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(20,0,8,0.30)',
    },
    effects: ['hearts'],
  },

  'birthday': {
    name: 'Birthday / Celebration',
    description: 'Vibrant colors with confetti and balloons.',
    swatch: '#1a0030',
    tokens: {
      '--theme-primary':      '#ff44cc',
      '--theme-secondary':    '#ffdd00',
      '--theme-accent':       '#44ccff',
      '--theme-background':   '#0d001a',
      '--theme-surface':      '#180030',
      '--theme-card':         '#1e0038',
      '--theme-navbar':       '#090012',
      '--theme-menu':         '#05000a',
      '--theme-input':        '#130025',
      '--theme-text':         '#fff0ff',
      '--theme-muted-text':   '#9966cc',
      '--theme-button':       '#cc00aa',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#ff66dd',
      '--theme-border':       '#440066',
      '--theme-danger':       '#ff2255',
      '--theme-success':      '#44ff88',
      '--theme-warning':      '#ffcc00',
      '--theme-glow':         'rgba(255,60,200,0.45)',
      '--theme-shadow':       'rgba(0,0,0,0.85)',
      '--theme-radius':       '12px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(15,0,25,0.25)',
    },
    effects: ['confetti', 'stars'],
  },

  'blood-moon': {
    name: 'Blood Moon',
    description: 'Black, dark red, crimson glow. Moon atmosphere.',
    swatch: '#150000',
    tokens: {
      '--theme-primary':      '#cc0000',
      '--theme-secondary':    '#880000',
      '--theme-accent':       '#ff2200',
      '--theme-background':   '#0a0000',
      '--theme-surface':      '#180000',
      '--theme-card':         '#1e0000',
      '--theme-navbar':       '#060000',
      '--theme-menu':         '#040000',
      '--theme-input':        '#120000',
      '--theme-text':         '#ffcccc',
      '--theme-muted-text':   '#883333',
      '--theme-button':       '#990000',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#ff3333',
      '--theme-border':       '#440000',
      '--theme-danger':       '#ff0000',
      '--theme-success':      '#00cc44',
      '--theme-warning':      '#ff6600',
      '--theme-glow':         'rgba(200,0,0,0.50)',
      '--theme-shadow':       'rgba(0,0,0,0.92)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(20,0,0,0.40)',
    },
    effects: ['fog'],
    fogRgb: '80,0,0',
  },

  'purple-storm': {
    name: 'Purple Storm',
    description: 'Black, purple, electric violet. Lightning.',
    swatch: '#0d0020',
    tokens: {
      '--theme-primary':      '#aa00ff',
      '--theme-secondary':    '#7700cc',
      '--theme-accent':       '#dd44ff',
      '--theme-background':   '#080010',
      '--theme-surface':      '#120020',
      '--theme-card':         '#180028',
      '--theme-navbar':       '#05000c',
      '--theme-menu':         '#030008',
      '--theme-input':        '#0e0018',
      '--theme-text':         '#f0ddff',
      '--theme-muted-text':   '#7744aa',
      '--theme-button':       '#8800cc',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#cc44ff',
      '--theme-border':       '#3d0066',
      '--theme-danger':       '#ff2266',
      '--theme-success':      '#00ffaa',
      '--theme-warning':      '#ff9900',
      '--theme-glow':         'rgba(170,0,255,0.50)',
      '--theme-shadow':       'rgba(0,0,0,0.90)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(10,0,20,0.35)',
    },
    effects: ['lightning', 'cyber'],
    cyberColor: '#aa00ff',
  },

  'black-gold': {
    name: 'Black & Gold',
    description: 'Black with gold luxury glow.',
    swatch: '#0d0900',
    tokens: {
      '--theme-primary':      '#cc9900',
      '--theme-secondary':    '#ffdd44',
      '--theme-accent':       '#ffbb00',
      '--theme-background':   '#080600',
      '--theme-surface':      '#120d00',
      '--theme-card':         '#181100',
      '--theme-navbar':       '#050400',
      '--theme-menu':         '#030200',
      '--theme-input':        '#0e0a00',
      '--theme-text':         '#fff8e8',
      '--theme-muted-text':   '#996600',
      '--theme-button':       '#aa8800',
      '--theme-button-text':  '#000000',
      '--theme-link':         '#ffcc00',
      '--theme-border':       '#3d2c00',
      '--theme-danger':       '#ff3333',
      '--theme-success':      '#00cc44',
      '--theme-warning':      '#ffcc00',
      '--theme-glow':         'rgba(200,150,0,0.50)',
      '--theme-shadow':       'rgba(0,0,0,0.88)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(10,7,0,0.30)',
    },
    effects: ['stars'],
  },

  'fire-ice': {
    name: 'Fire & Ice',
    description: 'Dark background with blue ice and fire accents.',
    swatch: '#080d18',
    tokens: {
      '--theme-primary':      '#00aaff',
      '--theme-secondary':    '#ff6600',
      '--theme-accent':       '#0066cc',
      '--theme-background':   '#040810',
      '--theme-surface':      '#081018',
      '--theme-card':         '#0a1420',
      '--theme-navbar':       '#030608',
      '--theme-menu':         '#020405',
      '--theme-input':        '#060c14',
      '--theme-text':         '#e8f0ff',
      '--theme-muted-text':   '#4466aa',
      '--theme-button':       '#0088cc',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#33ccff',
      '--theme-border':       '#0d2244',
      '--theme-danger':       '#ff3300',
      '--theme-success':      '#00ffaa',
      '--theme-warning':      '#ff8800',
      '--theme-glow':         'rgba(0,160,255,0.40)',
      '--theme-shadow':       'rgba(0,0,0,0.88)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(0,5,15,0.30)',
    },
    effects: ['embers', 'snow'],
  },

  'blue-lightning': {
    name: 'Blue Lightning',
    description: 'Black and electric blue with lightning effects.',
    swatch: '#000d1a',
    tokens: {
      '--theme-primary':      '#0088ff',
      '--theme-secondary':    '#00ccff',
      '--theme-accent':       '#0044cc',
      '--theme-background':   '#000810',
      '--theme-surface':      '#000f1e',
      '--theme-card':         '#001228',
      '--theme-navbar':       '#00050c',
      '--theme-menu':         '#000308',
      '--theme-input':        '#000c18',
      '--theme-text':         '#ddeeff',
      '--theme-muted-text':   '#335588',
      '--theme-button':       '#0066dd',
      '--theme-button-text':  '#ffffff',
      '--theme-link':         '#33aaff',
      '--theme-border':       '#001a44',
      '--theme-danger':       '#ff3366',
      '--theme-success':      '#00ffcc',
      '--theme-warning':      '#ffaa00',
      '--theme-glow':         'rgba(0,130,255,0.50)',
      '--theme-shadow':       'rgba(0,0,0,0.90)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(0,5,15,0.35)',
    },
    effects: ['lightning'],
    lightningColor: 'rgba(0,150,255,0.12)',
  },

  'neon-green': {
    name: 'Neon Green',
    description: 'Black with neon green cyber effects.',
    swatch: '#001a00',
    tokens: {
      '--theme-primary':      '#00ff44',
      '--theme-secondary':    '#00cc33',
      '--theme-accent':       '#00ff88',
      '--theme-background':   '#000d00',
      '--theme-surface':      '#001500',
      '--theme-card':         '#001800',
      '--theme-navbar':       '#000800',
      '--theme-menu':         '#000500',
      '--theme-input':        '#001200',
      '--theme-text':         '#ddffdd',
      '--theme-muted-text':   '#336633',
      '--theme-button':       '#00cc33',
      '--theme-button-text':  '#000000',
      '--theme-link':         '#00ff55',
      '--theme-border':       '#005500',
      '--theme-danger':       '#ff3355',
      '--theme-success':      '#00ff44',
      '--theme-warning':      '#aaff00',
      '--theme-glow':         'rgba(0,255,60,0.50)',
      '--theme-shadow':       'rgba(0,0,0,0.90)',
      '--theme-radius':       '10px',
      '--theme-font':         "'Segoe UI', Arial, sans-serif",
      '--theme-bg-image':     'none',
      '--theme-bg-opacity':   '1',
      '--theme-bg-blur':      '0px',
      '--theme-bg-brightness':'1',
      '--theme-bg-overlay':   'rgba(0,10,0,0.35)',
    },
    effects: ['cyber'],
    cyberColor: '#00ff44',
  },
};

/* ═══════════════════════════════════════════════════════════════════
   §2  SHADOW NEXUS DEFAULT (failsafe constant)
   ═══════════════════════════════════════════════════════════════════ */
const DEFAULT_THEME = PREBUILT_THEMES['shadow-nexus-default'];

/* ═══════════════════════════════════════════════════════════════════
   §3  THEME ENGINE MODULE
   ═══════════════════════════════════════════════════════════════════ */
const ThemeEngine = (() => {

  let _db = null;
  let _auth = null;
  let _themeUnsubscribe = null;
  let _currentThemeId = 'shadow-nexus-default';
  let _previewMode = false;
  let _previewThemeData = null;
  let _effectsTimers = [];
  let _effectsElements = [];
  let _bannerCountdownTimer = null;
  let _initialized = false;

  /* ── DOM element references (created once) ── */
  let _bgEl = null, _overlayEl = null, _veilEl = null, _effectsEl = null;
  let _bannerEl = null, _previewBarEl = null;

  /* ────────────────────────────────────────────────────────────────
     3.1  INITIALIZATION
  ──────────────────────────────────────────────────────────────── */
  function init(db, auth) {
    if (_initialized) return;
    _initialized = true;
    _db = db;
    _auth = auth;

    _createDomLayers();
    _loadActiveTheme();
    _startLiveListener();
  }

  function _createDomLayers() {
    // Background image layer
    _bgEl = document.getElementById('snx-theme-bg');
    if (!_bgEl) {
      _bgEl = document.createElement('div');
      _bgEl.id = 'snx-theme-bg';
      document.body.prepend(_bgEl);
    }
    // Dark overlay
    _overlayEl = document.getElementById('snx-theme-overlay');
    if (!_overlayEl) {
      _overlayEl = document.createElement('div');
      _overlayEl.id = 'snx-theme-overlay';
      document.body.prepend(_overlayEl);
    }
    // Transition veil
    _veilEl = document.getElementById('snx-theme-veil');
    if (!_veilEl) {
      _veilEl = document.createElement('div');
      _veilEl.id = 'snx-theme-veil';
      document.body.appendChild(_veilEl);
    }
    // Effects layer
    _effectsEl = document.getElementById('snx-effects-layer');
    if (!_effectsEl) {
      _effectsEl = document.createElement('div');
      _effectsEl.id = 'snx-effects-layer';
      document.body.appendChild(_effectsEl);
    }
    // Event banner
    _bannerEl = document.getElementById('snx-event-banner');
    if (!_bannerEl) {
      _bannerEl = document.createElement('div');
      _bannerEl.id = 'snx-event-banner';
      _bannerEl.className = 'hidden';
      _bannerEl.innerHTML = '<span class="banner-text"></span><div class="banner-countdown"></div>';
      document.body.appendChild(_bannerEl);
    }
    // Preview bar (Founder-only)
    _previewBarEl = document.getElementById('snx-preview-bar');
    if (!_previewBarEl) {
      _previewBarEl = document.createElement('div');
      _previewBarEl.id = 'snx-preview-bar';
      _previewBarEl.style.display = 'none';
      _previewBarEl.innerHTML = `
        <div>
          <div class="preview-label">🎨 Founder Theme Preview</div>
          <div class="preview-theme-name" id="snxPreviewThemeName"></div>
        </div>
        <div class="preview-actions">
          <button class="snx-preview-btn publish" onclick="window.ThemeEngine_publishPreview&&window.ThemeEngine_publishPreview()">Publish Globally</button>
          <button class="snx-preview-btn edit" onclick="window.ThemeEngine_openEditor&&window.ThemeEngine_openEditor()">Continue Editing</button>
          <button class="snx-preview-btn exit" onclick="window.ThemeEngine_exitPreview&&window.ThemeEngine_exitPreview()">Exit Preview</button>
        </div>`;
      document.body.appendChild(_previewBarEl);
    }
  }

  /* ────────────────────────────────────────────────────────────────
     3.2  LOAD ACTIVE THEME FROM FIRESTORE
     Reads siteConfig/globalTheme → fetches theme doc → applies tokens.
     Falls back to Shadow Nexus Default on any error.
  ──────────────────────────────────────────────────────────────── */
  async function _loadActiveTheme() {
    try {
      const cfgSnap = await getDoc(doc(_db, 'siteConfig', 'globalTheme'));
      if (!cfgSnap.exists()) {
        _applyTheme(DEFAULT_THEME, 'shadow-nexus-default');
        return;
      }
      const cfg = cfgSnap.data();

      // Check for scheduled theme override
      const scheduled = await _resolveScheduledTheme(cfg);
      const themeId = scheduled || cfg.activeThemeId || 'shadow-nexus-default';
      _currentThemeId = themeId;

      await _fetchAndApplyTheme(themeId, cfg);
    } catch (err) {
      console.warn('[ThemeEngine] Load failed — applying default:', err.message);
      _applyTheme(DEFAULT_THEME, 'shadow-nexus-default');
    }
  }

  async function _fetchAndApplyTheme(themeId, cfg) {
    try {
      // Check built-in presets first
      if (PREBUILT_THEMES[themeId]) {
        const preset = PREBUILT_THEMES[themeId];
        // Override tokens from globalTheme config if Founder customised it
        const merged = _mergeConfig(preset, cfg);
        _applyTheme(merged, themeId);
        return;
      }
      // Custom theme — fetch from Firestore
      const snap = await getDoc(doc(_db, 'themes', themeId));
      if (!snap.exists()) {
        console.warn('[ThemeEngine] Theme doc missing:', themeId, '— using default');
        _applyTheme(DEFAULT_THEME, 'shadow-nexus-default');
        return;
      }
      const themeData = snap.data();
      _applyTheme(_validateTheme(themeData), themeId);
    } catch (err) {
      console.warn('[ThemeEngine] fetchAndApply failed:', err.message);
      _applyTheme(DEFAULT_THEME, 'shadow-nexus-default');
    }
  }

  /* ────────────────────────────────────────────────────────────────
     3.3  LIVE REALTIME LISTENER
     Watches siteConfig/globalTheme for changes published by the Founder.
     When version increments, smoothly transitions to the new theme.
  ──────────────────────────────────────────────────────────────── */
  function _startLiveListener() {
    if (!_db) return;
    if (_themeUnsubscribe) _themeUnsubscribe();

    _themeUnsubscribe = onSnapshot(
      doc(_db, 'siteConfig', 'globalTheme'),
      async (snap) => {
        if (!snap.exists()) return;
        const cfg = snap.data();
        if (!cfg.activeThemeId) return;

        // Skip if this is the Founder's own private preview
        if (_previewMode && window._snxRole === 'founder') return;

        const newId = cfg.activeThemeId;
        if (newId === _currentThemeId && cfg.version === _appliedVersion) return;

        _currentThemeId = newId;
        _appliedVersion = cfg.version;

        // Smooth transition
        await _smoothTransition(async () => {
          await _fetchAndApplyTheme(newId, cfg);
        });

        // Apply event banner if set
        _applyBanner(cfg);
      },
      (err) => { console.warn('[ThemeEngine] Live listener error:', err.message); }
    );
  }

  let _appliedVersion = null;

  /* ────────────────────────────────────────────────────────────────
     3.4  APPLY THEME — sets all CSS variables on :root
  ──────────────────────────────────────────────────────────────── */
  function _applyTheme(themeData, themeId) {
    const tokens = themeData.tokens || {};
    const root = document.documentElement;

    // Apply each CSS token
    for (const [prop, val] of Object.entries(tokens)) {
      if (prop.startsWith('--theme-') && _isValidCSSValue(prop, val)) {
        root.style.setProperty(prop, val);
      }
    }

    // Apply background image if present
    const bgImage = themeData.backgroundImageUrl || themeData.tokens?.['--theme-bg-image'] || 'none';
    if (bgImage && bgImage !== 'none') {
      root.style.setProperty('--theme-bg-image', `url('${bgImage}')`);
      if (_bgEl) _bgEl.style.backgroundImage = `url('${bgImage}')`;
    } else {
      root.style.setProperty('--theme-bg-image', 'none');
      if (_bgEl) _bgEl.style.backgroundImage = 'none';
    }

    // Apply font
    const font = tokens['--theme-font'];
    if (font) document.body.style.fontFamily = font;

    // Effects
    _clearEffects();
    const effects = themeData.effects || [];
    _startEffects(effects, themeData);

    // Scrollbar color
    if (themeData.scrollbarColor) {
      _updateScrollbarColor(themeData.scrollbarColor);
    }

    // Store last applied
    window._snxActiveTheme = { id: themeId, data: themeData };
  }

  function _isValidCSSValue(prop, val) {
    if (!val && val !== '0') return false;
    // Reject obviously broken values
    if (String(val).includes('javascript:')) return false;
    if (String(val).includes('<script')) return false;
    return true;
  }

  function _mergeConfig(preset, cfg) {
    // Config may carry token overrides for presets (e.g., birthday name/message)
    const merged = { ...preset };
    if (cfg.tokenOverrides) {
      merged.tokens = { ...preset.tokens, ...cfg.tokenOverrides };
    }
    if (cfg.backgroundImageUrl) merged.backgroundImageUrl = cfg.backgroundImageUrl;
    if (cfg.effects) merged.effects = cfg.effects;
    if (cfg.bannerText) merged.bannerText = cfg.bannerText;
    return merged;
  }

  function _validateTheme(data) {
    // Ensure required token keys exist, fallback to default for any missing
    const validated = { ...data };
    validated.tokens = validated.tokens || {};
    const defaultTokens = DEFAULT_THEME.tokens;
    for (const key of Object.keys(defaultTokens)) {
      if (!validated.tokens[key]) validated.tokens[key] = defaultTokens[key];
    }
    return validated;
  }

  /* ────────────────────────────────────────────────────────────────
     3.5  EFFECTS ENGINE
     Lightweight CSS-animated particle effects.
     All elements use pointer-events:none.
  ──────────────────────────────────────────────────────────────── */
  function _clearEffects() {
    _effectsTimers.forEach(t => clearInterval(t));
    _effectsTimers = [];
    _effectsElements.forEach(el => el.remove());
    _effectsElements = [];
    if (_effectsEl) _effectsEl.innerHTML = '';
  }

  function _startEffects(effects, themeData) {
    // Respect prefers-reduced-motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!effects || effects.length === 0) return;

    if (effects.includes('snow'))      _startSnow();
    if (effects.includes('confetti'))  _startConfetti();
    if (effects.includes('hearts'))    _startHearts();
    if (effects.includes('leaves'))    _startLeaves();
    if (effects.includes('stars'))     _startStars();
    if (effects.includes('embers'))    _startEmbers();
    if (effects.includes('lightning')) _startLightning(themeData.lightningColor);
    if (effects.includes('fog'))       _startFog(themeData.fogRgb);
    if (effects.includes('cyber'))     _startCyberParticles(themeData.cyberColor);
    if (effects.includes('rain'))      _startRain();
  }

  function _spawnParticles(spawnFn, count, interval) {
    // Initial burst
    for (let i = 0; i < count; i++) {
      setTimeout(() => spawnFn(), Math.random() * 3000);
    }
    // Recurring spawn
    const t = setInterval(spawnFn, interval);
    _effectsTimers.push(t);
  }

  function _addEffect(el) {
    _effectsEl.appendChild(el);
    _effectsElements.push(el);
  }

  /* Snow */
  function _startSnow() {
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-snowflake';
      const size = 2 + Math.random() * 5;
      el.style.cssText = `
        left:${Math.random()*100}%;
        width:${size}px; height:${size}px;
        --sx:${-30+Math.random()*60}px;
        animation-duration:${5+Math.random()*10}s;
        animation-delay:${Math.random()*5}s;
        opacity:${0.4+Math.random()*0.6};
      `;
      _addEffect(el);
      setTimeout(() => el.remove(), 18000);
    }
    _spawnParticles(spawn, 40, 400);
  }

  /* Confetti */
  function _startConfetti() {
    const colors = ['#ff4488','#ffdd00','#44ccff','#ff8800','#44ff88','#cc44ff'];
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-confetti';
      el.style.cssText = `
        left:${Math.random()*100}%;
        background:${colors[Math.floor(Math.random()*colors.length)]};
        width:${5+Math.random()*6}px;
        height:${5+Math.random()*6}px;
        border-radius:${Math.random()>0.5?'50%':'2px'};
        --cx:${-60+Math.random()*120}px;
        --cr:${360+Math.random()*720}deg;
        animation-duration:${4+Math.random()*8}s;
        animation-delay:${Math.random()*3}s;
      `;
      _addEffect(el);
      setTimeout(() => el.remove(), 14000);
    }
    _spawnParticles(spawn, 50, 300);
  }

  /* Hearts */
  function _startHearts() {
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-heart';
      el.textContent = ['❤️','💕','💖','💗','💓'][Math.floor(Math.random()*5)];
      el.style.cssText = `
        left:${Math.random()*100}%;
        font-size:${10+Math.random()*14}px;
        --hx:${-40+Math.random()*80}px;
        animation-duration:${5+Math.random()*8}s;
        animation-delay:${Math.random()*4}s;
      `;
      _addEffect(el);
      setTimeout(() => el.remove(), 16000);
    }
    _spawnParticles(spawn, 25, 600);
  }

  /* Leaves */
  function _startLeaves() {
    const leafEmojis = ['🍂','🍁','🍃','🌿'];
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-leaf';
      el.textContent = leafEmojis[Math.floor(Math.random()*leafEmojis.length)];
      el.style.cssText = `
        left:${Math.random()*100}%;
        font-size:${12+Math.random()*10}px;
        --lsx:${-40+Math.random()*80}px;
        --lex:${-30+Math.random()*60}px;
        animation-duration:${8+Math.random()*12}s;
        animation-delay:${Math.random()*6}s;
      `;
      _addEffect(el);
      setTimeout(() => el.remove(), 22000);
    }
    _spawnParticles(spawn, 20, 800);
  }

  /* Stars */
  function _startStars() {
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-star';
      const size = 1 + Math.random() * 3;
      el.style.cssText = `
        left:${Math.random()*100}%;
        top:${Math.random()*100}%;
        width:${size}px; height:${size}px;
        animation-duration:${2+Math.random()*4}s;
        animation-delay:${Math.random()*4}s;
      `;
      _addEffect(el);
    }
    for (let i = 0; i < 60; i++) spawn();
  }

  /* Embers */
  function _startEmbers() {
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-ember';
      const size = 2 + Math.random() * 4;
      el.style.cssText = `
        left:${Math.random()*100}%;
        width:${size}px; height:${size}px;
        --ex:${-40+Math.random()*80}px;
        animation-duration:${2+Math.random()*5}s;
        animation-delay:${Math.random()*3}s;
      `;
      _addEffect(el);
      setTimeout(() => el.remove(), 9000);
    }
    _spawnParticles(spawn, 20, 500);
  }

  /* Lightning */
  function _startLightning(color) {
    const flashColor = color || 'rgba(0,150,255,0.10)';
    function flash() {
      const el = document.createElement('div');
      el.className = 'snx-lightning-flash';
      el.style.background = flashColor;
      _addEffect(el);
      setTimeout(() => el.remove(), 200);
    }
    // Random lightning flashes
    function scheduleFlash() {
      const delay = 3000 + Math.random() * 12000;
      const t = setTimeout(() => { flash(); scheduleFlash(); }, delay);
      _effectsTimers.push(t);
    }
    scheduleFlash();
  }

  /* Fog */
  function _startFog(rgb) {
    const bands = 3;
    for (let i = 0; i < bands; i++) {
      const el = document.createElement('div');
      el.className = 'snx-fog-band';
      const h = 15 + Math.random() * 25;
      el.style.cssText = `
        top:${20+i*25+Math.random()*15}%;
        height:${h}%;
        --fog-rgb:${rgb || '30,30,80'};
        animation-duration:${12+Math.random()*10}s;
        animation-delay:${i*3}s;
        opacity:${0.4+Math.random()*0.3};
      `;
      _addEffect(el);
    }
  }

  /* Cyber particles */
  function _startCyberParticles(color) {
    const c = color || '#00AEEF';
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-cyber-particle';
      el.style.cssText = `
        left:${Math.random()*100}%;
        top:${80+Math.random()*20}%;
        background:${c};
        box-shadow:0 0 4px ${c};
        width:${1+Math.random()*3}px;
        height:${1+Math.random()*3}px;
        --cpx:${-30+Math.random()*60}px;
        animation-duration:${6+Math.random()*10}s;
        animation-delay:${Math.random()*5}s;
      `;
      _addEffect(el);
      setTimeout(() => el.remove(), 18000);
    }
    _spawnParticles(spawn, 30, 500);
  }

  /* Rain */
  function _startRain() {
    function spawn() {
      const el = document.createElement('div');
      el.className = 'snx-raindrop';
      el.style.cssText = `
        left:${Math.random()*100}%;
        height:${15+Math.random()*20}px;
        animation-duration:${0.8+Math.random()*0.6}s;
        animation-delay:${Math.random()*2}s;
        opacity:${0.3+Math.random()*0.4};
      `;
      _addEffect(el);
      setTimeout(() => el.remove(), 3000);
    }
    _spawnParticles(spawn, 60, 200);
  }

  /* ────────────────────────────────────────────────────────────────
     3.6  SMOOTH TRANSITION
  ──────────────────────────────────────────────────────────────── */
  async function _smoothTransition(fn) {
    if (!_veilEl) return fn();
    _veilEl.classList.add('fade-in');
    await new Promise(r => setTimeout(r, 280));
    await fn();
    _veilEl.classList.remove('fade-in');
    _veilEl.classList.add('fade-out');
    await new Promise(r => setTimeout(r, 400));
    _veilEl.classList.remove('fade-out');
  }

  /* ────────────────────────────────────────────────────────────────
     3.7  SCROLLBAR COLOR
  ──────────────────────────────────────────────────────────────── */
  function _updateScrollbarColor(color) {
    const root = document.documentElement;
    root.style.setProperty('--scrollbar-thumb', color);
    // Inject or update a style tag for ::-webkit-scrollbar-thumb
    let st = document.getElementById('snx-scrollbar-style');
    if (!st) {
      st = document.createElement('style');
      st.id = 'snx-scrollbar-style';
      document.head.appendChild(st);
    }
    st.textContent = `::-webkit-scrollbar-thumb{background:${color};border-radius:4px;}`;
  }

  /* ────────────────────────────────────────────────────────────────
     3.8  EVENT BANNER
  ──────────────────────────────────────────────────────────────── */
  function _applyBanner(cfg) {
    if (!_bannerEl) return;
    if (!cfg.bannerEnabled || !cfg.bannerText) {
      _bannerEl.classList.add('hidden');
      if (_bannerCountdownTimer) { clearInterval(_bannerCountdownTimer); _bannerCountdownTimer = null; }
      return;
    }
    _bannerEl.classList.remove('hidden');
    const textEl = _bannerEl.querySelector('.banner-text');
    if (textEl) textEl.textContent = cfg.bannerText;

    const countdownEl = _bannerEl.querySelector('.banner-countdown');
    if (cfg.bannerCountdownEnabled && cfg.bannerCountdownTarget) {
      countdownEl.innerHTML = '';
      countdownEl.style.display = 'flex';
      function updateCountdown() {
        const diff = new Date(cfg.bannerCountdownTarget).getTime() - Date.now();
        if (diff <= 0) {
          countdownEl.innerHTML = '';
          if (_bannerCountdownTimer) clearInterval(_bannerCountdownTimer);
          return;
        }
        const d = Math.floor(diff / 86400000);
        const h = Math.floor((diff % 86400000) / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        countdownEl.innerHTML = `
          <div class="banner-count-unit"><span class="banner-count-value">${d}</span><span class="banner-count-label">Days</span></div>
          <div class="banner-count-unit"><span class="banner-count-value">${h}</span><span class="banner-count-label">Hours</span></div>
          <div class="banner-count-unit"><span class="banner-count-value">${m}</span><span class="banner-count-label">Min</span></div>`;
      }
      updateCountdown();
      if (_bannerCountdownTimer) clearInterval(_bannerCountdownTimer);
      _bannerCountdownTimer = setInterval(updateCountdown, 30000);
    } else {
      countdownEl.innerHTML = '';
      countdownEl.style.display = 'none';
    }
  }

  /* ────────────────────────────────────────────────────────────────
     3.9  SCHEDULING — resolves which theme should be active
     based on current time and scheduled entries.
  ──────────────────────────────────────────────────────────────── */
  async function _resolveScheduledTheme(cfg) {
    try {
      const now = Date.now();
      const schedSnap = await getDocs(
        query(collection(_db, 'themeSchedules'), where('active', '==', true))
      );
      if (schedSnap.empty) return null;

      for (const d of schedSnap.docs) {
        const s = d.data();
        const start = s.startAt?.toMillis ? s.startAt.toMillis() : new Date(s.startAt).getTime();
        const end   = s.endAt?.toMillis   ? s.endAt.toMillis()   : new Date(s.endAt).getTime();
        if (now >= start && now <= end) return s.themeId;
      }
    } catch (_) {}
    return null;
  }

  /* ────────────────────────────────────────────────────────────────
     3.10  FOUNDER OPERATIONS (all require Founder role)
  ──────────────────────────────────────────────────────────────── */

  /** Enter private preview — only Founder sees the draft theme */
  async function previewTheme(themeId, themeData) {
    if (window._snxRole !== 'founder') return;
    _previewMode = true;
    _previewThemeData = { id: themeId, data: themeData };
    await _smoothTransition(() => _applyTheme(themeData, themeId));
    if (_previewBarEl) {
      _previewBarEl.style.display = 'flex';
      const nameEl = document.getElementById('snxPreviewThemeName');
      if (nameEl) nameEl.textContent = themeData.name || themeId;
    }
  }

  /** Publish the current preview theme globally */
  async function publishPreview() {
    if (window._snxRole !== 'founder') return;
    if (!_previewThemeData) return;
    await publishTheme(_previewThemeData.id, _previewThemeData.data);
    exitPreview();
  }

  /** Exit preview, restoring the published theme */
  async function exitPreview() {
    if (!_previewMode) return;
    _previewMode = false;
    _previewThemeData = null;
    if (_previewBarEl) _previewBarEl.style.display = 'none';
    await _smoothTransition(() => _loadActiveTheme());
  }

  /** Publish a theme globally (Firestore write — rules enforce Founder-only) */
  async function publishTheme(themeId, themeData) {
    if (window._snxRole !== 'founder') {
      if (typeof toastNotification === 'function') toastNotification('⛔ Founder access only.');
      return;
    }
    try {
      const batch = writeBatch(_db);

      // Update or create theme doc
      if (themeId && !PREBUILT_THEMES[themeId]) {
        batch.set(doc(_db, 'themes', themeId), {
          ...themeData,
          status: 'published',
          publishedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: window._snxCurrentUser?.uid || 'founder',
        }, { merge: true });
      }

      // Update global config — Firestore rules enforce isFounder()
      const cfgRef = doc(_db, 'siteConfig', 'globalTheme');
      const cfgSnap = await getDoc(cfgRef);
      const prevVersion = cfgSnap.exists() ? (cfgSnap.data().version || 0) : 0;

      batch.set(cfgRef, {
        activeThemeId:    themeId,
        themeName:        themeData.name || themeId,
        version:          prevVersion + 1,
        status:           'published',
        publishedAt:      serverTimestamp(),
        updatedAt:        serverTimestamp(),
        updatedBy:        window._snxCurrentUser?.uid || 'founder',
        effects:          themeData.effects || [],
        backgroundImageUrl: themeData.backgroundImageUrl || null,
        bannerEnabled:    themeData.bannerEnabled || false,
        bannerText:       themeData.bannerText || '',
        bannerCountdownEnabled: themeData.bannerCountdownEnabled || false,
        bannerCountdownTarget:  themeData.bannerCountdownTarget || null,
        tokenOverrides:   themeData.tokenOverrides || null,
      }, { merge: true });

      // Add to theme history
      batch.set(doc(collection(_db, 'themeHistory')), {
        themeId,
        themeName: themeData.name || themeId,
        publishedAt: serverTimestamp(),
        publishedBy: window._snxCurrentUser?.uid || 'founder',
        version: prevVersion + 1,
        isManual: true,
      });

      await batch.commit();
      if (typeof toastNotification === 'function') toastNotification('✅ Theme published globally!');
    } catch (err) {
      console.error('[ThemeEngine] publishTheme error:', err);
      if (typeof toastNotification === 'function') toastNotification('❌ Publish failed: ' + err.message);
    }
  }

  /** Save a theme as a draft (no live effect on other users) */
  async function saveDraft(themeId, themeData) {
    if (window._snxRole !== 'founder') {
      if (typeof toastNotification === 'function') toastNotification('⛔ Founder access only.');
      return null;
    }
    try {
      let id = themeId;
      if (!id) {
        const ref = await addDoc(collection(_db, 'themes'), {
          ...themeData,
          status: 'draft',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          updatedBy: window._snxCurrentUser?.uid || 'founder',
        });
        id = ref.id;
      } else {
        await setDoc(doc(_db, 'themes', id), {
          ...themeData,
          status: 'draft',
          updatedAt: serverTimestamp(),
          updatedBy: window._snxCurrentUser?.uid || 'founder',
        }, { merge: true });
      }
      if (typeof toastNotification === 'function') toastNotification('💾 Draft saved.');
      return id;
    } catch (err) {
      console.error('[ThemeEngine] saveDraft error:', err);
      if (typeof toastNotification === 'function') toastNotification('❌ Save failed: ' + err.message);
      return null;
    }
  }

  /** Duplicate a theme */
  async function duplicateTheme(themeId) {
    if (window._snxRole !== 'founder') return null;
    try {
      let sourceData;
      if (PREBUILT_THEMES[themeId]) {
        sourceData = { ...PREBUILT_THEMES[themeId] };
      } else {
        const snap = await getDoc(doc(_db, 'themes', themeId));
        if (!snap.exists()) return null;
        sourceData = snap.data();
      }
      sourceData.name = (sourceData.name || themeId) + ' (Copy)';
      sourceData.status = 'draft';
      delete sourceData.publishedAt;
      const ref = await addDoc(collection(_db, 'themes'), {
        ...sourceData,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        updatedBy: window._snxCurrentUser?.uid || 'founder',
      });
      if (typeof toastNotification === 'function') toastNotification('📋 Theme duplicated.');
      return ref.id;
    } catch (err) {
      console.error('[ThemeEngine] duplicateTheme error:', err);
      return null;
    }
  }

  /** Delete a custom theme (never deletes website content) */
  async function deleteTheme(themeId) {
    if (window._snxRole !== 'founder') return;
    if (PREBUILT_THEMES[themeId]) {
      if (typeof toastNotification === 'function') toastNotification('⚠️ Built-in themes cannot be deleted.');
      return;
    }
    // Do not delete the currently active theme
    const cfg = await getDoc(doc(_db, 'siteConfig', 'globalTheme'));
    if (cfg.exists() && cfg.data().activeThemeId === themeId) {
      if (typeof toastNotification === 'function') toastNotification('⚠️ Cannot delete the currently published theme.');
      return;
    }
    await deleteDoc(doc(_db, 'themes', themeId));
    if (typeof toastNotification === 'function') toastNotification('🗑️ Theme deleted.');
  }

  /** Schedule a theme for a time range */
  async function scheduleTheme(themeId, startAt, endAt) {
    if (window._snxRole !== 'founder') return false;
    try {
      // Check for conflicts
      const existing = await getDocs(
        query(collection(_db, 'themeSchedules'), where('active', '==', true))
      );
      const start = new Date(startAt).getTime();
      const end   = new Date(endAt).getTime();
      for (const d of existing.docs) {
        const s = d.data();
        const sStart = s.startAt?.toMillis ? s.startAt.toMillis() : new Date(s.startAt).getTime();
        const sEnd   = s.endAt?.toMillis   ? s.endAt.toMillis()   : new Date(s.endAt).getTime();
        if (start < sEnd && end > sStart && d.data().themeId !== themeId) {
          return { conflict: true, conflictWith: s };
        }
      }
      await addDoc(collection(_db, 'themeSchedules'), {
        themeId,
        startAt: new Date(startAt),
        endAt:   new Date(endAt),
        active:  true,
        createdAt: serverTimestamp(),
        createdBy: window._snxCurrentUser?.uid || 'founder',
      });
      if (typeof toastNotification === 'function') toastNotification('📅 Theme scheduled.');
      return { conflict: false };
    } catch (err) {
      console.error('[ThemeEngine] scheduleTheme error:', err);
      return false;
    }
  }

  /** Emergency reset — restore Shadow Nexus Default for everyone */
  async function emergencyReset() {
    if (window._snxRole !== 'founder') return;
    try {
      await setDoc(doc(_db, 'siteConfig', 'globalTheme'), {
        activeThemeId:  'shadow-nexus-default',
        themeName:      'Shadow Nexus Default',
        version:        (Date.now()),
        status:         'published',
        publishedAt:    serverTimestamp(),
        updatedAt:      serverTimestamp(),
        updatedBy:      window._snxCurrentUser?.uid || 'founder',
        effects:        [],
        bannerEnabled:  false,
        bannerText:     '',
      }, { merge: false });
      _clearEffects();
      if (_previewMode) exitPreview();
      if (typeof toastNotification === 'function') toastNotification('✅ Shadow Nexus Default restored globally!');
    } catch (err) {
      // Failsafe: apply locally even if Firestore write fails
      _applyTheme(DEFAULT_THEME, 'shadow-nexus-default');
      if (typeof toastNotification === 'function') toastNotification('⚠️ Emergency reset applied locally.');
    }
  }

  /** Restore a theme from history */
  async function restoreFromHistory(themeId, themeName) {
    if (window._snxRole !== 'founder') return;
    let themeData;
    if (PREBUILT_THEMES[themeId]) {
      themeData = PREBUILT_THEMES[themeId];
    } else {
      const snap = await getDoc(doc(_db, 'themes', themeId));
      if (!snap.exists()) { if (typeof toastNotification==='function') toastNotification('⚠️ Theme not found.'); return; }
      themeData = snap.data();
    }
    await publishTheme(themeId, themeData);
  }

  /**
   * Upload a background image for a theme to Cloudflare R2 via the upload Worker.
   * Replaces the previous Firebase Storage implementation.
   * Only Founder-role users can call this (checked client-side + enforced by Worker auth).
   *
   * @param {File}     file        - Image file to upload.
   * @param {Function} onProgress  - Optional (pct: number) => void callback.
   * @returns {Promise<string|null>} - Public R2 CDN URL, or null on failure.
   */
  async function uploadBackgroundImage(file, onProgress) {
    if (window._snxRole !== 'founder') return null;

    // Get the current Firebase user from the auth instance passed to init()
    const user = _auth && _auth.currentUser;
    if (!user || typeof user.getIdToken !== 'function') {
      console.error('[ThemeEngine] uploadBg: no authenticated user — cannot upload to R2.');
      return null;
    }

    // Validate: images only, 10 MB max
    if (!file.type.startsWith('image/')) {
      console.error('[ThemeEngine] uploadBg: only image files are supported.');
      return null;
    }
    const MAX_BG_BYTES = 10 * 1024 * 1024;
    if (file.size > MAX_BG_BYTES) {
      console.error('[ThemeEngine] uploadBg: file too large (max 10 MB).');
      return null;
    }

    const R2_WORKER = 'https://yellow-term-11e6.nthntjrn.workers.dev';
    const uid = user.uid;
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const r2Key = `themes/${uid}/${Date.now()}_${safeName}`;

    try {
      const idToken = await user.getIdToken(true);
      const formData = new FormData();
      formData.append('file', file, file.name);
      formData.append('path', r2Key);

      const xhr = new XMLHttpRequest();
      xhr.timeout = 5 * 60 * 1000; // 5 min

      return new Promise((resolve, reject) => {
        xhr.upload.onprogress = e => {
          if (e.lengthComputable && onProgress) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status === 200) {
            try {
              const res = JSON.parse(xhr.responseText);
              if (res.url) { resolve(res.url); return; }
            } catch(_) {}
            reject(new Error('R2 upload returned no URL'));
          } else {
            let msg = 'R2 upload failed: HTTP ' + xhr.status;
            try { const r = JSON.parse(xhr.responseText); if (r.error) msg = r.error; } catch(_) {}
            reject(new Error(msg));
          }
        };
        xhr.onerror  = () => reject(new Error('Upload interrupted — check your connection.'));
        xhr.ontimeout = () => reject(new Error('Upload timed out.'));
        xhr.open('POST', R2_WORKER + '/');
        xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);
        xhr.send(formData);
      });
    } catch (err) {
      console.error('[ThemeEngine] uploadBg error:', err);
      return null;
    }
  }

  /** Load all themes (draft + published) for the Founder editor */
  async function loadAllThemes() {
    if (window._snxRole !== 'founder') return [];
    const themes = [];
    // Add prebuilt entries
    for (const [id, data] of Object.entries(PREBUILT_THEMES)) {
      themes.push({ id, ...data, isBuiltIn: true });
    }
    // Add custom themes from Firestore
    try {
      const snap = await getDocs(
        query(collection(_db, 'themes'), orderBy('updatedAt', 'desc'), limit(50))
      );
      for (const d of snap.docs) {
        themes.push({ id: d.id, ...d.data(), isBuiltIn: false });
      }
    } catch (_) {}
    return themes;
  }

  /** Load theme history */
  async function loadThemeHistory() {
    if (window._snxRole !== 'founder') return [];
    try {
      const snap = await getDocs(
        query(collection(_db, 'themeHistory'), orderBy('publishedAt', 'desc'), limit(30))
      );
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (_) { return []; }
  }

  /** Open the Theme Control Center tab inside the admin panel */
  function openThemeEditor() {
    if (window._snxRole !== 'founder') return;
    if (typeof realmNavTo === 'function') realmNavTo('adminPage');
    setTimeout(() => {
      if (typeof window.switchAdminTab === 'function') window.switchAdminTab('themes');
      // snxTCCOpen must run AFTER switchAdminTab so that #adminPage is active
      // (the guard inside snxTCCOpen checks for adminPage.active)
      if (typeof window.snxTCCOpen === 'function') window.snxTCCOpen();
    }, 350);
  }

  /** Public getter for current theme id */
  function getActiveThemeId() { return _currentThemeId; }
  function getPrebuiltThemes() { return PREBUILT_THEMES; }
  function getDefaultTheme() { return DEFAULT_THEME; }

  /* ────────────────────────────────────────────────────────────────
     3.11  CONTRAST WARNING HELPER
  ──────────────────────────────────────────────────────────────── */
  function checkContrast(bgHex, fgHex) {
    function lum(hex) {
      const c = hex.replace('#','');
      const r = parseInt(c.substr(0,2),16)/255;
      const g = parseInt(c.substr(2,2),16)/255;
      const b = parseInt(c.substr(4,2),16)/255;
      const toL = x => x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4);
      return 0.2126*toL(r) + 0.7152*toL(g) + 0.0722*toL(b);
    }
    const L1 = lum(bgHex), L2 = lum(fgHex);
    return (Math.max(L1,L2)+0.05) / (Math.min(L1,L2)+0.05);
  }

  /* ────────────────────────────────────────────────────────────────
     EXPORTS
  ──────────────────────────────────────────────────────────────── */
  return {
    init,
    // User-facing (read/apply only)
    getActiveThemeId,
    getPrebuiltThemes,
    getDefaultTheme,
    // Founder-only
    previewTheme,
    exitPreview,
    publishPreview,
    publishTheme,
    saveDraft,
    duplicateTheme,
    deleteTheme,
    scheduleTheme,
    emergencyReset,
    restoreFromHistory,
    uploadBackgroundImage,
    loadAllThemes,
    loadThemeHistory,
    openThemeEditor,
    checkContrast,
    // Internal (exposed for TCC UI)
    _applyTheme,
    _smoothTransition,
    _applyBanner,
  };

})();

export { ThemeEngine, PREBUILT_THEMES };
