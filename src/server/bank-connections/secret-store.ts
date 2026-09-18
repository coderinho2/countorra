import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BankProviderSecretRow, Database } from "@/types/database";
import { ProviderSecret, type ProviderSecretStore } from "@/domain/bank-connections/provider";
import { credentialAad, decryptCredential, encryptCredential, reencryptCredential, type CredentialKeyset, type EncryptedCredential } from "./credential-crypto";

type Client = SupabaseClient<Database>;

/**
 * THE PROVIDER SECRET STORE.
 *
 * Implements the Task 11 boundary: `bank_connection_credentials` keeps a
 * reference (`enc:<uuid>`) and this store keeps the ciphertext, in
 * `bank_provider_secrets` — service-role only, no RLS policy, encrypted with a
 * key that lives in the environment rather than the database.
 *
 * Nothing here ever returns a credential to a caller that did not ask for it
 * by reference, and a failure to decrypt is `null` rather than an exception
 * carrying the row: the caller turns that into CREDENTIAL_UNAVAILABLE, which
 * the sync engine already knows how to report without retrying forever.
 */

const REFERENCE = /^enc:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function referenceFor(id: string): string {
  return `enc:${id}`;
}

function idFromReference(reference: string): string | null {
  return REFERENCE.exec(reference)?.[1] ?? null;
}

function toEncrypted(row: Pick<BankProviderSecretRow, "key_id" | "algorithm" | "iv" | "ciphertext" | "auth_tag">): EncryptedCredential {
  return { keyId: row.key_id, algorithm: "AES-256-GCM", iv: row.iv, ciphertext: row.ciphertext, authTag: row.auth_tag };
}

export function createEncryptedSecretStore(admin: Client, keyset: CredentialKeyset): ProviderSecretStore {
  return {
    id: "enc",

    async put(input) {
      // The provider comes from the connection, not from the caller: a stored
      // credential must say which provider it is for, and the database refuses
      // a row whose provider disagrees with its connection.
      const connection = await admin.from("bank_connections").select("provider").eq("id", input.connectionId).eq("organization_id", input.organizationId).maybeSingle();
      if (connection.error) throw connection.error;
      if (!connection.data) throw new Error("Cannot store a credential for a connection that does not exist in this organization.");

      const encrypted = encryptCredential(input.secret.reveal(), keyset, credentialAad(input.organizationId, input.connectionId));
      const { data, error } = await admin
        .from("bank_provider_secrets")
        .upsert(
          {
            organization_id: input.organizationId,
            connection_id: input.connectionId,
            provider: connection.data.provider,
            key_id: encrypted.keyId,
            algorithm: encrypted.algorithm,
            iv: encrypted.iv,
            ciphertext: encrypted.ciphertext,
            auth_tag: encrypted.authTag,
            rotated_at: new Date().toISOString(),
          },
          { onConflict: "connection_id" },
        )
        .select("id")
        .single();
      if (error) throw error;
      return referenceFor(data.id);
    },

    async get(reference) {
      const id = idFromReference(reference);
      if (!id) return null;
      const { data, error } = await admin.from("bank_provider_secrets").select("organization_id, connection_id, key_id, algorithm, iv, ciphertext, auth_tag").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!data) return null;

      const plaintext = decryptCredential(toEncrypted(data as BankProviderSecretRow), keyset, credentialAad(data.organization_id, data.connection_id));
      return plaintext === null ? null : new ProviderSecret(plaintext);
    },

    /** Idempotent: destroying a credential that is already gone succeeds. */
    async destroy(reference) {
      const id = idFromReference(reference);
      if (!id) return;
      const { error } = await admin.from("bank_provider_secrets").delete().eq("id", id);
      if (error) throw error;
    },
  };
}

export type RotationOutcome = "ROTATED" | "ALREADY_CURRENT" | "NOT_FOUND" | "UNDECRYPTABLE";

/**
 * Re-encrypts one stored credential under the active key.
 *
 * The operational half of rotation: add the new key at the front of
 * BANK_CREDENTIAL_ENCRYPTION_KEY, run this for each connection, then drop the
 * retired key. Until it runs, rows still decrypt with the old key, so nothing
 * breaks in between. See PLAID-INTEGRATION.md.
 */
export async function rotateStoredCredential(admin: Client, keyset: CredentialKeyset, connectionId: string): Promise<RotationOutcome> {
  const { data, error } = await admin.from("bank_provider_secrets").select("id, organization_id, connection_id, key_id, algorithm, iv, ciphertext, auth_tag").eq("connection_id", connectionId).maybeSingle();
  if (error) throw error;
  if (!data) return "NOT_FOUND";
  if (data.key_id === keyset.active.id) return "ALREADY_CURRENT";

  const rotated = reencryptCredential(toEncrypted(data as BankProviderSecretRow), keyset, credentialAad(data.organization_id, data.connection_id));
  if (!rotated) return "UNDECRYPTABLE";

  const update = await admin
    .from("bank_provider_secrets")
    .update({ key_id: rotated.keyId, algorithm: rotated.algorithm, iv: rotated.iv, ciphertext: rotated.ciphertext, auth_tag: rotated.authTag, rotated_at: new Date().toISOString() })
    .eq("id", data.id);
  if (update.error) throw update.error;
  return "ROTATED";
}
