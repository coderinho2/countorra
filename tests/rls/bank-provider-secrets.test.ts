import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * 0048 — encrypted provider credentials, against real Postgres.
 *
 * A Plaid access token is the most dangerous thing this product can hold, so
 * the table's own rules are asserted rather than assumed: unreachable from any
 * browser role, one credential per connection, refused for a disconnected
 * connection, ciphertext that cannot be a plaintext token, and gone when the
 * organization is.
 */

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: TestDatabase;
let org: string;
let connectionId: string;

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;

async function service<T>(fn: (query: TestDatabase["query"]) => Promise<T>): Promise<T> {
  return db.asAdmin(async (query) => {
    await query("set role service_role");
    try {
      return await fn(query);
    } finally {
      await query("reset role");
    }
  });
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  return db.asAdmin(async (query) => Object.values(one<Record<string, T>>(await query(sql, params)))[0]);
}

/** Shaped exactly like what credential-crypto.ts produces. */
const CIPHERTEXT = Buffer.from("this stands in for encrypted bytes").toString("base64");
const IV = Buffer.alloc(12, 7).toString("base64");
const AUTH_TAG = Buffer.alloc(16, 9).toString("base64");

const insertSecret = (overrides: Record<string, unknown> = {}) => {
  const row = { organization_id: org, connection_id: connectionId, provider: "plaid", key_id: "primary", algorithm: "AES-256-GCM", iv: IV, ciphertext: CIPHERTEXT, auth_tag: AUTH_TAG, ...overrides };
  return service((query) =>
    query(
      `insert into bank_provider_secrets (organization_id, connection_id, provider, key_id, algorithm, iv, ciphertext, auth_tag) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [row.organization_id, row.connection_id, row.provider, row.key_id, row.algorithm, row.iv, row.ciphertext, row.auth_tag],
    ),
  );
};

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) => query(`insert into auth.users (id, email) values ($1, 'owner@example.test'), ($2, 'other@example.test')`, [OWNER, OTHER]));
  await db.asUser(OWNER);
  org = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Synthetic', 'personal', $1) returning id`, [OWNER])).id;
  connectionId = await service(async (query) => {
    const id = one<{ id: string }>(
      await query(`insert into bank_connections (organization_id, provider, provider_connection_id, institution_name, provider_environment, created_by) values ($1, 'plaid', 'item-1', 'First Platypus Bank', 'sandbox', $2) returning id`, [org, OWNER]),
    ).id;
    await query(`select bank_transition_connection($1, $2, 'PENDING', 'ACTIVE', 'LINK_COMPLETED', null)`, [org, id]);
    return id;
  });
});

afterEach(async () => {
  await db?.close();
});

describe("who can reach a stored credential", () => {
  it("nobody with a browser session, whatever their role", async () => {
    await insertSecret();
    await db.asUser(OWNER);
    for (const sql of [
      `select count(*) from bank_provider_secrets`,
      `select ciphertext from bank_provider_secrets`,
      `insert into bank_provider_secrets (organization_id, connection_id, provider, key_id, algorithm, iv, ciphertext, auth_tag) values ('${org}', '${connectionId}', 'plaid', 'k', 'AES-256-GCM', '${IV}', '${CIPHERTEXT}', '${AUTH_TAG}')`,
      `update bank_provider_secrets set ciphertext = 'x'`,
      `delete from bank_provider_secrets`,
    ]) {
      await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
    }
  });

  it("nor an anonymous caller", async () => {
    await insertSecret();
    await db.asAdmin(async () => {});
    await db.query(`set role anon`);
    await expect(db.query(`select count(*) from bank_provider_secrets`)).rejects.toThrow(/permission denied/);
  });

  it("and the table has no policy to grant it, row-level security being on", async () => {
    expect(await scalar(`select relrowsecurity from pg_class where relname = 'bank_provider_secrets'`)).toBe(true);
    expect(await scalar(`select count(*)::int from pg_policies where tablename = 'bank_provider_secrets'`)).toBe(0);
  });
});

