/**
 * Brand-kit input clamp suite — the size backstop the skill does NOT cover.
 * The skill validates FORMAT (hex, font grammar, scale, spacing); this layer
 * caps SIZE so a hostile mega-payload never reaches a jsonb column, refusing
 * with interface-voice copy.
 */

import { describe, expect, it } from "vitest";
import {
  LIKENESS_IDS_MAX,
  LOGO_URL_MAX_CHARS,
  VOICE_LIST_MAX,
  VOICE_SAMPLE_MAX_CHARS,
  sanitizeLogoUrl,
  validateBrandKitInput,
  validateBrandKitRevision,
} from "./validate";

describe("validateBrandKitInput", () => {
  it("passes a clean payload through, trimming voice entries", () => {
    const res = validateBrandKitInput({
      colors: { accent: "#2b6cff" },
      voice: { descriptors: ["  confident  "], samples: ["We build."] },
      likeness: { higgsfieldElementIds: ["hf_1"] },
      logoUrl: "  https://cdn/logo.svg  ",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.colors.accent).toBe("#2b6cff");
    expect(res.value.voice?.descriptors).toEqual(["confident"]);
    expect(res.value.logoUrl).toBe("https://cdn/logo.svg");
  });

  it("refuses when colors is absent or not an object (need at least a brand color)", () => {
    expect(validateBrandKitInput({}).ok).toBe(false);
    expect(validateBrandKitInput({ colors: "blue" }).ok).toBe(false);
  });

  it("refuses a non-string color value (hostile shape) before the skill parser", () => {
    const res = validateBrandKitInput({ colors: { accent: { evil: true } } });
    expect(res.ok).toBe(false);
  });

  it("caps the voice lists and per-entry length", () => {
    const tooMany = validateBrandKitInput({
      colors: { accent: "#2b6cff" },
      voice: { descriptors: Array.from({ length: VOICE_LIST_MAX + 1 }, () => "x") },
    });
    expect(tooMany.ok).toBe(false);

    const tooLong = validateBrandKitInput({
      colors: { accent: "#2b6cff" },
      voice: { samples: ["x".repeat(VOICE_SAMPLE_MAX_CHARS + 1)] },
    });
    expect(tooLong.ok).toBe(false);
  });

  it("refuses a non-string voice entry", () => {
    const res = validateBrandKitInput({
      colors: { accent: "#2b6cff" },
      voice: { descriptors: [42] },
    });
    expect(res.ok).toBe(false);
  });

  it("caps the likeness id lists", () => {
    const res = validateBrandKitInput({
      colors: { accent: "#2b6cff" },
      likeness: { motionElementIds: Array.from({ length: LIKENESS_IDS_MAX + 1 }, () => "m") },
    });
    expect(res.ok).toBe(false);
  });

  it("does not reintroduce the B1 vector: it passes font input THROUGH to the skill (never sanitizes it away)", () => {
    // The clamp must NOT strip/rewrite a font stack (sanitize-by-strip would
    // hide an attack). It only size-caps; the skill's grammar gate rejects.
    const res = validateBrandKitInput({
      colors: { accent: "#2b6cff" },
      typography: { body: 'Inter"; } evil' },
    });
    // Within the length cap → the clamp passes it through unchanged for the
    // skill to reject at build time.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.typography?.body).toBe('Inter"; } evil');
  });

  it("caps an over-long font stack", () => {
    const res = validateBrandKitInput({
      colors: { accent: "#2b6cff" },
      typography: { display: "A".repeat(400) },
    });
    expect(res.ok).toBe(false);
  });
});

describe("sanitizeLogoUrl", () => {
  it("passes a string, nulls blank/empty, keeps undefined absent", () => {
    expect(sanitizeLogoUrl("https://x/y.svg")).toEqual({ ok: true, value: "https://x/y.svg" });
    expect(sanitizeLogoUrl("   ")).toEqual({ ok: true, value: null });
    expect(sanitizeLogoUrl(null)).toEqual({ ok: true, value: null });
    expect(sanitizeLogoUrl(undefined)).toEqual({ ok: true, value: undefined });
  });

  it("refuses a non-string or over-long url", () => {
    expect(sanitizeLogoUrl(42).ok).toBe(false);
    expect(sanitizeLogoUrl("h".repeat(LOGO_URL_MAX_CHARS + 1)).ok).toBe(false);
  });
});

describe("validateBrandKitRevision", () => {
  it("passes a clean token diff + voice diff through", () => {
    const res = validateBrandKitRevision({
      tokens: { colors: { accent: "#12b886" } },
      voice_profile: { descriptors: ["warmer"] },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.changes.tokens?.colors).toEqual({ accent: "#12b886" });
    expect(res.changes.voice_profile?.descriptors).toEqual(["warmer"]);
  });

  it("refuses a non-object tokens container", () => {
    expect(validateBrandKitRevision({ tokens: "x" }).ok).toBe(false);
  });

  it("caps revision voice lists the same way", () => {
    const res = validateBrandKitRevision({
      voice_profile: { samples: ["x".repeat(VOICE_SAMPLE_MAX_CHARS + 1)] },
    });
    expect(res.ok).toBe(false);
  });

  it("an empty revision is valid (no-op diff)", () => {
    expect(validateBrandKitRevision({}).ok).toBe(true);
  });
});
