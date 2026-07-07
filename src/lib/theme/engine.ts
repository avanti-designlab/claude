/**
 * White-label theming engine (F2, doc 06 §3).
 *
 * Takes a `tenants.theme`-shaped object (the `toTenantTheme` output of the
 * brand-kit pipeline — or a hand-authored jsonb blob from the DB), rebuilds
 * and re-validates it through `buildBrandKit`, and emits the full CSS
 * custom-property set for a tenant scope. This module is the ENFORCEMENT
 * point: a palette that cannot be made accessible is refused and the Signal
 * default theme is applied instead, with the reason logged and surfaced.
 *
 * Every emitted variable comes from the token pipeline (`toCssVariables`)
 * plus the small derived-chrome set below, which is computed FROM pipeline
 * tokens by a single rule. No other source of color exists.
 */

import {
  buildBrandKit,
  contrastRatio,
  SIGNAL_DEFAULT_TOKENS,
  toCssVariables,
  type AccessibilityReport,
  type BrandKitBuildResult,
  type ColorTokens,
  type TenantTheme,
} from "@/lib/skills/brand-kit";

export { SIGNAL_LIGHT_SURFACE } from "./light-surface";

/** Which palette token an on-color foreground should use. */
export type OnColorChoice = "surface" | "ink";

/**
 * Derived on-color foregrounds — the text color used ON accent / positive /
 * negative fills (primary buttons, destructive buttons, solid chips).
 * One rule, applied to every theme: whichever of `surface` / `ink` carries
 * the higher WCAG contrast against the fill. The theme gate guarantees each
 * fill has >= 3:1 against `surface`, so the winner is always usable.
 */
export function deriveOnColorForegrounds(
  colors: ColorTokens
): Record<"accent" | "positive" | "negative", OnColorChoice> {
  const pick = (fill: string): OnColorChoice =>
    contrastRatio(fill, colors.surface) >= contrastRatio(fill, colors.ink)
      ? "surface"
      : "ink";
  return {
    accent: pick(colors.accent),
    positive: pick(colors.positive),
    negative: pick(colors.negative),
  };
}

/** The derived variables the engine adds on top of the pipeline set. */
export const DERIVED_VARIABLE_NAMES = [
  "--accent-foreground",
  "--positive-foreground",
  "--negative-foreground",
] as const;

function derivedVariables(colors: ColorTokens): Record<string, string> {
  const choices = deriveOnColorForegrounds(colors);
  return {
    "--accent-foreground": `var(--${choices.accent === "surface" ? "surface" : "ink"})`,
    "--positive-foreground": `var(--${choices.positive === "surface" ? "surface" : "ink"})`,
    "--negative-foreground": `var(--${choices.negative === "surface" ? "surface" : "ink"})`,
  };
}

export interface TenantThemeResolution {
  /** "tenant" when the theme passed the accessibility gate; otherwise the Signal fallback was applied. */
  source: "tenant" | "signal-fallback";
  /**
   * Complete custom-property set for the scope: the pipeline variables
   * (toCssVariables) plus the derived on-color foregrounds. When the source
   * is "tenant", auto-corrected values are already baked in.
   */
  variables: Record<string, string>;
  /**
   * Accessibility report for the REQUESTED theme (including the corrections
   * applied, or the checks that could not be resolved). Null only when the
   * theme was malformed before validation could run (e.g. unparseable hex).
   */
  report: AccessibilityReport | null;
  /** Human-readable reason the tenant theme was refused; null when applied. */
  fallbackReason: string | null;
}

export interface ResolveTenantThemeOptions {
  /**
   * Called with the logged reason whenever a tenant theme is refused and the
   * Signal fallback is applied. Defaults to console.warn — a refused theme
   * must never be silent (doc 06 §3, §7).
   */
  onFallback?: (reason: string, report: AccessibilityReport | null) => void;
}

