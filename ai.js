/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  LENSE — AI MODULE                                           ║
 * ║  All AI inference: Whisper STT, LLM refinement, Kokoro TTS,  ║
 * ║  frame-diff element suggestions, autonomy gating.            ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Design rules:
 * - No external URLs ever receive user audio, text, or frames.
 * - All models are loaded lazily on first use and cached via OPFS/Cache API.
 * - canAct() is the single gate for all autonomy-level decisions.
 * - Forbidden text rules are enforced on every AI text output.
 */

'use strict';

// ─── AUTONOMY GATE ────────────────────────────────────────────────────────────

/**
 * Decide whether the AI can take an action automatically, given the current
 * autonomy level and (optionally) the confidence score of the suggestion.
 *
 * @param {'transcribe'|'refine'|'suggestions'|'tts'|'rerender'} module
 * @param {'start'|'commit'} action  'start' = kick off the process; 'commit' = apply the result
 * @param {number} [confidence]  0–1 normalized confidence (for 'commit' on suggestions)
 * @returns {'auto'|'ask'|'block'}
 *   'auto'  = proceed silently (toast only)
 *   'ask'   = show UI and wait for explicit user action
 *   'block' = feature is disabled; do nothing
 */
function canAct(module, action, confidence = 1) {
  // Feature-level kill switch
  const featureMap = {
    transcribe:  'AI_FEATURE_TRANSCRIPTION',
    refine:      'AI_FEATURE_REFINEMENT',
    suggestions: null, // checked per-type by caller
    tts:         'AI_FEATURE_TTS',
    rerender:    null, // always allowed if user clicks Export
  };
  const featureKey = featureMap[module];
  if (featureKey && !CONFIG[featureKey]) return 'block';

  const level = CONFIG.AI_AUTONOMY;

  if (action === 'start') {
    // Level 1: must ask before starting any module
    if (level === 1) return 'ask';
    // Level 2+: auto-start (user reviews results)
    return 'auto';
  }

  if (action === 'commit') {
    if (level === 1) return 'ask';

    if (level === 2) {
      if (confidence >= CONFIG.AI_L2_AUTO_ACCEPT) return 'auto';
      if (confidence >= CONFIG.AI_MIN_CONFIDENCE) return 'ask';
      return 'block'; // below minimum — not shown
    }

    if (level === 3) {
      if (confidence >= CONFIG.AI_L3_AUTO_ACCEPT) return 'auto';
      if (confidence >= CONFIG.AI_MIN_CONFIDENCE) return 'ask';
      return 'block';
    }
  }

  return 'ask';
}

// ─── FORBIDDEN TEXT FILTER ────────────────────────────────────────────────────

const FORBIDDEN_WORDS = /\b(amazing|incredible|powerful|seamless|leverage|synergy)\b/gi;

