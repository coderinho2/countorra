/**
 * The single seam every error and security-relevant event passes through on
 * its way to being recorded.
 *
 * WHY AN INTERFACE BEFORE A VENDOR
 *
 * There is no error-tracking vendor in this stack yet, and picking one is a
 * decision that has not been made. What can be settled now is the shape of
 * what gets reported and — far more importantly for a product holding
 * financial records — what must never be reported. Wiring a vendor into
 * scattered `console.error` calls later is how prompts, amounts and tokens end
 * up in a third party's index: the redaction has to exist before the pipe
 * does, not after.
 *
 * WHAT MUST NEVER REACH A LOG
 *
 * Enforced by `redact` below rather than by convention:
 *
 *   - API keys, service-role keys, bearer tokens, session cookies
 *   - passwords, in any field name that looks like one
 *   - the user's AI prompt text and the assistant's reply — a financial
 *     question is itself sensitive ("can I afford the surgery")
 *   - money amounts and account balances
 *   - email addresses and full names
 *
 * Identifiers (organization id, user id, request id) ARE recorded: they are
 * what makes an event actionable, and they are meaningless without database
 * access that a log reader does not have.
 *
 * INTEGRATION POINT
 *
 * `reportError` and `reportEvent` are the only two functions to change when a
 * vendor is chosen. Nothing else in the codebase should call a logger
 * directly, so the swap is one file. Server-side callers today: the AI action
 * (`[ai] …`), the tool-error seam in the service factory, the rate limiter,
 * and the route error boundaries.
 */

export type Severity = "error" | "warning" | "info";

export interface ReportContext {
  /** Coarse area, for grouping. Never a message. */
  scope: "ai" | "auth" | "bank" | "billing" | "documents" | "financial" | "route" | "security" | "storage";
  organizationId?: string;
  userId?: string;
  /** Next's server-generated correlation id, where one exists. */
  digest?: string;
  /** Small, non-sensitive facts — a tool name, a rule name, an HTTP status.
   *  Passed through `redact`, so a mistake here is contained rather than
   *  published. */
  detail?: Record<string, unknown>;
}

/**
 * Key names are normalized (lowercased, separators stripped) before matching,
 * so `x-api-key`, `API_KEY` and `apiKey` are one rule.
 *
 * Two lists rather than one, because a single substring list is wrong in both
 * directions. `name` as a substring redacts `toolName` and `ruleName` — the
 * operational fields that make a log worth reading — while `name` as an exact
 * match alone would miss `fullName`. So: exact matches for the bare words that
 * are always content, and substrings only for compounds that are
 * unambiguously sensitive.
 */
const FORBIDDEN_EXACT = new Set([
  "name",
  "email",
  "password",
  "token",
  "key",
  "secret",
  "prompt",
  "message",
  "content",
  "answer",
  "amount",
  "balance",
  "total",
  "authorization",
  "cookie",
  "session",
  "credential",
]);

const FORBIDDEN_SUBSTRING = [
  "password",
  "secret",
  "token",
  "credential",
  "authorization",
  "cookie",
  "session",
  "apikey",
  "accesskey",
  "prompt",
  "email",
  "balance",
  "amountminor",
  "totalminor",
  "fullname",
  "displayname",
  "firstname",
  "lastname",
  "username",
  // Bank data (Task 11). A provider cursor can be replayed against the
  // provider; merchants and descriptions are what a person bought; account and
  // routing numbers, IBANs and credential references identify money.
  "cursor",
  "merchant",
  "description",
  "memo",
  "payload",
  "rawbody",
  "accountnumber",
  "routingnumber",
  "iban",
  "secretref",
];

function isForbidden(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_\-\s]/g, "");
  if (FORBIDDEN_EXACT.has(normalized)) return true;
  return FORBIDDEN_SUBSTRING.some((forbidden) => normalized.includes(forbidden));
}

const REDACTED = "[redacted]";

/**
 * Strips anything sensitive from a detail object.
 *
 * Deliberately an allow-by-shape filter rather than a deny-list of known
 * secrets: a deny-list only catches what someone remembered, and the values
 * that matter most here (a prompt, a balance) are not recognizable by
 * inspecting them. Only primitives survive, so an object cannot smuggle a
 * payload through in a nested field.
 */
export function redact(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!detail) return {};
  const safe: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(detail)) {
    if (isForbidden(key)) {
      safe[key] = REDACTED;
      continue;
    }
    if (value === null || value === undefined) {
      safe[key] = value;
      continue;
    }
    if (typeof value === "string") {
      // Bounded: a long string is far more likely to be content than a label.
      safe[key] = value.length > 200 ? REDACTED : value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      safe[key] = value;
      continue;
    }
    // Objects, arrays and functions never pass.
    safe[key] = REDACTED;
  }

  return safe;
}

