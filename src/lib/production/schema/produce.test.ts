/**
 * produceSchema — the M10 skill wrapper + visible-text gate (doc 05 M10, doc 07 §1.5).
 *
 * Coverage:
 *  - skill-wrap correctness (ready path, discriminated result passed through);
 *  - the visible-text match gate — fabricated FAQ answer / fake price / fabricated
 *    business name REJECTED with the named unmatched claim; a matching one PASSES;
 *  - the checkable-vs-pass-through distinction (sameAs, dates still pass-through;
 *    review counts + ratings are now error-gated — see below);
 *  - injection safety (hostile entity data escaped by the skill's serializer);
 *  - redacted rejection telemetry.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtractedDoc } from "@/lib/intelligence/crawl";
import {
  produceSchema,
  namedUnmatchedClaims,
  SCHEMA_REJECTION_MARKER,
} from "./produce";

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

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Skill-wrap correctness — the ready path                             */
/* ------------------------------------------------------------------ */

describe("produceSchema — ready path (skill wrap)", () => {
  it("returns the skill's ready result for schema whose claims are all on the page", () => {
    const q = "Do you deliver?";
    const a = "Yes, same day across San Diego.";
    const result = produceSchema({
      schemaType: "FAQPage",
      entity: { faqs: [{ question: q, answer: a }] },
      visible: doc({ h1s: ["FAQ"], visibleText: `${q} ${a}` }),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.jsonLd["@type"]).toBe("FAQPage");
    expect(result.scriptBlock.startsWith('<script type="application/ld+json">')).toBe(true);
    expect(result.correspondence.every((c) => c.matched)).toBe(true);
    expect(namedUnmatchedClaims(result)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The visible-text match gate — the M10 spine                         */
/* ------------------------------------------------------------------ */

describe("produceSchema — visible-text gate REJECTS overclaims", () => {
  it("rejects a fabricated FAQ answer, naming the exact unmatched claim", () => {
    const result = produceSchema({
      schemaType: "FAQPage",
      entity: {
        faqs: [
          { question: "Do you deliver?", answer: "Yes — free delivery on every order over $1." },
        ],
      },
      // Question is on the page; the answer is fabricated (never rendered).
      visible: doc({ visibleText: "Do you deliver? Hours are 9 to 5, Monday to Friday." }),
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.errors.some((e) => e.code === "TEXT_MISMATCH")).toBe(true);

    const named = namedUnmatchedClaims(result);
    expect(named).toHaveLength(1);
    expect(named[0].label).toBe("FAQ answer #1");
    expect(named[0].claim).toContain("free delivery");
  });

  it("rejects a fake Offer price, but passes it once the price is on the page", () => {
    const entity = {
      name: "Sunset Gummies",
      offer: { price: "24.99", priceCurrency: "USD" },
    } as const;

    const rejected = produceSchema({
      schemaType: "Product",
      entity,
      visible: doc({ visibleText: "Sunset Gummies are our best-selling edible." }),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      const named = namedUnmatchedClaims(rejected);
      expect(named.map((c) => c.label)).toContain("Offer price");
      expect(named.find((c) => c.label === "Offer price")?.claim).toBe("24.99");
    }

    const ready = produceSchema({
      schemaType: "Product",
      entity,
      visible: doc({ visibleText: "Sunset Gummies are our best-selling edible — just $24.99." }),
    });
    expect(ready.status).toBe("ready");
  });

  it("rejects a fabricated business name (error); address/phone on the page are not the cause", () => {
    const result = produceSchema({
      schemaType: "LocalBusiness",
      entity: {
        name: "Green Leaf Dispensary",
        address: { streetAddress: "123 Main St", addressLocality: "San Diego", addressCountry: "US" },
        telephone: "(619) 555-0143",
      },
      // Address + phone are on the page; the NAME is not.
      visible: doc({ visibleText: "123 Main St, San Diego. Call (619) 555-0143 for details." }),
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const named = namedUnmatchedClaims(result);
    expect(named.map((c) => c.label)).toEqual(["Business name"]);
  });
});

/* ------------------------------------------------------------------ */
/* Checkable vs PASS-THROUGH (the documented boundary)                 */
/* ------------------------------------------------------------------ */

describe("produceSchema — pass-through fields are NOT text-matched", () => {
  it("Person.sameAs URLs are pass-through — off-page URLs never block", () => {
    const result = produceSchema({
      schemaType: "Person",
      entity: {
        name: "Jane Realtor",
        jobTitle: "Principal Broker",
        sameAsSources: {
          linkedin: ["https://www.linkedin.com/in/jane-realtor"],
          credentialRegistries: ["https://nar.realtor/profile/jane"],
        },
      },
      // Name + jobTitle are on the page; the sameAs URLs are NOT.
      visible: doc({ visibleText: "Jane Realtor is our Principal Broker." }),
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // The URLs are encoded, but no correspondence entry exists for them (never a claim).
    expect(JSON.stringify(result.jsonLd)).toContain("linkedin.com/in/jane-realtor");
    expect(result.correspondence.some((c) => c.claim.includes("linkedin"))).toBe(false);
  });

  it("Article dates are pass-through — a dateModified not shown on the page still ships", () => {
    const result = produceSchema({
      schemaType: "Article",
      entity: {
        headline: "How AEO Changes Local Search",
        authorName: "Sam Writer",
        datePublished: "2026-01-10",
        dateModified: "2026-07-01",
      },
      visible: doc({ visibleText: "How AEO Changes Local Search. By Sam Writer." }),
      referenceDate: "2026-07-09",
    });
    expect(result.status).toBe("ready");
  });

});

/* ------------------------------------------------------------------ */
/* Review counts + ratings are now ERROR-gated                         */
/* (frozen-skill tightening 2026-07-09, Orchestrator-authorized —      */
/*  the M10 divergence is RESOLVED). These two cases previously encoded */
/*  the pass-through as intended; they are flipped to assert the gate   */
/*  now blocks fabrication and a genuinely-rendered value still passes. */
/* ------------------------------------------------------------------ */

describe("produceSchema — review counts + ratings are error-gated", () => {
  it("review COUNT is now checkable: a fabricated count is REJECTED (claim named); a matching one — incl. a thousands-comma page — passes", () => {
    const entity = {
      itemReviewed: { type: "Product", name: "Sunset Gummies" },
      ratingValue: 4.8,
      reviewCount: 5123,
    } as const;

    // Item name + rating value are on the page; the reviewCount is fabricated.
    const rejected = produceSchema({
      schemaType: "AggregateRating",
      entity,
      visible: doc({ visibleText: "Sunset Gummies — rated 4.8 by our customers." }),
    });
    expect(rejected.status).toBe("rejected");
    if (rejected.status === "rejected") {
      const named = namedUnmatchedClaims(rejected);
      expect(named.map((c) => c.label)).toContain("Aggregate review count");
      expect(named.find((c) => c.label === "Aggregate review count")?.claim).toBe("5123");
    }

    // A page that genuinely renders the count passes — contiguous OR with the
    // en-US thousands comma (the matcher tolerates "5,123").
    for (const page of [
      "Sunset Gummies — rated 4.8 from 5123 reviews.",
      "Sunset Gummies — rated 4.8 from 5,123 reviews.",
    ]) {
      const ready = produceSchema({
        schemaType: "AggregateRating",
        entity,
        visible: doc({ visibleText: page }),
      });
      expect(ready.status).toBe("ready");
      if (ready.status === "ready") {
        expect(ready.jsonLd.reviewCount).toBe(5123);
        // The count is now a VERIFIED correspondence entry (was never a claim before).
        expect(ready.correspondence.find((c) => c.claim === "5123")?.matched).toBe(true);
      }
    }
  });

  it("rating VALUE is now checkable: a fabricated rating is REJECTED (error, claim named)", () => {
    // Item name + review count are on the page; only the rating value is fabricated.
    const result = produceSchema({
      schemaType: "AggregateRating",
      entity: {
        itemReviewed: { type: "Product", name: "Sunset Gummies" },
        ratingValue: 4.8,
        reviewCount: 12,
      },
      visible: doc({ visibleText: "Sunset Gummies — trusted by 12 shoppers." }),
    });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    // The rating value is the ONLY blocking claim (name + count are on the page).
    expect(namedUnmatchedClaims(result).map((c) => c.label)).toEqual(["Aggregate rating value"]);
    const ratingEntry = result.correspondence.find((c) => c.label === "Aggregate rating value");
    expect(ratingEntry?.matched).toBe(false);
    expect(ratingEntry?.severity).toBe("error"); // was "warning" before the tightening
  });
});

/* ------------------------------------------------------------------ */
/* Injection safety — hostile entity data                              */
/* ------------------------------------------------------------------ */

describe("produceSchema — injection safety (skill serializer, never hand-rolled)", () => {
  it("escapes </script> and <!--, and safely round-trips a raw U+2028, in matching content", () => {
    const U2028 = String.fromCharCode(0x2028); // line separator — a real one, un-escaped
    // Both breakout sequences AND a raw U+2028 embedded in the answer.
    const answer = `Remove the </script> tag${U2028}and the <!-- comment --> before pasting.`;
    const question = "Why does my embed break?";
    const result = produceSchema({
      schemaType: "FAQPage",
      entity: { faqs: [{ question, answer }] },
      // Raw-string source: the hostile chars are in the corpus, so the claim matches.
      visible: `${question} ${answer}`,
    });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    // Every "<" is escaped to its u003c JSON form: the only raw </script> is the
    // block's own closing tag — no embedded breakout, and <!-- cannot open a comment.
    expect(result.scriptBlock.match(/<\/script>/g)).toHaveLength(1);
    expect(result.scriptBlock.endsWith("</script>")).toBe(true);
    expect(result.scriptBlock).toContain("\\u003c/script>");
    expect(result.scriptBlock).toContain("\\u003c!--");

    // U+2028 is NOT a script-tag breakout vector in an ld+json DATA block (only the
    // literal </script byte sequence closes it), so the skill correctly leaves it raw.
    // It survives in the emitted block and round-trips through JSON.parse.
    expect(result.scriptBlock.includes(U2028)).toBe(true);
    const body = result.scriptBlock.split("\n").slice(1, -1).join("\n");
    const parsed = JSON.parse(body) as { mainEntity: Array<{ acceptedAnswer: { text: string } }> };
    expect(parsed.mainEntity[0].acceptedAnswer.text).toBe(answer);
    expect(parsed.mainEntity[0].acceptedAnswer.text.includes(U2028)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Redacted telemetry (house contract)                                 */
/* ------------------------------------------------------------------ */

describe("produceSchema — rejection telemetry is redacted", () => {
  it("logs ONE line with marker + type + codes + count, never the claim value or page text", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const secret = "TOP_SECRET_UNMATCHED_ANSWER_9f3a";
    const pageText = "Do you deliver? Some entirely unrelated on-page copy about hours.";

    const result = produceSchema({
      schemaType: "FAQPage",
      entity: { faqs: [{ question: "Do you deliver?", answer: secret }] },
      visible: doc({ visibleText: pageText }),
    });
    expect(result.status).toBe("rejected");

    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0] as string;
    expect(line).toContain(SCHEMA_REJECTION_MARKER);
    expect(line).toContain("type=FAQPage");
    expect(line).toContain("codes=TEXT_MISMATCH");
    expect(line).toContain("count=1");
    // The unmatched claim value and the page text NEVER ride into the log.
    expect(line).not.toContain(secret);
    expect(line).not.toContain("unrelated on-page copy");
  });

  it("rejects (and logs) an empty visible corpus — nothing verifiable, nothing ships", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = produceSchema({
      schemaType: "FAQPage",
      entity: { faqs: [{ question: "Q?", answer: "A." }] },
      visible: doc({}), // every visible surface empty
    });
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.errors.some((e) => e.code === "EMPTY_VISIBLE_TEXT")).toBe(true);
    }
    expect(spy.mock.calls[0][0] as string).toContain("codes=EMPTY_VISIBLE_TEXT");
  });
});
