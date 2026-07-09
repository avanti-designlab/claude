/**
 * M4 input derivation + crawl-target resolution (doc 05 §M4) — PURE.
 *
 * The M3 → M4 seam: M3's cited-URL inventory (`CitedUrlEntry[]`, already
 * attributed against the client's named competitors) is filtered to the entries
 * where a COMPETITOR was cited, and each becomes a `CompetitorTarget`. M4 never
 * samples citations — it consumes M3's stored measurement.
 *
 * Then, before any crawl, each target's cited source is resolved to a concrete
 * http(s) crawl URL. Two refusals happen here, synchronously, with no network:
 *  - a source that is not an http(s) target and has no derivable host is
 *    `not_crawlable_url`;
 *  - a host that is a KNOWN-internal IP literal / loopback name is
 *    `blocked_address` (defense in depth — the crawler's egress guard closes the
 *    DNS-resolving case too, recording the same `blocked_address` reason).
 * Both are EXCLUSIONS, never "signal absent".
 */

import type { CitedUrlEntry } from "@/lib/intelligence/visibility";
import { hostIsBlockedLiteral } from "@/lib/intelligence/crawl";
import type { CompetitorExclusionReason, CompetitorTarget } from "./types";

/**
 * Derive M4 competitor targets from M3's cited-URL inventory. Only
 * competitor-attributed entries are taken (client / other / unattributed are
 * not competitors to reverse-engineer). Order is preserved from M3 (which is
 * itself deterministic: count desc, then url asc), so the whole pipeline is
 * deterministic.
 */
export function competitorTargetsFromCitedUrls(citedUrls: CitedUrlEntry[]): CompetitorTarget[] {
  const targets: CompetitorTarget[] = [];
  for (const entry of citedUrls) {
    if (entry.attribution !== "competitor") continue;
    targets.push({
      citedUrl: entry.url,
      domain: entry.domain,
      name: entry.competitor,
      citationCount: entry.count,
      engines: entry.engines,
    });
  }
  return targets;
}

/** Resolution of a competitor cited source to a crawl URL (or the refusal). */
export type ResolvedCrawlTarget =
  | { kind: "url"; url: string }
  | { kind: "blocked"; reason: Extract<CompetitorExclusionReason, "not_crawlable_url" | "blocked_address"> };

/**
 * Build an absolute http(s) crawl URL from a competitor target. Prefer the
 * verbatim cited URL when it is already http(s) (the exact page the engine
 * cited — the strongest evidence of WHY they win); otherwise fall back to the
 * competitor's origin (`https://<domain>`) when M3 derived a host. A source
 * that is neither is not a crawlable web target.
 */
function buildCandidateUrl(target: CompetitorTarget): string | null {
  const raw = target.citedUrl.trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (target.domain !== null && target.domain !== "") return `https://${target.domain}`;
  return null;
}

export function resolveCompetitorCrawlUrl(target: CompetitorTarget): ResolvedCrawlTarget {
  const candidate = buildCandidateUrl(target);
  if (candidate === null) return { kind: "blocked", reason: "not_crawlable_url" };
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { kind: "blocked", reason: "not_crawlable_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "blocked", reason: "not_crawlable_url" };
  }
  // Synchronous SSRF pre-check. Competitor URLs are external and
  // attacker-influenceable (a hostile answer engine, or a poisoned citation,
  // could feed an internal literal) — the same closure M2 applies to client
  // property URLs applies here. The crawler's egress guard also refuses the
  // DNS-resolving case (host resolves to an internal address) → blocked_address.
  if (hostIsBlockedLiteral(parsed.hostname)) {
    return { kind: "blocked", reason: "blocked_address" };
  }
  return { kind: "url", url: parsed.toString() };
}
