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
};
