import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeftIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  LockIcon,
  PaletteIcon,
  PencilIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Entrance } from "@/components/moments";
import { isUuidV4 } from "@/lib/clients/validate";
import {
  listBrandKitVersionHistory,
  readLockedBrandKit,
} from "@/lib/production/brand-kit/actions";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../../_components/surface";
import { loadClientHeader } from "../_components/kit-reads";
import {
  ContrastClean,
  LikenessView,
  PaletteSwatches,
  ReportCorrections,
  ReportNotes,
  TypographySummary,
  VoiceProfileView,
} from "../_components/kit-display";

export const metadata: Metadata = {
  title: "Brand kit — AEO/GEO + Brand Production OS",
  description: "A client's locked brand system — palette, type, voice, likeness, and version history.",
};

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

/**
 * Render-safety gate for the stored logo reference. The frozen write clamp
 * (production/brand-kit/validate.ts) caps SIZE only and explicitly delegates
 * scheme/render safety to the consuming renderer — this page. Mirrors the
 * sanitizePropertyUrl posture (properties/validate.ts): only http(s) may become
 * an href; anything else renders as plain text, never a link.
 */
function isWebUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/** First value of a possibly-repeated query param; undefined otherwise. */
function oneParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Brand kit detail — the read view of ONE client's current locked kit plus its
 * version history. Client-scoped, because the M7 read contract is client-scoped
 * (there is no read-kit-by-id). Every panel is honest: ready (real stored values),
 * failed (retryable read error), or empty (no kit yet → invite the ingest flow).
 * Values render only what the engine persisted; absent inputs say "none provided".
 */
