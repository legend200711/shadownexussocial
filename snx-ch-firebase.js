/**
 * Aurenix — Firestore Client (channel data only)
 * snx-ch-firebase.js
 *
 * Provides the Aurenix Firestore db instance and helpers for channel state,
 * media library, and queue data (Firebase project: remix-studio-4bf8a).
 *
 * AUTHENTICATION NOTE:
 *   This file no longer manages authentication.  Auth is handled exclusively
 *   by Shadow Nexus Social (SNS) via window._snxAuth (project: horr-a08f4).
 *   The auth proxy is in snx-ch-auth-bridge.js.
 *
 *   Auth-related imports (getAuth, signInWithEmailAndPassword, etc.) are kept
 *   only because snx-ch-auth-bridge.js re-exports them for compatibility with
 *   modules that call onAuthStateChanged / signOut against the Aurenix db.
 *   In practice auth state always comes from the SNS session.
 *
 * Firebase project: remix-studio-4bf8a  (Firestore / channel data)
 */

import { initializeApp, getApps }               from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, signInWithEmailAndPassword,
         createUserWithEmailAndPassword,
         sendPasswordResetEmail, signOut,
         onAuthStateChanged, updateProfile }    from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc,
         collection, query, where, orderBy,
         limit, getDocs, onSnapshot, addDoc,
         updateDoc, deleteDoc, serverTimestamp, increment,
         runTransaction, Timestamp,
         initializeFirestore, memoryLocalCache } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

/* ══════════════════════════════════════════════════════════════
   FIREBASE CONFIGURATION
   Public config — safe to commit (access is controlled by
   Firestore Security Rules, not by this key).
══════════════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey:            'AIzaSyB2M8sgU__2s0oVa5y4-s1S294aP5CBdeQ',
  authDomain:        'remix-studio-4bf8a.firebaseapp.com',
  databaseURL:       'https://remix-studio-4bf8a-default-rtdb.firebaseio.com',
  projectId:         'remix-studio-4bf8a',
  storageBucket:     'remix-studio-4bf8a.firebasestorage.app',
  messagingSenderId: '220851113113',
  appId:             '1:220851113113:web:bb3cd4e44f478d3925fc08',
  measurementId:     'G-GM0JCC3BGW',
};

/* ══════════════════════════════════════════════════════════════
   INITIALISE
   NOTE: auth object is intentionally NOT exported from this file.
   Use the SNS auth proxy exported by snx-ch-auth-bridge.js instead.
══════════════════════════════════════════════════════════════ */
// Guard: only initialise a second Firebase app for the Aurenix project once.
// Uses a named app so it never conflicts with the SNS [DEFAULT] app (horr-a08f4).
const _AURENIX_APP_NAME = 'aurenix-channel';
const _app  = getApps().find(a => a.name === _AURENIX_APP_NAME)
           || initializeApp(firebaseConfig, _AURENIX_APP_NAME);
const _aurenixAuth = getAuth(_app); // kept internally for onAuthStateChanged re-export

// Disable Firestore offline persistence for the channel-state listener.
// The default IndexedDB persistence causes onSnapshot to deliver a stale
// cached snapshot first, which made normal viewers appear to lag ~2 minutes
// behind the live broadcast (the stale started_at caused wrong elapsed
// calculations and triggered an advance-retry storm before fresh data arrived).
// Live channel state must always come from the network, not a local cache.
export const db = initializeFirestore(_app, {
  localCache: memoryLocalCache(),
});

/* ══════════════════════════════════════════════════════════════
   RE-EXPORT FIRESTORE HELPERS
   All modules import helpers from here — keeps Firebase SDK
   version in one place.
══════════════════════════════════════════════════════════════ */
export {
  doc, getDoc, setDoc, collection, query, where, orderBy,
  limit, getDocs, onSnapshot, addDoc, updateDoc, deleteDoc,
  serverTimestamp, increment, runTransaction, Timestamp,
  onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
};

// NOTE: `auth` is intentionally NOT exported here.
// Import `auth` from snx-ch-auth-bridge.js — it returns the SNS auth proxy.

