import { describe, expect, it } from "vitest";
import type { ColorTokens } from "@/lib/types/brand";
import { contrastRatio, hexToRgb, lightnessOf } from "./color";
import {
  CONTRAST_REQUIREMENTS,
  checkDistinguishability,
  ensureAccessibleColors,
  nearestAccessibleVariant,
  validateColorTokens,
} from "./contrast";
import { SIGNAL_COLORS } from "./defaults";

describe("validateColorTokens", () => {
  it("passes every required pair on the Signal default palette", () => {
    const checks = validateColorTokens(SIGNAL_COLORS);
    expect(checks).toHaveLength(6);
    for (const check of checks) {
      expect(check.pass, `${check.id} at ${check.ratio.toFixed(2)}:1`).toBe(true);
    }
  });

  it("applies AA normal-text (4.5:1) to ink and muted, UI-component (3:1) to accent/positive/negative", () => {
    const byId = new Map(validateColorTokens(SIGNAL_COLORS).map((c) => [c.id, c]));
    expect(byId.get("ink-on-surface")?.required).toBe(4.5);
    expect(byId.get("ink-on-surface-raised")?.required).toBe(4.5);
    expect(byId.get("muted-on-surface")?.required).toBe(4.5);
    expect(byId.get("accent-on-surface")?.required).toBe(3);
    expect(byId.get("positive-on-surface")?.required).toBe(3);
    expect(byId.get("negative-on-surface")?.required).toBe(3);
  });

  it("reports failures with measured ratios", () => {
    const failing: ColorTokens = { ...SIGNAL_COLORS, accent: "#20242c" };
    const check = validateColorTokens(failing).find((c) => c.id === "accent-on-surface");
    expect(check?.pass).toBe(false);
    expect(check?.ratio).toBeLessThan(3);
    expect(check?.ratio).toBeGreaterThanOrEqual(1);
  });
});

