import type { Metadata } from "next";
import { DashboardPreview } from "./dashboard";

export const metadata: Metadata = {
  title: "Design preview — sample dashboard",
  description:
    "A visual target for the operator dashboard, rendered in the operator brand with sample data. Not the live M19 module.",
};

/**
 * DESIGN PREVIEW route. Clearly labeled sample; a reaction/target surface for
 * the operator, not the real dashboard (doc 07 §1.10 builds M19 later to match
 * this). All chrome is token-driven — it re-skins per tenant like the app.
 */
export default function DashboardPreviewPage() {
  return <DashboardPreview />;
}
