/**
 * Parses a free-text search string into a structured, typed filter object
 * (product spec §47). This module never builds SQL — its only output is
 * plain data that repositories then apply through parameterized
 * `.eq()/.ilike()/.gte()` calls (see src/server/db/repositories), the same
 * validated-query-builder path every other query in the app uses. That
 * separation is what makes "never concatenate user text into SQL" true
 * here even though the input is unstructured natural language.
 *
 * Deliberately rule-based, not an LLM call: search needs to be instant and
 * deterministic. The AI assistant (src/domain/ai) is the place for
 * genuinely open-ended natural-language questions; this handles the
 * common, fast patterns ("restaurants July", "invoices overdue",
 * "expenses over €500") directly.
 */

export type SearchResourceType = "transaction" | "invoice" | "customer" | "document";

export interface ParsedSearchQuery {
  resourceType: SearchResourceType | null;
  kind: "income" | "expense" | null;
  amountMinMinor: number | null;
  amountMaxMinor: number | null;
  monthStart: string | null; // YYYY-MM-DD
  monthEnd: string | null; // YYYY-MM-DD
  overdueOnly: boolean;
  recurringOnly: boolean;
  /** Whatever free text is left after stripping recognized tokens —
   *  applied as an ILIKE/text-search fallback against merchant name,
   *  description, invoice number, or customer name depending on
   *  `resourceType`. */
  freeText: string;
}

const RESOURCE_KEYWORDS: Record<string, SearchResourceType> = {
  invoice: "invoice",
  invoices: "invoice",
  customer: "customer",
  customers: "customer",
  client: "customer",
  clients: "customer",
  document: "document",
  documents: "document",
  receipt: "document",
  receipts: "document",
  bill: "document",
  bills: "document",
  transaction: "transaction",
  transactions: "transaction",
  payment: "transaction",
  payments: "transaction",
};

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const CURRENCY_SYMBOLS = ["€", "$", "£", "lei", "ron", "eur", "usd", "gbp"];

function stripCurrencySymbols(text: string): string {
  let result = text;
  for (const symbol of CURRENCY_SYMBOLS) {
    result = result.split(symbol).join(" ");
  }
  return result;
}

/** Date-only math, done entirely in UTC — `new Date(y, m, d).toISOString()`
 *  would silently shift by a day for any timezone behind UTC, since the
 *  Date is constructed in local time but serialized in UTC. */
function isoDateUTC(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

function monthRange(monthIndex: number, referenceDate: Date, explicitYear?: number): { start: string; end: string } {
  const year = explicitYear ?? referenceDate.getUTCFullYear();
  // If the named month hasn't happened yet this year, assume last year's
  // occurrence — "July" asked for in March means the July that already
  // happened, not five months from now. An explicit year overrides this
  // entirely (the user said what they meant).
  const resolvedYear = explicitYear === undefined && monthIndex > referenceDate.getUTCMonth() ? year - 1 : year;
  return { start: isoDateUTC(resolvedYear, monthIndex, 1), end: isoDateUTC(resolvedYear, monthIndex + 1, 0) };
}

export function parseSearchQuery(rawQuery: string, referenceDate: Date = new Date()): ParsedSearchQuery {
  let remaining = ` ${rawQuery.trim().toLowerCase()} `;

  let resourceType: SearchResourceType | null = null;
  let kind: "income" | "expense" | null = null;
  let amountMinMinor: number | null = null;
  let amountMaxMinor: number | null = null;
  let monthStart: string | null = null;
  let monthEnd: string | null = null;
  let overdueOnly = false;
  let recurringOnly = false;

  const consume = (pattern: RegExp) => {
    const match = remaining.match(pattern);
    if (match) remaining = remaining.replace(pattern, " ");
    return match;
  };

  // Amount comparisons: "over €500", "above 500", "more than $1,000"
  const overMatch = consume(/\b(over|above|more than|greater than)\s+[€$£]?\s?([\d,]+(?:\.\d+)?)\s*(?:lei|ron|eur|usd|gbp)?\b/);
  if (overMatch) amountMinMinor = Math.round(parseFloat(overMatch[2].replace(/,/g, "")) * 100);

  const underMatch = consume(/\b(under|below|less than)\s+[€$£]?\s?([\d,]+(?:\.\d+)?)\s*(?:lei|ron|eur|usd|gbp)?\b/);
  if (underMatch) amountMaxMinor = Math.round(parseFloat(underMatch[2].replace(/,/g, "")) * 100);

  // Overdue
  if (consume(/\boverdue\b/)) overdueOnly = true;

  // Recurring / subscriptions
  if (consume(/\b(recurring|subscriptions?)\b/)) recurringOnly = true;

  // income / expense
  if (consume(/\bincome\b/)) kind = "income";
  if (consume(/\b(expenses?|spending|spent)\b/)) kind = "expense";

  // Resource type keyword
  for (const [keyword, type] of Object.entries(RESOURCE_KEYWORDS)) {
    const match = consume(new RegExp(`\\b${keyword}\\b`));
    if (match) {
      resourceType = type;
      break;
    }
  }

  // Month name, optionally followed by a 4-digit year
  for (let i = 0; i < MONTH_NAMES.length; i++) {
    const monthPattern = new RegExp(`\\b${MONTH_NAMES[i]}(?:\\s+(\\d{4}))?\\b`);
    const match = remaining.match(monthPattern);
    if (match) {
      remaining = remaining.replace(monthPattern, " ");
      const range = monthRange(i, referenceDate, match[1] ? Number(match[1]) : undefined);
      monthStart = range.start;
      monthEnd = range.end;
      break;
    }
  }

  // Any remaining bare currency amount (no over/under) is treated as an
  // approximate filter — skipped here deliberately: an unqualified number
  // is ambiguous (could be an amount, an invoice number, a date) and is
  // left in freeText for a plain substring match instead of guessing.

  const freeText = stripCurrencySymbols(remaining).replace(/\s+/g, " ").trim();

  return {
    resourceType,
    kind,
    amountMinMinor,
    amountMaxMinor,
    monthStart,
    monthEnd,
    overdueOnly,
    recurringOnly,
    freeText,
  };
}
