/**
 * SNX CREATOR CHANNELS — Data Layer
 * snx-creator-channels.js
 *
 * Firestore data layer for the Shadow Nexus TV Network creator channel system.
 * Reads/writes to the SNS Firebase project (horr-a08f4) — same project as
 * Shadow Nexus Social.  Uses window._snxAuth / window._snxCurrentUser.
 *
 * ONE SOCIAL GRAPH — ARCHITECTURE:
 *   Follow state is stored ONLY in users/{uid}.followers / users/{uid}.following
 *   (the canonical SNS social graph). This ensures:
 *     - Following on SNS profile = following on TV channel (and vice versa)
 *     - Follower counts are always in sync across all surfaces
 *     - No duplicate social data
 *
 * channelFollows/{uid}/followers/{fid} is kept ONLY for the live-notification
 * preference (notificationsEnabled). It no longer stores the authoritative
 * follow relationship.
 *
 * Collections (all in project horr-a08f4 Firestore):
 *
 *   users/{uid}                          — canonical SNS user doc (followers/following arrays)
 *   creatorChannels/{uid}                — permanent channel, keyed by owner UID
 *   liveSessions/{liveId}                — per-live-session documents
 *   liveReplays/{uid}/replays/{replayId} — replay metadata subcollection
 *   liveReplays/{uid}/replays/{replayId}/comments/{commentId} — replay comments
 *   replayLikes/{uid_replayId}           — like dedup index (flat collection)
 *   channelFollows/{uid}/followers/{fid} — NOTIF PREF ONLY (notificationsEnabled)
 *
 * ARCHITECTURE NOTES:
 *   - One channel per user, identified by their UID (NOT a separate ID)
 *   - Channels persist whether live or offline
 *   - Each creator's live session is independent — multiple simultaneous lives OK
 *   - Ending a live does NOT delete the channel
 *   - Recording/replay data is prepared but publishing is creator-controlled
 *   - Stage 3: full replay lifecycle (processing → ready/failed → publish/private/delete)
 *   - livePeakViewers and replayViews are stored separately (spec §11)
 *   - Feed posts reference replayId — no duplicate video (spec §20)
 */

