/**
 * buildVisibleCorpus — the crawl → skill visible-text bridge (M10, doc 05 M10).
 *
 * Proves the honest boundary: rendered body + h1s + title are IN; the SERP-only
 * meta description and the page's existing JSON-LD are OUT.
 */

import { describe, expect, it } from "vitest";
import type { ExtractedDoc } from "@/lib/intelligence/crawl";
import { buildVisibleCorpus } from "./corpus";

function doc(partial: Partial<ExtractedDoc>): ExtractedDoc {
  return {
    title: null,
    metaDescription: null,
    h1s: [],
    visibleText: "",
    jsonLdBlocks: [],
    images: [],
    hrefs: [],
    hasVideo: false,
    hasTranscriptMarker: false,
    hasScripts: false,
    jsonLdDateModified: null,
    ...partial,
  };
}

describe("buildVisibleCorpus — what counts as visible", () => {
  it("includes rendered body, h1s, and the title", () => {
    const corpus = buildVisibleCorpus(
      doc({
        title: "Green Leaf Dispensary — San Diego",
        h1s: ["Welcome to Green Leaf"],
        visibleText: "Open daily 9am to 9pm. Call (619) 555-0143.",
      }),
    );
    expect(corpus).toContain("Green Leaf Dispensary — San Diego");
    expect(corpus).toContain("Welcome to Green Leaf");
    expect(corpus).toContain("Open daily 9am to 9pm");
  });

  it("EXCLUDES the meta description (SERP-only, not rendered on the page)", () => {
    const corpus = buildVisibleCorpus(
      doc({
        visibleText: "On-page body copy.",
        metaDescription: "Best dispensary in California — invisible marketing claim.",
      }),
    );
    expect(corpus).toContain("On-page body copy.");
    expect(corpus).not.toContain("invisible marketing claim");
  });

  it("EXCLUDES existing JSON-LD blocks (old schema is not visible text)", () => {
    const corpus = buildVisibleCorpus(
      doc({
        visibleText: "Rendered content.",
        jsonLdBlocks: ['{"@type":"Product","name":"Ghost Product Not On Page"}'],
      }),
    );
    expect(corpus).not.toContain("Ghost Product Not On Page");
  });

  it("passes a raw string through verbatim", () => {
    expect(buildVisibleCorpus("already rendered text")).toBe("already rendered text");
  });

  it("never pads with phantom separators when fields are empty", () => {
    // Only visibleText present: no leading/trailing newline from empty title/h1s.
    expect(buildVisibleCorpus(doc({ visibleText: "just body" }))).toBe("just body");
    // Everything empty → empty corpus (the skill then rejects EMPTY_VISIBLE_TEXT).
    expect(buildVisibleCorpus(doc({}))).toBe("");
    // Empty-string title and blank h1 are dropped, not joined as blank lines.
    expect(buildVisibleCorpus(doc({ title: "", h1s: [""], visibleText: "body" }))).toBe("body");
  });
});
