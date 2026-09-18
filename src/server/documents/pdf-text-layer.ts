import "server-only";
import { inflateSync, constants as zlibConstants } from "node:zlib";
import type { VerifiedMimeType } from "@/domain/documents/file-signature";
import { MAX_LINE_LENGTH, MAX_LINES_PER_PAGE, MAX_PAGES, MAX_TEXT_CHARS, type ProviderLine, type ProviderResult, type TextExtractionInput, type TextExtractionProvider } from "@/domain/documents/intelligence/provider";
import type { ExtractionWarning } from "@/domain/documents/intelligence/types";

/**
 * PDF TEXT-LAYER READER — real extraction, and only what it truly does.
 *
 * A digital PDF (a W-2 exported by payroll software, a statement downloaded
 * from a bank) carries its text as text. This reads that text directly out of
 * the file: no network, no third party, no model, no OCR. The same bytes
 * always produce the same lines.
 *
 * WHAT IT CANNOT DO, AND SAYS SO
 *
 * A scan or a photo saved as a PDF has pictures of letters, not letters. For
 * those it returns no lines and the warning NO_TEXT_LAYER, and the job ends
 * UNSUPPORTED — reading pixels needs an OCR provider, which this build does
 * not have. Encrypted PDFs are refused the same way. It never guesses at text
 * it could not decode.
 *
 * WHY IT IS WRITTEN HERE RATHER THAN IMPORTED
 *
 * No PDF library is a dependency of this project, and the common ones are tens
 * of megabytes and include renderers, font engines and script interpreters —
 * a large attack surface for a job that needs to read text operators. This
 * reader handles the structures text-bearing PDFs actually use (FlateDecode
 * streams, object streams, the page tree, ToUnicode character maps, the text
 * operators) and treats everything else as unreadable.
 *
 * BOUNDED
 *
 * Every loop has a ceiling: inflated bytes per stream and in total, objects,
 * operators per page, pages, lines and characters. A malformed or hostile file
 * produces an error or a truncation warning, never an unbounded loop or an
 * unbounded allocation.
 */

export const PDF_TEXT_LAYER_PROVIDER = { id: "pdf-text-layer", version: "1.0.0" } as const;

const MAX_STREAM_INFLATED = 16 * 1024 * 1024;
const MAX_TOTAL_INFLATED = 48 * 1024 * 1024;
const MAX_OBJECTS = 50_000;
const MAX_OPERATORS_PER_PAGE = 250_000;
const MAX_PAGE_TREE_DEPTH = 32;

export class PdfTextLayerProvider implements TextExtractionProvider {
  readonly id = PDF_TEXT_LAYER_PROVIDER.id;
  readonly version = PDF_TEXT_LAYER_PROVIDER.version;
  readonly method = "PDF_TEXT_LAYER" as const;

  supports(mimeType: VerifiedMimeType): boolean {
    return mimeType === "application/pdf";
  }

  async extractText(input: TextExtractionInput): Promise<ProviderResult> {
    return readPdfTextLayer(input.bytes, input.signal);
  }
}

class PdfLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfLimitError";
  }
}

// ── Values ──────────────────────────────────────────────────────────────

type PdfValue = number | boolean | null | PdfName | PdfString | PdfRef | PdfValue[] | PdfDict;
class PdfName {
  constructor(readonly name: string) {}
}
class PdfString {
  /** Latin-1: one char per byte. */
  constructor(readonly bytes: string) {}
}
class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}
type PdfDict = Map<string, PdfValue>;

const isDict = (value: PdfValue | undefined): value is PdfDict => value instanceof Map;
const nameOf = (value: PdfValue | undefined): string | null => (value instanceof PdfName ? value.name : null);

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);

class Lexer {
  pos = 0;
  constructor(readonly src: string) {}

  private skipWhitespaceAndComments() {
    while (this.pos < this.src.length) {
      const code = this.src.charCodeAt(this.pos);
      if (WHITESPACE.has(code)) {
        this.pos++;
      } else if (code === 0x25) {
        while (this.pos < this.src.length && this.src[this.pos] !== "\n" && this.src[this.pos] !== "\r") this.pos++;
      } else {
        break;
      }
    }
  }

