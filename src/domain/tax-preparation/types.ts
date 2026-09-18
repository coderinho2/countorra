import type { CurrencyCode } from "@/domain/money/currency";
import type { FilingStatus, TaxJurisdiction } from "@/domain/tax/rules/types";

/**
 * TAX PREPARATION — the layer between what a person has and what an engine
 * can compute.
 *
 * THREE LAYERS, KEPT APART ON PURPOSE
 *
 *   Preparation   "Do we have the information needed?"
 *   Calculation   "What do the deterministic engines produce from it?"
 *   Filing        "Can this be submitted?" — NOT IMPLEMENTED, and nothing
 *                 here may imply that it is.
 *
 * The engines in `src/domain/tax/` already answer the middle question and are
 * not changed by any of this. Preparation sits above them: it collects facts,
 * records where each one came from, refuses to guess the ones it does not
 * have, freezes what it does have into an immutable snapshot, and hands that
 * snapshot to the engines.
 *
 * THE INVARIANT EVERYTHING ELSE SERVES
 *
 * A number a person typed, a number a model proposed from a document, and a
 * number an engine computed are three different kinds of thing. Flattening
 * them into "the wages figure" is how a tax product ends up confidently wrong.
 * So every fact carries its provenance and its state, and only CONFIRMED
 * facts reach a snapshot.
 */

/** Where a preparation case is in its workflow. */
export type PreparationStatus =
  /** Created, nothing meaningful collected yet. */
  | "DRAFT"
  /** Actively gathering taxpayer facts, income and documents. */
  | "COLLECTING"
  /** Everything the completeness engine requires is present; blockers are
   *  clear and the snapshot can be taken. */
  | "READY_FOR_CALCULATION"
  /** A snapshot was taken and the engines ran against it. */
  | "CALCULATED"
  /** Specific information is missing. Not a failure — a request. */
  | "NEEDS_INFORMATION"
  /** Something prevents calculation that the user cannot simply supply —
   *  an unsupported situation, or a jurisdiction whose rules are pending. */
  | "BLOCKED"
  /** Closed for this tax year. */
  | "ARCHIVED";

/**
 * Transitions the workflow permits.
 *
 * Declared as data rather than scattered through `if` statements so an
 * illegal move — say ARCHIVED back to COLLECTING — fails in one obvious
 * place, and so the set is readable without tracing call sites.
 */
export const ALLOWED_STATUS_TRANSITIONS: Readonly<Record<PreparationStatus, readonly PreparationStatus[]>> = {
  DRAFT: ["COLLECTING", "ARCHIVED"],
  COLLECTING: ["READY_FOR_CALCULATION", "NEEDS_INFORMATION", "BLOCKED", "ARCHIVED"],
  READY_FOR_CALCULATION: ["CALCULATED", "COLLECTING", "NEEDS_INFORMATION", "BLOCKED", "ARCHIVED"],
  // A calculated case can be reopened — that is what produces a new version.
  CALCULATED: ["COLLECTING", "NEEDS_INFORMATION", "BLOCKED", "ARCHIVED"],
  NEEDS_INFORMATION: ["COLLECTING", "READY_FOR_CALCULATION", "BLOCKED", "ARCHIVED"],
  BLOCKED: ["COLLECTING", "NEEDS_INFORMATION", "ARCHIVED"],
  // Terminal. Reopening a filed-away year is a new case, not a status change.
  ARCHIVED: [],
};

export function canTransition(from: PreparationStatus, to: PreparationStatus): boolean {
  return ALLOWED_STATUS_TRANSITIONS[from].includes(to);
}

/**
 * The status a case moves to when its information changes: COLLECTING, when
 * the workflow allows reaching it directly or through one intermediate status.
 * Null when the case is already collecting or cannot be reopened (archived).
 * Shared by every action that adds information to a case, so a stale
 * calculation is never presented as current.
 */
export function reopenedStatusFor(from: PreparationStatus): PreparationStatus | null {
  if (from === "COLLECTING") return null;
  if (canTransition(from, "COLLECTING")) return "COLLECTING";
  return ALLOWED_STATUS_TRANSITIONS[from].some((via) => canTransition(via, "COLLECTING")) ? "COLLECTING" : null;
}

/**
 * Where a fact came from.
 *
 * `AI_PROPOSED` is deliberately its own source rather than a flavour of
 * `DOCUMENT`: a model reading a document is not the document, and the
 * difference has to survive into the audit trail.
 */
export type FactSource =
  | "USER_ENTERED"
  | "DOCUMENT"
  | "TRANSACTION"
  | "INVOICE"
  | "IMPORT"
  | "SYSTEM_DERIVED"
  | "TAX_ENGINE"
  | "AI_PROPOSED";

/**
 * How far a fact has got.
 *
 * ONLY `CONFIRMED` FACTS REACH A SNAPSHOT. That is the rule that stops an
 * extracted or inferred number from silently becoming a tax figure.
 */
