"use server";

/**
 * Paste-URL brand-extract flow — the UI's thin server seam over the LANDED
 * brand_extract queue kind (migration 0015 + the egress-guarded adapter).
 * Nothing here fetches, extracts, or builds a kit: enqueue is the frozen
 * `enqueueRun` contract, execution is the background processor, and the kit
 * itself is only ever created by the frozen M7 engine actions after the
 * operator reviews and confirms (contrast gate + immutable lock unchanged).
 * This file adds exactly three capabilities:
 *
 *  - `getBrandExtractState` — one RLS-scoped read of where the flow stands for
 *    a client: the latest brand_extract run (so the panel can watch it) and the
 *    latest `proposed` draft (at most one exists, structurally — the 0015
 *    partial unique index). The stored draft jsonb is UNTRUSTED extracted DATA;
 *    it crosses to the client through `parseStoredExtractDraft` (the pure
 *    parse boundary in ../_components/extract-shared).
 *  - `discardBrandExtractDraft` — the operator dismisses a proposed kit. CAS'd
 *    (`status='proposed'` → 'discarded'); an already-consumed draft is never
 *    touched (mirrors the enqueue/adapter supersede filter).
 *  - `consumeBrandExtractDraft` — records that a proposed draft was used to
 *    prefill the ingest form that became a kit. Best-effort bookkeeping called
 *    AFTER `createBrandKit` succeeds; a failure never unwinds the kit.
 *
 * Both writes are `requireOperator`-floored (mirrors the drafts table's
 * writer-only RLS) and tenant/client-scoped by RLS below — a foreign id is an
 * RLS-empty read/0-row update, indistinguishable from nonexistent (doc 03 §4).
 */

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { isHeartbeatStale } from "@/lib/runs/config";
import { createClient } from "@/lib/supabase/server";
import type { RunStatus } from "@/lib/types/db";
import {
  parseStoredExtractDraft,
  type ExtractDraftView,
} from "../_components/extract-shared";

/* ------------------------------------------------------------------ */
/* View types (plain, server-shaped, serializable)                     */
/* ------------------------------------------------------------------ */

/** The latest brand_extract run, shaped to exactly what the watcher renders. */
export interface ExtractRunView {
  id: string;
  status: RunStatus;
  /** The pasted target (immutable run identity since migration 0016) — shown so
   *  the operator always sees WHICH site a state describes. */
  inputUrl: string | null;
  errorCode: string | null;
  /** True on a running row whose heartbeat has gone stale (A5 honesty). */
  heartbeatStale: boolean;
  createdAt: string;
}

export type BrandExtractState =
  | {
      ok: true;
      run: ExtractRunView | null;
      draft: ExtractDraftView | null;
    }
  | { ok: false; reason: "forbidden" | "read_failed"; error: string };

export type DraftActionResult =
  | { ok: true }
  | { ok: false; reason: "forbidden" | "not_found" | "write_failed"; error: string };

const FORBIDDEN_ERROR =
  "You don’t have permission to manage brand extractions — that’s an agency staff action.";
const READ_FAILED_ERROR =
  "We couldn’t check on the brand pull. This is a temporary read issue — refresh to try again.";
const DRAFT_GONE_ERROR =
  "That proposed kit isn’t available anymore — it may have been replaced by a newer pull. Refresh to see the current one.";
const WRITE_FAILED_ERROR =
  "We couldn’t update the proposed kit. Check your connection and try again.";

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * Where the paste-URL flow stands for one client: the latest brand_extract run
 * (any status — the panel maps it honestly) and the latest proposed draft.
 * Two RLS-scoped reads; either failing fails the whole state read LOUDLY
 * (a read blip must never render as "no pull yet").
 */
