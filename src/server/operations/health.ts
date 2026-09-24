import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/server/supabase/admin";
import { serverEnv } from "@/lib/server-env";
import { isBillingConfigured } from "@/server/billing/stripe-config";
import { bankProviderConfigured } from "@/server/bank-connections/providers";
import { emailConfig } from "@/server/email/config";
import { textractConfigured } from "@/server/documents/textract/client";
import { measureDependency, runtimeIdentity } from "@/lib/observability";

/**
 * Health and readiness — what Countorra can honestly say about itself.
 *
 * WHAT THIS CAN AND CANNOT SEE
 *
 * The application can check what it depends on from inside a request: can it
 * reach the database, is the database's schema the one this build expects,
 * is its own configuration whole. It CANNOT see the platform: function
 * concurrency, cold starts, region health, Postgres CPU, connections or disk
 * are Vercel's and Supabase's to report, in their dashboards. Nothing here
 * pretends otherwise, and no figure is produced that was not measured.
 *
 * WHAT IS PUBLIC
 *
 * `/api/health` (liveness) and `/api/health/ready` (readiness) answer anyone
 * with a status word and an HTTP status — enough for an uptime monitor, and
 * nothing an attacker can use. The breakdown (which check failed, latency,
 * which integrations are configured, the schema version) is returned only
 * with `Authorization: Bearer $OPERATIONS_TOKEN`. No secret value, host name
 * or connection string is ever included, even then.
 */

/** The migration this build expects the database to have reached. Keep in
 *  step with `operations_schema_version()` in the latest migration. */
export const EXPECTED_SCHEMA_VERSION = "0057";

const DATABASE_TIMEOUT_MS = 3_000;
const CACHE_MS = 15_000;

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checkedAt: string;
  environment: string;
  release: string | null;
  checks: {
    database: { ok: boolean; latencyMs: number | null; error: string | null };
    schema: { ok: boolean; expected: string; actual: string | null };
    configuration: { ok: boolean; error: string | null };
  };
  /** Optional integrations: whether each is configured. Never a value. */
  integrations: { stripe: boolean; plaid: boolean; email: boolean; documentOcr: boolean; bankWorkerCron: boolean; operationsToken: boolean };
}

async function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safely(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

async function runReadiness(requestId: string): Promise<ReadinessReport> {
  let configuration: ReadinessReport["checks"]["configuration"] = { ok: true, error: null };
  try {
    serverEnv();
  } catch (error) {
    // The variable NAMES in a validation message are useful and not secret;
    // values are never part of it.
    configuration = { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : "invalid configuration" };
  }

  let database: ReadinessReport["checks"]["database"] = { ok: false, latencyMs: null, error: null };
  let actual: string | null = null;
  if (configuration.ok) {
    const started = performance.now();
    try {
      const { data, error } = await measureDependency("database", "operations_schema_version", { scope: "route", requestId }, () =>
        withTimeout(createAdminClient().rpc("operations_schema_version"), DATABASE_TIMEOUT_MS),
      );
      database = { ok: !error || error.code === "PGRST202", latencyMs: Math.round(performance.now() - started), error: error ? "query failed" : null };
      // PGRST202: the function does not exist yet — the database is reachable
      // but behind this build's migrations.
      actual = error ? null : (data ?? null);
    } catch (error) {
      database = { ok: false, latencyMs: null, error: error instanceof Error && /timed out/.test(error.message) ? "timeout" : "unreachable" };
    }
  }

  const schema = { ok: actual === EXPECTED_SCHEMA_VERSION, expected: EXPECTED_SCHEMA_VERSION, actual };
  const env = configuration.ok ? serverEnv() : null;

  return {
    status: configuration.ok && database.ok && schema.ok ? "ready" : "not_ready",
    checkedAt: new Date().toISOString(),
    ...runtimeIdentity(),
    checks: { database, schema, configuration },
    integrations: {
      stripe: safely(isBillingConfigured),
      plaid: safely(bankProviderConfigured),
      email: safely(() => emailConfig() !== null),
      // Whether a paid document reader exists on this deployment. A boolean
      // and nothing more: it says a region is configured, never which one and
      // never a credential. Without it an operator turning OCR on has no way
      // to confirm the environment took effect short of uploading a photo and
      // watching what happens.
      documentOcr: safely(textractConfigured),
      bankWorkerCron: Boolean(env?.BANK_SYNC_WORKER_SECRET && env?.CRON_SECRET),
      operationsToken: Boolean(env?.OPERATIONS_TOKEN),
    },
  };
}

let cached: { at: number; report: Promise<ReadinessReport> } | null = null;

/**
 * Readiness, computed at most once per 15 seconds per instance: the public
 * endpoint must not become a way to put load on the database.
 */
export function checkReadiness(requestId: string, now: number = Date.now()): Promise<ReadinessReport> {
  if (!cached || now - cached.at > CACHE_MS) {
    cached = { at: now, report: runReadiness(requestId) };
  }
  return cached.report;
}

/** Test seam. */
export function __resetReadinessCacheForTests(): void {
  cached = null;
}

/**
 * Whether the request carries the operations token. Constant-time, and false
 * whenever the token is not configured — the detailed views are then off.
 */
export function hasOperationsToken(headers: { get(name: string): string | null }): boolean {
  let expected: string | undefined;
  try {
    expected = serverEnv().OPERATIONS_TOKEN;
  } catch {
    return false;
  }
  if (!expected) return false;
  const header = headers.get("authorization");
  const presented = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "") : null;
  if (!presented) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

export function operationsEnabled(): boolean {
  try {
    return Boolean(serverEnv().OPERATIONS_TOKEN);
  } catch {
    return false;
  }
}
