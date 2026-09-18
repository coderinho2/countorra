import { notFound } from "next/navigation";
import { Bank } from "@phosphor-icons/react/dist/ssr/Bank";
import { CreditCard } from "@phosphor-icons/react/dist/ssr/CreditCard";
import { Money as MoneyIcon } from "@phosphor-icons/react/dist/ssr/Money";
import { Wallet } from "@phosphor-icons/react/dist/ssr/Wallet";
import { Vault } from "@phosphor-icons/react/dist/ssr/Vault";
import { createClient } from "@/server/supabase/server";
import { getOrganization } from "@/server/db/repositories/organizations";
import Link from "next/link";
import { listAccounts, listAccountBalances, type Account } from "@/server/db/repositories/accounts";
import { listBankFedAccounts } from "@/server/db/repositories/bank-connections";
import { NewAccountDialog } from "@/components/accounts/new-account-dialog";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { Amount } from "@/components/amount";
import { money } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";

const KIND = {
  bank: { label: "Bank accounts", icon: Bank },
  cash: { label: "Cash", icon: MoneyIcon },
  credit_card: { label: "Credit cards", icon: CreditCard },
  wallet: { label: "Wallets", icon: Wallet },
  other: { label: "Other", icon: Vault },
} as const;

const KIND_ORDER: (keyof typeof KIND)[] = ["bank", "cash", "wallet", "credit_card", "other"];

/**
 * Where the money actually sits.
 *
 * This page was a three-across grid of identical cards — the exact pattern
 * DESIGN.md §26 bans, and one that made a $124,000 reserve account and a $425
 * petty cash tin look equally important. A list of balances is a ledger, not
 * a gallery, so it is now a ruled statement: accounts grouped by kind, name
 * on the left, balance right-aligned in the Numeric-prominent scale, with the
 * total on the page header where the eye reaches it first.
 *
 * Credit cards are grouped separately and last, because a negative balance
 * there means something different from a negative balance in a bank account —
 * it is money owed, not money missing.
 */
