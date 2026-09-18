import type { CurrencyCode } from "@/domain/money/currency";
import { factDefinition } from "./facts";
import type { PreparationCalculation } from "./calculation";
import type { CompletenessResult } from "./completeness";
import type { PreparationCase, PreparationDependent, PreparationIssue, TaxFact, TaxFactKey, TaxInputSnapshot } from "./types";

/**
 * THE PREPARATION PACKAGE.
 *
 * Everything a person — or, later, a tax professional — needs to see what was
 * prepared, what it was based on, and what it does not cover. Assembled from
 * data that already exists rather than computed afresh, so the package can
 * never disagree with the snapshot it describes.
 *
 * IT IS NOT A RETURN. There is no form here, no signature, no submission, and
 * no field called "final". Countorra does not file anything, and the
 * disclaimer on every package says so.
 *
 * DESIGNED FOR A LATER EXPORT, NOT EXPORTED HERE. The shape is plain,
 * serializable data so that a future task can render it to PDF, hand it to a
 * reviewer, or map it to filing formats — none of which is implemented.
 */

export interface PreparationProgressSection {
  /** Stable key for the UI. */
  key: "TAXPAYER" | "FILING_STATUS" | "DEPENDENTS" | "INCOME" | "DOCUMENTS" | "DEDUCTIONS" | "STATE" | "CALCULATION";
  label: string;
  state: "COMPLETE" | "REVIEW_REQUIRED" | "MISSING_INFORMATION" | "BLOCKED" | "NOT_STARTED";
  /** Concrete, e.g. "5 accepted / 1 pending". Never a percentage. */
  detail: string;
}

export interface IncomeLine {
  key: TaxFactKey;
  label: string;
  amountMinor: number;
  /** How many separate confirmed entries make up the total. */
  entryCount: number;
  /** Whether an engine actually used it. */
  calculated: boolean;
  /** How many of the entries have a document behind them. */
  evidencedCount: number;
}

export interface PreparationPackage {
  /** metadata */
  caseId: string;
  organizationId: string;
  taxYear: number;
  status: PreparationCase["status"];
  version: number;
  filingStatus: PreparationCase["filingStatus"];
  currency: CurrencyCode;

  taxpayer: {
    name: string | null;
    /** Presence only — never the identifier. */
    taxIdentifierOnFile: boolean;
    taxIdentifierType: string | null;
    primaryStateRegion: string | null;
    additionalStateRegions: readonly string[];
  };

  dependents: readonly { name: string; relationship: string; status: PreparationDependent["status"] }[];

  income: readonly IncomeLine[];
  deductions: readonly IncomeLine[];
  payments: readonly IncomeLine[];
  /** Credits are not modelled anywhere. Stated, not omitted. */
  credits: { modelled: false; note: string };

  documents: { linkedCount: number; factsWithEvidence: number; factsWithoutEvidence: number };

  calculation: PreparationCalculation | null;
  /** Present when calculation was refused. */
  blockedReason: string | null;

  issues: readonly PreparationIssue[];
  blockers: readonly PreparationIssue[];
  warnings: readonly PreparationIssue[];
  notModelled: readonly string[];

  progress: readonly PreparationProgressSection[];

  evidenceCount: number;
  lastCalculatedAt: string | null;
  disclaimer: string;
}

export interface BuildPackageInput {
  preparationCase: PreparationCase;
  facts: readonly TaxFact[];
  dependents: readonly PreparationDependent[];
  completeness: CompletenessResult;
  snapshot: TaxInputSnapshot | null;
  calculation: PreparationCalculation | null;
  blockedReason: string | null;
  currency: CurrencyCode;
}

const DISCLAIMER =
  "Countorra helps organize and prepare your tax information. Tax calculations use the supported tax rules and the information you provide, and are shown before any credits, which are not modelled. Some situations require review by a qualified tax professional. Countorra does not file tax returns and cannot submit anything to the IRS or a state tax authority.";

