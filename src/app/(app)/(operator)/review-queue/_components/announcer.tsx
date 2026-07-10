"use client";

/**
 * A PERSISTENT polite live region + a module-scope dispatcher for the Review &
 * Approvals decision controls (the same pattern the dashboard's Generate-plan
 * control uses — dashboard/status-announcer.tsx). A decision (approve / verdict
 * / send-back / resubmit) succeeds, the page router-refreshes to show the new
 * status, and the outcome is announced through THIS region.
 *
 * WHY A STANDALONE REGION (not one inside the decision panel): on approve /
 * send-back the controls that triggered the action re-render or disappear
 * (status left in_review), so a live region living inside them could be torn
 * out of the accessibility tree with its announcement unspoken. This region is
 * rendered by the detail page at a STABLE position outside the panel, so
 * router.refresh() preserves its DOM node (React reconciles by type + position)
 * and the message is announced into a region that already existed.
 */

import * as React from "react";

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** Politely announce `message` through every mounted ReviewStatusAnnouncer. */
export function announceReview(message: string): void {
  for (const listener of listeners) listener(message);
}

export function ReviewStatusAnnouncer() {
  const [message, setMessage] = React.useState("");
  const frame = React.useRef(0);

  React.useEffect(() => {
    const listener: Listener = (next) => {
      // Clear-then-set across a frame so repeating the SAME message still
      // mutates the DOM (and therefore re-announces).
      cancelAnimationFrame(frame.current);
      setMessage("");
      frame.current = requestAnimationFrame(() => setMessage(next));
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {message}
    </div>
  );
}
