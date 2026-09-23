import { describe, expect, it } from "vitest";
import { runProvider, type TextExtractionProvider } from "@/domain/documents/intelligence/provider";
import { decideProcessingRequest, currentIdentity, idempotencyKeyFor, isLeaseExpired, MAX_PROCESSING_ATTEMPTS, PROCESSING_LEASE_SECONDS, type JobSnapshot } from "@/domain/documents/intelligence/state-machine";
import { FAILURE_MESSAGES, isRetryableFailure, PERMANENT_FAILURES, type FailureCategory } from "@/domain/documents/intelligence/types";

/**
 * Reliability of the OCR path: what happens when the reader misbehaves.
 *
 * Every case here costs money when it is wrong. A retry loop against a
 * document the reader has already rejected is three billed calls for one
 * answer; a lost lease is a document that can never be read again; a
 * duplicate run is two extractions of the same evidence that then disagree.
 */

const PROVIDER = { id: "amazon-textract", version: "2026.1" };
const identity = currentIdentity("doc-1", PROVIDER);
const KEY = idempotencyKeyFor(identity);
const NOW = new Date("2026-09-23T12:00:00.000Z");

const job = (over: Partial<JobSnapshot> = {}): JobSnapshot => ({
  id: "job-1",
  status: "FAILED",
  attempts: 1,
  maxAttempts: MAX_PROCESSING_ATTEMPTS,
  idempotencyKey: KEY,
  startedAt: null,
  ...over,
});

/** A provider that fails in a chosen way, and classifies it the way the
 *  Textract adapter does. */
const failing = (error: unknown, category?: FailureCategory): TextExtractionProvider => ({
  id: PROVIDER.id,
  version: PROVIDER.version,
  method: "OCR",
  supports: () => true,
  extractText: async () => {
    throw error;
  },
  classifyError: () => (category ?? "PROVIDER_ERROR") as never,
});

describe("provider failures become stable internal categories", () => {
  it("asks the adapter to classify, and never returns the error itself", async () => {
    const awsError = Object.assign(new Error("AccessDenied: arn:aws:iam::123456789012:user/x; request id 9f2c"), { name: "AccessDeniedException" });
    const outcome = await runProvider(failing(awsError, "PROVIDER_AUTH_ERROR"), { bytes: new Uint8Array(4), mimeType: "image/png" });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.category).toBe("PROVIDER_AUTH_ERROR");
    expect(JSON.stringify(outcome)).not.toMatch(/arn:aws|123456789012|9f2c|AccessDenied/);
  });

  it("falls back to PROVIDER_ERROR for a provider that cannot classify", async () => {
    const provider = failing(new Error("boom"));
    delete (provider as { classifyError?: unknown }).classifyError;
    const outcome = await runProvider(provider, { bytes: new Uint8Array(4), mimeType: "image/png" });
    expect(outcome.ok === false && outcome.category).toBe("PROVIDER_ERROR");
  });

  it("does not let a broken classifier turn a read failure into a crash", async () => {
    const provider: TextExtractionProvider = {
      ...failing(new Error("boom")),
      classifyError: () => {
        throw new Error("classifier itself is broken");
      },
    };
    const outcome = await runProvider(provider, { bytes: new Uint8Array(4), mimeType: "image/png" });
    expect(outcome.ok === false && outcome.category).toBe("PROVIDER_ERROR");
  });

  it("reports a timeout as a timeout, not as whatever the provider threw", async () => {
    const provider: TextExtractionProvider = {
      id: PROVIDER.id,
      version: PROVIDER.version,
      method: "OCR",
      supports: () => true,
      extractText: () => new Promise(() => {}),
      classifyError: () => "PROVIDER_AUTH_ERROR",
    };
    const outcome = await runProvider(provider, { bytes: new Uint8Array(4), mimeType: "image/png" }, 25);
    expect(outcome.ok === false && outcome.category).toBe("PROVIDER_TIMEOUT");
  });

  it("rejects a response that does not fit the contract, without believing any of it", async () => {
    const provider: TextExtractionProvider = {
      id: PROVIDER.id,
      version: PROVIDER.version,
      method: "OCR",
      supports: () => true,
      extractText: async () => ({ provider: "amazon-textract", providerVersion: "2026.1", method: "OCR", pageCount: 1, pages: [{ pageNumber: 1, lines: [{ text: "x", position: null, confidence: 42 }] }], warnings: [] }),
    };
    const outcome = await runProvider(provider, { bytes: new Uint8Array(4), mimeType: "image/png" });
    expect(outcome.ok === false && outcome.category).toBe("MALFORMED_PROVIDER_RESPONSE");
  });

  it("refuses a result claiming to come from a different reader than the one that ran", async () => {
    const provider: TextExtractionProvider = {
      id: PROVIDER.id,
      version: PROVIDER.version,
      method: "OCR",
      supports: () => true,
      extractText: async () => ({ provider: "some-other-reader", providerVersion: "9", method: "OCR", pageCount: 0, pages: [], warnings: [] }),
    };
    const outcome = await runProvider(provider, { bytes: new Uint8Array(4), mimeType: "image/png" });
    expect(outcome.ok === false && outcome.category).toBe("MALFORMED_PROVIDER_RESPONSE");
  });
});

