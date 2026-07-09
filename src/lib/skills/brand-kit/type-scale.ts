/**
 * Type-scale validation — the anti-injection gate for the second family of
 * caller-controlled free-text typography tokens: the type scale.
 *
 * Font stacks (font-stack.ts) are NOT the only free-text values a tenant
 * controls. Each type-scale step becomes emitted CSS verbatim through the
 * serializer (`toCssVariables`): the step KEY is concatenated into a
 * `--text-${key}` custom-property NAME, and its `size` / `lineHeight` / `weight`
 * are concatenated in as VALUES. So a within-cap hostile scale can close the
 * `:root` rule early and inject arbitrary app-wide CSS through EITHER the key
 * (`x; } body{display:none} .y{`) OR a value (a `size` of
 * `1rem; } body{display:none} .x{color:red`) — the same stored-CSS-injection
 * class font-stack.ts defends against, reached through the type scale instead
 * of the font faces. `weight` is emitted via `String(weight)`, so a non-numeric
 * weight lands raw too.
 *
 * This gate mirrors `validateFontStack`: strict WHITELIST grammars, and a THROW
 * (never sanitize-by-strip) on any violation, so the theme/build engine falls
 * back to Signal and the attack is surfaced rather than silently rendered.
 * Colors are re-parsed to normalized hex and spacing is numeric, so with the
 * font stacks and this scale gated, no tenant free-text reaches emitted CSS
 * unvalidated.
 *
 *   - KEYS  → `--text-${key}` custom-property segments: lowercase letters,
 *             digits, and interior hyphens only (never leading/trailing), a
 *             bounded length. Matches every Signal key (`xs`…`score`, `2xl`).
 *   - size  → a CSS length: a number with one of a safe unit set
 *             (rem|em|px|%|ex|ch|vw|vh). No braces/semicolons/parens/colons/
 *             whitespace, so `url(` / `expression(` / rule-breakouts cannot form.
 *   - lineHeight → the same length grammar OR a unitless number (`1.5`, `1`).
 *   - weight → a finite number in [1, 1000] (CSS font-weight range); a
 *             non-numeric weight is rejected before `String(weight)` can emit it.
 */

import type { TypeScaleStep } from "@/lib/types/brand";

/** Max length of a step key (`--text-${key}` segment). Generous vs. real keys ("display" = 7). */
const SCALE_KEY_MAX = 48;
/** Max length of a `size` / `lineHeight` token ("0.9375rem" = 9). Bounds a giant-digit-string. */
const SCALE_VALUE_MAX = 32;
/** CSS font-weight numeric range. */
const FONT_WEIGHT_MIN = 1;
const FONT_WEIGHT_MAX = 1000;

/**
 * A `--text-${key}` custom-property segment: lowercase letters/digits, with
 * interior hyphens allowed but never a leading/trailing one. (`2xl`, `3xl`
 * start with a digit — valid after the `--text-` prefix.)
 */
const SCALE_KEY_GRAMMAR = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
/** A CSS length: a non-negative number that MUST carry one of the safe units. */
const CSS_SIZE_GRAMMAR = /^\d+(\.\d+)?(rem|em|px|%|ex|ch|vw|vh)$/;
/** A CSS line-height: the length grammar, but the unit is OPTIONAL (unitless allowed). */
const CSS_LINE_HEIGHT_GRAMMAR = /^\d+(\.\d+)?(rem|em|px|%|ex|ch|vw|vh)?$/;

/** True when `key` is a safe `--text-${key}` custom-property segment. */
export function isTypeScaleKey(key: string): boolean {
  return key.length <= SCALE_KEY_MAX && SCALE_KEY_GRAMMAR.test(key);
}

/** True when `value` is a CSS length token safe to emit as a `--text-*` size. */
export function isCssSizeToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= SCALE_VALUE_MAX && CSS_SIZE_GRAMMAR.test(value);
}

/** True when `value` is a CSS line-height token (a length OR a unitless number). */
export function isCssLineHeightToken(value: unknown): value is string {
  return typeof value === "string" && value.length <= SCALE_VALUE_MAX && CSS_LINE_HEIGHT_GRAMMAR.test(value);
}

/** True when `value` is a finite CSS font-weight number in [1, 1000]. */
export function isFontWeight(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= FONT_WEIGHT_MIN && value <= FONT_WEIGHT_MAX;
}

/** Render a candidate key readably + safely (escaped, bounded) for an error/log message. */
function describeKey(key: string): string {
  const shown = key.length > 32 ? `${key.slice(0, 32)}…` : key;
  return JSON.stringify(shown);
}

/**
 * Validate a full type scale against the grammars above.
 *
 * @param scale the candidate scale (untrusted — from brand-kit input or a
 *   revision diff), already the mutable shape the serializer will read.
 * @returns the scale, byte-for-byte unchanged, when every step is safe.
 * @throws Error naming the offending field when it is not. Same contract as a
 *   malformed color / font stack: throw → the build/revise pipeline surfaces it
 *   (M7 maps it to `invalid_brand_input`), never a silent rewrite.
 */
export function validateTypeScale(scale: Record<string, TypeScaleStep>): Record<string, TypeScaleStep> {
  if (typeof scale !== "object" || scale === null || Array.isArray(scale)) {
    throw new Error("typography.scale must be an object of type-scale steps");
  }
  const entries = Object.entries(scale);
  if (entries.length === 0) {
    // Preserved message + contract from the original resolveTypography check.
    throw new Error("typography.scale must define at least one step");
  }
  for (const [key, step] of entries) {
    if (!isTypeScaleKey(key)) {
      throw new Error(
        `typography.scale step name ${describeKey(key)} is not a valid CSS custom-property segment ` +
          `(allowed: lowercase letters, digits, and interior hyphens — e.g. "lg" or "2xl")`
      );
    }
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      throw new Error(`typography.scale.${key} must be an object with a size and lineHeight`);
    }
    const s = step as unknown as Record<string, unknown>;
    if (!isCssSizeToken(s.size)) {
      throw new Error(
        `typography.scale.${key}.size is not a valid CSS length ` +
          `(allowed: a number with a unit rem|em|px|%|ex|ch|vw|vh — no braces, semicolons, or parentheses)`
      );
    }
    if (!isCssLineHeightToken(s.lineHeight)) {
      throw new Error(
        `typography.scale.${key}.lineHeight is not a valid CSS line-height ` +
          `(allowed: a unitless number or a number with a unit rem|em|px|%|ex|ch|vw|vh)`
      );
    }
    if (s.weight !== undefined && !isFontWeight(s.weight)) {
      throw new Error(
        `typography.scale.${key}.weight must be a number from ${FONT_WEIGHT_MIN} to ${FONT_WEIGHT_MAX}`
      );
    }
  }
  return scale;
}
