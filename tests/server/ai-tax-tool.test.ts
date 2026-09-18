import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The boundary that matters most in this feature: the AI may bring INPUTS,
 * and may never bring TAX LAW.
 *
 * A model asked "how much tax will I owe" will happily produce a number from
 * its recollection of bracket tables — confidently, and often wrong, because
 * the figures change every year and it has seen many years. These tests
 * assert there is no parameter through which that recollection can reach the
 * result: no rate, no threshold, no deduction, no jurisdiction, no currency.
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
    baseCurrency: "USD",
    recorded: [] as Record<string, unknown>[],
    recordThrows: false,
  };
});

vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({
    id,
    name: "Acme",
    entityType: "freelancer",
    country: state.country,
    baseCurrency: state.baseCurrency,
  }),
}));

vi.mock("@/server/db/repositories/tax-calculations", () => ({
  recordTaxCalculation: async (_c: unknown, input: Record<string, unknown>) => {
    if (state.recordThrows) throw new Error("insert failed");
    state.recorded.push(input);
    return { id: "calc-1" };
  },
}));

const { createToolRegistry } = await import("@/domain/ai/tools/registry");

type ToolResult = Record<string, unknown>;

/** Invokes the tool exactly as the AI service does. */
async function callTaxTool(rawInput: unknown): Promise<ToolResult> {
  const registry = createToolRegistry({} as never);
  const tool = registry.find((t) => t.name === "calculateTaxEstimate");
  if (!tool) throw new Error("calculateTaxEstimate tool is not registered");

  const parsed = tool.parseInput ? tool.parseInput(rawInput) : rawInput;
  return (await tool.execute(parsed, { organizationId: ORG, userId: USER })) as ToolResult;
}

beforeEach(() => {
  state.country = "US";
  state.baseCurrency = "USD";
  state.recorded = [];
  state.recordThrows = false;
});

describe("the tool produces authoritative figures the AI did not supply", () => {
  it("calculates from inputs alone", async () => {
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });

    expect(result.supported).toBe(true);
    const totals = result.totals as Record<string, { amountMinor: number }>;
    // The same $13,170 the engine's own tests verify by hand.
    expect(totals.incomeTax.amountMinor).toBe(13_170_00);
  });

  it("returns the full trace and rule-set stamp for the model to explain", async () => {
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });

    expect(Array.isArray(result.steps)).toBe(true);
    expect((result.steps as unknown[]).length).toBeGreaterThan(4);
    expect((result.ruleSet as Record<string, unknown>).version).toBe("2026.2");
    expect(Array.isArray(result.notModelled)).toBe(true);
  });

  it("instructs the model to explain rather than recompute", async () => {
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "50000" });
    expect(String(result.guidance)).toMatch(/do not recompute/i);
    expect(String(result.guidance)).toMatch(/do not restate rates/i);
  });
});

describe("the AI cannot supply tax law", () => {
  const authoritativeOverrides = [
    { standardDeduction: "999999" },
    { standardDeductionMinor: 99_999_900 },
    { taxRate: 1 },
    { rate: 0.01 },
    { rateBasisPoints: 100 },
    { brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 100 }] },
    { marginalRate: 5 },
    { effectiveRate: 5 },
    { incomeTax: "0" },
    { totalTax: "0" },
    { taxableIncome: "0" },
    { ruleSetVersion: "1999.1" },
    { ruleSet: { version: "1999.1", jurisdiction: "US_FEDERAL" } },
  ];

  it.each(authoritativeOverrides)("ignores %j", async (override) => {
    // The schema strips unknown keys, so none of these reaches the engine.
    // The result must be identical to the clean call.
    const clean = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });
    const tampered = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000", ...override });

    expect((tampered.totals as Record<string, { amountMinor: number }>).incomeTax.amountMinor).toBe(
      (clean.totals as Record<string, { amountMinor: number }>).incomeTax.amountMinor,
    );
    expect((tampered.ruleSet as Record<string, unknown>).version).toBe("2026.2");
  });

  it("uses the published standard deduction, not one the model named", async () => {
    const result = await callTaxTool({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "100000",
      standardDeduction: "50000",
    });

    const totals = result.totals as Record<string, { amountMinor: number }>;
    expect(totals.standardDeduction.amountMinor).toBe(16_100_00);
    expect(totals.taxableIncome.amountMinor).toBe(83_900_00);
  });

  it("takes the JURISDICTION from the organization, never from the request", async () => {
    // A model that could name a jurisdiction could ask to be taxed somewhere
    // cheaper, or somewhere unimplemented.
    const result = await callTaxTool({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "100000",
      jurisdiction: "US_FL",
      country: "FL",
    });

    expect((result.ruleSet as Record<string, unknown>).jurisdiction).toBe("US_FEDERAL");
  });

  it("takes the CURRENCY from the organization, never from the request", async () => {
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000", currency: "EUR" });
    expect(result.currency).toBe("USD");
  });

  it("refuses when the organization's own currency is not the rule set's", async () => {
    // Not a model-supplied mismatch — a genuinely EUR-based workspace. The
    // engine refuses rather than running EUR through USD brackets.
    state.baseCurrency = "EUR";
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });

    expect(result.supported).toBe(false);
    expect(result.reason).toBe("currency_mismatch");
  });
});

