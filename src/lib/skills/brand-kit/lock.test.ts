import { describe, expect, it } from "vitest";
import type { BrandKit } from "@/lib/types/brand";
import { buildBrandKit } from "./build";
import { contrastRatio } from "./color";
import { lockKit, reviseKit, type BrandKitRevision } from "./lock";

const freshKit = (): BrandKit =>
  buildBrandKit({
    colors: { accent: "#e3a94f" },
    voice: { descriptors: ["precise"], samples: ["Signal, not noise."] },
    likeness: { higgsfieldElementIds: ["hf_1"] },
  }).kit;

describe("lockKit", () => {
  it("returns a locked copy and leaves the original untouched", () => {
    const kit = freshKit();
    const locked = lockKit(kit);

    expect(locked.locked).toBe(true);
    expect(locked.version).toBe(kit.version);
    expect(locked.tokens).toEqual(kit.tokens);
    expect(kit.locked).toBe(false); // original unchanged
    expect(Object.isFrozen(kit)).toBe(false);
  });

  it("is a deep copy — mutating the original later never reaches the locked kit", () => {
    const kit = freshKit();
    const locked = lockKit(kit);
    kit.tokens.colors.accent = "#ff0000";
    kit.voice_profile.samples.push("late edit");
    expect(locked.tokens.colors.accent).toBe("#e3a94f");
    expect(locked.voice_profile.samples).toEqual(["Signal, not noise."]);
  });

  it("throws on direct mutation of a locked kit — top level", () => {
    const locked = lockKit(freshKit()) as BrandKit;
    expect(() => {
      locked.version = 99;
    }).toThrow(TypeError);
    expect(() => {
      locked.locked = false;
    }).toThrow(TypeError);
  });

  it("throws on direct mutation of a locked kit — nested tokens", () => {
    const locked = lockKit(freshKit()) as BrandKit;
    expect(() => {
      locked.tokens.colors.accent = "#ffffff";
    }).toThrow(TypeError);
    expect(() => {
      locked.tokens.typography.scale["score"].size = "9rem";
    }).toThrow(TypeError);
  });

  it("throws on array mutation inside a locked kit", () => {
    const locked = lockKit(freshKit()) as BrandKit;
    expect(() => {
      locked.voice_profile.samples.push("sneaky");
    }).toThrow(TypeError);
    expect(() => {
      // Mutable cast is the point: prove the RUNTIME freeze throws even when
      // the compile-time readonly on steps is deliberately bypassed.
      (locked.tokens.spacing.steps as number[])[0] = 999;
    }).toThrow(TypeError);
    expect(() => {
      locked.likeness_refs.higgsfieldElementIds.pop();
    }).toThrow(TypeError);
  });
});

