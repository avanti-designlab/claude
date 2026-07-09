/**
 * WordPress target grammar + plan-time reversibility gate (doc 04 §2: an
 * operation that cannot be reversed byte-exact is rejected at PLAN time,
 * never discovered at rollback time).
 */

import { describe, expect, it } from "vitest";
import { WriteMethodError } from "../shared/errors";
import {
  assertReversibleValue,
  describeOperation,
  parseWordPressTarget,
  restRouteFor,
  validateWordPressWrite,
  wordpressLocators,
} from "./target";

const url = "https://client.example.com/pricing";

function parse(locator?: string) {
  return parseWordPressTarget({ url, locator });
}

describe("parseWordPressTarget — the supported operation set", () => {
  it("parses every locator the builders can produce (grammar round-trip)", () => {
    expect(parse(wordpressLocators.postTitle(42))).toEqual({
      resource: "post",
      id: 42,
      field: "title",
    });
    expect(parse(wordpressLocators.postContent(42))).toEqual({
      resource: "post",
      id: 42,
      field: "content",
    });
    expect(parse(wordpressLocators.postMeta(42, "_aeo_schema_jsonld"))).toEqual({
      resource: "post",
      id: 42,
      field: "meta",
      metaKey: "_aeo_schema_jsonld",
    });
    expect(parse(wordpressLocators.pageTitle(7))).toEqual({
      resource: "page",
      id: 7,
      field: "title",
    });
    expect(parse(wordpressLocators.pageContent(7))).toEqual({
      resource: "page",
      id: 7,
      field: "content",
    });
    expect(parse(wordpressLocators.pageMeta(7, "_yoast_wpseo_metadesc"))).toEqual({
      resource: "page",
      id: 7,
      field: "meta",
      metaKey: "_yoast_wpseo_metadesc",
    });
    expect(parse(wordpressLocators.mediaAltText(55))).toEqual({
      resource: "media",
      id: 55,
      field: "alt_text",
    });
  });

  it("maps operations onto the right wp/v2 routes", () => {
    expect(restRouteFor(parse("wp:post/42/title"))).toBe("posts/42");
    expect(restRouteFor(parse("wp:page/7/content"))).toBe("pages/7");
    expect(restRouteFor(parse("wp:media/55/alt_text"))).toBe("media/55");
  });

  it("describes operations in interface voice", () => {
    expect(describeOperation(parse("wp:post/42/title"))).toBe("post 42 title");
    expect(describeOperation(parse("wp:page/7/meta/_k_1"))).toBe(
      "page 7 meta['_k_1']",
    );
    expect(describeOperation(parse("wp:media/55/alt_text"))).toBe(
      "media 55 alt_text",
    );
  });

  const unsupported: Array<[string, string | undefined]> = [
    ["a missing locator", undefined],
    ["a slug write (URL-changing)", "wp:post/42/slug"],
    ["a status transition", "wp:post/42/status"],
    ["an unknown resource", "wp:comment/42/content"],
    ["alt_text on a post", "wp:post/42/alt_text"],
    ["title on media", "wp:media/55/title"],
    ["a zero id", "wp:post/0/title"],
    ["a non-numeric id", "wp:post/abc/title"],
    ["a path-traversal id", "wp:post/1/../2/title"],
    ["a meta key with a slash", "wp:post/42/meta/a/b"],
    ["a meta key with spaces", "wp:post/42/meta/bad key"],
    ["an empty meta key", "wp:post/42/meta/"],
    ["a foreign grammar", "webflow:item/1/name"],
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
      expect((thrown as WriteMethodError).method).toBe("wordpress");
    },
  );
});

describe("assertReversibleValue — the byte-exactness gate on values", () => {
  const title = parse("wp:post/42/title");
  const meta = parse("wp:post/42/meta/_aeo_meta_description");

  it("accepts strings for title/content/alt_text and any non-null JSON for meta", () => {
    expect(() => assertReversibleValue(title, "", "after")).not.toThrow();
    expect(() => assertReversibleValue(title, "A title", "before")).not.toThrow();
    expect(() => assertReversibleValue(meta, "desc", "after")).not.toThrow();
    expect(() => assertReversibleValue(meta, 3, "after")).not.toThrow();
    expect(() =>
      assertReversibleValue(meta, { "@type": "FAQPage" }, "after"),
    ).not.toThrow();
  });

  it.each([
    ["null title (absence is not installable)", title, null],
    ["numeric title", title, 5],
    ["object content", parse("wp:post/42/content"), { html: "<p>x</p>" }],
    ["null meta (delete does not round-trip byte-exact)", meta, null],
    ["non-string alt_text", parse("wp:media/55/alt_text"), 1],
  ] as const)("refuses %s with typed invalid_value", (_label, op, value) => {
    let thrown: unknown;
    try {
      assertReversibleValue(op, value, "before");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(WriteMethodError);
    expect((thrown as WriteMethodError).code).toBe("invalid_value");
  });
});

describe("validateWordPressWrite — GENERATE-side pre-check", () => {
  it("returns the parsed operation for a fully reversible write", () => {
    expect(
      validateWordPressWrite({
        target: { url, locator: "wp:post/42/title" },
        before: "Old",
        after: "New",
      }),
    ).toEqual({ resource: "post", id: 42, field: "title" });
  });

  it("rejects a write whose BEFORE could not be restored — rollback impossibility is caught before preview", () => {
    expect(() =>
      validateWordPressWrite({
        target: { url, locator: "wp:post/42/title" },
        before: null, // absent title cannot be restored byte-exact
        after: "New",
      }),
    ).toThrowError(/refused before any write/);
  });

  it("rejects a write whose AFTER could not be installed", () => {
    expect(() =>
      validateWordPressWrite({
        target: { url, locator: "wp:post/42/meta/_k" },
        before: "x",
        after: null,
      }),
    ).toThrowError(/does not round-trip byte-exact/);
  });
});
