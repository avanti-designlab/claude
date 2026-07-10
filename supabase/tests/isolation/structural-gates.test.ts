/**
 * F1 isolation suite — STRUCTURAL GATES (contract §4, §5, §6; doc 00 §7.3).
 *
 * These invariants live BELOW RLS: CHECK constraints and composite foreign
 * keys that hold even for the superuser (RLS-bypassing) connection. If any of
 * these can be bypassed, isolation/governance is breakable regardless of
 * policies. Run as `db.admin` (superuser): RLS is bypassed, so ONLY the
 * structural guards are under test.
 *
 *  - content_items cannot reach approved/published without BOTH review verdicts.
 *  - NO site_change can leave `previewed` without a recorded approver
 *    (contract §6: no automation-level exemption exists); lifecycle
 *    timestamps are enforced.
 *  - automation_level rejects unknown values, and 'auto' is structurally
 *    impossible on site_changes (doc 00 §2, CLAUDE.md rule 5) while remaining
 *    valid on the non-publishing carriers (tasks, content_items).
 *  - composite FKs forbid pointing a row at another tenant's — or another
 *    client's — parent, even for the superuser.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupIsolationDb, type IsolationDb } from "../helpers/harness";
import {
  seedSiblingClientRows,
  seedTenantPair,
  type SeededTenant,
  type SiblingClientRows,
} from "../helpers/seed";

let db: IsolationDb;
let a: SeededTenant;
let b: SeededTenant;
let sibA: SiblingClientRows;

beforeAll(async () => {
  db = await setupIsolationDb();
  ({ a, b } = await seedTenantPair(db.admin));
  // A sibling client under tenant A — gives a same-tenant/other-client plan for
  // the composite-FK "same client, not just same tenant" assertion.
  sibA = await seedSiblingClientRows(db.admin, a);
});

afterAll(async () => {
  await db?.teardown();
});

async function expectRejected(
  sql: string,
  params: unknown[],
  pattern: RegExp
): Promise<void> {
  await expect(db.admin.query(sql, params)).rejects.toThrow(pattern);
}

describe("content_items review gate — no approval/publish without BOTH verdicts (doc 00 §7.3)", () => {
  // A named approver ($4 = a.operatorUserId) is supplied on every case so the
  // ONLY constraint that can block is the REVIEW gate — the strengthened 0009
  // approver requirement (content_items_approver_present) is proven separately.
  const bothNull =
    `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, approved_by, status`;
  const approver = (t: SeededTenant) => [t.tenantId, t.clientId, t.brandKitId, t.operatorUserId];

  it("INSERT status='approved' with NO verdicts is rejected", async () => {
    await expectRejected(
      `${bothNull}) values ($1, $2, 'blog', $3, 'x', $4, 'approved')`,
      approver(a),
      /content_items_reviewed_before_approval/
    );
  });

  it("INSERT status='published' with NO verdicts is rejected", async () => {
    await expectRejected(
      `${bothNull}) values ($1, $2, 'blog', $3, 'x', $4, 'published')`,
      approver(a),
      /content_items_reviewed_before_approval/
    );
  });

  it("INSERT status='approved' with ONLY quality_review is rejected", async () => {
    await expectRejected(
      `${bothNull}, quality_review) values ($1, $2, 'blog', $3, 'x', $4, 'approved', '{}'::jsonb)`,
      approver(a),
      /content_items_reviewed_before_approval/
    );
  });

  it("INSERT status='approved' with ONLY compliance_review is rejected", async () => {
    await expectRejected(
      `${bothNull}, compliance_review) values ($1, $2, 'blog', $3, 'x', $4, 'approved', '{}'::jsonb)`,
      approver(a),
      /content_items_reviewed_before_approval/
    );
  });

  it("UPDATE draft → approved without verdicts is rejected", async () => {
    await expectRejected(
      `update content_items set status = 'approved', approved_by = $2 where id = $1`,
      [a.contentItemId, a.operatorUserId],
      /content_items_reviewed_before_approval/
    );
  });

  it("positive: approved with PASSING, hash-bound verdicts + humanization + a named approver succeeds (0009)", async () => {
    // The strengthened gate (migration 0009) needs more than verdict PRESENCE:
    // both verdicts must be passed:true AND record the row's exact body_hash,
    // machine prose needs humanization.passes:true, and a named human approver
    // must be recorded. app.content_body_hash(body, title) yields the same hash
    // the INSERT trigger computes, so the embedded verdict hashes match.
    const res = await db.admin.query(
      `${bothNull}, quality_review, compliance_review, humanization)
       values ($1, $2, 'blog', $3, 'x', $4, 'approved',
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('x', null)),
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('x', null)),
         '{"passes": true}'::jsonb)`,
      approver(a)
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("content_items STRENGTHENED approval gate (migration 0009)", () => {
  // A passing, hash-bound verdict pair for a given body/title — the raw jsonb a
  // legitimate approve writes. Hash is computed by the SAME DB function the
  // trigger uses, so it matches the stored body_hash exactly.
  const verdict = (passed: boolean, body: string, title: string | null = null) =>
    passed
      ? `jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('${body}', ${title === null ? "null" : `'${title}'`}))`
      : `jsonb_build_object('passed', false, 'body_hash', app.content_body_hash('${body}', ${title === null ? "null" : `'${title}'`}))`;

  const approve = (extraCols: string, extraVals: string, type = "blog") =>
    `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status${extraCols})
     values ($1, $2, '${type}', $3, 'x', 'approved'${extraVals})`;

  it("needs_revision is a valid status and is NOT subject to the approval gate", async () => {
    const res = await db.admin.query(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status)
       values ($1, $2, 'blog', $3, 'x', 'needs_revision')`,
      [a.tenantId, a.clientId, a.brandKitId]
    );
    expect(res.rowCount).toBe(1);
  });

  it("approved with a verdict PRESENT but passed:false is rejected (presence is not enough)", async () => {
    await expectRejected(
      approve(
        `, quality_review, compliance_review, humanization, approved_by`,
        `, ${verdict(false, "x")}, ${verdict(true, "x")}, '{"passes":true}'::jsonb, $4`
      ),
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId],
      /content_items_reviewed_before_approval/
    );
  });

  it("approved with a verdict recording the WRONG body_hash is rejected (binding)", async () => {
    await expectRejected(
      approve(
        `, quality_review, compliance_review, humanization, approved_by`,
        `, jsonb_build_object('passed', true, 'body_hash', 'deadbeef'), ${verdict(true, "x")}, '{"passes":true}'::jsonb, $4`
      ),
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId],
      /content_items_reviewed_before_approval/
    );
  });

  it("approved blog with humanization.passes NOT true is rejected (machine-prose humanization)", async () => {
    await expectRejected(
      approve(
        `, quality_review, compliance_review, humanization, approved_by`,
        `, ${verdict(true, "x")}, ${verdict(true, "x")}, '{"passes":false}'::jsonb, $4`
      ),
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId],
      /content_items_reviewed_before_approval/
    );
  });

  it("approved with passing hash-bound verdicts + humanization but NO approver is rejected (approver_present)", async () => {
    await expectRejected(
      approve(
        `, quality_review, compliance_review, humanization`,
        `, ${verdict(true, "x")}, ${verdict(true, "x")}, '{"passes":true}'::jsonb`
      ),
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_approver_present/
    );
  });

  it("EXEMPTION: schema_copy is approved with NO humanization (verdicts + approver still required)", async () => {
    const res = await db.admin.query(
      approve(
        `, quality_review, compliance_review, approved_by`,
        `, ${verdict(true, "x")}, ${verdict(true, "x")}, $4`,
        "schema_copy"
      ),
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId]
    );
    expect(res.rowCount).toBe(1);
  });

  it("EXEMPTION: automation_level='human_only' blog is approved with NO humanization", async () => {
    const res = await db.admin.query(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level, status, quality_review, compliance_review, approved_by)
       values ($1, $2, 'blog', $3, 'x', 'human_only', 'approved', ${verdict(true, "x")}, ${verdict(true, "x")}, $4)`,
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId]
    );
    expect(res.rowCount).toBe(1);
  });

  it("body_hash BINDING: a body edit on an approved row is rejected until it is demoted (demote-before-edit)", async () => {
    // Approve a fresh row, then attempt to mutate the body while still approved.
    const ins = await db.admin.query<{ id: string }>(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'bound-body', 'approved',
         ${verdict(true, "bound-body")}, ${verdict(true, "bound-body")},
         '{"passes":true}'::jsonb, $4) returning id`,
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId]
    );
    const id = ins.rows[0].id;

    // Illegal: change the body while status stays 'approved' — the trigger
    // recomputes body_hash, the verdicts' recorded hash no longer matches.
    await expectRejected(
      `update content_items set body = 'tampered' where id = $1`,
      [id],
      /content_items_reviewed_before_approval/
    );
    // Legal: demote + edit in one statement (needs_revision is not gated).
    const demoted = await db.admin.query(
      `update content_items set status = 'needs_revision', body = 'revised' where id = $1`,
      [id]
    );
    expect(demoted.rowCount).toBe(1);
  });

  it("body_hash BINDING: a TITLE edit on an approved row is likewise rejected until demoted", async () => {
    const ins = await db.admin.query<{ id: string }>(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, title, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'body-t', 'Original Title', 'approved',
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('body-t', 'Original Title')),
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('body-t', 'Original Title')),
         '{"passes":true}'::jsonb, $4) returning id`,
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId]
    );
    await expectRejected(
      `update content_items set title = 'Changed Title' where id = $1`,
      [ins.rows[0].id],
      /content_items_reviewed_before_approval/
    );
  });

  it("title is capped at 200 characters", async () => {
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, title)
       values ($1, $2, 'blog', $3, 'x', repeat('t', 201))`,
      [a.tenantId, a.clientId, a.brandKitId],
      /content_items_title_len/
    );
  });

  it("approved requires a SAME-TENANT approver (composite FK on approved_by)", async () => {
    await expectRejected(
      approve(
        `, quality_review, compliance_review, humanization, approved_by`,
        `, ${verdict(true, "x")}, ${verdict(true, "x")}, '{"passes":true}'::jsonb, $4`
      ),
      [a.tenantId, a.clientId, a.brandKitId, b.operatorUserId],
      /foreign key constraint/
    );
  });
});

describe("content_items approval-gate containment hardening (migration 0009 — QA gate)", () => {
  // The body_hash binding is this batch's CORE structural invariant: "a
  // post-verdict body/title edit invalidates the verdicts". These pin the
  // CORRECT contract — a verdict without a REAL, type-exact, hash-bound object
  // must NOT satisfy the approval gate.
  //
  // HISTORY (QA finding + remediation, 2026-07-10): the original CHECK mixed
  // NULL-safe `IS TRUE` legs with a NULL-propagating `quality_review ->>
  // 'body_hash' = body_hash` leg. Because a Postgres CHECK passes on TRUE **or
  // NULL** (only FALSE fails), a verdict that OMITTED body_hash (or set it JSON
  // null) made that leg NULL, the whole gate NULL, and the CHECK PASSED —
  // defeating demote-before-edit end-to-end (an approved row with a hashless
  // verdict could then mutate its body while still 'approved'), reachable by any
  // is_writer via the data API. It also text-cast `::boolean`, so a JSON string
  // "true" counted as passed. The architect remediated it to `is not null`
  // presence conjuncts + jsonb CONTAINMENT (`@>`), which is two-valued and
  // type-exact by construction. These tests are now GREEN because the constraint
  // REJECTS each shape (the test bodies are unchanged from when they were the RED
  // regression) — they are the standing guard against a regression.
  const approver = () => [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId];

  it("approve with verdicts that OMIT the body_hash key is rejected (an absent hash is not a bound hash)", async () => {
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'orig', 'approved',
         '{"passed": true}'::jsonb, '{"passed": true}'::jsonb, '{"passes": true}'::jsonb, $4)`,
      approver(),
      /content_items_reviewed_before_approval/
    );
  });

  it("approve with body_hash set to JSON null is rejected (null is not a bound hash)", async () => {
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'nv', 'approved',
         '{"passed": true, "body_hash": null}'::jsonb,
         '{"passed": true, "body_hash": null}'::jsonb, '{"passes": true}'::jsonb, $4)`,
      approver(),
      /content_items_reviewed_before_approval/
    );
  });

  it("a STRING-typed passed:'true' (not a JSON boolean) does NOT satisfy the gate", async () => {
    // The gate requires `passed` = JSON boolean true (TYPE-STRICT, via jsonb
    // containment). A JSON string "true" (and "yes"/"t"/"1"/"on") is a different
    // jsonb value, so `@>` yields FALSE and the DB rejects it. The batch's TS
    // mirror (transitions.test.ts) asserts the same. (Pre-remediation this INSERT
    // was ACCEPTED because the CHECK text-cast `::boolean`.)
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'st', 'approved',
         jsonb_build_object('passed', 'true', 'body_hash', app.content_body_hash('st', null)),
         jsonb_build_object('passed', 'true', 'body_hash', app.content_body_hash('st', null)),
         '{"passes": true}'::jsonb, $4)`,
      approver(),
      /content_items_reviewed_before_approval/
    );
  });

  it("an ARRAY-typed verdict jsonb (wrapping a CORRECT inner object) does NOT satisfy the gate", async () => {
    // The containment CHECK builds an OBJECT rhs (jsonb_build_object). jsonb `@>`
    // with an array LHS against an object RHS is FALSE (probed: the
    // primitive-in-array exception applies only to a scalar RHS, never an
    // object) — and the 0005 `content_items_quality_review_is_object` constraint
    // rejects a non-object verdict first. Defense in depth: an array verdict can
    // never reach 'approved', even with a byte-correct inner hash.
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'arr', 'approved',
         jsonb_build_array(jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('arr', null))),
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('arr', null)),
         '{"passes": true}'::jsonb, $4)`,
      approver(),
      /content_items_quality_review_is_object|content_items_reviewed_before_approval/
    );
  });

  it("an ARRAY-typed humanization jsonb does NOT satisfy the gate", async () => {
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'arrh', 'approved',
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('arrh', null)),
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('arrh', null)),
         '[{"passes": true}]'::jsonb, $4)`,
      approver(),
      /content_items_humanization_is_object|content_items_reviewed_before_approval/
    );
  });

  it("a NON-boolean passed (nested object) does NOT satisfy the gate (containment is type-exact)", async () => {
    // passed as {"x": true} is not the JSON boolean true — containment is exact,
    // so the approval CHECK itself rejects it (the verdict IS an object, so no
    // is_object guard applies here — the rejection comes from the gate).
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, status, quality_review, compliance_review, humanization, approved_by)
       values ($1, $2, 'blog', $3, 'nst', 'approved',
         jsonb_build_object('passed', jsonb_build_object('x', true), 'body_hash', app.content_body_hash('nst', null)),
         jsonb_build_object('passed', true, 'body_hash', app.content_body_hash('nst', null)),
         '{"passes": true}'::jsonb, $4)`,
      approver(),
      /content_items_reviewed_before_approval/
    );
  });
});

describe("competitors + runs structural gates (migrations 0010 / 0011)", () => {
  it("competitors names are case-insensitive-unique per client", async () => {
    await db.admin.query(
      `insert into competitors (tenant_id, client_id, name) values ($1, $2, 'Acme Corp')`,
      [a.tenantId, a.clientId]
    );
    await expectRejected(
      `insert into competitors (tenant_id, client_id, name) values ($1, $2, 'ACME CORP')`,
      [a.tenantId, a.clientId],
      /competitors_client_name_key/
    );
  });

  it("a competitor cannot point at another tenant's client (composite FK)", async () => {
    // tenant A, but client_id belongs to tenant B — the (tenant_id, client_id)
    // composite FK has no matching parent row.
    await expectRejected(
      `insert into competitors (tenant_id, client_id, name) values ($1, $2, 'Cross')`,
      [a.tenantId, b.clientId],
      /foreign key constraint/
    );
  });

  it("runs.error_code is a closed enum and only allowed on a failed run", async () => {
    // Bad enum value — rejected outright.
    await expectRejected(
      `insert into runs (tenant_id, client_id, kind, status, error_code) values ($1, $2, 'audit', 'failed', 'raw stack trace')`,
      [a.tenantId, a.clientId],
      /runs_error_code_allowed/
    );
    // Valid code but non-failed status — rejected (no failure signal off a failed row).
    await expectRejected(
      `insert into runs (tenant_id, client_id, kind, status, error_code) values ($1, $2, 'audit', 'queued', 'engine_error')`,
      [a.tenantId, a.clientId],
      /runs_error_code_only_on_failed/
    );
  });

  it("a property-scoped run cannot target another client's property (composite FK)", async () => {
    await expectRejected(
      `insert into runs (tenant_id, client_id, property_id, kind) values ($1, $2, $3, 'audit')`,
      [a.tenantId, a.clientId, sibA.propertyId],
      /foreign key constraint/
    );
  });

  it("a run cannot target another TENANT's property (composite FK — tenant B property on a tenant-A run)", async () => {
    // tenant A run, but property_id belongs to tenant B — the
    // (tenant_id, client_id, property_id) composite FK has no matching parent.
    await expectRejected(
      `insert into runs (tenant_id, client_id, property_id, kind) values ($1, $2, $3, 'audit')`,
      [a.tenantId, a.clientId, b.propertyId],
      /runs_property_fk|foreign key constraint/
    );
  });

  it("a run cannot record another tenant's user as requested_by (composite FK on the work-order actor)", async () => {
    await expectRejected(
      `insert into runs (tenant_id, client_id, kind, requested_by) values ($1, $2, 'audit', $3)`,
      [a.tenantId, a.clientId, b.operatorUserId],
      /runs_requested_by_fk|foreign key constraint/
    );
  });

  it("positive: a client-scoped run (property_id NULL) of every kind is valid", async () => {
    const res = await db.admin.query(
      `insert into runs (tenant_id, client_id, kind) values ($1, $2, 'visibility')`,
      [a.tenantId, a.clientId]
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("site_changes approval + lifecycle gates (contract §6; doc 03 §3)", () => {
  const base =
    `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, automation_level, status, approved_by, applied_at)`;
  const diff = `'{"before":"a","after":"b"}'::jsonb`;

  it("ai_draft_human_approve change cannot go 'applied' without an approver", async () => {
    await expectRejected(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'ai_draft_human_approve', 'applied', null, now())`,
      [a.tenantId, a.clientId, a.propertyId],
      /site_changes_requires_approval/
    );
  });

  it("human_only change cannot go 'applied' without an approver", async () => {
    await expectRejected(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'human_only', 'applied', null, now())`,
      [a.tenantId, a.clientId, a.propertyId],
      /site_changes_requires_approval/
    );
  });

  it("'applied' without an applied_at timestamp is rejected (lifecycle integrity)", async () => {
    // Approver recorded and automation_level valid, so the ONLY violated
    // constraint is the timestamp gate — the assertion is deterministic.
    await expectRejected(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'ai_draft_human_approve', 'applied', $4, null)`,
      [a.tenantId, a.clientId, a.propertyId, a.operatorUserId],
      /site_changes_applied_has_timestamp/
    );
  });

  it("positive: a change with a recorded approver may go 'applied'", async () => {
    const res = await db.admin.query(
      `${base} values ($1, $2, $3, 'wordpress', 'title', ${diff}, 'ai_draft_human_approve', 'applied', $4, now())`,
      [a.tenantId, a.clientId, a.propertyId, a.operatorUserId]
    );
    expect(res.rowCount).toBe(1);
  });
});

describe("'auto' is structurally impossible on site_changes (doc 00 §2, CLAUDE.md rule 5; contract §6)", () => {
  // Inverse of the pre-remediation exemption: fully autonomous on-page
  // publishing can no longer even be REPRESENTED on this table.
  const insertCols =
    `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, automation_level)`;
  const diff = `'{"before":"a","after":"b"}'::jsonb`;

  it("INSERT with automation_level='auto' is rejected by site_changes_automation_level_allowed", async () => {
    // status stays at the 'previewed' default, so the ONLY violated
    // constraint is the automation-level CHECK — deterministic assertion.
    await expectRejected(
      `${insertCols} values ($1, $2, $3, 'edge_worker', 'schema', ${diff}, 'auto')`,
      [a.tenantId, a.clientId, a.propertyId],
      /site_changes_automation_level_allowed/
    );
  });

  it("UPDATE of an existing site_change to automation_level='auto' is rejected", async () => {
    await expectRejected(
      `update site_changes set automation_level = 'auto' where id = $1`,
      [a.siteChangeId],
      /site_changes_automation_level_allowed/
    );
  });

  it("'auto' remains VALID on tasks and content_items (non-publishing carriers, contract §6)", async () => {
    const task = await db.admin.query(
      `insert into tasks (tenant_id, client_id, plan_id, module, automation_level)
       values ($1, $2, $3, 'rank_tracking', 'auto')`,
      [a.tenantId, a.clientId, a.planId]
    );
    expect(task.rowCount).toBe(1);
    const content = await db.admin.query(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level)
       values ($1, $2, 'blog', $3, 'x', 'auto')`,
      [a.tenantId, a.clientId, a.brandKitId]
    );
    expect(content.rowCount).toBe(1);
  });

  it("an 'auto' content_item still cannot reach 'published' without BOTH review verdicts", async () => {
    // 'auto' never shortcuts the review gate (contract §6). A named approver is
    // supplied so the ONLY constraint that can block these is the review gate
    // (0009 also requires approved_by — content_items_approver_present — which
    // is proven separately). No verdicts…
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level, status, approved_by)
       values ($1, $2, 'blog', $3, 'x', 'auto', 'published', $4)`,
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId],
      /content_items_reviewed_before_approval/
    );
    // …and ONE present-but-not-passing verdict is not enough either.
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level, status, quality_review, approved_by)
       values ($1, $2, 'blog', $3, 'x', 'auto', 'published', '{}'::jsonb, $4)`,
      [a.tenantId, a.clientId, a.brandKitId, a.operatorUserId],
      /content_items_reviewed_before_approval/
    );
  });
});

describe("tasks 'done' status requires human_only (migration 0013)", () => {
  // The honest completion word is fenced to GENUINE human work: 'done' is legal
  // ONLY on automation_level='human_only'. A machine-owned (auto) or pipeline
  // (ai_draft_human_approve) task can never be 'done' — approved/published stay
  // the load-bearing audit terminals. Enforced by tasks_done_is_human_only on
  // BOTH the INSERT and UPDATE routes (the F1 automation-CHECK precedent), below
  // RLS, holding even for the superuser. No transition trigger exists (ruled
  // unwarranted) — this coupling is the whole structural story.

  it("INSERT status='done' on a default (ai_draft_human_approve) task is rejected", async () => {
    // No automation_level given → column default 'ai_draft_human_approve'. The
    // status enum accepts 'done', so the ONLY constraint that can block is the
    // coupling — deterministic assertion.
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module, status)
       values ($1, $2, $3, 'audit', 'done')`,
      [a.tenantId, a.clientId, a.planId],
      /tasks_done_is_human_only/
    );
  });

  it("INSERT status='done' on an 'auto' task is rejected", async () => {
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module, automation_level, status)
       values ($1, $2, $3, 'rank_tracking', 'auto', 'done')`,
      [a.tenantId, a.clientId, a.planId],
      /tasks_done_is_human_only/
    );
  });

  it("UPDATE an ai_draft_human_approve task to 'done' is rejected", async () => {
    // The seeded a.taskId is a default (ai_draft_human_approve) task in 'todo'.
    await expectRejected(
      `update tasks set status = 'done' where id = $1`,
      [a.taskId],
      /tasks_done_is_human_only/
    );
  });

  it("UPDATE an 'auto' task to 'done' is rejected", async () => {
    const ins = await db.admin.query<{ id: string }>(
      `insert into tasks (tenant_id, client_id, plan_id, module, automation_level)
       values ($1, $2, $3, 'rank_tracking', 'auto') returning id`,
      [a.tenantId, a.clientId, a.planId]
    );
    await expectRejected(
      `update tasks set status = 'done' where id = $1`,
      [ins.rows[0].id],
      /tasks_done_is_human_only/
    );
  });

  it("positive: INSERT a human_only task directly as 'done' succeeds", async () => {
    const res = await db.admin.query(
      `insert into tasks (tenant_id, client_id, plan_id, module, automation_level, status)
       values ($1, $2, $3, 'strategy', 'human_only', 'done')`,
      [a.tenantId, a.clientId, a.planId]
    );
    expect(res.rowCount).toBe(1);
  });

  it("positive: UPDATE a human_only task to 'done' (and reopen it) succeeds — reversible", async () => {
    const ins = await db.admin.query<{ id: string }>(
      `insert into tasks (tenant_id, client_id, plan_id, module, automation_level, status)
       values ($1, $2, $3, 'compliance_signoff', 'human_only', 'in_progress') returning id`,
      [a.tenantId, a.clientId, a.planId]
    );
    const id = ins.rows[0].id;
    const done = await db.admin.query(
      `update tasks set status = 'done' where id = $1`,
      [id]
    );
    expect(done.rowCount).toBe(1);
    // Reversible work-tracking: done → in_progress ("Reopen") is a plain update.
    const reopened = await db.admin.query(
      `update tasks set status = 'in_progress' where id = $1`,
      [id]
    );
    expect(reopened.rowCount).toBe(1);
  });
});

describe("automation_level CHECK rejects unknown values (contract §6)", () => {
  // params built lazily (inside each test) — `a` is populated only by beforeAll.
  const cases: {
    table: string;
    sql: string;
    params: () => unknown[];
    constraint: RegExp;
  }[] = [
    {
      table: "tasks",
      sql: `insert into tasks (tenant_id, client_id, plan_id, module, automation_level) values ($1, $2, $3, 'audit', 'yolo')`,
      params: () => [a.tenantId, a.clientId, a.planId],
      constraint: /tasks_automation_level_allowed/,
    },
    {
      table: "content_items",
      sql: `insert into content_items (tenant_id, client_id, type, brand_kit_id, body, automation_level) values ($1, $2, 'blog', $3, 'x', 'yolo')`,
      params: () => [a.tenantId, a.clientId, a.brandKitId],
      constraint: /content_items_automation_level_allowed/,
    },
    {
      table: "site_changes",
      sql: `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, automation_level) values ($1, $2, $3, 'wordpress', 'title', '{"before":"a","after":"b"}'::jsonb, 'yolo')`,
      params: () => [a.tenantId, a.clientId, a.propertyId],
      constraint: /site_changes_automation_level_allowed/,
    },
  ];
  for (const c of cases) {
    it(`${c.table}: automation_level='yolo' is rejected`, async () => {
      await expectRejected(c.sql, c.params(), c.constraint);
    });
  }
});

describe("composite FKs — tenant/client consistency holds even for the superuser", () => {
  it("tenant-A task cannot point at tenant-B's plan", async () => {
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module) values ($1, $2, $3, 'audit')`,
      [a.tenantId, a.clientId, b.planId],
      /foreign key constraint/
    );
  });

  it("tenant-A task cannot point at a SAME-TENANT but different-client plan", async () => {
    // Three-column FK (tenant_id, client_id, plan_id): the plan must belong to
    // the SAME client, not merely the same tenant.
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module) values ($1, $2, $3, 'audit')`,
      [a.tenantId, a.clientId, sibA.planId],
      /foreign key constraint/
    );
  });

  it("tenant-A content_item cannot point at tenant-B's brand_kit", async () => {
    await expectRejected(
      `insert into content_items (tenant_id, client_id, type, brand_kit_id, body) values ($1, $2, 'blog', $3, 'x')`,
      [a.tenantId, a.clientId, b.brandKitId],
      /foreign key constraint/
    );
  });

  it("tenant-A site_change cannot point at tenant-B's property", async () => {
    await expectRejected(
      `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff) values ($1, $2, $3, 'wordpress', 'title', '{"before":"a","after":"b"}'::jsonb)`,
      [a.tenantId, a.clientId, b.propertyId],
      /foreign key constraint/
    );
  });

  it("tenant-A site_change cannot record a tenant-B user as applied_by (audit-trail actor)", async () => {
    await expectRejected(
      `insert into site_changes (tenant_id, client_id, property_id, method, change_type, diff, applied_by) values ($1, $2, $3, 'wordpress', 'title', '{"before":"a","after":"b"}'::jsonb, $4)`,
      [a.tenantId, a.clientId, a.propertyId, b.operatorUserId],
      /foreign key constraint/
    );
  });

  it("tenant-A task cannot be assigned to a tenant-B user", async () => {
    await expectRejected(
      `insert into tasks (tenant_id, client_id, plan_id, module, assigned_to) values ($1, $2, $3, 'audit', $4)`,
      [a.tenantId, a.clientId, a.planId, b.operatorUserId],
      /foreign key constraint/
    );
  });
});
