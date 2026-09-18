import { factDefinition } from "./facts";
import type { PreparationDependent, PreparationIssue, TaxFact, TaxpayerProfile } from "./types";
import type { FilingStatus } from "@/domain/tax/rules/types";

/**
 * DETERMINISTIC VALIDATION.
 *
 * Only things the system can be sure about. There is no legal reasoning here
 * — no deciding whether someone qualifies as head of household, no deciding
 * whether a dependent earns a credit. Those need a human, and a rule that
 * guessed at them would be confidently wrong in the cases that matter most.
 *
 * What this does check is arithmetic, shape, internal contradiction and
 * duplication: the failures a computer can see and a tired person cannot.
 */

const FILING_STATUSES: readonly FilingStatus[] = [
  "single",
  "married_filing_jointly",
  "married_filing_separately",
  "head_of_household",
  "qualifying_surviving_spouse",
];

/** Statuses that imply a spouse exists. */
const MARRIED_STATUSES: readonly FilingStatus[] = ["married_filing_jointly", "married_filing_separately"];

/** Statuses whose qualification tests are beyond what this product decides. */
const REVIEW_REQUIRED_STATUSES: readonly FilingStatus[] = ["head_of_household", "qualifying_surviving_spouse"];

export interface ValidationInput {
  taxYear: number;
  filingStatus: FilingStatus | null;
  taxpayer: TaxpayerProfile;
  dependents: readonly PreparationDependent[];
  /** Confirmed and proposed alike — validation looks at everything. */
  facts: readonly TaxFact[];
}

export function validatePreparation(input: ValidationInput): readonly PreparationIssue[] {
  return [
    ...validateFilingStatus(input),
    ...validateTaxpayer(input),
    ...validateFacts(input),
    ...validateWageConsistency(input),
    ...validateDuplicates(input),
    ...validateDependents(input),
    ...validateStates(input),
    ...validateDocumentFigures(input),
  ];
}

/**
 * Two different figures for the same item, from the same document.
 *
 * Happens when a figure typed from a W-2 disagrees with the value read from
 * that W-2, or when the document was read again and a value changed. Neither
 * is chosen: a CONFLICT stays until a person rejects or withdraws the wrong
 * one. Different documents (two W-2s from two jobs) are not a conflict.
 */
function validateDocumentFigures({ facts }: ValidationInput): PreparationIssue[] {
  const groups = new Map<string, Set<string>>();
  for (const fact of facts) {
    if (fact.state === "REJECTED" || !fact.evidenceDocumentId || fact.amountMinor === null) continue;
    const key = `${fact.key}|${fact.evidenceDocumentId}`;
    groups.set(key, (groups.get(key) ?? new Set()).add(`${fact.amountMinor}|${fact.currency ?? ""}`));
  }

  const issues: PreparationIssue[] = [];
  for (const [group, amounts] of groups) {
    if (amounts.size < 2) continue;
    const [key] = group.split("|");
    issues.push({
      id: "DOCUMENT_FIGURES_DISAGREE",
      severity: "WARNING",
      category: "CONFLICT",
      message: `${factDefinition(key as never).label} has ${amounts.size} different figures from the same document.`,
      affects: key,
      blocking: false,
      resolution: "Reject or withdraw the figure that's wrong. Countorra doesn't choose between them.",
    });
  }
  return issues;
}

