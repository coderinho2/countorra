/**
 * What an outbound email IS, independent of who sends it.
 *
 * Pure: no provider, no network, no secrets. Everything a template produces
 * and everything a provider consumes passes through these types, so swapping
 * Resend for SES is a new file in `src/server/email/providers` and nothing
 * else.
 */

/**
 * The distinction that decides whether an unsubscribe is honoured.
 *
 * TRANSACTIONAL — a direct consequence of something the recipient or their
 * counterparty did: an invoice they are owed money on, a password reset, a
 * security notice. Suppression does NOT apply. A customer who unsubscribed
 * from digests still has to receive the invoice they asked for, and most
 * jurisdictions treat these as exempt precisely because withholding them
 * would harm the recipient.
 *
 * NOTIFICATION — anything the product decided to send on its own schedule:
 * insight digests, tax reminders, nudges. Suppression DOES apply, and every
 * one of these carries an unsubscribe link. This is the category that makes
 * an unsubscribe mechanism legally required, so it is the category that is
 * checked.
 *
 * Getting this split wrong in either direction is a real failure: honouring
 * unsubscribe on an invoice silently loses someone money, and ignoring it on
 * a digest is a compliance problem.
 */
export type EmailCategory = "transactional" | "notification";

export interface EmailAddress {
  address: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  /** Base64. Providers differ on field names; adapters translate. */
  content: string;
  contentType: string;
}

export interface EmailMessage {
  to: EmailAddress;
  subject: string;
  html: string;
  /** Always present. A text part is not optional politeness — an HTML-only
   *  message scores worse with spam filters and is unreadable in a plain
   *  text client. */
  text: string;
  category: EmailCategory;
  attachments?: EmailAttachment[];
  /** RFC 8058 one-click unsubscribe target. Set only for `notification`. */
  unsubscribeUrl?: string;
  /** Correlates the provider's record with ours. */
  idempotencyKey?: string;
}

/**
 * Normalizes an address for comparison and suppression lookup.
 *
 * Lowercased and trimmed only. Deliberately NOT doing gmail-style dot or
 * plus-address folding: `a.b@gmail.com` and `ab@gmail.com` are the same
 * Gmail inbox but are different addresses at most other providers, and
 * folding them would suppress mail to a person who never unsubscribed.
 */
export function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * A deliberately conservative syntactic check.
 *
 * Not RFC 5322 — that grammar accepts things no provider will deliver to,
 * and implementing it invites a catastrophic-backtracking regex. This
 * rejects what is obviously unsendable and leaves the real verdict to the
 * provider, whose rejection is recorded against the message.
 */
export function isDeliverableAddress(address: string): boolean {
  const value = normalizeEmailAddress(address);
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;

  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return false;

  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64) return false;
  if (!domain.includes(".")) return false;

  // Checked per LABEL, not across the whole domain. `example-.test` has a
  // valid-looking domain but an invalid label, and a whole-string check
  // misses it — the hyphen is not at either end of the domain.
  const labels = domain.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }

  return true;
}

/** Whether an unsubscribe may be honoured for this category. */
export function respectsSuppression(category: EmailCategory): boolean {
  return category === "notification";
}
