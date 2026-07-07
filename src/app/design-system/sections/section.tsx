import type { ReactNode } from "react";

/** Shared section chrome for the showcase: mono overline + display heading. */
export function Section({
  id,
  overline,
  title,
  description,
  children,
}: {
  id: string;
  overline: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">{overline}</p>
        <h2 id={`${id}-title`} className="font-display text-3xl text-ink">
          {title}
        </h2>
        {description ? <p className="max-w-2xl text-sm text-muted">{description}</p> : null}
      </header>
      {children}
    </section>
  );
}

/** A quiet panel for grouping specimens. */
export function SpecimenPanel({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="mb-3 font-mono text-xs text-muted">{label}</p>
      <div className="rounded-lg border bg-surface-raised p-5">{children}</div>
    </div>
  );
}
