import "server-only";

/**
 * M3 Visibility Tracker — the single provider-resolution seam.
 *
 * LOCKED DECISION (doc 04 §3): citation data is bought/rented via the
 * CitationDataProvider port; vendor adapters are OWNED BY THE INTEGRATIONS
 * ENGINEER and live in src/lib/connectors/. No real adapter has landed yet —
 * the port shipped at 1.2 with only the in-memory test double — so resolution
 * returns null today and the run action degrades to a TYPED, honest
 * "no_provider" outcome (never a fake run, never invented zeros).
 *
 * ⚑ WIRING POINT (flagged for the Orchestrator): when the first vendor
 * adapter (e.g. ProfoundAdapter) lands, this function selects it — by env
 * config, credentials resolved at call time from the secrets vault (doc 04
 * §5). This is the ONLY place M3 learns which vendor exists; modules keep
 * importing the port. Swapping vendors changes this resolution + one adapter,
 * nothing else (doc 04 §7).
 */

import type { CitationDataProvider } from "@/lib/connectors";

export function resolveCitationDataProvider(): CitationDataProvider | null {
  // No vendor adapter exists in the repo yet (doc 07 §1.2 shipped the port +
  // fake only). Honest null — the action reports "no_provider" typed.
  return null;
}
