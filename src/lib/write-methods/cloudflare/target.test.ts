/**
 * Edge target grammar suite — the plan-time gate. Everything the method
 * cannot write reversibly must be rejected HERE (typed, refusal-honest),
 * before any HTTP call; and every locator the builders can produce must
 * round-trip through the parser (grammar completeness).
 */

import { describe, expect, it } from "vitest";
import type { Json } from "@/lib/types/db";
import { base64UrlEncode } from "../../../../workers/edge-autofix/src/manifest";
import { WriteMethodError, type WriteMethodErrorCode } from "../shared/errors";
import {
  assertReversibleEdgeValue,
  edgeLocators,
  parseEdgeTarget,
  ruleFor,
  ruleIdFor,
  ruleValueOf,
  validateEdgeWrite,
} from "./target";

const PAGE = "https://ggrealty.example/pricing";
const IMG_SRC = "https://cdn.example.com/photos/casa uno — exterior.jpg";

function expectRefusal(fn: () => unknown, code: WriteMethodErrorCode): WriteMethodError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(WriteMethodError);
  const error = thrown as WriteMethodError;
  expect(error.code).toBe(code);
  expect(error.method).toBe("edge_worker");
  return error;
}

describe("grammar completeness — every builder round-trips through the parser", () => {
  it("parses all five locator kinds into their rule slots", () => {
    const cases: Array<[string, string]> = [
      [edgeLocators.title(), "title@/pricing"],
      [edgeLocators.metaDescription(), "meta-description@/pricing"],
      [edgeLocators.canonical(), "canonical@/pricing"],
      [edgeLocators.jsonLd("faq"), "jsonld.faq@/pricing"],
      [
        edgeLocators.imgAlt(IMG_SRC),
        `img-alt.${base64UrlEncode(IMG_SRC)}@/pricing`,
      ],
    ];
    for (const [locator, expectedRuleId] of cases) {
      const address = parseEdgeTarget({ url: PAGE, locator });
      expect(address.path).toBe("/pricing");
      expect(address.ruleId).toBe(expectedRuleId);
      expect(ruleIdFor(address.op, address.path)).toBe(expectedRuleId);
    }
  });

  it("img.alt round-trips a unicode src through base64url", () => {
    const address = parseEdgeTarget({
      url: PAGE,
      locator: edgeLocators.imgAlt(IMG_SRC),
    });
    expect(address.op).toEqual({ kind: "img_alt", src: IMG_SRC });
  });

  it("rule value ↔ rule payload round-trips byte-exact for every kind", () => {
    const values: Array<[ReturnType<typeof parseEdgeTarget>, Json]> = [
      [parseEdgeTarget({ url: PAGE, locator: edgeLocators.title() }), "T"],
      [
        parseEdgeTarget({ url: PAGE, locator: edgeLocators.metaDescription() }),
        "D",
      ],
      [
        parseEdgeTarget({ url: PAGE, locator: edgeLocators.canonical() }),
        "https://ggrealty.example/pricing",
      ],
      [
        parseEdgeTarget({ url: PAGE, locator: edgeLocators.jsonLd("faq") }),
        { "@type": "FAQPage" },
      ],
      [parseEdgeTarget({ url: PAGE, locator: edgeLocators.imgAlt(IMG_SRC) }), "Alt"],
    ];
    for (const [address, value] of values) {
      expect(ruleValueOf(ruleFor(address.op, address.path, value))).toEqual(value);
    }
  });
});

describe("page-path derivation", () => {
  it("uses the pathname; query and fragment do not change the rule slot", () => {
    const base = parseEdgeTarget({ url: PAGE, locator: edgeLocators.title() });
    const withQuery = parseEdgeTarget({
      url: `${PAGE}?utm_source=x#faq`,
      locator: edgeLocators.title(),
    });
    expect(withQuery.ruleId).toBe(base.ruleId);
  });

  it("trailing slash is a DIFFERENT page (exact-match semantics, no guessing)", () => {
    const a = parseEdgeTarget({ url: PAGE, locator: edgeLocators.title() });
    const b = parseEdgeTarget({ url: `${PAGE}/`, locator: edgeLocators.title() });
    expect(a.ruleId).not.toBe(b.ruleId);
  });

  it("refuses an unparseable URL, userinfo, and non-http(s) schemes — never echoing the value", () => {
    for (const url of ["not a url ::", "https://user:s3cret@x.example/p", "ftp://x.example/p"]) {
      const error = expectRefusal(
        () => parseEdgeTarget({ url, locator: edgeLocators.title() }),
        "unsupported_operation",
      );
      expect(error.message).not.toContain("s3cret");
      expect(error.message).not.toContain("ftp://");
    }
  });
});

