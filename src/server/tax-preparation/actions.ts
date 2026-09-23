"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/types/database";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { recordAuditEvent, AUDIT_ACTIONS } from "@/domain/audit/audit-log";
import { enforceRateLimit } from "@/server/security/rate-limit";
import { reportError } from "@/lib/observability";
import { fromMajorUnits } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { runPreparationCalculation } from "@/domain/tax-preparation/calculation";
import { dependentStatusFor } from "@/domain/tax-preparation/dependents";
import { factDefinition } from "@/domain/tax-preparation/facts";
import { buildSnapshot } from "@/domain/tax-preparation/snapshot";
import { ALLOWED_STATUS_TRANSITIONS, canTransition, reopenedStatusFor, type PreparationCase, type PreparationStatus } from "@/domain/tax-preparation/types";
import { getOrganization } from "@/server/db/repositories/organizations";
import { getVisibleDocument } from "@/server/db/repositories/documents";
import { recordTaxCalculation } from "@/server/db/repositories/tax-calculations";
import {
  addDependent,
  createPreparationCase,
  findLivePreparationCase,
  getPreparationCase,
  listCurrentFacts,
  listDependents,
  recordFact,
  recordSnapshot,
  removeDependent,
  supersedeFact,
  updatePreparationCase,
  type PreparationCasePatch,
} from "@/server/db/repositories/tax-preparation";
import { loadPreparationWorkspace } from "@/server/tax-preparation/workspace";
import {
  addDependentSchema,
  caseActionSchema,
  recordFactSchema,
  removeDependentSchema,
  reviewFactSchema,
  startTaxPreparationSchema,
  updateTaxpayerSchema,
} from "@/validation/schemas/tax-preparation";

/**
 * Tax preparation mutations.
 *
 * Every action follows the same order, and the order is the point:
 *
 *   1. validate the form            — a browser's fields are claims
 *   2. authenticate + authorize     — membership, then `financial:write`
 *   3. rate limit                   — after authorization, so an anonymous
 *                                     caller cannot spend a member's budget
 *   4. load the case, same-org check — on top of RLS, not instead of it
 *   5. write through the RLS-scoped client
 *   6. audit, with names and statuses — never identifiers, notes or contents
 *
 * NOTHING HERE FILES ANYTHING. There is no submission, no e-file and no
 * signature. `calculateTaxPreparationAction` freezes the inputs and runs the
 * deterministic engines; that is where preparation ends.
 */

type Client = SupabaseClient<Database>;

export interface TaxPreparationActionResult {
  error?: string;
  success?: boolean;
  message?: string;
  /**
   * What is actually blocking a calculation, when one was refused.
   *
   * A count on its own — "blocked by 2 unresolved issues" — tells someone how
   * much trouble they are in and nothing about how to get out of it. The
   * issues are already computed here, they already carry a message and a
   * resolution, and the form that showed the count is the right place to show
   * them. Structured rather than concatenated into the error string so the
   * form can lay them out, and bounded so a pathological case cannot fill the
   * screen.
   */
  blockers?: readonly { id: string; message: string; resolution: string | null }[];
}

/** Blocking issues shown at the point of refusal. More than this and the
 *  list stops being read; the full set is always on the page above. */
const MAX_SHOWN_BLOCKERS = 4;

const UNIQUE_VIOLATION = "23505";

