import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

type Client = SupabaseClient<Database>;
type AccountRow = Database["public"]["Tables"]["accounts"]["Row"];

export interface Account {
  id: string;
  organizationId: string;
  name: string;
  kind: AccountRow["kind"];
  currency: string;
  openingBalanceMinor: number;
  isArchived: boolean;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    kind: row.kind,
    currency: row.currency,
    openingBalanceMinor: row.opening_balance_minor,
    isArchived: row.is_archived,
  };
}

export async function listAccounts(
  client: Client,
  organizationId: string,
  options: { includeArchived?: boolean } = {},
): Promise<Account[]> {
  let query = client.from("accounts").select("*").eq("organization_id", organizationId).order("created_at");
  if (!options.includeArchived) query = query.eq("is_archived", false);
  const { data, error } = await query;
  if (error) throw error;
  return data.map(toAccount);
}

export async function getAccount(client: Client, accountId: string): Promise<Account | null> {
  const { data, error } = await client.from("accounts").select("*").eq("id", accountId).maybeSingle();
  if (error) throw error;
  return data ? toAccount(data) : null;
}

export interface CreateAccountInput {
  organizationId: string;
  name: string;
  kind: AccountRow["kind"];
  currency: string;
  openingBalanceMinor?: number;
}

export async function createAccount(client: Client, input: CreateAccountInput): Promise<Account> {
  const { data, error } = await client
    .from("accounts")
    .insert({
      organization_id: input.organizationId,
      name: input.name,
      kind: input.kind,
      currency: input.currency,
      opening_balance_minor: input.openingBalanceMinor ?? 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return toAccount(data);
}

export async function archiveAccount(client: Client, accountId: string, organizationId: string): Promise<boolean> {
  const { data, error } = await client
    .from("accounts")
    .update({ is_archived: true })
    .eq("id", accountId)
    .eq("organization_id", organizationId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export interface AccountBalance {
  accountId: string;
  currency: string;
  balanceMinor: number;
}

/**
 * Current balance for every account in the organization, in one call.
 *
 * Balance is still derived, never stored, so a displayed balance can't drift
 * from the ledger — the classic "cached balance goes stale" bug class. What
 * changed (FIN-01) is where the derivation happens.
 *
 * It used to run in JavaScript over rows fetched through PostgREST, two
 * unbounded selects per account. PostgREST caps a response at `max_rows`
 * (1000) and truncates SILENTLY, so any account past a thousand transactions
 * reported a balance that was short by however many rows fell off the end —
 * on the dashboard, on the accounts page, and in the AI's answers. The
 * summation now happens in `account_balances_minor`
 * (supabase/migrations/0027_financial_aggregates.sql), which returns one row
 * per account, so the cap is structurally out of the picture regardless of
 * how many transactions the balance spans.
 *
 * The function is `security invoker`, so RLS scopes it exactly as it scopes
 * the selects this replaced: `organizationId` narrows the query, it does not
 * authorize it. Callers still go through `requireOrgMembership` first.
 *
 * Returning all accounts at once also removes the N+1 that had the dashboard
 * and the accounts page issuing two queries per account on every load.
 */
export async function listAccountBalances(client: Client, organizationId: string): Promise<AccountBalance[]> {
  const { data, error } = await client.rpc("account_balances_minor", { p_organization_id: organizationId });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    accountId: row.account_id,
    currency: row.currency,
    // bigint arrives as a string from PostgREST when it exceeds the JS safe
    // range; Number() on the string is still exact below 2^53, and an amount
    // beyond that is a separate problem this conversion must not hide.
    balanceMinor: Number(row.balance_minor),
  }));
}

/** Balance for a single account. Prefer `listAccountBalances` when more than
 *  one account is needed — this exists for the genuinely single-account
 *  callers, and shares the same SQL aggregate. */
export async function getAccountBalanceMinor(client: Client, accountId: string): Promise<number> {
  const account = await getAccount(client, accountId);
  if (!account) throw new Error("Account not found.");

  const balances = await listAccountBalances(client, account.organizationId);
  const balance = balances.find((b) => b.accountId === accountId);
  if (!balance) throw new Error("Account not found.");
  return balance.balanceMinor;
}
