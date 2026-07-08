import { describe, expect, it } from "vitest";
import { checkSchemaPresence } from "./checks/schema-presence";
import { checkFaqDirectAnswer, evaluateFaqAnswer } from "./checks/faq-direct-answer";
import { checkVideoTranscript } from "./checks/video-transcript";
import { checkLlmsTxt } from "./checks/llms-txt";
import { checkFreshness } from "./checks/freshness";
import { checkOnpageBasics } from "./checks/onpage-basics";
import { BASE_URL, CRAWLED_AT, FRESH_DATE, STALE_DATE, ctx, jsonLd, makePage, makeSite, realEstatePlaybook } from "./fixtures";

const CONTEXT = { "@context": "https://schema.org" };

describe("check 1 — schema presence + validity", () => {
  it("scores 100 when all schema_profile types are present and valid", () => {
    const site = makeSite({
      pages: [
        makePage({
          url: `${BASE_URL}/`,
          jsonLdBlocks: [
            jsonLd({ ...CONTEXT, "@type": "Person", name: "Jane Advisor" }),
            jsonLd({ ...CONTEXT, "@type": "RealEstateAgent", name: "Acme Realty" }),
            jsonLd({ ...CONTEXT, "@type": "Article", headline: "Guide" }),
            jsonLd({ ...CONTEXT, "@type": "VideoObject", name: "FAQ video" }),
            jsonLd({ ...CONTEXT, "@type": "BreadcrumbList" }),
          ],
        }),
        makePage({
          url: `${BASE_URL}/faq`,
          visibleText: "Can foreigners buy property in Dubai? Yes, they can in designated freehold areas.",
          jsonLdBlocks: [
            jsonLd({
              ...CONTEXT,
              "@type": "FAQPage",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "Can foreigners buy property in Dubai?",
                  acceptedAnswer: { "@type": "Answer", text: "Yes, they can in designated freehold areas." },
                },
              ],
            }),
          ],
        }),
      ],
    });
    const outcome = checkSchemaPresence(ctx(site));
    expect(outcome.status).toBe("scored");
    expect(outcome.score).toBe(100);
    expect(outcome.fixes).toHaveLength(0);
  });

  it("reports missing types with priority-weighted scoring and M10 fixes", () => {
    const site = makeSite(); // no JSON-LD anywhere
    const outcome = checkSchemaPresence(ctx(site));
    expect(outcome.score).toBe(0);
    const missingPerson = outcome.fixes.find((fix) => fix.id === "schema_presence_validity/add-person");
    expect(missingPerson).toBeDefined();
    expect(missingPerson?.title).toBe("Add Person schema");
    expect(missingPerson?.detail).toBe(
      "Person is the #1 schema priority in your industry playbook but appears on no crawled page. " +
        "We draft it for your approval; schema must match the visible page text exactly.",
    );
    expect(missingPerson?.impact).toBe("high"); // Person is priority #1 for real estate
    expect(missingPerson?.module).toBe("M10");
    expect(missingPerson?.automationLevel).toBe("ai_draft_human_approve");
    const missingBreadcrumb = outcome.fixes.find((fix) => fix.id === "schema_presence_validity/add-breadcrumblist");
    expect(missingBreadcrumb?.impact).toBe("low"); // priority #6
  });

  it("penalizes invalid JSON-LD with page-level evidence", () => {
    const url = `${BASE_URL}/broken`;
    const site = makeSite({
      pages: [makePage({ url, jsonLdBlocks: ["{not json", jsonLd({ "@type": "Person", name: "No Context" })] })],
    });
    const outcome = checkSchemaPresence(ctx(site));
    expect(outcome.evidence.some((e) => e.url === url && e.message.includes("Unparseable"))).toBe(true);
    expect(outcome.evidence.some((e) => e.url === url && e.field === "@context")).toBe(true);
    expect(outcome.fixes.some((fix) => fix.id === "schema_presence_validity/repair-invalid-json-ld")).toBe(true);
  });

  it("flags FAQPage questions that do not match visible text (manual-action risk)", () => {
    const url = `${BASE_URL}/faq`;
    const site = makeSite({
      pages: [
        makePage({
          url,
          visibleText: "Totally different content.",
          jsonLdBlocks: [
            jsonLd({
              ...CONTEXT,
              "@type": "FAQPage",
              mainEntity: [
                { "@type": "Question", name: "Is this hidden?", acceptedAnswer: { "@type": "Answer", text: "Yes." } },
              ],
            }),
          ],
        }),
      ],
    });
    const outcome = checkSchemaPresence(ctx(site));
    const mismatch = outcome.evidence.find((e) => e.field === "FAQPage question");
    expect(mismatch?.url).toBe(url);
    expect(mismatch?.found).toBe("Is this hidden?");
    const mismatchFix = outcome.fixes.find((fix) => fix.id === "schema_presence_validity/fix-schema-text-mismatch");
    expect(mismatchFix?.detail).toBe(
      "1 FAQPage question in schema does not appear in the visible page text. " +
        "Schema must match visible text exactly — mismatch is a manual-action risk.",
    );
  });
});

