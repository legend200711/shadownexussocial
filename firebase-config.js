/**
 * firebase-config.js
 * Shadow Nexus Social — canonical Firebase configuration reference.
 *
 * Firebase project: horr-a08f4  (SNS — Firestore, Auth, RTDB, Storage, Messaging)
 *
 * This module provides a single canonical Firebase app instance.
 * All pages must reuse the existing [DEFAULT] app to share the same Auth
 * session (browserLocalPersistence). Creating a second [DEFAULT] app for
 * the same project resets the Auth session and causes cold-start logout.
 *
 * STORAGE:  this file exposes the app instance only.
 *           Storage rules and buckets are NOT touched here.
 *
 * Usage (ES module):
 *   import { app, auth, db, liveDB } from './firebase-config.js';
 *
 * Pages that already initialise their own Firebase (index.html, live.js,
 * live-hub.html, live-room.html, channel.html) use the same getApps() guard
 * and will automatically share this same app instance — no conflict.
 */

import { initializeApp, getApps, getApp }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
import { getFirestore }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import { getDatabase }
  from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ── Firebase project credentials ── */
const _CONFIG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

/*
 * Reuse the existing app instance if one has already been initialised
 * (e.g. index.html and live-hub.html loaded in the same session).
 */
const app    = getApps().length ? getApp() : initializeApp(_CONFIG);
const auth   = getAuth(app);
const db     = getFirestore(app);
const liveDB = getDatabase(app);

export { app, auth, db, liveDB, _CONFIG };
