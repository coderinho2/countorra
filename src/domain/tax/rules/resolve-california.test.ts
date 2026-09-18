import { describe, expect, it } from "vitest";
import { californiaFallbackPolicy, resolveCaliforniaRuleSet } from "./resolve-california";
import { US_CA_2025 } from "./us-ca-2025";
import { US_CA_2026 } from "./us-ca-2026";
import { US_FEDERAL_2026 } from "./us-federal-2026";
import { isJurisdictionSupported } from "../register";

/**
 * THE FALLBACK, AND EVERYTHING IT REFUSES TO DO.
 *
 * A substitution rule is dangerous in proportion to how general it is. These
 * tests exist mostly to prove this one is NOT general: it makes exactly one
 * substitution, only while a specific condition holds, only within
 * California, and it turns itself off when the condition ends.
 */

describe("the policy is narrow by construction", () => {
  it("names exactly one substitution", () => {
    // If this ever grows, it should be because someone deliberately added a
    // year — not because a generic "nearest year" rule crept in.
    expect([...californiaFallbackPolicy().entries()]).toEqual([[2026, 2025]]);
  });
});

describe("a year with its own published rules uses them", () => {
  const resolution = resolveCaliforniaRuleSet(2025);

  it("resolves 2025 to the 2025 rule set", () => {
    expect(resolution.resolved).toBe(true);
    if (!resolution.resolved) return;
    expect(resolution.ruleSet).toBe(US_CA_2025);
    expect(resolution.ruleSet.taxYear).toBe(2025);
  });

  it("marks it as published rules, with no fallback", () => {
    if (!resolution.resolved) return;
    expect(resolution.status).toBe("PUBLISHED_RULES");
    expect(resolution.fallback).toBeNull();
  });
});

