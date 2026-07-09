/**
 * M3 Visibility Tracker — sampling engine over the CitationDataProvider port
 * (doc 04 §3/§7; doc 05 §M3; doc 07 §1.4).
 *
 * Drives the provider-agnostic port — NEVER a vendor SDK — across the derived
 * query set × the six engines, and returns a structurally honest run:
 *
 *  - A provider failure yields a FAILED outcome (typed kind, retryability,
 *    attempt count) — the sample is ABSENT from measurement, never an
 *    invented `cited: false`. 0 means "measured, not cited"; failure means
 *    "not measured".
 *  - Rate limits and transport blips are classified retryable and retried
 *    with bounded backoff; a provider response that isn't shaped like a
 *    CitationPromptResult is a NON-measurement too (invalid_response) — a
 *    misbehaving vendor cannot smuggle garbage into the trend line.
 *  - Coverage is a first-class output ({@link runCoverage}): a run that
 *    measured 60% of its requests says so structurally, and per-engine gaps
 *    are listed — nothing is extrapolated to fill them.
 *
 * Sampling is SEQUENTIAL by design (query-major, canonical engine order):
 * deterministic call order, and gentle on rented rate limits. Vendor-side
 * batching/parallelism is an adapter concern behind the port.
 *
 * Deterministic given provider behavior: same queries + same scripted
 * provider responses → identical outcomes (the injectable `delay` keeps
 * tests clock-free). The only clock input, `runAt`, is caller-supplied.
 */

import type {
  CitationDataProvider,
  CitationPromptResult,
} from "@/lib/connectors";
import { VISIBILITY_ENGINES, type VisibilityEngine } from "@/lib/types/db";
import type { DerivedQuery } from "./derive";
import type { MeasuredSample } from "./scoring";

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export type ProviderFailureKind =
  /** Vendor said "too many requests" — retryable. */
  | "rate_limited"
  /** Vendor/transport unreachable (5xx, connection errors) — retryable. */
  | "unavailable"
  /** Vendor responded with something that isn't a CitationPromptResult. */
  | "invalid_response"
  /** Anything else — not retried (retrying an unknown error blind is noise). */
  | "unknown";

export interface SampleFailure {
  kind: ProviderFailureKind;
  retryable: boolean;
  /** Attempts actually made (≥ 1). */
  attempts: number;
}

export type SampleOutcome =
  | {
      status: "measured";
      query: DerivedQuery;
      engine: VisibilityEngine;
      result: CitationPromptResult;
    }
  | {
      status: "failed";
      query: DerivedQuery;
      engine: VisibilityEngine;
      failure: SampleFailure;
    };

/** One tracker run: every requested sample accounted for, measured or not. */
export interface VisibilityRun {
  /** Provider provenance (`provider.vendor`). */
  vendor: string;
  /** Caller-supplied ISO timestamp — the run identity (see persist.ts). */
  runAt: string;
  /** Engines requested this run, in the order sampled. */
  engines: VisibilityEngine[];
  /** query-major × engine-minor; length = queries × engines, always. */
  outcomes: SampleOutcome[];
}

export interface RunCoverage {
  /** query × engine pairs requested. */
  requested: number;
  measured: number;
  failed: number;
  /** measured / requested (0 when nothing was requested). */
  coverage: number;
  /** Requested engines with ZERO measured samples — visibly unmeasured. */
  enginesMissing: VisibilityEngine[];
  failuresByKind: Record<ProviderFailureKind, number>;
}

export interface SampleOptions {
  /** ISO timestamp stamped on the run (callers pass their clock — pure). */
  runAt: string;
  /** Default: all six canonical engines. */
  engines?: VisibilityEngine[];
  /** Total attempts per sample, ≥ 1. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Backoff base; wait = backoffMs × attempt#. Default {@link DEFAULT_BACKOFF_MS}. */
  backoffMs?: number;
  /** Injectable wait (tests pass a no-op). Default: real timer. */
  delay?: (ms: number) => Promise<void>;
}

/**
 * ⚑ Doc-silent defaults, chosen at 1.4 (proportionate for a rented API):
 * one retry per failed sample, linear backoff from 500ms.
 */
export const DEFAULT_MAX_ATTEMPTS = 2;
export const DEFAULT_BACKOFF_MS = 500;

/* ------------------------------------------------------------------ */
/* Failure classification                                              */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_CODES = new Set(["429", "rate_limited", "too_many_requests"]);
const TRANSPORT_CODES = new Set([
  "econnreset",
  "econnrefused",
  "etimedout",
  "eai_again",
  "und_err_connect_timeout",
  "und_err_headers_timeout",
  "fetch_failed",
]);

/** Shape-checked `status` / `code` extraction — hostile error objects yield nothing. */
function errorSignals(cause: unknown): { status: number | null; code: string | null } {
  let status: number | null = null;
  let code: string | null = null;
  if (typeof cause === "object" && cause !== null) {
    const raw = cause as { status?: unknown; code?: unknown };
    if (typeof raw.status === "number" && Number.isInteger(raw.status)) {
      status = raw.status;
    }
    if (typeof raw.code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(raw.code)) {
      code = raw.code.toLowerCase();
    }
  }
  return { status, code };
}

