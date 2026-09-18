import { createRoot } from "react-dom/client";
import { BankConnectionsView } from "@/components/bank-connections/bank-connections-view";
import type { BankConnectionsWorkspace } from "@/server/bank-connections/workspace";

/**
 * TEST-ONLY. Renders the REAL Bank connections view with synthetic workspace
 * states, its Server Actions replaced by recorders (bank-actions-stub.ts).
 *
 * The "empty" state keeps the provider NOT configured — this deployment's
 * truth. The others show what the page must still render honestly when rows
 * exist: "history" has a connection that needs sign-in, one already
 * disconnected and a review queue; "worker" has the four states background
 * sync work can be in. None of them pretends a bank is connected — each
 * connection's status is exactly what its data says.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NOT_CONFIGURED = "No bank connection provider is configured for this deployment, so nothing is imported automatically. Accounts and transactions are recorded by hand.";

const manualAccounts: BankConnectionsWorkspace["manualAccounts"] = [
  { id: "a1111111-1111-4111-8111-111111111111", name: "Checking", currency: "USD", kind: "bank", bankFed: false },
  { id: "a2222222-2222-4222-8222-222222222222", name: "Savings", currency: "USD", kind: "bank", bankFed: false },
  { id: "a3333333-3333-4333-8333-333333333333", name: "Euro account", currency: "EUR", kind: "bank", bankFed: false },
];

const empty: BankConnectionsWorkspace = {
  provider: { configured: false, name: null, message: NOT_CONFIGURED, environment: null },
  access: { entitled: true, planName: "Premium", canConnect: false },
  connections: [],
  reviewItems: [],
  manualAccounts,
};

/** A provider exists; this workspace's plan does not include it. */
const planLocked: BankConnectionsWorkspace = {
  provider: { configured: true, name: "Plaid", message: null, environment: "production" },
  access: { entitled: false, planName: "the Free plan", canConnect: false },
  connections: [],
  reviewItems: [],
  manualAccounts,
};

/** Configured, entitled, and pointed at a SANDBOX — the state a developer sees. */
const ready: BankConnectionsWorkspace = {
  provider: { configured: true, name: "Plaid", message: null, environment: "sandbox" },
  access: { entitled: true, planName: "Premium", canConnect: true },
  connections: [],
  reviewItems: [],
  manualAccounts,
};

