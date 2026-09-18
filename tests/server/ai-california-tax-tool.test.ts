import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The California tools at the AI boundary.
 *
 * The invariant under test is the same one the federal tool has, extended to
 * a second axis: the model may bring INPUTS, and may never bring TAX LAW or
 * JURISDICTION. It cannot ask to be taxed in California, cannot ask not to
 * be, cannot supply a California rate, and cannot turn an unpublished 2026
 * schedule into a number by trying a different argument.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    country: "US",
    stateRegion: null as string | null,
    baseCurrency: "USD",
    recorded: [] as Record<string, unknown>[],
  };
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
  message?: string;
  details?: string[];
  jurisdiction?: string;
  taxYear?: number;
  requestedTaxYear?: number;
  calculationStatus?: "PUBLISHED_RULES" | "ESTIMATE_USING_LATEST_PUBLISHED_RULES";
  calculationMethod?: "FEDERAL_RATE_SCHEDULE" | "CA_TAX_TABLE" | "CA_RATE_SCHEDULE";
  fallback?: { requestedTaxYear: number; ruleSetTaxYear: number; reason: string; pendingPublication: string[]; notice: string } | null;
  ruleSetVersion?: string;
  totals?: Record<string, { amountMinor: number }>;
};

async function callTool(name: string, rawInput: unknown): Promise<ToolResult> {
  const registry = createToolRegistry({} as never);
  const tool = registry.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not registered`);
  const parsed = tool.parseInput ? tool.parseInput(rawInput) : rawInput;
  return (await tool.execute(parsed, { organizationId: ORG, userId: USER })) as ToolResult;
}

const callTax = (input: unknown) => callTool("calculateTaxEstimate", input);
const callSdi = (input: unknown) => callTool("calculateCaliforniaSdi", input);

beforeEach(() => {
  state.country = "US";
  state.stateRegion = null;
  state.baseCurrency = "USD";
  state.recorded = [];
});

describe("the state comes from the workspace, never from the model", () => {
  it("produces no state calculation when the workspace has no state set", async () => {
    const result = await callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });
    expect(result.supported).toBe(true);
    // Null, not absent: the model is told there is no state figure rather
    // than being left to assume one.
    expect(result.state).toBeNull();
  });

  it("produces no state calculation for a state with no engine", async () => {
    // Washington. Every jurisdiction named in `TaxJurisdiction` is now
    // registered — Texas and then Arizona each stood in here and each
    // acquired an engine — so the stand-in has to be a state outside that
    // union entirely.
    state.stateRegion = "WA";
    const result = await callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });
    expect(result.state).toBeNull();
    // And certainly not federal figures relabelled as a Washington result.
    expect(JSON.stringify(result)).not.toContain("US_WA");
  });

  it("cannot be talked into California by an argument", async () => {
    state.stateRegion = "WA";
    const result = await callTax({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "100000",
      ...({ state: "CA", jurisdiction: "US_CA", stateRegion: "CA" } as object),
    });
    expect(result.state).toBeNull();
  });

  it("cannot be talked out of California either", async () => {
    state.stateRegion = "CA";
    const result = await callTax({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "100000",
      ...({ state: null, jurisdiction: "US_FEDERAL", skipState: true } as object),
    });
    expect(result.state).not.toBeNull();
  });

  it("ignores a state on a non-US workspace", async () => {
    state.country = "DE";
    state.stateRegion = "CA";
    const result = await callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("unsupported_jurisdiction");
  });

  it("matches the state code case-insensitively, so a lowercase value is not a silent miss", async () => {
    state.stateRegion = "ca";
    const result = await callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });
    expect(result.state).not.toBeNull();
  });
});

describe("California 2026 answers with 2025 rules, and never hides it", () => {
  beforeEach(() => {
    state.stateRegion = "CA";
  });

  const ask2026 = () => callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });

  it("still returns the federal figure, which IS published for 2026", async () => {
    const result = await callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });
    expect(result.supported).toBe(true);
    expect((result.totals as Record<string, { amountMinor: number }>).incomeTax.amountMinor).toBe(13_170_00);
    // The federal side is the requested year's own rules and must not pick up
    // the state side's fallback status.
    expect(result.calculationStatus).toBe("PUBLISHED_RULES");
    expect(result.fallback).toBeNull();
  });

  it("produces a California figure rather than refusing", async () => {
    const stateOutcome = (await ask2026()).state as Outcome;
    expect(stateOutcome.supported).toBe(true);
    expect(stateOutcome.jurisdiction).toBe("US_CA");
  });

  it("reports the requested year and the rules used as different years", async () => {
    const stateOutcome = (await ask2026()).state as Outcome;
    expect(stateOutcome.requestedTaxYear).toBe(2026);
    expect(stateOutcome.taxYear).toBe(2025);
    expect(stateOutcome.ruleSetVersion).toBe("2025.1");
  });

  it("marks the status so the model cannot read it as an authoritative 2026 figure", async () => {
    const stateOutcome = (await ask2026()).state as Outcome;
    expect(stateOutcome.calculationStatus).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("hands the model the disclosure sentence and the missing figures", async () => {
    const stateOutcome = (await ask2026()).state as Outcome;
    expect(stateOutcome.fallback).not.toBeNull();
    expect(stateOutcome.fallback!.notice).toContain("not a 2026 filed-return calculation");
    expect(stateOutcome.fallback!.pendingPublication.join(" ")).toMatch(/rate schedule/i);
  });

  it("instructs the model not to say 'your 2026 tax is'", async () => {
    const result = await ask2026();
    expect(result.guidance).toContain("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
    expect(result.guidance).toContain("not a filed-return calculation");
  });

  it("records BOTH years on the stored calculation, so the row can never misreport itself", async () => {
    await ask2026();
    const california = state.recorded.map((r) => r.calculation as Outcome).find((c) => c.jurisdiction === "US_CA")!;
    expect(california.requestedTaxYear).toBe(2026);
    expect(california.taxYear).toBe(2025);
    expect(california.calculationStatus).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("cannot be pushed onto real 2026 figures by supplying them", async () => {
    const result = await callTax({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "100000",
      federalAdjustedGrossIncome: "100000",
      ...({ standardDeduction: "20000", brackets: [], taxTable: [], ruleSetVersion: "2026.9", calculationStatus: "PUBLISHED_RULES" } as object),
    });
    const stateOutcome = result.state as Outcome;
    expect(stateOutcome.ruleSetVersion).toBe("2025.1");
    expect(stateOutcome.calculationStatus).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("refuses 2027 outright — the fallback does not generalise", async () => {
    const result = await callTax({ taxYear: 2027, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    const stateOutcome = result.state as Outcome;
    expect(stateOutcome.supported).toBe(false);
    expect(stateOutcome.reason).toBe("unsupported_tax_year");
  });
});

describe("California 2025 computes, from the taxpayer's own federal AGI", () => {
  beforeEach(() => {
    state.stateRegion = "CA";
  });

  it("produces the California figure the engine's own tests verify by hand", async () => {
    const result = await callTax({
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncome: "100000",
      federalAdjustedGrossIncome: "100000",
    });
    const stateOutcome = result.state as Outcome;
    expect(stateOutcome.supported).toBe(true);
    expect(stateOutcome.jurisdiction).toBe("US_CA");
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(5_209_00);
  });

  it("reports federal as unsupported for 2025 while California succeeds — they are independent", async () => {
    const result = await callTax({
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncome: "100000",
      federalAdjustedGrossIncome: "100000",
    });
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("unsupported_tax_year");
    expect((result.state as Outcome).supported).toBe(true);
  });

  it("records the California calculation under its own jurisdiction and version", async () => {
    await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    expect(state.recorded).toHaveLength(1);
    const calculation = state.recorded[0].calculation as Outcome;
    expect(calculation.jurisdiction).toBe("US_CA");
    expect(calculation.ruleSetVersion).toBe("2025.1");
  });

  it("applies California adjustments the caller supplies", async () => {
    const plain = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    const adjusted = await callTax({
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncome: "100000",
      federalAdjustedGrossIncome: "100000",
      stateSubtractions: "10000",
    });
    expect((adjusted.state as Outcome).totals!.totalTax.amountMinor).toBeLessThan((plain.state as Outcome).totals!.totalTax.amountMinor);
  });

  it("takes no California rate or threshold from the model, however it is dressed up", async () => {
    const clean = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    const tampered = await callTax({
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncome: "100000",
      federalAdjustedGrossIncome: "100000",
      ...({ stateRate: "1", standardDeduction: "100000", brackets: [], mentalHealthThreshold: "0", ruleSetVersion: "9999.9" } as object),
    });
    expect((tampered.state as Outcome).totals!.totalTax.amountMinor).toBe((clean.state as Outcome).totals!.totalTax.amountMinor);
    expect((tampered.state as Outcome).ruleSetVersion).toBe("2025.1");
  });

  it("keeps federal and state as two separate liabilities in the guidance", async () => {
    const result = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    expect(result.guidance).toContain("never silently summed");
  });
});

describe("the SDI tool is separate from income tax, and stays separate", () => {
  it("calculates the 2026 contribution for a California workspace", async () => {
    state.stateRegion = "CA";
    const result = await callSdi({ taxYear: 2026, wages: "100000" });
    expect(result.supported).toBe(true);
    expect((result.contribution as { amountMinor: number }).amountMinor).toBe(1_300_00);
    expect(result.wageCeilingMinor).toBeNull();
  });

  it("refuses for a workspace that is not in California", async () => {
    state.stateRegion = "NY";
    const result = await callSdi({ taxYear: 2026, wages: "100000" });
    expect(result.supported).toBe(false);
    expect(result.reason).toBe("unsupported_jurisdiction");
  });

  it("refuses when no state is set at all", async () => {
    const result = await callSdi({ taxYear: 2026, wages: "100000" });
    expect(result.supported).toBe(false);
  });

  it("tells the model not to add it to a California income tax figure", async () => {
    state.stateRegion = "CA";
    const result = await callSdi({ taxYear: 2026, wages: "100000" });
    expect(result.guidance).toContain("not California income tax");
  });

  it("is never produced by the income tax tool", async () => {
    state.stateRegion = "CA";
    const result = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    const stateOutcome = result.state as unknown as { totals: Record<string, { amountMinor: number }>; steps: { key: string }[]; notModelled: string[] };

    // No SDI AMOUNT in the totals or the trace...
    expect(stateOutcome.steps.some((step) => step.key.includes("sdi"))).toBe(false);
    expect(JSON.stringify(stateOutcome.totals).toLowerCase()).not.toContain("sdi");
    // $100,000 of wages would carry $1,300 of SDI; the income tax figure is
    // exactly the bracket total, so none of it was folded in.
    expect(stateOutcome.totals.totalTax.amountMinor).toBe(5_209_00);

    // ...but the result DOES say out loud that SDI was excluded, which is
    // the opposite failure and just as important.
    expect(stateOutcome.notModelled.join(" ")).toContain("State Disability Insurance");
  });

  it("records nothing — a payroll figure is not a stored tax calculation", async () => {
    state.stateRegion = "CA";
    await callSdi({ taxYear: 2026, wages: "100000" });
    expect(state.recorded).toHaveLength(0);
  });
});

describe("the tools never claim California filing", () => {
  it("describes the California result as an estimate, not a return", async () => {
    state.stateRegion = "CA";
    const result = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    const disclaimer = (result.state as unknown as { disclaimer: string }).disclaimer;
    expect(disclaimer).toContain("does not prepare or file California returns");
  });
});

describe("the calculation method is reported, and the model cannot choose it", () => {
  beforeEach(() => {
    state.stateRegion = "CA";
  });

  it("uses the published Tax Table below $100,000 of California taxable income", async () => {
    const result = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    expect((result.state as Outcome).calculationMethod).toBe("CA_TAX_TABLE");
  });

  it("uses the Tax Rate Schedule above it", async () => {
    const result = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "400000", federalAdjustedGrossIncome: "400000" });
    expect((result.state as Outcome).calculationMethod).toBe("CA_RATE_SCHEDULE");
  });

  it("cannot be switched by an argument", async () => {
    const result = await callTax({
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncome: "100000",
      federalAdjustedGrossIncome: "100000",
      ...({ calculationMethod: "CA_RATE_SCHEDULE", useTaxTable: false } as object),
    });
    expect((result.state as Outcome).calculationMethod).toBe("CA_TAX_TABLE");
    expect((result.state as Outcome).totals!.totalTax.amountMinor).toBe(5_209_00);
  });

  it("takes no tax-table value from the model", async () => {
    const clean = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "60000", federalAdjustedGrossIncome: "60000" });
    const tampered = await callTax({
      taxYear: 2025,
      filingStatus: "single",
      ordinaryIncome: "60000",
      federalAdjustedGrossIncome: "60000",
      ...({ taxTableTax: "0", taxTableRows: [[0, 999999, 0, 0]], appliesUpTo: "0", intervalWidth: "1", surtaxRate: "0" } as object),
    });
    expect((tampered.state as Outcome).totals!.totalTax.amountMinor).toBe((clean.state as Outcome).totals!.totalTax.amountMinor);
  });

  it("tells the model the two methods are different published calculations", async () => {
    const result = await callTax({ taxYear: 2025, filingStatus: "single", ordinaryIncome: "100000", federalAdjustedGrossIncome: "100000" });
    expect(result.guidance).toContain("CA_TAX_TABLE");
    expect(result.guidance).toContain("CA_RATE_SCHEDULE");
  });
});
