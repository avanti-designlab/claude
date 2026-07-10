"use client";

/**
 * Shared polite-live-region announcer factory — ONE implementation of the
 * "persistent live region + module-scope dispatcher" pattern that three gated
 * surfaces (dashboard Generate-plan, Review & Approvals decisions, the plan
 * tab's controls) previously carried as verbatim copies (Design Review m3 /
 * Code Review minor 2, 2026-07-10). App-utility layer over F2, not frozen F2 —
 * same governance note as src/components/tone.ts.
 *
 * Each `makeAnnouncer()` call returns an independent {announce, Announcer}
 * pair with its OWN listener set, so surfaces stay isolated exactly as the
 * three copies were: announcing on the plan tab never speaks through the
 * dashboard's region.
 *
 * WHY THE PATTERN (kept verbatim from the originals):
 *  - A control that unmounts on success (router.refresh() swaps it for the new
 *    server state) cannot host its own live region — the region would be torn
 *    out of the accessibility tree with the announcement unspoken. The page
 *    renders <Announcer /> ONCE at a stable position outside the mutating
 *    subtree; React reconciles by element type + position, so the DOM node —
 *    already registered as a live region — survives the refresh, and the
 *    message dispatched at settle time lands in the surviving node.
 *  - A live region must exist in the accessibility tree BEFORE its content
 *    changes for the change to be announced — the region mounts empty and only
 *    ever changes its text.
 *  - Repeat announcements clear the text for a frame first: writing identical
 *    text is not a DOM mutation and would be silent (e.g. acting on two rows
 *    in a row).
 *  - Module-scope pub/sub (not context): the dispatchers are called from
 *    client islands that are siblings across Server Component boundaries,
 *    where no shared provider can sit.
 */

import * as React from "react";

type Listener = (message: string) => void;

export function makeAnnouncer(): {
  /** Politely announce `message` through every mounted Announcer of this pair. */
  announce: (message: string) => void;
  /** The persistent polite live region — render once at a stable position. */
  Announcer: () => React.JSX.Element;
} {
  const listeners = new Set<Listener>();

  function announce(message: string): void {
    for (const listener of listeners) listener(message);
  }

  function Announcer() {
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

  return { announce, Announcer };
}
