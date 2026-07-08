/**
 * Operator brand theme (tenant #1) — WORKING BRAND v1 (pass 3 consolidated,
 * 2026-07-08): the blue-depth dual palette IS the app's light/dark theme.
 *
 * Guards the intent of the consolidation:
 * (a) BOTH mode palettes are authored through the real brand-kit pipeline and
 *     pass the same accessibility gate every reseller theme passes,
 * (b) light is the boot palette; dark is the glow palette — each palette's
 *     corrections are honest and reported (never silent),
 * (c) text-on-blue resolves through DERIVED foregrounds at >= 4.5:1,
 * (d) Geist is the operator face for display AND body in both modes,
 * (e) the pass-2 Core-Blue/Orange palette is SUPERSEDED but kept — Core
 *     Orange and Alachua remain available accents (nothing deleted).
 */

import { describe, expect, test } from "vitest";
import { contrastRatio } from "@/lib/skills/brand-kit";
import {
  operatorBuild,
  operatorModeBuild,
  operatorModeTheme,
  operatorTheme,
  OPERATOR_ACCENT_LIBRARY,
  OPERATOR_BRAND_INPUT,
  OPERATOR_TENANT_ID,
} from "./operator-theme";
import { deriveOnColorForegrounds, resolveTenantTheme } from "./engine";

describe("operator theme (tenant #1) — working brand v1, dual palette", () => {
  test("BOTH mode palettes pass the accessibility gate (source = tenant, no fallback)", () => {
    for (const mode of ["light", "dark"] as const) {
      const res = resolveTenantTheme(operatorModeTheme[mode]);
      expect(res.source).toBe("tenant");
      expect(res.fallbackReason).toBeNull();
      expect(res.report?.pass).toBe(true);
      expect(operatorModeBuild[mode].accessibility.pass).toBe(true);
    }
  });

  test("LIGHT (boot): primary blue passes verbatim; the highlight cyan is honestly corrected", () => {
    const c = operatorModeBuild.light.kit.tokens.colors;
    expect(c.accent).toBe("#2456f0"); // primary vivid blue, untouched
    expect(c.surface).toBe("#f4f6fa"); // airy light-grey canvas
    expect(c.surfaceRaised).toBe("#ffffff"); // white cards
    expect(c.ink).toBe("#0b152b"); // navy-tinted near-black

    // The ONLY correction: the light cyan highlight can't mark on white, so
    // the gate darkens it — reported, never silent (doc 06 §3, §7).
    const adjusted = operatorModeBuild.light.accessibility.adjustments;
    expect(adjusted.map((a) => a.token)).toEqual(["accentSecondary"]);
    expect(adjusted[0].from).toBe("#8fd4ff");
    expect(adjusted[0].to).toBe("#0091eb");
    expect(adjusted[0].resolved).toBe(true);
  });

  test("DARK (glow): the whole palette — including the highlight cyan — passes verbatim, zero corrections", () => {
    const c = operatorModeBuild.dark.kit.tokens.colors;
    expect(operatorModeBuild.dark.accessibility.adjustments).toEqual([]);
    expect(c.accent).toBe("#3f7cff");
    expect(c.accentSecondary).toBe("#8fd4ff"); // the reference bubble cyan, intact
    expect(c.surface).toBe("#050815"); // near-black navy canvas
    expect(c.surfaceRaised).toBe("#0b1430"); // deep-navy cards
  });

  test("text on blue: the derived on-accent foreground carries >= 4.5:1 in both modes", () => {
    for (const mode of ["light", "dark"] as const) {
      const c = operatorModeBuild[mode].kit.tokens.colors;
      const choices = deriveOnColorForegrounds(c);
      const fg = choices.accent === "surface" ? c.surface : c.ink;
      expect(contrastRatio(fg, c.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("dark mode: every foreground clears its floor on BOTH navy chrome layers", () => {
    const report = operatorModeBuild.dark.accessibility;
    for (const check of report.checks) expect(check.pass).toBe(true);
    expect(report.distinguishability.pass).toBe(true);
  });

  test("urgency red stays distinguishable from green in both modes (never color-only anyway)", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(operatorModeBuild[mode].accessibility.distinguishability.pass).toBe(true);
    }
  });

  test("uses the Geist neo-grotesque for display AND body in both modes, Inter fallback", () => {
    for (const mode of ["light", "dark"] as const) {
      expect(operatorModeTheme[mode].font.display).toContain('"Geist"');
      expect(operatorModeTheme[mode].font.body).toContain('"Geist"');
      expect(operatorModeTheme[mode].font.display).toContain('"Inter"');
      expect(operatorModeTheme[mode].font.mono).toContain('"IBM Plex Mono"');
      expect(operatorModeTheme[mode].font.display).not.toContain("Sora");
      expect(operatorModeTheme[mode].font.display).not.toContain("Space Grotesk");
    }
  });

  test("one stable scope id; both mode resolutions carry the full token contract", () => {
    expect(OPERATOR_TENANT_ID).toBe("operator");
    for (const mode of ["light", "dark"] as const) {
      const res = resolveTenantTheme(operatorModeTheme[mode]);
      for (const name of [
        "--surface",
        "--surface-raised",
        "--ink",
        "--muted",
        "--accent",
        "--accent-secondary",
        "--accent-warm",
        "--positive",
        "--negative",
        "--accent-foreground",
      ]) {
        expect(res.variables[name]).toBeDefined();
      }
    }
  });
});

describe("pass-2 palette — superseded, kept (accent library stays available)", () => {
  test("Core Orange and Alachua remain in the accent library and the kept pass-2 input", () => {
    expect(OPERATOR_ACCENT_LIBRARY.coreOrange).toBe("#fc4c14");
    expect(OPERATOR_ACCENT_LIBRARY.alachua).toBe("#f4a200");
    expect(OPERATOR_ACCENT_LIBRARY.coreBlue).toBe("#1b2fce");
    expect(OPERATOR_BRAND_INPUT.colors?.accentSecondary).toBe("#fc4c14");
    expect(OPERATOR_BRAND_INPUT.colors?.accentWarm).toBe("#f4a200");
  });

  test("Alachua lineage is carried in the working palette's warm slot (both modes)", () => {
    // Light carries the post-gate lineage value; dark carries the original,
    // which passes verbatim on navy — the color is available, not leading.
    expect(operatorModeBuild.light.kit.tokens.colors.accentWarm).toBe("#c18000");
    expect(operatorModeBuild.dark.kit.tokens.colors.accentWarm).toBe("#f4a200");
  });

  test("the pass-2 theme still validates through the gate (only Alachua corrected)", () => {
    const res = resolveTenantTheme(operatorTheme);
    expect(res.source).toBe("tenant");
    expect(operatorBuild.accessibility.pass).toBe(true);
    const adjusted = operatorBuild.accessibility.adjustments;
    expect(adjusted.map((a) => a.token)).toEqual(["accentWarm"]);
    expect(adjusted[0].from).toBe("#f4a200");
    expect(adjusted[0].to).toBe("#c18000");
    // Anchors survive untouched — ready if the operator re-adds them.
    const c = operatorBuild.kit.tokens.colors;
    expect(c.accent).toBe("#1b2fce");
    expect(c.accentSecondary).toBe("#fc4c14");
  });
});
