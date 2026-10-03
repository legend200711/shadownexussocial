/**
 * shadow-reaper-v2/core/local-model.js
 * Shadow Reaper V2 — Local Language Model Engine
 *
 * Build: SR-V2-STAGE3A
 *
 * STAGE 3A CHANGES:
 *  - Single deterministic model (no auto-upgrade between models)
 *  - WEBLLM_CDN import verified at load time; exposes diagnostic trace
 *  - AbortError / empty pipeline → FAILED with error code MODEL_LOAD_ABORTED_OR_EMPTY
 *  - ModelNotLoadedError → FAILED with error code MODEL_NOT_LOADED
 *  - Full diagnostic trace exposed via getDiagnostics()
 *  - No silent fallback masking — inference errors propagate as errors
 *  - Readiness test uses engine.chat.completions.create() with real prompt
 *  - No auto-load on startup; manual load only via loadModel()
 *
 * MODEL:
 *  SmolLM2-360M-Instruct-q4f16_1-MLC  (single hardcoded; no auto-switch)
 *
 * Zero Workers AI calls. Zero env.AI.run(). Zero OpenAI. Zero hosted AI.
 * All inference runs locally in the browser via WebLLM (web-llm npm CDN).
 */

(function (global) {
  'use strict';

  // ─── Model states ────────────────────────────────────────────────────────────

  const MODEL_STATE = {
    UNINITIALIZED: 'UNINITIALIZED',
    LOADING:       'LOADING',
    VERIFYING:     'VERIFYING',
    READY:         'READY',
    FAILED:        'FAILED',
  };

  // ─── Error codes ─────────────────────────────────────────────────────────────

  const ERROR_CODES = {
    IMPORT_FAILED:                  'IMPORT_FAILED',
    MODEL_NOT_IN_REGISTRY:          'MODEL_NOT_IN_REGISTRY',
    ENGINE_CREATE_FAILED:           'ENGINE_CREATE_FAILED',
    MODEL_LOAD_ABORTED_OR_EMPTY:    'MODEL_LOAD_ABORTED_OR_EMPTY',
    MODEL_NOT_LOADED:               'MODEL_NOT_LOADED',
    VERIFY_EMPTY_RESPONSE:          'VERIFY_EMPTY_RESPONSE',
    VERIFY_INFERENCE_FAILED:        'VERIFY_INFERENCE_FAILED',
    INFERENCE_FAILED:               'INFERENCE_FAILED',
    WEBGPU_UNAVAILABLE:             'WEBGPU_UNAVAILABLE',
    GPU_ADAPTER_FAILED:             'GPU_ADAPTER_FAILED',
    UNKNOWN_LOAD_ERROR:             'UNKNOWN_LOAD_ERROR',
  };

  // ─── Configuration ───────────────────────────────────────────────────────────

  // STAGE 3A: ONE deterministic model only. No auto-switching.
  // ID verified against WebLLM model registry before use.
  const FIXED_MODEL_ID = 'SmolLM2-360M-Instruct-q4f16_1-MLC';

  // Max tokens for normal generation
  const MAX_GEN_TOKENS = 256;

  // Max tokens for the verification inference test
  const VERIFY_MAX_TOKENS = 40;

  // WebLLM CDN
  const WEBLLM_CDN = 'https://esm.run/@mlc-ai/web-llm';

  // ─── Shadow Reaper system prompt ─────────────────────────────────────────────

  const SYSTEM_PROMPT = [
    'You are Shadow Reaper, an AI assistant with a calm, direct, and supportive personality.',
    'Your tone is grounded, occasionally dark or cinematic when it feels natural, but never theatrical.',
    'You are loyal and honest. You do not pretend to have human emotions, physical experiences, or a body.',
    'You are capable of ordinary conversation — jokes, brainstorming, emotional support, creative ideas.',
    'You do not reduce every response to a single platform or topic. Respond naturally to what the user says.',
    'Keep responses concise but complete. Do not pad responses. Do not use bullet points unless asked.',
    'You are an AI. When asked if you are human, say you are not.',
  ].join(' ');

  // ─── Diagnostic trace ────────────────────────────────────────────────────────
  // Every step of the load sequence is recorded here for the diagnostics panel.

  var _diag = {
    // Import
    webllmImportStatus:       'NOT_ATTEMPTED', // NOT_ATTEMPTED / OK / FAILED
    webllmVersion:            null,
    webllmCDN:                WEBLLM_CDN,
    createMLCEngineExists:    null,
    modelRegistryAccessible:  null,

    // GPU
    webgpuAvailable:          null,
    webgpuAdapterAvailable:   null,
    gpuDeviceObtained:        null,

    // Model selection
    modelIdRequested:         FIXED_MODEL_ID,
    modelIdActuallyLoaded:    null,
    modelExistsInRegistry:    null,

    // Engine
    engineApi:                null,  // 'CreateMLCEngine' | 'new MLCEngine + reload' | 'UNKNOWN'
    engineCreated:            null,

    // Load sequence
    reloadStarted:            null,
    reloadReturned:           null,
    lastDownloadProgress:     null,
    downloadStarted:          null,
    downloadCompleted:        null,
    modelCacheStatus:         null,

    // Pipeline check
    pipelineCheckStarted:     null,
    pipelineState:            null,

    // Verify
    verifyStarted:            null,
    verifyResult:             null,
    verifyInferenceText:      null,

    // Errors
    lastErrorName:            null,
    lastErrorMessage:         null,
    lastErrorStack:           null,
    lastFailedOperation:      null,
    lastInferenceError:       null,
    errorCode:                null,
    modelNotLoadedError:      null,  // true/false
    abortError:               null,  // true/false

    // Final
    responseSource:           null,
  };

  // ─── Internal state ──────────────────────────────────────────────────────────

  var _state       = MODEL_STATE.UNINITIALIZED;
  var _modelId     = null;
  var _engine      = null;
  var _loadError   = null;
  var _loadPct     = 0;
  var _loadingPromise = null;  // guard against multiple simultaneous loads
  var _stateListeners = [];

  // ─── State management ────────────────────────────────────────────────────────

  function _setState(newState, pct, error) {
    _state = newState;
    if (pct !== undefined) _loadPct = pct;
    if (error !== undefined) _loadError = error;
    _stateListeners.forEach(function (fn) {
      try { fn(_state, _loadPct, _loadError); } catch (_) {}
    });
  }

  function _recordError(err, operation) {
    var name    = err && err.name    ? err.name    : 'UnknownError';
    var message = err && err.message ? err.message : String(err);
    var stack   = err && err.stack   ? err.stack   : null;

    _diag.lastErrorName      = name;
    _diag.lastErrorMessage   = message;
    _diag.lastErrorStack     = stack;
    _diag.lastFailedOperation = operation || null;

    // Classify specific error types
    var lc = message.toLowerCase();
    if (name === 'AbortError' || lc.includes('aborted') || lc.includes('abort')) {
      _diag.abortError = true;
    }
    if (name === 'ModelNotLoadedError' ||
        lc.includes('not loaded') ||
        lc.includes('modelnotloaded') ||
        lc.includes('engine not initialized')) {
      _diag.modelNotLoadedError = true;
    }

    console.error('[SRLocalModel] Error in "' + (operation || '?') + '":', name, message);
  }

  // ─── WebGPU probe ─────────────────────────────────────────────────────────────

  function _probeWebGPU() {
    _diag.webgpuAvailable = !!(global.navigator && global.navigator.gpu);
    return Promise.resolve().then(function () {
      if (!_diag.webgpuAvailable) {
        _diag.webgpuAdapterAvailable = false;
        _diag.gpuDeviceObtained      = false;
        return;
      }
      return global.navigator.gpu.requestAdapter().then(function (adapter) {
        _diag.webgpuAdapterAvailable = !!adapter;
        // We don't request a device here to avoid holding the GPU prematurely.
      }).catch(function () {
        _diag.webgpuAdapterAvailable = false;
      });
    });
  }

  // ─── WebLLM import ───────────────────────────────────────────────────────────

  var _webllmImportPromise = null;
  var _webllmModule        = null;

  function _importWebLLM() {
    if (_webllmImportPromise) return _webllmImportPromise;

    _diag.webllmImportStatus = 'IN_PROGRESS';
    console.log('[SRLocalModel] Importing WebLLM from:', WEBLLM_CDN);

    _webllmImportPromise = import(WEBLLM_CDN)
      .then(function (mod) {
        _webllmModule = mod;
        _diag.webllmImportStatus    = 'OK';
        _diag.createMLCEngineExists = !!(mod.MLCEngine || mod.CreateMLCEngine);

        // Attempt to read version from the module
        try {
          _diag.webllmVersion = mod.version || mod.VERSION || null;
          if (!_diag.webllmVersion && mod.MLCEngine && mod.MLCEngine.version) {
            _diag.webllmVersion = mod.MLCEngine.version;
          }
        } catch (_) {}

        // Check if model registry is accessible
        try {
          var reg = mod.prebuiltAppConfig || mod.prebuiltList || mod.modelList || null;
          _diag.modelRegistryAccessible = !!reg;
        } catch (_) {
          _diag.modelRegistryAccessible = false;
        }

        console.log('[SRLocalModel] WebLLM imported OK. Version:', _diag.webllmVersion,
                    'MLCEngine:', _diag.createMLCEngineExists);
        return mod;
      })
      .catch(function (err) {
        _webllmImportPromise = null;
        _diag.webllmImportStatus    = 'FAILED';
        _diag.createMLCEngineExists = false;
        _diag.modelRegistryAccessible = false;
        _recordError(err, 'IMPORT_WEBLLM');
        _diag.errorCode = ERROR_CODES.IMPORT_FAILED;
        throw err;
      });

    return _webllmImportPromise;
  }

  // ─── Registry check ───────────────────────────────────────────────────────────

  function _checkModelInRegistry(mod, modelId) {
    try {
      // WebLLM exposes prebuiltAppConfig.model_list or similar
      var registry = null;
      if (mod.prebuiltAppConfig && Array.isArray(mod.prebuiltAppConfig.model_list)) {
        registry = mod.prebuiltAppConfig.model_list;
      } else if (Array.isArray(mod.prebuiltList)) {
        registry = mod.prebuiltList;
      } else if (Array.isArray(mod.modelList)) {
        registry = mod.modelList;
      }

      if (!registry) {
        // Can't verify — treat as potentially ok but log
        _diag.modelExistsInRegistry = null; // unknown
        console.warn('[SRLocalModel] Cannot access model registry for verification.');
        return;
      }

      // registry entries may be objects with model_id or strings
      var found = registry.some(function (entry) {
        var id = typeof entry === 'string' ? entry : (entry.model_id || entry.id || '');
        return id === modelId;
      });

      _diag.modelExistsInRegistry = found;
      if (!found) {
        console.warn('[SRLocalModel] Model not found in registry:', modelId);
        console.warn('[SRLocalModel] Available models:', registry.slice(0, 10).map(function (e) {
          return typeof e === 'string' ? e : (e.model_id || e.id || JSON.stringify(e));
        }).join(', '));
      } else {
        console.log('[SRLocalModel] Model confirmed in registry:', modelId);
      }
    } catch (e) {
      _diag.modelExistsInRegistry = null;
      console.warn('[SRLocalModel] Registry check error:', e && e.message);
    }
  }

  // ─── Load the model ───────────────────────────────────────────────────────────

  /**
   * loadModel() → Promise<void>
   *
   * STAGE 3A: Uses FIXED_MODEL_ID only. No model parameter accepted.
   * Goes through LOADING → VERIFYING → READY (or FAILED).
   * Calling while LOADING/VERIFYING waits for the current attempt.
   * Calling while READY is a no-op.
   * Calling while FAILED retries from scratch.
   */
  function loadModel() {
    if (_state === MODEL_STATE.READY) return Promise.resolve();

    if (_state === MODEL_STATE.LOADING || _state === MODEL_STATE.VERIFYING) {
      // Already in progress — wait for completion
      return new Promise(function (resolve, reject) {
        var unsub = onStateChange(function (s, _pct, err) {
          if (s === MODEL_STATE.READY)  { unsub(); resolve(); }
          if (s === MODEL_STATE.FAILED) { unsub(); reject(err || new Error('Model failed to load.')); }
        });
      });
    }

    // Clean state for a fresh attempt
    _modelId   = FIXED_MODEL_ID;
    _loadError = null;
    _loadPct   = 0;
    _engine    = null;

    // Reset diagnostic trace for new attempt
    _diag.modelIdRequested      = FIXED_MODEL_ID;
    _diag.modelIdActuallyLoaded = null;
    _diag.engineApi             = null;
    _diag.engineCreated         = null;
    _diag.reloadStarted         = null;
    _diag.reloadReturned        = null;
    _diag.lastDownloadProgress  = null;
    _diag.downloadStarted       = null;
    _diag.downloadCompleted     = null;
    _diag.modelCacheStatus      = null;
    _diag.pipelineCheckStarted  = null;
    _diag.pipelineState         = null;
    _diag.verifyStarted         = null;
    _diag.verifyResult          = null;
    _diag.verifyInferenceText   = null;
    _diag.lastErrorName         = null;
    _diag.lastErrorMessage      = null;
    _diag.lastErrorStack        = null;
    _diag.lastFailedOperation   = null;
    _diag.lastInferenceError    = null;
    _diag.errorCode             = null;
    _diag.modelNotLoadedError   = null;
    _diag.abortError            = null;

    _setState(MODEL_STATE.LOADING, 0, null);

    // ── STEP 1: Probe WebGPU ─────────────────────────────────────────────────
    _loadingPromise = _probeWebGPU()

    // ── STEP 2: Import WebLLM ────────────────────────────────────────────────
    .then(function () {
      return _importWebLLM();
    })

    // ── STEP 3: Verify model in registry ────────────────────────────────────
    .then(function (mod) {
      _checkModelInRegistry(mod, FIXED_MODEL_ID);
      // If model not in registry we still attempt — it may just not be listed
      return mod;
    })

    // ── STEP 4: Create engine & load ────────────────────────────────────────
    .then(function (mod) {
      // Detect which API is available.
      // WebLLM ≥ 0.2.x exposes CreateMLCEngine (factory function that also loads).
      // Older builds expose MLCEngine class + engine.reload().
      // diag-probe.html surface confirmed CreateMLCEngine is the working path.
      _diag.engineApi = typeof mod.CreateMLCEngine === 'function'
        ? 'CreateMLCEngine'
        : (typeof mod.MLCEngine === 'function' ? 'new MLCEngine + reload' : 'UNKNOWN');
      console.log('[SRLocalModel] Engine API detected:', _diag.engineApi);

      var progressCb = function (report) {
        var pct  = Math.round((report.progress || 0) * 100);
        var text = report.text || '';
        _loadPct = pct;
        _diag.lastDownloadProgress = pct + '% — ' + text;

        if (pct > 0 && !_diag.downloadStarted) {
          _diag.downloadStarted = true;
          console.log('[SRLocalModel] Download started.');
        }

        var lc = text.toLowerCase();
        if (lc.includes('cache')) {
          _diag.modelCacheStatus = 'CACHED';
        } else if (lc.includes('fetch') || lc.includes('download')) {
          _diag.modelCacheStatus = 'DOWNLOADING';
        }

        _setState(MODEL_STATE.LOADING, pct, null);
        console.log('[SRLocalModel] Progress:', pct + '%', text);
      };

      // ── CreateMLCEngine (preferred / newer API) ──────────────────────────
      if (typeof mod.CreateMLCEngine === 'function') {
        _diag.reloadStarted = true;
        console.log('[SRLocalModel] CreateMLCEngine() starting for:', FIXED_MODEL_ID);
        return mod.CreateMLCEngine(FIXED_MODEL_ID, {
          initProgressCallback: progressCb,
        }).then(function (engine) {
          _diag.engineCreated  = true;
          _diag.reloadReturned = true;
          _diag.downloadCompleted  = true;
          _diag.modelIdActuallyLoaded = FIXED_MODEL_ID;
          _engine = engine;
          console.log('[SRLocalModel] CreateMLCEngine() resolved. Entering VERIFYING.');
          _setState(MODEL_STATE.VERIFYING, 100, null);
          _diag.pipelineCheckStarted = true;
          _diag.pipelineState = 'CHECK_SKIPPED_RELY_ON_VERIFY';
          return _verifyModel(engine);
        }).catch(function (e) {
          _diag.engineCreated = (_diag.engineCreated === true); // preserve if already set
          _recordError(e, 'CREATE_MLC_ENGINE');
          if (!_diag.errorCode) {
            var lc2 = (e && e.message ? e.message : '').toLowerCase();
            if (e && e.name === 'AbortError' || lc2.includes('abort')) {
              _diag.errorCode = ERROR_CODES.MODEL_LOAD_ABORTED_OR_EMPTY;
            } else {
              _diag.errorCode = ERROR_CODES.ENGINE_CREATE_FAILED;
            }
          }
          throw e;
        });
      }

      // ── Fallback: new MLCEngine() + reload() (older API) ─────────────────
      var EngineClass = mod.MLCEngine;
      if (!EngineClass) {
        throw new Error('No engine creation API found in WebLLM module (no CreateMLCEngine, no MLCEngine).');
      }
      var engine;
      try {
        engine = new EngineClass();
        _diag.engineCreated = true;
        console.log('[SRLocalModel] MLCEngine instance created (legacy API).');
      } catch (e) {
        _diag.engineCreated = false;
        _diag.errorCode = ERROR_CODES.ENGINE_CREATE_FAILED;
        _recordError(e, 'CREATE_ENGINE');
        throw e;
      }

      if (typeof engine.setInitProgressCallback === 'function') {
        engine.setInitProgressCallback(progressCb);
      }

      return engine;
    })

    // ── STEP 5: Start reload (legacy MLCEngine API only) ─────────────────────
    // NOTE: When CreateMLCEngine is used (STEP 4), this step is skipped because
    // the STEP 4 promise chain fully handles verify and resolves into STEP 8.
    // This .then() only fires for the legacy path where STEP 4 returns the
    // raw engine object rather than a fully-resolved chain.
    .then(function (engine) {
      // If we went through the CreateMLCEngine path, engine is undefined here
      // (the promise chain terminates inside STEP 4). Skip.
      if (engine === undefined) return;

      _diag.reloadStarted = true;
      console.log('[SRLocalModel] reload() starting for:', FIXED_MODEL_ID);

      return engine.reload(FIXED_MODEL_ID).then(function () {
        _diag.reloadReturned = true;
        console.log('[SRLocalModel] reload() returned.');

        // ── STEP 6: Pipeline check ─────────────────────────────────────────
        // reload() returning without throwing does NOT guarantee the model loaded.
        // Detect the AbortError / empty pipeline scenario.
        _diag.pipelineCheckStarted = true;

        var pipelineOk = false;
        try {
          // Check for pipeline/runtimeStatsText existence — available in WebLLM after load
          if (engine.getPipeline && engine.getPipeline()) {
            pipelineOk = true;
            _diag.pipelineState = 'PIPELINE_PRESENT';
          } else if (typeof engine.runtimeStatsText === 'function') {
            // runtimeStatsText() throws if model not loaded in some versions
            engine.runtimeStatsText();
            pipelineOk = true;
            _diag.pipelineState = 'RUNTIME_STATS_OK';
          } else {
            // No direct pipeline check available — rely on verify inference
            pipelineOk = true; // will fail in verify if not loaded
            _diag.pipelineState = 'CHECK_SKIPPED_RELY_ON_VERIFY';
          }
        } catch (pipeErr) {
          pipelineOk = false;
          _diag.pipelineState = 'PIPELINE_CHECK_THREW: ' + (pipeErr && pipeErr.message);
          _diag.abortError = pipeErr && pipeErr.name === 'AbortError';
        }

        if (!pipelineOk) {
          _diag.errorCode = ERROR_CODES.MODEL_LOAD_ABORTED_OR_EMPTY;
          _recordError(
            { name: 'ModelLoadAbortedOrEmpty',
              message: 'reload() returned but pipeline check failed. Possible AbortError during load.',
              stack: null },
            'PIPELINE_CHECK'
          );
          throw new Error('MODEL_LOAD_ABORTED_OR_EMPTY: reload() returned but pipeline verification failed.');
        }

        _diag.downloadCompleted  = true;
        _diag.modelIdActuallyLoaded = FIXED_MODEL_ID;
        _engine = engine;

        console.log('[SRLocalModel] Pipeline check passed. Entering VERIFYING.');
        _setState(MODEL_STATE.VERIFYING, 100, null);

        // ── STEP 7: Verify inference ───────────────────────────────────────
        return _verifyModel(engine);
      });
    })

    // ── STEP 8: READY ────────────────────────────────────────────────────────
    .then(function () {
      _setState(MODEL_STATE.READY, 100, null);
      _diag.responseSource = 'LOCAL_MODEL';
      _loadingPromise = null;
      console.log('[SRLocalModel] Model READY:', _modelId);
    })

    // ── Error handler ────────────────────────────────────────────────────────
    .catch(function (err) {
      _engine = null;
      _loadingPromise = null;

      // Always record the original exception — do not skip if name was already set,
      // because that set happened on a different (earlier) error in the sequence.
      // We want the *final* exception that killed the load to be preserved.
      _recordError(err, _diag.lastFailedOperation || 'LOAD_SEQUENCE');

      if (!_diag.errorCode) {
        // Classify from the error message
        var msg = err && err.message ? err.message : '';
        var lc  = msg.toLowerCase();
        if (lc.includes('model_load_aborted_or_empty') || lc.includes('abort') ||
            (err && err.name === 'AbortError')) {
          _diag.errorCode = ERROR_CODES.MODEL_LOAD_ABORTED_OR_EMPTY;
        } else if (lc.includes('not loaded') || lc.includes('modelnotloaded')) {
          _diag.errorCode = ERROR_CODES.MODEL_NOT_LOADED;
        } else if (lc.includes('import') || _diag.webllmImportStatus === 'FAILED') {
          _diag.errorCode = ERROR_CODES.IMPORT_FAILED;
        } else {
          _diag.errorCode = ERROR_CODES.UNKNOWN_LOAD_ERROR;
        }
      }

      var errMsg = err && err.message ? err.message : String(err);
      _setState(MODEL_STATE.FAILED, _loadPct, errMsg);
      console.error('[SRLocalModel] Load FAILED.',
        '\n  Code:      ', _diag.errorCode,
        '\n  Name:      ', _diag.lastErrorName,
        '\n  Message:   ', _diag.lastErrorMessage,
        '\n  Operation: ', _diag.lastFailedOperation,
        '\n  Stack:     ', _diag.lastErrorStack ? _diag.lastErrorStack.split('\n').slice(0,3).join(' | ') : 'n/a'
      );
      throw err;
    });

    return _loadingPromise;
  }

  // ─── Verification inference ───────────────────────────────────────────────────

  /**
   * Runs a real inference call to confirm the model pipeline is functional.
   * Uses engine.chat.completions.create() — the correct WebLLM inference API.
   * READY state is NOT set unless this produces a non-empty response.
   */
  function _verifyModel(engine) {
    _diag.verifyStarted = true;
    console.log('[SRLocalModel] Running verify inference…');

    var verifyMessages = [
      { role: 'system', content: 'You are a helpful assistant. Be extremely brief.' },
      { role: 'user',   content: 'Respond with exactly one short sentence explaining why the sky appears blue.' },
    ];

    return engine.chat.completions.create({
      messages:    verifyMessages,
      max_tokens:  VERIFY_MAX_TOKENS,
      temperature: 0.0,
    }).then(function (result) {
      var text = _extractText(result);
      _diag.verifyInferenceText = text;
      console.log('[SRLocalModel] Verify inference result:', JSON.stringify(text));

      if (!text || text.trim().length === 0) {
        _diag.verifyResult  = 'FAILED_EMPTY';
        _diag.errorCode     = ERROR_CODES.VERIFY_EMPTY_RESPONSE;
        throw new Error('Verification inference returned empty response. Model pipeline is not functional.');
      }

      _diag.verifyResult = 'PASS';
    }).catch(function (err) {
      if (_diag.verifyResult !== 'PASS') {
        _diag.verifyResult = 'FAILED_EXCEPTION';
        if (!_diag.errorCode) _diag.errorCode = ERROR_CODES.VERIFY_INFERENCE_FAILED;

        var name = err && err.name    ? err.name    : 'UnknownError';
        var msg  = err && err.message ? err.message : String(err);
        var lc   = msg.toLowerCase();

        if (name === 'ModelNotLoadedError' ||
            lc.includes('not loaded') ||
            lc.includes('modelnotloaded') ||
            lc.includes('engine not initialized')) {
          _diag.modelNotLoadedError = true;
          _diag.errorCode = ERROR_CODES.MODEL_NOT_LOADED;
        }
        if (name === 'AbortError' || lc.includes('abort')) {
          _diag.abortError = true;
          _diag.errorCode  = ERROR_CODES.MODEL_LOAD_ABORTED_OR_EMPTY;
        }

        _recordError(err, 'VERIFY_INFERENCE');
      }
      throw err;
    });
  }

  // ─── Text extraction ──────────────────────────────────────────────────────────

  function _extractText(result) {
    try {
      return result.choices[0].message.content || '';
    } catch (_) {
      return '';
    }
  }

  // ─── Context builder ──────────────────────────────────────────────────────────
  //
  // Builds the message array for the local model. Incorporates:
  //   - Project / topic context (from session)
  //   - Personal memory snippets (retrieved, bounded to 3)
  //   - Adaptive learning snippets (bounded to 3)
  //   - Resolved pronoun reference ("it" → last known subject)
  //   - Negation signal (e.g. "don't change the homepage")
  //   - Key concepts from language analysis (bounded to 8)
  //   - Named unknown entities (e.g. "NightGlass")
  //   - Recent conversation turns (bounded to 8)
  //
  // CRITICAL: 113k vocabulary is NEVER injected. Only the distilled analysis
  // of the current message is included — bounded at every step.

  function _buildMessages(userMessage, opts) {
    opts = opts || {};

    var systemParts = [SYSTEM_PROMPT];

    // ── Project / topic context ──────────────────────────────────────────────
    if (opts.projectName) {
      systemParts.push('Current project: the user is working on "' + opts.projectName + '".');
    }
    if (opts.currentTopic) {
      systemParts.push('Current topic: "' + opts.currentTopic + '".');
    }

    // ── Resolved reference ("it" / "that" / "the homepage") ──────────────────
    // This is the most important context for multi-turn continuity.
    // If the user said "Make it darker", resolvedRef = "homepage" (or whatever
    // was most recently mentioned). Include it explicitly so the model knows.
    if (opts.resolvedRef) {
      systemParts.push('Reference context: when the user says "it", "that", or "this", ' +
                       'they are most likely referring to: "' + opts.resolvedRef + '".');
    }

    // ── Negation signal ───────────────────────────────────────────────────────
    // If the language analysis detected negation, signal it explicitly.
    // "Don't change the homepage" must not be treated as "change the homepage".
    if (opts.negation && opts.negation.negated) {
      systemParts.push('Note: the user\'s message contains negation. ' +
                       'Pay attention to what they do NOT want.');
    }

    // ── Key concepts (bounded to 8) ───────────────────────────────────────────
    // Distilled from the language analysis — the 8 most semantically important
    // content words. Helps the model understand topic continuity.
    if (opts.concepts && opts.concepts.length) {
      var topConcepts = opts.concepts.slice(0, 8);
      systemParts.push('Key concepts in current message: ' + topConcepts.join(', ') + '.');
    }

    // ── Unknown named entities ────────────────────────────────────────────────
    // Words not in vocabulary that look like proper nouns / project names.
    // E.g. "NightGlass", "ShadowGlass", custom usernames.
    if (opts.unknownWords && opts.unknownWords.length) {
      var namedEntities = opts.unknownWords
        .filter(function (w) {
          return w.analysis && (w.analysis.type === 'named_entity' || /^[A-Z]/.test(w.word));
        })
        .slice(0, 4)
        .map(function (w) { return '"' + w.word + '"'; });
      if (namedEntities.length) {
        systemParts.push('Unknown proper names / entities in message: ' +
                         namedEntities.join(', ') +
                         '. Treat as project names, usernames, or custom terms.');
      }
    }

    // ── Personal memory (bounded to 3) ────────────────────────────────────────
    if (opts.memorySnippets && opts.memorySnippets.length) {
      var mem = opts.memorySnippets.slice(0, 3).map(function (m) {
        return m.content || m.text || String(m);
      });
      systemParts.push('Remembered about the user: ' + mem.join('; ') + '.');
    }

    // ── Adaptive learning context (bounded to 3) ──────────────────────────────
    if (opts.adaptiveSnippets && opts.adaptiveSnippets.length) {
      var ad = opts.adaptiveSnippets.slice(0, 3).map(function (a) {
        return a.value || a.content || String(a);
      });
      systemParts.push('Learned context from prior conversations: ' + ad.join('; ') + '.');
    }

    var messages = [
      { role: 'system', content: systemParts.join('\n') },
    ];

    // ── Recent conversation turns (bounded to 8 turns = 4 exchanges) ──────────
    if (opts.recentTurns && opts.recentTurns.length) {
      var recent = opts.recentTurns.slice(-8);
      recent.forEach(function (turn) {
        if (turn.role && turn.text) {
          messages.push({ role: turn.role, content: turn.text });
        }
      });
    }

    messages.push({ role: 'user', content: userMessage });
    return messages;
  }

  // ─── Generate ────────────────────────────────────────────────────────────────

  /**
   * generate(userMessage, opts, callback)
   *
   * STAGE 3A: If model fails, callback receives the raw error — no silent fallback.
   * The response engine is responsible for handling the error and reporting source=ERROR.
   *
   * callback(err, text)
   *   err  — Error if inference failed or model not ready; null on success
   *   text — Generated text on success; null on error
   */
  function generate(userMessage, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    callback = callback || function () {};

    if (_state !== MODEL_STATE.READY || !_engine) {
      var notReadyErr = new Error('Local model is not ready. State: ' + _state);
      notReadyErr.name = 'ModelNotReadyError';
      notReadyErr.errorCode = 'MODEL_NOT_READY';
      _diag.lastInferenceError = notReadyErr.message;
      callback(notReadyErr, null);
      return;
    }

    var messages = _buildMessages(userMessage, opts || {});

    _engine.chat.completions.create({
      messages:    messages,
      max_tokens:  MAX_GEN_TOKENS,
      temperature: 0.7,
    })
    .then(function (result) {
      var text = _extractText(result);
      _diag.responseSource = 'LOCAL_MODEL';
      callback(null, text.trim());
    })
    .catch(function (err) {
      var name = err && err.name    ? err.name    : 'UnknownError';
      var msg  = err && err.message ? err.message : String(err);
      var lc   = msg.toLowerCase();

      _diag.lastInferenceError = msg;
      console.error('[SRLocalModel] generate() error:', name, msg);

      // ModelNotLoadedError: explicit capture, mark state as FAILED
      if (name === 'ModelNotLoadedError' ||
          lc.includes('not loaded') ||
          lc.includes('modelnotloaded') ||
          lc.includes('engine not initialized')) {
        _diag.modelNotLoadedError = true;
        _diag.errorCode = ERROR_CODES.MODEL_NOT_LOADED;
        _recordError(err, 'INFERENCE');
        _setState(MODEL_STATE.FAILED, _loadPct, msg);
        _engine = null;
      }

      callback(err, null);
    });
  }

  // ─── State listener ───────────────────────────────────────────────────────────

  function onStateChange(fn) {
    _stateListeners.push(fn);
    return function () {
      _stateListeners = _stateListeners.filter(function (f) { return f !== fn; });
    };
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  function getStatus() {
    return {
      state:     _state,
      modelId:   _modelId,
      loadPct:   _loadPct,
      lastError: _loadError,
      isReady:   _state === MODEL_STATE.READY,
    };
  }

  // ─── Full diagnostics ─────────────────────────────────────────────────────────

  function getDiagnostics() {
    return Object.assign({}, _diag, {
      modelState:           _state,
      modelIdRequested:     FIXED_MODEL_ID,
      modelIdActuallyLoaded: _diag.modelIdActuallyLoaded,
      loadPct:              _loadPct,
      responseSource:       _state === MODEL_STATE.READY ? 'LOCAL_MODEL' : (_loadError ? 'ERROR' : '—'),
    });
  }

  // ─── Destroy ──────────────────────────────────────────────────────────────────

  function destroy() {
    if (_engine && typeof _engine.unload === 'function') {
      try { _engine.unload(); } catch (_) {}
    }
    _engine         = null;
    _loadingPromise = null;
    _stateListeners = [];
    _setState(MODEL_STATE.UNINITIALIZED, 0, null);
  }

  // ─── generateWithMessages ────────────────────────────────────────────────────
  //
  // Called by SRInferenceRuntime when it needs to pass a pre-built messages
  // array directly to the WebLLM engine (avoiding a redundant context rebuild).
  // Skips _buildMessages() — the messages array is already fully prepared.
  //
  // callback(err, text)

  function generateWithMessages(messages, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    callback = callback || function () {};
    opts = opts || {};

    if (_state !== MODEL_STATE.READY || !_engine) {
      var notReadyErr = new Error('Local model is not ready. State: ' + _state);
      notReadyErr.name = 'ModelNotReadyError';
      notReadyErr.errorCode = 'MODEL_NOT_READY';
      _diag.lastInferenceError = notReadyErr.message;
      callback(notReadyErr, null);
      return;
    }

    _engine.chat.completions.create({
      messages:    messages,
      max_tokens:  opts.maxTokens !== undefined ? opts.maxTokens : MAX_GEN_TOKENS,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.7,
    })
    .then(function (result) {
      var text = _extractText(result);
      _diag.responseSource = 'LOCAL_MODEL';
      callback(null, text ? text.trim() : '');
    })
    .catch(function (err) {
      var name = err && err.name    ? err.name    : 'UnknownError';
      var msg  = err && err.message ? err.message : String(err);
      var lc   = msg.toLowerCase();

      _diag.lastInferenceError = msg;
      console.error('[SRLocalModel] generateWithMessages() error:', name, msg);

      if (name === 'ModelNotLoadedError' ||
          lc.includes('not loaded') ||
          lc.includes('modelnotloaded') ||
          lc.includes('engine not initialized')) {
        _diag.modelNotLoadedError = true;
        _diag.errorCode = ERROR_CODES.MODEL_NOT_LOADED;
        _recordError(err, 'INFERENCE');
        _setState(MODEL_STATE.FAILED, _loadPct, msg);
        _engine = null;
      }

      callback(err, null);
    });
  }

  // ─── Internal engine accessor (for SRInferenceRuntime) ──────────────────────
  // Allows the runtime to check engine readiness without duplicating state.

  function _getEngine() {
    return _state === MODEL_STATE.READY ? _engine : null;
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  global.SRLocalModel = {
    MODEL_STATE:    MODEL_STATE,
    ERROR_CODES:    ERROR_CODES,
    FIXED_MODEL:    FIXED_MODEL_ID,

    // Stage 3A: single model only — keep DEFAULT_MODEL / CAPABLE_MODEL aliases
    // so existing test code that reads the property names doesn't break.
    DEFAULT_MODEL:  FIXED_MODEL_ID,
    CAPABLE_MODEL:  FIXED_MODEL_ID,

    loadModel:              loadModel,
    generate:               generate,
    generateWithMessages:   generateWithMessages,
    onStateChange:          onStateChange,
    getStatus:              getStatus,
    getDiagnostics:         getDiagnostics,
    destroy:                destroy,
    _getEngine:             _getEngine,
    // Exposed for SRInferenceRuntime — builds prepared messages array from
    // raw user message + context opts without running inference.
    _buildMessages:         _buildMessages,
  };

})(typeof window !== 'undefined' ? window : global);
