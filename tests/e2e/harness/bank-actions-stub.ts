import type { BankActionResult } from "@/server/bank-connections/actions";

/**
 * TEST-ONLY stand-ins for the bank-connection Server Actions, for the browser
 * harness. They record exactly what a form would post, so the spec can prove
 * the page sends ids and one small choice — and nothing else.
 */

declare global {
  interface Window {
    __bankSubmissions: { action: string; fields: Record<string, string> }[];
    __bankNextResult?: BankActionResult;
  }
}

function recorder(action: string) {
  return async (_previous: BankActionResult, formData: FormData): Promise<BankActionResult> => {
    window.__bankSubmissions = window.__bankSubmissions ?? [];
    const fields: Record<string, string> = {};
    formData.forEach((value, key) => {
      if (typeof value === "string" && !key.startsWith("$ACTION")) fields[key] = value;
    });
    window.__bankSubmissions.push({ action, fields });
    return window.__bankNextResult ?? { success: true, message: "Recorded by the harness." };
  };
}

export const startBankLinkAction = recorder("startBankLink");
export const completeBankLinkAction = recorder("completeBankLink");
export const completeBankReauthAction = recorder("completeBankReauth");
export const requestBankSyncAction = recorder("requestBankSync");
export const disconnectBankConnectionAction = recorder("disconnect");
export const linkExternalAccountAction = recorder("link");
export const resolveBankReviewAction = recorder("resolve");
export type { BankActionResult };
