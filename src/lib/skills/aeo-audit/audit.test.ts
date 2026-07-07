import { describe, expect, it } from "vitest";
import { runAudit } from "./audit";
import { channelBoost, CHECK_CANONICAL_ORDER, effectiveCheckWeight, LOCAL_CHECK_IDS } from "./weights";
import type { Playbook } from "@/lib/types/playbook";
import type { CrawledSite, GbpProfileInput } from "./types";
import {
  BASE_URL,
  deepClone,
  ecommercePlaybook,
  jsonLd,
  makePage,
  makeSite,
  realEstatePlaybook,
  restaurantPlaybook,
} from "./fixtures";

const CONTEXT = { "@context": "https://schema.org" };

const entity = {
  name: "Acme Realty",
  phone: "+1 (619) 555-0100",
  address: "123 Main Street, San Diego, CA 92101",
  credentials: ["NAR"],
};

const completeGbp: GbpProfileInput = {
  locationName: "Main St",
  primaryCategory: "Real estate agency",
  description: "Full-service advisory for international buyers.",
  phone: "(619) 555-0100",
  address: "123 Main Street, San Diego, CA 92101",
  websiteUrl: BASE_URL,
  hoursComplete: true,
  photoCount: 10,
  attributesComplete: true,
  postsLast30Days: 1,
};

/** A real-estate site that satisfies every rubric check (semi-local path). */
function goodRealEstateSite(): CrawledSite {
  const home = makePage({
    url: `${BASE_URL}/`,
    title: "Acme Realty - Dubai property advisory",
    internalLinks: [`${BASE_URL}/about`, `${BASE_URL}/faq`, `${BASE_URL}/guide`, `${BASE_URL}/video-faq`],
    jsonLdBlocks: [
      jsonLd({ ...CONTEXT, "@type": "Person", name: "Jane Advisor", sameAs: ["https://linkedin.com/in/jane"] }),
      jsonLd({
        ...CONTEXT,
        "@type": "RealEstateAgent",
        name: "Acme Realty",
        telephone: "619-555-0100",
        address: { "@type": "PostalAddress", streetAddress: "123 Main Street", addressLocality: "San Diego", addressRegion: "CA", postalCode: "92101" },
      }),
      jsonLd({ ...CONTEXT, "@type": "BreadcrumbList", itemListElement: [] }),
    ],
  });
  const about = makePage({
    url: `${BASE_URL}/about`,
    title: "About our advisory team",
    visibleText: "Jane Advisor is a NAR member with fifteen years advising international property buyers.",
    internalLinks: [`${BASE_URL}/`, `${BASE_URL}/faq`],
  });
  const faq = makePage({
    url: `${BASE_URL}/faq`,
    title: "Buyer questions, answered directly",
    visibleText:
      "Can foreigners buy property in Dubai? Yes. Foreign buyers can purchase freehold property in designated areas.",
    internalLinks: [`${BASE_URL}/`, `${BASE_URL}/guide`],
    faqItems: [
      {
        question: "Can foreigners buy property in Dubai?",
        answer: "Yes. Foreign buyers can purchase freehold property in designated areas.",
      },
    ],
    jsonLdBlocks: [
      jsonLd({
        ...CONTEXT,
        "@type": "FAQPage",
        mainEntity: [
          {
            "@type": "Question",
            name: "Can foreigners buy property in Dubai?",
            acceptedAnswer: { "@type": "Answer", text: "Yes. Foreign buyers can purchase freehold property in designated areas." },
          },
        ],
      }),
    ],
  });
  const guide = makePage({
    url: `${BASE_URL}/guide`,
    title: "The Dubai buying process, step by step",
    internalLinks: [`${BASE_URL}/`],
    jsonLdBlocks: [jsonLd({ ...CONTEXT, "@type": "Article", headline: "The Dubai buying process" })],
  });
  const videoFaq = makePage({
    url: `${BASE_URL}/video-faq`,
    title: "Video: mortgages for foreign buyers",
    internalLinks: [`${BASE_URL}/`],
    hasVideo: true,
    hasTranscript: true,
    jsonLdBlocks: [jsonLd({ ...CONTEXT, "@type": "VideoObject", name: "Mortgages for foreign buyers" })],
  });

  return makeSite({
    pages: [home, about, faq, guide, videoFaq],
    entity,
    gbpProfiles: [completeGbp],
    napRecords: [
      { directory: "Google", name: "Acme Realty", address: "123 Main St, San Diego, CA 92101", phone: "6195550100" },
      { directory: "Yelp", name: "Acme Realty LLC", address: "123 Main Street, San Diego, CA 92101", phone: "(619) 555-0100" },
    ],
    reviewSnapshots: [{ source: "Google", totalCount: 42, recentReviewDates: ["2026-06-25T00:00:00.000Z"] }],
    coreWebVitals: [{ url: `${BASE_URL}/`, lcpMs: 1800, inpMs: 150, cls: 0.05 }],
  });
}

