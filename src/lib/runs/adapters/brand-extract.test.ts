/**
 * brandExtractAdapter suite — the egress-guarded shallow-fetch routine.
 *
 * Ports are FAKES (a scripted FetchPort, a scripted ResolvePort, a capturing
 * supabase stub) — no live network, no undici, no DB. The REAL egress guard
 * (checkEgressHost) runs against the fake resolver, so the SSRF proofs are
 * genuine: a host that RESOLVES to an internal address is refused BEFORE the port
 * is ever called (the guard, not luck). Every fetch in the module flows through
 * that one guarded helper, so these tests exercise the 0-bypass property directly.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ResolvePort } from "@/lib/intelligence/crawl";
import type { RunRow } from "@/lib/types/db";
import type { FetchPort, FetchPortInit, FetchPortResponse } from "@/lib/write-methods/shared";
import type { AdapterContext } from "../execute";
import { RunExecutionError } from "../outcome";
import { brandExtractAdapter } from "./brand-extract";

const HOME = "https://acme.example/";
const HOME_HTML =
  `<html><head>` +
  `<link rel="stylesheet" href="/style.css">` +
  `<meta name="theme-color" content="#3366ff">` +
  `</head><body><header><img class="logo" src="/logo.png" alt="Acme"></header>` +
  `<h1>Acme</h1><p>We build things.</p></body></html>`;
const STYLE_CSS = ":root{--accent:#3366ff}a{color:#3366ff}body{background:#ffffff;color:#111111}";

function resp(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): FetchPortResponse {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (n: string) => h.get(n.toLowerCase()) ?? null },
    text: async () => body,
  };
}

interface FetchCall {
  url: string;
  init: FetchPortInit;
}

/** A scripted FetchPort: exact-URL routes; an unrouted URL rejects (network fail). */
function scriptedPort(routes: Record<string, FetchPortResponse>, calls: FetchCall[]): FetchPort {
  return async (url, init) => {
    calls.push({ url, init });
    const r = routes[url];
    if (r === undefined) throw new Error("network: no route");
    return r;
  };
}

/** A scripted resolver: host → address (default public). IPv4 addresses only. */
function scriptedResolve(map: Record<string, string> = {}): ResolvePort {
  return async (host) => [{ address: map[host] ?? "93.184.216.34", family: 4 }];
}

interface FakeSupabase {
  captured: { inserts: { table: string; row: unknown }[]; updates: { table: string; row: unknown }[] };
}

function fakeSupabase(
  insertResult: { data: unknown; error: unknown } = { data: { id: "draft-1" }, error: null }
): { supabase: AdapterContext["supabase"]; captured: FakeSupabase["captured"] } {
  const captured: FakeSupabase["captured"] = { inserts: [], updates: [] };
  function builder(table: string) {
    const b = {
      update(row: unknown) {
        captured.updates.push({ table, row });
        return b;
      },
      insert(row: unknown) {
        captured.inserts.push({ table, row });
        return b;
      },
      select() {
        return b;
      },
      eq() {
        return b;
      },
      single: async () => insertResult,
      maybeSingle: async () => insertResult,
      // Awaited directly by the supersede update chain (no .single()).
      then(resolve: (v: { data: null; error: null }) => void) {
        resolve({ data: null, error: null });
      },
    };
    return b;
  }
  return {
    supabase: { from: (t: string) => builder(t) } as unknown as AdapterContext["supabase"],
    captured,
  };
}

