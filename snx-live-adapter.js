/**
 * SNX LIVE ADAPTER
 * snx-live-adapter.js
 *
 * THIN INTEGRATION LAYER between the working Shadow Nexus Live engine
 * (live.html + live.js) and the rest of Shadow Nexus Social.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * ARCHITECTURE
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   BROADCAST ENGINE (AUTHORITATIVE):
 *     live.html + live.js + live.css
 *     — camera, mic, WebRTC, signaling, chat, viewer count, End Live
 *     — NOT replaceable, NOT re-implemented here
 *
 *   SOCIAL LAYER (DISCOVERY):
 *     creatorChannels/{uid}  — status, currentLiveId
 *     subscribeLiveChannels  — Live Now real-time feed
 *
 *   THIS ADAPTER:
 *     — goLive(user)           → navigate to live.html (the working page)
 *     — watchBroadcast(roomId) → navigate to live.html#watch=roomId
 *     — broadcastStarted(uid, roomId)  → write creatorChannels live  [called BY live.js]
 *     — broadcastEnded(uid, roomId)    → write creatorChannels offline [called BY live.js]
 *     — getActiveBroadcast(uid)        → read creatorChannels
 *     — endActiveBroadcast(uid)        → Firestore offline + optional RTDB mark-ended
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * KEY RULES
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *  1. live.js is the ONLY source of truth for broadcasting.
 *  2. currentLiveId in creatorChannels = the RTDB roomId from live.js.
 *     There is no separate liveSessions doc for the host path.
 *  3. watchBroadcast always opens live.html#watch=roomId — the proven viewer.
 *  5. This file never touches Firebase Storage, recordings, music, or avatars.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * CANONICAL LIVE IDENTITY
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   roomId              = RTDB liveRooms/{roomId}     (created by live.js)
 *   currentLiveId       = roomId                      (stored in creatorChannels)
 *   watchUrl            = live.html#watch={roomId}
 *
 * No separate liveSessions doc is needed for the host path.
 * The RTDB room IS the canonical broadcast identity.
 */

