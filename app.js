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
  rafId:          null,
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

  // Full-screen recording detection
  isFullScreen:   false,

  // Working canvas — separate canvas updated ONLY while Lense tab is hidden.
  // For full-screen recordings: sv shows Lense tab when you switch back,
  // causing recursion. This canvas freezes the last frame of the working screen
  // the instant you arrive at the Lense tab — no race condition.
  // For window/tab recordings: not used (sv always shows the correct content).
  _workingCanvas: null,
  _workingCtx:    null,

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
  }

  // ── STEP 6: Reset zoom + event state ────────────────────────────────────
  state.zoomActive  = false;
  state.zoomRect    = null;
  state.camX = state.camY = null;
  state.zoomEvents     = [];
  state.durationMs     = 0;
  state._thumbSnapshot = null;
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

  // ── Draw to offscreen canvas (the recording) ──────────────────────────────
  oc.clearRect(0, 0, srcW, srcH);

  // ── Advance zoom animation in DRAW SPACE ────────────────────────────────
  // We lerp between pre-computed draw rects {sx,sy,sw,sh}, not selection rects.
  // This ensures sw/sh (the zoom level) animate smoothly — giving the cinematic
  // push-in/pull-out feel. Constraints are applied once at endpoints, not per frame.
  if (state.zoomAnimating) {
    const elapsed  = performance.now() - state.zoomAnimStart;
    const duration = CONFIG.ZOOM_DURATION_MS || 500;
    const rawT     = Math.min(1, elapsed / duration);
    const t        = easingFn(rawT);
    state.zoomCurrentDraw = lerpDrawRect(state.zoomFromDraw, state.zoomToDraw, t);
    if (rawT >= 1) {
      state.zoomAnimating   = false;
      state.zoomCurrentDraw = { ...state.zoomToDraw };
      // Sync zoomCurrent selection rect for interrupted-animation detection
      state.zoomCurrent = { ...state.zoomTo };
    }
  }

  // ── Draw frame ────────────────────────────────────────────────────────────
  const isZoomed = state.zoomActive || state.zoomAnimating;

  if (isZoomed && state.zoomCurrentDraw) {
    // Use the pre-computed, constraint-applied, lerped draw rect directly
    const { sx, sy, sw, sh } = state.zoomCurrentDraw;

    // Only draw zoomed if meaningfully different from full-screen
    if (sw < srcW * 0.99 || sh < srcH * 0.99) {
      oc.drawImage(sv, sx, sy, sw, sh, 0, 0, srcW, srcH);

      // Zoom badge — only when fully settled (not mid-animation)
      if (state.zoomActive && !state.zoomAnimating) {
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
    } else {
      oc.drawImage(sv, 0, 0, srcW, srcH);
    }
  } else {
    // Normal full-screen draw
    oc.drawImage(sv, 0, 0, srcW, srcH);
  }

  // Webcam always drawn regardless of active tab
  if (state.useCam && state.camStream && camVideo.readyState >= 2) {
    drawCamOnOffscreen(oc, srcW, srcH);
  }

  // ── Update working canvas (full-screen mode only) ────────────────────────
  // While Lense tab is hidden: sv shows the actual working screen. Capture it
  // continuously into _workingCanvas. The moment Lense tab becomes visible,
  // sv starts showing Lense tab instead. By updating _workingCanvas ONLY while
  // hidden, we guarantee it always contains working screen content, not Lense UI.
  if (state.isFullScreen && state._workingCanvas && document.hidden) {
    state._workingCtx.drawImage(sv,
      0, 0, state._workingCanvas.width, state._workingCanvas.height
    );
  }

  // ── Update thumbnail (visible in Lense tab for zoom selection) ────────────
  if (state.isFullScreen && state._workingCanvas) {
    // Full-screen mode: always use frozen working canvas — never live sv
    // (sv shows Lense tab when visible, causing recursion)
    thumbCtx.drawImage(state._workingCanvas,
      0, 0, thumbCanvas.width, thumbCanvas.height
    );
  } else {
    // Window/tab mode: sv always shows the target content — draw directly
    thumbCtx.drawImage(sv, 0, 0, thumbCanvas.width, thumbCanvas.height);
  }

  // Draw webcam pip on thumbnail too so user sees the full composition
  if (state.useCam && state.camStream && camVideo.readyState >= 2) {
    const pipSize = Math.round(thumbCanvas.width * 0.14);
    const margin  = Math.round(thumbCanvas.width * 0.02);
    const pipW = state.camShape === "circle" ? pipSize : Math.round(pipSize * 1.4);
    const pipH = pipSize;
    const px   = state.camX !== null
      ? state.camX * (thumbCanvas.width  / srcW)
      : thumbCanvas.width  - pipW - margin;
    const py   = state.camY !== null
      ? state.camY * (thumbCanvas.height / srcH)
      : thumbCanvas.height - pipH - margin;

    thumbCtx.save();
    if (state.camShape === "circle") {
      thumbCtx.beginPath();
      thumbCtx.arc(px + pipSize/2, py + pipSize/2, pipSize/2, 0, Math.PI * 2);
      thumbCtx.clip();
    } else {
      thumbCtx.beginPath();
      thumbCtx.roundRect(px, py, pipW, pipH, 6);
      thumbCtx.clip();
    }
    thumbCtx.drawImage(camVideo, px, py, pipW, pipH);
    thumbCtx.restore();
  }

  // Draw active zoom rect outline on thumbnail so user sees current zoom region
  if (state.zoomActive && state.zoomRect) {
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
  recDot.classList.add("hidden");
  recTimer.textContent = "00:00";
}

function showLanding() {
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

  // Timeline seek on click
  $("rv-timeline-wrap").addEventListener("click", e => {
    const r = $("rv-timeline-wrap").getBoundingClientRect();
    rv.currentTime = ((e.clientX - r.left) / r.width) * (rv.duration || 0);
  });

  $("rv-btn-download-webm").onclick = () => downloadVideo(videoUrl, ext);
  $("rv-btn-new").onclick = () => {
    URL.revokeObjectURL(videoUrl);
    showLanding();
  };
}

function buildTimeline(dur) {
  const track = $("rv-timeline-track");
  track.innerHTML = "";
  if (!dur) return;

  // Zoom bands
  let zStart = null;
  state.zoomEvents.forEach(ev => {
    if (ev.type === "in") { zStart = ev.t; }
    if (ev.type === "out" && zStart !== null) {
      const band = document.createElement("div");
      band.className = "rv-zoom-band";
      band.style.left  = (zStart / dur * 100) + "%";
      band.style.width = ((ev.t - zStart) / dur * 100) + "%";
      band.title = `Zoom: ${formatTime(zStart)} – ${formatTime(ev.t)}`;
      track.appendChild(band);
      zStart = null;
    }
  });
  if (zStart !== null) {
    const band = document.createElement("div");
    band.className = "rv-zoom-band";
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
      rv.currentTime = parseFloat(e.target.dataset.t);
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
    if (!saved) return;
    if (saved.ZOOM_FACTOR    !== undefined) CONFIG.ZOOM_FACTOR    = saved.ZOOM_FACTOR;
    if (saved.ZOOM_DURATION_MS !== undefined) CONFIG.ZOOM_DURATION_MS = saved.ZOOM_DURATION_MS;
    if (saved.ZOOM_EASING    !== undefined) CONFIG.ZOOM_EASING    = saved.ZOOM_EASING;
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

// ─── Pro / License ────────────────────────────────────────────────────────────
const LICENSE_KEY     = "lense_license_key";
const LICENSE_PLAN    = "lense_license_plan";
const LICENSE_TS      = "lense_license_ts";
const LICENSE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7-day offline grace

state.licenseKey = null;
state.isPro      = false;

(function loadLicense() {
  const key  = localStorage.getItem(LICENSE_KEY);
  const plan = localStorage.getItem(LICENSE_PLAN);
  const ts   = parseInt(localStorage.getItem(LICENSE_TS) || "0");
  if (key && plan && (Date.now() - ts) < LICENSE_TTL_MS) {
    state.licenseKey = key;
    state.isPro      = true;
  }
  updateProUI();
})();

function updateProUI() {
  const btn = $("rv-btn-pro");
  if (!btn) return;
  if (state.isPro) {
    btn.textContent  = "⚡ Pro";
    btn.classList.add("active");
  } else {
    btn.textContent  = "⚡ Go Pro";
    btn.classList.remove("active");
  }
  // Gate upload button
  const uploadBtn = $("rv-btn-upload");
  if (uploadBtn) {
    uploadBtn.disabled = !state.isPro;
    uploadBtn.title    = state.isPro ? "" : "Pro subscription required";
  }
  // Gate server AI button
  const serverBtn = $("rv-ai-use-server");
  if (serverBtn) serverBtn.classList.toggle("hidden", !state.isPro);
}

// License modal
$("rv-btn-pro").addEventListener("click", () => {
  $("license-modal").classList.remove("hidden");
  $("license-status").classList.add("hidden");
  const input = $("license-key-input");
  input.value = state.licenseKey || "";
  input.focus();
});
$("btn-license-cancel").addEventListener("click", () => {
  $("license-modal").classList.add("hidden");
});
$("btn-activate").addEventListener("click", async () => {
  const key = $("license-key-input").value.trim();
  if (!key) return;
  const btn    = $("btn-activate");
  const status = $("license-status");
  btn.disabled = true;
  btn.textContent = "Checking…";
  status.className = "license-status";
  status.textContent = "";

  try {
    const resp = await fetch("/license/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await resp.json();
    if (data.valid) {
      state.licenseKey = key;
      state.isPro      = true;
      localStorage.setItem(LICENSE_KEY,  key);
      localStorage.setItem(LICENSE_PLAN, data.plan);
      localStorage.setItem(LICENSE_TS,   Date.now().toString());
      status.className   = "license-status success";
      status.textContent = `✓ Pro activated (${data.plan})`;
      status.classList.remove("hidden");
      updateProUI();
      setTimeout(() => $("license-modal").classList.add("hidden"), 1500);
    } else {
      status.className   = "license-status error";
      status.textContent = "Invalid license key. Check your purchase confirmation email.";
      status.classList.remove("hidden");
    }
  } catch {
    status.className   = "license-status error";
    status.textContent = "Couldn't reach license server. Check your connection.";
    status.classList.remove("hidden");
  } finally {
    btn.disabled    = false;
    btn.textContent = "Activate";
  }
});

// ─── Sharing ──────────────────────────────────────────────────────────────────
let _shareVideoUrl = null;
let _shareMimeType = null;
let _shareExt      = null;
let _shareVideoBlob = null;

// Patch showReviewPanel to capture the blob and init share UI
const _origShowReviewPanel = showReviewPanel;
function showReviewPanel(videoUrl, mimeType, ext) {
  _shareVideoUrl  = videoUrl;
  _shareMimeType  = mimeType;
  _shareExt       = ext;
  _origShowReviewPanel(videoUrl, mimeType, ext);

  // Reset share UI
  $("rv-share-body").classList.remove("hidden");
  $("rv-share-uploading").classList.add("hidden");
  $("rv-share-done").classList.add("hidden");
  $("rv-share-error").classList.add("hidden");
  updateProUI();

  // Kick off AI pipeline
  triggerAIPipeline();
}

$("rv-btn-upload").addEventListener("click", async () => {
  if (!state.isPro) {
    $("license-modal").classList.remove("hidden");
    return;
  }
  await runShareUpload();
});

async function runShareUpload() {
  $("rv-share-body").classList.add("hidden");
  $("rv-share-uploading").classList.remove("hidden");
  $("rv-share-error").classList.add("hidden");

  try {
    // Fetch blob from object URL
    const blob = await fetch(_shareVideoUrl).then(r => r.blob());
    const filename = `lense-${new Date().toISOString().slice(0,19).replace(/[:.]/g,"-")}.${_shareExt}`;

    // Step 1: get signed URL
    setUploadLabel("Preparing upload…");
    const reqResp = await fetch("/upload/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": state.licenseKey,
      },
      body: JSON.stringify({ filename, size_bytes: blob.size }),
    });
    if (!reqResp.ok) {
      const msg = await reqResp.text();
      throw new Error(msg.includes("2 GB") ? "Recording is too large to share (2 GB limit)." : "Couldn't start upload. Try again.");
    }
    const { upload_url, video_id, public_url } = await reqResp.json();

    // Step 2: PUT directly to R2 with progress
    setUploadLabel("Uploading…");
    await uploadWithProgress(blob, upload_url, pct => {
      $("rv-upload-bar").style.width = pct + "%";
      setUploadLabel(`Uploading… ${pct}%`);
    });

    // Step 3: POST /share with metadata
    setUploadLabel("Generating link…");
    const shareResp = await fetch("/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_id,
        zoom_events: state.zoomEvents,
        duration_ms: state.durationMs,
        ai_results: state._aiResults || null,
      }),
    });
    if (!shareResp.ok) throw new Error(`Couldn't generate share link. Contact support with ID: ${video_id}`);
    const { share_url } = await shareResp.json();

    const fullUrl = window.location.origin + share_url;
    $("rv-share-link").value = fullUrl;
    $("rv-share-uploading").classList.add("hidden");
    $("rv-share-done").classList.remove("hidden");

  } catch (err) {
    $("rv-share-uploading").classList.add("hidden");
    $("rv-share-body").classList.remove("hidden");
    $("rv-share-error").textContent = err.message || "Upload failed. Try again.";
    $("rv-share-error").classList.remove("hidden");
  }
}

