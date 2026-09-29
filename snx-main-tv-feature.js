/**
 * SNX MAIN TV FEATURE BRIDGE — Stage 4
 * snx-main-tv-feature.js
 *
 * Manages the mainTvState/current Firestore document that controls
 * whether the 24-Hour TV channel is in 'scheduled' or 'featured_live' mode.
 *
 * NOTE: The WebRTC viewer path (joinCreatorLive) has been removed from the
 * 24-Hour TV system. The featured_live state document remains intact (Firestore
 * data is NOT deleted), but the TV player no longer attempts to join a WebRTC
 * stream via this bridge. SNS Live is a separate system.
 *
 * Exports:
 *   featureCreatorOnMainTv(user, liveId, channel)   — founder only
 *   removeCreatorFromMainTv(user)                   — founder only
 *   subscribeMainTvState(cb)                        — any viewer
 *   loadMainTvState()                               — one-shot read
 *   getMainTvState()                                — sync cached value
 *   isFounderUser(user)                             — helper
 *   emergencyReturnToSchedule(user)                 — founder only
 *
 * Firestore path:
 *   mainTvState/current   (single document, world-readable, founder-write-only)
 */

import {
  doc, getDoc, setDoc, updateDoc, onSnapshot, serverTimestamp,
  collection, addDoc,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

import {
  snsDb,
  subscribeLiveSession,
  loadLiveSession,
} from './snx-creator-channels.js';

/* ════════════════════════════════════
   CONSTANTS
════════════════════════════════════ */
export const FOUNDER_EMAIL = 'christijerina46@gmail.com';
const MAIN_TV_DOC = doc(snsDb, 'mainTvState', 'current');

/* ════════════════════════════════════
   CACHED STATE
════════════════════════════════════ */
let _cachedState = null;
let _mainUnsub   = null;

/* ════════════════════════════════════
   FOUNDER CHECK
════════════════════════════════════ */

/**
 * Returns true only for the designated founder email.
 * Does NOT rely on hiding — this is the client-side gate used alongside
 * Firestore rules which enforce the same restriction on the server.
 *
 * @param {object|null} user  Firebase Auth user
 * @returns {boolean}
 */
export function isFounderUser(user) {
  return !!(user && user.email?.trim().toLowerCase() === FOUNDER_EMAIL.toLowerCase());
}

/* ════════════════════════════════════
   MAIN TV STATE SCHEMA
   mainTvState/current:
   {
     mode: 'scheduled' | 'featured_live',
     featuredLiveId: string | null,
     featuredCreatorUid: string | null,
     featuredChannelName: string | null,
     featuredChannelAvatar: string | null,
     featuredLiveTitle: string | null,
     featuredStartedAt: Timestamp | null,
     updatedAt: Timestamp,
   }
════════════════════════════════════ */

/** Default (scheduled) state object. */
function _scheduledState() {
  return {
    mode:                   'scheduled',
    featuredLiveId:         null,
    featuredCreatorUid:     null,
    featuredChannelName:    null,
    featuredChannelAvatar:  null,
    featuredLiveTitle:      null,
    featuredStartedAt:      null,
    updatedAt:              serverTimestamp(),
  };
}

/* ════════════════════════════════════
   READ — subscribe / one-shot
════════════════════════════════════ */

/**
 * Subscribe to Main TV state changes in real time.
 * Fires immediately with the current value, then on every change.
 *
 * @param {function} cb  Called with the state object, or null if doc missing.
 * @returns {function} unsubscribe
 */
export function subscribeMainTvState(cb) {
  return onSnapshot(MAIN_TV_DOC, snap => {
    const st = snap.exists() ? snap.data() : null;
    _cachedState = st;
    cb(st);
  });
}

/**
 * One-shot read of Main TV state.
 * @returns {Promise<object|null>}
 */
export async function loadMainTvState() {
  const snap = await getDoc(MAIN_TV_DOC);
  const st = snap.exists() ? snap.data() : null;
  _cachedState = st;
  return st;
}

/**
 * Synchronous read of last-known state.
 * @returns {object|null}
 */
export function getMainTvState() {
  return _cachedState;
}

/* ════════════════════════════════════
   WRITE — founder actions
════════════════════════════════════ */

/**
 * Feature a Creator Live on Main TV.
 * Founder-only — Firestore rules enforce this on the backend.
 *
 * Confirms if another live is already featured.
 * Does NOT end the scheduled program or reset the schedule.
 *
 * @param {object} user           Firebase Auth user (must be founder)
 * @param {string} liveId         The creator's existing liveId
 * @param {object} channel        Creator channel doc { channelName, avatar, ownerUid }
 * @param {object} liveSession    Live session doc { title, rtdbRoomId, … }
 * @returns {Promise<void>}
 */
export async function featureCreatorOnMainTv(user, liveId, channel, liveSession) {
  if (!isFounderUser(user)) throw new Error('Unauthorized: founder only');
  if (!liveId) throw new Error('liveId required');

  await setDoc(MAIN_TV_DOC, {
    mode:                  'featured_live',
    featuredLiveId:        liveId,
    featuredCreatorUid:    channel.ownerUid || channel.id || null,
    featuredChannelName:   channel.channelName || 'Creator Live',
    featuredChannelAvatar: channel.avatar || null,
    featuredLiveTitle:     liveSession?.title || 'Live Broadcast',
    featuredStartedAt:     serverTimestamp(),
    updatedAt:             serverTimestamp(),
  });

  // Notify the creator they are being featured (best-effort)
  _notifyCreatorFeatured(channel.ownerUid || channel.id, liveId, channel).catch(() => {});
}

/**
 * Return Main TV to scheduled programming.
 * Clears the featured live completely.
 * Founder-only — Firestore rules enforce this on the backend.
 *
 * @param {object} user  Firebase Auth user (must be founder)
 * @returns {Promise<void>}
 */
export async function removeCreatorFromMainTv(user) {
  if (!isFounderUser(user)) throw new Error('Unauthorized: founder only');
  await setDoc(MAIN_TV_DOC, _scheduledState());
}

/**
 * Emergency return — forces Main TV to scheduled mode.
 * Same as removeCreatorFromMainTv but callable without a live user object
 * for the emergency-button path (still checks founder via _isFounderUser at call site).
 * Internal use only via the emergency button in snx-ch-adapter / broadcast.
 *
 * @param {object} user Firebase Auth user
 * @returns {Promise<void>}
 */
export async function emergencyReturnToSchedule(user) {
  if (!isFounderUser(user)) throw new Error('Unauthorized: founder only');
  await setDoc(MAIN_TV_DOC, _scheduledState());
}

/* ════════════════════════════════════
   CREATOR LIVE END WATCHDOG
   When Main TV is in featured_live mode, this watches the creator's
   RTDB room + Firestore session.  If the live ends or expires,
   it automatically clears the feature and returns to scheduled.
════════════════════════════════════ */

let _watchdogUnsub = null;
let _watchdogLiveId = null;

/**
 * Start watching a featured liveId.
 * When the live session is marked 'ended', auto-clears Main TV feature.
 * Called by Main TV engines (adapter/broadcast) after they detect
 * mode === 'featured_live'.
 *
 * @param {string} liveId
 */
export function startFeatureWatchdog(liveId) {
  if (_watchdogLiveId === liveId && _watchdogUnsub) return; // already watching
  stopFeatureWatchdog();
  _watchdogLiveId = liveId;
  // Skip the first snapshot — it fires immediately with the current (live) state.
  // Only react to state CHANGES after the watchdog is established.
  let _firstSnap = true;
  _watchdogUnsub = subscribeLiveSession(liveId, session => {
    if (_firstSnap) { _firstSnap = false; return; }
    if (!session || session.status === 'ended') {
      console.log('[SNX TV FEATURE] Watchdog: featured live ended → returning to schedule');
      _autoReturnToSchedule();
    }
  });
}

/** Stop the feature watchdog (call when mode returns to scheduled). */
export function stopFeatureWatchdog() {
  if (_watchdogUnsub) { _watchdogUnsub(); _watchdogUnsub = null; }
  _watchdogLiveId = null;
}

/**
 * Auto-return to scheduled programming (no user auth required —
 * this is triggered server-side by the live session ending).
 * Writes a serverTimestamp-based scheduled state directly.
 */
async function _autoReturnToSchedule() {
  try {
    // Check current state first — avoid writing if already scheduled
    const snap = await getDoc(MAIN_TV_DOC);
    if (!snap.exists() || snap.data()?.mode !== 'featured_live') return;
    await setDoc(MAIN_TV_DOC, _scheduledState());
  } catch (err) {
    console.warn('[SNX TV FEATURE] Auto-return failed:', err.message);
  }
}

/* ════════════════════════════════════
   CREATOR NOTIFICATION (best-effort)
   Writes to /notifications/{creatorUid}/items/{id}
════════════════════════════════════ */
async function _notifyCreatorFeatured(creatorUid, liveId, channel) {
  if (!creatorUid) return;
  try {
    // Check if creator has opted out (allowMainTvFeature field)
    const chSnap = await getDoc(doc(snsDb, 'creatorChannels', creatorUid));
    if (chSnap.exists() && chSnap.data().allowMainTvFeature === false) return; // opt-out

    await addDoc(collection(snsDb, 'notifications', creatorUid, 'items'), {
      type:        'main_tv_featured',
      fromUid:     null, // system notification
      channelName: channel.channelName || 'Your Channel',
      liveId,
      text:        '📺 You\'re being featured on Shadow Nexus Main TV.',
      subtitle:    'Your live broadcast is now airing on Shadow Nexus Main 24-Hour TV.',
      deepLink:    `channel.html`,
      timestamp:   serverTimestamp(),
      read:        false,
    });
  } catch (err) {
    console.warn('[SNX TV FEATURE] Creator notification failed:', err.message);
  }
}

/* ════════════════════════════════════
   MAIN TV FEATURE — PLAYER HOOKS
   WebRTC viewer path removed from 24-Hour TV.
   mountFeaturedLiveInPlayer immediately returns to schedule.
   dismountFeaturedLiveFromPlayer cleans up any leftover layer.
════════════════════════════════════ */

/**
 * mountFeaturedLiveInPlayer — WebRTC viewer removed from 24-Hour TV.
 *
 * When the TV detects featured_live mode it calls this function.
 * TV no longer joins a WebRTC stream — it returns to scheduled programming.
 * SNS Live (live.html) is a separate system and is not affected.
 */
export function mountFeaturedLiveInPlayer(_user, _userData, mainTvState, _mediaArea, onReturnScheduled) {
  if (!mainTvState || mainTvState.mode !== 'featured_live') return;
  console.log('[SNX TV FEATURE] featured_live mode detected; WebRTC join removed from TV — returning to schedule.');
  stopFeatureWatchdog();
  onReturnScheduled?.('tv_live_removed');
}

/**
 * Dismount any leftover featured-live layer from Main TV.
 * Safe to call even when nothing is mounted.
 */
export function dismountFeaturedLiveFromPlayer() {
  stopFeatureWatchdog();
  const layer = document.getElementById('snx-featured-live-layer');
  if (layer) layer.remove();
}