describe("reviseKit", () => {
  it("returns a NEW kit at version+1, unlocked, with the change applied — history preserved", () => {
    const locked = lockKit(freshKit());
    const { kit: revised } = reviseKit(locked, {
      tokens: { colors: { accent: "#45b0e6" } },
    });

    expect(revised).not.toBe(locked);
    expect(revised.version).toBe(locked.version + 1);
    expect(revised.locked).toBe(false);
    expect(revised.tokens.colors.accent).toBe("#45b0e6");

    // The locked base is untouched — the caller persists both versions.
    expect(locked.version).toBe(1);
    expect(locked.locked).toBe(true);
    expect(locked.tokens.colors.accent).toBe("#e3a94f");
  });

  it("returns a mutable kit (locked:false) ready for further editing", () => {
    const { kit: revised } = reviseKit(lockKit(freshKit()), {});
    expect(Object.isFrozen(revised)).toBe(false);
    expect(Object.isFrozen(revised.tokens.colors)).toBe(false);
  });

  it("deep-merges: untouched branches survive a narrow change", () => {
    const base = lockKit(freshKit());
    const { kit: revised } = reviseKit(base, {
      tokens: { colors: { accent: "#45b0e6" } },
    });

    expect(revised.tokens.colors.surface).toBe(base.tokens.colors.surface);
    expect(revised.tokens.colors.muted).toBe(base.tokens.colors.muted);
    expect(revised.tokens.typography).toEqual(base.tokens.typography);
    expect(revised.tokens.spacing).toEqual(base.tokens.spacing);
    expect(revised.voice_profile).toEqual(base.voice_profile);
    expect(revised.likeness_refs).toEqual(base.likeness_refs);
  });

  it("replaces arrays wholesale (voice samples are curated, not appended)", () => {
    const base = lockKit(freshKit());
    const { kit: revised } = reviseKit(base, {
      voice_profile: { samples: ["New voice sample."] },
    });
    expect(revised.voice_profile.samples).toEqual(["New voice sample."]);
    expect(revised.voice_profile.descriptors).toEqual(["precise"]); // untouched list survives
  });

  it("re-validates contrast: an inaccessible revised accent is corrected and reported", () => {
    const base = lockKit(freshKit());
    const { kit: revised, accessibility } = reviseKit(base, {
      tokens: { colors: { accent: "#20242c" } },
    });

    expect(
      contrastRatio(revised.tokens.colors.accent, revised.tokens.colors.surface)
    ).toBeGreaterThanOrEqual(3);
    const adj = accessibility.adjustments.find((a) => a.token === "accent");
    expect(adj?.from).toBe("#20242c");
    expect(adj?.resolved).toBe(true);
  });

  it("rejects a revision smuggling a negative spacing unit (same gate as buildBrandKit)", () => {
    const base = lockKit(freshKit());
    expect(() => reviseKit(base, { tokens: { spacing: { unit: -4 } } })).toThrow(
      /spacing\.unit/
    );
    // The rejected revision never touches the locked base.
    expect(base.tokens.spacing.unit).toBe(4);
  });

  it("rejects a revision smuggling an empty font stack (same gate as buildBrandKit)", () => {
    const base = lockKit(freshKit());
    expect(() =>
      reviseKit(base, { tokens: { typography: { body: "  " } } })
    ).toThrow(/typography\.body/);
    expect(base.tokens.typography.body).not.toBe("  ");
  });

  it("applies a valid spacing + typography revision through the shared pipeline", () => {
    const base = lockKit(freshKit());
    const { kit: revised, accessibility } = reviseKit(base, {
      tokens: { spacing: { unit: 8 }, typography: { body: '"Söhne", sans-serif' } },
    });

    expect(revised.version).toBe(base.version + 1);
    expect(revised.locked).toBe(false);
    expect(revised.tokens.spacing.unit).toBe(8);
    expect(revised.tokens.spacing.steps).toEqual(base.tokens.spacing.steps); // merged, not dropped
    expect(revised.tokens.typography.body).toBe('"Söhne", sans-serif');
    expect(revised.tokens.typography.display).toBe(base.tokens.typography.display);
    expect(revised.tokens.colors).toEqual(base.tokens.colors);
    expect(revised.voice_profile).toEqual(base.voice_profile);
    expect(accessibility.pass).toBe(true);
    expect(accessibility.adjustments).toEqual([]);
    // History intact.
    expect(base.tokens.spacing.unit).toBe(4);
  });

  it("ignores attempts to patch locked/version directly", () => {
    const base = lockKit(freshKit());
    const sneaky = { locked: true, version: 99 } as unknown as BrandKitRevision;
    const { kit: revised } = reviseKit(base, sneaky);
    expect(revised.version).toBe(base.version + 1);
    expect(revised.locked).toBe(false);
  });

  it("chains versions across lock → revise → lock → revise", () => {
    const v1 = lockKit(freshKit());
    const v2 = reviseKit(v1, { tokens: { colors: { accent: "#45b0e6" } } }).kit;
    const v3Locked = lockKit(v2);
    const v3 = reviseKit(v3Locked, {
      voice_profile: { descriptors: ["precise", "warm"] },
    }).kit;

    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(v3.version).toBe(3);
    // Later revisions carry earlier ones forward.
    expect(v3.tokens.colors.accent).toBe("#45b0e6");
    expect(v3.voice_profile.descriptors).toEqual(["precise", "warm"]);
    // And every ancestor is intact.
    expect(v1.tokens.colors.accent).toBe("#e3a94f");
    expect(v2.voice_profile.descriptors).toEqual(["precise"]);
  });

  it("also versions unlocked kits (an unapproved draft can be revised too)", () => {
    const draft = freshKit();
    const { kit: revised } = reviseKit(draft, {
      tokens: { colors: { accent: "#45b0e6" } },
    });
    expect(revised.version).toBe(2);
    expect(draft.tokens.colors.accent).toBe("#e3a94f");
  });
});
