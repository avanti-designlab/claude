/**
 * WCAG contrast validation + auto-correction for token sets (doc 06 §7:
 * "accessible contrast on all themes (including tenant themes — the theming
 * engine validates contrast)"). This module is where that validation lives.
 *
 * Policy: backgrounds (`surface`, `surfaceRaised`) are taken as given — they
 * are the tenant's brand chrome. Foreground tokens that fail are corrected to
 * the nearest-accessible variant by stepping HSL lightness, and every
 * correction is reported (what was adjusted and why). The library never
 * silently returns an inaccessible kit: if a combination is mathematically
 * unsolvable (e.g. a mid-gray surface where even pure white/black cannot
 * reach the required ratio), the failing check is reported with `pass: false`
 * for the theming engine to gate on.
 */

import type { ColorTokens } from "@/lib/types/brand";
import {
  contrastRatio,
  hueSeparationDeg,
  lightnessOf,
  normalizeHex,
  setLightness,
} from "./color";

/**
 * Required minimum contrast ratios (WCAG 2.x) + the required pair set.
 *
 * F2 DESIGN POLICY (set by the Lead Designer, 2026-07-07; doc 06 §7 names the
 * ratios but is silent on the pair set, so this constant is normative and
 * goes into the design-system spec): every foreground token is validated
 * against BOTH chrome layers — `surface` AND `surfaceRaised` — because raised
 * cards (KPI tiles, tracker rows, chart panels) carry the same foregrounds as
 * the base surface. Muted text on a raised card is a standard dashboard
 * pattern, not an edge case.
 *
 * - `ink`, `muted` → `normalText` (4.5:1, WCAG 1.4.3 AA) on both surfaces.
 * - `accent`, `positive`, `negative` → `uiComponent` (3:1, WCAG 1.4.11) on
 *   both surfaces. These tokens color UI components, indicators, and large
 *   data numerals — never body copy; status at body size always pairs the
 *   color with a glyph (color is never the only signal).
 *
 * The concrete pair list lives in `CHECK_SPECS` below.
 */
export const CONTRAST_REQUIREMENTS = {
  /** WCAG 1.4.3 AA, normal text. */
  normalText: 4.5,
  /** WCAG 1.4.11 non-text contrast / AA large text. */
  uiComponent: 3,
  /**
   * Library policy for positive-vs-negative distinguishability: the pair
   * passes with either >= 30° of hue separation or >= 1.3:1 mutual
   * luminance contrast, so the pair is readable for red–green color
   * vision deficiency as well.
   */
  distinguishabilityContrast: 1.3,
  distinguishabilityHueDeg: 30,
} as const;

type ForegroundToken = "ink" | "muted" | "accent" | "positive" | "negative";
type BackgroundToken = "surface" | "surfaceRaised";

export interface ContrastCheck {
  /** Stable id, e.g. "ink-on-surface". */
  id: string;
  foreground: ForegroundToken;
  background: BackgroundToken;
  /** Measured WCAG contrast ratio. */
  ratio: number;
  /** Required minimum ratio. */
  required: number;
  pass: boolean;
}

export interface DistinguishabilityCheck {
  id: "positive-vs-negative";
  hueSeparationDeg: number;
  /** Mutual luminance contrast between positive and negative. */
  contrast: number;
  pass: boolean;
}

export interface TokenAdjustment {
  token: ForegroundToken;
  /** Normalized original value. */
  from: string;
  /** Corrected value. */
  to: string;
  /** Human-readable explanation: which check failed, at what ratio, what was done. */
  reason: string;
  /** Whether the correction reached the required ratio(s). */
  resolved: boolean;
}

export interface AccessibilityReport {
  /** Post-correction results for every required contrast pair. */
  checks: ContrastCheck[];
  /** Post-correction positive-vs-negative distinguishability. */
  distinguishability: DistinguishabilityCheck;
  /** Every correction that was applied, with the reason. Empty when the input palette passed as-is. */
  adjustments: TokenAdjustment[];
  /** True when every check (including distinguishability) passes. */
  pass: boolean;
}

interface CheckSpec {
  id: string;
  foreground: ForegroundToken;
  background: BackgroundToken;
  min: number;
  rule: string;
}

/**
 * The required contrast pairs — every foreground token on BOTH chrome layers
 * (F2 design policy; see `CONTRAST_REQUIREMENTS`).
 */
