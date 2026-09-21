import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * Verifies 0021_ai_actions_insert_hardening.sql: no client role can
 * insert an `ai_actions` row directly, regardless of their org role —
 * only the admin-client-backed server flow can (see that migration's
 * module comment and src/server/db/repositories/ai-conversations.ts
 * #createPendingAction).
 */

let db: TestDatabase;
let owner: string;
let viewer: string;
let orgA: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('owner@example.com'), ('viewer@example.com') returning id`);
    [owner, viewer] = users.rows.map((r: unknown) => (r as { id: string }).id);
  });

  await db.asUser(owner);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'personal', $1) returning id`, [owner]);
  orgA = (org.rows[0] as { id: string }).id;

  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'viewer')`, [orgA, viewer]));
});

afterEach(async () => {
  await db.close();
});

describe("ai_actions insert hardening", () => {
  it("blocks even the organization owner from inserting an ai_actions row directly", async () => {
    await db.asUser(owner);
    await expect(
      db.query(
        `insert into ai_actions (organization_id, operation_mode, tool_name, input) values ($1, 'delete', 'deleteTransaction', '{}')`,
        [orgA],
      ),
    ).rejects.toThrow();
  });

  it("blocks a viewer from planting a fake pending action", async () => {
    await db.asUser(viewer);
    await expect(
      db.query(
        `insert into ai_actions (organization_id, operation_mode, tool_name, input) values ($1, 'write', 'createDraftInvoice', '{}')`,
        [orgA],
      ),
    ).rejects.toThrow();
  });

  it("an admin-privileged session (SECURITY DEFINER-equivalent in this test) can still write, matching the server-side flow", async () => {
    // asAdmin here plays the role of the ADMIN client the real
    // createPendingAction() uses — bypasses RLS by design.
    const result = await db.asAdmin((query) =>
      query(`insert into ai_actions (organization_id, operation_mode, tool_name, input) values ($1, 'write', 'createDraftInvoice', '{}') returning id`, [
        orgA,
      ]),
    );
    expect(result.rows).toHaveLength(1);
  });
});
