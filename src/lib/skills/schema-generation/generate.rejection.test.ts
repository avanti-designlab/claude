/**
 * Rejection-path regression suite (0.2 QA gate finding 1 — adapted from the
 * QA adversarial probes A1–A4).
 *
 * The hard rule under test: a rejected result can NEVER be injected — it must
 * not carry a `scriptBlock` property at all, on any rejection path. That is a
 * runtime object-shape guarantee, not just a TypeScript narrowing.
 */

import { describe, expect, it } from "vitest";
import { generateSchema } from "./generate";
import type { SchemaGenerationRejected, SchemaGenerationResult } from "./types";

function expectRejected(result: SchemaGenerationResult): SchemaGenerationRejected {
  expect(result.status).toBe("rejected");
  // Hard-rule enforcement: nothing injectable may exist on a rejected result —
  // no `scriptBlock` own-property in the runtime object shape.
  expect("scriptBlock" in result).toBe(false);
  expect(Object.keys(result)).not.toContain("scriptBlock");
  if (result.status !== "rejected") throw new Error("unreachable");
  return result;
}

describe("generateSchema — rejection paths (QA probes A1–A4)", () => {
  it("A1: claim not on the page → rejected with TEXT_MISMATCH and NO scriptBlock property", () => {
    const result = expectRejected(
      generateSchema({
        schemaType: "FAQPage",
        entity: { faqs: [{ question: "Do you deliver?", answer: "Yes, same day." }] },
        visiblePageText: "Totally unrelated page about socks.",
      }),
    );
    const mismatches = result.errors.filter((e) => e.code === "TEXT_MISMATCH");
    expect(mismatches.length).toBeGreaterThan(0);
    // The mismatch names the offending claim so review can act on it.
    expect(mismatches[0].claim).toBeDefined();
    // The draft stays available for debugging/review but is never serialized.
    expect(result.draftJsonLd).toBeDefined();
  });

  it("A2: empty or whitespace-only visiblePageText → rejected with EMPTY_VISIBLE_TEXT", () => {
    for (const visiblePageText of ["", "   \n\t "]) {
      const result = expectRejected(
        generateSchema({
          schemaType: "Person",
          entity: { name: "Jane Doe" },
          visiblePageText,
        }),
      );
      expect(result.errors.some((e) => e.code === "EMPTY_VISIBLE_TEXT")).toBe(true);
    }
  });

  it("A3: nested-only types (Offer, Menu) smuggled as root → rejected with UNSUPPORTED_ROOT_TYPE", () => {
    for (const smuggled of ["Offer", "Menu"]) {
      const result = expectRejected(
        generateSchema({
          // Casts simulate a loosely-typed caller (e.g. an API boundary).
          schemaType: smuggled as never,
          entity: { price: 5, priceCurrency: "USD" } as never,
          visiblePageText: "Anything",
        }),
      );
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe("UNSUPPORTED_ROOT_TYPE");
      expect(result.errors[0].message).toContain("nested-only");
    }
  });

  it("A4: whitespace-only FAQ question → rejected with MISSING_REQUIRED", () => {
    const result = expectRejected(
      generateSchema({
        schemaType: "FAQPage",
        entity: { faqs: [{ question: "   ", answer: "An answer that is on the page." }] },
        visiblePageText: "An answer that is on the page.",
      }),
    );
    expect(result.errors.some((e) => e.code === "MISSING_REQUIRED")).toBe(true);
  });
});