export async function getBrandExtractState(clientId: string): Promise<BrandExtractState> {
  try {
    await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }
  const id = typeof clientId === "string" ? clientId.trim() : "";
  if (!isUuidV4(id)) {
    // An unshaped id can't name a real client; same observation as RLS-empty.
    return { ok: true, run: null, draft: null };
  }

  const supabase = await createClient();
  const [runRes, draftRes] = await Promise.all([
    supabase
      .from("runs")
      .select("id, status, input_url, error_code, heartbeat_at, created_at")
      .eq("client_id", id)
      .eq("kind", "brand_extract")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("brand_extract_drafts")
      .select("id, draft, created_at")
      .eq("client_id", id)
      .eq("status", "proposed")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (runRes.error || draftRes.error) {
    return { ok: false, reason: "read_failed", error: READ_FAILED_ERROR };
  }

  let run: ExtractRunView | null = null;
  if (runRes.data) {
    const row = runRes.data as {
      id: string;
      status: RunStatus;
      input_url: string | null;
      error_code: string | null;
      heartbeat_at: string | null;
      created_at: string;
    };
    // isHeartbeatStale takes ms; an unparseable timestamp maps to null (= stale,
    // the honest failure direction — never render a fresh pulse we can't prove).
    const hbMs = row.heartbeat_at === null ? null : Date.parse(row.heartbeat_at);
    run = {
      id: row.id,
      status: row.status,
      inputUrl: row.input_url,
      errorCode: row.error_code,
      heartbeatStale:
        row.status === "running" &&
        isHeartbeatStale(hbMs === null || Number.isNaN(hbMs) ? null : hbMs, Date.now()),
      createdAt: row.created_at,
    };
  }

  let draft: ExtractDraftView | null = null;
  if (draftRes.data) {
    const row = draftRes.data as { id: string; draft: unknown; created_at: string };
    draft = parseStoredExtractDraft(row.draft, row.id, row.created_at);
  }

  return { ok: true, run, draft };
}

/* ------------------------------------------------------------------ */
/* Draft lifecycle writes                                              */
/* ------------------------------------------------------------------ */

async function transitionDraft(
  clientId: string,
  draftId: string,
  to: "consumed" | "discarded"
): Promise<DraftActionResult> {
  try {
    await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }
  const cid = typeof clientId === "string" ? clientId.trim() : "";
  const did = typeof draftId === "string" ? draftId.trim() : "";
  if (!isUuidV4(cid) || !isUuidV4(did)) {
    return { ok: false, reason: "not_found", error: DRAFT_GONE_ERROR };
  }

  const supabase = await createClient();
  // CAS: only a still-proposed draft moves. A consumed draft is never rewritten;
  // a superseded (discarded) one stays discarded. 0 rows = the CAS lost — the
  // draft moved on (or is foreign/nonexistent: RLS makes those the same
  // observation, no existence oracle).
  const res = await supabase
    .from("brand_extract_drafts")
    .update({ status: to })
    .eq("id", did)
    .eq("client_id", cid)
    .eq("status", "proposed")
    .select("id");
  if (res.error) {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  if (!res.data || res.data.length === 0) {
    return { ok: false, reason: "not_found", error: DRAFT_GONE_ERROR };
  }
  return { ok: true };
}

/** The operator dismisses a proposed kit (it stays on record as `discarded`). */
export async function discardBrandExtractDraft(input: {
  clientId: string;
  draftId: string;
}): Promise<DraftActionResult> {
  return transitionDraft(input?.clientId ?? "", input?.draftId ?? "", "discarded");
}

/**
 * Bookkeeping after a draft-prefilled kit is CREATED: the proposed draft is
 * `consumed`. Called best-effort AFTER `createBrandKit` succeeds — a failure
 * here never unwinds the kit (the next extraction supersedes the leftover).
 */
export async function consumeBrandExtractDraft(input: {
  clientId: string;
  draftId: string;
}): Promise<DraftActionResult> {
  return transitionDraft(input?.clientId ?? "", input?.draftId ?? "", "consumed");
}
