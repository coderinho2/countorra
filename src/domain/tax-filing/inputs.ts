import type { PreparationCalculation } from "@/domain/tax-preparation/calculation";
import { buildSnapshot } from "@/domain/tax-preparation/snapshot";
import type { PreparationCase, PreparationDependent, TaxFact, TaxInputSnapshot } from "@/domain/tax-preparation/types";
import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import { canonicalJson } from "./canonical-json";

/**
 * WHETHER THE FROZEN INPUTS STILL DESCRIBE THE CASE.
 *
 * A preparation snapshot freezes what the engines were given. Filing needs
 * more than "a snapshot exists": it needs the snapshot to still be the truth.
 *
 * The case status and version are the ordinary signal — every workflow action
 * reopens the case when information changes. But those are fields a member can
 * write, and a figure inserted directly through the API leaves them alone. So
 * this compares CONTENT: the snapshot the engines would receive if calculation
 * ran now, rebuilt with the same builder, against the one that was frozen.
 * Anything that differs — a fact, a dependent, the filing status, the taxpayer,
 * the jurisdictions — means the frozen calculation is not about this return.
 */

/** A preparation snapshot as stored: database id plus frozen content. */
export interface FrozenPreparation {
  id: string;
  version: number;
  snapshot: TaxInputSnapshot;
  calculation: PreparationCalculation | null;
}

export interface LiveInputs {
  preparationCase: PreparationCase;
  facts: readonly TaxFact[];
  dependents: readonly PreparationDependent[];
  /** From the completeness engine, which derives them from the organization. */
  jurisdictions: readonly TaxJurisdiction[];
}

export function liveInputsMatchFrozen(frozen: TaxInputSnapshot, live: LiveInputs): boolean {
  const { preparationCase } = live;
  if (!preparationCase.filingStatus) return false;

  const rebuilt = buildSnapshot({
    organizationId: frozen.organizationId,
    caseId: frozen.caseId,
    version: frozen.version,
    taxYear: preparationCase.taxYear,
    filingStatus: preparationCase.filingStatus,
    taxpayer: preparationCase.taxpayer,
    dependents: live.dependents,
    facts: live.facts,
    jurisdictions: live.jurisdictions,
    createdBy: frozen.createdBy,
    createdAt: frozen.createdAt,
  });

  return canonicalJson(comparableInputs(rebuilt)) === canonicalJson(comparableInputs(frozen));
}

/**
 * The parts of a snapshot that decide a tax result or appear in a package.
 *
 * Row ids and timestamps are left out on purpose: a dependent edited back to
 * its original values is the same dependent, and ordering must not matter.
 */
export function comparableInputs(snapshot: TaxInputSnapshot) {
  return {
    taxYear: snapshot.taxYear,
    filingStatus: snapshot.filingStatus,
    taxpayer: snapshot.taxpayer,
    dependents: snapshot.dependents
      .map((dependent) => ({
        firstName: dependent.firstName,
        lastName: dependent.lastName,
        relationship: dependent.relationship,
        dateOfBirth: dependent.dateOfBirth,
        monthsLivedWithTaxpayer: dependent.monthsLivedWithTaxpayer,
        isStudent: dependent.isStudent,
        isDisabled: dependent.isDisabled,
        hasTaxIdentifier: dependent.hasTaxIdentifier,
        claimedByAnother: dependent.claimedByAnother,
        status: dependent.status,
      }))
      .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    facts: snapshot.facts,
    jurisdictions: [...snapshot.jurisdictions],
  };
}

/**
 * The material a filing snapshot's input fingerprint is computed from.
 *
 * Which preparation snapshot, its frozen inputs and the calculation stored
 * with it. A filing snapshot whose fingerprint no longer matches the current
 * preparation state is stale, whatever its status says.
 */
export function inputFingerprintMaterial(frozen: FrozenPreparation): string {
  return canonicalJson({
    preparationSnapshotId: frozen.id,
    preparationVersion: frozen.version,
    inputs: comparableInputs(frozen.snapshot),
    calculation: frozen.calculation,
  });
}
