/**
 * CloudflareEdgeAdapter driven by the REAL change-management pipeline
 * (doc 04 §2) — the integration proof the 1.3 gate cares about:
 *
 *  - APPLY captures the RULE state through readCurrent (null = no rule — the
 *    normal case for a first fix) and persists it as `site_changes.diff.before`;
 *    the write upserts one rule into the property's edge manifest, verified
 *    byte-exact against the authoritative store. `applied_at` correlation for
 *    MONITOR is sound with ONE stated caveat: the rendered effect lands on
 *    the next request after ~60s KV propagation (this suite asserts the
 *    authoritative manifest state — render-verification is MONITOR's job via
 *    the worker's x-edge-autofix header);
 *  - ROLLBACK restores the captured rule state via the same adapter (one
 *    action): a null before REMOVES the rule and the origin — never touched
 *    by this method — shows through; a non-null before re-installs the prior
 *    rule byte-exact. STRONGER than methods 1–3: there is no origin state to
 *    mis-restore, and the transport journal proves the client's domain is
 *    never contacted at all;
 *  - a failed write — including an honest 429 — leaves the row 'previewed'
 *    and the manifest untouched (retryable by re-running the SAME action); a
 *    429/credential failure/verification failure on the REVERT direction
 *    leaves the row 'applied' (never a false 'reverted' claim) — both
 *    directions pinned;
 *  - the QA-1 crash window holds THROUGH THIS ADAPTER: a store crash after
 *    the manifest write leaves the row 'previewed' while the manifest already
 *    holds the rule; the retry keeps the persisted before (null) as the
 *    rollback baseline (resumed_after_partial_apply) and rollback still
 *    removes the rule — restoring the true original (origin content, sans
 *    rule);
 *  - BATCH partial apply is reported exactly (applied prefix / failed member /
 *    not-attempted tail), a mid-batch 429 keeps row-status truth, the re-run
 *    continues (previouslyApplied) and the applied prefix rolls back
 *    member-by-member;
 *  - no credential ever reaches a persisted `site_changes` row;
 *  - the §4 onboarding no-op verify works — and names an HTML-interstitial
 *    front honestly.
 *
 * All HTTP is the injected FakeCloudflareKv — no network.
 */

import { describe, expect, it } from "vitest";
import {
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  steppingClock,
  type ChangePatch,
  type ChangeStore,
  type DesiredChange,
  type NewPreviewedChange,
  type TenantContext,
} from "@/lib/change-management";
import { VendorCredential, type SecretsResolver } from "@/lib/connectors";
import type { SiteChangeRow } from "@/lib/types/db";
import {
  MANIFEST_KEY,
  parseManifest,
} from "../../../../workers/edge-autofix/src/manifest";
import { isWriteMethodError } from "../shared/errors";
import { CloudflareEdgeAdapter, CLOUDFLARE_API_HOST } from "./adapter";
import { FakeCloudflareKv } from "./fake-cloudflare";
import { edgeLocators } from "./target";

const SECRET = "cf-api-token-4bCdEfGh5ecretT0ken";

const ACCOUNT_ID = "aabbccddeeff00112233445566778899";
const NAMESPACE_ID = "0123456789abcdef0123456789abcdef";

const CTX: TenantContext = {
  tenantId: "t1",
  actor: { id: "user-op", role: "operator" },
};
const APPROVAL = { approvedBy: "user-admin" };

const PATHS = ["/pricing", "/listings", "/about"] as const;
const NEW_TITLE = "Pricing | GG Realty";

/**
 * A ChangeStore wrapper whose next update() throws AFTER the underlying
 * store is left untouched — the DB-crash-mid-apply window (QA-1). Delegation
 * only; the real InMemoryChangeStore (with its CHECK/RLS emulation) does all
 * actual work.
 */
class CrashingStore implements ChangeStore {
  private failNextUpdate = false;
  constructor(private readonly inner: InMemoryChangeStore) {}
  crashOnNextUpdate(): void {
    this.failNextUpdate = true;
  }
  insertPreviewed(input: NewPreviewedChange, ctx: TenantContext) {
    return this.inner.insertPreviewed(input, ctx);
  }
  insertPreviewedBatch(inputs: NewPreviewedChange[], ctx: TenantContext) {
    return this.inner.insertPreviewedBatch(inputs, ctx);
  }
  getById(id: string, ctx: TenantContext) {
    return this.inner.getById(id, ctx);
  }
  update(
    id: string,
    patch: ChangePatch,
    ctx: TenantContext,
  ): Promise<SiteChangeRow> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("qa-1 window: database unavailable during row update");
    }
    return this.inner.update(id, patch, ctx);
  }
}