function setUploadLabel(text) {
  const el = $("rv-upload-label");
  if (el) el.textContent = text;
}

function uploadWithProgress(blob, url, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", blob.type || "video/webm");
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100));
    };
    xhr.onload  = () => (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error("Upload failed. Try again."));
    xhr.onerror = () => reject(new Error("Network error during upload. Try again."));
    xhr.send(blob);
  });
}

$("rv-share-copy").addEventListener("click", () => {
  const input = $("rv-share-link");
  navigator.clipboard.writeText(input.value).then(() => {
    const btn = $("rv-share-copy");
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = "Copy"; }, 2000);
  });
});

// ─── AI Pipeline ──────────────────────────────────────────────────────────────
state._aiResults = null;

function setAIStatus(html) {
  const el = $("rv-ai-status");
  if (el) el.innerHTML = html;
}

function showAIResults(results, source) {
  state._aiResults = results;

  if (results.summary) {
    const el = $("rv-ai-summary");
    el.innerHTML = `<div class="rv-ai-label">Summary</div><div class="rv-ai-text">${escHtml(results.summary)}</div>`;
    el.classList.remove("hidden");
  }

  if (results.chapters && results.chapters.length) {
    const el = $("rv-ai-chapters");
    const rv = $("rv-video");
    el.innerHTML = `<div class="rv-ai-label">Chapters</div>`;
    results.chapters.forEach(ch => {
      const item = document.createElement("div");
      item.className = "rv-ai-chapter";
      item.innerHTML = `<span class="rv-ai-ch-time" data-t="${ch.start_ms/1000}">${formatTime(ch.start_ms)}</span><span class="rv-ai-ch-title">${escHtml(ch.title)}</span>`;
      item.querySelector(".rv-ai-ch-time").addEventListener("click", e => {
        rv.currentTime = parseFloat(e.target.dataset.t);
        rv.play();
      });
      el.appendChild(item);
    });
    el.classList.remove("hidden");
  }

  if (results.action_items && results.action_items.length) {
    const el = $("rv-ai-actions");
    el.innerHTML = `<div class="rv-ai-label">Action Items</div>` +
      results.action_items.map(a => `<div class="rv-ai-action">→ ${escHtml(a)}</div>`).join("");
    el.classList.remove("hidden");
  }

  if (source === "local") {
    $("rv-ai-privacy").classList.remove("hidden");
    if (state.isPro) $("rv-ai-server-prompt").classList.remove("hidden");
  }

  setAIStatus("");
}

