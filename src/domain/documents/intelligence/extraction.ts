import { classifyDocument } from "./classification";
import {
  currencyFromHint,
  detectDocumentCurrency,
  findAmounts,
  findDate,
  findTaxYear,
  maskSensitive,
  sanitizeText,
  toMinorUnits,
  type ParsedAmount,
} from "./normalization";
import type { ProviderLine, ProviderResult } from "./provider";
import { schemaFor, type DocumentSchema, type FieldDefinition } from "./schemas";
import type { Classification, CurrencySource, ExtractedFieldDraft, ExtractionDraft, ExtractionStatus, ExtractionWarning, FieldReviewState } from "./types";

/**
 * STRUCTURED EXTRACTION — deterministic, and incapable of inventing a value.
 *
 * Input is a validated `ProviderResult`; output is an `ExtractionDraft`. No
 * clock, no network, no randomness: the same text always produces the same
 * fields, which is what lets a stored extraction be explained and re-derived.
 *
 * HOW A VALUE IS READ
 *
 * A field's printed label is located on a line. Its value is the first value
 * of the right kind that follows the label on that line — stopping at the next
 * label — or, when the label line carries no value (the IRS layout prints
 * labels above their boxes), the value in the same position on the next line.
 *
 *   same line                               HIGH (MEDIUM in a less certain document)
 *   next line, one value per label          MEDIUM
 *   next line, counts don't line up         LOW
 *   label found, nothing parseable          UNREADABLE — no value kept
 *   label not found                         MISSING — no value kept
 *   read differently in two places          CONFLICT — no value chosen
 *
 * Identifiers are never kept: an SSN, EIN, card or account number is recorded
 * as PRESENT, with at most the last four digits of a non-SSN identifier.
 */

interface Line {
  page: number;
  index: number;
  text: string;
  source: ProviderLine;
}

interface Candidate {
  line: Line;
  state: FieldReviewState;
  method: string;
  raw: string;
  amount?: ParsedAmount;
  date?: string;
  text?: string;
  reason?: string;
}

const READ_STATES: readonly FieldReviewState[] = ["HIGH_CONFIDENCE", "MEDIUM_CONFIDENCE", "LOW_CONFIDENCE"];

function atMost(state: FieldReviewState, ceiling: FieldReviewState | undefined): FieldReviewState {
  if (!ceiling) return state;
  const at = READ_STATES.indexOf(state);
  const cap = READ_STATES.indexOf(ceiling);
  if (at < 0 || cap < 0) return state;
  return READ_STATES[Math.max(at, cap)];
}

const MAX_ROWS = 50;

export function extractDocument(result: ProviderResult): ExtractionDraft {
  const warnings = new Set<ExtractionWarning>(result.warnings);
  const lines: Line[] = [];
  let textCharCount = 0;

  for (const page of result.pages) {
    page.lines.forEach((source, index) => {
      const text = sanitizeText(source.text, 1000);
      if (!text) return;
      textCharCount += text.length;
      lines.push({ page: page.pageNumber, index, text, source });
    });
  }

  const pageTexts = result.pages.map((page) => lines.filter((line) => line.page === page.pageNumber).map((line) => line.text).join("\n"));
  const base = { pageCount: result.pageCount, textCharCount, textTruncated: warnings.has("TEXT_LIMIT_REACHED") };

  if (textCharCount === 0) {
    if (!warnings.has("ENCRYPTED_DOCUMENT")) warnings.add("NO_TEXT_LAYER");
    const classification = classifyDocument([]);
    return { ...base, status: "UNSUPPORTED", classification, taxYear: null, fields: [], warnings: [...warnings] };
  }

  const classification = classifyDocument(pageTexts);
  const schema = schemaFor(classification.documentType);

  if (!schema) {
    if (classification.signals.some((signal) => signal.startsWith("ambiguous:"))) warnings.add("TYPE_AMBIGUOUS");
    else warnings.add("UNSUPPORTED_DOCUMENT_TYPE");
    return { ...base, status: "REVIEW_REQUIRED", classification, taxYear: null, fields: [], warnings: [...warnings] };
  }

  const allText = pageTexts.join("\n");
  const documentCurrency: { code: string | null; source: CurrencySource | null } =
    schema.currency === "FORM_USD" ? { code: "USD", source: "FORM_DEFINITION" } : (() => {
      const detected = detectDocumentCurrency(allText);
      return { code: detected, source: detected ? "DOCUMENT_TEXT" : null };
    })();

  const taxYear = schema.taxYearTitle ? readTaxYear(schema.taxYearTitle, result, lines, warnings) : null;
  const reader = new FieldReader(schema, lines, classification, documentCurrency, warnings);
  const fields = schema.fields.flatMap((definition) => reader.read(definition));

  if (fields.some((field) => field.reviewState === "CONFLICT")) warnings.add("CONFLICTING_VALUES");
  if (documentCurrency.code === null && fields.some((field) => field.valueKind === "MONEY" && field.normalizedDecimal !== null)) warnings.add("CURRENCY_NOT_FOUND");

  return { ...base, status: statusFor(schema, classification, fields), classification, taxYear, fields, warnings: [...warnings] };
}

