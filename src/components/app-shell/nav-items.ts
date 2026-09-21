import { House, ArrowsLeftRight, Wallet, Bank, FileText, UsersThree, FolderOpen, ChartBar, Sparkle, ChatCircleText, Gear, Calculator, ListChecks } from "@phosphor-icons/react";
import type { UserEntityType } from "@/domain/organizations/types";

export interface NavItem {
  href: (orgId: string) => string;
  label: string;
  icon: typeof House;
  showFor?: UserEntityType[];
}

/**
 * Nav is grouped rather than flat. DESIGN.md §7 specifies Micro-scale
 * uppercase group labels in the sidebar, and a nine-item flat list is
 * exactly the case they exist for: without grouping the eye has to read
 * every label to find anything, because nothing tells it which region of
 * the list to look in.
 *
 * The groups are the actual mental model of the product — where money is
 * recorded, who owes it, what it means — rather than a tidy alphabetisation.
 * "Overview" is deliberately ungrouped and sits above the first label: it is
 * the home of the product, not a member of a category.
 */
export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const OVERVIEW_ITEM: NavItem = {
  href: (id) => `/app/${id}/dashboard`,
  label: "Overview",
  icon: House,
};
export const AI_NAV_ITEM: NavItem = {
  href: (id) => `/app/${id}/ai`,
  label: "Ask your money",
  icon: ChatCircleText,
};
export const SETTINGS_ITEM: NavItem = {
  href: (id) => `/app/${id}/settings`,
  label: "Settings",
  icon: Gear,
};

export const NAV_GROUPS: NavGroup[] = [
  { label: null, items: [OVERVIEW_ITEM] },
  {
    label: "Records",
    items: [
      {
        href: (id) => `/app/${id}/transactions`,
        label: "Transactions",
        icon: ArrowsLeftRight,
      },
      { href: (id) => `/app/${id}/accounts`, label: "Accounts", icon: Wallet },
      // Directly under Accounts, and separate from it: Accounts are the books,
      // kept by hand; a bank connection only feeds transactions into an
      // account a person chose.
      { href: (id) => `/app/${id}/bank-connections`, label: "Bank connections", icon: Bank },
      {
        href: (id) => `/app/${id}/documents`,
        label: "Documents",
        icon: FolderOpen,
      },
    ],
  },
  {
    label: "Analysis",
    items: [
      // Income, expenses by category and the net result for any period — as
      // useful for a household as for a business.
      { href: (id) => `/app/${id}/reports`, label: "Reports", icon: ChartBar },
      { href: (id) => `/app/${id}/insights`, label: "Insights", icon: Sparkle },
      // Personal (individual) tax preparation. The page says it does not
      // prepare business returns.
      { href: (id) => `/app/${id}/tax-preparation`, label: "Tax preparation", icon: Calculator },
      // The next stage after preparation: readiness, review and finalization.
      // Not e-filing — the page says so before anything else.
      { href: (id) => `/app/${id}/tax-filing`, label: "Tax filing", icon: ListChecks },
    ],
  },
  { label: "Assistant", items: [AI_NAV_ITEM] },
];

/**
 * Invoicing — invoices and customers — built for freelancers and businesses
 * and deferred at launch (src/domain/organizations/launch-scope.ts). Kept
 * here, out of NAV_GROUPS, so the entries return unchanged when the module
 * does; their routes answer 404 while it is deferred.
 */
export const DEFERRED_NAV_ITEMS: NavItem[] = [
  { href: (id) => `/app/${id}/invoices`, label: "Invoices", icon: FileText, showFor: ["freelancer", "business"] },
  { href: (id) => `/app/${id}/customers`, label: "Customers", icon: UsersThree, showFor: ["freelancer", "business"] },
];

/** Flat list of everything visible to this entity type — used by the mobile
 *  drawer's search-free list and by the breadcrumb's title lookup. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

export function visibleNavGroups(entityType: UserEntityType): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.showFor || item.showFor.includes(entityType)),
  })).filter((group) => group.items.length > 0);
}

export function visibleNavItems(entityType: UserEntityType): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.showFor || item.showFor.includes(entityType));
}
