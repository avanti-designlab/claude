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
 * Direction: high-end SaaS, light-first, modelled on Webflow's published
 * brand (webflow.com). Grounded anchors, adapted for accessibility + product
 * restraint:
 *  - accent  #146ef5  Webflow electric blue — used sparingly and confidently
 *                     (primary buttons, key links, focus, the signature moment).
 *  - surface #ffffff  clean white page field (Webflow's native ground). Kept
 *                     pure white so the frozen on-color derivation resolves
 *                     button labels to white-on-blue (4.58:1) rather than the
 *                     muddy near-black-on-blue the mid-luminance accent would
 *                     otherwise win — see the note in the report at the top of
 *                     the file's build result.
 *  - raised  #f4f6f9  cool whisper-grey panels/cards band above the white page
 *                     (Webflow's light-grey feature bands); hairline + soft
 *                     shadow separate them.
 *  - ink     #080808  Webflow near-black, high-contrast headings / body.
 *  - muted   #5b6473  refined cool grey secondary text.
 * Display face is Sora (a free, self-hosted geometric grotesque standing in
 * for Webflow's proprietary "WF Visual Sans"); body is the already self-hosted
 * Inter; mono stays IBM Plex Mono.
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
 * Geometric-grotesque display face (Sora) standing in for "WF Visual Sans".
 * Self-hosted woff2 in `public/fonts/sora-var.woff2`; @font-face in
 * globals.css. Inter (body) and IBM Plex Mono (mono) are already self-hosted.
 */
export const OPERATOR_TYPOGRAPHY = {
  display: '"Sora", "Inter", system-ui, sans-serif',
  body: '"Inter", system-ui, -apple-system, sans-serif',
  mono: '"IBM Plex Mono", "SFMono-Regular", Menlo, monospace',
} as const;

/**
 * The brand INPUT. `buildBrandKit` fills any unspecified neutrals and runs the
 * full contrast gate; `positive`/`negative` default to the Signal functional
 * colors and are auto-adapted to the light surface by the gate.
 */
export const OPERATOR_BRAND_INPUT: BrandKitInput = {
  colors: {
    accent: "#146ef5",
    surface: "#ffffff",
    surfaceRaised: "#f4f6f9",
    ink: "#080808",
    muted: "#5b6473",
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
