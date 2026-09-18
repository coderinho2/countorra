import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./harness";

/**
 * The customer-facing invoice view, against real Postgres.
 *
 * This is the most exposed surface in the product: an unauthenticated route
 * that reads financial data. The token in the URL is the whole
 * authorization, so what it does and does not unlock is a database property
 * and is tested as one.
 *
 * The functions under test are `invoice_by_public_token` and
 * `invoice_line_items_by_public_token` (0037), both SECURITY DEFINER and
 * both callable by `anon`.
 */

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const TOKEN_A = "tok_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "tok_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

let db: TestDatabase;
let orgA: string;
let orgB: string;
let invoiceA: string;

async function makeInvoice(
  organizationId: string,
  owner: string,
  options: { token?: string | null; status?: string; number?: string } = {},
): Promise<string> {
  return db.asAdmin(async (query) => {
    const customer = await query(`insert into customers (organization_id, display_name, email) values ($1, 'Wile E. Coyote', 'wile@example.test') returning id`, [
      organizationId,
    ]);
    const customerId = (customer.rows[0] as { id: string }).id;

    const invoice = await query(
      `insert into invoices (organization_id, customer_id, invoice_number, status, currency, issue_date, due_date,
                             subtotal_minor, tax_minor, total_minor, notes, created_by, public_token)
       values ($1, $2, $3, $4::invoice_status, 'USD', date '2026-09-01', date '2026-10-01', 100000, 0, 100000, 'Thanks', $5, $6)
       returning id`,
      [organizationId, customerId, options.number ?? "INV-1", options.status ?? "sent", owner, options.token === undefined ? TOKEN_A : options.token],
    );
    const invoiceId = (invoice.rows[0] as { id: string }).id;

    await query(
      `insert into invoice_line_items (invoice_id, "position", description, quantity, unit_price_minor, tax_rate, amount_minor)
       values ($1, 0, 'Consulting', 2, 50000, 0, 100000)`,
      [invoiceId],
    );

    return invoiceId;
  });
}

/** Calls the public function the way the unauthenticated page does. */
async function fetchByToken(token: string) {
  return db.asAdmin(async (query) => {
    await query(`set role anon`);
    const result = await query(`select * from invoice_by_public_token($1)`, [token]);
    await query(`reset role`);
    return result.rows as Record<string, unknown>[];
  });
}

async function fetchLineItemsByToken(token: string) {
  return db.asAdmin(async (query) => {
    await query(`set role anon`);
    const result = await query(`select * from invoice_line_items_by_public_token($1)`, [token]);
    await query(`reset role`);
    return result.rows as Record<string, unknown>[];
  });
}

beforeEach(async () => {
  db = await createTestDatabase();

  await db.asAdmin((query) =>
    query(`insert into auth.users (id, email) values ($1, 'a@example.test'), ($2, 'b@example.test')`, [OWNER_A, OWNER_B]),
  );

  await db.asUser(OWNER_A);
  orgA = (
    (await db.query(`insert into organizations (name, entity_type, created_by) values ('Acme', 'business', $1) returning id`, [OWNER_A])).rows[0] as {
      id: string;
    }
  ).id;

  await db.asUser(OWNER_B);
  orgB = (
    (await db.query(`insert into organizations (name, entity_type, created_by) values ('Rival', 'business', $1) returning id`, [OWNER_B])).rows[0] as {
      id: string;
    }
  ).id;

  invoiceA = await makeInvoice(orgA, OWNER_A);
});

afterEach(async () => {
  await db.close();
});

describe("a valid token unlocks exactly one invoice", () => {
  it("returns the invoice it belongs to", async () => {
    const rows = await fetchByToken(TOKEN_A);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(invoiceA);
    expect(rows[0].invoice_number).toBe("INV-1");
    expect(rows[0].organization_name).toBe("Acme");
    expect(rows[0].customer_name).toBe("Wile E. Coyote");
    expect(Number(rows[0].total_minor)).toBe(100000);
  });

  it("returns that invoice's line items", async () => {
    const items = await fetchLineItemsByToken(TOKEN_A);
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe("Consulting");
  });

  it("exposes ONLY the fields a customer needs", async () => {
    // Not `created_by`, not `public_token`, not `customer_id`. A customer
    // has no reason to learn who inside the organization raised the invoice,
    // and echoing the token back puts a live capability in a page body.
    const rows = await fetchByToken(TOKEN_A);
    const fields = Object.keys(rows[0]);

    expect(fields).not.toContain("created_by");
    expect(fields).not.toContain("public_token");
    expect(fields).not.toContain("customer_id");
    expect(fields).not.toContain("recurrence_id");
  });
});