function escHtml(str) {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function triggerAIPipeline() {
  if (!_shareVideoUrl) return;
  setAIStatus('<span class="rv-ai-spinner"></span> Transcribing…');
  $("rv-ai-privacy").classList.add("hidden");
  $("rv-ai-server-prompt").classList.add("hidden");
  $("rv-ai-summary").classList.add("hidden");
  $("rv-ai-chapters").classList.add("hidden");
  $("rv-ai-actions").classList.add("hidden");
  state._aiResults = null;

  let transcript = null;
  try {
    transcript = await runTranscription(_shareVideoUrl);
  } catch {
    setAIStatus('<span class="rv-ai-note">Couldn\'t load transcription model. <button class="rv-ai-retry" onclick="triggerAIPipeline()">Retry</button></span>');
    return;
  }

  if (!transcript || !transcript.text || transcript.text.trim().length < 10) {
    setAIStatus('<span class="rv-ai-note">No speech detected.</span>');
    return;
  }

  setAIStatus('<span class="rv-ai-spinner"></span> Analyzing…');
  try {
    const results = await runAnalysis(transcript.text, state.zoomEvents, state.durationMs);
    showAIResults(results, "local");
  } catch (err) {
    if (err.message === "server-needed") {
      // Already prompted via showServerAIPrompt — do nothing more here
    } else {
      setAIStatus('<span class="rv-ai-note">Analysis failed. <button class="rv-ai-retry" onclick="triggerAIPipeline()">Retry</button></span>');
    }
  }
}

// ── Transcription (Whisper WASM via Transformers.js) ─────────────────────────
async function runTranscription(videoUrl) {
  // Lazy-load Transformers.js
  if (!window._transformers) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.type = "module";
      s.textContent = `
        import { pipeline } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
        window._transformersPipeline = pipeline;
        window._transformers = true;
        window.dispatchEvent(new Event('transformers-ready'));
      `;
      document.head.appendChild(s);
      const onReady = () => { window.removeEventListener("transformers-ready", onReady); resolve(); };
      window.addEventListener("transformers-ready", onReady);
      s.onerror = reject;
      setTimeout(() => reject(new Error("Transformers.js load timeout")), 30000);
    });
  }

  // Extract audio from video blob via AudioContext
  const blob    = await fetch(videoUrl).then(r => r.blob());
  const arrBuf  = await blob.arrayBuffer();
  const ctx     = new AudioContext({ sampleRate: 16000 });
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrBuf);
  } catch {
    await ctx.close();
    throw new Error("audio-decode-failed");
  }
  await ctx.close();

  // Get mono float32 at 16kHz (Whisper requirement)
  const channelData = decoded.getChannelData(0);

  // Load Whisper pipeline (cached after first load)
  if (!window._whisperPipe) {
    window._whisperPipe = await window._transformersPipeline(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny.en",
      { quantized: true }
    );
  }

  const result = await window._whisperPipe(channelData, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  });

  return { text: result.text || "" };
}

