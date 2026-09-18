import { createHash, generateKeyPairSync, randomUUID, sign as signData, type KeyObject } from "node:crypto";
import type { PlaidGateway, PlaidLinkTokenRequest } from "@/server/bank-connections/providers/plaid/gateway";

/**
 * TEST-ONLY: Plaid's HTTP surface, in memory.
 *
 * It answers with Plaid-SHAPED payloads (snake_case, JSON numbers for money,
 * `/transactions/sync`-style cursors), so the adapter, its mapping, the
 * contract validation, the sync engine and the ledger are all exercised on
 * data that looks exactly like the real thing. Only the transport is fake.
 *
 * It lives under tests/ and nothing in src/ imports it — asserted by a test.
 * The real gateway (src/.../plaid/gateway.ts) is the only thing that ever
 * talks to Plaid.
 */

type PlaidTransactionShape = {
  transaction_id: string;
  account_id: string;
  pending: boolean;
  pending_transaction_id: string | null;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  personal_finance_category: { primary: string } | null;
};

type LogEntry = { kind: "upsert"; transaction: PlaidTransactionShape } | { kind: "removed"; transactionId: string };

export interface InjectedFailure {
  errorCode: string;
  errorType?: string;
  status?: number;
  /** Only fail this endpoint, so a test can break one step of a flow. */
  operation?: "linkToken" | "exchange" | "item" | "institution" | "accounts" | "sync" | "remove";
}

export class PlaidGatewayDouble implements PlaidGateway {
  readonly environment: "sandbox" | "production";
  readonly keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  readonly webhookKeyId = "plaid-key-1";

  accounts: Record<string, unknown>[] = [];
  institutionName = "First Platypus Bank";
  institutionId: string | null = "ins_109508";
  /** Set to make `/item/get` report a problem, the way a broken item does. */
  itemError: string | null = null;
  /** Thrown, in order, by the next data calls. */
  failures: InjectedFailure[] = [];
  /** Return something Plaid would never send. */
  malformedNext = false;
  calls = { linkToken: 0, exchange: 0, item: 0, institution: 0, accounts: 0, sync: 0, remove: 0, webhookKey: 0 };
  linkTokenRequests: PlaidLinkTokenRequest[] = [];
  removedTokens: string[] = [];

  private readonly items = new Map<string, { itemId: string }>();
  private readonly log: LogEntry[] = [];
  private readonly seen = new Set<string>();

  constructor(options: { environment?: "sandbox" | "production" } = {}) {
    this.environment = options.environment ?? "sandbox";
    this.accounts = [this.account()];
  }

  // ── Fixture data ──────────────────────────────────────────────────────

