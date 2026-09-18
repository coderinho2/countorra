import type { CurrencyCode } from "@/domain/money/currency";
import { jurisdictionName, type JurisdictionResult } from "@/domain/tax-preparation/calculation";
import { factDefinition, isKnownFactKey } from "@/domain/tax-preparation/facts";
import { readableFilingStatus } from "@/domain/tax-preparation/preparation-package";
import { federalPaymentsMinor } from "@/domain/tax-preparation/snapshot";
import type { SnapshotFact, TaxInputSnapshot } from "@/domain/tax-preparation/types";
import type { SupportedTaxCalculation } from "@/domain/tax/tax-engine";
import type { FrozenPreparation } from "./inputs";
import {
  FILING_TAX_YEAR,
  PACKAGE_BUILDER_VERSION,
  type FilingPackage,
  type FilingReadiness,
  type FilingScope,
  type JurisdictionReadiness,
  type PackageJurisdiction,
  type PackageLine,
  type PackageSource,
  type PackageTotals,
} from "./types";

/**
 * THE COUNTORRA FILING PACKAGE.
 *
 * A structured, deterministic record of a prepared return — not a tax form,
 * not an e-file payload, and not evidence that anything was filed. The name
 * says so, three boolean fields say so, and the database refuses to store a
 * package that says otherwise.
 *
 * BUILT ONLY FROM FROZEN DATA
 *
 * Every value comes from the immutable preparation snapshot, the calculation
 * stored with it, and the readiness result stored with the filing snapshot.
 * Nothing live is read, nothing is recalculated, and the clock is an input
 * (`generatedAt`). So the same inputs always produce the same package, and a
 * stored package can be rebuilt and compared byte for byte.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 *   form line numbers    2026 mappings are unverified — `formMapping` says PENDING
 *   identifiers          there is no field that could hold an SSN or ITIN
 *   dates of birth       not needed to describe the prepared figures
 *   evidence notes       free text copied from documents stays out of exports
 *   submission fields    no confirmation number, no submission id, no acceptance
 */

export interface BuildFilingPackageInput {
  organizationId: string;
  currency: CurrencyCode;
  filingCaseId: string;
  filingVersion: number;
  preparationCaseId: string;
  /** Must carry its stored calculation. */
  preparation: FrozenPreparation;
  readiness: FilingReadiness;
  scope: FilingScope;
  generatedAt: string;
}

export const FILING_PACKAGE_DISCLAIMER =
  "Countorra Filing Package — a preparation record, not an IRS or state tax form. Countorra has not filed or submitted this return, and electronic filing is not available in Countorra. Figures are tax before credits, which are not modelled, and use only the supported tax rules and the information provided.";

const DEDUCTION_KEYS = new Set(["ITEMIZED_DEDUCTIONS_TOTAL", "MORTGAGE_INTEREST", "CHARITABLE_CONTRIBUTIONS"]);
const ADJUSTMENT_KEYS = new Set(["STATE_ADDITIONS", "STATE_SUBTRACTIONS"]);
const PAYMENT_KEYS = new Set(["W2_FEDERAL_WITHHOLDING", "W2_STATE_WITHHOLDING", "FEDERAL_ESTIMATED_PAYMENTS", "STATE_ESTIMATED_PAYMENTS"]);

