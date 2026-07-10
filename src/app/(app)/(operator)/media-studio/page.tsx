import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  CalendarClockIcon,
  ClipboardCheckIcon,
  ImageIcon,
  InboxIcon,
  type LucideIcon,
  MessageSquareIcon,
  PaletteIcon,
  PlugZapIcon,
  Share2Icon,
  UsersRoundIcon,
  VideoIcon,
} from "lucide-react";

import { Entrance } from "@/components/moments";
import { Button } from "@/components/ui/button";
import { getClaims } from "@/lib/auth/session";
import { isStaffRole } from "@/lib/auth/parse-claims";
import { isUuidV4 } from "@/lib/clients/validate";
import type { ContentItemStatus } from "@/lib/types/db";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import { WARM_TEXT_CLASS } from "../../_components/tone";
// Reused from the Content Studio (landed, reviewed): the identical brand-kit
// eligibility split (both caption + media production REQUIRE a locked kit), and
// the shared M9 authenticity-gate control (runAuthenticityGate handles a caption
// draft — caption → social_caption — exactly as it does a blog draft). Reused,
// not re-implemented, so the two studios can't drift apart.
import {
  loadDirectory,
  type DirectoryLoad,
  type StudioClient,
} from "../content-studio/_components/studio-reads";
import { DraftAdvance } from "../content-studio/_components/draft-actions";
import { CaptionBriefForm } from "./_components/caption-brief-form";
import {
  CAPTION_STATUS_LABEL,
  CAPTION_STATUS_TONE,
  CONNECTIONS_HREF,
  MEDIA_STUDIO_HREF,
  medDateTime,
  REVIEW_QUEUE_HREF,
} from "./_components/caption-pipeline";
import {
  CAPTION_QUEUE_LIMIT,
  loadCaptionQueue,
  type CaptionQueueItem,
  type CaptionQueueLoad,
} from "./_components/media-reads";

export const metadata: Metadata = {
  title: "Image & Media Studio — AEO/GEO + Brand Production OS",
  description:
    "Brand-consistent captions, images, and video for social — forced through each client's locked brand kit.",
};

/**
 * Image & Media Studio (global) — the SOCIAL arm of the brand-consistent
 * production engine (M11). Pick a client, draft an on-brand caption, and watch
 * it move through the same pipeline into Review & Approvals. Deliberately
 * UTILITARIAN (doc 06 §4/§5 — no glow, no signature motion) and HONEST: it
 * renders REAL `content_items` captions or an honest empty/failed state, never a
 * fabricated draft.
 *
 * WHAT'S REAL vs. HONESTLY DEFERRED (verified against src/lib/social/**):
 *  - CAPTIONS are fully buildable: `createSocialCaption` writes a pinned
 *    pre-approval caption (content_items.type='caption') that flows to Review &
 *    Approvals — like the Content Studio, but for social copy. The generation
 *    vendor (Anthropic, the SAME deferred seam M8 uses) is fail-closed, so a real
 *    submit today returns a DESIGNED not-connected state; the studio comes alive
 *    with zero code change when it wires.
 *  - MEDIA (image/video) is BRAND-FORCED server-side from the locked kit behind
 *    the deferred Higgsfield/Motion port — its section is an honest "Not
 *    connected" state (no fake generate buttons), because a generated media ref
 *    also has no persistence home yet (recorded schema gap).
 *  - COMPOSING + SCHEDULING has no persisted schema home (a pending platform
 *    decision), and M11 structurally CANNOT auto-post — that section is an honest
 *    designed state, never a fake scheduler form.
 *
 * Approve/send-back decisions are NOT duplicated here — captions in review link
 * INTO Review & Approvals (one decision surface, rule of one owner).
 */
export default async function MediaStudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const selectedId =
    typeof raw.client === "string" && isUuidV4(raw.client) ? raw.client : undefined;

  const [claims, directory, captions] = await Promise.all([
    getClaims(),
    loadDirectory(),
    selectedId ? loadCaptionQueue(selectedId) : Promise.resolve(null),
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
          title="Image & Media Studio"
          description="Draft on-brand captions, and — as the media engines connect — brand-forced images and video, all in each client's locked brand look and voice. Everything routes through Review & Approvals before it ships."
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
              title={selected ? `Draft a caption for ${selected.name}` : "Draft a caption"}
              description="Compose one social caption; it’s written in the client’s brand voice and enters the pipeline as a draft."
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
              <CaptionPipeline
                load={captions}
                canWrite={canWrite}
                clientName={selected?.name ?? null}
              />
            </Entrance>
          )}
        </>
      )}

      {/* The forward-looking half of the studio — honestly deferred, never faked.
          Shown always so the studio tells its whole story: what connecting the
          media engines turns on, and how composed posts will reach a channel. */}
      <Entrance step={4}>
        <MediaGenerationSection />
      </Entrance>
      <Entrance step={5}>
        <SchedulingSection />
      </Entrance>

      <Entrance step={6}>
        <p className="max-w-3xl text-xs leading-5 text-muted">
          Captions are written in the client’s locked brand voice, checked for
          fabricated claims and compliance, then reviewed and approved before
          anything is published. Media is generated brand-forced from the client’s
          kit — never off-brand, and never used to style this app’s own interface.
          This studio reads the live pipeline only — nothing here is sampled or
          faked.
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
          href={MEDIA_STUDIO_HREF}
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
          description="Onboard a client first — then give them a brand kit and you can produce captions and media in their brand."
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
        title="Ready to produce"
        description="Clients with a locked brand kit — pick one to draft a caption"
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
            description="Captions are written in a client’s locked brand voice, and media is forced through their brand look, so each needs a brand kit first."
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
                  href={`${MEDIA_STUDIO_HREF}?client=${c.id}`}
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
        description="These clients can’t produce until their brand voice and look are locked"
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
            description="All your clients are ready to produce — nothing waiting on a kit."
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
            <Link href={MEDIA_STUDIO_HREF}>Back to all clients</Link>
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
            Captions are written in a client’s locked brand voice, and media is
            forced through their brand look — we never fall back to a generic
            brand. Create the brand kit, then produce for this client.
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
        Producing social content is an agency-staff action. You can see this
        client’s caption pipeline below, but drafting new captions is shown to
        staff only.
      </p>
    );
  }

  return <CaptionBriefForm clientId={selectedId} clientName={selected?.name ?? "this client"} />;
}

