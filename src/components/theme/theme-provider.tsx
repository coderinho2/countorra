"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * The single theme provider for the whole product. There is exactly one,
 * mounted by the root layout, so every route — marketing, auth and the
 * authenticated app — reads and writes the same preference.
 *
 * WHY `attribute="data-theme"` AND WHY SYSTEM IS STILL THE DEFAULT
 *
 * src/app/globals.css was already written for this contract, before any
 * switcher existed: `:root` carries the light tokens, an
 * `@media (prefers-color-scheme: dark)` block carries the dark ones for
 * anyone who has not chosen, and `:root[data-theme="dark"]` carries them for
 * anyone who has. DESIGN.md §25 states that both modes follow the operating
 * system. So the default stays `system` and the OS keeps deciding until the
 * visitor overrides it; the switcher then writes an explicit choice that
 * wins. The control itself offers only Light and Dark (see theme-switcher),
 * which is what a person actually wants to express.
 *
 * `disableTransitionOnChange` suppresses every colour transition for the one
 * frame the attribute flips. Without it each token that is mid-transition
 * animates independently and the page wipes through an intermediate state.
 *
 * `nonce` is not optional here: the provider renders a blocking inline
 * script to set the theme before first paint, and the CSP admits inline
 * scripts only by nonce (src/server/security/request-nonce.ts).
 */
export function ThemeProvider({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <NextThemesProvider
      attribute="data-theme"
      defaultTheme="system"
      enableSystem
      enableColorScheme
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </NextThemesProvider>
  );
}
