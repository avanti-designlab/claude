/**
 * M12 press/person assessment (pure). Honesty-first: uncrawlable is SAID SO,
 * corroboration is by on-page text mention, detection is conservative.
 */

import { describe, expect, it } from "vitest";
import type { CrawledPage, CrawledSite } from "@/lib/skills/aeo-audit";
import {
  assessPersonEntity,
  assessPressSurface,
  buildEntityCorpus,
  detectPressSection,
  personSchemaSignals,
  publicationLabel,
} from "./press";

function page(over: Partial<CrawledPage> = {}): CrawledPage {
  return {
    url: "https://gg.test/",
    title: "GG Realty",
    metaDescription: null,
    h1s: ["GG Realty"],
    visibleText: "Daniel Reyes is the founder of GG Realty.",
    jsonLdBlocks: [],
    images: [],
    internalLinks: [],
    hasVideo: false,
    hasTranscript: false,
    lastModified: null,
    rendersWithoutJs: true,
    ...over,
  };
}

function site(pages: CrawledPage[]): CrawledSite {
  return { baseUrl: "https://gg.test", crawledAt: "2026-07-01T00:00:00.000Z", pages, robotsTxt: null, llmsTxt: null };
}

describe("publicationLabel", () => {
  it("derives the registrable label from a URL host", () => {
    expect(publicationLabel("https://www.forbes.com/profile/x")).toBe("forbes");
    expect(publicationLabel("https://nar.realtor/x")).toBe("nar");
  });
  it("normalizes a plain publication name", () => {
    expect(publicationLabel("Forbes")).toBe("forbes");
  });
  it("returns null for empty", () => {
    expect(publicationLabel("   ")).toBeNull();
  });
});

describe("detectPressSection — conservative", () => {
  it("detects an 'As Featured In' marker in visible text", () => {
    expect(detectPressSection(site([page({ visibleText: "As featured in Forbes and Inman." })]))).toBe(true);
  });
  it("detects an exact short press heading", () => {
    expect(detectPressSection(site([page({ h1s: ["Press"] })]))).toBe(true);
  });
  it("does NOT fire on incidental prose ('press enter', 'press release')", () => {
    expect(detectPressSection(site([page({ visibleText: "Press enter to submit our press release form." , h1s: ["Contact"] })]))).toBe(false);
  });
});

describe("personSchemaSignals — conservative raw-string signal", () => {
  it("detects a Person block and its sameAs", () => {
    const s = site([page({ jsonLdBlocks: ['{"@type":"Person","name":"Daniel Reyes","sameAs":["https://forbes.com/x"]}'] })]);
    expect(personSchemaSignals(s)).toEqual({ present: true, withSameAs: true });
  });
  it("Person without sameAs → present, no sameAs", () => {
    const s = site([page({ jsonLdBlocks: ['{"@type":"Person","name":"Daniel Reyes"}'] })]);
    expect(personSchemaSignals(s)).toEqual({ present: true, withSameAs: false });
  });
  it("no Person block → neither present", () => {
    const s = site([page({ jsonLdBlocks: ['{"@type":"Organization","name":"GG Realty"}'] })]);
    expect(personSchemaSignals(s)).toEqual({ present: false, withSameAs: false });
  });
});

describe("assessPersonEntity — honesty", () => {
  const corpus = buildEntityCorpus(site([page()]));

  it("name present on page → assessed, namePresentOnPage true", () => {
    const a = assessPersonEntity({
      keyPersonName: "Daniel Reyes",
      corpus,
      corpusAssessable: true,
      personSchema: { present: false, withSameAs: false },
    });
    expect(a.status).toBe("assessed");
    expect(a.namePresentOnPage).toBe(true);
    // No Person schema on-site → an honest note is raised.
    expect(a.notes.join(" ")).toContain("No Person JSON-LD");
  });

  it("name NOT on page → assessed but flagged (would be gate-rejected)", () => {
    const a = assessPersonEntity({
      keyPersonName: "Someone Else",
      corpus,
      corpusAssessable: true,
      personSchema: { present: false, withSameAs: false },
    });
    expect(a.namePresentOnPage).toBe(false);
    expect(a.notes.join(" ")).toContain("visible-text gate");
  });

  it("uncrawlable → not_assessable, verdict withheld (never fabricated)", () => {
    const a = assessPersonEntity({
      keyPersonName: "Daniel Reyes",
      corpus: "",
      corpusAssessable: false,
      personSchema: { present: false, withSameAs: false },
    });
    expect(a.status).toBe("not_assessable");
    expect(a.namePresentOnPage).toBe(false);
    expect(a.notes.join(" ")).toContain("no crawlable pages");
  });

  it("no key person supplied → no_key_person", () => {
    const a = assessPersonEntity({ keyPersonName: null, corpus, corpusAssessable: true, personSchema: { present: false, withSameAs: false } });
    expect(a.status).toBe("no_key_person");
  });
});

describe("assessPressSurface — corroboration honesty", () => {
  const corpus = "As featured in Forbes. Daniel Reyes joined GG Realty.";

  it("corroborates a claimed press item mentioned on-page; flags one that is not", () => {
    const a = assessPressSurface({
      claimedPress: [
        { publication: "Forbes", url: "https://forbes.com/x" },
        { publication: "Inman", url: "https://inman.com/y" },
      ],
      corpus,
      corpusAssessable: true,
      pressSectionPresent: true,
    });
    expect(a.status).toBe("assessed");
    expect(a.corroboratedCount).toBe(1);
    expect(a.claimedCount).toBe(2);
    const forbes = a.claimedPress.find((p) => p.publication === "Forbes")!;
    const inman = a.claimedPress.find((p) => p.publication === "Inman")!;
    expect(forbes.mentionedOnPage).toBe(true);
    expect(inman.mentionedOnPage).toBe(false);
    expect(inman.note).toContain("NOT mentioned");
  });

  it("uncrawlable → not_assessable, no fabricated corroboration", () => {
    const a = assessPressSurface({
      claimedPress: [{ publication: "Forbes" }],
      corpus: "",
      corpusAssessable: false,
      pressSectionPresent: false,
    });
    expect(a.status).toBe("not_assessable");
    expect(a.corroboratedCount).toBe(0);
    expect(a.claimedPress).toEqual([]);
    expect(a.claimedCount).toBe(1);
  });
});
