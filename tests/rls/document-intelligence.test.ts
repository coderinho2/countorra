import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * 0046 — document intelligence, against real Postgres with every migration.
 *
 * W, X: tenant isolation and read-only RLS for members.
 * AF: extractions and fields are immutable evidence, for every role.
 * E (database half): the job state machine is enforced by the trigger too.
 * U, V: an extracted value reaches Tax preparation only as a proposal carrying
 *       exactly what was extracted, with its provenance.
 * AG: deletion of a document, an organization and a user.
 */

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let db: TestDatabase;
let orgA: string;
let orgB: string;
let docA: string;
let docB: string;
let caseA: string;

const one = <T>(result: { rows: unknown[] }) => result.rows[0] as T;

async function insertDocument(orgId: string, owner: string): Promise<string> {
  return db.asAdmin(async (query) =>
    one<{ id: string }>(
      await query(
        `insert into documents (organization_id, uploaded_by, kind, storage_path, original_filename, mime_type, size_bytes, status)
         values ($1, $2, 'tax_form', $3, 'synthetic-w2.pdf', 'application/pdf', 1024, 'uploaded') returning id`,
        [orgId, owner, `${orgId}/${crypto.randomUUID()}.pdf`],
      ),
    ).id,
  );
}

const EXTRACTION = (fieldCount: number, overrides: Record<string, unknown> = {}) => ({
  status: "SUCCEEDED",
  method: "PDF_TEXT_LAYER",
  document_type: "W2",
  classification_confidence: "HIGH",
  classification_method: "CONTENT_SIGNALS",
  classification_signals: ["form-w2", "wage-and-tax-statement"],
  classification_review_reason: null,
  tax_year: 2026,
  page_count: 1,
  text_char_count: 640,
  text_truncated: false,
  warnings: [],
  field_count: fieldCount,
  duration_ms: 12,
  ...overrides,
});

const FIELD = (overrides: Record<string, unknown> = {}) => ({
  schema_id: "w2.2026.1",
  field_key: "box1_wages",
  label: "Wages, tips, other compensation",
  section: "INCOME",
  box: "1",
  value_kind: "MONEY",
  raw_value: "85,000.00",
  normalized_decimal: "85000.00",
  amount_minor: 8_500_000,
  currency: "USD",
  currency_source: "FORM_DEFINITION",
  normalized_date: null,
  normalized_text: null,
  review_state: "MEDIUM_CONFIDENCE",
  review_reason: null,
  provider_confidence: null,
  page_number: 1,
  line_index: 7,
  source_position: { x: 40, y: 626, width: null, height: null, units: "pdf_points" },
  method: "w2.2026.1/label-column-below",
  ...overrides,
});

async function queuedJob(orgId: string, documentId: string, key = "k1", requestedBy = OWNER_A): Promise<string> {
  return db.asAdmin(async (query) =>
    one<{ id: string }>(
      await query(
        `insert into document_processing_jobs (organization_id, document_id, idempotency_key, processing_version, provider, provider_version, requested_by)
         values ($1, $2, $3, 'document-intelligence.2026.1', 'pdf-text-layer', '1.0.0', $4) returning id`,
        [orgId, documentId, `${documentId}|${key}`, requestedBy],
      ),
    ).id,
  );
}

async function startJob(jobId: string) {
  await db.asAdmin((query) => query(`update document_processing_jobs set status = 'PROCESSING', attempts = attempts + 1, started_at = now() where id = $1`, [jobId]));
}

async function record(orgId: string, jobId: string, fields: Record<string, unknown>[] = [FIELD()], extraction = EXTRACTION(fields.length)): Promise<string> {
  return db.asAdmin(async (query) =>
    one<{ id: string }>(await query(`select record_document_extraction($1, $2, $3::jsonb, $4::jsonb) as id`, [orgId, jobId, JSON.stringify(extraction), JSON.stringify(fields)])).id,
  );
}

/** A document read once, successfully: job, extraction and one field. */
async function readDocument(orgId: string, documentId: string) {
  const jobId = await queuedJob(orgId, documentId);
  await startJob(jobId);
  const extractionId = await record(orgId, jobId);
  const fieldId = await db.asAdmin(async (query) => one<{ id: string }>(await query(`select id from document_extracted_fields where extraction_id = $1`, [extractionId])).id);
  return { jobId, extractionId, fieldId };
}