describe("what the table refuses to hold", () => {
  it("anything shaped like a plaintext provider token", async () => {
    for (const ciphertext of [Buffer.from("x").toString("base64"), "access-sandbox-1234567890abcdef"]) {
      const attempt = insertSecret({ ciphertext });
      if (ciphertext.startsWith("access-")) await expect(attempt).rejects.toThrow(/looks_encrypted|check constraint/);
      else await expect(attempt).rejects.toThrow(/ciphertext/);
    }
  });

  it("a malformed IV or authentication tag", async () => {
    await expect(insertSecret({ iv: Buffer.alloc(8).toString("base64") })).rejects.toThrow(/iv/);
    await expect(insertSecret({ auth_tag: Buffer.alloc(8).toString("base64") })).rejects.toThrow(/auth_tag/);
    await expect(insertSecret({ algorithm: "AES-128-CBC" })).rejects.toThrow(/algorithm/);
    await expect(insertSecret({ key_id: "Primary Key" })).rejects.toThrow(/key_id/);
  });

  it("a second credential for the same connection", async () => {
    await insertSecret();
    await expect(insertSecret({ key_id: "another" })).rejects.toThrow(/one_per_connection/);
  });

  it("a credential for another organization's connection, or another provider", async () => {
    await db.asUser(OTHER);
    const otherOrg = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Other', 'personal', $1) returning id`, [OTHER])).id;
    await expect(insertSecret({ organization_id: otherOrg })).rejects.toThrow();
    await expect(insertSecret({ provider: "teller" })).rejects.toThrow(/same provider/);
  });

  it("a credential for a disconnected connection", async () => {
    await service((query) => query(`select bank_finalize_disconnect($1, $2, $3)`, [org, connectionId, OWNER]));
    await expect(insertSecret()).rejects.toThrow(/live connection/);
  });
});

describe("rotation and history", () => {
  it("allows re-encryption, and records when", async () => {
    const id = one<{ id: string }>(await insertSecret()).id;
    await expect(service((query) => query(`update bank_provider_secrets set key_id = 'next', ciphertext = $2 where id = $1`, [id, `${CIPHERTEXT}Zg==`]))).rejects.toThrow(/records when it happened/);
    await service((query) => query(`update bank_provider_secrets set key_id = 'next', ciphertext = $2, rotated_at = now() where id = $1`, [id, `${CIPHERTEXT}Zg==`]));
    expect(await scalar(`select key_id from bank_provider_secrets where id = $1`, [id])).toBe("next");
  });

  it("keeps a credential bound to its connection", async () => {
    const id = one<{ id: string }>(await insertSecret()).id;
    const second = await service(async (query) => {
      const other = one<{ id: string }>(await query(`insert into bank_connections (organization_id, provider, provider_connection_id, created_by) values ($1, 'plaid', 'item-2', $2) returning id`, [org, OWNER])).id;
      await query(`select bank_transition_connection($1, $2, 'PENDING', 'ACTIVE', 'LINK_COMPLETED', null)`, [org, other]);
      return other;
    });
    await expect(service((query) => query(`update bank_provider_secrets set connection_id = $2 where id = $1`, [id, second]))).rejects.toThrow(/belongs to one connection/);
  });
});

describe("deletion", () => {
  it("takes the credential with the organization", async () => {
    await insertSecret();
    expect(await scalar(`select count(*)::int from bank_provider_secrets`)).toBe(1);
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [org]));
    expect(await scalar(`select count(*)::int from bank_provider_secrets`)).toBe(0);
  });
});

describe("the provider environment", () => {
  it("is recorded on the connection and readable by members, so sandbox data is never mistaken for real money", async () => {
    expect(await scalar(`select provider_environment from bank_connections where id = $1`, [connectionId])).toBe("sandbox");
    await db.asUser(OWNER);
    expect((await db.query(`select provider_environment from bank_connections where id = $1`, [connectionId])).rows).toEqual([{ provider_environment: "sandbox" }]);
  });

  it("cannot be edited afterwards", async () => {
    await expect(service((query) => query(`update bank_connections set provider_environment = 'production' where id = $1`, [connectionId]))).rejects.toThrow();
  });
});
