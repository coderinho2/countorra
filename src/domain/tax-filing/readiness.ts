import type { CurrencyCode } from "@/domain/money/currency";
import { jurisdictionName, runPreparationCalculation, type JurisdictionResult, type PreparationCalculation } from "@/domain/tax-preparation/calculation";
import type { CompletenessResult } from "@/domain/tax-preparation/completeness";
import { factDefinition, isKnownFactKey } from "@/domain/tax-preparation/facts";
import type { PreparationCase, PreparationDependent, PreparationIssue, TaxFact } from "@/domain/tax-preparation/types";
import { stateJurisdictionFor } from "@/domain/tax/register";
import { findRuleSet } from "@/domain/tax/rules/registry";
import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import { liveInputsMatchFrozen, type FrozenPreparation } from "./inputs";
import { unverifiedRequirementIds } from "./requirements";
import {
  FILING_TAX_YEAR,
  READINESS_ENGINE_VERSION,
  type ComponentReadiness,
  type FilingIssue,
  type FilingIssueProvenance,
  type FilingIssueScope,
  type FilingIssueSeverity,
  type FilingReadiness,
  type JurisdictionReadiness,
  type ReadinessStatus,
} from "./types";

/**
 * THE FILING READINESS ENGINE.
 *
 * Deterministic and pure: the same case, facts and stored calculation always
 * produce the same result, byte for byte, with no clock and no I/O. That is
 * what lets a result be frozen into a snapshot and re-derived later.
 *
 * WHAT IT DOES NOT DO
 *
 * It computes no tax. Every figure comes from the stored preparation
 * calculation, and the only engine call here re-runs the SAME deterministic
 * engines on the SAME frozen inputs to prove the stored result is what they
 * produce — a stored figure that a member forged through the API, or that was
 * computed under a rule set since corrected, is refused rather than filed.
 *
 * It decides no tax law. Blockers are about what Countorra can prove or
 * supports; filing requirements it has not verified are reported, not
 * enforced (see `requirements.ts`).
 *
 * HOW THE STATUS IS DETERMINED
 *
 *   NOT_SUPPORTED    not tax year 2026, or not a US workspace
 *   BLOCKED          any FILING- or FEDERAL-scope blocker
 *   REVIEW_REQUIRED  either a REVIEW issue is open — a filing-status question
 *                    Countorra does not decide — and NOTHING is finalizable;
 *                    or federal is clear but a state component is not ready,
 *                    and federal may be finalized alone, naming the state
 *   READY            federal and every state component ready or not applicable
 *
 * CALCULATION IS NOT QUALIFICATION
 *
 * Every federal filing status is calculated from 2026's published tables. That
 * says nothing about whether the taxpayer may use the status. Head of household
 * and qualifying surviving spouse have qualification tests, and filing
 * separately loses the standard deduction if the spouse itemizes; none of that
 * is decided here. An open question is a REVIEW issue, and a REVIEW issue is
 * never cleared by assuming the answer.
 */

export interface FilingReadinessInput {
  /** The filing case's own tax year. */
  filingTaxYear: number;
  organization: { country: string; entityType: string };
  /** With the organization's authoritative state already applied. */
  preparationCase: PreparationCase;
  /** Current facts — superseded rows already filtered. */
  facts: readonly TaxFact[];
  dependents: readonly PreparationDependent[];
  completeness: CompletenessResult;
  latest: FrozenPreparation | null;
  calculationIsCurrent: boolean;
  currency: CurrencyCode | null;
}

const SEVERITY_RANK: Record<FilingIssueSeverity, number> = { BLOCKER: 0, REVIEW: 1, WARNING: 2, INFO: 3 };
const SCOPE_RANK: Record<FilingIssueScope, number> = { FILING: 0, FEDERAL: 1, STATE: 2 };

/** Collected-not-calculated keys that are deductions rather than income. */
const DEDUCTION_KEYS = new Set<string>(["ITEMIZED_DEDUCTIONS_TOTAL", "MORTGAGE_INTEREST", "CHARITABLE_CONTRIBUTIONS"]);

/** Preparation issues the filing layer restates in its own, more specific terms. */
const RESTATED_PREPARATION_ISSUES = new Set<string>(["MULTI_STATE_REVIEW_REQUIRED", "FEDERAL_PAYMENTS_UNKNOWN", "TAXPAYER_IDENTIFIER_NOT_ON_FILE",
  // The state component reports a missing or unsupported state itself.
  "STATE_NOT_SET",
  "STATE_NOT_SUPPORTED",
]);

function product(rule: string): FilingIssueProvenance {
  return { kind: "COUNTORRA_PRODUCT_RULE", rule };
}