function tenantThemeToKitInput(theme: TenantTheme) {
  return {
    colors: {
      accent: theme.colors.accent,
      surface: theme.colors.surface,
      surfaceRaised: theme.colors.surface_raised,
      ink: theme.colors.ink,
      muted: theme.colors.muted,
      positive: theme.colors.positive,
      negative: theme.colors.negative,
    },
    typography: {
      display: theme.font.display,
      body: theme.font.body,
      mono: theme.font.mono,
    },
    logoUrl: theme.logo_url ?? undefined,
  };
}

function unresolvedSummary(report: AccessibilityReport): string {
  const failedChecks = report.checks
    .filter((c) => !c.pass)
    .map((c) => `${c.id} ${c.ratio.toFixed(2)}:1 < ${c.required}:1`);
  const unresolved = report.adjustments
    .filter((a) => !a.resolved)
    .map((a) => `${a.token}: ${a.reason}`);
  const distinguishability = report.distinguishability.pass
    ? []
    : ["positive-vs-negative not distinguishable"];
  return [...failedChecks, ...distinguishability, ...unresolved].join(" | ");
}

/** The Signal fallback resolution, shared by every refusal path. */
function signalFallback(
  reason: string,
  report: AccessibilityReport | null,
  onFallback: NonNullable<ResolveTenantThemeOptions["onFallback"]>
): TenantThemeResolution {
  onFallback(reason, report);
  return {
    source: "signal-fallback",
    variables: {
      ...toCssVariables(SIGNAL_DEFAULT_TOKENS),
      ...derivedVariables(SIGNAL_DEFAULT_TOKENS.colors),
    },
    report,
    fallbackReason: reason,
  };
}

/**
 * Resolve a tenant theme into an applicable variable set — the single code
 * path for every tenant (tenant #1's Signal theme included, via the
 * defaults baked into globals.css from the same pipeline).
 *
 * - Valid palette → tenant variables (with any auto-corrections applied and
 *   reported).
 * - Unsolvable palette (the accessibility report fails even after
 *   correction) → REFUSED: Signal fallback + logged reason.
 * - Malformed theme (unparseable colors; empty font stacks; font stacks
 *   outside the CSS font-family grammar — the stored-CSS-injection gate,
 *   see brand-kit/font-stack.ts) → REFUSED the same way.
 */
export function resolveTenantTheme(
  theme: TenantTheme,
  options: ResolveTenantThemeOptions = {}
): TenantThemeResolution {
  const onFallback =
    options.onFallback ??
    ((reason: string) => {
      console.warn(`[theme-engine] tenant theme refused: ${reason}`);
    });

  let built: BrandKitBuildResult;
  try {
    built = buildBrandKit(tenantThemeToKitInput(theme));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return signalFallback(
      `theme is malformed and could not be validated: ${message}`,
      null,
      onFallback
    );
  }

  if (!built.accessibility.pass) {
    return signalFallback(
      `palette cannot meet the contrast requirements even after correction: ${unresolvedSummary(built.accessibility)}`,
      built.accessibility,
      onFallback
    );
  }

  return {
    source: "tenant",
    variables: {
      ...toCssVariables(built.kit.tokens),
      ...derivedVariables(built.kit.tokens.colors),
    },
    report: built.accessibility,
    fallbackReason: null,
  };
}

/**
 * Render a resolution as a ready-to-inject CSS rule scoped to
 * `:root[data-tenant-theme="<id>"]`. Injected <style> content comes after
 * the stylesheet in document order, so these declarations win over the
 * Signal defaults (and the light-mode media block) at equal specificity.
 */
export function tenantThemeCss(
  resolution: TenantThemeResolution,
  tenantId: string
): string {
  const safeId = tenantId.replace(/["\\]/g, "");
  const lines = Object.entries(resolution.variables).map(
    ([name, value]) => `  ${name}: ${value};`
  );
  return `:root[data-tenant-theme="${safeId}"] {\n${lines.join("\n")}\n}`;
}