function readTaxYear(title: RegExp, result: ProviderResult, lines: readonly Line[], warnings: Set<ExtractionWarning>): number | null {
  const years = new Set<number>();
  let ambiguous = false;
  for (const page of result.pages) {
    const found = findTaxYear(lines.filter((line) => line.page === page.pageNumber).map((line) => line.text), title);
    if (found.year !== null) years.add(found.year);
    if (found.ambiguous) ambiguous = true;
  }
  if (years.size === 1 && !ambiguous) return [...years][0];
  warnings.add(years.size > 1 || ambiguous ? "TAX_YEAR_AMBIGUOUS" : "TAX_YEAR_NOT_FOUND");
  return null;
}

function statusFor(schema: DocumentSchema, classification: Classification, fields: readonly ExtractedFieldDraft[]): ExtractionStatus {
  if (classification.reviewRequired) return "REVIEW_REQUIRED";
  if (fields.some((field) => field.reviewState === "CONFLICT")) return "REVIEW_REQUIRED";

  const read = (field: ExtractedFieldDraft) => READ_STATES.includes(field.reviewState);
  const required = schema.fields.filter((definition) => definition.required).map((definition) => definition.key);
  const requiredFields = fields.filter((field) => required.includes(field.fieldKey));

  if (required.length > 0) {
    if (requiredFields.every((field) => field.reviewState === "HIGH_CONFIDENCE" || field.reviewState === "MEDIUM_CONFIDENCE")) return "SUCCEEDED";
    return fields.some(read) ? "PARTIAL" : "REVIEW_REQUIRED";
  }
  return fields.some(read) ? "SUCCEEDED" : "REVIEW_REQUIRED";
}

// ── Reading fields ──────────────────────────────────────────────────────

interface LabelHit {
  definition: FieldDefinition;
  start: number;
  end: number;
}

class FieldReader {
  private readonly hitsByLine = new Map<Line, LabelHit[]>();

  constructor(
    private readonly schema: DocumentSchema,
    private readonly lines: readonly Line[],
    private readonly classification: Classification,
    private readonly currency: { code: string | null; source: CurrencySource | null },
    private readonly warnings: Set<ExtractionWarning>,
  ) {
    for (const line of lines) {
      const hits: LabelHit[] = [];
      for (const definition of schema.fields) {
        for (const label of definition.labels ?? []) {
          const match = new RegExp(label.source, label.flags.replace("g", "")).exec(line.text);
          if (match) {
            hits.push({ definition, start: match.index, end: match.index + match[0].length });
            break;
          }
        }
      }
      if (hits.length > 0) this.hitsByLine.set(line, hits.sort((a, b) => a.start - b.start));
    }
  }

