/**
 * snx-radio-submit.js — Shadow Nexus Radio · Music Submission
 * Build: SNS-2026-RADIO-SUBMIT-001
 *
 * Purpose:
 *   Provides a self-contained "Submit Your Music" panel that artists can use
 *   to upload a track for consideration on Shadow Nexus Radio.
 *
 * Architecture:
 *   - Renders a form inside a provided container element.
 *   - Uploads audio (and optional artwork) via the existing chunked Worker
 *     endpoints (/upload-chunk + /upload-complete).
 *   - Writes a /radioSubmissions/{subId} document to Firestore with status:'pending'.
 *   - Firestore security rules enforce:
 *       • submittedByUid == auth.uid  (no impersonation)
 *       • ownershipConfirmed == true  (copyright gate)
 *       • status == 'pending'  (no auto-approval on create)
 *   - Approved tracks are promoted to /radioTracks by the Founder via
 *     SNXRadioSubmissions.approveToRadio() (called from Studio admin panel).
 *
 * Public API (window.SNXRadioSubmit):
 *   mount(containerEl)  — render form into containerEl (idempotent)
 *   unmount()           — tear down, remove DOM
 *   loadMySubmissions() — refresh the user's own submission history
 *
 * Dependencies (available as globals when radio feature is loaded):
 *   window._snxFirestore    — Firestore instance
 *   window._snxAuth         — Firebase Auth instance
 *   window._getFirestoreMods() — returns { collection, addDoc, getDocs, query,
 *                                           where, orderBy, serverTimestamp }
 *
 * Storage:
 *   R2 via Worker endpoints (same as snx-radio-studio.js uses).
 *   Audio stored at:  submissions/{uid}/{uploadId}.{ext}
 *   Artwork stored at: submissions/{uid}/art_{uploadId}.{ext}
 *
 * Does NOT touch:
 *   Radio playback · timeline · epoch · DJ · Broadcast · Live · Shadow Reaper
 */

'use strict';

