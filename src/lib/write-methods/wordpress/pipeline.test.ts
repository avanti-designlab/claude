/**
 * WordPressAdapter driven by the REAL change-management pipeline (doc 04 §2)
 * — the integration proof the 1.3 gate cares about:
 *
 *  - APPLY captures the byte-exact LIVE before-state through readCurrent and
 *    persists it as `site_changes.diff.before` (with drift surfaced when the
 *    preview was stale);
 *  - ROLLBACK restores that captured before-state on the site, byte-exact,
 *    via the same adapter (one action, status → 'reverted');
 *  - a failed write leaves the row 'previewed' and the site untouched
 *    (retryable, never a silent half-state);
 *  - BATCH partial apply is reported exactly (applied prefix / failed member /
 *    not-attempted tail) and the applied prefix rolls back member-by-member;
 *  - no credential ever reaches a persisted `site_changes` row;
 *  - the §4 onboarding no-op verify works — and names a login-redirecting
 *    site honestly.
 *
 * All HTTP is the injected FakeWordPress — no network.
 */

import { describe, expect, it } from "vitest";
import {
  ChangeManager,
  InMemoryChangeStore,
  MapAdapterRegistry,
  steppingClock,
  type DesiredChange,
  type TenantContext,
} from "@/lib/change-management";
import { VendorCredential, type SecretsResolver } from "@/lib/connectors";
import { isWriteMethodError } from "../shared/errors";
import { WordPressAdapter } from "./adapter";
import { FakeWordPress } from "./fake-wp";
import { wordpressLocators } from "./target";

const SECRET = "gg-operator:AbCd EfGh IjKl MnOp";
const SECRET_B64 = Buffer.from(SECRET, "utf8").toString("base64");

const CTX: TenantContext = {
  tenantId: "t1",
  actor: { id: "user-op", role: "operator" },
};
const APPROVAL = { approvedBy: "user-admin" };

const ORIGINAL_TITLES: Record<number, string> = {
  1: "Homes for Sale in San Diego",
  2: "Condos in La Jolla",
  3: "Open Houses This Weekend",
};

function setup() {
  const fake = new FakeWordPress({
    credential: SECRET,
    posts: {
      1: { title: ORIGINAL_TITLES[1], content: "<p>Body one</p>" },
      2: { title: ORIGINAL_TITLES[2], content: "<p>Body two</p>" },
      3: { title: ORIGINAL_TITLES[3], content: "<p>Body three</p>" },
    },
  });
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(SECRET),
  };
  const adapter = new WordPressAdapter({
    site: {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "prop-1",
      baseUrl: "https://ggrealty.example",
    },
    secrets,
    authRef: "vault://wp/prop-1",
    fetch: fake.port,
  });
  const clock = steppingClock("2026-07-09T10:00:00.000Z");
  const store = new InMemoryChangeStore({ clock });
  const manager = new ChangeManager({
    store,
    adapters: new MapAdapterRegistry([adapter]),
    clock,
  });
  return { fake, manager, store };
}

function titleChange(postId: number, after: string, before?: string): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "wordpress",
    changeType: "title",
    target: {
      url: `https://ggrealty.example/listing-${postId}`,
      locator: wordpressLocators.postTitle(postId),
    },
    before: before ?? ORIGINAL_TITLES[postId],
    after,
  };
}

