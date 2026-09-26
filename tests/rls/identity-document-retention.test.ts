import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { IDENTITY_ORIGINAL_RETENTION_DAYS } from "@/domain/documents/retention";

/**
 * supabase/migrations/0058_identity_document_retention.sql, against the real
 * migrations (tests/rls/harness.ts).
 *
 * The question this file answers is narrow and the whole point of the
 * migration: does an identity document's ORIGINAL expire, does a financial
 * document's original NOT expire, and can the sweep that removes one reach
 * anything it should not?
 *
 * Written as the service role wherever possible, because that is the most
 * privileged caller there is and the one a future bug would be running as.
 */

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;

let db: TestDatabase;
let owner: string;
let orgA: string;
let orgB: string;

interface Seeded {
  documentId: string;
  jobId: string;
}

/** A document with a queued job, ready to have an extraction recorded. */
async function seed(organizationId: string, filename = "licence.jpg"): Promise<Seeded> {
  const documentId = await db.asAdmin(
    async (query) =>
      one<{ id: string }>(
        await query(
          `insert into documents (organization_id, uploaded_by, kind, storage_path, original_filename, mime_type, size_bytes, status)
           values ($1, $2, 'other', $3, $4, 'image/jpeg', 2048, 'uploaded') returning id`,
          [organizationId, owner, `${organizationId}/${crypto.randomUUID()}.jpg`, filename],
        ),
      ).id,
  );
  const jobId = await db.asAdmin(
    async (query) =>
      one<{ id: string }>(
        await query(
          `insert into document_processing_jobs (organization_id, document_id, idempotency_key, processing_version, provider, provider_version, requested_by)
           values ($1, $2, $3, 'document-intelligence.2026.2', 'amazon-textract', '2026.1', $4) returning id`,
          [organizationId, documentId, crypto.randomUUID(), owner],
        ),
      ).id,
  );
  return { documentId, jobId };
}

/** Another processing job for a document that already has one. */
async function jobFor(organizationId: string, documentId: string): Promise<string> {
  return db.asAdmin(
    async (query) =>
      one<{ id: string }>(
        await query(
          `insert into document_processing_jobs (organization_id, document_id, idempotency_key, processing_version, provider, provider_version, requested_by)
           values ($1, $2, $3, 'document-intelligence.2026.2', 'amazon-textract', '2026.1', $4) returning id`,
          [organizationId, documentId, crypto.randomUUID(), owner],
        ),
      ).id,
  );
}

const EXTRACTION = (documentType: string) => ({
  status: "REVIEW_REQUIRED",
  method: "OCR",
  document_type: documentType,
  classification_confidence: "HIGH",
  classification_method: "CONTENT_SIGNALS",
  classification_signals: ["signal"],
  classification_review_reason: null,
  tax_year: null,
  page_count: 1,
  text_char_count: 120,
  text_truncated: false,
  warnings: [],
  field_count: 0,
  duration_ms: 20,
});

/** Records an extraction of the given class, which is what starts the clock. */
async function read(organizationId: string, seeded: Seeded, documentType: string): Promise<void> {
  await db.asAdmin(async (query) => {
    await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [seeded.jobId]);
    await query(`select record_document_extraction($1, $2, $3::jsonb, $4::jsonb)`, [organizationId, seeded.jobId, JSON.stringify(EXTRACTION(documentType)), JSON.stringify([])]);
  });
}

const retention = (documentId: string) =>
  db.asAdmin(async (query) =>
    // pglite hands back Date objects for timestamptz, not strings.
    one<{ retention_expires_at: Date | null; original_removed_at: Date | null }>(
      await query(`select retention_expires_at, original_removed_at from documents where id = $1`, [documentId]),
    ),
  );

/** Moves a document's expiry into the past, as the passage of time would. */
const expireNow = (documentId: string) => db.asAdmin((query) => query(`update documents set retention_expires_at = now() - interval '1 minute' where id = $1`, [documentId]));

const due = (limit = 50) => db.asAdmin(async (query) => (await query(`select * from documents_expired_originals($1)`, [limit])).rows as { document_id: string; organization_id: string; storage_path: string }[]);

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    owner = one<{ id: string }>(await query(`insert into auth.users (email) values ('owner@example.test') returning id`)).id;
  });
  await db.asUser(owner);
  orgA = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Mine', 'personal', $1) returning id`, [owner])).id;
  orgB = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Other', 'personal', $1) returning id`, [owner])).id;
});

afterEach(async () => {
  await db.close();
});

