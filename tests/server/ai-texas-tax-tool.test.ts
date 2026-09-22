import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Texas at the AI boundary.
 *
 * Four ways this could go wrong, and a test for each: the model asserting $0
 * from its own recollection instead of the engine; presenting $0 as
 * "unsupported"; claiming Texas has a 0% income-tax bracket; and letting "no
 * individual income tax" become "no Texas tax" — Texas has a franchise tax, a
 * sales tax and locally levied property tax, and none of them is this.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return { country: "US", stateRegion: "TX" as string | null, baseCurrency: "USD", recorded: [] as Record<string, unknown>[] };
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
  jurisdiction?: string;
  taxYear?: number;
  requestedTaxYear?: number;
  calculationStatus?: string;
  calculationMethod?: string;
  ruleSetVersion?: string;
  totals?: Record<string, { amountMinor: number }>;
  rates?: { marginalRateBasisPoints: number; effectiveRateBasisPoints: number | null };
  steps?: { key: string; label: string; explanation: string }[];
  notModelled?: string[];
  disclaimer?: string;
  ruleSet?: { sources: { authority: string; url: string; verification: string }[] };
};

async function callTax(rawInput: unknown): Promise<ToolResult> {
  const registry = createToolRegistry({} as never);
  const tool = registry.find((t) => t.name === "calculateTaxEstimate")!;
  const parsed = tool.parseInput ? tool.parseInput(rawInput) : rawInput;
  return (await tool.execute(parsed, { organizationId: ORG, userId: USER })) as ToolResult;
}

const tx = (extra: Record<string, unknown> = {}) => callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "250000", ...extra });

beforeEach(() => {
  state.country = "US";
  state.stateRegion = "TX";
  state.baseCurrency = "USD";
  state.recorded = [];
});

describe("a Texas workspace gets an authoritative $0, from the engine", () => {
  it("returns a supported Texas result rather than a null state", async () => {
    const stateOutcome = (await tx()).state as Outcome;
    expect(stateOutcome).not.toBeNull();
    expect(stateOutcome.supported).toBe(true);
    expect(stateOutcome.jurisdiction).toBe("US_TX");
  });

  it("reports $0 with the NO_INDIVIDUAL_INCOME_TAX method", async () => {
    const stateOutcome = (await tx()).state as Outcome;
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(0);
    expect(stateOutcome.calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
  });

  it("identifies US_TX and tax year 2026", async () => {
    const stateOutcome = (await tx()).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_TX");
    expect(stateOutcome.requestedTaxYear).toBe(2026);
    expect(stateOutcome.taxYear).toBe(2026);
    expect(stateOutcome.ruleSetVersion).toBe("2026.1");
    expect(stateOutcome.calculationStatus).toBe("PUBLISHED_RULES");
  });

  it("still returns the federal figure, which a Texas resident owes in full", async () => {
    const result = await tx();
    expect(result.supported).toBe(true);
    expect((result.totals as Record<string, { amountMinor: number }>).totalTax.amountMinor).toBeGreaterThan(0);
  });

  it("gives the same $0 for every filing status and any income", async () => {
    for (const filingStatus of ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"] as const) {
      const stateOutcome = (await tx({ filingStatus, ordinaryIncome: "12000000" })).state as Outcome;
      expect(stateOutcome.totals!.totalTax.amountMinor, filingStatus).toBe(0);
    }
  });

  it("records the Texas calculation under its own jurisdiction and version", async () => {
    await tx();
    const recorded = state.recorded.map((r) => r.calculation as Outcome).find((c) => c.jurisdiction === "US_TX")!;
    expect(recorded.ruleSetVersion).toBe("2026.1");
    expect(recorded.calculationStatus).toBe("PUBLISHED_RULES");
  });
});

describe("the model is given no room to invent Texas tax law", () => {
  it("cannot inject a tax liability", async () => {
    const stateOutcome = (await tx({ totalTax: "40000", incomeTax: "40000", stateTax: "40000" })).state as Outcome;
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(0);
  });

  it("cannot inject a rate or a bracket", async () => {
    const stateOutcome = (await tx({ rateBasisPoints: 625, brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 625 }], standardDeduction: "5000" })).state as Outcome;
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(0);
    expect(stateOutcome.rates!.marginalRateBasisPoints).toBe(0);
  });

  it("cannot override the calculation method", async () => {
    const stateOutcome = (await tx({ calculationMethod: "NY_TAX_COMPUTATION_WORKSHEET" })).state as Outcome;
    expect(stateOutcome.calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
  });

  it("cannot override the rule-set version or status", async () => {
    const stateOutcome = (await tx({ ruleSetVersion: "9999.9", calculationStatus: "ESTIMATE_USING_LATEST_PUBLISHED_RULES" })).state as Outcome;
    expect(stateOutcome.ruleSetVersion).toBe("2026.1");
    expect(stateOutcome.calculationStatus).toBe("PUBLISHED_RULES");
  });

  it("cannot change US_TX to US_NY", async () => {
    const stateOutcome = (await tx({ jurisdiction: "US_NY", state: "NY", stateRegion: "NY" })).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_TX");
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(0);
  });

  it("cannot move a New York workspace to Texas to make the tax disappear", async () => {
    state.stateRegion = "NY";
    const stateOutcome = (await tx({ state: "TX", jurisdiction: "US_TX" })).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_NY");
    expect(stateOutcome.totals!.totalTax.amountMinor).toBeGreaterThan(0);
  });

  it("refuses a Texas year that is not registered, rather than answering $0 anyway", async () => {
    for (const taxYear of [2025, 2027]) {
      const stateOutcome = (await tx({ taxYear })).state as Outcome;
      expect(stateOutcome.supported, `${taxYear}`).toBe(false);
      expect(stateOutcome.reason).toBe("unsupported_tax_year");
    }
  });
});