function field(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

function firstIssue(error: { issues: { message: string }[] }, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

/** The exact, currency-aware parser — never parseFloat(x) * 100. Null rather
 *  than a throw, so a bad amount becomes a message. */
function parseAmount(amount: string, currency: CurrencyCode) {
  try {
    return fromMajorUnits(amount, currency);
  } catch {
    return null;
  }
}

function pagePath(organizationId: string): string {
  return `/app/${organizationId}/tax-preparation`;
}

async function authorizeWrite(organizationId: string): Promise<{ userId: string } | { error: string }> {
  const { user, membership } = await requireOrgMembership(organizationId);
  if (!can(membership.role, "financial:write")) return { error: "You don't have permission to change tax preparation for this workspace." };

  const limited = await enforceRateLimit("recordMutation", { recordMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  return { userId: user.id };
}

/** The case, if it belongs to this organization and is still open. */
async function openCase(client: Client, organizationId: string, caseId: string): Promise<PreparationCase | { error: string }> {
  const preparationCase = await getPreparationCase(client, caseId);
  if (!preparationCase || preparationCase.organizationId !== organizationId) return { error: "Tax preparation not found." };
  if (preparationCase.status === "ARCHIVED") return { error: "This tax year's preparation is archived and can't be changed." };
  return preparationCase;
}

/**
 * The status to move to, if the workflow allows reaching it in at most one
 * intermediate step. Null when it does not — the caller then leaves the
 * status alone rather than forcing an illegal move.
 */
function reachableStatus(from: PreparationStatus, to: PreparationStatus): PreparationStatus | null {
  if (from === to || canTransition(from, to)) return to;
  return ALLOWED_STATUS_TRANSITIONS[from].some((via) => canTransition(via, to)) ? to : null;
}

/** Any change to the collected information reopens the case, so a stale
 *  calculation is never presented as current. */
function reopenedStatus(preparationCase: PreparationCase): PreparationCasePatch {
  const next = reopenedStatusFor(preparationCase.status);
  return next ? { status: next } : {};
}

async function audit(client: Client, organizationId: string, action: string, resourceId: string, metadata: Record<string, Json>) {
  try {
    await recordAuditEvent(client, { organizationId, action, resourceType: "tax_preparation_case", resourceId, metadata });
  } catch (error) {
    // The change itself succeeded. An audit failure is reported loudly but
    // does not undo a person's work.
    reportError(error, { scope: "financial", organizationId, detail: { step: "audit", action } });
  }
}

// ── Start ─────────────────────────────────────────────────────────────

export async function startTaxPreparationAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = startTaxPreparationSchema.safeParse({ organizationId: field(formData, "organizationId"), taxYear: field(formData, "taxYear") });
  if (!parsed.success) return { error: firstIssue(parsed.error, "That tax year can't be prepared.") };

  const authorized = await authorizeWrite(parsed.data.organizationId);
  if ("error" in authorized) return authorized;

  const client = await createClient();
  const organization = await getOrganization(client, parsed.data.organizationId);
  if (!organization) return { error: "Workspace not found." };

  // Idempotent: starting a year that is already open is not an error, it is
  // the same case. The partial unique index is what actually guarantees it.
  const existing = await findLivePreparationCase(client, parsed.data.organizationId, parsed.data.taxYear);
  if (existing) return { success: true };

  try {
    const created = await createPreparationCase(client, {
      organizationId: parsed.data.organizationId,
      taxYear: parsed.data.taxYear,
      createdBy: authorized.userId,
      // From the organization, never from the form. A request cannot choose
      // which state's tax law it is prepared under.
      primaryStateRegion: organization.country === "US" ? organization.stateRegion : null,
    });
    await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationStarted, created.id, { taxYear: created.taxYear });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // A double-click raced us to the same year. That case is the answer.
  }

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true };
}

// ── Taxpayer ──────────────────────────────────────────────────────────

export async function updateTaxpayerAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = updateTaxpayerSchema.safeParse(Object.fromEntries([...formData.entries()].filter(([, value]) => typeof value === "string")));
  if (!parsed.success) return { error: firstIssue(parsed.error, "Those details couldn't be saved.") };

  const authorized = await authorizeWrite(parsed.data.organizationId);
  if ("error" in authorized) return authorized;

  const client = await createClient();
  const preparationCase = await openCase(client, parsed.data.organizationId, parsed.data.caseId);
  if ("error" in preparationCase) return preparationCase;

  const patch: PreparationCasePatch = {
    filingStatus: parsed.data.filingStatus,
    legalFirstName: parsed.data.legalFirstName,
    legalMiddleName: parsed.data.legalMiddleName,
    legalLastName: parsed.data.legalLastName,
    dateOfBirth: parsed.data.dateOfBirth,
    taxIdentifierType: parsed.data.taxIdentifierType,
    // "none" means the taxpayer has no identifier, so none can be on file —
    // two fields that contradict each other are not saved as if they agreed.
    taxIdentifierOnFile: parsed.data.taxIdentifierType === "none" ? false : parsed.data.taxIdentifierOnFile,
    additionalStateRegions: parsed.data.additionalStateRegions,
    spouseFirstName: parsed.data.spouseFirstName,
    spouseLastName: parsed.data.spouseLastName,
    spouseDateOfBirth: parsed.data.spouseDateOfBirth,
    spouseTaxIdentifierOnFile: parsed.data.spouseTaxIdentifierOnFile,
    spouseItemizesDeductions: parsed.data.spouseItemizesDeductions,
    ...reopenedStatus(preparationCase),
  };

  await updatePreparationCase(client, preparationCase.id, patch);
  // Field NAMES only. A name, a date of birth or a filing status is exactly
  // the kind of value an audit trail should not accumulate copies of.
  await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationTaxpayerUpdated, preparationCase.id, {
    fields: Object.keys(patch).filter((key) => key !== "status"),
  });

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true, message: "Saved." };
}

