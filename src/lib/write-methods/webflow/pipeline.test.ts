/**
 * WebflowAdapter driven by the REAL change-management pipeline (doc 04 §2)
 * — the integration proof the 1.3 gate cares about:
 *
 *  - APPLY captures the byte-exact live STAGED before-state through
 *    readCurrent and persists it as `site_changes.diff.before`; the write is
 *    staged-only — the PUBLISHED site is byte-untouched by apply AND rollback
 *    (going live stays with the pipeline's explicit publish flow);
 *  - ROLLBACK restores that captured before-state on the site, byte-exact,
 *    via the same adapter (one action, status → 'reverted');
 *  - a failed write — including an honest 429 — leaves the row 'previewed'
 *    and the site untouched (retryable by re-running the SAME action, which
 *    is exactly what the rate_limited contract documents);
 *  - rollback under adversity: a token rotated mid-revert and a
 *    server-normalized restore both leave the row 'applied' (never a false
 *    'reverted' claim, never silent divergence);
 *  - BATCH partial apply is reported exactly (applied prefix / failed member /
 *    not-attempted tail) and the applied prefix rolls back member-by-member;
 *  - no credential ever reaches a persisted `site_changes` row;
 *  - the §4 onboarding no-op verify works — and names an HTML-interstitial
 *    site honestly.
 *
 * All HTTP is the injected FakeWebflow — no network.
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
import { WebflowAdapter } from "./adapter";
import { FakeWebflow } from "./fake-webflow";
import { webflowLocators } from "./target";

const SECRET = "wf-pat-4bCdEfGh.5ecret.T0ken";
const SECRET_B64 = Buffer.from(SECRET, "utf8").toString("base64");

const wfid = (tail: string) => tail.padStart(24, "0");
const SITE_ID = wfid("c0ffee");
const PAGE_ID = wfid("9a9e1");
const COLLECTION_ID = wfid("c011");
const ITEM_IDS = [wfid("17e1"), wfid("17e2"), wfid("17e3")] as const;

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

function setup() {
  const fake = new FakeWebflow({
    token: SECRET,
    siteId: SITE_ID,
    pages: {
      [PAGE_ID]: {
        name: "Listings",
        seo: { title: ORIGINAL_SEO_TITLE, description: "Old description" },
      },
    },
    collections: {
      [COLLECTION_ID]: {
        fields: ["summary"],
        items: Object.fromEntries(
          ITEM_IDS.map((id, i) => [
            id,
            { name: `Casa ${i + 1}`, slug: `casa-${i + 1}`, summary: ORIGINAL_SUMMARIES[id] },
          ]),
        ),
      },
    },
  });
  const secrets: SecretsResolver = {
    resolve: async () => new VendorCredential(SECRET),
  };
  const adapter = new WebflowAdapter({
    site: {
      tenantId: "t1",
      clientId: "c1",
      propertyId: "prop-1",
      siteId: SITE_ID,
    },
    secrets,
    authRef: "vault://webflow/prop-1",
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

function seoTitleChange(after: string, before?: string): DesiredChange {
  return {
    tenantId: "t1",
    clientId: "c1",
    propertyId: "prop-1",
    method: "webflow",
    changeType: "title",
    target: {
      url: "https://ggrealty.example/listings",
      locator: webflowLocators.pageSeoTitle(PAGE_ID),
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
    method: "webflow",
    changeType: "content",
    target: {
      url: `https://ggrealty.example/listing/${itemId}`,
      locator: webflowLocators.itemField(COLLECTION_ID, itemId, "summary"),
    },
    before: ORIGINAL_SUMMARIES[itemId],
    after,
  };
}

describe("apply through the pipeline — live before-capture, staged-only writes", () => {
  it("captures the byte-exact staged before-state, applies the after, persists both — and the PUBLISHED site is byte-untouched", async () => {
    const { fake, manager } = setup();
    const after = "San Diego Homes for Sale | GG Realty";

    const preview = await manager.preview(seoTitleChange(after), CTX);
    // PREVIEW writes nothing to the site.
    expect(fake.requests).toHaveLength(0);

    const outcome = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(outcome.warnings).toEqual([]); // preview matched live → no drift
    // STAGED holds the change...
    expect(fake.page(PAGE_ID).seo.title).toBe(after);
    // ...while the LIVE (published) site is byte-identical to before the
    // apply, and no publish/live endpoint was ever called: this method never
    // publishes — going live is the pipeline's explicit publish flow.
    expect(fake.livePage(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    for (const req of fake.requests) {
      expect(req.url).not.toContain("publish");
      expect(req.url).not.toMatch(/\/live(\?|$)/);
    }
    // The audit row carries the byte-exact before + after + target — a
    // one-click rollback is executable from this row alone.
    expect(outcome.change.diff).toEqual({
      before: ORIGINAL_SEO_TITLE,
      after,
      target: {
        url: "https://ggrealty.example/listings",
        locator: `webflow:page/${PAGE_ID}/seo.title`,
      },
    });
    expect(outcome.change.status).toBe("applied");
  });

  it("leaves the row 'previewed' and the site untouched when the write fails — retryable, no silent half-state", async () => {
    const { fake, manager, store } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    fake.failNextWriteWith(500);

    await expect(manager.apply(preview.change.id, APPROVAL, CTX)).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "vendor_failure",
    );
    expect(fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    expect(store.peek(preview.change.id)?.status).toBe("previewed");

    // Retry succeeds against the same row.
    const retry = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(fake.page(PAGE_ID).seo.title).toBe("New Title");
  });

  it("a 429 mid-apply is honest: rate_limited, row stays 'previewed', site untouched — and re-running the SAME action succeeds", async () => {
    const { fake, manager, store } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    fake.rateLimitNext(30);

    await expect(manager.apply(preview.change.id, APPROVAL, CTX)).rejects.toSatisfy(
      (err) =>
        isWriteMethodError(err) &&
        err.code === "rate_limited" &&
        err.retryAfterSeconds === 30,
    );
    // The operation was NOT performed — exactly what the contract documents.
    expect(fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    expect(store.peek(preview.change.id)?.status).toBe("previewed");

    // The retry contract: the same action, re-run — nothing retried itself.
    const retry = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(retry.change.status).toBe("applied");
    expect(fake.page(PAGE_ID).seo.title).toBe("New Title");
  });
});

describe("rollback through the pipeline — byte-exact restore, one action", () => {
  it("restores the captured before-state exactly via the same adapter; live site untouched throughout", async () => {
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
    // Byte-exact: the STAGED site now holds EXACTLY the captured before-state.
    expect(fake.page(PAGE_ID).seo.title).toBe(capturedBefore);
    expect(fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    // The published site never moved in either direction.
    expect(fake.livePage(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    expect(reverted.change.status).toBe("reverted");
    expect(reverted.change.reverted_reason).toBe("operator: change regressed CTR");

    // The revert traveled through the SAME adapter as the apply: two PATCHes
    // to the same pinned route, second body = captured before.
    const patches = fake.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect(patches.map((p) => p.url)).toEqual([
      `https://api.webflow.com/v2/pages/${PAGE_ID}`,
      `https://api.webflow.com/v2/pages/${PAGE_ID}`,
    ]);
    expect(JSON.parse(patches[1].body ?? "")).toEqual({
      seo: { title: capturedBefore },
    });
  });

  it("a token rotated mid-revert leaves the row 'applied' (never a false 'reverted' claim); reconnecting completes the rollback", async () => {
    const { fake, manager, store } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);

    // The client rotates/revokes the API token between apply and rollback.
    fake.rotateToken("wf-pat-rotated-away");
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "credential_rejected",
    );
    expect(store.peek(applied.change.id)?.status).toBe("applied");
    expect(fake.page(PAGE_ID).seo.title).toBe("New Title");

    // Property reconnected (token valid again) → the retry completes it.
    fake.rotateToken(SECRET);
    await manager.rollback(applied.change.id, { reason: "undo" }, CTX);
    expect(fake.page(PAGE_ID).seo.title).toBe(ORIGINAL_SEO_TITLE);
    expect(store.peek(applied.change.id)?.status).toBe("reverted");
  });

  it("a deleted item discovered at rollback time fails honestly (target_missing) and the row stays 'applied'", async () => {
    const { fake, manager, store } = setup();
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
    expect(store.peek(applied.change.id)?.status).toBe("applied");
  });

  it("a server-normalized restore is reported write_verification_failed — the row stays 'applied', divergence is never silent", async () => {
    const { fake, manager, store } = setup();
    const preview = await manager.preview(
      summaryChange(ITEM_IDS[0], "New tight summary"),
      CTX,
    );
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    expect(fake.item(COLLECTION_ID, ITEM_IDS[0]).summary).toBe("New tight summary");

    // Between apply and rollback the vendor starts normalizing writes (the
    // slug-normalization class); the captured before-state has double spaces,
    // so the restore comes back altered.
    fake.mutateWrites((v) => v.replace(/\s+/g, " "));
    await expect(
      manager.rollback(applied.change.id, { reason: "undo" }, CTX),
    ).rejects.toSatisfy(
      (err) => isWriteMethodError(err) && err.code === "write_verification_failed",
    );
    // Honesty over tidiness: the row is NOT 'reverted' (the site does not
    // hold the captured before-state — it holds the normalized variant), and
    // nothing pretended otherwise.
    expect(store.peek(applied.change.id)?.status).toBe("applied");
    expect(fake.item(COLLECTION_ID, ITEM_IDS[0]).summary).toBe(
      "Casa Uno: a summary with odd spacing",
    );
  });
});

describe("batch partial apply — exact reporting, prefix rollback", () => {
  it("stops at the failed member, reports applied/failed/not-attempted exactly, and the applied prefix rolls back", async () => {
    const { fake, manager } = setup();
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

    // The site reflects exactly that: member 1 applied, member 3 untouched
    // (not even a request naming it), member 2 unwritable.
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
    // And the published items never moved at any point.
    for (const id of ITEM_IDS) {
      expect(fake.liveItem(COLLECTION_ID, id).summary).toBe(ORIGINAL_SUMMARIES[id]);
    }
  });
});

describe("connection verify + credential containment at the pipeline level", () => {
  it("verifyConnection reads without writing (doc 04 §4 no-op check)", async () => {
    const { fake, manager } = setup();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "webflow",
        target: {
          url: "https://ggrealty.example/listings",
          locator: webflowLocators.pageSeoTitle(PAGE_ID),
        },
      },
      CTX,
    );
    expect(result).toEqual({
      method: "webflow",
      ok: true,
      detail: "read access verified",
    });
    expect(fake.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });

  it("verifyConnection names an HTML-interstitial site honestly (and safely)", async () => {
    const { fake, manager } = setup();
    fake.simulateHtmlInterstitial();
    const result = await manager.verifyConnection(
      {
        clientId: "c1",
        propertyId: "prop-1",
        method: "webflow",
        target: {
          url: "https://ggrealty.example/listings",
          locator: webflowLocators.pageSeoTitle(PAGE_ID),
        },
      },
      CTX,
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("HTML page instead of an API response");
    expect(result.detail).not.toContain(SECRET);
  });

  it("no persisted site_changes row ever contains the credential (raw or base64)", async () => {
    const { manager, store } = setup();
    const preview = await manager.preview(seoTitleChange("New Title"), CTX);
    const applied = await manager.apply(preview.change.id, APPROVAL, CTX);
    await manager.rollback(applied.change.id, { reason: "leak sweep" }, CTX);

    const row = JSON.stringify(store.peek(preview.change.id));
    expect(row).not.toContain(SECRET);
    expect(row).not.toContain(SECRET_B64);
  });
});
