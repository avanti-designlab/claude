/**
 * buildBrandKit — encode a client/tenant brand into a complete, validated
 * `BrandKit` (docs 03 §3 `brand_kits`, 06 §2–3; skill: brand-kit-design-token).
 *
 * Minimal input is a single brand accent color; the neutral-premium "Signal"
 * defaults fill everything the brand does not specify, and every palette is
 * contrast-validated and auto-corrected before it leaves this function.
 */

import type {
  BrandKit,
  ColorTokens,
  DesignTokenSet,
  LikenessRefs,
  SpacingTokens,
  TypeScaleStep,
  TypographyTokens,
  VoiceProfile,
} from "@/lib/types/brand";
import { adjustLightness, normalizeHex, relativeLuminance } from "./color";
import { ensureAccessibleColors, type AccessibilityReport } from "./contrast";
import {
  SIGNAL_COLORS,
  SIGNAL_LIGHT_NEUTRALS,
  SIGNAL_SPACING,
  SIGNAL_TYPOGRAPHY,
} from "./defaults";
import { validateFontStack } from "./font-stack";
import { deepClone } from "./structural";

export interface BrandColorInput {
  /** The brand color. Drives the `accent` token. Required. */
  accent: string;
  /**
   * Optional secondary/warm brand accents (the two-accent brand extension).
   * Unspecified → the neutral Signal defaults. Gated like `accent`.
   */
  accentSecondary?: string;
  accentWarm?: string;
  /** Optional brand neutrals. Unspecified neutrals fall back to the Signal defaults (adapted to the surface when one is given). */
  surface?: string;
  surfaceRaised?: string;
  ink?: string;
  muted?: string;
  /** Optional functional colors. Must remain mutually distinguishable — corrected if not. */
  positive?: string;
  negative?: string;
}

export interface BrandTypographyInput {
  display?: string;
  body?: string;
  mono?: string;
  /** Full replacement type scale. Omit to use the Signal scale. */
  scale?: Record<string, TypeScaleStep>;
}

export interface BrandKitInput {
  colors: BrandColorInput;
  /** Stored on `tenants.theme.logo_url` via `toTenantTheme` — the kit row itself has no logo column (doc 03 §3). */
  logoUrl?: string;
  typography?: BrandTypographyInput;
  spacing?: Partial<SpacingTokens>;
  voice?: Partial<VoiceProfile>;
  likeness?: Partial<LikenessRefs>;
}

export interface BrandKitBuildResult {
  /** Complete kit: locked=false, version=1. Caller persists it (brand_kits row). */
  kit: BrandKit;
  /** Contrast validation results + every auto-correction applied, with reasons. */
  accessibility: AccessibilityReport;
  /** Echoed for the caller to thread into `toTenantTheme` — not part of the kit. */
  logoUrl: string | null;
}

/** Luminance below which a surface is treated as dark chrome. */
const DARK_SURFACE_LUMINANCE = 0.4;

function normalizeInputHex(value: string, field: string): string {
  try {
    return normalizeHex(value);
  } catch {
    throw new Error(`Invalid hex color for colors.${field}: "${value}"`);
  }
}

/**
 * Resolve the full 7-token palette from brand input + Signal defaults.
 * When the brand specifies its own surface, the unspecified neutrals are
 * derived from that surface (raised = one lightness step away; ink/muted
 * switch to the light-chrome counterparts on light surfaces) instead of
 * blindly mixing dark defaults into a light brand.
 */
function resolveColors(input: BrandColorInput): ColorTokens {
  if (!input || typeof input.accent !== "string" || input.accent.trim() === "") {
    throw new Error("buildBrandKit requires colors.accent (the brand color)");
  }

  const surface =
    input.surface !== undefined
      ? normalizeInputHex(input.surface, "surface")
      : SIGNAL_COLORS.surface;
  const surfaceIsCustom = input.surface !== undefined;
  const surfaceIsDark = relativeLuminance(surface) < DARK_SURFACE_LUMINANCE;

  const surfaceRaised =
    input.surfaceRaised !== undefined
      ? normalizeInputHex(input.surfaceRaised, "surfaceRaised")
      : surfaceIsCustom
        ? adjustLightness(surface, surfaceIsDark ? 4 : -4)
        : SIGNAL_COLORS.surfaceRaised;

  const ink =
    input.ink !== undefined
      ? normalizeInputHex(input.ink, "ink")
      : surfaceIsDark
        ? SIGNAL_COLORS.ink
        : SIGNAL_LIGHT_NEUTRALS.ink;

  const muted =
    input.muted !== undefined
      ? normalizeInputHex(input.muted, "muted")
      : surfaceIsDark
        ? SIGNAL_COLORS.muted
        : SIGNAL_LIGHT_NEUTRALS.muted;

  return {
    surface,
    surfaceRaised,
    ink,
    muted,
    accent: normalizeInputHex(input.accent, "accent"),
    accentSecondary:
      input.accentSecondary !== undefined
        ? normalizeInputHex(input.accentSecondary, "accentSecondary")
        : SIGNAL_COLORS.accentSecondary,
    accentWarm:
      input.accentWarm !== undefined
        ? normalizeInputHex(input.accentWarm, "accentWarm")
        : SIGNAL_COLORS.accentWarm,
    positive:
      input.positive !== undefined
        ? normalizeInputHex(input.positive, "positive")
        : SIGNAL_COLORS.positive,
    negative:
      input.negative !== undefined
        ? normalizeInputHex(input.negative, "negative")
        : SIGNAL_COLORS.negative,
  };
}