/* ------------------------------------------------------------------ */
/* Caption pipeline (a client is chosen)                               */
/* ------------------------------------------------------------------ */

function CaptionPipeline({
  load,
  canWrite,
  clientName,
}: {
  load: CaptionQueueLoad | null;
  canWrite: boolean;
  clientName: string | null;
}) {
  return (
    <PanelCard
      title="Caption pipeline"
      description="Every caption for this client, newest first — drafts, in review, and approved"
      aside={
        clientName ? <span className="truncate text-xs text-muted">{clientName}</span> : undefined
      }
    >
      {load == null || !load.ok ? (
        <FailedState subject="this client’s captions" />
      ) : load.items.length === 0 ? (
        <EmptyState
          icon={MessageSquareIcon}
          title="No captions yet"
          description="Draft a caption above to start one. It enters here as a draft, then moves through the authenticity check into Review & Approvals."
        />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {load.items.map((item) => (
              <CaptionRow key={item.id} item={item} canWrite={canWrite} />
            ))}
          </ul>
          {/* Honest "showing first N" affordance when the list is at the cap. */}
          {load.items.length === CAPTION_QUEUE_LIMIT &&
          (load.count == null || load.count > CAPTION_QUEUE_LIMIT) ? (
            <p className="mt-3 text-xs text-muted">
              {load.count != null
                ? `Showing the first ${CAPTION_QUEUE_LIMIT} of ${load.count} — newest first.`
                : `Showing the first ${CAPTION_QUEUE_LIMIT} — newest first.`}
            </p>
          ) : null}
        </>
      )}
    </PanelCard>
  );
}

/** The review lanes a caption row links INTO (never decided here — one owner). */
const IN_REVIEW_STATUSES: readonly ContentItemStatus[] = ["in_review", "needs_revision"];

