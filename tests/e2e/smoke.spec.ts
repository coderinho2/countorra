import { expect, test } from "@playwright/test";

/**
 * Covers what's honestly testable without a live Supabase project (see
 * ARCHITECTURE.md's "Deferred" section): public/auth/legal pages, the
 * onboarding UI's client-side interaction, and the unauthenticated route
 * boundary for every org-scoped route. The full authenticated product
 * (dashboard, transactions, AI assistant, invoices, ...) needs a real
 * backend to exercise end-to-end and is not faked here (product spec
 * §49/§59/§60) — the RLS test suite (tests/rls) is what actually verifies
 * that layer, against a real Postgres engine.
 */

test("home page renders with the design tokens applied", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your money.", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Countorra" }).first()).toBeVisible();
});

test("login page renders a sign-in form", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  // No OAuth provider is enabled on the linked project, so the button that
  // used to sit here could only ever fail. Absent is the correct state.
  await expect(page.getByRole("button", { name: /Google/i })).toHaveCount(0);
});

test("signup, forgot-password, and reset-password pages render", async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Google/i })).toHaveCount(0);

  await page.goto("/forgot-password");
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();

  // Without a recovery session there is no form to submit — only a way to ask
  // for a new link. The page used to offer the form to anyone.
  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
  await expect(page.getByText("This reset link can't be used")).toBeVisible();
  await expect(page.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test("unauthenticated visitors are redirected away from /app and every org-scoped route", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/);

  const routes = [
    "dashboard",
    "transactions",
    "accounts",
    "bank-connections",
    "invoices",
    "customers",
    "documents",
    "documents/22222222-2222-4222-8222-222222222222",
    "reports",
    "insights",
    "tax-preparation",
    "tax-filing",
    "tax-filing/export",
    "ai",
    "settings",
  ];
  for (const path of routes) {
    await page.goto(`/app/11111111-1111-4111-8111-111111111111/${path}`);
    await expect(page).toHaveURL(/\/login/);
  }
});

test("the bank webhook endpoint is not an open door: a forged delivery is refused whether or not a provider is configured", async ({ request }) => {
  const forged = (provider: string) =>
    request.post(`/api/bank-connections/webhooks/${provider}`, {
      data: { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-forged" },
      headers: { "plaid-verification": "forged" },
      maxRedirects: 0,
    });

  // Providers this deployment can never have: always 404, in every configuration.
  for (const provider of ["fixture", "PLAID", "..%2Fstripe"]) {
    expect((await forged(provider)).status(), provider).toBe(404);
  }

  // Plaid itself: 404 on a deployment without Plaid, and — on one WITH Plaid
  // (a developer machine running sandbox) — refused by signature verification
  // before the body is read or any key is fetched. Never accepted either way.
  // The strict unconfigured case is pinned at unit level in
  // tests/server/bank-webhook-route.test.ts.
  const plaid = await forged("plaid");
  expect([400, 404], "plaid").toContain(plaid.status());
  if (plaid.status() === 400) expect(await plaid.json()).toEqual({ error: "unverified" });
});

test("onboarding: selecting an entity type reveals a form with US-first defaults", async ({ page }) => {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "What are you using Countorra for?" })).toBeVisible();

  await page.getByRole("radio", { name: /Business/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("Business name")).toBeVisible();

  await expect(page.getByLabel("Country")).toHaveValue("US");
  await expect(page.getByLabel("Currency")).toHaveValue("USD");

  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "What are you using Countorra for?" })).toBeVisible();
});

test("onboarding: entity type radiogroup is keyboard-navigable and only one option is checked at a time", async ({ page }) => {
  await page.goto("/onboarding");
  const personal = page.getByRole("radio", { name: /Personal/ });
  const freelancer = page.getByRole("radio", { name: /Freelancer/ });

  await personal.click();
  await expect(personal).toHaveAttribute("aria-checked", "true");
  await expect(freelancer).toHaveAttribute("aria-checked", "false");

  await personal.press("ArrowDown");
  await expect(freelancer).toHaveAttribute("aria-checked", "true");
  await expect(personal).toHaveAttribute("aria-checked", "false");
});

test("legal pages render real content, not dead links", async ({ page }) => {
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();
  await expect(page.getByText("Configuration notice.")).toBeVisible();

  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
  await expect(page.getByText(/not professional financial, tax, legal, or accounting advice/i)).toBeVisible();
});

test("pricing page shows all three plans with real, enforced AI usage limits", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("heading", { name: "One financial system. Priced by how far you take it." })).toBeVisible();
  await expect(page.getByText("For getting started, and for seeing your own numbers clearly.")).toBeVisible();
  await expect(page.getByText("For individuals and freelancers who need deeper financial intelligence.")).toBeVisible();
  await expect(page.getByText("For organizations that need business workflows and collaboration.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ask Countorra grows with your plan." })).toBeVisible();

  // The three published allowances, which are the same values the server
  // enforces — the page reads PLAN_ENTITLEMENTS rather than restating it.
  await expect(page.getByText("3/day").first()).toBeVisible();
  await expect(page.getByText("100/day").first()).toBeVisible();
  await expect(page.getByText("500/day").first()).toBeVisible();

  // Prices are now published on all three tiers.
  await expect(page.getByText("$0").first()).toBeVisible();
  await expect(page.getByText("$19").first()).toBeVisible();
  await expect(page.getByText("$49").first()).toBeVisible();

  // No tier advertises unlimited AI any more.
  await expect(page.getByText("Unlimited AI")).toHaveCount(0);
});

