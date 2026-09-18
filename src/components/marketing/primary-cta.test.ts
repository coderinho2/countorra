import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { MarketingAuthState } from "@/server/marketing/auth-state";

const state = vi.hoisted(() => ({ current: null as MarketingAuthState | null }));

vi.mock("@/server/marketing/auth-state", () => ({
  getMarketingAuthState: async () => state.current,
}));

const { PrimaryCta, SignInLink } = await import("./primary-cta");

const SIGNED_OUT: MarketingAuthState = { identity: null, appHref: "/app", settingsHref: "/app" };
const SIGNED_IN: MarketingAuthState = {
  identity: { displayName: "Ada Lovelace", initials: "AL" },
  appHref: "/app/8f14e45f-ceea-467a-9dc0-8e2b09c9b0a1/dashboard",
  settingsHref: "/app/8f14e45f-ceea-467a-9dc0-8e2b09c9b0a1/settings",
};

/** The rendered CTA is a Button wrapping a single Link; this reads the
 *  destination and label back out of that pair. */
function readCta(element: ReactElement) {
  const link = (element.props as { children: ReactElement }).children;
  const linkProps = link.props as { href: string; children: string };
  return { href: linkProps.href, label: linkProps.children };
}

describe("PrimaryCta", () => {
  beforeEach(() => {
    state.current = SIGNED_OUT;
  });

  it("invites a signed-out visitor to sign up", async () => {
    const cta = readCta(await PrimaryCta({}));
    expect(cta).toEqual({ href: "/signup", label: "Get started" });
  });

  it("honours a caller's signed-out label", async () => {
    const cta = readCta(await PrimaryCta({ signedOutLabel: "Start free" }));
    expect(cta.label).toBe("Start free");
  });

  it("sends a signed-in visitor into their own workspace, never to signup", async () => {
    state.current = SIGNED_IN;
    const cta = readCta(await PrimaryCta({}));
    expect(cta).toEqual({ href: SIGNED_IN.appHref, label: "Open Countorra" });
    expect(cta.href).not.toContain("signup");
  });

  it("ignores the signed-out label entirely once there is a session", async () => {
    state.current = SIGNED_IN;
    const cta = readCta(await PrimaryCta({ signedOutLabel: "Get started" }));
    expect(cta.label).toBe("Open Countorra");
  });

  it("falls back to /app for a signed-in user with no organization yet", async () => {
    state.current = { ...SIGNED_IN, appHref: "/app" };
    expect(readCta(await PrimaryCta({})).href).toBe("/app");
  });
});

describe("SignInLink", () => {
  it("offers sign-in to a signed-out visitor", async () => {
    state.current = SIGNED_OUT;
    const element = await SignInLink({});
    expect(element).not.toBeNull();
    expect((element!.props as { href: string }).href).toBe("/login");
  });

  it("renders nothing at all once there is a session", async () => {
    state.current = SIGNED_IN;
    expect(await SignInLink({})).toBeNull();
  });
});
