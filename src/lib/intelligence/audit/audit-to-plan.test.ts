/**
 * The M2 → M1 seam, proven through the REAL pipeline: scripted crawl →
 * `auditProperty` (frozen skill) → `generatePlan` with the audit attached
 * (real generator, real audit-merge — nothing mocked, nothing re-implemented).
 * Pins that a found gap becomes a gap-closing roadmap task carrying the
 * skill's impact/automation truth, per doc 02/05 and the audit-merge rules.
 */

import { describe, expect, it } from "vitest";
import { generatePlan } from "@/lib/plan";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import { auditProperty, type PropertyAuditResult } from "./engine";

const ORIGIN = "https://client.example";
const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
const NOW = "2026-07-09T00:00:00.000Z";
const PLAYBOOK = SEED_PLAYBOOKS["real-estate"];

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** Gap-rich crawl: GPTBot blocked, no llms.txt, no schema, thin on-page basics. */
async function runEngine(): Promise<PropertyAuditResult> {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, "User-agent: GPTBot\nDisallow: /\n"));
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "not found"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(
      200,
      `<title>Home</title><h1>Dubai property advisory</h1>
       <p>${"Substantive advisory copy answering real buyer questions in detail. ".repeat(4)}</p>
       <img src="/hero.jpg"><a href="/about">about</a>`,
    ),
  );
  fetchPort.on("GET", exact(`${ORIGIN}/about`), () =>
    htmlResponse(200, `<h1>About</h1><p>${"Team background and credentials. ".repeat(5)}</p><a href="/">home</a>`),
  );
  return auditProperty({ fetchPort: fetchPort.port, startUrl: ORIGIN, playbook: PLAYBOOK, crawledAt: CRAWLED_AT });
}

describe("audit → plan merge (real generatePlan, real audit-merge)", () => {
  it("every audit fix becomes an audit-sourced roadmap task with the skill's truth attached", async () => {
    const result = await runEngine();
    expect(result.audit.fixes.length).toBeGreaterThan(0);

    const roadmap = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: result.audit });
    const auditTasks = roadmap.tasks.filter((task) => task.source === "audit");

    // Real-estate's local module is ON, so no fix is gated out: 1:1 fix → task.
    expect(auditTasks).toHaveLength(result.audit.fixes.length);
    const taskById = new Map(auditTasks.map((task) => [task.id, task]));
    for (const fix of result.audit.fixes) {
      const task = taskById.get(`audit/${fix.id}`);
      expect(task).toBeDefined();
      // Title and impact come from the skill, verbatim — no invented numbers,
      // no rewritten estimates; the description carries the fix's own estimate.
      expect(task!.title).toBe(fix.title);
      expect(task!.impact).toBe(fix.impact);
      expect(task!.description).toContain(fix.impactEstimate);
      // Channel anchoring: every merged task lands on a REAL playbook channel.
      expect(Object.keys(PLAYBOOK.channel_weighting)).toContain(task!.channel);
    }
  });

  it("M13 on-page fixes are re-homed to roadmap modules; publishing fixes stay human-approved", async () => {
    const result = await runEngine();
    const roadmap = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: result.audit });

    // The robots.txt unblock fix is an M13/ai_crawler_access fix → re-homed
    // to M5 (crawler monitoring) per the audit-merge mapping.
    const unblock = roadmap.tasks.find((task) => task.id === "audit/ai_crawler_access/unblock-ai-crawlers");
    expect(unblock).toBeDefined();
    expect(unblock!.module).toBe("M5");

    // doc 03 §6: nothing that publishes may be fully autonomous.
    for (const task of roadmap.tasks.filter((t) => t.source === "audit")) {
      expect(["auto", "ai_draft_human_approve", "human_only"]).toContain(task.automationLevel);
      if (task.module === "M10") {
        expect(task.automationLevel).not.toBe("auto");
      }
    }
  });

  it("the merged roadmap stays deterministic and says the audit contributed", async () => {
    const result = await runEngine();
    const a = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: result.audit });
    const b = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: result.audit });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.summary).toMatch(/fix(es)? the audit surfaced/);
    // Ordered by priority, descending — the audit's gap-closers compete on
    // the same deterministic scale as playbook starters.
    for (let i = 1; i < a.tasks.length; i += 1) {
      expect(a.tasks[i - 1].priorityScore).toBeGreaterThanOrEqual(a.tasks[i].priorityScore);
    }
  });

  it("a playbook-only plan (no audit) is unchanged by this module's existence", async () => {
    const bare = generatePlan({ playbook: PLAYBOOK, now: NOW });
    expect(bare.tasks.every((task) => task.source === "playbook")).toBe(true);
  });
});