const history: BankConnectionsWorkspace = {
  provider: { configured: true, name: "Plaid", message: null, environment: "sandbox" },
  access: { entitled: true, planName: "Premium", canConnect: true },
  connections: [
    {
      id: "c1111111-1111-4111-8111-111111111111",
      provider: "plaid",
      providerEnvironment: "sandbox",
      institutionName: "Synthetic Credit Union",
      status: "REQUIRES_REAUTH",
      statusReason: "PROVIDER_REPORTED_REAUTH",
      statusChangedAt: "2026-09-14T09:00:00Z",
      consecutiveFailedRuns: 1,
      lastFailureCategory: "REAUTH_REQUIRED",
      lastSuccessfulSyncAt: "2026-09-13T16:20:00Z",
      lastSyncAttemptAt: "2026-09-14T09:00:00Z",
      disconnectedAt: null,
      createdAt: "2026-09-01T10:00:00Z",
      linkedAccounts: [
        {
          id: "l1111111-1111-4111-8111-111111111111",
          connectionId: "c1111111-1111-4111-8111-111111111111",
          accountId: manualAccounts[0].id,
          accountName: "Checking",
          importMode: "IMPORT",
          accountType: "DEPOSITORY",
          accountSubtype: "checking",
          displayName: "Everyday Checking with a deliberately long name that must wrap on a phone",
          mask: "3333",
          currency: "USD",
          currentBalanceMinor: 1_043_20,
          availableBalanceMinor: 1_000_00,
          balancesAsOf: "2026-09-13T16:20:00Z",
          providerState: "OPEN",
          detached: false,
        },
        {
          id: "l2222222-2222-4222-8222-222222222222",
          connectionId: "c1111111-1111-4111-8111-111111111111",
          accountId: null,
          accountName: null,
          importMode: "AWAITING_DECISION",
          accountType: "DEPOSITORY",
          accountSubtype: "savings",
          displayName: "High-Yield Savings",
          mask: "9012",
          currency: "USD",
          currentBalanceMinor: null,
          availableBalanceMinor: null,
          balancesAsOf: null,
          providerState: "OPEN",
          detached: false,
        },
      ],
      latestJob: null,
      reviewCount: 2,
      pendingCount: 1,
      transactionCount: 214,
    },
    {
      id: "c2222222-2222-4222-8222-222222222222",
      provider: "plaid",
      providerEnvironment: "sandbox",
      institutionName: "Former Savings Bank",
      status: "DISCONNECTED",
      statusReason: "USER_DISCONNECTED",
      statusChangedAt: "2026-08-30T12:00:00Z",
      consecutiveFailedRuns: 0,
      lastFailureCategory: null,
      lastSuccessfulSyncAt: "2026-08-29T08:00:00Z",
      lastSyncAttemptAt: "2026-08-29T08:00:00Z",
      disconnectedAt: "2026-08-30T12:00:00Z",
      createdAt: "2026-06-01T10:00:00Z",
      linkedAccounts: [
        {
          id: "l3333333-3333-4333-8333-333333333333",
          connectionId: "c2222222-2222-4222-8222-222222222222",
          accountId: manualAccounts[1].id,
          accountName: "Savings",
          importMode: "IMPORT",
          accountType: "DEPOSITORY",
          accountSubtype: "savings",
          displayName: "Old Savings",
          mask: "4444",
          currency: "USD",
          currentBalanceMinor: null,
          availableBalanceMinor: null,
          balancesAsOf: null,
          providerState: "OPEN",
          detached: true,
        },
      ],
      latestJob: null,
      reviewCount: 0,
      pendingCount: 0,
      transactionCount: 88,
    },
  ],
  reviewItems: [
    {
      id: "e1111111-1111-4111-8111-111111111111",
      connectionId: "c1111111-1111-4111-8111-111111111111",
      linkedAccountId: "l1111111-1111-4111-8111-111111111111",
      status: "POSTED",
      direction: "DEBIT",
      amountMinor: 42_50,
      amountDecimal: "42.5",
      currency: "USD",
      transactionDate: "2026-09-10",
      merchantName: "Corner Coffee",
      description: null,
      reviewReason: "AMBIGUOUS_MANUAL_MATCH",
      ledgerTransactionId: null,
    },
    {
      id: "e2222222-2222-4222-8222-222222222222",
      connectionId: "c1111111-1111-4111-8111-111111111111",
      linkedAccountId: "l1111111-1111-4111-8111-111111111111",
      status: "POSTED",
      direction: "CREDIT",
      amountMinor: 4_200_00,
      amountDecimal: "4200",
      currency: "USD",
      transactionDate: "2026-09-01",
      merchantName: "Employer Payroll",
      description: null,
      reviewReason: "PROVIDER_CHANGED_AFTER_EDIT",
      ledgerTransactionId: "t1111111-1111-4111-8111-111111111111",
    },
  ],
  manualAccounts: manualAccounts.map((account, index) => ({ ...account, bankFed: index === 0 })),
};

/**
 * The four things the background worker can be doing for a connection, so the
 * page can be checked for saying each of them once and only once. Every job
 * below is a state the `bank_sync_jobs` table can actually hold.
 */
