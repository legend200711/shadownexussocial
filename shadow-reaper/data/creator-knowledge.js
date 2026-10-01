/**
 * shadow-reaper/data/creator-knowledge.js
 * Shadow Reaper AI — Creator Knowledge Wrapper
 *
 * Build: SR-2026-UNIFIED-STAGE1-001
 *
 * Creator Knowledge entries (Chris / Legend of Shadows / Shadow Nexus origin).
 * These records are extracted from SNXShadowKnowledge (CREATOR_* categories)
 * and surfaced through the unified API.
 *
 * PRIVACY RULES (enforced here):
 *   - No personal address, phone, email, passwords, tokens, API keys.
 *   - No private family details (names of family members).
 *   - No financial/location data.
 *   - No speculative/unknown personal details.
 *
 * If SNXShadowKnowledge is loaded, this module delegates for CREATOR_* queries.
 * If not, it provides its own minimal creator knowledge set.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-2026-UNIFIED-STAGE1-CREATOR-001';

  /* ─────────────────────────────────────────────────────────────
     PRIVACY GUARD — block queries seeking private info
  ───────────────────────────────────────────────────────────────*/
  var _PRIVATE_PATTERNS = [
    /\b(address|phone|email|password|token|api key|private key|bank|credit card|social security|ssn|exact location|home address|personal number)\b/i,
    /\b(sister'?s? name|family member name|kids?'? name|child'?s? name|partner'?s? name|girlfriend'?s? name|wife'?s? name)\b/i,
    /\b(bypass founder|make me founder|firebase credentials|cloudflare token|admin (key|password|access))\b/i,
    /\b(show me another user|delete another user|access another user)\b/i
  ];

  function _isPrivateQuery(text) {
    for (var i = 0; i < _PRIVATE_PATTERNS.length; i++) {
      if (_PRIVATE_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  var PRIVACY_RESPONSE = "That's private information and I won't share it. I can tell you about Chris's public story, his music, his values, and why he built Shadow Nexus Social.";

  /* ─────────────────────────────────────────────────────────────
     CREATOR KNOWLEDGE — Condensed records
     (Full records exist in snx-shadow-ai-knowledge.js)
  ───────────────────────────────────────────────────────────────*/
  var _CREATOR_RECORDS = {

    creatorIdentity: {
      id: 'creatorIdentity',
      title: 'Who is the Creator of Shadow Nexus Social?',
      summary: 'Shadow Nexus Social was built by Chris, also known as Legend of Shadows. He is the founder, designer, and sole developer of the platform.',
      phrases: ['who made shadow nexus', 'who built this', 'who is the founder', 'who is legend of shadows',
                'who is the creator', 'who created shadow nexus', 'who owns shadow nexus',
                'who is behind shadow nexus', 'who made this', 'the creator of shadow nexus',
                'who is chris', 'creator of shadow nexus']
    },

    creatorBio: {
      id: 'creatorBio',
      title: 'About Chris (Legend of Shadows)',
      summary: 'Chris, known as Legend of Shadows, is the creator of Shadow Nexus Social. He is a passionate musician, platform builder, and mental health advocate who built SNS from the ground up — channeling personal struggles, music, and a deep commitment to community into every part of the platform.',
      phrases: ['tell me about chris', 'tell me about the creator', 'who is chris']
    },

    creatorStory: {
      id: 'creatorStory',
      title: "Chris's Story",
      summary: "Chris's story is one of resilience. He faced real hardship — personal losses, mental health battles, and periods of isolation — and chose to channel all of it into creation. Rather than giving up, he built Shadow Nexus Social as a space where others who feel alone could connect, be heard, and belong.",
      phrases: ["chris's story", 'creator story', 'what has chris been through', 'tell me his story']
    },

    creatorOrigin: {
      id: 'creatorOrigin',
      title: 'Why Chris Built Shadow Nexus Social',
      summary: "Chris built Shadow Nexus Social because he needed a space that didn't exist — a place where creativity, community, and emotional honesty could coexist. Mainstream platforms felt shallow. He wanted something real: a place built with care, where people like him could belong.",
      phrases: ['why did he build this', 'what inspired shadow nexus', 'why did chris create']
    },

    creatorMusic: {
      id: 'creatorMusic',
      title: "Chris's Music (Legend of Shadows)",
      summary: "Chris makes music as Legend of Shadows. His style blends rap, rock, melodic vocals, and alternative metal — raw emotion over heavy and melodic production. His music deals with pain, resilience, mental health, purpose, loyalty, and finding light in darkness.",
      phrases: ['what music does chris make', 'legend of shadows music', 'what kind of music']
    },

    creatorMusicThemes: {
      id: 'creatorMusicThemes',
      title: "Themes in Chris's Music",
      summary: "The recurring themes across Legend of Shadows music: overcoming pain, mental health struggles, loyalty, never giving up, finding purpose, the complexity of family, isolation and connection, identity, and turning darkness into strength.",
      phrases: ['themes in his music', 'what does his music talk about', 'music themes']
    },

    creatorMusicStyle: {
      id: 'creatorMusicStyle',
      title: "Chris's Music Style",
      summary: "Legend of Shadows is melodic rap rock — combining rap verses with sung choruses, layered over alternative rock or metal production. His delivery shifts between aggressive rap and vulnerable melodic singing, often in the same song.",
      phrases: ['what style of music', 'rap rock', 'music style']
    },

    creatorMentalHealth: {
      id: 'creatorMentalHealth',
      title: "Chris and Mental Health Advocacy",
      summary: "Chris advocates strongly for mental health awareness, particularly for men. He has lived through periods of depression, isolation, and hopelessness — and speaks openly about it in his music and platform. He built Shadow Nexus Social partly as a space where people can talk without judgment and feel less alone.",
      phrases: ['why does he talk about mental health', 'chris mental health', 'why mental health matters to him']
    },

    creatorFamily: {
      id: 'creatorFamily',
      title: "Chris and Family",
      summary: "Family is central to Chris's values and story. His sister holds a deeply important place in his life — she represents the kind of loyalty, love, and presence that he builds his platform around. He speaks about chosen family too: the idea that community can be family.",
      phrases: ["why is his sister important", "chris and family", "family means everything"]
    },

    creatorValues: {
      id: 'creatorValues',
      title: "Chris's Core Values",
      summary: "Loyalty. Creativity. Resilience. Community. Authenticity. Never giving up. These aren't marketing words for Chris — they're lived experiences that shaped Shadow Nexus Social. The platform was built to reflect these values.",
      phrases: ['what does chris believe in', 'his values', 'what drives him']
    },

    creatorStayLegendary: {
      id: 'creatorStayLegendary',
      title: 'Stay Legendary',
      summary: "'Stay Legendary' is Chris's personal motto and the defining phrase of Legend of Shadows. It means: live with purpose, face darkness without breaking, give back, and leave something behind that matters. It's a reminder to never let life's weight extinguish who you are.",
      phrases: ['stay legendary', 'what does stay legendary mean', 'legend motto']
    },

    creatorSymbols: {
      id: 'creatorSymbols',
      title: "Chris's Symbols",
      summary: "Chris draws on specific symbols throughout his work: The Grim Reaper (facing mortality, transformation, the journey through darkness), Wolves (loyalty, strength, unity, protecting the pack), Black Cats (independence, mystery, walking your own path), Crows (intelligence, death and rebirth, carrying messages), Blue Lightning (energy, breakthrough, raw power), Blue Flames (transformation, intensity, the fire that changes you).",
      phrases: ['why the grim reaper', 'why wolves', 'why blue lightning', 'why crows', 'creator symbols']
    },

    creatorGrimReaper: {
      id: 'creatorGrimReaper',
      title: 'Why the Grim Reaper?',
      summary: "The Grim Reaper isn't about death for Chris — it's about transformation. Walking through the worst of life and coming out changed. It's the guide through darkness, not the destroyer. For Shadow Nexus Social, Shadow Reaper (the AI) represents this: a presence that guides you, not one that frightens.",
      phrases: ['why the grim reaper', 'grim reaper symbol', 'grim reaper meaning']
    },

    creatorNeverGiveUp: {
      id: 'creatorNeverGiveUp',
      title: 'Never Giving Up',
      summary: "Chris speaks often about never giving up — not as a cliché but as something he's lived. There were moments he could have stopped building, stopped creating, stopped entirely. He didn't. That refusal to quit is baked into Shadow Nexus Social's identity.",
      phrases: ['never give up', 'never giving up', 'kept going']
    },

    creatorHelpingOthers: {
      id: 'creatorHelpingOthers',
      title: 'Helping Others Feel Less Alone',
      summary: "One of Chris's core reasons for building Shadow Nexus Social was to help people who feel invisible and alone. He knows what that feels like. The platform's community features — Storm Rooms, Support Rooms, the Feed — are designed with this in mind.",
      phrases: ['helping others', 'feel less alone', 'helping people']
    },

    creatorTurningPain: {
      id: 'creatorTurningPain',
      title: 'Turning Pain into Creativity',
      summary: "Chris describes his approach to hardship as 'turning pain into power.' Rather than being destroyed by what he's been through, he channels it into music, into building, into creating a platform that carries meaning. This is the heart of Legend of Shadows as an identity.",
      phrases: ['turning pain into creativity', 'pain into power', 'how he channels pain']
    },

    creatorLoyalty: {
      id: 'creatorLoyalty',
      title: 'Loyalty and Chosen Family',
      summary: "For Chris, loyalty is sacred. He believes in showing up for the people who show up for you — and in the idea of chosen family: that the people who stand by you through darkness are your real family, blood or not. This value is woven into everything about Shadow Nexus Social.",
      phrases: ['loyalty', 'chosen family', 'showing up for people']
    },

    creatorPrivacy: {
      id: 'creatorPrivacy',
      title: "Creator Private Information",
      summary: "That information is private and I won't share it. I can tell you about Chris's public story, values, music, and why he built Shadow Nexus Social.",
      phrases: ['address', 'password', 'api key', 'token', 'private message', 'sister name', 'personal info']
    }
  };

  /* ─────────────────────────────────────────────────────────────
     query(text) → { text, handled } | null
     Public entry point for creator knowledge queries.
  ───────────────────────────────────────────────────────────────*/
  function query(text) {
    if (!text) return null;

    // Privacy guard first
    if (_isPrivateQuery(text)) {
      return { text: PRIVACY_RESPONSE, handled: true };
    }

    // Delegate to SNXShadowKnowledge for full scoring if available
    var delegate = global.SNXShadowKnowledge;
    if (delegate && typeof delegate.answerLocally === 'function') {
      var result = delegate.answerLocally(text, { category: 'CREATOR' });
      if (result && result.text && result.handled) return result;
    }

    // Local matching
    var lower = text.toLowerCase();
    var records = Object.values ? Object.values(_CREATOR_RECORDS) : _objectValues(_CREATOR_RECORDS);
    var best = null;
    var bestScore = 0;

    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      var score = 0;
      var phrases = record.phrases || [];
      for (var j = 0; j < phrases.length; j++) {
        if (lower.indexOf(phrases[j]) !== -1) {
          score += phrases[j].split(' ').length * 3;
        }
      }
      if (score > bestScore) { bestScore = score; best = record; }
    }

    if (best && bestScore >= 3) {
      return { text: best.summary, handled: true, id: best.id, title: best.title };
    }

    return null;
  }

  function _objectValues(obj) {
    return Object.keys(obj).map(function (k) { return obj[k]; });
  }

  /* ─────────────────────────────────────────────────────────────
     getRecord(id) → record | null
  ───────────────────────────────────────────────────────────────*/
  function getRecord(id) {
    return _CREATOR_RECORDS[id] || null;
  }

  /* ─────────────────────────────────────────────────────────────
     isPrivateQuery(text) → boolean
  ───────────────────────────────────────────────────────────────*/
  function isPrivateQuery(text) {
    return _isPrivateQuery(text);
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE
  ───────────────────────────────────────────────────────────────*/
  global.SRCreatorKnowledge = {
    query:          query,
    getRecord:      getRecord,
    isPrivateQuery: isPrivateQuery,
    PRIVACY_RESPONSE: PRIVACY_RESPONSE,
    build:          BUILD_ID
  };

}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : {})));