  read(definition: FieldDefinition): ExtractedFieldDraft[] {
    switch (definition.strategy) {
      case "FIRST_LINE":
        return [this.readFirstLine(definition)];
      case "ROWS":
        return this.readRows(definition);
      case "BOX_12":
        return this.readBox12(definition);
      default:
        return [this.readLabelled(definition)];
    }
  }

  /** Where this field's label is, and the text after it up to the next label. */
  private occurrences(definition: FieldDefinition): { line: Line; hit: LabelHit; segment: string }[] {
    const out: { line: Line; hit: LabelHit; segment: string }[] = [];
    for (const [line, hits] of this.hitsByLine) {
      const hit = hits.find((candidate) => candidate.definition === definition);
      if (!hit) continue;
      const next = hits.find((candidate) => candidate.start >= hit.end && candidate.start !== hit.start);
      out.push({ line, hit, segment: line.text.slice(hit.end, next ? next.start : undefined) });
    }
    return out;
  }

  private nextLine(line: Line, offset = 1): Line | null {
    return this.lines.find((candidate) => candidate.page === line.page && candidate.index === line.index + offset) ?? null;
  }

  private sameLineState(): FieldReviewState {
    return this.classification.confidence === "HIGH" ? "HIGH_CONFIDENCE" : "MEDIUM_CONFIDENCE";
  }

  private readLabelled(definition: FieldDefinition): ExtractedFieldDraft {
    const occurrences = this.occurrences(definition);
    if (occurrences.length === 0) return this.missing(definition, "The label for this field wasn't found.");

    const candidates: Candidate[] = [];
    for (const occurrence of occurrences) {
      const candidate = this.readOccurrence(definition, occurrence);
      if (candidate) candidates.push(candidate);
    }

    const readable = candidates.filter((candidate) => candidate.state !== "UNREADABLE");
    if (readable.length === 0) {
      const first = candidates[0] ?? { line: occurrences[0].line, reason: "The label was found, but no value beside or below it could be read." };
      return this.draft(definition, { line: first.line, state: "UNREADABLE", method: "label-found-no-value", raw: "", reason: first.reason ?? "The label was found, but no value beside or below it could be read." }, true);
    }

    const distinct = new Map<string, Candidate>();
    for (const candidate of readable) {
      const key = candidate.amount?.decimal ?? candidate.date ?? candidate.text ?? candidate.raw;
      const existing = distinct.get(key);
      if (!existing || READ_STATES.indexOf(candidate.state) < READ_STATES.indexOf(existing.state)) distinct.set(key, candidate);
    }
    if (distinct.size > 1) {
      const first = readable[0];
      return this.draft(definition, { line: first.line, state: "CONFLICT", method: "label-read-differently", raw: "", reason: `This field was read with ${distinct.size} different values in different places. None was chosen.` }, true);
    }
    return this.draft(definition, [...distinct.values()][0], false);
  }

