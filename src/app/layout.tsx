import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AEO/GEO + Brand Production OS",
  description:
    "AI-native agency operating system — AEO/GEO intelligence with brand-consistent production.",
};

/**
 * Root layout. Deliberately minimal: all chrome (colors, faces, type scale)
 * comes from the design tokens in globals.css, and tenant themes override
 * those same custom properties at runtime — nothing brand-shaped lives here.
 * `suppressHydrationWarning` covers the client-set `data-theme` /
 * `data-tenant-theme` attributes on <html>.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full" suppressHydrationWarning>
      <body className="flex min-h-full flex-col font-body">{children}</body>
    </html>
  );
}
