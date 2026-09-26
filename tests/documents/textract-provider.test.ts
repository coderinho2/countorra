import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Amazon Textract adapter, with AWS mocked.
 *
 * NO AWS CREDENTIALS ARE NEEDED OR USED. The SDK is replaced wholesale, so
 * this suite runs offline on every machine and in CI. A separate, opt-in
 * live smoke test exists for the real service
 * (tests/textract-live/textract-live.test.ts).
 *
 * What is asserted here is the boundary: what the adapter sends, what it
 * makes of what comes back, and — most importantly — that nothing AWS says
 * escapes it.
 */

const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  /** Set to make the AWS environment unreadable, as a half key pair does. */
  envThrows: null as string | null,
  sent: [] as { command: string; input: unknown }[],
  respond: {} as Record<string, () => unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server-env", () => ({
  textractEnv: () => {
    if (state.envThrows) throw new Error(state.envThrows);
    return state.env;
  },
}));

vi.mock("@aws-sdk/client-textract", () => {
  class Command {
    constructor(readonly input: unknown) {}
    get name() {
      return this.constructor.name;
    }
  }
  return {
    TextractClient: class {
      constructor(readonly config: unknown) {}
      async send(command: Command) {
        state.sent.push({ command: command.constructor.name, input: command.input });
        const responder = state.respond[command.constructor.name];
        if (!responder) throw new Error(`no stub for ${command.constructor.name}`);
        return responder();
      }
    },
    DetectDocumentTextCommand: class DetectDocumentTextCommand extends Command {},
    AnalyzeExpenseCommand: class AnalyzeExpenseCommand extends Command {},
    AnalyzeIDCommand: class AnalyzeIDCommand extends Command {},
  };
});

const { TextractProvider } = await import("@/server/documents/textract/provider");
const { __resetTextractClientForTests, classifyTextractError, textractConfigured, TEXTRACT_MAX_BYTES } = await import("@/server/documents/textract/client");
const { providerResultSchema, runProvider } = await import("@/domain/documents/intelligence/provider");

const bytes = (length = 32) => new Uint8Array(length).fill(7);
const signal = new AbortController().signal;

const line = (text: string, confidence = 99) => ({
  BlockType: "LINE",
  Text: text,
  Confidence: confidence,
  Page: 1,
  Geometry: { BoundingBox: { Left: 0.1, Top: 0.2, Width: 0.3, Height: 0.04 } },
});

beforeEach(() => {
  state.env = { AWS_REGION: "us-east-1" };
  state.envThrows = null;
  state.sent = [];
  state.respond = {};
  __resetTextractClientForTests();
});

describe("configuration", () => {
  it("is off with no region, so images resolve to 'no reader'", () => {
    state.env = {};
    expect(textractConfigured()).toBe(false);
  });

  it("is on with a region alone, using the deployment's own IAM role", () => {
    expect(textractConfigured()).toBe(true);
  });

  it("is off when the AWS configuration cannot be read, rather than throwing", () => {
    // Half a key pair: refused by assertTextractConfigurationIsWhole, which
    // is the one failure that still reaches this path. An upload answers "no
    // reader is configured" instead of an AWS credential error.
    state.envThrows = "AWS credentials are partly configured";
    expect(() => textractConfigured()).not.toThrow();
    expect(textractConfigured()).toBe(false);
  });
});

describe("which files it will read", () => {
  const provider = new TextractProvider();

  it("reads PDF, PNG and JPEG", () => {
    for (const type of ["application/pdf", "image/png", "image/jpeg"] as const) expect(provider.supports(type), type).toBe(true);
  });

  it("does not read WEBP, which Textract does not accept", () => {
    expect(provider.supports("image/webp")).toBe(false);
  });
});

