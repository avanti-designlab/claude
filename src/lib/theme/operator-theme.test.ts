/**
 * Operator brand theme (tenant #1) — the app's active default, the REAL brand.
 *
 * Guards the intent of the rework: the operator's real palette (Core Blue /
 * Core Orange / Alachua on a Spendex-airy light ground)
 * (a) is authored through the real brand-kit pipeline,
 * (b) passes the same accessibility gate every reseller theme passes,
 * (c) keeps Core Blue / Core Orange / green / rose-red exactly as authored and
 *     auto-darkens only Alachua (too light for a 3:1 mark on white),
 * (d) resolves primary-button labels to (near-white) surface-on-blue, and
 * (e) carries the two-accent brand extension (Core Orange + Alachua) intact
 *     through the tenants.theme round-trip.
 */

import { describe, expect, test } from "vitest";
import { contrastRatio, hueSeparationDeg } from "@/lib/skills/brand-kit";
import {
  blueDepthBuild,
  blueDepthTheme,
  BLUE_DEPTH_SCOPE_ID,
  operatorBuild,
  operatorTheme,
  OPERATOR_TENANT_ID,
} from "./operator-theme";
import { deriveOnColorForegrounds, resolveTenantTheme } from "./engine";

describe("operator theme (tenant #1) — real brand", () => {
  test("passes the accessibility gate as authored (source = tenant, no fallback)", () => {
    const res = resolveTenantTheme(operatorTheme);
    expect(res.source).toBe("tenant");
    expect(res.fallbackReason).toBeNull();
    expect(res.report?.pass).toBe(true);
    expect(operatorBuild.accessibility.pass).toBe(true);
  });

  test("keeps the brand anchors exact; only Alachua auto-corrects", () => {
    const c = operatorBuild.kit.tokens.colors;
    // Anchors survive the gate untouched.
    expect(c.accent).toBe("#1b2fce"); // Core Blue
    expect(c.accentSecondary).toBe("#fc4c14"); // Core Orange (passes 3:1 verbatim)
    expect(c.surface).toBe("#f4f6fa"); // cool light-grey canvas
    expect(c.surfaceRaised).toBe("#ffffff"); // white cards
    expect(c.ink).toBe("#0b152b"); // Dark-Blue-tinted near-black
    expect(c.muted).toBe("#5b6577");
    expect(c.positive).toBe("#16a34a"); // green, passes verbatim
    expect(c.negative).toBe("#e11d48"); // rose-crimson, passes verbatim

    // The ONLY auto-correction is Alachua, darkened to reach the 3:1
    // UI-component floor (WCAG 1.4.11) on the light surface.
    const adjustedTokens = operatorBuild.accessibility.adjustments.map((a) => a.token);
    expect(adjustedTokens).toEqual(["accentWarm"]);
    const warm = operatorBuild.accessibility.adjustments[0];
    expect(warm.from).toBe("#f4a200");
    expect(warm.to).toBe("#c18000");
    expect(warm.resolved).toBe(true);
  });

  test("Core Blue and Core Orange both clear 3:1 on both chrome layers, untouched", () => {
    const c = operatorBuild.kit.tokens.colors;
    for (const mark of [c.accent, c.accentSecondary]) {
      expect(contrastRatio(mark, c.surface)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(mark, c.surfaceRaised)).toBeGreaterThanOrEqual(3);
    }
  });

  test("functional red stays visually distinct from Core Orange (energy ≠ error)", () => {
    const c = operatorBuild.kit.tokens.colors;
    // Green up is obviously distinct; the rose-red down is deliberately
    // hue-separated from Core Orange so brand energy never reads as an error.
    expect(hueSeparationDeg(c.positive, c.accentSecondary)).toBeGreaterThan(80);
    expect(hueSeparationDeg(c.negative, c.accentSecondary)).toBeGreaterThan(20);
    expect(operatorBuild.accessibility.distinguishability.pass).toBe(true);
  });

  test("primary-button labels resolve to (near-white) surface-on-blue", () => {
    const c = operatorBuild.kit.tokens.colors;
    const choices = deriveOnColorForegrounds(c);
    expect(choices.accent).toBe("surface"); // surface = #f4f6fa → near-white label
    expect(contrastRatio(c.surface, c.accent)).toBeGreaterThanOrEqual(4.5);
  });

  test("the two-accent extension survives the tenants.theme round-trip", () => {
    // Written into the jsonb shape...
    expect(operatorTheme.colors.accent_secondary).toBe("#fc4c14");
    expect(operatorTheme.colors.accent_warm).toBe("#c18000");
    // ...and re-emitted as CSS vars (+ their derived on-color foregrounds).
    const res = resolveTenantTheme(operatorTheme);
    expect(res.variables["--accent-secondary"]).toBe("#fc4c14");
    expect(res.variables["--accent-warm"]).toBe("#c18000");
    expect(res.variables["--accent-secondary-foreground"]).toBeDefined();
    expect(res.variables["--accent-warm-foreground"]).toBeDefined();
  });

  test("uses the Geist neo-grotesque for display AND body (pass 3), Inter fallback", () => {
    expect(operatorTheme.font.display).toContain('"Geist"');
    expect(operatorTheme.font.body).toContain('"Geist"');
    expect(operatorTheme.font.display).toContain('"Inter"');
    expect(operatorTheme.font.mono).toContain('"IBM Plex Mono"');
  });

  test("resolves under the stable operator scope id with the full token contract", () => {
    expect(OPERATOR_TENANT_ID).toBe("operator");
    const res = resolveTenantTheme(operatorTheme);
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
  });
});

