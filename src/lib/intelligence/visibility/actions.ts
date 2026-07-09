"use server";

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { createClient } from "@/lib/supabase/server";
import type { ClientLocation } from "@/lib/types/db";
import type { SeedVertical } from "@/lib/types/playbook";
import { deriveQuerySet } from "./derive";
import { persistVisibilityRun } from "./persist";
import { resolveCitationDataProvider } from "./provider";
import { measuredSamples, runCoverage, sampleVisibility, type RunCoverage } from "./sampler";
import {
  computeRunMetrics,
  normalizeDomain,
  type CitedUrlEntry,
  type CompetitorRef,
  type EngineBreakdown,
  type ShareOfVoiceReport,
} from "./scoring";
import { logPartialRun } from "./telemetry";

/**
 * M3 Visibility Tracker — the run server action (doc 05 §M3; doc 07 §1.4).
 * Samples the client's derived query set across the AI engines via the
 * CitationDataProvider port, stores the measured results append-only
 * (`visibility_results`, migration 0006), and returns the run's metrics with
 * STRUCTURAL coverage honesty. Same security posture as the plan actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser
 *    sends a clientId (+ optional competitor refs); the tenant comes from the
 *    caller's VERIFIED JWT claim, and RLS (`visibility_results_insert`,
 *    migration 0006) re-pins every row below us regardless.
 *  - WRITE RIGHTS ARE STAFF (`requireOperator`: agency_admin | operator) —
 *    mirroring the RLS floor exactly (`app.is_writer()`); running the tracker
 *    is bread-and-butter module work, not an admin-only surface (contract §3).
 *    client_viewer can read the gauges (reads.ts) but never run a sample.
 *  - The query set is derived SERVER-SIDE from the server-loaded playbook +
 *    the stored client row — the browser cannot inject prompts, and hostile
 *    competitor payloads are clamped dead before anything runs.
 *
 * HONESTY CONTRACT (the module's spine):
 *  - Provider failures are typed and retryable; a failed sample is ABSENT
 *    from scoring and storage — never an invented "not cited".
 *  - A partial run says so structurally (`run.coverage`) AND in interface
 *    voice (`warning`) — never a footnote.
 *  - A run that measured nothing stores nothing and fails typed
 *    (provider_failed). A run that measured but couldn't store fails typed
 *    (write_failed) — an unstored run is not part of the trend line, and
 *    saying otherwise would lie.
 */

/**
 * FROZEN CONTRACT — the frontend wiring slice consumes this exact shape.
 * Post-handoff changes require Orchestrator + Code Review sign-off
 * (CLAUDE.md rule 1).
 */
export interface VisibilityRunSummary {
  /** Run identity — equals every stored row's captured_at. */
  runAt: string;
  /** Provider provenance (e.g. "profound"). */
  vendor: string;
  vertical: string;
  playbookVersion: string;
  /** Tracked queries sampled this run. */
  queryCount: number;
  /** Playbook templates excluded because they could not be honestly filled. */
  excludedTemplates: number;
  /** Queries dropped by the derivation cap (0 = none). */
  droppedQueries: number;
  /** Structural partial-coverage honesty — what was actually measured. */
  coverage: RunCoverage;
  /** Null when nothing was measured (that outcome returns ok:false instead). */
  score: number | null;
  perEngine: EngineBreakdown[];
  shareOfVoice: ShareOfVoiceReport;
  citedUrls: CitedUrlEntry[];
  /** Rows stored in visibility_results (measured samples only). */
  persisted: number;
}

export type RunVisibilityTrackingResult =
  | {
      ok: true;
      run: VisibilityRunSummary;
      /** Present iff the run was partial — interface voice, structural truth in run.coverage. */
      warning?: string;
    }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "invalid_competitors"
        | "no_playbook"
        | "empty_query_set"
        | "no_provider"
        | "lookup_failed"
        | "provider_failed"
        | "write_failed";
      error: string;
    };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a
 * raw Postgres/PostgREST/vendor string. */
const FORBIDDEN_ERROR =
  "You don’t have permission to run visibility tracking — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const INVALID_COMPETITORS_ERROR =
  "We couldn’t read the competitor list, so we didn’t run tracking. Remove and re-add the competitors, then try again.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s nothing to track. Tracking activates once this vertical’s playbook ships.";
const EMPTY_QUERY_SET_ERROR =
  "None of this playbook’s prompts can be filled from this client’s name and locations, so there’s nothing honest to track yet. Add the client’s locations, or expand the playbook’s prompt library.";
const NO_PROVIDER_ERROR =
  "No citation-data provider is connected yet, so we can’t sample the AI engines. Connect a provider, then run tracking again.";
const LOOKUP_FAILED_ERROR =
  "We couldn’t load that client. Check your connection and try again — nothing was run.";
const PROVIDER_FAILED_ERROR =
  "The citation-data provider returned no measurements this run, so nothing was recorded. Try again in a few minutes.";
const WRITE_FAILED_ERROR =
  "We sampled the engines but couldn’t save the run, so it isn’t part of the trend line. Run tracking again — nothing partial was stored.";

/* ------------------------------------------------------------------ */
/* Competitor clamp (the one browser-supplied structure)               */
/* ------------------------------------------------------------------ */

const COMPETITORS_MAX = 20;
const COMPETITOR_NAME_MAX_CHARS = 200;
const COMPETITOR_DOMAINS_MAX = 10;
/** Registrable-host shape after normalization (no schemes, paths, ports). */
const HOSTNAME_SHAPE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

