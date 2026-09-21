import type { UserEntityType } from "@/types/database";

/**
 * COUNTORRA'S LAUNCH SCOPE: PERSONAL ONLY.
 *
 * Countorra launches as a personal finance and personal tax product. The
 * data model still knows three entity types — `organizations.entity_type` is
 * a Postgres enum of personal / freelancer / business, and removing values
 * from a live enum is a risky migration for no benefit — but only `personal`
 * can be created or chosen, and every workspace is presented as personal.
 *
 * This module is the single switch. Freelancer and Business are deferred, not
 * deleted: reintroducing them is a matter of widening `LAUNCH_ENTITY_TYPES`,
 * re-enabling the modules in `DEFERRED_MODULES`, and relaxing the database
 * guard added in supabase/migrations/0051_personal_launch_scope.sql.
 *
 * Existing workspaces stored as freelancer or business keep their stored
 * value — nothing is rewritten or deleted — and are treated as personal by
 * the product (`productEntityType`). The one place the stored value is still
 * read is tax preparation, which refuses to prepare a personal return for a
 * workspace recorded as a business (src/domain/tax-preparation/completeness.ts).
 */

export const LAUNCH_ENTITY_TYPE = "personal" as const satisfies UserEntityType;
export type LaunchEntityType = typeof LAUNCH_ENTITY_TYPE;

/** The entity types that can be created or selected. */
export const LAUNCH_ENTITY_TYPES: readonly [LaunchEntityType] = [LAUNCH_ENTITY_TYPE];

/** Entity types that exist in the database model but are not part of the launch. */
export const DEFERRED_ENTITY_TYPES: readonly UserEntityType[] = ["freelancer", "business"];

export function isLaunchEntityType(value: unknown): value is LaunchEntityType {
  return value === LAUNCH_ENTITY_TYPE;
}

/**
 * How the product treats a workspace, whatever its stored entity type. Every
 * UI branch and the assistant's context use this, never the raw column, so a
 * legacy freelancer or business workspace behaves exactly like a personal one.
 */
export function productEntityType(stored: UserEntityType): LaunchEntityType {
  // A type that is part of the launch passes through; a deferred one is
  // presented as personal. If the launch scope widens, only
  // `LAUNCH_ENTITY_TYPES` and `isLaunchEntityType` need to change.
  return isLaunchEntityType(stored) ? stored : LAUNCH_ENTITY_TYPE;
}

/**
 * Product areas that were built for freelancers and businesses and are
 * deferred at launch. Their code, tables and data are kept; their routes,
 * navigation, server actions and assistant tools are switched off.
 *
 *   invoicing — invoices and customers (src/app/app/[orgId]/invoices,
 *               src/app/app/[orgId]/customers, src/server/invoices,
 *               src/server/customers, and the assistant's invoice/customer
 *               tools listed in src/domain/ai/tools/launch-scope.ts)
 *
 * Deliberately NOT deferred: the public page a customer opens from an invoice
 * that was already sent (/invoice/[token]). Those links are in real inboxes;
 * breaking them would harm people outside Countorra for no product benefit.
 */
export type ProductModule = "invoicing";

export const DEFERRED_MODULES: ReadonlySet<ProductModule> = new Set<ProductModule>(["invoicing"]);

export function isModuleEnabled(module: ProductModule): boolean {
  return !DEFERRED_MODULES.has(module);
}

/** What a server action returns when it belongs to a deferred module. */
export const DEFERRED_MODULE_MESSAGE = "Invoicing isn't part of Countorra yet. Countorra currently supports personal finances only.";

/** What onboarding returns if anything other than a personal workspace is requested. */
export const PERSONAL_ONLY_MESSAGE = "Countorra currently supports personal workspaces only.";
