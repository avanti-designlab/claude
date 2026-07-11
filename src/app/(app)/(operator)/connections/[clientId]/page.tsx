import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon, CloudOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Entrance } from "@/components/moments";
import { isUuidV4 } from "@/lib/clients/validate";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../../_components/surface";
import {
  CLIENT_CONNECTORS,
  WEBSITE_CONNECTOR_KEY,
  type ClientConnector,
} from "../catalog";
import { loadConnectionsClientHeader } from "../_components/reads";

export const metadata: Metadata = {
  title: "Client connections — AEO/GEO + Brand Production OS",
  description:
    "One client’s own connections — their analytics, profiles, channels, and website.",
};

/**
 * One client’s connections home (Orchestrator scope ruling, 2026-07-11 —
 * operator-directed: "we need to have those connectors available for each
 * client since each have their own systems"). The per-client sub-route pattern
 * (brand-assets precedent): client-scoped by the URL’s clientId, RLS the real
 * boundary below, NOT a workspace tab — the tab-grouping decision for an 11th
 * tab is a recorded pending item, the bar already scrolls on mobile, and this
 * surface becomes the credential/OAuth home at wiring time, so it lives under
 * the operator-guarded connections route and survives that transition in
 * place.
 *
 * TODAY this is status-only and STRUCTURAL: no vendor-config storage exists,
 * so every connector reads "Not set up yet" by design — no credential forms,
 * no fake connect buttons. The one live half is the client’s website:
 * registration ships on their Properties panel, and that row routes there.
 * At wiring time each row gains its real connect affordance HERE, behind the
 * same guardOperatorSurface() chain (the global page’s guard-mechanic note —
 * ƒ dynamic in every config, request-time fail-closed — applies to this route
 * too: the header read here touches cookies() the same way).
 */
export default async function ClientConnectionsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  if (!isUuidV4(clientId)) notFound();

  const header = await loadConnectionsClientHeader(clientId);
  if (header.status === "not_found") notFound();

  const pageHeader = (title: string) => (
    <Entrance step={0}>
      <PageHeader
        eyebrow="Connections · Client"
        title={title}
        description="This client’s own accounts — their analytics, profiles, channels, and website. Nothing here is shared with another client."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/connections">
              <ArrowLeftIcon aria-hidden /> All connections
            </Link>
          </Button>
        }
      />
    </Entrance>
  );

  if (header.status === "env_unset") {
    return (
      <PageContainer>
        {pageHeader("Client connections")}
        <Entrance step={1}>
          <EmptyState
            icon={CloudOffIcon}
            title="Workspace not connected"
            description="Client records live in the connected workspace. Once the workspace database is wired up, this client’s connections load here."
          />
        </Entrance>
      </PageContainer>
    );
  }

  if (header.status === "read_failed") {
    return (
      <PageContainer>
        {pageHeader("Client connections")}
        <Entrance step={1}>
          <FailedState subject="this client" />
        </Entrance>
      </PageContainer>
    );
  }

  const client = header.client;

  return (
    <PageContainer>
      {pageHeader(client.name)}

      <Entrance step={1}>
        <PanelCard
          title="Their connections"
          description="Each of these is authorized with this client’s own accounts when vendor wiring goes live."
        >
          <ul className="flex flex-col">
            {CLIENT_CONNECTORS.map((connector, i) => (
              <ClientRow
                key={connector.key}
                connector={connector}
                clientId={client.id}
                first={i === 0}
              />
            ))}
          </ul>
        </PanelCard>
      </Entrance>

      <Entrance step={2}>
        <footer className="border-t border-border pt-6">
          <p className="max-w-3xl text-xs leading-5 text-muted">
            Statuses here are structural: no external service is wired yet, so
            everything reads &ldquo;Not set up yet&rdquo; by design — not from a
            failed check. When vendor wiring goes live, this page is where you
            connect this client&rsquo;s accounts, and it reads their real state.
          </p>
        </footer>
      </Entrance>
    </PageContainer>
  );
}

function ClientRow({
  connector,
  clientId,
  first,
}: {
  connector: ClientConnector;
  clientId: string;
  first: boolean;
}) {
  const Icon = connector.icon;
  const isWebsite = connector.key === WEBSITE_CONNECTOR_KEY;
  return (
    <li
      className={
        "flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6" +
        (first ? "" : " border-t border-border")
      }
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
        >
          <Icon className="size-4 text-muted" strokeWidth={1.75} />
        </span>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-ink">{connector.name}</span>
          <p className="max-w-xl text-xs leading-5 text-muted">
            {connector.unlocksClient}
          </p>
          {isWebsite ? (
            <Link
              href={`/clients/${clientId}/overview`}
              className="inline-flex w-fit items-center gap-1 rounded text-xs font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              Manage on their Properties panel
              <ArrowRightIcon aria-hidden className="size-3" strokeWidth={2} />
            </Link>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1 pl-12 sm:items-end sm:pl-0 sm:text-right">
        {isWebsite ? (
          <StatusPill tone="accent">Registration live</StatusPill>
        ) : (
          <>
            <StatusPill tone="muted">Not set up yet</StatusPill>
            <span className="text-[11px] leading-4 text-muted">
              Setup arrives with vendor wiring
            </span>
          </>
        )}
      </div>
    </li>
  );
}