export function assessFilingReadiness(input: FilingReadinessInput): FilingReadiness {
  const issues: FilingIssue[] = [];
  const add = (issue: Omit<FilingIssue, "related"> & { related?: FilingIssue["related"] }) => issues.push({ related: null, ...issue });
  const { preparationCase, completeness, latest, currency } = input;
  const calculation = latest?.calculation ?? null;

  // ── Scope of this layer ─────────────────────────────────────────────
  let notSupported = false;

  if (input.filingTaxYear !== FILING_TAX_YEAR) {
    notSupported = true;
    add({
      code: "FILING_TAX_YEAR_UNSUPPORTED",
      severity: "BLOCKER",
      scope: "FILING",
      jurisdiction: null,
      message: `Filing readiness is available for tax year ${FILING_TAX_YEAR} only.`,
      resolution: `Prepare a ${FILING_TAX_YEAR} return. Other years are not evaluated, and no year's rules stand in for another's.`,
      provenance: product("Filing readiness serves exactly one tax year."),
    });
  }

  if (preparationCase.taxYear !== input.filingTaxYear) {
    add({
      code: "FILING_TAX_YEAR_MISMATCH",
      severity: "BLOCKER",
      scope: "FILING",
      jurisdiction: null,
      message: "The filing case and the preparation it refers to are for different tax years.",
      resolution: "Start filing from the preparation for the same tax year.",
      related: { preparationCaseId: preparationCase.id },
      provenance: product("A filing case and its preparation share one tax year."),
    });
  }

  if (input.organization.country !== "US") {
    notSupported = true;
    add({
      code: "FILING_COUNTRY_UNSUPPORTED",
      severity: "BLOCKER",
      scope: "FILING",
      jurisdiction: null,
      message: "Filing readiness covers United States individual returns only.",
      resolution: "This workspace's country is not one Countorra prepares returns for.",
      provenance: product("Only US jurisdictions have engines."),
    });
  }

  if (!currency) {
    add({
      code: "FILING_CURRENCY_UNSUPPORTED",
      severity: "BLOCKER",
      scope: "FILING",
      jurisdiction: null,
      message: "This workspace's currency isn't supported for tax figures.",
      resolution: "US returns are prepared in US dollars.",
      provenance: product("Engines refuse a currency mismatch."),
    });
  }

  if (preparationCase.status === "ARCHIVED") {
    add({
      code: "PREPARATION_ARCHIVED",
      severity: "BLOCKER",
      scope: "FILING",
      jurisdiction: null,
      message: "This tax year's preparation is archived.",
      resolution: "An archived preparation can't be finalized. Start a new preparation for the year.",
      related: { preparationCaseId: preparationCase.id },
      provenance: product("Archived preparation is closed."),
    });
  }

  // ── Preparation, relayed ────────────────────────────────────────────
  let evidenceGaps = 0;
  for (const issue of completeness.issues) {
    if (issue.id.startsWith("JURISDICTION_")) continue; // restated per state below
    if (issue.id.startsWith("DOCUMENT_POSSIBLY_REQUIRED:")) {
      evidenceGaps += 1;
      continue;
    }
    if (RESTATED_PREPARATION_ISSUES.has(issue.id)) continue;
    add(fromPreparationIssue(issue, preparationCase.id));
  }

  if (!preparationCase.taxpayer.taxIdentifierOnFile) {
    add({
      code: "TAXPAYER_IDENTIFIER_NOT_ON_FILE",
      severity: "WARNING",
      scope: "FILING",
      jurisdiction: null,
      message: "No SSN or ITIN is recorded as being on file for the taxpayer.",
      resolution: "A return is expected to need one. Countorra has not verified the 2026 requirement, does not collect the number, and does not block on it.",
      related: { affects: "taxpayer.taxIdentifier" },
      provenance: { kind: "FILING_REQUIREMENT_NOT_VERIFIED", requirementId: "FEDERAL_TAXPAYER_IDENTIFICATION_NUMBER" },
    });
  }

  if (evidenceGaps > 0) {
    add({
      code: "EVIDENCE_NOT_ATTACHED",
      severity: "INFO",
      scope: "FILING",
      jurisdiction: null,
      message: `${evidenceGaps} ${evidenceGaps === 1 ? "kind of figure has" : "kinds of figure have"} no supporting document attached.`,
      resolution: "Attach the W-2, 1099 or other document where there is one. The figures are used either way.",
      provenance: product("Evidence is recorded, not required."),
    });
  }

  // ── Facts the engines cannot turn into a figure ─────────────────────
  const confirmed = input.facts.filter((fact) => fact.state === "CONFIRMED");
  const confirmedKeys = [...new Set(confirmed.map((fact) => fact.key as string))].sort();

  for (const key of confirmedKeys) {
    if (!isKnownFactKey(key)) {
      add({
        code: `UNRECOGNISED_FACT:${key}`,
        severity: "BLOCKER",
        scope: "FILING",
        jurisdiction: null,
        message: "A confirmed figure has a type this version of Countorra doesn't recognise.",
        resolution: "Reject the figure and enter it again.",
        related: { affects: key },
        provenance: product("Every figure in a filing must be a recognised fact."),
      });
      continue;
    }

    const definition = factDefinition(key);
    if (definition.support !== "COLLECTED_NOT_CALCULATED") continue;

    if (DEDUCTION_KEYS.has(key)) {
      add({
        code: `DEDUCTION_NOT_APPLIED:${key}`,
        severity: "WARNING",
        scope: "FEDERAL",
        jurisdiction: "US_FEDERAL",
        message: `${definition.label} is recorded but not applied. Every figure uses the standard deduction.`,
        resolution: "If itemizing would be better, the prepared figures do not reflect it. Have that reviewed before relying on them.",
        related: { affects: key },
        provenance: product("Itemized deductions are not modelled."),
      });
      continue;
    }

    add({
      code: `INCOME_NOT_MODELLED:${key}`,
      severity: "BLOCKER",
      scope: "FEDERAL",
      jurisdiction: "US_FEDERAL",
      message: `${definition.label} is confirmed but no engine includes it, so the calculated tax leaves this income out.`,
      resolution: `A return that omits it would be wrong. ${definition.notModelledReason ?? ""} This return can't be finalized here while it is part of the year.`.trim(),
      related: { affects: key },
      provenance: product("Every confirmed income figure must reach the calculation."),
    });
  }

  const hasKey = (key: string) => confirmed.some((fact) => fact.key === key);
  if (hasKey("W2_WAGES") && hasKey("SELF_EMPLOYMENT_NET_PROFIT") && !hasKey("W2_SOCIAL_SECURITY_WAGES")) {
    add({
      code: "W2_SOCIAL_SECURITY_WAGES_MISSING",
      severity: "BLOCKER",
      scope: "FEDERAL",
      jurisdiction: "US_FEDERAL",
      message: "There are W-2 wages and self-employment income, but no W-2 Social Security wages (box 3).",
      resolution: "Enter box 3 from the W-2. Without it, self-employment tax is computed as if no wages had already reached the Social Security wage base.",
      related: { affects: "W2_SOCIAL_SECURITY_WAGES" },
      provenance: { kind: "TAX_ENGINE", jurisdiction: "US_FEDERAL", ruleSetVersion: null },
    });
  }

  // ── The stored calculation ──────────────────────────────────────────
  if (!latest || !calculation) {
    add({
      code: "CALCULATION_MISSING",
      severity: "BLOCKER",
      scope: "FILING",
      jurisdiction: null,
      message: "This year's figures haven't been calculated.",
      resolution: "Calculate on the Tax preparation page.",
      related: { preparationCaseId: preparationCase.id },
      provenance: product("Filing is prepared from a stored calculation."),
    });
  } else {
    const related = { preparationCaseId: preparationCase.id, preparationSnapshotId: latest.id };

    if (!input.calculationIsCurrent) {
      add({
        code: "CALCULATION_STALE",
        severity: "BLOCKER",
        scope: "FILING",
        jurisdiction: null,
        message: `Information changed after version ${latest.version} was calculated, so its figures no longer describe this return.`,
        resolution: "Calculate again on the Tax preparation page, then return here.",
        related,
        provenance: product("A filing uses the current calculation only."),
      });
    } else if (!liveInputsMatchFrozen(latest.snapshot, { preparationCase, facts: input.facts, dependents: input.dependents, jurisdictions: completeness.jurisdictions })) {
      add({
        code: "SNAPSHOT_INPUTS_OUTDATED",
        severity: "BLOCKER",
        scope: "FILING",
        jurisdiction: null,
        message: "The confirmed information differs from what the last calculation was given.",
        resolution: "Calculate again on the Tax preparation page so the figures match what is recorded.",
        related,
        provenance: product("Frozen inputs must equal the confirmed information."),
      });
    }

    if (latest.snapshot.taxYear !== preparationCase.taxYear || calculation.taxYear !== preparationCase.taxYear) {
      add({
        code: "CALCULATION_TAX_YEAR_MISMATCH",
        severity: "BLOCKER",
        scope: "FILING",
        jurisdiction: null,
        message: "The stored calculation is for a different tax year than this preparation.",
        resolution: "Calculate again on the Tax preparation page.",
        related,
        provenance: product("A calculation and its preparation share one tax year."),
      });
    }

    if (calculation.version !== latest.version || calculation.snapshotId !== latest.snapshot.id) {
      add({
        code: "CALCULATION_INTEGRITY_MISMATCH",
        severity: "BLOCKER",
        scope: "FILING",
        jurisdiction: null,
        message: "The stored calculation doesn't belong to the inputs it is stored with.",
        resolution: "Calculate again on the Tax preparation page.",
        related,
        provenance: product("A calculation must name the snapshot it was run on."),
      });
    }

    if (currency && calculation.currency !== currency) {
      add({
        code: "CALCULATION_CURRENCY_MISMATCH",
        severity: "BLOCKER",
        scope: "FILING",
        jurisdiction: null,
        message: "The stored calculation is in a different currency from this workspace.",
        resolution: "Calculate again on the Tax preparation page.",
        related,
        provenance: product("Figures and workspace share one currency."),
      });
    }

    if (currency) {
      for (const mismatch of verifyAgainstEngines(latest, calculation, currency)) {
        add({
          code: `CALCULATION_MISMATCH:${mismatch}`,
          severity: "BLOCKER",
          scope: "FILING",
          jurisdiction: mismatch === "REFUND" || mismatch === "JURISDICTIONS" ? null : (mismatch as TaxJurisdiction),
          message:
            mismatch === "REFUND"
              ? "The stored refund or balance-due statement doesn't match what the stored figures produce."
              : "The stored figures don't match what the supported tax rules produce from the same inputs today.",
          resolution: "Calculate again on the Tax preparation page. A stored figure that the engines don't reproduce is never filed.",
          related,
          provenance: { kind: "TAX_ENGINE", jurisdiction: mismatch === "REFUND" || mismatch === "JURISDICTIONS" ? "US_FEDERAL" : (mismatch as TaxJurisdiction), ruleSetVersion: null },
        });
      }
    }
  }

  // ── Federal ─────────────────────────────────────────────────────────
  const federalResult = calculation?.federal ?? null;
  const federalOutcome = federalResult?.outcome?.supported ? federalResult.outcome : null;

  if (federalResult && (federalResult.status !== "CALCULATED" || !federalOutcome)) {
    add({
      code: "FEDERAL_NOT_CALCULATED",
      severity: "BLOCKER",
      scope: "FEDERAL",
      jurisdiction: "US_FEDERAL",
      message: `No federal figure was produced. ${federalResult.message}`,
      resolution: "Resolve what the federal engine reports, then calculate again.",
      provenance: { kind: "TAX_ENGINE", jurisdiction: "US_FEDERAL", ruleSetVersion: null },
    });
  }

  if (federalOutcome && latest) {
    if (federalOutcome.taxYear !== FILING_TAX_YEAR || federalOutcome.requestedTaxYear !== FILING_TAX_YEAR || federalOutcome.calculationStatus !== "PUBLISHED_RULES") {
      add({
        code: "FEDERAL_RULES_NOT_2026",
        severity: "BLOCKER",
        scope: "FEDERAL",
        jurisdiction: "US_FEDERAL",
        message: `The federal figure was not computed under ${FILING_TAX_YEAR}'s own published rules.`,
        resolution: "Calculate again on the Tax preparation page.",
        provenance: { kind: "TAX_ENGINE", jurisdiction: "US_FEDERAL", ruleSetVersion: federalOutcome.ruleSetVersion },
      });
    }

    if (federalOutcome.inputs.filingStatus !== latest.snapshot.filingStatus) {
      add({
        code: "FEDERAL_FILING_STATUS_MISMATCH",
        severity: "BLOCKER",
        scope: "FEDERAL",
        jurisdiction: "US_FEDERAL",
        message: "The federal figure was computed for a different filing status than the one recorded.",
        resolution: "Calculate again on the Tax preparation page.",
        provenance: { kind: "TAX_ENGINE", jurisdiction: "US_FEDERAL", ruleSetVersion: federalOutcome.ruleSetVersion },
      });
    }

    add({
      code: "CREDITS_NOT_MODELLED",
      severity: "WARNING",
      scope: "FEDERAL",
      jurisdiction: "US_FEDERAL",
      message: "No tax credits are modelled. Every figure is tax before credits, and credits could lower it materially.",
      resolution: "Have any credits you may be entitled to reviewed before relying on these figures.",
      provenance: { kind: "TAX_ENGINE", jurisdiction: "US_FEDERAL", ruleSetVersion: federalOutcome.ruleSetVersion },
    });

    if (input.dependents.length > 0) {
      add({
        code: "DEPENDENT_CREDITS_NOT_MODELLED",
        severity: "WARNING",
        scope: "FEDERAL",
        jurisdiction: "US_FEDERAL",
        message: "Dependents are recorded, but no dependent-related credit is modelled or applied.",
        resolution: "Credits for dependents are not in any figure here. Have them reviewed.",
        provenance: { kind: "TAX_ENGINE", jurisdiction: "US_FEDERAL", ruleSetVersion: federalOutcome.ruleSetVersion },
      });
    }

    add({
      code: "FEDERAL_TAX_TABLE_NOT_MODELLED",
      severity: "WARNING",
      scope: "FEDERAL",
      jurisdiction: "US_FEDERAL",
      message: `Federal tax is computed from the verified ${FILING_TAX_YEAR} rate schedule. A filed return may compute it from a tax table instead, which can differ slightly.`,
      resolution: `Countorra has not verified the ${FILING_TAX_YEAR} tax-table requirement. Compare against the official instructions once they are published.`,
      provenance: { kind: "FILING_REQUIREMENT_NOT_VERIFIED", requirementId: "FEDERAL_2026_TAX_TABLE" },
    });
  }

  const refund = refundFrom(calculation);
  if (calculation && refund.status === "NOT_DETERMINABLE") {
    add({
      code: "REFUND_NOT_DETERMINABLE",
      severity: "WARNING",
      scope: "FEDERAL",
      jurisdiction: "US_FEDERAL",
      message: "No refund or balance due can be stated, because federal withholding and estimated payments are not recorded.",
      resolution: "Enter the federal tax withheld from each W-2 and any estimated payments, then calculate again.",
      provenance: product("A refund is never inferred from a liability alone."),
    });
  }

  // ── States ──────────────────────────────────────────────────────────
  const states = assessStates(input, calculation, add);

  // ── Requirements that inform and do not decide ──────────────────────
  const unverified = unverifiedRequirementIds();
  add({
    code: "FILING_REQUIREMENTS_NOT_VERIFIED",
    severity: "INFO",
    scope: "FILING",
    jurisdiction: null,
    message: `${unverified.length} filing requirements for ${FILING_TAX_YEAR} — identification numbers, signature, form lines, state returns — have not been verified against official ${FILING_TAX_YEAR} publications, so none is enforced or implied.`,
    resolution: "Electronic filing is not available in Countorra. Whoever files the return must meet the official requirements.",
    provenance: product("Unverified requirements are disclosed, never enforced."),
  });

  // ── Result ──────────────────────────────────────────────────────────
  const sorted = issues.sort(compareIssues);
  const outsideStateBlocked = sorted.some((issue) => issue.severity === "BLOCKER" && issue.scope !== "STATE");
  const stateNotReady = states.some((state) => state.readiness === "NOT_READY" || state.readiness === "NOT_SUPPORTED");
  // A REVIEW issue concerns the return as a whole — the filing status decides
  // every jurisdiction's figure — so no scope, federal-only included, survives it.
  const reviewOpen = sorted.some((issue) => issue.severity === "REVIEW");

  let status: ReadinessStatus;
  if (notSupported) status = "NOT_SUPPORTED";
  else if (outsideStateBlocked) status = "BLOCKED";
  else if (reviewOpen || stateNotReady) status = "REVIEW_REQUIRED";
  else status = "READY";

  const finalizableScope = status === "READY" ? "FULL" : status === "REVIEW_REQUIRED" && !reviewOpen ? "FEDERAL_ONLY" : null;

  const federalCodes = sorted.filter((issue) => issue.scope !== "STATE").map((issue) => issue.code);

  return {
    engineVersion: READINESS_ENGINE_VERSION,
    taxYear: input.filingTaxYear,
    status,
    finalizableScope,
    federal: {
      jurisdiction: "US_FEDERAL",
      stateCode: null,
      label: jurisdictionName("US_FEDERAL"),
      readiness: outsideStateBlocked || notSupported || reviewOpen ? "NOT_READY" : "READY",
      resultStatus: federalResult?.status ?? null,
      ruleSet: federalOutcome
        ? { taxYear: federalOutcome.taxYear, requestedTaxYear: federalOutcome.requestedTaxYear, version: federalOutcome.ruleSetVersion, calculationStatus: federalOutcome.calculationStatus }
        : null,
      issueCodes: federalCodes,
    },
    states,
    issues: sorted,
    refund,
    preparation: {
      caseId: preparationCase.id,
      caseVersion: preparationCase.currentVersion,
      snapshotId: latest?.id ?? null,
      snapshotVersion: latest?.version ?? null,
      calculationCurrent: input.calculationIsCurrent,
    },
    unverifiedRequirementIds: unverified,
  };
}

