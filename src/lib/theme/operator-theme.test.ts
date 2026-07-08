/**
 * Operator brand theme (tenant #1) — the app's active default.
 *
 * Guards the intent of the rework: the Webflow-grounded light-first palette
 * (a) is authored through the real brand-kit pipeline, (b) passes the same
 * accessibility gate every reseller theme passes, (c) keeps the anchor blue
 * and near-black exactly as authored while auto-adapting only the functional
 * colors, and (d) resolves primary-button labels to white-on-blue (not the
 * muddy near-black-on-blue the mid-luminance accent would otherwise win).
 */

import { describe, expect, test } from "vitest";
import { contrastRatio } from "@/lib/skills/brand-kit";
import { operatorBuild, operatorTheme, OPERATOR_TENANT_ID } from "./operator-theme";
import { deriveOnColorForegrounds, resolveTenantTheme } from "./engine";

describe("operator theme (tenant #1)", () => {
  test("passes the accessibility gate as authored (source = tenant, no fallback)", () => {
    const res = resolveTenantTheme(operatorTheme);
    expect(res.source).toBe("tenant");
    expect(res.fallbackReason).toBeNull();
    expect(res.report?.pass).toBe(true);
    expect(operatorBuild.accessibility.pass).toBe(true);
  });

  test("keeps the Webflow anchors exact; only functional colors auto-correct", () => {
    const c = operatorBuild.kit.tokens.colors;
    // Anchors survive the gate untouched.
    expect(c.accent).toBe("#146ef5"); // Webflow electric blue
    expect(c.ink).toBe("#080808"); // Webflow near-black
    expect(c.surface).toBe("#ffffff"); // clean white ground
    expect(c.surfaceRaised).toBe("#f4f6f9");
    expect(c.muted).toBe("#5b6473");

    // The only auto-corrections are positive/negative, darkened for the light
    // surface to reach the 3:1 UI-component ratio (WCAG 1.4.11).
    const adjustedTokens = operatorBuild.accessibility.adjustments.map((a) => a.token).sort();
    expect(adjustedTokens).toEqual(["negative", "positive"]);
    for (const a of operatorBuild.accessibility.adjustments) {
      expect(a.resolved).toBe(true);
    }
  });

  test("the accent stays #146ef5 — the gate never touched it (survives 3:1)", () => {
    // Accent is a UI-component/large-numeral token (3:1 floor), and it clears
    // that on both chrome layers, so the brand blue is preserved verbatim.
    const c = operatorBuild.kit.tokens.colors;
    expect(contrastRatio(c.accent, c.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(c.accent, c.surfaceRaised)).toBeGreaterThanOrEqual(3);
  });

  test("primary-button labels resolve to white-on-blue, not near-black-on-blue", () => {
    const c = operatorBuild.kit.tokens.colors;
    const choices = deriveOnColorForegrounds(c);
    expect(choices.accent).toBe("surface"); // surface = #ffffff → white label
    // And that white-on-blue clears the UI-component floor comfortably.
    expect(contrastRatio(c.surface, c.accent)).toBeGreaterThanOrEqual(4.5);
  });

  test("uses the Sora geometric-grotesque display face and self-hosted Inter body", () => {
    expect(operatorTheme.font.display).toContain('"Sora"');
    expect(operatorTheme.font.body).toContain('"Inter"');
    expect(operatorTheme.font.mono).toContain('"IBM Plex Mono"');
  });

  test("resolves under the stable operator scope id", () => {
    expect(OPERATOR_TENANT_ID).toBe("operator");
    const res = resolveTenantTheme(operatorTheme);
    // Every doc 06 §2 named color token is present in the emitted variables.
    for (const name of [
      "--surface",
      "--surface-raised",
      "--ink",
      "--muted",
      "--accent",
      "--positive",
      "--negative",
      "--accent-foreground",
    ]) {
      expect(res.variables[name]).toBeDefined();
    }
  });
});
