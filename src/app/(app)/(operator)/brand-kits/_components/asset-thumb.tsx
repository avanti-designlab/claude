"use client";

/**
 * One asset's preview. THE SERVE CONTRACT LIVES HERE (BUILD-STATE, binding
 * Orchestrator condition): an asset's bytes are reached ONLY through a
 * short-lived signed URL from the landed `getAssetSignedUrl` action, and are
 * rendered ONLY as an `<img src>` — NEVER inline SVG, NEVER injected into the
 * DOM, NEVER dangerouslySetInnerHTML. This holds for EVERY type, SVG included:
 * an SVG asset also renders through `<img src>`, where the browser treats it as
 * a non-executing image. The sanitizer (upload side) + this non-executing serve
 * are the two independent layers; this component owns the serve layer.
 *
 * The bucket is private, so the URL is fetched on demand (row-gated: a
 * cross-tenant / sibling-client / removed id yields no row → no URL). The heavy
 * byte download is deferred by the browser via loading="lazy"; only the tiny
 * signed-URL round-trip happens on mount.
 */

import * as React from "react";
import { ImageOffIcon, RefreshCwIcon } from "lucide-react";

import { getAssetSignedUrl } from "@/lib/brand-assets/actions";

/** Ask for the max the action allows (it clamps to 1h) so a preview survives a
 *  browsing session without a mid-view re-fetch. */
const PREVIEW_TTL_SECONDS = 3600;

type State =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string };

export function AssetThumb({ assetId, alt }: { assetId: string; alt: string }) {
  const [state, setState] = React.useState<State>({ kind: "loading" });
  // `broken` = the signed URL was minted but the <img> failed to load it
  // (object removed under us, or URL expired mid-view). Kept separate so a
  // retry re-mints a fresh URL.
  const [broken, setBroken] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let active = true;
    // No synchronous setState here — the initial render is already "loading",
    // and retry() resets to loading before bumping `attempt`. State is only ever
    // written from the async callback below (after the await), never in the
    // effect body, so this can't cascade renders.
    (async () => {
      try {
        const res = await getAssetSignedUrl({ assetId, expiresIn: PREVIEW_TTL_SECONDS });
        if (!active) return;
        if (res.ok) setState({ kind: "ready", url: res.url });
        else setState({ kind: "error", message: res.error });
      } catch {
        if (!active) return;
        setState({ kind: "error", message: "We couldn’t load this preview." });
      }
    })();
    return () => {
      active = false;
    };
  }, [assetId, attempt]);

  const retry = () => {
    setState({ kind: "loading" });
    setBroken(false);
    setAttempt((n) => n + 1);
  };

  if (state.kind === "loading") {
    return (
      <div className="flex aspect-square w-full items-center justify-center rounded-md bg-overlay">
        <span className="sr-only">Loading preview…</span>
        <span aria-hidden className="size-6 animate-pulse rounded-full bg-border" />
      </div>
    );
  }

  if (state.kind === "error" || broken) {
    return (
      <div className="flex aspect-square w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed border-border bg-surface-raised px-3 text-center">
        <ImageOffIcon className="size-5 text-muted" aria-hidden strokeWidth={1.75} />
        <p className="text-[11px] leading-4 text-muted">
          {broken ? "Preview didn’t load" : "Preview unavailable"}
        </p>
        <button
          type="button"
          onClick={retry}
          className="inline-flex items-center gap-1 rounded text-[11px] text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <RefreshCwIcon className="size-3" aria-hidden /> Retry
        </button>
      </div>
    );
  }

  // READY — the ONLY render path that reaches asset bytes, and it is an
  // `<img src>` (checkerboard backing so transparent + reversed art both read).
  return (
    <div
      className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border border-border p-2"
      style={{
        backgroundColor: "var(--color-surface-raised)",
        backgroundImage:
          "repeating-conic-gradient(var(--color-overlay) 0% 25%, transparent 0% 50%)",
        backgroundSize: "16px 16px",
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URLs are
          short-lived + per-asset; next/image optimization/caching is wrong for
          them, and a plain non-executing <img> IS the serve contract. */}
      <img
        src={state.url}
        alt={alt}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  );
}
