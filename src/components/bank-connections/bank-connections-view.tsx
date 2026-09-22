import { importedAccountKind, unsupportedAccountReason } from "@/domain/bank-connections/account-import";
import Link from "next/link";
import { Bank } from "@phosphor-icons/react/dist/ssr/Bank";
import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import {
  PageHeader,
  PageMeta,
  PageMetaItem,
  PageShell,
} from "@/components/ui/page-header";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DetailList, DetailRow } from "@/components/ui/detail-list";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Amount } from "@/components/amount";
import { money } from "@/domain/money/money";
import { isSupportedCurrency } from "@/domain/money/currency";
import { canSync } from "@/domain/bank-connections/lifecycle";
import {
  CONNECTION_REASON_TEXT,
  CONNECTION_STATUS_PRESENTATION,
  REVIEW_REASON_TEXT,
  SYNC_FAILURE_TEXT,
  importActivityText,
} from "@/domain/bank-connections/presentation";
import type { BankConnectionsWorkspace } from "@/server/bank-connections/workspace";
import { ConnectionStatusBadge, ImportModeBadge } from "./status-badges";
import {
  DisconnectConnectionDialog,
  LinkAccountForm,
  RefreshConnectionForm,
  ReviewResolutionForm,
} from "./bank-connection-forms";
import { PlaidLinkButton } from "./plaid-link-button";

/**
 * Bank connections.
 *
 * WHAT THIS PAGE REFUSES TO DO
 *
 * It never shows a bank as connected unless the database says a connection is
 * ACTIVE, never draws a provider or bank logo, and never offers a "Connect"
 * button that could only fail: this deployment has no provider, and the page
 * says exactly that before anything else. What exists without a provider is
 * still shown truthfully — the accounts kept by hand, and how imports behave
 * once a provider is added — because that is what the person needs to know.
 *
 * COMPOSITION
 *
 * A ledger page, not a dashboard (DESIGN.md §1, §26): a header, one honest
 * notice, connections as ruled panels with their accounts in a table, the
 * review queue when something needs a person, and — kept visibly separate —
 * the accounts recorded by hand. No card grid, no hero figure: a bank
 * connection has no number worth leading with, and inventing one would be
 * decoration.
 */

export interface BankConnectionsViewProps {
  organizationId: string;
  workspace: BankConnectionsWorkspace;
  permissions: { manage: boolean; sync: boolean; resolve: boolean };
}

const ACCOUNT_TYPE_LABEL = {
  DEPOSITORY: "Deposit",
  CREDIT: "Credit",
  LOAN: "Loan",
  INVESTMENT: "Investment",
  OTHER: "Other",
} as const;

const DATE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

