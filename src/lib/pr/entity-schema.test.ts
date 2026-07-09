/**
 * M12 entity schema via M10's visible-text gate. A Person NAME the page doesn't
 * show REJECTS (no fabricated entity). sameAs is pass-through — the genuineness
 * caveat is ALWAYS attached, and uncorroborated press links are flagged.
 */

import { describe, expect, it } from "vitest";
import { produceEntitySchema, SAME_AS_GENUINENESS_CAVEAT } from "./entity-schema";

const PAGE = "Daniel Reyes is the founder of GG Realty. As featured in Forbes.";

describe("produceEntitySchema — Person, visible-text gated", () => {
  it("rejects a Person whose name is NOT on the page (no fabricated entity)", () => {
    const out = produceEntitySchema({
      entity: { entityType: "Person", person: { name: "Nonexistent Ghost", jobTitle: "Founder" } },
      visible: PAGE,
    });
    expect(out.result.status).toBe("rejected");
  });

  it("produces a ready Person when the name IS on the page", () => {
    const out = produceEntitySchema({
      entity: {
        entityType: "Person",
        person: { name: "Daniel Reyes", jobTitle: "Founder", sameAsSources: { pressArticles: ["https://www.forbes.com/profile/daniel-reyes"] } },
      },
      visible: PAGE,
    });
    expect(out.result.status).toBe("ready");
    expect(out.sameAs).toEqual(["https://www.forbes.com/profile/daniel-reyes"]);
  });
});

describe("produceEntitySchema — sameAs genuineness honesty", () => {
  it("ALWAYS attaches the genuineness caveat (on-page-match cannot verify ownership)", () => {
    const out = produceEntitySchema({
      entity: { entityType: "Person", person: { name: "Daniel Reyes", sameAsSources: { pressArticles: ["https://forbes.com/x"] } } },
      visible: PAGE,
    });
    expect(out.sameAsGenuinenessCaveat).toBe(SAME_AS_GENUINENESS_CAVEAT);
  });

  it("flags a sameAs whose publication is NOT mentioned on-page (uncorroborated)", () => {
    const out = produceEntitySchema({
      entity: {
        entityType: "Person",
        person: {
          name: "Daniel Reyes",
          sameAsSources: { pressArticles: ["https://www.forbes.com/x", "https://www.inman.com/y"] },
        },
      },
      visible: PAGE, // mentions Forbes, not Inman
    });
    expect(out.uncorroboratedSameAs).toEqual(["https://www.inman.com/y"]);
  });

  it("with no corroboration corpus, flags nothing (absence of a corpus is not evidence against a link)", () => {
    const out = produceEntitySchema({
      entity: { entityType: "Person", person: { name: "Daniel Reyes", sameAsSources: { pressArticles: ["https://inman.com/y"] } } },
      visible: { title: "Daniel Reyes", metaDescription: null, h1s: ["Daniel Reyes"], visibleText: "Daniel Reyes founder", jsonLdBlocks: [], images: [], hrefs: [], hasVideo: false, hasTranscriptMarker: false, hasScripts: false, jsonLdDateModified: null },
      corroborationCorpus: null,
    });
    expect(out.uncorroboratedSameAs).toEqual([]);
  });
});

describe("produceEntitySchema — Organization", () => {
  it("produces a ready Organization when name is on-page; sameAs pass-through + caveat", () => {
    const out = produceEntitySchema({
      entity: {
        entityType: "Organization",
        organization: { name: "GG Realty", url: "https://gg.test", sameAs: ["https://forbes.com/x"] },
      },
      visible: PAGE,
    });
    expect(out.entityType).toBe("Organization");
    expect(out.result.status).toBe("ready");
    expect(out.sameAs).toEqual(["https://forbes.com/x"]);
    expect(out.sameAsGenuinenessCaveat).toBe(SAME_AS_GENUINENESS_CAVEAT);
  });
});
