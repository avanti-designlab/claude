/**
 * Unified change-management layer — public API (Phase 1.2, doc 04 §2).
 *
 * THE NON-NEGOTIABLE: no write to a client site may bypass this layer. A write
 * method (WordPress / Webflow / Wix / Cloudflare edge worker — built in 1.3)
 * reaches a site ONLY by implementing the {@link WriteMethodAdapter} port and
 * being driven by the {@link ChangeManager}; the manager persists a
 * `site_changes` row before every write, requires a human approver, and makes
 * every change reversible by exactly one action.
 *
 * Public surface:
 *  - {@link ChangeManager}         — the pipeline (preview → apply → monitor → rollback)
 *  - {@link WriteMethodAdapter}    — the write port 1.3's methods implement
 *  - {@link ChangeStore}           — the persistence port Supabase implements
 *  - {@link Clock}                 — injected time (determinism)
 *  - {@link AutoRollbackPolicyResolver} / {@link AlertSink} — per-client policy + M17 hook
 *  - Stubs ({@link InMemoryChangeStore}, {@link RecordingWriteAdapter}) for tests / pre-1.3
 */

export { ChangeManager } from "./manager";
export type { ChangeManagerDeps, ConnectionCheck } from "./manager";

export * from "./types";
export * from "./ports";
export * from "./errors";

export {
  LEGAL_TRANSITIONS,
  isLegalTransition,
  assertLegalTransition,
  assertRowSatisfiesConstraints,
} from "./status-machine";

export {
  WRITER_ROLES,
  isWriter,
  assertWriter,
  resolveWriteAutomationLevel,
  assertTenantMatch,
  assertRowInScope,
  DEFAULT_SITE_CHANGE_AUTOMATION_LEVEL,
} from "./automation";

export {
  isBreach,
  evaluateBreaches,
  describeBreach,
  autoRollbackReason,
} from "./auto-rollback";

export { buildStructuredDiff, toLines } from "./diff";
export { jsonEqual } from "./json";

export { systemClock, fixedClock, steppingClock } from "./clock";

export {
  InMemoryChangeStore,
  type InMemoryChangeStoreOptions,
} from "./stub-store";
export {
  RecordingWriteAdapter,
  MapAdapterRegistry,
  type AdapterCall,
  type AdapterOp,
} from "./stub-adapter";
