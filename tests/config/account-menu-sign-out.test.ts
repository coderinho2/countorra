import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Sign-out from the account menu must actually submit.
 *
 * FOUND DURING LIVE VERIFICATION (Task 7.1.2): clicking "Sign out" left the
 * user signed in. The sign-out <form> was rendered inside a Radix
 * DropdownMenuItem. Radix dispatches item selection through flushSync and
 * closes the menu unless onSelect prevents it, so the form was unmounted
 * before the browser ran the submit button's default action; the browser
 * logged "Form submission canceled because the form is not connected" and no
 * request reached the server. Keyboard selection (Enter/Space) calls click()
 * on the item — the <form> itself — which never submits.
 *
 * The suite has no DOM environment (vitest runs in node) and no authenticated
 * E2E account, so the structure that makes sign-out work is pinned here and
 * the behaviour was verified in the running app.
 */

const source = readFileSync(path.join(process.cwd(), "src/components/app-shell/account-menu.tsx"), "utf8");
const menuContent = source.slice(source.indexOf("<DropdownMenuContent"), source.indexOf("</DropdownMenuContent>"));

describe("account menu sign-out", () => {
  it("renders the sign-out form outside the menu, so closing the menu cannot unmount it", () => {
    expect(source).toMatch(/<form ref=\{signOutFormRef\} action=\{signOutAction\} hidden \/>/);
    expect(source.indexOf("<form")).toBeLessThan(source.indexOf("<DropdownMenu>"));
    expect(menuContent).not.toMatch(/<form/);
  });

  it("submits that form from the item's onSelect, which runs for pointer and keyboard selection", () => {
    const item = menuContent.slice(menuContent.lastIndexOf("<DropdownMenuItem", menuContent.indexOf("Sign out")), menuContent.indexOf("Sign out"));
    expect(item).toMatch(/onSelect=\{\(\) => signOutFormRef\.current\?\.requestSubmit\(\)\}/);
    expect(item).not.toMatch(/asChild/);
  });

  it("does not rely on a submit button inside the menu", () => {
    expect(menuContent).not.toMatch(/type="submit"/);
  });
});
