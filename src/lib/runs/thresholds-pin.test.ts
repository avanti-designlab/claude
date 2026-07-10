/**
 * QA pin — the RECORDED A6/A3 threshold values (ARCHITECTURE RULING 2026-07-10,
 * amendment A6 ⚑ provisional, ratified at wiring review; A8 QA gate).
 *
 * config.test.ts proves the RELATIONSHIPS (budget ≤ window, heartbeat ≪ orphan
 * threshold). THIS file pins the ratified NUMBERS themselves, so a silent edit
 * to any provisional threshold fails a test and forces the ⚑ ratification
 * conversation instead of drifting through:
 *   - orphan threshold  = maxDuration + 60s  (A6, exactly — both the formula
 *     and today's value at the 60s Hobby-safe maxDuration)
 *   - heartbeat cadence ≤ ~15s (A6; implemented 12s)
 *   - attempt cap 3, capped backoff 30s base / 5m max (A6)
 *   - per-run JWT TTL covers the whole run window (mint.ts security parameter)
 */

import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_INTERVAL_MS,
  ORPHAN_STALE_MS,
  RETRY_ATTEMPT_CAP,
  RETRY_BASE_BACKOFF_MS,
  RETRY_MAX_BACKOFF_MS,
  SCAN_MAX_DURATION_SECONDS,
} from "./config";
import { RUN_JWT_TTL_SECONDS } from "./mint";

describe("A6 recorded thresholds (⚑ provisional — a change here must be a ratified edit)", () => {
  it("orphan threshold is EXACTLY maxDuration + 60s (the A6 formula)", () => {
    expect(ORPHAN_STALE_MS).toBe((SCAN_MAX_DURATION_SECONDS + 60) * 1000);
  });

  it("today's ratified values: 60s maxDuration → 120s orphan threshold", () => {
    expect(SCAN_MAX_DURATION_SECONDS).toBe(60);
    expect(ORPHAN_STALE_MS).toBe(120_000);
  });

  it("heartbeat cadence is 12s (within the A6 ≤~15s bound)", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(12_000);
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(15_000);
  });

  it("retry policy: cap 3, backoff 30s base capped at 5m", () => {
    expect(RETRY_ATTEMPT_CAP).toBe(3);
    expect(RETRY_BASE_BACKOFF_MS).toBe(30_000);
    expect(RETRY_MAX_BACKOFF_MS).toBe(5 * 60_000);
  });
});

describe("per-run JWT TTL (mint.ts security parameter)", () => {
  it("covers the full run window: TTL ≥ maxDuration, and stays short (≤ orphan threshold)", () => {
    expect(RUN_JWT_TTL_SECONDS).toBe(120);
    expect(RUN_JWT_TTL_SECONDS).toBeGreaterThanOrEqual(SCAN_MAX_DURATION_SECONDS);
    expect(RUN_JWT_TTL_SECONDS * 1000).toBeLessThanOrEqual(ORPHAN_STALE_MS);
  });
});
