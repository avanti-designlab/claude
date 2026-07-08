/**
 * Demo tenant themes for the /design-system review surface.
 *
 * These are the ONLY files besides the token definitions in globals.css that
 * may contain literal brand colors — they play the role of `tenants.theme`
 * rows (brand INPUTS to the token pipeline), not UI values. The
 * no-hardcoded-colors test allowlists exactly this file.
 *
 * Two authoring paths are exercised on purpose (doc 06 §3):
 * - "coastal-realty": built through buildBrandKit → toTenantTheme (the
 *   brand-kit-design-token skill path) — arrives pre-validated.
 * - "verde-botanica" / "midgrey-holdings": hand-authored jsonb, as a theme
 *   row written directly via API would look — the engine's render-time gate
 *   is the enforcement point. Verde is deliberately near-failing (the gate
 *   auto-corrects and reports); Midgrey is deliberately unsolvable (the gate
 *   refuses and falls back to Signal).
 */

import {
  buildBrandKit,
  toTenantTheme,
  type TenantTheme,
} from "@/lib/skills/brand-kit";
import { operatorTheme } from "./operator-theme";

export interface DemoTenant {
  id: string;
  name: string;
  /** One-line description shown in the showcase switcher. */
  description: string;
  /** null = the neutral Signal framework theme straight from globals.css. */
  theme: TenantTheme | null;
}

/** Light, editorial, serif display — proves accent + font + surface swap. */
const coastalRealty: TenantTheme = toTenantTheme(
  buildBrandKit({
    colors: {
      accent: "#2f6db8",
      surface: "#f7f5f1",
    },
    typography: {
      display: '"Fraunces", "Georgia", serif',
    },
  }).kit,
  { logoUrl: null, customDomain: "portal.coastalrealty.example" }
);

/** Deep-green cannabis brand with deliberately weak muted/accent contrast. */
const verdeBotanica: TenantTheme = {
  logo_url: null,
  colors: {
    surface: "#0f2018",
    surface_raised: "#16291f",
    ink: "#e8f0ea",
    muted: "#6f8377",
    accent: "#2e7d4f",
    positive: "#45c496",
    negative: "#ef7466",
  },
  font: {
    display: '"Space Grotesk", "Inter", system-ui, sans-serif',
    body: '"Inter", system-ui, -apple-system, sans-serif',
    mono: '"IBM Plex Mono", "SFMono-Regular", Menlo, monospace',
  },
  custom_domain: null,
};

/**
 * Mathematically unsolvable: surface and raised surface sit on opposite
 * sides of mid-luminance, so no foreground can satisfy both. The engine must
 * refuse this palette and fall back to Signal with a logged reason.
 */
const midgreyHoldings: TenantTheme = {
  logo_url: null,
  colors: {
    surface: "#565f6d",
    surface_raised: "#aab2bf",
    ink: "#f5f5f5",
    muted: "#d0d4da",
    accent: "#7f8ea3",
    positive: "#45c496",
    negative: "#ef7466",
  },
  font: {
    display: '"Space Grotesk", "Inter", system-ui, sans-serif',
    body: '"Inter", system-ui, -apple-system, sans-serif',
    mono: '"IBM Plex Mono", "SFMono-Regular", Menlo, monospace',
  },
  custom_domain: null,
};

export const DEMO_TENANTS: DemoTenant[] = [
  {
    id: "operator",
    name: "Our agency (tenant #1)",
    description:
      "The active brand: high-end SaaS, light-first, Webflow-grounded — Sora display, electric-blue accent, white ground. Authored through buildBrandKit.",
    theme: operatorTheme,
  },
  {
    id: "signal",
    name: "Signal (framework default)",
    description:
      "The neutral-premium instrument chrome shipped as the built-in fallback — dark by default, with the light adaptation. Not brand-shaped.",
    theme: null,
  },
  {
    id: "coastal-realty",
    name: "Coastal Realty Group",
    description:
      "Light warm paper, marine accent, Fraunces display — authored through buildBrandKit.",
    theme: coastalRealty,
  },
  {
    id: "verde-botanica",
    name: "Verde Botanica",
    description:
      "Hand-authored, near-failing contrast — the gate auto-corrects and reports every fix.",
    theme: verdeBotanica,
  },
  {
    id: "midgrey-holdings",
    name: "Midgrey Holdings",
    description:
      "Deliberately unsolvable palette — the gate refuses it and falls back to Signal.",
    theme: midgreyHoldings,
  },
];
