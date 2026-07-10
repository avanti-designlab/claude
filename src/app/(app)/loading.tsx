import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for the operator app pages. Reuses the F2
 * Skeleton primitive, laid out to match the standard page container (header +
 * stat strip + content panels) so navigation never flashes an empty frame or
 * shifts layout when the real page resolves. Quiet by design.
 */
export default function AppLoading() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10"
    >
      {/* Header */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>

      {/* Content panels */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>

      <span className="sr-only">Loading…</span>
    </div>
  );
}
