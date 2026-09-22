/**
 * THE LEGAL FACTS ONLY THE BUSINESS CAN SUPPLY — in one place.
 *
 * Privacy, Terms and Security are written from what the code actually does.
 * A few statements, though, are facts about the business, not the software:
 * who the legal entity is, where it is, which law governs, how to reach it,
 * and what the refund policy is. None of them may be invented.
 *
 * Every one of them lives here and nowhere else. While a value is `null`, the
 * pages render a visible, bracketed placeholder — styled as a warning, never
 * silently blank — so an unfinished policy cannot look finished. Filling one
 * in here fills it in on every page that states it.
 *
 * `LEGAL_PLACEHOLDERS_REMAINING` is what the launch checklist reads.
 */

import { SUPPORT_EMAIL } from "@/lib/support";

export interface LegalFacts {
  /** e.g. "Countorra, Inc." — the entity that provides the service. */
  legalEntityName: string | null;
  /** The entity's registered postal address. */
  registeredAddress: string | null;
  /** Where people write about privacy, their data, or these terms. */
  contactEmail: string | null;
  /** e.g. "the State of Delaware, United States". */
  governingLaw: string | null;
  /** The refund policy the business has chosen, in one or two sentences. */
  refundPolicy: string | null;
  /** Whether listed prices include sales tax / VAT, once decided. */
  taxOnPrices: string | null;
}

export const LEGAL_FACTS: LegalFacts = {
  legalEntityName: null,
  registeredAddress: null,
  contactEmail: SUPPORT_EMAIL,
  governingLaw: null,
  refundPolicy: null,
  taxOnPrices: null,
};

export const LEGAL_FACT_LABELS: Record<keyof LegalFacts, string> = {
  legalEntityName: "Legal entity name",
  registeredAddress: "Registered address",
  contactEmail: "Contact email",
  governingLaw: "Governing law",
  refundPolicy: "Refund policy",
  taxOnPrices: "Whether prices include sales tax / VAT",
};

export const LEGAL_PLACEHOLDERS_REMAINING: readonly (keyof LegalFacts)[] = (Object.keys(LEGAL_FACTS) as (keyof LegalFacts)[]).filter((key) => LEGAL_FACTS[key] === null);

/** The last date the legal pages were revised against the codebase. */
export const LEGAL_LAST_UPDATED = "September 18, 2026";

/** Third-party policies linked from Countorra's own. */
export const PLAID_END_USER_PRIVACY_POLICY_URL = "https://plaid.com/legal/#end-user-privacy-policy";
export const STRIPE_PRIVACY_POLICY_URL = "https://stripe.com/privacy";
