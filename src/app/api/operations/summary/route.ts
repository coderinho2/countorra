import { NextResponse } from "next/server";
import { measureDependency, reportEvent, requestIdFrom } from "@/lib/observability";
import { createAdminClient } from "@/server/supabase/admin";
import { hasOperationsToken, operationsEnabled } from "@/server/operations/health";

/**
 * INTERNAL operational reporting — never user financial reporting, and never
 * shown to a Countorra user. Counts of webhooks, sync jobs and runs,
 * connection health, email delivery, security events and AI usage over a
 * window, from `operations_summary()` (0053): counts only, no identifiers,
 * amounts or text.
 *
 * `Authorization: Bearer $OPERATIONS_TOKEN` only. With no token configured the
 * endpoint does not exist (404); with a wrong one it refuses (401). `?hours=`
 * sets the window, 1–168, default 24.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request.headers);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  if (!operationsEnabled()) return NextResponse.json({ error: "not_found" }, { status: 404, headers });
  if (!hasOperationsToken(request.headers)) {
    reportEvent("operations.unauthorized", { scope: "security", requestId }, "warning");
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  }

  const hours = Number(new URL(request.url).searchParams.get("hours") ?? 24);
  const window = Number.isInteger(hours) && hours >= 1 && hours <= 168 ? hours : 24;
  const since = new Date(Date.now() - window * 3_600_000).toISOString();

  try {
    const { data, error } = await measureDependency("database", "operations_summary", { scope: "route", requestId }, async () =>
      createAdminClient().rpc("operations_summary", { p_since: since }),
    );
    if (error) throw error;
    return NextResponse.json({ windowHours: window, summary: data }, { headers });
  } catch {
    // Already recorded by measureDependency, with the request id.
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers });
  }
}
