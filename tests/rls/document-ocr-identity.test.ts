import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * supabase/migrations/0055_document_ocr_identity.sql, against the real
 * migrations (tests/rls/harness.ts).
 *
 * The application refuses to store an identifier from an identity document
 * (src/domain/documents/intelligence/identity.ts). These cases prove the
 * DATABASE refuses too — by writing as the service role, which is the most
 * privileged caller there is and the one a future bug would be running as.
 * If the constraints hold against it, no application change can quietly start
 * persisting a licence number.
 */

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;

let db: TestDatabase;
let owner: string;
let org: string;
let documentId: string;
let extractionId: string;

const EXTRACTION = (fieldCount: number, overrides: Record<string, unknown> = {}) => ({
  status: "REVIEW_REQUIRED",
  method: "OCR",
  document_type: "DRIVER_LICENSE",
  classification_confidence: "HIGH",
  classification_method: "CONTENT_SIGNALS",
  classification_signals: ["drivers-license"],
  classification_review_reason: null,
  tax_year: null,
  page_count: 1,
  text_char_count: 120,
  text_truncated: false,
  warnings: ["IDENTITY_DOCUMENT"],
  field_count: fieldCount,
  duration_ms: 20,
  ...overrides,
});

const IDENTITY_FIELD = (overrides: Record<string, unknown> = {}) => ({
  schema_id: "textract-identity.2026.1",
  field_key: "document_number_present",
  label: "Document number",
  section: "IDENTITY",
  box: null,
  value_kind: "PRESENCE",
  raw_value: "••••4567",
  normalized_decimal: null,
  amount_minor: null,
  currency: null,
  currency_source: null,
  normalized_date: null,
  normalized_text: "••••4567",
  review_state: "HIGH_CONFIDENCE",
  review_reason: null,
  provider_confidence: 0.99,
  page_number: null,
  line_index: null,
  source_position: null,
  method: "textract-identity/field",
  ...overrides,
});

/** Writes an extraction as the service role — the privileged path. */
async function record(fields: Record<string, unknown>[]): Promise<void> {
  await db.asAdmin(async (query) => {
    await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [jobId]);
    await query(`select record_document_extraction($1, $2, $3::jsonb, $4::jsonb)`, [org, jobId, JSON.stringify(EXTRACTION(fields.length)), JSON.stringify(fields)]);
  });
}

let jobId: string;

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async (query) => {
    owner = one<{ id: string }>(await query(`insert into auth.users (email) values ('owner@example.test') returning id`)).id;
  });
  await db.asUser(owner);
  org = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Mine', 'personal', $1) returning id`, [owner])).id;
  documentId = one<{ id: string }>(
    await db.query(
      `insert into documents (organization_id, uploaded_by, kind, storage_path, original_filename, mime_type, size_bytes, status)
       values ($1, $2, 'other', $3, 'licence.jpg', 'image/jpeg', 2048, 'uploaded') returning id`,
      [org, owner, `${org}/${crypto.randomUUID()}.jpg`],
    ),
  ).id;
  jobId = await db.asAdmin(async (query) =>
    one<{ id: string }>(
      await query(
        `insert into document_processing_jobs (organization_id, document_id, idempotency_key, processing_version, provider, provider_version, requested_by)
         values ($1, $2, 'k1', 'document-intelligence.2026.2', 'amazon-textract', '2026.1', $3) returning id`,
        [org, documentId, owner],
      ),
    ).id,
  );
});

afterEach(async () => {
  await db.close();
});

describe("the new document classes are accepted", () => {
  it.each(["BILL", "DRIVER_LICENSE", "PASSPORT", "SSN_DOCUMENT", "GOVERNMENT_ID"])("stores a %s extraction", async (documentType) => {
    await db.asAdmin(async (query) => {
      await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [jobId]);
      await query(`select record_document_extraction($1, $2, $3::jsonb, '[]'::jsonb)`, [org, jobId, JSON.stringify(EXTRACTION(0, { document_type: documentType }))]);
    });
    extractionId = await db.asAdmin(async (query) => one<{ id: string }>(await query(`select id from document_extractions where job_id = $1`, [jobId])).id);
    expect(extractionId).toBeTruthy();
  });

  it("still refuses a type nobody defined", async () => {
    await expect(
      db.asAdmin(async (query) => {
        await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [jobId]);
        await query(`select record_document_extraction($1, $2, $3::jsonb, '[]'::jsonb)`, [org, jobId, JSON.stringify(EXTRACTION(0, { document_type: "BIOMETRIC_SCAN" }))]);
      }),
    ).rejects.toThrow();
  });
});

