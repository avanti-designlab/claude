"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Route-level error boundary for the operator app (client component, as Next
 * requires). Honest and calm: it says something broke, that it's temporary, and
 * offers a retry — never a stack trace. The error is logged to the console for
 * observability but never shown to the operator.
 *
 * A segment's error boundary does not catch its own layout's errors; the (app)
 * layout reads fail closed to null rather than throw, so this covers the pages.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
      <Card className="flex flex-col items-center gap-5 border-dashed py-16 text-center">
        <div className="flex max-w-md flex-col gap-2 px-6">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink">
            Something went wrong
          </h1>
          <p className="text-sm leading-6 text-muted">
            Something went wrong loading this page — your data isn&apos;t
            affected by viewing errors. Try again; if it keeps happening,
            refresh the page.
          </p>
        </div>
        <Button onClick={reset} variant="outline" size="sm">
          Try again
        </Button>
      </Card>
    </div>
  );
}
