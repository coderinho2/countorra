/**
 * Provider failures, classified once and phrased for a person.
 *
 * Everything that can go wrong between this app and Anthropic — a 429, a 503,
 * a socket timeout, a response whose shape is not what the SDK promised —
 * arrives as some provider-shaped object carrying provider-shaped text. None
 * of it belongs in front of a user, and none of it belongs in the message
 * transcript either, because that transcript is read back later by both the
 * user and the model.
 *
 * So the classification happens here, at the boundary, and only a
 * `ProviderError` crosses it. The `kind` exists so callers can react
 * differently (a 429 is worth retrying later, a malformed response is not)
 * without re-parsing an error string; the `message` is always safe to display.
 */

export type ProviderFailureKind = "rate_limited" | "unavailable" | "timeout" | "malformed" | "unauthorized" | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderFailureKind;
  /** Whether trying the same request again could plausibly succeed. Recorded
   *  for callers and logs — this class never retries anything itself. */
  readonly retryable: boolean;

  constructor(kind: ProviderFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = kind === "rate_limited" || kind === "unavailable" || kind === "timeout";
  }
}

const MESSAGES: Record<ProviderFailureKind, string> = {
  rate_limited: "The assistant is handling a lot of requests right now. Please try again in a moment.",
  unavailable: "The assistant is temporarily unavailable. Please try again shortly.",
  timeout: "The assistant took too long to respond. Please try again.",
  // Deliberately not "something went wrong": a malformed reply means we do
  // not know what the model intended, and the one thing that must not happen
  // is a half-understood answer about someone's money being presented anyway.
  malformed: "The assistant returned a response that could not be read. Nothing was changed.",
  // A missing or rejected key is an operator problem, and saying "check your
  // API key" to an end user is both useless and a configuration disclosure.
  unauthorized: "The assistant is not available right now.",
  unknown: "The assistant could not complete this request. Nothing was changed.",
};

/**
 * Maps whatever the SDK threw onto a safe `ProviderError`.
 *
 * Matched on `status` and constructor name rather than by importing the SDK's
 * error classes, so this module stays free of the provider dependency and a
 * future second provider can reuse it.
 */
export function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;

  const candidate = error as { status?: number; name?: string; message?: string } | null | undefined;
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const name = candidate?.name ?? "";

  if (status === 429 || name === "RateLimitError") {
    return new ProviderError("rate_limited", MESSAGES.rate_limited, { cause: error });
  }
  if (status === 401 || status === 403 || name === "AuthenticationError" || name === "PermissionDeniedError") {
    return new ProviderError("unauthorized", MESSAGES.unauthorized, { cause: error });
  }
  if (status !== undefined && status >= 500) {
    return new ProviderError("unavailable", MESSAGES.unavailable, { cause: error });
  }
  if (name === "APIConnectionTimeoutError" || name === "TimeoutError" || name === "AbortError") {
    return new ProviderError("timeout", MESSAGES.timeout, { cause: error });
  }
  if (name === "APIConnectionError") {
    return new ProviderError("unavailable", MESSAGES.unavailable, { cause: error });
  }

  return new ProviderError("unknown", MESSAGES.unknown, { cause: error });
}

/** Raised when a response parses as JSON but is not the shape the SDK's types
 *  promise — a case the type system cannot rule out at runtime. */
export function malformedResponse(detail: string): ProviderError {
  return new ProviderError("malformed", MESSAGES.malformed, { cause: new Error(detail) });
}
