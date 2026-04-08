/**
 * Lense — Client-side screen recorder
 *
 * Architecture:
 *   - Offscreen canvas: never in DOM, always compositing screen + webcam
 *   - MediaRecorder records the offscreen canvas stream directly
 *   - Lense tab shows a small live thumbnail for zoom selection only
 *   - User works in target tab; switches to Lense tab only to zoom/stop
 *   - Zoom: Shift+drag on thumbnail → region zoomed in recording. Esc to zoom out.
 *   - Webcam always recorded regardless of active tab
 */

// ─── Brand injection ──────────────────────────────────────────────────────────
(function injectBrandName() {
  document.querySelectorAll(".brand-name").forEach(el => {
    el.textContent = CONFIG.APP_NAME;
  });
  document.getElementById("page-title").textContent =
    `${CONFIG.APP_NAME} — ${CONFIG.TAGLINE}`;
  document.querySelectorAll("#nav-github, #footer-github").forEach(el => {
    el.href = CONFIG.GITHUB_URL;
  });
})();

// ─── Mobile gate ──────────────────────────────────────────────────────────────
(function checkMobile() {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (isMobile && !navigator.mediaDevices?.getDisplayMedia) {
    const warn = document.createElement("div");
    warn.className = "mobile-warning";
    warn.innerHTML = `
      <div class="logo-mark"></div>
      <h2>${CONFIG.APP_NAME}</h2>
      <p>Screen recording isn't supported on mobile browsers. Open ${CONFIG.APP_NAME} on a desktop — Chrome, Edge, or Firefox.</p>
    `;
    document.body.appendChild(warn);
    warn.style.display = "flex";
  }
})();

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  recording:      false,
  screenStream:   null,
  camStream:      null,
  micStream:      null,
  mediaRecorder:  null,
  chunks:         [],
  startTime:      null,
  timerInterval:  null,
  _screenVideo:   null,   // decodes screen stream
  _offscreen:     null,   // offscreen canvas — never in DOM
  _offCtx:        null,   // offscreen canvas 2d context

  // Zoom
  zoomActive:      false,
  zoomRect:        null,  // { x, y, w, h } target selection in source pixel coords
  zoomAnimating:   false,
  zoomAnimStart:   null,  // timestamp when animation began
  zoomFrom:        null,  // selection rect animating FROM
  zoomTo:          null,  // selection rect animating TO
  zoomCurrent:     null,  // current selection rect (for interrupted-zoom detection)
  zoomFromDraw:    null,  // pre-computed draw rect FROM {sx,sy,sw,sh}
  zoomToDraw:      null,  // pre-computed draw rect TO {sx,sy,sw,sh}
  zoomCurrentDraw: null,  // current lerped draw rect — used directly in drawImage

  // Shift+drag on thumbnail
  shiftHeld:      false,
  dragStart:      null,
  dragging:       false,

  // Webcam pip drag (visible in Lense tab for positioning)
  camDragging:    false,
  camDragOffset:  { x: 0, y: 0 },
  camX:           null,   // pip position, null = default bottom-right
  camY:           null,

  // Settings
  useCam:         true,
  useMic:         true,
  camShape:       "circle",

  // Event tracking — populated during recording for review panel
  zoomEvents:     [],   // { t: ms, type: "in"|"out" }
  durationMs:     0,

  // AI post-production state
  recordingBlob:   null,   // Blob of the recording for AI processing
  transcript:      null,   // { text, chunks } from Whisper
  aiSuggestions:   [],     // suggestion objects from suggestElements()
  ttsAudio:           null,   // { audioBuffer, sampleRate } from Kokoro
  useAIAudio:         false,  // true = use ttsAudio in export, false = use original mic
  rerenderedBlob:     null,   // final exported Blob with all AI elements baked in
  rerenderedBlobUrl:  null,   // object URL for rerenderedBlob — tracked for revocation

  // Full-screen recording detection
  isFullScreen:   false,

  // Working canvas — separate canvas updated ONLY while Lense tab is hidden.
  // For full-screen recordings: sv shows Lense tab when you switch back,
  // causing recursion. This canvas freezes the last frame of the working screen
  // the instant you arrive at the Lense tab — no race condition.
  // For window/tab recordings: not used (sv always shows the correct content).
  _workingCanvas:      null,
  _workingCtx:         null,
  _workingCanvasReady: false,  // true after first frame captured; guards against black frames at recording start

  // Legacy snapshot (kept for fallback)
  _thumbSnapshot: null,
  _snapInterval:  null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const landing        = $("landing");
const recorderEl     = $("recorder");
const startModal     = $("start-modal");
const thumbCanvas    = $("thumb-canvas");   // small live preview for zoom selection
const thumbCtx       = thumbCanvas.getContext("2d");
const dragBox        = $("drag-box");
const camPip         = $("cam-pip");
const camVideo       = $("cam-video");
const recTimer       = $("rec-timer");
const recDot         = $("rec-dot");
const zoomHint       = $("zoom-hint");
const zoomHintText   = $("zoom-hint-text");
const zoomIndicator  = $("zoom-indicator");
const modalError     = $("modal-error");
const btnGo          = $("btn-go");
const btnCancel      = $("btn-cancel");
const btnStop        = $("btn-stop");
const btnDiscard     = $("btn-discard");
const btnCamToggle   = $("btn-cam-toggle");
const btnCamShape    = $("btn-cam-shape");
const btnMicToggle   = $("btn-mic-toggle");
const btnZoomOut     = $("btn-zoom-out");
const toggleWebcam   = $("toggle-webcam");
const toggleMic      = $("toggle-mic");

// ─── Open modal ───────────────────────────────────────────────────────────────
function openModal() {
  startModal.classList.remove("hidden");
  modalError.classList.add("hidden");
  syncSettingsUI(); // ensure sliders/buttons reflect current CONFIG
}
$("nav-start-btn").addEventListener("click", openModal);
$("hero-start-btn").addEventListener("click", openModal);
btnCancel.addEventListener("click", () => {
  closeSettingsPanel();
  startModal.classList.add("hidden");
});

// ─── Start recording ──────────────────────────────────────────────────────────
btnGo.addEventListener("click", async () => {
  state.useCam = toggleWebcam.checked;
  state.useMic = toggleMic.checked;
  modalError.classList.add("hidden");
  btnGo.disabled = true;
  btnGo.innerHTML = `<span class="btn-icon">⬤</span> Starting…`;

  try {
    await startRecording();
    closeSettingsPanel();
    startModal.classList.add("hidden");
  } catch (err) {
    showModalError(err);
    // Clean up any partial streams on error
    [state.camStream, state.micStream, state.screenStream].forEach(s => {
      if (s) s.getTracks().forEach(t => t.stop());
    });
    state.camStream = state.micStream = state.screenStream = null;
  } finally {
    btnGo.disabled = false;
    btnGo.innerHTML = `<span class="btn-icon">⬤</span> Start Recording`;
  }
});

function showModalError(err) {
  let msg = "Could not start recording.";
  if (err.name === "NotAllowedError") msg = "Permission denied. Please allow access and try again.";
  if (err.name === "NotFoundError")   msg = "No screen found to capture.";
  if (err.name === "AbortError")      msg = "Screen selection was cancelled.";
  modalError.textContent = msg;
  modalError.classList.remove("hidden");
}

async function startRecording() {
  // ── STEP 1: Cam permission first — stays on Lense page ───────────────────
  if (state.useCam) {
    try {
      state.camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 320, facingMode: "user" },
        audio: false,
      });
      camVideo.srcObject = state.camStream;
      await camVideo.play();
      camPip.classList.remove("hidden-cam");
    } catch {
      state.useCam = false;
      camPip.classList.add("hidden-cam");
    }
  } else {
    camPip.classList.add("hidden-cam");
  }

  // ── STEP 2: Mic permission — still on Lense page ─────────────────────────
  let audioTracks = [];
  if (state.useMic) {
    try {
      state.micStream = await navigator.mediaDevices.getUserMedia({
        audio: true, video: false,
      });
      audioTracks = state.micStream.getAudioTracks();
    } catch { state.useMic = false; }
  }

  // ── STEP 3: Screen picker — user picks target, switches away ─────────────
  state.screenStream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30, cursor: "always" },
    audio: false,
  });

  // ── STEP 4: Hidden video decodes the screen stream ──────────────────────
  const sv = document.createElement("video");
  sv.srcObject = state.screenStream;
  sv.muted = true;
  await sv.play();
  state._screenVideo = sv;

  // ── STEP 4b: Detect full screen capture ──────────────────────────────────
  const trackSettings  = state.screenStream.getVideoTracks()[0].getSettings();
  state.isFullScreen   = (trackSettings.displaySurface === "monitor");

  // ── STEP 5: Set up offscreen canvas ───────────────────────────────────────
  // CRITICAL: Use sv.videoWidth/videoHeight AFTER play() — these are the
  // actual decoded stream dimensions. settings.width/height can be logical
  // pixels on Retina/HiDPI displays, causing stretching.
  // This canvas is NEVER inserted into the DOM.
  const srcW = sv.videoWidth  || 1920;
  const srcH = sv.videoHeight || 1080;

  const offscreen  = document.createElement("canvas");
  offscreen.width  = srcW;
  offscreen.height = srcH;
  state._offscreen = offscreen;
  state._offCtx    = offscreen.getContext("2d");

  // ── STEP 5b: Init working canvas for full-screen mode ────────────────────
  // Only needed for full-screen captures. Sized at thumbnail resolution — small.
  if (state.isFullScreen) {
    if (!state._workingCanvas) {
      state._workingCanvas = document.createElement("canvas");
      state._workingCtx    = state._workingCanvas.getContext("2d");
    }
    state._workingCanvas.width  = 1280; // fixed working resolution — enough for zoom selection
    state._workingCanvas.height = Math.round(1280 * srcH / srcW);
    // Prev-frame backup canvas — same dimensions, cleared on recording start.
    if (!_prevWorkingCanvas) {
      _prevWorkingCanvas = document.createElement("canvas");
      _prevWorkingCtx    = _prevWorkingCanvas.getContext("2d");
    }
    _prevWorkingCanvas.width   = 1280;
    _prevWorkingCanvas.height  = state._workingCanvas.height;
    _prevWorkingCanvasReady    = false;
    _prevWorkingCanvasSaveTime = 0;
    _wasLenseTabVisible        = false;
  }

  // ── STEP 6: Reset zoom + event state ────────────────────────────────────
  state.zoomActive  = false;
  state.zoomRect    = null;
  state.camX = state.camY = null;
  state.zoomEvents     = [];
  state.durationMs          = 0;
  state._thumbSnapshot      = null;
  state._workingCanvasReady = false;
  updateZoomUI();

  // ── STEP 7: Switch to recorder view ──────────────────────────────────────
  landing.classList.add("hidden");
  recorderEl.classList.remove("hidden");

  // ── STEP 8: Size thumbnail AFTER UI is visible so offsetWidth is correct ──
  // Thumbnail aspect ratio matches source. Used only for zoom region selection.
  await new Promise(r => setTimeout(r, 50)); // let layout paint
  const thumbW = thumbCanvas.offsetWidth || 640;
  const thumbH = Math.round(thumbW * srcH / srcW);
  thumbCanvas.width  = thumbW;
  thumbCanvas.height = thumbH;
  thumbCanvas.style.height = thumbH + "px";

  // ── STEP 9: Start render loop via Web Worker ─────────────────────────────
  // CRITICAL: Both requestAnimationFrame AND setInterval are throttled in
  // background tabs (Chrome clamps to ~1fps). Web Worker timers are NOT
  // throttled — they fire reliably at 30fps regardless of active tab.
  state.recording = true;
  state.startTime = Date.now();
  startRenderWorker();
  startTimer();

  // ── STEP 10: MediaRecorder records offscreen canvas stream ────────────────
  // Audio comes from mic. Video comes from offscreen canvas.
  // This is the actual recording — no Lense tab UI, no mirror.
  const offscreenStream = offscreen.captureStream(30);
  audioTracks.forEach(t => offscreenStream.addTrack(t));
  const mimeType = getSupportedMimeType();
  state.mediaRecorder = new MediaRecorder(offscreenStream, {
    mimeType,
    videoBitsPerSecond: 5_000_000,
  });
  state.chunks = [];
  state.mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) state.chunks.push(e.data);
  };
  state.mediaRecorder.onstop = saveVideo;
  state.mediaRecorder.start(200);

  // ── STEP 11: Handle user clicking "Stop sharing" in browser chrome ────────
  state.screenStream.getVideoTracks()[0].onended = () => stopRecording();

  recDot.classList.remove("hidden");
  updateCamButtonState();
  updateMicButtonState();
  showHint("idle");
  setTimeout(() => zoomHint.classList.add("fade"), 5000);

  // ── Periodic thumbnail snapshot while Lense tab is hidden ─────────────────
  // Captures the working screen every 500ms in the background so when the user
  // switches back to Lense tab to zoom, the thumbnail shows their actual working
  // content — not the Lense tab itself (which would cause recursion on full screen).
  // Single snapshot canvas — always overwritten, zero memory accumulation.
  startThumbSnapshots();
  document.addEventListener("visibilitychange", onVisibilityChange);
}

