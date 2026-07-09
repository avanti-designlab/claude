/**
 * M5 — render-visibility verdicts (doc 05 M5).
 *
 * "The technical half of why am I not cited" also covers JS-render
 * invisibility: most AI crawlers do NOT execute client-side JavaScript, so
 * content that only appears after JS runs is invisible to them. The reused M2
 * crawl layer already computes this signal per page — `CrawledPage.rendersWithoutJs`
 * is `true` when the primary content is present in the RAW server HTML, decided
 * by the crawl layer's `RENDER_VISIBLE_MIN_WORDS` heuristic (an SPA shell has
 * scripts and almost no server text → `false`). M5 does NOT invent a second
 * heuristic; it reads that signal and maps it to a status.
 *
 * ── HONESTY ─────────────────────────────────────────────────────────────────
 * A page that FAILED to crawl (robots-blocked, fetch failed, oversized, 5xx…)
 * has render status `unknown` — NEVER `js_dependent`/"invisible". We saw no HTML
 * for it, so we assert nothing. Only a successfully-crawled page yields
 * visible/js_dependent, straight from its `rendersWithoutJs`.
 */

import { RENDER_VISIBLE_MIN_WORDS, type CrawlResult } from "@/lib/intelligence/crawl";
import type { PageRenderVerdict, RenderVisibilityReport } from "./types";

export function evaluateRenderVisibility(crawl: CrawlResult): RenderVisibilityReport {
  // Crawled pages carry the render signal; index by URL for the coverage walk.
  const rendersByUrl = new Map<string, boolean>();
  for (const page of crawl.site.pages) rendersByUrl.set(page.url, page.rendersWithoutJs);

  const pages: PageRenderVerdict[] = [];
  for (const outcome of crawl.coverage.pages) {
    if (outcome.status !== "crawled") {
      // Never seen the HTML → unknown, not invisible (honesty rule 4).
      pages.push({
        url: outcome.url,
        status: "unknown",
        detail: `Not crawled (${outcome.reason ?? "unknown"}) — render visibility could not be assessed.`,
      });
      continue;
    }
    const renders = rendersByUrl.get(outcome.url);
    if (renders === undefined) {
      // A crawled outcome with no matching page is structurally unexpected;
      // report unknown rather than fabricate a verdict from missing data.
      pages.push({
        url: outcome.url,
        status: "unknown",
        detail: "Crawl outcome carried no render signal — render visibility could not be assessed.",
      });
      continue;
    }
    pages.push(
      renders
        ? { url: outcome.url, status: "visible", detail: "Primary content is present in the raw HTML — AI crawlers can read it." }
        : {
            url: outcome.url,
            status: "js_dependent",
            detail:
              `Fewer than ${RENDER_VISIBLE_MIN_WORDS} words of content are present without client-side JS — ` +
              "most AI crawlers (which do not run JS) would see an empty page.",
          },
    );
  }

  const jsDependentUrls = pages
    .filter((page) => page.status === "js_dependent")
    .map((page) => page.url)
    .sort();

  return {
    pages,
    visibleCount: pages.filter((page) => page.status === "visible").length,
    jsDependentCount: jsDependentUrls.length,
    unknownCount: pages.filter((page) => page.status === "unknown").length,
    jsDependentUrls,
  };
}
