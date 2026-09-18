import { resolveRuleSet, type RuleResolution } from "./resolve-rule-set";

/**
 * WHICH FLORIDA RULE SET ANSWERS A GIVEN REQUESTED YEAR.
 *
 * Florida needs a resolver for the same reason New York does: not to
 * substitute anything, but to REFUSE. Florida has exactly one registered rule
 * set, and a lenient lookup would hand it to every year anyone asked about —
 * including years whose legal position this codebase has not checked.
 *
 * `FALLBACK_POLICY` is empty, deliberately, and for a slightly different
 * reason than New York's. Florida's answer is stable in a way an indexed
 * bracket table never is: it would take a constitutional amendment to change
 * it. That makes "just route every year to 2026" tempting, and wrong — a
 * codebase that silently answers 2031 is one that will keep answering it
 * after the law changes. Each year is registered explicitly or refused.
 */

export type FloridaRuleResolution = RuleResolution;

/** Empty by design. See the header. */
const FALLBACK_POLICY: ReadonlyMap<number, number> = new Map();

export function resolveFloridaRuleSet(requestedTaxYear: number): FloridaRuleResolution {
  return resolveRuleSet("US_FL", requestedTaxYear, FALLBACK_POLICY, {
    jurisdictionName: "Florida",
    authorityName: "the Florida Department of Revenue",
  });
}

/** Exposed for tests and documentation: the substitutions this resolver will
 *  ever make, regardless of what is registered. */
export function floridaFallbackPolicy(): ReadonlyMap<number, number> {
  return FALLBACK_POLICY;
}
