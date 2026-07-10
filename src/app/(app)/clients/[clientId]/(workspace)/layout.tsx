import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getClaims } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { isUuidV4 } from "@/lib/clients/validate";
import { verticalLabel } from "@/lib/clients/format";
import type { ClientLocation, ClientStatus } from "@/lib/types/db";
import type { Vertical } from "@/lib/types/playbook";
import { WorkspaceTabs } from "./workspace-tabs";

/**
 * The operator CLIENT WORKSPACE shell (doc 07 IA). One nested layout that wraps
 * every workspace tab (Overview, Plan, Audit, Visibility, Crawler Health,
 * Content Decay, Local SEO, Reviews, PR & Entity, Site Changes) with a shared
 * client header + routed tab bar. It sits in a `(workspace)` route group so the
 * client-facing white-label report at `/clients/[clientId]/dashboard` stays
 * OUTSIDE this operator chrome (that route wears the tenant brand, alone).
 *
 * SCOPING (same discipline as the M19 dashboard):
 *  - A malformed id can never name a real row → notFound before any read.
 *  - A `client_viewer` is confined to their OWN report — the operator workspace
 *    is off-limits, so we redirect them to their dashboard (RLS would also stop
 *    them; this is explicit confinement, not the sole gate).
 *  - The client header read is RLS-scoped: an out-of-scope id returns nothing
 *    → notFound. Env-less build degrades to a neutral header, never a 500.
 */

interface ClientHeader {
  id: string;
  name: string;
  vertical: Vertical;
  status: ClientStatus;
  locations: ClientLocation[];
}

const STATUS_VARIANT: Record<ClientStatus, "default" | "secondary" | "outline"> =
  {
    onboarding: "secondary",
    active: "default",
    paused: "outline",
    archived: "outline",
  };

type HeaderLoad =
  | { ok: false }
  | { ok: true; found: false }
  | { ok: true; found: true; client: ClientHeader };

async function loadHeader(clientId: string): Promise<HeaderLoad> {
  let supabase: Awaited<ReturnType<typeof createClient>>;
  try {
    supabase = await createClient();
  } catch {
    return { ok: false };
  }
  try {
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, vertical, status, locations")
      .eq("id", clientId)
      .maybeSingle();
    if (error) return { ok: false };
    if (!data) return { ok: true, found: false };
    const row = data as {
      id: string;
      name: string;
      vertical: Vertical;
      status: ClientStatus;
      locations: ClientLocation[] | null;
    };
    return {
      ok: true,
      found: true,
      client: {
        id: row.id,
        name: row.name,
        vertical: row.vertical,
        status: row.status,
        locations: Array.isArray(row.locations) ? row.locations : [],
      },
    };
  } catch {
    return { ok: false };
  }
}

export default async function ClientWorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  if (!isUuidV4(clientId)) notFound();

  const claims = await getClaims();
  if (claims?.role === "client_viewer") {
    redirect(`/clients/${clientId}/dashboard`);
  }

  const load = await loadHeader(clientId);
  if (load.ok && !load.found) notFound();
  const client = load.ok && load.found ? load.client : null;
  const locationCount = client?.locations.length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 sm:py-8">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-sm text-muted"
      >
        <Link
          href="/clients"
          className="rounded outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          Clients
        </Link>
        <ChevronRightIcon aria-hidden className="size-3.5" />
        <span className="truncate text-ink">{client?.name ?? "Client"}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            {client?.name ?? "Client workspace"}
          </h1>
          {client ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={STATUS_VARIANT[client.status]} className="font-mono text-[10px] uppercase">
                {client.status}
              </Badge>
              <Badge variant="secondary">{verticalLabel(client.vertical)}</Badge>
              <span className="text-xs text-muted">
                {locationCount} {locationCount === 1 ? "location" : "locations"}
              </span>
            </div>
          ) : (
            <p className="text-sm text-muted">
              This workspace is running in a limited mode — refresh once your
              connection is back.
            </p>
          )}
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={`/clients/${clientId}/dashboard`}>
            <ExternalLinkIcon aria-hidden /> Client report
          </Link>
        </Button>
      </div>

      <WorkspaceTabs clientId={clientId} />

      <div className="flex flex-1 flex-col">{children}</div>
    </div>
  );
}
