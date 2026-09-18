import { z } from "zod";
import { isSupportedCurrency } from "@/domain/money/currency";

/**
 * Currency validation, shared by every schema that accepts one.
 *
 * `z.string().length(3)` was not validation: any three characters passed,
 * so "XYZ" could be stored on an account, a transaction or an invoice. The
 * damage isn't at write time — it's at read time. Everything that
 * aggregates money (src/domain/financial/calculation-engine via
 * `getTransactionTotals`, which drops an unrecognized code rather than
 * folding it into another currency's total, and
 * `sum()`, which throws `CurrencyMismatchError` across two different ones)
 * refuses to compute over a row it can't reason about. One bad row
 * therefore takes down the dashboard, every reporting page and every
 * `calculate`-mode AI tool for the WHOLE organization, for everyone in it,
 * permanently — a durable denial of service that any write-capable member
 * could plant in a single request. Rejecting the code at the boundary is
 * the fix; the strict behaviour downstream is correct and stays.
 */
export const currencySchema = z
  .string()
  .length(3)
  .transform((value) => value.toUpperCase())
  .refine(isSupportedCurrency, "That currency isn't supported yet.");

/** A plain, non-negative decimal amount in MAJOR units, as a string.
 *  Deliberately not a number: JSON numbers are floats before we ever see
 *  them. Converted with `fromMajorUnits` (src/domain/money), never
 *  `parseFloat(x) * 100`. */
export const majorAmountSchema = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, "Amount must be a plain decimal like 10.50");
