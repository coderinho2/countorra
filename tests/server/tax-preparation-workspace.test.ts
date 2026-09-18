import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparationCase, TaxFact } from "@/domain/tax-preparation/types";

/**
 * The preparation workspace loader, reproducing the live stale-state bug.
 *
 * Observed against the real project: a workspace set to CA opened a 2026 case,
 * Settings was then changed to AZ, and the case kept showing CA — and a fresh
 * calculation froze US_CA again. These tests pin the corrected behaviour at the
 * layer every consumer reads from: the page, the calculate action and the AI
 * status tool all go through `loadPreparationWorkspace`.
 */

const ORG = "51d1385e-8278-4388-a248-73b3fed44275";
const CASE = "f8311959-cf1b-4bfe-bc2f-d2a5f51b04be";

const state = vi.hoisted(() => ({
  organization: { id: "", name: "TEST", entityType: "personal", country: "US", stateRegion: "AZ" as string | null, baseCurrency: "USD", taxIdentifier: null, taxIdentifierType: null },
  storedCase: null as unknown,
  latest: null as unknown,
}));

vi.mock("@/server/db/repositories/organizations", () => ({ getOrganization: async () => state.organization }));
vi.mock("@/server/db/repositories/tax-preparation", () => ({
  getPreparationCase: async () => state.storedCase,
  listCurrentFacts: async () => [fact()],
  listDependents: async () => [],
  latestSnapshot: async () => state.latest,
}));

const { loadPreparationWorkspace } = await import("@/server/tax-preparation/workspace");

function fact(): TaxFact {
  return {
    id: "fact-1",
    organizationId: ORG,
    caseId: CASE,
    version: 1,
    key: "W2_WAGES",
    amountMinor: 9_000_000,
    currency: "USD",
    textValue: null,
    source: "USER_ENTERED",
    state: "CONFIRMED",
    evidenceDocumentId: null,
    evidenceNote: null,
    createdAt: "2026-09-13T09:43:33.000Z",
    createdBy: "user",
  };
}

function storedCase(primaryStateRegion: string | null): PreparationCase {
  return {
    id: CASE,
    organizationId: ORG,
    taxYear: 2026,
    status: "CALCULATED",
    filingStatus: "single",
    taxpayer: {
      legalFirstName: "Test",
      legalMiddleName: null,
      legalLastName: "Taxpayer",
      dateOfBirth: "1985-04-12",
      taxIdentifierType: null,
      taxIdentifierOnFile: false,
      primaryStateRegion,
      additionalStateRegions: [],
      spouseFirstName: null,
      spouseLastName: null,
      spouseDateOfBirth: null,
      spouseTaxIdentifierOnFile: false,
      spouseItemizesDeductions: null,
    },
    currentVersion: 3,
    createdBy: "user",
    createdAt: "2026-09-13T09:34:46.000Z",
    updatedAt: "2026-09-13T09:47:20.000Z",
    completedAt: null,
  };
}

function snapshotFor(jurisdictions: string[]) {
  return { id: "snap-3", caseId: CASE, version: 3, snapshot: { jurisdictions }, calculation: { states: [] }, createdAt: "2026-09-13T09:47:20.000Z" };
}

beforeEach(() => {
  state.organization = { ...state.organization, id: ORG, country: "US", stateRegion: "AZ" };
  state.storedCase = storedCase("CA");
  state.latest = snapshotFor(["US_FEDERAL", "US_CA"]);
});

describe("a workspace whose State changed after the case was opened", () => {
  it("uses the organization's current State, not the copy on the case", async () => {
    const workspace = await loadPreparationWorkspace({} as never, ORG, CASE);
    expect(workspace?.preparationCase.taxpayer.primaryStateRegion).toBe("AZ");
    expect(workspace?.storedPrimaryStateRegion).toBe("CA");
  });

  it("assesses and would calculate Arizona, not California", async () => {
    const workspace = await loadPreparationWorkspace({} as never, ORG, CASE);
    expect(workspace?.completeness.jurisdictions).toEqual(["US_FEDERAL", "US_AZ"]);
    const ids = workspace?.completeness.issues.map((issue) => issue.id) ?? [];
    // Arizona 2026 is unavailable; the California estimate notice must be gone.
    expect(ids).toContain("JURISDICTION_RULES_PENDING:US_AZ");
    expect(ids).not.toContain("JURISDICTION_ESTIMATE_FROM_PUBLISHED_RULES:US_CA");
  });

  it("marks the California result as no longer current, though no fact changed", async () => {
    const workspace = await loadPreparationWorkspace({} as never, ORG, CASE);
    expect(workspace?.calculationIsCurrent).toBe(false);
  });

  it("treats a result frozen for the current jurisdictions as current", async () => {
    state.latest = snapshotFor(["US_FEDERAL", "US_AZ"]);
    const workspace = await loadPreparationWorkspace({} as never, ORG, CASE);
    expect(workspace?.calculationIsCurrent).toBe(true);
  });

  it("drops the state engine entirely when the workspace State is cleared", async () => {
    state.organization = { ...state.organization, stateRegion: null };
    const workspace = await loadPreparationWorkspace({} as never, ORG, CASE);
    expect(workspace?.completeness.jurisdictions).toEqual(["US_FEDERAL"]);
  });

  it("still refuses a case that belongs to another workspace", async () => {
    state.storedCase = { ...storedCase("CA"), organizationId: "f688d664-cbf1-4811-9eea-7c8e397622e5" };
    expect(await loadPreparationWorkspace({} as never, ORG, CASE)).toBeNull();
  });
});
