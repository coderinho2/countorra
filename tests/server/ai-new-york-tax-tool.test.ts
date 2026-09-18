import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * New York at the AI boundary.
 *
 * Same invariant as California, tested against a jurisdiction whose rules ARE
 * published: the model may bring taxpayer facts, and may never bring tax law
 * or jurisdiction. It cannot supply a New York rate, a deduction, a bracket,
 * a worksheet figure, or the calculation method; it cannot move the workspace
 * into or out of New York; and it cannot turn a PUBLISHED_RULES result into a
 * fallback or the other way round.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return { country: "US", stateRegion: "NY" as string | null, baseCurrency: "USD", recorded: [] as Record<string, unknown>[] };
});

vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({
    id,
    name: "Acme",
    entityType: "freelancer",
    country: state.country,
    stateRegion: state.stateRegion,
    baseCurrency: state.baseCurrency,
  }),
}));

vi.mock("@/server/db/repositories/tax-calculations", () => ({
  recordTaxCalculation: async (_c: unknown, input: Record<string, unknown>) => {
    state.recorded.push(input);
    return { id: `calc-${state.recorded.length}` };
  },
}));

const { createToolRegistry } = await import("@/domain/ai/tools/registry");

type ToolResult = Record<string, unknown>;
type Outcome = {
  supported: boolean;
  reason?: string;
  jurisdiction?: string;
  taxYear?: number;
  requestedTaxYear?: number;
  calculationStatus?: string;
  calculationMethod?: string;
  fallback?: unknown;
  ruleSetVersion?: string;
  totals?: Record<string, { amountMinor: number }>;
  notModelled?: string[];
  disclaimer?: string;
  steps?: { key: string; label: string }[];
};

async function callTax(rawInput: unknown): Promise<ToolResult> {
  const registry = createToolRegistry({} as never);
  const tool = registry.find((t) => t.name === "calculateTaxEstimate")!;
  const parsed = tool.parseInput ? tool.parseInput(rawInput) : rawInput;
  return (await tool.execute(parsed, { organizationId: ORG, userId: USER })) as ToolResult;
}

const ny = (extra: Record<string, unknown> = {}) =>
  callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "60000", federalAdjustedGrossIncome: "60000", ...extra });

beforeEach(() => {
  state.country = "US";
  state.stateRegion = "NY";
  state.baseCurrency = "USD";
  state.recorded = [];
});

describe("a New York workspace gets a New York calculation", () => {
  it("computes New York State tax alongside the federal figure", async () => {
    const result = await ny();
    const stateOutcome = result.state as Outcome;
    expect(stateOutcome.supported).toBe(true);
    expect(stateOutcome.jurisdiction).toBe("US_NY");
    // 60,000 − 8,000 = 52,000 taxable: $586 plus 5.40% over $13,900.
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(2_643_40);
  });

  it("reports 2026's own published rules, with no fallback", async () => {
    const stateOutcome = (await ny()).state as Outcome;
    expect(stateOutcome.calculationStatus).toBe("PUBLISHED_RULES");
    expect(stateOutcome.requestedTaxYear).toBe(2026);
    expect(stateOutcome.taxYear).toBe(2026);
    expect(stateOutcome.fallback).toBeNull();
    expect(stateOutcome.ruleSetVersion).toBe("2026.1");
  });

  it("reports the calculation method", async () => {
    expect(((await ny()).state as Outcome).calculationMethod).toBe("NY_RATE_SCHEDULE");
  });

  it("switches to the worksheet method above $107,650 of NYAGI", async () => {
    const result = await ny({ ordinaryIncome: "300000", federalAdjustedGrossIncome: "300000" });
    const stateOutcome = result.state as Outcome;
    expect(stateOutcome.calculationMethod).toBe("NY_TAX_COMPUTATION_WORKSHEET");
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(20_002_10);
  });

  it("accepts dependents and the claimed-as-dependent flag", async () => {
    const plain = (await ny()).state as Outcome;
    const withDependents = (await ny({ dependentCount: 3 })).state as Outcome;
    const asDependent = (await ny({ claimedAsDependent: true })).state as Outcome;
    expect(withDependents.totals!.totalTax.amountMinor).toBeLessThan(plain.totals!.totalTax.amountMinor);
    expect(asDependent.totals!.totalTax.amountMinor).toBeGreaterThan(plain.totals!.totalTax.amountMinor);
  });

  it("records the New York calculation under its own jurisdiction and version", async () => {
    await ny();
    const recorded = state.recorded.map((r) => r.calculation as Outcome).find((c) => c.jurisdiction === "US_NY")!;
    expect(recorded.ruleSetVersion).toBe("2026.1");
    expect(recorded.requestedTaxYear).toBe(2026);
    expect(recorded.calculationStatus).toBe("PUBLISHED_RULES");
  });
});

