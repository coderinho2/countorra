import { Info } from "@phosphor-icons/react/dist/ssr/Info";
import { Calculator } from "@phosphor-icons/react/dist/ssr/Calculator";
import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { can } from "@/domain/organizations/permissions";
import { format, money } from "@/domain/money/money";
import { isSupportedCurrency } from "@/domain/money/currency";
import { supportedTaxYears } from "@/domain/tax/register";
import type { TaxJurisdiction } from "@/domain/tax/rules/types";
import { factDefinition } from "@/domain/tax-preparation/facts";
import { readableFilingStatus, type PreparationProgressSection } from "@/domain/tax-preparation/preparation-package";
import type { JurisdictionResult } from "@/domain/tax-preparation/calculation";
import type { IssueSeverity, PreparationIssue, ResultStatus } from "@/domain/tax-preparation/types";
import { listPreparationCases } from "@/server/db/repositories/tax-preparation";
import { listDocuments } from "@/server/db/repositories/documents";
import { VISIBLE_DOCUMENT_STATUSES } from "@/domain/documents/upload-lifecycle";
import { loadPreparationWorkspace } from "@/server/tax-preparation/workspace";
import { PageHeader, PageMeta, PageMetaItem, PageShell } from "@/components/ui/page-header";
import { Panel, PanelFooter, SectionHeading } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AddDependentDialog,
  AddFactDialog,
  CalculateForm,
  FactReviewActions,
  RemoveDependentButton,
  StartPreparationForm,
  TaxpayerForm,
} from "@/components/tax-preparation/preparation-forms";

/**
 * Tax preparation.
 *
 * The page is a document, not a dashboard: numbered, ruled sections read in
 * the order a person actually works through a tax year — what needs
 * attention, who the taxpayer is, what they earned and paid, who they claim,
 * and what the supported rules produce from all of it.
 *
 * TWO THINGS THE PAGE REFUSES TO DO
 *
 * It never presents anything as a return, as filed, or as final. Countorra
 * does not file, and the only place that is said is not a footnote — it is
 * the first thing under the title.
 *
 * It never shows a percentage of completeness. "87% complete" is a number
 * nobody can check or act on; each section says what is actually there.
 */

const JURISDICTION_NAMES: Record<TaxJurisdiction, string> = {
  US_FEDERAL: "Federal",
  US_CA: "California",
  US_NY: "New York",
  US_FL: "Florida",
  US_TX: "Texas",
  US_AZ: "Arizona",
};

const RESULT_BADGE: Record<ResultStatus, { label: string; variant: BadgeProps["variant"] }> = {
  CALCULATED: { label: "Calculated", variant: "neutral" },
  ESTIMATE: { label: "Estimate", variant: "warning" },
  INCOMPLETE: { label: "Incomplete", variant: "warning" },
  BLOCKED: { label: "Unavailable", variant: "warning" },
  UNSUPPORTED: { label: "Not supported", variant: "neutral" },
  NEEDS_REVIEW: { label: "Needs review", variant: "warning" },
};

const SEVERITY_BADGE: Record<IssueSeverity, { label: string; variant: BadgeProps["variant"] }> = {
  // A blocker and a non-blocking ERROR shared the `warning` variant, so the
  // two rows that actually stop a calculation were indistinguishable at a
  // glance from the ones that do not — in a list where "Blocking issues: 2"
  // is the number the person is trying to act on.
  BLOCKER: { label: "Blocks calculation", variant: "negative" },
  ERROR: { label: "Needs fixing", variant: "warning" },
  WARNING: { label: "Review", variant: "neutral" },
  INFO: { label: "Note", variant: "info" },
};

const PROGRESS_BADGE: Record<PreparationProgressSection["state"], { label: string; variant: BadgeProps["variant"] }> = {
  COMPLETE: { label: "Complete", variant: "neutral" },
  REVIEW_REQUIRED: { label: "Review", variant: "info" },
  MISSING_INFORMATION: { label: "Missing information", variant: "warning" },
  BLOCKED: { label: "Blocked", variant: "warning" },
  NOT_STARTED: { label: "Not started", variant: "neutral" },
};

const SOURCE_LABELS: Record<string, string> = {
  USER_ENTERED: "Entered",
  DOCUMENT: "Document",
  TRANSACTION: "Transactions",
  INVOICE: "Invoices",
  IMPORT: "Import",
  SYSTEM_DERIVED: "Derived",
  TAX_ENGINE: "Tax engine",
  AI_PROPOSED: "Assistant",
};

