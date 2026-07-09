"use client";

/**
 * A PERSISTENT polite live region + a module-scope dispatcher (design review,
 * 2026-07-09, Minor 9): the Generate-plan control's errors carry
 * role="alert", but its success was silent — on success the row refreshes
 * and the button UNMOUNTS (replaced by the plan's version row), so a live
 * region inside the row would be torn out of the accessibility tree with the
 * announcement unspoken.
 *
 * WHY THIS SURVIVES THE SERVER REFRESH: the dashboard page renders
 * <StatusAnnouncer /> at a stable tree position OUTSIDE the per-client card
 * grid. `router.refresh()` re-renders the Server Component payload, but React
 * reconciles by element type + position, so this client component's instance
 * — and its DOM node, already registered as a live region — is PRESERVED
 * while the cards around it re-render. The success message is dispatched at
 * settle time, before the refresh lands, into that surviving node.
 *
 * Screen-reader mechanics: a live region must exist in the accessibility
 * tree BEFORE its content changes for the change to be announced — this
 * region mounts empty and only ever changes its text. Repeat announcements
 * clear the text for a frame first: writing identical text is not a DOM
 * mutation and would be silent (e.g. generating plans on two cards in a row).
 *
 * Module-scope pub/sub (not context): the dispatcher is called from client
 * islands (GeneratePlanRow) that are siblings across a Server Component
 * boundary, where no shared provider can sit.
 */

import * as React from "react";

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** Politely announce `message` through every mounted StatusAnnouncer. */
export function announceStatus(message: string): void {
  for (const listener of listeners) listener(message);
}

export function StatusAnnouncer() {
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
