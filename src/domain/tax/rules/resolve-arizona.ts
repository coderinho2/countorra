import { resolveRuleSet, type RuleResolution } from "./resolve-rule-set";

/**
 * WHICH ARIZONA RULE SET ANSWERS A GIVEN REQUESTED YEAR.
 *
 * `FALLBACK_POLICY` IS EMPTY, AND THAT IS THE SUBSTANTIVE DECISION HERE.
 *
 * Arizona 2026 is registered but incomplete: the 2.5% rate is settled and the
 * standard deduction the calculation depends on is not. That is exactly the
 * shape California was in — and California DOES fall back to 2025, so the
 * temptation to copy that policy across is strong.
 *
 * It would be wrong. California's fallback is not this codebase's idea: FTB's
 * own 2026 Form 540-ES tells filers to figure 2026 tax using the 2025 table
 * and the 2025 exemption credit, so answering with 2025's rules follows the
 * authority's own instruction. No equivalent Arizona instruction was found.
 * Substituting Arizona's 2025 standard deduction into a 2026 calculation
 * would be an invention wearing a disclosure, and a disclosed invention is
 * still an invention.
 *
 * So a 2026 request resolves to the registered-but-pending 2026 rule set,
 * which the shared resolver turns into a structured refusal carrying the list
 * of missing figures; and every other year is refused outright.
 *
 * WHEN THE DEPARTMENT PUBLISHES the 2026 standard deduction, filling in
 * `us-az-2026.ts` and emptying its `pendingPublication` makes the shared
 * resolver's first branch match, and Arizona answers with its own 2026 rules.
 * No change here, and no fallback ever needed.
 */

export type ArizonaRuleResolution = RuleResolution;

/** Empty by design. See the header. */
const FALLBACK_POLICY: ReadonlyMap<number, number> = new Map();

export function resolveArizonaRuleSet(requestedTaxYear: number): ArizonaRuleResolution {
  return resolveRuleSet("US_AZ", requestedTaxYear, FALLBACK_POLICY, {
    jurisdictionName: "Arizona",
    authorityName: "the Arizona Department of Revenue",
  });
}

/** Exposed for tests and documentation: the substitutions this resolver will
 *  ever make, regardless of what is registered. */
export function arizonaFallbackPolicy(): ReadonlyMap<number, number> {
  return FALLBACK_POLICY;
}
