import { describe, expect, it } from "vitest";
import { resolvableJurisdictions, resolveRulesFor } from "./resolve";
import type { TaxJurisdiction } from "./types";

/**
 * The resolver dispatch.
 *
 * Its whole job is to tell a caller, before any figures exist, whether a
 * jurisdiction will answer with its own published rules, with a disclosed
 * estimate, or not at all. The test that matters most is that California and
 * Arizona — which both carry a `pendingPublication` list for 2026 — come out
 * on opposite sides of that line.
 */

const EVERY_JURISDICTION: readonly TaxJurisdiction[] = ["US_FEDERAL", "US_CA", "US_NY", "US_FL", "US_TX", "US_AZ"];

describe("coverage", () => {
  it("can answer for every jurisdiction the type allows", () => {
    // A state added to TaxJurisdiction without a resolver here would make
    // the preparation layer throw on the collection screen.
    expect([...resolvableJurisdictions()].sort()).toEqual([...EVERY_JURISDICTION].sort());
  });
});

describe("2026", () => {
  it("answers federal with its own published rules", () => {
    const resolution = resolveRulesFor("US_FEDERAL", 2026);
    expect(resolution.resolved).toBe(true);
    if (resolution.resolved) {
      expect(resolution.status).toBe("PUBLISHED_RULES");
      expect(resolution.fallback).toBeNull();
    }
  });

  it("answers California with a disclosed estimate under 2025 rules", () => {
    const resolution = resolveRulesFor("US_CA", 2026);
    expect(resolution.resolved).toBe(true);
    if (resolution.resolved) {
      expect(resolution.status).toBe("ESTIMATE_USING_LATEST_PUBLISHED_RULES");
      expect(resolution.ruleSet.taxYear).toBe(2025);
      expect(resolution.fallback?.notice).toMatch(/not a 2026 filed-return calculation/);
    }
  });

  it("refuses Arizona, naming what is unpublished", () => {
    const resolution = resolveRulesFor("US_AZ", 2026);
    // Arizona has no sanctioned fallback. Whatever the preparation layer
    // shows, it must not be an estimate.
    expect(resolution.resolved).toBe(false);
    if (!resolution.resolved) {
      expect(resolution.details?.length).toBeGreaterThan(0);
    }
  });

  it("answers New York, Florida and Texas with their own 2026 rules", () => {
    for (const jurisdiction of ["US_NY", "US_FL", "US_TX"] as const) {
      const resolution = resolveRulesFor(jurisdiction, 2026);
      expect(resolution.resolved, jurisdiction).toBe(true);
      if (resolution.resolved) expect(resolution.status, jurisdiction).toBe("PUBLISHED_RULES");
    }
  });
});

describe("years nobody modelled", () => {
  it("refuses every jurisdiction for a far-future year rather than reaching for the nearest one", () => {
    for (const jurisdiction of EVERY_JURISDICTION) {
      expect(resolveRulesFor(jurisdiction, 2031).resolved, jurisdiction).toBe(false);
    }
  });

  it("gives federal no substitution policy at all", () => {
    // Federal 2025 is not modelled. It must be refused, not answered with 2026.
    expect(resolveRulesFor("US_FEDERAL", 2025).resolved).toBe(false);
  });
});
