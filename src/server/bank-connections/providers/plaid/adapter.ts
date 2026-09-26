import "server-only";
import type { z } from "zod";
import { BankProviderError, ProviderSecret, type BankConnectionProvider } from "@/domain/bank-connections/provider";
import { classifyPlaidFailure, extractPlaidError, itemErrorToConnectionEvent } from "./errors";
import { PLAID_PROVIDER_ID, plaidProviderVersion, type PlaidConfig } from "./config";
import { createPlaidGateway, type PlaidGateway } from "./gateway";
import {
  classifyPlaidWebhook,
  plaidAccountsResponseSchema,
  plaidExchangeResponseSchema,
  plaidInstitutionResponseSchema,
  plaidItemResponseSchema,
  plaidLinkTokenResponseSchema,
  plaidSyncResponseSchema,
  plaidWebhookBodySchema,
  toProviderAccount,
  toProviderTransaction,
} from "./mapping";
import { createPlaidWebhookVerifier, type PlaidWebhookVerifier } from "./webhook-verification";
import { createHash } from "node:crypto";

/**
 * THE PLAID ADAPTER.
 *
 * One implementation of `BankConnectionProvider`. Everything above it — the
 * sync engine, reconciliation, the ledger, the UI, the AI — is unchanged from
 * Task 11 and knows nothing about Plaid. Everything below it is HTTP, and is
 * reached only through the injected gateway, which is the single file that
 * imports the SDK.
 *
 * TRUST BOUNDARY
 *
 * Plaid is untrusted input. Every response is parsed before use; a response
 * that does not parse is MALFORMED_PROVIDER_RESPONSE, not a crash and not a
 * partially-applied sync. Every thrown error is reduced to a category
 * (./errors.ts) — Plaid's own message text is never propagated, logged or
 * shown, because it can name institutions, items and request internals.
 *
 * WHAT NEVER CROSSES THIS BOUNDARY
 *
 * The access token. It arrives once from `completeLink` inside a
 * `ProviderSecret` (which cannot be logged or serialised), goes straight to
 * the encrypted store, and comes back only for the duration of a call.
 */

export interface PlaidAdapterDependencies {
  gateway: PlaidGateway;
  config: Pick<PlaidConfig, "environment" | "webhookUrl" | "redirectUri">;
  verifier: PlaidWebhookVerifier;
}

export class PlaidBankProvider implements BankConnectionProvider {
  readonly id = PLAID_PROVIDER_ID;
  readonly version: string;
  readonly displayName = "Plaid";
  readonly capabilities = { webhooks: true, pendingTransactions: true, balances: true } as const;
  readonly environment: PlaidConfig["environment"];

  constructor(private readonly deps: PlaidAdapterDependencies) {
    this.environment = deps.config.environment;
    this.version = plaidProviderVersion(deps.config.environment);
  }

