import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon, CloudOffIcon, ImagePlusIcon, UsersRoundIcon } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Entrance } from "@/components/moments";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
} from "../../../_components/surface";
import { loadAssetPickerClients } from "../_components/asset-reads";

export const metadata: Metadata = {
  title: "Brand assets — AEO/GEO + Brand Production OS",
  description: "Pick a client to open their brand asset library.",
};

/**
 * Cold entry to the Brand Asset Library: pick a client, then step into their own
 * home of assets (/brand-kits/[clientId]/assets). Every client is listed (a kit
 * is not required to hold assets), RLS-scoped. A static segment alongside the
 * dynamic [clientId] — same pattern the existing `new` route already uses.
 */
export default async function AssetLibraryPickerPage() {
  const load = await loadAssetPickerClients();

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Brand Kits"
          title="Brand assets"
          description="Open a client's asset library — their own home for logos, favicons, iconography, and imagery. Assets are filed per client and never shared across clients."
        />
      </Entrance>

      <Entrance step={1}>
        {!load.ok ? (
          load.reason === "env_unset" ? (
            <EmptyState
              icon={CloudOffIcon}
              title="Workspace not connected"
              description="Client asset libraries load once this workspace's storage and database are wired up."
            />
          ) : (
            <FailedState subject="your clients" />
          )
        ) : load.clients.length === 0 ? (
          <EmptyState
            icon={UsersRoundIcon}
            title="No clients yet"
            description="Add a client through onboarding first — then their brand asset library lives here."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {load.clients.map((client) => (
              <Link
                key={client.id}
                href={`/brand-kits/${client.id}/assets`}
                className="group block h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                <Card className="h-full gap-3 py-5 transition-colors group-hover:border-accent/40">
                  <div className="flex flex-col gap-3 px-6">
                    <div className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                      >
                        <ImagePlusIcon className="size-4 text-accent" strokeWidth={2} />
                      </span>
                      <span className="truncate font-medium text-ink">{client.name}</span>
                    </div>
                    <span className="inline-flex items-center gap-1 text-xs text-muted group-hover:text-accent">
                      Open asset library <ArrowRightIcon className="size-3.5" aria-hidden />
                    </span>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </Entrance>

      {load.ok && load.capped ? (
        <p className="text-xs text-muted">
          Showing the most recently added clients. If a client isn’t listed, open their workspace
          to reach theirs.
        </p>
      ) : null}
    </PageContainer>
  );
}
