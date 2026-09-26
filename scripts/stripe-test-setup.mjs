#!/usr/bin/env node
/**
 * Stripe TEST MODE setup and pre-flight for Countorra (Task 18.1).
 *
 *   node scripts/stripe-test-setup.mjs check   read-only pre-flight
 *   node scripts/stripe-test-setup.mjs setup   create/verify test prices and the portal
 *
 * TEST MODE ONLY. The key must start with `sk_test_`; a live key (`sk_live_`,
 * `rk_live_`) stops the script before any call is made.
 *
 * WHAT `setup` DOES, AND NOTHING ELSE
 *
 *   1. Finds — or creates — two test-mode Products with one recurring monthly
 *      USD price each, identified by lookup key:
 *        countorra_premium_monthly   $19.00  (PLAN_ENTITLEMENTS.premium)
 *        countorra_business_monthly  $49.00  (PLAN_ENTITLEMENTS.business)
 *      An existing price with the right lookup key but the wrong amount,
 *      currency or interval is REPORTED, never changed.
 *      No Free price: Free is a Countorra-only $0 entitlement.
 *   2. Writes STRIPE_PREMIUM_PRICE_ID / STRIPE_BUSINESS_PRICE_ID into
 *      .env.local only when they are absent. An existing value is kept; if it
 *      disagrees with Stripe, that is reported.
 *   3. Sets the test-mode DEFAULT Customer Portal configuration to exactly the
 *      features Countorra supports (see PORTAL_FEATURES). The default must
 *      exist first — Stripe creates it when "Save" is clicked once in
 *      Dashboard → Settings → Billing → Customer portal (test mode); the API
 *      cannot. Countorra's portal sessions pass no configuration id, so the
 *      default is the one customers see.
 *
 * The webhook signing secret is not created here: locally it comes from
 * `stripe listen` (see DEPLOYMENT.md §8), and no public endpoint exists.
 *
 * No secret, key or id is ever printed — only names and YES/NO.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Must equal STRIPE_API_VERSION in src/server/billing/stripe-client.ts
 *  (asserted by tests/config/stripe-test-setup.test.ts). */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

/**
 * `taxCode` is NOT decoration. Stripe's Managed Payments (enabled by default on
 * this account) makes Stripe the merchant of record, and it refuses a Checkout
 * line item whose product has no tax code:
 *
 *   Invalid line_items[0]: the product tax code is missing.
 *
 * So a product created without one cannot be bought — in test mode or in live
 * mode. These two codes are Stripe's own, and are the ones the LIVE products
 * carry, so test mode mirrors production rather than diverging from it:
 *
 *   txcd_10103000  Software as a service (SaaS) - personal use
 *   txcd_10103001  Software as a service (SaaS) - business use
 *
 * Countorra is personal-only at launch, hence personal use for Premium; the
 * Business tier is a Stripe tier for business use.
 */
export const PLANS = [
  { plan: "premium", envVar: "STRIPE_PREMIUM_PRICE_ID", lookupKey: "countorra_premium_monthly", productName: "Countorra Premium", unitAmount: 1_900, taxCode: "txcd_10103000" },
  { plan: "business", envVar: "STRIPE_BUSINESS_PRICE_ID", lookupKey: "countorra_business_monthly", productName: "Countorra Business", unitAmount: 4_900, taxCode: "txcd_10103001" },
];

export const STRIPE_VARS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PREMIUM_PRICE_ID", "STRIPE_BUSINESS_PRICE_ID"];

/**
 * What the portal may do — only what Countorra handles:
 *   - invoices: read-only history.
 *   - payment method: the fix for a failed payment (Settings says "update the
 *     payment method"; invoice.* webhooks restore access).
 *   - billing email/address: billing details only; Countorra stores neither.
 *   - cancel AT PERIOD END: the webhook records cancel_at_period_end and
 *     Settings shows "Ending"; no proration, no refund (refund policy is not
 *     decided — LEGAL_FACTS.refundPolicy).
 *   - switch between the two Countorra prices only. `always_invoice` bills an
 *     upgrade's difference immediately: with `create_prorations` the charge
 *     waits for the next invoice, which a cancel-at-period-end never produces,
 *     so an upgrade followed by cancellation would get Business for free.
 *   - NO quantity changes. Stripe turns `adjustable_quantity` ON for each
 *     product unless told otherwise, which let a customer buy "2 × Premium":
 *     double the price for nothing, because Countorra's entitlements are per
 *     workspace and ignore quantity. So every product states it off.
 *   - no pause (not a state Countorra models), no cancellation survey.
 */
