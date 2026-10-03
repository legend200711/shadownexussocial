/**
 * shadow-reaper-v2/core/sr-inference-runtime.js
 * Shadow Reaper — Hybrid Inference Runtime
 *
 * Build: SR-INFERENCE-RUNTIME-1
 *
 * Exposes: window.SRInferenceRuntime
 *
 * PURPOSE:
 *   One inference router. Exactly one AI: ShadowReaper.
 *   This module only decides WHERE the language model computation executes.
 *
 * RUNTIME PRIORITY ORDER:
 *   1. WebGPU (WebLLM / MLC)         — local, GPU-accelerated
 *   2. CPU local (Transformers.js)    — local, WASM-based, no GPU required
 *   3. Shadow API (Cloudflare Worker) — hosted, privacy-respecting
 *   4. Emergency fallback             — deterministic, no model required
 *
 * KEY DESIGN:
 *   - Automatic failover — if a runtime fails, the next is tried silently
 *   - Session memory — a known-failed runtime is not retried on every turn
 *   - Single generate() entry point — SRResponse.composeAsync() calls this
 *   - All runtimes receive identical prepared context (messages array)
 *   - runtimeUsed field exposed on every response for diagnostics
 *
 * IMPORTANT HARDWARE NOTE:
 *   The X230 Tablet (Intel HD 4000 / Ivy Bridge) exposes navigator.gpu but
 *   requestAdapter() returns null. This is correctly handled: we probe the
 *   full chain (navigator.gpu → requestAdapter → requestDevice) before
 *   declaring WEBGPU_READY. navigator.gpu alone is NOT sufficient.
 *
 * CPU RUNTIME:
 *   Uses @xenova/transformers (Transformers.js) for WASM-based inference.
 *   Model: Xenova/TinyLlama-1.1B-Chat-v1.0 (GGUF/ONNX, ~600MB)
 *   OR:    Xenova/smollm2-360m-instruct    (ONNX format, ~220MB)
 *   The model download is deferred until CPU is actually needed.
 *   WebGPU is NOT required for Transformers.js.
 *
 * SHADOW API:
 *   POST <workerUrl>/api/v1/inference
 *   Stub until a real inference server is deployed.
 *   Reports SHADOW_API_INFERENCE_NOT_DEPLOYED until backend exists.
 *
 * SHADOW API — PRIVACY:
 *   Only sends: requestId, conversationId, prepared messages, generationOptions.
 *   Never sends: full memory DB, unrelated conversations, private stored data.
 *   Messages array is already bounded by _buildMessages() in local-model.js.
 */

