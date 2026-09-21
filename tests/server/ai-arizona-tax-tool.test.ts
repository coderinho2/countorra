import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Arizona at the AI boundary.
 *
 * Arizona is the hardest of the five for a model to handle well, because the
 * right answer is "I can't tell you yet, and here is precisely why". A model
 * that knows Arizona's rate is 2.5% will be tempted to answer anyway — the
 * rate is even correct. It is the standard deduction that is missing, and a
 * rate without a deduction is not a tax figure.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return { country: "US", stateRegion: "AZ" as string | null, baseCurrency: "USD", recorded: [] as Record<string, unknown>[] };
});

vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

vi.mock("@/server/db/repositories/organizations", () => ({
  getOrganization: async (_c: unknown, id: string) => ({
    id,
    name: "Acme",
    entityType: "personal",
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
  totals?: Record<string, { amountMinor: number }>;
};

async function callTax(rawInput: unknown): Promise<ToolResult> {
  const registry = createToolRegistry({} as never);
  const tool = registry.find((t) => t.name === "calculateTaxEstimate")!;
  const parsed = tool.parseInput ? tool.parseInput(rawInput) : rawInput;
  return (await tool.execute(parsed, { organizationId: ORG, userId: USER })) as ToolResult;
}

const az = (extra: Record<string, unknown> = {}) =>
  callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "120000", federalAdjustedGrossIncome: "120000", ...extra });

beforeEach(() => {
  state.country = "US";
  state.stateRegion = "AZ";
  state.baseCurrency = "USD";
  state.recorded = [];
});

describe("an Arizona workspace is routed to the Arizona engine", () => {
  it("returns an Arizona outcome rather than a null state", async () => {
    // Registered-and-refusing is a different, more useful answer than "this
    // state isn't modelled".
    const stateOutcome = (await az()).state as Outcome;
    expect(stateOutcome).not.toBeNull();
    expect(stateOutcome.jurisdiction).toBe("US_AZ");
    expect(stateOutcome.taxYear).toBe(2026);
  });

  it("refuses with rules_not_published, not unsupported_tax_year", async () => {
    const stateOutcome = (await az()).state as Outcome;
    expect(stateOutcome.supported).toBe(false);
    expect(stateOutcome.reason).toBe("rules_not_published");
  });

  it("hands the model the missing figure and the authority to wait on", async () => {
    const stateOutcome = (await az()).state as Outcome;
    expect(stateOutcome.details!.join(" ")).toContain("standard deduction");
    expect(stateOutcome.message).toContain("Arizona Department of Revenue");
  });

  it("still returns the federal figure, which an Arizona resident owes in full", async () => {
    const result = await az();
    expect(result.supported).toBe(true);
    expect((result.totals as Record<string, { amountMinor: number }>).totalTax.amountMinor).toBeGreaterThan(0);
  });

  it("records nothing for the refused state calculation", async () => {
    await az();
    expect(state.recorded.map((r) => r.calculation as Outcome).some((c) => c.jurisdiction === "US_AZ")).toBe(false);
  });

  it("refuses every filing status alike", async () => {
    for (const filingStatus of ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"] as const) {
      const stateOutcome = (await az({ filingStatus })).state as Outcome;
      expect(stateOutcome.supported, filingStatus).toBe(false);
    }
  });

  it("refuses an unregistered Arizona year with the other reason", async () => {
    for (const taxYear of [2025, 2027]) {
      const stateOutcome = (await az({ taxYear })).state as Outcome;
      expect(stateOutcome.supported, `${taxYear}`).toBe(false);
      expect(stateOutcome.reason).toBe("unsupported_tax_year");
    }
  });
});

describe("the model cannot turn the refusal into a figure", () => {
  const TAMPER = {
    standardDeduction: "16100",
    standardDeductionMinor: 1_610_000,
    rateBasisPoints: 250,
    taxRate: "2.5",
    brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 250 }],
    totalTax: "2500",
    stateTax: "2500",
    calculationMethod: "NY_RATE_SCHEDULE",
    calculationStatus: "PUBLISHED_RULES",
    ruleSetVersion: "2026.1",
    pendingPublication: [],
  };

  it("cannot inject the missing standard deduction", async () => {
    const stateOutcome = (await az(TAMPER)).state as Outcome;
    expect(stateOutcome.supported).toBe(false);
    expect(stateOutcome.reason).toBe("rules_not_published");
  });

  it("cannot inject a rate, a bracket or a liability", async () => {
    const stateOutcome = (await az(TAMPER)).state as Outcome;
    expect(stateOutcome.totals).toBeUndefined();
    expect(JSON.stringify(stateOutcome)).not.toContain("amountMinor");
  });

  it("cannot force a fallback the resolver does not authorize", async () => {
    // Arizona's situation matches California's, and California DOES fall
    // back. The policy is per-jurisdiction and not requestable.
    const stateOutcome = (await az({ ...TAMPER, allowFallback: true, fallbackYear: 2025 })).state as Outcome;
    expect(stateOutcome.supported).toBe(false);
    expect(JSON.stringify(stateOutcome)).not.toContain("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("cannot change US_AZ to US_NY", async () => {
    const stateOutcome = (await az({ jurisdiction: "US_NY", state: "NY", stateRegion: "NY" })).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_AZ");
  });

  it("cannot change US_AZ to US_TX to get a $0 answer", async () => {
    const stateOutcome = (await az({ jurisdiction: "US_TX", state: "TX", stateRegion: "TX" })).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_AZ");
    expect(stateOutcome.supported).toBe(false);
  });

  it("cannot move an Arizona workspace to a state that does compute", async () => {
    const stateOutcome = (await az({ stateRegion: "NY", state: "NY" })).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_AZ");
  });
});

describe("what the model is told to say", () => {
  it("is told rules_not_published means the authority has not released a figure", async () => {
    const guidance = (await az()).guidance as string;
    expect(guidance).toContain("rules_not_published");
    expect(guidance).toContain("has not released a figure the calculation needs");
  });

  it("is told Arizona's rate is settled but the deduction is not", async () => {
    const guidance = (await az()).guidance as string;
    expect(guidance).toContain("Arizona 2026");
    expect(guidance).toContain("flat 2.5%");
    expect(guidance).toContain("standard deduction the calculation depends on has not been published");
  });

  it("is told not to answer from general knowledge or substitute a year", async () => {
    const guidance = (await az()).guidance as string;
    expect(guidance).toContain("do NOT answer from general knowledge");
    expect(guidance).toContain("do NOT substitute another year, another state, or the federal figures");
  });

  it("is told a rate is not an answer without a deduction", async () => {
    expect((await az()).guidance).toContain("do NOT present a rate as an answer when there is no deduction to apply it to");
  });

  it("is told unsupported_tax_year is a different situation", async () => {
    expect((await az()).guidance).toContain("that year was never modelled at all");
  });

  it("is told federal and state remain separate", async () => {
    expect((await az()).guidance).toContain("never silently summed");
  });
});
