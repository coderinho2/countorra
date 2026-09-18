import { money, zero, add, percentageOf, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import type { TaxBracket } from "../rules/types";

/**
 * Progressive marginal tax, computed bracket by bracket.
 *
 * THE MISTAKE THIS EXISTS TO MAKE IMPOSSIBLE
 *
 * "You're in the 22% bracket, so you pay 22%" is wrong, and it is wrong in
 * the direction that overstates someone's tax by thousands. Only the income
 * INSIDE a bracket is taxed at that bracket's rate. A single-percentage
 * calculation is not an approximation of this; it is a different and much
 * larger number.
 *
 * EXACTNESS
 *
 * Every step goes through `percentageOf`, which is BigInt with round-half-up
 * at the cent. Rates arrive as integer basis points, so no float appears in
 * the data or the arithmetic. The per-bracket amounts are each rounded to the
 * cent and then summed, rather than summed as rationals and rounded once —
 * that is what makes the returned breakdown add up to the returned total,
 * which matters because the breakdown is shown to the user.
 */

export interface BracketApplication {
  rateBasisPoints: number;
  /** Bracket bounds, for the trace. */
  fromMinor: number;
  upToMinor: number | null;
  /** How much of the taxable income fell inside this bracket. */
  taxableInBracket: Money;
  /** Tax produced by this bracket alone. */
  tax: Money;
}

export interface ProgressiveTaxResult {
  total: Money;
  applications: BracketApplication[];
  /** The rate on the last dollar — the "tax bracket" a person means when
   *  they say they are in one. Zero when there is no taxable income. */
  marginalRateBasisPoints: number;
  /** Total tax ÷ taxable income, in basis points. The number that actually
   *  answers "what percentage do I pay". Null when income is zero. */
  effectiveRateBasisPoints: number | null;
}

/**
 * Applies a bracket table to an amount of taxable income.
 *
 * `brackets` must be contiguous and ascending; the last one must be open
 * (`upToMinor: null`). Both are asserted rather than assumed — a gap or an
 * overlap in a rule set would silently under- or double-tax a slice of
 * income, and that is not a failure anyone would notice from the output.
 */
export function applyProgressiveBrackets(
  taxableIncome: Money,
  brackets: readonly TaxBracket[],
  currency: CurrencyCode,
): ProgressiveTaxResult {
  assertWellFormed(brackets);

  if (taxableIncome.amountMinor <= 0) {
    return { total: zero(currency), applications: [], marginalRateBasisPoints: 0, effectiveRateBasisPoints: null };
  }

  const applications: BracketApplication[] = [];
  let total = zero(currency);
  let marginalRateBasisPoints = 0;

  for (const bracket of brackets) {
    if (taxableIncome.amountMinor <= bracket.fromMinor) break;

    const ceiling = bracket.upToMinor ?? taxableIncome.amountMinor;
    const inBracket = Math.min(taxableIncome.amountMinor, ceiling) - bracket.fromMinor;
    if (inBracket <= 0) continue;

    const taxableInBracket = money(inBracket, currency);
    // Basis points → percent for `percentageOf`, which accepts two decimal
    // places. 2200 bp → 22, 1240 bp → 12.4. Exact for every rate in use.
    const tax = percentageOf(taxableInBracket, bracket.rateBasisPoints / 100);

    applications.push({
      rateBasisPoints: bracket.rateBasisPoints,
      fromMinor: bracket.fromMinor,
      upToMinor: bracket.upToMinor,
      taxableInBracket,
      tax,
    });

    total = add(total, tax);
    marginalRateBasisPoints = bracket.rateBasisPoints;
  }

  const effectiveRateBasisPoints =
    taxableIncome.amountMinor > 0 ? Math.round((total.amountMinor / taxableIncome.amountMinor) * 10_000) : null;

  return { total, applications, marginalRateBasisPoints, effectiveRateBasisPoints };
}

/**
 * Caps an amount at a ceiling — the OASDI wage base, for instance.
 * Separate and named because "the smaller of" appears throughout tax law and
 * an inline `Math.min` on a raw number loses the currency check.
 */
export function capAt(value: Money, ceilingMinor: number): Money {
  return money(Math.min(value.amountMinor, ceilingMinor), value.currency);
}

/** The part of an amount above a threshold, or zero. */
export function excessOver(value: Money, thresholdMinor: number): Money {
  return money(Math.max(0, value.amountMinor - thresholdMinor), value.currency);
}

/** Never below zero — taxable income and most tax bases floor at zero rather
 *  than going negative. */
export function floorAtZero(value: Money): Money {
  return value.amountMinor < 0 ? zero(value.currency) : value;
}

function assertWellFormed(brackets: readonly TaxBracket[]): void {
  if (brackets.length === 0) throw new RangeError("A bracket table must have at least one bracket.");

  let previousTop = 0;
  for (const [index, bracket] of brackets.entries()) {
    if (bracket.fromMinor !== previousTop) {
      // A gap leaves income untaxed; an overlap taxes it twice. Neither is
      // visible in the output, so both have to fail loudly here.
      throw new RangeError(`Bracket table is not contiguous at index ${index}: expected to start at ${previousTop}, starts at ${bracket.fromMinor}.`);
    }
    if (bracket.upToMinor === null) {
      if (index !== brackets.length - 1) throw new RangeError("Only the last bracket may be open-ended.");
      return;
    }
    if (bracket.upToMinor <= bracket.fromMinor) {
      throw new RangeError(`Bracket ${index} ends at or before it starts.`);
    }
    previousTop = bracket.upToMinor;
  }

  throw new RangeError("The highest bracket must be open-ended (upToMinor: null).");
}
