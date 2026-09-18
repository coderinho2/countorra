import { resolveRuleSet, type RuleResolution } from "./resolve-rule-set";

/**
 * WHICH TEXAS RULE SET ANSWERS A GIVEN REQUESTED YEAR.
 *
 * Texas needs a resolver in order to REFUSE, not to substitute. It has one
 * registered rule set, and a lenient lookup would hand that rule set to every
 * year anyone asked about.
 *
 * `FALLBACK_POLICY` is empty, deliberately. The temptation here is stronger
 * than anywhere else in this codebase: Texas's answer is $0 and would have
 * been $0 in 2025 and probably will be in 2027, so routing every year to 2026
 * looks free. It is not. Article VIII, Section 24-a is only in the Texas
 * Constitution because voters put it there in November 2019 — before that the
 * former Section 24 permitted an individual income tax subject to a
 * referendum. A constitution that changed once can change again, and a
 * resolver that answers years nobody checked would keep answering them
 * afterwards.
 *
 * So each year is registered explicitly or refused. Branch logic is shared
 * with California, New York and Florida in `resolve-rule-set.ts`; the policy
 * is Texas's own.
 */

export type TexasRuleResolution = RuleResolution;

/** Empty by design. See the header. */
const FALLBACK_POLICY: ReadonlyMap<number, number> = new Map();

export function resolveTexasRuleSet(requestedTaxYear: number): TexasRuleResolution {
  return resolveRuleSet("US_TX", requestedTaxYear, FALLBACK_POLICY, {
    jurisdictionName: "Texas",
    authorityName: "the Texas Comptroller of Public Accounts",
  });
}

/** Exposed for tests and documentation: the substitutions this resolver will
 *  ever make, regardless of what is registered. */
export function texasFallbackPolicy(): ReadonlyMap<number, number> {
  return FALLBACK_POLICY;
}