function run(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    tenant_id: "tenant-1",
    client_id: "client-1",
    property_id: null,
    input_url: HOME,
    kind: "brand_extract",
    status: "running",
    attempts: 0,
    progress: {},
    heartbeat_at: null,
    requested_by: null,
    result_ref: null,
    error_code: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function ctxFor(opts: {
  run?: RunRow;
  supabase: AdapterContext["supabase"];
  fetchPort: FetchPort;
  resolvePort: ResolvePort;
  now?: () => number;
}): AdapterContext {
  const r = opts.run ?? run();
  return {
    run: r,
    tenantId: r.tenant_id,
    supabase: opts.supabase,
    fetchPort: opts.fetchPort,
    resolvePort: opts.resolvePort,
    heartbeat: async () => {},
    now: opts.now ?? (() => 0),
  };
}

describe("brandExtractAdapter — happy path", () => {
  it("fetches homepage + stylesheet + /about, persists a proposed draft, returns the ref", async () => {
    const calls: FetchCall[] = [];
    const port = scriptedPort(
      {
        [HOME]: resp(200, HOME_HTML, { "content-type": "text/html" }),
        "https://acme.example/style.css": resp(200, STYLE_CSS, { "content-type": "text/css" }),
        "https://acme.example/about": resp(200, "<html><body><h1>About Acme</h1></body></html>"),
      },
      calls
    );
    const { supabase, captured } = fakeSupabase();
    const out = await brandExtractAdapter(
      ctxFor({ supabase, fetchPort: port, resolvePort: scriptedResolve() })
    );

    expect(out.resultRef).toEqual({ kind: "brand_extract", id: "draft-1" });
    // Every fetch went through the port, redirect pinned to "error".
    expect(calls.map((c) => c.url)).toEqual([
      HOME,
      "https://acme.example/style.css",
      "https://acme.example/about",
    ]);
    for (const c of calls) expect(c.init.redirect).toBe("error");

    // Supersede-before-insert, then the proposed insert (RLS-scoped writes).
    expect(captured.updates).toEqual([
      { table: "brand_extract_drafts", row: { status: "discarded" } },
    ]);
    expect(captured.inserts).toHaveLength(1);
    const row = captured.inserts[0].row as Record<string, unknown>;
    expect(row).toMatchObject({
      tenant_id: "tenant-1",
      client_id: "client-1",
      run_id: "run-1",
      status: "proposed",
    });
    // The draft carries the deterministic BrandKitDraft + capped candidate lists.
    const draft = row.draft as Record<string, unknown>;
    expect(draft).toHaveProperty("colors");
    expect(draft).toHaveProperty("logoCandidates");
    expect(draft).toHaveProperty("imageryCandidates");
    expect(Array.isArray(draft.logoCandidates)).toBe(true);
  });
});

describe("brandExtractAdapter — SSRF / egress 0-leak", () => {
  it("a homepage host that RESOLVES to an internal address is refused BEFORE any port call", async () => {
    const calls: FetchCall[] = [];
    const port = scriptedPort({ [HOME]: resp(200, HOME_HTML) }, calls);
    const { supabase, captured } = fakeSupabase();
    // DNS-rebinding shape: the name resolves to loopback.
    const resolve = scriptedResolve({ "acme.example": "127.0.0.1" });

    await expect(
      brandExtractAdapter(ctxFor({ supabase, fetchPort: port, resolvePort: resolve }))
    ).rejects.toMatchObject({ errorCode: "crawl_refused" });

    // The guard blocked pre-fetch: the port was NEVER called, nothing persisted.
    expect(calls).toHaveLength(0);
    expect(captured.inserts).toHaveLength(0);
  });

  it("a cross-origin stylesheet on an internal host is refused (not fetched) and counted honestly", async () => {
    const calls: FetchCall[] = [];
    const htmlWithInternalSheet =
      `<html><head>` +
      `<link rel="stylesheet" href="https://cdn.internal/app.css">` +
      `<link rel="stylesheet" href="/ok.css">` +
      `</head><body><h1>Hi</h1></body></html>`;
    const port = scriptedPort(
      {
        [HOME]: resp(200, htmlWithInternalSheet),
        "https://acme.example/ok.css": resp(200, "a{color:#0055ff}"),
        // NOTE: no route for the internal sheet — it must never be reached.
        "https://cdn.internal/app.css": resp(200, "body{background:#000}"),
        "https://acme.example/about": resp(404, ""),
      },
      calls
    );
    const { supabase, captured } = fakeSupabase();
    const resolve = scriptedResolve({ "cdn.internal": "10.0.0.5", "acme.example": "93.184.216.34" });

    const out = await brandExtractAdapter(
      ctxFor({ supabase, fetchPort: port, resolvePort: resolve })
    );
    expect(out.resultRef.kind).toBe("brand_extract");

    // The internal stylesheet was NEVER fetched (guard blocked it pre-port);
    // the public one WAS.
    const urls = calls.map((c) => c.url);
    expect(urls).not.toContain("https://cdn.internal/app.css");
    expect(urls).toContain("https://acme.example/ok.css");

    // The skip is recorded honestly in the draft notes (count only, no URL).
    const draft = (captured.inserts[0].row as Record<string, unknown>).draft as {
      notes: string[];
    };
    expect(draft.notes.some((n) => /could not be fetched/.test(n))).toBe(true);
  });
});

describe("brandExtractAdapter — budget + honesty", () => {
  it("stops fetching stylesheets once the aggregate budget is spent", async () => {
    const calls: FetchCall[] = [];
    const html =
      `<html><head>` +
      `<link rel="stylesheet" href="/a.css">` +
      `<link rel="stylesheet" href="/b.css">` +
      `</head><body><h1>Hi</h1></body></html>`;
    const port = scriptedPort(
      {
        [HOME]: resp(200, html),
        "https://acme.example/a.css": resp(200, "a{color:#0055ff}"),
        "https://acme.example/b.css": resp(200, "a{color:#00aa55}"),
        "https://acme.example/about": resp(200, "<html></html>"),
      },
      calls
    );
    const { supabase } = fakeSupabase();
    // now() is 0 for the deadline calc + the pre-homepage budget check (calls 1-2),
    // then jumps far past the deadline — so the homepage IS read but the stylesheet
    // loop (and /about) must stop.
    let n = 0;
    const now = () => (n++ < 2 ? 0 : 10_000_000);

    await brandExtractAdapter(ctxFor({ supabase, fetchPort: port, resolvePort: scriptedResolve(), now }));

    const urls = calls.map((c) => c.url);
    expect(urls).toContain(HOME);
    expect(urls).not.toContain("https://acme.example/a.css");
    expect(urls).not.toContain("https://acme.example/about");
  });
});

describe("brandExtractAdapter — closed-enum failure mapping", () => {
  it("no input_url → misconfigured (defensive; enqueue shape-checks it)", async () => {
    const { supabase } = fakeSupabase();
    await expect(
      brandExtractAdapter(
        ctxFor({
          run: run({ input_url: null }),
          supabase,
          fetchPort: scriptedPort({}, []),
          resolvePort: scriptedResolve(),
        })
      )
    ).rejects.toMatchObject({ errorCode: "misconfigured" });
  });

  it("a failed draft write → engine_error (retryable)", async () => {
    const calls: FetchCall[] = [];
    const port = scriptedPort(
      {
        [HOME]: resp(200, HOME_HTML),
        "https://acme.example/style.css": resp(200, STYLE_CSS),
        "https://acme.example/about": resp(404, ""),
      },
      calls
    );
    const { supabase } = fakeSupabase({ data: null, error: { code: "500" } });
    const err = await brandExtractAdapter(
      ctxFor({ supabase, fetchPort: port, resolvePort: scriptedResolve() })
    ).catch((e) => e);
    expect(err).toBeInstanceOf(RunExecutionError);
    expect((err as RunExecutionError).errorCode).toBe("engine_error");
  });
});
