import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailMessage } from "@/domain/email/message";

/**
 * The one path every outbound email takes.
 *
 * Uses the memory provider, so the retry policy, the suppression rule and
 * the audit trail are all exercised with no provider account, no network and
 * no Stripe/Resend anything running.
 */

const state = vi.hoisted(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
  process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "test-anon-key";
  process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";
  return {
    configured: true,
    deliversForReal: true,
    /** In-memory `email_messages`. */
    rows: [] as Record<string, unknown>[],
    suppressed: new Set<string>(),
    provider: {
      name: "memory",
      attempts: 0,
      failTimes: 0,
      failRetryable: true,
      sent: [] as EmailMessage[],
    },
  };
});

vi.mock("@/lib/observability", () => ({ reportError: () => {}, reportEvent: () => {} }));

vi.mock("@/server/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          maybeSingle: async () => ({
            data: table === "email_suppressions" && state.suppressed.has(value) ? { address: value } : null,
            error: null,
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            const stored = { id: `msg_${state.rows.length + 1}`, ...row };
            state.rows.push(stored);
            return { data: stored, error: null };
          },
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_column: string, id: string) => {
          const row = state.rows.find((r) => r.id === id);
          if (row) Object.assign(row, patch);
          return { error: null };
        },
      }),
      upsert: async () => ({ error: null }),
    }),
  }),
}));

vi.mock("@/server/email/config", () => ({
  emailConfig: () =>
    state.configured
      ? {
          from: { address: "billing@countorra.test", name: "Countorra" },
          provider: {
            name: state.provider.name,
            deliversForReal: state.deliversForReal,
            async send(message: EmailMessage) {
              state.provider.attempts += 1;
              if (state.provider.attempts <= state.provider.failTimes) {
                return { ok: false as const, retryable: state.provider.failRetryable, reason: "forced_failure" };
              }
              state.provider.sent.push(message);
              return { ok: true as const, providerMessageId: `mem_${state.provider.sent.length}` };
            },
          },
        }
      : null,
  isEmailConfigured: () => state.configured,
  emailDeliversForReal: () => state.deliversForReal,
  resetEmailConfigCache: () => {},
}));

const { sendEmail } = await import("@/server/email/send");

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: { address: "customer@example.test", name: "Wile E. Coyote" },
    subject: "Invoice INV-1",
    html: "<p>hi</p>",
    text: "hi",
    category: "transactional",
    ...overrides,
  };
}

const send = (overrides: Partial<EmailMessage> = {}, options: { template?: string; organizationId?: string | null } = {}) =>
  sendEmail({
    message: message(overrides),
    template: options.template ?? "invoice.new",
    organizationId: options.organizationId === undefined ? "11111111-1111-4111-8111-111111111111" : options.organizationId,
  });

beforeEach(() => {
  state.configured = true;
  state.deliversForReal = true;
  state.rows = [];
  state.suppressed = new Set();
  state.provider.attempts = 0;
  state.provider.failTimes = 0;
  state.provider.failRetryable = true;
  state.provider.sent = [];
});

describe("a successful send", () => {
  it("delivers and reports it", async () => {
    const result = await send();

    expect(result.status).toBe("sent");
    expect(state.provider.sent).toHaveLength(1);
    expect(state.provider.sent[0].subject).toBe("Invoice INV-1");
  });

  it("writes an audit row, and marks it sent", async () => {
    await send();

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ status: "sent", template: "invoice.new", attempts: 1, provider_message_id: "mem_1" });
  });

  it("normalizes the recipient before storing or sending", async () => {
    await send({ to: { address: "  Customer@Example.TEST " } });

    expect(state.rows[0].to_address).toBe("customer@example.test");
    expect(state.provider.sent[0].to.address).toBe("customer@example.test");
  });

  it("gives the provider an idempotency key, so a retry cannot double-send", async () => {
    await send();
    expect(state.provider.sent[0].idempotencyKey).toBe(state.rows[0].id);
  });

  it("reports when the provider does not really deliver", async () => {
    // The console provider in development. Telling the user their customer
    // received an invoice that went to a log file would be a lie.
    state.deliversForReal = false;
    const result = await send();

    expect(result.status).toBe("sent");
    if (result.status === "sent") expect(result.deliveredForReal).toBe(false);
  });
});

