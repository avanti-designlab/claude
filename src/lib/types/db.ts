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
 * The claims RLS keys off (read via `auth.jwt()`; set at auth time).
 * A missing/empty `tenant_id` yields zero rows everywhere — fail closed.
 */
export interface JwtClaims {
  tenant_id: string;
  role: JwtRole;
  /** Present iff role === "client_viewer". */
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
  body: string;
  humanization: HumanizationResult | null;
  quality_review: ReviewVerdict | null;
  compliance_review: ReviewVerdict | null;
  status: ContentItemStatus;
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
