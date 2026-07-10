import {
  AlertTriangleIcon,
  CheckIcon,
  CircleDashedIcon,
  WandSparklesIcon,
} from "lucide-react";

import { StatusPill } from "../../../_components/surface";
import type {
  ColorTokens,
  LikenessRefs,
  TypographyTokens,
  VoiceProfile,
} from "@/lib/types/brand";
import type { IngestionNote, IngestionReport } from "@/lib/production/brand-kit";
import type { ContrastCheck, TokenAdjustment } from "@/lib/skills/brand-kit";

/**
 * Presentational brand-kit views, shared by the read-only DETAIL page (server)
 * and the ingest/revise REVIEW step (client). Hookless and token-driven so both
 * graphs can import it. HONESTY is the rule throughout: swatches render only the
 * exact values the engine produced, empty lists say "None provided" (absent is
 * never shown as zero), and every contrast correction / refusal reason is the
 * engine's own verbatim text — never paraphrased.
 */

/* ------------------------------------------------------------------ */
/* Labels (token/check keys → operator-facing names)                   */
/* ------------------------------------------------------------------ */

const COLOR_LABELS: Record<keyof ColorTokens, string> = {
  surface: "Surface",
  surfaceRaised: "Raised surface",
  ink: "Ink · text",
  muted: "Muted · text",
  accent: "Accent · brand",
  accentSecondary: "Secondary accent",
  accentWarm: "Warm accent",
  positive: "Positive",
  negative: "Negative",
};

/** The palette order that reads as a system: chrome, then text, then accents, then status. */
const COLOR_ORDER: Array<keyof ColorTokens> = [
  "surface",
  "surfaceRaised",
  "ink",
  "muted",
  "accent",
  "accentSecondary",
  "accentWarm",
  "positive",
  "negative",
];

/* ------------------------------------------------------------------ */
/* Swatches                                                            */
/* ------------------------------------------------------------------ */

/**
 * A single color chip: the actual value as a fill (inline style is the brand
 * DATUM, not app chrome — the only honest way to show a client's color), with
 * its label + hex in the surface's own tokens.
 */
export function Swatch({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="size-9 shrink-0 rounded-md border border-border shadow-xs"
        style={{ backgroundColor: value }}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-xs font-medium text-ink">{label}</span>
        <span className="font-mono text-[11px] text-muted uppercase">{value}</span>
      </span>
    </div>
  );
}

