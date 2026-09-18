import { describe, expect, it } from "vitest";
import { RECOVERY_WINDOW_SECONDS, isRecentRecovery, recoveryAuthenticatedAt } from "./password-recovery";

/**
 * The rule that decides whether a verified session may set a password without
 * the current one. See the module header for why each case matters.
 */

const NOW = 1_800_000_000;

describe("which sessions count as recovery", () => {
  it("accepts a session authenticated by recovery moments ago", () => {
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW - 20 }], NOW)).toBe(true);
  });

  it("accepts it right up to the end of the window, and not after", () => {
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW - RECOVERY_WINDOW_SECONDS }], NOW)).toBe(true);
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW - RECOVERY_WINDOW_SECONDS - 1 }], NOW)).toBe(false);
  });

  it("refuses an ordinary password sign-in", () => {
    expect(isRecentRecovery([{ method: "password", timestamp: NOW - 5 }], NOW)).toBe(false);
  });

  it("refuses a session from a sign-up confirmation link", () => {
    expect(isRecentRecovery([{ method: "email/signup", timestamp: NOW - 5 }], NOW)).toBe(false);
  });

  it("refuses a session with no authentication methods at all", () => {
    expect(isRecentRecovery(undefined, NOW)).toBe(false);
    expect(isRecentRecovery([], NOW)).toBe(false);
  });

  it("fails closed on the timestamp-less string form", () => {
    expect(isRecentRecovery(["recovery"], NOW)).toBe(false);
  });

  it("refuses a recovery timestamp from the future beyond clock skew", () => {
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW + 30 }], NOW)).toBe(true);
    expect(isRecentRecovery([{ method: "recovery", timestamp: NOW + 3600 }], NOW)).toBe(false);
  });

  it("uses the most recent recovery when several are recorded", () => {
    const amr = [
      { method: "recovery", timestamp: NOW - 7200 },
      { method: "password", timestamp: NOW - 60 },
      { method: "recovery", timestamp: NOW - 120 },
    ];
    expect(recoveryAuthenticatedAt(amr)).toBe(NOW - 120);
    expect(isRecentRecovery(amr, NOW)).toBe(true);
  });
});
