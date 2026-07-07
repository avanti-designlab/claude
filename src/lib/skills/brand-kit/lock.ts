/**
 * Locking + versioning semantics (doc 03 §3 `brand_kits.locked` /
 * `brand_kits.version`; skill rule 3: "Kits are versioned; changing a locked
 * kit creates a new version — history is never overwritten").
 *
 * - `lockKit` returns a deep-frozen, locked copy. Direct mutation of any part
 *   of a locked kit throws (strict-mode TypeError).
 * - `reviseKit` is the only way to change a locked kit: it returns a NEW,
 *   unlocked kit at version+1 with the changes merged in and the palette
 *   re-validated. The input kit is never touched — the caller persists both
 *   rows, so history survives.
 */

import type {
  BrandKit,
  ColorTokens,
  LikenessRefs,
  SpacingTokens,
  TypeScaleStep,
  TypographyTokens,
  VoiceProfile,
} from "@/lib/types/brand";
import { ensureAccessibleColors, type AccessibilityReport } from "./contrast";
import { deepClone, deepFreeze, deepMerge } from "./structural";

/**
 * Changes accepted by `reviseKit`. `locked` and `version` are managed by the
 * library and cannot be patched. Objects merge deeply; arrays (voice lists,
 * likeness ids, spacing steps) replace wholesale.
 */
export interface BrandKitRevision {
  tokens?: {
    colors?: Partial<ColorTokens>;
    typography?: Partial<Omit<TypographyTokens, "scale">> & {
      scale?: Record<string, TypeScaleStep>;
    };
    spacing?: Partial<SpacingTokens>;
  };
  voice_profile?: Partial<VoiceProfile>;
  likeness_refs?: Partial<LikenessRefs>;
}

export interface BrandKitRevisionResult {
  /** The new kit: version = base.version + 1, locked = false. */
  kit: BrandKit;
  /** Contrast validation of the revised palette (auto-corrections included). */
  accessibility: AccessibilityReport;
}

/**
 * Return a locked, deep-frozen copy of the kit. The original is not modified.
 * Any attempt to mutate the returned kit — top-level or nested — throws.
 */
export function lockKit(kit: BrandKit): Readonly<BrandKit> {
  const locked = deepClone(kit);
  locked.locked = true;
  return deepFreeze(locked);
}

/**
 * Create the next version of a kit. Works on locked and unlocked kits alike;
 * for locked kits it is the ONLY way to make a change. The result is a brand
 * new, mutable kit with `version + 1` and `locked: false` — lock it again
 * once approved. The revised palette goes through the same contrast
 * validation/correction as `buildBrandKit`.
 */
export function reviseKit(
  kit: BrandKit,
  changes: BrandKitRevision
): BrandKitRevisionResult {
  // Accept only the revisable fields — `locked`/`version` in a loosely typed
  // caller's object are ignored, never merged.
  const patch: BrandKitRevision = {
    tokens: changes.tokens,
    voice_profile: changes.voice_profile,
    likeness_refs: changes.likeness_refs,
  };

  const next = deepMerge(deepClone(kit) as unknown as Record<string, unknown>, patch) as unknown as BrandKit;
  const { colors, report } = ensureAccessibleColors(next.tokens.colors);
  next.tokens.colors = colors;
  next.version = kit.version + 1;
  next.locked = false;

  return { kit: next, accessibility: report };
}
