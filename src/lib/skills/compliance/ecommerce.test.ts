/**
 * E-commerce ruleset — superiority substantiation, FTC endorsement/review
 * rules, disease claims, urgency/pricing verification (doc 02 §2.5).
 */

import { describe, expect, it } from "vitest";
import { checkCompliance } from "./index";
import { expectClean, expectExcerptAt, violation, warning } from "./test-helpers";

describe("ecommerce — violating samples", () => {
  it("blocks self-referential superiority claims ('our ... the best on the market')", () => {
    const text = "Our titanium bottle is simply the best on the market.";
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "ecommerce.superiority-claims");
    expectExcerptAt(v, text, "Our titanium bottle is simply the best");
    expect(v.legalReference).toContain("15 U.S.C. §45");
  });

  it("blocks unsubstantiated '#1' claims", () => {
    const text = "The #1 rated blender in America.";
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "ad",
      content: { text, platform: "google ads" },
    });
    expect(result.pass).toBe(false);
    expectExcerptAt(violation(result, "ecommerce.superiority-claims"), text, "#1");
  });

  it("blocks incentives conditioned on positive review sentiment", () => {
    const text = "Leave us a 5-star review and get a 20% discount code!";
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "review_response",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "ecommerce.review-incentives");
    expectExcerptAt(v, text, "5-star review and get a 20% discount");
    expect(v.legalReference).toContain("465");
  });

  it("blocks testimonial content with no FTC disclosure, and clears once disclosed", () => {
    const caption = '"This serum transformed my routine!" says Maya K.';
    const undisclosed = checkCompliance({
      vertical: "ecommerce",
      contentType: "social_caption",
      content: { text: caption, containsTestimonial: true },
    });
    expect(undisclosed.pass).toBe(false);
    const v = violation(undisclosed, "ecommerce.endorsement-disclosure");
    expect(v.match).toBeUndefined(); // missing element — no text span to point at
    expect(v.legalReference).toContain("255");

    const disclosed = checkCompliance({
      vertical: "ecommerce",
      contentType: "social_caption",
      content: { text: `${caption} #ad`, containsTestimonial: true },
    });
    expectClean(disclosed);
  });

  it("blocks affiliate content with no disclosure, and accepts 'we may earn a commission'", () => {
    const body = "Here are the five standing desks we tested this spring.";
    const undisclosed = checkCompliance({
      vertical: "ecommerce",
      contentType: "blog",
      content: { text: body, hasAffiliateRelationship: true },
    });
    expect(undisclosed.pass).toBe(false);
    violation(undisclosed, "ecommerce.endorsement-disclosure");

    const disclosed = checkCompliance({
      vertical: "ecommerce",
      contentType: "blog",
      content: { text: `We may earn a commission from links on this page. ${body}`, hasAffiliateRelationship: true },
    });
    expectClean(disclosed);
  });

  it("blocks disease claims on supplement products (one minimal finding per claim)", () => {
    const text = "This supplement prevents diabetes and reverses inflammation.";
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text },
    });
    expect(result.pass).toBe(false);
    expectExcerptAt(violation(result, "ecommerce.health-claims"), text, "prevents diabetes");
    expect(result.violations.filter((x) => x.ruleId === "ecommerce.health-claims")).toHaveLength(2); // + "reverses inflammation"
  });
});

describe("ecommerce — warn-for-verification rules", () => {
  it("warns on urgency/scarcity claims (true-or-remove, engine cannot verify inventory)", () => {
    const text = "Only 3 left in stock, and the sale ends tonight!";
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "ad",
      content: { text, platform: "google ads" },
    });
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
    expectExcerptAt(warning(result, "ecommerce.false-urgency"), text, "Only 3 left");
    expect(result.warnings.filter((x) => x.ruleId === "ecommerce.false-urgency")).toHaveLength(2); // + "ends tonight"
  });

  it("warns on former-price comparisons pending verification", () => {
    const text = "Was $99, now $49 for a limited run.";
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text },
    });
    expect(result.pass).toBe(true);
    // span anchors at the second price's first digit
    expectExcerptAt(warning(result, "ecommerce.deceptive-pricing"), text, "Was $99, now $4");
  });

  it("warns on quantified competitor comparisons without substantiation", () => {
    const text = "10x better than any leading detergent.";
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text },
    });
    expect(result.pass).toBe(true);
    expectExcerptAt(warning(result, "ecommerce.comparison-claims"), text, "10x better");
  });
});

describe("ecommerce — false-positive design (the product's own templates must not trip)", () => {
  it("passes substantiated '#1' claims (citation suppresses the match)", () => {
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text: "Rated #1 by Wirecutter (2025) for smoothie performance." },
    });
    expectClean(result);
  });

  it("passes editorial buying-guide 'best X for Y' language", () => {
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "blog",
      content: { text: "The best air purifiers for small apartments, tested over three weeks." },
    });
    expectClean(result);
  });

  it("passes 'number one priority' (exception span, not a claim)", () => {
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text: "Customer safety is our number one priority." },
    });
    expectClean(result);
  });

  it("passes negated disease language ('does not treat anxiety')", () => {
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: { text: "This tea does not treat anxiety; it is simply a calming bedtime ritual." },
    });
    expectClean(result);
  });
});

describe("ecommerce — clean samples", () => {
  it("passes a plain product description", () => {
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "page",
      content: {
        text: "Made from double-walled stainless steel, this 24 oz bottle keeps drinks cold for 24 hours. Free shipping on orders over $50.",
      },
    });
    expectClean(result);
  });

  it("passes an honest review-incentive invitation (no sentiment condition)", () => {
    const result = checkCompliance({
      vertical: "ecommerce",
      contentType: "review_response",
      content: { text: "Thanks for your order! We'd love your honest feedback, whatever your experience was." },
    });
    expectClean(result);
  });
});
