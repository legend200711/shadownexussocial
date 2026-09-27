/**
 * snx-vault.js — Shadow Nexus Social — The Vault
 *
 * Private saved-content system.
 * Users can save: Posts, Music, Videos, Playlists
 *
 * Firestore: /users/{uid}/vault/{itemId}
 *   { type, refId, title, artUrl, savedAt, collection }
 *
 * Collections: favorites, watchLater, listenLater, custom (user-named)
 *
 * Content is PRIVATE — only owner reads it.
 * References existing content — no media duplication.
 */

'use strict';

(function () {

  var COLL_VAULT = 'vault'; // subcollection under users/{uid}

  window.SNXVault = {
    save:           save,
    unsave:         unsave,
    isSaved:        isSaved,
    loadItems:      loadItems,
    createCollection: createCollection,
    getCollections: getCollections
  };

  /* ────────────────────────────────────────────────
     save({ type, refId, title, artUrl, collection? })
  ──────────────────────────────────────────────── */
  function save(item) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid || !item.refId) return Promise.reject('Not ready');

    var docId = item.type + '_' + item.refId;
    var data  = {
      type:       item.type || 'post',   // post|music|video|playlist
      refId:      item.refId,
      title:      item.title    || '',
      artUrl:     item.artUrl   || '',
      collection: item.collection || 'favorites',
      savedAt:    Date.now()
    };

    return fs.setDoc(
      fs.doc(fs.db, 'users', uid, COLL_VAULT, docId),
      data
    ).then(function() {
      _notify('save', data);
    });
  }

  /* ────────────────────────────────────────────────
     unsave(type, refId)
  ──────────────────────────────────────────────── */
  function unsave(type, refId) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.reject('Not ready');

    var docId = type + '_' + refId;
    return fs.deleteDoc(
      fs.doc(fs.db, 'users', uid, COLL_VAULT, docId)
    ).then(function() {
      _notify('unsave', { type: type, refId: refId });
    });
  }

  /* ────────────────────────────────────────────────
     isSaved(type, refId) → Promise<boolean>
  ──────────────────────────────────────────────── */
  function isSaved(type, refId) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.resolve(false);

    var docId = type + '_' + refId;
    return fs.getDoc(fs.doc(fs.db, 'users', uid, COLL_VAULT, docId))
      .then(function(snap) { return snap.exists(); });
  }

  /* ────────────────────────────────────────────────
     loadItems(collection?, limit?) → Promise<Item[]>
  ──────────────────────────────────────────────── */
  function loadItems(coll, lim) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid) return Promise.resolve([]);

    var q;
    try {
      var colRef = fs.collection(fs.db, 'users', uid, COLL_VAULT);
      if (coll && coll !== 'all') {
        q = fs.query(colRef,
          fs.where('collection', '==', coll),
          fs.orderBy('savedAt', 'desc'),
          fs.limit(lim || 40));
      } else {
        q = fs.query(colRef,
          fs.orderBy('savedAt', 'desc'),
          fs.limit(lim || 40));
      }
      return fs.getDocs(q).then(function(snap) {
        return snap.docs.map(function(d) { return Object.assign({ id: d.id }, d.data()); });
      });
    } catch(e) {
      return Promise.resolve([]);
    }
  }

  /* ────────────────────────────────────────────────
     createCollection / getCollections
     Collections are stored as a field on users/{uid}
  ──────────────────────────────────────────────── */
  function createCollection(name) {
    var fs  = window._snxFirestore;
    var uid = window._snxCurrentUser && window._snxCurrentUser.uid;
    if (!fs || !uid || !name) return Promise.reject('Not ready');

    var sanitized = String(name).trim().slice(0, 40);
    return fs.updateDoc(
      fs.doc(fs.db, 'users', uid),
      { vaultCollections: fs.arrayUnion(sanitized) }
    );
  }

  function getCollections() {
    var defaults = ['favorites', 'watchLater', 'listenLater'];
    var extra = (window._snxUserData && window._snxUserData.vaultCollections) || [];
    return defaults.concat(extra.filter(function(c) { return !defaults.includes(c); }));
  }

  function _notify(event, data) {
    try { document.dispatchEvent(new CustomEvent('snxVault:' + event, { detail: data })); } catch(_) {}
  }

})();