  private readOccurrence(definition: FieldDefinition, occurrence: { line: Line; hit: LabelHit; segment: string }): Candidate | null {
    const { line, segment } = occurrence;
    const below = this.nextLine(line);
    const segmentText = segment.replace(/^[\s:#.\-–]+/, "");

    switch (definition.kind) {
      case "MONEY": {
        const onLine = findAmounts(segmentText);
        const column = definition.column ?? 0;
        if (onLine.length > column) return { line, state: this.sameLineState(), method: "label-same-line", raw: onLine[column].raw, amount: onLine[column] };
        for (const offset of [1, 2]) {
          const candidateLine = this.nextLine(line, offset);
          if (!candidateLine) break;
          const amounts = findAmounts(candidateLine.text);
          if (amounts.length === 0) continue;
          if (definition.column !== undefined) {
            return amounts.length > column
              ? { line: candidateLine, state: "MEDIUM_CONFIDENCE", method: "label-column-below", raw: amounts[column].raw, amount: amounts[column] }
              : { line: candidateLine, state: "UNREADABLE", method: "label-column-below", raw: "", reason: "The row below the label has fewer values than expected." };
          }
          // Labels on this line without their own value, in order: the IRS
          // layout prints box 1 and box 2 labels side by side, and their
          // amounts side by side on the line beneath.
          // Only amount labels take part: a state code or a name printed in the
          // same row has its own value, not one of these amounts.
          const valueless = (this.hitsByLine.get(line) ?? []).filter((hit) => {
            if (hit.definition.kind !== "MONEY" || hit.definition.column !== undefined) return false;
            const next = (this.hitsByLine.get(line) ?? []).find((other) => other.start >= hit.end && other.start !== hit.start);
            return findAmounts(line.text.slice(hit.end, next ? next.start : undefined)).length === 0;
          });
          const position = valueless.findIndex((hit) => hit.definition === definition);
          if (position < 0 || amounts.length <= position) {
            return { line: candidateLine, state: "UNREADABLE", method: "label-column-below", raw: "", reason: "Values below the label couldn't be matched to it." };
          }
          const state: FieldReviewState = amounts.length === valueless.length ? "MEDIUM_CONFIDENCE" : "LOW_CONFIDENCE";
          return { line: candidateLine, state, method: "label-column-below", raw: amounts[position].raw, amount: amounts[position] };
        }
        return { line, state: "UNREADABLE", method: "label-found-no-value", raw: "", reason: "The label was found, but no amount beside or below it." };
      }

      case "DATE": {
        const convention = definition.dateConvention ?? this.schema.dateConvention;
        const dates = allDates(segmentText, convention);
        const fromBelow = dates.length === 0 && below ? allDates(below.text, convention) : [];
        const pool = dates.length > 0 ? dates : fromBelow;
        const picked = pool[definition.occurrence ?? 0];
        if (!picked) return { line, state: "UNREADABLE", method: "label-found-no-value", raw: "", reason: "No date was found beside or below the label." };
        if (picked.ambiguous || !picked.iso) {
          return { line, state: "UNREADABLE", method: "date-ambiguous", raw: picked.raw, reason: "This date could be read as two different dates, so it wasn't read." };
        }
        return { line: dates.length > 0 ? line : (below as Line), state: dates.length > 0 ? this.sameLineState() : "MEDIUM_CONFIDENCE", method: dates.length > 0 ? "label-same-line" : "label-below", raw: picked.raw, date: picked.iso };
      }

      case "CODE": {
        const pattern = definition.codePattern ?? /\b([A-Z0-9]{1,8})\b/;
        const match = segmentText.match(pattern) ?? (below ? below.text.match(pattern) : null);
        if (!match) return { line, state: "UNREADABLE", method: "label-found-no-value", raw: "", reason: "No code was found beside or below the label." };
        const onLine = Boolean(segmentText.match(pattern));
        if (definition.key.includes("state") && below && !onLine) {
          const states = below.text.match(new RegExp(pattern.source, "g")) ?? [];
          if (states.length > 1) {
            this.warnings.add("MULTIPLE_STATE_ROWS");
            return { line: below, state: "LOW_CONFIDENCE", method: "label-below-multiple", raw: (match[1] ?? match[0]).toUpperCase(), text: (match[1] ?? match[0]).toUpperCase() };
          }
        }
        const code = (match[1] ?? match[0]).toUpperCase();
        return { line: onLine ? line : (below as Line), state: onLine ? this.sameLineState() : "MEDIUM_CONFIDENCE", method: onLine ? "label-same-line" : "label-below", raw: code, text: code };
      }

      case "PRESENCE": {
        if (definition.presence === "IDENTIFIER") {
          const token = identifierIn(segmentText) ?? (below ? identifierIn(below.text) : null);
          if (!token) return null;
          const masked = maskSensitive(token).text;
          this.warnings.add("SENSITIVE_VALUES_MASKED");
          return { line, state: this.sameLineState(), method: "identifier-presence", raw: masked, text: "PRESENT" };
        }
        const text = segmentText.trim() || (below && !this.hitsByLine.has(below) ? below.text.trim() : "");
        if (!text) return null;
        // A name is personal data this layer does not need: presence only.
        return { line, state: this.sameLineState(), method: "text-presence", raw: "", text: "PRESENT" };
      }

      default: {
        const onLine = segmentText.trim();
        const text = onLine || (below && !this.hitsByLine.has(below) && findAmounts(below.text).length === 0 ? below.text.trim() : "");
        if (!text) return { line, state: "UNREADABLE", method: "label-found-no-value", raw: "", reason: "No text was found beside or below the label." };
        const masked = maskSensitive(text);
        if (masked.masked) this.warnings.add("SENSITIVE_VALUES_MASKED");
        const clean = sanitizeText(masked.text, 120);
        return { line: onLine ? line : (below as Line), state: onLine ? this.sameLineState() : "MEDIUM_CONFIDENCE", method: onLine ? "label-same-line" : "label-below", raw: clean, text: clean };
      }
    }
  }

  private readFirstLine(definition: FieldDefinition): ExtractedFieldDraft {
    const first = this.lines.find((line) => line.page === this.lines[0]?.page && /[A-Za-z]{3}/.test(line.text) && !this.hitsByLine.has(line) && findAmounts(line.text).length === 0);
    if (!first) return this.missing(definition, "No heading line was found.");
    const masked = maskSensitive(first.text);
    if (masked.masked) this.warnings.add("SENSITIVE_VALUES_MASKED");
    const clean = sanitizeText(masked.text, 120);
    return this.draft(definition, { line: first, state: "LOW_CONFIDENCE", method: "first-line", raw: clean, text: clean, reason: "Taken from the document's first line, which may not be the name." }, false);
  }

  private readRows(definition: FieldDefinition): ExtractedFieldDraft[] {
    const out: ExtractedFieldDraft[] = [];
    const isStatement = this.schema.documentType === "BANK_STATEMENT";
    let inItems = !isStatement ? false : true;

    for (const line of this.lines) {
      if (out.length >= MAX_ROWS) break;
      if (!isStatement) {
        if (/\b(Description|Item|Qty|Quantity)\b/i.test(line.text)) {
          inItems = true;
          continue;
        }
        if (/\b(Subtotal|Total|Amount\s+Due|Balance\s+Due)\b/i.test(line.text)) inItems = false;
        if (!inItems) continue;
      }
      if (this.hitsByLine.has(line)) continue;

      const amounts = findAmounts(line.text);
      if (amounts.length === 0) continue;
      const date = isStatement ? findDate(line.text, this.schema.dateConvention) : null;
      if (isStatement && !date) continue;

      const amount = amounts[amounts.length - 1];
      const description = sanitizeText(maskSensitive(line.text.replace(amount.raw, "").replace(date?.raw ?? "", "")).text, 120);
      const n = out.length + 1;
      out.push(
        this.draft(
          { ...definition, key: `${definition.key}_${n}`, label: `${definition.label} ${n}` },
          {
            line,
            state: "LOW_CONFIDENCE",
            method: isStatement ? "row-date-amount" : "row-description-amount",
            raw: sanitizeText(maskSensitive(line.text).text, 200),
            amount,
            date: date?.iso ?? undefined,
            text: description,
            reason: "Read from a table row; rows vary between issuers.",
          },
          false,
        ),
      );
    }
    return out;
  }

  private readBox12(definition: FieldDefinition): ExtractedFieldDraft[] {
    const out: ExtractedFieldDraft[] = [];
    const pattern = /\b12([a-d])\b\s*[:-]?\s*([A-HJ-NP-Z]{1,2})\s+(\$?\d{1,3}(?:,\d{3})*\.\d{2})/g;
    const seen = new Set<string>();
    for (const line of this.lines) {
      for (const match of line.text.matchAll(pattern)) {
        const letter = match[1];
        if (seen.has(letter)) continue;
        seen.add(letter);
        const amount = findAmounts(match[3])[0];
        if (!amount) continue;
        out.push(
          this.draft(
            { ...definition, key: `box12${letter}`, label: `Box 12${letter} (code ${match[2]})`, box: `12${letter}` },
            { line, state: "LOW_CONFIDENCE", method: "box12-pattern", raw: `${match[2]} ${amount.raw}`, amount, text: match[2], reason: "Box 12 entries are read by pattern." },
            false,
          ),
        );
      }
    }
    return out;
  }

  private missing(definition: FieldDefinition, reason: string): ExtractedFieldDraft {
    return {
      schemaId: this.schema.id,
      fieldKey: definition.key,
      label: definition.label,
      section: definition.section,
      box: definition.box,
      valueKind: definition.kind,
      rawValue: null,
      normalizedDecimal: null,
      amountMinor: null,
      currency: null,
      currencySource: null,
      normalizedDate: null,
      normalizedText: null,
      reviewState: "MISSING",
      reviewReason: reason,
      providerConfidence: null,
      pageNumber: null,
      lineIndex: null,
      position: null,
      method: "not-found",
    };
  }

  private draft(definition: FieldDefinition, candidate: Candidate, withoutValue: boolean): ExtractedFieldDraft {
    let state = withoutValue ? candidate.state : atMost(candidate.state, definition.ceiling);
    if (!withoutValue && this.classification.confidence === "MEDIUM") state = atMost(state, "MEDIUM_CONFIDENCE");
    if (!withoutValue && this.classification.confidence === "LOW") state = atMost(state, "LOW_CONFIDENCE");

    const confidence = candidate.line.source.confidence;
    let reason = candidate.reason ?? null;
    if (!withoutValue && confidence !== null) {
      if (confidence < 0.2) {
        state = "UNREADABLE";
        reason = "The reader reported very low confidence for this text.";
      } else if (confidence < 0.5) {
        state = atMost(state, "LOW_CONFIDENCE");
        reason = reason ?? "The reader reported low confidence for this text.";
      }
    }

    const keepValue = !withoutValue && state !== "UNREADABLE";
    const amount = keepValue ? candidate.amount : undefined;
    const hintCurrency = amount ? currencyFromHint(amount.currencyHint) : null;
    const currency = amount ? (hintCurrency ?? this.currency.code) : null;
    const currencySource: CurrencySource | null = amount ? (hintCurrency ? "DOCUMENT_TEXT" : this.currency.source) : null;

    return {
      schemaId: this.schema.id,
      fieldKey: definition.key,
      label: definition.label,
      section: definition.section,
      box: definition.box,
      valueKind: definition.kind,
      rawValue: candidate.raw ? sanitizeText(maskSensitive(candidate.raw).text, 200) : null,
      normalizedDecimal: amount ? amount.decimal : null,
      amountMinor: amount ? toMinorUnits(amount.decimal, currency) : null,
      currency: amount ? currency : null,
      currencySource,
      normalizedDate: keepValue ? (candidate.date ?? null) : null,
      normalizedText: keepValue ? (candidate.text ?? null) : null,
      reviewState: state,
      reviewReason: reason,
      providerConfidence: confidence,
      pageNumber: candidate.line.page,
      lineIndex: candidate.line.index,
      position: candidate.line.source.position,
      method: `${this.schema.id}/${candidate.method}`,
    };
  }
}

function allDates(text: string, convention: DocumentSchema["dateConvention"]) {
  const out: NonNullable<ReturnType<typeof findDate>>[] = [];
  let rest = text;
  for (let i = 0; i < 4; i++) {
    const found = findDate(rest, convention);
    if (!found) break;
    out.push(found);
    const at = rest.indexOf(found.raw);
    rest = rest.slice(at + found.raw.length);
  }
  return out;
}

function identifierIn(text: string): string | null {
  const match = text.match(/(?<!\d)(\d{3}[-\s.]?\d{2}[-\s.]?\d{4}|\d{2}-\d{7}|(?:\d[ -]?){12,18}\d|\d{7,}|[x*•]{2,}[-\s]?\d{4})(?!\d)/i);
  return match ? match[1] : null;
}
