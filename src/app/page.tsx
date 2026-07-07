import Link from "next/link";

/**
 * Placeholder root. Feature UI is Phase 1 and gated behind the F1/F2
 * freezes — until then, this page only points at the F2 review surface.
 */
export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">
        AEO/GEO + Brand Production OS
      </p>
      <h1 className="font-display text-3xl text-ink">
        Platform foundation in progress
      </h1>
      <p className="max-w-md text-sm text-muted">
        Feature UI is gated until the Phase 0 foundations freeze. The F2
        design system is ready for review.
      </p>
      <Link
        href="/design-system"
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:opacity-90"
      >
        Open the design-system review
      </Link>
    </main>
  );
}
