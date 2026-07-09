/**
 * M9 CORE — the pure humanize→detect→flag flow (doc 05 Part B; doc 07 §1.5).
 * Owns exactly two pipeline stages: Humanize + Detect. It EVALUATES and RECORDS;
 * it NEVER approves, publishes, or gates on quality — the verdict is data the
 * downstream human/hard gates (Content Quality → Compliance) + the dashboard read.
 *
 * Pure w.r.t. the platform: no DB, no auth, no logging, no clock, no randomness —
 * providers are INJECTED (task constraint: ports + injected clients only, no vendor
 * SDK in tested paths). Determinism: same candidate + same detector readings ⇒
 * byte-identical record (pinned by a determinism test). The action (./actions)
 * wires the real (deferred) providers, the locked voice, and persistence.
 *
 * WHY IT CANNOT FORCE-PASS OR SELF-APPROVE (the authenticity spine):
 *  - Scores are reported VERBATIM (./detector) — never massaged to clear the line.
 *  - `passes` is TRUE only when the detector quorum is met AND no meaning/voice
 *    drift AND enough detectors were available. Any shortfall ⇒ `flagged_for_human`
 *    with an explicit reason; the item is NEVER marked clean.
 *  - It emits a RECORD + an optional body; it writes no review verdict and cannot
 *    set an approved/published status (that lives in ./persist, pinned to
 *    'in_review', and the DB CHECK forbids approval without both gate verdicts).
 *  - Providers unavailable ⇒ a typed `ok:false` (nothing to persist), never a
 *    silent pass.
 */

import { runDetectorPanel, type AIDetectionProvider, type DetectorReading } from "./detector";
import { recheckDrift } from "./drift";
import type { HumanizerProvider } from "./humanizer";
import {
  aggregatePanel,
  resolveThresholds,
  type AuthenticityThresholds,
} from "./thresholds";
import type { FlagReason, HumanizationRecord, HumanizationVerdict } from "./types";
import type { VoiceProfile } from "@/lib/types/brand";

export interface AuthenticateInput {
  /** The M8 draft body (the original — also the meaning ground-truth for drift). */
  body: string;
  /** The locked brand voice (from M7's kit) — drives the humanizer + the voice-drift recheck. */
  voice: VoiceProfile;
  humanizer: HumanizerProvider;
  /** The detector PANEL — 2–3 piloted vendors (doc 07). A list/registry, not one detector. */
  detectors: readonly AIDetectionProvider[];
  /** Optional threshold override (validated/clamped); defaults to the launch thresholds. */
  thresholds?: Partial<AuthenticityThresholds>;
}

export type AuthenticateOutcome =
  | {
      ok: true;
      record: HumanizationRecord;
      /**
       * The humanized text to write to content_items.body, or null to KEEP the
       * original. Non-null only when meaning/voice were preserved (never persist
       * drifted text).
       */
      bodyToPersist: string | null;
    }
  | {
      ok: false;
      reason: "humanizer_unavailable" | "humanizer_empty" | "detectors_unavailable";
      cause?: unknown;
      /** Partial detector readings on `detectors_unavailable`, for redacted diagnostics. */
      partial?: DetectorReading[];
    };

/**
 * Run the authenticity gate over one draft. Returns a persistable record + the
 * body decision, or a typed unavailable outcome (nothing to persist — honest, not
 * a pass). See the module header for why it can neither force-pass nor self-approve.
 */
export async function authenticate(input: AuthenticateInput): Promise<AuthenticateOutcome> {
  const thresholds = resolveThresholds(input.thresholds);

  // 1) HUMANIZE. A thrown/rejected humanizer (deferred adapter, timeout, vendor
  //    error) is an honest unavailable — never a silent pass, nothing persisted.
  let humanizedText: string;
  let humanizerVendor: string;
  try {
    const result = await input.humanizer.humanize({ body: input.body, voice: input.voice });
    humanizerVendor = input.humanizer.vendor;
    humanizedText = typeof result?.text === "string" ? result.text.trim() : "";
  } catch (cause) {
    return { ok: false, reason: "humanizer_unavailable", cause };
  }
  if (humanizedText === "") return { ok: false, reason: "humanizer_empty" };

  // 2) DRIFT recheck (meaning + voice) — did the humanizer alter facts / slip
  //    off-voice? Computed against the ORIGINAL body. A drifted rewrite is never
  //    a safe substitute, so it is not applied to the body (bodyToPersist stays null).
  const drift = recheckDrift({ original: input.body, humanized: humanizedText, voice: input.voice });

  // 3) DETECT — the whole panel scores the HUMANIZED CANDIDATE; scores verbatim.
  const panel = await runDetectorPanel(input.detectors, humanizedText, thresholds.passAt);
  const aggregate = aggregatePanel(panel, thresholds);
  if (aggregate.detectorsAvailable < thresholds.minDetectors) {
    // Not enough available detectors to form a verdict — honestly unavailable.
    return { ok: false, reason: "detectors_unavailable", partial: panel };
  }

  // 4) VERDICT. Any shortfall flags for a human; only a fully-clean item passes.
  const flaggedReasons: FlagReason[] = [];
  if (drift.meaning.length > 0) flaggedReasons.push("meaning_drift");
  if (drift.voice.length > 0) flaggedReasons.push("voice_drift");
  if (!aggregate.belowThreshold) flaggedReasons.push("detection_above_threshold");

  const verdict: HumanizationVerdict = flaggedReasons.length === 0 ? "passed" : "flagged_for_human";
  const passes = verdict === "passed";
  // Apply the humanized text ONLY when meaning/voice were preserved. A drifted
  // rewrite is discarded (keep the original); a clean-but-still-detectable rewrite
  // is kept (it is the better base for the human, just flagged).
  const applied = !drift.detected;

  const record: HumanizationRecord = {
    // --- frozen HumanizationResult projection (do not rename; M8 + db.ts read these) ---
    humanized: applied,
    detection_score: aggregate.score ?? 1,
    passes,
    // --- M9 detail ---
    schemaVersion: 1,
    verdict,
    flaggedReasons,
    humanizer: { vendor: humanizerVendor, applied },
    detectors: panel,
    aggregate: {
      score: aggregate.score,
      detectorsAvailable: aggregate.detectorsAvailable,
      detectorsBelow: aggregate.detectorsBelow,
      belowThreshold: aggregate.belowThreshold,
    },
    quorum: { required: aggregate.quorumRequired, met: aggregate.quorumMet },
    thresholds: {
      passAt: thresholds.passAt,
      minDetectors: thresholds.minDetectors,
      requireUnanimous: thresholds.requireUnanimous,
    },
    drift: { meaning: drift.meaning, voice: drift.voice, detected: drift.detected },
  };

  return { ok: true, record, bodyToPersist: applied ? humanizedText : null };
}