// One reusable snapshot canvas — created once, reused forever
let _snapCanvas = null;
let _snapCtx    = null;

function startThumbSnapshots() {
  if (!_snapCanvas) {
    _snapCanvas = document.createElement("canvas");
    _snapCtx    = _snapCanvas.getContext("2d");
  }
  // Capture every 500ms while recording — only when tab is hidden
  state._snapInterval = setInterval(() => {
    if (!state.recording || !state._screenVideo || !state._offscreen) return;
    if (!document.hidden) return; // only snapshot when we're in the background
    const sv = state._screenVideo;
    if (sv.readyState < 2) return;
    // Snapshot at thumbnail resolution — tiny, fast
    // Capture at 2x thumbnail resolution for crisp Retina rendering
    _snapCanvas.width  = (thumbCanvas.width  || 640) * 2;
    _snapCanvas.height = (thumbCanvas.height || 360) * 2;
    _snapCtx.drawImage(sv, 0, 0, _snapCanvas.width, _snapCanvas.height);
    // Store as ImageData — single allocation, always replaced
    state._thumbSnapshot = _snapCtx.getImageData(0, 0, _snapCanvas.width, _snapCanvas.height);
  }, 500);
}

function stopThumbSnapshots() {
  clearInterval(state._snapInterval);
  state._snapInterval  = null;
  state._thumbSnapshot = null;
  document.removeEventListener("visibilitychange", onVisibilityChange);
}

function onVisibilityChange() {
  if (!state.recording) return;
  if (!document.hidden) {
    // User switched back to Lense tab — snapshot is already fresh (captured 0-500ms ago)
    // Thumbnail will use it automatically via renderFrame
  }
}

function getSupportedMimeType() {
  const types = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
    "video/mp4",
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

// Track the last time Chrome lost OS focus — used for address-bar grace period.
// When the user clicks Chrome's address bar, hasFocus() dips to false but sv
// still captures the Lense tab; a 200ms grace period prevents _workingCanvas
// from being contaminated during that transient.
let _lastBlurTime = document.hasFocus() ? -Infinity : Date.now();
let _prevHasFocus  = document.hasFocus();
window.addEventListener("blur", () => { _lastBlurTime = Date.now(); });

// Event-cached focus flag — backup for document.hasFocus() which may be unreliable
// on some systems (DevTools focused, file:// protocol quirks, accessibility tools, etc.).
// window.focus fires AFTER hasFocus() IPC so _windowHasFocus is never true before
// hasFocus() is true. The OR adds zero lag frames in the normal case; it only rescues
// the case where hasFocus() stays false after the user returns to Lense.
let _windowHasFocus = document.hasFocus();
window.addEventListener("focus", () => { _windowHasFocus = true; });
window.addEventListener("blur",  () => { _windowHasFocus = false; });

// One-frame-ago backup of _workingCanvas — used by the window.focus handler to
// undo contamination from the Branch B lag frame that runs when sv has already
// updated to show Lense UI but hasFocus() IPC hasn't arrived yet.
let _prevWorkingCanvas        = null;
let _prevWorkingCtx           = null;
let _prevWorkingCanvasReady   = false;
let _prevWorkingCanvasSaveTime = 0;     // throttle: save at most once per 200ms
let _wasLenseTabVisible        = false; // track Branch B→A transitions for restore

// Redundant backup: if window.focus fires (reliably), also restore there.
// Primary restore path is the B→A transition inside renderFrame (see below).
window.addEventListener("focus", () => {
  if (!state.recording || !state.isFullScreen || !state._workingCanvas || !state._workingCtx) return;
  if (_prevWorkingCanvasReady && _prevWorkingCtx) {
    state._workingCtx.drawImage(_prevWorkingCanvas, 0, 0,
      state._workingCanvas.width, state._workingCanvas.height);
    // _workingCanvasReady stays true — restored content is valid native-app frame
  }
  // else: leave _workingCanvas/_workingCanvasReady as-is
});

// ─── Web Worker render driver ─────────────────────────────────────────────────
// Chrome throttles timers in background tabs. Web Workers are exempt.
// The worker sends a "tick" message at 30fps; the main thread renders on each tick.
let _renderWorker = null;

const WORKER_CODE = `
  let interval = null;
  self.onmessage = function(e) {
    if (e.data === 'start') {
      interval = setInterval(() => self.postMessage('tick'), 1000 / 30);
    } else if (e.data === 'stop') {
      clearInterval(interval);
      interval = null;
    }
  };
`;

function startRenderWorker() {
  const blob = new Blob([WORKER_CODE], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);
  _renderWorker = new Worker(url);
  _renderWorker.onmessage = () => renderFrame();
  _renderWorker.postMessage('start');
  URL.revokeObjectURL(url);
}

function stopRenderWorker() {
  if (_renderWorker) {
    _renderWorker.postMessage('stop');
    _renderWorker.terminate();
    _renderWorker = null;
  }
}

// ─── Easing functions ─────────────────────────────────────────────────────────
function easingFn(t) {
  switch (CONFIG.ZOOM_EASING) {
    case "linear":     return t;
    case "ease-in":    return t * t * t;
    case "ease-out":   return 1 - Math.pow(1 - t, 3);
    case "ease-in-out":
    default:           return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2;
  }
}

function lerpRect(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    w: a.w + (b.w - a.w) * t,
    h: a.h + (b.h - a.h) * t,
  };
}

// Full-screen rect in source coords — the "zoomed out" state
function fullRect() {
  return { x: 0, y: 0, w: state._offscreen.width, h: state._offscreen.height };
}

// Compute the constrained DRAW rect {sx,sy,sw,sh} from a selection rect {x,y,w,h}.
// This is what actually gets passed to drawImage — after ZOOM_FACTOR, MAX_COVERAGE,
// and MIN_MAG constraints are applied. Used to pre-compute animation endpoints
// so the lerp happens in draw space, not selection space.
function selectionToDrawRect(sel) {
  const srcW = state._offscreen.width;
  const srcH = state._offscreen.height;
  const { x, y, w, h } = sel;

  // Full-screen selection = full-screen draw (zoomed out state)
  if (w >= srcW && h >= srcH) {
    return { sx: 0, sy: 0, sw: srcW, sh: srcH };
  }

  const factor = Math.min(1.0, Math.max(0.05, CONFIG.ZOOM_FACTOR));
  let sw = w / factor;
  let sh = h / factor;

  const maxW = srcW * Math.min(1.0, Math.max(0.1, CONFIG.ZOOM_MAX_COVERAGE));
  const maxH = srcH * Math.min(1.0, Math.max(0.1, CONFIG.ZOOM_MAX_COVERAGE));
  sw = Math.min(sw, maxW);
  sh = Math.min(sh, maxH);

  const minMag = Math.max(1.1, CONFIG.ZOOM_MIN_MAG);
  sw = Math.min(sw, srcW / minMag);
  sh = Math.min(sh, srcH / minMag);

  const cx = x + w / 2;
  const cy = y + h / 2;
  let sx = cx - sw / 2;
  let sy = cy - sh / 2;
  if (sx + sw > srcW) sx = srcW - sw;
  if (sy + sh > srcH) sy = srcH - sh;
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);
  sw = Math.min(sw, srcW - sx);
  sh = Math.min(sh, srcH - sy);

  return { sx, sy, sw, sh };
}

// Lerp between two draw rects {sx,sy,sw,sh}
function lerpDrawRect(a, b, t) {
  return {
    sx: a.sx + (b.sx - a.sx) * t,
    sy: a.sy + (b.sy - a.sy) * t,
    sw: a.sw + (b.sw - a.sw) * t,
    sh: a.sh + (b.sh - a.sh) * t,
  };
}

// Start a zoom animation.
// Pre-computes draw-space endpoints so lerp is smooth and constraint-free mid-flight.
function animateZoom(fromSel, toSel) {
  state.zoomAnimating  = true;
  state.zoomAnimStart  = performance.now();
  state.zoomFrom       = { ...fromSel };
  state.zoomTo         = { ...toSel };
  // Pre-compute draw rects for both endpoints
  state.zoomFromDraw   = selectionToDrawRect(fromSel);
  state.zoomToDraw     = selectionToDrawRect(toSel);
  state.zoomCurrentDraw = { ...state.zoomFromDraw };
}

