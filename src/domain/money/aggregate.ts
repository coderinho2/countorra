import { money, type CurrencyCode, type Money } from "./money";

/**
 * FIN-03. The one rule for totalling amounts that may not share a currency.
 *
 * The accounts page already got this right and said why
 * (src/app/app/[orgId]/accounts/page.tsx):
 *
 *   "adding a EUR balance to a USD one at 1:1 would be a fabricated number,
 *    and this product does not print numbers it cannot stand behind."
 *
 * The AI tools did not. `getFinancialOverview` and `forecastCashFlow` reduced
 * raw `amountMinor` integers across every account regardless of currency and
 * stamped one currency label on the result — sidestepping the `Money` type and
 * its `assertSameCurrency` guard entirely. The screen refused to invent that
 * number while the assistant stated it as fact, which is the worse of the two
 * failures: a wrong figure delivered with an explanation attached.
 *
 * So the rule lives here now, once, and both callers use it. Amounts in the
 * base currency are summed exactly; everything else is EXCLUDED and reported.
 * Never converted, never coerced, never silently dropped — an exclusion the
 * caller cannot see is the same lie in a quieter voice.
 *
 * There is deliberately no FX rate anywhere in this module. Converting
 * requires a rate source, a rate date, and a decision about which rate is
 * authoritative for a given report — none of which this product has. Until it
 * does, "we did not include this, and here is what we left out" is the only
 * honest answer.
 */

export interface CurrencyAmount {
  amountMinor: number;
  currency: CurrencyCode;
}

export interface ExcludedCurrency {
  currency: CurrencyCode;
  /** How many amounts were left out — not their sum, which would invite a
   *  reader to add the two figures back together themselves. */
  count: number;
}

export interface BaseCurrencyTotal {
  /** Exact, and always in the base currency. */
  total: Money;
  includedCount: number;
  /** Empty when everything shared the base currency. Sorted by currency so
   *  the output is stable for snapshots and for the model reading it. */
  excluded: ExcludedCurrency[];
}

export function totalInBaseCurrency(values: CurrencyAmount[], base: CurrencyCode): BaseCurrencyTotal {
  let totalMinor = 0;
  let includedCount = 0;
  const excludedCounts = new Map<CurrencyCode, number>();

  for (const value of values) {
    if (value.currency === base) {
      totalMinor += value.amountMinor;
      includedCount += 1;
    } else {
      excludedCounts.set(value.currency, (excludedCounts.get(value.currency) ?? 0) + 1);
    }
  }

  const excluded = [...excludedCounts.entries()]
    .map(([currency, count]) => ({ currency, count }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return { total: money(totalMinor, base), includedCount, excluded };
}

/**
 * A one-line, human-readable statement of what a total left out, or `null`
 * when it left out nothing.
 *
 * Returned alongside the structured `excluded` array rather than instead of
 * it: the structured form is what a UI renders, and this is what goes into an
 * AI tool result so the model has the caveat in the same payload as the
 * number. A caveat the model has to reconstruct is a caveat it can drop.
 */
export function describeExclusions(excluded: ExcludedCurrency[], base: CurrencyCode): string | null {
  if (excluded.length === 0) return null;

  const parts = excluded.map((e) => `${e.count} in ${e.currency}`);
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

  return `This total covers ${base} only. Excluded: ${list}. Amounts in another currency are never converted, so state this exclusion when reporting the figure.`;
}
