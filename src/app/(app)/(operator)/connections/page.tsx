import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  GlobeIcon,
  LineChartIcon,
  type LucideIcon,
  MapPinIcon,
  PenLineIcon,
  PhoneIcon,
  SearchIcon,
  Share2Icon,
  ShieldCheckIcon,
  SparklesIcon,
  StarIcon,
  WandSparklesIcon,
} from "lucide-react";

import { Entrance } from "@/components/moments";
import {
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";

export const metadata: Metadata = {
  title: "Connections — AEO/GEO + Brand Production OS",
  description:
    "Which external services are connected, and what each one turns on across the app.",
};

/**
 * Connections (global) — the tenant-level vendor status + roadmap board the UX
 * audit called for (2026-07-10 §2.2). Deliberately UTILITARIAN and QUIET (doc 06
 * §4/§5, operator surface) and, above all, HONEST: today NO external service is
 * connected and there is NO vendor-config storage — every port is deferred and
 * fail-closed by design (the recorded architecture). So this v1 is a status +
 * roadmap page, NOT a credential form: no input fields, no connect buttons, no
 * progress indicators. It has no reads today (there is nothing to read), which
 * the footer says plainly.
 *
 * FORWARD-COMPATIBLE BY SHAPE: every capability renders from a `VendorPort`
 * carrying a `status` (and an optional `action`). Today the status union is the
 * single structural value `not_connected` and no vendor row carries an action;
 * when the visibility/vendor wiring lands, this board gains real reads by
 * widening that union and passing an action — the row renderer does not change.
 *
 * HONESTY RULE (absolute — this page is ALL claims): every "unlocks" sentence is
 * true of a SHIPPED module and names the real surface where its data lands. The
 * mappings are verified against docs 00/05 and the live pages:
 *  - AI-citation data → each client's Visibility tab (M3, shipped). The prompt
 *    clause says "across the playbook's prompt library" — per-prompt rows
 *    persist but the tab renders no per-prompt breakdown yet.
 *  - GA4 / Search Console / call tracking → Measurement (M16); the page already
 *    names these three sources.
 *  - Google Business Profile → each client's Local SEO tab (M14, shipped —
 *    local-pack READINESS, not live rank tracking; rank tracking is its own
 *    deferred vendor, see src/lib/local/types.ts).
 *  - review platforms → each client's Reviews tab (M15, shipped; replies are
 *    always drafted for a human, never auto-sent).
 *  - content generation / humanizer / detectors → the drafts that move through
 *    the Review & Approvals queue (M8/M9, shipped pipeline behind their ports).
 *  - social posting → approved in Review & Approvals, never auto-posted (M11
 *    structurally cannot auto-post; the composing studio is still in build, so
 *    the row doesn't point at it).
 * No internal module codes render anywhere — vendor brand names only.
 *
 * GUARD MECHANIC (Code Review, 2026-07-10): in any env-provisioned build this
 * route renders DYNAMIC because the (app) layout's session read touches
 * cookies(); the env-less build instead bakes a static 307 → /login (verified
 * safe in all three configs). The page's operator confinement therefore depends
 * on the (app) layout's session read AND this group's guardOperatorSurface()
 * staying in the layout chain above it — a refactor that moves either (or adds
 * `revalidate`/static hints here) must re-verify the guard.
 */

/**
 * A connection's live state. Today the ONLY value is the structural
 * `not_connected` — nothing is wired. Widen this union (e.g. add "connected" |
 * "action_needed" | "error") when real reads land; {@link PortRow} renders from
 * it, so the layout does not change.
 */
type ConnectionStatus = "not_connected";

interface VendorPort {
  /** Plain-language capability name — vendor brand names are fine; no codes. */
  name: string;
  icon: LucideIcon;
  /** ONE honest sentence: what connecting it turns on + the real surface it lands on. */
  unlocks: string;
  status: ConnectionStatus;
  /**
   * Forward-looking action seam. UNUSED by vendor rows today (no fake connect
   * buttons) — reserved so a row can gain a real "Connect"/"Manage" affordance
   * later without a redesign.
   */
  action?: { href: string; label: string };
}

interface PortGroup {
  label: string;
  caption: string;
  ports: VendorPort[];
}

const GROUPS: PortGroup[] = [
  {
    label: "Content & AI",
    caption: "The engines that write, humanize, and authenticity-check drafts",
    ports: [
      {
        name: "Content generation (Anthropic)",
        icon: PenLineIcon,
        unlocks:
          "Writes blog, FAQ, and pillar drafts in each client's locked brand voice — the drafts that move through the Review & Approvals queue.",
        status: "not_connected",
      },
      {
        name: "Humanizer",
        icon: WandSparklesIcon,
        unlocks:
          "Runs each draft through a humanization pass so it reads like a person wrote it; the result shows on the content review screen.",
        status: "not_connected",
      },
      {
        name: "AI detectors",
        icon: ShieldCheckIcon,
        unlocks:
          "Scores every draft against AI-detection tools and shows each detector's result on the review screen before anyone approves it.",
        status: "not_connected",
      },
    ],
  },
  {
    label: "Intelligence",
    caption: "Where AI answers come from, measured per client",
    ports: [
      {
        name: "AI-citation data",
        icon: SparklesIcon,
        unlocks:
          "Turns on live citation tracking in each client's Visibility tab — which AI engines cite them across the playbook's prompt library, and where competitors win the answer.",
        status: "not_connected",
      },
    ],
  },
  {
    label: "Measurement",
    caption: "The outcomes that tie visibility to real results, on Measurement",
    ports: [
      {
        name: "Google Analytics (GA4)",
        icon: LineChartIcon,
        unlocks:
          "Brings sessions, engaged sessions, and conversions into Measurement, tying visibility to real site outcomes.",
        status: "not_connected",
      },
      {
        name: "Search Console",
        icon: SearchIcon,
        unlocks:
          "Adds search clicks and impressions to Measurement, so you can see which queries actually reach a client.",
        status: "not_connected",
      },
      {
        name: "Call tracking",
        icon: PhoneIcon,
        unlocks:
          "Counts phone-call and form-fill leads in Measurement — the outcomes that turn visibility into attributed value.",
        status: "not_connected",
      },
    ],
  },
  {
    label: "Local & Reviews",
    caption: "Local presence and reputation, on each client's workspace",
    ports: [
      {
        name: "Google Business Profile",
        icon: MapPinIcon,
        unlocks:
          "Turns on local-pack readiness, NAP consistency, and Business Profile data in each client's Local SEO tab.",
        status: "not_connected",
      },
      {
        name: "Review platforms",
        icon: StarIcon,
        unlocks:
          "Turns on review monitoring and drafted replies in each client's Reviews tab — replies are always drafted for a human to approve, never auto-sent.",
        status: "not_connected",
      },
    ],
  },
  {
    label: "Distribution",
    caption: "Publishing approved work to a client's channels",
    ports: [
      {
        name: "Social posting",
        icon: Share2Icon,
        unlocks:
          "Publishes approved, brand-voice social posts to a client's channels on schedule — approved in Review & Approvals, never auto-posted.",
        status: "not_connected",
      },
    ],
  },
];

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  not_connected: "Not connected",
};