  /** The next token: a value, or an operator keyword as a string. */
  next(): PdfValue | { op: string } | undefined {
    this.skipWhitespaceAndComments();
    if (this.pos >= this.src.length) return undefined;
    const char = this.src[this.pos];

    if (char === "/") {
      this.pos++;
      let name = "";
      while (this.pos < this.src.length && !WHITESPACE.has(this.src.charCodeAt(this.pos)) && !DELIMITERS.has(this.src[this.pos])) {
        name += this.src[this.pos++];
      }
      return new PdfName(name.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    }
    if (char === "(") return this.literalString();
    if (char === "<") {
      if (this.src[this.pos + 1] === "<") {
        this.pos += 2;
        return this.dictionary();
      }
      return this.hexString();
    }
    if (char === "[") {
      this.pos++;
      const items: PdfValue[] = [];
      for (let guard = 0; guard < 1_000_000; guard++) {
        this.skipWhitespaceAndComments();
        if (this.pos >= this.src.length) break;
        if (this.src[this.pos] === "]") {
          this.pos++;
          break;
        }
        const value = this.value();
        if (value === undefined) break;
        items.push(value);
      }
      return items;
    }
    if (char === "]" || char === ")" || char === ">" || char === "{" || char === "}") {
      this.pos++;
      return { op: char };
    }

    let word = "";
    while (this.pos < this.src.length && !WHITESPACE.has(this.src.charCodeAt(this.pos)) && !DELIMITERS.has(this.src[this.pos])) {
      word += this.src[this.pos++];
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return Number(word);
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { op: word };
  }

  /** A value, resolving `n g R` into a reference. */
  value(): PdfValue | undefined {
    const token = this.next();
    if (token === undefined) return undefined;
    if (typeof token === "number" && Number.isInteger(token)) {
      const saved = this.pos;
      const gen = this.next();
      if (typeof gen === "number" && Number.isInteger(gen)) {
        const r = this.next();
        if (r && typeof r === "object" && "op" in r && r.op === "R") return new PdfRef(token, gen);
      }
      this.pos = saved;
      return token;
    }
    if (token !== null && typeof token === "object" && "op" in token) return null;
    return token as PdfValue;
  }

  private dictionary(): PdfDict {
    const dict: PdfDict = new Map();
    for (let guard = 0; guard < 100_000; guard++) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.src.length) break;
      if (this.src.startsWith(">>", this.pos)) {
        this.pos += 2;
        break;
      }
      const key = this.next();
      if (!(key instanceof PdfName)) {
        if (key === undefined) break;
        continue;
      }
      const value = this.value();
      if (value === undefined) break;
      dict.set(key.name, value);
    }
    return dict;
  }

  private literalString(): PdfString {
    this.pos++;
    let depth = 1;
    let out = "";
    while (this.pos < this.src.length && depth > 0) {
      const char = this.src[this.pos++];
      if (char === "\\") {
        const escaped = this.src[this.pos++];
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
        if (escaped in simple) out += simple[escaped];
        else if (/[0-7]/.test(escaped)) {
          let octal = escaped;
          while (octal.length < 3 && /[0-7]/.test(this.src[this.pos] ?? "")) octal += this.src[this.pos++];
          out += String.fromCharCode(parseInt(octal, 8) & 0xff);
        } else if (escaped === "\r") {
          if (this.src[this.pos] === "\n") this.pos++;
        } else if (escaped !== "\n") out += escaped;
      } else if (char === "(") {
        depth++;
        out += char;
      } else if (char === ")") {
        depth--;
        if (depth > 0) out += char;
      } else {
        out += char;
      }
    }
    return new PdfString(out);
  }

  private hexString(): PdfString {
    this.pos++;
    let hex = "";
    while (this.pos < this.src.length && this.src[this.pos] !== ">") {
      const char = this.src[this.pos++];
      if (/[0-9a-fA-F]/.test(char)) hex += char;
    }
    this.pos++;
    if (hex.length % 2 === 1) hex += "0";
    let out = "";
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    return new PdfString(out);
  }
}

// ── Objects ─────────────────────────────────────────────────────────────

interface PdfObject {
  value: PdfValue;
  /** Raw (still encoded) stream bytes, latin-1. */
  stream: string | null;
}

class PdfDocument {
  readonly objects = new Map<number, PdfObject>();
  private inflatedTotal = 0;
  warnings = new Set<ExtractionWarning>();

  constructor(
    readonly src: string,
    private readonly signal: AbortSignal,
  ) {}

  checkAborted() {
    if (this.signal.aborted) throw new PdfLimitError("aborted");
  }