describe("nearestAccessibleVariant", () => {
  it("returns the input (normalized) when it already passes", () => {
    const result = nearestAccessibleVariant("#E9ECF1", ["#14181f"], 4.5);
    expect(result).toEqual({ hex: "#e9ecf1", passes: true });
  });

  it("nudges #777777 on white across the AA boundary with a minimal lightness step", () => {
    const result = nearestAccessibleVariant("#777777", ["#ffffff"], 4.5);
    expect(result.passes).toBe(true);
    expect(contrastRatio(result.hex, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    // Nearest variant: within a couple of lightness points of the original.
    expect(Math.abs(lightnessOf(result.hex) - lightnessOf("#777777"))).toBeLessThanOrEqual(2);
    // Gray stays gray — hue and saturation preserved.
    const { r, g, b } = hexToRgb(result.hex);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("corrects against multiple backgrounds at once", () => {
    const result = nearestAccessibleVariant("#3a4150", ["#14181f", "#1c222b"], 4.5);
    expect(result.passes).toBe(true);
    expect(contrastRatio(result.hex, "#14181f")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(result.hex, "#1c222b")).toBeGreaterThanOrEqual(4.5);
  });

  it("returns a best-effort variant with passes:false when the requirement is unsatisfiable", () => {
    // For ratios above sqrt(21) ~ 4.58, a mid-luminance background can defeat
    // every lightness of the foreground hue.
    const result = nearestAccessibleVariant("#888888", ["#808080"], 7);
    expect(result.passes).toBe(false);
    expect(contrastRatio(result.hex, "#808080")).toBeLessThan(7);
  });
});

describe("ensureAccessibleColors", () => {
  it("leaves a passing palette untouched and reports no adjustments", () => {
    const { colors, report } = ensureAccessibleColors(SIGNAL_COLORS);
    expect(colors).toEqual(SIGNAL_COLORS);
    expect(report.adjustments).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.checks.every((c) => c.pass)).toBe(true);
    expect(report.distinguishability.pass).toBe(true);
  });

  it("normalizes shorthand hex without treating it as an adjustment", () => {
    const { colors, report } = ensureAccessibleColors({
      ...SIGNAL_COLORS,
      ink: "#FFF",
    });
    expect(colors.ink).toBe("#ffffff");
    expect(report.adjustments).toEqual([]);
  });

  it("corrects a low-contrast accent and reports what was adjusted and why", () => {
    const { colors, report } = ensureAccessibleColors({
      ...SIGNAL_COLORS,
      accent: "#20242c", // ~1.2:1 on the Signal surface
    });
    expect(contrastRatio(colors.accent, colors.surface)).toBeGreaterThanOrEqual(3);
    expect(report.pass).toBe(true);

    expect(report.adjustments).toHaveLength(1);
    const adj = report.adjustments[0];
    expect(adj.token).toBe("accent");
    expect(adj.from).toBe("#20242c");
    expect(adj.to).toBe(colors.accent);
    expect(adj.to).not.toBe(adj.from);
    expect(adj.resolved).toBe(true);
    expect(adj.reason).toContain("accent-on-surface");
    expect(adj.reason).toContain("required 3.00:1");
    expect(adj.reason).toContain("Lightness stepped");
  });

  it("darkens a pale accent on a light surface", () => {
    const light: ColorTokens = {
      surface: "#ffffff",
      surfaceRaised: "#f2f4f7",
      ink: "#1b202a",
      muted: "#5c6677",
      accent: "#ffe066", // pale yellow, ~1.3:1 on white
      positive: "#1c7a5c",
      negative: "#b53a2e",
    };
    const { colors, report } = ensureAccessibleColors(light);
    expect(contrastRatio(colors.accent, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(lightnessOf(colors.accent)).toBeLessThan(lightnessOf("#ffe066"));
    const adj = report.adjustments.find((a) => a.token === "accent");
    expect(adj).toBeDefined();
    expect(adj?.resolved).toBe(true);
  });

  it("corrects ink against BOTH surface and surface-raised", () => {
    const { colors, report } = ensureAccessibleColors({
      ...SIGNAL_COLORS,
      ink: "#3a4150", // fails 4.5:1 on both dark surfaces
    });
    expect(contrastRatio(colors.ink, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.ink, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
    expect(report.adjustments.map((a) => a.token)).toContain("ink");
    expect(report.pass).toBe(true);
  });

  it("corrects muted text to AA", () => {
    const { colors, report } = ensureAccessibleColors({
      ...SIGNAL_COLORS,
      muted: "#4a5260",
    });
    expect(contrastRatio(colors.muted, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(report.adjustments.map((a) => a.token)).toContain("muted");
  });

  it("separates indistinguishable positive/negative while keeping surface contrast", () => {
    const { colors, report } = ensureAccessibleColors({
      ...SIGNAL_COLORS,
      positive: "#45c496",
      negative: "#45c496", // identical — unusable for up/down states
    });
    expect(colors.negative).not.toBe(colors.positive);
    expect(report.distinguishability.pass).toBe(true);
    expect(contrastRatio(colors.negative, colors.surface)).toBeGreaterThanOrEqual(3);
    const adj = report.adjustments.find(
      (a) => a.token === "negative" && a.reason.includes("distinguishability")
    );
    expect(adj).toBeDefined();
  });

  it("reports an honest failure when surfaces straddle mid-luminance and no ink can serve both", () => {
    const { report } = ensureAccessibleColors({
      surface: "#ffffff",
      surfaceRaised: "#14181f", // light + dark surface: no single 4.5:1 ink exists
      ink: "#e9ecf1",
      muted: "#98a2b3",
      accent: "#e3a94f",
      positive: "#45c496",
      negative: "#ef7466",
    });
    const inkAdj = report.adjustments.find((a) => a.token === "ink");
    expect(inkAdj?.resolved).toBe(false);
    expect(inkAdj?.reason).toContain("best-effort");
    expect(report.pass).toBe(false);
  });

  it("throws on unparseable hex", () => {
    expect(() =>
      ensureAccessibleColors({ ...SIGNAL_COLORS, accent: "not-a-color" })
    ).toThrow(/Invalid hex color/);
  });
});

describe("checkDistinguishability", () => {
  it("passes hue-opposed pairs", () => {
    const check = checkDistinguishability(SIGNAL_COLORS.positive, SIGNAL_COLORS.negative);
    expect(check.pass).toBe(true);
    expect(check.hueSeparationDeg).toBeGreaterThan(140);
  });

  it("passes same-hue pairs separated by luminance", () => {
    const check = checkDistinguishability("#0d4f3c", "#7fe0c3");
    expect(check.pass).toBe(true);
    expect(check.contrast).toBeGreaterThanOrEqual(
      CONTRAST_REQUIREMENTS.distinguishabilityContrast
    );
  });

  it("fails identical colors", () => {
    expect(checkDistinguishability("#45c496", "#45c496").pass).toBe(false);
  });
});
