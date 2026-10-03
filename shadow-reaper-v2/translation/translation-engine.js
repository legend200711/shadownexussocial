/**
 * shadow-reaper-v2/translation/translation-engine.js
 * Shadow Reaper V2 — Translation Engine
 *
 * Build: SR-V2-TRANSLATION-1
 *
 * Exposes: window.SRTranslation
 *
 * ARCHITECTURE:
 *   Model-independent and provider-independent translation interface.
 *   All methods are stable interfaces. A future local/self-owned multilingual
 *   engine can plug into these interfaces without rebuilding Shadow Reaper.
 *
 * CURRENT STATE:
 *   No hosted translation API (no Google, DeepL, OpenAI, Cloudflare Workers AI).
 *   Basic phrase/word detection for common translations using a local dictionary.
 *   Unknown translations honestly report UNSUPPORTED — never faked.
 *
 * SUPPORTED LANGUAGES (architecture):
 *   English, Spanish, French, German, Portuguese, Italian,
 *   Japanese, Korean, Simplified Chinese, Traditional Chinese.
 *   Architecture is extensible — language list is not hardcoded into logic.
 *
 * INTERFACES:
 *   detectLanguage(text)           → { language, code, confidence }
 *   translate(text, src, tgt)      → { translated, source, target, supported, honest }
 *   getSupportedLanguages()        → [{ name, code }]
 *   setPreferredLanguage(code)     → void
 *   getPreferredLanguage()         → { name, code } | null
 *   translateResponse(text, code)  → string (best-effort; honest about limits)
 *   parseTranslationRequest(text)  → { text, source, target } | null
 *
 * ZERO EXTERNAL AI CALLS.
 * ZERO HOSTED TRANSLATION API DEPENDENCIES.
 */

