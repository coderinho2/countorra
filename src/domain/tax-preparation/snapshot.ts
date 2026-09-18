import type { CurrencyCode } from "@/domain/money/currency";
import type { TaxCalculationInput } from "@/domain/tax/tax-engine";
import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import { calculatedKeys, paymentKeys } from "./facts";
import type { PreparationDependent, SnapshotFact, TaxFact, TaxFactKey, TaxInputSnapshot, TaxpayerProfile } from "./types";
import type { FilingStatus } from "@/domain/tax/rules/types";

/**
 * THE IMMUTABLE TAX INPUT SNAPSHOT.
 *
 * A stored tax result that cannot be tied to the exact inputs that produced
 * it is not auditable, and inputs that change underneath an existing result
 * are worse than no record at all. So calculation runs against a frozen
 * snapshot, and a correction produces a NEW version rather than editing the
 * old one.
 *
 * ONLY CONFIRMED FACTS GET IN. A proposed value — a model's reading of a
 * document, a candidate derived from transactions — is visible to the user
 * and invisible to the engine until a person accepts it. That single rule is
 * what keeps an extraction from becoming a tax figure by default.
 */

export interface BuildSnapshotInput {
  organizationId: string;
  caseId: string;
  version: number;
  taxYear: number;
  filingStatus: FilingStatus;
  taxpayer: TaxpayerProfile;
  dependents: readonly PreparationDependent[];
  facts: readonly TaxFact[];
  jurisdictions: readonly TaxJurisdiction[];
  createdBy: string | null;
  createdAt: string;
}

export function buildSnapshot(input: BuildSnapshotInput): TaxInputSnapshot {
  const confirmed = input.facts.filter((fact) => fact.state === "CONFIRMED");

  return {
    id: `${input.caseId}:${input.version}`,
    organizationId: input.organizationId,
    caseId: input.caseId,
    version: input.version,
    taxYear: input.taxYear,
    filingStatus: input.filingStatus,
    taxpayer: input.taxpayer,
    dependents: input.dependents,
    // Sorted so the same set of facts always serializes identically —
    // a snapshot whose bytes depend on row order is not comparable to
    // itself, which defeats the point of freezing it.
    facts: confirmed.map(toSnapshotFact).sort(compareFacts),
    jurisdictions: [...input.jurisdictions],
    createdAt: input.createdAt,
    createdBy: input.createdBy,
  };
}

function toSnapshotFact(fact: TaxFact): SnapshotFact {
  return {
    key: fact.key,
    amountMinor: fact.amountMinor,
    currency: fact.currency,
    textValue: fact.textValue,
    source: fact.source,
    evidenceDocumentId: fact.evidenceDocumentId,
    evidenceNote: fact.evidenceNote,
  };
}

function compareFacts(a: SnapshotFact, b: SnapshotFact): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if ((a.amountMinor ?? 0) !== (b.amountMinor ?? 0)) return (a.amountMinor ?? 0) - (b.amountMinor ?? 0);
  return (a.evidenceDocumentId ?? "").localeCompare(b.evidenceDocumentId ?? "");
}

/** Total of every confirmed fact with this key, in minor units. */
export function totalFor(snapshot: TaxInputSnapshot, key: TaxFactKey): number {
  return snapshot.facts.filter((fact) => fact.key === key).reduce((sum, fact) => sum + (fact.amountMinor ?? 0), 0);
}

/** Whether the snapshot holds any fact with this key at all. */
export function has(snapshot: TaxInputSnapshot, key: TaxFactKey): boolean {
  return snapshot.facts.some((fact) => fact.key === key);
}

/**
 * The snapshot, expressed as the engines' own input type.
 *
 * THIS IS THE ONLY PLACE preparation facts become engine inputs, and it is
 * deliberately narrow: it reads the keys the engines actually consume and
 * ignores the rest. A fact that is merely collected cannot leak into a
 * figure through a forgotten branch here, because there is no branch for it.
 *
 * Note what is NOT done: nothing is inferred, defaulted or estimated. A
 * missing W-2 box 5 stays missing, and the federal engine applies its own
 * documented rule for that case rather than preparation inventing one.
 */
export function toEngineInput(snapshot: TaxInputSnapshot, currency: CurrencyCode): TaxCalculationInput {
  const wages = totalFor(snapshot, "W2_WAGES");
  const selfEmployment = totalFor(snapshot, "SELF_EMPLOYMENT_NET_PROFIT");

  return {
    organizationId: snapshot.organizationId,
    // Server-authoritative, straight off the frozen snapshot. Nothing a
    // client or a model supplies can reach this.
    taxYear: snapshot.taxYear,
    filingStatus: snapshot.filingStatus,
    ordinaryIncomeMinor: wages,
    selfEmploymentNetProfitMinor: has(snapshot, "SELF_EMPLOYMENT_NET_PROFIT") ? selfEmployment : 0,
    w2SocialSecurityWagesMinor: has(snapshot, "W2_SOCIAL_SECURITY_WAGES") ? totalFor(snapshot, "W2_SOCIAL_SECURITY_WAGES") : undefined,
    w2MedicareWagesMinor: has(snapshot, "W2_MEDICARE_WAGES") ? totalFor(snapshot, "W2_MEDICARE_WAGES") : undefined,
    stateAdditionsMinor: has(snapshot, "STATE_ADDITIONS") ? totalFor(snapshot, "STATE_ADDITIONS") : undefined,
    stateSubtractionsMinor: has(snapshot, "STATE_SUBTRACTIONS") ? totalFor(snapshot, "STATE_SUBTRACTIONS") : undefined,
    dependentCount: snapshot.dependents.length > 0 ? snapshot.dependents.length : undefined,
    currency,
  };
}

/** Federal payments recorded, or null when none are — which is not zero. */
export function federalPaymentsMinor(snapshot: TaxInputSnapshot): number | null {
  const keys: TaxFactKey[] = ["W2_FEDERAL_WITHHOLDING", "FEDERAL_ESTIMATED_PAYMENTS"];
  if (!keys.some((key) => has(snapshot, key))) return null;
  return keys.reduce((sum, key) => sum + totalFor(snapshot, key), 0);
}

/** State payments recorded, or null when none are. */
export function statePaymentsMinor(snapshot: TaxInputSnapshot): number | null {
  const keys: TaxFactKey[] = ["W2_STATE_WITHHOLDING", "STATE_ESTIMATED_PAYMENTS"];
  if (!keys.some((key) => has(snapshot, key))) return null;
  return keys.reduce((sum, key) => sum + totalFor(snapshot, key), 0);
}

/** The fact keys a snapshot carries — used to scope the notModelled list. */
export function snapshotFactKeys(snapshot: TaxInputSnapshot): readonly TaxFactKey[] {
  return [...new Set(snapshot.facts.map((fact) => fact.key))];
}

/** Every key that reaches an engine, for documentation and tests. */
export const ENGINE_CONSUMED_KEYS: readonly TaxFactKey[] = calculatedKeys();

/** Every key that only informs the refund statement. */
export const PAYMENT_KEYS: readonly TaxFactKey[] = paymentKeys();
