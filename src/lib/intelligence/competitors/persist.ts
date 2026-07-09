import "server-only";

/**
 * M4 Competitor reverse-engineering — persistence decision + read API.
 *
 * PERSISTENCE DECISION (honest, against the FROZEN schema — migrations
 * 0005/0006): there is NO table that fits a competitor-gap analysis.
 *   - `audits` is FK-bound to a CLIENT property (`audits_property_fk`), and its
 *     history reads (audit/rows.ts) would mis-read a competitor-diff row as a
 *     property audit, poisoning the M2 trend line. A competitor's cited page is
 *     not the client's property — storing it here would be a lie.
 *   - `metrics.source` CHECK admits only gsc/ga4/call_tracking/local_rank/
 *     reviews — not a competitor analysis.
 *   - `alerts` is M17's surface; `type = 'competitor_overtook'` is a
 *     NOTIFICATION, not an analysis store, and `payload` cannot hold the full
 *     evidence/denominator record without abuse. (M4 findings MAY later feed an
 *     M17 `competitor_overtook` alert — that is M17's job, not storage here.)
 *
 * So M4 follows M3's precedent for what the frozen schema can't hold:
 * RETURN-WITHOUT-INVENTING and FLAG THE GAP. The computed gap analysis is
 * live-only (returned by the action); nothing is written. The proposed frozen-
 * schema addition is a `competitor_analyses` table (tenant-scoped, immutable
 * captures like `audits`), deferred to the post-freeze Orchestrator + Code
 * Review path (CLAUDE.md rule 1).
 *
 * READ API: what IS stored and readable is the competitor-citation SUBSTRATE —
 * the latest visibility run's competitor cited-URL inventory
 * (`visibility_results`, via M3's tenant-scoped `getLatestShareOfVoice`). The
 * read API returns that (the "latest competitor picture per client"), tenant-
 * scoped by RLS, and states plainly that the computed gap analysis itself is
 * not persisted. Deliberately NOT a "use server" module (house rule): only the
 * audited action imports it.
 */

import type { createClient } from "@/lib/supabase/server";
import type { CompetitorRef } from "@/lib/intelligence/visibility";
import { getLatestShareOfVoice } from "@/lib/intelligence/visibility/reads";
import { competitorTargetsFromCitedUrls } from "./targets";
import type { CompetitorTarget } from "./types";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * The flag surfaced everywhere M4 would otherwise persist. Stable string so the
 * Orchestrator/documentation agent can grep for the schema-gap follow-up.
 */
export const COMPETITOR_PERSISTENCE_GAP =
  "No frozen-schema table holds a competitor-gap analysis (migrations 0005/0006: " +
  "audits is FK-bound to a client property and its history reads would mis-read a " +
  "competitor-diff row; metrics.source and alerts.type CHECKs don't admit it). The " +
  "analysis is returned live and not persisted. Proposed addition: a tenant-scoped " +
  "competitor_analyses table — deferred to the post-freeze Orchestrator + Code Review path.";

/**
 * The persistence outcome. There is exactly one variant today: the analysis is
 * NOT persisted, with the flag. Writing an inventing row into audits/metrics/
 * alerts would corrupt another module's data — so this writes nothing.
 */
export type PersistCompetitorGapsOutcome = {
  kind: "not_persisted";
  reason: "no_table";
  flag: string;
};

/**
 * "Persist" a competitor-gap report — honestly a no-op against the frozen
 * schema. Returns the flagged gap; the caller keeps the live report. Takes no
 * client so it can never be mistaken for a real write path.
 */
export function persistCompetitorGapReport(): PersistCompetitorGapsOutcome {
  return { kind: "not_persisted", reason: "no_table", flag: COMPETITOR_PERSISTENCE_GAP };
}

/* ------------------------------------------------------------------ */
/* Read API — the latest stored competitor-citation substrate          */
/* ------------------------------------------------------------------ */

export interface LatestCompetitorCitations {
  /** The run key of the latest stored visibility run (its captured_at). */
  runAt: string;
  /** Competitor-attributed cited URLs from that run — M4's crawl input. */
  competitorCitations: CompetitorTarget[];
  /** The computed gap analysis is NOT persisted — see `flag`. */
  analysisPersisted: false;
  flag: string;
}

export type ReadLatestCompetitorCitationsOutcome =
  /** latest is null when the client has no stored visibility runs yet. */
  | { kind: "ok"; latest: LatestCompetitorCitations | null }
  /** The read failed — retryable; never mistaken for "no competitors yet". */
  | { kind: "failed" };

/**
 * Latest stored competitor citations for a client — the persisted substrate M4
 * reverse-engineers, read through M3's tenant-scoped share-of-voice read. RLS
 * (`visibility_results_select`) is the isolation boundary: a cross-tenant
 * clientId yields no run (indistinguishable from "no runs yet"). Competitor
 * refs come from the caller (there is no competitor-config table in the frozen
 * schema either — a parallel flagged gap); arbitrary strings are safe (a
 * non-host-shaped domain simply never matches, per scoring.normalizeDomain).
 */
export async function readLatestCompetitorCitations(
  supabase: Supabase,
  clientId: string,
  competitors: CompetitorRef[]
): Promise<ReadLatestCompetitorCitationsOutcome> {
  const sov = await getLatestShareOfVoice(supabase, clientId, competitors);
  if (sov.kind === "failed") return { kind: "failed" };
  if (sov.latest === null) return { kind: "ok", latest: null };
  return {
    kind: "ok",
    latest: {
      runAt: sov.latest.runAt,
      competitorCitations: competitorTargetsFromCitedUrls(sov.latest.citedUrls),
      analysisPersisted: false,
      flag: COMPETITOR_PERSISTENCE_GAP,
    },
  };
}
