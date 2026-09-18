import { describe, expect, it } from "vitest";
import { newYorkFallbackPolicy, resolveNewYorkRuleSet } from "./resolve-new-york";
import { resolveCaliforniaRuleSet } from "./resolve-california";
import { US_NY_2026 } from "./us-ny-2026";
import { US_CA_2025 } from "./us-ca-2025";
import { US_FEDERAL_2026 } from "./us-federal-2026";

/**
 * NEW YORK'S RESOLVER, AND THE FALLBACK IT DELIBERATELY DOES NOT HAVE.
 *
 * New York published its complete 2026 figures, so there is nothing to fall
 * back from. The interesting assertions here are all negative: that an empty
 * policy stays empty, that no other jurisdiction's rules can be reached
 * through it, and that a year New York has not published is refused rather
 * than answered with the one year that exists.
 */

describe("the policy is empty, and that is a statement", () => {
  it("makes no substitutions at all", () => {
    // California needs one entry. New York needs none. Copying California's
    // policy across would have made a future incomplete year silently borrow.
    expect([...newYorkFallbackPolicy().entries()]).toEqual([]);
  });
});

describe("2026 uses New York's own published 2026 rules", () => {
  const resolution = resolveNewYorkRuleSet(2026);

  it("resolves to the 2026 rule set", () => {
    expect(resolution.resolved).toBe(true);
    if (!resolution.resolved) return;
    expect(resolution.ruleSet).toBe(US_NY_2026);
    expect(resolution.ruleSet.taxYear).toBe(2026);
    expect(resolution.ruleSet.version).toBe("2026.1");
  });

  it("reports PUBLISHED_RULES with no fallback", () => {
    if (!resolution.resolved) return;
    expect(resolution.status).toBe("PUBLISHED_RULES");
    expect(resolution.fallback).toBeNull();
  });

  it("keeps the requested year and the rule-set year the same", () => {
    if (!resolution.resolved) return;
    expect(resolution.requestedTaxYear).toBe(2026);
    expect(resolution.ruleSet.taxYear).toBe(resolution.requestedTaxYear);
  });
});

describe("no silent fallback anywhere", () => {
  it.each([2020, 2023, 2024, 2025, 2027, 2028, 2030, 2099])("refuses %s outright", (year) => {
    const resolution = resolveNewYorkRuleSet(year);
    expect(resolution.resolved).toBe(false);
    if (resolution.resolved) return;
    expect(resolution.message).toContain("New York");
    expect(resolution.message).toContain("not currently supported");
  });

  it("refuses 2025 even though 2026 exists — the nearest year is not a fallback", () => {
    // The single most tempting wrong behaviour: New York has exactly one
    // rule set, so a lenient resolver would hand it to every request.
    expect(resolveNewYorkRuleSet(2025).resolved).toBe(false);
  });

  it("never resolves to California's or the federal rule set", () => {
    for (const year of [2024, 2025, 2026, 2027]) {
      const resolution = resolveNewYorkRuleSet(year);
      if (!resolution.resolved) continue;
      expect(resolution.ruleSet.jurisdiction).toBe("US_NY");
      expect(resolution.ruleSet).not.toBe(US_CA_2025);
      expect(resolution.ruleSet).not.toBe(US_FEDERAL_2026);
    }
  });

  it("resolves only to a rule set that is itself fully published", () => {
    const resolution = resolveNewYorkRuleSet(2026);
    expect(resolution.resolved).toBe(true);
    if (!resolution.resolved) return;
    expect(resolution.ruleSet.pendingPublication ?? []).toHaveLength(0);
  });
});

describe("the two resolvers stay independent", () => {
  it("California's fallback does not apply to New York", () => {
    // Both share branch logic. If the policy were shared too, a 2026 New York
    // request would start resolving to California 2025.
    const ny = resolveNewYorkRuleSet(2026);
    const ca = resolveCaliforniaRuleSet(2026);
    expect(ny.resolved && ny.ruleSet.jurisdiction).toBe("US_NY");
    expect(ca.resolved && ca.ruleSet.jurisdiction).toBe("US_CA");
    expect(ny.resolved && ny.status).toBe("PUBLISHED_RULES");
    expect(ca.resolved && ca.status).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("New York has no 2025 while California does, and neither leaks into the other", () => {
    expect(resolveNewYorkRuleSet(2025).resolved).toBe(false);
    expect(resolveCaliforniaRuleSet(2025).resolved).toBe(true);
  });
});

describe("if a future New York year is ever incomplete", () => {
  it("would refuse rather than borrow, because the policy is opt-in", () => {
    // Asserted on the mechanism rather than simulated: an incomplete year is
    // one with `pendingPublication`, and with no policy entry the shared
    // resolver's third branch has nowhere to go. 2027 stands in for that
    // case today — it has no rule set at all and is refused.
    expect(newYorkFallbackPolicy().size).toBe(0);
    expect(resolveNewYorkRuleSet(2027).resolved).toBe(false);
  });
});