  /** One Plaid call, with its failure classified and its response validated. */
  private async call<T>(schema: z.ZodType<T>, operation: () => Promise<unknown>): Promise<T> {
    let raw: unknown;
    try {
      raw = await operation();
    } catch (error) {
      // The category decides what happens next; the code and request id say
      // WHY, which several categories — INTERNAL_ERROR above all — cannot.
      // Only these two facts travel: Plaid's message text can name an
      // institution or an item and is never propagated.
      const facts = extractPlaidError(error);
      throw new BankProviderError(classifyPlaidFailure(error), { code: facts.errorCode, requestId: facts.requestId });
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new BankProviderError("MALFORMED_PROVIDER_RESPONSE");
    return parsed.data;
  }

  async createLinkSession(input: { organizationId: string; userId: string; reauthSecret?: ProviderSecret; signal: AbortSignal }): Promise<unknown> {
    const response = await this.call(plaidLinkTokenResponseSchema, () =>
      this.deps.gateway.createLinkToken({
        // A stable, non-personal id. Countorra's user uuid: it identifies the
        // person to Plaid without telling Plaid anything about them.
        clientUserId: input.userId,
        webhookUrl: this.deps.config.webhookUrl,
        redirectUri: this.deps.config.redirectUri,
        // Update mode: re-authenticating an item that already exists, which
        // keeps the same access token rather than issuing a new one.
        accessToken: input.reauthSecret ? input.reauthSecret.reveal() : null,
      }),
    );

    const expiresAt = new Date(response.expiration);
    if (Number.isNaN(expiresAt.getTime())) throw new BankProviderError("MALFORMED_PROVIDER_RESPONSE");
    return { linkToken: response.link_token, expiresAt: expiresAt.toISOString() };
  }

  async completeLink(input: { publicToken: string; signal: AbortSignal }): Promise<unknown> {
    const exchange = await this.call(plaidExchangeResponseSchema, () => this.deps.gateway.exchangePublicToken(input.publicToken));
    // The institution is read from Plaid, never from what the browser said it
    // connected to.
    const item = await this.call(plaidItemResponseSchema, () => this.deps.gateway.getItem(exchange.access_token));
    const institutionId = item.item.institution_id ?? null;

    let institutionName: string | null = null;
    if (institutionId) {
      try {
        const institution = await this.call(plaidInstitutionResponseSchema, () => this.deps.gateway.getInstitution(institutionId));
        institutionName = institution.institution.name.slice(0, 120);
      } catch {
        // A missing display name must not fail a connection that works.
        institutionName = null;
      }
    }

    return {
      providerConnectionId: exchange.item_id,
      institutionId,
      institutionName,
      providerEnvironment: this.environment,
      secret: new ProviderSecret(exchange.access_token),
    };
  }

  async fetchAccounts(input: { secret: ProviderSecret; signal: AbortSignal }): Promise<unknown> {
    const response = await this.call(plaidAccountsResponseSchema, () => this.deps.gateway.getAccounts(input.secret.reveal()));
    return { accounts: response.accounts.map(toProviderAccount) };
  }

  async fetchTransactions(input: { secret: ProviderSecret; cursor: string | null; pageSize: number; signal: AbortSignal; includeAccounts?: boolean }): Promise<unknown> {
    const sync = await this.call(plaidSyncResponseSchema, () =>
      this.deps.gateway.syncTransactions({ accessToken: input.secret.reveal(), cursor: input.cursor, count: Math.max(1, Math.min(input.pageSize, 500)) }),
    );

    // Accounts come with the first page of each sync RUN: the same list on
    // every page, so once per run, not per page. This used to test only
    // `cursor === null`, which is true once in a connection's life — so after
    // the first sync, balances never refreshed and accounts opened later at
    // the bank never appeared. The sync now says when it wants them.
    const wantAccounts = input.includeAccounts ?? input.cursor === null;
    const accounts = wantAccounts ? (await this.call(plaidAccountsResponseSchema, () => this.deps.gateway.getAccounts(input.secret.reveal()))).accounts.map(toProviderAccount) : [];

    return {
      accounts,
      added: sync.added.map(toProviderTransaction),
      modified: sync.modified.map(toProviderTransaction),
      removed: sync.removed.map((removed) => ({ providerTransactionId: removed.transaction_id })),
      nextCursor: sync.next_cursor,
      hasMore: sync.has_more,
    };
  }

  async revoke(input: { secret: ProviderSecret; signal: AbortSignal }): Promise<unknown> {
    try {
      return await this.deps.gateway.removeItem(input.secret.reveal());
    } catch (error) {
      const category = classifyPlaidFailure(error);
      // An item Plaid has already forgotten is revoked as far as anyone is
      // concerned; anything else is reported so disconnect can decide.
      if (category === "CONNECTION_REVOKED") return { removed: true };
      throw new BankProviderError(category);
    }
  }

  /** What Plaid currently says about the item: used after re-authentication,
   *  and whenever a connection's real state matters more than our record. */
  async inspectConnection(input: { secret: ProviderSecret; signal: AbortSignal }): Promise<unknown> {
    const item = await this.call(plaidItemResponseSchema, () => this.deps.gateway.getItem(input.secret.reveal()));
    const errorCode = item.item.error?.error_code ?? null;
    const event = itemErrorToConnectionEvent(errorCode);
    const health = !event ? "HEALTHY" : event.kind === "PROVIDER_REAUTH_REQUIRED" ? "REQUIRES_REAUTH" : event.kind === "PROVIDER_REVOKED" ? "REVOKED" : "ERROR";
    return { health, errorCode: errorCode ? errorCode.slice(0, 64) : null, institutionId: item.item.institution_id ?? null };
  }

  async verifyWebhook(input: { rawBody: string; headers: Readonly<Record<string, string>>; receivedAt: Date }): Promise<unknown> {
    const verified = await this.deps.verifier.verify(input);
    if (!verified.ok) {
      // The reason is a short code for the log; the body and the token never
      // travel with it.
      throw new BankProviderError("MALFORMED_PROVIDER_RESPONSE");
    }
    const body = plaidWebhookBodySchema.safeParse(verified.body);
    if (!body.success) throw new BankProviderError("MALFORMED_PROVIDER_RESPONSE");

    return classifyPlaidWebhook(body.data, {
      // Plaid does not give a webhook an id of its own, so identity is the
      // exact body it signed. A redelivery of the same notification collapses
      // onto one row; a genuinely new notification differs in its body.
      providerEventId: createHash("sha256").update(input.rawBody, "utf8").digest("hex"),
      // Provider time, from the signed token — which is what makes
      // out-of-order lifecycle events detectable.
      occurredAt: verified.issuedAt.toISOString(),
    });
  }
}

/** The configured Plaid provider, wired to the real SDK. */
export function createPlaidProvider(config: PlaidConfig): PlaidBankProvider {
  const gateway = createPlaidGateway(config);
  return new PlaidBankProvider({
    gateway,
    config,
    verifier: createPlaidWebhookVerifier({
      fetchKey: (keyId) => gateway.getWebhookVerificationKey(keyId),
    }),
  });
}

export { extractPlaidError };