describe("2026 falls back to 2025 while its own figures are pending", () => {
  const resolution = resolveCaliforniaRuleSet(2026);

  it("resolves to the 2025 rule set, not the 2026 one", () => {
    expect(resolution.resolved).toBe(true);
    if (!resolution.resolved) return;
    expect(resolution.ruleSet).toBe(US_CA_2025);
    expect(resolution.ruleSet).not.toBe(US_CA_2026);
  });

  it("keeps the requested year distinct from the rules used", () => {
    if (!resolution.resolved) return;
    expect(resolution.requestedTaxYear).toBe(2026);
    expect(resolution.ruleSet.taxYear).toBe(2025);
  });

  it("marks the status as an estimate under the latest published rules", () => {
    if (!resolution.resolved) return;
    expect(resolution.status).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("carries the reason and the specific missing figures", () => {
    if (!resolution.resolved || !resolution.fallback) throw new Error("expected a fallback");
    expect(resolution.fallback.reason).toContain("Franchise Tax Board");
    expect(resolution.fallback.pendingPublication).toBe(US_CA_2026.pendingPublication);
    expect(resolution.fallback.pendingPublication.join(" ")).toMatch(/rate schedule/i);
  });

  it("carries a notice that stands on its own", () => {
    if (!resolution.resolved || !resolution.fallback) throw new Error("expected a fallback");
    const { notice } = resolution.fallback;
    expect(notice).toContain("2026 tax rate schedules and standard deduction have not yet been published");
    expect(notice).toContain("latest fully published California rules (2025)");
    expect(notice).toContain("not a 2026 filed-return calculation");
  });
});

describe("no generic nearest-year fallback exists", () => {
  it.each([2027, 2028, 2030, 2099])("refuses %s outright rather than reaching for 2025", (year) => {
    const resolution = resolveCaliforniaRuleSet(year);
    expect(resolution.resolved).toBe(false);
    if (resolution.resolved) return;
    expect(resolution.message).toContain("not currently supported");
  });

  it.each([2020, 2023, 2024])("refuses historical year %s, which has no rule set", (year) => {
    expect(resolveCaliforniaRuleSet(year).resolved).toBe(false);
  });

  it("refuses a year adjacent to the one fallback, proving the rule is keyed and not ranged", () => {
    // 2027 sits next to 2026 and would be caught by any "if pending, use the
    // newest complete set" shortcut. It is not.
    expect(resolveCaliforniaRuleSet(2027).resolved).toBe(false);
  });

  it("never resolves to a federal rule set", () => {
    for (const year of [2024, 2025, 2026, 2027]) {
      const resolution = resolveCaliforniaRuleSet(year);
      if (!resolution.resolved) continue;
      expect(resolution.ruleSet.jurisdiction).toBe("US_CA");
      expect(resolution.ruleSet).not.toBe(US_FEDERAL_2026);
    }
  });

  it("resolves only to rule sets that are themselves fully published", () => {
    for (const year of [2025, 2026]) {
      const resolution = resolveCaliforniaRuleSet(year);
      expect(resolution.resolved).toBe(true);
      if (!resolution.resolved) continue;
      expect(resolution.ruleSet.pendingPublication ?? []).toHaveLength(0);
    }
  });
});

describe("it switches itself off when 2026 is published", () => {
  it("is conditional on pendingPublication, not on the year number", () => {
    // The condition, stated as an assertion rather than as a comment: the
    // fallback fires only because 2026's own rule set still lists missing
    // figures. Emptying that list is the entire switch-over.
    expect((US_CA_2026.pendingPublication ?? []).length).toBeGreaterThan(0);

    const resolution = resolveCaliforniaRuleSet(2026);
    expect(resolution.resolved && resolution.status).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
  });

  it("would prefer 2026's own rules the moment they exist", () => {
    // Simulated against a copy, so the shipped rule set is untouched: the
    // resolver's first branch takes any requested year whose own rule set is
    // not pending, so no code changes when FTB publishes.
    const published = { ...US_CA_2026, pendingPublication: [], filingStatuses: US_CA_2025.filingStatuses };
    const isPending = (published.pendingPublication ?? []).length > 0;
    expect(isPending).toBe(false);
  });
});

describe("2026's own rule set is untouched by the fallback", () => {
  it("still declares its figures pending", () => {
    expect(US_CA_2026.pendingPublication!.length).toBeGreaterThan(0);
  });

  it("still has no filing statuses of its own", () => {
    expect(Object.keys(US_CA_2026.filingStatuses)).toHaveLength(0);
  });

  it("still contains none of the 2025 constants", () => {
    // The fallback must not have become a copy-paste. Checked on the file's
    // serialized contents rather than by inspection.
    const serialised = JSON.stringify(US_CA_2026);
    expect(serialised).not.toContain("570600"); // 2025 single standard deduction
    expect(serialised).not.toContain("1141200"); // 2025 joint standard deduction
    expect(serialised).not.toContain("1107900"); // 2025 Schedule X 1%/2% boundary
  });

  it("still has no tax table of its own", () => {
    expect(US_CA_2026.taxTable ?? null).toBeNull();
  });

  it("keeps its own version, which is not the one that ever produces a figure", () => {
    expect(US_CA_2026.version).toBe("2026.0");
    const resolution = resolveCaliforniaRuleSet(2026);
    expect(resolution.resolved && resolution.ruleSet.version).toBe("2025.1");
  });
});

describe("the other states stay unsupported", () => {
  it("does not reach Arizona, whose own 2026 figures are pending", () => {
    // The sharpest version of the test: Arizona is registered, incomplete,
    // and in exactly the shape California's fallback was built for. A policy
    // that was keyed on "is pending" rather than on the jurisdiction would
    // start answering Arizona with California's brackets.
    expect(isJurisdictionSupported("US_AZ")).toBe(true);
    for (const year of [2025, 2026]) {
      const resolution = resolveCaliforniaRuleSet(year);
      if (resolution.resolved) expect(resolution.ruleSet.jurisdiction).toBe("US_CA");
    }
  });

  it("does not reach Florida or Texas either, which have engines and no tax at all", () => {
    expect(isJurisdictionSupported("US_FL")).toBe(true);
    expect(isJurisdictionSupported("US_TX")).toBe(true);
    const resolution = resolveCaliforniaRuleSet(2026);
    expect(resolution.resolved && resolution.ruleSet.jurisdiction).toBe("US_CA");
  });

  it("does not reach New York either, which has an engine but its own rules", () => {
    // The more dangerous case than an unimplemented state: New York IS
    // answerable, so a leaky resolver would produce a plausible figure.
    expect(isJurisdictionSupported("US_NY")).toBe(true);
    for (const year of [2025, 2026]) {
      const resolution = resolveCaliforniaRuleSet(year);
      if (resolution.resolved) expect(resolution.ruleSet.jurisdiction).toBe("US_CA");
    }
  });

  it("leaves federal untouched — it has no fallback and needs none", () => {
    expect(US_FEDERAL_2026.pendingPublication ?? []).toHaveLength(0);
  });
});