// ── Facts ─────────────────────────────────────────────────────────────

export async function recordFactAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = recordFactSchema.safeParse({
    organizationId: field(formData, "organizationId"),
    caseId: field(formData, "caseId"),
    key: field(formData, "key"),
    amount: field(formData, "amount"),
    evidenceDocumentId: field(formData, "evidenceDocumentId"),
    evidenceNote: field(formData, "evidenceNote"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error, "That figure couldn't be saved.") };

  const authorized = await authorizeWrite(parsed.data.organizationId);
  if ("error" in authorized) return authorized;

  const client = await createClient();
  const preparationCase = await openCase(client, parsed.data.organizationId, parsed.data.caseId);
  if ("error" in preparationCase) return preparationCase;

  const organization = await getOrganization(client, parsed.data.organizationId);
  if (!organization) return { error: "Workspace not found." };

  const definition = factDefinition(parsed.data.key);
  if (parsed.data.amount.startsWith("-") && !definition.allowsNegative) return { error: `${definition.label} can't be negative.` };

  // The organization's currency, not a form field — and the exact,
  // currency-aware parser, never parseFloat(x) * 100.
  if (!isSupportedCurrency(organization.baseCurrency)) return { error: "This workspace's currency isn't supported for tax preparation." };
  const money = parseAmount(parsed.data.amount, organization.baseCurrency);
  if (!money) return { error: "That amount isn't usable in this workspace's currency." };

  if (parsed.data.evidenceDocumentId) {
    // Belt and braces: the composite foreign key in 0042 already refuses a
    // document from another organization, but refusing it here gives a
    // message instead of a constraint error.
    // Visible documents only: an upload still pending verification, or one
    // refused, is not evidence of anything.
    const document = await getVisibleDocument(client, parsed.data.evidenceDocumentId);
    if (!document || document.organizationId !== parsed.data.organizationId) return { error: "That document isn't in this workspace." };
  }

  const fact = await recordFact(client, {
    organizationId: parsed.data.organizationId,
    caseId: preparationCase.id,
    version: preparationCase.currentVersion,
    key: parsed.data.key,
    amountMinor: money.amountMinor,
    currency: money.currency,
    // A person typed this figure, so it is confirmed by the act of entering
    // it. Only a figure from somewhere ELSE — a model, an import — starts as
    // a proposal.
    source: parsed.data.evidenceDocumentId ? "DOCUMENT" : "USER_ENTERED",
    state: "CONFIRMED",
    evidenceDocumentId: parsed.data.evidenceDocumentId,
    evidenceNote: parsed.data.evidenceNote,
    createdBy: authorized.userId,
  });

  const reopened = reopenedStatus(preparationCase);
  if (reopened.status) await updatePreparationCase(client, preparationCase.id, reopened);

  // The key and where it came from. Not the amount's note, not the document.
  await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationFactRecorded, preparationCase.id, {
    factId: fact.id,
    key: fact.key,
    source: fact.source,
  });

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true };
}