/** Strip forbidden marketing words from AI-generated text. */
function cleanText(text) {
  return text.replace(FORBIDDEN_WORDS, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Measure what fraction of words in `refined` differ from `original`.
 * Used to decide whether L3 can auto-accept script refinement.
 */
function wordDiffRatio(original, refined) {
  const a = original.toLowerCase().split(/\s+/);
  const b = refined.toLowerCase().split(/\s+/);
  const setA = new Set(a);
  const changed = b.filter(w => !setA.has(w)).length;
  return changed / Math.max(b.length, 1);
}

// ─── MODEL HANDLES (lazy) ─────────────────────────────────────────────────────

let _whisperPipeline = null;
let _llmSession      = null;   // Chrome LanguageModel API session or SmolLM2 pipeline
let _kokoroTTS       = null;

// ─── FEATURE 1: AUTO-TRANSCRIPTION (WHISPER) ─────────────────────────────────

/**
 * Extract PCM audio from a recorded Blob and run Whisper inference.
 *
 * @param {Blob} recordingBlob
 * @param {function(number)} onProgress  0–1 progress callback
 * @returns {Promise<{text: string, chunks: Array<{text:string, timestamp:[number,number]}>}>}
 */
async function transcribeAudio(recordingBlob, onProgress = () => {}) {
  if (!CONFIG.AI_FEATURE_TRANSCRIPTION) throw new Error('Transcription disabled');

  onProgress(0.05);

  // 1. Decode audio track from webm → Float32Array at 16 kHz mono
  const ab = await recordingBlob.arrayBuffer();
  onProgress(0.10);

  const audioCtx = new AudioContext({ sampleRate: 16000 });
  let audioBuffer;
  try {
    audioBuffer = await audioCtx.decodeAudioData(ab);
  } catch {
    // Blob may be audio-less (screen-only); return empty transcript
    audioCtx.close();
    return { text: '', chunks: [] };
  }
  audioCtx.close();

  const pcm = audioBuffer.getChannelData(0); // already 16 kHz mono
  onProgress(0.20);

  // 2. Lazy-load Whisper pipeline
  if (!_whisperPipeline) {
    const { pipeline } = await import(
      'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js'
    );
    _whisperPipeline = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-base.en',
      {
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: 'word',
        progress_callback: p => onProgress(0.20 + p.progress * 0.60),
      }
    );
  }

  onProgress(0.80);

  // 3. Run inference
  const result = await _whisperPipeline(pcm, { return_timestamps: 'word' });
  onProgress(1.0);

  return {
    text:   result.text || '',
    chunks: result.chunks || [],
  };
}

// ─── FEATURE 2: SCRIPT REFINEMENT (LLM CASCADE) ──────────────────────────────

const REFINEMENT_PROMPT = `You are a transcript editor. Clean up this screen recording transcript.
Rules:
- Remove filler words (um, uh, like, you know, sort of)
- Fix obvious speech recognition errors based on context
- Keep all technical terms, UI element names, and step descriptions intact
- Do not add new content, only clean what is there
- Do not add exclamation points or emojis
- Output only the cleaned transcript, nothing else

Transcript:
`;

/**
 * Refine a raw transcript using LLM cascade:
 *   1. Chrome LanguageModel API (Gemini Nano, zero download)
 *   2. SmolLM2-360M-Instruct (WebGPU/WASM, ~400 MB one-time download)
 *   3. Return original on failure
 *
 * @param {string} rawText
 * @param {function(number)} onProgress
 * @returns {Promise<{refined: string, diffRatio: number, method: string}>}
 */
async function refineScript(rawText, onProgress = () => {}) {
  if (!CONFIG.AI_FEATURE_REFINEMENT) throw new Error('Refinement disabled');
  if (!rawText.trim()) return { refined: rawText, diffRatio: 0, method: 'passthrough' };

  onProgress(0.1);

  // Try 1: Chrome LanguageModel API
  try {
    if (typeof LanguageModel !== 'undefined') {
      const avail = await LanguageModel.availability();
      if (avail === 'available' || avail === 'downloadable') {
        if (!_llmSession) {
          _llmSession = await LanguageModel.create({
            systemPrompt: 'You are a concise transcript editor.',
          });
        }
        onProgress(0.4);
        const raw = await _llmSession.prompt(REFINEMENT_PROMPT + rawText);
        const refined = cleanText(raw);
        onProgress(1.0);
        return { refined, diffRatio: wordDiffRatio(rawText, refined), method: 'gemini-nano' };
      }
    }
  } catch { /* fall through */ }

  // Try 2: SmolLM2 via @huggingface/transformers
  try {
    if (!_llmSession || _llmSession._type !== 'smollm') {
      const { pipeline } = await import(
        'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js'
      );
      _llmSession = await pipeline(
        'text-generation',
        'HuggingFaceTB/SmolLM2-360M-Instruct',
        {
          dtype: 'q4',
          device: 'webgpu',
          progress_callback: p => onProgress(0.1 + p.progress * 0.7),
        }
      );
      _llmSession._type = 'smollm';
    }
    onProgress(0.85);
    const messages = [
      { role: 'system', content: 'You are a concise transcript editor.' },
      { role: 'user',   content: REFINEMENT_PROMPT + rawText },
    ];
    const out = await _llmSession(messages, { max_new_tokens: 512, return_full_text: false });
    const refined = cleanText(out[0]?.generated_text || rawText);
    onProgress(1.0);
    return { refined, diffRatio: wordDiffRatio(rawText, refined), method: 'smollm2' };
  } catch { /* fall through */ }

  // Fallback: return original unchanged
  return { refined: rawText, diffRatio: 0, method: 'passthrough' };
}

// ─── FEATURE 3: ELEMENT SUGGESTIONS (FRAME DIFF + TRANSCRIPT) ────────────────

const TRIGGERS = {
  zoom: {
    words: /\b(click|clicks|clicked|clicking|select|selecting|selected|tap|tapping|drag|dragging|type|typing|enter|entering|press|pressing|scroll|scrolling|copy|paste|open|opens|navigate|navigating|go\s+to|switch|switching|zoom|zooming)\b/i,
    phrases: /\b(here|right\s+here|over\s+here|this\s+(button|field|menu|item|area|section|icon)|that\s+(button|field|menu|area)|this\s+one|on\s+this|in\s+this|at\s+this)\b/i,
    multiplier: 2.0,
  },
  callout: {
    phrases: /\b(notice|notice\s+this|draw\s+attention|pay\s+attention|look\s+at|look\s+here|see\s+this|see\s+how|see\s+that|watch\s+this|watch\s+how|focus\s+on|important|note\s+that|highlight|this\s+is\s+key|key\s+thing|worth\s+noting|make\s+sure\s+you|don.t\s+miss|heads\s+up)\b/i,
    multiplier: 2.5,
  },
  spotlight: {
    phrases: /\b(focus\s+on\s+(this|here|that)|just\s+(look|focus|notice)|only\s+(this|here)|ignore\s+the\s+rest|this\s+area|this\s+part|this\s+section|I.ll\s+highlight|I.m\s+highlighting|let\s+me\s+show)\b/i,
    multiplier: 2.5,
  },
};

// Base intensity thresholds (applied to raw pixel diff intensity × phrase multiplier)
const ZOOM_THRESHOLD      = 0.12;
const CALLOUT_THRESHOLD   = 0.18;
const SPOTLIGHT_THRESHOLD = 0.20;

/**
 * Extract 1 frame per second from a video Blob.
 * Frames are processed pairwise as they're captured — only two frames live in
 * memory at once, keeping peak allocation to ~2×(W×H×4) bytes regardless of
 * recording length.
 *
 * @param {Blob} videoBlob
 * @param {function(number)} onProgress
 * @returns {Promise<Array<{t:number, cx:number, cy:number, intensity:number}>>}
 */
async function extractFrames(videoBlob, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = URL.createObjectURL(videoBlob);
    video.muted = true;
    video.preload = 'metadata';

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const activity = [];
    let prevData = null;  // only one frame's raw bytes held at a time

    video.addEventListener('loadedmetadata', () => {
      canvas.width  = Math.min(320, video.videoWidth);
      canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth);
      const W = canvas.width, H = canvas.height;
      const duration = video.duration;
      const total = Math.ceil(duration);
      let t = 0;

      const seekNext = () => {
        if (t > duration) {
          URL.revokeObjectURL(video.src);
          resolve(activity);
          return;
        }
        video.currentTime = t;
      };

      video.addEventListener('seeked', () => {
        ctx.drawImage(video, 0, 0, W, H);
        const currData = ctx.getImageData(0, 0, W, H).data;

        if (prevData === null) {
          activity.push({ t, cx: 0.5, cy: 0.5, intensity: 0 });
        } else {
          activity.push({ t, ...pixelDiff(prevData, currData, W, H) });
        }

        prevData = new Uint8ClampedArray(currData); // copy; ctx buffer reused each seek
        onProgress(t / total);
        t += 1;
        seekNext();
      });

      seekNext();
    });

    video.addEventListener('error', reject);
  });
}

