import { configuredBankProviders } from "@/server/bank-connections/providers";
import { productionBankDependencies } from "@/server/bank-connections/runtime";
import { MAX_WEBHOOK_BODY_BYTES, ingestBankWebhook } from "@/server/bank-connections/webhooks";

/**
 * Bank-provider webhooks: POST /api/bank-connections/webhooks/<provider>.
 *
 * No session, no cookie, no organization in the request — a webhook is not a
 * user. Everything that makes it safe lives in src/server/bank-connections/
 * webhooks.ts: provider signature verification on the raw body, idempotent
 * claiming by event id, and a plan that never writes a financial row.
 *
 * This deployment has no bank provider, so every request is answered 404
 * before the body is read and before a database client exists.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,31}$/;

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await context.params;
  if (!PROVIDER_ID.test(provider) || !configuredBankProviders().some((candidate) => candidate.id === provider)) {
    return Response.json({ error: "not_configured" }, { status: 404 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return Response.json({ error: "too_large" }, { status: 413 });
  }

  // RAW body: signatures are computed over the exact bytes sent.
  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = await ingestBankWebhook(productionBankDependencies(), { providerId: provider, rawBody, headers });
  return Response.json(result.body, { status: result.status });
}
