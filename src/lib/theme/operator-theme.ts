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
 * Display AND body face is Geist (Vercel's neo-grotesque, OFL-1.1, self-hosted
 * from @fontsource-variable/geist 5.2.9 — the Apple/Webflow-grade modern SaaS
 * face; operator direction, pass 3, 2026-07-08: Sora/Space Grotesk are OUT for
 * the operator theme). Inter remains the fallback; mono stays IBM Plex Mono.
 * The frozen Signal DEFAULTS keep Space Grotesk/Inter untouched.
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
 * Modern neo-grotesque face (Geist, weight 100–900 variable). Self-hosted
 * woff2 in `public/fonts/geist-var.woff2`; @font-face in globals.css. One
 * family for display AND body — the Apple/Webflow pattern: hierarchy comes
 * from weight + size + tracking, not a second face. Inter stays as the
 * self-hosted fallback; IBM Plex Mono is unchanged.
 */
export const OPERATOR_TYPOGRAPHY = {
  display: '"Geist", "Inter", system-ui, sans-serif',
  body: '"Geist", "Inter", system-ui, -apple-system, sans-serif',
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

/* ==========================================================================
   PASS-3 "BLUE-DEPTH" PREVIEW VARIANTS (operator direction, 2026-07-08)
   --------------------------------------------------------------------------
   Scoped to /dashboard-preview ONLY (applied via TenantThemeScope — the
   frozen engine, unchanged). The operator's reference: illuminated, Apple-
   grade dark UI — layered blues traveling light → dark. Three blues:

     highlight  #8fd4ff  light cyan-blue (the reference chat-bubble tone) —
                         authored into accentSecondary. Passes VERBATIM on
                         the dark navy chrome; on the light chrome the gate
                         honestly darkens it to #0091eb (3.11:1) — reported,
                         never silent.
     primary    #2456f0 (light chrome) / #3f7cff (dark chrome) — the vivid
                         blue; the accent. Both clear 3:1 on both chrome
                         layers verbatim, and the DERIVED on-accent
                         foreground carries >= 5.2:1 for text on blue.
     anchor     deep navy — carried by the dark variant's SURFACES
                         (#050815 canvas / #0b1430 cards, Dark-Blue #0a1c46
                         lineage) and, on the light variant, by gradient ends
                         mixed toward the navy ink at the token layer.

   Core Orange + Alachua remain in the OPERATOR THEME above (the system keeps
   them) but are OFF this page — the final palette call is the operator's
   after seeing pass 3. These are exploration inputs, additive; nothing about
   the frozen token system or the global operator theme palette changes.
   ========================================================================== */

/** The /dashboard-preview pass-3 variant axis. */
export type BlueDepthVariant = "light" | "dark";

/** Stable scope ids for the two preview variants. */
export const BLUE_DEPTH_SCOPE_ID: Record<BlueDepthVariant, string> = {
  light: "operator-p3-light",
  dark: "operator-p3-dark",
};

/** Brand INPUTS for the two variants (tenants.theme-row shaped, pre-gate). */
export const BLUE_DEPTH_INPUTS: Record<BlueDepthVariant, BrandKitInput> = {
  light: {
    colors: {
      accent: "#2456f0", // primary vivid blue (passes verbatim on white)
      accentSecondary: "#8fd4ff", // highlight cyan — gate darkens on white (reported)
      accentWarm: "#c18000", // Alachua (post-gate lineage) — kept in system, OFF this page
      surface: "#f4f6fa", // unchanged operator canvas
      surfaceRaised: "#ffffff", // unchanged white cards
      ink: "#0b152b", // unchanged navy-tinted near-black
      muted: "#5b6577",
      positive: "#16a34a",
      negative: "#e11d48",
    },
    typography: { ...OPERATOR_TYPOGRAPHY },
  },
  dark: {
    colors: {
      accent: "#3f7cff", // primary vivid blue, brightened for the dark chrome
      accentSecondary: "#8fd4ff", // highlight cyan — passes verbatim on navy
      accentWarm: "#f4a200", // original Alachua (passes verbatim on navy), OFF this page
      surface: "#050815", // near-black canvas with a navy cast (the reference ground)
      surfaceRaised: "#0b1430", // deep-navy cards (Dark Blue #0a1c46 lineage)
      ink: "#eaf1fc", // light blue-tinted foreground
      muted: "#9aa8c7", // blue-slate secondary text
      positive: "#22c55e", // brightened for the dark chrome
      negative: "#f43f5e", // brightened rose for the dark chrome
    },
    typography: { ...OPERATOR_TYPOGRAPHY },
  },
};

/**
 * Build results (kit + accessibility report) for both variants — exported so
 * the gate's corrections are surfaced, exactly like `operatorBuild`.
 */
export const blueDepthBuild: Record<BlueDepthVariant, ReturnType<typeof buildBrandKit>> = {
  light: buildBrandKit(BLUE_DEPTH_INPUTS.light),
  dark: buildBrandKit(BLUE_DEPTH_INPUTS.dark),
};

/** The two variant themes in `tenants.theme` jsonb shape, post-gate. */
export const blueDepthTheme: Record<BlueDepthVariant, TenantTheme> = {
  light: toTenantTheme(blueDepthBuild.light.kit, { logoUrl: null, customDomain: null }),
  dark: toTenantTheme(blueDepthBuild.dark.kit, { logoUrl: null, customDomain: null }),
};
