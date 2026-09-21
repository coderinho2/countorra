import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/** RLS coverage for supabase/migrations/0018_document_storage.sql — the
 *  private Storage bucket receipts/invoices/statements are uploaded to.
 *  Tenant isolation here matters as much as any table's, since a leak
 *  would expose someone's actual financial documents (product spec §21,
 *  §37). */

let db: TestDatabase;
let ownerA: string;
let ownerB: string;
let employeeA: string;
let orgA: string;
let orgB: string;

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin(async (query) => {
    const users = await query(`insert into auth.users (email) values ('a@example.com'), ('b@example.com'), ('emp@example.com') returning id`);
    [ownerA, ownerB, employeeA] = users.rows.map((r: unknown) => (r as { id: string }).id);
  });

  await db.asUser(ownerA);
  const a = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org A', 'personal', $1) returning id`, [ownerA]);
  orgA = (a.rows[0] as { id: string }).id;

  await db.asUser(ownerB);
  const b = await db.query(`insert into organizations (name, entity_type, created_by) values ('Org B', 'personal', $1) returning id`, [ownerB]);
  orgB = (b.rows[0] as { id: string }).id;

  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'employee')`, [orgA, employeeA]));
});

afterEach(async () => {
  await db.close();
});

describe("storage.objects tenant isolation", () => {
  it("a member can upload to their own organization's folder", async () => {
    await db.asUser(ownerA);
    const result = await db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1) returning id`, [`${orgA}/receipt.pdf`]);
    expect(result.rows).toHaveLength(1);
  });

  it("a member cannot upload into another organization's folder", async () => {
    await db.asUser(ownerA);
    await expect(db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${orgB}/receipt.pdf`])).rejects.toThrow();
  });

  it("a member of org A cannot read a document uploaded to org B's folder", async () => {
    await db.asUser(ownerB);
    await db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1)`, [`${orgB}/statement.pdf`]);

    await db.asUser(ownerA);
    const result = await db.query(`select * from storage.objects where name = $1`, [`${orgB}/statement.pdf`]);
    expect(result.rows).toHaveLength(0);
  });

  it("an employee (write-capable role) can upload documents", async () => {
    await db.asUser(employeeA);
    const result = await db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1) returning id`, [`${orgA}/invoice.pdf`]);
    expect(result.rows).toHaveLength(1);
  });

  it("only owner/admin/accountant can delete a document, not employee", async () => {
    const inserted = await db.asAdmin((query) => query(`insert into storage.objects (bucket_id, name) values ('documents', $1) returning id`, [`${orgA}/bill.pdf`]));
    const objectId = (inserted.rows[0] as { id: string }).id;

    await db.asUser(employeeA);
    const attempt = await db.query(`delete from storage.objects where id = $1 returning id`, [objectId]);
    expect(attempt.rows).toHaveLength(0);

    await db.asUser(ownerA);
    const ownerAttempt = await db.query(`delete from storage.objects where id = $1 returning id`, [objectId]);
    expect(ownerAttempt.rows).toHaveLength(1);
  });
});

/**
 * The upload lifecycle at the database level
 * (supabase/migrations/0030_document_upload_lifecycle_states.sql and 0031).
 *
 * The application filters `status = 'uploaded'` in one place
 * (src/server/db/repositories/documents.ts). These assertions are the layer
 * underneath that: that the states exist, that a row which forgets to declare
 * one lands invisible rather than visible, and that RLS still scopes all of it
 * per organization.
 */
describe("document upload lifecycle", () => {
  const insertDocument = (organizationId: string, columns = "", values = "") =>
    db.query(
      `insert into documents (organization_id, kind, storage_path${columns})
       values ($1, 'receipt', $2${values}) returning id, status`,
      [organizationId, `${organizationId}/${crypto.randomUUID()}.pdf`],
    );

  it("defaults a new row to pending, not uploaded", async () => {
    // Fail safe. The old default was 'uploaded', so any insert that omitted a
    // status produced a row the product would immediately show and sign a
    // download URL for, before any file was confirmed to exist.
    await db.asUser(ownerA);
    const result = await insertDocument(orgA);
    expect((result.rows[0] as { status: string }).status).toBe("pending");
  });

  it("accepts both new lifecycle states", async () => {
    await db.asUser(ownerA);
    for (const status of ["pending", "uploaded", "rejected"]) {
      const result = await insertDocument(orgA, ", status", `, '${status}'`);
      expect((result.rows[0] as { status: string }).status, status).toBe(status);
    }
  });

  it("still refuses a status that is not in the enum", async () => {
    await db.asUser(ownerA);
    await expect(insertDocument(orgA, ", status", `, 'definitely_fine'`)).rejects.toThrow();
  });

  it("keeps pending and rejected rows out of the filtered read the product uses", async () => {
    await db.asUser(ownerA);
    await insertDocument(orgA, ", status", `, 'pending'`);
    await insertDocument(orgA, ", status", `, 'rejected'`);
    await insertDocument(orgA, ", status", `, 'uploaded'`);

    const visible = await db.query(`select id from documents where organization_id = $1 and status = 'uploaded'`, [orgA]);
    const all = await db.query(`select id from documents where organization_id = $1`, [orgA]);

    expect(all.rows).toHaveLength(3);
    expect(visible.rows).toHaveLength(1);
  });

  it("scopes pending rows by organization like every other row", async () => {
    // An invisible row is not an unscoped one — a pending upload still must
    // not be readable, or confirmable, by another tenant.
    await db.asUser(ownerB);
    await insertDocument(orgB, ", status", `, 'pending'`);

    await db.asUser(ownerA);
    const leaked = await db.query(`select id from documents where organization_id = $1`, [orgB]);
    expect(leaked.rows).toHaveLength(0);
  });

  it("indexes the reclaim query rather than scanning every document", async () => {
    const index = await db.asAdmin((query) =>
      query(`select indexdef from pg_indexes where tablename = 'documents' and indexname = 'documents_incomplete_created_idx'`),
    );
    expect(index.rows).toHaveLength(1);
    expect((index.rows[0] as { indexdef: string }).indexdef).toMatch(/pending/);
  });
});