function formatDate(isoDate: string): string {
  return DATE.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

function formatDateTime(iso: string | null): string {
  return iso ? `${DATE_TIME.format(new Date(iso))} UTC` : "never";
}

export function BankConnectionsView({
  organizationId,
  workspace,
  permissions,
}: BankConnectionsViewProps) {
  const { provider, connections, reviewItems, manualAccounts } = workspace;
  const reviewTotal = connections.reduce(
    (sum, connection) => sum + connection.reviewCount,
    0,
  );
  const fedAccountIds = new Set(
    connections.flatMap((connection) =>
      connection.linkedAccounts
        .filter((account) => account.accountId && !account.detached)
        .map((account) => account.accountId as string),
    ),
  );

  return (
    <PageShell className="gap-8">
      <PageHeader
        eyebrow="Records"
        title="Bank connections"
        description="Transactions a bank reports, brought into accounts you choose — kept separate from the accounts you record by hand."
        actions={workspace.access.canConnect && permissions.manage ? <PlaidLinkButton organizationId={organizationId} label="Connect a bank" /> : undefined}
        meta={
          connections.length > 0 ? (
            <PageMeta>
              <PageMetaItem
                label="Connections"
                value={
                  connections.filter(
                    (connection) => connection.status !== "DISCONNECTED",
                  ).length
                }
              />
              <PageMetaItem
                label="Disconnected"
                value={
                  connections.filter(
                    (connection) => connection.status === "DISCONNECTED",
                  ).length
                }
              />
              <PageMetaItem
                label="Needs review"
                value={reviewTotal}
                tone={reviewTotal > 0 ? "warning" : "neutral"}
              />
            </PageMeta>
          ) : undefined
        }
      />

      <ProviderNotice provider={provider} access={workspace.access} organizationId={organizationId} />

      <section
        aria-labelledby="bank-connections-heading"
        className="flex flex-col gap-3"
      >
        <SectionTitle id="bank-connections-heading" title="Connections" />
        {connections.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<Bank size={24} aria-hidden="true" />}
              title="No bank connected"
              description={
                workspace.access.canConnect
                  ? "Connect a bank to import its transactions into an account you choose."
                  : provider.configured
                    ? `Bank connections are part of Premium and Business. This workspace is on ${workspace.access.planName}.`
                    : "Nothing is imported from any bank on this deployment. Accounts and transactions are recorded by hand."
              }
              action={
                workspace.access.canConnect && permissions.manage ? (
                  <PlaidLinkButton organizationId={organizationId} label="Connect a bank" size="sm" />
                ) : (
                  <Button asChild variant="secondary" size="sm">
                    <Link href={`/app/${organizationId}/accounts`}>
                      Open accounts
                    </Link>
                  </Button>
                )
              }
            />
          </Panel>
        ) : (
          <div className="flex flex-col gap-6">
            {connections.map((connection) => (
              <ConnectionPanel
                key={connection.id}
                organizationId={organizationId}
                connection={connection}
                providerConfigured={provider.configured}
                permissions={permissions}
                accounts={manualAccounts}
                fedAccountIds={fedAccountIds}
              />
            ))}
          </div>
        )}
      </section>

      {reviewItems.length > 0 && (
        <ReviewQueue
          organizationId={organizationId}
          items={reviewItems}
          canResolve={permissions.resolve}
        />
      )}

      <ManualAccounts
        organizationId={organizationId}
        accounts={manualAccounts}
      />

      <HowImportsWork />
    </PageShell>
  );
}

function SectionTitle({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 id={id} className="text-[15px] font-semibold text-ink">
        {title}
      </h2>
      {description && (
        <p className="max-w-[70ch] text-[13px] text-text-secondary">
          {description}
        </p>
      )}
    </div>
  );
}

/**
 * Three different truths, never merged into one cheerful sentence:
 *
 *   * this deployment has no bank provider at all — nothing a customer can buy
 *     changes that, so it is said plainly to everyone;
 *   * a provider exists, and this workspace's plan does not include it;
 *   * a provider exists and the plan includes it.
 *
 * And, on top of any of them, whether the provider is pointed at a SANDBOX,
 * where every figure is fictional. That warning is not optional: sandbox data
 * looks exactly like money.
 */
