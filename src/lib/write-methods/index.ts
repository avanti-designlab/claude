/**
 * Auto-fix write methods (Phase 1.3, doc 04 §1) — the adapters that implement
 * the change-management layer's {@link WriteMethodAdapter} port, one per
 * platform: WordPress + Webflow + Wix + Cloudflare edge worker (all four
 * shipped; Git/PR is architected in the data model, built in Phase 2).
 *
 * THE NON-NEGOTIABLE (doc 04 §2): nothing imports an adapter to write with it
 * directly. Adapters are registered on the ChangeManager's AdapterRegistry and
 * driven only by the pipeline — preview → human-approved apply (with live
 * before-capture) → monitor → rollback. A direct adapter write in feature code
 * is a Code Review rejection.
 */

export * from "./shared";
export * from "./wordpress";
export * from "./webflow";
export * from "./wix";
export * from "./cloudflare";
