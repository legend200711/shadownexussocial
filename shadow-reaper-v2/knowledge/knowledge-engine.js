/**
 * shadow-reaper-v2/knowledge/knowledge-engine.js
 * Shadow Reaper V2 — Knowledge Engine
 *
 * Build: SR-V2-KNOWLEDGE-1
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
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-V2-KNOWLEDGE-1';

  /* ─────────────────────────────────────────────────────────────
     KNOWLEDGE CATEGORIES
  ───────────────────────────────────────────────────────────────*/
  var CATEGORY = {
    SNS:       'SNS',        // Shadow Nexus Social platform
    CREATOR:   'CREATOR',    // Public creator information
    GENERAL:   'GENERAL',    // General capability info
  };

  /* ─────────────────────────────────────────────────────────────
     KNOWLEDGE BASE
     Each entry: { category, keywords: [], content }
     keywords drive relevance detection — no full-text scan needed.
  ───────────────────────────────────────────────────────────────*/
  var KNOWLEDGE_BASE = [

    /* ── SHADOW NEXUS SOCIAL — PLATFORM ──────────────────────── */
    {
      category: CATEGORY.SNS,
      keywords: ['shadow nexus social', 'sns', 'what is shadow nexus', 'platform overview', 'about shadow nexus', 'shadow nexus'],
      content: 'Shadow Nexus Social is a creative social platform built by Chris (Legend of Shadows). It features Radio, DJ streaming, Live video, TV channels, Feed, Profiles, Friends, Inbox, Notifications, Search, and PWA support.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['radio', 'listen', 'music stream', 'radio station', 'radio player', 'shadow nexus radio'],
      content: 'Radio on Shadow Nexus Social lets you listen to live music streams. You can tune in, see track info, send requests, and see who else is listening.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['radio studio', 'dj', 'dj mode', 'broadcast', 'stream music', 'go live radio', 'difference between radio'],
      content: 'The Radio Studio allows DJs and Founders to broadcast live audio streams. DJ mode provides mixing controls. You can start a broadcast, manage tracks, and control the stream from the Studio. Radio Studio is for broadcasting; Radio is for listening.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['shadow nexus live', 'live video', 'go live', 'live stream', 'live broadcast', 'video call', 'cohost', 'live feature', 'live system', 'what is live', 'live'],
      content: 'Live on Shadow Nexus Social lets creators broadcast live video. You can go live from your account, invite a cohost to join your stream, and viewers can watch and interact in real time.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['tv studio', 'tv channel', 'shadow tv', 'television studio', '24 hour', 'television', 'shadow nexus tv', 'what is tv studio', 'tv used for', 'run a channel'],
      content: 'Shadow Nexus Social TV allows you to watch and host 24-hour TV channels. Creators can run their own channels. Viewers can tune into different channels in the TV section. TV Studio is where creators manage and broadcast their TV channel.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['feed', 'timeline', 'posts', 'home feed', 'news feed'],
      content: 'The Feed on Shadow Nexus Social shows posts from people you follow. You can post updates, share content, and interact with your community.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['profile', 'my profile', 'user profile', 'edit profile', 'profile page'],
      content: 'Your profile on Shadow Nexus Social shows your posts, media, and public information. You can edit your profile, set a profile picture, and customize your page.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['friends', 'follow', 'followers', 'following', 'friend request', 'connect'],
      content: 'Shadow Nexus Social uses a follow system. You can follow other users, see who follows you, and manage your connections.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['inbox', 'messages', 'dm', 'direct message', 'messaging', 'chat'],
      content: 'The Inbox on Shadow Nexus Social allows you to send and receive private messages.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['notifications', 'alerts', 'activity'],
      content: 'Notifications on Shadow Nexus Social keep you updated on activity related to your account — new followers, mentions, replies, and more.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['search', 'find', 'discover users', 'search people'],
      content: 'Search on Shadow Nexus Social lets you find users, content, and channels.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['uploads', 'upload', 'post media', 'share files', 'upload music'],
      content: 'You can upload media to Shadow Nexus Social including music, videos, and images.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['settings', 'account settings', 'preferences', 'account'],
      content: 'Settings on Shadow Nexus Social let you manage your account, privacy, and preferences.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['privacy', 'privacy settings', 'who can see', 'private'],
      content: 'Privacy settings on Shadow Nexus Social control who can see your content and interact with you.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['community', 'community guidelines', 'rules', 'report'],
      content: 'Shadow Nexus Social has community guidelines to keep the platform safe and positive. You can report content or users that violate the guidelines.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['safety', 'block', 'mute', 'report user', 'harassment'],
      content: 'Shadow Nexus Social provides safety tools including the ability to block and mute users, and report harmful content.',
    },
    {
      category: CATEGORY.SNS,
      keywords: ['pwa', 'install app', 'add to home screen', 'offline', 'progressive web app',
                 'install shadow nexus', 'install as an app', 'install as app', 'add to homescreen',
                 'install the website', 'install it as an app', 'install on my phone',
                 'install on device', 'how do i install', 'download the app'],
      content: 'Shadow Nexus Social is a Progressive Web App (PWA). You can install it on your device from your browser — add it to your home screen for an app-like experience on Android and iPhone. On Android: tap the browser menu and select "Add to Home Screen". On iPhone: tap Share then "Add to Home Screen".',
    },

    /* ── CREATOR — PUBLIC INFORMATION ────────────────────────── */
    {
      category: CATEGORY.CREATOR,
      keywords: ['chris', 'legend of shadows', 'creator', 'who made this', 'who built this', 'who is chris',
                 'who created', 'who made shadow nexus', 'who built shadow nexus', 'who created shadow nexus',
                 'who is the creator', 'who founded', 'founder'],
      content: 'Shadow Nexus Social was built by Chris, also known as Legend of Shadows. Chris is a creator focused on music, creative projects, and building independent platforms.',
    },
    {
      category: CATEGORY.CREATOR,
      keywords: ['legend of shadows', 'chris music', 'creator music', 'shadow nexus creator'],
      content: 'Legend of Shadows is the creative identity of Chris — the builder of Shadow Nexus Social. The name reflects themes of survival, growth, and creative identity in the dark.',
    },
    {
      category: CATEGORY.CREATOR,
      keywords: ['stay legendary', 'legendary', 'motto', 'creator motto'],
      content: '"Stay legendary" is the motto associated with Chris / Legend of Shadows.',
    },
    {
      category: CATEGORY.CREATOR,
      keywords: ['shadow reaper', 'what is shadow reaper', 'ai assistant'],
      content: 'Shadow Reaper is the AI assistant built into Shadow Nexus Social. It is designed to be a general conversational assistant, a creative thinking partner, and a platform guide.',
    },

    /* ── GENERAL CAPABILITY ───────────────────────────────────── */
    {
      category: CATEGORY.GENERAL,
      keywords: ['what can you do', 'help me', 'capabilities', 'what are you', 'what do you do'],
      content: 'I can help you with conversation, creative brainstorming, organizing ideas, answering questions, recalling things you have told me, and navigating Shadow Nexus Social. I am Shadow Reaper — a general AI assistant.',
    },
    {
      category: CATEGORY.GENERAL,
      keywords: ['shadow reaper remember', 'remember for me', 'memory', 'what do you remember', 'persistent memory'],
      content: 'I can save things you explicitly tell me to remember — just say "remember that..." and I will store it for future sessions. You can also ask "what do you remember about me?"',
    },
    {
      category: CATEGORY.GENERAL,
      keywords: ['history', 'conversation history', 'previous conversation', 'continue conversation'],
      content: 'I keep a history of our conversations so we can pick up where we left off. Ask "what were we talking about?" or "continue where we left off."',
    },
    {
      category: CATEGORY.GENERAL,
      keywords: ['translate', 'translation', 'language', 'speak spanish', 'speak french', 'what language'],
      content: 'I have a translation layer built in. I can attempt translations and respond in different languages. Ask "translate X to Spanish" or "answer me in French."',
    },
  ];

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
     EXPOSE — window.SRKnowledge
  ───────────────────────────────────────────────────────────────*/
  global.SRKnowledge = {
    build:          BUILD_ID,
    CATEGORY:       CATEGORY,
    query:          query,
    queryMultiple:  queryMultiple,
    isRelevant:     isRelevant,
    getByCategory:  getByCategory,
  };

})(typeof window !== 'undefined' ? window : global);