  account(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      account_id: "plaid-acct-checking",
      balances: { available: 100, current: 110, iso_currency_code: "USD", limit: null, unofficial_currency_code: null },
      mask: "0000",
      name: "Plaid Checking",
      official_name: "Plaid Gold Standard 0% Interest Checking",
      subtype: "checking",
      type: "depository",
      ...overrides,
    };
  }

  transaction(overrides: Partial<PlaidTransactionShape> = {}): PlaidTransactionShape {
    return {
      transaction_id: `plaid-tx-${randomUUID()}`,
      account_id: "plaid-acct-checking",
      pending: false,
      pending_transaction_id: null,
      amount: 42.5,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
      date: "2026-09-11",
      authorized_date: "2026-09-10",
      name: "CORNER COFFEE 0042",
      merchant_name: "Corner Coffee",
      personal_finance_category: { primary: "FOOD_AND_DRINK" },
      ...overrides,
    };
  }

  add(...transactions: PlaidTransactionShape[]): void {
    for (const transaction of transactions) this.log.push({ kind: "upsert", transaction });
  }

  modify(transaction: PlaidTransactionShape): void {
    this.log.push({ kind: "upsert", transaction });
  }

  remove(transactionId: string): void {
    this.log.push({ kind: "removed", transactionId });
  }

  failNext(...failures: (string | InjectedFailure)[]): void {
    for (const failure of failures) this.failures.push(typeof failure === "string" ? { errorCode: failure } : failure);
  }

  /** The `plaid-verification` header for a body, as Plaid would sign it. */
  signWebhook(rawBody: string, issuedAt: Date = new Date()): string {
    const header = { alg: "ES256", kid: this.webhookKeyId, typ: "JWT" };
    const payload = { iat: Math.floor(issuedAt.getTime() / 1000), request_body_sha256: createHash("sha256").update(rawBody, "utf8").digest("hex") };
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = signData("sha256", Buffer.from(signingInput), { key: this.keyPair.privateKey as KeyObject, dsaEncoding: "ieee-p1363" });
    return `${signingInput}.${signature.toString("base64url")}`;
  }

  // ── The gateway ───────────────────────────────────────────────────────

  private throwIfFailing(operation: NonNullable<InjectedFailure["operation"]>): void {
    const next = this.failures[0];
    if (!next) return;
    if (next.operation && next.operation !== operation) return;
    const failure = this.failures.shift()!;
    // Exactly what the SDK throws: an axios error carrying Plaid's body.
    throw {
      isAxiosError: true,
      message: "Request failed",
      response: {
        status: failure.status ?? 400,
        data: { error_code: failure.errorCode, error_type: failure.errorType ?? "ITEM_ERROR", error_message: "Developer-facing sentence", request_id: "req_double" },
      },
    };
  }

  async createLinkToken(request: PlaidLinkTokenRequest): Promise<unknown> {
    this.calls.linkToken += 1;
    this.linkTokenRequests.push(request);
    this.throwIfFailing("linkToken");
    return { link_token: `link-${this.environment}-${randomUUID()}`, expiration: new Date(Date.now() + 30 * 60_000).toISOString(), request_id: "req_link" };
  }

  async exchangePublicToken(publicToken: string): Promise<unknown> {
    this.calls.exchange += 1;
    this.throwIfFailing("exchange");
    const accessToken = `access-${this.environment}-${randomUUID()}`;
    const itemId = `item-${publicToken}`;
    this.items.set(accessToken, { itemId });
    return { access_token: accessToken, item_id: itemId, request_id: "req_exchange" };
  }

  async getItem(accessToken: string): Promise<unknown> {
    this.calls.item += 1;
    this.throwIfFailing("item");
    const item = this.items.get(accessToken);
    if (!item) throw { isAxiosError: true, response: { status: 400, data: { error_code: "INVALID_ACCESS_TOKEN", error_type: "INVALID_INPUT", request_id: "req_item" } } };
    return {
      item: {
        item_id: item.itemId,
        institution_id: this.institutionId,
        webhook: "https://example.test/api/bank-connections/webhooks/plaid",
        error: this.itemError ? { error_code: this.itemError, error_type: "ITEM_ERROR", error_message: "developer sentence" } : null,
        available_products: ["transactions"],
        billed_products: ["transactions"],
        consent_expiration_time: null,
      },
      status: { transactions: { last_successful_update: "2026-09-15T10:00:00Z" } },
      request_id: "req_item",
    };
  }

  async getInstitution(institutionId: string): Promise<unknown> {
    this.calls.institution += 1;
    this.throwIfFailing("institution");
    return { institution: { institution_id: institutionId, name: this.institutionName, products: ["transactions"], country_codes: ["US"] }, request_id: "req_inst" };
  }

  async getAccounts(accessToken: string): Promise<unknown> {
    this.calls.accounts += 1;
    this.throwIfFailing("accounts");
    const item = this.items.get(accessToken);
    if (!item) throw { isAxiosError: true, response: { status: 400, data: { error_code: "INVALID_ACCESS_TOKEN", error_type: "INVALID_INPUT" } } };
    return { accounts: this.accounts, item: { item_id: item.itemId }, request_id: "req_accounts" };
  }

  async syncTransactions(input: { accessToken: string; cursor: string | null; count: number }): Promise<unknown> {
    this.calls.sync += 1;
    this.throwIfFailing("sync");
    if (this.malformedNext) {
      this.malformedNext = false;
      return { added: [{ amount: "not a number" }], next_cursor: 42, has_more: "maybe" };
    }
    if (!this.items.has(input.accessToken)) {
      throw { isAxiosError: true, response: { status: 400, data: { error_code: "INVALID_ACCESS_TOKEN", error_type: "INVALID_INPUT" } } };
    }

    const start = input.cursor ? Number(input.cursor.replace("cursor-", "")) : 0;
    const slice = this.log.slice(start, start + input.count);
    const latest = new Map<string, LogEntry>();
    for (const entry of slice) latest.set(entry.kind === "removed" ? entry.transactionId : entry.transaction.transaction_id, entry);

    const added: PlaidTransactionShape[] = [];
    const modified: PlaidTransactionShape[] = [];
    const removed: { transaction_id: string }[] = [];
    for (const [id, entry] of latest) {
      if (entry.kind === "removed") {
        removed.push({ transaction_id: id });
        continue;
      }
      // Plaid reports a transaction it has already sent as "modified".
      if (this.seen.has(id)) modified.push(entry.transaction);
      else {
        added.push(entry.transaction);
        this.seen.add(id);
      }
    }

    const end = start + slice.length;
    return { added, modified, removed, next_cursor: `cursor-${end}`, has_more: end < this.log.length, request_id: "req_sync", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" };
  }

  async removeItem(accessToken: string): Promise<unknown> {
    this.calls.remove += 1;
    this.throwIfFailing("remove");
    if (!this.items.delete(accessToken)) {
      throw { isAxiosError: true, response: { status: 400, data: { error_code: "ITEM_NOT_FOUND", error_type: "ITEM_ERROR" } } };
    }
    this.removedTokens.push(accessToken);
    return { request_id: "req_remove" };
  }

  async getWebhookVerificationKey(keyId: string): Promise<unknown> {
    this.calls.webhookKey += 1;
    const jwk = this.keyPair.publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
    return { key: { kid: keyId, kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, alg: "ES256", use: "sig", created_at: 1_700_000_000, expired_at: null }, request_id: "req_key" };
  }
}
