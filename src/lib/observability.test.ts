import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetObservabilitySinksForTests, redact, registerObservabilitySink, reportError, reportEvent, scrubMessage, type ReportedError } from "./observability";

/**
 * The redaction contract, tested as a security control rather than a
 * formatting nicety.
 *
 * This module is the point where a vendor will eventually be wired in. Once
 * that happens, anything that reaches it leaves the building — so the
 * guarantees about what must never reach it have to hold before the pipe
 * exists, not after.
 */

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetObservabilitySinksForTests();
});

describe("redact", () => {
  it.each([
    "apiKey",
    "ANTHROPIC_API_KEY",
    "x-api-key",
    "accessToken",
    "refresh_token",
    "serviceRoleSecret",
    "password",
    "Authorization",
    "cookie",
    "sessionId",
    "credentials",
  ])("never records the value of %s", (key) => {
    expect(redact({ [key]: "sk-ant-super-secret-value" })[key]).toBe("[redacted]");
  });

  it.each(["prompt", "userPrompt", "message", "content", "answer"])("never records %s — a financial question is itself sensitive", (key) => {
    expect(redact({ [key]: "can I afford the surgery" })[key]).toBe("[redacted]");
  });

  it.each(["amount", "amountMinor", "balance", "totalMinor"])("never records %s", (key) => {
    expect(redact({ [key]: 1_500_00 })[key]).toBe("[redacted]");
  });

  it.each(["email", "userEmail", "fullName", "displayName"])("never records %s", (key) => {
    expect(redact({ [key]: "person@example.test" })[key]).toBe("[redacted]");
  });

  it("keeps identifiers and operational fields, which are what make an event actionable", () => {
    const safe = redact({ organizationId: "org-1", userId: "user-1", toolName: "getCashFlow", ruleName: "aiMessagePerUser", status: 429, retried: true });

    expect(safe).toEqual({
      organizationId: "org-1",
      userId: "user-1",
      toolName: "getCashFlow",
      ruleName: "aiMessagePerUser",
      status: 429,
      retried: true,
    });
  });

  it("distinguishes an operational *Name field from a personal one", () => {
    // A substring rule on "name" would redact both and make logs useless.
    const safe = redact({ toolName: "getIncome", fullName: "A Person", displayName: "A Person", name: "A Person" });

    expect(safe.toolName).toBe("getIncome");
    expect(safe.fullName).toBe("[redacted]");
    expect(safe.displayName).toBe("[redacted]");
    expect(safe.name).toBe("[redacted]");
  });

  it("distinguishes a money field from a count", () => {
    const safe = redact({ amountMinor: 150_000, totalMinor: 1, total: 5, messageCount: 12, transactionCount: 1600 });

    expect(safe.amountMinor).toBe("[redacted]");
    expect(safe.totalMinor).toBe("[redacted]");
    expect(safe.total).toBe("[redacted]");
    expect(safe.messageCount).toBe(12);
    expect(safe.transactionCount).toBe(1600);
  });

  it("redacts a long string even under an innocuous key, because length means content", () => {
    expect(redact({ note: "x".repeat(201) }).note).toBe("[redacted]");
    expect(redact({ note: "short label" }).note).toBe("short label");
  });

  it("refuses nested objects, so nothing can be smuggled through a sub-field", () => {
    expect(redact({ payload: { apiKey: "secret" } }).payload).toBe("[redacted]");
    expect(redact({ rows: [{ amountMinor: 1 }] }).rows).toBe("[redacted]");
  });

  it("preserves null and undefined rather than turning them into strings", () => {
    expect(redact({ a: null, b: undefined })).toEqual({ a: null, b: undefined });
  });

  it("returns an empty object for no detail", () => {
    expect(redact(undefined)).toEqual({});
  });
});

describe("reportError", () => {
  it("records the error name and scope", () => {
    const record = reportError(new TypeError("boom"), { scope: "ai" });

    expect(record.errorName).toBe("TypeError");
    expect(record.scope).toBe("ai");
    expect(record.severity).toBe("error");
  });

  it("redacts an over-long provider message rather than recording it", () => {
    const leaky = new Error("connect ECONNREFUSED 10.0.0.4:5432 password=hunter2 ".repeat(10));
    const record = reportError(leaky, { scope: "financial" });

    expect(record.detail.hint).toBe("[redacted]");
    expect(JSON.stringify(record)).not.toContain("hunter2");
  });

  it("keeps a short message, which is usually a real hint", () => {
    expect(reportError(new Error("row not found"), { scope: "financial" }).detail.hint).toBe("row not found");
  });

  it("carries identifiers through for correlation", () => {
    const record = reportError(new Error("x"), { scope: "route", organizationId: "org-1", userId: "user-1", digest: "abc123" });

    expect(record.detail).toMatchObject({ organizationId: "org-1", userId: "user-1", digest: "abc123" });
  });

  it("redacts sensitive detail even when a caller passes it by mistake", () => {
    // The point of centralizing: one careless call site cannot leak.
    const record = reportError(new Error("x"), { scope: "ai", detail: { prompt: "how much do I have", apiKey: "sk-ant-x" } });

    expect(record.detail.prompt).toBe("[redacted]");
    expect(record.detail.apiKey).toBe("[redacted]");
  });

  it("handles a non-Error throw without crashing the reporter", () => {
    expect(reportError("just a string", { scope: "security" }).errorName).toBe("string");
    expect(reportError(null, { scope: "security" }).errorName).toBe("object");
  });
});