/** The full palette as swatches, in system order. */
export function PaletteSwatches({ colors }: { colors: ColorTokens }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {COLOR_ORDER.map((key) => (
        <Swatch key={key} label={COLOR_LABELS[key]} value={colors[key]} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Typography                                                          */
/* ------------------------------------------------------------------ */

export function TypographySummary({ typography }: { typography: TypographyTokens }) {
  const scaleSteps = Object.entries(typography.scale);
  const faces: Array<{ label: string; value: string }> = [
    { label: "Display", value: typography.display },
    { label: "Body", value: typography.body },
    { label: "Mono", value: typography.mono },
  ];
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-2 sm:grid-cols-3">
        {faces.map((f) => (
          <div key={f.label} className="flex flex-col gap-0.5">
            <dt className="text-[11px] tracking-wide text-muted uppercase">{f.label}</dt>
            <dd className="truncate text-sm text-ink" title={f.value}>
              {f.value}
            </dd>
          </div>
        ))}
      </dl>
      {scaleSteps.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-wide text-muted uppercase">
            Type scale · {scaleSteps.length} {scaleSteps.length === 1 ? "step" : "steps"}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {scaleSteps.map(([name, step]) => (
              <span
                key={name}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-raised px-2 py-1 font-mono text-[11px] text-muted"
                title={`${step.size} / line-height ${step.lineHeight}${step.weight ? ` / weight ${step.weight}` : ""}`}
              >
                <span className="text-ink">{name}</span>
                <span aria-hidden>·</span>
                <span>{step.size}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Voice + likeness (honest empties)                                   */
/* ------------------------------------------------------------------ */

function NoneProvided({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted italic">{children}</p>;
}

function Chips({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className="inline-flex rounded-full border border-border bg-surface-raised px-2.5 py-0.5 text-xs text-ink"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function RuleList({ items, tone }: { items: string[]; tone: "positive" | "negative" }) {
  const dot = tone === "positive" ? "bg-positive" : "bg-negative";
  return (
    <ul className="flex flex-col gap-1">
      {items.map((item, i) => (
        <li key={`${item}-${i}`} className="flex items-start gap-2 text-xs text-ink">
          <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot}`} />
          <span className="leading-5">{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function VoiceProfileView({ voice }: { voice: VoiceProfile }) {
  const hasAny =
    voice.descriptors.length > 0 ||
    voice.samples.length > 0 ||
    voice.do.length > 0 ||
    voice.dont.length > 0;
  if (!hasAny) {
    return (
      <NoneProvided>
        No brand voice provided. Content generation can’t enforce brand voice
        until descriptors or samples are added.
      </NoneProvided>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] tracking-wide text-muted uppercase">Descriptors</span>
        {voice.descriptors.length > 0 ? (
          <Chips items={voice.descriptors} />
        ) : (
          <NoneProvided>None provided</NoneProvided>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-wide text-muted uppercase">Do</span>
          {voice.do.length > 0 ? (
            <RuleList items={voice.do} tone="positive" />
          ) : (
            <NoneProvided>None provided</NoneProvided>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-wide text-muted uppercase">Don’t</span>
          {voice.dont.length > 0 ? (
            <RuleList items={voice.dont} tone="negative" />
          ) : (
            <NoneProvided>None provided</NoneProvided>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] tracking-wide text-muted uppercase">Samples</span>
        {voice.samples.length > 0 ? (
          <div className="flex flex-col gap-2">
            {voice.samples.map((sample, i) => (
              <blockquote
                key={i}
                className="border-l-2 border-border pl-3 text-xs leading-5 text-muted italic"
              >
                {sample}
              </blockquote>
            ))}
          </div>
        ) : (
          <NoneProvided>None provided</NoneProvided>
        )}
      </div>
    </div>
  );
}

export function LikenessView({ likeness }: { likeness: LikenessRefs }) {
  const hasAny =
    likeness.higgsfieldElementIds.length > 0 || likeness.motionElementIds.length > 0;
  if (!hasAny) {
    return (
      <NoneProvided>
        No product/founder likeness references provided. On-likeness media
        generation has no anchor until these are added.
      </NoneProvided>
    );
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] tracking-wide text-muted uppercase">Higgsfield</span>
        {likeness.higgsfieldElementIds.length > 0 ? (
          <Chips items={likeness.higgsfieldElementIds} />
        ) : (
          <NoneProvided>None provided</NoneProvided>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] tracking-wide text-muted uppercase">Motion</span>
        {likeness.motionElementIds.length > 0 ? (
          <Chips items={likeness.motionElementIds} />
        ) : (
          <NoneProvided>None provided</NoneProvided>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Provenance — corrections + defaulted/missing (the honesty report)   */
/* ------------------------------------------------------------------ */

/** The from→to of one contrast correction, as two small chips. */
function AdjustmentSwatches({ from, to }: { from: string; to: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted uppercase">
      <span
        aria-hidden
        className="size-4 rounded-sm border border-border"
        style={{ backgroundColor: from }}
      />
      {from}
      <span aria-hidden>→</span>
      <span
        aria-hidden
        className="size-4 rounded-sm border border-border"
        style={{ backgroundColor: to }}
      />
      {to}
    </span>
  );
}

/**
 * The contrast corrections the engine APPLIED and resolved (verbatim reason).
 * Only the resolved ones belong here — an unresolved adjustment is a refusal,
 * shown by ContrastRefusalPanel instead.
 */
export function ReportCorrections({ corrections }: { corrections: TokenAdjustment[] }) {
  const resolved = corrections.filter((c) => c.resolved);
  if (resolved.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <WandSparklesIcon className="size-4 text-accent" aria-hidden />
        <span className="text-sm font-medium text-ink">
          Contrast corrections applied
        </span>
        <StatusPill tone="accent">{resolved.length}</StatusPill>
      </div>
      <p className="text-xs text-muted">
        We adjusted these colors to meet accessible contrast. The corrected values
        are what the kit stores and enforces.
      </p>
      <ul className="flex flex-col gap-2.5">
        {resolved.map((c, i) => (
          <li
            key={`${c.token}-${i}`}
            className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-raised px-3 py-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink">
                {COLOR_LABELS[c.token] ?? c.token}
              </span>
              <AdjustmentSwatches from={c.from} to={c.to} />
            </div>
            <p className="text-[11px] leading-4 text-muted">{c.reason}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const NOTE_LABELS: Record<IngestionNote["status"], string> = {
  defaulted: "Filled with a default",
  missing: "Not provided",
};

/**
 * Defaulted + missing inputs. Split honestly: a `defaulted` value is the skill's
 * choice (shown WITH the value, labeled a default — never presented as the
 * client's brand); a `missing` input is a real gap the operator should close.
 */
export function ReportNotes({ notes }: { notes: IngestionNote[] }) {
  if (notes.length === 0) return null;
  const defaulted = notes.filter((n) => n.status === "defaulted");
  const missing = notes.filter((n) => n.status === "missing");
  return (
    <div className="flex flex-col gap-3">
      {missing.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <CircleDashedIcon className="size-4 text-accent-warm" aria-hidden />
            <span className="text-sm font-medium text-ink">Not provided</span>
            <StatusPill tone="warm">{missing.length}</StatusPill>
          </div>
          <ul className="flex flex-col gap-1.5">
            {missing.map((n) => (
              <li key={n.field} className="text-xs leading-5 text-muted">
                {n.note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {defaulted.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">Filled with defaults</span>
            <StatusPill tone="muted">{defaulted.length}</StatusPill>
          </div>
          <ul className="flex flex-col gap-1.5">
            {defaulted.map((n) => (
              <li key={n.field} className="flex flex-wrap items-baseline gap-1.5 text-xs leading-5">
                <span className="text-muted">{n.note}</span>
                {n.value ? (
                  <span className="font-mono text-[11px] text-ink uppercase">{n.value}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-[11px] leading-4 text-muted">
        {NOTE_LABELS.defaulted} means the platform default, not the client’s
        brand. {NOTE_LABELS.missing} means no default exists — add it to close
        the gap.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Structured contrast REFUSAL (the honesty gate said no)              */
/* ------------------------------------------------------------------ */

const CHECK_LABELS: Record<string, string> = {
  ...COLOR_LABELS,
  surface: "surface",
  surfaceRaised: "raised surface",
};

function checkSentence(c: ContrastCheck): string {
  const fg = COLOR_LABELS[c.foreground as keyof ColorTokens] ?? c.foreground;
  const bg = CHECK_LABELS[c.background] ?? c.background;
  return `${fg} on ${bg}: ${c.ratio.toFixed(2)}:1 (needs ${c.required.toFixed(2)}:1)`;
}

/**
 * The structured refusal: the engine could NOT resolve this palette to
 * accessible contrast, so an unlockable, unreadable brand is being refused. We
 * render EXACTLY why — the specific failing checks and the engine's own reason
 * for each best-effort adjustment — plus the one thing the operator can change.
 * Never a generic "something went wrong". The panel is an alert (announced on
 * mount) and its heading is programmatically focusable (`headingRef` +
 * tabIndex −1) so the flow can move focus here when the refusal appears.
 *
 * The lead copy HEDGES ("most often") rather than diagnosing: the engine
 * reports which checks failed, not why — and causes other than a mid-gray
 * surface exist (e.g. positive/negative distinguishability). When the report
 * carries neither failing checks nor attempted adjustments, an honest fallback
 * line renders instead of a bare panel.
 */
export function ContrastRefusalPanel({
  report,
  headingRef,
}: {
  report: IngestionReport;
  /** Focus target for the flow's phase change (client callers only). */
  headingRef?: React.Ref<HTMLParagraphElement>;
}) {
  const failing = report.unresolvedContrast;
  const unresolvedAdjustments = report.contrastCorrections.filter((c) => !c.resolved);
  return (
    <div
      role="alert"
      className="flex flex-col gap-4 rounded-lg border border-negative/40 bg-negative/5 px-4 py-4"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-negative" aria-hidden />
        <div className="flex flex-col gap-1">
          <p
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold text-ink outline-none"
          >
            This palette can’t be locked — it isn’t accessible
          </p>
          <p className="text-xs leading-5 text-muted">
            An unreadable brand must never be locked and enforced downstream.
            Most often this means the surface color is too close to mid-gray for
            any accessible foreground — picking a clearly lighter or darker
            surface (or background) usually resolves it. Adjust the colors, then
            review again.
          </p>
        </div>
      </div>

      {failing.length === 0 && unresolvedAdjustments.length === 0 ? (
        <p className="text-xs leading-5 text-ink">
          The palette could not be resolved to accessible contrast. Adjust the
          brand colors and try again.
        </p>
      ) : null}

      {failing.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-wide text-muted uppercase">
            Failing contrast checks
          </span>
          <ul className="flex flex-col gap-1">
            {failing.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs text-ink">
                <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-negative" />
                <span className="font-mono leading-5">{checkSentence(c)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unresolvedAdjustments.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] tracking-wide text-muted uppercase">
            What we tried
          </span>
          <ul className="flex flex-col gap-2">
            {unresolvedAdjustments.map((c, i) => (
              <li key={`${c.token}-${i}`} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-ink">
                    {COLOR_LABELS[c.token] ?? c.token}
                  </span>
                  <AdjustmentSwatches from={c.from} to={c.to} />
                </div>
                <p className="text-[11px] leading-4 text-muted">{c.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** The clean-bill counterpart: every check passed, nothing was adjusted. */
export function ContrastClean() {
  return (
    <div className="flex items-center gap-2 text-xs text-positive">
      <CheckIcon className="size-4" aria-hidden />
      <span>Every color meets accessible contrast — no corrections needed.</span>
    </div>
  );
}
