import "server-only";
import type { EmailMessage } from "@/domain/email/message";

/**
 * The contract every email provider implements.
 *
 * Kept this small on purpose. Anything richer — templates, scheduling,
 * contact lists — is a provider feature the product would then depend on,
 * and swapping providers would stop being a one-file change. Countorra
 * renders its own HTML and decides its own suppression; a provider's only
 * job is to hand bytes to an SMTP relay and say what happened.
 */
export interface EmailProvider {
  readonly name: string;
  /** True for providers that never reach the network (console, memory). */
  readonly deliversForReal: boolean;
  send(message: EmailMessage, from: EmailFrom): Promise<ProviderSendResult>;
}

export interface EmailFrom {
  address: string;
  name: string;
  replyTo?: string;
}

export type ProviderSendResult =
  | { ok: true; providerMessageId: string | null }
  /**
   * `retryable` is the provider's judgement about OUR next move, and it is
   * the field that matters most. A 422 for a malformed address will fail
   * identically forever; a 429 or a 503 will not. Retrying the first wastes
   * the budget and delays the queue, and not retrying the second loses mail.
   */
  | { ok: false; retryable: boolean; reason: string };