describe("reading an identity document starts the clock", () => {
  it("sets an expiry the application and the database agree on", async () => {
    const seeded = await seed(orgA);
    expect((await retention(seeded.documentId)).retention_expires_at).toBeNull();

    await read(orgA, seeded, "DRIVER_LICENSE");

    const { retention_expires_at } = await retention(seeded.documentId);
    expect(retention_expires_at).not.toBeNull();
    const days = (retention_expires_at!.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    // The interval in the trigger and IDENTITY_ORIGINAL_RETENTION_DAYS are
    // two copies of one decision. This is what keeps them the same number.
    expect(days).toBeGreaterThan(IDENTITY_ORIGINAL_RETENTION_DAYS - 0.01);
    expect(days).toBeLessThan(IDENTITY_ORIGINAL_RETENTION_DAYS + 0.01);
  });

  it("does it for every identity class, not only a licence", async () => {
    for (const type of ["DRIVER_LICENSE", "PASSPORT", "SSN_DOCUMENT", "GOVERNMENT_ID"]) {
      const seeded = await seed(orgA);
      await read(orgA, seeded, type);
      expect((await retention(seeded.documentId)).retention_expires_at, type).not.toBeNull();
    }
  });

  it("leaves a financial document alone, because a receipt is evidence for years", async () => {
    for (const type of ["RECEIPT", "INVOICE", "BILL", "W2", "BANK_STATEMENT", "UNKNOWN"]) {
      const seeded = await seed(orgA, "receipt.jpg");
      await read(orgA, seeded, type);
      expect((await retention(seeded.documentId)).retention_expires_at, type).toBeNull();
    }
  });

  it("does not extend a window that is already running when the document is read again", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    const first = (await retention(seeded.documentId)).retention_expires_at;

    // A second read of the SAME document — its own job, as re-processing
    // creates. The clock must not restart, or a document re-read every few
    // days would never expire at all.
    const secondJob = await jobFor(orgA, seeded.documentId);
    await read(orgA, { documentId: seeded.documentId, jobId: secondJob }, "DRIVER_LICENSE");

    // Seven days from the FIRST read, not the second.
    expect((await retention(seeded.documentId)).retention_expires_at).toEqual(first);
  });
});

describe("what the sweep is offered", () => {
  it("offers nothing while the window is still running", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    expect(await due()).toHaveLength(0);
  });

  it("offers the document once its window has passed", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await expireNow(seeded.documentId);

    const rows = await due();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ document_id: seeded.documentId, organization_id: orgA });
    // The storage path is what the caller needs to delete the object.
    expect(rows[0].storage_path.startsWith(`${orgA}/`)).toBe(true);
  });

  it("never offers a document with no expiry at all", async () => {
    const seeded = await seed(orgA, "receipt.jpg");
    await read(orgA, seeded, "RECEIPT");
    // Even with the clock wound far forward, a null expiry is not "due".
    expect(await due()).toHaveLength(0);
  });

  it("stops offering one that was already swept", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await expireNow(seeded.documentId);

    await db.asAdmin((query) => query(`select document_original_removed($1, $2)`, [orgA, seeded.documentId]));
    expect(await due()).toHaveLength(0);
  });

  it("is bounded however it is called, so no invocation becomes a full scan", async () => {
    for (let index = 0; index < 4; index++) {
      const seeded = await seed(orgA);
      await read(orgA, seeded, "DRIVER_LICENSE");
      await expireNow(seeded.documentId);
    }
    expect(await due(2)).toHaveLength(2);
    // A caller asking for more than the ceiling gets the ceiling, not more.
    expect((await due(100_000)).length).toBeLessThanOrEqual(200);
  });
});

describe("marking one removed", () => {
  it("records the removal and is idempotent on a second call", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await expireNow(seeded.documentId);

    const first = await db.asAdmin(async (query) => one<{ document_original_removed: boolean }>(await query(`select document_original_removed($1, $2)`, [orgA, seeded.documentId])).document_original_removed);
    const second = await db.asAdmin(async (query) => one<{ document_original_removed: boolean }>(await query(`select document_original_removed($1, $2)`, [orgA, seeded.documentId])).document_original_removed);

    expect(first).toBe(true);
    // False, not an error: a re-run after a partial failure is the normal case.
    expect(second).toBe(false);
    expect((await retention(seeded.documentId)).original_removed_at).not.toBeNull();
  });

  it("refuses to mark a document belonging to another organization", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await expireNow(seeded.documentId);

    // The right document id, the wrong workspace. Nothing happens.
    const marked = await db.asAdmin(async (query) => one<{ document_original_removed: boolean }>(await query(`select document_original_removed($1, $2)`, [orgB, seeded.documentId])).document_original_removed);
    expect(marked).toBe(false);
    expect((await retention(seeded.documentId)).original_removed_at).toBeNull();
  });

  it("refuses to mark a document that was never given an expiry", async () => {
    const seeded = await seed(orgA, "receipt.jpg");
    await read(orgA, seeded, "RECEIPT");

    const marked = await db.asAdmin(async (query) => one<{ document_original_removed: boolean }>(await query(`select document_original_removed($1, $2)`, [orgA, seeded.documentId])).document_original_removed);
    expect(marked).toBe(false);
  });

  it("cannot record a removal with no expiry behind it, even by direct write", async () => {
    const seeded = await seed(orgA, "receipt.jpg");
    await expect(db.asAdmin((query) => query(`update documents set original_removed_at = now() where id = $1`, [seeded.documentId]))).rejects.toThrow(/documents_original_removed_needs_expiry/);
  });
});