describe("runAudit — real-estate (semi-local path)", () => {
  it("scores a fully healthy site at 100 with all 13 checks scored and local checks applied", () => {
    const result = runAudit(goodRealEstateSite(), realEstatePlaybook);
    expect(result.overallScore).toBe(100);
    expect(result.checks).toHaveLength(13);
    expect(result.checks.map((check) => check.checkId)).toEqual([...CHECK_CANONICAL_ORDER]);
    expect(result.checks.every((check) => check.status === "scored")).toBe(true);
    expect(result.localChecksApplied).toBe(true);
    expect(result.fixes).toHaveLength(0);
    expect(result.dataGaps).toHaveLength(0);
    expect(result.playbookVertical).toBe("real-estate");
  });

  it("runs local checks at reduced (MEDIUM) weight for semi-local", () => {
    const result = runAudit(goodRealEstateSite(), realEstatePlaybook);
    const gbp = result.checks.find((check) => check.checkId === "gbp_completeness");
    const nap = result.checks.find((check) => check.checkId === "nap_consistency");
    expect(gbp?.weight).toBe(8 * 0.75 * 0.75); // base × semi-local × gbp_priority medium
    expect(nap?.weight).toBe(7 * 0.75);
  });

  it("records missing optional inputs as data gaps, not failures", () => {
    const site = goodRealEstateSite();
    delete site.gbpProfiles;
    delete site.napRecords;
    delete site.reviewSnapshots;
    delete site.coreWebVitals;
    const result = runAudit(site, realEstatePlaybook);
    const skipped = result.checks.filter((check) => check.skipReason === "no_data");
    expect(skipped.map((check) => check.checkId).sort()).toEqual(
      ["core_web_vitals", "gbp_completeness", "nap_consistency", "review_velocity"].sort(),
    );
    expect(skipped.every((check) => check.score === null && check.weight === 0)).toBe(true);
    expect(result.dataGaps).toHaveLength(4);
    expect(result.overallScore).toBe(100); // remaining checks all pass; gaps do not drag the score
  });
});

describe("runAudit — e-commerce (national path): local checks excluded, not failed", () => {
  function nationalSite(extra: Partial<CrawledSite> = {}): CrawledSite {
    // No local data at all — a national store.
    return makeSite(extra);
  }

  it("skips checks 8-10 as local_module_off with zero weight and null scores", () => {
    const result = runAudit(nationalSite(), ecommercePlaybook);
    for (const checkId of LOCAL_CHECK_IDS) {
      const check = result.checks.find((c) => c.checkId === checkId);
      expect(check?.status).toBe("skipped");
      expect(check?.skipReason).toBe("local_module_off");
      expect(check?.score).toBeNull();
      expect(check?.weight).toBe(0);
      expect(check?.fixes).toHaveLength(0);
    }
    expect(result.localChecksApplied).toBe(false);
    // Excluded-not-failed: local skips are not data gaps either.
    expect(result.dataGaps.some((gap) => gap.includes("GBP") || gap.includes("NAP") || gap.includes("Review"))).toBe(false);
  });

  it("produces the same overall score whether local data is absent or present-and-terrible", () => {
    const withoutLocal = runAudit(nationalSite(), ecommercePlaybook);
    const withTerribleLocal = runAudit(
      nationalSite({
        gbpProfiles: [
          {
            locationName: "Warehouse",
            primaryCategory: null,
            description: null,
            phone: null,
            address: null,
            websiteUrl: null,
            hoursComplete: false,
            photoCount: 0,
            attributesComplete: false,
            postsLast30Days: 0,
          },
        ],
        napRecords: [{ directory: "Google", name: "Wrong Name Entirely", address: null, phone: null }],
        reviewSnapshots: [],
      }),
      ecommercePlaybook,
    );
    expect(withTerribleLocal.overallScore).toBe(withoutLocal.overallScore);
    expect(withTerribleLocal.fixes.filter((fix) => LOCAL_CHECK_IDS.includes(fix.checkId))).toHaveLength(0);
  });

  it("matches a hand-computed weighted average over the scored non-local checks", () => {
    const result = runAudit(nationalSite(), ecommercePlaybook);
    const scored = result.checks.filter((check) => check.status === "scored" && check.score !== null);
    const weightSum = scored.reduce((sum, check) => sum + check.weight, 0);
    const expected = scored.reduce((sum, check) => sum + check.weight * (check.score ?? 0), 0) / weightSum;
    expect(result.overallScore).toBe(Math.round(expected * 10) / 10);
  });
});

