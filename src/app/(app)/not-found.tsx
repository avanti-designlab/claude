import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Branded 404 for the authenticated operator area. Renders within the (app)
 * shell (sidebar + top bar persist), so the operator keeps their bearings, and
 * offers a route home to the dashboard. Catches any notFound() raised in this
 * group that has no closer boundary.
 */
export default function AppNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <Card className="flex flex-col items-center gap-5 border-dashed py-16 text-center">
        <div className="flex max-w-md flex-col gap-2 px-6">
          <span className="font-mono text-[11px] tracking-[0.18em] text-muted uppercase">
            404
          </span>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            We couldn&apos;t find that page
          </h1>
          <p className="text-sm leading-6 text-muted">
            The page you&apos;re after doesn&apos;t exist or has moved. Head back
            to your dashboard.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </Card>
    </div>
  );
}
