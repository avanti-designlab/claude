/**
 * M5 — AI crawler + render-visibility monitoring: public API (doc 05 M5, doc 07 §1.4).
 *
 * Detect the technical half of "why am I not cited": robots.txt blocks of the
 * major AI crawlers, and JS-render invisibility. Built ON TOP of the reused M2
 * crawl layer (`crawlSite` + the SSRF egress guard) — M5 forks neither. Output
 * feeds M17 alerting (`crawler_blocked`) and the M19 dashboard.
 *
 * Server actions (`runPropertyMonitor`, `getCrawlerRenderStatus`) live in
 * ./actions — imported directly by the app layer, deliberately not re-exported
 * here so the pure engine surface stays importable from client-adjacent code
 * without dragging in "use server" modules (mirrors the audit barrel).
 */

export { AI_CRAWLERS, type AiCrawler, type CrawlerRole } from "./crawlers";
export { monitorProperty, type MonitorPropertyInput } from "./monitor";
export { analyzeMonitor } from "./analyze";
export { evaluateCrawlerAccess } from "./robots-access";
export { evaluateRenderVisibility } from "./render-visibility";
export {
  monitorAlertRows,
  crawlerRenderStatusEntry,
  type AlertInsertRow,
  type AlertSeverity,
  type BlockedCrawlerRef,
  type CrawlerRenderStatusEntry,
  type MonitorAlertKind,
  type MonitorAlertPayload,
} from "./rows";
export type {
  CrawlerAccess,
  CrawlerAccessSource,
  CrawlerAccessVerdict,
  PageRenderVerdict,
  PropertyMonitorReport,
  RenderStatus,
  RenderVisibilityReport,
} from "./types";
