/**
 * Webflow target grammar + plan-time reversibility gate (doc 04 §2: an
 * operation that cannot be reversed byte-exact is rejected at PLAN time,
 * never discovered at rollback time).
 */

import { describe, expect, it } from "vitest";
import { WriteMethodError } from "../shared/errors";
import {
  assertReversibleWebflowValue,
  describeWebflowOperation,
  parseWebflowTarget,
  validateWebflowWrite,
  webflowLocators,
  webflowRouteFor,
} from "./target";

const url = "https://client.example.com/pricing";
const PAGE_ID = "683f07d9aa4b5c8d2e1f0a3b";
const COLLECTION_ID = "5f0a3b683f07d9aa4b5c8d2e";
const ITEM_ID = "8d2e1f0a3b683f07d9aa4b5c";

function parse(locator?: string) {
  return parseWebflowTarget({ url, locator });
}

describe("parseWebflowTarget — the supported operation set", () => {
  it("parses every locator the builders can produce (grammar round-trip)", () => {
    expect(parse(webflowLocators.pageSeoTitle(PAGE_ID))).toEqual({
      kind: "page",
      pageId: PAGE_ID,
      group: "seo",
      attr: "title",
    });
    expect(parse(webflowLocators.pageSeoDescription(PAGE_ID))).toEqual({
      kind: "page",
      pageId: PAGE_ID,
      group: "seo",
      attr: "description",
    });
    expect(parse(webflowLocators.pageOgTitle(PAGE_ID))).toEqual({
      kind: "page",
      pageId: PAGE_ID,
      group: "og",
      attr: "title",
    });
    expect(parse(webflowLocators.pageOgDescription(PAGE_ID))).toEqual({
      kind: "page",
      pageId: PAGE_ID,
      group: "og",
      attr: "description",
    });
    expect(
      parse(webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "faq-answer")),
    ).toEqual({
      kind: "item",
      collectionId: COLLECTION_ID,
      itemId: ITEM_ID,
      fieldSlug: "faq-answer",
    });
  });

  it("maps operations onto the right Data API v2 routes", () => {
    expect(webflowRouteFor(parse(`webflow:page/${PAGE_ID}/seo.title`))).toBe(
      `pages/${PAGE_ID}`,
    );
    expect(
      webflowRouteFor(
        parse(`webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/name`),
      ),
    ).toBe(`collections/${COLLECTION_ID}/items/${ITEM_ID}`);
  });

  it("describes operations in interface voice", () => {
    expect(describeWebflowOperation(parse(`webflow:page/${PAGE_ID}/seo.title`))).toBe(
      `page ${PAGE_ID} seo.title`,
    );
    expect(
      describeWebflowOperation(
        parse(`webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/summary`),
      ),
    ).toBe(`item ${COLLECTION_ID}/${ITEM_ID} field['summary']`);
  });

  const unsupported: Array<[string, string | undefined]> = [
    ["a missing locator", undefined],
    // Publish semantics: staged→live can never round-trip byte-exact.
    ["a site publish", `webflow:site/${PAGE_ID}/publish`],
    ["a live-item write", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/live`],
    // Page name/slug are not the SEO surface / are URL-changing.
    ["the page name", `webflow:page/${PAGE_ID}/title`],
    ["the page slug", `webflow:page/${PAGE_ID}/slug`],
    // The item slug field: URL-changing AND server-normalized.
    ["the item slug field", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/slug`],
    // Draft/archive flips are state transitions, not fieldData.
    ["an isDraft flip", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/isDraft`],
    // Id strictness: 24 lowercase hex, nothing else.
    ["an uppercase-hex page id", `webflow:page/${PAGE_ID.toUpperCase()}/seo.title`],
    ["a 23-char page id", `webflow:page/${PAGE_ID.slice(0, 23)}/seo.title`],
    ["a 25-char page id", `webflow:page/${PAGE_ID}0/seo.title`],
    ["a non-hex page id", "webflow:page/zzzf07d9aa4b5c8d2e1f0a3b/seo.title"],
    ["a path-traversal id", `webflow:page/../${PAGE_ID}/seo.title`],
    // Field-slug strictness: Webflow's own lowercase [a-z0-9-] shape.
    ["a field slug with a slash", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/a/b`],
    ["a field slug with spaces", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/bad key`],
    ["an uppercase field slug", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/Name`],
    ["an underscore field slug", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/_draft`],
    ["an empty field slug", `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/`],
    // Locale variants have no grammar slot — not expressible.
    ["a locale-qualified page", `webflow:page/${PAGE_ID}/fr-FR/seo.title`],
    ["a foreign grammar", "wp:post/42/title"],
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
      expect((thrown as WriteMethodError).method).toBe("webflow");
    },
  );

  it("names the slug refusal's reasons (URL-changing + server-normalized)", () => {
    let thrown: unknown;
    try {
      parse(webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "slug"));
    } catch (err) {
      thrown = err;
    }
    const error = thrown as WriteMethodError;
    expect(error.message).toContain("URL-changing");
    expect(error.message).toContain("server-normalized");
    expect(error.message).toContain("plan time");
  });
});

describe("assertReversibleWebflowValue — the byte-exactness gate on values", () => {
  const seoTitle = parse(`webflow:page/${PAGE_ID}/seo.title`);
  const itemField = parse(
    `webflow:item/${COLLECTION_ID}/${ITEM_ID}/field/faq-schema`,
  );

  it("accepts strings for page fields and any non-null JSON for item fields", () => {
    expect(() => assertReversibleWebflowValue(seoTitle, "", "after")).not.toThrow();
    expect(() =>
      assertReversibleWebflowValue(seoTitle, "A title", "before"),
    ).not.toThrow();
    expect(() =>
      assertReversibleWebflowValue(itemField, "<p>rich text</p>", "after"),
    ).not.toThrow();
    expect(() => assertReversibleWebflowValue(itemField, 3, "after")).not.toThrow();
    expect(() =>
      assertReversibleWebflowValue(itemField, true, "before"),
    ).not.toThrow();
    expect(() =>
      assertReversibleWebflowValue(itemField, ["ref-a", "ref-b"], "after"),
    ).not.toThrow();
    expect(() =>
      assertReversibleWebflowValue(itemField, { "@type": "FAQPage" }, "after"),
    ).not.toThrow();
  });

  it.each([
    ["a null page field (unset is not restorable)", seoTitle, null],
    ["a numeric page field", seoTitle, 5],
    ["an object page field", seoTitle, { text: "x" }],
    ["a null item field (clearing does not round-trip)", itemField, null],
  ] as const)("refuses %s with typed invalid_value", (_label, op, value) => {
    let thrown: unknown;
    try {
      assertReversibleWebflowValue(op, value, "before");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WriteMethodError);
    expect((thrown as WriteMethodError).code).toBe("invalid_value");
  });
});

describe("validateWebflowWrite — GENERATE-side pre-check", () => {
  it("returns the parsed operation for a fully reversible write", () => {
    expect(
      validateWebflowWrite({
        target: { url, locator: webflowLocators.pageSeoTitle(PAGE_ID) },
        before: "Old",
        after: "New",
      }),
    ).toEqual({ kind: "page", pageId: PAGE_ID, group: "seo", attr: "title" });
  });

  it("rejects a write whose BEFORE could not be restored — rollback impossibility is caught before preview", () => {
    expect(() =>
      validateWebflowWrite({
        target: { url, locator: webflowLocators.pageSeoDescription(PAGE_ID) },
        before: null, // unset description cannot be restored byte-exact
        after: "New",
      }),
    ).toThrowError(/refused before any write/);
  });

  it("rejects a write whose AFTER could not be installed", () => {
    expect(() =>
      validateWebflowWrite({
        target: {
          url,
          locator: webflowLocators.itemField(COLLECTION_ID, ITEM_ID, "summary"),
        },
        before: "x",
        after: null,
      }),
    ).toThrowError(/does not round-trip byte-exact/);
  });
});
