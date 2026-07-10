import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Branded 404 for a client that can't be resolved — a malformed id, an
 * archived client, or an id outside the caller's scope (RLS returns nothing;
 * one indistinguishable 404 for all three, no existence oracle).
 *
 * BOUNDARY MODEL (App Router): a not-found file catches `notFound()` thrown
 * BELOW its own segment's layout. This file sits at `[clientId]`, so it
 * catches throws from the `[clientId]` entry page AND from the `(workspace)`
 * layout/tabs beneath it. A file inside `(workspace)` would NOT catch the
 * workspace layout's own throws (the boundary nests inside the layout), which
 * is why it lives here. Routes back to the client list, the relevant home.
 */
export default function ClientNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <Card className="flex flex-col items-center gap-5 border-dashed py-16 text-center">
        <div className="flex max-w-md flex-col gap-2 px-6">
          <span className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
            404
          </span>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            We couldn&apos;t find that client
          </h1>
          <p className="text-sm leading-6 text-muted">
            It may have been archived, or the link is out of date. Head back to
            your clients to find them.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/clients">Back to clients</Link>
        </Button>
      </Card>
    </div>
  );
}
