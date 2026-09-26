import type { TestDatabase } from "../rls/harness";
import {
  decisionPayload,
  ingestPayload,
  toManualCandidate,
  toReconciliationRow,
  type BankConnectionRecord,
  type BankStore,
  type BankSyncJobRecord,
  type ExternalDbRow,
  type HeartbeatOutcome,
  type LedgerDbRow,
  type LinkedAccountDbRow,
  type ReconciliationRow,
} from "@/server/bank-connections/store";

/**
 * TEST-ONLY: the bank store over real Postgres (PGlite), calling the same SQL
 * functions from migration 0047 that the Supabase store calls through
 * PostgREST, as `service_role` — the role the admin client uses. The engine
 * tests therefore run the production engine against the production SQL.
 */

type Row = Record<string, unknown>;

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value));

export function createPgliteBankStore(db: TestDatabase): BankStore {
  const run = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    db.asAdmin(async (query) => {
      await query("set role service_role");
      try {
        return (await query(sql, params)).rows as T[];
      } finally {
        await query("reset role");
      }
    });
  const one = async <T>(sql: string, params: unknown[] = []): Promise<T | null> => (await run<T>(sql, params))[0] ?? null;
  const value = async (sql: string, params: unknown[] = []): Promise<string> => String(Object.values((await one<Row>(sql, params)) ?? {})[0]);

  const toConnection = (row: Row): BankConnectionRecord => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    provider: String(row.provider),
    providerConnectionId: String(row.provider_connection_id),
    providerEnvironment: (row.provider_environment as string | null) ?? null,
    institutionName: (row.institution_name as string | null) ?? null,
    status: row.status as BankConnectionRecord["status"],
    statusReason: row.status_reason as BankConnectionRecord["statusReason"],
    lastProviderEventAt: iso(row.last_provider_event_at),
    consecutiveFailedRuns: Number(row.consecutive_failed_runs),
    pageCursor: (row.page_cursor as string | null) ?? null,
    committedCursor: (row.committed_cursor as string | null) ?? null,
    lastSuccessfulSyncAt: iso(row.last_successful_sync_at),
  });

  const toJob = (row: Row): BankSyncJobRecord => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    connectionId: String(row.connection_id),
    status: row.status as BankSyncJobRecord["status"],
    trigger: row.trigger as BankSyncJobRecord["trigger"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: iso(row.next_attempt_at),
    leaseExpiresAt: iso(row.lease_expires_at),
  });

  const EXTERNAL_COLUMNS = `e.id, e.connection_id, e.linked_account_id, e.revision, e.status, e.direction, e.amount_minor, e.currency, e.transaction_date::text as transaction_date,
    e.merchant_name, e.description, e.category_hint, e.transfer_counterpart_id, e.reconciliation_state, e.review_reason, e.review_resolved_revision, e.ledger_transaction_id, e.ledger_link_kind,
    e.ledger_linked_at::text as ledger_linked_at, e.ledger_written_account_id, e.ledger_written_kind, e.ledger_written_amount_minor, e.ledger_written_currency,
    e.ledger_written_occurred_on::text as ledger_written_occurred_on, e.ledger_written_description, e.created_at::text as created_at`;

  async function rowsFor(organizationId: string, externals: ExternalDbRow[]): Promise<ReconciliationRow[]> {
    if (externals.length === 0) return [];
    const links = await run<LinkedAccountDbRow>(
      `select id, import_mode, account_id, currency, detached_at::text as detached_at from bank_linked_accounts where organization_id = $1 and id in (select value::uuid from jsonb_array_elements_text($2::jsonb))`,
      [organizationId, JSON.stringify([...new Set(externals.map((e) => e.linked_account_id))])],
    );
    const accountIds = links.map((link) => link.account_id).filter((id): id is string => id !== null);
    const accounts = accountIds.length
      ? await run<{ id: string; currency: string; kind: string }>(`select id, currency, kind from accounts where organization_id = $1 and id in (select value::uuid from jsonb_array_elements_text($2::jsonb))`, [organizationId, JSON.stringify(accountIds)])
      : [];
    const ledgerIds = externals.map((e) => e.ledger_transaction_id).filter((id): id is string => id !== null);
    const ledger = ledgerIds.length
      ? await run<LedgerDbRow>(
          `select id, account_id, kind, amount_minor, currency, occurred_on::text as occurred_on, description, source from transactions where organization_id = $1 and id in (select value::uuid from jsonb_array_elements_text($2::jsonb))`,
          [organizationId, JSON.stringify(ledgerIds)],
        )
      : [];
    const linkById = new Map(links.map((link) => [link.id, link]));
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const ledgerById = new Map(ledger.map((row) => [row.id, row]));
    return externals.flatMap((external) => {
      const link = linkById.get(external.linked_account_id);
      if (!link) return [];
      return [toReconciliationRow(external, link, link.account_id ? (accountById.get(link.account_id) ?? null) : null, external.ledger_transaction_id ? (ledgerById.get(external.ledger_transaction_id) ?? null) : null)];
    });
  }

  const CONNECTION_COLUMNS = "id, organization_id, provider, provider_connection_id, provider_environment, institution_name, status, status_reason, last_provider_event_at, consecutive_failed_runs, page_cursor, committed_cursor, last_successful_sync_at";
  const JOB_COLUMNS = "id, organization_id, connection_id, status, trigger, attempts, max_attempts, next_attempt_at, lease_expires_at";

  return {
    async getConnection(organizationId, connectionId) {
      const row = await one<Row>(`select ${CONNECTION_COLUMNS} from bank_connections where id = $1 and organization_id = $2`, [connectionId, organizationId]);
      return row ? toConnection(row) : null;
    },
    async findConnectionByProvider(provider, providerConnectionId) {
      const row = await one<Row>(`select ${CONNECTION_COLUMNS} from bank_connections where provider = $1 and provider_connection_id = $2`, [provider, providerConnectionId]);
      return row ? toConnection(row) : null;
    },
    async createConnection(input) {
      return value(
        `insert into bank_connections (organization_id, provider, provider_connection_id, institution_id, institution_name, provider_environment, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [input.organizationId, input.provider, input.providerConnectionId, input.institutionId, input.institutionName, input.providerEnvironment, input.createdBy],
      );
    },
    async storeCredentialRef(input) {
      await run(`insert into bank_connection_credentials (connection_id, organization_id, secret_ref) values ($1, $2, $3)`, [input.connectionId, input.organizationId, input.secretRef]);
    },
    async getCredentialRef(organizationId, connectionId) {
      return (await one<{ secret_ref: string }>(`select secret_ref from bank_connection_credentials where connection_id = $1 and organization_id = $2`, [connectionId, organizationId]))?.secret_ref ?? null;
    },
    async listCredentialRefs(organizationId) {
      const rows = await run<{ connection_id: string; provider: string; secret_ref: string }>(
        `select c.connection_id, b.provider, c.secret_ref from bank_connection_credentials c join bank_connections b on b.id = c.connection_id where c.organization_id = $1 limit 1000`,
        [organizationId],
      );
      return rows.map((row) => ({ connectionId: row.connection_id, provider: row.provider, secretRef: row.secret_ref }));
    },
    async getJob(organizationId, jobId) {
      const row = await one<Row>(`select ${JOB_COLUMNS} from bank_sync_jobs where id = $1 and organization_id = $2`, [jobId, organizationId]);
      return row ? toJob(row) : null;
    },
    async getActiveJob(organizationId, connectionId) {
      const row = await one<Row>(`select ${JOB_COLUMNS} from bank_sync_jobs where connection_id = $1 and organization_id = $2 and status in ('QUEUED', 'RUNNING', 'RETRYABLE')`, [connectionId, organizationId]);
      return row ? toJob(row) : null;
    },
    async enqueueJob(input) {
      const row = await one<{ job_id: string | null; outcome: string }>(`select * from bank_enqueue_sync_job($1, $2, $3, $4, $5, $6)`, [
        input.organizationId,
        input.connectionId,
        input.trigger,
        input.idempotencyKey,
        input.requestedBy,
        input.webhookEventId,
      ]);
      return { jobId: row?.job_id ?? null, outcome: (row?.outcome ?? "NOT_FOUND") as never };
    },
    async claimJob(organizationId, jobId, leaseSeconds) {
      const row = await one<{ run: string | null }>(`select bank_claim_sync_job($1, $2, $3) as run`, [organizationId, jobId, leaseSeconds]);
      return row?.run ?? null;
    },
    async claimNextJobs(input) {
      const rows = await run<Row>(`select * from bank_claim_next_sync_jobs($1, $2, $3)`, [input.limit, input.leaseSeconds, input.workerId]);
      return rows.map((row) => ({
        jobId: String(row.job_id),
        organizationId: String(row.organization_id),
        connectionId: String(row.connection_id),
        trigger: row.trigger as BankSyncJobRecord["trigger"],
        attempt: Number(row.attempt),
        runId: String(row.run_id),
      }));
    },
    async heartbeatRun(input) {
      return value(`select bank_heartbeat_sync_job($1, $2, $3, $4)`, [input.organizationId, input.runId, input.workerId, input.leaseSeconds]) as Promise<HeartbeatOutcome>;
    },
    async reclaimExpiredLeases(limit) {
      return Number(await value(`select bank_reclaim_expired_sync_leases($1)`, [limit]));
    },
    async queueHealth() {
      const row = await one<Row>(
        `select
           (select count(*)::int from bank_sync_jobs where status in ('QUEUED', 'RETRYABLE') and (next_attempt_at is null or next_attempt_at <= now())) as due_jobs,
           (select extract(epoch from now() - min(coalesce(next_attempt_at, created_at)))::int from bank_sync_jobs
              where status in ('QUEUED', 'RETRYABLE') and (next_attempt_at is null or next_attempt_at <= now())) as oldest_due_age_seconds,
           (select count(*)::int from bank_sync_jobs where status = 'RUNNING' and lease_expires_at < now()) as running_past_lease`,
      );
      return {
        dueJobs: Number(row?.due_jobs ?? 0),
        oldestDueAgeSeconds: row?.oldest_due_age_seconds === null || row?.oldest_due_age_seconds === undefined ? null : Math.max(0, Number(row.oldest_due_age_seconds)),
        runningPastLease: Number(row?.running_past_lease ?? 0),
      };
    },
    async listConnectionsDueForSync(input) {
      const rows = await run<Row>(`select * from bank_connections_due_for_sync($1, $2)`, [input.limit, input.minIntervalSeconds]);
      return rows.map((row) => ({ connectionId: String(row.connection_id), organizationId: String(row.organization_id), provider: String(row.provider) }));
    },
    async completeRun(input) {
      return value(`select bank_complete_sync_run($1, $2, $3, $4, $5, $6, $7)`, [
        input.organizationId,
        input.runId,
        input.outcome,
        input.failureCategory,
        input.nextAttemptAt ? input.nextAttemptAt.toISOString() : null,
        input.countsAgainstConnection,
        Math.max(0, Math.round(input.durationMs)),
      ]);
    },
    async ingestPage(input) {
      const payload = ingestPayload(input.page, input.hash);
      const row = await one<{ result: unknown }>(`select bank_ingest_sync_page($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10) as result`, [
        input.organizationId,
        input.runId,
        input.cursorBefore,
        input.page.nextCursor,
        input.page.hasMore,
        JSON.stringify(payload.accounts),
        JSON.stringify(payload.transactions),
        JSON.stringify(payload.removed),
        payload.rejected,
        input.leaseSeconds,
      ]);
      return row!.result as never;
    },
    async resetPageCursor(organizationId, connectionId) {
      await run(`select bank_reset_page_cursor($1, $2)`, [organizationId, connectionId]);
    },
    async listToReconcile(organizationId, connectionId, limit, after) {
      const externals = await run<ExternalDbRow>(
        `select ${EXTERNAL_COLUMNS} from bank_external_transactions e where e.organization_id = $1 and e.connection_id = $2 and e.needs_reconciliation and ($3::uuid is null or e.id > $3::uuid) order by e.id limit $4`,
        [organizationId, connectionId, after?.id ?? null, Math.max(1, Math.min(limit, 100))],
      );
      return rowsFor(organizationId, externals);
    },
    async getReconciliationRow(organizationId, externalId) {
      const externals = await run<ExternalDbRow>(`select ${EXTERNAL_COLUMNS} from bank_external_transactions e where e.organization_id = $1 and e.id = $2`, [organizationId, externalId]);
      return (await rowsFor(organizationId, externals))[0] ?? null;
    },
    async matchCandidates(organizationId, query) {
      const rows = await run<{ id: string; account_id: string; kind: "income" | "expense" | "transfer"; amount_minor: number; currency: string; occurred_on: string; source: string }>(
        `select id, account_id, kind, amount_minor, currency, occurred_on::text as occurred_on, source from bank_match_candidates($1, $2, $3, $4, $5, $6, $7)`,
        [organizationId, query.accountId, query.kind, query.amountMinor, query.currency, query.dateFrom, query.dateTo],
      );
      return rows.map(toManualCandidate);
    },
    async transferCandidates(organizationId, externalId) {
      const rows = await run<Record<string, unknown>>(
        `select id, organization_id, linked_account_id, account_id, account_kind, direction, amount_minor, currency,
                transaction_date::text as transaction_date, status, category_hint, reconciliation_state,
                ledger_transaction_id, transfer_counterpart_id, importable, revision
           from bank_transfer_candidates($1, $2)`,
        [organizationId, externalId],
      );
      return rows.map((row) => ({
        id: String(row.id),
        organizationId: String(row.organization_id),
        linkedAccountId: String(row.linked_account_id),
        accountId: row.account_id ? String(row.account_id) : null,
        accountKind: (row.account_kind ?? null) as never,
        direction: row.direction as "DEBIT" | "CREDIT",
        amountMinor: row.amount_minor === null ? null : Number(row.amount_minor),
        currency: String(row.currency),
        transactionDate: String(row.transaction_date).slice(0, 10),
        status: row.status as never,
        categoryHint: row.category_hint ? String(row.category_hint) : null,
        reconciliationState: row.reconciliation_state as never,
        ledgerTransactionId: row.ledger_transaction_id ? String(row.ledger_transaction_id) : null,
        transferCounterpartId: row.transfer_counterpart_id ? String(row.transfer_counterpart_id) : null,
        importable: row.importable === true,
        revision: Number(row.revision),
      }));
    },
    async pairInternalTransfer(input) {
      return (await value(`select bank_pair_internal_transfer($1, $2, $3, $4, $5, $6, $7)`, [
        input.organizationId,
        input.sourceExternalId,
        input.counterpartExternalId,
        input.expectedSourceRevision,
        input.expectedCounterpartRevision,
        input.runId,
        input.actorId,
      ])) as never;
    },
    async reconcile(input) {
      return (await value(`select bank_reconcile_transaction($1, $2, $3, $4::jsonb, $5, $6, $7)`, [
        input.organizationId,
        input.externalId,
        input.expectedRevision,
        JSON.stringify(decisionPayload(input.decision, input.acknowledged)),
        input.runId,
        input.actorId,
        input.resolution,
      ])) as never;
    },
    async transitionConnection(input) {
      return (await value(`select bank_transition_connection($1, $2, $3, $4, $5, $6)`, [input.organizationId, input.connectionId, input.expectedStatus, input.to, input.reason, input.eventAt])) as never;
    },
    async finalizeDisconnect(organizationId, connectionId, actorId) {
      return (await value(`select bank_finalize_disconnect($1, $2, $3)`, [organizationId, connectionId, actorId])) as never;
    },
    async getLinkedAccount(organizationId, linkedAccountId) {
      const row = await one<Row>(`select id, connection_id, import_mode, account_id, detached_at, account_type, account_subtype from bank_linked_accounts where organization_id = $1 and id = $2`, [organizationId, linkedAccountId]);
      return row
        ? {
            id: String(row.id),
            connectionId: String(row.connection_id),
            importMode: row.import_mode as never,
            accountId: (row.account_id as string | null) ?? null,
            detached: row.detached_at !== null,
            accountType: row.account_type as never,
            accountSubtype: (row.account_subtype as string | null) ?? null,
          }
        : null;
    },
    async getAccountKind(organizationId, accountId) {
      const row = await one<Row>(`select kind from accounts where organization_id = $1 and id = $2`, [organizationId, accountId]);
      return row ? String(row.kind) : null;
    },
    async autoImportAccounts(organizationId, connectionId) {
      return Number(await value(`select bank_auto_import_accounts($1, $2)`, [organizationId, connectionId]));
    },
    async importLinkedAccount(input) {
      return (await value(`select bank_import_linked_account($1, $2, $3)`, [input.organizationId, input.linkedAccountId, input.actorId])) as never;
    },
    async anchorAccountBalances(organizationId, connectionId) {
      return Number(await value(`select bank_anchor_account_balances($1, $2)`, [organizationId, connectionId]));
    },
    async linkAccount(input) {
      return (await value(`select bank_link_account($1, $2, $3, $4, $5)`, [input.organizationId, input.linkedAccountId, input.accountId, input.importMode, input.actorId])) as never;
    },
    async claimWebhookEvent(input) {
      const row = await one<{ event_id: string; claimed: boolean; status: string; payload_matches: boolean }>(`select * from bank_claim_webhook_event($1, $2, $3, $4, $5, $6, $7, $8)`, [
        input.provider,
        input.providerEventId,
        input.eventType,
        input.providerEventType,
        input.providerConnectionId,
        input.occurredAt,
        input.payloadSha256,
        input.leaseSeconds,
      ]);
      return { eventId: row!.event_id, claimed: row!.claimed, status: row!.status as never, payloadMatches: row!.payload_matches };
    },
    async completeWebhookEvent(input) {
      return value(`select bank_complete_webhook_event($1, $2, $3, $4, $5, $6)`, [
        input.eventId,
        input.status,
        input.outcome,
        input.status === "FAILED" ? "INTERNAL_ERROR" : null,
        input.organizationId,
        input.connectionId,
      ]);
    },
  };
}