const CHECK_SPECS: readonly CheckSpec[] = (
  [
    { foreground: "ink", min: CONTRAST_REQUIREMENTS.normalText, rule: "WCAG 1.4.3 AA normal text" },
    { foreground: "muted", min: CONTRAST_REQUIREMENTS.normalText, rule: "WCAG 1.4.3 AA normal text" },
    { foreground: "accent", min: CONTRAST_REQUIREMENTS.uiComponent, rule: "WCAG 1.4.11 non-text / large text" },
    { foreground: "positive", min: CONTRAST_REQUIREMENTS.uiComponent, rule: "WCAG 1.4.11 non-text / large text" },
    { foreground: "negative", min: CONTRAST_REQUIREMENTS.uiComponent, rule: "WCAG 1.4.11 non-text / large text" },
  ] as const
).flatMap(({ foreground, min, rule }): CheckSpec[] => [
  { id: `${foreground}-on-surface`, foreground, background: "surface", min, rule },
  {
    id: `${foreground}-on-surface-raised`,
    foreground,
    background: "surfaceRaised",
    min,
    rule,
  },
]);

/** Run all required contrast checks against a palette without modifying it. */
export function validateColorTokens(colors: ColorTokens): ContrastCheck[] {
  return CHECK_SPECS.map((spec) => {
    const ratio = contrastRatio(colors[spec.foreground], colors[spec.background]);
    return {
      id: spec.id,
      foreground: spec.foreground,
      background: spec.background,
      ratio,
      required: spec.min,
      pass: ratio >= spec.min,
    };
  });
}

/** Positive-vs-negative distinguishability check (library policy, see CONTRAST_REQUIREMENTS). */
export function checkDistinguishability(
  positive: string,
  negative: string
): DistinguishabilityCheck {
  const hueSep = hueSeparationDeg(positive, negative);
  const contrast = contrastRatio(positive, negative);
  return {
    id: "positive-vs-negative",
    hueSeparationDeg: hueSep,
    contrast,
    pass:
      hueSep >= CONTRAST_REQUIREMENTS.distinguishabilityHueDeg ||
      contrast >= CONTRAST_REQUIREMENTS.distinguishabilityContrast,
  };
}

/**
 * Find the nearest-accessible variant of `foreground` against one or more
 * backgrounds: step HSL lightness outward from the original, one point at a
 * time, in both directions; the first candidate that meets `minRatio` against
 * every background wins (smallest lightness change = nearest). Hue and
 * saturation are preserved. If no lightness can satisfy the requirement, the
 * best-effort candidate (highest worst-case ratio) is returned with
 * `passes: false`.
 */
export function nearestAccessibleVariant(
  foreground: string,
  backgrounds: readonly string[],
  minRatio: number
): { hex: string; passes: boolean } {
  const start = normalizeHex(foreground);
  const worstRatio = (hex: string): number =>
    Math.min(...backgrounds.map((bg) => contrastRatio(hex, bg)));

  if (worstRatio(start) >= minRatio) return { hex: start, passes: true };

  const l0 = lightnessOf(start);
  let best = { hex: start, ratio: worstRatio(start) };

  for (let delta = 1; delta <= 100; delta++) {
    for (const direction of [1, -1]) {
      const l = l0 + direction * delta;
      if (l < 0 || l > 100) continue;
      const candidate = setLightness(start, l);
      const ratio = worstRatio(candidate);
      if (ratio >= minRatio) return { hex: candidate, passes: true };
      if (ratio > best.ratio) best = { hex: candidate, ratio };
    }
  }
  return { hex: best.hex, passes: false };
}

const fmt = (n: number): string => `${(Math.round(n * 100) / 100).toFixed(2)}:1`;

/**
 * Validate a palette and correct any failing foreground token to its
 * nearest-accessible variant. Returns the corrected palette plus a full
 * report: post-correction check results and every adjustment made.
 *
 * All values in the returned palette are normalized to lowercase `#rrggbb`.
 * Throws on unparseable hex input.
 */
