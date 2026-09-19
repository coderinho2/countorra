/**
 * Stand-in for `@/server/account/actions` inside the delete-account harness.
 * It is NOT an auth or data path and never reaches a server. It records
 * exactly what the real dialog submitted and answers with the result the test
 * chose, so the dialog's own behaviour (gating, pending, double submission,
 * error display) can be observed in a real browser.
 *
 * What the real action does is tested in tests/server/account-deletion.test.ts
 * and tests/server/billing-deletion-safety.test.ts, and the database half in
 * tests/rls/billing-safe-deletion.test.ts.
 */

export interface AccountActionResult {
  error?: string;
  success?: boolean;
}

declare global {
  interface Window {
    __deleteSubmissions: Record<string, string>[];
    __deleteResult: AccountActionResult;
    /** Milliseconds the fake round trip takes, so pending state is visible. */
    __deleteDelay: number;
  }
}

export async function deleteAccountAction(_prev: AccountActionResult, formData: FormData): Promise<AccountActionResult> {
  const fields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) fields[key] = typeof value === "string" ? value : "[file]";
  window.__deleteSubmissions.push(fields);
  await new Promise((resolve) => setTimeout(resolve, window.__deleteDelay));
  return window.__deleteResult;
}

export async function transferOrganizationOwnershipAction(): Promise<AccountActionResult> {
  return { error: "Not available in the harness." };
}
