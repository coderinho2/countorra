import { describe, expect, it } from "vitest";
import { getAiMessageLimit, formatAiMessageLimit, last24HoursIso } from "./limits";
import { PLAN_ENTITLEMENTS, PLAN_TIERS } from "./entitlements";

/**
 * `limits.ts` defines nothing — it re-exports the canonical helpers so the
 * AI action, Settings and the pricing page did not all need rewriting when
 * the model moved. These tests exist to prove the re-export still resolves to
 * the same numbers, which is the only way the shim could go wrong.
 */
describe("plan limits", () => {
  it("gives every plan tier a finite AI message limit", () => {
    expect(PLAN_ENTITLEMENTS.free.aiMessagesPerDay).toBe(3);
    expect(PLAN_ENTITLEMENTS.premium.aiMessagesPerDay).toBe(100);
    expect(PLAN_ENTITLEMENTS.business.aiMessagesPerDay).toBe(500);
  });

  it("orders the tiers, with no unlimited tier at the top", () => {
    expect(getAiMessageLimit("free")).toBeLessThan(getAiMessageLimit("premium"));
    expect(getAiMessageLimit("premium")).toBeLessThan(getAiMessageLimit("business"));
    for (const tier of PLAN_TIERS) expect(Number.isFinite(getAiMessageLimit(tier)), tier).toBe(true);
  });

  it("formats every limit as '<n>/day', since none is unlimited", () => {
    expect(formatAiMessageLimit("free")).toBe("3/day");
    expect(formatAiMessageLimit("premium")).toBe("100/day");
    expect(formatAiMessageLimit("business")).toBe("500/day");
  });

  it("re-exports the canonical helpers rather than defining its own", () => {
    for (const tier of PLAN_TIERS) {
      expect(getAiMessageLimit(tier), tier).toBe(PLAN_ENTITLEMENTS[tier].aiMessagesPerDay);
    }
  });

  it("meters a rolling 24 hours, not a calendar day", () => {
    // A calendar reset lets someone spend a full allowance at 23:59 and
    // another at 00:01. The window slides instead.
    const elapsed = Date.now() - Date.parse(last24HoursIso());
    expect(elapsed).toBeGreaterThan(23.9 * 60 * 60 * 1000);
    expect(elapsed).toBeLessThan(24.1 * 60 * 60 * 1000);
  });
});
