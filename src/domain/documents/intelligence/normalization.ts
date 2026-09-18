import { fromMajorUnits } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";

/**
 * NORMALIZATION — from what was printed to what can be compared.
 *
 * Every function here keeps the original representation alongside the
 * normalized one, and refuses rather than guesses:
 *
 *   - amounts are parsed from their digits as a decimal STRING and converted
 *     to minor units by `fromMajorUnits`, never through a float;
 *   - a currency is taken only from the document (an ISO code or an
 *     unambiguous symbol) or from a form's own definition — never from the
 *     workspace, and "$" alone is not a currency;
 *   - a date that could be read two ways is not read at all;
 *   - a tax year is taken only from where the document prints one — never
 *     from today's date.
 */

// ── Amounts ─────────────────────────────────────────────────────────────

export interface ParsedAmount {
  /** As written, trimmed. */
  raw: string;
  /** Canonical decimal: optional minus, digits, optional ".dd". */
  decimal: string;
  negative: boolean;
  /** A symbol or code printed with the amount, if any. */
  currencyHint: string | null;
}

/**
 * One amount token: US formatting only — comma thousands, point decimal.
 *
 * "1.234,56" is refused rather than read as 1.23456 or 123456: a document in
 * that convention needs a reader that knows it is in that convention, and a
 * wrong guess moves a figure by a factor of a thousand.
 */
const AMOUNT_TOKEN =
  /(?<![\w.,])(\()?(-)?\s?(US\$|USD|CAD|EUR|GBP|AUD|\$|€|£)?\s?(-)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!\d|[.,]\d)(\))?/g;

export function findAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  for (const match of text.matchAll(AMOUNT_TOKEN)) {
    const [raw, openParen, minusBefore, symbol, minusAfter, digits, closeParen] = match;
    // A bare integer with no decimals and no symbol is as likely to be a box
    // number, a year or a code as an amount. Only formatted numbers count.
    const formatted = digits.includes(".") || digits.includes(",") || Boolean(symbol);
    if (!formatted) continue;
    const negative = Boolean(minusBefore || minusAfter || (openParen && closeParen));
    const plain = digits.replace(/,/g, "");
    out.push({ raw: raw.trim(), decimal: `${negative ? "-" : ""}${plain}`, negative, currencyHint: symbol ?? null });
  }
  return out;
}

export function parseAmount(text: string): ParsedAmount | null {
  const amounts = findAmounts(text);
  return amounts.length === 1 ? amounts[0] : null;
}

/** Minor units, or null when the currency is not known or not supported. */
export function toMinorUnits(decimal: string, currency: string | null): number | null {
  if (!currency || !isSupportedCurrency(currency)) return null;
  try {
    return fromMajorUnits(decimal, currency as CurrencyCode).amountMinor;
  } catch {
    return null;
  }
}

// ── Currency ────────────────────────────────────────────────────────────

const SYMBOL_CURRENCY: Readonly<Record<string, string>> = {
  "US$": "USD",
  USD: "USD",
  CAD: "CAD",
  EUR: "EUR",
  GBP: "GBP",
  AUD: "AUD",
  "€": "EUR",
  "£": "GBP",
};

/**
 * The currency a document states, or null.
 *
 * Returns null — not USD — for "$", which is the symbol of more than twenty
 * currencies, and null when two different currencies appear.
 */
export function detectDocumentCurrency(text: string): string | null {
  const found = new Set<string>();
  for (const match of text.matchAll(/(US\$|\bUSD\b|\bCAD\b|\bEUR\b|\bGBP\b|\bAUD\b|€|£)/g)) {
    const currency = SYMBOL_CURRENCY[match[1]];
    if (currency) found.add(currency);
  }
  if (found.size !== 1) return null;
  const [currency] = [...found];
  return currency;
}

/** A currency hint printed next to one amount. "$" is not a currency. */
export function currencyFromHint(hint: string | null): string | null {
  if (!hint) return null;
  return SYMBOL_CURRENCY[hint] ?? null;
}

// ── Dates ───────────────────────────────────────────────────────────────

export type DateConvention =
  /** US information returns and US payroll documents print month first. */
  | "MONTH_FIRST"
  /** Unknown — a numeric date is read only when it cannot be read two ways. */
  | "UNKNOWN";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

export interface ParsedDate {
  raw: string;
  /** YYYY-MM-DD, or null when the text could be two different dates. */
  iso: string | null;
  ambiguous: boolean;
}

