import { money, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import type { TaxBracket, TaxTableRules } from "../rules/types";
import { applyProgressiveBrackets } from "./brackets";

/**
 * A published TAX TABLE, applied as the discrete step function it is.
 *
 * WHY THIS IS NOT `applyProgressiveBrackets` WITH EXTRA STEPS
 *
 * A rate schedule is continuous: one more dollar of income always changes the
 * tax. A table is not. Every taxable income inside an interval pays the SAME
 * whole-dollar amount, so the tax is flat across the interval and jumps at
 * its edge. Running the rate schedule directly on the income instead would
 * disagree with a filed Form 540 for almost everyone under $100,000 — the
 * table's whole purpose is to replace that figure with a banded one.
 *
 * So this function finds the interval, and the rate schedule is applied only
 * to that interval's midpoint. The income itself never reaches the brackets.
 *
 * THE CONSTRUCTION IS DATA, NOT A CONSTANT IN HERE
 *
 * Interval boundaries, widths, the midpoint rule and the rounding rule all
 * come from `TaxTableRules` on the rule set. This function holds no dollar
 * amount, no width and no cap — adding a year, or a jurisdiction with a
 * differently shaped table, is a data change.
 *
 * VERIFIED, NOT ASSUMED. All 983 rows recoverable from FTB's published 2025
 * table reproduce exactly under this construction, for Single and for
 * Married/RDP Filing Jointly. `california-tax-table.test.ts` re-runs verbatim
 * published rows as an executable oracle.
 */

export interface TaxTableApplication {
  /** The published interval the income fell in, inclusive, in minor units. */
  intervalFromMinor: number;
  intervalToMinor: number;
  /** The income the rate schedule was actually applied to. */
  midpoint: Money;
  /** Before the whole-dollar rounding the table applies. */
  taxAtMidpoint: Money;
  /** The published figure: whole dollars. */
  tax: Money;
  /** True when the income sits below the table's first published row — under
   *  $1 for California. There is no row to name, and the tax is zero. */
  belowFirstRow: boolean;
}

/**
 * Applies the table, or returns null when the income is outside its range.
 *
 * Null means "the table does not govern this income" — above the cap, where
 * FTB requires the rate schedule instead. The caller decides what to do with
 * that; this function will not silently substitute one method for the other.
 */
export function applyTaxTable(
  taxableIncome: Money,
  brackets: readonly TaxBracket[],
  table: TaxTableRules,
  currency: CurrencyCode,
): TaxTableApplication | null {
  if (taxableIncome.amountMinor > table.appliesUpToMinor) return null;

  // Below the first band there is no row, and no tax. FTB's table starts at
  // $1; anything under it rounds to zero under the same construction anyway.
  const band = table.bands.find((candidate) => taxableIncome.amountMinor >= candidate.fromMinor && taxableIncome.amountMinor <= candidate.toMinor);
  if (!band) {
    const zeroAmount = money(0, currency);
    return {
      intervalFromMinor: 0,
      intervalToMinor: Math.max(0, (table.bands[0]?.fromMinor ?? 1) - 1),
      midpoint: zeroAmount,
      taxAtMidpoint: zeroAmount,
      tax: zeroAmount,
      belowFirstRow: true,
    };
  }

  const index = Math.floor((taxableIncome.amountMinor - band.fromMinor) / band.intervalWidthMinor);
  const intervalFromMinor = band.fromMinor + index * band.intervalWidthMinor;
  // `- 100` because an interval "$51 to $150" spans 100 dollars inclusive:
  // its top is one dollar below the next interval's floor. Truncated at the
  // band's own top, which is what makes FTB's final row only $50 wide.
  const intervalToMinor = Math.min(band.toMinor, intervalFromMinor + band.intervalWidthMinor - 100);

  // Both bounds are whole dollars, so their sum is even and the midpoint is
  // an exact integer number of cents. No float enters here.
  const midpointMinor = (intervalFromMinor + intervalToMinor) / 2;
  const midpoint = money(midpointMinor, currency);

  const taxAtMidpoint = applyProgressiveBrackets(midpoint, brackets, currency).total;
  const tax = money(roundToWholeMajorUnit(taxAtMidpoint.amountMinor, table.rounding), currency);

  return { intervalFromMinor, intervalToMinor, midpoint, taxAtMidpoint, tax, belowFirstRow: false };
}

/**
 * Rounds a cent amount to a whole dollar.
 *
 * The tie-break is declared in the rule set rather than chosen here. For
 * California 2025 it is half-up — and, stated honestly, no row of that table
 * lands on an exact half-dollar, so the published data cannot distinguish
 * half-up from half-even. Half-up matches the rounding used everywhere else
 * in this codebase, so that is what is declared and what runs.
 */
function roundToWholeMajorUnit(amountMinor: number, rounding: TaxTableRules["rounding"]): number {
  if (rounding !== "whole_dollar_half_up") {
    // Unreachable while the type has one member, and deliberately loud if a
    // second is added without teaching this function about it. A silently
    // wrong rounding rule would be invisible in the output.
    throw new RangeError(`Unsupported tax table rounding rule: ${rounding}`);
  }
  // Math.round is half-up for positives, which is what is wanted; taxable
  // income is floored at zero before it ever reaches a table.
  return Math.round(amountMinor / 100) * 100;
}
