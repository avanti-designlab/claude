/**
 * Media BRAND-FORCING — the visual analog of M8's voice enforcement. Proves the
 * request carries M7's brand tokens (palette/logo/likeness) as HARD constraints,
 * derived from the LOCKED kit only (a caller can never request unbranded creative),
 * and that an unavailable provider is honest (media_unavailable, no invented asset).
 */

import { describe, expect, it } from "vitest";
import { brandKitFromRow, ingestBrandKit, type LockedBrandKit } from "@/lib/production/brand-kit";
import { ScriptedMediaGenerationProvider } from "./provider";
import { brandPalette, buildMediaGenerationRequest, brandVisualConstraints, requestMedia } from "./media";

/** A locked kit with a full accent palette, logo, and Higgsfield/Motion likeness refs. */
function lockedKit(): LockedBrandKit {
  const res = ingestBrandKit({
    colors: { accent: "#2b6cff", accentSecondary: "#12d18e", accentWarm: "#ff7a1a" },
    voice: { descriptors: ["confident"], samples: ["We advise, we don’t sell."] },
    likeness: { higgsfieldElementIds: ["hf_founder"], motionElementIds: ["mo_product"] },
    logoUrl: "https://cdn/logo.svg",
  });
  if (!res.ok) throw new Error("fixture build failed");
  const kit = brandKitFromRow({
    id: "kit-1",
    client_id: "client-1",
    version: 1,
    tokens: res.kit.tokens,
    voice_profile: res.kit.voice_profile,
    likeness_refs: res.kit.likeness_refs,
    assets: { logo_url: res.logoUrl, ingestion: res.report },
    created_at: "2026-07-09T00:00:00Z",
  });
  if (!kit) throw new Error("fixture map failed");
  return kit;
}

describe("brand-forcing", () => {
  it("palette forces the brand accent trio (chrome neutrals are NOT forced)", () => {
    const kit = lockedKit();
    const palette = brandPalette(kit);
    expect(palette).toContain(kit.tokens.colors.accent);
    expect(palette).toContain(kit.tokens.colors.accentSecondary);
    expect(palette).toContain(kit.tokens.colors.accentWarm);
    // the neutral surface/ink chrome must not leak into the forced brand palette
    expect(palette).not.toContain(kit.tokens.colors.surface);
    expect(palette).not.toContain(kit.tokens.colors.ink);
  });

  it("constraints carry the logo + likeness refs verbatim from the locked kit", () => {
    const c = brandVisualConstraints(lockedKit());
    expect(c.logoUrl).toBe("https://cdn/logo.svg");
    expect(c.likenessRefs.higgsfieldElementIds).toEqual(["hf_founder"]);
    expect(c.likenessRefs.motionElementIds).toEqual(["mo_product"]);
  });

  it("the request is brand-forced from the kit, not the caller: brand block matches the kit", () => {
    const kit = lockedKit();
    const request = buildMediaGenerationRequest({
      kit,
      brief: { mediaType: "video", prompt: "founder walks the marina", aspectRatio: "9:16" },
    });
    expect(request.brief).toMatchObject({ mediaType: "video", prompt: "founder walks the marina", aspectRatio: "9:16" });
    expect(request.brand).toEqual(brandVisualConstraints(kit));
    // there is no caller-supplied brand seam on the brief — brand comes from the kit
    expect(request.brand.palette).toContain("#2b6cff");
  });

  it("dedupes a single-accent kit's palette (accent == accentSecondary == accentWarm)", () => {
    const res = ingestBrandKit({ colors: { accent: "#333333" }, voice: { descriptors: ["x"], samples: ["y"] } });
    if (!res.ok) throw new Error("build failed");
    const kit = brandKitFromRow({
      id: "k", client_id: "c", version: 1, tokens: res.kit.tokens, voice_profile: res.kit.voice_profile,
      likeness_refs: res.kit.likeness_refs, assets: { logo_url: null, ingestion: res.report },
      created_at: "2026-07-09T00:00:00Z",
    })!;
    // whatever the defaults resolve to, the palette carries no duplicate hexes
    const palette = brandPalette(kit);
    expect(new Set(palette.map((h) => h.toLowerCase())).size).toBe(palette.length);
  });
});

describe("requestMedia", () => {
  it("returns the produced ref on success (carrying vendor provenance)", async () => {
    const provider = new ScriptedMediaGenerationProvider().script({
      result: { url: "img://x", type: "image", vendor: "scripted-fake" },
    });
    const out = await requestMedia(provider, buildMediaGenerationRequest({ kit: lockedKit(), brief: { mediaType: "image", prompt: "p" } }));
    expect(out).toEqual({ ok: true, media: { url: "img://x", type: "image", vendor: "scripted-fake" } });
  });

  it("a throwing (deferred/unavailable) provider is honest: media_unavailable, cause retained, no invented asset", async () => {
    const provider = new ScriptedMediaGenerationProvider().failNext(new Error("deferred"));
    const out = await requestMedia(provider, buildMediaGenerationRequest({ kit: lockedKit(), brief: { mediaType: "image", prompt: "p" } }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("media_unavailable");
    expect(out.cause).toBeInstanceOf(Error);
  });
});