// ── Analysis ──────────────────────────────────────────────────────────────────
function estimateTokens(text) {
  return Math.ceil(text.split(/\s+/).length * 1.3);
}

const MAX_ACCEPTABLE_SECONDS = 45;

async function runAnalysis(transcript, zoomEvents, durationMs) {
  const transcriptTokens = estimateTokens(transcript);
  const OUTPUT_BUDGET    = Math.min(600, Math.ceil(transcriptTokens * 0.4));

  // Try Chrome Gemini Nano first
  if (window.ai?.summarizer || window.ai?.languageModel) {
    try {
      return await analyzeWithNano(transcript, zoomEvents, durationMs);
    } catch { /* fall through */ }
  }

  // WebGPU fallback
  if (navigator.gpu) {
    return await analyzeWithWebGPU(transcript, zoomEvents, durationMs, {
      outputBudget: OUTPUT_BUDGET,
      onSpeedSample: (tps, tokensRemaining) => {
        const projected = tokensRemaining / tps;
        if (projected > MAX_ACCEPTABLE_SECONDS) {
          showServerAIPrompt();
        }
      },
    });
  }

  // No local AI available
  showServerAIPrompt();
  throw new Error("server-needed");
}

// ── Chrome Gemini Nano ────────────────────────────────────────────────────────
async function analyzeWithNano(transcript, zoomEvents, durationMs) {
  const zoomCtx = zoomEvents.length
    ? zoomEvents.filter(e => e.type === "in").map(e => `zoom at ${formatTime(e.t)}`).join(", ")
    : "none";

  const prompt = `Analyze this screen recording transcript and return JSON only.
Zoom moments: ${zoomCtx}
Duration: ${formatTime(durationMs)}
Transcript: ${transcript.slice(0, 8000)}

Return this JSON shape only, no markdown:
{"summary":"...","chapters":[{"title":"...","start_ms":0,"end_ms":0}],"action_items":["..."]}`;

  let raw;
  if (window.ai?.languageModel) {
    const session = await window.ai.languageModel.create();
    raw = await session.prompt(prompt);
    session.destroy();
  } else if (window.ai?.summarizer) {
    const summarizer = await window.ai.summarizer.create({ type: "key-points" });
    const summary    = await summarizer.summarize(transcript);
    raw = JSON.stringify({ summary, chapters: [], action_items: [] });
    summarizer.destroy();
  } else {
    throw new Error("nano-unavailable");
  }

  // Strip markdown fences if present
  if (raw.includes("```")) { raw = raw.split("```")[1]; if (raw.startsWith("json")) raw = raw.slice(4); }
  return JSON.parse(raw.trim());
}