function ProviderNotice({
  provider,
  access,
  organizationId,
}: {
  provider: BankConnectionsWorkspace["provider"];
  access: BankConnectionsWorkspace["access"];
  organizationId: string;
}) {
  const title = !provider.configured
    ? "Automatic bank imports aren't available"
    : access.entitled
      ? `Bank connections use ${provider.name}`
      : "Bank connections are part of Premium and Business";
  const body = !provider.configured
    ? provider.message
    : access.entitled
      ? "Imported transactions are checked against the ones you entered, and nothing in your books is overwritten without you."
      : `This workspace is on ${access.planName}. Bank imports start working as soon as the plan includes them — nothing else changes.`;

  // An info banner per DESIGN.md §19: a rail, not a tinted block.
  return (
    <section
      aria-labelledby="bank-provider-status"
      className="flex items-start gap-2.5 rounded-md border border-l-2 border-border-subtle border-l-accent bg-surface px-4 py-3"
    >
      <Info
        size={16}
        aria-hidden="true"
        className="mt-0.5 shrink-0 text-accent"
      />
      <div className="flex flex-col gap-1">
        <h2
          id="bank-provider-status"
          className="text-[13px] font-semibold text-ink"
        >
          {title}
        </h2>
        <p className="max-w-[80ch] text-[13px] text-text-secondary">{body}</p>
        {provider.environment === "sandbox" && (
          <p className="max-w-[80ch] text-[13px] font-medium text-warning">
            This deployment is connected to {provider.name}&apos;s sandbox. Anything imported here is fictional test data — not real bank data, and not anyone&apos;s money.
          </p>
        )}
        {provider.configured && !access.entitled && (
          <Link
            href={`/app/${organizationId}/settings`}
            className="w-fit text-[13px] text-accent underline-offset-2 hover:underline"
          >
            See plans in Settings
          </Link>
        )}
      </div>
    </section>
  );
}

