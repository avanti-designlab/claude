import type { Metadata } from "next";
import { MapPinnedIcon } from "lucide-react";

import { readLocalHistory } from "@/lib/local/persist";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "Local SEO — Client workspace",
};

/**
 * Local SEO tab — GBP, NAP consistency, local schema, and local-pack readiness
 * across the client's locations (M14). Reads `readLocalHistory` (RLS-scoped).
 * Absent ≠ zero — no assessment yet reads as pending, never a score of 0.
 */

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

export default async function LocalSeoTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await tryCreateClient();
  const result = supabase
    ? await readLocalHistory(supabase, clientId)
    : ({ ok: false } as const);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Local SEO"
        description="Google Business Profile, NAP consistency across directories, local schema, and local-pack readiness — assessed per location."
      />

      <PanelCard
        title="Local readiness"
        description="Each assessment across the client's locations, newest first"
      >
        {!result.ok ? (
          <FailedState subject="local presence" />
        ) : result.entries.length === 0 ? (
          <PendingState
            icon={MapPinnedIcon}
            title="No local assessment yet"
            measuring="The first assessment scores NAP consistency, local schema, and local-pack readiness across every location — and lists the fixes to close the gaps."
          />
        ) : (
          <ul className="flex flex-col">
            {result.entries.slice(0, 12).map((entry, i) => (
              <li
                key={entry.id}
                className={
                  "flex items-center justify-between gap-3 py-3" +
                  (i > 0 ? " border-t border-border" : "")
                }
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span
                    aria-hidden
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                  >
                    <MapPinnedIcon className="size-4 text-accent" strokeWidth={2} />
                  </span>
                  <div className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">
                      {entry.assessedLocations ?? 0} of {entry.totalLocations ?? 0}{" "}
                      locations assessed
                    </span>
                    <span className="block font-mono text-xs text-muted">
                      {medDate(entry.createdAt)}
                      {entry.fixCount ? ` · ${entry.fixCount} fixes queued` : ""}
                    </span>
                  </div>
                </div>
                <span className="shrink-0 font-display text-xl font-bold tabular-nums text-ink">
                  {entry.overallScore ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
    </div>
  );
}
