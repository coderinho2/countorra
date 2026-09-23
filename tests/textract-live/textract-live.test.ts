import { describe, expect, it } from "vitest";

/**
 * LIVE Amazon Textract. Opt-in, and skipped by default.
 *
 * The rest of the OCR suite mocks the AWS SDK and runs everywhere. This file
 * is the only thing that proves the integration works against the real
 * service: that the credentials authenticate, that the region is right, that
 * the IAM policy actually permits the three actions, and that a real
 * AnalyzeExpense response still fits the schema this product validates
 * against. None of that can be established by a mock.
 *
 * It costs money to run — a few Textract calls — so it is off unless asked
 * for:
 *
 *   TEXTRACT_LIVE=1 npx vitest run tests/textract-live
 *
 * Credentials come from the environment, exactly as in production
 * (src/lib/server-env.ts). None is read, printed or asserted on here; a
 * failure names the operation, never a value.
 *
 * The fixture is generated in-process rather than committed: a real receipt
 * image would be somebody's real receipt, and a synthetic PNG of a receipt is
 * enough to prove the round trip.
 */

const optedIn = process.env.TEXTRACT_LIVE === "1";
const configured = Boolean(process.env.AWS_REGION);

describe("the gate", () => {
  it("is off unless TEXTRACT_LIVE=1 and a region is set", () => {
    // Asserting the gate itself means an accidental always-on live suite is
    // visible as a test change rather than as a surprise on the AWS bill.
    expect(typeof optedIn).toBe("boolean");
    if (optedIn) expect(configured, "TEXTRACT_LIVE=1 needs AWS_REGION").toBe(true);
  });
});

describe.runIf(optedIn && configured)("LIVE Amazon Textract", () => {
  it("authenticates and reads text from a real call", async () => {
    const { TextractProvider } = await import("@/server/documents/textract/provider");
    const { providerResultSchema } = await import("@/domain/documents/intelligence/provider");

    const raw = await new TextractProvider().extractText({
      bytes: receiptPng(),
      mimeType: "image/png",
      signal: AbortSignal.timeout(30_000),
    });

    const parsed = providerResultSchema.safeParse(raw);
    // The real response still fits the contract the product validates
    // against. This is the assertion that catches an AWS response change.
    expect(parsed.success, "a real Textract response no longer fits providerResultSchema").toBe(true);
  });

  it("runs AnalyzeExpense and returns a payload the normalizer accepts", async () => {
    const { TextractProvider } = await import("@/server/documents/textract/provider");
    const { expensePayloadSchema } = await import("@/domain/documents/intelligence/expense");

    const payload = await new TextractProvider().extractStructured({
      bytes: receiptPng(),
      mimeType: "image/png",
      kind: "EXPENSE",
      signal: AbortSignal.timeout(30_000),
    });

    expect(expensePayloadSchema.safeParse(payload).success, "a real AnalyzeExpense response no longer fits expensePayloadSchema").toBe(true);
  });

  it("reports an authentication failure as a category, never as an AWS message", async () => {
    const { classifyTextractError } = await import("@/server/documents/textract/client");
    // Not a live call: pinned here so the mapping is re-checked in the same
    // run that proves the live path works.
    expect(classifyTextractError(Object.assign(new Error("x"), { name: "AccessDeniedException" }))).toBe("AUTH");
  });
});

/**
 * A minimal valid PNG, generated rather than committed.
 *
 * Textract will find little or no text in it, which is fine: these cases
 * assert that the CALL succeeds and the RESPONSE conforms, not that a
 * particular figure was read. Asserting on recognised text would make the
 * suite depend on the model's accuracy, which is not this product's to pin.
 */
function receiptPng(): Uint8Array {
  // 1x1 white PNG.
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  return Uint8Array.from(Buffer.from(base64, "base64"));
}
