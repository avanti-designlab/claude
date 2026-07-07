/**
 * Health & life insurance ruleset — TCPA lead-form consent, guarantee limits,
 * Special Ad Category gate, fear-based marketing, state licensing (doc 02 §2.4).
 */

import { describe, expect, it } from "vitest";
import { checkCompliance } from "./index";
import { expectClean, expectExcerptAt, violation, warning } from "./test-helpers";

describe("health-life-insurance — TCPA required element on lead forms", () => {
  it("blocks a lead form with no TCPA consent language anywhere", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "lead_form",
      content: {
        text: "Get your free life insurance quote in minutes.",
        formFields: [
          { name: "full_name", label: "Full name", type: "text", required: true },
          { name: "phone", label: "Phone number", type: "tel", required: true },
          { name: "email", label: "Email address", type: "email" },
        ],
      },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "health-life-insurance.tcpa-consent");
    expect(v.match).toBeUndefined(); // missing element — no text span to point at
    expect(v.legalReference).toContain("227");
    expect(v.requiredFix).toMatch(/consent/i);
  });

  it("passes with consent language but warns while 'not a condition of purchase' is missing", () => {
    const consentText =
      "By submitting, you consent to receive calls and texts from Acme Insurance, including via autodialer. Msg & data rates may apply.";
    const partial = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "lead_form",
      content: { text: `Request your quote. ${consentText}` },
    });
    expect(partial.pass).toBe(true);
    expect(partial.violations).toEqual([]);
    warning(partial, "health-life-insurance.tcpa-condition-clause");

    const complete = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "lead_form",
      content: { text: `Request your quote. ${consentText} Consent is not a condition of any purchase.` },
    });
    expectClean(complete);
  });

  it("finds consent language in declared form-field labels, not just body text", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "lead_form",
      content: {
        text: "Request your personalized quote. Consent is not required to purchase.",
        formFields: [
          { name: "phone", label: "Phone number", type: "tel", required: true },
          { name: "tcpa_consent", label: "I consent to be contacted by phone or text", type: "checkbox", required: true },
        ],
      },
    });
    expectClean(result);
  });

  it("does not demand TCPA language on non-form content", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "blog",
      content: { text: "How term life premiums are set: age, health class, and coverage length." },
    });
    expectClean(result);
  });
});

describe("health-life-insurance — violating samples", () => {
  it("blocks 'guaranteed approval' and 'no one is turned down'", () => {
    const text = "Guaranteed approval for seniors: no one is turned down, regardless of health.";
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "page",
      content: { text },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "health-life-insurance.guarantee-claims");
    expectExcerptAt(v, text, "Guaranteed approval");
    expect(result.violations.filter((x) => x.ruleId === "health-life-insurance.guarantee-claims")).toHaveLength(2);
  });

  it("blocks a Meta ad without a declared Special Ad Category", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "ad",
      content: { text: "Term life coverage from $20 a month, tailored to your budget.", platform: "facebook" },
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "health-life-insurance.special-ad-category");
    expect(v.match).toEqual({ excerpt: "facebook", index: -1 });
    expect(v.requiredFix).toMatch(/special ad category/i);
  });

  it("blocks solicitation targeting a state where the producer is not licensed", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "page",
      content: { text: "Affordable term life options for Texas residents.", licensedStates: ["CA", "AZ"] },
      jurisdiction: "Texas",
    });
    expect(result.pass).toBe(false);
    const v = violation(result, "health-life-insurance.state-licensing");
    expect(v.match).toEqual({ excerpt: "Texas", index: -1 });
  });
});

describe("health-life-insurance — jurisdiction-dependent licensing", () => {
  const text = "Compare coverage options with a local agent.";

  it("passes when the target jurisdiction is licensed (name vs code normalization)", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "page",
      content: { text, licensedStates: ["TX"] },
      jurisdiction: "texas",
    });
    expectClean(result);
  });

  it("warns when licensing cannot be verified (no licensedStates provided)", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "page",
      content: { text },
      jurisdiction: "TX",
    });
    expect(result.pass).toBe(true);
    expect(warning(result, "health-life-insurance.state-licensing").explanation).toMatch(/cannot be verified/i);
  });
});

describe("health-life-insurance — warn rules and false-positive design", () => {
  it("warns — never blocks — on fear-based framing", () => {
    const text = "Don't be a burden. Without coverage, your family will suffer.";
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "social_caption",
      content: { text },
    });
    expect(result.pass).toBe(true);
    expect(result.violations).toEqual([]);
    const w = warning(result, "health-life-insurance.fear-based-marketing");
    expectExcerptAt(w, text, "Don't be a burden");
    expect(result.warnings.filter((x) => x.ruleId === "health-life-insurance.fear-based-marketing")).toHaveLength(2); // + "your family will suffer"
  });

  it("does not flag the 'guaranteed issue' product name or a 'no-risk consultation'", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "page",
      content: { text: "Ask about guaranteed issue whole life policies and book a no-risk consultation today." },
    });
    expectClean(result);
  });

  it("warns on unsubstantiated cost superlatives ('lowest rates')", () => {
    const text = "We find you the lowest rates on term life.";
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "blog",
      content: { text },
    });
    expect(result.pass).toBe(true);
    expectExcerptAt(warning(result, "health-life-insurance.superlative-cost-claims"), text, "lowest rates");
  });
});

describe("health-life-insurance — clean samples", () => {
  it("passes a Meta ad declared under the Special Ad Category", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "ad",
      content: {
        text: "Term life coverage from $20 a month, tailored to your budget.",
        platform: "facebook",
        declaredSpecialAdCategory: true,
      },
    });
    expectClean(result);
  });

  it("passes a plain educational comparison (no guarantees, no fear, no superlatives)", () => {
    const result = checkCompliance({
      vertical: "health-life-insurance",
      contentType: "blog",
      content: {
        text: "Term life lasts for a set period, while whole life builds cash value. A licensed agent can help you compare coverage that fits your budget.",
      },
    });
    expectClean(result);
  });
});
