import type { Metadata } from "next";
import { DashboardPreview } from "./dashboard";

export const metadata: Metadata = {
  title: "Design preview — sample dashboard",
  description:
    "A visual target for the operator dashboard, rendered in the operator brand with sample data. Not the live M19 module.",
};

/**
 * DESIGN PREVIEW route — working brand v1 (consolidated, 2026-07-08). The
 * operator brand is now the APP-WIDE dual-palette theme applied in the root
 * layout, so this page needs no scope wrapper and no variant param: it
 * renders in the light blue-depth palette by default and in the dark-glow
 * palette under the standard mode mechanism (OS preference / `data-theme`).
 * The page's Light / Dark-glow toggle drives that same mechanism
 * (ModeToggle). All chrome is token-driven — swap the tenant theme and the
 * page re-skins with zero code changes.
 */
export default function DashboardPreviewPage() {
  return <DashboardPreview />;
}