describe("apply through the pipeline — live before-capture", () => {
  it("captures the byte-exact live before-state, applies the after, and persists both in the audit row", async () => {
    const { fake, manager } = setup();
    const after = "San Diego Homes for Sale | GG Realty";

    const preview = await manager.preview(titleChange(1, after), CTX);
    // PREVIEW writes nothing to the site.
    expect(fake.requests).toHaveLength(0);

    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings).toEqual([]); // preview matched live → no drift
    expect(fake.post(1).title).toBe(after);
    // The audit row carries the byte-exact before + after + target — a
    // one-click rollback is executable from this row alone.
    expect(outcome.change.diff).toEqual({
      before: ORIGINAL_TITLES[1],
      after,
      target: {
        url: "https://ggrealty.example/listing-1",
        locator: "wp:post/1/title",
      },
    });
    expect(outcome.change.status).toBe("applied");
  });

  it("re-baselines rollback to the LIVE state when the preview was stale (drift surfaced, never swallowed)", async () => {
    const { fake, manager } = setup();
    // Previewed against a stale crawl value...
    const preview = await manager.preview(
      titleChange(1, "New Title", "A stale crawl title"),
      CTX,
    );
    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings.map((w) => w.code)).toEqual(["drift_detected"]);
    // ...but the persisted rollback baseline is the LIVE before-state.
    expect(outcome.change.diff.before).toBe(ORIGINAL_TITLES[1]);

    await manager.rollback(
      outcome.change.id,
      { reason: "operator: undo title test" },
      CTX,
    );
    expect(fake.post(1).title).toBe(ORIGINAL_TITLES[1]);
  });

  it("never adopts the change's OWN after-value as the rollback baseline (QA-1): resumed_after_partial_apply surfaced, persisted before kept, rollback restores the original", async () => {
    // The live site already shows the approved after-value at apply time —
    // either a prior apply crashed between the site write and the store
    // update (the documented retry path) or a third party set the identical
    // value; the two are indistinguishable. Re-baselining to the live read
    // here would persist diff.before === diff.after, erase the original
    // pre-change state from the audit row, and turn rollback into a verified
    // no-op. The pipeline must keep the persisted previewed before instead.
    const fake = new FakeWordPress({
      credential: SECRET,
      posts: { 1: { title: "New Title", content: "<p>Body one</p>" } },
    });
    const secrets: SecretsResolver = {
      resolve: async () => new VendorCredential(SECRET),
    };
    const adapter = new WordPressAdapter({
      site: {
        tenantId: "t1",
        clientId: "c1",
        propertyId: "prop-1",
        baseUrl: "https://ggrealty.example",
      },
      secrets,
      authRef: "vault://wp/prop-1",
      fetch: fake.port,
    });
    const clock = steppingClock("2026-07-09T10:00:00.000Z");
    const store = new InMemoryChangeStore({ clock });
    const manager = new ChangeManager({
      store,
      adapters: new MapAdapterRegistry([adapter]),
      clock,
    });

    // Previewed before = the true original; live already equals the after.
    const preview = await manager.preview(titleChange(1, "New Title"), CTX);
    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);

    // Surfaced explicitly — and distinctly from generic drift.
    expect(outcome.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(outcome.change.status).toBe("applied");
    // THE baseline contract: the original pre-change state, never our own after.
    expect(outcome.change.diff.before).toBe(ORIGINAL_TITLES[1]);
    expect(outcome.change.diff.after).toBe("New Title");
    expect(fake.post(1).title).toBe("New Title");

    // One-click rollback restores the pre-change state — reversibility held.
    await manager.rollback(
      outcome.change.id,
      { reason: "operator: undo resumed change" },
      CTX,
    );
    expect(fake.post(1).title).toBe(ORIGINAL_TITLES[1]);
  });

  it("leaves the row 'previewed' and the site untouched when the write fails — retryable, no silent half-state", async () => {
    const { fake, manager, store } = setup();
    const preview = await manager.preview(titleChange(1, "New Title"), CTX);
    fake.failNextWriteWith(500);

    await expect(manager.apply(preview.change.id, APPROVAL, CTX)).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "vendor_failure",
    );
    expect(fake.post(1).title).toBe(ORIGINAL_TITLES[1]);
    expect(store.peek(preview.change.id)?.status).toBe("previewed");

    // Retry succeeds against the same row.
    const retry = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(fake.post(1).title).toBe("New Title");
  });
});