// ─── Render frame ─────────────────────────────────────────────────────────────
// Called by the Web Worker at ~30fps, runs even when Lense tab is in background.
function renderFrame() {
  if (!state.recording || !state._offscreen || !state._screenVideo) return;

  const sv   = state._screenVideo;
  const oc   = state._offCtx;
  const srcW = state._offscreen.width;
  const srcH = state._offscreen.height;

  // Guard: video must be ready
  if (sv.readyState < 2) return;

  // Advance zoom animation in draw space (lerp between pre-computed rects).
  if (state.zoomAnimating) {
    const elapsed  = performance.now() - state.zoomAnimStart;
    const duration = CONFIG.ZOOM_DURATION_MS || 500;
    const rawT     = Math.min(1, elapsed / duration);
    const t        = easingFn(rawT);
    state.zoomCurrentDraw = lerpDrawRect(state.zoomFromDraw, state.zoomToDraw, t);
    if (rawT >= 1) {
      state.zoomAnimating   = false;
      state.zoomCurrentDraw = { ...state.zoomToDraw };
      state.zoomCurrent     = { ...state.zoomTo };
    }
  }
  const isZoomed = state.zoomActive || state.zoomAnimating;

  // ── BRANCH A: Lense tab is visible — sv captures Lense UI, must not use it ──
  // sv shows the Lense UI whenever Chrome has OS focus AND the Lense tab is
  // active. Drawing sv to the recording would capture the UI into the video
  // (causing recursive self-reference). Instead draw frozen _workingCanvas.
  //
  // Use document.hasFocus() synchronously rather than an event-cached flag.
  // hasFocus() updates at the SAME TIME sv switches to capturing the Lense tab;
  // the window.focus event fires AFTER. An event-cached flag would have a race
  // window of 1-2 frames where sv already shows Lense UI but the flag still
  // says "not focused" → Branch B contaminates _workingCanvas → recursion.
  //
  // Grace period: if hasFocus() just became false (<200ms ago), treat the tab
  // as still visible. Handles address-bar clicks where hasFocus() dips but sv
  // still captures the Lense tab.
  const hasFocus = document.hasFocus() || _windowHasFocus;
  // Eagerly detect focus loss before the async blur event fires.
  // When clicking a native app, hasFocus() drops immediately (OS state) while
  // window.blur fires later via IPC. The renderFrame between them would otherwise
  // run Branch B with a stale sv frame (Lense UI) → _workingCanvas contamination.
  if (_prevHasFocus && !hasFocus) _lastBlurTime = Date.now();
  _prevHasFocus = hasFocus;
  const justLostFocus = !hasFocus && (Date.now() - _lastBlurTime < 200);
  const lenseTabVisible = !document.hidden && (hasFocus || justLostFocus);

  // ── Branch B→A transition: lenseTabVisible just became true ────────────────
  // This fires on the render tick AFTER all lag frames finish (lag frames have
  // lenseTabVisible=false). Restoring here mirrors how the browser-tab path works
  // implicitly: document.hidden flipping false→true triggers a clean B→A without
  // any window.focus event dependency.
  //
  // The throttled _prevWorkingCanvas (saved at most once per 200ms) is guaranteed
  // to contain pre-contamination native-app content even if 2+ lag frames ran.
  if (state.isFullScreen && lenseTabVisible && !_wasLenseTabVisible) {
    if (_prevWorkingCanvasReady && _prevWorkingCtx && state._workingCanvas && state._workingCtx) {
      state._workingCtx.drawImage(_prevWorkingCanvas, 0, 0,
        state._workingCanvas.width, state._workingCanvas.height);
      // _workingCanvasReady stays true — restored content is valid native-app frame
    } else {
      // No clean backup yet (recording just started or very fast switch).
      // Clear thumbnail to blank so a stale Lense UI frame can't persist.
      state._workingCanvasReady = false;
      thumbCtx.clearRect(0, 0, thumbCanvas.width, thumbCanvas.height);
    }
  }
  _wasLenseTabVisible = lenseTabVisible;

  if (state.isFullScreen && lenseTabVisible) {
    oc.clearRect(0, 0, srcW, srcH);

    if (state._workingCanvasReady && state._workingCanvas) {
      if (isZoomed && state.zoomCurrentDraw) {
        // zoomCurrentDraw is in srcW/srcH space; remap to _workingCanvas space.
        let { sx, sy, sw, sh } = state.zoomCurrentDraw;
        const wScaleX = state._workingCanvas.width  / srcW;
        const wScaleY = state._workingCanvas.height / srcH;
        sx *= wScaleX; sy *= wScaleY; sw *= wScaleX; sh *= wScaleY;
        if (sw < state._workingCanvas.width * 0.99 || sh < state._workingCanvas.height * 0.99) {
          oc.drawImage(state._workingCanvas, sx, sy, sw, sh, 0, 0, srcW, srcH);
          if (state.zoomActive && !state.zoomAnimating) drawZoomBadge(oc);
        } else {
          oc.drawImage(state._workingCanvas, 0, 0, srcW, srcH);
        }
      } else {
        oc.drawImage(state._workingCanvas, 0, 0, srcW, srcH);
      }
    }

    if (state.useCam && state.camStream && camVideo.readyState >= 2) {
      drawCamOnOffscreen(oc, srcW, srcH);
    }

    // Thumbnail — show frozen work frame for zoom selection.
    // NOTE: previously this was skipped by an early return, leaving the
    // thumbnail stale. Now it always updates.
    if (state._workingCanvas && state._workingCanvasReady) {
      thumbCtx.drawImage(state._workingCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    }
    drawThumbZoomRect(srcW, srcH);
    return;
  }

  // ── BRANCH B: Work app is visible — sv shows real content ─────────────────
  // sv is at srcW×srcH resolution; draw directly with no coordinate scaling.
  oc.clearRect(0, 0, srcW, srcH);
  if (isZoomed && state.zoomCurrentDraw) {
    const { sx, sy, sw, sh } = state.zoomCurrentDraw;
    if (sw < srcW * 0.99 || sh < srcH * 0.99) {
      oc.drawImage(sv, sx, sy, sw, sh, 0, 0, srcW, srcH);
      if (state.zoomActive && !state.zoomAnimating) drawZoomBadge(oc);
    } else {
      oc.drawImage(sv, 0, 0, srcW, srcH);
    }
  } else {
    oc.drawImage(sv, 0, 0, srcW, srcH);
  }

  if (state.useCam && state.camStream && camVideo.readyState >= 2) {
    drawCamOnOffscreen(oc, srcW, srcH);
  }

  // Capture sv into the frozen work-frame buffer. This always runs in Branch B
  // so there is no code path that can leave _workingCanvas un-populated when
  // the user is in their work app.
  if (state.isFullScreen && state._workingCanvas) {
    // Save _workingCanvas to the backup BEFORE overwriting, throttled to once per 200ms.
    // Throttling prevents lag frames (33ms apart) from overwriting _prevWorkingCanvas
    // with Lense UI — the first lag frame's overwrite is blocked by the 200ms window,
    // keeping _prevWorkingCanvas on the last clean native-app content.
    if (state._workingCanvasReady && _prevWorkingCtx &&
        Date.now() - _prevWorkingCanvasSaveTime > 200) {
      _prevWorkingCtx.drawImage(state._workingCanvas, 0, 0,
        _prevWorkingCanvas.width, _prevWorkingCanvas.height);
      _prevWorkingCanvasReady    = true;
      _prevWorkingCanvasSaveTime = Date.now();
    }
    state._workingCtx.drawImage(sv,
      0, 0, state._workingCanvas.width, state._workingCanvas.height
    );
    state._workingCanvasReady = true;
  }

  // Thumbnail — prefer _prevWorkingCanvas (throttled backup, always pre-lag-frame native-app
  // content) over _workingCanvas, which may temporarily contain Lense UI during a lag frame.
  if (state.isFullScreen && state._workingCanvas && state._workingCanvasReady) {
    if (_prevWorkingCanvasReady && _prevWorkingCtx) {
      thumbCtx.drawImage(_prevWorkingCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    } else {
      thumbCtx.drawImage(state._workingCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
    }
  } else {
    thumbCtx.drawImage(sv, 0, 0, thumbCanvas.width, thumbCanvas.height);
  }
  drawThumbZoomRect(srcW, srcH);
}

// Draw the orange ZOOM badge onto the offscreen recording canvas.
// Called only when zoom is fully settled (not mid-animation).
function drawZoomBadge(oc) {
  oc.save();
  oc.fillStyle = "rgba(249,115,22,0.88)";
  oc.roundRect(16, 16, 80, 30, 6);
  oc.fill();
  oc.fillStyle = "#fff";
  oc.font = "bold 13px sans-serif";
  oc.textBaseline = "middle";
  oc.fillText("🔍 ZOOM", 30, 31);
  oc.restore();
}

// Draw the active zoom selection outline onto the thumbnail canvas.
function drawThumbZoomRect(srcW, srcH) {
  if (!state.zoomActive || !state.zoomRect) return;
  const scaleX = thumbCanvas.width  / srcW;
  const scaleY = thumbCanvas.height / srcH;
  const { x, y, w, h } = state.zoomRect;
  thumbCtx.save();
  thumbCtx.strokeStyle = "rgba(249,115,22,0.9)";
  thumbCtx.lineWidth   = 2;
  thumbCtx.setLineDash([4, 3]);
  thumbCtx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);
  thumbCtx.restore();
}

// Draw webcam onto offscreen canvas at a fixed corner position
function drawCamOnOffscreen(oc, srcW, srcH) {
  // Cam pip size in source pixels
  const pipSize = Math.round(srcW * 0.14); // ~14% of width
  const margin  = Math.round(srcW * 0.02);

  // Position: use stored camX/camY (set when user drags pip in Lense tab)
  // Default: bottom-right corner
  const pipW = state.camShape === "circle" ? pipSize : Math.round(pipSize * 1.4);
  const pipH = pipSize;
  const px   = state.camX !== null ? state.camX : srcW - pipW - margin;
  const py   = state.camY !== null ? state.camY : srcH - pipH - margin;

  oc.save();
  if (state.camShape === "circle") {
    const r = pipSize / 2;
    oc.beginPath();
    oc.arc(px + r, py + r, r, 0, Math.PI * 2);
    oc.clip();
  } else {
    oc.beginPath();
    oc.roundRect(px, py, pipW, pipH, 12);
    oc.clip();
  }
  oc.drawImage(camVideo, px, py, pipW, pipH);
  oc.restore();

  // Border ring
  oc.save();
  oc.strokeStyle = "rgba(255,255,255,0.3)";
  oc.lineWidth   = 3;
  if (state.camShape === "circle") {
    oc.beginPath();
    oc.arc(px + pipSize/2, py + pipSize/2, pipSize/2, 0, Math.PI * 2);
    oc.stroke();
  } else {
    oc.beginPath();
    oc.roundRect(px, py, pipW, pipH, 12);
    oc.stroke();
  }
  oc.restore();
}

// ─── Thumbnail: Shift+drag to select zoom region ──────────────────────────────
// The thumbnail shows a live preview of the recording.
// User holds Shift and drags on the thumbnail to select a zoom region.
// That selection maps back to source pixel coords and zooms the offscreen render.

document.addEventListener("keydown", e => {
  if (!state.recording) return;

  if (e.key === "Shift" && !state.shiftHeld) {
    state.shiftHeld = true;
    thumbCanvas.style.cursor = "crosshair";
    thumbCanvas.closest(".thumb-container")?.classList.add("shift-active");
    showHint("shift");
    return;
  }
  if (e.key === "Escape") {
    zoomOut();
  }
});

document.addEventListener("keyup", e => {
  if (e.key !== "Shift") return;
  state.shiftHeld = false;
  // Do NOT cancel an active drag on Shift release.
  // User naturally releases Shift before or during mouse release.
  // The drag completes on mouseup regardless of Shift state.
  if (!state.dragging) {
    thumbCanvas.style.cursor = "default";
    thumbCanvas.closest(".thumb-container")?.classList.remove("shift-active");
    if (!state.zoomActive) showHint("idle");
  }
});

let lastClickTime = 0;

thumbCanvas.addEventListener("mousedown", e => {
  if (e.button !== 0) return;

  // Double-click = zoom out
  const now = Date.now();
  if (now - lastClickTime < 350) {
    zoomOut();
    lastClickTime = 0;
    return;
  }
  lastClickTime = now;

  if (!state.shiftHeld) return;

  state.dragging  = true;
  state.dragStart = { x: e.clientX, y: e.clientY };

  // Position drag box relative to viewport
  dragBox.style.left   = e.clientX + "px";
  dragBox.style.top    = e.clientY + "px";
  dragBox.style.width  = "0";
  dragBox.style.height = "0";
  dragBox.classList.remove("hidden");
  e.preventDefault();
});

document.addEventListener("mousemove", e => {
  if (!state.dragging) return;
  if (state.camDragging) return; // don't interfere with pip drag

  const x0 = state.dragStart.x, y0 = state.dragStart.y;
  dragBox.style.left   = Math.min(x0, e.clientX) + "px";
  dragBox.style.top    = Math.min(y0, e.clientY) + "px";
  dragBox.style.width  = Math.abs(e.clientX - x0) + "px";
  dragBox.style.height = Math.abs(e.clientY - y0) + "px";
});

document.addEventListener("mouseup", e => {
  if (!state.dragging) return;
  state.dragging = false;
  dragBox.classList.add("hidden");

  const W = Math.abs(e.clientX - state.dragStart.x);
  const H = Math.abs(e.clientY - state.dragStart.y);
  if (W < 15 || H < 15) return; // too small — ignore

  // Map thumbnail coords → source pixel coords
  const thumbRect = thumbCanvas.getBoundingClientRect();

  // Use thumbCanvas.width (pixel buffer) not thumbRect.width (CSS pixels)
  // to correctly account for CSS scaling of the canvas element.
  // Chain: drag CSS px → canvas buffer px → source video px
  const scaleX = state._offscreen.width  / thumbCanvas.width;
  const scaleY = state._offscreen.height / thumbCanvas.height;

  // Convert CSS drag position to canvas buffer pixels first
  const cssToCanvasX = thumbCanvas.width  / thumbRect.width;
  const cssToCanvasY = thumbCanvas.height / thumbRect.height;

  const dragLeft = (Math.min(state.dragStart.x, e.clientX) - thumbRect.left) * cssToCanvasX;
  const dragTop  = (Math.min(state.dragStart.y, e.clientY) - thumbRect.top)  * cssToCanvasY;
  const dragW    = W * cssToCanvasX;
  const dragH    = H * cssToCanvasY;

  // Then scale from canvas buffer px to source video px
  let x = dragLeft * scaleX;
  let y = dragTop  * scaleY;
  let w = dragW    * scaleX;
  let h = dragH    * scaleY;

  // Clamp to source bounds
  x = Math.max(0, x);
  y = Math.max(0, y);
  w = Math.min(w, state._offscreen.width  - x);
  h = Math.min(h, state._offscreen.height - y);

  // Enforce canvas aspect ratio on the zoom rect.
  // If the user drags a very thin or very wide strip, the result gets
  // badly stretched when drawn into the canvas. Snap the shorter dimension
  // to match the canvas aspect ratio, centered on the drag.
  const canvasAspect = state._offscreen.width / state._offscreen.height;
  const rectAspect   = w / h;

  if (rectAspect > canvasAspect) {
    // Too wide — expand height to match
    const targetH = w / canvasAspect;
    const deltaH  = targetH - h;
    y = Math.max(0, y - deltaH / 2);
    h = Math.min(state._offscreen.height - y, targetH);
  } else if (rectAspect < canvasAspect) {
    // Too tall — expand width to match
    const targetW = h * canvasAspect;
    const deltaW  = targetW - w;
    x = Math.max(0, x - deltaW / 2);
    w = Math.min(state._offscreen.width - x, targetW);
  }

  state.zoomRect   = { x, y, w, h };
  state.zoomActive = true;
  state.shiftHeld  = false;
  state.dragging   = false;

  // Animate from full screen → selected region.
  // If mid-animation, start from current selection rect so it flows continuously.
  const from = state.zoomCurrent && state.zoomAnimating
    ? { ...state.zoomCurrent }
    : fullRect();
  animateZoom(from, { x, y, w, h });

  // Log zoom-in event for review panel
  if (state.recording) {
    state.zoomEvents.push({ t: Date.now() - state.startTime, type: "in" });
  }

  thumbCanvas.style.cursor = "default";
  thumbCanvas.closest(".thumb-container")?.classList.remove("shift-active");
  updateZoomUI();
  showHint("zoomed");
  thumbCanvas.closest(".thumb-container").classList.add("zoomed");
});

function zoomOut() {
  thumbCanvas.closest(".thumb-container").classList.remove("zoomed");

  // Log zoom-out event for review panel
  if (state.recording && state.zoomActive) {
    state.zoomEvents.push({ t: Date.now() - state.startTime, type: "out" });
  }

  // Animate from current rect → full screen
  if (state._offscreen) {
    const from = state.zoomCurrent && (state.zoomActive || state.zoomAnimating)
      ? { ...state.zoomCurrent }
      : fullRect();
    animateZoom(from, fullRect());
  }

  state.zoomActive = false;
  state.zoomRect   = null;
  updateZoomUI();
  showHint("idle");
}

function updateZoomUI() {
  if (state.zoomActive) {
    zoomIndicator.classList.remove("hidden");
    btnZoomOut.classList.remove("hidden");
  } else {
    zoomIndicator.classList.add("hidden");
    btnZoomOut.classList.add("hidden");
  }
}

btnZoomOut.addEventListener("click", zoomOut);

// ─── Zoom hint ────────────────────────────────────────────────────────────────
let hintTimer = null;
function showHint(mode) {
  clearTimeout(hintTimer);
  zoomHint.classList.remove("fade");

  if (mode === "shift") {
    zoomHintText.innerHTML = `Drag to select the region you want to zoom into`;
  } else if (mode === "zoomed") {
    zoomHintText.innerHTML = `🔍 Zoomed in &nbsp;·&nbsp; Click <strong>Zoom Out</strong> or press <strong>Esc</strong>`;
  } else {
    zoomHintText.innerHTML = `Hold <strong>Shift</strong> + drag on the preview to zoom into any region`;
  }

  hintTimer = setTimeout(() => zoomHint.classList.add("fade"),
    mode === "idle" ? 5000 : mode === "zoomed" ? 8000 : 999999
  );
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function startTimer() {
  state.timerInterval = setInterval(() => {
    const elapsed = Date.now() - state.startTime;
    recTimer.textContent = formatTime(elapsed);
    if (elapsed >= CONFIG.MAX_REC_MS) stopRecording();
  }, 500);
}

function formatTime(ms) {
  const s  = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

// ─── Stop & save ──────────────────────────────────────────────────────────────
function stopRecording(discard = false) {
  if (!state.recording) return;
  state.recording  = false;
  state.durationMs = Date.now() - state.startTime;
  stopRenderWorker();
  clearInterval(state.timerInterval);

  if (discard) { cleanupStreams(); showLanding(); return; }

  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  } else {
    cleanupStreams(); showLanding();
  }
}

function saveVideo() {
  // Capture duration before cleanup
  state.durationMs = Date.now() - state.startTime;
  const mimeType = state.mediaRecorder.mimeType;
  const ext  = mimeType.includes("mp4") ? "mp4" : "webm";
  const blob = new Blob(state.chunks, { type: mimeType });
  state.recordingBlob = blob;   // store for AI processing
  const url  = URL.createObjectURL(blob);
  cleanupStreams();
  showReviewPanel(url, mimeType, ext);
}

function downloadVideo(url, ext) {
  const a  = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href     = url;
  a.download = `${CONFIG.APP_NAME.toLowerCase()}-${ts}.${ext}`;
  a.click();
}

function cleanupStreams() {
  stopThumbSnapshots();
  [state.screenStream, state.camStream, state.micStream].forEach(s => {
    if (s) s.getTracks().forEach(t => t.stop());
  });
  state.screenStream = state.camStream = state.micStream = null;
  state._screenVideo   = null;
  state._offscreen     = null;
  state._offCtx        = null;
  state.isFullScreen   = false;
  // Keep _workingCanvas allocated — it's reused across recordings
  // but reset its contents
  if (state._workingCtx && state._workingCanvas) {
    state._workingCtx.clearRect(0, 0, state._workingCanvas.width, state._workingCanvas.height);
  }
  if (_prevWorkingCtx && _prevWorkingCanvas) {
    _prevWorkingCtx.clearRect(0, 0, _prevWorkingCanvas.width, _prevWorkingCanvas.height);
  }
  _prevWorkingCanvasReady    = false;
  _prevWorkingCanvasSaveTime = 0;
  _wasLenseTabVisible        = false;
  recDot.classList.add("hidden");
  recTimer.textContent = "00:00";
}

function showLanding() {
  if (_ttsAudioContext && _ttsAudioContext.state !== 'closed') _ttsAudioContext.close();
  _ttsAudioContext = null;
  _ttsSourceNode   = null;

  recorderEl.classList.add("hidden");
  $("review-panel").classList.add("hidden");
  landing.classList.remove("hidden");
  state.zoomActive = false;
  state.zoomRect   = null;
  state.dragging   = false;
  state.shiftHeld  = false;
  dragBox.classList.add("hidden");
  thumbCanvas.style.cursor = "default";
  zoomIndicator.classList.add("hidden");
  btnZoomOut.classList.add("hidden");
  thumbCanvas.closest(".thumb-container")?.classList.remove("zoomed");
  state.zoomAnimating   = false;
  state.zoomCurrent     = null;
  state.zoomFrom        = null;
  state.zoomTo          = null;
  state.zoomFromDraw    = null;
  state.zoomToDraw      = null;
  state.zoomCurrentDraw = null;
}

btnStop.addEventListener("click",    () => stopRecording(false));
btnDiscard.addEventListener("click", () => {
  if (confirm("Discard this recording?")) stopRecording(true);
});

// ─── Control bar ──────────────────────────────────────────────────────────────
btnCamToggle.addEventListener("click", () => {
  state.useCam = !state.useCam;
  camPip.classList.toggle("hidden-cam", !state.useCam);
  updateCamButtonState();
});
btnCamShape.addEventListener("click", () => {
  state.camShape = state.camShape === "circle" ? "rect" : "circle";
  camPip.classList.toggle("rect", state.camShape === "rect");
});
btnMicToggle.addEventListener("click", () => {
  if (!state.micStream) return;
  const on = state.micStream.getAudioTracks()[0]?.enabled;
  state.micStream.getAudioTracks().forEach(t => { t.enabled = !on; });
  state.useMic = !on;
  updateMicButtonState();
});

function updateCamButtonState() { btnCamToggle.classList.toggle("active",  state.useCam); }
function updateMicButtonState() { btnMicToggle.classList.toggle("muted", !state.useMic); }

// ─── Webcam PIP drag in Lense tab ─────────────────────────────────────────────
// Moving the pip in the Lense tab updates state.camX/camY which controls
// where the webcam is drawn on the offscreen canvas (the actual recording).
camPip.addEventListener("mousedown", e => {
  state.camDragging = true;
  state.camDragOffset = {
    x: e.clientX - camPip.offsetLeft,
    y: e.clientY - camPip.offsetTop,
  };
  e.stopPropagation();
  e.preventDefault();
});
document.addEventListener("mousemove", e => {
  if (!state.camDragging) return;
  const rec = recorderEl.getBoundingClientRect();
  const nx  = Math.max(0, Math.min(e.clientX - state.camDragOffset.x, rec.width  - camPip.offsetWidth));
  const ny  = Math.max(0, Math.min(e.clientY - state.camDragOffset.y, rec.height - camPip.offsetHeight));
  camPip.style.left   = nx + "px";
  camPip.style.top    = ny + "px";
  camPip.style.right  = "auto";
  camPip.style.bottom = "auto";

  // Map pip position in Lense tab UI → source pixel coords for offscreen draw
  if (state._offscreen) {
    const scaleX = state._offscreen.width  / rec.width;
    const scaleY = state._offscreen.height / rec.height;
    state.camX = nx * scaleX;
    state.camY = ny * scaleY;
  }
});
document.addEventListener("mouseup", () => { state.camDragging = false; });

camPip.addEventListener("touchstart", e => {
  if (e.touches.length !== 1) return;
  const t = e.touches[0];
  state.camDragging   = true;
  state.camDragOffset = { x: t.clientX - camPip.offsetLeft, y: t.clientY - camPip.offsetTop };
  e.stopPropagation();
}, { passive: true });
document.addEventListener("touchmove", e => {
  if (!state.camDragging || e.touches.length !== 1) return;
  const t   = e.touches[0];
  const rec = recorderEl.getBoundingClientRect();
  const nx  = Math.max(0, Math.min(t.clientX - state.camDragOffset.x, rec.width  - camPip.offsetWidth));
  const ny  = Math.max(0, Math.min(t.clientY - state.camDragOffset.y, rec.height - camPip.offsetHeight));
  camPip.style.left   = nx + "px";
  camPip.style.top    = ny + "px";
  camPip.style.right  = "auto";
  camPip.style.bottom = "auto";
  if (state._offscreen) {
    const scaleX = state._offscreen.width  / rec.width;
    const scaleY = state._offscreen.height / rec.height;
    state.camX = nx * scaleX;
    state.camY = ny * scaleY;
  }
}, { passive: true });
document.addEventListener("touchend", () => { state.camDragging = false; });


// ─── Review panel ─────────────────────────────────────────────────────────────
function showReviewPanel(videoUrl, mimeType, ext) {
  recorderEl.classList.add("hidden");
  const panel = $("review-panel");
  panel.classList.remove("hidden");

  const dur = state.durationMs;

  // Video player
  const rv = $("rv-video");
  rv.src   = videoUrl;

  // Stats
  $("rv-stat-duration").textContent = formatTime(dur);
  $("rv-stat-zooms").textContent    = state.zoomEvents.filter(e => e.type === "in").length;

  // Build timeline and zoom list
  buildTimeline(dur);
  buildZoomList(dur);

  // Playhead sync
  rv.ontimeupdate = () => {
    const ph = $("rv-playhead");
    if (ph && dur) ph.style.left = (rv.currentTime / (dur / 1000) * 100) + "%";
  };

  // AI zoom preview: apply CSS transform to mirror what the re-render will do
  if (rv._aiZoomTimeUpdate) rv.removeEventListener('timeupdate', rv._aiZoomTimeUpdate);
  rv._aiZoomTimeUpdate = () => {
    const tMs = rv.currentTime * 1000;
    const z = elements.items.find(
      e => e.type === 'zoom' && e.source === 'ai' && typeof e.cx === 'number' &&
           tMs >= e.t && tMs <= e.t + e.duration
    );
    if (z) {
      const scale = 1 / Math.min(1.0, Math.max(0.05, CONFIG.ZOOM_FACTOR));
      rv.style.transition    = 'transform 0.3s ease';
      rv.style.transform     = `scale(${scale})`;
      rv.style.transformOrigin = `${z.cx * 100}% ${z.cy * 100}%`;
    } else {
      rv.style.transition    = 'transform 0.3s ease';
      rv.style.transform     = '';
      rv.style.transformOrigin = '';
    }
  };
  rv.addEventListener('timeupdate', rv._aiZoomTimeUpdate);

  // Timeline seek on click
  $("rv-timeline-wrap").addEventListener("click", e => {
    const r = $("rv-timeline-wrap").getBoundingClientRect();
    rv.currentTime = ((e.clientX - r.left) / r.width) * (rv.duration || 0);
  });

  $("rv-btn-download-webm").onclick = () => downloadVideo(videoUrl, ext);
  $("rv-btn-new").onclick = () => {
    URL.revokeObjectURL(videoUrl);
    if (state.rerenderedBlobUrl) {
      URL.revokeObjectURL(state.rerenderedBlobUrl);
      state.rerenderedBlobUrl = null;
    }
    showLanding();
  };

  // Reset AI state for this recording
  state.transcript        = null;
  state.aiSuggestions     = [];
  state.ttsAudio          = null;
  state.useAIAudio        = false;
  state.rerenderedBlob    = null;
  state.rerenderedBlobUrl = null;

  initReviewTabs();
  initAIPanel(dur);
}

function buildTimeline(dur) {
  const track = $("rv-timeline-track");
  track.innerHTML = "";
  if (!dur) return;

  // Zoom bands
  let zStart = null, zSource = null;
  state.zoomEvents.forEach(ev => {
    if (ev.type === "in") { zStart = ev.t; zSource = ev.source; }
    if (ev.type === "out" && zStart !== null) {
      const band = document.createElement("div");
      band.className = "rv-zoom-band" + (zSource === 'ai' ? ' rv-zoom-band-ai' : '');
      band.style.left  = (zStart / dur * 100) + "%";
      band.style.width = ((ev.t - zStart) / dur * 100) + "%";
      band.title = `${zSource === 'ai' ? 'AI zoom' : 'Zoom'}: ${formatTime(zStart)} – ${formatTime(ev.t)}`;
      track.appendChild(band);
      zStart = null; zSource = null;
    }
  });
  if (zStart !== null) {
    const band = document.createElement("div");
    band.className = "rv-zoom-band" + (zSource === 'ai' ? ' rv-zoom-band-ai' : '');
    band.style.left  = (zStart / dur * 100) + "%";
    band.style.width = ((dur - zStart) / dur * 100) + "%";
    track.appendChild(band);
  }

  // Zoom markers
  state.zoomEvents.forEach(ev => {
    const m = document.createElement("div");
    m.className = `rv-tl-marker ${ev.type === "in" ? "rv-marker-in" : "rv-marker-out"}`;
    m.style.left = (ev.t / dur * 100) + "%";
    m.title = (ev.type === "in" ? "Zoom in" : "Zoom out") + " — " + formatTime(ev.t);
    track.appendChild(m);
  });

  // Playhead
  const ph = document.createElement("div");
  ph.id = "rv-playhead"; ph.className = "rv-playhead";
  track.appendChild(ph);
}

function buildZoomList(dur) {
  const list   = $("rv-zoom-list");
  list.innerHTML = "";
  const ins = state.zoomEvents.filter(e => e.type === "in");

  if (!ins.length) {
    list.innerHTML = `<div class="rv-zoom-empty">No zooms recorded</div>`;
    return;
  }

  ins.forEach((ev, i) => {
    const item = document.createElement("div");
    item.className = "rv-zoom-item";
    item.innerHTML = `
      <div class="rv-zi-num">${i+1}</div>
      <div class="rv-zi-body">
        <div class="rv-zi-time">${formatTime(ev.t)}</div>
        <div class="rv-zi-label">Zoom ${i+1}</div>
      </div>
      <button class="rv-zi-seek" data-t="${ev.t/1000}">▶ Jump</button>
    `;
    item.querySelector(".rv-zi-seek").addEventListener("click", e => {
      const rv = $("rv-video");
      const t = parseFloat(e.target.dataset.t);
      if (!isNaN(t) && t >= 0) rv.currentTime = t;
      rv.play();
    });
    list.appendChild(item);
  });
}
// ─── Settings panel ───────────────────────────────────────────────────────────
// Completely isolated from recording logic.
// Reads/writes CONFIG live. Persists to localStorage.
// Preview canvas uses its own loop and never touches state._offscreen.

const SETTINGS_KEY = "lense_zoom_settings";

// Load saved settings into CONFIG on startup
(function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY));
    if (!saved || typeof saved !== "object") return;
    const EASING_VALUES = ["linear", "ease-in", "ease-out", "ease-in-out"];
    if (typeof saved.ZOOM_FACTOR === "number" &&
        saved.ZOOM_FACTOR >= 0.05 && saved.ZOOM_FACTOR <= 1.0)
      CONFIG.ZOOM_FACTOR = saved.ZOOM_FACTOR;
    if (typeof saved.ZOOM_DURATION_MS === "number" &&
        saved.ZOOM_DURATION_MS >= 200 && saved.ZOOM_DURATION_MS <= 1000)
      CONFIG.ZOOM_DURATION_MS = saved.ZOOM_DURATION_MS;
    if (EASING_VALUES.includes(saved.ZOOM_EASING))
      CONFIG.ZOOM_EASING = saved.ZOOM_EASING;
  } catch {}
})();

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      ZOOM_FACTOR:      CONFIG.ZOOM_FACTOR,
      ZOOM_DURATION_MS: CONFIG.ZOOM_DURATION_MS,
      ZOOM_EASING:      CONFIG.ZOOM_EASING,
    }));
  } catch {}
}

