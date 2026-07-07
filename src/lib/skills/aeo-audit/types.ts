/**
 * aeo-audit — types.
 *
 * The AEO/SEO scoring rubric as an isolation-tested library (build step 0.2,
 * docs 01 §6, 05 M2, skill spec at .claude/skills/aeo-audit/SKILL.md).
 *
 * IMPORTANT: `CrawledSite` is an INPUT contract. Nothing in this library
 * fetches, crawls, or touches a network/database — the Phase 1 M2 crawler
 * fills this structure; this library only scores it against a playbook.
 */

import type { Playbook } from "@/lib/types/playbook";

/**
 * doc 03 §6 — every task / generative action carries an automation level.
 * Anything that publishes defaults to `ai_draft_human_approve`.
 * (Local copy: no shared type exists in src/lib/types yet; unify when F1 lands.)
 */
export type AutomationLevel = "auto" | "ai_draft_human_approve" | "human_only";

/**
 * Owning module for a fix (doc 00 module map):
 * M5 crawler monitor · M6 freshness · M8 content · M10 schema ·
 * M13 on-page auto-fix · M14 local SEO · M15 reviews.
 */
export type OwningModule = "M5" | "M6" | "M8" | "M10" | "M13" | "M14" | "M15";

/** The 13 rubric checks, in SKILL.md order. */
export type CheckId =
  | "schema_presence_validity"
  | "faq_direct_answer"
  | "video_transcript_schema"
  | "llms_txt"
  | "ai_crawler_access"
  | "internal_linking"
  | "entity_consistency"
  | "gbp_completeness"
  | "nap_consistency"
  | "review_velocity"
  | "core_web_vitals"
  | "freshness"
  | "onpage_basics";

// ---------------------------------------------------------------------------
// Crawled-site input model (filled by the future M2 crawler)
// ---------------------------------------------------------------------------

