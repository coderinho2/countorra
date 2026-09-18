import type { CurrencyCode } from "@/domain/money/currency";
import { getTaxEngine } from "@/domain/tax/register";
import type { SupportedTaxCalculation, TaxCalculationOutcome } from "@/domain/tax/tax-engine";
import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import { notModelledFor } from "./facts";
import { federalPaymentsMinor, snapshotFactKeys, statePaymentsMinor, toEngineInput } from "./snapshot";
import type { PreparationIssue, RefundStatus, ResultStatus, TaxInputSnapshot } from "./types";

/**
 * RUNNING THE ENGINES AGAINST A FROZEN SNAPSHOT.
 *
 * This orchestrates; it does not calculate. Every figure comes from the
 * deterministic engines in `src/domain/tax/`, which own the tax law. What
 * this adds is the part preparation is responsible for: asking each
 * jurisdiction separately, classifying what came back, and refusing to turn a
 * refusal into a number.
 *
 * WHY EACH STATE IS ASKED RATHER THAN ASSUMED
 *
 * The five states behave differently and the differences matter:
 *
 *   California  answers 2026 under 2025's published rules, disclosed on the
 *               result — so it is an ESTIMATE, not a calculation.
 *   New York    computes 2026 from its own published figures.
 *   Florida     answers $0 because its constitution forbids the tax.
 *   Texas       answers $0 on a different constitutional basis.
 *   Arizona     refuses, because its 2026 standard deduction is unpublished.
 *
 * None of that is encoded here. Each engine is called and its own answer is
 * reported, which is why a sixth state needs no change to this file — and why
 * Arizona's refusal cannot accidentally become a zero.
 */

export interface JurisdictionResult {
  jurisdiction: TaxJurisdiction;
  status: ResultStatus;
  /** The engine's own outcome, verbatim. Null when no engine exists. */
  outcome: TaxCalculationOutcome | null;
  /** Safe to show a person, and specific about why when it is not a figure. */
  message: string;
  /** Tax owed for this jurisdiction, in minor units. Null when none was
   *  produced — which is not the same as zero. */
  totalTaxMinor: number | null;
  /** Whether this figure is before credits that were not modelled. */
  beforeCredits: boolean;
}

export interface RefundAssessment {
  status: RefundStatus;
  /** Positive means a refund, negative a balance due. Null when unknown. */
  amountMinor: number | null;
  explanation: string;
}

export interface PreparationCalculation {
  snapshotId: string;
  version: number;
  taxYear: number;
  currency: CurrencyCode;
  federal: JurisdictionResult;
  states: readonly JurisdictionResult[];
  /** Refund or balance due, federal only, and only when payments are known. */
  federalRefund: RefundAssessment;
  /** Everything collected but not turned into a figure. */
  notModelled: readonly string[];
  calculatedAt: string;
}

export interface RunCalculationInput {
  snapshot: TaxInputSnapshot;
  currency: CurrencyCode;
  calculatedAt: string;
  /** Blockers from the completeness engine. A non-empty list refuses. */
  blockers: readonly PreparationIssue[];
}

export type CalculationOutcome =
  | { ran: true; calculation: PreparationCalculation }
  /** Refused before any engine was called. */
  | { ran: false; reason: "BLOCKED"; blockers: readonly PreparationIssue[]; message: string };

export function runPreparationCalculation(input: RunCalculationInput): CalculationOutcome {
  // Gate first, and absolutely. Running the engines on partial information
  // and labelling the result carefully afterwards is not good enough — the
  // number escapes the label.
  if (input.blockers.length > 0) {
    return {
      ran: false,
      reason: "BLOCKED",
      blockers: input.blockers,
      message: `Calculation is blocked by ${input.blockers.length} unresolved ${input.blockers.length === 1 ? "issue" : "issues"}. Resolve them and calculate again.`,
    };
  }

  const { snapshot, currency } = input;
  const engineInput = toEngineInput(snapshot, currency);

  const federal = runOne("US_FEDERAL", engineInput);
  const states = snapshot.jurisdictions.filter((jurisdiction) => jurisdiction !== "US_FEDERAL").map((jurisdiction) => runOne(jurisdiction, engineInput));

  return {
    ran: true,
    calculation: {
      snapshotId: snapshot.id,
      version: snapshot.version,
      taxYear: snapshot.taxYear,
      currency,
      federal,
      states,
      federalRefund: assessFederalRefund(federal, snapshot),
      notModelled: [...notModelledFor(snapshotFactKeys(snapshot)), ...engineNotModelled(federal, states)],
      calculatedAt: input.calculatedAt,
    },
  };
}

