import type { Metadata } from "next";
import { PenLineIcon } from "lucide-react";

import { Entrance } from "@/components/moments";
import {
  PageContainer,
  PageHeader,
  StudioPlaceholder,
} from "../../_components/surface";

export const metadata: Metadata = {
  title: "Content Studio — AEO/GEO + Brand Production OS",
  description:
    "Generate on-brand, humanized, compliant content through the review pipeline.",
};

/**
 * Content Studio (global) — the production surface for M8 content + M9
 * authenticity. The engines are built and gated behind fail-closed vendor ports
 * (Anthropic, humanizer, detectors); the studio UI (brief → draft → pipeline
 * kanban) lands in a later wave, so this states its intent honestly rather than
 * faking an editor.
 */
export default function ContentStudioPage() {
  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Studios"
          title="Content Studio"
          description="Blogs, FAQs, and pillar pages written in each client's locked brand voice — then humanized, detection-checked, and gated before anything reaches a page."
        />
      </Entrance>
      <Entrance step={1}>
        <StudioPlaceholder
          icon={PenLineIcon}
          title="The content studio is being built"
          lead="The production engines are live behind their review gates. The authoring surface — brief a piece, watch it move through the pipeline, approve or send back — is coming in a later wave."
          capabilities={[
            "Draft blogs, FAQs, and pillar pages mapped to the client's playbook",
            "Every draft written in the client's locked brand voice",
            "Generate → humanize → detection → quality → compliance → schema → publish",
            "Nothing advances past a failed gate; humans approve before publish",
          ]}
          note="AI drafts, humans approve — fully autonomous publishing stays prohibited for content."
        />
      </Entrance>
    </PageContainer>
  );
}
