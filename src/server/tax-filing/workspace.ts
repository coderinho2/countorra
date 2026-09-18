import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assessFilingReadiness } from "@/domain/tax-filing/readiness";
import { FILING_TAX_YEAR, type FilingCase, type FilingReadiness } from "@/domain/tax-filing/types";
import type { FrozenPreparation } from "@/domain/tax-filing/inputs";
import { findLivePreparationCase } from "@/server/db/repositories/tax-preparation";
import {
  getFilingCaseForPreparation,
  latestFilingSnapshot,
  listFilingSnapshots,
  listFinalizations,
  type FilingFinalization,
  type FilingSnapshotSummary,
  type StoredFilingSnapshot,
} from "@/server/db/repositories/tax-filing";
import { loadPreparationWorkspace, type PreparationWorkspace } from "@/server/tax-preparation/workspace";
import { inputFingerprint } from "./fingerprint";

type Client = SupabaseClient<Database>;

/**
 * Everything about one year's filing, assembled once — for the page, the
 * server actions and the AI tool alike, so none of them develops its own
 * answer to "is this ready?".
 *
 * READINESS IS RECOMPUTED ON EVERY LOAD. It is a statement about the return
 * as it stands now, from versioned rules.
 *
 * THE LATEST FILING SNAPSHOT IS NEVER RECOMPUTED. It is read exactly as it was
 * frozen, and `staleReasons` says, specifically, why it no longer describes the
 * return — so the page can never present an old package as current.
 */
export interface FilingWorkspace {
  preparation: PreparationWorkspace;
  filingCase: FilingCase | null;
  readiness: FilingReadiness;
  latestSnapshot: StoredFilingSnapshot | null;
  /** Empty when the latest snapshot still describes the return. */
  staleReasons: readonly FilingStaleReason[];
  history: readonly FilingSnapshotSummary[];
  finalizations: readonly FilingFinalization[];
  /** The finalization of the latest snapshot, if it has one. */
  currentFinalization: FilingFinalization | null;
  /** The preparation snapshot readiness was judged against, as frozen. */
  frozenPreparation: FrozenPreparation | null;
}

export type FilingStaleReason =
  /** Preparation was calculated again after this snapshot. */
  | "PREPARATION_RECALCULATED"
  /** Information changed and has not been calculated yet. */
  | "INFORMATION_CHANGED"
  /** The frozen preparation no longer matches what the snapshot recorded. */
  | "INPUTS_CHANGED"
  /** Readiness under today's rules differs from what the snapshot recorded. */
  | "READINESS_CHANGED";

/** The 2026 filing workspace for an organization, or null when there is no
 *  live 2026 preparation to file from. */
export async function loadFilingWorkspaceForYear(client: Client, organizationId: string): Promise<FilingWorkspace | null> {
  const live = await findLivePreparationCase(client, organizationId, FILING_TAX_YEAR);
  if (!live) return null;
  return loadFilingWorkspace(client, organizationId, live.id);
}

export async function loadFilingWorkspace(client: Client, organizationId: string, preparationCaseId: string): Promise<FilingWorkspace | null> {
  const [preparation, filingCase] = await Promise.all([
    loadPreparationWorkspace(client, organizationId, preparationCaseId),
    getFilingCaseForPreparation(client, organizationId, preparationCaseId),
  ]);
  if (!preparation) return null;
  // Same-organization check on top of RLS, in the codebase's usual order.
  if (filingCase && filingCase.organizationId !== organizationId) return null;

  const frozenPreparation: FrozenPreparation | null = preparation.latest
    ? { id: preparation.latest.id, version: preparation.latest.version, snapshot: preparation.latest.snapshot, calculation: preparation.latest.calculation }
    : null;

  const readiness = assessFilingReadiness({
    filingTaxYear: filingCase?.taxYear ?? FILING_TAX_YEAR,
    organization: { country: preparation.organization.country, entityType: preparation.organization.entityType },
    preparationCase: preparation.preparationCase,
    facts: preparation.facts,
    dependents: preparation.dependents,
    completeness: preparation.completeness,
    latest: frozenPreparation,
    calculationIsCurrent: preparation.calculationIsCurrent,
    currency: preparation.currency,
  });

  const [latestSnapshot, history, finalizations] = filingCase
    ? await Promise.all([latestFilingSnapshot(client, filingCase.id), listFilingSnapshots(client, filingCase.id), listFinalizations(client, filingCase.id)])
    : [null, [], []];

  return {
    preparation,
    filingCase,
    readiness,
    latestSnapshot,
    staleReasons: latestSnapshot ? staleReasonsFor(latestSnapshot, frozenPreparation, readiness) : [],
    history,
    finalizations,
    currentFinalization: latestSnapshot ? (finalizations.find((finalization) => finalization.snapshotId === latestSnapshot.id) ?? null) : null,
    frozenPreparation,
  };
}

export function staleReasonsFor(snapshot: StoredFilingSnapshot, frozen: FrozenPreparation | null, readiness: FilingReadiness): FilingStaleReason[] {
  const reasons: FilingStaleReason[] = [];
  if (!frozen || frozen.id !== snapshot.preparationSnapshotId) reasons.push("PREPARATION_RECALCULATED");
  if (readiness.issues.some((issue) => issue.code === "CALCULATION_STALE" || issue.code === "SNAPSHOT_INPUTS_OUTDATED")) reasons.push("INFORMATION_CHANGED");
  if (frozen && frozen.id === snapshot.preparationSnapshotId && inputFingerprint(frozen) !== snapshot.inputFingerprint) reasons.push("INPUTS_CHANGED");
  if (readiness.status !== snapshot.readinessStatus || readiness.engineVersion !== snapshot.readiness.engineVersion) reasons.push("READINESS_CHANGED");
  return reasons;
}
