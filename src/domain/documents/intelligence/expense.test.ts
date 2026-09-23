import { describe, expect, it } from "vitest";
import { expensePayloadSchema, MAX_LINE_ITEMS, MAX_REASONABLE_AMOUNT, normalizeExpense, reconciles, reviewStateForConfidence, type ExpensePayload } from "./expense";

/**
 * AnalyzeExpense normalization.
 *
 * The cases that matter are the ones where OCR is wrong in a way that looks
 * right: totals that do not add up, an amount with a stray digit, a card
 * number in a receipt footer.
 */

const field = (type: string, text: string, confidence = 0.99, currency: string | null = "USD") => ({
  type,
  label: null,
  value: { text, confidence },
  currency,
  pageNumber: 1,
});

const payload = (over: Partial<ExpensePayload> = {}): ExpensePayload => ({
  summaryFields: [],
  lineItems: [],
  ...over,
});

describe("summary fields", () => {
  it("reads a clean receipt into merchant, date and totals", () => {
    const { fields, currency } = normalizeExpense(
      payload({
        summaryFields: [
          field("VENDOR_NAME", "Northwind Coffee"),
          field("INVOICE_RECEIPT_DATE", "2026-03-04"),
          field("SUBTOTAL", "$20.00"),
          field("TAX", "$1.60"),
          field("TOTAL", "$21.60"),
        ],
      }),
    );

    expect(currency).toBe("USD");
    const by = (key: string) => fields.find((entry) => entry.fieldKey === key);
    expect(by("merchant")?.normalizedText).toBe("Northwind Coffee");
    expect(by("date")?.normalizedDate).toBe("2026-03-04");
    expect(by("total")?.normalizedDecimal).toBe("21.60");
    expect(by("total")?.amountMinor).toBe(2160);
    expect(by("total")?.currency).toBe("USD");
    expect(by("total")?.reviewState).toBe("HIGH_CONFIDENCE");
  });

  it("keeps no amount it could not parse, and says so", () => {
    const { fields } = normalizeExpense(payload({ summaryFields: [field("TOTAL", "twenty one dollars")] }));
    const total = fields.find((entry) => entry.fieldKey === "total");
    expect(total?.reviewState).toBe("UNREADABLE");
    expect(total?.amountMinor).toBeNull();
    expect(total?.normalizedDecimal).toBeNull();
  });

  it("refuses a negative total rather than storing it", () => {
    const { fields } = normalizeExpense(payload({ summaryFields: [field("TOTAL", "-40.00")] }));
    expect(fields.find((entry) => entry.fieldKey === "total")?.reviewState).toBe("UNREADABLE");
  });

  it("refuses an amount beyond any plausible personal receipt", () => {
    const { fields } = normalizeExpense(payload({ summaryFields: [field("TOTAL", String(MAX_REASONABLE_AMOUNT + 1))] }));
    expect(fields.find((entry) => entry.fieldKey === "total")?.reviewState).toBe("UNREADABLE");
  });

  it("records no currency when the provider stated none", () => {
    const { currency, warnings } = normalizeExpense(payload({ summaryFields: [field("TOTAL", "21.60", 0.99, null)] }));
    expect(currency).toBeNull();
    expect(warnings).toContain("CURRENCY_NOT_FOUND");
  });

  it("masks a card number that appears in a field", () => {
    const { fields, warnings } = normalizeExpense(payload({ summaryFields: [field("VENDOR_NAME", "STORE 4111 1111 1111 1111")] }));
    expect(warnings).toContain("SENSITIVE_VALUES_MASKED");
    const merchant = fields.find((entry) => entry.fieldKey === "merchant");
    expect(merchant?.rawValue).not.toMatch(/4111 1111 1111 1111/);
    expect(merchant?.rawValue).toMatch(/1111$/);
  });

  it("takes the first reading when a label appears twice", () => {
    const { fields } = normalizeExpense(payload({ summaryFields: [field("TOTAL", "21.60"), field("TOTAL", "99.99")] }));
    expect(fields.filter((entry) => entry.fieldKey === "total")).toHaveLength(1);
    expect(fields.find((entry) => entry.fieldKey === "total")?.normalizedDecimal).toBe("21.60");
  });
});

