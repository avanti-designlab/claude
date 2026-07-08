/**
 * Operator brand theme — tenant #1 (our agency). WORKING BRAND v1 (pass 3,
 * consolidated app-wide on operator direction, 2026-07-08).
 *
 * The operator brand is DUAL-PALETTE: the blue-depth LIGHT palette is the
 * app's boot theme, and the blue-depth DARK-GLOW palette applies under the
 * standard mode mechanism (`prefers-color-scheme: dark` + the existing
 * `data-theme` override) — see `operator-mode-css.ts` for the emission and
 * `src/app/layout.tsx` for the boot wiring. Both palettes are authored
 * through the brand-kit-design-token skill path (`buildBrandKit` →
 * `toTenantTheme`), so each arrives pre-validated by the same accessibility
 * gate every reseller tenant theme passes through, and each is applied by the
 * SAME frozen theming engine (`resolveTenantTheme`) — nothing here is
 * hardcoded into components. The frozen neutral "Signal" default token set
 * remains the framework fallback (SIGNAL_DEFAULT_TOKENS untouched); this file
 * only supplies tenant #1's brand INPUTS, exactly as `tenants.theme` rows
 * would. (Phase-1 flag: a DB-driven dual-palette tenant needs a
 * `tenants.theme` schema extension — see docs/design/operator-brand.md.)
 *
 * STRUCTURE (locked as v1 roles — VALUES float; the operator may swap the
 * font or re-add colors later):
 *  - primary vivid blue  → --accent          (buttons, links, focus, resolve)
 *  - highlight cyan      → --accent-secondary (the illuminated-edge tone)
 *  - deep navy anchor    → dark-mode surfaces / light-mode gradient ends
 *  - red = urgency       → --negative wears every "needs action" surface;
 *                          brand energy colors never read as "error"
 *  - Geist               → display AND body face
 *  - glow language + floating rounded "bubble" hero (GlowCard)
 *
 * The pass-2 Core-Blue/Core-Orange palette below is SUPERSEDED as the boot
 * theme but deliberately kept: Core Orange + Alachua remain available accents
 * in the theme system (the operator may re-add colors later — additive path;
 * nothing deleted, just not leading).
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
 * self-hosted fallback; IBM Plex Mono is unchanged. (Sora/Space Grotesk are
 * OUT for the operator theme — pass-3 direction; the frozen Signal DEFAULTS
 * keep Space Grotesk/Inter untouched.)
 */
export const OPERATOR_TYPOGRAPHY = {
  display: '"Geist", "Inter", system-ui, sans-serif',
  body: '"Geist", "Inter", system-ui, -apple-system, sans-serif',
  mono: '"IBM Plex Mono", "SFMono-Regular", Menlo, monospace',
} as const;

/**
 * Dark Blue — the brand's deep-surface lineage value, kept as a token
 * constant (the dark-mode surfaces below derive from it; any future scoped
 * hero section uses it via a surface override, never hardcoded).
 */
export const OPERATOR_DARK_SURFACE = "#0a1c46";

/**
 * The operator's ACCENT LIBRARY — brand colors kept AVAILABLE in the theme
 * system even where the current working palette doesn't lead with them
 * (operator direction: colors may be re-added later; the path is additive).
 * These are brand INPUT values (this file plays the role of tenants.theme
 * rows), not UI values.
 */
export const OPERATOR_ACCENT_LIBRARY = {
  /** Pass-2 primary (brand guide "Core Blue"). */
  coreBlue: "#1b2fce",
  /** Energy accent (brand guide "Core Orange") — available, not leading. */
  coreOrange: "#fc4c14",
  /** Warm accent (brand guide "Alachua") — available, not leading. */
  alachua: "#f4a200",
  /** Deep navy (brand guide "Dark Blue") — dark-surface lineage. */
  darkBlue: OPERATOR_DARK_SURFACE,
} as const;

