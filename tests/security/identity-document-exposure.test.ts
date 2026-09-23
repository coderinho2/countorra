import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocumentExplanation } from "@/domain/documents/intelligence/explain";
import { identityPayloadSchema, normalizeIdentity } from "@/domain/documents/intelligence/identity";
import { planFactProposals } from "@/domain/documents/intelligence/proposals";
import { DOCUMENT_TYPES, isIdentityDocument } from "@/domain/documents/intelligence/types";

/**
 * WHERE AN IDENTITY DOCUMENT MUST NOT APPEAR.
 *
 * The identity normalizer decides what is stored; this file asserts what
 * happens to it afterwards. Each case is one exit route out of the product —
 * the model, the ledger, a log line, the client bundle — and each one is
 * closed by a different mechanism, so each is checked separately rather than
 * trusting the one at the top.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const LICENCE_FIELDS = normalizeIdentity({
  fields: [
    { type: "FIRST_NAME", value: { text: "ALEX MORGAN", confidence: 0.99, normalizedValue: null } },
    { type: "DOCUMENT_NUMBER", value: { text: "Y1234567", confidence: 0.99, normalizedValue: null } },
    { type: "ID_TYPE", value: { text: "DRIVER LICENSE", confidence: 0.99, normalizedValue: null } },
    { type: "EXPIRATION_DATE", value: { text: "04/12/2030", confidence: 0.98, normalizedValue: "2030-04-12" } },
  ],
}).fields;

const explainField = (over: Partial<Parameters<typeof buildDocumentExplanation>[0]["fields"][number]> = {}) => ({
  id: "field-1",
  fieldKey: "document_number_present",
  label: "Document number",
  section: "IDENTITY" as const,
  box: null,
  valueKind: "PRESENCE" as const,
  rawValue: "••••4567",
  normalizedDecimal: null,
  currency: null,
  normalizedDate: null,
  normalizedText: "••••4567",
  reviewState: "HIGH_CONFIDENCE" as const,
  reviewReason: null,
  pageNumber: null,
  method: "textract-identity/field",
  ...over,
});

const explainInput = (documentType: string) => ({
  document: { id: "doc-1", kind: "identity" },
  readerAvailable: true,
  readerUnavailableMessage: null,
  latestJob: null,
  extraction: {
    version: 1,
    status: "REVIEW_REQUIRED" as const,
    documentType: documentType as never,
    classificationConfidence: "HIGH" as const,
    classificationReviewReason: null,
    taxYear: null,
    method: "OCR",
    provider: "amazon-textract",
    providerVersion: "2026.1",
    pageCount: 1,
    warnings: [],
    createdAt: "2026-09-23T00:00:00.000Z",
  },
  fields: [explainField()],
  preparationStateByField: new Map<string, null>(),
  conflicts: [],
});

describe("the assistant is never given an identity document's contents", () => {
  it("sends no fields at all for an identity document", () => {
    const payload = buildDocumentExplanation(explainInput("DRIVER_LICENSE") as never);
    expect(payload.fields).toEqual([]);
    expect(payload.rows.shown).toEqual([]);
    expect(payload.identityDocument).toBe(true);
  });

  it("tells the model why, so an empty result is not read as 'nothing was found'", () => {
    const payload = buildDocumentExplanation(explainInput("DRIVER_LICENSE") as never);
    expect(payload.guidance).toMatch(/identity document/i);
    expect(payload.guidance).toMatch(/not available to the assistant/i);
  });

  it("leaks no masked tail, no document class, nothing", () => {
    const serialized = JSON.stringify(buildDocumentExplanation(explainInput("PASSPORT") as never));
    expect(serialized).not.toContain("4567");
    expect(serialized).not.toContain("DRIVER LICENSE");
  });

  it("drops an IDENTITY-section field even on a document classified as financial", () => {
    // Defence in depth: if a licence were ever misclassified as a receipt,
    // its identity fields still do not reach the model.
    const payload = buildDocumentExplanation(explainInput("RECEIPT") as never);
    expect(payload.identityDocument).toBe(false);
    expect(payload.fields).toEqual([]);
  });

  it("still passes financial fields through, so the exclusion is not a blanket one", () => {
    const input = explainInput("RECEIPT") as never as ReturnType<typeof explainInput>;
    const payload = buildDocumentExplanation({ ...input, fields: [explainField({ section: "TOTALS", fieldKey: "total", label: "Total", rawValue: "21.60", normalizedDecimal: "21.60" })] } as never);
    expect(payload.fields).toHaveLength(1);
  });
});

describe("an identity document cannot reach the ledger or a tax fact", () => {
  it("proposes nothing from identity fields", () => {
    const plan = planFactProposals({
      extraction: {
        id: "extraction-1",
        documentId: "doc-1",
        documentType: "DRIVER_LICENSE",
        status: "REVIEW_REQUIRED",
        classificationConfidence: "HIGH",
        taxYear: null,
      },
      fields: LICENCE_FIELDS.map((field, index) => ({
        id: `field-${index}`,
        schemaId: field.schemaId,
        fieldKey: field.fieldKey,
        label: field.label,
        box: field.box,
        amountMinor: field.amountMinor,
        currency: field.currency,
        normalizedDecimal: field.normalizedDecimal,
        normalizedDate: field.normalizedDate,
        normalizedText: field.normalizedText,
        reviewState: field.reviewState,
      })),
      preparation: { caseId: "case-1", taxYear: 2026 },
      workspaceCurrency: "USD",
      currentFacts: [],
    } as never);

    // Nothing is proposable, and it is blocked for a structural reason: the
    // identity schema maps no field to a tax fact, so there is nothing to
    // arbitrate rather than something that was filtered late.
    expect(plan.items).toEqual([]);
    expect(plan.blocked).toBeTruthy();
  });

  it("holds no amount that could become one", () => {
    expect(LICENCE_FIELDS.every((field) => field.amountMinor === null && field.normalizedDecimal === null)).toBe(true);
  });
});

describe("the database enforces it too, not only the application", () => {
  const migration = read("supabase/migrations/0055_document_ocr_identity.sql");

  it("forbids money on an identity field", () => {
    expect(migration).toMatch(/document_extracted_fields_identity_no_money/);
    expect(migration).toMatch(/amount_minor is null and normalized_decimal is null/);
  });

  it("forbids a run of digits long enough to be an identifier", () => {
    expect(migration).toMatch(/document_extracted_fields_identity_no_identifiers/);
    expect(migration).toMatch(/\[0-9\]\{5,\}/);
  });

  it("keeps the SSN backstop that already applied to every row", () => {
    expect(read("supabase/migrations/0046_document_intelligence.sql")).toMatch(/document_extracted_fields_no_ssn/);
  });
});

describe("nothing sensitive is logged", () => {
  it("records ids, statuses and durations from processing — never values or text", () => {
    const processing = read("src/server/documents/processing.ts");
    const logged = [...processing.matchAll(/reportEvent\("([^"]+)"[\s\S]{0,400}?\)/g)].map((match) => match[0]);
    expect(logged.length).toBeGreaterThan(0);
    for (const call of logged) {
      for (const forbidden of ["rawValue", "normalizedText", "fields:", "text:", "storagePath", "signedUrl", "bytes"]) {
        expect(call, forbidden).not.toContain(forbidden);
      }
    }
  });

  it("never console.logs document content anywhere in the OCR path", () => {
    for (const file of [
      "src/server/documents/processing.ts",
      "src/server/documents/textract/provider.ts",
      "src/server/documents/textract/client.ts",
      "src/domain/documents/intelligence/identity.ts",
      "src/domain/documents/intelligence/expense.ts",
    ]) {
      expect(read(file), file).not.toMatch(/console\.(log|info|debug|warn|error)/);
    }
  });
});

describe("AWS credentials stay on the server", () => {
  it("declares no AWS variable as NEXT_PUBLIC_", () => {
    const env = read("src/lib/env.ts");
    expect(env).not.toMatch(/NEXT_PUBLIC_AWS/i);
    expect(read("src/lib/server-env.ts")).not.toMatch(/NEXT_PUBLIC_AWS/i);
  });

  it("reads credentials only through server-env, never process.env directly", () => {
    const client = read("src/server/documents/textract/client.ts");
    expect(client).toContain('import "server-only"');
    expect(client).not.toMatch(/process\.env/);
  });

  it("hardcodes no key", () => {
    for (const file of ["src/server/documents/textract/client.ts", "src/server/documents/textract/provider.ts"]) {
      // An AWS access key id is AKIA/ASIA followed by 16 uppercase alphanumerics.
      expect(read(file), file).not.toMatch(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/);
    }
  });

  it("needs no S3 permission, because the bytes never go through a bucket", () => {
    const provider = read("src/server/documents/textract/provider.ts");
    expect(provider).not.toContain("S3Object");
    expect(provider).toContain("Bytes");
  });
});

describe("a hostile or malformed provider response", () => {
  /**
   * The normalizer is written for what AnalyzeID documents it returns. These
   * cases assume it returns something else — because a provider can change, be
   * wrong, or be replaced, and "the vendor behaved" is not a security control.
   *
   * Identity data is planted in the fields the allowlist KEEPS, which is the
   * only way it could reach storage at all.
   */

  const SSN = "123-45-6789";

  it("discards an SSN planted in the document-class field", () => {
    const { fields, discarded } = normalizeIdentity({ fields: [{ type: "ID_TYPE", value: { text: SSN, confidence: 0.99, normalizedValue: null } }] });
    expect(fields).toHaveLength(0);
    expect(discarded).toContain("ID_TYPE");
    expect(JSON.stringify(fields)).not.toContain("123");
  });

  it("discards a long digit run planted in the issuing-state field", () => {
    const { fields } = normalizeIdentity({ fields: [{ type: "STATE_NAME", value: { text: "CA 4111111111111111", confidence: 0.99, normalizedValue: null } }] });
    expect(fields).toHaveLength(0);
  });

  it("keeps no digits when a document number is itself an SSN", () => {
    const { fields } = normalizeIdentity({ fields: [{ type: "DOCUMENT_NUMBER", value: { text: `SSN ${SSN}`, confidence: 0.99, normalizedValue: null } }] });
    // The stored VALUES, not the row's metadata: a schema id and a confidence
    // legitimately contain digits, an identifier does not.
    for (const value of [fields[0]?.rawValue, fields[0]?.normalizedText]) {
      expect(value).toBe("•••••••••");
      expect(value).not.toMatch(/\d/);
    }
  });

  it("does not let an MRZ through in a kept slot", () => {
    const mrz = "P<USAMORGAN<<ALEX<J<<<<<<<<<<<<<<<<<<<<<<<<<<1234567890USA9004125M3004127";
    const { fields } = normalizeIdentity({ fields: [{ type: "ID_TYPE", value: { text: mrz, confidence: 0.99, normalizedValue: null } }] });
    expect(JSON.stringify(fields)).not.toContain("MORGAN");
    expect(JSON.stringify(fields)).not.toContain("1234567890");
  });

  it("keeps a date but not an SSN sharing the same field", () => {
    const { fields } = normalizeIdentity({
      fields: [{ type: "EXPIRATION_DATE", value: { text: `exp 04/12/2030 ssn ${SSN}`, confidence: 0.99, normalizedValue: "2030-04-12" } }],
    });
    expect(fields[0]?.normalizedDate).toBe("2030-04-12");
    expect(JSON.stringify(fields)).not.toContain("6789");
  });

  it("refuses a date the provider normalized to something impossible", () => {
    const { fields } = normalizeIdentity({ fields: [{ type: "EXPIRATION_DATE", value: { text: "31/02/2026", confidence: 0.99, normalizedValue: "2026-02-31" } }] });
    // 2026-02-31 does not exist. No date is invented and none is rolled
    // forward into March.
    expect(fields).toHaveLength(0);
  });

  it("drops an unknown field type carrying identity data, keeping only its name", () => {
    const { fields, discarded } = normalizeIdentity({ fields: [{ type: "SOCIAL_SECURITY_NUMBER", value: { text: SSN, confidence: 0.99, normalizedValue: null } }] });
    expect(fields).toHaveLength(0);
    expect(discarded).toEqual(["SOCIAL_SECURITY_NUMBER"]);
    expect(JSON.stringify(discarded)).not.toContain("123");
  });

  it("rejects a payload larger than any real identity document before reading it", () => {
    const flood = { fields: Array.from({ length: 500 }, () => ({ type: "ID_TYPE", value: { text: SSN, confidence: 0.99, normalizedValue: null } })) };
    expect(identityPayloadSchema.safeParse(flood).success).toBe(false);
  });

  it("survives nulls and empties where the provider promised values", () => {
    const { fields } = normalizeIdentity({
      fields: [
        { type: null, value: null },
        { type: "ID_TYPE", value: null },
        { type: "DOCUMENT_NUMBER", value: { text: "", confidence: null, normalizedValue: null } },
      ],
    });
    expect(fields).toEqual([]);
  });

  it("stores nothing at all from a response that is entirely identity data", () => {
    const { fields } = normalizeIdentity({
      fields: [
        { type: "FIRST_NAME", value: { text: "ALEX", confidence: 0.99, normalizedValue: null } },
        { type: "LAST_NAME", value: { text: "MORGAN", confidence: 0.99, normalizedValue: null } },
        { type: "DATE_OF_BIRTH", value: { text: "1990-04-12", confidence: 0.99, normalizedValue: "1990-04-12" } },
        { type: "ADDRESS", value: { text: "142 Cedar Street", confidence: 0.99, normalizedValue: null } },
        { type: "MRZ_CODE", value: { text: "P<USA<<<<", confidence: 0.99, normalizedValue: null } },
      ],
    });
    expect(fields).toEqual([]);
  });
});

