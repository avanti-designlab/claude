/**
 * Operator brand theme — tenant #1 (our agency).
 *
 * This is the app's ACTIVE/default theme. It is authored through the
 * brand-kit-design-token skill path (`buildBrandKit` → `toTenantTheme`), so it
 * arrives pre-validated by the same accessibility gate every reseller tenant
 * theme passes through, and it is applied at runtime by the SAME theming
 * engine (`resolveTenantTheme`) — nothing here is hardcoded into components.
 * The frozen neutral "Signal" default token set remains the framework fallback
 * (SIGNAL_DEFAULT_TOKENS is untouched); this file only supplies tenant #1's
 * brand INPUT, exactly as a `tenants.theme` row would.
 *
 * Direction: the operator's REAL brand (brand guide, docs/design/operator-brand.md),
 * light-first, Spendex-airy. Grounded anchors, adapted for accessibility:
 *  - accent           #1b2fce  Core Blue — primary; buttons, links, focus ring,
 *                              the Visibility-Score "resolve" moment. Dark and
 *                              vivid, so it clears the gate on white verbatim.
 *  - accentSecondary  #fc4c14  Core Orange — the ENERGY accent (gradient
 *                              moments, secondary pops; used sparingly). Kept
 *                              hue-separated from the functional red so brand
 *                              energy never reads as "error."
 *  - accentWarm       #f4a200  Alachua amber — warm tertiary (badges, detail).
 *                              Too light for a 3:1 UI mark on white, so the gate
 *                              darkens it; the correction is reported, never
 *                              silent (see operatorBuild.accessibility).
 *  - surface  #f4f6fa  cool light-grey CANVAS — the Spendex airy ground that
 *                      makes the white cards float above it.
 *  - raised   #ffffff  white CARDS.
 *  - ink      #0b152b  Dark-Blue-tinted near-black (#0a1c46 lineage) — a
 *                      branded, premium foreground rather than flat black.
 *  - muted    #5b6577  cool grey secondary text.
 * Functional colors are semantic (green up / red down). The negative red is a
 * rose-crimson deliberately hue-separated from Core Orange so the "energy"
 * accent is never confused with an error state. positive/negative are gated at
 * 3:1 on both chrome layers and auto-darkened where needed for the light
 * surface; every correction is in `operatorBuild.accessibility.adjustments`.
 *
 * Dark/hero sections use Dark Blue #0a1c46 through the token layer (a scoped
 * surface override), never a hardcoded value in a component.
 *
 * Display face is Sora (a free, self-hosted geometric grotesque standing in for
 * the brand's proprietary display face); body is the self-hosted Inter; mono
 * stays IBM Plex Mono.
 *
 * This file is a pipeline INPUT (it plays the role of tenant #1's
 * `tenants.theme` row), so — like `demo-themes.ts` and `light-surface.ts` — it
 * is allowlisted in `no-hardcoded-colors.test.ts`. The values below are brand
 * inputs, not UI values; every UI color still flows through tokens.
 */

import {
  buildBrandKit,
  toTenantTheme,
  type BrandKitInput,
  type TenantTheme,
} from "@/lib/skills/brand-kit";

/** Stable scope id for `:root[data-tenant-theme]`. */
export const OPERATOR_TENANT_ID = "operator";

/**
 * Geometric-grotesque display face (Sora). Self-hosted woff2 in
 * `public/fonts/sora-var.woff2`; @font-face in globals.css. Inter (body) and
 * IBM Plex Mono (mono) are already self-hosted.
 */
export const OPERATOR_TYPOGRAPHY = {
  display: '"Sora", "Inter", system-ui, sans-serif',
  body: '"Inter", system-ui, -apple-system, sans-serif',
  mono: '"IBM Plex Mono", "SFMono-Regular", Menlo, monospace',
} as const;

/**
 * Dark Blue — the brand's deep surface, exposed as a token constant for any
 * scoped dark/hero section (applied via a surface override, never hardcoded in
 * a component). Kept here so the one brand value lives with the brand input.
 */
export const OPERATOR_DARK_SURFACE = "#0a1c46";

/**
 * The brand INPUT. `buildBrandKit` fills any unspecified neutrals and runs the
 * full contrast gate; the two-accent extension carries Core Orange + Alachua.
 */
export const OPERATOR_BRAND_INPUT: BrandKitInput = {
  colors: {
    accent: "#1b2fce", // Core Blue (primary)
    accentSecondary: "#fc4c14", // Core Orange (energy)
    accentWarm: "#f4a200", // Alachua (warm)
    surface: "#f4f6fa", // cool light-grey canvas
    surfaceRaised: "#ffffff", // white cards
    ink: "#0b152b", // Dark-Blue-tinted near-black
    muted: "#5b6577", // cool grey secondary
    positive: "#16a34a", // green up
    negative: "#e11d48", // rose-crimson down (hue-separated from Core Orange)
  },
  typography: { ...OPERATOR_TYPOGRAPHY },
};

/**
 * Build result (kit + accessibility report). Exported so the report — every
 * auto-correction the gate applied and why — can be surfaced (the theming
 * engine never alters a brand silently; doc 06 §3, §7).
 */
export const operatorBuild = buildBrandKit(OPERATOR_BRAND_INPUT);

/** Tenant #1's theme in `tenants.theme` jsonb shape, post-gate. */
export const operatorTheme: TenantTheme = toTenantTheme(operatorBuild.kit, {
  logoUrl: null,
  customDomain: null,
});