/**
 * Hostile JSON ignores the compile-time type (house rule,
 * src/lib/clients/validate.ts): rebuild the competitor list field-by-field —
 * trimmed, capped, host-shaped — or refuse the WHOLE payload. Silently
 * dropping one bad competitor would misreport share of voice (its citations
 * would land in "other"), so a malformed list is refused, never repaired.
 */
function sanitizeCompetitors(raw: unknown): CompetitorRef[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > COMPETITORS_MAX) return null;
  const competitors: CompetitorRef[] = [];
  const seenNames = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name === "" || name.length > COMPETITOR_NAME_MAX_CHARS) return null;
    if (seenNames.has(name.toLowerCase())) return null;
    seenNames.add(name.toLowerCase());
    if (
      !Array.isArray(record.domains) ||
      record.domains.length === 0 ||
      record.domains.length > COMPETITOR_DOMAINS_MAX
    ) {
      return null;
    }
    const domains: string[] = [];
    for (const rawDomain of record.domains) {
      if (typeof rawDomain !== "string") return null;
      const host = normalizeDomain(rawDomain);
      if (host === null || !HOSTNAME_SHAPE.test(host)) return null;
      domains.push(host);
    }
    competitors.push({ name, domains });
  }
  return competitors;
}

/* ------------------------------------------------------------------ */
/* Gate 1a mirror (src/lib/plans/persist.ts): dormant verticals track   */
/* nothing, exactly like they plan nothing.                            */
/* ------------------------------------------------------------------ */

function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/* ------------------------------------------------------------------ */
/* The action                                                          */
/* ------------------------------------------------------------------ */

export async function runVisibilityTracking(input: {
  clientId: string;
  /** Named competitors for share-of-voice; optional, clamped hard. */
  competitors?: Array<{ name: string; domains: string[] }>;
}): Promise<RunVisibilityTrackingResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login if there
  // is no verified claim — that redirect must propagate, so we only trap the
  // wrong-role case and rethrow everything else, including NEXT_REDIRECT).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  // Runtime backstops on the caller-supplied fields — junk never reaches
  // Postgres or the rented provider.
  const clientId =
    typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const competitors = sanitizeCompetitors(input?.competitors);
  if (competitors === null) {
    return {
      ok: false,
      reason: "invalid_competitors",
      error: INVALID_COMPETITORS_ERROR,
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, vertical, locations")
    .eq("id", clientId)
    .maybeSingle();
  if (error) {
    // A failed READ is not "not found" — it's retryable, and claiming the
    // client is gone would be a lie in interface voice.
    return { ok: false, reason: "lookup_failed", error: LOOKUP_FAILED_ERROR };
  }
  if (!data) {
    // RLS-scoped read came back empty: nonexistent id and another tenant's id
    // are the SAME observation here — correct and intended (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const vertical = data.vertical as string;
  const playbook = activePlaybook(vertical);
  if (!playbook) {
    return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };
  }

  // SERVER-SIDE derivation from the trusted playbook + the STORED client row
  // (name/locations were clamped at their own write seam) — the browser never
  // supplies a prompt.
  const querySet = deriveQuerySet(playbook, {
    name: data.name as string,
    locations: (data.locations as ClientLocation[] | null) ?? [],
  });
  if (querySet.queries.length === 0) {
    // The honest thin-playbook outcome (doc 02: prompt libraries are living
    // lists) — a smaller set is reported, an invented one never is.
    return {
      ok: false,
      reason: "empty_query_set",
      error: EMPTY_QUERY_SET_ERROR,
    };
  }

  const provider = resolveCitationDataProvider();
  if (!provider) {
    return { ok: false, reason: "no_provider", error: NO_PROVIDER_ERROR };
  }

  const runAt = new Date().toISOString();
  const run = await sampleVisibility(provider, querySet.queries, { runAt });
  const coverage = runCoverage(run);
  if (coverage.failed > 0) {
    // Exactly one redacted telemetry line per degraded run (counts only).
    logPartialRun(coverage);
  }
  if (coverage.measured === 0) {
    return {
      ok: false,
      reason: "provider_failed",
      error: PROVIDER_FAILED_ERROR,
    };
  }

  // Claim-sourced tenant scope — NEVER from the client payload. RLS re-pins
  // it below us regardless (migration 0006).
  const persisted = await persistVisibilityRun(
    supabase,
    claims.tenantId,
    clientId,
    run
  );
  if (persisted.kind !== "persisted") {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }

  const metrics = computeRunMetrics(measuredSamples(run), competitors);
  const summary: VisibilityRunSummary = {
    runAt,
    vendor: run.vendor,
    vertical,
    playbookVersion: querySet.playbookVersion,
    queryCount: querySet.queries.length,
    excludedTemplates: querySet.excluded.length,
    droppedQueries: querySet.dropped,
    coverage,
    score: metrics.score,
    perEngine: metrics.perEngine,
    shareOfVoice: metrics.shareOfVoice,
    citedUrls: metrics.citedUrls,
    persisted: persisted.rows,
  };

  if (coverage.failed > 0) {
    return {
      ok: true,
      run: summary,
      warning: `This run measured ${coverage.measured} of ${coverage.requested} checks — the scores reflect only what was measured. Run tracking again to fill the gaps.`,
    };
  }
  return { ok: true, run: summary };
}
