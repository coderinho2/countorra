import type { OrgRole, UserEntityType } from "@/types/database";

export type { OrgRole, UserEntityType };

/**
 * Every value the database's `user_entity_type` enum can hold — the column is
 * named `entity_type` because the row it lives on (`organizations`) models a
 * financial entity, not a user.
 *
 * This is the STORAGE model, not the product: at launch only `personal` can be
 * created or selected. See ./launch-scope.ts, and use `LAUNCH_ENTITY_TYPES`
 * wherever a type is offered or accepted.
 */
export const USER_ENTITY_TYPES: readonly UserEntityType[] = ["personal", "freelancer", "business"];

export const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "accountant", "manager", "employee", "viewer"];

export type TaxIdentifierType = "ein" | "ssn" | "itin" | "other";

export interface Organization {
  id: string;
  name: string;
  entityType: UserEntityType;
  country: string;
  /** USPS two-letter state code for US organizations; null when unset. Used
   *  to select a state tax engine, and never inferred from anything else. */
  stateRegion: string | null;
  baseCurrency: string;
  taxIdentifier: string | null;
  taxIdentifierType: TaxIdentifierType | null;
}

export interface Membership {
  organizationId: string;
  userId: string;
  role: OrgRole;
}