// ── Settings panel open/close (lives in modal now) ────────────────────────────
// Panel is a collapsible section inside the modal.
// Preview loop runs while panel is open, stops when modal closes.
const settingsPanel = $("settings-panel");
const btnSettings   = $("btn-settings");

btnSettings.addEventListener("click", () => {
  const isHidden = settingsPanel.classList.contains("hidden");
  settingsPanel.classList.toggle("hidden", !isHidden);
  const arrow = $("settings-arrow");
  if (arrow) arrow.textContent = isHidden ? "▾" : "▸";
  if (isHidden) {
    syncSettingsUI();
    startPreviewLoop();
  } else {
    stopPreviewLoop();
  }
});

// Stop preview when modal closes (cancel or start)
function closeSettingsPanel() {
  settingsPanel.classList.add("hidden");
  const arrow = $("settings-arrow");
  if (arrow) arrow.textContent = "▸";
  stopPreviewLoop();
}

// ── Sync UI to current CONFIG values ──────────────────────────────────────────
function syncSettingsUI() {
  const factorSlider   = $("sp-factor");
  const durationSlider = $("sp-duration");

  factorSlider.value   = CONFIG.ZOOM_FACTOR;
  durationSlider.value = CONFIG.ZOOM_DURATION_MS;

  $("sp-factor-val").textContent   = Math.round(CONFIG.ZOOM_FACTOR * 100) + "%";
  $("sp-duration-val").textContent = CONFIG.ZOOM_DURATION_MS + "ms";

  document.querySelectorAll(".sp-ease-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.ease === CONFIG.ZOOM_EASING);
  });
}