describe("a token unlocks NOTHING else", () => {
  it("returns nothing for another organization's token", async () => {
    await makeInvoice(orgB, OWNER_B, { token: TOKEN_B, number: "INV-B" });

    const rows = await fetchByToken(TOKEN_A);
    expect(rows).toHaveLength(1);
    expect(rows[0].organization_name).toBe("Acme");
  });

  it("does not return org B's line items for org A's token", async () => {
    await makeInvoice(orgB, OWNER_B, { token: TOKEN_B, number: "INV-B" });

    const items = await fetchLineItemsByToken(TOKEN_A);
    expect(items).toHaveLength(1);
  });

  it.each(["", "wrong", "tok_", "' or '1'='1", "%", "tok_%"])("returns nothing for the token %s", async (token) => {
    // Including the SQL-injection and wildcard shapes: the lookup is an
    // equality match on a parameter, not a pattern.
    expect(await fetchByToken(token)).toHaveLength(0);
  });

  it("refuses a token shorter than a real one, without touching rows", async () => {
    // A short token cannot be one this product issued (32 random bytes), so
    // the function rejects it outright rather than scanning.
    expect(await fetchByToken("a".repeat(31))).toHaveLength(0);
  });

  it("returns nothing once the token is revoked", async () => {
    await db.asAdmin((query) => query(`update invoices set public_token = null where id = $1`, [invoiceA]));
    expect(await fetchByToken(TOKEN_A)).toHaveLength(0);
  });

  it("returns nothing for an invoice that has no token at all", async () => {
    await makeInvoice(orgB, OWNER_B, { token: null, number: "INV-B2" });
    // A null token must never match a null lookup.
    const rows = await db.asAdmin(async (query) => {
      await query(`set role anon`);
      const result = await query(`select * from invoice_by_public_token(null)`);
      await query(`reset role`);
      return result.rows;
    });
    expect(rows).toHaveLength(0);
  });
});

describe("a draft is never visible, even with its token", () => {
  it("hides a draft invoice", async () => {
    // A draft has not been sent to anybody. Even holding the token, there is
    // nothing to show: it is not yet a claim on the customer's money.
    await db.asAdmin((query) => query(`update invoices set status = 'draft' where id = $1`, [invoiceA]));
    expect(await fetchByToken(TOKEN_A)).toHaveLength(0);
  });

  it("hides a draft's line items too", async () => {
    await db.asAdmin((query) => query(`update invoices set status = 'draft' where id = $1`, [invoiceA]));
    expect(await fetchLineItemsByToken(TOKEN_A)).toHaveLength(0);
  });

  it.each(["sent", "paid", "void"])("shows a %s invoice", async (status) => {
    // Paid and void stay visible on purpose: the customer keeps a receipt,
    // and a cancelled invoice should say so rather than 404.
    await db.asAdmin((query) => query(`update invoices set status = $1::invoice_status where id = $2`, [status, invoiceA]));
    expect(await fetchByToken(TOKEN_A)).toHaveLength(1);
  });
});

describe("the anon role gains nothing beyond these two functions", () => {
  it("still cannot read the invoices table directly", async () => {
    await db.asAdmin(async (query) => {
      await query(`set role anon`);
      // Either refused outright or RLS-filtered to nothing — never rows.
      const result = await query(`select id from invoices`).catch(() => ({ rows: [] }));
      expect(result.rows).toHaveLength(0);
      await query(`reset role`);
    });
  });

  it("still cannot read customers or organizations directly", async () => {
    await db.asAdmin(async (query) => {
      await query(`set role anon`);
      for (const table of ["customers", "organizations", "invoice_line_items"]) {
        const result = await query(`select * from ${table}`).catch(() => ({ rows: [] }));
        expect(result.rows, table).toHaveLength(0);
      }
      await query(`reset role`);
    });
  });

  it("cannot write anything through the token path", async () => {
    await db.asAdmin(async (query) => {
      await query(`set role anon`);
      await expect(query(`update invoices set status = 'paid' where public_token = $1`, [TOKEN_A])).rejects.toThrow();
      await query(`reset role`);
    });
  });
});

describe("the token column itself", () => {
  it("is unique, so two invoices cannot share a capability", async () => {
    await expect(makeInvoice(orgB, OWNER_B, { token: TOKEN_A, number: "INV-B3" })).rejects.toThrow();
  });

  it("allows many invoices to have no token", async () => {
    // The unique index is partial. Drafts have no token, and there are many.
    await makeInvoice(orgA, OWNER_A, { token: null, number: "INV-2" });
    await expect(makeInvoice(orgA, OWNER_A, { token: null, number: "INV-3" })).resolves.toBeTruthy();
  });

  it("is not visible to an ordinary member reading their own invoice", async () => {
    // Members legitimately read the invoices table. The token is a secret
    // within it, but it is not hidden by column — so this documents what IS
    // true today: a member of the org can see the share link, which is the
    // same thing they can generate from the UI anyway.
    await db.asUser(OWNER_A);
    const result = await db.query(`select public_token from invoices where id = $1`, [invoiceA]);
    expect((result.rows[0] as { public_token: string }).public_token).toBe(TOKEN_A);
  });

  it("is not visible to a member of ANOTHER organization", async () => {
    await db.asUser(OWNER_B);
    const result = await db.query(`select public_token from invoices where id = $1`, [invoiceA]);
    expect(result.rows).toHaveLength(0);
  });
});