function isoIfReal(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
const NUMERIC_DATE = /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/;
const MONTH_NAME_FIRST = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/;
const DAY_FIRST_NAME = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/;

export function findDate(text: string, convention: DateConvention): ParsedDate | null {
  const iso = text.match(ISO_DATE);
  if (iso) return { raw: iso[0], iso: isoIfReal(Number(iso[1]), Number(iso[2]), Number(iso[3])), ambiguous: false };

  const named = text.match(MONTH_NAME_FIRST);
  if (named && MONTHS[named[1].toLowerCase()]) {
    return { raw: named[0], iso: isoIfReal(Number(named[3]), MONTHS[named[1].toLowerCase()], Number(named[2])), ambiguous: false };
  }
  const dayNamed = text.match(DAY_FIRST_NAME);
  if (dayNamed && MONTHS[dayNamed[2].toLowerCase()]) {
    return { raw: dayNamed[0], iso: isoIfReal(Number(dayNamed[3]), MONTHS[dayNamed[2].toLowerCase()], Number(dayNamed[1])), ambiguous: false };
  }

  const numeric = text.match(NUMERIC_DATE);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const year = Number(numeric[3]);
    if (convention === "MONTH_FIRST") return { raw: numeric[0], iso: isoIfReal(year, first, second), ambiguous: false };
    // Unknown convention: only when one reading is impossible, or both agree.
    const monthFirst = isoIfReal(year, first, second);
    const dayFirst = isoIfReal(year, second, first);
    if (monthFirst && dayFirst && monthFirst !== dayFirst) return { raw: numeric[0], iso: null, ambiguous: true };
    return { raw: numeric[0], iso: monthFirst ?? dayFirst, ambiguous: false };
  }
  return null;
}

// ── Tax year ────────────────────────────────────────────────────────────

export type TaxYearResult = { year: number; ambiguous: false } | { year: null; ambiguous: boolean };

/**
 * The tax year printed on a form: a four-digit year on a line that also
 * carries the form's title, within the first lines of a page.
 *
 * Never today's year, never the upload date, never the most common year in
 * the document.
 */
export function findTaxYear(lines: readonly string[], titlePattern: RegExp, searchLines = 12): TaxYearResult {
  const years = new Set<number>();
  for (const line of lines.slice(0, searchLines)) {
    if (!titlePattern.test(line)) continue;
    for (const match of line.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)) years.add(Number(match[1]));
  }
  // The year is often printed on its own line directly beside the title.
  if (years.size === 0) {
    const titleIndex = lines.slice(0, searchLines).findIndex((line) => titlePattern.test(line));
    if (titleIndex >= 0) {
      for (const line of lines.slice(Math.max(0, titleIndex - 1), titleIndex + 2)) {
        if (/^\s*(20\d{2})\s*$/.test(line)) years.add(Number(line.trim()));
      }
    }
  }
  if (years.size === 1) return { year: [...years][0], ambiguous: false };
  return { year: null, ambiguous: years.size > 1 };
}

// ── Sensitive identifiers ───────────────────────────────────────────────

/** SSN / ITIN layout, with or without separators. Matches the project's
 *  TAX_IDENTIFIER_PATTERN in src/validation/schemas/tax-preparation.ts. */
const SSN_LIKE = /(?<!\d)\d{3}[-\s.]?\d{2}[-\s.]?\d{4}(?!\d)/g;
/** EIN layout: 12-3456789. */
const EIN_LIKE = /(?<!\d)\d{2}-\d{7}(?!\d)/g;
/** Payment card numbers: 13–19 digits, optionally grouped. */
const CARD_LIKE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
/** Any other long digit run — account and routing numbers. */
const LONG_DIGITS = /(?<!\d)\d{7,}(?!\d)/g;

export interface MaskResult {
  text: string;
  masked: boolean;
}

/**
 * Removes identifiers before anything is stored.
 *
 * SSNs and ITINs are replaced completely. Card, account and employer numbers
 * keep their last four digits, the most a statement itself shows. Formatted
 * amounts ("85,000.00") are not digit runs and pass through.
 */
export function maskSensitive(input: string): MaskResult {
  let masked = false;
  let text = input.replace(SSN_LIKE, () => {
    masked = true;
    return "•••-••-••••";
  });
  text = text.replace(EIN_LIKE, (value) => {
    masked = true;
    return `••-•••${value.slice(-4)}`;
  });
  text = text.replace(CARD_LIKE, (value) => {
    const digits = value.replace(/\D/g, "");
    if (digits.length < 13) return value;
    masked = true;
    return `•••• ${digits.slice(-4)}`;
  });
  text = text.replace(LONG_DIGITS, (value) => {
    masked = true;
    return `••••${value.slice(-4)}`;
  });
  return { text, masked };
}

export function containsSsnLike(text: string): boolean {
  return new RegExp(SSN_LIKE.source).test(text);
}

/** Code-point ranges that must never reach storage or a model: C0 and C1
 *  controls, zero-width characters and bidirectional overrides. Expressed as
 *  numbers rather than a regex so no invisible character lives in this file. */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008],
  [0x000b, 0x000c],
  [0x000e, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function isUnsafeCodePoint(codePoint: number): boolean {
  return UNSAFE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/**
 * Text as data: control and invisible characters removed, whitespace
 * collapsed, bounded. Rendering escapes it as text; this makes sure what is
 * stored is also short and printable.
 */
export function sanitizeText(input: string, maxLength = 200): string {
  let kept = "";
  for (const character of input) {
    if (!isUnsafeCodePoint(character.codePointAt(0) ?? 0)) kept += character;
  }
  const cleaned = kept.replace(/\s+/g, " ").trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}
