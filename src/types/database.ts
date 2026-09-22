/**
 * Hand-written to match supabase/migrations exactly, table for table. This
 * project has no live Supabase instance to run `supabase gen types`
 * against yet — once one exists, prefer generating this file and deleting
 * the hand-maintained version, since generated types can't drift from the
 * schema the way hand-written ones can.
 *
 * `bigint`/`int8` columns (all `*_minor` money columns, audit_logs.id) are
 * typed `number`. Realistic money amounts stay far under
 * Number.MAX_SAFE_INTEGER in minor units, and src/domain/money is the only
 * code allowed to do arithmetic on them — see that module for why this is
 * safe in practice despite Postgres's bigint being wider than a JS number.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

// ── 0047 bank connections ───────────────────────────────────────────────
// Members read these column by column (see the grants in 0047); the service
// role writes them. Provider identifiers, cursors and idempotency keys are in
// the Row types because the service role reads them — member reads in
// src/server/db/repositories/bank-connections.ts never select them.

export type BankConnectionStatusValue = "PENDING" | "ACTIVE" | "DEGRADED" | "REQUIRES_REAUTH" | "ERROR" | "DISCONNECTED";
export type BankImportModeValue = "AWAITING_DECISION" | "IMPORT" | "IGNORE";
export type BankAccountTypeValue = "DEPOSITORY" | "CREDIT" | "LOAN" | "INVESTMENT" | "OTHER";
export type BankSyncJobStatusValue = "QUEUED" | "RUNNING" | "SUCCEEDED" | "RETRYABLE" | "FAILED" | "CANCELLED";
export type BankSyncTriggerValue = "INITIAL" | "MANUAL" | "WEBHOOK" | "SCHEDULED" | "CONTINUATION";
export type BankExternalStatusValue = "PENDING" | "POSTED" | "SUPERSEDED" | "REMOVED";

export type BankConnectionRow = {
  id: string;
  organization_id: string;
  provider: string;
  provider_connection_id: string;
  institution_id: string | null;
  institution_name: string | null;
  /** 0048 — the provider environment this connection was made against. */
  provider_environment: string | null;
  status: BankConnectionStatusValue;
  status_reason: string;
  status_changed_at: string;
  last_provider_event_at: string | null;
  consecutive_failed_runs: number;
  last_failure_category: string | null;
  last_successful_sync_at: string | null;
  last_sync_attempt_at: string | null;
  committed_cursor: string | null;
  page_cursor: string | null;
  created_by: string | null;
  disconnected_by: string | null;
  disconnected_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BankConnectionCredentialRow = {
  connection_id: string;
  organization_id: string;
  secret_ref: string;
  created_at: string;
  rotated_at: string | null;
};

export type BankLinkedAccountRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  provider_account_id: string;
  account_id: string | null;
  import_mode: BankImportModeValue;
  account_type: BankAccountTypeValue;
  account_subtype: string | null;
  display_name: string;
  mask: string | null;
  currency: string | null;
  current_balance_minor: number | null;
  available_balance_minor: number | null;
  balances_as_of: string | null;
  provider_state: "OPEN" | "CLOSED";
  linked_by: string | null;
  linked_at: string | null;
  detached_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BankWebhookEventRow = {
  id: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  provider_event_type: string;
  provider_connection_id: string | null;
  occurred_at: string | null;
  payload_sha256: string;
  organization_id: string | null;
  connection_id: string | null;
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "IGNORED" | "FAILED";
  outcome: string | null;
  attempts: number;
  max_attempts: number;
  failure_category: string | null;
  received_at: string;
  processing_started_at: string | null;
  processed_at: string | null;
};

export type BankSyncJobRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  status: BankSyncJobStatusValue;
  trigger: BankSyncTriggerValue;
  idempotency_key: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
  /** The worker execution holding this job's lease (0049). Not readable by
   *  members: it names a process, not a tenant's data. */
  lease_owner: string | null;
  failure_category: string | null;
  requested_by: string | null;
  webhook_event_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BankSyncRunRow = {
  id: string;
  organization_id: string;
  job_id: string;
  connection_id: string;
  attempt: number;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  pages_fetched: number;
  accounts_seen: number;
  transactions_added: number;
  transactions_modified: number;
  transactions_unchanged: number;
  transactions_removed: number;
  transactions_rejected: number;
  ledger_imported: number;
  ledger_matched: number;
  ledger_updated: number;
  flagged_for_review: number;
  has_more: boolean;
  failure_category: string | null;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
};

export type BankExternalTransactionRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  linked_account_id: string;
  provider: string;
  provider_transaction_id: string;
  pending_provider_transaction_id: string | null;
  status: BankExternalStatusValue;
  direction: "DEBIT" | "CREDIT";
  amount_decimal: string;
  amount_minor: number | null;
  currency: string;
  transaction_date: string;
  posted_date: string | null;
  authorized_date: string | null;
  merchant_name: string | null;
  description: string | null;
  category_hint: string | null;
  content_hash: string;
  revision: number;
  superseded_by_id: string | null;
  removed_at: string | null;
  reconciliation_state: string;
  review_reason: string | null;
  needs_reconciliation: boolean;
  reconciled_revision: number | null;
  review_resolved_revision: number | null;
  ledger_transaction_id: string | null;
  ledger_link_kind: "IMPORTED" | "MATCHED" | null;
  ledger_linked_at: string | null;
  ledger_written_account_id: string | null;
  ledger_written_kind: "income" | "expense" | null;
  ledger_written_amount_minor: number | null;
  ledger_written_currency: string | null;
  ledger_written_occurred_on: string | null;
  ledger_written_description: string | null;
  first_sync_run_id: string | null;
  last_sync_run_id: string | null;
  created_at: string;
  updated_at: string;
};

/** 0048 — encrypted provider credentials. Service role only. */
export type BankProviderSecretRow = {
  id: string;
  organization_id: string;
  connection_id: string;
  provider: string;
  key_id: string;
  algorithm: "AES-256-GCM";
  iv: string;
  ciphertext: string;
  auth_tag: string;
  created_at: string;
  rotated_at: string | null;
};

export type BankTransactionRevisionRow = {
  id: string;
  organization_id: string;
  external_transaction_id: string;
  revision: number;
  change_kind: string;
  sync_run_id: string | null;
  actor_id: string | null;
  status: string;
  amount_decimal: string;
  amount_minor: number | null;
  currency: string;
  transaction_date: string;
  posted_date: string | null;
  merchant_name: string | null;
  description: string | null;
  reconciliation_state: string;
  review_reason: string | null;
  ledger_transaction_id: string | null;
  created_at: string;
};

// Two easy-to-reintroduce mistakes will silently break every `.from(...)`
// and `.rpc(...)` call in the codebase — TypeScript won't error here, it'll
// just make `SupabaseClient<Database>` fall back to `never` for every
// table, which then shows up as confusing "Property 'x' does not exist on
// type 'never'" errors far away, at each call site:
//
// 1. Row types below are `type X = {...}`, never `interface X {...}`.
//    postgrest-js checks `Database["public"] extends GenericSchema`
//    (its structural test for "is this a usable schema") to decide
//    `SupabaseClient`'s table types. An `interface` reference isn't
//    eagerly structurally simplified the way a `type` alias is — even
//    though `Row: ProfileRow` and `Row: { id: string; ... }` print
//    identically, only the latter form (or a `type` alias, which resolves
//    the same way) satisfies that `extends` check. This is a genuine
//    TypeScript quirk, confirmed by isolated repro during Phase 1
//    development, not a guess.
// 2. Insert/Update below are fully literal object types — never
//    `Omit<Row, X> & Partial<Pick<Row, X>>`, and never `Row["field"]`
//    indexed access either. Any `Omit`/`Partial`/`Pick`/indexed-access
//    usage inside the `Tables` map has the exact same deferred-type
//    effect as (1), for the same underlying reason: the checker doesn't
//    eagerly resolve it before the `extends GenericSchema` comparison.
//
// Both are more verbose than the "clever" version — matches the shape
// `supabase gen types typescript` itself produces, which is verbose for
// the same reason. `Relationships: []` is required structurally by
// postgrest-js's `GenericTable` — real generated types populate it with
// foreign-key metadata for embedded `.select("*, other_table(*)")`
// queries, which nothing here uses, so an empty array satisfies the type
// without hand-encoding relationships that have no caller.

