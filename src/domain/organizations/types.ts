import type { OrgRole, UserEntityType } from "@/types/database";

export type { OrgRole, UserEntityType };

/**
 * Product-facing alias for `UserEntityType` — DESIGN brief §6 calls these
 * "user types" (PERSONAL / FREELANCER / BUSINESS); the database column is
 * named `entity_type` because the row it lives on (`organizations`) models
 * a financial entity, not a user. Both names refer to the same three values.
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
