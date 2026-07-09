import { describe, expect, it } from "vitest";
import { getPlaybook as loadPlaybook } from "@/lib/playbooks";

/** Seed playbooks are always present — unwrap getPlaybook's null for tests. */
const getPlaybook = (v: Parameters<typeof loadPlaybook>[0]) => loadPlaybook(v)!;
import { buildSchemaChange, localSchemaTypeFor, produceLocationSchema } from "./schema";
import type { CanonicalLocation } from "./locations";

function loc(overrides: Partial<CanonicalLocation> = {}): CanonicalLocation {
  return { index: 0, name: "North Park Realty", address: "3814 Ray St", phone: null, zip: "92104", geo: null, usable: true, ...overrides };
}

describe("localSchemaTypeFor — playbook-driven, order-respecting", () => {
  it("maps each seed vertical to the first local-business-class type in its profile", () => {
    expect(localSchemaTypeFor(getPlaybook("real-estate"))).toBe("RealEstateAgent");
    expect(localSchemaTypeFor(getPlaybook("health-life-insurance"))).toBe("InsuranceAgency");
    expect(localSchemaTypeFor(getPlaybook("cannabis"))).toBe("LocalBusiness");
    // restaurants: Restaurant needs menu (M8) → falls back to the LocalBusiness NAP base.
    expect(localSchemaTypeFor(getPlaybook("restaurants"))).toBe("LocalBusiness");
  });

  it("returns null for a playbook with no local schema type (e-commerce)", () => {
    expect(localSchemaTypeFor(getPlaybook("ecommerce"))).toBeNull();
  });
});

describe("produceLocationSchema — reuses M10's visible-text gate", () => {
  const playbook = getPlaybook("real-estate");

  it("produces a READY RealEstateAgent block when the name is shown on the page", () => {
    const out = produceLocationSchema({
      location: loc(),
      playbook,
      websiteUrl: "https://npr.test",
      visible: "Welcome to North Park Realty — San Diego's neighborhood agent.",
    });
    expect(out.schemaType).toBe("RealEstateAgent");
    expect(out.result?.status).toBe("ready");
  });

  it("REJECTS when the asserted name is absent from the visible text (fabricated NAP can't ship)", () => {
    const out = produceLocationSchema({
      location: loc(),
      playbook,
      websiteUrl: "https://npr.test",
      visible: "This page says nothing about the business name at all.",
    });
    expect(out.result?.status).toBe("rejected");
    if (out.result?.status === "rejected") {
      expect(out.result.errors.some((e) => e.code === "TEXT_MISMATCH")).toBe(true);
    }
  });

  it("skips honestly (no skill call) when the location has no canonical name", () => {
    const out = produceLocationSchema({ location: loc({ name: null }), playbook, websiteUrl: "https://x.test", visible: "x" });
    expect(out.result).toBeNull();
    expect("skipped" in out && out.skipped).toBe(true);
  });

  it("skips LocalBusiness/Store when no structured address is available (never fabricated)", () => {
    const out = produceLocationSchema({
      location: loc(),
      playbook: getPlaybook("cannabis"), // → LocalBusiness (address required)
      websiteUrl: "https://x.test",
      visible: "North Park Realty",
    });
    expect(out.result).toBeNull();
    expect("reason" in out && out.reason).toMatch(/structured address/i);
  });

  it("produces LocalBusiness when a structured address IS supplied and the name is on the page", () => {
    const out = produceLocationSchema({
      location: loc(),
      playbook: getPlaybook("cannabis"),
      websiteUrl: "https://x.test",
      visible: "North Park Realty at 3814 Ray St, San Diego CA",
      structuredAddress: { streetAddress: "3814 Ray St", addressLocality: "San Diego", addressRegion: "CA", addressCountry: "US" },
    });
    expect(out.schemaType).toBe("LocalBusiness");
    expect(out.result?.status).toBe("ready");
  });
});

describe("buildSchemaChange — ready-only change-management feed (M10 seam)", () => {
  it("shapes a ready result into a schema DesiredChange with the jsonLd as `after`", () => {
    const out = produceLocationSchema({
      location: loc(),
      playbook: getPlaybook("real-estate"),
      websiteUrl: "https://npr.test",
      visible: "North Park Realty",
    });
    expect(out.result?.status).toBe("ready");
    if (out.result?.status !== "ready") return;

    const change = buildSchemaChange(out.result, {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "p1",
      method: "wordpress",
      target: { url: "https://npr.test/", locator: "edge:jsonld/localbusiness" },
    });
    expect(change.changeType).toBe("schema");
    expect(change.source).toBe("schema:RealEstateAgent");
    expect(change.after).toEqual(out.result.jsonLd);
  });
});