function validateFilingStatus({ filingStatus, taxpayer }: ValidationInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];

  if (!filingStatus) {
    issues.push({
      id: "FILING_STATUS_MISSING",
      severity: "BLOCKER",
      category: "FILING_STATUS",
      message: "A filing status is needed before any tax can be calculated.",
      affects: "filingStatus",
      blocking: true,
      resolution: "Choose the filing status for this tax year.",
    });
    return issues;
  }

  if (!FILING_STATUSES.includes(filingStatus)) {
    issues.push({
      id: "FILING_STATUS_INVALID",
      severity: "BLOCKER",
      category: "FILING_STATUS",
      message: "That filing status isn't one this product supports.",
      affects: "filingStatus",
      blocking: true,
      resolution: "Choose one of the five federal filing statuses.",
    });
    return issues;
  }

  // A contradiction the system CAN see: a married status with no spouse
  // recorded at all. Not a blocker — the spouse fields may simply be next on
  // the list — but it must not pass silently either.
  if (MARRIED_STATUSES.includes(filingStatus) && !taxpayer.spouseFirstName && !taxpayer.spouseLastName) {
    issues.push({
      id: "SPOUSE_DETAILS_MISSING",
      severity: "ERROR",
      category: "FILING_STATUS",
      message: "This filing status is for married taxpayers, but no spouse details have been entered.",
      affects: "taxpayer.spouse",
      blocking: false,
      resolution: "Add the spouse's name and date of birth, or change the filing status.",
    });
  }

  if (!MARRIED_STATUSES.includes(filingStatus) && filingStatus !== "qualifying_surviving_spouse" && taxpayer.spouseFirstName) {
    issues.push({
      id: "SPOUSE_DETAILS_UNEXPECTED",
      severity: "WARNING",
      category: "FILING_STATUS",
      message: "Spouse details are recorded, but the chosen filing status is not a married one.",
      affects: "taxpayer.spouse",
      blocking: false,
      resolution: "Confirm the filing status, or remove the spouse details if they were entered by mistake.",
    });
  }

  // The honest answer for the two statuses with real qualification tests.
  // Collect the facts, flag for review, decide nothing.
  if (REVIEW_REQUIRED_STATUSES.includes(filingStatus)) {
    issues.push({
      id: "FILING_STATUS_REVIEW_REQUIRED",
      severity: "WARNING",
      category: "FILING_STATUS",
      message:
        filingStatus === "head_of_household"
          ? "Head of household has qualification tests — a qualifying person, and paying more than half the cost of keeping up a home — that Countorra does not decide."
          : "Qualifying surviving spouse has qualification tests that depend on the year of a spouse's death and on a dependent child, which Countorra does not decide.",
      affects: "filingStatus",
      blocking: false,
      resolution: "The calculation will use this status. Have it reviewed by a qualified tax professional before relying on it.",
    });
  }

  // Married filing separately and the standard deduction. IRS Topic 551: a
  // married individual filing separately whose spouse itemizes deductions is
  // not entitled to the standard deduction — and the standard deduction is the
  // only one the engines apply. The answer is recorded by a person; it is
  // never inferred from anything else on the case.
  if (filingStatus === "married_filing_separately") {
    if (taxpayer.spouseItemizesDeductions === true) {
      issues.push({
        id: "MFS_STANDARD_DEDUCTION_NOT_ALLOWED",
        severity: "BLOCKER",
        category: "FILING_STATUS",
        message:
          "When filing separately and the spouse itemizes deductions, the standard deduction isn't allowed. Countorra only applies the standard deduction, so it can't calculate this return.",
        affects: "taxpayer.spouseItemizesDeductions",
        blocking: true,
        resolution: "No federal figure is produced for this situation. A return with itemized deductions needs separate preparation.",
      });
    } else if (taxpayer.spouseItemizesDeductions === null) {
      issues.push({
        id: "MFS_SPOUSE_ITEMIZING_UNKNOWN",
        severity: "WARNING",
        category: "FILING_STATUS",
        message:
          "When filing separately, the standard deduction isn't allowed if the spouse itemizes deductions. Whether the spouse itemizes hasn't been recorded.",
        affects: "taxpayer.spouseItemizesDeductions",
        blocking: false,
        resolution: "Answer “Spouse itemizes deductions” in the taxpayer details. Until then the calculation applies the standard deduction, which may not be allowed.",
      });
    }
  }

  return issues;
}

