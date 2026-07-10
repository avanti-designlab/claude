import { Skeleton } from "@/components/ui/skeleton";

/**
 * Tab-content loading skeleton for the client workspace. The workspace layout
 * (breadcrumb, client header, tab bar) persists around this while a tab's data
 * resolves; this fills only the content slot, shaped like a tab's header +
 * panel so there's no layout shift. Reuses the F2 Skeleton primitive.
 */
export default function WorkspaceLoading() {
  return (
    <div role="status" aria-label="Loading" className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
