import type { Metadata } from "next";
import { LandmarkIcon } from "lucide-react";

import { readEntityAuthorityHistory } from "@/lib/pr/persist";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "PR & Entity — Client workspace",
};

/**
 * PR & Entity tab — entity-leverage (M12): turning a client's existing press
 * into entity signals (Press section, Person sameAs, on-page mentions). Reads
 * `readEntityAuthorityHistory` (RLS-scoped). Claimed vs corroborated press is
 * reported separately — an uncorroborated mention is never counted as proven.
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

export default async function PrEntityTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await tryCreateClient();
  const result = supabase
    ? await readEntityAuthorityHistory(supabase, clientId)
    : ({ ok: false } as const);
  const latest = result.ok && result.entries.length > 0 ? result.entries[0] : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="PR & Entity"
        description="Turning the client's existing press into entity signals search and AI engines trust — a Press section, Person sameAs, and on-page mentions."
      />

      <PanelCard
        title="Entity authority"
        description="Press signals assessed for this client, newest first"
      >
        {!result.ok ? (
          <FailedState subject="entity authority" />
        ) : !latest ? (
          <PendingState
            icon={LandmarkIcon}
            title="No entity assessment yet"
            measuring="The first assessment maps the client's press into entity signals — corroborated mentions, sameAs links, and the fixes to strengthen them. New-PR outreach stays human-assisted."
          />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end gap-6 rounded-lg border border-border bg-surface-raised px-5 py-4">
              <div className="flex flex-col">
                <span className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                  Authority score
                </span>
                <span className="font-display text-4xl font-bold tabular-nums text-ink">
                  {latest.overallScore ?? "—"}
                </span>
              </div>
              <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                <Metric label="Press corroborated" value={latest.pressCorroborated ?? 0} />
                <Metric label="Press claimed" value={latest.pressClaimed ?? 0} />
                <Metric label="Fixes queued" value={latest.fixCount ?? 0} />
              </dl>
            </div>
            <ul className="flex flex-col">
              {result.entries.map((entry, i) => (
                <li
                  key={entry.id}
                  className={
                    "flex items-center justify-between gap-3 py-3" +
                    (i > 0 ? " border-t border-border" : "")
                  }
                >
                  <div className="flex flex-col">
                    <span className="text-sm text-ink">{medDate(entry.createdAt)}</span>
                    <span className="font-mono text-xs text-muted">
                      {entry.pressCorroborated ?? 0} corroborated ·{" "}
                      {entry.pressClaimed ?? 0} claimed
                    </span>
                  </div>
                  <span className="font-display text-xl font-bold tabular-nums text-ink">
                    {entry.overallScore ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PanelCard>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
        {label}
      </dt>
      <dd className="font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}
