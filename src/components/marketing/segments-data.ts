/**
 * Plain data, deliberately kept out of entity-segments.tsx (a "use
 * client" file): Next's client-boundary transform turns every export of
 * a client module into a client reference when it's imported from a
 * Server Component, which breaks plain data/array exports (they stop
 * being real arrays on the server-rendered path). Server Components
 * (the /solutions pages) and the client EntitySegments component both
 * import from this plain module instead.
 */
export interface Segment {
  key: string;
  label: string;
  headline: string;
  body: string;
  capabilities: string[];
}

export const SEGMENTS: Segment[] = [
  {
    key: "personal",
    label: "Personal",
    headline: "Understand where your money actually goes.",
    body: "Countorra tracks everyday spending, recurring costs, income, and overall financial health — so the picture of your money is always current, not reconstructed at tax time.",
    capabilities: ["Spending by category", "Recurring cost detection", "Financial health score", "Cash flow forecast"],
  },
  {
    key: "freelancer",
    label: "Freelancer",
    headline: "Run the financial side without the spreadsheet.",
    body: "Track income and expenses as they happen, send invoices, watch cash flow across irregular pay cycles, and keep records organized for tax season without guessing.",
    capabilities: ["Invoicing & payment tracking", "Income vs. expense clarity", "Cash flow across pay cycles", "Tax-ready organization"],
  },
  {
    key: "business",
    label: "Business",
    headline: "See revenue, expenses, and customers in one system.",
    body: "Understand performance across accounts, customers, and invoices, with cash flow and financial health figures that reflect the business as it actually runs.",
    capabilities: ["Revenue & expense tracking", "Customer & invoice management", "Financial performance reporting", "Financial health score"],
  },
];
