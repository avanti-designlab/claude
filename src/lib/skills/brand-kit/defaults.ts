/**
 * "Signal" defaults — the neutral-premium chrome (doc 06 §2).
 *
 * Design direction: precision instrument meets studio. These values are the
 * default (our-agency / tenant #1) theme AND the fill-ins for anything a
 * client brand does not specify. Deliberately NOT any of the three generic
 * AI-SaaS looks named in doc 06 §2:
 *  - not cream + serif + terracotta (surface is a deep cool graphite, body is
 *    a grotesque, accent is instrument brass — no cream field, no serif body);
 *  - not near-black + single acid accent (the surface carries a visible
 *    blue-slate cast at ~10% lightness rather than reading as black, and the
 *    palette is accent + two hue-opposed functional colors, none of them acid);
 *  - not hairline-broadsheet (weights run 400–650, the data moments are set
 *    heavy, and structure comes from spacing, not rules).
 *
 * Every value here passes the contrast gates in `contrast.ts` as-is — the
 * default theme is validated by the same math as every tenant theme.
 */

import type {
  ColorTokens,
  DesignTokenSet,
  SpacingTokens,
  TypographyTokens,
} from "@/lib/types/brand";

/**
 * Read-only views of the shared kit shapes, so the frozen constants below are
 * typed honestly instead of casting `Object.freeze` away. The shared
 * `SpacingTokens` (src/lib/types/brand.ts) declares `steps` as mutable
 * `number[]`; ideally it would be `readonly number[]` at the source — that
 * file is outside this library, so these views carry the honest typing
 * locally. Mutable token sets are assignable to these views, never the
 * reverse; consumers needing a mutable copy spread/clone first (see
 * `resolveSpacing` in build.ts).
 */
export interface ReadonlySpacingTokens extends Readonly<Omit<SpacingTokens, "steps">> {
  readonly steps: readonly number[];
}

/** `DesignTokenSet` with the frozen spacing typed honestly (see `ReadonlySpacingTokens`). */
export interface ReadonlyDesignTokenSet
  extends Readonly<Omit<DesignTokenSet, "spacing">> {
  readonly spacing: ReadonlySpacingTokens;
}

/**
 * Default color tokens (dark "Signal" theme).
 *
 * - surface       #14181f  deep graphite with a cool blue-slate cast
 * - surfaceRaised #1c222b  one step lifted, same temperature
 * - ink           #e9ecf1  cool paper-white (15.0:1 on surface)
 * - muted         #98a2b3  slate secondary text (6.9:1 on surface)
 * - accent        #e3a94f  instrument brass — the default tenant accent;
 *                          every real tenant overrides this (8.5:1 on surface)
 * - positive      #45c496  teal-leaning green (8.1:1 on surface)
 * - negative      #ef7466  coral, orange-leaning red (6.2:1 on surface)
 *
 * positive/negative are hue-opposed by ~152° and separated by ~1.3:1 mutual
 * luminance contrast, so citation-up/down reads under red–green color
 * vision deficiency too.
 */
export const SIGNAL_COLORS: ColorTokens = Object.freeze({
  surface: "#14181f",
  surfaceRaised: "#1c222b",
  ink: "#e9ecf1",
  muted: "#98a2b3",
  accent: "#e3a94f",
  positive: "#45c496",
  negative: "#ef7466",
});

/**
 * Neutral fill-ins for a client-provided surface the defaults were not
 * designed against. Dark surfaces reuse the Signal foregrounds; light
 * surfaces get the light-chrome counterparts. (Accent/positive/negative are
 * handled by contrast auto-correction instead — they are brand-expressive.)
 */
export const SIGNAL_LIGHT_NEUTRALS = Object.freeze({
  ink: "#1b202a",
  muted: "#5c6677",
});

/**
 * Default typography: characterful grotesque display for the big data
 * moments (Visibility Score, section heroes), a quiet body face for dense
 * dashboard reading, and a mono face for data/metrics/schema views
 * (doc 06 §2). The scale's `display` and `score` steps are the memorable
 * big-number treatment; weights above 600 assume variable fonts.
 */
export const SIGNAL_TYPOGRAPHY: TypographyTokens = Object.freeze({
  display: '"Space Grotesk", "Inter", system-ui, sans-serif',
  body: '"Inter", system-ui, -apple-system, sans-serif',
  mono: '"IBM Plex Mono", "SFMono-Regular", Menlo, monospace',
  scale: Object.freeze({
    xs: Object.freeze({ size: "0.75rem", lineHeight: "1.125rem" }),
    sm: Object.freeze({ size: "0.8125rem", lineHeight: "1.25rem" }),
    base: Object.freeze({ size: "0.9375rem", lineHeight: "1.5rem" }),
    lg: Object.freeze({ size: "1.125rem", lineHeight: "1.625rem" }),
    xl: Object.freeze({ size: "1.375rem", lineHeight: "1.75rem" }),
    "2xl": Object.freeze({ size: "1.75rem", lineHeight: "2.125rem", weight: 600 }),
    "3xl": Object.freeze({ size: "2.25rem", lineHeight: "2.5rem", weight: 600 }),
    display: Object.freeze({ size: "3.5rem", lineHeight: "1.05", weight: 640 }),
    /** The Visibility Score / share-of-voice big number. */
    score: Object.freeze({ size: "5.25rem", lineHeight: "1", weight: 650 }),
  }),
});

/** 4px base unit; steps are multipliers of the unit (0–128px). */
export const SIGNAL_SPACING: ReadonlySpacingTokens = Object.freeze({
  unit: 4,
  steps: Object.freeze([0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32]),
});

/** The complete default token set — the tenant #1 theme. */
export const SIGNAL_DEFAULT_TOKENS: ReadonlyDesignTokenSet = Object.freeze({
  colors: SIGNAL_COLORS,
  typography: SIGNAL_TYPOGRAPHY,
  spacing: SIGNAL_SPACING,
});
