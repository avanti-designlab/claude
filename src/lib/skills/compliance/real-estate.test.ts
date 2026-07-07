/** Real-estate ruleset — Fair Housing screen + investment guarantees + dateModified discipline (doc 02 §2.2). */

import { describe, expect, it } from "vitest";
import { checkCompliance } from "./index";
import { expectClean, expectExcerptAt, violation, warning } from "./test-helpers";

describe("real-estate — violating samples", () => {
  it("blocks protected-class exclusions ('no kids', 'adults only')", () => {
    const text = "Quiet garden duplex: no kids, adults only.";
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "page",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "real-estate.fair-housing-exclusion");
    expectExcerptAt(v, text, "no kids");
    expect(v.legalReference).toContain("3604(c)");
    // "adults only" is reported as its own finding
    expect(result.violations.filter((x) => x.ruleId === "real-estate.fair-housing-exclusion")).toHaveLength(2);
  });

  it("blocks source-of-income refusals ('No Section 8')", () => {
    const text = "Great unit in a walkable spot. No Section 8.";
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "social_caption",
      content: { text },
    });
    const v = violation(result, "real-estate.fair-housing-exclusion");
    expectExcerptAt(v, text, "No Section 8");
  });

  it("blocks occupant-preference steering ('perfect for young families')", () => {
    const text = "This sunny 3-bedroom near the park is perfect for young families.";
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "blog",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "real-estate.fair-housing-preference");
    expectExcerptAt(v, text, "perfect for young families");
  });

  it("blocks investment guarantees ('guaranteed rental income', 'risk-free')", () => {
    const text = "Guaranteed rental income from day one makes this condo a truly risk-free investment.";
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "page",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "real-estate.investment-guarantees");
    expectExcerptAt(v, text, "Guaranteed rental income");
    expect(result.violations.filter((x) => x.ruleId === "real-estate.investment-guarantees")).toHaveLength(2); // + "risk-free"
  });

  it("blocks regulatory content (visa/tax) with no last-verified date", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "blog",
      content: { text: "Buying here qualifies you for the golden visa program and significant tax benefits." },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "real-estate.regulatory-freshness");
    expect(v.match).toBeUndefined(); // missing element — no text span to point at
    expect(v.requiredFix).toMatch(/lastVerified|last updated/i);
  });
});

describe("real-estate — freshness (dateModified discipline)", () => {
  const regulatoryText = "The golden visa program changed this year; talk to us about the current requirements.";

  it("passes regulatory content when content.lastVerified is stamped", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "blog",
      content: { text: regulatoryText, lastVerified: "2026-06-15" },
    });
    expectClean(result);
  });

  it("passes when the page itself carries 'Last updated <date>' language", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "faq",
      content: { text: `Last updated 15 June 2026. ${regulatoryText}` },
    });
    expectClean(result);
  });

  it("does not demand freshness stamps on non-regulatory content", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "blog",
      content: { text: "Five questions to ask at an open house, from a decade of showings." },
    });
    expectClean(result);
  });
});

describe("real-estate — false-positive design", () => {
  it("does not flag lawful HOPA senior housing ('adults only' near 55+ signals)", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "page",
      content: {
        text: "Resort-style living in our 55+ active adult community. Adults only residences with pickleball courts and a clubhouse.",
      },
    });
    expectClean(result);
  });

  it("does not flag 'exclusive listing' (ordinary brokerage term)", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "page",
      content: { text: "Exclusive listing: a renovated craftsman with a wraparound porch, offered at $725,000." },
    });
    expectClean(result);
  });

  it("warns — never blocks — on coded language like 'family-friendly' (context decides)", () => {
    const text = "A family-friendly neighborhood with parks nearby.";
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "social_caption",
      content: { text },
    });
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
    const w = warning(result, "real-estate.fair-housing-language-review");
    expectExcerptAt(w, text, "family-friendly");
  });
});

describe("real-estate — clean samples", () => {
  it("passes a plain property description (features, not occupants)", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "page",
      content: {
        text: "This 4-bedroom home features a fenced backyard, an updated kitchen, and a two-car garage half a mile from the elementary school.",
      },
    });
    expectClean(result);
  });

  it("passes a neutral just-listed caption", () => {
    const result = checkCompliance({
      vertical: "real-estate",
      contentType: "social_caption",
      content: { text: "Just listed in Maplewood: a light-filled corner condo with two balconies. DM to book a showing." },
    });
    expectClean(result);
  });
});
