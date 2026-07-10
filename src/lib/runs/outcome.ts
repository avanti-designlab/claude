/**
 * Run execution outcome — the CLOSED, redacted shape the processor records on
 * a leased run (ARCHITECTURE RULING A4/telemetry rule). A run finishes as
 * `succeeded` (+ a content-free `result_ref` pointer to the produced artifact)
 * or `failed` (+ a closed-enum `error_code`). Nothing here carries a URL, a
 * payload, or free error text — the honesty/redaction guardrail is structural:
 * the type simply cannot hold anything else.
 *
 * Pure — no server/DB imports; safe in the default `npm test` run.
 */

import type { RunErrorCode } from "@/lib/types/db";

/** Content-free artifact pointer (mirrors runs.result_ref jsonb: {kind, id?}). */
export interface RunResultRef {
  kind: string;
  id?: string;
}

/** The terminal outcome the processor writes (running → succeeded|failed). */
export type RunOutcome =
  | { status: "succeeded"; resultRef: RunResultRef | null }
  | { status: "failed"; errorCode: RunErrorCode };

/**
 * The ONLY error a kind adapter may throw to signal a mapped, redacted failure.
 * `errorCode` is a closed-enum value (src/lib/types/db RUN_ERROR_CODES) — an
 * adapter chooses which honest bucket a failure falls in; anything it lets
 * escape unmapped is caught by the orchestrator and recorded as `engine_error`
 * (never the raw message).
 */
export class RunExecutionError extends Error {
  readonly errorCode: RunErrorCode;
  constructor(errorCode: RunErrorCode, message?: string) {
    super(message ?? errorCode);
    this.name = "RunExecutionError";
    this.errorCode = errorCode;
  }
}

/** Map any thrown value to a closed error_code: a mapped RunExecutionError keeps
 *  its code; everything else collapses to `engine_error` (no message leaks). */
export function toErrorCode(err: unknown): RunErrorCode {
  return err instanceof RunExecutionError ? err.errorCode : "engine_error";
}
