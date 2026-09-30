/**
 * snx-radio-comments.js — Shadow Nexus Radio · On-Air Conversation
 * Version: 1.0.0
 *
 * Completely isolated from Radio playback. Zero audio interaction.
 *
 * Public API (window.SNXRadioComments):
 *   mount(container)   — render the comments panel into container
 *   unmount()          — remove panel, unsubscribe Firestore listener
 *   pageEnter()        — called when user returns to radioPage (reconnects listener)
 *   pageLeave()        — called when user leaves radioPage (unsubscribes listener)
 *
 * Dependencies:
 *   window._snxFirestore  — modular Firestore bundle (set by index.html)
 *   window._snxAuth       — Firebase Auth instance
 *   window._snxRole       — 'founder' | 'moderator' | 'member' | undefined
 *   window.SNXRadio       — for reading current track context (read-only)
 *   snx-radio.css         — includes .snxrc-* class styles
 */

'use strict';

(function () {

/* ══════════════════════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════════════════════ */

const COL_COMMENTS   = 'radioComments';
const PAGE_SIZE      = 50;   // initial load
const MAX_CHARS      = 500;
const CHAR_WARN      = 80;   // show counter when this many chars remain

/* ══════════════════════════════════════════════════════════════
   MODULE STATE
══════════════════════════════════════════════════════════════ */

let _container   = null;   // DOM node passed to mount()
let _el          = null;   // root .snxrc-panel element
let _mounted     = false;
let _unsub       = null;   // Firestore onSnapshot unsubscribe
let _comments    = [];     // local cache: newest-first
let _hasEarlier  = false;  // true when server returned PAGE_SIZE docs
let _lastDoc     = null;   // cursor for "load earlier" pagination
let _submitting  = false;  // debounce double-submit

/* ── DOM element cache ── */
const E = {};

/* ══════════════════════════════════════════════════════════════
   PUBLIC API
══════════════════════════════════════════════════════════════ */

window.SNXRadioComments = {
  mount,
  unmount,
  pageEnter,
  pageLeave,
  get isMounted() { return _mounted; },
};

/* ══════════════════════════════════════════════════════════════
   MOUNT / UNMOUNT
══════════════════════════════════════════════════════════════ */

function mount(container) {
  if (_mounted) unmount();
  if (!container) { console.warn('[SNX-RC] mount: no container'); return; }
  _container = container;
  _buildDOM();
  _mounted = true;
  _subscribe();
  console.log('[SNX-RC] On-Air Conversation mounted');
}

function unmount() {
  if (!_mounted) return;
  _unsubscribe();
  if (_el && _el.parentNode) _el.parentNode.removeChild(_el);
  _el = null;
  Object.keys(E).forEach(k => { delete E[k]; });
  _mounted     = false;
  _comments    = [];
  _hasEarlier  = false;
  _lastDoc     = null;
  _submitting  = false;
  console.log('[SNX-RC] unmounted');
}

/* ══════════════════════════════════════════════════════════════
   PAGE LIFECYCLE (called by snxRadioPageOpen / snxRadioPageLeave)
══════════════════════════════════════════════════════════════ */

function pageEnter() {
  if (!_mounted) return;
  if (!_unsub) _subscribe();   // reconnect if we unsubscribed on leave
}

function pageLeave() {
  _unsubscribe();
}

/* ══════════════════════════════════════════════════════════════
   BUILD DOM
══════════════════════════════════════════════════════════════ */

function _buildDOM() {
  const div = document.createElement('div');
  div.className = 'snxrc-panel';
  div.innerHTML =
    '<div class="snxrc-header">' +
      '<h3 class="snxrc-title">On-Air Conversation</h3>' +
      '<p class="snxrc-subtitle">Talk about what\'s playing with other listeners.</p>' +
    '</div>' +

    /* composer */
    '<div class="snxrc-composer" id="snxrcComposer">' +
      '<div class="snxrc-composer-inner">' +
        '<textarea id="snxrcTextarea" class="snxrc-textarea"' +
          ' placeholder="Write something about what\'s playing…"' +
          ' maxlength="' + MAX_CHARS + '" rows="2"></textarea>' +
        '<div class="snxrc-composer-foot">' +
          '<span class="snxrc-charcount snxrc-hidden" id="snxrcCharCount"></span>' +
          '<button class="snxrc-post-btn" id="snxrcPostBtn" type="button">POST</button>' +
        '</div>' +
      '</div>' +
      '<p class="snxrc-auth-notice snxrc-hidden" id="snxrcAuthNotice">' +
        'Sign in to join the conversation.' +
      '</p>' +
    '</div>' +

    /* load earlier */
    '<div class="snxrc-earlier-wrap snxrc-hidden" id="snxrcEarlier">' +
      '<button class="snxrc-earlier-btn" id="snxrcEarlierBtn" type="button">Load earlier comments</button>' +
    '</div>' +

    /* list */
    '<div class="snxrc-list" id="snxrcList">' +
      '<div class="snxrc-empty" id="snxrcEmpty">No comments yet. Be the first to say something!</div>' +
    '</div>';

  _container.appendChild(div);
  _el = div;

  /* cache elements */
  E.composer    = document.getElementById('snxrcComposer');
  E.textarea    = document.getElementById('snxrcTextarea');
  E.charCount   = document.getElementById('snxrcCharCount');
  E.postBtn     = document.getElementById('snxrcPostBtn');
  E.authNotice  = document.getElementById('snxrcAuthNotice');
  E.earlierWrap = document.getElementById('snxrcEarlier');
  E.earlierBtn  = document.getElementById('snxrcEarlierBtn');
  E.list        = document.getElementById('snxrcList');
  E.empty       = document.getElementById('snxrcEmpty');

  _updateComposerVisibility();
  _bindEvents();
}

/* ══════════════════════════════════════════════════════════════
   EVENTS
══════════════════════════════════════════════════════════════ */

function _bindEvents() {
  /* Character counter */
  if (E.textarea) {
    E.textarea.addEventListener('input', _onTextareaInput);
  }
  /* Post button */
  if (E.postBtn) {
    E.postBtn.addEventListener('click', _onPost);
  }
  /* Ctrl+Enter also submits */
  if (E.textarea) {
    E.textarea.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        _onPost();
      }
    });
  }
  /* Load earlier */
  if (E.earlierBtn) {
    E.earlierBtn.addEventListener('click', _loadEarlier);
  }
}

