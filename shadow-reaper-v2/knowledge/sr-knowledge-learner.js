/**
 * shadow-reaper-v2/knowledge/sr-knowledge-learner.js
 * Shadow Reaper V2 — Knowledge Learning Layer
 *
 * Build: SR-V2-LEARN-1
 *
 * Exposes: window.SRKnowledgeLearner
 *
 * PURPOSE:
 *   Model-independent, continuous knowledge learning from natural conversation.
 *   Every meaningful turn is processed through the pipeline:
 *
 *   USER MESSAGE
 *   → understand topic
 *   → check conversation context
 *   → search existing knowledge
 *   → search relevant learned knowledge
 *   → determine what is known
 *   → generate response guidance
 *   → analyze new user-provided information
 *   → extract useful knowledge
 *   → classify it (personal/project/general-claim)
 *   → check for duplicates/conflicts
 *   → assign confidence/provenance
 *   → store appropriate learning
 *   → connect related concepts
 *
 * ARCHITECTURE:
 *   • Wraps SRAdaptiveBrain — does NOT create a duplicate learning store.
 *   • Uses the same Firestore collection via SRAdaptiveBrain.
 *   • Adds: general concept extraction, definition learning, claim classification,
 *     semantic recall, knowledge-aware response generation, correction handling.
 *
 * CLAIM CLASSIFICATION:
 *   PERSONAL  — "My X is Y", "I prefer Y", "My project/game uses Y"
 *   PROJECT   — "In my game, X does Y", "My app's X is Y"
 *   GENERAL   — "X is Y" without clear personal ownership
 *   Stored with provenance tag — never auto-promoted to verified facts.
 *
 * PRIVACY RULES (SNS):
 *   • UID-scoped — User A's knowledge never leaks to User B.
 *   • No cross-user global learning database.
 *   • Temporary emotions are NOT permanently profiled.
 *   • Secrets/credentials are rejected.
 *   • Emotional signals used only for CURRENT response, not stored as labels.
 *
 * MODEL INDEPENDENCE:
 *   Zero external AI calls. Pure deterministic extraction + heuristics.
 *   Generic interfaces: learn(), retrieve(), relate(), correct(), reinforce(),
 *   forget(), findRelated(), queryForResponse()
 *
 * ZERO POLLING. ZERO RAF. ZERO setInterval.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-V2-LEARN-1';

  /* ─────────────────────────────────────────────────────────────
     CLAIM TYPES
  ───────────────────────────────────────────────────────────────*/
  var CLAIM_TYPE = {
    PERSONAL:         'PERSONAL',         // "my X is Y"
    PROJECT:          'PROJECT',          // "my project/game X does Y"
    GENERAL_CLAIM:    'GENERAL_CLAIM',    // "X is Y" (unverified general)
    DEFINITION:       'DEFINITION',       // "X is defined as Y"
    RELATIONSHIP:     'RELATIONSHIP',     // "X belongs to Y", "X is part of Y"
    FICTIONAL:        'FICTIONAL',        // "In my game/story, X is Y"
    CORRECTION:       'CORRECTION',       // "Actually X is Y" (overrides prior)
    TERMINOLOGY:      'TERMINOLOGY',      // "X means Y" in some context
  };

  /* ─────────────────────────────────────────────────────────────
     SENSITIVE DATA — reject these from learned knowledge
  ───────────────────────────────────────────────────────────────*/
  var _SENSITIVE_PATTERNS = [
    /\b(password|passwd)\s*(is|=|:)/i,
    /\bapi[\s_-]?key\s*(is|=|:)/i,
    /\btoken\s*(is|=|:)/i,
    /\bsecret\s*(is|=|:)\s*\S+/i,
    /\bcredit\s*card/i,
    /\b(private key|ssh key|rsa key)\s*(is|=|:)/i,
    /\bmy password is\b/i,
    /\bmy (api key|token|secret) is\b/i,
    /\b(suicid|kill myself|end my life|self.harm)\b/i,
  ];

  function _isSensitive(text) {
    if (!text) return false;
    for (var i = 0; i < _SENSITIVE_PATTERNS.length; i++) {
      if (_SENSITIVE_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  /* ─────────────────────────────────────────────────────────────
     FILLER DETECTION — skip ephemeral/meaningless input
  ───────────────────────────────────────────────────────────────*/
  var _FILLER_RE = /^(hello|hi|hey|yo|bye|thanks|thank you|okay|ok|lol|lmao|haha|yep|nope|sure|great|cool|nice|yes|no|please|sorry|hmm|um|uh|wait|oh|wow|oops)$/i;

  function _isFiller(text) {
    return _FILLER_RE.test((text || '').trim());
  }

  /* ─────────────────────────────────────────────────────────────
     CONCEPT NORMALIZATION
  ───────────────────────────────────────────────────────────────*/
  function _normalize(str) {
    return (str || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/['"]/g, '');
  }

  function _conceptKey(str) {
    return _normalize(str).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 60);
  }

  /* ─────────────────────────────────────────────────────────────
     EXTRACTION ENGINE
     Extracts knowledge concepts from natural conversation.
     Returns array of KnowledgeItem objects:
     {
       concept:      string  — normalized concept key
       label:        string  — display label
       claimType:    CLAIM_TYPE.*
       value:        string  — what was learned
       provenance:   string  — "user stated" / "user believes"
       relationships: [{from, relation, to}]
     }
  ───────────────────────────────────────────────────────────────*/

  /**
   * General concept definition:
   *   "A Zorvian Core is the power system in my game"
   *   "X is Y" / "X is a Y" / "X is the Y"
   *   "X means Y"
   *   "X refers to Y"
   */
  // Words that cannot be the subject of a definition — question words, pronouns, auxiliaries
  var _NON_SUBJECT = new Set([
    'what','which','who','where','when','why','how',
    'is','are','was','were','will','would','could','should','can','do','does','did',
    'the','a','an','it','this','that','they','we','i','you','he','she',
    'tell','show','explain','describe','give','list',
  ]);

  function _extractDefinitions(text) {
    var results = [];

    // GUARD: Do not extract definitions from questions.
    // A question asks for information — it does not assert a definition.
    // Questions typically start with "What", "How", "Who", "Which", or end with "?".
    var isQuestion = /^(what|how|who|which|where|when|why|tell|show|explain|can|could|would|is|are|do|does)\b/i.test(text.trim()) ||
                     /\?$/.test(text.trim());
    if (isQuestion) return results;

    // Pattern: "A/The/An X is [a/the/an] Y"  — subject with article
    var m1 = text.match(/^[Aa]n?\s+([A-Za-z][A-Za-z0-9 _\-]{1,40})\s+is\s+(?:a\s+|an\s+|the\s+)?(.{5,120}?)(?:[.,!?]|$)/);
    if (m1) {
      var subj1 = m1[1].trim();
      var pred1 = m1[2].trim().replace(/[.,!?]$/, '');
      if (!_isFiller(subj1) && !_isSensitive(pred1) && pred1.length >= 5 && !_NON_SUBJECT.has(subj1.toLowerCase())) {
        results.push({
          concept:      _conceptKey(subj1),
          label:        subj1,
          claimType:    _classifyClaim(text, subj1, pred1),
          value:        '"' + subj1 + '" is ' + pred1,
          provenance:   'user stated',
          relationships: [{ from: _conceptKey(subj1), relation: 'is_a', to: _conceptKey(pred1.split(' ').slice(0, 4).join(' ')) }],
        });
      }
    }

    // Pattern: "[CapWords] is [a/an/the] Y" — named concept starting with cap
    var m2 = text.match(/^([A-Z][A-Za-z0-9][A-Za-z0-9 _\-]{0,38}?)\s+is\s+(?:a\s+|an\s+|the\s+)?(.{5,120}?)(?:[.,!?]|$)/);
    if (m2 && !m1) {
      var subj2 = m2[1].trim();
      var pred2 = m2[2].trim().replace(/[.,!?]$/, '');
      // Reject single common words (question/filler words) as subjects
      if (!_isFiller(subj2) && !_isSensitive(pred2) && pred2.length >= 5 && subj2.length >= 2 &&
          !_NON_SUBJECT.has(subj2.toLowerCase())) {
        results.push({
          concept:      _conceptKey(subj2),
          label:        subj2,
          claimType:    _classifyClaim(text, subj2, pred2),
          value:        '"' + subj2 + '" is ' + pred2,
          provenance:   'user stated',
          relationships: [{ from: _conceptKey(subj2), relation: 'defined_as', to: _conceptKey(pred2.split(' ').slice(0, 5).join(' ')) }],
        });
      }
    }

    // Pattern: "X means Y" / "X refers to Y" / "X stands for Y"
    var m3 = text.match(/([A-Za-z][A-Za-z0-9 _\-]{1,40})\s+(?:means|refers\s+to|stands\s+for|is\s+defined\s+as)\s+(.{4,100}?)(?:[.,!?]|$)/i);
    if (m3) {
      var subj3 = m3[1].trim();
      var pred3 = m3[2].trim().replace(/[.,!?]$/, '');
      if (!_isFiller(subj3) && !_isSensitive(pred3) && pred3.length >= 4) {
        results.push({
          concept:      _conceptKey(subj3),
          label:        subj3,
          claimType:    CLAIM_TYPE.TERMINOLOGY,
          value:        '"' + subj3 + '" means: ' + pred3,
          provenance:   'user stated',
          relationships: [{ from: _conceptKey(subj3), relation: 'means', to: _conceptKey(pred3.split(' ').slice(0, 4).join(' ')) }],
        });
      }
    }

    return results;
  }

  /**
   * Personal claims:
   *   "My name is X", "I'm called X", "I like X", "I'm working on X"
   *   "My X is Y" where X is attribute of the person
   */
  function _extractPersonalClaims(text) {
    var results = [];

    // "My [attribute] is/are/was [value]"
    var m1 = text.match(/\b[Mm]y\s+((?:favorite|fav|favourite|project|app|game|site|website|tool|system|hobby|interest|goal|name|username|handle|style|color scheme)\b[a-z0-9 ]{0,30}?)\s+(?:is|are|was|will\s+be|'?s)\s+(.{3,100}?)(?:[.,!?]|$)/i);
    if (m1) {
      var attr = m1[1].trim().toLowerCase();
      var val  = m1[2].trim().replace(/[.,!?]$/, '');
      if (!_isFiller(val) && !_isSensitive(val) && val.length >= 2) {
        results.push({
          concept:      _conceptKey('user_' + attr),
          label:        'My ' + attr,
          claimType:    CLAIM_TYPE.PERSONAL,
          value:        'User\'s ' + attr + ': ' + val,
          provenance:   'user personal claim',
          relationships: [{ from: 'user', relation: attr.replace(/\s+/g, '_'), to: _conceptKey(val) }],
        });
      }
    }

    // "I'm building/creating/making/designing [thing]"
    var m2 = text.match(/\bI.?m\s+(building|creating|making|designing|developing|working\s+on)\s+(?:a\s+|an\s+|the\s+|my\s+)?(.{3,60}?)(?:[.,!?]|\s+and\s|$)/i);
    if (m2) {
      var thing2 = m2[2].trim().replace(/[.,!?]$/, '');
      if (!_isFiller(thing2) && !_isSensitive(thing2) && thing2.length >= 3) {
        results.push({
          concept:      _conceptKey('user_project_' + thing2.split(' ')[0]),
          label:        thing2,
          claimType:    CLAIM_TYPE.PERSONAL,
          value:        'User is building: ' + thing2,
          provenance:   'user personal claim',
          relationships: [{ from: 'user', relation: 'is_building', to: _conceptKey(thing2) }],
        });
      }
    }

    return results;
  }

  /**
   * Project/fictional world claims:
   *   "In my game, X does Y"
   *   "My project X uses Y"
   *   "[ProjectName]'s X is Y"
   *   "The X in my game is Y"
   */
  function _extractProjectClaims(text, contextProjectName) {
    var results = [];

    // "In my [game/story/world/project/app], X is/does Y"
    var m1 = text.match(/\bIn\s+my\s+(?:game|story|world|project|app|website|novel|book|film|universe|setting)\b[,]?\s+(.{2,50}?)\s+(?:is|does|are|can|will|has|powers|controls|drives|represents|serves\s+as)\s+(.{3,100}?)(?:[.,!?]|$)/i);
    if (m1) {
      var subj1 = m1[1].trim();
      var pred1 = m1[2].trim().replace(/[.,!?]$/, '');
      if (!_isFiller(subj1) && !_isSensitive(pred1) && pred1.length >= 3) {
        results.push({
          concept:      _conceptKey(subj1),
          label:        subj1,
          claimType:    CLAIM_TYPE.FICTIONAL,
          value:        '"' + subj1 + '" (in user\'s project): ' + pred1,
          provenance:   'user fictional/project claim',
          relationships: contextProjectName
            ? [{ from: _conceptKey(subj1), relation: 'belongs_to', to: _conceptKey(contextProjectName) }]
            : [],
        });
      }
    }

    // "The [X] is the [power/system/core/engine] of/in my [game/project]"
    var m2 = text.match(/\b[Tt]he\s+([A-Za-z][A-Za-z0-9 _\-]{1,40})\s+is\s+(?:a\s+|an\s+|the\s+)?(.{3,80}?)\s+(?:of|in)\s+(?:my|the)\s+(?:game|project|app|story|world|novel)/i);
    if (m2) {
      var subj2 = m2[1].trim();
      var pred2 = m2[2].trim();
      if (!_isFiller(subj2) && !_isSensitive(pred2) && pred2.length >= 3) {
        results.push({
          concept:      _conceptKey(subj2),
          label:        subj2,
          claimType:    CLAIM_TYPE.PROJECT,
          value:        '"' + subj2 + '" is ' + pred2 + ' of user\'s project',
          provenance:   'user project claim',
          relationships: contextProjectName
            ? [{ from: _conceptKey(subj2), relation: 'is_part_of', to: _conceptKey(contextProjectName) }]
            : [],
        });
      }
    }

    // "[ProjectName]'s X is/does Y"
    if (contextProjectName) {
      var pn = contextProjectName.replace(/[^a-z0-9 ]/gi, '');
      var re3 = new RegExp(pn.replace(/\s+/g, '\\s+') + '.?s?\\s+([A-Za-z][A-Za-z0-9 _\\-]{1,40})\\s+(?:is|does|are|has|uses|will\\s+be|should\\s+be)\\s+(.{3,80}?)(?:[.,!?]|$)', 'i');
      var m3 = text.match(re3);
      if (m3) {
        var attr3 = m3[1].trim();
        var pred3 = m3[2].trim().replace(/[.,!?]$/, '');
        if (!_isFiller(attr3) && !_isSensitive(pred3)) {
          results.push({
            concept:      _conceptKey(contextProjectName + '_' + attr3),
            label:        contextProjectName + ' ' + attr3,
            claimType:    CLAIM_TYPE.PROJECT,
            value:        contextProjectName + ' — ' + attr3 + ': ' + pred3,
            provenance:   'user project claim',
            relationships: [{ from: _conceptKey(contextProjectName), relation: attr3.replace(/\s+/g, '_'), to: _conceptKey(pred3.split(' ').slice(0, 4).join(' ')) }],
          });
        }
      }
    }

    return results;
  }

  /**
   * Relationship extraction:
   *   "X belongs to Y", "X is part of Y", "X is related to Y"
   *   "X connects to Y", "X powers Y"
   */
  function _extractRelationships(text) {
    var results = [];

    var RELATIONS = [
      'belongs to', 'is part of', 'is related to', 'connects to',
      'powers', 'controls', 'drives', 'enables', 'requires',
      'contains', 'uses', 'leads to', 'comes from', 'is inside',
    ];

    for (var i = 0; i < RELATIONS.length; i++) {
      var rel = RELATIONS[i];
      var re = new RegExp('([A-Za-z][A-Za-z0-9 _\\-]{1,40})\\s+' + rel.replace(/\s+/g, '\\s+') + '\\s+([A-Za-z][A-Za-z0-9 _\\-]{1,40})(?:[.,!?]|$)', 'i');
      var m = text.match(re);
      if (m) {
        var from = m[1].trim();
        var to   = m[2].trim();
        if (!_isFiller(from) && !_isFiller(to) && !_isSensitive(from) && !_isSensitive(to)) {
          results.push({
            concept:      _conceptKey(from + '_' + rel.replace(/\s+/g, '_') + '_' + to),
            label:        from + ' ' + rel + ' ' + to,
            claimType:    CLAIM_TYPE.RELATIONSHIP,
            value:        '"' + from + '" ' + rel + ' "' + to + '"',
            provenance:   'user stated',
            relationships: [{ from: _conceptKey(from), relation: rel.replace(/\s+/g, '_'), to: _conceptKey(to) }],
          });
          break; // one relationship per sentence
        }
      }
    }

    return results;
  }

  /**
   * Correction detection:
   *   "Actually X is Y", "Wait, X should be Y", "I meant X is Y"
   *   "No, it's X", "Change that to X"
   */
  // Negation prefixes — a correction starting with these is a negated command, not a fact
  var _CORRECTION_NEGATION = /^(don'?t|do not|not |never |stop |no )/i;

  function _extractCorrectionClaim(text) {
    var results = [];

    var corrRe = /\b(?:actually[,]?\s+|wait[,]?\s+|no[,]?\s+it.?s\s+|i\s+(?:meant|changed\s+it\s+to|want\s+it\s+to\s+be)\s+|make\s+that\s+|change\s+(?:that\s+)?to\s+|correction[:]?\s*)(.{3,100}?)(?:[.,!?]|$)/i;
    var m = text.match(corrRe);
    if (m) {
      var correction = m[1].trim().replace(/[.,!?]$/, '');

      // NEGATION GUARD: "Actually, don't change X" → negated command, not a storable correction
      if (_CORRECTION_NEGATION.test(correction)) return results;

      if (!_isFiller(correction) && !_isSensitive(correction) && correction.length >= 3) {
        results.push({
          concept:      _conceptKey('correction_' + correction.split(' ').slice(0, 4).join('_')),
          label:        correction,
          claimType:    CLAIM_TYPE.CORRECTION,
          value:        'Correction: ' + correction,
          provenance:   'user correction',
          relationships: [],
          isCorrection: true,
          correctionText: correction,
        });
      }
    }

    return results;
  }

  /**
   * Classify a claim as PERSONAL, PROJECT, FICTIONAL, GENERAL_CLAIM, or DEFINITION
   */
  function _classifyClaim(text, subject, predicate) {
    var lower = text.toLowerCase();

    if (/\b(my|our)\b/.test(lower) || /\bi.?m\b/.test(lower) || /\bi\s+(am|was|built|made|created)\b/.test(lower)) {
      // Has personal ownership marker
      if (/\b(game|project|story|app|website|world|novel|universe)\b/.test(lower)) {
        return CLAIM_TYPE.FICTIONAL; // fictional/project world
      }
      return CLAIM_TYPE.PERSONAL;
    }

    if (/\bin\s+(my|the)\s+(game|story|world|project|app|novel|universe)\b/i.test(text)) {
      return CLAIM_TYPE.FICTIONAL;
    }

    if (/\b(means|refers to|stands for|is defined as)\b/i.test(text)) {
      return CLAIM_TYPE.TERMINOLOGY;
    }

    if (/\b(is a|is an|are a|are an)\b/i.test(text)) {
      return CLAIM_TYPE.DEFINITION;
    }

    return CLAIM_TYPE.GENERAL_CLAIM;
  }

  /**
   * Main extraction function — runs all extractors and deduplicates.
   */
  function extractKnowledge(text, contextProjectName) {
    if (!text || _isSensitive(text)) return [];
    if (_isFiller(text)) return [];

    var all = [];

    try { all = all.concat(_extractDefinitions(text)); }              catch (_) {}
    try { all = all.concat(_extractPersonalClaims(text)); }           catch (_) {}
    try { all = all.concat(_extractProjectClaims(text, contextProjectName)); } catch (_) {}
    try { all = all.concat(_extractRelationships(text)); }            catch (_) {}
    try { all = all.concat(_extractCorrectionClaim(text)); }          catch (_) {}

    // Deduplicate by concept key
    var seen = {};
    return all.filter(function (item) {
      if (!item || !item.concept || item.concept.length < 2) return false;
      if (seen[item.concept]) return false;
      seen[item.concept] = true;
      return true;
    });
  }

  /* ─────────────────────────────────────────────────────────────
     SEMANTIC RETRIEVAL
     Query learned knowledge using concept/relationship/topic matching
     beyond simple keyword overlap.
  ───────────────────────────────────────────────────────────────*/

  /**
   * Semantic token overlap score.
   * Splits text into meaningful tokens (length >= 3, not stop words).
   */
  var _STOP_WORDS = new Set(['the', 'and', 'for', 'are', 'was', 'were', 'will', 'been', 'have', 'has', 'had',
    'that', 'this', 'with', 'from', 'but', 'not', 'can', 'did', 'does', 'its', 'what', 'how',
    'you', 'your', 'they', 'them', 'then', 'than', 'into', 'about', 'when', 'which', 'like',
    'some', 'tell', 'use', 'used', 'just', 'any', 'all', 'also', 'more', 'who', 'where']);

  function _tokens(text) {
    return (text || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(function (t) { return t.length >= 3 && !_STOP_WORDS.has(t); });
  }

  function _tokenOverlapScore(queryTokens, targetText) {
    if (!targetText) return 0;
    var targetTokens = _tokens(targetText);
    var score = 0;
    queryTokens.forEach(function (qt) {
      targetTokens.forEach(function (tt) {
        if (tt === qt) score += 3;
        else if (tt.indexOf(qt) !== -1 || qt.indexOf(tt) !== -1) score += 1;
      });
    });
    return score;
  }

  /**
   * Query learned brain knowledge semantically.
   * Returns items sorted by relevance to the query text.
   */
  function semanticRetrieve(queryText, contextProjectName, maxResults) {
    maxResults = maxResults || 6;
    var brain = _brain();
    if (!brain) return [];

    // Get all items from brain
    var allItems = brain.retrieve({
      text:        queryText,
      projectName: contextProjectName || null,
      topic:       null,
    });

    if (!allItems || !allItems.length) return [];

    // Re-score with semantic overlap
    var queryTokens = _tokens(queryText);
    if (!queryTokens.length) return allItems.slice(0, maxResults);

    var rescored = allItems.map(function (item) {
      var score = 0;

      // Token overlap with value
      score += _tokenOverlapScore(queryTokens, item.value);

      // Token overlap with concept key (only non-trivial concept keys >= 4 chars)
      var conceptText = (item.concept || '').replace(/_/g, ' ');
      if (conceptText.length >= 4) {
        score += _tokenOverlapScore(queryTokens, conceptText);
      }

      // Relationship targets
      (item.relationships || []).forEach(function (r) {
        if (r.to && r.to.length >= 3)   score += _tokenOverlapScore(queryTokens, r.to);
        if (r.from && r.from.length >= 3) score += _tokenOverlapScore(queryTokens, r.from);
      });

      // Boost corrections to the top
      if (item.type === 'CORRECTION' || item.claimType === CLAIM_TYPE.CORRECTION) score += 8;

      // High confidence bonus
      if (item.confidence === 'HIGH') score += 2;
      else if (item.confidence === 'MEDIUM') score += 1;

      return { item: item, score: score };
    });

    rescored.sort(function (a, b) { return b.score - a.score; });
    // Minimum threshold of 3: requires at least one real token match beyond base confidence.
    // This prevents items learned from unrelated turns from bleeding into every response.
    return rescored
      .filter(function (s) { return s.score >= 3; })
      .slice(0, maxResults)
      .map(function (s) { return s.item; });
  }

  /* ─────────────────────────────────────────────────────────────
     KNOWLEDGE-AWARE RESPONSE BUILDER
     Composes a natural response from retrieved knowledge.
  ───────────────────────────────────────────────────────────────*/

  /**
   * Given a question and retrieved knowledge items, build a natural answer.
   * Returns null if knowledge is insufficient.
   */
  function buildLearnedResponse(queryText, knowledgeItems, contextProjectName) {
    if (!knowledgeItems || !knowledgeItems.length) return null;

    var lower = queryText.toLowerCase();

    // Detect question type
    var isWhatIs   = /\b(what|who|which)\b.*\b(is|are|was|were|does|do|did)\b/i.test(queryText);
    var isDesign   = /\b(design|look|style|color|colour|theme|visual|background|layout|ui|interface)\b/i.test(lower);
    var isFeature  = /\b(feature|does it|can it|how does|what does|what can)\b/i.test(lower);
    var isRelation = /\b(belong|part of|related|connect|inside|contain|power|drive)\b/i.test(lower);

    // Filter out low-relevance items — only use items that actually have value
    var useful = knowledgeItems.filter(function (item) {
      return item && item.value && item.value.length > 5;
    });

    if (!useful.length) return null;

    // Build response parts
    var parts = [];
    var seen  = {};

    for (var i = 0; i < useful.length && parts.length < 3; i++) {
      var item = useful[i];
      var v = item.value;

      // Avoid duplicate sentences
      var vKey = v.toLowerCase().substring(0, 40);
      if (seen[vKey]) continue;
      seen[vKey] = true;

      // Clean up internal prefixes for natural presentation
      v = v.replace(/^"([^"]+)"\s+is\s+/, '$1 is ')
           .replace(/^User's\s+/, 'Your ')
           .replace(/^User is building:\s+/, 'You\'re building ')
           .replace(/^"([^"]+)"\s+means:\s+/, '$1 means ')
           .replace(/^Correction:\s+/i, '');

      parts.push(v);
    }

    if (!parts.length) return null;

    // Format response
    if (parts.length === 1) {
      return 'Based on what you\'ve told me: ' + parts[0] + '.';
    }

    return 'Here\'s what I have from our conversations:\n' + parts.map(function (p, idx) {
      return '• ' + p;
    }).join('\n');
  }

  /**
   * "I don't know" response variants — natural, not canned.
   */
  var _DONT_KNOW = [
    "I don't have reliable information on that yet.",
    "I'm not sure about that — I don't have enough context on it.",
    "That's not something I have in my knowledge yet.",
    "I don't know enough about that to give you a confident answer.",
    "I haven't learned anything about that yet. Can you tell me more?",
  ];

  var _DONT_KNOW_IDX = 0;
  function _pickDontKnow() {
    var r = _DONT_KNOW[_DONT_KNOW_IDX % _DONT_KNOW.length];
    _DONT_KNOW_IDX++;
    return r;
  }

  /* ─────────────────────────────────────────────────────────────
     LEARN FROM TURN — public entry point
     Processes a user turn through the full extraction pipeline
     and stores any learned knowledge into SRAdaptiveBrain.
  ───────────────────────────────────────────────────────────────*/

  /**
   * learn(turn)
   * turn = { text, role, convId, projectName, sessionContext }
   * Fire-and-forget.
   */
  function learn(turn) {
    if (!turn || !turn.text || turn.role !== 'user') return;
    if (_isSensitive(turn.text)) return;

    var brain = _brain();
    if (!brain) return;

    var text        = turn.text;
    var convId      = turn.convId      || null;
    var projectName = turn.projectName || null;

    // 1. Let SRAdaptiveBrain run its own extraction (project/design/preference/person)
    brain.learn({
      text:        text,
      role:        'user',
      convId:      convId,
      projectName: projectName,
    });

    // 2. Run our extended extraction (definitions, relationships, fictional claims)
    var extracted = extractKnowledge(text, projectName);
    if (!extracted.length) return;

    // 3. Store each extracted item directly via brain.store() — bypasses re-extraction.
    //    This handles items the brain's own text extractors cannot derive from raw text:
    //    general definitions ("A X is Y"), fictional claims, terminology, relationships.
    extracted.forEach(function (item) {
      if (_isNewKnowledge(item, brain)) {
        if (typeof brain.store === 'function') {
          brain.store({
            concept:      item.concept,
            type:         item.claimType || item.type || 'TOPIC',
            value:        item.value,
            relationships: item.relationships || [],
            isCorrection:  !!item.isCorrection,
            correctionValue: item.correctionValue || null,
            sourceConvId:  convId,
          });
        }
      }
    });
  }

  /**
   * Check if a knowledge item is genuinely new (not already in brain).
   */
  function _isNewKnowledge(item, brain) {
    var existing = brain.listAll();
    var key = item.concept;
    // Check if concept key or similar value already exists
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].concept === key) return false;
      // Check value similarity
      var existVal = (existing[i].value || '').toLowerCase();
      var itemVal  = (item.value || '').toLowerCase();
      if (existVal.indexOf(itemVal.substring(0, 30)) !== -1) return false;
    }
    return true;
  }

  /* ─────────────────────────────────────────────────────────────
     RETRIEVE — semantic recall
  ───────────────────────────────────────────────────────────────*/

  function retrieve(queryText, contextProjectName, maxResults) {
    return semanticRetrieve(queryText, contextProjectName, maxResults || 6);
  }

  /* ─────────────────────────────────────────────────────────────
     QUERY FOR RESPONSE — used by response engine
     Returns { answered: bool, response: string|null, items: [] }
  ───────────────────────────────────────────────────────────────*/

  function queryForResponse(queryText, contextProjectName, intent) {
    var brain = _brain();
    if (!brain) return { answered: false, response: null, items: [] };

    var items = semanticRetrieve(queryText, contextProjectName, 6);

    if (!items.length) {
      // No learned knowledge found.
      // CRITICAL: Do NOT emit "I don't know" here.
      // The caller (response engine + shadow-reaper) checks SRKnowledge (static)
      // separately. If we emit "don't know" now we intercept before static
      // knowledge can answer. Return answered:false so the pipeline continues.
      return { answered: false, response: null, items: [] };
    }

    // Additional filter: for QUESTION intent, only use learned knowledge if the
    // query tokens have real semantic overlap with the top item (not just confidence).
    // This prevents project context ("darker", "NightGlass") from being served
    // as answers to unrelated general knowledge questions like "What is JavaScript?".
    if (intent === 'QUESTION') {
      var queryTokens = _tokens(queryText);
      var hasDirectOverlap = items.some(function (item) {
        // At least one meaningful token (>= 5 chars) must overlap with item value or concept
        return queryTokens.some(function (t) {
          if (t.length < 5) return false;
          var valLower = (item.value || '').toLowerCase();
          var conLower = (item.concept || '').replace(/_/g, ' ').toLowerCase();
          return valLower.indexOf(t) !== -1 || conLower.indexOf(t) !== -1;
        });
      });
      if (!hasDirectOverlap) {
        return { answered: false, response: null, items: [] };
      }
    }

    var response = buildLearnedResponse(queryText, items, contextProjectName);
    if (!response) {
      return { answered: false, response: null, items: items };
    }

    return { answered: true, response: response, items: items };
  }

  /* ─────────────────────────────────────────────────────────────
     CORRECT — override stale knowledge
  ───────────────────────────────────────────────────────────────*/

  function correct(oldValue, newValue, conceptKey) {
    var brain = _brain();
    if (!brain) return;
    brain.correct(oldValue, newValue, conceptKey);
  }

  /* ─────────────────────────────────────────────────────────────
     REINFORCE — bump confidence of a concept
  ───────────────────────────────────────────────────────────────*/

  function reinforce(conceptKey) {
    var brain = _brain();
    if (!brain) return;
    brain.reinforce(conceptKey);
  }

  /* ─────────────────────────────────────────────────────────────
     FORGET — soft-delete a concept
  ───────────────────────────────────────────────────────────────*/

  function forget(conceptKey) {
    var brain = _brain();
    if (!brain) return;
    brain.forget(conceptKey);
  }

  /* ─────────────────────────────────────────────────────────────
     FIND RELATED — cross-concept lookup
  ───────────────────────────────────────────────────────────────*/

  function findRelated(conceptName) {
    var brain = _brain();
    if (!brain) return [];
    return brain.getRelated(conceptName);
  }

  /* ─────────────────────────────────────────────────────────────
     RELATE — explicitly store a relationship between two concepts
  ───────────────────────────────────────────────────────────────*/

  function relate(fromConcept, relation, toConcept, contextProjectName) {
    var brain = _brain();
    if (!brain) return;

    var relationshipText = fromConcept + ' ' + relation + ' ' + toConcept;
    brain.learn({
      text:        '"' + fromConcept + '" ' + relation + ' "' + toConcept + '"',
      role:        'user',
      convId:      null,
      projectName: contextProjectName || null,
    });
  }

  /* ─────────────────────────────────────────────────────────────
     EMOTIONAL SIGNAL DETECTION
     Returns the current emotional signal from a message — used ONLY
     to adapt the CURRENT response. Never stored as a permanent profile.
  ───────────────────────────────────────────────────────────────*/

  var _EMOTION_PATTERNS = [
    { signal: 'happy',      re: /\b(happy|great|amazing|awesome|joyful|thrilled|ecstatic|delighted|wonderful|love|blessed|grateful|so\s+good|feeling\s+good)\b/i },
    { signal: 'excited',    re: /\b(excited|can.?t wait|pumped|stoked|hyped|woohoo|yay|yes!)\b/i },
    { signal: 'sad',        re: /\b(sad|upset|down|depressed|heartbroken|crying|unhappy|miserable|blue|lonely|hurt|lost)\b/i },
    { signal: 'frustrated', re: /\b(frustrated|annoyed|irritated|fed up|done with|sick of|uggh?|ugh)\b/i },
    { signal: 'angry',      re: /\b(angry|furious|mad|rage|livid|infuriated)\b/i },
    { signal: 'anxious',    re: /\b(anxious|worried|nervous|scared|afraid|panic|stressed|overwhelmed)\b/i },
    { signal: 'confused',   re: /\b(confused|confusing|don.?t understand|not sure|lost|unclear|huh|wait what)\b/i },
    { signal: 'tired',      re: /\b(tired|exhausted|drained|sleepy|long day|rough day|worn out)\b/i },
    { signal: 'hopeful',    re: /\b(hopeful|optimistic|looking forward|things.+better)\b/i },
    { signal: 'playful',    re: /\b(haha|lol|lmao|rofl|joking|just kidding|jk)\b/i },
  ];

  /**
   * Detect emotional signal — for CURRENT response adaptation ONLY.
   * NEVER stored. NEVER used to build a permanent profile.
   */
  function detectEmotionalSignal(text) {
    if (!text) return null;
    for (var i = 0; i < _EMOTION_PATTERNS.length; i++) {
      if (_EMOTION_PATTERNS[i].re.test(text)) {
        return _EMOTION_PATTERNS[i].signal;
      }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     HELPERS
  ───────────────────────────────────────────────────────────────*/

  function _brain() {
    return global.SRAdaptiveBrain || null;
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.SRKnowledgeLearner
  ───────────────────────────────────────────────────────────────*/
  global.SRKnowledgeLearner = {
    build:    BUILD_ID,

    CLAIM_TYPE: CLAIM_TYPE,

    // Core generic model-independent interfaces
    learn:             learn,
    retrieve:          retrieve,
    relate:            relate,
    correct:           correct,
    reinforce:         reinforce,
    forget:            forget,
    findRelated:       findRelated,
    queryForResponse:  queryForResponse,

    // Knowledge extraction (for testing)
    extractKnowledge:  extractKnowledge,

    // Semantic retrieval
    semanticRetrieve:  semanticRetrieve,

    // Response building
    buildLearnedResponse: buildLearnedResponse,

    // Emotional signal (current-turn only)
    detectEmotionalSignal: detectEmotionalSignal,

    // Helpers exposed for testing
    _isSensitive:      _isSensitive,
    _isFiller:         _isFiller,
    _conceptKey:       _conceptKey,
    _classifyClaim:    _classifyClaim,
    _tokens:           _tokens,
    _tokenOverlapScore: _tokenOverlapScore,
  };

})(typeof window !== 'undefined' ? window : global);
