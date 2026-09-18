import { beforeEach, describe, expect, it, vi } from "vitest";
import { fact, preparationCase, scenario, w2Facts, type ScenarioOptions } from "@/domain/tax-filing/fixtures.test-helpers";

/**
 * The tax filing Server Actions, end to end through the real readiness engine,
 * the real package builder and the real fingerprinting.
 *
 * Only the database (repositories), the session, the rate limiter and the audit
 * sink are replaced. What is pinned: the order of authorization and elevated
 * writes; that blocked, stale, tampered or unconfirmed finalizations write
 * nothing; that the scope and excluded states must match exactly; and that no
 * database error reaches the person.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const FILING = "66666666-6666-4666-8666-666666666666";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    role: "owner" as string,
    denied: false,
    adminClients: 0,
    stateRegion: "TX" as string | null,
    liveCase: null as unknown,
    facts: [] as unknown[],
    latestPreparation: null as unknown,
    filingCase: null as Record<string, unknown> | null,
    latestFilingSnapshot: null as Record<string, unknown> | null,
    finalizations: [] as Record<string, unknown>[],
    snapshotInserts: [] as Record<string, unknown>[],
    finalizationInserts: [] as Record<string, unknown>[],
    caseUpdates: [] as Record<string, unknown>[],
    audits: [] as { action: string; metadata?: Record<string, unknown> }[],
    reported: [] as unknown[],
    failSnapshotInsert: false,
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminClients += 1;
    return { admin: true };
  },
}));
vi.mock("@/server/auth/session", () => ({
  requireOrgMembership: async () => {
    if (state.denied) {
      const error = new Error("NEXT_REDIRECT:/app") as Error & { digest?: string };
      error.digest = "NEXT_REDIRECT;/app";
      throw error;
    }
    return { user: { id: USER }, membership: { role: state.role } };
  },
}));
vi.mock("@/server/security/rate-limit", () => ({ enforceRateLimit: async () => ({ allowed: true }) }));
vi.mock("@/lib/observability", () => ({
  reportError: (...args: unknown[]) => void state.reported.push(args),
  reportEvent: (...args: unknown[]) => void state.reported.push(args),
}));
vi.mock("@/domain/audit/audit-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/audit/audit-log")>()),
  recordAuditEvent: async (_client: unknown, event: { action: string; metadata?: Record<string, unknown> }) => void state.audits.push(event),
}));

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({ id, name: "Synthetic", entityType: "personal", country: "US", stateRegion: state.stateRegion, baseCurrency: "USD", taxIdentifier: null, taxIdentifierType: null }),
}));

vi.mock("@/server/db/repositories/tax-preparation", () => ({
  findLivePreparationCase: async () => state.liveCase,
  getPreparationCase: async () => state.liveCase,
  listCurrentFacts: async () => state.facts,
  listDependents: async () => [],
  latestSnapshot: async () => state.latestPreparation,
}));

vi.mock("@/server/db/repositories/tax-filing", () => ({
  getFilingCase: async (_c: unknown, id: string) => (state.filingCase && state.filingCase.id === id ? state.filingCase : null),
  getFilingCaseForPreparation: async () => state.filingCase,
  latestFilingSnapshot: async () => state.latestFilingSnapshot,
  listFilingSnapshots: async () => (state.latestFilingSnapshot ? [state.latestFilingSnapshot] : []),
  listFinalizations: async () => state.finalizations,
  insertFilingCase: async () => {
    throw new Error("not used");
  },
  insertFilingSnapshot: async (_admin: unknown, input: Record<string, unknown>) => {
    state.snapshotInserts.push(input);
    if (state.failSnapshotInsert) throw Object.assign(new Error('permission denied for table tax_filing_snapshots (SQLSTATE 42501) SECRET-INTERNAL'), { code: "42501" });
    state.latestFilingSnapshot = {
      id: "77777777-7777-4777-8777-777777777777",
      organizationId: input.organizationId,
      filingCaseId: input.filingCaseId,
      version: input.version,
      taxYear: input.taxYear,
      preparationSnapshotId: input.preparationSnapshotId,
      preparationVersion: input.preparationVersion,
      readinessStatus: (input.readiness as { status: string }).status,
      packageFingerprint: input.packageFingerprint,
      inputFingerprint: input.inputFingerprint,
      createdBy: input.createdBy,
      createdAt: input.createdAt,
      // As read back from jsonb.
      readiness: JSON.parse(JSON.stringify(input.readiness)),
      package: JSON.parse(JSON.stringify(input.package)),
    };
    return state.latestFilingSnapshot;
  },
  insertFinalization: async (_admin: unknown, input: Record<string, unknown>) => {
    state.finalizationInserts.push(input);
    const row = { id: "88888888-8888-4888-8888-888888888888", ...input, finalizedAt: "2026-09-13T13:00:00.000Z" };
    state.finalizations.push(row);
    return row;
  },
  updateFilingCase: async (_admin: unknown, input: Record<string, unknown>) => {
    state.caseUpdates.push(input);
    state.filingCase = { ...state.filingCase, status: input.status, currentVersion: input.currentVersion ?? state.filingCase?.currentVersion };
    return state.filingCase;
  },
}));

const { createTaxFilingSnapshotAction, finalizeTaxFilingAction } = await import("@/server/tax-filing/actions");
const { staleReasonsFor } = await import("@/server/tax-filing/workspace");
const { canonicalJson } = await import("@/domain/tax-filing/canonical-json");
const { assessFilingReadiness } = await import("@/domain/tax-filing/readiness");
const { PACKAGE_BUILDER_VERSION, READINESS_ENGINE_VERSION } = await import("@/domain/tax-filing/types");

function load(options: ScenarioOptions) {
  const input = scenario(options);
  state.stateRegion = options.state === undefined ? "TX" : options.state;
  state.liveCase = { ...preparationCase(options), organizationId: ORG };
  state.facts = [...input.facts];
  state.latestPreparation = input.latest
    ? { id: input.latest.id, caseId: input.latest.snapshot.caseId, version: input.latest.version, snapshot: input.latest.snapshot, calculation: input.latest.calculation, createdAt: "2026-09-13T10:00:00.000Z" }
    : null;
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const ids = () => ({ organizationId: ORG, filingCaseId: FILING });

async function snapshot() {
  return createTaxFilingSnapshotAction({}, form(ids()));
}

async function finalize(overrides: Record<string, string> = {}) {
  return finalizeTaxFilingAction(
    {},
    form({
      ...ids(),
      snapshotId: String(state.latestFilingSnapshot?.id ?? "77777777-7777-4777-8777-777777777777"),
      scope: "FULL",
      confirmation: "FINALIZE",
      acknowledged: "yes",
      excludedJurisdictions: "",
      ...overrides,
    }),
  );
}

beforeEach(() => {
  Object.assign(state, {
    role: "owner",
    denied: false,
    adminClients: 0,
    filingCase: { id: FILING, organizationId: ORG, preparationCaseId: "22222222-2222-4222-8222-222222222222", taxYear: 2026, status: "DRAFT", currentVersion: 0, createdBy: USER },
    latestFilingSnapshot: null,
    finalizations: [],
    snapshotInserts: [],
    finalizationInserts: [],
    caseUpdates: [],
    audits: [],
    reported: [],
    failSnapshotInsert: false,
  });
  load({ state: "TX" });
});

describe("creating a filing snapshot", () => {
  it("freezes readiness and a deterministic package for a ready return", async () => {
    const result = await snapshot();
    expect(result.success).toBe(true);

    const inserted = state.snapshotInserts[0];
    expect(inserted).toMatchObject({ organizationId: ORG, filingCaseId: FILING, version: 1, taxYear: 2026 });
    expect(inserted.packageFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((inserted.package as Record<string, unknown>)).toMatchObject({ filed: false, submitted: false, governmentForm: false });
    expect(state.caseUpdates[0]).toMatchObject({ status: "READY_FOR_FILING", currentVersion: 1 });

    const audit = state.audits.find((event) => event.action === "tax_filing.snapshot_created");
    expect(audit?.metadata).toMatchObject({ version: 1, readiness: "READY" });
    expect(JSON.stringify(state.audits)).not.toMatch(/Taylor|Synthetic|85000|8500000/);
  });

  it("writes nothing for a blocked return", async () => {
    load({ state: "TX", facts: [] });
    const result = await snapshot();
    expect(result.error).toMatch(/blocking/);
    expect(state.snapshotInserts).toEqual([]);
    expect(state.adminClients).toBe(0);
  });

  it.each([
    ["head of household", { filingStatus: "head_of_household" }],
    ["qualifying surviving spouse", { filingStatus: "qualifying_surviving_spouse" }],
    ["married filing separately, spouse's itemizing unanswered", { filingStatus: "married_filing_separately", taxpayer: { spouseFirstName: "Jordan", spouseLastName: "Synthetic" } }],
  ] as const)("writes nothing while a %s question is open — calculated, never qualified", async (_label, options) => {
    load({ state: "TX", ...options });
    const result = await snapshot();
    expect(result.error).toMatch(/qualified review/);
    expect(state.snapshotInserts).toEqual([]);
    expect(state.caseUpdates).toEqual([]);
    expect(state.adminClients).toBe(0);
  });

  it("snapshots married filing separately once the spouse is recorded as not itemizing", async () => {
    load({ state: "TX", filingStatus: "married_filing_separately", taxpayer: { spouseFirstName: "Jordan", spouseLastName: "Synthetic", spouseItemizesDeductions: false } });
    const result = await snapshot();
    expect(result.success).toBe(true);
    const inserted = state.snapshotInserts[0];
    expect((inserted.readiness as { status: string; finalizableScope: string }).finalizableScope).toBe("FULL");
    expect((inserted.package as { taxpayer: { spouseItemizesDeductions: boolean | null }; filingStatus: { code: string } }).taxpayer.spouseItemizesDeductions).toBe(false);
    expect((inserted.package as { filingStatus: { code: string } }).filingStatus.code).toBe("married_filing_separately");
  });

  it("refuses a filing case from another workspace", async () => {
    state.filingCase = { ...state.filingCase!, organizationId: "99999999-9999-4999-8999-999999999999" };
    const result = await snapshot();
    expect(result.error).toBe("Tax filing not found.");
    expect(state.adminClients).toBe(0);
  });

  it("never returns a database error to the person", async () => {
    state.failSnapshotInsert = true;
    const result = await snapshot();
    expect(result.error).toBe("That couldn't be completed, and nothing was changed. Please try again.");
    expect(JSON.stringify(result)).not.toMatch(/SQLSTATE|permission denied|SECRET-INTERNAL/);
    expect(state.reported.length).toBeGreaterThan(0);
  });

  it("authorizes before any elevated client exists", async () => {
    state.denied = true;
    await expect(snapshot()).rejects.toThrow(/NEXT_REDIRECT/);
    expect(state.adminClients).toBe(0);
  });
});

describe("finalizing", () => {
  it("finalizes exactly the reviewed snapshot, and says nothing was filed", async () => {
    await snapshot();
    const result = await finalize();

    expect(result).toMatchObject({ success: true });
    expect(result.message).toMatch(/Nothing has been filed or submitted/);
    expect(state.finalizationInserts[0]).toMatchObject({ scope: "FULL", excludedJurisdictions: [], snapshotId: state.latestFilingSnapshot!.id });
    expect(state.caseUpdates.at(-1)).toMatchObject({ status: "FINALIZED" });
    expect(state.audits.find((event) => event.action === "tax_filing.finalized")?.metadata).toMatchObject({ scope: "FULL", submitted: false, version: 1 });
  });

  it("requires the typed confirmation and the acknowledgment", async () => {
    await snapshot();
    const attempts: Record<string, string>[] = [{ confirmation: "" }, { confirmation: "finalize" }, { acknowledged: "" }];
    for (const overrides of attempts) {
      const result = await finalize(overrides);
      expect(result.error, JSON.stringify(overrides)).toBeTruthy();
    }
    expect(state.finalizationInserts).toEqual([]);
  });

  it("is refused to a role without the finalize permission", async () => {
    await snapshot();
    state.role = "employee";
    const adminBefore = state.adminClients;
    const result = await finalize();
    expect(result.error).toMatch(/owner, admin or accountant/);
    expect(state.adminClients).toBe(adminBefore);
    expect(state.finalizationInserts).toEqual([]);
  });

  it("is refused when information changed after the snapshot", async () => {
    await snapshot();
    state.facts = [...w2Facts(), fact("FEDERAL_ESTIMATED_PAYMENTS", 25_000)];
    state.liveCase = { ...(state.liveCase as object), status: "COLLECTING" };
    const result = await finalize();
    expect(result.error).toMatch(/Information changed after this snapshot/);
    expect(state.finalizationInserts).toEqual([]);
  });

  it("is refused when the stored package no longer reproduces from its inputs", async () => {
    await snapshot();
    const stored = state.latestFilingSnapshot!;
    (stored.package as { federal: { totals: { totalTaxMinor: number } } }).federal.totals.totalTaxMinor = 1;
    const result = await finalize();
    expect(result.error).toMatch(/no longer reproduces/);
    expect(state.finalizationInserts).toEqual([]);
  });

  it("is refused for any snapshot but the latest", async () => {
    await snapshot();
    const result = await finalize({ snapshotId: "12121212-1212-4212-8212-121212121212" });
    expect(result.error).toMatch(/isn't the latest/);
  });

  it("Arizona: federal-only finalization must name the excluded state exactly", async () => {
    load({ state: "AZ" });
    await snapshot();

    expect((await finalize({ scope: "FULL" })).error).toMatch(/Readiness no longer allows/);
    expect((await finalize({ scope: "FEDERAL_ONLY", excludedJurisdictions: "" })).error).toMatch(/excluded states exactly/);
    expect((await finalize({ scope: "FEDERAL_ONLY", excludedJurisdictions: "US_CA" })).error).toMatch(/excluded states exactly/);
    expect(state.finalizationInserts).toEqual([]);

    const result = await finalize({ scope: "FEDERAL_ONLY", excludedJurisdictions: "US_AZ" });
    expect(result.success).toBe(true);
    expect(state.finalizationInserts[0]).toMatchObject({ scope: "FEDERAL_ONLY", excludedJurisdictions: ["US_AZ"] });
  });

  it("does not finalize the same version twice", async () => {
    await snapshot();
    await finalize();
    const result = await finalize();
    expect(result.error).toMatch(/already finalized/);
    expect(state.finalizationInserts).toHaveLength(1);
  });
});

/**
 * A filing snapshot taken under EARLIER readiness and package rules.
 *
 * Found in live verification after Task 9: the Task 8 synthetic workspace's v4
 * was stored under `filing-readiness.2026.1` / `filing-package.2026.1` and now
 * shows as out of date. That is the intended behaviour, pinned here: the stored
 * snapshot is never rewritten or restamped; newer rules alone are enough to mark
 * it outdated; it cannot be finalized; and the current return is snapshotted as
 * a NEW version under the current rules.
 */
