import type { Metadata } from "next";
import Link from "next/link";
import { PlusIcon, UsersRoundIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Entrance } from "@/components/moments";
import { createClient } from "@/lib/supabase/server";
import { verticalLabel } from "@/lib/clients/format";
import type { ClientRow } from "@/lib/types/db";

export const metadata: Metadata = {
  title: "Clients — AEO/GEO + Brand Production OS",
  description: "The clients in your workspace.",
};

/**
 * Clients list — the read-back half of the loop (login → onboard → saved →
 * listed). This is a Server Component using the RLS-scoped server client (anon
 * key + the caller's cookies), so the query returns ONLY this tenant's clients:
 * `clients_select` policy pins `tenant_id = app.tenant_id()` in the database.
 * No tenant filter is written in app code — RLS is the boundary. The (app)
 * layout has already verified the session before we get here.
 */

type ClientListRow = Pick<
  ClientRow,
  "id" | "name" | "vertical" | "status" | "locations" | "created_at"
>;

const STATUS_VARIANT: Record<
  ClientRow["status"],
  "default" | "secondary" | "outline"
> = {
  onboarding: "secondary",
  active: "default",
  paused: "outline",
  archived: "outline",
};

async function loadClients(): Promise<
  { ok: true; clients: ClientListRow[] } | { ok: false }
> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("clients")
      .select("id, name, vertical, status, locations, created_at")
      .order("created_at", { ascending: false });
    if (error || !data) return { ok: false };
    return { ok: true, clients: data as ClientListRow[] };
  } catch {
    // e.g. runtime env not provisioned yet — degrade gracefully rather than 500.
    return { ok: false };
  }
}

export default async function ClientsPage() {
  const result = await loadClients();

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <Entrance
        step={0}
        className="flex flex-wrap items-end justify-between gap-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
            Clients
          </h1>
          <p className="text-sm text-muted">
            Everyone in your workspace. Onboarding a client saves them here.
          </p>
        </div>
        <Button asChild>
          <Link href="/onboarding">
            <PlusIcon aria-hidden /> Onboard a client
          </Link>
        </Button>
      </Entrance>

      {!result.ok ? (
        <Entrance step={1}>
          <Card className="flex flex-col items-center gap-3 border-dashed py-16 text-center">
            <p className="max-w-md px-6 text-sm text-muted">
              We couldn’t load your clients right now. Check your connection and
              refresh — your data is safe.
            </p>
          </Card>
        </Entrance>
      ) : result.clients.length === 0 ? (
        <Entrance step={1}>
          <Card className="flex flex-col items-center gap-4 border-dashed py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full bg-overlay">
              <UsersRoundIcon aria-hidden className="size-5 text-accent" />
            </span>
            <div className="flex max-w-md flex-col gap-1 px-6">
              <h2 className="font-display text-2xl text-ink">No clients yet</h2>
              <p className="text-sm text-muted">
                Your book starts with one. Onboard your first client — pick their
                industry, add locations, and reveal a real plan.
              </p>
            </div>
            <Button asChild>
              <Link href="/onboarding">
                <PlusIcon aria-hidden /> Onboard a client
              </Link>
            </Button>
          </Card>
        </Entrance>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {result.clients.map((client, index) => {
            const locationCount = Array.isArray(client.locations)
              ? client.locations.length
              : 0;
            return (
              <Entrance key={client.id} step={1 + index}>
                <Card className="h-full gap-3 py-5">
                  <div className="flex flex-col gap-3 px-6">
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate font-medium text-ink">
                        {client.name}
                      </span>
                      <Badge
                        variant={STATUS_VARIANT[client.status]}
                        className="shrink-0 font-mono text-[10px] uppercase"
                      >
                        {client.status}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {verticalLabel(client.vertical)}
                      </Badge>
                      <span className="text-xs text-muted">
                        {locationCount}{" "}
                        {locationCount === 1 ? "location" : "locations"}
                      </span>
                    </div>
                  </div>
                </Card>
              </Entrance>
            );
          })}
        </div>
      )}
    </div>
  );
}