describe("an identity field may not carry money", () => {
  it("accepts a masked, money-free identity field", async () => {
    await record([IDENTITY_FIELD()]);
    expect(await db.asAdmin(async (query) => one<{ n: number }>(await query(`select count(*)::int as n from document_extracted_fields where section = 'IDENTITY'`)).n)).toBe(1);
  });

  it("refuses an amount on an identity field, even from the service role", async () => {
    await expect(record([IDENTITY_FIELD({ value_kind: "MONEY", amount_minor: 12_500, currency: "USD", normalized_decimal: "125.00" })])).rejects.toThrow(
      /identity_no_money|violates check constraint/i,
    );
  });
});

describe("an identity field may not carry an identifier", () => {
  it("refuses a run of five or more digits in the stored value", async () => {
    await expect(record([IDENTITY_FIELD({ raw_value: "Y1234567", normalized_text: "Y1234567" })])).rejects.toThrow(/identity_no_identifiers|violates check constraint/i);
  });

  it("refuses it in normalized_text alone", async () => {
    await expect(record([IDENTITY_FIELD({ normalized_text: "987654321" })])).rejects.toThrow(/identity_no_identifiers|violates check constraint/i);
  });

  it("allows a date, which is digits but not an identifier", async () => {
    await record([IDENTITY_FIELD({ field_key: "expires_on", label: "Expires", value_kind: "DATE", raw_value: "2030-04-12", normalized_text: null, normalized_date: "2030-04-12" })]);
    expect(await db.asAdmin(async (query) => one<{ n: number }>(await query(`select count(*)::int as n from document_extracted_fields where field_key = 'expires_on'`)).n)).toBe(1);
  });

  it("allows the four-digit masked tail the product actually shows", async () => {
    await record([IDENTITY_FIELD()]);
    expect(
      await db.asAdmin(async (query) => one<{ raw: string }>(await query(`select raw_value as raw from document_extracted_fields where section = 'IDENTITY'`)).raw),
    ).toBe("••••4567");
  });

  it("still refuses anything SSN-shaped, which 0046 already forbade everywhere", async () => {
    await expect(record([IDENTITY_FIELD({ raw_value: "123-45-6789", normalized_text: null })])).rejects.toThrow(/no_ssn|violates check constraint/i);
  });

  it("leaves financial fields alone — the rule is scoped to IDENTITY", async () => {
    await record([
      IDENTITY_FIELD({
        field_key: "total",
        label: "Total",
        section: "TOTALS",
        value_kind: "MONEY",
        raw_value: "1234567.00",
        normalized_text: null,
        normalized_decimal: "1234567.00",
        amount_minor: 123_456_700,
        currency: "USD",
        currency_source: "DOCUMENT_TEXT",
      }),
    ]);
    expect(await db.asAdmin(async (query) => one<{ n: number }>(await query(`select count(*)::int as n from document_extracted_fields where section = 'TOTALS'`)).n)).toBe(1);
  });
});

describe("tenant isolation is unchanged", () => {
  it("keeps identity fields readable only by the workspace they belong to", async () => {
    await record([IDENTITY_FIELD()]);
    const outsider = await db.asAdmin(async (query) => one<{ id: string }>(await query(`insert into auth.users (email) values ('outsider@example.test') returning id`)).id);
    await db.asUser(outsider);
    expect((await db.query(`select id from document_extracted_fields`)).rows).toEqual([]);
    await db.asUser(owner);
    expect((await db.query(`select id from document_extracted_fields`)).rows).toHaveLength(1);
  });
});

