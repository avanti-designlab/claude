/**
 * M2 crawl layer — public API (doc 05 M2, doc 07 §1.4).
 *
 * Bounded, robots-respecting, same-origin-only property crawler over the
 * shared injected FetchPort. Output (`CrawlResult`) is the aeo-audit skill's
 * input (`CrawledSite`) plus the per-page crawl-honesty record. Consumers:
 * M2 Audit Engine (src/lib/intelligence/audit); M4/M5 reuse this crawler for
 * competitor crawls and render monitoring rather than forking it.
 */

export { crawlSite, RENDER_VISIBLE_MIN_WORDS, type CrawlInput } from "./crawler";
export {
  checkEgressHost,
  hostIsBlockedLiteral,
  isBlockedAddress,
  type ResolvedAddress,
  type ResolvePort,
} from "./egress-guard";
export {
  extractDoc,
  MAX_ATTR_CHARS,
  MAX_H1S,
  MAX_HREFS,
  MAX_IMAGES,
  MAX_JSONLD_BLOCK_CHARS,
  MAX_JSONLD_BLOCKS,
  MAX_TITLE_CHARS,
  MAX_VISIBLE_TEXT_CHARS,
  type ExtractedDoc,
  type ExtractedImage,
} from "./extract";
export {
  AUDIT_CRAWLER_BOT,
  AUDIT_CRAWLER_USER_AGENT,
  DEFAULT_CRAWL_BOUNDS,
  REQUEST_TIMEOUT_MS,
  type CrawlBounds,
  type CrawlCoverage,
  type CrawlResult,
  type PageFailureReason,
  type PageOutcome,
} from "./types";
