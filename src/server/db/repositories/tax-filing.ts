import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import type { FilingCase, FilingCaseStatus, FilingPackage, FilingReadiness, FilingScope } from "@/domain/tax-filing/types";

type Client = SupabaseClient<Database>;
type CaseRow = Database["public"]["Tables"]["tax_filing_cases"]["Row"];
type SnapshotRow = Database["public"]["Tables"]["tax_filing_snapshots"]["Row"];
type FinalizationRow = Database["public"]["Tables"]["tax_filing_finalizations"]["Row"];

/**
 * Reading and writing filing records.
 *
 * TWO KINDS OF CLIENT, ON PURPOSE
 *
 * Reads take the caller's RLS-scoped client, like every other repository:
 * a member sees their own workspace's filing records and nothing else.
 *
 * Writes take the SERVICE ROLE client, and that is the exception migration
 * 0044 explains at length. Members have no write policy on these tables,
 * because a filing snapshot asserts things Postgres cannot check — that the
 * engines produced these figures and readiness passed — and a member writing
 * through the REST API could otherwise assert them falsely. So only a server
 * action that has already authenticated, authorized, recomputed readiness and
 * re-run the engines may write, and every write here is additionally scoped by
 * organization id. The database triggers still apply to the service role.
 *
 * NO UPDATE AND NO DELETE FOR SNAPSHOTS OR FINALIZATIONS. There are no such
 * functions below; the triggers refuse them anyway.
 */

// ── Cases ─────────────────────────────────────────────────────────────

const CASE_COLUMNS = "id, organization_id, preparation_case_id, tax_year, status, current_version, created_by, created_at, updated_at";

