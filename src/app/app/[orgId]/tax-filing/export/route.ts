import { NextResponse } from "next/server";
import { requireOrgMembership } from "@/server/auth/session";
import { createClient } from "@/server/supabase/server";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/domain/audit/audit-log";
import { EXPORT_CONTENT_TYPES, exportFileName, toCsvExport, toJsonExport, toTextSummary, type ExportFormat } from "@/domain/tax-filing/export";
import { reportError, reportEvent } from "@/lib/observability";
import { getFilingSnapshot } from "@/server/db/repositories/tax-filing";
import { packageFingerprint } from "@/server/tax-filing/fingerprint";
import { exportFormatSchema } from "@/validation/schemas/tax-filing";

/**
 * Downloads a stored Countorra Filing Package.
 *
 * Exports what was frozen — never a recomputation — and only after checking
 * the stored package still matches its fingerprint. Every format opens with
 * "Preparation summary — not an IRS or state filing form."
 *
 * Authorization is membership, through the same helper every page uses, and
 * the snapshot is read through the caller's RLS client, so another workspace's
 * package id resolves to nothing. Failures return a generic message; no
 * database error ever reaches the response.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refusal(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const url = new URL(request.url);
  const snapshotId = url.searchParams.get("snapshot") ?? "";
  const format = exportFormatSchema.safeParse(url.searchParams.get("format") ?? "json");

  if (!UUID.test(snapshotId) || !format.success) return refusal(400, "That export isn't available.");

  // Redirects anyone who is not a member. Called outside the try below so the
  // redirect is not mistaken for a failure.
  await requireOrgMembership(orgId);

  try {
    const client = await createClient();
    const snapshot = await getFilingSnapshot(client, snapshotId);
    if (!snapshot || snapshot.organizationId !== orgId) return refusal(404, "That filing package wasn't found.");

    if (packageFingerprint(snapshot.package) !== snapshot.packageFingerprint) {
      reportEvent("tax_filing_export_integrity_failed", { scope: "financial", organizationId: orgId, detail: { version: snapshot.version } }, "error");
      return refusal(409, "This filing package failed its integrity check and can't be exported.");
    }

    const chosen: ExportFormat = format.data;
    const body = chosen === "json" ? toJsonExport(snapshot.package) : chosen === "csv" ? toCsvExport(snapshot.package) : toTextSummary(snapshot.package);

    try {
      await recordAuditEvent(client, {
        organizationId: orgId,
        action: AUDIT_ACTIONS.taxFilingPackageExported,
        resourceType: "tax_filing_case",
        resourceId: snapshot.filingCaseId,
        metadata: { snapshotId: snapshot.id, version: snapshot.version, format: chosen, packageFingerprint: snapshot.packageFingerprint },
      });
    } catch (error) {
      reportError(error, { scope: "financial", organizationId: orgId, detail: { step: "audit", action: AUDIT_ACTIONS.taxFilingPackageExported } });
    }

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": EXPORT_CONTENT_TYPES[chosen],
        "Content-Disposition": `attachment; filename="${exportFileName(snapshot.package, chosen)}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    reportError(error, { scope: "financial", organizationId: orgId, detail: { step: "export_tax_filing_package" } });
    return refusal(500, "The filing package couldn't be exported. Please try again.");
  }
}
