import { findRuleSet, isSupported } from "@/domain/tax/rules/registry";
import { getTaxEngine, stateJurisdictionFor } from "@/domain/tax/register";
import { isSupportedState } from "@/domain/tax/supported-states";
import { resolveRulesFor } from "@/domain/tax/rules/resolve";
import { factDefinition } from "./facts";
import { validatePreparation, type ValidationInput } from "./validation";
import type { PreparationIssue, TaxFact, TaxFactKey } from "./types";
import type { TaxJurisdiction } from "@/domain/tax/rules/types";

/**
 * COMPLETENESS — "do we have enough to calculate, and what is missing?"
 *
 * Deterministic, and separate from validation on purpose. Validation asks
 * whether what we have is internally sound; completeness asks whether there
 * is enough of it, and whether the engines can actually answer for this
 * jurisdiction and year.
 *
 * THE RULE THAT KEEPS THIS HONEST: not every gap is a blocker. A product that
 * blocks on every missing optional field trains people to click past
 * warnings, which is how the real blockers get ignored too. So only four
 * things block — no filing status, no usable tax year, a validation BLOCKER,
 * and a claim of income with no figure behind it.
 */

export interface CompletenessInput extends ValidationInput {
  countryCode: string;
  /** The organization's entity type — a business return is not this product. */
  entityType: string;
  /** What the person said they have, before any figures arrive. Drives
   *  expected-document detection. */
  declaredIncomeKinds: readonly TaxFactKey[];
}

export interface CompletenessResult {
  issues: readonly PreparationIssue[];
  blockers: readonly PreparationIssue[];
  /** True when a snapshot may be taken and the engines run. */
  readyForCalculation: boolean;
  /** Jurisdictions that will actually be calculated. */
  jurisdictions: readonly TaxJurisdiction[];
}

export function assessCompleteness(input: CompletenessInput): CompletenessResult {
  const issues: PreparationIssue[] = [
    ...validatePreparation(input),
    ...assessEntityType(input),
    ...assessTaxYearSupport(input),
    ...assessIncomePresence(input),
    ...assessExpectedDocuments(input),
    ...assessStateResidence(input),
    ...assessJurisdictions(input),
    ...assessPayments(input),
  ];

  const blockers = issues.filter((issue) => issue.blocking);

  return {
    issues,
    blockers,
    readyForCalculation: blockers.length === 0,
    jurisdictions: jurisdictionsFor(input),
  };
}

/**
 * Which engines this case will consult.
 *
 * Federal always; the primary state only if it maps to a jurisdiction. The
 * additional states are deliberately NOT included — allocating income between
 * states is not implemented, and running a second state engine on the whole
 * federal figure would produce a confident, wrong number.
 */
export function jurisdictionsFor(input: Pick<CompletenessInput, "countryCode" | "taxpayer">): readonly TaxJurisdiction[] {
  const out: TaxJurisdiction[] = ["US_FEDERAL"];
  const state = stateJurisdictionFor(input.countryCode, input.taxpayer.primaryStateRegion);
  if (state) out.push(state);
  return out;
}

/**
 * Whether Countorra knows the state this person lives in. Without it no state
 * position is calculated — never a default state — and the person is told so
 * and pointed at the one field that fixes it. The federal figure is
 * unaffected, so this does not block. (Filing readiness has its own
 * STATE_NOT_SET component and does not relay this issue a second time.)
 */
function assessStateResidence({ countryCode, taxpayer }: CompletenessInput): PreparationIssue[] {
  if (countryCode !== "US") return [];
  const code = taxpayer.primaryStateRegion;
  if (isSupportedState(code)) return [];
  return [
    code
      ? {
          id: "STATE_NOT_SUPPORTED",
          severity: "WARNING",
          category: "JURISDICTION",
          message: `${code} isn't a state Countorra supports, so no state tax is calculated.`,
          affects: "organization.stateRegion",
          blocking: false,
          resolution: "Countorra supports California, Texas, Arizona, Florida and New York. The federal figure is unaffected.",
        }
      : {
          id: "STATE_NOT_SET",
          severity: "WARNING",
          category: "JURISDICTION",
          message: "Your state isn't set, so no state tax is calculated.",
          affects: "organization.stateRegion",
          blocking: false,
          resolution: "Set the state you live in under Settings → Workspace. The federal figure is unaffected.",
        },
  ];
}

