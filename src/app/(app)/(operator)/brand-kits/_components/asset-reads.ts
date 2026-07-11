import "server-only";

/**
 * RLS-scoped reads for the per-client Brand Asset Library routes. Like
 * kit-reads.ts, these never widen scope: the claim-scoped server client pins
 * every row to `tenant_id = app.tenant_id()` in the database, and the asset LIST
 * itself goes through the LANDED contract (`listBrandAssets`) — this module only
 * adds the client-directory reads the library pages need around it (a single
 * client header, and the cold-entry picker's client list).
 *
 * The library page must tell three "no assets shown" cases apart honestly:
 *   env_unset   — the workspace isn't connected (env-less) → a designed
 *                 "connect your workspace" state, never a crash;
 *   not_found   — the client id is out of the caller's scope / doesn't exist
 *                 (RLS returned nothing — indistinguishable, by design) → 404;
 *   read_failed — a transient read error → a retryable failed state.
 */

import { listBrandAssets } from "@/lib/brand-assets/actions";
import type { BrandAsset } from "@/lib/brand-assets";
import type { ClientStatus } from "@/lib/types/db";
import type { Vertical } from "@/lib/types/playbook";
import { tryCreateClient } from "../../../_components/reads";

export interface AssetClientHeader {
  id: string;
  name: string;
  vertical: Vertical;
  status: ClientStatus;
}

export type AssetLibraryLoad =
  | { status: "env_unset" }
  | { status: "not_found" }
  | { status: "read_failed" }
  | {
      status: "ok";
      client: AssetClientHeader;
      /** The client's live library, or null when the assets read itself failed
       *  (distinct from an empty [] — the page renders a failed-list state, not
       *  "no assets", so a read blip never reads as an empty library). */
      assets: BrandAsset[] | null;
    };

/**
 * Load one client's asset library: the client header (for the page identity) +
 * its assets via the landed `listBrandAssets` contract. Client-scoped by the
 * `clientId` in the URL; RLS is the real boundary below.
 */
export async function loadAssetLibrary(clientId: string): Promise<AssetLibraryLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { status: "env_unset" };

  let client: AssetClientHeader;
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, vertical, status")
      .eq("id", clientId)
      .maybeSingle();
    if (error) return { status: "read_failed" };
    if (!data) return { status: "not_found" };
    const row = data as AssetClientHeader;
    client = { id: row.id, name: row.name, vertical: row.vertical, status: row.status };
  } catch {
    return { status: "read_failed" };
  }

  // The LANDED contract for listing — RLS-scoped to this client's library.
  const res = await listBrandAssets({ clientId });
  return { status: "ok", client, assets: res.ok ? res.assets : null };
}

export interface AssetPickerClient {
  id: string;
  name: string;
  vertical: Vertical;
  status: ClientStatus;
}

export type AssetPickerLoad =
  | { ok: false; reason: "env_unset" | "read_failed" }
  | { ok: true; clients: AssetPickerClient[]; capped: boolean };

/** How many clients the cold-entry picker surfaces (RLS-scoped, newest first). */
const PICKER_LIMIT = 200;

/**
 * Every client in the caller's scope, for the cold-entry picker that lets an
 * operator step into a client's asset library. RLS-scoped; app code writes no
 * tenant filter. A client_viewer never reaches here (the operator layout
 * redirects that role), so this is always a staff-scoped list.
 */
export async function loadAssetPickerClients(): Promise<AssetPickerLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false, reason: "env_unset" };
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, vertical, status")
      .order("created_at", { ascending: false })
      .limit(PICKER_LIMIT + 1);
    if (error || !data) return { ok: false, reason: "read_failed" };
    const rows = data as AssetPickerClient[];
    const capped = rows.length > PICKER_LIMIT;
    return {
      ok: true,
      clients: rows.slice(0, PICKER_LIMIT).map((r) => ({
        id: r.id,
        name: r.name,
        vertical: r.vertical,
        status: r.status,
      })),
      capped,
    };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}
