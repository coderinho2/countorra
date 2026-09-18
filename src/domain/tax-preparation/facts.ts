import type { FactCalculationSupport, TaxFactKey } from "./types";

/**
 * THE NORMALIZED FACT VOCABULARY.
 *
 * One table, and it carries the thing that is easiest to get wrong: which
 * facts the deterministic engines actually consume, and which are merely
 * collected. A product that quietly drops an income category because no
 * engine reads it produces a figure that looks complete and is not.
 *
 * So every key declares its support level, and `notModelledFor` turns the
 * COLLECTED_NOT_CALCULATED ones into an explicit list that travels on the
 * preparation package. Nothing is silently omitted.
 *
 * FORM MAPPING IS DELIBERATELY COARSE
 *
 * `formConcept` names the form or schedule a fact belongs to, and never a
 * line number. The 2026 Form 1040 instructions are not published in final
 * form, and inventing "line 1a" for 2026 would be exactly the fabrication the
 * source-integrity work exists to prevent. `FORM_MAPPING_PENDING` is the
 * honest value until an authoritative 2026 form is verified.
 */

export interface TaxFactDefinition {
  key: TaxFactKey;
  /** Short, safe to show a person. */
  label: string;
  /** Whether an engine consumes it, and if not, that it is still reported. */
  support: FactCalculationSupport;
  /** True for amounts in minor units; false for flags and codes. */
  monetary: boolean;
  /** Amounts that may legitimately be negative — a capital loss, a Schedule C
   *  loss. Everything else is rejected below zero by `validation.ts`. */
  allowsNegative: boolean;
  /**
   * The form or schedule this belongs on, as a concept. Never a line number
   * for 2026 — see the header.
   */
  formConcept: string;
  /** The tax document that would normally evidence it, where one exists. */
  expectedDocument: string | null;
  /** Why an engine cannot use it, for the ones that cannot. */
  notModelledReason?: string;
}