describe("generic text extraction", () => {
  it("maps lines, confidence and boxes into a valid provider result", async () => {
    state.respond.DetectDocumentTextCommand = () => ({ DocumentMetadata: { Pages: 1 }, Blocks: [line("NORTHWIND COFFEE"), line("TOTAL 21.60"), { BlockType: "WORD", Text: "ignored" }] });
    const provider = new TextractProvider();

    const raw = await provider.extractText({ bytes: bytes(), mimeType: "image/png", signal });
    const parsed = providerResultSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.method).toBe("OCR");
    expect(parsed.data.pages).toHaveLength(1);
    // WORD blocks are not lines and must not be duplicated into the text.
    expect(parsed.data.pages[0].lines.map((entry) => entry.text)).toEqual(["NORTHWIND COFFEE", "TOTAL 21.60"]);
    // Textract reports 0–100; everything downstream is 0–1.
    expect(parsed.data.pages[0].lines[0].confidence).toBeCloseTo(0.99);
    expect(parsed.data.pages[0].lines[0].position).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.04, units: "ratio" });
  });

  it("sends the bytes in the request, never an S3 reference", async () => {
    state.respond.DetectDocumentTextCommand = () => ({ Blocks: [line("x")] });
    await new TextractProvider().extractText({ bytes: bytes(), mimeType: "image/png", signal });
    const [call] = state.sent;
    expect(call.command).toBe("DetectDocumentTextCommand");
    expect(JSON.stringify(call.input)).not.toContain("S3Object");
  });

  it("says when it read only the first page of a multi-page file", async () => {
    state.respond.DetectDocumentTextCommand = () => ({ DocumentMetadata: { Pages: 6 }, Blocks: [line("page one")] });
    const result = (await new TextractProvider().extractText({ bytes: bytes(), mimeType: "application/pdf", signal })) as { warnings: string[] };
    expect(result.warnings).toContain("OCR_PAGE_LIMIT");
  });

  it("says when the image was hard to read", async () => {
    state.respond.DetectDocumentTextCommand = () => ({ DocumentMetadata: { Pages: 1 }, Blocks: [line("blurry", 40), line("text", 45)] });
    const result = (await new TextractProvider().extractText({ bytes: bytes(), mimeType: "image/jpeg", signal })) as { warnings: string[] };
    expect(result.warnings).toContain("OCR_LOW_CONFIDENCE");
  });

  it("refuses an oversized file as a result, not an error, and never calls AWS", async () => {
    const result = (await new TextractProvider().extractText({ bytes: bytes(TEXTRACT_MAX_BYTES + 1), mimeType: "image/png", signal })) as { warnings: string[]; pages: unknown[] };
    expect(result.warnings).toEqual(["OCR_FILE_TOO_LARGE"]);
    expect(result.pages).toEqual([]);
    expect(state.sent).toEqual([]);
  });
});

describe("the expense operation", () => {
  it("maps summary fields and line items into the payload shape", async () => {
    state.respond.AnalyzeExpenseCommand = () => ({
      ExpenseDocuments: [
        {
          SummaryFields: [{ Type: { Text: "TOTAL" }, ValueDetection: { Text: "21.60", Confidence: 99 }, Currency: { Code: "USD" }, PageNumber: 1 }],
          LineItemGroups: [{ LineItems: [{ LineItemExpenseFields: [{ Type: { Text: "ITEM" }, ValueDetection: { Text: "Flat white", Confidence: 97 } }] }] }],
        },
      ],
    });

    const payload = (await new TextractProvider().extractStructured({ bytes: bytes(), mimeType: "image/png", kind: "EXPENSE", signal })) as {
      summaryFields: { type: string; value: { confidence: number } }[];
      lineItems: { fields: { type: string }[] }[];
    };

    expect(state.sent[0].command).toBe("AnalyzeExpenseCommand");
    expect(payload.summaryFields[0].type).toBe("TOTAL");
    expect(payload.summaryFields[0].value.confidence).toBeCloseTo(0.99);
    expect(payload.lineItems[0].fields[0].type).toBe("ITEM");
  });

  it("returns an empty payload when Textract found no expense, rather than inventing one", async () => {
    state.respond.AnalyzeExpenseCommand = () => ({ ExpenseDocuments: [] });
    const payload = (await new TextractProvider().extractStructured({ bytes: bytes(), mimeType: "image/png", kind: "EXPENSE", signal })) as { summaryFields: unknown[] };
    expect(payload.summaryFields).toEqual([]);
  });
});