describe("the model cannot choose the jurisdiction", () => {
  it("cannot move a New York workspace to California", async () => {
    const result = await ny({ state: "CA", jurisdiction: "US_CA", stateRegion: "CA" });
    expect((result.state as Outcome).jurisdiction).toBe("US_NY");
  });

  it("cannot move a workspace with no state engine into New York", async () => {
    // Washington: outside `TaxJurisdiction` entirely, now that every
    // jurisdiction it names is registered.
    state.stateRegion = "WA";
    const result = await ny({ state: "NY", jurisdiction: "US_NY" });
    expect(result.state).toBeNull();
  });

  it("matches the state code case-insensitively", async () => {
    state.stateRegion = "ny";
    expect(((await ny()).state as Outcome).jurisdiction).toBe("US_NY");
  });

  it("produces no New York figure for a non-US workspace", async () => {
    state.country = "DE";
    const result = await ny();
    expect(result.supported).toBe(false);
  });
});

describe("the model cannot supply New York tax law", () => {
  const TAMPER = {
    standardDeduction: "50000",
    standardDeductionMinor: 0,
    dependentExemption: "99999",
    dependentExemptionMinor: 9_999_900,
    brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 1, baseTaxMinor: 0 }],
    rateBasisPoints: 1,
    baseTaxMinor: 0,
    recaptureBaseMinor: 0,
    incrementalBenefitMinor: 0,
    highIncome: null,
    taxTable: [[0, 999_999, 0, 0]],
    calculationMethod: "NY_RATE_SCHEDULE",
    calculationStatus: "ESTIMATE_USING_LATEST_PUBLISHED_RULES",
    ruleSetVersion: "9999.9",
    // NOTE: `taxYear` is deliberately NOT in this payload. The requested year
    // is a taxpayer fact the model may legitimately supply — what it must not
    // supply is which RULES answer it. That distinction has its own test
    // below.
  };

  it("ignores injected rates, deductions, brackets and worksheet figures", async () => {
    const clean = (await ny({ ordinaryIncome: "300000", federalAdjustedGrossIncome: "300000" })).state as Outcome;
    const tampered = (await ny({ ordinaryIncome: "300000", federalAdjustedGrossIncome: "300000", ...TAMPER })).state as Outcome;
    expect(tampered.totals!.totalTax.amountMinor).toBe(clean.totals!.totalTax.amountMinor);
  });

  it("ignores an injected calculation method", async () => {
    const tampered = (await ny({ ordinaryIncome: "300000", federalAdjustedGrossIncome: "300000", ...TAMPER })).state as Outcome;
    expect(tampered.calculationMethod).toBe("NY_TAX_COMPUTATION_WORKSHEET");
  });

  it("ignores an injected calculation status", async () => {
    const tampered = (await ny(TAMPER)).state as Outcome;
    expect(tampered.calculationStatus).toBe("PUBLISHED_RULES");
    expect(tampered.fallback).toBeNull();
  });

  it("ignores an injected rule-set version", async () => {
    expect(((await ny(TAMPER)).state as Outcome).ruleSetVersion).toBe("2026.1");
  });

  it("takes the tax year from the argument but the RULES from the server", async () => {
    // The requested year is a taxpayer fact and may be supplied. Which rule
    // set answers it is not, and 2025 has none for New York.
    const result = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "60000", federalAdjustedGrossIncome: "60000" });
    const stateOutcome = result.state as Outcome;
    expect(stateOutcome.supported).toBe(false);
    expect(stateOutcome.reason).toBe("unsupported_tax_year");
  });

  it("refuses 2027 rather than reaching for 2026", async () => {
    const result = await callTax({ taxYear: 2027, filingStatus: "single", ordinaryIncome: "60000", federalAdjustedGrossIncome: "60000" });
    expect((result.state as Outcome).supported).toBe(false);
  });

  it("rejects an out-of-range dependent count at the schema, before the engine", async () => {
    await expect(ny({ dependentCount: -1 })).rejects.toThrow();
    await expect(ny({ dependentCount: 2.5 })).rejects.toThrow();
  });
});

describe("what the model is told to say", () => {
  it("is instructed to report the method and not to compute it itself", async () => {
    const result = await ny();
    expect(result.guidance).toContain("NY_RATE_SCHEDULE");
    expect(result.guidance).toContain("NY_TAX_COMPUTATION_WORKSHEET");
    expect(result.guidance).toContain("never compute any of them yourself");
  });

  it("is told New York State tax excludes New York City, Yonkers and the MCTMT", async () => {
    const result = await ny();
    expect(result.guidance).toContain("New York City tax, Yonkers tax and the MCTMT");
  });

  it("is told federal and state are separate liabilities", async () => {
    expect((await ny()).guidance).toContain("never silently summed");
  });

  it("carries a disclaimer that does not claim New York filing", async () => {
    const stateOutcome = (await ny()).state as Outcome;
    expect(stateOutcome.disclaimer).toContain("does not prepare or file New York returns");
    expect(stateOutcome.disclaimer).toContain("New York State tax only");
  });

  it("carries the not-modelled list, naming New York City", async () => {
    expect(((await ny()).state as Outcome).notModelled!.join(" ")).toContain("New York City");
  });

  it("names the published worksheet in the trace it hands over", async () => {
    const stateOutcome = (await ny({ ordinaryIncome: "300000", federalAdjustedGrossIncome: "300000" })).state as Outcome;
    expect(stateOutcome.steps!.some((s) => s.label.includes("worksheet 8"))).toBe(true);
  });
});