/**
 * Compute pixel diff between two raw RGBA pixel buffers (Uint8ClampedArray).
 */
function pixelDiff(da, db, W, H) {
  let sumX = 0, sumY = 0, sumW = 0, totalDiff = 0;

  for (let i = 0; i < da.length; i += 4) {
    const dr = Math.abs(da[i]   - db[i]);
    const dg = Math.abs(da[i+1] - db[i+1]);
    const db2 = Math.abs(da[i+2] - db[i+2]);
    const diff = (dr + dg + db2) / (3 * 255);
    if (diff > 0.05) {  // ignore tiny noise
      const px = ((i / 4) % W) / W;
      const py = Math.floor((i / 4) / W) / H;
      sumX += px * diff;
      sumY += py * diff;
      sumW += diff;
    }
    totalDiff += diff;
  }

  const pixelCount = da.length / 4;
  return {
    cx: sumW > 0 ? sumX / sumW : 0.5,
    cy: sumW > 0 ? sumY / sumW : 0.5,
    intensity: Math.min(1, totalDiff / pixelCount * 8),  // scale up; raw values are small
  };
}

/** Group activity samples into clusters where samples are within `gapS` seconds of each other. */
function groupByProximity(activity, gapS) {
  if (!activity.length) return [];
  const groups = [];
  let current = [activity[0]];
  for (let i = 1; i < activity.length; i++) {
    if (activity[i].t - activity[i-1].t <= gapS) {
      current.push(activity[i]);
    } else {
      groups.push(current);
      current = [activity[i]];
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Analyse a video Blob + transcript to produce AI element suggestions.
 * Each suggestion may qualify for multiple effect types (zoom/callout/spotlight).
 *
 * @param {Blob} videoBlob
 * @param {{text:string, chunks:Array}} transcript
 * @param {function(number)} onProgress
 * @returns {Promise<Array>}  array of suggestion objects
 */
async function suggestElements(videoBlob, transcript, onProgress = () => {}) {
  // Check which types are enabled
  const zoomOn      = CONFIG.AI_FEATURE_ZOOM;
  const calloutOn   = CONFIG.AI_FEATURE_CALLOUT;
  const spotlightOn = CONFIG.AI_FEATURE_SPOTLIGHT;
  if (!zoomOn && !calloutOn && !spotlightOn) return [];

  // extractFrames returns activity directly (diffs computed pairwise during capture)
  const activity = await extractFrames(videoBlob, p => onProgress(p * 0.7));

  // Apply transcript trigger phrase multipliers
  activity.forEach(a => {
    const windowChunks = (transcript.chunks || []).filter(
      w => Math.abs(w.timestamp[0] - a.t) < 2
    );
    const windowText = windowChunks.map(w => w.text).join(' ');

    let bestMultiplier = 1;
    let bestType = null;

    for (const [type, cfg] of Object.entries(TRIGGERS)) {
      const matches =
        (cfg.words   && cfg.words.test(windowText)) ||
        (cfg.phrases && cfg.phrases.test(windowText));
      if (matches && cfg.multiplier > bestMultiplier) {
        bestMultiplier = cfg.multiplier;
        bestType = type;
      }
    }

    a.multiplier    = bestMultiplier;
    a.suggestedType = bestType;
    a.score         = a.intensity * bestMultiplier;
  });

  onProgress(0.80);

  // Group into moments and pick best peak per group
  const moments = groupByProximity(activity, 1.5);
  const suggestions = [];
  let lastT = -Infinity;

  moments.forEach(group => {
    const best = group.slice().sort((a, b) => b.score - a.score)[0];
    if (best.t - lastT < 3) return;

    // Determine which types this moment qualifies for (respect feature toggles)
    const qualified = [];
    if (zoomOn && best.score >= ZOOM_THRESHOLD)
      qualified.push({ type: 'zoom', score: best.score });
    if (calloutOn && best.score >= CALLOUT_THRESHOLD && best.suggestedType === 'callout')
      qualified.push({ type: 'callout', score: best.score });
    if (spotlightOn && best.score >= SPOTLIGHT_THRESHOLD && best.suggestedType === 'spotlight')
      qualified.push({ type: 'spotlight', score: best.score });

    if (!qualified.length) return;

    // Callout label: verbatim transcript words within ±1s
    const nearChunks = (transcript.chunks || []).filter(
      w => Math.abs(w.timestamp[0] - best.t) < 1.0
    );
    const label = nearChunks.map(w => w.text.trim()).join(' ').trim().slice(0, 60) || 'See this';

    // Confidence: normalized against 2× the most relevant threshold
    const primaryThreshold = qualified[qualified.length - 1].type === 'callout'
      ? CALLOUT_THRESHOLD
      : qualified[qualified.length - 1].type === 'spotlight'
        ? SPOTLIGHT_THRESHOLD
        : ZOOM_THRESHOLD;
    const confidence = Math.min(1, best.score / (primaryThreshold * 2));

    const recommended = qualified[qualified.length - 1].type; // highest-intent type

    suggestions.push({
      t:           Math.max(0, (best.t - 0.3) * 1000),  // ms
      qualified,
      recommended,
      active:      null,       // set when user/autopilot picks a type
      cx:          best.cx,
      cy:          best.cy,
      duration:    CONFIG['AI_' + recommended.toUpperCase() + '_DURATION_MS'] || 3000,
      label,
      score:       best.score,
      confidence,
      source:      'ai',
      dismissed:   false,
      _id:         Math.random().toString(36).slice(2, 9),
    });
    lastT = best.t;
  });

  onProgress(1.0);
  return suggestions.sort((a, b) => a.t - b.t);
}

// ─── FEATURE 4: TTS (KOKORO) ──────────────────────────────────────────────────

/**
 * Generate TTS audio from text using Kokoro-82M.
 *
 * @param {string} text
 * @param {string} voice  e.g. 'af_heart'
 * @param {function(number)} onProgress
 * @returns {Promise<{audioBuffer: AudioBuffer, sampleRate: number}>}
 */
async function generateTTS(text, voice = 'af_heart', onProgress = () => {}) {
  if (!CONFIG.AI_FEATURE_TTS) throw new Error('TTS disabled');
  if (!text.trim()) throw new Error('No text to synthesize');

  onProgress(0.05);

  if (!_kokoroTTS) {
    const { KokoroTTS } = await import(
      'https://cdn.jsdelivr.net/npm/kokoro-js@1/dist/kokoro.min.js'
    );
    _kokoroTTS = await KokoroTTS.from_pretrained(
      'onnx-community/Kokoro-82M-v1.0',
      {
        dtype:   'q8',
        device:  'wasm',   // fallback; kokoro-js uses webgpu automatically if available
        progress_callback: p => onProgress(0.05 + p.progress * 0.70),
      }
    );
  }

  onProgress(0.80);
  const audio = await _kokoroTTS.generate(text, { voice });
  onProgress(1.0);

  // audio is Float32Array PCM at 24 kHz
  const audioCtx = new AudioContext();
  const audioBuffer = audioCtx.createBuffer(1, audio.length, 24000);
  audioBuffer.copyToChannel(audio, 0);
  audioCtx.close();

  return { audioBuffer, sampleRate: 24000 };
}