(function (global) {
  'use strict';

  // ─── Runtime identifiers ────────────────────────────────────────────────────

  var RUNTIME = {
    WEBGPU:           'webgpu-local',
    CPU:              'cpu-local',
    SHADOW_API:       'shadow-api',
    EMERGENCY:        'emergency-fallback',
  };

  // ─── State machine ──────────────────────────────────────────────────────────

  var STATE = {
    UNINITIALIZED:          'UNINITIALIZED',
    CHECKING_CAPABILITIES:  'CHECKING_CAPABILITIES',

    WEBGPU_LOADING:         'WEBGPU_LOADING',
    WEBGPU_READY:           'WEBGPU_READY',
    WEBGPU_UNAVAILABLE:     'WEBGPU_UNAVAILABLE',
    WEBGPU_FAILED:          'WEBGPU_FAILED',

    CPU_LOADING:            'CPU_LOADING',
    CPU_READY:              'CPU_READY',
    CPU_UNAVAILABLE:        'CPU_UNAVAILABLE',
    CPU_FAILED:             'CPU_FAILED',

    SHADOW_API_CHECKING:    'SHADOW_API_CHECKING',
    SHADOW_API_READY:       'SHADOW_API_READY',
    SHADOW_API_UNAVAILABLE: 'SHADOW_API_UNAVAILABLE',
    SHADOW_API_FAILED:      'SHADOW_API_FAILED',

    DEGRADED:               'DEGRADED',
    READY:                  'READY',
  };

  // ─── AI state (for UI / diagnostics) ────────────────────────────────────────

  var AI_STATE = {
    INITIALIZING:         'INITIALIZING',
    AI_READY:             'AI_READY',
    DEGRADED_TEMPLATE_ONLY: 'DEGRADED_TEMPLATE_ONLY',
  };

  // ─── Configuration ───────────────────────────────────────────────────────────

  // CPU model via Transformers.js (Xenova CDN)
  // PRIMARY:  HuggingFaceTB/SmolLM2-360M-Instruct — officially transformers.js + onnx tagged,
  //           has onnx/model_quantized.onnx, ~220 MB. (Xenova/smollm2-360m-instruct does NOT
  //           exist on HuggingFace — 404 — so it must never be used as primary.)
  // FALLBACK: Xenova/TinyLlama-1.1B-Chat-v1.0 — Xenova-hosted, confirmed working, ~700 MB.
  var CPU_MODEL_ID      = 'HuggingFaceTB/SmolLM2-360M-Instruct';
  var CPU_MODEL_ALT     = 'Xenova/TinyLlama-1.1B-Chat-v1.0';
  var TRANSFORMERS_CDN  = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

  // CPU generation limits
  var CPU_MAX_NEW_TOKENS  = 256;
  // Verify tokens: must be large enough for the model to produce a real response.
  // 30 was too small — with TinyLlama the chat-template overhead plus EOS can abort
  // before any real text reaches the decoded output.  Use 64 minimum.
  var CPU_VERIFY_TOKENS   = 64;

  // Shadow API inference endpoint path
  var SHADOW_API_INFERENCE_PATH = '/api/v1/inference';

  // Timeouts
  var SHADOW_API_TIMEOUT_MS = 15000;  // 15s per request
  var SHADOW_API_HEALTH_TIMEOUT_MS = 5000;

  // ─── Internal state ──────────────────────────────────────────────────────────

  var _state        = STATE.UNINITIALIZED;
  var _aiState      = AI_STATE.INITIALIZING;
  var _activeRuntime = null;  // currently selected runtime ID

  // Per-runtime capability memory (session-scoped — reset on page reload)
  var _cap = {
    webgpu: {
      checked:         false,
      apiAvailable:    null,   // navigator.gpu exists
      adapterAvailable: null,  // requestAdapter() non-null
      deviceAvailable:  null,  // requestDevice() succeeded
      modelLoaded:      null,  // engine created
      inferenceVerified: null, // verify inference passed
      ready:            false,
      failed:           false,
      failReason:       null,
    },
    cpu: {
      checked:         false,
      runtimeAvailable: null,  // import() succeeded
      transformersVersion: null, // detected from module
      modelLoaded:      null,
      inferenceVerified: null,
      ready:            false,
      failed:           false,
      failReason:       null,
      modelId:          null,
      pipeline:         null,  // Transformers.js pipeline instance
      // Primary model load diagnostics
      primaryLoadStarted:    false,
      primaryLoadError:      null,  // {name, message, stack}
      // Diagnostic fields populated during _verifyCPU — surfaced in getDiagnostics()
      verifyPrompt:     null,
      verifyRawResult:  null,
      verifyRawType:    null,
      verifyRawJSON:    null,
      verifyExtracted:  null,
      verifyExtractedLen: null,
      verifyError:      null,  // {name, message, stack} if generation threw
      // Stage instrumentation
      stageTokReady:       null,
      stageModelReady:     null,
      stageChatTplStart:   null,
      stageChatTplDone:    null,
      stageTokStart:       null,
      stageTokDone:        null,
      stageGenStart:       null,
      stageGenDone:        null,
      stageDecStart:       null,
      stageDecDone:        null,
      // Plain-text (no chat template) test result
      plainTextResult:     null,  // {result, error} from direct string generation
      plainTextVsChatDiff: null,  // 'PLAIN_OK_CHAT_FAIL' | 'BOTH_FAIL' | 'BOTH_OK'
      // Tokenizer-only test result
      tokTestIds:          null,
      tokTestLen:          null,
      tokTestDecoded:      null,
      tokTestError:        null,
      // Single-thread control test result
      singleThreadResult:  null,  // {pass, error} or null if not run
      // Runtime environment
      env: {
        crossOriginIsolated: null,
        sharedArrayBuffer:   null,
        wasmThreads:         null,
        wasmSimd:            null,
        performanceMemory:   null,
        browserArch:         null,
      },
    },
    shadowApi: {
      checked:         false,
      configured:      null,   // workerUrl set
      reachable:       null,   // health check OK
      inferenceVerified: null, // real inference succeeded
      notDeployed:     false,  // server stub confirmed not running inference
      ready:           false,
      failed:          false,
      failReason:      null,
    },
  };

  // State change listeners
  var _stateListeners = [];

  // Serialized generate queue — prevents concurrent inference on CPU
  var _generateLock = false;
  var _generateQueue = [];

  // ─── State helpers ───────────────────────────────────────────────────────────

  function _setState(newState) {
    if (_state === newState) return;
    _state = newState;
    _updateAIState();
    _notifyListeners();
    console.log('[SRInferenceRuntime] State:', _state, '| AI:', _aiState, '| Runtime:', _activeRuntime);
  }

  function _updateAIState() {
    if (_state === STATE.WEBGPU_READY ||
        _state === STATE.CPU_READY    ||
        _state === STATE.SHADOW_API_READY ||
        _state === STATE.READY) {
      _aiState = AI_STATE.AI_READY;
    } else if (_state === STATE.DEGRADED) {
      _aiState = AI_STATE.DEGRADED_TEMPLATE_ONLY;
    } else {
      _aiState = AI_STATE.INITIALIZING;
    }
  }

  function _notifyListeners() {
    _stateListeners.forEach(function (fn) {
      try { fn(_state, _aiState, _activeRuntime); } catch (_) {}
    });
  }

  // ─── Phase 3: WebGPU deep verification ──────────────────────────────────────

  /**
   * Full 8-step WebGPU verification.
   * Returns { ready: bool, reason: string }
   *
   * RULE: navigator.gpu existing is NOT sufficient.
   * We require:
   *   1. isSecureContext
   *   2. navigator.gpu exists
   *   3. requestAdapter() non-null
   *   4. requestDevice() succeeds
   *   5. WebLLM import OK (already done by SRLocalModel — re-use it)
   *   6. Model load succeeds
   *   7. Pipeline exists
   *   8. Verify inference produces non-empty text
   */
  function _probeWebGPU() {
    _cap.webgpu.checked = true;

    return Promise.resolve().then(function () {
      // Step 1: Secure context
      if (global.window && !global.window.isSecureContext) {
        _cap.webgpu.apiAvailable = false;
        _cap.webgpu.failReason = 'NOT_SECURE_CONTEXT';
        return { ready: false, reason: 'NOT_SECURE_CONTEXT' };
      }

      // Step 2: navigator.gpu
      _cap.webgpu.apiAvailable = !!(global.navigator && global.navigator.gpu);
      if (!_cap.webgpu.apiAvailable) {
        _cap.webgpu.adapterAvailable = false;
        _cap.webgpu.deviceAvailable  = false;
        _cap.webgpu.failReason = 'WEBGPU_API_ABSENT';
        return { ready: false, reason: 'WEBGPU_API_ABSENT' };
      }

      // Step 3: requestAdapter()
      return global.navigator.gpu.requestAdapter()
        .then(function (adapter) {
          _cap.webgpu.adapterAvailable = !!adapter;
          if (!adapter) {
            // X230 case: navigator.gpu=true but adapter=null
            _cap.webgpu.deviceAvailable = false;
            _cap.webgpu.failReason = 'WEBGPU_ADAPTER_NULL';
            return { ready: false, reason: 'WEBGPU_ADAPTER_NULL' };
          }

          // Step 4: requestDevice()
          return adapter.requestDevice().then(function (device) {
            _cap.webgpu.deviceAvailable = !!device;
            if (!device) {
              _cap.webgpu.failReason = 'WEBGPU_DEVICE_NULL';
              return { ready: false, reason: 'WEBGPU_DEVICE_NULL' };
            }
            // Immediately release device — SRLocalModel will re-acquire it
            try { device.destroy(); } catch (_) {}
            // Steps 5–8 happen inside SRLocalModel.loadModel()
            return { ready: true, reason: 'GPU_DEVICE_OK' };
          }).catch(function (err) {
            _cap.webgpu.deviceAvailable = false;
            _cap.webgpu.failReason = 'WEBGPU_DEVICE_ERROR: ' + (err && err.message);
            return { ready: false, reason: 'WEBGPU_DEVICE_ERROR' };
          });
        })
        .catch(function (err) {
          _cap.webgpu.adapterAvailable = false;
          _cap.webgpu.deviceAvailable  = false;
          _cap.webgpu.failReason = 'WEBGPU_ADAPTER_ERROR: ' + (err && err.message);
          return { ready: false, reason: 'WEBGPU_ADAPTER_ERROR' };
        });
    });
  }

  // ─── Phase 4: CPU inference via Transformers.js ──────────────────────────────

  /**
   * Check if Transformers.js CPU inference is available.
   * Imports the library, loads the model, runs a verify inference.
   */
  function _probeCPU() {
    _cap.cpu.checked = true;
    _setState(STATE.CPU_LOADING);

    // Transformers.js works via ESM import from CDN
    var importUrl = TRANSFORMERS_CDN + '/dist/transformers.min.js';
    console.log('[SRInferenceRuntime] CPU: importing Transformers.js from:', importUrl);

    return import(importUrl)
      .catch(function () {
        // Some CDN formats — try without /dist/
        return import(TRANSFORMERS_CDN);
      })
      .then(function (transformers) {
          _cap.cpu.runtimeAvailable = true;
          console.log('[SRInferenceRuntime] CPU: Transformers.js imported OK');
  
          // Detect Transformers.js version
          try {
            var txVer = (transformers.env && transformers.env.version)
              || (transformers.VERSION)
              || (transformers.version)
              || 'UNKNOWN';
            _cap.cpu.transformersVersion = txVer;
            console.log('[SRInferenceRuntime] CPU: Transformers.js version:', txVer);
          } catch (_ve) {}
  
          // Capture runtime environment diagnostics
          if (global.window) {
            try {
              _cap.cpu.env.crossOriginIsolated = !!global.window.crossOriginIsolated;
              _cap.cpu.env.sharedArrayBuffer   = typeof global.SharedArrayBuffer !== 'undefined';
              // Browser architecture from UA hints if available
              if (global.navigator && global.navigator.userAgentData &&
                  typeof global.navigator.userAgentData.getHighEntropyValues === 'function') {
                global.navigator.userAgentData.getHighEntropyValues(['architecture'])
                  .then(function (hints) { _cap.cpu.env.browserArch = hints.architecture || 'unknown'; })
                  .catch(function () {});
              }
              // Performance memory
              if (global.performance && global.performance.memory) {
                var pm = global.performance.memory;
                _cap.cpu.env.performanceMemory = {
                  jsHeapSizeLimit:  pm.jsHeapSizeLimit,
                  totalJSHeapSize:  pm.totalJSHeapSize,
                  usedJSHeapSize:   pm.usedJSHeapSize,
                };
              }
            } catch (_ee) {}
  
            // WASM threading: determined by crossOriginIsolated + SharedArrayBuffer
            _cap.cpu.env.wasmThreads = _cap.cpu.env.crossOriginIsolated && _cap.cpu.env.sharedArrayBuffer;
  
            // WASM SIMD: detect via WebAssembly.validate if available
            try {
              if (typeof WebAssembly !== 'undefined' && typeof WebAssembly.validate === 'function') {
                // Minimal SIMD probe bytecode (i32x4.splat)
                var simdProbe = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]);
                _cap.cpu.env.wasmSimd = WebAssembly.validate(simdProbe);
              }
            } catch (_se) { _cap.cpu.env.wasmSimd = false; }
          }
  
          // Set environment options for browser WASM usage
          if (transformers.env) {
            // Use remote ONNX models from Hugging Face hub
            transformers.env.allowRemoteModels = true;
            // Disable local model check (not applicable in browser)
            if (typeof transformers.env.allowLocalModels !== 'undefined') {
              transformers.env.allowLocalModels = false;
            }
            // Use quantized models for smaller download
            transformers.env.backends = transformers.env.backends || {};
          }
  
          // Try primary model (SmolLM2-360M ONNX) — capture full error before falling back
          _cap.cpu.primaryLoadStarted = true;
          return _loadCPUModel(transformers, CPU_MODEL_ID)
            .catch(function (err) {
              // Capture primary model failure with full stack before falling back
              _cap.cpu.primaryLoadError = {
                name:    err && err.name    ? err.name    : 'Error',
                message: err && err.message ? err.message : String(err),
                stack:   err && err.stack   ? err.stack   : '',
              };
              console.warn('[SRInferenceRuntime] CPU: primary model FAILED:',
                           _cap.cpu.primaryLoadError.name + ': ' + _cap.cpu.primaryLoadError.message);
              console.warn('[SRInferenceRuntime] CPU: primary stack:', _cap.cpu.primaryLoadError.stack);

              // ── Single-thread control test ────────────────────────────────────
              // Before falling back, attempt the alt model with single-thread ONNX
              // to isolate whether WASM multi-threading causes the RangeError.
              // numThreads must be set before pipeline() creates the ONNX session.
              try {
                if (transformers.env && transformers.env.backends &&
                    transformers.env.backends.onnx && transformers.env.backends.onnx.wasm) {
                  transformers.env.backends.onnx.wasm.numThreads = 1;
                  _cap.cpu.singleThreadResult = { attempted: true, numThreadsSet: 1 };
                  console.log('[SRInferenceRuntime] CPU: single-thread mode enabled (numThreads=1)');
                } else {
                  _cap.cpu.singleThreadResult = { attempted: false, reason: 'ort.env.backends.onnx.wasm not available' };
                }
              } catch (_te) {
                _cap.cpu.singleThreadResult = { attempted: false, reason: _te.message };
              }

              console.warn('[SRInferenceRuntime] CPU: trying alt model:', CPU_MODEL_ALT);
              return _loadCPUModel(transformers, CPU_MODEL_ALT);
            });
        })
      .catch(function (err) {
        _cap.cpu.runtimeAvailable = false;
        _cap.cpu.failReason = 'TRANSFORMERS_IMPORT_FAILED: ' + (err && err.message);
        console.error('[SRInferenceRuntime] CPU: import failed:', err && err.message);
        return { ready: false, reason: 'TRANSFORMERS_IMPORT_FAILED' };
      });
  }

  function _loadCPUModel(transformers, modelId) {
    console.log('[SRInferenceRuntime] CPU: loading model:', modelId);
    _cap.cpu.modelId = modelId;

    // Use text-generation pipeline for chat-style models
    var PipelineClass = transformers.pipeline || (transformers.default && transformers.default.pipeline);
    if (!PipelineClass) {
      return Promise.reject(new Error('pipeline() not found in Transformers.js module'));
    }

    return PipelineClass('text-generation', modelId, {
      // Quantized weights reduce download size dramatically
      quantized: true,
      // Progress callback — for diagnostics
      progress_callback: function (progress) {
        if (progress && progress.status === 'downloading') {
          console.log('[SRInferenceRuntime] CPU model download:',
            Math.round((progress.progress || 0)) + '%', progress.file || '');
        }
      },
    }).then(function (pipe) {
      _cap.cpu.pipeline    = pipe;
      _cap.cpu.modelLoaded = true;
      _cap.cpu.stageModelReady = true;
      console.log('[SRInferenceRuntime] CPU: model loaded OK:', modelId);

      // Verify inference
      return _verifyCPU(pipe).then(function (verified) {
        _cap.cpu.inferenceVerified = verified;
        if (verified) {
          _cap.cpu.ready = true;
          return { ready: true, reason: 'CPU_INFERENCE_OK' };
        } else if (_cap.cpu.verifyError) {
          // Generation threw an exception — not an empty response
          _cap.cpu.failReason = 'CPU_GENERATION_FAILED: ' + _cap.cpu.verifyError.message;
          return { ready: false, reason: 'CPU_GENERATION_FAILED' };
        } else {
          // Generation completed but extracted text was empty
          _cap.cpu.failReason = 'CPU_VERIFY_EMPTY';
          return { ready: false, reason: 'CPU_VERIFY_EMPTY' };
        }
      });
    }).catch(function (err) {
      _cap.cpu.modelLoaded = false;
      _cap.cpu.failReason  = 'CPU_MODEL_LOAD_FAILED: ' + (err && err.message);
      console.error('[SRInferenceRuntime] CPU model load failed:', err && err.message);
      throw err;
    });
  }

  // ─── _verifyCPU: staged generation verification ──────────────────────────────
  //
  // Runs three sub-tests in sequence:
  //   1. Tokenizer-only test  (encode + decode "Hello" without running model)
  //   2. Plain-text test      (pipe("Hello", ...) — no chat template, no messages array)
  //   3. Chat-messages test   (pipe([{role,content}], ...) — standard chat path)
  //
  // The three-way result determines WHERE failure occurs.

  function _verifyCPU(pipe) {
    _cap.cpu.verifyPrompt = 'Hello';

    // ── Stage: tokenizer ─────────────────────────────────────────────────────
    _cap.cpu.stageTokReady = false;
    var tokReady = Promise.resolve();
    if (pipe.tokenizer) {
      tokReady = Promise.resolve().then(function () {
        try {
          _cap.cpu.stageTokReady = true;
          _cap.cpu.stageTokStart = true;
          var enc = pipe.tokenizer('Hello');
          _cap.cpu.stageTokDone  = true;

          // Capture token info
          var ids = enc.input_ids;
          if (ids && ids.data) {
            _cap.cpu.tokTestIds = Array.from(ids.data);
          } else if (Array.isArray(ids)) {
            _cap.cpu.tokTestIds = ids;
          }
          _cap.cpu.tokTestLen = _cap.cpu.tokTestIds ? _cap.cpu.tokTestIds.length : 0;

          // Decode back
          if (_cap.cpu.tokTestIds && _cap.cpu.tokTestIds.length > 0 &&
              typeof pipe.tokenizer.decode === 'function') {
            _cap.cpu.stageDecStart = true;
            _cap.cpu.tokTestDecoded = pipe.tokenizer.decode(_cap.cpu.tokTestIds, { skip_special_tokens: true });
            _cap.cpu.stageDecDone  = true;
          }
          console.log('[SRInferenceRuntime] CPU tokenizer test OK: ids=',
                      _cap.cpu.tokTestIds, 'decoded=', _cap.cpu.tokTestDecoded);
        } catch (tokErr) {
          _cap.cpu.tokTestError = {
            name:    tokErr.name    || 'Error',
            message: tokErr.message || String(tokErr),
            stack:   tokErr.stack   || '',
          };
          console.warn('[SRInferenceRuntime] CPU tokenizer test FAILED:', _cap.cpu.tokTestError.message);
        }
      });
    }

    return tokReady.then(function () {
      // ── Stage: plain text (no chat template) ──────────────────────────────
      _cap.cpu.stageChatTplStart = false;  // not in chat path yet
      return pipe('Hello', {
        max_new_tokens: CPU_VERIFY_TOKENS,
        min_new_tokens: 1,
        do_sample:      false,
        temperature:    1,
        return_full_text: false,
      }).then(function (plainResult) {
        var plainText = '';
        try {
          if (Array.isArray(plainResult) && plainResult[0]) {
            var gt = plainResult[0].generated_text;
            // generated_text is a string for plain-text input; array for chat input
            if (typeof gt === 'string') {
              plainText = gt;
            } else if (Array.isArray(gt)) {
              // Unexpected chat format for plain-text input — extract last assistant turn
              for (var pi = gt.length - 1; pi >= 0; pi--) {
                if (gt[pi] && gt[pi].role === 'assistant') { plainText = gt[pi].content || ''; break; }
              }
            }
          }
        } catch (_pe) {}

        _cap.cpu.plainTextResult = {
          rawType: Array.isArray(plainResult) ? 'array[' + plainResult.length + ']' : typeof plainResult,
          text:    plainText,
          pass:    !!(plainText && typeof plainText === 'string' && plainText.trim().length > 0),
        };
        console.log('[SRInferenceRuntime] CPU plain-text test:', _cap.cpu.plainTextResult.pass ? 'PASS' : 'FAIL',
                    '"' + String(plainText).substring(0, 80) + '"');

      }).catch(function (plainErr) {
        _cap.cpu.plainTextResult = {
          pass:  false,
          error: {
            name:    plainErr.name    || 'Error',
            message: plainErr.message || String(plainErr),
            stack:   plainErr.stack   || '',
          },
        };
        console.warn('[SRInferenceRuntime] CPU plain-text test FAILED:',
                     _cap.cpu.plainTextResult.error.name + ': ' +
                     _cap.cpu.plainTextResult.error.message);
      });

    }).then(function () {
      // ── Stage: chat messages (standard path) ──────────────────────────────
      var verifyMessages = [{ role: 'user', content: 'Hello' }];
      _cap.cpu.stageChatTplStart = true;

      return pipe(verifyMessages, {
        max_new_tokens:  CPU_VERIFY_TOKENS,
        min_new_tokens:  1,
        do_sample:       false,
        temperature:     1,
        // return_full_text is IGNORED for chat input in Transformers.js 2.x
      }).then(function (result) {
        _cap.cpu.stageChatTplDone = true;
        _cap.cpu.stageGenStart    = true;
        _cap.cpu.stageGenDone     = true;

        // ── Capture raw diagnostics ────────────────────────────────────────
        _cap.cpu.verifyRawResult = result;
        _cap.cpu.verifyRawType   = Array.isArray(result) ? 'array[' + result.length + ']'
                                   : (result === null ? 'null' : typeof result);
        try { _cap.cpu.verifyRawJSON = JSON.stringify(result); } catch (_e) { _cap.cpu.verifyRawJSON = '[not serializable]'; }

        var text = _extractCPUText(result);
        _cap.cpu.verifyExtracted    = text;
        _cap.cpu.verifyExtractedLen = text ? text.length : 0;

        var verified = !!(text && text.trim().length > 0);
        _cap.cpu.inferenceVerified = verified;

        // Classify plain vs chat result difference
        var plainPass = _cap.cpu.plainTextResult && _cap.cpu.plainTextResult.pass;
        if (plainPass && !verified) {
          _cap.cpu.plainTextVsChatDiff = 'PLAIN_OK_CHAT_FAIL';
        } else if (!plainPass && !verified) {
          _cap.cpu.plainTextVsChatDiff = 'BOTH_FAIL';
        } else {
          _cap.cpu.plainTextVsChatDiff = 'BOTH_OK';
        }

        console.log('[SRInferenceRuntime] CPU verify chat: extracted=' + JSON.stringify(text) +
                    ' verified=' + verified + ' diff=' + _cap.cpu.plainTextVsChatDiff);
        return verified;

      }).catch(function (err) {
        _cap.cpu.stageChatTplDone = false;
        _cap.cpu.stageGenStart    = false;
        _cap.cpu.stageGenDone     = false;

        // Preserve FULL stack — do not truncate
        _cap.cpu.verifyError = {
          name:    err && err.name    ? err.name    : 'Error',
          message: err && err.message ? err.message : String(err),
          stack:   err && err.stack   ? err.stack   : '',
        };
        _cap.cpu.inferenceVerified = false;

        var plainPass = _cap.cpu.plainTextResult && _cap.cpu.plainTextResult.pass;
        _cap.cpu.plainTextVsChatDiff = plainPass ? 'PLAIN_OK_CHAT_FAIL' : 'BOTH_FAIL';

        console.warn('[SRInferenceRuntime] CPU verify chat THREW:', _cap.cpu.verifyError.name,
                     _cap.cpu.verifyError.message);
        console.warn('[SRInferenceRuntime] CPU verify FULL STACK:\n', _cap.cpu.verifyError.stack);
        return false;
      });
    });
  }

  // _extractCPUText: handles Transformers.js 2.x pipeline output shapes.
  //
  // Transformers.js 2.17 TextGenerationPipeline returns:
  //   String input:   [{generated_text: "full string including prompt (return_full_text=true default)"}]
  //   String input:   [{generated_text: "generated only (return_full_text=false)"}]
  //   Chat input:     [{generated_text: [{role:'user',content:'...'}, {role:'assistant',content:'...'}]}]
  //                   (return_full_text is IGNORED for chat input — full messages array always returned)
  //
  // When a single Chat is passed (not wrapped in outer array), pipeline returns d[0]
  // which is [{generated_text: [...messages...]}], so result itself IS an array.
  //
  // When batched (outer array), result is array of arrays.
  function _extractCPUText(result) {
    try {
      if (!result) return '';

      // result = [{generated_text: ...}] — standard single-item array from pipeline
      if (Array.isArray(result) && result.length > 0) {
        var first = result[0];
        if (!first) return '';

        var gt = first.generated_text;

        // Chat output: [{role, content}, ...]
        if (Array.isArray(gt)) {
          // Find the last assistant turn
          for (var i = gt.length - 1; i >= 0; i--) {
            if (gt[i] && gt[i].role === 'assistant') {
              return gt[i].content || '';
            }
          }
          // No assistant turn found — take last element content if present
          var lastMsg = gt[gt.length - 1];
          return (lastMsg && typeof lastMsg.content === 'string') ? lastMsg.content : '';
        }

        // Plain string output
        if (typeof gt === 'string') return gt;
        return '';
      }

      // Fallback: result itself might be a single object (shouldn't happen with 2.17, but guard)
      if (result && typeof result.generated_text === 'string') return result.generated_text;
      if (result && Array.isArray(result.generated_text)) {
        var last2 = result.generated_text[result.generated_text.length - 1];
        return (last2 && last2.content) ? last2.content : '';
      }

      return '';
    } catch (_e) {
      return '';
    }
  }

  // ─── Phase 5: Shadow API ─────────────────────────────────────────────────────

  function _checkShadowAPI() {
    _cap.shadowApi.checked = true;
    _setState(STATE.SHADOW_API_CHECKING);

    var workerUrl = _getWorkerUrl();
    _cap.shadowApi.configured = !!workerUrl;

    if (!workerUrl) {
      _cap.shadowApi.reachable  = false;
      _cap.shadowApi.failReason = 'SHADOW_API_NOT_CONFIGURED';
      console.log('[SRInferenceRuntime] Shadow API: not configured (no worker URL)');
      return Promise.resolve({ ready: false, reason: 'SHADOW_API_NOT_CONFIGURED' });
    }

    var healthUrl = workerUrl + '/api/v1/health';
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, SHADOW_API_HEALTH_TIMEOUT_MS)
      : null;

    var fetchOpts = { method: 'GET' };
    if (controller) fetchOpts.signal = controller.signal;

    var _fetchFn = global.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!_fetchFn) {
      _cap.shadowApi.reachable  = false;
      _cap.shadowApi.failReason = 'FETCH_NOT_AVAILABLE';
      return Promise.resolve({ ready: false, reason: 'FETCH_NOT_AVAILABLE' });
    }

    return _fetchFn(healthUrl, fetchOpts)
      .then(function (resp) {
        if (timer) clearTimeout(timer);
        _cap.shadowApi.reachable = resp.ok;
        if (!resp.ok) {
          _cap.shadowApi.failReason = 'SHADOW_API_HEALTH_HTTP_' + resp.status;
          return { ready: false, reason: 'SHADOW_API_HEALTH_FAILED' };
        }
        return resp.json().then(function (data) {
            // Health endpoint exists — check if Workers AI inference binding is present.
            // inference:true  = AI binding deployed; attempt /api/v1/inference
            // inference:false = AI binding absent; skip hosted runtime
            _cap.shadowApi.reachable = true;
            var hasInference = !!(data && data.inference);
            _cap.shadowApi.notDeployed = !hasInference;
            if (!hasInference) {
              _cap.shadowApi.failReason = 'SHADOW_API_INFERENCE_NOT_CONFIGURED';
              return { ready: false, reason: 'SHADOW_API_INFERENCE_NOT_CONFIGURED' };
            }
            _cap.shadowApi.ready = true;
            return { ready: true, reason: 'SHADOW_API_OK' };
          }).catch(function () {
            // JSON parse error — health endpoint exists but no inference info
            _cap.shadowApi.notDeployed = true;
            _cap.shadowApi.failReason = 'SHADOW_API_INFERENCE_NOT_CONFIGURED';
            return { ready: false, reason: 'SHADOW_API_INFERENCE_NOT_CONFIGURED' };
          });
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        _cap.shadowApi.reachable  = false;
        _cap.shadowApi.failReason = 'SHADOW_API_UNREACHABLE: ' + (err && err.message);
        console.log('[SRInferenceRuntime] Shadow API unreachable:', err && err.message);
        return { ready: false, reason: 'SHADOW_API_UNREACHABLE' };
      });
  }

  function _getWorkerUrl() {
    // Priority 1: SRConfig — single canonical configuration source
    if (global.SRConfig && typeof global.SRConfig.getWorkerUrl === 'function') {
      var cfgUrl = global.SRConfig.getWorkerUrl();
      if (cfgUrl) return cfgUrl;
    }
    // Priority 2: SRCloudAPI (backward compatibility)
    if (global.SRCloudAPI && typeof global.SRCloudAPI.getWorkerUrl === 'function') {
      return global.SRCloudAPI.getWorkerUrl() || '';
    }
    // Priority 3: global SR_CLOUD_WORKER_URL property (test sandbox + legacy)
    if (global.SR_CLOUD_WORKER_URL) return global.SR_CLOUD_WORKER_URL;
    // Priority 4: identifier in scope (browser window property)
    try {
      var _w = (typeof SR_CLOUD_WORKER_URL !== 'undefined') ? SR_CLOUD_WORKER_URL : null;
      if (_w) return _w;
    } catch (_) {}
    return '';
  }

  // ─── Phase 6: Runtime selection ──────────────────────────────────────────────

  /**
   * Main initialization — tries runtimes in priority order.
   * Records which runtimes are available for the session.
   * Does not block ShadowReaper.init() — called on first generate() or
   * explicitly via initialize().
   *
   * @returns {Promise<void>}
   */
  function initialize() {
    if (_state !== STATE.UNINITIALIZED) return Promise.resolve();
    _setState(STATE.CHECKING_CAPABILITIES);

    // ── Try WebGPU first ─────────────────────────────────────────────────────
    return _probeWebGPU().then(function (gpuResult) {
      if (gpuResult.ready) {
        // GPU device obtainable — let SRLocalModel handle steps 5–8
        _setState(STATE.WEBGPU_LOADING);
        var lm = global.SRLocalModel;
        if (!lm) {
          _cap.webgpu.failed    = true;
          _cap.webgpu.failReason = 'SRLOCAL_MODEL_NOT_LOADED';
          return _tryNextRuntime('webgpu', 'SRLocalModel not available');
        }
        return lm.loadModel().then(function () {
          // Model READY confirmed
          _cap.webgpu.modelLoaded        = true;
          _cap.webgpu.inferenceVerified  = true;
          _cap.webgpu.ready              = true;
          _activeRuntime = RUNTIME.WEBGPU;
          _setState(STATE.WEBGPU_READY);
          _setState(STATE.READY);
          console.log('[SRInferenceRuntime] WebGPU runtime READY');
        }).catch(function (err) {
          _cap.webgpu.failed    = true;
          _cap.webgpu.failReason = err && err.message ? err.message : String(err);
          console.warn('[SRInferenceRuntime] WebGPU load failed:', _cap.webgpu.failReason);
          return _tryNextRuntime('webgpu', _cap.webgpu.failReason);
        });
      } else {
        // GPU not viable (includes X230 requestAdapter=null case)
        _cap.webgpu.failed    = true;
        _cap.webgpu.failReason = gpuResult.reason;
        console.log('[SRInferenceRuntime] WebGPU unavailable:', gpuResult.reason);
        _setState(STATE.WEBGPU_UNAVAILABLE);
        return _tryNextRuntime('webgpu', gpuResult.reason);
      }
    });
  }

  /**
   * Attempt the next runtime after the given one has failed.
   * Priority: webgpu → cpu → shadow_api → emergency
   */
  function _tryNextRuntime(failed, reason) {
    console.log('[SRInferenceRuntime] Trying next runtime after', failed, '(' + reason + ')');

    if (failed === 'webgpu') {
      // Try CPU
      if (_cap.cpu.failed) {
        // CPU already tried and failed
        return _tryNextRuntime('cpu', _cap.cpu.failReason || 'already_failed');
      }
      return _probeCPU().then(function (cpuResult) {
        if (cpuResult.ready) {
          _cap.cpu.ready   = true;
          _activeRuntime   = RUNTIME.CPU;
          _setState(STATE.CPU_READY);
          _setState(STATE.READY);
          console.log('[SRInferenceRuntime] CPU runtime READY, model:', _cap.cpu.modelId);
          return;
        } else {
          _cap.cpu.failed    = true;
          _cap.cpu.failReason = cpuResult.reason;
          console.warn('[SRInferenceRuntime] CPU runtime unavailable:', cpuResult.reason);
          _setState(STATE.CPU_UNAVAILABLE);
          return _tryNextRuntime('cpu', cpuResult.reason);
        }
      }).catch(function (err) {
        _cap.cpu.failed    = true;
        _cap.cpu.failReason = err && err.message ? err.message : String(err);
        _setState(STATE.CPU_FAILED);
        return _tryNextRuntime('cpu', _cap.cpu.failReason);
      });
    }

    if (failed === 'cpu') {
      // Try Shadow API
      if (_cap.shadowApi.failed || _cap.shadowApi.notDeployed) {
        return _tryNextRuntime('shadow_api',
          _cap.shadowApi.failReason || 'already_failed');
      }
      return _checkShadowAPI().then(function (apiResult) {
        if (apiResult.ready) {
          _cap.shadowApi.ready = true;
          _activeRuntime       = RUNTIME.SHADOW_API;
          _setState(STATE.SHADOW_API_READY);
          _setState(STATE.READY);
          console.log('[SRInferenceRuntime] Shadow API runtime READY');
          return;
        } else {
          _cap.shadowApi.failed    = true;
          _cap.shadowApi.failReason = apiResult.reason;
          // Both notDeployed (old) and notConfigured (new) indicate no hosted backend yet
          if (apiResult.reason === 'SHADOW_API_INFERENCE_NOT_DEPLOYED' ||
              apiResult.reason === 'SHADOW_API_INFERENCE_NOT_CONFIGURED') {
            _cap.shadowApi.notDeployed = true;
          }
          _setState(STATE.SHADOW_API_UNAVAILABLE);
          return _tryNextRuntime('shadow_api', apiResult.reason);
        }
      }).catch(function (err) {
        _cap.shadowApi.failed    = true;
        _cap.shadowApi.failReason = err && err.message ? err.message : String(err);
        _setState(STATE.SHADOW_API_FAILED);
        return _tryNextRuntime('shadow_api', _cap.shadowApi.failReason);
      });
    }

    // All runtimes failed — degrade
    _activeRuntime = RUNTIME.EMERGENCY;
    _setState(STATE.DEGRADED);
    console.warn('[SRInferenceRuntime] All runtimes failed. Emergency fallback only.',
                 '| WebGPU:', _cap.webgpu.failReason,
                 '| CPU:', _cap.cpu.failReason,
                 '| ShadowAPI:', _cap.shadowApi.failReason);
    return Promise.resolve();
  }

  // ─── Generate ────────────────────────────────────────────────────────────────

  /**
   * Primary entry point for inference.
   *
   * generate(messages, opts, callback)
   *
   *   messages  — Array<{role, content}> already built by _buildMessages()
   *   opts      — { maxTokens, temperature, conversationId }
   *   callback  — fn(err, text, runtimeUsed)
   *               err: Error or null
   *               text: generated string or null
   *               runtimeUsed: one of RUNTIME values
   *
   * Automatically initializes if not yet started.
   * Routes to active runtime; falls back to next on per-request failure.
   */
  function generate(messages, opts, callback) {
    if (typeof opts === 'function') { callback = opts; opts = {}; }
    callback = callback || function () {};
    opts = opts || {};

    // Enqueue if a generate is already running (CPU serialization)
    if (_generateLock) {
      _generateQueue.push({ messages: messages, opts: opts, callback: callback });
      return;
    }
    _generateLock = true;

    function _done(err, text, runtimeUsed) {
      _generateLock = false;
      var next = _generateQueue.shift();
      if (next) {
        // Process next queued generate
        setTimeout(function () {
          generate(next.messages, next.opts, next.callback);
        }, 0);
      }
      callback(err, text, runtimeUsed);
    }

    // Auto-initialize if needed
    if (_state === STATE.UNINITIALIZED) {
      initialize().then(function () {
        _generateWithCurrentRuntime(messages, opts, _done);
      }).catch(function () {
        _generateWithCurrentRuntime(messages, opts, _done);
      });
      return;
    }

    // Initialization in progress — wait
    if (_state === STATE.CHECKING_CAPABILITIES ||
        _state === STATE.WEBGPU_LOADING        ||
        _state === STATE.CPU_LOADING           ||
        _state === STATE.SHADOW_API_CHECKING) {
      var _unsub = onStateChange(function (newState) {
        if (newState === STATE.READY    ||
            newState === STATE.DEGRADED ||
            newState === STATE.WEBGPU_READY    ||
            newState === STATE.CPU_READY       ||
            newState === STATE.SHADOW_API_READY) {
          _unsub();
          _generateWithCurrentRuntime(messages, opts, _done);
        }
      });
      return;
    }

    _generateWithCurrentRuntime(messages, opts, _done);
  }

  function _generateWithCurrentRuntime(messages, opts, callback) {
    var runtime = _activeRuntime;

    if (!runtime || runtime === RUNTIME.EMERGENCY || _state === STATE.DEGRADED) {
      var fallbackErr = new Error('All inference runtimes unavailable. Using emergency fallback.');
      fallbackErr.name = 'AllRuntimesFailed';
      fallbackErr.runtimeUsed = RUNTIME.EMERGENCY;
      callback(fallbackErr, null, RUNTIME.EMERGENCY);
      return;
    }

    if (runtime === RUNTIME.WEBGPU) {
      _generateWebGPU(messages, opts, function (err, text) {
        if (err) {
          // WebGPU failed mid-session — try to failover
          console.warn('[SRInferenceRuntime] WebGPU mid-session failure:', err.message);
          _cap.webgpu.failed = true;
          _cap.webgpu.failReason = err.message;
          _setState(STATE.WEBGPU_FAILED);
          _activeRuntime = null;
          // Retry next runtime (async)
          _tryNextRuntime('webgpu', err.message).then(function () {
            _generateWithCurrentRuntime(messages, opts, callback);
          });
          return;
        }
        callback(null, text, RUNTIME.WEBGPU);
      });
      return;
    }

    if (runtime === RUNTIME.CPU) {
      _generateCPU(messages, opts, function (err, text) {
        if (err) {
          console.warn('[SRInferenceRuntime] CPU mid-session failure:', err.message);
          _cap.cpu.failed = true;
          _cap.cpu.failReason = err.message;
          _setState(STATE.CPU_FAILED);
          _activeRuntime = null;
          _tryNextRuntime('cpu', err.message).then(function () {
            _generateWithCurrentRuntime(messages, opts, callback);
          });
          return;
        }
        callback(null, text, RUNTIME.CPU);
      });
      return;
    }

    if (runtime === RUNTIME.SHADOW_API) {
      _generateShadowAPI(messages, opts, function (err, text) {
        if (err) {
          console.warn('[SRInferenceRuntime] Shadow API mid-session failure:', err.message);
          _cap.shadowApi.failed = true;
          _cap.shadowApi.failReason = err.message;
          _setState(STATE.SHADOW_API_FAILED);
          _activeRuntime = null;
          _tryNextRuntime('shadow_api', err.message).then(function () {
            _generateWithCurrentRuntime(messages, opts, callback);
          });
          return;
        }
        callback(null, text, RUNTIME.SHADOW_API);
      });
      return;
    }

    // Should not reach here
    var unknownErr = new Error('Unknown runtime: ' + runtime);
    unknownErr.runtimeUsed = RUNTIME.EMERGENCY;
    callback(unknownErr, null, RUNTIME.EMERGENCY);
  }

  // ─── WebGPU generation ───────────────────────────────────────────────────────

  function _generateWebGPU(messages, opts, callback) {
    var lm = global.SRLocalModel;
    if (!lm || lm.getStatus().state !== 'READY') {
      callback(new Error('SRLocalModel not ready'), null);
      return;
    }

    // Use generateWithMessages() — passes the pre-built messages array
    // directly to the engine, preserving all Shadow context that was built
    // by _buildMessages() in the response engine without rebuilding it.
    if (lm.generateWithMessages) {
      lm.generateWithMessages(messages, opts, function (err, text) {
        callback(err, text);
      });
    } else {
      // Legacy fallback: extract raw user message and use generate()
      var userMsg = '';
      for (var i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') { userMsg = messages[i].content; break; }
      }
      lm.generate(userMsg, opts, function (err, text) {
        callback(err, text);
      });
    }
  }

  // ─── CPU generation ──────────────────────────────────────────────────────────

  function _generateCPU(messages, opts, callback) {
    var pipe = _cap.cpu.pipeline;
    if (!pipe) {
      callback(new Error('CPU pipeline not available'), null);
      return;
    }

    // Transformers.js expects message array with role/content
    pipe(messages, {
      max_new_tokens:   opts.maxTokens  || CPU_MAX_NEW_TOKENS,
      do_sample:        opts.temperature !== 0,
      temperature:      opts.temperature !== undefined ? opts.temperature : 0.7,
      return_full_text: false,
    }).then(function (result) {
      var text = _extractCPUText(result);
      if (!text || text.trim().length === 0) {
        callback(new Error('CPU inference returned empty response'), null);
        return;
      }
      callback(null, text.trim());
    }).catch(function (err) {
      callback(err, null);
    });
  }

  // ─── Shadow API generation ───────────────────────────────────────────────────

  function _generateShadowAPI(messages, opts, callback) {
    var workerUrl = _getWorkerUrl();
    if (!workerUrl) {
      callback(new Error('Shadow API not configured'), null);
      return;
    }

    var requestId     = 'sr_inf_' + Date.now().toString(36);
    var conversationId = opts.conversationId || null;

    // Only send what's needed — never dump entire local DB
    var body = JSON.stringify({
      requestId:      requestId,
      conversationId: conversationId,
      // Messages already bounded by _buildMessages() — max ~8 turns + system
      messages:       messages,
      generationOptions: {
        max_tokens:  opts.maxTokens  || 256,
        temperature: opts.temperature !== undefined ? opts.temperature : 0.7,
      },
    });

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller
      ? setTimeout(function () { controller.abort(); }, SHADOW_API_TIMEOUT_MS)
      : null;

    var headers = { 'Content-Type': 'application/json' };

    // Attach Firebase auth token if available
    var authUI = global.SRAuthUI;
    if (authUI && typeof authUI.getIdToken === 'function') {
      try {
        var token = authUI.getIdToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
      } catch (_) {}
    }

    var fetchOpts = { method: 'POST', headers: headers, body: body };
    if (controller) fetchOpts.signal = controller.signal;

    var _fetchFn2 = global.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!_fetchFn2) {
      callback(new Error('fetch not available'), null);
      return;
    }

    _fetchFn2(workerUrl + SHADOW_API_INFERENCE_PATH, fetchOpts)
      .then(function (resp) {
        if (timer) clearTimeout(timer);
        if (!resp.ok) {
          return resp.text().then(function (t) {
            throw new Error('Shadow API HTTP ' + resp.status + ': ' + t.substring(0, 100));
          });
        }
        return resp.json();
      })
      .then(function (data) {
        // Handle not-configured case — AI binding not yet bound on the Worker.
        // Treat this as a non-error soft failure so the client falls back cleanly.
        if (!data.success && (data.notConfigured || data.notDeployed)) {
          var ncErr = new Error('Shadow API inference not configured');
          ncErr.name = 'ShadowAPINotConfigured';
          callback(ncErr, null);
          return;
        }
        if (!data.success || !data.response) {
          throw new Error(data.error || 'Shadow API returned no response');
        }
        callback(null, data.response);
      })
      .catch(function (err) {
        if (timer) clearTimeout(timer);
        callback(err, null);
      });
  }

  // ─── Public API — state management ──────────────────────────────────────────

  function onStateChange(fn) {
    _stateListeners.push(fn);
    return function () {
      _stateListeners = _stateListeners.filter(function (f) { return f !== fn; });
    };
  }

  function getStatus() {
    return {
      state:         _state,
      aiState:       _aiState,
      activeRuntime: _activeRuntime,
      isAIReady:     _aiState === AI_STATE.AI_READY,
      isDegraded:    _aiState === AI_STATE.DEGRADED_TEMPLATE_ONLY,
    };
  }

  function getDiagnostics() {
    return {
      state:         _state,
      aiState:       _aiState,
      activeRuntime: _activeRuntime,

      // WebGPU
      WEBGPU_API_AVAILABLE:      _cap.webgpu.apiAvailable,
      WEBGPU_ADAPTER_AVAILABLE:  _cap.webgpu.adapterAvailable,
      WEBGPU_DEVICE_AVAILABLE:   _cap.webgpu.deviceAvailable,
      WEBGPU_MODEL_LOADED:       _cap.webgpu.modelLoaded,
      WEBGPU_INFERENCE_VERIFIED: _cap.webgpu.inferenceVerified,
      WEBGPU_READY:              _cap.webgpu.ready,
      WEBGPU_FAILED:             _cap.webgpu.failed,
      WEBGPU_FAIL_REASON:        _cap.webgpu.failReason,

      // CPU
      CPU_RUNTIME_AVAILABLE:       _cap.cpu.runtimeAvailable,
      CPU_TRANSFORMERS_VERSION:    _cap.cpu.transformersVersion,
      CPU_REQUESTED_MODEL:         CPU_MODEL_ID,
      CPU_MODEL_ID:                _cap.cpu.modelId,
      CPU_MODEL_LOADED:            _cap.cpu.modelLoaded,
      CPU_INFERENCE_VERIFIED:      _cap.cpu.inferenceVerified,
      CPU_READY:                   _cap.cpu.ready,
      CPU_FAILED:                  _cap.cpu.failed,
      CPU_FAIL_REASON:             _cap.cpu.failReason,

      // Primary model load diagnostics
      CPU_PRIMARY_MODEL_LOAD_STARTED: _cap.cpu.primaryLoadStarted,
      CPU_PRIMARY_MODEL_LOAD_ERROR_NAME:    _cap.cpu.primaryLoadError ? _cap.cpu.primaryLoadError.name    : null,
      CPU_PRIMARY_MODEL_LOAD_ERROR_MESSAGE: _cap.cpu.primaryLoadError ? _cap.cpu.primaryLoadError.message : null,
      CPU_PRIMARY_MODEL_LOAD_ERROR_STACK:   _cap.cpu.primaryLoadError ? _cap.cpu.primaryLoadError.stack   : null,

      // Stage instrumentation
      CPU_STAGE_TOKENIZER_READY:         _cap.cpu.stageTokReady,
      CPU_STAGE_MODEL_READY:             _cap.cpu.stageModelReady,
      CPU_STAGE_CHAT_TEMPLATE_STARTED:   _cap.cpu.stageChatTplStart,
      CPU_STAGE_CHAT_TEMPLATE_COMPLETED: _cap.cpu.stageChatTplDone,
      CPU_STAGE_TOKENIZATION_STARTED:    _cap.cpu.stageTokStart,
      CPU_STAGE_TOKENIZATION_COMPLETED:  _cap.cpu.stageTokDone,
      CPU_STAGE_GENERATION_STARTED:      _cap.cpu.stageGenStart,
      CPU_STAGE_GENERATION_COMPLETED:    _cap.cpu.stageGenDone,
      CPU_STAGE_DECODE_STARTED:          _cap.cpu.stageDecStart,
      CPU_STAGE_DECODE_COMPLETED:        _cap.cpu.stageDecDone,

      // Verify diagnostics — captures raw generation result for debug
      CPU_VERIFY_PROMPT:           _cap.cpu.verifyPrompt,
      CPU_RAW_RESULT_TYPE:         _cap.cpu.verifyRawType,
      CPU_RAW_RESULT:              _cap.cpu.verifyRawResult,
      CPU_RAW_RESULT_JSON:         _cap.cpu.verifyRawJSON,
      CPU_EXTRACTED_TEXT:          _cap.cpu.verifyExtracted,
      CPU_EXTRACTED_TEXT_LENGTH:   _cap.cpu.verifyExtractedLen,
      CPU_GENERATION_ERROR_NAME:    _cap.cpu.verifyError ? _cap.cpu.verifyError.name    : null,
      CPU_GENERATION_ERROR_MESSAGE: _cap.cpu.verifyError ? _cap.cpu.verifyError.message : null,
      CPU_GENERATION_ERROR_STACK:   _cap.cpu.verifyError ? _cap.cpu.verifyError.stack   : null,

      // Plain-text vs chat-template test
      CPU_PLAIN_TEXT_RESULT:       _cap.cpu.plainTextResult,
      CPU_PLAIN_VS_CHAT_DIFF:      _cap.cpu.plainTextVsChatDiff,

      // Tokenizer-only test
      CPU_TOK_TEST_IDS:            _cap.cpu.tokTestIds,
      CPU_TOK_TEST_LEN:            _cap.cpu.tokTestLen,
      CPU_TOK_TEST_DECODED:        _cap.cpu.tokTestDecoded,
      CPU_TOK_TEST_ERROR:          _cap.cpu.tokTestError,

      // Runtime environment
      CPU_ENV_CROSS_ORIGIN_ISOLATED: _cap.cpu.env.crossOriginIsolated,
      CPU_ENV_SHARED_ARRAY_BUFFER:   _cap.cpu.env.sharedArrayBuffer,
      CPU_ENV_WASM_THREADS:          _cap.cpu.env.wasmThreads,
      CPU_ENV_WASM_SIMD:             _cap.cpu.env.wasmSimd,
      CPU_ENV_PERFORMANCE_MEMORY:    _cap.cpu.env.performanceMemory,
      CPU_ENV_BROWSER_ARCH:          _cap.cpu.env.browserArch,

      // Single-thread control test
      CPU_SINGLE_THREAD_RESULT:      _cap.cpu.singleThreadResult,

      // Shadow API
      SHADOW_API_CONFIGURED:        _cap.shadowApi.configured,
      SHADOW_API_REACHABLE:         _cap.shadowApi.reachable,
      SHADOW_API_INFERENCE_VERIFIED: _cap.shadowApi.inferenceVerified,
      SHADOW_API_NOT_DEPLOYED:      _cap.shadowApi.notDeployed,
      SHADOW_API_READY:             _cap.shadowApi.ready,
      SHADOW_API_FAILED:            _cap.shadowApi.failed,
      SHADOW_API_FAIL_REASON:       _cap.shadowApi.failReason,

      // Selected
      SELECTED_RUNTIME: _activeRuntime,
      FINAL_AI_STATE:   _aiState,
    };
  }

  /**
   * Expose an internal engine accessor for WebGPU generate path.
   * SRLocalModel uses its own internal _engine variable — we need a way to
   * call chat.completions.create() with a pre-built messages array.
   * This is done by extending SRLocalModel.generate() below (see integration note).
   */

  /**
   * resetRuntime(runtimeId)
   * Allow a specific runtime to be reconsidered (e.g., GPU drivers updated).
   * Safe — clears failed flag so next generate() will re-probe.
   */
  function resetRuntime(runtimeId) {
    if (runtimeId === RUNTIME.WEBGPU) {
      _cap.webgpu.checked = false;
      _cap.webgpu.failed  = false;
      _cap.webgpu.ready   = false;
      _cap.webgpu.failReason = null;
    } else if (runtimeId === RUNTIME.CPU) {
      _cap.cpu.checked = false;
      _cap.cpu.failed  = false;
      _cap.cpu.ready   = false;
      _cap.cpu.pipeline = null;
      _cap.cpu.failReason = null;
    } else if (runtimeId === RUNTIME.SHADOW_API) {
      _cap.shadowApi.checked = false;
      _cap.shadowApi.failed  = false;
      _cap.shadowApi.ready   = false;
      _cap.shadowApi.notDeployed = false;
      _cap.shadowApi.failReason = null;
    }

    // Reset overall state to re-attempt
    if (_activeRuntime === runtimeId || _state === STATE.DEGRADED) {
      _activeRuntime = null;
      _setState(STATE.UNINITIALIZED);
    }
  }

  // ─── Export ──────────────────────────────────────────────────────────────────

  global.SRInferenceRuntime = {
    RUNTIME:   RUNTIME,
    STATE:     STATE,
    AI_STATE:  AI_STATE,

    initialize:    initialize,
    generate:      generate,
    onStateChange: onStateChange,
    getStatus:     getStatus,
    getDiagnostics: getDiagnostics,
    resetRuntime:  resetRuntime,

    // For testing — expose internal capability state
    _cap: function () { return _cap; },
  };

})(typeof window !== 'undefined' ? window : global);
