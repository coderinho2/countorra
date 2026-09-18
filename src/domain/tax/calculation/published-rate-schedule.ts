import { add, money, percentageOf, zero, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import type { TaxBracket } from "../rules/types";

/**
 * A rate schedule applied the way its authority PUBLISHES it: a printed base
 * amount, plus a rate on the excess over the threshold.
 *
 * WHY THIS IS NOT `applyProgressiveBrackets`
 *
 * Both compute a progressive tax, and for a schedule stated only as rates
 * they agree. New York's schedules are not stated that way. They read:
 *
 *     over      but not over
 *     $8,500    $11,700       $332 plus 4.40% of the excess over $8,500
 *
 * and $332 is a ROUNDED whole dollar — the exact tax at $8,500 is $331.50.
 * Every base above it inherits that rounding, so New York's printed base at
 * $80,650 is $4,191 where an exact per-bracket sum gives $4,190.50. Summing
 * brackets therefore disagrees with the published schedule at essentially
 * every income, by up to about a dollar, silently.
 *
 * A dollar is small. Being unable to reconcile a tax figure against the form
 * it claims to implement is not. So where the authority publishes a base,
 * this function uses it verbatim, and the result matches the schedule.
 *
 * THE BASES ARE STILL CHECKED. `us-ny-2026.test.ts` recomputes each published
 * base from the rate and the base below it and asserts they agree to the
 * dollar — the same self-checking oracle used for the federal and California
 * tables. A mistyped base or rate fails there.
 */

export interface PublishedScheduleApplication {
  /** The bracket the income fell in. */
  fromMinor: number;
  upToMinor: number | null;
  rateBasisPoints: number;
  /** The published cumulative tax at `fromMinor`. */
  baseTaxMinor: number;
  /** Income above `fromMinor`. */
  excess: Money;
  /** Rate applied to `excess`. */
  taxOnExcess: Money;
  tax: Money;
}

export interface PublishedScheduleResult {
  total: Money;
  application: PublishedScheduleApplication | null;
  marginalRateBasisPoints: number;
  effectiveRateBasisPoints: number | null;
}

/**
 * Applies a published schedule to an amount of taxable income.
 *
 * `brackets` must be contiguous and ascending and every one must carry a
 * `baseTaxMinor` — a schedule missing one cannot be applied this way, and
 * failing loudly is the only safe response, because falling back to summing
 * brackets would produce a plausible figure that does not match the form.
 */
export function applyPublishedRateSchedule(taxableIncome: Money, brackets: readonly TaxBracket[], currency: CurrencyCode): PublishedScheduleResult {
  assertPublishedSchedule(brackets);

  if (taxableIncome.amountMinor <= 0) {
    return { total: zero(currency), application: null, marginalRateBasisPoints: 0, effectiveRateBasisPoints: null };
  }

  // The bracket containing the income: the last one whose floor it reaches.
  let bracket = brackets[0];
  for (const candidate of brackets) {
    if (taxableIncome.amountMinor > candidate.fromMinor) bracket = candidate;
  }

  const excess = money(taxableIncome.amountMinor - bracket.fromMinor, currency);
  const taxOnExcess = percentageOf(excess, bracket.rateBasisPoints / 100);
  const baseTaxMinor = bracket.baseTaxMinor ?? 0;
  const total = add(money(baseTaxMinor, currency), taxOnExcess);

  return {
    total,
    application: {
      fromMinor: bracket.fromMinor,
      upToMinor: bracket.upToMinor,
      rateBasisPoints: bracket.rateBasisPoints,
      baseTaxMinor,
      excess,
      taxOnExcess,
      tax: total,
    },
    marginalRateBasisPoints: bracket.rateBasisPoints,
    effectiveRateBasisPoints: Math.round((total.amountMinor / taxableIncome.amountMinor) * 10_000),
  };
}

function assertPublishedSchedule(brackets: readonly TaxBracket[]): void {
  if (brackets.length === 0) throw new RangeError("A published rate schedule must have at least one bracket.");

  let previousTop = 0;
  for (const [index, bracket] of brackets.entries()) {
    if (bracket.baseTaxMinor === undefined) {
      throw new RangeError(`Bracket ${index} has no published base amount, so this schedule cannot be applied as published.`);
    }
    if (bracket.fromMinor !== previousTop) {
      // A gap leaves income untaxed; an overlap taxes it twice. Neither is
      // visible in the output, so both have to fail loudly here.
      throw new RangeError(`Published schedule is not contiguous at index ${index}: expected to start at ${previousTop}, starts at ${bracket.fromMinor}.`);
    }
    if (bracket.upToMinor === null) {
      if (index !== brackets.length - 1) throw new RangeError("Only the last bracket may be open-ended.");
      return;
    }
    if (bracket.upToMinor <= bracket.fromMinor) throw new RangeError(`Bracket ${index} ends at or before it starts.`);
    previousTop = bracket.upToMinor;
  }

  throw new RangeError("The highest bracket must be open-ended (upToMinor: null).");
}