function assessEntityType({ entityType }: CompletenessInput): PreparationIssue[] {
  if (entityType !== "business") return [];
  // A business owner still has a personal return, and that is what this
  // prepares. What it does not do is prepare the ENTITY's return, and saying
  // so plainly is better than a figure that looks like one.
  return [
    {
      id: "ENTITY_RETURN_NOT_SUPPORTED",
      severity: "WARNING",
      category: "ENTITY",
      message: "This workspace is a business. Countorra prepares individual tax information only — it does not prepare a corporate or partnership return.",
      affects: "organization.entityType",
      blocking: false,
      resolution: "Use this to prepare the owner's individual position. An entity return needs separate preparation.",
    },
  ];
}

function assessTaxYearSupport({ taxYear }: CompletenessInput): PreparationIssue[] {
  if (!Number.isInteger(taxYear) || taxYear < 1900 || taxYear > 2200) {
    return [
      {
        id: "TAX_YEAR_INVALID",
        severity: "BLOCKER",
        category: "JURISDICTION",
        message: "This case's tax year isn't usable.",
        affects: "taxYear",
        blocking: true,
        resolution: "Preparation cases are created for a specific supported tax year.",
      },
    ];
  }

  if (!isSupported("US_FEDERAL", taxYear)) {
    return [
      {
        id: "FEDERAL_YEAR_UNSUPPORTED",
        severity: "BLOCKER",
        category: "JURISDICTION",
        message: `Federal tax rules for ${taxYear} are not implemented, so nothing can be calculated for this year.`,
        affects: "taxYear",
        blocking: true,
        resolution: "Federal support currently covers tax year 2026.",
      },
    ];
  }

  return [];
}

function assessIncomePresence({ facts, declaredIncomeKinds }: CompletenessInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const confirmed = facts.filter((fact) => fact.state === "CONFIRMED");

  if (confirmed.length === 0) {
    issues.push({
      id: "NO_CONFIRMED_FACTS",
      severity: "BLOCKER",
      category: "INCOME",
      message: "No income or other tax information has been confirmed yet.",
      affects: "facts",
      blocking: true,
      resolution: "Enter at least one income figure and confirm it. Proposed values are not used in a calculation until confirmed.",
    });
    // Deliberately falls through to the PROPOSED note below instead of
    // returning here.
    //
    // It used to return, which suppressed that note in the one case where it
    // is most useful: somebody whose only figures came from a document has
    // nothing confirmed AND suggestions waiting, and was told the first
    // without the second. They then had no way to know that the fix was two
    // clicks away on the same page.
    //
    // The declared-income loop IS skipped, because with nothing confirmed it
    // would repeat "no amount entered" for every declared kind alongside a
    // blocker that already says exactly that.
    return [...issues, ...proposedNote(facts)];
  }

  // Someone said they had a W-2 job but no wage figure exists. That is a
  // genuine blocker: calculating without it understates the tax, and the
  // person already told us the income is there.
  for (const declared of declaredIncomeKinds) {
    const hasValue = confirmed.some((fact) => fact.key === declared && fact.amountMinor !== null);
    if (hasValue) continue;
    const definition = factDefinition(declared);
    issues.push({
      id: `DECLARED_INCOME_MISSING_VALUE:${declared}`,
      severity: "BLOCKER",
      category: "INCOME",
      message: `${definition.label} was reported for this year, but no confirmed amount has been entered.`,
      affects: declared,
      blocking: true,
      resolution: `Enter and confirm the ${definition.label.toLowerCase()} figure, or remove it from the reported income for this year.`,
    });
  }

  return [...issues, ...proposedNote(facts)];
}

/** Suggestions waiting for review. Not a blocker — but the thing a person
 *  most needs to know when nothing is confirmed yet. */
function proposedNote(facts: CompletenessInput["facts"]): PreparationIssue[] {
  const proposed = facts.filter((fact) => fact.state === "PROPOSED");
  if (proposed.length === 0) return [];
  return [
    {
      id: "PROPOSED_FACTS_PENDING",
      severity: "WARNING",
      category: "INCOME",
      message: `${proposed.length} suggested ${proposed.length === 1 ? "value has" : "values have"} not been reviewed, and will not be used in the calculation.`,
      affects: "facts",
      blocking: false,
      resolution: "Review each suggestion and confirm or reject it. Only confirmed values reach the calculation.",
    },
  ];
}

/**
 * Expected-but-missing documents.
 *
 * `POSSIBLY_REQUIRED` rather than required: not everyone receives every form,
 * and a product that insists on a 1099-INT for $3 of interest is one people
 * learn to ignore.
 */