// ── Preparation issues ────────────────────────────────────────────────

function fromPreparationIssue(issue: PreparationIssue, preparationCaseId: string): FilingIssue {
  const provenance: FilingIssueProvenance = { kind: "PREPARATION_COMPLETENESS", preparationIssueId: issue.id };
  const related = { affects: issue.affects ?? undefined, preparationCaseId };
  const base = { jurisdiction: null, message: issue.message, resolution: issue.resolution, related, provenance };

  if (issue.id === "FILING_STATUS_MISSING") return { ...base, code: "FILING_STATUS_MISSING", severity: "BLOCKER", scope: "FILING" };
  if (issue.id === "PROPOSED_FACTS_PENDING") {
    return {
      ...base,
      code: "PROPOSED_FACTS_UNREVIEWED",
      severity: "BLOCKER",
      scope: "FILING",
      resolution: "Confirm or reject every suggested figure first. A return is never finalized with suggestions silently left out.",
    };
  }
  if (issue.blocking) return { ...base, code: `PREPARATION_BLOCKER:${issue.id}`, severity: "BLOCKER", scope: "FILING" };
  if (issue.severity === "ERROR") return { ...base, code: `PREPARATION_ERROR:${issue.id}`, severity: "BLOCKER", scope: "FILING" };
  if (issue.category === "CONFLICT" || issue.id === "DEPENDENT_CLAIMED_ELSEWHERE") {
    return { ...base, code: `UNRESOLVED_CONFLICT:${issue.id}`, severity: "BLOCKER", scope: "FILING" };
  }
  if (issue.id === "ENTITY_RETURN_NOT_SUPPORTED") return { ...base, code: "ENTITY_RETURN_NOT_PREPARED", severity: "WARNING", scope: "FILING" };
  // Calculated, never qualified. Relayed as REVIEW, which leaves nothing
  // finalizable: a disclosed WARNING would let a person acknowledge their way
  // past a qualification test nobody has checked.
  if (issue.id === "FILING_STATUS_REVIEW_REQUIRED") {
    return {
      ...base,
      code: "FILING_STATUS_QUALIFICATION_NOT_DETERMINED",
      severity: "REVIEW",
      scope: "FEDERAL",
      jurisdiction: "US_FEDERAL",
      resolution: "Countorra calculates this filing status but doesn't determine whether the taxpayer qualifies for it. Have qualification reviewed by a qualified tax professional. Nothing can be finalized here while it is undetermined.",
    };
  }
  if (issue.id === "MFS_SPOUSE_ITEMIZING_UNKNOWN") {
    return { ...base, code: "MFS_SPOUSE_ITEMIZING_NOT_DETERMINED", severity: "REVIEW", scope: "FEDERAL", jurisdiction: "US_FEDERAL" };
  }
  if (issue.severity === "WARNING") return { ...base, code: `PREPARATION_WARNING:${issue.id}`, severity: "WARNING", scope: "FILING" };
  return { ...base, code: `PREPARATION_NOTE:${issue.id}`, severity: "INFO", scope: "FILING" };
}

