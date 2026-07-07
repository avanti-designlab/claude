import { describe, expect, it } from "vitest";
import {
  adjustLightness,
  contrastRatio,
  hexToRgb,
  hslToRgb,
  hueOf,
  hueSeparationDeg,
  lightnessOf,
  normalizeHex,
  relativeLuminance,
  rgbToHex,
  rgbToHsl,
  setLightness,
} from "./color";

describe("normalizeHex", () => {
  it("normalizes 6-digit hex to lowercase with a leading #", () => {
    expect(normalizeHex("#AaBbCc")).toBe("#aabbcc");
    expect(normalizeHex("aabbcc")).toBe("#aabbcc");
  });

  it("expands 3-digit shorthand", () => {
    expect(normalizeHex("#abc")).toBe("#aabbcc");
    expect(normalizeHex("ABC")).toBe("#aabbcc");
    expect(normalizeHex("#fff")).toBe("#ffffff");
  });

  it("drops the alpha channel from 4- and 8-digit forms", () => {
    expect(normalizeHex("#abcf")).toBe("#aabbcc");
    expect(normalizeHex("#aabbccdd")).toBe("#aabbcc");
    expect(normalizeHex("AABBCC80")).toBe("#aabbcc");
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeHex("  #fff  ")).toBe("#ffffff");
  });

  it("throws on invalid input", () => {
    for (const bad of ["", "#", "#12", "#12345", "#1234567", "red", "#gggggg", "rgb(0,0,0)"]) {
      expect(() => normalizeHex(bad), `should reject "${bad}"`).toThrow();
    }
  });
});

describe("hexToRgb / rgbToHex", () => {
  it("parses channels", () => {
    expect(hexToRgb("#ff8000")).toEqual({ r: 255, g: 128, b: 0 });
    expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(hexToRgb("fff")).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("serializes, clamping and rounding channels", () => {
    expect(rgbToHex({ r: 255, g: 128, b: 0 })).toBe("#ff8000");
    expect(rgbToHex({ r: 300, g: -5, b: 12.4 })).toBe("#ff000c");
  });

  it("round-trips", () => {
    for (const hex of ["#14181f", "#e3a94f", "#45c496", "#ef7466", "#98a2b3"]) {
      expect(rgbToHex(hexToRgb(hex))).toBe(hex);
    }
  });
});

describe("relativeLuminance (WCAG 2.x)", () => {
  it("is 0 for black and 1 for white", () => {
    expect(relativeLuminance("#000000")).toBe(0);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("matches the exact channel coefficients on the primaries", () => {
    expect(relativeLuminance("#ff0000")).toBeCloseTo(0.2126, 10);
    expect(relativeLuminance("#00ff00")).toBeCloseTo(0.7152, 10);
    expect(relativeLuminance("#0000ff")).toBeCloseTo(0.0722, 10);
  });

  it("matches the published value for #777777", () => {
    expect(relativeLuminance("#777777")).toBeCloseTo(0.1845, 3);
  });
});

describe("contrastRatio (WCAG 2.x) against published reference values", () => {
  it("white on black is 21:1", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 8);
  });

  it("a color against itself is 1:1", () => {
    expect(contrastRatio("#e3a94f", "#e3a94f")).toBe(1);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#14181f", "#e9ecf1")).toBe(contrastRatio("#e9ecf1", "#14181f"));
  });

  it("#777777 on white is ~4.48:1 and fails AA normal text", () => {
    const ratio = contrastRatio("#777777", "#ffffff");
    expect(ratio).toBeCloseTo(4.48, 2);
    expect(ratio).toBeLessThan(4.5);
  });

  it("#767676 on white is ~4.54:1 and passes AA normal text", () => {
    const ratio = contrastRatio("#767676", "#ffffff");
    expect(ratio).toBeCloseTo(4.54, 2);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it("pure blue on white is ~8.59:1", () => {
    expect(contrastRatio("#0000ff", "#ffffff")).toBeCloseTo(8.59, 2);
  });

  it("pure red on white is ~4.00:1", () => {
    expect(contrastRatio("#ff0000", "#ffffff")).toBeCloseTo(4.0, 2);
  });
});

describe("HSL conversion", () => {
  it("converts primaries to HSL", () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    const green = rgbToHsl(hexToRgb("#008000"));
    expect(green.h).toBeCloseTo(120, 6);
    expect(green.s).toBeCloseTo(100, 6);
    expect(green.l).toBeCloseTo(25.1, 1);
  });

  it("converts HSL back to RGB", () => {
    expect(rgbToHex(hslToRgb({ h: 120, s: 100, l: 25 }))).toBe("#008000");
    expect(rgbToHex(hslToRgb({ h: 0, s: 0, l: 0 }))).toBe("#000000");
    expect(rgbToHex(hslToRgb({ h: 0, s: 0, l: 100 }))).toBe("#ffffff");
  });

  it("round-trips within one step per channel", () => {
    for (const hex of ["#e3a94f", "#45c496", "#ef7466", "#98a2b3", "#1c222b"]) {
      const back = hexToRgb(rgbToHex(hslToRgb(rgbToHsl(hexToRgb(hex)))));
      const original = hexToRgb(hex);
      expect(Math.abs(back.r - original.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - original.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - original.b)).toBeLessThanOrEqual(1);
    }
  });
});

describe("lightness adjustment", () => {
  it("sets absolute lightness", () => {
    expect(setLightness("#000000", 50)).toBe("#808080");
    expect(setLightness("#e3a94f", 100)).toBe("#ffffff");
    expect(setLightness("#e3a94f", 0)).toBe("#000000");
  });

  it("shifts lightness by a delta, preserving hue", () => {
    const darker = adjustLightness("#e3a94f", -10);
    expect(lightnessOf(darker)).toBeCloseTo(lightnessOf("#e3a94f") - 10, 0);
    expect(hueOf(darker)).toBeCloseTo(hueOf("#e3a94f"), 0);
  });

  it("clamps at the bounds", () => {
    expect(adjustLightness("#eeeeee", 50)).toBe("#ffffff");
    expect(adjustLightness("#111111", -50)).toBe("#000000");
  });
});

describe("hue separation", () => {
  it("measures the shortest angular distance", () => {
    expect(hueOf("#ff0000")).toBe(0);
    expect(hueOf("#00ff00")).toBe(120);
    expect(hueOf("#0000ff")).toBe(240);
    expect(hueSeparationDeg("#ff0000", "#0000ff")).toBe(120);
    expect(hueSeparationDeg("#ff0000", "#00ff00")).toBe(120);
    expect(hueSeparationDeg("#e3a94f", "#e3a94f")).toBe(0);
  });
});
