import "server-only";

/**
 * RLS-scoped reads for the Connections surfaces. Same discipline as every
 * operator read: the shared claim-scoped server client (`tryCreateClient`),
 * so RLS is the boundary; env-less, read-failed, and RLS-empty are DISTINCT
 * outcomes the pages render honestly (a read blip never renders as "no
 * clients" / "no such client").
 */

import { tryCreateClient } from "../../../_components/reads";

/** Exactly what the pages render — id (routing) + name (identity). Widen only
 *  with a consumer (e.g. a status pill on the list rows at wiring time). */
export interface ConnectionsClientRow {
  id: string;
  name: string;
}

export type ConnectionsClientList =
  | { status: "ok"; rows: ConnectionsClientRow[] }
  | { status: "env_unset" }
  | { status: "read_failed" };

/** Every client in scope (RLS), newest first — the global page's client half. */
export async function loadConnectionsClientList(): Promise<ConnectionsClientList> {
  const supabase = await tryCreateClient();
  if (!supabase) return { status: "env_unset" };
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .order("created_at", { ascending: false });
    if (error || !data) return { status: "read_failed" };
    return { status: "ok", rows: data as ConnectionsClientRow[] };
  } catch {
    return { status: "read_failed" };
  }
}

export type ConnectionsClientHeader =
  | { status: "ok"; client: ConnectionsClientRow }
  | { status: "not_found" }
  | { status: "env_unset" }
  | { status: "read_failed" };

/** One client's header for the per-client page. RLS-empty = not_found (a
 *  foreign id and a nonexistent id are the same observation, by design). */
export async function loadConnectionsClientHeader(
  clientId: string
): Promise<ConnectionsClientHeader> {
  const supabase = await tryCreateClient();
  if (!supabase) return { status: "env_unset" };
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name")
      .eq("id", clientId)
      .maybeSingle();
    if (error) return { status: "read_failed" };
    if (!data) return { status: "not_found" };
    return { status: "ok", client: data as ConnectionsClientRow };
  } catch {
    return { status: "read_failed" };
  }
}
