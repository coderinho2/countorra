/**
 * AI usage limits.
 *
 * These numbers used to be defined here, in a `PLAN_LIMITS` table that was
 * the only entitlement definition anything actually enforced — while three
 * other definitions of the same plans sat elsewhere, dead and disagreeing.
 * They now live in one canonical model
 * (src/domain/billing/entitlements.ts); this module keeps the two helpers
 * its callers already import, so the AI action, Settings, the pricing page
 * and the upgrade prompt did not all need rewriting to point at a new path.
 *
 * Nothing is defined here any more. If a limit looks wrong, entitlements.ts
 * is the only place it can be wrong.
 */

export { formatAiMessageLimit, getAiMessageLimit } from "./entitlements";

/** The rolling 24h window used for `aiMessagesPerDay` metering. Factored
 *  out so callers (a Server Component, in particular) don't call the
 *  impure `Date.now()` directly in their own render body — React's purity
 *  rule flags that even for async Server Components. */
export function last24HoursIso(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}