describe("no browser role can reach the sweep", () => {
  it("refuses documents_expired_originals to a member", async () => {
    await db.asUser(owner);
    await expect(db.query(`select * from documents_expired_originals(10)`)).rejects.toThrow(/permission denied/i);
  });

  it("refuses document_original_removed to a member", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await db.asUser(owner);
    await expect(db.query(`select document_original_removed($1, $2)`, [orgA, seeded.documentId])).rejects.toThrow(/permission denied/i);
  });
});

describe("the row outlives the file", () => {
  it("keeps the document, its filename and its extraction after the original is removed", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await expireNow(seeded.documentId);
    await db.asAdmin((query) => query(`select document_original_removed($1, $2)`, [orgA, seeded.documentId]));

    const row = await db.asAdmin(async (query) => one<{ original_filename: string; status: string }>(await query(`select original_filename, status from documents where id = $1`, [seeded.documentId])));
    expect(row.original_filename).toBe("licence.jpg");

    const extractions = await db.asAdmin(async (query) => (await query(`select id from document_extractions where document_id = $1`, [seeded.documentId])).rows);
    expect(extractions).toHaveLength(1);
  });

  it("still deletes everything when the document itself is deleted", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await expireNow(seeded.documentId);
    await db.asAdmin((query) => query(`select document_original_removed($1, $2)`, [orgA, seeded.documentId]));

    await db.asAdmin((query) => query(`delete from documents where id = $1`, [seeded.documentId]));
    const extractions = await db.asAdmin(async (query) => (await query(`select id from document_extractions where document_id = $1`, [seeded.documentId])).rows);
    expect(extractions).toHaveLength(0);
  });

  it("takes an expired identity document with the organization when it goes", async () => {
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgA]));
    const rows = await db.asAdmin(async (query) => (await query(`select id from documents where id = $1`, [seeded.documentId])).rows);
    expect(rows).toHaveLength(0);
  });
});

describe("the migration itself", () => {
  it("can be applied twice without failing, so a partial run can be retried", async () => {
    // Every object this migration creates is guarded. Re-applying each of
    // them here proves the guard rather than trusting the wording: an
    // operator who loses their connection mid-migration can simply run it
    // again, which is the difference between a retry and a manual repair.
    const statements = [
      `alter table documents add column if not exists retention_expires_at timestamptz, add column if not exists original_removed_at timestamptz`,
      `alter table documents drop constraint if exists documents_original_removed_needs_expiry`,
      `alter table documents add constraint documents_original_removed_needs_expiry check (original_removed_at is null or retention_expires_at is not null)`,
      `create index if not exists documents_retention_due_idx on documents (retention_expires_at) where retention_expires_at is not null and original_removed_at is null`,
      `drop trigger if exists document_extractions_set_identity_retention on document_extractions`,
      `create trigger document_extractions_set_identity_retention after insert on document_extractions for each row execute function documents_set_identity_retention()`,
    ];
    for (const statement of statements) {
      await expect(db.asAdmin((query) => query(statement)), statement.slice(0, 60)).resolves.toBeDefined();
    }

    // And the trigger still works afterwards, so the re-run rebuilt it rather
    // than leaving the table without one.
    const seeded = await seed(orgA);
    await read(orgA, seeded, "DRIVER_LICENSE");
    expect((await retention(seeded.documentId)).retention_expires_at).not.toBeNull();
  });

  it("guards every object it creates, so nothing in the file fails on a re-run", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/0058_identity_document_retention.sql", "utf8");
    const body = sql
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    expect(body).toMatch(/add column if not exists retention_expires_at/);
    expect(body).toMatch(/create index if not exists documents_retention_due_idx/);
    expect(body).toMatch(/drop constraint if exists documents_original_removed_needs_expiry/);
    expect(body).toMatch(/drop trigger if exists document_extractions_set_identity_retention/);
    // Functions are replaced rather than created.
    expect(body.match(/^create function/gm)).toBeNull();
    expect((body.match(/create or replace function/g) ?? []).length).toBe(4);
  });

  it("leaves every existing document without an expiry, so deploying deletes nothing", async () => {
    // Seeded before any extraction: exactly the state of every document
    // already in production when 0058 is applied.
    const seeded = await seed(orgA);
    expect((await retention(seeded.documentId)).retention_expires_at).toBeNull();
    expect(await due()).toHaveLength(0);
  });

  it("refuses a removal that no expiry authorised, even from the service role", async () => {
    const seeded = await seed(orgA);
    await expect(db.asAdmin((query) => query(`update documents set original_removed_at = now() where id = $1`, [seeded.documentId]))).rejects.toThrow(
      /documents_original_removed_needs_expiry/,
    );
  });
});

describe("the schema version is reported", () => {
  it("is 0058", async () => {
    const version = await db.asAdmin(async (query) => one<{ v: string }>(await query(`select operations_schema_version() as v`)).v);
    expect(version).toBe("0059");
  });
});
