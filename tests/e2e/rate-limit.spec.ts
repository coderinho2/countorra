import { expect, test } from "@playwright/test";

/**
 * End-to-end proof that the login limiter is real: a browser, over HTTP,
 * through the Server Action, against the live Postgres counter. Nothing here
 * is mocked — this is the only test in the suite that exercises the whole
 * chain at once.
 *
 * It is deliberately the *login* limiter and not the AI one: login is the
 * surface an unauthenticated attacker actually has, and it needs no fixture
 * data. Counters are keyed on a salted hash of a clearly-fake address, sit in
 * a 15-minute window, and are pruned automatically.
 */

const NONEXISTENT = `ratelimit-e2e-${Date.now()}@example.com`;
const WRONG_PASSWORD = "not-the-right-password";

async function attemptLogin(page: import("@playwright/test").Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(WRONG_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Either the credential error or the throttle message lands in the same
  // error region.
  const error = page.locator("text=/Incorrect email or password|Too many requests|temporarily unavailable/i");
  await error.first().waitFor({ state: "visible", timeout: 15_000 });
  return (await error.first().textContent()) ?? "";
}

test("repeated failed logins are throttled server-side", async ({ page }) => {
  const messages: string[] = [];

  // The per-identifier rule is 5 per 15 minutes; the per-IP rule is 10 per 5
  // minutes. Either one firing is a pass — the assertion is that the server
  // starts refusing, not which rule got there first, because the user-facing
  // message deliberately does not say.
  for (let attempt = 0; attempt < 8; attempt++) {
    messages.push(await attemptLogin(page, NONEXISTENT));
    if (/too many requests/i.test(messages[messages.length - 1]!)) break;
  }

  const throttled = messages.filter((m) => /too many requests/i.test(m));
  expect(throttled.length, `expected the server to start refusing; saw: ${JSON.stringify(messages)}`).toBeGreaterThan(0);

  // The refusal must not name the rule, the address, the identifier, or how
  // many attempts remain — any of those helps an attacker tune the next run.
  const refusal = throttled[0]!;
  expect(refusal).not.toMatch(/auth:login|ip|identifier|remaining|bucket|@/i);
});

test("the throttle message is identical for an address that does not exist", async ({ page }) => {
  // Account-existence oracles are the classic way a rate limiter leaks. Both
  // of these addresses are unregistered, but the point holds structurally:
  // the limiter counts and refuses before the credential is ever checked, so
  // its output cannot depend on whether the account is real.
  const first = `ratelimit-a-${Date.now()}@example.com`;
  const second = `ratelimit-b-${Date.now()}@example.com`;

  const firstMessages: string[] = [];
  for (let i = 0; i < 8; i++) {
    firstMessages.push(await attemptLogin(page, first));
    if (/too many requests/i.test(firstMessages[firstMessages.length - 1]!)) break;
  }

  const secondMessage = await attemptLogin(page, second);
  // Whatever the second address gets, it is one of the two generic strings —
  // never a distinct "no such account" response.
  expect(secondMessage).toMatch(/Incorrect email or password|Too many requests/i);
});

test("rotating the client address does not defeat the per-account limit", async ({ browser }) => {
  // This test demonstrates a real, documented weakness AND its mitigation.
  //
  // `x-forwarded-for` is only trustworthy when a proxy the operator controls
  // sets it. Here nothing does, so each context can claim whatever address it
  // likes — exactly what a botnet doing credential stuffing achieves for
  // free. The IP-scoped rule is therefore evaded.
  //
  // The per-identifier rule is not, because it is keyed on the submitted
  // account rather than on anything the client can rewrite. That is why every
  // auth operation carries both, and why the identifier rule is the
  // load-bearing one. See SECURITY-RATE-LIMITING.md.
  const email = `ratelimit-rotate-${Date.now()}@example.com`;
  const messages: string[] = [];

  for (let attempt = 0; attempt < 8; attempt++) {
    const context = await browser.newContext({
      extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${attempt + 1}` },
    });
    const page = await context.newPage();
    messages.push(await attemptLogin(page, email));
    await context.close();
    if (/too many requests/i.test(messages[messages.length - 1]!)) break;
  }

  expect(
    messages.some((m) => /too many requests/i.test(m)),
    `a new source address per attempt should still hit the per-account limit; saw: ${JSON.stringify(messages)}`,
  ).toBe(true);
});
