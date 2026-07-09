/**
 * AIDetectionProvider — the SECOND of M9's two vendor-deferred seams, and the one
 * doc 07 §1.5 says to "pilot 2–3 vendors" for. So the design is a MULTI-DETECTOR
 * PANEL: a LIST/registry of independent detectors, each reporting its own score,
 * never a single hardcoded detector. Each adapter normalizes its vendor's native
 * score to a common AI-likelihood in [0,1] (higher = more machine-like), so the
 * panel can aggregate + apply a quorum (see ./thresholds).
 *
 * DEFERRED VENDORS (like the humanizer + M8's Anthropic adapter): the real
 * adapters read operator secrets from the vault (doc 04 §5) and are NOT yet
 * provisioned. They land in ./live-providers at wiring time, behind this port. A
 * detection SDK import outside an adapter is a Code Review rejection.
 *
 * HONESTY (the authenticity spine): scores are reported VERBATIM — never massaged,
 * clamped-to-pass, or gamed. A detector that errors, times out, or returns a
 * non-finite/out-of-range score is marked UNAVAILABLE (score null), NOT silently
 * treated as a pass. The panel needs a quorum of AVAILABLE detectors to reach a
 * verdict (./thresholds MIN_DETECTORS); otherwise the gate is honestly
 * "unavailable".
 */

/** One detector adapter's native reading, normalized to a common scale. */
export interface DetectionReading {
  /** AI-likelihood in [0,1]; higher = more likely machine-generated. */
  aiLikelihood: number;
}

/**
 * The provider-agnostic AI-detection connector. A PANEL is simply a list of these
 * (`readonly AIDetectionProvider[]`) — the registry is the array, so piloting 2–3
 * vendors is "register 2–3 adapters", and reporting each is inherent.
 */
export interface AIDetectionProvider {
  /** Stable vendor id for provenance, e.g. "detector-a", "scripted-fake-1". */
  readonly vendor: string;
  /** Score one text's AI-likelihood. */
  detect(text: string): Promise<DetectionReading>;
}

/** One detector's result AS RECORDED — verbatim score + availability + a redacted note. */
export interface DetectorReading {
  vendor: string;
  /** True only when the detector produced a valid finite score in [0,1]. */
  available: boolean;
  /** The verbatim normalized score — NEVER massaged. null when unavailable. */
  aiLikelihood: number | null;
  /** Whether this detector alone reads the candidate as human (≤ passAt). null when unavailable. */
  belowThreshold: boolean | null;
  /** Stable redacted token when unavailable ("detector_error" | "detector_bad_score"); never the raw error/text. */
  note?: "detector_error" | "detector_bad_score";
}

/** A valid AI-likelihood is a finite number within [0,1]. Anything else is "unavailable", not a pass. */
function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Run one detector in isolation and record its verbatim reading. A throw (vendor
 * error, timeout, deferred adapter) → unavailable with `detector_error`; a
 * malformed/out-of-range score → unavailable with `detector_bad_score`. The raw
 * error is NEVER surfaced (it can carry the candidate text) — only the stable
 * token. A detector failure never fails the whole panel; it just doesn't count
 * toward the quorum.
 */
async function runOne(
  detector: AIDetectionProvider,
  text: string,
  passAt: number,
): Promise<DetectorReading> {
  try {
    const reading = await detector.detect(text);
    if (!reading || !validScore(reading.aiLikelihood)) {
      return { vendor: detector.vendor, available: false, aiLikelihood: null, belowThreshold: null, note: "detector_bad_score" };
    }
    const score = reading.aiLikelihood;
    return { vendor: detector.vendor, available: true, aiLikelihood: score, belowThreshold: score <= passAt };
  } catch {
    return { vendor: detector.vendor, available: false, aiLikelihood: null, belowThreshold: null, note: "detector_error" };
  }
}

/**
 * Run the whole detector PANEL over one candidate. Every detector runs (isolated,
 * concurrently); each contributes one {@link DetectorReading}. The list preserves
 * registration order for stable reporting. Aggregation/quorum is ./thresholds'
 * job — this function only gathers verbatim readings.
 */
export async function runDetectorPanel(
  detectors: readonly AIDetectionProvider[],
  text: string,
  passAt: number,
): Promise<DetectorReading[]> {
  return Promise.all(detectors.map((d) => runOne(d, text, passAt)));
}

/* ------------------------------------------------------------------ */
/* Scriptable fake (M9 tests; build a panel of these — no SDK/network) */
/* ------------------------------------------------------------------ */

/**
 * Scriptable, journaling detector double. Give each its own vendor id + score so a
 * TEST PANEL of 2–3 exercises multi-detector reporting + the quorum. The score may
 * be a function of the text so a test can prove the exact candidate reached the
 * detector. `failNext()` / a NaN score exercise the unavailable paths.
 */
export class ScriptedDetectionProvider implements AIDetectionProvider {
  readonly vendor: string;
  readonly calls: string[] = [];
  private scorer: number | ((text: string) => number);
  private nextError: Error | null = null;

  constructor(vendor: string, score: number | ((text: string) => number) = 0) {
    this.vendor = vendor;
    this.scorer = score;
  }

  /** Set the score (fixed or a function of the scored text). */
  set(score: number | ((text: string) => number)): this {
    this.scorer = score;
    return this;
  }

  /** The next detect() call rejects (unavailable/thrown path). */
  failNext(error: Error = new Error("detector unavailable")): this {
    this.nextError = error;
    return this;
  }

  async detect(text: string): Promise<DetectionReading> {
    this.calls.push(text);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    return { aiLikelihood: typeof this.scorer === "function" ? this.scorer(text) : this.scorer };
  }
}
