import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import type { SupportedTaxCalculation } from "@/domain/tax/tax-engine";

type Client = SupabaseClient<Database>;

/**
 * Persisting a tax calculation, with the stamp that keeps it reproducible.
 *
 * Write-only by design: there is no update and no delete here, matching the
 * absence of those policies in 0038. A calculation is a record of what the
 * product told someone on a given day, and editing one destroys the only
 * thing it is for. Corrections are new rows.
 *
 * The client passed in is the caller's RLS-scoped one, never the service
 * role — recording a calculation is an ordinary member action and must be
 * subject to the same organization scoping as every other write.
 */

export interface StoredTaxCalculation {
  id: string;
  organizationId: string;
  jurisdiction: string;
  /** The tax year whose RULES produced this, which `ruleSetVersion` pins. */
  taxYear: number;
  /** The tax year the user asked about. Differs from `taxYear` only when a
   *  disclosed fallback was used. */
  requestedTaxYear: number;
  /** Never present an ESTIMATE_USING_LATEST_PUBLISHED_RULES row as an
   *  authoritative calculation for `requestedTaxYear`. */
  calculationStatus: "PUBLISHED_RULES" | "ESTIMATE_USING_LATEST_PUBLISHED_RULES";
  ruleSetVersion: string;
  filingStatus: string;
  /** Total tax for THIS jurisdiction. A US_FEDERAL row and a US_CA row for
   *  the same year are two separate liabilities; never add them without
   *  saying which is which. */
  totalTaxMinor: number;
  createdAt: string;
}

export async function recordTaxCalculation(
  client: Client,
  input: {
    organizationId: string;
    calculatedBy: string;
    calculation: SupportedTaxCalculation;
    /** The frozen preparation inputs this was run against, when it came from
     *  a preparation case. Null for the direct calculation path. */
    preparationSnapshotId?: string | null;
  },
): Promise<StoredTaxCalculation | null> {
  const { calculation } = input;

  const { data, error } = await client
    .from("tax_calculations")
    .insert({
      organization_id: input.organizationId,
      jurisdiction: calculation.jurisdiction,
      tax_year: calculation.taxYear,
      requested_tax_year: calculation.requestedTaxYear,
      calculation_status: calculation.calculationStatus,
      // The whole point of the row: which published figures produced this.
      rule_set_version: calculation.ruleSetVersion,
      filing_status: calculation.inputs.filingStatus,
      currency: calculation.currency,
      inputs: calculation.inputs as unknown as Json,
      totals: calculation.totals as unknown as Json,
      trace: calculation.steps as unknown as Json,
      total_tax_minor: calculation.totals.totalTax.amountMinor,
      preparation_snapshot_id: input.preparationSnapshotId ?? null,
      calculated_by: input.calculatedBy,
    })
    .select("id, organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status, rule_set_version, filing_status, total_tax_minor, created_at")
    .single();

  if (error) throw error;

  return {
    id: data.id,
    organizationId: data.organization_id,
    jurisdiction: data.jurisdiction,
    taxYear: data.tax_year,
    requestedTaxYear: data.requested_tax_year,
    calculationStatus: data.calculation_status,
    ruleSetVersion: data.rule_set_version,
    filingStatus: data.filing_status,
    totalTaxMinor: data.total_tax_minor,
    createdAt: data.created_at,
  };
}

/** An organization's calculations, newest first. RLS scopes this. */
export async function listTaxCalculations(client: Client, organizationId: string, taxYear?: number): Promise<StoredTaxCalculation[]> {
  let query = client
    .from("tax_calculations")
    .select("id, organization_id, jurisdiction, tax_year, requested_tax_year, calculation_status, rule_set_version, filing_status, total_tax_minor, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(100);

  // Filtered on the REQUESTED year: "show me 2026" must return the 2026
  // estimate even though 2025's rules produced it.
  if (taxYear !== undefined) query = query.eq("requested_tax_year", taxYear);

  const { data, error } = await query;
  if (error) throw error;

  return data.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    jurisdiction: row.jurisdiction,
    taxYear: row.tax_year,
    requestedTaxYear: row.requested_tax_year,
    calculationStatus: row.calculation_status,
    ruleSetVersion: row.rule_set_version,
    filingStatus: row.filing_status,
    totalTaxMinor: row.total_tax_minor,
    createdAt: row.created_at,
  }));
}