(function () {

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════════ */

const VERSION        = 'SNS-2026-RADIO-SUBMIT-001';
const WORKER_BASE    = 'https://yellow-term-11e6.nthntjrn.workers.dev';
const COL_SUBS       = 'radioSubmissions';

const MAX_AUDIO_BYTES   = 200 * 1024 * 1024;  // 200 MB
const MAX_ART_BYTES     =  10 * 1024 * 1024;  // 10 MB
const CHUNK_SIZE        =   5 * 1024 * 1024;  // 5 MB per chunk

const ALLOWED_AUDIO = ['audio/mpeg','audio/mp3','audio/wav','audio/x-wav',
                       'audio/flac','audio/x-flac','audio/aac','audio/ogg',
                       'audio/m4a','audio/mp4','audio/x-m4a'];
const ALLOWED_IMAGE = ['image/jpeg','image/png','image/webp','image/gif'];

/* ═══════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════ */

let _container    = null;
let _mounted      = false;
let _submitting   = false;

/* ═══════════════════════════════════════════════════════════════
   PUBLIC API
═══════════════════════════════════════════════════════════════ */

window.SNXRadioSubmit = {
  mount,
  unmount,
  loadMySubmissions,
  get version() { return VERSION; },
};

/* ═══════════════════════════════════════════════════════════════
   MOUNT / UNMOUNT
═══════════════════════════════════════════════════════════════ */

function mount(containerEl) {
  if (_mounted || !containerEl) return;
  _container = containerEl;
  _buildDOM();
  _bindEvents();
  _mounted = true;
  loadMySubmissions();
}

function unmount() {
  if (!_mounted) return;
  if (_container) _container.innerHTML = '';
  _container  = null;
  _mounted    = false;
  _submitting = false;
}

/* ═══════════════════════════════════════════════════════════════
   DOM BUILDER
═══════════════════════════════════════════════════════════════ */

function _buildDOM() {
  _container.innerHTML = `
<div class="snxsub-wrap">

  <!-- ── HEADER ──────────────────────────────────────────── -->
  <div class="snxsub-header">
    <div class="snxsub-header-icon">🎵</div>
    <div>
      <div class="snxsub-header-title">Submit Your Music</div>
      <div class="snxsub-header-sub">Share your original music for possible airplay on Shadow Nexus Radio</div>
    </div>
  </div>

  <!-- ── NOTICE ───────────────────────────────────────────── -->
  <div class="snxsub-notice">
    <div class="snxsub-notice-title">📋 Before You Submit</div>
    <ul class="snxsub-notice-list">
      <li>You must own the recording or hold sufficient rights to authorize its broadcast.</li>
      <li>Submission does not guarantee airplay — all tracks are reviewed by the station administrator.</li>
      <li>Only you and the station administrator can see your submission.</li>
      <li>To request removal of a previously submitted track, use the contact link below.</li>
    </ul>
  </div>

  <!-- ── FORM ─────────────────────────────────────────────── -->
  <form class="snxsub-form" id="snxSubForm" autocomplete="off" novalidate>

    <div class="snxsub-field-row">
      <div class="snxsub-field snxsub-field--half">
        <label class="snxsub-label" for="snxSubArtist">Artist Name *</label>
        <input class="snxsub-input" id="snxSubArtist" type="text" maxlength="120"
               placeholder="Your artist or band name" autocomplete="off" />
      </div>
      <div class="snxsub-field snxsub-field--half">
        <label class="snxsub-label" for="snxSubTitle">Song Title *</label>
        <input class="snxsub-input" id="snxSubTitle" type="text" maxlength="180"
               placeholder="Name of the track" autocomplete="off" />
      </div>
    </div>

    <div class="snxsub-field">
      <label class="snxsub-label" for="snxSubGenre">Genre <span class="snxsub-optional">(optional)</span></label>
      <input class="snxsub-input" id="snxSubGenre" type="text" maxlength="60"
             placeholder="e.g. Hip-Hop, R&amp;B, Electronic, Rock…" autocomplete="off" />
    </div>

    <div class="snxsub-field">
      <label class="snxsub-label" for="snxSubDesc">Artist / Track Description <span class="snxsub-optional">(optional)</span></label>
      <textarea class="snxsub-input snxsub-textarea" id="snxSubDesc" rows="3" maxlength="800"
                placeholder="Tell us about the track or yourself as an artist…"></textarea>
    </div>

    <div class="snxsub-field">
      <label class="snxsub-label" for="snxSubContact">Contact Email <span class="snxsub-optional">(optional)</span></label>
      <input class="snxsub-input" id="snxSubContact" type="email" maxlength="200"
             placeholder="So we can follow up about your submission" autocomplete="off" />
      <div class="snxsub-field-hint">Your contact email is only visible to the station administrator, never publicly displayed.</div>
    </div>

    <!-- ── AUDIO UPLOAD ──────────────────────────────────── -->
    <div class="snxsub-field">
      <label class="snxsub-label" for="snxSubAudio">Audio File * <span class="snxsub-optional">(MP3, WAV, FLAC, AAC, OGG — max 200 MB)</span></label>
      <div class="snxsub-dropzone" id="snxSubAudioDrop">
        <input type="file" id="snxSubAudio" accept="audio/*" class="snxsub-file-input" />
        <div class="snxsub-dropzone-label">
          <span class="snxsub-dropzone-icon">🎵</span>
          <span id="snxSubAudioName">Tap to choose audio file</span>
        </div>
      </div>
      <div class="snxsub-progress-wrap snxsub-hidden" id="snxSubAudioProgressWrap">
        <div class="snxsub-progress-bar" id="snxSubAudioProgressBar"></div>
      </div>
    </div>

    <!-- ── ARTWORK UPLOAD ────────────────────────────────── -->
    <div class="snxsub-field">
      <label class="snxsub-label" for="snxSubArt">Artwork <span class="snxsub-optional">(optional — JPEG, PNG, WebP — max 10 MB)</span></label>
      <div class="snxsub-dropzone" id="snxSubArtDrop">
        <input type="file" id="snxSubArt" accept="image/*" class="snxsub-file-input" />
        <div class="snxsub-dropzone-label">
          <span class="snxsub-dropzone-icon" id="snxSubArtPreviewIcon">🖼️</span>
          <span id="snxSubArtName">Tap to choose artwork (optional)</span>
        </div>
        <img id="snxSubArtPreview" class="snxsub-art-preview snxsub-hidden" alt="Artwork preview" />
      </div>
    </div>

    <!-- ── OWNERSHIP CONFIRMATION ────────────────────────── -->
    <label class="snxsub-check-label" id="snxSubOwnershipLabel">
      <input type="checkbox" id="snxSubOwnership" />
      <span class="snxsub-check-box"></span>
      <span class="snxsub-check-text">
        I confirm that I own this recording or hold sufficient rights to authorize its broadcast on Shadow Nexus Radio.
        I understand that submitting this track does not guarantee airplay, and I can request its removal at any time.
      </span>
    </label>

    <!-- ── STATUS MESSAGE ────────────────────────────────── -->
    <div class="snxsub-status snxsub-hidden" id="snxSubStatus"></div>

    <!-- ── SUBMIT BUTTON ─────────────────────────────────── -->
    <button class="snxsub-submit-btn" id="snxSubSubmitBtn" type="submit">
      <span id="snxSubSubmitLabel">Submit Track for Review</span>
    </button>

    <div class="snxsub-contact-line">
      Questions about a submission? Contact the station at
      <a href="mailto:christijerina46@gmail.com" class="snxsub-link">christijerina46@gmail.com</a>
    </div>

  </form>

  <!-- ── MY SUBMISSIONS ────────────────────────────────────── -->
  <div class="snxsub-mysubs-section">
    <div class="snxsub-mysubs-header">
      <div class="snxsub-mysubs-title">📂 My Submissions</div>
      <button class="snxsub-refresh-btn" id="snxSubRefreshBtn" type="button">↺ Refresh</button>
    </div>
    <div id="snxSubMyList" class="snxsub-mysubs-list">
      <div class="snxsub-mysubs-empty">Loading your submissions…</div>
    </div>
  </div>

</div>
`;
}

/* ═══════════════════════════════════════════════════════════════
   EVENT BINDING
═══════════════════════════════════════════════════════════════ */

function _bindEvents() {
  const form          = _el('snxSubForm');
  const audioInput    = _el('snxSubAudio');
  const artInput      = _el('snxSubArt');
  const refreshBtn    = _el('snxSubRefreshBtn');

  if (form)       form.addEventListener('submit', _onSubmit);
  if (refreshBtn) refreshBtn.addEventListener('click', loadMySubmissions);

  if (audioInput) {
    audioInput.addEventListener('change', function () {
      const f = audioInput.files && audioInput.files[0];
      const nameEl = _el('snxSubAudioName');
      if (nameEl) nameEl.textContent = f ? f.name : 'Tap to choose audio file';
    });
  }

  if (artInput) {
    artInput.addEventListener('change', function () {
      const f = artInput.files && artInput.files[0];
      const nameEl   = _el('snxSubArtName');
      const preview  = _el('snxSubArtPreview');
      const iconEl   = _el('snxSubArtPreviewIcon');
      if (!f) {
        if (nameEl)  nameEl.textContent  = 'Tap to choose artwork (optional)';
        if (preview) { preview.src = ''; preview.classList.add('snxsub-hidden'); }
        if (iconEl)  iconEl.style.display = '';
        return;
      }
      if (nameEl) nameEl.textContent = f.name;
      if (preview && ALLOWED_IMAGE.includes(f.type.toLowerCase().split(';')[0].trim())) {
        const reader = new FileReader();
        reader.onload = function (e) {
          preview.src = e.target.result;
          preview.classList.remove('snxsub-hidden');
          if (iconEl) iconEl.style.display = 'none';
        };
        reader.readAsDataURL(f);
      }
    });
  }
}

/* ═══════════════════════════════════════════════════════════════
   FORM SUBMISSION
═══════════════════════════════════════════════════════════════ */

async function _onSubmit(e) {
  e.preventDefault();
  if (_submitting) return;

  // ── Auth check ──────────────────────────────────────────────
  const auth = window._snxAuth;
  const user = auth && auth.currentUser;
  if (!user || !user.uid) {
    _showStatus('You must be signed in to submit music.', 'err');
    return;
  }
  if (user.isAnonymous) {
    _showStatus('Anonymous accounts cannot submit music. Please create a full account.', 'err');
    return;
  }

  // ── Validate fields ─────────────────────────────────────────
  const artistName = (_val('snxSubArtist') || '').trim();
  const songTitle  = (_val('snxSubTitle')  || '').trim();
  const genre      = (_val('snxSubGenre')  || '').trim();
  const description= (_val('snxSubDesc')   || '').trim();
  const contactEmail=(_val('snxSubContact')|| '').trim();
  const ownership  = _el('snxSubOwnership') && _el('snxSubOwnership').checked;

  if (!artistName) { _showStatus('Artist name is required.', 'err'); _el('snxSubArtist') && _el('snxSubArtist').focus(); return; }
  if (!songTitle)  { _showStatus('Song title is required.', 'err');  _el('snxSubTitle')  && _el('snxSubTitle').focus();  return; }
  if (!ownership)  { _showStatus('You must confirm ownership rights before submitting.', 'err'); return; }

  const audioInput = _el('snxSubAudio');
  const audioFile  = audioInput && audioInput.files && audioInput.files[0];
  if (!audioFile) { _showStatus('Please choose an audio file.', 'err'); return; }

  const audioMime = (audioFile.type || '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED_AUDIO.includes(audioMime) && !audioMime.startsWith('audio/')) {
    _showStatus('File type not accepted. Please upload an MP3, WAV, FLAC, AAC, or OGG file.', 'err');
    return;
  }
  if (audioFile.size > MAX_AUDIO_BYTES) {
    _showStatus('Audio file is too large (max 200 MB).', 'err');
    return;
  }

  const artInput   = _el('snxSubArt');
  const artFile    = artInput && artInput.files && artInput.files[0];
  if (artFile) {
    const artMime = (artFile.type || '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_IMAGE.includes(artMime) && !artMime.startsWith('image/')) {
      _showStatus('Artwork must be a JPEG, PNG, or WebP image.', 'err');
      return;
    }
    if (artFile.size > MAX_ART_BYTES) {
      _showStatus('Artwork file is too large (max 10 MB).', 'err');
      return;
    }
  }

  // ── Get ID token ────────────────────────────────────────────
  let idToken;
  try { idToken = await user.getIdToken(true); }
  catch (err) { _showStatus('Authentication error. Please refresh and try again.', 'err'); return; }

  _submitting = true;
  _setSubmitBusy(true);
  _showStatus('Uploading audio…', 'info');

  // ── Upload audio ─────────────────────────────────────────────
  let audioUrl = null;
  let audioKey = null;
  try {
    const audioExt   = _extFromMime(audioMime) || _extFromName(audioFile.name) || 'audio';
    const uploadId   = _uid();
    audioKey = `submissions/${user.uid}/${uploadId}.${audioExt}`;
    const prog = _el('snxSubAudioProgressWrap');
    if (prog) prog.classList.remove('snxsub-hidden');
    const res = await _chunkedUpload(audioFile, audioKey, idToken, function (pct) {
      const bar = _el('snxSubAudioProgressBar');
      if (bar) bar.style.width = pct + '%';
    });
    audioUrl = res.url;
    if (!audioUrl) throw new Error('Upload returned no URL.');
  } catch (err) {
    _submitting = false;
    _setSubmitBusy(false);
    _showStatus('Audio upload failed: ' + (err.message || 'Unknown error'), 'err');
    return;
  }

  // ── Upload artwork (optional) ─────────────────────────────────
  let artworkUrl = null;
  let artworkKey = null;
  if (artFile) {
    _showStatus('Uploading artwork…', 'info');
    try {
      const artMime  = (artFile.type || '').toLowerCase().split(';')[0].trim();
      const artExt   = _extFromMime(artMime) || _extFromName(artFile.name) || 'jpg';
      const artId    = _uid();
      artworkKey = `submissions/${user.uid}/art_${artId}.${artExt}`;
      const res2 = await _chunkedUpload(artFile, artworkKey, idToken, function () {});
      artworkUrl = res2.url;
    } catch (err) {
      // Artwork upload failure is non-fatal — warn and continue
      console.warn('[SNXRadioSubmit] Artwork upload failed (non-fatal):', err.message);
    }
  }

  // ── Write Firestore submission doc ────────────────────────────
  _showStatus('Saving submission…', 'info');
  try {
    const mods = await _getFirestoreMods();
    const db   = (window._snxFirestore && window._snxFirestore.db) || window._snxFirestore;
    if (!db || !mods) throw new Error('Firestore not ready');

    const docData = {
      submittedByUid:     user.uid,
      submittedByName:    user.displayName || user.email || '',
      artistName,
      songTitle,
      genre:              genre      || '',
      description:        description|| '',
      contactEmail:       contactEmail || '',
      ownershipConfirmed: true,
      audioUrl,
      audioKey,
      artworkUrl:         artworkUrl  || '',
      artworkKey:         artworkKey  || '',
      status:             'pending',
      reviewNote:         '',
      submittedAt:        mods.serverTimestamp(),
      reviewedAt:         null,
    };

    await mods.addDoc(mods.collection(db, COL_SUBS), docData);
  } catch (err) {
    _submitting = false;
    _setSubmitBusy(false);
    _showStatus('Submission failed: ' + (err.message || 'Unknown error'), 'err');
    return;
  }

  // ── Success ───────────────────────────────────────────────────
  _submitting = false;
  _setSubmitBusy(false);
  _showStatus('✅ Track submitted! We\'ll review it and get back to you.', 'ok');
  _resetForm();
  loadMySubmissions();
}

/* ═══════════════════════════════════════════════════════════════
   MY SUBMISSIONS LIST
═══════════════════════════════════════════════════════════════ */

async function loadMySubmissions() {
  const listEl = _el('snxSubMyList');
  if (!listEl) return;

  const auth = window._snxAuth;
  const user = auth && auth.currentUser;
  if (!user || !user.uid || user.isAnonymous) {
    listEl.innerHTML = '<div class="snxsub-mysubs-empty">Sign in to see your submissions.</div>';
    return;
  }

  listEl.innerHTML = '<div class="snxsub-mysubs-empty">Loading…</div>';

  try {
    const mods = await _getFirestoreMods();
    const db   = (window._snxFirestore && window._snxFirestore.db) || window._snxFirestore;
    if (!db || !mods) throw new Error('Firestore not ready');

    const q = mods.query(
      mods.collection(db, COL_SUBS),
      mods.where('submittedByUid', '==', user.uid),
      mods.orderBy('submittedAt', 'desc')
    );
    const snap = await mods.getDocs(q);
    if (snap.empty) {
      listEl.innerHTML = '<div class="snxsub-mysubs-empty">No submissions yet.</div>';
      return;
    }

    let html = '';
    snap.forEach(function (doc) {
      const d = doc.data();
      const status = d.status || 'pending';
      const statusClass = status === 'approved' ? 'snxsub-status-badge--ok'
                        : status === 'rejected'  ? 'snxsub-status-badge--err'
                        : 'snxsub-status-badge--pending';
      const statusLabel = status === 'approved' ? '✅ Approved'
                        : status === 'rejected'  ? '✗ Not Selected'
                        : '⏳ Pending Review';
      const artHtml = d.artworkUrl
        ? `<img src="${_esc(d.artworkUrl)}" class="snxsub-mysub-art" alt="artwork" />`
        : `<div class="snxsub-mysub-art-fallback">🎵</div>`;
      const reviewNote = d.reviewNote
        ? `<div class="snxsub-mysub-note">Note: ${_esc(d.reviewNote)}</div>`
        : '';
      html += `
<div class="snxsub-mysub-row">
  ${artHtml}
  <div class="snxsub-mysub-info">
    <div class="snxsub-mysub-title">${_esc(d.songTitle || '—')}</div>
    <div class="snxsub-mysub-artist">${_esc(d.artistName || '—')}</div>
    ${d.genre ? `<div class="snxsub-mysub-genre">${_esc(d.genre)}</div>` : ''}
    ${reviewNote}
  </div>
  <div class="snxsub-status-badge ${statusClass}">${statusLabel}</div>
</div>`;
    });
    listEl.innerHTML = html;
  } catch (err) {
    listEl.innerHTML = `<div class="snxsub-mysubs-empty" style="color:#ff8899;">Could not load submissions: ${_esc(err.message || '')}</div>`;
  }
}

/* ═══════════════════════════════════════════════════════════════
   CHUNKED UPLOAD (reuses existing Worker endpoints)
═══════════════════════════════════════════════════════════════ */

async function _chunkedUpload(file, r2Key, idToken, onProgress) {
  const totalChunks  = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId     = _uid();

  // Phase 1 — upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const blob  = file.slice(start, start + CHUNK_SIZE);
    const fd    = new FormData();
    fd.append('uploadId',    uploadId);
    fd.append('chunkIndex',  String(i));
    fd.append('totalChunks', String(totalChunks));
    fd.append('chunk', blob, file.name);

    const res = await fetch(WORKER_BASE + '/upload-chunk', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + idToken },
      body: fd,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || ('Chunk upload failed (' + res.status + ')'));
    }
    onProgress(Math.round(((i + 1) / totalChunks) * 90));
  }

  // Phase 2 — assemble
  const fd2 = new FormData();
  fd2.append('uploadId',    uploadId);
  fd2.append('totalChunks', String(totalChunks));
  fd2.append('key',         r2Key);
  fd2.append('fileName',    file.name);
  fd2.append('fileType',    file.type || 'application/octet-stream');
  fd2.append('fileSize',    String(file.size));

  const res2 = await fetch(WORKER_BASE + '/upload-complete', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + idToken },
    body: fd2,
  });
  if (!res2.ok) {
    const body2 = await res2.json().catch(() => ({}));
    throw new Error(body2.error || ('Assembly failed (' + res2.status + ')'));
  }

  onProgress(100);
  return await res2.json();  // { url, key }
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