/**
 * Accepting, correcting or rejecting a figure.
 *
 * Confirm is only for a PROPOSED value — that is the review step. Reject works
 * on either state, because withdrawing a figure a person entered by mistake is
 * the same act as rejecting a bad suggestion: a superseding row that says so.
 * Neither deletes anything.
 */
export async function reviewFactAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = reviewFactSchema.safeParse({
    organizationId: field(formData, "organizationId"),
    caseId: field(formData, "caseId"),
    factId: field(formData, "factId"),
    decision: field(formData, "decision"),
    correctedAmount: field(formData, "correctedAmount"),
  });
  if (!parsed.success) return { error: firstIssue(parsed.error, "That review couldn't be saved.") };

  const authorized = await authorizeWrite(parsed.data.organizationId);
  if ("error" in authorized) return authorized;

  const client = await createClient();
  const preparationCase = await openCase(client, parsed.data.organizationId, parsed.data.caseId);
  if ("error" in preparationCase) return preparationCase;

  // From the CURRENT facts only: a superseded row is history, and reviewing
  // it again would fork the chain the unique index exists to keep linear.
  const facts = await listCurrentFacts(client, preparationCase.id);
  const previous = facts.find((fact) => fact.id === parsed.data.factId);
  if (!previous) return { error: "That figure has already been reviewed or no longer exists." };
  if (previous.state === "REJECTED") return { error: "That figure was already rejected." };
  if (parsed.data.decision === "confirm" && previous.state !== "PROPOSED") return { error: "Only a suggested figure needs confirming." };

  let correctedAmountMinor: number | undefined;
  if (parsed.data.decision === "confirm" && parsed.data.correctedAmount !== null) {
    const definition = factDefinition(previous.key);
    if (parsed.data.correctedAmount.startsWith("-") && !definition.allowsNegative) return { error: `${definition.label} can't be negative.` };
    const corrected = previous.currency ? parseAmount(parsed.data.correctedAmount, previous.currency) : null;
    if (!corrected) return { error: "That corrected amount isn't usable." };
    correctedAmountMinor = corrected.amountMinor;
  }

  try {
    await supersedeFact(client, {
      previous,
      state: parsed.data.decision === "confirm" ? "CONFIRMED" : "REJECTED",
      reviewedBy: authorized.userId,
      amountMinor: correctedAmountMinor,
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "Someone else reviewed that figure a moment ago. Refresh to see it." };
    throw error;
  }

  const reopened = reopenedStatus(preparationCase);
  if (reopened.status) await updatePreparationCase(client, preparationCase.id, reopened);

  await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationFactReviewed, preparationCase.id, {
    factId: previous.id,
    key: previous.key,
    source: previous.source,
    decision: parsed.data.decision,
    corrected: correctedAmountMinor !== undefined,
  });

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true };
}

// ── Dependents ────────────────────────────────────────────────────────

export async function addDependentAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = addDependentSchema.safeParse(Object.fromEntries([...formData.entries()].filter(([, value]) => typeof value === "string")));
  if (!parsed.success) return { error: firstIssue(parsed.error, "That dependent couldn't be added.") };

  const authorized = await authorizeWrite(parsed.data.organizationId);
  if ("error" in authorized) return authorized;

  const client = await createClient();
  const preparationCase = await openCase(client, parsed.data.organizationId, parsed.data.caseId);
  if ("error" in preparationCase) return preparationCase;

  const existing = await listDependents(client, preparationCase.id);
  if (existing.length >= 20) return { error: "A preparation case can hold at most 20 dependents." };

  const details = {
    dateOfBirth: parsed.data.dateOfBirth,
    monthsLivedWithTaxpayer: parsed.data.monthsLivedWithTaxpayer,
    hasTaxIdentifier: parsed.data.hasTaxIdentifier,
    claimedByAnother: parsed.data.claimedByAnother,
  };

  const dependent = await addDependent(client, {
    organizationId: parsed.data.organizationId,
    caseId: preparationCase.id,
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    relationship: parsed.data.relationship,
    isStudent: parsed.data.isStudent,
    isDisabled: parsed.data.isDisabled,
    ...details,
    // Server-derived. A form cannot declare its own dependent "verified".
    status: dependentStatusFor(details),
    createdBy: authorized.userId,
  });

  const reopened = reopenedStatus(preparationCase);
  if (reopened.status) await updatePreparationCase(client, preparationCase.id, reopened);

  await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationDependentAdded, preparationCase.id, {
    dependentId: dependent.id,
    status: dependent.status,
  });

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true };
}

