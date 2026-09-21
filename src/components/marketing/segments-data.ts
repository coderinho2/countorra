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

/**
 * Who Countorra is for. Personal only at launch
 * (src/domain/organizations/launch-scope.ts); the Freelancer and Business
 * segments are retired with those entity types. EntitySegments renders its
 * switcher only when there is more than one segment to switch between.
 */
export const SEGMENTS: Segment[] = [
  {
    key: "personal",
    label: "Personal",
    headline: "Understand where your money actually goes.",
    body: "Countorra tracks everyday spending, recurring costs, income, and overall financial health — and organises your tax year as it happens, so nothing is reconstructed in April.",
    capabilities: ["Spending by category", "Recurring cost detection", "Financial health score", "Cash flow forecast", "Personal tax preparation"],
  },
];
