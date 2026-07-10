/**
 * Shared DB-mirroring types for the F1 multi-tenant data model
 * (doc 03; contracts: docs/contracts/data-model.md; migrations:
 * supabase/migrations/).
 *
 * This file is the single shared home for enum/value sets that the database
 * CHECK-constrains and every module reads. Ratified at F1 (BUILD-STATE item
 * 3): aeo-audit's local `AutomationLevel` copy
 * (src/lib/skills/aeo-audit/types.ts) is unified onto this type by its owner
 * (aeo-seo-logic-engineer) post-freeze.
 *
 * Conventions:
 * - Timestamps are ISO-8601 strings as returned by supabase-js/PostgREST.
 * - Each `X_…S` const array mirrors the corresponding CHECK constraint
 *   verbatim; runtime validators should reuse these instead of re-listing.
 */

import type { TenantTheme } from "@/lib/skills/brand-kit/serialize";
import type {
  DesignTokenSet,
  LikenessRefs,
  VoiceProfile,
} from "@/lib/types/brand";
import type { Vertical } from "@/lib/types/playbook";

/**
 * Canonical `tenants.theme` jsonb shape (F1-ratified, BUILD-STATE items 1–2):
 * snake_case color keys, `font` = {display, body, mono}. The producing
 * library (brand-kit skill, `toTenantTheme`) owns the declaration; re-exported
 * here so modules import the DB shape from the data layer.
 */
export type { TenantTheme };

/** Postgres jsonb value. */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json }
  | Json[];

/* ------------------------------------------------------------------ */
/* Roles + JWT claim contract (doc 03 §2, §4)                          */
/* ------------------------------------------------------------------ */

/** Roles a JWT may carry. `platform_owner` never appears in tenant_users. */
export const JWT_ROLES = [
  "platform_owner",
  "agency_admin",
  "operator",
  "client_viewer",
] as const;
export type JwtRole = (typeof JWT_ROLES)[number];

/** Roles storable in `tenant_users.role` (tenant membership). */
export const TENANT_USER_ROLES = [
  "agency_admin",
  "operator",
  "client_viewer",
] as const;
export type TenantUserRole = (typeof TENANT_USER_ROLES)[number];

/**
 * The claims RLS keys off (read via `auth.jwt()`; minted server-side by the
 * Custom Access Token hook, migration 0007). A missing/empty `tenant_id` yields
 * zero rows everywhere — fail closed.
 *
 * IMPORTANT — two distinct role claims:
 *  - `user_role` carries the APP role (doc 03 §2). RLS reads it via
 *    `app.user_role()` (migration 0008). This is the tenant-authorization role.
 *  - `role` is PostgREST's RESERVED DB-role claim — GoTrue sets it to
 *    `authenticated` and PostgREST does `SET ROLE <role>` off it. It is NEVER
 *    the app role; the hook leaves it untouched. Do not read authorization from
 *    it.
 */
