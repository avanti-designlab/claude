import "server-only";

/**
 * Review-detail READS for the Review & Approvals studio (the operator item /
 * site-change detail pages). A THIN, RLS-scoped read layer that the landed
 * lifecycle (persist.ts / actions.ts) deliberately does NOT expose, because
 * neither existing read is sufficient for the detail SURFACE:
 *
 *   - production/content readContentDraftById selects no `title` / `body_hash`;
 *   - review/persist readReviewRow selects no `body` / `title` / timestamps.
 *
 * A reviewer's detail page needs BOTH the body AND the body_hash (to say,
 * honestly, whether a recorded verdict is bound to the CURRENT revision). So
 * this module adds exactly the reads the page needs and NOTHING more — it never
 * writes, never widens scope, and follows the module's read patterns
 * (maybeSingle, RLS-scoped, a nonexistent OR another-tenant id is the SAME empty
 * observation → null; doc 03 §4). It is a plain server-only module (NOT
 * "use server"): the detail pages are Server Components that call it directly;
 * exporting reads from an action file would mint each as a browser RPC.
 *
 * Tenant isolation: every read passes the CLAIM-SCOPED Supabase client, so RLS
 * (`content_items_select`, `site_changes_select`, `properties_select`) pins
 * `tenant_id = app.tenant_id()` (and client-scope for a viewer) in the database.
 * App code writes no tenant filter; an out-of-scope id simply returns null.
 */

import type { createClient } from "@/lib/supabase/server";
import type { ChangeTarget } from "@/lib/change-management";
import type {
  AutomationLevel,
  ContentItemStatus,
  ContentItemType,
  Json,
  PropertyPlatform,
  SiteChangeAutomationLevel,
  SiteChangeMethod,
  SiteChangeStatus,
  SiteChangeType,
} from "@/lib/types/db";

export type Supabase = Awaited<ReturnType<typeof createClient>>;

/* ------------------------------------------------------------------ */
/* Redacted failure telemetry (house contract — persist.ts pattern)    */
/* ------------------------------------------------------------------ */

const REVIEW_READ_FAILURE_MARKER = "[review-read-failure]";

type ReviewReadStage = "content_detail" | "site_change_detail" | "property_ref";

