/**
 * M6 → M1 plan-flow shape, proven through the REAL generator: synthetic crawl
 * → `assessDecay` (real engine) → `decayPlanInput` → `generatePlan` (real
 * generator, real audit-merge — nothing mocked, nothing re-implemented).
 *
 * Pins that a decayed page becomes a gap-closing roadmap task on a REAL
 * playbook channel, carrying the decay fix's impact/automation truth, via the
 * same merge M2's audit fixes use — and that a clean site adds no decay tasks.
 */

import { describe, expect, it } from "vitest";
import { generatePlan } from "@/lib/plan";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import type { CrawledPage, CrawledSite } from "@/lib/skills/aeo-audit";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import { assessDecay } from "./assess";
import { decayPlanInput, decayRefreshFixes, generatePlanWithDecay } from "./decay-to-plan";

const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
const NOW = "2026-07-09T00:00:00.000Z";
const BASE = "https://client.example";
const PLAYBOOK = SEED_PLAYBOOKS["real-estate"];
const THICK = "Substantive advisory copy answering real buyer questions in genuine detail. ".repeat(20);

function page(overrides: Partial<CrawledPage> & { url: string }): CrawledPage {
  return {
    url: overrides.url,
    title: "T",
    metaDescription: "d",
    h1s: ["H1"],
    visibleText: overrides.visibleText ?? THICK,
    jsonLdBlocks: [],
    images: [],
    internalLinks: [],
    hasVideo: false,
    hasTranscript: false,
    lastModified: "lastModified" in overrides ? overrides.lastModified! : null,
    rendersWithoutJs: true,
  };
}

function daysBefore(days: number): string {
  return new Date(Date.parse(CRAWLED_AT) - days * 86_400_000).toISOString();
}

function fullCoverage(n: number): CrawlCoverage {
  return { attempted: n, crawled: n, pages: [], robotsTxtStatus: "fetched", llmsTxtStatus: "absent", frontierTruncated: false, offOriginRefused: 0 };
}

/** A decay-rich crawl: a stale page, an age-unknown page, a future-dated page. */
function decayReport() {
  const future = new Date(Date.parse(CRAWLED_AT) + 30 * 86_400_000).toISOString();
  const site: CrawledSite = {
    baseUrl: BASE,
    crawledAt: CRAWLED_AT,
    pages: [
      page({ url: `${BASE}/stale`, lastModified: daysBefore(400) }),
      page({ url: `${BASE}/unknown`, lastModified: null }),
      page({ url: `${BASE}/future`, lastModified: future }),
      page({ url: `${BASE}/fresh`, lastModified: daysBefore(5) }),
    ],
    robotsTxt: null,
    llmsTxt: null,
  };
  return assessDecay(site, fullCoverage(4));
}

describe("decayRefreshFixes — the FixDraft projection", () => {
  it("emits refresh-queue, expose-signal, and correct-future-dated fixes with distinct decay/ ids", () => {
    const fixes = decayRefreshFixes(decayReport());
    const byId = new Map(fixes.map((f) => [f.id, f]));
    expect([...byId.keys()].sort()).toEqual([
      "decay/correct-future-dated",
      "decay/expose-last-modified",
      "decay/refresh-decayed-pages",
    ]);
    // Owning modules route the way audit-merge expects: refresh = content (M8),
    // metadata corrections = on-page (M13, re-homed to M6 by the merge).
    expect(byId.get("decay/refresh-decayed-pages")!.module).toBe("M8");
    expect(byId.get("decay/expose-last-modified")!.module).toBe("M13");
    expect(byId.get("decay/correct-future-dated")!.module).toBe("M13");
    // The refresh fix lists the stale page (worst-first); it carries the dateModified rule.
    expect(byId.get("decay/refresh-decayed-pages")!.targetUrls).toContain(`${BASE}/stale`);
    expect(byId.get("decay/refresh-decayed-pages")!.detail).toMatch(/cosmetic date-bumping is (discounted|prohibited)/i);
  });

  it("a clean site (all fresh) emits NO decay fixes", () => {
    const site: CrawledSite = {
      baseUrl: BASE,
      crawledAt: CRAWLED_AT,
      pages: [page({ url: `${BASE}/a`, lastModified: daysBefore(5) }), page({ url: `${BASE}/b`, lastModified: daysBefore(20) })],
      robotsTxt: null,
      llmsTxt: null,
    };
    expect(decayRefreshFixes(assessDecay(site, fullCoverage(2)))).toEqual([]);
  });
});

describe("decay → plan merge (real generatePlan, real audit-merge)", () => {
  it("every decay fix becomes an audit-sourced roadmap task on a real playbook channel", () => {
    const report = decayReport();
    const fixes = decayRefreshFixes(report);
    const roadmap = generatePlanWithDecay({ playbook: PLAYBOOK, now: NOW, report });

    const decayTasks = roadmap.tasks.filter((t) => t.id.startsWith("audit/decay/"));
    expect(decayTasks).toHaveLength(fixes.length);

    for (const fix of fixes) {
      const task = decayTasks.find((t) => t.id === `audit/${fix.id}`);
      expect(task).toBeDefined();
      expect(task!.source).toBe("audit"); // the roadmap's only scan-derived source term
      expect(task!.title).toBe(fix.title); // skill-shaped, verbatim — no rewrite
      expect(task!.impact).toBe(fix.impact);
      expect(task!.description).toContain(fix.impactEstimate);
      // Anchored on a REAL playbook channel (never a fabricated one).
      expect(Object.keys(PLAYBOOK.channel_weighting)).toContain(task!.channel);
      // Nothing here publishes autonomously.
      expect(task!.automationLevel).not.toBe("auto");
    }

    // The refresh work re-homes to content (M8); the metadata fixes re-home to M6.
    expect(decayTasks.find((t) => t.id === "audit/decay/refresh-decayed-pages")!.module).toBe("M8");
    expect(decayTasks.find((t) => t.id === "audit/decay/expose-last-modified")!.module).toBe("M6");
    expect(decayTasks.find((t) => t.id === "audit/decay/correct-future-dated")!.module).toBe("M6");
  });

  it("the merged roadmap is deterministic and priority-ordered", () => {
    const report = decayReport();
    const a = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: decayPlanInput(report) });
    const b = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: decayPlanInput(report) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (let i = 1; i < a.tasks.length; i += 1) {
      expect(a.tasks[i - 1].priorityScore).toBeGreaterThanOrEqual(a.tasks[i].priorityScore);
    }
  });

  it("a playbook-only plan is unchanged by the decay projection's existence", () => {
    const bare = generatePlan({ playbook: PLAYBOOK, now: NOW });
    expect(bare.tasks.every((t) => t.source === "playbook")).toBe(true);
    expect(bare.tasks.some((t) => t.id.startsWith("audit/decay/"))).toBe(false);
  });
});
