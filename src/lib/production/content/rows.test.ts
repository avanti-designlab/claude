/**
 * content_items row mapping — the STRUCTURAL pre-approval guarantee + the read
 * shapes. Pure; no DB.
 */

import { describe, expect, it } from "vitest";
import {
  contentDraftDetail,
  contentDraftInsertRow,
  contentDraftSummary,
  CONTENT_PREVIEW_CHARS,
  M8_AUTOMATION_LEVEL,
  M8_INITIAL_STATUS,
} from "./rows";

const BASE = {
  tenantId: "tenant-1",
  clientId: "client-1",
  brandKitId: "kit-1",
  body: "A grounded, brand-voiced draft.",
};

describe("contentDraftInsertRow — pre-approval is structural (never auto-approve)", () => {
  it("hard-pins status='draft' and automation_level='ai_draft_human_approve'", () => {
    const row = contentDraftInsertRow({ ...BASE, type: "blog" });
    expect(row.status).toBe("draft");
    expect(row.automation_level).toBe("ai_draft_human_approve");
    expect(M8_INITIAL_STATUS).toBe("draft");
    expect(M8_AUTOMATION_LEVEL).toBe("ai_draft_human_approve");
  });

  it("emits ONLY the columns M8 sets — never a review verdict or humanization", () => {
    const row = contentDraftInsertRow({ ...BASE, type: "pillar" });
    expect(Object.keys(row).sort()).toEqual(
      ["automation_level", "body", "brand_kit_id", "client_id", "status", "tenant_id", "type"].sort(),
    );
    // Review columns + humanization are absent → default NULL in-DB, so the
    // reviewed-before-approval CHECK keeps approved/published unreachable.
    expect(row).not.toHaveProperty("quality_review");
    expect(row).not.toHaveProperty("compliance_review");
    expect(row).not.toHaveProperty("humanization");
  });

  it("carries the claim/RLS-sourced scope + honest type, and nothing else can raise the state", () => {
    const row = contentDraftInsertRow({ ...BASE, type: "faq" });
    expect(row).toMatchObject({
      tenant_id: "tenant-1",
      client_id: "client-1",
      brand_kit_id: "kit-1",
      type: "faq",
      body: "A grounded, brand-voiced draft.",
    });
    // There is no parameter path to 'auto' or 'approved' — the literals are fixed.
    expect(row.status).not.toBe("approved");
    expect(row.status).not.toBe("published");
    expect(row.automation_level).not.toBe("auto");
  });
});

/* ------------------------------------------------------------------ */
/* Read shapes                                                          */
/* ------------------------------------------------------------------ */

function rawRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ci-1",
    type: "blog" as const,
    status: "draft" as const,
    automation_level: "ai_draft_human_approve" as const,
    brand_kit_id: "kit-1",
    body: "hello world",
    humanization: null,
    quality_review: null,
    compliance_review: null,
    created_at: "2026-07-09T00:00:00Z",
    updated_at: "2026-07-09T00:00:00Z",
    ...overrides,
  };
}

describe("contentDraftSummary — pipeline state for the review gates", () => {
  it("reports a fresh draft as not-yet-humanized, not-yet-reviewed", () => {
    const s = contentDraftSummary(rawRow());
    expect(s.pipeline).toEqual({
      humanized: null,
      detectionPasses: null,
      qualityReviewed: false,
      complianceReviewed: false,
    });
    expect(s.status).toBe("draft");
    expect(s.automationLevel).toBe("ai_draft_human_approve");
  });

  it("reflects M9 + review verdicts as they land", () => {
    const s = contentDraftSummary(
      rawRow({
        humanization: { humanized: true, detection_score: 0.12, passes: true },
        quality_review: { verdict: "pass" },
        compliance_review: { verdict: "pass" },
        status: "approved",
      }),
    );
    expect(s.pipeline).toEqual({
      humanized: true,
      detectionPasses: true,
      qualityReviewed: true,
      complianceReviewed: true,
    });
  });

  it("truncates the body preview and reports the full length", () => {
    const long = "x".repeat(CONTENT_PREVIEW_CHARS + 50);
    const s = contentDraftSummary(rawRow({ body: long }));
    expect(s.bodyPreview).toHaveLength(CONTENT_PREVIEW_CHARS);
    expect(s.bodyLength).toBe(CONTENT_PREVIEW_CHARS + 50);
  });

  it("degrades a malformed humanization jsonb to null flags (defensive)", () => {
    const s = contentDraftSummary(rawRow({ humanization: "corrupt" }));
    expect(s.pipeline.humanized).toBeNull();
    expect(s.pipeline.detectionPasses).toBeNull();
  });
});

describe("contentDraftDetail", () => {
  it("adds the full body + prior verdicts for a reviewer / M9", () => {
    const d = contentDraftDetail(
      rawRow({
        body: "full body",
        humanization: { humanized: true, detection_score: 0.2, passes: false },
        quality_review: { verdict: "revise" },
      }),
    );
    expect(d.body).toBe("full body");
    expect(d.humanization).toEqual({ humanized: true, detection_score: 0.2, passes: false });
    expect(d.qualityReview).toEqual({ verdict: "revise" });
    expect(d.complianceReview).toBeNull();
    // Detail is a superset of the summary.
    expect(d.pipeline.detectionPasses).toBe(false);
  });
});
