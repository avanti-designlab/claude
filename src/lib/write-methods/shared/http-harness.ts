/**
 * Scripted FetchPort — the shared HTTP test harness for write-method adapters.
 *
 * One harness for all four methods (WordPress now; Webflow / Wix / edge-worker
 * reuse it rather than forking): tests script routes, the harness journals
 * every request (method, url, LOWERCASED headers, body) so a test can assert
 * exactly what left the adapter — including that a credential appears in the
 * Authorization header and NOWHERE else — and inject faults (network throw,
 * HTML-instead-of-JSON, arbitrary statuses).
 *
 * Honesty over convenience: an UNSCRIPTED request throws. A test that forgot a
 * route fails loudly instead of green-lighting an adapter that silently hit an
 * unexpected endpoint.
 */

import type { FetchPort, FetchPortResponse } from "./http";

/** One journaled request. Header names are lowercased for stable assertions. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** The redirect policy the adapter stated (the port contract pins "error"). */
  redirect: "error";
}

/** A scripted response producer. Receives the (already journaled) request. */
export type ScriptedHandler = (req: RecordedRequest) => FetchPortResponse;

interface ScriptedRoute {
  method: "GET" | "POST" | "*";
  match: string | RegExp;
  handler: ScriptedHandler;
}

export class ScriptedFetch {
  /** Every request the adapter made, in order. */
  readonly requests: RecordedRequest[] = [];
  private readonly routes: ScriptedRoute[] = [];
  private nextError: Error | null = null;

  /**
   * Script a route. `match` is a substring (string) or a pattern (RegExp)
   * tested against the full request URL; first registered match wins.
   */
  on(
    method: "GET" | "POST" | "*",
    match: string | RegExp,
    handler: ScriptedHandler,
  ): this {
    this.routes.push({ method, match, handler });
    return this;
  }

  /** The next port call rejects at the network level (DNS/TLS/timeout stand-in). */
  failNext(error: Error = new Error("scripted network failure")): this {
    this.nextError = error;
    return this;
  }

  /** The injectable FetchPort (pre-bound; hand it to the adapter as-is). */
  readonly port: FetchPort = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init.headers)) {
      headers[name.toLowerCase()] = value;
    }
    const req: RecordedRequest = {
      method: init.method,
      url,
      headers,
      body: init.body,
      redirect: init.redirect,
    };
    this.requests.push(req);

    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }

    const route = this.routes.find(
      (r) =>
        (r.method === "*" || r.method === init.method) &&
        (typeof r.match === "string"
          ? url.includes(r.match)
          : r.match.test(url)),
    );
    if (!route) {
      throw new Error(
        `ScriptedFetch: no route matches ${init.method} ${url} — script it explicitly`,
      );
    }
    return route.handler(req);
  };
}

/* ------------------------------------------------------------------ */
/* Response builders                                                   */
/* ------------------------------------------------------------------ */

function makeResponse(
  status: number,
  body: string,
  contentType: string,
): FetchPortResponse {
  return {
    status,
    headers: {
      get: (name) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    text: async () => body,
  };
}

/** A JSON response (the honest vendor path). */
export function jsonResponse(status: number, body: unknown): FetchPortResponse {
  return makeResponse(status, JSON.stringify(body), "application/json; charset=UTF-8");
}

/** An HTML response (the classic wp-login redirect / security interstitial). */
export function htmlResponse(status: number, markup: string): FetchPortResponse {
  return makeResponse(status, markup, "text/html; charset=UTF-8");
}

/** An arbitrary text response (malformed JSON, proxies, plain-text errors). */
export function textResponse(
  status: number,
  body: string,
  contentType = "text/plain; charset=UTF-8",
): FetchPortResponse {
  return makeResponse(status, body, contentType);
}
