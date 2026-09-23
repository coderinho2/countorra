import { expect, test } from "@playwright/test";

/**
 * The published legal and trust pages, as a visitor sees them.
 *
 * They must state what the product actually does — Plaid for bank data,
 * Stripe for payments — must not state what it no longer does or never did,
 * and must show every unknown business fact as a visible placeholder rather
 * than a blank or an invention.
 */

test("privacy states the real processors and how bank and card data are handled", async ({ page }) => {
  await page.goto("/privacy");
  const body = page.locator("main, body").first();

  for (const provider of ["Supabase", "Vercel", "Anthropic", "Plaid", "Stripe", "Resend"]) await expect(body).toContainText(provider);
  await expect(page.locator("#bank-connections")).toContainText("Countorra never receives or stores your bank username or password.");
  await expect(page.locator("#bank-connections")).toContainText("AES-256-GCM");
  await expect(page.locator("#bank-connections")).toContainText("last four digits");
  await expect(page.locator("#payments")).toContainText("Countorra never receives or stores your full card number or security code.");
  await expect(page.locator("#retention")).toContainText("Deleting your account is self-serve");
  await expect(page.locator("#retention")).toContainText("deleting your account cancels the paid subscription of every workspace being deleted");
  await expect(page.getByRole("link", { name: "Plaid's End User Privacy Policy" }).first()).toHaveAttribute("href", "https://plaid.com/legal/#end-user-privacy-policy");

  const text = await body.innerText();
  expect(text).not.toMatch(/do not currently use[^.]*a payment processor/i);
  expect(text).not.toMatch(/does not connect to your bank/i);
  expect(text).not.toMatch(/Self-serve account deletion is not yet built/i);
  // OCR now ships, so the policy must name the processor rather than deny it.
  expect(body).toContainText("Amazon Web Services");
  expect(text).not.toMatch(/do not currently use a document-extraction or OCR service/);
  // ...and state what is NOT kept from an identity document.
  await expect(page.locator("#identity-documents")).toContainText("no digits are kept at all");
  await expect(page.locator("#identity-documents")).toContainText("never used to change your records");
});

test("terms state the plans, recurring billing, Plaid, and the limits of the tax figures", async ({ page }) => {
  await page.goto("/terms");
  const body = page.locator("main, body").first();

  await expect(page.locator("#plans")).toContainText("$19 USD per month");
  await expect(page.locator("#plans")).toContainText("$49 USD per month");
  await expect(page.locator("#plans")).toContainText("Recurring billing.");
  await expect(page.locator("#plans")).toContainText("Deleting your account cancels your subscriptions.");
  await expect(page.locator("#plans")).toContainText("If that cannot be confirmed, nothing is deleted");
  await expect(page.locator("#bank-connections")).toContainText("Connect only accounts you are authorized to access.");
  await expect(page.locator("#tax")).toContainText("2026");
  await expect(page.locator("#tax")).toContainText("California, New York State, Arizona");
  await expect(page.locator("#tax")).toContainText("Countorra does not prepare or file tax returns, does not e-file");
  await expect(page.locator("#ai")).toContainText("not authoritative");

  const text = await body.innerText();
  expect(text).not.toMatch(/not yet purchasable/i);
  expect(text).not.toMatch(/does not currently connect to external bank accounts/i);
  expect(text).not.toMatch(/does not cancel a subscription/i);
});

test("security describes what is enforced and claims no certification", async ({ page }) => {
  await page.goto("/security");
  const body = page.locator("main, body").first();

  for (const heading of ["Bank connections", "Provider credentials and webhooks", "Background work", "Monitoring", "Deleting your account"]) {
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  await expect(body).toContainText("AES-256-GCM");
  await expect(body).toContainText("has not been audited or certified by a third party");

  const text = await body.innerText();
  expect(text).not.toMatch(/SOC 2 (certified|compliant|Type)|PCI (DSS )?(certified|compliant)|HIPAA|ISO 27001 certified/i);
});

test("unknown business facts are shown as placeholders, never left blank", async ({ page }) => {
  for (const path of ["/privacy", "/terms"]) {
    await page.goto(path);
    await expect(page.getByText("Not yet final.")).toBeVisible();
    const placeholders = page.locator("[data-legal-placeholder]");
    expect(await placeholders.count()).toBeGreaterThan(0);
    for (const text of await placeholders.allInnerTexts()) expect(text).toMatch(/— to be provided before launch\]$/);
  }
});
