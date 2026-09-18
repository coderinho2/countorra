"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { createClient } from "@/server/supabase/server";
import { createAdminClient } from "@/server/supabase/admin";
import { requireOrgMembership } from "@/server/auth/session";
import { can, type Permission } from "@/domain/organizations/permissions";
import { AUDIT_ACTIONS, recordAuditEvent } from "@/domain/audit/audit-log";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { reportError, reportEvent } from "@/lib/observability";
import { buildFilingPackage } from "@/domain/tax-filing/package";
import { FILING_TAX_YEAR, filingCaseStatusFor, type FilingCaseStatus } from "@/domain/tax-filing/types";
import { findLivePreparationCase } from "@/server/db/repositories/tax-preparation";
import {
  getFilingCase,
  getFilingCaseForPreparation,
  insertFilingCase,
  insertFilingSnapshot,
  insertFinalization,
  updateFilingCase,
} from "@/server/db/repositories/tax-filing";
import { loadFilingWorkspace, type FilingWorkspace } from "@/server/tax-filing/workspace";
import { inputFingerprint, packageFingerprint } from "@/server/tax-filing/fingerprint";
import { filingActionSchema, finalizeFilingSchema, startFilingSchema } from "@/validation/schemas/tax-filing";

/**
 * Tax filing mutations.
 *
 * NOTHING HERE FILES ANYTHING. There is no submission, no transmission and no
 * provider. The furthest any action goes is finalization: a person confirms a
 * reviewed, immutable snapshot inside Countorra.
 *
 * Every action follows the same order, and the order is the point:
 *
 *   1. validate the form              — a browser's fields are claims
 *   2. authenticate + authorize       — membership, then the permission
 *   3. rate limit                     — after authorization
 *   4. load through the RLS client    — proves the caller can see the records,
 *                                       and is the only source of every id used
 *   5. recompute readiness and re-run the engines on the frozen inputs
 *   6. write with the SERVICE ROLE    — members have no write policy on the
 *                                       filing tables (0044); the triggers there
 *                                       still check the invariants Postgres can
 *   7. audit, with codes and versions — never names, figures or identifiers
 *
 * Errors a person sees are generic. A Postgres or Supabase message never
 * reaches the page; it is reported, not returned.
 */

type Client = SupabaseClient<Database>;

export interface TaxFilingActionResult {
  error?: string;
  success?: boolean;
  message?: string;
}

const GENERIC_FAILURE = "That couldn't be completed, and nothing was changed. Please try again.";
const UNIQUE_VIOLATION = "23505";

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

function pagePath(organizationId: string): string {
  return `/app/${organizationId}/tax-filing`;
}

