import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@/lib/server-env";
import { reportError, reportEvent } from "@/lib/observability";
import { clientAddress, enforceRateLimit } from "@/server/security/rate-limit";
import { createAdminClient } from "@/server/supabase/admin";
import { sweepExpiredIdentityOriginals } from "@/server/documents/retention";

/**
 * THE RETENTION SWEEP'S ENTRY POINT: /api/documents/retention
 *
 * One bounded invocation of the identity-document original sweep. It deletes
 * stored bytes whose retention window has passed (0058) and nothing else; the
 * `documents` row, its filename and its extraction all survive.
 *
 * WHY A ROUTE OF ITS OWN RATHER THAN A BRANCH OF THE BANK WORKER
 *
 * Two reasons, both practical. The bank worker returns early when no bank
 * provider is configured, so a deployment with no Plaid — which is most of
 * them — would silently never sweep. And its sixty-second budget is already
 * spent on bank pages; sharing it would mean document cleanup competing with
 * somebody's transactions for the same seconds.
 *
 * Everything else follows the bank worker exactly: same secret convention,
 * same constant-time comparison, same 404-when-unconfigured, same
 * counters-only response. This is that architecture, not a second one.
 *
 * AUTHORIZATION
 *
 * `Authorization: Bearer …` compared in constant time against CRON_SECRET,
 * which is what Vercel Cron sends and what DEPLOYMENT.md already requires. No
 * session and no organization: the sweep serves every organization, and each
 * row carries the organization the delete is scoped by. With no CRON_SECRET
 * configured the route answers 404, exactly as if it did not exist.
 *
 * WHY IT IS SAFE TO CALL REPEATEDLY, BY ANYONE HOLDING THE SECRET
 *
 * The sweep acts only on rows already past their expiry. Calling it a hundred
 * times deletes nothing that one call would not have deleted; it cannot be
 * used to bring a deletion forward, to reach a financial document, or to
 * touch a document whose window is still running.
 *
 * THE RESPONSE IS COUNTERS ONLY
 *
 * No organization id, no document id, no storage path, no filename. A storage
 * path contains a document id, and this response ends up in cron logs.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Seconds. The sweep is bounded to one page, which is a few dozen small
 *  deletes; this is headroom, not a target. */
export const maxDuration = 60;

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

function presentedSecret(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "") : request.headers.get("x-cron-secret");
}

function sameSecret(presented: string | null, expected: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function configuredSecret(): string | null {
  try {
    return serverEnv().CRON_SECRET ?? null;
  } catch {
    // A half-configured environment must not turn into an open endpoint.
    return null;
  }
}

/** Vercel Cron identifies itself. Recorded, never trusted — the secret is
 *  what authorizes. */
function invoker(request: Request): "vercel-cron" | "other" {
  return /^vercel-cron\//i.test(request.headers.get("user-agent") ?? "") ? "vercel-cron" : "other";
}

async function handle(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const secret = configuredSecret();
  if (!secret) return Response.json({ error: "not_configured" }, { status: 404 });

  // Before the comparison, so guessing the secret is bounded rather than free.
  const limited = await enforceRateLimit("documentRetention", { documentRetentionPerIp: await clientAddress() });
  if (!limited.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(Math.max(1, limited.retryAfterSeconds)) } });

  const caller = invoker(request);
  if (!sameSecret(presentedSecret(request), secret)) {
    reportEvent("documents.retention_unauthorized", { scope: "security", detail: { route: "document-retention", invoker: caller } }, "warning");
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // An admin client: the sweep acts for every organization at once and
    // belongs to no member, so RLS would make it see nothing.
    const result = await sweepExpiredIdentityOriginals(createAdminClient());

    reportEvent(
      "documents.retention_invocation",
      { scope: "documents", detail: { invoker: caller, considered: result.considered, filesRemoved: result.filesRemoved, rowsMarked: result.rowsMarked, failed: result.failed, remaining: result.remaining, durationMs: Date.now() - startedAt } },
      result.failed > 0 ? "warning" : "info",
    );

    return Response.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    reportError(error, { scope: "documents", detail: { step: "retention_route", invoker: caller, durationMs: Date.now() - startedAt } });
    return Response.json({ error: "sweep_failed" }, { status: 503 });
  }
}

/** Vercel Cron issues GET. The work is idempotent, so a repeated delivery
 *  costs nothing; both verbs require the secret. */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
