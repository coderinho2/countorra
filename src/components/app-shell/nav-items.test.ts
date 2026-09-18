import { describe, expect, it } from "vitest";
import { AI_NAV_ITEM, NAV_GROUPS, NAV_ITEMS, SETTINGS_ITEM, visibleNavGroups, visibleNavItems } from "./nav-items";
import type { UserEntityType } from "@/domain/organizations/types";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Navigation-audit regression coverage (Phase 2 §1): every nav item must
 * point at a route that actually exists, and entity-type-gated items must
 * never leak to an entity type that doesn't have that route in the app.
 */
describe("visibleNavItems", () => {
  it("every nav item resolves to a non-empty, org-scoped href", () => {
    for (const item of [...NAV_ITEMS, AI_NAV_ITEM]) {
      const href = item.href(ORG_ID);
      expect(href.startsWith(`/app/${ORG_ID}/`)).toBe(true);
    }
  });

  it("hides Invoices, Customers, and Reports from personal entities (no such pages for personal)", () => {
    const items = visibleNavItems("personal");
    const labels = items.map((i) => i.label);
    expect(labels).not.toContain("Invoices");
    expect(labels).not.toContain("Customers");
    expect(labels).not.toContain("Reports");
    expect(labels).toContain("Overview");
    expect(labels).toContain("Transactions");
  });

  it("shows Invoices, Customers, and Reports for freelancer and business entities", () => {
    for (const entityType of ["freelancer", "business"] satisfies UserEntityType[]) {
      const labels = visibleNavItems(entityType).map((i) => i.label);
      expect(labels).toContain("Invoices");
      expect(labels).toContain("Customers");
      expect(labels).toContain("Reports");
    }
  });

  it("'Ask your money' is always available regardless of entity type, and links to the real AI page", () => {
    expect(AI_NAV_ITEM.href(ORG_ID)).toBe(`/app/${ORG_ID}/ai`);
    expect(AI_NAV_ITEM.label).toBe("Ask your money");
  });
});

/**
 * Grouping regression coverage (Phase 2 §23). The sidebar and the mobile
 * drawer both render from `visibleNavGroups`, so a group that survives
 * filtering with no items left would render a bare uppercase label above
 * nothing — which is what an entity-type-gated group does if the filter is
 * applied to the items but not to the group.
 */
describe("visibleNavGroups", () => {
  it("never yields an empty group", () => {
    for (const entityType of ["personal", "freelancer", "business"] satisfies UserEntityType[]) {
      for (const group of visibleNavGroups(entityType)) {
        expect(group.items.length).toBeGreaterThan(0);
      }
    }
  });

  it("drops the Billing group entirely for personal entities", () => {
    // Both of Billing's items are gated to freelancer/business, so for a
    // personal workspace the whole group must disappear rather than leaving
    // a heading with nothing under it.
    const labels = visibleNavGroups("personal").map((g) => g.label);
    expect(labels).not.toContain("Billing");
    expect(visibleNavGroups("business").map((g) => g.label)).toContain("Billing");
  });

  it("covers exactly the same items as the flat list, for every entity type", () => {
    for (const entityType of ["personal", "freelancer", "business"] satisfies UserEntityType[]) {
      const fromGroups = visibleNavGroups(entityType).flatMap((g) => g.items.map((i) => i.label));
      expect(fromGroups).toEqual(visibleNavItems(entityType).map((i) => i.label));
    }
  });

  it("leads with an ungrouped Overview — the product's home is not a category member", () => {
    expect(NAV_GROUPS[0].label).toBeNull();
    expect(NAV_GROUPS[0].items.map((i) => i.label)).toEqual(["Overview"]);
  });

  it("lists Bank connections beside, and separate from, Accounts — for every entity type", () => {
    for (const entityType of ["personal", "freelancer", "business"] satisfies UserEntityType[]) {
      const records = visibleNavGroups(entityType).find((g) => g.label === "Records")!;
      const labels = records.items.map((i) => i.label);
      expect(labels.indexOf("Bank connections")).toBe(labels.indexOf("Accounts") + 1);
    }
    expect(NAV_ITEMS.find((i) => i.label === "Bank connections")!.href(ORG_ID)).toBe(`/app/${ORG_ID}/bank-connections`);
  });

  it("keeps Settings out of the groups so it can be pinned to the footer", () => {
    expect(NAV_ITEMS.map((i) => i.label)).not.toContain(SETTINGS_ITEM.label);
    expect(SETTINGS_ITEM.href(ORG_ID)).toBe(`/app/${ORG_ID}/settings`);
  });
});
