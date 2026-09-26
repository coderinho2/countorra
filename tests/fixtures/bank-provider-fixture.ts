import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  BankProviderError,
  ProviderSecret,
  type BankConnectionProvider,
  type ProviderAccount,
  type ProviderSecretStore,
  type ProviderTransaction,
} from "@/domain/bank-connections/provider";
import type { SyncFailureCategory } from "@/domain/bank-connections/types";

/**
 * TEST-ONLY. A deterministic, in-memory bank-data provider.
 *
 * It exists so the provider-independent architecture can be exercised end to
 * end without a real provider. It lives under tests/ and is imported by nothing
 * in src/ — production's provider list is empty (src/server/bank-connections/
 * providers.ts), and a test in tests/server asserts that it stays that way.
 *
 * The data model is a change log: every add, modify and remove is appended, and
 * a cursor is a position in that log — the same incremental, cursor-paginated
 * shape a real transactions-sync API has.
 */

type LogEntry = { kind: "added" | "modified"; transaction: ProviderTransaction } | { kind: "removed"; providerTransactionId: string };

export class FixtureBankProvider implements BankConnectionProvider {
  readonly id = "fixture";
  readonly version = "1.0.0";
  readonly displayName = "Fixture bank data (tests only)";
  readonly capabilities = { webhooks: true, pendingTransactions: true, balances: true } as const;
  /**
   * Which environment this "deployment" is pointed at, exactly as the Plaid
   * adapter carries `PLAID_ENV`. Mutable so a test can do what flipping
   * PLAID_ENV does in production — change the runtime's environment while
   * connections stamped with the old one are still in the database — and then
   * assert the environment guard refuses them.
   */
  environment = "fixture";

  accounts: ProviderAccount[] = [];
  readonly webhookSecret = "fixture-webhook-signing-secret";
  /** What `inspectConnection` reports — a test can make an item look broken. */
  health: "HEALTHY" | "REQUIRES_REAUTH" | "REVOKED" | "ERROR" = "HEALTHY";
  /** Link sessions opened in update mode, i.e. with an existing credential. */
  reauthSessions = 0;
  /** Failures to throw on the next fetches, in order. */
  failNext: SyncFailureCategory[] = [];
  /** Return a malformed page on the next fetch. */
  malformedNext = false;
  calls = { fetch: 0, revoke: 0, completeLink: 0 };
  revokedSecrets: string[] = [];
  private log: LogEntry[] = [];