export interface JwtClaims {
  tenant_id: string;
  /** APP role — the tenant-authorization role RLS reads (`app.user_role()`). */
  user_role: JwtRole;
  /**
   * PostgREST's reserved DB-role claim (`authenticated` for signed-in tenant
   * users). Present in every real token; not the app role. Optional here
   * because degenerate/forged test claims may omit it.
   */
  role?: string;
  /** Present iff user_role === "client_viewer". */
  client_id?: string;
  /** Supabase auth user id (auth.users.id). */
  sub?: string;
  /** Supabase adds standard claims (iss, aud, exp, ...). */
  [claim: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* automation_level (doc 03 §6)                                        */
/* ------------------------------------------------------------------ */

/**
 * The human/AI orchestration flag on every task and generative action:
 * - `auto`: no human needed (schema validation, rank tracking, reporting).
 * - `ai_draft_human_approve`: DEFAULT for anything that publishes.
 * - `human_only`: genuine participation, compliance sign-off, strategy.
 */
export const AUTOMATION_LEVELS = [
  "auto",
  "ai_draft_human_approve",
  "human_only",
] as const;
export type AutomationLevel = (typeof AUTOMATION_LEVELS)[number];

/**
 * site_changes only: 'auto' is structurally impossible there — a fully
 * autonomous on-page publish cannot be represented (doc 00 §2, CLAUDE.md
 * rule 5; CHECK site_changes_automation_level_allowed, contract §6).
 */
export const SITE_CHANGE_AUTOMATION_LEVELS = [
  "ai_draft_human_approve",
  "human_only",
] as const;
export type SiteChangeAutomationLevel =
  (typeof SITE_CHANGE_AUTOMATION_LEVELS)[number];

/* ------------------------------------------------------------------ */
/* Status/value sets (mirror the migrations' CHECK constraints)        */
/* ------------------------------------------------------------------ */

export const CLIENT_STATUSES = [
  "onboarding",
  "active",
  "paused",
  "archived",
] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const TASK_STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "approved",
  "published",
  "reverted",
  // 'done' (migration 0013): an honest, human-owned completion word. Legal ONLY
  // on automation_level='human_only' (structural CHECK tasks_done_is_human_only)
  // — never a bypass of the approved/published pipeline terminals.
  "done",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const CONTENT_ITEM_TYPES = [
  "blog",
  "faq",
  "caption",
  "pillar",
  "schema_copy",
] as const;
export type ContentItemType = (typeof CONTENT_ITEM_TYPES)[number];

export const CONTENT_ITEM_STATUSES = [
  "draft",
  "in_review",
  // Send-back target (migration 0009): a reviewer returned the draft to the
  // producer. Re-review is required to re-approve; the body_hash binding makes
  // any prior verdicts structurally stale on the next edit.
  "needs_revision",
  "approved",
  "published",
] as const;
export type ContentItemStatus = (typeof CONTENT_ITEM_STATUSES)[number];

export const SITE_CHANGE_METHODS = [
  "wordpress",
  "webflow",
  "wix",
  "edge_worker",
  "pr",
] as const;
export type SiteChangeMethod = (typeof SITE_CHANGE_METHODS)[number];

export const SITE_CHANGE_TYPES = [
  "h1",
  "title",
  "meta",
  "schema",
  "alt",
  "content",
  "canonical",
] as const;
export type SiteChangeType = (typeof SITE_CHANGE_TYPES)[number];

export const SITE_CHANGE_STATUSES = [
  "previewed",
  "applied",
  "reverted",
  "auto_reverted",
] as const;
export type SiteChangeStatus = (typeof SITE_CHANGE_STATUSES)[number];

export const VISIBILITY_ENGINES = [
  "chatgpt",
  "perplexity",
  "gemini",
  "claude",
  "copilot",
  "google_aio",
] as const;
export type VisibilityEngine = (typeof VISIBILITY_ENGINES)[number];

export const METRIC_SOURCES = [
  "gsc",
  "ga4",
  "call_tracking",
  "local_rank",
  "reviews",
] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

/** doc 03 §3's six types + doc 07 §1.8's auto-rollback fired (superset). */
export const ALERT_TYPES = [
  "visibility_drop",
  "competitor_overtook",
  "schema_broke",
  "crawler_blocked",
  "negative_review_spike",
  "site_down",
  "auto_rollback_fired",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * How a property is connected for the auto-fix write methods (doc 04):
 * 'api' (WordPress/Webflow/Wix APIs) | 'edge_worker' (Cloudflare worker) |
 * 'pr' (the GIT/PULL-REQUEST write method — NOT press-release/M12) | 'none'.
 * Only 'none' is writable until the Connections block wires real connections
 * (Orchestrator ruling 2026-07-10 — no exceptions).
 */
export const PROPERTY_CONNECTION_METHODS = [
  "api",
  "edge_worker",
  "pr",
  "none",
] as const;
export type PropertyConnectionMethod =
  (typeof PROPERTY_CONNECTION_METHODS)[number];

export const PROPERTY_PLATFORMS = [
  "wordpress",
  "webflow",
  "wix",
  "framer",
  "nextjs",
  "custom",
] as const;
export type PropertyPlatform = (typeof PROPERTY_PLATFORMS)[number];

/** Narrow an unknown to a valid property platform (mirrors the 0003 CHECK). */
export function isPropertyPlatform(value: unknown): value is PropertyPlatform {
  return (
    typeof value === "string" &&
    (PROPERTY_PLATFORMS as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------ */
/* runs — the scan work-order queue (migration 0011)                   */
/* ------------------------------------------------------------------ */

/** Run kinds — one per intelligence scan module (migration 0011 CHECK). */
export const RUN_KINDS = [
  "audit", // M2 audit engine
  "monitor", // M5 crawler/render monitoring
  "decay", // M6 content decay/freshness
  "local", // M14 local assessment
  "entity", // M12 PR entity leverage
  "visibility", // M3 visibility tracker
] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** Run lifecycle states (migration 0011 CHECK). Transition legality lives in
 *  src/lib/runs/transitions.ts (enforced by the future queue actions). */
export const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Terminal states — immutable once reached (queue-infra invariant). */
export const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "canceled",
] as const;

/**
 * CLOSED error-code enum (migration 0011 CHECK). NEVER raw error text or URLs
 * (honesty rule) — a small honest set the failure paths map onto. Set only on a
 * failed run.
 */
export const RUN_ERROR_CODES = [
  "crawl_refused", // egress guard / robots / DNS refused the target
  "budget_exhausted_total", // the crawler's honest total-budget truncation
  "engine_error", // the intelligence engine itself errored
  "orphaned", // sweeper marked a stale-heartbeat run failed
  "misconfigured", // enqueued against missing/invalid config (missing property, etc.)
] as const;
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number];

/* ------------------------------------------------------------------ */
/* brand_assets — the per-client asset library (migration 0014)        */
/* ------------------------------------------------------------------ */

/** Closed asset taxonomy — mirrors `brand_assets_type_allowed` (0014). */
export const BRAND_ASSET_TYPES = [
  "primary_logo",
  "secondary_logo",
  "mono_logo",
  "reversed_logo",
  "favicon",
  "icon",
  "imagery",
  "other",
] as const;
export type BrandAssetType = (typeof BRAND_ASSET_TYPES)[number];

/**
 * MIME allowlist — raster images + SVG (ruling condition 5). Mirrors
 * `brand_assets_content_type_allowed` (0014) AND the storage bucket's
 * allowed_mime_types (supabase/storage/brand-assets-bucket.sql).
 */
export const BRAND_ASSET_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
] as const;
export type BrandAssetMime = (typeof BRAND_ASSET_MIME_TYPES)[number];

/* ------------------------------------------------------------------ */
/* jsonb sub-shapes                                                    */
/* ------------------------------------------------------------------ */

/** `clients.locations` entry: [{name, address, geo}] (doc 03 §3). */
export interface ClientLocation {
  name: string;
  address: string;
  /** Geo shape is doc-silent; refined by the local module (M14) at 1.6. */
  geo?: Json;
}

/** `content_items.humanization` (doc 03 §3 / doc 05 authenticity gate). */
export interface HumanizationResult {
  humanized: boolean;
  detection_score: number;
  passes: boolean;
}

/**
 * Review-agent verdicts (`content_items.quality_review` /
 * `compliance_review`). Shape is owned by the content-quality and
 * compliance-review agents; the data layer stores it opaquely.
 */
export type ReviewVerdict = { [key: string]: Json };

/** `site_changes.diff`: before/after (doc 03 §3). */
export interface SiteChangeDiff {
  before: Json;
  after: Json;
}

/**
 * `brand_kits.assets`: client brand assets ingested by M7 (doc 05 — logo,
 * ...). `logo_url` feeds schema-generation's `SchemaBrandContext.logoUrl`
 * (F1 ratification item 4).
 */
export interface BrandAssets {
  logo_url?: string;
  [key: string]: Json | undefined;
}

/* ------------------------------------------------------------------ */
/* Row types (one per table; column semantics in the contracts doc)    */
/* ------------------------------------------------------------------ */

export interface TenantRow {
  id: string;
  name: string;
  theme: TenantTheme | null;
  plan_tier: string | null;
  created_at: string;
  updated_at: string;
}

export interface TenantUserRow {
  id: string;
  tenant_id: string;
  /** Supabase auth.users.id. */
  auth_user_id: string;
  role: TenantUserRole;
  /** Non-null iff role === "client_viewer". */
  client_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  vertical: Vertical;
  locations: ClientLocation[];
  status: ClientStatus;
  created_at: string;
  updated_at: string;
}

export interface PropertyRow {
  id: string;
  tenant_id: string;
  client_id: string;
  /** website | gbp | instagram | linkedin | ... (open set). */
  type: string;
  /** Required when type === "website"; null for gbp/social assets. */
  platform: PropertyPlatform | null;
  url: string;
  /** Secrets-vault reference ONLY — never a raw credential (doc 03 §5). */
  auth_ref: string | null;
  connection_method: PropertyConnectionMethod;
  created_at: string;
  updated_at: string;
}

export interface BrandKitRow {
  id: string;
  tenant_id: string;
  client_id: string;
  tokens: DesignTokenSet;
  voice_profile: VoiceProfile;
  likeness_refs: LikenessRefs;
  assets: BrandAssets | null;
  locked: boolean;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface PlanRow {
  id: string;
  tenant_id: string;
  client_id: string;
  playbook_version: string;
  generated_roadmap: Json;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  tenant_id: string;
  client_id: string;
  plan_id: string;
  /** audit | content | schema | local | ... (open set). */
  module: string;
  automation_level: AutomationLevel;
  status: TaskStatus;
  /** tenant_users.id of the assignee (same tenant, enforced). */
  assigned_to: string | null;
  payload: Json;
  created_at: string;
  updated_at: string;
}

export interface AuditRow {
  id: string;
  tenant_id: string;
  client_id: string;
  property_id: string;
  score: Json;
  fixes: Json;
  created_at: string;
}

export interface ContentItemRow {
  id: string;
  tenant_id: string;
  client_id: string;
  type: ContentItemType;
  brand_kit_id: string;
  automation_level: AutomationLevel;
  /** Optional client-facing headline (≤200). NULL renders as "Untitled". */
  title: string | null;
  body: string;
  /**
   * SHA-256 over {title, body}, maintained by the content_items_set_body_hash
   * trigger (migration 0009) — never caller-set. Each review verdict records
   * the hash it reviewed; approval requires the recorded hashes to equal this.
   */
  body_hash: string;
  humanization: HumanizationResult | null;
  quality_review: ReviewVerdict | null;
  compliance_review: ReviewVerdict | null;
  status: ContentItemStatus;
  /** tenant_users.id of the human approver; required for approved/published. */
  approved_by: string | null;
  /** Server-clock approval time (set by the approve action, never a caller). */
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A review-gate verdict (`content_items.quality_review` / `compliance_review`)
 * as the R3 lifecycle actions record it. `passed` is the gate's decision (the
 * approval CHECK requires TRUE) and `body_hash` binds the verdict to the exact
 * content version reviewed. The DB stores the jsonb opaquely (`ReviewVerdict`);
 * this is the shape the review module reads/writes.
 */
export interface ContentReviewVerdict {
  passed: boolean;
  /** The content_items.body_hash this verdict reviewed (version binding). */
  body_hash: string;
  /** Reviewer's tenant_users.id (audit; not caller-supplied). */
  reviewed_by?: string;
  /** ISO-8601 stamp set server-side. */
  reviewed_at?: string;
  /** Free-text note / send-back reason (redaction-safe; reviewer-authored). */
  note?: string;
  [key: string]: Json | undefined;
}

export interface CompetitorRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  /** Optional bare hostname ("example.com"); NULL when only a name is known. */
  domain: string | null;
  created_at: string;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  client_id: string;
  /** Set for property-scoped kinds (audit/monitor/decay/local); NULL otherwise. */
  property_id: string | null;
  kind: RunKind;
  status: RunStatus;
  attempts: number;
  /** Bounded, content-free progress frontier (never crawled URLs/content). */
  progress: Json;
  heartbeat_at: string | null;
  /** tenant_users.id of the enqueuer; NULL for system/sweeper re-queues. */
  requested_by: string | null;
  /** Content-free pointer to the produced artifact; NULL until succeeded. */
  result_ref: Json | null;
  /** Closed enum; set only on a failed run. */
  error_code: RunErrorCode | null;
  created_at: string;
  updated_at: string;
}

export interface SiteChangeRow {
  id: string;
  tenant_id: string;
  client_id: string;
  property_id: string;
  method: SiteChangeMethod;
  change_type: SiteChangeType;
  automation_level: SiteChangeAutomationLevel;
  diff: SiteChangeDiff;
  /** tenant_users.id (same tenant, enforced; audit trail — never reused). */
  applied_by: string | null;
  /** tenant_users.id; required for ANY status past 'previewed' — no
   * exemptions (CHECK site_changes_requires_approval). */
  approved_by: string | null;
  status: SiteChangeStatus;
  reverted_reason: string | null;
  applied_at: string | null;
  reverted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VisibilityResultRow {
  id: string;
  tenant_id: string;
  client_id: string;
  engine: VisibilityEngine;
  prompt: string;
  cited: boolean;
  position: number | null;
  sentiment: string | null;
  cited_source: string | null;
  captured_at: string;
}

export interface MetricRow {
  id: string;
  tenant_id: string;
  client_id: string;
  source: MetricSource;
  data: Json;
  captured_at: string;
}

export interface AlertRow {
  id: string;
  tenant_id: string;
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  payload: Json;
  acknowledged: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * `brand_assets` (migration 0014) — the per-client brand asset library. Assets
 * attach to the CLIENT (mutable library); a locked brand_kit version may
 * reference asset ids/paths as an immutable snapshot via `brand_kits.assets`.
 * `storage_path` is the ONLY pointer to the bytes (the auth_ref-analog, doc 03
 * §5) — raw bytes live in the PRIVATE brand-assets Storage bucket, never a
 * table. `archived_at` is the soft-delete marker set by the remove action when
 * a locked kit still references the asset (never dangle an immutable snapshot).
 */
export interface BrandAssetRow {
  id: string;
  tenant_id: string;
  client_id: string;
  type: BrandAssetType;
  label: string | null;
  /** Presentation hints only (never credentials/URLs/bytes); bounded jsonb. */
  variants: Json;
  /** "<tenant_id>/<client_id>/<uuid>[.ext]" in the private brand-assets bucket. */
  storage_path: string;
  content_type: BrandAssetMime;
  size_bytes: number;
  /** Non-null once soft-deleted (row kept + object kept for locked-kit refs). */
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}