// ── WebLLM (WebGPU) ───────────────────────────────────────────────────────────
async function analyzeWithWebGPU(transcript, zoomEvents, durationMs, { outputBudget, onSpeedSample }) {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { showServerAIPrompt(); throw new Error("server-needed"); }

  if (!window._webllm) {
    // Show download progress banner the first time
    const isFirstTime = !localStorage.getItem("lense_webllm_cached");
    if (isFirstTime) {
      setAIStatus('<span class="rv-ai-spinner"></span> Downloading AI model (1.1 GB) — cached after first use <span id="rv-webllm-pct"></span>');
    }
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.73/lib/index.js";
      s.onload  = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
      setTimeout(() => reject(new Error("WebLLM load timeout")), 30000);
    });
    window._webllm = window.webllm;
  }

  if (!window._webllmEngine) {
    window._webllmEngine = await window._webllm.CreateMLCEngine(
      "Qwen2.5-1.5B-Instruct-q4f32_1-MLC",
      {
        initProgressCallback: (p) => {
          const pctEl = $("rv-webllm-pct");
          if (pctEl) pctEl.textContent = Math.round(p.progress * 100) + "%";
          if (p.progress >= 1) localStorage.setItem("lense_webllm_cached", "1");
        },
      }
    );
    setAIStatus('<span class="rv-ai-spinner"></span> Analyzing…');
  }

  const zoomCtx = zoomEvents.filter(e => e.type === "in")
    .map(e => `zoom at ${formatTime(e.t)}`).join(", ") || "none";

  const prompt = `Analyze this screen recording transcript. Return JSON only, no markdown.
Zoom moments: ${zoomCtx}
Duration: ${formatTime(durationMs)}
Transcript: ${transcript.slice(0, 6000)}

JSON shape: {"summary":"...","chapters":[{"title":"...","start_ms":0,"end_ms":0}],"action_items":["..."]}`;

  let raw = "";
  let tokenCount = 0;
  let startTime  = null;

  const chunks = await window._webllmEngine.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
    max_tokens: outputBudget,
    stream: true,
    stream_options: { include_usage: false },
  });

  for await (const chunk of chunks) {
    const delta = chunk.choices[0]?.delta?.content || "";
    raw += delta;
    tokenCount++;
    if (tokenCount === 15 && onSpeedSample) {
      startTime = startTime || performance.now();
      const elapsed = (performance.now() - (startTime || performance.now())) / 1000 || 0.1;
      const tps = 15 / Math.max(elapsed, 0.1);
      onSpeedSample(tps, outputBudget - 15);
    }
    if (tokenCount === 1) startTime = performance.now();
  }

  if (raw.includes("```")) { raw = raw.split("```")[1]; if (raw.startsWith("json")) raw = raw.slice(4); }
  return JSON.parse(raw.trim());
}

