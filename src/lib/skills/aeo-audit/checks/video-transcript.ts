/**
 * Check 3 — Transcript + VideoObject on video pages (SKILL.md).
 * Every page with a video needs an indexable text transcript AND VideoObject
 * JSON-LD. Half credit per page for having one of the two.
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft } from "../types";
import { collectJsonLdNodes, nodeTypes, round1 } from "../util";

function hasVideoObjectSchema(jsonLdBlocks: string[]): boolean {
  for (const raw of jsonLdBlocks) {
    try {
      const nodes = collectJsonLdNodes(JSON.parse(raw));
      if (nodes.some((node) => nodeTypes(node).includes("VideoObject"))) return true;
    } catch {
      // invalid blocks are check 1's problem
    }
  }
  return false;
}

export function checkVideoTranscript(ctx: CheckContext): CheckOutcome {
  const videoPages = ctx.site.pages.filter((page) => page.hasVideo);
  if (videoPages.length === 0) {
    return {
      status: "skipped",
      skipReason: "not_applicable",
      score: null,
      evidence: [{ message: "No video pages detected — nothing to check (missing FAQ-video content is a plan gap, M1)." }],
      fixes: [],
    };
  }

  const evidence: EvidenceItem[] = [];
  const missingTranscript: string[] = [];
  const missingSchema: string[] = [];
  let pageScoreSum = 0;

  for (const page of videoPages) {
    const hasSchema = hasVideoObjectSchema(page.jsonLdBlocks);
    let pageScore = 0;
    if (page.hasTranscript) {
      pageScore += 50;
    } else {
      missingTranscript.push(page.url);
      evidence.push({
        url: page.url,
        field: "transcript",
        message: "Video page has no indexable text transcript — the video's content is invisible to engines.",
      });
    }
    if (hasSchema) {
      pageScore += 50;
    } else {
      missingSchema.push(page.url);
      evidence.push({
        url: page.url,
        field: "VideoObject",
        message: "Video page has no VideoObject JSON-LD.",
      });
    }
    pageScoreSum += pageScore;
  }

  const score = round1(pageScoreSum / videoPages.length);
  const fixes: FixDraft[] = [];

  if (missingTranscript.length > 0) {
    fixes.push({
      id: "video_transcript_schema/add-transcripts",
      checkId: "video_transcript_schema",
      title: `Publish indexable transcripts on ${missingTranscript.length} video page(s)`,
      detail:
        "The transcript is the indexable text surface of a video page (doc 02 real-estate template: FAQ page = direct answer + full transcript + VideoObject).",
      targetUrls: missingTranscript.sort(),
      impact: "high",
      impactEstimate: "High — without a transcript the video contributes zero citable text.",
      module: "M8",
      automationLevel: "ai_draft_human_approve",
    });
  }
  if (missingSchema.length > 0) {
    fixes.push({
      id: "video_transcript_schema/add-videoobject",
      checkId: "video_transcript_schema",
      title: `Add VideoObject JSON-LD to ${missingSchema.length} video page(s)`,
      detail: "Generate VideoObject schema via the schema-generation skill; it must match the on-page video and transcript.",
      targetUrls: missingSchema.sort(),
      impact: "medium",
      impactEstimate: "Medium — VideoObject makes the video machine-readable and eligible for video surfacing.",
      module: "M10",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return { status: "scored", score, evidence, fixes };
}
