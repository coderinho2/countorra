import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The user's state (src/domain/tax/supported-states.ts): how it is collected
 * at onboarding, validated, persisted, changed and audited in Settings, how it
 * routes the tax engines, and how the assistant learns it. Database-level
 * enforcement and cross-tenant isolation are in tests/rls/supported-states.test.ts.
 */

const state = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    created: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    audits: [] as { action: string; metadata?: unknown }[],
    stored: { id: "org-1", name: "Mine", entityType: "personal", country: "US", stateRegion: "CA" as string | null, baseCurrency: "USD" },
    role: "owner",
  };
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
  notFound: () => {},
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/server/auth/session", () => ({
  requireUser: async () => ({ id: "user-1" }),
  requireOrgMembership: async () => ({ user: { id: "user-1" }, membership: { role: state.role } }),
}));
vi.mock("@/server/security/rate-limit", () => ({ enforceRateLimit: async () => ({ allowed: true }), clientAddress: async () => "127.0.0.1" }));
vi.mock("@/server/db/repositories/subscriptions", () => ({
  listOwnedOrganizationSubscriptions: async () => ({ organizationIds: [], subscriptions: [] }),
}));
vi.mock("@/server/db/repositories/organizations", () => ({
  createOrganization: async (_c: unknown, input: Record<string, unknown>) => {
    state.created.push(input);
    return { id: "new-org" };
  },
  getOrganization: async () => ({ ...state.stored }),
  updateOrganization: async (_c: unknown, _id: string, updates: Record<string, unknown>) => {
    state.updates.push(updates);
  },
}));
vi.mock("@/server/db/repositories/profiles", () => ({ updateProfile: async () => {} }));
vi.mock("@/server/db/repositories/categories", () => ({ createCategory: async () => ({ id: "c" }) }));
vi.mock("@/domain/audit/audit-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/domain/audit/audit-log")>()),
  recordAuditEvent: async (_c: unknown, event: { action: string; metadata?: unknown }) => {
    state.audits.push({ action: event.action, metadata: event.metadata });
  },
}));

const states = await import("@/domain/tax/supported-states");
const { stateJurisdictionFor, getTaxEngine } = await import("@/domain/tax/register");
const { assessCompleteness, jurisdictionsFor } = await import("@/domain/tax-preparation/completeness");
const { withAuthoritativeState } = await import("@/domain/tax-preparation/jurisdiction");
const { buildSystemPrompt, stateContextLine } = await import("@/server/ai/service-factory");
const { completeOnboarding } = await import("@/server/onboarding/actions");
const { updateOrganizationAction } = await import("@/server/settings/actions");

beforeEach(() => {
  state.created = [];
  state.updates = [];
  state.audits = [];
  state.stored = { id: "org-1", name: "Mine", entityType: "personal", country: "US", stateRegion: "CA", baseCurrency: "USD" };
  state.role = "owner";
});

const ORG_ID = "11111111-1111-4111-8111-111111111111";