import {
  initializeApp, getApps, getApp,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc, serverTimestamp,
  initializeFirestore, memoryLocalCache,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';
import {
  getDatabase, ref, get, update,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-database.js';

/* ── Firebase — horr-a08f4 (same project as live.js, index.html) ── */
const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};
const _app = getApps().find(a => a.name === '[DEFAULT]') || initializeApp(_CFG);
// IMPORTANT: live.js (live.html) already called getFirestore(_app) before this module
// is dynamically imported.  initializeFirestore() throws "already started" in that case
// — catch it and fall back to getFirestore() which returns the identical instance.
let _db;
try { _db = initializeFirestore(_app, { localCache: memoryLocalCache() }); }
catch (_initErr) { _db = getFirestore(_app); }
const _rtdb = getDatabase(_app);
console.log('[LIVE-BRIDGE] ADAPTER MODULE LOADED — Firebase project: horr-a08f4, Firestore instance:', _db ? '[DEFAULT]' : 'MISSING');

/* ══════════════════════════════════════════════════════════════
   GO LIVE
   Sends the user to the working live.html broadcast page.
   This is the ONLY way a host starts broadcasting.
   live.html + live.js handles ALL camera/mic/WebRTC.

   When live.js successfully starts a broadcast it already writes
   creatorChannels via its built-in bridge (broadcastStarted path).

   @param {object} user  — Firebase Auth user
   @param {string} [title] — optional pre-fill for the stream title
══════════════════════════════════════════════════════════════ */
export function goLive(user, title) {
  if (!user || !user.uid) {
    console.warn('[SNX ADAPTER] goLive — no authenticated user');
    return;
  }

  // Verify auth consistency before navigating
  const canonical = window._snxCurrentUser || null;
  if (canonical && canonical.uid !== user.uid) {
    console.error('[SNX ADAPTER] goLive — UID mismatch: caller=' + user.uid + ' canonical=' + canonical.uid);
    return;
  }

  // Optionally pre-fill the live title input on the target page
  if (title) {
    try { localStorage.setItem('snx_live_title_prefill', title); } catch (_) {}
  }

  console.log('[SNX ADAPTER] goLive — navigating to live.html, uid:', user.uid);
  window.location.href = 'live.html';
}

/* ══════════════════════════════════════════════════════════════
   WATCH BROADCAST
   Opens the working live.html viewer for a known roomId.
   roomId may come from:
     - creatorChannels/{uid}.currentLiveId  (set by live.js bridge)
     - RTDB liveRooms/{roomId}              (direct RTDB lookup)

   If roomId is not directly available, resolves it from Firestore
   creatorChannels.currentLiveId first.

   @param {string} roomId — the RTDB liveRooms key
   @param {object} [opts]
   @param {boolean} [opts.sameTab] — open in current tab (default: new tab)
══════════════════════════════════════════════════════════════ */
export function watchBroadcast(roomId, opts = {}) {
  if (!roomId) {
    console.warn('[SNX ADAPTER] watchBroadcast — no roomId');
    return;
  }
  const url = 'live.html#watch=' + encodeURIComponent(roomId);
  console.log('[SNX ADAPTER] watchBroadcast — url:', url);
  if (opts.sameTab) {
    window.location.href = url;
  } else {
    window.open(url, '_blank', 'noopener');
  }
}

/* ══════════════════════════════════════════════════════════════
   WATCH LIVE (high-level)
   Resolves the active roomId for a creator and opens the viewer.
   Called by Live Now cards, Creator Channel WATCH LIVE buttons,
   and profile Watch Live buttons.

   Resolution order:
     1. channel.currentLiveId   (fastest — already in memory)
     2. RTDB liveRooms/{roomId} (verify still live)
     3. Give up (channel is offline)

   @param {object} channel — creatorChannels doc data (must have currentLiveId or ownerUid)
   @param {object} [opts]
   @param {boolean} [opts.sameTab]
══════════════════════════════════════════════════════════════ */
export async function watchLive(user, userData, channel, liveIdOrRoomId, opts = {}) {
  // liveIdOrRoomId may be:
  //   A) the RTDB roomId directly (set by live.js bridge in currentLiveId)
  //   B) a Firestore liveSessions doc ID (legacy path — resolve to rtdbRoomId)

  let roomId = liveIdOrRoomId || channel?.currentLiveId || null;

  if (!roomId) {
    console.warn('[SNX ADAPTER] watchLive — no roomId/liveId available');
    return;
  }

  // If it looks like a Firestore doc ID (no underscores — liveSessions IDs are auto-generated
  // alphanumeric, while live.js roomIds always contain an underscore like "uid_timestamp36"),
  // try to resolve the rtdbRoomId from liveSessions.
  const looksLikeLiveSession = !roomId.includes('_');
  if (looksLikeLiveSession) {
    try {
      const snap = await getDoc(doc(_db, 'liveSessions', roomId));
      if (snap.exists() && snap.data().rtdbRoomId) {
        roomId = snap.data().rtdbRoomId;
        console.log('[SNX ADAPTER] watchLive — resolved liveSessions → rtdbRoomId:', roomId);
      }
    } catch (_) {}
  }

  // Verify the RTDB room is still live before opening the viewer
  try {
    const roomSnap = await get(ref(_rtdb, `liveRooms/${roomId}`));
    if (!roomSnap.exists() || roomSnap.val().status !== 'live') {
      console.warn('[SNX ADAPTER] watchLive — room not live in RTDB:', roomId);
      return;
    }
  } catch (_) {
    // Network error — proceed optimistically, live.html handles the not-found case
  }

  watchBroadcast(roomId, opts);
}

/* ══════════════════════════════════════════════════════════════
   BROADCAST STARTED  (called BY live.js after successful go-live)
   Updates creatorChannels so the creator appears in Live Now.
   live.js already calls this inline — this exported version lets
   other callers (e.g., future Studio page) trigger it explicitly.

   @param {string} uid    — host's Firebase uid
   @param {string} roomId — the RTDB liveRooms key (= currentLiveId)
   @param {object} [meta] — optional { displayName, username, avatar }
══════════════════════════════════════════════════════════════ */
export async function broadcastStarted(uid, roomId, meta = {}) {
  if (!uid || !roomId) {
    console.error('[LIVE-BRIDGE] broadcastStarted called with missing uid or roomId — uid:', uid, 'roomId:', roomId);
    return;
  }

  console.log('[LIVE-BRIDGE] BROADCAST_STARTED ENTRY — uid:', uid, 'roomId:', roomId);
  console.log('[LIVE-BRIDGE] UID:', uid);
  console.log('[LIVE-BRIDGE] ROOM_ID:', roomId);
  console.log('[LIVE-BRIDGE] ADAPTER_FIRESTORE_PROJECT: horr-a08f4');
  console.log('[LIVE-BRIDGE] CREATOR_CHANNEL_PATH: creatorChannels/' + uid);
  console.log('[LIVE-BRIDGE] FIRESTORE_INSTANCE:', _db ? '[DEFAULT] horr-a08f4' : 'MISSING — this will fail');

  const chData = {
    status:           'live',
    currentLiveId:    roomId,       // roomId IS the liveId for live.js broadcasts
    currentStartedAt: serverTimestamp(),
    updatedAt:        serverTimestamp(),
  };

  console.log('[LIVE-BRIDGE] CREATOR_CHANNEL_READ_START — getDoc creatorChannels/' + uid);
  try {
    const chRef = doc(_db, 'creatorChannels', uid);
    const snap  = await getDoc(chRef);
    console.log('[LIVE-BRIDGE] CREATOR_CHANNEL_READ — exists:', snap.exists(), 'current status:', snap.exists() ? snap.data().status : 'N/A');
    console.log('[LIVE-BRIDGE] CREATOR_CHANNEL_WRITE_START — writing status:live currentLiveId:', roomId);
    if (snap.exists()) {
      await updateDoc(chRef, chData);
    } else {
      // First-time: create a minimal channel doc
      console.log('[LIVE-BRIDGE] CREATOR_CHANNEL_CREATE — first-time creator, using setDoc');
      await setDoc(chRef, {
        ownerUid:      uid,
        channelName:   meta.displayName || 'Creator',
        ownerUsername: meta.username    || '',
        avatar:        meta.avatar      || null,
        ...chData,
      });
    }
    console.log('[LIVE-BRIDGE] CREATOR_CHANNEL_WRITE_SUCCESS — status:live currentLiveId:', roomId);
  } catch (err) {
    console.error('[LIVE-BRIDGE] CREATOR_CHANNEL_WRITE_FAILED',
      '\n  code:', err.code,
      '\n  message:', err.message,
      '\n  Firebase project: horr-a08f4',
      '\n  document path: creatorChannels/' + uid,
      '\n  full error:', err);
    // Re-throw so callers know it failed — silent failure is what caused the invisibility bug
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════
   BROADCAST ENDED  (called BY live.js after endLive completes)
   Clears creatorChannels so the creator leaves Live Now.

   @param {string} uid    — host's Firebase uid
   @param {string} [roomId] — the RTDB liveRooms key (for logging)
══════════════════════════════════════════════════════════════ */
export async function broadcastEnded(uid, roomId) {
  if (!uid) {
    console.error('[LIVE-BRIDGE] broadcastEnded called with no uid');
    return;
  }
  console.log('[LIVE-BRIDGE] OFFLINE_WRITE_START (adapter) — uid:', uid, 'roomId:', roomId);
  console.log('[LIVE-BRIDGE] FIRESTORE_INSTANCE (ended):', _db ? '[DEFAULT] horr-a08f4' : 'MISSING');

  try {
    await updateDoc(doc(_db, 'creatorChannels', uid), {
      status:           'offline',
      currentLiveId:    null,
      currentStartedAt: null,
      updatedAt:        serverTimestamp(),
    });
    console.log('[LIVE-BRIDGE] OFFLINE_WRITE_SUCCESS — creatorChannels status:offline ✓');
  } catch (err) {
    console.error('[LIVE-BRIDGE] OFFLINE_WRITE_FAILED',
      '\n  code:', err.code,
      '\n  message:', err.message,
      '\n  Firebase project: horr-a08f4',
      '\n  document path: creatorChannels/' + uid,
      '\n  full error:', err);
    throw err;
  }
}

/* ══════════════════════════════════════════════════════════════
   GET ACTIVE BROADCAST
   Returns { roomId, status } for a creator, or null if offline.

   @param {string} uid
   @returns {{ roomId: string, status: string } | null}
══════════════════════════════════════════════════════════════ */
export async function getActiveBroadcast(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(_db, 'creatorChannels', uid));
    if (!snap.exists()) return null;
    const data = snap.data();
    if (data.status !== 'live' || !data.currentLiveId) return null;
    return { roomId: data.currentLiveId, status: 'live' };
  } catch (_) {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   END ACTIVE BROADCAST  (emergency path from MY CHANNEL)
   Used when the host closed live.html without pressing END LIVE,
   leaving a ghost live session.

   Steps:
     1. Mark RTDB room as ended (if still accessible)
     2. Clear creatorChannels to offline

   Does NOT touch camera/mic (those are already stopped if the
   live.html page was closed).

   @param {string} uid
   @param {string} [roomId] — if known, marks RTDB room ended too
══════════════════════════════════════════════════════════════ */
export async function endActiveBroadcast(uid, roomId) {
  if (!uid) return;
  console.log('[SNX ADAPTER] endActiveBroadcast — uid:', uid, 'roomId:', roomId);

  // Resolve roomId from creatorChannels if not provided
  if (!roomId) {
    try {
      const snap = await getDoc(doc(_db, 'creatorChannels', uid));
      if (snap.exists()) roomId = snap.data().currentLiveId || null;
    } catch (_) {}
  }

  // Mark RTDB room ended (best-effort)
  if (roomId) {
    try {
      await update(ref(_rtdb, `liveRooms/${roomId}`), {
        status: 'ended', isLive: false, endedAt: Date.now(),
      });
      console.log('[SNX ADAPTER] endActiveBroadcast — RTDB room marked ended ✓');
    } catch (rtdbErr) {
      console.warn('[SNX ADAPTER] endActiveBroadcast — RTDB mark-ended failed:', rtdbErr.message);
    }
  }

  // Clear creatorChannels (critical — must not leave ghost live)
  await broadcastEnded(uid, roomId);
}

/* ══════════════════════════════════════════════════════════════
   LEGACY COMPAT — openHostStage
   Previous code called openHostStage(user, userData, channel).
   Now redirects to goLive(user) so live.html opens.
   Kept for any callers that haven't been updated yet.
══════════════════════════════════════════════════════════════ */
export function openHostStage(user, userData, channel) {
  return goLive(user, channel?.channelName);
}

/* ══════════════════════════════════════════════════════════════
   LEGACY COMPAT — endLive
   Previous code called endLive(uid).
   Delegates to endActiveBroadcast which handles the ghost-live case.
══════════════════════════════════════════════════════════════ */
export async function endLive(uid) {
  return endActiveBroadcast(uid);
}

/* ══════════════════════════════════════════════════════════════
   SYNC CREATOR CHANNEL  (convenience)
   Reads a creatorChannels doc and returns it, or null.
   Used by MY CHANNEL to display current live state.

   @param {string} uid
   @returns {object|null}
══════════════════════════════════════════════════════════════ */
export async function syncCreatorChannel(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(_db, 'creatorChannels', uid));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (_) {
    return null;
  }
}

