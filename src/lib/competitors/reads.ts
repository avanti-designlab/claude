import "server-only";

/**
 * Passed-supabase, RLS-scoped read of a client's named competitors — the seam
 * BOTH share-of-voice callers source from (the Visibility tab and the M19
 * dashboard's `load.ts`), so the panel a client sees and the SOV shares it
 * renders are drawn from the SAME rows.
 *
 * Unlike `listCompetitors` (actions.ts), this takes an already-built claim-scoped
 * client rather than building its own — mirroring the visibility reads and the
 * overview page's `loadProperties`. That keeps it composable inside a page's
 * `Promise.all` AND env-safe (the caller degrades via `tryCreateClient`/try-catch;
 * this module never calls `createClient`, so an env-less build never throws here).
 *
 * TENANT + CLIENT SCOPING IS THE DATABASE'S JOB. RLS (`competitors_select`,
 * migration 0010: `tenant_id = app.tenant_id() and app.client_scope(client_id)`)
 * pins every row — a client_viewer sees only its own client's competitors, staff
 * see their tenant's; a cross-tenant/cross-client id simply yields zero rows. App
 * code writes no tenant filter; `eq(client_id)` only narrows within the caller's
 * own scope. A non-UUID id never reaches Postgres (same "none" observation).
 */

import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
import type { CompetitorSummary } from "./actions";
import { COMPETITORS_PER_CLIENT_CAP } from "./validate";

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * Structural row bound. The per-client cap is app-enforced with an accepted
 * add race (actions.ts), so a row or two beyond the cap can exist; the slack
 * keeps every real row visible while still bounding the read.
 */
const LIST_ROW_CAP = COMPETITORS_PER_CLIENT_CAP + 5;

export type ClientCompetitorsRead =
  | { ok: true; rows: CompetitorSummary[] }
  /** The read failed (retryable) — never conflated with "no competitors yet". */
  | { ok: false };

/**
 * Read a client's competitors, oldest first (the same order `listCompetitors`
 * returns — stable list, stable SOV bar order). Only the columns SOV + the panel
 * need; never `select *`.
 */
export async function readClientCompetitors(
  supabase: Supabase,
  clientId: string
): Promise<ClientCompetitorsRead> {
  if (!isUuidV4(clientId)) return { ok: true, rows: [] };
  const res = await supabase
    .from("competitors")
    .select("id, name, domain")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true })
    .limit(LIST_ROW_CAP);
  if (res.error || !res.data) return { ok: false };
  const rows = (
    res.data as Array<{ id: string; name: string; domain: string | null }>
  ).map((row) => ({ id: row.id, name: row.name, domain: row.domain ?? null }));
  return { ok: true, rows };
}
