import { describe, expect, it } from "vitest";
import { sameJurisdictions, withAuthoritativeState } from "./jurisdiction";
import type { TaxpayerProfile } from "./types";

/**
 * Regression tests for the stale-state bug seen live: a workspace moved from
 * CA to AZ in Settings, and its open preparation case kept calculating
 * California.
 */

const TAXPAYER: TaxpayerProfile = {
  legalFirstName: "Test",
  legalMiddleName: null,
  legalLastName: "Taxpayer",
  dateOfBirth: "1985-04-12",
  taxIdentifierType: null,
  taxIdentifierOnFile: false,
  primaryStateRegion: "CA",
  additionalStateRegions: ["NY"],
  spouseFirstName: null,
  spouseLastName: null,
  spouseDateOfBirth: null,
  spouseTaxIdentifierOnFile: false,
  spouseItemizesDeductions: null,
};

describe("the organization decides the primary state", () => {
  it("follows a workspace that moved from California to Arizona", () => {
    expect(withAuthoritativeState(TAXPAYER, { country: "US", stateRegion: "AZ" }).primaryStateRegion).toBe("AZ");
  });

  it("clears the state when the workspace's State is cleared", () => {
    expect(withAuthoritativeState(TAXPAYER, { country: "US", stateRegion: null }).primaryStateRegion).toBeNull();
  });

  it("ignores a stored state that disagrees with the workspace, whatever wrote it", () => {
    // A value written to the column directly is not trusted.
    const tampered = { ...TAXPAYER, primaryStateRegion: "TX" };
    expect(withAuthoritativeState(tampered, { country: "US", stateRegion: "CA" }).primaryStateRegion).toBe("CA");
  });

  it("routes a non-US workspace into no state engine, even with a stray code", () => {
    expect(withAuthoritativeState(TAXPAYER, { country: "RO", stateRegion: "CA" }).primaryStateRegion).toBeNull();
  });

  it("keeps the additional states the person entered", () => {
    expect(withAuthoritativeState(TAXPAYER, { country: "US", stateRegion: "AZ" }).additionalStateRegions).toEqual(["NY"]);
  });

  it("returns the same object when nothing needs to change", () => {
    expect(withAuthoritativeState(TAXPAYER, { country: "US", stateRegion: "CA" })).toBe(TAXPAYER);
  });
});

describe("whether a frozen result matches today's jurisdictions", () => {
  it("matches identical lists", () => {
    expect(sameJurisdictions(["US_FEDERAL", "US_CA"], ["US_FEDERAL", "US_CA"])).toBe(true);
  });

  it("does not match after the state changed", () => {
    expect(sameJurisdictions(["US_FEDERAL", "US_CA"], ["US_FEDERAL", "US_AZ"])).toBe(false);
  });

  it("does not match when a state was added or removed", () => {
    expect(sameJurisdictions(["US_FEDERAL"], ["US_FEDERAL", "US_CA"])).toBe(false);
    expect(sameJurisdictions(["US_FEDERAL", "US_CA"], ["US_FEDERAL"])).toBe(false);
  });
});
