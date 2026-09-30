/**
 * snx-radio-requests.js — Shadow Nexus Radio · Song Requests
 * Version: 1.0.0
 *
 * Completely isolated from Radio playback. Zero audio interaction.
 * Never touches: _audioEl, epochMs, _playlist, _station, SNXRadio.init/destroy.
 *
 * Public API (window.SNXRadioRequests):
 *   openModal()   — open the REQUEST A SONG modal
 *   closeModal()  — close the modal
 *
 * Dependencies:
 *   window._snxFirestore  — modular Firestore bundle (set by index.html)
 *   window._snxAuth       — Firebase Auth instance
 *   window._snxCurrentUser — current Firebase user (or auth.currentUser)
 *   window._snxUserData   — live onSnapshot of users/{uid} (same as On-Air Conversation)
 *   window.SNXRadio       — read-only: nowPlaying (NEVER writes)
 *   snx-radio.css         — includes .snxrq-* class styles
 */

'use strict';

(function () {

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════ */

const COL_TRACKS   = 'radioTracks';
const COL_REQUESTS = 'radioRequests';

/* ══════════════════════════════════════════════════════════════
   MODULE STATE
══════════════════════════════════════════════════════════════ */

let _modalEl      = null;   // root modal overlay element
let _open         = false;
let _tracks       = [];     // cached enabled tracks from Firestore (kept live)
let _filtered     = [];     // search-filtered view
let _selected     = null;   // { id, title, artist }
let _submitting   = false;
let _searchVal    = '';
let _tracksUnsub  = null;   // onSnapshot unsubscribe for /radioTracks

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */

window.SNXRadioRequests = {
  openModal,
  closeModal,
};

/* Start live track library subscription as soon as the module loads.
   Uses SNXRadioTrackStore (shared listener) when available to avoid a
   duplicate Firestore onSnapshot for /radioTracks.
   Falls back to a direct Firestore query if the store is not loaded. */
function _startTrackLibrarySubscription() {
  if (_tracksUnsub) return; // already subscribed

  // ── Prefer shared store ───────────────────────────────────────────────────
  if (window.SNXRadioTrackStore) {
    _tracksUnsub = window.SNXRadioTrackStore.subscribe(function (docs) {
      _tracks = docs
        .filter(function (d) { return d.audioUrl || d.musicUrl || d.downloadURL || d.url; })
        .filter(function (d) { return d.enabled !== false; })
        .map(function (d) {
          return {
            id:     d.id,
            title:  d.title  || d.name      || 'Unknown',
            artist: d.artist || d.artistName || 'Unknown Artist',
          };
        })
        .sort(function (a, b) { return a.title.localeCompare(b.title); });
      if (_open) _renderList();
      console.log('[SNX-RQ] library update (via store) —', _tracks.length, 'tracks');
    });
    return;
  }

  // ── Fallback: direct Firestore listener ────────────────────────────────────
  const mods = window._snxFirestore;
  if (!mods || !mods.db || !mods.collection || !mods.onSnapshot || !mods.query || !mods.where) {
    // Firebase not ready yet — retry
    setTimeout(_startTrackLibrarySubscription, 1000);
    return;
  }

  try {
    const { db, collection, query, where, onSnapshot } = mods;
    const q = query(collection(db, COL_TRACKS), where('enabled', '==', true));
    _tracksUnsub = onSnapshot(q, (snap) => {
      let docs = [];
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
      _tracks = docs
        .filter(d => d.audioUrl || d.musicUrl || d.downloadURL || d.url)
        .map(d => ({
          id:     d.id,
          title:  d.title  || d.name      || 'Unknown',
          artist: d.artist || d.artistName || 'Unknown Artist',
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
      if (_open) _renderList();
      console.log('[SNX-RQ] library live update (direct) —', _tracks.length, 'tracks');
    }, (err) => {
      console.warn('[SNX-RQ] tracks snapshot error:', err.message);
      _tracksUnsub = null;
    });
  } catch (e) {
    console.warn('[SNX-RQ] _startTrackLibrarySubscription error:', e.message);
  }
}

// Also listen for tracksChange events from SNXRadio engine (belt-and-suspenders)
document.addEventListener('snxRadio:tracksChange', function() {
  if (_open) _renderList();
});

// Start subscription when Firebase is ready — wait for store to initialise first
setTimeout(_startTrackLibrarySubscription, 1800);

/* ══════════════════════════════════════════════════════════════
   OPEN / CLOSE MODAL
══════════════════════════════════════════════════════════════ */

function openModal() {
  if (_open) { _focusSearch(); return; }

  // Check sign-in
  const user = _getCurrentUser();
  if (!user) {
    _showToast('Sign in to request a song.');
    return;
  }

  _buildModal();
  document.body.appendChild(_modalEl);
  _open = true;

  // If live subscription hasn't loaded yet, fall back to one-time load
  if (_tracks.length > 0) {
    _renderList();
    _focusSearch();
  } else {
    _loadTracks().then(() => {
      _renderList();
      _focusSearch();
    });
  }
  // Ensure subscription is running (idempotent)
  _startTrackLibrarySubscription();

  // Trap ESC key
  document.addEventListener('keydown', _onKeyDown);
  console.log('[SNX-RQ] modal opened');
}

function closeModal() {
  if (!_open) return;
  if (_modalEl && _modalEl.parentNode) _modalEl.parentNode.removeChild(_modalEl);
  _modalEl    = null;
  _open       = false;
  _selected   = null;
  _submitting = false;
  _searchVal  = '';
  document.removeEventListener('keydown', _onKeyDown);
  console.log('[SNX-RQ] modal closed');
}

/* ══════════════════════════════════════════════════════════════
   MODAL DOM
══════════════════════════════════════════════════════════════ */

function _buildModal() {
  const overlay = document.createElement('div');
  overlay.id        = 'snxrqOverlay';
  overlay.className = 'snxrq-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Request a Song');

  overlay.innerHTML = `
<div class="snxrq-modal" id="snxrqModal">

  <div class="snxrq-header">
    <span class="snxrq-header-title">🎵 REQUEST A SONG</span>
    <button class="snxrq-close-btn" id="snxrqCloseBtn" type="button" aria-label="Close">✕</button>
  </div>

  <div class="snxrq-hint">Search the Radio library and request a track for future playback.</div>

  <div class="snxrq-search-wrap">
    <input class="snxrq-search"
           id="snxrqSearch"
           type="search"
           placeholder="Search the Radio library…"
           autocomplete="off"
           spellcheck="false"
           aria-label="Search tracks"
    />
  </div>

  <div class="snxrq-list-wrap">
    <div class="snxrq-list" id="snxrqList" role="listbox" aria-label="Available tracks">
      <p class="snxrq-empty" id="snxrqEmpty">Loading library…</p>
    </div>
  </div>

  <div class="snxrq-selected-wrap snxrq-hidden" id="snxrqSelectedWrap">
    <div class="snxrq-selected-label">Selected:</div>
    <div class="snxrq-selected-info" id="snxrqSelectedInfo"></div>
  </div>

  <div class="snxrq-footer">
    <button class="snxrq-btn snxrq-btn--primary" id="snxrqSubmitBtn" type="button" disabled>
      🎵 REQUEST
    </button>
    <p class="snxrq-msg" id="snxrqMsg"></p>
  </div>

</div>
  `;

  // Close on overlay click (outside modal box)
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal();
  });

  _modalEl = overlay;

  // Bind events after insertion into DOM at next tick
  setTimeout(_bindModalEvents, 0);
}

function _bindModalEvents() {
  if (!_modalEl) return;
  const $ = id => document.getElementById(id);

  const closeBtn  = $('snxrqCloseBtn');
  const searchEl  = $('snxrqSearch');
  const submitBtn = $('snxrqSubmitBtn');

  if (closeBtn)  closeBtn.addEventListener('click',  closeModal);
  if (searchEl)  searchEl.addEventListener('input',  _onSearchInput);
  if (submitBtn) submitBtn.addEventListener('click',  _onSubmit);
}

/* ══════════════════════════════════════════════════════════════
   TRACK LOADING  (read-only — never writes to /radioTracks)
══════════════════════════════════════════════════════════════ */

async function _loadTracks() {
  // Always reload — never serve a stale empty cache from a previous failed query.
  // (The tracks list is small; a fresh read on each modal open is inexpensive.)

  try {
    const mods = window._snxFirestore;
    if (!mods || !mods.db) return;

    const { db, collection, query, where, getDocs } = mods;
    let docs = [];

    if (collection && query && where && getDocs) {
      // Simple equality filter only — no orderBy, so no composite index required.
      // Sorting is done client-side after the fetch.
      const q = query(
        collection(db, COL_TRACKS),
        where('enabled', '==', true)
      );
      const snap = await getDocs(q);
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
    } else if (db.collection) {
      // compat fallback (no orderBy here either)
      const snap = await db.collection(COL_TRACKS)
        .where('enabled', '==', true)
        .get();
      snap.forEach(d => docs.push({ id: d.id, ...d.data() }));
    }

    // Normalise fields (mirrors snx-radio.js _normaliseTrack), sort A-Z by title client-side
    _tracks = docs
      .filter(d => d.audioUrl || d.musicUrl || d.downloadURL || d.url)
      .map(d => ({
        id:     d.id,
        title:  d.title  || d.name             || 'Unknown',
        artist: d.artist || d.artistName        || 'Unknown Artist',
      }))
      .sort((a, b) => a.title.localeCompare(b.title));

    console.log('[SNX-RQ] library loaded —', _tracks.length, 'tracks');
  } catch (e) {
    console.error('[SNX-RQ] loadTracks error:', e.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   SEARCH + RENDER
══════════════════════════════════════════════════════════════ */

function _onSearchInput(e) {
  _searchVal = (e.target.value || '').trim().toLowerCase();
  _renderList();
}

function _renderList() {
  const listEl  = document.getElementById('snxrqList');
  const emptyEl = document.getElementById('snxrqEmpty');
  if (!listEl) return;

  // Apply search filter
  if (_searchVal) {
    _filtered = _tracks.filter(t =>
      t.title.toLowerCase().includes(_searchVal) ||
      t.artist.toLowerCase().includes(_searchVal)
    );
  } else {
    _filtered = _tracks.slice();
  }

  if (_tracks.length === 0) {
    listEl.innerHTML = '<p class="snxrq-empty">No tracks in the library yet.</p>';
    return;
  }

  if (_filtered.length === 0) {
    listEl.innerHTML = '<p class="snxrq-empty">No tracks match your search.</p>';
    return;
  }

  listEl.innerHTML = _filtered.map(t => {
    const sel = _selected && _selected.id === t.id;
    return `<div class="snxrq-track-row${sel ? ' snxrq-track-row--selected' : ''}"
                 data-id="${_esc(t.id)}"
                 role="option"
                 aria-selected="${sel}"
                 tabindex="0">
      <div class="snxrq-track-title">${_esc(t.title)}</div>
      <div class="snxrq-track-artist">${_esc(t.artist)}</div>
    </div>`;
  }).join('');

  // Bind click/keyboard to each row
  listEl.querySelectorAll('.snxrq-track-row').forEach(row => {
    row.addEventListener('click', _onRowClick);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _onRowClick(e); }
    });
  });
}

function _onRowClick(e) {
  const row = e.currentTarget;
  const id  = row.dataset.id;
  const track = _filtered.find(t => t.id === id);
  if (!track) return;

  _selected = track;

  // Update selected indicator
  const infoEl = document.getElementById('snxrqSelectedInfo');
  const wrap   = document.getElementById('snxrqSelectedWrap');
  if (infoEl) infoEl.innerHTML = `<strong>${_esc(track.title)}</strong><br><span style="color:#7c8cad">${_esc(track.artist)}</span>`;
  if (wrap)   wrap.classList.remove('snxrq-hidden');

  // Enable submit
  const btn = document.getElementById('snxrqSubmitBtn');
  if (btn) btn.disabled = false;

  // Re-render to highlight selection
  _renderList();

  // Clear previous message
  _setMsg('', '');
}

/* ══════════════════════════════════════════════════════════════
   SUBMIT REQUEST
══════════════════════════════════════════════════════════════ */

async function _onSubmit() {
  if (_submitting) return;
  if (!_selected)  { _setMsg('Select a track first.', 'error'); return; }

  const user = _getCurrentUser();
  if (!user) { _setMsg('Sign in to request a song.', 'error'); return; }

  const mods = window._snxFirestore;
  if (!mods || !mods.db) {
    _setMsg('Cannot connect to server. Please try again.', 'error');
    return;
  }

  _submitting = true;
  const btn = document.getElementById('snxrqSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Requesting…'; }
  _setMsg('', '');

  try {
    /* Resolve display username (same chain as snx-radio-comments.js) */
    const username = await _resolveUsername(user);

    const { db, collection, query, where, getDocs, addDoc, doc,
            getDoc, updateDoc, serverTimestamp, arrayUnion } = mods;

    const trackId     = _selected.id;
    const trackTitle  = _selected.title;
    const trackArtist = _selected.artist;

    /*
     * DEDUP STRATEGY
     * --------------
     * Query for a pending or approved request for this trackId.
     * If found → increment requestCount and append uid to requesterUids.
     * If not found → create a new request doc.
     *
     * UID never exposed to other listeners — only stored in the
     * requesterUids array which is Founder-read-only.
     */
    const q = query(
      collection(db, COL_REQUESTS),
      where('trackId', '==', trackId),
      where('status', 'in', ['pending', 'approved'])
    );
    const snap = await getDocs(q);

    if (!snap.empty) {
      /* Existing active request — merge this user into it */
      const existing = snap.docs[0];
      const data     = existing.data();

      /* Prevent the same user from inflating the count */
      const uids = data.requesterUids || [];
      if (uids.includes(user.uid)) {
        _setMsg('✓ Your request is already in the queue!', 'ok');
        return;
      }

      await updateDoc(doc(db, COL_REQUESTS, existing.id), {
        requestCount:   (data.requestCount || 1) + 1,
        requesterUids:  arrayUnion(user.uid),
        /* Keep latest requester's username visible to Founder
           (doesn't leak other UIDs — just a display label) */
        lastRequestedByUid:      user.uid,
        lastRequestedByUsername: username,
        lastRequestedAt:         serverTimestamp(),
      });

      console.log('[SNX-RQ] merged into existing request:', existing.id);
      _setMsg('✓ Request added! The Founder will review it.', 'ok');

    } else {
      /* No active request — create new */
      const ref = await addDoc(collection(db, COL_REQUESTS), {
        trackId:                 trackId,
        trackTitle:              trackTitle,
        trackArtist:             trackArtist,
        requestedByUid:          user.uid,
        requestedByUsername:     username,
        requestCount:            1,
        requesterUids:           [user.uid],
        requestedAt:             serverTimestamp(),
        status:                  'pending',
      });

      console.log('[SNX-RQ] new request created:', ref.id);
      _setMsg('✓ Request sent! The Founder will review it.', 'ok');
    }

    /* Deselect and reset so user can request another if they want */
    _selected = null;
    const selWrap = document.getElementById('snxrqSelectedWrap');
    if (selWrap) selWrap.classList.add('snxrq-hidden');
    if (btn) btn.disabled = true;
    _renderList();

    /* Auto-close after a short success pause */
    setTimeout(closeModal, 2200);

  } catch (e) {
    console.error('[SNX-RQ] submit error:', e.code, e.message);
    _setMsg('Could not send request. Please try again.', 'error');
  } finally {
    _submitting = false;
    const btnEl = document.getElementById('snxrqSubmitBtn');
    if (btnEl) {
      btnEl.textContent = '🎵 REQUEST';
      if (_selected) btnEl.disabled = false;
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   IDENTITY RESOLUTION
   Same priority chain as snx-radio-comments.js _resolveIdentity
══════════════════════════════════════════════════════════════ */

async function _resolveUsername(user) {
  // Primary: in-memory snapshot (_snxUserData is live onSnapshot of users/{uid})
  const ud = window._snxUserData;
  if (ud && (ud.username || ud.displayName)) {
    return ud.username || ud.displayName || '';
  }

  // Secondary: one-shot Firestore read (handles race on first page load)
  try {
    const mods = window._snxFirestore;
    if (mods && mods.db && mods.doc && mods.getDoc) {
      const snap = await mods.getDoc(mods.doc(mods.db, 'users', user.uid));
      if (snap.exists()) {
        const d = snap.data();
        return d.username || d.displayName || '';
      }
    }
  } catch (_) {}

  // Final fallback: Firebase Auth displayName (rarely set on SNS)
  return user.displayName || '';
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */

function _getCurrentUser() {
  if (window._snxCurrentUser) return window._snxCurrentUser;
  const auth = window._snxAuth ||
    (window.firebase && window.firebase.auth && window.firebase.auth());
  return auth ? auth.currentUser : null;
}

function _focusSearch() {
  setTimeout(() => {
    const el = document.getElementById('snxrqSearch');
    if (el) el.focus();
  }, 80);
}

function _onKeyDown(e) {
  if (e.key === 'Escape') closeModal();
}

function _setMsg(text, type) {
  const el = document.getElementById('snxrqMsg');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'snxrq-msg'
    + (type === 'error' ? ' snxrq-msg--error'
     : type === 'ok'    ? ' snxrq-msg--ok'
     : '');
}

function _showToast(msg) {
  try {
    if (typeof window.toastNotification === 'function') {
      window.toastNotification(msg);
    }
  } catch (_) {}
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

/* ══════════════════════════════════════════════════════════════
   STARTUP
══════════════════════════════════════════════════════════════ */

console.log('[SNX-RQ] snx-radio-requests.js loaded — v1.0.0');

})(); // end IIFE
