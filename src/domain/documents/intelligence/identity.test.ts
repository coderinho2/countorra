import { describe, expect, it } from "vitest";
import { assertNoIdentifiers, DISCARDED_FIELDS, identityPayloadSchema, normalizeIdentity, redactIdentifier, type IdentityPayload } from "./identity";
import { DOCUMENT_TYPES, documentSensitivity, isIdentityDocument } from "./types";

/**
 * Identity documents.
 *
 * Every case here is about something NOT happening. The module's value is
 * what it refuses to keep, so the tests assert absence: no SSN in any form,
 * no document number, no name, no address, no MRZ.
 */

const field = (type: string, text: string, confidence = 0.99, normalizedValue: string | null = null) => ({
  type,
  value: { text, confidence, normalizedValue },
});

const payload = (fields: IdentityPayload["fields"]): IdentityPayload => ({ fields });

/** A full AnalyzeID response for a US driver's licence. */
const LICENCE = payload([
  field("FIRST_NAME", "ALEX"),
  field("LAST_NAME", "MORGAN"),
  field("MIDDLE_NAME", "J"),
  field("DATE_OF_BIRTH", "1990-04-12", 0.99, "1990-04-12"),
  field("ADDRESS", "142 Cedar Street, Apt 4"),
  field("CITY_IN_ADDRESS", "Sacramento"),
  field("ZIP_CODE_IN_ADDRESS", "95814"),
  field("DOCUMENT_NUMBER", "Y1234567"),
  field("EXPIRATION_DATE", "04/12/2030", 0.97, "2030-04-12"),
  field("DATE_OF_ISSUE", "04/12/2022", 0.97, "2022-04-12"),
  field("ID_TYPE", "DRIVER LICENSE FRONT"),
  field("STATE_IN_ADDRESS", "CA"),
  field("CLASS", "C"),
  field("ENDORSEMENTS", "NONE"),
  field("RESTRICTIONS", "NONE"),
  field("VETERAN", ""),
]);

describe("what is kept", () => {
  const { fields } = normalizeIdentity(LICENCE);
  const keys = fields.map((entry) => entry.fieldKey).sort();

  it("keeps only the small allowlist", () => {
    expect(keys).toEqual(["document_class", "document_number_present", "expires_on", "issued_on", "issuing_state"]);
  });

  it("files every one of them under IDENTITY, which is never proposable", () => {
    expect(fields.every((entry) => entry.section === "IDENTITY")).toBe(true);
  });

  it("reads the dates Textract normalized", () => {
    expect(fields.find((entry) => entry.fieldKey === "expires_on")?.normalizedDate).toBe("2030-04-12");
    expect(fields.find((entry) => entry.fieldKey === "issued_on")?.normalizedDate).toBe("2022-04-12");
  });

  it("carries no money, ever", () => {
    expect(fields.every((entry) => entry.amountMinor === null && entry.normalizedDecimal === null && entry.currency === null)).toBe(true);
  });
});

describe("what is discarded", () => {
  const { fields, discarded, warnings } = normalizeIdentity(LICENCE);
  const stored = JSON.stringify(fields);

  it("stores no name", () => {
    expect(stored).not.toMatch(/ALEX|MORGAN/i);
  });

  it("stores no date of birth", () => {
    expect(stored).not.toContain("1990-04-12");
  });

  it("stores no address", () => {
    expect(stored).not.toMatch(/Cedar Street|Sacramento|95814/i);
  });

  it("stores no document number", () => {
    expect(stored).not.toContain("Y1234567");
    expect(stored).not.toContain("1234567");
  });

  it("records WHICH field types were dropped, and never their values", () => {
    expect(discarded).toEqual(expect.arrayContaining(["FIRST_NAME", "LAST_NAME", "DATE_OF_BIRTH", "ADDRESS"]));
    expect(JSON.stringify(discarded)).not.toMatch(/ALEX|Cedar/i);
    expect(warnings).toContain("IDENTIFIERS_NOT_STORED");
  });

  it("names every refused field type explicitly, so the refusal is reviewable", () => {
    for (const type of ["MRZ_CODE", "DATE_OF_BIRTH", "ADDRESS", "FIRST_NAME", "LAST_NAME"]) {
      expect(DISCARDED_FIELDS, type).toContain(type);
    }
  });

  it("drops a passport MRZ, which would otherwise smuggle the whole document in", () => {
    const { fields: passportFields } = normalizeIdentity(payload([field("MRZ_CODE", "P<USAMORGAN<<ALEX<J<<<<<<<<<<<<<<<<<<<<<<<<<<"), field("ID_TYPE", "PASSPORT")]));
    expect(JSON.stringify(passportFields)).not.toMatch(/MORGAN|P<USA/);
  });
});