export interface CrawledImage {
  src: string;
  /** null = no alt attribute; "" = empty alt (decorative — counts as covered). */
  alt: string | null;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface CrawledPage {
  /** Absolute URL of the page. */
  url: string;
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  /** Rendered visible text content of the page. */
  visibleText: string;
  /** Raw contents of each `script[type="application/ld+json"]` block found. */
  jsonLdBlocks: string[];
  images: CrawledImage[];
  /** Internal link hrefs found on the page (absolute or root-relative). */
  internalLinks: string[];
  hasVideo: boolean;
  /** True when an indexable text transcript is present on the page. */
  hasTranscript: boolean;
  /**
   * ISO timestamp of the page's last-modification signal (schema dateModified,
   * sitemap lastmod, or Last-Modified header) — null when no signal exists.
   */
  lastModified: string | null;
  /** True when the primary content is present in server HTML without client-side JS. */
  rendersWithoutJs: boolean;
  /**
   * FAQ question/answer pairs the crawler extracted from the DOM.
   * Optional — when absent, the FAQ check falls back to FAQPage JSON-LD.
   */
  faqItems?: FaqItem[];
}

/** Google Business Profile completeness fields (one per location). */
export interface GbpProfileInput {
  locationName: string;
  primaryCategory: string | null;
  description: string | null;
  phone: string | null;
  address: string | null;
  websiteUrl: string | null;
  hoursComplete: boolean;
  photoCount: number;
  attributesComplete: boolean;
  postsLast30Days: number;
}

/** One NAP listing observed on a directory. */
export interface NapRecord {
  /** Directory name — matched (case-insensitively) against the playbook's nap_directories. */
  directory: string;
  name: string | null;
  address: string | null;
  phone: string | null;
  /** Listing URL, for evidence. */
  url?: string;
}

export interface ReviewSnapshot {
  source: string;
  totalCount: number;
  /** ISO dates of reviews observed in (at least) the 90 days before the crawl. */
  recentReviewDates: string[];
}

export interface CoreWebVitalsSample {
  url: string;
  /** Largest Contentful Paint, ms. */
  lcpMs: number | null;
  /** Interaction to Next Paint, ms. */
  inpMs: number | null;
  /** Cumulative Layout Shift, unitless. */
  cls: number | null;
}

/** The canonical business entity the site should be consistent with. */
export interface CanonicalEntity {
  name: string;
  phone?: string;
  address?: string;
  /** Credentials that should be visible on-site (e.g. RERA/NAR/CIPS, NPN). */
  credentials?: string[];
}

export interface CrawledSite {
  /** Site root, e.g. "https://example.com". */
  baseUrl: string;
  /**
   * ISO timestamp of when the crawl ran. Freshness and review velocity are
   * computed against this — NEVER against wall-clock time — so audits are
   * deterministic and re-runnable.
   */
  crawledAt: string;
  pages: CrawledPage[];
  /** robots.txt body, or null when the site serves none (= everything allowed). */
  robotsTxt: string | null;
  /** llms.txt body, or null when absent. */
  llmsTxt: string | null;
  entity?: CanonicalEntity;
  // Optional local-data inputs — supplied by local-module connectors (M14/M15).
  gbpProfiles?: GbpProfileInput[];
  napRecords?: NapRecord[];
  reviewSnapshots?: ReviewSnapshot[];
  /** Optional field/lab data; absent → check skipped as a data gap, not failed. */
  coreWebVitals?: CoreWebVitalsSample[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AuditOptions {
  /**
   * Refresh window (days) for the freshness check. The playbook schema has no
   * refresh-cadence field yet (escalated — see final report); defaults to 90,
   * per the doc 05 real-estate example ("60–90 days") at its outer bound.
   */
  refreshWindowDays?: number;
}

export interface ResolvedAuditOptions {
  refreshWindowDays: number;
}

export const DEFAULT_REFRESH_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type ImpactLevel = "critical" | "high" | "medium" | "low";

export interface EvidenceItem {
  /** Page URL, listing URL, or synthetic identifier (e.g. "gbp:Main St"). */
  url?: string;
  /** Which field failed (e.g. "title", "phone", "GPTBot"). */
  field?: string;
  expected?: string;
  found?: string;
  /** Why this is a finding — always present. */
  message: string;
}

/** A fix as emitted by a check, before prioritization. */
export interface FixDraft {
  /** Stable, deterministic id — "<checkId>/<slug>". */
  id: string;
  checkId: CheckId;
  /** What to do, actionably phrased. */
  title: string;
  /** Why (evidence summary) + any execution rules the fix must respect. */
  detail: string;
  targetUrls: string[];
  impact: ImpactLevel;
  /** Human-readable impact estimate for the plan/roadmap. */
  impactEstimate: string;
  module: OwningModule;
  automationLevel: AutomationLevel;
}

/** A prioritized fix (FixDraft + computed priority). */
export interface AuditFix extends FixDraft {
  /**
   * Deterministic priority: effective check weight × impact factor ×
   * channel boost × severity. Higher = do first.
   */
  priorityScore: number;
}

export type SkipReason =
  /** Playbook is national or local module disabled — local checks are OFF, not failed. */
  | "local_module_off"
  /** local_module_config.gbp_priority === "off" while local module is otherwise on. */
  | "gbp_priority_off"
  /** Optional input not supplied — recorded as a data gap, excluded from the score. */
  | "no_data"
  /** Check has no subject matter on this site (e.g. no video pages, no FAQ content). */
  | "not_applicable";

export interface CheckOutcome {
  status: "scored" | "skipped";
  skipReason?: SkipReason;
  /** 0–100 when scored, null when skipped. */
  score: number | null;
  evidence: EvidenceItem[];
  fixes: FixDraft[];
}

export interface CheckResult extends Omit<CheckOutcome, "fixes"> {
  checkId: CheckId;
  name: string;
  /** Effective weight used in the overall roll-up (0 when skipped/excluded). */
  weight: number;
  fixes: AuditFix[];
}

export interface AuditResult {
  /** Weighted 0–100 over applicable, scored checks. */
  overallScore: number;
  /** All 13 checks, in canonical SKILL.md order. */
  checks: CheckResult[];
  /** All fixes, deterministically prioritized (highest priority first). */
  fixes: AuditFix[];
  /** Human-readable notes for checks skipped for missing optional inputs. */
  dataGaps: string[];
  playbookVertical: string;
  /** True when local checks (8–10) were in scope for this playbook. */
  localChecksApplied: boolean;
  crawledAt: string;
}

/** Everything a check needs. Checks are pure functions of this context. */
export interface CheckContext {
  site: CrawledSite;
  playbook: Playbook;
  options: ResolvedAuditOptions;
}

export type CheckFn = (ctx: CheckContext) => CheckOutcome;