export async function removeDependentAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = removeDependentSchema.safeParse({
    organizationId: field(formData, "organizationId"),
    caseId: field(formData, "caseId"),
    dependentId: field(formData, "dependentId"),
  });
  if (!parsed.success) return { error: "That dependent couldn't be removed." };

  const authorized = await authorizeWrite(parsed.data.organizationId);
  if ("error" in authorized) return authorized;

  const client = await createClient();
  const preparationCase = await openCase(client, parsed.data.organizationId, parsed.data.caseId);
  if ("error" in preparationCase) return preparationCase;

  const dependents = await listDependents(client, preparationCase.id);
  if (!dependents.some((dependent) => dependent.id === parsed.data.dependentId)) return { error: "That dependent isn't part of this preparation." };

  await removeDependent(client, parsed.data.dependentId);

  const reopened = reopenedStatus(preparationCase);
  if (reopened.status) await updatePreparationCase(client, preparationCase.id, reopened);

  await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationDependentRemoved, preparationCase.id, { dependentId: parsed.data.dependentId });

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true };
}

// ── Calculate ─────────────────────────────────────────────────────────

/**
 * Freeze the inputs, run the engines, keep what was said.
 *
 * The snapshot row stores the inputs AND the classified result together, and
 * each supported jurisdiction result is also recorded in `tax_calculations`
 * pointing back at that snapshot. The database refuses to delete a snapshot a
 * stored calculation depends on, so the pair cannot come apart.
 */
