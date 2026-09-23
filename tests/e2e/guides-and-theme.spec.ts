import { expect, test } from "@playwright/test";
import { GUIDES } from "@/components/guides/guides-content";

/**
 * The published guides, and the light/dark preference, as a visitor meets
 * them.
 *
 * Both are things that look right the moment they ship and rot quietly
 * afterwards: a guide whose route stops resolving, or a theme that survives a
 * click but not a reload. The cases below are the ones a reader would hit
 * first.
 */

test("every published guide is reachable from the index", async ({ page }) => {
  await page.goto("/guides");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Financial guides");

  // Located by href, not by accessible name: each row is a single link
  // wrapping the title, the summary and the reading time, so its name is all
  // three together.
  for (const guide of GUIDES) {
    const link = page.locator(`a[href="/guides/${guide.slug}"]`).first();
    await expect(link, guide.slug).toBeVisible();
    await expect(link, guide.slug).toContainText(guide.title);
  }

  // The state the section used to be in.
  await expect(page.locator("body")).not.toContainText("aren't published yet");
});

test("a guide page renders its content, and the resources section links onward", async ({ page }) => {
  const guide = GUIDES.find((entry) => entry.slug === "federal-and-state-income-tax")!;
  await page.goto(`/guides/${guide.slug}`);

  await expect(page).toHaveTitle(`${guide.title} — Countorra`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(guide.title);
  for (const section of guide.sections) await expect(page.getByRole("heading", { name: section.heading })).toBeVisible();

  // A tax guide always separates general information from advice.
  await expect(page.locator("body")).toContainText("not advice about your particular circumstances");

  await page.goto("/resources");
  await expect(page.locator("#guides")).toContainText("Financial guides");
  await expect(page.locator("#guides").getByRole("link", { name: /All \d+ financial guides/ })).toBeVisible();
});

test("an unknown guide slug is a 404, not a blank page", async ({ page }) => {
  const response = await page.goto("/guides/not-a-real-guide");
  expect(response?.status()).toBe(404);
});

test("the theme choice applies, survives a reload, and follows the visitor between routes", async ({ page }) => {
  await page.goto("/guides");

  const root = page.locator("html");
  const dark = page.getByRole("radio", { name: "Dark theme" });
  const light = page.getByRole("radio", { name: "Light theme" });

  await light.click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await expect(light).toHaveAttribute("aria-checked", "true");

  await dark.click();
  await expect(root).toHaveAttribute("data-theme", "dark");

  // Survives a full reload — the preference is stored, and the blocking
  // script applies it before first paint.
  await page.reload();
  await expect(root).toHaveAttribute("data-theme", "dark");

  // ...and a client-side navigation to another part of the site.
  await page.goto("/pricing");
  await expect(root).toHaveAttribute("data-theme", "dark");
  await page.goto("/privacy");
  await expect(root).toHaveAttribute("data-theme", "dark");

  // Back to light, and it sticks the same way.
  await page.getByRole("radio", { name: "Light theme" }).click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.goto("/");
  await expect(root).toHaveAttribute("data-theme", "light");
});

test("the theme control is a labelled radio group with one tab stop", async ({ page }) => {
  await page.goto("/");
  const group = page.getByRole("radiogroup", { name: "Colour theme" }).first();
  await expect(group).toBeVisible();

  // Roving tabindex: the selected option is the only one in the tab order.
  const checked = group.getByRole("radio", { name: /theme$/ }).and(page.locator('[aria-checked="true"]'));
  await expect(checked).toHaveCount(1);
  await expect(checked).toHaveAttribute("tabindex", "0");
});