// ── Slider listeners ──────────────────────────────────────────────────────────
$("sp-factor").addEventListener("input", e => {
  CONFIG.ZOOM_FACTOR = parseFloat(e.target.value);
  $("sp-factor-val").textContent = Math.round(CONFIG.ZOOM_FACTOR * 100) + "%";
  saveSettings();
  resetPreview();
});

$("sp-duration").addEventListener("input", e => {
  CONFIG.ZOOM_DURATION_MS = parseInt(e.target.value);
  $("sp-duration-val").textContent = CONFIG.ZOOM_DURATION_MS + "ms";
  saveSettings();
  resetPreview();
});

// ── Easing button listeners ───────────────────────────────────────────────────
document.querySelectorAll(".sp-ease-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    CONFIG.ZOOM_EASING = btn.dataset.ease;
    document.querySelectorAll(".sp-ease-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.ease === CONFIG.ZOOM_EASING)
    );
    saveSettings();
    resetPreview();
  });
});

// ── Preview canvas — live animated demo ───────────────────────────────────────
// Uses a fake 16:9 "screen" with colored UI blocks.
// Demonstrates zoom in and out using the exact same easing math as real recording.
// Completely self-contained — no dependency on state._offscreen or recording.

const PREVIEW_W = 220; // virtual source width (matches canvas display width)
const PREVIEW_H = 124; // virtual source height (16:9 ≈ 220 * 9/16)