describe("pass-3 blue-depth preview variants (/dashboard-preview only)", () => {
  test("both variants pass the accessibility gate (source = tenant, no fallback)", () => {
    for (const variant of ["light", "dark"] as const) {
      const res = resolveTenantTheme(blueDepthTheme[variant]);
      expect(res.source).toBe("tenant");
      expect(res.fallbackReason).toBeNull();
      expect(blueDepthBuild[variant].accessibility.pass).toBe(true);
    }
  });

  test("LIGHT: primary blue passes verbatim; the reference cyan is honestly corrected", () => {
    const c = blueDepthBuild.light.kit.tokens.colors;
    expect(c.accent).toBe("#2456f0"); // primary vivid blue, untouched
    expect(c.surface).toBe("#f4f6fa"); // operator chrome unchanged
    expect(c.surfaceRaised).toBe("#ffffff");
    expect(c.ink).toBe("#0b152b");

    // The ONLY correction: the light cyan highlight can't mark on white, so
    // the gate darkens it — reported, never silent (doc 06 §3, §7).
    const adjusted = blueDepthBuild.light.accessibility.adjustments;
    expect(adjusted.map((a) => a.token)).toEqual(["accentSecondary"]);
    expect(adjusted[0].from).toBe("#8fd4ff");
    expect(adjusted[0].to).toBe("#0091eb");
    expect(adjusted[0].resolved).toBe(true);
  });

  test("DARK: the whole palette — including the reference cyan — passes verbatim, zero corrections", () => {
    const c = blueDepthBuild.dark.kit.tokens.colors;
    expect(blueDepthBuild.dark.accessibility.adjustments).toEqual([]);
    expect(c.accent).toBe("#3f7cff");
    expect(c.accentSecondary).toBe("#8fd4ff"); // the reference bubble cyan, intact
    expect(c.surface).toBe("#050815");
    expect(c.surfaceRaised).toBe("#0b1430");
  });

  test("text on blue: the derived on-accent foreground carries >= 4.5:1 in both variants", () => {
    for (const variant of ["light", "dark"] as const) {
      const c = blueDepthBuild[variant].kit.tokens.colors;
      const choices = deriveOnColorForegrounds(c);
      const fg = choices.accent === "surface" ? c.surface : c.ink;
      expect(contrastRatio(fg, c.accent)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("dark chrome: every foreground clears its floor on BOTH navy layers", () => {
    const report = blueDepthBuild.dark.accessibility;
    for (const check of report.checks) expect(check.pass).toBe(true);
    expect(report.distinguishability.pass).toBe(true);
  });

  test("stable scope ids, distinct from the operator scope", () => {
    expect(BLUE_DEPTH_SCOPE_ID.light).toBe("operator-p3-light");
    expect(BLUE_DEPTH_SCOPE_ID.dark).toBe("operator-p3-dark");
    expect(Object.values(BLUE_DEPTH_SCOPE_ID)).not.toContain(OPERATOR_TENANT_ID);
  });
});
