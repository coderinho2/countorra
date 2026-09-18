import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

/**
 * The Bank connections page in a real browser, against the REAL view and its
 * real client forms, with the production stylesheet.
 *
 * WHY A HARNESS: the page needs a signed-in member, and this suite has no
 * authenticated session (see smoke.spec.ts, which asserts the route redirects
 * visitors to /login). The view's rendering does not depend on who is signed
 * in, so it is bundled on its own with synthetic workspace states and its
 * Server Actions replaced by recorders. Nothing is faked on the server: what
 * the actions do is tested in tests/server/bank-connection-actions.test.ts and
 * against real Postgres in tests/rls/bank-*.test.ts.
 *
 * Every state here has NO provider configured, matching this deployment.
 */

const ROOT = path.resolve(__dirname, "../..");
const HARNESS = "http://bank-connections.harness.test/";
const ORG = "11111111-1111-4111-8111-111111111111";
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
        { find: "@/server/bank-connections/actions", replacement: path.resolve(__dirname, "harness/bank-actions-stub.ts") },
        { find: /^next\/link$/, replacement: path.resolve(__dirname, "harness/next-link-stub.tsx") },
        { find: /^next\/navigation$/, replacement: path.resolve(__dirname, "harness/next-navigation-stub.ts") },
        { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
      ],
    },
    oxc: { jsx: { runtime: "automatic" } },
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      rolldownOptions: { input: path.resolve(__dirname, "harness/bank-connections-entry.tsx"), output: { format: "iife" } },
    },
  });
  const results = Array.isArray(output) ? output : [output];
  const chunk = results.flatMap((result) => ("output" in result ? result.output : [])).find((file) => file.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("The bank connections harness did not build.");
  bundle = chunk.code;
  // The production stylesheet from the build the web server just ran.
  css = collectCss(path.resolve(ROOT, ".next/static")).join("\n");
});

async function open(page: Page, query: string) {
  await page.route(`${HARNESS}**`, (route) => {
    const url = route.request().url();
    // UTF-8 declared explicitly: without it the bundle's "••••" and "—" are
    // decoded as Latin-1 — a harness artefact the real app (which serves UTF-8)
    // does not have.
    if (url.includes("/harness.js")) return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: bundle });
    if (url.includes("/app.css")) return route.fulfill({ contentType: "text/css; charset=utf-8", body: css });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body class="bg-paper text-text-primary"><div id="root"></div><script src="/harness.js"></script></body></html>',
    });
  });
  await page.goto(`${HARNESS}?${query}`);
  await expect(page.getByRole("heading", { name: "Bank connections", level: 1 })).toBeVisible();
}

const submissions = (page: Page) => page.evaluate(() => window.__bankSubmissions);

test("with no provider: an honest unavailable state, no connect button, and hand-kept accounts shown separately", async ({ page }) => {
  await open(page, "state=empty&role=owner");

  await expect(page.getByRole("heading", { name: "Automatic bank imports aren't available" })).toBeVisible();
  await expect(page.getByText("No bank connection provider is configured for this deployment")).toBeVisible();
  await expect(page.getByRole("heading", { name: "No bank connected" })).toBeVisible();
  await expect(page.getByRole("button", { name: /connect/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /import now/i })).toHaveCount(0);
  // No invented institutions, providers or "connected" claims.
  await expect(page.getByText(/Plaid|Chase|Bank of America|Wells Fargo/)).toHaveCount(0);
  await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);

  const manual = page.getByRole("region", { name: "Accounts you record by hand" });
  await expect(manual).toBeVisible();
  await expect(manual.getByText("Checking")).toBeVisible();
  await expect(manual.getByText("By hand", { exact: true })).toHaveCount(3);
  await expect(page.getByRole("link", { name: "Open accounts" })).toHaveAttribute("href", `/app/${ORG}/accounts`);
  await expect(page.getByRole("link", { name: "Manage accounts" })).toHaveAttribute("href", `/app/${ORG}/accounts`);
});