describe("unsupported combinations reach the model as refusals", () => {
  it.each([2024, 2025, 2027])("refuses tax year %s rather than using another year", async (taxYear) => {
    const result = await callTaxTool({ taxYear, filingStatus: "single", ordinaryIncome: "100000" });

    expect(result.supported).toBe(false);
    expect(result.reason).toBe("unsupported_tax_year");
    expect(result.message).toBe("This federal tax year is not currently supported.");
    // Critically: no figures at all, so there is nothing for the model to
    // present as a result.
    expect(result.totals).toBeUndefined();
  });

  it.each([
    ["head_of_household", 9_588_00],
    ["married_filing_separately", 13_170_00],
    ["qualifying_surviving_spouse", 7_640_00],
  ] as const)("calculates filing status %s from the engine's own tables", async (filingStatus, incomeTax) => {
    // The same hand-checked figures as the engine tests: $100,000 of income.
    const result = await callTaxTool({ taxYear: 2026, filingStatus, ordinaryIncome: "100000" });

    expect(result.supported).toBe(true);
    expect((result.totals as Record<string, { amountMinor: number }>).incomeTax.amountMinor).toBe(incomeTax);
    expect((result.ruleSet as Record<string, unknown>).version).toBe("2026.2");
    // Calculated is not qualified: the limitation travels with the figure.
    expect(JSON.stringify(result.notModelled)).toMatch(/head of household and qualifying surviving spouse have qualification tests/);
  });

  it.each(["head_of_household", "qualifying_surviving_spouse"])("ignores a model's claim that the taxpayer qualifies for %s", async (filingStatus) => {
    const clean = await callTaxTool({ taxYear: 2026, filingStatus, ordinaryIncome: "100000" });
    const claimed = await callTaxTool({ taxYear: 2026, filingStatus, ordinaryIncome: "100000", qualifies: true, qualificationDetermined: true, standardDeduction: "0" });
    expect(claimed.totals).toEqual(clean.totals);
    expect(JSON.stringify(claimed)).not.toMatch(/qualificationDetermined|"qualifies"/);
  });

  it("refuses a non-US organization without falling back to federal rules", async () => {
    state.country = "RO";
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });

    expect(result.supported).toBe(false);
    expect(result.reason).toBe("unsupported_jurisdiction");
    expect(result.message).toBe("This jurisdiction is not currently supported.");
  });

  it("rejects a filing status the schema does not know at parse time", async () => {
    await expect(callTaxTool({ taxYear: 2026, filingStatus: "corporation", ordinaryIncome: "100000" })).rejects.toThrow();
  });

  it("rejects a malformed income amount at parse time", async () => {
    for (const ordinaryIncome of ["abc", "100,000", "1e5", "-5000", ""]) {
      await expect(callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome })).rejects.toThrow();
    }
  });
});

describe("self-employment through the tool", () => {
  it("calculates SE tax from Schedule C net profit", async () => {
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "0", selfEmploymentNetProfit: "100000" });

    const totals = result.totals as Record<string, { amountMinor: number }>;
    expect(totals.selfEmploymentTax.amountMinor).toBe(14_129_55);
    expect(totals.totalTax.amountMinor).toBe(25_745_30);
  });

  it("accepts a loss, which is a legitimate Schedule C figure", async () => {
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "80000", selfEmploymentNetProfit: "-20000" });
    expect(result.supported).toBe(true);
  });
});

describe("recording", () => {
  it("stores the calculation with its rule-set version", async () => {
    await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });

    expect(state.recorded).toHaveLength(1);
    expect(state.recorded[0]).toMatchObject({ organizationId: ORG, calculatedBy: USER });
    const calculation = state.recorded[0].calculation as { ruleSetVersion: string };
    expect(calculation.ruleSetVersion).toBe("2026.2");
  });

  it("records nothing for an unsupported combination", async () => {
    await callTaxTool({ taxYear: 2027, filingStatus: "single", ordinaryIncome: "100000" });
    expect(state.recorded).toEqual([]);
  });

  it("still returns the estimate when recording fails", async () => {
    // A failed audit write must not take down a correct answer.
    state.recordThrows = true;
    const result = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000" });

    expect(result.supported).toBe(true);
    expect((result.totals as Record<string, { amountMinor: number }>).incomeTax.amountMinor).toBe(13_170_00);
  });

  it("scopes the record to the caller's organization, not a requested one", async () => {
    await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "100000", organizationId: "99999999-9999-4999-8999-999999999999" });
    expect(state.recorded[0].organizationId).toBe(ORG);
  });
});