// Fixed zoom selection: right-center region (like zooming into main content)
const PREVIEW_SEL = {
  x: PREVIEW_W * 0.38,
  y: PREVIEW_H * 0.20,
  w: PREVIEW_W * 0.42,
  h: PREVIEW_H * 0.55,
};

let _previewInterval  = null;
let _previewAnimStart = null;
let _previewPhase     = "zoom-in"; // "zoom-in" | "hold-in" | "zoom-out" | "hold-out"
let _previewFromDraw  = null;
let _previewToDraw    = null;

// Draw a fake "screen" UI onto an offscreen canvas — sidebar, header, content blocks
function drawFakeScreen(ctx, W, H) {
  // Background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, W, H);

  // Sidebar
  ctx.fillStyle = "#16213e";
  ctx.fillRect(0, 0, W * 0.3, H);

  // Sidebar items
  const items = [0.15, 0.28, 0.41, 0.54, 0.67];
  items.forEach((y, i) => {
    ctx.fillStyle = i === 1 ? "#533483" : "#0f3460";
    ctx.fillRect(W * 0.04, H * y, W * 0.22, H * 0.09);
  });

  // Header bar
  ctx.fillStyle = "#0f3460";
  ctx.fillRect(W * 0.3, 0, W * 0.7, H * 0.14);

  // Header pills
  [[0.35, 0.03], [0.50, 0.03], [0.65, 0.03]].forEach(([x, y]) => {
    ctx.fillStyle = "#533483";
    ctx.fillRect(W * x, H * y, W * 0.1, H * 0.08);
  });

  // Main content area — cards
  const cards = [
    [0.32, 0.18, 0.62, 0.32],
    [0.32, 0.55, 0.30, 0.22],
    [0.65, 0.55, 0.30, 0.22],
  ];
  cards.forEach(([x, y, w, h]) => {
    ctx.fillStyle = "#0f3460";
    ctx.strokeStyle = "#533483";
    ctx.lineWidth = 0.5;
    ctx.fillRect(W*x, H*y, W*w, H*h);
    ctx.strokeRect(W*x, H*y, W*w, H*h);
  });

  // Text lines inside first card
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillRect(W*0.35, H*(0.23 + i*0.07), W * (0.3 - i*0.05), H*0.025);
  }
}

// Compute preview draw rect using CONFIG values (same math as selectionToDrawRect
// but with fixed fake dimensions instead of state._offscreen)
function previewSelToDrawRect(sel, zoomed) {
  if (!zoomed) return { sx: 0, sy: 0, sw: PREVIEW_W, sh: PREVIEW_H };

  const factor  = Math.min(1.0, Math.max(0.05, CONFIG.ZOOM_FACTOR));
  let sw = sel.w / factor;
  let sh = sel.h / factor;

  const maxW = PREVIEW_W * Math.min(1.0, Math.max(0.1, CONFIG.ZOOM_MAX_COVERAGE));
  const maxH = PREVIEW_H * Math.min(1.0, Math.max(0.1, CONFIG.ZOOM_MAX_COVERAGE));
  sw = Math.min(sw, maxW);
  sh = Math.min(sh, maxH);

  const minMag = Math.max(1.1, CONFIG.ZOOM_MIN_MAG);
  sw = Math.min(sw, PREVIEW_W / minMag);
  sh = Math.min(sh, PREVIEW_H / minMag);

  const cx = sel.x + sel.w / 2;
  const cy = sel.y + sel.h / 2;
  let sx = cx - sw / 2;
  let sy = cy - sh / 2;
  if (sx + sw > PREVIEW_W) sx = PREVIEW_W - sw;
  if (sy + sh > PREVIEW_H) sy = PREVIEW_H - sh;
  sx = Math.max(0, sx);
  sy = Math.max(0, sy);

  return { sx, sy, sw: Math.min(sw, PREVIEW_W-sx), sh: Math.min(sh, PREVIEW_H-sy) };
}

// Easing using CONFIG.ZOOM_EASING — same function as recording
function previewEase(t) {
  return easingFn(t); // reuse exact same easing function
}

function resetPreview() {
  _previewPhase     = "zoom-in";
  _previewAnimStart = performance.now();
  _previewFromDraw  = previewSelToDrawRect(PREVIEW_SEL, false);
  _previewToDraw    = previewSelToDrawRect(PREVIEW_SEL, true);
}

// The preview source canvas — drawn once, reused every frame
let _fakeScreenCanvas = null;

function getOrCreateFakeScreen() {
  if (_fakeScreenCanvas) return _fakeScreenCanvas;
  _fakeScreenCanvas = document.createElement("canvas");
  _fakeScreenCanvas.width  = PREVIEW_W;
  _fakeScreenCanvas.height = PREVIEW_H;
  drawFakeScreen(_fakeScreenCanvas.getContext("2d"), PREVIEW_W, PREVIEW_H);
  return _fakeScreenCanvas;
}

function renderPreviewFrame() {
  const canvas = $("sp-preview");
  if (!canvas) return;

  // Size canvas to match display size for crisp rendering
  if (canvas.width !== canvas.offsetWidth * 2) {
    canvas.width  = canvas.offsetWidth  * 2;
    canvas.height = canvas.offsetHeight * 2 || Math.round(canvas.width * PREVIEW_H / PREVIEW_W);
  }

  const pctx = canvas.getContext("2d");
  const W    = canvas.width;
  const H    = canvas.height;
  const now  = performance.now();
  const dur  = CONFIG.ZOOM_DURATION_MS;

  if (!_previewAnimStart) resetPreview();

  const elapsed = now - _previewAnimStart;

  let currentDraw;

  if (_previewPhase === "zoom-in") {
    const rawT = Math.min(1, elapsed / dur);
    const t    = previewEase(rawT);
    currentDraw = {
      sx: _previewFromDraw.sx + (_previewToDraw.sx - _previewFromDraw.sx) * t,
      sy: _previewFromDraw.sy + (_previewToDraw.sy - _previewFromDraw.sy) * t,
      sw: _previewFromDraw.sw + (_previewToDraw.sw - _previewFromDraw.sw) * t,
      sh: _previewFromDraw.sh + (_previewToDraw.sh - _previewFromDraw.sh) * t,
    };
    if (rawT >= 1) { _previewPhase = "hold-in"; _previewAnimStart = now; }

  } else if (_previewPhase === "hold-in") {
    currentDraw = { ..._previewToDraw };
    if (elapsed > 900) { _previewPhase = "zoom-out"; _previewAnimStart = now; }

  } else if (_previewPhase === "zoom-out") {
    const rawT = Math.min(1, elapsed / dur);
    const t    = previewEase(rawT);
    currentDraw = {
      sx: _previewToDraw.sx + (_previewFromDraw.sx - _previewToDraw.sx) * t,
      sy: _previewToDraw.sy + (_previewFromDraw.sy - _previewToDraw.sy) * t,
      sw: _previewToDraw.sw + (_previewFromDraw.sw - _previewToDraw.sw) * t,
      sh: _previewToDraw.sh + (_previewFromDraw.sh - _previewToDraw.sh) * t,
    };
    if (rawT >= 1) { _previewPhase = "hold-out"; _previewAnimStart = now; }

  } else { // hold-out
    currentDraw = { ..._previewFromDraw };
    if (elapsed > 500) { _previewPhase = "zoom-in"; _previewAnimStart = now; resetPreview(); }
  }

  // Draw fake screen cropped to currentDraw
  const fakeScreen = getOrCreateFakeScreen();
  const { sx, sy, sw, sh } = currentDraw;
  pctx.clearRect(0, 0, W, H);
  pctx.drawImage(fakeScreen, sx, sy, sw, sh, 0, 0, W, H);

  // Draw orange selection box outline (shows what region will be zoomed)
  if (_previewPhase === "hold-out" || _previewPhase === "zoom-in") {
    const scaleX = W / PREVIEW_W;
    const scaleY = H / PREVIEW_H;
    pctx.save();
    pctx.strokeStyle = "rgba(249,115,22,0.7)";
    pctx.lineWidth = 2;
    pctx.setLineDash([4, 3]);
    pctx.strokeRect(
      PREVIEW_SEL.x * scaleX,
      PREVIEW_SEL.y * scaleY,
      PREVIEW_SEL.w * scaleX,
      PREVIEW_SEL.h * scaleY
    );
    pctx.restore();
  }
}

function startPreviewLoop() {
  if (_previewInterval) return;
  resetPreview();
  _previewInterval = setInterval(renderPreviewFrame, 1000 / 30);
}

function stopPreviewLoop() {
  clearInterval(_previewInterval);
  _previewInterval = null;
}

// Sync settings UI on page load (in case saved settings differ from config defaults)
syncSettingsUI();

// ─── AI Settings panel ────────────────────────────────────────────────────────

const aiSettingsPanel = $("ai-settings-panel");
const btnAISettings   = $("btn-ai-settings");

btnAISettings.addEventListener("click", () => {
  const isHidden = aiSettingsPanel.classList.contains("hidden");
  aiSettingsPanel.classList.toggle("hidden", !isHidden);
  const arrow = $("ai-settings-arrow");
  if (arrow) arrow.textContent = isHidden ? "▾" : "▸";
  if (isHidden) syncAISettingsUI();
});

const AI_FEATURE_TOGGLE_MAP = {
  'ai-toggle-transcription': 'AI_FEATURE_TRANSCRIPTION',
  'ai-toggle-refinement':    'AI_FEATURE_REFINEMENT',
  'ai-toggle-tts':           'AI_FEATURE_TTS',
  'ai-toggle-zoom':          'AI_FEATURE_ZOOM',
  'ai-toggle-spotlight':     'AI_FEATURE_SPOTLIGHT',
  'ai-toggle-callout':       'AI_FEATURE_CALLOUT',
};

function syncAISettingsUI() {
  Object.entries(AI_FEATURE_TOGGLE_MAP).forEach(([id, key]) => {
    const el = $(id);
    if (el) el.checked = CONFIG[key];
  });

  // Autonomy buttons
  document.querySelectorAll('.ai-auto-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.level) === CONFIG.AI_AUTONOMY);
  });

  // Duration sliders
  const zDur = $('ai-zoom-dur');
  if (zDur) { zDur.value = CONFIG.AI_ZOOM_DURATION_MS; $('ai-zoom-dur-val').textContent = (CONFIG.AI_ZOOM_DURATION_MS / 1000).toFixed(1) + 's'; }
  const sDur = $('ai-spotlight-dur');
  if (sDur) { sDur.value = CONFIG.AI_SPOTLIGHT_DURATION_MS; $('ai-spotlight-dur-val').textContent = (CONFIG.AI_SPOTLIGHT_DURATION_MS / 1000).toFixed(1) + 's'; }
  const cDur = $('ai-callout-dur');
  if (cDur) { cDur.value = CONFIG.AI_CALLOUT_DURATION_MS; $('ai-callout-dur-val').textContent = (CONFIG.AI_CALLOUT_DURATION_MS / 1000).toFixed(1) + 's'; }
}

// Wire AI feature toggles
Object.entries(AI_FEATURE_TOGGLE_MAP).forEach(([id, key]) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener('change', () => saveConfig(key, el.checked));
});