async function onboard(fields: Record<string, string>) {
  const form = new FormData();
  form.set("name", "My Finances");
  form.set("country", "US");
  form.set("baseCurrency", "USD");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  try {
    return (await completeOnboarding({}, form)) as { error?: string };
  } catch (error) {
    if (String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT")) return {};
    throw error;
  }
}

function settingsForm(stateRegion?: string) {
  const form = new FormData();
  form.set("organizationId", ORG_ID);
  form.set("name", "Mine");
  form.set("country", "US");
  form.set("baseCurrency", "USD");
  if (stateRegion !== undefined) form.set("stateRegion", stateRegion);
  return form;
}

describe("the supported states", () => {
  it("are exactly California, Texas, Arizona, Florida and New York", () => {
    expect(states.SUPPORTED_STATE_CODES).toEqual(["CA", "TX", "AZ", "FL", "NY"]);
  });

  it("each routes to its own registered state engine", () => {
    for (const s of states.SUPPORTED_STATES) {
      expect(stateJurisdictionFor("US", s.code)).toBe(s.jurisdiction);
      expect(getTaxEngine(s.jurisdiction), s.code).toBeDefined();
    }
  });

  it("route nothing for an unsupported state, a missing state, or a non-US workspace", () => {
    expect(stateJurisdictionFor("US", "WA")).toBeNull();
    expect(stateJurisdictionFor("US", null)).toBeNull();
    expect(stateJurisdictionFor("GB", "CA")).toBeNull();
  });

  it("are validated strictly, with case and whitespace normalised", () => {
    expect(states.supportedStateSchema.parse(" ny ")).toBe("NY");
    for (const bad of ["WA", "California", "", "C", undefined, null, 5]) {
      expect(states.supportedStateSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it("describe an unknown state honestly — never a default", () => {
    expect(states.stateContextFor({ country: "US", stateRegion: null })).toEqual({ status: "NOT_SET" });
    expect(states.stateContextFor({ country: "US", stateRegion: "WA" })).toEqual({ status: "UNSUPPORTED", code: "WA" });
    expect(states.stateContextFor({ country: "US", stateRegion: "TX" })).toMatchObject({ status: "SET", state: { name: "Texas", leviesIndividualIncomeTax: false } });
  });
});

describe("tax-engine routing from the persisted state", () => {
  const taxpayer = { primaryStateRegion: "NY" } as never;

  it.each([
    ["CA", ["US_FEDERAL", "US_CA"]],
    ["TX", ["US_FEDERAL", "US_TX"]],
    ["AZ", ["US_FEDERAL", "US_AZ"]],
    ["FL", ["US_FEDERAL", "US_FL"]],
    ["NY", ["US_FEDERAL", "US_NY"]],
  ])("a %s workspace is prepared under %j — whatever the case last stored", (code, expected) => {
    const authoritative = withAuthoritativeState(taxpayer, { country: "US", stateRegion: code });
    expect(jurisdictionsFor({ countryCode: "US", taxpayer: authoritative })).toEqual(expected);
  });

  it("a workspace with no state is prepared federally only", () => {
    const authoritative = withAuthoritativeState(taxpayer, { country: "US", stateRegion: null });
    expect(jurisdictionsFor({ countryCode: "US", taxpayer: authoritative })).toEqual(["US_FEDERAL"]);
  });

  const input = (primaryStateRegion: string | null) =>
    assessCompleteness({
      taxYear: 2026,
      filingStatus: "single",
      taxpayer: {
        legalFirstName: "A",
        legalMiddleName: null,
        legalLastName: "B",
        dateOfBirth: "1985-01-01",
        taxIdentifierType: "ssn",
        taxIdentifierOnFile: true,
        primaryStateRegion,
        additionalStateRegions: [],
        spouseFirstName: null,
        spouseLastName: null,
        spouseDateOfBirth: null,
        spouseTaxIdentifierOnFile: false,
        spouseItemizesDeductions: null,
      },
      dependents: [],
      facts: [],
      countryCode: "US",
      entityType: "personal",
      declaredIncomeKinds: [],
    });

  it("tells a person with no state that no state tax is calculated, without blocking federal", () => {
    const issue = input(null).issues.find((i) => i.id === "STATE_NOT_SET");
    expect(issue).toMatchObject({ severity: "WARNING", blocking: false });
  });

  it("names an unsupported state rather than calculating it", () => {
    expect(input("WA").issues.find((i) => i.id === "STATE_NOT_SUPPORTED")?.message).toContain("WA");
  });

  it.each(["CA", "TX", "AZ", "FL", "NY"])("raises no state-residence issue for %s", (code) => {
    expect(input(code).issues.some((i) => i.id === "STATE_NOT_SET" || i.id === "STATE_NOT_SUPPORTED")).toBe(false);
  });
});

describe("the assistant's state context", () => {
  it.each([
    ["CA", "California (CA)", "Form 540"],
    ["AZ", "Arizona (AZ)", "Form 140"],
    ["NY", "New York (NY)", "Form IT-201"],
  ])("knows a %s resident's state and return", (code, name, form) => {
    const line = stateContextLine({ country: "US", stateRegion: code });
    expect(line).toContain(name);
    expect(line).toContain(form);
    expect(line).toContain("Do not ask the user which state they live in");
  });

  it.each([
    ["TX", "Texas"],
    ["FL", "Florida"],
  ])("says %s levies no individual income tax", (code, name) => {
    expect(stateContextLine({ country: "US", stateRegion: code })).toContain(`${name} levies no individual income tax`);
  });

  it("never assumes a state when none is set", () => {
    const line = stateContextLine({ country: "US", stateRegion: null });
    expect(line).toContain("not set");
    expect(line).toContain("Never assume a state");
    for (const s of states.SUPPORTED_STATES) expect(line).not.toContain(s.name);
  });

  it("carries only this workspace's state into the prompt", () => {
    const prompt = buildSystemPrompt({ country: "US", stateRegion: "NY", baseCurrency: "USD" });
    expect(prompt).toContain("New York (NY)");
    for (const other of ["California", "Texas", "Arizona", "Florida"]) expect(prompt).not.toContain(`${other} (`);
  });

  it("is built from the organization the server loaded, not from the request", async () => {
    const { readFileSync } = await import("node:fs");
    const actions = readFileSync("src/server/ai/actions.ts", "utf8");
    expect(actions).toMatch(/system: buildSystemPrompt\(organization\)/);
    expect(actions).toMatch(/const organization = await getOrganization\(/);
  });
});

describe("onboarding collects the state", () => {
  it.each(["CA", "TX", "AZ", "FL", "NY"])("persists %s with the new workspace", async (code) => {
    expect((await onboard({ stateRegion: code })).error).toBeUndefined();
    expect(state.created.at(-1)).toMatchObject({ stateRegion: code, country: "US", entityType: "personal" });
  });

  it("refuses to create a workspace without a state — nothing is defaulted", async () => {
    expect((await onboard({})).error).toBe(states.STATE_REQUIRED_MESSAGE);
    expect(state.created).toEqual([]);
  });

  it.each(["WA", "California", "ZZ"])("refuses %j", async (value) => {
    expect((await onboard({ stateRegion: value })).error).toBe(states.STATE_REQUIRED_MESSAGE);
    expect(state.created).toEqual([]);
  });

  it("refuses a non-US country", async () => {
    expect((await onboard({ stateRegion: "CA", country: "GB" })).error).toBeDefined();
    expect(state.created).toEqual([]);
  });
});

describe("Settings changes the state", () => {
  it("saves a new supported state and audits the change with what it replaced", async () => {
    expect(await updateOrganizationAction({}, settingsForm("NY"))).toEqual({ success: true });
    expect(state.updates.at(-1)).toMatchObject({ stateRegion: "NY" });
    expect(state.audits).toEqual([{ action: "organization.state_changed", metadata: { from: "CA", to: "NY" } }]);
  });

  it("does not audit a save that leaves the state unchanged", async () => {
    await updateOrganizationAction({}, settingsForm("CA"));
    expect(state.audits).toEqual([]);
  });

  it("audits a legacy workspace's first state", async () => {
    state.stored.stateRegion = null;
    await updateOrganizationAction({}, settingsForm("TX"));
    expect(state.audits).toEqual([{ action: "organization.state_changed", metadata: { from: null, to: "TX" } }]);
  });

  it.each([undefined, "", "WA"])("refuses %j and writes nothing", async (value) => {
    const result = await updateOrganizationAction({}, settingsForm(value));
    expect(result.error).toBe(states.STATE_REQUIRED_MESSAGE);
    expect(state.updates).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("refuses a member without permission to update the workspace", async () => {
    state.role = "viewer";
    const result = await updateOrganizationAction({}, settingsForm("NY"));
    expect(result.error).toMatch(/permission/);
    expect(state.updates).toEqual([]);
  });
});
