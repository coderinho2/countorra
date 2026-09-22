import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Countorra's personal-only launch scope, end to end at the application layer
 * (src/domain/organizations/launch-scope.ts). The database side is in
 * tests/rls/personal-launch-scope.test.ts; onboarding in
 * tests/server/entitlement-enforcement.test.ts; navigation in
 * src/components/app-shell/nav-items.test.ts.
 */

const calls = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return { supabase: 0, auth: 0 };
});

vi.mock("@/server/supabase/server", () => ({
  createClient: async () => {
    calls.supabase += 1;
    return {};
  },
}));
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => {
    calls.auth += 1;
    return { id: "user" };
  },
  requireOrgMembership: async () => {
    calls.auth += 1;
    return { user: { id: "user" }, membership: { role: "owner" } };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {}, notFound: () => {} }));

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

const scope = await import("@/domain/organizations/launch-scope");
const { createOrganizationSchema } = await import("@/validation/schemas/organization");
const { createToolRegistry } = await import("@/domain/ai/tools/registry");
const { DEFERRED_TOOLS, launchScopeTools, isToolInLaunchScope } = await import("@/domain/ai/tools/launch-scope");
const { buildSystemPrompt, AI_SYSTEM_PROMPT, PERSONAL_CONTEXT } = await import("@/server/ai/service-factory");
const { TAX_ENGINE_SCOPE } = await import("@/domain/tax/tax-engine");
const { supportedJurisdictions } = await import("@/domain/tax/register");
const { PLAN_ENTITLEMENTS, FEATURE_IMPLEMENTED } = await import("@/domain/billing/entitlements");
const { calculateFinancialHealth } = await import("@/domain/insights/financial-health");
const { SEGMENTS } = await import("@/components/marketing/segments-data");
const { NAV_GROUPS, DIRECT_LINKS } = await import("@/components/marketing/nav-data");

beforeEach(() => {
  calls.supabase = 0;
  calls.auth = 0;
});

describe("the entity model", () => {
  it("launches with personal as the only entity type", () => {
    expect(scope.LAUNCH_ENTITY_TYPES).toEqual(["personal"]);
    expect(scope.DEFERRED_ENTITY_TYPES).toEqual(["freelancer", "business"]);
    expect(scope.isLaunchEntityType("personal")).toBe(true);
    for (const value of ["freelancer", "business", "", null, undefined]) expect(scope.isLaunchEntityType(value)).toBe(false);
  });

  it("presents every stored workspace — legacy ones included — as personal", () => {
    for (const stored of ["personal", "freelancer", "business"] as const) expect(scope.productEntityType(stored)).toBe("personal");
  });

  it("accepts only personal when creating an organization, and defaults to it", () => {
    expect(createOrganizationSchema.parse({ name: "Mine", stateRegion: "CA" }).entityType).toBe("personal");
    expect(createOrganizationSchema.parse({ name: "Mine", entityType: "personal", stateRegion: "CA" }).entityType).toBe("personal");
    for (const entityType of ["freelancer", "business"]) {
      const result = createOrganizationSchema.safeParse({ name: "Mine", entityType, stateRegion: "CA" });
      expect(result.success, entityType).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(scope.PERSONAL_ONLY_MESSAGE);
    }
  });

  it("defers invoicing, and nothing else", () => {
    expect([...scope.DEFERRED_MODULES]).toEqual(["invoicing"]);
    expect(scope.isModuleEnabled("invoicing")).toBe(false);
  });
});

describe("the deferred invoicing module", () => {
  it("refuses every invoice and customer action before touching auth or the database", async () => {
    const invoices = await import("@/server/invoices/actions");
    const customers = await import("@/server/customers/actions");
    const results = await Promise.all([
      invoices.createInvoiceAction({}, new FormData()),
      invoices.updateInvoiceStatusAction("org", "inv", "paid"),
      invoices.sendInvoiceAction("org", "inv"),
      invoices.getInvoiceShareLinkAction("org", "inv"),
      customers.createCustomerAction({}, new FormData()),
    ]);
    for (const result of results) expect(result).toEqual({ error: scope.DEFERRED_MODULE_MESSAGE });
    expect(calls).toEqual({ supabase: 0, auth: 0 });
  });

  it("answers 404 on every invoice and customer page", () => {
    for (const segment of ["invoices", "customers"]) {
      const layout = read(`src/app/app/[orgId]/${segment}/layout.tsx`);
      expect(layout).toMatch(/if \(!isModuleEnabled\("invoicing"\)\) notFound\(\);/);
    }
  });

  it("keeps the public page for invoices already sent working — those links are in real inboxes", () => {
    expect(read("src/app/invoice/[token]/page.tsx")).not.toMatch(/isModuleEnabled/);
  });
});

