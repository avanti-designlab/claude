import "server-only";

/**
 * Website-property persistence + idempotent reconciliation for onboarding
 * (frozen schema: supabase/migrations/0003_clients_properties_brand_kits.sql).
 *
 * Deliberately NOT a "use server" module (house rule — same as
 * src/lib/plans/persist.ts): exporting helpers from an action file would mint
 * each as a browser-invokable RPC endpoint. This is a plain server-side module
 * the onboarding action imports. Every caller passes a claim-scoped Supabase
 * client and a CLAIM-SOURCED tenantId (never anything the browser sent); RLS
 * (`properties_insert` / `properties_select` / `properties_update`, migration
 * 0003) re-pins tenant scope below us, and the composite FK (tenant_id,
 * client_id) → clients makes a cross-tenant OR cross-client property
 * structurally impossible.
 *
 * SECRETS: a property row NEVER carries a raw credential (doc 03 §5). This seam
 * writes url + platform + connection_method='none' and NEVER auth_ref.
 */

import type { createClient } from "@/lib/supabase/server";
import type { PropertyPlatform } from "@/lib/types/db";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — plans/persist.ts)      */
/* ------------------------------------------------------------------ */

export const PROPERTY_WRITE_FAILURE_MARKER = "[property-write-failure]";

export type PropertyWriteStage =
  | "property_read"
  | "property_insert"
  | "property_update";

export function logPropertyWriteFailure(
  stage: PropertyWriteStage,
  cause: unknown
): void {
  console.error(
    `${PROPERTY_WRITE_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`
  );
}

/** Bare SQLSTATE/PostgREST code, or "unknown" — no data can ride the log line. */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) {
      return code;
    }
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* ensureWebsiteProperty — idempotent "this client has this website"   */
/* ------------------------------------------------------------------ */

export interface PersistedProperty {
  id: string;
  url: string;
  platform: PropertyPlatform;
}

export interface WebsiteInput {
  url: string;
  platform: PropertyPlatform;
}

export type EnsurePropertyOutcome =
  | { ok: true; property: PersistedProperty }
  | { ok: false };

interface WebsiteRow {
  id: string;
  url: string;
  platform: string | null;
}

/**
 * Reconcile a client to "has its onboarding website property", idempotently —
 * the property-row half of the ratified onboarding replay semantics (BUILD-STATE
 * SCOPE AUTHORIZATION item 1, CRITICAL condition): a divergent replay must
 * UPDATE the property THROUGH to the resubmitted values, never strand a stale
 * URL. Safe to call on BOTH the fresh path (no property yet → insert) and the
 * replay path (property exists → reconcile), because it always:
 *
 *   1. reads the client's EXISTING website properties (oldest first);
 *   2. NONE      → INSERT a fresh website (connection_method 'none', no auth_ref);
 *   3. one MATCHES the submitted url+platform → return it untouched (no-op);
 *   4. exists but DIVERGES → UPDATE-THROUGH the oldest (the onboarding row) to
 *      the submitted values.
 *
 * "Oldest website" is the onboarding row: onboarding creates a brand-new
 * client's FIRST property, and its replay window (a lost-response retry) is
 * seconds — no workspace edit can predate it. KNOWN RACE (accepted, mirrors
 * ensurePlan): properties has no per-client unique constraint, so two TRULY
 * concurrent submits can both read "none" and both insert a website; sequential
 * lost-response retries — the case onboarding idempotency closes — are fully
 * idempotent. A unique index would need the post-freeze schema path.
 *
 * Any read/write failure returns ok:false — the caller surfaces an honest
 * partial-success warning (client saved, property not), never a silent success.
 */
export async function ensureWebsiteProperty(
  supabase: Supabase,
  tenantId: string,
  clientId: string,
  website: WebsiteInput
): Promise<EnsurePropertyOutcome> {
  const existing = await supabase
    .from("properties")
    .select("id, url, platform")
    .eq("client_id", clientId)
    .eq("type", "website")
    .order("created_at", { ascending: true });
  if (existing.error || !existing.data) {
    logPropertyWriteFailure("property_read", existing.error);
    return { ok: false };
  }

  const rows = existing.data as WebsiteRow[];
  const match = rows.find(
    (row) => row.url === website.url && row.platform === website.platform
  );
  if (match) {
    return {
      ok: true,
      property: { id: match.id, url: website.url, platform: website.platform },
    };
  }

  if (rows.length === 0) {
    const inserted = await supabase
      .from("properties")
      .insert({
        // Claim-sourced tenant scope — RLS re-pins it regardless.
        tenant_id: tenantId,
        client_id: clientId,
        type: "website",
        platform: website.platform,
        url: website.url,
        // NEVER a connected value without a real connection (doc 03 §5); no
        // auth_ref is written here.
        connection_method: "none",
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      logPropertyWriteFailure("property_insert", inserted.error);
      return { ok: false };
    }
    return {
      ok: true,
      property: {
        id: inserted.data.id as string,
        url: website.url,
        platform: website.platform,
      },
    };
  }

  // Diverged: UPDATE-THROUGH the oldest (onboarding) website row. RLS
  // (properties_update) re-pins tenant scope; the eq filters make the
  // claim-sourced scope explicit; select().single() turns a vanished row into
  // an error, never a silent no-op.
  const target = rows[0];
  const updated = await supabase
    .from("properties")
    .update({ url: website.url, platform: website.platform })
    .eq("tenant_id", tenantId)
    .eq("id", target.id)
    .select("id")
    .single();
  if (updated.error || !updated.data) {
    logPropertyWriteFailure("property_update", updated.error);
    return { ok: false };
  }
  return {
    ok: true,
    property: {
      id: updated.data.id as string,
      url: website.url,
      platform: website.platform,
    },
  };
}
