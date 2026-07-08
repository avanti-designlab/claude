/**
 * Structural no-bypass tripwire (doc 04 §2 non-negotiable: "no write to a
 * client site may bypass the change-management layer").
 *
 * The layer's write safety is enforced by construction:
 *  - the ONLY things that can touch a client site are WriteMethodAdapter
 *    implementations, and the ChangeManager holds them privately — `apply`
 *    and `rollback` accept only change IDs minted by `preview`, so no adapter
 *    write can happen without a persisted `site_changes` row;
 *  - REAL write-method adapters (WordPress / Webflow / Wix / edge worker, 1.3)
 *    must be registered inside the composition root and must NEVER be exported
 *    from this package. The only adapter exported today is the
 *    RecordingWriteAdapter test stub, which writes to its own in-memory Map
 *    and cannot reach any real site.
 *
 * This suite pins the package's runtime export surface. If ANY new runtime
 * export appears — especially anything shaped like a WriteMethodAdapter — the
 * suite fails and the addition becomes a conscious, reviewed decision at the
 * 1.2/1.3 gates instead of silent drift.
 */

import { describe, expect, it } from "vitest";
import * as changeManagement from "./index";

/** Every RUNTIME export of the public surface (types vanish at runtime). */
const EXPECTED_RUNTIME_EXPORTS = [
  // pipeline
  "ChangeManager",
  // errors (typed refusals)
  "ChangeManagementError",
  "AuthorizationError",
  "AutomationLevelError",
  "ApprovalRequiredError",
  "IllegalTransitionError",
  "ConstraintViolationError",
  "TenantScopeError",
  "ChangeNotFoundError",
  "MethodNotRegisteredError",
  "RollbackReasonRequiredError",
  // state machine
  "LEGAL_TRANSITIONS",
  "isLegalTransition",
  "assertLegalTransition",
  "assertRowSatisfiesConstraints",
  // seam guards
  "WRITER_ROLES",
  "isWriter",
  "assertWriter",
  "resolveWriteAutomationLevel",
  "assertTenantMatch",
  "assertRowInScope",
  "DEFAULT_SITE_CHANGE_AUTOMATION_LEVEL",
  // monitor / auto-rollback (pure evaluation)
  "MONITORED_METRICS",
  "DEFAULT_AUTO_ROLLBACK_POLICY",
  "isBreach",
  "evaluateBreaches",
  "describeBreach",
  "autoRollbackReason",
  // diff + json helpers
  "buildStructuredDiff",
  "toLines",
  "jsonEqual",
  // clocks
  "systemClock",
  "fixedClock",
  "steppingClock",
  // test stubs (in-memory only — cannot reach a real site)
  "InMemoryChangeStore",
  "RecordingWriteAdapter",
  "MapAdapterRegistry",
].sort();

function runtimeExports(): string[] {
  return Object.keys(changeManagement).sort();
}

describe("change-management public surface (no-bypass tripwire)", () => {
  it("exports exactly the reviewed surface — nothing more, nothing less", () => {
    expect(runtimeExports()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it("exports no adapter-shaped value except the in-memory test stub", () => {
    const adapterShaped = Object.entries(changeManagement).filter(
      ([, value]) => {
        const proto =
          typeof value === "function" ? value.prototype : undefined;
        if (!proto) return false;
        return (
          typeof proto.apply === "function" &&
          typeof proto.revert === "function" &&
          typeof proto.readCurrent === "function"
        );
      }
    );
    expect(adapterShaped.map(([name]) => name)).toEqual([
      "RecordingWriteAdapter",
    ]);
  });

  it("the test stub's writes are memory-only (no real-site reach)", async () => {
    const adapter = new changeManagement.RecordingWriteAdapter("wordpress");
    const target = { url: "https://real-client-site.example.com/", locator: "title" };
    await adapter.apply({
      target,
      before: "a",
      after: "b",
      ctx: { tenantId: "t1", clientId: "c1", propertyId: "p1" },
    });
    // The "write" landed in the stub's own Map and nowhere else.
    expect(adapter.current(target)).toBe("b");
    expect(adapter.count("apply")).toBe(1);
  });

  it("the pipeline accepts only change ids minted by preview — an unpersisted change cannot be applied", async () => {
    const clock = changeManagement.fixedClock("2026-07-08T00:00:00.000Z");
    const manager = new changeManagement.ChangeManager({
      store: new changeManagement.InMemoryChangeStore({ clock }),
      adapters: new changeManagement.MapAdapterRegistry([
        new changeManagement.RecordingWriteAdapter("wordpress"),
      ]),
      clock,
    });
    await expect(
      manager.apply(
        "never-previewed",
        { approvedBy: "u-approver" },
        { tenantId: "t1", actor: { id: "u-op", role: "operator" } }
      )
    ).rejects.toBeInstanceOf(changeManagement.ChangeNotFoundError);
  });
});
