import "server-only";

/**
 * `brand_extract` execution adapter — the shallow, cross-origin, egress-guarded
 * fetch routine behind "paste the client's URL → propose a draft brand kit".
 *
 * This is a DISTINCT shallow-fetch routine, NOT crawlSite-with-different-bounds:
 *   leased run.input_url (a pasted URL) → fetch homepage → parse for linked
 *   stylesheet <link href> (+ conventional /about) → fetch each → hand the raw
 *   html + cssBlobs + aboutHtml to the PURE engine (extractBrandCandidates →
 *   toBrandKitDraft) → persist a `proposed` brand_extract_drafts row → return the
 *   content-free result_ref {kind:'brand_extract', id}.
 *
 * SSRF / EGRESS — the 0-LEAK standard (higher surface than the audit crawler: the
 * URL is attacker-influenceable and stylesheets are cross-origin):
 *   - EVERY fetch (homepage, each stylesheet, /about) goes through ONE helper,
 *     `guardedTextFetch`, which runs `checkEgressHost` (pre-DNS literal reject +
 *     resolve-and-vet, any-blocked-wins) BEFORE it touches the port — a blocked
 *     target gets NO connection. `ctx.fetchPort` (the processor's socket-pinned
 *     seam) appears EXACTLY ONCE in this file, inside that helper: the pin re-vets
 *     at connect time, closing the DNS-rebinding TOCTOU. So NO fetch bypasses the
 *     seam, and cross-origin is allowed only THROUGH the guard.
 *   - `redirect: "error"` on every request (a redirect could escape the vetted
 *     host); per-fetch byte cap (Content-Length precheck + post-read length).
 *   - A blocked/refused target is HONEST (a failed homepage → mapped error_code;
 *     a skipped stylesheet → counted in the draft's operator-facing notes), never
 *     silently swallowed.
 *
 * The pure engine NEVER fetches; this adapter NEVER emits CSS. The persisted
 * `draft` jsonb is untrusted extracted DATA — it prefills the ingest form later
 * and is re-validated through resolveAndValidateTokens at review→lock.
 *
 * Failures map to the CLOSED error_code enum (0015 adds no code): a blocked/
 * unfetchable homepage → `crawl_refused`; the aggregate budget hit before the
 * homepage → `budget_exhausted_total`; a missing/invalid input_url → `misconfigured`
 * (defensive — enqueue shape-checks it); a failed draft write → `engine_error`
 * (retryable), mirroring the audit adapter.
 */

import { checkEgressHost, type ResolvePort } from "@/lib/intelligence/crawl";
import {
  extractBrandCandidates,
  toBrandKitDraft,
  tokenize,
  type BrandKitDraft,
  type ExtractedBrandCandidates,
} from "@/lib/production/brand-extract";
import type { FetchPort } from "@/lib/write-methods/shared";
import {
  BRAND_EXTRACT_AGGREGATE_BUDGET_MS,
  BRAND_EXTRACT_CANDIDATE_URL_MAX_CHARS,
  BRAND_EXTRACT_MAX_FETCH_BYTES,
  BRAND_EXTRACT_MAX_IMAGERY_CANDIDATES,
  BRAND_EXTRACT_MAX_LOGO_CANDIDATES,
  BRAND_EXTRACT_MAX_STYLESHEETS,
} from "../config";
import { heartbeatingFetch, type AdapterContext } from "../execute";
import { RunExecutionError, type RunResultRef } from "../outcome";

/** Honest bot identity (brand pull ≈ what a browser loads for one page). */
const BRAND_EXTRACT_USER_AGENT = "Mozilla/5.0 (compatible; AEO-BrandBot/1.0)";

/** The persisted draft = the deterministic BrandKitDraft + capped candidate URL
 *  lists (the extra logo/imagery choices the review UI offers beyond the top pick). */
interface PersistedBrandExtractDraft extends BrandKitDraft {
  logoCandidates: string[];
  imageryCandidates: string[];
}

type FetchReason = "bad_url" | "blocked" | "http_error" | "too_large" | "rejected";
type GuardedFetch =
  | { ok: true; body: string }
  | { ok: false; reason: FetchReason };

/**
 * The ONE fetch path. Egress-guards the URL's host BEFORE any port call, then
 * fetches through the socket-pinned seam. This is the ONLY place `port` (i.e.
 * ctx.fetchPort) is invoked — so every brand_extract fetch is guarded, by
 * construction.
 */
