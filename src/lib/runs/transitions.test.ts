import { describe, expect, it } from "vitest";
import { RUN_STATUSES, type RunStatus } from "@/lib/types/db";
import {
  isLegalRunTransition,
  isTerminalRunStatus,
  shouldRetry,
  type RunTransitionVia,
} from "./transitions";

const VIAS: RunTransitionVia[] = ["processor", "sweep", "retry", "cancel"];

/** Every legal edge (from, to, via) from the ARCHITECTURE RULING A4. */
const LEGAL: Array<[RunStatus, RunStatus, RunTransitionVia]> = [
  ["queued", "running", "processor"],
  ["running", "succeeded", "processor"],
  ["running", "failed", "processor"],
  ["running", "failed", "sweep"],
  ["failed", "queued", "retry"],
  ["queued", "canceled", "cancel"],
];

function isLegalListed(from: RunStatus, to: RunStatus, via: RunTransitionVia): boolean {
  return LEGAL.some(([f, t, v]) => f === from && t === to && v === via);
}

describe("run transition legality — the full graph pinned, legal AND illegal", () => {
  it("accepts exactly the legal edges", () => {
    for (const [from, to, via] of LEGAL) {
      expect(isLegalRunTransition(from, to, via), `${from}->${to} via ${via}`).toBe(true);
    }
  });

  it("rejects EVERY other (from, to, via) combination", () => {
    for (const from of RUN_STATUSES) {
      for (const to of RUN_STATUSES) {
        for (const via of VIAS) {
          if (isLegalListed(from, to, via)) continue;
          expect(
            isLegalRunTransition(from, to, via),
            `${from}->${to} via ${via} must be illegal`
          ).toBe(false);
        }
      }
    }
  });

  it("running → failed is allowed by BOTH processor and sweep; queued → failed by neither", () => {
    expect(isLegalRunTransition("running", "failed", "sweep")).toBe(true);
    expect(isLegalRunTransition("running", "failed", "processor")).toBe(true);
    expect(isLegalRunTransition("queued", "failed", "processor")).toBe(false);
    expect(isLegalRunTransition("queued", "failed", "sweep")).toBe(false);
  });

  it("sweep may ONLY reap a running run into failed (never lease or complete)", () => {
    expect(isLegalRunTransition("queued", "running", "sweep")).toBe(false);
    expect(isLegalRunTransition("running", "succeeded", "sweep")).toBe(false);
  });

  it("cancel is ONLY queued → canceled (no mid-run cancel yet)", () => {
    expect(isLegalRunTransition("queued", "canceled", "cancel")).toBe(true);
    expect(isLegalRunTransition("running", "canceled", "cancel")).toBe(false);
  });

  it("terminal states cannot be reopened — except the bounded failed → queued retry", () => {
    for (const term of ["succeeded", "canceled"] as const) {
      for (const to of RUN_STATUSES) {
        for (const via of VIAS) {
          expect(isLegalRunTransition(term, to, via), `${term} is immutable`).toBe(false);
        }
      }
    }
    // failed is terminal EXCEPT retry → queued.
    expect(isLegalRunTransition("failed", "queued", "retry")).toBe(true);
    expect(isLegalRunTransition("failed", "running", "processor")).toBe(false);
    expect(isLegalRunTransition("failed", "succeeded", "processor")).toBe(false);
  });
});

describe("terminal + retry policy", () => {
  it("isTerminalRunStatus", () => {
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("canceled")).toBe(true);
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
  });

  it("shouldRetry re-queues a failed run only under the cap", () => {
    expect(shouldRetry("failed", 0, 3)).toBe(true);
    expect(shouldRetry("failed", 2, 3)).toBe(true);
    expect(shouldRetry("failed", 3, 3)).toBe(false); // cap reached
    expect(shouldRetry("failed", 4, 3)).toBe(false);
    expect(shouldRetry("running", 0, 3)).toBe(false); // not failed
    expect(shouldRetry("succeeded", 0, 3)).toBe(false);
  });
});