function validateTaxpayer({ taxpayer, filingStatus }: ValidationInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];

  if (!taxpayer.legalFirstName || !taxpayer.legalLastName) {
    issues.push({
      id: "TAXPAYER_NAME_MISSING",
      severity: "ERROR",
      category: "TAXPAYER",
      message: "The taxpayer's legal first and last name are needed.",
      affects: "taxpayer.name",
      blocking: false,
      resolution: "Enter the name exactly as it appears on the taxpayer's Social Security card.",
    });
  }

  if (taxpayer.dateOfBirth && !isPlausibleDate(taxpayer.dateOfBirth)) {
    issues.push({
      id: "TAXPAYER_DOB_IMPLAUSIBLE",
      severity: "ERROR",
      category: "TAXPAYER",
      message: "That date of birth isn't a usable date.",
      affects: "taxpayer.dateOfBirth",
      blocking: false,
      resolution: "Check the date of birth.",
    });
  }

  if (!taxpayer.taxIdentifierOnFile) {
    // Not a blocker for PREPARATION — a person can organise everything else
    // first. It would be a blocker for filing, which this product does not do.
    issues.push({
      id: "TAXPAYER_IDENTIFIER_NOT_ON_FILE",
      severity: "INFO",
      category: "TAXPAYER",
      message: "No taxpayer identification number is recorded as being on file.",
      affects: "taxpayer.taxIdentifier",
      blocking: false,
      resolution: "Countorra records only whether an SSN or ITIN exists, never the number itself. A return would need the number.",
    });
  }

  if (filingStatus && MARRIED_STATUSES.includes(filingStatus) && taxpayer.spouseDateOfBirth && !isPlausibleDate(taxpayer.spouseDateOfBirth)) {
    issues.push({
      id: "SPOUSE_DOB_IMPLAUSIBLE",
      severity: "ERROR",
      category: "TAXPAYER",
      message: "The spouse's date of birth isn't a usable date.",
      affects: "taxpayer.spouseDateOfBirth",
      blocking: false,
      resolution: "Check the date of birth.",
    });
  }

  return issues;
}

function validateFacts({ facts, taxYear }: ValidationInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];

  for (const fact of facts) {
    if (fact.state === "REJECTED") continue;
    const definition = factDefinition(fact.key);

    if (definition.monetary) {
      if (fact.amountMinor === null) {
        issues.push(factIssue(fact.key, "FACT_AMOUNT_MISSING", "ERROR", `${definition.label} has no amount.`, "Enter the amount, or remove the entry."));
        continue;
      }
      // Integer minor units, per the project's money rule. A float here would
      // silently lose cents on the way to the engine.
      if (!Number.isSafeInteger(fact.amountMinor)) {
        issues.push(
          factIssue(fact.key, "FACT_AMOUNT_NOT_INTEGER", "ERROR", `${definition.label} isn't a usable amount.`, "Amounts are held in whole cents. Re-enter the figure."),
        );
        continue;
      }
      if (fact.amountMinor < 0 && !definition.allowsNegative) {
        issues.push(
          factIssue(
            fact.key,
            "FACT_AMOUNT_NEGATIVE",
            "ERROR",
            `${definition.label} can't be negative.`,
            "Check the figure against the document it came from.",
          ),
        );
      }
    }

    if (fact.source === "DOCUMENT" && !fact.evidenceDocumentId) {
      issues.push(
        factIssue(
          fact.key,
          "FACT_DOCUMENT_EVIDENCE_MISSING",
          "ERROR",
          `${definition.label} is recorded as coming from a document, but no document is linked.`,
          "Link the document it came from, or change the source to manual entry.",
        ),
      );
    }

    // An AI-proposed value that reached CONFIRMED without a person is the
    // failure this whole layer exists to prevent. It cannot happen through
    // the workflow, so if it appears it is a defect worth shouting about.
    if (fact.source === "AI_PROPOSED" && fact.state === "CONFIRMED" && !fact.createdBy) {
      issues.push(
        factIssue(
          fact.key,
          "FACT_AI_CONFIRMED_WITHOUT_REVIEWER",
          "BLOCKER",
          `${definition.label} was proposed automatically and marked confirmed with no reviewer recorded.`,
          "Review the value against its source and confirm it explicitly.",
        ),
      );
    }

    if (!Number.isInteger(taxYear)) {
      issues.push(factIssue(fact.key, "FACT_TAX_YEAR_INVALID", "BLOCKER", "The tax year on this case isn't usable.", "Reopen the case with a supported tax year."));
    }
  }

  return issues;
}