describe("playbook-driven weighting", () => {
  it("gates and scales local check weights by local_intensity and gbp_priority", () => {
    expect(effectiveCheckWeight("gbp_completeness", restaurantPlaybook)).toBe(8 * 1.5 * 1.25);
    expect(effectiveCheckWeight("gbp_completeness", realEstatePlaybook)).toBe(8 * 0.75 * 0.75);
    expect(effectiveCheckWeight("gbp_completeness", ecommercePlaybook)).toBe(0);
    expect(effectiveCheckWeight("review_velocity", restaurantPlaybook)).toBe(6 * 1.5);
    expect(effectiveCheckWeight("review_velocity", realEstatePlaybook)).toBe(6 * 0.75);
    // Non-local checks are never gated by locality.
    expect(effectiveCheckWeight("schema_presence_validity", ecommercePlaybook)).toBe(12);
  });

  it("boosts fix priority from channel_weighting keywords", () => {
    expect(channelBoost("gbp_completeness", restaurantPlaybook)).toBe(1.35); // GBP + local @ 35
    expect(channelBoost("gbp_completeness", ecommercePlaybook)).toBe(1); // "Local" channel has weight 0
    expect(channelBoost("faq_direct_answer", realEstatePlaybook)).toBe(1.3); // on-site resource center @ 30
    expect(channelBoost("review_velocity", restaurantPlaybook)).toBe(1.25); // reviews @ 25
  });

  it("ignores non-finite channel weights — NaN or Infinity never poisons priority scores (0.2 gate regression)", () => {
    // NOT deepClone: JSON round-tripping silently converts NaN to null, which
    // would defeat the point of the regression (real NaN must reach the guard).
    const nanPlaybook: Playbook = { ...restaurantPlaybook, channel_weighting: { local: NaN } };
    const infinityPlaybook: Playbook = { ...restaurantPlaybook, channel_weighting: { local: Infinity } };

    // Non-finite weights degrade to "no boost" — NaN must not survive Math.min/Math.max.
    expect(channelBoost("gbp_completeness", nanPlaybook)).toBe(1);
    expect(channelBoost("gbp_completeness", infinityPlaybook)).toBe(1);

    // End-to-end: a site with GBP gaps (whose check matches the "local"
    // channel keyword) still yields finite, deterministically ordered fixes.
    const weakGbp: GbpProfileInput = {
      ...completeGbp,
      primaryCategory: null,
      hoursComplete: false,
      photoCount: 0,
      attributesComplete: false,
      postsLast30Days: 0,
    };
    const site = makeSite({ gbpProfiles: [weakGbp] });
    for (const playbook of [nanPlaybook, infinityPlaybook]) {
      const result = runAudit(site, playbook);
      expect(result.fixes.length).toBeGreaterThan(0);
      expect(result.fixes.some((fix) => fix.checkId === "gbp_completeness")).toBe(true);
      expect(result.fixes.every((fix) => Number.isFinite(fix.priorityScore))).toBe(true);
      // Roadmap ordering holds (a NaN priorityScore would corrupt the sort) …
      const scores = result.fixes.map((fix) => fix.priorityScore);
      expect([...scores].sort((x, y) => y - x)).toEqual(scores);
      // … and re-running on fresh inputs reproduces the exact same roadmap.
      const rerun = runAudit(deepClone(site), { ...playbook });
      expect(JSON.stringify(rerun)).toBe(JSON.stringify(result));
    }
  });

  it("prioritizes the same GBP gap far higher under a hyper-local playbook than a semi-local one", () => {
    const weakGbp: GbpProfileInput = {
      ...completeGbp,
      locationName: "Hillcrest",
      primaryCategory: null,
      hoursComplete: false,
      photoCount: 0,
      attributesComplete: false,
      postsLast30Days: 0,
    };
    const site = makeSite({ gbpProfiles: [weakGbp] });
    const restaurant = runAudit(site, restaurantPlaybook);
    const realEstate = runAudit(site, realEstatePlaybook);
    const restaurantFix = restaurant.fixes.find((fix) => fix.checkId === "gbp_completeness");
    const realEstateFix = realEstate.fixes.find((fix) => fix.checkId === "gbp_completeness");
    expect(restaurantFix).toBeDefined();
    expect(realEstateFix).toBeDefined();
    expect(restaurantFix!.priorityScore).toBeGreaterThan(realEstateFix!.priorityScore * 3);
    // And under the hyper-local playbook the GBP fix leads the roadmap.
    expect(restaurant.fixes[0]?.checkId).toBe("gbp_completeness");
  });
});