function _onTextareaInput() {
  const len  = (E.textarea.value || '').length;
  const left = MAX_CHARS - len;
  if (left <= CHAR_WARN) {
    E.charCount.textContent = left + ' remaining';
    E.charCount.classList.remove('snxrc-hidden');
    E.charCount.classList.toggle('snxrc-charcount--warn', left <= 20);
  } else {
    E.charCount.classList.add('snxrc-hidden');
  }
}

/* ══════════════════════════════════════════════════════════════
   COMPOSER VISIBILITY
══════════════════════════════════════════════════════════════ */

function _isSignedIn() {
  return !!(window._snxAuth && window._snxAuth.currentUser);
}

function _updateComposerVisibility() {
  if (!E.composer) return;
  const signedIn = _isSignedIn();
  if (E.textarea) E.textarea.style.display    = signedIn ? '' : 'none';
  if (E.postBtn)  E.postBtn.style.display     = signedIn ? '' : 'none';
  if (E.charCount) E.charCount.style.display  = signedIn ? '' : 'none';
  if (E.authNotice) {
    if (signedIn) {
      E.authNotice.classList.add('snxrc-hidden');
    } else {
      E.authNotice.classList.remove('snxrc-hidden');
    }
  }
}

/* ══════════════════════════════════════════════════════════════
   POST A COMMENT
══════════════════════════════════════════════════════════════ */

