import { describe, expect, it } from "vitest";
import { createToolRegistry } from "./registry";
import { parseToolInput, type AITool } from "./types";

/**
 * AI-02: the model cannot put a tax rate on an invoice.
 *
 * An invoice is a document a business sends to a customer and may be assessed
 * on. A rate the model recalled is not a tax determination — there is no
 * jurisdiction table in this product to check it against — so the write tool
 * simply does not accept one.
 *
 * The defence is layered rather than cosmetic, and each layer is asserted
 * separately below, because removing only the JSON Schema property would leave
 * the argument to arrive anyway: a JSON Schema is a description sent to the
 * model, not a validator.
 */

const tools = createToolRegistry(null as never);

function tool(name: string): AITool {
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`No such tool: ${name}`);
  return found;
}

const VALID = {
  customerId: "11111111-1111-4111-8111-111111111111",
  invoiceNumber: "INV-001",
  currency: "USD",
  issueDate: "2026-09-01",
  lineItems: [{ description: "Consulting", quantity: 2, unitPrice: "500.00" }],
};

describe("createDraftInvoice does not accept a tax rate", () => {
  it("does not advertise taxRate in the schema the model is shown", () => {
    expect(JSON.stringify(tool("createDraftInvoice").inputSchema)).not.toContain("taxRate");
  });

  it("tells the model plainly that it cannot set one", () => {
    const description = tool("createDraftInvoice").description;
    expect(description).toMatch(/cannot set a tax rate/i);
    expect(description).toMatch(/0%/);
  });

  it("strips a tax rate the model sends anyway", () => {
    // The layer that actually matters: Zod, not the advertised schema.
    const parsed = parseToolInput(tool("createDraftInvoice"), {
      ...VALID,
      lineItems: [{ description: "Consulting", quantity: 2, unitPrice: "500.00", taxRate: 8.25 }],
    }) as { lineItems: Record<string, unknown>[] };

    expect(parsed.lineItems[0]).not.toHaveProperty("taxRate");
    expect(JSON.stringify(parsed)).not.toContain("8.25");
  });

  it("strips a tax rate from every line, not just the first", () => {
    const parsed = parseToolInput(tool("createDraftInvoice"), {
      ...VALID,
      lineItems: [
        { description: "A", quantity: 1, unitPrice: "100.00", taxRate: 20 },
        { description: "B", quantity: 1, unitPrice: "200.00", taxRate: 5 },
      ],
    }) as { lineItems: Record<string, unknown>[] };

    for (const line of parsed.lineItems) expect(line).not.toHaveProperty("taxRate");
  });

  it("strips tax fields under other plausible names too", () => {
    const parsed = parseToolInput(tool("createDraftInvoice"), {
      ...VALID,
      lineItems: [{ description: "A", quantity: 1, unitPrice: "100.00", tax_rate: 20, vatRate: 19, taxPercent: 8 }],
    });

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("tax_rate");
    expect(serialized).not.toContain("vatRate");
    expect(serialized).not.toContain("taxPercent");
  });

  it("still creates a legitimate invoice with no tax involved", () => {
    const parsed = parseToolInput(tool("createDraftInvoice"), VALID) as {
      customerId: string;
      lineItems: { description: string; quantity: number; unitPrice: string }[];
    };

    expect(parsed.customerId).toBe(VALID.customerId);
    expect(parsed.lineItems).toEqual([{ description: "Consulting", quantity: 2, unitPrice: "500.00" }]);
  });

  it("keeps the confirmation gate — this is still a write tool", () => {
    // Stripping the rate must not have changed the tool's mode. If it ever
    // became a read tool it would execute without a human seeing it.
    expect(tool("createDraftInvoice").operationMode).toBe("write");
  });

  it("still rejects genuinely invalid input rather than silently repairing it", () => {
    expect(() => parseToolInput(tool("createDraftInvoice"), { ...VALID, customerId: "not-a-uuid" })).toThrow();
    expect(() => parseToolInput(tool("createDraftInvoice"), { ...VALID, lineItems: [] })).toThrow();
    expect(() => parseToolInput(tool("createDraftInvoice"), { ...VALID, lineItems: [{ description: "A", quantity: 1, unitPrice: "abc" }] })).toThrow();
  });
});

describe("the generic percentage calculators do not claim authority", () => {
  for (const name of ["calculateSalesTax", "calculateVAT"]) {
    it(`${name} marks its result as non-authoritative`, async () => {
      const result = (await tool(name).execute({ amount: "100.00", currency: "USD", ratePercent: 8.25 }, { organizationId: "o", userId: "u" })) as Record<
        string,
        unknown
      >;

      expect(result.authoritative).toBe(false);
      expect(result.rateSource).toBe("supplied_in_request");
    });

    it(`${name} shows jurisdiction and effective date as absent, not missing`, async () => {
      const result = (await tool(name).execute({ amount: "100.00", currency: "USD", ratePercent: 20 }, { organizationId: "o", userId: "u" })) as Record<
        string,
        unknown
      >;

      // Present-and-null so the two dimensions a real tax answer needs are
      // visibly unfilled rather than silently omitted.
      expect(result).toHaveProperty("jurisdiction", null);
      expect(result).toHaveProperty("effectiveDate", null);
    });

    it(`${name} still computes the arithmetic exactly`, async () => {
      const result = (await tool(name).execute({ amount: "100.00", currency: "USD", ratePercent: 20 }, { organizationId: "o", userId: "u" })) as Record<
        string,
        { amountMinor: number }
      >;
      const amount = (result.tax ?? result.vat) as { amountMinor: number };

      expect(amount.amountMinor).toBe(2_000);
    });

    it(`${name} tells the model the rate was not looked up`, async () => {
      const result = (await tool(name).execute({ amount: "100.00", currency: "USD", ratePercent: 20 }, { organizationId: "o", userId: "u" })) as {
        disclaimer: string;
      };

      expect(result.disclaimer).toMatch(/not looked up/i);
      expect(result.disclaimer).toMatch(/never as the tax owed/i);
    });

    it(`${name} does not describe itself as knowing any rate`, () => {
      expect(tool(name).description).toMatch(/does not know/i);
    });
  }
});
