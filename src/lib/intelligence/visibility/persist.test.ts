/**
 * M3 run-persistence suite (persist.ts).
 *
 * What must hold: only MEASURED samples are stored (a failed sample is
 * absent, never a fake `cited:false` row); rows are pinned to the
 * claim-sourced tenant/client and to ONE captured_at (the run key) in a
 * single batch statement; the verbatim vendor payload never reaches the
 * database; every write failure is retryable and emits exactly ONE redacted
 * telemetry line (marker + stage + code — no prompts, no ids, no messages).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import type { CitationPromptResult } from "@/lib/connectors";
import { persistVisibilityRun, type Supabase } from "./persist";
import type { SampleOutcome, VisibilityRun } from "./sampler";
import type { DerivedQuery } from "./derive";

vi.mock("server-only", () => ({}));

const TENANT_ID = "11111111-2222-4333-8444-555555555555";
const CLIENT_ID = "3f8e2a4b-5c6d-4e7f-8a9b-0c1d2e3f4a5b";
const RUN_AT = "2026-07-09T12:00:00.000Z";

function query(prompt: string): DerivedQuery {
  return {
    prompt,
    template: prompt,
    intents: ["entity"],
    priority: "normal",
    location: null,
  };
}

function measured(
  prompt: string,
  engine: SampleOutcome["engine"],
  result: Partial<CitationPromptResult> = {}
): SampleOutcome {
  return {
    status: "measured",
    query: query(prompt),
    engine,
    result: {
      cited: false,
      position: null,
      sentiment: null,
      citedSource: null,
      raw: { vendor_secret_blob: "never-stored" },
      ...result,
    },
  };
}

function failed(prompt: string, engine: SampleOutcome["engine"]): SampleOutcome {
  return {
    status: "failed",
    query: query(prompt),
    engine,
    failure: { kind: "unavailable", retryable: true, attempts: 2 },
  };
}

function run(outcomes: SampleOutcome[], runAt = RUN_AT): VisibilityRun {
  return { vendor: "in-memory", runAt, engines: ["chatgpt", "perplexity"], outcomes };
}

function setup(script: FakeScript) {
  return fakePostgrest(script);
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");
    return call[0] as string;
  });
}

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("persistVisibilityRun", () => {
  it("stores measured samples only, claim-scoped, one captured_at, one statement", async () => {
    const fake = setup({ visibility_results: { insert: {} } });
    const outcome = await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([
        measured("who is Gable & Grove Realty", "chatgpt", {
          cited: true,
          position: 2,
          sentiment: "positive",
          citedSource: "https://client.example.com/about",
        }),
        failed("who is Gable & Grove Realty", "perplexity"),
        measured("is Dubai real estate a good investment / a bubble", "chatgpt"),
      ])
    );

    expect(outcome).toEqual({ kind: "persisted", rows: 2 });
    expect(fake.inserts).toHaveLength(1); // ONE batch statement — whole run or nothing
    expect(fake.inserts[0].table).toBe("visibility_results");
    expect(fake.inserts[0].values).toEqual([
      {
        tenant_id: TENANT_ID,
        client_id: CLIENT_ID,
        engine: "chatgpt",
        prompt: "who is Gable & Grove Realty",
        cited: true,
        position: 2,
        sentiment: "positive",
        cited_source: "https://client.example.com/about",
        captured_at: RUN_AT,
      },
      {
        tenant_id: TENANT_ID,
        client_id: CLIENT_ID,
        engine: "chatgpt",
        prompt: "is Dubai real estate a good investment / a bubble",
        cited: false,
        position: null,
        sentiment: null,
        cited_source: null,
        captured_at: RUN_AT,
      },
    ]);
  });

  it("never lets the verbatim vendor payload reach the database", async () => {
    const fake = setup({ visibility_results: { insert: {} } });
    await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([measured("prompt one", "chatgpt")])
    );
    expect(JSON.stringify(fake.inserts[0].values)).not.toContain("vendor_secret_blob");
    const row = (fake.inserts[0].values as Array<Record<string, unknown>>)[0];
    expect(Object.keys(row)).not.toContain("raw");
  });

  it("stores nothing when nothing was measured — no invented zero rows", async () => {
    const fake = setup({});
    const outcome = await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([failed("prompt one", "chatgpt")])
    );
    expect(outcome).toEqual({ kind: "nothing_measured" });
    expect(fake.inserts).toHaveLength(0);
    expect(loggedLines()).toEqual([]);
  });

  it("returns failed + ONE redacted line on an insert error — no data in the log", async () => {
    const fake = setup({
      visibility_results: {
        insert: {
          error: {
            message: `duplicate key quoting prompt "who is Gable & Grove Realty" tenant ${TENANT_ID}`,
            code: "23505",
            details: "row payload verbatim",
          },
        },
      },
    });
    const outcome = await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([measured("who is Gable & Grove Realty", "chatgpt")])
    );
    expect(outcome).toEqual({ kind: "failed" });
    const lines = loggedLines();
    expect(lines).toEqual(["[visibility-write-failure] stage=results_insert code=23505"]);
    expect(lines[0]).not.toContain(TENANT_ID);
    expect(lines[0]).not.toContain("Gable");
  });

  it("returns failed + stage=thrown when the insert transport throws", async () => {
    const fake = setup({
      visibility_results: { insert: { throws: new TypeError("fetch failed") } },
    });
    const outcome = await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([measured("prompt one", "chatgpt")])
    );
    expect(outcome).toEqual({ kind: "failed" });
    expect(loggedLines()).toEqual([
      "[visibility-write-failure] stage=thrown code=unknown",
    ]);
  });

  it("fails whole-run on an unmappable row (hostile empty prompt) BEFORE any insert", async () => {
    const fake = setup({ visibility_results: { insert: {} } });
    const outcome = await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([measured("  ", "chatgpt"), measured("real prompt", "chatgpt")])
    );
    expect(outcome).toEqual({ kind: "failed" });
    expect(fake.inserts).toHaveLength(0);
    expect(loggedLines()).toEqual([
      "[visibility-write-failure] stage=row_mapping code=unknown",
    ]);
  });

  it("refuses a run whose runAt is not a timestamp (run identity would be junk)", async () => {
    const fake = setup({ visibility_results: { insert: {} } });
    const outcome = await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([measured("prompt one", "chatgpt")], "not-a-time")
    );
    expect(outcome).toEqual({ kind: "failed" });
    expect(fake.inserts).toHaveLength(0);
  });

  it("clamps a vendor position that violates the contract (uncited keeps no position)", async () => {
    const fake = setup({ visibility_results: { insert: {} } });
    await persistVisibilityRun(
      fake.client as unknown as Supabase,
      TENANT_ID,
      CLIENT_ID,
      run([measured("prompt one", "chatgpt", { cited: false, position: 4 })])
    );
    const row = (fake.inserts[0].values as Array<Record<string, unknown>>)[0];
    expect(row.cited).toBe(false);
    expect(row.position).toBeNull();
  });
});
