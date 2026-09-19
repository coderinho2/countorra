import { describe, expect, it, vi } from "vitest";
import { parseCredentialKeyset } from "@/server/bank-connections/credential-crypto";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, set: () => {} }) }));
const { openBankLinkState, sealBankLinkState } = await import("@/server/bank-connections/link-state");

/** The seal itself, without actions around it. */

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64");
const OLD = parseCredentialKeyset(`old:${key(1)}`);
const ROTATED = parseCredentialKeyset(`new:${key(2)},old:${key(1)}`);
const STATE = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  connectionId: null,
  mode: "connect" as const,
  linkToken: "link-sandbox-0000",
};
const now = new Date("2026-09-18T12:00:00Z");

describe("a sealed Link session", () => {
  it("opens to exactly what was sealed", () => {
    const opened = openBankLinkState(sealBankLinkState(STATE, OLD, now), OLD, now);
    expect(opened).toMatchObject({ ...STATE, expiresAt: Math.floor(now.getTime() / 1000) + 30 * 60 });
  });

  it("still opens after the keyset is rotated, while the old key is listed", () => {
    const sealedWithOld = sealBankLinkState(STATE, OLD, now);
    expect(openBankLinkState(sealedWithOld, ROTATED, now)).not.toBeNull();
    // And new seals use the new key.
    expect(sealBankLinkState(STATE, ROTATED, now).split(".")[1]).toBe("new");
  });

  it("is refused once the key that sealed it is retired", () => {
    const sealedWithNew = sealBankLinkState(STATE, ROTATED, now);
    expect(openBankLinkState(sealedWithNew, OLD, now)).toBeNull();
  });

  it("is refused if issued in the future, which only a forger or a broken clock produces", () => {
    const future = sealBankLinkState(STATE, OLD, new Date(now.getTime() + 10 * 60_000));
    expect(openBankLinkState(future, OLD, now)).toBeNull();
  });

  it.each([null, "", "v1", "v2.old.a.b.c", "v1.old.!!.!!.!!", "x".repeat(5000)])("treats %j as nothing to resume", (value) => {
    expect(openBankLinkState(value as string | null, OLD, now)).toBeNull();
  });

  it("will not seal an inconsistent session: a repair must name its connection", () => {
    expect(() => sealBankLinkState({ ...STATE, mode: "reauthenticate" }, OLD, now)).toThrow();
    expect(() => sealBankLinkState({ ...STATE, connectionId: "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0" }, OLD, now)).toThrow();
  });
});
