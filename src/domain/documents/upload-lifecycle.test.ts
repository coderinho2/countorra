import { describe, expect, it } from "vitest";
import {
  ABANDONED_UPLOAD_TTL_HOURS,
  VISIBLE_DOCUMENT_STATUSES,
  decideConfirmation,
  evaluateUpload,
} from "./upload-lifecycle";
import { MAX_UPLOAD_BYTES } from "./upload-limits";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HTML = new Uint8Array(Buffer.from("<!DOCTYPE html><script>alert(1)"));
const SVG = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">'));

const landed = (sizeBytes: number, header: Uint8Array) => ({ exists: true as const, sizeBytes, header });

describe("evaluateUpload", () => {
  it("accepts an object whose bytes match what was declared", () => {
    expect(evaluateUpload(landed(4096, PDF), "application/pdf")).toEqual({ outcome: "accept", sizeBytes: 4096 });
  });

  it("records the size Storage reported, not one supplied with the request", () => {
    // The declared size is not a parameter of this function at all. That is
    // the point: the only size that can be written to the row is the observed
    // one.
    const verdict = evaluateUpload(landed(999_999, PDF), "application/pdf");
    expect(verdict).toMatchObject({ outcome: "accept", sizeBytes: 999_999 });
  });

  describe("a failed upload cannot become a document", () => {
    it("rejects when nothing was ever uploaded to the signed URL", () => {
      const verdict = evaluateUpload({ exists: false }, "application/pdf");
      expect(verdict.outcome).toBe("reject");
    });

    it("rejects a zero-byte object", () => {
      // A PUT that opened and died leaves this behind. It is a row pointing at
      // an empty file, which is not a receipt.
      expect(evaluateUpload(landed(0, new Uint8Array()), "application/pdf").outcome).toBe("reject");
    });

    it("rejects a truncated object whose header never completed", () => {
      expect(evaluateUpload(landed(2, new Uint8Array([0x25, 0x50])), "application/pdf").outcome).toBe("reject");
    });
  });

  describe("the client's declared size is not the enforced one", () => {
    it("rejects an object larger than the limit, however it was declared", () => {
      // The interesting attack: declare 1 MB to pass the schema, then PUT
      // 500 MB. Only the observed size can catch that.
      const verdict = evaluateUpload(landed(MAX_UPLOAD_BYTES + 1, PDF), "application/pdf");
      expect(verdict.outcome).toBe("reject");
      if (verdict.outcome === "reject") expect(verdict.reason).toMatch(/20MB/);
    });

    it("accepts an object at exactly the limit", () => {
      expect(evaluateUpload(landed(MAX_UPLOAD_BYTES, PDF), "application/pdf").outcome).toBe("accept");
    });
  });

  describe("the client's declared type is not the enforced one", () => {
    it("rejects HTML stored as a PDF", () => {
      expect(evaluateUpload(landed(500, HTML), "application/pdf").outcome).toBe("reject");
    });

    it("rejects SVG whatever it claims to be", () => {
      expect(evaluateUpload(landed(500, SVG), "image/png").outcome).toBe("reject");
      expect(evaluateUpload(landed(500, SVG), "image/webp").outcome).toBe("reject");
    });

    it("rejects one allowed type stored under a different allowed type", () => {
      // A PNG served as application/pdf is content-type confusion, not a
      // harmless mismatch.
      expect(evaluateUpload(landed(500, PNG), "application/pdf").outcome).toBe("reject");
    });

    it("rejects an empty declared type, which is what a null column reads as", () => {
      expect(evaluateUpload(landed(500, PDF), "").outcome).toBe("reject");
    });
  });

  it("never leaks the detected type back to the caller", () => {
    const verdict = evaluateUpload(landed(500, PNG), "application/pdf");
    if (verdict.outcome === "reject") {
      expect(verdict.reason.toLowerCase()).not.toContain("png");
    }
  });

  it("checks existence before size and size before content", () => {
    // Ordering is observable through the messages, and it matters: a missing
    // object must not be reported as a bad file type.
    const missing = evaluateUpload({ exists: false }, "application/pdf");
    if (missing.outcome === "reject") expect(missing.reason).toMatch(/never finished/i);

    const oversized = evaluateUpload(landed(MAX_UPLOAD_BYTES + 1, HTML), "application/pdf");
    if (oversized.outcome === "reject") expect(oversized.reason).toMatch(/20MB/);
  });
});

describe("decideConfirmation", () => {
  it("verifies a pending upload", () => {
    expect(decideConfirmation("pending")).toEqual({ kind: "verify" });
  });

  it("is idempotent on an already-committed document", () => {
    // A retried confirm must not re-verify. Re-verifying would let a later
    // observation (a deleted object, say) demote a live document.
    expect(decideConfirmation("uploaded")).toEqual({ kind: "already_uploaded" });
  });

  it("does not let a rejected upload be retried into acceptance", () => {
    // If `rejected` returned to `verify`, the check would be advisory: upload
    // again against the same key and confirm until it passes.
    expect(decideConfirmation("rejected")).toEqual({ kind: "already_rejected" });
  });

  it.each(["processing", "processed", "failed", "needs_review", "", "PENDING", "nonsense"])(
    "refuses to act on %s",
    (status) => {
      expect(decideConfirmation(status)).toEqual({ kind: "not_confirmable" });
    },
  );

  it("treats both terminal states as terminal in both directions", () => {
    for (const status of ["uploaded", "rejected"]) {
      expect(decideConfirmation(status).kind).not.toBe("verify");
    }
  });
});

describe("visibility", () => {
  it("shows only committed documents", () => {
    expect([...VISIBLE_DOCUMENT_STATUSES]).toEqual(["uploaded"]);
  });

  it.each(["pending", "rejected", "processing", "failed"])("does not include %s", (status) => {
    expect(VISIBLE_DOCUMENT_STATUSES as readonly string[]).not.toContain(status);
  });
});

describe("the abandoned-upload TTL", () => {
  it("outlasts the signed URL's own validity, so the sweep cannot race an upload", () => {
    // Supabase signed upload URLs are valid for two hours. Reclaiming a row
    // before that window closes would delete an upload still legitimately in
    // progress.
    expect(ABANDONED_UPLOAD_TTL_HOURS).toBeGreaterThan(2);
  });

  it("is short enough that abandoned bytes are not paid for indefinitely", () => {
    expect(ABANDONED_UPLOAD_TTL_HOURS).toBeLessThanOrEqual(72);
  });
});
