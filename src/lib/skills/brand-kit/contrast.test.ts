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
    // 7 foreground tokens × 2 chrome layers.
    expect(checks).toHaveLength(14);
    for (const check of checks) {
      expect(check.pass, `${check.id} at ${check.ratio.toFixed(2)}:1`).toBe(true);
    }
  });

  it("checks every foreground on BOTH surfaces: 4.5:1 for ink/muted, 3:1 for accent/positive/negative (F2 pair-set policy)", () => {
    const byId = new Map(validateColorTokens(SIGNAL_COLORS).map((c) => [c.id, c]));
    expect(byId.get("ink-on-surface")?.required).toBe(4.5);
    expect(byId.get("ink-on-surface-raised")?.required).toBe(4.5);
    expect(byId.get("muted-on-surface")?.required).toBe(4.5);
    expect(byId.get("muted-on-surface-raised")?.required).toBe(4.5);
    expect(byId.get("accent-on-surface")?.required).toBe(3);
    expect(byId.get("accent-on-surface-raised")?.required).toBe(3);
    expect(byId.get("accentSecondary-on-surface")?.required).toBe(3);
    expect(byId.get("accentSecondary-on-surface-raised")?.required).toBe(3);
    expect(byId.get("accentWarm-on-surface")?.required).toBe(3);
    expect(byId.get("accentWarm-on-surface-raised")?.required).toBe(3);
    expect(byId.get("positive-on-surface")?.required).toBe(3);
    expect(byId.get("positive-on-surface-raised")?.required).toBe(3);
    expect(byId.get("negative-on-surface")?.required).toBe(3);
    expect(byId.get("negative-on-surface-raised")?.required).toBe(3);
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
      accentSecondary: "#155e6b", // dark teal — passes on both light surfaces
      accentWarm: "#6b5416", // dark amber — passes on both light surfaces
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
      accentSecondary: "#59c3dd",
      accentWarm: "#e9b872",
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

describe("F2 pair-set policy — foregrounds validated on surfaceRaised too", () => {
  it("catches muted text that passes on surface but fails on a raised card, and corrects it against both", () => {
    // 5.75:1 on surface (passes), 3.94:1 on the lighter raised card (fails 4.5:1).
    const palette: ColorTokens = {
      surface: "#14181f",
      surfaceRaised: "#2e3642",
      ink: "#e9ecf1",
      muted: "#8a93a3",
      accent: "#e3a94f",
      accentSecondary: "#59c3dd",
      accentWarm: "#e9b872",
      positive: "#45c496",
      negative: "#ef7466",
    };
    const byId = new Map(validateColorTokens(palette).map((c) => [c.id, c]));
    expect(byId.get("muted-on-surface")?.pass).toBe(true);
    expect(byId.get("muted-on-surface-raised")?.pass).toBe(false);

    const { colors, report } = ensureAccessibleColors(palette);
    expect(contrastRatio(colors.muted, colors.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.muted, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
    const adj = report.adjustments.find((a) => a.token === "muted");
    expect(adj?.reason).toContain("muted-on-surface-raised");
    expect(adj?.resolved).toBe(true);
    expect(report.pass).toBe(true);
  });

  it("catches an accent that passes on surface but fails 3:1 on a raised card", () => {
    // 3.69:1 on white (passes), 2.86:1 on the raised gray (fails 3:1).
    const palette: ColorTokens = {
      surface: "#ffffff",
      surfaceRaised: "#dfe3e8",
      ink: "#1b202a",
      muted: "#525c6b",
      accent: "#b8763a",
      accentSecondary: "#155e6b",
      accentWarm: "#6b5416",
      positive: "#1c7a5c",
      negative: "#b53a2e",
    };
    const byId = new Map(validateColorTokens(palette).map((c) => [c.id, c]));
    expect(byId.get("accent-on-surface")?.pass).toBe(true);
    expect(byId.get("accent-on-surface-raised")?.pass).toBe(false);

    const { colors, report } = ensureAccessibleColors(palette);
    expect(contrastRatio(colors.accent, colors.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colors.accent, colors.surfaceRaised)).toBeGreaterThanOrEqual(3);
    expect(report.pass).toBe(true);
  });

  it("auto-correction converges on a tight surface/surfaceRaised pair (every constraint met at once)", () => {
    // White chrome with a fairly deep raised gray: muted and accent both fail
    // only against the raised card and must be corrected against BOTH
    // backgrounds simultaneously.
    const { colors, report } = ensureAccessibleColors({
      surface: "#ffffff",
      surfaceRaised: "#dfe3e8",
      ink: "#1b202a",
      muted: "#6d7787", // 4.53:1 on white, 3.51:1 on raised
      accent: "#b8763a", // 3.69:1 on white, 2.86:1 on raised
      accentSecondary: "#155e6b", // dark — passes both, no correction expected
      accentWarm: "#6b5416", // dark — passes both, no correction expected
      positive: "#1c7a5c",
      negative: "#b53a2e",
    });

    expect(report.pass).toBe(true);
    for (const check of report.checks) {
      expect(
        check.ratio,
        `${check.id} at ${check.ratio.toFixed(2)}:1`
      ).toBeGreaterThanOrEqual(check.required);
    }
    expect(report.adjustments.map((a) => a.token).sort()).toEqual(["accent", "muted"]);
    expect(report.adjustments.every((a) => a.resolved)).toBe(true);
    expect(report.distinguishability.pass).toBe(true);
    // Corrections hold on both chrome layers.
    expect(contrastRatio(colors.muted, "#dfe3e8")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.accent, "#dfe3e8")).toBeGreaterThanOrEqual(3);
  });

  it("keeps the separated negative accessible on the raised surface as well", () => {
    const { colors, report } = ensureAccessibleColors({
      ...SIGNAL_COLORS,
      negative: SIGNAL_COLORS.positive, // indistinguishable pair forces separation
    });
    expect(report.distinguishability.pass).toBe(true);
    expect(contrastRatio(colors.negative, colors.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colors.negative, colors.surfaceRaised)).toBeGreaterThanOrEqual(3);
  });
});

describe("two-accent extension — accentSecondary / accentWarm are gated like accent", () => {
  it("validates both new accents on BOTH chrome layers at the 3:1 UI-component floor", () => {
    const byId = new Map(validateColorTokens(SIGNAL_COLORS).map((c) => [c.id, c]));
    for (const id of [
      "accentSecondary-on-surface",
      "accentSecondary-on-surface-raised",
      "accentWarm-on-surface",
      "accentWarm-on-surface-raised",
    ]) {
      expect(byId.get(id)?.required).toBe(3);
      expect(byId.get(id)?.pass).toBe(true);
    }
  });

  it("darkens a too-light secondary and warm accent on a light surface and reports each fix", () => {
    const { colors, report } = ensureAccessibleColors({
      surface: "#ffffff",
      surfaceRaised: "#f4f6fa",
      ink: "#0b152b",
      muted: "#5b6577",
      accent: "#1b2fce", // dark blue — passes verbatim
      accentSecondary: "#7fd8ef", // pale cyan — fails 3:1 on white
      accentWarm: "#f4a200", // Alachua amber — ~1.9:1 on white, fails
      positive: "#16a34a",
      negative: "#e11d48",
    });

    expect(contrastRatio(colors.accentSecondary, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(colors.accentWarm, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(lightnessOf(colors.accentSecondary)).toBeLessThan(lightnessOf("#7fd8ef"));
    expect(lightnessOf(colors.accentWarm)).toBeLessThan(lightnessOf("#f4a200"));

    const tokens = report.adjustments.map((a) => a.token);
    expect(tokens).toContain("accentSecondary");
    expect(tokens).toContain("accentWarm");
    expect(colors.accent).toBe("#1b2fce"); // brand blue untouched
    expect(report.pass).toBe(true);
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
