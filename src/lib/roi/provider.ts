import "server-only";

/**
 * M16 ROI / attribution — the single source-resolution seam.
 *
 * LOCKED DECISION (doc 04 §3): outcome data is bought/rented via the RoiSource
 * ports (GA4/GSC official APIs; a rented call-tracking provider; a form-fill
 * provider; a CRM handoff). Vendor adapters are OWNED BY THE INTEGRATIONS
 * ENGINEER and live in src/lib/roi/. No real adapter has landed yet — this
 * module ships the ports + fakes only — so resolution returns null for every
 * source today and the collection degrades to an HONEST "absent" per source
 * (never a fake capture, never invented zeros; absent ≠ zero).
 *
 * ⚑ WIRING POINT (flagged for the Orchestrator): when a real adapter lands
 * (e.g. Ga4Adapter), this function selects it — by env/tenant config,
 * credentials resolved at call time from the secrets vault (doc 04 §5), the API
 * host pinned via `resolvePinnedApiHost`. This is the ONLY place M16 learns
 * which vendor exists; the collection + attribution import the port. Swapping a
 * vendor changes this resolution + one adapter, nothing else (doc 04 §7).
 */

import type { ResolvedSources } from "./collect";
import { ROI_SOURCE_IDS, type RoiSource, type RoiSourceId } from "./sources";

/** Resolve one source's live port, or null when no adapter is connected. */
export function resolveRoiSource(sourceId: RoiSourceId): RoiSource | null {
  // Reserved for adapter selection (by env/tenant config) when the first vendor
  // lands; today no adapter exists, so resolution is an honest null. The
  // collection reports the source "absent", and attribution treats absent as
  // ABSENT, never zero.
  void sourceId;
  return null;
}

/** Resolve the full requested set into the map the collection consumes. */
export function resolveRoiSources(requested: RoiSourceId[] = [...ROI_SOURCE_IDS]): ResolvedSources {
  const resolved: ResolvedSources = {};
  for (const id of requested) resolved[id] = resolveRoiSource(id);
  return resolved;
}
