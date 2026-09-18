import { describe, expect, it } from "vitest";
import { extensionFor, isKeyOwnedBy, storageKeyFor } from "./storage-key";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const OBJECT = "33333333-3333-4333-8333-333333333333";

/**
 * In Storage there is no `organization_id` column. The first path segment IS
 * the tenant boundary — `documents_storage_select_member` reads
 * `(storage.foldername(name))[1]` and nothing else. So every property here is
 * a tenancy property wearing a string-formatting costume.
 */
describe("storageKeyFor", () => {
  it("puts the object under the organization's prefix", () => {
    expect(storageKeyFor(ORG, OBJECT, "application/pdf")).toBe(`${ORG}/${OBJECT}.pdf`);
  });

  it("uses the validated MIME type for the extension, never a filename", () => {
    expect(storageKeyFor(ORG, OBJECT, "image/png").endsWith(".png")).toBe(true);
    expect(storageKeyFor(ORG, OBJECT, "image/jpeg").endsWith(".jpg")).toBe(true);
    expect(storageKeyFor(ORG, OBJECT, "image/webp").endsWith(".webp")).toBe(true);
  });

  it("produces exactly two segments, so the tenant prefix is unambiguous", () => {
    expect(storageKeyFor(ORG, OBJECT, "application/pdf").split("/")).toHaveLength(2);
  });

  it("produces a different key every time, since the object id is fresh", () => {
    const a = storageKeyFor(ORG, crypto.randomUUID(), "application/pdf");
    const b = storageKeyFor(ORG, crypto.randomUUID(), "application/pdf");
    expect(a).not.toBe(b);
  });

  it.each([
    ["a traversal segment", "../22222222-2222-4222-8222-222222222222"],
    ["another org's id with a suffix", `${OTHER_ORG}/x`],
    ["an empty string", ""],
    ["a bare word", "documents"],
    ["a SQL-ish payload", "1' or '1'='1"],
  ])("refuses to build a key from %s as the organization", (_label, value) => {
    expect(() => storageKeyFor(value, OBJECT, "application/pdf")).toThrow();
  });

  it("refuses a non-UUID object id, so no caller-supplied name can reach the path", () => {
    expect(() => storageKeyFor(ORG, "../../etc/passwd", "application/pdf")).toThrow();
    expect(() => storageKeyFor(ORG, "receipt.pdf", "application/pdf")).toThrow();
  });

  it("emits only the four known extensions", () => {
    const extensions = (["application/pdf", "image/png", "image/jpeg", "image/webp"] as const).map(extensionFor);
    expect(new Set(extensions)).toEqual(new Set(["pdf", "png", "jpg", "webp"]));
  });
});

describe("isKeyOwnedBy", () => {
  it("accepts a key under the organization's own prefix", () => {
    expect(isKeyOwnedBy(`${ORG}/${OBJECT}.pdf`, ORG)).toBe(true);
  });

  it("rejects another organization's key", () => {
    // The case that matters: a row read by id whose path points elsewhere.
    expect(isKeyOwnedBy(`${OTHER_ORG}/${OBJECT}.pdf`, ORG)).toBe(false);
  });

  it("rejects a key with extra depth, where the prefix check would still pass", () => {
    // `foldername()[1]` would read the ORG here, but the object is nested —
    // exactly the shape that makes prefix reasoning unreliable.
    expect(isKeyOwnedBy(`${ORG}/nested/${OBJECT}.pdf`, ORG)).toBe(false);
  });

  it("rejects traversal in the object segment", () => {
    expect(isKeyOwnedBy(`${ORG}/..`, ORG)).toBe(false);
    expect(isKeyOwnedBy(`${ORG}/../${OTHER_ORG}/x.pdf`, ORG)).toBe(false);
  });

  it("rejects a bare key with no prefix at all", () => {
    expect(isKeyOwnedBy("receipt.pdf", ORG)).toBe(false);
    expect(isKeyOwnedBy("", ORG)).toBe(false);
  });

  it("rejects an empty object segment", () => {
    expect(isKeyOwnedBy(`${ORG}/`, ORG)).toBe(false);
  });

  it("rejects when the organization id is not a UUID, rather than string-matching it", () => {
    expect(isKeyOwnedBy("x/y", "x")).toBe(false);
  });

  it("accepts every key its own builder produces", () => {
    for (const mime of ["application/pdf", "image/png", "image/jpeg", "image/webp"] as const) {
      expect(isKeyOwnedBy(storageKeyFor(ORG, crypto.randomUUID(), mime), ORG), mime).toBe(true);
    }
  });
});
