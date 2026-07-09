import { describe, expect, it } from "vitest";
import {
  activeAlertEntry,
  autoRollbackFingerprint,
  competitorOvertookFingerprint,
  isWriterAlertType,
  reviewSpikeFingerprint,
  schemaBrokeFingerprint,
  siteDownFingerprint,
  visibilityDropFingerprint,
  M17_WRITER_ALERT_TYPES,
} from "./rows";

/** The exact frozen `alerts_type_allowed` CHECK set (migration 0006). */
const FROZEN_ALERT_TYPES = [
  "visibility_drop",
  "competitor_overtook",
  "schema_broke",
  "crawler_blocked",
  "negative_review_spike",
  "site_down",
  "auto_rollback_fired",
] as const;

describe("type-CHECK conformance", () => {
  it("every writer type is a member of the frozen alerts.type CHECK set", () => {
    for (const type of M17_WRITER_ALERT_TYPES) {
      expect(FROZEN_ALERT_TYPES).toContain(type);
    }
  });

  it("the writer set EXCLUDES the two owned-elsewhere classes (no double-write)", () => {
    expect(isWriterAlertType("crawler_blocked")).toBe(false); // M5 owns it
    expect(isWriterAlertType("auto_rollback_fired")).toBe(false); // change-mgmt owns it
    expect(isWriterAlertType("visibility_drop")).toBe(true);
    expect(isWriterAlertType("nonsense")).toBe(false);
  });
});

describe("fingerprints — standing-condition keys", () => {
  it("are stable and per-condition (same condition ⇒ same key; different ⇒ different)", () => {
    expect(visibilityDropFingerprint("c1")).toBe(visibilityDropFingerprint("c1"));
    expect(visibilityDropFingerprint("c1")).not.toBe(visibilityDropFingerprint("c2"));
    expect(competitorOvertookFingerprint("c1", "A")).not.toBe(competitorOvertookFingerprint("c1", "B"));
    expect(schemaBrokeFingerprint("p", "u", "FAQPage")).not.toBe(schemaBrokeFingerprint("p", "u", "Article"));
    expect(reviewSpikeFingerprint("c1", "google")).not.toBe(reviewSpikeFingerprint("c1", "yelp"));
    expect(siteDownFingerprint("p1")).not.toBe(siteDownFingerprint("p2"));
    // auto_rollback is keyed to the EVENT (change), not a standing condition.
    expect(autoRollbackFingerprint("chg-1")).not.toBe(autoRollbackFingerprint("chg-2"));
  });
});

describe("activeAlertEntry — defensive feed parse", () => {
  it("extracts named fields and narrows type/severity to the frozen sets", () => {
    const entry = activeAlertEntry({
      id: "a1",
      type: "visibility_drop",
      severity: "critical",
      payload: { summary: "fell 30 pts", fingerprint: "visibility_drop|c1", detectedAt: "r2" },
      acknowledged: false,
      created_at: "2026-07-09T00:00:00Z",
    });
    expect(entry).toEqual({
      alertId: "a1",
      type: "visibility_drop",
      severity: "critical",
      summary: "fell 30 pts",
      fingerprint: "visibility_drop|c1",
      detectedAt: "r2",
      acknowledged: false,
      createdAt: "2026-07-09T00:00:00Z",
    });
  });

  it("never throws or guesses on a hostile/malformed payload — unreadable fields map to null", () => {
    const entry = activeAlertEntry({
      id: "a2",
      type: "not_a_type",
      severity: 42,
      payload: "}<script>", // not an object
      acknowledged: "yes", // not a boolean
      created_at: "t",
    });
    expect(entry.type).toBeNull();
    expect(entry.severity).toBeNull();
    expect(entry.summary).toBeNull();
    expect(entry.fingerprint).toBeNull();
    expect(entry.acknowledged).toBe(false); // only strict true is true
  });

  it("does not echo the raw payload verbatim (only named string fields are surfaced)", () => {
    const entry = activeAlertEntry({
      id: "a3",
      type: "crawler_blocked",
      severity: "warning",
      payload: { summary: "s", secret: "leak-me", nested: { x: 1 } },
      acknowledged: true,
      created_at: "t",
    });
    // The entry carries no arbitrary payload keys — only the whitelisted ones.
    expect(Object.keys(entry).sort()).toEqual(
      ["acknowledged", "alertId", "createdAt", "detectedAt", "fingerprint", "severity", "summary", "type"].sort(),
    );
    expect(JSON.stringify(entry)).not.toContain("leak-me");
  });
});
