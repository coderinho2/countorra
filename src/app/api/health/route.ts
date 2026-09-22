import { NextResponse } from "next/server";
import { requestIdFrom } from "@/lib/observability";

/**
 * Liveness: the application is running and can answer a request. It checks
 * nothing else on purpose — a liveness probe that fails when the database is
 * down makes a platform restart healthy instances. Readiness is
 * /api/health/ready. Public, and says nothing but "ok".
 */
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return NextResponse.json(
    { status: "ok" },
    { headers: { "Cache-Control": "no-store", "x-request-id": requestIdFrom(request.headers) } },
  );
}
