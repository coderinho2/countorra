/**
 * Provider cost protection — deliberately NOT a product entitlement.
 *
 * "How much may the customer use" and "how much may one request cost us" are
 * different questions, and only the first is a product decision. They are
 * separated here:
 *
 *   PRODUCT ENTITLEMENT  — how many messages a plan allows per day. Lives in
 *                          entitlements.ts. Advertised on the pricing page.
 *                          Every tier now has a finite number, Business
 *                          included; there is no unlimited tier.
 *
 *   PROVIDER PROTECTION  — how many billed provider calls a SINGLE message
 *                          can produce. Lives here. Operational, not
 *                          advertised, and not a tier feature.
 *
 * The two multiply. A tier's worst-case daily provider cost is
 * `aiMessagesPerDay * maxProviderCallsPerMessage()`, which is now a bounded
 * number on every plan — it was unbounded on Business for as long as that
 * tier's allowance was `null`, because the daily meter skipped a null limit
 * entirely rather than treating it as a high ceiling.
 *
 * WHAT THIS FILE DOES AND DOES NOT DO
 *
 * It defines the structural bounds, which are facts about the code rather
 * than numbers anyone has to choose:
 *
 *   - a single request makes at most `MAX_PROVIDER_CALLS_PER_REQUEST`
 *     provider calls, because `AIService.respond` iterates to a fixed bound
 *     and offers no tools on the last turn — it is a bounded loop, never an
 *     open-ended agent loop;
 *   - each of those carries at most `MAX_RETRIES_PER_CALL` retries, set
 *     explicitly on the SDK client;
 *   - so one message can cost at most `maxProviderCallsPerMessage()` billed
 *     requests, and that is a bound the code guarantees rather than a limit
 *     someone configured.
 *
 * It does NOT define a daily token or spend ceiling. Choosing that number is
 * a product and finance decision — it depends on the Business price, the
 * expected messages per seat, and what should happen when a customer crosses
 * it (throttle? alert? keep serving and absorb it?). Inventing one here would
 * put a silent cap on a tier sold as unlimited, which is the failure this
 * separation exists to prevent. The measurement needed to make that decision
 * is now recorded on every request (`ai_usage`), so the number can be chosen
 * from real data instead of guessed.
 */

/**
 * Model turns per user message. Raised from 2 to 3 by AI-03, which replaced
 * the fixed round-one-with-tools / round-two-without with a bounded loop.
 *
 * Three is the smallest number that answers the question the first live test
 * failed on: resolve "this month" into a date range, compute over that range,
 * then explain the result. Two made that impossible; more than three buys
 * little and multiplies the bill.
 *
 * This is not advisory. `AIService.respond` iterates to exactly this bound and
 * offers NO tools on the final turn, so the loop terminates because of the
 * request we send rather than because the model chose to stop.
 */
export const MAX_PROVIDER_CALLS_PER_REQUEST = 3;

/** Set explicitly on the Anthropic client
 *  (src/domain/ai/providers/anthropic.ts). Stated here too so the total cost
 *  of one message can be reasoned about in one place. */
export const MAX_RETRIES_PER_CALL = 1;

/** The worst case number of BILLED provider requests one user message can
 *  produce. Retries are attempts beyond the first, so each call is at most
 *  `1 + MAX_RETRIES_PER_CALL` requests. AI-03 moved this from 4 to 6; the
 *  number is stated rather than left implicit precisely because it is what
 *  multiplies if either input grows. */
export function maxProviderCallsPerMessage(): number {
  return MAX_PROVIDER_CALLS_PER_REQUEST * (1 + MAX_RETRIES_PER_CALL);
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** How many times the provider was actually called for one user message.
   *  Recorded rather than assumed, so the structural bound above is
   *  observable in production and not just in a test. */
  providerCalls: number;
}

export const ZERO_USAGE: ProviderUsage = { inputTokens: 0, outputTokens: 0, providerCalls: 0 };

export function addUsage(a: ProviderUsage, b: { inputTokens: number; outputTokens: number }): ProviderUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    providerCalls: a.providerCalls + 1,
  };
}

/** Whether a recorded request exceeded what the code is supposed to allow.
 *  A true here means a bug — an added round, a retry loop, a re-entrant call
 *  — not a customer using the product too much. */
export function exceedsStructuralBound(usage: ProviderUsage): boolean {
  return usage.providerCalls > MAX_PROVIDER_CALLS_PER_REQUEST;
}
