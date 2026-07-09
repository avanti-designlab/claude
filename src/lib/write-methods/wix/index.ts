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
 *    semantics).
 *  - {@link wixLocators} / {@link validateWixWrite} — how the GENERATE side
 *    composes and pre-validates Wix targets.
 *  - {@link FakeWix} — the stateful Wix REST test double (QA rollback suite),
 *    modeling bare-API-key + wix-site-id auth scoping, unset-inherits page
 *    SEO fields, full-replace Data-item updates with server-managed system
 *    fields, and rate limiting.
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
