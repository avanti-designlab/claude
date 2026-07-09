/**
 * brand-kit-design-token skill library (build step 0.2).
 *
 * Encode a client/tenant brand into an enforceable, contrast-validated,
 * versioned `BrandKit`. One library, two consumers: the brand-consistent
 * production engine (`brand_kits.tokens`) and the white-label theming engine
 * (`tenants.theme`). Pure TypeScript — no network, no DB, no DOM.
 *
 * Specs: docs/06 §2–3, §7; docs/03 §3; .claude/skills/brand-kit-design-token.
 */

// Build
export {
  buildBrandKit,
  type BrandColorInput,
  type BrandKitBuildResult,
  type BrandKitInput,
  type BrandTypographyInput,
} from "./build";

// Locking + versioning
export {
  lockKit,
  reviseKit,
  type BrandKitRevision,
  type BrandKitRevisionResult,
} from "./lock";

// Serialization
export {
  toCssBlock,
  toCssVariables,
  toTenantTheme,
  type TenantTheme,
  type TenantThemeOptions,
} from "./serialize";

// Font-stack grammar gate (stored-CSS-injection defense)
export { validateFontStack } from "./font-stack";

// Type-scale grammar gate + field predicates (stored-CSS-injection defense; the
// predicates let the M7 write seam mirror this gate in interface voice).
export {
  isCssLineHeightToken,
  isCssSizeToken,
  isFontWeight,
  isTypeScaleKey,
  validateTypeScale,
} from "./type-scale";

// Accessibility validation + correction
export {
  CONTRAST_REQUIREMENTS,
  checkDistinguishability,
  ensureAccessibleColors,
  nearestAccessibleVariant,
  validateColorTokens,
  type AccessibilityReport,
  type ContrastCheck,
  type DistinguishabilityCheck,
  type TokenAdjustment,
} from "./contrast";

// "Signal" defaults (the tenant #1 / neutral-premium theme)
export {
  SIGNAL_COLORS,
  SIGNAL_DEFAULT_TOKENS,
  SIGNAL_LIGHT_NEUTRALS,
  SIGNAL_SPACING,
  SIGNAL_TYPOGRAPHY,
  type ReadonlyDesignTokenSet,
  type ReadonlySpacingTokens,
} from "./defaults";

// Color math
export {
  adjustLightness,
  contrastRatio,
  hexToRgb,
  hueOf,
  hueSeparationDeg,
  lightnessOf,
  normalizeHex,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  setLightness,
  type Hsl,
  type Rgb,
} from "./color";

// Shared shapes, re-exported for consumers of this library
export type {
  BrandKit,
  ColorTokens,
  DesignTokenSet,
  LikenessRefs,
  SpacingTokens,
  TypeScaleStep,
  TypographyTokens,
  VoiceProfile,
} from "@/lib/types/brand";
