import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * ENCRYPTION FOR PROVIDER CREDENTIALS AT REST.
 *
 * A Plaid access token grants ongoing read access to somebody's bank account.
 * It is never stored in a financial table, never returned to a browser, and
 * never written in the clear: `bank_provider_secrets` holds only the output of
 * this module, and `bank_connection_credentials` holds only a reference to
 * that row (the Task 11 boundary, unchanged).
 *
 * AES-256-GCM, from node's crypto — nothing invented here:
 *
 *   * A fresh random 96-bit IV per encryption, the size GCM is specified for.
 *   * The authentication tag is kept and checked, so a modified ciphertext
 *     fails instead of decrypting to something else.
 *   * ADDITIONAL AUTHENTICATED DATA binds the ciphertext to the organization
 *     and connection it belongs to. Moving a row to another connection — by a
 *     bug or by hand in the database — makes it undecryptable rather than
 *     making one tenant's token work for another's connection.
 *   * Decryption returns null on any failure. Callers report
 *     CREDENTIAL_UNAVAILABLE; the plaintext never reaches an error message,
 *     a log line or a stack trace.
 *
 * ROTATION. The keyset lists every key that may DECRYPT and encrypts with the
 * first. So a new key is added at the front, rows are re-encrypted in the
 * background (`reencryptCredential`), and the retired key is removed once
 * nothing references it. `key_id` on each row says which key it needs.
 */

export const CREDENTIAL_KEY_BYTES = 32;
export const CREDENTIAL_ALGORITHM = "AES-256-GCM";
const IV_BYTES = 12;
const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface CredentialKey {
  readonly id: string;
  readonly key: Buffer;
}

export interface CredentialKeyset {
  /** Encrypts new credentials. */
  readonly active: CredentialKey;
  /** Every key that may decrypt, by id — the active one included. */
  readonly byId: ReadonlyMap<string, CredentialKey>;
}

export class CredentialKeyError extends Error {
  constructor(message: string) {
    // Deliberately never includes the offending value: this message ends up
    // in logs and in a deployment's startup output.
    super(`BANK_CREDENTIAL_ENCRYPTION_KEY is unusable: ${message}`);
    this.name = "CredentialKeyError";
  }
}

/**
 * Parses `<key-id>:<base64 32 bytes>[,<key-id>:<base64>…]`, newest first.
 *
 * A single bare base64 key is also accepted and treated as id "primary", so a
 * deployment that has never rotated does not have to think about ids.
 */
export function parseCredentialKeyset(raw: string): CredentialKeyset {
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) throw new CredentialKeyError("it is empty");

  const keys: CredentialKey[] = [];
  for (const entry of entries) {
    const separator = entry.lastIndexOf(":");
    const id = separator === -1 ? "primary" : entry.slice(0, separator);
    const material = separator === -1 ? entry : entry.slice(separator + 1);

    if (!KEY_ID.test(id)) throw new CredentialKeyError("a key id must be lowercase letters, digits, dashes or underscores");
    if (keys.some((key) => key.id === id)) throw new CredentialKeyError(`the key id "${id}" appears twice`);

    let decoded: Buffer;
    try {
      decoded = Buffer.from(material, "base64");
    } catch {
      throw new CredentialKeyError(`the key "${id}" is not base64`);
    }
    // Buffer.from ignores invalid characters instead of throwing, so the
    // length check below is what actually rejects a malformed key.
    if (decoded.length !== CREDENTIAL_KEY_BYTES) {
      throw new CredentialKeyError(`the key "${id}" decodes to ${decoded.length} bytes; it must be exactly ${CREDENTIAL_KEY_BYTES} (openssl rand -base64 32)`);
    }
    keys.push({ id, key: decoded });
  }

  return { active: keys[0], byId: new Map(keys.map((key) => [key.id, key])) };
}

export interface EncryptedCredential {
  keyId: string;
  algorithm: typeof CREDENTIAL_ALGORITHM;
  /** base64 */
  iv: string;
  /** base64 */
  ciphertext: string;
  /** base64 */
  authTag: string;
}

/** What the ciphertext is bound to. Neither part is secret; both are checked. */
export function credentialAad(organizationId: string, connectionId: string): string {
  return `countorra:bank-credential:v1:${organizationId}:${connectionId}`;
}

export function encryptCredential(plaintext: string, keyset: CredentialKeyset, aad: string): EncryptedCredential {
  if (plaintext.length === 0) throw new TypeError("A provider credential cannot be empty.");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyset.active.key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyId: keyset.active.id,
    algorithm: CREDENTIAL_ALGORITHM,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

/** The plaintext, or null when it cannot be authenticated — a wrong key, a
 *  different organization or connection, or a tampered row. Never throws with
 *  the plaintext or the key in the message. */
export function decryptCredential(record: EncryptedCredential, keyset: CredentialKeyset, aad: string): string | null {
  if (record.algorithm !== CREDENTIAL_ALGORITHM) return null;
  const key = keyset.byId.get(record.keyId);
  if (!key) return null;

  try {
    const iv = Buffer.from(record.iv, "base64");
    if (iv.length !== IV_BYTES) return null;
    const authTag = Buffer.from(record.authTag, "base64");
    if (authTag.length !== 16) return null;

    const decipher = createDecipheriv("aes-256-gcm", key.key, iv, { authTagLength: 16 });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}

/** Re-encrypts a stored credential under the active key. Used by rotation. */
export function reencryptCredential(record: EncryptedCredential, keyset: CredentialKeyset, aad: string): EncryptedCredential | null {
  const plaintext = decryptCredential(record, keyset, aad);
  if (plaintext === null) return null;
  return encryptCredential(plaintext, keyset, aad);
}
