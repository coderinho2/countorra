import { resolveRuleSet, type CalculationStatus, type ResolvedRules, type RuleFallback, type RuleResolution, type UnresolvedRules } from "./resolve-rule-set";

/**
 * WHICH CALIFORNIA RULE SET ANSWERS A GIVEN REQUESTED YEAR.
 *
 * THE PROBLEM THIS SOLVES
 *
 * FTB has published the 2026 Behavioral Health Services Tax but not the 2026
 * rate schedules or standard deduction. Refusing every 2026 request is
 * correct but not useful; answering one with 2025 figures labelled 2026 would
 * be useful and dishonest. The third option — answer with 2025 rules, say so
 * in the result, and stamp the rule set that actually ran — is what this
 * implements.
 *
 * THIS IS NOT A GENERIC "NEAREST YEAR" FALLBACK
 *
 * There is exactly one entry in `FALLBACK_POLICY`, and it is conditional.
 * A generic "any unsupported year → latest available" rule would silently
 * answer 2031 with 2025 figures, and answer a year FTB has genuinely never
 * published with something that looks authoritative. Every year not named
 * below is unsupported, full stop.
 *
 * IT TURNS ITSELF OFF
 *
 * The fallback fires only while the requested year's own rule set is marked
 * `pendingPublication`. The moment `us-ca-2026.ts` gains its rate schedules
 * and that list is emptied, the shared resolver's first branch matches and
 * 2026 answers with 2026 rules. No code changes, no calculation-engine
 * rewrite, and no chance of the fallback outliving the reason for it.
 *
 * The branch logic itself lives in `resolve-rule-set.ts`, shared with New
 * York — one implementation of "never silently substitute one year's tax law
 * for another", rather than two that can drift apart.
 */

export type { CalculationStatus, RuleFallback };

/** Kept as named types so existing callers and tests read unchanged. */
export type ResolvedCaliforniaRules = ResolvedRules;
export type UnresolvedCaliforniaRules = UnresolvedRules;
export type CaliforniaRuleResolution = RuleResolution;

/**
 * The ONLY permitted substitution, and the condition under which it applies.
 *
 * Read as: a request for 2026 may be answered with 2025's rules, but only
 * while 2026's own rule set says its figures are pending publication.
 */
const FALLBACK_POLICY: ReadonlyMap<number, number> = new Map([[2026, 2025]]);

export function resolveCaliforniaRuleSet(requestedTaxYear: number): CaliforniaRuleResolution {
  return resolveRuleSet("US_CA", requestedTaxYear, FALLBACK_POLICY, {
    jurisdictionName: "California",
    authorityName: "the Franchise Tax Board",
  });
}

/** Exposed for tests and documentation: the substitutions this resolver will
 *  ever make, regardless of what is registered. */
export function californiaFallbackPolicy(): ReadonlyMap<number, number> {
  return FALLBACK_POLICY;
}