(function (global) {
  'use strict';

  var BUILD_ID = 'SR-V2-TRANSLATION-1';
  var PREF_KEY = 'srTranslationPreferredLanguage';

  /* ─────────────────────────────────────────────────────────────
     SUPPORTED LANGUAGE REGISTRY
     Extensible — add entries here to extend language support.
  ───────────────────────────────────────────────────────────────*/
  var LANGUAGES = [
    { name: 'English',            code: 'en',    aliases: ['english', 'en'] },
    { name: 'Spanish',            code: 'es',    aliases: ['spanish', 'español', 'espanol', 'es', 'castellano'] },
    { name: 'French',             code: 'fr',    aliases: ['french', 'français', 'francais', 'fr'] },
    { name: 'German',             code: 'de',    aliases: ['german', 'deutsch', 'de'] },
    { name: 'Portuguese',         code: 'pt',    aliases: ['portuguese', 'português', 'portugues', 'pt'] },
    { name: 'Italian',            code: 'it',    aliases: ['italian', 'italiano', 'it'] },
    { name: 'Japanese',           code: 'ja',    aliases: ['japanese', '日本語', 'ja', 'nihongo'] },
    { name: 'Korean',             code: 'ko',    aliases: ['korean', '한국어', 'ko', 'hangul'] },
    { name: 'Simplified Chinese', code: 'zh-cn', aliases: ['chinese', 'simplified chinese', '中文', 'mandarin', 'zh-cn', 'zh', 'chinese simplified'] },
    { name: 'Traditional Chinese',code: 'zh-tw', aliases: ['traditional chinese', '繁體中文', 'zh-tw', 'chinese traditional'] },
  ];

  /* ─────────────────────────────────────────────────────────────
     BASIC LOCAL PHRASE DICTIONARY
     Small vocabulary for common translations (not a full engine).
     Keyed as phraseMap[sourceLang][phrase] = { [targetLang]: translation }
  ───────────────────────────────────────────────────────────────*/
  var PHRASE_MAP = {
    en: {
      'hello':          { es: 'hola', fr: 'bonjour', de: 'hallo', pt: 'olá', it: 'ciao', ja: 'こんにちは', ko: '안녕하세요', 'zh-cn': '你好', 'zh-tw': '你好' },
      'goodbye':        { es: 'adiós', fr: 'au revoir', de: 'auf wiedersehen', pt: 'tchau', it: 'arrivederci', ja: 'さようなら', ko: '안녕히 가세요', 'zh-cn': '再见', 'zh-tw': '再見' },
      'thank you':      { es: 'gracias', fr: 'merci', de: 'danke', pt: 'obrigado', it: 'grazie', ja: 'ありがとう', ko: '감사합니다', 'zh-cn': '谢谢', 'zh-tw': '謝謝' },
      'thanks':         { es: 'gracias', fr: 'merci', de: 'danke', pt: 'obrigado', it: 'grazie', ja: 'ありがとう', ko: '감사합니다', 'zh-cn': '谢谢', 'zh-tw': '謝謝' },
      'yes':            { es: 'sí', fr: 'oui', de: 'ja', pt: 'sim', it: 'sì', ja: 'はい', ko: '네', 'zh-cn': '是', 'zh-tw': '是' },
      'no':             { es: 'no', fr: 'non', de: 'nein', pt: 'não', it: 'no', ja: 'いいえ', ko: '아니요', 'zh-cn': '不', 'zh-tw': '不' },
      'good morning':   { es: 'buenos días', fr: 'bonjour', de: 'guten morgen', pt: 'bom dia', it: 'buongiorno', ja: 'おはようございます', ko: '좋은 아침이에요', 'zh-cn': '早上好', 'zh-tw': '早上好' },
      'good night':     { es: 'buenas noches', fr: 'bonne nuit', de: 'gute nacht', pt: 'boa noite', it: 'buonanotte', ja: 'おやすみなさい', ko: '잘 자요', 'zh-cn': '晚安', 'zh-tw': '晚安' },
      'how are you':    { es: '¿cómo estás?', fr: 'comment allez-vous?', de: 'wie geht es dir?', pt: 'como você está?', it: 'come stai?', ja: 'お元気ですか？', ko: '어떻게 지내세요?', 'zh-cn': '你好吗？', 'zh-tw': '你好嗎？' },
      'my name is':     { es: 'me llamo', fr: 'je m\'appelle', de: 'ich heiße', pt: 'meu nome é', it: 'mi chiamo', ja: '私の名前は', ko: '제 이름은', 'zh-cn': '我叫', 'zh-tw': '我叫' },
      'i love you':     { es: 'te amo', fr: 'je t\'aime', de: 'ich liebe dich', pt: 'eu te amo', it: 'ti amo', ja: '愛してる', ko: '사랑해', 'zh-cn': '我爱你', 'zh-tw': '我愛你' },
      'please':         { es: 'por favor', fr: 's\'il vous plaît', de: 'bitte', pt: 'por favor', it: 'per favore', ja: 'お願いします', ko: '부탁합니다', 'zh-cn': '请', 'zh-tw': '請' },
      'sorry':          { es: 'lo siento', fr: 'désolé', de: 'es tut mir leid', pt: 'desculpe', it: 'mi dispiace', ja: 'ごめんなさい', ko: '죄송합니다', 'zh-cn': '对不起', 'zh-tw': '對不起' },
      'water':          { es: 'agua', fr: 'eau', de: 'wasser', pt: 'água', it: 'acqua', ja: '水', ko: '물', 'zh-cn': '水', 'zh-tw': '水' },
      'help':           { es: 'ayuda', fr: 'aide', de: 'hilfe', pt: 'ajuda', it: 'aiuto', ja: '助けて', ko: '도와주세요', 'zh-cn': '帮助', 'zh-tw': '幫助' },
      'where is':       { es: '¿dónde está', fr: 'où est', de: 'wo ist', pt: 'onde está', it: 'dove si trova', ja: 'どこですか', ko: '어디에 있나요', 'zh-cn': '在哪里', 'zh-tw': '在哪裡' },
      'what time is it':{ es: '¿qué hora es?', fr: 'quelle heure est-il?', de: 'wie spät ist es?', pt: 'que horas são?', it: 'che ore sono?', ja: '何時ですか？', ko: '지금 몇 시예요?', 'zh-cn': '现在几点？', 'zh-tw': '現在幾點？' },
    },
    es: {
      'hola':           { en: 'hello', fr: 'bonjour', de: 'hallo' },
      'gracias':        { en: 'thank you', fr: 'merci', de: 'danke' },
      'adios':          { en: 'goodbye', fr: 'au revoir', de: 'auf wiedersehen' },
    },
    fr: {
      'bonjour':        { en: 'hello', es: 'hola', de: 'hallo' },
      'merci':          { en: 'thank you', es: 'gracias', de: 'danke' },
    },
    de: {
      'hallo':          { en: 'hello', es: 'hola', fr: 'bonjour' },
      'danke':          { en: 'thank you', es: 'gracias', fr: 'merci' },
    },
    ja: {
      'こんにちは':       { en: 'hello', es: 'hola', fr: 'bonjour' },
      'ありがとう':       { en: 'thank you', es: 'gracias', fr: 'merci' },
    },
    ko: {
      '안녕하세요':       { en: 'hello', es: 'hola', fr: 'bonjour' },
      '감사합니다':       { en: 'thank you', es: 'gracias', fr: 'merci' },
    },
  };

  /* ─────────────────────────────────────────────────────────────
     LANGUAGE DETECTION
     Basic script/keyword detection — not a full NLP detector.
  ───────────────────────────────────────────────────────────────*/
  function detectLanguage(text) {
    if (!text) return { language: 'Unknown', code: null, confidence: 'NONE' };
    var t = text.trim();

    // CJK detection by Unicode range
    if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(t)) {
      // Japanese (Hiragana/Katakana dominant) vs Chinese
      if (/[\u3040-\u309F\u30A0-\u30FF]/.test(t)) {
        return { language: 'Japanese', code: 'ja', confidence: 'HIGH' };
      }
      return { language: 'Simplified Chinese', code: 'zh-cn', confidence: 'MEDIUM' };
    }

    // Korean
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(t)) {
      return { language: 'Korean', code: 'ko', confidence: 'HIGH' };
    }

    // Latin-script language detection by common words
    var lower = t.toLowerCase();
    var scores = { en: 0, es: 0, fr: 0, de: 0, pt: 0, it: 0 };

    var EN_MARKERS  = /\b(the|and|is|are|was|were|have|has|this|that|with|for|from)\b/g;
    var ES_MARKERS  = /\b(el|la|los|las|de|en|que|con|una|por|para|esto|esta)\b/g;
    var FR_MARKERS  = /\b(le|la|les|de|du|et|un|une|des|dans|avec|est|pour|sur|que)\b/g;
    var DE_MARKERS  = /\b(der|die|das|die|und|ist|mit|für|von|dem|den|ein|eine|nicht)\b/g;
    var PT_MARKERS  = /\b(o|a|os|as|de|em|que|com|uma|por|para|este|esta|são|tem)\b/g;
    var IT_MARKERS  = /\b(il|la|i|le|di|in|che|con|una|per|questo|questa|è|sono)\b/g;

    var count = function (re, s) { var m = s.match(re); return m ? m.length : 0; };

    scores.en = count(EN_MARKERS, lower);
    scores.es = count(ES_MARKERS, lower);
    scores.fr = count(FR_MARKERS, lower);
    scores.de = count(DE_MARKERS, lower);
    scores.pt = count(PT_MARKERS, lower);
    scores.it = count(IT_MARKERS, lower);

    var best = null;
    var bestScore = 0;
    var keys = Object.keys(scores);
    for (var i = 0; i < keys.length; i++) {
      if (scores[keys[i]] > bestScore) {
        bestScore = scores[keys[i]];
        best = keys[i];
      }
    }

    if (!best || bestScore < 1) {
      return { language: 'English', code: 'en', confidence: 'LOW' };
    }

    var lang = _findLanguage(best);
    return {
      language:   lang ? lang.name : 'English',
      code:       best,
      confidence: bestScore >= 3 ? 'HIGH' : 'MEDIUM',
    };
  }

  /* ─────────────────────────────────────────────────────────────
     LANGUAGE LOOKUP
  ───────────────────────────────────────────────────────────────*/
  function _findLanguage(codeOrAlias) {
    if (!codeOrAlias) return null;
    var q = codeOrAlias.toLowerCase().trim();
    for (var i = 0; i < LANGUAGES.length; i++) {
      if (LANGUAGES[i].code === q) return LANGUAGES[i];
      for (var j = 0; j < LANGUAGES[i].aliases.length; j++) {
        if (LANGUAGES[i].aliases[j] === q) return LANGUAGES[i];
      }
    }
    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     TRANSLATE
     Attempts dictionary lookup. Reports UNSUPPORTED honestly.
     NEVER fakes a translation.
  ───────────────────────────────────────────────────────────────*/
  function translate(text, sourceCode, targetCode) {
    if (!text || !targetCode) {
      return { translated: null, source: sourceCode || 'unknown', target: targetCode || 'unknown', supported: false, honest: true, reason: 'MISSING_INPUT' };
    }

    var srcLang = _findLanguage(sourceCode || 'en');
    var tgtLang = _findLanguage(targetCode);

    if (!tgtLang) {
      return { translated: null, source: sourceCode, target: targetCode, supported: false, honest: true, reason: 'UNKNOWN_TARGET_LANGUAGE' };
    }

    if (srcLang && srcLang.code === tgtLang.code) {
      return { translated: text, source: srcLang.code, target: tgtLang.code, supported: true, honest: true, reason: 'SAME_LANGUAGE' };
    }

    var srcCode = srcLang ? srcLang.code : 'en';
    var tgtCode = tgtLang.code;

    var phrasebook = PHRASE_MAP[srcCode] || {};
    var lower = text.trim().toLowerCase().replace(/[¿¡?!.,;:]+$/, '').replace(/^[¿¡]/, '');

    if (phrasebook[lower] && phrasebook[lower][tgtCode]) {
      return {
        translated:    phrasebook[lower][tgtCode],
        source:        srcCode,
        target:        tgtCode,
        targetName:    tgtLang.name,
        supported:     true,
        honest:        true,
        reason:        'DICTIONARY_MATCH',
      };
    }

    // Check with common suffix/prefix normalizations
    var words = lower.split(/\s+/);
    if (words.length === 1 && phrasebook[words[0]] && phrasebook[words[0]][tgtCode]) {
      return {
        translated:    phrasebook[words[0]][tgtCode],
        source:        srcCode,
        target:        tgtCode,
        targetName:    tgtLang.name,
        supported:     true,
        honest:        true,
        reason:        'DICTIONARY_MATCH',
      };
    }

    // Unsupported — honest report, never fake
    return {
      translated:    null,
      source:        srcCode,
      target:        tgtCode,
      targetName:    tgtLang.name,
      supported:     false,
      honest:        true,
      reason:        'NOT_IN_LOCAL_DICTIONARY',
      message:       'My local translation vocabulary does not include that phrase. A full translation engine would be needed for this.',
    };
  }

  /* ─────────────────────────────────────────────────────────────
     GET SUPPORTED LANGUAGES
  ───────────────────────────────────────────────────────────────*/
  function getSupportedLanguages() {
    return LANGUAGES.map(function (l) { return { name: l.name, code: l.code }; });
  }

  /* ─────────────────────────────────────────────────────────────
     PREFERRED LANGUAGE
  ───────────────────────────────────────────────────────────────*/
  function setPreferredLanguage(codeOrName) {
    var lang = _findLanguage(codeOrName);
    if (!lang) return false;
    try {
      global.localStorage.setItem(PREF_KEY, lang.code);
    } catch (_) {}
    return true;
  }

  function getPreferredLanguage() {
    try {
      var stored = global.localStorage.getItem(PREF_KEY);
      if (stored) return _findLanguage(stored);
    } catch (_) {}
    return null;
  }

  function clearPreferredLanguage() {
    try { global.localStorage.removeItem(PREF_KEY); } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────
     TRANSLATE RESPONSE
     Best-effort — reports honestly if not possible.
  ───────────────────────────────────────────────────────────────*/
  function translateResponse(text, targetCode) {
    if (!targetCode) return text;
    var result = translate(text, 'en', targetCode);
    if (result.supported) return result.translated;
    return null; // caller must handle null (report unsupported)
  }

  /* ─────────────────────────────────────────────────────────────
     PARSE TRANSLATION REQUEST
     Parses user messages like:
       "translate hello to Spanish"
       "translate this: bonjour to English"
       "what does <phrase> mean in English?"
       "how do you say hello in French?"
       "answer me in Korean"
       "speak to me in Spanish"
  ───────────────────────────────────────────────────────────────*/
  function parseTranslationRequest(text) {
    if (!text) return null;
    var t = text.trim();

    // "translate X to Y" / "translate X into Y"
    var m1 = t.match(/\btranslate\s+["']?(.{1,100}?)["']?\s+(?:to|into)\s+([a-záéíóúàèìòùäöüñçêîôâüß\w\s-]+?)(?:\s*[.?!]|$)/i);
    if (m1) {
      var tgt1 = _findLanguage(m1[2].trim());
      if (tgt1) {
        var src1 = detectLanguage(m1[1].trim());
        return { text: m1[1].trim(), source: src1 ? src1.code : 'en', target: tgt1.code, targetName: tgt1.name, intent: 'TRANSLATE' };
      }
    }

    // "how do you say X in Y"
    var m2 = t.match(/how do you say\s+["']?(.{1,80}?)["']?\s+in\s+([a-záéíóúàèìòùäöüñçêîôâüß\w\s-]+?)(?:\s*[.?!]|$)/i);
    if (m2) {
      var tgt2 = _findLanguage(m2[2].trim());
      if (tgt2) {
        return { text: m2[1].trim(), source: 'en', target: tgt2.code, targetName: tgt2.name, intent: 'TRANSLATE' };
      }
    }

    // "what does X mean in Spanish?" — only fire when a specific target language is named.
    // "what does X mean?" without a language is a WORD_DEFINITION request, NOT translation.
    var m3 = t.match(/what does\s+["']?(.{1,80}?)["']?\s+mean\s+in\s+([a-záéíóúàèìòùäöüñçêîôâüß\w\s-]+?)(?:\s*[.?!]|$)/i);
    if (m3) {
      var tgt3 = _findLanguage(m3[2].trim());
      if (tgt3) {
        return { text: m3[1].trim(), source: null, target: tgt3.code, targetName: tgt3.name, intent: 'TRANSLATE' };
      }
    }

    // "answer me in X" / "speak to me in X" / "respond in X"
    var m4 = t.match(/\b(?:answer me|speak to me|respond|reply|talk to me)\s+in\s+([a-záéíóúàèìòùäöüñçêîôâüß\w\s-]+?)(?:\s*[.?!]|$)/i);
    if (m4) {
      var tgt4 = _findLanguage(m4[1].trim());
      if (tgt4) {
        return { text: null, source: 'en', target: tgt4.code, targetName: tgt4.name, intent: 'SET_LANGUAGE' };
      }
    }

    // "translate this to X" (when followed by a separate message)
    var m5 = t.match(/^\s*translate\s+(?:this|it)\s+(?:to|into)\s+([a-záéíóúàèìòùäöüñçêîôâüß\w\s-]+?)(?:\s*[.?!]|$)/i);
    if (m5) {
      var tgt5 = _findLanguage(m5[1].trim());
      if (tgt5) {
        return { text: null, source: 'en', target: tgt5.code, targetName: tgt5.name, intent: 'SET_LANGUAGE' };
      }
    }

    return null;
  }

  /* ─────────────────────────────────────────────────────────────
     COMPOSE TRANSLATION RESPONSE
     Formats a natural response for a translation result.
  ───────────────────────────────────────────────────────────────*/
  function composeTranslationResponse(result, originalText, targetName) {
    if (!result) return 'Translation request not understood.';

    if (result.intent === 'SET_LANGUAGE') {
      return 'I\'ll try to respond in ' + (result.targetName || targetName) + '. Note that my local translation vocabulary is limited — for full multilingual support a translation engine would be needed.';
    }

    if (!result.supported) {
      return 'I can detect the language and recognize the structure of that request, but my local vocabulary doesn\'t include that phrase. A full translation engine would be needed for this translation. I won\'t guess.';
    }

    var tgtLang = result.targetName || targetName || result.target;
    return '"' + result.translated + '" — that\'s "' + (originalText || result.text || '...') + '" in ' + tgtLang + '.';
  }

  /* ─────────────────────────────────────────────────────────────
     EXPOSE — window.SRTranslation
  ───────────────────────────────────────────────────────────────*/
  global.SRTranslation = {
    build:                    BUILD_ID,
    detectLanguage:           detectLanguage,
    translate:                translate,
    getSupportedLanguages:    getSupportedLanguages,
    setPreferredLanguage:     setPreferredLanguage,
    getPreferredLanguage:     getPreferredLanguage,
    clearPreferredLanguage:   clearPreferredLanguage,
    translateResponse:        translateResponse,
    parseTranslationRequest:  parseTranslationRequest,
    composeTranslationResponse: composeTranslationResponse,
  };

})(typeof window !== 'undefined' ? window : global);