export function ensureAccessibleColors(colors: ColorTokens): {
  colors: ColorTokens;
  report: AccessibilityReport;
} {
  const palette: ColorTokens = {
    surface: normalizeHex(colors.surface),
    surfaceRaised: normalizeHex(colors.surfaceRaised),
    ink: normalizeHex(colors.ink),
    muted: normalizeHex(colors.muted),
    accent: normalizeHex(colors.accent),
    positive: normalizeHex(colors.positive),
    negative: normalizeHex(colors.negative),
  };
  const adjustments: TokenAdjustment[] = [];

  // Group specs by foreground token so a token constrained by several
  // backgrounds (ink) is corrected against all of them at once.
  const tokens: ForegroundToken[] = ["ink", "muted", "accent", "positive", "negative"];
  for (const token of tokens) {
    const specs = CHECK_SPECS.filter((s) => s.foreground === token);
    const backgrounds = specs.map((s) => palette[s.background]);
    const min = Math.max(...specs.map((s) => s.min));
    const failing = specs.filter(
      (s) => contrastRatio(palette[token], palette[s.background]) < s.min
    );
    if (failing.length === 0) continue;

    const from = palette[token];
    const corrected = nearestAccessibleVariant(from, backgrounds, min);
    palette[token] = corrected.hex;

    const failures = failing
      .map(
        (s) =>
          `${s.id} was ${fmt(contrastRatio(from, palette[s.background]))} ` +
          `(required ${fmt(s.min)}, ${s.rule})`
      )
      .join("; ");
    adjustments.push({
      token,
      from,
      to: corrected.hex,
      reason: corrected.passes
        ? `${failures}. Lightness stepped from ${Math.round(lightnessOf(from))} to ` +
          `${Math.round(lightnessOf(corrected.hex))} to reach the nearest accessible ` +
          `variant (now ${fmt(Math.min(...backgrounds.map((bg) => contrastRatio(corrected.hex, bg))))}).`
        : `${failures}. No lightness of this hue/saturation can satisfy the requirement ` +
          `against the given surface(s); best-effort variant applied ` +
          `(${fmt(Math.min(...backgrounds.map((bg) => contrastRatio(corrected.hex, bg))))}). ` +
          `The surface color itself is too close to mid-luminance for accessible foregrounds.`,
      resolved: corrected.passes,
    });
  }

  // Positive vs negative must stay mutually distinguishable.
  let distinguishability = checkDistinguishability(palette.positive, palette.negative);
  if (!distinguishability.pass) {
    const from = palette.negative;
    const surfaces = [palette.surface, palette.surfaceRaised];
    const separated = separateNegative(palette.positive, from, surfaces);
    if (separated !== null) {
      palette.negative = separated;
      distinguishability = checkDistinguishability(palette.positive, palette.negative);
      adjustments.push({
        token: "negative",
        from,
        to: separated,
        reason:
          `positive-vs-negative distinguishability failed: hue separation ` +
          `${Math.round(hueSeparationDeg(palette.positive, from))}° < ` +
          `${CONTRAST_REQUIREMENTS.distinguishabilityHueDeg}° and mutual contrast ` +
          `${fmt(contrastRatio(palette.positive, from))} < ` +
          `${fmt(CONTRAST_REQUIREMENTS.distinguishabilityContrast)}. Negative lightness ` +
          `stepped to ${Math.round(lightnessOf(separated))} so the pair reads as two ` +
          `states (now ${fmt(contrastRatio(palette.positive, separated))} mutual contrast) ` +
          `while keeping ${fmt(Math.min(...surfaces.map((bg) => contrastRatio(separated, bg))))} ` +
          `on both surfaces.`,
        resolved: true,
      });
    }
  }

  const checks = validateColorTokens(palette);
  return {
    colors: palette,
    report: {
      checks,
      distinguishability,
      adjustments,
      pass: checks.every((c) => c.pass) && distinguishability.pass,
    },
  };
}

/**
 * Step the negative token's lightness outward until it is luminance-
 * distinguishable from positive while still meeting the UI-component ratio
 * on every chrome surface (both `surface` and `surfaceRaised`, per the F2
 * pair-set policy). Returns null when no lightness satisfies all constraints.
 */
function separateNegative(
  positive: string,
  negative: string,
  surfaces: readonly string[]
): string | null {
  const l0 = lightnessOf(negative);
  for (let delta = 1; delta <= 100; delta++) {
    for (const direction of [1, -1]) {
      const l = l0 + direction * delta;
      if (l < 0 || l > 100) continue;
      const candidate = setLightness(negative, l);
      if (
        contrastRatio(positive, candidate) >=
          CONTRAST_REQUIREMENTS.distinguishabilityContrast &&
        surfaces.every(
          (bg) => contrastRatio(candidate, bg) >= CONTRAST_REQUIREMENTS.uiComponent
        )
      ) {
        return candidate;
      }
    }
  }
  return null;
}
