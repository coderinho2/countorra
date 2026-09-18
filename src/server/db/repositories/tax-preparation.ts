import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, TaxPreparationCaseRow, TaxPreparationDependentRow, TaxPreparationFactRow, TaxPreparationSnapshotRow } from "@/types/database";
import { isSupportedCurrency } from "@/domain/money/currency";
import { isKnownFactKey } from "@/domain/tax-preparation/facts";
import type { FactSource, FactState, PreparationCase, PreparationDependent, TaxFact, TaxInputSnapshot } from "@/domain/tax-preparation/types";
import type { FilingStatus } from "@/domain/tax/rules/types";
import type { PreparationCalculation } from "@/domain/tax-preparation/calculation";

type Client = SupabaseClient<Database>;

/**
 * Reading and writing preparation data.
 *
 * The client passed in is always the caller's RLS-scoped one, never the
 * service role. Preparing tax information is an ordinary member action and
 * must be subject to the same organization scoping as every other write —
 * the policies in 0042 are the authorization boundary, and routing around
 * them here would make them decorative.
 *
 * NO UPDATE AND NO DELETE FOR FACTS OR SNAPSHOTS. There are no such
 * functions below, matching the absent policies. Confirming or rejecting a
 * value is `supersedeFact`, which INSERTS.
 */

// ── Cases ─────────────────────────────────────────────────────────────

const CASE_COLUMNS =
  "id, organization_id, tax_year, status, filing_status, legal_first_name, legal_middle_name, legal_last_name, date_of_birth, tax_identifier_type, tax_identifier_on_file, primary_state_region, additional_state_regions, spouse_first_name, spouse_last_name, spouse_date_of_birth, spouse_tax_identifier_on_file, spouse_itemizes_deductions, current_version, created_by, created_at, updated_at, completed_at";

export async function createPreparationCase(
  client: Client,
  input: {
    organizationId: string;
    taxYear: number;
    createdBy: string;
    /** Derived server-side from the organization, never from a client claim
     *  or a model argument — the rule that stops a request asking to be
     *  taxed somewhere cheaper. */
    primaryStateRegion: string | null;
  },
): Promise<PreparationCase> {
  const { data, error } = await client
    .from("tax_preparation_cases")
    .insert({
      organization_id: input.organizationId,
      tax_year: input.taxYear,
      status: "DRAFT",
      primary_state_region: input.primaryStateRegion,
      created_by: input.createdBy,
    })
    .select(CASE_COLUMNS)
    .single();

  if (error) throw error;
  return toCase(data as TaxPreparationCaseRow);
}

