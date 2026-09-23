import "server-only";
import { headers } from "next/headers";

/**
 * This response's CSP nonce, read back from the policy src/proxy.ts set on
 * the request.
 *
 * Next.js stamps its own scripts automatically, but a third-party component
 * that renders an inline `<script>` or a runtime `<style>` has to be handed
 * the nonce explicitly or `script-src`/`style-src` blocks it
 * (src/lib/security/content-security-policy.ts). next-themes is the first
 * such component: its bootstrap script must run BEFORE first paint to set
 * the theme, so it cannot be deferred or hydrated in.
 *
 * Returns undefined rather than throwing when no policy is present — routes
 * outside the proxy's matcher render without one, and a missing nonce must
 * degrade to "no nonce attribute", not to a crashed page.
 */
export async function requestNonce(): Promise<string | undefined> {
  const policy = (await headers()).get("content-security-policy");
  return policy?.match(/'nonce-([^']+)'/)?.[1];
}