/* ══════════════════════════════════════════════════════════════
   AUTH HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Returns the currently signed-in user, or null.
 * Reads from the SNS session (window._snxCurrentUser) when available,
 * falling back to the Aurenix auth instance for standalone channel.html.
 * @returns {import('firebase/auth').User | null}
 */
export function getUser() {
  return window._snxCurrentUser ?? _aurenixAuth.currentUser ?? null;
}

/**
 * Subscribe to auth state changes.
 * Uses the SNS auth instance if available, otherwise falls back to Aurenix auth.
 * @param {(user: import('firebase/auth').User | null) => void} cb
 * @returns {() => void} unsubscribe function
 */
export function onAuthChange(cb) {
  const snxAuth = window._snxAuth;
  if (snxAuth && typeof snxAuth.onAuthStateChanged === 'function') {
    return snxAuth.onAuthStateChanged(cb);
  }
  return onAuthStateChanged(_aurenixAuth, cb);
}

/* ══════════════════════════════════════════════════════════════
   USER PROFILE HELPERS  (Firestore `users/{uid}`)
══════════════════════════════════════════════════════════════ */

/**
 * Load a user's Firestore profile document.
 * Returns null if the document does not exist yet.
 * @param {string} uid  Firebase Auth UID
 */
export async function loadUserProfile(uid) {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[Firebase] loadUserProfile error:', err.message);
    return null;
  }
}

/**
 * Create or merge-update a user profile document.
 * @param {string} uid
 * @param {Record<string, any>} data  — fields to set/merge
 */
