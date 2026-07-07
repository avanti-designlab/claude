/**
 * Brand kit + design token shapes (docs 03 `brand_kits`, 06 §2–3).
 *
 * One shape, two uses: the brand-consistent production engine forces all
 * generated content/creative through a client's locked kit, and the
 * white-label theming engine renders each tenant's dashboard from the same
 * token structure (`tenants.theme`).
 */

/** The named color tokens (doc 06 §2). Chrome stays neutral-premium; the accent is brand-driven. */
export interface ColorTokens {
  /** Deep neutral base. */
  surface: string;
  surfaceRaised: string;
  /** High-contrast foreground. */
  ink: string;
  /** Secondary text. */
  muted: string;
  /** Tenant/client brand color — the one that does the talking. */
  accent: string;
  /** Citation up / rank up. */
  positive: string;
  /** Citation down / rank down. */
  negative: string;
}

export interface TypeScaleStep {
  size: string;
  lineHeight: string;
  weight?: number;
}

export interface TypographyTokens {
  /** Characterful display face — big data moments only (Visibility Score, section heroes). */
  display: string;
  /** Clean body face for dense dashboard reading. */
  body: string;
  /** Mono/utility face for data, metrics, code/schema views. */
  mono: string;
  scale: Record<string, TypeScaleStep>;
}

export interface SpacingTokens {
  /** Base unit in px. */
  unit: number;
  /** Multiplier steps of the base unit. */
  steps: number[];
}

export interface DesignTokenSet {
  colors: ColorTokens;
  typography: TypographyTokens;
  spacing: SpacingTokens;
}

/** Tone descriptors + samples that content generation reads at generation time. */
export interface VoiceProfile {
  descriptors: string[];
  samples: string[];
  do: string[];
  dont: string[];
}

/** Higgsfield/Motion reference element ids (doc 03 `brand_kits.likeness_refs`). */
export interface LikenessRefs {
  higgsfieldElementIds: string[];
  motionElementIds: string[];
}

/** Mirrors `brand_kits` (doc 03 §3): tokens / voice_profile / likeness_refs + locked + version. */
export interface BrandKit {
  tokens: DesignTokenSet;
  voice_profile: VoiceProfile;
  likeness_refs: LikenessRefs;
  locked: boolean;
  version: number;
}
