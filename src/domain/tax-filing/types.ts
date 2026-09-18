import type { CurrencyCode } from "@/domain/money/currency";
import type { CalculationStatus } from "@/domain/tax/rules/resolve-rule-set";
import type { FilingStatus, TaxJurisdiction } from "@/domain/tax/rules/types";
import type { CalculationMethod } from "@/domain/tax/tax-engine";
import type { ResultStatus } from "@/domain/tax-preparation/types";

/**
 * TAX FILING FOUNDATION — "can Countorra prove this return is ready to file?"
 *
 * THE LAYERS, AND WHERE THIS ONE STOPS
 *
 *   Preparation   collects confirmed facts and freezes them       (tax-preparation)
 *   Calculation   deterministic engines run on the frozen inputs  (tax)
 *   Filing        readiness, an immutable filing snapshot, a      (THIS)
 *                 deterministic package, and explicit finalization
 *   E-filing      submission to the IRS or a state               NOT IMPLEMENTED
 *
 * Nothing in this layer submits, transmits or confirms anything. There is no
 * provider, no submission id and no acceptance, and the types below make the
 * provider-only states impossible to hold rather than merely unused.
 *
 * NOTHING HERE IS TAX LAW
 *
 * Readiness rules are product-support rules: "is the calculation current",
 * "did the engine answer under 2026's own published rules", "is every figure
 * one an engine actually modelled". Where a real filing requirement would
 * apply — a taxpayer identification number, a signature, a form line — it is
 * registered in `requirements.ts` as NOT VERIFIED and not enforced, because
 * no official 2026 publication establishing it has been verified.
 */

/** The only tax year this layer serves. A new year is a deliberate change. */
export const FILING_TAX_YEAR = 2026;

/** Stamped on every readiness result and package, so a stored record names
 *  the rules that judged it. Bump when a readiness rule changes. */
// 2026.2: REVIEW severity — an undetermined filing-status question (head of
// household or qualifying surviving spouse qualification, or whether a
// separately filing spouse itemizes) leaves nothing finalizable. The package
// records the spouse-itemizes answer.
export const READINESS_ENGINE_VERSION = "filing-readiness.2026.2";
export const PACKAGE_BUILDER_VERSION = "filing-package.2026.2";

// ── Filing case status ──────────────────────────────────────────────────

/**
 * What Countorra can honestly say about a prepared return today.
 *
 * Mirrors the CHECK constraint in 0044 exactly. There is no SUBMITTED,
 * ACCEPTED or REJECTED here, and none in the database either.
 */
export type FilingCaseStatus =
  /** Created; readiness not yet evaluated. */
  | "DRAFT"
  /** Federal is ready, but at least one state cannot be filed from here —
   *  an estimate, unpublished rules, an unsupported state, or allocation. */
  | "REVIEW_REQUIRED"
  /** Something prevents finalization of anything. */
  | "BLOCKED"
  /** Every component is ready or has no individual income-tax return. */
  | "READY_FOR_FILING"
  /** A person explicitly finalized the current filing snapshot. NOT filed. */
  | "FINALIZED";

/**
 * States that only a real e-file provider integration could ever report.
 *
 * Listed so the boundary is visible in code, and deliberately NOT members of
 * `FilingCaseStatus`: no function can return one, no row can hold one (the
 * database CHECK excludes them), and no screen can render one. When a provider
 * exists, adding them is a migration and a reviewed change — not a string
 * someone can set today to make the UI look complete.
 */
export const PROVIDER_ONLY_STATUSES = ["SUBMISSION_PENDING", "SUBMITTED", "ACCEPTED", "REJECTED"] as const;
export type ProviderOnlyStatus = (typeof PROVIDER_ONLY_STATUSES)[number];

/**
 * Permitted moves. Mirrored by the trigger in 0044, which is what enforces it.
 *
 * FINALIZED may move back only because its inputs changed: the finalization
 * record and its snapshot stay exactly as they were, and the case moves on to
 * a new version.
 */
export const ALLOWED_FILING_TRANSITIONS: Readonly<Record<FilingCaseStatus, readonly FilingCaseStatus[]>> = {
  DRAFT: ["REVIEW_REQUIRED", "BLOCKED", "READY_FOR_FILING"],
  REVIEW_REQUIRED: ["BLOCKED", "READY_FOR_FILING", "FINALIZED"],
  BLOCKED: ["REVIEW_REQUIRED", "READY_FOR_FILING"],
  READY_FOR_FILING: ["REVIEW_REQUIRED", "BLOCKED", "FINALIZED"],
  FINALIZED: ["REVIEW_REQUIRED", "BLOCKED", "READY_FOR_FILING"],
};

export function canTransitionFiling(from: FilingCaseStatus, to: FilingCaseStatus): boolean {
  return from === to || ALLOWED_FILING_TRANSITIONS[from].includes(to);
}

