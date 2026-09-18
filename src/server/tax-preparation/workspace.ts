import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import type { Organization } from "@/domain/organizations/types";
import { assessCompleteness, type CompletenessResult } from "@/domain/tax-preparation/completeness";
import { sameJurisdictions, withAuthoritativeState } from "@/domain/tax-preparation/jurisdiction";
import { buildPreparationPackage, type PreparationPackage } from "@/domain/tax-preparation/preparation-package";
import type { PreparationCase, PreparationDependent, TaxFact } from "@/domain/tax-preparation/types";
import { getOrganization } from "@/server/db/repositories/organizations";
import { getPreparationCase, latestSnapshot, listCurrentFacts, listDependents, type StoredSnapshot } from "@/server/db/repositories/tax-preparation";

type Client = SupabaseClient<Database>;

/**
 * Everything about one preparation case, assembled once.
 *
 * The page, the server actions and the AI tools all need the same picture —
 * current facts, dependents, completeness, the last frozen calculation — and
 * three hand-rolled versions of "load it and assess it" would drift into
 * three slightly different answers to "is this ready?". So there is one.
 *
 * WHAT IS RECOMPUTED AND WHAT IS NOT
 *
 * Completeness is recomputed on every load, because it is a statement about
 * the case as it stands now and its rules live in versioned code.
 *
 * The calculation is NOT recomputed. It is read from the latest snapshot,
 * exactly as it was frozen. Re-running the engines here would quietly restate
 * a figure someone was already shown the moment a rule set was corrected.
 * `calculationIsCurrent` says whether the case has changed since.
 */
export interface PreparationWorkspace {
  organization: Organization;
  preparationCase: PreparationCase;
  /** Facts in force — superseded rows filtered out. */
  facts: readonly TaxFact[];
  dependents: readonly PreparationDependent[];
  completeness: CompletenessResult;
  latest: StoredSnapshot | null;
  /** False when information changed after the last calculation — including
   *  the workspace's State, which changes the jurisdictions without touching
   *  a single fact. */
  calculationIsCurrent: boolean;
  /** The state stored on the case row, which may lag the organization's. The
   *  case itself above always carries the organization's current state. */
  storedPrimaryStateRegion: string | null;
  currency: CurrencyCode | null;
  package: PreparationPackage;
}

export async function loadPreparationWorkspace(client: Client, organizationId: string, caseId: string): Promise<PreparationWorkspace | null> {
  const [organization, storedCase] = await Promise.all([getOrganization(client, organizationId), getPreparationCase(client, caseId)]);

  // Same-organization check on top of RLS, in the order the rest of the
  // codebase uses: a guessed case id from another workspace is simply absent.
  if (!organization || !storedCase || storedCase.organizationId !== organizationId) return null;

  // Jurisdiction comes from the organization, every time — never from the copy
  // stored on the case. See src/domain/tax-preparation/jurisdiction.ts for the
  // live bug this closes.
  const preparationCase: PreparationCase = { ...storedCase, taxpayer: withAuthoritativeState(storedCase.taxpayer, organization) };

  const [facts, dependents, latest] = await Promise.all([listCurrentFacts(client, caseId), listDependents(client, caseId), latestSnapshot(client, caseId)]);

  const completeness = assessCompleteness({
    taxYear: preparationCase.taxYear,
    filingStatus: preparationCase.filingStatus,
    taxpayer: preparationCase.taxpayer,
    dependents,
    facts,
    countryCode: organization.country,
    entityType: organization.entityType,
    // No "what income did you have this year?" questionnaire exists yet, so
    // nothing is declared ahead of its figure. Stated rather than faked: the
    // DECLARED_INCOME_MISSING_VALUE blocker is implemented and tested, and
    // starts firing the day a questionnaire supplies this list.
    declaredIncomeKinds: [],
  });

  const calculationIsCurrent =
    latest !== null &&
    preparationCase.status === "CALCULATED" &&
    latest.version === preparationCase.currentVersion &&
    sameJurisdictions(latest.snapshot.jurisdictions, completeness.jurisdictions);
  const currency = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : null;

  return {
    organization,
    preparationCase,
    facts,
    dependents,
    completeness,
    latest,
    calculationIsCurrent,
    storedPrimaryStateRegion: storedCase.taxpayer.primaryStateRegion,
    currency,
    package: buildPreparationPackage({
      preparationCase,
      facts,
      dependents,
      completeness,
      snapshot: latest?.snapshot ?? null,
      calculation: latest?.calculation ?? null,
      blockedReason:
        completeness.blockers.length > 0
          ? `Calculation is blocked by ${completeness.blockers.length} unresolved ${completeness.blockers.length === 1 ? "issue" : "issues"}.`
          : null,
      // A non-USD workspace cannot reach a US engine anyway — the engines
      // refuse a currency mismatch — so USD here labels the package only.
      currency: currency ?? "USD",
    }),
  };
}