describe("check 2 — direct-answer FAQ formatting", () => {
  it("accepts answers that open with the answer", () => {
    expect(evaluateFaqAnswer("Yes. Foreign buyers can get a mortgage from most Dubai banks.").direct).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["That depends on a lot of different factors we will explore.", "preamble"],
    ["Great question! Let me explain the background first.", "preamble"],
    ["What do you mean by mortgage?", "question opening"],
  ])("rejects non-direct answer %#: %s", (answer) => {
    expect(evaluateFaqAnswer(answer).direct).toBe(false);
  });

  it("rejects openings longer than 50 words", () => {
    const long = `${Array.from({ length: 55 }, (_, i) => `word${i}`).join(" ")}.`;
    const verdict = evaluateFaqAnswer(long);
    expect(verdict.direct).toBe(false);
    expect(verdict.reason).toContain("55 words");
  });

  it("scores the pass ratio with per-question evidence and an M8 fix", () => {
    const url = `${BASE_URL}/faq`;
    const site = makeSite({
      pages: [
        makePage({
          url,
          faqItems: [
            { question: "Q1?", answer: "Yes. It works exactly like this." },
            { question: "Q2?", answer: "Well, there are many considerations to weigh first." },
          ],
        }),
      ],
    });
    const outcome = checkFaqDirectAnswer(ctx(site));
    expect(outcome.score).toBe(50);
    expect(outcome.evidence[0]).toMatchObject({ url, field: "Q2?" });
    expect(outcome.fixes[0]).toMatchObject({ module: "M8", automationLevel: "ai_draft_human_approve", impact: "high" });
  });

  it("falls back to FAQPage JSON-LD when the crawler extracted no faqItems", () => {
    const site = makeSite({
      pages: [
        makePage({
          url: `${BASE_URL}/faq`,
          jsonLdBlocks: [
            jsonLd({
              ...CONTEXT,
              "@type": "FAQPage",
              mainEntity: [
                { "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "Yes. Directly answered." } },
              ],
            }),
          ],
        }),
      ],
    });
    const outcome = checkFaqDirectAnswer(ctx(site));
    expect(outcome.status).toBe("scored");
    expect(outcome.score).toBe(100);
  });

  it("skips as not_applicable when no FAQ content exists (not a failure)", () => {
    const outcome = checkFaqDirectAnswer(ctx(makeSite()));
    expect(outcome.status).toBe("skipped");
    expect(outcome.skipReason).toBe("not_applicable");
    expect(outcome.score).toBeNull();
  });
});

describe("check 3 — transcript + VideoObject on video pages", () => {
  it("skips when the site has no video pages", () => {
    const outcome = checkVideoTranscript(ctx(makeSite()));
    expect(outcome.status).toBe("skipped");
    expect(outcome.skipReason).toBe("not_applicable");
  });

  it("passes a video page with transcript + VideoObject", () => {
    const site = makeSite({
      pages: [
        makePage({
          url: `${BASE_URL}/video-faq`,
          hasVideo: true,
          hasTranscript: true,
          jsonLdBlocks: [jsonLd({ ...CONTEXT, "@type": "VideoObject", name: "FAQ video" })],
        }),
      ],
    });
    expect(checkVideoTranscript(ctx(site)).score).toBe(100);
  });

  it("gives half credit and separate M8/M10 fixes for missing transcript vs schema", () => {
    const url = `${BASE_URL}/video-faq`;
    const site = makeSite({ pages: [makePage({ url, hasVideo: true, hasTranscript: false })] });
    const outcome = checkVideoTranscript(ctx(site));
    expect(outcome.score).toBe(0);
    expect(outcome.evidence.map((e) => e.field).sort()).toEqual(["VideoObject", "transcript"]);
    const transcriptFix = outcome.fixes.find((fix) => fix.id === "video_transcript_schema/add-transcripts");
    const schemaFix = outcome.fixes.find((fix) => fix.id === "video_transcript_schema/add-videoobject");
    expect(transcriptFix?.module).toBe("M8");
    expect(transcriptFix?.title).toBe("Publish indexable transcripts on 1 video page");
    expect(transcriptFix?.detail).toContain("without it, engines have nothing to quote");
    expect(schemaFix?.module).toBe("M10");
    expect(schemaFix?.detail).toBe("We draft VideoObject schema to match the on-page video and transcript.");
  });
});

describe("check 4 — llms.txt", () => {
  it("scores 100 for a well-formed llms.txt", () => {
    expect(checkLlmsTxt(ctx(makeSite())).score).toBe(100);
  });

  it("scores 0 with a creation fix when absent", () => {
    const outcome = checkLlmsTxt(ctx(makeSite({ llmsTxt: null })));
    expect(outcome.score).toBe(0);
    expect(outcome.fixes[0]).toMatchObject({ id: "llms_txt/create", module: "M13", automationLevel: "ai_draft_human_approve" });
  });

  it("penalizes malformed content (no H1, no links) with field evidence", () => {
    const outcome = checkLlmsTxt(ctx(makeSite({ llmsTxt: "just some prose without structure" })));
    expect(outcome.score).toBe(50);
    expect(outcome.evidence.map((e) => e.field).sort()).toEqual(["links", "title"]);
  });
});

describe("check 12 — freshness / staleness", () => {
  it("scores 100 when all pages are within the refresh window", () => {
    expect(checkFreshness(ctx(makeSite())).score).toBe(100);
  });

  it("flags pages past the playbook refresh window, relative to crawledAt", () => {
    const staleUrl = `${BASE_URL}/stale`;
    const site = makeSite({
      pages: [
        makePage({ url: `${BASE_URL}/`, lastModified: FRESH_DATE }),
        makePage({ url: staleUrl, lastModified: STALE_DATE }),
      ],
    });
    const outcome = checkFreshness(ctx(site, realEstatePlaybook, 90));
    expect(outcome.score).toBe(50);
    const finding = outcome.evidence.find((e) => e.url === staleUrl);
    expect(finding?.found).toContain("181 days old");
    const fix = outcome.fixes.find((f) => f.id === "freshness/refresh-stale-pages");
    expect(fix?.title).toBe("Refresh 1 stale page with real content updates");
    expect(fix?.module).toBe("M8");
    expect(fix?.automationLevel).toBe("ai_draft_human_approve");
    expect(fix?.detail).toContain("cosmetic date-bumping is discounted by Google and prohibited.");
    expect(fix?.detail).not.toContain("doc 05");
  });

  it("respects a tighter refreshWindowDays option", () => {
    const site = makeSite(); // pages modified 11 days before crawl
    expect(checkFreshness(ctx(site, realEstatePlaybook, 10)).score).toBe(0);
    expect(checkFreshness(ctx(site, realEstatePlaybook, 60)).score).toBe(100);
  });

  it("treats missing last-modified signals as a gap with an M13 exposure fix", () => {
    const url = `${BASE_URL}/nosignal`;
    const site = makeSite({ pages: [makePage({ url, lastModified: null })] });
    const outcome = checkFreshness(ctx(site));
    expect(outcome.score).toBe(0);
    expect(outcome.fixes.some((fix) => fix.id === "freshness/expose-lastmodified-signals")).toBe(true);
  });

  it("never rewards a future-dated lastModified — flagged as suspect data with a correction fix (0.2 gate regression)", () => {
    const futureUrl = `${BASE_URL}/future`;
    const site = makeSite({
      pages: [
        makePage({ url: `${BASE_URL}/`, lastModified: FRESH_DATE }),
        // 14 days AFTER crawledAt (2026-07-01) — negative age must not pass `age <= windowDays`.
        makePage({ url: futureUrl, lastModified: "2026-07-15T00:00:00.000Z" }),
      ],
    });
    const outcome = checkFreshness(ctx(site, realEstatePlaybook, 90));
    // The future-dated page is NOT counted fresh: 1 of 2 pages fresh.
    expect(outcome.score).toBe(50);
    const finding = outcome.evidence.find((e) => e.url === futureUrl && e.field === "lastModified");
    expect(finding?.message).toContain("future-dated");
    expect(finding?.found).toContain("14 days after the crawl");
    const fix = outcome.fixes.find((f) => f.id === "freshness/correct-future-dated-lastmodified");
    expect(fix).toBeDefined();
    expect(fix?.targetUrls).toEqual([futureUrl]);
    expect(fix?.title).toBe("Correct future-dated last-modified signals on 1 page");
    expect(fix?.module).toBe("M13");
    expect(fix?.automationLevel).toBe("ai_draft_human_approve");
    expect(fix?.detail).toContain("cosmetic date-bumping is prohibited.");
    expect(fix?.detail).not.toContain("doc 05");
    // It is a suspect-data finding, not a "past the refresh window" finding.
    expect(outcome.fixes.some((f) => f.id === "freshness/refresh-stale-pages")).toBe(false);
  });

  it("detects stale dated statistics in visible text", () => {
    const url = `${BASE_URL}/stats`;
    const site = makeSite({
      pages: [makePage({ url, visibleText: "As of 2022, prices rose 4%. Data from 2023 shows growth." })],
    });
    const outcome = checkFreshness(ctx(site));
    expect(outcome.score).toBe(95); // fresh page, one stale-stat page penalty
    const staleStats = outcome.evidence.filter((e) => e.field === "stale statistic");
    expect(staleStats.length).toBe(2); // 2022 and 2023 are both ≥2 years before 2026
    expect(staleStats[0]?.url).toBe(url);
  });
});

describe("check 13 — title/meta/H1/alt coverage", () => {
  it("scores 100 for complete, non-duplicative basics", () => {
    expect(checkOnpageBasics(ctx(makeSite())).score).toBe(100);
  });

  it("catches missing titles, duplicate metas, H1 issues, and alt gaps with per-page evidence", () => {
    const meta = "The same duplicated description reused across two different pages of this website.";
    const site = makeSite({
      pages: [
        makePage({ url: `${BASE_URL}/a`, title: null, metaDescription: meta, h1s: [] }),
        makePage({
          url: `${BASE_URL}/b`,
          metaDescription: meta,
          h1s: ["One", "Two"],
          images: [
            { src: "/x.jpg", alt: null },
            { src: "/y.jpg", alt: "described" },
          ],
        }),
      ],
    });
    const outcome = checkOnpageBasics(ctx(site));
    expect(outcome.score).toBeLessThan(80);
    expect(outcome.evidence.some((e) => e.url === `${BASE_URL}/a` && e.field === "title")).toBe(true);
    expect(outcome.evidence.some((e) => e.field === "metaDescription" && e.message.includes("Duplicate"))).toBe(true);
    expect(outcome.evidence.some((e) => e.url === `${BASE_URL}/b` && e.field === "h1" && e.found === "2")).toBe(true);
    expect(outcome.evidence.some((e) => e.url === `${BASE_URL}/b` && e.field === "alt" && e.found === "1/2 images with alt")).toBe(true);
    const fixIds = outcome.fixes.map((fix) => fix.id);
    expect(fixIds).toContain("onpage_basics/write-missing-titles");
    expect(fixIds).toContain("onpage_basics/dedupe-metas");
    expect(fixIds).toContain("onpage_basics/fix-h1-structure");
    expect(fixIds).toContain("onpage_basics/add-image-alt-text");
    // Real plurals in client-facing fix titles: 1 page singular, 2 pages plural.
    expect(outcome.fixes.find((f) => f.id === "onpage_basics/write-missing-titles")?.title).toBe("Write titles for 1 page");
    expect(outcome.fixes.find((f) => f.id === "onpage_basics/dedupe-metas")?.title).toBe(
      "De-duplicate meta descriptions on 2 pages",
    );
    expect(outcome.fixes.every((fix) => fix.module === "M13" && fix.automationLevel === "ai_draft_human_approve")).toBe(true);
  });

  it("drafts missing meta descriptions per page, previewed before publish", () => {
    const site = makeSite({ pages: [makePage({ url: `${BASE_URL}/no-meta`, metaDescription: null })] });
    const outcome = checkOnpageBasics(ctx(site));
    const fix = outcome.fixes.find((f) => f.id === "onpage_basics/write-missing-metas");
    expect(fix?.title).toBe("Write meta descriptions for 1 page");
    expect(fix?.detail).toBe(
      "Write a unique description per page, drafted to the playbook's keyword targets and previewed before publish.",
    );
  });

  it("counts empty alt (decorative) as covered but missing alt as a gap", () => {
    const site = makeSite({
      pages: [makePage({ url: `${BASE_URL}/imgs`, images: [{ src: "/decorative.png", alt: "" }] })],
    });
    expect(checkOnpageBasics(ctx(site)).score).toBe(100);
  });
});

describe("determinism of time-dependent checks", () => {
  it("freshness is computed against crawledAt, not wall-clock", () => {
    // Same pages, crawl pushed 200 days later → everything becomes stale.
    const laterCrawl = makeSite({ crawledAt: "2027-01-17T00:00:00.000Z" });
    expect(checkFreshness(ctx(laterCrawl)).score).toBe(0);
    expect(checkFreshness(ctx(makeSite({ crawledAt: CRAWLED_AT }))).score).toBe(100);
  });
});
