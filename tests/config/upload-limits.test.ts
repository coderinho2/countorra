import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, SERVER_ACTION_BODY_LIMIT } from "@/domain/documents/upload-limits";
import { uploadDocumentSchema } from "@/validation/schemas/document";

/**
 * DEP-02 regression.
 *
 * The bug was not that any single limit was wrong — it was that three
 * declarations of the same limit existed and only one of them was reachable.
 * `uploadDocumentSchema` allowed 20 MB, the dialog promised 20 MB, and Next
 * rejected the request at its 1 MB default before either could run.
 *
 * So these tests assert AGREEMENT, not values. A future edit that changes one
 * number without the others fails here rather than at a user's file picker.
 */

const ROOT = process.cwd();
const readSource = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");

describe("upload limit is declared once", () => {
  it("expresses the same number in bytes and in UI form", () => {
    expect(MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_UPLOAD_LABEL).toBe("20MB");
  });

  it("derives the label from the byte constant, not from a literal", () => {
    expect(Number(MAX_UPLOAD_LABEL.replace("MB", "")) * 1024 * 1024).toBe(MAX_UPLOAD_BYTES);
  });

  it("keeps the schema on the shared constant", () => {
    const schema = readSource("src/validation/schemas/document.ts");
    expect(schema).toContain("MAX_UPLOAD_BYTES");
    expect(schema).not.toMatch(/\d+\s*\*\s*1024\s*\*\s*1024/);
  });

  it("keeps the UI label on the shared constant", () => {
    const dialog = readSource("src/components/documents/upload-document-dialog.tsx");
    expect(dialog).toContain("MAX_UPLOAD_LABEL");
    expect(dialog).not.toMatch(/up to 20MB/);
  });
});

describe("the Server Action body limit is back down, because uploads left it", () => {
  const config = readSource("next.config.ts");

  it("no longer sizes Server Action bodies to fit a document", () => {
    // The 20 MB window was global — every authenticated action paid for it so
    // one upload path could work. Bytes now go straight to Storage, so the
    // window closes. A regression here silently re-widens every action.
    expect(SERVER_ACTION_BODY_LIMIT).toBe("1mb");
    expect(MAX_UPLOAD_BYTES).toBeGreaterThan(20 * 1024 * 1024 - 1);
  });

  it("still sets the limit explicitly rather than inheriting a default", () => {
    expect(config).toMatch(/serverActions/);
    expect(config).toContain("SERVER_ACTION_BODY_LIMIT");
    expect(config).not.toMatch(/bodySizeLimit:\s*["']\d+mb["']/);
  });

  it("does not route the upload ceiling into the framework config any more", () => {
    expect(config).not.toContain("MAX_UPLOAD_BYTES");
  });
});

describe("the schema enforces the limit it declares", () => {
  const base = {
    organizationId: "11111111-1111-4111-8111-111111111111",
    kind: "receipt" as const,
    originalFilename: "receipt.pdf",
    mimeType: "application/pdf" as const,
  };

  it("accepts a file at exactly the limit", () => {
    expect(uploadDocumentSchema.safeParse({ ...base, sizeBytes: MAX_UPLOAD_BYTES }).success).toBe(true);
  });

  it("rejects a file one byte over", () => {
    expect(uploadDocumentSchema.safeParse({ ...base, sizeBytes: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
  });

  it("accepts the sizes that used to fail at the framework boundary", () => {
    // 1 MB was the old silent ceiling. These sizes now bypass Server Actions
    // entirely, but the declared product limit must still admit them.
    for (const size of [1024 * 1024 + 1, 2 * 1024 * 1024, 10 * 1024 * 1024, 19 * 1024 * 1024]) {
      expect(uploadDocumentSchema.safeParse({ ...base, sizeBytes: size }).success, `${size} bytes`).toBe(true);
    }
  });

  it("still rejects an empty or negative size", () => {
    expect(uploadDocumentSchema.safeParse({ ...base, sizeBytes: 0 }).success).toBe(false);
    expect(uploadDocumentSchema.safeParse({ ...base, sizeBytes: -1 }).success).toBe(false);
  });

  it("still refuses a disallowed type regardless of size", () => {
    // Raising the size limit must not have widened the type allowlist.
    const svg = uploadDocumentSchema.safeParse({ ...base, mimeType: "image/svg+xml", sizeBytes: 1000 });
    const html = uploadDocumentSchema.safeParse({ ...base, mimeType: "text/html", sizeBytes: 1000 });

    expect(svg.success).toBe(false);
    expect(html.success).toBe(false);
  });
});