export default async function AccountsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const client = await createClient();
  const organization = await getOrganization(client, orgId);
  if (!organization) notFound();

  // One SQL aggregate for every account (FIN-01). This used to issue two
  // unbounded selects per account and sum the rows in JavaScript, which
  // PostgREST silently truncated at 1000 — so the figure this page exists to
  // show went quietly wrong on any account past its first thousand entries.
  const [accounts, balances, bankFed] = await Promise.all([listAccounts(client, orgId), listAccountBalances(client, orgId), listBankFedAccounts(client, orgId)]);
  const balanceById = new Map(balances.map((b) => [b.accountId, b.balanceMinor]));

  const baseCurrency: CurrencyCode = isSupportedCurrency(organization.baseCurrency) ? organization.baseCurrency : "USD";
  const safe = (amountMinor: number, currency: string) => money(amountMinor, isSupportedCurrency(currency) ? currency : baseCurrency);

  // Only accounts held in the workspace's base currency roll into the total:
  // adding a EUR balance to a USD one at 1:1 would be a fabricated number,
  // and this product does not print numbers it cannot stand behind.
  const inBaseCurrency = accounts.filter((a) => a.currency === baseCurrency);
  const totalMinor = inBaseCurrency.reduce((sum, a) => sum + (balanceById.get(a.id) ?? 0), 0);
  const excluded = accounts.length - inBaseCurrency.length;

  const grouped = KIND_ORDER.map((kind) => ({ kind, accounts: accounts.filter((a) => a.kind === kind) })).filter((group) => group.accounts.length > 0);

  return (
    <PageShell className="gap-6">
      <PageHeader
        eyebrow="Records"
        title="Accounts"
        description="Every account this workspace tracks, and what is in each of them right now."
        actions={<NewAccountDialog organizationId={orgId} currency={organization.baseCurrency} />}
        meta={
          accounts.length > 0 ? (
            <PageMeta>
              <PageMetaItem
                label="Total"
                value={<Amount value={money(totalMinor, baseCurrency)} size="small" tone={totalMinor < 0 ? "negative" : "neutral"} />}
              />
              <PageMetaItem label="Accounts" value={accounts.length} />
              {excluded > 0 && <PageMetaItem label="Not in total" value={`${excluded} in another currency`} />}
            </PageMeta>
          ) : undefined
        }
      />

      {accounts.length === 0 ? (
        <Panel className="p-0">
          <EmptyState title="No accounts yet" description="Add a bank account, cash, or credit card to start tracking transactions." />
        </Panel>
      ) : (
        <div className="flex flex-col gap-8">
          {grouped.map((group) => {
            const { label, icon: Icon } = KIND[group.kind];
            const subtotal = group.accounts.filter((a) => a.currency === baseCurrency).reduce((sum, a) => sum + (balanceById.get(a.id) ?? 0), 0);
            return (
              <section key={group.kind} className="flex flex-col gap-3">
                <div className="flex items-end justify-between gap-4 border-b border-border pb-2.5">
                  <h2 className="font-numeric flex items-center gap-2 text-[10px] tracking-[0.14em] text-text-secondary uppercase">
                    <Icon size={13} aria-hidden="true" className="text-text-tertiary" />
                    {label}
                  </h2>
                  <span className="flex items-baseline gap-2">
                    <span className="font-numeric text-[10px] tracking-[0.08em] text-text-tertiary uppercase">Subtotal</span>
                    <Amount value={money(subtotal, baseCurrency)} size="small" tone={subtotal < 0 ? "negative" : "ink"} />
                  </span>
                </div>

                <ul className="flex flex-col">
                  {group.accounts.map((account) => (
                    <AccountRow
                      key={account.id}
                      organizationId={orgId}
                      account={account}
                      balance={safe(balanceById.get(account.id) ?? 0, account.currency)}
                      bankFeed={bankFed.get(account.id) ?? null}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

function AccountRow({
  organizationId,
  account,
  balance,
  bankFeed,
}: {
  organizationId: string;
  account: Account;
  balance: ReturnType<typeof money>;
  /** The bank account feeding this one, if a person linked one. */
  bankFeed: { displayName: string; mask: string | null } | null;
}) {
  // The opening balance is already on the account record and was never shown.
  // A statement states where an account started as well as where it stands —
  // without it, a balance is a number with no baseline to read it against.
  const opening = money(account.openingBalanceMinor, balance.currency);
  return (
    <li className="flex items-center justify-between gap-4 border-b border-border-subtle py-3.5 last:border-0">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-[15px] font-medium text-text-primary">{account.name}</span>
        <span className="font-numeric flex flex-wrap items-center gap-2 text-[11px] tracking-[0.02em] text-text-tertiary uppercase">
          <span>{account.currency}</span>
          <span aria-hidden="true" className="h-2.5 w-px bg-border-subtle" />
          <span className="opacity-70">Opened at</span>
          <Amount value={opening} size="small" tone="muted" className="text-[11px]" />
          {account.isArchived && (
            <>
              <span aria-hidden="true" className="h-2.5 w-px bg-border-subtle" />
              <span>Archived</span>
            </>
          )}
          {bankFeed && (
            <>
              <span aria-hidden="true" className="h-2.5 w-px bg-border-subtle" />
              <Link href={`/app/${organizationId}/bank-connections`} className="underline-offset-2 hover:text-text-secondary hover:underline">
                Fed by {bankFeed.displayName}
                {bankFeed.mask ? ` ••${bankFeed.mask}` : ""}
              </Link>
            </>
          )}
        </span>
      </div>
      {/* The balance is the point of the row, so it carries the
          Numeric-prominent scale (DESIGN.md §4) — bigger than the account's
          own name, which is only a label for it. */}
      <Amount value={balance} size="prominent" tone={balance.amountMinor < 0 ? "negative" : "ink"} />
    </li>
  );
}
