import { describe, expect, it } from "vitest";
import { amountSign } from "./display";
import { money } from "./money";

const usd = (minor: number) => money(minor, "USD");

describe("amountSign", () => {
  /**
   * The regression this file exists for. A credit-card account holding
   * −$13,274.40 was rendered as "$13,274.40" in the negative colour, because
   * the display component stripped the minus whenever no explicit sign mode
   * was passed. DESIGN.md §24 forbids colour as the sole indicator, and the
   * failure mode is worse than that: a reader who does not register the
   * colour reads the balance as money held rather than money owed.
   */
  it("always signs a negative amount, even with no sign mode", () => {
    expect(amountSign(usd(-1_327_440))).toBe("−");
  });

  it("still signs a negative amount under every non-suppressing mode", () => {
    for (const mode of ["auto", "positive", "negative"] as const) {
      expect(amountSign(usd(-500), mode)).toBe("−");
    }
  });

  it("uses U+2212 MINUS SIGN, never a hyphen", () => {
    // A hyphen is narrower and shorter than a tabular digit, so a column of
    // negative amounts set with one no longer aligns.
    expect(amountSign(usd(-1))).toBe("−");
    expect(amountSign(usd(-1))).not.toBe("-");
  });

  it("leaves a positive amount unsigned by default, so a balance is not read as a delta", () => {
    expect(amountSign(usd(482_000))).toBe("");
  });

  it("signs a positive amount under 'auto', for deltas and movements", () => {
    expect(amountSign(usd(482_000), "auto")).toBe("+");
  });

  it("forces the sign for amounts stored unsigned alongside a separate kind", () => {
    // Transaction rows store `amount_minor` unsigned with `kind` carrying the
    // direction, so an expense row asks for "negative" on a positive number.
    expect(amountSign(usd(129_900), "negative")).toBe("−");
    expect(amountSign(usd(129_900), "positive")).toBe("+");
  });

  it("suppresses the sign only under 'none'", () => {
    expect(amountSign(usd(129_900), "none")).toBe("");
    // Even then, a genuinely negative amount is not misrepresented — "none"
    // is only used for transfers, which are stored unsigned.
    expect(amountSign(usd(0), "none")).toBe("");
  });

  it("leaves zero unsigned in every mode that could add one", () => {
    expect(amountSign(usd(0))).toBe("");
    expect(amountSign(usd(0), "auto")).toBe("");
  });
});
