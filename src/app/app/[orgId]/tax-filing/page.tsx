import Link from "next/link";
import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import { ListChecks } from "@phosphor-icons/react/dist/ssr/ListChecks";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { format, money } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { FILING_TAX_YEAR, type ComponentReadiness, type FilingIssue, type FilingIssueSeverity, type FilingPackage, type ReadinessStatus } from "@/domain/tax-filing/types";
import type { FilingStaleReason } from "@/server/tax-filing/workspace";
import { loadFilingWorkspaceForYear } from "@/server/tax-filing/workspace";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Panel, PanelFooter, SectionHeading } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CreateSnapshotForm, EvaluateReadinessForm, FinalizeDialog, StartFilingForm, type FinalizeSummary } from "@/components/tax-filing/filing-forms";

/**
 * Tax filing — the stage after Tax preparation.
 *
 * Read like a document, in the order the work happens: can this return be
 * finalized, what stops it, the frozen snapshot under review, finalization,
 * and the package with its history.
 *
 * THE BOUNDARY IS THE FIRST THING SAID. Electronic filing is not available,
 * Countorra does not file or submit, and "finalized" means locked for review
 * here. There is no "Submit to IRS" control anywhere, and no status on this page
 * can say a return was filed, submitted or accepted.
 */

const READINESS_BADGE: Record<ReadinessStatus, { label: string; variant: BadgeProps["variant"]; sentence: string }> = {
  READY: { label: "Ready to finalize", variant: "positive", sentence: "Federal and every state component can be finalized together." },
  REVIEW_REQUIRED: {
    label: "Federal ready",
    variant: "warning",
    sentence: "The federal return can be finalized on its own. At least one state can't be finalized from here.",
  },
  BLOCKED: { label: "Blocked", variant: "warning", sentence: "Nothing can be finalized until the blocking issues below are resolved." },
  NOT_SUPPORTED: { label: "Not supported", variant: "neutral", sentence: `Filing readiness covers ${FILING_TAX_YEAR} United States individual returns only.` },
};

/** REVIEW_REQUIRED with nothing finalizable: an open question, not a state. */
const NEEDS_REVIEW_BADGE = {
  label: "Needs review",
  variant: "warning",
  sentence: "A question Countorra doesn't decide is open, so nothing can be finalized here yet. The figures are still calculated and shown below.",
} satisfies { label: string; variant: BadgeProps["variant"]; sentence: string };

const COMPONENT_BADGE: Record<ComponentReadiness, { label: string; variant: BadgeProps["variant"] }> = {
  READY: { label: "Ready", variant: "positive" },
  NOT_READY: { label: "Not ready", variant: "warning" },
  NOT_APPLICABLE: { label: "No income-tax return", variant: "neutral" },
  NOT_SUPPORTED: { label: "Not supported", variant: "neutral" },
};

const SEVERITY_LABEL: Record<FilingIssueSeverity, { heading: string; badge: string; variant: BadgeProps["variant"] }> = {
  BLOCKER: { heading: "Blocks finalization", badge: "Blocks", variant: "warning" },
  REVIEW: { heading: "Needs a qualified review — nothing can be finalized while open", badge: "Needs review", variant: "warning" },
  WARNING: { heading: "Disclosed limitations — acknowledged when finalizing", badge: "Limitation", variant: "neutral" },
  INFO: { heading: "Notes", badge: "Note", variant: "info" },
};

const STALE_REASON: Record<FilingStaleReason, string> = {
  PREPARATION_RECALCULATED: "Tax preparation was calculated again after this snapshot.",
  INFORMATION_CHANGED: "Information changed in Tax preparation and hasn't been calculated yet.",
  INPUTS_CHANGED: "The preparation this snapshot was built from no longer matches what it recorded.",
  READINESS_CHANGED: "Readiness under the current rules differs from what this snapshot recorded.",
};

const ROLE_LABEL: Record<FilingPackage["states"][number]["role"], string> = {
  INCLUDED: "Included",
  EXCLUDED: "Excluded from this finalization",
  NO_INDIVIDUAL_INCOME_TAX_RETURN: "No individual income-tax return",
};