function assessExpectedDocuments({ facts }: CompletenessInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];
  const byKey = new Map<TaxFactKey, TaxFact[]>();

  for (const fact of facts) {
    if (fact.state === "REJECTED") continue;
    byKey.set(fact.key, [...(byKey.get(fact.key) ?? []), fact]);
  }

  for (const [key, group] of byKey) {
    const definition = factDefinition(key);
    if (!definition.expectedDocument) continue;
    if (group.some((fact) => fact.evidenceDocumentId)) continue;

    issues.push({
      id: `DOCUMENT_POSSIBLY_REQUIRED:${key}`,
      severity: "INFO",
      category: "DOCUMENTS",
      message: `${definition.label} is recorded with no ${definition.expectedDocument} attached.`,
      affects: key,
      blocking: false,
      resolution: `Attach the ${definition.expectedDocument} if there is one. The figure is used either way — this is about having the evidence on file.`,
    });
  }

  return issues;
}

/**
 * Whether each jurisdiction's engine can answer for this year.
 *
 * Asks the registry and the resolvers rather than hard-coding what each state
 * does. Arizona's refusal, California's disclosed estimate and Florida's and
 * Texas's no-tax answers all surface from the same code path, and a state
 * added later surfaces without changing this function.
 *
 * THE DISTINCTION THIS MAKES, AND WHY
 *
 * Both California 2026 and Arizona 2026 carry a `pendingPublication` list,
 * and reading only that list would produce the same sentence for both. It
 * would be wrong for one of them either way: California answers with a
 * disclosed estimate under 2025's published rules, and Arizona answers with
 * nothing. So the resolver is asked which of the two is happening.
 */
function assessJurisdictions(input: CompletenessInput): PreparationIssue[] {
  const issues: PreparationIssue[] = [];

  for (const jurisdiction of jurisdictionsFor(input)) {
    if (!getTaxEngine(jurisdiction)) {
      issues.push({
        id: `JURISDICTION_NO_ENGINE:${jurisdiction}`,
        severity: "WARNING",
        category: "JURISDICTION",
        message: `No tax engine is implemented for ${jurisdiction}, so no figure will be produced for it.`,
        affects: jurisdiction,
        blocking: false,
        resolution: "The federal figure is unaffected. This state is not calculated.",
      });
      continue;
    }

    const ruleSet = findRuleSet(jurisdiction, input.taxYear);
    if ((ruleSet?.pendingPublication?.length ?? 0) === 0) continue;

    const resolution = resolveRulesFor(jurisdiction, input.taxYear);

    if (resolution.resolved) {
      // California 2026. A figure WILL be produced, under another year's
      // published rules, and the substitution is stated rather than buried —
      // including on the collection screen, before anyone sees a number.
      issues.push({
        id: `JURISDICTION_ESTIMATE_FROM_PUBLISHED_RULES:${jurisdiction}`,
        severity: "WARNING",
        category: "JURISDICTION",
        message:
          resolution.fallback?.notice ??
          `The ${input.taxYear} figure for ${jurisdiction} will be an estimate under ${resolution.ruleSet.taxYear} rules.`,
        affects: jurisdiction,
        blocking: false,
        resolution: "The figure is an estimate, not a calculation for the requested year. Have it reviewed before relying on it.",
      });
      continue;
    }

    // Arizona 2026. The engine refuses; the preparation layer says exactly
    // what is missing and who publishes it, and does NOT substitute another
    // year, a federal figure, or zero.
    const pending = ruleSet?.pendingPublication ?? [];
    issues.push({
      id: `JURISDICTION_RULES_PENDING:${jurisdiction}`,
      severity: "WARNING",
      category: "JURISDICTION",
      message: `The ${input.taxYear} tax calculation for ${jurisdiction} is unavailable because required authoritative ${input.taxYear} tax inputs are not yet published: ${pending.join("; ")}.`,
      affects: jurisdiction,
      blocking: false,
      resolution:
        "The federal figure and any other state are unaffected. This state will show as unavailable rather than being estimated from another year's rules.",
    });
  }

  return issues;
}

/**
 * Whether a refund or balance due can be stated at all.
 *
 * A liability figure alone never implies a refund, and the absence of
 * withholding data is not the same as zero withholding.
 */
function assessPayments({ facts }: CompletenessInput): PreparationIssue[] {
  const hasFederalPayments = facts.some(
    (fact) => fact.state === "CONFIRMED" && (fact.key === "W2_FEDERAL_WITHHOLDING" || fact.key === "FEDERAL_ESTIMATED_PAYMENTS"),
  );
  if (hasFederalPayments) return [];

  return [
    {
      id: "FEDERAL_PAYMENTS_UNKNOWN",
      severity: "INFO",
      category: "PAYMENTS",
      message: "No federal withholding or estimated payments are recorded, so no refund or balance due can be stated.",
      affects: "payments",
      blocking: false,
      resolution: "Enter the federal tax withheld from your W-2 and any estimated payments. Until then only the tax liability is shown.",
    },
  ];
}
