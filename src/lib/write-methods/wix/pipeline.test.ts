/**
 * WixAdapter driven by the REAL change-management pipeline (doc 04 §2)
 * — the integration proof the 1.3 gate cares about:
 *
 *  - APPLY captures the byte-exact LIVE before-state through readCurrent and
 *    persists it as `site_changes.diff.before`; the write is LIVE-IMMEDIATE —
 *    Wix has no staged layer, so the live site holds the after-value the
 *    moment apply returns, which is exactly why `applied_at` is a SOUND
 *    correlation timestamp for MONITOR on this method (unlike Webflow);
 *  - ROLLBACK restores that captured before-state on the site, byte-exact,
 *    via the same adapter (one action, status → 'reverted') — with no publish
 *    gate in front of the live site, before-capture + verified revert is the
 *    entire safety story, and these tests treat it that way;
 *  - a failed write — including an honest 429 — leaves the row 'previewed'
 *    and the site untouched (retryable by re-running the SAME action); a 429
 *    on the REVERT direction leaves the row 'applied' (never a false
 *    'reverted' claim) — both directions pinned;
 *  - the QA-1 crash window holds THROUGH THIS ADAPTER: a store crash after
 *    the site write leaves the row 'previewed' while the LIVE site already
 *    shows the after; the retry keeps the persisted before as the rollback
 *    baseline (resumed_after_partial_apply) and rollback still restores the
 *    true original;
 *  - rollback under adversity: a key rotated mid-revert and a
 *    server-normalized restore both leave the row 'applied' (never a false
 *    'reverted' claim, never silent divergence);
 *  - BATCH partial apply is reported exactly (applied prefix / failed member /
 *    not-attempted tail) and the applied prefix rolls back member-by-member;
 *  - no credential ever reaches a persisted `site_changes` row;
 *  - the §4 onboarding no-op verify works — and names an HTML-interstitial
 *    site honestly.
 *
 * All HTTP is the injected FakeWix — no network.
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
import { isWriteMethodError } from "../shared/errors";
import { WixAdapter } from "./adapter";
import { FakeWix } from "./fake-wix";
import { wixLocators } from "./target";

const SECRET = "IST.wix-api-key.4bCdEfGh.5ecretT0ken";
const SECRET_B64 = Buffer.from(SECRET, "utf8").toString("base64");

const SITE_ID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
const PAGE_ID = "c1dmp";
const COLLECTION_ID = "Listings";
const ITEM_IDS = [
  "11111111-aaaa-4bbb-8ccc-dddddddddd01",
  "11111111-aaaa-4bbb-8ccc-dddddddddd02",
  "11111111-aaaa-4bbb-8ccc-dddddddddd03",
] as const;

const CTX: TenantContext = {
  tenantId: "t1",
  actor: { id: "user-op", role: "operator" },
};
const APPROVAL = { approvedBy: "user-admin" };

const ORIGINAL_SEO_TITLE = "Homes for Sale in San Diego";
const ORIGINAL_SUMMARIES: Record<string, string> = {
  [ITEM_IDS[0]]: "Casa Uno:  a summary with  odd spacing", // double spaces — the normalization-adversity fixture
  [ITEM_IDS[1]]: "Casa Dos summary",
  [ITEM_IDS[2]]: "Casa Tres summary",
};

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
  const fake = new FakeWix({
    apiKey: SECRET,
    siteId: SITE_ID,
    pages: {
      [PAGE_ID]: {
        name: "Listings",
        seoData: { title: ORIGINAL_SEO_TITLE, description: "Old description" },
      },
    },
    collections: {
      [COLLECTION_ID]: {
        items: Object.fromEntries(
          ITEM_IDS.map((id, i) => [
            id,
            { name: `Casa ${i + 1}`, summary: ORIGINAL_SUMMARIES[id] },
          ]),
        ),
      },
    },
  });
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(SECRET),
  };
  const adapter = new WixAdapter({
    site: {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "prop-1",
      siteId: SITE_ID,
    },
    secrets,
    authRef: "vault://wix/prop-1",
    fetch: fake.port,
  });
  const clock = steppingClock("2026-07-09T10:00:00.000Z");
  const inner = new InMemoryChangeStore({ clock });
  const store = new CrashingStore(inner);
  const manager = new ChangeManager({
    store,
    adapters: new MapAdapterRegistry([adapter]),
    clock,
  });
  return { fake, manager, store, peek: (id: string) => inner.peek(id) };
}

function seoTitleChange(after: string, before?: string): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "wix",
    changeType: "title",
    target: {
      url: "https://ggrealty.example/listings",
      locator: wixLocators.pageSeoTitle(PAGE_ID),
    },
    before: before ?? ORIGINAL_SEO_TITLE,
    after,
  };
}

function summaryChange(itemId: string, after: string): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "wix",
    changeType: "content",
    target: {
      url: `https://ggrealty.example/listing/${itemId}`,
      locator: wixLocators.dataField(COLLECTION_ID, itemId, "summary"),
    },
    before: ORIGINAL_SUMMARIES[itemId],
    after,
  };
}

describe("apply through the pipeline — live before-capture, live-immediate writes", () => {
  it("captures the byte-exact live before-state, applies the after, persists both — and the LIVE site holds the change the moment apply returns", async () => {
    const { fake, manager } = setup();
    const after = "San Diego Homes for Sale | GG Realty";

    const preview = await manager.preview(seoTitleChange(after), CTX);
    // PREVIEW writes nothing to the site.
    expect(fake.requests).toHaveLength(0);

    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings).toEqual([]); // preview matched live → no drift
    // LIVE-IMMEDIATE: there is no staged layer between this assertion and the
    // client's visitors — what the fake holds now is what the site serves.
    // MONITOR correlation against applied_at is sound for exactly this reason.
    expect(fake.page(PAGE_ID).seoData.title).toBe(after);
    // The audit row carries the byte-exact before + after + target — a
    // one-click rollback is executable from this row alone.
    expect(outcome.change.diff).toEqual({
      before: ORIGINAL_SEO_TITLE,
      after,
      target: {
        url: "https://ggrealty.example/listings",
        locator: `wix:page/${PAGE_ID}/seo.title`,
      },
    });
    expect(outcome.change.status).toBe("applied");
  });

  it("leaves the row 'previewed' and the site untouched when the write fails — retryable, no silent half-state", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    fake.failNextWriteWith(500);

    await expect(manager.apply(preview.change.id, APPROVAL, CTX)).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "vendor_failure",
    );
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
    expect(peek(preview.change.id)?.status).toBe("previewed");

    // Retry succeeds against the same row.
    const retry = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(fake.page(PAGE_ID).seoData.title).toBe("New Title");
  });

  it("a 429 mid-apply is honest: rate_limited, row stays 'previewed', site untouched — and re-running the SAME action succeeds", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    fake.rateLimitNext(30);

    await expect(manager.apply(preview.change.id, APPROVAL, CTX)).rejects.toSatisfy(
      (err) =>
        isWriteMethodError(err) &&
        err.code === "rate_limited" &&
        err.retryAfterSeconds === 30,
    );
    // The operation was NOT performed — exactly what the contract documents.
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
    expect(peek(preview.change.id)?.status).toBe("previewed");

    // The retry contract: the same action, re-run — nothing retried itself.
    const retry = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(fake.page(PAGE_ID).seoData.title).toBe("New Title");
  });

  it("QA-1 crash window through this adapter: a store crash after the LIVE site write keeps the persisted before as the rollback baseline on retry", async () => {
    // On a live-immediate method this window matters MORE than anywhere else:
    // between the crash and the retry, the LIVE site is already serving the
    // after-value while the row still reads 'previewed'. The retry's live
    // re-read equals this change's own after — the manager must keep the
    // persisted previewed before (never adopt our own half-applied write as
    // the baseline), or rollback becomes a verified no-op.
    const { fake, manager, store, peek } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);

    store.crashOnNextUpdate();
    await expect(
      manager.apply(preview.change.id, APPROVAL, CTX),
    ).rejects.toThrowError(/database unavailable/);
    // The documented ordering consequence: site written, row not yet updated.
    expect(fake.page(PAGE_ID).seoData.title).toBe("New Title");
    expect(peek(preview.change.id)?.status).toBe("previewed");

    // Retry: surfaced distinctly, baseline kept, never our own after-value.
    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings.map((w) => w.code)).toEqual([
      "resumed_after_partial_apply",
    ]);
    expect(outcome.change.status).toBe("applied");
    expect(outcome.change.diff.before).toBe(ORIGINAL_SEO_TITLE);
    expect(outcome.change.diff.after).toBe("New Title");

    // One-click rollback restores the TRUE pre-change state on the live site.
    await manager.rollback(
      outcome.change.id,
      { reason: "operator: undo resumed change" },
      CTX,
    );
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
    expect(peek(outcome.change.id)?.status).toBe("reverted");
  });
});

describe("rollback through the pipeline — byte-exact restore, one action", () => {
  it("restores the captured before-state exactly via the same adapter", async () => {
    const { fake, manager } = setup();
    const preview = await manager.preview(
      seoTitleChange("San Diego Homes for Sale | GG Realty"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    const capturedBefore = applied.change.diff.before;

    const reverted = await manager.rollback(
      applied.change.id,
      { reason: "operator: change regressed CTR" },
      CTX,
    );
    // Byte-exact: the LIVE site now holds EXACTLY the captured before-state.
    expect(fake.page(PAGE_ID).seoData.title).toBe(capturedBefore);
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
    expect(reverted.change.status).toBe("reverted");
    expect(reverted.change.reverted_reason).toBe("operator: change regressed CTR");

    // The revert traveled through the SAME adapter as the apply: two PATCHes
    // to the same pinned route, second body = captured before.
    const patches = fake.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches.map((p) => p.url)).toEqual([
      `https://www.wixapis.com/site-pages/v1/pages/${PAGE_ID}`,
      `https://www.wixapis.com/site-pages/v1/pages/${PAGE_ID}`,
    ]);
    expect(JSON.parse(patches[1].body ?? "")).toEqual({
      page: { seoData: { title: capturedBefore } },
    });
  });

  it("a 429 mid-revert is honest: rate_limited, the row STAYS 'applied' (never a false 'reverted'), the live site keeps the after — the same rollback completes later", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
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
    // Row-status truth on the revert direction: the revert did NOT happen.
    expect(peek(applied.change.id)?.status).toBe("applied");
    expect(fake.page(PAGE_ID).seoData.title).toBe("New Title");

    // Window passes → the same one-click action completes.
    await manager.rollback(applied.change.id, { reason: "undo" }, CTX);
    expect(peek(applied.change.id)?.status).toBe("reverted");
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
  });

  it("a key rotated mid-revert leaves the row 'applied' (never a false 'reverted' claim); reconnecting completes the rollback", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    // The account rotates/revokes the API key between apply and rollback.
    fake.rotateKey("IST.rotated-away");
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "credential_rejected",
    );
    expect(peek(applied.change.id)?.status).toBe("applied");
    expect(fake.page(PAGE_ID).seoData.title).toBe("New Title");

    // Property reconnected (key valid again) → the retry completes it.
    fake.rotateKey(SECRET);
    await manager.rollback(applied.change.id, { reason: "undo" }, CTX);
    expect(fake.page(PAGE_ID).seoData.title).toBe(ORIGINAL_SEO_TITLE);
    expect(peek(applied.change.id)?.status).toBe("reverted");
  });

  it("a deleted item discovered at rollback time fails honestly (target_missing) and the row stays 'applied'", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(
      summaryChange(ITEM_IDS[1], "New summary"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    fake.removeItem(COLLECTION_ID, ITEM_IDS[1]);
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "target_missing",
    );
    expect(peek(applied.change.id)?.status).toBe("applied");
  });

  it("a server-normalized restore is reported write_verification_failed — the row stays 'applied', divergence is never silent", async () => {
    const { fake, manager, peek } = setup();
    const preview = await manager.preview(
      summaryChange(ITEM_IDS[0], "New tight summary"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(fake.item(COLLECTION_ID, ITEM_IDS[0]).summary).toBe("New tight summary");

    // Between apply and rollback the vendor starts normalizing writes; the
    // captured before-state has double spaces, so the restore comes back
    // altered — on the LIVE site, which is why it must never be silent.
    fake.mutateWrites((v) => v.replace(/\s+/g, " "));
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "write_verification_failed",
    );
    // Honesty over tidiness: the row is NOT 'reverted' (the site does not
    // hold the captured before-state — it holds the normalized variant), and
    // nothing pretended otherwise.
    expect(peek(applied.change.id)?.status).toBe("applied");
    expect(fake.item(COLLECTION_ID, ITEM_IDS[0]).summary).toBe(
      "Casa Uno: a summary with odd spacing",
    );
  });
});

describe("batch partial apply — exact reporting, prefix rollback", () => {
  it("stops at the failed member, reports applied/failed/not-attempted exactly, and the applied prefix rolls back", async () => {
    const { fake, manager, peek } = setup();
    const batch = await manager.previewBatch(
      [
        summaryChange(ITEM_IDS[0], "One | GG Realty"),
        summaryChange(ITEM_IDS[1], "Two | GG Realty"),
        summaryChange(ITEM_IDS[2], "Three | GG Realty"),
      ],
      CTX,
    );
    // Member 2's item vanishes between preview and apply (deleted on the site).
    fake.removeItem(COLLECTION_ID, ITEM_IDS[1]);

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

    // Row-status truth: only the prefix reads 'applied'; the failed member
    // and the never-attempted tail stay 'previewed' (retryable).
    expect(peek(batch.members[0].change.id)?.status).toBe("applied");
    expect(peek(batch.members[1].change.id)?.status).toBe("previewed");
    expect(peek(batch.members[2].change.id)?.status).toBe("previewed");

    // The LIVE site reflects exactly that: member 1 applied, member 3
    // untouched (not even a request naming it), member 2 unwritable.
    expect(fake.item(COLLECTION_ID, ITEM_IDS[0]).summary).toBe("One | GG Realty");
    expect(fake.item(COLLECTION_ID, ITEM_IDS[2]).summary).toBe(
      ORIGINAL_SUMMARIES[ITEM_IDS[2]],
    );
    expect(fake.requests.some((r) => r.url.includes(ITEM_IDS[2]))).toBe(false);

    // The applied prefix is individually revertible — change management rolls
    // it back through the same adapter, byte-exact.
    await manager.rollback(
      batch.members[0].change.id,
      { reason: "batch partially failed — reverting applied prefix" },
      CTX,
    );
    expect(fake.item(COLLECTION_ID, ITEM_IDS[0]).summary).toBe(
      ORIGINAL_SUMMARIES[ITEM_IDS[0]],
    );
  });
});

describe("connection verify + credential containment at the pipeline level", () => {
  it("verifyConnection reads without writing (doc 04 §4 no-op check)", async () => {
    const { fake, manager } = setup();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "wix",
        target: {
          url: "https://ggrealty.example/listings",
          locator: wixLocators.pageSeoTitle(PAGE_ID),
        },
      },
      CTX,
    );
    expect(result).toEqual({
      method: "wix",
      ok: true,
      detail: "read access verified",
    });
    expect(
      fake.requests.filter((r) => r.method === "PATCH" || r.method === "PUT"),
    ).toHaveLength(0);
  });

  it("verifyConnection names an HTML-interstitial site honestly (and safely)", async () => {
    const { fake, manager } = setup();
    fake.simulateHtmlInterstitial();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "wix",
        target: {
          url: "https://ggrealty.example/listings",
          locator: wixLocators.pageSeoTitle(PAGE_ID),
        },
      },
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTML page instead of an API response");
    expect(result.detail).not.toContain(SECRET);
  });

  it("no persisted site_changes row ever contains the credential (raw or base64)", async () => {
    const { manager, peek } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    await manager.rollback(applied.change.id, { reason: "leak sweep" }, CTX);

    const row = JSON.stringify(peek(preview.change.id));
    expect(row).not.toContain(SECRET);
    expect(row).not.toContain(SECRET_B64);
  });
});
