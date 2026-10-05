/**
 * SHADOW NEXUS SOCIAL — Channel Auth Bridge
 * snx-ch-auth-bridge.js
 *
 * OWNERSHIP: Shadow Nexus Social
 *
 * ── SNS-NATIVE TV REBUILD NOTE ──────────────────────────────────────────────
 * The SNS TV has been rebuilt to use ONLY the SNS Firebase project (horr-a08f4).
 * The separate remix-studio-4bf8a project is NO LONGER used for TV data.
 * TV state, media, playlists, programs, and schedule now live in horr-a08f4
 * collections: tv_state, tv_config, tv_media, tv_playlists, tv_programs.
 *
 * This bridge is retained for compatibility with:
 *   - snx-ch-broadcast.js (channel.html legacy path)
 *   - snx-ch-control.js (Founder studio legacy path)
 * But the TV auth token bridge to remix-studio-4bf8a has been REMOVED.
 * No custom token exchange is needed — the SNS auth session handles all TV writes.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Bridges the SNS 24-Hour TV to the Shadow Nexus Social authenticated session.
 * The SNS main app initialises Firebase (project: horr-a08f4) and exposes:
 *
 *   window._snxAuth          — Firebase Auth instance (SNS project)
 *   window._snxCurrentUser   — currently signed-in user (or null)
 *
 * This bridge exports a thin compatibility layer so snx-ch-control.js,
 * snx-ch-broadcast.js, and snx-ch-adapter.js can import auth helpers
 * without duplicating Firebase initialisation.
 */

/* ── Re-export Aurenix Firestore client — db + helpers ONLY.
      auth is NOT re-exported from here; the SNS proxy below takes precedence. ── */
import {
  db, tvAuth,
  doc, getDoc, setDoc, collection, query, where, orderBy,
  limit, getDocs, onSnapshot, addDoc, updateDoc, deleteDoc,
  serverTimestamp, increment, runTransaction, Timestamp,
  onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
  loadUserProfile, upsertUserProfile,
  createSubmission, updateSubmission,
  getUserSubmissions, getAllSubmissions, getApprovedSubmissions,
  fetchStationState, subscribeStation, advanceStation,
  submitReport, updateReport, getAllReports,
} from './snx-ch-firebase.js';

export {
  db,
  doc, getDoc, setDoc, collection, query, where, orderBy,
  limit, getDocs, onSnapshot, addDoc, updateDoc, deleteDoc,
  serverTimestamp, increment, runTransaction, Timestamp,
  // Auth helpers from firebase-auth are exported for compatibility but auth
  // state is now driven by the SNS proxy above — only Firestore operations
  // actually use these helpers.
  onAuthStateChanged, signOut,
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, updateProfile,
  loadUserProfile, upsertUserProfile,
  createSubmission, updateSubmission,
  getUserSubmissions, getAllSubmissions, getApprovedSubmissions,
  fetchStationState, subscribeStation, advanceStation,
  submitReport, updateReport, getAllReports,
};

/* ── SNS Auth proxy ──────────────────────────────────────────────────────── *
 *
 * `auth` exported here is a lightweight proxy that reads the LIVE SNS
 * Firebase auth instance from window._snxAuth.
 *
 * Why a proxy instead of directly importing the SNS Firebase?
 *  - snx-ch-control.js calls auth.currentUser.getIdToken() to authorise
 *    uploads through the Cloudflare Worker.
 *  - The Worker validates tokens against the SNS Firebase project (horr-a08f4).
 *  - window._snxAuth is guaranteed to be set before snxTvInit() is called
 *    because the SNS main module script runs first.
 * ─────────────────────────────────────────────────────────────────────────── */
export const auth = new Proxy(
  /** @type {import('firebase/auth').Auth} */ ({}),
  {
    get(_target, prop) {
      const snxAuth = window._snxAuth;
      if (!snxAuth) return undefined;
      const val = snxAuth[prop];
      return typeof val === 'function' ? val.bind(snxAuth) : val;
    },
    set(_target, prop, value) {
      const snxAuth = window._snxAuth;
      if (snxAuth) snxAuth[prop] = value;
      return true;
    },
  }
);

/* ── onAuthChange ───────────────────────────────────────────────────────── *
 * Wraps onAuthStateChanged using the SNS auth instance.
 * Used by snx-ch-broadcast.js to subscribe to auth state (channel.html path).
 * ─────────────────────────────────────────────────────────────────────────── */
export function onAuthChange(cb) {
  // If SNS auth is already available, subscribe directly.
  const snxAuth = window._snxAuth;
  if (snxAuth && typeof snxAuth.onAuthStateChanged === 'function') {
    return snxAuth.onAuthStateChanged(cb);
  }
  // SNS auth not yet initialised — wait for it and fire immediately with
  // the current user once available (happens on channel.html standalone path).
  let fired = false;
  let unsub  = () => {};
  const interval = setInterval(() => {
    const a = window._snxAuth;
    if (a && typeof a.onAuthStateChanged === 'function') {
      clearInterval(interval);
      if (!fired) {
        fired = true;
        unsub = a.onAuthStateChanged(cb);
      }
    }
  }, 100);
  // Return an unsubscribe function
  return () => { clearInterval(interval); unsub(); };
}

/* ── getUser ─────────────────────────────────────────────────────────────── */
export function getUser() {
  return window._snxAuth?.currentUser ?? null;
}

/* ── TV Auth Bridge — REMOVED ────────────────────────────────────────────── *
 *
 * The bridge that signed the Aurenix (remix-studio-4bf8a) Firebase Auth
 * instance using a custom token has been REMOVED as part of the SNS TV
 * clean rebuild.
 *
 * The SNS TV now stores all data in horr-a08f4 (the SNS project) and uses
 * the existing SNS auth session directly.  No custom token exchange is needed.
 *
 * The /auth/tv-token Worker endpoint has been deprecated (returns HTTP 410).
 * ─────────────────────────────────────────────────────────────────────────── */
