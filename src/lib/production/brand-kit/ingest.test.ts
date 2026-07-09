/**
 * M7 ingest suite — the skill wrapper + the honesty report.
 *
 * Pins the review-gated properties of the wrapper:
 *  - it produces the skill's token set + voice profile from real brand inputs
 *    (wraps, never reimplements);
 *  - the B1 CSS-injection defense HOLDS THROUGH the wrapper: a hostile font/
 *    color brand input is caught by the SKILL's gate (validateFontStack /
 *    normalizeHex), surfaced as invalid_brand_input, and never passed through;
 *  - partial input is honest: unspecified attributes are reported as defaults
 *    (never the client's choice) and truly-absent inputs (voice/likeness/logo)
 *    as missing;
 *  - the contrast auto-corrections the skill made are surfaced (not hidden), and
 *    an unresolvable palette is flagged for the write-path hard gate.
 */

import { describe, expect, it } from "vitest";
import { contrastRatio, lightnessOf } from "@/lib/skills/brand-kit";
import { ingestBrandKit } from "./ingest";

describe("ingestBrandKit — skill-wrap correctness", () => {
  it("produces the skill's token set + voice profile from real brand inputs", () => {
    const result = ingestBrandKit({
      colors: { accent: "#2B6CFF" },
      typography: { body: "Georgia, serif" },
      voice: {
        descriptors: ["confident", "concise"],
        samples: ["We build durable software."],
        do: ["use active voice"],
        dont: ["no jargon"],
      },
      likeness: { higgsfieldElementIds: ["hf_founder_01"] },
      logoUrl: "https://cdn.example/logo.svg",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Token set comes from the skill: accent normalized to lowercase #rrggbb.
    expect(result.kit.tokens.colors.accent).toBe("#2b6cff");
    // A valid font stack passes the B1 grammar gate byte-for-byte.
    expect(result.kit.tokens.typography.body).toBe("Georgia, serif");
    // Voice profile preserved verbatim (M8 reads this at generation time).
    expect(result.kit.voice_profile).toEqual({
      descriptors: ["confident", "concise"],
      samples: ["We build durable software."],
      do: ["use active voice"],
      dont: ["no jargon"],
    });
    expect(result.kit.likeness_refs.higgsfieldElementIds).toEqual(["hf_founder_01"]);
    expect(result.logoUrl).toBe("https://cdn.example/logo.svg");
    // A fully-specified voice/likeness/logo → not reported missing.
    expect(result.report.notes.find((n) => n.field === "voice")).toBeUndefined();
    expect(result.report.notes.find((n) => n.field === "likeness")).toBeUndefined();
    expect(result.report.notes.find((n) => n.field === "logo")).toBeUndefined();
  });

  it("the built kit is unlocked at version 1 (the caller locks before persisting)", () => {
    const result = ingestBrandKit({ colors: { accent: "#2b6cff" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kit.locked).toBe(false);
    expect(result.kit.version).toBe(1);
  });
});

describe("ingestBrandKit — B1 CSS-injection defense holds through the wrapper", () => {
  it("a hostile font stack is caught by the SKILL's grammar gate, not passed through", () => {
    // Payload that would close the :root rule and inject app-wide CSS if it ever
    // reached a stylesheet. It must never reach one — the skill throws first.
    const hostile = 'Inter"; } body { display:none } /*';
    const result = ingestBrandKit({ colors: { accent: "#2b6cff" }, typography: { body: hostile } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_brand_input");
    // The message is the SKILL's font-stack error — proving its gate fired, not
    // our code. (font-stack.ts: "not a valid CSS font-family list".)
    expect(result.detail).toContain("not a valid CSS font-family list");
    expect(result.detail).toContain("body");
  });

  it("rejects every CSS-escape-capable character class a hostile stack might use", () => {
    for (const hostile of ["Inter; color:red", "Inter</style><script>x", "url(evil)", "a{b}c"]) {
      const result = ingestBrandKit({ colors: { accent: "#2b6cff" }, typography: { display: hostile } });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe("invalid_brand_input");
      expect(result.detail).toContain("not a valid CSS font-family list");
    }
  });

  it("a hostile color is caught by the skill's hex parser, not passed through", () => {
    const result = ingestBrandKit({
      colors: { accent: "#fff; background:url(https://evil)" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_brand_input");
    expect(result.detail).toContain("Invalid hex color");
  });

  it("a missing accent is the skill's own refusal", () => {
    const result = ingestBrandKit({ colors: {} as { accent: string } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_brand_input");
    expect(result.detail).toContain("colors.accent");
  });
});

describe("ingestBrandKit — partial-input honesty (no invented brand attributes)", () => {
  it("reports every unspecified color/type/spacing as a DEFAULT, with the skill's value", () => {
    const result = ingestBrandKit({ colors: { accent: "#2b6cff" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The two-accent defaults are reported as defaults, not the client's choice.
    const secondary = result.report.notes.find((n) => n.field === "colors.accentSecondary");
    expect(secondary?.status).toBe("defaulted");
    expect(secondary?.value).toBe(result.kit.tokens.colors.accentSecondary);

    // Typography faces + scale defaulted.
    expect(result.report.notes.find((n) => n.field === "typography.body")?.status).toBe("defaulted");
    expect(result.report.notes.find((n) => n.field === "typography.scale")?.status).toBe("defaulted");
    // Spacing defaulted.
    expect(result.report.notes.find((n) => n.field === "spacing")?.status).toBe("defaulted");

    // Every default note carries a value or a scale/spacing note — never a
    // silent invention. accent (the client's actual choice) is NEVER defaulted.
    expect(result.report.notes.find((n) => n.field === "colors.accent")).toBeUndefined();
  });

  it("reports truly-absent inputs (voice/likeness/logo) as MISSING, not defaulted", () => {
    const result = ingestBrandKit({ colors: { accent: "#2b6cff" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const field of ["voice", "likeness", "logo"]) {
      expect(result.report.notes.find((n) => n.field === field)?.status).toBe("missing");
    }
  });

  it("a client-specified accentSecondary is NOT reported as a default", () => {
    const result = ingestBrandKit({ colors: { accent: "#2b6cff", accentSecondary: "#12b886" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.notes.find((n) => n.field === "colors.accentSecondary")).toBeUndefined();
  });
});

describe("ingestBrandKit — contrast-correction surfacing", () => {
  it("surfaces the skill's correction (we darkened your orange to meet contrast)", () => {
    // Bright orange on a white surface fails the 3:1 UI-component ratio; the
    // skill darkens it. The correction is surfaced, not hidden.
    const result = ingestBrandKit({ colors: { accent: "#ff9900", surface: "#ffffff" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const accentFix = result.report.contrastCorrections.find((a) => a.token === "accent");
    expect(accentFix).toBeDefined();
    if (!accentFix) return;
    // Darkened: the corrected orange is lower-lightness than the input.
    expect(lightnessOf(accentFix.to)).toBeLessThan(lightnessOf(accentFix.from));
    expect(accentFix.reason).toMatch(/required|contrast|1\.4\.11/i);
    // The corrected accent now clears 3:1 on the white surface.
    expect(contrastRatio(accentFix.to, "#ffffff")).toBeGreaterThanOrEqual(3);
    // Solvable palette → resolved, no unresolved checks.
    expect(result.report.contrastResolved).toBe(true);
    expect(result.report.unresolvedContrast).toHaveLength(0);
  });

  it("a palette that already passes surfaces zero corrections", () => {
    // The Signal-default dark chrome passes every gate as-is (defaults.ts).
    const result = ingestBrandKit({ colors: { accent: "#e3a94f" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.contrastCorrections).toHaveLength(0);
    expect(result.report.contrastResolved).toBe(true);
  });

  it("flags an UNRESOLVABLE palette for the write-path hard gate", () => {
    // Client-supplied light + dark surfaces straddle mid-luminance: no single
    // ink can serve both (skill contrast.test.ts fixture).
    const result = ingestBrandKit({
      colors: { accent: "#e3a94f", surface: "#ffffff", surfaceRaised: "#14181f" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.contrastResolved).toBe(false);
    expect(result.report.unresolvedContrast.length).toBeGreaterThan(0);
  });
});