test("a configured provider the plan does not include says so, and offers no connect button", async ({ page }) => {
  await open(page, "state=plan&role=owner");

  await expect(page.getByRole("heading", { name: "Bank connections are part of Premium and Business" })).toBeVisible();
  // Stated in the notice and again in the empty state.
  await expect(page.getByText("This workspace is on the Free plan").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "See plans in Settings" })).toHaveAttribute("href", `/app/${ORG}/settings`);
  await expect(page.getByRole("button", { name: "Connect a bank" })).toHaveCount(0);
  // And it does not pretend the provider is missing, which is a different fact.
  await expect(page.getByText("No bank connection provider is configured")).toHaveCount(0);
});

test("configured, entitled and pointed at a sandbox: connect is offered, and the fictional data is called fictional", async ({ page }) => {
  await open(page, "state=ready&role=owner");

  await expect(page.getByRole("heading", { name: "Bank connections use Plaid" })).toBeVisible();
  await expect(page.getByText(/sandbox\. Anything imported here is fictional test data/)).toBeVisible();
  // One in the header, one in the empty state.
  await expect(page.getByRole("button", { name: "Connect a bank" })).toHaveCount(2);

  // Clicking posts nothing but the organization — no provider, no institution,
  // no account — and an answer without a token is reported honestly.
  await page.evaluate(() => void (window.__bankNextResult = { error: "Plaid is not reachable from the harness." }));
  await page.getByRole("button", { name: "Connect a bank" }).first().click();
  await expect.poll(() => submissions(page)).toHaveLength(1);
  expect((await submissions(page))[0]).toEqual({ action: "startBankLink", fields: { organizationId: ORG } });
  await expect(page.getByText("Plaid is not reachable from the harness.")).toBeVisible();
});