export function buildPreparationPackage(input: BuildPackageInput): PreparationPackage {
  const { preparationCase, facts, dependents, completeness, calculation, currency } = input;
  const confirmed = facts.filter((fact) => fact.state === "CONFIRMED");

  const lines = groupIntoLines(confirmed);
  const income = lines.filter((line) => isIncome(line.key));
  const deductions = lines.filter((line) => isDeduction(line.key));
  const payments = lines.filter((line) => isPayment(line.key));

  const withEvidence = confirmed.filter((fact) => fact.evidenceDocumentId).length;

  return {
    caseId: preparationCase.id,
    organizationId: preparationCase.organizationId,
    taxYear: preparationCase.taxYear,
    status: preparationCase.status,
    version: preparationCase.currentVersion,
    filingStatus: preparationCase.filingStatus,
    currency,

    taxpayer: {
      name: fullName(preparationCase),
      taxIdentifierOnFile: preparationCase.taxpayer.taxIdentifierOnFile,
      taxIdentifierType: preparationCase.taxpayer.taxIdentifierType,
      primaryStateRegion: preparationCase.taxpayer.primaryStateRegion,
      additionalStateRegions: preparationCase.taxpayer.additionalStateRegions,
    },

    dependents: dependents.map((dependent) => ({
      name: `${dependent.firstName} ${dependent.lastName}`.trim(),
      relationship: dependent.relationship,
      status: dependent.status,
    })),

    income,
    deductions,
    payments,
    credits: {
      modelled: false,
      note: "No tax credits are modelled. Every figure here is tax before credits, and credits could change it materially.",
    },

    documents: {
      linkedCount: new Set(confirmed.map((fact) => fact.evidenceDocumentId).filter(Boolean)).size,
      factsWithEvidence: withEvidence,
      factsWithoutEvidence: confirmed.length - withEvidence,
    },

    calculation,
    blockedReason: input.blockedReason,

    issues: completeness.issues,
    blockers: completeness.blockers,
    warnings: completeness.issues.filter((issue) => issue.severity === "WARNING"),
    notModelled: calculation?.notModelled ?? [],

    progress: buildProgress(input, lines),

    evidenceCount: withEvidence,
    lastCalculatedAt: calculation?.calculatedAt ?? null,
    disclaimer: DISCLAIMER,
  };
}

/**
 * Progress from actual state, never a percentage.
 *
 * "87% complete" is a number nobody can check and nobody can act on. A
 * section that says "2 suggestions awaiting review" tells someone what to do
 * next, which is the only thing progress is for.
 */
