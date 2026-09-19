import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "@/domain/billing/entitlements";
import * as setup from "../../scripts/stripe-test-setup.mjs";

/**
 * scripts/stripe-test-setup.mjs — the Stripe TEST MODE setup and pre-flight
 * (Task 18.1). No test here contacts Stripe: the subprocess runs from an empty
 * directory with no key, or with a live-shaped key it must refuse before any
 * call.
 */

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts/stripe-test-setup.mjs");
const empty = mkdtempSync(path.join(tmpdir(), "countorra-stripe-setup-"));

afterAll(() => rmSync(empty, { recursive: true, force: true }));

function run(mode: string, env: Record<string, string>) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("STRIPE_") && !k.startsWith("NEXT_PUBLIC_")));
  return spawnSync(process.execPath, [SCRIPT, mode], { cwd: empty, env: { ...clean, ...env } as NodeJS.ProcessEnv, encoding: "utf8", timeout: 20_000 });
}

describe("the script matches the app it configures", () => {
  it("pins the same Stripe API version as the app's client", () => {
    const client = readFileSync(path.join(ROOT, "src/server/billing/stripe-client.ts"), "utf8");
    expect(client).toContain(`const STRIPE_API_VERSION = "${setup.STRIPE_API_VERSION}";`);
  });

  it("creates exactly the two paid plans, at the canonical amounts, and no Free price", () => {
    expect(setup.PLANS.map((p: { plan: string }) => p.plan)).toEqual(["premium", "business"]);
    for (const spec of setup.PLANS as { plan: "premium" | "business"; unitAmount: number; envVar: string }[]) {
      expect(spec.unitAmount).toBe(PLAN_ENTITLEMENTS[spec.plan].priceMinorMonthly);
    }
    expect(setup.PLANS.map((p: { envVar: string }) => p.envVar)).toEqual(["STRIPE_PREMIUM_PRICE_ID", "STRIPE_BUSINESS_PRICE_ID"]);
  });

  it("uses the same four variable names the app reads", () => {
    const config = readFileSync(path.join(ROOT, "src/server/billing/stripe-config.ts"), "utf8");
    for (const name of setup.STRIPE_VARS as string[]) expect(config).toContain(name);
  });
});

describe("keys", () => {
  it("accepts only a secret TEST key", () => {
    expect(setup.refuseKey("sk_test_abc")).toBeNull();
    expect(setup.refuseKey("sk_live_abc")).toMatch(/LIVE/);
    expect(setup.refuseKey("rk_live_abc")).toMatch(/LIVE/);
    expect(setup.refuseKey("rk_test_abc")).toMatch(/not a secret test key/);
    expect(setup.refuseKey("")).toMatch(/not set/);
  });
});

describe("the portal is limited to what Countorra supports", () => {
  const features = setup.portalFeatures([
    { product: "prod_p", prices: ["price_p"] },
    { product: "prod_b", prices: ["price_b"] },
  ]);

  it("cancels at period end, with no proration", () => {
    expect(features.subscription_cancel).toMatchObject({ enabled: true, mode: "at_period_end", proration_behavior: "none" });
  });

  it("switches only between the two Countorra prices, billing an upgrade immediately", () => {
    expect(features.subscription_update).toMatchObject({ enabled: true, default_allowed_updates: ["price"], proration_behavior: "always_invoice" });
    expect(features.subscription_update.products).toEqual([
      { product: "prod_p", prices: ["price_p"] },
      { product: "prod_b", prices: ["price_b"] },
    ]);
  });

  it("lets customers fix a payment method and see invoices, and edit billing email/address only", () => {
    expect(features.payment_method_update.enabled).toBe(true);
    expect(features.invoice_history.enabled).toBe(true);
    expect(features.customer_update.allowed_updates).toEqual(["email", "address"]);
  });
});

describe(".env.local is only added to", () => {
  it("writes what is missing and keeps what is set, reporting names only", () => {
    const before = "NEXT_PUBLIC_APP_URL=http://localhost:3000\nSTRIPE_PREMIUM_PRICE_ID=price_existing\nSTRIPE_BUSINESS_PRICE_ID=\n";
    const change = setup.addMissingEnv(before, { STRIPE_PREMIUM_PRICE_ID: "price_new_p", STRIPE_BUSINESS_PRICE_ID: "price_new_b" });

    expect(change.written).toEqual(["STRIPE_BUSINESS_PRICE_ID"]);
    expect(change.kept).toEqual(["STRIPE_PREMIUM_PRICE_ID"]);
    expect(change.conflicts).toEqual(["STRIPE_PREMIUM_PRICE_ID"]);
    expect(setup.parseEnv(change.text)).toMatchObject({ STRIPE_PREMIUM_PRICE_ID: "price_existing", STRIPE_BUSINESS_PRICE_ID: "price_new_b", NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(change.text.match(/^STRIPE_BUSINESS_PRICE_ID=/gm)).toHaveLength(1);
    expect(JSON.stringify([change.written, change.kept, change.conflicts])).not.toMatch(/price_/);
  });

  it("changes nothing when everything is already set", () => {
    const before = "STRIPE_PREMIUM_PRICE_ID=a\nSTRIPE_BUSINESS_PRICE_ID=b\n";
    const change = setup.addMissingEnv(before, { STRIPE_PREMIUM_PRICE_ID: "a", STRIPE_BUSINESS_PRICE_ID: "b" });
    expect(change.text).toBe(before);
    expect(change.written).toEqual([]);
    expect(change.conflicts).toEqual([]);
  });
});

describe("running it", () => {
  it("with nothing configured: reports every item NO and makes no Stripe call", () => {
    const result = run("check", {});
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/TEST MODE key configured\s+NO/);
    expect(result.stdout).toMatch(/Webhook signing secret configured\s+NO/);
    expect(result.stdout).toMatch(/Countorra Premium TEST price configured\s+NO/);
    expect(result.stdout).toMatch(/Countorra Business TEST price configured\s+NO/);
    expect(result.stdout).toMatch(/Customer Portal configured \(default\)\s+NO/);
    expect(result.stdout).toContain("No Stripe API call was made.");
  });

  it("with a live key: stops before any call and never prints the key", () => {
    const fake = "sk_live_" + "x".repeat(24);
    const result = run("setup", { STRIPE_SECRET_KEY: fake, STRIPE_WEBHOOK_SECRET: "whsec_" + "y".repeat(24) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Stopped: live keys are never used.");
    expect(result.stdout + result.stderr).not.toContain(fake);
    expect(result.stdout + result.stderr).not.toContain("y".repeat(24));
  });

  it("rejects an unknown mode", () => {
    expect(run("delete-everything", {}).status).toBe(2);
  });
});