describe("the arithmetic rule", () => {
  it("flags a receipt whose parts do not add up, and changes nothing", () => {
    const { fields, warnings } = normalizeExpense(
      payload({ summaryFields: [field("SUBTOTAL", "20.00"), field("TAX", "5.00"), field("TOTAL", "40.00")] }),
    );

    expect(warnings).toContain("TOTALS_INCONSISTENT");
    // Every value survives exactly as it was read. This is the case the whole
    // module exists for: 20 + 5 does not silently become the total.
    const by = (key: string) => fields.find((entry) => entry.fieldKey === key)?.normalizedDecimal;
    expect([by("subtotal"), by("tax"), by("total")]).toEqual(["20.00", "5.00", "40.00"]);
  });

  it("accepts a receipt that reconciles", () => {
    const { warnings } = normalizeExpense(payload({ summaryFields: [field("SUBTOTAL", "20.00"), field("TAX", "1.60"), field("TOTAL", "21.60")] }));
    expect(warnings).not.toContain("TOTALS_INCONSISTENT");
  });

  it("allows a cent of rounding, but not a dollar", () => {
    expect(reconciles(new Map([["subtotal", 2000], ["tax", 160], ["total", 2161]]))).toBe(true);
    expect(reconciles(new Map([["subtotal", 2000], ["tax", 160], ["total", 2260]]))).toBe(false);
  });

  it("subtracts a discount before comparing", () => {
    expect(reconciles(new Map([["subtotal", 2000], ["tax", 160], ["discount", 500], ["total", 1660]]))).toBe(true);
  });

  it("says nothing when a part is missing, because absence is not a conflict", () => {
    expect(reconciles(new Map([["total", 2160]]))).toBe(true);
    expect(reconciles(new Map([["subtotal", 2000], ["total", 9999]]))).toBe(true);
  });
});

describe("line items", () => {
  it("reads description, quantity and price into one reviewable row", () => {
    const { fields } = normalizeExpense(
      payload({ lineItems: [{ fields: [field("ITEM", "Flat white"), field("QUANTITY", "2"), field("UNIT_PRICE", "4.50"), field("PRICE", "9.00")] }] }),
    );
    const row = fields.find((entry) => entry.section === "LINE_ITEMS");
    expect(row?.normalizedText).toBe("Flat white");
    expect(row?.amountMinor).toBe(900);
    expect(row?.label).toContain("× 2");
    expect(row?.label).toContain("@ 4.50");
  });

  it("never rates a line item better than low confidence", () => {
    const { fields } = normalizeExpense(payload({ lineItems: [{ fields: [field("ITEM", "Flat white", 1), field("PRICE", "9.00", 1)] }] }));
    expect(fields.find((entry) => entry.section === "LINE_ITEMS")?.reviewState).toBe("LOW_CONFIDENCE");
  });

  it("drops a row that has neither a description nor a price", () => {
    const { fields } = normalizeExpense(payload({ lineItems: [{ fields: [field("QUANTITY", "2")] }] }));
    expect(fields.filter((entry) => entry.section === "LINE_ITEMS")).toHaveLength(0);
  });

  it("caps the rows it keeps and says it did", () => {
    const many = Array.from({ length: MAX_LINE_ITEMS + 5 }, (_, index) => ({ fields: [field("ITEM", `Item ${index}`), field("PRICE", "1.00")] }));
    const { fields, warnings } = normalizeExpense(payload({ lineItems: many }));
    expect(fields.filter((entry) => entry.section === "LINE_ITEMS")).toHaveLength(MAX_LINE_ITEMS);
    expect(warnings).toContain("PAGE_LIMIT_REACHED");
  });
});

describe("confidence", () => {
  it("is conservative about what counts as cleanly read", () => {
    expect(reviewStateForConfidence(0.99)).toBe("HIGH_CONFIDENCE");
    expect(reviewStateForConfidence(0.9)).toBe("MEDIUM_CONFIDENCE");
    expect(reviewStateForConfidence(0.5)).toBe("LOW_CONFIDENCE");
    // An unreported confidence is never treated as a good one.
    expect(reviewStateForConfidence(null)).toBe("LOW_CONFIDENCE");
  });
});

describe("the payload is untrusted", () => {
  it("refuses a confidence outside 0–1", () => {
    expect(expensePayloadSchema.safeParse({ summaryFields: [field("TOTAL", "1.00", 97)], lineItems: [] }).success).toBe(false);
  });

  it("refuses unknown keys", () => {
    expect(expensePayloadSchema.safeParse({ summaryFields: [], lineItems: [], extra: true }).success).toBe(false);
  });

  it("accepts the shape the adapter actually produces", () => {
    expect(expensePayloadSchema.safeParse(payload({ summaryFields: [field("TOTAL", "1.00")] })).success).toBe(true);
  });
});
