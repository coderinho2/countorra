import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import type { TaxpayerProfile } from "./types";

/**
 * Where a preparation case is taxed comes from the ORGANIZATION, now.
 *
 * FOUND DURING LIVE VERIFICATION (Task 7.1)
 *
 * A case copied the workspace's State into `primary_state_region` when it was
 * created, and every later read trusted that copy. Change the workspace from
 * California to Arizona in Settings and the open case kept calculating
 * California — while the page labelled the field "Taken from workspace
 * settings". A person who corrected their State got another state's tax, and
 * nothing said so.
 *
 * The rule the rest of the product already follows (the AI tools, the direct
 * calculator) is that jurisdiction is read from the organization, server-side,
 * every time. This applies that rule to preparation. The stored column becomes
 * a record of what was last used — kept in step when a case is calculated — and
 * a value written to it by any other route is ignored rather than trusted.
 *
 * Only the PRIMARY state follows the organization. Additional states are what
 * the person told us about their year, and stay theirs.
 */
export function withAuthoritativeState(taxpayer: TaxpayerProfile, organization: { country: string; stateRegion: string | null }): TaxpayerProfile {
  // A state only means something for a US workspace. A non-US workspace with a
  // stray state code must not be routed into a US state engine.
  const primaryStateRegion = organization.country === "US" ? organization.stateRegion : null;
  if (taxpayer.primaryStateRegion === primaryStateRegion) return taxpayer;
  return { ...taxpayer, primaryStateRegion };
}

/** Whether a frozen calculation was run for the same jurisdictions the case
 *  would use today. A changed workspace State makes an old result stale even
 *  though no fact changed. */
export function sameJurisdictions(a: readonly TaxJurisdiction[], b: readonly TaxJurisdiction[]): boolean {
  return a.length === b.length && a.every((jurisdiction, index) => jurisdiction === b[index]);
}