async function count(table: string, where = "", params: unknown[] = []) {
  return db.asAdmin(async (query) => one<{ n: number }>(await query(`select count(*)::int as n from ${table} ${where}`, params)).n);
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin((query) =>
    query(`insert into auth.users (id, email) values ($1, 'owner-a@example.test'), ($2, 'member-a@example.test'), ($3, 'owner-b@example.test')`, [OWNER_A, MEMBER_A, OWNER_B]),
  );
  await db.asUser(OWNER_A);
  orgA = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Synthetic A', 'personal', $1) returning id`, [OWNER_A])).id;
  await db.asUser(OWNER_B);
  orgB = one<{ id: string }>(await db.query(`insert into organizations (name, entity_type, created_by) values ('Synthetic B', 'personal', $1) returning id`, [OWNER_B])).id;
  await db.asAdmin((query) => query(`insert into memberships (organization_id, user_id, role) values ($1, $2, 'employee')`, [orgA, MEMBER_A]));
  docA = await insertDocument(orgA, OWNER_A);
  docB = await insertDocument(orgB, OWNER_B);
  caseA = await db.asAdmin(async (query) =>
    one<{ id: string }>(await query(`insert into tax_preparation_cases (organization_id, tax_year, status, filing_status, created_by) values ($1, 2026, 'COLLECTING', 'single', $2) returning id`, [orgA, OWNER_A])).id,
  );
});

afterEach(async () => {
  await db.close();
});

describe("placeholder tables are gone", () => {
  it("no longer has document_extracted_data, whose member-writable confirmation flag duplicated Tax preparation", async () => {
    const result = await db.asAdmin((query) => query(`select to_regclass('public.document_extracted_data') as t`));
    expect(one<{ t: string | null }>(result).t).toBeNull();
  });
});

describe("members read their own organization's results, and nothing else", () => {
  it("shows a member their jobs, extractions and fields", async () => {
    await readDocument(orgA, docA);
    await db.asUser(MEMBER_A);
    expect((await db.query(`select id from document_processing_jobs`)).rows).toHaveLength(1);
    expect((await db.query(`select id from document_extractions`)).rows).toHaveLength(1);
    expect((await db.query(`select id from document_extracted_fields`)).rows).toHaveLength(1);
  });

  it("shows another organization's owner nothing", async () => {
    await readDocument(orgA, docA);
    await db.asUser(OWNER_B);
    expect((await db.query(`select id from document_processing_jobs`)).rows).toHaveLength(0);
    expect((await db.query(`select id from document_extractions`)).rows).toHaveLength(0);
    expect((await db.query(`select id from document_extracted_fields`)).rows).toHaveLength(0);
  });
});

