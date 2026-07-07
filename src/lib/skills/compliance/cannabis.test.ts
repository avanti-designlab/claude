/** Cannabis ruleset — strictest vertical (doc 02 §2.1). */

import { describe, expect, it } from "vitest";
import { checkCompliance } from "./index";
import { expectClean, expectExcerptAt, violation, warning } from "./test-helpers";

describe("cannabis — violating samples", () => {
  it("blocks health/disease claims (verb + condition)", () => {
    const text = "Our CBD tincture treats anxiety and cures insomnia.";
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "page",
      content: { text, hasAgeGate: true },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "cannabis.health-claims");
    expectExcerptAt(v, text, "treats anxiety");
    expect(v.legalReference).toContain("21 U.S.C.");
    // both claims in the sentence are reported
    expect(result.violations.filter((x) => x.ruleId === "cannabis.health-claims")).toHaveLength(2);
  });

  it("blocks relief-framed medical claims ('anxiety relief')", () => {
    const text = "Reach for our indica gummies for fast anxiety relief.";
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "social_caption",
      content: { text },
    });
    const v = violation(result, "cannabis.health-claims");
    expectExcerptAt(v, text, "anxiety relief");
  });

  it("blocks pages with no age-gate signal (required element)", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "page",
      content: { text: "Browse our indica flower menu and order online for same-day pickup." },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "cannabis.age-gate");
    expect(v.match).toBeUndefined(); // missing element — no text span to point at
    expect(v.requiredFix).toMatch(/age gate|21\+/i);
  });

  it("blocks interstate-commerce implications", () => {
    const text = "We ship nationwide — order from any state today.";
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "blog",
      content: { text },
    });
    const v = violation(result, "cannabis.interstate-commerce");
    expectExcerptAt(v, text, "ship nationwide");
    expect(v.legalReference).toContain("Controlled Substances Act");
  });

  it("blocks minor-targeting signals", () => {
    const text = "Perfect for students on a budget — stock up before back to school!";
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "social_caption",
      content: { text },
    });
    const v = violation(result, "cannabis.minor-appeal");
    expectExcerptAt(v, text, "Perfect for students");
    expect(result.violations.filter((x) => x.ruleId === "cannabis.minor-appeal")).toHaveLength(2); // + "back to school"
  });
});

describe("cannabis — Meta/prohibited-platform ad gate", () => {
  it("blocks ANY ad output targeted at Meta", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "ad",
      content: { text: "First-time customers get 15% off.", platform: "meta" },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "cannabis.ad-platform-gate");
    expect(v.match).toEqual({ excerpt: "meta", index: -1 });
    expect(v.explanation).toContain("meta");
  });

  it("recognizes Meta-family platform strings ('Instagram Stories')", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "ad",
      content: { text: "Daily deals for adults 21 and over.", platform: "Instagram Stories" },
    });
    expect(result.pass).toBe(false);
    violation(result, "cannabis.ad-platform-gate");
  });

  it("warns (fails toward review) when the ad platform is unlisted or unspecified", () => {
    const unlisted = checkCompliance({
      vertical: "cannabis",
      contentType: "ad",
      content: { text: "Daily deals for adults 21 and over.", platform: "local news site" },
    });
    expect(unlisted.pass).toBe(true);
    warning(unlisted, "cannabis.ad-platform-gate");

    const unspecified = checkCompliance({
      vertical: "cannabis",
      contentType: "ad",
      content: { text: "Daily deals for adults 21 and over." },
    });
    expect(unspecified.pass).toBe(true);
    expect(warning(unspecified, "cannabis.ad-platform-gate").explanation).toMatch(/no target platform/i);
  });

  it("does not gate non-ad content types on platform", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "social_caption",
      content: { text: "Stop by the shop this weekend — adults 21 and over.", platform: "instagram" },
    });
    expectClean(result);
  });
});

describe("cannabis — jurisdiction-dependent licensing", () => {
  const text = "Order online for pickup at our dispensary.";

  it("blocks content targeting a state where the operator is not licensed", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "blog",
      content: { text, licensedStates: ["CA"] },
      jurisdiction: "ID",
    });
    const v = violation(result, "cannabis.state-licensing");
    expect(v.match).toEqual({ excerpt: "ID", index: -1 });
  });

  it("passes when the jurisdiction is licensed (state-name vs code normalization)", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "blog",
      content: { text, licensedStates: ["CA"] },
      jurisdiction: "California",
    });
    expectClean(result);
  });

  it("warns when licensing cannot be verified (no licensedStates provided)", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "blog",
      content: { text },
      jurisdiction: "CA",
    });
    expect(result.pass).toBe(true);
    expect(warning(result, "cannabis.state-licensing").explanation).toMatch(/cannot be verified/i);
  });

  it("stays silent when no jurisdiction is provided (rule is jurisdiction-scoped)", () => {
    const result = checkCompliance({ vertical: "cannabis", contentType: "blog", content: { text } });
    expectClean(result);
  });
});

describe("cannabis — clean samples", () => {
  it("passes an age-gated menu page (and mandated safety text never trips minor-appeal)", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "page",
      content: {
        text:
          "Shop our curated menu of flower, edibles, and pre-rolls. Must be 21 or older — age verification required at the door. Keep out of reach of children.",
      },
    });
    expectClean(result);
  });

  it("passes an ad on a vetted cannabis platform", () => {
    const result = checkCompliance({
      vertical: "cannabis",
      contentType: "ad",
      content: { text: "Visit our Denver dispensary for daily deals. Adults 21 and over only.", platform: "weedmaps" },
    });
    expectClean(result);
  });
});
