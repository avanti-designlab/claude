/**
 * Pure ContentDraft ⇄ `content_items` row mapping (FROZEN schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql). Mirrors the
 * audit/brand-kit rows split (no server imports, no Supabase client) — unit-
 * tested in the default `npm test` run; the write action feeds these rows to
 * PostgREST and shapes reads back through them.
 *
 * THE STRUCTURAL PRE-APPROVAL GUARANTEE (CLAUDE.md rule 5; doc 05 pipeline).
 * `contentDraftInsertRow` is the ONLY way M8 builds a row, and it HARD-PINS the
 * two fields that could otherwise let a freshly generated item publish itself:
 *   - status            = 'draft'                  (never approved/published)
 *   - automation_level  = 'ai_draft_human_approve' (never 'auto')
 * Neither is a parameter — no caller, hostile or careless, can raise a draft to
 * an approved/publishable state through this builder. It also NEVER sets
 * `quality_review` / `compliance_review` (those are the independent review
 * agents' verdicts — M8 writing them would be self-approval) nor `humanization`
 * (M9's). With both review columns NULL, the DB CHECK
 * `content_items_reviewed_before_approval` makes 'approved'/'published'
 * structurally unreachable for an M8 row regardless — code pin + schema pin,
 * belt and braces.
 *
 * Even though `content_items.automation_level` PERMITS 'auto' at the column
 * level (unlike `site_changes`), M8 pins 'ai_draft_human_approve' because every
 * blog/faq/pillar it makes is publish-bound content, and publish-bound content
 * is never autonomous (doc 03 §6; doc 00 §2). This is the same automation clamp
 * M1/M10/M13 apply — content-publishing actions are never 'auto'.
 */

import type {
  AutomationLevel,
  ContentItemStatus,
  ContentItemType,
  HumanizationResult,
  ReviewVerdict,
} from "@/lib/types/db";
import type { GeneratableContentType } from "./types";

/** The pinned pre-approval literals — exported so tests can assert the constants directly. */
export const M8_INITIAL_STATUS = "draft" as const satisfies ContentItemStatus;
export const M8_AUTOMATION_LEVEL = "ai_draft_human_approve" as const satisfies AutomationLevel;

/** Insert shape for `content_items` — ONLY the columns M8 sets; the rest default in-DB. */
export interface ContentItemInsertRow {
  tenant_id: string;
  client_id: string;
  type: ContentItemType;
  brand_kit_id: string;
  /** Always 'ai_draft_human_approve' — pinned, not a parameter. */
  automation_level: typeof M8_AUTOMATION_LEVEL;
  body: string;
  /** Always 'draft' — pinned, not a parameter. */
  status: typeof M8_INITIAL_STATUS;
}

/**
 * Build the `content_items` row for ONE freshly generated draft. `type` is a
 * GeneratableContentType (blog/faq/pillar) — caption/schema_copy are structurally
 * unrepresentable here. `status` and `automation_level` are hard-pinned to the
 * pre-approval state (see the module header); nothing the caller passes can
 * change them.
 */
export function contentDraftInsertRow(args: {
  tenantId: string;
  clientId: string;
  brandKitId: string;
  type: GeneratableContentType;
  body: string;
}): ContentItemInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    type: args.type,
    brand_kit_id: args.brandKitId,
    automation_level: M8_AUTOMATION_LEVEL,
    body: args.body,
    status: M8_INITIAL_STATUS,
  };
}

/* ------------------------------------------------------------------ */
/* Reads — shaped for the review gates + the dashboard work-log        */
/* ------------------------------------------------------------------ */

/** How far a draft has moved down the pipeline — read by the review-gate consumers + M9. */
export interface DraftPipelineState {
  /** From humanization.humanized; null when M9 hasn't run yet. */
  humanized: boolean | null;
  /** From humanization.passes (detection gate); null when M9 hasn't run yet. */
  detectionPasses: boolean | null;
  /** content-quality has recorded a verdict (`quality_review` present). */
  qualityReviewed: boolean;
  /** compliance-review has recorded a verdict (`compliance_review` present). */
  complianceReviewed: boolean;
}

/** Lean list entry — the review queue + the dashboard work-log row. */
export interface ContentDraftSummary {
  id: string;
  type: ContentItemType;
  status: ContentItemStatus;
  automationLevel: AutomationLevel;
  brandKitId: string;
  /** Safe leading slice of the body (never the whole thing in a list). */
  bodyPreview: string;
  bodyLength: number;
  pipeline: DraftPipelineState;
  createdAt: string;
  updatedAt: string;
}

/** Full item for a reviewer (Content Quality / Compliance) or M9 — the body + prior verdicts. */
export interface ContentDraftDetail extends ContentDraftSummary {
  body: string;
  humanization: HumanizationResult | null;
  qualityReview: ReviewVerdict | null;
  complianceReview: ReviewVerdict | null;
}

/** Chars of body surfaced in a list summary (recency/scan, not full read). */
export const CONTENT_PREVIEW_CHARS = 240;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function pipelineState(row: {
  humanization: unknown;
  quality_review: unknown;
  compliance_review: unknown;
}): DraftPipelineState {
  const h = isObject(row.humanization) ? row.humanization : null;
  return {
    humanized: h ? boolOrNull(h.humanized) : null,
    detectionPasses: h ? boolOrNull(h.passes) : null,
    // A verdict is "present" only when it's a real object (defensive against a
    // malformed non-object jsonb — the DB CHECK already requires object|null).
    qualityReviewed: isObject(row.quality_review),
    complianceReviewed: isObject(row.compliance_review),
  };
}

/** Shape a raw `content_items` row into a lean summary (list). */
export function contentDraftSummary(row: {
  id: string;
  type: ContentItemType;
  status: ContentItemStatus;
  automation_level: AutomationLevel;
  brand_kit_id: string;
  body: unknown;
  humanization: unknown;
  quality_review: unknown;
  compliance_review: unknown;
  created_at: string;
  updated_at: string;
}): ContentDraftSummary {
  const body = typeof row.body === "string" ? row.body : "";
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    automationLevel: row.automation_level,
    brandKitId: row.brand_kit_id,
    bodyPreview: body.slice(0, CONTENT_PREVIEW_CHARS),
    bodyLength: body.length,
    pipeline: pipelineState(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Shape a raw `content_items` row into the full detail (single-item read). */
export function contentDraftDetail(row: {
  id: string;
  type: ContentItemType;
  status: ContentItemStatus;
  automation_level: AutomationLevel;
  brand_kit_id: string;
  body: unknown;
  humanization: unknown;
  quality_review: unknown;
  compliance_review: unknown;
  created_at: string;
  updated_at: string;
}): ContentDraftDetail {
  const summary = contentDraftSummary(row);
  return {
    ...summary,
    body: typeof row.body === "string" ? row.body : "",
    humanization: isObject(row.humanization) ? (row.humanization as unknown as HumanizationResult) : null,
    qualityReview: isObject(row.quality_review) ? (row.quality_review as ReviewVerdict) : null,
    complianceReview: isObject(row.compliance_review) ? (row.compliance_review as ReviewVerdict) : null,
  };
}