describe("a historical snapshot under earlier readiness rules", () => {
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
  }

  /** The stored row as a 2026.1 build wrote it: same inputs, older stamps. Frozen,
   *  so any attempt to restamp or repair it in place throws. */
  function historicalCopy(row: Record<string, unknown>) {
    const copy = JSON.parse(JSON.stringify(row)) as Record<string, unknown> & {
      id: string;
      readiness: { engineVersion: string };
      package: { metadata: { readinessEngineVersion: string; packageBuilderVersion: string } };
    };
    copy.readiness.engineVersion = "filing-readiness.2026.1";
    copy.package.metadata.readinessEngineVersion = "filing-readiness.2026.1";
    copy.package.metadata.packageBuilderVersion = "filing-package.2026.1";
    return deepFreeze(copy);
  }

  it("stays byte-for-byte as stored, is outdated by the newer rules alone, and cannot be finalized", async () => {
    await snapshot();
    const historical = historicalCopy(state.latestFilingSnapshot!);
    state.latestFilingSnapshot = historical;
    const before = canonicalJson(historical);

    const input = scenario({ state: "TX" });
    const readiness = assessFilingReadiness(input);
    // Same preparation snapshot, same inputs, same READY status — only the rules moved.
    expect(staleReasonsFor(historical as never, input.latest, readiness)).toEqual(["READINESS_CHANGED"]);
    // The identical row under the current rules is current: the stamp is the only cause.
    const underCurrentRules = { ...historical, readiness: { ...historical.readiness, engineVersion: READINESS_ENGINE_VERSION } };
    expect(staleReasonsFor(underCurrentRules as never, input.latest, readiness)).toEqual([]);

    const refused = await finalize({ snapshotId: historical.id });
    expect(refused.error).toMatch(/Information changed after this snapshot was taken/);
    expect(state.finalizationInserts).toEqual([]);

    expect(canonicalJson(historical)).toBe(before);
    expect(historical.readiness.engineVersion).toBe("filing-readiness.2026.1");
    expect(historical.package.metadata.packageBuilderVersion).toBe("filing-package.2026.1");
  });

  it("is superseded by a new version built from current inputs and rules, never overwritten", async () => {
    await snapshot();
    const historical = historicalCopy(state.latestFilingSnapshot!);
    state.latestFilingSnapshot = historical;
    const before = canonicalJson(historical);

    const result = await snapshot();
    expect(result.success).toBe(true);
    expect(state.snapshotInserts).toHaveLength(2);

    const inserted = state.snapshotInserts[1] as { version: number; readiness: { engineVersion: string }; package: { metadata: { readinessEngineVersion: string; packageBuilderVersion: string } } };
    expect(inserted.version).toBe(2);
    expect(inserted.readiness.engineVersion).toBe(READINESS_ENGINE_VERSION);
    expect(inserted.package.metadata).toMatchObject({ readinessEngineVersion: READINESS_ENGINE_VERSION, packageBuilderVersion: PACKAGE_BUILDER_VERSION });

    // The earlier version is exactly as it was, stamps included.
    expect(canonicalJson(historical)).toBe(before);
    expect(state.latestFilingSnapshot).not.toBe(historical);
  });

  it("is reported as already current when nothing, including the rules, has changed", async () => {
    await snapshot();
    const again = await snapshot();
    expect(again).toEqual({ success: true, message: "Version 1 is already current." });
    expect(state.snapshotInserts).toHaveLength(1);
  });
});
