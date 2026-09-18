import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { build } from "vite";

/**
 * The taxpayer form's state across failed and successful saves, in a real
 * browser, against the REAL TaxpayerForm component and real Radix selects.
 *
 * WHY A HARNESS AND NOT THE APP PAGE: the Tax preparation page needs a signed-in
 * member, and this suite has no authenticated session (see smoke.spec.ts). The
 * form's state handling does not depend on who is signed in, so the component
 * is bundled on its own with its server actions replaced by a recorder
 * (harness/actions-stub.ts). No auth is faked: nothing here talks to a server.
 * What a failed save does on the SERVER is tested in
 * tests/server/tax-preparation-taxpayer-action.test.ts.
 *
 * Two defects are pinned:
 *   1. After a SUCCESSFUL save, React reset the form and Radix restored each
 *      select's mount-time value, so the form showed and resubmitted old choices.
 *   2. After a FAILED save, the same reset silently threw away the person's
 *      unsaved changes while an error said the save had failed.
 */

const ROOT = path.resolve(__dirname, "../..");
const HARNESS = "http://taxpayer-form.harness.test/";
let bundle = "";

test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    root: ROOT,
    logLevel: "silent",
    mode: "development",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    resolve: {
      alias: [
        { find: "@/server/tax-preparation/actions", replacement: path.resolve(__dirname, "harness/actions-stub.ts") },
        { find: /^@\//, replacement: `${path.resolve(ROOT, "src")}/` },
      ],
    },
    oxc: { jsx: { runtime: "automatic" } },
    build: {
      write: false,
      minify: false,
      emptyOutDir: false,
      rolldownOptions: {
        input: path.resolve(__dirname, "harness/taxpayer-form-entry.tsx"),
        output: { format: "iife" },
      },
    },
  });
  const results = Array.isArray(output) ? output : [output];
  const chunk = results.flatMap((result) => ("output" in result ? result.output : [])).find((file) => file.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("The taxpayer form harness did not build.");
  bundle = chunk.code;
});

async function open(page: Page) {
  await page.route(`${HARNESS}**`, (route) => {
    if (route.request().url().endsWith("/harness.js")) return route.fulfill({ contentType: "text/javascript", body: bundle });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/harness.js"></script></body></html>' });
  });
  await page.goto(HARNESS);
  await expect(page.getByRole("button", { name: "Save details" })).toBeVisible();
}

async function choose(page: Page, field: string, option: string) {
  await page.locator(`#${field}`).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  await expect(page.locator(`#${field}`)).toHaveText(option);
}

/** What each select shows, what its hidden input will submit, and the text field. */
async function formState(page: Page) {
  return page.evaluate(() => {
    const form = document.querySelector("form")!;
    const hidden = (name: string) => (form.querySelector(`input[type=hidden][name=${name}]`) as HTMLInputElement).value;
    const shown = (id: string) => document.getElementById(id)!.textContent;
    return {
      filingStatus: { shown: shown("filingStatus"), submits: hidden("filingStatus") },
      taxIdentifierType: { shown: shown("taxIdentifierType"), submits: hidden("taxIdentifierType") },
      spouseItemizesDeductions: { shown: shown("spouseItemizesDeductions"), submits: hidden("spouseItemizesDeductions") },
      additionalStateRegions: (document.getElementById("additionalStateRegions") as HTMLInputElement).value,
      legalMiddleName: (document.getElementById("legalMiddleName") as HTMLInputElement).value,
    };
  });
}

const submissions = (page: Page) => page.evaluate(() => window.__submissions);
const saved = (page: Page) => page.evaluate(() => window.__saved);
const nextResult = (page: Page, result: { error?: string; success?: boolean; message?: string }) => page.evaluate((value) => void (window.__nextResult = value), result);

