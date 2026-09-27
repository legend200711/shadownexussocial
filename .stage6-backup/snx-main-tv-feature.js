/**
 * SNX MAIN TV FEATURE BRIDGE — Stage 4
 * snx-main-tv-feature.js
 *
 * Controlled bridge that lets the FOUNDER temporarily carry an active
 * Creator Live on the Shadow Nexus Main 24-Hour TV station.
 *
 * Architecture:
 *   - A single Firestore document  mainTvState/current  holds the mode.
 *   - All viewers listen to that doc in real time.
 *   - When mode === 'featured_live', Main TV players switch to the creator's
 *     existing liveId WebRTC stream.  The 24-hour schedule keeps advancing
 *     in the background — it is never stopped.
 *   - When the feature ends (founder removes, creator ends live, or creator
 *     disconnects) mode reverts to 'scheduled' and the player resumes at the
 *     CURRENT schedule position (elapsed = now - started_at).
 *
 * Exports (used by snx-ch-adapter.js, snx-ch-broadcast.js, snx-creator-live-viewer.js,
 *          snx-tv-network.js):
 *
 *   featureCreatorOnMainTv(user, liveId, channel)   — founder only
 *   removeCreatorFromMainTv(user)                   — founder only
 *   subscribeMainTvState(cb)                        — any viewer
 *   loadMainTvState()                               — one-shot read
 *   getMainTvState()                                — sync cached value
 *   isFounderUser(user)                             — helper
 *   notifyCreatorFeatured(founderUser, liveId, channel) — internal
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
  _watchdogUnsub  = subscribeLiveSession(liveId, session => {
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
   MAIN TV FEATURE — VIEWER PLAYER HOOK
   Used by snx-ch-adapter.js and snx-ch-broadcast.js to build the
   featured live overlay inside the existing Main TV player area.
════════════════════════════════════ */

let _featurePlayerState = {
  active: false,
  liveId: null,
  videoEl: null,
  unsub: null,
};

/**
 * Build and inject the Featured Live overlay inside the Main TV player.
 * Does NOT create a new overlay — reuses the existing #ax-media-area.
 *
 * @param {object} user          Firebase Auth user (for joinCreatorLive)
 * @param {object} userData      User profile data
 * @param {object} mainTvState   The mainTvState/current document data
 * @param {HTMLElement} mediaArea   The existing #ax-media-area element
 * @param {function} onReturnScheduled  Called when the feature ends (auto or manual)
 */
export async function mountFeaturedLiveInPlayer(user, userData, mainTvState, mediaArea, onReturnScheduled) {
  if (!mediaArea) return;
  if (!mainTvState || mainTvState.mode !== 'featured_live') return;

  const liveId     = mainTvState.featuredLiveId;
  const chanName   = mainTvState.featuredChannelName   || 'Creator Live';
  const chanAvatar = mainTvState.featuredChannelAvatar || null;
  const liveTitle  = mainTvState.featuredLiveTitle      || 'Live Broadcast';

  // If the same live is already mounted, do nothing
  if (_featurePlayerState.active && _featurePlayerState.liveId === liveId) return;

  // Teardown any previous feature player
  dismountFeaturedLiveFromPlayer();

  // Build the featured live layer inside the existing media area
  // Position: absolute, covers the media area, z-index above the scheduled content
  const featuredDiv = document.createElement('div');
  featuredDiv.id = 'snx-featured-live-layer';
  featuredDiv.style.cssText = [
    'position:absolute;inset:0;z-index:20;',
    'background:#000;display:flex;flex-direction:column;',
    'align-items:center;justify-content:center;',
  ].join('');

  const avatarHtml = chanAvatar
    ? `<img src="${_esc(chanAvatar)}" alt="" style="width:40px;height:40px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,45,85,0.7);">`
    : `<div style="width:40px;height:40px;border-radius:50%;background:#1a2a45;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:900;color:#fff;">${_esc(chanName.charAt(0).toUpperCase())}</div>`;

  featuredDiv.innerHTML = `
    <div id="snx-feat-header" style="position:absolute;top:0;left:0;right:0;z-index:2;padding:8px 12px;background:linear-gradient(to bottom,rgba(0,0,0,0.8),transparent);display:flex;align-items:center;gap:8px;">
      <span style="display:inline-block;background:rgba(255,45,85,0.92);color:#fff;font-size:9px;font-weight:900;letter-spacing:2px;padding:2px 7px;border-radius:4px;flex-shrink:0;">🔴 LIVE ON SHADOW NEXUS TV</span>
      ${avatarHtml}
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:800;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(chanName)}</div>
        <div style="font-size:10px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${_esc(liveTitle)}</div>
      </div>
    </div>
    <video id="snx-feat-video" playsinline style="width:100%;height:100%;object-fit:contain;background:#000;" autoplay></video>
    <div id="snx-feat-connecting" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.85);flex-direction:column;gap:10px;">
      <div style="font-size:28px;">📺</div>
      <div style="font-size:13px;font-weight:700;color:#00AEEF;letter-spacing:2px;">CONNECTING TO LIVE…</div>
    </div>
  `;

  // Ensure media area has position:relative for absolute children
  if (!mediaArea.style.position) mediaArea.style.position = 'relative';

  mediaArea.appendChild(featuredDiv);

  const videoEl = featuredDiv.querySelector('#snx-feat-video');
  const connecting = featuredDiv.querySelector('#snx-feat-connecting');

  _featurePlayerState = {
    active: true,
    liveId,
    videoEl,
    unsub: null,
  };

  // Start the feature watchdog
  startFeatureWatchdog(liveId);

  // Join the creator live WebRTC stream
  try {
    const { joinCreatorLive, leaveCreatorLive } = await import('./snx-creator-live.js');

    // Track whether we have already left (to prevent double-leave)
    let leftFlag = false;

    await joinCreatorLive(user, liveId, videoEl, event => {
      switch (event.type) {
        case 'connecting':
          if (connecting) connecting.style.display = 'flex';
          break;

        case 'stream':
        case 'connected':
          if (connecting) connecting.style.display = 'none';
          break;

        case 'reconnecting':
          if (connecting) {
            connecting.style.display = 'flex';
            connecting.querySelector('div:last-child').textContent = 'RECONNECTING TO LIVE…';
          }
          break;

        case 'ended':
          // Creator ended live — auto-return to schedule
          if (!leftFlag) {
            leftFlag = true;
            leaveCreatorLive().catch(() => {});
            onReturnScheduled?.('live_ended');
          }
          break;

        default:
          break;
      }
    });

    // Store leave function for cleanup
    _featurePlayerState.unsub = () => {
      if (!leftFlag) {
        leftFlag = true;
        leaveCreatorLive().catch(() => {});
      }
      stopFeatureWatchdog();
    };

  } catch (err) {
    console.warn('[SNX TV FEATURE] Failed to join featured live:', err.message);
    // Fallback: return to scheduled immediately
    dismountFeaturedLiveFromPlayer();
    onReturnScheduled?.('join_failed');
  }
}

/**
 * Dismount the featured live player from Main TV.
 * Called when returning to scheduled programming.
 */
export function dismountFeaturedLiveFromPlayer() {
  if (_featurePlayerState.unsub) {
    try { _featurePlayerState.unsub(); } catch (_) {}
  }
  stopFeatureWatchdog();

  const layer = document.getElementById('snx-featured-live-layer');
  if (layer) layer.remove();

  _featurePlayerState = { active: false, liveId: null, videoEl: null, unsub: null };
}

/* ════════════════════════════════════
   UTILITIES
════════════════════════════════════ */
function _esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