describe("every document path into the model, not just the explain tool", () => {
  const registry = read("src/domain/ai/tools/registry.ts");

  it("has exactly three document tools, so this list cannot silently grow", () => {
    // If a fourth appears, this fails and someone has to decide what it may
    // expose rather than inheriting whatever the repository returns.
    const names = [...registry.matchAll(/name: "(getDocuments|searchDocuments|explainDocument|[a-zA-Z]*[Dd]ocument[a-zA-Z]*)"/g)].map((match) => match[1]);
    expect([...new Set(names)].sort()).toEqual(["explainDocument", "getDocuments", "searchDocuments"]);
  });

  it("gives the model no storage path and no signed URL for a document", () => {
    const shape = registry.slice(registry.indexOf("function toAssistantDocument"));
    for (const forbidden of ["storagePath", "storage_path", "signedUrl", "createSignedUrl", "bucket"]) {
      expect(shape.slice(0, 400), forbidden).not.toContain(forbidden);
    }
  });

  it("keeps the storage path out of the explain payload too", () => {
    const payload = JSON.stringify(buildDocumentExplanation(explainInput("RECEIPT") as never));
    for (const forbidden of ["storagePath", "signedUrl", "supabase.co", "http"]) expect(payload, forbidden).not.toContain(forbidden);
  });

  it("never puts a raw provider payload or provider error into the model's view", () => {
    const payload = JSON.stringify(buildDocumentExplanation(explainInput("RECEIPT") as never));
    for (const forbidden of ["Blocks", "ExpenseDocuments", "IdentityDocuments", "AccessDenied", "Exception", "arn:aws"]) {
      expect(payload, forbidden).not.toContain(forbidden);
    }
  });
});

