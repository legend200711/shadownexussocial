/**
 * snx-radio-setup.js — Shadow Nexus Radio Stage 2 Test Data Setup
 *
 * Run this in the browser console while signed in as the Founder
 * (christijerina46@gmail.com) to create the initial test configuration.
 *
 * What it creates:
 *   /siteSettings/radioStation  — station OFF AIR, mode RADIO
 *   /radioPlaylists/snx-test-001 — test playlist (empty, ready for Founder uploads)
 *
 * !! TEST TRACK UPLOAD REQUIRED !!
 * No audio files are pre-invented.  Upload real audio via Shadow Nexus Radio
 * (Radio → Studio → Upload Track) then add the resulting
 * /radioTracks/{trackId} document IDs to the playlist using
 * SNXRadio.playlistUpdate('snx-test-001', { trackIds: ['id1','id2'] }).
 *
 * Usage:
 *   1. Open Shadow Nexus in Chrome/Firefox as the Founder account.
 *   2. Open DevTools → Console.
 *   3. Paste this entire file and press Enter.
 *   4. Or: load it via <script src="snx-radio-setup.js"></script>
 *      and call window.snxRadioSetup() from the console.
 */

(async function snxRadioSetup() {
  'use strict';

  console.log('[SNX-SETUP] Starting radio test data setup…');

  // ── 1. Verify we have Firestore ────────────────────────────────────────────
  const db = window._snxFirestore
    || (window.firebase && window.firebase.firestore && window.firebase.firestore());

  if (!db) {
    console.error('[SNX-SETUP] Firestore not available. Is firebase-config.js loaded?');
    return;
  }

  // ── 2. Verify auth (Founder check) ────────────────────────────────────────
  const auth = window._snxAuth
    || (window.firebase && window.firebase.auth && window.firebase.auth());

  if (!auth) {
    console.error('[SNX-SETUP] Firebase Auth not available.');
    return;
  }

  const user = window._snxCurrentUser || (auth.currentUser);
  if (!user) {
    console.error('[SNX-SETUP] Not signed in. Sign in as the Founder first.');
    return;
  }
  if (user.email !== 'christijerina46@gmail.com') {
    console.error('[SNX-SETUP] Must be signed in as the Founder account. Current:', user.email);
    return;
  }

  console.log('[SNX-SETUP] Founder verified:', user.email);

  // ── 3. Helper: write Firestore doc ─────────────────────────────────────────
  const mods = window._snxFirestoreModules;

  async function _setDoc(col, docId, data) {
    if (mods && mods.doc && mods.setDoc) {
      const ref = mods.doc(db, col, docId);
      await mods.setDoc(ref, data, { merge: true });
    } else if (db.collection) {
      await db.collection(col).doc(docId).set(data, { merge: true });
    } else {
      throw new Error('No supported Firestore write API found');
    }
  }

  // ── 4. Create /siteSettings/radioStation  (OFF AIR) ───────────────────────
  const stationDoc = {
    enabled:    false,
    mode:       'RADIO',              // engine ready; not broadcasting yet
    playlistId: 'snx-test-001',      // pre-point at the test playlist
    epochMs:    0,                    // will be overwritten by stationStart()
    updatedAt:  mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date(),
    note:       'Stage 2 test configuration — created by snx-radio-setup.js',
  };

  try {
    await _setDoc('siteSettings', 'radioStation', stationDoc);
    console.log('[SNX-SETUP] ✓ /siteSettings/radioStation created (OFF AIR, mode=RADIO)');
  } catch (e) {
    console.error('[SNX-SETUP] ✗ Failed to write radioStation:', e.message);
    return;
  }

  // ── 5. Create /radioPlaylists/snx-test-001  (empty, ready for tracks) ─────
  const playlistDoc = {
    name:      'SNX Test Playlist 001',
    trackIds:  [],     // !! TEST TRACK UPLOAD REQUIRED — add real track IDs here
    enabled:   true,
    createdAt: mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date(),
    updatedAt: mods && mods.serverTimestamp ? mods.serverTimestamp() : new Date(),
    note:      'Stage 2 test playlist — created by snx-radio-setup.js. Add trackIds after uploading audio.',
  };

  try {
    await _setDoc('radioPlaylists', 'snx-test-001', playlistDoc);
    console.log('[SNX-SETUP] ✓ /radioPlaylists/snx-test-001 created (empty — track upload required)');
  } catch (e) {
    console.error('[SNX-SETUP] ✗ Failed to write radioPlaylists:', e.message);
    return;
  }

  console.log('\n[SNX-SETUP] ══════════════════════════════════════════');
  console.log('[SNX-SETUP]  Stage 2 test data setup COMPLETE');
  console.log('[SNX-SETUP] ══════════════════════════════════════════');
  console.log('[SNX-SETUP]');
  console.log('[SNX-SETUP]  NEXT STEPS:');
  console.log('[SNX-SETUP]  1. Open Shadow Nexus → Radio (sidebar nav)');
  console.log('[SNX-SETUP]     In the Radio Studio: Upload Track');
  console.log('[SNX-SETUP]');
  console.log('[SNX-SETUP]  2. Track Library will list your uploaded tracks.');
  console.log('[SNX-SETUP]     Use "Add to Playlist" to create /radioTracks/{id} docs.');
  console.log('[SNX-SETUP]     Required fields: title, artist, audioUrl, duration, enabled:true');
  console.log('[SNX-SETUP]');
  console.log('[SNX-SETUP]  3. After tracks are added, update the playlist:');
  console.log('[SNX-SETUP]     SNXRadio.playlistUpdate("snx-test-001", { trackIds: ["id1","id2"] })');
  console.log('[SNX-SETUP]');
  console.log('[SNX-SETUP]  4. Start the station (Founder only):');
  console.log('[SNX-SETUP]     SNXRadio.stationStart("snx-test-001")');
  console.log('[SNX-SETUP]');
  console.log('[SNX-SETUP]  !! TEST TRACK UPLOAD REQUIRED !!');
  console.log('[SNX-SETUP]  No audio URLs were pre-invented.');

  return {
    status:    'OK',
    radioStation: stationDoc,
    playlist:  playlistDoc,
    message:   'TEST TRACK UPLOAD REQUIRED',
  };

})();

// ── Also expose as window function for manual re-runs ─────────────────────
window.snxRadioSetup = async function() {
  // Re-invoke the IIFE above by re-loading script context is not ideal;
  // instead call the internal logic again from a named export.
  console.log('[SNX-SETUP] Call snxRadioSetup() via the IIFE — reload the script or paste it again.');
};
