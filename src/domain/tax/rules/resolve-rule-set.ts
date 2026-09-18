import { findRuleSet } from "./registry";
import type { TaxJurisdiction, TaxRuleSet } from "./types";

/**
 * WHICH RULE SET ANSWERS A GIVEN REQUESTED YEAR.
 *
 * One implementation, shared by every jurisdiction that needs it, because
 * "never silently substitute one year's tax law for another" is the kind of
 * rule that must not exist in two places and drift.
 *
 * THE THREE BRANCHES, IN ORDER
 *
 *   1. The requested year's OWN published rules, whenever they exist and are
 *      complete. This is checked first, which is what makes a fallback turn
 *      itself off: the moment a pending rule set is filled in, it wins here
 *      and the substitution below stops happening. No code changes.
 *
 *   2. A year nobody has modelled at all → unsupported. Checked BEFORE the
 *      fallback policy, so a future year can never reach it.
 *
 *   3. The requested year exists but its figures are pending → consult the
 *      jurisdiction's explicit policy. A policy is a keyed map, never a range
 *      and never "the nearest year": a generic rule would answer 2031 with
 *      2025's figures and look authoritative doing it.
 *
 * A fallback target that is itself incomplete is no fallback, and refusing is
 * the only honest outcome — that also stops a chain of substitutions.
 */

/** Whether the rules that produced a figure are the ones published for the
 *  year that was asked about. */
export type CalculationStatus = "PUBLISHED_RULES" | "ESTIMATE_USING_LATEST_PUBLISHED_RULES";

/** What the result must say when the two years differ. Structured rather than
 *  prose, so a caller can render it and a test can assert on it. */
export interface RuleFallback {
  requestedTaxYear: number;
  ruleSetTaxYear: number;
  /** Why the requested year's own rules were not used. */
  reason: string;
  /** The specific figures the authority has yet to release. */
  pendingPublication: readonly string[];
  /** One sentence, safe and sufficient to show a person on its own. */
  notice: string;
}

export interface ResolvedRules {
  resolved: true;
  ruleSet: TaxRuleSet;
  requestedTaxYear: number;
  status: CalculationStatus;
  /** Null when the requested year's own published rules were used. */
  fallback: RuleFallback | null;
}

export interface UnresolvedRules {
  resolved: false;
  requestedTaxYear: number;
  message: string;
  details?: readonly string[];
}

export type RuleResolution = ResolvedRules | UnresolvedRules;

/** How a jurisdiction describes itself in the messages a person will read. */
export interface ResolverCopy {
  /** e.g. "California", "New York". */
  jurisdictionName: string;
  /** e.g. "the Franchise Tax Board". */
  authorityName: string;
}

function isPending(ruleSet: TaxRuleSet): boolean {
  return (ruleSet.pendingPublication?.length ?? 0) > 0;
}

/**
 * @param fallbackPolicy The ONLY substitutions permitted, as requested year →
 *   fallback year. Empty means this jurisdiction never substitutes.
 */
export function resolveRuleSet(
  jurisdiction: TaxJurisdiction,
  requestedTaxYear: number,
  fallbackPolicy: ReadonlyMap<number, number>,
  copy: ResolverCopy,
): RuleResolution {
  const requested = findRuleSet(jurisdiction, requestedTaxYear);

  // ── 1. The requested year's own published rules ───────────────────────
  if (requested && !isPending(requested)) {
    return { resolved: true, ruleSet: requested, requestedTaxYear, status: "PUBLISHED_RULES", fallback: null };
  }

  // ── 2. A year nobody has modelled ─────────────────────────────────────
  if (!requested) {
    return { resolved: false, requestedTaxYear, message: `This ${copy.jurisdictionName} tax year is not currently supported.` };
  }

  // ── 3. Pending figures — consult the explicit policy ──────────────────
  const fallbackYear = fallbackPolicy.get(requestedTaxYear);
  const fallbackRuleSet = fallbackYear === undefined ? null : findRuleSet(jurisdiction, fallbackYear);

  if (!fallbackRuleSet || isPending(fallbackRuleSet)) {
    return {
      resolved: false,
      requestedTaxYear,
      message: `${copy.jurisdictionName} income tax for ${requestedTaxYear} can't be calculated yet: ${copy.authorityName} has not published all the figures it needs, and no fully published ${copy.jurisdictionName} rule set is available to estimate from.`,
      details: requested.pendingPublication,
    };
  }

  return {
    resolved: true,
    ruleSet: fallbackRuleSet,
    requestedTaxYear,
    status: "ESTIMATE_USING_LATEST_PUBLISHED_RULES",
    fallback: {
      requestedTaxYear,
      ruleSetTaxYear: fallbackRuleSet.taxYear,
      reason: `${copy.authorityName} has not yet published the complete ${requestedTaxYear} ${copy.jurisdictionName} rate schedules and standard deduction.`,
      pendingPublication: requested.pendingPublication ?? [],
      notice: `${copy.jurisdictionName}'s complete ${requestedTaxYear} tax rate schedules and standard deduction have not yet been published. This estimate uses the latest fully published ${copy.jurisdictionName} rules (${fallbackRuleSet.taxYear}) and is not a ${requestedTaxYear} filed-return calculation.`,
    },
  };
}
