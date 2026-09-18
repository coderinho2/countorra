/**
 * Stand-in for `@/server/tax-preparation/actions` inside the taxpayer form
 * harness. It is NOT an auth or data path — it never reaches a server. It only
 * records what the real form submitted and answers with whatever result the
 * test chose, so the form's own state handling can be observed in a browser.
 *
 * The server half (validation, authorization, "a failed save writes nothing")
 * is tested against the real action in tests/server/.
 */

export interface HarnessResult {
  error?: string;
  success?: boolean;
  message?: string;
}

type SubmittedFields = Record<string, string>;

declare global {
  interface Window {
    __submissions: SubmittedFields[];
    __nextResult: HarnessResult;
    __applySaved: (fields: SubmittedFields) => void;
  }
}

export async function updateTaxpayerAction(_prev: HarnessResult, formData: FormData): Promise<HarnessResult> {
  const fields: SubmittedFields = {};
  for (const [key, value] of formData.entries()) if (typeof value === "string") fields[key] = value;
  window.__submissions.push(fields);
  // A round trip, so pending state and ordering behave as they do for real.
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  const result = window.__nextResult;
  // A successful save is followed by the server re-rendering the page with the
  // saved case — `revalidatePath` in the real action.
  if (result.success) window.__applySaved(fields);
  return result;
}

const unused = async (): Promise<HarnessResult> => ({ error: "Not available in the harness." });
export const addDependentAction = unused;
export const calculateTaxPreparationAction = unused;
export const recordFactAction = unused;
export const removeDependentAction = unused;
export const reviewFactAction = unused;
export const startTaxPreparationAction = unused;
