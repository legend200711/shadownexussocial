/**
 * snx-music-storage.js — Shadow Nexus Music Hub 2.0
 * Storage Router
 *
 * Abstracts Cloudflare R2 and Supabase Storage behind one interface.
 * UI components NEVER call R2 or Supabase directly — they call MusicStorage.
 *
 * Provider values:  'cloudflare' | 'supabase' | 'legacy'
 *
 * Architecture:
 *   - uploadTrack(file, options)  → { trackId, storageKey, playbackUrl, provider }
 *   - getPlaybackUrl(track)       → string
 *   - deleteTrack(track)          → Promise<void>
 *   - checkHealth()               → { cloudflare, supabase }
 *   - getProvider(track)          → 'cloudflare' | 'supabase' | 'legacy'
 *
 * Secrets: R2 credentials stay inside the Cloudflare Worker.
 *          Supabase anon/publishable key is used for Storage reads only.
 *          The Worker proxies authenticated Supabase uploads server-side.
 */

'use strict';

(function () {

  /* ── Constants ─────────────────────────────────────────────── */
  var WORKER_URL   = 'https://yellow-term-11e6.nthntjrn.workers.dev';
  var SUPABASE_URL = 'https://nxsyoreuwmmxtuvmeqbg.supabase.co';
  var MUSIC_BUCKET = 'snx-music';  // Supabase bucket for Music Hub 2.0

  /* ── Auth helper ───────────────────────────────────────────── */
  function _getIdToken() {
    var user = (window._snxAuth && window._snxAuth.currentUser)
             ? window._snxAuth.currentUser
             : (window._snxCurrentUser || null);
    if (!user) return Promise.reject(new Error('Not signed in'));
    if (typeof user.getIdToken !== 'function') return Promise.reject(new Error('Invalid auth session'));
    return user.getIdToken(true);
  }

  function _getUid() {
    var user = (window._snxAuth && window._snxAuth.currentUser)
             ? window._snxAuth.currentUser
             : (window._snxCurrentUser || null);
    return user ? user.uid : null;
  }

  /* ── Track ID generator ────────────────────────────────────── */
  function _genTrackId() {
    return 'mh' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ════════════════════════════════════════════════════════════
     uploadTrack(file, options)
     ────────────────────────────────────────────────────────────
     options = {
       provider:   'auto' | 'cloudflare' | 'supabase'  (default: 'auto')
       trackId:    string  (generated if not supplied)
       onProgress: function(pct, bytesPerSec)
     }
     Returns Promise<{ trackId, storageKey, playbackUrl, provider }>
  ════════════════════════════════════════════════════════════ */
  function uploadTrack(file, options) {
    options = options || {};
    var provider  = options.provider || 'auto';
    var trackId   = options.trackId  || _genTrackId();
    var uid       = _getUid();
    if (!uid) return Promise.reject(new Error('Not signed in'));

    // AUTO: prefer Cloudflare R2
    if (provider === 'auto' || provider === 'cloudflare') {
      return _uploadToR2(file, trackId, uid, options.onProgress)
        .then(function (r) { return { trackId: trackId, storageKey: r.key, playbackUrl: r.url, provider: 'cloudflare' }; })
        .catch(function (err) {
          if (provider === 'cloudflare') throw err; // explicit Cloudflare — don't fall through
          // AUTO fallback — surface the original error, let caller decide
          err._r2Failed = true;
          throw err;
        });
    }

    if (provider === 'supabase') {
      return _uploadToSupabase(file, trackId, uid, options.onProgress)
        .then(function (r) { return { trackId: trackId, storageKey: r.key, playbackUrl: r.url, provider: 'supabase' }; });
    }

    return Promise.reject(new Error('Unknown provider: ' + provider));
  }

  /* ── Upload artwork ────────────────────────────────────────── */
  function uploadArtwork(file, trackId, options) {
    options = options || {};
    var provider = options.provider || 'cloudflare';
    var uid      = _getUid();
    if (!uid) return Promise.reject(new Error('Not signed in'));

    if (provider === 'supabase') {
      return _uploadToSupabase(file, trackId + '_art', uid, options.onProgress)
        .then(function (r) { return { storageKey: r.key, url: r.url, provider: 'supabase' }; });
    }

    // Default: R2
    var key = 'music/' + uid + '/' + trackId + '/cover.' + _ext(file.name);
    return _r2Upload(key, file, options.onProgress)
      .then(function (r) { return { storageKey: r.key, url: r.url, provider: 'cloudflare' }; });
  }

  /* ════════════════════════════════════════════════════════════
     getPlaybackUrl(track)
     Resolves the correct playable URL regardless of provider.
  ════════════════════════════════════════════════════════════ */
  function getPlaybackUrl(track) {
    if (!track) return '';
    var provider = track.storageProvider || 'legacy';

    if (provider === 'cloudflare') {
      if (track.playbackReference) return track.playbackReference;
      if (track.storageKey) return WORKER_URL + '/' + track.storageKey;
    }

    if (provider === 'supabase') {
      if (track.playbackReference) return track.playbackReference;
      if (track.storageKey) {
        return SUPABASE_URL + '/storage/v1/object/public/' + MUSIC_BUCKET + '/' + track.storageKey;
      }
    }

    // Legacy: old fields from profile-music.js / studio.js
    return track.musicUrl || track.downloadURL || track.url || '';
  }

  /* ════════════════════════════════════════════════════════════
     getArtworkUrl(track)
  ════════════════════════════════════════════════════════════ */
  function getArtworkUrl(track) {
    if (!track) return '';
    var ap = track.artworkProvider || track.storageProvider || 'legacy';
    if (ap === 'cloudflare' && track.artworkKey)
      return WORKER_URL + '/' + track.artworkKey;
    if (ap === 'supabase' && track.artworkKey)
      return SUPABASE_URL + '/storage/v1/object/public/' + MUSIC_BUCKET + '/' + track.artworkKey;
    return track.artworkUrl || track.coverUrl || track.coverArt || '';
  }

  /* ════════════════════════════════════════════════════════════
     deleteTrack(track)
     Removes the media object from the correct storage provider.
  ════════════════════════════════════════════════════════════ */
  function deleteTrack(track) {
    if (!track) return Promise.resolve();
    var provider = track.storageProvider || 'legacy';

    if (provider === 'cloudflare' && track.storageKey) {
      return _deleteR2(track.storageKey);
    }

    if (provider === 'supabase' && track.storageKey) {
      return _deleteSupabase(track.storageKey);
    }

    // Legacy: try r2Key from old schema
    if (track.r2Key) return _deleteR2(track.r2Key);

    return Promise.resolve(); // legacy without key — nothing to delete
  }

  /* ════════════════════════════════════════════════════════════
     checkHealth()
     Returns { cloudflare: 'ok'|'error', supabase: 'ok'|'error' }
  ════════════════════════════════════════════════════════════ */
  function checkHealth() {
    var results = { cloudflare: 'checking', supabase: 'checking' };

    var cfCheck = fetch(WORKER_URL + '/upload-health?_=' + Date.now(), { method: 'GET' })
      .then(function (r) { results.cloudflare = r.ok || r.status === 405 ? 'ok' : 'error'; })
      .catch(function ()  { results.cloudflare = 'error'; });

    var sbCheck = fetch(SUPABASE_URL + '/storage/v1/bucket/' + MUSIC_BUCKET, {
        headers: { apikey: 'sb_publishable_nVGMJKoZGduKTt5Vh6P7cg_H692tMxL' }
      })
      .then(function (r) { results.supabase = r.status < 500 ? 'ok' : 'error'; })
      .catch(function ()  { results.supabase = 'error'; });

    return Promise.all([cfCheck, sbCheck]).then(function () { return results; });
  }

  /* ════════════════════════════════════════════════════════════
     getProvider(track) — returns canonical provider string
  ════════════════════════════════════════════════════════════ */
  function getProvider(track) {
    if (!track) return 'legacy';
    return track.storageProvider || (track.r2Key ? 'cloudflare' : 'legacy');
  }

  /* ════════════════════════════════════════════════════════════
     INTERNAL — R2 upload
  ════════════════════════════════════════════════════════════ */
  function _uploadToR2(file, trackId, uid, onProgress) {
    var key = 'music/' + uid + '/' + trackId + '/audio.' + _ext(file.name);
    return _r2Upload(key, file, onProgress);
  }

  function _r2Upload(key, file, onProgress) {
    return _getIdToken().then(function (idToken) {
      return new Promise(function (resolve, reject) {
        var form = new FormData();
        form.append('file', file, file.name);
        form.append('path', key);

        var xhr = new XMLHttpRequest();
        xhr.timeout = 10 * 60 * 1000;
        xhr.open('POST', WORKER_URL + '/');
        xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);

        var lastLoaded = 0, lastTime = Date.now();
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          var pct = Math.round((e.loaded / e.total) * 100);
          var now = Date.now();
          var elapsed = (now - lastTime) / 1000;
          if (elapsed > 0.4) {
            var bps = (e.loaded - lastLoaded) / elapsed;
            lastLoaded = e.loaded; lastTime = now;
            if (onProgress) onProgress(pct, bps);
          } else {
            if (onProgress) onProgress(pct, null);
          }
        };

        xhr.onload = function () {
          var res;
          try { res = JSON.parse(xhr.responseText); } catch (_) { res = {}; }
          if (xhr.status >= 200 && xhr.status < 300 && res.url) {
            resolve({ url: res.url, key: res.key || key });
          } else {
            var msg = (res && res.error) || ('R2 upload failed (HTTP ' + xhr.status + ')');
            if (xhr.status === 401) msg = 'Session expired — sign in again.';
            if (xhr.status === 413) msg = 'File too large (max 200 MB).';
            reject(new Error(msg));
          }
        };
        xhr.onerror   = function () { reject(new Error('R2 upload failed — network error or CORS block')); };
        xhr.ontimeout = function () { reject(new Error('R2 upload timed out')); };
        xhr.onabort   = function () { reject(new Error('R2 upload cancelled')); };
        xhr.send(form);
      });
    });
  }

  function _deleteR2(key) {
    return _getIdToken().then(function (idToken) {
      var uid = _getUid();
      return fetch(WORKER_URL + '/r2/delete', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ idToken: idToken, r2Key: key, ownerId: uid })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) {
          throw new Error(d.error || 'R2 delete failed');
        });
      });
    }).catch(function (e) {
      console.warn('[SNX Storage] R2 delete best-effort failed:', e.message);
    });
  }

  /* ════════════════════════════════════════════════════════════
     INTERNAL — Supabase upload (proxied through Worker for auth)
  ════════════════════════════════════════════════════════════ */
  function _uploadToSupabase(file, trackId, uid, onProgress) {
    var key = 'music/' + uid + '/' + trackId + '/audio.' + _ext(file.name);
    return _getIdToken().then(function (idToken) {
      return new Promise(function (resolve, reject) {
        var form = new FormData();
        form.append('file', file, file.name);
        form.append('path', key);
        form.append('bucket', MUSIC_BUCKET);

        var xhr = new XMLHttpRequest();
        xhr.timeout = 10 * 60 * 1000;
        xhr.open('POST', WORKER_URL + '/supabase-upload');
        xhr.setRequestHeader('Authorization', 'Bearer ' + idToken);

        var lastLoaded = 0, lastTime = Date.now();
        xhr.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          var pct = Math.round((e.loaded / e.total) * 100);
          var now = Date.now();
          if ((now - lastTime) > 400) {
            var bps = (e.loaded - lastLoaded) / ((now - lastTime) / 1000);
            lastLoaded = e.loaded; lastTime = now;
            if (onProgress) onProgress(pct, bps);
          } else {
            if (onProgress) onProgress(pct, null);
          }
        };

        xhr.onload = function () {
          var res;
          try { res = JSON.parse(xhr.responseText); } catch (_) { res = {}; }
          if (xhr.status >= 200 && xhr.status < 300 && res.url) {
            resolve({ url: res.url, key: res.key || key });
          } else {
            reject(new Error((res && res.error) || 'Supabase upload failed (HTTP ' + xhr.status + ')'));
          }
        };
        xhr.onerror   = function () { reject(new Error('Supabase upload failed — network error')); };
        xhr.ontimeout = function () { reject(new Error('Supabase upload timed out')); };
        xhr.onabort   = function () { reject(new Error('Supabase upload cancelled')); };
        xhr.send(form);
      });
    });
  }

  function _deleteSupabase(key) {
    return _getIdToken().then(function (idToken) {
      return fetch(WORKER_URL + '/supabase-delete', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + idToken },
        body:    JSON.stringify({ key: key, bucket: MUSIC_BUCKET })
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (d) { throw new Error(d.error || 'Supabase delete failed'); });
      });
    }).catch(function (e) {
      console.warn('[SNX Storage] Supabase delete best-effort failed:', e.message);
    });
  }

  /* ── Helpers ───────────────────────────────────────────────── */
  function _ext(filename) {
    return ((filename || '').split('.').pop() || 'mp3').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /* ════════════════════════════════════════════════════════════
     Public API
  ════════════════════════════════════════════════════════════ */
  window.MusicStorage = {
    uploadTrack:    uploadTrack,
    uploadArtwork:  uploadArtwork,
    getPlaybackUrl: getPlaybackUrl,
    getArtworkUrl:  getArtworkUrl,
    deleteTrack:    deleteTrack,
    checkHealth:    checkHealth,
    getProvider:    getProvider,
    WORKER_URL:     WORKER_URL,
    SUPABASE_URL:   SUPABASE_URL,
    MUSIC_BUCKET:   MUSIC_BUCKET
  };

})();