// ── Enums (must match supabase/migrations/0001_extensions_and_types.sql) ──

export type UserEntityType = "personal" | "freelancer" | "business";
export type OrgRole = "owner" | "admin" | "accountant" | "manager" | "employee" | "viewer";
export type TransactionKind = "income" | "expense" | "transfer";
export type InvoiceStatus = "draft" | "sent" | "paid" | "overdue" | "void";
export type DocumentKind = "invoice" | "receipt" | "bill" | "bank_statement" | "tax_form" | "other";
/** Mirrors the `document_status` enum. `pending`/`rejected` were added by
 *  supabase/migrations/0030_document_upload_lifecycle_states.sql for the
 *  direct-to-Storage upload flow; `processing`/`processed`/`needs_review`
 *  remain unused, as there is still no extraction provider. */
export type DocumentStatus =
  | "pending"
  | "uploaded"
  | "rejected"
  | "processing"
  | "processed"
  | "failed"
  | "needs_review";
export type AiMessageRole = "user" | "assistant" | "system" | "tool";
export type AiOperationMode = "read" | "analyze" | "calculate" | "suggest" | "write" | "delete";
export type AiActionStatus = "pending_confirmation" | "confirmed" | "executed" | "rejected" | "failed";
export type PlanTier = "free" | "premium" | "business";
/** Mirrors `subscription_status`. `unpaid`/`incomplete_expired`/`paused` were
 *  added by 0034 so Stripe's full lifecycle can be recorded; only `active` and
 *  `trialing` confer a paid plan (ENTITLED_STATUSES in domain/billing). */
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";
export type NotificationKind =
  | "overdue_invoice"
  | "unusual_transaction"
  | "document_needs_review"
  | "document_processing_failed"
  | "financial_insight"
  | "upcoming_bill"
  | "ai_recommendation";

// ── Row shapes ──────────────────────────────────────────────────────────

export type ProfileRow = {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
  default_currency: string;
  locale: string;
  created_at: string;
  updated_at: string;
}

export type OrganizationRow = {
  id: string;
  name: string;
  entity_type: UserEntityType;
  country: string;
  state_region: string | null;
  base_currency: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  tax_identifier: string | null;
  tax_identifier_type: "ein" | "ssn" | "itin" | "other" | null;
}

export type MembershipRow = {
  id: string;
  organization_id: string;
  user_id: string;
  role: OrgRole;
  invited_by: string | null;
  created_at: string;
}