  account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
    const account: ProviderAccount = {
      providerAccountId: "acct-checking",
      name: "Everyday Checking",
      type: "DEPOSITORY",
      subtype: "checking",
      mask: "0000111122223333",
      currency: "USD",
      currentBalance: "1043.20",
      availableBalance: "1000.00",
      state: "OPEN",
      ...overrides,
    };
    this.accounts = [...this.accounts.filter((existing) => existing.providerAccountId !== account.providerAccountId), account];
    return account;
  }

  transaction(overrides: Partial<ProviderTransaction> = {}): ProviderTransaction {
    return {
      providerTransactionId: `tx-${randomUUID()}`,
      providerAccountId: "acct-checking",
      pendingProviderTransactionId: null,
      status: "POSTED",
      direction: "DEBIT",
      amount: "42.50",
      currency: "USD",
      transactionDate: "2026-09-10",
      postedDate: "2026-09-11",
      authorizedDate: null,
      merchantName: "Corner Coffee",
      description: "CORNER COFFEE 0042",
      categoryHint: "FOOD_AND_DRINK",
      ...overrides,
    };
  }

  add(...transactions: ProviderTransaction[]): void {
    for (const transaction of transactions) this.log.push({ kind: "added", transaction });
  }

  modify(transaction: ProviderTransaction): void {
    this.log.push({ kind: "modified", transaction });
  }

  remove(providerTransactionId: string): void {
    this.log.push({ kind: "removed", providerTransactionId });
  }

  async createLinkSession(input: { reauthSecret?: ProviderSecret }): Promise<unknown> {
    if (input?.reauthSecret) this.reauthSessions += 1;
    return { linkToken: `link-fixture-${randomUUID()}`, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
  }

  async inspectConnection(input: { secret: ProviderSecret }): Promise<unknown> {
    if (!input.secret.reveal().startsWith("fixture-access-token-")) throw new BankProviderError("REAUTH_REQUIRED");
    return { health: this.health, errorCode: this.health === "HEALTHY" ? null : "FIXTURE_ITEM_PROBLEM", institutionId: "ins_fixture" };
  }

  async completeLink(input: { publicToken: string }): Promise<unknown> {
    this.calls.completeLink += 1;
    return {
      providerConnectionId: `item-${input.publicToken}`,
      institutionId: "ins_fixture",
      institutionName: "Fixture Credit Union",
      // From the same field the guard compares against, so a connection is
      // always stamped with the environment that created it — never a literal
      // that could silently drift from `this.environment`.
      providerEnvironment: this.environment,
      secret: new ProviderSecret(`fixture-access-token-${input.publicToken}`),
    };
  }

  async fetchAccounts(): Promise<unknown> {
    return { accounts: this.accounts };
  }

  async fetchTransactions(input: { secret: ProviderSecret; cursor: string | null; pageSize: number }): Promise<unknown> {
    this.calls.fetch += 1;
    if (!input.secret.reveal().startsWith("fixture-access-token-")) throw new BankProviderError("REAUTH_REQUIRED");
    const failure = this.failNext.shift();
    if (failure) throw new BankProviderError(failure);
    if (this.malformedNext) {
      this.malformedNext = false;
      return { added: [{ amount: 12.5 }], nextCursor: 7 };
    }

    const start = input.cursor ? Number(input.cursor.replace("cursor-", "")) : 0;
    const slice = this.log.slice(start, start + input.pageSize);
    const latest = new Map<string, LogEntry>();
    for (const entry of slice) latest.set(entry.kind === "removed" ? `removed:${entry.providerTransactionId}` : `tx:${entry.transaction.providerTransactionId}`, entry);

    const added: ProviderTransaction[] = [];
    const modified: ProviderTransaction[] = [];
    const removed: { providerTransactionId: string }[] = [];
    for (const entry of latest.values()) {
      if (entry.kind === "removed") removed.push({ providerTransactionId: entry.providerTransactionId });
      else if (entry.kind === "added") added.push(entry.transaction);
      else modified.push(entry.transaction);
    }
    const end = start + slice.length;
    return { accounts: start === 0 ? this.accounts : [], added, modified, removed, nextCursor: `cursor-${end}`, hasMore: end < this.log.length };
  }

  async revoke(input: { secret: ProviderSecret }): Promise<unknown> {
    this.calls.revoke += 1;
    this.revokedSecrets.push(input.secret.reveal());
    return { revoked: true };
  }

  sign(rawBody: string, timestamp: number): string {
    return createHmac("sha256", this.webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  }

  async verifyWebhook(input: { rawBody: string; headers: Readonly<Record<string, string>>; receivedAt: Date }): Promise<unknown> {
    const timestamp = Number(input.headers["x-fixture-timestamp"]);
    const signature = input.headers["x-fixture-signature"] ?? "";
    if (!Number.isFinite(timestamp) || Math.abs(input.receivedAt.getTime() / 1000 - timestamp) > 300) throw new Error("stale or missing timestamp");
    const expected = Buffer.from(this.sign(input.rawBody, timestamp), "hex");
    const given = Buffer.from(signature, "hex");
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error("bad signature");
    return JSON.parse(input.rawBody);
  }
}

/** TEST-ONLY secret store. Records destruction so tests can prove it happened. */
export class MemorySecretStore implements ProviderSecretStore {
  readonly id = "memory";
  readonly secrets = new Map<string, string>();
  readonly destroyed: string[] = [];
  /** Every reference this store was asked to decrypt. A test asserts this stays
   *  EMPTY when a connection is refused at the environment boundary. */
  readonly reads: string[] = [];
  failDestroy = false;

  async put(input: { secret: ProviderSecret }): Promise<string> {
    const reference = `memory:${randomUUID()}`;
    this.secrets.set(reference, input.secret.reveal());
    return reference;
  }

  async get(reference: string): Promise<ProviderSecret | null> {
    this.reads.push(reference);
    const value = this.secrets.get(reference);
    return value ? new ProviderSecret(value) : null;
  }

  async destroy(reference: string): Promise<void> {
    if (this.failDestroy) throw new Error("secret store unavailable");
    this.secrets.delete(reference);
    this.destroyed.push(reference);
  }
}
