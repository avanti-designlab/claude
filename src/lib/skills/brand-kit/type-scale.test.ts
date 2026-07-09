import { describe, expect, it } from "vitest";
import type { TypeScaleStep } from "@/lib/types/brand";
import { SIGNAL_TYPOGRAPHY } from "./defaults";
import {
  isCssLineHeightToken,
  isCssSizeToken,
  isFontWeight,
  isTypeScaleKey,
  validateTypeScale,
} from "./type-scale";

/**
 * B1 (stored CSS injection), second family: the type scale. The reviewer's two
 * confirmed PoC payloads — a hostile size VALUE and a hostile step KEY — each
 * reach the emitted `--text-*` CSS if unchecked (serialize.ts:47-53). A hostile
 * WEIGHT lands raw via `String(weight)`. All must be REJECTED (throw, exactly
 * like a malformed color / font stack); a legitimate scale passes unchanged.
 */

/** Confirmed PoC: a hostile `size` value closes `:root` and injects a rule. */
const HOSTILE_SIZE_SCALE = {
  base: { size: "1rem; } body{display:none} .x{color:red", lineHeight: "1.5rem" },
} as unknown as Record<string, TypeScaleStep>;

/** Confirmed PoC: a hostile step KEY does the same via the `--text-{key}` name. */
const HOSTILE_KEY_SCALE = {
  "x; } body{display:none} .y{": { size: "1rem", lineHeight: "1.5rem" },
} as unknown as Record<string, TypeScaleStep>;

/** A non-numeric weight — `String(weight)` would emit it verbatim. */
const HOSTILE_WEIGHT_SCALE = {
  base: { size: "1rem", lineHeight: "1.5rem", weight: "700; } body{display:none}" },
} as unknown as Record<string, TypeScaleStep>;

describe("validateTypeScale — legitimate scales pass byte-for-byte unchanged", () => {
  it("returns the Signal default scale unchanged (same reference)", () => {
    expect(validateTypeScale(SIGNAL_TYPOGRAPHY.scale)).toBe(SIGNAL_TYPOGRAPHY.scale);
  });

  it("accepts a real custom scale (units, unitless line-height, in-range weights)", () => {
    const scale = {
      sm: { size: "0.875rem", lineHeight: "1.25rem" },
      "2xl": { size: "2rem", lineHeight: "1.1", weight: 600 },
      hero: { size: "72px", lineHeight: "1", weight: 800 },
      wide: { size: "100%", lineHeight: "1.4" },
    };
    expect(validateTypeScale(scale)).toBe(scale);
  });
});

describe("validateTypeScale — hostile scales are REJECTED (throw, like a malformed color)", () => {
  it("rejects the reviewer's hostile SIZE-value PoC", () => {
    expect(() => validateTypeScale(HOSTILE_SIZE_SCALE)).toThrow(
      /typography\.scale\.base\.size is not a valid CSS length/
    );
  });

  it("rejects the reviewer's hostile step-KEY PoC", () => {
    expect(() => validateTypeScale(HOSTILE_KEY_SCALE)).toThrow(
      /typography\.scale step name .* is not a valid CSS custom-property segment/
    );
  });

  it("rejects a hostile WEIGHT (String(weight) would emit it raw)", () => {
    expect(() => validateTypeScale(HOSTILE_WEIGHT_SCALE)).toThrow(
      /typography\.scale\.base\.weight must be a number from 1 to 1000/
    );
  });

  it("rejects every CSS-escape-capable character in a size value", () => {
    for (const ch of [";", "{", "}", "(", ")", ":", "<", ">", "/", "\\", " ", "\n", "\t"]) {
      expect(() =>
        validateTypeScale({ base: { size: `1rem${ch}`, lineHeight: "1.5rem" } } as unknown as Record<string, TypeScaleStep>)
      ).toThrow(/typography\.scale\.base\.size/);
    }
  });

  it("rejects url(...) / expression(...) smuggled into a size", () => {
    for (const size of ["url(https://evil.example/x)", "expression(alert(1))"]) {
      expect(() =>
        validateTypeScale({ base: { size, lineHeight: "1rem" } } as unknown as Record<string, TypeScaleStep>)
      ).toThrow(/typography\.scale\.base\.size/);
    }
  });

  it("rejects a missing/non-string size or lineHeight", () => {
    expect(() =>
      validateTypeScale({ base: { lineHeight: "1rem" } } as unknown as Record<string, TypeScaleStep>)
    ).toThrow(/typography\.scale\.base\.size is not a valid CSS length/);
    expect(() =>
      validateTypeScale({ base: { size: "1rem" } } as unknown as Record<string, TypeScaleStep>)
    ).toThrow(/typography\.scale\.base\.lineHeight is not a valid CSS line-height/);
  });

  it("rejects a non-object step", () => {
    expect(() =>
      validateTypeScale({ base: "1rem; }" } as unknown as Record<string, TypeScaleStep>)
    ).toThrow(/typography\.scale\.base must be an object/);
  });

  it("keeps the empty-scale contract + message", () => {
    expect(() => validateTypeScale({})).toThrow(/typography\.scale must define at least one step/);
  });

  it("rejects a non-object scale container", () => {
    expect(() =>
      validateTypeScale("evil" as unknown as Record<string, TypeScaleStep>)
    ).toThrow(/typography\.scale must be an object/);
  });
});

describe("type-scale field predicates (shared with the M7 write seam)", () => {
  it("isTypeScaleKey accepts every Signal key, rejects injection / uppercase / edge hyphens / over-length", () => {
    for (const k of ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "display", "hero", "score", "a", "a-b"]) {
      expect(isTypeScaleKey(k)).toBe(true);
    }
    for (const k of ["x; }", "-x", "x-", "Base", "a b", "a{b", "a/b", "a.b", "", "a".repeat(49)]) {
      expect(isTypeScaleKey(k)).toBe(false);
    }
  });

  it("isCssSizeToken requires a unit and rejects injection / unitless / non-strings", () => {
    for (const v of ["1rem", "0.9375rem", "72px", "100%", "2em", "3ch", "10vw", "5vh", "4ex"]) {
      expect(isCssSizeToken(v)).toBe(true);
    }
    for (const v of ["1", "1rem;", "1rem }", "url(x)", "1 rem", "expression(1)", "", "1cm", 5, null]) {
      expect(isCssSizeToken(v)).toBe(false);
    }
  });

  it("isCssLineHeightToken allows unitless AND units, rejects injection", () => {
    for (const v of ["1", "1.5", "1.05", "1.5rem", "20px"]) {
      expect(isCssLineHeightToken(v)).toBe(true);
    }
    for (const v of ["1.5;", "1 }", "calc(1)", "", "abc"]) {
      expect(isCssLineHeightToken(v)).toBe(false);
    }
  });

  it("isFontWeight accepts 1..1000 numbers, rejects strings and out-of-range", () => {
    for (const w of [1, 400, 650, 700, 1000]) {
      expect(isFontWeight(w)).toBe(true);
    }
    for (const w of [0, 1001, Number.NaN, Number.POSITIVE_INFINITY, "700", "700; }", null, undefined]) {
      expect(isFontWeight(w)).toBe(false);
    }
  });
});
