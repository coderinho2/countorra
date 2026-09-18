import "server-only";
import { isDeliverableAddress } from "@/domain/email/message";
import type { EmailFrom, EmailProvider } from "./types";
import { consoleEmailProvider } from "./providers/console";
import { createResendProvider } from "./providers/resend";

/**
 * Email configuration. SERVER ONLY — no key here may reach a bundle.
 *
 * Shaped exactly like `stripe-config.ts`, deliberately: unconfigured returns
 * null and every caller decides what that means, rather than the app failing
 * to boot over an optional capability. A partial configuration throws,
 * because "can address mail but has no credential" is a state that fails at
 * the worst moment — when an invoice is being sent to a real customer.
 *
 * PROVIDERS
 *
 *   console — writes the rendered message to the server log and returns
 *             success. The default in development, so the whole invoice flow
 *             is exercisable with no account anywhere. `deliversForReal` is
 *             false, and the UI says so rather than claiming an email was
 *             sent to a customer.
 *   resend  — real delivery over plain `fetch`. No SDK: the REST call is
 *             three lines and an SDK would be a dependency, a supply-chain
 *             surface and a second retry policy fighting ours.
 *
 * A new provider is a file in ./providers plus one arm below.
 */

export type EmailProviderName = "console" | "resend";

export interface EmailConfig {
  provider: EmailProvider;
  from: EmailFrom;
}

let cached: EmailConfig | null | undefined;

function readFrom(): EmailFrom | null {
  const address = process.env.EMAIL_FROM_ADDRESS?.trim();
  if (!address) return null;
  return {
    address,
    name: process.env.EMAIL_FROM_NAME?.trim() || "Countorra",
    replyTo: process.env.EMAIL_REPLY_TO?.trim() || undefined,
  };
}

export function emailConfig(): EmailConfig | null {
  if (cached !== undefined) return cached;

  if (typeof window !== "undefined") {
    throw new Error("emailConfig() must never be called from the client.");
  }

  const providerName = (process.env.EMAIL_PROVIDER?.trim() || "") as EmailProviderName | "";
  const from = readFrom();

  // Nothing configured at all: the product runs, and email-dependent
  // features say so.
  if (!providerName && !from && !process.env.RESEND_API_KEY) {
    cached = null;
    return cached;
  }

  const missing: string[] = [];
  if (!providerName) missing.push("EMAIL_PROVIDER");
  if (!from) missing.push("EMAIL_FROM_ADDRESS");

  if (providerName === "resend" && !process.env.RESEND_API_KEY?.trim()) {
    missing.push("RESEND_API_KEY");
  }

  if (missing.length > 0) {
    // Names only — a value here would put a live credential in a log.
    throw new Error(
      `Email is partially configured: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing. Set all of them, or none of them to run without email.`,
    );
  }

  if (from && !isDeliverableAddress(from.address)) {
    throw new Error("EMAIL_FROM_ADDRESS is not a usable email address.");
  }
  if (from?.replyTo && !isDeliverableAddress(from.replyTo)) {
    throw new Error("EMAIL_REPLY_TO is not a usable email address.");
  }

  let provider: EmailProvider;
  switch (providerName) {
    case "resend":
      provider = createResendProvider(process.env.RESEND_API_KEY!.trim());
      break;
    case "console":
      provider = consoleEmailProvider;
      break;
    default:
      throw new Error(`EMAIL_PROVIDER "${providerName}" is not a provider this build knows about.`);
  }

  cached = { provider, from: from! };
  return cached;
}

/** Test seam. Never called by application code. */
export function resetEmailConfigCache(): void {
  cached = undefined;
}

export function isEmailConfigured(): boolean {
  return emailConfig() !== null;
}

/**
 * Whether email actually LEAVES this deployment.
 *
 * Distinct from "configured": the console provider is a valid configuration
 * that delivers nothing. The UI uses this to avoid telling a user their
 * customer received an invoice when it went to a log file.
 */
export function emailDeliversForReal(): boolean {
  return emailConfig()?.provider.deliversForReal ?? false;
}