async function guardedTextFetch(
  port: FetchPort,
  resolve: ResolvePort,
  url: string,
  maxBytes: number
): Promise<GuardedFetch> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "bad_url" };
  }
  // EGRESS GUARD — pre-DNS literal reject + resolve-and-vet (any-blocked-wins).
  // A blocked host returns here with NO port call: no connection, nothing to leak.
  if (!(await checkEgressHost(parsed.hostname, resolve))) {
    return { ok: false, reason: "blocked" };
  }
  let response;
  try {
    // The socket-pinned seam (pins the connection to the vetted address — closes
    // the DNS-rebinding TOCTOU). redirect:"error" refuses any escape hop.
    response = await port(url, {
      method: "GET",
      headers: {
        accept: "text/html,text/css,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "user-agent": BRAND_EXTRACT_USER_AGENT,
      },
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "rejected" };
  }
  const status = response.status;
  if (status < 200 || status >= 300) return { ok: false, reason: "http_error" };
  // Content-Length precheck: refuse a declared-oversized body without reading it.
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { ok: false, reason: "rejected" };
  }
  // Post-read cap: refuse whole (never truncate) an undeclared over-cap body.
  if (body.length > maxBytes) return { ok: false, reason: "too_large" };
  return { ok: true, body };
}

/**
 * Discover linked-stylesheet hrefs from the homepage HTML, resolved absolute and
 * http(s)-only, deduped and count-capped. Reuses the engine's hardened, linear-
 * time `tokenize` (never a fresh regex over untrusted HTML). Each returned URL is
 * still egress-guarded per fetch — this only decides WHICH URLs to attempt.
 */
function collectStylesheetHrefs(html: string, base: URL, cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokenize(html)) {
    if (out.length >= cap) break;
    if (tok.type !== "open" || tok.name !== "link") continue;
    const rel = (tok.attrs.get("rel") ?? "").toLowerCase();
    if (!rel.split(/\s+/).includes("stylesheet")) continue;
    const href = tok.attrs.get("href");
    if (href === undefined || href === "") continue;
    let abs: URL;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
    const s = abs.toString();
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Cap + dedupe a candidate URL list (each length-capped, list count-capped). */
function cappedCandidateUrls(urls: ReadonlyArray<string | null>, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (out.length >= max) break;
    if (typeof u !== "string" || u === "" || u.length > BRAND_EXTRACT_CANDIDATE_URL_MAX_CHARS) {
      continue;
    }
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Postgres jsonb cannot store \u0000 — a NUL smuggled through a hostile page's
 * markup into any candidate string would make the draft insert fail on every
 * retry (fail-closed but wasteful). Strip it from every string in the draft,
 * recursively, right before persist. Nothing legitimate contains NUL.
 *
 * Defense-in-depth: today every draft string is already NUL-free by construction
 * (the font grammar rejects control chars, URL parsing percent-encodes NUL, and
 * notes are fixed engine strings) — this guards FUTURE draft fields. Exported
 * for its direct test pin only.
 */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === "string") {
    return value.replaceAll("\u0000", "") as T;
  }
  if (Array.isArray(value)) {
    return value.map(stripNulDeep) as T;
  }
  if (value !== null && typeof value === "object") {
    // Keys are stripped too: today every draft key is an engine-defined literal,
    // but a future map keyed by extracted content would reopen the jsonb failure.
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [stripNulDeep(k), stripNulDeep(v)])
    ) as T;
  }
  return value;
}

/** Exported for its direct test pin (the NUL-strip wiring proof) only. */
export function buildPersistedDraft(
  candidates: ExtractedBrandCandidates,
  stylesheetsFetched: number,
  stylesheetsSkipped: number
): PersistedBrandExtractDraft {
  const base = toBrandKitDraft(candidates);
  const notes = [...base.notes];
  if (stylesheetsSkipped > 0) {
    // Honest, count-only (no URLs → no leak): blocked/refused sheets are recorded,
    // never silently dropped.
    notes.push(
      `${stylesheetsFetched} stylesheet(s) were read; ${stylesheetsSkipped} could not be fetched (unreachable, non-public, or over the size limit) and were skipped — the proposed palette may be partial.`
    );
  }
  return stripNulDeep({
    ...base,
    notes,
    logoCandidates: cappedCandidateUrls(
      candidates.logos.map((l) => l.url),
      BRAND_EXTRACT_MAX_LOGO_CANDIDATES
    ),
    imageryCandidates: cappedCandidateUrls(
      candidates.imagery.map((i) => i.url),
      BRAND_EXTRACT_MAX_IMAGERY_CANDIDATES
    ),
  });
}

/**
 * Supersede a client's prior `proposed` drafts (→ `discarded`) through the RLS-
 * scoped per-run client. Runs right before this run's own insert so the NEWEST
 * brand_extract wins under concurrent completion (the partial unique index is the
 * structural backstop; a colliding insert surfaces as engine_error → retry, which
 * re-supersedes and converges). Best-effort: a cleanup blip must not fail a
 * completed extraction — the index still upholds the invariant.
 */