const SEVERITY_ORDER: Record<IssueSeverity, number> = { BLOCKER: 0, ERROR: 1, WARNING: 2, INFO: 3 };

export default async function TaxPreparationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { membership } = await requireOrgMembership(orgId);
  const canWrite = can(membership.role, "financial:write");

  const client = await createClient();
  const cases = await listPreparationCases(client, orgId);
  const live = cases.find((entry) => entry.status !== "ARCHIVED") ?? null;
  const years = supportedTaxYears("US_FEDERAL");

  const header = (
    <PageHeader
      eyebrow="Tax"
      title="Tax preparation"
      description="Organize a tax year's information and see what the supported tax rules produce from it."
    />
  );

  const notice = (
    <p className="border-border-subtle border-l-accent bg-surface text-text-secondary flex items-start gap-2.5 rounded-md border border-l-2 px-4 py-3 text-[13px]">
      <Info size={16} aria-hidden="true" className="text-accent mt-px shrink-0" />
      <span>
        Countorra helps organize and prepare tax information. It does not file tax returns and cannot submit anything to the IRS or a state tax authority. Some
        situations need review by a qualified tax professional.
      </span>
    </p>
  );

  if (!live) {
    return (
      <PageShell className="gap-6">
        {header}
        {notice}
        <Panel>
          <EmptyState
            icon={<Calculator size={24} aria-hidden="true" />}
            title="No tax year in preparation"
            description={years.length > 0 ? `Start with a tax year the supported rules cover: ${years.join(", ")}.` : "No tax year is currently supported."}
            action={canWrite && years.length > 0 ? <StartPreparationForm organizationId={orgId} years={years} /> : undefined}
          />
        </Panel>
      </PageShell>
    );
  }

  const [workspace, documents] = await Promise.all([loadPreparationWorkspace(client, orgId, live.id), listDocuments(client, orgId)]);
  if (!workspace) return null;

  const { preparationCase, facts, dependents, completeness, latest, calculationIsCurrent } = workspace;
  const pkg = workspace.package;
  const currency = workspace.currency ?? "USD";
  const shownFacts = facts.filter((fact) => fact.state !== "REJECTED");
  const rejectedCount = facts.length - shownFacts.length;
  const issues = [...completeness.issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  // The same visibility rule the Documents page uses: an upload still being
  // verified, or one refused, is not evidence of anything.
  const visibleDocuments = documents.filter((document) => (VISIBLE_DOCUMENT_STATUSES as readonly string[]).includes(document.status));
  const blocked = completeness.blockers.length > 0;

  return (
    <PageShell className="gap-8">
      <PageHeader
        eyebrow="Tax"
        title={`Tax year ${preparationCase.taxYear}`}
        description="Organize this year's information and see what the supported tax rules produce from it."
        actions={canWrite ? <CalculateForm organizationId={orgId} caseId={preparationCase.id} blockerCount={completeness.blockers.length} /> : undefined}
        meta={
          <PageMeta>
            <PageMetaItem label="Filing status" value={preparationCase.filingStatus ? readableFilingStatus(preparationCase.filingStatus) : "Not chosen"} />
            <PageMetaItem label="Blocking issues" value={completeness.blockers.length} tone={blocked ? "warning" : "neutral"} />
            <PageMetaItem label="Version" value={preparationCase.currentVersion} />
            <PageMetaItem label="Last calculated" value={latest ? new Date(latest.createdAt).toLocaleDateString("en-US", { dateStyle: "medium" }) : "Never"} />
          </PageMeta>
        }
      />

      {notice}

      {/* ── Progress ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4" aria-labelledby="progress-heading">
        <SectionHeading index={1} title="Where things stand" description="Each part of the year, and what is actually there." />
        <Panel>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Section</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pkg.progress.map((section) => (
                <TableRow key={section.key}>
                  <TableCell className="text-text-primary font-medium">{section.label}</TableCell>
                  <TableCell>
                    <Badge variant={PROGRESS_BADGE[section.state].variant}>{PROGRESS_BADGE[section.state].label}</Badge>
                  </TableCell>
                  <TableCell className="text-text-secondary">{section.detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      </section>

      {/* ── Attention ────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4" id="attention">
        <SectionHeading
          index={2}
          title="What needs attention"
          description={blocked ? "Issues that block calculation come first." : "Nothing blocks calculation. The notes below are still worth reading."}
        />
        <Panel>
          {issues.length === 0 ? (
            <EmptyState title="Nothing needs attention" description="Every check that can be made automatically has passed." />
          ) : (
            <ul className="divide-border-subtle flex flex-col divide-y">
              {issues.map((issue) => (
                <IssueRow key={`${issue.id}:${issue.affects ?? ""}`} issue={issue} />
              ))}
            </ul>
          )}
        </Panel>
      </section>

      {/* ── Taxpayer ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={3} title="Taxpayer and filing status" description="Countorra records whether a tax ID exists, never the number itself." />
        <Panel className="p-6">
          <TaxpayerForm
            organizationId={orgId}
            caseId={preparationCase.id}
            filingStatus={preparationCase.filingStatus}
            taxpayer={preparationCase.taxpayer}
            disabled={!canWrite}
          />
        </Panel>
      </section>

      {/* ── Facts ────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading
          index={4}
          title="Income, deductions and payments"
          description="Only confirmed figures are used in a calculation. Suggestions wait for review."
          action={
            canWrite ? (
              <AddFactDialog
                organizationId={orgId}
                caseId={preparationCase.id}
                currency={currency}
                documents={visibleDocuments.map((document) => ({ id: document.id, name: document.originalFilename ?? "Untitled document" }))}
              />
            ) : undefined
          }
        />
        <Panel>
          {shownFacts.length === 0 ? (
            <EmptyState title="No figures yet" description="Add wages from a W-2, self-employment profit, withholding, or anything else for this year." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Evidence</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  {canWrite && (
                    <TableHead>
                      <span className="sr-only">Review</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {shownFacts.map((fact) => {
                  const definition = factDefinition(fact.key);
                  return (
                    <TableRow key={fact.id}>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-text-primary">{definition.label}</span>
                          {definition.support === "COLLECTED_NOT_CALCULATED" && (
                            <span className="text-text-tertiary text-[12px]">Recorded, not included in any calculated figure</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-text-secondary">{SOURCE_LABELS[fact.source] ?? fact.source}</TableCell>
                      <TableCell>
                        {fact.state === "PROPOSED" ? <Badge variant="warning">Awaiting review</Badge> : <Badge variant="neutral">Confirmed</Badge>}
                      </TableCell>
                      <TableCell className="text-text-secondary">{fact.evidenceDocumentId ? "Document attached" : "—"}</TableCell>
                      <TableCell className="font-numeric text-right tabular-nums">
                        {fact.amountMinor !== null && fact.currency ? format(money(fact.amountMinor, fact.currency)) : "—"}
                      </TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          <FactReviewActions organizationId={orgId} caseId={preparationCase.id} factId={fact.id} state={fact.state} />
                        </TableCell>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {rejectedCount > 0 && (
            <PanelFooter>
              <span>
                {rejectedCount} rejected {rejectedCount === 1 ? "entry is" : "entries are"} kept in the history and not used.
              </span>
            </PanelFooter>
          )}
        </Panel>
      </section>

      {/* ── Dependents ───────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading
          index={5}
          title="Dependents"
          description="Collected for review. Countorra does not decide whether someone qualifies."
          action={canWrite ? <AddDependentDialog organizationId={orgId} caseId={preparationCase.id} /> : undefined}
        />
        <Panel>
          {dependents.length === 0 ? (
            <EmptyState title="No dependents added" description="Add anyone you expect to claim for this year." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Relationship</TableHead>
                  <TableHead>Information</TableHead>
                  {canWrite && (
                    <TableHead>
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {dependents.map((dependent) => (
                  <TableRow key={dependent.id}>
                    <TableCell className="text-text-primary">{`${dependent.firstName} ${dependent.lastName}`}</TableCell>
                    <TableCell className="text-text-secondary">{dependent.relationship}</TableCell>
                    <TableCell>
                      <Badge variant={dependent.status === "VERIFIED" ? "neutral" : "warning"}>
                        {dependent.status === "VERIFIED" ? "Complete" : dependent.status === "NEEDS_REVIEW" ? "Needs review" : dependent.status === "INCOMPLETE" ? "Incomplete" : "Not supported"}
                      </Badge>
                    </TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        <RemoveDependentButton organizationId={orgId} caseId={preparationCase.id} dependentId={dependent.id} />
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </section>

      {/* ── Calculation ──────────────────────────────────────────────── */}
      <section className="flex flex-col gap-4">
        <SectionHeading index={6} title="Calculation" description="What the supported tax rules produce from the confirmed figures, before any credits." />

        {latest?.calculation && !calculationIsCurrent && (
          <p className="border-border-subtle border-l-warning bg-surface text-text-secondary rounded-md border border-l-2 px-4 py-3 text-[13px]">
            Information has changed since version {latest.version} was calculated. The figures below are from that version — calculate again to include the
            changes.
          </p>
        )}

        <Panel>
          {!latest?.calculation ? (
            <EmptyState
              title="Not calculated yet"
              description={
                blocked
                  ? `Resolve the ${completeness.blockers.length === 1 ? "issue" : `${completeness.blockers.length} issues`} that block calculation first.`
                  : "Everything required is present. Calculate to see what the supported rules produce."
              }
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Jurisdiction</TableHead>
                    <TableHead>Result</TableHead>
                    <TableHead>Explanation</TableHead>
                    <TableHead className="text-right">Tax before credits</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[latest.calculation.federal, ...latest.calculation.states].map((result) => (
                    <ResultRow key={result.jurisdiction} result={result} currency={latest.calculation!.currency} />
                  ))}
                </TableBody>
              </Table>
              <PanelFooter>
                <span>
                  Version {latest.calculation.version}, calculated {new Date(latest.calculation.calculatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}. Federal
                  and state amounts are separate liabilities.
                </span>
              </PanelFooter>
            </>
          )}
        </Panel>

        {latest?.calculation && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <Panel className="flex flex-col gap-2 p-6">
              <h3 className="text-text-secondary text-[11px] font-semibold tracking-[0.08em] uppercase">Federal refund or balance due</h3>
              {latest.calculation.federalRefund.amountMinor === null || !isSupportedCurrency(latest.calculation.currency) ? (
                <p className="text-text-primary text-[15px]">Not stated</p>
              ) : (
                <p
                  className={
                    latest.calculation.federalRefund.status === "REFUND_EXPECTED"
                      ? "font-numeric text-positive text-[28px] font-semibold tabular-nums"
                      : "font-numeric text-negative text-[28px] font-semibold tabular-nums"
                  }
                >
                  {latest.calculation.federalRefund.status === "REFUND_EXPECTED" ? "+" : "−"}
                  {format(money(latest.calculation.federalRefund.amountMinor, latest.calculation.currency))}
                  <span className="text-text-secondary ml-2 font-sans text-[13px] font-normal">
                    {latest.calculation.federalRefund.status === "REFUND_EXPECTED" ? "expected refund" : "balance due"}
                  </span>
                </p>
              )}
              <p className="text-text-secondary text-[13px]">{latest.calculation.federalRefund.explanation}</p>
            </Panel>

            <Panel className="flex flex-col gap-2 p-6">
              <h3 className="text-text-secondary text-[11px] font-semibold tracking-[0.08em] uppercase">Not included</h3>
              <p className="text-text-secondary text-[13px]">No tax credits are modelled. These items were also left out of the figures:</p>
              {latest.calculation.notModelled.length === 0 ? (
                <p className="text-text-primary text-[13px]">Nothing else.</p>
              ) : (
                <details className="text-[13px]">
                  <summary className="text-accent cursor-pointer">
                    {latest.calculation.notModelled.length} {latest.calculation.notModelled.length === 1 ? "item" : "items"}
                  </summary>
                  <ul className="text-text-secondary mt-2 flex list-disc flex-col gap-1 pl-5">
                    {latest.calculation.notModelled.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </details>
              )}
            </Panel>
          </div>
        )}
      </section>
    </PageShell>
  );
}

function IssueRow({ issue }: { issue: PreparationIssue }) {
  const badge = SEVERITY_BADGE[issue.severity];
  return (
    <li className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="w-40 shrink-0">
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-text-primary text-[15px]">{issue.message}</p>
        <p className="text-text-secondary text-[13px]">{issue.resolution}</p>
      </div>
    </li>
  );
}

function ResultRow({ result, currency }: { result: JurisdictionResult; currency: string }) {
  const badge = RESULT_BADGE[result.status];
  return (
    <TableRow>
      <TableCell className="text-text-primary font-medium">{JURISDICTION_NAMES[result.jurisdiction]}</TableCell>
      <TableCell>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </TableCell>
      <TableCell className="text-text-secondary max-w-[60ch] text-[13px] whitespace-normal">{result.message}</TableCell>
      <TableCell className="font-numeric text-right tabular-nums">
        {/* Null is not zero. A state that could not be calculated shows a
            dash, never $0.00 — Arizona does tax income. */}
        {result.totalTaxMinor === null || !isSupportedCurrency(currency) ? "—" : format(money(result.totalTaxMinor, currency))}
      </TableCell>
    </TableRow>
  );
}
