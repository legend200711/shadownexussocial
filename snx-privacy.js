/**
 * snx-privacy.js — Shadow Nexus Social Privacy Center
 *
 * Manages per-user privacy settings, blocked accounts, muted accounts.
 *
 * Firestore: users/{uid}.privacySettings = {
 *   whoCanMessage:       'everyone'|'friends'|'nobody'
 *   whoCanFollow:        'everyone'|'nobody'
 *   whoCanComment:       'everyone'|'friends'|'nobody'
 *   whoCanSeeActivity:   'everyone'|'friends'|'nobody'
 *   whoCanSeeConnections:'everyone'|'friends'|'nobody'
 *   whoCanTagMe:         'everyone'|'friends'|'nobody'
 *   whoCanPostToProfile: 'everyone'|'friends'|'nobody'
 * }
 *
 * /users/{uid}/blocked/{blockedUid}  — blocked accounts
 * /users/{uid}/muted/{mutedUid}      — muted accounts
 */

'use strict';

(function () {

  var DEFAULTS = {
    whoCanMessage:        'everyone',
    whoCanFollow:         'everyone',
    whoCanComment:        'everyone',
    whoCanSeeActivity:    'friends',
    whoCanSeeConnections: 'everyone',
    whoCanTagMe:          'everyone',
    whoCanPostToProfile:  'friends'
  };

  window.SNXPrivacy = {
    getSettings:    getSettings,
    saveSettings:   saveSettings,
    block:          block,
    unblock:        unblock,
    mute:           mute,
    unmute:         unmute,
    isBlocked:      isBlocked,
    isMuted:        isMuted,
    getBlocked:     getBlocked,
    getMuted:       getMuted,
    canInteract:    canInteract
  };

  /* ────────────────────────────────────────────────
     getSettings() → the current user's privacy settings
  ──────────────────────────────────────────────── */
  function getSettings() {
    var stored = (window._snxUserData && window._snxUserData.privacySettings) || {};
    return Object.assign({}, DEFAULTS, stored);
  }

  /* ────────────────────────────────────────────────
     saveSettings(obj) → Promise
  ──────────────────────────────────────────────── */
  function saveSettings(obj) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.reject('Not ready');

    var merged = Object.assign({}, DEFAULTS, obj);
    // Update local cache
    if (window._snxUserData) window._snxUserData.privacySettings = merged;

    return fs.updateDoc(fs.doc(fs.db, 'users', uid), {
      privacySettings: merged,
      privacyUpdatedAt: Date.now()
    });
  }

  /* ────────────────────────────────────────────────
     block / unblock
  ──────────────────────────────────────────────── */
  function block(targetUid, targetName) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid || !targetUid) return Promise.reject('Not ready');

    var data = { uid: targetUid, name: targetName || '', blockedAt: Date.now() };
    return fs.setDoc(fs.doc(fs.db, 'users', uid, 'blocked', targetUid), data);
  }

  function unblock(targetUid) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.reject('Not ready');
    return fs.deleteDoc(fs.doc(fs.db, 'users', uid, 'blocked', targetUid));
  }

  /* ────────────────────────────────────────────────
     mute / unmute
  ──────────────────────────────────────────────── */
  function mute(targetUid, targetName) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid || !targetUid) return Promise.reject('Not ready');

    var data = { uid: targetUid, name: targetName || '', mutedAt: Date.now() };
    return fs.setDoc(fs.doc(fs.db, 'users', uid, 'muted', targetUid), data);
  }

  function unmute(targetUid) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.reject('Not ready');
    return fs.deleteDoc(fs.doc(fs.db, 'users', uid, 'muted', targetUid));
  }

  /* ────────────────────────────────────────────────
     isBlocked(uid) / isMuted(uid) → boolean (cached)
  ──────────────────────────────────────────────── */
  var _blockedCache = null;
  var _mutedCache   = null;

  function isBlocked(uid) {
    return _blockedCache ? _blockedCache.has(uid) : false;
  }

  function isMuted(uid) {
    return _mutedCache ? _mutedCache.has(uid) : false;
  }

  /* ────────────────────────────────────────────────
     getBlocked() → Promise<Array>
  ──────────────────────────────────────────────── */
  function getBlocked() {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.resolve([]);

    return fs.getDocs(fs.collection(fs.db, 'users', uid, 'blocked'))
      .then(function(snap) {
        var items = snap.docs.map(function(d) { return d.data(); });
        _blockedCache = new Set(items.map(function(i) { return i.uid; }));
        return items;
      });
  }

  /* ────────────────────────────────────────────────
     getMuted() → Promise<Array>
  ──────────────────────────────────────────────── */
  function getMuted() {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.resolve([]);

    return fs.getDocs(fs.collection(fs.db, 'users', uid, 'muted'))
      .then(function(snap) {
        var items = snap.docs.map(function(d) { return d.data(); });
        _mutedCache = new Set(items.map(function(i) { return i.uid; }));
        return items;
      });
  }

  /* ────────────────────────────────────────────────
     canInteract(targetUid, action) → boolean
     action: 'message'|'follow'|'comment'|'tag'|'postToProfile'
  ──────────────────────────────────────────────── */
  function canInteract(targetData, action, viewerUid) {
    if (!targetData) return false;
    var privSettings = (targetData.privacySettings) || {};
    var settings     = Object.assign({}, DEFAULTS, privSettings);

    var keyMap = {
      message:       'whoCanMessage',
      follow:        'whoCanFollow',
      comment:       'whoCanComment',
      tag:           'whoCanTagMe',
      postToProfile: 'whoCanPostToProfile'
    };

    var key  = keyMap[action];
    if (!key) return true;
    var rule = settings[key] || 'everyone';

    if (rule === 'nobody')  return false;
    if (rule === 'everyone') return true;
    if (rule === 'friends') {
      var friends = targetData.friends || [];
      return friends.includes(viewerUid || '');
    }
    return true;
  }

  /* ── Load caches on auth ready ── */
  document.addEventListener('snxAuthReady', function() {
    getBlocked().catch(function(){});
    getMuted().catch(function(){});
  });

})();
