import { describe, expect, it } from "vitest";
import type { CrawledPage, CrawledSite } from "@/lib/skills/aeo-audit";
import { assessOnSiteNap, buildSiteNapSurface, type CanonicalNap } from "./nap";

function page(overrides: Partial<CrawledPage>): CrawledPage {
  return {
    url: "https://x.test/",
    title: null,
    metaDescription: null,
    h1s: [],
    visibleText: "",
    jsonLdBlocks: [],
    images: [],
    internalLinks: [],
    hasVideo: false,
    hasTranscript: false,
    lastModified: null,
    rendersWithoutJs: true,
    ...overrides,
  };
}

function site(pages: CrawledPage[]): CrawledSite {
  return { baseUrl: "https://x.test", crawledAt: "2026-07-01T00:00:00.000Z", pages, robotsTxt: null, llmsTxt: null };
}

const CANON: CanonicalNap = {
  name: "North Park Realty",
  address: "3814 Ray St, San Diego, CA 92104",
  phone: "(619) 555-0143",
};

const LOCAL_JSONLD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "RealEstateAgent",
  name: "North Park Realty",
  telephone: "+1-619-555-0143",
  address: { "@type": "PostalAddress", streetAddress: "3814 Ray St", addressLocality: "San Diego" },
});

describe("assessOnSiteNap — structured schema match", () => {
  it("matches name + phone against LocalBusiness-class schema (normalized, separator-insensitive)", () => {
    const surface = buildSiteNapSurface(site([page({ jsonLdBlocks: [LOCAL_JSONLD], visibleText: "welcome" })]));
    const nap = assessOnSiteNap(CANON, surface);
    expect(nap.assessable).toBe(true);
    const byField = Object.fromEntries(nap.fields.map((f) => [f.field, f.status]));
    expect(byField.name).toBe("match");
    expect(byField.phone).toBe("match"); // +1-619-555-0143 vs (619) 555-0143 → same last-10
  });

  it("flags a schema NAP that disagrees with the canonical record as a mismatch", () => {
    const wrong = JSON.stringify({ "@type": "RealEstateAgent", name: "Old Brand Realty", telephone: "619-555-9999" });
    const surface = buildSiteNapSurface(site([page({ jsonLdBlocks: [wrong], visibleText: "hi" })]));
    const nap = assessOnSiteNap(CANON, surface);
    const name = nap.fields.find((f) => f.field === "name")!;
    expect(name.status).toBe("mismatch");
    expect(name.foundOnSite).toBe("Old Brand Realty");
    expect(nap.consistent).toBe(false);
  });
});

describe("assessOnSiteNap — visible-text fallback + honesty", () => {
  it("matches a name present only in prose (no local schema on the page)", () => {
    const surface = buildSiteNapSurface(site([page({ visibleText: "Welcome to North Park Realty, your agent." })]));
    const name = assessOnSiteNap(CANON, surface).fields.find((f) => f.field === "name")!;
    expect(name.status).toBe("match");
  });

  it("marks a canonical value that appears nowhere on the site as absent", () => {
    const surface = buildSiteNapSurface(site([page({ visibleText: "totally unrelated content" })]));
    const name = assessOnSiteNap(CANON, surface).fields.find((f) => f.field === "name")!;
    expect(name.status).toBe("absent");
  });

  it("reports no_canonical for a phone that isn't on record (NAP honesty — never a failure)", () => {
    const surface = buildSiteNapSurface(site([page({ visibleText: "North Park Realty 3814 Ray St" })]));
    const nap = assessOnSiteNap({ name: "North Park Realty", address: "3814 Ray St", phone: null }, surface);
    expect(nap.fields.find((f) => f.field === "phone")!.status).toBe("no_canonical");
  });

  it("withholds the whole on-site verdict when the site had no crawlable pages", () => {
    const surface = buildSiteNapSurface(site([]));
    const nap = assessOnSiteNap(CANON, surface);
    expect(nap.assessable).toBe(false);
    expect(nap.consistent).toBe(false);
    expect(nap.fields.every((f) => f.status === "not_assessable")).toBe(true);
  });
});

describe("assessOnSiteNap — determinism", () => {
  it("is byte-identical across repeated runs on the same inputs", () => {
    const s = site([page({ jsonLdBlocks: [LOCAL_JSONLD], visibleText: "North Park Realty 3814 Ray St San Diego" })]);
    const a = assessOnSiteNap(CANON, buildSiteNapSurface(s));
    const b = assessOnSiteNap(CANON, buildSiteNapSurface(s));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("survives invalid JSON-LD without throwing (falls back to prose presence)", () => {
    const surface = buildSiteNapSurface(
      site([page({ jsonLdBlocks: ["{ not json"], visibleText: "North Park Realty" })]),
    );
    expect(surface.hasLocalSchema).toBe(false);
    expect(assessOnSiteNap(CANON, surface).fields.find((f) => f.field === "name")!.status).toBe("match");
  });
});