export function portalFeatures(products) {
  return {
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    customer_update: { enabled: true, allowed_updates: ["email", "address"] },
    subscription_cancel: { enabled: true, mode: "at_period_end", proration_behavior: "none", cancellation_reason: { enabled: false, options: [] } },
    subscription_pause: { enabled: false },
    subscription_update: {
      enabled: true,
      default_allowed_updates: ["price"],
      proration_behavior: "always_invoice",
      products: products.map((p) => ({ product: p.product, prices: p.prices, adjustable_quantity: { enabled: false } })),
    },
  };
}

/**
 * Where `products` lives in a portal configuration response.
 *
 * In API version 2026-08-26.dahlia, `features.subscription_update.products`
 * is NOT part of a configuration response unless it is explicitly expanded —
 * the key is simply absent. Reading it unexpanded sees no products at all,
 * which is why an already-correct portal used to be reported as "NO". Every
 * read and write below passes this expansion.
 */
export const PORTAL_EXPAND = ["features.subscription_update.products"];

const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/**
 * Every way a portal configuration differs from Countorra's. Empty means it
 * matches exactly. Messages name the setting, never an id.
 *
 * `expected` is [{ product, prices: [priceId] }] for the two Countorra plans.
 */
export function portalProblems(portal, expected) {
  if (!portal) return ["no default configuration exists"];
  const problems = [];
  const f = portal.features ?? {};
  if (portal.livemode) problems.push("is a LIVE configuration");
  if (!portal.active) problems.push("is not active");
  if (!f.invoice_history?.enabled) problems.push("invoice history is off");
  if (!f.payment_method_update?.enabled) problems.push("payment method update is off");
  if (!f.customer_update?.enabled) problems.push("billing information update is off");
  else if (!sameSet(f.customer_update.allowed_updates ?? [], ["email", "address"])) problems.push("billing information fields are not exactly email and address");
  if (!f.subscription_cancel?.enabled) problems.push("cancellation is off");
  if (f.subscription_cancel?.mode !== "at_period_end") problems.push("cancellation is not at period end");
  if (f.subscription_cancel?.proration_behavior !== "none") problems.push("cancellation prorates");
  if (f.subscription_pause?.enabled) problems.push("pausing is on");
  const update = f.subscription_update;
  if (!update?.enabled) problems.push("plan switching is off");
  if (!sameSet(update?.default_allowed_updates ?? [], ["price"])) problems.push("switching allows more than price changes");
  if (update?.proration_behavior !== "always_invoice") problems.push("switching does not bill immediately (always_invoice)");
  const products = update?.products;
  if (!Array.isArray(products)) {
    problems.push("switching products were not returned (the response was not expanded)");
  } else {
    const actual = products.map((p) => `${p.product}:${[...(p.prices ?? [])].sort().join(",")}`);
    const wanted = expected.map((p) => `${p.product}:${[...p.prices].sort().join(",")}`);
    if (!sameSet(actual, wanted)) problems.push("switching is not limited to exactly the Countorra Premium and Business prices");
    if (products.some((p) => p.adjustable_quantity?.enabled)) problems.push("customers can change quantity");
  }
  return problems;
}

/** Test-mode keys only. Returns a reason when the key must not be used. */
export function refuseKey(key) {
  if (!key) return "STRIPE_SECRET_KEY is not set";
  if (/^(sk|rk)_live_/.test(key)) return "STRIPE_SECRET_KEY is a LIVE key; this script is test mode only";
  if (!key.startsWith("sk_test_")) return "STRIPE_SECRET_KEY is not a secret test key (sk_test_…)";
  return null;
}

export function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Adds `entries` to an env file's text without replacing anything already
 * set. Returns the new text and, per name, what happened — never the values.
 */
export function addMissingEnv(text, entries) {
  const existing = parseEnv(text);
  const result = { text, written: [], kept: [], conflicts: [] };
  const additions = [];
  for (const [name, value] of Object.entries(entries)) {
    if (existing[name]) {
      result.kept.push(name);
      if (existing[name] !== value) result.conflicts.push(name);
    } else {
      additions.push(`${name}=${value}`);
      result.written.push(name);
    }
  }
  if (additions.length > 0) {
    // An empty `NAME=` line would shadow nothing but confuse a reader: drop it.
    const cleaned = text
      .split(/\r?\n/)
      .filter((line) => !additions.some((a) => line.trim() === `${a.split("=")[0]}=`))
      .join("\n")
      .replace(/\n*$/, "\n");
    result.text = `${cleaned}\n# Stripe TEST MODE prices (scripts/stripe-test-setup.mjs)\n${additions.join("\n")}\n`;
  }
  return result;
}

