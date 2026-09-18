import { describe, expect, it } from "vitest";
import { UnauthorizedAiActionError, assertAuthorized, requiresConfirmation } from "./safety";

describe("requiresConfirmation", () => {
  it("is true only for write and delete", () => {
    expect(requiresConfirmation("read")).toBe(false);
    expect(requiresConfirmation("analyze")).toBe(false);
    expect(requiresConfirmation("calculate")).toBe(false);
    expect(requiresConfirmation("suggest")).toBe(false);
    expect(requiresConfirmation("write")).toBe(true);
    expect(requiresConfirmation("delete")).toBe(true);
  });
});

describe("assertAuthorized", () => {
  it("never throws for non-mutating modes, confirmed or not", () => {
    expect(() => assertAuthorized("getTransactions", "read", false)).not.toThrow();
    expect(() => assertAuthorized("calculateProfit", "calculate", false)).not.toThrow();
  });

  it("throws for write/delete without confirmation", () => {
    expect(() => assertAuthorized("deleteTransaction", "delete", false)).toThrow(UnauthorizedAiActionError);
    expect(() => assertAuthorized("createInvoice", "write", false)).toThrow(UnauthorizedAiActionError);
  });

  it("does not throw for write/delete once confirmed", () => {
    expect(() => assertAuthorized("deleteTransaction", "delete", true)).not.toThrow();
  });
});