describe("rollback through the pipeline — byte-exact restore, one action", () => {
  it("restores the captured before-state exactly (asserted against the capture, not the fixture)", async () => {
    const { fake, manager } = setup();
    const preview = await manager.preview(
      titleChange(1, "San Diego Homes for Sale | GG Realty"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    const capturedBefore = applied.change.diff.before;

    const reverted = await manager.rollback(
      applied.change.id,
      { reason: "operator: change regressed CTR" },
      CTX,
    );
    // Byte-exact: the site now holds EXACTLY the captured before-state.
    expect(fake.post(1).title).toBe(capturedBefore);
    expect(fake.post(1).title).toBe(ORIGINAL_TITLES[1]);
    expect(reverted.change.status).toBe("reverted");
    expect(reverted.change.reverted_reason).toBe("operator: change regressed CTR");

    // The revert traveled through the SAME adapter as the apply: two POSTs
    // to the same pinned wp/v2 route, second body = captured before.
    const posts = fake.requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts.map((p) => p.url)).toEqual([
      "https://ggrealty.example/wp-json/wp/v2/posts/1?context=edit",
      "https://ggrealty.example/wp-json/wp/v2/posts/1?context=edit",
    ]);
    expect(JSON.parse(posts[1].body ?? "")).toEqual({ title: capturedBefore });
  });

  it("a failed revert leaves the row 'applied' (never a false 'reverted' claim)", async () => {
    const { fake, manager, store } = setup();
    const preview = await manager.preview(titleChange(1, "New Title"), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    fake.failNextWriteWith(502, "bad_gateway");
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "vendor_failure",
    );
    expect(store.peek(applied.change.id)?.status).toBe("applied");
    expect(fake.post(1).title).toBe("New Title");

    // And the retry completes the rollback.
    await manager.rollback(applied.change.id, { reason: "undo" }, CTX);
    expect(fake.post(1).title).toBe(ORIGINAL_TITLES[1]);
  });
});

describe("batch partial apply — exact reporting, prefix rollback", () => {
  it("stops at the failed member, reports applied/failed/not-attempted exactly, and the applied prefix rolls back", async () => {
    const { fake, manager } = setup();
    const batch = await manager.previewBatch(
      [
        titleChange(1, "One | GG Realty"),
        titleChange(2, "Two | GG Realty"),
        titleChange(3, "Three | GG Realty"),
      ],
      CTX,
    );
    // Member 2's post vanishes between preview and apply (deleted on the site).
    fake.remove("posts", 2);

    const report = await manager.applyBatch(batch, APPROVAL, CTX);

    // EXACT partial-apply accounting: the pipeline knows precisely which ops hit the site.
    expect(report.complete).toBe(false);
    expect(report.applied.map((a) => a.change.id)).toEqual([
      batch.members[0].change.id,
    ]);
    expect(report.failed?.changeId).toBe(batch.members[1].change.id);
    const failedError = report.failed?.error;
    if (!isWriteMethodError(failedError)) {
      throw new Error("expected the failed member to carry a WriteMethodError");
    }
    expect(failedError.code).toBe("target_missing");
    expect(report.notAttempted).toEqual([batch.members[2].change.id]);

    // The site reflects exactly that: member 1 applied, member 3 untouched
    // (not even a request), member 2 unwritable.
    expect(fake.post(1).title).toBe("One | GG Realty");
    expect(fake.post(3).title).toBe(ORIGINAL_TITLES[3]);
    expect(fake.requests.some((r) => r.url.includes("/posts/3"))).toBe(false);

    // The applied prefix is individually revertible — change management rolls
    // it back through the same adapter, byte-exact.
    await manager.rollback(
      batch.members[0].change.id,
      { reason: "batch partially failed — reverting applied prefix" },
      CTX,
    );
    expect(fake.post(1).title).toBe(ORIGINAL_TITLES[1]);
  });
});

describe("connection verify + credential containment at the pipeline level", () => {
  it("verifyConnection reads without writing (doc 04 §4 no-op check)", async () => {
    const { fake, manager } = setup();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "wordpress",
        target: {
          url: "https://ggrealty.example/listing-1",
          locator: wordpressLocators.postTitle(1),
        },
      },
      CTX,
    );
    expect(result).toEqual({
      method: "wordpress",
      ok: true,
      detail: "read access verified",
    });
    expect(fake.requests.filter((r) => r.method === "POST")).toHaveLength(0);
  });

  it("verifyConnection names a login-redirecting site honestly (and safely)", async () => {
    const { fake, manager } = setup();
    fake.simulateLoginRedirect();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "wordpress",
        target: {
          url: "https://ggrealty.example/listing-1",
          locator: wordpressLocators.postTitle(1),
        },
      },
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTML page instead of a REST response");
    expect(result.detail).not.toContain(SECRET);
  });

  it("no persisted site_changes row ever contains the credential (raw or base64)", async () => {
    const { manager, store } = setup();
    const preview = await manager.preview(titleChange(1, "New Title"), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    await manager.rollback(applied.change.id, { reason: "leak sweep" }, CTX);

    const row = JSON.stringify(store.peek(preview.change.id));
    expect(row).not.toContain(SECRET);
    expect(row).not.toContain(SECRET_B64);
  });
});