describe("deleting the document deletes everything read from it", () => {
  it("leaves no extraction, no field and no job behind", async () => {
    await record([IDENTITY_FIELD()]);

    const before = await db.asAdmin(async (query) => ({
      fields: one<{ n: number }>(await query(`select count(*)::int as n from document_extracted_fields where document_id = $1`, [documentId])).n,
      extractions: one<{ n: number }>(await query(`select count(*)::int as n from document_extractions where document_id = $1`, [documentId])).n,
      jobs: one<{ n: number }>(await query(`select count(*)::int as n from document_processing_jobs where document_id = $1`, [documentId])).n,
    }));
    expect(before).toEqual({ fields: 1, extractions: 1, jobs: 1 });

    // Deleted by the OWNER through RLS, which is how it actually happens.
    await db.asUser(owner);
    await db.query(`delete from documents where id = $1`, [documentId]);

    const after = await db.asAdmin(async (query) => ({
      fields: one<{ n: number }>(await query(`select count(*)::int as n from document_extracted_fields where document_id = $1`, [documentId])).n,
      extractions: one<{ n: number }>(await query(`select count(*)::int as n from document_extractions where document_id = $1`, [documentId])).n,
      jobs: one<{ n: number }>(await query(`select count(*)::int as n from document_processing_jobs where document_id = $1`, [documentId])).n,
    }));
    // Nothing is orphaned: no masked tail, no document class, no job row.
    expect(after).toEqual({ fields: 0, extractions: 0, jobs: 0 });
  });

  it("leaves nothing behind when the whole workspace goes", async () => {
    await record([IDENTITY_FIELD()]);
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [org]));
    const remaining = await db.asAdmin(async (query) =>
      one<{ n: number }>(
        await query(
          `select (select count(*) from document_extracted_fields) + (select count(*) from document_extractions) + (select count(*) from document_processing_jobs) as n`,
        ),
      ).n,
    );
    expect(Number(remaining)).toBe(0);
  });
});

describe("failure categories (0056)", () => {
  it.each([
    "UNSUPPORTED_DOCUMENT",
    "DOCUMENT_TOO_LARGE",
    "DOCUMENT_UNREADABLE",
    "PROVIDER_AUTH_ERROR",
    "PROVIDER_THROTTLED",
    "PROVIDER_UNAVAILABLE",
  ])("accepts %s", async (category) => {
    await db.asAdmin(async (query) => {
      await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [jobId]);
      await query(`update document_processing_jobs set status = 'FAILED', failure_category = $2, failure_message = 'x', completed_at = now() where id = $1`, [jobId, category]);
    });
    expect(
      await db.asAdmin(async (query) => one<{ c: string }>(await query(`select failure_category as c from document_processing_jobs where id = $1`, [jobId])).c),
    ).toBe(category);
  });

  it("still accepts the categories 0046 defined, so old rows stay legal", async () => {
    await db.asAdmin(async (query) => {
      await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [jobId]);
      await query(`update document_processing_jobs set status = 'FAILED', failure_category = 'PROVIDER_ERROR', failure_message = 'x', completed_at = now() where id = $1`, [jobId]);
    });
    expect(
      await db.asAdmin(async (query) => one<{ c: string }>(await query(`select failure_category as c from document_processing_jobs where id = $1`, [jobId])).c),
    ).toBe("PROVIDER_ERROR");
  });

  it("refuses a category nobody defined", async () => {
    await expect(
      db.asAdmin(async (query) => {
        await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [jobId]);
        await query(`update document_processing_jobs set status = 'FAILED', failure_category = 'AWS_ACCESS_DENIED', failure_message = 'x', completed_at = now() where id = $1`, [jobId]);
      }),
    ).rejects.toThrow();
  });
});

describe("the schema version is reported", () => {
  it("is 0055", async () => {
    const version = await db.asAdmin(async (query) => {
      await query("set role service_role");
      try {
        return one<{ v: string }>(await query(`select operations_schema_version() as v`)).v;
      } finally {
        await query("reset role");
      }
    });
    expect(version).toBe("0056");
  });
});
