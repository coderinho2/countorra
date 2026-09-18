import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * The rate limiter's database layer (0026_rate_limiting.sql), exercised
 * against a real Postgres engine.
 *
 * Two things are being proven here. First, that the counting is exact and the
 * decision comes from a single statement — the audit already found
 * check-then-act races twice in this codebase, and a limiter with that shape
 * would fail in precisely the burst it exists to stop. Second, that counters
 * are unreachable from any client role: a writable counter would let an
 * attacker exhaust somebody else's login budget, turning the control into the
 * denial of service.
 */

function row<T>(rows: unknown[], index = 0): T {
  return rows[index] as T;
}

interface Decision {
  allowed: boolean;
  remaining: number;
  retry_after_seconds: number;
}

let db: TestDatabase;

async function consume(namespace: string, key: string, limit: number, windowSeconds: number): Promise<Decision> {
  const r = await db.query(`select * from consume_rate_limit($1, $2, $3, $4)`, [namespace, key, limit, windowSeconds]);
  return row<Decision>(r.rows);
}

beforeEach(async () => {
  db = await createTestDatabase();
  await db.asAdmin(async () => {});
});

afterEach(async () => {
  await db.close();
});

describe("consume_rate_limit", () => {
  it("allows exactly `limit` requests in a window, then refuses", async () => {
    const outcomes: boolean[] = [];
    for (let i = 0; i < 8; i++) outcomes.push((await consume("test:ns", "key-a", 5, 60)).allowed);

    expect(outcomes).toEqual([true, true, true, true, true, false, false, false]);
  });

  it("reports a decreasing remaining budget, floored at zero", async () => {
    expect((await consume("test:ns", "key-b", 3, 60)).remaining).toBe(2);
    expect((await consume("test:ns", "key-b", 3, 60)).remaining).toBe(1);
    expect((await consume("test:ns", "key-b", 3, 60)).remaining).toBe(0);
    expect((await consume("test:ns", "key-b", 3, 60)).remaining).toBe(0);
  });

  it("returns a usable retry_after only once blocked", async () => {
    expect((await consume("test:ns", "key-c", 1, 60)).retry_after_seconds).toBe(0);
    const blocked = await consume("test:ns", "key-c", 1, 60);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_seconds).toBeGreaterThan(0);
    expect(blocked.retry_after_seconds).toBeLessThanOrEqual(60);
  });

  it("keeps counting while blocked, so a retry storm cannot probe the boundary for free", async () => {
    for (let i = 0; i < 10; i++) await consume("test:ns", "key-d", 2, 60);
    const counted = await db.asAdmin(async (query) =>
      row<{ count: number }>((await query(`select count from rate_limit_counters where key_hash = 'key-d'`)).rows).count,
    );
    expect(Number(counted)).toBe(10);
  });

  it("isolates namespaces, so one operation's budget never spends another's", async () => {
    for (let i = 0; i < 5; i++) await consume("auth:login:ip", "same-key", 5, 60);
    expect((await consume("auth:login:ip", "same-key", 5, 60)).allowed).toBe(false);
    // Same key, different namespace — untouched.
    expect((await consume("ai:message:user", "same-key", 5, 60)).allowed).toBe(true);
  });

  it("isolates keys, so one identifier cannot exhaust another's budget", async () => {
    for (let i = 0; i < 5; i++) await consume("test:ns", "victim", 5, 60);
    expect((await consume("test:ns", "victim", 5, 60)).allowed).toBe(false);
    expect((await consume("test:ns", "someone-else", 5, 60)).allowed).toBe(true);
  });

  it("starts a fresh window when the clock rolls over", async () => {
    // A one-second window makes rollover observable without waiting.
    expect((await consume("test:ns", "key-e", 1, 1)).allowed).toBe(true);
    expect((await consume("test:ns", "key-e", 1, 1)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await consume("test:ns", "key-e", 1, 1)).allowed).toBe(true);
  });

  it("counts a concurrently-issued burst exactly, losing none of it", async () => {
    // PGlite serializes statements on one connection, so this is not a test
    // of lock contention — real concurrency was verified against the live
    // project. What it does prove is that the decision is derived from the
    // post-increment count in the same statement, so no two callers can ever
    // observe the same value and both proceed. A read-then-write limiter
    // fails this: several of the 20 would see an under-limit count.
    const results = await Promise.all(Array.from({ length: 20 }, () => consume("test:ns", "burst", 6, 60)));
    expect(results.filter((r) => r.allowed)).toHaveLength(6);
    expect(results.filter((r) => !r.allowed)).toHaveLength(14);
  });

  it("refuses a nonsensical limit or window rather than defaulting to permissive", async () => {
    await expect(consume("test:ns", "key-f", 0, 60)).rejects.toThrow(/positive/i);
    await expect(consume("test:ns", "key-g", 5, 0)).rejects.toThrow(/positive/i);
  });
});

describe("counters are unreachable from client roles", () => {
  it("neither anon nor authenticated may execute the function", async () => {
    await db.query(`set role anon`);
    await expect(db.query(`select * from consume_rate_limit('x', 'y', 5, 60)`)).rejects.toThrow(/permission denied/i);

    await db.asUser("00000000-0000-4000-8000-000000000001");
    await expect(db.query(`select * from consume_rate_limit('x', 'y', 5, 60)`)).rejects.toThrow(/permission denied/i);
  });

  it("neither anon nor authenticated may read counters", async () => {
    // Reading is not harmless: it would reveal whether a given identifier is
    // currently being attacked, and how close it is to the limit.
    await db.query(`set role anon`);
    await expect(db.query(`select * from rate_limit_counters`)).rejects.toThrow(/permission denied/i);

    await db.asUser("00000000-0000-4000-8000-000000000001");
    await expect(db.query(`select * from rate_limit_counters`)).rejects.toThrow(/permission denied/i);
  });

  it("neither anon nor authenticated may write counters", async () => {
    // The attack this closes: burn a victim's login budget to lock them out.
    for (const stmt of [
      `insert into rate_limit_counters (namespace, key_hash, window_start, count, expires_at) values ('auth:login:id', 'victim', now(), 999, now() + interval '1 hour')`,
      `update rate_limit_counters set count = 999`,
      `delete from rate_limit_counters`,
    ]) {
      await db.query(`set role anon`);
      await expect(db.query(stmt)).rejects.toThrow(/permission denied/i);

      await db.asUser("00000000-0000-4000-8000-000000000001");
      await expect(db.query(stmt)).rejects.toThrow(/permission denied/i);
    }
  });

  it("row level security is enabled on the table", async () => {
    const r = await db.asAdmin(async (query) =>
      query(`select relrowsecurity from pg_class where relname = 'rate_limit_counters'`),
    );
    expect(row<{ relrowsecurity: boolean }>(r.rows).relrowsecurity).toBe(true);
  });
});
