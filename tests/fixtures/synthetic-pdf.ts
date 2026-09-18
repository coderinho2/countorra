import { deflateSync } from "node:zlib";

/**
 * Builds small, genuine PDF files for tests — synthetic content only.
 *
 * The files are real PDFs (header, objects, content streams, xref, trailer),
 * written the ways PDF producers actually write text: plain or Flate-compressed
 * content streams, simple Type1 fonts or composite Type0 fonts with ToUnicode
 * maps, objects inside object streams. No binary fixture is checked in; every
 * byte a test parses is produced here from readable source.
 */

export interface SyntheticLine {
  text: string;
  x: number;
  y: number;
  size?: number;
  /** Write the line as a TJ array, splitting at double spaces with a kerning gap. */
  tj?: boolean;
}

export interface SyntheticPdfOptions {
  compress?: boolean;
  /** Composite font with a ToUnicode map (Identity-H, 2-byte codes). */
  type0?: "with-to-unicode" | "without-to-unicode";
  /** Put page and font dictionaries inside a compressed object stream. */
  objectStream?: boolean;
  encrypted?: boolean;
  /** A page that draws only an image: no text operators at all. */
  imageOnly?: boolean;
}

const latin1 = (text: string) => Buffer.from(text, "latin1");

function escapeLiteral(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function buildTextPdf(pages: readonly SyntheticLine[][], options: SyntheticPdfOptions = {}): Uint8Array {
  const characters = [...new Set(pages.flat().flatMap((line) => [...line.text]))];
  const codeFor = new Map(characters.map((character, index) => [character, index + 1]));
  const hex = (text: string) => [...text].map((character) => (codeFor.get(character) ?? 0).toString(16).padStart(4, "0")).join("");

  const showText = (text: string) => (options.type0 ? `<${hex(text)}> Tj` : `(${escapeLiteral(text)}) Tj`);
  const showArray = (text: string) => {
    const parts = text.split("  ");
    return `[${parts.map((part) => (options.type0 ? `<${hex(part)}>` : `(${escapeLiteral(part)})`)).join(" -900 ")}] TJ`;
  };

  const objects: { num: number; body: Buffer; inStream?: boolean }[] = [];
  let next = 1;
  const add = (body: string | Buffer, inStream = false) => {
    const num = next++;
    objects.push({ num, body: typeof body === "string" ? latin1(body) : body, inStream });
    return num;
  };
  const stream = (dict: string, data: Buffer) => {
    const encoded = options.compress ? deflateSync(data) : data;
    const filter = options.compress ? " /Filter /FlateDecode" : "";
    return Buffer.concat([latin1(`<< ${dict} /Length ${encoded.length}${filter} >>\nstream\n`), encoded, latin1("\nendstream")]);
  };

  const catalog = add("");
  const pagesRoot = add("");

  let fontRef: number;
  if (options.type0) {
    let toUnicode = "";
    if (options.type0 === "with-to-unicode") {
      const entries = characters.map((character) => `<${(codeFor.get(character) ?? 0).toString(16).padStart(4, "0")}> <${character.charCodeAt(0).toString(16).padStart(4, "0")}>`);
      const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${entries.length} beginbfchar\n${entries.join("\n")}\nendbfchar\nendcmap\nend\nend`;
      toUnicode = ` /ToUnicode ${add(stream("", latin1(cmap)))} 0 R`;
    }
    fontRef = add(`<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticSans /Encoding /Identity-H${toUnicode} >>`, options.objectStream);
  } else {
    fontRef = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", options.objectStream);
  }

  const pageRefs: number[] = [];
  for (const lines of pages) {
    const content = options.imageOnly
      ? "q 612 0 0 792 0 0 cm /Im1 Do Q"
      : lines.map((line) => `BT /F1 ${line.size ?? 10} Tf ${line.x} ${line.y} Td ${line.tj ? showArray(line.text) : showText(line.text)} ET`).join("\n");
    const contentRef = add(stream("", latin1(content)));
    pageRefs.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 612 792] /Contents ${contentRef} 0 R /Resources << /Font << /F1 ${fontRef} 0 R >> >> >>`, options.objectStream));
  }

  objects[catalog - 1].body = latin1(`<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`);
  objects[pagesRoot - 1].body = latin1(`<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(" ")}] /Count ${pageRefs.length} >>`);

  if (options.objectStream) {
    const inner = objects.filter((object) => object.inStream);
    let header = "";
    let bodies = "";
    for (const object of inner) {
      header += `${object.num} ${bodies.length} `;
      bodies += `${object.body.toString("latin1")}\n`;
    }
    const data = latin1(header + bodies);
    const compressed = deflateSync(data);
    add(Buffer.concat([latin1(`<< /Type /ObjStm /N ${inner.length} /First ${header.length} /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`), compressed, latin1("\nendstream")]));
  }

  const chunks: Buffer[] = [latin1("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let length = chunks[0].length;
  for (const object of objects) {
    if (object.inStream) continue;
    offsets[object.num] = length;
    const chunk = Buffer.concat([latin1(`${object.num} 0 obj\n`), object.body, latin1("\nendobj\n")]);
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefStart = length;
  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let num = 1; num < next; num++) xref += `${String(offsets[num] ?? 0).padStart(10, "0")} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${next} /Root ${catalog} 0 R${options.encrypted ? " /Encrypt << /Filter /Standard /V 2 /R 3 >>" : ""} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(latin1(xref + trailer));
  return new Uint8Array(Buffer.concat(chunks));
}

/** A synthetic W-2 page in the IRS box layout. Every value is invented. */
export function syntheticW2Lines(overrides: { wages?: string; year?: string } = {}): SyntheticLine[] {
  const wages = overrides.wages ?? "85,000.00";
  return [
    { text: `Form W-2 Wage and Tax Statement ${overrides.year ?? "2026"}`, x: 40, y: 760, size: 12 },
    { text: "SYNTHETIC TEST DOCUMENT - NOT A REAL W-2", x: 40, y: 744 },
    { text: "a Employee's social security number", x: 40, y: 720 },
    { text: "123-45-6789", x: 300, y: 720 },
    { text: "b Employer identification number (EIN)", x: 40, y: 700 },
    { text: "12-3456789", x: 300, y: 700 },
    { text: "c Employer's name, address, and ZIP code", x: 40, y: 680 },
    { text: "Example Test Employer (fictional)", x: 40, y: 666 },
    { text: "1 Wages, tips, other compensation", x: 40, y: 640 },
    { text: "2 Federal income tax withheld", x: 320, y: 640 },
    { text: wages, x: 40, y: 626 },
    { text: "11,000.00", x: 320, y: 626 },
    { text: "3 Social security wages", x: 40, y: 600 },
    { text: "4 Social security tax withheld", x: 320, y: 600 },
    { text: wages, x: 40, y: 586 },
    { text: "5,270.00", x: 320, y: 586 },
    { text: "5 Medicare wages and tips", x: 40, y: 560 },
    { text: "6 Medicare tax withheld", x: 320, y: 560 },
    { text: wages, x: 40, y: 546 },
    { text: "1,232.50", x: 320, y: 546 },
  ];
}