export async function getFilingCaseForPreparation(client: Client, organizationId: string, preparationCaseId: string): Promise<FilingCase | null> {
  const { data, error } = await client
    .from("tax_filing_cases")
    .select(CASE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("preparation_case_id", preparationCaseId)
    .maybeSingle();
  if (error) throw error;
  return data ? toCase(data as CaseRow) : null;
}

export async function getFilingCase(client: Client, filingCaseId: string): Promise<FilingCase | null> {
  const { data, error } = await client.from("tax_filing_cases").select(CASE_COLUMNS).eq("id", filingCaseId).maybeSingle();
  if (error) throw error;
  return data ? toCase(data as CaseRow) : null;
}

/** Service role only — see the header. */
export async function insertFilingCase(
  admin: Client,
  input: { organizationId: string; preparationCaseId: string; taxYear: number; createdBy: string },
): Promise<FilingCase> {
  const { data, error } = await admin
    .from("tax_filing_cases")
    .insert({ organization_id: input.organizationId, preparation_case_id: input.preparationCaseId, tax_year: input.taxYear, created_by: input.createdBy })
    .select(CASE_COLUMNS)
    .single();
  if (error) throw error;
  return toCase(data as CaseRow);
}

/** Service role only. The trigger enforces transitions and version consistency. */
export async function updateFilingCase(
  admin: Client,
  input: { organizationId: string; filingCaseId: string; status: FilingCaseStatus; currentVersion?: number },
): Promise<FilingCase> {
  const update: Database["public"]["Tables"]["tax_filing_cases"]["Update"] = { status: input.status };
  if (input.currentVersion !== undefined) update.current_version = input.currentVersion;

  const { data, error } = await admin
    .from("tax_filing_cases")
    .update(update)
    .eq("id", input.filingCaseId)
    .eq("organization_id", input.organizationId)
    .select(CASE_COLUMNS)
    .single();
  if (error) throw error;
  return toCase(data as CaseRow);
}

// ── Snapshots ─────────────────────────────────────────────────────────

const SNAPSHOT_SUMMARY_COLUMNS =
  "id, organization_id, filing_case_id, version, tax_year, preparation_snapshot_id, preparation_version, readiness_status, package_fingerprint, input_fingerprint, created_by, created_at";
const SNAPSHOT_COLUMNS = `${SNAPSHOT_SUMMARY_COLUMNS}, readiness, package`;

export interface FilingSnapshotSummary {
  id: string;
  organizationId: string;
  filingCaseId: string;
  version: number;
  taxYear: number;
  preparationSnapshotId: string;
  preparationVersion: number;
  readinessStatus: "READY" | "REVIEW_REQUIRED";
  packageFingerprint: string;
  inputFingerprint: string;
  createdBy: string | null;
  createdAt: string;
}

export interface StoredFilingSnapshot extends FilingSnapshotSummary {
  readiness: FilingReadiness;
  package: FilingPackage;
}

export async function getFilingSnapshot(client: Client, snapshotId: string): Promise<StoredFilingSnapshot | null> {
  const { data, error } = await client.from("tax_filing_snapshots").select(SNAPSHOT_COLUMNS).eq("id", snapshotId).maybeSingle();
  if (error) throw error;
  return data ? toSnapshot(data as SnapshotRow) : null;
}

export async function latestFilingSnapshot(client: Client, filingCaseId: string): Promise<StoredFilingSnapshot | null> {
  const { data, error } = await client
    .from("tax_filing_snapshots")
    .select(SNAPSHOT_COLUMNS)
    .eq("filing_case_id", filingCaseId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? toSnapshot(data as SnapshotRow) : null;
}

/** Version history without the package bodies — bounded and cheap. */
export async function listFilingSnapshots(client: Client, filingCaseId: string): Promise<FilingSnapshotSummary[]> {
  const { data, error } = await client
    .from("tax_filing_snapshots")
    .select(SNAPSHOT_SUMMARY_COLUMNS)
    .eq("filing_case_id", filingCaseId)
    .order("version", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data as Omit<SnapshotRow, "readiness" | "package">[]).map(toSummary);
}

/** Service role only. */
export async function insertFilingSnapshot(
  admin: Client,
  input: {
    organizationId: string;
    filingCaseId: string;
    version: number;
    taxYear: number;
    preparationSnapshotId: string;
    preparationVersion: number;
    readiness: FilingReadiness;
    package: FilingPackage;
    packageFingerprint: string;
    inputFingerprint: string;
    createdBy: string;
    createdAt: string;
  },
): Promise<FilingSnapshotSummary> {
  if (input.readiness.status !== "READY" && input.readiness.status !== "REVIEW_REQUIRED") {
    throw new RangeError("A filing snapshot is only taken when something can be finalized.");
  }

  const { data, error } = await admin
    .from("tax_filing_snapshots")
    .insert({
      organization_id: input.organizationId,
      filing_case_id: input.filingCaseId,
      version: input.version,
      tax_year: input.taxYear,
      preparation_snapshot_id: input.preparationSnapshotId,
      preparation_version: input.preparationVersion,
      readiness_status: input.readiness.status,
      readiness: input.readiness as unknown as Json,
      package: input.package as unknown as Json,
      package_fingerprint: input.packageFingerprint,
      input_fingerprint: input.inputFingerprint,
      created_by: input.createdBy,
      created_at: input.createdAt,
    })
    .select(SNAPSHOT_SUMMARY_COLUMNS)
    .single();
  if (error) throw error;
  return toSummary(data as Omit<SnapshotRow, "readiness" | "package">);
}

// ── Finalizations ─────────────────────────────────────────────────────

const FINALIZATION_COLUMNS = "id, organization_id, filing_case_id, snapshot_id, scope, excluded_jurisdictions, acknowledged_issue_codes, finalized_by, finalized_at";

export interface FilingFinalization {
  id: string;
  organizationId: string;
  filingCaseId: string;
  snapshotId: string;
  scope: FilingScope;
  excludedJurisdictions: readonly string[];
  acknowledgedIssueCodes: readonly string[];
  finalizedBy: string | null;
  finalizedAt: string;
}

export async function listFinalizations(client: Client, filingCaseId: string): Promise<FilingFinalization[]> {
  const { data, error } = await client
    .from("tax_filing_finalizations")
    .select(FINALIZATION_COLUMNS)
    .eq("filing_case_id", filingCaseId)
    .order("finalized_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data as FinalizationRow[]).map(toFinalization);
}

/** Service role only. */
export async function insertFinalization(
  admin: Client,
  input: {
    organizationId: string;
    filingCaseId: string;
    snapshotId: string;
    scope: FilingScope;
    excludedJurisdictions: readonly string[];
    acknowledgedIssueCodes: readonly string[];
    finalizedBy: string;
  },
): Promise<FilingFinalization> {
  const { data, error } = await admin
    .from("tax_filing_finalizations")
    .insert({
      organization_id: input.organizationId,
      filing_case_id: input.filingCaseId,
      snapshot_id: input.snapshotId,
      scope: input.scope,
      excluded_jurisdictions: [...input.excludedJurisdictions],
      acknowledged_issue_codes: [...input.acknowledgedIssueCodes],
      finalized_by: input.finalizedBy,
    })
    .select(FINALIZATION_COLUMNS)
    .single();
  if (error) throw error;
  return toFinalization(data as FinalizationRow);
}

// ── Mapping ───────────────────────────────────────────────────────────

function toCase(row: CaseRow): FilingCase {
  return {
    id: row.id,
    organizationId: row.organization_id,
    preparationCaseId: row.preparation_case_id,
    taxYear: row.tax_year,
    status: row.status,
    currentVersion: row.current_version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSummary(row: Omit<SnapshotRow, "readiness" | "package">): FilingSnapshotSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    filingCaseId: row.filing_case_id,
    version: row.version,
    taxYear: row.tax_year,
    preparationSnapshotId: row.preparation_snapshot_id,
    preparationVersion: row.preparation_version,
    readinessStatus: row.readiness_status,
    packageFingerprint: row.package_fingerprint,
    inputFingerprint: row.input_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function toSnapshot(row: SnapshotRow): StoredFilingSnapshot {
  return {
    ...toSummary(row),
    readiness: row.readiness as unknown as FilingReadiness,
    package: row.package as unknown as FilingPackage,
  };
}

function toFinalization(row: FinalizationRow): FilingFinalization {
  return {
    id: row.id,
    organizationId: row.organization_id,
    filingCaseId: row.filing_case_id,
    snapshotId: row.snapshot_id,
    scope: row.scope,
    excludedJurisdictions: row.excluded_jurisdictions ?? [],
    acknowledgedIssueCodes: row.acknowledged_issue_codes ?? [],
    finalizedBy: row.finalized_by,
    finalizedAt: row.finalized_at,
  };
}
