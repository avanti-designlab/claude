/**
 * M12 assessEntityAuthority — the crawl → person/press → entity-schema → fixes
 * orchestrator. Reuses crawlSite (shared SSRF egress guard). Honesty-first:
 * uncrawlable is stated, never fabricated; deterministic given the same inputs.
 */

import { describe, expect, it } from "vitest";
import { ScriptedFetch, htmlResponse, textResponse } from "@/lib/write-methods/shared/http-harness";
import type { ResolvePort } from "@/lib/intelligence/crawl";
import { getPlaybook as loadPlaybook } from "@/lib/playbooks";
import { assessEntityAuthority, type AssessEntityAuthorityInput } from "./assess";

const getPlaybook = (v: Parameters<typeof loadPlaybook>[0]) => loadPlaybook(v)!;
const ORIGIN = "https://gg.test";
const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
const resolvePublic: ResolvePort = async () => [{ address: "93.184.216.34", family: 4 }];

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** A one-page site that names the founder, shows a press marker + a Forbes mention. */
function healthySite(): ScriptedFetch {
  const f = new ScriptedFetch();
  f.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, "User-agent: *\nAllow: /\n"));
  f.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "nf"));
  f.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(
      200,
      `<title>GG Realty</title><h1>GG Realty</h1><h1>Press</h1>
       <p>Daniel Reyes is the founder of GG Realty. As featured in Forbes. ${"We serve North Park. ".repeat(4)}</p>`,
    ),
  );
  return f;
}

/** robots.txt unreachable → the crawler reads zero pages (uncrawlable). */
function uncrawlableSite(): ScriptedFetch {
  const f = new ScriptedFetch();
  f.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(500, "boom"));
  f.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, ""));
  f.on("GET", exact(`${ORIGIN}/`), () => htmlResponse(200, "<h1>unused</h1>"));
  return f;
}

function assess(fetch: ScriptedFetch, over: Partial<AssessEntityAuthorityInput> = {}) {
  return assessEntityAuthority({
    fetchPort: fetch.port,
    resolvePort: resolvePublic,
    startUrl: `${ORIGIN}/`,
    playbook: getPlaybook("real-estate"),
    keyPerson: { name: "Daniel Reyes", jobTitle: "Founder", sameAsSources: { pressArticles: ["https://www.forbes.com/profile/daniel-reyes"] } },
    organization: { name: "GG Realty", url: ORIGIN },
    claimedPress: [
      { publication: "Forbes", url: "https://www.forbes.com/profile/daniel-reyes" },
      { publication: "Inman", url: "https://www.inman.com/x" },
    ],
    crawledAt: CRAWLED_AT,
    ...over,
  });
}

describe("assessEntityAuthority — healthy site", () => {
  it("assesses the person + press surface and produces ready entity schema", async () => {
    const { report, schema } = await assess(healthySite());
    expect(report.assessable).toBe(true);
    expect(report.person.status).toBe("assessed");
    expect(report.person.namePresentOnPage).toBe(true);
    expect(report.press.status).toBe("assessed");
    expect(report.press.pressSectionPresent).toBe(true);
    // Forbes corroborated on-page, Inman not.
    expect(report.press.corroboratedCount).toBe(1);
    expect(schema.person?.result.status).toBe("ready");
    expect(schema.organization?.result.status).toBe("ready");
    // Person schema's Inman sameAs is NOT flagged (not in sameAs); its uncorroborated set is empty (only Forbes supplied, corroborated).
    expect(schema.person?.uncorroboratedSameAs).toEqual([]);
  });

  it("emits M12 fixes (all module 'M12') — incl. surfacing the uncorroborated Inman claim", async () => {
    const { report } = await assess(healthySite());
    expect(report.fixes.length).toBeGreaterThan(0);
    expect(report.fixes.every((fx) => fx.module === "M12")).toBe(true);
    const corr = report.fixes.find((fx) => fx.id === "pr/press-corroborate");
    expect(corr?.detail).toContain("Inman");
  });

  it("is deterministic given the same inputs", async () => {
    const a = await assess(healthySite());
    const b = await assess(healthySite());
    expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
  });
});

describe("assessEntityAuthority — uncrawlable site (honesty)", () => {
  it("states not-assessable, withholds verdicts, and produces NO schema/fixes (never fabricated)", async () => {
    const { report, schema } = await assess(uncrawlableSite());
    expect(report.assessable).toBe(false);
    expect(report.person.status).toBe("not_assessable");
    expect(report.press.status).toBe("not_assessable");
    expect(report.fixes).toEqual([]);
    // No crawlable corpus to gate against → no honest schema attempt.
    expect(schema.person).toBeNull();
    expect(schema.organization).toBeNull();
  });
});

describe("assessEntityAuthority — no key person", () => {
  it("reports no_key_person without fabricating a person entity", async () => {
    const { report, schema } = await assess(healthySite(), { keyPerson: null });
    expect(report.person.status).toBe("no_key_person");
    expect(schema.person).toBeNull();
  });
});
