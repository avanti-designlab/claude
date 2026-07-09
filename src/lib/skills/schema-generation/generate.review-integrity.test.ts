/**
 * Review-integrity isolation suite (frozen-skill tightening 2026-07-09,
 * Orchestrator-authorized per CLAUDE.md rule 1).
 *
 * The hard rule under test: aggregate review counts + rating values are
 * error-gated visible-text claims — a fabricated count/rating REJECTS with the
 * offending claim surfaced in the correspondence report, while a genuinely
 * rendered value (contiguous OR with an en-US thousands comma) still ships.
 * Governing basis: doc 05 M10 ("schema must match the visible page text exactly")
 * + fabricated-review FTC exposure.
 *
 * Covers both the standalone AggregateRating root and the Product-embedded
 * aggregateRating (same shared builder — buildAggregateRating — so Restaurant is
 * covered transitively; the happy suite exercises the matching Restaurant path).
 */

import { describe, expect, it } from "vitest";
import { generateSchema } from "./generate";
import type {
  AggregateRatingInput,
  CorrespondenceEntry,
  ProductInput,
  SchemaGenerationResult,
} from "./types";

const ITEM = { type: "Product", name: "Sunset Gummies" } as const;

function aggregate(entity: AggregateRatingInput, visiblePageText: string): SchemaGenerationResult {
  return generateSchema({ schemaType: "AggregateRating", entity, visiblePageText });
}

function errorMismatch(result: SchemaGenerationResult): CorrespondenceEntry[] {
  return result.correspondence.filter((c) => !c.matched && c.severity === "error");
}

describe("aggregate review counts + rating value are error-gated", () => {
  it("fabricated reviewCount → rejected, error-severity, claim surfaced in correspondence", () => {
    // Item name + rating value are on the page; the reviewCount is fabricated.
    const result = aggregate(
      { itemReviewed: ITEM, ratingValue: 4.8, reviewCount: 5123 },
      "Sunset Gummies — rated 4.8 by our customers.",
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const blocked = errorMismatch(result);
    expect(blocked.map((c) => c.label)).toEqual(["Aggregate review count"]);
    expect(blocked[0].claim).toBe("5123");
    expect(result.errors.some((e) => e.code === "TEXT_MISMATCH" && e.claim === "5123")).toBe(true);
  });

  it("fabricated ratingCount → rejected, error-severity, claim surfaced in correspondence", () => {
    const result = aggregate(
      { itemReviewed: ITEM, ratingValue: 4.8, ratingCount: 5123 },
      "Sunset Gummies — rated 4.8 by our customers.",
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const blocked = errorMismatch(result);
    expect(blocked.map((c) => c.label)).toEqual(["Aggregate rating count"]);
    expect(blocked[0].claim).toBe("5123");
  });

  it("fabricated ratingValue → rejected, error-severity (was warning before the tightening)", () => {
    // Item name + review count are on the page; only the rating value is fabricated.
    const result = aggregate(
      { itemReviewed: ITEM, ratingValue: 4.8, reviewCount: 12 },
      "Sunset Gummies — trusted by 12 shoppers.",
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const blocked = errorMismatch(result);
    expect(blocked.map((c) => c.label)).toEqual(["Aggregate rating value"]);
    expect(blocked[0].claim).toBe("4.8");
  });

  it("matching count + rating (contiguous page) → ready, both verified", () => {
    const result = aggregate(
      { itemReviewed: ITEM, ratingValue: 4.8, reviewCount: 5123 },
      "Sunset Gummies — rated 4.8 from 5123 reviews.",
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.correspondence.find((c) => c.claim === "5123")?.matched).toBe(true);
    expect(result.correspondence.find((c) => c.claim === "4.8")?.matched).toBe(true);
  });

  it("matching count rendered with a thousands comma (page shows '5,123') → ready", () => {
    const result = aggregate(
      { itemReviewed: ITEM, ratingValue: 4.8, reviewCount: 5123 },
      "Sunset Gummies — rated 4.8 from 5,123 reviews.",
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    const countEntry = result.correspondence.find((c) => c.claim === "5123");
    expect(countEntry?.matched).toBe(true);
    // Evidence points at the comma-rendered form on the page.
    expect(countEntry?.evidence).toContain("5,123");
    expect(result.jsonLd.reviewCount).toBe(5123);
  });

  it("partial: rating present but count absent → rejected on the absent count only", () => {
    // Rating value 4.8 is on the page; the reviewCount 5123 is not.
    const result = aggregate(
      { itemReviewed: ITEM, ratingValue: 4.8, reviewCount: 5123 },
      "Sunset Gummies — rated 4.8 out of 5.",
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(errorMismatch(result).map((c) => c.label)).toEqual(["Aggregate review count"]);
    // The rating value it DID render is matched, not a blocker.
    expect(result.correspondence.find((c) => c.claim === "4.8")?.matched).toBe(true);
  });
});

describe("Product-embedded aggregateRating uses the same error gate", () => {
  const base: ProductInput = {
    name: "Sunset Gummies",
    aggregateRating: { ratingValue: 4.8, reviewCount: 5123 },
  };

  it("fabricated embedded reviewCount → rejected, path scoped under aggregateRating", () => {
    // Name + rating on the page; the embedded reviewCount is fabricated.
    const result = generateSchema({
      schemaType: "Product",
      entity: base,
      visiblePageText: "Sunset Gummies are our best-selling edible — rated 4.8.",
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    const blocked = errorMismatch(result);
    expect(blocked.map((c) => c.label)).toEqual(["Aggregate review count"]);
    expect(blocked[0].path).toBe("aggregateRating.reviewCount");
  });

  it("genuinely-rendered embedded count (thousands comma) → ready", () => {
    const result = generateSchema({
      schemaType: "Product",
      entity: base,
      visiblePageText: "Sunset Gummies — rated 4.8, 5,123 reviews.",
    });
    expect(result.status).toBe("ready");
  });
});
