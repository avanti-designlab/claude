/**
 * Light-theme-legible tone classes for small sentence text on card surfaces —
 * a PURE constants module importable from both Server Components and client
 * islands. Raw `text-accent-warm` measures ~3.0:1 against the light card
 * surface, below the 4.5:1 WCAG AA floor for 11-12px text (Design Review M2,
 * 2026-07-10). The fix is the exact pattern the plan-generation error text
 * already ships (BUILD-STATE ticket F precedent): mix the accent 70/30 toward
 * ink for light mode, keep the pure accent in dark mode (which already passes).
 * Pills/borders are untouched — this is for SENTENCE text only.
 */

/** Warm advisory sentence text (stale verdicts, send-back summaries, hints). */
export const WARM_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--accent-warm)_70%,var(--ink))] dark:text-accent-warm";

/** Positive confirmation sentence text (inline "Recorded" echoes). */
export const POSITIVE_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--positive)_70%,var(--ink))] dark:text-positive";
