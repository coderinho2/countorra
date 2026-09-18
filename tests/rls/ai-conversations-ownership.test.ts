import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Verifies 0022_ai_conversations_delete.sql and the existing
 * ai_conversations_update_own policy (0011_rls_policies.sql) actually
 * restrict rename/delete to a conversation's own creator — product spec
 * §8: "delete conversations only with confirmation" and "a user must
 * never access conversations belonging to another organization" extend to
 * same-org teammates too for mutation (not just cross-org reads, already
 * covered by tests/rls/tenant-isolation.test.ts).
 */

function row<T>(rows: unknown[], index = 0): T {
  return rows[index] as T;
}

let db: TestDatabase;
let owner: string;
let teammate: string;
let outsider: string;
let orgA: string;
let orgB: string;
let conversationId: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.com'), ('teammate@example.com'), ('outsider@example.com') returning id`);
    [owner, teammate, outsider] = users.rows.map((r: unknown) => row<{ id: string }>([r]).id);
  });

  await db.asUser(owner);
  const orgAResult = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'business', $1) returning id`, [owner]);
  orgA = row<{ id: string }>(orgAResult.rows).id;

  await db.asUser(outsider);
  const orgBResult = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org B', 'business', $1) returning id`, [outsider]);
  orgB = row<{ id: string }>(orgBResult.rows).id;

  // teammate is a member of Org A (same org as owner), not an owner of it.
  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer')`, [orgA, teammate]));

  await db.asUser(owner);
  const conv = await db.query(`insert into ai_conversations (organization_id, user_id, title) values ($1, $2, 'Q1 spend') returning id`, [orgA, owner]);
  conversationId = row<{ id: string }>(conv.rows).id;
});

afterEach(async () => {
  await db.close();
});

describe("ai_conversations ownership (rename/delete)", () => {
  it("the creator can rename their own conversation", async () => {
    await db.asUser(owner);
    const result = await db.query(`update ai_conversations set title = 'Renamed' where id = $1 returning id`, [conversationId]);
    expect(result.rows).toHaveLength(1);
  });

  it("a same-org teammate cannot rename someone else's conversation", async () => {
    await db.asUser(teammate);
    const result = await db.query(`update ai_conversations set title = 'Hijacked' where id = $1 returning id`, [conversationId]);
    expect(result.rows).toHaveLength(0);
  });

  it("a non-member cannot rename a conversation in another organization at all", async () => {
    await db.asUser(outsider);
    const result = await db.query(`update ai_conversations set title = 'Hijacked' where id = $1 returning id`, [conversationId]);
    expect(result.rows).toHaveLength(0);
  });

  it("the creator can delete their own conversation", async () => {
    await db.asUser(owner);
    const result = await db.query(`delete from ai_conversations where id = $1 returning id`, [conversationId]);
    expect(result.rows).toHaveLength(1);
  });

  it("a same-org teammate cannot delete someone else's conversation", async () => {
    await db.asUser(teammate);
    const result = await db.query(`delete from ai_conversations where id = $1 returning id`, [conversationId]);
    expect(result.rows).toHaveLength(0);

    await db.asUser(owner);
    const stillThere = await db.query(`select id from ai_conversations where id = $1`, [conversationId]);
    expect(stillThere.rows).toHaveLength(1);
  });

  it("a non-member cannot delete a conversation in another organization", async () => {
    await db.asUser(outsider);
    const result = await db.query(`delete from ai_conversations where id = $1 returning id`, [conversationId]);
    expect(result.rows).toHaveLength(0);
  });

  it("deleting a conversation cascades to its messages", async () => {
    await db.asUser(owner);
    await db.query(`insert into ai_messages (conversation_id, role, content) values ($1, 'user', 'hi')`, [conversationId]);

    const before = await db.query(`select id from ai_messages where conversation_id = $1`, [conversationId]);
    expect(before.rows).toHaveLength(1);

    await db.query(`delete from ai_conversations where id = $1`, [conversationId]);
    const after = await db.asAdmin((query) => query(`select id from ai_messages where conversation_id = $1`, [conversationId]));
    expect(after.rows).toHaveLength(0);
  });

  it("orgB never sees orgA's conversation regardless of ownership rules", async () => {
    await db.asUser(outsider);
    const result = await db.query(`select * from ai_conversations where organization_id = $1`, [orgA]);
    expect(result.rows).toHaveLength(0);
    expect(orgB).not.toBe(orgA);
  });
});
