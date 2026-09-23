import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assessCompleteness, type CompletenessInput } from "@/domain/tax-preparation/completeness";
import type { TaxFact, TaxpayerProfile } from "@/domain/tax-preparation/types";
import { SUPPORTED_STATES } from "@/domain/tax/supported-states";

/**
 * "Calculation is blocked by 2 unresolved issues."
 *
 * THE REPORTED SCENARIO, PINNED. A person started a tax year and pressed
 * Calculate, and got a count with no names. Tracing it produced a precise
 * answer: exactly one case state yields exactly two blockers — a case with no
 * filing status and no confirmed figure, which is what a brand-new case is.
 *
 * Both blockers are CORRECT. A tax calculation without a filing status has no
 * bracket table to use, and one without a confirmed figure has nothing to
 * apply it to; producing a number anyway would mean inventing one. So these
 * cases assert that the blockers STAY, and that they disappear only when the
 * missing information actually arrives.
 *
 * What was wrong was the telling, not the blocking — see
 * `the refusal names what is wrong` at the foot of this file.
 */

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

const taxpayer = (over: Record<string, unknown> = {}): TaxpayerProfile =>
  ({
    legalFirstName: "Alex",
    legalMiddleName: null,
    legalLastName: "Morgan",
    dateOfBirth: "1990-04-12",
    taxIdentifierType: "ssn",
    taxIdentifierOnFile: true,
    primaryStateRegion: "CA",
    additionalStateRegions: [],
    spouseFirstName: null,
    spouseLastName: null,
    spouseDateOfBirth: null,
    spouseTaxIdentifierType: null,
    spouseTaxIdentifierOnFile: false,
    spouseItemizesDeductions: null,
    ...over,
  }) as unknown as TaxpayerProfile;

/** A confirmed wage figure — the kind a person types in and confirms. */
const wages = (over: Record<string, unknown> = {}): TaxFact =>
  ({
    id: "fact-wages",
    key: "W2_WAGES",
    state: "CONFIRMED",
    amountMinor: 8_640_000,
    currency: "USD",
    evidenceDocumentId: null,
    ...over,
  }) as unknown as TaxFact;

const caseInput = (over: Partial<CompletenessInput> = {}): CompletenessInput =>
  ({
    taxYear: 2026,
    countryCode: "US",
    entityType: "personal",
    declaredIncomeKinds: [],
    dependents: [],
    filingStatus: null,
    taxpayer: taxpayer(),
    facts: [],
    ...over,
  }) as CompletenessInput;

const blockerIds = (input: CompletenessInput) => assessCompleteness(input).blockers.map((issue) => issue.id).sort();

describe("A. the reported scenario", () => {
  it("a brand-new case produces EXACTLY these two blockers", () => {
    const result = assessCompleteness(caseInput());
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers.map((issue) => issue.id).sort()).toEqual(["FILING_STATUS_MISSING", "NO_CONFIRMED_FACTS"]);
    expect(result.readyForCalculation).toBe(false);
  });

  it("names both, and says where each is fixed", () => {
    for (const issue of assessCompleteness(caseInput()).blockers) {
      expect(issue.message.length, issue.id).toBeGreaterThan(20);
      expect(issue.resolution, issue.id).toBeTruthy();
      expect(issue.affects, issue.id).toBeTruthy();
    }
  });

  it("clears the first blocker when a filing status is chosen, and only that one", () => {
    expect(blockerIds(caseInput({ filingStatus: "single" }))).toEqual(["NO_CONFIRMED_FACTS"]);
  });

  it("clears the second when a figure is confirmed, and only that one", () => {
    expect(blockerIds(caseInput({ facts: [wages()] }))).toEqual(["FILING_STATUS_MISSING"]);
  });

  it("calculates once both are supplied — the scenario end to end", () => {
    const result = assessCompleteness(caseInput({ filingStatus: "single", facts: [wages()] }));
    expect(result.blockers).toEqual([]);
    expect(result.readyForCalculation).toBe(true);
    expect(result.jurisdictions).toEqual(["US_FEDERAL", "US_CA"]);
  });
});

