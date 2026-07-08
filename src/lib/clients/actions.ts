"use server";

import { AuthorizationError, requireRole } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";
import type { ClientLocation, ClientStatus } from "@/lib/types/db";

/**
 * Client-record server actions (the real "make it real" write of this slice).
 *
 * Persisting a client is the first live tenant write in the product. Two hard
 * properties, both enforced here AND below us in the database:
 *
 *  1. TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The row's
 *     `tenant_id` is taken from the caller's VERIFIED JWT claim
 *     (`requireRole` → `getClaims` → supabase `getClaims()` signature-verified),
 *     not from anything the browser sent. The client payload carries only
 *     name / vertical / locations — there is no `tenant_id` field to spoof.
 *     Even if this code had a bug, the RLS INSERT policy
 *     (`clients_insert`: `with check (tenant_id = app.tenant_id() and
 *     app.is_admin())`, migration 0003) re-pins `tenant_id` to the caller's
 *     claim and rejects a mismatched or foreign tenant — so a cross-tenant
 *     write is structurally impossible, not merely discouraged.
 *
 *  2. WRITE RIGHTS ARE ADMIN-ONLY. `clients` writes are `agency_admin`-only
 *     (contract §3). We guard with `requireRole("agency_admin")` so the UI can
 *     show a precise permission message instead of a raw RLS rejection; RLS is
 *     still the real gate (`app.is_admin()`), the guard only mirrors it.
 *
 * NOTE — what this slice persists vs. defers: this writes the CLIENT row only
 * (name, vertical, locations, status 'onboarding'). The generated plan
 * (`generatePlan`) is shown in onboarding but NOT yet persisted — plan/task
 * persistence into `plans`/`tasks` and the operator dashboard reading them back
 * is the NEXT slice. We deliberately do not invent columns here.
 */

export interface CreateClientInput {
  name: string;
  /** Onboarding's selected vertical (open set — mirrors `Vertical`). */
  vertical: string;
  /** Mapped from the onboarding location steps ([{name, address, geo}]). */
  locations: ClientLocation[];
}

export interface CreatedClient {
  id: string;
  name: string;
  vertical: string;
  status: ClientStatus;
}

export type CreateClientResult =
  | { ok: true; client: CreatedClient }
  | { ok: false; error: string };

export async function createClientFromOnboarding(
  input: CreateClientInput
): Promise<CreateClientResult> {
  // AUTHZ. requireRole authenticates first (redirects to /login if there is no
  // verified claim — that redirect must propagate, so we only trap the
  // wrong-role case and rethrow everything else, including NEXT_REDIRECT).
  let claims;
  try {
    claims = await requireRole("agency_admin");
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return {
        ok: false,
        error:
          "You don’t have permission to add clients — that’s an agency-admin action. Ask your admin to add the client, or to change your role.",
      };
    }
    throw err;
  }

  const name = input.name?.trim();
  if (!name) {
    return { ok: false, error: "Add a name for this client before saving." };
  }
  const vertical = input.vertical?.trim();
  if (!vertical) {
    return {
      ok: false,
      error: "Pick an industry for this client before saving.",
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .insert({
      // Claim-sourced tenant scope — NEVER from the client payload. RLS
      // re-pins this to app.tenant_id() and rejects any mismatch.
      tenant_id: claims.tenantId,
      name,
      vertical,
      locations: input.locations ?? [],
      status: "onboarding",
    })
    .select("id, name, vertical, status")
    .single();

  if (error || !data) {
    // Interface-voice failure (doc 06 §6): what happened + what to do, never a
    // raw Postgres/PostgREST string.
    return {
      ok: false,
      error:
        "We couldn’t save this client. Check your connection and try again — nothing was created.",
    };
  }

  return {
    ok: true,
    client: {
      id: data.id as string,
      name: data.name as string,
      vertical: data.vertical as string,
      status: data.status as ClientStatus,
    },
  };
}
