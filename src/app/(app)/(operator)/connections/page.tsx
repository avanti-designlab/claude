import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  CloudOffIcon,
  UsersRoundIcon,
} from "lucide-react";

import { Entrance } from "@/components/moments";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import {
  CLIENT_CONNECTORS,
  PLATFORM_CONNECTORS,
  WEBSITE_CONNECTOR_KEY,
  type ClientConnector,
  type PlatformConnector,
} from "./catalog";
import { loadConnectionsClientList } from "./_components/reads";

export const metadata: Metadata = {
  title: "Connections — AEO/GEO + Brand Production OS",
  description:
    "Which external services are connected — the platform’s own, and each client’s.",
};

/**
 * Connections (global) — restructured per the Orchestrator’s scope ruling
 * (2026-07-11, operator-directed: "certain connectors are one-time for the
 * whole app; others need to be installed per client"). TWO clearly-labeled
 * halves, one shared catalog (./catalog.ts):
 *
 *  - PLATFORM CONNECTIONS — connect once, powers every client (the agency’s
 *    own AI/vendor subscriptions).
 *  - CLIENT CONNECTIONS — set up per client (each client’s own GA4, Search
 *    Console, call tracking, Business Profile, review profiles, social
 *    channels, and website), with the RLS-scoped client list routing to each
 *    client’s own /connections/[clientId] page. The website type folds in
 *    here (registration is live on Properties; the row says so).
 *
 * ALL PRIOR HONESTY RULES CARRY UNCHANGED: nothing is wired, no vendor-config
 * storage exists, so vendor statuses are STRUCTURAL "Not connected" — no
 * credential forms, no fake connect buttons, no progress. The one real read on
 * this page is the client list (RLS-scoped); its failure renders as a read
 * failure, never as "no clients".
 *
 * GUARD MECHANIC (re-verified by Code Review 2026-07-11 — this slice CHANGED
 * it): this route now renders ƒ DYNAMIC in EVERY build config, env-less
 * included, because the page's own client-list read touches cookies()
 * (tryCreateClient → createClient() reads them before the env check throws).
 * The pre-slice mechanic — an env-less static 307 → /login baked at build
 * time — no longer applies here (it still does on read-less operator pages
 * like /measurement). Confinement is request-time and fail-closed: the (app)
 * layout's verified-session read redirects a null session to /login, and this
 * group's guardOperatorSurface() confines roles. A refactor moving either out
 * of the layout chain (or adding `revalidate`/static hints here) must
 * re-verify. The same applies to the per-client sub-route.
 */

type ConnectionStatus = "not_connected";

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  not_connected: "Not connected",
};

function PortRow({
  name,
  icon: Icon,
  unlocks,
  first,
  statusCell,
}: {
  name: string;
  icon: PlatformConnector["icon"];
  unlocks: string;
  first: boolean;
  /** The right-hand cell — an honest pill (+ note) or a real link. */
  statusCell: React.ReactNode;
}) {
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
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink">{name}</span>
          <p className="max-w-xl text-xs leading-5 text-muted">{unlocks}</p>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1 pl-12 sm:items-end sm:pl-0 sm:text-right">
        {statusCell}
      </div>
    </li>
  );
}

/** The honest not-connected status cell (structural — nothing is wired). */
function NotConnectedCell() {
  return (
    <>
      <StatusPill tone="muted">{STATUS_LABEL.not_connected}</StatusPill>
      <span className="text-[11px] leading-4 text-muted">
        Setup arrives with vendor wiring
      </span>
    </>
  );
}

function ClientTypeRow({ connector, first }: { connector: ClientConnector; first: boolean }) {
  // The website type is the one client connector with a live half today:
  // registration ships on each client’s Properties panel.
  const isWebsite = connector.key === WEBSITE_CONNECTOR_KEY;
  return (
    <PortRow
      name={connector.name}
      icon={connector.icon}
      unlocks={connector.unlocksGlobal}
      first={first}
      statusCell={
        isWebsite ? (
          <>
            <StatusPill tone="accent">Registration live</StatusPill>
            <span className="text-[11px] leading-4 text-muted">
              Managed on each client&rsquo;s Properties panel
            </span>
          </>
        ) : (
          <NotConnectedCell />
        )
      }
    />
  );
}