describe("reportEvent", () => {
  it("records a named event with its scope", () => {
    const record = reportEvent("rate_limit_blocked", { scope: "security", detail: { rule: "aiMessagePerUser" } });

    expect(record.errorName).toBe("rate_limit_blocked");
    expect(record.detail.rule).toBe("aiMessagePerUser");
    expect(record.severity).toBe("info");
  });

  it("applies the same redaction as reportError", () => {
    const record = reportEvent("deletion_completed", { scope: "security", detail: { email: "a@b.test", organizationId: "org-1" } });

    expect(record.detail.email).toBe("[redacted]");
    expect(record.detail.organizationId).toBe("org-1");
  });
});

/**
 * Credential-shaped fixtures are assembled at runtime, never written as one
 * literal: a literal `sk_live_…` in source is exactly what a repository secret
 * scanner (GitHub push protection included) is built to stop, and these are
 * fake. The scrubber only ever sees the assembled string.
 */
const fake = (...parts: string[]) => parts.join("");

describe("the short message that survives as a hint", () => {
  it.each([
    ["a Plaid access token", `token ${fake("access-", "sandbox-", "1a2b3c4d-5e6f")} invalid`, fake("access-", "sandbox-", "1a2b3c4d-5e6f")],
    ["a Plaid production token", `${fake("access-", "production-", "99aa-bb77")} revoked`, fake("access-", "production-", "99aa-bb77")],
    ["a Stripe secret key", `No such key ${fake("sk_", "live_", "abc123DEF456")}`, fake("sk_", "live_", "abc123DEF456")],
    ["a Stripe webhook secret", `bad secret ${fake("whsec", "_abcDEF123456")}`, fake("whsec", "_abcDEF123456")],
    ["an Anthropic key", `rejected ${fake("sk-", "ant-", "api03-abcdefgh")}`, fake("sk-", "ant-", "api03-abcdefgh")],
    ["a bearer credential", "sent Bearer c29tZS1zZWNyZXQtdmFsdWU= upstream", "c29tZS1zZWNyZXQtdmFsdWU="],
    ["a JWT", "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4 expired", "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"],
    ["an email address", "duplicate for person@example.test", "person@example.test"],
    ["an account number", "account 000123456789 not found", "000123456789"],
  ])("never keeps %s", (_label, message, secret) => {
    const hint = reportError(new Error(message), { scope: "bank" }).detail.hint as string;
    expect(hint).not.toContain(secret);
    expect(scrubMessage(message)).not.toContain(secret);
  });

  it("leaves an ordinary hint readable", () => {
    expect(scrubMessage("row not found")).toBe("row not found");
    expect(scrubMessage("Request failed with status code 429")).toBe("Request failed with status code 429");
    // Short numbers are statuses and counts, not account numbers.
    expect(scrubMessage("retry 3 of 5 after 12345 ms")).toBe("retry 3 of 5 after 12345 ms");
  });
});

describe("where records go", () => {
  it("writes each severity to the matching console method", () => {
    reportEvent("a.info", { scope: "bank" });
    reportEvent("a.warning", { scope: "bank" }, "warning");
    reportEvent("a.error", { scope: "bank" }, "error");

    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("writes one parseable JSON line per record in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    reportEvent("bank.worker_invocation", { scope: "bank", detail: { invoker: "vercel-cron", apiKey: "sk-ant-x" } }, "warning");

    const [line, ...rest] = vi.mocked(console.warn).mock.calls[0];
    expect(rest).toEqual([]);
    const parsed = JSON.parse(String(line));
    expect(parsed).toMatchObject({ severity: "warning", scope: "bank", event: "bank.worker_invocation", detail: { invoker: "vercel-cron", apiKey: "[redacted]" } });
    expect(String(line)).not.toContain(String.fromCharCode(10));
  });

  it("hands every record to a registered sink, already redacted", () => {
    const captured: ReportedError[] = [];
    registerObservabilitySink({ name: "test", capture: (record) => void captured.push(record) });

    reportError(new Error("token access-sandbox-abc123 invalid"), { scope: "bank", detail: { password: "hunter2", jobId: "job-1" } });
    reportEvent("bank.worker_backlog", { scope: "bank", detail: { dueJobs: 4 } }, "warning");

    expect(captured).toHaveLength(2);
    expect(captured[0].detail).toMatchObject({ password: "[redacted]", jobId: "job-1" });
    expect(String(captured[0].detail.hint)).not.toContain("access-sandbox-abc123");
    expect(captured[1]).toMatchObject({ errorName: "bank.worker_backlog", severity: "warning", detail: { dueJobs: 4 } });
  });

  it("never lets a failing sink break the caller, or starve the next sink", () => {
    const captured: string[] = [];
    registerObservabilitySink({ name: "broken", capture: () => { throw new Error("vendor down"); } });
    registerObservabilitySink({ name: "working", capture: (record) => void captured.push(record.errorName) });

    expect(() => reportEvent("still.recorded", { scope: "bank" })).not.toThrow();
    expect(captured).toEqual(["still.recorded"]);
    // Named, never the record.
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain('sink "broken" failed');
  });

  it("registers a sink once, and can remove it", () => {
    const captured: string[] = [];
    const sink = { name: "once", capture: (record: ReportedError) => void captured.push(record.errorName) };
    registerObservabilitySink(sink);
    const remove = registerObservabilitySink(sink);

    reportEvent("first", { scope: "bank" });
    remove();
    reportEvent("second", { scope: "bank" });

    expect(captured).toEqual(["first"]);
  });

  it("works exactly as before with no sink at all", () => {
    const record = reportError(new Error("row not found"), { scope: "financial" });
    expect(record.detail.hint).toBe("row not found");
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
