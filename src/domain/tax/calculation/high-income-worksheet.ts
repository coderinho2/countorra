import { add, money, percentageOf, subtract, type Money } from "@/domain/money/money";
import type { CurrencyCode } from "@/domain/money/currency";
import type { FilingStatus, HighIncomeRules, HighIncomeWorksheet, TaxBracket } from "../rules/types";
import { applyPublishedRateSchedule } from "./published-rate-schedule";

/**
 * NEW YORK'S TAX COMPUTATION WORKSHEETS, LINE BY LINE.
 *
 * WHAT THEY DO, AND WHY AN ENGINE THAT IGNORED THEM WOULD BE BADLY WRONG
 *
 * Above $107,650 of New York adjusted gross income, New York recaptures the
 * benefit of its lower brackets. A taxpayer well above the threshold ends up
 * paying their top rate on EVERY dollar of taxable income rather than on the
 * top slice only. Stopping at the progressive brackets would understate a
 * high earner's New York tax by thousands — and would look entirely
 * reasonable while doing it, because the bracket arithmetic itself is right.
 *
 * Three published shapes, implemented exactly as printed:
 *
 *   phase_in       Taxable income × the flat rate at the top of the band. The
 *                  difference from the ordinary bracket tax is phased in over
 *                  $50,000 of NYAGI above the threshold. New York's "Stop"
 *                  instruction — above $157,650 the flat figure stands — is
 *                  the same statement as the fraction reaching 1.
 *
 *   recapture      Ordinary bracket tax, plus a published recapture base
 *                  (already fully phased in below), plus this band's
 *                  incremental benefit phased in over the same $50,000.
 *
 *   flat_top_rate  Above $25,000,000 of NYAGI: taxable income × the top rate.
 *
 * THE FOURTH-DECIMAL ROUNDING IS NOT DECORATION
 *
 * New York says "Divide line 7 by $50,000 and round the result to the fourth
 * decimal place", and then multiplies a dollar amount by that. Rounding to
 * four places rather than carrying full precision changes the answer by cents
 * to dollars on large incomes, so it is done here in integer arithmetic —
 * ten-thousandths, never a float.
 */

export interface HighIncomeApplication {
  /** New York's own worksheet number, so the trace names the published form. */
  worksheetId: number;
  kind: HighIncomeWorksheet["kind"];
  /** Each line of the published worksheet that carries a figure. */
  lines: readonly { line: string; label: string; amount: Money }[];
  /** The phase-in fraction, in ten-thousandths, where one applies. */
  phaseInTenThousandths: number | null;
  tax: Money;
}

/**
 * Selects and applies the worksheet New York prescribes, or returns null when
 * the ordinary rate schedule governs.
 *
 * Null means "no worksheet applies" — at or below the threshold. It never
 * means "no worksheet was found": a filing status above the threshold with no
 * matching worksheet throws, because silently reverting to the bracket table
 * there is the exact understatement this module exists to prevent.
 */
