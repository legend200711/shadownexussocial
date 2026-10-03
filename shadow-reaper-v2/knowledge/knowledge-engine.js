/**
 * shadow-reaper-v2/knowledge/knowledge-engine.js
 * Shadow Reaper V2 — Knowledge Engine
 *
 * Build: SR-V2-KNOWLEDGE-2
 *
 * Exposes: window.SRKnowledge
 *
 * PURPOSE:
 *   Provides structured, retrievable knowledge about Shadow Nexus Social,
 *   creator public information, and general capabilities.
 *
 * ARCHITECTURE:
 *   - Knowledge is NEVER injected into every conversation.
 *   - Knowledge is retrieved ONLY when the query is relevant.
 *   - SNS knowledge does NOT hijack unrelated conversations.
 *   - Creator knowledge protects all private information.
 *
 * MODEL INDEPENDENCE:
 *   Zero external AI calls. Pure deterministic local lookup.
 *
 * PORTABLE:
 *   This module is designed to work standalone — no SNS dependency.
 *   SNS-specific knowledge is isolated in a dedicated category.
 *
 * KNOWLEDGE STATUS KEY (for internal reference):
 *   CURRENT_VERIFIED  — confirmed against current SNS codebase
 *   CURRENT_PARTIAL   — feature exists, some details uncertain
 *   OUTDATED          — known old; do not use
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-V2-KNOWLEDGE-2';

  /* ─────────────────────────────────────────────────────────────
     KNOWLEDGE CATEGORIES
  ───────────────────────────────────────────────────────────────*/
  var CATEGORY = {
    SNS:     'SNS',      // Shadow Nexus Social platform  [CURRENT_VERIFIED]
    CREATOR: 'CREATOR',  // Public creator information    [CURRENT_VERIFIED]
    GENERAL: 'GENERAL',  // General capability info       [CURRENT_VERIFIED]
  };

  /* ─────────────────────────────────────────────────────────────
     KNOWLEDGE BASE
     Each entry: { category, keywords: [], content, _status }
     keywords drive relevance detection — no full-text scan needed.
     _status is internal metadata, never shown to users.
  ───────────────────────────────────────────────────────────────*/
  var KNOWLEDGE_BASE = [

    /* ══════════════════════════════════════════════════════════
       SHADOW NEXUS SOCIAL — PLATFORM OVERVIEW
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'shadow nexus social', 'sns', 'what is shadow nexus', 'platform overview',
        'about shadow nexus', 'shadow nexus', 'what can i do on this website',
        'what is this site', 'what is this platform', 'what does shadow nexus do',
        'features of shadow nexus', 'what does this website have',
      ],
      content: 'Shadow Nexus Social is a creative social platform built by Chris (Legend of Shadows). It includes: Eclipse Feed (social posts), Live video streaming with Cohost, 24-Hour TV channels and TV Studio, Radio and Radio Studio for DJ streaming, Inbox for direct messages, Notifications, Search, Profiles, Friends/follow system, Community Hub, Storm Rooms (live chat), Support Rooms (moderated safe spaces), Arcade games, and PWA install support. You need an account for most features; some browsing is available as a guest.',
    },

    /* ══════════════════════════════════════════════════════════
       ECLIPSE FEED
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'eclipse feed', 'feed', 'timeline', 'posts', 'home feed', 'news feed',
        'what is eclipse feed', 'what does eclipse feed do', 'what can i do on the feed',
        'how does the feed work', 'post something', 'share a post',
        'create a post', 'write a post',
      ],
      content: 'Eclipse Feed is the main social feed on Shadow Nexus Social. It shows posts from people you follow. You can create text posts, share media, like and comment on posts, and see who is currently live. The Eclipse Feed is the home page after login. The ⚡ CLICK ME button next to Eclipse Feed opens Shadow Reaper. Live streams happening right now appear as a banner at the top of the feed.',
    },
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'like a post', 'comment on a post', 'comments', 'likes',
        'how to like', 'how to comment', 'interact with posts',
        'share posts', 'post pictures', 'post images', 'post videos',
        'upload to feed', 'feed uploads',
      ],
      content: 'On the Eclipse Feed you can like posts, leave comments, and share media. You can upload images and videos directly to your posts. Posts from people you follow appear in your feed automatically.',
    },

    /* ══════════════════════════════════════════════════════════
       LIVE — SHADOW NEXUS LIVE
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'shadow nexus live', 'live video', 'go live', 'live stream', 'live broadcast',
        'cohost', 'live feature', 'live system', 'what is live', 'live',
        'how do i go live', 'start a live', 'watch a live', 'join a live',
        'invite someone to live', 'live streaming', 'who is live',
        'viewers', 'live chat', 'live viewer',
      ],
      content: 'Shadow Nexus Live lets creators broadcast live video to their followers. To go live: navigate to the Live section and tap the GO LIVE button (you must be logged in). While live, viewers can watch and interact in real time. You can invite a Cohost to join your stream — the cohost appears alongside you in the broadcast. Live streams currently happening are shown in a banner at the top of Eclipse Feed and are also searchable.',
    },
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'cohost', 'co-host', 'cohosting', 'what is cohost', 'how does cohosting work',
        'invite cohost', 'join as cohost', 'two people live',
      ],
      content: 'Cohost is a feature of Shadow Nexus Live that lets a second person join your live stream as a co-broadcaster. When you are live, you can invite another user to cohost. The cohost joins your stream and viewers can see both of you. Only the original streamer initiates the cohost invitation.',
    },

    /* ══════════════════════════════════════════════════════════
       RADIO
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'radio', 'listen', 'music stream', 'radio station', 'radio player',
        'shadow nexus radio', 'how does radio work', 'tune in', 'radio listener',
        'who is on radio', 'radio requests', 'request a song', 'radio chat',
        'radio comments', 'listening to radio',
      ],
      content: 'Radio on Shadow Nexus Social lets you listen to live music streams from DJs and creators. When Radio is active you can tune in, see the current track, send song requests, and chat in the radio comments. Navigate to the Radio section from the sidebar to access it. You can see how many other people are listening.',
    },
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'radio studio', 'dj', 'dj mode', 'broadcast radio', 'stream music',
        'go live radio', 'difference between radio', 'radio broadcast',
        'how to be a dj', 'start a radio stream', 'radio studio access',
        'founder radio', 'dj controls',
      ],
      content: 'Radio Studio is the broadcasting side of Radio — it is for DJs and Founders who want to stream live audio. From Radio Studio you can start a broadcast, manage tracks, and control the stream. DJ Mode provides mixing controls. Radio Studio is separate from the Radio listener page: Radio = listening, Radio Studio = broadcasting. Access to Radio Studio is typically limited to Founders and authorized DJs.',
    },

    /* ══════════════════════════════════════════════════════════
       TV — SHADOW NEXUS TV / 24-HOUR TV
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'shadow tv', '24 hour', '24-hour tv', 'television', 'shadow nexus tv',
        'what is tv', 'what is the tv', 'tv channels', 'watch tv', 'tv studio',
        'how does tv work', 'run a channel', 'tv network', 'tv for',
        'creator channel', 'tune into tv', 'tv viewer', 'shadow nexus television',
        'what does tv do', 'how does the tv work', 'what can i do with tv',
      ],
      content: 'Shadow Nexus Social TV features 24-hour TV channels that play continuously. Viewers can tune in to different channels in the TV section. Creators can run their own channels and manage what plays. TV Studio is where creators schedule and broadcast their channel\'s content. Navigate to the TV section from the sidebar to start watching.',
    },

    /* ══════════════════════════════════════════════════════════
       INBOX / MESSAGES
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'inbox', 'messages', 'dm', 'direct message', 'messaging', 'chat',
        'where are my messages', 'how do i message someone', 'send a message',
        'start a conversation', 'new conversation', 'inbox page',
        'private message', 'private chat', 'how do i dm',
      ],
      content: 'The Inbox on Shadow Nexus Social is where your direct messages live. To access it, tap the Inbox icon in the navigation sidebar or top bar. You can start a new conversation from the Inbox — search for a user and open a chat. Inbox requires a logged-in account. Messages are private between you and the other person.',
    },

    /* ══════════════════════════════════════════════════════════
       NOTIFICATIONS
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'notifications', 'alerts', 'activity', 'notification center',
        'how do notifications work', 'what are notifications', 'notify me',
        'new follower notification', 'like notification', 'comment notification',
        'notification bell',
      ],
      content: 'Notifications on Shadow Nexus Social keep you updated on activity related to your account — new followers, likes on your posts, comments, replies, mentions, and system alerts. Access notifications from the Notifications icon in the navigation bar. You must be logged in to see your notifications.',
    },

    /* ══════════════════════════════════════════════════════════
       SEARCH
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'search', 'find', 'discover users', 'search people', 'how do i find someone',
        'find a user', 'search for someone', 'find content', 'search posts',
        'search music', 'search live', 'search tab', 'people tab',
      ],
      content: 'Search on Shadow Nexus Social lets you find users, posts, music, and live streams. Open Search from the navigation sidebar. You can switch between tabs: People, Posts, Music, and Live. Type in the search bar to see results in real time. Use Search to discover new creators and content.',
    },

    /* ══════════════════════════════════════════════════════════
       PROFILES
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'profile', 'my profile', 'user profile', 'edit profile', 'profile page',
        'how do i edit my profile', 'change profile picture', 'profile picture',
        'profile bio', 'view someone\'s profile', 'public profile',
        'profile music', 'profile theme', 'customize profile',
      ],
      content: 'Your profile on Shadow Nexus Social shows your posts, media, and public information. You can edit your profile to set a display name, bio, and profile picture. Profiles support custom themes and music. You can view other users\' profiles by tapping their name or avatar. Some profile customization features like themes and music may be part of creator-tier settings.',
    },

    /* ══════════════════════════════════════════════════════════
       FRIENDS / FOLLOW SYSTEM
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'friends', 'follow', 'followers', 'following', 'friend request', 'connect',
        'how to follow someone', 'how to add a friend', 'unfollow', 'who follows me',
        'follow system', 'friend system', 'connections',
      ],
      content: 'Shadow Nexus Social uses a follow system. You can follow other users to see their posts in your Eclipse Feed. When you follow someone they may follow you back. You can see your followers and who you are following from your profile. There is no separate "friend request" — following is one-directional unless they follow back.',
    },

    /* ══════════════════════════════════════════════════════════
       UPLOADS
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'uploads', 'upload', 'post media', 'share files', 'upload music',
        'how do i upload', 'upload a video', 'upload an image', 'upload a photo',
        'add media to post', 'share a photo', 'share a video',
        'media upload', 'file upload',
      ],
      content: 'On Shadow Nexus Social you can upload media as part of your posts — images, videos, and music. When creating a post on Eclipse Feed you can attach media. Uploads are stored and shown on your profile and in your followers\' feeds. Supported file types depend on the post type (image post, video post, music post). You must be logged in to upload.',
    },

    /* ══════════════════════════════════════════════════════════
       SETTINGS
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'settings', 'account settings', 'preferences', 'account',
        'how do i change my settings', 'where are settings', 'open settings',
        'account options', 'user settings',
      ],
      content: 'Settings on Shadow Nexus Social let you manage your account preferences, notification preferences, privacy options, and more. Access Settings from the navigation sidebar. From Settings you can change your account details, adjust privacy, control notifications, and manage connected features.',
    },

    /* ══════════════════════════════════════════════════════════
       PRIVACY
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'privacy', 'privacy settings', 'who can see', 'private',
        'hide my posts', 'block', 'mute', 'report user', 'harassment',
        'safety', 'safe', 'block someone', 'mute someone',
        'report content', 'report a user',
      ],
      content: 'Privacy and safety settings on Shadow Nexus Social control who can see your content and interact with you. You can block users, mute users, and report harmful content. Privacy settings are accessible from Settings. You can also report content or users that violate community guidelines using the report feature on any post or profile.',
    },

    /* ══════════════════════════════════════════════════════════
       COMMUNITY HUB
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'community', 'community hub', 'community guidelines', 'community rules',
        'rules', 'report', 'snx community', 'platform rules',
        'what are the rules', 'community page',
      ],
      content: 'The Community Hub on Shadow Nexus Social is where you can learn about the platform\'s community guidelines and values. Shadow Nexus Social has community rules to keep the platform safe and positive. You can access the Community Hub and Community Rules from the navigation sidebar. You can report content or users that violate the guidelines using the report feature.',
    },

    /* ══════════════════════════════════════════════════════════
       STORM ROOMS
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'storm rooms', 'storm room', 'what are storm rooms', 'live chat rooms',
        'how do storm rooms work', 'join a storm room', 'enter a storm room',
        'room code', 'chat room', 'live chat', 'group chat',
      ],
      content: 'Storm Rooms are live real-time chat rooms on Shadow Nexus Social. You join a Storm Room using a room code. Once inside you can chat, send reactions, and see who else is in the room. Storm Rooms use Firebase Realtime Database for live updates. Messages are live — they appear instantly for everyone in the room. Storm Rooms are accessible from the navigation sidebar.',
    },

    /* ══════════════════════════════════════════════════════════
       SUPPORT ROOMS
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'support rooms', 'support room', 'what are support rooms',
        'safe space', 'moderated chat', 'anonymous chat',
        'support chat', 'how do support rooms work', 'difference between storm and support',
      ],
      content: 'Support Rooms are calm, moderated safe spaces on Shadow Nexus Social — they are distinct from Storm Rooms. Support Rooms are designed for supportive, thoughtful conversation. They are anonymous and moderated. Messages in Support Rooms fade after 24 hours. You can access Support Rooms from the navigation sidebar. Support Rooms are for when you need a safe, quiet space to talk.',
    },

    /* ══════════════════════════════════════════════════════════
       ARCADE
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'arcade', 'games', 'play games', 'snx arcade', 'shadow nexus arcade',
        'what is the arcade', 'how do i play', 'game', 'leaderboard',
        'arcade games', 'invite to game', 'game invite',
      ],
      content: 'The Arcade on Shadow Nexus Social is a built-in retro game hub. You can play games directly on the platform, see leaderboards, and invite other users to play. Games are accessible from the navigation menu. Your scores are tracked and can appear on the leaderboard. The Arcade is available to logged-in users.',
    },

    /* ══════════════════════════════════════════════════════════
       PWA / INSTALL AS APP
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'pwa', 'install app', 'add to home screen', 'offline', 'progressive web app',
        'install shadow nexus', 'install as an app', 'install as app', 'add to homescreen',
        'install the website', 'install it as an app', 'install on my phone',
        'install on device', 'how do i install', 'download the app',
        'can i install', 'put it on my phone',
      ],
      content: 'Shadow Nexus Social is a Progressive Web App (PWA) — you can install it on your device from your browser for an app-like experience. On Android: open the site in Chrome, tap the browser menu (⋮), and select "Add to Home Screen" or look for the install prompt in the address bar. On iPhone/iOS: open in Safari, tap the Share button (□↑), then tap "Add to Home Screen". Once installed it appears as an app icon and can work offline for some features.',
    },

    /* ══════════════════════════════════════════════════════════
       PERFORMANCE MODE
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'performance mode', 'lite mode', 'balanced mode', 'full mode',
        'snx performance', 'slow loading', 'adaptive performance',
        'why is it slow', 'reduce data usage', 'optimize performance',
        'performance setting',
      ],
      content: 'Shadow Nexus Social has an adaptive performance system with three modes: LITE (minimal loading, best for slow connections), BALANCED (default — loads features on demand), and FULL (prefetches features for faster navigation). The mode is automatically selected but can be adjusted in settings. Performance mode affects how quickly features like Radio, Live, and TV load.',
    },

    /* ══════════════════════════════════════════════════════════
       ACCOUNT / LOGIN / AUTH
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'login', 'sign in', 'sign up', 'create account', 'register',
        'how do i log in', 'how do i create an account', 'account',
        'forgot password', 'password', 'auth', 'authentication',
        'guest mode', 'guest', 'can i use without account',
        'log out', 'sign out',
      ],
      content: 'Shadow Nexus Social requires an account for most features. You can sign up with email and password. Some browsing is available in Guest Mode with limited features. To log in, use the sign-in screen when you open the site. If you forget your password you can use the password reset flow. You must be logged in to post, message, follow, go live, use Radio Studio, or access personal features like Notifications and Inbox.',
    },

    /* ══════════════════════════════════════════════════════════
       NAVIGATION — HOW TO GET AROUND
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.SNS,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'how do i navigate', 'where is the menu', 'navigation', 'sidebar',
        'how to get to', 'where is', 'how do i find', 'how do i open',
        'nav bar', 'menu', 'how to access',
      ],
      content: 'Shadow Nexus Social has a navigation sidebar (on desktop) and a mobile menu (on mobile). The sidebar has icons for: Eclipse Feed, Search, Inbox, Notifications, Community Hub, Community Rules, Storm Rooms, Support Rooms, Live, 24-Hour TV, Radio, Settings, and role-specific panels for Moderators, Admins, and Founders. On mobile, tap the menu icon to open the navigation drawer.',
    },

    /* ══════════════════════════════════════════════════════════
       CREATOR / FOUNDER KNOWLEDGE (PUBLIC)
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.CREATOR,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'chris', 'legend of shadows', 'creator', 'who made this', 'who built this',
        'who is chris', 'who created', 'who made shadow nexus', 'who built shadow nexus',
        'who created shadow nexus', 'who is the creator', 'who founded', 'founder',
        'who is the founder', 'who runs this',
      ],
      content: 'Shadow Nexus Social was built by Chris, also known as Legend of Shadows. Chris is a creator focused on music, creative projects, and building independent platforms. Chris is the Founder of Shadow Nexus Social.',
    },
    {
      category: CATEGORY.CREATOR,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'legend of shadows', 'chris music', 'creator music', 'shadow nexus creator',
        'what does legend of shadows mean',
      ],
      content: 'Legend of Shadows is the creative identity of Chris — the builder of Shadow Nexus Social. The name reflects themes of survival, growth, and creative identity.',
    },
    {
      category: CATEGORY.CREATOR,
      _status: 'CURRENT_VERIFIED',
      keywords: ['stay legendary', 'legendary', 'motto', 'creator motto'],
      content: '"Stay legendary" is the motto associated with Chris / Legend of Shadows.',
    },
    {
      category: CATEGORY.CREATOR,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'shadow reaper', 'what is shadow reaper', 'ai assistant', 'who is shadow reaper',
        'what does shadow reaper do',
      ],
      content: 'Shadow Reaper is the AI assistant built into Shadow Nexus Social. It is a general conversational AI and platform guide. You can talk with Shadow Reaper about everyday topics, ideas, creative projects, brainstorming, and how to use Shadow Nexus Social. It is not just a help bot — it can hold a real conversation.',
    },

    /* ══════════════════════════════════════════════════════════
       GENERAL CAPABILITY
    ═══════════════════════════════════════════════════════════*/
    {
      category: CATEGORY.GENERAL,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'what can you do', 'help me', 'capabilities', 'what are you', 'what do you do',
        'what can i ask you', 'what can i say', 'what can i talk to you about',
        'what can i do', 'what can shadow reaper do', 'how can you help',
        'what can i use you for',
      ],
      content: 'SHADOW_REAPER_WHAT_CAN_I_DO',
      // Special marker: the response engine substitutes the full capability response for this token.
    },
    {
      category: CATEGORY.GENERAL,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'shadow reaper remember', 'remember for me', 'memory', 'what do you remember',
        'persistent memory', 'remember that', 'remember my',
      ],
      content: 'I can save things you explicitly tell me to remember — just say "remember that..." and I will store it for future sessions. You can also ask "what do you remember about me?" to see what I have stored.',
    },
    {
      category: CATEGORY.GENERAL,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'history', 'conversation history', 'previous conversation',
        'continue conversation', 'what were we talking about', 'continue last chat',
      ],
      content: 'I keep a history of our conversations so we can pick up where we left off. Ask "what were we talking about?" or "continue where we left off" to resume a previous conversation.',
    },
    {
      category: CATEGORY.GENERAL,
      _status: 'CURRENT_VERIFIED',
      keywords: [
        'translate', 'translation', 'language', 'speak spanish', 'speak french',
        'what language', 'translate hello', 'say something in',
      ],
      content: 'I have a translation layer built in. I can attempt translations and respond in different languages. Ask "translate X to Spanish" or "answer me in French."',
    },
  ];

  /* ─────────────────────────────────────────────────────────────
     WHAT CAN I DO — CAPABILITY REGISTRY
     Centralised so the response is generated from this registry
     and not hardcoded separately in the response engine.
  ───────────────────────────────────────────────────────────────*/
  var CAPABILITY_REGISTRY = {
    general: [
      'Everyday conversation — just talk to me',
      'Tell me how you\'re feeling',
      'Brainstorm ideas together',
      'Think through a project',
      'Creative thinking and problem solving',
      'Ask questions about anything',
      'Tell a joke or something interesting',
      'Set context I can remember ("remember that...")',
      'Continue a previous conversation',
      'Translate text into other languages',
    ],
    sns: [
      '"What is Shadow Nexus Social?" — get an overview',
      '"What is Eclipse Feed?" — learn about the main feed',
      '"How does Live work?" — streaming and cohost explained',
      '"How does Radio work?" — listener and DJ info',
      '"What is TV?" — 24-hour channel guide',
      '"Where are my messages?" — Inbox help',
      '"How do notifications work?"',
      '"How do I find someone?" — Search help',
      '"How do I upload something?"',
      '"How do I edit my profile?"',
      '"What are Storm Rooms / Support Rooms?"',
      '"What is the Arcade?"',
      '"Can I install this as an app?" — PWA install help',
      '"What can I do on this website?"',
    ],
  };

  /* ─────────────────────────────────────────────────────────────
     RELEVANCE SCORING
     Score a query against a knowledge entry by keyword matching.
     Returns 0 if not relevant.
  ───────────────────────────────────────────────────────────────*/
  function _score(query, entry) {
    var q = query.toLowerCase();
    var score = 0;
    for (var i = 0; i < entry.keywords.length; i++) {
      var kw = entry.keywords[i].toLowerCase();
      if (q.indexOf(kw) !== -1) {
        // Longer keyword match = higher weight
        score += kw.length;
      }
    }
    return score;
  }

  /* ─────────────────────────────────────────────────────────────
     QUERY
     Returns the single most relevant knowledge entry for a query,
     or null if nothing is relevant (score = 0).

     DOES NOT inject SNS knowledge into unrelated conversations.
  ───────────────────────────────────────────────────────────────*/
  function query(text) {
    if (!text || typeof text !== 'string') return null;

    var best = null;
    var bestScore = 0;

    for (var i = 0; i < KNOWLEDGE_BASE.length; i++) {
      var s = _score(text, KNOWLEDGE_BASE[i]);
      if (s > bestScore) {
        bestScore = s;
        best = KNOWLEDGE_BASE[i];
      }
    }

    // Only return if score is meaningful (≥ 3 = at least a 3-char keyword match)
    if (bestScore < 3) return null;
    return best;
  }

  /* ─────────────────────────────────────────────────────────────
     QUERY MULTIPLE
     Returns up to maxResults relevant entries, sorted by score.
  ───────────────────────────────────────────────────────────────*/
  function queryMultiple(text, maxResults) {
    maxResults = maxResults || 3;
    if (!text || typeof text !== 'string') return [];

    var scored = [];
    for (var i = 0; i < KNOWLEDGE_BASE.length; i++) {
      var s = _score(text, KNOWLEDGE_BASE[i]);
      if (s >= 3) {
        scored.push({ entry: KNOWLEDGE_BASE[i], score: s });
      }
    }

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, maxResults).map(function (x) { return x.entry; });
  }

  /* ─────────────────────────────────────────────────────────────
     IS RELEVANT
     Returns true if the query matches any knowledge entry.
     Useful for routing decisions before retrieval.
  ───────────────────────────────────────────────────────────────*/
  function isRelevant(text) {
    if (!text) return false;
    for (var i = 0; i < KNOWLEDGE_BASE.length; i++) {
      if (_score(text, KNOWLEDGE_BASE[i]) >= 3) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     GET BY CATEGORY
  ───────────────────────────────────────────────────────────────*/
  function getByCategory(category) {
    return KNOWLEDGE_BASE.filter(function (e) { return e.category === category; });
  }

  /* ─────────────────────────────────────────────────────────────
     BUILD CAPABILITY RESPONSE
     Generates a natural "What Can I Do?" response from the
     centralized capability registry.
     Never advertises unsupported abilities.
  ───────────────────────────────────────────────────────────────*/
  function buildCapabilityResponse() {
    var general = CAPABILITY_REGISTRY.general;
    var sns     = CAPABILITY_REGISTRY.sns;

    var lines = [];
    lines.push("Here's what you can do with me:\n");
    lines.push("CONVERSATION & IDEAS");
    for (var i = 0; i < general.length; i++) {
      lines.push('• ' + general[i]);
    }
    lines.push('\nSHADOW NEXUS SOCIAL HELP');
    for (var j = 0; j < sns.length; j++) {
      lines.push('• ' + sns[j]);
    }
    lines.push('\nJust say whatever is on your mind. I\'m here.');
    return lines.join('\n');
  }

  /* ─────────────────────────────────────────────────────────────
     CAPABILITY REGISTRY — public access
  ───────────────────────────────────────────────────────────────*/
  function getCapabilityRegistry() {
    return {
      general: CAPABILITY_REGISTRY.general.slice(),
      sns:     CAPABILITY_REGISTRY.sns.slice(),
    };
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.SRKnowledge
  ───────────────────────────────────────────────────────────────*/
  global.SRKnowledge = {
    build:                  BUILD_ID,
    CATEGORY:               CATEGORY,
    query:                  query,
    queryMultiple:          queryMultiple,
    isRelevant:             isRelevant,
    getByCategory:          getByCategory,
    buildCapabilityResponse: buildCapabilityResponse,
    getCapabilityRegistry:  getCapabilityRegistry,
  };

})(typeof window !== 'undefined' ? window : global);
