/**
 * Pure date-range math, deliberately kept out of date-range-picker.tsx.
 * That component is "use client" (it uses next/navigation hooks), and a
 * Server Component importing a plain function from a "use client" module
 * hits Next's RSC boundary error ("Attempted to call X from the server")
 * even though the function itself has no client dependency — see
 * src/app/app/[orgId]/reports/page.tsx, the Server Component that needs
 * this same preset math to compute the default range server-side.
 */

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function presetRange(preset: string): { from: string; to: string } {
  const now = new Date();
  const today = isoDate(now);
  switch (preset) {
    case "this-month":
      return { from: isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: today };
    case "last-month": {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
      return { from: isoDate(start), to: isoDate(end) };
    }
    case "last-90-days": {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 90);
      return { from: isoDate(start), to: today };
    }
    case "this-year":
      return { from: `${now.getUTCFullYear()}-01-01`, to: today };
    default:
      return { from: isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: today };
  }
}