test("a viewer on a ready workspace still gets no controls", async ({ page }) => {
  await open(page, "state=ready&role=viewer");
  await expect(page.getByRole("heading", { name: "Bank connections use Plaid" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect a bank" })).toHaveCount(0);
});

test("existing history stays readable and truthful, and nothing offers an import without a provider", async ({ page }) => {
  await open(page, "state=history&role=owner");

  const live = page.getByRole("region", { name: /Synthetic Credit Union/ });
  await expect(live.getByText("Needs sign-in", { exact: true })).toBeVisible();
  await expect(live.getByText("•••• 3333")).toBeVisible();
  await expect(live.getByText("1 pending at bank")).toBeVisible();
  const former = page.getByRole("region", { name: /Former Savings Bank/ });
  await expect(former.getByText("Disconnected", { exact: true }).first()).toBeVisible();

  // A connection waiting for the bank's sign-in cannot import, so no refresh is
  // offered — the repair is, exactly where the problem is stated.
  await expect(page.getByRole("button", { name: "Import now" })).toHaveCount(0);
  await expect(live.getByRole("button", { name: "Sign in again" })).toHaveCount(1);
  await expect(live.getByText("Sandbox — test data")).toBeVisible();
  // Only the live connection can be disconnected.
  await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(1);
  await expect(former.getByRole("button")).toHaveCount(0);

  const review = page.getByRole("region", { name: "Needs review" });
  await expect(review.getByText("More than one transaction you entered could be this one")).toBeVisible();
  await expect(review.getByText("The bank changed this transaction after you edited it. Your edit was kept.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Accounts you record by hand" }).getByText("Fed by a bank")).toHaveCount(1);
});

test("a viewer sees status, and no control that would change anything", async ({ page }) => {
  await open(page, "state=history&role=viewer");
  await expect(page.getByText("Needs sign-in", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Import as a new transaction|Keep my books/ })).toHaveCount(0);
});

test("disconnecting asks first, then posts only ids and the confirmation", async ({ page }) => {
  await open(page, "state=history&role=owner");
  await page.getByRole("button", { name: "Disconnect" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Transactions already imported stay in your books")).toBeVisible();
  expect(await submissions(page)).toEqual([]);

  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect.poll(() => submissions(page)).toHaveLength(1);
  expect((await submissions(page))[0]).toEqual({
    action: "disconnect",
    fields: { organizationId: ORG, connectionId: "c1111111-1111-4111-8111-111111111111", confirm: "disconnect" },
  });
});

test("linking a bank account posts the chosen account, or 'don't import' — and only same-currency accounts are offered", async ({ page }) => {
  await open(page, "state=history&role=owner");
  await page.getByRole("combobox", { name: "Account fed by High-Yield Savings" }).click();
  const options = await page.getByRole("option").allTextContents();
  // Checking is already fed by a bank; the EUR account is another currency.
  expect(options).toEqual(["Savings", "Don't import"]);
  await page.getByRole("option", { name: "Don't import" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => submissions(page)).toHaveLength(1);
  expect((await submissions(page))[0]).toEqual({ action: "link", fields: { organizationId: ORG, linkedAccountId: "l2222222-2222-4222-8222-222222222222", target: "ignore" } });
});

test("a review decision posts one resolution for one transaction", async ({ page }) => {
  await open(page, "state=history&role=owner");
  await page.getByRole("button", { name: "Import as a new transaction" }).click();
  await expect.poll(() => submissions(page)).toHaveLength(1);
  expect((await submissions(page))[0]).toEqual({ action: "resolve", fields: { organizationId: ORG, externalId: "e1111111-1111-4111-8111-111111111111", resolution: "IMPORT_AS_NEW" } });
});

test("says what the background worker is doing for each connection, and nothing more", async ({ page }) => {
  await open(page, "state=worker&role=owner");

  const queued = page.getByRole("region", { name: /Queued Credit Union/ });
  await expect(queued.getByText("Import queued")).toBeVisible();
  await expect(queued.getByText("Connected", { exact: true })).toBeVisible();

  const running = page.getByRole("region", { name: /Running Savings Bank/ });
  await expect(running.getByText("Importing now")).toBeVisible();

  // A retry says which attempt is next, so "it will be retried" is a fact with
  // a number rather than a reassurance.
  const retrying = page.getByRole("region", { name: /Retrying Mutual/ });
  await expect(retrying.getByText("Retry scheduled — attempt 3 of 5")).toBeVisible();
  await expect(retrying.getByText("Delayed", { exact: true })).toBeVisible();

  const stopped = page.getByRole("region", { name: /Stopped Trust/ });
  await expect(stopped.getByText("Import failed after 5 attempts")).toBeVisible();
  await expect(stopped.getByText("Not importing", { exact: true })).toBeVisible();

  // No progress bar, no spinner, no percentage: a sync's length is unknown.
  expect(await page.locator("progress, [role=progressbar]").count()).toBe(0);
  await expect(page.getByText(/%/)).toHaveCount(0);
});

test("a viewer sees the worker's state but is offered no way to change it", async ({ page }) => {
  await open(page, "state=worker&role=viewer");
  await expect(page.getByText("Importing now")).toBeVisible();
  await expect(page.getByRole("button", { name: "Import now" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  expect(await submissions(page)).toEqual([]);
});

test("no page state ever puts a credential, token or worker identity in the browser", async ({ page }) => {
  for (const state of ["empty", "plan", "ready", "history", "worker"]) {
    await open(page, `state=${state}&role=owner`);
    const text = await page.locator("body").innerText();
    const html = await page.content();
    for (const forbidden of ["access-token", "access_token", "public-token", "public_token", "link-token", "secret", "PLAID_SECRET", "lease_owner", "worker-", "service_role"]) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  }
});

test("on a phone the page never scrolls sideways; wide tables scroll inside their own frame", async ({ page }) => {
  test.skip(css.length === 0, "The production stylesheet was not found; layout cannot be judged without it.");
  await page.setViewportSize({ width: 375, height: 812 });
  for (const state of ["empty", "history"]) {
    await open(page, `state=${state}&role=owner`);
    const { overflow, offenders } = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      // Elements that reach past the viewport without an scrolling ancestor
      // containing them — named, so a failure says what to fix.
      const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((element) => element.getBoundingClientRect().right > width + 1)
        .filter((element) => !element.closest("table") && !element.closest("[role=dialog]"))
        .slice(0, 8)
        .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 80)} right=${Math.round(element.getBoundingClientRect().right)}`);
      return { overflow: document.documentElement.scrollWidth - width, offenders };
    });
    expect(overflow, `${state}: ${offenders.join(" | ")}`).toBeLessThanOrEqual(1);
  }
  const frames = await page.locator("table").evaluateAll((tables) => tables.map((table) => getComputedStyle(table.parentElement!).overflowX));
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) expect(frame).toBe("auto");
  // Reachable rather than above the fold: a phone scrolls, and a control that
  // renders off-screen is not a layout defect.
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
});