async function _onPost() {
  if (_submitting) return;
  if (!_isSignedIn()) return;

  const msg = (E.textarea ? E.textarea.value : '').trim();
  if (!msg) return;

  /* Resolve current user */
  const user = window._snxAuth.currentUser;
  if (!user) return;

  /* Resolve current track from Radio engine (read-only — no playback interaction) */
  let trackId     = '';
  let trackTitle  = '';
  let trackArtist = '';
  try {
    const track = window.SNXRadio && window.SNXRadio.nowPlaying;
    if (track) {
      trackId     = track.id     || '';
      trackTitle  = track.title  || '';
      trackArtist = track.artist || '';
    }
  } catch (_) {}

  /* Resolve display info */
  const displayName = user.displayName || '';
  const photoURL    = user.photoURL    || '';
  /* Prefer the SNX username from _snxUserData (set after auth resolves) */
  let username = '';
  try {
    const userData = window._snxUserData;
    if (userData) {
      username = userData.username || userData.handle || '';
    }
  } catch (_) {}
  if (!username && displayName) username = displayName;

  /* Build doc */
  const mods = window._snxFirestore;
  if (!mods || !mods.db) {
    console.error('[SNX-RC] Firestore not available');
    return;
  }

  _submitting = true;
  if (E.postBtn) E.postBtn.disabled = true;

  try {
    await mods.addDoc(
      mods.collection(mods.db, COL_COMMENTS),
      {
        uid:         user.uid,
        username:    username,
        displayName: displayName,
        photoURL:    photoURL,
        message:     msg,
        trackId:     trackId,
        trackTitle:  trackTitle,
        trackArtist: trackArtist,
        createdAt:   mods.serverTimestamp(),
      }
    );
    /* Clear textarea */
    if (E.textarea) {
      E.textarea.value = '';
      _onTextareaInput();
    }
  } catch (e) {
    console.error('[SNX-RC] post error:', e.message);
    /* Show brief error toast if available — never affect Radio */
    try {
      if (typeof window.toastNotification === 'function') {
        window.toastNotification('Could not post comment. Please try again.');
      }
    } catch (_) {}
  } finally {
    _submitting = false;
    if (E.postBtn) E.postBtn.disabled = false;
  }
}

/* ══════════════════════════════════════════════════════════════
   FIRESTORE SUBSCRIPTION
══════════════════════════════════════════════════════════════ */

function _subscribe() {
  const mods = window._snxFirestore;
  if (!mods || !mods.db) {
    /* Firebase not ready yet — retry once */
    setTimeout(_subscribe, 1200);
    return;
  }

  try {
    const q = mods.query(
      mods.collection(mods.db, COL_COMMENTS),
      mods.orderBy('createdAt', 'desc'),
      mods.limit(PAGE_SIZE)
    );

    _unsub = mods.onSnapshot(q, function(snap) {
      _hasEarlier = snap.docs.length >= PAGE_SIZE;
      _lastDoc    = snap.docs[snap.docs.length - 1] || null;

      /* Rebuild comments array newest-first */
      _comments = snap.docs.map(function(d) {
        return Object.assign({ _id: d.id }, d.data());
      });

      _render();

      /* Show/hide "Load earlier" */
      if (E.earlierWrap) {
        if (_hasEarlier) {
          E.earlierWrap.classList.remove('snxrc-hidden');
        } else {
          E.earlierWrap.classList.add('snxrc-hidden');
        }
      }
    }, function(err) {
      console.warn('[SNX-RC] snapshot error:', err.message);
      /* Silently degrade — Radio keeps playing */
    });

    console.log('[SNX-RC] subscribed to /radioComments');
  } catch (e) {
    console.warn('[SNX-RC] subscribe error:', e.message);
  }
}

function _unsubscribe() {
  if (_unsub) {
    try { _unsub(); } catch (_) {}
    _unsub = null;
    console.log('[SNX-RC] unsubscribed from /radioComments');
  }
}

/* ══════════════════════════════════════════════════════════════
   LOAD EARLIER (pagination)
══════════════════════════════════════════════════════════════ */

async function _loadEarlier() {
  if (!_lastDoc) return;
  const mods = window._snxFirestore;
  if (!mods || !mods.db) return;

  if (E.earlierBtn) E.earlierBtn.disabled = true;

  try {
    const q = mods.query(
      mods.collection(mods.db, COL_COMMENTS),
      mods.orderBy('createdAt', 'desc'),
      mods.startAfter(_lastDoc),
      mods.limit(PAGE_SIZE)
    );
    const snap = await mods.getDocs(q);
    const older = snap.docs.map(function(d) {
      return Object.assign({ _id: d.id }, d.data());
    });

    if (older.length > 0) {
      _lastDoc    = snap.docs[snap.docs.length - 1];
      _hasEarlier = snap.docs.length >= PAGE_SIZE;
      /* Append at end (they are older) */
      _comments = _comments.concat(older);
      _render();
    } else {
      _hasEarlier = false;
    }

    if (E.earlierWrap) {
      if (_hasEarlier) {
        E.earlierWrap.classList.remove('snxrc-hidden');
      } else {
        E.earlierWrap.classList.add('snxrc-hidden');
      }
    }
  } catch (e) {
    console.warn('[SNX-RC] loadEarlier error:', e.message);
  } finally {
    if (E.earlierBtn) E.earlierBtn.disabled = false;
  }
}

