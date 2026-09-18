/**
 * Supported currencies. Adding one is a one-line change here — nothing
 * elsewhere in src/domain/money hardcodes a currency, only the minor-unit
 * exponent this table provides (DESIGN principle: don't hardcode EUR
 * everywhere).
 */
export const CURRENCIES = {
  EUR: { code: "EUR", minorUnitExponent: 2, name: "Euro" },
  RON: { code: "RON", minorUnitExponent: 2, name: "Romanian Leu" },
  USD: { code: "USD", minorUnitExponent: 2, name: "US Dollar" },
  GBP: { code: "GBP", minorUnitExponent: 2, name: "British Pound" },
} as const;

export type CurrencyCode = keyof typeof CURRENCIES;

export function isSupportedCurrency(value: string): value is CurrencyCode {
  return value in CURRENCIES;
}

export function minorUnitExponent(currency: CurrencyCode): number {
  return CURRENCIES[currency].minorUnitExponent;
}
