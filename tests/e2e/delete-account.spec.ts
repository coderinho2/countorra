import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

/**
 * Settings → Delete account, in a real browser, against the REAL dialog with
 * the production stylesheet.
 *
 * WHY A HARNESS: the dialog lives on an authenticated page and this suite has
 * no signed-in session (smoke.spec.ts asserts /app routes redirect to /login;
 * the route-level check is repeated below). The dialog's behaviour does not
 * depend on who is signed in, so it is bundled on its own with its Server
 * Action replaced by a recorder. The action itself is tested for real in
 * tests/server/account-deletion.test.ts.
 */

const ROOT = path.resolve(__dirname, "../..");
const HARNESS = "http://delete-account.harness.test/";
const SAFE_ERROR = "We couldn't confirm with our payment provider that your subscription is canceled, so nothing was deleted. Please try again in a few minutes.";
let bundle = "";
let css = "";

function collectCss(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((file) => file.endsWith(".css")).map((file) => readFileSync(path.join(dir, file), "utf8"));
}

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    root: ROOT,
    logLevel: "silent",
    mode: "development",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    resolve: {
      alias: [
        { find: "@/server/account/actions", replacement: path.resolve(__dirname, "harness/account-actions-stub.ts") },
        { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
      ],
    },
    oxc: { jsx: { runtime: "automatic" } },
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      rolldownOptions: { input: path.resolve(__dirname, "harness/delete-account-entry.tsx"), output: { format: "iife" } },
    },
  });
  const results = Array.isArray(output) ? output : [output];
  const chunk = results.flatMap((result) => ("output" in result ? result.output : [])).find((file) => file.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("The delete-account harness did not build.");
  bundle = chunk.code;
  css = collectCss(path.resolve(ROOT, ".next/static")).join("\n");
});

async function open(page: Page) {
  await page.route(`${HARNESS}**`, (route) => {
    const url = route.request().url();
    if (url.includes("/harness.js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle });
    if (url.includes("/app.css")) return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-paper text-text-primary"><div id="root"></div><script src="/harness.js"></script></body></html>',
    });
  });
  await page.goto(HARNESS);
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByRole("dialog", { name: "Delete your account?" })).toBeVisible();
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Delete your account?" });
const confirmButton = (page: Page) => dialog(page).getByRole("button", { name: /^Delete account$|^Deleting account/ });
const submissions = (page: Page) => page.evaluate(() => window.__deleteSubmissions);

test("the settings route itself requires a session", async ({ page }) => {
  await page.goto("/app/11111111-1111-4111-8111-111111111111/settings#delete-account");
  await expect(page).toHaveURL(/\/login/);
});

test("explains what deletion does before asking for anything", async ({ page }) => {
  await open(page);
  const d = dialog(page);
  await expect(d).toContainText("This is permanent and cannot be undone.");
  await expect(d).toContainText("Every workspace you are the only member of is deleted");
  await expect(d).toContainText("Any paid subscription on those workspaces is canceled first. If the cancellation cannot be confirmed, nothing is deleted.");
  await expect(d).toContainText("You are removed from workspaces you share.");
  await expect(d.getByLabel("Your password")).toHaveAttribute("type", "password");
});

test("stays disabled until the password is given and DELETE is typed exactly", async ({ page }) => {
  await open(page);
  const d = dialog(page);
  await expect(confirmButton(page)).toBeDisabled();

  await d.getByLabel("Your password").fill("correct horse battery staple");
  await expect(confirmButton(page)).toBeDisabled();

  for (const almost of ["delete", "DELET", "DELETE ", " DELETE", "Delete"]) {
    await d.getByLabel(/to confirm/).fill(almost);
    await expect(confirmButton(page)).toBeDisabled();
  }

  await d.getByLabel(/to confirm/).fill("DELETE");
  await expect(confirmButton(page)).toBeEnabled();

  await d.getByLabel("Your password").fill("");
  await expect(confirmButton(page)).toBeDisabled();
});

test("cannot be submitted around the gate, even by forcing the form", async ({ page }) => {
  await open(page);
  const d = dialog(page);
  await d.getByLabel("Your password").fill("correct horse battery staple");
  await d.getByLabel(/to confirm/).fill("delete");

  await d.getByLabel(/to confirm/).press("Enter");
  await page.evaluate(() => document.querySelector("form")?.requestSubmit());

  expect(await submissions(page)).toEqual([]);
});

test("sends only the password and the confirmation: no ids of any kind", async ({ page }) => {
  await open(page);
  const d = dialog(page);
  await d.getByLabel("Your password").fill("correct horse battery staple");
  await d.getByLabel(/to confirm/).fill("DELETE");
  await confirmButton(page).click();

  await expect.poll(() => submissions(page)).toHaveLength(1);
  const [sent] = await submissions(page);
  expect(Object.keys(sent).sort()).toEqual(["confirmation", "password"]);
  expect(sent.confirmation).toBe("DELETE");
  expect(JSON.stringify(sent)).not.toMatch(/org|cus_|sub_|price_|[0-9a-f]{8}-[0-9a-f]{4}-/i);
});

test("shows pending, locks the form, and submits exactly once on a double click", async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.__deleteDelay = 800;
    window.__deleteResult = { error: "We couldn't finish deleting your account. Nothing further was removed — please contact support." };
  });
  const d = dialog(page);
  await d.getByLabel("Your password").fill("correct horse battery staple");
  await d.getByLabel(/to confirm/).fill("DELETE");

  await confirmButton(page).dblclick();

  await expect(d.getByRole("button", { name: "Deleting account…" })).toBeDisabled();
  await expect(d.getByLabel("Your password")).toBeDisabled();
  await expect(d.getByLabel(/to confirm/)).toBeDisabled();
  await expect(d.getByRole("button", { name: "Cancel" })).toBeDisabled();

  // Escape must not hide an action that is still running.
  await page.keyboard.press("Escape");
  await expect(d).toBeVisible();

  await expect(d.getByRole("alert")).toBeVisible();
  expect(await submissions(page)).toHaveLength(1);
});

test("shows the server's fixed message on failure and never claims success", async ({ page }) => {
  await open(page);
  await page.evaluate((message) => {
    window.__deleteResult = { error: message };
  }, SAFE_ERROR);
  const d = dialog(page);
  await d.getByLabel("Your password").fill("correct horse battery staple");
  await d.getByLabel(/to confirm/).fill("DELETE");
  await confirmButton(page).click();

  await expect(d.getByRole("alert")).toHaveText(SAFE_ERROR);
  await expect(d).toBeVisible();
  await expect(d).not.toContainText(/deleted successfully|account has been deleted/i);
  // Still usable: the person can try again.
  await expect(confirmButton(page)).toBeEnabled();
});

test("a retry after a failure submits again, and reopening starts clean", async ({ page }) => {
  await open(page);
  await page.evaluate((message) => {
    window.__deleteResult = { error: message };
  }, SAFE_ERROR);
  const d = dialog(page);
  await d.getByLabel("Your password").fill("correct horse battery staple");
  await d.getByLabel(/to confirm/).fill("DELETE");
  await confirmButton(page).click();
  await expect(d.getByRole("alert")).toBeVisible();

  await confirmButton(page).click();
  await expect.poll(() => submissions(page)).toHaveLength(2);

  await d.getByRole("button", { name: "Cancel" }).click();
  await expect(d).toBeHidden();
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(dialog(page).getByLabel("Your password")).toHaveValue("");
  await expect(dialog(page).getByLabel(/to confirm/)).toHaveValue("");
  await expect(dialog(page).getByRole("alert")).toHaveCount(0);
});
