import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";
import { PLAN_ENTITLEMENTS, PLAN_TIERS } from "@/domain/billing/entitlements";

/**
 * The database's plan catalogue must agree with the canonical model.
 *
 * It did not, and that is how `ai_accountant: false` survived on the Free
 * tier while the product shipped Free with a working assistant: four
 * definitions existed, only one was executed, and nothing ever compared them.
 *
 * Enforcement reads the TypeScript model, so a mismatch here is not itself a
 * live bug — but it is how the next false statement gets written down and
 * believed. This test is the comparison that was missing.
 */
describe("plan catalogue agrees with the canonical entitlements", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.close();
  });

  async function catalogue() {
    return db.asAdmin(async (query) => {
      const result = await query(`select id, name, price_minor, currency, entitlements from plans order by id`);
      return result.rows as {
        id: "free" | "premium" | "business";
        name: string;
        price_minor: string | number | null;
        currency: string;
        entitlements: Record<string, unknown>;
      }[];
    });
  }

  it("seeds exactly the tiers the canonical model defines", async () => {
    const rows = await catalogue();
    expect(rows.map((r) => r.id).sort()).toEqual([...PLAN_TIERS].sort());
  });

  it("matches the canonical name and price for every tier", async () => {
    for (const row of await catalogue()) {
      const canonical = PLAN_ENTITLEMENTS[row.id];
      expect(row.name, `${row.id} name`).toBe(canonical.name);
      expect(Number(row.price_minor), `${row.id} price`).toBe(canonical.priceMinorMonthly);
      expect(row.currency, `${row.id} currency`).toBe(canonical.currency);
    }
  });

  it("matches the canonical entitlements for every tier", async () => {
    for (const row of await catalogue()) {
      const canonical = PLAN_ENTITLEMENTS[row.id];
      expect(row.entitlements, `${row.id} entitlements`).toEqual({
        max_organizations: canonical.maxOrganizations,
        ai_assistant: canonical.aiAssistant,
        ai_messages_per_day: canonical.aiMessagesPerDay,
        document_processing: canonical.documentProcessing,
        advanced_tax_tools: canonical.advancedTaxTools,
        bank_connections: canonical.bankConnections,
        priority_support: canonical.prioritySupport,
      });
    }
  });

  it("no longer claims Free has no assistant", async () => {
    const free = (await catalogue()).find((r) => r.id === "free");
    expect(free?.entitlements.ai_assistant).toBe(true);
    expect(free?.entitlements).not.toHaveProperty("ai_accountant");
  });

  it("gives every tier a finite AI allowance", async () => {
    // `ai_messages_per_day: null` on Business was not a generous ceiling — the
    // enforcement site skipped metering entirely for a null limit, so the
    // most expensive resource in the product had no counter on the most
    // expensive tier. A null here again would mean that regression is back.
    for (const row of await catalogue()) {
      expect(row.entitlements.ai_messages_per_day, `${row.id} allowance`).toEqual(expect.any(Number));
      expect(row.entitlements.ai_messages_per_day as number, `${row.id} allowance`).toBeGreaterThan(0);
    }
  });

  it("records the re-cut allowances rather than the old ones", async () => {
    const byId = Object.fromEntries((await catalogue()).map((r) => [r.id, r.entitlements]));
    expect(byId.free.ai_messages_per_day).toBe(3);
    expect(byId.premium.ai_messages_per_day).toBe(100);
    expect(byId.business.ai_messages_per_day).toBe(500);
  });

  it("still lets a signed-out visitor read the public catalogue", async () => {
    // `plans` is the one table with a `using (true)` select policy — it is a
    // price list, not tenant data. Making it canonical must not change that.
    await db.asAdmin(async (query) => {
      await query(`set role anon`);
      const result = await query(`select id from plans`);
      expect(result.rows.length).toBe(3);
      await query(`reset role`);
    });
  });

  it("does not let a client rewrite its own entitlements", async () => {
    // Billing tamper-resistance. There is no UPDATE policy on `plans`, and
    // RLS expresses that as "no rows were visible to update" rather than as
    // an error — so the assertion that matters is that the catalogue is
    // unchanged afterwards, not that the statement threw. A test that only
    // expected a throw would fail while the system was behaving correctly.
    await db.asAdmin(async (query) => {
      await query(`set role authenticated`);
      const attempt = await query(`update plans set entitlements = '{"max_organizations": null}'::jsonb, price_minor = 0 where id = 'free'`);
      expect((attempt as { affectedRows?: number }).affectedRows ?? 0).toBe(0);
      await query(`reset role`);
    });

    const free = (await catalogue()).find((r) => r.id === "free");
    expect(free?.entitlements.max_organizations).toBe(1);
    expect(Number(free?.price_minor)).toBe(0);
  });

  it("does not let a client insert a tier of its own", async () => {
    await db.asAdmin(async (query) => {
      await query(`set role authenticated`);
      await expect(
        query(`insert into plans (id, name, price_minor, entitlements) values ('business', 'Free Business', 0, '{}'::jsonb)`),
      ).rejects.toThrow();
      await query(`reset role`);
    });
  });
});