  parse() {
    const header = /(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null;
    while ((match = header.exec(this.src)) !== null) {
      if (this.objects.size >= MAX_OBJECTS) throw new PdfLimitError("too many objects");
      const num = Number(match[1]);
      const lexer = new Lexer(this.src);
      lexer.pos = match.index + match[0].length;
      const value = lexer.value() ?? null;
      let stream: string | null = null;

      const afterValue = this.src.slice(lexer.pos, lexer.pos + 32);
      const streamKeyword = /^\s*stream(\r\n|\n|\r)/.exec(afterValue);
      if (streamKeyword && isDict(value)) {
        const dataStart = lexer.pos + streamKeyword[0].length;
        const declared = value.get("Length");
        let dataEnd = -1;
        if (typeof declared === "number" && declared >= 0 && dataStart + declared <= this.src.length && /^\s*endstream/.test(this.src.slice(dataStart + declared, dataStart + declared + 32))) {
          dataEnd = dataStart + declared;
        } else {
          dataEnd = this.src.indexOf("endstream", dataStart);
        }
        if (dataEnd < 0) break;
        stream = this.src.slice(dataStart, dataEnd);
        header.lastIndex = dataEnd;
      } else {
        header.lastIndex = lexer.pos;
      }
      this.objects.set(num, { value, stream });
    }
    this.expandObjectStreams();
  }

  private expandObjectStreams() {
    for (const object of [...this.objects.values()]) {
      if (!isDict(object.value) || nameOf(object.value.get("Type")) !== "ObjStm" || object.stream === null) continue;
      const decoded = this.decodeStream(object);
      if (decoded === null) continue;
      const count = object.value.get("N");
      const first = object.value.get("First");
      if (typeof count !== "number" || typeof first !== "number") continue;

      const lexer = new Lexer(decoded);
      const entries: [number, number][] = [];
      for (let i = 0; i < Math.min(count, MAX_OBJECTS); i++) {
        const num = lexer.next();
        const offset = lexer.next();
        if (typeof num !== "number" || typeof offset !== "number") break;
        entries.push([num, offset]);
      }
      for (const [num, offset] of entries) {
        if (this.objects.has(num)) continue;
        const inner = new Lexer(decoded);
        inner.pos = first + offset;
        const value = inner.value();
        if (value !== undefined) this.objects.set(num, { value, stream: null });
      }
    }
  }

  resolve(value: PdfValue | undefined, depth = 0): PdfValue | undefined {
    if (value instanceof PdfRef) {
      if (depth > 16) return undefined;
      return this.resolve(this.objects.get(value.num)?.value, depth + 1);
    }
    return value;
  }

  objectFor(value: PdfValue | undefined): PdfObject | undefined {
    return value instanceof PdfRef ? this.objects.get(value.num) : undefined;
  }

  decodeStream(object: PdfObject): string | null {
    if (object.stream === null || !isDict(object.value)) return null;
    const filterValue = this.resolve(object.value.get("Filter"));
    const filters = Array.isArray(filterValue) ? filterValue.map((f) => nameOf(this.resolve(f))) : filterValue ? [nameOf(filterValue)] : [];
    let data = object.stream;

    for (const filter of filters) {
      this.checkAborted();
      if (filter === "FlateDecode" || filter === "Fl") {
        const inflated = inflate(data);
        if (inflated === null) return null;
        this.inflatedTotal += inflated.length;
        if (this.inflatedTotal > MAX_TOTAL_INFLATED) throw new PdfLimitError("inflated size limit");
        data = inflated;
        const params = this.resolve(object.value.get("DecodeParms"));
        const predictor = isDict(params) ? params.get("Predictor") : undefined;
        if (typeof predictor === "number" && predictor >= 10) return null;
      } else if (filter === "ASCIIHexDecode" || filter === "AHx") {
        const hex = data.replace(/[^0-9a-fA-F]/g, "");
        let out = "";
        for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        data = out;
      } else {
        // Images (DCT, JPX, CCITT) and other encodings carry no text layer.
        return null;
      }
    }
    return data;
  }
}

function inflate(data: string): string | null {
  const buffer = Buffer.from(data, "latin1");
  try {
    return inflateSync(buffer, { maxOutputLength: MAX_STREAM_INFLATED }).toString("latin1");
  } catch {
    try {
      // Streams with a truncated or missing adler checksum are common.
      return inflateSync(buffer, { maxOutputLength: MAX_STREAM_INFLATED, finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("latin1");
    } catch {
      return null;
    }
  }
}

// ── Fonts ───────────────────────────────────────────────────────────────

interface Font {
  /** Bytes per character code. */
  codeLength: 1 | 2;
  toUnicode: Map<number, string> | null;
  decodable: boolean;
}

function parseToUnicode(cmap: string): { map: Map<number, string>; codeLength: 1 | 2 } {
  const map = new Map<number, string>();
  let codeLength: 1 | 2 = 1;
  const utf16 = (hex: string) => {
    let out = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const unit = parseInt(hex.slice(i, i + 4).padEnd(4, "0"), 16);
      out += String.fromCharCode(unit);
    }
    return out;
  };

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (pair[1].length >= 4) codeLength = 2;
      map.set(parseInt(pair[1], 16), utf16(pair[2]));
      if (map.size > 70_000) break;
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      if (range[1].length >= 4) codeLength = 2;
      const low = parseInt(range[1], 16);
      const high = Math.min(parseInt(range[2], 16), low + 70_000);
      if (range[4] !== undefined) {
        const start = parseInt(range[4].slice(-4) || "0", 16);
        const prefix = range[4].length > 4 ? utf16(range[4].slice(0, -4)) : "";
        for (let code = low; code <= high; code++) map.set(code, prefix + String.fromCharCode(start + (code - low)));
      } else if (range[5] !== undefined) {
        const targets = [...range[5].matchAll(/<([0-9a-fA-F]*)>/g)].map((target) => utf16(target[1]));
        for (let code = low; code <= high && code - low < targets.length; code++) map.set(code, targets[code - low]);
      }
    }
  }
  return { map, codeLength };
}

