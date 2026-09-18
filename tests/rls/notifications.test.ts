import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/** RLS coverage for supabase/migrations/0015_notifications.sql — a table
 *  added in Phase 2. Same real-migrations-against-PGlite approach as
 *  tests/rls/tenant-isolation.test.ts. */

let db: TestDatabase;
let userA: string;
let userB: string;
let orgA: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('a@example.com'), ('b@example.com') returning id`);
    [userA, userB] = users.rows.map((r: unknown) => (r as { id: string }).id);
  });

  await db.asUser(userA);
  const org = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'business', $1) returning id`, [
    userA,
  ]);
  orgA = (org.rows[0] as { id: string }).id;

  // userB joins orgA as a regular member, to test org-wide vs targeted visibility.
  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'employee')`, [orgA, userB]));
});

afterEach(async () => {
  await db.close();
});

describe("notifications visibility", () => {
  it("an org-wide notification (user_id null) is visible to every member", async () => {
    await db.asAdmin((query) =>
      query(`insert into notifications (organization_id, kind, title) values ($1, 'overdue_invoice', 'Invoice overdue')`, [orgA]),
    );

    await db.asUser(userA);
    expect((await db.query(`select * from notifications`)).rows).toHaveLength(1);

    await db.asUser(userB);
    expect((await db.query(`select * from notifications`)).rows).toHaveLength(1);
  });

  it("a targeted notification is visible only to that user", async () => {
    await db.asAdmin((query) =>
      query(`insert into notifications (organization_id, user_id, kind, title) values ($1, $2, 'ai_recommendation', 'Just for you')`, [
        orgA,
        userA,
      ]),
    );

    await db.asUser(userA);
    expect((await db.query(`select * from notifications`)).rows).toHaveLength(1);

    await db.asUser(userB);
    expect((await db.query(`select * from notifications`)).rows).toHaveLength(0);
  });

  it("a non-member cannot see the organization's notifications at all", async () => {
    await db.asAdmin((query) =>
      query(`insert into notifications (organization_id, kind, title) values ($1, 'financial_insight', 'Spending up')`, [orgA]),
    );

    await db.asAdmin(async (query) => {
      const outsider = await query(`insert into auth.users (email) values ('outsider@example.com') returning id`);
      return (outsider.rows[0] as { id: string }).id;
    });
    const outsiderResult = await db.asAdmin((query) => query(`select id from auth.users where email = 'outsider@example.com'`));
    const outsiderId = (outsiderResult.rows[0] as { id: string }).id;

    await db.asUser(outsiderId);
    expect((await db.query(`select * from notifications`)).rows).toHaveLength(0);
  });

  it("a client cannot insert a notification directly (no INSERT policy)", async () => {
    await db.asUser(userA);
    await expect(
      db.query(`insert into notifications (organization_id, kind, title) values ($1, 'financial_insight', 'Fake')`, [orgA]),
    ).rejects.toThrow();
  });
});

describe("notification_reads", () => {
  let notificationId: string;

  beforeEach(async () => {
    const result = await db.asAdmin((query) =>
      query(`insert into notifications (organization_id, kind, title) values ($1, 'financial_insight', 'Spending up') returning id`, [orgA]),
    );
    notificationId = (result.rows[0] as { id: string }).id;
  });

  it("a user can mark their own read receipt", async () => {
    await db.asUser(userA);
    const result = await db.query(`insert into notification_reads (notification_id, user_id) values ($1, $2) returning notification_id`, [
      notificationId,
      userA,
    ]);
    expect(result.rows).toHaveLength(1);
  });

  it("a user cannot mark a read receipt on another user's behalf", async () => {
    await db.asUser(userA);
    await expect(
      db.query(`insert into notification_reads (notification_id, user_id) values ($1, $2)`, [notificationId, userB]),
    ).rejects.toThrow();
  });

  it("a user cannot see another user's read receipts", async () => {
    await db.asAdmin((query) => query(`insert into notification_reads (notification_id, user_id) values ($1, $2)`, [notificationId, userA]));

    await db.asUser(userB);
    expect((await db.query(`select * from notification_reads where notification_id = $1`, [notificationId])).rows).toHaveLength(0);
  });
});
