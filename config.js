/**
 * ╔══════════════════════════════════════════╗
 * ║  LENSE — BRAND CONFIG                    ║
 * ║  Change APP_NAME here to rename the      ║
 * ║  entire product across all UI labels.    ║
 * ╚══════════════════════════════════════════╝
 */

const CONFIG = {
  APP_NAME:   "Lense",
  TAGLINE:    "Record. Zoom. Share.",
  GITHUB_URL: "https://github.com/shankhadey/lense",
  MAX_REC_MS: 30 * 60 * 1000,  // 30 min max recording

  /**
   * ZOOM_FACTOR — how much context surrounds your zoom selection.
   * 1.0 = hard crop, selection fills frame exactly
   * 0.49 = selection fills 49%, 51% is context around it (default)
   * 0.3 = very subtle, lots of context
   * Range: 0.05 – 1.0
   */
  ZOOM_FACTOR: 0.49,

  /**
   * ZOOM_MAX_COVERAGE — padded zoom rect never exceeds this fraction of source.
   * Prevents Retina/HiDPI blowout where padding math exceeds source dimensions,
   * which would produce zero zoom (drawing the full source into the canvas).
   * 0.75 = at most 75% of source drawn, guaranteeing real zoom (default)
   * 0.5 = tighter ceiling, always at least 2x zoom from coverage alone
   * Range: 0.1 – 1.0
   */
  ZOOM_MAX_COVERAGE: 0.75,

  /**
   * ZOOM_MIN_MAG — minimum zoom magnification always guaranteed.
   * Regardless of selection size or source resolution, content always
   * appears at least this many times larger than normal.
   * 1.5 = subtle cinematic zoom, always at least 1.5x (default)
   * 2.0 = always at least 2x, more obvious zoom
   * Range: 1.1 – 5.0
   */
  ZOOM_MIN_MAG: 1.5,

  /**
   * ZOOM_DURATION_MS — zoom animation duration in milliseconds.
   * 300 = snappy, 500 = cinematic (default), 800 = slow and dramatic
   */
  ZOOM_DURATION_MS: 500,

  /**
   * ZOOM_EASING — easing curve for zoom animation.
   * "ease-in-out" = cinematic (default), "ease-out" = punchy,
   * "ease-in" = slow start, "linear" = constant
   */
  ZOOM_EASING: "ease-in-out",

  // ─── AI FEATURE TOGGLES ───────────────────────────────────────────────────
  // Each flag independently enables/disables an AI module.
  // Off = module never runs, no model downloaded, no UI shown.

  AI_FEATURE_TRANSCRIPTION: true,   // Whisper STT
  AI_FEATURE_REFINEMENT:    true,   // LLM script cleanup
  AI_FEATURE_TTS:           true,   // Kokoro voiceover
  AI_FEATURE_ZOOM:          true,   // Auto-zoom suggestions
  AI_FEATURE_SPOTLIGHT:     true,   // Spotlight suggestions
  AI_FEATURE_CALLOUT:       true,   // Callout suggestions

  // ─── AI AUTONOMY LEVEL ────────────────────────────────────────────────────
  // 1 = Full Review (user approves every action)
  // 2 = Guided (AI auto-starts, user reviews results)
  // 3 = Autopilot (AI runs end-to-end, toasts only) [DEFAULT]
  AI_AUTONOMY: 3,

  // ─── AI ELEMENT DURATIONS ─────────────────────────────────────────────────
  // How long each AI-suggested effect holds before auto-releasing.

  AI_ZOOM_DURATION_MS:       3000,   // 1000–10000 ms
  AI_SPOTLIGHT_DURATION_MS:  3000,   // 500–10000 ms
  AI_CALLOUT_DURATION_MS:    2500,   // 500–8000 ms

  // ─── AI SUGGESTION THRESHOLDS ─────────────────────────────────────────────
  // Normalized confidence (0–1) cutoffs per autonomy level.
  // Below AI_MIN_CONFIDENCE = never shown to user.

  AI_MIN_CONFIDENCE:          0.40,   // global floor; below this = not shown
  AI_L2_AUTO_ACCEPT:          0.70,   // L2: auto-accept if confidence >= this
  AI_L3_AUTO_ACCEPT:          0.40,   // L3: auto-accept if confidence >= this
  AI_L3_REFINEMENT_MAX_DIFF:  0.20,   // L3: auto-accept refinement if word diff <= 20%
};

// ─── PERSISTENCE ──────────────────────────────────────────────────────────────
// Load any user-saved overrides from localStorage on startup.
(function loadSavedConfig() {
  const AI_KEYS = [
    'AI_FEATURE_TRANSCRIPTION', 'AI_FEATURE_REFINEMENT', 'AI_FEATURE_TTS',
    'AI_FEATURE_ZOOM', 'AI_FEATURE_SPOTLIGHT', 'AI_FEATURE_CALLOUT',
    'AI_AUTONOMY',
    'AI_ZOOM_DURATION_MS', 'AI_SPOTLIGHT_DURATION_MS', 'AI_CALLOUT_DURATION_MS',
  ];
  AI_KEYS.forEach(key => {
    const raw = localStorage.getItem('lense_' + key);
    if (raw === null) return;
    CONFIG[key] = key.startsWith('AI_FEATURE_')
      ? raw === 'true'
      : Number(raw);
  });
})();

/** Persist a CONFIG value to localStorage. */
function saveConfig(key, value) {
  CONFIG[key] = value;
  localStorage.setItem('lense_' + key, String(value));
}
