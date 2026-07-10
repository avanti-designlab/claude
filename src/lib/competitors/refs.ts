/**
 * The load-bearing adapter that makes share-of-voice able to name a competitor.
 *
 * A stored competitor row (migration 0010) carries a display `name` and an
 * OPTIONAL bare `domain`. The SOV scorer (`shareOfVoice`, scoring.ts) matches
 * citations to a competitor BY DOMAIN, taking `CompetitorRef { name, domains[] }`.
 * This maps one to the other:
 *   - a competitor WITH a domain → one-element `domains` (its citations can match);
 *   - a NAME-ONLY competitor → `domains: []` → it can never match a citation, so it
 *     surfaces as an honest 0% slice (present, tracked, but unattributable until a
 *     domain is added). Absent ≠ zero — a labelled 0 is the truth here.
 *
 * Pure and free of server/Next imports so both SOV callers (the Visibility tab and
 * the M19 dashboard) share ONE transform and it is unit-tested in the default run.
 * The audit's "share of voice can structurally never show a competitor" was exactly
 * the `[]` that used to sit where this adapter's output now goes.
 */

import type { CompetitorRef } from "@/lib/intelligence/visibility/scoring";

/** The fields the adapter needs from a stored competitor row (CompetitorSummary is assignable). */
export interface CompetitorLike {
  name: string;
  domain: string | null;
}

/** Map stored competitor rows to the SOV scorer's domain-keyed refs. */
export function toCompetitorRefs(
  competitors: readonly CompetitorLike[]
): CompetitorRef[] {
  return competitors.map((competitor) => ({
    name: competitor.name,
    domains: competitor.domain ? [competitor.domain] : [],
  }));
}
