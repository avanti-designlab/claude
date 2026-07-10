import type { LucideIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Shared operator-surface UI — the house treatment for every operator studio
 * and client-workspace tab. Server-safe (no client hooks), token-driven (no
 * hardcoded brand values), so it re-skins per tenant like the rest of the app.
 *
 * These pages are deliberately QUIET (doc 06 §4/§5: operator module UIs are
 * utilitarian — no glow, no signature motion). Honesty is the through-line:
 * a page is either WIRED (a real RLS-scoped read that renders ready / an honest
 * empty / pending / failed state) or an explicit "being built" studio — never
 * a lorem page and never a fabricated number.
 */

/* ------------------------------------------------------------------ */
/* Page header                                                         */
/* ------------------------------------------------------------------ */

export function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  level = "h1",
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  /**
   * Heading level. Global studios are their page's `h1`; a client-workspace tab
   * is an `h2` under the workspace layout's client-name `h1` (correct document
   * outline, one h1 per page).
   */
  level?: "h1" | "h2";
}) {
  const Heading = level;
  const headingClass =
    level === "h1"
      ? "font-display text-3xl font-bold tracking-[-0.02em] text-ink"
      : "font-display text-2xl font-bold tracking-tight text-ink";
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        {eyebrow ? (
          <span className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
            {eyebrow}
          </span>
        ) : null}
        <Heading className={headingClass}>{title}</Heading>
        {description ? (
          <p className="max-w-2xl text-sm text-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel card + honest states                                          */
/* ------------------------------------------------------------------ */

export function PanelCard({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="font-display text-xl leading-tight font-bold tracking-tight">
              {title}
            </CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </div>
          {aside ? <div className="shrink-0">{aside}</div> : null}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** A small status pill (utilitarian — no glow). */
export function StatusPill({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "accent" | "positive" | "warm" | "negative";
  children: React.ReactNode;
}) {
  const toneClass: Record<string, string> = {
    muted: "border-border text-muted",
    accent: "border-accent/40 text-accent",
    positive: "border-positive/40 text-positive",
    warm: "border-accent-warm/40 text-accent-warm",
    negative: "border-negative/40 text-negative",
  };
  return (
    <span
      className={
        "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase " +
        toneClass[tone]
      }
    >
      {children}
    </span>
  );
}

/**
 * The honest PENDING state — the real data source isn't connected yet. Quiet by
 * design (dashed, muted): it never competes with real data and never shows a
 * fabricated number. Copy names what has to connect, in the interface voice.
 */
export function PendingState({
  icon: Icon,
  title,
  measuring,
  action,
}: {
  icon: LucideIcon;
  title: string;
  measuring: string;
  /** Optional first-action affordance, centered below the copy. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-overlay"
      >
        <Icon className="size-5 text-muted" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          <StatusPill tone="warm">Measuring soon</StatusPill>
        </div>
        <p className="max-w-sm text-xs leading-5 text-muted">{measuring}</p>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

/** A read failed (retryable) — honest, never mistaken for "no data". */
export function FailedState({ subject }: { subject: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">Couldn&apos;t load {subject}</p>
      <p className="max-w-sm text-xs leading-5 text-muted">
        This is a temporary read issue, not a data problem — refresh to try
        again.
      </p>
    </div>
  );
}

/**
 * A real, healthy empty state — "nothing here yet", not a placeholder. Doc 06
 * §4 makes empty states "inviting first-action moments", so an optional `action`
 * (a Button/Link) can be offered below the copy. The prop is optional: existing
 * call sites render exactly as before.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Optional first-action affordance, centered below the description. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-12 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-overlay"
      >
        <Icon className="size-5 text-muted" strokeWidth={1.75} />
      </span>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-sm text-xs leading-5 text-muted">{description}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* "Being built" studio                                                */
/* ------------------------------------------------------------------ */

/**
 * The honest placeholder for a studio whose deep build lands in a later wave.
 * NOT a broken/lorem page: a designed, F2-native statement of intent — what the
 * studio is, what it will do, and (optionally) what has to connect first. It
 * says so plainly instead of faking a working screen.
 */
export function StudioPlaceholder({
  icon: Icon,
  title,
  lead,
  capabilities,
  note,
}: {
  icon: LucideIcon;
  title: string;
  lead: string;
  capabilities: string[];
  note?: string;
}) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex flex-col items-center gap-6 px-6 py-14 text-center sm:py-16">
        <span
          aria-hidden
          className="flex size-14 items-center justify-center rounded-2xl bg-overlay"
        >
          <Icon className="size-6 text-accent" strokeWidth={1.75} />
        </span>
        <div className="flex max-w-xl flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-2xl font-bold tracking-tight text-ink">
              {title}
            </h2>
            <StatusPill tone="accent">In build</StatusPill>
          </div>
          <p className="text-base leading-6 text-muted">{lead}</p>
        </div>
        <ul className="grid w-full max-w-xl gap-2 text-left sm:grid-cols-2">
          {capabilities.map((cap) => (
            <li
              key={cap}
              className="flex items-start gap-2 rounded-lg border border-border bg-surface-raised px-3.5 py-2.5 text-sm text-ink"
            >
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"
              />
              <span className="leading-5">{cap}</span>
            </li>
          ))}
        </ul>
        {note ? (
          <p className="max-w-xl text-xs leading-5 text-muted">{note}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