const STATUS_TONE: Record<
  ConnectionStatus,
  React.ComponentProps<typeof StatusPill>["tone"]
> = {
  not_connected: "muted",
};

function PortRow({ port, first }: { port: VendorPort; first: boolean }) {
  const Icon = port.icon;
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
          <span className="text-sm font-medium text-ink">{port.name}</span>
          <p className="max-w-xl text-xs leading-5 text-muted">{port.unlocks}</p>
        </div>
      </div>
      {/* Status cell — where a real action lands later. Today: the honest pill
          plus the standing "not configurable yet" note, no control. */}
      <div className="flex shrink-0 flex-col gap-1 pl-12 sm:items-end sm:pl-0 sm:text-right">
        <StatusPill tone={STATUS_TONE[port.status]}>
          {STATUS_LABEL[port.status]}
        </StatusPill>
        <span className="text-[11px] leading-4 text-muted">
          Setup arrives with vendor wiring
        </span>
      </div>
    </li>
  );
}

export default function ConnectionsPage() {
  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Workspace"
          title="Connections"
          description="Every external service the platform can use — what each one turns on, and where that shows up across your clients."
        />
      </Entrance>

      <Entrance step={1}>
        <p className="max-w-3xl text-sm leading-6 text-muted">
          Nothing is connected yet. Every integration below is deferred and
          fail-closed by design, so there is nothing to configure here today —
          connection setup arrives with the vendor-wiring work. This board is the
          honest map of what each connection unlocks and the surface it lands on,
          so you can see exactly what turns on when the wiring goes live.
        </p>
      </Entrance>

      {GROUPS.map((group, i) => (
        <Entrance key={group.label} step={2 + i}>
          <PanelCard title={group.label} description={group.caption}>
            <ul className="flex flex-col">
              {group.ports.map((port, j) => (
                <PortRow key={port.name} port={port} first={j === 0} />
              ))}
            </ul>
          </PanelCard>
        </Entrance>
      ))}

      {/* Site connections — the half with a shipped home: a client's website is
          REGISTERED per client on their Properties panel (the live connect
          methods arrive with the write-method wiring), not here; route the
          operator there via the Clients list. */}
      <Entrance step={2 + GROUPS.length}>
        <PanelCard
          title="Site connections"
          description="How approved changes reach a client's live website"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
              >
                <GlobeIcon className="size-4 text-muted" strokeWidth={1.75} />
              </span>
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">
                    Client websites
                  </span>
                  <StatusPill tone="accent">Registration live</StatusPill>
                </div>
                <p className="max-w-xl text-xs leading-5 text-muted">
                  Connecting a client&apos;s site — WordPress, Webflow, Wix, or
                  through the edge worker — is what lets approved changes publish
                  with a full diff preview and one-click rollback. Unlike the
                  services above, this is managed per client on their Properties
                  panel. Registering a site — its address and platform — ships
                  today; the live connection methods arrive with the
                  write-method wiring.
                </p>
              </div>
            </div>
            <div className="pl-12">
              <Link
                href="/clients"
                className="inline-flex w-fit items-center gap-1 rounded text-sm font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                Open the Clients list
                <ArrowRightIcon aria-hidden className="size-3.5" strokeWidth={2} />
              </Link>
            </div>
          </div>
        </PanelCard>
      </Entrance>

      <Entrance step={3 + GROUPS.length}>
        <footer className="border-t border-border pt-6">
          <p className="max-w-3xl text-xs leading-5 text-muted">
            Statuses on this page are structural: no external service is wired
            yet, so every service reads &ldquo;Not connected&rdquo; by design —
            not from a failed check. When connections go live, this board reads
            their real state.
          </p>
        </footer>
      </Entrance>
    </PageContainer>
  );
}
