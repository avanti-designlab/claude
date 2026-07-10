/**
 * The Signal wordmark — the operator (platform) brand mark. Token-driven so it
 * re-skins with the tenant accent. Shown ONLY on operator surfaces (sidebar,
 * operator top bar, mobile menu). A `client_viewer` never sees it — their shell
 * is brand-free and the white-label report wears the agency's brand instead
 * (doc 06 §3).
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={"flex items-center gap-2 " + (className ?? "")}>
      <span
        aria-hidden
        className="flex size-6 items-center justify-center rounded-md bg-accent"
      >
        <span className="size-2 rounded-[3px] bg-accent-foreground" />
      </span>
      <span className="font-display text-base font-bold text-ink">Signal</span>
    </span>
  );
}
