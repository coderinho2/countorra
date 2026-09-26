import type { PlanTier } from "@/types/database";

/**
 * WHO MAY SET A TEST PLAN, AND WHAT A TEST PLAN IS.
 *
 * Pure: no database, no session, no environment read. It decides, from values
 * a caller supplies, whether a person is a developer of this deployment. The
 * server module beside it supplies those values and does the rest.
 *
 * THE PROBLEM THIS SOLVES
 *
 * Bank connections, document OCR and the assistant's allowance are Premium
 * and Business features. That is correct, and it means the features most
 * worth testing cannot be reached on the deployment they run on without
 * completing a real payment first.
 *
 * WHAT IT IS NOT
 *
 * Not a change to the Free tier — Free is exactly what it was, for everyone.
 * Not a fake subscription — `subscriptions` is Stripe's table and nothing
 * here writes to it. Not a client-side flag — no query parameter, no cookie
 * the browser can set, no React state and no form field reaches this
 * decision. The two inputs are the session's CONFIRMED email, read
 * server-side from Supabase, and a list that exists only in the deployment's
 * environment.
 *
 * OFF UNLESS DELIBERATELY TURNED ON
 *
 * `DEVELOPER_ACCOUNTS` unset — the default, and the state of every deployment
 * that has not been configured for this — means `developerAccounts()` is
 * empty and `isDeveloperAccount` answers false for everybody. There is no
 * override mechanism at all on such a deployment, whatever rows exist.
 */

/** The plans a test override may name. The same tiers the product sells —
 *  `free` included, because forcing Free onto a paid workspace is how the
 *  restrictions get tested without cancelling a real subscription. */
export const DEVELOPER_PLAN_TIERS: readonly PlanTier[] = ["free", "premium", "business"];

export function isDeveloperPlanTier(value: string): value is PlanTier {
  return (DEVELOPER_PLAN_TIERS as readonly string[]).includes(value);
}

/**
 * The configured developer accounts, normalized.
 *
 * Comma-separated, whitespace tolerated, case-insensitive — an operator
 * typing `Armin@Example.com, other@example.com ` gets what they meant.
 * Entries that are not email-shaped are dropped rather than trusted: a
 * malformed list must not widen access, and a stray comma must not produce an
 * empty entry that matches an empty email.
 */
export function developerAccounts(configured: string | undefined | null): readonly string[] {
  if (!configured) return [];
  return [
    ...new Set(
      configured
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0 && entry.includes("@") && !entry.startsWith("@") && !entry.endsWith("@")),
    ),
  ];
}

export interface DeveloperCandidate {
  /** The session's email, as Supabase reports it server-side. */
  email: string | null | undefined;
  /**
   * Whether Supabase has confirmed that address.
   *
   * Required, and not a formality: an unconfirmed signup can claim any
   * address in the world. Without this check, anybody could register
   * `<a-developer>@example.com`, never open the mailbox, and be treated as a
   * developer on the strength of a string they typed.
   */
  emailConfirmed: boolean;
}

/** Whether this session belongs to a developer of this deployment. */
export function isDeveloperAccount(candidate: DeveloperCandidate, accounts: readonly string[]): boolean {
  if (accounts.length === 0) return false;
  if (!candidate.emailConfirmed) return false;
  const email = candidate.email?.trim().toLowerCase();
  if (!email) return false;
  return accounts.includes(email);
}

/** Where an effective plan came from. Shown to the person, so a test plan is
 *  never mistaken for a purchase. */
export type PlanSource = "subscription" | "developer_override";

export const DEVELOPER_OVERRIDE_LABEL = "Test override";

/** e.g. "Premium — Test override". Used wherever a plan name is displayed. */
export function planLabelWithSource(planName: string, source: PlanSource): string {
  return source === "developer_override" ? `${planName} — ${DEVELOPER_OVERRIDE_LABEL}` : planName;
}