function ConnectionPanel({
  organizationId,
  connection,
  providerConfigured,
  permissions,
  accounts,
  fedAccountIds,
}: {
  organizationId: string;
  connection: BankConnectionsWorkspace["connections"][number];
  providerConfigured: boolean;
  permissions: BankConnectionsViewProps["permissions"];
  accounts: BankConnectionsWorkspace["manualAccounts"];
  fedAccountIds: Set<string>;
}) {
  const name = connection.institutionName ?? "Unnamed institution";
  const presentation = CONNECTION_STATUS_PRESENTATION[connection.status];
  const disconnected = connection.status === "DISCONNECTED";
  const canImport =
    providerConfigured && permissions.sync && canSync(connection.status);
  // The bank is asking for the person, so the repair is offered where the
  // problem is stated — not buried in a menu.
  const needsReauth =
    providerConfigured &&
    permissions.manage &&
    connection.status === "REQUIRES_REAUTH";
  const activity = importActivityText(connection.latestJob);

  return (
    // A labelled section per connection, so assistive technology can move
    // between connections by name.
    <section
      aria-labelledby={`connection-${connection.id}`}
      className="min-w-0"
    >
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-border-subtle px-4 py-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h3
              id={`connection-${connection.id}`}
              className="flex flex-wrap items-center gap-2 text-[15px] font-semibold text-ink"
            >
              <span className="min-w-0 break-words">{name}</span>
              <ConnectionStatusBadge status={connection.status} />
              {connection.providerEnvironment === "sandbox" && (
                <Badge variant="warning">Sandbox — test data</Badge>
              )}
            </h3>
            <p className="max-w-[70ch] text-[13px] text-text-secondary">
              {presentation.description}
            </p>
            <p className="font-numeric flex flex-wrap gap-x-3 gap-y-1 text-[11px] tracking-[0.02em] text-text-tertiary uppercase">
              <span>{CONNECTION_REASON_TEXT[connection.statusReason]}</span>
              <span>
                Last import {formatDateTime(connection.lastSuccessfulSyncAt)}
              </span>
              {/* What the background worker is doing, when it is doing
                  something. Nothing is claimed here that the job table does not
                  say. */}
              {activity && !disconnected && <span>{activity}</span>}
              {connection.lastFailureCategory &&
                connection.status !== "ACTIVE" &&
                !disconnected && (
                  <span>
                    {SYNC_FAILURE_TEXT[connection.lastFailureCategory]}
                  </span>
                )}
              <span>
                {connection.transactionCount} bank{" "}
                {connection.transactionCount === 1
                  ? "transaction"
                  : "transactions"}
              </span>
              {connection.pendingCount > 0 && (
                <span>{connection.pendingCount} pending at bank</span>
              )}
              {disconnected && connection.disconnectedAt && (
                <span>
                  Disconnected {formatDateTime(connection.disconnectedAt)}
                </span>
              )}
            </p>
          </div>
          {(canImport || needsReauth || (permissions.manage && !disconnected)) && (
            <div className="flex flex-wrap items-start gap-2">
              {needsReauth && (
                <PlaidLinkButton
                  organizationId={organizationId}
                  connectionId={connection.id}
                  label="Sign in again"
                  size="sm"
                />
              )}
              {canImport && (
                <RefreshConnectionForm
                  organizationId={organizationId}
                  connectionId={connection.id}
                />
              )}
              {permissions.manage && !disconnected && (
                <DisconnectConnectionDialog
                  organizationId={organizationId}
                  connectionId={connection.id}
                  institutionName={name}
                />
              )}
            </div>
          )}
        </div>

        {connection.linkedAccounts.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-text-secondary">
            The bank hasn&apos;t reported any accounts for this connection.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Bank account</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead numeric>Reported by bank</TableHead>
                <TableHead>Feeds</TableHead>
                <TableHead>Import</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {connection.linkedAccounts.map((account) => {
                // Plaid-first (0054): supported accounts are imported by
                // themselves; an unsupported one says why, and offers nothing.
                const importKind = importedAccountKind(account.accountType, account.accountSubtype);
                const unsupported = !account.detached && account.importMode !== "IMPORT" ? unsupportedAccountReason(account.accountType, account.accountSubtype) : null;
                const choosable =
                  permissions.manage &&
                  !account.detached &&
                  account.importMode !== "IMPORT" &&
                  importKind !== null;
                return (
                  <TableRow key={account.id}>
                    <TableCell className="min-w-[180px] py-2">
                      <div className="flex flex-col">
                        <span className="text-[15px] font-medium text-text-primary">
                          {account.displayName}
                        </span>
                        {account.mask && (
                          <span className="font-numeric text-[12px] text-text-tertiary">
                            •••• {account.mask}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-[13px] whitespace-nowrap text-text-secondary">
                      {ACCOUNT_TYPE_LABEL[account.accountType]}
                      {account.accountSubtype
                        ? ` · ${account.accountSubtype.replace(/_/g, " ")}`
                        : ""}
                    </TableCell>
                    <TableCell className="font-numeric text-[13px]">
                      {account.currency ?? "Unknown"}
                    </TableCell>
                    <TableCell numeric className="whitespace-nowrap">
                      {account.currentBalanceMinor !== null &&
                      account.currency &&
                      isSupportedCurrency(account.currency) ? (
                        <Amount
                          value={money(
                            account.currentBalanceMinor,
                            account.currency,
                          )}
                          size="small"
                          tone="muted"
                        />
                      ) : (
                        <span className="text-[13px] text-text-tertiary">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="min-w-[220px] py-2">
                      {unsupported ? (
                        <span className="max-w-[36ch] text-[13px] text-text-secondary">{unsupported}</span>
                      ) : choosable ? (
                        <LinkAccountForm
                          organizationId={organizationId}
                          linkedAccountId={account.id}
                          label={`Account fed by ${account.displayName}`}
                          accounts={accounts
                            .filter(
                              (candidate) =>
                                candidate.currency === account.currency &&
                                candidate.kind === importKind &&
                                !fedAccountIds.has(candidate.id),
                            )
                            .map((candidate) => ({
                              id: candidate.id,
                              name: candidate.name,
                            }))}
                        />
                      ) : (
                        <span className="text-[13px] text-text-primary">
                          {account.accountName ?? "—"}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <ImportModeBadge
                        mode={account.importMode}
                        detached={account.detached}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Panel>
    </section>
  );
}

function ReviewQueue({
  organizationId,
  items,
  canResolve,
}: {
  organizationId: string;
  items: BankConnectionsWorkspace["reviewItems"];
  canResolve: boolean;
}) {
  return (
    <section
      aria-labelledby="bank-review-heading"
      className="flex flex-col gap-3"
    >
      <SectionTitle
        id="bank-review-heading"
        title="Needs review"
        description="Nothing listed here has been changed in your books. Each item waits for you."
      />
      <Panel>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Date</TableHead>
              <TableHead>Bank transaction</TableHead>
              <TableHead numeric>Amount</TableHead>
              <TableHead>Why</TableHead>
              {canResolve && <TableHead>Decide</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell className="font-numeric text-[13px] whitespace-nowrap">
                  {formatDate(item.transactionDate)}
                </TableCell>
                <TableCell className="min-w-[160px] text-[15px]">
                  {item.merchantName ?? item.description ?? "Bank transaction"}
                </TableCell>
                <TableCell numeric className="whitespace-nowrap">
                  {item.amountMinor !== null &&
                  isSupportedCurrency(item.currency) ? (
                    <Amount
                      value={money(
                        item.direction === "DEBIT"
                          ? -item.amountMinor
                          : item.amountMinor,
                        item.currency,
                      )}
                      size="small"
                      tone="semantic"
                    />
                  ) : (
                    <span className="text-[13px]">
                      {item.direction === "DEBIT" ? "−" : ""}
                      {item.amountDecimal} {item.currency}
                    </span>
                  )}
                </TableCell>
                <TableCell className="min-w-[240px] py-2 text-[13px] text-text-secondary">
                  {REVIEW_REASON_TEXT[item.reviewReason]}
                </TableCell>
                {canResolve && (
                  <TableCell className="min-w-[240px] py-2">
                    <ReviewResolutionForm
                      organizationId={organizationId}
                      externalId={item.id}
                      options={
                        item.reviewReason === "AMBIGUOUS_MANUAL_MATCH"
                          ? ["IMPORT_AS_NEW", "DO_NOT_IMPORT"]
                          : ["KEEP_BOOKS"]
                      }
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </section>
  );
}

function ManualAccounts({
  organizationId,
  accounts,
}: {
  organizationId: string;
  accounts: BankConnectionsWorkspace["manualAccounts"];
}) {
  return (
    <section
      aria-labelledby="manual-accounts-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle
          id="manual-accounts-heading"
          title="Accounts you record by hand"
          description="These are your books. A bank connection only adds transactions to an account you choose — it never creates one."
        />
        <Button asChild variant="ghost" size="sm">
          <Link href={`/app/${organizationId}/accounts`}>Manage accounts</Link>
        </Button>
      </div>
      <Panel>
        {accounts.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-text-secondary">
            No accounts yet.
          </p>
        ) : (
          <ul className="flex flex-col">
            {accounts.map((account) => (
              <li
                key={account.id}
                className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 last:border-0"
              >
                <span className="min-w-0 truncate text-[15px] text-text-primary">
                  {account.name}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-numeric text-[12px] text-text-tertiary">
                    {account.currency}
                  </span>
                  {account.bankFed ? (
                    <Badge variant="info">Fed by a bank</Badge>
                  ) : (
                    <Badge variant="neutral">By hand</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </section>
  );
}

function HowImportsWork() {
  return (
    <Panel>
      <PanelHeader
        title="How bank imports work"
        description="The rules every connection follows, whichever provider supplies the data."
      />
      <DetailList>
        <DetailRow label="Pending">
          Pending transactions wait at the bank. Only posted ones reach your
          books, so a cancelled charge never has to be removed.
        </DetailRow>
        <DetailRow label="Your entries">
          A posted transaction that matches one you already entered is linked to
          it, not added a second time.
        </DetailRow>
        <DetailRow label="Your edits">
          If you change an imported transaction, a later update from the bank
          never overwrites it — it asks you instead.
        </DetailRow>
        <DetailRow label="Currencies">
          Nothing is converted. A transaction in another currency stays out of
          your books and is listed.
        </DetailRow>
        <DetailRow label="Disconnecting">
          Stops imports and removes the stored access. Transactions already
          imported stay.
        </DetailRow>
      </DetailList>
    </Panel>
  );
}