export type AccountRow = {
  id: string;
  organization_id: string;
  name: string;
  kind: "cash" | "bank" | "credit_card" | "wallet" | "other";
  currency: string;
  opening_balance_minor: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

export type TransactionCategoryRow = {
  id: string;
  organization_id: string;
  parent_category_id: string | null;
  kind: "income" | "expense";
  name: string;
  color: string | null;
  is_system: boolean;
  created_at: string;
}

export type MerchantRow = {
  id: string;
  organization_id: string;
  name: string;
  normalized_name: string;
  created_at: string;
}

export type TransactionRow = {
  id: string;
  organization_id: string;
  account_id: string;
  category_id: string | null;
  merchant_id: string | null;
  kind: TransactionKind;
  amount_minor: number;
  currency: string;
  occurred_on: string;
  description: string | null;
  memo: string | null;
  is_reconciled: boolean;
  source: "manual" | "import" | "bank_sync" | "ai";
  created_by: string | null;
  created_at: string;
  updated_at: string;
  is_reviewed: boolean;
  categorized_by: "user" | "ai" | "system" | null;
  category_confidence: number | null;
  transfer_account_id: string | null;
  /** Generated column (description || ' ' || memo) — read-only, never
   *  part of Insert/Update below; see 0019_transaction_search_text.sql. */
  search_text: string;
}

export type AccountingPeriodRow = {
  id: string;
  organization_id: string;
  period_start: string;
  period_end: string;
  status: "open" | "closed" | "locked";
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
}

export type TaxConfigurationRow = {
  id: string;
  organization_id: string;
  country: string;
  tax_year: number;
  config: Json;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export type VatConfigurationRow = {
  id: string;
  organization_id: string;
  is_vat_registered: boolean;
  vat_number: string | null;
  vat_scheme: string | null;
  default_vat_rate: number | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

export type SalesTaxConfigurationRow = {
  id: string;
  organization_id: string;
  state: string;
  has_nexus: boolean;
  registered: boolean;
  rate_percent: number | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentRow = {
  id: string;
  organization_id: string;
  uploaded_by: string | null;
  kind: DocumentKind;
  storage_bucket: string;
  storage_path: string;
  original_filename: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  status: DocumentStatus;
  created_at: string;
  updated_at: string;
  form_type: "w9" | "1099-nec" | "1099-misc" | "1099-k" | "other" | null;
}

export type DocumentProcessingJobRow = {
  id: string;
  organization_id: string;
  document_id: string;
  status: "QUEUED" | "PROCESSING" | "SUCCEEDED" | "PARTIAL" | "REVIEW_REQUIRED" | "UNSUPPORTED" | "FAILED";
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  processing_version: string;
  provider: string;
  provider_version: string;
  failure_category: "DOCUMENT_UNAVAILABLE" | "FILE_VALIDATION_FAILED" | "PROVIDER_ERROR" | "PROVIDER_TIMEOUT" | "MALFORMED_PROVIDER_RESPONSE" | "LEASE_EXPIRED" | "INTERNAL_ERROR" | null;
  failure_message: string | null;
  requested_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type DocumentExtractionRow = {
  id: string;
  organization_id: string;
  document_id: string;
  job_id: string;
  version: number;
  status: "SUCCEEDED" | "PARTIAL" | "REVIEW_REQUIRED" | "UNSUPPORTED";
  processing_version: string;
  provider: string;
  provider_version: string;
  method: "PDF_TEXT_LAYER" | "OCR";
  document_type:
    | "W2"
    | "FORM_1099_NEC"
    | "FORM_1099_MISC"
    | "FORM_1099_INT"
    | "FORM_1099_DIV"
    | "FORM_1099_B"
    | "FORM_1099_R"
    | "FORM_1098"
    | "FORM_1098_T"
    | "FORM_1095_A"
    | "PAY_STUB"
    | "BANK_STATEMENT"
    | "INVOICE"
    | "RECEIPT"
    | "OTHER_FINANCIAL"
    | "UNKNOWN";
  classification_confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  classification_method: "CONTENT_SIGNALS" | "NO_TEXT";
  classification_signals: string[];
  classification_review_reason: string | null;
  tax_year: number | null;
  page_count: number;
  text_char_count: number;
  text_truncated: boolean;
  warnings: string[];
  field_count: number;
  duration_ms: number | null;
  created_at: string;
}

export type DocumentExtractedFieldRow = {
  id: string;
  organization_id: string;
  extraction_id: string;
  document_id: string;
  position: number;
  schema_id: string;
  field_key: string;
  label: string;
  section: "DOCUMENT" | "PARTIES" | "INCOME" | "WITHHOLDING" | "DEDUCTIONS" | "STATE" | "LOCAL" | "PERIOD" | "BALANCES" | "TOTALS" | "LINE_ITEMS" | "TRANSACTIONS";
  box: string | null;
  value_kind: "MONEY" | "DATE" | "TAX_YEAR" | "TEXT" | "CODE" | "PRESENCE";
  raw_value: string | null;
  normalized_decimal: string | null;
  amount_minor: number | null;
  currency: string | null;
  currency_source: "FORM_DEFINITION" | "DOCUMENT_TEXT" | null;
  normalized_date: string | null;
  normalized_text: string | null;
  review_state: "HIGH_CONFIDENCE" | "MEDIUM_CONFIDENCE" | "LOW_CONFIDENCE" | "UNREADABLE" | "MISSING" | "CONFLICT";
  review_reason: string | null;
  /** numeric(4,3) arrives as a string from PostgREST. */
  provider_confidence: number | string | null;
  page_number: number | null;
  line_index: number | null;
  source_position: Json | null;
  method: string;
  created_at: string;
}

export type DocumentRelationshipRow = {
  id: string;
  document_id: string;
  related_type: "transaction" | "invoice";
  related_id: string;
  relationship: "source_of" | "attachment_for";
  created_at: string;
}

export type CustomerRow = {
  id: string;
  organization_id: string;
  display_name: string;
  email: string | null;
  billing_address: Json;
  tax_id: string | null;
  created_at: string;
  updated_at: string;
}

export type InvoiceRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  invoice_number: string;
  status: InvoiceStatus;
  currency: string;
  issue_date: string;
  due_date: string | null;
  subtotal_minor: number;
  tax_minor: number;
  total_minor: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // ── Added by 0037_invoice_delivery_and_recurrence.sql ──
  sent_at: string | null;
  paid_at: string | null;
  voided_at: string | null;
  last_reminder_at: string | null;
  /** Unguessable capability for the customer-facing view; never the id. */
  public_token: string | null;
  /** A real provider-issued payment link, or null. Never a placeholder. */
  payment_url: string | null;
  recurrence_id: string | null;
}

export type RecurrenceInterval = "weekly" | "monthly" | "quarterly" | "yearly";
export type RecurrenceStatus = "active" | "paused" | "ended";

export type InvoiceRecurrenceRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  currency: string;
  interval: RecurrenceInterval;
  interval_count: number;
  due_days: number | null;
  line_items: Json;
  notes: string | null;
  status: RecurrenceStatus;
  next_issue_date: string;
  ends_on: string | null;
  last_generated_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type EmailStatus = "queued" | "sent" | "failed" | "suppressed";

export type EmailMessageRow = {
  id: string;
  organization_id: string | null;
  to_address: string;
  category: string;
  template: string;
  subject: string;
  status: EmailStatus;
  provider: string | null;
  provider_message_id: string | null;
  attempts: number;
  last_error: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
  sent_at: string | null;
}

export type TaxCalculationRow = {
  id: string;
  organization_id: string;
  jurisdiction: string;
  tax_year: number;
  /** The rule-set version in force when this was computed. Never updated. */
  rule_set_version: string;
  filing_status: string;
  currency: string;
  inputs: Json;
  totals: Json;
  trace: Json;
  total_tax_minor: number;
  requested_tax_year: number;
  calculation_status: "PUBLISHED_RULES" | "ESTIMATE_USING_LATEST_PUBLISHED_RULES";
  /** The frozen preparation inputs this was run against. Null for
   *  calculations made outside a preparation case. */
  preparation_snapshot_id: string | null;
  calculated_by: string | null;
  created_at: string;
}

/**
 * Preparation of individual tax information. NOT a return and NOT a filing
 * record - see 0042 and `src/domain/tax-preparation`.
 *
 * Note what is absent and stays absent: there is no column here for a Social
 * Security number, an ITIN, or any other tax identifier. `tax_identifier_type`
 * says WHICH kind exists and `tax_identifier_on_file` says THAT one does,
 * which is all completeness needs.
 */
export type TaxPreparationCaseRow = {
  id: string;
  organization_id: string;
  tax_year: number;
  status: TaxPreparationStatus;
  filing_status: TaxPreparationFilingStatus | null;
  legal_first_name: string | null;
  legal_middle_name: string | null;
  legal_last_name: string | null;
  date_of_birth: string | null;
  tax_identifier_type: "ssn" | "itin" | "none" | null;
  tax_identifier_on_file: boolean;
  primary_state_region: string | null;
  additional_state_regions: string[];
  spouse_first_name: string | null;
  spouse_last_name: string | null;
  spouse_date_of_birth: string | null;
  spouse_tax_identifier_on_file: boolean;
  /** Married filing separately only. NULL = not answered. */
  spouse_itemizes_deductions: boolean | null;
  current_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type TaxPreparationStatus =
  | "DRAFT"
  | "COLLECTING"
  | "READY_FOR_CALCULATION"
  | "CALCULATED"
  | "NEEDS_INFORMATION"
  | "BLOCKED"
  | "ARCHIVED";

export type TaxPreparationFilingStatus =
  | "single"
  | "married_filing_jointly"
  | "married_filing_separately"
  | "head_of_household"
  | "qualifying_surviving_spouse";

/**
 * A normalized tax figure with its provenance. Append-only: confirming or
 * rejecting a value inserts a superseding row rather than updating this one,
 * so an AI proposal and the person who accepted it stay separately
 * attributable. Hence no Update shape below.
 */
export type TaxPreparationFactRow = {
  id: string;
  organization_id: string;
  case_id: string;
  version: number;
  key: string;
  amount_minor: number | null;
  currency: string | null;
  text_value: string | null;
  source: "USER_ENTERED" | "DOCUMENT" | "TRANSACTION" | "INVOICE" | "IMPORT" | "SYSTEM_DERIVED" | "TAX_ENGINE" | "AI_PROPOSED";
  state: "PROPOSED" | "CONFIRMED" | "REJECTED";
  evidence_document_id: string | null;
  evidence_note: string | null;
  supersedes_fact_id: string | null;
  /** 0046. The extracted field this figure was read from, if any. */
  evidence_extraction_field_id: string | null;
  /** For a CONFIRMED row, the person who accepted the value. */
  created_by: string | null;
  created_at: string;
}

export type TaxPreparationDependentRow = {
  id: string;
  organization_id: string;
  case_id: string;
  first_name: string;
  last_name: string;
  relationship: string;
  date_of_birth: string | null;
  months_lived_with_taxpayer: number | null;
  is_student: boolean;
  is_disabled: boolean;
  /** Whether a TIN exists - never the TIN. */
  has_tax_identifier: boolean;
  claimed_by_another: boolean;
  /** How complete the INFORMATION is. Never a determination that a
   *  dependency exemption or credit is allowed. */
  status: "VERIFIED" | "NEEDS_REVIEW" | "INCOMPLETE" | "NOT_SUPPORTED";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Exactly what the engines were given, frozen. Immutable by design. */
export type TaxPreparationSnapshotRow = {
  id: string;
  organization_id: string;
  case_id: string;
  version: number;
  tax_year: number;
  filing_status: TaxPreparationFilingStatus;
  jurisdictions: string[];
  payload: Json;
  /** The classified result shown for these inputs, frozen with them. */
  calculation: Json | null;
  created_by: string | null;
  created_at: string;
}

export type EmailSuppressionRow = {
  address: string;
  reason: string;
  created_at: string;
}

export type InvoiceLineItemRow = {
  id: string;
  invoice_id: string;
  position: number;
  description: string;
  quantity: number;
  unit_price_minor: number;
  tax_rate: number;
  discount_rate: number;
  amount_minor: number;
  created_at: string;
}

export type AiConversationRow = {
  id: string;
  organization_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

export type AiMessageRow = {
  id: string;
  conversation_id: string;
  role: AiMessageRole;
  content: string | null;
  tool_calls: Json;
  tool_results: Json;
  created_at: string;
}

export type AiUsageRow = {
  id: string;
  organization_id: string;
  user_id: string | null;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_minor: number | null;
  created_at: string;
}

export type AiInsightRow = {
  id: string;
  organization_id: string;
  kind: string;
  title: string;
  body: string | null;
  data: Json;
  generated_at: string;
  dismissed_at: string | null;
  created_at: string;
}

export type AiActionRow = {
  id: string;
  organization_id: string;
  conversation_id: string | null;
  operation_mode: AiOperationMode;
  tool_name: string;
  input: Json;
  status: AiActionStatus;
  confirmed_by: string | null;
  /** True when the confirming user's account has since been permanently
   *  deleted. Set only by the database (0033); never written by app code. */
  confirmer_deleted: boolean;
  executed_at: string | null;
  result: Json;
  error_message: string | null;
  created_at: string;
}

export type AuditLogRow = {
  id: number;
  organization_id: string | null;
  actor_id: string | null;
  actor_type: "user" | "ai" | "system";
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: Json;
  ip_address: string | null;
  created_at: string;
}

export type SecurityEventRow = {
  id: number;
  event_type: string;
  severity: "info" | "warning" | "critical";
  user_id: string | null;
  organization_id: string | null;
  metadata: Json;
  created_at: string;
}

export type PlanRow = {
  id: PlanTier;
  name: string;
  price_minor: number | null;
  currency: string;
  entitlements: Json;
  is_active: boolean;
}

export type SubscriptionRow = {
  id: string;
  organization_id: string;
  plan_id: PlanTier;
  status: SubscriptionStatus;
  current_period_end: string | null;
  external_provider: string | null;
  /** The Stripe subscription id when `external_provider = 'stripe'`. */
  external_subscription_id: string | null;
  created_at: string;
  updated_at: string;
  // ── Added by 0035_stripe_billing.sql ──
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  current_period_start: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  /** `created` of the newest Stripe event applied; older events are ignored. */
  stripe_event_at: string | null;
  // ── Added by 0050_billing_safe_organization_deletion.sql ──
  /** Held while a server-side deletion cancels this organization's billing. */
  deletion_lock_id: string | null;
  deletion_locked_at: string | null;
}

export type StripeWebhookEventRow = {
  id: string;
  type: string;
  event_created_at: string | null;
  organization_id: string | null;
  outcome: string | null;
  received_at: string;
}

export type NotificationRow = {
  id: string;
  organization_id: string;
  user_id: string | null;
  kind: NotificationKind;
  title: string;
  body: string | null;
  resource_type: string | null;
  resource_id: string | null;
  created_at: string;
}

export type NotificationReadRow = {
  notification_id: string;
  user_id: string;
  read_at: string;
}

// ── Database shape consumed by @supabase/supabase-js's generic client ────

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: {
          id: string;
          full_name?: string | null;
          avatar_url?: string | null;
          default_currency?: string;
          locale?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          full_name?: string | null;
          avatar_url?: string | null;
          default_currency?: string;
          locale?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organizations: {
        Row: OrganizationRow;
        Insert: {
          id?: string;
          name: string;
          entity_type?: UserEntityType;
          country?: string;
          state_region?: string | null;
          base_currency?: string;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          tax_identifier?: string | null;
          tax_identifier_type?: "ein" | "ssn" | "itin" | "other" | null;
        };
        Update: {
          id?: string;
          name?: string;
          entity_type?: UserEntityType;
          country?: string;
          state_region?: string | null;
          base_currency?: string;
          created_by?: string;
          created_at?: string;
          updated_at?: string;
          tax_identifier?: string | null;
          tax_identifier_type?: "ein" | "ssn" | "itin" | "other" | null;
        };
        Relationships: [];
      };
      memberships: {
        Row: MembershipRow;
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role?: OrgRole;
          invited_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          role?: OrgRole;
          invited_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      accounts: {
        Row: AccountRow;
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          kind: "cash" | "bank" | "credit_card" | "wallet" | "other";
          currency: string;
          opening_balance_minor?: number;
          is_archived?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          kind?: "cash" | "bank" | "credit_card" | "wallet" | "other";
          currency?: string;
          opening_balance_minor?: number;
          is_archived?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      transaction_categories: {
        Row: TransactionCategoryRow;
        Insert: {
          id?: string;
          organization_id: string;
          parent_category_id?: string | null;
          kind: "income" | "expense";
          name: string;
          color?: string | null;
          is_system?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          parent_category_id?: string | null;
          kind?: "income" | "expense";
          name?: string;
          color?: string | null;
          is_system?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      merchants: {
        Row: MerchantRow;
        Insert: {
          id?: string;
          organization_id: string;
          name: string;
          normalized_name: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          name?: string;
          normalized_name?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      transactions: {
        Row: TransactionRow;
        Insert: {
          id?: string;
          organization_id: string;
          account_id: string;
          category_id?: string | null;
          merchant_id?: string | null;
          kind: TransactionKind;
          amount_minor: number;
          currency: string;
          occurred_on: string;
          description?: string | null;
          memo?: string | null;
          is_reconciled?: boolean;
          source?: "manual" | "import" | "bank_sync" | "ai";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          is_reviewed?: boolean;
          categorized_by?: "user" | "ai" | "system" | null;
          category_confidence?: number | null;
          transfer_account_id?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          account_id?: string;
          category_id?: string | null;
          merchant_id?: string | null;
          kind?: TransactionKind;
          amount_minor?: number;
          currency?: string;
          occurred_on?: string;
          description?: string | null;
          memo?: string | null;
          is_reconciled?: boolean;
          source?: "manual" | "import" | "bank_sync" | "ai";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          is_reviewed?: boolean;
          categorized_by?: "user" | "ai" | "system" | null;
          category_confidence?: number | null;
          transfer_account_id?: string | null;
        };
        Relationships: [];
      };
      accounting_periods: {
        Row: AccountingPeriodRow;
        Insert: {
          id?: string;
          organization_id: string;
          period_start: string;
          period_end: string;
          status?: "open" | "closed" | "locked";
          closed_at?: string | null;
          closed_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          period_start?: string;
          period_end?: string;
          status?: "open" | "closed" | "locked";
          closed_at?: string | null;
          closed_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      tax_configurations: {
        Row: TaxConfigurationRow;
        Insert: {
          id?: string;
          organization_id: string;
          country: string;
          tax_year: number;
          config?: Json;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          country?: string;
          tax_year?: number;
          config?: Json;
          is_active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      vat_configurations: {
        Row: VatConfigurationRow;
        Insert: {
          id?: string;
          organization_id: string;
          is_vat_registered?: boolean;
          vat_number?: string | null;
          vat_scheme?: string | null;
          default_vat_rate?: number | null;
          effective_from?: string;
          effective_to?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          is_vat_registered?: boolean;
          vat_number?: string | null;
          vat_scheme?: string | null;
          default_vat_rate?: number | null;
          effective_from?: string;
          effective_to?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      sales_tax_configurations: {
        Row: SalesTaxConfigurationRow;
        Insert: {
          id?: string;
          organization_id: string;
          state: string;
          has_nexus?: boolean;
          registered?: boolean;
          rate_percent?: number | null;
          effective_from?: string;
          effective_to?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          state?: string;
          has_nexus?: boolean;
          registered?: boolean;
          rate_percent?: number | null;
          effective_from?: string;
          effective_to?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      documents: {
        Row: DocumentRow;
        Insert: {
          id?: string;
          organization_id: string;
          uploaded_by?: string | null;
          kind?: DocumentKind;
          storage_bucket?: string;
          storage_path: string;
          original_filename?: string | null;
          mime_type?: string | null;
          size_bytes?: number | null;
          status?: DocumentStatus;
          created_at?: string;
          updated_at?: string;
          form_type?: "w9" | "1099-nec" | "1099-misc" | "1099-k" | "other" | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          uploaded_by?: string | null;
          kind?: DocumentKind;
          storage_bucket?: string;
          storage_path?: string;
          original_filename?: string | null;
          mime_type?: string | null;
          size_bytes?: number | null;
          status?: DocumentStatus;
          created_at?: string;
          updated_at?: string;
          form_type?: "w9" | "1099-nec" | "1099-misc" | "1099-k" | "other" | null;
        };
        Relationships: [];
      };
      /** 0046. Members may SELECT only; writes happen in server code with the
       *  service role after authorization, under guard triggers. */
      document_processing_jobs: {
        Row: DocumentProcessingJobRow;
        Insert: {
          id?: string;
          organization_id: string;
          document_id: string;
          status?: DocumentProcessingJobRow["status"];
          attempts?: number;
          max_attempts?: number;
          idempotency_key: string;
          processing_version: string;
          provider: string;
          provider_version: string;
          failure_category?: DocumentProcessingJobRow["failure_category"];
          failure_message?: string | null;
          requested_by?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
        };
        Update: {
          status?: DocumentProcessingJobRow["status"];
          attempts?: number;
          failure_category?: DocumentProcessingJobRow["failure_category"];
          failure_message?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
        };
        Relationships: [];
      };
      /** 0046. Immutable; written only through record_document_extraction. */
      document_extractions: {
        Row: DocumentExtractionRow;
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      /** 0046. Immutable; written only through record_document_extraction. */
      document_extracted_fields: {
        Row: DocumentExtractedFieldRow;
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      document_relationships: {
        Row: DocumentRelationshipRow;
        Insert: {
          id?: string;
          document_id: string;
          related_type: "transaction" | "invoice";
          related_id: string;
          relationship?: "source_of" | "attachment_for";
          created_at?: string;
        };
        Update: {
          id?: string;
          document_id?: string;
          related_type?: "transaction" | "invoice";
          related_id?: string;
          relationship?: "source_of" | "attachment_for";
          created_at?: string;
        };
        Relationships: [];
      };
      customers: {
        Row: CustomerRow;
        Insert: {
          id?: string;
          organization_id: string;
          display_name: string;
          email?: string | null;
          billing_address?: Json;
          tax_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          display_name?: string;
          email?: string | null;
          billing_address?: Json;
          tax_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      invoices: {
        Row: InvoiceRow;
        Insert: {
          id?: string;
          organization_id: string;
          customer_id: string;
          invoice_number: string;
          status?: InvoiceStatus;
          currency: string;
          issue_date?: string;
          due_date?: string | null;
          subtotal_minor?: number;
          tax_minor?: number;
          total_minor?: number;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          sent_at?: string | null;
          paid_at?: string | null;
          voided_at?: string | null;
          last_reminder_at?: string | null;
          public_token?: string | null;
          payment_url?: string | null;
          recurrence_id?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          customer_id?: string;
          invoice_number?: string;
          status?: InvoiceStatus;
          currency?: string;
          issue_date?: string;
          due_date?: string | null;
          subtotal_minor?: number;
          tax_minor?: number;
          total_minor?: number;
          notes?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          sent_at?: string | null;
          paid_at?: string | null;
          voided_at?: string | null;
          last_reminder_at?: string | null;
          public_token?: string | null;
          payment_url?: string | null;
          recurrence_id?: string | null;
        };
        Relationships: [];
      };
      invoice_recurrences: {
        Row: InvoiceRecurrenceRow;
        Insert: {
          id?: string;
          organization_id: string;
          customer_id: string;
          currency: string;
          interval: RecurrenceInterval;
          interval_count?: number;
          due_days?: number | null;
          line_items: Json;
          notes?: string | null;
          status?: RecurrenceStatus;
          next_issue_date: string;
          ends_on?: string | null;
          last_generated_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          customer_id?: string;
          currency?: string;
          interval?: RecurrenceInterval;
          interval_count?: number;
          due_days?: number | null;
          line_items?: Json;
          notes?: string | null;
          status?: RecurrenceStatus;
          next_issue_date?: string;
          ends_on?: string | null;
          last_generated_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      email_messages: {
        Row: EmailMessageRow;
        Insert: {
          id?: string;
          organization_id?: string | null;
          to_address: string;
          category: string;
          template: string;
          subject: string;
          status?: EmailStatus;
          provider?: string | null;
          provider_message_id?: string | null;
          attempts?: number;
          last_error?: string | null;
          resource_type?: string | null;
          resource_id?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string | null;
          to_address?: string;
          category?: string;
          template?: string;
          subject?: string;
          status?: EmailStatus;
          provider?: string | null;
          provider_message_id?: string | null;
          attempts?: number;
          last_error?: string | null;
          resource_type?: string | null;
          resource_id?: string | null;
          created_at?: string;
          sent_at?: string | null;
        };
        Relationships: [];
      };
      tax_calculations: {
        Row: TaxCalculationRow;
        Insert: {
          id?: string;
          organization_id: string;
          jurisdiction: string;
          tax_year: number;
          rule_set_version: string;
          filing_status: string;
          currency: string;
          inputs: Json;
          totals: Json;
          trace: Json;
          total_tax_minor: number;
          requested_tax_year: number;
          calculation_status: "PUBLISHED_RULES" | "ESTIMATE_USING_LATEST_PUBLISHED_RULES";
          preparation_snapshot_id?: string | null;
          calculated_by?: string | null;
          created_at?: string;
        };
        /** No Update shape is exposed: 0038 creates no UPDATE policy, and a
         *  stored calculation is immutable by design. */
        Update: Record<string, never>;
        Relationships: [];
      };
      tax_preparation_cases: {
        Row: TaxPreparationCaseRow;
        Insert: {
          id?: string;
          organization_id: string;
          tax_year: number;
          status?: TaxPreparationStatus;
          filing_status?: TaxPreparationFilingStatus | null;
          legal_first_name?: string | null;
          legal_middle_name?: string | null;
          legal_last_name?: string | null;
          date_of_birth?: string | null;
          tax_identifier_type?: "ssn" | "itin" | "none" | null;
          tax_identifier_on_file?: boolean;
          primary_state_region?: string | null;
          additional_state_regions?: string[];
          spouse_first_name?: string | null;
          spouse_last_name?: string | null;
          spouse_date_of_birth?: string | null;
          spouse_tax_identifier_on_file?: boolean;
          spouse_itemizes_deductions?: boolean | null;
          current_version?: number;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
          completed_at?: string | null;
        };
        Update: {
          status?: TaxPreparationStatus;
          filing_status?: TaxPreparationFilingStatus | null;
          legal_first_name?: string | null;
          legal_middle_name?: string | null;
          legal_last_name?: string | null;
          date_of_birth?: string | null;
          tax_identifier_type?: "ssn" | "itin" | "none" | null;
          tax_identifier_on_file?: boolean;
          primary_state_region?: string | null;
          additional_state_regions?: string[];
          spouse_first_name?: string | null;
          spouse_last_name?: string | null;
          spouse_date_of_birth?: string | null;
          spouse_tax_identifier_on_file?: boolean;
          spouse_itemizes_deductions?: boolean | null;
          current_version?: number;
          updated_at?: string;
          completed_at?: string | null;
        };
        Relationships: [];
      };
      tax_preparation_facts: {
        Row: TaxPreparationFactRow;
        Insert: {
          id?: string;
          organization_id: string;
          case_id: string;
          version: number;
          key: string;
          amount_minor?: number | null;
          currency?: string | null;
          text_value?: string | null;
          source: TaxPreparationFactRow["source"];
          state: TaxPreparationFactRow["state"];
          evidence_document_id?: string | null;
          evidence_note?: string | null;
          supersedes_fact_id?: string | null;
          evidence_extraction_field_id?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        /** No Update shape: 0042 creates no UPDATE policy. A fact is
         *  append-only, and a correction is a superseding row. */
        Update: Record<string, never>;
        Relationships: [];
      };
      tax_preparation_dependents: {
        Row: TaxPreparationDependentRow;
        Insert: {
          id?: string;
          organization_id: string;
          case_id: string;
          first_name: string;
          last_name: string;
          relationship: string;
          date_of_birth?: string | null;
          months_lived_with_taxpayer?: number | null;
          is_student?: boolean;
          is_disabled?: boolean;
          has_tax_identifier?: boolean;
          claimed_by_another?: boolean;
          status?: TaxPreparationDependentRow["status"];
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          first_name?: string;
          last_name?: string;
          relationship?: string;
          date_of_birth?: string | null;
          months_lived_with_taxpayer?: number | null;
          is_student?: boolean;
          is_disabled?: boolean;
          has_tax_identifier?: boolean;
          claimed_by_another?: boolean;
          status?: TaxPreparationDependentRow["status"];
          updated_at?: string;
        };
        Relationships: [];
      };
      tax_preparation_snapshots: {
        Row: TaxPreparationSnapshotRow;
        Insert: {
          id?: string;
          organization_id: string;
          case_id: string;
          version: number;
          tax_year: number;
          filing_status: TaxPreparationFilingStatus;
          jurisdictions: string[];
          payload: Json;
          calculation?: Json | null;
          created_by?: string | null;
          created_at?: string;
        };
        /** No Update shape: a snapshot is the record of what was actually
         *  calculated. A correction is a new snapshot at a new version. */
        Update: Record<string, never>;
        Relationships: [];
      };
      /** Tax filing (0044). Members may READ these; every write goes through a
       *  server action using the service role, checked by database triggers. */
      tax_filing_cases: {
        Row: {
          id: string;
          organization_id: string;
          preparation_case_id: string;
          tax_year: number;
          /** No provider-only state exists here or in the database. */
          status: "DRAFT" | "REVIEW_REQUIRED" | "BLOCKED" | "READY_FOR_FILING" | "FINALIZED";
          current_version: number;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          preparation_case_id: string;
          tax_year: number;
          status?: "DRAFT";
          current_version?: 0;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          status?: "DRAFT" | "REVIEW_REQUIRED" | "BLOCKED" | "READY_FOR_FILING" | "FINALIZED";
          current_version?: number;
        };
        Relationships: [];
      };
      tax_filing_snapshots: {
        Row: {
          id: string;
          organization_id: string;
          filing_case_id: string;
          version: number;
          tax_year: number;
          preparation_snapshot_id: string;
          preparation_version: number;
          readiness_status: "READY" | "REVIEW_REQUIRED";
          readiness: Json;
          package: Json;
          package_fingerprint: string;
          input_fingerprint: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          filing_case_id: string;
          version: number;
          tax_year: number;
          preparation_snapshot_id: string;
          preparation_version: number;
          readiness_status: "READY" | "REVIEW_REQUIRED";
          readiness: Json;
          package: Json;
          package_fingerprint: string;
          input_fingerprint: string;
          created_by?: string | null;
          created_at?: string;
        };
        /** Immutable. */
        Update: Record<string, never>;
        Relationships: [];
      };
      tax_filing_finalizations: {
        Row: {
          id: string;
          organization_id: string;
          filing_case_id: string;
          snapshot_id: string;
          scope: "FULL" | "FEDERAL_ONLY";
          excluded_jurisdictions: string[];
          acknowledged_issue_codes: string[];
          finalized_by: string | null;
          finalized_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          filing_case_id: string;
          snapshot_id: string;
          scope: "FULL" | "FEDERAL_ONLY";
          excluded_jurisdictions?: string[];
          acknowledged_issue_codes?: string[];
          finalized_by?: string | null;
          finalized_at?: string;
        };
        /** Immutable. */
        Update: Record<string, never>;
        Relationships: [];
      };
      email_suppressions: {
        Row: EmailSuppressionRow;
        Insert: { address: string; reason: string; created_at?: string };
        Update: { address?: string; reason?: string; created_at?: string };
        Relationships: [];
      };
      invoice_line_items: {
        Row: InvoiceLineItemRow;
        Insert: {
          id?: string;
          invoice_id: string;
          position?: number;
          description: string;
          quantity?: number;
          unit_price_minor: number;
          tax_rate?: number;
          discount_rate?: number;
          amount_minor: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          invoice_id?: string;
          position?: number;
          description?: string;
          quantity?: number;
          unit_price_minor?: number;
          tax_rate?: number;
          discount_rate?: number;
          amount_minor?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      ai_conversations: {
        Row: AiConversationRow;
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          title?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          title?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ai_messages: {
        Row: AiMessageRow;
        Insert: {
          id?: string;
          conversation_id: string;
          role: AiMessageRole;
          content?: string | null;
          tool_calls?: Json;
          tool_results?: Json;
          created_at?: string;
        };
        Update: {
          id?: string;
          conversation_id?: string;
          role?: AiMessageRole;
          content?: string | null;
          tool_calls?: Json;
          tool_results?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      ai_usage: {
        Row: AiUsageRow;
        Insert: {
          id?: string;
          organization_id: string;
          user_id?: string | null;
          provider: string;
          model: string;
          input_tokens?: number;
          output_tokens?: number;
          cost_minor?: number | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string | null;
          provider?: string;
          model?: string;
          input_tokens?: number;
          output_tokens?: number;
          cost_minor?: number | null;
          created_at?: string;
        };
        Relationships: [];
      };
      ai_insights: {
        Row: AiInsightRow;
        Insert: {
          id?: string;
          organization_id: string;
          kind: string;
          title: string;
          body?: string | null;
          data?: Json;
          generated_at?: string;
          dismissed_at?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          kind?: string;
          title?: string;
          body?: string | null;
          data?: Json;
          generated_at?: string;
          dismissed_at?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      ai_actions: {
        Row: AiActionRow;
        Insert: {
          id?: string;
          organization_id: string;
          conversation_id?: string | null;
          operation_mode: AiOperationMode;
          tool_name: string;
          input?: Json;
          status?: AiActionStatus;
          confirmed_by?: string | null;
          executed_at?: string | null;
          result?: Json;
          error_message?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          conversation_id?: string | null;
          operation_mode?: AiOperationMode;
          tool_name?: string;
          input?: Json;
          status?: AiActionStatus;
          confirmed_by?: string | null;
          executed_at?: string | null;
          result?: Json;
          error_message?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLogRow;
        Insert: {
          id?: number;
          organization_id?: string | null;
          actor_id?: string | null;
          actor_type?: "user" | "ai" | "system";
          action: string;
          resource_type?: string | null;
          resource_id?: string | null;
          metadata?: Json;
          ip_address?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          organization_id?: string | null;
          actor_id?: string | null;
          actor_type?: "user" | "ai" | "system";
          action?: string;
          resource_type?: string | null;
          resource_id?: string | null;
          metadata?: Json;
          ip_address?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      security_events: {
        Row: SecurityEventRow;
        Insert: {
          id?: number;
          event_type: string;
          severity?: "info" | "warning" | "critical";
          user_id?: string | null;
          organization_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Update: {
          id?: number;
          event_type?: string;
          severity?: "info" | "warning" | "critical";
          user_id?: string | null;
          organization_id?: string | null;
          metadata?: Json;
          created_at?: string;
        };
        Relationships: [];
      };
      plans: {
        Row: PlanRow;
        Insert: {
          id: PlanTier;
          name: string;
          price_minor?: number | null;
          currency?: string;
          entitlements?: Json;
          is_active?: boolean;
        };
        Update: {
          id?: PlanTier;
          name?: string;
          price_minor?: number | null;
          currency?: string;
          entitlements?: Json;
          is_active?: boolean;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: SubscriptionRow;
        Insert: {
          id?: string;
          organization_id: string;
          plan_id?: PlanTier;
          status?: SubscriptionStatus;
          current_period_end?: string | null;
          external_provider?: string | null;
          external_subscription_id?: string | null;
          created_at?: string;
          updated_at?: string;
          stripe_customer_id?: string | null;
          stripe_price_id?: string | null;
          current_period_start?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          stripe_event_at?: string | null;
          deletion_lock_id?: string | null;
          deletion_locked_at?: string | null;
        };
        Update: {
          id?: string;
          organization_id?: string;
          plan_id?: PlanTier;
          status?: SubscriptionStatus;
          current_period_end?: string | null;
          external_provider?: string | null;
          external_subscription_id?: string | null;
          created_at?: string;
          updated_at?: string;
          stripe_customer_id?: string | null;
          stripe_price_id?: string | null;
          current_period_start?: string | null;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          stripe_event_at?: string | null;
          deletion_lock_id?: string | null;
          deletion_locked_at?: string | null;
        };
        Relationships: [];
      };
      stripe_webhook_events: {
        Row: StripeWebhookEventRow;
        Insert: {
          id: string;
          type: string;
          event_created_at?: string | null;
          organization_id?: string | null;
          outcome?: string | null;
          received_at?: string;
        };
        Update: {
          id?: string;
          type?: string;
          event_created_at?: string | null;
          organization_id?: string | null;
          outcome?: string | null;
          received_at?: string;
        };
        Relationships: [];
      };
      notifications: {
        Row: NotificationRow;
        Insert: {
          id?: string;
          organization_id: string;
          user_id?: string | null;
          kind: NotificationKind;
          title: string;
          body?: string | null;
          resource_type?: string | null;
          resource_id?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string | null;
          kind?: NotificationKind;
          title?: string;
          body?: string | null;
          resource_type?: string | null;
          resource_id?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      notification_reads: {
        Row: NotificationReadRow;
        Insert: {
          notification_id: string;
          user_id: string;
          read_at?: string;
        };
        Update: {
          notification_id?: string;
          user_id?: string;
          read_at?: string;
        };
        Relationships: [];
      };
      bank_connections: {
        Row: BankConnectionRow;
        Insert: {
          id?: string;
          organization_id: string;
          provider: string;
          provider_connection_id: string;
          institution_id?: string | null;
          institution_name?: string | null;
          provider_environment?: string | null;
          status?: BankConnectionStatusValue;
          status_reason?: string;
          status_changed_at?: string;
          last_provider_event_at?: string | null;
          consecutive_failed_runs?: number;
          last_failure_category?: string | null;
          last_successful_sync_at?: string | null;
          last_sync_attempt_at?: string | null;
          committed_cursor?: string | null;
          page_cursor?: string | null;
          created_by?: string | null;
          disconnected_by?: string | null;
          disconnected_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          provider?: string;
          provider_connection_id?: string;
          institution_id?: string | null;
          institution_name?: string | null;
          status?: BankConnectionStatusValue;
          status_reason?: string;
          status_changed_at?: string;
          last_provider_event_at?: string | null;
          consecutive_failed_runs?: number;
          last_failure_category?: string | null;
          last_successful_sync_at?: string | null;
          last_sync_attempt_at?: string | null;
          committed_cursor?: string | null;
          page_cursor?: string | null;
          created_by?: string | null;
          disconnected_by?: string | null;
          disconnected_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      bank_connection_credentials: {
        Row: BankConnectionCredentialRow;
        Insert: {
          connection_id: string;
          organization_id: string;
          secret_ref: string;
          created_at?: string;
          rotated_at?: string | null;
        };
        Update: {
          connection_id?: string;
          organization_id?: string;
          secret_ref?: string;
          created_at?: string;
          rotated_at?: string | null;
        };
        Relationships: [];
      };
      bank_linked_accounts: {
        Row: BankLinkedAccountRow;
        Insert: {
          id?: string;
          organization_id: string;
          connection_id: string;
          provider_account_id: string;
          account_id?: string | null;
          import_mode?: BankImportModeValue;
          account_type: BankAccountTypeValue;
          account_subtype?: string | null;
          display_name: string;
          mask?: string | null;
          currency?: string | null;
          current_balance_minor?: number | null;
          available_balance_minor?: number | null;
          balances_as_of?: string | null;
          provider_state?: "OPEN" | "CLOSED";
          linked_by?: string | null;
          linked_at?: string | null;
          detached_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          connection_id?: string;
          provider_account_id?: string;
          account_id?: string | null;
          import_mode?: BankImportModeValue;
          account_type?: BankAccountTypeValue;
          account_subtype?: string | null;
          display_name?: string;
          mask?: string | null;
          currency?: string | null;
          current_balance_minor?: number | null;
          available_balance_minor?: number | null;
          balances_as_of?: string | null;
          provider_state?: "OPEN" | "CLOSED";
          linked_by?: string | null;
          linked_at?: string | null;
          detached_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      bank_webhook_events: {
        Row: BankWebhookEventRow;
        Insert: {
          id?: string;
          provider: string;
          provider_event_id: string;
          event_type: string;
          provider_event_type: string;
          provider_connection_id?: string | null;
          occurred_at?: string | null;
          payload_sha256: string;
          organization_id?: string | null;
          connection_id?: string | null;
          status?: "RECEIVED" | "PROCESSING" | "PROCESSED" | "IGNORED" | "FAILED";
          outcome?: string | null;
          attempts?: number;
          max_attempts?: number;
          failure_category?: string | null;
          received_at?: string;
          processing_started_at?: string | null;
          processed_at?: string | null;
        };
        Update: {
          id?: string;
          provider?: string;
          provider_event_id?: string;
          event_type?: string;
          provider_event_type?: string;
          provider_connection_id?: string | null;
          occurred_at?: string | null;
          payload_sha256?: string;
          organization_id?: string | null;
          connection_id?: string | null;
          status?: "RECEIVED" | "PROCESSING" | "PROCESSED" | "IGNORED" | "FAILED";
          outcome?: string | null;
          attempts?: number;
          max_attempts?: number;
          failure_category?: string | null;
          received_at?: string;
          processing_started_at?: string | null;
          processed_at?: string | null;
        };
        Relationships: [];
      };
      bank_sync_jobs: {
        Row: BankSyncJobRow;
        Insert: {
          id?: string;
          organization_id: string;
          connection_id: string;
          status?: BankSyncJobStatusValue;
          trigger: BankSyncTriggerValue;
          idempotency_key: string;
          attempts?: number;
          max_attempts?: number;
          next_attempt_at?: string | null;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          failure_category?: string | null;
          requested_by?: string | null;
          webhook_event_id?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          connection_id?: string;
          status?: BankSyncJobStatusValue;
          trigger?: BankSyncTriggerValue;
          idempotency_key?: string;
          attempts?: number;
          max_attempts?: number;
          next_attempt_at?: string | null;
          lease_expires_at?: string | null;
          lease_owner?: string | null;
          failure_category?: string | null;
          requested_by?: string | null;
          webhook_event_id?: string | null;
          started_at?: string | null;
          completed_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      bank_sync_runs: {
        Row: BankSyncRunRow;
        Insert: {
          id?: string;
          organization_id: string;
          job_id: string;
          connection_id: string;
          attempt: number;
          status?: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
          started_at?: string;
          completed_at?: string | null;
          duration_ms?: number | null;
          failure_category?: string | null;
        };
        Update: {
          status?: "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
          completed_at?: string | null;
          duration_ms?: number | null;
          failure_category?: string | null;
        };
        Relationships: [];
      };
      bank_external_transactions: {
        Row: BankExternalTransactionRow;
        Insert: {
          id?: string;
          organization_id: string;
          connection_id: string;
          linked_account_id: string;
          provider: string;
          provider_transaction_id: string;
          status: BankExternalStatusValue;
          direction: "DEBIT" | "CREDIT";
          amount_decimal: string;
          amount_minor?: number | null;
          currency: string;
          transaction_date: string;
          content_hash: string;
        };
        Update: {
          reconciliation_state?: string;
          review_reason?: string | null;
          needs_reconciliation?: boolean;
        };
        Relationships: [];
      };
      bank_provider_secrets: {
        Row: BankProviderSecretRow;
        Insert: {
          id?: string;
          organization_id: string;
          connection_id: string;
          provider: string;
          key_id: string;
          algorithm: "AES-256-GCM";
          iv: string;
          ciphertext: string;
          auth_tag: string;
          created_at?: string;
          rotated_at?: string | null;
        };
        Update: {
          key_id?: string;
          algorithm?: "AES-256-GCM";
          iv?: string;
          ciphertext?: string;
          auth_tag?: string;
          rotated_at?: string | null;
        };
        Relationships: [];
      };
      bank_transaction_revisions: {
        Row: BankTransactionRevisionRow;
        Insert: {
          id?: string;
          organization_id: string;
          external_transaction_id: string;
          revision: number;
          change_kind: string;
          status: string;
          amount_decimal: string;
          currency: string;
          transaction_date: string;
          reconciliation_state: string;
        };
        Update: {
          actor_id?: string | null;
          sync_run_id?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<never, never>;
    Functions: {
      /** 0047 — every bank function is service-role only. */
      bank_claim_sync_job: {
        Args: { p_organization_id: string; p_job_id: string; p_lease_seconds: number };
        Returns: string | null;
      };
      bank_claim_next_sync_jobs: {
        Args: { p_limit: number; p_lease_seconds: number; p_worker: string };
        Returns: { job_id: string; organization_id: string; connection_id: string; trigger: BankSyncTriggerValue; attempt: number; run_id: string }[];
      };
      bank_heartbeat_sync_job: {
        Args: { p_organization_id: string; p_run_id: string; p_worker: string | null; p_lease_seconds: number };
        Returns: string;
      };
      bank_reclaim_expired_sync_leases: {
        Args: { p_limit: number };
        Returns: number;
      };
      bank_connections_due_for_sync: {
        Args: { p_limit: number; p_min_interval_seconds: number };
        Returns: { connection_id: string; organization_id: string; provider: string }[];
      };
      bank_ingest_sync_page: {
        Args: {
          p_organization_id: string;
          p_run_id: string;
          p_cursor_before: string | null;
          p_cursor_after: string;
          p_has_more: boolean;
          p_accounts: Json;
          p_transactions: Json;
          p_removed: Json;
          p_rejected: number;
          p_lease_seconds: number;
        };
        Returns: Json;
      };
      bank_reset_page_cursor: {
        Args: { p_organization_id: string; p_connection_id: string };
        Returns: undefined;
      };
      bank_match_candidates: {
        Args: {
          p_organization_id: string;
          p_account_id: string;
          p_kind: TransactionKind;
          p_amount_minor: number;
          p_currency: string;
          p_date_from: string;
          p_date_to: string;
        };
        Returns: { id: string; account_id: string; kind: TransactionKind; amount_minor: number; currency: string; occurred_on: string; source: string }[];
      };
      bank_reconcile_transaction: {
        Args: {
          p_organization_id: string;
          p_external_id: string;
          p_expected_revision: number;
          p_decision: Json;
          p_run_id: string | null;
          p_actor: string | null;
          p_resolution: boolean;
        };
        Returns: string;
      };
      bank_complete_sync_run: {
        Args: {
          p_organization_id: string;
          p_run_id: string;
          p_outcome: string;
          p_failure_category: string | null;
          p_next_attempt_at: string | null;
          p_counts_against_connection: boolean;
          p_duration_ms: number;
        };
        Returns: string;
      };
      bank_transition_connection: {
        Args: {
          p_organization_id: string;
          p_connection_id: string;
          p_expected_status: string;
          p_to: string;
          p_reason: string;
          p_event_at: string | null;
        };
        Returns: string;
      };
      bank_link_account: {
        Args: { p_organization_id: string; p_linked_account_id: string; p_account_id: string | null; p_import_mode: string; p_actor: string | null };
        Returns: string;
      };
      bank_finalize_disconnect: {
        Args: { p_organization_id: string; p_connection_id: string; p_actor: string | null };
        Returns: string;
      };
      bank_enqueue_sync_job: {
        Args: {
          p_organization_id: string;
          p_connection_id: string;
          p_trigger: string;
          p_idempotency_key: string;
          p_requested_by: string | null;
          p_webhook_event_id: string | null;
        };
        Returns: { job_id: string | null; outcome: string }[];
      };
      bank_claim_webhook_event: {
        Args: {
          p_provider: string;
          p_provider_event_id: string;
          p_event_type: string;
          p_provider_event_type: string;
          p_provider_connection_id: string | null;
          p_occurred_at: string | null;
          p_payload_sha256: string;
          p_lease_seconds: number;
        };
        Returns: { event_id: string; claimed: boolean; status: string; payload_matches: boolean }[];
      };
      bank_complete_webhook_event: {
        Args: {
          p_event_id: string;
          p_status: string;
          p_outcome: string | null;
          p_failure_category: string | null;
          p_organization_id: string | null;
          p_connection_id: string | null;
        };
        Returns: string;
      };
      /** 0046 — service role only. Records an extraction, its fields and the
       *  job's completion in one transaction. */
      record_document_extraction: {
        Args: { p_organization_id: string; p_job_id: string; p_extraction: Json; p_fields: Json };
        Returns: string;
      };
      /** supabase/migrations/0037 — SECURITY DEFINER, callable by `anon`.
       *  Returns at most the ONE invoice a capability token unlocks, and
       *  nothing for a draft. The function body is the access control. */
      invoice_by_public_token: {
        Args: { p_token: string };
        Returns: {
          id: string;
          organization_id: string;
          organization_name: string;
          invoice_number: string;
          status: InvoiceStatus;
          currency: string;
          issue_date: string;
          due_date: string | null;
          subtotal_minor: number;
          tax_minor: number;
          total_minor: number;
          notes: string | null;
          payment_url: string | null;
          customer_name: string;
          sent_at: string | null;
        }[];
      };
      invoice_line_items_by_public_token: {
        Args: { p_token: string };
        Returns: {
          position: number;
          description: string;
          quantity: number;
          unit_price_minor: number;
          tax_rate: number;
          amount_minor: number;
        }[];
      };
      /** supabase/migrations/0035_stripe_billing.sql — service-role only.
       *  Claims the Stripe event id and applies it in one transaction.
       *  Returns 'applied' | 'duplicate' | 'stale' | 'unknown_customer'. */
      apply_stripe_subscription_event: {
        Args: {
          p_event_id: string;
          p_event_type: string;
          p_event_created: string | null;
          p_organization_id: string | null;
          p_stripe_customer_id: string | null;
          p_stripe_subscription_id: string | null;
          p_stripe_price_id: string | null;
          p_plan_id: PlanTier;
          p_status: SubscriptionStatus;
          p_current_period_start: string | null;
          p_current_period_end: string | null;
          p_cancel_at_period_end: boolean;
          p_canceled_at: string | null;
        };
        Returns: string;
      };
      /** supabase/migrations/0035_stripe_billing.sql — service-role only. */
      bind_stripe_customer: {
        Args: { p_organization_id: string; p_stripe_customer_id: string };
        Returns: undefined;
      };
      acquire_organization_billing_teardown: {
        Args: { p_organization_id: string; p_attempt_id: string };
        Returns: boolean;
      };
      release_organization_billing_teardown: {
        Args: { p_organization_id: string; p_attempt_id: string };
        Returns: undefined;
      };
      record_stripe_subscription_terminal: {
        Args: { p_organization_id: string; p_stripe_subscription_id: string; p_status: SubscriptionStatus; p_canceled_at: string };
        Returns: boolean;
      };
      record_audit_event: {
        Args: {
          p_organization_id: string;
          p_action: string;
          p_resource_type?: string | null;
          p_resource_id?: string | null;
          p_metadata?: Json;
          p_actor_type?: string;
        };
        Returns: number;
      };
      /** supabase/migrations/0026_rate_limiting.sql — service-role only. */
      consume_rate_limit: {
        Args: {
          p_namespace: string;
          p_key_hash: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: { allowed: boolean; remaining: number; retry_after_seconds: number }[];
      };
      /**
       * supabase/migrations/0027_financial_aggregates.sql — the authoritative
       * money aggregates. `security invoker`, so RLS scopes them exactly as it
       * scopes a direct select; `p_organization_id` narrows the scan, it does
       * not grant access.
       */
      /** 0053: whether a person may enter transactions by hand into this account. */
      account_accepts_manual_entry: {
        Args: { p_account_id: string };
        Returns: boolean;
      };
      /** 0053: internal operational counts since a point in time. Service role only. */
      operations_summary: {
        Args: { p_since: string };
        Returns: Json;
      };
      /** 0053: the latest migration that (re)defined it. Service role only. */
      operations_schema_version: {
        Args: Record<string, never>;
        Returns: string;
      };
      account_balances_minor: {
        Args: { p_organization_id: string };
        Returns: { account_id: string; currency: string; balance_minor: number }[];
      };
      transaction_totals: {
        Args: {
          p_organization_id: string;
          p_kind?: "income" | "expense" | "transfer" | null;
          p_account_id?: string | null;
          p_category_id?: string | null;
          p_merchant_id?: string | null;
          p_date_from?: string | null;
          p_date_to?: string | null;
          p_amount_min_minor?: number | null;
          p_amount_max_minor?: number | null;
          p_is_reviewed?: boolean | null;
          p_categorized_by?: string | null;
          p_search?: string | null;
        };
        Returns: {
          currency: string;
          kind: "income" | "expense" | "transfer";
          total_minor: number;
          transaction_count: number;
          unreviewed_count: number;
        }[];
      };
      transaction_category_totals: {
        Args: { p_organization_id: string; p_date_from?: string | null; p_date_to?: string | null };
        Returns: { category_id: string | null; currency: string; total_minor: number }[];
      };
    };
    Enums: {
      user_entity_type: UserEntityType;
      org_role: OrgRole;
      transaction_kind: TransactionKind;
      invoice_status: InvoiceStatus;
      document_kind: DocumentKind;
      document_status: DocumentStatus;
      ai_message_role: AiMessageRole;
      ai_operation_mode: AiOperationMode;
      ai_action_status: AiActionStatus;
      plan_tier: PlanTier;
      subscription_status: SubscriptionStatus;
      notification_kind: NotificationKind;
    };
  };
}