function loadFont(pdf: PdfDocument, fontValue: PdfValue | undefined): Font {
  const dict = pdf.resolve(fontValue);
  if (!isDict(dict)) return { codeLength: 1, toUnicode: null, decodable: true };
  const subtype = nameOf(pdf.resolve(dict.get("Subtype")));
  const toUnicodeObject = pdf.objectFor(dict.get("ToUnicode"));
  const cmapText = toUnicodeObject ? pdf.decodeStream(toUnicodeObject) : null;

  if (cmapText) {
    const parsed = parseToUnicode(cmapText);
    return { codeLength: subtype === "Type0" ? 2 : parsed.codeLength, toUnicode: parsed.map, decodable: true };
  }
  if (subtype === "Type0") {
    // Composite font with no Unicode map: the codes are glyph ids, not
    // characters. Refusing is honest; guessing would produce plausible nonsense.
    return { codeLength: 2, toUnicode: null, decodable: false };
  }
  return { codeLength: 1, toUnicode: null, decodable: true };
}

/** WinAnsi characters that differ from Latin-1 in 0x80–0x9F. */
const WIN_ANSI: Readonly<Record<number, string>> = {
  0x80: "€", 0x85: "…", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x99: "™",
};

function decodeText(bytes: string, font: Font): string | null {
  if (!font.decodable) return null;
  let out = "";
  if (font.codeLength === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1);
      out += font.toUnicode?.get(code) ?? "";
    }
    return out;
  }
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    const mapped = font.toUnicode?.get(code);
    out += mapped ?? WIN_ANSI[code] ?? String.fromCharCode(code);
  }
  return out;
}

// ── Pages and content ───────────────────────────────────────────────────

interface PageRef {
  dict: PdfDict;
  resources: PdfDict | null;
}

function collectPages(pdf: PdfDocument): PageRef[] {
  const pages: PageRef[] = [];
  const visited = new Set<PdfDict>();

  const walk = (node: PdfValue | undefined, inheritedResources: PdfDict | null, depth: number) => {
    if (depth > MAX_PAGE_TREE_DEPTH || pages.length > 10_000) return;
    const dict = pdf.resolve(node);
    if (!isDict(dict) || visited.has(dict)) return;
    visited.add(dict);
    const resourcesValue = pdf.resolve(dict.get("Resources"));
    const resources = isDict(resourcesValue) ? resourcesValue : inheritedResources;
    const type = nameOf(dict.get("Type"));
    if (type === "Page" || (!type && dict.has("Contents"))) {
      pages.push({ dict, resources });
      return;
    }
    const kids = pdf.resolve(dict.get("Kids"));
    if (Array.isArray(kids)) for (const kid of kids) walk(kid, resources, depth + 1);
  };

  const catalog = [...pdf.objects.values()].map((object) => object.value).find((value) => isDict(value) && nameOf(value.get("Type")) === "Catalog");
  if (isDict(catalog)) walk(catalog.get("Pages"), null, 0);

  if (pages.length === 0) {
    // No usable page tree: every page object, in object-number order.
    const byNumber = [...pdf.objects.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, object] of byNumber) {
      if (isDict(object.value) && nameOf(object.value.get("Type")) === "Page") {
        const resources = pdf.resolve(object.value.get("Resources"));
        pages.push({ dict: object.value, resources: isDict(resources) ? resources : null });
      }
    }
  }
  return pages;
}

