import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, ImagesIcon, LockIcon, PaletteIcon, PlusIcon } from "lucide-react";

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
 * Brand Kits (global) — the library of locked, versioned client brand systems.
 * Each client is ONE card showing its CURRENT (highest) version; earlier versions
 * live in the kit's own history (persistence is insert-only, one row per version).
 * Cards link to the kit detail; the header offers the ingest flow.
 */

/** How many version rows to scan (RLS-scoped) before deduping to current-per-client. */
const ROW_FETCH = 500;
/** How many distinct clients' kits to surface. */
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
  clientId: string;
  version: number;
  locked: boolean;
  updatedAt: string;
}

type Load =
  | { ok: false }
  | {
      ok: true;
      kits: KitEntry[];
      names: Map<string, string>;
      /** More distinct clients than the card display cap. */
      capped: boolean;
      /** The row SCAN hit its window — clients whose newest version row is older
       * than the window may be missing entirely (surfaced honestly below). */
      scanCapped: boolean;
    };

async function load(): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const { data, error } = await supabase
      .from("brand_kits")
      .select("client_id, version, locked, updated_at")
      // RECENCY order, not version order: persistence is insert-only, so a
      // client's newest-updated row IS its highest version — the first row seen
      // per client is its current version. Ordering by version desc instead
      // would push every low-version-only client (v1 kits) to the very end of
      // the scan window and silently drop them first; recency order truncates
      // fairly (least recently updated clients fall out last) and matches the
      // "most recently updated" copy below.
      .order("updated_at", { ascending: false })
      .limit(ROW_FETCH);
    if (error || !data) return { ok: false };

    const rows = data as Array<{
      client_id: string;
      version: number;
      locked: boolean;
      updated_at: string;
    }>;
    // Dedupe to one card per client (first seen = current version, see above).
    const current = new Map<string, KitEntry>();
    for (const r of rows) {
      if (current.has(r.client_id)) continue;
      current.set(r.client_id, {
        clientId: r.client_id,
        version: r.version,
        locked: r.locked,
        updatedAt: r.updated_at,
      });
    }
    const all = [...current.values()];
    const kits = all.slice(0, KIT_LIMIT);
    const names = await resolveClientNames(
      supabase,
      kits.map((k) => k.clientId),
    );
    return {
      ok: true,
      kits,
      names,
      capped: all.length > KIT_LIMIT,
      scanCapped: rows.length === ROW_FETCH,
    };
  } catch {
    return { ok: false };
  }
}

export default async function BrandKitsPage() {
  const result = await load();

  // Asset library is reachable even with zero kits (clients can hold assets
  // without a locked kit); ingest is offered only once kits exist.
  const headerActions = (
    <div className="flex items-center gap-2">
      <Button asChild variant="outline" size="sm">
        <Link href="/brand-kits/assets">
          <ImagesIcon aria-hidden /> Asset library
        </Link>
      </Button>
      {result.ok && result.kits.length > 0 ? (
        <Button asChild size="sm">
          <Link href="/brand-kits/new">
            <PlusIcon aria-hidden /> Ingest a kit
          </Link>
        </Button>
      ) : null}
    </div>
  );

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Studios"
          title="Brand Kits"
          description="Each client's brand — palette, type, voice, and likeness — encoded once into a locked, enforceable kit so everything ships looking like the same brand."
          actions={headerActions}
        />
      </Entrance>

      <Entrance step={1}>
        {!result.ok ? (
          <FailedState subject="brand kits" />
        ) : result.kits.length === 0 ? (
          <EmptyState
            icon={PaletteIcon}
            title="No brand kits yet"
            description="A kit is ingested once per client — logo, palette, type, voice, and likeness references — then locked. Content and media generation stay blocked until a client has one."
            action={
              <Button asChild size="sm">
                <Link href="/brand-kits/new">Ingest a kit</Link>
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.kits.map((kit) => {
              const name = result.names.get(kit.clientId) ?? "A client";
              return (
                <Link
                  key={kit.clientId}
                  href={`/brand-kits/${kit.clientId}`}
                  className="group block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <Card className="h-full gap-3 py-5 transition-colors group-hover:border-accent/40">
                    <div className="flex flex-col gap-3 px-6">
                      <div className="flex items-start justify-between gap-2">
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden
                            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                          >
                            <PaletteIcon className="size-4 text-accent" strokeWidth={2} />
                          </span>
                          <span className="truncate font-medium text-ink">{name}</span>
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
                        <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                          v{kit.version}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted">Updated</span>
                        <span className="font-mono text-ink">{medDate(kit.updatedAt)}</span>
                      </div>
                      <span className="inline-flex items-center gap-1 text-xs text-muted group-hover:text-accent">
                        View kit <ArrowRightIcon className="size-3.5" aria-hidden />
                      </span>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </Entrance>

      {result.ok && (result.capped || result.scanCapped) ? (
        <p className="text-xs text-muted">
          {result.scanCapped
            ? `Built from the ${ROW_FETCH} most recently updated kit versions — clients whose kit hasn't changed in a long time may not appear. Open a client's workspace to find theirs.`
            : `Showing the ${KIT_LIMIT} most recently updated kits.`}
        </p>
      ) : null}
    </PageContainer>
  );
}
