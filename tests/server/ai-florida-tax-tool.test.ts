import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Florida at the AI boundary.
 *
 * The failure modes here are different from every other state's. Nobody will
 * hand the model a fabricated Florida bracket — there is no bracket to
 * fabricate. What could go wrong is the model asserting "$0" from its own
 * recollection rather than from the engine, presenting $0 as "unsupported",
 * or letting "no individual income tax" become "no Florida tax".
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return { country: "US", stateRegion: "FL" as string | null, baseCurrency: "USD", recorded: [] as Record<string, unknown>[] };
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
  ruleSet?: { sources: { authority: string; url: string }[] };
};

async function callTax(rawInput: unknown): Promise<ToolResult> {
  const registry = createToolRegistry({} as never);
  const tool = registry.find((t) => t.name === "calculateTaxEstimate")!;
  const parsed = tool.parseInput ? tool.parseInput(rawInput) : rawInput;
  return (await tool.execute(parsed, { organizationId: ORG, userId: USER })) as ToolResult;
}

const fl = (extra: Record<string, unknown> = {}) =>
  callTax({ taxYear: 2026, filingStatus: "single", ordinaryIncome: "150000", ...extra });

beforeEach(() => {
  state.country = "US";
  state.stateRegion = "FL";
  state.baseCurrency = "USD";
  state.recorded = [];
});

