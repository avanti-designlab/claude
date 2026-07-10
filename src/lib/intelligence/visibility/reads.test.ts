/**
 * M3 read-API suite (reads.ts) — the dashboard-gauge contract.
 *
 * What must hold: runs group on captured_at (the pinned run key); the latest
 * read returns ONLY the newest run; the series is ascending and per-run
 * scores match the live formula; unmeasured engines read as null (absent ≠
 * 0); row-cap truncation is structural, never a silently wrong oldest point;
 * failures are typed and never mistaken for "no runs yet"; junk client ids
 * never reach Postgres.
 */

import { describe, expect, it, vi } from "vitest";
import { VISIBILITY_ENGINES, type VisibilityEngine } from "@/lib/types/db";
import { MAX_TRACKED_QUERIES } from "./derive";
import type { Supabase } from "./persist";
import { fakeReadPostgrest, type ScriptedRead } from "./read-fake";
import {
  getLatestRunResults,
  getLatestShareOfVoice,
  getLatestVisibilityScore,
  getVisibilityScoreSeries,
  SERIES_ROW_CAP,
} from "./reads";

vi.mock("server-only", () => ({}));

const CLIENT_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const RUN_NEW = "2026-07-09T12:00:00+00:00";
const RUN_MID = "2026-07-02T12:00:00+00:00";
const RUN_OLD = "2026-06-25T12:00:00+00:00";

interface RowSpec {
  engine?: VisibilityEngine;
  prompt?: string;
  cited?: boolean;
  position?: number | null;
  cited_source?: string | null;
  captured_at: string;
}

function row(spec: RowSpec) {
  return {
    engine: spec.engine ?? "chatgpt",
    prompt: spec.prompt ?? "who is Gable & Grove Realty",
    cited: spec.cited ?? false,
    position: spec.position ?? null,
    cited_source: spec.cited_source ?? null,
    captured_at: spec.captured_at,
  };
}

/** Rows as the DB returns them for our reads: captured_at DESC. */
const TWO_RUNS = [
  row({ captured_at: RUN_NEW, engine: "chatgpt", cited: true, position: 1 }),
  row({ captured_at: RUN_NEW, engine: "perplexity", cited: false }),
  row({ captured_at: RUN_OLD, engine: "chatgpt", cited: false }),
];

function client(scripted: ScriptedRead | ScriptedRead[]) {
  const fake = fakeReadPostgrest(scripted);
  return { supabase: fake.client as unknown as Supabase, reads: fake.reads };
}

describe("getLatestVisibilityScore", () => {
  it("scores ONLY the newest captured_at group, with per-engine nulls for gaps", async () => {
    const { supabase, reads } = client({ data: TWO_RUNS });
    const result = await getLatestVisibilityScore(supabase, CLIENT_ID);
    expect(result).toEqual({
      kind: "ok",
      latest: {
        runAt: RUN_NEW,
        score: 50, // mean(1, 0) — the older run's uncited row is NOT mixed in
        samples: 2,
        engines: VISIBILITY_ENGINES.map((engine) =>
          engine === "chatgpt"
            ? { engine, sampled: 1, cited: 1, score: 100 }
            : engine === "perplexity"
              ? { engine, sampled: 1, cited: 0, score: 0 }
              : { engine, sampled: 0, cited: 0, score: null }
        ),
      },
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      table: "visibility_results",
      filters: { client_id: CLIENT_ID },
      order: [{ column: "captured_at", ascending: false }],
      limit: MAX_TRACKED_QUERIES * 6,
    });
    // Only the needed columns — never select *.
    expect(reads[0].columns).toBe(
      "engine, prompt, cited, position, cited_source, captured_at"
    );
  });

  it("returns latest:null when the client has no stored runs (gauge pending)", async () => {
    const { supabase } = client({ data: [] });
    expect(await getLatestVisibilityScore(supabase, CLIENT_ID)).toEqual({
      kind: "ok",
      latest: null,
    });
  });

  it("returns a typed failure on a read error — never mistaken for 'no runs yet'", async () => {
    const { supabase } = client({ error: { message: "boom", code: "PGRST301" } });
    expect(await getLatestVisibilityScore(supabase, CLIENT_ID)).toEqual({
      kind: "failed",
    });
  });

  it("never sends a junk client id to Postgres", async () => {
    const { supabase, reads } = client({ data: TWO_RUNS });
    expect(
      await getLatestVisibilityScore(supabase, "'; drop table clients; --")
    ).toEqual({ kind: "ok", latest: null });
    expect(reads).toHaveLength(0);
  });
});

