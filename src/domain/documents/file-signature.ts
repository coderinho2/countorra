/**
 * Verifies that a file's BYTES match the type it claims to be.
 *
 * `uploadDocumentSchema` validates `mimeType` against an allowlist, but that
 * value comes from the browser, which derives it from the file extension. It
 * is a claim, not evidence: renaming `payload.html` to `receipt.pdf` produces
 * `application/pdf` and passes every check the product had.
 *
 * WHAT THIS ACTUALLY PREVENTS
 *
 * The allowlist already excludes `image/svg+xml`, which is the classic stored
 * XSS vector, so the immediate risk today is modest. It matters for two other
 * reasons:
 *
 *   - A document store is an input to a future OCR/extraction pipeline. That
 *     pipeline will hand these bytes to a parser, and parsers are where
 *     malformed-file vulnerabilities live. Establishing "the bytes are what
 *     they say" before that exists is much easier than retrofitting it after.
 *   - A signed download URL serves the stored `content-type`. A file stored as
 *     `application/pdf` whose bytes are HTML is a file the browser may
 *     eventually be persuaded to render.
 *
 * WHAT THIS IS NOT
 *
 * Not malware scanning. A genuine PDF containing a malicious payload passes
 * every check here, because it IS a PDF. Antivirus is a separate control and
 * remains unimplemented — reported, not silently implied.
 */

export type VerifiedMimeType = "application/pdf" | "image/png" | "image/jpeg" | "image/webp";

interface Signature {
  mimeType: VerifiedMimeType;
  /** Byte prefix. `null` matches any byte at that offset. */
  magic: (number | null)[];
  /** Extra bytes that must appear at a fixed offset, for containers whose
   *  prefix alone is ambiguous. */
  at?: { offset: number; bytes: number[] };
}

/** Longest prefix any signature needs, plus the WEBP offset check. */
export const SIGNATURE_BYTES_NEEDED = 16;

const SIGNATURES: Signature[] = [
  // %PDF-
  { mimeType: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // \x89PNG\r\n\x1a\n
  { mimeType: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // JPEG SOI + marker. The third byte varies by encoder, so it is wildcarded.
  { mimeType: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  // RIFF....WEBP — the size field sits between the two, so the container tag
  // has to be checked at its offset rather than as part of the prefix.
  { mimeType: "image/webp", magic: [0x52, 0x49, 0x46, 0x46], at: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
];

function matches(bytes: Uint8Array, signature: Signature): boolean {
  if (bytes.length < signature.magic.length) return false;

  for (let i = 0; i < signature.magic.length; i++) {
    const expected = signature.magic[i];
    if (expected !== null && bytes[i] !== expected) return false;
  }

  if (signature.at) {
    const { offset, bytes: tail } = signature.at;
    if (bytes.length < offset + tail.length) return false;
    for (let i = 0; i < tail.length; i++) {
      if (bytes[offset + i] !== tail[i]) return false;
    }
  }

  return true;
}

/** The type the bytes actually are, or `null` for anything unrecognised. */
export function detectMimeType(bytes: Uint8Array): VerifiedMimeType | null {
  return SIGNATURES.find((signature) => matches(bytes, signature))?.mimeType ?? null;
}

export interface SignatureCheck {
  ok: boolean;
  detected: VerifiedMimeType | null;
  /** Safe to show a user. Never echoes the filename or the bytes. */
  error?: string;
}

/**
 * Confirms the bytes are a recognised type AND that it is the type claimed.
 *
 * Both halves are required. Accepting "the bytes are some allowed type" would
 * let a PNG be stored and served as `application/pdf`, which is the same
 * content-type confusion in a smaller costume.
 */
export function verifyFileSignature(bytes: Uint8Array, claimedMimeType: string): SignatureCheck {
  const detected = detectMimeType(bytes);

  if (!detected) {
    return { ok: false, detected: null, error: "That file isn't a PDF, PNG, JPEG or WEBP. Please upload one of those formats." };
  }

  if (detected !== claimedMimeType) {
    // Deliberately does not name the detected type. A user who renamed a file
    // by accident is served by the generic message; one probing the allowlist
    // learns nothing about what the server can identify.
    return { ok: false, detected, error: "That file's contents don't match its type. Please re-save it and try again." };
  }

  return { ok: true, detected };
}
