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
      { product: "prod_p", prices: ["price_p"], adjustable_quantity: { enabled: false } },
      { product: "prod_b", prices: ["price_b"], adjustable_quantity: { enabled: false } },
    ]);
  });

  it("turns quantity changes and pausing off explicitly — Stripe enables quantity by default", () => {
    for (const product of features.subscription_update.products) expect(product.adjustable_quantity).toEqual({ enabled: false });
    expect(features.subscription_pause).toEqual({ enabled: false });
  });

  it("lets customers fix a payment method and see invoices, and edit billing email/address only", () => {
    expect(features.payment_method_update.enabled).toBe(true);
    expect(features.invoice_history.enabled).toBe(true);
    expect(features.customer_update.allowed_updates).toEqual(["email", "address"]);
  });
});

/**
 * Verifying a live configuration. The shape below is what Stripe returned for
 * this project's test-mode default portal under API version
 * 2026-08-26.dahlia — including the bug this guards: without an explicit
 * `expand`, `subscription_update.products` is ABSENT, and the old check read
 * that as "no products" and reported an already-correct portal as NO.
 */
describe("checking a portal configuration Stripe returned", () => {
  const expected = [
    { product: "prod_premium", prices: ["price_premium"] },
    { product: "prod_business", prices: ["price_business"] },
  ];
  const stripeShape = (overrides: { products?: unknown; [k: string]: unknown } = {}) => {
    const { products, ...rest } = overrides;
    const subscriptionUpdate: Record<string, unknown> = {
      billing_cycle_anchor: "unchanged",
      default_allowed_updates: ["price"],
      enabled: true,
      proration_behavior: "always_invoice",
      schedule_at_period_end: { conditions: [] },
      trial_update_behavior: "end_trial",
    };
    if (products !== "absent") {
      subscriptionUpdate.products = products ?? [
        { product: "prod_premium", prices: ["price_premium"], adjustable_quantity: { enabled: false, maximum: null, minimum: 1 } },
        { product: "prod_business", prices: ["price_business"], adjustable_quantity: { enabled: false, maximum: null, minimum: 1 } },
      ];
    }
    return {
      id: "bpc_test",
      is_default: true,
      active: true,
      livemode: false,
      metadata: { countorra: "customer-portal" },
      features: {
        customer_update: { allowed_updates: ["email", "address"], enabled: true },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true, payment_method_configuration: null },
        subscription_cancel: { cancellation_reason: { enabled: false, feedback_options: [], options: ["too_expensive"] }, enabled: true, mode: "at_period_end", proration_behavior: "none" },
        subscription_pause: { enabled: false },
        subscription_update: subscriptionUpdate,
      },
      ...rest,
    };
  };

  it("accepts a configuration that matches exactly", () => {
    expect(setup.portalProblems(stripeShape(), expected)).toEqual([]);
  });

  it("does not mistake an UNEXPANDED response for a portal without products", () => {
    // The original bug. It must say why it cannot tell, not claim a mismatch
    // in the settings themselves.
    expect(setup.portalProblems(stripeShape({ products: "absent" }), expected)).toEqual([
      "switching products were not returned (the response was not expanded)",
    ]);
    expect(setup.PORTAL_EXPAND).toEqual(["features.subscription_update.products"]);
  });

  it("flags quantity changes, which Stripe turns on by default", () => {
    const products = [
      { product: "prod_premium", prices: ["price_premium"], adjustable_quantity: { enabled: true } },
      { product: "prod_business", prices: ["price_business"], adjustable_quantity: { enabled: false } },
    ];
    expect(setup.portalProblems(stripeShape({ products }), expected)).toEqual(["customers can change quantity"]);
  });

  it("flags switching to any price that is not Countorra's, or a missing plan", () => {
    const extra = [
      { product: "prod_premium", prices: ["price_premium", "price_other"], adjustable_quantity: { enabled: false } },
      { product: "prod_business", prices: ["price_business"], adjustable_quantity: { enabled: false } },
    ];
    const missing = [{ product: "prod_premium", prices: ["price_premium"], adjustable_quantity: { enabled: false } }];
    for (const products of [extra, missing]) {
      expect(setup.portalProblems(stripeShape({ products }), expected)).toContain("switching is not limited to exactly the Countorra Premium and Business prices");
    }
  });

  it("flags each Countorra rule that is not met", () => {
    const base = stripeShape();
    const cases: [string, (c: ReturnType<typeof stripeShape>) => void][] = [
      ["cancellation is not at period end", (c) => (c.features.subscription_cancel.mode = "immediately")],
      ["cancellation prorates", (c) => (c.features.subscription_cancel.proration_behavior = "create_prorations")],
      ["pausing is on", (c) => (c.features.subscription_pause.enabled = true)],
      ["invoice history is off", (c) => (c.features.invoice_history.enabled = false)],
      ["payment method update is off", (c) => (c.features.payment_method_update.enabled = false)],
      ["billing information fields are not exactly email and address", (c) => (c.features.customer_update.allowed_updates = ["email", "address", "tax_id"])],
      ["switching allows more than price changes", (c) => ((c.features.subscription_update as Record<string, unknown>).default_allowed_updates = ["price", "quantity"])],
      ["switching does not bill immediately (always_invoice)", (c) => ((c.features.subscription_update as Record<string, unknown>).proration_behavior = "create_prorations")],
      ["is a LIVE configuration", (c) => (c.livemode = true)],
    ];
    for (const [message, mutate] of cases) {
      const config = structuredClone(base);
      mutate(config);
      expect(setup.portalProblems(config, expected), message).toEqual([message]);
    }
  });

  it("reports a missing default rather than inventing one", () => {
    expect(setup.portalProblems(null, expected)).toEqual(["no default configuration exists"]);
  });

  it("never names an id in a problem", () => {
    const wrong = stripeShape({ products: [{ product: "prod_x", prices: ["price_x"], adjustable_quantity: { enabled: true } }], livemode: true });
    for (const message of setup.portalProblems(wrong, expected)) expect(message).not.toMatch(/prod_|price_|bpc_/);
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