function formatMinor(minor: number | null, currency: CurrencyCode | string): string {
  if (minor === null || !isSupportedCurrency(currency)) return "—";
  return format(money(minor, currency));
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default async function TaxFilingPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { membership } = await requireOrgMembership(orgId);
  const canWrite = can(membership.role, "financial:write");
  const canFinalize = can(membership.role, "tax:finalize");

  const client = await createClient();
  const workspace = await loadFilingWorkspaceForYear(client, orgId);

  const notice = (
    <p className="border-border-subtle border-l-accent bg-surface text-text-secondary flex items-start gap-2.5 rounded-md border border-l-2 px-4 py-3 text-[13px]">
      <Info size={16} aria-hidden="true" className="text-accent mt-px shrink-0" />
      <span>
        <span className="text-text-primary font-medium">Electronic filing integration is not yet available.</span> Countorra doesn&apos;t file or submit returns to
        the IRS or any state. Finalizing locks a reviewed version here, and the exported package is a preparation record, not a government form.
      </span>
    </p>
  );

  if (!workspace) {
    return (
      <PageShell className="gap-6">
        <PageHeader eyebrow="Tax" title="Tax filing" description={`Check whether a prepared ${FILING_TAX_YEAR} return is ready, review it, and finalize it.`} />
        {notice}
        <Panel>
          <EmptyState
            icon={<ListChecks size={24} aria-hidden="true" />}
            title={`No ${FILING_TAX_YEAR} preparation to file from`}
            description={`Filing is prepared from Tax preparation. Start the ${FILING_TAX_YEAR} tax year there first.`}
            action={
              <Button asChild variant="secondary">
                <Link href={`/app/${orgId}/tax-preparation`}>Go to Tax preparation</Link>
              </Button>
            }
          />
        </Panel>
      </PageShell>
    );
  }

  const { readiness, filingCase, latestSnapshot, staleReasons, history, finalizations, currentFinalization } = workspace;
  const currency = workspace.preparation.currency ?? "USD";
  const readinessBadge = readiness.status === "REVIEW_REQUIRED" && !readiness.finalizableScope ? NEEDS_REVIEW_BADGE : READINESS_BADGE[readiness.status];
  const blockers = readiness.issues.filter((issue) => issue.severity === "BLOCKER");
  const snapshotCurrent = latestSnapshot !== null && staleReasons.length === 0;
  // A snapshot is taken only of something that could be finalized.
  const canSnapshot = readiness.finalizableScope !== null;
  const finalizedBySnapshot = new Map(finalizations.map((finalization) => [finalization.snapshotId, finalization]));

  const actions = !filingCase ? (canWrite ? <StartFilingForm organizationId={orgId} /> : undefined) : canWrite ? <EvaluateReadinessForm organizationId={orgId} filingCaseId={filingCase.id} /> : undefined;

  return (
    <PageShell className="gap-8">
      <PageHeader
        eyebrow="Tax"
        title={`Tax filing ${FILING_TAX_YEAR}`}
        description="Check whether the prepared return is ready, review exactly what would be finalized, and finalize it."
        actions={actions}
        meta={
          <PageMeta>
            <PageMetaItem label="Readiness" value={readinessBadge.label} tone={readiness.status === "READY" ? "positive" : readiness.status === "NOT_SUPPORTED" ? "neutral" : "warning"} />
            <PageMetaItem label="Blocking issues" value={blockers.length} tone={blockers.length > 0 ? "warning" : "neutral"} />
            <PageMetaItem label="Filing version" value={filingCase?.currentVersion ? filingCase.currentVersion : "None"} />
            <PageMetaItem label="Finalized" value={currentFinalization ? (snapshotCurrent ? `Version ${latestSnapshot?.version}` : "Out of date") : "No"} />
          </PageMeta>
        }
      />

      {notice}

      {/* ── Readiness ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={1} title="Readiness" description="Determined from the current preparation, recomputed every time this page loads." />
        <Panel>
          <div className="border-border-subtle flex flex-col gap-1.5 border-b px-4 py-4 sm:flex-row sm:items-center sm:gap-4">
            <Badge variant={readinessBadge.variant}>{readinessBadge.label}</Badge>
            <p className="text-text-primary text-[15px]">{readinessBadge.sentence}</p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Jurisdiction</TableHead>
                <TableHead>Readiness</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Rules used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[readiness.federal, ...readiness.states].map((component) => (
                <TableRow key={`${component.jurisdiction ?? component.stateCode ?? "state"}`}>
                  <TableCell className="text-text-primary font-medium">{component.label}</TableCell>
                  <TableCell>
                    <Badge variant={COMPONENT_BADGE[component.readiness].variant}>{COMPONENT_BADGE[component.readiness].label}</Badge>
                  </TableCell>
                  <TableCell className="text-text-secondary">{component.resultStatus ? component.resultStatus.charAt(0) + component.resultStatus.slice(1).toLowerCase().replace(/_/g, " ") : "No result"}</TableCell>
                  <TableCell className="font-numeric text-text-secondary text-[13px]">
                    {component.ruleSet
                      ? `${component.ruleSet.taxYear} rules · v${component.ruleSet.version}${component.ruleSet.calculationStatus === "ESTIMATE_USING_LATEST_PUBLISHED_RULES" ? ` · estimate for ${component.ruleSet.requestedTaxYear}` : ""}`
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <PanelFooter>
            <span>
              Preparation version {readiness.preparation.snapshotVersion ?? "—"} · readiness rules {readiness.engineVersion} ·{" "}
              <Link href={`/app/${orgId}/tax-preparation`} className="text-accent hover:underline">
                Open Tax preparation
              </Link>
            </span>
          </PanelFooter>
        </Panel>
      </section>

      {/* ── Issues ───────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={2} title="What needs attention" description="Every issue has a reason and a way to resolve it. Nothing here is a legal determination." />
        <Panel>
          {(["BLOCKER", "REVIEW", "WARNING", "INFO"] as const).map((severity) => {
            const group = readiness.issues.filter((issue) => issue.severity === severity);
            if (group.length === 0) return null;
            return (
              <div key={severity} className="border-border-subtle border-b last:border-b-0">
                <p className="bg-surface-sunken text-text-secondary px-4 py-2 text-[11px] font-semibold tracking-[0.08em] uppercase">
                  {SEVERITY_LABEL[severity].heading} · {group.length}
                </p>
                <ul className="divide-border-subtle flex flex-col divide-y">
                  {group.map((issue) => (
                    <IssueRow key={`${issue.code}:${issue.related?.affects ?? ""}`} issue={issue} />
                  ))}
                </ul>
              </div>
            );
          })}
        </Panel>
      </section>

      {/* ── Snapshot ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading
          index={3}
          title="Filing snapshot"
          description="An immutable record of the prepared return under review. A change in preparation needs a new version; old versions are kept."
        />

        {latestSnapshot && !snapshotCurrent && (
          <div className="border-border-subtle border-l-warning bg-surface text-text-secondary rounded-md border border-l-2 px-4 py-3 text-[13px]">
            <p className="text-text-primary font-medium">Version {latestSnapshot.version} no longer describes this return.</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5">
              {staleReasons.map((reason) => (
                <li key={reason}>{STALE_REASON[reason]}</li>
              ))}
            </ul>
            <p className="mt-1">The figures below are that version&apos;s, kept as history. Create a new version to review the current return.</p>
          </div>
        )}

        <Panel>
          {!latestSnapshot ? (
            <EmptyState
              title="No filing snapshot yet"
              description={
                !filingCase
                  ? "Start the filing review first."
                  : canSnapshot
                    ? "Create a snapshot to freeze the current readiness and generate the filing package for review."
                    : "Resolve the blocking and review issues before a snapshot can be created."
              }
              action={filingCase && canWrite ? <CreateSnapshotForm organizationId={orgId} filingCaseId={filingCase.id} disabled={!canSnapshot} label="Create filing snapshot" /> : undefined}
            />
          ) : (
            <SnapshotSummary pkg={latestSnapshot.package} currency={currency} />
          )}
          {latestSnapshot && (
            <PanelFooter>
              <span className="font-numeric">
                Version {latestSnapshot.version} · created {formatDate(latestSnapshot.createdAt)} · package {latestSnapshot.packageFingerprint.slice(0, 12)}
              </span>
              {filingCase && canWrite && !snapshotCurrent && canSnapshot && (
                <CreateSnapshotForm organizationId={orgId} filingCaseId={filingCase.id} disabled={false} label={`Create version ${latestSnapshot.version + 1}`} />
              )}
            </PanelFooter>
          )}
        </Panel>
      </section>

      {/* ── Finalize ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={4} title="Finalize" description="Locks the reviewed version inside Countorra. It does not file or submit anything." />
        <Panel className="flex flex-col gap-3 p-6">
          {currentFinalization && latestSnapshot && snapshotCurrent ? (
            <>
              <p className="text-text-primary text-[15px]">
                Version {latestSnapshot.version} was finalized on {formatDate(currentFinalization.finalizedAt)}
                {currentFinalization.scope === "FEDERAL_ONLY" ? ", federal only" : ""}.
              </p>
              <p className="text-text-secondary text-[13px]">It has not been filed or submitted. Export the package below for whoever files the return.</p>
            </>
          ) : latestSnapshot && snapshotCurrent && latestSnapshot.readiness.finalizableScope && filingCase ? (
            canFinalize ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-text-secondary text-[13px]">
                  Review version {latestSnapshot.version} in full before finalizing. Every figure, excluded state, warning and limitation is shown in the confirmation.
                </p>
                <FinalizeDialog organizationId={orgId} filingCaseId={filingCase.id} snapshotId={latestSnapshot.id} summary={finalizeSummary(latestSnapshot.package, latestSnapshot.version, currency)} />
              </div>
            ) : (
              <p className="text-text-secondary text-[13px]">Only an owner, admin or accountant can finalize a return.</p>
            )
          ) : (
            <p className="text-text-secondary text-[13px]">
              {!latestSnapshot
                ? "Finalization becomes available once a current filing snapshot exists."
                : !snapshotCurrent
                  ? "The latest snapshot is out of date. Create a new version first."
                  : "This snapshot has blocking issues and can't be finalized."}
            </p>
          )}
        </Panel>
      </section>

      {/* ── Package and history ──────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={5} title="Filing package and history" description="Every version is kept exactly as it was created. Exports are preparation summaries, not filing forms." />
        <Panel>
          {history.length === 0 ? (
            <EmptyState title="No versions yet" description="Versions appear here once a filing snapshot is created." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Readiness</TableHead>
                  <TableHead>Finalized</TableHead>
                  <TableHead>Export</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((entry) => {
                  const finalization = finalizedBySnapshot.get(entry.id);
                  return (
                    <TableRow key={entry.id}>
                      <TableCell className="font-numeric text-text-primary tabular-nums">
                        v{entry.version}
                        {latestSnapshot?.id === entry.id && !snapshotCurrent ? <span className="text-text-tertiary ml-2 font-sans text-[12px]">out of date</span> : null}
                      </TableCell>
                      <TableCell className="text-text-secondary">{formatDate(entry.createdAt)}</TableCell>
                      <TableCell>
                        <Badge variant={entry.readinessStatus === "READY" ? "positive" : "warning"}>{entry.readinessStatus === "READY" ? "Ready" : "Federal ready"}</Badge>
                      </TableCell>
                      <TableCell className="text-text-secondary">{finalization ? `${formatDate(finalization.finalizedAt)}${finalization.scope === "FEDERAL_ONLY" ? " · federal only" : ""}` : "—"}</TableCell>
                      <TableCell>
                        <span className="flex gap-3 text-[13px]">
                          {(["json", "csv", "txt"] as const).map((exportFormat) => (
                            <a key={exportFormat} href={`/app/${orgId}/tax-filing/export?snapshot=${entry.id}&format=${exportFormat}`} className="text-accent hover:underline">
                              {exportFormat === "txt" ? "Summary" : exportFormat.toUpperCase()}
                            </a>
                          ))}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Panel>
      </section>
    </PageShell>
  );
}

function IssueRow({ issue }: { issue: FilingIssue }) {
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="flex w-40 shrink-0 flex-col items-start gap-1">
        <Badge variant={SEVERITY_LABEL[issue.severity].variant}>{SEVERITY_LABEL[issue.severity].badge}</Badge>
        <span className="font-numeric text-text-tertiary text-[11px] break-all">{issue.code}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-text-primary text-[15px]">{issue.message}</p>
        <p className="text-text-secondary text-[13px]">{issue.resolution}</p>
      </div>
    </li>
  );
}

function SnapshotSummary({ pkg, currency }: { pkg: FilingPackage; currency: string }) {
  const jurisdictions = [pkg.federal, ...pkg.states];
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Jurisdiction</TableHead>
            <TableHead>In this version</TableHead>
            <TableHead>Explanation</TableHead>
            <TableHead className="text-right">Tax before credits</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jurisdictions.map((jurisdiction) => (
            <TableRow key={`${jurisdiction.jurisdiction ?? jurisdiction.stateCode ?? jurisdiction.name}`}>
              <TableCell className="text-text-primary font-medium">{jurisdiction.name}</TableCell>
              <TableCell className="text-text-secondary">{ROLE_LABEL[jurisdiction.role]}</TableCell>
              <TableCell className="text-text-secondary max-w-[60ch] text-[13px] whitespace-normal">{jurisdiction.exclusionReason ?? jurisdiction.message}</TableCell>
              <TableCell className="font-numeric text-right tabular-nums">{jurisdiction.totals ? formatMinor(jurisdiction.totals.totalTaxMinor, currency) : "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <div className="border-border-subtle grid gap-4 border-t px-4 py-4 sm:grid-cols-3">
        <Figure label="Filing status" value={pkg.filingStatus.label} />
        <Figure label="Scope" value={pkg.metadata.scope === "FULL" ? "Federal and states" : "Federal only"} />
        <Figure
          label="Federal refund or balance due"
          value={pkg.refund.federal.status === "NOT_DETERMINABLE" ? "Not determinable" : `${pkg.refund.federal.status === "REFUND" ? "Refund" : "Balance due"} ${formatMinor(pkg.refund.federal.amountMinor, currency)}`}
          numeric
        />
      </div>
    </>
  );
}

function Figure({ label, value, numeric }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-text-tertiary text-[11px] font-semibold tracking-[0.08em] uppercase">{label}</span>
      <span className={numeric ? "font-numeric text-text-primary text-[15px] tabular-nums" : "text-text-primary text-[15px]"}>{value}</span>
    </div>
  );
}

function finalizeSummary(pkg: FilingPackage, version: number, currency: string): FinalizeSummary {
  return {
    taxYear: pkg.metadata.taxYear,
    version,
    filingStatus: pkg.filingStatus.label,
    scope: pkg.metadata.scope,
    jurisdictions: [pkg.federal, ...pkg.states].map((jurisdiction) => ({
      name: jurisdiction.name,
      role: ROLE_LABEL[jurisdiction.role],
      figure: jurisdiction.totals ? `${formatMinor(jurisdiction.totals.totalTaxMinor, currency)} before credits` : "No figure",
    })),
    refund:
      pkg.refund.federal.status === "NOT_DETERMINABLE"
        ? "Not determinable"
        : `${pkg.refund.federal.status === "REFUND" ? "Refund" : "Balance due"} ${formatMinor(pkg.refund.federal.amountMinor, currency)}`,
    exclusions: pkg.states
      .filter((state) => state.role === "EXCLUDED")
      .map((state) => ({ code: state.jurisdiction ?? state.stateCode ?? "STATE", name: state.name, reason: state.exclusionReason ?? "Not ready for filing." })),
    warnings: pkg.readiness.issues.filter((issue) => issue.severity === "WARNING").map((issue) => issue.message),
    limitations: pkg.limitations,
  };
}
