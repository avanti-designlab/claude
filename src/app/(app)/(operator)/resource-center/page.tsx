import type { Metadata } from "next";
import { BookOpenIcon } from "lucide-react";

import { Entrance } from "@/components/moments";
import {
  PageContainer,
  PageHeader,
  StudioPlaceholder,
} from "../../_components/surface";

export const metadata: Metadata = {
  title: "Resource Center — AEO/GEO + Brand Production OS",
  description:
    "A vertical-scoped research assistant for AEO, compliance, and prompt intelligence.",
};

/**
 * Resource Center (global) — the playbook-scoped Q&A assistant (M18): a
 * Claude-powered research aid for operators, scoped to a client's vertical, with
 * cited sources from web search. The engine is built behind deferred
 * Anthropic + web-search ports; the conversational surface lands in a later
 * wave.
 */
export default function ResourceCenterPage() {
  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Knowledge"
          title="Resource Center"
          description="Ask questions about a client's vertical — AEO tactics, compliance constraints, prompt-volume intelligence — and get answers with cited sources."
        />
      </Entrance>
      <Entrance step={1}>
        <StudioPlaceholder
          icon={BookOpenIcon}
          title="The resource center is being built"
          lead="A conversational research aid, scoped to the client's playbook. The engine treats every source as untrusted — citations are verified, fabricated sources stripped — and the chat surface arrives in a later wave."
          capabilities={[
            "Vertical-scoped answers grounded in the client's playbook",
            "Sources cited from web search and verified, not asserted",
            "Compliance and regulatory questions per vertical",
            "Prompt-volume and AEO-opportunity research",
          ]}
          note="Answers are a research aid — regulated-claim answers still route through compliance review."
        />
      </Entrance>
    </PageContainer>
  );
}