const connectionInJobState = (
  index: number,
  institutionName: string,
  status: BankConnectionsWorkspace["connections"][number]["status"],
  statusReason: BankConnectionsWorkspace["connections"][number]["statusReason"],
  latestJob: BankConnectionsWorkspace["connections"][number]["latestJob"],
): BankConnectionsWorkspace["connections"][number] => ({
  id: `c${index}${index}${index}${index}${index}${index}${index}${index}-1111-4111-8111-11111111111${index}`,
  provider: "plaid",
  providerEnvironment: "sandbox",
  institutionName,
  status,
  statusReason,
  statusChangedAt: "2026-09-16T09:00:00Z",
  consecutiveFailedRuns: status === "DEGRADED" ? 1 : 0,
  lastFailureCategory: status === "DEGRADED" ? "PROVIDER_UNAVAILABLE" : status === "ERROR" ? "PROVIDER_UNAVAILABLE" : null,
  lastSuccessfulSyncAt: "2026-09-16T06:00:00Z",
  lastSyncAttemptAt: "2026-09-16T09:00:00Z",
  disconnectedAt: null,
  createdAt: "2026-09-01T10:00:00Z",
  linkedAccounts: [],
  latestJob,
  reviewCount: 0,
  pendingCount: 0,
  transactionCount: 12,
});

const job = (
  id: string,
  connectionId: string,
  status: NonNullable<BankConnectionsWorkspace["connections"][number]["latestJob"]>["status"],
  attempts: number,
  nextAttemptAt: string | null,
  failureCategory: NonNullable<BankConnectionsWorkspace["connections"][number]["latestJob"]>["failureCategory"] = null,
): NonNullable<BankConnectionsWorkspace["connections"][number]["latestJob"]> => ({
  id,
  connectionId,
  status,
  trigger: "SCHEDULED",
  attempts,
  maxAttempts: 5,
  nextAttemptAt,
  failureCategory,
  startedAt: status === "QUEUED" ? null : "2026-09-16T09:00:00Z",
  completedAt: status === "FAILED" ? "2026-09-16T09:05:00Z" : null,
  createdAt: "2026-09-16T08:59:00Z",
});

const worker: BankConnectionsWorkspace = {
  provider: { configured: true, name: "Plaid", message: null, environment: "sandbox" },
  access: { entitled: true, planName: "Premium", canConnect: true },
  connections: [
    connectionInJobState(1, "Queued Credit Union", "ACTIVE", "SYNC_SUCCEEDED", job("j1111111-1111-4111-8111-111111111111", "c11111111-1111-4111-8111-111111111111", "QUEUED", 0, null)),
    connectionInJobState(2, "Running Savings Bank", "ACTIVE", "SYNC_SUCCEEDED", job("j2222222-2222-4222-8222-222222222222", "c22222222-2222-4222-8222-222222222222", "RUNNING", 1, null)),
    connectionInJobState(3, "Retrying Mutual", "DEGRADED", "SYNC_FAILED", job("j3333333-3333-4333-8333-333333333333", "c33333333-3333-4333-8333-333333333333", "RETRYABLE", 2, "2026-09-16T09:10:00Z", "PROVIDER_UNAVAILABLE")),
    connectionInJobState(4, "Stopped Trust", "ERROR", "REPEATED_SYNC_FAILURE", job("j4444444-4444-4444-8444-444444444444", "c44444444-4444-4444-8444-444444444444", "FAILED", 5, null, "PROVIDER_UNAVAILABLE")),
  ],
  reviewItems: [],
  manualAccounts,
};

const params = new URLSearchParams(window.location.search);
const STATES: Record<string, BankConnectionsWorkspace> = { empty, plan: planLocked, ready, history, worker };
const workspace = STATES[params.get("state") ?? "empty"] ?? empty;
const role = params.get("role") ?? "owner";
const permissions = {
  manage: role === "owner" || role === "admin",
  sync: role !== "viewer",
  resolve: role !== "viewer",
};

window.__bankSubmissions = [];
createRoot(document.getElementById("root")!).render(<BankConnectionsView organizationId={ORG} workspace={workspace} permissions={permissions} />);
