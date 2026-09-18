import "server-only";
import type { EmailFrom, EmailProvider, ProviderSendResult } from "../types";
import type { EmailMessage } from "@/domain/email/message";

/**
 * Resend, over plain `fetch`.
 *
 * NO SDK, ON PURPOSE. The request is one POST with a JSON body. An SDK would
 * add a dependency and a supply-chain surface to save four lines, and it
 * would bring its own retry policy that fought the one in `send.ts` — two
 * layers of retries multiply into a message delivered many times.
 *
 * The provider is chosen by `EMAIL_PROVIDER=resend`; nothing else in the
 * codebase imports this file, so replacing it is a new file and one arm in
 * config.ts.
 */

const ENDPOINT = "https://api.resend.com/emails";
const TIMEOUT_MS = 15_000;

/** Which HTTP failures are worth sending again. */
function isRetryableStatus(status: number): boolean {
  // 408 timeout, 429 rate limited, 5xx. A 4xx that is not one of those is a
  // rejected message — a bad address, a domain that is not verified — and
  // will fail identically forever.
  return status === 408 || status === 429 || status >= 500;
}

export function createResendProvider(apiKey: string): EmailProvider {
  return {
    name: "resend",
    deliversForReal: true,

    async send(message: EmailMessage, from: EmailFrom): Promise<ProviderSendResult> {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      // Resend honours this to collapse duplicate deliveries of the same
      // message, which matters because `send.ts` retries.
      if (message.idempotencyKey) headers["Idempotency-Key"] = message.idempotencyKey;

      const body: Record<string, unknown> = {
        from: `${from.name} <${from.address}>`,
        to: [message.to.name ? `${message.to.name} <${message.to.address}>` : message.to.address],
        subject: message.subject,
        html: message.html,
        text: message.text,
      };
      if (from.replyTo) body.reply_to = from.replyTo;
      if (message.attachments?.length) {
        body.attachments = message.attachments.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType }));
      }
      if (message.unsubscribeUrl) {
        // RFC 8058. Gmail and Yahoo require this on bulk mail, and it is the
        // difference between an unsubscribe and a spam report.
        body.headers = {
          "List-Unsubscribe": `<${message.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        };
      }

      try {
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (response.ok) {
          const json = (await response.json().catch(() => null)) as { id?: string } | null;
          return { ok: true, providerMessageId: json?.id ?? null };
        }

        // The status is recorded; the body is not. It can echo the address
        // and subject back, and this string is written to an audit row.
        return { ok: false, retryable: isRetryableStatus(response.status), reason: `resend_http_${response.status}` };
      } catch (error) {
        // Timeout or network failure — the message may or may not have been
        // accepted, so this is retryable and the idempotency key is what
        // stops a double send.
        const reason = error instanceof Error && error.name === "TimeoutError" ? "resend_timeout" : "resend_network_error";
        return { ok: false, retryable: true, reason };
      }
    },
  };
}
