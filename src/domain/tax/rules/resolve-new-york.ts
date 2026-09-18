import { resolveRuleSet, type RuleResolution } from "./resolve-rule-set";

/**
 * WHICH NEW YORK RULE SET ANSWERS A GIVEN REQUESTED YEAR.
 *
 * NEW YORK 2026 NEEDS NO FALLBACK, AND THAT IS THE POINT OF CHECKING
 *
 * California's 2026 figures were not published, so a request for 2026 there
 * is answered with 2025's rules under an explicit disclosure. New York is the
 * opposite case: the Department of Taxation and Finance published the
 * complete 2026 rate schedules, standard deductions, dependent exemption and
 * tax computation worksheets in Form IT-2105-I (2026), so a 2026 request is
 * answered with 2026's own rules and `PUBLISHED_RULES`.
 *
 * `FALLBACK_POLICY` is therefore EMPTY, deliberately. That is a statement,
 * not an omission: New York will never answer one year with another year's
 * tax law. Had the policy been copied from California's, a future year whose
 * figures went pending would silently start borrowing — which is exactly the
 * behaviour a keyed, per-jurisdiction policy exists to prevent.
 *
 * The resolver still exists, and it still matters. It is what refuses 2025,
 * 2027 and every other unmodelled year rather than reaching for the one rule
 * set that does exist. Branch logic is shared with California in
 * `resolve-rule-set.ts`.
 *
 * IF A FUTURE NEW YORK YEAR IS EVER INCOMPLETE
 *
 * Register it with `pendingPublication` listing the missing figures, and add
 * one entry here. Until both are done, an incomplete New York year refuses —
 * which is the safe default, and the reason the policy is opt-in.
 */

export type NewYorkRuleResolution = RuleResolution;

/** Empty by design. See the header. */
const FALLBACK_POLICY: ReadonlyMap<number, number> = new Map();

export function resolveNewYorkRuleSet(requestedTaxYear: number): NewYorkRuleResolution {
  return resolveRuleSet("US_NY", requestedTaxYear, FALLBACK_POLICY, {
    jurisdictionName: "New York",
    authorityName: "the New York State Department of Taxation and Finance",
  });
}

/** Exposed for tests and documentation: the substitutions this resolver will
 *  ever make, regardless of what is registered. */
export function newYorkFallbackPolicy(): ReadonlyMap<number, number> {
  return FALLBACK_POLICY;
}