/**
 * Masks what can still hide inside an otherwise short error message.
 *
 * `hint` is the one field that carries text this module did not write, so it
 * gets a second pass once it is known to be short: anything shaped like a
 * credential, an address or an account number is replaced, whatever produced
 * it. The patterns are deliberately broad — a false positive costs a word in a
 * log line; a false negative puts a bank token in a vendor's index.
 */
const HINT_SCRUBBERS: readonly [RegExp, string][] = [
  // Provider credentials and signing secrets.
  [/\b(?:access|public|link|processor)-(?:sandbox|development|production)-[A-Za-z0-9-]+/g, "[token]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]+/g, "[key]"],
  [/\bwhsec_[A-Za-z0-9]+/g, "[key]"],
  [/\bsk-ant-[A-Za-z0-9_-]+/g, "[key]"],
  // JWTs, and anything presented as a bearer credential.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  // People and money.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/\b\d{9,}\b/g, "[number]"],
];

export function scrubMessage(message: string): string {
  return HINT_SCRUBBERS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);
}

/**
 * The error name and a short, non-sensitive summary — never a long
 * `error.message`, which routinely carries connection strings, row values and
 * provider internals, and a short one only after `scrubMessage`.
 */
function describe(error: unknown): { name: string; hint: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", hint: error.message.length > 200 ? REDACTED : scrubMessage(error.message) };
  }
  return { name: typeof error, hint: REDACTED };
}

export interface ReportedError {
  severity: Severity;
  scope: ReportContext["scope"];
  errorName: string;
  detail: Record<string, unknown>;
  at: string;
}

/**
 * WHERE RECORDS GO — the vendor integration boundary.
 *
 * Every record is written to the console (which a host's log pipeline — a
 * Vercel log drain, for instance — can forward anywhere, with no code) and
 * then handed to each registered sink. A sink is how an error-tracking vendor
 * attaches, from `src/instrumentation.ts`, without this module knowing its
 * name:
 *
 *   registerObservabilitySink({ name: "vendor", capture: (record) => … });
 *
 * A sink receives the record AFTER redaction and scrubbing — never the raw
 * error, never the request — so the guarantees above hold for every
 * destination. A sink that throws is dropped for that record and reported once
 * to the console: observability must never be the reason a request fails.
 *
 * With no sink registered, nothing changes: the console is the destination,
 * exactly as before.
 */
export interface ObservabilitySink {
  /** Short, for the one-line notice if the sink fails. */
  readonly name: string;
  capture(record: Readonly<ReportedError>): void;
}

const sinks: ObservabilitySink[] = [];

export function registerObservabilitySink(sink: ObservabilitySink): () => void {
  if (!sinks.some((existing) => existing.name === sink.name)) sinks.push(sink);
  return () => {
    const index = sinks.findIndex((existing) => existing.name === sink.name);
    if (index !== -1) sinks.splice(index, 1);
  };
}

/** Test seam: forget every registered sink. */
export function __resetObservabilitySinksForTests(): void {
  sinks.length = 0;
}

/**
 * Production logs are one JSON object per line, so a log drain or a parser
 * can index `event`, `scope` and `severity` without guessing where a
 * multi-line object ends. Development keeps the readable form.
 */
function writeToConsole(record: ReportedError): void {
  const line =
    process.env.NODE_ENV === "production"
      ? [JSON.stringify({ severity: record.severity, scope: record.scope, event: record.errorName, detail: record.detail, at: record.at })]
      : [`[${record.scope}] ${record.errorName}`, record.detail];

  if (record.severity === "error") console.error(...line);
  else if (record.severity === "warning") console.warn(...line);
  else console.info(...line);
}

function emit(record: ReportedError): void {
  writeToConsole(record);
  for (const sink of [...sinks]) {
    try {
      sink.capture(record);
    } catch {
      // Named, never the record: the record already went to the console above.
      console.warn(`[observability] sink "${sink.name}" failed to capture ${record.errorName}`);
    }
  }
}

/**
 * Records an error. Returns what was recorded so callers (and tests) can
 * assert that nothing sensitive survived redaction.
 */
export function reportError(error: unknown, context: ReportContext, severity: Severity = "error"): ReportedError {
  const { name, hint } = describe(error);
  const record: ReportedError = {
    severity,
    scope: context.scope,
    errorName: name,
    detail: {
      ...redact(context.detail),
      ...(context.organizationId ? { organizationId: context.organizationId } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
      ...(context.digest ? { digest: context.digest } : {}),
      hint,
    },
    at: new Date().toISOString(),
  };

  emit(record);
  return record;
}

/** A notable non-error event: a rate limit firing, a confirmation executing,
 *  a deletion completing. Same redaction, lower severity. */
export function reportEvent(name: string, context: ReportContext, severity: Severity = "info"): ReportedError {
  const record: ReportedError = {
    severity,
    scope: context.scope,
    errorName: name,
    detail: {
      ...redact(context.detail),
      ...(context.organizationId ? { organizationId: context.organizationId } : {}),
      ...(context.userId ? { userId: context.userId } : {}),
    },
    at: new Date().toISOString(),
  };

  emit(record);
  return record;
}
