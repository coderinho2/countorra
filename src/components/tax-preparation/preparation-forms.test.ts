import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The taxpayer form's single source of truth, pinned structurally.
 *
 * The behaviour itself — a successful save showing and resubmitting what was
 * saved, and a failed save keeping the person's changes — is exercised in a
 * real browser against the real component in
 * tests/e2e/taxpayer-form-state.spec.ts, and on the server in
 * tests/server/tax-preparation-taxpayer-action.test.ts. This guards the shape
 * of the fix so it cannot be quietly undone or replaced with a workaround.
 */

const source = readFileSync(path.resolve(__dirname, "preparation-forms.tsx"), "utf8");
const taxpayerForm = source.slice(source.indexOf("export function TaxpayerForm"), source.indexOf("// ── Facts"));

describe("TaxpayerForm", () => {
  it("keys its fields on the saved case and on successful saves only", () => {
    expect(taxpayerForm).toMatch(/const persisted = JSON\.stringify\(\{ filingStatus, taxpayer \}\);/);
    expect(taxpayerForm).toContain("<Fragment key={`${persisted}#${state.savedCount}`}>");
    expect(taxpayerForm).toMatch(/savedCount: previous\.savedCount \+ \(result\.success \? 1 : 0\)/);

    const keyed = taxpayerForm.slice(taxpayerForm.indexOf("<Fragment key="), taxpayerForm.indexOf("</Fragment>"));
    for (const name of ["filingStatus", "taxIdentifierType", "taxIdentifierOnFile", "additionalStateRegions", "spouseTaxIdentifierOnFile", "spouseItemizesDeductions"]) {
      expect(keyed, name).toContain(`name="${name}"`);
    }
  });

  it("dispatches submission itself, so React never resets the form after a save", () => {
    expect(taxpayerForm).toMatch(/onSubmit=\{submit\}/);
    expect(taxpayerForm).toMatch(/event\.preventDefault\(\);/);
    expect(taxpayerForm).toMatch(/startTransition\(\(\) => formAction\(formData\)\)/);
  });

  it("says plainly that a failed save saved nothing and kept the changes", () => {
    expect(taxpayerForm).toMatch(/Nothing was saved — your changes are still below/);
  });

  it("holds no copy of the field values in React state", () => {
    expect(taxpayerForm).not.toMatch(/useState|useEffect|useRef|useLayoutEffect/);
  });

  it("does not paper over the bugs with timers, reloads or browser storage", () => {
    expect(source).not.toMatch(/setTimeout|setInterval|location\.reload|router\.refresh|localStorage|sessionStorage/);
  });
});
