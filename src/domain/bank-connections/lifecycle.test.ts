import { describe, expect, it } from "vitest";
import { CONNECTION_STATUSES, type ConnectionStatus } from "./types";
import { CONNECTION_TRANSITIONS, InvalidConnectionTransitionError, assertConnectionTransition, canSync, canTransitionConnection, nextConnectionStatus } from "./lifecycle";

describe("connection transition table", () => {
  it("defines every status", () => {
    expect(Object.keys(CONNECTION_TRANSITIONS).sort()).toEqual([...CONNECTION_STATUSES].sort());
  });

  it("makes DISCONNECTED terminal", () => {
    for (const to of CONNECTION_STATUSES) expect(canTransitionConnection("DISCONNECTED", to)).toBe(false);
  });

  it("allows disconnecting from every live status", () => {
    for (const from of CONNECTION_STATUSES.filter((s) => s !== "DISCONNECTED")) expect(canTransitionConnection(from, "DISCONNECTED")).toBe(true);
  });

  it("never lets a connection go back to PENDING", () => {
    for (const from of CONNECTION_STATUSES) expect(canTransitionConnection(from, "PENDING")).toBe(false);
  });

  it("rejects illegal transitions with a typed error", () => {
    expect(() => assertConnectionTransition("PENDING", "REQUIRES_REAUTH")).toThrow(InvalidConnectionTransitionError);
    expect(() => assertConnectionTransition("REQUIRES_REAUTH", "DEGRADED")).toThrow(InvalidConnectionTransitionError);
    expect(() => assertConnectionTransition("ACTIVE", "ERROR")).not.toThrow();
  });
});

describe("what events do to a connection", () => {
  it("activates a pending connection when the link completes, and only then", () => {
    expect(nextConnectionStatus("PENDING", { kind: "LINK_COMPLETED" })).toEqual({ kind: "transition", from: "PENDING", to: "ACTIVE", reason: "LINK_COMPLETED" });
    expect(nextConnectionStatus("ACTIVE", { kind: "LINK_COMPLETED" }).kind).toBe("ignored");
  });

  it("ignores every event after disconnection", () => {
    const events = [
      { kind: "SYNC_SUCCEEDED" },
      { kind: "PROVIDER_RECOVERED" },
      { kind: "PROVIDER_REAUTH_REQUIRED" },
      { kind: "USER_DISCONNECTED" },
    ] as const;
    for (const event of events) expect(nextConnectionStatus("DISCONNECTED", event)).toEqual({ kind: "ignored", status: "DISCONNECTED", why: "TERMINAL" });
  });

  it("degrades on the first failed run, and errors only after repeated failures", () => {
    expect(nextConnectionStatus("ACTIVE", { kind: "SYNC_FAILED", category: "PROVIDER_UNAVAILABLE", consecutiveFailures: 1 })).toMatchObject({ to: "DEGRADED" });
    expect(nextConnectionStatus("DEGRADED", { kind: "SYNC_FAILED", category: "PROVIDER_TIMEOUT", consecutiveFailures: 2 })).toEqual({ kind: "unchanged", status: "DEGRADED" });
    expect(nextConnectionStatus("DEGRADED", { kind: "SYNC_FAILED", category: "PROVIDER_TIMEOUT", consecutiveFailures: 3 })).toMatchObject({ to: "ERROR", reason: "REPEATED_SYNC_FAILURE" });
  });

  it("asks the person to act immediately when only they can fix it", () => {
    expect(nextConnectionStatus("ACTIVE", { kind: "SYNC_FAILED", category: "REAUTH_REQUIRED", consecutiveFailures: 1 })).toMatchObject({ to: "REQUIRES_REAUTH" });
    expect(nextConnectionStatus("ACTIVE", { kind: "SYNC_FAILED", category: "CONNECTION_REVOKED", consecutiveFailures: 1 })).toMatchObject({ to: "ERROR", reason: "PROVIDER_REVOKED" });
  });

  it("does not let a successful run silently clear a re-authentication request", () => {
    expect(nextConnectionStatus("REQUIRES_REAUTH", { kind: "SYNC_SUCCEEDED" })).toEqual({ kind: "unchanged", status: "REQUIRES_REAUTH" });
  });

  it("recovers a degraded connection on a successful run", () => {
    expect(nextConnectionStatus("DEGRADED", { kind: "SYNC_SUCCEEDED" })).toMatchObject({ to: "ACTIVE", reason: "SYNC_SUCCEEDED" });
    expect(nextConnectionStatus("ACTIVE", { kind: "SYNC_SUCCEEDED" })).toEqual({ kind: "unchanged", status: "ACTIVE" });
  });

  it("treats failures unrelated to the connection as no change", () => {
    for (const category of ["CURSOR_CONFLICT", "CONNECTION_DISCONNECTED", "PROVIDER_NOT_CONFIGURED"] as const) {
      expect(nextConnectionStatus("ACTIVE", { kind: "SYNC_FAILED", category, consecutiveFailures: 5 })).toEqual({ kind: "unchanged", status: "ACTIVE" });
    }
  });

  it("only ever proposes transitions the table allows", () => {
    const events = [
      { kind: "LINK_COMPLETED" },
      { kind: "SYNC_SUCCEEDED" },
      { kind: "SYNC_FAILED", category: "PROVIDER_UNAVAILABLE", consecutiveFailures: 1 },
      { kind: "SYNC_FAILED", category: "PROVIDER_UNAVAILABLE", consecutiveFailures: 9 },
      { kind: "SYNC_FAILED", category: "REAUTH_REQUIRED", consecutiveFailures: 1 },
      { kind: "PROVIDER_REAUTH_REQUIRED" },
      { kind: "PROVIDER_ERROR" },
      { kind: "PROVIDER_REVOKED" },
      { kind: "PROVIDER_RECOVERED" },
      { kind: "CONSENT_EXPIRED" },
      { kind: "USER_DISCONNECTED" },
    ] as const;
    for (const from of CONNECTION_STATUSES) {
      for (const event of events) {
        const decision = nextConnectionStatus(from as ConnectionStatus, event);
        if (decision.kind === "transition") expect(canTransitionConnection(decision.from, decision.to)).toBe(true);
      }
    }
  });

  it("syncs only connections that can still import", () => {
    expect(CONNECTION_STATUSES.filter(canSync)).toEqual(["ACTIVE", "DEGRADED", "ERROR"]);
  });
});