export async function calculateTaxPreparationAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = caseActionSchema.safeParse({ organizationId: field(formData, "organizationId"), caseId: field(formData, "caseId") });
  if (!parsed.success) return { error: "That calculation couldn't be started." };

  const authorized = await authorizeWrite(parsed.data.organizationId);
  if ("error" in authorized) return authorized;

  const client = await createClient();
  const workspace = await loadPreparationWorkspace(client, parsed.data.organizationId, parsed.data.caseId);
  if (!workspace) return { error: "Tax preparation not found." };

  const { preparationCase, completeness } = workspace;
  if (preparationCase.status === "ARCHIVED") return { error: "This tax year's preparation is archived and can't be recalculated." };

  if (completeness.blockers.length > 0 || !preparationCase.filingStatus) {
    const next = reachableStatus(preparationCase.status, "NEEDS_INFORMATION");
    if (next && next !== preparationCase.status) await updatePreparationCase(client, preparationCase.id, { status: next });
    revalidatePath(pagePath(parsed.data.organizationId));
    return {
      error: `Calculation is blocked by ${completeness.blockers.length} unresolved ${completeness.blockers.length === 1 ? "issue" : "issues"}. Resolve ${completeness.blockers.length === 1 ? "it" : "them"} and calculate again.`,
      // Named, not just counted. Every one of these is resolvable in a form
      // further down this same page.
      blockers: completeness.blockers.slice(0, MAX_SHOWN_BLOCKERS).map((issue) => ({ id: issue.id, message: issue.message, resolution: issue.resolution })),
    };
  }

  if (!workspace.currency) return { error: "This workspace's currency isn't supported for tax calculation." };

  const version = (workspace.latest?.version ?? 0) + 1;
  const now = new Date().toISOString();

  const snapshot = buildSnapshot({
    organizationId: parsed.data.organizationId,
    caseId: preparationCase.id,
    version,
    taxYear: preparationCase.taxYear,
    filingStatus: preparationCase.filingStatus,
    taxpayer: preparationCase.taxpayer,
    dependents: workspace.dependents,
    facts: workspace.facts,
    // From the completeness engine, which derives them from the
    // organization. Never from the form.
    jurisdictions: completeness.jurisdictions,
    createdBy: authorized.userId,
    createdAt: now,
  });

  const outcome = runPreparationCalculation({ snapshot, currency: workspace.currency, calculatedAt: now, blockers: completeness.blockers });
  if (!outcome.ran) return { error: outcome.message };

  let stored: { id: string };
  try {
    stored = await recordSnapshot(client, { organizationId: parsed.data.organizationId, caseId: preparationCase.id, snapshot, calculation: outcome.calculation, createdBy: authorized.userId });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "A calculation for this version was saved a moment ago. Refresh to see it." };
    throw error;
  }

  for (const result of [outcome.calculation.federal, ...outcome.calculation.states]) {
    if (!result.outcome?.supported) continue;
    try {
      await recordTaxCalculation(client, {
        organizationId: parsed.data.organizationId,
        calculatedBy: authorized.userId,
        calculation: result.outcome,
        preparationSnapshotId: stored.id,
      });
    } catch (error) {
      // The frozen snapshot already holds the result that is shown. A failed
      // secondary record is reported, not allowed to erase that.
      reportError(error, { scope: "financial", organizationId: parsed.data.organizationId, detail: { step: "record_tax_calculation", jurisdiction: result.jurisdiction } });
    }
  }

  const status = reachableStatus(preparationCase.status, "CALCULATED");
  await updatePreparationCase(client, preparationCase.id, {
    currentVersion: version,
    ...(status ? { status } : {}),
    // Bring the stored copy back in step with the organization, so the row
    // records the state this snapshot was actually calculated for.
    ...(workspace.storedPrimaryStateRegion !== preparationCase.taxpayer.primaryStateRegion
      ? { primaryStateRegion: preparationCase.taxpayer.primaryStateRegion }
      : {}),
  });

  await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationCalculated, preparationCase.id, {
    snapshotId: stored.id,
    version,
    taxYear: preparationCase.taxYear,
    results: Object.fromEntries([outcome.calculation.federal, ...outcome.calculation.states].map((result) => [result.jurisdiction, result.status])),
  });

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true };
}

// ── Archive ───────────────────────────────────────────────────────────

export async function archiveTaxPreparationAction(_prev: TaxPreparationActionResult, formData: FormData): Promise<TaxPreparationActionResult> {
  const parsed = caseActionSchema.safeParse({ organizationId: field(formData, "organizationId"), caseId: field(formData, "caseId") });
  if (!parsed.success) return { error: "That preparation couldn't be archived." };

  // Closing a year is heavier than editing it, so it needs the delete-level
  // financial permission, and the stricter bucket.
  const { user, membership } = await requireOrgMembership(parsed.data.organizationId);
  if (!can(membership.role, "financial:delete")) return { error: "You don't have permission to archive tax preparation." };
  const limited = await enforceRateLimit("privilegedMutation", { privilegedMutationPerUser: user.id });
  if (!limited.allowed) return { error: limited.message };

  const client = await createClient();
  const preparationCase = await openCase(client, parsed.data.organizationId, parsed.data.caseId);
  if ("error" in preparationCase) return preparationCase;

  await updatePreparationCase(client, preparationCase.id, { status: "ARCHIVED", completedAt: new Date().toISOString() });
  await audit(client, parsed.data.organizationId, AUDIT_ACTIONS.taxPreparationArchived, preparationCase.id, { taxYear: preparationCase.taxYear });

  revalidatePath(pagePath(parsed.data.organizationId));
  return { success: true };
}
