"use server";

import {
  AuthorizationError,
  requireAuth,
  requireOperator,
} from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
import {
  COMPETITORS_PER_CLIENT_CAP,
  validateCompetitorInput,
} from "./validate";

/**
 * Competitors write + read seam (migration 0010; M4 share-of-voice, M19
 * dashboard). Security posture mirrors the M8 content actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED. The browser sends only clientId + name +
 *    domain; the tenant comes from the verified JWT claim, RLS (`competitors_*`)
 *    re-pins every row, and the composite FK (tenant_id, client_id) → clients
 *    makes a cross-tenant/cross-client competitor impossible.
 *  - WRITE FLOOR MIRRORS RLS. competitors_insert/delete admit any writer
 *    (`app.is_writer()`), so writes guard with `requireOperator()`; the read
 *    guards with `requireAuth()` (competitors_select is client_viewer-scoped, so
 *    a viewer sees only its own client's competitors — RLS enforces it).
 *
 * PER-CLIENT CAP. A CHECK cannot count sibling rows, so the cap
 * (COMPETITORS_PER_CLIENT_CAP) is enforced HERE: read the client's competitor
 * ids and refuse at the cap. KNOWN RACE (accepted, documented like ensurePlan):
 * two truly-concurrent adds can both pass the count; a partial unique constraint
 * would need the post-freeze path. The unique index still prevents duplicate
 * NAMES atomically.
 */

const FORBIDDEN_ERROR =
  "You don’t have permission to manage competitors — that’s an agency staff action. Ask your admin, or to change your role.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const COMPETITOR_NOT_FOUND_ERROR =
  "We couldn’t find that competitor. It may have been removed — refresh and try again.";
const CAP_REACHED_ERROR = `You can track up to ${COMPETITORS_PER_CLIENT_CAP} competitors per client. Remove one before adding another.`;
const DUPLICATE_ERROR =
  "That competitor is already on this client's list.";
const WRITE_FAILED_ERROR =
  "We couldn’t save this competitor. Check your connection and try again.";
const READ_FAILED_ERROR =
  "We couldn’t load competitors. Check your connection and try again.";

export interface CompetitorSummary {
  id: string;
  name: string;
  domain: string | null;
}

export type AddCompetitorResult =
  | { ok: true; competitor: CompetitorSummary }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "invalid_input"
        | "cap_reached"
        | "duplicate"
        | "write_failed";
      error: string;
    };

export type ListCompetitorsResult =
  | { ok: true; competitors: CompetitorSummary[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

export type RemoveCompetitorResult =
  | { ok: true }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "write_failed";
      error: string;
    };

export interface AddCompetitorInput {
  clientId: string;
  name: string;
  domain?: string;
}

export async function addCompetitor(
  input: AddCompetitorInput
): Promise<AddCompetitorResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };
  }

  const validated = validateCompetitorInput(input);
  if (!validated.ok) {
    return { ok: false, reason: "invalid_input", error: validated.error };
  }
  const { name, domain } = validated.value;

  const supabase = await createClient();

  // Cap check: RLS scopes the read to the caller's tenant; eq(client_id)
  // narrows within it. Bounded (≤ cap+1) rows.
  const existing = await supabase
    .from("competitors")
    .select("id")
    .eq("client_id", clientId);
  if (existing.error || !existing.data) {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  if ((existing.data as unknown[]).length >= COMPETITORS_PER_CLIENT_CAP) {
    return { ok: false, reason: "cap_reached", error: CAP_REACHED_ERROR };
  }

  const inserted = await supabase
    .from("competitors")
    .insert({
      // Claim-sourced tenant — RLS re-pins it. A bad clientId (foreign/absent)
      // fails the composite FK here → surfaced as a not-found below.
      tenant_id: claims.tenantId,
      client_id: clientId,
      name,
      domain,
    })
    .select("id, name, domain")
    .single();
  if (inserted.error || !inserted.data) {
    // 23505 = the case-insensitive unique index — a duplicate name.
    if (inserted.error?.code === "23505") {
      return { ok: false, reason: "duplicate", error: DUPLICATE_ERROR };
    }
    // 23503 = composite FK — the client doesn't exist in this tenant.
    if (inserted.error?.code === "23503") {
      return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };
    }
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  return {
    ok: true,
    competitor: {
      id: inserted.data.id as string,
      name: inserted.data.name as string,
      domain: (inserted.data.domain as string | null) ?? null,
    },
  };
}

export async function listCompetitors(input: {
  clientId: string;
}): Promise<ListCompetitorsResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  // RLS scopes the read (a client_viewer sees only its own client's rows).
  const res = await supabase
    .from("competitors")
    .select("id, name, domain")
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (res.error || !res.data) {
    return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  }
  const competitors = (res.data as Array<{ id: string; name: string; domain: string | null }>).map(
    (row) => ({ id: row.id, name: row.name, domain: row.domain ?? null })
  );
  return { ok: true, competitors };
}

export async function removeCompetitor(input: {
  competitorId: string;
}): Promise<RemoveCompetitorResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const competitorId = typeof input?.competitorId === "string" ? input.competitorId.trim() : "";
  if (!isUuidV4(competitorId)) {
    return { ok: false, reason: "not_found", error: COMPETITOR_NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  // RLS-scoped delete; eq filters make the claim-sourced scope explicit.
  // select() returns the deleted rows — zero means nonexistent/foreign (parity).
  const res = await supabase
    .from("competitors")
    .delete()
    .eq("tenant_id", claims.tenantId)
    .eq("id", competitorId)
    .select("id");
  if (res.error) {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  if (!res.data || (res.data as unknown[]).length === 0) {
    return { ok: false, reason: "not_found", error: COMPETITOR_NOT_FOUND_ERROR };
  }
  return { ok: true };
}