/**
 * The one cross-fact arithmetic rule the federal engine already enforces,
 * surfaced here where a person can still fix it.
 *
 * Box 5 includes everything box 3 does and more — box 3 stops at the Social
 * Security wage base, box 5 never does — so box 5 below box 3 means the two
 * were transposed. The engine would reject it; catching it during collection
 * is far more useful.
 */
function validateWageConsistency({ facts }: ValidationInput): PreparationIssue[] {
  const socialSecurity = sumConfirmable(facts, "W2_SOCIAL_SECURITY_WAGES");
  const medicare = sumConfirmable(facts, "W2_MEDICARE_WAGES");
  if (socialSecurity === null || medicare === null) return [];
  if (medicare >= socialSecurity) return [];

  return [
    {
      id: "W2_MEDICARE_BELOW_SOCIAL_SECURITY",
      severity: "ERROR",
      category: "INCOME",
      message: "W-2 Medicare wages (box 5) are lower than Social Security wages (box 3), which cannot be right.",
      affects: "W2_MEDICARE_WAGES",
      blocking: false,
      resolution: "Box 5 is never smaller than box 3. Check whether the two boxes were entered the wrong way round.",
    },
  ];
}

/**
 * Duplicates, flagged and never merged.
 *
 * Two W-2s is normal — two jobs. The same DOCUMENT feeding the same fact key
 * twice is not; that is an import run twice. Neither is auto-resolved:
 * deleting one of a person's income records on a guess is worse than asking.
 */
function validateDuplicates({ facts }: ValidationInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const seen = new Map<string, number>();

  for (const fact of facts) {
    if (fact.state === "REJECTED" || !fact.evidenceDocumentId) continue;
    const signature = `${fact.key}:${fact.evidenceDocumentId}`;
    seen.set(signature, (seen.get(signature) ?? 0) + 1);
  }

  for (const [signature, count] of seen) {
    if (count < 2) continue;
    const [key] = signature.split(":");
    issues.push({
      id: "DUPLICATE_FACT_FROM_DOCUMENT",
      severity: "WARNING",
      category: "CONFLICT",
      message: `The same document has produced ${count} entries for ${factDefinition(key as never).label}.`,
      affects: key,
      blocking: false,
      resolution: "Check whether the document was entered or imported twice, then reject the duplicate. Nothing is removed automatically.",
    });
  }

  return issues;
}