function setup() {
  const fake = new FakeCloudflareKv({
    apiToken: SECRET,
    accountId: ACCOUNT_ID,
    namespaceId: NAMESPACE_ID,
  });
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(SECRET),
  };
  const clock = steppingClock("2026-07-09T10:00:00.000Z");
  const adapter = new CloudflareEdgeAdapter({
    pin: {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "prop-1",
      accountId: ACCOUNT_ID,
      zoneId: "99887766554433221100ffeeddccbbaa",
      scriptName: "edge-autofix-ggrealty",
      namespaceId: NAMESPACE_ID,
    },
    secrets,
    authRef: "vault://cloudflare/prop-1",
    fetch: fake.port,
    clock,
  });
  const inner = new InMemoryChangeStore({ clock });
  const store = new CrashingStore(inner);
  const manager = new ChangeManager({
    store,
    adapters: new MapAdapterRegistry([adapter]),
    clock,
  });
  const manifest = () => {
    const text = fake.value(MANIFEST_KEY);
    return text === null ? null : parseManifest(text);
  };
  return { fake, manager, store, manifest, peek: (id: string) => inner.peek(id) };
}

function titleChange(after: string, before: string | null = null): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "edge_worker",
    changeType: "title",
    target: {
      url: "https://ggrealty.example/pricing",
      locator: edgeLocators.title(),
    },
    before,
    after,
  };
}

function jsonLdChange(path: (typeof PATHS)[number]): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "edge_worker",
    changeType: "schema",
    target: {
      url: `https://ggrealty.example${path}`,
      locator: edgeLocators.jsonLd("faq"),
    },
    before: null,
    after: { "@type": "FAQPage", about: path },
  };
}