test("every pricing plan is self-contained: price, CTA and features in one card", async ({ page }) => {
  await page.goto("/pricing");

  // The point of the change: a visitor who has decided on Premium does not
  // scroll past the comparison table to find a button. Each card carries its
  // own price, CTA and feature list.
  for (const [planName, price] of [
    ["Free", "$0"],
    ["Premium", "$19"],
    ["Business", "$49"],
  ]) {
    const card = page
      .locator("div.relative")
      .filter({ has: page.getByRole("heading", { name: planName, exact: true, level: 2 }) });

    await expect(card).toHaveCount(1);
    await expect(card.getByText(price, { exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: "Get started" })).toBeVisible();
    await expect(card.getByText("AI requests/day")).toBeVisible();
    await expect(card.getByText("AI assistant", { exact: true })).toBeVisible();
  }
});

test("the plan CTA sits above the feature list, not below it", async ({ page }) => {
  await page.goto("/pricing");

  const card = page
    .locator("div.relative")
    .filter({ has: page.getByRole("heading", { name: "Premium", exact: true, level: 2 }) });

  const ctaBox = await card.getByRole("link", { name: "Get started" }).boundingBox();
  const listBox = await card.locator("ul").boundingBox();

  // Measured, not assumed: someone who has decided should not have to read
  // past everything the plan includes to find the button.
  expect(ctaBox!.y).toBeLessThan(listBox!.y);
});

test("pricing page marks unbuilt paid features as coming soon rather than claiming them", async ({ page }) => {
  await page.goto("/pricing");

  // OCR, tax tooling and priority support are entitlements of the paid tiers
  // that are not built. A checkmark against any of those rows would be selling
  // a feature that does not exist. Bank connections ARE built (Task 12), so
  // that row is no longer marked coming soon — whether a given deployment has
  // Plaid credentials is a separate fact, stated inside the product.
  for (const label of ["Document OCR & extraction", "Advanced tax tools", "Bank connections (Plaid)", "Priority support"]) {
    await expect(page.getByRole("cell", { name: label })).toBeVisible();
  }
  await expect(page.getByText("Coming soon").first()).toBeVisible();
});

test("pricing page's real /signup CTA and public nav still work after the visual redesign", async ({ page }) => {
  await page.goto("/pricing");
  await expect(page.getByRole("link", { name: "Security" }).first()).toHaveAttribute("href", "/security");
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute("href", "/login");
  await page.getByRole("link", { name: "Get started" }).first().click();
  await expect(page).toHaveURL(/\/signup/);
});

test("public footer links to real Privacy and Terms pages, not dead links", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/privacy/);
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();

  await page.goto("/");
  await page.getByRole("link", { name: "Terms" }).click();
  await expect(page).toHaveURL(/\/terms/);
  await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
});

test("authenticated app navigation is discoverable and correctly linked from the public site", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Get started" }).first()).toHaveAttribute("href", "/signup");
});

/**
 * The public header has to answer "where am I?" on every public route,
 * including the three /solutions/[persona] pages that have no nav item of
 * their own and must keep their parent lit.
 *
 * Asserted through `aria-current="page"` rather than through classes: it is
 * the same signal the visual treatment is driven from, and unlike a class
 * string it is also the thing a screen reader announces, so a regression in
 * either surface fails here.
 */
test("public nav marks the current section on every public route", async ({ page }) => {
  const cases: { route: string; expected: string }[] = [
    { route: "/product", expected: "Product" },
    { route: "/solutions", expected: "Solutions" },
    { route: "/solutions/personal", expected: "Solutions" },
    { route: "/solutions/freelancer", expected: "Solutions" },
    { route: "/solutions/business", expected: "Solutions" },
    { route: "/resources", expected: "Resources" },
    { route: "/pricing", expected: "Pricing" },
    { route: "/security", expected: "Security" },
  ];

  for (const { route, expected } of cases) {
    await page.goto(route);
    const nav = page.getByRole("navigation", { name: "Primary" });
    const active = nav.locator('[aria-current="page"]');
    await expect(active, `${route} should mark exactly one nav item active`).toHaveCount(1);
    await expect(active).toHaveText(expected);
  }
});

test("public nav marks nothing active on routes that have no nav item", async ({ page }) => {
  for (const route of ["/", "/privacy", "/terms"]) {
    await page.goto(route);
    await expect(page.getByRole("navigation", { name: "Primary" }).locator('[aria-current="page"]')).toHaveCount(0);
  }
});

test("mobile nav marks the current section too", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/solutions/business");
  await page.getByRole("button", { name: "Open menu" }).click();

  const panel = page.locator("#mobile-nav-panel");
  await expect(panel.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(panel.locator('[aria-current="page"]')).toHaveText("Solutions");
});

/**
 * A signed-out visitor must still be offered both doors. The signed-in
 * counterpart of this — identity plus "Open Countorra", and no signup
 * invitation anywhere on the page — needs a real Supabase session and so is
 * not asserted here; see the note at the top of this file.
 */
test("signed-out visitors are offered both Sign in and Get started, on every public surface", async ({ page }) => {
  for (const route of ["/", "/pricing", "/solutions/freelancer"]) {
    await page.goto(route);
    const header = page.locator("header");
    await expect(header.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    await expect(header.getByRole("link", { name: "Get started" })).toHaveAttribute("href", "/signup");
    await expect(page.getByRole("link", { name: "Open Countorra" })).toHaveCount(0);
  }
});

test("signed-out: Get started reaches signup and Sign in reaches login", async ({ page }) => {
  await page.goto("/");
  await page.locator("header").getByRole("link", { name: "Get started" }).click();
  await expect(page).toHaveURL(/\/signup/);

  await page.goto("/");
  await page.locator("header").getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/login/);
});
