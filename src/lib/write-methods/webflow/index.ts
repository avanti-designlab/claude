/**
 * Webflow write method (doc 04 §1 method 1 — build second).
 *
 * Public surface:
 *  - {@link WebflowAdapter} — the WriteMethodAdapter implementation; register
 *    it (per property) on the ChangeManager's AdapterRegistry. It is NEVER
 *    called directly by feature code — every write flows through the
 *    change-management pipeline (doc 04 §2, the non-negotiable). Writes are
 *    STAGED-only: the live site changes exclusively through the pipeline's
 *    explicit publish flow, never through this method.
 *  - {@link webflowLocators} / {@link validateWebflowWrite} — how the
 *    GENERATE side composes and pre-validates Webflow targets.
 *  - {@link FakeWebflow} — the stateful Data API v2 test double (QA rollback
 *    suite), modeling staged-vs-published state, the OG mirror flags, slug
 *    normalization, and rate limiting.
 */

export {
  WEBFLOW_API_HOST,
  WebflowAdapter,
  type WebflowAdapterConfig,
  type WebflowSitePin,
} from "./adapter";

export {
  assertReversibleWebflowValue,
  describeWebflowOperation,
  parseWebflowTarget,
  validateWebflowWrite,
  webflowLocators,
  webflowRouteFor,
  type WebflowOperation,
} from "./target";

export {
  FakeWebflow,
  type FakeWebflowCollectionSeed,
  type FakeWebflowPageSeed,
  type FakeWebflowSeed,
} from "./fake-webflow";