/** The live case for a year, if there is one. At most one can exist. */
export async function findLivePreparationCase(client: Client, organizationId: string, taxYear: number): Promise<PreparationCase | null> {
  const { data, error } = await client
    .from("tax_preparation_cases")
    .select(CASE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("tax_year", taxYear)
    .neq("status", "ARCHIVED")
    .maybeSingle();

  if (error) throw error;
  return data ? toCase(data as TaxPreparationCaseRow) : null;
}

export async function getPreparationCase(client: Client, caseId: string): Promise<PreparationCase | null> {
  const { data, error } = await client.from("tax_preparation_cases").select(CASE_COLUMNS).eq("id", caseId).maybeSingle();
  if (error) throw error;
  return data ? toCase(data as TaxPreparationCaseRow) : null;
}

export async function listPreparationCases(client: Client, organizationId: string): Promise<PreparationCase[]> {
  const { data, error } = await client
    .from("tax_preparation_cases")
    .select(CASE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("tax_year", { ascending: false })
    .limit(50);

  if (error) throw error;
  return (data as TaxPreparationCaseRow[]).map(toCase);
}

/**
 * Taxpayer details and status.
 *
 * `tax_year` and `organization_id` are absent from what can be changed, and
 * that is deliberate rather than an omission: a case IS its tax year, and
 * moving one would silently reinterpret every fact in it.
 */
export interface PreparationCasePatch {
  status?: PreparationCase["status"];
  filingStatus?: FilingStatus | null;
  legalFirstName?: string | null;
  legalMiddleName?: string | null;
  legalLastName?: string | null;
  dateOfBirth?: string | null;
  taxIdentifierType?: "ssn" | "itin" | "none" | null;
  taxIdentifierOnFile?: boolean;
  primaryStateRegion?: string | null;
  additionalStateRegions?: readonly string[];
  spouseFirstName?: string | null;
  spouseLastName?: string | null;
  spouseDateOfBirth?: string | null;
  spouseTaxIdentifierOnFile?: boolean;
  spouseItemizesDeductions?: boolean | null;
  currentVersion?: number;
  completedAt?: string | null;
}

export async function updatePreparationCase(client: Client, caseId: string, patch: PreparationCasePatch): Promise<PreparationCase | null> {
  const update: Database["public"]["Tables"]["tax_preparation_cases"]["Update"] = {};
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.filingStatus !== undefined) update.filing_status = patch.filingStatus;
  if (patch.legalFirstName !== undefined) update.legal_first_name = patch.legalFirstName;
  if (patch.legalMiddleName !== undefined) update.legal_middle_name = patch.legalMiddleName;
  if (patch.legalLastName !== undefined) update.legal_last_name = patch.legalLastName;
  if (patch.dateOfBirth !== undefined) update.date_of_birth = patch.dateOfBirth;
  if (patch.taxIdentifierType !== undefined) update.tax_identifier_type = patch.taxIdentifierType;
  if (patch.taxIdentifierOnFile !== undefined) update.tax_identifier_on_file = patch.taxIdentifierOnFile;
  if (patch.primaryStateRegion !== undefined) update.primary_state_region = patch.primaryStateRegion;
  if (patch.additionalStateRegions !== undefined) update.additional_state_regions = [...patch.additionalStateRegions];
  if (patch.spouseFirstName !== undefined) update.spouse_first_name = patch.spouseFirstName;
  if (patch.spouseLastName !== undefined) update.spouse_last_name = patch.spouseLastName;
  if (patch.spouseDateOfBirth !== undefined) update.spouse_date_of_birth = patch.spouseDateOfBirth;
  if (patch.spouseTaxIdentifierOnFile !== undefined) update.spouse_tax_identifier_on_file = patch.spouseTaxIdentifierOnFile;
  if (patch.spouseItemizesDeductions !== undefined) update.spouse_itemizes_deductions = patch.spouseItemizesDeductions;
  if (patch.currentVersion !== undefined) update.current_version = patch.currentVersion;
  if (patch.completedAt !== undefined) update.completed_at = patch.completedAt;

  if (Object.keys(update).length === 0) return getPreparationCase(client, caseId);

  const { data, error } = await client.from("tax_preparation_cases").update(update).eq("id", caseId).select(CASE_COLUMNS).maybeSingle();
  if (error) throw error;
  return data ? toCase(data as TaxPreparationCaseRow) : null;
}

// ── Facts ─────────────────────────────────────────────────────────────

const FACT_COLUMNS =
  "id, organization_id, case_id, version, key, amount_minor, currency, text_value, source, state, evidence_document_id, evidence_note, supersedes_fact_id, evidence_extraction_field_id, created_by, created_at";

export interface RecordFactInput {
  organizationId: string;
  caseId: string;
  version: number;
  key: string;
  amountMinor?: number | null;
  currency?: string | null;
  textValue?: string | null;
  source: FactSource;
  state: FactState;
  evidenceDocumentId?: string | null;
  evidenceNote?: string | null;
  /** The extracted field it was read from (0046). */
  evidenceExtractionFieldId?: string | null;
  /** Set only when this row replaces an earlier one. */
  supersedesFactId?: string | null;
  /** For a CONFIRMED row this is the person who accepted the value. */
  createdBy: string | null;
}

export async function recordFact(client: Client, input: RecordFactInput): Promise<TaxFact> {
  const { data, error } = await client
    .from("tax_preparation_facts")
    .insert({
      organization_id: input.organizationId,
      case_id: input.caseId,
      version: input.version,
      key: input.key,
      amount_minor: input.amountMinor ?? null,
      currency: input.currency ?? null,
      text_value: input.textValue ?? null,
      source: input.source,
      state: input.state,
      evidence_document_id: input.evidenceDocumentId ?? null,
      evidence_note: input.evidenceNote ?? null,
      evidence_extraction_field_id: input.evidenceExtractionFieldId ?? null,
      supersedes_fact_id: input.supersedesFactId ?? null,
      created_by: input.createdBy,
    })
    .select(FACT_COLUMNS)
    .single();

  if (error) throw error;
  return toFact(data as TaxPreparationFactRow);
}

/**
 * Accepting or rejecting a proposed value.
 *
 * An INSERT, not an UPDATE, and that is the whole design. Updating the
 * proposal's row would overwrite its `created_by` with the reviewer's and
 * erase the distinction between "a model suggested this" and "a person
 * accepted it" — which is the single distinction this layer exists to keep.
 *
 * The unique index on `supersedes_fact_id` means a second, concurrent
 * confirmation of the same proposal fails rather than duplicating the figure.
 */
export async function supersedeFact(
  client: Client,
  input: {
    previous: TaxFact;
    state: Extract<FactState, "CONFIRMED" | "REJECTED">;
    /** The reviewer. Required: a confirmation with nobody behind it is the
     *  failure `validation.ts` shouts about. */
    reviewedBy: string;
    /** A corrected figure, where the reviewer changed it. */
    amountMinor?: number | null;
  },
): Promise<TaxFact> {
  return recordFact(client, {
    organizationId: input.previous.organizationId,
    caseId: input.previous.caseId,
    version: input.previous.version,
    key: input.previous.key,
    amountMinor: input.amountMinor !== undefined ? input.amountMinor : input.previous.amountMinor,
    currency: input.previous.currency,
    textValue: input.previous.textValue,
    // Provenance survives the review. A value a model proposed stays
    // AI_PROPOSED after a person accepts it — the acceptance is recorded as
    // the new row's `created_by`, not by relabelling where it came from.
    source: input.previous.source,
    state: input.state,
    evidenceDocumentId: input.previous.evidenceDocumentId,
    evidenceNote: input.previous.evidenceNote,
    // The link to the extracted field survives review, as the source does.
    evidenceExtractionFieldId: input.previous.evidenceExtractionFieldId ?? null,
    supersedesFactId: input.previous.id,
    createdBy: input.reviewedBy,
  });
}

/**
 * The facts currently in force for a case.
 *
 * Every row is fetched and the superseded ones are filtered out here rather
 * than in SQL. PostgREST has no clean anti-join, and the alternative — a
 * database view — would put the definition of "current" somewhere a reader
 * of this file cannot see. A case holds tens of rows, not thousands.
 *
 * `listAllFacts` is the audit trail: the proposals, the rejections and the
 * corrections, in order.
 */
export async function listCurrentFacts(client: Client, caseId: string): Promise<TaxFact[]> {
  const all = await listAllFacts(client, caseId);
  const superseded = new Set(all.map((fact) => fact.supersedesFactId).filter((id): id is string => id !== null));
  return all.filter((fact) => !superseded.has(fact.id));
}

export async function listAllFacts(client: Client, caseId: string): Promise<(TaxFact & { supersedesFactId: string | null })[]> {
  const { data, error } = await client
    .from("tax_preparation_facts")
    .select(FACT_COLUMNS)
    .eq("case_id", caseId)
    .order("created_at", { ascending: true })
    .limit(1000);

  if (error) throw error;
  return (data as TaxPreparationFactRow[]).map(toFact);
}

// ── Dependents ────────────────────────────────────────────────────────

const DEPENDENT_COLUMNS =
  "id, organization_id, case_id, first_name, last_name, relationship, date_of_birth, months_lived_with_taxpayer, is_student, is_disabled, has_tax_identifier, claimed_by_another, status, created_by, created_at, updated_at";

export async function listDependents(client: Client, caseId: string): Promise<PreparationDependent[]> {
  const { data, error } = await client.from("tax_preparation_dependents").select(DEPENDENT_COLUMNS).eq("case_id", caseId).order("created_at", { ascending: true }).limit(50);
  if (error) throw error;
  return (data as TaxPreparationDependentRow[]).map(toDependent);
}

export async function addDependent(
  client: Client,
  input: {
    organizationId: string;
    caseId: string;
    firstName: string;
    lastName: string;
    relationship: string;
    dateOfBirth: string | null;
    monthsLivedWithTaxpayer: number | null;
    isStudent: boolean;
    isDisabled: boolean;
    hasTaxIdentifier: boolean;
    claimedByAnother: boolean;
    status: PreparationDependent["status"];
    createdBy: string | null;
  },
): Promise<PreparationDependent> {
  const { data, error } = await client
    .from("tax_preparation_dependents")
    .insert({
      organization_id: input.organizationId,
      case_id: input.caseId,
      first_name: input.firstName,
      last_name: input.lastName,
      relationship: input.relationship,
      date_of_birth: input.dateOfBirth,
      months_lived_with_taxpayer: input.monthsLivedWithTaxpayer,
      is_student: input.isStudent,
      is_disabled: input.isDisabled,
      has_tax_identifier: input.hasTaxIdentifier,
      claimed_by_another: input.claimedByAnother,
      status: input.status,
      created_by: input.createdBy,
    })
    .select(DEPENDENT_COLUMNS)
    .single();

  if (error) throw error;
  return toDependent(data as TaxPreparationDependentRow);
}

export async function removeDependent(client: Client, dependentId: string): Promise<boolean> {
  const { data, error } = await client.from("tax_preparation_dependents").delete().eq("id", dependentId).select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

// ── Snapshots ─────────────────────────────────────────────────────────

const SNAPSHOT_COLUMNS = "id, organization_id, case_id, version, tax_year, filing_status, jurisdictions, payload, calculation, created_by, created_at";

export interface StoredSnapshot {
  id: string;
  caseId: string;
  version: number;
  snapshot: TaxInputSnapshot;
  /** Exactly what was shown for this version. Never recomputed. */
  calculation: PreparationCalculation | null;
  createdAt: string;
}

/**
 * Freezing the inputs.
 *
 * Insert-only, matching 0042. The domain builds the snapshot object; this
 * stores it verbatim, so what is read back is byte-for-byte what the engines
 * were given rather than something re-derived from rows that have since
 * moved on.
 */
export async function recordSnapshot(
  client: Client,
  input: {
    organizationId: string;
    caseId: string;
    snapshot: TaxInputSnapshot;
    /** The classified result, exactly as it will be shown. Frozen with the
     *  inputs so a later rule correction cannot restate what was said. */
    calculation: PreparationCalculation | null;
    createdBy: string | null;
  },
): Promise<{ id: string; version: number; createdAt: string }> {
  const { snapshot } = input;

  const { data, error } = await client
    .from("tax_preparation_snapshots")
    .insert({
      organization_id: input.organizationId,
      case_id: input.caseId,
      version: snapshot.version,
      tax_year: snapshot.taxYear,
      filing_status: snapshot.filingStatus,
      jurisdictions: [...snapshot.jurisdictions],
      payload: snapshot as unknown as Json,
      calculation: input.calculation as unknown as Json,
      created_by: input.createdBy,
    })
    .select("id, version, created_at")
    .single();

  if (error) throw error;
  const row = data as { id: string; version: number; created_at: string };
  return { id: row.id, version: row.version, createdAt: row.created_at };
}

export async function getSnapshot(client: Client, snapshotId: string): Promise<StoredSnapshot | null> {
  const { data, error } = await client.from("tax_preparation_snapshots").select(SNAPSHOT_COLUMNS).eq("id", snapshotId).maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const row = data as TaxPreparationSnapshotRow;
  return toStoredSnapshot(row);
}

export async function latestSnapshot(client: Client, caseId: string): Promise<StoredSnapshot | null> {
  const { data, error } = await client
    .from("tax_preparation_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("case_id", caseId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return toStoredSnapshot(data as TaxPreparationSnapshotRow);
}

function toStoredSnapshot(row: TaxPreparationSnapshotRow): StoredSnapshot {
  return {
    id: row.id,
    caseId: row.case_id,
    version: row.version,
    snapshot: row.payload as unknown as TaxInputSnapshot,
    calculation: row.calculation as unknown as PreparationCalculation | null,
    createdAt: row.created_at,
  };
}

// ── Mapping ───────────────────────────────────────────────────────────

function toCase(row: TaxPreparationCaseRow): PreparationCase {
  return {
    id: row.id,
    organizationId: row.organization_id,
    taxYear: row.tax_year,
    status: row.status,
    filingStatus: row.filing_status,
    taxpayer: {
      legalFirstName: row.legal_first_name,
      legalMiddleName: row.legal_middle_name,
      legalLastName: row.legal_last_name,
      dateOfBirth: row.date_of_birth,
      taxIdentifierType: row.tax_identifier_type,
      taxIdentifierOnFile: row.tax_identifier_on_file,
      primaryStateRegion: row.primary_state_region,
      additionalStateRegions: row.additional_state_regions ?? [],
      spouseFirstName: row.spouse_first_name,
      spouseLastName: row.spouse_last_name,
      spouseDateOfBirth: row.spouse_date_of_birth,
      spouseTaxIdentifierOnFile: row.spouse_tax_identifier_on_file,
      spouseItemizesDeductions: row.spouse_itemizes_deductions,
    },
    currentVersion: row.current_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

/**
 * A stored row becomes a domain fact.
 *
 * `key` is text in the database so the vocabulary can grow without a
 * migration, which means a row can hold a key this build does not recognise —
 * after a downgrade, say. It is mapped through as-is rather than dropped:
 * `facts.ts` is the authority on what is recognised, and the completeness
 * layer reports an unrecognised key as unrecognised. Silently discarding it
 * here would make a figure vanish from a total with nothing said.
 */
function toFact(row: TaxPreparationFactRow): TaxFact & { supersedesFactId: string | null } {
  return {
    id: row.id,
    organizationId: row.organization_id,
    caseId: row.case_id,
    version: row.version,
    key: row.key as TaxFact["key"],
    amountMinor: row.amount_minor,
    currency: row.currency && isSupportedCurrency(row.currency) ? row.currency : null,
    textValue: row.text_value,
    source: row.source,
    state: row.state,
    evidenceDocumentId: row.evidence_document_id,
    evidenceNote: row.evidence_note,
    evidenceExtractionFieldId: row.evidence_extraction_field_id ?? null,
    supersedesFactId: row.supersedes_fact_id,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/** Whether a stored row's key is one this build understands. */
export function factKeyRecognised(fact: Pick<TaxFact, "key">): boolean {
  return isKnownFactKey(fact.key);
}

function toDependent(row: TaxPreparationDependentRow): PreparationDependent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    caseId: row.case_id,
    firstName: row.first_name,
    lastName: row.last_name,
    relationship: row.relationship,
    dateOfBirth: row.date_of_birth,
    monthsLivedWithTaxpayer: row.months_lived_with_taxpayer,
    isStudent: row.is_student,
    isDisabled: row.is_disabled,
    hasTaxIdentifier: row.has_tax_identifier,
    claimedByAnother: row.claimed_by_another,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Every figure, in any case of this organization, whose evidence is one
 * document — the audit trail of what was proposed from it and what a person
 * decided. Bounded; a single document supports tens of figures, not
 * thousands.
 */
export async function listFactsForDocument(client: Client, organizationId: string, documentId: string): Promise<(TaxFact & { supersedesFactId: string | null })[]> {
  const { data, error } = await client
    .from("tax_preparation_facts")
    .select(FACT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("evidence_document_id", documentId)
    .order("created_at", { ascending: true })
    .limit(500);
  if (error) throw error;
  return (data as TaxPreparationFactRow[]).map(toFact);
}