// Wire autonomy buttons
document.querySelectorAll('.ai-auto-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const level = Number(btn.dataset.level);
    saveConfig('AI_AUTONOMY', level);
    document.querySelectorAll('.ai-auto-btn').forEach(b =>
      b.classList.toggle('active', Number(b.dataset.level) === level)
    );
  });
});

// Wire duration sliders
$('ai-zoom-dur').addEventListener('input', e => {
  const v = parseInt(e.target.value);
  saveConfig('AI_ZOOM_DURATION_MS', v);
  $('ai-zoom-dur-val').textContent = (v / 1000).toFixed(1) + 's';
});
$('ai-spotlight-dur').addEventListener('input', e => {
  const v = parseInt(e.target.value);
  saveConfig('AI_SPOTLIGHT_DURATION_MS', v);
  $('ai-spotlight-dur-val').textContent = (v / 1000).toFixed(1) + 's';
});
$('ai-callout-dur').addEventListener('input', e => {
  const v = parseInt(e.target.value);
  saveConfig('AI_CALLOUT_DURATION_MS', v);
  $('ai-callout-dur-val').textContent = (v / 1000).toFixed(1) + 's';
});

// Sync AI settings when modal opens
$("nav-start-btn").addEventListener("click", syncAISettingsUI);
$("hero-start-btn").addEventListener("click", syncAISettingsUI);

// Close AI panel when modal closes
btnCancel.addEventListener("click", () => {
  aiSettingsPanel.classList.add("hidden");
  const arrow = $("ai-settings-arrow");
  if (arrow) arrow.textContent = "▸";
}, true); // capture before the existing cancel handler

// ─── Review panel tabs ────────────────────────────────────────────────────────

