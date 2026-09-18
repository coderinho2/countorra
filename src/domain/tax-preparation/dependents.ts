import type { DependentStatus, PreparationDependent } from "./types";

/**
 * How complete a dependent's INFORMATION is.
 *
 * Deliberately not a qualification test. Whether a person is a qualifying
 * child or qualifying relative turns on relationship, age, residency, support
 * and joint-return rules that this product does not decide — and a threshold
 * encoded here ("six months or more") would look like a determination while
 * being a guess about the edge cases that matter most.
 *
 * So this answers only what a computer can: are the fields a reviewer needs
 * present, and has the person told us about a conflict that needs a human?
 * `NOT_SUPPORTED` is never assigned automatically.
 */
export function dependentStatusFor(
  dependent: Pick<PreparationDependent, "dateOfBirth" | "monthsLivedWithTaxpayer" | "hasTaxIdentifier" | "claimedByAnother">,
): DependentStatus {
  if (!dependent.dateOfBirth || dependent.monthsLivedWithTaxpayer === null || !dependent.hasTaxIdentifier) return "INCOMPLETE";
  // Two people cannot claim the same dependent. Collected so a reviewer sees
  // it; nothing here adjudicates who may.
  if (dependent.claimedByAnother) return "NEEDS_REVIEW";
  return "VERIFIED";
}