/* ==========================================================================
   WORKING BRAND v1 — the BLUE-DEPTH dual palette (light + dark modes)
   --------------------------------------------------------------------------
   Promoted from the pass-3 /dashboard-preview exploration to the app-wide
   operator theme (operator decision, 2026-07-08: "keep both as light/dark
   mode"). The reference: illuminated, Apple-grade layered blues traveling
   light → dark. Three blues:

     highlight  #8fd4ff  light cyan-blue — authored into accentSecondary.
                         Passes VERBATIM on the dark navy chrome; on the light
                         chrome the gate honestly darkens it to #0091eb
                         (3.11:1) — reported, never silent.
     primary    #2456f0 (light mode) / #3f7cff (dark mode) — the vivid blue;
                         the accent. Both clear 3:1 on both chrome layers
                         verbatim, and the DERIVED on-accent foreground
                         carries >= 4.5:1 for text on blue.
     anchor     deep navy — the dark mode's SURFACES (#050815 canvas /
                         #0b1430 cards, Dark-Blue #0a1c46 lineage) and, in
                         light mode, gradient ends mixed toward the navy ink
                         at the token layer.
   ========================================================================== */

/** The operator theme's mode axis (standard light/dark). */
export type OperatorMode = "light" | "dark";

/** Brand INPUTS for the two modes (tenants.theme-row shaped, pre-gate). */
export const OPERATOR_MODE_INPUTS: Record<OperatorMode, BrandKitInput> = {
  light: {
    colors: {
      accent: "#2456f0", // primary vivid blue (passes verbatim on white)
      accentSecondary: "#8fd4ff", // highlight cyan — gate darkens on white (reported)
      accentWarm: "#c18000", // Alachua (post-gate lineage) — available, not leading
      surface: "#f4f6fa", // cool light-grey canvas (Spendex-airy ground)
      surfaceRaised: "#ffffff", // white cards
      ink: "#0b152b", // Dark-Blue-tinted near-black
      muted: "#5b6577", // cool grey secondary text
      positive: "#16a34a", // green up
      negative: "#e11d48", // rose-crimson down — URGENCY red, hue-separated from brand blues
    },
    typography: { ...OPERATOR_TYPOGRAPHY },
  },
  dark: {
    colors: {
      accent: "#3f7cff", // primary vivid blue, brightened for the dark chrome
      accentSecondary: "#8fd4ff", // highlight cyan — passes verbatim on navy
      accentWarm: "#f4a200", // original Alachua (passes verbatim on navy) — available, not leading
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
 * Build results (kit + accessibility report) per mode — exported so the
 * gate's corrections are surfaced (the theming engine never alters a brand
 * silently; doc 06 §3, §7).
 */
export const operatorModeBuild: Record<OperatorMode, ReturnType<typeof buildBrandKit>> = {
  light: buildBrandKit(OPERATOR_MODE_INPUTS.light),
  dark: buildBrandKit(OPERATOR_MODE_INPUTS.dark),
};

/** The two mode themes in `tenants.theme` jsonb shape, post-gate. */
export const operatorModeTheme: Record<OperatorMode, TenantTheme> = {
  light: toTenantTheme(operatorModeBuild.light.kit, { logoUrl: null, customDomain: null }),
  dark: toTenantTheme(operatorModeBuild.dark.kit, { logoUrl: null, customDomain: null }),
};

/* ==========================================================================
   PASS-2 PALETTE — Core Blue / Core Orange / Alachua (SUPERSEDED, KEPT)
   --------------------------------------------------------------------------
   The operator's brand-guide palette from pass 2. No longer the boot theme
   (the blue-depth dual palette above leads), but kept intact: it documents
   the accent library's provenance, still validates through the same gate,
   and remains available should the operator re-add colors later.
   ========================================================================== */

/** Pass-2 brand INPUT (superseded as boot theme; accents remain available). */
export const OPERATOR_BRAND_INPUT: BrandKitInput = {
  colors: {
    accent: OPERATOR_ACCENT_LIBRARY.coreBlue,
    accentSecondary: OPERATOR_ACCENT_LIBRARY.coreOrange,
    accentWarm: OPERATOR_ACCENT_LIBRARY.alachua,
    surface: "#f4f6fa", // cool light-grey canvas
    surfaceRaised: "#ffffff", // white cards
    ink: "#0b152b", // Dark-Blue-tinted near-black
    muted: "#5b6577", // cool grey secondary
    positive: "#16a34a", // green up
    negative: "#e11d48", // rose-crimson down (hue-separated from Core Orange)
  },
  typography: { ...OPERATOR_TYPOGRAPHY },
};

/** Pass-2 build result (kept: the gate report documents Alachua's correction). */
export const operatorBuild = buildBrandKit(OPERATOR_BRAND_INPUT);

/** Pass-2 theme in `tenants.theme` jsonb shape, post-gate (superseded, kept). */
export const operatorTheme: TenantTheme = toTenantTheme(operatorBuild.kit, {
  logoUrl: null,
  customDomain: null,
});