// ── Server AI prompt ──────────────────────────────────────────────────────────
function showServerAIPrompt() {
  if (!state.isPro) return;
  $("rv-ai-server-prompt").classList.remove("hidden");
}

$("rv-ai-use-server").addEventListener("click", async () => {
  if (!state.isPro) { $("license-modal").classList.remove("hidden"); return; }
  $("rv-ai-server-prompt").classList.add("hidden");
  $("rv-ai-privacy").classList.add("hidden");
  setAIStatus('<span class="rv-ai-spinner"></span> Sending transcript to server…');

  const transcriptText = window._lastTranscript || "";
  if (!transcriptText) {
    setAIStatus('<span class="rv-ai-note">No transcript available for server analysis.</span>');
    return;
  }

  try {
    const resp = await fetch("/ai/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": state.licenseKey,
      },
      body: JSON.stringify({
        transcript:  transcriptText,
        duration_ms: state.durationMs,
        zoom_events: state.zoomEvents,
      }),
    });
    if (!resp.ok) throw new Error("Server unavailable");
    const results = await resp.json();

    // Clear previous local results
    $("rv-ai-summary").classList.add("hidden");
    $("rv-ai-chapters").classList.add("hidden");
    $("rv-ai-actions").classList.add("hidden");

    showAIResults(results, "server");
    const notice = document.createElement("div");
    notice.className = "rv-ai-note";
    notice.textContent = "Transcript sent to Lense servers for analysis. Video remains on your device.";
    $("rv-ai-status").appendChild(notice);
  } catch {
    setAIStatus('<span class="rv-ai-note">Server unavailable. <button class="rv-ai-retry" onclick="$(`rv-ai-use-server`).click()">Retry</button></span>');
  }
});

// Store transcript for server opt-in (set during transcription)
const _origRunTranscription = runTranscription;
async function runTranscription(videoUrl) {
  const result = await _origRunTranscription(videoUrl);
  if (result) window._lastTranscript = result.text;
  return result;
}