describe("identifier redaction", () => {
  it("keeps a masked tail of a document number", () => {
    expect(redactIdentifier("Y1234567")).toEqual({ display: "••••4567", present: true });
  });

  it("keeps NO digits of anything SSN-shaped", () => {
    for (const value of ["123-45-6789", "123 45 6789", "123456789"]) {
      const result = redactIdentifier(value);
      expect(result?.display, value).toBe("•••••••••");
      expect(result?.display, value).not.toMatch(/\d/);
    }
  });

  it("masks a short identifier rather than revealing it whole", () => {
    expect(redactIdentifier("A12")).toEqual({ display: "••••", present: true });
  });

  it("returns nothing for an empty reading", () => {
    expect(redactIdentifier("   ")).toBeNull();
  });

  it("stores the document number only as a mask", () => {
    const { fields } = normalizeIdentity(payload([field("DOCUMENT_NUMBER", "Y1234567")]));
    const presence = fields.find((entry) => entry.fieldKey === "document_number_present");
    expect(presence?.valueKind).toBe("PRESENCE");
    expect(presence?.rawValue).toBe("••••4567");
  });

  it("stores an SSN-shaped document number with no digits at all", () => {
    const { fields } = normalizeIdentity(payload([field("DOCUMENT_NUMBER", "123-45-6789")]));
    expect(fields.find((entry) => entry.fieldKey === "document_number_present")?.rawValue).toBe("•••••••••");
  });
});

describe("the backstop", () => {
  it("throws rather than return an SSN-shaped value", () => {
    expect(() =>
      assertNoIdentifiers([
        { ...blankField(), fieldKey: "leaked", rawValue: "123-45-6789" },
      ]),
    ).toThrow(/SSN-shaped/);
  });

  it("throws rather than return more digits than a masked tail", () => {
    expect(() => assertNoIdentifiers([{ ...blankField(), fieldKey: "leaked", normalizedText: "1234567" }])).toThrow(/masked tail/);
  });

  it("allows a date, which is digits but not an identifier", () => {
    expect(() => assertNoIdentifiers([{ ...blankField(), valueKind: "DATE", rawValue: "2030-04-12" }])).not.toThrow();
  });

  it("allows a masked tail", () => {
    expect(() => assertNoIdentifiers([{ ...blankField(), rawValue: "••••4567" }])).not.toThrow();
  });

  it("runs over everything the normalizer returns", () => {
    // A state field carrying a long digit run is dropped before it could
    // reach the backstop, which is the belt the braces are behind.
    const { fields, discarded } = normalizeIdentity(payload([field("STATE_NAME", "CA 987654321")]));
    expect(fields).toHaveLength(0);
    expect(discarded).toContain("STATE_NAME");
  });
});

describe("sensitivity", () => {
  it("treats the four identity classes as identity, and nothing else", () => {
    const identity = DOCUMENT_TYPES.filter(isIdentityDocument);
    expect(identity.sort()).toEqual(["DRIVER_LICENSE", "GOVERNMENT_ID", "PASSPORT", "SSN_DOCUMENT"]);
  });

  it("defaults an unlisted type to FINANCIAL, which is the recoverable direction", () => {
    expect(documentSensitivity("RECEIPT")).toBe("FINANCIAL");
    expect(documentSensitivity("UNKNOWN")).toBe("FINANCIAL");
  });

  it("marks every identity result so the rest of the product can see it", () => {
    expect(normalizeIdentity(LICENCE).warnings).toContain("IDENTITY_DOCUMENT");
  });
});

describe("the payload is untrusted", () => {
  it("refuses unknown keys", () => {
    expect(identityPayloadSchema.safeParse({ fields: [], extra: 1 }).success).toBe(false);
  });

  it("refuses a confidence outside 0–1", () => {
    expect(identityPayloadSchema.safeParse({ fields: [field("ID_TYPE", "X", 99)] }).success).toBe(false);
  });

  it("ignores a field type it has never heard of rather than storing it", () => {
    const { fields, discarded } = normalizeIdentity(payload([field("BIOMETRIC_TEMPLATE", "some-value")]));
    expect(fields).toHaveLength(0);
    expect(discarded).toContain("BIOMETRIC_TEMPLATE");
  });
});

function blankField() {
  return {
    schemaId: "test",
    fieldKey: "field",
    label: "Field",
    section: "IDENTITY" as const,
    box: null,
    valueKind: "TEXT" as const,
    rawValue: null,
    normalizedDecimal: null,
    amountMinor: null,
    currency: null,
    currencySource: null,
    normalizedDate: null,
    normalizedText: null,
    reviewState: "HIGH_CONFIDENCE" as const,
    reviewReason: null,
    providerConfidence: null,
    pageNumber: null,
    lineIndex: null,
    position: null,
    method: "test",
  };
}
