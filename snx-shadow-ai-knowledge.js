/**
 * snx-shadow-ai-knowledge.js
 * Shadow Nexus Social — Shadow Reaper Local Knowledge Base
 *
 * Build: SNS-2026-SHADOW-AI-STAGE1-001
 *
 * Exposes: window.SNXShadowKnowledge
 *
 * This module contains LOCAL knowledge about the CURRENT, VERIFIED
 * Shadow Nexus Social platform.  Features documented here were confirmed
 * by auditing index.html, snx-feature-loader.js, and related modules.
 *
 * Rules:
 *  • Only verified, existing features are described.
 *  • No invented features.
 *  • No fabricated navigation paths.
 *  • No external API calls.
 *  • Searchable via keywords, feature IDs, and phrase matching.
 *  • All navigation keys match _NAV_MAP in snx-shadow-ai.js exactly.
 */

(function (global) {
  'use strict';

  /* ─────────────────────────────────────────────────────────────
     KNOWLEDGE ENTRIES
     Each entry:
       id          unique key (matches _NAV_MAP where navigable)
       title       human-readable feature name
       keywords    array of lowercase strings for fast matching
       summary     one-sentence description
       description paragraph — what it is and what you can do
       how         how to access/use it
       navigation  null or key matching _NAV_MAP
       founderOnly flag — do not describe specifics if true
       troubleshooting  array of { symptom, resolution }
  ───────────────────────────────────────────────────────────────*/
  var KNOWLEDGE = [

    /* ── FEED ────────────────────────────────────────────────── */
    {
      id: 'feed',
      title: 'Eclipse Feed',
      keywords: ['feed', 'home', 'eclipse', 'timeline', 'post', 'posts', 'newsfeed',
                 'stories', 'story', 'react', 'reaction', 'comment', 'repost',
                 'main page', 'what people post', 'eclipse feed'],
      summary: 'The main social timeline of Shadow Nexus Social.',
      description: 'The Eclipse Feed is the main social timeline. Every post — text, images, and videos — from people you follow shows up here in real time. You can create your own posts, react with emoji, leave comments, repost content you love, and browse Stories at the top of the page. The Feed also shows who is currently live.',
      how: 'The Eclipse Feed is the default landing page after sign-in. It is also reachable from any navigation menu via the Home icon. To post: use the composer at the top of the feed, type or add media, then tap "Post to the Eclipse". Stories appear as bubbles above the feed.',
      navigation: 'feed',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Feed not loading', resolution: 'Check your internet connection. Pull down to refresh. If the problem continues, try reloading the page.' },
        { symptom: 'Posts not showing', resolution: 'You may not be following anyone yet. Visit profiles and tap Follow, then return to the Feed.' }
      ]
    },

    /* ── PROFILE ─────────────────────────────────────────────── */
    {
      id: 'profile',
      title: 'Profile',
      keywords: ['profile', 'bio', 'avatar', 'cover photo', 'display name', 'handle',
                 'edit profile', 'theme', 'colours', 'style', 'sandbox', 'social links',
                 'sections', 'mood', 'custom', 'followers', 'following', 'my page',
                 'profile music', 'background music', 'spotlight'],
      summary: 'Your personal space on Shadow Nexus Social.',
      description: 'Your Profile page is your personal space. It shows your display name, handle, bio, avatar, cover photo, posts, follower and following counts, friends, and photo album. You can fully customise it — bio, avatar, cover, custom theme colours, background music, spotlight message, social links, and more — by tapping the Edit Profile button.',
      how: 'Open your profile from the sidebar navigation. To edit: tap the Edit Profile button. Profile edit tabs: Basics (name, bio, handle), Mood (status), Media (avatar & cover photo), Style (custom theme & colours), Sandbox (free-form decoration), Links (social links), Sections (toggle which profile sections are visible). If you go live, a LIVE NOW badge appears on your profile automatically.',
      navigation: 'profile',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Cannot save profile changes', resolution: 'Make sure you are signed in. If the save button is unresponsive, check your internet connection and try again.' },
        { symptom: 'Avatar not updating', resolution: 'After uploading a new avatar, wait a few seconds for the upload to complete, then tap Save.' }
      ]
    },

    /* ── SEARCH ──────────────────────────────────────────────── */
    {
      id: 'search',
      title: 'Search',
      keywords: ['search', 'find', 'find user', 'find people', 'look up', 'look for',
                 'find someone', 'search users', 'user search'],
      summary: 'Find any user on Shadow Nexus Social by name or handle.',
      description: 'The Search page lets you find any user by their display name or handle. Type a name into the search bar and press Search to see matching profiles. From the results you can view profiles, follow users, or send them a message. Your own visibility in search is controlled in Settings → Privacy.',
      how: 'Open Search from the sidebar navigation (🔍 icon). Type a display name or handle and tap Search. Tap any result to view that profile.',
      navigation: 'search',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Cannot find a user', resolution: 'Check the spelling. If the user has restricted their search visibility in Settings → Privacy, they may not appear.' }
      ]
    },

    /* ── NOTIFICATIONS ───────────────────────────────────────── */
    {
      id: 'notifications',
      title: 'Notification Center',
      keywords: ['notifications', 'notification', 'notif', 'alerts', 'bell', 'mention',
                 'like notification', 'follow notification', 'push notification',
                 'unread', 'notification center', 'mark all read', 'clear notifications'],
      summary: 'All your alerts in one place — messages, likes, follows, and system announcements.',
      description: 'The Notification Center collects every alert. It has four filter tabs: Messages (direct messages), Likes & Comments (activity on your posts), Followers (new follows and friend requests), and System (platform announcements). You can mark all notifications as read or clear them all with the buttons at the top.',
      how: 'Open the Notification Center from the 🔔 icon in the sidebar. The red badge shows how many unread notifications you have. Push notification preferences — which types send alerts to your device — are in Settings → Notification Preferences.',
      navigation: 'notifications',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Not receiving push notifications', resolution: 'Go to Settings → Notification Preferences and tap "Enable Push". Your browser will ask for permission — allow it.' },
        { symptom: 'Badge count not clearing', resolution: 'Open the Notification Center and tap "Mark All Read" at the top.' }
      ]
    },

    /* ── INBOX ───────────────────────────────────────────────── */
    {
      id: 'inbox',
      title: 'Inbox',
      keywords: ['inbox', 'message', 'messages', 'direct message', 'dm', 'chat',
                 'conversations', 'unread messages', 'message list', 'conversation list'],
      summary: 'All your direct message conversations.',
      description: 'The Inbox shows all your direct message conversations. Each row shows the other person\'s name, their online status, a preview of the last message, and an unread count badge. Tap any conversation to open the chat overlay. You can also search conversations by name.',
      how: 'Open the Inbox from the 💬 icon in the sidebar navigation. To start a new conversation, visit someone\'s profile and tap Message. Conversations are sorted newest first.',
      navigation: 'inbox',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Messages not sending', resolution: 'Check your internet connection. Make sure the recipient has not restricted messages to "Friends only" or "Nobody" in their Settings.' }
      ]
    },

    /* ── SETTINGS ────────────────────────────────────────────── */
    {
      id: 'settings',
      title: 'Settings',
      keywords: ['settings', 'setting', 'privacy', 'account settings', 'privacy settings',
                 'who can see', 'delete account', 'push notifications', 'notification preferences',
                 'game invites', 'password', 'wall settings', 'tag', 'friend request privacy',
                 'family request', 'change performance mode', 'performance mode',
                 'performance', 'quality', 'lite', 'balanced', 'full', 'auto'],
      summary: 'Control your account, privacy, notifications, and performance across Shadow Nexus Social.',
      description: 'Settings gives you full control over your account. Privacy section — choose who can see your profile, send you friend requests, message you, find you in search, write on your wall, send family requests, view your friends list, view your family list, and tag you in posts. Each option: Everyone, Friends only, Followers, Nobody, or Only me. Notification Preferences — toggle push alerts per type. Performance Mode — choose between Auto, ULTRA, HIGH, BALANCED, LITE, and MINIMAL quality levels.',
      how: 'Open Settings from the ⚙️ icon in the sidebar or Shadow Core navigation. Scroll to find the section you need. To change performance mode, scroll to the Performance section and select your preferred quality level. Your choice is saved.',
      navigation: 'settings',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Cannot find performance mode setting', resolution: 'Open Settings and scroll down to the Performance section. You will see quality mode options including Auto, BALANCED, LITE, and others.' },
        { symptom: 'Privacy changes not saving', resolution: 'Make sure you are signed in and have a stable internet connection, then tap Save.' }
      ]
    },

    /* ── STORM ROOMS ─────────────────────────────────────────── */
    {
      id: 'stormrooms',
      title: 'Storm Rooms',
      keywords: ['storm rooms', 'storm room', 'anonymous chat', 'live chat', 'public lobby',
                 'private room', 'room code', 'ephemeral chat', 'shadow room',
                 'anonymous', 'no real name', 'temporary chat'],
      summary: 'Live anonymous chat rooms where messages vanish after 10 minutes.',
      description: 'Storm Rooms are live anonymous chat rooms. Choose a shadow display name, then join the Public Lobby (open to everyone, no code needed) or a Private Room using a room code. Private rooms can also be created — you get a code to share with friends. Messages vanish after 10 minutes. No real names. No judgment.',
      how: '1) Open Storm Rooms from the sidebar. 2) Enter a shadow display name. 3) Tap "Enter Public Lobby" for open chat, or enter a room code to join a private room. To create a private room tap "Create New Private Room" — you get a code to share. Inside a room: see who is online, send messages with emoji, copy the room code, or leave.',
      navigation: 'stormrooms',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Cannot join a private room', resolution: 'Make sure you have the correct room code. Codes are case-sensitive. Ask the room creator to share the code again.' }
      ]
    },

    /* ── SUPPORT ROOMS ───────────────────────────────────────── */
    {
      id: 'supportrooms',
      title: 'Support Rooms',
      keywords: ['support rooms', 'support room', 'peer support', 'night owls', 'morning light',
                 'venting lounge', 'healing circle', 'grief garden', 'self-love club',
                 'someone to talk to', 'need support', 'mental health rooms', 'safe space',
                 'anxiety room', 'depression room', 'grief room', 'trauma room'],
      summary: 'Safe, calm, anonymous peer-support spaces for real human conversations.',
      description: 'Support Rooms are calm, safe, anonymously moderated spaces to share what you are going through and receive genuine peer support. There are six dedicated rooms: Night Owls (anxiety), Morning Light (depression), Venting Lounge (general venting), Healing Circle (trauma & recovery), Grief Garden (loss & grief), and Self-Love Club (body image & esteem). No judgment. No real names required. Crisis resources are always visible in every room.',
      how: '1) Open Support Rooms from the sidebar. 2) Choose a gentle display name. 3) Pick a room that fits what you are carrying and tap to join. Inside: chat, use the emoji picker, read room rules. Crisis line: call or text 988 (US), 116 123 (UK), 13 11 14 (Australia). Room rules: be kind, no bullying, no medical advice, respect everyone\'s pace.',
      navigation: 'supportrooms',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Cannot connect to a Support Room', resolution: 'Check your internet connection. Support Rooms require an active connection to send and receive messages.' }
      ]
    },

    /* ── COMMUNITY HUB ───────────────────────────────────────── */
    {
      id: 'community',
      title: 'Community Hub',
      keywords: ['community hub', 'community', 'quote of the day', 'daily challenge', 'xp',
                 'kindness badge', 'community goal', 'community pulse', 'anonymous board',
                 'anonymous support board', 'kindness', 'badge', 'challenge', 'community event'],
      summary: 'A positive shared space with challenges, badges, quotes, and community features.',
      description: 'The Community Hub is a positive shared space. Sections: Quote of the Day (tap ↻ for a new one) · Daily Challenge (complete it for +50 XP, resets daily) · Community Goals (shared platform-wide targets) · Kindness Badges (earned by positive actions, visible on your profile) · Community Pulse (send silent emoji energy to everyone) · Anonymous Support Board (post feelings tagged as Just Sharing / Need Support / Venting / Grateful / Milestone — toggle anonymous on or off).',
      how: 'Open Community Hub from the 💙 icon in the sidebar. Tap a section to interact. To claim the Daily Challenge reward tap "Complete Challenge". Kindness Badges appear automatically as you earn them.',
      navigation: 'community',
      founderOnly: false,
      troubleshooting: []
    },

    /* ── COMMUNITY RULES ─────────────────────────────────────── */
    {
      id: 'rules',
      title: 'Community Rules',
      keywords: ['community rules', 'rules', 'guidelines', 'what is allowed', 'not allowed',
                 'report', 'appeal', 'moderation', 'banned', 'warning', 'hate speech',
                 'bullying', 'harassment', 'spam rules', 'safety', 'reported'],
      summary: 'The six community rules and the platform safety flow.',
      description: 'The Community Rules page outlines what is and is not allowed. Six prohibited behaviours: Bullying, Harassment, Threats, Hate Speech, Spam, and Repeated Disruptive Behaviour. These rules apply to posts, stories, messages, and live streams. Safety flow: Rule broken → AI detects → Warning issued → Continued issue → Action taken → User can appeal → Founder reviews → Accept or deny.',
      how: 'Open Community Rules from the 📜 icon in the sidebar. To appeal a moderation action, go to the Reports section, explain what happened in your own words, and your case will be reviewed personally by the Founder.',
      navigation: 'rules',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'I received a warning I do not understand', resolution: 'Open Community Rules to review the guidelines. If you believe the warning was incorrect, submit an appeal through the Reports section.' }
      ]
    },

    /* ── FRIENDS & FAMILY ────────────────────────────────────── */
    {
      id: 'friends',
      title: 'Nexus Family & Friends',
      keywords: ['friends', 'family', 'friend request', 'family request', 'connections',
                 'follow', 'following', 'followers', 'nexus family', 'friends list',
                 'family list', 'add friend', 'add family', 'pending requests',
                 'accept friend', 'decline friend'],
      summary: 'Manage your friend and family connections on Shadow Nexus Social.',
      description: 'The Nexus Family & Friends page manages your connections. It has three tabs: Friends (people you are mutually connected with), Requests (pending friend requests you have received), and Family (members you have added to your inner circle with ❤️ Family). You can accept or decline requests from here. Privacy for who can send requests and see your lists is in Settings.',
      how: 'Open Friends & Family from the 🦋 icon in the sidebar. Use the tabs to navigate between Friends, Requests, and Family. To accept a friend request tap Accept. To send a friend request, visit someone\'s profile and tap Add Friend.',
      navigation: 'friends',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Friend requests not arriving', resolution: 'Check Settings → Privacy → Friend requests to ensure "Everyone" is selected. If it is set to "Nobody", no one can send you requests.' }
      ]
    },

    /* ── ARCADE ──────────────────────────────────────────────── */
    {
      id: 'arcade',
      title: 'Arcade',
      keywords: ['arcade', 'mini game', 'mini games', 'games', 'game hub', 'play game',
                 'challenge friend', 'game invite', 'game challenge', 'play'],
      summary: 'Shadow Nexus Social\'s built-in mini-game hub.',
      description: 'The Arcade is Shadow Nexus Social\'s built-in mini-game hub. You can play games solo or challenge friends directly from their profile. Game challenge invitations go through the notification system. Arcade invite preferences (who can challenge you) are adjustable in Settings → Game Challenges.',
      how: 'Open the Arcade from the 🕹️ icon in the sidebar navigation. To challenge a friend: visit their profile and tap the Challenge button, choose a game, and send the invite. Pending challenges appear in the Arcade Hub.',
      navigation: 'arcade',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Cannot challenge a friend', resolution: 'Make sure the other user allows game challenges. They can change this in Settings → Game Challenges. Also confirm you are mutual friends.' }
      ]
    },

    /* ── RADIO ───────────────────────────────────────────────── */
    {
      id: 'radio',
      title: 'Shadow Nexus Radio',
      keywords: ['radio', 'shadow nexus radio', 'music', 'stream', 'listen', 'station',
                 'now playing', 'track', 'song', 'listening now', 'request a song',
                 'song request', 'radio comments', 'radio chat', 'dj', 'dj mode',
                 'broadcast', 'radio broadcast', 'radio studio', 'schedule',
                 'where is radio', 'how do i open radio'],
      summary: '24/7 live music streaming with chat, song requests, and DJ Mode.',
      description: 'Shadow Nexus Radio is a 24/7 community music stream. You can listen to live music, see what is playing, leave comments in the radio chat, and submit song requests. Founders and DJs can access Radio Studio to manage broadcasts and scheduling.',
      how: 'Open Radio from the 📻 icon in the sidebar or the Shadow Core navigation. The player loads automatically. To leave a comment: type in the radio chat and tap Send. To request a song: look for the Song Request section on the Radio page and submit your request. DJ Mode is a special feature for authorised DJs.',
      navigation: 'radio',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Radio not playing', resolution: 'Check your internet connection. On mobile, make sure your device is not on silent and that browser audio permission is granted. Try tapping the play button if it has paused.' },
        { symptom: 'Cannot request a song', resolution: 'Song requests are on the Radio page. Scroll down to find the Request section. You must be signed in to submit a request.' }
      ]
    },

    /* ── RADIO COMMENTS ──────────────────────────────────────── */
    {
      id: 'radioComments',
      title: 'Radio Comments',
      keywords: ['radio comments', 'radio chat', 'comment on radio', 'radio message',
                 'live chat radio'],
      summary: 'Live chat alongside the Radio stream.',
      description: 'Radio Comments is the live chat that appears alongside the Shadow Nexus Radio stream. You can read what other listeners are saying and post your own messages while the music plays.',
      how: 'Open Radio from the sidebar. The comments section is below the player on the Radio page. Type your message and tap Send. You must be signed in to comment.',
      navigation: 'radio',
      founderOnly: false,
      troubleshooting: []
    },

    /* ── SONG REQUESTS ───────────────────────────────────────── */
    {
      id: 'radioRequests',
      title: 'Song Requests',
      keywords: ['song request', 'request a song', 'request song', 'radio request',
                 'request music', 'how do i request', 'submit request'],
      summary: 'Submit a song request to the Shadow Nexus Radio DJ.',
      description: 'The Song Request feature lets you submit a song to the DJ during a Radio broadcast. Requests are visible to the DJ and may be played during the stream.',
      how: 'Open Radio from the sidebar. Scroll down to find the Song Requests section on the Radio page. Enter the song name and artist, then tap Submit. You must be signed in to submit a request.',
      navigation: 'radio',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Song request section not visible', resolution: 'Song requests may only appear when a broadcast is active. Check that Radio is live and try again.' }
      ]
    },

    /* ── LISTENING NOW ───────────────────────────────────────── */
    {
      id: 'listeningNow',
      title: 'Listening Now',
      keywords: ['listening now', 'who is listening', 'listeners', 'radio presence',
                 'who is online radio'],
      summary: 'See who is currently listening to Shadow Nexus Radio.',
      description: 'Listening Now shows you which members are currently tuned in to Shadow Nexus Radio in real time.',
      how: 'Open Radio from the sidebar. The Listening Now presence display appears on the Radio page alongside the player.',
      navigation: 'radio',
      founderOnly: false,
      troubleshooting: []
    },

    /* ── DJ MODE ─────────────────────────────────────────────── */
    {
      id: 'dj',
      title: 'DJ Mode',
      keywords: ['dj', 'dj mode', 'disk jockey', 'mixing', 'go live radio',
                 'what is dj mode', 'become dj', 'dj controls'],
      summary: 'DJ Mode gives authorised DJs live broadcast controls during Radio.',
      description: 'DJ Mode is a feature within Shadow Nexus Radio that provides authorised DJs with live broadcast controls. DJs can manage the music stream, interact with listeners, and control what plays on the station.',
      how: 'DJ Mode is accessible from the Radio page if your account has been authorised as a DJ by the Founder. The DJ controls panel appears automatically for qualified users.',
      navigation: 'radio',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'DJ controls not visible', resolution: 'DJ Mode requires authorisation from the Founder. If you believe you should have DJ access, contact the Founder directly.' }
      ]
    },

    /* ── LIVE ────────────────────────────────────────────────── */
    {
      id: 'live',
      title: 'Shadow Nexus Live',
      keywords: ['live', 'live stream', 'go live', 'live video', 'broadcast',
                 'live viewer', 'live now', 'watch live', 'stream live',
                 'where is live', 'how do i go live', 'live hub'],
      summary: 'Live video streaming — watch community members stream or go live yourself.',
      description: 'Shadow Nexus Live is the platform\'s live video streaming feature. You can watch other members who are live directly from the Live Hub, or start your own live stream. The Live Hub shows all currently active streams. A LIVE NOW badge appears on the profiles of users who are currently streaming.',
      how: 'Open Live from the 🔴 icon in the sidebar or Shadow Core navigation. The Live Hub loads showing active streams. To watch a stream tap on it. To go live yourself, tap the Start Stream button. You must be signed in.',
      navigation: 'live',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Cannot start a live stream', resolution: 'Make sure your browser has camera and microphone permission. Check your internet connection — live streaming requires a stable connection.' },
        { symptom: 'Live stream buffering or freezing', resolution: 'Your internet connection may be too slow for smooth streaming. Move to a stronger connection and try reloading.' }
      ]
    },

    /* ── TV ──────────────────────────────────────────────────── */
    {
      id: 'tv',
      title: '24-Hour TV / Shadow Nexus TV',
      keywords: ['tv', 'television', 'nexus tv', 'shadow nexus tv', '24 hour tv',
                 '24-hour tv', 'watch tv', 'channel', 'tv channel', 'where is tv',
                 'how do i open tv', 'tv studio', 'tv network', 'studio'],
      summary: '24-hour TV network with live and on-demand content on Shadow Nexus Social.',
      description: 'Shadow Nexus TV is the platform\'s 24-hour television experience. You can watch live and scheduled content across channels. The TV feature includes a Watch tab for viewing content and, for authorised creators, a TV Studio tab for managing and broadcasting.',
      how: 'Open TV from the 📺 icon in the sidebar or Shadow Core navigation (labelled 24-Hour TV). The Watch tab opens automatically. Use the channel navigation to browse content.',
      navigation: 'tv',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'TV not loading', resolution: 'TV loads its engine lazily on first visit. If it does not load, check your internet connection and try refreshing the page.' }
      ]
    },

    /* ── SHADOW REAPER / GRIM ────────────────────────────────── */
    {
      id: 'shadowReaper',
      title: 'Shadow Reaper',
      keywords: ['shadow reaper', 'grim', 'ai assistant', 'assistant', 'guide',
                 'who are you', 'what are you', 'what can you do', 'click here',
                 'help', 'guardian', 'shadow nexus guide', 'your name'],
      summary: 'Your guide and guardian through Shadow Nexus Social.',
      description: 'I am Shadow Reaper — the guardian and guide of Shadow Nexus Social. I know every public feature on this platform. Ask me where to find anything, how something works, or what a feature does. I can also navigate you directly to most sections with a single tap. And if you just want to talk, I am here for that too.',
      how: 'You are already speaking with me. Type your question or use the quick chips in the panel.',
      navigation: null,
      founderOnly: false,
      troubleshooting: []
    },

    /* ── PERFORMANCE MODE ────────────────────────────────────── */
    {
      id: 'performance',
      title: 'Performance Mode',
      keywords: ['performance', 'performance mode', 'quality mode', 'lite mode', 'balanced mode',
                 'full mode', 'minimal', 'change performance', 'how do i change performance',
                 'graphics', 'animation', 'slow', 'laggy', 'battery saver', 'reduce effects',
                 'snxperf', 'adaptive performance', 'auto mode', 'ultra mode', 'high mode'],
      summary: 'Adaptive quality system that controls visual effects and performance across the site.',
      description: 'Shadow Nexus Social uses an adaptive performance system with six quality levels: AUTO (system picks the best level automatically), ULTRA (maximum effects), HIGH, BALANCED (default), LITE (reduced effects, better battery), and MINIMAL (bare-bones performance). The system adjusts automatically based on your device, connection, and frame rate. You can override it manually in Settings.',
      how: 'Open Settings from the sidebar and scroll down to the Performance section. Select your preferred mode. AUTO is recommended for most devices. Choose LITE or MINIMAL if the site feels slow or to save battery. Your choice is remembered between sessions.',
      navigation: 'settings',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Site is slow or laggy', resolution: 'Open Settings and switch Performance Mode to LITE or MINIMAL. This reduces animations and visual effects significantly.' },
        { symptom: 'Mode keeps changing on its own', resolution: 'If Performance Mode is set to AUTO, the system adjusts it based on your current frame rate and device load. To keep it fixed, select a specific level like BALANCED.' }
      ]
    },

    /* ── ACCOUNT ─────────────────────────────────────────────── */
    {
      id: 'account',
      title: 'Account',
      keywords: ['account', 'sign in', 'sign out', 'log in', 'log out', 'sign up',
                 'register', 'create account', 'delete account', 'password',
                 'forgot password', 'email', 'authentication'],
      summary: 'Account creation, sign-in, and account management on Shadow Nexus Social.',
      description: 'Shadow Nexus Social accounts are managed through the authentication system. You can sign in with email and password. Account deletion is permanent and removes all your data — this option is in Settings → Danger Zone.',
      how: 'Sign in using the sign-in screen. To manage your account: open Settings. To delete your account permanently: open Settings → scroll to Danger Zone → tap Delete Account. This action is irreversible.',
      navigation: 'settings',
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Forgot password', resolution: 'On the sign-in screen, tap "Forgot password" to receive a reset link by email.' },
        { symptom: 'Cannot sign in', resolution: 'Double-check your email and password. Make sure Caps Lock is off. If the problem continues, use the forgot password option.' }
      ]
    },

    /* ── TROUBLESHOOTING GENERAL ─────────────────────────────── */
    {
      id: 'troubleshooting',
      title: 'General Troubleshooting',
      keywords: ['not working', 'broken', 'error', 'problem', 'issue', 'bug',
                 'page not loading', 'crash', 'freezing', 'stuck', 'reload',
                 'refresh', 'clear cache', 'troubleshoot', 'something wrong'],
      summary: 'General steps to resolve common issues on Shadow Nexus Social.',
      description: 'Most issues on Shadow Nexus Social can be resolved with a few basic steps.',
      how: '1) Check your internet connection. 2) Reload the page (pull to refresh on mobile, F5 on desktop). 3) Try signing out and signing back in. 4) Clear your browser cache. 5) Try a different browser or device. If a specific feature is not working, ask me about that feature by name.',
      navigation: null,
      founderOnly: false,
      troubleshooting: [
        { symptom: 'Everything is broken', resolution: 'Try reloading the page. If you are offline, the app will show an offline page — reconnect to the internet and reload.' },
        { symptom: 'Something looks visually wrong', resolution: 'Try switching Performance Mode in Settings. Some visual glitches are related to high-quality effects on older hardware.' }
      ]
    }
  ];

  /* ─────────────────────────────────────────────────────────────
     KEYWORD INDEX  (built once at load time)
  ───────────────────────────────────────────────────────────────*/
  var _index = {};  // keyword → [entryId, ...]

  (function buildIndex() {
    KNOWLEDGE.forEach(function (entry) {
      entry.keywords.forEach(function (kw) {
        if (!_index[kw]) _index[kw] = [];
        if (_index[kw].indexOf(entry.id) === -1) _index[kw].push(entry.id);
      });
    });
  })();

  /* ─────────────────────────────────────────────────────────────
     QUERY ENGINE
     Lightweight keyword + phrase matching — no external libraries.
  ───────────────────────────────────────────────────────────────*/

  /** Return entry by id */
  function _byId(id) {
    for (var i = 0; i < KNOWLEDGE.length; i++) {
      if (KNOWLEDGE[i].id === id) return KNOWLEDGE[i];
    }
    return null;
  }

  /** Score a message string against a knowledge entry */
  function _score(text, entry) {
    var t = text.toLowerCase();
    var score = 0;

    /* Exact id mention */
    if (t.indexOf(entry.id.toLowerCase()) !== -1) score += 10;

    /* Title mention */
    if (entry.title && t.indexOf(entry.title.toLowerCase()) !== -1) score += 8;

    /* Keyword matches */
    entry.keywords.forEach(function (kw) {
      if (t.indexOf(kw) !== -1) score += kw.split(' ').length; // longer phrase = higher weight
    });

    return score;
  }

  /** Main query function — returns {text, page, handled} or null */
  function query(message, context) {
    if (!message) return null;

    var text = message.trim();
    if (!text) return null;

    /* Score all entries */
    var scored = KNOWLEDGE.map(function (entry) {
      return { entry: entry, score: _score(text, entry) };
    });

    /* Sort descending */
    scored.sort(function (a, b) { return b.score - a.score; });

    /* No match */
    if (scored[0].score === 0) return null;

    var best = scored[0].entry;

    /* Construct response */
    var responseText = best.description;

    /* Add how-to if question words present */
    var isHowQ = /\b(how|where|what|find|go to|open|access|get to|navigate|location)\b/i.test(text);
    if (isHowQ && best.how) {
      responseText += ' ' + best.how;
    }

    /* Troubleshooting match */
    var tText = text.toLowerCase();
    var foundTrouble = null;
    if (best.troubleshooting) {
      best.troubleshooting.forEach(function (t) {
        if (!foundTrouble && t.symptom && tText.indexOf(t.symptom.toLowerCase().split(' ').slice(0, 3).join(' ')) !== -1) {
          foundTrouble = t;
        }
      });
    }
    if (foundTrouble) {
      responseText = foundTrouble.resolution;
    }

    return {
      text: responseText,
      page: best.navigation || null,
      handled: true
    };
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API  — window.SNXShadowKnowledge
  ───────────────────────────────────────────────────────────────*/
  global.SNXShadowKnowledge = {
    /**
     * Query local knowledge.
     * @param {string} message   - user message text
     * @param {object} context   - optional context from SNXShadowAI.getContext()
     * @returns {{text, page, handled}|null}
     */
    query: query,

    /**
     * Get all knowledge entries.
     * @returns {Array}
     */
    getAll: function () { return KNOWLEDGE; },

    /**
     * Get a single entry by feature id.
     * @param {string} id
     * @returns {object|null}
     */
    getEntry: function (id) { return _byId(id); },

    /**
     * Get all feature category IDs.
     * @returns {string[]}
     */
    getCategories: function () { return KNOWLEDGE.map(function (e) { return e.id; }); },

    /** Build identifier */
    build: 'SNS-2026-SHADOW-AI-STAGE1-001'
  };

})(window);
