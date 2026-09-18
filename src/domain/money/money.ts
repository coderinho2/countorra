import { CURRENCIES, type CurrencyCode, minorUnitExponent } from "./currency";

/**
 * Money is always an integer count of minor units (e.g. cents) plus an
 * explicit currency — never a float, per DESIGN brief §11. Every arithmetic
 * operation in this module works in BigInt internally and rounds
 * half-up exactly once, at the end, so intermediate steps never accumulate
 * floating-point error.
 *
 * One documented exception: `fromMajorUnits` TRUNCATES precision beyond the
 * currency's minor unit rather than rounding it. That contradicted this
 * paragraph silently until MON-01; it is now stated here and at the call site
 * so the inconsistency is visible rather than surprising. This is the only place in the codebase that should
 * do math on `*_minor` columns — reach for these functions instead of `+`,
 * `-`, `*` on amounts directly.
 */
export interface Money {
  readonly amountMinor: number;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`Currency mismatch: cannot operate on ${a} and ${b} together.`);
    this.name = "CurrencyMismatchError";
  }
}

export function money(amountMinor: number, currency: CurrencyCode): Money {
  // `isSafeInteger`, not `isInteger` (MON-01). Past 2^53 a JS number is still
  // an "integer" but no longer a distinct one: 9007199254740993 silently
  // becomes 9007199254740992. Every construction path funnels through here —
  // parsing, multiplication, allocation, the SQL aggregates — so this is the
  // one place that can refuse an amount which has already lost precision
  // rather than let it circulate as a plausible-looking figure.
  //
  // The ceiling is ~90 trillion in a 2-decimal currency, far above any real
  // balance, so this only ever fires on corruption or overflow.
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError(`amountMinor must be a safe integer, got ${amountMinor}.`);
  }
  return { amountMinor, currency };
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

/**
 * Parses a decimal major-unit amount ("10.50", 10.5) into Money. Prefer
 * passing a string at trust boundaries (form input, CSV import) — a
 * JS number literal like 10.1 is already an approximation before this
 * function ever sees it, while the string "10.10" is exact.
 */
export function fromMajorUnits(amount: string | number, currency: CurrencyCode): Money {
  const exponent = minorUnitExponent(currency);
  const text = typeof amount === "number" ? amount.toString() : amount.trim();

  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart, fractionPart = ""] = unsigned.split(".");

  if (!/^\d+$/.test(wholePart) || (fractionPart && !/^\d+$/.test(fractionPart))) {
    throw new TypeError(`Invalid monetary amount: "${amount}".`);
  }

  // Extra precision beyond the currency's minor unit is TRUNCATED, not
  // rounded — "8.165" in a 2-decimal currency becomes 816, never 817.
  //
  // This is deliberate and asserted in src/validation/schemas/money.test.ts,
  // and it is the one operation in this module that does not round half-up.
  // Whether it should is an accounting decision rather than a bug fix
  // (truncation never overstates an amount; half-up matches every other
  // operation here), so it is documented rather than changed. See MON-01 in
  // the hardening report.
  const magnitude = BigInt(wholePart + (fractionPart + "0".repeat(exponent)).slice(0, exponent));
  const signed = negative ? -magnitude : magnitude;

  // Refuses an amount that has already lost precision rather than returning a
  // plausible-looking wrong figure (MON-01).
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError(`Monetary amount "${amount}" is too large to represent exactly.`);
  }

  return money(Number(signed), currency);
}

export function toMajorUnits(value: Money): number {
  return value.amountMinor / 10 ** minorUnitExponent(value.currency);
}

export function format(value: Money, locale = "en-US"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: value.currency,
    currencyDisplay: "symbol",
  }).format(toMajorUnits(value));
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new CurrencyMismatchError(a.currency, b.currency);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function sum(values: Money[], currency: CurrencyCode): Money {
  return values.reduce((total, v) => add(total, v), zero(currency));
}

