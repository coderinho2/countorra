/**
 * Navigation content for the marketing header. Every href is either a
 * real route or a real anchor on one of this site's real pages — nothing
 * here points at a page that doesn't exist. The authenticated product
 * areas (Dashboard, Transactions, ...) live behind auth + an org id, so
 * they can't be linked directly from a logged-out page; where a public
 * page or section represents that area, the item points there.
 */

export interface NavLeaf {
  label: string;
  description: string;
  href: string;
}

export interface NavCategory {
  label: string;
  items: NavLeaf[];
}

export interface NavGroup {
  label: string;
  href: string;
  categories: NavCategory[];
}

export const PRODUCT_MENU: NavGroup = {
  label: "Product",
  href: "/product",
  categories: [
    {
      label: "Financial intelligence",
      items: [
        { label: "Financial health", description: "A weighted, explainable score for your finances.", href: "/product#financial-intelligence" },
        { label: "Cash flow & forecasting", description: "What's coming in, going out, and what's next.", href: "/product#financial-intelligence" },
        { label: "Ask Countorra", description: "Ask real questions, answered from your own data.", href: "/product#financial-intelligence" },
      ],
    },
    {
      label: "Accounting",
      items: [
        { label: "Transactions", description: "Every transaction, categorized and searchable.", href: "/product#accounting" },
        { label: "Accounts", description: "Every account and its balance, in one place.", href: "/product#accounting" },
        { label: "Reports", description: "Financial reports built from your real records.", href: "/product#accounting" },
      ],
    },
    {
      label: "Invoicing",
      items: [
        { label: "Invoices", description: "Send invoices and track what's outstanding.", href: "/product#invoicing" },
        { label: "Customers", description: "A record of who you bill and what they owe.", href: "/product#invoicing" },
      ],
    },
    {
      label: "Documents",
      items: [
        { label: "Document intelligence", description: "Upload invoices and receipts, reviewed before they count.", href: "/product#documents" },
        { label: "Private storage", description: "Documents are stored per organization, never public.", href: "/product#documents" },
      ],
    },
  ],
};

export const SOLUTIONS_MENU: NavGroup = {
  label: "Solutions",
  href: "/solutions",
  categories: [
    {
      label: "By who you are",
      items: [
        { label: "Personal", description: "Understand everyday spending and financial health.", href: "/solutions/personal" },
        { label: "Freelancer", description: "Income, invoices, and cash flow across pay cycles.", href: "/solutions/freelancer" },
        { label: "Business", description: "Revenue, customers, and financial performance.", href: "/solutions/business" },
      ],
    },
  ],
};

export const RESOURCES_MENU: NavGroup = {
  label: "Resources",
  href: "/resources",
  categories: [
    {
      label: "Learn",
      items: [
        { label: "How it works", description: "The product story, end to end.", href: "/resources#how-it-works" },
        { label: "Financial guides", description: "Practical guidance on organizing your finances.", href: "/resources#guides" },
        { label: "Security architecture", description: "How data isolation and access control work.", href: "/security" },
      ],
    },
  ],
};

export const NAV_GROUPS = [PRODUCT_MENU, SOLUTIONS_MENU, RESOURCES_MENU];

export const DIRECT_LINKS: NavLeaf[] = [
  { label: "Pricing", description: "Plans and what's included.", href: "/pricing" },
  { label: "Security", description: "How data isolation and access control work.", href: "/security" },
];