import {
  initializeApp, getApps, getApp,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit,
  getDocs, onSnapshot, addDoc,
  serverTimestamp, increment, Timestamp,
  initializeFirestore, memoryLocalCache,
  runTransaction, arrayUnion, arrayRemove,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js';

/* ══════════════════════════════════════════════════════════════
   FIREBASE INIT  (SNS project — horr-a08f4)
   Reuse existing app if already initialised by channel.html bootstrap.
══════════════════════════════════════════════════════════════ */
const _snsCfg = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

// Reuse the existing SNS Firebase app (initialised in channel.html) if available
const _snsApp = getApps().find(a => a.name === '[DEFAULT]') || initializeApp(_snsCfg);

// Use memory cache when we are the first to initialise Firestore on this app.
// If index.html (getFirestore) or snx-creator-live.js (initializeFirestore) already
// ran first, initializeFirestore throws "already initialized" — fall back to
// getFirestore() to get the existing instance.
let snsDb;
try {
  snsDb = initializeFirestore(_snsApp, { localCache: memoryLocalCache() });
} catch (_initErr) {
  snsDb = getFirestore(_snsApp);
}
export { snsDb };

/* ══════════════════════════════════════════════════════════════
   CURRENT USER ACCESSOR
══════════════════════════════════════════════════════════════ */
export function getCurrentUser() {
  return window._snxCurrentUser ?? null;
}

/* ══════════════════════════════════════════════════════════════
   CREATOR CHANNEL HELPERS  (creatorChannels/{uid})
══════════════════════════════════════════════════════════════ */

/**
 * Create or retrieve the permanent creator channel for the current user.
 * Keyed by the user's SNS UID — one channel per account.
 * Idempotent: safe to call on every login.
 *
 * @param {object} user  — Firebase Auth user object
 * @param {object} opts  — optional overrides: channelName, channelDescription
 * @returns {Promise<object>} channel data
 */
export async function ensureCreatorChannel(user, opts = {}) {
  if (!user) throw new Error('Not authenticated');
  const ref = doc(snsDb, 'creatorChannels', user.uid);
  const snap = await getDoc(ref);

  // Load the canonical SNS user profile to get authoritative identity fields
  let snsProfile = null;
  try {
    const uSnap = await getDoc(doc(snsDb, 'users', user.uid));
    if (uSnap.exists()) snsProfile = uSnap.data();
  } catch (_) {}

  // Derive display name and avatar from canonical SNS profile
  const displayName  = snsProfile?.displayName || snsProfile?.username || user.displayName || '';
  const snsAvatar    = snsProfile?.avatar || snsProfile?.profileImage || user.photoURL || null;
  const snsUsername  = snsProfile?.username || snsProfile?.handle || '';
  // Follower count always derives from canonical SNS followers array
  const followersCount = (snsProfile?.followers || []).length;

  if (snap.exists()) {
    // Channel exists — sync identity fields from SNS profile so they stay current
    const existing = snap.data();
    const needsSync =
      existing.ownerUsername !== snsUsername ||
      existing.avatar        !== snsAvatar   ||
      existing.ownerUid      !== user.uid;
    if (needsSync) {
      try {
        await updateDoc(ref, {
          ownerUsername: snsUsername,
          avatar:        snsAvatar,
          followersCount,
          updatedAt:     serverTimestamp(),
        });
      } catch (_) {}
    }
    return { ...existing, ownerUsername: snsUsername, avatar: snsAvatar, followersCount };
  }

  // First time — create the channel
  const channelName = opts.channelName
    || (displayName ? `${displayName}'s Channel` : 'My Channel');

  const data = {
    ownerUid:           user.uid,
    ownerUsername:      snsUsername,
    channelName,
    channelDescription: opts.channelDescription || '',
    avatar:             snsAvatar,
    coverImage:         null,
    createdAt:          serverTimestamp(),
    updatedAt:          serverTimestamp(),
    status:             'offline',   // 'offline' | 'live'
    currentLiveId:      null,
    followersCount,
    // Stage 4: Main TV feature fields
    featuredOnMainTv:   false,    // true while founder is featuring this channel on Main TV
    allowMainTvFeature: true,     // creator opt-out: set false to prevent Main TV featuring
  };

  await setDoc(ref, data);
  return data;
}

/**
 * Load the creator channel for any UID.
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
export async function loadCreatorChannel(uid) {
  const snap = await getDoc(doc(snsDb, 'creatorChannels', uid));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Update editable channel fields (name, description, avatar, coverImage).
 * Only the owner should call this.
 *
 * @param {string} uid
 * @param {object} updates  — subset of: channelName, channelDescription, avatar, coverImage
 */
export async function updateCreatorChannel(uid, updates) {
  // avatar is NOT allowed here — avatar is owned by the SNS users/{uid} profile.
  // channelName is the TV-display name (can differ from SNS displayName — it's the
  // creator's chosen broadcast persona name).
  const allowed = ['channelName', 'channelDescription', 'coverImage', 'allowMainTvFeature'];
  const safe = {};
  for (const k of allowed) { if (k in updates) safe[k] = updates[k]; }
  await updateDoc(doc(snsDb, 'creatorChannels', uid), {
    ...safe,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Set the creator's Main TV feature opt-in/out preference.
 * When set to false, the founder will see a warning and cannot feature this creator.
 *
 * @param {string} uid
 * @param {boolean} allowed  true = allow Main TV featuring (default), false = opt-out
 */
export async function setMainTvFeaturePreference(uid, allowed) {
  await updateDoc(doc(snsDb, 'creatorChannels', uid), {
    allowMainTvFeature: allowed,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Subscribe to real-time updates for a creator channel.
 * @param {string} uid
 * @param {function} cb  — called with channel data or null
 * @returns {function} unsubscribe
 */
export function subscribeCreatorChannel(uid, cb) {
  return onSnapshot(doc(snsDb, 'creatorChannels', uid), snap => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

/**
 * Subscribe to all creator channels (for the directory).
 * Returns all channels, sorted: live first, then by followersCount desc.
 * @param {function} cb
 * @returns {function} unsubscribe
 */
export function subscribeChannelDirectory(cb) {
  // We fetch all and sort client-side to avoid a composite index requirement
  // for Stage 1. Can be optimised with a server-side index in Stage 2.
  return onSnapshot(
    collection(snsDb, 'creatorChannels'),
    snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Sort: live first, then offline; within each group by followersCount desc
      all.sort((a, b) => {
        if (a.status === 'live' && b.status !== 'live') return -1;
        if (b.status === 'live' && a.status !== 'live') return 1;
        return (b.followersCount || 0) - (a.followersCount || 0);
      });
      cb(all);
    }
  );
}

/**
 * Subscribe to LIVE-only channels (for LIVE NOW section).
 * @param {function} cb
 * @returns {function} unsubscribe
 */
export function subscribeLiveChannels(cb) {
  const q = query(
    collection(snsDb, 'creatorChannels'),
    where('status', '==', 'live'),
  );
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

/* ══════════════════════════════════════════════════════════════
   LIVE SESSION HELPERS  (liveSessions/{liveId})
   Each creator's live is independent — multiple simultaneous lives supported.
══════════════════════════════════════════════════════════════ */

/**
 * Start a new live session for the creator.
 * Updates their channel status to 'live' and creates a liveSessions doc.
 *
 * @param {string} uid
 * @param {object} opts  — title, description
 * @returns {Promise<string>} liveId
 */
export async function startLiveSession(uid, opts = {}) {
  // Create a new live session document with an auto-generated ID
  const sessionRef = await addDoc(collection(snsDb, 'liveSessions'), {
    liveId:       '',   // filled in after doc creation
    hostUid:      uid,
    channelId:    uid,  // channelId == ownerUid for creator channels
    title:        opts.title || 'Live Broadcast',
    description:  opts.description || '',
    status:       'live',    // 'live' | 'ended'
    startedAt:    serverTimestamp(),
    endedAt:      null,
    viewerCount:  0,
    peakViewers:  0,
    // Stream / WebRTC session info will be added when actual streaming is built
    streamInfo:   null,
    // Founder Main-TV carry placeholder (future only)
    featuredOnMainTv: false,
  });

  const liveId = sessionRef.id;

  // Update the liveId field inside the doc
  await updateDoc(sessionRef, { liveId });

  // Update the creator's channel to 'live'
  await updateDoc(doc(snsDb, 'creatorChannels', uid), {
    status:        'live',
    currentLiveId: liveId,
    updatedAt:     serverTimestamp(),
  });

  // Write a live notification for followers
  await _writeLiveNotification(uid, liveId);

  return liveId;
}

/**
 * End the current live session.
 * Sets the channel back to 'offline'.  Does NOT delete the channel.
 *
 * @param {string} uid
 * @param {string} liveId
 * @returns {Promise<void>}
 */
export async function endLiveSession(uid, liveId) {
  if (!liveId) return;

  // Mark the session as ended
  await updateDoc(doc(snsDb, 'liveSessions', liveId), {
    status:   'ended',
    endedAt:  serverTimestamp(),
  });

  // Take channel back offline — channel itself persists
  await updateDoc(doc(snsDb, 'creatorChannels', uid), {
    status:        'offline',
    currentLiveId: null,
    updatedAt:     serverTimestamp(),
  });
}

/**
 * Load a live session document.
 * @param {string} liveId
 * @returns {Promise<object|null>}
 */
export async function loadLiveSession(liveId) {
  const snap = await getDoc(doc(snsDb, 'liveSessions', liveId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Subscribe to a live session for real-time viewer count, etc.
 * @param {string} liveId
 * @param {function} cb
 * @returns {function} unsubscribe
 */
export function subscribeLiveSession(liveId, cb) {
  return onSnapshot(doc(snsDb, 'liveSessions', liveId), snap => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

/**
 * Increment viewer count for a live session.
 * @param {string} liveId
 */
export async function incrementViewerCount(liveId) {
  try {
    await updateDoc(doc(snsDb, 'liveSessions', liveId), {
      viewerCount: increment(1),
    });
  } catch (_) { /* non-critical */ }
}

/* ══════════════════════════════════════════════════════════════
   LIVE REPLAY HELPERS  (liveReplays/{uid}/replays/{replayId})
   Stage 3: full lifecycle — processing → ready/failed → publish/private/delete
══════════════════════════════════════════════════════════════ */

/**
 * Create a replay record immediately after a live ends.
 * Stored with processingStatus: 'processing' so creator sees the state.
 * recordingUrl is null until an actual video recording pipeline populates it.
 *
 * Fields stored separately per spec §11:
 *   livePeakViewers — peak viewer count from the original broadcast
 *   replayViews     — starts at 0, incremented when viewers watch the replay
 *
 * @param {string} uid
 * @param {string} liveId
 * @param {object} opts  — title, thumbnail, duration, recordingUrl, livePeakViewers
 * @returns {Promise<string>} replayId
 */
export async function createReplayRecord(uid, liveId, opts = {}) {
  const ref = await addDoc(collection(snsDb, 'liveReplays', uid, 'replays'), {
    replayId:          '',      // filled after creation
    creatorUid:        uid,
    originalLiveId:    liveId,
    title:             opts.title || 'Live Replay',
    description:       opts.description || '',
    thumbnail:         opts.thumbnail || null,
    duration:          opts.duration || null,
    recordingUrl:      opts.recordingUrl || null,  // populated when recording pipeline ready
    processingStatus:  opts.recordingUrl ? 'ready' : 'processing',
    createdAt:         serverTimestamp(),
    publishedAt:       null,
    visibility:        'private',   // 'public' | 'followers' | 'private'
    livePeakViewers:   opts.livePeakViewers || 0,   // §11 — separate from replayViews
    replayViews:       0,                            // §11 — incremented by viewers
    likeCount:         0,
    commentCount:      0,
    postedToFeed:      false,
    feedPostId:        null,
  });
  await updateDoc(ref, { replayId: ref.id });
  return ref.id;
}

/**
 * Mark a replay's processing state.
 * Called after recording finalization attempt.
 * @param {string} uid
 * @param {string} replayId
 * @param {'processing'|'ready'|'failed'} status
 * @param {string|null} recordingUrl  — set when ready
 */
export async function setReplayProcessingStatus(uid, replayId, status, recordingUrl = null) {
  const updates = { processingStatus: status };
  if (recordingUrl) updates.recordingUrl = recordingUrl;
  await updateDoc(doc(snsDb, 'liveReplays', uid, 'replays', replayId), updates);
}

/**
 * Publish a replay: set visibility + optionally post to feed.
 * Creator-only action.
 *
 * @param {string} uid
 * @param {string} replayId
 * @param {'public'|'followers'|'private'} visibility
 * @param {object} opts  — title, description, thumbnail, postToFeed
 * @returns {Promise<{feedPostId: string|null}>}
 */
export async function publishReplay(uid, replayId, visibility = 'public', opts = {}) {
  const replayRef = doc(snsDb, 'liveReplays', uid, 'replays', replayId);
  const snap = await getDoc(replayRef);
  if (!snap.exists()) throw new Error('Replay not found');
  const data = snap.data();

  const updates = {
    visibility,
    publishedAt:  serverTimestamp(),
    postedToFeed: false,
    feedPostId:   null,
  };

  // Apply optional metadata updates from the publish form
  if (opts.title)       updates.title       = opts.title;
  if (opts.description) updates.description = opts.description;
  if (opts.thumbnail)   updates.thumbnail   = opts.thumbnail;

  let feedPostId = null;

  // Post to Feed if requested and visibility is public or followers
  if (opts.postToFeed && visibility !== 'private') {
    try {
      const channelSnap = await getDoc(doc(snsDb, 'creatorChannels', uid));
      const channel = channelSnap.exists() ? channelSnap.data() : {};
      const postRef = await addDoc(collection(snsDb, 'posts'), {
        type:          'live_replay',
        uid,
        authorUid:     uid,
        channelName:   channel.channelName || 'A creator',
        avatar:        channel.avatar || null,
        replayId,
        creatorUid:    uid,
        title:         opts.title || data.title || 'Live Replay',
        thumbnail:     opts.thumbnail || data.thumbnail || null,
        duration:      data.duration || null,
        deepLink:      `channel.html?replay=${uid}&replayId=${replayId}`,
        text:          `${channel.channelName || 'A creator'} posted a Live Replay: "${opts.title || data.title || 'Live Replay'}"`,
        createdAt:     serverTimestamp(),
        likes:         0,
        likedBy:       [],
        comments:      [],
        visibility,
      });
      feedPostId = postRef.id;
      updates.postedToFeed = true;
      updates.feedPostId   = feedPostId;
    } catch (err) {
      console.warn('[SNX Channels] Feed post write error:', err.message);
    }
  }

  await updateDoc(replayRef, updates);

  // Send replay notification to followers (non-private only)
  if (visibility !== 'private') {
    _writeReplayNotification(uid, replayId, opts.title || data.title || 'Live Replay').catch(() => {});
  }

  return { feedPostId };
}

/**
 * Update replay details (title, description, thumbnail, visibility).
 * Creator-only.
 *
 * @param {string} uid
 * @param {string} replayId
 * @param {object} updates  — allowed: title, description, thumbnail, visibility
 */
export async function updateReplayDetails(uid, replayId, updates) {
  const allowed = ['title', 'description', 'thumbnail', 'visibility'];
  const safe = {};
  for (const k of allowed) { if (k in updates) safe[k] = updates[k]; }
  if (Object.keys(safe).length === 0) return;
  await updateDoc(doc(snsDb, 'liveReplays', uid, 'replays', replayId), safe);
}

/**
 * Delete a replay record and any associated feed post.
 * Deletes only this replay — does NOT delete the channel or live history.
 * @param {string} uid
 * @param {string} replayId
 */
export async function deleteReplay(uid, replayId) {
  // Load first so we can clean up feed post if present
  try {
    const snap = await getDoc(doc(snsDb, 'liveReplays', uid, 'replays', replayId));
    if (snap.exists() && snap.data().feedPostId) {
      deleteDoc(doc(snsDb, 'posts', snap.data().feedPostId)).catch(() => {});
    }
  } catch (_) {}
  await deleteDoc(doc(snsDb, 'liveReplays', uid, 'replays', replayId));
}

/**
 * Load a single replay record.
 * @param {string} creatorUid
 * @param {string} replayId
 * @returns {Promise<object|null>}
 */
export async function loadReplay(creatorUid, replayId) {
  const snap = await getDoc(doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Subscribe to a single replay document for real-time updates.
 * @param {string} creatorUid
 * @param {string} replayId
 * @param {function} cb
 * @returns {function} unsubscribe
 */
export function subscribeReplay(creatorUid, replayId, cb) {
  return onSnapshot(doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId), snap => {
    cb(snap.exists() ? { id: snap.id, ...snap.data() } : null);
  });
}

/**
 * Load public/followers replays for a creator's channel (visitor view).
 * Owner gets all replays including private, processing, and failed.
 * @param {string} uid
 * @param {boolean} includeAll  — only true when caller is the owner
 * @returns {Promise<object[]>}
 */
export async function loadReplays(uid, includeAll = false) {
  let q;
  if (includeAll) {
    q = query(
      collection(snsDb, 'liveReplays', uid, 'replays'),
      orderBy('createdAt', 'desc'),
      limit(50),
    );
  } else {
    // Visitors only see public and followers-only replays that are ready
    q = query(
      collection(snsDb, 'liveReplays', uid, 'replays'),
      where('visibility', 'in', ['public', 'followers']),
      orderBy('createdAt', 'desc'),
      limit(20),
    );
  }
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Increment replay view count.
 * replayViews is separate from livePeakViewers (spec §11).
 * @param {string} creatorUid
 * @param {string} replayId
 */
export async function incrementReplayViews(creatorUid, replayId) {
  try {
    await updateDoc(doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId), {
      replayViews: increment(1),
    });
  } catch (_) { /* non-critical */ }
}

/* ══════════════════════════════════════════════════════════════
   REPLAY LIKES  (replayLikes/{uid_replayId})
   Flat collection for dedup — one doc per user-per-replay.
   likeCount is stored on the replay doc for display.
══════════════════════════════════════════════════════════════ */

/**
 * Like a replay.  Idempotent — second call for the same user is a no-op.
 * Returns true if the like was recorded, false if already liked.
 * @param {string} viewerUid
 * @param {string} creatorUid
 * @param {string} replayId
 * @returns {Promise<boolean>}
 */
export async function likeReplay(viewerUid, creatorUid, replayId) {
  const likeDocId = `${viewerUid}_${replayId}`;
  const likeRef   = doc(snsDb, 'replayLikes', likeDocId);
  try {
    await runTransaction(snsDb, async tx => {
      const existing = await tx.get(likeRef);
      if (existing.exists()) throw new Error('already_liked');
      tx.set(likeRef, { viewerUid, creatorUid, replayId, likedAt: serverTimestamp() });
      const replayRef = doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId);
      tx.update(replayRef, { likeCount: increment(1) });
    });
    return true;
  } catch (err) {
    if (err.message === 'already_liked') return false;
    throw err;
  }
}

/**
 * Unlike a replay.
 * @param {string} viewerUid
 * @param {string} creatorUid
 * @param {string} replayId
 * @returns {Promise<boolean>} true if like was removed
 */
export async function unlikeReplay(viewerUid, creatorUid, replayId) {
  const likeDocId = `${viewerUid}_${replayId}`;
  const likeRef   = doc(snsDb, 'replayLikes', likeDocId);
  try {
    await runTransaction(snsDb, async tx => {
      const existing = await tx.get(likeRef);
      if (!existing.exists()) throw new Error('not_liked');
      tx.delete(likeRef);
      const replayRef = doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId);
      tx.update(replayRef, { likeCount: increment(-1) });
    });
    return true;
  } catch (err) {
    if (err.message === 'not_liked') return false;
    throw err;
  }
}

/**
 * Check if a user has liked a replay.
 * @param {string} viewerUid
 * @param {string} replayId
 * @returns {Promise<boolean>}
 */
export async function hasLikedReplay(viewerUid, replayId) {
  const snap = await getDoc(doc(snsDb, 'replayLikes', `${viewerUid}_${replayId}`));
  return snap.exists();
}

/* ══════════════════════════════════════════════════════════════
   REPLAY COMMENTS  (liveReplays/{uid}/replays/{replayId}/comments/{commentId})
   Each replay has its own thread.  Comments are stored per replayId.
   Creator can moderate (delete) comments on their own replays.
══════════════════════════════════════════════════════════════ */

/**
 * Post a comment on a replay.
 * @param {string} creatorUid  — replay owner
 * @param {string} replayId
 * @param {object} author      — { uid, displayName, username, avatar }
 * @param {string} text
 * @returns {Promise<string>} commentId
 */
export async function addReplayComment(creatorUid, replayId, author, text) {
  if (!text?.trim()) throw new Error('Empty comment');
  const commentsRef = collection(snsDb, 'liveReplays', creatorUid, 'replays', replayId, 'comments');
  const ref = await addDoc(commentsRef, {
    creatorUid,
    replayId,
    authorUid:     author.uid,
    authorName:    author.displayName || author.username || 'User',
    authorAvatar:  author.avatar || null,
    text:          text.trim().slice(0, 300),
    createdAt:     serverTimestamp(),
  });
  // Increment comment count on the replay doc
  updateDoc(doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId), {
    commentCount: increment(1),
  }).catch(() => {});
  return ref.id;
}

/**
 * Subscribe to comments on a replay (real-time).
 * @param {string} creatorUid
 * @param {string} replayId
 * @param {function} cb  — called with array of comment objects
 * @returns {function} unsubscribe
 */
export function subscribeReplayComments(creatorUid, replayId, cb) {
  const q = query(
    collection(snsDb, 'liveReplays', creatorUid, 'replays', replayId, 'comments'),
    orderBy('createdAt', 'asc'),
    limit(100),
  );
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

/**
 * Delete a replay comment.
 * Only the comment author or the replay owner (creator) should call this.
 * @param {string} creatorUid
 * @param {string} replayId
 * @param {string} commentId
 */
export async function deleteReplayComment(creatorUid, replayId, commentId) {
  await deleteDoc(
    doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId, 'comments', commentId),
  );
  updateDoc(doc(snsDb, 'liveReplays', creatorUid, 'replays', replayId), {
    commentCount: increment(-1),
  }).catch(() => {});
}

/* ══════════════════════════════════════════════════════════════
   FOLLOW HELPERS — ONE CANONICAL FOLLOW SYSTEM
   ─────────────────────────────────────────────────────────────
   Follow state lives in users/{uid}.followers / users/{uid}.following
   (the SNS canonical social graph).  This is the SAME data the main
   Shadow Nexus profile follow button reads and writes.

   channelFollows/{creatorUid}/followers/{followerUid} is kept solely for
   the per-creator live-notification preference (notificationsEnabled).
   It does NOT determine whether a follow relationship exists.
══════════════════════════════════════════════════════════════ */

/**
 * Follow a creator.
 * Writes to the canonical SNS users collection (followers/following arrays).
 * Also writes a channelFollows record for live-notification prefs.
 *
 * @param {string} creatorUid  — channel owner
 * @param {string} followerUid
 */
export async function followChannel(creatorUid, followerUid) {
  // ── 1. Canonical SNS follow relationship ──────────────────────────────────
  await Promise.all([
    updateDoc(doc(snsDb, 'users', creatorUid),  { followers: arrayUnion(followerUid) }),
    updateDoc(doc(snsDb, 'users', followerUid), { following: arrayUnion(creatorUid) }),
  ]);

  // ── 2. Sync followersCount on creatorChannels from actual follower array ──
  // We use a fresh read after the write so the count is always accurate.
  try {
    const snap = await getDoc(doc(snsDb, 'users', creatorUid));
    if (snap.exists()) {
      const count = (snap.data().followers || []).length;
      await updateDoc(doc(snsDb, 'creatorChannels', creatorUid), {
        followersCount: count,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (_) {}

  // ── 3. Notification pref record (TV-specific, non-blocking) ──────────────
  setDoc(
    doc(snsDb, 'channelFollows', creatorUid, 'followers', followerUid),
    { followerUid, followedAt: serverTimestamp(), notificationsEnabled: true },
    { merge: true },
  ).catch(() => {});
}

/**
 * Unfollow a creator.
 * Removes from canonical SNS users collection and channelFollows pref record.
 *
 * @param {string} creatorUid
 * @param {string} followerUid
 */
export async function unfollowChannel(creatorUid, followerUid) {
  // ── 1. Canonical SNS follow relationship ──────────────────────────────────
  await Promise.all([
    updateDoc(doc(snsDb, 'users', creatorUid),  { followers: arrayRemove(followerUid) }),
    updateDoc(doc(snsDb, 'users', followerUid), { following: arrayRemove(creatorUid) }),
  ]);

  // ── 2. Sync followersCount on creatorChannels ─────────────────────────────
  try {
    const snap = await getDoc(doc(snsDb, 'users', creatorUid));
    if (snap.exists()) {
      const count = (snap.data().followers || []).length;
      await updateDoc(doc(snsDb, 'creatorChannels', creatorUid), {
        followersCount: count,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (_) {}

  // ── 3. Remove notification pref record (non-blocking) ─────────────────────
  deleteDoc(doc(snsDb, 'channelFollows', creatorUid, 'followers', followerUid)).catch(() => {});
}

/**
 * Check if a user follows a creator.
 * Reads from the canonical SNS users/{creatorUid}.followers array —
 * the same data the main profile follow button uses.
 *
 * @param {string} creatorUid
 * @param {string} followerUid
 * @returns {Promise<boolean>}
 */
export async function isFollowingChannel(creatorUid, followerUid) {
  try {
    const snap = await getDoc(doc(snsDb, 'users', creatorUid));
    if (!snap.exists()) return false;
    return (snap.data().followers || []).includes(followerUid);
  } catch (_) { return false; }
}

/**
 * Update live notification preference for a followed channel.
 * This preference is TV-specific (separate from the follow relationship).
 * Turning off notifications does NOT unfollow the creator.
 *
 * @param {string} creatorUid
 * @param {string} followerUid
 * @param {boolean} enabled
 */
export async function setNotificationPref(creatorUid, followerUid, enabled) {
  const ref = doc(snsDb, 'channelFollows', creatorUid, 'followers', followerUid);
  await setDoc(ref, { followerUid, notificationsEnabled: enabled }, { merge: true });
}

/* ══════════════════════════════════════════════════════════════
   ONE-TIME MIGRATION HELPER
   Merges legacy channelFollows records into the canonical SNS
   users collection. Safe to call multiple times — idempotent.
   Exported so the TV Network can call it once on startup.
══════════════════════════════════════════════════════════════ */

/**
 * Migrate legacy channelFollows data into the canonical SNS follow system.
 * For each creatorUid in channelFollows, adds followerUid to
 * users/{creatorUid}.followers and users/{followerUid}.following if not
 * already present.
 *
 * @param {string} creatorUid  — only migrate for this creator's followers
 * @returns {Promise<number>}  number of relationships migrated
 */
export async function migrateChannelFollowsToSns(creatorUid) {
  try {
    const chFollowsSnap = await getDocs(
      collection(snsDb, 'channelFollows', creatorUid, 'followers'),
    );
    if (chFollowsSnap.empty) return 0;

    // Get current canonical followers for this creator
    const creatorSnap = await getDoc(doc(snsDb, 'users', creatorUid));
    if (!creatorSnap.exists()) return 0;
    const existingFollowers = new Set(creatorSnap.data().followers || []);

    let migrated = 0;
    for (const fDoc of chFollowsSnap.docs) {
      const followerUid = fDoc.data().followerUid;
      if (!followerUid || followerUid === creatorUid) continue;
      if (existingFollowers.has(followerUid)) continue; // already in canonical system

      try {
        await Promise.all([
          updateDoc(doc(snsDb, 'users', creatorUid),  { followers: arrayUnion(followerUid) }),
          updateDoc(doc(snsDb, 'users', followerUid), { following: arrayUnion(creatorUid) }),
        ]);
        existingFollowers.add(followerUid);
        migrated++;
      } catch (_) { /* non-fatal — skip this record */ }
    }

    // Sync followersCount after migration
    if (migrated > 0) {
      const updatedSnap = await getDoc(doc(snsDb, 'users', creatorUid));
      if (updatedSnap.exists()) {
        const count = (updatedSnap.data().followers || []).length;
        updateDoc(doc(snsDb, 'creatorChannels', creatorUid), {
          followersCount: count,
          updatedAt: serverTimestamp(),
        }).catch(() => {});
      }
    }

    return migrated;
  } catch (err) {
    console.warn('[SNX Channels] Follow migration error:', err.message);
    return 0;
  }
}

/* ══════════════════════════════════════════════════════════════
   REPLAY NOTIFICATION WRITER  (internal)
   Sent to followers when a replay is published (non-private only).
   This is distinct from the 🔴 LIVE notification.
══════════════════════════════════════════════════════════════ */
async function _writeReplayNotification(creatorUid, replayId, replayTitle) {
  try {
    const channelSnap = await getDoc(doc(snsDb, 'creatorChannels', creatorUid));
    if (!channelSnap.exists()) return;
    const channel = channelSnap.data();

    // ── Use canonical SNS followers array as the source of truth ─────────────
    const creatorUserSnap = await getDoc(doc(snsDb, 'users', creatorUid));
    if (!creatorUserSnap.exists()) return;
    const allFollowers = (creatorUserSnap.data().followers || []).filter(f => f !== creatorUid);
    if (!allFollowers.length) return;

    // Load notification pref records to filter out opted-out followers
    const notifPrefsSnap = await getDocs(
      collection(snsDb, 'channelFollows', creatorUid, 'followers'),
    );
    const notifPrefs = {};
    notifPrefsSnap.docs.forEach(d => {
      notifPrefs[d.data().followerUid] = d.data().notificationsEnabled !== false;
    });

    const notifBatch = allFollowers
      .filter(followerUid => notifPrefs[followerUid] !== false) // default: notify unless opted out
      .map(followerUid =>
        addDoc(collection(snsDb, 'notifications', followerUid, 'items'), {
          type:          'replay_published',
          fromUid:       creatorUid,
          channelName:   channel.channelName || 'A creator',
          replayId,
          replayTitle,
          text:          `▶ ${channel.channelName || 'A creator'} posted a Live Replay`,
          subtitle:      `"${replayTitle}"`,
          deepLink:      `channel.html?replay=${creatorUid}&replayId=${replayId}`,
          timestamp:     serverTimestamp(),
          read:          false,
        }),
      );

    await Promise.allSettled(notifBatch);
  } catch (err) {
    console.warn('[SNX Channels] Replay notification write error:', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   LIVE NOTIFICATION WRITER  (internal)
   Writes to /notifications/{followerUid}/items/{id} — existing SNS
   notification system.  Each follower with notificationsEnabled gets a doc.
══════════════════════════════════════════════════════════════ */
async function _writeLiveNotification(creatorUid, liveId) {
  try {
    // ── Load display info from canonical SNS profile ──────────────────────────
    const [channelSnap, creatorUserSnap] = await Promise.all([
      getDoc(doc(snsDb, 'creatorChannels', creatorUid)),
      getDoc(doc(snsDb, 'users', creatorUid)),
    ]);
    if (!channelSnap.exists() || !creatorUserSnap.exists()) return;
    const channel = channelSnap.data();

    // ── Use canonical SNS followers array as the source of truth ─────────────
    // Only followers who were added via the unified follow system receive notifications.
    // This prevents phantom notifications to TV-only followers that predate the migration.
    const allFollowers = (creatorUserSnap.data().followers || []).filter(f => f !== creatorUid);
    if (!allFollowers.length) return;

    // Load per-creator live-notification prefs from channelFollows
    const notifPrefsSnap = await getDocs(
      collection(snsDb, 'channelFollows', creatorUid, 'followers'),
    );
    const notifPrefs = {};
    notifPrefsSnap.docs.forEach(d => {
      notifPrefs[d.data().followerUid] = d.data().notificationsEnabled !== false;
    });

    // Write ONE notification per eligible follower
    const notifBatch = allFollowers
      .filter(followerUid => notifPrefs[followerUid] !== false) // default: notify unless opted out
      .map(followerUid =>
        addDoc(collection(snsDb, 'notifications', followerUid, 'items'), {
          type:          'creator_live',
          fromUid:       creatorUid,
          channelName:   channel.channelName || 'A creator',
          liveId,
          text:          `🔴 ${channel.channelName || 'A creator'} is LIVE on Shadow Nexus TV`,
          subtitle:      `${channel.channelName || 'A creator'} is broadcasting now.`,
          // Deep-link directly to this live session (not generic channel page)
          deepLink:      `channel.html?live=${creatorUid}&liveId=${liveId}`,
          timestamp:     serverTimestamp(),
          read:          false,
        }),
      );

    await Promise.allSettled(notifBatch);
  } catch (err) {
    console.warn('[SNX Channels] Live notification write error:', err.message);
  }
}

/* ══════════════════════════════════════════════════════════════
   USER PROFILE HELPER  (reads users/{uid} in SNS Firestore)
══════════════════════════════════════════════════════════════ */

/**
 * Load basic public profile fields from the SNS users collection.
 * @param {string} uid
 * @returns {Promise<{username, displayName, profileImage}|null>}
 */
export async function loadUserProfile(uid) {
  try {
    const snap = await getDoc(doc(snsDb, 'users', uid));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      uid,
      username:     d.username || d.handle || '',
      displayName:  d.displayName || d.name || '',
      profileImage: d.avatar || d.profileImage || d.photoURL || null,
      avatar:       d.avatar || d.profileImage || d.photoURL || null,
      followers:    d.followers || [],
      following:    d.following || [],
    };
  } catch (_) { return null; }
}

/**
 * Subscribe to real-time profile updates for a user.
 * Use this to keep TV channel identity in sync with SNS profile changes.
 * @param {string} uid
 * @param {function} cb  — called with profile data or null
 * @returns {function} unsubscribe
 */
export function subscribeUserProfile(uid, cb) {
  return onSnapshot(doc(snsDb, 'users', uid), snap => {
    if (!snap.exists()) { cb(null); return; }
    const d = snap.data();
    cb({
      uid,
      username:     d.username || d.handle || '',
      displayName:  d.displayName || d.name || '',
      profileImage: d.avatar || d.profileImage || d.photoURL || null,
      avatar:       d.avatar || d.profileImage || d.photoURL || null,
      followers:    d.followers || [],
      following:    d.following || [],
    });
  });
}
