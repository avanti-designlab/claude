/**
 * Pins for the shared website-URL normalization + persistability mirror
 * (combined-remediation A1): the value SHOWN (input normalizes on blur) and
 * the value SENT (payload normalizes at send) must be byte-identical, and the
 * client gate must accept exactly what the server seam accepts.
 */

import { describe, expect, it } from "vitest";
import { sanitizePropertyUrl } from "@/lib/properties/validate";
import {
  normalizeWebsiteUrl,
  WEBSITE_URL_PROBLEM,
  websiteUrlProblem,
} from "./website-url";

describe("normalizeWebsiteUrl", () => {
  it("prefixes https:// onto scheme-less input", () => {
    expect(normalizeWebsiteUrl("mysite.com")).toBe("https://mysite.com");
    expect(normalizeWebsiteUrl("  mysite.com/path?q=1  ")).toBe(
      "https://mysite.com/path?q=1"
    );
  });

  it("is IDEMPOTENT — display-normalize then payload-normalize is a no-op (byte-identity)", () => {
    const inputs = [
      "mysite.com",
      "https://mysite.com",
      "http://mysite.com",
      "//mysite.com",
      "  spaced.example  ",
      "javascript:alert(1)",
      "",
    ];
    for (const raw of inputs) {
      const once = normalizeWebsiteUrl(raw);
      expect(normalizeWebsiteUrl(once)).toBe(once);
    }
  });

  it("leaves schemed input as typed (the problem check decides persistability)", () => {
    expect(normalizeWebsiteUrl("https://mysite.com")).toBe("https://mysite.com");
    expect(normalizeWebsiteUrl("http://mysite.com")).toBe("http://mysite.com");
    expect(normalizeWebsiteUrl("javascript:alert(1)")).toBe(
      "javascript:alert(1)"
    );
  });

  it("strips leading slashes before prefixing (protocol-relative input)", () => {
    expect(normalizeWebsiteUrl("//mysite.com")).toBe("https://mysite.com");
  });

  it("empty and whitespace-only stay empty", () => {
    expect(normalizeWebsiteUrl("")).toBe("");
    expect(normalizeWebsiteUrl("   ")).toBe("");
  });

  it("all-slashes input is returned as typed (and then fails the problem check)", () => {
    expect(normalizeWebsiteUrl("///")).toBe("///");
    expect(websiteUrlProblem(normalizeWebsiteUrl("///"))).toBe(
      WEBSITE_URL_PROBLEM
    );
  });
});

describe("websiteUrlProblem (the server-seam mirror)", () => {
  it("accepts what the server accepts — normalized everyday input passes", () => {
    for (const raw of ["mysite.com", "https://mysite.com", "sub.domain.co/p"]) {
      const normalized = normalizeWebsiteUrl(raw);
      expect(websiteUrlProblem(normalized)).toBeNull();
      // The exact server check agrees, on the exact same bytes.
      expect(sanitizePropertyUrl(normalized)).toBe(normalized);
    }
  });

  it("blocks what the server blocks — non-http(s) schemes and unparseable input", () => {
    for (const raw of [
      "javascript:alert(1)",
      "ftp://files.example",
      "https://my site.com",
      "http://",
      "///",
    ]) {
      const normalized = normalizeWebsiteUrl(raw);
      expect(websiteUrlProblem(normalized)).toBe(WEBSITE_URL_PROBLEM);
      expect(sanitizePropertyUrl(normalized)).toBeNull();
    }
  });

  it("gate and server can never disagree (property check over a spread of shapes)", () => {
    const shapes = [
      "mysite.com",
      "www.mysite.com",
      "https://ok.example/path#frag",
      "HTTPS://CAPS.EXAMPLE",
      "mailto:x@y.z",
      "data:text/html,hi",
      "a".repeat(3000) + ".com",
      "my site .com",
      "localhost:3000", // scheme-shaped ("localhost:") — stays as typed
    ];
    for (const raw of shapes) {
      const normalized = normalizeWebsiteUrl(raw);
      expect(websiteUrlProblem(normalized) === null).toBe(
        sanitizePropertyUrl(normalized) !== null
      );
    }
  });

  it("problem copy is interface voice: typographic apostrophe, names the fix", () => {
    expect(WEBSITE_URL_PROBLEM).not.toContain("'");
    expect(WEBSITE_URL_PROBLEM).toContain("https://yoursite.com");
  });
});
