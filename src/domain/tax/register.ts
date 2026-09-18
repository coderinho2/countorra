import { registerTaxEngine } from "./tax-engine";
import {
  usArizonaTaxEngine,
  usCaliforniaTaxEngine,
  usFederalTaxEngine,
  usFloridaTaxEngine,
  usNewYorkTaxEngine,
  usTexasTaxEngine,
} from "./countries/us";

/**
 * Registers every implemented jurisdiction engine.
 *
 * Kept separate from tax-engine.ts so the abstraction does not depend on the
 * concrete engines — engines depend on the abstraction, not the other way
 * around. Any code calling `getTaxEngine()` imports this module first, for
 * its side effect.
 *
 * WHAT IS REGISTERED IS WHAT IS IMPLEMENTED.
 *
 * Every jurisdiction `TaxJurisdiction` names is now registered. A registry
 * entry that threw would look like support from the outside; absence is
 * unambiguous — and so, now, is presence.
 *
 * Registration is not a promise that every year computes. Arizona is
 * registered and refuses: its 2026 rate is settled but the standard deduction
 * the calculation needs has not been published, so it returns
 * `rules_not_published` naming that figure. "We know, and we are waiting on
 * this" is a better answer than silence, and a much better one than a guess.
 *
 * Florida and Texas are registered even though neither levies an individual
 * income tax. "We know, and it is zero" is a different answer from "we don't
 * know", and only a registered engine can give the first one. They are two
 * engines over two rule sets, not one shared with an alias: same number,
 * different law, and either could change without the other.
 *
 * Registration is not a promise that every year computes. The California
 * engine is registered and answers for California; asked for a year whose
 * figures FTB has not published, it returns a structured refusal naming
 * them. That is a better answer than absence, and it is still never a
 * federal number.
 *
 * The Romania placeholder that used to sit here was removed with this
 * change. It existed only to demonstrate that the registry held more than
 * one country, which the jurisdiction list above now does honestly — and it
 * was a stub whose `calculate()` threw, which is exactly the shape this
 * architecture replaced with structured unsupported results.
 */
registerTaxEngine(usFederalTaxEngine);
registerTaxEngine(usCaliforniaTaxEngine);
registerTaxEngine(usNewYorkTaxEngine);
registerTaxEngine(usFloridaTaxEngine);
registerTaxEngine(usTexasTaxEngine);
registerTaxEngine(usArizonaTaxEngine);

export { getTaxEngine, isJurisdictionSupported, jurisdictionForCountry, stateJurisdictionFor } from "./tax-engine";
export { calculateCaliforniaSdi } from "./payroll/california-sdi";
export { findRuleSet, isSupported, supportedJurisdictions, supportedTaxYears } from "./rules/registry";