function logReviewReadFailure(stage: ReviewReadStage, cause: unknown): void {
  console.error(`${REVIEW_READ_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/** Bare SQLSTATE/PostgREST code, or "unknown" — no row data can ride the log line. */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) {
      return code;
    }
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Gate-verdict view — defensive parse of the opaque review jsonb       */
/* ------------------------------------------------------------------ */

/**
 * A single gate verdict as surfaced to a reviewer. Shaped defensively from the
 * opaque `quality_review` / `compliance_review` jsonb (the R3 actions write
 * {@link import("@/lib/types/db").ContentReviewVerdict}); a malformed field
 * becomes null, never a throw. `bodyHash` is what the verdict RECORDED — the
 * detail page compares it to the row's CURRENT body_hash to render a
 * stale-bound verdict honestly ("recorded against an earlier revision").
 */
export interface VerdictView {
  /** The gate's pass/fail decision; null if the stored value wasn't a boolean. */
  passed: boolean | null;
  /** The content_items.body_hash this verdict reviewed; null if absent/malformed. */
  bodyHash: string | null;
  /** ISO stamp the verdict was recorded; null if absent. */
  reviewedAt: string | null;
  /** Reviewer note / send-back reason; null when none was recorded. */
  note: string | null;
}

/** Parse one opaque review jsonb into a {@link VerdictView}, or null when absent/not-an-object. */
export function parseVerdict(raw: unknown): VerdictView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const note = typeof v.note === "string" && v.note.trim() !== "" ? v.note : null;
  return {
    passed: typeof v.passed === "boolean" ? v.passed : null,
    bodyHash: typeof v.body_hash === "string" ? v.body_hash : null,
    reviewedAt: typeof v.reviewed_at === "string" ? v.reviewed_at : null,
    note,
  };
}

/* ------------------------------------------------------------------ */
/* Content review detail                                                */
/* ------------------------------------------------------------------ */

export interface ContentReviewDetail {
  id: string;
  clientId: string;
  type: ContentItemType;
  status: ContentItemStatus;
  automationLevel: AutomationLevel;
  /** null renders "Untitled" — never fabricated from the body. */
  title: string | null;
  body: string;
  /** The row's CURRENT hash (0009 trigger-maintained); verdicts bind to a hash. */
  bodyHash: string;
  /** Raw M9 jsonb — shaped by the page via authenticityVerdictView (absent = not run). */
  humanization: Json;
  quality: VerdictView | null;
  compliance: VerdictView | null;
  /** tenant_users.id of the human approver (0009); null until approved. */
  approvedBy: string | null;
  /** Server-clock approval time; null until approved. */
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const CONTENT_DETAIL_COLUMNS =
  "id, client_id, type, status, automation_level, title, body, body_hash, humanization, quality_review, compliance_review, approved_by, approved_at, created_at, updated_at";

interface RawContentDetail {
  id: string;
  client_id: string;
  type: ContentItemType;
  status: ContentItemStatus;
  automation_level: AutomationLevel;
  title: string | null;
  body: unknown;
  body_hash: unknown;
  humanization: Json;
  quality_review: unknown;
  compliance_review: unknown;
  approved_by: unknown;
  approved_at: unknown;
  created_at: string;
  updated_at: string;
}

/**
 * Read ONE content item for the reviewer detail page. RLS-scoped; a nonexistent
 * OR another-tenant id is the SAME empty observation → `detail: null` (the page
 * maps that to notFound() — no existence oracle). A read error is `ok: false`
 * (the page renders a retryable failure state, never a 500).
 */
export async function readContentReviewDetail(
  supabase: Supabase,
  contentItemId: string
): Promise<{ ok: true; detail: ContentReviewDetail | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("content_items")
    .select(CONTENT_DETAIL_COLUMNS)
    .eq("id", contentItemId)
    .maybeSingle();
  if (error) {
    logReviewReadFailure("content_detail", error);
    return { ok: false };
  }
  if (!data) return { ok: true, detail: null };
  const row = data as unknown as RawContentDetail;
  return {
    ok: true,
    detail: {
      id: row.id,
      clientId: row.client_id,
      type: row.type,
      status: row.status,
      automationLevel: row.automation_level,
      title: typeof row.title === "string" && row.title.trim() !== "" ? row.title : null,
      body: typeof row.body === "string" ? row.body : "",
      bodyHash: typeof row.body_hash === "string" ? row.body_hash : "",
      humanization: row.humanization ?? null,
      quality: parseVerdict(row.quality_review),
      compliance: parseVerdict(row.compliance_review),
      approvedBy: typeof row.approved_by === "string" ? row.approved_by : null,
      approvedAt: typeof row.approved_at === "string" ? row.approved_at : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Site-change detail                                                   */
/* ------------------------------------------------------------------ */

/**
 * The persisted `site_changes.diff` as this surface reads it. Typed from the
 * change-management module's ratified shape ({@link ChangeTarget} + before/after),
 * NOT the stale `SiteChangeDiff` mirror in db.ts (which still declares
 * `{before, after}` only — flagged for a mirror-sync; see the report). `target`
 * is the "which page changed" locator the audit flagged as missing.
 */
export interface SiteChangeDetail {
  id: string;
  clientId: string;
  propertyId: string;
  method: SiteChangeMethod;
  changeType: SiteChangeType;
  automationLevel: SiteChangeAutomationLevel;
  status: SiteChangeStatus;
  before: Json;
  after: Json;
  /** The page/field locator, when the change recorded one; null otherwise. */
  target: ChangeTarget | null;
  revertedReason: string | null;
  appliedAt: string | null;
  revertedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SITE_CHANGE_DETAIL_COLUMNS =
  "id, client_id, property_id, method, change_type, automation_level, status, diff, reverted_reason, applied_at, reverted_at, created_at, updated_at";

interface RawSiteChangeDetail {
  id: string;
  client_id: string;
  property_id: string;
  method: SiteChangeMethod;
  change_type: SiteChangeType;
  automation_level: SiteChangeAutomationLevel;
  status: SiteChangeStatus;
  diff: unknown;
  reverted_reason: string | null;
  applied_at: string | null;
  reverted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Extract the ratified `target` locator from the opaque diff jsonb, defensively. */
function readDiffTarget(diff: Record<string, unknown>): ChangeTarget | null {
  const t = diff.target;
  if (typeof t !== "object" || t === null || Array.isArray(t)) return null;
  const rec = t as Record<string, unknown>;
  if (typeof rec.url !== "string") return null;
  const locator = typeof rec.locator === "string" ? rec.locator : undefined;
  return locator !== undefined ? { url: rec.url, locator } : { url: rec.url };
}

/**
 * Read ONE site change for the change detail page. RLS-scoped; null when the id
 * is nonexistent or out of scope (→ notFound()). The diff jsonb is read
 * defensively: before/after default to null (absent), target to null when the
 * change didn't record a locator.
 */
export async function readSiteChangeDetail(
  supabase: Supabase,
  changeId: string
): Promise<{ ok: true; detail: SiteChangeDetail | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("site_changes")
    .select(SITE_CHANGE_DETAIL_COLUMNS)
    .eq("id", changeId)
    .maybeSingle();
  if (error) {
    logReviewReadFailure("site_change_detail", error);
    return { ok: false };
  }
  if (!data) return { ok: true, detail: null };
  const row = data as unknown as RawSiteChangeDetail;
  const diff =
    typeof row.diff === "object" && row.diff !== null && !Array.isArray(row.diff)
      ? (row.diff as Record<string, unknown>)
      : {};
  return {
    ok: true,
    detail: {
      id: row.id,
      clientId: row.client_id,
      propertyId: row.property_id,
      method: row.method,
      changeType: row.change_type,
      automationLevel: row.automation_level,
      status: row.status,
      before: (diff.before ?? null) as Json,
      after: (diff.after ?? null) as Json,
      target: readDiffTarget(diff),
      revertedReason: row.reverted_reason,
      appliedAt: row.applied_at,
      revertedAt: row.reverted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Property reference (which site the change lands on)                  */
/* ------------------------------------------------------------------ */

export interface PropertyRef {
  id: string;
  url: string;
  platform: PropertyPlatform | null;
  type: string;
}

/**
 * Resolve a property to its url/platform for the change detail's "which site"
 * identification. RLS-scoped; null when out of scope. The change row already
 * carries the property_id (same tenant, composite-FK-anchored), so this only
 * turns that id into a human-readable site — never an existence probe.
 */
export async function readPropertyRef(
  supabase: Supabase,
  propertyId: string
): Promise<{ ok: true; property: PropertyRef | null } | { ok: false }> {
  const { data, error } = await supabase
    .from("properties")
    .select("id, url, platform, type")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) {
    logReviewReadFailure("property_ref", error);
    return { ok: false };
  }
  if (!data) return { ok: true, property: null };
  const row = data as { id: string; url: string; platform: PropertyPlatform | null; type: string };
  return {
    ok: true,
    property: { id: row.id, url: row.url, platform: row.platform, type: row.type },
  };
}
