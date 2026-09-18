/**
 * `?redirectTo=` on the auth callback is attacker-controllable — it's part
 * of a link anyone can construct and send to a victim — so it may only ever
 * name a path on this origin, never a host.
 *
 * Concatenating it onto `origin` unchecked was an open redirect: `origin`
 * carries no trailing slash, so `redirectTo=@evil.com/` produced
 * `https://app.example.com@evil.com/` (host = evil.com, everything before
 * the `@` parsed as userinfo) and `redirectTo=.evil.com/` produced
 * `https://app.example.com.evil.com/` — a lookalike domain the attacker
 * owns, landed on immediately after a genuine sign-in.
 *
 * This is deliberately a strict allowlist rather than a blocklist of those
 * two payloads: exactly one leading `/`, never `//` or `/\`
 * (protocol-relative forms browsers resolve to another host), and no
 * control characters (which can be used to smuggle a newline into a
 * Location header).
 */
export const DEFAULT_REDIRECT = "/app";

export function safeRedirectPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_REDIRECT;
  if (!raw.startsWith("/")) return DEFAULT_REDIRECT;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_REDIRECT;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_REDIRECT;
  return raw;
}
