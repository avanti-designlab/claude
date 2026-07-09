/**
 * M5 — per-crawler robots.txt access verdicts (doc 05 M5).
 *
 * The AUTHORITATIVE access-control mechanism AI crawlers honor is robots.txt.
 * For each monitored crawler (crawlers.ts) we ask the FROZEN aeo-audit robots
 * parser `isBotAllowed` — the single source of truth for user-agent-group
 * selection and Allow/Disallow precedence (we never re-decide that here). We
 * add only the M5 concerns the parser is not responsible for: the honest
 * mapping of an unreachable robots.txt to `unknown`, and human-readable
 * evidence.
 *
 * ── HONESTY ─────────────────────────────────────────────────────────────────
 * robots.txt UNREACHABLE (5xx/network) ⇒ every verdict is `unknown`, never
 * "allowed": we did not read the rules, so we do not assert access. robots.txt
 * ABSENT (4xx / not served) ⇒ `allowed` by omission (there is nothing to block
 * a crawler). Only a FETCHED robots.txt yields blocked/allowed from its rules.
 *
 * ── SCOPE (what M5 does NOT read here) ──────────────────────────────────────
 * Page-level `<meta name="robots">` and the `X-Robots-Tag` HTTP header are
 * additional directives an operator asked about. The reused (frozen) crawl
 * layer deliberately DISCARDS both — `extractDoc` keeps only rubric signals and
 * the crawler drops response headers — so M5 cannot see them without a
 * crawl-layer signal addition (out of scope: crawl/ is frozen). They are FLAGGED
 * for the Orchestrator, not fabricated: robots.txt is reported as the
 * authoritative verdict and meta/X-Robots-Tag are named as a bounded gap.
 */

import { isBotAllowed, parseRobotsTxt } from "@/lib/skills/aeo-audit";
import type { CrawlResult } from "@/lib/intelligence/crawl";
import { AI_CRAWLERS } from "./crawlers";
import type { CrawlerAccessVerdict } from "./types";

/** Evidence cap — bounded lists so a hostile robots.txt can't balloon a verdict. */
const MAX_EVIDENCE_PATHS = 20;

/** The paths tested per crawler: root plus every crawled page path (deduped). */
function testedPaths(crawl: CrawlResult): string[] {
  const paths = ["/"];
  const seen = new Set<string>(["/"]);
  for (const outcome of crawl.coverage.pages) {
    if (outcome.status !== "crawled") continue;
    let path: string;
    try {
      path = new URL(outcome.url).pathname || "/";
    } catch {
      continue; // a malformed stored URL is not a path we can test — skip it
    }
    if (!seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Evidence-only: the Disallow rule paths in the group that governs `botId`.
 * Mirrors the frozen parser's group-selection rule (longest user-agent prefix;
 * `*` only when no named group matches) purely to SHOW which directives apply.
 * The VERDICT is always `isBotAllowed`'s — if this ever disagreed with it, the
 * verdict (not this list) is authoritative.
 */
function governingDisallows(robotsTxt: string, botId: string): string[] {
  const groups = parseRobotsTxt(robotsTxt);
  const botLower = botId.toLowerCase();
  let best: { rules: string[]; length: number } | null = null;
  let wildcard: string[] | null = null;
  for (const group of groups) {
    const disallows = group.rules.filter((rule) => rule.type === "disallow").map((rule) => rule.path);
    for (const agent of group.userAgents) {
      if (agent === "*") {
        if (wildcard === null) wildcard = disallows;
        continue;
      }
      if (botLower.startsWith(agent) && (best === null || agent.length > best.length)) {
        best = { rules: disallows, length: agent.length };
      }
    }
  }
  return (best?.rules ?? wildcard ?? []).filter((path) => path !== "").slice(0, MAX_EVIDENCE_PATHS);
}

/**
 * Per-crawler access verdicts for a crawled property. Pure — no fetch, no
 * clock: given the same `CrawlResult` it returns byte-identical verdicts, in
 * `AI_CRAWLERS` order (determinism is a tested property).
 */
export function evaluateCrawlerAccess(crawl: CrawlResult): CrawlerAccessVerdict[] {
  const robotsTxtUrl = `${crawl.site.baseUrl}/robots.txt`;
  const status = crawl.coverage.robotsTxtStatus;
  const paths = testedPaths(crawl);
  const robotsTxt = crawl.site.robotsTxt; // null unless status === "fetched"

  return AI_CRAWLERS.map((crawler) => {
    const base = {
      botId: crawler.id,
      operator: crawler.operator,
      role: crawler.role,
      citationRelevant: crawler.citationRelevant,
      robotsTxtUrl,
      testedPaths: paths.length,
    };

    if (status === "unreachable") {
      return {
        ...base,
        access: "unknown" as const,
        source: "robots_unreachable" as const,
        blockedPaths: [],
        disallowDirectives: [],
        evidence:
          "robots.txt could not be read (server error or no response) — access is unknown, not asserted allowed.",
      };
    }
    if (status === "absent" || robotsTxt === null) {
      return {
        ...base,
        access: "allowed" as const,
        source: "no_robots_txt" as const,
        blockedPaths: [],
        disallowDirectives: [],
        evidence: "No robots.txt is served — the crawler is allowed by omission.",
      };
    }

    // status === "fetched": ask the frozen parser per tested path.
    const blockedPaths = paths.filter((path) => !isBotAllowed(robotsTxt, crawler.id, path));
    if (blockedPaths.length === 0) {
      return {
        ...base,
        access: "allowed" as const,
        source: "robots_txt" as const,
        blockedPaths: [],
        disallowDirectives: [],
        evidence: `robots.txt allows ${crawler.id} on all ${paths.length} tested path(s).`,
      };
    }
    const shown = blockedPaths.slice(0, MAX_EVIDENCE_PATHS);
    return {
      ...base,
      access: "blocked" as const,
      source: "robots_txt" as const,
      blockedPaths: shown,
      disallowDirectives: governingDisallows(robotsTxt, crawler.id),
      evidence:
        `robots.txt blocks ${crawler.id} from ${blockedPaths.length}/${paths.length} tested path(s): ` +
        `${shown.join(", ")}${blockedPaths.length > shown.length ? ", …" : ""}`,
    };
  });
}
