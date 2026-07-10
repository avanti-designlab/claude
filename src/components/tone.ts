/**
 * Shared TONE TEXT classes — the single source for the warm / positive /
 * negative AA-fixed sentence-text recipes that had recurred inline across the
 * review queue, the workspace Properties panel, the audit-runs list, the
 * onboarding + login error lines, and the dashboard plan-generation row. A PURE
 * constants module (no client hooks, no server-only), importable from both
 * Server Components and client islands. Relocated here from
 * src/app/(app)/_components/ (Design M1 / Code Review minor, 2026-07-10) so
 * src/components consumers don't reach into the app layer; the app-layer path
 * re-exports from here, so existing imports are untouched.
 *
 * Why the color-mix: raw `text-{tone}` measures ~2.75–3.0:1 against the light
 * card surface — below the 4.5:1 WCAG AA floor for 11–13px sentence text (Design
 * Review, 2026-07-09/10). The fix mixes the tone 70/30 toward `--ink` for light
 * mode and keeps the pure token in dark mode (which already passes); the exact
 * 70% share is contrast-proven in dashboard/error-text-contrast.test.ts, which
 * parses the share out of the shipped class below. This is for SENTENCE text
 * ONLY — pills and borders keep their own token treatment.
 *
 * GOVERNANCE: this is the app-utility layer over F2 tokens — NOT part of the
 * frozen F2 design system. Its new home under src/components does not pull it
 * behind the foundation gate: these are utility class strings composed from F2
 * tokens, free to change without a foundation-change sign-off.
 */

/** Warm advisory sentence text (stale verdicts, send-back summaries, hints). */
export const WARM_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--accent-warm)_70%,var(--ink))] dark:text-accent-warm";

/** Positive confirmation sentence text (inline "Recorded" / "Saved" echoes). */
export const POSITIVE_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--positive)_70%,var(--ink))] dark:text-positive";

/** Negative / error sentence text (form + action failure lines). */
export const NEGATIVE_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--negative)_70%,var(--ink))] dark:text-negative";
