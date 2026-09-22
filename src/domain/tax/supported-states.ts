import { z } from "zod";
import type { TaxJurisdiction } from "./rules/types";

/**
 * The US states Countorra supports, and the ONE place that says so.
 *
 * Onboarding, Settings, the server's validation, the database constraint
 * (supabase/migrations/0052_supported_states.sql), tax-engine routing
 * (`stateJurisdictionFor` in ./tax-engine.ts) and the assistant's context all
 * read this list. Adding a state later means: implement and register its rules
 * and engine, add one entry here, and widen the database constraint. Nothing
 * else in the application names a state.
 *
 * The state lives on the workspace (`organizations.state_region`), not on the
 * user: a household shares one tax residence and one set of books, and every
 * member of the workspace must be taxed under the same rules. It is read from
 * the database, server-side, whenever a tax figure is produced — never taken
 * from a request, a form on the tax page or the model.
 */
export const SUPPORTED_STATES = [
  { code: "CA", name: "California", jurisdiction: "US_CA", leviesIndividualIncomeTax: true, individualReturn: "Form 540" },
  { code: "TX", name: "Texas", jurisdiction: "US_TX", leviesIndividualIncomeTax: false, individualReturn: null },
  { code: "AZ", name: "Arizona", jurisdiction: "US_AZ", leviesIndividualIncomeTax: true, individualReturn: "Form 140" },
  { code: "FL", name: "Florida", jurisdiction: "US_FL", leviesIndividualIncomeTax: false, individualReturn: null },
  { code: "NY", name: "New York", jurisdiction: "US_NY", leviesIndividualIncomeTax: true, individualReturn: "Form IT-201" },
] as const satisfies readonly {
  code: string;
  name: string;
  jurisdiction: TaxJurisdiction;
  leviesIndividualIncomeTax: boolean;
  individualReturn: string | null;
}[];

export type SupportedState = (typeof SUPPORTED_STATES)[number];
export type SupportedStateCode = SupportedState["code"];

export const SUPPORTED_STATE_CODES = SUPPORTED_STATES.map((state) => state.code) as [SupportedStateCode, ...SupportedStateCode[]];

export const STATE_REQUIRED_MESSAGE = "Choose the state you live in: California, Texas, Arizona, Florida or New York.";

/** Strict validation for anything that sets a workspace's state. Case and
 *  whitespace are normalised first; anything outside the list is refused. */
export const supportedStateSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
  z.enum(SUPPORTED_STATE_CODES, { error: STATE_REQUIRED_MESSAGE }),
);

export function isSupportedState(value: unknown): value is SupportedStateCode {
  return typeof value === "string" && (SUPPORTED_STATE_CODES as readonly string[]).includes(value);
}

export function supportedState(code: string | null | undefined): SupportedState | null {
  return SUPPORTED_STATES.find((state) => state.code === code) ?? null;
}

/**
 * What the product knows about a workspace's state, for everything that has
 * to behave differently when it doesn't know:
 *
 *   SET          one of the supported states
 *   NOT_SET      nothing recorded — a workspace created before onboarding
 *                asked. Never defaulted: state tax is simply not calculated
 *                until the person says where they live.
 *   UNSUPPORTED  a state recorded before the list existed (or a non-US
 *                workspace). Treated like NOT_SET for tax, and named so the
 *                person understands why.
 */
export type StateContext =
  | { status: "SET"; state: SupportedState }
  | { status: "NOT_SET" }
  | { status: "UNSUPPORTED"; code: string };

export function stateContextFor(organization: { country: string; stateRegion: string | null }): StateContext {
  if (!organization.stateRegion) return { status: "NOT_SET" };
  const state = organization.country === "US" ? supportedState(organization.stateRegion) : null;
  return state ? { status: "SET", state } : { status: "UNSUPPORTED", code: organization.stateRegion };
}
