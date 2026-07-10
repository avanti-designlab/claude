import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  InboxIcon,
  PaletteIcon,
  RocketIcon,
  UsersRoundIcon,
} from "lucide-react";

import { Entrance } from "@/components/moments";
import { Button } from "@/components/ui/button";
import { getClaims } from "@/lib/auth/session";
import { isStaffRole } from "@/lib/auth/parse-claims";
import { isUuidV4 } from "@/lib/clients/validate";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import { WARM_TEXT_CLASS } from "../../_components/tone";
import {
  LANE_LIMIT,
  loadDirectory,
  loadPipeline,
  type DirectoryLoad,
  type LaneSection,
  type PipelineItem,
  type PipelineLoad,
  type StudioClient,
} from "./_components/studio-reads";
import {
  medDateTime,
  STATUS_LABEL,
  STATUS_TONE,
  TYPE_NOUN,
} from "./_components/pipeline";
import { BriefForm } from "./_components/brief-form";
import { DraftAdvance } from "./_components/draft-actions";

export const metadata: Metadata = {
  title: "Content Studio — AEO/GEO + Brand Production OS",
  description:
    "Brief a piece, watch it move through the production pipeline, and hand it to Review & Approvals.",
};

/**
 * Content Studio (global) — the operator's daily-driver production surface for
 * M8 content + M9 authenticity. Pick a client, brief a piece, and watch it move
 * through the real status lanes (Draft → In review → Sent back → Approved) into
 * Review & Approvals. Deliberately UTILITARIAN (doc 06 §4/§5 — no glow, no
 * signature motion) and HONEST: every lane renders REAL `content_items` rows or
 * an honest empty/failed state, never a fabricated draft.
 *
 * The generation vendor (Anthropic) is deferred/fail-closed by design, so the
 * studio is fully built and usable in shape: the brief form calls the real
 * `createContentDraft` and renders the not-connected reality as a DESIGNED state
 * linking to /connections. It comes alive with zero code change when the vendor
 * wires. Approve/send-back decisions are NOT duplicated here — those rows link
 * INTO the Review & Approvals detail (one decision surface, rule of one owner).
 *
 * CARRIED (non-gating, 2026-07-10 gate record — BUILD-STATE carries the detail):
 * Design Review minors 3/4/5/7 and Code Review minors 4/5 ride the flagged
 * backlog with STUDIO_CONTENT_READ_GAP / STUDIO_TITLE_AT_BRIEF_GAP
 * (_components/studio-reads.ts).
 */

export default async function ContentStudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const selectedId =
    typeof raw.client === "string" && isUuidV4(raw.client) ? raw.client : undefined;

  const [claims, directory, pipeline] = await Promise.all([
    getClaims(),
    loadDirectory(),
    selectedId ? loadPipeline(selectedId) : Promise.resolve(null),
  ]);
  const canWrite = claims ? isStaffRole(claims.role) : false;

  // Resolve the selected client from the directory (existence + kit eligibility).
  const selected =
    selectedId && directory.ok
      ? [...directory.eligible, ...directory.needsKit].find((c) => c.id === selectedId) ?? null
      : null;
  const selectedHasKit =
    selected != null && directory.ok
      ? directory.eligible.some((c) => c.id === selected.id)
      : false;
  // Directory confirmed the id is out of scope / doesn't exist — don't render a
  // pipeline for a client we've confirmed isn't there (RLS parity: absent == foreign).
  const confirmedMissing = selectedId != null && directory.ok && selected == null;

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Studios"
          title="Content Studio"
          description="Brief a piece, watch it move through the production pipeline, and hand it to Review & Approvals — every draft written in the client's locked brand voice."
        />
      </Entrance>

      <Entrance step={1}>
        <ClientSelector
          directory={directory}
          selectedId={selectedId}
          selectedName={selected?.name ?? null}
        />
      </Entrance>

      {!selectedId ? (
        <Entrance step={2}>
          <DirectoryPanel directory={directory} canWrite={canWrite} />
        </Entrance>
      ) : (
        <>
          <Entrance step={2}>
            <PanelCard
              title={selected ? `Brief a piece for ${selected.name}` : "Brief a piece"}
              description="Compose one piece; it’s generated in the client’s brand voice and enters the pipeline as a draft."
            >
              <BriefPanel
                directory={directory}
                selected={selected}
                selectedId={selectedId}
                hasKit={selectedHasKit}
                confirmedMissing={confirmedMissing}
                canWrite={canWrite}
              />
            </PanelCard>
          </Entrance>

          {confirmedMissing ? null : (
            <Entrance step={3}>
              <PipelineBoard
                pipeline={pipeline}
                canWrite={canWrite}
                clientName={selected?.name ?? null}
              />
            </Entrance>
          )}
        </>
      )}

      <Entrance step={4}>
        <p className="max-w-3xl text-xs leading-5 text-muted">
          Drafts are written in the client’s locked brand voice, humanized and
          detection-checked, then reviewed and approved before anything is
          published. This studio reads the live pipeline only — nothing here is
          sampled or faked.
        </p>
      </Entrance>
    </PageContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Client selector (server-rendered GET form — no client JS)           */
