import "server-only";
import type { EmailFrom, EmailProvider, ProviderSendResult } from "../types";
import type { EmailMessage } from "@/domain/email/message";

/**
 * Development provider. Renders to the server log and delivers nothing.
 *
 * It exists so the entire invoice-sending flow — render, attach the PDF,
 * write the audit row, move the status to `sent` — is exercisable end to end
 * with no account at any provider. The alternative is developing against a
 * disabled feature and discovering the bugs in production.
 *
 * `deliversForReal: false` is the important field: it is what stops the UI
 * telling someone their customer received an invoice that went to stdout.
 *
 * The BODY is never logged. An invoice email contains a customer's name and
 * what they owe; server logs are the wrong home for that, and the habit of
 * logging message bodies is exactly how PII ends up in a log aggregator.
 */
export const consoleEmailProvider: EmailProvider = {
  name: "console",
  deliversForReal: false,

  async send(message: EmailMessage, from: EmailFrom): Promise<ProviderSendResult> {
    console.info(
      `[email:console] would send "${message.subject}" from ${from.address} to ${message.to.address}` +
        ` (${message.category}, ${message.attachments?.length ?? 0} attachment(s), ${message.html.length} bytes html)`,
    );
    return { ok: true, providerMessageId: null };
  },
};
