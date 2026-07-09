/**
 * M3 Visibility Tracker — pure per-run metrics (doc 05 §M3; doc 00 §M19).
 *
 * Computes, from measured samples ONLY: the Visibility Score, the per-engine
 * breakdown, share of voice vs named competitors, and the cited-URL inventory
 * (M4's input). Pure and deterministic — no I/O, no wall-clock; the sampler
 * (sampler.ts) owns the provider I/O, the reads (reads.ts) recompute these
 * exact functions over stored history.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ⚑ OPERATOR RATIFICATION REQUIRED — THE SCORE FORMULA IS NOT SPEC'D.
 * Docs 00/02/05/06 define WHAT the Visibility Score is for (the dashboard's
 * signature number, trend line over runs) but are SILENT on the math. The
 * formula below is a 1.4 engineering choice — defensible and documented, not
 * doctrine. Ratify or replace it before client-facing launch; changing it
 * later re-scales the trend line, so decide early.
 *
 * THE FORMULA (score 0–100, one decimal):
 *   score = 100 × mean(credit) over MEASURED samples, where per sample
 *     credit = 0                    when not cited   ("measured, invisible")
 *     credit = 0.5 + 0.5/position   when cited with a valid position ≥ 1
 *     credit = 0.5                  when cited, position unknown
 *
 * Why this shape:
 *  - Being cited AT ALL earns half credit — presence in the answer is the
 *    product's core promise; position refines, it doesn't gatekeep.
 *  - Position credit is reciprocal (1st → 1.0, 2nd → 0.75, 3rd → ~0.67…),
 *    the standard reciprocal-rank treatment; as position → ∞ credit → 0.5,
 *    so an unknown position (vendor didn't say) is scored as "cited, deep" —
 *    conservative, never an extrapolation upward.
 *  - Every measured sample weighs the SAME (no prompt-priority weighting).
 *    Deliberate: the frozen `visibility_results` schema stores no weights, so
 *    an equal-weight score is exactly recomputable from stored history
 *    forever — across playbook edits and vendor swaps. Priority still drives
 *    derivation order/truncation (derive.ts), just not the score.
 *  - A run with ZERO measured samples has score null — measured-nothing is
 *    NOT 0; 0 means "measured, never cited" (doc 05: no invented zeros).
 * ────────────────────────────────────────────────────────────────────────
 *
 * Share of voice: attribution per measured sample — `cited === true` → the
 * client (that column IS client attribution, doc 04 §7); otherwise the
 * `cited_source` domain is matched against each named competitor's domains
 * (first match in caller order wins); an unmatched source counts as "other";
 * no source at all is "unattributed". Shares are citations / measured, so
 * they are comparable across entities and never invented when nobody won.
 */

import { VISIBILITY_ENGINES, type VisibilityEngine } from "@/lib/types/db";

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/**
 * One measured (query × engine) observation. Exactly the fields the frozen
 * `visibility_results` row stores — so every metric here is recomputable
 * from history (reads.ts) and from a live run (sampler.ts) identically.
 */
export interface MeasuredSample {
  engine: VisibilityEngine;
  prompt: string;
  cited: boolean;
  position: number | null;
  citedSource: string | null;
}

/** A named competitor and the domains that identify its citations. */
export interface CompetitorRef {
  name: string;
  /** Bare hosts or URLs; normalized before matching (www./scheme stripped). */
  domains: string[];
}

export interface EngineBreakdown {
  engine: VisibilityEngine;
  /** Measured samples for this engine in the run. */
  sampled: number;
  cited: number;
  /** Null when the engine was not measured — absent is NOT 0. */
  score: number | null;
}

export interface ShareOfVoiceEntry {
  name: string;
  citations: number;
  /** citations / measured; 0 when nothing was measured. */
  share: number;
}

export interface ShareOfVoiceReport {
  /** Measured samples the shares are computed over. */
  measured: number;
  client: { citations: number; share: number };
  competitors: ShareOfVoiceEntry[];
  /** Samples citing a source that is neither the client nor a named competitor. */
  otherCitations: number;
  /** Measured samples with no citation signal at all (nobody identifiable won). */
  unattributed: number;
}

export interface CitedUrlEntry {
  /** The cited source verbatim, as the engine returned it. */
  url: string;
  /** Normalized registrable host (null when the source isn't URL-shaped). */
  domain: string | null;
  attribution: "client" | "competitor" | "other";
  /** Competitor name when attribution === "competitor". */
  competitor: string | null;
  count: number;
  /** Engines this source appeared on, in canonical engine order. */
  engines: VisibilityEngine[];
}

export interface VisibilityRunMetrics {
  /** Null when zero samples were measured — never an invented 0. */
  score: number | null;
  perEngine: EngineBreakdown[];
  shareOfVoice: ShareOfVoiceReport;
  citedUrls: CitedUrlEntry[];
}

/* ------------------------------------------------------------------ */
/* Score                                                               */
/* ------------------------------------------------------------------ */

/** Per-sample credit — see the ⚑ formula documentation in the module header. */
export function citationCredit(cited: boolean, position: number | null): number {
  if (!cited) return 0;
  if (position !== null && Number.isInteger(position) && position >= 1) {
    return 0.5 + 0.5 / position;
  }
  return 0.5;
}

/**
 * The Visibility Score over measured samples: 100 × mean(credit), one
 * decimal. Null (not 0) when nothing was measured.
 */
export function visibilityScore(samples: MeasuredSample[]): number | null {
  if (samples.length === 0) return null;
  const total = samples.reduce(
    (sum, sample) => sum + citationCredit(sample.cited, sample.position),
    0
  );
  return Math.round((total / samples.length) * 1000) / 10;
}