export function buildFilingPackage(input: BuildFilingPackageInput): FilingPackage {
  const { preparation, readiness, scope } = input;
  const snapshot = preparation.snapshot;
  const calculation = preparation.calculation;
  if (!calculation) throw new RangeError("A filing package needs the calculation stored with its preparation snapshot.");

  const lines = groupLines(snapshot.facts);
  const federalOutcome = calculation.federal.outcome?.supported ? calculation.federal.outcome : null;

  return {
    format: { id: "countorra.filing-package", name: "Countorra Filing Package", version: 1 },
    filed: false,
    submitted: false,
    governmentForm: false,
    electronicFilingAvailable: false,
    disclaimer: FILING_PACKAGE_DISCLAIMER,

    metadata: {
      taxYear: FILING_TAX_YEAR,
      organizationId: input.organizationId,
      currency: input.currency,
      filingCaseId: input.filingCaseId,
      filingVersion: input.filingVersion,
      preparationCaseId: input.preparationCaseId,
      preparationSnapshotId: preparation.id,
      preparationVersion: preparation.version,
      scope,
      generatedAt: input.generatedAt,
      readinessEngineVersion: readiness.engineVersion,
      packageBuilderVersion: PACKAGE_BUILDER_VERSION,
    },

    taxpayer: {
      legalName: joinName(snapshot.taxpayer.legalFirstName, snapshot.taxpayer.legalMiddleName, snapshot.taxpayer.legalLastName),
      taxIdentifierType: snapshot.taxpayer.taxIdentifierType,
      taxIdentifierOnFile: snapshot.taxpayer.taxIdentifierOnFile,
      spouseName: joinName(snapshot.taxpayer.spouseFirstName, null, snapshot.taxpayer.spouseLastName),
      spouseTaxIdentifierOnFile: snapshot.taxpayer.spouseTaxIdentifierOnFile,
      // Absent from a snapshot frozen before the question existed: not answered.
      spouseItemizesDeductions: snapshot.taxpayer.spouseItemizesDeductions ?? null,
      primaryStateRegion: snapshot.taxpayer.primaryStateRegion,
      additionalStateRegions: [...snapshot.taxpayer.additionalStateRegions].sort(),
      dependents: snapshot.dependents
        .map((dependent) => ({ name: `${dependent.firstName} ${dependent.lastName}`.trim(), relationship: dependent.relationship, informationStatus: dependent.status }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.relationship.localeCompare(b.relationship)),
    },

    filingStatus: { code: snapshot.filingStatus, label: readableFilingStatus(snapshot.filingStatus) },
    income: lines.filter((line) => !DEDUCTION_KEYS.has(line.key) && !ADJUSTMENT_KEYS.has(line.key) && !PAYMENT_KEYS.has(line.key)),
    adjustments: lines.filter((line) => ADJUSTMENT_KEYS.has(line.key)),
    deductions: {
      standardDeductionAppliedMinor: federalOutcome ? federalOutcome.totals.standardDeduction.amountMinor : null,
      collectedNotApplied: lines.filter((line) => DEDUCTION_KEYS.has(line.key)),
    },

    federal: jurisdictionSection(calculation.federal, readiness.federal, "INCLUDED", null),

    payments: {
      federalWithholdingMinor: totalOrNull(snapshot, "W2_FEDERAL_WITHHOLDING"),
      federalEstimatedPaymentsMinor: totalOrNull(snapshot, "FEDERAL_ESTIMATED_PAYMENTS"),
      stateWithholdingMinor: totalOrNull(snapshot, "W2_STATE_WITHHOLDING"),
      stateEstimatedPaymentsMinor: totalOrNull(snapshot, "STATE_ESTIMATED_PAYMENTS"),
    },

    refund: {
      federal: federalPaymentsMinor(snapshot) === null ? { ...readiness.refund, status: "NOT_DETERMINABLE", amountMinor: null } : readiness.refund,
      state: { status: "NOT_DETERMINABLE", explanation: "No state refund or balance due is calculated. State payments are listed, not netted against a state figure." },
    },

    states: readiness.states.map((component) => {
      const result = component.jurisdiction ? (calculation.states.find((state) => state.jurisdiction === component.jurisdiction) ?? null) : null;
      if (component.readiness === "NOT_APPLICABLE") return jurisdictionSection(result, component, "NO_INDIVIDUAL_INCOME_TAX_RETURN", null);
      if (component.readiness === "READY" && scope === "FULL") return jurisdictionSection(result, component, "INCLUDED", null);
      return jurisdictionSection(result, component, "EXCLUDED", exclusionReason(component, readiness));
    }),

    credits: { modelled: false, note: "No tax credits are modelled. Every figure is tax before credits, and credits could change it materially." },

    evidence: {
      documentIds: [...new Set(snapshot.facts.map((fact) => fact.evidenceDocumentId).filter((id): id is string => Boolean(id)))].sort(),
      factsWithEvidence: snapshot.facts.filter((fact) => fact.evidenceDocumentId).length,
      factsWithoutEvidence: snapshot.facts.filter((fact) => !fact.evidenceDocumentId).length,
    },

    limitations: [
      "This package is a preparation record. It is not a tax return, not an official form, and has not been filed or submitted.",
      "Electronic filing is not available in Countorra.",
      "No tax credits are modelled; every figure is before credits.",
      ...calculation.notModelled,
    ],

    readiness: {
      status: readiness.status,
      finalizableScope: readiness.finalizableScope,
      issues: readiness.issues.map(({ code, severity, scope: issueScope, jurisdiction, message }) => ({ code, severity, scope: issueScope, jurisdiction, message })),
    },

    formMapping: {
      status: "PENDING",
      note: `No ${FILING_TAX_YEAR} form line numbers are produced. Official ${FILING_TAX_YEAR} form mappings have not been verified, and no earlier year's form is used in their place.`,
    },

    sources: collectSources([calculation.federal, ...calculation.states]),
  };
}

// ── helpers ───────────────────────────────────────────────────────────

function groupLines(facts: readonly SnapshotFact[]): PackageLine[] {
  const byKey = new Map<string, SnapshotFact[]>();
  for (const fact of facts) byKey.set(fact.key, [...(byKey.get(fact.key) ?? []), fact]);

  return [...byKey.entries()]
    .map(([key, group]) => {
      const definition = isKnownFactKey(key) ? factDefinition(key) : null;
      return {
        key,
        label: definition?.label ?? key,
        amountMinor: group.reduce((sum, fact) => sum + (fact.amountMinor ?? 0), 0),
        entryCount: group.length,
        includedInCalculation: definition?.support === "CALCULATED",
        evidenceDocumentIds: [...new Set(group.map((fact) => fact.evidenceDocumentId).filter((id): id is string => Boolean(id)))].sort(),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function totalOrNull(snapshot: TaxInputSnapshot, key: string): number | null {
  const matching = snapshot.facts.filter((fact) => fact.key === key);
  if (matching.length === 0) return null;
  return matching.reduce((sum, fact) => sum + (fact.amountMinor ?? 0), 0);
}

function joinName(first: string | null, middle: string | null, last: string | null): string | null {
  const parts = [first, middle, last].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join(" ") : null;
}

function totalsOf(outcome: SupportedTaxCalculation): PackageTotals {
  const { totals } = outcome;
  return {
    grossIncomeMinor: totals.grossIncome.amountMinor,
    adjustedGrossIncomeMinor: totals.adjustedGrossIncome.amountMinor,
    standardDeductionMinor: totals.standardDeduction.amountMinor,
    taxableIncomeMinor: totals.taxableIncome.amountMinor,
    incomeTaxMinor: totals.incomeTax.amountMinor,
    selfEmploymentTaxMinor: totals.selfEmploymentTax.amountMinor,
    selfEmploymentTaxDeductionMinor: totals.selfEmploymentTaxDeduction.amountMinor,
    surtaxMinor: totals.surtax.amountMinor,
    totalTaxMinor: totals.totalTax.amountMinor,
  };
}

function jurisdictionSection(
  result: JurisdictionResult | null,
  component: JurisdictionReadiness,
  role: PackageJurisdiction["role"],
  exclusionReasonText: string | null,
): PackageJurisdiction {
  const outcome = result?.outcome?.supported ? result.outcome : null;
  return {
    jurisdiction: component.jurisdiction,
    stateCode: component.stateCode,
    name: component.jurisdiction ? jurisdictionName(component.jurisdiction) : component.label,
    role,
    exclusionReason: exclusionReasonText,
    readiness: component.readiness,
    resultStatus: result?.status ?? null,
    calculationMethod: outcome?.calculationMethod ?? null,
    ruleSet: outcome
      ? {
          taxYear: outcome.taxYear,
          requestedTaxYear: outcome.requestedTaxYear,
          version: outcome.ruleSetVersion,
          calculationStatus: outcome.calculationStatus,
          effectiveFrom: outcome.ruleSet.effectiveFrom,
        }
      : null,
    fallbackNotice: outcome?.fallback?.notice ?? null,
    totals: outcome ? totalsOf(outcome) : null,
    message: result?.message ?? "No result was produced for this jurisdiction.",
  };
}

function exclusionReason(component: JurisdictionReadiness, readiness: FilingReadiness): string {
  const blocker = readiness.issues.find((issue) => issue.severity === "BLOCKER" && issue.scope === "STATE" && component.issueCodes.includes(issue.code));
  return blocker?.message ?? `${component.label} is not ready for filing and is excluded from this finalization.`;
}

function collectSources(results: readonly JurisdictionResult[]): PackageSource[] {
  const out: PackageSource[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    const outcome = result.outcome?.supported ? result.outcome : null;
    if (!outcome) continue;
    for (const source of outcome.ruleSet.sources) {
      const key = `${outcome.jurisdiction}|${source.url}|${source.citation}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        jurisdiction: outcome.jurisdiction,
        ruleSetVersion: outcome.ruleSetVersion,
        authority: source.authority,
        citation: source.citation,
        url: source.url,
        verification: source.verification,
        retrievedOn: source.retrievedOn ?? null,
      });
    }
  }
  return out;
}