describe("unsupported operations — rejected at plan time", () => {
  const rejected = [
    undefined, // no locator at all
    "edge:", // empty op
    "edge:h1", // structural content — not an edge-rule surface
    "edge:robots", // indexing state machine — excluded by design
    "edge:replace/regex", // the whole patch class is unrepresentable
    "edge:jsonld/", // missing scriptId
    "edge:jsonld/bad/slash", // path smuggling
    "edge:jsonld/-leading-dash", // scriptId grammar
    "edge:img.alt/", // missing src
    "edge:img.alt/!!!", // not base64url
    `edge:img.alt/${base64UrlEncode("")}`, // decodes to empty
    "wp:post/1/title", // another method's grammar
  ];

  for (const locator of rejected) {
    it(`refuses ${JSON.stringify(locator)}`, () => {
      expectRefusal(
        () => parseEdgeTarget({ url: PAGE, locator }),
        "unsupported_operation",
      );
    });
  }

  it("refuses an img src that embeds credentials (userinfo) without echoing it", () => {
    const error = expectRefusal(
      () =>
        parseEdgeTarget({
          url: PAGE,
          locator: edgeLocators.imgAlt("https://user:s3cret@cdn.example/x.jpg"),
        }),
      "unsupported_operation",
    );
    expect(error.message).not.toContain("s3cret");
  });
});

describe("reversibility gate on values", () => {
  const title = () => parseEdgeTarget({ url: PAGE, locator: edgeLocators.title() });
  const jsonld = () =>
    parseEdgeTarget({ url: PAGE, locator: edgeLocators.jsonLd("faq") });
  const canonical = () =>
    parseEdgeTarget({ url: PAGE, locator: edgeLocators.canonical() });

  it("null is INSTALLABLE on both sides — rule absence round-trips on this method (the contrast with methods 1–3)", () => {
    expect(() => assertReversibleEdgeValue(title(), null, "before")).not.toThrow();
    expect(() => assertReversibleEdgeValue(title(), null, "after")).not.toThrow();
    expect(() => assertReversibleEdgeValue(jsonld(), null, "before")).not.toThrow();
  });

  it("string slots refuse non-strings; the jsonld slot refuses non-objects", () => {
    expectRefusal(() => assertReversibleEdgeValue(title(), 42, "after"), "invalid_value");
    expectRefusal(
      () => assertReversibleEdgeValue(title(), { text: "x" }, "before"),
      "invalid_value",
    );
    expectRefusal(
      () => assertReversibleEdgeValue(jsonld(), "a string", "after"),
      "invalid_value",
    );
    expectRefusal(
      () => assertReversibleEdgeValue(jsonld(), [{ "@type": "FAQPage" }], "after"),
      "invalid_value",
    );
  });

  it("canonical hrefs must be absolute http(s) without userinfo — refused without echo", () => {
    expectRefusal(
      () => assertReversibleEdgeValue(canonical(), "/relative", "after"),
      "invalid_value",
    );
    expectRefusal(
      () => assertReversibleEdgeValue(canonical(), "javascript:alert(1)", "after"),
      "invalid_value",
    );
    const error = expectRefusal(
      () =>
        assertReversibleEdgeValue(
          canonical(),
          "https://user:s3cret@ggrealty.example/pricing",
          "after",
        ),
      "invalid_value",
    );
    expect(error.message).not.toContain("s3cret");
  });

  it("validateEdgeWrite gates target + both directions in one call (the GENERATE seam)", () => {
    expect(
      validateEdgeWrite({
        target: { url: PAGE, locator: edgeLocators.title() },
        before: null,
        after: "Pricing | GG Realty",
      }).ruleId,
    ).toBe("title@/pricing");
    expectRefusal(
      () =>
        validateEdgeWrite({
          target: { url: PAGE, locator: edgeLocators.title() },
          before: null,
          after: 42,
        }),
      "invalid_value",
    );
  });
});
