import { describe, expect, it } from "vitest";
import { evaluateRenderVisibility } from "./render-visibility";
import { makeCrawlResult, FIX_BASE_URL } from "./fixtures";

const A = `${FIX_BASE_URL}/a`;
const B = `${FIX_BASE_URL}/b`;
const C = `${FIX_BASE_URL}/c`;

describe("evaluateRenderVisibility", () => {
  it("a page whose content is in raw HTML is `visible`", () => {
    const report = evaluateRenderVisibility(makeCrawlResult({ pages: [[A, true]] }));
    expect(report.pages).toHaveLength(1);
    expect(report.pages[0]).toMatchObject({ url: A, status: "visible" });
    expect(report.visibleCount).toBe(1);
    expect(report.jsDependentCount).toBe(0);
    expect(report.jsDependentUrls).toEqual([]);
  });

  it("a JS-dependent page is `js_dependent` and lands in the risk set", () => {
    const report = evaluateRenderVisibility(makeCrawlResult({ pages: [[A, false]] }));
    expect(report.pages[0]).toMatchObject({ url: A, status: "js_dependent" });
    expect(report.jsDependentCount).toBe(1);
    expect(report.jsDependentUrls).toEqual([A]);
    expect(report.pages[0].detail).toContain("without client-side JS");
  });

  it("HONESTY: a page that FAILED to crawl is `unknown`, never `js_dependent`/invisible", () => {
    const report = evaluateRenderVisibility(
      makeCrawlResult({ pages: [[A, true]], failed: [[B, "robots_disallowed"], [C, "fetch_failed"]] })
    );
    const byUrl = Object.fromEntries(report.pages.map((p) => [p.url, p.status]));
    expect(byUrl[A]).toBe("visible");
    expect(byUrl[B]).toBe("unknown");
    expect(byUrl[C]).toBe("unknown");
    expect(report.unknownCount).toBe(2);
    // A failed page is NEVER counted as a render risk.
    expect(report.jsDependentUrls).toEqual([]);
    expect(report.jsDependentCount).toBe(0);
    // The unknown detail names the reason honestly.
    const bVerdict = report.pages.find((p) => p.url === B);
    expect(bVerdict?.detail).toContain("robots_disallowed");
  });

  it("counts and the sorted risk set are correct across a mixed site", () => {
    const report = evaluateRenderVisibility(
      makeCrawlResult({ pages: [[C, false], [A, true], [B, false]] })
    );
    expect(report.visibleCount).toBe(1);
    expect(report.jsDependentCount).toBe(2);
    expect(report.unknownCount).toBe(0);
    // jsDependentUrls is sorted regardless of crawl order.
    expect(report.jsDependentUrls).toEqual([B, C]);
  });

  it("a zero-page crawl yields an empty, all-zero report (no fabricated verdicts)", () => {
    const report = evaluateRenderVisibility(makeCrawlResult({ robotsTxtStatus: "unreachable" }));
    expect(report.pages).toEqual([]);
    expect(report.visibleCount).toBe(0);
    expect(report.jsDependentCount).toBe(0);
    expect(report.unknownCount).toBe(0);
  });
});