export interface FilingCase {
  id: string;
  organizationId: string;
  preparationCaseId: string;
  taxYear: number;
  status: FilingCaseStatus;
  /** The latest filing snapshot version; 0 before the first snapshot. */
  currentVersion: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── Readiness ───────────────────────────────────────────────────────────

export type ReadinessStatus =
  /** Federal and every state component can be finalized together. */
  | "READY"
  /** Needs attention short of a blocker. Either federal can be finalized on
   *  its own because only a state cannot (`finalizableScope` FEDERAL_ONLY), or
   *  a question only a qualified person can answer is open and nothing can be
   *  finalized (`finalizableScope` null). */
  | "REVIEW_REQUIRED"
  /** Nothing can be finalized until the blockers are resolved. */
  | "BLOCKED"
  /** Outside what this layer serves at all — another tax year or country. */
  | "NOT_SUPPORTED";

/** What a finalization covers. FEDERAL_ONLY exists so a state whose rules are
 *  unpublished does not hold the federal return hostage — and it requires
 *  each excluded state to be acknowledged by name. */
export type FilingScope = "FULL" | "FEDERAL_ONLY";

export type FilingIssueSeverity =
  /** Prevents finalization of the scope it belongs to. */
  | "BLOCKER"
  /** A question Countorra does not decide — filing-status qualification, or a
   *  fact about the spouse that decides the deduction. Nothing can be
   *  finalized while one is open, and nothing here resolves it by assumption. */
  | "REVIEW"
  /** A disclosed limitation. Shown in full at confirmation and acknowledged. */
  | "WARNING"
  | "INFO";

/** FILING and FEDERAL blockers stop everything; STATE blockers stop only the
 *  state component, leaving FEDERAL_ONLY available. */
export type FilingIssueScope = "FILING" | "FEDERAL" | "STATE";

/**
 * Why an issue exists — so "not ready" is never unexplained, and so nobody
 * mistakes a product rule for a legal one.
 */
export type FilingIssueProvenance =
  /** A rule about what Countorra supports or can prove. Not tax law. */
  | { kind: "COUNTORRA_PRODUCT_RULE"; rule: string }
  /** Raised by the preparation completeness engine, relayed. */
  | { kind: "PREPARATION_COMPLETENESS"; preparationIssueId: string }
  /** The engine's own answer, from the stored calculation. */
  | { kind: "TAX_ENGINE"; jurisdiction: TaxJurisdiction; ruleSetVersion: string | null }
  /** A filing requirement that exists in the register but is NOT verified,
   *  and therefore informs rather than decides. */
  | { kind: "FILING_REQUIREMENT_NOT_VERIFIED"; requirementId: string };

export interface FilingIssue {
  /** Stable, machine-readable. Tests, the UI and audit metadata key on it. */
  code: string;
  severity: FilingIssueSeverity;
  scope: FilingIssueScope;
  jurisdiction: TaxJurisdiction | null;
  /** Safe to show a person. */
  message: string;
  /** What the person can actually do about it. */
  resolution: string;
  /** The fact key, field, snapshot or case it concerns, where there is one. */
  related: { affects?: string; preparationCaseId?: string; preparationSnapshotId?: string } | null;
  provenance: FilingIssueProvenance;
}

export type ComponentReadiness =
  | "READY"
  | "NOT_READY"
  /** The jurisdiction levies no individual income tax, so there is no
   *  individual income-tax return — not "a return filed at $0". */
  | "NOT_APPLICABLE"
  /** Countorra has no rules for it. */
  | "NOT_SUPPORTED";

export interface JurisdictionReadiness {
  /** Null for a state Countorra does not model at all, or none set. */
  jurisdiction: TaxJurisdiction | null;
  /** USPS code for a state component; null for federal. */
  stateCode: string | null;
  label: string;
  readiness: ComponentReadiness;
  /** The stored calculation's classification, verbatim. */
  resultStatus: ResultStatus | null;
  ruleSet: { taxYear: number; requestedTaxYear: number; version: string; calculationStatus: CalculationStatus } | null;
  issueCodes: readonly string[];
}

export type RefundOutcome = "REFUND" | "BALANCE_DUE" | "NOT_DETERMINABLE";

export interface FilingReadiness {
  engineVersion: typeof READINESS_ENGINE_VERSION;
  taxYear: number;
  status: ReadinessStatus;
  /** The scope a finalization may take right now, if any. */
  finalizableScope: FilingScope | null;
  federal: JurisdictionReadiness;
  states: readonly JurisdictionReadiness[];
  /** Sorted deterministically: severity, scope, code, affected item. */
  issues: readonly FilingIssue[];
  refund: { status: RefundOutcome; amountMinor: number | null; explanation: string };
  preparation: {
    caseId: string;
    caseVersion: number;
    /** The database id of the latest preparation snapshot, if any. */
    snapshotId: string | null;
    snapshotVersion: number | null;
    calculationCurrent: boolean;
  };
  /** Requirements the register holds, none of them enforced. */
  unverifiedRequirementIds: readonly string[];
}

// ── Package ─────────────────────────────────────────────────────────────

export interface PackageLine {
  key: string;
  label: string;
  amountMinor: number;
  entryCount: number;
  /** Whether a deterministic engine consumed it. */
  includedInCalculation: boolean;
  evidenceDocumentIds: readonly string[];
}

export interface PackageTotals {
  grossIncomeMinor: number;
  adjustedGrossIncomeMinor: number;
  standardDeductionMinor: number;
  taxableIncomeMinor: number;
  incomeTaxMinor: number;
  selfEmploymentTaxMinor: number;
  selfEmploymentTaxDeductionMinor: number;
  surtaxMinor: number;
  totalTaxMinor: number;
}

export interface PackageJurisdiction {
  jurisdiction: TaxJurisdiction | null;
  stateCode: string | null;
  name: string;
  /** INCLUDED in this finalization, EXCLUDED from it, or a state with no
   *  individual income-tax return — which is never presented as a return. */
  role: "INCLUDED" | "EXCLUDED" | "NO_INDIVIDUAL_INCOME_TAX_RETURN";
  exclusionReason: string | null;
  readiness: ComponentReadiness;
  resultStatus: ResultStatus | null;
  calculationMethod: CalculationMethod | null;
  ruleSet: { taxYear: number; requestedTaxYear: number; version: string; calculationStatus: CalculationStatus; effectiveFrom: string } | null;
  /** Present only when another year's published rules were used. */
  fallbackNotice: string | null;
  /** Null when no figure was produced — never zero. */
  totals: PackageTotals | null;
  message: string;
}

export interface PackageSource {
  jurisdiction: TaxJurisdiction;
  ruleSetVersion: string;
  authority: string;
  citation: string;
  url: string;
  verification: string;
  retrievedOn: string | null;
}

export interface FilingPackage {
  format: { id: "countorra.filing-package"; name: "Countorra Filing Package"; version: 1 };
  /** Asserted in the data and again by a CHECK constraint on the stored row. */
  filed: false;
  submitted: false;
  governmentForm: false;
  electronicFilingAvailable: false;
  disclaimer: string;