// ── Engine verification ───────────────────────────────────────────────

/**
 * Re-runs the deterministic engines on the frozen inputs and names every
 * jurisdiction whose stored classification or figure differs. Timestamps are
 * not compared; everything that decides what a person is told is.
 */
function verifyAgainstEngines(latest: FrozenPreparation, stored: PreparationCalculation, currency: CurrencyCode): readonly string[] {
  let rerun: PreparationCalculation;
  try {
    const outcome = runPreparationCalculation({ snapshot: latest.snapshot, currency, calculatedAt: stored.calculatedAt, blockers: [] });
    if (!outcome.ran) return ["JURISDICTIONS"];
    rerun = outcome.calculation;
  } catch {
    return ["JURISDICTIONS"];
  }

  const mismatches: string[] = [];
  const storedAll = [stored.federal, ...stored.states];
  const rerunAll = [rerun.federal, ...rerun.states];

  if (storedAll.map((result) => result.jurisdiction).join() !== rerunAll.map((result) => result.jurisdiction).join()) return ["JURISDICTIONS"];

  for (let index = 0; index < storedAll.length; index += 1) {
    if (signature(storedAll[index]) !== signature(rerunAll[index])) mismatches.push(storedAll[index].jurisdiction);
  }

  if (stored.federalRefund.status !== rerun.federalRefund.status || stored.federalRefund.amountMinor !== rerun.federalRefund.amountMinor) mismatches.push("REFUND");
  return mismatches;
}

