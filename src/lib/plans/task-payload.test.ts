/**
 * task-payload suite — the read-side honesty guarantee: absent ≠ zero. A field
 * the payload doesn't carry (or carries malformed) reads back null, never a
 * fabricated 0 / "" / bogus enum, and priorityScore is never surfaced.
 */

import { describe, expect, it } from "vitest";
import { readTaskDetail } from "./task-payload";

const FULL = {
  id: "t1",
  title: "Add FAQPage schema to neighborhood guides",
  description: "They win because they answer the question; do the same on /guides.",
  channel: "schema",
  source: "playbook",
  impact: "high",
  priorityScore: 87,
  effortWeight: 3,
};

describe("readTaskDetail — a full payload", () => {
  it("reads every human field; never surfaces priorityScore", () => {
    const d = readTaskDetail(FULL);
    expect(d).toEqual({
      title: FULL.title,
      description: FULL.description,
      channel: "schema",
      impact: "high",
      effortWeight: 3,
      source: "playbook",
    });
    expect(d).not.toHaveProperty("priorityScore");
  });
});

describe("readTaskDetail — absent ≠ zero / empty", () => {
  it("an empty payload is all-null (no fabricated values)", () => {
    expect(readTaskDetail({})).toEqual({
      title: null,
      description: null,
      channel: null,
      impact: null,
      effortWeight: null,
      source: null,
    });
  });

  it("effort 0 / negative / non-finite → null, never a claimed 0", () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
      expect(readTaskDetail({ effortWeight: bad }).effortWeight).toBeNull();
    }
  });

  it("a real positive effort survives", () => {
    expect(readTaskDetail({ effortWeight: 5 }).effortWeight).toBe(5);
    expect(readTaskDetail({ effortWeight: 1 }).effortWeight).toBe(1);
  });

  it("blank / whitespace strings → null; real strings are trimmed", () => {
    expect(readTaskDetail({ title: "   " }).title).toBeNull();
    expect(readTaskDetail({ title: "  Real  " }).title).toBe("Real");
  });

  it("unknown impact / source enums → null", () => {
    expect(readTaskDetail({ impact: "urgent" }).impact).toBeNull();
    expect(readTaskDetail({ impact: "critical" }).impact).toBe("critical");
    expect(readTaskDetail({ source: "guess" }).source).toBeNull();
    expect(readTaskDetail({ source: "audit" }).source).toBe("audit");
  });
});

describe("readTaskDetail — hostile / malformed input never throws", () => {
  it("non-object payloads (null, array, string, number) → all-null", () => {
    const allNull = {
      title: null,
      description: null,
      channel: null,
      impact: null,
      effortWeight: null,
      source: null,
    };
    for (const bad of [null, undefined, [], "x", 7, true]) {
      expect(readTaskDetail(bad)).toEqual(allNull);
    }
  });
});