async function authorize(organizationId: string, permission: Permission, bucket: "record" | "privileged"): Promise<{ userId: string } | { error: string }> {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, permission)) {
    return { error: permission === "tax:finalize" ? "Only an owner, admin or accountant can finalize a return." : "You don't have permission to change tax filing for this workspace." };
  }

  const limited =
    bucket === "record"
      ? await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id })
      : await enforceRateLimit("privilegedMutation", { privilegedMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  return { userId: user.id };
}

async function audit(client: Client, organizationId: string, action: string, resourceId: string, metadata: Record<string, Json>) {
  try {
    await recordAuditEvent(client, { organizationId, action, resourceType: "tax_filing_case", resourceId, metadata });
  } catch (error) {
    // The change itself succeeded. An audit failure is reported loudly but does
    // not undo it — the same rule tax preparation follows.
    reportError(error, { scope: "financial", organizationId, detail: { step: "audit", action } });
  }
}

/** The filing workspace for a filing case, loaded through the caller's RLS client. */
async function loadCase(client: Client, organizationId: string, filingCaseId: string): Promise<FilingWorkspace | { error: string }> {
  const filingCase = await getFilingCase(client, filingCaseId);
  if (!filingCase || filingCase.organizationId !== organizationId) return { error: "Tax filing not found." };

  const workspace = await loadFilingWorkspace(client, organizationId, filingCase.preparationCaseId);
  if (!workspace?.filingCase || workspace.filingCase.id !== filingCaseId) return { error: "Tax filing not found." };
  return workspace;
}

/** Where the case belongs now: FINALIZED only while its finalized snapshot is still current. */
function settledStatus(workspace: FilingWorkspace): FilingCaseStatus {
  if (workspace.filingCase?.status === "FINALIZED" && workspace.currentFinalization && workspace.staleReasons.length === 0) return "FINALIZED";
  return filingCaseStatusFor(workspace.readiness.status);
}

/**
 * Moves the case to the status readiness supports, and — when that moves a
 * FINALIZED case back — records that its finalized snapshot was invalidated.
 * The snapshot and its finalization are never touched; they stay as history.
 */
async function settle(client: Client, workspace: FilingWorkspace, newVersion?: number): Promise<FilingCaseStatus> {
  const filingCase = workspace.filingCase!;
  const next = newVersion !== undefined ? filingCaseStatusFor(workspace.readiness.status) : settledStatus(workspace);
  if (next === filingCase.status && newVersion === undefined) return next;

  await updateFilingCase(createAdminClient(), { organizationId: filingCase.organizationId, filingCaseId: filingCase.id, status: next, currentVersion: newVersion });

  if (filingCase.status === "FINALIZED" && next !== "FINALIZED") {
    await audit(client, filingCase.organizationId, AUDIT_ACTIONS.taxFilingInvalidated, filingCase.id, {
      finalizedVersion: filingCase.currentVersion,
      reasons: [...workspace.staleReasons],
      nextStatus: next,
    });
  }
  return next;
}

function blockerCodes(workspace: FilingWorkspace): string[] {
  return workspace.readiness.issues
    .filter((issue) => issue.severity === "BLOCKER")
    .map((issue) => issue.code)
    .slice(0, 50);
}

async function recordEvaluation(client: Client, workspace: FilingWorkspace, status: FilingCaseStatus, durationMs: number) {
  const filingCase = workspace.filingCase!;
  const { readiness } = workspace;
  const codes = blockerCodes(workspace);

  await audit(client, filingCase.organizationId, AUDIT_ACTIONS.taxFilingReadinessEvaluated, filingCase.id, {
    readiness: readiness.status,
    caseStatus: status,
    finalizableScope: readiness.finalizableScope,
    blockerCodes: codes,
    reviewCount: readiness.issues.filter((issue) => issue.severity === "REVIEW").length,
    warningCount: readiness.issues.filter((issue) => issue.severity === "WARNING").length,
    engineVersion: readiness.engineVersion,
    preparationVersion: readiness.preparation.snapshotVersion,
    durationMs,
  });

  if (readiness.status === "BLOCKED" || readiness.status === "NOT_SUPPORTED") {
    await audit(client, filingCase.organizationId, AUDIT_ACTIONS.taxFilingReadinessBlocked, filingCase.id, { readiness: readiness.status, blockerCodes: codes });
  }

  reportEvent("tax_filing_readiness_evaluated", {
    scope: "financial",
    organizationId: filingCase.organizationId,
    detail: { readiness: readiness.status, engineVersion: readiness.engineVersion, blockerCount: codes.length, durationMs },
  });
}

// ── Start ─────────────────────────────────────────────────────────────

export async function startTaxFilingAction(_prev: TaxFilingActionResult, formData: FormData): Promise<TaxFilingActionResult> {
  const parsed = startFilingSchema.safeParse({ organizationId: field(formData, "organizationId") });
  if (!parsed.success) return { error: "Tax filing couldn't be started." };
  const { organizationId } = parsed.data;

  const authorized = await authorize(organizationId, "financial:write", "record");
  if ("error" in authorized) return authorized;

  const client = await createClient();
  try {
    const started = Date.now();
    // The tax year comes from the live preparation, never from the form.
    const live = await findLivePreparationCase(client, organizationId, FILING_TAX_YEAR);
    if (!live) return { error: `Start ${FILING_TAX_YEAR} tax preparation first — filing is prepared from it.` };

    if (!(await getFilingCaseForPreparation(client, organizationId, live.id))) {
      try {
        const created = await insertFilingCase(createAdminClient(), { organizationId, preparationCaseId: live.id, taxYear: live.taxYear, createdBy: authorized.userId });
        await audit(client, organizationId, AUDIT_ACTIONS.taxFilingCaseCreated, created.id, { preparationCaseId: live.id, taxYear: created.taxYear });
      } catch (error) {
        // A double-click raced us to the same preparation. That case is the answer.
        if (!isUniqueViolation(error)) throw error;
      }
    }

    const workspace = await loadFilingWorkspace(client, organizationId, live.id);
    if (!workspace?.filingCase) return { error: GENERIC_FAILURE };
    const status = await settle(client, workspace);
    await recordEvaluation(client, workspace, status, Date.now() - started);
  } catch (error) {
    reportError(error, { scope: "financial", organizationId, detail: { step: "start_tax_filing" } });
    return { error: GENERIC_FAILURE };
  }

  revalidatePath(pagePath(organizationId));
  return { success: true };
}

// ── Readiness ─────────────────────────────────────────────────────────

export async function evaluateTaxFilingReadinessAction(_prev: TaxFilingActionResult, formData: FormData): Promise<TaxFilingActionResult> {
  const parsed = filingActionSchema.safeParse({ organizationId: field(formData, "organizationId"), filingCaseId: field(formData, "filingCaseId") });
  if (!parsed.success) return { error: "Readiness couldn't be checked." };
  const { organizationId, filingCaseId } = parsed.data;

  const authorized = await authorize(organizationId, "financial:write", "record");
  if ("error" in authorized) return authorized;

  const client = await createClient();
  try {
    const started = Date.now();
    const workspace = await loadCase(client, organizationId, filingCaseId);
    if ("error" in workspace) return workspace;
    const status = await settle(client, workspace);
    await recordEvaluation(client, workspace, status, Date.now() - started);
  } catch (error) {
    reportError(error, { scope: "financial", organizationId, detail: { step: "evaluate_tax_filing" } });
    return { error: GENERIC_FAILURE };
  }

  revalidatePath(pagePath(organizationId));
  return { success: true, message: "Readiness checked." };
}

// ── Snapshot ──────────────────────────────────────────────────────────

/**
 * Freezes the current readiness result and generates the package from the
 * frozen preparation. A new version every time information has changed; the
 * previous versions, and any finalization of them, are kept exactly as they were.
 */
export async function createTaxFilingSnapshotAction(_prev: TaxFilingActionResult, formData: FormData): Promise<TaxFilingActionResult> {
  const parsed = filingActionSchema.safeParse({ organizationId: field(formData, "organizationId"), filingCaseId: field(formData, "filingCaseId") });
  if (!parsed.success) return { error: "A filing snapshot couldn't be created." };
  const { organizationId, filingCaseId } = parsed.data;

  const authorized = await authorize(organizationId, "financial:write", "record");
  if ("error" in authorized) return authorized;

  const client = await createClient();
  let message: string;
  try {
    const started = Date.now();
    const workspace = await loadCase(client, organizationId, filingCaseId);
    if ("error" in workspace) return workspace;

    const { readiness, frozenPreparation, latestSnapshot } = workspace;
    const filingCase = workspace.filingCase!;
    const currency = workspace.preparation.currency;

    if ((readiness.status !== "READY" && readiness.status !== "REVIEW_REQUIRED") || !readiness.finalizableScope) {
      const count = blockerCodes(workspace).length;
      const reviews = readiness.issues.filter((issue) => issue.severity === "REVIEW").length;
      if (count === 0 && reviews > 0) {
        return { error: `This return can't be snapshotted yet: ${reviews} ${reviews === 1 ? "question needs" : "questions need"} a qualified review first.` };
      }
      return { error: `This return can't be snapshotted yet: ${count} blocking ${count === 1 ? "issue needs" : "issues need"} resolving first.` };
    }
    if (!frozenPreparation?.calculation || !currency) return { error: "There is no current calculation to prepare a filing from." };
    if (latestSnapshot && workspace.staleReasons.length === 0) return { success: true, message: `Version ${latestSnapshot.version} is already current.` };

    const version = filingCase.currentVersion + 1;
    const generatedAt = new Date().toISOString();
    const filingPackage = buildFilingPackage({
      organizationId,
      currency,
      filingCaseId: filingCase.id,
      filingVersion: version,
      preparationCaseId: filingCase.preparationCaseId,
      preparation: frozenPreparation,
      readiness,
      scope: readiness.finalizableScope,
      generatedAt,
    });
    const fingerprint = packageFingerprint(filingPackage);
    const generationMs = Date.now() - started;

    try {
      await insertFilingSnapshot(createAdminClient(), {
        organizationId,
        filingCaseId: filingCase.id,
        version,
        taxYear: filingCase.taxYear,
        preparationSnapshotId: frozenPreparation.id,
        preparationVersion: frozenPreparation.version,
        readiness,
        package: filingPackage,
        packageFingerprint: fingerprint,
        inputFingerprint: inputFingerprint(frozenPreparation),
        createdBy: authorized.userId,
        createdAt: generatedAt,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { error: "A filing snapshot was created a moment ago. Refresh to see it." };
      throw error;
    }

    const status = await settle(client, workspace, version);

    await audit(client, organizationId, AUDIT_ACTIONS.taxFilingSnapshotCreated, filingCase.id, {
      version,
      readiness: readiness.status,
      scope: readiness.finalizableScope,
      caseStatus: status,
      preparationSnapshotId: frozenPreparation.id,
      preparationVersion: frozenPreparation.version,
      packageFingerprint: fingerprint,
      engineVersion: readiness.engineVersion,
      generationMs,
    });
    if (version > 1) {
      await audit(client, organizationId, AUDIT_ACTIONS.taxFilingVersionCreated, filingCase.id, { version, previousVersion: version - 1, reasons: [...workspace.staleReasons] });
    }
    reportEvent("tax_filing_package_generated", { scope: "financial", organizationId, detail: { version, readiness: readiness.status, generationMs } });
    message = `Filing snapshot version ${version} created.`;
  } catch (error) {
    reportError(error, { scope: "financial", organizationId, detail: { step: "create_tax_filing_snapshot" } });
    return { error: GENERIC_FAILURE };
  }

  revalidatePath(pagePath(organizationId));
  return { success: true, message };
}

// ── Finalize ──────────────────────────────────────────────────────────

/**
 * Explicit finalization of exactly the snapshot the person reviewed.
 *
 * Refused unless, at this moment: the snapshot is the latest and still current,
 * readiness recomputed from live data allows the scope, every excluded state is
 * named by the person exactly as shown, the stored package reproduces byte for
 * byte from its frozen inputs, and the person typed the confirmation and
 * acknowledged the warnings. It submits nothing to anyone.
 */
export async function finalizeTaxFilingAction(_prev: TaxFilingActionResult, formData: FormData): Promise<TaxFilingActionResult> {
  const parsed = finalizeFilingSchema.safeParse({
    organizationId: field(formData, "organizationId"),
    filingCaseId: field(formData, "filingCaseId"),
    snapshotId: field(formData, "snapshotId"),
    scope: field(formData, "scope"),
    confirmation: field(formData, "confirmation"),
    acknowledged: field(formData, "acknowledged"),
    excludedJurisdictions: field(formData, "excludedJurisdictions") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "That finalization couldn't be confirmed." };
  const { organizationId, filingCaseId, snapshotId, scope } = parsed.data;

  const authorized = await authorize(organizationId, "tax:finalize", "privileged");
  if ("error" in authorized) return authorized;

  const client = await createClient();
  let message: string;
  try {
    const workspace = await loadCase(client, organizationId, filingCaseId);
    if ("error" in workspace) return workspace;

    const { readiness, latestSnapshot, frozenPreparation } = workspace;
    const filingCase = workspace.filingCase!;

    if (!latestSnapshot || latestSnapshot.id !== snapshotId) return { error: "That isn't the latest filing snapshot. Review the current version and confirm again." };
    if (workspace.currentFinalization) return { error: `Version ${latestSnapshot.version} is already finalized.` };
    if (workspace.staleReasons.length > 0 || !frozenPreparation) {
      return { error: "Information changed after this snapshot was taken. Create a new filing snapshot and review it before finalizing." };
    }
    if (readiness.finalizableScope !== scope || latestSnapshot.readiness.finalizableScope !== scope) {
      return { error: "Readiness no longer allows this finalization. Check readiness again." };
    }
    if (filingCase.status !== "READY_FOR_FILING" && filingCase.status !== "REVIEW_REQUIRED") {
      return { error: "Check readiness again before finalizing." };
    }

    const requiredExclusions = latestSnapshot.package.states
      .filter((state) => state.role === "EXCLUDED")
      .map((state) => state.jurisdiction ?? state.stateCode ?? "STATE")
      .sort();
    const confirmedExclusions = [...parsed.data.excludedJurisdictions].sort();
    if (scope === "FULL" ? confirmedExclusions.length > 0 : confirmedExclusions.join() !== requiredExclusions.join()) {
      return { error: "Confirm the excluded states exactly as they are shown." };
    }

    // The package must still be exactly what its frozen inputs produce.
    const rebuilt = buildFilingPackage({
      organizationId,
      currency: latestSnapshot.package.metadata.currency,
      filingCaseId: filingCase.id,
      filingVersion: latestSnapshot.version,
      preparationCaseId: filingCase.preparationCaseId,
      preparation: frozenPreparation,
      readiness: latestSnapshot.readiness,
      scope,
      generatedAt: latestSnapshot.package.metadata.generatedAt,
    });
    if (packageFingerprint(rebuilt) !== latestSnapshot.packageFingerprint || packageFingerprint(latestSnapshot.package) !== latestSnapshot.packageFingerprint) {
      reportEvent("tax_filing_integrity_failed", { scope: "financial", organizationId, detail: { version: latestSnapshot.version } }, "error");
      return { error: "This filing package no longer reproduces from its inputs, so it can't be finalized. Create a new filing snapshot." };
    }

    const warningCodes = latestSnapshot.readiness.issues.filter((issue) => issue.severity === "WARNING").map((issue) => issue.code);
    const admin = createAdminClient();
    await insertFinalization(admin, {
      organizationId,
      filingCaseId: filingCase.id,
      snapshotId: latestSnapshot.id,
      scope,
      excludedJurisdictions: requiredExclusions,
      acknowledgedIssueCodes: warningCodes,
      finalizedBy: authorized.userId,
    });
    await updateFilingCase(admin, { organizationId, filingCaseId: filingCase.id, status: "FINALIZED" });

    await audit(client, organizationId, AUDIT_ACTIONS.taxFilingFinalized, filingCase.id, {
      snapshotId: latestSnapshot.id,
      version: latestSnapshot.version,
      taxYear: filingCase.taxYear,
      scope,
      excludedJurisdictions: requiredExclusions,
      acknowledgedWarningCount: warningCodes.length,
      packageFingerprint: latestSnapshot.packageFingerprint,
      submitted: false,
    });
    reportEvent("tax_filing_finalized", { scope: "financial", organizationId, detail: { version: latestSnapshot.version, finalizationScope: scope } });
    message = `Version ${latestSnapshot.version} finalized. Nothing has been filed or submitted.`;
  } catch (error) {
    reportError(error, { scope: "financial", organizationId, detail: { step: "finalize_tax_filing" } });
    return { error: GENERIC_FAILURE };
  }

  revalidatePath(pagePath(organizationId));
  return { success: true, message };
}
