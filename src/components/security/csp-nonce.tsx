"use client";

import { getNonce, setNonce } from "get-nonce";

/**
 * Hands this page's CSP nonce to the libraries that create `<style>` elements
 * at runtime.
 *
 * The policy allows a `<style>` element only if it carries the response's
 * nonce (src/lib/security/content-security-policy.ts). Two libraries in the
 * tree add style elements after the page has loaded:
 *
 *   - react-style-singleton, behind every modal Radix Dialog and
 *     DropdownMenu, injects the scroll lock that stops the page scrolling
 *     behind an open modal. It reads its nonce from `get-nonce`, which is
 *     what `setNonce` below fills in.
 *   - Radix Select renders a `<style>` for its viewport and takes the nonce
 *     as a prop; src/components/ui/select.tsx passes `useCspNonce()`.
 *
 * Without this both are blocked: a modal stops locking the page behind it,
 * and each open logs a violation.
 *
 * The nonce is read from the DOM rather than passed down from the server,
 * so it never appears in the serialized component payload. Browsers hide the
 * `nonce` ATTRIBUTE from page script and CSS selectors once a page has
 * loaded, but keep it on the element's `nonce` property, which is what
 * Next's own nonce-stamped scripts expose here. This runs at module
 * evaluation — before hydration, and so before any modal can open.
 */
if (typeof document !== "undefined") {
  const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
  if (nonce) setNonce(nonce);
}

/** Rendered once, by the root layout, so the module above is always loaded. */
export function CspNonce() {
  return null;
}

/** For components that render their own `<style>` and accept a `nonce` prop. */
export function useCspNonce(): string | undefined {
  return getNonce() || undefined;
}