function _resetForm() {
  const form = _el('snxSubForm');
  if (form) form.reset();
  const audioName = _el('snxSubAudioName');
  if (audioName) audioName.textContent = 'Tap to choose audio file';
  const artName = _el('snxSubArtName');
  if (artName)   artName.textContent = 'Tap to choose artwork (optional)';
  const artPreview = _el('snxSubArtPreview');
  if (artPreview) { artPreview.src = ''; artPreview.classList.add('snxsub-hidden'); }
  const artIcon = _el('snxSubArtPreviewIcon');
  if (artIcon)  artIcon.style.display = '';
  const prog = _el('snxSubAudioProgressWrap');
  if (prog) prog.classList.add('snxsub-hidden');
  const bar  = _el('snxSubAudioProgressBar');
  if (bar)  bar.style.width = '0%';
}

function _showStatus(msg, type) {
  const el = _el('snxSubStatus');
  if (!el) return;
  el.textContent = msg;
  el.className   = 'snxsub-status';
  if (type === 'ok')   el.classList.add('snxsub-status--ok');
  if (type === 'err')  el.classList.add('snxsub-status--err');
  if (type === 'info') el.classList.add('snxsub-status--info');
  el.classList.remove('snxsub-hidden');
}

function _setSubmitBusy(busy) {
  const btn   = _el('snxSubSubmitBtn');
  const label = _el('snxSubSubmitLabel');
  if (!btn) return;
  btn.disabled = busy;
  if (label) label.textContent = busy ? 'Uploading…' : 'Submit Track for Review';
}

function _el(id) { return _container ? _container.querySelector('#' + id) : null; }
function _val(id) { const e = _el(id); return e ? e.value : ''; }
function _esc(s) { return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function _uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 9); }

function _extFromMime(mime) {
  const m = { 'audio/mpeg':'mp3','audio/mp3':'mp3','audio/wav':'wav','audio/x-wav':'wav',
              'audio/flac':'flac','audio/x-flac':'flac','audio/aac':'aac',
              'audio/ogg':'ogg','audio/m4a':'m4a','audio/mp4':'m4a','audio/x-m4a':'m4a',
              'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif' };
  return m[mime] || null;
}

function _extFromName(name) {
  const parts = (name || '').split('.');
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase().replace(/[^a-z0-9]/g,'') : '';
}

async function _getFirestoreMods() {
  if (window._getFirestoreMods) return window._getFirestoreMods();
  // Fallback: lazy import Firestore modular API
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js');
    return {
      collection:      mod.collection,
      addDoc:          mod.addDoc,
      getDocs:         mod.getDocs,
      query:           mod.query,
      where:           mod.where,
      orderBy:         mod.orderBy,
      serverTimestamp: mod.serverTimestamp,
    };
  } catch (_) { return null; }
}

})();
