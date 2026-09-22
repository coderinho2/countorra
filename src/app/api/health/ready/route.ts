import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/observability";
import { checkReadiness, hasOperationsToken } from "@/server/operations/health";

/**
 * Readiness: can this deployment serve real requests — configuration whole,
 * database reachable, schema at the version this build expects. 200 when
 * ready, 503 when not, so an uptime monitor needs no parsing.
 *
 * The public answer is the status word only. The breakdown is for operators,
 * with `Authorization: Bearer $OPERATIONS_TOKEN` (src/server/operations/health.ts).
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = requestIdFrom(request.headers);
  const report = await checkReadiness(requestId);
  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const status = report.status === "ready" ? 200 : 503;
  return NextResponse.json(hasOperationsToken(request.headers) ? report : { status: report.status }, { status, headers });
}
