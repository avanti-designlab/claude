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

  test("uses the Sora geometric-grotesque display face and self-hosted Inter body", () => {
    expect(operatorTheme.font.display).toContain('"Sora"');
    expect(operatorTheme.font.body).toContain('"Inter"');
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