describe("retries", () => {
  it("retries a retryable failure and succeeds", async () => {
    state.provider.failTimes = 2;
    const result = await send();

    expect(result.status).toBe("sent");
    expect(state.provider.attempts).toBe(3);
    expect(state.rows[0].attempts).toBe(3);
  });

  it("gives up after the attempt budget", async () => {
    state.provider.failTimes = 99;
    const result = await send();

    expect(result.status).toBe("failed");
    expect(state.provider.attempts).toBe(3);
    expect(state.rows[0]).toMatchObject({ status: "failed", last_error: "forced_failure" });
  });

  it("does NOT retry a permanent rejection", async () => {
    // A malformed address or an unverified domain fails identically forever.
    // Retrying wastes the budget and delays everything behind it.
    state.provider.failTimes = 99;
    state.provider.failRetryable = false;

    const result = await send();

    expect(result.status).toBe("failed");
    expect(state.provider.attempts).toBe(1);
  });

  it("records the failure durably, so it is visible in the product", async () => {
    state.provider.failTimes = 99;
    await send();
    expect(state.rows[0].status).toBe("failed");
  });
});

describe("suppression applies to notifications, never to transactional mail", () => {
  beforeEach(() => state.suppressed.add("customer@example.test"));

  it("suppresses a notification to an unsubscribed address", async () => {
    const result = await send({ category: "notification" }, { template: "insights.digest" });

    expect(result.status).toBe("suppressed");
    expect(state.provider.sent).toHaveLength(0);
    expect(state.rows[0].status).toBe("suppressed");
  });

  it("STILL SENDS a transactional email to the same address", async () => {
    // The rule that matters most. Honouring an unsubscribe on an invoice
    // silently loses someone money, and most jurisdictions exempt
    // transactional mail precisely because withholding it causes harm.
    const result = await send({ category: "transactional" });

    expect(result.status).toBe("sent");
    expect(state.provider.sent).toHaveLength(1);
  });

  it("sends a notification to an address that has not unsubscribed", async () => {
    const result = await send({ category: "notification", to: { address: "someone-else@example.test" } }, { template: "insights.digest" });
    expect(result.status).toBe("sent");
  });
});

describe("addresses it refuses outright", () => {
  it.each(["", "   ", "no-at-sign", "@example.test", "a@", "a@b", "a b@example.test", "a@exam ple.test", "a@.test", "a@test."])(
    "refuses %s without writing a row",
    async (address) => {
      const result = await send({ to: { address } });

      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.reason).toBe("invalid_address");
      // No row: there is no address to attribute it to, so a record keyed on
      // garbage would be noise rather than evidence.
      expect(state.rows).toHaveLength(0);
      expect(state.provider.sent).toHaveLength(0);
    },
  );

  it("accepts an ordinary address", async () => {
    expect((await send({ to: { address: "first.last+tag@sub.example.co.uk" } })).status).toBe("sent");
  });
});

describe("when email is not configured", () => {
  beforeEach(() => {
    state.configured = false;
  });

  it("says so instead of pretending to send", async () => {
    const result = await send();
    expect(result.status).toBe("not_configured");
    expect(state.provider.sent).toHaveLength(0);
  });

  it("writes no audit row for a send that never happened", async () => {
    await send();
    expect(state.rows).toHaveLength(0);
  });
});

describe("it never throws", () => {
  it("returns a result even when the provider fails hard", async () => {
    // Callers are invoice sends and notification sweeps. A provider outage
    // must not roll back an invoice the user already saw marked sent.
    state.provider.failTimes = 99;
    await expect(send()).resolves.toMatchObject({ status: "failed" });
  });
});
