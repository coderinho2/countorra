import { describe, expect, it } from "vitest";
import { isNavItemActive } from "./nav-active";
import { NAV_GROUPS, DIRECT_LINKS } from "./nav-data";

describe("isNavItemActive", () => {
  it("matches a section's own page", () => {
    expect(isNavItemActive("/pricing", "/pricing")).toBe(true);
    expect(isNavItemActive("/product", "/product")).toBe(true);
    expect(isNavItemActive("/solutions", "/solutions")).toBe(true);
    expect(isNavItemActive("/resources", "/resources")).toBe(true);
    expect(isNavItemActive("/security", "/security")).toBe(true);
  });

  it("keeps the parent section active on a nested page", () => {
    expect(isNavItemActive("/solutions/personal", "/solutions")).toBe(true);
    expect(isNavItemActive("/solutions/freelancer", "/solutions")).toBe(true);
    expect(isNavItemActive("/solutions/business", "/solutions")).toBe(true);
  });

  it("does not activate an unrelated section", () => {
    expect(isNavItemActive("/pricing", "/product")).toBe(false);
    expect(isNavItemActive("/solutions/freelancer", "/pricing")).toBe(false);
    expect(isNavItemActive("/security", "/resources")).toBe(false);
  });

  it("matches on path segments, not on string prefixes", () => {
    expect(isNavItemActive("/products", "/product")).toBe(false);
    expect(isNavItemActive("/pricing-guide", "/pricing")).toBe(false);
    expect(isNavItemActive("/securityx", "/security")).toBe(false);
  });

  it("treats the homepage as matching only itself", () => {
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/pricing", "/")).toBe(false);
    expect(isNavItemActive("/solutions/personal", "/")).toBe(false);
  });

  it("activates nothing on the homepage", () => {
    const items = [...NAV_GROUPS.map((g) => g.href), ...DIRECT_LINKS.map((l) => l.href)];
    expect(items.filter((href) => isNavItemActive("/", href))).toEqual([]);
  });

  it("ignores a trailing slash, a hash and a query string", () => {
    expect(isNavItemActive("/pricing/", "/pricing")).toBe(true);
    expect(isNavItemActive("/product", "/product#accounting")).toBe(true);
    expect(isNavItemActive("/resources?ref=email", "/resources")).toBe(true);
  });

  it("handles an empty pathname without matching anything", () => {
    expect(isNavItemActive("", "/pricing")).toBe(false);
  });

  it("activates exactly one top-level item on every public route", () => {
    const items = [...NAV_GROUPS.map((g) => g.href), ...DIRECT_LINKS.map((l) => l.href)];
    const routes = [
      "/product",
      "/solutions",
      "/solutions/personal",
      "/solutions/freelancer",
      "/solutions/business",
      "/resources",
      "/pricing",
      "/security",
    ];

    for (const route of routes) {
      expect(items.filter((href) => isNavItemActive(route, href))).toHaveLength(1);
    }
  });
});