function CaptionRow({
  item,
  canWrite,
}: {
  item: CaptionQueueItem;
  canWrite: boolean;
}) {
  const body = (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="line-clamp-2 text-sm leading-5 text-ink">
        {item.preview === "" ? "This caption has no text yet." : item.preview}
      </p>
      <span className="text-xs text-muted">
        {CAPTION_STATUS_LABEL[item.status]} · {medDateTime(item.createdAt)}
      </span>
    </div>
  );

  // In review / sent back: the whole card links INTO the decision surface — this
  // studio never records the verdict/approval itself (one decision surface).
  if (IN_REVIEW_STATUSES.includes(item.status)) {
    return (
      <li>
        <Link
          href={`/review-queue/content/${item.id}`}
          className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised px-3.5 py-3 outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {body}
          {item.status === "needs_revision" ? (
            <span className={`text-xs leading-5 ${WARM_TEXT_CLASS}`}>
              Sent back for revision — open to see the note.
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

  // Draft: the real next production step (M9 authenticity → advance to review),
  // reusing the shared authenticity-gate control. Empty until caption generation
  // wires (nothing persists a draft before then), then live with no code change.
  if (item.status === "draft") {
    return (
      <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised px-3.5 py-3">
        {body}
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

  // Approved / published: honest — publishing a caption happens by composing a
  // scheduled post (the deferred section below), never auto-posted. No button.
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        {body}
        <StatusPill tone={CAPTION_STATUS_TONE[item.status]}>
          {CAPTION_STATUS_LABEL[item.status]}
        </StatusPill>
      </div>
      <span className="text-xs leading-5 text-muted">
        Approved and locked to this revision. Publishing happens by composing a
        scheduled post — never auto-posted (see below).
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Media generation — honestly deferred (Higgsfield / Motion)          */
/* ------------------------------------------------------------------ */

interface MediaCapability {
  name: string;
  icon: LucideIcon;
  /** ONE true sentence, verified against src/lib/social/media.ts + types.ts. */
  unlocks: string;
}

// Verified against the M11 engine: SOCIAL_MEDIA_TYPES = image | video only (no
// voice type exists in the engine, so none is promised). Brand is forced from the
// locked kit's accent palette + logo + Higgsfield/Motion likeness refs.
const MEDIA_CAPABILITIES: MediaCapability[] = [
  {
    name: "Images",
    icon: ImageIcon,
    unlocks:
      "On-brand images from a short creative brief — the client’s brand colors, logo, and product or founder likeness are applied automatically.",
  },
  {
    name: "Short video",
    icon: VideoIcon,
    unlocks:
      "Reels, Shorts, and carousel video in the client’s look — the same brand lock, generated from a brief you write.",
  },
];

function MediaGenerationSection() {
  return (
    <PanelCard
      title="Brand-forced images & video"
      description="Generated through each client’s locked kit — the media half of this studio, arriving with the media engines"
      aside={<StatusPill tone="muted">Not connected</StatusPill>}
    >
      <div className="flex flex-col gap-5">
        <p className="max-w-2xl text-sm leading-6 text-muted">
          When the media engines connect, you’ll generate on-brand images and
          short video for a client from a short creative brief. You supply only the
          creative direction — the brand colors, logo, and product or founder
          likeness references come from the client’s locked kit and are applied
          server-side, so a brief can never request off-brand creative. Off-brand
          output is prevented at generation, never corrected after.
        </p>

        <ul className="grid gap-3 sm:grid-cols-2">
          {MEDIA_CAPABILITIES.map((cap) => {
            const Icon = cap.icon;
            return (
              <li
                key={cap.name}
                className="flex items-start gap-3 rounded-lg border border-border bg-surface-raised px-3.5 py-3"
              >
                <span
                  aria-hidden
                  className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                >
                  <Icon className="size-4 text-accent" strokeWidth={1.75} />
                </span>
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-ink">{cap.name}</span>
                  <p className="text-xs leading-5 text-muted">{cap.unlocks}</p>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-4 py-4">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
            >
              <PlugZapIcon className="size-4 text-muted" strokeWidth={1.75} />
            </span>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-ink">
                The media engines aren’t connected yet
              </span>
              <p className="max-w-xl text-xs leading-5 text-muted">
                Image and video generation is deferred and fail-closed by design —
                there’s nothing to generate here today, and no setup to do in this
                studio. It turns on with the media-engine wiring; the Connections
                board is where that status will show.
              </p>
              <Link
                href={CONNECTIONS_HREF}
                className="mt-0.5 inline-flex w-fit items-center gap-1 rounded text-sm font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                See Connections
                <ArrowRightIcon aria-hidden className="size-3.5" strokeWidth={2} />
              </Link>
            </div>
          </div>
        </div>
      </div>
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Composing & scheduling — honestly deferred (pending schema decision) */
/* ------------------------------------------------------------------ */

function SchedulingSection() {
  return (
    <PanelCard
      title="Composing & scheduling posts"
      description="Turning approved captions and media into scheduled posts"
      aside={<StatusPill tone="muted">In design</StatusPill>}
    >
      <div className="flex flex-col gap-5">
        <ol className="flex flex-col gap-3">
          <FlowStep
            icon={MessageSquareIcon}
            title="Compose"
            body="Pair an approved caption with its media and a time to publish."
          />
          <FlowStep
            icon={ClipboardCheckIcon}
            title="Review & approve"
            body="The composed post goes to Review & Approvals — nothing is scheduled until a person approves it."
          />
          <FlowStep
            icon={CalendarClockIcon}
            title="Publish on schedule"
            body="Approved posts publish to the client’s channels at the chosen time. Nothing is ever auto-posted."
          />
        </ol>

        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border px-4 py-4">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
            >
              <Share2Icon className="size-4 text-muted" strokeWidth={1.75} />
            </span>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-ink">
                Composing isn’t available in this studio yet
              </span>
              <p className="max-w-xl text-xs leading-5 text-muted">
                Where composed and scheduled posts live in the system is still
                being decided, so this studio doesn’t offer a scheduler today — it
                never fakes one. Once that’s built, composing appears right here,
                and publishing stays a separate, approved step. Distribution status
                shows on the Connections board.
              </p>
              <Link
                href={CONNECTIONS_HREF}
                className="mt-0.5 inline-flex w-fit items-center gap-1 rounded text-sm font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                See Connections
                <ArrowRightIcon aria-hidden className="size-3.5" strokeWidth={2} />
              </Link>
            </div>
          </div>
        </div>

        <p className="max-w-2xl text-xs leading-5 text-muted">
          Approved captions are ready to compose the moment this lands — find them
          in{" "}
          <Link
            href={REVIEW_QUEUE_HREF}
            className="rounded text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            Review &amp; Approvals
          </Link>
          .
        </p>
      </div>
    </PanelCard>
  );
}

function FlowStep({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden
        className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-overlay"
      >
        <Icon className="size-4 text-accent" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink">{title}</span>
        <p className="max-w-xl text-xs leading-5 text-muted">{body}</p>
      </div>
    </li>
  );
}
