import type { Instrumentation } from "next";
import { reportError } from "@/lib/observability";

/**
 * NEXT.JS INSTRUMENTATION — the process-wide observability hook.
 *
 * `onRequestError` receives every error no route, action or page caught
 * itself. Until now those went only to Next's own logger, bypassing the
 * redaction in src/lib/observability.ts; now they pass through it like every
 * other report, and so reach any sink registered below.
 *
 * WHAT IS RECORDED
 *
 * The route PATTERN (`/app/[orgId]/invoices/[invoiceId]`), the route type, the
 * router, the HTTP method and Next's error digest. Deliberately NOT the
 * concrete path: `/invoice/<token>` carries a public invoice token, and
 * `/app/<orgId>/…` paths carry tenant ids in a place nobody chose to log.
 * Never the headers — they hold the session cookie.
 *
 * WHERE AN ERROR-TRACKING VENDOR ATTACHES
 *
 * `register()` runs once per server process. When a vendor is chosen, it is
 * initialised there and attached with `registerObservabilitySink` — and
 * nothing else in the codebase changes. With no vendor, `register()` does
 * nothing and every record goes to the console, which the host's log pipeline
 * (a Vercel log drain, for instance) can forward without any code at all. See
 * DEPLOYMENT.md, "Error tracking".
 */

export async function register(): Promise<void> {
  // Intentionally empty until a vendor is chosen. The shape, for when it is:
  //
  //   if (process.env.NEXT_RUNTIME === "nodejs" && process.env.ERROR_TRACKING_DSN) {
  //     const vendor = await import("<vendor sdk>");
  //     vendor.init({ dsn: process.env.ERROR_TRACKING_DSN });
  //     registerObservabilitySink({ name: "vendor", capture: (record) => vendor.capture(record) });
  //   }
}

type ErrorWithDigest = Error & { digest?: string };

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const digest = typeof (error as ErrorWithDigest | undefined)?.digest === "string" ? (error as ErrorWithDigest).digest : undefined;
  const header = request.headers["x-request-id"];
  const requestId = typeof header === "string" ? header : undefined;
  reportError(error, {
    scope: "route",
    digest,
    requestId,
    detail: {
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind,
      method: request.method,
    },
  });
};
