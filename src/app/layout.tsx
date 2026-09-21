import type { Metadata } from "next";
import { connection } from "next/server";
import { Geist, Geist_Mono, Playfair_Display } from "next/font/google";
import "./globals.css";
import { publicEnv } from "@/lib/env";
import { CspNonce } from "@/components/security/csp-nonce";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/**
 * Editorial display serif, marketing headlines only (DESIGN.md §4).
 *
 * Playfair Display is a high-contrast transitional/didone — the class the
 * reference system calls for, and the first fallback its own spec names
 * (Ivy Presto itself is licensed and not distributable). Loaded at 400/500
 * only: this face never sets UI, body copy or a figure, so the heavier cuts
 * would be dead weight.
 *
 * Declaring it here only publishes a CSS variable. Nothing renders in it
 * until something asks for `font-serif`, so the authenticated application is
 * completely unaffected by its presence.
 */
const playfairDisplay = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
});

/**
 * Root metadata, inherited by every route that does not override it.
 *
 * `metadataBase` is the load-bearing part: without it Next cannot resolve a
 * relative Open Graph or canonical URL, so it warns at build time and any
 * share card silently falls back to a bare link. Every social preview,
 * canonical tag and OG image URL in the product resolves against this.
 *
 * The `title.template` means a page setting `title: "Pricing"` renders as
 * "Pricing — Countorra" without each page repeating the suffix.
 */
export const metadata: Metadata = {
  metadataBase: new URL(publicEnv.NEXT_PUBLIC_APP_URL),
  title: {
    default: "Countorra — Financial intelligence for your own records",
    template: "%s — Countorra",
  },
  description:
    "A premium financial intelligence and accounting platform for individuals, freelancers, and businesses. Ask real questions about your money, answered from your own records.",
  applicationName: "Countorra",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "Countorra",
    url: "/",
    title: "Countorra — Financial intelligence for your own records",
    description:
      "One system for income, expenses, accounts and invoices — that answers real questions about them, grounded in your own records.",
  },
  twitter: {
    card: "summary_large_image",
    title: "Countorra",
    description:
      "One system for income, expenses, accounts and invoices — that answers real questions about them, grounded in your own records.",
  },
  // No image is referenced because none exists. Pointing at a missing file
  // produces a broken card, which is worse than the text-only one a crawler
  // falls back to.
  robots: { index: true, follow: true },
};

/**
 * Every page is rendered per request, never prerendered at build time.
 *
 * The Content-Security-Policy allows only scripts carrying the nonce that
 * src/proxy.ts generates for each response. A page prerendered at build time
 * has its inline bootstrap scripts baked in without that nonce, so the
 * browser would block them and the page would never hydrate.
 * `connection()` opts the whole tree into request-time rendering, which is
 * what lets Next.js stamp the current nonce onto every script it emits.
 *
 * A side effect worth having: pages like /login used to be served from
 * Vercel's static cache with `Access-Control-Allow-Origin: *`; a dynamic
 * response carries no CORS grant at all.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  await connection();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${playfairDisplay.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-paper text-text-primary">
        <CspNonce />
        {children}
      </body>
    </html>
  );
}
