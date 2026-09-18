import "server-only";
import type { EmailFrom, EmailProvider, ProviderSendResult } from "../types";
import type { EmailMessage } from "@/domain/email/message";

/**
 * The test provider. Captures what would have been sent, and can be told to
 * fail in either of the two ways that matter.
 *
 * This is why the whole email path is testable without a provider account,
 * a network, or a running Stripe/Resend anything: the suite asserts on
 * `sent`, and the retry policy is exercised by `failTimes`.
 */
export interface MemoryEmailProvider extends EmailProvider {
  sent: { message: EmailMessage; from: EmailFrom }[];
  /** Fail this many attempts before succeeding. */
  failTimes: number;
  /** Whether those failures are retryable. */
  failRetryable: boolean;
  attempts: number;
  reset(): void;
}

export function createMemoryEmailProvider(options: { deliversForReal?: boolean } = {}): MemoryEmailProvider {
  const provider: MemoryEmailProvider = {
    name: "memory",
    deliversForReal: options.deliversForReal ?? true,
    sent: [],
    failTimes: 0,
    failRetryable: true,
    attempts: 0,

    async send(message: EmailMessage, from: EmailFrom): Promise<ProviderSendResult> {
      provider.attempts += 1;

      if (provider.attempts <= provider.failTimes) {
        return { ok: false, retryable: provider.failRetryable, reason: "memory_forced_failure" };
      }

      provider.sent.push({ message, from });
      return { ok: true, providerMessageId: `mem_${provider.sent.length}` };
    },

    reset() {
      provider.sent = [];
      provider.failTimes = 0;
      provider.failRetryable = true;
      provider.attempts = 0;
    },
  };

  return provider;
}