describe("apply through the pipeline — rule-state before-capture", () => {
  it("captures the rule state (null — no rule yet), installs the rule verified byte-exact, persists both; NO request ever touches the client's domain", async () => {
    const { fake, manager, manifest } = setup();

    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    // PREVIEW writes nothing anywhere.
    expect(fake.requests).toHaveLength(0);

    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings).toEqual([]); // preview matched live rule state → no drift
    expect(outcome.change.status).toBe("applied");
    // The audit row: before = PRIOR RULE STATE (absent), after = the rule
    // value — never origin HTML, which this method does not modify.
    expect(outcome.change.diff).toEqual({
      before: null,
      after: NEW_TITLE,
      target: {
        url: "https://ggrealty.example/pricing",
        locator: "edge:title",
      },
    });

    // Authoritative manifest state: one enabled rule in the pinned slot.
    // (Rendered effect follows on the next request after ~60s KV propagation
    // — the applied_at caveat; MONITOR owns render-verification.)
    const stored = manifest()!;
    expect(stored.version).toBe(1);
    expect(stored.rules).toEqual([
      {
        id: "title@/pricing",
        enabled: true,
        path: "/pricing",
        op: "set_title",
        payload: { text: NEW_TITLE },
      },
    ]);

    // ORIGIN NEVER TOUCHED — at the transport level: every request in the
    // journal is to the pinned Cloudflare API host; the client's domain
    // appears in no URL.
    for (const req of fake.requests) {
      expect(req.url.startsWith(`${CLOUDFLARE_API_HOST}/`)).toBe(true);
      expect(req.url).not.toContain("ggrealty.example");
    }
  });

  it("leaves the row 'previewed' and the manifest untouched when the write fails — retryable, no silent half-state", async () => {
    const { fake, manager, manifest, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    fake.failNextWriteWith(500, 10000);

    await expect(manager.apply(preview.change.id, APPROVAL, CTX)).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "vendor_failure",
    );
    expect(manifest()).toBeNull();
    expect(peek(preview.change.id)?.status).toBe("previewed");

    const retry = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(manifest()!.rules).toHaveLength(1);
  });

  it("a 429 mid-apply is honest: rate_limited, row stays 'previewed', manifest untouched — and re-running the SAME action succeeds", async () => {
    const { fake, manager, manifest, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    fake.rateLimitNext(30);

    await expect(manager.apply(preview.change.id, APPROVAL, CTX)).rejects.toSatisfy(
      (err) =>
        isWriteMethodError(err) &&
        err.code === "rate_limited" &&
        err.retryAfterSeconds === 30,
    );
    expect(manifest()).toBeNull();
    expect(peek(preview.change.id)?.status).toBe("previewed");

    const retry = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
  });

  it("QA-1 crash window through this adapter: a store crash after the manifest write keeps the persisted before (null) as the rollback baseline on retry", async () => {
    const { manager, store, manifest, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);

    store.crashOnNextUpdate();
    await expect(
      manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrowError(/database unavailable/);
    // The documented ordering consequence: manifest written, row not updated.
    expect(manifest()!.rules[0].payload).toEqual({ text: NEW_TITLE });
    expect(peek(preview.change.id)?.status).toBe("previewed");

    // Retry: surfaced distinctly, baseline kept (null = no rule), never our
    // own after-value.
    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(outcome.change.diff.before).toBeNull();
    expect(outcome.change.diff.after).toBe(NEW_TITLE);

    // One-click rollback restores the TRUE original: no rule at all — the
    // untouched origin shows through.
    await manager.rollback(
      outcome.change.id,
      { reason: "operator: undo resumed change" },
      CTX,
    );
    expect(manifest()!.rules).toEqual([]);
    expect(peek(outcome.change.id)?.status).toBe("reverted");
  });
});

describe("rollback through the pipeline — stronger than methods 1–3", () => {
  it("reverting a first-ever rule REMOVES it (origin shows through); reverting an upsert-over-prior restores the prior rule byte-exact", async () => {
    const { manager, manifest } = setup();

    // Fix 1: install a title rule.
    const first = await manager.preview(titleChange("Title v1"), CTX);
    await manager.apply(first.change.id, APPROVAL, CTX);
    expect(manifest()!.rules[0].payload).toEqual({ text: "Title v1" });

    // Fix 2: upsert over it (before = the prior rule state, captured live).
    const second = await manager.preview(titleChange("Title v2", "Title v1"), CTX);
    const applied2 = await manager.apply(second.change.id, APPROVAL, CTX);
    expect(manifest()!.rules[0].payload).toEqual({ text: "Title v2" });

    // Rollback fix 2 → the PRIOR rule version is back, byte-exact (slot
    // versioning through before-capture — removal/restore is always exact).
    await manager.rollback(applied2.change.id, { reason: "undo v2" }, CTX);
    expect(manifest()!.rules[0].payload).toEqual({ text: "Title v1" });

    // Rollback fix 1 → no rule at all. The origin content was never touched
    // at any point, so "restore" is complete by construction.
    await manager.rollback(first.change.id, { reason: "undo v1" }, CTX);
    expect(manifest()!.rules).toEqual([]);
  });

  it("a 429 mid-revert is honest: rate_limited, the row STAYS 'applied' (never a false 'reverted'), the rule stays live — the same rollback completes later", async () => {
    const { fake, manager, manifest, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    fake.rateLimitNext(45);
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) =>
        isWriteMethodError(err) &&
        err.code === "rate_limited" &&
        err.retryAfterSeconds === 45,
    );
    expect(peek(applied.change.id)?.status).toBe("applied");
    expect(manifest()!.rules).toHaveLength(1);

    await manager.rollback(applied.change.id, { reason: "undo" }, CTX);
    expect(peek(applied.change.id)?.status).toBe("reverted");
    expect(manifest()!.rules).toEqual([]);
  });

  it("a token rotated mid-revert leaves the row 'applied' (never a false 'reverted' claim); reconnecting completes the rollback", async () => {
    const { fake, manager, manifest, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    fake.rotateToken("rotated-away");
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "credential_rejected",
    );
    expect(peek(applied.change.id)?.status).toBe("applied");
    expect(manifest()!.rules).toHaveLength(1);

    fake.rotateToken(SECRET);
    await manager.rollback(applied.change.id, { reason: "undo" }, CTX);
    expect(peek(applied.change.id)?.status).toBe("reverted");
  });

  it("a deleted namespace discovered at rollback time fails honestly (target_missing) and the row stays 'applied'", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    fake.deleteNamespace();
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "target_missing",
    );
    expect(peek(applied.change.id)?.status).toBe("applied");
  });

  it("a concurrent manifest writer during revert is write_verification_failed — the row stays 'applied', divergence is never silent", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    const foreignText = fake.value(MANIFEST_KEY)!; // any other-writer bytes
    fake.overwriteAfterNextPut(foreignText);
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "write_verification_failed",
    );
    // Honesty over tidiness: the row is NOT 'reverted' (the store was not
    // verified to hold the reverted manifest), and nothing pretended otherwise.
    expect(peek(applied.change.id)?.status).toBe("applied");
  });
});

