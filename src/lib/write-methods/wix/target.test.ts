/**
 * Wix target grammar + plan-time reversibility gate (doc 04 §2: an operation
 * that cannot be reversed byte-exact is rejected at PLAN time, never
 * discovered at rollback time). Wix-specific lines pinned here: the
 * underscore system-field class is structurally unwritable, app-namespaced
 * collections are structurally unrepresentable, and null values are refused
 * on both surfaces (unset-inherits pages; absent-vs-explicit-null items).
 */

import { describe, expect, it } from "vitest";
import { WriteMethodError } from "../shared/errors";
import {
  assertReversibleWixValue,
  describeWixOperation,
  parseWixTarget,
  validateWixWrite,
  wixLocators,
} from "./target";

const url = "https://client.example.com/pricing";
const PAGE_ID = "c1dmp";
const COLLECTION_ID = "Listings";
const ITEM_ID = "8d2e1f0a-3b68-4f07-9aa4-b5c8d2e1f0a3";

function parse(locator?: string) {
  return parseWixTarget({ url, locator });
}

describe("parseWixTarget — the supported operation set", () => {
  it("parses every locator the builders can produce (grammar round-trip)", () => {
    expect(parse(wixLocators.pageSeoTitle(PAGE_ID))).toEqual({
      kind: "page",
      pageId: PAGE_ID,
      attr: "title",
    });
    expect(parse(wixLocators.pageSeoDescription(PAGE_ID))).toEqual({
      kind: "page",
      pageId: PAGE_ID,
      attr: "description",
    });
    expect(
      parse(wixLocators.dataField(COLLECTION_ID, ITEM_ID, "faqSchema")),
    ).toEqual({
      kind: "data",
      collectionId: COLLECTION_ID,
      itemId: ITEM_ID,
      fieldKey: "faqSchema",
    });
    // Item ids cover Wix's GUID default AND safe custom ids.
    expect(
      parse(wixLocators.dataField(COLLECTION_ID, "custom-item-7", "summary")),
    ).toEqual({
      kind: "data",
      collectionId: COLLECTION_ID,
      itemId: "custom-item-7",
      fieldKey: "summary",
    });
  });

  it("describes operations in interface voice", () => {
    expect(describeWixOperation(parse(`wix:page/${PAGE_ID}/seo.title`))).toBe(
      `page ${PAGE_ID} seo.title`,
    );
    expect(
      describeWixOperation(
        parse(`wix:data/${COLLECTION_ID}/${ITEM_ID}/field/summary`),
      ),
    ).toBe(`item ${COLLECTION_ID}/${ITEM_ID} field['summary']`);
  });

  const unsupported: Array<[string, string | undefined]> = [
    ["a missing locator", undefined],
    // THE SYSTEM-FIELD CLASS: no underscore-prefixed key is expressible —
    // including system fields Wix has not invented yet.
    ["the _id system field", `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_id`],
    ["the _owner system field", `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_owner`],
    [
      "the _updatedDate system field",
      `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_updatedDate`,
    ],
    [
      "the _createdDate system field",
      `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_createdDate`,
    ],
    [
      "a future underscore field",
      `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_anythingWixAddsNext`,
    ],
    // APP COLLECTIONS: the slash namespace is structurally unrepresentable.
    ["an app collection (Stores)", `wix:data/Stores/Products/${ITEM_ID}/field/price`],
    [
      "an app collection (Members)",
      `wix:data/Members/PrivateMembersData/${ITEM_ID}/field/name`,
    ],
    // Page operations outside the SEO fields.
    ["a page rename", `wix:page/${PAGE_ID}/name`],
    ["a page uri change", `wix:page/${PAGE_ID}/uri`],
    ["a noIndex flip", `wix:page/${PAGE_ID}/seo.noIndex`],
    ["the structured-data tag list", `wix:page/${PAGE_ID}/seo.tags`],
    // Id/key strictness: no traversal, no smuggled segments, no empty parts.
    ["a path-traversal page id", "wix:page/../c1dmp/seo.title"],
    ["a path-traversal item id", `wix:data/${COLLECTION_ID}/../evil/field/summary`],
    ["a field key with a slash", `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/a/b`],
    ["a field key with a dot", `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/a.b`],
    ["a field key with spaces", `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/bad key`],
    ["a field key with a hyphen", `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/faq-schema`],
    ["an empty field key", `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/`],
    // Fail-closed grammar probes: lookalike/encoded system-field spellings
    // must be as unwritable as the real thing. The grammar's ASCII character
    // classes admit none of them — a fullwidth underscore (U+FF3F) is not
    // [A-Za-z0-9_], `_ID` starts with the forbidden underscore like any
    // case-variant, and `%` (percent-encoding) is outside every class, so
    // nothing can smuggle a system field past the plan-time gate.
    [
      "a fullwidth-underscore (U+FF3F) system-field lookalike",
      `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/＿id`,
    ],
    [
      "a mixed-case _ID system-field spelling",
      `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_ID`,
    ],
    [
      "a percent-encoded %5Fid system-field spelling",
      `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/%5Fid`,
    ],
    ["a digit-led collection id", `wix:data/1Listings/${ITEM_ID}/field/summary`],
    ["an empty page id", "wix:page//seo.title"],
    ["a foreign grammar", "webflow:page/683f07d9aa4b5c8d2e1f0a3b/seo.title"],
    ["another foreign grammar", "wp:post/42/title"],
  ];

  it.each(unsupported)(
    "refuses %s at plan time (typed unsupported_operation)",
    (_label, locator) => {
      let thrown: unknown;
      try {
        parse(locator);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(WriteMethodError);
      expect((thrown as WriteMethodError).code).toBe("unsupported_operation");
      expect((thrown as WriteMethodError).method).toBe("wix");
    },
  );

  it("names the refusal's Wix-specific reasons (system fields + app collections)", () => {
    let thrown: unknown;
    try {
      parse(`wix:data/${COLLECTION_ID}/${ITEM_ID}/field/_owner`);
    } catch (err) {
      thrown = err;
    }
    const error = thrown as WriteMethodError;
    expect(error.message).toContain("system fields are not writable");
    expect(error.message).toContain("app collections are not writable");
    expect(error.message).toContain("plan time");
  });
});

describe("assertReversibleWixValue — the byte-exactness gate on values", () => {
  const seoTitle = parse(`wix:page/${PAGE_ID}/seo.title`);
  const dataField = parse(
    `wix:data/${COLLECTION_ID}/${ITEM_ID}/field/faqSchema`,
  );

  it("accepts strings for page fields and any non-null JSON for data fields", () => {
    expect(() => assertReversibleWixValue(seoTitle, "", "after")).not.toThrow();
    expect(() =>
      assertReversibleWixValue(seoTitle, "A title", "before"),
    ).not.toThrow();
    expect(() =>
      assertReversibleWixValue(dataField, "<p>rich text</p>", "after"),
    ).not.toThrow();
    expect(() => assertReversibleWixValue(dataField, 3, "after")).not.toThrow();
    expect(() =>
      assertReversibleWixValue(dataField, true, "before"),
    ).not.toThrow();
    expect(() =>
      assertReversibleWixValue(dataField, ["a", "b"], "after"),
    ).not.toThrow();
    expect(() =>
      assertReversibleWixValue(dataField, { "@type": "FAQPage" }, "after"),
    ).not.toThrow();
  });

  it.each([
    ["a null page field (unset inherits the SEO pattern)", seoTitle, null],
    ["a numeric page field", seoTitle, 5],
    ["an object page field", seoTitle, { text: "x" }],
    ["a null data field (ambiguous with absent — unverifiable)", dataField, null],
  ] as const)("refuses %s with typed invalid_value", (_label, op, value) => {
    let thrown: unknown;
    try {
      assertReversibleWixValue(op, value, "before");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WriteMethodError);
    expect((thrown as WriteMethodError).code).toBe("invalid_value");
  });

  it("names the derived-value reason on an unset page field", () => {
    let thrown: unknown;
    try {
      assertReversibleWixValue(seoTitle, null, "live");
    } catch (err) {
      thrown = err;
    }
    const error = thrown as WriteMethodError;
    expect(error.message).toContain("inherits the site's SEO pattern");
    expect(error.message).toContain("refused before any write");
  });
});

describe("validateWixWrite — GENERATE-side pre-check", () => {
  it("returns the parsed operation for a fully reversible write", () => {
    expect(
      validateWixWrite({
        target: { url, locator: wixLocators.pageSeoTitle(PAGE_ID) },
        before: "Old",
        after: "New",
      }),
    ).toEqual({ kind: "page", pageId: PAGE_ID, attr: "title" });
  });

  it("rejects a write whose BEFORE could not be restored — rollback impossibility is caught before preview", () => {
    expect(() =>
      validateWixWrite({
        target: { url, locator: wixLocators.pageSeoDescription(PAGE_ID) },
        before: null, // unset description inherits the pattern — not restorable
        after: "New",
      }),
    ).toThrowError(/refused before any write/);
  });

  it("rejects a write whose AFTER could not be installed", () => {
    expect(() =>
      validateWixWrite({
        target: {
          url,
          locator: wixLocators.dataField(COLLECTION_ID, ITEM_ID, "summary"),
        },
        before: "x",
        after: null,
      }),
    ).toThrowError(/refused before any write/);
  });
});
