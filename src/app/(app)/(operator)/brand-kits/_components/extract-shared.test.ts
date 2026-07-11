/**
 * parseStoredExtractDraft — the parse boundary between stored draft jsonb
 * (untrusted extracted DATA) and the review panel / form prefill. The contract:
 * throw-free under hostile input, unknown keys dropped, malformed values
 * dropped (absent ≠ fabricated), strings trimmed + length-bounded, lists
 * count-bounded.
 */

import { describe, expect, it } from "vitest";

import {
  DRAFT_COLOR_KEYS,
  parseStoredExtractDraft,
} from "./extract-shared";

const ID = "draft-1";
const AT = "2026-07-11T00:00:00Z";

describe("parseStoredExtractDraft — happy path", () => {
  it("picks known keys and carries them through", () => {
    const view = parseStoredExtractDraft(
      {
        colors: { accent: "#3366ff", surface: "#ffffff", ink: "#111111" },
        typography: { display: "Inter, sans-serif", body: "Georgia, serif" },
        logoUrl: "https://acme.example/logo.png",
        logoCandidates: ["https://acme.example/logo.png", "https://acme.example/alt.svg"],
        imageryCandidates: ["https://acme.example/hero.jpg"],
        notes: ["Accent color proposed from the site's most prominent brand color."],
      },
      ID,
      AT
    );
    expect(view.draftId).toBe(ID);
    expect(view.createdAt).toBe(AT);
    expect(view.colors).toEqual({ accent: "#3366ff", surface: "#ffffff", ink: "#111111" });
    expect(view.typography).toEqual({ display: "Inter, sans-serif", body: "Georgia, serif" });
    expect(view.logoUrl).toBe("https://acme.example/logo.png");
    expect(view.logoCandidates).toHaveLength(2);
    expect(view.imageryCandidates).toEqual(["https://acme.example/hero.jpg"]);
    expect(view.notes).toHaveLength(1);
  });

  it("trims values", () => {
    const view = parseStoredExtractDraft(
      { colors: { accent: "  #3366ff  " }, logoUrl: "  https://a.example/l.png " },
      ID,
      AT
    );
    expect(view.colors.accent).toBe("#3366ff");
    expect(view.logoUrl).toBe("https://a.example/l.png");
  });
});

describe("parseStoredExtractDraft — hostile input (throw-free, absent ≠ fabricated)", () => {
  it.each([null, undefined, 42, "a string", [1, 2], true])(
    "a non-object draft (%p) yields an empty view, not a throw",
    (raw) => {
      const view = parseStoredExtractDraft(raw, ID, AT);
      expect(view.colors).toEqual({});
      expect(view.typography).toEqual({});
      expect(view.logoUrl).toBeNull();
      expect(view.logoCandidates).toEqual([]);
      expect(view.imageryCandidates).toEqual([]);
      expect(view.notes).toEqual([]);
    }
  );

  it("drops unknown color keys and non-string values; keeps the valid rest", () => {
    const view = parseStoredExtractDraft(
      {
        colors: {
          accent: "#3366ff",
          evil: "#000000", // unknown key — dropped
          surface: 42, // wrong type — dropped
          ink: null, // wrong type — dropped
          muted: "", // empty — dropped (absent, not fabricated)
        },
      },
      ID,
      AT
    );
    expect(view.colors).toEqual({ accent: "#3366ff" });
    expect("evil" in view.colors).toBe(false);
  });

  it("drops malformed containers wholesale (colors as array, typography as string)", () => {
    const view = parseStoredExtractDraft(
      { colors: ["#3366ff"], typography: "Inter", notes: "not-a-list" },
      ID,
      AT
    );
    expect(view.colors).toEqual({});
    expect(view.typography).toEqual({});
    expect(view.notes).toEqual([]);
  });

  it("drops over-length strings instead of truncating (honesty: never silently alter)", () => {
    const view = parseStoredExtractDraft(
      {
        colors: { accent: "#".padEnd(64, "f") }, // > 32 chars
        logoUrl: "https://a.example/" + "x".repeat(2100), // > 2048
        notes: ["ok", "y".repeat(600)], // 2nd > 500
      },
      ID,
      AT
    );
    expect(view.colors.accent).toBeUndefined();
    expect(view.logoUrl).toBeNull();
    expect(view.notes).toEqual(["ok"]);
  });

  it("count-caps lists (8 candidates, 24 notes) and skips non-string entries", () => {
    const view = parseStoredExtractDraft(
      {
        logoCandidates: Array.from({ length: 20 }, (_, i) => `https://a.example/${i}.png`),
        imageryCandidates: [null, 42, "https://a.example/real.jpg", {}],
        notes: Array.from({ length: 40 }, (_, i) => `note ${i}`),
      },
      ID,
      AT
    );
    expect(view.logoCandidates).toHaveLength(8);
    expect(view.imageryCandidates).toEqual(["https://a.example/real.jpg"]);
    expect(view.notes).toHaveLength(24);
  });

  it("drops an over-length font stack (512) and survives hostile typography values", () => {
    const view = parseStoredExtractDraft(
      {
        typography: {
          display: "F".repeat(600), // > 512 — dropped
          body: ["Georgia"], // wrong type — dropped
          mono: { stack: "Menlo" }, // wrong type — dropped
        },
      },
      ID,
      AT
    );
    expect(view.typography).toEqual({});
  });

  it("dedupes list entries (duplicate keys must never reach the panel)", () => {
    const view = parseStoredExtractDraft(
      {
        logoCandidates: ["https://a.example/l.png", "https://a.example/l.png"],
        notes: ["same note", "same note", "other"],
      },
      ID,
      AT
    );
    expect(view.logoCandidates).toEqual(["https://a.example/l.png"]);
    expect(view.notes).toEqual(["same note", "other"]);
  });

  it("covers every offered color key (the form's key set — drift breaks this pin)", () => {
    const all: Record<string, string> = {};
    for (const k of DRAFT_COLOR_KEYS) all[k] = "#123456";
    const view = parseStoredExtractDraft({ colors: all }, ID, AT);
    expect(Object.keys(view.colors).sort()).toEqual([...DRAFT_COLOR_KEYS].sort());
  });
});
