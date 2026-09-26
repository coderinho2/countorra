import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

/**
 * LIVE AnalyzeID. Opt-in, document-supplied, and skipped by default.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE OTHER LIVE TEST
 *
 * The rest of the live suite runs against a 1x1 PNG generated in-process:
 * synthetic, worthless, safe to keep in the repository. AnalyzeID cannot be
 * proven that way. It returns nothing for a blank image, so the only thing
 * that exercises it is a REAL government document — somebody's real licence
 * or passport, with their real name, address, date of birth and document
 * number on it.
 *
 * That is why this file exists on its own terms:
 *
 *   - NO FIXTURE IS COMMITTED, and none ever should be. The document is
 *     supplied at run time, by path, by the person who owns it.
 *   - NOTHING IS WRITTEN. The bytes are read into memory, sent once, and
 *     dropped. No copy, no cache, no report file, no Supabase row.
 *   - NOTHING IS PRINTED BUT SHAPE. Field TYPE names ("LAST_NAME"), counts
 *     and booleans are printed. No value is, ever — not a name, not a number,
 *     not a date, not an address, not an MRZ line. The assertions below are
 *     written so that a failure names a field KEY and never its content.
 *   - The path itself is not printed either. A file called
 *     "jane-passport.jpg" is a disclosure.
 *
 * HOW TO RUN IT
 *
 *   $env:TEXTRACT_LIVE="1"
 *   $env:TEXTRACT_TEST_ID_IMAGE="C:\temp\test-id.jpg"
 *   npx.cmd vitest run tests/textract-live
 *
 * With no image set, the live cases SKIP — they never fail for the absence of
 * a document nobody should have to provide. Both variables must be real
 * environment variables of the command; the runner loads no .env file.
 *
 * WHAT IT PROVES
 *
 * That the IAM policy actually permits textract:AnalyzeID, that a real
 * response still fits `identityPayloadSchema`, and — the part that matters
 * most — that `normalizeIdentity` throws all the sensitive fields away when
 * given a genuine document rather than a hand-written fixture.
 */

const optedIn = process.env.TEXTRACT_LIVE === "1";
const configured = Boolean(process.env.AWS_REGION);
const imagePath = process.env.TEXTRACT_TEST_ID_IMAGE?.trim() ?? "";

/** Present means: set, exists, is a file, and is a format Textract reads. */
const image = resolveImage(imagePath);
/** Narrowed once here, so the live case does not re-derive it. */
const liveMimeType = image.ok ? image.mimeType : null;
const runLive = optedIn && configured && image.ok;

/** Shape only. Nothing here can carry a value from the document. */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

describe("the AnalyzeID gate", () => {
  it("explains what it is waiting for instead of failing", () => {
    if (runLive) {
      say("AnalyzeID live test: ARMED");
    } else if (!optedIn) {
      say("AnalyzeID live test: SKIPPED — TEXTRACT_LIVE is not 1");
    } else if (!configured) {
      say("AnalyzeID live test: SKIPPED — AWS_REGION is not set");
    } else {
      // The reason, never the path.
      say(`AnalyzeID live test: SKIPPED — ${image.ok ? "" : image.reason}`);
    }
    // Absence of a document is a valid state of this suite, not a failure.
    expect(typeof runLive).toBe("boolean");
  });
});