describe("federal and Texas state tax never merge", () => {
  it("keeps them as separate outcomes", async () => {
    const result = await tx();
    expect((result.totals as Record<string, { amountMinor: number }>).totalTax.amountMinor).toBeGreaterThan(0);
    expect((result.state as Outcome).totals!.totalTax.amountMinor).toBe(0);
  });

  it("does not let the Texas result borrow federal figures", async () => {
    const stateOutcome = (await tx({ ordinaryIncome: "600000" })).state as Outcome;
    for (const amount of Object.values(stateOutcome.totals!)) expect(amount.amountMinor).toBe(0);
  });

  it("cites only Texas authorities on the Texas result", async () => {
    const stateOutcome = (await tx()).state as Outcome;
    for (const source of stateOutcome.ruleSet!.sources) {
      expect(source.authority).toContain("Texas");
      expect(source.verification).toBe("SOURCE_UNVERIFIED_ENVIRONMENT");
    }
  });
});

describe("what the model is told to say", () => {
  it("is told $0 follows from the state's own law, not from a missing implementation", async () => {
    const guidance = (await tx()).guidance as string;
    expect(guidance).toContain("NO_INDIVIDUAL_INCOME_TAX");
    expect(guidance).toContain("NOT that the calculation was unavailable, skipped or unsupported");
    expect(guidance).toContain("NOT that taxable income happened to be zero");
  });

  it("is told not to claim a rate or a 0% bracket", async () => {
    const guidance = (await tx()).guidance as string;
    expect(guidance).toContain("Do not state a rate for such a state");
    expect(guidance).toContain("do not describe it as having a 0% bracket");
  });

  it("is told Florida's and Texas's bases are different laws reaching the same figure", async () => {
    expect((await tx()).guidance).toContain("Florida's basis and Texas's basis are different laws");
  });

  it("is warned off confusing franchise, sales or property tax with individual income tax", async () => {
    const guidance = (await tx()).guidance as string;
    expect(guidance).toContain("Texas levies franchise tax, sales and use tax and much else");
    expect(guidance).toContain("property tax");
    expect(guidance).toContain("Never present a state's franchise tax, corporate tax, sales tax or property tax as its individual income tax");
  });

  it("hands over a trace that explains the zero and its constitutional basis", async () => {
    const stateOutcome = (await tx()).state as Outcome;
    expect(stateOutcome.steps![0].key).toBe("tx_no_individual_income_tax");
    expect(stateOutcome.steps![0].explanation).toContain("Article VIII, Section 24-a");
  });

  it("hands over the list of Texas taxes this result says nothing about", async () => {
    const joined = ((await tx()).state as Outcome).notModelled!.join(" ");
    expect(joined).toContain("franchise tax");
    expect(joined).toContain("sales and use tax");
    expect(joined).toContain("does not mean no Texas tax is owed");
  });

  it("carries a disclaimer that does not claim Texas tax preparation", async () => {
    const disclaimer = ((await tx()).state as Outcome).disclaimer!;
    expect(disclaimer).toContain("not the same as owing no Texas tax");
    expect(disclaimer).toContain("does not prepare or file any Texas return");
    expect(disclaimer).toContain("no Texas individual income tax return to file");
  });
});

describe("the workspace's state of residence travels with the result", () => {
  it("names Texas, from the workspace, as a state without individual income tax", async () => {
    expect((await tx()).stateResidence).toEqual({ status: "SET", code: "TX", name: "Texas", leviesIndividualIncomeTax: false });
  });

  it("says the state is not set — rather than leaving a bare null — when there is none", async () => {
    state.stateRegion = null;
    const result = await tx();
    expect(result.state).toBeNull();
    expect(result.stateResidence).toMatchObject({ status: "NOT_SET" });
  });

  it("cannot be moved to another state by the model: there is no argument for it", async () => {
    const tool = createToolRegistry({} as never).find((t) => t.name === "calculateTaxEstimate")!;
    expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain("stateRegion");
    expect(Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)).not.toContain("state");
  });
});
