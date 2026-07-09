/**
 * MediaGenerationProvider fake — the deferred Higgsfield/Motion seam's test double.
 * Proves it journals the exact BRAND-FORCED requests (so downstream tests can assert
 * the palette/logo/likeness reached the provider) and injects faults, with no SDK/MCP.
 */

import { describe, expect, it } from "vitest";
import { ScriptedMediaGenerationProvider } from "./provider";
import type { MediaGenerationRequest } from "./types";

function req(overrides: Partial<MediaGenerationRequest> = {}): MediaGenerationRequest {
  return {
    brief: { mediaType: "image", prompt: "a bright marina listing hero" },
    brand: {
      palette: ["#2b6cff", "#ff7a1a"],
      logoUrl: "https://cdn/logo.svg",
      likenessRefs: { higgsfieldElementIds: ["hf_1"], motionElementIds: ["mo_1"] },
    },
    ...overrides,
  };
}

describe("ScriptedMediaGenerationProvider", () => {
  it("journals every request (the brand-forced constraints are visible for asserts)", async () => {
    const provider = new ScriptedMediaGenerationProvider();
    await provider.generate(req());
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].brand.palette).toEqual(["#2b6cff", "#ff7a1a"]);
    expect(provider.calls[0].brand.logoUrl).toBe("https://cdn/logo.svg");
    expect(provider.calls[0].brand.likenessRefs.higgsfieldElementIds).toEqual(["hf_1"]);
  });

  it("scripts a result as a function of the request (echo the forced palette back)", async () => {
    const provider = new ScriptedMediaGenerationProvider().script({
      result: (r) => ({ url: `img://${r.brand.palette[0]}`, type: r.brief.mediaType, vendor: "scripted-fake" }),
    });
    const media = await provider.generate(req());
    expect(media).toEqual({ url: "img://#2b6cff", type: "image", vendor: "scripted-fake" });
  });

  it("matches a script by media type; unscripted returns a typed stub", async () => {
    const provider = new ScriptedMediaGenerationProvider().script({
      mediaType: "video",
      result: { url: "vid://x", type: "video", vendor: "scripted-fake" },
    });
    expect((await provider.generate(req({ brief: { mediaType: "video", prompt: "p" }, brand: req().brand }))).url).toBe(
      "vid://x",
    );
    const stub = await provider.generate(req()); // image — no matching rule
    expect(stub).toMatchObject({ type: "image", vendor: "scripted-fake" });
  });

  it("failNext rejects exactly once (the deferred/unavailable path)", async () => {
    const provider = new ScriptedMediaGenerationProvider().failNext(new Error("boom"));
    await expect(provider.generate(req())).rejects.toThrow("boom");
    // recovers on the next call
    await expect(provider.generate(req())).resolves.toBeDefined();
  });
});
