import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";

type Client = SupabaseClient<Database>;

/**
 * The only sanctioned way to write an audit event (DESIGN brief §16).
 * Calls the `record_audit_event` RPC rather than inserting into
 * `audit_logs` directly — there is no INSERT policy on that table for the
 * `authenticated` role (supabase/migrations/0011_rls_policies.sql), so a
 * direct insert would fail by design. The RPC is SECURITY DEFINER
 * specifically so this function can succeed anyway.
 */
export async function recordAuditEvent(
  client: Client,
  event: {
    organizationId: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, Json>;
  },
): Promise<void> {
  const { error } = await client.rpc("record_audit_event", {
    p_organization_id: event.organizationId,
    p_action: event.action,
    p_resource_type: event.resourceType ?? null,
    p_resource_id: event.resourceId ?? null,
    p_metadata: event.metadata ?? {},
  });

  if (error) throw error;
}

/**
 * Common action names, kept centralized so call sites don't invent
 * slightly-different strings for the same event (DESIGN brief §16 lists:
 * login, organization creation, membership changes, financial record
 * create/update/delete, AI actions, document processing, permission
 * changes). Extend this as new events are actually recorded — it's a
 * convention aid, not a database constraint (audit_logs.action is `text`
 * specifically so new values never need a migration).
 */
export const AUDIT_ACTIONS = {
  organizationCreated: "organization.created",
  /** The workspace's state of residence changed — and with it the state tax rules applied. */
  organizationStateChanged: "organization.state_changed",
  membershipRoleChanged: "membership.role_changed",
  accountCreated: "account.created",
  accountArchived: "account.archived",
  transactionCreated: "transaction.created",
  transactionUpdated: "transaction.updated",
  transactionDeleted: "transaction.deleted",
  invoiceCreated: "invoice.created",
  invoiceStatusChanged: "invoice.status_changed",
  /** Delivered to the customer for the first time. */
  invoiceSent: "invoice.sent",
  /** A second or later delivery of an invoice that was already sent. */
  invoiceReminderSent: "invoice.reminder_sent",
  customerCreated: "customer.created",
  categoryCreated: "category.created",
  documentUploaded: "document.uploaded",
  documentRejected: "document.rejected",
  documentDeleted: "document.deleted",
  /** Document intelligence. Metadata carries ids, versions, statuses, the
   *  document TYPE and fact KEYS — never extracted values, names or text. */
  documentProcessingCompleted: "document.processing_completed",
  documentProcessingFailed: "document.processing_failed",
  documentFactsProposed: "document.facts_proposed",
  aiActionConfirmed: "ai_action.confirmed",
  aiActionExecuted: "ai_action.executed",
  /** Tax preparation. Metadata carries field NAMES, fact keys and statuses —
   *  never a tax identifier, never document contents, never a free-text note. */
  taxPreparationStarted: "tax_preparation.started",
  taxPreparationTaxpayerUpdated: "tax_preparation.taxpayer_updated",
  taxPreparationFactRecorded: "tax_preparation.fact_recorded",
  taxPreparationFactReviewed: "tax_preparation.fact_reviewed",
  taxPreparationDependentAdded: "tax_preparation.dependent_added",
  taxPreparationDependentRemoved: "tax_preparation.dependent_removed",
  taxPreparationCalculated: "tax_preparation.calculated",
  taxPreparationArchived: "tax_preparation.archived",
  /** Tax filing (2026). Metadata carries ids, versions, statuses, scopes,
   *  issue CODES and fingerprints — never names, figures, identifiers or text
   *  copied from a document. Nothing here records a submission: there is none. */
  taxFilingCaseCreated: "tax_filing.case_created",
  taxFilingReadinessEvaluated: "tax_filing.readiness_evaluated",
  taxFilingReadinessBlocked: "tax_filing.readiness_blocked",
  taxFilingSnapshotCreated: "tax_filing.snapshot_created",
  taxFilingVersionCreated: "tax_filing.version_created",
  taxFilingInvalidated: "tax_filing.invalidated",
  taxFilingFinalized: "tax_filing.finalized",
  taxFilingPackageExported: "tax_filing.package_exported",
  /** A member sent this workspace to Stripe Checkout. Records the INTENT —
   *  whether it resulted in a subscription is decided by the webhook, which
   *  writes `billingSubscriptionSynced`. */
  billingCheckoutStarted: "billing.checkout_started",
  /** A verified Stripe event moved this workspace's subscription. */
  billingSubscriptionSynced: "billing.subscription_synced",
  /** Bank connections (Task 11). Metadata carries ids, the provider NAME,
   *  statuses, reasons, outcome codes and counts — never a provider identifier,
   *  credential, cursor, amount, merchant or description. */
  bankLinkStarted: "bank_connection.link_started",
  /** A developer of this deployment set or cleared a workspace's TEST plan.
   *  Entitlements only — billing is untouched, and the metadata carries the
   *  tier and nothing else. */
  developerPlanOverrideChanged: "billing.developer_plan_override_changed",
  bankConnectionConnected: "bank_connection.connected",
  bankConnectionStatusChanged: "bank_connection.status_changed",
  bankConnectionReauthenticated: "bank_connection.reauthenticated",
  bankConnectionDisconnected: "bank_connection.disconnected",
  bankSyncRequested: "bank_connection.sync_requested",
  bankAccountLinked: "bank_connection.account_linked",
  bankReviewResolved: "bank_connection.review_resolved",
} as const;

/**
 * An audit event with no person behind it: a verified provider webhook, or a
 * status change decided by a sync run.
 *
 * `record_audit_event` refuses a caller without a session, by design (0024), and
 * reserves the `system` actor for back-end writers that do not go through it.
 * This is that writer: the service-role client inserts the row directly.
 * Only server code holding the admin client can call it.
 */
export async function recordSystemAuditEvent(
  admin: Client,
  event: {
    organizationId: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    metadata?: Record<string, Json>;
  },
): Promise<void> {
  const { error } = await admin.from("audit_logs").insert({
    organization_id: event.organizationId,
    actor_id: null,
    actor_type: "system",
    action: event.action,
    resource_type: event.resourceType ?? null,
    resource_id: event.resourceId ?? null,
    metadata: event.metadata ?? {},
  });
  if (error) throw error;
}