describe("B. a blocker that is genuinely legitimate stays", () => {
  it("does not accept a suggested figure as a confirmed one", () => {
    // A PROPOSED value is a suggestion nobody has agreed to. Treating it as
    // confirmed is exactly how a calculation would come to rest on a number
    // the person never saw.
    const result = assessCompleteness(caseInput({ filingStatus: "single", facts: [wages({ state: "PROPOSED" })] }));
    expect(result.blockers.map((issue) => issue.id)).toEqual(["NO_CONFIRMED_FACTS"]);
    expect(result.issues.some((issue) => issue.id === "PROPOSED_FACTS_PENDING")).toBe(true);
  });

  it("refuses a year the federal rules do not cover, rather than using another year's", () => {
    const result = assessCompleteness(caseInput({ taxYear: 2025, filingStatus: "single", facts: [wages()] }));
    expect(result.blockers.map((issue) => issue.id)).toEqual(["FEDERAL_YEAR_UNSUPPORTED"]);
  });

  it("refuses married-filing-separately when the spouse itemizes", () => {
    // Countorra only applies the standard deduction, which is not available
    // in this situation. A figure here would be wrong, so there is none.
    const result = assessCompleteness(
      caseInput({ filingStatus: "married_filing_separately", taxpayer: taxpayer({ spouseItemizesDeductions: true, spouseFirstName: "Sam", spouseLastName: "Morgan" }), facts: [wages()] }),
    );
    expect(result.blockers.map((issue) => issue.id)).toEqual(["MFS_STANDARD_DEDUCTION_NOT_ALLOWED"]);
  });
});

describe("C. every supported state", () => {
  it.each(SUPPORTED_STATES.map((state) => [state.code, state.jurisdiction] as const))("%s calculates federal + its own jurisdiction, with no blocker", (code, jurisdiction) => {
    const result = assessCompleteness(caseInput({ filingStatus: "single", taxpayer: taxpayer({ primaryStateRegion: code }), facts: [wages()] }));
    expect(result.blockers, code).toEqual([]);
    expect(result.jurisdictions, code).toEqual(["US_FEDERAL", jurisdiction]);
  });

  it("invents no state-income-tax blocker for the states that levy none", () => {
    for (const code of ["TX", "FL"]) {
      const result = assessCompleteness(caseInput({ filingStatus: "single", taxpayer: taxpayer({ primaryStateRegion: code }), facts: [wages()] }));
      expect(result.issues.some((issue) => issue.category === "JURISDICTION"), code).toBe(false);
    }
  });

  it("warns without blocking when Arizona's 2026 inputs are unpublished", () => {
    const result = assessCompleteness(caseInput({ filingStatus: "single", taxpayer: taxpayer({ primaryStateRegion: "AZ" }), facts: [wages()] }));
    expect(result.blockers).toEqual([]);
    const issue = result.issues.find((entry) => entry.id === "JURISDICTION_RULES_PENDING:US_AZ");
    expect(issue?.blocking).toBe(false);
    // The federal figure is unaffected, which is the point of not blocking.
    expect(result.jurisdictions).toContain("US_FEDERAL");
  });

  it("does not block when no state is known, and calculates federal alone", () => {
    const result = assessCompleteness(caseInput({ filingStatus: "single", taxpayer: taxpayer({ primaryStateRegion: null }), facts: [wages()] }));
    expect(result.blockers).toEqual([]);
    expect(result.jurisdictions).toEqual(["US_FEDERAL"]);
    // Never a default state — it says so instead.
    expect(result.issues.some((issue) => issue.id === "STATE_NOT_SET")).toBe(true);
  });

  it("does not block on an unsupported state either, and never taxes it", () => {
    const result = assessCompleteness(caseInput({ filingStatus: "single", taxpayer: taxpayer({ primaryStateRegion: "OR" }), facts: [wages()] }));
    expect(result.blockers).toEqual([]);
    expect(result.jurisdictions).toEqual(["US_FEDERAL"]);
    expect(result.issues.some((issue) => issue.id === "STATE_NOT_SUPPORTED")).toBe(true);
  });
});