describe("batch partial apply — exact reporting, continuation, prefix rollback", () => {
  it("a mid-batch 429 stops the batch with row-status truth; the re-run continues; the applied prefix rolls back", async () => {
    const { fake, manager, manifest, peek } = setup();
    const batch = await manager.previewBatch(
      [jsonLdChange(PATHS[0]), jsonLdChange(PATHS[1]), jsonLdChange(PATHS[2])],
      CTX,
    );
    // Member 2's manifest PUT (the 2nd PUT of the run) is rate-limited.
    fake.failPut(2, 429, 10015);

    const report = await manager.applyBatch(batch, APPROVAL, CTX);

    expect(report.complete).toBe(false);
    expect(report.applied.map((a) => a.change.id)).toEqual([
      batch.members[0].change.id,
    ]);
    expect(report.failed?.changeId).toBe(batch.members[1].change.id);
    const failedError = report.failed?.error;
    if (!isWriteMethodError(failedError)) {
      throw new Error("expected the failed member to carry a WriteMethodError");
    }
    expect(failedError.code).toBe("rate_limited");
    expect(report.notAttempted).toEqual([batch.members[2].change.id]);

    // Row-status truth: only the prefix reads 'applied'.
    expect(peek(batch.members[0].change.id)?.status).toBe("applied");
    expect(peek(batch.members[1].change.id)?.status).toBe("previewed");
    expect(peek(batch.members[2].change.id)?.status).toBe("previewed");
    // The manifest reflects exactly that: member 1's rule only.
    expect(manifest()!.rules.map((r) => r.path)).toEqual([PATHS[0]]);

    // Continuation: the SAME batch re-run after the window passes.
    const rerun = await manager.applyBatch(batch, APPROVAL, CTX);
    expect(rerun.complete).toBe(true);
    expect(rerun.previouslyApplied).toEqual([batch.members[0].change.id]);
    expect(rerun.applied.map((a) => a.change.id)).toEqual([
      batch.members[1].change.id,
      batch.members[2].change.id,
    ]);
    expect(manifest()!.rules.map((r) => r.path).sort()).toEqual(
      [...PATHS].sort(),
    );

    // The applied members are individually revertible, member-by-member.
    await manager.rollback(
      batch.members[0].change.id,
      { reason: "batch member 1 regressed" },
      CTX,
    );
    expect(manifest()!.rules.map((r) => r.path).sort()).toEqual(
      [PATHS[1], PATHS[2]].sort(),
    );
  });
});

describe("connection verify + credential containment at the pipeline level", () => {
  it("verifyConnection reads without writing (doc 04 §4 no-op check) — and proves token + namespace reachability", async () => {
    const { fake, manager } = setup();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "edge_worker",
        target: {
          url: "https://ggrealty.example/pricing",
          locator: edgeLocators.title(),
        },
      },
      CTX,
    );
    expect(result).toEqual({
      method: "edge_worker",
      ok: true,
      detail: "read access verified",
    });
    expect(fake.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
  });

  it("verifyConnection names an HTML-interstitial front honestly (and safely)", async () => {
    const { fake, manager } = setup();
    fake.simulateHtmlInterstitial();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "edge_worker",
        target: {
          url: "https://ggrealty.example/pricing",
          locator: edgeLocators.title(),
        },
      },
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTML page");
    expect(result.detail).not.toContain(SECRET);
  });

  it("no persisted site_changes row ever contains the credential", async () => {
    const { manager, peek } = setup();
    const preview = await manager.preview(titleChange(NEW_TITLE), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    await manager.rollback(applied.change.id, { reason: "leak sweep" }, CTX);

    const row = JSON.stringify(peek(preview.change.id));
    expect(row).not.toContain(SECRET);
  });
});
