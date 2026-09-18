import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import type { BankConnectionProvider, ProviderSecretStore } from "@/domain/bank-connections/provider";
import { serverEnv } from "@/lib/env";
import { parseCredentialKeyset, type CredentialKeyset } from "./credential-crypto";
import { createEncryptedSecretStore } from "./secret-store";
import { createPlaidProvider } from "./providers/plaid/adapter";
import { plaidConfig } from "./providers/plaid/config";

type Client = SupabaseClient<Database>;

/**
 * THE BANK PROVIDERS THIS DEPLOYMENT HAS.
 *
 * The single registration point, unchanged in shape from Task 11: Plaid is one
 * entry, added when — and only when — its configuration is present. Everything
 * above this file still speaks the provider interface, so a second provider is
 * another entry here and nothing else.
 *
 * With no PLAID_CLIENT_ID / PLAID_SECRET / PLAID_ENV the list is empty and the
 * product says truthfully that no provider is configured. There is deliberately
 * no stand-in and no sample data: a fake provider in production code is how a
 * "connected to your bank" screen ships with nothing behind it.
 */

let cachedProviders: readonly BankConnectionProvider[] | undefined;

export function configuredBankProviders(): readonly BankConnectionProvider[] {
  if (cachedProviders !== undefined) return cachedProviders;
  const plaid = plaidConfig();
  cachedProviders = plaid ? Object.freeze([createPlaidProvider(plaid)]) : Object.freeze([]);
  return cachedProviders;
}

/** Whether this deployment can connect a bank at all, without building a
 *  provider client to find out. Used by surfaces that only need the fact — the
 *  pricing page, which must not advertise what this deployment cannot do. */
export function bankProviderConfigured(): boolean {
  return plaidConfig() !== null;
}

let cachedKeyset: CredentialKeyset | null | undefined;

function credentialKeyset(): CredentialKeyset | null {
  if (cachedKeyset !== undefined) return cachedKeyset;
  const raw = serverEnv().BANK_CREDENTIAL_ENCRYPTION_KEY;
  // Throws if the key material is unusable, rather than storing a credential
  // it cannot protect.
  cachedKeyset = raw ? parseCredentialKeyset(raw) : null;
  return cachedKeyset;
}

/**
 * Where provider credentials are kept.
 *
 * `bank_provider_secrets` (migration 0048), encrypted with AES-256-GCM under a
 * key that lives only in BANK_CREDENTIAL_ENCRYPTION_KEY. Without that key
 * there is no store, and `completeBankLink` refuses rather than holding a bank
 * access token it cannot protect — which is also why `src/lib/env.ts` refuses
 * a deployment that configures Plaid without it.
 */
export function configuredSecretStore(admin: Client): ProviderSecretStore | null {
  const keyset = credentialKeyset();
  return keyset ? createEncryptedSecretStore(admin, keyset) : null;
}

/** Test seam: forget what the environment said. */
export function __resetBankProvidersForTests(): void {
  cachedProviders = undefined;
  cachedKeyset = undefined;
}