  metadata: {
    taxYear: number;
    organizationId: string;
    currency: CurrencyCode;
    filingCaseId: string;
    filingVersion: number;
    preparationCaseId: string;
    preparationSnapshotId: string;
    preparationVersion: number;
    scope: FilingScope;
    generatedAt: string;
    readinessEngineVersion: string;
    packageBuilderVersion: string;
  };

  taxpayer: {
    legalName: string | null;
    taxIdentifierType: string | null;
    /** Presence only. There is no field that could hold the number. */
    taxIdentifierOnFile: boolean;
    spouseName: string | null;
    spouseTaxIdentifierOnFile: boolean;
    /** Married filing separately only; null when not answered. */
    spouseItemizesDeductions: boolean | null;
    primaryStateRegion: string | null;
    additionalStateRegions: readonly string[];
    dependents: readonly { name: string; relationship: string; informationStatus: string }[];
  };

  filingStatus: { code: FilingStatus; label: string };
  income: readonly PackageLine[];
  adjustments: readonly PackageLine[];
  deductions: { standardDeductionAppliedMinor: number | null; collectedNotApplied: readonly PackageLine[] };
  federal: PackageJurisdiction;
  payments: {
    federalWithholdingMinor: number | null;
    federalEstimatedPaymentsMinor: number | null;
    stateWithholdingMinor: number | null;
    stateEstimatedPaymentsMinor: number | null;
  };
  refund: { federal: FilingReadiness["refund"]; state: { status: "NOT_DETERMINABLE"; explanation: string } };
  states: readonly PackageJurisdiction[];
  credits: { modelled: false; note: string };
  evidence: { documentIds: readonly string[]; factsWithEvidence: number; factsWithoutEvidence: number };
  limitations: readonly string[];
  readiness: {
    status: ReadinessStatus;
    finalizableScope: FilingScope | null;
    issues: readonly { code: string; severity: FilingIssueSeverity; scope: FilingIssueScope; jurisdiction: TaxJurisdiction | null; message: string }[];
  };
  formMapping: { status: "PENDING"; note: string };
  sources: readonly PackageSource[];
}

/** The case status a readiness result corresponds to. */
export function filingCaseStatusFor(status: ReadinessStatus): Exclude<FilingCaseStatus, "DRAFT" | "FINALIZED"> {
  if (status === "READY") return "READY_FOR_FILING";
  if (status === "REVIEW_REQUIRED") return "REVIEW_REQUIRED";
  return "BLOCKED";
}
