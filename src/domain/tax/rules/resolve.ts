import { resolveArizonaRuleSet } from "./resolve-arizona";
import { resolveCaliforniaRuleSet } from "./resolve-california";
import { resolveFloridaRuleSet } from "./resolve-florida";
import { resolveNewYorkRuleSet } from "./resolve-new-york";
import { resolveRuleSet, type RuleResolution } from "./resolve-rule-set";
import { resolveTexasRuleSet } from "./resolve-texas";
import type { TaxJurisdiction } from "./types";

/**
 * WHICH RULE SET WOULD ANSWER, WITHOUT RUNNING A CALCULATION.
 *
 * The engines each call their own resolver. This exists for callers that need
 * the answer BEFORE they have anything to calculate with — specifically the
 * preparation layer, which has to tell a person what a jurisdiction will do
 * with their year while they are still collecting the figures.
 *
 * WHY THE DISTINCTION IS WORTH A MODULE
 *
 * "Pending publication" does not mean the same thing in two states:
 *
 *   California 2026  FTB has not published the rate schedules, and there IS
 *                    a fully published 2025 set to estimate from. The answer
 *                    is a disclosed estimate.
 *   Arizona 2026     the standard deduction is unpublished and there is no
 *                    sanctioned fallback. The answer is a refusal.
 *
 * Both rule sets carry a `pendingPublication` list. A caller that read only
 * that list would tell a Californian their state is unavailable when it is
 * not, and an Arizonan they will get an estimate when they will not. Only the
 * resolver knows which, so this asks the resolver.
 *
 * THIS IS NOT A SECOND SOURCE OF TRUTH. It dispatches to the same functions
 * the engines use; it decides nothing itself. If it ever disagreed with an
 * engine, the engine's own outcome is still what gets recorded — the
 * preparation layer classifies results from what the engine returned, never
 * from what this predicted.
 */

/**
 * Federal has no substitution policy of its own, and should not acquire one
 * by accident. An empty map is the explicit statement of that: a federal year
 * is answered by its own published rules or not at all.
 */
const FEDERAL_POLICY: ReadonlyMap<number, number> = new Map();

const RESOLVERS: Readonly<Record<TaxJurisdiction, (taxYear: number) => RuleResolution>> = {
  US_FEDERAL: (taxYear) => resolveRuleSet("US_FEDERAL", taxYear, FEDERAL_POLICY, { jurisdictionName: "Federal", authorityName: "the IRS" }),
  US_CA: resolveCaliforniaRuleSet,
  US_NY: resolveNewYorkRuleSet,
  US_FL: resolveFloridaRuleSet,
  US_TX: resolveTexasRuleSet,
  US_AZ: resolveArizonaRuleSet,
};

export function resolveRulesFor(jurisdiction: TaxJurisdiction, requestedTaxYear: number): RuleResolution {
  return RESOLVERS[jurisdiction](requestedTaxYear);
}

/** The jurisdictions this module can answer for — used to prove it covers
 *  every one the type allows, rather than silently missing a new state. */
export function resolvableJurisdictions(): readonly TaxJurisdiction[] {
  return Object.keys(RESOLVERS) as TaxJurisdiction[];
}