describe("a Florida workspace gets an authoritative $0, from the engine", () => {
  it("returns a supported Florida result rather than a null state", () => {
    // The distinction the whole task turns on: "we know, and it is zero" is
    // not the same as "we don't model this state".
    return fl().then((result) => {
      const stateOutcome = result.state as Outcome;
      expect(stateOutcome).not.toBeNull();
      expect(stateOutcome.supported).toBe(true);
      expect(stateOutcome.jurisdiction).toBe("US_FL");
    });
  });

  it("reports $0 with the NO_INDIVIDUAL_INCOME_TAX method", async () => {
    const stateOutcome = (await fl()).state as Outcome;
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(0);
    expect(stateOutcome.calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
  });

  it("stamps the requested year and Florida's own rule set", async () => {
    const stateOutcome = (await fl()).state as Outcome;
    expect(stateOutcome.requestedTaxYear).toBe(2026);
    expect(stateOutcome.taxYear).toBe(2026);
    expect(stateOutcome.ruleSetVersion).toBe("2026.1");
    expect(stateOutcome.calculationStatus).toBe("PUBLISHED_RULES");
  });

  it("still returns the federal figure, which a Florida resident owes in full", async () => {
    const result = await fl();
    expect(result.supported).toBe(true);
    expect((result.totals as Record<string, { amountMinor: number }>).totalTax.amountMinor).toBeGreaterThan(0);
  });

  it("records the Florida calculation like any other", async () => {
    await fl();
    const recorded = state.recorded.map((r) => r.calculation as Outcome).find((c) => c.jurisdiction === "US_FL")!;
    expect(recorded.ruleSetVersion).toBe("2026.1");
    expect(recorded.calculationStatus).toBe("PUBLISHED_RULES");
  });

  it("gives the same $0 for every filing status and any income", async () => {
    for (const filingStatus of ["single", "married_filing_jointly", "married_filing_separately", "head_of_household", "qualifying_surviving_spouse"] as const) {
      const stateOutcome = (await fl({ filingStatus, ordinaryIncome: "9000000" })).state as Outcome;
      expect(stateOutcome.totals!.totalTax.amountMinor, filingStatus).toBe(0);
    }
  });
});

describe("the model is given no room to invent Florida tax law", () => {
  it("cannot inject a tax liability", async () => {
    const stateOutcome = (await fl({ totalTax: "25000", incomeTax: "25000", stateTax: "25000" })).state as Outcome;
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(0);
  });

  it("cannot inject a rate or a bracket", async () => {
    const stateOutcome = (await fl({ rateBasisPoints: 500, brackets: [{ fromMinor: 0, upToMinor: null, rateBasisPoints: 500 }], standardDeduction: "1000" })).state as Outcome;
    expect(stateOutcome.totals!.totalTax.amountMinor).toBe(0);
    expect(stateOutcome.rates!.marginalRateBasisPoints).toBe(0);
  });

  it("cannot override the calculation method", async () => {
    const stateOutcome = (await fl({ calculationMethod: "NY_RATE_SCHEDULE" })).state as Outcome;
    expect(stateOutcome.calculationMethod).toBe("NO_INDIVIDUAL_INCOME_TAX");
  });

  it("cannot override the rule-set version or status", async () => {
    const stateOutcome = (await fl({ ruleSetVersion: "9999.9", calculationStatus: "ESTIMATE_USING_LATEST_PUBLISHED_RULES" })).state as Outcome;
    expect(stateOutcome.ruleSetVersion).toBe("2026.1");
    expect(stateOutcome.calculationStatus).toBe("PUBLISHED_RULES");
  });

  it("cannot move a Florida workspace to New York or California", async () => {
    const stateOutcome = (await fl({ state: "NY", jurisdiction: "US_NY", stateRegion: "CA" })).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_FL");
  });

  it("cannot move a New York workspace to Florida to make the tax disappear", async () => {
    state.stateRegion = "NY";
    const stateOutcome = (await fl({ state: "FL", jurisdiction: "US_FL" })).state as Outcome;
    expect(stateOutcome.jurisdiction).toBe("US_NY");
    expect(stateOutcome.totals!.totalTax.amountMinor).toBeGreaterThan(0);
  });

  it("refuses a Florida year that is not registered, rather than answering $0 anyway", async () => {
    // $0 would even be the right number. It would still be an unverified
    // claim about a year nobody checked.
    for (const taxYear of [2025, 2027]) {
      const stateOutcome = (await fl({ taxYear })).state as Outcome;
      expect(stateOutcome.supported, `${taxYear}`).toBe(false);
      expect(stateOutcome.reason).toBe("unsupported_tax_year");
    }
  });
});

describe("the federal figure and the Florida figure never merge", () => {
  it("keeps them as separate outcomes", async () => {
    const result = await fl();
    const federalTax = (result.totals as Record<string, { amountMinor: number }>).totalTax.amountMinor;
    expect(federalTax).toBeGreaterThan(0);
    expect((result.state as Outcome).totals!.totalTax.amountMinor).toBe(0);
  });

  it("does not let the Florida result borrow federal figures", async () => {
    const stateOutcome = (await fl({ ordinaryIncome: "400000" })).state as Outcome;
    for (const amount of Object.values(stateOutcome.totals!)) expect(amount.amountMinor).toBe(0);
  });

  it("cites only Florida authorities on the Florida result", async () => {
    const stateOutcome = (await fl()).state as Outcome;
    for (const source of stateOutcome.ruleSet!.sources) expect(source.authority).toContain("Florida");
  });
});

describe("what the model is told to say", () => {
  it("is told $0 follows from the state's law, not from a missing implementation", async () => {
    const result = await fl();
    expect(result.guidance).toContain("NO_INDIVIDUAL_INCOME_TAX");
    expect(result.guidance).toContain("NOT that the calculation was unavailable, skipped or unsupported");
  });

  it("is told not to state a rate or claim a 0% bracket", async () => {
    const guidance = (await fl()).guidance as string;
    expect(guidance).toContain("Do not state a rate for such a state");
    expect(guidance).toContain("do not describe it as having a 0% bracket");
  });

  it("is warned off turning $0 individual income tax into $0 state tax", async () => {
    const guidance = (await fl()).guidance as string;
    expect(guidance).toContain("do not let '$0 individual income tax' become '$0 state tax'");
    expect(guidance).toContain("Florida levies corporate income tax and sales and use tax");
  });

  it("is told to take the figure from the result rather than assert it", async () => {
    const result = await fl();
    expect(result.guidance).toContain("Report the $0 from the result");
  });

  it("hands over a trace that explains the zero", async () => {
    const stateOutcome = (await fl()).state as Outcome;
    expect(stateOutcome.steps![0].key).toBe("fl_no_individual_income_tax");
    expect(stateOutcome.steps![0].explanation).toContain("Article VII, Section 5");
  });

  it("hands over the list of Florida taxes this result says nothing about", async () => {
    const joined = ((await fl()).state as Outcome).notModelled!.join(" ");
    expect(joined).toContain("corporate income");
    expect(joined).toContain("sales and use tax");
    expect(joined).toContain("does not mean no Florida tax is owed");
  });

  it("carries a disclaimer that does not claim Florida tax preparation", async () => {
    const disclaimer = ((await fl()).state as Outcome).disclaimer!;
    expect(disclaimer).toContain("not the same as owing no Florida tax");
    expect(disclaimer).toContain("does not prepare or file any Florida return");
  });
});
