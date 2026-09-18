import { runPreparationCalculation, type PreparationCalculation } from "@/domain/tax-preparation/calculation";
import { assessCompleteness } from "@/domain/tax-preparation/completeness";
import { buildSnapshot } from "@/domain/tax-preparation/snapshot";
import type { PreparationCase, PreparationDependent, TaxFact, TaxFactKey, TaxpayerProfile } from "@/domain/tax-preparation/types";
import type { FilingStatus } from "@/domain/tax/rules/types";
import type { FilingReadinessInput } from "./readiness";

/**
 * Realistic synthetic 2026 preparation cases for the filing tests.
 *
 * Built with the REAL preparation machinery — completeness, the snapshot
 * builder and the deterministic engines — so readiness is tested against the
 * same stored shapes production produces, not hand-written approximations.
 * Every value is synthetic.
 */

export const ORG = "11111111-1111-4111-8111-111111111111";
export const CASE_ID = "22222222-2222-4222-8222-222222222222";
export const USER = "33333333-3333-4333-8333-333333333333";
export const PREP_SNAPSHOT_DB_ID = "44444444-4444-4444-8444-444444444444";
export const FROZEN_AT = "2026-09-13T10:00:00.000Z";

let nextId = 1;

export function fact(key: TaxFactKey, amountMinor: number, overrides: Partial<TaxFact> = {}): TaxFact {
  nextId += 1;
  return {
    id: `fact-${nextId}`,
    organizationId: ORG,
    caseId: CASE_ID,
    version: 1,
    key,
    amountMinor,
    currency: "USD",
    textValue: null,
    source: "USER_ENTERED",
    state: "CONFIRMED",
    evidenceDocumentId: null,
    evidenceNote: null,
    createdAt: FROZEN_AT,
    createdBy: USER,
    ...overrides,
  };
}

/** A W-2 employee with withholding: the ordinary, fully supported case. */
export function w2Facts(): TaxFact[] {
  return [
    fact("W2_WAGES", 8_500_000),
    fact("W2_SOCIAL_SECURITY_WAGES", 8_500_000),
    fact("W2_MEDICARE_WAGES", 8_500_000),
    fact("W2_FEDERAL_WITHHOLDING", 1_100_000),
  ];
}

export function dependent(overrides: Partial<PreparationDependent> = {}): PreparationDependent {
  return {
    id: "dep-1",
    organizationId: ORG,
    caseId: CASE_ID,
    firstName: "Sam",
    lastName: "Synthetic",
    relationship: "child",
    dateOfBirth: "2016-05-01",
    monthsLivedWithTaxpayer: 12,
    isStudent: false,
    isDisabled: false,
    hasTaxIdentifier: true,
    claimedByAnother: false,
    status: "VERIFIED",
    createdAt: FROZEN_AT,
    ...overrides,
  };
}

export interface ScenarioOptions {
  state?: string | null;
  additionalStates?: string[];
  facts?: TaxFact[];
  filingStatus?: FilingStatus | null;
  dependents?: PreparationDependent[];
  taxYear?: number;
  filingTaxYear?: number;
  country?: string;
  identifierOnFile?: boolean;
  calculationIsCurrent?: boolean;
  /** Facts changed AFTER the calculation, without the status noticing. */
  liveFacts?: TaxFact[];
  /** Mutates the stored calculation, as a forged REST insert would. */
  tamper?: (calculation: PreparationCalculation) => void;
  status?: PreparationCase["status"];
  /** Spouse details and answers, for the married and surviving-spouse statuses. */
  taxpayer?: Partial<TaxpayerProfile>;
}

export function preparationCase(options: ScenarioOptions = {}): PreparationCase {
  const taxpayer: TaxpayerProfile = {
    legalFirstName: "Taylor",
    legalMiddleName: null,
    legalLastName: "Synthetic",
    dateOfBirth: "1988-03-14",
    taxIdentifierType: "ssn",
    taxIdentifierOnFile: options.identifierOnFile ?? true,
    primaryStateRegion: options.state === undefined ? "TX" : options.state,
    additionalStateRegions: options.additionalStates ?? [],
    spouseFirstName: null,
    spouseLastName: null,
    spouseDateOfBirth: null,
    spouseTaxIdentifierOnFile: false,
    spouseItemizesDeductions: null,
    ...options.taxpayer,
  };

  return {
    id: CASE_ID,
    organizationId: ORG,
    taxYear: options.taxYear ?? 2026,
    status: options.status ?? "CALCULATED",
    filingStatus: options.filingStatus === undefined ? "single" : options.filingStatus,
    taxpayer,
    currentVersion: 1,
    createdBy: USER,
    createdAt: FROZEN_AT,
    updatedAt: FROZEN_AT,
    completedAt: null,
  };
}

/** A full readiness input: completeness, a frozen snapshot and its stored calculation. */
export function scenario(options: ScenarioOptions = {}): FilingReadinessInput {
  const prepCase = preparationCase(options);
  const facts = options.facts ?? w2Facts();
  const dependents = options.dependents ?? [];
  const country = options.country ?? "US";

  const completenessAtCalculation = assessCompleteness({
    taxYear: prepCase.taxYear,
    filingStatus: prepCase.filingStatus,
    taxpayer: prepCase.taxpayer,
    dependents,
    facts,
    countryCode: country,
    entityType: "personal",
    declaredIncomeKinds: [],
  });

  let latest: FilingReadinessInput["latest"] = null;
  if (prepCase.filingStatus) {
    const snapshot = buildSnapshot({
      organizationId: ORG,
      caseId: CASE_ID,
      version: 1,
      taxYear: prepCase.taxYear,
      filingStatus: prepCase.filingStatus,
      taxpayer: prepCase.taxpayer,
      dependents,
      facts,
      jurisdictions: completenessAtCalculation.jurisdictions,
      createdBy: USER,
      createdAt: FROZEN_AT,
    });
    const outcome = runPreparationCalculation({ snapshot, currency: "USD", calculatedAt: FROZEN_AT, blockers: completenessAtCalculation.blockers });
    if (outcome.ran) {
      const calculation = JSON.parse(JSON.stringify(outcome.calculation)) as PreparationCalculation;
      options.tamper?.(calculation);
      latest = { id: PREP_SNAPSHOT_DB_ID, version: 1, snapshot: JSON.parse(JSON.stringify(snapshot)), calculation };
    }
  }

  const liveFacts = options.liveFacts ?? facts;
  const completeness = options.liveFacts
    ? assessCompleteness({ taxYear: prepCase.taxYear, filingStatus: prepCase.filingStatus, taxpayer: prepCase.taxpayer, dependents, facts: liveFacts, countryCode: country, entityType: "personal", declaredIncomeKinds: [] })
    : completenessAtCalculation;

  return {
    filingTaxYear: options.filingTaxYear ?? 2026,
    organization: { country, entityType: "personal" },
    preparationCase: prepCase,
    facts: liveFacts,
    dependents,
    completeness,
    latest,
    calculationIsCurrent: options.calculationIsCurrent ?? latest !== null,
    currency: "USD",
  };
}
