import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
});

import { ProviderSecret } from "@/domain/bank-connections/provider";
import { CREDENTIAL_KEY_BYTES, parseCredentialKeyset } from "@/server/bank-connections/credential-crypto";
import { createEncryptedSecretStore, rotateStoredCredential } from "@/server/bank-connections/secret-store";

/**
 * The credential store's wiring: what it writes, what it refuses to return,
 * and that a token only ever exists in it encrypted.
 *
 * The cryptography is tested directly in credential-crypto.test.ts and the
 * table's own rules against real Postgres in tests/rls/bank-provider-secrets;
 * here the database is a small double, so the queries the store makes are
 * visible and assertable.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONNECTION = "22222222-2222-4222-8222-222222222222";
const TOKEN = "access-sandbox-11111111-2222-3333-4444-555555555555";
const keyset = (seed = 3) => parseCredentialKeyset(Buffer.alloc(CREDENTIAL_KEY_BYTES, seed).toString("base64"));

type Row = Record<string, unknown> & { id: string };

function database(options: { connectionProvider?: string | null } = {}) {
  const rows = new Map<string, Row>();
  const queries: string[] = [];

  const client = {
    from(table: string) {
      queries.push(table);
      if (table === "bank_connections") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: options.connectionProvider === null ? null : { provider: options.connectionProvider ?? "plaid" }, error: null }),
              }),
            }),
          }),
        };
      }
      return {
        upsert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              const existing = [...rows.values()].find((candidate) => candidate.connection_id === row.connection_id);
              const id = existing?.id ?? randomUUID();
              rows.set(id, { ...row, id });
              return { data: { id }, error: null };
            },
          }),
        }),
        select: () => ({
          eq: (_column: string, value: string) => ({
            maybeSingle: async () => ({ data: rows.get(value) ?? [...rows.values()].find((row) => row.connection_id === value) ?? null, error: null }),
          }),
        }),
        delete: () => ({
          eq: async (_column: string, value: string) => {
            rows.delete(value);
            return { error: null };
          },
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: async (_column: string, value: string) => {
            const row = rows.get(value);
            if (row) rows.set(value, { ...row, ...patch });
            return { error: null };
          },
        }),
      };
    },
  };

  return { client: client as never, rows, queries };
}

let db: ReturnType<typeof database>;

beforeEach(() => {
  db = database();
});

describe("storing a credential", () => {
  it("writes ciphertext and returns a reference, never the token", async () => {
    const store = createEncryptedSecretStore(db.client, keyset());
    const reference = await store.put({ organizationId: ORG, connectionId: CONNECTION, secret: new ProviderSecret(TOKEN) });

    expect(reference).toMatch(/^enc:[0-9a-f-]{36}$/);
    const row = [...db.rows.values()][0];
    expect(row).toMatchObject({ organization_id: ORG, connection_id: CONNECTION, provider: "plaid", algorithm: "AES-256-GCM" });
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(JSON.stringify(row)).not.toContain("access-sandbox");
    expect(String(row.ciphertext)).toMatch(/^[A-Za-z0-9+/=]+$/);
    // The provider is read from the connection, not supplied by the caller.
    expect(db.queries).toContain("bank_connections");
  });

  it("gives the token back only to the reference that holds it", async () => {
    const store = createEncryptedSecretStore(db.client, keyset());
    const reference = await store.put({ organizationId: ORG, connectionId: CONNECTION, secret: new ProviderSecret(TOKEN) });

    expect((await store.get(reference))?.reveal()).toBe(TOKEN);
    expect(await store.get("enc:33333333-3333-4333-8333-333333333333")).toBeNull();
    // Not a reference this store issued.
    for (const bogus of ["vault:1234", "enc:not-a-uuid", TOKEN, ""]) expect(await store.get(bogus), bogus).toBeNull();
  });

  it("refuses to decrypt a row that was moved to another connection", async () => {
    const store = createEncryptedSecretStore(db.client, keyset());
    const reference = await store.put({ organizationId: ORG, connectionId: CONNECTION, secret: new ProviderSecret(TOKEN) });
    const row = [...db.rows.values()][0];
    db.rows.set(row.id, { ...row, connection_id: "44444444-4444-4444-8444-444444444444" });
    expect(await store.get(reference)).toBeNull();
  });

  it("refuses a different key", async () => {
    const store = createEncryptedSecretStore(db.client, keyset(3));
    const reference = await store.put({ organizationId: ORG, connectionId: CONNECTION, secret: new ProviderSecret(TOKEN) });
    const other = createEncryptedSecretStore(db.client, keyset(9));
    expect(await other.get(reference)).toBeNull();
  });

  it("rotates a credential in place, and destroying one is idempotent", async () => {
    const before = keyset(3);
    const store = createEncryptedSecretStore(db.client, before);
    const reference = await store.put({ organizationId: ORG, connectionId: CONNECTION, secret: new ProviderSecret(TOKEN) });

    const rotating = parseCredentialKeyset(`next:${Buffer.alloc(CREDENTIAL_KEY_BYTES, 5).toString("base64")},primary:${Buffer.alloc(CREDENTIAL_KEY_BYTES, 3).toString("base64")}`);
    expect(await rotateStoredCredential(db.client, rotating, CONNECTION)).toBe("ROTATED");
    expect(await rotateStoredCredential(db.client, rotating, CONNECTION)).toBe("ALREADY_CURRENT");
    expect(await rotateStoredCredential(db.client, rotating, "55555555-5555-4555-8555-555555555555")).toBe("NOT_FOUND");

    const rotated = createEncryptedSecretStore(db.client, rotating);
    expect((await rotated.get(reference))?.reveal()).toBe(TOKEN);
    expect([...db.rows.values()][0].key_id).toBe("next");

    await rotated.destroy(reference);
    expect(db.rows.size).toBe(0);
    await rotated.destroy(reference);
    expect(await rotated.get(reference)).toBeNull();
  });

  it("will not store a credential for a connection that is not there", async () => {
    const missing = database({ connectionProvider: null });
    const store = createEncryptedSecretStore(missing.client, keyset());
    await expect(store.put({ organizationId: ORG, connectionId: CONNECTION, secret: new ProviderSecret(TOKEN) })).rejects.toThrow(/does not exist in this organization/);
    expect(missing.rows.size).toBe(0);
  });
});
