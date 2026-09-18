import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetObservabilitySinksForTests, registerObservabilitySink, type ReportedError } from "@/lib/observability";
import { onRequestError, register } from "./instrumentation";

/**
 * Unhandled request errors now pass through the redaction boundary.
 *
 * The point of these tests is what is NOT recorded: the concrete path (which
 * can carry a public invoice token or tenant ids) and the headers (which carry
 * the session cookie).
 */

let captured: ReportedError[];

beforeEach(() => {
  captured = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  registerObservabilitySink({ name: "test", capture: (record) => void captured.push(record) });
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetObservabilitySinksForTests();
});

const request = {
  path: "/invoice/inv_tok_SECRETPUBLICTOKEN123?utm=x",
  method: "GET",
  headers: { cookie: "sb-access-token=eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4", authorization: "Bearer abc" },
};
const context = { routerKind: "App Router", routePath: "/invoice/[token]", routeType: "render", renderSource: "server-rendering", revalidateReason: undefined } as const;

describe("unhandled request errors", () => {
  it("are recorded with the route pattern, never the concrete path or headers", async () => {
    const error = Object.assign(new Error("boom"), { digest: "1234567" });
    await onRequestError(error, request, context);

    expect(captured).toHaveLength(1);
    const [record] = captured;
    expect(record).toMatchObject({ scope: "route", severity: "error", errorName: "Error" });
    expect(record.detail).toMatchObject({ routePath: "/invoice/[token]", routeType: "render", routerKind: "App Router", method: "GET", digest: "1234567" });

    const everything = JSON.stringify(record);
    expect(everything).not.toContain("SECRETPUBLICTOKEN");
    expect(everything).not.toContain("sb-access-token");
    expect(everything).not.toContain("eyJhbGci");
    expect(everything).not.toContain("Bearer abc");
    expect(everything).not.toContain("utm=");
  });

  it("scrub whatever the error message itself carries", async () => {
    await onRequestError(new Error("failed for person@example.test with access-sandbox-9f9f"), request, context);
    const hint = String(captured[0].detail.hint);
    expect(hint).not.toContain("person@example.test");
    expect(hint).not.toContain("access-sandbox-9f9f");
  });

  it("survive something that is not an Error at all", async () => {
    await expect(Promise.resolve(onRequestError("a string was thrown", request, context))).resolves.not.toThrow();
    expect(captured[0].errorName).toBe("string");
  });
});

describe("process start", () => {
  it("registers nothing, and needs nothing, while no vendor is configured", async () => {
    await expect(register()).resolves.toBeUndefined();
  });
});
