/**
 * Wix write method (doc 04 §1 method 1 — build third).
 *
 * Public surface:
 *  - {@link WixAdapter} — the WriteMethodAdapter implementation; register it
 *    (per property) on the ChangeManager's AdapterRegistry. It is NEVER
 *    called directly by feature code — every write flows through the
 *    change-management pipeline (doc 04 §2, the non-negotiable). Writes are
 *    LIVE-IMMEDIATE: Wix has no staged layer on these surfaces, so an apply
 *    changes the live site the moment the API accepts it — before-capture +
 *    verified revert is the entire safety story, and MONITOR correlation
 *    against applied_at is sound for this method (unlike Webflow's staged
 *    semantics; resumed-after-crash rows carry a caveat — adapter header).
 *    One gate-dispositioned ACCEPTED RESIDUAL (Orchestrator + Code Review,
 *    2026-07-09): a concurrent CMS edit landing inside a data write's
 *    GET→PUT window is silently overwritten — Wix Data v2 is last-writer-wins
 *    with no conditional update; see the adapter header's residual section
 *    for the operator-facing framing.
 *  - {@link wixLocators} / {@link validateWixWrite} — how the GENERATE side
 *    composes and pre-validates Wix targets.
 *  - {@link FakeWix} — the stateful Wix REST test double (QA rollback suite),
 *    modeling bare-API-key + wix-site-id auth scoping, unset-inherits page
 *    SEO fields, full-replace Data-item updates with server-managed system
 *    fields, rate limiting, concurrent CMS edits at rest and inside the
 *    GET→PUT window (editDataItem / editDataItemOnNextPut), and a
 *    replace-semantics seoData PATCH mode (the merge-assumption canary).
 */

export {
  WIX_API_HOST,
  WixAdapter,
  type WixAdapterConfig,
  type WixSitePin,
} from "./adapter";

export {
  assertReversibleWixValue,
  describeWixOperation,
  parseWixTarget,
  validateWixWrite,
  wixLocators,
  type WixOperation,
} from "./target";

export {
  FakeWix,
  type FakeWixCollectionSeed,
  type FakeWixPageSeed,
  type FakeWixSeed,
} from "./fake-wix";