describe("the tool describes itself honestly to the model", () => {
  it("tells the model not to supply rates, and never claims to file", () => {
    const registry = createToolRegistry({} as never);
    const tool = registry.find((t) => t.name === "calculateTaxEstimate")!;

    expect(tool.description).toMatch(/must NOT supply/i);
    expect(tool.description).toMatch(/deterministic/i);
    // Never implies preparation or filing.
    expect(tool.description).not.toMatch(/file your|e-file|tax return preparation|prepares your return/i);
  });

  it("is a calculate-mode tool, so it needs no write confirmation", () => {
    const registry = createToolRegistry({} as never);
    const tool = registry.find((t) => t.name === "calculateTaxEstimate")!;
    expect(tool.operationMode).toBe("calculate");
  });
});

describe("W-2 wages reach the engine through the tool", () => {
  it("passes Social Security wages, which cap the self-employment portion", async () => {
    // $200,000 of wages already fill the 2026 wage base, so none of the
    // $50,000 profit is subject to the 12.4% Social Security portion.
    const result = await callTaxTool({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "200000",
      selfEmploymentNetProfit: "50000",
      w2SocialSecurityWages: "200000",
    });

    const totals = result.totals as Record<string, { amountMinor: number }>;
    expect(totals.selfEmploymentTax.amountMinor).toBe(1_754_66);
  });

  it("costs more when the wages are omitted — the bug this patch fixed", async () => {
    const withWages = await callTaxTool({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "200000",
      selfEmploymentNetProfit: "50000",
      w2SocialSecurityWages: "200000",
    });
    const without = await callTaxTool({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "200000", selfEmploymentNetProfit: "50000" });

    const se = (r: ToolResult) => (r.totals as Record<string, { amountMinor: number }>).selfEmploymentTax.amountMinor;
    expect(se(withWages)).toBeLessThan(se(without));
  });

  it("passes Medicare wages separately from Social Security wages", async () => {
    // The realistic high earner: box 3 capped at the wage base, box 5 not.
    const result = await callTaxTool({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "250000",
      selfEmploymentNetProfit: "50000",
      w2SocialSecurityWages: "184500",
      w2MedicareWages: "250000",
    });

    const steps = result.steps as { key: string; amount: { amountMinor: number } }[];
    expect(steps.find((s) => s.key === "se_social_security")!.amount.amountMinor).toBe(0);
    expect(steps.find((s) => s.key === "se_additional_medicare")!.amount.amountMinor).toBe(415_58);
  });

  it("still takes the wage figures as INPUTS, not as authoritative tax law", async () => {
    // Wages are a fact about the taxpayer. They change the base the engine
    // applies its own rates to; they never change the rates or thresholds.
    const result = await callTaxTool({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "100000",
      selfEmploymentNetProfit: "50000",
      w2SocialSecurityWages: "100000",
      socialSecurityWageBase: "999999",
      additionalMedicareThreshold: "1",
    });

    expect((result.ruleSet as Record<string, unknown>).version).toBe("2026.2");
    const steps = result.steps as { key: string; amount: { amountMinor: number } }[];
    // Remaining base 84,500 → 12.4% = 10,478, computed from the rule set's
    // own $184,500 and not from the smuggled figure.
    expect(steps.find((s) => s.key === "se_wage_base_remaining")!.amount.amountMinor).toBe(84_500_00);
  });

  it("refuses swapped W-2 boxes rather than understating the tax", async () => {
    const result = await callTaxTool({
      taxYear: 2026,
      filingStatus: "single",
      ordinaryIncome: "150000",
      selfEmploymentNetProfit: "50000",
      w2SocialSecurityWages: "150000",
      w2MedicareWages: "100000",
    });

    expect(result.supported).toBe(false);
    expect(result.reason).toBe("invalid_input");
  });

  it("tells the model to supply W-2 wages when there is a job as well", () => {
    const registry = createToolRegistry({} as never);
    const tool = registry.find((t) => t.name === "calculateTaxEstimate")!;
    expect(tool.description).toMatch(/box 3.*box 5|W-2 wages/i);
    expect(tool.description).toMatch(/overstates the tax/i);
  });
});
