import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * vercel.json is deployment configuration that no build step validates
 * against the app: a cron pointing at a path that was renamed simply fails
 * every five minutes, forever, in production only. So it is checked here.
 */

const ROOT = process.cwd();
const config = JSON.parse(readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as { crons?: { path: string; schedule: string }[] };

describe("vercel.json", () => {
  it("schedules exactly one cron: the bank sync worker", () => {
    expect(config.crons).toEqual([{ path: "/api/bank-connections/worker", schedule: "*/5 * * * *" }]);
  });

  it("points at a route that exists, with a GET handler — Vercel Cron issues GET", () => {
    const file = path.join(ROOT, "src/app/api/bank-connections/worker/route.ts");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(/export async function GET\(/);
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