test("a failed save keeps the person's changes, says nothing was saved, and a retry saves them", async ({ page }) => {
  await open(page);

  // Change two selects and a text field.
  await choose(page, "filingStatus", "Head of household");
  await choose(page, "taxIdentifierType", "ITIN");
  await choose(page, "spouseItemizesDeductions", "No");
  await page.locator("#additionalStateRegions").fill("N1");

  // The server refuses the save.
  await nextResult(page, { error: "Use two-letter state codes, separated by commas." });
  await page.getByRole("button", { name: "Save details" }).click();

  await expect(page.getByText("Couldn't save")).toBeVisible();
  expect((await submissions(page))[0]).toMatchObject({ filingStatus: "head_of_household", taxIdentifierType: "itin", spouseItemizesDeductions: "no", additionalStateRegions: "N1" });

  // Nothing reverted — not immediately, and not a moment later.
  const attempted = {
    filingStatus: { shown: "Head of household", submits: "head_of_household" },
    taxIdentifierType: { shown: "ITIN", submits: "itin" },
    spouseItemizesDeductions: { shown: "No", submits: "no" },
    additionalStateRegions: "N1",
    legalMiddleName: "",
  };
  expect(await formState(page)).toEqual(attempted);
  await page.waitForTimeout(750);
  expect(await formState(page)).toEqual(attempted);

  // The failure is unmistakable, and says what happened to the changes.
  await expect(page.getByText(/Nothing was saved/)).toBeVisible();
  await expect(page.getByText("Saved.", { exact: true })).toHaveCount(0);

  // The saved case is untouched.
  expect(await saved(page)).toMatchObject({ filingStatus: "single", taxpayer: { taxIdentifierType: "ssn", additionalStateRegions: ["NY"], spouseItemizesDeductions: null } });

  // Correct the one bad field and retry: everything the person chose is saved.
  await page.locator("#additionalStateRegions").fill("ny, nj");
  await nextResult(page, { success: true, message: "Saved." });
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(page.getByText("Couldn't save")).toHaveCount(0);

  expect((await submissions(page))[1]).toMatchObject({ filingStatus: "head_of_household", taxIdentifierType: "itin", spouseItemizesDeductions: "no", additionalStateRegions: "ny, nj" });
  expect(await saved(page)).toMatchObject({ filingStatus: "head_of_household", taxpayer: { taxIdentifierType: "itin", additionalStateRegions: ["NY", "NJ"], spouseItemizesDeductions: false } });

  // After success the form shows exactly what was saved — normalised by the server.
  expect(await formState(page)).toEqual({
    filingStatus: { shown: "Head of household", submits: "head_of_household" },
    taxIdentifierType: { shown: "ITIN", submits: "itin" },
    spouseItemizesDeductions: { shown: "No", submits: "no" },
    additionalStateRegions: "NY, NJ",
    legalMiddleName: "",
  });
});

test("after a successful save, editing another field and saving again submits the current selections", async ({ page }) => {
  await open(page);

  await choose(page, "filingStatus", "Married filing separately");
  await choose(page, "taxIdentifierType", "ITIN");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await page.waitForTimeout(500);

  expect((await formState(page)).filingStatus).toEqual({ shown: "Married filing separately", submits: "married_filing_separately" });
  expect((await formState(page)).taxIdentifierType).toEqual({ shown: "ITIN", submits: "itin" });

  // Only a text field changes; the second save must carry the saved selections.
  await page.locator("#legalMiddleName").fill("Quinn");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect.poll(async () => (await submissions(page)).length).toBe(2);
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  expect((await submissions(page))[1]).toMatchObject({ filingStatus: "married_filing_separately", taxIdentifierType: "itin", legalMiddleName: "Quinn" });
});

test("a failed save after a successful one keeps the new attempt, not the earlier saved values", async ({ page }) => {
  await open(page);

  await choose(page, "filingStatus", "Head of household");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

  await choose(page, "filingStatus", "Qualifying surviving spouse");
  await page.locator("#legalMiddleName").fill("123-45-6789");
  await nextResult(page, { error: "Don't enter a Social Security number or other tax ID here. Countorra never stores the number itself." });
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Couldn't save")).toBeVisible();

  const state = await formState(page);
  expect(state.filingStatus).toEqual({ shown: "Qualifying surviving spouse", submits: "qualifying_surviving_spouse" });
  expect(state.legalMiddleName).toBe("123-45-6789");
  expect((await saved(page)).filingStatus).toBe("head_of_household");

  // Rapid correction and retry.
  await page.locator("#legalMiddleName").fill("");
  await nextResult(page, { success: true, message: "Saved." });
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  expect((await saved(page)).filingStatus).toBe("qualifying_surviving_spouse");
  expect((await formState(page)).filingStatus).toEqual({ shown: "Qualifying surviving spouse", submits: "qualifying_surviving_spouse" });
});
