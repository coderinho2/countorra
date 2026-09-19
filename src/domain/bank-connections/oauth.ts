/**
 * THE BANK OAUTH RETURN PATH — one address for every organization.
 *
 * Many banks sign a customer in on their own website and then send them back
 * to a redirect URI the provider requires to be registered in advance, exactly.
 * One deployment registers ONE such URI, so it cannot carry an organization:
 * `/app/<orgId>/…` would serve exactly one workspace and strand everyone else.
 *
 * The organization a returning customer belongs to is therefore never read
 * from the URL. It is sealed server-side when the Link session starts
 * (src/server/bank-connections/link-state.ts) and re-verified against the
 * session when the customer comes back.
 *
 * Provider-independent: nothing here is Plaid's.
 */

export const BANK_OAUTH_RETURN_PATH = "/app/bank-connections/oauth";

/** How long a started Link session may be resumed after a bank redirect. A
 *  bank's sign-in takes minutes; half an hour is generous without leaving a
 *  resumable session lying around for an afternoon. */
export const BANK_LINK_STATE_TTL_SECONDS = 30 * 60;

export type BankOauthReturnUriProblem = "not_a_url" | "not_https" | "wrong_path" | "has_query_or_fragment";

/**
 * Whether a configured redirect URI is the fixed return path, and nothing
 * else: https (or http on localhost, for local sandbox work), exactly
 * BANK_OAUTH_RETURN_PATH, no query string, no fragment. Anything else — a
 * per-organization path above all — would register a URI that only works for
 * some customers.
 */
export function checkBankOauthReturnUri(uri: string): { ok: true } | { ok: false; problem: BankOauthReturnUriProblem } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return { ok: false, problem: "not_a_url" };
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return { ok: false, problem: "not_https" };
  if (parsed.search !== "" || parsed.hash !== "") return { ok: false, problem: "has_query_or_fragment" };
  if (parsed.pathname !== BANK_OAUTH_RETURN_PATH) return { ok: false, problem: "wrong_path" };
  return { ok: true };
}
