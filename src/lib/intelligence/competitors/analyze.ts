/**
 * M4 competitor crawl + score (doc 05 §M4; doc 07 §1.4) — PURE of DB/wall-clock.
 *
 * For each competitor target: resolve a crawl URL → crawl it through the SHARED
 * M2 crawler (`crawlSite` — same bounded, robots-respecting, same-origin,
 * SSRF-egress-guarded crawler M2 uses; NOT forked) → score the crawl with the
 * SAME frozen aeo-audit rubric (`runAudit`). A competitor from which we could
 * read ZERO pages yields NO rubric signal and is EXCLUDED (with the honest
 * reason) — never scored as if it lacked signals.
 *
 * Determinism: targets are processed in input order; every score comes from the
 * skill; the only clock input is the crawler's wall-clock safety budget (a
 * crawl that completes within budget — the normal case — is byte-identical
 * across runs, per the M2 crawler contract).
 *
 * Bounds: competitor crawls default to a SHALLOW neighborhood of the cited page
 * (we analyze why the CITED page wins, not a full-site audit of a competitor).
 * This is deliberately conservative for the client: the client's own audit
 * (M2) crawls its site fully, so the client gets every page to demonstrate a
 * signal, and a gap is only asserted when a competitor's shallow crawl STILL
 * out-scores the client's fuller one. ⚑ Doc-silent bounds — flagged for
 * ratification with the other aeo-audit crawl thresholds (BUILD-STATE ⚑ list).
 */

import type { AuditOptions } from "@/lib/skills/aeo-audit";
import { runAudit } from "@/lib/skills/aeo-audit";
import type { Playbook } from "@/lib/types/playbook";
import type { FetchPort } from "@/lib/write-methods/shared";
import {
  crawlSite,
  type CrawlBounds,
  type CrawlCoverage,
  type ResolvePort,
} from "@/lib/intelligence/crawl";
import type { CompetitorCrawlResult, CompetitorExclusionReason, CompetitorTarget } from "./types";
import { resolveCompetitorCrawlUrl } from "./targets";

/** Shallow default competitor crawl — the cited page and its immediate links. */
export const DEFAULT_COMPETITOR_CRAWL_BOUNDS: Partial<CrawlBounds> = {
  maxPages: 8,
  maxDepth: 1,
};

export interface AnalyzeCompetitorsInput {
  fetchPort: FetchPort;
  /** Injected DNS resolver for the crawler's SSRF egress guard — REQUIRED. */
  resolvePort: ResolvePort;
  /** Competitor targets (from `competitorTargetsFromCitedUrls`). */
  targets: CompetitorTarget[];
  /** The client's loaded vertical playbook — the SAME rubric both sides score against. */
  playbook: Playbook;
  /** ISO timestamp for the crawl — caller-supplied (determinism). */
  crawledAt: string;
  /** Crawl bounds override; defaults to the shallow competitor bounds. */
  bounds?: Partial<CrawlBounds>;
  auditOptions?: AuditOptions;
}

/**
 * A crawl that read zero pages exposes WHICH refusal dominated via the first
 * (start-URL) page outcome — a blocked address, a robots block, or an ordinary
 * unreachable/error. Mapped to the coarser exclusion reason M4 reports.
 */
function exclusionReasonFromCoverage(coverage: CrawlCoverage): CompetitorExclusionReason {
  const first = coverage.pages[0];
  if (first?.reason === "blocked_address") return "blocked_address";
  if (first?.reason === "robots_disallowed" || first?.reason === "robots_unavailable") {
    return "robots_blocked";
  }
  return "unreachable";
}

export async function analyzeCompetitors(
  input: AnalyzeCompetitorsInput
): Promise<CompetitorCrawlResult[]> {
  const bounds = input.bounds ?? DEFAULT_COMPETITOR_CRAWL_BOUNDS;
  const results: CompetitorCrawlResult[] = [];

  for (const target of input.targets) {
    const resolved = resolveCompetitorCrawlUrl(target);
    if (resolved.kind === "blocked") {
      // No crawl attempted (not a web target, or a known-internal literal).
      results.push({
        target,
        crawlUrl: null,
        status: "excluded",
        audit: null,
        coverage: null,
        exclusionReason: resolved.reason,
      });
      continue;
    }

    const { site, coverage } = await crawlSite({
      fetchPort: input.fetchPort,
      resolvePort: input.resolvePort,
      startUrl: resolved.url,
      crawledAt: input.crawledAt,
      bounds,
    });

    if (coverage.crawled === 0) {
      // Zero pages read ⇒ no rubric signal ⇒ excluded from every denominator.
      results.push({
        target,
        crawlUrl: resolved.url,
        status: "excluded",
        audit: null,
        coverage,
        exclusionReason: exclusionReasonFromCoverage(coverage),
      });
      continue;
    }

    const audit = runAudit(site, input.playbook, input.auditOptions);
    results.push({
      target,
      crawlUrl: resolved.url,
      status: "scored",
      audit,
      coverage,
      exclusionReason: null,
    });
  }

  return results;
}