describe("retries are bounded by cause, not only by budget", () => {
  it("retries a transient failure while attempts remain", () => {
    for (const category of ["PROVIDER_THROTTLED", "PROVIDER_UNAVAILABLE", "PROVIDER_TIMEOUT", "DOCUMENT_UNAVAILABLE", "LEASE_EXPIRED", "INTERNAL_ERROR"] as const) {
      expect(isRetryableFailure(category), category).toBe(true);
      expect(decideProcessingRequest([job({ failureCategory: category })], identity, NOW), category).toEqual({ kind: "retry", jobId: "job-1" });
    }
  });

  it("does NOT retry a failure another attempt cannot change", () => {
    for (const category of PERMANENT_FAILURES) {
      expect(isRetryableFailure(category), category).toBe(false);
      // Attempts remain (1 of 3) and it still refuses: the budget is not the
      // reason, the cause is.
      expect(decideProcessingRequest([job({ failureCategory: category, attempts: 1 })], identity, NOW), category).toEqual({
        kind: "permanently_failed",
        jobId: "job-1",
        category,
      });
    }
  });

  it("treats an unclassified failure as transient, which is the recoverable direction", () => {
    expect(decideProcessingRequest([job({ failureCategory: null })], identity, NOW)).toEqual({ kind: "retry", jobId: "job-1" });
    expect(decideProcessingRequest([job({ failureCategory: undefined })], identity, NOW)).toEqual({ kind: "retry", jobId: "job-1" });
  });

  it("stops at the attempt ceiling even for a transient failure", () => {
    expect(decideProcessingRequest([job({ failureCategory: "PROVIDER_THROTTLED", attempts: MAX_PROCESSING_ATTEMPTS })], identity, NOW)).toEqual({
      kind: "attempts_exhausted",
      jobId: "job-1",
    });
  });

  it("gives every category a sentence, and none of them names the vendor", () => {
    for (const [category, message] of Object.entries(FAILURE_MESSAGES)) {
      expect(message.length, category).toBeGreaterThan(10);
      expect(message, category).not.toMatch(/textract|aws|amazon|s3|arn|exception|null|undefined/i);
    }
  });
});

describe("the same document is never read twice into conflicting results", () => {
  it("returns the existing result rather than running again", () => {
    for (const status of ["SUCCEEDED", "PARTIAL", "REVIEW_REQUIRED", "UNSUPPORTED"] as const) {
      expect(decideProcessingRequest([job({ status })], identity, NOW), status).toEqual({ kind: "already_processed", jobId: "job-1", status });
    }
  });

  it("refuses to start a second run while one holds a live lease", () => {
    const live = job({ status: "PROCESSING", startedAt: new Date(NOW.getTime() - 10_000).toISOString() });
    expect(decideProcessingRequest([live], identity, NOW)).toEqual({ kind: "in_progress", jobId: "job-1" });
  });

  it("keys the job on the document, the rules and the reader together", () => {
    // A different reader is a different read, so it gets its own job and its
    // own extraction rather than overwriting the first.
    const other = idempotencyKeyFor({ ...identity, provider: "pdf-text-layer" });
    expect(other).not.toBe(KEY);
    expect(decideProcessingRequest([job({ idempotencyKey: other, status: "SUCCEEDED" })], identity, NOW)).toEqual({ kind: "create" });
  });

  it("ignores jobs for other documents entirely", () => {
    expect(decideProcessingRequest([job({ idempotencyKey: idempotencyKeyFor({ ...identity, documentId: "doc-2" }) })], identity, NOW)).toEqual({ kind: "create" });
  });
});

describe("a crashed run is recoverable, not a dead end", () => {
  it("recovers a lease held past its expiry", () => {
    const stale = job({ status: "PROCESSING", startedAt: new Date(NOW.getTime() - (PROCESSING_LEASE_SECONDS + 5) * 1000).toISOString(), attempts: 1 });
    expect(decideProcessingRequest([stale], identity, NOW)).toEqual({ kind: "recover_expired", jobId: "job-1", canRetryAfter: true });
  });

  it("does not offer another attempt when the crash used the last one", () => {
    const stale = job({ status: "PROCESSING", startedAt: new Date(NOW.getTime() - (PROCESSING_LEASE_SECONDS + 5) * 1000).toISOString(), attempts: MAX_PROCESSING_ATTEMPTS });
    expect(decideProcessingRequest([stale], identity, NOW)).toEqual({ kind: "recover_expired", jobId: "job-1", canRetryAfter: false });
  });

  it("treats an unparseable start time as expired rather than as forever-running", () => {
    expect(isLeaseExpired({ status: "PROCESSING", startedAt: "not a date" }, NOW)).toBe(true);
  });

  it("holds the lease right up to the boundary", () => {
    const startedAt = new Date(NOW.getTime() - PROCESSING_LEASE_SECONDS * 1000 + 1).toISOString();
    expect(isLeaseExpired({ status: "PROCESSING", startedAt }, NOW)).toBe(false);
  });

  it("starts a job that was written but never began", () => {
    expect(decideProcessingRequest([job({ status: "QUEUED" })], identity, NOW)).toEqual({ kind: "start_existing", jobId: "job-1" });
  });
});