describe("fix list — determinism and governance flags", () => {
  function messySite(): CrawledSite {
    // Nearly complete schema (only BreadcrumbList missing), missing meta + H1
    // problems on distinct pages (two equal-priority onpage fixes), and all
    // four AI crawlers blocked (the critical finding).
    return makeSite({
      pages: [
        makePage({
          url: `${BASE_URL}/`,
          internalLinks: [`${BASE_URL}/a`, `${BASE_URL}/b`],
          jsonLdBlocks: [
            jsonLd({ ...CONTEXT, "@type": "Person", name: "Jane Advisor" }),
            jsonLd({ ...CONTEXT, "@type": "RealEstateAgent", name: "Acme Realty" }),
            jsonLd({ ...CONTEXT, "@type": "FAQPage" }),
            jsonLd({ ...CONTEXT, "@type": "Article", headline: "Guide" }),
            jsonLd({ ...CONTEXT, "@type": "VideoObject", name: "Clip" }),
          ],
        }),
        makePage({ url: `${BASE_URL}/a`, metaDescription: null, internalLinks: [`${BASE_URL}/`] }),
        makePage({ url: `${BASE_URL}/b`, h1s: [], internalLinks: [`${BASE_URL}/`] }),
      ],
      robotsTxt:
        "User-agent: GPTBot\nUser-agent: ClaudeBot\nUser-agent: PerplexityBot\nUser-agent: Google-Extended\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
    });
  }

  it("is deterministic: identical inputs produce identical results", () => {
    const a = runAudit(messySite(), realEstatePlaybook);
    const b = runAudit(deepClone(messySite()), deepClone(realEstatePlaybook));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("orders fixes by priority, then impact, then canonical check order, then id", () => {
    const result = runAudit(messySite(), realEstatePlaybook);
    const scores = result.fixes.map((fix) => fix.priorityScore);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    // Equal-priority tie within the same check breaks on fix id (h1 < metas alphabetically).
    const h1Index = result.fixes.findIndex((fix) => fix.id === "onpage_basics/fix-h1-structure");
    const metaIndex = result.fixes.findIndex((fix) => fix.id === "onpage_basics/write-missing-metas");
    expect(h1Index).toBeGreaterThanOrEqual(0);
    expect(metaIndex).toBeGreaterThanOrEqual(0);
    expect(result.fixes[h1Index]?.priorityScore).toBe(result.fixes[metaIndex]?.priorityScore);
    expect(h1Index).toBeLessThan(metaIndex);
  });

  it("puts the critical crawler block at the top of the roadmap", () => {
    const result = runAudit(messySite(), realEstatePlaybook);
    expect(result.fixes[0]?.id).toBe("ai_crawler_access/unblock-ai-crawlers");
    expect(result.fixes[0]?.impact).toBe("critical");
  });

  it("never emits fully-autonomous fixes — publishing work is ai_draft_human_approve or human_only (doc 03 §6)", () => {
    const result = runAudit(messySite(), realEstatePlaybook);
    expect(result.fixes.length).toBeGreaterThan(0);
    expect(result.fixes.every((fix) => fix.automationLevel !== "auto")).toBe(true);
    // Every fix names an owning module and carries evidence-bearing targets.
    expect(result.fixes.every((fix) => fix.module.length > 0 && fix.targetUrls.length > 0)).toBe(true);
  });
});