function envFile() {
  return path.resolve(process.cwd(), ".env.local");
}

function loadEnv() {
  const file = envFile();
  const local = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const value = (name) => process.env[name] || local[name] || "";
  return { local, value };
}

const yes = (b) => (b ? "YES" : "NO");

async function findPrice(stripe, spec) {
  const found = await stripe.prices.list({ lookup_keys: [spec.lookupKey], expand: ["data.product"], limit: 1 });
  return found.data[0] ?? null;
}

function priceProblems(price, spec) {
  const problems = [];
  if (price.livemode) problems.push("is a LIVE price");
  if (!price.active) problems.push("is archived");
  if (price.currency !== "usd") problems.push("is not USD");
  if (price.unit_amount !== spec.unitAmount) problems.push(`is not ${spec.unitAmount / 100} USD`);
  if (price.type !== "recurring" || price.recurring?.interval !== "month" || price.recurring?.interval_count !== 1) problems.push("is not monthly recurring");
  if (price.recurring?.usage_type !== "licensed") problems.push("is not licensed usage");
  // Without a tax code Managed Payments refuses the line item, so the price
  // exists but cannot be bought. Reported as a problem with the price because
  // that is the thing the caller configured.
  const product = typeof price.product === "object" && price.product !== null ? price.product : null;
  if (product && !product.tax_code) problems.push("product has no tax_code (Managed Payments refuses it)");
  return problems;
}

/**
 * Gives an EXISTING product the tax code it should have had.
 *
 * The create path above sets it, but these products predate that and creation
 * never runs again once a price with the lookup key exists — so without this,
 * `setup` could not repair the account it is meant to set up. Narrow on
 * purpose: only ever fills a MISSING code, never replaces a different one a
 * human may have chosen deliberately.
 */
async function ensureProductTaxCode(stripe, price, spec) {
  const product = typeof price.product === "object" && price.product !== null ? price.product : null;
  if (!product || product.livemode) return null;
  if (product.tax_code) return null;
  await stripe.products.update(product.id, { tax_code: spec.taxCode });
  return product.id;
}

