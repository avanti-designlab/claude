import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, PaletteIcon, UsersRoundIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Entrance } from "@/components/moments";
import { verticalLabel } from "@/lib/clients/format";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  StatusPill,
} from "../../../_components/surface";
import { loadIngestPicker, type PickerClient } from "../_components/kit-reads";

export const metadata: Metadata = {
  title: "Ingest a brand kit — AEO/GEO + Brand Production OS",
  description: "Pick a client to encode their brand into a locked, enforceable kit.",
};

/**
 * Ingest picker — step one of creating a brand kit: choose the client. Only
 * clients WITHOUT a kit can be created (a second kit is refused — revise keeps
 * history), so clients split into "ready to ingest" and "already has a kit"
 * (which route to their detail to revise). No clients at all routes to onboarding.
 */
export default async function IngestPickerPage() {
  const result = await loadIngestPicker();

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Brand Kits"
          title="Ingest a brand kit"
          description="Encode a client's brand — palette, type, voice, and likeness — into one locked, enforceable kit. Choose who to build it for."
        />
      </Entrance>

      {!result.ok ? (
        <Entrance step={1}>
          <FailedState subject="your clients" />
        </Entrance>
      ) : result.eligible.length === 0 && result.withKit.length === 0 ? (
        <Entrance step={1}>
          <EmptyState
            icon={UsersRoundIcon}
            title="No clients yet"
            description="A brand kit is built for a client. Onboard your first client — pick their industry and locations — then come back to ingest their brand."
            action={
              <Button asChild size="sm">
                <Link href="/onboarding">Onboard a client</Link>
              </Button>
            }
          />
        </Entrance>
      ) : (
        <>
          <Entrance step={1} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="font-display text-lg font-bold tracking-tight text-ink">
                Ready to ingest
              </h2>
              <p className="text-xs text-muted">
                Clients without a brand kit. Pick one to build theirs.
              </p>
            </div>
            {result.eligible.length === 0 ? (
              <EmptyState
                icon={PaletteIcon}
                title="Every client already has a kit"
                description="Open a client below to revise their kit — revising keeps the full version history."
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {result.eligible.map((client) => (
                  <ClientPickCard key={client.id} client={client} href={`/brand-kits/new/${client.id}`} cta="Ingest kit" />
                ))}
              </div>
            )}
          </Entrance>

          {result.withKit.length > 0 ? (
            <Entrance step={2} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h2 className="font-display text-lg font-bold tracking-tight text-ink">
                  Already has a kit
                </h2>
                <p className="text-xs text-muted">
                  These clients are set up. Open one to view or revise its kit.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {result.withKit.map((client) => (
                  <ClientPickCard
                    key={client.id}
                    client={client}
                    href={`/brand-kits/${client.id}`}
                    cta="Open kit"
                    hasKit
                  />
                ))}
              </div>
            </Entrance>
          ) : null}
        </>
      )}
    </PageContainer>
  );
}

function ClientPickCard({
  client,
  href,
  cta,
  hasKit,
}: {
  client: PickerClient;
  href: string;
  cta: string;
  hasKit?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <Card className="h-full gap-3 py-5 transition-colors group-hover:border-accent/40">
        <div className="flex flex-col gap-3 px-6">
          <div className="flex items-start justify-between gap-2">
            <span className="truncate font-medium text-ink">{client.name}</span>
            {hasKit ? <StatusPill tone="positive">Has kit</StatusPill> : null}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Badge variant="secondary">{verticalLabel(client.vertical)}</Badge>
            <span className="inline-flex items-center gap-1 text-xs text-muted group-hover:text-accent">
              {cta} <ArrowRightIcon className="size-3.5" aria-hidden />
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}
