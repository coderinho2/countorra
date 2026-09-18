import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/env";
import { reportError, reportEvent } from "@/lib/observability";
import { clientAddress, enforceRateLimit } from "@/server/security/rate-limit";
import { configuredBankProviders } from "@/server/bank-connections/providers";
import { productionBankDependencies } from "@/server/bank-connections/runtime";
import { runBankSyncScheduler, runBankSyncWorker } from "@/server/bank-connections/worker";
import { WORKER_ROUTE_MAX_DURATION_SECONDS, workerStartBudgetMs } from "@/domain/bank-connections/worker";

/**
 * THE SCHEDULER'S ENTRY POINT: /api/bank-connections/worker
 *
 * One bounded invocation of the bank sync scheduler and worker. Whatever calls
 * it — Vercel Cron, a scheduled function on another host, a queue consumer, a
 * systemd timer, a person with the secret and curl — calls only this, and
 * nothing about the work depends on which. See PLAID-INTEGRATION.md.
 *
 *   ?mode=both      (default) reclaim abandoned leases, queue due syncs, then work
 *   ?mode=schedule  reclaim and queue only
 *   ?mode=work      execute queued jobs only
 *
 * AUTHORIZATION
 *
 * A deployment secret in `Authorization: Bearer …` (Vercel Cron's convention)
 * or `x-bank-worker-secret`, compared in constant time against
 * BANK_SYNC_WORKER_SECRET. There is no session and no organization in the
 * request: the worker serves every organization, and each job carries the
 * organization every database call it makes is scoped by. No user
 * authorization is weakened to make this work — a job can only exist because
 * an authorized action, a verified webhook or the scheduler created it.
 *
 * With no secret configured the route answers 404, exactly as if it did not
 * exist, so an unauthenticated caller learns nothing either way.
 *
 * GET IS SUPPORTED BECAUSE CRON USES IT
 *
 * Vercel Cron issues GET. This endpoint is not idempotent in the HTTP sense —
 * it starts work — but the work itself is idempotent (window-keyed scheduling,
 * one active job per connection, idempotent ingest), so a repeated delivery
 * costs nothing. Both verbs require the secret.
 *
 * VERCEL CRON
 *
 * `vercel.json` invokes this path every five minutes (production deployments
 * only — Vercel does not run crons on previews). Vercel sends
 * `Authorization: Bearer $CRON_SECRET`, which is checked exactly like any
 * other caller against BANK_SYNC_WORKER_SECRET: a cron call gets no
 * exemption from the secret or from the rate limit. CRON_SECRET must
 * therefore hold the same value; if it does not, every cron call is refused
 * and `bank.worker_cron_secret_mismatch` is reported as an error.
 *
 * TIME
 *
 * `maxDuration = 60` is this function's hard limit. The worker is given a
 * start budget of `workerStartBudgetMs` (30 s): no job is claimed and no new
 * provider page is started after it, so the page in flight — however slow the
 * bank is — still finishes inside the limit, and the rest of a backlog
 * continues in a CONTINUATION job on the next invocation.
 *
 * THE RESPONSE IS COUNTERS ONLY
 *
 * No organization id, no connection id, no institution, no amount, no
 * credential. A caller holding the deployment secret is an operator, not a
 * tenant, and this response ends up in cron logs.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Seconds. A literal, because Next reads route segment config statically; a
 *  test asserts it equals WORKER_ROUTE_MAX_DURATION_SECONDS. */
export const maxDuration = 60;

type Mode = "both" | "schedule" | "work";

/** The credential the caller presented, from either accepted header. */
function presentedSecret(request: Request): string | null {
  const header = request.headers.get("authorization");
  const bearer = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "") : null;
  return bearer ?? request.headers.get("x-bank-worker-secret");
}

/** Constant-time comparison over digests, so neither the secret's length nor
 *  its leading characters can be measured. */
function sameSecret(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

interface WorkerEnvironment {
  secret: string | null;
  cronSecret: string | null;
  heartbeatUrl: string | null;
}

function workerEnvironment(): WorkerEnvironment {
  try {
    const env = serverEnv();
    return { secret: env.BANK_SYNC_WORKER_SECRET ?? null, cronSecret: env.CRON_SECRET ?? null, heartbeatUrl: env.BANK_SYNC_HEARTBEAT_URL ?? null };
  } catch {
    // A half-configured environment must not turn into an open endpoint.
    return { secret: null, cronSecret: null, heartbeatUrl: null };
  }
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Vercel Cron identifies itself; anything else is an operator or another
 *  scheduler. Recorded, never trusted — the secret is what authorizes. */
function invoker(request: Request): "vercel-cron" | "other" {
  return /^vercel-cron\//i.test(request.headers.get("user-agent") ?? "") ? "vercel-cron" : "other";
}

/**
 * Pings the operator's dead-man's switch. Awaited (a serverless function may
 * be frozen the moment it responds), bounded to three seconds, and never
 * allowed to change the response. The URL is never logged: these URLs carry a
 * secret path segment.
 */
async function pingHeartbeat(url: string): Promise<void> {
  try {
    const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000), cache: "no-store" });
    if (!response.ok) reportEvent("bank.worker_heartbeat_failed", { scope: "bank", detail: { status: response.status } }, "warning");
  } catch (error) {
    reportEvent("bank.worker_heartbeat_failed", { scope: "bank", detail: { reason: error instanceof Error ? error.name : "unknown" } }, "warning");
  }
}

