/**
 * edge-autofix — Phase 0.1 pass-through stub.
 *
 * Phase 1.3 builds the real method: fetch the platform's desired-state for the
 * requested URL and apply diffs (title/meta/schema/H1/alt/canonical) at the
 * edge before the page reaches users and crawlers. Every applied diff comes
 * from the change-management layer (doc 04 §2) — this worker never invents
 * changes and never writes outside a logged, reversible site_changes entry.
 */
const worker = {
  async fetch(request: Request): Promise<Response> {
    // Pass-through: no rewriting until the change-management layer exists.
    return fetch(request);
  },
};

export default worker;