describe.runIf(runLive)("LIVE Amazon Textract AnalyzeID", () => {
  it("reads a real identity document and stores almost none of it", async () => {
    const { TextractProvider } = await import("@/server/documents/textract/provider");
    const { identityPayloadSchema, normalizeIdentity, DISCARDED_FIELDS } = await import("@/domain/documents/intelligence/identity");

    // Guaranteed by `runLive`; re-checked so the type is narrowed without a
    // cast, and so a future change to the gate cannot send `null` to AWS.
    if (!liveMimeType) throw new Error("no readable identity document was resolved");

    const bytes = new Uint8Array(readFileSync(imagePath));

    const raw = await new TextractProvider().extractStructured({
      bytes,
      mimeType: liveMimeType,
      kind: "IDENTITY",
      signal: AbortSignal.timeout(30_000),
    });

    // 1. The real response still fits the contract the product validates
    //    against. `.strict()` means an added AWS field fails here rather than
    //    reaching storage unexamined.
    const parsed = identityPayloadSchema.safeParse(raw);
    expect(parsed.success, "a real AnalyzeID response no longer fits identityPayloadSchema").toBe(true);
    if (!parsed.success) return;

    const payload = parsed.data;
    const returnedTypes = [...new Set(payload.fields.map((field) => field.type?.toUpperCase()).filter((type): type is string => Boolean(type)))].sort();

    say("");
    say("AWS authentication: SUCCESS");
    say("AnalyzeID call: SUCCESS");
    say(`Identity document detected: ${payload.fields.length > 0 ? "YES" : "NO"}`);
    say(`Field count: ${payload.fields.length}`);
    say(`Field types: [${returnedTypes.join(", ")}]`);

    // 2. Countorra's own decision, over the real response. This is the
    //    assertion a hand-written fixture cannot make: a genuine licence
    //    carries field types and formats nobody wrote down.
    const normalized = normalizeIdentity(payload);
    const keptKeys = [...new Set(normalized.fields.map((field) => field.fieldKey))].sort();

    say("");
    say(`Kept field count: ${normalized.fields.length}`);
    say(`Kept field keys: [${keptKeys.join(", ")}]`);
    say(`Discarded field types: [${[...normalized.discarded].sort().join(", ")}]`);
    say(`Warnings: [${[...normalized.warnings].sort().join(", ")}]`);
    say("No sensitive values displayed.");
    say("");

    // 3. Only allowlisted keys survive. A key outside this set means the
    //    allowlist grew without this test being reconsidered.
    const ALLOWED = ["document_class", "issuing_state", "expires_on", "issued_on", "document_number_present"];
    for (const key of keptKeys) expect(ALLOWED, `an unexpected field key reached storage: ${key}`).toContain(key);

    // 4. Every field is filed under IDENTITY, which is the section the
    //    assistant is never shown and no tax fact maps from.
    expect(normalized.fields.every((field) => field.section === "IDENTITY")).toBe(true);

    // 5. THE ONE THAT MATTERS. Nothing the provider returned under a
    //    discarded type may appear in anything that will be stored. Compared
    //    by content, so a value re-appearing under a different name is caught
    //    too. The comparison happens in memory; neither side is printed.
    const stored = normalized.fields.flatMap((field) => [field.rawValue, field.normalizedText].filter((value): value is string => Boolean(value)).map((value) => value.toLowerCase()));
    for (const field of payload.fields) {
      const type = field.type?.trim().toUpperCase() ?? "";
      const value = field.value?.text?.trim() ?? "";
      if (!DISCARDED_FIELDS.includes(type) || value.length < 3) continue;
      const needle = value.toLowerCase();
      // Named by TYPE. The value it refers to is never in the message.
      expect(stored.some((entry) => entry.includes(needle)), `a value the provider returned as ${type} reached a stored field`).toBe(false);
    }

    // 6. And the document number, if one was read, survives only as a mask.
    const numberField = normalized.fields.find((field) => field.fieldKey === "document_number_present");
    if (numberField) {
      expect(numberField.valueKind).toBe("PRESENCE");
      // Asserted as a BOOLEAN, deliberately. `expect(value).toMatch(...)`
      // prints the received value on failure — and the failure case here is
      // precisely "the document number was not masked", so the one run that
      // failed would print the number.
      const masked = /^•+\d{0,4}$/.test(numberField.rawValue ?? "");
      expect(masked, "a document number was stored without a mask").toBe(true);
    }

    // 7. A real document should yield at least one field. If AWS returned
    //    nothing, the document was not one it supports (see below) — reported
    //    rather than asserted, since that is a property of the file supplied.
    if (payload.fields.length === 0) {
      say("NOTE: AnalyzeID returned no fields. It reads US driver's licences");
      say("and US passports only — a national ID or a non-US document is");
      say("expected to come back empty. That is AWS's limit, not a failure.");
    }
  });
});

/**
 * What was supplied, without ever revealing what it was called.
 *
 * Every rejection is a SKIP reason, not an error: a missing or unreadable
 * file must never turn into a red test, because the default state of this
 * suite is "no identity document is available", and that is the correct
 * default.
 */
function resolveImage(path: string): { ok: true; mimeType: "image/jpeg" | "image/png" | "application/pdf" } | { ok: false; reason: string } {
  if (path.length === 0) return { ok: false, reason: "TEXTRACT_TEST_ID_IMAGE is not set" };
  if (!existsSync(path)) return { ok: false, reason: "TEXTRACT_TEST_ID_IMAGE points at nothing that exists" };
  if (!statSync(path).isFile()) return { ok: false, reason: "TEXTRACT_TEST_ID_IMAGE is not a file" };

  // AWS's synchronous ceiling. Checked here so an oversized file is a skip
  // with a clear reason rather than a billed call that fails at the service.
  const MAX_BYTES = 10 * 1024 * 1024;
  if (statSync(path).size > MAX_BYTES) return { ok: false, reason: "the file is over the 10 MB synchronous limit" };

  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return { ok: true, mimeType: "image/jpeg" };
    case ".png":
      return { ok: true, mimeType: "image/png" };
    case ".pdf":
      return { ok: true, mimeType: "application/pdf" };
    default:
      // TIFF is a Textract format but not one this product stores, so it is
      // not offered here either.
      return { ok: false, reason: "the file is not a JPEG, PNG or PDF" };
  }
}