async function main(mode) {
  if (mode !== "check" && mode !== "setup") {
    console.log("Usage: node scripts/stripe-test-setup.mjs <check|setup>");
    process.exitCode = 2;
    return;
  }

  const { value } = loadEnv();
  const report = [];
  const line = (label, ok, note = "") => report.push(`${label.padEnd(42)} ${yes(ok)}${note ? `  — ${note}` : ""}`);

  const refused = refuseKey(value("STRIPE_SECRET_KEY"));
  line("TEST MODE key configured", !refused, refused ?? "");
  if (refused && /LIVE/.test(refused)) {
    console.log(report.join("\n"));
    console.log("\nStopped: live keys are never used.");
    process.exitCode = 1;
    return;
  }

  const appUrl = value("NEXT_PUBLIC_APP_URL") || "http://localhost:3000";
  let appUrlOk = false;
  try {
    const url = new URL(appUrl);
    appUrlOk = url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    appUrlOk = false;
  }
  line("App URL usable for return URLs", appUrlOk, appUrlOk ? "" : "NEXT_PUBLIC_APP_URL must be https, or localhost for local testing");

  const webhookSecret = value("STRIPE_WEBHOOK_SECRET");
  line("Webhook signing secret configured", webhookSecret.startsWith("whsec_"), webhookSecret ? (webhookSecret.startsWith("whsec_") ? "" : "not a whsec_ value") : "run `stripe listen --print-secret` (DEPLOYMENT.md §8)");

  if (refused) {
    for (const spec of PLANS) line(`${spec.productName} TEST price configured`, false, "needs the test key");
    line("Customer Portal configured (default)", false, "needs the test key");
    console.log(report.join("\n"));
    console.log("\nNo Stripe API call was made.");
    process.exitCode = 1;
    return;
  }

  const { default: Stripe } = await import("stripe");
  const stripe = new Stripe(value("STRIPE_SECRET_KEY"), { apiVersion: STRIPE_API_VERSION, timeout: 15_000, maxNetworkRetries: 1, appInfo: { name: "Countorra test-mode setup" } });

  // Belt and braces: ask Stripe which mode this key is in.
  const probe = await stripe.prices.list({ limit: 1 });
  if (probe.data[0]?.livemode) {
    console.log("Stopped: Stripe reports live mode for this key.");
    process.exitCode = 1;
    return;
  }

  const priceIds = {};
  const portalProducts = [];
  let pricesOk = true;
  for (const spec of PLANS) {
    let price = await findPrice(stripe, spec);
    if (!price && mode === "setup") {
      const product = await stripe.products.create({ name: spec.productName, tax_code: spec.taxCode, metadata: { countorra_plan: spec.plan } });
      price = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: spec.unitAmount,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        lookup_key: spec.lookupKey,
        metadata: { countorra_plan: spec.plan },
      });
      price = await findPrice(stripe, spec);
    }
    if (price && mode === "setup") {
      const repaired = await ensureProductTaxCode(stripe, price, spec);
      if (repaired) {
        report.push(`  ${spec.productName}: set tax_code ${spec.taxCode} on existing product ${repaired}`);
        price = await findPrice(stripe, spec);
      }
    }
    const problems = price ? priceProblems(price, spec) : ["does not exist (run `setup`)"];
    const configured = value(spec.envVar);
    const matchesEnv = Boolean(price && configured && configured === price.id);
    if (price && problems.length === 0) {
      priceIds[spec.envVar] = price.id;
      portalProducts.push({ product: typeof price.product === "string" ? price.product : price.product.id, prices: [price.id] });
    }
    const ok = problems.length === 0 && (matchesEnv || mode === "setup");
    pricesOk &&= ok;
    const note = problems.length ? `price ${problems.join(", ")}` : !configured ? `${spec.envVar} not in .env.local yet` : matchesEnv ? "" : `${spec.envVar} does not match the ${spec.lookupKey} price`;
    line(`${spec.productName} TEST price configured`, ok && (matchesEnv || !configured), note);
  }

  if (mode === "setup" && Object.keys(priceIds).length === PLANS.length) {
    const file = envFile();
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    const change = addMissingEnv(before, priceIds);
    if (change.written.length) writeFileSync(file, change.text, "utf8");
    report.push(`  .env.local: written ${change.written.join(", ") || "nothing"}; kept ${change.kept.join(", ") || "nothing"}${change.conflicts.length ? `; DISAGREES WITH STRIPE: ${change.conflicts.join(", ")} (not replaced)` : ""}`);
  }

  // The DEFAULT configuration is the one Countorra's portal sessions use (they
  // pass no configuration id). Stripe's API cannot create a default — only
  // the Dashboard's "Save" does — so setup updates it in place and never
  // creates a second, non-default configuration nobody would see.
  const defaults = await stripe.billingPortal.configurations.list({ is_default: true, limit: 1, expand: PORTAL_EXPAND.map((f) => `data.${f}`) });
  let portal = defaults.data[0] ?? null;
  let portalAction = "";
  let problems = portalProducts.length === PLANS.length ? portalProblems(portal, portalProducts) : ["the Countorra prices are not both valid, so the portal cannot be checked"];
  if (portal && mode === "setup" && portalProducts.length === PLANS.length) {
    if (problems.length > 0) {
      portal = await stripe.billingPortal.configurations.update(portal.id, {
        features: portalFeatures(portalProducts),
        metadata: { countorra: "customer-portal" },
        expand: PORTAL_EXPAND,
      });
      problems = portalProblems(portal, portalProducts);
      portalAction = problems.length === 0 ? "updated to Countorra's settings" : "updated, but Stripe did not accept every setting";
    } else {
      portalAction = "already matched; nothing changed";
    }
  }
  const portalOk = Boolean(portal) && problems.length === 0;
  line(
    "Customer Portal configured (default)",
    portalOk,
    !portal
      ? "no default yet: open Dashboard (TEST mode) → Settings → Billing → Customer portal → Save, then run `setup`"
      : portalOk
        ? portalAction
        : `${problems.join("; ")}${mode === "check" ? " — run `setup`" : ""}`,
  );

  const cli = process.env.PATH?.split(path.delimiter).some((dir) => existsSync(path.join(dir, process.platform === "win32" ? "stripe.exe" : "stripe"))) ?? false;
  line("Webhook delivery path (Stripe CLI) available", cli, cli ? "`stripe listen --forward-to localhost:3000/api/stripe/webhook`" : "install the Stripe CLI, or use a deployed https test endpoint");

  console.log(report.join("\n"));
  const ready = !refused && pricesOk && portalOk && webhookSecret.startsWith("whsec_") && appUrlOk;
  console.log(`\nReady for \`npx vitest run tests/stripe-test-mode\`: ${yes(ready)}`);
  if (!ready) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv[2]).catch((error) => {
    // The type and code only: Stripe's messages quote ids.
    console.log(`Stripe call failed: ${error?.type ?? error?.name ?? "Error"}${error?.code ? ` (${error.code})` : ""}`);
    process.exitCode = 1;
  });
}
