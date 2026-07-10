import type { Metadata } from "next";
import Link from "next/link";
import { LockIcon, PaletteIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Entrance } from "@/components/moments";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  StatusPill,
} from "../../_components/surface";
import { resolveClientNames, tryCreateClient } from "../../_components/reads";

export const metadata: Metadata = {
  title: "Brand Kits — AEO/GEO + Brand Production OS",
  description: "The locked brand systems that force every client's output on-brand.",
};

/**
 * Brand Kits (global) — the library of locked, versioned client brand systems
 * (M7). Reads the `brand_kits` table RLS-scoped; each kit is immutable once
 * locked, so production (content + media) is forced on-brand. Ingesting a new
 * kit is a workspace action that arrives with the brand-kit wave; this is the
 * honest library view.
 */

/** Card cap for the library — surfaced honestly when it's at the cap. */
const KIT_LIMIT = 60;

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

interface KitEntry {
  id: string;
  clientId: string;
  version: number;
  locked: boolean;
  updatedAt: string;
}

type Load =
  | { ok: false }
  | { ok: true; kits: KitEntry[]; names: Map<string, string> };

async function load(): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const { data, error } = await supabase
      .from("brand_kits")
      .select("id, client_id, version, locked, updated_at")
      .order("updated_at", { ascending: false })
      .limit(KIT_LIMIT);
    if (error || !data) return { ok: false };
    const kits: KitEntry[] = (
      data as Array<{
        id: string;
        client_id: string;
        version: number;
        locked: boolean;
        updated_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      clientId: r.client_id,
      version: r.version,
      locked: r.locked,
      updatedAt: r.updated_at,
    }));
    const names = await resolveClientNames(
      supabase,
      kits.map((k) => k.clientId),
    );
    return { ok: true, kits, names };
  } catch {
    return { ok: false };
  }
}

export default async function BrandKitsPage() {
  const result = await load();

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Studios"
          title="Brand Kits"
          description="Each client's brand — palette, type, voice, and likeness — encoded once into a locked, enforceable kit so everything ships looking like the same brand."
        />
      </Entrance>

      <Entrance step={1}>
        {!result.ok ? (
          <FailedState subject="brand kits" />
        ) : result.kits.length === 0 ? (
          <EmptyState
            icon={PaletteIcon}
            title="No brand kits yet"
            description="A kit is ingested once per client — logo, palette, type, voice, and likeness references — then locked. Kits appear here as clients are set up."
            action={
              <Button asChild size="sm">
                <Link href="/onboarding">Onboard a client</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.kits.map((kit) => {
              const name = result.names.get(kit.clientId) ?? "A client";
              return (
                <Card key={kit.id} className="h-full gap-3 py-5">
                  <div className="flex flex-col gap-3 px-6">
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden
                          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                        >
                          <PaletteIcon
                            className="size-4 text-accent"
                            strokeWidth={2}
                          />
                        </span>
                        <Link
                          href={`/clients/${kit.clientId}`}
                          className="truncate font-medium text-ink underline-offset-4 hover:underline"
                        >
                          {name}
                        </Link>
                      </span>
                      {kit.locked ? (
                        <StatusPill tone="positive">
                          <LockIcon className="mr-1 size-3" aria-hidden />
                          Locked
                        </StatusPill>
                      ) : (
                        <StatusPill tone="warm">Draft</StatusPill>
                      )}
                    </div>
                    <div className="flex items-center justify-between border-t border-border pt-3 text-xs">
                      <span className="text-muted">Version</span>
                      <Badge
                        variant="secondary"
                        className="font-mono text-[10px] uppercase"
                      >
                        v{kit.version}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted">Updated</span>
                      <span className="font-mono text-ink">
                        {medDate(kit.updatedAt)}
                      </span>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Entrance>

      {result.ok && result.kits.length === KIT_LIMIT ? (
        <p className="text-xs text-muted">
          Showing the {KIT_LIMIT} most recently updated kits.
        </p>
      ) : null}
    </PageContainer>
  );
}
