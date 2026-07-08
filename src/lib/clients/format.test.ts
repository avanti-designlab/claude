import { describe, expect, it } from "vitest";

import {
  suggestClientName,
  toClientLocations,
  verticalLabel,
} from "./format";

describe("toClientLocations", () => {
  it("maps non-empty values to {name, address} and drops blanks", () => {
    expect(
      toClientLocations(["Austin, TX", "  ", "78704", ""])
    ).toEqual([
      { name: "Austin, TX", address: "Austin, TX" },
      { name: "78704", address: "78704" },
    ]);
  });

  it("returns an empty array when nothing is entered", () => {
    expect(toClientLocations(["", "   "])).toEqual([]);
  });
});

describe("suggestClientName", () => {
  it("prefers the first property's www-stripped hostname", () => {
    expect(
      suggestClientName(["Austin"], ["https://www.gableandgrove.com/agents"])
    ).toBe("gableandgrove.com");
  });

  it("tolerates a scheme-less URL", () => {
    expect(suggestClientName([], ["gableandgrove.com"])).toBe(
      "gableandgrove.com"
    );
  });

  it("falls back to the first location when no usable URL", () => {
    expect(suggestClientName(["Austin, TX"], ["   "])).toBe("Austin, TX");
  });

  it("returns empty string when there is nothing to suggest", () => {
    expect(suggestClientName([], [])).toBe("");
  });
});

describe("verticalLabel", () => {
  it("humanizes a slug", () => {
    expect(verticalLabel("real-estate")).toBe("Real estate");
    expect(verticalLabel("health-life-insurance")).toBe(
      "Health life insurance"
    );
  });

  it("passes a single word through, capitalized", () => {
    expect(verticalLabel("ecommerce")).toBe("Ecommerce");
  });
});