const DEFINITIONS: readonly TaxFactDefinition[] = [
  // ── Income the federal engine genuinely consumes ─────────────────────
  {
    key: "W2_WAGES",
    label: "W-2 wages",
    support: "CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Form 1040 — wages (FORM_MAPPING_PENDING for the 2026 line)",
    expectedDocument: "W-2",
  },
  {
    key: "W2_SOCIAL_SECURITY_WAGES",
    label: "W-2 Social Security wages (box 3)",
    support: "CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule SE — wage-base coordination",
    expectedDocument: "W-2",
  },
  {
    key: "W2_MEDICARE_WAGES",
    label: "W-2 Medicare wages (box 5)",
    support: "CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule SE / Form 8959 — Additional Medicare Tax threshold",
    expectedDocument: "W-2",
  },
  {
    key: "SELF_EMPLOYMENT_NET_PROFIT",
    label: "Self-employment net profit",
    support: "CALCULATED",
    monetary: true,
    // A Schedule C loss is real, and the federal engine handles it explicitly.
    allowsNegative: true,
    formConcept: "Schedule C / Schedule SE",
    expectedDocument: "1099-NEC",
  },

  // ── Income collected but NOT calculated ──────────────────────────────
  //
  // Each of these is stored, validated and reported. None reaches a figure,
  // because the engines model ordinary income and self-employment tax only.
  {
    key: "INTEREST_INCOME",
    label: "Interest income",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule B",
    expectedDocument: "1099-INT",
    notModelledReason: "Interest is collected and reported but is not yet added to the engine's ordinary income input.",
  },
  {
    key: "ORDINARY_DIVIDENDS",
    label: "Ordinary dividends",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule B",
    expectedDocument: "1099-DIV",
    notModelledReason: "Dividends are collected and reported but are not yet an engine input.",
  },
  {
    key: "QUALIFIED_DIVIDENDS",
    label: "Qualified dividends",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Qualified Dividends and Capital Gain Tax Worksheet",
    expectedDocument: "1099-DIV",
    notModelledReason: "Qualified dividends carry preferential rates, which no engine here models. Reporting them as ordinary income would overstate the tax.",
  },
  {
    key: "CAPITAL_GAIN_OR_LOSS",
    label: "Capital gain or loss",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: true,
    formConcept: "Schedule D / Form 8949",
    expectedDocument: "1099-B",
    notModelledReason: "Long-term capital gains carry preferential rates and losses carry limits; neither is modelled, so the figure is collected rather than taxed.",
  },
  {
    key: "UNEMPLOYMENT_COMPENSATION",
    label: "Unemployment compensation",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule 1",
    expectedDocument: "1099-G",
    notModelledReason: "Collected and reported; not yet an engine input.",
  },
  {
    key: "RETIREMENT_INCOME",
    label: "Retirement distributions",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Form 1040 — pensions and annuities",
    expectedDocument: "1099-R",
    notModelledReason: "The taxable portion of a distribution depends on basis and rollover treatment, none of which is modelled.",
  },
  {
    key: "SOCIAL_SECURITY_BENEFITS",
    label: "Social Security benefits",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Social Security Benefits Worksheet",
    expectedDocument: "SSA-1099",
    notModelledReason:
      "How much of a benefit is taxable depends on a provisional-income worksheet that is not modelled. Note that some states — Arizona among them — do not tax it at all.",
  },
  {
    key: "RENTAL_INCOME",
    label: "Rental income",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: true,
    formConcept: "Schedule E",
    expectedDocument: null,
    notModelledReason: "Rental income carries depreciation and passive-loss rules that are not modelled.",
  },
  {
    key: "K1_INCOME",
    label: "Partnership / S-corporation income (K-1)",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: true,
    formConcept: "Schedule E / Schedule K-1",
    expectedDocument: "K-1",
    notModelledReason: "K-1 income carries character and basis rules that are not modelled.",
  },
  {
    key: "OTHER_1099_INCOME",
    label: "Other 1099 income",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule 1",
    expectedDocument: "1099-MISC",
    notModelledReason: "Collected and reported; its treatment depends on what the payment was for.",
  },
  {
    key: "OTHER_INCOME",
    label: "Other income",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule 1",
    expectedDocument: null,
    notModelledReason: "Collected and reported; its treatment depends on what it is.",
  },

  // ── Deductions and state adjustments ─────────────────────────────────
  {
    key: "ITEMIZED_DEDUCTIONS_TOTAL",
    label: "Itemized deductions",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule A",
    expectedDocument: null,
    notModelledReason: "Every engine here applies the standard deduction. Itemizing is collected for review but never applied.",
  },
  {
    key: "MORTGAGE_INTEREST",
    label: "Mortgage interest paid",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule A",
    expectedDocument: "1098",
    notModelledReason: "An itemized deduction, and itemizing is not modelled.",
  },
  {
    key: "CHARITABLE_CONTRIBUTIONS",
    label: "Charitable contributions",
    support: "COLLECTED_NOT_CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "Schedule A",
    expectedDocument: null,
    notModelledReason:
      "Not modelled federally. Note that Arizona increases its standard deduction by charitable contributions from tax year 2026, so this is worth collecting even though no engine consumes it yet.",
  },
  {
    key: "STATE_ADDITIONS",
    label: "State additions to federal income",
    support: "CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "State adjustment schedule — Schedule CA (540) or Form IT-225",
    expectedDocument: null,
  },
  {
    key: "STATE_SUBTRACTIONS",
    label: "State subtractions from federal income",
    support: "CALCULATED",
    monetary: true,
    allowsNegative: false,
    formConcept: "State adjustment schedule — Schedule CA (540) or Form IT-225",
    expectedDocument: null,
  },

  // ── Payments: what makes a refund statement possible at all ──────────
  {
    key: "W2_FEDERAL_WITHHOLDING",
    label: "Federal income tax withheld",
    support: "PAYMENTS_ONLY",
    monetary: true,
    allowsNegative: false,
    formConcept: "Form 1040 — federal income tax withheld",
    expectedDocument: "W-2",
  },
  {
    key: "W2_STATE_WITHHOLDING",
    label: "State income tax withheld",
    support: "PAYMENTS_ONLY",
    monetary: true,
    allowsNegative: false,
    formConcept: "State return — tax withheld",
    expectedDocument: "W-2",
  },
  {
    key: "FEDERAL_ESTIMATED_PAYMENTS",
    label: "Federal estimated tax payments",
    support: "PAYMENTS_ONLY",
    monetary: true,
    allowsNegative: false,
    formConcept: "Form 1040 — estimated payments",
    expectedDocument: null,
  },
  {
    key: "STATE_ESTIMATED_PAYMENTS",
    label: "State estimated tax payments",
    support: "PAYMENTS_ONLY",
    monetary: true,
    allowsNegative: false,
    formConcept: "State return — estimated payments",
    expectedDocument: null,
  },
];

const BY_KEY = new Map<TaxFactKey, TaxFactDefinition>(DEFINITIONS.map((definition) => [definition.key, definition]));

export function factDefinition(key: TaxFactKey): TaxFactDefinition {
  const definition = BY_KEY.get(key);
  // A key in the union with no definition would silently lose its support
  // level and its validation rules, which is precisely the kind of quiet gap
  // this module exists to close.
  if (!definition) throw new RangeError(`No tax fact definition for ${key}.`);
  return definition;
}

export function allFactDefinitions(): readonly TaxFactDefinition[] {
  return DEFINITIONS;
}

export function isKnownFactKey(value: string): value is TaxFactKey {
  return BY_KEY.has(value as TaxFactKey);
}

/**
 * The `notModelled` list for the facts a case actually has.
 *
 * Scoped to what was supplied rather than listing every unsupported category
 * in existence: a person who entered no rental income does not need to be
 * told rental income is unmodelled, and burying the two entries that matter
 * in a list of fifteen is how disclosure stops working.
 */
export function notModelledFor(keys: readonly TaxFactKey[]): readonly string[] {
  const seen = new Set<TaxFactKey>();
  const out: string[] = [];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const definition = factDefinition(key);
    if (definition.support !== "COLLECTED_NOT_CALCULATED") continue;
    out.push(`${definition.label}: ${definition.notModelledReason ?? "collected and reported, but not included in any calculated figure."}`);
  }
  return out;
}

/** Facts that feed an engine input and therefore change a figure. */
export function calculatedKeys(): readonly TaxFactKey[] {
  return DEFINITIONS.filter((d) => d.support === "CALCULATED").map((d) => d.key);
}

/** Facts that establish what has already been paid. */
export function paymentKeys(): readonly TaxFactKey[] {
  return DEFINITIONS.filter((d) => d.support === "PAYMENTS_ONLY").map((d) => d.key);
}