describe("the identity operation", () => {
  it("maps identity fields, including the normalized date", async () => {
    state.respond.AnalyzeIDCommand = () => ({
      IdentityDocuments: [
        {
          IdentityDocumentFields: [
            { Type: { Text: "EXPIRATION_DATE" }, ValueDetection: { Text: "04/12/2030", Confidence: 98, NormalizedValue: { Value: "2030-04-12T00:00:00" } } },
            { Type: { Text: "FIRST_NAME" }, ValueDetection: { Text: "ALEX", Confidence: 99 } },
          ],
        },
      ],
    });

    const payload = (await new TextractProvider().extractStructured({ bytes: bytes(), mimeType: "image/jpeg", kind: "IDENTITY", signal })) as {
      fields: { type: string; value: { normalizedValue: string | null } }[];
    };

    expect(state.sent[0].command).toBe("AnalyzeIDCommand");
    expect(payload.fields[0].value.normalizedValue).toBe("2030-04-12T00:00:00");
    // The adapter passes everything through; discarding is identity.ts's job,
    // and it is tested there.
    expect(payload.fields.map((entry) => entry.type)).toEqual(["EXPIRATION_DATE", "FIRST_NAME"]);
  });

  it("sends at most the pages AnalyzeID accepts, as bytes", async () => {
    state.respond.AnalyzeIDCommand = () => ({ IdentityDocuments: [] });
    await new TextractProvider().extractStructured({ bytes: bytes(), mimeType: "image/jpeg", kind: "IDENTITY", signal });
    const input = state.sent[0].input as { DocumentPages: unknown[] };
    expect(input.DocumentPages).toHaveLength(1);
    expect(JSON.stringify(input)).not.toContain("S3Object");
  });
});

describe("nothing from AWS escapes", () => {
  it("turns a provider failure into a category, dropping the AWS message", async () => {
    state.respond.DetectDocumentTextCommand = () => {
      const error = new Error("AccessDenied: arn:aws:iam::123456789012:user/countorra is not authorized; request id 9f2c");
      error.name = "AccessDeniedException";
      throw error;
    };

    const outcome = await runProvider(new TextractProvider(), { bytes: bytes(), mimeType: "image/png" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The adapter places it: an expired or wrong credential is an operator's
    // problem and is never worth retrying, which PROVIDER_ERROR could not say.
    expect(outcome.category).toBe("PROVIDER_AUTH_ERROR");
    // No account id, no ARN, no request id anywhere in what the caller gets.
    expect(JSON.stringify(outcome)).not.toMatch(/arn:aws|123456789012|9f2c/);
  });

  it("classifies the AWS errors worth telling apart", () => {
    const named = (name: string) => Object.assign(new Error("x"), { name });
    expect(classifyTextractError(named("ThrottlingException"))).toBe("THROTTLED");
    expect(classifyTextractError(named("AccessDeniedException"))).toBe("AUTH");
    expect(classifyTextractError(named("UnsupportedDocumentException"))).toBe("UNSUPPORTED");
    expect(classifyTextractError(named("DocumentTooLargeException"))).toBe("TOO_LARGE");
    expect(classifyTextractError(named("BadDocumentException"))).toBe("BAD_DOCUMENT");
    expect(classifyTextractError(named("InternalServerError"))).toBe("SERVICE");
    expect(classifyTextractError(named("SomethingNew"))).toBe("UNKNOWN");
    expect(classifyTextractError("not an error at all")).toBe("UNKNOWN");
  });

  it("abandons a read that runs past the deadline", async () => {
    state.respond.DetectDocumentTextCommand = () => new Promise(() => {});
    const outcome = await runProvider(new TextractProvider(), { bytes: bytes(), mimeType: "image/png" }, 30);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.category).toBe("PROVIDER_TIMEOUT");
  });
});
