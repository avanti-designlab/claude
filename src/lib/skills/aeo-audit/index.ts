/**
 * aeo-audit — public API (build step 0.2; wrapped by .claude/skills/aeo-audit).
 *
 * The AEO/SEO scoring rubric as an isolation-tested, pure TypeScript library:
 * crawled site data + loaded playbook in → scored checks with evidence +
 * deterministically prioritized fix list out. No network, no clock, no DB.
 *
 * Consumers: M2 Audit Engine, M4 competitor gap analysis (run per-check
 * functions on a competitor crawl), content-quality (evaluateFaqAnswer).
 */

export { runAudit } from "./audit";

export type {
  AuditFix,
  AuditOptions,
  AuditResult,
  AutomationLevel,
  CanonicalEntity,
  CheckContext,
  CheckFn,
  CheckId,
  CheckOutcome,
  CheckResult,
  CoreWebVitalsSample,
  CrawledImage,
  CrawledPage,
  CrawledSite,
  EvidenceItem,
  FaqItem,
  FixDraft,
  GbpProfileInput,
  ImpactLevel,
  NapRecord,
  OwningModule,
  ResolvedAuditOptions,
  ReviewSnapshot,
  SkipReason,
} from "./types";
export { DEFAULT_REFRESH_WINDOW_DAYS } from "./types";

export {
  BASE_CHECK_WEIGHTS,
  CHECK_CANONICAL_ORDER,
  CHECK_NAMES,
  LOCAL_CHECK_IDS,
  channelBoost,
  effectiveCheckWeight,
  isLocalCheck,
  localChecksApplicable,
} from "./weights";

export { AI_CRAWLER_BOTS, isBotAllowed, parseRobotsTxt } from "./robots";
export type { AiCrawlerBot, RobotsGroup, RobotsRule } from "./robots";

// Individual checks — exported for M4 competitor analysis and content-quality.
export { checkSchemaPresence } from "./checks/schema-presence";
export { checkFaqDirectAnswer, evaluateFaqAnswer, faqItemsForPage } from "./checks/faq-direct-answer";
export type { FaqVerdict } from "./checks/faq-direct-answer";
export { checkVideoTranscript } from "./checks/video-transcript";
export { checkLlmsTxt } from "./checks/llms-txt";
export { checkAiCrawlerAccess } from "./checks/ai-crawler-access";
export { checkInternalLinking } from "./checks/internal-linking";
export { checkEntityConsistency } from "./checks/entity-consistency";
export { checkGbpCompleteness } from "./checks/gbp-completeness";
export { checkNapConsistency } from "./checks/nap-consistency";
export { checkReviewVelocity } from "./checks/review-velocity";
export { checkCoreWebVitals } from "./checks/core-web-vitals";
export { checkFreshness } from "./checks/freshness";
export { checkOnpageBasics } from "./checks/onpage-basics";
