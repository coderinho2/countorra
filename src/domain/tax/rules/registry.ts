import type { TaxJurisdiction, TaxRuleSet } from "./types";
import { US_CA_2025 } from "./us-ca-2025";
import { US_FL_2026 } from "./us-fl-2026";
import { US_AZ_2026 } from "./us-az-2026";
import { US_TX_2026 } from "./us-tx-2026";
import { US_CA_2026 } from "./us-ca-2026";
import { US_FEDERAL_2026 } from "./us-federal-2026";
import { US_NY_2026 } from "./us-ny-2026";

/**
 * Which rule sets exist, keyed by jurisdiction and year.
 *
 * THE ONE RULE THIS ENFORCES: NO FALLBACK.
 *
 * A lookup that misses returns nothing. It does not return the nearest year,
 * the previous year, or the federal set for a state — every one of those
 * would produce a confident, wrong number, and a wrong tax figure is worse
 * than a refusal because the user has no way to tell it is wrong.
 *
 * Adding a jurisdiction or a year is a new entry here and a new data file.
 * Nothing in the engine changes.
 *
 * A REGISTERED YEAR IS NOT NECESSARILY A COMPUTABLE ONE. `US_CA` 2026 is
 * registered while FTB has yet to publish its rate schedules; its rule set
 * carries `pendingPublication`, and the California engine turns that into a
 * structured refusal naming the missing figures. Registration says "this
 * jurisdiction and year are understood"; the rule set says what is known.
 */

const RULE_SETS: readonly TaxRuleSet[] = [US_FEDERAL_2026, US_CA_2025, US_CA_2026, US_NY_2026, US_FL_2026, US_TX_2026, US_AZ_2026];

function keyOf(jurisdiction: TaxJurisdiction, taxYear: number): string {
  return `${jurisdiction}:${taxYear}`;
}

const BY_KEY = new Map<string, TaxRuleSet>(RULE_SETS.map((set) => [keyOf(set.jurisdiction, set.taxYear), set]));

/** The rule set for exactly this jurisdiction and year, or null. */
export function findRuleSet(jurisdiction: TaxJurisdiction, taxYear: number): TaxRuleSet | null {
  return BY_KEY.get(keyOf(jurisdiction, taxYear)) ?? null;
}

/**
 * A specific historical version, for reproducing a stored calculation.
 *
 * Returns null when the stored version is not the one currently in the
 * codebase. That is the honest answer: the figures have since been corrected
 * and this build cannot reproduce the old result. Silently recomputing under
 * the new rules would present a different number as if it were the original.
 */
export function findRuleSetVersion(jurisdiction: TaxJurisdiction, taxYear: number, version: string): TaxRuleSet | null {
  const ruleSet = findRuleSet(jurisdiction, taxYear);
  return ruleSet && ruleSet.version === version ? ruleSet : null;
}

export function supportedJurisdictions(): TaxJurisdiction[] {
  return [...new Set(RULE_SETS.map((set) => set.jurisdiction))];
}

export function supportedTaxYears(jurisdiction: TaxJurisdiction): number[] {
  return RULE_SETS.filter((set) => set.jurisdiction === jurisdiction)
    .map((set) => set.taxYear)
    .sort((a, b) => a - b);
}

export function isSupported(jurisdiction: TaxJurisdiction, taxYear: number): boolean {
  return BY_KEY.has(keyOf(jurisdiction, taxYear));
}

/** Every registered set, for documentation and tests. */
export function allRuleSets(): readonly TaxRuleSet[] {
  return RULE_SETS;
}
