import type { Metadata } from "next";
import { DesignSystemShowcase } from "./showcase";

export const metadata: Metadata = {
  title: "Design system — F2 review",
  description:
    "The Signal design system: tokens, white-label theming, components, charts, and the five animated moments.",
};

/**
 * F2 review surface (doc 06 §8). This route exists for Design Review and the
 * operator's freeze sign-off: every component in both modes, the full
 * tenant re-skin demo, the accessibility-gate report, and all five animated
 * moments with a reduced-motion toggle.
 */
export default function DesignSystemPage() {
  return <DesignSystemShowcase />;
}