describe("the assistant", () => {
  const all = createToolRegistry(null as never);
  const offered = launchScopeTools(all);

  it("still defines every tool — deferral removes nothing from the registry", () => {
    // 43 defined (checkAffordability and getNetWorth added); 38 offered at launch.
    expect(all).toHaveLength(43);
    expect(offered).toHaveLength(all.length - Object.keys(DEFERRED_TOOLS).length);
  });

  it("is offered every tool except exactly the five invoicing ones", () => {
    const withheld = all.map((t) => t.name).filter((name) => !offered.some((t) => t.name === name));
    expect(withheld.sort()).toEqual(["createDraftInvoice", "getCustomers", "getInvoice", "getInvoices", "getOverdueInvoices"]);
    expect(Object.keys(DEFERRED_TOOLS).sort()).toEqual(withheld.sort());
  });

  it("keeps the personal finance, personal tax and bank tools", () => {
    const names = offered.map((t) => t.name);
    for (const name of [
      "getFinancialOverview",
      "searchTransactions",
      "categorizeTransaction",
      "createDraftExpense",
      "getRecurringExpenses",
      "detectAnomalies",
      "forecastCashFlow",
      "calculateTaxEstimate",
      "getTaxPreparationStatus",
      "proposeTaxFact",
      "getFilingReadiness",
      "explainDocument",
      "getBankConnectionStatus",
      "prepareReport",
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it("will not replay a pending invoice write on confirmation", () => {
    expect(isToolInLaunchScope("createDraftInvoice")).toBe(false);
    expect(isToolInLaunchScope("categorizeTransaction")).toBe(true);
    const actions = read("src/server/ai/actions.ts");
    const guard = actions.indexOf("if (!isToolInLaunchScope(action.toolName))");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(actions.indexOf("claimActionForExecution(client, action.id"));
  });

  it("is given the launch tool set by the one factory that builds it", () => {
    expect(read("src/server/ai/service-factory.ts")).toMatch(/launchScopeTools\(createToolRegistry\(client\)\)/);
  });

  it("is a personal finance and personal tax assistant, whatever the workspace's stored type", () => {
    const prompt = buildSystemPrompt({ country: "US", stateRegion: "CA", baseCurrency: "USD" });
    expect(AI_SYSTEM_PROMPT).toMatch(/personal finance and personal tax assistant/);
    expect(prompt).toContain(PERSONAL_CONTEXT);
    expect(prompt).not.toMatch(/freelanc|Entity type:|business workspace/i);
    expect(PERSONAL_CONTEXT).toMatch(/does not keep books for a business, issue invoices or prepare business tax returns/);
  });

  it("suggests only personal questions, including one about taxes", () => {
    const panel = read("src/components/ai/ai-chat-panel.tsx");
    const block = panel.slice(panel.indexOf("export const SUGGESTED_QUESTIONS"), panel.indexOf("];", panel.indexOf("export const SUGGESTED_QUESTIONS")));
    expect(block).not.toMatch(/invoice|client|customer|business|freelanc|our /i);
    expect(block).toMatch(/group: "Taxes"/);
    expect(panel).not.toMatch(/entityType/);
  });
});

describe("the tax engine", () => {
  it("covers individual returns only", () => {
    expect(TAX_ENGINE_SCOPE.returnType).toBe("individual");
    expect(TAX_ENGINE_SCOPE.notSupported.join(" ")).toMatch(/1120.*1065/);
    expect(TAX_ENGINE_SCOPE.notSupported).toContain("Filing or submitting any return");
  });

  it("states exactly the state jurisdictions that have rule sets", () => {
    const states = supportedJurisdictions().filter((j) => j !== "US_FEDERAL").sort();
    expect(Object.keys(TAX_ENGINE_SCOPE.states).sort()).toEqual(states);
  });

  it("still refuses to prepare a personal return for a workspace recorded as a business", () => {
    expect(read("src/domain/tax-preparation/completeness.ts")).toMatch(/ENTITY_RETURN_NOT_SUPPORTED/);
  });
});

describe("Stripe subscription tiers are untouched", () => {
  it("keeps Free, Premium $19 and Business $49 — 'Business' is a plan, not an entity type", () => {
    expect(Object.keys(PLAN_ENTITLEMENTS)).toEqual(["free", "premium", "business"]);
    expect(PLAN_ENTITLEMENTS.free.priceMinorMonthly).toBe(0);
    expect(PLAN_ENTITLEMENTS.premium.priceMinorMonthly).toBe(1_900);
    expect(PLAN_ENTITLEMENTS.business.priceMinorMonthly).toBe(4_900);
  });

  it("keeps bank connections (Plaid) on the paid plans", () => {
    expect(PLAN_ENTITLEMENTS.free.bankConnections).toBe(false);
    expect(PLAN_ENTITLEMENTS.premium.bankConnections).toBe(true);
    expect(PLAN_ENTITLEMENTS.business.bankConnections).toBe(true);
    expect(FEATURE_IMPLEMENTED.bankConnections).toBe(true);
  });
});

describe("financial health for a personal workspace", () => {
  const input = {
    currency: "USD" as const,
    cashBalanceMinor: 1_000_000,
    averageMonthlyExpenseMinor: 300_000,
    averageMonthlyIncomeMinor: 500_000,
    monthlyExpenseTotalsMinor: [300_000, 310_000, 290_000],
    recurringAnnualCostMinor: 600_000,
    overdueReceivablesMinor: 0,
    totalReceivablesMinor: 0,
  };

  it("does not score receivables, which would otherwise pad every personal score with a free 100", () => {
    const personal = calculateFinancialHealth({ ...input, includeReceivables: false });
    expect(personal.factors.map((f) => f.key)).not.toContain("receivablesHealth");
    const withFreeHundred = calculateFinancialHealth(input);
    expect(withFreeHundred.factors.map((f) => f.key)).toContain("receivablesHealth");
    expect(personal.overallScore).toBeLessThanOrEqual(withFreeHundred.overallScore);
  });

  it("renormalises the remaining weights, so a perfect personal record still scores 100", () => {
    const perfect = calculateFinancialHealth({ ...input, cashBalanceMinor: 100_000_000, averageMonthlyIncomeMinor: 10_000_000, monthlyExpenseTotalsMinor: [300_000, 300_000, 300_000], recurringAnnualCostMinor: 0, includeReceivables: false });
    expect(perfect.overallScore).toBe(100);
  });

  it("is computed without receivables on the dashboard while invoicing is deferred", () => {
    expect(read("src/server/dashboard/get-dashboard-data.ts")).toMatch(/includeReceivables: invoicing/);
  });
});

describe("public positioning", () => {
  it("presents one audience", () => {
    expect(SEGMENTS.map((s) => s.key)).toEqual(["personal"]);
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(["Product", "Resources"]);
    expect(DIRECT_LINKS[0]).toMatchObject({ label: "Personal finance", href: "/solutions/personal" });
    expect(JSON.stringify(NAV_GROUPS)).not.toMatch(/freelanc|Invoices|Customers/i);
  });

  it("retires the Freelancer and Business pages behind permanent redirects", async () => {
    const { default: config } = await import("../../next.config");
    const redirects = await config.redirects!();
    expect(redirects).toEqual([
      { source: "/solutions", destination: "/solutions/personal", permanent: true },
      { source: "/solutions/freelancer", destination: "/solutions/personal", permanent: true },
      { source: "/solutions/business", destination: "/solutions/personal", permanent: true },
    ]);
    expect(read("src/app/sitemap.ts")).not.toMatch(/solutions\/(freelancer|business)/);
  });

  it("describes Countorra as a personal finance and personal tax platform", () => {
    expect(read("src/app/layout.tsx")).toMatch(/An AI-powered personal finance and personal tax platform/);
    expect(read("src/app/layout.tsx")).not.toMatch(/freelancers, and businesses/);
  });
});
