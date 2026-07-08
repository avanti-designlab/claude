/**
 * Serialization for the two consumers of a kit:
 *
 * 1. `toCssVariables` — the app/theming engine (doc 06 §2–3). Emits the
 *    doc-specified custom-property names (`--surface`, `--surface-raised`,
 *    `--ink`, `--muted`, `--accent`, `--positive`, `--negative`) plus
 *    typography and spacing variables in Tailwind-v4-compatible naming.
 * 2. `toTenantTheme` — the `tenants.theme` jsonb shape (doc 03 §3:
 *    `{logo_url, colors, font, custom_domain}`) for white-label rendering.
 */

import type { BrandKit } from "@/lib/types/brand";
import type { ReadonlyDesignTokenSet } from "./defaults";

/**
 * Flatten a token set into CSS custom properties.
 *
 * Naming (exact):
 * - Colors (doc 06 §2): `--surface`, `--surface-raised`, `--ink`, `--muted`,
 *   `--accent`, `--positive`, `--negative`. Plus the additive two-accent brand
 *   extension: `--accent-secondary`, `--accent-warm`.
 * - Fonts: `--font-display`, `--font-body`, `--font-mono`.
 * - Type scale, per step `k`: `--text-{k}` (size),
 *   `--text-{k}--line-height`, and `--text-{k}--font-weight` when the step
 *   defines a weight (Tailwind v4 theme-variable convention).
 * - Spacing: `--space-unit` (`{unit}px`) and, per step multiplier `m`,
 *   `--space-{m}` = `{m * unit}px`.
 */
export function toCssVariables(tokens: ReadonlyDesignTokenSet): Record<string, string> {
  const vars: Record<string, string> = {};

  const { colors, typography, spacing } = tokens;
  vars["--surface"] = colors.surface;
  vars["--surface-raised"] = colors.surfaceRaised;
  vars["--ink"] = colors.ink;
  vars["--muted"] = colors.muted;
  vars["--accent"] = colors.accent;
  vars["--accent-secondary"] = colors.accentSecondary;
  vars["--accent-warm"] = colors.accentWarm;
  vars["--positive"] = colors.positive;
  vars["--negative"] = colors.negative;

  vars["--font-display"] = typography.display;
  vars["--font-body"] = typography.body;
  vars["--font-mono"] = typography.mono;
  for (const [step, def] of Object.entries(typography.scale)) {
    vars[`--text-${step}`] = def.size;
    vars[`--text-${step}--line-height`] = def.lineHeight;
    if (def.weight !== undefined) {
      vars[`--text-${step}--font-weight`] = String(def.weight);
    }
  }

  vars["--space-unit"] = `${spacing.unit}px`;
  for (const step of spacing.steps) {
    vars[`--space-${step}`] = `${step * spacing.unit}px`;
  }

  return vars;
}

/** Render the token set as a ready-to-inject CSS rule (default selector `:root`). */
export function toCssBlock(tokens: ReadonlyDesignTokenSet, selector = ":root"): string {
  const lines = Object.entries(toCssVariables(tokens)).map(
    ([name, value]) => `  ${name}: ${value};`
  );
  return `${selector} {\n${lines.join("\n")}\n}`;
}

/** The `tenants.theme` jsonb shape (doc 03 §3). */
export interface TenantTheme {
  logo_url: string | null;
  colors: {
    surface: string;
    surface_raised: string;
    ink: string;
    muted: string;
    accent: string;
    /**
     * Two-accent brand extension. Optional so hand-authored rows written
     * before the extension still resolve (the engine defaults them to the
     * neutral Signal accents). `toTenantTheme` always writes them.
     */
    accent_secondary?: string;
    accent_warm?: string;
    positive: string;
    negative: string;
  };
  font: {
    display: string;
    body: string;
    mono: string;
  };
  custom_domain: string | null;
}

export interface TenantThemeOptions {
  /** The tenant's logo — lives on the theme, not the kit (doc 03 §3). */
  logoUrl?: string | null;
  customDomain?: string | null;
}

/**
 * Project a kit onto the `tenants.theme` jsonb shape
 * (`{logo_url, colors, font, custom_domain}`) for white-label rendering.
 */
export function toTenantTheme(
  kit: BrandKit,
  options: TenantThemeOptions = {}
): TenantTheme {
  const { colors, typography } = kit.tokens;
  return {
    logo_url: options.logoUrl ?? null,
    colors: {
      surface: colors.surface,
      surface_raised: colors.surfaceRaised,
      ink: colors.ink,
      muted: colors.muted,
      accent: colors.accent,
      accent_secondary: colors.accentSecondary,
      accent_warm: colors.accentWarm,
      positive: colors.positive,
      negative: colors.negative,
    },
    font: {
      display: typography.display,
      body: typography.body,
      mono: typography.mono,
    },
    custom_domain: options.customDomain ?? null,
  };
}
