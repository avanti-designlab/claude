/**
 * The client-workspace tab model — one reachable route per tab. Client-safe
 * (no server imports) so the tab bar and the layout share a single source of
 * truth. Each `segment` is appended to `/clients/[clientId]/`.
 *
 * NOTE: no internal module codes here or in any rendered label — these are
 * operator-facing names for what the tab shows (doc 06 §6).
 */
export interface WorkspaceTab {
  segment: string;
  label: string;
}

export const WORKSPACE_TABS: WorkspaceTab[] = [
  { segment: "overview", label: "Overview" },
  { segment: "plan", label: "Plan" },
  { segment: "audit", label: "Audit" },
  { segment: "visibility", label: "Visibility" },
  { segment: "crawler-health", label: "Crawler Health" },
  { segment: "content-decay", label: "Content Decay" },
  { segment: "local-seo", label: "Local SEO" },
  { segment: "reviews", label: "Reviews" },
  { segment: "pr-entity", label: "PR & Entity" },
  { segment: "site-changes", label: "Site Changes" },
];

/** The default landing tab when a workspace is opened without a segment. */
export const WORKSPACE_DEFAULT_TAB = "overview";
