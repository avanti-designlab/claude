/**
 * M2 Audit Engine — crawl + score (doc 05 M2, doc 07 §1.4).
 *
 * `auditProperty` is the M2 core: crawl a property over the injected
 * FetchPort → hand the crawl output (already the skill's `CrawledSite` input
 * shape) to the FROZEN aeo-audit skill (`runAudit`, 0.2-gated) → return the
 * skill's scored, prioritized result UNTOUCHED plus the crawl-coverage
 * honesty record.
 *
 * Honesty rules enforced at this seam:
 *  - Every score, impact estimate, and priority comes from the skill's
 *    rubric — this module invents NO numbers and rewrites NO fix text.
 *  - `coverage` states per-page what was uncrawlable (robots-blocked, fetch
 *    failed, oversized …) so a partial crawl can never masquerade as a full
 *    audit. Callers must surface it (the server action persists it inside
 *    `audits.score` and refuses to store a zero-page audit at all).
 *
 * Determinism: given the same FetchPort responses and the same `crawledAt`,
 * the whole run — crawl order, extraction, scores, fix priorities — is
 * byte-identical. No wall-clock, no randomness (pinned by test).
 */

import type {
  AuditOptions,
  AuditResult,
  CanonicalEntity,
  CrawledSite,
} from "@/lib/skills/aeo-audit";
import { runAudit } from "@/lib/skills/aeo-audit";
import type { Playbook } from "@/lib/types/playbook";
import type { FetchPort } from "@/lib/write-methods/shared";
import { crawlSite, type CrawlBounds, type CrawlCoverage } from "@/lib/intelligence/crawl";

export interface PropertyAuditInput {
  fetchPort: FetchPort;
  /** Absolute http(s) URL of the property (callers validate before invoking). */
  startUrl: string;
  /** The client's loaded vertical playbook — the rubric weights follow it. */
  playbook: Playbook;
  /** ISO timestamp for the crawl — caller-supplied (determinism). */
  crawledAt: string;
  /**
   * Canonical business entity for the entity-consistency check (typically the
   * operator-entered client record). Optional — absent, the skill derives the
   * majority on-site name per its own contract.
   */
  entity?: CanonicalEntity;
  bounds?: Partial<CrawlBounds>;
  auditOptions?: AuditOptions;
}

export interface PropertyAuditResult {
  /** The skill's output, verbatim — scores, evidence, prioritized fixes. */
  audit: AuditResult;
  /** Per-page crawl honesty — what the audit is (and is not) based on. */
  coverage: CrawlCoverage;
  /** The exact site the skill scored (evidence trail for callers/tests). */
  site: CrawledSite;
}

export async function auditProperty(input: PropertyAuditInput): Promise<PropertyAuditResult> {
  const { site, coverage } = await crawlSite({
    fetchPort: input.fetchPort,
    startUrl: input.startUrl,
    crawledAt: input.crawledAt,
    bounds: input.bounds,
  });
  // GBP / NAP / review / CWV inputs are M14/M15/M17 connector data — not
  // supplied here, so the skill records them as data gaps (skipped, never
  // silently failed). They join the site when those connectors land (1.6+).
  const scoredSite: CrawledSite = input.entity === undefined ? site : { ...site, entity: input.entity };
  const audit = runAudit(scoredSite, input.playbook, input.auditOptions);
  return { audit, coverage, site: scoredSite };
}
