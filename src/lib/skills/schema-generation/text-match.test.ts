import { describe, expect, it } from "vitest";
import { normalizeVisibleText, numericCandidates, verifyClaims } from "./text-match";
import type { ClaimSpec } from "./types";

function textClaim(value: string, severity: "error" | "warning" = "error"): ClaimSpec {
  return { path: "name", label: "Test claim", value, kind: "text", severity };
}

describe("normalizeVisibleText", () => {
  it("lowercases, collapses whitespace, and trims", () => {
    expect(normalizeVisibleText("  Baja   Fish\n\tTaco  ")).toBe("baja fish taco");
  });

  it("folds curly quotes and dashes to their plain forms", () => {
    expect(normalizeVisibleText("San Diego’s “best” taco — really")).toBe(
      "san diego's \"best\" taco - really",
    );
  });

  it("replaces non-breaking spaces and strips zero-width characters", () => {
    expect(normalizeVisibleText("Blue\u00A0Dream\u200B Flower")).toBe("blue dream flower");
  });
});

describe("numericCandidates", () => {
  it("adds the .00 rendering for integers", () => {
    expect(numericCandidates("45")).toEqual(["45", "45.00"]);
  });

  it("adds the padded two-decimal rendering for one-decimal values", () => {
    expect(numericCandidates("6.5")).toEqual(["6.5", "6.50"]);
  });

  it("adds the trimmed rendering for trailing zeros, without duplicates", () => {
    expect(numericCandidates("24.50")).toEqual(["24.50", "24.5"]);
    expect(numericCandidates("45.00")).toEqual(["45.00", "45"]);
  });

  it("keeps plain decimals as-is", () => {
    expect(numericCandidates("24.99")).toEqual(["24.99"]);
  });
});

describe("verifyClaims — text", () => {
  it("matches despite casing, curly quotes, and whitespace differences", () => {
    const { issues, correspondence } = verifyClaims(
      [textClaim("San Diego's trusted dispensary")],
      "SAN DIEGO’S TRUSTED\n DISPENSARY since 2018",
    );
    expect(issues).toHaveLength(0);
    expect(correspondence[0].matched).toBe(true);
    expect(correspondence[0].evidence).toContain("san diego's trusted dispensary");
  });

  it("reports TEXT_MISMATCH with the failing claim when text is absent", () => {
    const { issues, correspondence } = verifyClaims(
      [textClaim("Blue Dream 3.5g Flower")],
      "Sour Diesel 3.5g Flower — $24.99",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TEXT_MISMATCH");
    expect(issues[0].severity).toBe("error");
    expect(issues[0].claim).toBe("Blue Dream 3.5g Flower");
    expect(correspondence[0].matched).toBe(false);
  });

  it("carries warning severity through for warning-level claims", () => {
    const { issues } = verifyClaims([textClaim("missing description", "warning")], "other text");
    expect(issues[0].severity).toBe("warning");
  });
});

describe("verifyClaims — price/number", () => {
  const priceClaim = (value: string): ClaimSpec => ({
    path: "offers.price",
    label: "Offer price",
    value,
    kind: "price",
    severity: "error",
  });

  it("matches a price rendered with a currency symbol", () => {
    const { issues } = verifyClaims([priceClaim("24.99")], "Blue Dream — $24.99 per eighth");
    expect(issues).toHaveLength(0);
  });

  it("does not match a price embedded in a larger number", () => {
    const { issues } = verifyClaims([priceClaim("12.99")], "Bundle price $112.99 today");
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TEXT_MISMATCH");
  });

  it("does not let an integer claim match the integer part of a decimal", () => {
    const { issues } = verifyClaims([priceClaim("24")], "Special: $24.99");
    expect(issues).toHaveLength(1);
  });

  it("matches integer prices rendered with .00 and vice versa", () => {
    expect(verifyClaims([priceClaim("45")], "Total: $45.00").issues).toHaveLength(0);
    expect(verifyClaims([priceClaim("45.00")], "Total: $45 flat").issues).toHaveLength(0);
  });

  it("matches a numeric-input price (6.5) against its rendered two-decimal form ($6.50)", () => {
    expect(verifyClaims([priceClaim("6.5")], "Street corn — $6.50 each").issues).toHaveLength(0);
    expect(verifyClaims([priceClaim("6.50")], "Street corn — $6.5 each").issues).toHaveLength(0);
  });
});

describe("verifyClaims — phone", () => {
  const phoneClaim = (value: string): ClaimSpec => ({
    path: "telephone",
    label: "Business phone",
    value,
    kind: "phone",
    severity: "error",
  });

  it("matches the same digits across formatting differences", () => {
    const { issues } = verifyClaims([phoneClaim("619-555-0143")], "Call (619) 555.0143 today");
    expect(issues).toHaveLength(0);
  });

  it("falls back to the last 10 digits when the page omits the country code", () => {
    const { issues } = verifyClaims([phoneClaim("+1-619-555-0143")], "Call (619) 555-0143");
    expect(issues).toHaveLength(0);
  });

  it("flags a different phone number", () => {
    const { issues } = verifyClaims([phoneClaim("619-555-0143")], "Call (619) 555-0199");
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe("TEXT_MISMATCH");
  });
});