function signature(result: JurisdictionResult): string {
  const outcome = result.outcome;
  return JSON.stringify([
    result.jurisdiction,
    result.status,
    result.totalTaxMinor,
    outcome?.supported ? [outcome.taxYear, outcome.requestedTaxYear, outcome.calculationStatus, outcome.calculationMethod, outcome.ruleSetVersion] : outcome ? [outcome.reason] : null,
  ]);
}

// ── Refund ────────────────────────────────────────────────────────────

function refundFrom(calculation: PreparationCalculation | null): FilingReadiness["refund"] {
  if (!calculation) return { status: "NOT_DETERMINABLE", amountMinor: null, explanation: "No calculation exists, so no refund or balance due can be stated." };
  const { federalRefund } = calculation;
  if (federalRefund.status === "REFUND_EXPECTED" && federalRefund.amountMinor !== null) return { status: "REFUND", amountMinor: federalRefund.amountMinor, explanation: federalRefund.explanation };
  if (federalRefund.status === "BALANCE_DUE" && federalRefund.amountMinor !== null) return { status: "BALANCE_DUE", amountMinor: federalRefund.amountMinor, explanation: federalRefund.explanation };
  return { status: "NOT_DETERMINABLE", amountMinor: null, explanation: federalRefund.explanation };
}

