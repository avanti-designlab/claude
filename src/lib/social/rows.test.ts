/**
 * Caption row mapping — the PRE-APPROVAL structural guarantee (CLAUDE.md rule 5).
 * Proves the insert row hard-pins type='caption', status='draft', automation_level=
 * 'ai_draft_human_approve' (reusing M8's literals), and NEVER sets a review verdict or
 * humanization (writing those would be self-approval). Plus the schema-gap flag shape.
 */

import { describe, expect, it } from "vitest";
import { M8_AUTOMATION_LEVEL, M8_INITIAL_STATUS } from "@/lib/production/content";
import {
  captionInsertRow,
  CAPTION_AUTOMATION_LEVEL,
  CAPTION_CONTENT_TYPE,
  CAPTION_GENERATION_TYPE_GAP,
  CAPTION_INITIAL_STATUS,
  SOCIAL_MEDIA_REF_SCHEMA_GAP,
  SOCIAL_SCHEDULE_SCHEMA_GAP,
} from "./rows";

describe("captionInsertRow", () => {
  const row = captionInsertRow({ tenantId: "t1", clientId: "c1", brandKitId: "kit-1", body: "hello world" });

  it("hard-pins type='caption', status='draft', automation_level='ai_draft_human_approve'", () => {
    expect(row.type).toBe("caption");
    expect(row.status).toBe("draft");
    expect(row.automation_level).toBe("ai_draft_human_approve");
    // never the states that could enable autonomous publishing
    expect(row.status).not.toBe("approved");
    expect(row.automation_level).not.toBe("auto");
  });

  it("reuses M8's pinned pre-approval literals verbatim (one governance source, anti-drift)", () => {
    expect(CAPTION_INITIAL_STATUS).toBe(M8_INITIAL_STATUS);
    expect(CAPTION_AUTOMATION_LEVEL).toBe(M8_AUTOMATION_LEVEL);
    expect(CAPTION_CONTENT_TYPE).toBe("caption");
  });

  it("sets ONLY the scoping + content columns — no review verdict, no humanization", () => {
    expect(row).not.toHaveProperty("quality_review");
    expect(row).not.toHaveProperty("compliance_review");
    expect(row).not.toHaveProperty("humanization");
    expect(row).not.toHaveProperty("id"); // db-generated
    expect(row).toMatchObject({ tenant_id: "t1", client_id: "c1", brand_kit_id: "kit-1", body: "hello world" });
  });
});

describe("schema-gap flags (greppable follow-ups)", () => {
  it("are descriptive strings naming the missing home + the post-freeze path", () => {
    for (const flag of [CAPTION_GENERATION_TYPE_GAP, SOCIAL_MEDIA_REF_SCHEMA_GAP, SOCIAL_SCHEDULE_SCHEMA_GAP]) {
      expect(typeof flag).toBe("string");
      expect(flag.length).toBeGreaterThan(40);
    }
    expect(SOCIAL_SCHEDULE_SCHEMA_GAP).toContain("social_posts");
    expect(SOCIAL_MEDIA_REF_SCHEMA_GAP).toContain("content_items");
  });
});
