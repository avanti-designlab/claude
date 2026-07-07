import { describe, expect, it } from "vitest";
import { buildBrandKit } from "./build";
import { contrastRatio, lightnessOf } from "./color";
import { SIGNAL_COLORS, SIGNAL_SPACING, SIGNAL_TYPOGRAPHY } from "./defaults";

describe("buildBrandKit — token completeness from minimal input", () => {
  it("produces a complete kit from a single brand color", () => {
    const { kit, accessibility, logoUrl } = buildBrandKit({
      colors: { accent: "#E3A94F" },
    });

    // All 7 color tokens populated with normalized hex.
    const colors = kit.tokens.colors;
    for (const token of [
      "surface",
      "surfaceRaised",
      "ink",
      "muted",
      "accent",
      "positive",
      "negative",
    ] as const) {
      expect(colors[token]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(colors).toEqual({ ...SIGNAL_COLORS, accent: "#e3a94f" });

    // Real type scale + faces.
    expect(kit.tokens.typography.display).toBe(SIGNAL_TYPOGRAPHY.display);
    expect(kit.tokens.typography.body).toBe(SIGNAL_TYPOGRAPHY.body);
    expect(kit.tokens.typography.mono).toBe(SIGNAL_TYPOGRAPHY.mono);
    for (const step of ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "display", "score"]) {
      expect(kit.tokens.typography.scale[step]?.size).toBeTruthy();
      expect(kit.tokens.typography.scale[step]?.lineHeight).toBeTruthy();
    }

    // Spacing.
    expect(kit.tokens.spacing.unit).toBe(SIGNAL_SPACING.unit);
    expect(kit.tokens.spacing.steps).toEqual(SIGNAL_SPACING.steps);

    // Voice + likeness default to empty, ready to be filled.
    expect(kit.voice_profile).toEqual({ descriptors: [], samples: [], do: [], dont: [] });
    expect(kit.likeness_refs).toEqual({ higgsfieldElementIds: [], motionElementIds: [] });

    // Fresh kit state.
    expect(kit.locked).toBe(false);
    expect(kit.version).toBe(1);

    // The default chrome passes without correction.
    expect(accessibility.adjustments).toEqual([]);
    expect(accessibility.pass).toBe(true);
    expect(logoUrl).toBeNull();
  });

  it("accepts hex in any supported form and normalizes it", () => {
    expect(buildBrandKit({ colors: { accent: "E3A94F" } }).kit.tokens.colors.accent).toBe(
      "#e3a94f"
    );
    expect(buildBrandKit({ colors: { accent: "#abc" } }).kit.tokens.colors.accent).toBe(
      "#aabbcc"
    );
  });

  it("keeps positive and negative distinguishable in every built kit", () => {
    const { accessibility } = buildBrandKit({ colors: { accent: "#7c5cff" } });
    expect(accessibility.distinguishability.pass).toBe(true);
  });
});

describe("buildBrandKit — brand inputs flow through", () => {
  it("carries voice, likeness, typography, spacing, and logo", () => {
    const { kit, logoUrl } = buildBrandKit({
      colors: { accent: "#e3a94f" },
      logoUrl: "https://cdn.example.com/tenant/logo.svg",
      typography: { display: '"Canela", serif', body: '"Söhne", sans-serif' },
      spacing: { unit: 8 },
      voice: {
        descriptors: ["dry", "assured"],
        samples: ["We measure. Then we move."],
        do: ["lead with the number"],
        dont: ["exclamation marks"],
      },
      likeness: { higgsfieldElementIds: ["hf_el_123"], motionElementIds: ["mo_456"] },
    });

    expect(logoUrl).toBe("https://cdn.example.com/tenant/logo.svg");
    expect(kit.tokens.typography.display).toBe('"Canela", serif');
    expect(kit.tokens.typography.body).toBe('"Söhne", sans-serif');
    expect(kit.tokens.typography.mono).toBe(SIGNAL_TYPOGRAPHY.mono); // unspecified → default
    expect(kit.tokens.spacing.unit).toBe(8);
    expect(kit.voice_profile.descriptors).toEqual(["dry", "assured"]);
    expect(kit.voice_profile.dont).toEqual(["exclamation marks"]);
    expect(kit.likeness_refs.higgsfieldElementIds).toEqual(["hf_el_123"]);
    expect(kit.likeness_refs.motionElementIds).toEqual(["mo_456"]);
  });

  it("does not share references with the input (later input mutation cannot reach the kit)", () => {
    const samples = ["original"];
    const { kit } = buildBrandKit({ colors: { accent: "#e3a94f" }, voice: { samples } });
    samples.push("injected");
    expect(kit.voice_profile.samples).toEqual(["original"]);
  });

  it("adapts neutral defaults to a light brand surface instead of mixing in dark chrome", () => {
    const { kit } = buildBrandKit({ colors: { accent: "#0e7490", surface: "#ffffff" } });
    const { surface, surfaceRaised, ink, muted } = kit.tokens.colors;
    expect(surface).toBe("#ffffff");
    expect(surfaceRaised).not.toBe(SIGNAL_COLORS.surfaceRaised);
    expect(lightnessOf(surfaceRaised)).toBeGreaterThan(80); // a light raised surface
    expect(contrastRatio(ink, surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ink, surfaceRaised)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("buildBrandKit — accessibility correction", () => {
  it("corrects a brand accent that fails on the default surface and reports it", () => {
    const { kit, accessibility } = buildBrandKit({ colors: { accent: "#20242c" } });

    expect(contrastRatio(kit.tokens.colors.accent, kit.tokens.colors.surface)).toBeGreaterThanOrEqual(3);
    expect(kit.tokens.colors.accent).not.toBe("#20242c");

    const adj = accessibility.adjustments.find((a) => a.token === "accent");
    expect(adj).toBeDefined();
    expect(adj?.from).toBe("#20242c");
    expect(adj?.to).toBe(kit.tokens.colors.accent);
    expect(adj?.resolved).toBe(true);
    expect(accessibility.pass).toBe(true);
  });

  it("corrects the Signal brass accent when a tenant runs it on a white surface", () => {
    const { kit, accessibility } = buildBrandKit({
      colors: { accent: SIGNAL_COLORS.accent, surface: "#ffffff" },
    });
    expect(contrastRatio(kit.tokens.colors.accent, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(lightnessOf(kit.tokens.colors.accent)).toBeLessThan(
      lightnessOf(SIGNAL_COLORS.accent)
    );
    expect(accessibility.adjustments.map((a) => a.token)).toContain("accent");
  });
});

describe("buildBrandKit — input validation", () => {
  it("requires a brand accent", () => {
    expect(() => buildBrandKit({ colors: { accent: "" } })).toThrow(/colors\.accent/);
    expect(() => buildBrandKit({ colors: {} as { accent: string } })).toThrow(
      /colors\.accent/
    );
  });

  it("rejects unparseable colors, naming the field", () => {
    expect(() => buildBrandKit({ colors: { accent: "sage green" } })).toThrow(
      /colors\.accent/
    );
    expect(() =>
      buildBrandKit({ colors: { accent: "#e3a94f", muted: "#zz0011" } })
    ).toThrow(/colors\.muted/);
  });

  it("rejects invalid spacing", () => {
    expect(() =>
      buildBrandKit({ colors: { accent: "#e3a94f" }, spacing: { unit: 0 } })
    ).toThrow(/spacing\.unit/);
    expect(() =>
      buildBrandKit({ colors: { accent: "#e3a94f" }, spacing: { steps: [] } })
    ).toThrow(/spacing\.steps/);
    expect(() =>
      buildBrandKit({ colors: { accent: "#e3a94f" }, spacing: { steps: [1, -2] } })
    ).toThrow(/spacing\.steps/);
  });

  it("rejects empty font stacks", () => {
    expect(() =>
      buildBrandKit({ colors: { accent: "#e3a94f" }, typography: { body: "   " } })
    ).toThrow(/typography\.body/);
  });
});
