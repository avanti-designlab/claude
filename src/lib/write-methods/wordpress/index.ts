/**
 * WordPress write method (doc 04 §1 method 1 — build first, highest coverage).
 *
 * Public surface:
 *  - {@link WordPressAdapter} — the WriteMethodAdapter implementation; register
 *    it (per property) on the ChangeManager's AdapterRegistry. It is NEVER
 *    called directly by feature code — every write flows through the
 *    change-management pipeline (doc 04 §2, the non-negotiable).
 *  - {@link wordpressLocators} / {@link validateWordPressWrite} — how the
 *    GENERATE side composes and pre-validates WordPress targets.
 *  - {@link FakeWordPress} — the stateful wp/v2 test double (QA rollback suite).
 */

export {
  WordPressAdapter,
  type WordPressAdapterConfig,
  type WordPressSitePin,
} from "./adapter";

export {
  assertReversibleValue,
  describeOperation,
  parseWordPressTarget,
  restRouteFor,
  validateWordPressWrite,
  wordpressLocators,
  type WordPressOperation,
} from "./target";

export {
  FakeWordPress,
  type FakeEntitySeed,
  type FakeWordPressSeed,
  type RegisteredMetaType,
} from "./fake-wp";
