import "server-only";
import { Configuration, PlaidApi, type PlaidEnvironments } from "plaid";
import { PLAID_API_VERSION, PLAID_COUNTRY_CODES, PLAID_PRODUCTS, type PlaidConfig } from "./config";

/**
 * THE ONLY FILE THAT TALKS TO PLAID.
 *
 * `plaid` (the official SDK) is imported here and nowhere else — a test
 * asserts that. Everything above this file works with `unknown` and validates
 * it (./mapping.ts), so no Plaid type reaches the adapter, let alone the
 * Countorra domain.
 *
 * Every method returns `unknown` deliberately: an SDK's TypeScript types are a
 * promise about a remote service, not a guarantee, and this integration treats
 * the provider as untrusted input like any other.
 */

/** Slightly under the caller's own deadline (PROVIDER_CALL_TIMEOUT_MS = 25s),
 *  so a hung socket is closed by us rather than abandoned. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface PlaidLinkTokenRequest {
  /** A stable, non-PII id for the person. Countorra's user uuid. */
  clientUserId: string;
  webhookUrl: string | null;
  redirectUri: string | null;
  /** Present for update mode — re-authenticating an existing item. */
  accessToken: string | null;
}

export interface PlaidGateway {
  readonly environment: PlaidConfig["environment"];
  createLinkToken(request: PlaidLinkTokenRequest): Promise<unknown>;
  exchangePublicToken(publicToken: string): Promise<unknown>;
  getItem(accessToken: string): Promise<unknown>;
  getInstitution(institutionId: string): Promise<unknown>;
  getAccounts(accessToken: string): Promise<unknown>;
  syncTransactions(input: { accessToken: string; cursor: string | null; count: number }): Promise<unknown>;
  removeItem(accessToken: string): Promise<unknown>;
  getWebhookVerificationKey(keyId: string): Promise<unknown>;
}

export function createPlaidGateway(config: PlaidConfig): PlaidGateway {
  const client = new PlaidApi(
    new Configuration({
      basePath: config.basePath as unknown as (typeof PlaidEnvironments)[keyof typeof PlaidEnvironments],
      baseOptions: {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "PLAID-CLIENT-ID": config.clientId,
          "PLAID-SECRET": config.secret,
          "Plaid-Version": PLAID_API_VERSION,
        },
      },
    }),
  );

  return {
    environment: config.environment,

    async createLinkToken(request) {
      const response = await client.linkTokenCreate({
        user: { client_user_id: request.clientUserId },
        client_name: "Countorra",
        language: "en",
        country_codes: [...PLAID_COUNTRY_CODES] as never,
        // Update mode asks for no products: the item already has them, and
        // naming products again is what Plaid rejects.
        ...(request.accessToken ? { access_token: request.accessToken } : { products: [...PLAID_PRODUCTS] as never }),
        ...(request.webhookUrl ? { webhook: request.webhookUrl } : {}),
        ...(request.redirectUri ? { redirect_uri: request.redirectUri } : {}),
      });
      return response.data;
    },

    async exchangePublicToken(publicToken) {
      const response = await client.itemPublicTokenExchange({ public_token: publicToken });
      return response.data;
    },

    async getItem(accessToken) {
      const response = await client.itemGet({ access_token: accessToken });
      return response.data;
    },

    async getInstitution(institutionId) {
      const response = await client.institutionsGetById({ institution_id: institutionId, country_codes: [...PLAID_COUNTRY_CODES] as never });
      return response.data;
    },

    async getAccounts(accessToken) {
      const response = await client.accountsGet({ access_token: accessToken });
      return response.data;
    },

    async syncTransactions(input) {
      const response = await client.transactionsSync({
        access_token: input.accessToken,
        count: input.count,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return response.data;
    },

    async removeItem(accessToken) {
      const response = await client.itemRemove({ access_token: accessToken });
      return response.data;
    },

    async getWebhookVerificationKey(keyId) {
      const response = await client.webhookVerificationKeyGet({ key_id: keyId });
      return response.data;
    },
  };
}