async function supersedePriorProposed(
  supabase: AdapterContext["supabase"],
  clientId: string
): Promise<void> {
  await supabase
    .from("brand_extract_drafts")
    .update({ status: "discarded" })
    .eq("client_id", clientId)
    .eq("status", "proposed");
}

export async function brandExtractAdapter(
  ctx: AdapterContext
): Promise<{ resultRef: RunResultRef }> {
  const run = ctx.run;

  // input_url is the run's SHAPE-checked target (enqueue). Defensive re-parse.
  const rawUrl = typeof run.input_url === "string" ? run.input_url.trim() : "";
  if (rawUrl === "") {
    throw new RunExecutionError("misconfigured", "brand_extract run carries no input_url");
  }
  let base: URL;
  try {
    base = new URL(rawUrl);
  } catch {
    throw new RunExecutionError("misconfigured", "brand_extract input_url is not a valid URL");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new RunExecutionError("misconfigured", "brand_extract input_url is not http(s)");
  }

  // Per-fetch heartbeat (A6): the wrapped port beats before each fetch, so a
  // multi-stylesheet pull proves liveness between fetches. This is the ONLY port
  // handed to guardedTextFetch — every fetch is heartbeat-wrapped AND guarded.
  const port = heartbeatingFetch(ctx.fetchPort, ctx.heartbeat);
  const resolve = ctx.resolvePort;

  // AGGREGATE budget (interactive; see config). Checked BETWEEN fetches.
  const deadline = ctx.now() + BRAND_EXTRACT_AGGREGATE_BUDGET_MS;
  const withinBudget = () => ctx.now() < deadline;

  // (1) Homepage — essential. Budget could only be spent here by clock skew.
  if (!withinBudget()) {
    throw new RunExecutionError("budget_exhausted_total", "budget spent before the homepage fetch");
  }
  const home = await guardedTextFetch(port, resolve, rawUrl, BRAND_EXTRACT_MAX_FETCH_BYTES);
  if (!home.ok) {
    // A blocked/unfetchable homepage measured nothing — honest crawl_refused
    // (retried under the attempt cap, like the audit adapter's zero-page crawl).
    throw new RunExecutionError("crawl_refused", `homepage fetch failed (${home.reason})`);
  }
  const html = home.body;

  // (2) Stylesheets — cross-origin ALLOWED, each egress-guarded; budget-bounded.
  const sheetUrls = collectStylesheetHrefs(html, base, BRAND_EXTRACT_MAX_STYLESHEETS);
  const cssBlobs: string[] = [];
  let stylesheetsFetched = 0;
  let stylesheetsSkipped = 0;
  for (let i = 0; i < sheetUrls.length; i++) {
    if (!withinBudget()) {
      // Every unreached sheet is honestly counted (never silently dropped).
      stylesheetsSkipped += sheetUrls.length - i;
      break;
    }
    const sheet = await guardedTextFetch(port, resolve, sheetUrls[i], BRAND_EXTRACT_MAX_FETCH_BYTES);
    if (sheet.ok) {
      cssBlobs.push(sheet.body);
      stylesheetsFetched++;
    } else {
      stylesheetsSkipped++;
    }
  }

  // (3) /about — optional, same-origin, best-effort (its copy joins sourceText,
  // reserved for the deferred voice summary). A failure just omits it.
  let aboutHtml: string | undefined;
  if (withinBudget()) {
    let aboutUrl: string | null = null;
    try {
      aboutUrl = new URL("/about", base.origin).toString();
    } catch {
      aboutUrl = null;
    }
    if (aboutUrl !== null) {
      const about = await guardedTextFetch(port, resolve, aboutUrl, BRAND_EXTRACT_MAX_FETCH_BYTES);
      if (about.ok) aboutHtml = about.body;
    }
  }

  // (4) PURE engine — no network here. Then build the persisted draft.
  const candidates = extractBrandCandidates({ html, pageUrl: rawUrl, cssBlobs, aboutHtml });
  const draft = buildPersistedDraft(candidates, stylesheetsFetched, stylesheetsSkipped);

  // (5) Supersede prior proposed drafts, then persist THIS proposed draft — both
  // through the RLS-scoped per-run client (A1; NOT service_role).
  await supersedePriorProposed(ctx.supabase, run.client_id);
  const inserted = await ctx.supabase
    .from("brand_extract_drafts")
    .insert({
      tenant_id: run.tenant_id,
      client_id: run.client_id,
      run_id: run.id,
      draft,
      status: "proposed",
    })
    .select("id")
    .single();
  if (inserted.error || !inserted.data) {
    // A background run exists to PERSIST — a failed write is retryable.
    throw new RunExecutionError("engine_error", "brand_extract draft write failed");
  }
  const draftId = (inserted.data as { id: string }).id;

  return { resultRef: { kind: "brand_extract", id: draftId } };
}
