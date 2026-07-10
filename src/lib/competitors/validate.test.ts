import { describe, expect, it } from "vitest";
import {
  COMPETITOR_NAME_MAX,
  sanitizeCompetitorDomain,
  validateCompetitorInput,
} from "./validate";

describe("sanitizeCompetitorDomain — bare hostname grammar", () => {
  it("absent/empty → undefined (name-only competitor)", () => {
    expect(sanitizeCompetitorDomain(undefined)).toBeUndefined();
    expect(sanitizeCompetitorDomain(null)).toBeUndefined();
    expect(sanitizeCompetitorDomain("")).toBeUndefined();
    expect(sanitizeCompetitorDomain("   ")).toBeUndefined();
  });

  it("accepts a bare hostname (lowercased)", () => {
    expect(sanitizeCompetitorDomain("Competitor.com")).toBe("competitor.com");
    expect(sanitizeCompetitorDomain("sub.example.co.uk")).toBe("sub.example.co.uk");
    expect(sanitizeCompetitorDomain("example.com.")).toBe("example.com"); // trailing dot tolerated
  });

  it("extracts the hostname from a full http(s) URL", () => {
    expect(sanitizeCompetitorDomain("https://Acme.com/pricing")).toBe("acme.com");
    expect(sanitizeCompetitorDomain("http://acme.com")).toBe("acme.com");
  });

  it("refuses paths/ports/spaces/schemes-with-no-host and non-hostnames", () => {
    for (const bad of [
      "acme.com/path",
      "acme.com:8080",
      "acme com",
      "ftp://acme.com",
      "notadomain",
      "-acme.com",
      "acme-.com",
      "acme..com",
      "javascript:alert(1)",
    ]) {
      expect(sanitizeCompetitorDomain(bad), bad).toBeNull();
    }
  });

  it("non-string → null", () => {
    expect(sanitizeCompetitorDomain(123)).toBeNull();
    expect(sanitizeCompetitorDomain({})).toBeNull();
  });
});

describe("validateCompetitorInput", () => {
  it("requires a name", () => {
    expect(validateCompetitorInput({ name: "" }).ok).toBe(false);
    expect(validateCompetitorInput({ name: "   " }).ok).toBe(false);
    expect(validateCompetitorInput({}).ok).toBe(false);
  });

  it("caps the name at the CHECK length", () => {
    expect(validateCompetitorInput({ name: "x".repeat(COMPETITOR_NAME_MAX) }).ok).toBe(true);
    expect(validateCompetitorInput({ name: "x".repeat(COMPETITOR_NAME_MAX + 1) }).ok).toBe(false);
  });

  it("trims the name and normalizes an absent domain to null", () => {
    const res = validateCompetitorInput({ name: "  Rival Co  " });
    expect(res).toEqual({ ok: true, value: { name: "Rival Co", domain: null } });
  });

  it("carries a valid domain, refuses an invalid one", () => {
    expect(validateCompetitorInput({ name: "R", domain: "rival.com" })).toEqual({
      ok: true,
      value: { name: "R", domain: "rival.com" },
    });
    expect(validateCompetitorInput({ name: "R", domain: "not a domain" }).ok).toBe(false);
  });
});
