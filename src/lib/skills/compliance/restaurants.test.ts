/** Restaurants ruleset — food health claims, allergen accuracy, alcohol rules, operational freshness (doc 02 §2.3). */

import { describe, expect, it } from "vitest";
import { checkCompliance } from "./index";
import { expectClean, expectExcerptAt, violation, warning } from "./test-helpers";

describe("restaurants — violating samples", () => {
  it("blocks disease claims about menu items (one minimal finding per claim)", () => {
    const text = "Our golden turmeric latte cures inflammation and treats arthritis.";
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "blog",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "restaurants.health-claims");
    expectExcerptAt(v, text, "cures inflammation");
    expect(v.legalReference).toContain("343(r)");
    expect(result.violations.filter((x) => x.ruleId === "restaurants.health-claims")).toHaveLength(2); // + "treats arthritis"
  });

  it("blocks alcohol-as-medicine framing ('wine ... good for your heart')", () => {
    const text = "A glass of red wine every night is good for your heart.";
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "social_caption",
      content: { text },
    });
    const v = violation(result, "restaurants.health-claims");
    expectExcerptAt(v, text, "wine every night is good for your heart");
  });

  it("blocks student-targeted alcohol promotion", () => {
    const text = "College students get $1 shots every Thursday!";
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "social_caption",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "restaurants.alcohol-minors");
    expectExcerptAt(v, text, "College students get $1 shots");
  });

  it("blocks ID-free service claims", () => {
    const text = "Trivia night with cheap pints; no ID required at the door.";
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "ad",
      content: { text, platform: "instagram" },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "restaurants.alcohol-minors");
    expectExcerptAt(v, text, "no ID required");
  });
});

describe("restaurants — warn-for-verification rules (fail toward review, not block)", () => {
  it("warns on allergen-free claims (kitchen verification required)", () => {
    const text = "Our gluten-free pizza crust is celiac safe.";
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "page",
      content: { text, lastVerified: "2026-07-01" },
    });
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
    const w = warning(result, "restaurants.allergen-verification");
    expectExcerptAt(w, text, "gluten-free");
    expect(result.warnings.filter((x) => x.ruleId === "restaurants.allergen-verification")).toHaveLength(2); // + "celiac safe"
  });

  it("warns on unlimited/free-alcohol promotions (state-law jurisdiction check)", () => {
    const text = "Join us Sunday for bottomless mimosas and an open bar.";
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "social_caption",
      content: { text },
    });
    expect(result.pass).toBe(true);
    const w = warning(result, "restaurants.alcohol-promotion-review");
    expectExcerptAt(w, text, "bottomless mimosas");
    expect(w.explanation).toMatch(/jurisdiction/i);
    expect(result.warnings.filter((x) => x.ruleId === "restaurants.alcohol-promotion-review")).toHaveLength(2); // + "open bar"
  });

  it("warns when hours/prices carry no last-verified stamp, and clears once stamped", () => {
    const text = "Happy hour daily 4-6pm: $5 drafts and half-price snacks.";
    const stale = checkCompliance({
      vertical: "restaurants",
      contentType: "page",
      content: { text },
    });
    expect(stale.pass).toBe(true);
    const w = warning(stale, "restaurants.operational-freshness");
    expect(w.match).toBeUndefined(); // missing element — no text span to point at
    expect(w.requiredFix).toMatch(/lastVerified|last updated/i);

    const stamped = checkCompliance({
      vertical: "restaurants",
      contentType: "page",
      content: { text, lastVerified: "2026-07-01" },
    });
    expectClean(stamped);
  });
});

describe("restaurants — clean samples", () => {
  it("passes dessert copy — 'sweet treats' and 'treat yourself' never read as disease claims", () => {
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "social_caption",
      content: { text: "Sweet treats and house-made desserts. Treat yourself this weekend." },
    });
    expectClean(result);
  });

  it("passes a plain menu story with no operational facts", () => {
    const result = checkCompliance({
      vertical: "restaurants",
      contentType: "blog",
      content: { text: "Our chef's tasting menu changes weekly with produce from two nearby farms." },
    });
    expectClean(result);
  });
});