// ── States ────────────────────────────────────────────────────────────

function assessStates(
  input: FilingReadinessInput,
  calculation: PreparationCalculation | null,
  add: (issue: Omit<FilingIssue, "related"> & { related?: FilingIssue["related"] }) => void,
): JurisdictionReadiness[] {
  const { taxpayer } = input.preparationCase;
  const primary = taxpayer.primaryStateRegion;
  const additional = [...new Set(taxpayer.additionalStateRegions.filter((code) => code !== primary))].sort();
  const components: JurisdictionReadiness[] = [];

  if (!primary) {
    add({
      code: "STATE_NOT_SET",
      severity: "BLOCKER",
      scope: "STATE",
      jurisdiction: null,
      message: "No state is set for this workspace, so no state position has been considered.",
      resolution: "Set the workspace's state in Settings and calculate again. The federal return can still be finalized on its own.",
      related: { affects: "organization.stateRegion" },
      provenance: product("A state component needs a state."),
    });
    components.push({ jurisdiction: null, stateCode: null, label: "State", readiness: "NOT_READY", resultStatus: null, ruleSet: null, issueCodes: ["STATE_NOT_SET"] });
  } else {
    components.push(assessPrimaryState(input, calculation, primary, additional.length > 0, add));
  }

  for (const code of additional) {
    const jurisdiction = stateJurisdictionFor(input.organization.country, code);
    components.push({
      jurisdiction,
      stateCode: code,
      label: jurisdiction ? jurisdictionName(jurisdiction) : code,
      readiness: jurisdiction ? "NOT_READY" : "NOT_SUPPORTED",
      resultStatus: null,
      ruleSet: null,
      issueCodes: ["STATE_ALLOCATION_REQUIRED"],
    });
  }

  if (additional.length > 0) {
    add({
      code: "STATE_ALLOCATION_REQUIRED",
      severity: "BLOCKER",
      scope: "STATE",
      jurisdiction: null,
      message: `Income or residency in more than one state (${[primary, ...additional].filter(Boolean).join(", ")}) needs allocation between them, which Countorra does not do.`,
      resolution: "No state return can be treated as ready while allocation is unresolved. The federal return can still be finalized on its own.",
      related: { affects: "taxpayer.additionalStateRegions" },
      provenance: product("Multi-state allocation is not implemented."),
    });
  }

  return components;
}

