import { describe, expect, it } from "vitest";
import { ProviderError, malformedResponse, toProviderError } from "./provider-errors";

/**
 * Every provider failure has to arrive at the user as a sentence they can act
 * on, carrying nothing about our infrastructure. These assert both halves:
 * the right classification, and that nothing from the original error survives
 * into the message.
 */

function sdkError(name: string, status?: number, message = "internal detail: pod-7 conn=postgres://user:pw@host") {
  const e = new Error(message) as Error & { status?: number };
  e.name = name;
  if (status !== undefined) e.status = status;
  return e;
}

describe("toProviderError", () => {
  it.each([
    ["a 429 status", sdkError("APIError", 429), "rate_limited"],
    ["a named RateLimitError", sdkError("RateLimitError"), "rate_limited"],
    ["a 500", sdkError("APIError", 500), "unavailable"],
    ["a 502", sdkError("APIError", 502), "unavailable"],
    ["a 503", sdkError("APIError", 503), "unavailable"],
    ["a 529 overloaded", sdkError("APIError", 529), "unavailable"],
    ["a connection error", sdkError("APIConnectionError"), "unavailable"],
    ["a timeout", sdkError("APIConnectionTimeoutError"), "timeout"],
    ["an abort", sdkError("AbortError"), "timeout"],
    ["a 401", sdkError("AuthenticationError", 401), "unauthorized"],
    ["a 403", sdkError("PermissionDeniedError", 403), "unauthorized"],
    ["an unrecognised failure", sdkError("TypeError"), "unknown"],
  ])("classifies %s as %s", (_label, error, kind) => {
    expect(toProviderError(error).kind).toBe(kind);
  });

  it("marks transient failures retryable and permanent ones not", () => {
    expect(toProviderError(sdkError("APIError", 429)).retryable).toBe(true);
    expect(toProviderError(sdkError("APIError", 503)).retryable).toBe(true);
    expect(toProviderError(sdkError("APIConnectionTimeoutError")).retryable).toBe(true);

    expect(toProviderError(sdkError("AuthenticationError", 401)).retryable).toBe(false);
    expect(toProviderError(sdkError("TypeError")).retryable).toBe(false);
    expect(malformedResponse("bad shape").retryable).toBe(false);
  });

  it("never carries the original message through to the user", () => {
    const leaky = sdkError("APIError", 500, "connect ECONNREFUSED 10.0.0.4:5432 password=hunter2");
    const safe = toProviderError(leaky);

    expect(safe.message).not.toContain("ECONNREFUSED");
    expect(safe.message).not.toContain("10.0.0.4");
    expect(safe.message).not.toContain("hunter2");
  });

  it("keeps the original as `cause` for server-side logging", () => {
    const original = sdkError("APIError", 500);
    expect(toProviderError(original).cause).toBe(original);
  });

  it("does not tell an end user that an API key is the problem", () => {
    const message = toProviderError(sdkError("AuthenticationError", 401, "invalid x-api-key")).message;

    expect(message).not.toMatch(/api[- ]?key/i);
    expect(message).not.toMatch(/token|credential|auth/i);
  });

  it("passes an already-classified error through unchanged", () => {
    const already = new ProviderError("rate_limited", "busy");
    expect(toProviderError(already)).toBe(already);
  });

  it.each([null, undefined, "a string", 42, {}])("handles a non-Error throw: %s", (thrown) => {
    const safe = toProviderError(thrown);
    expect(safe).toBeInstanceOf(ProviderError);
    expect(safe.message.length).toBeGreaterThan(0);
  });

  it("gives every failure kind a non-empty, non-technical message", () => {
    const kinds = [
      toProviderError(sdkError("RateLimitError")),
      toProviderError(sdkError("APIError", 503)),
      toProviderError(sdkError("APIConnectionTimeoutError")),
      toProviderError(sdkError("AuthenticationError", 401)),
      toProviderError(sdkError("TypeError")),
      malformedResponse("x"),
    ];

    for (const error of kinds) {
      expect(error.message.length).toBeGreaterThan(20);
      expect(error.message).not.toMatch(/\b(stack|undefined|null|Error:)\b/);
    }
  });
});

describe("malformedResponse", () => {
  it("says nothing was changed, because a half-read answer is the danger", () => {
    expect(malformedResponse("content was not an array").message).toContain("Nothing was changed");
  });

  it("keeps the technical detail off the message and on the cause", () => {
    const error = malformedResponse("response.content was not an array");
    expect(error.message).not.toContain("response.content");
    expect((error.cause as Error).message).toContain("response.content");
  });
});
