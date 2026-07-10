import type { Metadata } from "next";
import { ImageIcon } from "lucide-react";

import { Entrance } from "@/components/moments";
import {
  PageContainer,
  PageHeader,
  StudioPlaceholder,
} from "../../_components/surface";

export const metadata: Metadata = {
  title: "Image & Media Studio — AEO/GEO + Brand Production OS",
  description:
    "Brand-consistent images, video, and voice for social and on-page assets.",
};

/**
 * Image & Media Studio (global) — brand-consistent creative production (M11
 * social design). Media is generated brand-forced from the client's kit via the
 * in-product media engines (Higgsfield / Motion), which are deferred behind
 * fail-closed vendor ports. The studio surface arrives with that wiring.
 */
export default function MediaStudioPage() {
  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Studios"
          title="Image & Media Studio"
          description="On-brand images, video, and voice for social and on-page assets — forced through each client's brand kit so everything ships looking like the same brand."
        />
      </Entrance>
      <Entrance step={1}>
        <StudioPlaceholder
          icon={ImageIcon}
          title="The media studio is being built"
          lead="Creative is generated brand-forced from the client's kit — never off-brand. The generation surface connects to the in-product media engines in a later wave."
          capabilities={[
            "Generate images, short video, and voice for a client",
            "Brand-locked to the client's palette, type, and likeness references",
            "Captions written in the client's voice, ready for scheduling",
            "Assets flow into the review queue before anything is published",
          ]}
          note="Media production runs through the in-product engines — never used to style this app's own interface."
        />
      </Entrance>
    </PageContainer>
  );
}