describe("the reader entitlement is enforced on the server, not only in the page", () => {
  const actions = read("src/server/documents/intelligence-actions.ts");

  it("checks the plan before any provider call", () => {
    expect(actions).toContain("readerAccess");
    expect(actions).toContain("entitlementsFor");
    // Order matters: the gate must precede the call that costs money.
    expect(actions.indexOf("readerAccess(client")).toBeLessThan(actions.indexOf("processDocument("));
  });

  it("separates 'this deployment has no reader' from 'your plan does not include it'", () => {
    // Conflating them would tell a Free workspace to upgrade for something
    // the deployment cannot do at all.
    expect(actions).toContain("textractConfigured()");
    expect(actions).toMatch(/Premium and Business/);
  });

  it("still authenticates, authorizes and rate limits first", () => {
    for (const guard of ["requireOrgMembership", 'can(membership.role, "financial:write")', "enforceRateLimit"]) {
      expect(actions, guard).toContain(guard);
    }
    expect(actions.indexOf("enforceRateLimit")).toBeLessThan(actions.indexOf("readerAccess(client"));
  });
});

describe("the identity class is closed", () => {
  it("has a sensitivity for every document type, so none is unclassified", () => {
    for (const type of DOCUMENT_TYPES) expect(typeof isIdentityDocument(type), type).toBe("boolean");
  });

  it("treats exactly the four identity classes as identity", () => {
    expect(DOCUMENT_TYPES.filter(isIdentityDocument).sort()).toEqual(["DRIVER_LICENSE", "GOVERNMENT_ID", "PASSPORT", "SSN_DOCUMENT"]);
  });
});