function runOne(jurisdiction: TaxJurisdiction, engineInput: ReturnType<typeof toEngineInput>): JurisdictionResult {
  const engine = getTaxEngine(jurisdiction);
  if (!engine) {
    return {
      jurisdiction,
      status: "UNSUPPORTED",
      outcome: null,
      message: `No tax engine is implemented for ${jurisdiction}.`,
      totalTaxMinor: null,
      beforeCredits: false,
    };
  }

  // For a STATE, hand over the federal AGI the federal engine just produced
  // where one is available — every state engine here begins from it, and
  // recomputing it separately would risk two different answers.
  const outcome = engine.calculate(engineInput);

  if (!outcome.supported) {
    return {
      jurisdiction,
      status: outcome.reason === "rules_not_published" ? "BLOCKED" : "UNSUPPORTED",
      outcome,
      // The engine's own words, including the list of what is unpublished.
      // Nothing here paraphrases a refusal into something softer.
      message: outcome.details?.length ? `${outcome.message} Missing: ${outcome.details.join("; ")}` : outcome.message,
      totalTaxMinor: null,
      beforeCredits: false,
    };
  }

  return {
    jurisdiction,
    // A disclosed rule-year substitution is an ESTIMATE, not a calculation,
    // and the engine is the thing that says which.
    status: outcome.calculationStatus === "ESTIMATE_USING_LATEST_PUBLISHED_RULES" ? "ESTIMATE" : "CALCULATED",
    outcome,
    message: describe(outcome),
    totalTaxMinor: outcome.totals.totalTax.amountMinor,
    // No engine here models credits, so every figure is pre-credit.
    beforeCredits: true,
  };
}

/**
 * Names a person reads. The jurisdiction CODES stay on the result for
 * machines; a sentence shown on the page said "US_FL levies no individual
 * personal income tax" until live verification caught it.
 */
const JURISDICTION_NAMES: Readonly<Record<TaxJurisdiction, string>> = {
  US_FEDERAL: "Federal",
  US_CA: "California",
  US_NY: "New York",
  US_FL: "Florida",
  US_TX: "Texas",
  US_AZ: "Arizona",
};

export function jurisdictionName(jurisdiction: TaxJurisdiction): string {
  return JURISDICTION_NAMES[jurisdiction];
}

function describe(outcome: SupportedTaxCalculation): string {
  if (outcome.fallback) return outcome.fallback.notice;
  const name = jurisdictionName(outcome.jurisdiction);
  if (outcome.calculationMethod === "NO_INDIVIDUAL_INCOME_TAX") {
    return `${name} levies no individual personal income tax, so the individual state income tax is $0. Other taxes in that state are not covered.`;
  }
  return `Calculated under ${name} ${outcome.taxYear} rules (version ${outcome.ruleSetVersion}).`;
}

/**
 * Refund or balance due — only when it can honestly be stated.
 *
 * A liability figure alone says nothing about a refund. The absence of
 * withholding data is not zero withholding, and presenting it as such would
 * turn every un-entered W-2 box 2 into a fictitious bill.
 */
function assessFederalRefund(federal: JurisdictionResult, snapshot: TaxInputSnapshot): RefundAssessment {
  if (federal.totalTaxMinor === null) {
    return {
      status: "REFUND_STATUS_INCOMPLETE",
      amountMinor: null,
      explanation: "No federal tax figure was produced, so no refund or balance due can be stated.",
    };
  }

  const payments = federalPaymentsMinor(snapshot);
  if (payments === null) {
    return {
      status: "REFUND_STATUS_INCOMPLETE",
      amountMinor: null,
      explanation:
        "No federal withholding or estimated payments are recorded. A tax liability on its own does not imply a refund, so none is stated. Enter the federal tax withheld to see one.",
    };
  }

  const difference = payments - federal.totalTaxMinor;
  return {
    status: difference >= 0 ? "REFUND_EXPECTED" : "BALANCE_DUE",
    amountMinor: Math.abs(difference),
    explanation:
      difference >= 0
        ? "Payments recorded exceed the calculated tax. This is before any credits, which are not modelled and could change it."
        : "The calculated tax exceeds the payments recorded. This is before any credits, which are not modelled and could change it.",
  };
}

/** The engines' own not-modelled lists, deduplicated. */
function engineNotModelled(federal: JurisdictionResult, states: readonly JurisdictionResult[]): readonly string[] {
  const out = new Set<string>();
  for (const result of [federal, ...states]) {
    if (!result.outcome?.supported) continue;
    for (const item of result.outcome.notModelled) out.add(`${result.jurisdiction}: ${item}`);
  }
  return [...out];
}

/** Whether any state was refused for want of published rules. */
export function hasPendingJurisdiction(calculation: PreparationCalculation): boolean {
  return calculation.states.some((state) => state.status === "BLOCKED");
}

/** Statement of the state payments position, for the summary. */
export function statePaymentsKnown(snapshot: TaxInputSnapshot): boolean {
  return statePaymentsMinor(snapshot) !== null;
}
