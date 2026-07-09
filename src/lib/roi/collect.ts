/**
 * M16 ROI / attribution — the collection layer: drive the resolved outcome
 * ports across a period and return a STRUCTURALLY honest result (doc 05 §M16).
 * The sampler analog of the visibility tracker (intelligence/visibility/
 * sampler.ts): it never throws for a source failure — every requested source
 * comes back accounted for as contributed / absent / failed.
 *
 * The three states carry the honesty the whole module depends on:
 *  - CONTRIBUTED: the source is connected and fetched OK; its measured samples
 *    (possibly a measured 0, possibly none) are included.
 *  - ABSENT: the source is not connected (its resolver returned null). It is
 *    listed as absent — NEVER folded in as a zero. "GA4 isn't connected" and
 *    "GA4 measured 0 sessions" are different truths and stay different here.
 *  - FAILED: the source is connected but the fetch errored (typed, retryable).
 *    Also absent from the data, but distinct from "not connected" so the
 *    dashboard can say "retry" rather than "connect".
 *
 * Determinism: given the same resolved ports and the same scripted responses,
 * the collection is identical. Sources are driven in canonical order.
 */

import {
  isRoiSourceError,
  ROI_SOURCE_IDS,
  type OutcomePeriod,
  type OutcomeSample,
  type RoiSource,
  type RoiSourceErrorCode,
  type RoiSourceId,
} from "./sources";

/** How a single source resolved this collection. */
export type SourceOutcome =
  | { sourceId: RoiSourceId; status: "contributed"; vendor: string; samples: OutcomeSample[] }
  | { sourceId: RoiSourceId; status: "absent" }
  | { sourceId: RoiSourceId; status: "failed"; failure: SourceFailureKind };

/** Typed failure classification — read from the error CODE only, never a message. */
export type SourceFailureKind = RoiSourceErrorCode | "unknown";

/** Structural per-source coverage for the collection. */
export interface CollectionCoverage {
  requested: RoiSourceId[];
  contributing: RoiSourceId[];
  /** Not connected — absent, never zero. */
  absent: RoiSourceId[];
  /** Connected but errored — retryable. */
  failed: RoiSourceId[];
  /** contributing / requested (0 when nothing was requested). */
  coverage: number;
}

export interface RoiCollection {
  period: OutcomePeriod;
  /** All measured samples from contributing sources (measured values only). */
  samples: OutcomeSample[];
  /** One entry per requested source, canonical order. */
  outcomes: SourceOutcome[];
  coverage: CollectionCoverage;
}

/** A resolved set of ports; a null value means "requested but not connected". */
export type ResolvedSources = Partial<Record<RoiSourceId, RoiSource | null>>;

function classify(cause: unknown): SourceFailureKind {
  return isRoiSourceError(cause) ? cause.code : "unknown";
}

/**
 * Collect outcomes for `period` from the requested sources. `requested`
 * defaults to all five logical sources; `resolved` supplies the live port for
 * each (absent/null → the source is not connected). A source's fetch is retried
 * once on a retryable typed failure via the injected `delay` (tests pass a
 * no-op); non-retryable failures are not retried.
 */
export async function collectOutcomes(
  resolved: ResolvedSources,
  period: OutcomePeriod,
  options: { requested?: RoiSourceId[]; delay?: (ms: number) => Promise<void> } = {},
): Promise<RoiCollection> {
  const requested = dedupeCanonical(options.requested ?? [...ROI_SOURCE_IDS]);
  const delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const outcomes: SourceOutcome[] = [];
  const samples: OutcomeSample[] = [];

  for (const sourceId of requested) {
    const port = resolved[sourceId] ?? null;
    if (port === null) {
      outcomes.push({ sourceId, status: "absent" });
      continue;
    }
    const outcome = await fetchWithRetry(port, sourceId, period, delay);
    outcomes.push(outcome);
    if (outcome.status === "contributed") samples.push(...outcome.samples);
  }

  const contributing = outcomes.filter((o) => o.status === "contributed").map((o) => o.sourceId);
  const absent = outcomes.filter((o) => o.status === "absent").map((o) => o.sourceId);
  const failed = outcomes.filter((o) => o.status === "failed").map((o) => o.sourceId);

  return {
    period,
    samples,
    outcomes,
    coverage: {
      requested,
      contributing,
      absent,
      failed,
      coverage: requested.length === 0 ? 0 : contributing.length / requested.length,
    },
  };
}

const RETRYABLE: ReadonlySet<SourceFailureKind> = new Set<SourceFailureKind>([
  "rate_limited",
  "network_failure",
]);

async function fetchWithRetry(
  port: RoiSource,
  sourceId: RoiSourceId,
  period: OutcomePeriod,
  delay: (ms: number) => Promise<void>,
): Promise<SourceOutcome> {
  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await port.fetchOutcomes({ period });
      // Trust nothing the port returns: keep only well-formed measured samples
      // for THIS source and THIS period — a misbehaving adapter can't smuggle
      // another source's rows or a bad value into the collection.
      const clean = sanitizeSamples(result.samples, sourceId, period);
      return { sourceId, status: "contributed", vendor: result.vendor, samples: clean };
    } catch (cause) {
      const failure = classify(cause);
      if (!RETRYABLE.has(failure) || attempt >= maxAttempts) {
        return { sourceId, status: "failed", failure };
      }
      await delay(250 * attempt);
    }
  }
  /* istanbul ignore next -- loop always returns */
  return { sourceId, status: "failed", failure: "unknown" };
}

function sanitizeSamples(
  raw: unknown,
  sourceId: RoiSourceId,
  period: OutcomePeriod,
): OutcomeSample[] {
  if (!Array.isArray(raw)) return [];
  const clean: OutcomeSample[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    // An adapter must only report ITS OWN source; a row tagged for a different
    // source is dropped, never re-stamped in (that would launder another
    // source's metric — e.g. a "revenue" row — into this one).
    if (typeof record.source === "string" && record.source !== sourceId) continue;
    const metric = typeof record.metric === "string" ? record.metric.trim() : "";
    const value = record.value;
    if (
      metric === "" ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0
    ) {
      continue;
    }
    // Stamp source/period from the trusted collection scope (never the
    // adapter's echo) so the sample's provenance is authoritative.
    clean.push({ source: sourceId, metric, value, period });
  }
  return clean;
}

function dedupeCanonical(ids: RoiSourceId[]): RoiSourceId[] {
  const wanted = new Set(ids);
  return ROI_SOURCE_IDS.filter((id) => wanted.has(id));
}
