import type { Money } from "./money";

/**
 * How a monetary figure is signed on screen.
 *
 * `undefined` — just the figure. Correct for a balance or a total, where a
 *   leading "+" would read as a delta rather than as a level.
 * `"auto"` — sign both directions. Correct for a movement or a change.
 * `"positive"` / `"negative"` — force the sign regardless of how the amount
 *   happens to be stored. Transaction amounts are stored unsigned with a
 *   separate `kind`, so an expense row asks for "negative" even though its
 *   `amountMinor` is positive.
 * `"none"` — no sign at all. Only correct where direction genuinely does not
 *   apply, such as a transfer between the user's own accounts.
 */
export type SignMode = "auto" | "positive" | "negative" | "none";

/**
 * Returns the sign glyph to prefix a formatted amount with.
 *
 * The load-bearing rule is the first one: **a negative amount is always
 * signed**, whatever the caller asked for. This was originally the other way
 * round — with no `sign` prop the minus was stripped along with the plus —
 * and a credit-card balance of −$13,274.40 rendered as "$13,274.40" in red.
 * Colour was then the only thing saying it was negative, which DESIGN.md §24
 * rules out, and a reader who does not register the colour reads the exact
 * opposite of the truth. In an accounting product that is not a styling bug.
 *
 * U+2212 MINUS SIGN, not a hyphen: in a column of Geist Mono tabular figures
 * a hyphen is visibly shorter and narrower than the digits it sits against,
 * so a column of negative amounts stops lining up.
 */
export function amountSign(value: Money, mode?: SignMode): "" | "+" | "−" {
  if (mode === "none") return "";
  if (mode === "negative" || value.amountMinor < 0) return "−";
  if (mode === "positive" || (mode === "auto" && value.amountMinor > 0)) return "+";
  return "";
}
