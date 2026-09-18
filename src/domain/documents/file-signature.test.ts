import { describe, expect, it } from "vitest";
import { SIGNATURE_BYTES_NEEDED, detectMimeType, verifyFileSignature } from "./file-signature";

/** Real leading bytes for each accepted format. */
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

const HTML = [...Buffer.from("<!DOCTYPE html><script>alert(1)</script>")];
const SVG = [...Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')];
const ZIP = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00];
const ELF = [0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00];

const bytes = (values: number[]) => new Uint8Array(values);

describe("detectMimeType", () => {
  it.each([
    ["PDF", PDF, "application/pdf"],
    ["PNG", PNG, "image/png"],
    ["JPEG", JPEG, "image/jpeg"],
    ["WEBP", WEBP, "image/webp"],
  ])("recognises a real %s", (_label, input, expected) => {
    expect(detectMimeType(bytes(input))).toBe(expected);
  });

  it.each([
    ["HTML", HTML],
    ["SVG", SVG],
    ["ZIP", ZIP],
    ["an ELF binary", ELF],
    ["empty input", []],
    ["a single byte", [0x25]],
  ])("does not recognise %s", (_label, input) => {
    expect(detectMimeType(bytes(input))).toBeNull();
  });

  it("does not mistake a bare RIFF container for WEBP", () => {
    // RIFF also fronts WAV and AVI. The container tag at offset 8 is what
    // distinguishes them, which is why the prefix alone is not enough.
    const wav = [0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45];
    expect(detectMimeType(bytes(wav))).toBeNull();
  });

  it("accepts JPEG from any encoder, whose third marker byte varies", () => {
    expect(detectMimeType(bytes([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(detectMimeType(bytes([0xff, 0xd8, 0xff, 0xe1]))).toBe("image/jpeg");
  });

  it("reads only the prefix the checks need", () => {
    expect(SIGNATURE_BYTES_NEEDED).toBeGreaterThanOrEqual(12);
    expect(SIGNATURE_BYTES_NEEDED).toBeLessThanOrEqual(64);
  });
});

describe("verifyFileSignature", () => {
  it("accepts a file whose bytes match its claim", () => {
    expect(verifyFileSignature(bytes(PDF), "application/pdf")).toMatchObject({ ok: true, detected: "application/pdf" });
  });

  it("rejects HTML renamed as a PDF — the case the MIME allowlist could not catch", () => {
    const result = verifyFileSignature(bytes(HTML), "application/pdf");

    expect(result.ok).toBe(false);
    expect(result.detected).toBeNull();
  });

  it("rejects SVG, whatever it claims to be", () => {
    expect(verifyFileSignature(bytes(SVG), "image/png").ok).toBe(false);
    expect(verifyFileSignature(bytes(SVG), "image/webp").ok).toBe(false);
  });

  it("rejects a real allowed type stored under a DIFFERENT allowed type", () => {
    // Accepting "some allowed type" would let a PNG be served as a PDF —
    // content-type confusion in a smaller costume.
    const result = verifyFileSignature(bytes(PNG), "application/pdf");

    expect(result.ok).toBe(false);
    expect(result.detected).toBe("image/png");
  });

  it("rejects an executable claiming to be an image", () => {
    expect(verifyFileSignature(bytes(ELF), "image/jpeg").ok).toBe(false);
  });

  it("rejects a truncated file rather than guessing", () => {
    expect(verifyFileSignature(bytes([0x25, 0x50]), "application/pdf").ok).toBe(false);
  });

  it("never echoes the detected type back to the user", () => {
    // A probe should not learn what the server can identify.
    const result = verifyFileSignature(bytes(PNG), "application/pdf");

    expect(result.error).not.toContain("png");
    expect(result.error).not.toContain("PNG");
    expect(result.error).toMatch(/don't match its type/i);
  });

  it("gives an actionable message for an unrecognised file", () => {
    const result = verifyFileSignature(bytes(ZIP), "application/pdf");

    expect(result.error).toMatch(/PDF, PNG, JPEG or WEBP/);
  });

  it("accepts every allowed type when correctly claimed", () => {
    for (const [input, claim] of [
      [PDF, "application/pdf"],
      [PNG, "image/png"],
      [JPEG, "image/jpeg"],
      [WEBP, "image/webp"],
    ] as const) {
      expect(verifyFileSignature(bytes([...input]), claim).ok, claim).toBe(true);
    }
  });
});