/**
 * Each face is gated through `validateFontStack` (font-family grammar
 * whitelist) BEFORE it can reach `toCssVariables` — font stacks are emitted
 * verbatim into stylesheets, so a hostile value (`}`/`;`/`<`/`url(`) throws
 * here like a malformed color does, and the theme engine falls back to
 * Signal. See font-stack.ts for the threat model.
 */
function resolveTypography(input?: BrandTypographyInput): TypographyTokens {
  const resolved: TypographyTokens = {
    display: validateFontStack(input?.display ?? SIGNAL_TYPOGRAPHY.display, "display"),
    body: validateFontStack(input?.body ?? SIGNAL_TYPOGRAPHY.body, "body"),
    mono: validateFontStack(input?.mono ?? SIGNAL_TYPOGRAPHY.mono, "mono"),
    scale: deepClone(input?.scale ?? SIGNAL_TYPOGRAPHY.scale),
  };
  if (Object.keys(resolved.scale).length === 0) {
    throw new Error("typography.scale must define at least one step");
  }
  return resolved;
}

function resolveSpacing(input?: Partial<SpacingTokens>): SpacingTokens {
  const unit = input?.unit ?? SIGNAL_SPACING.unit;
  // Spread: a fresh mutable copy of what may be the frozen `readonly` default.
  const steps = [...(input?.steps ?? SIGNAL_SPACING.steps)];
  if (!Number.isFinite(unit) || unit <= 0) {
    throw new Error(`spacing.unit must be a positive number of px, got ${unit}`);
  }
  if (steps.length === 0 || steps.some((s) => !Number.isFinite(s) || s < 0)) {
    throw new Error("spacing.steps must be a non-empty list of non-negative multipliers");
  }
  return { unit, steps };
}

function resolveVoice(input?: Partial<VoiceProfile>): VoiceProfile {
  return {
    descriptors: deepClone(input?.descriptors ?? []),
    samples: deepClone(input?.samples ?? []),
    do: deepClone(input?.do ?? []),
    dont: deepClone(input?.dont ?? []),
  };
}

function resolveLikeness(input?: Partial<LikenessRefs>): LikenessRefs {
  return {
    higgsfieldElementIds: deepClone(input?.higgsfieldElementIds ?? []),
    motionElementIds: deepClone(input?.motionElementIds ?? []),
  };
}

/**
 * The single resolve/validate pipeline for a full token set: colors are
 * contrast-validated and auto-corrected, typography and spacing are
 * structurally validated. EVERY path that produces a kit — `buildBrandKit`
 * and `reviseKit` — runs through this function, so no mutation path can
 * smuggle an invalid token set past the gates.
 *
 * Internal to the library (exported for `lock.ts`, not from the index).
 */
export function resolveAndValidateTokens(
  colors: ColorTokens,
  typography: BrandTypographyInput | undefined,
  spacing: Partial<SpacingTokens> | undefined
): { tokens: DesignTokenSet; report: AccessibilityReport } {
  const { colors: accessible, report } = ensureAccessibleColors(colors);
  return {
    tokens: {
      colors: accessible,
      typography: resolveTypography(typography),
      spacing: resolveSpacing(spacing),
    },
    report,
  };
}

/**
 * Build a complete, contrast-validated brand kit from brand assets.
 *
 * The returned kit is unlocked at version 1. Lock it with `lockKit` once
 * approved; after that, changes go through `reviseKit` (new version, history
 * preserved by the caller).
 */
export function buildBrandKit(input: BrandKitInput): BrandKitBuildResult {
  const { tokens, report } = resolveAndValidateTokens(
    resolveColors(input.colors),
    input.typography,
    input.spacing
  );

  const kit: BrandKit = {
    tokens,
    voice_profile: resolveVoice(input.voice),
    likeness_refs: resolveLikeness(input.likeness),
    locked: false,
    version: 1,
  };

  return { kit, accessibility: report, logoUrl: input.logoUrl ?? null };
}
