import "server-only";
import Stripe from "stripe";
import { stripeConfig } from "./stripe-config";

/**
 * The Stripe SDK client, or null when billing is unconfigured.
 *
 * Cached per process. `apiVersion` is pinned explicitly rather than left
 * implicit: Stripe changes response shapes between versions, and the webhook
 * reads the `Subscription` object field by field. Pinning it in source means
 * an SDK upgrade that moves the version is a visible line in a diff.
 *
 * It must match the version the installed SDK's types were generated for
 * (`node_modules/stripe/esm/apiVersion.js`) — TypeScript rejects any other
 * value, which is what keeps this honest on upgrade.
 */
const STRIPE_API_VERSION = "2026-08-26.dahlia";

let cached: Stripe | null | undefined;

export function stripeClient(): Stripe | null {
  if (cached !== undefined) return cached;

  const config = stripeConfig();
  cached = config
    ? new Stripe(config.secretKey, {
        apiVersion: STRIPE_API_VERSION,
        // Bounded like every other outbound call in this codebase
        // (src/domain/ai/providers/anthropic.ts). A Checkout request that
        // hangs would hold a Server Action open until the platform kills it.
        timeout: 15_000,
        maxNetworkRetries: 1,
        appInfo: { name: "Countorra" },
      })
    : null;

  return cached;
}

/** Test seam. Never called by application code. */
export function resetStripeClientCache(): void {
  cached = undefined;
}
