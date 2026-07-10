"use server";

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import {
  logPropertyWriteFailure,
  type PersistedProperty,
} from "@/lib/clients/properties";
import { createClient } from "@/lib/supabase/server";
import {
  validatePropertyCreateInput,
  validatePropertyEditInput,
} from "./validate";

/**
 * Workspace properties seam (BUILD-STATE SCOPE AUTHORIZATION item 1) — the
 * operator-facing create/edit path for a client's website property. Security
 * posture mirrors the M8 content + M2 audit actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only clientId/propertyId + url + platform; the tenant comes from the
 *    caller's VERIFIED JWT claim, and RLS (`properties_*`, migration 0003)
 *    re-pins every row below us. The composite FK (tenant_id, client_id) →
 *    clients makes a cross-tenant OR cross-client property impossible.
 *  - WRITE FLOOR MIRRORS RLS. `properties_insert/update` admit any writer
 *    (`app.is_writer()` = agency_admin | operator), so the guard is
 *    `requireOperator()` — managing a client's properties is operator module
 *    work (doc 03 §2). RLS is the real gate; the guard only sharpens the message.
 *  - SECRETS NEVER TOUCHED. This seam writes url + platform + connection_method
 *    'none' only; it NEVER writes auth_ref (doc 03 §5) and NEVER a
 *    connected-looking connection_method (no connection flow exists yet — the
 *    Connections block owns that transition, with a real auth_ref).
 *
 * NO DELETE (v1 ruling): properties are on-delete-restrict FK parents (audits,
 * site_changes, runs), so a delete surface would need cascade semantics that do
 * not exist yet. Deletion is deferred to the Connections/lifecycle block.
 */

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres string. */
const FORBIDDEN_ERROR =
  "You don’t have permission to manage properties — that’s an agency staff action. Ask your admin, or to change your role.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const PROPERTY_NOT_FOUND_ERROR =
  "We couldn’t find that property. It may have been removed — refresh and try again.";
const WRITE_FAILED_ERROR =
  "We couldn’t save this property. Check your connection and try again.";

export type CreatePropertyResult =
  | { ok: true; property: PersistedProperty }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "invalid_input" | "write_failed";
      error: string;
    };

export type EditPropertyResult = CreatePropertyResult;

export interface CreatePropertyInput {
  clientId: string;
  url: string;
  platform: string;
  /** Accepted only as 'none' (or omitted) today — see the validator. */
  connectionMethod?: string;
}

export interface EditPropertyInput {
  propertyId: string;
  url: string;
  platform: string;
  connectionMethod?: string;
}

/**
 * Create a website property for a client. type is pinned to 'website'
 * (connection_method 'none'); the frozen properties_website_has_platform CHECK
 * then requires the platform the validator already enforced.
 */
export async function createProperty(
  input: CreatePropertyInput
): Promise<CreatePropertyResult> {
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

  const validated = validatePropertyCreateInput(input);
  if (!validated.ok) {
    return { ok: false, reason: "invalid_input", error: validated.error };
  }
  const { url, platform } = validated.value;

  const supabase = await createClient();
  try {
    // RLS-scoped existence check: a cross-tenant or nonexistent id is the SAME
    // empty observation (doc 03 §4). Also gives a precise "no client" message
    // instead of a raw FK rejection.
    const clientRes = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .maybeSingle();
    if (clientRes.error) {
      return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    if (!clientRes.data) {
      return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };
    }

    const inserted = await supabase
      .from("properties")
      .insert({
        // Claim-sourced tenant — RLS re-pins it regardless.
        tenant_id: claims.tenantId,
        client_id: clientId,
        type: "website",
        platform,
        url,
        connection_method: "none",
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      logPropertyWriteFailure("property_insert", inserted.error);
      return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
    }
    return {
      ok: true,
      property: { id: inserted.data.id as string, url, platform },
    };
  } catch (err) {
    logPropertyWriteFailure("property_insert", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}

/**
 * Edit a property's url + platform. connection_method is NOT editable here (only
 * 'none' is writable — the Connections block owns connected transitions); auth_ref
 * is never touched.
 */
export async function editProperty(
  input: EditPropertyInput
): Promise<EditPropertyResult> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const propertyId = typeof input?.propertyId === "string" ? input.propertyId.trim() : "";
  if (!isUuidV4(propertyId)) {
    return { ok: false, reason: "not_found", error: PROPERTY_NOT_FOUND_ERROR };
  }

  const validated = validatePropertyEditInput(input);
  if (!validated.ok) {
    return { ok: false, reason: "invalid_input", error: validated.error };
  }
  const { url, platform } = validated.value;

  const supabase = await createClient();
  try {
    // RLS-scoped update; the eq filters make the claim-sourced scope explicit.
    // select().single() turns a nonexistent/foreign row into a not-found, never
    // a silent no-op.
    const updated = await supabase
      .from("properties")
      .update({ url, platform })
      .eq("tenant_id", claims.tenantId)
      .eq("id", propertyId)
      .select("id")
      .single();
    if (updated.error || !updated.data) {
      // A vanished/foreign row surfaces here as an error (no row) — map to a
      // not-found rather than a raw failure. Any real write error is redacted.
      logPropertyWriteFailure("property_update", updated.error);
      return { ok: false, reason: "not_found", error: PROPERTY_NOT_FOUND_ERROR };
    }
    return {
      ok: true,
      property: { id: updated.data.id as string, url, platform },
    };
  } catch (err) {
    logPropertyWriteFailure("property_update", err);
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
}
