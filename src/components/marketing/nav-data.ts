import type { Icon } from "@phosphor-icons/react";
import { ChartLineUp } from "@phosphor-icons/react/dist/ssr/ChartLineUp";
import { ChatCircleText } from "@phosphor-icons/react/dist/ssr/ChatCircleText";
import { Pulse } from "@phosphor-icons/react/dist/ssr/Pulse";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/ssr/ArrowsLeftRight";
import { Wallet } from "@phosphor-icons/react/dist/ssr/Wallet";
import { ChartBar } from "@phosphor-icons/react/dist/ssr/ChartBar";
import { FileText } from "@phosphor-icons/react/dist/ssr/FileText";
import { UsersThree } from "@phosphor-icons/react/dist/ssr/UsersThree";
import { FolderOpen } from "@phosphor-icons/react/dist/ssr/FolderOpen";
import { LockKey } from "@phosphor-icons/react/dist/ssr/LockKey";
import { User } from "@phosphor-icons/react/dist/ssr/User";
import { Briefcase } from "@phosphor-icons/react/dist/ssr/Briefcase";
import { Buildings } from "@phosphor-icons/react/dist/ssr/Buildings";
import { BookOpen } from "@phosphor-icons/react/dist/ssr/BookOpen";
import { Compass } from "@phosphor-icons/react/dist/ssr/Compass";
import { ShieldCheck } from "@phosphor-icons/react/dist/ssr/ShieldCheck";

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
  /** Shown in the mega menu's icon tile. Phosphor, like the rest of the
   *  product — the same glyph set the app shell's navigation uses. */
  icon: Icon;
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
        { label: "Financial health", description: "A weighted, explainable score for your finances.", href: "/product#financial-intelligence", icon: Pulse },
        { label: "Cash flow & forecasting", description: "What's coming in, going out, and what's next.", href: "/product#financial-intelligence", icon: ChartLineUp },
        { label: "Ask Countorra", description: "Ask real questions, answered from your own data.", href: "/product#financial-intelligence", icon: ChatCircleText },
      ],
    },
    {
      label: "Accounting",
      items: [
        { label: "Transactions", description: "Every transaction, categorized and searchable.", href: "/product#accounting", icon: ArrowsLeftRight },
        { label: "Accounts", description: "Every account and its balance, in one place.", href: "/product#accounting", icon: Wallet },
        { label: "Reports", description: "Financial reports built from your real records.", href: "/product#accounting", icon: ChartBar },
      ],
    },
    {
      label: "Invoicing",
      items: [
        { label: "Invoices", description: "Send invoices and track what's outstanding.", href: "/product#invoicing", icon: FileText },
        { label: "Customers", description: "A record of who you bill and what they owe.", href: "/product#invoicing", icon: UsersThree },
      ],
    },
    {
      label: "Documents",
      items: [
        { label: "Document intelligence", description: "Upload invoices and receipts, reviewed before they count.", href: "/product#documents", icon: FolderOpen },
        { label: "Private storage", description: "Documents are stored per organization, never public.", href: "/product#documents", icon: LockKey },
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
        { label: "Personal", description: "Understand everyday spending and financial health.", href: "/solutions/personal", icon: User },
        { label: "Freelancer", description: "Income, invoices, and cash flow across pay cycles.", href: "/solutions/freelancer", icon: Briefcase },
        { label: "Business", description: "Revenue, customers, and financial performance.", href: "/solutions/business", icon: Buildings },
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
        { label: "How it works", description: "The product story, end to end.", href: "/resources#how-it-works", icon: Compass },
        { label: "Financial guides", description: "Practical guidance on organizing your finances.", href: "/resources#guides", icon: BookOpen },
        { label: "Security architecture", description: "How data isolation and access control work.", href: "/security", icon: ShieldCheck },
      ],
    },
  ],
};

export const NAV_GROUPS = [PRODUCT_MENU, SOLUTIONS_MENU, RESOURCES_MENU];

export const DIRECT_LINKS: NavLeaf[] = [
  { label: "Pricing", description: "Plans and what's included.", href: "/pricing", icon: ChartBar },
  { label: "Security", description: "How data isolation and access control work.", href: "/security", icon: ShieldCheck },
];
