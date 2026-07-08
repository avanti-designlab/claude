/**
 * State-machine tests: the layer's legal transitions are a superset-safe SUBSET
 * of the site_changes CHECK constraints (migration 0005). Proves the layer can
 * never attempt an illegal transition, and never composes a row Postgres would
 * reject.
 */

import { describe, expect, it } from "vitest";
import type { SiteChangeRow, SiteChangeStatus } from "@/lib/types/db";
import { ConstraintViolationError, IllegalTransitionError } from "./errors";
import {
  LEGAL_TRANSITIONS,
  assertLegalTransition,
  assertRowSatisfiesConstraints,
  isLegalTransition,
} from "./status-machine";

const ALL: SiteChangeStatus[] = [
  "previewed",
  "applied",
  "reverted",
  "auto_reverted",
];

function row(overrides: Partial<SiteChangeRow>): SiteChangeRow {
  return {
    id: "sc-1",
    tenant_id: "t1",
    client_id: "c1",
    property_id: "p1",
    method: "wordpress",
    change_type: "title",
    automation_level: "ai_draft_human_approve",
    diff: { before: "a", after: "b" },
    applied_by: null,
    approved_by: null,
    status: "previewed",
    reverted_reason: null,
    applied_at: null,
    reverted_at: null,
    created_at: "2026-07-08T00:00:00.000Z",
    updated_at: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("LEGAL_TRANSITIONS graph", () => {
  it("permits exactly the safe edges and no others", () => {
    // preview may only advance to applied (or record approval in place).
    expect(isLegalTransition("previewed", "applied")).toBe(true);
    expect(isLegalTransition("previewed", "previewed")).toBe(true);
    // applied may only be reverted, manually or automatically.
    expect(isLegalTransition("applied", "reverted")).toBe(true);
    expect(isLegalTransition("applied", "auto_reverted")).toBe(true);
    // never applied ⇒ never reverted (nothing to undo).
    expect(isLegalTransition("previewed", "reverted")).toBe(false);
    expect(isLegalTransition("previewed", "auto_reverted")).toBe(false);
    // no re-apply, no un-revert; terminal states are terminal.
    expect(isLegalTransition("applied", "applied")).toBe(false);
    expect(isLegalTransition("reverted", "applied")).toBe(false);
    expect(isLegalTransition("auto_reverted", "applied")).toBe(false);
  });

  it("terminal states have no outgoing edges", () => {
    expect(LEGAL_TRANSITIONS.reverted).toHaveLength(0);
    expect(LEGAL_TRANSITIONS.auto_reverted).toHaveLength(0);
  });

  it("assertLegalTransition throws IllegalTransitionError on every illegal edge", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        if (isLegalTransition(from, to)) {
          expect(() => assertLegalTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertLegalTransition(from, to)).toThrow(
            IllegalTransitionError,
          );
        }
      }
    }
  });
});

describe("assertRowSatisfiesConstraints mirrors the DB CHECKs", () => {
  it("accepts a valid previewed row (no approver / timestamps needed)", () => {
    expect(() => assertRowSatisfiesConstraints(row({}))).not.toThrow();
  });

  it("rejects automation_level 'auto' — autonomous publishing is impossible here", () => {
    expect(() =>
      assertRowSatisfiesConstraints(
        row({ automation_level: "auto" as never }),
      ),
    ).toThrow(ConstraintViolationError);
  });

  it("applied requires BOTH approved_by and applied_at", () => {
    expect(() =>
      assertRowSatisfiesConstraints(
        row({ status: "applied", applied_at: "2026-07-08T00:00:01.000Z" }),
      ),
    ).toThrow(/requires approved_by/);
    expect(() =>
      assertRowSatisfiesConstraints(
        row({ status: "applied", approved_by: "u-1" }),
      ),
    ).toThrow(/requires applied_at/);
    expect(() =>
      assertRowSatisfiesConstraints(
        row({
          status: "applied",
          approved_by: "u-1",
          applied_at: "2026-07-08T00:00:01.000Z",
        }),
      ),
    ).not.toThrow();
  });

  it("reverted / auto_reverted additionally require reverted_at", () => {
    for (const status of ["reverted", "auto_reverted"] as const) {
      expect(() =>
        assertRowSatisfiesConstraints(
          row({
            status,
            approved_by: "u-1",
            applied_at: "2026-07-08T00:00:01.000Z",
          }),
        ),
      ).toThrow(/requires reverted_at/);
      expect(() =>
        assertRowSatisfiesConstraints(
          row({
            status,
            approved_by: "u-1",
            applied_at: "2026-07-08T00:00:01.000Z",
            reverted_at: "2026-07-08T00:00:02.000Z",
          }),
        ),
      ).not.toThrow();
    }
  });
});
