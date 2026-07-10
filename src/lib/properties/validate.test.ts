import { describe, expect, it } from "vitest";
import {
  sanitizePropertyUrl,
  validatePropertyCreateInput,
  validatePropertyEditInput,
  validateWebsiteInput,
} from "./validate";

describe("sanitizePropertyUrl", () => {
  it("accepts http(s) URLs (trimmed, otherwise verbatim)", () => {
    expect(sanitizePropertyUrl("  https://site.com  ")).toBe("https://site.com");
    expect(sanitizePropertyUrl("http://a.example.com/path?q=1")).toBe(
      "http://a.example.com/path?q=1"
    );
  });

  it("refuses non-http(s), empty, non-string, and over-long", () => {
    expect(sanitizePropertyUrl("ftp://site.com")).toBeNull();
    expect(sanitizePropertyUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizePropertyUrl("not a url")).toBeNull();
    expect(sanitizePropertyUrl("")).toBeNull();
    expect(sanitizePropertyUrl(42)).toBeNull();
    expect(sanitizePropertyUrl("https://x.com/" + "a".repeat(3000))).toBeNull();
  });
});

describe("validateWebsiteInput (onboarding — soft)", () => {
  it("no url → none", () => {
    expect(validateWebsiteInput(undefined)).toEqual({ kind: "none" });
    expect(validateWebsiteInput({})).toEqual({ kind: "none" });
    expect(validateWebsiteInput({ url: "  " })).toEqual({ kind: "none" });
  });

  it("url + valid platform → ok", () => {
    expect(validateWebsiteInput({ url: "https://s.com", platform: "wordpress" })).toEqual({
      kind: "ok",
      url: "https://s.com",
      platform: "wordpress",
    });
  });

  it("url present but no/invalid platform → invalid (a website needs a platform)", () => {
    expect(validateWebsiteInput({ url: "https://s.com" })).toEqual({ kind: "invalid" });
    expect(validateWebsiteInput({ url: "https://s.com", platform: "joomla" })).toEqual({
      kind: "invalid",
    });
  });

  it("url present but malformed → invalid", () => {
    expect(validateWebsiteInput({ url: "nope", platform: "wix" })).toEqual({ kind: "invalid" });
  });
});

describe("validatePropertyCreateInput (workspace seam — hard)", () => {
  it("accepts a valid website", () => {
    expect(
      validatePropertyCreateInput({ url: "https://s.com", platform: "webflow" })
    ).toEqual({ ok: true, value: { url: "https://s.com", platform: "webflow", connectionMethod: "none" } });
  });

  it("refuses missing url / missing platform", () => {
    expect(validatePropertyCreateInput({ platform: "wix" }).ok).toBe(false);
    expect(validatePropertyCreateInput({ url: "https://s.com" }).ok).toBe(false);
  });

  it("refuses a connected-looking connection_method (only 'none' writable today)", () => {
    for (const cm of ["api", "edge_worker", "pr"]) {
      const res = validatePropertyCreateInput({ url: "https://s.com", platform: "wix", connectionMethod: cm });
      expect(res.ok, cm).toBe(false);
    }
    expect(validatePropertyCreateInput({ url: "https://s.com", platform: "wix", connectionMethod: "none" }).ok).toBe(true);
  });
});

describe("validatePropertyEditInput", () => {
  it("requires both url and platform (a website always needs a platform)", () => {
    expect(validatePropertyEditInput({ url: "https://s.com", platform: "nextjs" }).ok).toBe(true);
    expect(validatePropertyEditInput({ url: "https://s.com" }).ok).toBe(false);
    expect(validatePropertyEditInput({ platform: "nextjs" }).ok).toBe(false);
    expect(validatePropertyEditInput({}).ok).toBe(false);
  });

  it("refuses a connected-looking connection_method", () => {
    expect(
      validatePropertyEditInput({ url: "https://s.com", platform: "custom", connectionMethod: "api" }).ok
    ).toBe(false);
  });
});
