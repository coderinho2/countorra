import { describe, expect, it } from "vitest";
import { AI_NAV_ITEM, DEFERRED_NAV_ITEMS, NAV_GROUPS, NAV_ITEMS, SETTINGS_ITEM, visibleNavGroups, visibleNavItems } from "./nav-items";
import { LAUNCH_ENTITY_TYPE } from "@/domain/organizations/launch-scope";

const ORG_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Navigation-audit regression coverage (Phase 2 §1): every nav item must
 * point at a route that actually exists, and nothing from a deferred module
 * may appear. Countorra launches personal-only
 * (src/domain/organizations/launch-scope.ts), so the personal navigation IS
 * the product's navigation.
 */
describe("visibleNavItems", () => {
  it("every nav item resolves to a non-empty, org-scoped href", () => {
    for (const item of [...NAV_ITEMS, AI_NAV_ITEM]) {
      const href = item.href(ORG_ID);
      expect(href.startsWith(`/app/${ORG_ID}/`)).toBe(true);
    }
  });

  it("shows a personal workspace everything the launch product includes, Reports among it", () => {
    expect(visibleNavItems(LAUNCH_ENTITY_TYPE).map((i) => i.label)).toEqual([
      "Overview",
      "Transactions",
      "Accounts",
      "Bank connections",
      "Documents",
      "Reports",
      "Insights",
      "Tax preparation",
      "Tax filing",
      "Ask your money",
    ]);
  });

  it("never shows the deferred invoicing module", () => {
    const labels = NAV_ITEMS.map((i) => i.label);
    expect(labels).not.toContain("Invoices");
    expect(labels).not.toContain("Customers");
    expect(NAV_ITEMS.map((i) => i.href(ORG_ID))).not.toContain(`/app/${ORG_ID}/invoices`);
  });

  it("keeps the deferred entries defined, so the module can return unchanged", () => {
    expect(DEFERRED_NAV_ITEMS.map((i) => i.href(ORG_ID))).toEqual([`/app/${ORG_ID}/invoices`, `/app/${ORG_ID}/customers`]);
  });

  it("has no item gated to an entity type that cannot exist at launch", () => {
    expect(NAV_ITEMS.filter((item) => item.showFor)).toEqual([]);
  });

  it("'Ask your money' is always available, and links to the real AI page", () => {
    expect(AI_NAV_ITEM.href(ORG_ID)).toBe(`/app/${ORG_ID}/ai`);
    expect(AI_NAV_ITEM.label).toBe("Ask your money");
  });
});

/**
 * Grouping regression coverage (Phase 2 §23). The sidebar and the mobile
 * drawer both render from `visibleNavGroups`, so a group left with no items
 * would render a bare uppercase label above nothing.
 */
describe("visibleNavGroups", () => {
  it("never yields an empty group", () => {
    for (const group of visibleNavGroups(LAUNCH_ENTITY_TYPE)) expect(group.items.length).toBeGreaterThan(0);
  });

  it("no longer has a Billing group — its only items were the deferred invoicing module", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([null, "Records", "Analysis", "Assistant"]);
  });

  it("covers exactly the same items as the flat list", () => {
    const fromGroups = visibleNavGroups(LAUNCH_ENTITY_TYPE).flatMap((g) => g.items.map((i) => i.label));
    expect(fromGroups).toEqual(visibleNavItems(LAUNCH_ENTITY_TYPE).map((i) => i.label));
  });

  it("leads with an ungrouped Overview — the product's home is not a category member", () => {
    expect(NAV_GROUPS[0].label).toBeNull();
    expect(NAV_GROUPS[0].items.map((i) => i.label)).toEqual(["Overview"]);
  });

  it("lists Bank connections beside, and separate from, Accounts", () => {
    const records = visibleNavGroups(LAUNCH_ENTITY_TYPE).find((g) => g.label === "Records")!;
    const labels = records.items.map((i) => i.label);
    expect(labels.indexOf("Bank connections")).toBe(labels.indexOf("Accounts") + 1);
    expect(NAV_ITEMS.find((i) => i.label === "Bank connections")!.href(ORG_ID)).toBe(`/app/${ORG_ID}/bank-connections`);
  });

  it("keeps Settings out of the groups so it can be pinned to the footer", () => {
    expect(NAV_ITEMS.map((i) => i.label)).not.toContain(SETTINGS_ITEM.label);
    expect(SETTINGS_ITEM.href(ORG_ID)).toBe(`/app/${ORG_ID}/settings`);
  });
});
