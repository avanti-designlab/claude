import "server-only";

/**
 * RLS-scoped reads for the Brand Kits studio routes. These never widen scope:
 * they use the shared claim-scoped server client (`tryCreateClient`), so every
 * row is pinned to `tenant_id = app.tenant_id()` (and client-scope for a viewer)
 * in the database. App code writes no tenant filter — RLS is the boundary.
 *
 * The kit READS themselves (current locked kit + version history) go through the
 * frozen M7 actions (`readLockedBrandKit` / `listBrandKitVersionHistory`); this
 * module only adds the client-directory reads the studio pages need around them:
 * a single client header, and the ingest picker's "who can get a kit" split.
 */

import { tryCreateClient } from "../../../_components/reads";
import type { ClientStatus } from "@/lib/types/db";
import type { Vertical } from "@/lib/types/playbook";

export interface ClientHeader {
  id: string;
  name: string;
  vertical: Vertical;
  status: ClientStatus;
}

/**
 * One client's header, or null when the id is out of the caller's scope (RLS
 * returned nothing — indistinguishable from "doesn't exist", by design) or the
 * runtime env is not provisioned. The caller maps null to a clean not-found.
 */
export async function loadClientHeader(clientId: string): Promise<ClientHeader | null> {
  const supabase = await tryCreateClient();
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, vertical, status")
      .eq("id", clientId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as ClientHeader;
    return { id: row.id, name: row.name, vertical: row.vertical, status: row.status };
  } catch {
    return null;
  }
}

export interface PickerClient {
  id: string;
  name: string;
  vertical: Vertical;
  status: ClientStatus;
}

export type IngestPickerLoad =
  | { ok: false }
  | { ok: true; eligible: PickerClient[]; withKit: PickerClient[] };

/**
 * The ingest picker's data: every client in scope, split by whether they already
 * have a brand kit. Clients WITHOUT a kit are offerable for create; clients WITH
 * one route to revise (create refuses a second kit — M7's already_exists gate).
 *
 * "Has a kit" = has any `brand_kits` row (persistence is insert-only and stores
 * only locked captures, so a row's mere existence means a locked kit exists).
 * Both reads are RLS-scoped; the set intersection is done in app code, never a
 * cross-tenant query.
 */
export async function loadIngestPicker(): Promise<IngestPickerLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const [clientsRes, kitsRes] = await Promise.all([
      supabase
        .from("clients")
        .select("id, name, vertical, status")
        .order("created_at", { ascending: false }),
      supabase.from("brand_kits").select("client_id"),
    ]);
    if (clientsRes.error || !clientsRes.data) return { ok: false };
    if (kitsRes.error || !kitsRes.data) return { ok: false };

    const withKitIds = new Set(
      (kitsRes.data as Array<{ client_id: string }>).map((r) => r.client_id),
    );
    const clients = clientsRes.data as PickerClient[];
    const eligible: PickerClient[] = [];
    const withKit: PickerClient[] = [];
    for (const c of clients) {
      (withKitIds.has(c.id) ? withKit : eligible).push({
        id: c.id,
        name: c.name,
        vertical: c.vertical,
        status: c.status,
      });
    }
    return { ok: true, eligible, withKit };
  } catch {
    return { ok: false };
  }
}