/**
 * Classify a thrown provider error. Adapters are encouraged to throw errors
 * carrying `status` (HTTP) or `code` (transport) — but classification never
 * trusts anything beyond those two shape-checked fields, and never reads or
 * propagates the error MESSAGE (vendor messages can quote prompts/payloads;
 * redaction is absolute — docs/ops/environments.md).
 */
export function classifyProviderError(cause: unknown): {
  kind: ProviderFailureKind;
  retryable: boolean;
} {
  const { status, code } = errorSignals(cause);
  if (status === 429 || (code !== null && RATE_LIMIT_CODES.has(code))) {
    return { kind: "rate_limited", retryable: true };
  }
  if (
    (status !== null && status >= 500) ||
    (code !== null && TRANSPORT_CODES.has(code)) ||
    cause instanceof TypeError // fetch's network-failure signature
  ) {
    return { kind: "unavailable", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}

/** Runtime shape check on what the provider returned — trust nothing. */
function isCitationResult(value: unknown): value is CitationPromptResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.cited === "boolean" &&
    (result.position === null || typeof result.position === "number") &&
    (result.sentiment === null || typeof result.sentiment === "string") &&
    (result.citedSource === null || typeof result.citedSource === "string")
  );
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

const realDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function sampleOne(
  provider: CitationDataProvider,
  query: DerivedQuery,
  engine: VisibilityEngine,
  maxAttempts: number,
  backoffMs: number,
  delay: (ms: number) => Promise<void>
): Promise<SampleOutcome> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await provider.runPrompt({
        engine,
        prompt: query.prompt,
        ...(query.geo ? { geo: query.geo } : {}),
      });
      if (!isCitationResult(result)) {
        return {
          status: "failed",
          query,
          engine,
          failure: {
            kind: "invalid_response",
            retryable: false,
            attempts: attempt,
          },
        };
      }
      return { status: "measured", query, engine, result };
    } catch (cause) {
      const { kind, retryable } = classifyProviderError(cause);
      if (!retryable || attempt >= maxAttempts) {
        return {
          status: "failed",
          query,
          engine,
          failure: { kind, retryable, attempts: attempt },
        };
      }
      await delay(backoffMs * attempt);
    }
  }
  /* istanbul ignore next -- loop always returns */
  throw new Error("unreachable");
}

/**
 * Sample the query set across the engines. Never throws for provider
 * failures — every requested pair comes back as an outcome, measured or
 * failed. Throws only on programmer error (unknown engine, empty engine
 * list, invalid runAt) — fail loud before spending rented calls.
 */
export async function sampleVisibility(
  provider: CitationDataProvider,
  queries: DerivedQuery[],
  options: SampleOptions
): Promise<VisibilityRun> {
  if (!Number.isFinite(Date.parse(options.runAt))) {
    throw new Error(`sampleVisibility: runAt is not a timestamp`);
  }
  const engines = options.engines ?? [...VISIBILITY_ENGINES];
  if (engines.length === 0) {
    throw new Error("sampleVisibility: engines must be non-empty");
  }
  for (const engine of engines) {
    if (!VISIBILITY_ENGINES.includes(engine)) {
      throw new Error(`sampleVisibility: unknown engine '${engine}'`);
    }
  }
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = Math.max(0, options.backoffMs ?? DEFAULT_BACKOFF_MS);
  const delay = options.delay ?? realDelay;

  const outcomes: SampleOutcome[] = [];
  for (const query of queries) {
    for (const engine of engines) {
      outcomes.push(
        await sampleOne(provider, query, engine, maxAttempts, backoffMs, delay)
      );
    }
  }

  return {
    vendor: provider.vendor,
    runAt: options.runAt,
    engines: [...engines],
    outcomes,
  };
}

/* ------------------------------------------------------------------ */
/* Run → measurement views                                             */
/* ------------------------------------------------------------------ */

/** The measured samples only — failed samples are ABSENT, never zeros. */
export function measuredSamples(run: VisibilityRun): MeasuredSample[] {
  return run.outcomes.flatMap((outcome) =>
    outcome.status === "measured"
      ? [
          {
            engine: outcome.engine,
            prompt: outcome.query.prompt,
            cited: outcome.result.cited,
            position: outcome.result.position,
            citedSource: outcome.result.citedSource,
          },
        ]
      : []
  );
}

/** Structural partial-coverage honesty — see the module header. */
export function runCoverage(run: VisibilityRun): RunCoverage {
  const failuresByKind: Record<ProviderFailureKind, number> = {
    rate_limited: 0,
    unavailable: 0,
    invalid_response: 0,
    unknown: 0,
  };
  const measuredByEngine = new Map<VisibilityEngine, number>();
  let measured = 0;
  for (const outcome of run.outcomes) {
    if (outcome.status === "measured") {
      measured += 1;
      measuredByEngine.set(
        outcome.engine,
        (measuredByEngine.get(outcome.engine) ?? 0) + 1
      );
    } else {
      failuresByKind[outcome.failure.kind] += 1;
    }
  }
  const requested = run.outcomes.length;
  return {
    requested,
    measured,
    failed: requested - measured,
    coverage: requested === 0 ? 0 : measured / requested,
    enginesMissing: run.engines.filter(
      (engine) => (measuredByEngine.get(engine) ?? 0) === 0
    ),
    failuresByKind,
  };
}