export type FactState =
  /** Suggested — by a model, an import, or a derivation from financial data.
   *  Visible to the user, never used in a calculation. */
  | "PROPOSED"
  /** A person has affirmatively accepted this value. */
  | "CONFIRMED"
  /** A person has rejected it. Kept, not deleted: "we offered this and it was
   *  wrong" is part of the audit trail. */
  | "REJECTED";

/** A single normalized tax fact, with its provenance attached. */
export interface TaxFact {
  id: string;
  organizationId: string;
  caseId: string;
  /** The version of the case this fact belongs to. Facts are never edited;
   *  a correction is a new fact in a new version. */
  version: number;
  key: TaxFactKey;
  /** Integer minor units. Null for facts that are not amounts. */
  amountMinor: number | null;
  currency: CurrencyCode | null;
  /** For non-monetary facts — a code, a flag, a date. */
  textValue: string | null;
  source: FactSource;
  state: FactState;
  /** The document this came from, where it came from one. */
  evidenceDocumentId: string | null;
  /** Free text describing the evidence, e.g. "W-2 box 1, Acme Corp". Never
   *  a tax identifier. */
  evidenceNote: string | null;
  /** The extracted document field this figure was read from, when it came
   *  from document intelligence. Provenance only: it never makes a figure
   *  confirmed, and it is not part of a snapshot's inputs. */
  evidenceExtractionFieldId?: string | null;
  createdAt: string;
  createdBy: string | null;
}

/**
 * The normalized vocabulary. See `facts.ts` for what each one means, which
 * engine input it feeds, and whether the engines support it at all.
 */
export type TaxFactKey =
  // ── Income ──────────────────────────────────────────────────────────
  | "W2_WAGES"
  | "W2_SOCIAL_SECURITY_WAGES"
  | "W2_MEDICARE_WAGES"
  | "W2_FEDERAL_WITHHOLDING"
  | "W2_STATE_WITHHOLDING"
  | "INTEREST_INCOME"
  | "ORDINARY_DIVIDENDS"
  | "QUALIFIED_DIVIDENDS"
  | "CAPITAL_GAIN_OR_LOSS"
  | "SELF_EMPLOYMENT_NET_PROFIT"
  | "UNEMPLOYMENT_COMPENSATION"
  | "RETIREMENT_INCOME"
  | "SOCIAL_SECURITY_BENEFITS"
  | "RENTAL_INCOME"
  | "K1_INCOME"
  | "OTHER_1099_INCOME"
  | "OTHER_INCOME"
  // ── Deductions and adjustments ──────────────────────────────────────
  | "ITEMIZED_DEDUCTIONS_TOTAL"
  | "MORTGAGE_INTEREST"
  | "CHARITABLE_CONTRIBUTIONS"
  | "STATE_ADDITIONS"
  | "STATE_SUBTRACTIONS"
  // ── Payments, which is what makes a refund figure possible ──────────
  | "FEDERAL_ESTIMATED_PAYMENTS"
  | "STATE_ESTIMATED_PAYMENTS";

/** Whether the deterministic engines can actually use a fact. */
export type FactCalculationSupport =
  /** Feeds a supported engine input and changes the result. */
  | "CALCULATED"
  /** Collected, validated, stored and reported — but no engine consumes it
   *  yet, so it appears in `notModelled` rather than in a figure. */
  | "COLLECTED_NOT_CALCULATED"
  /** Used to decide whether a refund or balance due can be stated at all. */
  | "PAYMENTS_ONLY";

/** A dependent, and how far their qualification has been established. */
export interface PreparationDependent {
  id: string;
  organizationId: string;
  caseId: string;
  /** Given name only. Never a tax identifier. */
  firstName: string;
  lastName: string;
  relationship: string;
  dateOfBirth: string | null;
  monthsLivedWithTaxpayer: number | null;
  isStudent: boolean;
  isDisabled: boolean;
  /** Whether a TIN exists — never the TIN itself. */
  hasTaxIdentifier: boolean;
  claimedByAnother: boolean;
  status: DependentStatus;
  createdAt: string;
}

/**
 * Collected is not the same as qualifies.
 *
 * Nothing in this codebase decides that a dependent legally qualifies for a
 * credit. `VERIFIED` here means the INFORMATION is complete and internally
 * consistent, not that a credit is allowed.
 */
export type DependentStatus =
  /** Every field needed to hand to a reviewer is present and consistent. */
  | "VERIFIED"
  /** Complete, but something needs a human: an edge case, or a conflict. */
  | "NEEDS_REVIEW"
  /** Fields are missing. */
  | "INCOMPLETE"
  /** The situation is outside what this product handles. */
  | "NOT_SUPPORTED";