interface TextRun {
  x: number;
  y: number;
  size: number;
  text: string;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

function readContent(pdf: PdfDocument, content: string, fonts: Map<string, Font>): TextRun[] {
  const runs: TextRun[] = [];
  const lexer = new Lexer(content);
  const operands: PdfValue[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let font: Font = { codeLength: 1, toUnicode: null, decodable: true };
  let fontSize = 12;
  let leading = 0;
  let operators = 0;

  const emit = (value: PdfValue) => {
    if (!(value instanceof PdfString)) return;
    const text = decodeText(value.bytes, font);
    if (text === null) {
      pdf.warnings.add("UNSUPPORTED_FONT_ENCODING");
      return;
    }
    const m = multiply(tm, ctm);
    const scale = Math.hypot(m[0], m[1]) || 1;
    const size = Math.abs(fontSize * scale) || 1;
    runs.push({ x: m[4], y: m[5], size, text });
    // Approximate advance: glyph widths aren't read, and positions are used
    // only to order runs and find line breaks.
    tm = multiply([1, 0, 0, 1, text.length * fontSize * 0.5, 0], tm);
  };

  for (;;) {
    const token = lexer.next();
    if (token === undefined) break;
    if (token === null || typeof token !== "object" || !("op" in token)) {
      operands.push(token as PdfValue);
      if (operands.length > 64) operands.shift();
      continue;
    }
    if (++operators > MAX_OPERATORS_PER_PAGE) throw new PdfLimitError("operator limit");
    if (operators % 5000 === 0) pdf.checkAborted();

    const op = token.op;
    const num = (i: number) => (typeof operands[i] === "number" ? (operands[i] as number) : 0);
    switch (op) {
      case "q":
        if (stack.length < 64) stack.push(ctm);
        break;
      case "Q":
        ctm = stack.pop() ?? IDENTITY;
        break;
      case "cm":
        if (operands.length >= 6) ctm = multiply([num(operands.length - 6), num(operands.length - 5), num(operands.length - 4), num(operands.length - 3), num(operands.length - 2), num(operands.length - 1)], ctm);
        break;
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "Tf": {
        const name = operands[operands.length - 2];
        if (name instanceof PdfName) font = fonts.get(name.name) ?? { codeLength: 1, toUnicode: null, decodable: true };
        fontSize = num(operands.length - 1) || fontSize;
        break;
      }
      case "TL":
        leading = num(operands.length - 1);
        break;
      case "Td":
      case "TD": {
        const tx = num(operands.length - 2);
        const ty = num(operands.length - 1);
        if (op === "TD") leading = -ty;
        tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
        tm = tlm;
        break;
      }
      case "Tm":
        if (operands.length >= 6) {
          tlm = [num(operands.length - 6), num(operands.length - 5), num(operands.length - 4), num(operands.length - 3), num(operands.length - 2), num(operands.length - 1)];
          tm = tlm;
        }
        break;
      case "T*":
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;
      case "Tj":
        emit(operands[operands.length - 1]);
        break;
      case "'":
      case '"':
        tlm = multiply([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        emit(operands[operands.length - 1]);
        break;
      case "TJ": {
        const items = operands[operands.length - 1];
        if (Array.isArray(items)) {
          for (const item of items) {
            if (typeof item === "number") {
              if (item < -250) runs.push({ ...lastPosition(tm, ctm, fontSize), text: " " });
              tm = multiply([1, 0, 0, 1, (-item / 1000) * fontSize, 0], tm);
            } else {
              emit(item);
            }
          }
        }
        break;
      }
      case "BI": {
        // Inline image: skip its binary data up to EI.
        const end = content.indexOf("EI", lexer.pos);
        lexer.pos = end < 0 ? content.length : end + 2;
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  return runs;
}

function lastPosition(tm: Matrix, ctm: Matrix, fontSize: number): Omit<TextRun, "text"> {
  const m = multiply(tm, ctm);
  return { x: m[4], y: m[5], size: Math.abs(fontSize * (Math.hypot(m[0], m[1]) || 1)) || 1 };
}

function groupLines(runs: readonly TextRun[]): ProviderLine[] {
  const sorted = [...runs].filter((run) => run.text.length > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: TextRun[][] = [];
  for (const run of sorted) {
    const group = groups[groups.length - 1];
    if (group && Math.abs(group[0].y - run.y) <= Math.max(2, run.size * 0.4)) group.push(run);
    else groups.push([run]);
  }

  return groups.map((group) => {
    const ordered = group.sort((a, b) => a.x - b.x);
    let text = "";
    let previousEnd: number | null = null;
    for (const run of ordered) {
      if (previousEnd !== null) {
        const gap = run.x - previousEnd;
        if (gap > run.size * 1.5 && !text.endsWith(" ")) text += "  ";
        else if (gap > run.size * 0.2 && !text.endsWith(" ") && !run.text.startsWith(" ")) text += " ";
      }
      text += run.text;
      previousEnd = run.x + run.text.length * run.size * 0.5;
    }
    return {
      text: text.replace(/[ \t]{3,}/g, "  ").trim().slice(0, MAX_LINE_LENGTH),
      position: { x: Math.round(ordered[0].x * 100) / 100, y: Math.round(ordered[0].y * 100) / 100, width: null, height: null, units: "pdf_points" as const },
      confidence: null,
    };
  });
}

async function readPdfTextLayer(bytes: Uint8Array, signal: AbortSignal): Promise<ProviderResult> {
  const src = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const base = { provider: PDF_TEXT_LAYER_PROVIDER.id, providerVersion: PDF_TEXT_LAYER_PROVIDER.version, method: "PDF_TEXT_LAYER" as const };

  if (!src.startsWith("%PDF-")) throw new Error("not a PDF");
  const pdf = new PdfDocument(src, signal);

  // An encryption dictionary means every string and stream is enciphered.
  if (/\/Encrypt\s+(\d+\s+\d+\s+R|<<)/.test(src)) {
    return { ...base, pageCount: 0, pages: [], warnings: ["ENCRYPTED_DOCUMENT"] };
  }

  pdf.parse();
  const pageRefs = collectPages(pdf);
  const pages: ProviderResult["pages"] = [];
  let characters = 0;

  for (const [index, page] of pageRefs.entries()) {
    if (index >= MAX_PAGES) {
      pdf.warnings.add("PAGE_LIMIT_REACHED");
      break;
    }
    // Let a pending timeout fire between pages.
    await new Promise((resolve) => setTimeout(resolve, 0));
    pdf.checkAborted();

    const fonts = new Map<string, Font>();
    const fontDict = page.resources ? pdf.resolve(page.resources.get("Font")) : undefined;
    if (isDict(fontDict)) for (const [name, value] of fontDict) fonts.set(name, loadFont(pdf, value));

    const contents = pdf.resolve(page.dict.get("Contents")) === undefined ? [] : Array.isArray(pdf.resolve(page.dict.get("Contents"))) ? (pdf.resolve(page.dict.get("Contents")) as PdfValue[]) : [page.dict.get("Contents") as PdfValue];
    let content = "";
    for (const part of contents) {
      const object = pdf.objectFor(part);
      const decoded = object ? pdf.decodeStream(object) : null;
      if (decoded !== null) content += `${decoded}\n`;
    }

    const lines: ProviderLine[] = [];
    for (const line of groupLines(readContent(pdf, content, fonts))) {
      if (!line.text) continue;
      if (lines.length >= MAX_LINES_PER_PAGE) break;
      if (characters + line.text.length > MAX_TEXT_CHARS) {
        pdf.warnings.add("TEXT_LIMIT_REACHED");
        break;
      }
      characters += line.text.length;
      lines.push(line);
    }
    pages.push({ pageNumber: index + 1, lines });
    if (pdf.warnings.has("TEXT_LIMIT_REACHED")) break;
  }

  if (characters === 0) pdf.warnings.add("NO_TEXT_LAYER");
  return { ...base, pageCount: pageRefs.length, pages, warnings: [...pdf.warnings] };
}