/**
 * Per-engine breakdown across the canonical engine set. An engine with no
 * measured samples reports score null and sampled 0 — visibly unmeasured,
 * never a fake zero.
 */
export function perEngineBreakdown(
  samples: MeasuredSample[],
  engines: readonly VisibilityEngine[] = VISIBILITY_ENGINES
): EngineBreakdown[] {
  return engines.map((engine) => {
    const engineSamples = samples.filter((sample) => sample.engine === engine);
    return {
      engine,
      sampled: engineSamples.length,
      cited: engineSamples.filter((sample) => sample.cited).length,
      score: visibilityScore(engineSamples),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Domains                                                             */
/* ------------------------------------------------------------------ */

/**
 * Normalize a cited source (URL or bare host) to a comparable host:
 * lowercase hostname, `www.` and trailing dot stripped. Null when the value
 * isn't host-shaped — garbage never silently matches anyone.
 */
export function normalizeDomain(source: string | null): string | null {
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  if (trimmed === "") return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host.startsWith("www.")) host = host.slice(4);
  return host === "" ? null : host;
}

/** Exact host or subdomain-on-a-dot-boundary match (blog.x.com ~ x.com). */
export function domainMatches(host: string, target: string): boolean {
  return host === target || host.endsWith(`.${target}`);
}

/** First competitor (caller order) whose normalized domains match the host. */
function matchCompetitor(
  host: string | null,
  competitors: CompetitorRef[]
): CompetitorRef | null {
  if (host === null) return null;
  for (const competitor of competitors) {
    for (const raw of competitor.domains) {
      const target = normalizeDomain(raw);
      if (target !== null && domainMatches(host, target)) return competitor;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Share of voice                                                      */
/* ------------------------------------------------------------------ */

export function shareOfVoice(
  samples: MeasuredSample[],
  competitors: CompetitorRef[]
): ShareOfVoiceReport {
  const measured = samples.length;
  let clientCitations = 0;
  let otherCitations = 0;
  let unattributed = 0;
  const byCompetitor = new Map<string, number>(
    competitors.map((competitor) => [competitor.name, 0])
  );

  for (const sample of samples) {
    if (sample.cited) {
      clientCitations += 1;
      continue;
    }
    const host = normalizeDomain(sample.citedSource);
    if (sample.citedSource === null || sample.citedSource.trim() === "") {
      unattributed += 1;
      continue;
    }
    const competitor = matchCompetitor(host, competitors);
    if (competitor) {
      byCompetitor.set(
        competitor.name,
        (byCompetitor.get(competitor.name) ?? 0) + 1
      );
    } else {
      otherCitations += 1;
    }
  }

  const share = (citations: number): number =>
    measured === 0 ? 0 : citations / measured;

  return {
    measured,
    client: { citations: clientCitations, share: share(clientCitations) },
    competitors: competitors.map((competitor) => {
      const citations = byCompetitor.get(competitor.name) ?? 0;
      return { name: competitor.name, citations, share: share(citations) };
    }),
    otherCitations,
    unattributed,
  };
}

/* ------------------------------------------------------------------ */
/* Cited-URL inventory (M4's input)                                    */
/* ------------------------------------------------------------------ */

const ENGINE_RANK = new Map<VisibilityEngine, number>(
  VISIBILITY_ENGINES.map((engine, index) => [engine, index])
);

/**
 * Every cited source seen in the run, attributed and counted. Attribution:
 * competitor by domain match first (definitive), else "client" when the URL
 * ever appeared on a sample where the client WAS cited (it is the client's
 * cited page), else "other". Sorted count desc, then url asc — deterministic.
 */
export function citedUrlInventory(
  samples: MeasuredSample[],
  competitors: CompetitorRef[]
): CitedUrlEntry[] {
  const byUrl = new Map<
    string,
    { count: number; engines: Set<VisibilityEngine>; everClientCited: boolean }
  >();
  for (const sample of samples) {
    if (sample.citedSource === null || sample.citedSource.trim() === "") {
      continue;
    }
    const entry = byUrl.get(sample.citedSource) ?? {
      count: 0,
      engines: new Set<VisibilityEngine>(),
      everClientCited: false,
    };
    entry.count += 1;
    entry.engines.add(sample.engine);
    entry.everClientCited = entry.everClientCited || sample.cited;
    byUrl.set(sample.citedSource, entry);
  }

  const entries: CitedUrlEntry[] = [];
  for (const [url, info] of byUrl) {
    const domain = normalizeDomain(url);
    const competitor = matchCompetitor(domain, competitors);
    entries.push({
      url,
      domain,
      attribution: competitor
        ? "competitor"
        : info.everClientCited
          ? "client"
          : "other",
      competitor: competitor ? competitor.name : null,
      count: info.count,
      engines: [...info.engines].sort(
        (a, b) => (ENGINE_RANK.get(a) ?? 0) - (ENGINE_RANK.get(b) ?? 0)
      ),
    });
  }

  return entries.sort(
    (a, b) => b.count - a.count || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)
  );
}

/* ------------------------------------------------------------------ */
/* Assembly                                                            */
/* ------------------------------------------------------------------ */

/** All per-run metrics in one pass — pure; same samples → identical output. */
export function computeRunMetrics(
  samples: MeasuredSample[],
  competitors: CompetitorRef[]
): VisibilityRunMetrics {
  return {
    score: visibilityScore(samples),
    perEngine: perEngineBreakdown(samples),
    shareOfVoice: shareOfVoice(samples, competitors),
    citedUrls: citedUrlInventory(samples, competitors),
  };
}
