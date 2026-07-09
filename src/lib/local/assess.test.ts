import { describe, expect, it } from "vitest";
import { ScriptedFetch, htmlResponse, textResponse } from "@/lib/write-methods/shared/http-harness";
import type { ResolvePort } from "@/lib/intelligence/crawl";
import { getPlaybook as loadPlaybook } from "@/lib/playbooks";

/** Seed playbooks are always present — unwrap getPlaybook's null for tests. */
const getPlaybook = (v: Parameters<typeof loadPlaybook>[0]) => loadPlaybook(v)!;
import type { ClientLocation } from "@/lib/types/db";
import { assessClientLocal } from "./assess";
import { InMemoryGbpDataProvider, NotConnectedGbpProvider, type GbpDataProvider } from "./gbp-provider";
import type { GbpProfileInput } from "@/lib/skills/aeo-audit";

const ORIGIN = "https://npr.test";
const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
const resolvePublic: ResolvePort = async () => [{ address: "93.184.216.34", family: 4 }];

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** A one-page site that shows the location's name + address in visible text. */
function healthySite(): ScriptedFetch {
  const f = new ScriptedFetch();
  f.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, "User-agent: *\nAllow: /\n"));
  f.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "not found"));
  f.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(
      200,
      `<title>North Park Realty</title><h1>North Park Realty</h1>
       <p>${"Your neighborhood agent at 3814 Ray St, San Diego. ".repeat(3)}</p>`,
    ),
  );
  return f;
}

/** A site whose robots.txt is unreachable → the crawler reads zero pages (uncrawlable). */
function uncrawlableSite(): ScriptedFetch {
  const f = new ScriptedFetch();
  f.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(500, "boom"));
  f.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, ""));
  f.on("GET", exact(`${ORIGIN}/`), () => htmlResponse(200, "<h1>unused</h1>"));
  return f;
}

const REALTY: ClientLocation = { name: "North Park Realty", address: "3814 Ray St, San Diego, CA 92104" };
const OTHER: ClientLocation = { name: "Ocean Beach Office", address: "5000 Beach Ave, San Diego, CA 92107" };

function assess(overrides: {
  fetchPort: ScriptedFetch;
  locations: ClientLocation[];
  gbpProvider?: GbpDataProvider;
  playbook?: ReturnType<typeof getPlaybook>;
}) {
  return assessClientLocal({
    fetchPort: overrides.fetchPort.port,
    resolvePort: resolvePublic,
    startUrl: `${ORIGIN}/`,
    playbook: overrides.playbook ?? getPlaybook("real-estate"),
    locations: overrides.locations,
    gbpProvider: overrides.gbpProvider ?? new NotConnectedGbpProvider(),
    crawledAt: CRAWLED_AT,
  });
}

describe("assessClientLocal — OFF playbook", () => {
  it("returns an explicit empty report (active:false), never a fabricated score", async () => {
    const report = await assess({ fetchPort: healthySite(), locations: [REALTY], playbook: getPlaybook("ecommerce") });
    expect(report.active).toBe(false);
    expect(report.intensity).toBe("off");
    expect(report.locations).toEqual([]);
    expect(report.coverage).toBeNull();
  });
});

describe("assessClientLocal — multi-location honesty", () => {
  it("N locations → N per-location assessments", async () => {
    const report = await assess({ fetchPort: healthySite(), locations: [REALTY, OTHER] });
    expect(report.locations).toHaveLength(2);
    expect(report.locations.map((l) => l.locationIndex)).toEqual([0, 1]);
  });

  it("an unusable location record is insufficient_canonical — never scored", async () => {
    const report = await assess({ fetchPort: healthySite(), locations: [REALTY, { name: "", address: "" }] });
    const bad = report.locations[1];
    expect(bad.status).toBe("insufficient_canonical");
    expect(bad.gbp.status).toBe("not_connected");
    expect(bad.localPack.readiness).toBe("not_assessable");
  });

  it("an uncrawlable site → on-site NAP not assessable (never a fabricated verdict)", async () => {
    const report = await assess({ fetchPort: uncrawlableSite(), locations: [REALTY] });
    expect(report.coverage!.crawled).toBe(0);
    const loc = report.locations[0];
    expect(loc.nap.assessable).toBe(false);
    expect(loc.notes.some((n) => /no crawlable pages/i.test(n))).toBe(true);
  });

  it("uncrawlable site + no GBP connection → no_data (neither source produced a signal)", async () => {
    const report = await assess({ fetchPort: uncrawlableSite(), locations: [REALTY] });
    const loc = report.locations[0];
    expect(loc.status).toBe("no_data");
    expect(loc.notes.some((n) => /not scored/i.test(n))).toBe(true);
  });
});

const GBP_PROFILE: GbpProfileInput = {
  locationName: "North Park Realty",
  primaryCategory: "Real estate agency",
  description: "Agents.",
  phone: "619-555-0143",
  address: "3814 Ray St",
  websiteUrl: ORIGIN,
  hoursComplete: true,
  photoCount: 10,
  attributesComplete: true,
  postsLast30Days: 2,
};

describe("assessClientLocal — GBP provider honesty", () => {
  it("not connected → gbp.status not_connected (score null, not zero)", async () => {
    const report = await assess({ fetchPort: healthySite(), locations: [REALTY] });
    expect(report.locations[0].gbp.status).toBe("not_connected");
    expect(report.locations[0].gbp.completenessScore).toBeNull();
  });

  it("a connected profile is scored via the skill; the location is assessed", async () => {
    const gbp = new InMemoryGbpDataProvider().script("North Park Realty", { connected: true, profile: GBP_PROFILE });
    const report = await assess({ fetchPort: healthySite(), locations: [REALTY], gbpProvider: gbp });
    const loc = report.locations[0];
    expect(loc.status).toBe("assessed");
    expect(loc.gbp.status).toBe("connected");
    expect(loc.gbp.completenessScore).toBe(100);
  });

  it("a THROWING GBP provider degrades to honest not-connected — assess never throws", async () => {
    const gbp = new InMemoryGbpDataProvider().failNext(new Error("vendor down"));
    const report = await assess({ fetchPort: healthySite(), locations: [REALTY], gbpProvider: gbp });
    const loc = report.locations[0];
    expect(loc.gbp.status).toBe("not_connected");
    expect(loc.notes.some((n) => /GBP lookup failed/i.test(n))).toBe(true);
    // Site was crawlable, so the location is still assessed on the on-site half.
    expect(loc.status).toBe("assessed");
  });
});

describe("assessClientLocal — determinism", () => {
  it("byte-identical reports across repeated runs on the same inputs", async () => {
    const a = await assess({ fetchPort: healthySite(), locations: [REALTY, OTHER] });
    const b = await assess({ fetchPort: healthySite(), locations: [REALTY, OTHER] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
