/**
 * M16 outcome-source ports: the deferred-connector contract, the fixed
 * per-source host pins, the SSRF gate, and the non-echo (credential-safety)
 * discipline shared with the write methods' refuseBaseUrl.
 */

import { describe, expect, it } from "vitest";
import {
  assertPinnedApiHost,
  InMemoryRoiSource,
  isRoiSourceError,
  resolvePinnedApiHost,
  ROI_SOURCE_API_HOSTS,
  RoiSourceError,
  type OutcomePeriod,
} from "./sources";

const PERIOD: OutcomePeriod = { start: "2026-06-01T00:00:00.000Z", end: "2026-06-29T00:00:00.000Z" };

/** A secret that might have been fat-fingered into a URL/host config. */
const SECRET = "roi-ga4-oauth-refresh-token-9aZ";
const ENCODINGS = [
  SECRET,
  encodeURIComponent(SECRET),
  Buffer.from(SECRET, "utf8").toString("base64"),
];

function expectNoLeak(message: string): void {
  for (const form of ENCODINGS) {
    expect(message).not.toContain(form);
  }
}

describe("resolvePinnedApiHost — GA4/GSC hosts are fixed, never operator-movable", () => {
  it("returns the hardcoded Google host for ga4/gsc", () => {
    expect(resolvePinnedApiHost("ga4")).toBe("analyticsdata.googleapis.com");
    expect(resolvePinnedApiHost("gsc")).toBe("searchconsole.googleapis.com");
    expect(ROI_SOURCE_API_HOSTS.ga4).toBe("analyticsdata.googleapis.com");
  });

  it("IGNORES a configured override for ga4/gsc (a vendor swap can't move GA4 off Google)", () => {
    expect(resolvePinnedApiHost("ga4", "attacker.example.com")).toBe("analyticsdata.googleapis.com");
    expect(resolvePinnedApiHost("gsc", "attacker.example.com")).toBe("searchconsole.googleapis.com");
  });

  it("requires a bare host for the vendor-agnostic sources", () => {
    expect(resolvePinnedApiHost("call_tracking", "api.callrail.com")).toBe("api.callrail.com");
    expect(resolvePinnedApiHost("crm", "API.HubSpot.com")).toBe("api.hubspot.com");
  });

  it("refuses a missing/malformed host WITHOUT echoing it (creds can hide there)", () => {
    for (const bad of ["", "https://api.callrail.com/", `https://x.com/?k=${SECRET}`, "not a host"]) {
      let caught: unknown;
      try {
        resolvePinnedApiHost("call_tracking", bad);
      } catch (err) {
        caught = err;
      }
      expect(isRoiSourceError(caught)).toBe(true);
      const error = caught as RoiSourceError;
      expect(error.code).toBe("misconfigured");
      expect(error.message).not.toContain(bad === "" ? "__unlikely_never_present__" : bad);
      expectNoLeak(error.message);
    }
  });
});

describe("assertPinnedApiHost — the SSRF gate", () => {
  const PIN = "analyticsdata.googleapis.com";

  it("accepts an https request on the pinned host", () => {
    expect(() =>
      assertPinnedApiHost(`https://${PIN}/v1beta/properties/123:runReport`, PIN, "ga4"),
    ).not.toThrow();
  });

  it("refuses an off-host target (the classic SSRF redirect)", () => {
    let caught: unknown;
    try {
      assertPinnedApiHost("https://attacker.example.com/steal", PIN, "ga4");
    } catch (err) {
      caught = err;
    }
    expect((caught as RoiSourceError).code).toBe("off_host_target");
    expectNoLeak((caught as RoiSourceError).message);
  });

  it("refuses non-https (credentials are never sent in the clear)", () => {
    expect(() => assertPinnedApiHost(`http://${PIN}/x`, PIN, "ga4")).toThrow(RoiSourceError);
    try {
      assertPinnedApiHost(`http://${PIN}/x`, PIN, "ga4");
    } catch (err) {
      expect((err as RoiSourceError).code).toBe("insecure_transport");
    }
  });

  it("refuses a URL carrying a credential in userinfo/query/fragment — and never echoes it", () => {
    const hostile = [
      `https://user:${SECRET}@${PIN}/x`,
      `https://${PIN}/x?access_token=${SECRET}`,
      `https://${PIN}/x#token=${SECRET}`,
    ];
    for (const target of hostile) {
      let caught: unknown;
      try {
        assertPinnedApiHost(target, PIN, "ga4");
      } catch (err) {
        caught = err;
      }
      expect((caught as RoiSourceError).code).toBe("credential_in_url");
      expectNoLeak((caught as RoiSourceError).message);
    }
  });

  it("refuses a non-URL target without echoing it", () => {
    let caught: unknown;
    try {
      assertPinnedApiHost(`totally not a url ${SECRET}`, PIN, "ga4");
    } catch (err) {
      caught = err;
    }
    expect((caught as RoiSourceError).code).toBe("off_host_target");
    expectNoLeak((caught as RoiSourceError).message);
  });
});

describe("InMemoryRoiSource — the connected-source test double", () => {
  it("defaults to measured-empty (a connected source with nothing to report)", async () => {
    const source = new InMemoryRoiSource("ga4");
    const result = await source.fetchOutcomes({ period: PERIOD });
    expect(result).toEqual({ source: "ga4", vendor: "in-memory", period: PERIOD, samples: [] });
    expect(source.requests).toHaveLength(1);
  });

  it("stamps source + period onto reported samples", async () => {
    const source = new InMemoryRoiSource("ga4", "ga4-data-api");
    source.report([
      { metric: "sessions", value: 1200 },
      { metric: "conversions", value: 0 }, // measured zero is real data
    ]);
    const result = await source.fetchOutcomes({ period: PERIOD });
    expect(result.vendor).toBe("ga4-data-api");
    expect(result.samples).toEqual([
      { source: "ga4", metric: "sessions", value: 1200, period: PERIOD },
      { source: "ga4", metric: "conversions", value: 0, period: PERIOD },
    ]);
  });

  it("throws a typed, retryable failure on failNext (never a raw vendor error)", async () => {
    const source = new InMemoryRoiSource("call_tracking").failNext("rate_limited");
    await expect(source.fetchOutcomes({ period: PERIOD })).rejects.toMatchObject({
      name: "RoiSourceError",
      code: "rate_limited",
      sourceId: "call_tracking",
    });
    // Fault is one-shot: the next call succeeds.
    await expect(source.fetchOutcomes({ period: PERIOD })).resolves.toMatchObject({ samples: [] });
  });
});
