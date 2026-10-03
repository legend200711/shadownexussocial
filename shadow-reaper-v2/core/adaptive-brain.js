/**
 * shadow-reaper-v2/core/adaptive-brain.js
 * Shadow Reaper V2 — Persistent Adaptive Learning Brain
 *
 * Build: SR-V2-BRAIN-1
 *
 * PURPOSE:
 *   Model-independent, Firebase-backed learning brain that automatically
 *   extracts concepts and relationships from conversation turns, builds a
 *   concept graph, corrects/supersedes stale knowledge, and retrieves
 *   bounded relevant context for future sessions.
 *
 * ARCHITECTURE:
 *   This module WRAPS and EXTENDS SNXShadowAdaptive (snx-shadow-adaptive.js).
 *   It reuses the same:
 *     - Firebase collection: users/{uid}/shadowReaperLearnedContext
 *     - UID isolation and auth helpers
 *     - Sensitive data filters
 *     - Enabled/disabled preference
 *   It adds:
 *     - Concept extraction from free-form conversation (named entity, project,
 *       design decision, feature, preference, topic, relationship, correction)
 *     - Relationship tracking between concepts
 *     - Correction engine (supersedes stale knowledge)
 *     - Confidence levels: LOW / MEDIUM / HIGH
 *     - getRelated(concept) for cross-concept retrieval
 *     - learn(turn), retrieve(context), correct(old, new), reinforce(item),
 *       forget(item) generic interfaces
 *
 * WHAT IS LEARNED:
 *   Named projects, websites, features, design decisions, preferences,
 *   topics, corrections, relationships between any of the above.
 *
 * WHAT IS NEVER LEARNED:
 *   passwords, API keys, tokens, credentials, ephemeral emotions,
 *   greetings, filler words, sensitive personal health data.
 *
 * MODEL INDEPENDENCE:
 *   Zero Workers AI. Zero OpenAI. Zero external model inference.
 *   All extraction is deterministic local regex + heuristics.
 *   The learn/retrieve/correct/getRelated interfaces are model-agnostic.
 *
 * FIRESTORE PATH:
 *   users/{uid}/shadowReaperLearnedContext/{itemId}
 *   (same collection as SNXShadowAdaptive — no duplicate collections)
 *
 * PRIVACY:
 *   UID-scoped. No cross-user access. Founder status does not override.
 *
 * ZERO POLLING. ZERO RAF. ZERO setInterval.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-V2-BRAIN-1';

  /* ─────────────────────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────────────────────────*/
  var MAX_CONCEPTS        = 300;   // max stored concepts per user
  var MAX_RETRIEVE        = 8;     // max items injected per response
  var MAX_VALUE_LEN       = 400;   // max chars per concept value
  var MAX_REL_PER_CONCEPT = 10;    // max relationships stored per concept
  var CONF_HIGH_THRESHOLD = 4;     // count >= this → HIGH
  var CONF_MED_THRESHOLD  = 2;     // count >= this → MEDIUM

  /* ─────────────────────────────────────────────────────────────
     SENSITIVE DATA FILTER
     Extends the patterns in SNXShadowAdaptive.
  ───────────────────────────────────────────────────────────────*/
  var _SENSITIVE = [
    /\b(password|passwd)\s*(is|=|:)\s*\S+/i,
    /\bapi[\s_-]?key\s*(is|=|:)\s*\S+/i,
    /\btoken\s*(is|=|:)\s*\S+/i,
    /\bsecret\s*(is|=|:)\s*\S+/i,
    /\bcredit\s*card/i,
    /\b(private key|ssh key|rsa key)\s*(is|=|:)/i,
    /\bmy password is\b/i,
    /\bmy api key is\b/i,
    /\bmy token is\b/i,
    /\b(suicid|kill myself|end my life|self.harm)\b/i,
  ];

  // Words that are ephemeral filler and must not be learned as concepts
  var _FILLER = /^(hello|hi|hey|yo|bye|thanks|okay|ok|lol|lmao|haha|yep|nope|sure|great|cool|nice|yes|no|please|sorry)$/i;

  function _isSensitive(text) {
    if (!text) return false;
    for (var i = 0; i < _SENSITIVE.length; i++) {
      if (_SENSITIVE[i].test(text)) return true;
    }
    return false;
  }

  function _isFiller(word) {
    return _FILLER.test(word.trim());
  }

  /* ─────────────────────────────────────────────────────────────
     CONCEPT TYPES
  ───────────────────────────────────────────────────────────────*/
  var CONCEPT_TYPES = {
    PROJECT:     'PROJECT',
    WEBSITE:     'WEBSITE',
    FEATURE:     'FEATURE',
    DESIGN:      'DESIGN',
    PREFERENCE:  'PREFERENCE',
    PERSON:      'PERSON',
    TOPIC:       'TOPIC',
    DECISION:    'DECISION',
    CORRECTION:  'CORRECTION',
    RELATIONSHIP:'RELATIONSHIP',
    NAME:        'NAME',
  };

  /* ─────────────────────────────────────────────────────────────
     EXTRACTION PATTERNS
     Each extractor returns an array of { concept, type, value, relationships }
     relationships: [{from, relation, to}]
  ───────────────────────────────────────────────────────────────*/

  /**
   * Extract a named entity (project/website name) from:
   *   "My project is called X"
   *   "I'm building X"
   *   "X is a website/project/app/game/platform"
   *   "It's called X"
   */
  function _extractNamedProject(text) {
    var results = [];

    // "my project is called/named X" / "the project is called X"
    var m = text.match(/\b(?:my|the|a)\s+(?:project|app|game|website|site|platform|tool|system|thing)\s+(?:is\s+called|is\s+named|called|named)\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38}?)["']?(?:\s*[.,!?]|$)/i);
    if (m) {
      var name = m[1].trim();
      if (!_isFiller(name)) {
        results.push({
          concept: name.toLowerCase(),
          type: CONCEPT_TYPES.PROJECT,
          value: name,
          relationships: [{ from: name.toLowerCase(), relation: 'is_a', to: 'project' }],
        });
      }
    }

    // "I'm building/creating/making X"
    var m2 = text.match(/\bI.?m\s+(?:building|creating|making|developing|working\s+on|designing)\s+(?:a\s+|an\s+|my\s+|the\s+)?(?:(?:new|app|game|website|project)\s+)?(?:called\s+|named\s+)?["']?([A-Z][A-Za-z0-9][A-Za-z0-9 _\-]{1,36})["']?(?:\s*[.,!?]|$)/);
    if (m2) {
      var name2 = m2[1].trim();
      if (!_isFiller(name2) && name2.length >= 2) {
        results.push({
          concept: name2.toLowerCase(),
          type: CONCEPT_TYPES.PROJECT,
          value: name2,
          relationships: [{ from: name2.toLowerCase(), relation: 'is_a', to: 'project' }],
        });
      }
    }

    // "X is a website/app/game/project/platform"
    var m3 = text.match(/^["']?([A-Z][A-Za-z0-9][A-Za-z0-9 _\-]{1,36})["']?\s+is\s+(?:a|an|my)\s+(website|web\s*site|app|application|game|project|platform|tool|system|service)\b/i);
    if (m3) {
      var name3 = m3[1].trim();
      var type3 = m3[2].trim().toLowerCase().replace(/\s+/g, '');
      if (!_isFiller(name3)) {
        var ctype = (type3 === 'website' || type3 === 'website') ? CONCEPT_TYPES.WEBSITE : CONCEPT_TYPES.PROJECT;
        results.push({
          concept: name3.toLowerCase(),
          type: ctype,
          value: name3,
          relationships: [{ from: name3.toLowerCase(), relation: 'is_a', to: type3 }],
        });
      }
    }

    // "I'm calling it X" / "It's called X"
    var m4 = text.match(/\b(?:I.?m calling it|it.?s called|it.?s named|calling it)\s+["']?([A-Za-z0-9][A-Za-z0-9 _\-]{1,38}?)["']?(?:\s*[.,!?]|$)/i);
    if (m4) {
      var name4 = m4[1].trim();
      if (!_isFiller(name4) && name4.length >= 2) {
        results.push({
          concept: name4.toLowerCase(),
          type: CONCEPT_TYPES.PROJECT,
          value: name4,
          relationships: [],
        });
      }
    }

    return results;
  }

  /**
   * Extract design decisions:
   *   "The homepage is dark/black/minimal"
   *   "It has blue lightning in the background"
   *   "Background uses X"
   *   "Design is going to be X"
   */
  function _extractDesignDecision(text, contextProjectName) {
    var results = [];

    // "the X is Y" where X is a design area
    var areaRe = /\b(?:the\s+)?(homepage|home\s*page|landing\s*page|background|header|footer|sidebar|dashboard|navbar|nav bar|ui|layout|design|color scheme|colour scheme|font|typography|logo|icon|button|page|section|interface|style|theme)\b\s+(?:is|will\s+be|should\s+be|needs?\s+to\s+be|going\s+to\s+be|is\s+going\s+to\s+be)\s+([a-z][a-z0-9 _,\-]{0,60})/ig;
    var am;
    while ((am = areaRe.exec(text)) !== null) {
      var area  = am[1].trim().toLowerCase().replace(/\s+/g, '_');
      var value = am[2].trim().toLowerCase().replace(/[.,!?]$/, '');
      if (value.length > 1 && !_isFiller(value)) {
        var rel = { from: area, relation: 'design', to: value };
        if (contextProjectName) {
          rel = { from: contextProjectName.toLowerCase(), relation: area + '_design', to: value };
        }
        results.push({
          concept: area + '_design',
          type:    CONCEPT_TYPES.DESIGN,
          value:   (contextProjectName ? contextProjectName + ' — ' : '') + area + ': ' + value,
          relationships: [rel],
        });
      }
    }

    // "It uses/has X in the background/header/etc."
    var hasRe = /\b(?:it\s+)?(?:uses?|has|includes?|features?)\s+([a-z][a-z0-9 \-_]{2,40}?)\s+(?:in\s+(?:the\s+)?)?(?:background|header|footer|sidebar|navbar|nav|design|theme|interface|layout|style)\b/ig;
    var hm;
    while ((hm = hasRe.exec(text)) !== null) {
      var feature = hm[1].trim().toLowerCase();
      if (!_isFiller(feature) && feature.length > 2) {
        results.push({
          concept: feature + '_feature',
          type:    CONCEPT_TYPES.FEATURE,
          value:   (contextProjectName ? contextProjectName + ' — ' : '') + 'feature: ' + feature,
          relationships: contextProjectName
            ? [{ from: contextProjectName.toLowerCase(), relation: 'has_feature', to: feature }]
            : [],
        });
      }
    }

    return results;
  }

  /**
   * Extract user preference:
   *   "I prefer X", "I like X", "I want X", "I always use X"
   */
  function _extractPreference(text) {
    var results = [];
    var m = text.match(/\b(?:I\s+(?:prefer|like|love|always\s+use|usually\s+use|tend\s+to\s+use|want)\s+([a-z][a-z0-9 _\-]{2,60}))\b/i);
    if (m) {
      var pref = m[1].trim().toLowerCase().replace(/[.,!?]$/, '');
      if (!_isFiller(pref) && !_isSensitive(pref)) {
        results.push({
          concept: 'pref_' + pref.substring(0, 30).replace(/\s+/g, '_'),
          type:    CONCEPT_TYPES.PREFERENCE,
          value:   'User prefers: ' + pref,
          relationships: [],
        });
      }
    }
    return results;
  }

  /**
   * Extract person mentions:
   *   "My friend/colleague/collaborator X is helping"
   *   "Working with X on this"
   */
  function _extractPerson(text) {
    var results = [];
    var m = text.match(/\b(?:my\s+(?:friend|colleague|collaborator|partner|co-founder|teammate|bandmate)\s+|working\s+with\s+)([A-Z][a-z]{1,20}(?:\s+[A-Z][a-z]{1,20})?)\b/);
    if (m) {
      var name = m[1].trim();
      results.push({
        concept: name.toLowerCase(),
        type:    CONCEPT_TYPES.PERSON,
        value:   'Person: ' + name,
        relationships: [],
      });
    }
    return results;
  }

  /**
   * Detect a correction / update to existing knowledge:
   *   "Actually, X is Y" / "I meant X" / "Make that X" / "Change it to X"
   *   "Wait, it should be X"
   *
   * NEGATION GUARD:
   *   "Actually, don't change the homepage" → NOT a storable correction.
   *   "No, I meant the menu" → IS a storable correction (redirects focus).
   *   Reject corrections that are themselves negated commands.
   */
  function _extractCorrection(text) {
    var results = [];
    var corrRe = /\b(?:actually[,]?\s+|wait[,]?\s+|no[,]?\s+|i\s+(?:meant|changed\s+it\s+to|changed\s+my\s+mind|want\s+it\s+to\s+be|said)\s+|make\s+(?:that|it)\s+|change\s+(?:it\s+)?to\s+)([a-z][a-z0-9 _,\-]{1,60})/i;
    var m = text.match(corrRe);
    if (m) {
      var correction = m[1].trim().toLowerCase().replace(/[.,!?]$/, '');

      // Reject if the correction text starts with a negation — it's a negated command,
      // not a durable fact. e.g. "don't change the homepage", "not the homepage"
      var _NEGATION_START = /^(don'?t?|do not|not\b|never|no |stop |don't |no\b)/i;
      if (_NEGATION_START.test(correction)) return results;

      // Reject bare fragment "don" (partial tokenization of "don't")
      if (/^don$/.test(correction.trim())) return results;

      // Also reject very generic extracted fragments that aren't meaningful concepts:
      // sentence-internal conjunctions used as pivots ("let's work on the menu instead")
      var _MEANINGLESS = /^(the |a |an |it |that |this |let'?s |work on |instead|change|just|focus|working)/i;
      if (_MEANINGLESS.test(correction) && correction.split(' ').length <= 3) return results;

      if (!_isFiller(correction) && !_isSensitive(correction) && correction.length > 2) {
        results.push({
          concept: 'correction_' + Date.now().toString(36),
          type:    CONCEPT_TYPES.CORRECTION,
          value:   'Correction: ' + correction,
          isCorrection: true,
          correctionValue: correction,
          relationships: [],
        });
      }
    }
    return results;
  }

  /**
   * Main extraction entry point.
   * Returns array of extracted concept objects.
   */
  function _extractConcepts(text, contextProjectName) {
    if (!text || _isSensitive(text)) return [];

    var all = [];

    try { all = all.concat(_extractNamedProject(text)); }       catch (_) {}
    try { all = all.concat(_extractDesignDecision(text, contextProjectName)); } catch (_) {}
    try { all = all.concat(_extractPreference(text)); }         catch (_) {}
    try { all = all.concat(_extractPerson(text)); }             catch (_) {}
    try { all = all.concat(_extractCorrection(text)); }         catch (_) {}

    // Deduplicate by concept key
    var seen = {};
    return all.filter(function (item) {
      if (!item || !item.concept) return false;
      if (seen[item.concept]) return false;
      seen[item.concept] = true;
      return true;
    });
  }

  /* ─────────────────────────────────────────────────────────────
     FIREBASE HELPERS
     Uses SRFirebaseAdapter — standalone, no SNS globals.
  ───────────────────────────────────────────────────────────────*/
  function _fa()  { return global.SRFirebaseAdapter || null; }
  function _uid() {
    var fa = _fa();
    if (fa && typeof fa.getUID === 'function') return fa.getUID();
    return null;
  }
  function _isAuth()  { return !!_uid(); }

  function _timestamp() {
    return new Date();
  }

  function _conceptsRef(uid) {
    var fa = _fa();
    if (!fa || !uid) return null;
    // Same collection as SNXShadowAdaptive — no duplication
    return typeof fa.userLearnedContextCol === 'function' ? fa.userLearnedContextCol() : null;
  }

  function _genId() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var b = new Uint8Array(8);
      crypto.getRandomValues(b);
      return 'br_' + Array.from(b).map(function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    }
    return 'br_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  /* ─────────────────────────────────────────────────────────────
     IN-MEMORY BRAIN STATE
     conceptMap: { conceptKey → BrainConcept }
       BrainConcept: {
         id, concept, type, value, confidence, count,
         relationships: [{from, relation, to}],
         active, supersededBy, sourceConvId,
         createdAt, updatedAt
       }
  ───────────────────────────────────────────────────────────────*/
  var _map      = {};   // concept key → BrainConcept
  var _loaded   = false;
  var _pending  = [];   // items queued before DB loaded
  var _ready    = false;

  function _calcConfidence(count) {
    if (count >= CONF_HIGH_THRESHOLD) return 'HIGH';
    if (count >= CONF_MED_THRESHOLD)  return 'MEDIUM';
    return 'LOW';
  }

  function _isEnabled() {
    try {
      // Delegate to SNXShadowAdaptive preference if available
      if (global.SNXShadowAdaptive && typeof global.SNXShadowAdaptive.isEnabled === 'function') {
        return global.SNXShadowAdaptive.isEnabled();
      }
      var val = global.localStorage ? global.localStorage.getItem('snxShadowAdaptiveEnabled') : null;
      return val !== 'false';
    } catch (_) { return true; }
  }

  /* ─────────────────────────────────────────────────────────────
     LOAD FROM FIRESTORE
     Loads all active brain concepts for the current user into _map.
     Lazy — only runs once per session; called on first learn/retrieve.
  ───────────────────────────────────────────────────────────────*/
  function _loadFromDB(uid, callback) {
    callback = callback || function () {};
    if (!_isAuth() || !uid) { _loaded = true; callback(); return; }
    var ref = _conceptsRef(uid);
    if (!ref) { _loaded = true; callback(); return; }

    // Load only records that have the brain category field (type='BRAIN_CONCEPT')
    // Fall back to loading all active items if category filter not supported
    ref.where('active', '==', true)
       .where('brainRecord', '==', true)
       .orderBy('updatedAt', 'desc')
       .limit(MAX_CONCEPTS)
       .get()
       .then(function (snap) {
         _map = {};
         snap.forEach(function (doc) {
           var d = doc.data();
           if (d && d.concept) {
             _map[d.concept] = {
               id:           doc.id,
               concept:      d.concept,
               type:         d.type || CONCEPT_TYPES.TOPIC,
               value:        d.value || '',
               confidence:   d.confidence || 'LOW',
               count:        d.count || 1,
               relationships: d.relationships || [],
               active:       true,
               supersededBy: d.supersededBy || null,
               sourceConvId: d.sourceConvId || null,
               createdAt:    d.createdAt || null,
               updatedAt:    d.updatedAt || null,
             };
           }
         });
         _loaded = true;
         callback();
       })
       .catch(function () {
         _loaded = true; // graceful failure
         callback();
       });
  }

  /* ─────────────────────────────────────────────────────────────
     PERSIST A CONCEPT
     Fire-and-forget — never blocks the pipeline.
  ───────────────────────────────────────────────────────────────*/
  function _persistConcept(uid, item) {
    if (!_isAuth() || !uid) return;
    var ref = _conceptsRef(uid);
    if (!ref) return;
    var now = _timestamp();

    var doc = {
      brainRecord:   true,  // distinguishes brain records from SNXShadowAdaptive records
      concept:       item.concept,
      type:          item.type,
      value:         item.value.substring(0, MAX_VALUE_LEN),
      confidence:    item.confidence,
      count:         item.count,
      relationships: (item.relationships || []).slice(0, MAX_REL_PER_CONCEPT),
      active:        item.active !== false,
      supersededBy:  item.supersededBy || null,
      sourceConvId:  item.sourceConvId || null,
      updatedAt:     now,
      category:      item.type, // kept for compatibility with SNXShadowAdaptive queries
      key:           item.concept, // kept for compatibility
    };

    if (item.id) {
      ref.doc(item.id).update(doc).catch(function () {});
    } else {
      var newId = _genId();
      doc.createdAt = now;
      ref.doc(newId).set(doc).then(function () {
        if (_map[item.concept]) _map[item.concept].id = newId;
      }).catch(function () {});
      if (_map[item.concept]) _map[item.concept].id = newId;
    }
  }

  /* ─────────────────────────────────────────────────────────────
     SOFT-SUPERSEDE
     Marks an old concept as superseded, links to new.
  ───────────────────────────────────────────────────────────────*/
  function _supersede(uid, oldConceptKey, newConceptKey) {
    var old = _map[oldConceptKey];
    if (!old) return;
    old.active       = false;
    old.supersededBy = newConceptKey;
    old.updatedAt    = Date.now();
    _persistConcept(uid, old);
  }

  /* ─────────────────────────────────────────────────────────────
     PROCESS — learn from extracted items
  ───────────────────────────────────────────────────────────────*/
  function _doLearn(uid, extractedItems, sourceConvId) {
    extractedItems.forEach(function (item) {
      var key = item.concept;
      var existing = _map[key];

      if (existing && existing.active) {
        // Reinforce: update value if changed, bump count, recalculate confidence
        if (item.value && item.value !== existing.value) {
          existing.value = item.value.substring(0, MAX_VALUE_LEN);
        }
        // Merge new relationships
        if (item.relationships && item.relationships.length) {
          item.relationships.forEach(function (rel) {
            var alreadyHas = existing.relationships.some(function (r) {
              return r.from === rel.from && r.relation === rel.relation && r.to === rel.to;
            });
            if (!alreadyHas && existing.relationships.length < MAX_REL_PER_CONCEPT) {
              existing.relationships.push(rel);
            }
          });
        }
        existing.count      = (existing.count || 1) + 1;
        existing.confidence = _calcConfidence(existing.count);
        existing.updatedAt  = Date.now();
        _persistConcept(uid, existing);

      } else {
        // New concept
        var newItem = {
          id:           null,
          concept:      key,
          type:         item.type,
          value:        (item.value || '').substring(0, MAX_VALUE_LEN),
          confidence:   'LOW',
          count:        1,
          relationships: (item.relationships || []).slice(0, MAX_REL_PER_CONCEPT),
          active:       true,
          supersededBy: null,
          sourceConvId: sourceConvId || null,
          createdAt:    Date.now(),
          updatedAt:    Date.now(),
        };
        _map[key] = newItem;
        _persistConcept(uid, newItem);
        _pruneIfNeeded(uid);
      }
    });
  }

  function _pruneIfNeeded(uid) {
    var keys = Object.keys(_map).filter(function (k) { return _map[k] && _map[k].active; });
    if (keys.length <= MAX_CONCEPTS) return;
    keys.sort(function (a, b) {
      var order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      return (order[_map[b].confidence] || 2) - (order[_map[a].confidence] || 2);
    });
    keys.slice(MAX_CONCEPTS).forEach(function (k) {
      var item = _map[k];
      _map[k].active = false;
      if (uid && item && item.id) {
        var ref = _conceptsRef(uid);
        if (ref) ref.doc(item.id).update({ active: false }).catch(function () {});
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────
     PUBLIC API — GENERIC INTERFACES
  ───────────────────────────────────────────────────────────────*/

  /**
   * learn(turn)
   * Process a conversation turn for adaptive learning.
   * turn = { text: string, role: 'user'|'assistant', convId: string, projectName: string }
   * Fire-and-forget.
   */
  function learn(turn) {
    if (!_isEnabled()) return;
    if (!turn || !turn.text || turn.role !== 'user') return;
    if (_isSensitive(turn.text)) return;

    var uid = _uid();  // null for guests — no persistence, but still learn in-memory

    var text = turn.text;
    var convId = turn.convId || null;
    var projectName = turn.projectName || null;

    if (!_loaded) {
      if (uid) {
        // Authenticated: load DB first, then process
        _pending.push({ text: text, convId: convId, projectName: projectName });
        _loadFromDB(uid, function () { _flushPending(uid); });
      } else {
        // Guest / test context: no DB to load, run in-memory immediately
        _loaded = true;
        var guestExtracted = _extractConcepts(text, projectName);
        _doLearn(null, guestExtracted, convId);
      }
      return;
    }
    var extracted = _extractConcepts(text, projectName);
    _doLearn(uid, extracted, convId);
  }

  function _flushPending(uid) {
    var q = _pending.slice();
    _pending = [];
    q.forEach(function (t) {
      if (t._preExtracted) {
        // Pre-extracted item from external extractor — store directly
        _doLearnPreExtracted(uid, [t._preExtracted]);
      } else {
        var extracted = _extractConcepts(t.text, t.projectName);
        _doLearn(uid, extracted, t.convId);
      }
    });
  }

  /**
   * retrieve(context)
   * Returns up to MAX_RETRIEVE relevant concept items for current message.
   * context = { text: string, projectName: string, topic: string }
   * Returns array of { concept, type, value, confidence }
   */
  function retrieve(context) {
    if (!_isEnabled()) return [];
    if (!context || !context.text) return [];
    // If DB not yet loaded for authenticated user, we can still return from in-memory
    // (DB load happens lazily; in-memory may be empty until first load)
    var text  = context.text.toLowerCase();
    var keys  = Object.keys(_map);
    if (!keys.length) return [];

    var scored = [];
    keys.forEach(function (k) {
      var item = _map[k];
      if (!item || !item.active) return;

      var score = 0;

      // Confidence base
      if (item.confidence === 'HIGH')   score += 3;
      else if (item.confidence === 'MEDIUM') score += 2;
      else score += 1;

      // Direct concept name appears in query
      var conceptWords = item.concept.replace(/_/g, ' ').toLowerCase();
      if (text.indexOf(conceptWords) !== -1) score += 5;

      // Value keywords match query
      var valueWords = (item.value || '').toLowerCase().split(/\s+/).filter(function (w) { return w.length > 3; });
      valueWords.forEach(function (w) { if (text.indexOf(w) !== -1) score += 2; });

      // Project name context match
      if (context.projectName) {
        var pn = context.projectName.toLowerCase();
        if ((item.value || '').toLowerCase().indexOf(pn) !== -1) score += 4;
        if (item.concept.indexOf(pn) !== -1) score += 3;
      }

      // Relationship target matches query
      (item.relationships || []).forEach(function (rel) {
        if (text.indexOf((rel.to || '').toLowerCase()) !== -1) score += 2;
        if (text.indexOf((rel.from || '').toLowerCase()) !== -1) score += 1;
      });

      // Type bonus
      if (item.type === CONCEPT_TYPES.CORRECTION) score += 3;
      if (item.type === CONCEPT_TYPES.PROJECT || item.type === CONCEPT_TYPES.WEBSITE) score += 1;

      scored.push({ item: item, score: score });
    });

    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, MAX_RETRIEVE).map(function (s) {
      return {
        concept:      s.item.concept,
        type:         s.item.type,
        value:        s.item.value,
        confidence:   s.item.confidence,
        relationships: s.item.relationships,
      };
    });
  }

  /**
   * correct(oldValue, newValue, conceptKey)
   * Mark existing knowledge as superseded and store updated value.
   * conceptKey is optional — if not provided, attempts to match by value.
   */
  function correct(oldValue, newValue, conceptKey) {
    if (!_isEnabled()) return;
    var uid = _uid();
    if (!newValue) return;

    var targetKey = conceptKey || null;

    // Find by conceptKey or by value substring match
    if (!targetKey) {
      var oldLower = (oldValue || '').toLowerCase();
      Object.keys(_map).forEach(function (k) {
        var item = _map[k];
        if (item && item.active && (item.value || '').toLowerCase().indexOf(oldLower) !== -1) {
          targetKey = k;
        }
      });
    }

    var newConceptKey = (conceptKey ? conceptKey + '_corrected' : 'corrected_' + Date.now().toString(36));
    var newItem = {
      id:           null,
      concept:      newConceptKey,
      type:         CONCEPT_TYPES.CORRECTION,
      value:        'Correction: ' + newValue.substring(0, MAX_VALUE_LEN),
      confidence:   'HIGH', // user corrections get HIGH confidence immediately
      count:        4,       // starts at HIGH threshold
      relationships: targetKey ? [{ from: newConceptKey, relation: 'supersedes', to: targetKey }] : [],
      active:       true,
      supersededBy: null,
      sourceConvId: null,
      createdAt:    Date.now(),
      updatedAt:    Date.now(),
    };
    _map[newConceptKey] = newItem;

    if (targetKey) {
      _supersede(uid, targetKey, newConceptKey);
    }
    if (uid) _persistConcept(uid, newItem);
  }

  /**
   * reinforce(conceptKey)
   * Explicitly bump confidence of an existing concept.
   */
  function reinforce(conceptKey) {
    var uid = _uid();
    var item = _map[conceptKey];
    if (!item || !item.active) return;
    item.count      = (item.count || 1) + 1;
    item.confidence = _calcConfidence(item.count);
    item.updatedAt  = Date.now();
    if (uid) _persistConcept(uid, item);
  }

  /**
   * forget(conceptKey)
   * Soft-deletes a concept (marks active=false).
   * Does not physically delete from Firestore.
   */
  function forget(conceptKey) {
    var uid = _uid();
    var item = _map[conceptKey];
    if (!item) return;
    item.active    = false;
    item.updatedAt = Date.now();
    if (uid && item.id) {
      var ref = _conceptsRef(uid);
      if (ref) ref.doc(item.id).update({ active: false }).catch(function () {});
    }
  }

  /**
   * getRelated(conceptName)
   * Returns all concepts that have a relationship to/from the given concept name.
   * Matches against concept key or relationships.
   */
  function getRelated(conceptName) {
    if (!conceptName) return [];
    var nameLower = conceptName.toLowerCase();
    var related = [];
    Object.keys(_map).forEach(function (k) {
      var item = _map[k];
      if (!item || !item.active) return;
      // Direct match
      if (item.concept.indexOf(nameLower) !== -1 ||
          (item.value || '').toLowerCase().indexOf(nameLower) !== -1) {
        related.push({
          concept:      item.concept,
          type:         item.type,
          value:        item.value,
          confidence:   item.confidence,
          relationships: item.relationships,
        });
        return;
      }
      // Relationship match
      var hasRel = (item.relationships || []).some(function (r) {
        return (r.from || '').toLowerCase().indexOf(nameLower) !== -1 ||
               (r.to   || '').toLowerCase().indexOf(nameLower) !== -1;
      });
      if (hasRel) {
        related.push({
          concept:      item.concept,
          type:         item.type,
          value:        item.value,
          confidence:   item.confidence,
          relationships: item.relationships,
        });
      }
    });
    // Sort by confidence
    var order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    related.sort(function (a, b) {
      return (order[a.confidence] || 2) - (order[b.confidence] || 2);
    });
    return related;
  }

  /**
   * ensureLoaded(callback)
   * Ensures the in-memory map is populated from Firestore.
   * Safe to call multiple times.
   */
  function ensureLoaded(callback) {
    callback = callback || function () {};
    var uid = _uid();
    if (_loaded || !uid) { callback(); return; }
    _loadFromDB(uid, callback);
  }

  /**
   * listAll()
   * Returns all active brain concepts (for user inspection / testing).
   */
  function listAll() {
    return Object.keys(_map)
      .filter(function (k) { return _map[k] && _map[k].active; })
      .map(function (k) {
        var item = _map[k];
        return {
          concept:      item.concept,
          type:         item.type,
          value:        item.value,
          confidence:   item.confidence,
          count:        item.count,
          relationships: item.relationships,
          id:           item.id || null,
        };
      });
  }

  /**
   * extractConcepts(text, projectName)
   * Public extraction entry point — for testing.
   */
  function extractConcepts(text, projectName) {
    return _extractConcepts(text, projectName);
  }

  /**
   * store(item)
   * Direct-inject a pre-extracted concept item (from external extractors).
   * item = { concept, type, value, relationships, claimType, provenance, sourceConvId }
   * Used by SRKnowledgeLearner to store concepts that the brain's own extractors
   * cannot derive from raw text (e.g., general definitions, fictional world claims).
   * Fire-and-forget.
   */
  function store(item) {
    if (!_isEnabled()) return;
    if (!item || !item.concept || !item.value) return;
    if (_isSensitive(item.value)) return;

    var uid = _uid();

    // Truncate value to safe length
    var safeItem = {
      concept:      item.concept.substring(0, 60),
      type:         item.type || CONCEPT_TYPES.TOPIC,
      value:        (item.value || '').substring(0, MAX_VALUE_LEN),
      relationships: (item.relationships || []).slice(0, MAX_REL_PER_CONCEPT),
      isCorrection:  !!item.isCorrection,
      correctionValue: item.correctionValue || null,
      sourceConvId: item.sourceConvId || null,
    };

    if (!_loaded) {
      if (uid) {
        _pending.push({ _preExtracted: safeItem });
        _loadFromDB(uid, function () { _flushPending(uid); });
      } else {
        _loaded = true;
        _doLearnPreExtracted(null, [safeItem]);
      }
      return;
    }

    _doLearnPreExtracted(uid, [safeItem]);
  }

  /**
   * _doLearnPreExtracted(uid, items)
   * Stores pre-extracted items directly (bypasses re-extraction).
   */
  function _doLearnPreExtracted(uid, items) {
    (items || []).forEach(function (item) {
      if (!item || !item.concept) return;
      var key      = item.concept;
      var existing = _map[key];

      if (existing && existing.active) {
        // Reinforce
        existing.count      = (existing.count || 1) + 1;
        existing.confidence = _calcConfidence(existing.count);
        existing.updatedAt  = Date.now();
        // Merge new relationships
        (item.relationships || []).forEach(function (rel) {
          var already = existing.relationships.some(function (r) {
            return r.from === rel.from && r.relation === rel.relation && r.to === rel.to;
          });
          if (!already && existing.relationships.length < MAX_REL_PER_CONCEPT) {
            existing.relationships.push(rel);
          }
        });
        _persistConcept(uid, existing);
      } else {
        var newItem = {
          id:            null,
          concept:       key,
          type:          item.type || CONCEPT_TYPES.TOPIC,
          value:         (item.value || '').substring(0, MAX_VALUE_LEN),
          confidence:    'LOW',
          count:         1,
          relationships: (item.relationships || []).slice(0, MAX_REL_PER_CONCEPT),
          active:        true,
          supersededBy:  null,
          sourceConvId:  item.sourceConvId || null,
          createdAt:     Date.now(),
          updatedAt:     Date.now(),
        };
        _map[key] = newItem;
        _persistConcept(uid, newItem);
        _pruneIfNeeded(uid);
      }
    });
  }

  /**
   * destroy()
   * Clears in-memory state. Does not delete Firestore data.
   */
  function destroy() {
    _map     = {};
    _loaded  = false;
    _pending = [];
    _ready   = false;
  }

  /**
   * resetForFreshSession()
   * Clears in-memory cache so next retrieve/learn forces a DB reload.
   * Used to simulate a "fresh session" in tests.
   */
  function resetForFreshSession() {
    _map    = {};
    _loaded = false;
    _pending = [];
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.SRAdaptiveBrain
  ───────────────────────────────────────────────────────────────*/
  global.SRAdaptiveBrain = {
    build:    BUILD_ID,
    CONCEPT_TYPES: CONCEPT_TYPES,

    // Generic model-independent interfaces
    learn:           learn,
    store:           store,         // direct-inject pre-extracted items
    retrieve:        retrieve,
    correct:         correct,
    reinforce:       reinforce,
    forget:          forget,
    getRelated:      getRelated,

    // Management
    ensureLoaded:    ensureLoaded,
    listAll:         listAll,
    extractConcepts: extractConcepts,
    resetForFreshSession: resetForFreshSession,
    _resetForTest:   resetForFreshSession,  // alias for test environments
    destroy:         destroy,

    // Expose internals for testing
    _isSensitive:    _isSensitive,
    _isFiller:       _isFiller,
    _calcConfidence: _calcConfidence,
    _map:            _map,
  };

})(typeof window !== 'undefined' ? window : global);
