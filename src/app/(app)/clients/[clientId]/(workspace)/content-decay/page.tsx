import type { Metadata } from "next";
import { CalendarClockIcon } from "lucide-react";

import {
  PageHeader,
  StudioPlaceholder,
} from "../../../../_components/surface";

export const metadata: Metadata = {
  title: "Content Decay — Client workspace",
};

/**
 * Content Decay tab — the freshness engine (M6). Unlike the other intelligence
 * modules, decay is computed ON DEMAND and persists nothing today, so there is
 * no stored history to read. Rather than fake a table, this states plainly what
 * the scan does and where it lands (the plan) once wired — an honest "being
 * built" surface, not a broken page.
 */
export default function ContentDecayTab({}: {
  params: Promise<{ clientId: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Content Decay"
        description="Pages past their refresh window and stats that have gone stale — queued for a dated refresh so AI engines keep trusting the client's content."
      />
      <StudioPlaceholder
        icon={CalendarClockIcon}
        title="The decay scan is being wired in"
        lead="The freshness engine flags aging pages and stale stats on demand. Its findings will queue here — and feed the plan — once the scan is scheduled for this client."
        capabilities={[
          "Flag pages past their vertical's refresh window",
          "Detect stale statistics and out-of-date claims",
          "Queue refreshes with an updated last-modified date",
          "Findings flow into the plan as prioritized tasks",
        ]}
        note="Decay runs as a scan, not a stored feed — this tab lights up when the scan is scheduled."
      />
    </div>
  );
}