/* ══════════════════════════════════════════════════════════════
   RENDER
══════════════════════════════════════════════════════════════ */

function _render() {
  if (!E.list) return;

  /* Refresh composer visibility on every render (handles sign-in after mount) */
  _updateComposerVisibility();

  if (_comments.length === 0) {
    E.list.innerHTML = '<div class="snxrc-empty" id="snxrcEmpty">No comments yet. Be the first to say something!</div>';
    E.empty = document.getElementById('snxrcEmpty');
    return;
  }

  const myUid    = window._snxAuth && window._snxAuth.currentUser
                   ? window._snxAuth.currentUser.uid : null;
  const isFounder = window._snxRole === 'founder';

  const html = _comments.map(function(c) {
    return _renderComment(c, myUid, isFounder);
  }).join('');

  E.list.innerHTML = html;

  /* Bind delete buttons */
  E.list.querySelectorAll('.snxrc-del-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var commentId = btn.getAttribute('data-id');
      _confirmDelete(commentId);
    });
  });
}

function _renderComment(c, myUid, isFounder) {
  var canDelete = isFounder || (myUid && c.uid === myUid);

  /* Avatar */
  var avatarHtml = c.photoURL
    ? '<img class="snxrc-avatar" src="' + _esc(c.photoURL) + '" alt="" loading="lazy">'
    : '<div class="snxrc-avatar snxrc-avatar--fallback">' + _initials(c.displayName || c.username || '?') + '</div>';

  /* Name */
  var name = _esc(c.displayName || c.username || 'Listener');
  var handle = c.username ? '<span class="snxrc-handle">@' + _esc(c.username) + '</span>' : '';

  /* Time */
  var timeStr = _fmtTime(c.createdAt);

  /* Track context */
  var trackLine = '';
  if (c.trackTitle || c.trackArtist) {
    var tStr = [c.trackTitle, c.trackArtist].filter(Boolean).join(' — ');
    trackLine = '<div class="snxrc-track-ctx">🎵 ' + _esc(tStr) + '</div>';
  }

  /* Delete button */
  var delBtn = canDelete
    ? '<button class="snxrc-del-btn" data-id="' + _esc(c._id) + '" title="Delete comment" aria-label="Delete comment">✕</button>'
    : '';

  return (
    '<div class="snxrc-comment" data-id="' + _esc(c._id) + '">' +
      '<div class="snxrc-comment-left">' + avatarHtml + '</div>' +
      '<div class="snxrc-comment-body">' +
        '<div class="snxrc-comment-meta">' +
          '<span class="snxrc-name">' + name + '</span>' +
          handle +
          '<span class="snxrc-time">' + timeStr + '</span>' +
          delBtn +
        '</div>' +
        '<p class="snxrc-message">' + _esc(c.message) + '</p>' +
        trackLine +
      '</div>' +
    '</div>'
  );
}

/* ══════════════════════════════════════════════════════════════
   DELETE
══════════════════════════════════════════════════════════════ */

function _confirmDelete(commentId) {
  if (!commentId) return;
  if (!confirm('Delete this comment?')) return;
  _deleteComment(commentId);
}

async function _deleteComment(commentId) {
  const mods = window._snxFirestore;
  if (!mods || !mods.db) return;
  try {
    await mods.deleteDoc(mods.doc(mods.db, COL_COMMENTS, commentId));
  } catch (e) {
    console.error('[SNX-RC] delete error:', e.message);
    try {
      if (typeof window.toastNotification === 'function') {
        window.toastNotification('Could not delete comment.');
      }
    } catch (_) {}
  }
}

/* ══════════════════════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════════════════════ */

function _fmtTime(ts) {
  if (!ts) return '';
  var ms;
  if (ts && typeof ts.toMillis === 'function') {
    ms = ts.toMillis();
  } else if (ts && ts.seconds) {
    ms = ts.seconds * 1000;
  } else if (typeof ts === 'number') {
    ms = ts;
  } else {
    return '';
  }
  var d   = new Date(ms);
  var now = Date.now();
  var diff = now - ms;
  if (diff < 60000)  return 'just now';
  if (diff < 3600000) {
    var m = Math.floor(diff / 60000);
    return m + 'm ago';
  }
  if (diff < 86400000) {
    var h = Math.floor(diff / 3600000);
    return h + 'h ago';
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function _initials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

})();
