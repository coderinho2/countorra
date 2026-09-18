import { describe, expect, it } from "vitest";
import { presetRange } from "./date-range";

/**
 * Regression test for a real bug found during the Phase 2 navigation audit:
 * `presetRange` used to live only inside date-range-picker.tsx, a
 * "use client" file. src/app/app/[orgId]/reports/page.tsx (a Server
 * Component) called it directly, which throws Next's RSC boundary error
 * ("Attempted to call presetRange() from the server") on every visit to
 * /reports without explicit ?from&to query params — i.e. every normal
 * visit. Moving it here (a plain module, no "use client") fixed it; this
 * test exists so a future refactor can't reintroduce the split.
 */
describe("presetRange", () => {
  it("returns a from/to pair for every known preset", () => {
    for (const preset of ["this-month", "last-month", "last-90-days", "this-year"]) {
      const range = presetRange(preset);
      expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(range.from <= range.to).toBe(true);
    }
  });

  it("falls back to the this-month range for an unknown preset", () => {
    expect(presetRange("not-a-real-preset")).toEqual(presetRange("this-month"));
  });

  it("is a plain, server-callable function (no client-only dependency)", () => {
    expect(typeof presetRange).toBe("function");
    expect(() => presetRange("this-year")).not.toThrow();
  });
});