function assessPrimaryState(
  input: FilingReadinessInput,
  calculation: PreparationCalculation | null,
  code: string,
  allocationRequired: boolean,
  add: (issue: Omit<FilingIssue, "related"> & { related?: FilingIssue["related"] }) => void,
): JurisdictionReadiness {
  const jurisdiction = stateJurisdictionFor(input.organization.country, code);
  const codes: string[] = [];
  const raise = (issue: Omit<FilingIssue, "related"> & { related?: FilingIssue["related"] }) => {
    codes.push(issue.code);
    add(issue);
  };

  if (!jurisdiction) {
    raise({
      code: `STATE_NOT_SUPPORTED:${code}`,
      severity: "BLOCKER",
      scope: "STATE",
      jurisdiction: null,
      message: `Countorra has no tax rules for ${code}, so nothing about a ${code} return is prepared.`,
      resolution: "The federal return can still be finalized on its own. A state return for this state needs separate preparation.",
      related: { affects: "organization.stateRegion" },
      provenance: product("Only modelled states are prepared."),
    });
    return { jurisdiction: null, stateCode: code, label: code, readiness: "NOT_SUPPORTED", resultStatus: null, ruleSet: null, issueCodes: codes };
  }

  const name = jurisdictionName(jurisdiction);
  const result = calculation?.states.find((state) => state.jurisdiction === jurisdiction) ?? null;
  const outcome = result?.outcome?.supported ? result.outcome : null;
  const ruleSet = outcome ? { taxYear: outcome.taxYear, requestedTaxYear: outcome.requestedTaxYear, version: outcome.ruleSetVersion, calculationStatus: outcome.calculationStatus } : null;
  const engine = { kind: "TAX_ENGINE" as const, jurisdiction, ruleSetVersion: outcome?.ruleSetVersion ?? null };

  let readiness: ComponentReadiness;

  if (!result) {
    raise({
      code: `STATE_NOT_CALCULATED:${jurisdiction}`,
      severity: "BLOCKER",
      scope: "STATE",
      jurisdiction,
      message: `No ${name} result is part of the stored calculation.`,
      resolution: "Calculate again on the Tax preparation page.",
      provenance: product("A state component needs its own stored result."),
    });
    readiness = "NOT_READY";
  } else if (result.status === "ESTIMATE") {
    raise({
      code: `STATE_ESTIMATE_ONLY:${jurisdiction}`,
      severity: "BLOCKER",
      scope: "STATE",
      jurisdiction,
      message: `${name}'s ${FILING_TAX_YEAR} figure is an estimate under ${ruleSet?.taxYear ?? "another year's"} published rules, not a ${FILING_TAX_YEAR} calculation, so it can't be treated as ready for filing. ${result.message}`,
      resolution: `This stays an estimate until ${name} publishes its complete ${FILING_TAX_YEAR} rules. The federal return can still be finalized on its own.`,
      provenance: engine,
    });
    readiness = "NOT_READY";
  } else if (result.status === "BLOCKED") {
    raise({
      code: `STATE_RULES_NOT_PUBLISHED:${jurisdiction}`,
      severity: "BLOCKER",
      scope: "STATE",
      jurisdiction,
      message: result.message,
      resolution: `No ${name} figure exists, and none is estimated or assumed to be zero. The federal return can still be finalized on its own.`,
      provenance: engine,
    });
    readiness = "NOT_READY";
  } else if (result.status !== "CALCULATED" || !outcome) {
    raise({
      code: `STATE_CALCULATION_UNSUPPORTED:${jurisdiction}`,
      severity: "BLOCKER",
      scope: "STATE",
      jurisdiction,
      message: result.message,
      resolution: `This ${name} situation isn't supported. The federal return can still be finalized on its own.`,
      provenance: engine,
    });
    readiness = "NOT_SUPPORTED";
  } else if (outcome.calculationMethod === "NO_INDIVIDUAL_INCOME_TAX") {
    raise({
      code: `NO_INDIVIDUAL_INCOME_TAX_RETURN:${jurisdiction}`,
      severity: "INFO",
      scope: "STATE",
      jurisdiction,
      message: `${name} levies no individual income tax, so there is no ${name} individual income-tax return. Countorra files nothing for ${name}. Other ${name} taxes — sales, property, franchise or business taxes — are not covered.`,
      resolution: "Nothing to prepare for an individual income-tax return in this state.",
      provenance: engine,
    });
    if (outcome.ruleSet.sources.some((source) => source.verification === "SOURCE_UNVERIFIED_ENVIRONMENT")) {
      raise({
        code: `STATE_SOURCES_UNVERIFIED:${jurisdiction}`,
        severity: "WARNING",
        scope: "STATE",
        jurisdiction,
        message: `The sources for ${name}'s no-income-tax rule could not be opened from Countorra's environment, so the citation is recorded as unverified.`,
        resolution: "The rule itself is long-established; the citation has simply not been confirmed first-hand.",
        provenance: engine,
      });
    }
    readiness = "NOT_APPLICABLE";
  } else {
    readiness = "READY";

    if (outcome.taxYear !== FILING_TAX_YEAR || outcome.requestedTaxYear !== FILING_TAX_YEAR || outcome.calculationStatus !== "PUBLISHED_RULES") {
      raise({
        code: `STATE_RULES_NOT_2026:${jurisdiction}`,
        severity: "BLOCKER",
        scope: "STATE",
        jurisdiction,
        message: `The ${name} figure was not computed under ${FILING_TAX_YEAR}'s own published rules.`,
        resolution: "Calculate again on the Tax preparation page.",
        provenance: engine,
      });
      readiness = "NOT_READY";
    }

    // New York's 2026 rule set declares its return tax table unpublished
    // (`taxTable: null`), in its own verified data. Read from the rule set, not
    // re-stated here with a threshold of its own.
    if (jurisdiction === "US_NY" && findRuleSet("US_NY", FILING_TAX_YEAR)?.taxTable === null) {
      raise({
        code: "NY_TAX_TABLE_NOT_PUBLISHED",
        severity: "WARNING",
        scope: "STATE",
        jurisdiction,
        message: "New York has not published a 2026 tax table. The New York figure uses the 2026 rate schedules, and a filed return that must use the table may differ slightly.",
        resolution: "Compare against the official New York tax table once it is published.",
        provenance: engine,
      });
      raise({
        code: "NY_LOCAL_TAXES_NOT_ASSESSED",
        severity: "WARNING",
        scope: "STATE",
        jurisdiction,
        message: "New York City and Yonkers income taxes, the MCTMT, and part-year or nonresident situations are not modelled, and residency within New York is not collected.",
        resolution: "If any of these apply, the New York figures are incomplete. Have them reviewed.",
        provenance: engine,
      });
    }

    raise({
      code: `STATE_REFUND_NOT_CALCULATED:${jurisdiction}`,
      severity: "WARNING",
      scope: "STATE",
      jurisdiction,
      message: `A ${name} refund or balance due is not calculated; only the ${name} tax before credits is.`,
      resolution: `State withholding and estimated payments are listed in the package but not netted against the ${name} figure.`,
      provenance: product("State refund statements are not modelled."),
    });
  }

  if (allocationRequired && readiness !== "NOT_APPLICABLE" && readiness !== "NOT_SUPPORTED") {
    codes.push("STATE_ALLOCATION_REQUIRED");
    readiness = "NOT_READY";
  }

  return { jurisdiction, stateCode: input.preparationCase.taxpayer.primaryStateRegion, label: name, readiness, resultStatus: result?.status ?? null, ruleSet, issueCodes: codes };
}

function compareIssues(a: FilingIssue, b: FilingIssue): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
    (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) ||
    (a.related?.affects ?? "").localeCompare(b.related?.affects ?? "")
  );
}