export async function upsertUserProfile(uid, data) {
  try {
    await setDoc(doc(db, 'users', uid), {
      ...data,
      uid,
      updated_at: serverTimestamp(),
    }, { merge: true });
  } catch (err) {
    console.warn('[Firebase] upsertUserProfile error:', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   RADIO SUBMISSION HELPERS  (Firestore `radio_submissions/{id}`)
══════════════════════════════════════════════════════════════ */

/**
 * Create a new radio submission document.
 * Returns the new document ID on success, throws on failure.
 * @param {Record<string, any>} submissionData
 * @returns {Promise<string>} document ID
 */
export async function createSubmission(submissionData) {
  const ref = await addDoc(collection(db, 'radio_submissions'), {
    ...submissionData,
    status:     'pending',
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Update fields on an existing submission (admin only — enforced by rules).
 * @param {string} submissionId
 * @param {Record<string, any>} updates
 */
export async function updateSubmission(submissionId, updates) {
  await updateDoc(doc(db, 'radio_submissions', submissionId), {
    ...updates,
    updated_at: serverTimestamp(),
  });
}

/**
 * Fetch all submissions for a specific user, ordered newest first.
 * @param {string} uid
 */
export async function getUserSubmissions(uid) {
  const q = query(
    collection(db, 'radio_submissions'),
    where('submitted_by', '==', uid),
    orderBy('created_at', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Fetch ALL submissions (admin).
 */
export async function getAllSubmissions() {
  const q = query(
    collection(db, 'radio_submissions'),
    orderBy('created_at', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Fetch only approved/playing submissions for the public queue.
 */
export async function getApprovedSubmissions() {
  const q = query(
    collection(db, 'radio_submissions'),
    where('status', 'in', ['approved', 'playing']),
    orderBy('updated_at', 'asc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ══════════════════════════════════════════════════════════════
   RADIO STATION STATE  (Firestore `radio_station/live`)
══════════════════════════════════════════════════════════════ */

/**
 * Fetch the current authoritative station state from Firestore.
 */
export async function fetchStationState() {
  try {
    const snap = await getDoc(doc(db, 'radio_station', 'live'));
    return snap.exists() ? snap.data() : null;
  } catch (err) {
    console.warn('[Firebase] fetchStationState error:', err.message);
    return null;
  }
}

/**
 * Subscribe to real-time station state changes.
 * @param {(state: object | null) => void} cb
 * @returns {() => void} unsubscribe
 */
export function subscribeStation(cb) {
  return onSnapshot(doc(db, 'radio_station', 'live'), snap => {
    cb(snap.exists() ? snap.data() : null);
  });
}

/**
 * Atomically advance the station to the next track using a Firestore transaction.
 * Only advances if the current track in Firestore matches p_finished_track_id
 * (race-condition safe — only the first caller wins).
 *
 * @param {string|null} finishedTrackId
 * @param {object|null} nextTrack
 * @param {object[]}    queueSnapshot
 * @param {number|null} durationSec
 */
export async function advanceStation(finishedTrackId, nextTrack, queueSnapshot, durationSec) {
  const stationRef = doc(db, 'radio_station', 'live');

  return runTransaction(db, async tx => {
    const snap = await tx.get(stationRef);
    const current = snap.exists() ? snap.data() : null;

    // Race guard: only advance if we're still on the track we think is playing
    const dbCurrentId = current?.current_track_id || null;
    if (dbCurrentId !== null && dbCurrentId !== finishedTrackId) {
      return { advanced: false, current_track_id: dbCurrentId };
    }

    const now = Timestamp.now();

    // Mark finished track back to 'approved' in radio_submissions
    if (finishedTrackId) {
      const finRef = doc(db, 'radio_submissions', finishedTrackId);
      const finSnap = await tx.get(finRef);
      if (finSnap.exists() && finSnap.data().status === 'playing') {
        tx.update(finRef, { status: 'approved', updated_at: serverTimestamp() });
      }
    }

    if (!nextTrack) {
      // Queue exhausted
      tx.set(stationRef, {
        current_track_id: null,
        current_track:    null,
        track_started_at: now,
        duration_sec:     null,
        next_track_id:    null,
        next_track:       null,
        queue:            queueSnapshot || [],
        station_status:   'idle',
        updated_at:       serverTimestamp(),
      });
      return { advanced: true, current_track_id: null };
    }

    // Mark next track as playing
    const nextRef = doc(db, 'radio_submissions', nextTrack.id);
    tx.update(nextRef, { status: 'playing', updated_at: serverTimestamp() });

    // Find the track after next for the hint
    const nextIdx      = queueSnapshot.findIndex(t => t.id === nextTrack.id);
    const nextNextTrack = queueSnapshot[nextIdx + 1] || null;

    tx.set(stationRef, {
      current_track_id: nextTrack.id,
      current_track:    _trackSnapshot(nextTrack),
      track_started_at: now,
      duration_sec:     durationSec || null,
      next_track_id:    nextNextTrack?.id || null,
      next_track:       nextNextTrack ? _trackSnapshot(nextNextTrack) : null,
      queue:            queueSnapshot.map(_trackSnapshot),
      station_status:   'playing',
      updated_at:       serverTimestamp(),
    });

    return { advanced: true, current_track_id: nextTrack.id };
  });
}

function _trackSnapshot(t) {
  if (!t) return null;
  return {
    id:          t.id,
    title:       t.title        || '',
    artist:      t.artist       || '',
    album:       t.album        || null,
    artwork_url: t.artwork_url  || null,
    url:         t.url          || '',
    type:        t.type         || 'upload',
    genre:       t.genre        || null,
    likes:       t.likes        || 0,
  };
}

/* ══════════════════════════════════════════════════════════════
   COPYRIGHT REPORTS  (Firestore `radio_reports/{id}`)
══════════════════════════════════════════════════════════════ */

/**
 * Submit a copyright/content report.
 */
export async function submitReport(reportData) {
  await addDoc(collection(db, 'radio_reports'), {
    ...reportData,
    status:     'open',
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });
}

/**
 * Update a report (admin only).
 */
export async function updateReport(reportId, updates) {
  await updateDoc(doc(db, 'radio_reports', reportId), {
    ...updates,
    updated_at: serverTimestamp(),
  });
}

/**
 * Fetch all copyright reports (admin).
 */
export async function getAllReports() {
  const q = query(
    collection(db, 'radio_reports'),
    orderBy('created_at', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