export function negate(value: Money): Money {
  return money(-value.amountMinor, value.currency);
}

export function abs(value: Money): Money {
  return money(Math.abs(value.amountMinor), value.currency);
}

export function isZero(value: Money): boolean {
  return value.amountMinor === 0;
}

export function isNegative(value: Money): boolean {
  return value.amountMinor < 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/** -1 if a < b, 0 if equal, 1 if a > b. Throws on a currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

/** Rounds a non-negative rational (numerator/denominator) to the nearest
 *  integer, ties rounding away from zero — the conventional rounding rule
 *  for money (as opposed to banker's rounding). Callers pass a signed
 *  numerator; the sign is restored after rounding the magnitude. */
function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const remainder = n % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Multiplies Money by a decimal factor (e.g. a line item quantity like
 * `2.5`), rounding to the nearest minor unit. `factorDecimalPlaces` bounds
 * how many decimal digits `factor` is trusted to have — pass the same
 * precision the source column uses (e.g. 3 for invoice_line_items.quantity)
 * so the scaling stays exact instead of re-introducing float error via
 * `factor * 10 ** n`.
 */
export function multiply(value: Money, factor: number, factorDecimalPlaces = 4): Money {
  const scale = 10 ** factorDecimalPlaces;
  const scaledFactor = BigInt(Math.round(factor * scale));
  const result = divideRoundHalfUp(BigInt(value.amountMinor) * scaledFactor, BigInt(scale));
  return money(Number(result), value.currency);
}

/**
 * Computes `percent`% of an amount (e.g. `percentageOf(vatBase, 19)` for a
 * 19% VAT line). `percent` is trusted to at most 2 decimal places, matching
 * every `numeric(5,2)` rate column in the schema (tax_rate, default_vat_rate).
 */
export function percentageOf(value: Money, percent: number): Money {
  const basisPoints = BigInt(Math.round(percent * 100));
  const result = divideRoundHalfUp(BigInt(value.amountMinor) * basisPoints, 10_000n);
  return money(Number(result), value.currency);
}

/**
 * Splits Money into `ratios.length` parts proportional to `ratios`
 * (e.g. `[1, 1, 1]` for an even three-way split), guaranteeing the parts
 * sum to exactly the original amount — the classic "split $100 three ways"
 * problem, where naive division loses a cent. Computed entirely in BigInt
 * (ratios must be non-negative integers — pass weights like `[1, 1, 1]` or
 * whole-percent shares like `[50, 30, 20]`, not fractions) so there's no
 * float step even internally. Any remainder from flooring is distributed
 * one minor unit at a time, largest exact remainder first.
 */
export function allocate(value: Money, ratios: number[]): Money[] {
  if (ratios.length === 0) throw new RangeError("allocate() requires at least one ratio.");
  if (ratios.some((r) => !Number.isInteger(r) || r < 0)) {
    throw new RangeError("allocate() ratios must be non-negative integers.");
  }

  const ratioTotal = ratios.reduce((a, b) => a + b, 0);
  if (ratioTotal === 0) throw new RangeError("allocate() ratios must not all be zero.");

  const amount = BigInt(value.amountMinor);
  const total = BigInt(ratioTotal);

  const parts = ratios.map((r, index) => {
    const numerator = amount * BigInt(r);
    return { index, floor: numerator / total, remainder: numerator % total };
  });

  const distributed = parts.reduce((sum, p) => sum + p.floor, 0n);
  let remaining = amount - distributed;

  const byRemainderDesc = [...parts].sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : 0));

  const shares = parts.map((p) => p.floor);
  for (const { index } of byRemainderDesc) {
    if (remaining <= 0n) break;
    shares[index] += 1n;
    remaining -= 1n;
  }

  return shares.map((amountMinor) => money(Number(amountMinor), value.currency));
}

export { CURRENCIES };
export type { CurrencyCode };