describe("getVisibilityScoreSeries", () => {
  it("returns the trend line ascending, one point per run, live-formula scores", async () => {
    const { supabase } = client({
      data: [
        row({ captured_at: RUN_NEW, cited: true, position: 1 }),
        row({ captured_at: RUN_NEW, engine: "gemini", cited: false }),
        row({ captured_at: RUN_MID, cited: true, position: 2 }),
        row({ captured_at: RUN_OLD, cited: false }),
      ],
    });
    const result = await getVisibilityScoreSeries(supabase, CLIENT_ID);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.truncated).toBe(false);
    expect(result.series.map((point) => [point.runAt, point.score, point.samples])).toEqual([
      [RUN_OLD, 0, 1],
      [RUN_MID, 75, 1],
      [RUN_NEW, 50, 2],
    ]);
  });

  it("applies a valid `since` filter and ignores an invalid one (documented)", async () => {
    const { supabase, reads } = client({ data: [] });
    await getVisibilityScoreSeries(supabase, CLIENT_ID, { since: RUN_OLD });
    await getVisibilityScoreSeries(supabase, CLIENT_ID, { since: "yesterday-ish" });
    expect(reads[0].filters).toEqual({
      client_id: CLIENT_ID,
      "captured_at>=": RUN_OLD,
    });
    expect(reads[1].filters).toEqual({ client_id: CLIENT_ID });
  });

  it("keeps only the newest maxRuns runs and flags the cut", async () => {
    const { supabase } = client({
      data: [
        row({ captured_at: RUN_NEW }),
        row({ captured_at: RUN_MID }),
        row({ captured_at: RUN_OLD }),
      ],
    });
    const result = await getVisibilityScoreSeries(supabase, CLIENT_ID, { maxRuns: 2 });
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(result.series.map((point) => point.runAt)).toEqual([RUN_MID, RUN_NEW]);
    expect(result.truncated).toBe(true);
  });

  it("drops the possibly-partial OLDEST run when the row cap is hit, structurally", async () => {
    const capped = [
      ...Array.from({ length: SERIES_ROW_CAP - 1 }, (_, i) =>
        row({ captured_at: RUN_NEW, prompt: `prompt ${i}` })
      ),
      row({ captured_at: RUN_OLD }),
    ];
    const { supabase, reads } = client({ data: capped });
    const result = await getVisibilityScoreSeries(supabase, CLIENT_ID);
    if (result.kind !== "ok") throw new Error("expected ok");
    expect(reads[0].limit).toBe(SERIES_ROW_CAP);
    expect(result.truncated).toBe(true);
    expect(result.series.map((point) => point.runAt)).toEqual([RUN_NEW]);
  });

  it("returns an empty, untruncated series for a junk client id without touching Postgres", async () => {
    const { supabase, reads } = client({ data: [] });
    expect(await getVisibilityScoreSeries(supabase, "not-a-uuid")).toEqual({
      kind: "ok",
      series: [],
      truncated: false,
    });
    expect(reads).toHaveLength(0);
  });

  it("returns a typed failure on a read error", async () => {
    const { supabase } = client({ error: { message: "boom" } });
    expect(await getVisibilityScoreSeries(supabase, CLIENT_ID)).toEqual({
      kind: "failed",
    });
  });
});

