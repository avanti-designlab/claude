import { guardOperatorSurface } from "@/components/app-shell/access";

/**
 * Operator route group. Every global studio/section under here
 * (/content-studio, /media-studio, /brand-kits, /review-queue, /measurement,
 * /alerts, /resource-center, /connections, /settings) is an OPERATOR surface:
 * this layout
 * gates the whole group once, redirecting a `client_viewer` to their own report
 * (access.ts) so they can never reach the operator app by direct URL. Staff
 * roles pass through. The route group adds no URL segment — these pages keep
 * their top-level paths — and no visual chrome (the (app) shell owns that).
 *
 * RLS remains the real boundary below; this is defense-in-depth confinement,
 * never the sole gate.
 */
export default async function OperatorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await guardOperatorSurface();
  return <>{children}</>;
}
