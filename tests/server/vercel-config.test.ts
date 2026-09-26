import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * vercel.json is deployment configuration that no build step validates
 * against the app: a cron pointing at a path that was renamed simply fails
 * on every run, forever, in production only. So it is checked here.
 *
 * The schedule is DAILY because the project runs on Vercel's Hobby plan,
 * which refuses to deploy any cron that runs more than once a day. A
 * five-minute schedule there fails the deployment itself. See BANK-SYNC-WORKER.md for
 * what daily means for imports, and how to run it more often.
 */

const ROOT = process.cwd();
const config = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as { crons?: { path: string; schedule: string }[] };

describe("vercel.json", () => {
  it("schedules exactly two crons, and no others", () => {
    // Listed in full rather than by count, so adding a third is a decision
    // somebody makes here rather than a line that slips in. Hobby allows two.
    expect(config.crons).toEqual([
      { path: "/api/bank-connections/worker", schedule: "0 6 * * *" },
      { path: "/api/documents/retention", schedule: "0 7 * * *" },
    ]);
  });

  it("does not run two crons in the same hour", () => {
    // Both are 60-second functions on the same deployment; an hour apart
    // keeps the retention sweep out of the bank worker's window.
    const hours = (config.crons ?? []).map((cron) => cron.schedule.trim().split(/\s+/)[1]);
    expect(new Set(hours).size).toBe(hours.length);
  });

  it("runs at most once a day, which Vercel Hobby requires", () => {
    // A fixed minute and a fixed hour, every day: exactly one run per day.
    // Anything else in those two fields (`*`, a step, a list or a range) would
    // run more often and Hobby would reject the deployment.
    for (const cron of config.crons ?? []) {
      const fields = cron.schedule.trim().split(/\s+/);
      expect(fields).toHaveLength(5);
      const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
      expect(minute).toMatch(/^([0-9]|[1-5][0-9])$/);
      expect(hour).toMatch(/^([0-9]|1[0-9]|2[0-3])$/);
      expect([dayOfMonth, month, dayOfWeek]).toEqual(["*", "*", "*"]);
    }
  });

  it("points every cron at a route that exists, with a GET handler — Vercel Cron issues GET", () => {
    for (const cron of config.crons ?? []) {
      const file = path.join(ROOT, `src/app${cron.path}/route.ts`);
      expect(existsSync(file), cron.path).toBe(true);
      expect(readFileSync(file, "utf8"), cron.path).toMatch(/export async function GET\(/);
    }
  });

  it("passes no secret and no query in the cron path — the secret travels as CRON_SECRET", () => {
    for (const cron of config.crons ?? []) {
      expect(cron.path).not.toContain("?");
      expect(cron.path).not.toMatch(/secret|token|key/i);
    }
  });

  it("carries no secret value anywhere in the file", () => {
    const raw = readFileSync(path.join(ROOT, "vercel.json"), "utf8");
    expect(raw).not.toMatch(/sk_(live|test)_|whsec_|access-(sandbox|production)-|BANK_SYNC_WORKER_SECRET|CRON_SECRET/);
  });
});