function mode(request: Request): Mode {
  const value = new URL(request.url).searchParams.get("mode");
  return value === "schedule" || value === "work" ? value : "both";
}

async function handle(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const { secret, cronSecret, heartbeatUrl } = workerEnvironment();
  if (!secret) return Response.json({ error: "not_configured" }, { status: 404 });

  // Before the comparison, so guessing the secret is bounded rather than free.
  const limited = await enforceRateLimit("bankWorker", { bankWorkerPerIp: await clientAddress() });
  if (!limited.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(Math.max(1, limited.retryAfterSeconds)) } });

  const caller = invoker(request);
  const presented = presentedSecret(request);
  if (!sameSecret(presented, secret)) {
    reportEvent("bank.worker_unauthorized", { scope: "security", detail: { route: "bank-worker", invoker: caller } }, "warning");
    // The one refusal that is OUR fault: the caller presented this
    // deployment's CRON_SECRET, and it is not the worker secret. That is
    // Vercel Cron being refused every five minutes and every automatic import
    // silently stopping — so it is an error, and only this exact case is.
    // A stranger's wrong guess can never trigger it.
    if (cronSecret && sameSecret(presented, cronSecret)) {
      reportEvent("bank.worker_cron_secret_mismatch", { scope: "bank", detail: { route: "bank-worker", invoker: caller } }, "error");
    }
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (configuredBankProviders().length === 0) {
    reportEvent("bank.worker_invocation", { scope: "bank", detail: { invoker: caller, providerConfigured: false, durationMs: Date.now() - startedAt } });
    if (heartbeatUrl) await pingHeartbeat(heartbeatUrl);
    return Response.json({ ok: true, providerConfigured: false, scheduled: null, worked: null }, { status: 200 });
  }

  const requested = mode(request);
  // Everything that starts new work must start by this instant; see TIME above.
  const budgetMs = workerStartBudgetMs({ functionLimitMs: WORKER_ROUTE_MAX_DURATION_SECONDS * 1000 });
  try {
    const deps = productionBankDependencies();
    const scheduled = requested === "work" ? null : await runBankSyncScheduler(deps);
    const worked =
      requested === "schedule"
        ? null
        : await runBankSyncWorker(deps, {
            maxDurationMs: Math.max(1_000, budgetMs - (Date.now() - startedAt)),
            pageDeadline: startedAt + budgetMs,
          });

    reportEvent(
      "bank.worker_invocation",
      {
        scope: "bank",
        detail: {
          invoker: caller,
          mode: requested,
          providerConfigured: true,
          executed: worked?.executed ?? 0,
          failed: worked?.failed ?? 0,
          abandoned: worked?.abandoned ?? 0,
          stoppedBecause: worked?.stoppedBecause ?? null,
          durationMs: Date.now() - startedAt,
        },
      },
      (worked?.failed ?? 0) + (worked?.abandoned ?? 0) > 0 ? "warning" : "info",
    );
    if (heartbeatUrl) await pingHeartbeat(heartbeatUrl);

    return Response.json(
      {
        ok: true,
        providerConfigured: true,
        mode: requested,
        scheduled: scheduled && {
          reclaimedLeases: scheduled.reclaimedLeases,
          considered: scheduled.connectionsConsidered,
          created: scheduled.jobsCreated,
          alreadyActive: scheduled.alreadyActive,
          duplicates: scheduled.duplicates,
          skipped: scheduled.skipped,
          durationMs: scheduled.durationMs,
        },
        worked: worked && {
          executed: worked.executed,
          succeeded: worked.succeeded,
          failed: worked.failed,
          retrying: worked.retrying,
          cancelled: worked.cancelled,
          abandoned: worked.abandoned,
          continuations: worked.continuations,
          stoppedBecause: worked.stoppedBecause,
          durationMs: worked.durationMs,
        },
      },
      { status: 200 },
    );
  } catch (error) {
    // No heartbeat: an invocation that failed outright is exactly what the
    // dead-man's switch exists to notice.
    reportError(error, { scope: "bank", detail: { step: "worker_route", mode: requested, invoker: caller, durationMs: Date.now() - startedAt } });
    return Response.json({ error: "worker_failed" }, { status: 503 });
  }
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}
