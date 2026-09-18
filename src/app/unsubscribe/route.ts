import { escapeHtml } from "@/domain/email/layout";
import { suppressAddress, verifyUnsubscribeToken } from "@/server/email/unsubscribe";
import { reportEvent } from "@/lib/observability";

/**
 * Unsubscribe, for both ways a client does it.
 *
 *   GET  — a person clicking the link in an email. Suppresses, then renders
 *          a plain confirmation.
 *   POST — RFC 8058 one-click, which Gmail and Yahoo require on bulk mail.
 *          The mail client fires it with no user interaction, so it must
 *          succeed without a form, a session, or a redirect.
 *
 * Deliberately NOT authenticated. The recipient of a notification may not
 * have an account at all — a customer, or someone who was invited once — and
 * requiring a login to stop receiving mail is precisely the dark pattern the
 * regulation exists to forbid. The HMAC in the link is the authorization.
 *
 * A GET that unsubscribes is normally a mistake (scanners and prefetchers
 * follow links). It is correct here: the action is idempotent, reversible by
 * re-subscribing, and erring toward "stopped sending" is the safe direction.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address") ?? "";
  const token = searchParams.get("token") ?? "";

  if (!address || !verifyUnsubscribeToken(address, token)) {
    // One generic answer for a missing token, a wrong token and a malformed
    // address: distinguishing them would confirm which addresses exist.
    return page("That link isn't valid", "This unsubscribe link is incomplete or has been altered. If you keep receiving emails you didn't ask for, reply to one of them and we'll remove you.", 400);
  }

  await suppressAddress(address, "user_unsubscribed");
  reportEvent("email.unsubscribed", { scope: "route", detail: { source: request.method.toLowerCase() } });

  return page(
    "You've been unsubscribed",
    "You won't receive further notification emails from Countorra at this address. Invoices and account or security messages will still be delivered — those are part of a transaction rather than a mailing list.",
    200,
  );
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

/** A self-contained page. No layout import: this renders for someone with no
 *  session, and pulling the app shell in would drag auth into the path. */
function page(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} — Countorra</title>
</head>
<body style="margin:0;background:#f7f6f3;font:400 15px/23px -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#5c5c57;">
  <main style="max-width:520px;margin:0 auto;padding:64px 24px;">
    <p style="margin:0 0 24px;font-weight:600;color:#1a1a18;">Countorra</p>
    <h1 style="margin:0 0 12px;font-size:22px;line-height:30px;font-weight:600;color:#1a1a18;letter-spacing:-0.01em;">${escapeHtml(title)}</h1>
    <p style="margin:0;">${escapeHtml(body)}</p>
  </main>
</body>
</html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
