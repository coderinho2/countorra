import "server-only";
import { serverEnv } from "@/lib/server-env";
import { parseCredentialKeyset, type CredentialKeyset } from "@/server/bank-connections/credential-crypto";
import { BANK_OAUTH_RETURN_PATH, checkBankOauthReturnUri } from "@/domain/bank-connections/oauth";

/**
 * Plaid configuration. SERVER ONLY.
 *
 * Same shape as `stripeConfig()`: `null` when Plaid is not configured, so the
 * product runs perfectly well without it and says so, and a THROW when the
 * configuration is half-present — a deployment that can open a bank Link but
 * cannot store the access token fails on somebody who has already typed their
 * bank password. `src/lib/env.ts` performs that all-or-nothing check; this
 * module assembles what the adapter needs.
 *
 * SANDBOX AND PRODUCTION ARE NEVER GUESSED. `PLAID_ENV` names the environment
 * explicitly, it is carried on every connection through the provider version,
 * and the base URL is derived from it here — so a test can only reach real
 * bank data if somebody deliberately put production credentials in the
 * environment it runs with.
 */

export const PLAID_PROVIDER_ID = "plaid";

/** Pinned. Plaid's responses are versioned by this header, so an upgrade is a
 *  deliberate change here with the mapping tests re-run, not a surprise. */
export const PLAID_API_VERSION = "2020-09-14";

/** Only what Countorra uses. Asking for more products would ask the customer's
 *  bank for more access than the product needs. */
export const PLAID_PRODUCTS = ["transactions"] as const;

/** US-first, matching the rest of the product (tax engines, currencies). */
export const PLAID_COUNTRY_CODES = ["US"] as const;

export type PlaidEnvironment = "sandbox" | "production";

const BASE_URL: Record<PlaidEnvironment, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  basePath: string;
  /** Where Plaid should post webhooks, when it can reach us. */
  webhookUrl: string | null;
  /** Required only by OAuth institutions. */
  redirectUri: string | null;
  /** Encrypts stored access tokens. */
  keyset: CredentialKeyset;
}

let cached: PlaidConfig | null | undefined;

export function plaidConfig(): PlaidConfig | null {
  if (cached !== undefined) return cached;
  if (typeof window !== "undefined") throw new Error("plaidConfig() must never be called from the client.");

  const env = serverEnv();
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET || !env.PLAID_ENV || !env.BANK_CREDENTIAL_ENCRYPTION_KEY) {
    cached = null;
    return cached;
  }

  // Plaid sends every OAuth bank's customer back to exactly this URI, so it
  // must be the one fixed return path — never a per-organization one, which
  // would work for a single workspace and strand every other customer at
  // their bank. Refused here, at the first bank call, rather than discovered
  // by a customer standing at their bank's redirect.
  if (env.PLAID_REDIRECT_URI) {
    const check = checkBankOauthReturnUri(env.PLAID_REDIRECT_URI);
    if (!check.ok) {
      throw new Error(
        `PLAID_REDIRECT_URI is not the fixed bank OAuth return path (${check.problem}). It must be https://<your-origin>${BANK_OAUTH_RETURN_PATH} exactly — no organization id, no query string — and registered with Plaid character for character.`,
      );
    }
  }

  cached = {
    clientId: env.PLAID_CLIENT_ID,
    secret: env.PLAID_SECRET,
    environment: env.PLAID_ENV,
    basePath: BASE_URL[env.PLAID_ENV],
    webhookUrl: env.PLAID_WEBHOOK_URL ?? null,
    redirectUri: env.PLAID_REDIRECT_URI ?? null,
    // Throws if the key material is unusable. Better at the first bank call
    // than when a customer's token is already in memory waiting to be stored.
    keyset: parseCredentialKeyset(env.BANK_CREDENTIAL_ENCRYPTION_KEY),
  };
  return cached;
}

/** Test seam only: forget the cached configuration. */
export function __resetPlaidConfigForTests(): void {
  cached = undefined;
}

/** Shown to people, and recorded on every connection's provider version, so a
 *  sandbox connection can never be mistaken for a production one. */
export function plaidProviderVersion(environment: PlaidEnvironment): string {
  return `${PLAID_API_VERSION}+${environment}`;
}