function initReviewTabs() {
  document.querySelectorAll('.rv-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });
  // Start on Moments tab
  switchTab('moments');
}

function switchTab(name) {
  document.querySelectorAll('.rv-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === name)
  );
  document.querySelectorAll('.rv-tab-panel').forEach(p => {
    const active = p.id === 'tab-' + name;
    p.classList.toggle('active', active);
    p.classList.toggle('hidden', !active);
  });
}

// ─── Toast notifications ──────────────────────────────────────────────────────

function showToast(msg, duration = 3000) {
  let toast = $('ai-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ai-toast';
    toast.className = 'ai-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), duration);
}

// ─── AI panel: transcription + suggestions pipeline ──────────────────────────

function initAIPanel(durMs) {
  // Show/hide TTS section based on feature flag
  const ttsSection = $('ai-tts-section');
  if (ttsSection) ttsSection.classList.toggle('hidden', !CONFIG.AI_FEATURE_TTS);

  // Show export section
  const exportSection = $('ai-export-section');
  if (exportSection) exportSection.classList.remove('hidden');

  // Set up "Transcribe now" button
  const btnTranscribe = $('btn-transcribe');
  if (btnTranscribe) {
    btnTranscribe.addEventListener('click', () => runTranscription(), { once: true });
  }

  // Set up "Refine" button
  const btnRefine = $('btn-refine');
  if (btnRefine) {
    btnRefine.addEventListener('click', () => runRefinement());
  }

  // Set up TTS
  $('btn-gen-tts')?.addEventListener('click', () => runTTS());
  $('btn-tts-play')?.addEventListener('click', () => previewTTSAudio());
  $('btn-tts-use')?.addEventListener('click', () => {
    state.useAIAudio = true;
    showToast('AI voiceover selected for export');
  });
  $('btn-tts-discard')?.addEventListener('click', () => {
    state.useAIAudio = false;
    showToast('Original audio selected for export');
  });

  // Set up Export with AI
  $('btn-export-ai')?.addEventListener('click', () => runRerender());

  // Accept-all / show-dismissed
  $('btn-accept-all-ai')?.addEventListener('click', acceptAllSuggestions);
  $('btn-show-dismissed')?.addEventListener('click', () => {
    _showDismissed = !_showDismissed;
    renderSuggestions();
    updateDismissedBtn();
  });

  // Auto-start based on autonomy level
  const startAct = canAct('transcribe', 'start');
  if (startAct === 'auto' && CONFIG.AI_FEATURE_TRANSCRIPTION) {
    // Small delay so review panel is fully visible first
    setTimeout(() => runTranscription(), 500);
  } else if (startAct === 'ask' && CONFIG.AI_FEATURE_TRANSCRIPTION) {
    // Show the "Transcribe now" prompt (already visible in idle state)
  }
  // If transcription is off but suggestions are on, still run frame analysis
  if (!CONFIG.AI_FEATURE_TRANSCRIPTION && (CONFIG.AI_FEATURE_ZOOM || CONFIG.AI_FEATURE_SPOTLIGHT || CONFIG.AI_FEATURE_CALLOUT)) {
    setTimeout(() => runSuggestionsOnly(), 500);
  }
}

// ─── Transcription ────────────────────────────────────────────────────────────

async function runTranscription() {
  if (!state.recordingBlob) return;

  // Switch to Transcript tab so user can watch progress
  switchTab('transcript');

  const idleEl    = $('transcript-idle');
  const runningEl = $('transcript-running');
  const progressEl = $('transcript-progress');
  const labelEl   = $('transcript-progress-label');

  idleEl?.classList.add('hidden');
  runningEl?.classList.remove('hidden');

  try {
    state.transcript = await transcribeAudio(state.recordingBlob, p => {
      if (progressEl) progressEl.style.width = Math.round(p * 100) + '%';
      if (labelEl) labelEl.textContent = p < 0.2 ? 'Extracting audio…' :
        p < 0.8 ? 'Transcribing…' : 'Almost done…';
    });
  } catch (err) {
    runningEl?.classList.add('hidden');
    idleEl?.classList.remove('hidden');
    showToast('Transcription failed: ' + err.message, 5000);
    return;
  }

  runningEl?.classList.add('hidden');

  if (state.transcript && state.transcript.chunks.length > 0) {
    renderTranscriptWords();
    showToast('Transcript ready');

    // Auto-run suggestions now that we have a transcript
    runSuggestions();

    // L2/L3: auto-run refinement too
    const refineAct = canAct('refine', 'start');
    if (refineAct === 'auto' && CONFIG.AI_FEATURE_REFINEMENT) {
      setTimeout(() => runRefinement(), 200);
    }
  } else {
    if (labelEl) labelEl.textContent = 'No speech detected';
    runningEl?.classList.remove('hidden');
    // Still run frame-diff suggestions without transcript
    runSuggestionsOnly();
  }
}

function renderTranscriptWords() {
  const container = $('transcript-words');
  if (!container || !state.transcript) return;
  container.classList.remove('hidden');
  container.innerHTML = '';

  const rv = $('rv-video');
  state.transcript.chunks.forEach(chunk => {
    const span = document.createElement('span');
    span.className = 'transcript-word';
    span.textContent = chunk.text;
    span.dataset.start = chunk.timestamp[0];
    span.dataset.end   = chunk.timestamp[1] || chunk.timestamp[0];
    span.addEventListener('click', () => {
      if (rv) rv.currentTime = parseFloat(span.dataset.start);
    });
    container.appendChild(span);
  });

  // Show refine section
  const refineSection = $('transcript-refine');
  if (refineSection) refineSection.classList.remove('hidden');

  // Playhead sync: highlight current word.
  // Store the handler on the element so repeated calls replace it, not stack it.
  if (rv) {
    if (rv._transcriptTimeUpdate) rv.removeEventListener('timeupdate', rv._transcriptTimeUpdate);
    rv._transcriptTimeUpdate = () => {
      const t = rv.currentTime;
      container.querySelectorAll('.transcript-word').forEach(span => {
        const start = parseFloat(span.dataset.start);
        const end   = parseFloat(span.dataset.end);
        span.classList.toggle('active', t >= start && t <= end + 0.1);
      });
    };
    rv.addEventListener('timeupdate', rv._transcriptTimeUpdate);
  }
}

// ─── Script refinement ────────────────────────────────────────────────────────

async function runRefinement() {
  if (!state.transcript?.text) {
    showToast('No transcript to refine');
    return;
  }

  const btnRefine  = $('btn-refine');
  const scriptArea = $('transcript-script');
  const acceptBtn  = $('btn-refine-accept');
  const revertBtn  = $('btn-refine-revert');

  if (btnRefine) { btnRefine.disabled = true; btnRefine.textContent = 'Refining…'; }

  try {
    const result = await refineScript(state.transcript.text, p => {});
    if (scriptArea) {
      scriptArea.value    = result.refined;
      scriptArea.readOnly = false;
    }

    // L3: auto-accept if word diff is low
    if (CONFIG.AI_AUTONOMY === 3 && result.diffRatio <= CONFIG.AI_L3_REFINEMENT_MAX_DIFF) {
      state.transcript.text = result.refined;
      if (scriptArea) scriptArea.readOnly = true;
      showToast(`Script refined (${result.method}, auto-accepted)`);
    } else {
      // Show accept button
      if (acceptBtn) acceptBtn.style.display = '';
      if (revertBtn) revertBtn.classList.remove('hidden');
      showToast('Refinement ready — review and accept');
      switchTab('transcript');
    }

    if (acceptBtn) {
      acceptBtn.onclick = () => {
        state.transcript.text = scriptArea?.value || state.transcript.text;
        if (acceptBtn) acceptBtn.style.display = 'none';
        if (revertBtn) revertBtn.classList.add('hidden');
        showToast('Refined script accepted');
      };
    }
    if (revertBtn) {
      revertBtn.onclick = () => {
        if (scriptArea) scriptArea.value = state.transcript.text;
        if (acceptBtn) acceptBtn.style.display = 'none';
        if (revertBtn) revertBtn.classList.add('hidden');
      };
    }
  } catch (err) {
    showToast('Refinement failed: ' + err.message, 5000);
  } finally {
    if (btnRefine) { btnRefine.disabled = false; btnRefine.textContent = 'Refine with AI'; }
  }
}

// ─── AI suggestions ───────────────────────────────────────────────────────────

async function runSuggestions() {
  if (!state.recordingBlob) return;
  await _runSuggestionsInternal(state.transcript || { text: '', chunks: [] });
}

async function runSuggestionsOnly() {
  if (!state.recordingBlob) return;
  await _runSuggestionsInternal({ text: '', chunks: [] });
}

async function _runSuggestionsInternal(transcript) {
  const idleEl  = $('ai-analysis-idle');
  const runEl   = $('ai-analysis-running');
  const progEl  = $('ai-analysis-progress');
  const labelEl = $('ai-analysis-label');

  idleEl?.classList.add('hidden');
  runEl?.classList.remove('hidden');
  if (labelEl) labelEl.textContent = 'Analysing video…';

  try {
    const suggestions = await suggestElements(
      state.recordingBlob,
      transcript,
      p => {
        if (progEl) progEl.style.width = Math.round(p * 100) + '%';
        if (labelEl) labelEl.textContent = p < 0.7 ? 'Analysing frames…' : 'Finding moments…';
      }
    );

    state.aiSuggestions = suggestions;

    // Apply autonomy: auto-accept high-confidence suggestions
    suggestions.forEach(s => {
      const act = canAct('suggestions', 'commit', s.confidence);
      if (act === 'auto') {
        s.active = s.recommended;
        applySuggestion(s, false);
      }
    });

    renderSuggestions();

    const count = suggestions.filter(s => !s.dismissed).length;
    if (count) {
      const badge = $('ai-tab-badge');
      if (badge) { badge.textContent = count; badge.classList.remove('hidden'); }
      showToast(`${count} AI suggestion${count > 1 ? 's' : ''} ready`);

      const bulkActions = $('ai-bulk-actions');
      if (bulkActions) bulkActions.classList.remove('hidden');
    }

    // Render AI markers on timeline
    renderAIMarkers(
      $('rv-timeline-track'),
      state.durationMs,
      state.aiSuggestions
    );

  } catch (err) {
    if (labelEl) labelEl.textContent = 'Analysis failed';
    showToast('Suggestion analysis failed: ' + err.message, 5000);
  } finally {
    runEl?.classList.add('hidden');
    idleEl?.classList.remove('hidden');
  }
}

let _showDismissed = false;

function updateDismissedBtn() {
  const btn = $('btn-show-dismissed');
  if (!btn) return;
  const count = state.aiSuggestions.filter(s => s.dismissed).length;
  btn.textContent = `${_showDismissed ? 'Hide' : 'Show'} dismissed (${count})`;
}

function renderSuggestions() {
  renderSuggestionCards($('ai-suggestion-list'), state.aiSuggestions, {
    onAccept:    (s, applyAll) => { applySuggestion(s, applyAll); renderSuggestions(); refreshAITimeline(); },
    onDismiss:   (s) => {
      if (s.accepted) { unapplySuggestion(s); s.accepted = false; }
      s.dismissed = true;
      renderSuggestions(); refreshAITimeline(); updateDismissedBtn();
    },
    onRestore:   (s) => { s.dismissed = false; renderSuggestions(); refreshAITimeline(); updateDismissedBtn(); },
    onRemove:    (s) => {
      if (s.accepted) unapplySuggestion(s);
      state.aiSuggestions = state.aiSuggestions.filter(x => x._id !== s._id);
      renderSuggestions(); refreshAITimeline(); updateDismissedBtn();
    },
    onLabelEdit: () => {},
  }, _showDismissed);

  // Update tab badge
  const active = state.aiSuggestions.filter(s => !s.dismissed).length;
  const badge = $('ai-tab-badge');
  if (badge) { badge.textContent = active; badge.classList.toggle('hidden', active === 0); }

  // Disable Accept All when nothing is left to accept
  const acceptable = state.aiSuggestions.filter(s => !s.dismissed && !s.accepted).length;
  const acceptAllBtn = $('btn-accept-all-ai');
  if (acceptAllBtn) acceptAllBtn.disabled = acceptable === 0;

  // Hide bulk actions row entirely when no suggestions remain
  const bulkActions = $('ai-bulk-actions');
  if (bulkActions) bulkActions.classList.toggle('hidden', state.aiSuggestions.length === 0);
}

// skipRebuild lets acceptAllSuggestions batch the timeline rebuild.
function applySuggestion(s, applyAll, skipRebuild = false) {
  const newEls = suggestionToElements(s, applyAll);
  newEls.forEach(el => { el.suggId = s._id; elements.add(el); });

  newEls.filter(e => e.type === 'zoom').forEach(el => {
    state.zoomEvents.push({ t: el.t,              type: 'in',  source: 'ai', cx: el.cx, cy: el.cy, suggId: s._id });
    state.zoomEvents.push({ t: el.t + el.duration, type: 'out', source: 'ai', suggId: s._id });
  });

  if (!skipRebuild) buildTimeline(state.durationMs);
  s.accepted = true;
}

function unapplySuggestion(s) {
  elements.removeBySugg(s._id);
  state.zoomEvents = state.zoomEvents.filter(e => e.suggId !== s._id);
  buildTimeline(state.durationMs);
  buildZoomList(state.durationMs);
}

function acceptAllSuggestions() {
  state.aiSuggestions.filter(s => !s.dismissed).forEach(s => {
    if (!s.accepted) {
      if (!s.active) s.active = s.recommended;
      applySuggestion(s, false, true);
    }
  });
  buildTimeline(state.durationMs);
  renderSuggestions();
  refreshAITimeline();
  showToast('All suggestions applied');
}

function refreshAITimeline() {
  renderAIMarkers($('rv-timeline-track'), state.durationMs, state.aiSuggestions);
}

// ─── TTS ──────────────────────────────────────────────────────────────────────

let _ttsAudioContext = null;
let _ttsSourceNode   = null;

async function runTTS() {
  if (!state.transcript?.text) {
    showToast('No transcript — run transcription first');
    return;
  }

  const btn    = $('btn-gen-tts');
  const voice  = $('ai-voice-select')?.value || 'af_heart';
  const text   = state.transcript.text;

  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }

  try {
    const result = await generateTTS(text, voice, p => {});
    state.ttsAudio = result;

    // L3: auto-select as export audio
    if (CONFIG.AI_AUTONOMY === 3) {
      state.useAIAudio = true;
      showToast('Voiceover generated and selected for export');
    } else {
      showToast('Voiceover ready — preview and accept');
      switchTab('ai');
    }

    $('ai-tts-preview')?.classList.remove('hidden');
    renderWaveform(result.audioBuffer);
  } catch (err) {
    showToast('TTS failed: ' + err.message, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate voiceover'; }
  }
}

function previewTTSAudio() {
  if (!state.ttsAudio) return;
  if (_ttsSourceNode) { try { _ttsSourceNode.stop(); } catch {} }
  if (!_ttsAudioContext || _ttsAudioContext.state === 'closed') {
    _ttsAudioContext = new AudioContext();
  }
  _ttsSourceNode = _ttsAudioContext.createBufferSource();
  _ttsSourceNode.buffer = state.ttsAudio.audioBuffer;
  _ttsSourceNode.connect(_ttsAudioContext.destination);
  _ttsSourceNode.start();
}

function renderWaveform(audioBuffer) {
  const waveEl = $('ai-waveform');
  if (!waveEl) return;
  const data    = audioBuffer.getChannelData(0);
  const samples = 80;
  const step    = Math.floor(data.length / samples);
  let bars      = '';
  for (let i = 0; i < samples; i++) {
    let max = 0;
    for (let j = 0; j < step; j++) max = Math.max(max, Math.abs(data[i * step + j] || 0));
    const h = Math.round(max * 40) + 2;
    bars += `<span class="wf-bar" style="height:${h}px"></span>`;
  }
  waveEl.innerHTML = bars;
}

// ─── Re-render pipeline ───────────────────────────────────────────────────────

async function runRerender() {
  if (!state.recordingBlob) return;

  const btn       = $('btn-export-ai');
  const progWrap  = $('ai-export-progress-wrap');
  const progFill  = $('ai-export-progress');

  if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
  if (progWrap) progWrap.classList.remove('hidden');

  try {
    const blob = await rerenderVideo(state.recordingBlob, p => {
      if (progFill) progFill.style.width = Math.round(p * 100) + '%';
    });
    state.rerenderedBlob    = blob;
    const url = URL.createObjectURL(blob);
    state.rerenderedBlobUrl = url;
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';

    // Update video player to show re-rendered version (zooms baked in — remove CSS preview)
    const rv = $('rv-video');
    if (rv) {
      rv.src = url;
      rv.style.transform = '';
      rv.style.transformOrigin = '';
      if (rv._aiZoomTimeUpdate) {
        rv.removeEventListener('timeupdate', rv._aiZoomTimeUpdate);
        rv._aiZoomTimeUpdate = null;
      }
    }

    // Update download button to use re-rendered version
    $('rv-btn-download-webm').onclick = () => downloadVideo(url, ext);

    showToast('Export ready — download button updated');
  } catch (err) {
    showToast('Export failed: ' + err.message, 5000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Export with AI'; }
    if (progWrap) progWrap.classList.add('hidden');
  }
}

async function rerenderVideo(srcBlob, onProgress) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src   = URL.createObjectURL(srcBlob);
    video.muted = true;
    video.preload = 'metadata';

    video.addEventListener('loadedmetadata', async () => {
      const W = video.videoWidth;
      const H = video.videoHeight;
      const duration = video.duration;

      const canvas = document.createElement('canvas');
      canvas.width  = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');

      // Audio setup
      const audioCtx = new AudioContext();
      let audioSource;
      if (state.useAIAudio && state.ttsAudio) {
        audioSource = audioCtx.createBufferSource();
        audioSource.buffer = state.ttsAudio.audioBuffer;
      } else {
        // decode original audio
        try {
          const ab = await srcBlob.arrayBuffer();
          const decoded = await audioCtx.decodeAudioData(ab);
          audioSource = audioCtx.createBufferSource();
          audioSource.buffer = decoded;
        } catch {
          // no audio track — proceed without audio
          audioSource = null;
        }
      }

      const dest = audioCtx.createMediaStreamDestination();
      if (audioSource) audioSource.connect(dest);

      const canvasStream = canvas.captureStream(30);
      if (audioSource) {
        dest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));
      }

      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(canvasStream, {
        mimeType,
        videoBitsPerSecond: 8_000_000,
      });

      const rerenderChunks = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) rerenderChunks.push(e.data); };
      recorder.onstop = () => {
        video.remove();
        URL.revokeObjectURL(video.src);
        audioCtx.close();
        const finalBlob = new Blob(rerenderChunks, { type: mimeType });
        resolve(finalBlob);
      };

      recorder.start(200);
      if (audioSource) audioSource.start(0);

      // Must be in DOM for requestVideoFrameCallback to fire (compositor requires it)
      video.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:-9999px';
      document.body.appendChild(video);

      video.requestVideoFrameCallback(function renderLoop(now, meta) {
        const tMs = meta.mediaTime * 1000;
        ctx.clearRect(0, 0, W, H);

        // Apply zoom if applicable (check state.zoomEvents pairs)
        _applyReplayZoom(ctx, video, tMs, W, H);

        // Apply elements (spotlights, callouts)
        drawElements(ctx, W, H, tMs);

        onProgress(Math.min(0.99, isFinite(duration) && duration > 0 ? meta.mediaTime / duration : 0));

        if (!video.ended && video.readyState >= 2) {
          video.requestVideoFrameCallback(renderLoop);
        } else {
          recorder.stop();
        }
      });

      video.play().catch(reject);
    });

    video.addEventListener('error', reject);
  });
}

/**
 * Apply the recorded zoom state at time tMs when re-rendering.
 * Reads state.zoomEvents to find active zoom intervals.
 */
function _applyReplayZoom(ctx, videoEl, tMs, W, H) {
  // Find the last 'in' event before tMs with no 'out' between it and tMs
  let activeZoom = null;
  for (let i = state.zoomEvents.length - 1; i >= 0; i--) {
    const ev = state.zoomEvents[i];
    if (ev.t > tMs) continue;
    if (ev.type === 'out') break;
    if (ev.type === 'in') { activeZoom = ev; break; }
  }

  if (activeZoom && activeZoom.cx !== undefined) {
    // AI zoom: cx/cy based — honour user's ZOOM_FACTOR setting
    const el = elements.items.find(e => e.type === 'zoom' && Math.abs(e.t - activeZoom.t) < 100);
    if (el) {
      const zf = Math.min(1.0, Math.max(0.05, CONFIG.ZOOM_FACTOR));
      const sw = W * zf;
      const sh = H * zf;
      const sx = Math.max(0, Math.min(el.cx * W - sw / 2, W - sw));
      const sy = Math.max(0, Math.min(el.cy * H - sh / 2, H - sh));
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, W, H);
      return;
    }
  }
  // Default: draw full frame
  ctx.drawImage(videoEl, 0, 0, W, H);
}

// Initial sync of AI settings UI
syncAISettingsUI();