describe("D. readiness is recomputed, never cached", () => {
  it("is a pure function of the case, so the same input always answers the same", () => {
    const input = caseInput({ filingStatus: "single", facts: [wages()] });
    expect(assessCompleteness(input).readyForCalculation).toBe(assessCompleteness(input).readyForCalculation);
  });

  it("is recomputed on every workspace load rather than read from a stored column", () => {
    const workspace = read("src/server/tax-preparation/workspace.ts");
    expect(workspace).toContain("assessCompleteness(");
    // A stored readiness flag is what makes a resolved blocker linger.
    expect(workspace).not.toMatch(/readyForCalculation\s*[:=]\s*(storedCase|preparationCase)\./);
  });

  it("revalidates the page after every action that can change readiness", () => {
    const actions = read("src/server/tax-preparation/actions.ts");
    for (const action of ["updateTaxpayerAction", "recordFactAction", "reviewFactAction", "addDependentAction", "removeDependentAction"]) {
      const start = actions.indexOf(`export async function ${action}`);
      const next = actions.indexOf("export async function", start + 1);
      const body = actions.slice(start, next === -1 ? undefined : next);
      expect(body, action).toContain("revalidatePath");
    }
  });
});

describe("E. the client cannot talk its way past a blocker", () => {
  const actions = read("src/server/tax-preparation/actions.ts");

  it("re-derives completeness on the server instead of trusting the request", () => {
    const body = actions.slice(actions.indexOf("export async function calculateTaxPreparationAction"));
    expect(body).toContain("loadPreparationWorkspace");
    expect(body).toMatch(/completeness\.blockers\.length > 0/);
  });

  it("accepts only ids from the form — no filing status, no figures, no readiness", () => {
    const body = actions.slice(actions.indexOf("export async function calculateTaxPreparationAction"), actions.indexOf("export async function archiveTaxPreparationAction"));
    const fields = [...body.matchAll(/field\(formData, "([^"]+)"\)/g)].map((match) => match[1]).sort();
    expect(fields).toEqual(["caseId", "organizationId"]);
  });

  it("takes the state from the organization, never from the case's stored copy", () => {
    expect(read("src/server/tax-preparation/workspace.ts")).toContain("withAuthoritativeState(storedCase.taxpayer, organization)");
  });
});

describe("the refusal names what is wrong, not just how much", () => {
  it("returns the blocking issues alongside the count", () => {
    const actions = read("src/server/tax-preparation/actions.ts");
    const body = actions.slice(actions.indexOf("export async function calculateTaxPreparationAction"));
    expect(body).toMatch(/blockers: completeness\.blockers\.slice/);
    expect(body).toMatch(/message: issue\.message/);
    expect(body).toMatch(/resolution: issue\.resolution/);
  });

  it("renders them under the Calculate button", () => {
    const form = read("src/components/tax-preparation/preparation-forms.tsx");
    const body = form.slice(form.indexOf("export function CalculateForm"), form.indexOf("// ── Taxpayer"));
    expect(body).toContain("state.blockers");
    expect(body).toContain("blocker.resolution");
  });

  it("distinguishes a blocking issue from a non-blocking one in the list", () => {
    const page = read("src/app/app/[orgId]/tax-preparation/page.tsx");
    const badges = page.slice(page.indexOf("const SEVERITY_BADGE"), page.indexOf("const PROGRESS_BADGE"));
    expect(badges).toMatch(/BLOCKER:\s*\{\s*label: "Blocks calculation", variant: "negative"/);
    expect(badges).toMatch(/ERROR:\s*\{\s*label: "Needs fixing", variant: "warning"/);
  });
});
