import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateTaxpayerAction` when a save FAILS — the server half of the failed-save
 * scenario (the form half is `tests/e2e/taxpayer-form-state.spec.ts`).
 *
 * A save that fails validation, authorization or the rate limit must change
 * nothing: no case update, no audit event, no cache revalidation, and a message
 * a person can read. A save that then succeeds must write exactly what was
 * submitted.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CASE = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

const state = vi.hoisted(() => ({
  role: "owner",
  rateLimited: false,
  updates: [] as { caseId: string; patch: Record<string, unknown> }[],
  audits: [] as unknown[],
  revalidated: [] as string[],
  status: "CALCULATED" as string,
}));

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => void state.revalidated.push(path) }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/auth/session", () => ({ requireOrgMembership: async () => ({ user: { id: USER }, membership: { role: state.role } }) }));
vi.mock("@/server/security/rate-limit", () => ({
  enforceRateLimit: async () => (state.rateLimited ? { allowed: false, message: "Too many changes. Try again shortly." } : { allowed: true }),
}));
vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));
vi.mock("@/domain/audit/audit-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/audit/audit-log")>()),
  recordAuditEvent: async (_client: unknown, event: unknown) => void state.audits.push(event),
}));
vi.mock("@/server/db/repositories/tax-preparation", () => ({
  getPreparationCase: async () => ({
    id: CASE,
    organizationId: ORG,
    taxYear: 2026,
    status: state.status,
    filingStatus: "single",
    taxpayer: {
      legalFirstName: "Taylor",
      legalMiddleName: null,
      legalLastName: "Synthetic",
      dateOfBirth: "1988-03-14",
      taxIdentifierType: "ssn",
      taxIdentifierOnFile: true,
      primaryStateRegion: "FL",
      additionalStateRegions: ["NY"],
      spouseFirstName: null,
      spouseLastName: null,
      spouseDateOfBirth: null,
      spouseTaxIdentifierOnFile: false,
      spouseItemizesDeductions: null,
    },
    currentVersion: 21,
    createdBy: USER,
    createdAt: "2026-09-13T10:00:00.000Z",
    updatedAt: "2026-09-13T10:00:00.000Z",
    completedAt: null,
  }),
  updatePreparationCase: async (_client: unknown, caseId: string, patch: Record<string, unknown>) => void state.updates.push({ caseId, patch }),
}));

const { updateTaxpayerAction } = await import("@/server/tax-preparation/actions");

/** The form exactly as the taxpayer form submits it, with overrides. */
function submission(overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    organizationId: ORG,
    caseId: CASE,
    filingStatus: "single",
    legalFirstName: "Taylor",
    legalMiddleName: "",
    legalLastName: "Synthetic",
    dateOfBirth: "1988-03-14",
    taxIdentifierType: "ssn",
    taxIdentifierOnFile: "yes",
    additionalStateRegions: "NY",
    spouseFirstName: "",
    spouseLastName: "",
    spouseDateOfBirth: "",
    spouseTaxIdentifierOnFile: "no",
    spouseItemizesDeductions: "",
    ...overrides,
  };
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function expectNothingWritten() {
  expect(state.updates).toEqual([]);
  expect(state.audits).toEqual([]);
  expect(state.revalidated).toEqual([]);
}

beforeEach(() => {
  Object.assign(state, { role: "owner", rateLimited: false, updates: [], audits: [], revalidated: [], status: "CALCULATED" });
});

describe("a taxpayer save that fails changes nothing", () => {
  it.each([
    ["an invalid additional state code", { filingStatus: "head_of_household", additionalStateRegions: "N1" }, /two-letter state codes/],
    ["a tax identifier typed into a name field", { filingStatus: "head_of_household", legalMiddleName: "123-45-6789" }, /Don't enter a Social Security number/],
    ["an unknown filing status", { filingStatus: "married_filing_jointly_but_separately" }, /./],
    ["an invented spouse-itemizes answer", { filingStatus: "married_filing_separately", spouseItemizesDeductions: "maybe" }, /./],
    ["an impossible date", { dateOfBirth: "26-01-01" }, /YYYY-MM-DD/],
  ])("refuses %s and writes nothing", async (_label, overrides, message) => {
    const result = await updateTaxpayerAction({}, submission(overrides));
    expect(result.success).toBeUndefined();
    expect(result.error).toMatch(message);
    expectNothingWritten();
  });

  it("refuses a role without write access and writes nothing", async () => {
    state.role = "viewer";
    const result = await updateTaxpayerAction({}, submission({ filingStatus: "head_of_household" }));
    expect(result.error).toMatch(/permission/);
    expectNothingWritten();
  });

  it("refuses when rate limited and writes nothing", async () => {
    state.rateLimited = true;
    const result = await updateTaxpayerAction({}, submission({ filingStatus: "head_of_household" }));
    expect(result.error).toMatch(/Too many/);
    expectNothingWritten();
  });

  it("never echoes the refused value back in the message", async () => {
    const result = await updateTaxpayerAction({}, submission({ legalMiddleName: "123-45-6789" }));
    expect(result.error).not.toContain("123-45-6789");
  });
});

describe("retrying after a failed save", () => {
  it("writes exactly the corrected submission, including the choices made before the failure", async () => {
    const failed = await updateTaxpayerAction({}, submission({ filingStatus: "head_of_household", taxIdentifierType: "itin", additionalStateRegions: "N1" }));
    expect(failed.error).toBeTruthy();
    expectNothingWritten();

    const retried = await updateTaxpayerAction(failed, submission({ filingStatus: "head_of_household", taxIdentifierType: "itin", additionalStateRegions: "NY, nj" }));
    expect(retried).toEqual({ success: true, message: "Saved." });
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].caseId).toBe(CASE);
    expect(state.updates[0].patch).toMatchObject({
      filingStatus: "head_of_household",
      taxIdentifierType: "itin",
      additionalStateRegions: ["NY", "NJ"],
      spouseItemizesDeductions: null,
      // A calculated case is reopened, so the old figure is never presented as current.
      status: "COLLECTING",
    });
    expect(state.revalidated).toEqual([`/app/${ORG}/tax-preparation`]);
  });

  it("ignores whatever the previous result carried", async () => {
    const result = await updateTaxpayerAction({ error: "stale", success: false, message: "stale" }, submission({ additionalStateRegions: "N1" }));
    expect(result.error).toMatch(/two-letter/);
    expectNothingWritten();
  });
});