export default async function ConnectionsPage() {
  const clients = await loadConnectionsClientList();

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Workspace"
          title="Connections"
          description="Two kinds of connections power the platform: the agency’s own services, connected once — and each client’s own accounts, set up per client."
        />
      </Entrance>

      <Entrance step={1}>
        <p className="max-w-3xl text-sm leading-6 text-muted">
          Nothing is connected yet. Every integration below is deferred and
          fail-closed by design, so there is nothing to configure here today —
          connection setup arrives with the vendor-wiring work. This board is
          the honest map of what each connection unlocks and the surface it
          lands on.
        </p>
      </Entrance>

      <Entrance step={2}>
        <PanelCard
          title="Platform connections"
          description="Connect once — these power every client. The agency’s own AI and data subscriptions."
        >
          <ul className="flex flex-col">
            {PLATFORM_CONNECTORS.map((port, i) => (
              <PortRow
                key={port.key}
                name={port.name}
                icon={port.icon}
                unlocks={port.unlocks}
                first={i === 0}
                statusCell={<NotConnectedCell />}
              />
            ))}
          </ul>
        </PanelCard>
      </Entrance>

      <Entrance step={3}>
        <PanelCard
          title="Client connections"
          description="Set up per client — every client authorizes their own accounts, so their numbers and channels are always their own."
        >
          <ul className="flex flex-col">
            {CLIENT_CONNECTORS.map((connector, i) => (
              <ClientTypeRow key={connector.key} connector={connector} first={i === 0} />
            ))}
          </ul>
        </PanelCard>
      </Entrance>

      <Entrance step={4}>
        <PanelCard
          title="Set up by client"
          description="Each client’s own connections home — their status in one place"
        >
          {clients.status === "env_unset" ? (
            <EmptyState
              icon={CloudOffIcon}
              title="Workspace not connected"
              description="The client list lives in the connected workspace. Once the workspace database is wired up, your clients appear here with their own connections pages."
            />
          ) : clients.status === "read_failed" ? (
            // A read blip must never render as "no clients yet" — the shared
            // failed-state primitive, same as every operator surface.
            <FailedState subject="your client list" />
          ) : clients.rows.length === 0 ? (
            <EmptyState
              icon={UsersRoundIcon}
              title="No clients yet"
              description="Once you onboard a client, their connections home appears here."
              action={
                <Link
                  href="/onboarding"
                  className="inline-flex items-center gap-1 rounded text-sm font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  Onboard a client
                  <ArrowRightIcon aria-hidden className="size-3.5" strokeWidth={2} />
                </Link>
              }
            />
          ) : (
            <ul className="flex flex-col">
              {clients.rows.map((client, i) => (
                <li
                  key={client.id}
                  className={i === 0 ? "" : "border-t border-border"}
                >
                  <Link
                    href={`/connections/${client.id}`}
                    className="group flex items-center justify-between gap-4 rounded px-1 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <span className="text-sm font-medium text-ink group-hover:text-accent">
                      {client.name}
                    </span>
                    <span className="flex items-center gap-1 text-xs text-muted">
                      Their connections
                      <ArrowRightIcon aria-hidden className="size-3.5" strokeWidth={2} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </PanelCard>
      </Entrance>

      <Entrance step={5}>
        <footer className="border-t border-border pt-6">
          <p className="max-w-3xl text-xs leading-5 text-muted">
            Statuses on this page are structural: no external service is wired
            yet, so every service reads &ldquo;Not connected&rdquo; by design —
            not from a failed check. When connections go live, this board reads
            their real state, including how many clients each per-client
            connector is set up for.
          </p>
        </footer>
      </Entrance>
    </PageContainer>
  );
}