describe("members cannot write results — extraction is never client-authoritative", () => {
  it("refuses a member inserting a job", async () => {
    await db.asUser(OWNER_A);
    await expect(
      db.query(
        `insert into document_processing_jobs (organization_id, document_id, idempotency_key, processing_version, provider, provider_version) values ($1, $2, 'x', 'v', 'p', '1')`,
        [orgA, docA],
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses a member recording an extraction through the database function", async () => {
    const jobId = await queuedJob(orgA, docA);
    await startJob(jobId);
    await db.asUser(OWNER_A);
    await expect(db.query(`select record_document_extraction($1, $2, $3::jsonb, $4::jsonb)`, [orgA, jobId, JSON.stringify(EXTRACTION(1)), JSON.stringify([FIELD()])])).rejects.toThrow(
      /permission denied/,
    );
    expect(await count("document_extractions")).toBe(0);
  });

  it("refuses a member changing or deleting an extracted value", async () => {
    await readDocument(orgA, docA);
    await db.asUser(OWNER_A);
    await expect(db.query(`update document_extracted_fields set amount_minor = 1`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from document_extractions`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`update document_processing_jobs set status = 'SUCCEEDED'`)).rejects.toThrow(/permission denied/);
  });
});

describe("history is immutable — even for the service role", () => {
  it("refuses updating or deleting an extraction or a field directly", async () => {
    const { extractionId } = await readDocument(orgA, docA);
    await db.asAdmin(async (query) => {
      await expect(query(`update document_extractions set tax_year = 2025 where id = $1`, [extractionId])).rejects.toThrow(/immutable/);
      await expect(query(`delete from document_extractions where id = $1`, [extractionId])).rejects.toThrow(/cannot be deleted directly/);
      await expect(query(`update document_extracted_fields set amount_minor = 1`)).rejects.toThrow(/immutable/);
      await expect(query(`delete from document_extracted_fields`)).rejects.toThrow(/cannot be deleted directly/);
      await expect(query(`delete from document_processing_jobs`)).rejects.toThrow(/cannot be deleted directly/);
    });
  });

  it("gives a second reading of the same document the next version, leaving the first intact", async () => {
    const first = await readDocument(orgA, docA);
    const job2 = await queuedJob(orgA, docA, "k2");
    await startJob(job2);
    const second = await record(orgA, job2, [FIELD({ amount_minor: 8_350_000, normalized_decimal: "83500.00", raw_value: "83,500.00" })]);
    const rows = await db.asAdmin((query) => query(`select id, version from document_extractions where document_id = $1 order by version`, [docA]));
    expect(rows.rows).toEqual([
      { id: first.extractionId, version: 1 },
      { id: second, version: 2 },
    ]);
    const original = await db.asAdmin((query) => query(`select amount_minor from document_extracted_fields where extraction_id = $1`, [first.extractionId]));
    expect(Number(one<{ amount_minor: number }>(original).amount_minor)).toBe(8_500_000);
  });

  it("refuses fields added after their run completed", async () => {
    const { extractionId } = await readDocument(orgA, docA);
    await db.asAdmin(async (query) => {
      await expect(
        query(
          `insert into document_extracted_fields (organization_id, extraction_id, document_id, position, schema_id, field_key, label, section, value_kind, review_state, method)
           values ($1, $2, $3, 9, 'w2.2026.1', 'box2_federal_withholding', 'Federal', 'WITHHOLDING', 'MONEY', 'MISSING', 'x')`,
          [orgA, extractionId, docA],
        ),
      ).rejects.toThrow(/while their run is in progress/);
    });
  });
});

describe("the job state machine, enforced in the database", () => {
  it("starts QUEUED with no attempts", async () => {
    await db.asAdmin(async (query) => {
      await expect(
        query(`insert into document_processing_jobs (organization_id, document_id, status, idempotency_key, processing_version, provider, provider_version) values ($1, $2, 'SUCCEEDED', 'x', 'v', 'p', '1')`, [orgA, docA]),
      ).rejects.toThrow(/starts QUEUED/);
    });
  });

  it("refuses skipping PROCESSING, or completing without an extraction", async () => {
    const jobId = await queuedJob(orgA, docA);
    await db.asAdmin(async (query) => {
      await expect(query(`update document_processing_jobs set status = 'SUCCEEDED', completed_at = now() where id = $1`, [jobId])).rejects.toThrow(/cannot move from QUEUED to SUCCEEDED/);
      await query(`update document_processing_jobs set status = 'PROCESSING', attempts = 1, started_at = now() where id = $1`, [jobId]);
      await expect(query(`update document_processing_jobs set status = 'SUCCEEDED', completed_at = now() where id = $1`, [jobId])).rejects.toThrow(/must have its extraction/);
    });
  });

  it("counts exactly one attempt per run, and refuses a retry once attempts are exhausted", async () => {
    const jobId = await queuedJob(orgA, docA);
    await db.asAdmin(async (query) => {
      await expect(query(`update document_processing_jobs set status = 'PROCESSING', attempts = 2, started_at = now() where id = $1`, [jobId])).rejects.toThrow(/one attempt/);
      for (let attempt = 1; attempt <= 3; attempt++) {
        await query(`update document_processing_jobs set status = 'PROCESSING', attempts = $2, started_at = now() where id = $1`, [jobId, attempt]);
        await query(`update document_processing_jobs set status = 'FAILED', failure_category = 'PROVIDER_ERROR', failure_message = 'x', completed_at = now() where id = $1`, [jobId]);
        if (attempt < 3) await query(`update document_processing_jobs set status = 'QUEUED', failure_category = null, failure_message = null, started_at = null, completed_at = null where id = $1`, [jobId]);
      }
      await expect(query(`update document_processing_jobs set status = 'QUEUED', failure_category = null, failure_message = null where id = $1`, [jobId])).rejects.toThrow(/no attempts remain/);
    });
  });

  it("keeps a job's identity fixed", async () => {
    const jobId = await queuedJob(orgA, docA);
    await db.asAdmin(async (query) => {
      await expect(query(`update document_processing_jobs set provider_version = '9.9.9' where id = $1`, [jobId])).rejects.toThrow(/identity cannot change/);
    });
  });

  it("allows one job per read, and one run in flight per document", async () => {
    await queuedJob(orgA, docA, "same");
    await expect(queuedJob(orgA, docA, "same")).rejects.toThrow(/duplicate key|unique/);
    await expect(queuedJob(orgA, docA, "different-version")).rejects.toThrow(/duplicate key|unique/);
  });

  it("refuses a job for another organization's document", async () => {
    await expect(queuedJob(orgA, docB)).rejects.toThrow(/foreign key|violates/);
  });
});

describe("recording a result is all or nothing, and constrained", () => {
  it("records nothing when the field count doesn't match", async () => {
    const jobId = await queuedJob(orgA, docA);
    await startJob(jobId);
    await expect(record(orgA, jobId, [FIELD()], EXTRACTION(2))).rejects.toThrow(/field_count does not match/);
    expect(await count("document_extractions")).toBe(0);
    expect(await count("document_extracted_fields")).toBe(0);
  });

  it("records nothing when one field is invalid — no half-written extraction", async () => {
    const jobId = await queuedJob(orgA, docA);
    await startJob(jobId);
    await expect(record(orgA, jobId, [FIELD(), FIELD({ field_key: "box2_federal_withholding", review_state: "MISSING", amount_minor: 100, normalized_decimal: "1.00" })])).rejects.toThrow(
      /no_value_when_unread/,
    );
    expect(await count("document_extractions")).toBe(0);
    const status = await db.asAdmin((query) => query(`select status from document_processing_jobs where id = $1`, [jobId]));
    expect(one<{ status: string }>(status).status).toBe("PROCESSING");
  });

  it("refuses anything shaped like an SSN in a stored value", async () => {
    const jobId = await queuedJob(orgA, docA);
    await startJob(jobId);
    await expect(record(orgA, jobId, [FIELD({ field_key: "employer_name", value_kind: "TEXT", raw_value: "SSN 123-45-6789", normalized_text: "x", amount_minor: null, normalized_decimal: null, currency: null, currency_source: null })])).rejects.toThrow(
      /no_ssn/,
    );
  });

  it("refuses recording against a job that isn't running", async () => {
    const jobId = await queuedJob(orgA, docA);
    await expect(record(orgA, jobId)).rejects.toThrow(/only a running job/);
  });
});

describe("from an extracted field to Tax preparation: a proposal, with the exact amount", () => {
  const insertFact = (values: { amount?: number; state?: string; source?: string; fieldId: string; documentId?: string; supersedes?: string | null; createdBy?: string | null }) =>
    db.query(
      `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, evidence_document_id, evidence_extraction_field_id, supersedes_fact_id, created_by)
       values ($1, $2, 1, 'W2_WAGES', $3, 'USD', $4, $5, $6, $7, $8, $9) returning id`,
      [orgA, caseA, values.amount ?? 8_500_000, values.source ?? "DOCUMENT", values.state ?? "PROPOSED", values.documentId ?? docA, values.fieldId, values.supersedes ?? null, values.createdBy ?? null],
    );

  it("accepts a member's proposal carrying the extracted amount, once per field", async () => {
    const { fieldId } = await readDocument(orgA, docA);
    await db.asUser(OWNER_A);
    const proposal = one<{ id: string }>(await insertFact({ fieldId }));
    expect(proposal.id).toBeTruthy();
    await expect(insertFact({ fieldId })).rejects.toThrow(/duplicate key|one_proposal_per_field/);
  });

  it("refuses a proposal with a different amount than was extracted", async () => {
    const { fieldId } = await readDocument(orgA, docA);
    await db.asUser(OWNER_A);
    await expect(insertFact({ fieldId, amount: 9_999_900 })).rejects.toThrow(/must carry the extracted amount/);
  });

  it("refuses an extracted value entering as CONFIRMED, or under another source", async () => {
    const { fieldId } = await readDocument(orgA, docA);
    await db.asUser(OWNER_A);
    await expect(insertFact({ fieldId, state: "CONFIRMED", createdBy: OWNER_A })).rejects.toThrow(/only as a proposal/);
    await expect(insertFact({ fieldId, source: "USER_ENTERED" })).rejects.toThrow(/must have source DOCUMENT/);
  });

  it("lets a person confirm — or correct — a proposal, carrying its provenance forward", async () => {
    const { fieldId } = await readDocument(orgA, docA);
    await db.asUser(OWNER_A);
    const proposal = one<{ id: string }>(await insertFact({ fieldId }));
    const corrected = one<{ id: string }>(await insertFact({ fieldId, state: "CONFIRMED", amount: 8_350_000, supersedes: proposal.id, createdBy: OWNER_A }));
    const row = await db.query(`select evidence_extraction_field_id, amount_minor, created_by from tax_preparation_facts where id = $1`, [corrected.id]);
    expect(one<{ evidence_extraction_field_id: string; amount_minor: number; created_by: string }>(row)).toMatchObject({ evidence_extraction_field_id: fieldId, created_by: OWNER_A });
  });

  it("refuses linking a field to a different document, or from another organization", async () => {
    const { fieldId } = await readDocument(orgA, docA);
    const otherDoc = await insertDocument(orgA, OWNER_A);
    const b = await readDocument(orgB, docB);
    await db.asUser(OWNER_A);
    await expect(insertFact({ fieldId, documentId: otherDoc })).rejects.toThrow(/must name that field's document/);
    await expect(insertFact({ fieldId: b.fieldId, documentId: docA })).rejects.toThrow(/does not exist in this organization|foreign key/);
  });

  it("refuses proposing a field that has no readable value", async () => {
    const jobId = await queuedJob(orgA, docA);
    await startJob(jobId);
    const extractionId = await record(orgA, jobId, [FIELD({ review_state: "MISSING", raw_value: null, normalized_decimal: null, amount_minor: null, currency: null, currency_source: null })]);
    const fieldId = await db.asAdmin(async (query) => one<{ id: string }>(await query(`select id from document_extracted_fields where extraction_id = $1`, [extractionId])).id);
    await db.asUser(OWNER_A);
    await expect(insertFact({ fieldId, amount: 0 })).rejects.toThrow(/no readable value/);
  });
});

describe("deletion", () => {
  it("deleting a document removes its jobs, extractions and fields, and keeps the tax figure with its links cleared", async () => {
    const { fieldId } = await readDocument(orgA, docA);
    await db.asUser(OWNER_A);
    const proposal = one<{ id: string }>(
      await db.query(
        `insert into tax_preparation_facts (organization_id, case_id, version, key, amount_minor, currency, source, state, evidence_document_id, evidence_extraction_field_id)
         values ($1, $2, 1, 'W2_WAGES', 8500000, 'USD', 'DOCUMENT', 'PROPOSED', $3, $4) returning id`,
        [orgA, caseA, docA, fieldId],
      ),
    );
    await db.asAdmin((query) => query(`delete from documents where id = $1`, [docA]));
    expect(await count("document_processing_jobs")).toBe(0);
    expect(await count("document_extractions")).toBe(0);
    expect(await count("document_extracted_fields")).toBe(0);
    const fact = await db.asAdmin((query) => query(`select evidence_document_id, evidence_extraction_field_id, amount_minor from tax_preparation_facts where id = $1`, [proposal.id]));
    expect(one<Record<string, unknown>>(fact)).toMatchObject({ evidence_document_id: null, evidence_extraction_field_id: null });
  });

  it("deleting an organization removes its document intelligence and nothing of another organization's", async () => {
    await readDocument(orgA, docA);
    await readDocument(orgB, docB);
    await db.asAdmin((query) => query(`delete from organizations where id = $1`, [orgA]));
    expect(await count("document_extractions", "where organization_id = $1", [orgA])).toBe(0);
    expect(await count("document_extractions", "where organization_id = $1", [orgB])).toBe(1);
  });

  it("deleting the user who requested a read keeps the job and clears only the attribution", async () => {
    const jobId = await queuedJob(orgA, docA, "by-member", MEMBER_A);
    await db.asAdmin((query) => query(`delete from auth.users where id = $1`, [MEMBER_A]));
    const row = await db.asAdmin((query) => query(`select requested_by, status from document_processing_jobs where id = $1`, [jobId]));
    expect(one<Record<string, unknown>>(row)).toEqual({ requested_by: null, status: "QUEUED" });
  });
});