export function applyHighIncomeWorksheet(
  nyagi: Money,
  taxableIncome: Money,
  filingStatus: FilingStatus,
  brackets: readonly TaxBracket[],
  rules: HighIncomeRules,
  currency: CurrencyCode,
): HighIncomeApplication | null {
  if (nyagi.amountMinor <= rules.ordinaryScheduleUpToAgiMinor) return null;

  const worksheets = rules.worksheets[filingStatus];
  if (!worksheets || worksheets.length === 0) {
    throw new RangeError(`No New York tax computation worksheets are transcribed for filing status ${filingStatus}.`);
  }

  const worksheet = worksheets.find((candidate) => matches(candidate, nyagi.amountMinor, taxableIncome.amountMinor));
  if (!worksheet) {
    // Unreachable with well-formed published data — taxable income never
    // exceeds NYAGI, so the bands cover every reachable pair. Loud rather
    // than silent, because the alternative is an understated tax bill.
    throw new RangeError(
      `No New York tax computation worksheet covers NYAGI ${nyagi.amountMinor} with taxable income ${taxableIncome.amountMinor} for ${filingStatus}.`,
    );
  }

  const lines: { line: string; label: string; amount: Money }[] = [
    { line: "1", label: "New York adjusted gross income", amount: nyagi },
    { line: "2", label: "New York taxable income", amount: taxableIncome },
  ];

  if (worksheet.kind === "flat_top_rate") {
    // Worksheets 6, 11 and 16 do not take NYAGI as a line at all — above
    // $25,000,000 the recapture is total.
    const tax = percentageOf(taxableIncome, worksheet.topRateBasisPoints / 100);
    return {
      worksheetId: worksheet.id,
      kind: worksheet.kind,
      lines: [
        { line: "1", label: "New York taxable income", amount: taxableIncome },
        { line: "2", label: `Taxable income × ${worksheet.topRateBasisPoints / 100}%`, amount: tax },
      ],
      phaseInTenThousandths: null,
      tax,
    };
  }

  const scheduleTax = applyPublishedRateSchedule(taxableIncome, brackets, currency).total;

  if (worksheet.kind === "phase_in") {
    const flat = percentageOf(taxableIncome, worksheet.flatRateBasisPoints / 100);
    lines.push({ line: "3", label: `Taxable income × ${worksheet.flatRateBasisPoints / 100}%`, amount: flat });

    if (nyagi.amountMinor >= worksheet.phaseInCompleteAtAgiMinor) {
      // New York's printed "Stop" instruction: the phase-in is complete, and
      // the flat-rate figure is the tax.
      return { worksheetId: worksheet.id, kind: worksheet.kind, lines, phaseInTenThousandths: 10_000, tax: flat };
    }

    lines.push({ line: "4", label: "Tax from the New York State rate schedule", amount: scheduleTax });
    const benefit = subtract(flat, scheduleTax);
    lines.push({ line: "5", label: "Benefit being recaptured", amount: benefit });

    const excess = money(nyagi.amountMinor - worksheet.phaseInFromMinor, currency);
    lines.push({ line: "6", label: `NYAGI over $${(worksheet.phaseInFromMinor / 100).toLocaleString("en-US")}`, amount: excess });

    const fraction = phaseInFraction(excess.amountMinor, worksheet.phaseInRangeMinor, rules.phaseInFractionDecimalPlaces);
    const phasedIn = applyFraction(benefit, fraction, currency);
    lines.push({ line: "8", label: "Recaptured portion", amount: phasedIn });

    const tax = add(scheduleTax, phasedIn);
    lines.push({ line: "9", label: "New York State tax", amount: tax });
    return { worksheetId: worksheet.id, kind: worksheet.kind, lines, phaseInTenThousandths: fraction, tax };
  }

  // kind === "recapture"
  lines.push({ line: "3", label: "Tax from the New York State rate schedule", amount: scheduleTax });

  const recaptureBase = money(worksheet.recaptureBaseMinor, currency);
  lines.push({ line: "4", label: "Recapture base amount", amount: recaptureBase });

  const incremental = money(worksheet.incrementalBenefitMinor, currency);
  lines.push({ line: "5", label: "Incremental benefit amount", amount: incremental });

  const excess = money(nyagi.amountMinor - worksheet.phaseInFromMinor, currency);
  lines.push({ line: "6", label: `NYAGI over $${(worksheet.phaseInFromMinor / 100).toLocaleString("en-US")}`, amount: excess });

  // Line 7 is the LESSER of the excess and the range — the recapture
  // worksheets cap it explicitly, where the phase-in worksheets rely on the
  // "Stop" instruction instead.
  const capped = money(Math.min(excess.amountMinor, worksheet.phaseInRangeMinor), currency);
  lines.push({ line: "7", label: `Lesser of that and $${(worksheet.phaseInRangeMinor / 100).toLocaleString("en-US")}`, amount: capped });

  const fraction = phaseInFraction(capped.amountMinor, worksheet.phaseInRangeMinor, rules.phaseInFractionDecimalPlaces);
  const phasedIn = applyFraction(incremental, fraction, currency);
  lines.push({ line: "9", label: "Phased-in incremental benefit", amount: phasedIn });

  const tax = add(add(scheduleTax, recaptureBase), phasedIn);
  lines.push({ line: "10", label: "New York State tax", amount: tax });

  return { worksheetId: worksheet.id, kind: worksheet.kind, lines, phaseInTenThousandths: fraction, tax };
}

function matches(worksheet: HighIncomeWorksheet, nyagiMinor: number, taxableMinor: number): boolean {
  if (nyagiMinor <= worksheet.agiOverMinor) return false;
  if (worksheet.kind === "flat_top_rate") return true;
  if (worksheet.agiUpToMinor !== null && nyagiMinor > worksheet.agiUpToMinor) return false;

  if (worksheet.kind === "phase_in") return taxableMinor <= worksheet.taxableIncomeUpToMinor;

  if (taxableMinor <= worksheet.taxableIncomeOverMinor) return false;
  return worksheet.taxableIncomeUpToMinor === null || taxableMinor <= worksheet.taxableIncomeUpToMinor;
}

/**
 * New York's "divide by $50,000 and round to the fourth decimal place",
 * returned as an integer count of ten-thousandths.
 *
 * Integer arithmetic end to end: a float here would make the result depend on
 * binary rounding at the fourth decimal, which is precisely where New York
 * chose to round.
 */
function phaseInFraction(numeratorMinor: number, denominatorMinor: number, decimalPlaces: number): number {
  const scale = 10 ** decimalPlaces;
  if (denominatorMinor <= 0) return scale;
  return Math.min(scale, Math.round((numeratorMinor * scale) / denominatorMinor));
}

/** Multiplies a money amount by a fraction expressed in ten-thousandths. */
function applyFraction(amount: Money, tenThousandths: number, currency: CurrencyCode): Money {
  // Via `percentageOf`, which is BigInt with round-half-up at the cent:
  // ten-thousandths → percent is a divide by 100, exact to two decimals for
  // every value New York's fourth-decimal rounding can produce.
  return percentageOf(money(amount.amountMinor, currency), tenThousandths / 100);
}
