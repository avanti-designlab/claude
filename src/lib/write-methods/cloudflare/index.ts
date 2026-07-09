/**
 * Cloudflare edge-worker write method (doc 04 §1 method 2 — the universal
 * fallback, REQUIRED for Framer). Method value: `edge_worker`.
 *
 * Public surface:
 *  - {@link CloudflareEdgeAdapter} — the WriteMethodAdapter implementation;
 *    register it (per property) on the ChangeManager's AdapterRegistry. It is
 *    NEVER called directly by feature code — every write flows through the
 *    change-management pipeline (doc 04 §2, the non-negotiable). A "write" on
 *    this method upserts/removes ONE rule in the property's edge manifest;
 *    origin content is never touched (see the adapter header for what that
 *    makes stronger — rollback — and what it defers to MONITOR —
 *    render-verification).
 *  - {@link edgeLocators} / {@link validateEdgeWrite} — how the GENERATE side
 *    composes and pre-validates edge targets. NOTE for GENERATE modules: on
 *    this method `DesiredChange.before` is the RULE state (usually null — no
 *    rule yet), never crawled origin HTML.
 *  - {@link FakeCloudflareKv} — the stateful Workers-KV REST test double
 *    (QA rollback suite).
 *
 * The manifest wire format itself lives with the worker
 * (`workers/edge-autofix/src/manifest.ts`) and is re-exported here so app
 * code never deep-imports across the package boundary.
 */

export {
  CloudflareEdgeAdapter,
  CLOUDFLARE_API_HOST,
  type CloudflareEdgeAdapterConfig,
  type CloudflareEdgePin,
} from "./adapter";

export {
  assertReversibleEdgeValue,
  describeEdgeOperation,
  edgeLocators,
  parseEdgeTarget,
  ruleFor,
  ruleIdFor,
  ruleValueOf,
  validateEdgeWrite,
  type EdgeOperation,
  type EdgeRuleAddress,
} from "./target";

export {
  MANIFEST_KEY as EDGE_MANIFEST_KEY,
  parseManifest as parseEdgeManifest,
  serializeManifest as serializeEdgeManifest,
  type EdgeRule,
  type EdgeRulesManifest,
} from "../../../../workers/edge-autofix/src/manifest";

export { FakeCloudflareKv, type FakeCloudflareKvSeed } from "./fake-cloudflare";
