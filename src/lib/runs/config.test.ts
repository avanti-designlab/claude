import { describe, expect, it } from "vitest";
import { REQUEST_TIMEOUT_MS } from "@/lib/intelligence/crawl/types";
import {
  BRAND_EXTRACT_AGGREGATE_BUDGET_MS,
  BRAND_EXTRACT_INPUT_URL_MAX_CHARS,
  BRAND_EXTRACT_MAX_FETCH_BYTES,
  BRAND_EXTRACT_MAX_STYLESHEETS,
  HEARTBEAT_INTERVAL_MS,
  isHeartbeatStale,
  ORPHAN_STALE_MS,
  orphanCutoffIso,
  retryBackoffMs,
  RETRY_ATTEMPT_CAP,
  RETRY_BASE_BACKOFF_MS,
  RETRY_MAX_BACKOFF_MS,
  SCAN_CRAWL_BUDGET_MS,
  SCAN_MAX_DURATION_SECONDS,
  SCAN_OVERHEAD_SECONDS,
} from "./config";

describe("A3 budget invariant (the pinned single-source-of-truth guarantee)", () => {
  it("crawl budget <= (maxDuration - overhead) — truncation is the crawler's, never a platform kill", () => {
    expect(SCAN_CRAWL_BUDGET_MS).toBeLessThanOrEqual(
      (SCAN_MAX_DURATION_SECONDS - SCAN_OVERHEAD_SECONDS) * 1000
    );
  });

  it("all three knobs are positive and leave real headroom", () => {
    expect(SCAN_OVERHEAD_SECONDS).toBeGreaterThan(0);
    expect(SCAN_CRAWL_BUDGET_MS).toBeGreaterThan(0);
    expect(SCAN_MAX_DURATION_SECONDS).toBeGreaterThan(SCAN_OVERHEAD_SECONDS);
  });

  it("a healthy run heartbeats well inside the orphan threshold", () => {
    // Heartbeat cadence must be comfortably under maxDuration so a live run
    // always beats before it could be mistaken for an orphan.
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(15_000); // A6: ≤~15s
    expect(HEARTBEAT_INTERVAL_MS * 2).toBeLessThan(ORPHAN_STALE_MS);
    // Orphan threshold is strictly greater than the whole run window (A6).
    expect(ORPHAN_STALE_MS).toBeGreaterThan(SCAN_MAX_DURATION_SECONDS * 1000);
  });
});

describe("isHeartbeatStale (orphan-detection math, mirrors reap_orphaned_runs)", () => {
  const now = 1_000_000_000;
  it("null heartbeat is stale by definition", () => {
    expect(isHeartbeatStale(null, now)).toBe(true);
  });
  it("a beat exactly AT the cutoff is SPARED (QA F4 — mirrors 0012 reap's strict <)", () => {
    expect(isHeartbeatStale(now - ORPHAN_STALE_MS, now)).toBe(false);
  });
  it("a beat 1ms past the cutoff is stale", () => {
    expect(isHeartbeatStale(now - ORPHAN_STALE_MS - 1, now)).toBe(true);
  });
  it("a fresh beat is alive", () => {
    expect(isHeartbeatStale(now - 1_000, now)).toBe(false);
  });
});

describe("retryBackoffMs (capped backoff, mirrors requeue_failed_runs)", () => {
  it("grows with attempts", () => {
    expect(retryBackoffMs(0)).toBe(RETRY_BASE_BACKOFF_MS * 1);
    expect(retryBackoffMs(1)).toBe(RETRY_BASE_BACKOFF_MS * 2);
    expect(retryBackoffMs(2)).toBe(RETRY_BASE_BACKOFF_MS * 3);
  });
  it("is capped at the max", () => {
    expect(retryBackoffMs(1_000)).toBe(RETRY_MAX_BACKOFF_MS);
    expect(retryBackoffMs(1_000)).toBeLessThanOrEqual(RETRY_MAX_BACKOFF_MS);
  });
});

describe("orphanCutoffIso", () => {
  it("is now - ORPHAN_STALE_MS as an ISO string", () => {
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    expect(orphanCutoffIso(now)).toBe(new Date(now - ORPHAN_STALE_MS).toISOString());
  });
});

describe("attempt cap", () => {
  it("is the ratified provisional cap of 3", () => {
    expect(RETRY_ATTEMPT_CAP).toBe(3);
  });
});

describe("brand_extract shallow-fetch bounds (interactive, inside the route window)", () => {
  it("the aggregate budget is TIGHTER than the audit crawl budget (interactive expectation)", () => {
    expect(BRAND_EXTRACT_AGGREGATE_BUDGET_MS).toBeGreaterThan(0);
    expect(BRAND_EXTRACT_AGGREGATE_BUDGET_MS).toBeLessThan(SCAN_CRAWL_BUDGET_MS);
  });

  it("even a final in-flight fetch admitted just before the deadline finishes inside the crawl window", () => {
    // A fetch is admitted while now() < deadline, then may run up to one per-request
    // timeout. budget + REQUEST_TIMEOUT_MS must stay within the route's honest crawl
    // window, so brand_extract never overruns into a mid-write platform kill.
    expect(BRAND_EXTRACT_AGGREGATE_BUDGET_MS + REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(
      SCAN_CRAWL_BUDGET_MS
    );
  });

  it("the work + size caps are positive and sane", () => {
    expect(BRAND_EXTRACT_MAX_STYLESHEETS).toBe(10);
    expect(BRAND_EXTRACT_MAX_FETCH_BYTES).toBe(2 * 1024 * 1024);
    // The enqueue shape cap matches the runs.input_url CHECK bound (0015).
    expect(BRAND_EXTRACT_INPUT_URL_MAX_CHARS).toBe(2048);
  });
});
