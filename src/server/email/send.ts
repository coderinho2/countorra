import "server-only";
import { createAdminClient } from "@/server/supabase/admin";
import { isDeliverableAddress, normalizeEmailAddress, respectsSuppression } from "@/domain/email/message";
import type { EmailMessage } from "@/domain/email/message";
import { reportError, reportEvent } from "@/lib/observability";
import { emailConfig } from "./config";

/**
 * The one path every outbound email takes.
 *
 * Order matters and is deliberate:
 *
 *   1. Refuse an undeliverable address before anything is written.
 *   2. Check suppression — for notifications only.
 *   3. Write a `queued` audit row, so a crash mid-send leaves evidence
 *      rather than silence.
 *   4. Send, retrying only what the provider said is worth retrying.
 *   5. Record the outcome against the same row.
 *
 * WHY IT NEVER THROWS
 *
 * Callers are invoice sends and notification sweeps. An email provider being
 * down must not roll back the invoice that was successfully marked sent, and
 * must not take down a page. So this returns a result, always, and the
 * caller decides what to tell the user. The failure is durable in
 * `email_messages` either way.
 *
 * SERVICE ROLE, DELIBERATELY
 *
 * `email_messages` has no INSERT policy for `authenticated` — a member must
 * not be able to forge a delivery record, and suppression is not theirs to
 * read. Authorization happened at the calling action; this is the back end
 * acting on an already-authorized request.
 */

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;

export type EmailSendOutcome =
  | { status: "sent"; messageId: string; providerMessageId: string | null; deliveredForReal: boolean }
  | { status: "suppressed"; messageId: string }
  | { status: "failed"; messageId: string | null; reason: string }
  | { status: "not_configured" };

export interface SendEmailOptions {
  message: EmailMessage;
  /** Which template produced this, for the audit row: 'invoice.new', ... */
  template: string;
  /** Null for account/security email that belongs to a person, not a org. */
  organizationId: string | null;
  resource?: { type: string; id: string };
}

export async function sendEmail(options: SendEmailOptions): Promise<EmailSendOutcome> {
  const config = emailConfig();
  if (!config) return { status: "not_configured" };

  const { message, template, organizationId } = options;
  const address = normalizeEmailAddress(message.to.address);

  if (!isDeliverableAddress(address)) {
    // Not written to the log: there is no address to attribute it to, and a
    // row keyed on garbage is noise rather than evidence.
    return { status: "failed", messageId: null, reason: "invalid_address" };
  }

  const admin = createAdminClient();

  if (respectsSuppression(message.category)) {
    const { data: suppressed } = await admin.from("email_suppressions").select("address").eq("address", address).maybeSingle();
    if (suppressed) {
      const { data } = await admin
        .from("email_messages")
        .insert({
          organization_id: organizationId,
          to_address: address,
          category: message.category,
          template,
          subject: message.subject,
          status: "suppressed",
          resource_type: options.resource?.type ?? null,
          resource_id: options.resource?.id ?? null,
        })
        .select("id")
        .single();

      return { status: "suppressed", messageId: data?.id ?? "" };
    }
  }

  const { data: queued, error: queueError } = await admin
    .from("email_messages")
    .insert({
      organization_id: organizationId,
      to_address: address,
      category: message.category,
      template,
      subject: message.subject,
      status: "queued",
      provider: config.provider.name,
      resource_type: options.resource?.type ?? null,
      resource_id: options.resource?.id ?? null,
    })
    .select("id")
    .single();

  if (queueError || !queued) {
    reportError(queueError, { scope: "route", organizationId: organizationId ?? undefined, detail: { step: "queue_email", template } });
    return { status: "failed", messageId: null, reason: "queue_failed" };
  }

  // The row id doubles as the provider idempotency key: a retry inside this
  // function, and a redelivery after a crash, both present the same key, so
  // the provider collapses them into one message.
  const withKey: EmailMessage = { ...message, to: { ...message.to, address }, idempotencyKey: queued.id };

  let attempts = 0;
  let lastReason = "unknown";

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    const result = await config.provider.send(withKey, config.from);

    if (result.ok) {
      await admin
        .from("email_messages")
        .update({ status: "sent", attempts, provider_message_id: result.providerMessageId, sent_at: new Date().toISOString() })
        .eq("id", queued.id);

      reportEvent("email.sent", {
        scope: "route",
        organizationId: organizationId ?? undefined,
        detail: { template, provider: config.provider.name, attempts },
      });

      return {
        status: "sent",
        messageId: queued.id,
        providerMessageId: result.providerMessageId,
        deliveredForReal: config.provider.deliversForReal,
      };
    }

    lastReason = result.reason;

    // A permanent rejection — a malformed address, an unverified domain —
    // will fail identically forever. Retrying it wastes the budget and
    // delays everything behind it.
    if (!result.retryable) break;
    if (attempts < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, BASE_BACKOFF_MS * 2 ** (attempts - 1)));
    }
  }

  await admin.from("email_messages").update({ status: "failed", attempts, last_error: lastReason }).eq("id", queued.id);

  reportEvent(
    "email.failed",
    { scope: "route", organizationId: organizationId ?? undefined, detail: { template, provider: config.provider.name, attempts, reason: lastReason } },
    "warning",
  );

  return { status: "failed", messageId: queued.id, reason: lastReason };
}