/* ------------------------------------------------------------------ */

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm text-ink outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function ClientSelector({
  directory,
  selectedId,
  selectedName,
}: {
  directory: DirectoryLoad;
  selectedId: string | undefined;
  selectedName: string | null;
}) {
  const all: StudioClient[] = directory.ok
    ? [...directory.eligible, ...directory.needsKit].sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    : [];
  // Keep a set selection selectable even if the directory read came back empty.
  const options =
    selectedId && !all.some((c) => c.id === selectedId)
      ? [
          { id: selectedId, name: selectedName ?? "Selected client" } as {
            id: string;
            name: string;
          },
          ...all,
        ]
      : all;

  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Client
        <select name="client" defaultValue={selectedId ?? ""} className={SELECT_CLASS}>
          <option value="">Choose a client…</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="sm" variant="outline">
        Open
      </Button>
      {selectedId ? (
        <Link
          href="/content-studio"
          className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Clear
        </Link>
      ) : null}
      {!directory.ok ? (
        <span className="text-xs text-muted">
          The client list couldn’t load — refresh to try again.
        </span>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Directory panel (no client chosen)                                  */
/* ------------------------------------------------------------------ */

function DirectoryPanel({
  directory,
  canWrite,
}: {
  directory: DirectoryLoad;
  canWrite: boolean;
}) {
  if (!directory.ok) {
    return (
      <PanelCard title="Your clients">
        <FailedState subject="your clients" />
      </PanelCard>
    );
  }

  const total = directory.eligible.length + directory.needsKit.length;
  if (total === 0) {
    return (
      <PanelCard title="Your clients">
        <EmptyState
          icon={UsersRoundIcon}
          title="No clients yet"
          description="Onboard a client first — then give them a brand kit and you can brief content in their voice."
          action={
            canWrite ? (
              <Button asChild size="sm" variant="outline">
                <Link href="/onboarding">Add your first client</Link>
              </Button>
            ) : undefined
          }
        />
      </PanelCard>
    );
  }

  return (
    <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
      <PanelCard
        title="Ready to brief"
        description="Clients with a locked brand kit — pick one to produce a piece"
        aside={
          directory.eligible.length > 0 ? (
            <StatusPill tone="muted">{directory.eligible.length}</StatusPill>
          ) : undefined
        }
      >
        {directory.eligible.length === 0 ? (
          <EmptyState
            icon={PaletteIcon}
            title="No clients have a brand kit yet"
            description="Content is written in a client’s locked brand voice, so each needs a brand kit before you can brief a piece."
            action={
              canWrite ? (
                <Button asChild size="sm" variant="outline">
                  <Link href="/brand-kits/new">Create a brand kit</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col">
            {directory.eligible.map((c, i) => (
              <li key={c.id} className={i === 0 ? "" : "border-t border-border"}>
                <Link
                  href={`/content-studio?client=${c.id}`}
                  className="flex items-center justify-between gap-3 rounded-md px-1 py-3 outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <span className="truncate text-sm font-medium text-ink">{c.name}</span>
                  <ArrowRightIcon
                    aria-hidden
                    className="size-4 shrink-0 text-muted"
                    strokeWidth={2}
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>

      <PanelCard
        title="Needs a brand kit first"
        description="These clients can’t produce content until their brand voice is locked"
        aside={
          directory.needsKit.length > 0 ? (
            <StatusPill tone="warm">{directory.needsKit.length}</StatusPill>
          ) : undefined
        }
      >
        {directory.needsKit.length === 0 ? (
          <EmptyState
            icon={ClipboardCheckIcon}
            title="Every client has a brand kit"
            description="All your clients are ready to brief — nothing waiting on a kit."
          />
        ) : (
          <ul className="flex flex-col">
            {directory.needsKit.map((c, i) => (
              <li
                key={c.id}
                className={
                  "flex flex-wrap items-center justify-between gap-3 py-3" +
                  (i === 0 ? "" : " border-t border-border")
                }
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-ink">{c.name}</span>
                  <span className={`text-xs ${WARM_TEXT_CLASS}`}>Needs a brand kit</span>
                </div>
                {canWrite ? (
                  <Button asChild size="xs" variant="outline">
                    <Link href={`/brand-kits/new/${c.id}`}>Add brand kit</Link>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Brief panel (a client is chosen)                                    */
/* ------------------------------------------------------------------ */

function BriefPanel({
  directory,
  selected,
  selectedId,
  hasKit,
  confirmedMissing,
  canWrite,
}: {
  directory: DirectoryLoad;
  selected: StudioClient | null;
  selectedId: string;
  hasKit: boolean;
  confirmedMissing: boolean;
  canWrite: boolean;
}) {
  if (confirmedMissing) {
    return (
      <EmptyState
        icon={InboxIcon}
        title="We couldn’t find that client"
        description="It may have been removed, or it isn’t in your workspace. Pick another client to continue."
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/content-studio">Back to all clients</Link>
          </Button>
        }
      />
    );
  }

  if (!directory.ok) {
    // Independent failure domain: the client directory read failed, so we can't
    // confirm this client's kit eligibility. Honest, retryable — not a guess.
    return <FailedState subject="this client’s details" />;
  }

  if (!hasKit) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4">
        <span
          aria-hidden
          className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
        >
          <PaletteIcon className="size-4 text-accent" strokeWidth={1.75} />
        </span>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">
            {selected ? `${selected.name} needs a brand kit first` : "This client needs a brand kit first"}
          </span>
          <p className="max-w-xl text-xs leading-5 text-muted">
            Content is written in a client’s locked brand voice — we never fall
            back to a generic voice. Create the brand kit, then brief this piece.
          </p>
          {canWrite ? (
            <Button asChild size="sm" variant="outline" className="mt-1 w-fit">
              <Link href={`/brand-kits/new/${selectedId}`}>Create the brand kit</Link>
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (!canWrite) {
    return (
      <p className="text-sm leading-6 text-muted">
        Producing content is an agency-staff action. You can see this client’s
        pipeline below, but briefing new pieces is shown to staff only.
      </p>
    );
  }

  return <BriefForm clientId={selectedId} clientName={selected?.name ?? "this client"} />;
}

/* ------------------------------------------------------------------ */
/* Pipeline board (a client is chosen)                                 */
/* ------------------------------------------------------------------ */

function PipelineBoard({
  pipeline,
  canWrite,
  clientName,
}: {
  pipeline: PipelineLoad | null;
  canWrite: boolean;
  clientName: string | null;
}) {
  if (pipeline === null) {
    return (
      <PanelCard title="Pipeline">
        <FailedState subject="this client’s pipeline" />
      </PanelCard>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold tracking-tight text-ink">
          Pipeline
        </h2>
        {clientName ? (
          <span className="truncate text-xs text-muted">{clientName}</span>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4 xl:items-start">
        <Lane
          title="Draft"
          variant="draft"
          icon={FileTextIcon}
          emptyCopy="Nothing in draft. Brief a piece above to start one."
          section={pipeline.draft}
          canWrite={canWrite}
        />
        <Lane
          title="In review"
          variant="review"
          icon={ClipboardCheckIcon}
          emptyCopy="No drafts are waiting on a review decision."
          section={pipeline.inReview}
          canWrite={canWrite}
        />
        <Lane
          title="Sent back"
          variant="review"
          icon={InboxIcon}
          emptyCopy="Nothing has been sent back for revision."
          section={pipeline.needsRevision}
          canWrite={canWrite}
        />
        <Lane
          title="Approved"
          variant="approved"
          icon={RocketIcon}
          emptyCopy="Nothing approved yet."
          section={pipeline.approved}
          canWrite={canWrite}
        />
      </div>
    </section>
  );
}

function laneTotal(section: LaneSection): { n: number; lowerBound: boolean } {
  if (!section.ok) return { n: 0, lowerBound: false };
  const n = section.count ?? section.items.length;
  return {
    n,
    lowerBound: section.count == null && section.items.length === LANE_LIMIT,
  };
}

function Lane({
  title,
  variant,
  icon: Icon,
  emptyCopy,
  section,
  canWrite,
}: {
  title: string;
  variant: "draft" | "review" | "approved";
  icon: typeof FileTextIcon;
  emptyCopy: string;
  section: LaneSection;
  canWrite: boolean;
}) {
  const total = laneTotal(section);
  return (
    <PanelCard
      title={title}
      aside={
        total.n > 0 ? (
          <StatusPill tone="muted">
            {total.n}
            {total.lowerBound ? "+" : ""}
          </StatusPill>
        ) : undefined
      }
    >
      {!section.ok ? (
        <FailedState subject={`the ${title.toLowerCase()} lane`} />
      ) : section.items.length === 0 ? (
        <EmptyState icon={Icon} title="Empty" description={emptyCopy} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {section.items.map((item) => (
              <PipelineCard
                key={item.id}
                item={item}
                variant={variant}
                canWrite={canWrite}
              />
            ))}
          </ul>
          {/* A known count that fits the cap needs no note ("first 24 of 24"
              would be noise); an UNKNOWN count at the cap keeps the honest
              total-free fallback. */}
          {section.items.length === LANE_LIMIT &&
          (section.count == null || section.count > LANE_LIMIT) ? (
            <p className="mt-3 text-xs text-muted">
              {section.count != null
                ? `Showing the first ${LANE_LIMIT} of ${section.count} — newest first.`
                : `Showing the first ${LANE_LIMIT} — newest first.`}
            </p>
          ) : null}
        </>
      )}
    </PanelCard>
  );
}

function PipelineCard({
  item,
  variant,
  canWrite,
}: {
  item: PipelineItem;
  variant: "draft" | "review" | "approved";
  canWrite: boolean;
}) {
  const heading = (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-sm font-medium text-ink">
        {item.title ?? "Untitled"}
      </span>
      <span className="truncate text-xs text-muted">
        {TYPE_NOUN[item.type]} · {medDateTime(item.updatedAt)}
      </span>
    </div>
  );

  // Review lanes: the whole card links INTO the decision surface — this studio
  // never records the verdict/approval itself (one owner).
  if (variant === "review") {
    return (
      <li>
        <Link
          href={`/review-queue/content/${item.id}`}
          className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised px-3.5 py-3 outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {heading}
          {item.sendBackNote ? (
            <span className={`line-clamp-2 text-xs leading-5 ${WARM_TEXT_CLASS}`}>
              Sent back: {item.sendBackNote}
            </span>
          ) : null}
          <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-accent">
            Open in Review &amp; Approvals
            <ArrowRightIcon aria-hidden className="size-3" strokeWidth={2} />
          </span>
        </Link>
      </li>
    );
  }

  // Draft lane: the real next production step (M9 authenticity → advance).
  if (variant === "draft") {
    return (
      <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised px-3.5 py-3">
        {heading}
        {canWrite ? (
          <DraftAdvance contentItemId={item.id} />
        ) : (
          <span className="text-xs leading-5 text-muted">
            Advancing a draft is a staff action.
          </span>
        )}
      </li>
    );
  }

  // Approved lane: honest — publishing to a live site isn't wired. No button.
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        {heading}
        <StatusPill tone={STATUS_TONE[item.status]}>
          {STATUS_LABEL[item.status]}
        </StatusPill>
      </div>
      <span className="text-xs leading-5 text-muted">
        Approved and locked to this revision. Publishing to the live site isn’t
        wired up yet — that arrives with the site-connection work.
      </span>
    </li>
  );
}