function validateDependents({ dependents }: ValidationInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const names = new Map<string, number>();

  for (const dependent of dependents) {
    const label = `${dependent.firstName} ${dependent.lastName}`.trim();
    names.set(label.toLowerCase(), (names.get(label.toLowerCase()) ?? 0) + 1);

    if (dependent.dateOfBirth && !isPlausibleDate(dependent.dateOfBirth)) {
      issues.push({
        id: "DEPENDENT_DOB_IMPLAUSIBLE",
        severity: "ERROR",
        category: "DEPENDENTS",
        message: `${label || "A dependent"} has a date of birth that isn't a usable date.`,
        affects: `dependent:${dependent.id}`,
        blocking: false,
        resolution: "Check the date of birth.",
      });
    }

    if (dependent.monthsLivedWithTaxpayer !== null && (dependent.monthsLivedWithTaxpayer < 0 || dependent.monthsLivedWithTaxpayer > 12)) {
      issues.push({
        id: "DEPENDENT_MONTHS_OUT_OF_RANGE",
        severity: "ERROR",
        category: "DEPENDENTS",
        message: `${label || "A dependent"} has a months-lived-with figure outside 0 to 12.`,
        affects: `dependent:${dependent.id}`,
        blocking: false,
        resolution: "Enter the number of months in the tax year, between 0 and 12.",
      });
    }

    if (dependent.claimedByAnother) {
      issues.push({
        id: "DEPENDENT_CLAIMED_ELSEWHERE",
        severity: "WARNING",
        category: "DEPENDENTS",
        message: `${label || "A dependent"} is marked as claimed by another person.`,
        affects: `dependent:${dependent.id}`,
        blocking: false,
        resolution: "Two people cannot claim the same dependent. Have this reviewed before the return is prepared.",
      });
    }
  }

  for (const [name, count] of names) {
    if (count < 2 || !name) continue;
    issues.push({
      id: "DUPLICATE_DEPENDENT",
      severity: "WARNING",
      category: "CONFLICT",
      message: `${count} dependents share the same name.`,
      affects: "dependents",
      blocking: false,
      resolution: "Check whether the same person was entered twice. Nothing is removed automatically.",
    });
  }

  return issues;
}

function validateStates({ taxpayer }: ValidationInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const primary = taxpayer.primaryStateRegion;
  const additional = taxpayer.additionalStateRegions;

  if (primary && additional.includes(primary)) {
    issues.push({
      id: "STATE_LISTED_TWICE",
      severity: "WARNING",
      category: "STATE",
      message: "The primary state also appears in the list of additional states.",
      affects: "taxpayer.additionalStateRegions",
      blocking: false,
      resolution: "Remove it from the additional states list.",
    });
  }

  // Multi-state allocation is genuinely not implemented, and a figure that
  // ignored it would be wrong rather than approximate.
  if (additional.length > 0) {
    issues.push({
      id: "MULTI_STATE_REVIEW_REQUIRED",
      severity: "WARNING",
      category: "STATE",
      message: "Income or residency in more than one state needs allocation between them, which Countorra does not do.",
      affects: "taxpayer.additionalStateRegions",
      blocking: false,
      resolution: "Only the primary state is calculated. Have the multi-state position reviewed by a qualified tax professional.",
    });
  }

  return issues;
}

// ── helpers ───────────────────────────────────────────────────────────

function factIssue(key: string, id: string, severity: PreparationIssue["severity"], message: string, resolution: string): PreparationIssue {
  return { id, severity, category: "INCOME", message, affects: key, blocking: severity === "BLOCKER", resolution };
}

/** Total of the non-rejected facts for a key, or null when there are none. */
function sumConfirmable(facts: readonly TaxFact[], key: TaxFact["key"]): number | null {
  const matching = facts.filter((fact) => fact.key === key && fact.state !== "REJECTED" && fact.amountMinor !== null);
  if (matching.length === 0) return null;
  return matching.reduce((total, fact) => total + (fact.amountMinor ?? 0), 0);
}

function isPlausibleDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;

  // Round-trip, because parsing alone is not a check. When V8's strict ISO
  // parser rejects a string it falls back to a lenient one, which rolls
  // 2026-02-30 forward to 2026-03-02 and hands back a perfectly valid Date —
  // so a mistyped birthday would pass as real. Comparing the parsed date back
  // against the digits that were typed is what actually catches it.
  if (parsed.toISOString().slice(0, 10) !== value) return false;

  const year = parsed.getUTCFullYear();
  // Wide but finite: rejects typos like 0202 and 3025 without pretending to
  // know how old a taxpayer can be.
  return year >= 1900 && year <= 2200;
}

export { isPlausibleDate };
