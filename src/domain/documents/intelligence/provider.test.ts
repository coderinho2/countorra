import { describe, expect, it } from "vitest";
import { MAX_TEXT_CHARS, resolveProvider, runProvider, type TextExtractionProvider } from "./provider";

/** AC, AD, AE: a provider is untrusted — malformed, slow and failing providers. */

function fake(extract: () => Promise<unknown>, overrides: Partial<TextExtractionProvider> = {}): TextExtractionProvider {
  return { id: "fixture-test-only", version: "1", method: "OCR", supports: () => true, extractText: extract, ...overrides };
}

const valid = {
  provider: "fixture-test-only",
  providerVersion: "1",
  method: "OCR",
  pageCount: 1,
  pages: [{ pageNumber: 1, lines: [{ text: "Total 12.00", position: { x: 10, y: 20, width: 100, height: 12, units: "pixels" }, confidence: 0.91 }] }],
  warnings: [],
};

const input = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" as const };

describe("runProvider", () => {
  it("accepts a result that conforms to the contract, keeping reported coordinates and confidence", async () => {
    const outcome = await runProvider(fake(async () => valid), input);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.result.pages[0].lines[0]).toEqual(valid.pages[0].lines[0]);
  });

  it.each([
    ["an unexpected field", { ...valid, secret: "x" }],
    ["a confidence above 1", { ...valid, pages: [{ pageNumber: 1, lines: [{ text: "x", position: null, confidence: 7 }] }] }],
    ["a line that is not text", { ...valid, pages: [{ pageNumber: 1, lines: [{ text: 42, position: null, confidence: null }] }] }],
    ["duplicate page numbers", { ...valid, pages: [valid.pages[0], valid.pages[0]] }],
    ["more text than the extraction limit", { ...valid, pages: Array.from({ length: 3 }, (_, i) => ({ pageNumber: i + 1, lines: Array.from({ length: 100 }, () => ({ text: "x".repeat(1000), position: null, confidence: null })) })) }],
    ["an unknown warning", { ...valid, warnings: ["TRUST_ME"] }],
    ["nothing at all", undefined],
  ])("rejects a response with %s as malformed", async (_label, response) => {
    expect(await runProvider(fake(async () => response), input)).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("rejects a result claiming to come from a different reader than the one that ran", async () => {
    expect(await runProvider(fake(async () => ({ ...valid, provider: "someone-else" })), input)).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
    expect(await runProvider(fake(async () => ({ ...valid, providerVersion: "2" })), input)).toMatchObject({ ok: false, category: "MALFORMED_PROVIDER_RESPONSE" });
  });

  it("reports a thrown error as a category, never the provider's message", async () => {
    const outcome = await runProvider(fake(async () => { throw new Error("api_key=sk-live-SECRET path=/bucket/org/123-45-6789.pdf"); }), input);
    expect(outcome).toMatchObject({ ok: false, category: "PROVIDER_ERROR" });
    expect(JSON.stringify(outcome)).not.toMatch(/SECRET|123-45-6789|bucket/);
  });

  it("abandons a provider that does not answer in time", async () => {
    const outcome = await runProvider(fake(() => new Promise(() => {})), input, 50);
    expect(outcome).toMatchObject({ ok: false, category: "PROVIDER_TIMEOUT" });
  });

  it("bounds the text a result may carry", () => {
    expect(MAX_TEXT_CHARS).toBeLessThanOrEqual(200_000);
  });
});

describe("resolveProvider", () => {
  const pdfOnly = fake(async () => valid, { supports: (mime) => mime === "application/pdf" });

  it("uses the reader that supports the file type", () => {
    expect(resolveProvider("application/pdf", [pdfOnly])).toMatchObject({ available: true });
  });

  it("says plainly that images need OCR which isn't configured — no stand-in reader", () => {
    const result = resolveProvider("image/jpeg", [pdfOnly]);
    expect(result).toMatchObject({ available: false, reason: "OCR_NOT_CONFIGURED" });
    if (!result.available) expect(result.message).toMatch(/none is configured/);
    expect(resolveProvider("image/png", [])).toMatchObject({ available: false });
  });
});