function buildProgress(input: BuildPackageInput, lines: readonly IncomeLine[]): readonly PreparationProgressSection[] {
  const { preparationCase, facts, dependents, completeness, calculation } = input;
  const issuesIn = (category: PreparationIssue["category"]) => completeness.issues.filter((issue) => issue.category === category);
  const worst = (category: PreparationIssue["category"]): PreparationProgressSection["state"] => {
    const issues = issuesIn(category);
    if (issues.some((issue) => issue.blocking)) return "BLOCKED";
    if (issues.some((issue) => issue.severity === "ERROR")) return "MISSING_INFORMATION";
    if (issues.some((issue) => issue.severity === "WARNING")) return "REVIEW_REQUIRED";
    return "COMPLETE";
  };

  const proposed = facts.filter((fact) => fact.state === "PROPOSED").length;
  const confirmed = facts.filter((fact) => fact.state === "CONFIRMED").length;
  const states = [preparationCase.taxpayer.primaryStateRegion, ...preparationCase.taxpayer.additionalStateRegions].filter(Boolean);

  return [
    { key: "TAXPAYER", label: "Taxpayer", state: worst("TAXPAYER"), detail: fullName(preparationCase) ?? "Not entered" },
    {
      key: "FILING_STATUS",
      label: "Filing status",
      state: preparationCase.filingStatus ? worst("FILING_STATUS") : "NOT_STARTED",
      detail: preparationCase.filingStatus ? readableFilingStatus(preparationCase.filingStatus) : "Not chosen",
    },
    {
      key: "DEPENDENTS",
      label: "Dependents",
      state: dependents.length === 0 ? "NOT_STARTED" : worst("DEPENDENTS"),
      detail: dependents.length === 0 ? "None added" : `${dependents.length} added, ${dependents.filter((d) => d.status === "VERIFIED").length} complete`,
    },
    {
      key: "INCOME",
      label: "Income",
      state: confirmed === 0 ? "NOT_STARTED" : worst("INCOME"),
      detail: proposed > 0 ? `${confirmed} confirmed, ${proposed} awaiting review` : `${confirmed} confirmed`,
    },
    {
      key: "DOCUMENTS",
      label: "Documents",
      state: worst("DOCUMENTS"),
      detail: `${input.facts.filter((f) => f.evidenceDocumentId).length} of ${input.facts.length} entries have a document attached`,
    },
    {
      key: "DEDUCTIONS",
      label: "Deductions",
      state: lines.some((line) => isDeduction(line.key)) ? worst("DEDUCTIONS") : "NOT_STARTED",
      detail: lines.filter((line) => isDeduction(line.key)).length === 0 ? "Standard deduction will be applied" : "Entered, not applied — itemizing is not modelled",
    },
    {
      key: "STATE",
      label: "State",
      state: states.length === 0 ? "NOT_STARTED" : worst("STATE"),
      detail: states.length === 0 ? "Not set" : states.join(", "),
    },
    {
      key: "CALCULATION",
      label: "Calculation",
      state: completeness.blockers.length > 0 ? "BLOCKED" : calculation ? "COMPLETE" : "NOT_STARTED",
      detail: completeness.blockers.length > 0 ? `Blocked by ${completeness.blockers.length}` : calculation ? `Version ${calculation.version}` : "Not run",
    },
  ];
}

// ── helpers ───────────────────────────────────────────────────────────

function groupIntoLines(confirmed: readonly TaxFact[]): readonly IncomeLine[] {
  const byKey = new Map<TaxFactKey, TaxFact[]>();
  for (const fact of confirmed) byKey.set(fact.key, [...(byKey.get(fact.key) ?? []), fact]);

  return [...byKey.entries()]
    .map(([key, group]) => {
      const definition = factDefinition(key);
      return {
        key,
        label: definition.label,
        amountMinor: group.reduce((sum, fact) => sum + (fact.amountMinor ?? 0), 0),
        entryCount: group.length,
        calculated: definition.support === "CALCULATED",
        evidencedCount: group.filter((fact) => fact.evidenceDocumentId).length,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

const DEDUCTION_KEYS = new Set<TaxFactKey>(["ITEMIZED_DEDUCTIONS_TOTAL", "MORTGAGE_INTEREST", "CHARITABLE_CONTRIBUTIONS", "STATE_ADDITIONS", "STATE_SUBTRACTIONS"]);
const PAYMENT_KEYS = new Set<TaxFactKey>(["W2_FEDERAL_WITHHOLDING", "W2_STATE_WITHHOLDING", "FEDERAL_ESTIMATED_PAYMENTS", "STATE_ESTIMATED_PAYMENTS"]);

const isDeduction = (key: TaxFactKey) => DEDUCTION_KEYS.has(key);
const isPayment = (key: TaxFactKey) => PAYMENT_KEYS.has(key);
const isIncome = (key: TaxFactKey) => !isDeduction(key) && !isPayment(key);

function fullName(preparationCase: PreparationCase): string | null {
  const { legalFirstName, legalLastName } = preparationCase.taxpayer;
  if (!legalFirstName && !legalLastName) return null;
  return [legalFirstName, legalLastName].filter(Boolean).join(" ");
}

export function readableFilingStatus(status: NonNullable<PreparationCase["filingStatus"]>): string {
  return {
    single: "Single",
    married_filing_jointly: "Married filing jointly",
    married_filing_separately: "Married filing separately",
    head_of_household: "Head of household",
    qualifying_surviving_spouse: "Qualifying surviving spouse",
  }[status];
}