describe("getLatestShareOfVoice", () => {
  it("recomputes SOV + cited-URL inventory over the newest run only", async () => {
    const { supabase } = client({
      data: [
        row({
          captured_at: RUN_NEW,
          cited: true,
          position: 1,
          cited_source: "https://client.example.com/about",
        }),
        row({
          captured_at: RUN_NEW,
          engine: "perplexity",
          cited: false,
          cited_source: "https://www.rival.com/why-us",
        }),
        row({ captured_at: RUN_NEW, engine: "gemini", cited: false }),
        row({ captured_at: RUN_OLD, cited: true, position: 1 }),
      ],
    });
    const result = await getLatestShareOfVoice(supabase, CLIENT_ID, [
      { name: "Rival Realty", domains: ["rival.com"] },
    ]);
    if (result.kind !== "ok" || result.latest === null) {
      throw new Error("expected an ok read with a latest run");
    }
    expect(result.latest.runAt).toBe(RUN_NEW);
    expect(result.latest.samples).toBe(3);
    expect(result.latest.shareOfVoice).toEqual({
      measured: 3,
      client: { citations: 1, share: 1 / 3 },
      competitors: [{ name: "Rival Realty", citations: 1, share: 1 / 3 }],
      otherCitations: 0,
      unattributed: 1,
    });
    expect(result.latest.citedUrls.map((entry) => entry.attribution)).toEqual([
      "client",
      "competitor",
    ]);
  });

  it("returns latest:null when no runs exist and a typed failure on error", async () => {
    const empty = client({ data: [] });
    expect(await getLatestShareOfVoice(empty.supabase, CLIENT_ID, [])).toEqual({
      kind: "ok",
      latest: null,
    });
    const failing = client({ error: { message: "boom" } });
    expect(await getLatestShareOfVoice(failing.supabase, CLIENT_ID, [])).toEqual({
      kind: "failed",
    });
  });
});

describe("getLatestRunResults — per-prompt latest-run view (with sentiment)", () => {
  const fullRow = (o: {
    engine?: VisibilityEngine;
    prompt?: string;
    cited?: boolean;
    position?: number | null;
    sentiment?: string | null;
    cited_source?: string | null;
    captured_at: string;
  }) => ({
    engine: o.engine ?? "chatgpt",
    prompt: o.prompt ?? "who is Gable & Grove Realty",
    cited: o.cited ?? false,
    position: o.position ?? null,
    sentiment: o.sentiment ?? null,
    cited_source: o.cited_source ?? null,
    captured_at: o.captured_at,
  });

  it("returns ONLY the newest run's samples and selects the sentiment column", async () => {
    const { supabase, reads } = client({
      data: [
        fullRow({
          captured_at: RUN_NEW,
          engine: "chatgpt",
          cited: true,
          position: 1,
          sentiment: "positive",
          cited_source: "client.example/about",
        }),
        fullRow({
          captured_at: RUN_NEW,
          engine: "perplexity",
          cited: false,
          cited_source: "rival.com/why-us",
        }),
        fullRow({ captured_at: RUN_OLD, engine: "chatgpt", cited: true, position: 2 }),
      ],
    });
    const result = await getLatestRunResults(supabase, CLIENT_ID);
    if (result.kind !== "ok" || result.latest === null) {
      throw new Error("expected an ok read with a latest run");
    }
    expect(result.latest.runAt).toBe(RUN_NEW);
    // The older run's row is NOT mixed in; cited_source → citedSource; absent
    // signals stay null (never invented as 0).
    expect(result.latest.rows).toEqual([
      {
        engine: "chatgpt",
        prompt: "who is Gable & Grove Realty",
        cited: true,
        position: 1,
        sentiment: "positive",
        citedSource: "client.example/about",
      },
      {
        engine: "perplexity",
        prompt: "who is Gable & Grove Realty",
        cited: false,
        position: null,
        sentiment: null,
        citedSource: "rival.com/why-us",
      },
    ]);
    // Selects sentiment — which the score/SOV reads deliberately do NOT.
    expect(reads[0].columns).toBe(
      "engine, prompt, cited, position, sentiment, cited_source, captured_at"
    );
    expect(reads[0].limit).toBe(MAX_TRACKED_QUERIES * 6);
    expect(reads[0].order).toEqual([{ column: "captured_at", ascending: false }]);
  });

  it("returns latest:null with no runs and a typed failure on error", async () => {
    expect(
      await getLatestRunResults(client({ data: [] }).supabase, CLIENT_ID)
    ).toEqual({ kind: "ok", latest: null });
    expect(
      await getLatestRunResults(client({ error: { message: "boom" } }).supabase, CLIENT_ID)
    ).toEqual({ kind: "failed" });
  });

  it("never sends a junk client id to Postgres", async () => {
    const { supabase, reads } = client({ data: [] });
    expect(await getLatestRunResults(supabase, "not-a-uuid")).toEqual({
      kind: "ok",
      latest: null,
    });
    expect(reads).toHaveLength(0);
  });
});
