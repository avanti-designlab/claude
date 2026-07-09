/**
 * M4 persistence-decision + read-API + telemetry suite.
 *
 * Pins: there is NO frozen table for a competitor-gap analysis, so persistence
 * honestly returns the flagged gap and writes nothing (M3 precedent); the read
 * API returns the stored competitor-citation substrate (latest visibility run,
 * tenant-scoped by RLS) and states the analysis is unpersisted; a junk clientId
 * never reaches Postgres; failure telemetry is redacted to marker+stage+code.
 */

import { describe, expect, it, vi } from "vitest";
import type { CompetitorRef } from "@/lib/intelligence/visibility";
import { fakeReadPostgrest, type ScriptedRead } from "@/lib/intelligence/visibility/read-fake";
import {
  COMPETITOR_PERSISTENCE_GAP,
  persistCompetitorGapReport,
  readLatestCompetitorCitations,
  type Supabase,
} from "./persist";
import { COMPETITOR_FAILURE_MARKER, logCompetitorFailure } from "./telemetry";

vi.mock("server-only", () => ({}));

const CLIENT_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const RUN = "2026-07-09T12:00:00+00:00";
const RIVAL: CompetitorRef[] = [{ name: "Rival", domains: ["rival.example"] }];

function client(scripted: ScriptedRead | ScriptedRead[]) {
  const fake = fakeReadPostgrest(scripted);
  return fake.client as unknown as Supabase;
}

describe("persistCompetitorGapReport — the flagged persistence gap (no frozen table)", () => {
  it("writes nothing and returns the flag (return-without-inventing, M3 precedent)", () => {
    const outcome = persistCompetitorGapReport();
    expect(outcome).toEqual({ kind: "not_persisted", reason: "no_table", flag: COMPETITOR_PERSISTENCE_GAP });
    // The function takes no Supabase client — it structurally cannot write.
    expect(persistCompetitorGapReport.length).toBe(0);
  });

  it("the flag honestly names why audits/metrics/alerts don't fit", () => {
    expect(COMPETITOR_PERSISTENCE_GAP).toMatch(/audits/);
    expect(COMPETITOR_PERSISTENCE_GAP).toMatch(/metrics/);
    expect(COMPETITOR_PERSISTENCE_GAP).toMatch(/alerts/);
    expect(COMPETITOR_PERSISTENCE_GAP).toMatch(/competitor_analyses/);
  });
});

describe("readLatestCompetitorCitations — the stored competitor-citation substrate", () => {
  it("returns the latest run's competitor-attributed cited URLs, flagged unpersisted", async () => {
    const rows = [
      { engine: "chatgpt", prompt: "best dubai advisor", cited: false, position: null, cited_source: "https://rival.example/guide", captured_at: RUN },
    ];
    const result = await readLatestCompetitorCitations(client({ data: rows }), CLIENT_ID, RIVAL);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok" || result.latest === null) throw new Error("expected a latest run");
    expect(result.latest.runAt).toBe(RUN);
    expect(result.latest.analysisPersisted).toBe(false);
    expect(result.latest.flag).toBe(COMPETITOR_PERSISTENCE_GAP);
    expect(result.latest.competitorCitations).toEqual([
      { citedUrl: "https://rival.example/guide", domain: "rival.example", name: "Rival", citationCount: 1, engines: ["chatgpt"] },
    ]);
  });

  it("no stored runs → latest null (never mistaken for a read failure)", async () => {
    const result = await readLatestCompetitorCitations(client({ data: [] }), CLIENT_ID, RIVAL);
    expect(result).toEqual({ kind: "ok", latest: null });
  });

  it("a read error is typed failed, not 'no competitors yet'", async () => {
    const result = await readLatestCompetitorCitations(
      client({ error: { message: "boom", code: "PGRST500" } }),
      CLIENT_ID,
      RIVAL,
    );
    expect(result).toEqual({ kind: "failed" });
  });

  it("a junk clientId never reaches Postgres (returns latest null)", async () => {
    const fake = fakeReadPostgrest({ data: [] });
    const result = await readLatestCompetitorCitations(
      fake.client as unknown as Supabase,
      "not-a-uuid",
      RIVAL,
    );
    expect(result).toEqual({ kind: "ok", latest: null });
    expect(fake.reads).toHaveLength(0); // no query was ever issued
  });
});

describe("logCompetitorFailure — redacted telemetry", () => {
  it("emits ONLY marker + stage + a shape-checked code — no payload, message, or ids", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logCompetitorFailure("thrown", {
        code: "23505",
        message: "duplicate cited_source https://rival.example/x for tenant abc-123",
        details: "row (client_id=secret) violates ...",
      });
      expect(spy).toHaveBeenCalledTimes(1);
      const line = spy.mock.calls[0][0] as string;
      expect(line).toBe(`${COMPETITOR_FAILURE_MARKER} stage=thrown code=23505`);
      expect(line).not.toMatch(/rival|tenant|secret|client_id|duplicate/);
    } finally {
      spy.mockRestore();
    }
  });

  it("collapses a non-code-shaped error to 'unknown' so no data can ride in", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      logCompetitorFailure("competitor_crawl", { code: "'; DROP TABLE competitors; --", message: "leaky" });
      expect(spy.mock.calls[0][0]).toBe(`${COMPETITOR_FAILURE_MARKER} stage=competitor_crawl code=unknown`);
    } finally {
      spy.mockRestore();
    }
  });
});