/** The taxpayer, holding as little sensitive data as the job allows. */
export interface TaxpayerProfile {
  legalFirstName: string | null;
  legalMiddleName: string | null;
  legalLastName: string | null;
  dateOfBirth: string | null;
  /**
   * Which kind of identifier the taxpayer has — NOT the identifier.
   *
   * Countorra does not need an SSN to prepare information, and storing one
   * creates an obligation it does not need either. Presence is enough for
   * completeness; a filing task can collect the number itself, under whatever
   * protection that task establishes.
   */
  taxIdentifierType: "ssn" | "itin" | "none" | null;
  taxIdentifierOnFile: boolean;
  /** USPS two-letter code. Server-derived default from the organization. */
  primaryStateRegion: string | null;
  /** Other states with income or residency in the year. */
  additionalStateRegions: readonly string[];
  /** Set only where the filing status makes it relevant. */
  spouseFirstName: string | null;
  spouseLastName: string | null;
  spouseDateOfBirth: string | null;
  spouseTaxIdentifierOnFile: boolean;
  /**
   * Married filing separately only: whether the spouse itemizes deductions.
   * IRS Topic 551 — if they do, the standard deduction is not allowed, and the
   * standard deduction is the only one Countorra applies. Null = not answered.
   * Recorded by a person; never inferred.
   */
  spouseItemizesDeductions: boolean | null;
}

export interface PreparationCase {
  id: string;
  organizationId: string;
  /** Server-authoritative. A client cannot move a case between years. */
  taxYear: number;
  status: PreparationStatus;
  filingStatus: FilingStatus | null;
  taxpayer: TaxpayerProfile;
  /** Increments whenever a snapshot is taken, so facts and calculations stay
   *  tied to the exact state they were computed from. */
  currentVersion: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ── Issues ────────────────────────────────────────────────────────────

export type IssueSeverity = "INFO" | "WARNING" | "ERROR" | "BLOCKER";

export type IssueCategory =
  | "TAXPAYER"
  | "FILING_STATUS"
  | "DEPENDENTS"
  | "INCOME"
  | "DEDUCTIONS"
  | "DOCUMENTS"
  | "STATE"
  | "JURISDICTION"
  | "PAYMENTS"
  | "CONFLICT"
  | "ENTITY";

export interface PreparationIssue {
  /** Stable, machine-readable. Tests and the UI key on this, not the prose. */
  id: string;
  severity: IssueSeverity;
  category: IssueCategory;
  /** Safe to show a person. */
  message: string;
  /** The fact key, field name or jurisdiction it concerns. */
  affects: string | null;
  /** True only for BLOCKER. Calculation is refused while any is true. */
  blocking: boolean;
  /** What the person can actually do about it. */
  resolution: string;
}

// ── Snapshot ──────────────────────────────────────────────────────────

/**
 * Exactly what the engines were given, frozen.
 *
 * Immutable after creation, and the reason the whole fact/version machinery
 * exists: a stored tax result that cannot be tied to the inputs that produced
 * it is not auditable, and a tax product that silently edits those inputs
 * under an existing result is worse than one that stores nothing.
 */
export interface TaxInputSnapshot {
  id: string;
  organizationId: string;
  caseId: string;
  version: number;
  taxYear: number;
  filingStatus: FilingStatus;
  taxpayer: TaxpayerProfile;
  dependents: readonly PreparationDependent[];
  /** Only CONFIRMED facts, by construction. */
  facts: readonly SnapshotFact[];
  /** Jurisdictions the snapshot was calculated for. */
  jurisdictions: readonly TaxJurisdiction[];
  createdAt: string;
  createdBy: string | null;
}

/** A fact as frozen into a snapshot — the value plus where it came from. */
export interface SnapshotFact {
  key: TaxFactKey;
  amountMinor: number | null;
  currency: CurrencyCode | null;
  textValue: string | null;
  source: FactSource;
  evidenceDocumentId: string | null;
  evidenceNote: string | null;
}

// ── Results ───────────────────────────────────────────────────────────

/**
 * How much weight a result carries.
 *
 * `FINAL` is deliberately absent. Nothing in this product can establish that
 * a return is final, and a status that says so would be the single most
 * misleading string in the codebase.
 */
export type ResultStatus =
  /** The engine computed from a complete-enough snapshot. */
  | "CALCULATED"
  /** Computed, but under rules the engine itself flagged as a disclosed
   *  substitution — California 2026 on 2025's rules. */
  | "ESTIMATE"
  /** Information is missing. */
  | "INCOMPLETE"
  /** A blocker prevented calculation. */
  | "BLOCKED"
  /** The jurisdiction or situation is not supported. */
  | "UNSUPPORTED"
  /** Computed, but something needs a human before it is relied on. */
  | "NEEDS_REVIEW";

/** Whether a refund or balance due can be stated at all. */
export type RefundStatus =
  | "REFUND_EXPECTED"
  | "BALANCE_DUE"
  /** Payments and withholding are not fully known, so neither is stated.
   *  A liability figure alone never implies a refund. */
  | "REFUND_STATUS_INCOMPLETE";