export default async function BrandKitDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { clientId } = await params;
  if (!isUuidV4(clientId)) notFound();

  const client = await loadClientHeader(clientId);
  if (!client) notFound();

  const [kitRes, historyRes] = await Promise.all([
    readLockedBrandKit({ clientId }),
    listBrandKitVersionHistory({ clientId }),
  ]);

  // Success-banner params are VALIDATED, never echoed: `created` must be the
  // literal flag our redirect sets; `revised` must be digits (it's rendered as
  // a version number). Anything else — arrays, crafted strings — is dropped.
  const sp = await searchParams;
  const created = oneParam(sp.created) === "1";
  const revisedRaw = oneParam(sp.revised);
  const revised = revisedRaw && /^\d+$/.test(revisedRaw) ? revisedRaw : undefined;
  const banner = created
    ? "Brand kit created and locked."
    : revised
      ? `Version ${revised} locked. The previous version is preserved in history.`
      : null;

  const kit = kitRes.ok ? kitRes.kit : null;

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Brand Kits"
          title={client.name}
          description="The locked brand system that forces this client's content and media on-brand."
          actions={
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm">
                <Link href="/brand-kits">
                  <ArrowLeftIcon aria-hidden /> All kits
                </Link>
              </Button>
              {kit ? (
                <Button asChild size="sm">
                  <Link href={`/brand-kits/${clientId}/revise`}>
                    <PencilIcon aria-hidden /> Revise
                  </Link>
                </Button>
              ) : null}
            </div>
          }
        />
      </Entrance>

      {banner ? (
        <Entrance step={1}>
          <div className="flex items-center gap-2 rounded-lg border border-positive/40 bg-positive/5 px-4 py-3 text-sm text-ink">
            <CheckCircle2Icon className="size-4 text-positive" aria-hidden />
            {banner}
          </div>
        </Entrance>
      ) : null}

      {!kitRes.ok ? (
        <Entrance step={2}>
          <FailedState subject="this brand kit" />
        </Entrance>
      ) : kit === null ? (
        <Entrance step={2}>
          <EmptyState
            icon={PaletteIcon}
            title="No brand kit yet"
            description="Content and media generation stay blocked until this client has a locked brand kit. Ingest one to capture their palette, type, and voice."
            action={
              <Button asChild size="sm">
                <Link href={`/brand-kits/new/${clientId}`}>Ingest a kit</Link>
              </Button>
            }
          />
        </Entrance>
      ) : (
        <>
          <Entrance step={2} className="flex flex-wrap items-center gap-2">
            <StatusPill tone="positive">
              <LockIcon className="mr-1 size-3" aria-hidden />
              Locked
            </StatusPill>
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              Version {kit.version}
            </Badge>
            <span className="font-mono text-xs text-muted">Locked {medDate(kit.createdAt)}</span>
          </Entrance>

          <div className="grid gap-6 lg:grid-cols-2">
            <Entrance step={3}>
              <PanelCard title="Palette" description="The color tokens the theming + production engines enforce.">
                <PaletteSwatches colors={kit.tokens.colors} />
              </PanelCard>
            </Entrance>
            <Entrance step={4}>
              <PanelCard title="Typography" description="Faces and the type scale used across generated assets.">
                <TypographySummary typography={kit.tokens.typography} />
              </PanelCard>
            </Entrance>
          </div>

          <Entrance step={5}>
            <PanelCard title="Brand voice" description="Read at generation time so every piece ships in this voice.">
              <VoiceProfileView voice={kit.voiceProfile} />
            </PanelCard>
          </Entrance>

          <Entrance step={6}>
            <PanelCard title="Logo & likeness" description="Feeds schema, press placements, and on-brand media generation.">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11px] tracking-wide text-muted uppercase">Logo</span>
                  {kit.logoUrl ? (
                    isWebUrl(kit.logoUrl) ? (
                      <a
                        href={kit.logoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex max-w-full items-center gap-1.5 truncate font-mono text-xs text-accent underline-offset-4 hover:underline"
                      >
                        <span className="truncate">{kit.logoUrl}</span>
                        <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
                      </a>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <span className="font-mono text-xs break-all text-ink">
                          {kit.logoUrl}
                        </span>
                        <p className="text-[11px] text-muted italic">
                          Stored reference isn&apos;t a web link, so it isn&apos;t
                          rendered as one.
                        </p>
                      </div>
                    )
                  ) : (
                    <p className="text-xs text-muted italic">
                      No logo provided. Schema and press placements have no logo until one is added.
                    </p>
                  )}
                </div>
                <LikenessView likeness={kit.likenessRefs} />
              </div>
            </PanelCard>
          </Entrance>

          <Entrance step={7}>
            <PanelCard
              title="How this version was resolved"
              description="What the ingest engine adjusted for accessibility, and what it filled or left open."
            >
              {kit.provenance ? (
                <div className="flex flex-col gap-5">
                  {kit.provenance.contrastCorrections.filter((c) => c.resolved).length === 0 &&
                  kit.provenance.notes.length === 0 ? (
                    <ContrastClean />
                  ) : null}
                  <ReportCorrections corrections={kit.provenance.contrastCorrections} />
                  <ReportNotes notes={kit.provenance.notes} />
                </div>
              ) : (
                <p className="text-xs text-muted italic">
                  Resolution details weren&apos;t recorded for this version.
                </p>
              )}
            </PanelCard>
          </Entrance>

          <Entrance step={8}>
            <PanelCard
              title="Version history"
              description="Each locked version, newest first. Revising creates the next version; nothing is overwritten."
            >
              <VersionHistory result={historyRes} currentVersion={kit.version} />
            </PanelCard>
          </Entrance>
        </>
      )}
    </PageContainer>
  );
}

function VersionHistory({
  result,
  currentVersion,
}: {
  result: Awaited<ReturnType<typeof listBrandKitVersionHistory>>;
  currentVersion: number;
}) {
  if (!result.ok) return <FailedState subject="version history" />;
  if (result.entries.length === 0) {
    return <p className="text-xs text-muted italic">No versions recorded.</p>;
  }
  return (
    <ul className="flex flex-col divide-y divide-border">
      {result.entries.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
          <div className="flex items-center gap-2.5">
            <Badge variant="secondary" className="font-mono text-[10px] uppercase">
              v{entry.version}
            </Badge>
            {entry.version === currentVersion ? (
              <StatusPill tone="accent">Current</StatusPill>
            ) : null}
            <span className="font-mono text-xs text-muted">{medDate(entry.createdAt)}</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-muted">
            {entry.contrastCorrectionCount !== null ? (
              <span>
                {entry.contrastCorrectionCount}{" "}
                {entry.contrastCorrectionCount === 1 ? "correction" : "corrections"}
              </span>
            ) : null}
            {entry.unspecifiedInputCount !== null ? (
              <span>{entry.unspecifiedInputCount} defaulted / missing</span>
            ) : null}
            {entry.contrastCorrectionCount === null && entry.unspecifiedInputCount === null ? (
              <span className="italic">no resolution details</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}
