/**
 * M2 engine suite: `auditProperty` = crawl (scripted, zero network) + the
 * REAL frozen aeo-audit skill. Pins the two properties the engine exists for:
 * determinism (same responses + same crawledAt → byte-identical result) and
 * honesty (skill output verbatim; per-page coverage says what was uncrawlable;
 * the skill only ever scores pages that were actually read).
 */

import { describe, expect, it } from "vitest";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import { auditProperty } from "./engine";

const ORIGIN = "https://client.example";
const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
const PLAYBOOK = SEED_PLAYBOOKS["real-estate"];

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/**
 * A gap-rich but crawlable site: GPTBot blocked (rubric check 5 finding, while
 * AEO-AuditBot itself stays allowed), /private blocked for our bot, no
 * llms.txt, home + about pages with thin schema.
 */
function scriptGapSite(): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () =>
    textResponse(200, "User-agent: GPTBot\nDisallow: /\n\nUser-agent: AEO-AuditBot\nDisallow: /private\n"),
  );
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "not found"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(
      200,
      `<title>Gable &amp; Grove Realty</title><h1>Dubai property advisory</h1>
       <p>${"Substantive advisory copy answering real buyer questions in detail. ".repeat(4)}</p>
       <a href="/about">about</a><a href="/private">private</a>`,
    ),
  );
  fetchPort.on("GET", exact(`${ORIGIN}/about`), () =>
    htmlResponse(
      200,
      `<title>About</title><h1>About</h1>
       <p>${"Team background, credentials, and service scope in plain language. ".repeat(4)}</p>
       <a href="/">home</a>`,
    ),
  );
  return fetchPort;
}

describe("auditProperty — the M2 wrap around the frozen skill", () => {
  it("feeds the crawl output to the skill and returns its scored result verbatim", async () => {
    const { audit, coverage, site } = await auditProperty({
      fetchPort: scriptGapSite().port,
      startUrl: ORIGIN,
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
    });

    // Deterministic time anchor: the skill scored against OUR crawledAt.
    expect(audit.crawledAt).toBe(CRAWLED_AT);
    expect(audit.playbookVertical).toBe("real-estate");
    expect(Number.isFinite(audit.overallScore)).toBe(true);
    expect(audit.checks).toHaveLength(13);

    // Real crawl gaps became real rubric fixes — impact text and priority all
    // authored by the skill, none of it invented here.
    const fixIds = audit.fixes.map((fix) => fix.id);
    expect(fixIds).toContain("ai_crawler_access/unblock-ai-crawlers"); // GPTBot blocked in robots.txt
    expect(fixIds).toContain("llms_txt/create"); // no llms.txt served
    for (const fix of audit.fixes) {
      expect(fix.impactEstimate).not.toBe("");
      expect(Number.isFinite(fix.priorityScore)).toBe(true);
    }

    // Coverage honesty: the robots-blocked page is REPORTED, and the skill
    // never saw it as page data.
    const blocked = coverage.pages.find((p) => p.url === `${ORIGIN}/private`);
    expect(blocked).toMatchObject({ status: "failed", reason: "robots_disallowed" });
    expect(site.pages.map((p) => p.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/about`]);
    expect(coverage.crawled).toBe(2);
  });

  it("passes the caller's canonical entity through to the skill's input", async () => {
    const entity = { name: "Gable & Grove Realty" };
    const { site } = await auditProperty({
      fetchPort: scriptGapSite().port,
      startUrl: ORIGIN,
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
      entity,
    });
    expect(site.entity).toEqual(entity);
  });

  it("is deterministic end-to-end: two runs over identical responses are byte-identical", async () => {
    const run = () =>
      auditProperty({
        fetchPort: scriptGapSite().port,
        startUrl: ORIGIN,
        playbook: PLAYBOOK,
        crawledAt: CRAWLED_AT,
      });
    const [a, b] = [await run(), await run()];
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("an uncrawlable site yields zero scored pages and a coverage record that says why", async () => {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(503, "boom"));
    fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(503, "boom"));
    const { coverage, site } = await auditProperty({
      fetchPort: fetchPort.port,
      startUrl: ORIGIN,
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
    });
    expect(coverage.crawled).toBe(0);
    expect(coverage.pages.every((p) => p.status === "failed" && p.reason === "robots_unavailable")).toBe(true);
    expect(site.pages).toEqual([]);
    // The engine still returns deterministically — the caller (server action)
    // owns the refuse-to-persist decision, pinned in actions.test.ts.
  });
});
