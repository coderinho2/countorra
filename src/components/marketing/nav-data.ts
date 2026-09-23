import type { Icon } from "@phosphor-icons/react";
import { ChartLineUp } from "@phosphor-icons/react/dist/ssr/ChartLineUp";
import { ChatCircleText } from "@phosphor-icons/react/dist/ssr/ChatCircleText";
import { Pulse } from "@phosphor-icons/react/dist/ssr/Pulse";
import { ArrowsLeftRight } from "@phosphor-icons/react/dist/ssr/ArrowsLeftRight";
import { Wallet } from "@phosphor-icons/react/dist/ssr/Wallet";
import { ChartBar } from "@phosphor-icons/react/dist/ssr/ChartBar";
import { FolderOpen } from "@phosphor-icons/react/dist/ssr/FolderOpen";
import { LockKey } from "@phosphor-icons/react/dist/ssr/LockKey";
import { User } from "@phosphor-icons/react/dist/ssr/User";
import { BookOpen } from "@phosphor-icons/react/dist/ssr/BookOpen";
import { Compass } from "@phosphor-icons/react/dist/ssr/Compass";
import { ShieldCheck } from "@phosphor-icons/react/dist/ssr/ShieldCheck";
import { Calculator } from "@phosphor-icons/react/dist/ssr/Calculator";
import { Lifebuoy } from "@phosphor-icons/react/dist/ssr/Lifebuoy";

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
      label: "Taxes",
      items: [
        { label: "Tax preparation", description: "Your tax year organised, with a U.S. federal and state estimate.", href: "/product#taxes", icon: Calculator },
      ],
    },
    {
      label: "Documents",
      items: [
        { label: "Document intelligence", description: "Upload receipts, bills and tax forms, reviewed before they count.", href: "/product#documents", icon: FolderOpen },
        { label: "Private storage", description: "Documents are stored per organization, never public.", href: "/product#documents", icon: LockKey },
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
        { label: "Help Centre", description: "How to use Countorra, and answers to common questions.", href: "/help", icon: Lifebuoy },
        { label: "How it works", description: "The product story, end to end.", href: "/resources#how-it-works", icon: Compass },
        { label: "Financial guides", description: "Practical guidance on organizing your finances.", href: "/guides", icon: BookOpen },
        { label: "Security architecture", description: "How data isolation and access control work.", href: "/security", icon: ShieldCheck },
      ],
    },
  ],
};

/*
 * Countorra launches personal-only (src/domain/organizations/launch-scope.ts).
 * The Solutions menu listed Personal, Freelancer and Business; with one
 * audience left it is a direct link, "Personal finance", rather than a menu
 * of one.
 */
export const NAV_GROUPS = [PRODUCT_MENU, RESOURCES_MENU];

export const DIRECT_LINKS: NavLeaf[] = [
  { label: "Personal finance", description: "Everyday spending, financial health and your tax year.", href: "/solutions/personal", icon: User },
  { label: "Pricing", description: "Plans and what's included.", href: "/pricing", icon: ChartBar },
  { label: "Security", description: "How data isolation and access control work.", href: "/security", icon: ShieldCheck },
];
