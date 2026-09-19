import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { Reveal } from "@/components/marketing/reveal";
import { CtaSection } from "@/components/marketing/cta-section";
import { LockMark } from "@/components/marketing/lock-mark";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr/ArrowRight";

export const metadata: Metadata = {
  title: "Security",
  description: "Authentication, authorization, data isolation, encrypted bank credentials, webhook verification, and the AI action-control gate.",
};

const REQUEST_FLOW = ["Your request", "Row-level security policy, evaluated per query", "Only your organization's rows"];

const ROLE_MATRIX = [
  { role: "Owner, Admin, Accountant", read: true, write: true, delete: true },
  { role: "Manager, Employee", read: true, write: true, delete: false },
  { role: "Viewer", read: true, write: false, delete: false },
];

const SECTIONS = [
  {
    number: "01",
    title: "Authentication",
    body: "Sessions are managed through Supabase Auth and refreshed on every request at the routing layer — a session is never trusted from client-held state alone. Unauthenticated requests to any application route redirect to sign-in before a page renders.",
  },
  {
    number: "02",
    title: "Authorization",
    body: "What a member can do is governed by a role, checked on both the server and at the database layer. A member can never grant themselves a higher role — that path is blocked at the row-level security policy, not only in application code.",
    table: ROLE_MATRIX,
  },
  {
    number: "03",
    title: "Data isolation",
    body: "Every table that holds financial data carries a row-level security policy scoped to organization membership. A query issued by one organization's session cannot return another organization's rows, regardless of what the application code asks for.",
  },
  {
    number: "04",
    title: "Private documents",
    body: "Uploaded documents live in a private, per-organization storage path with its own access policy. The bucket is never public: only a member of the owning organization can ask for a document, and the link they receive is short-lived and expires within minutes.",
  },
  {
    number: "05",
    title: "Auditability",
    body: "Financial record changes write to an append-only audit log. The table itself rejects UPDATE and DELETE at the database level — a change can be superseded by a new entry, never edited or erased after the fact.",
  },
  {
    number: "06",
    title: "AI action control",
    body: "The assistant can read, analyze, and calculate freely — every calculation runs through a deterministic engine, never invented by the model. Any action that would write or delete a record is held in a pending state until a privileged member explicitly confirms it.",
  },
  {
    number: "07",
    title: "Bank connections",
    body: "Bank sign-in happens in Plaid's window: Countorra never receives your bank username or password. The access key Plaid issues for a connection is encrypted with AES-256-GCM before it is stored, under a key held only in the server environment and never in the database, in a table no member role can read. It is never sent to the browser. Returning from a bank's own sign-in page uses one fixed address for everyone; which workspace you return to comes from an encrypted, server-issued session tied to your sign-in, never from the address itself.",
  },
  {
    number: "08",
    title: "Provider credentials and webhooks",
    body: "Credentials for Plaid, Stripe and our other providers exist only on the server — none is ever included in what your browser downloads. Messages Plaid and Stripe send to Countorra are verified against their signatures before anything in them is acted on, and a message delivered twice is processed once.",
  },
  {
    number: "09",
    title: "Background work",
    body: "Bank imports run in a background worker on the server. It can be started only with a deployment secret, it is rate limited like any other caller, and every job it runs is bound to one workspace — it cannot read or write another's data. It stops itself well inside its time limit, and work interrupted part-way is picked up again without being duplicated.",
  },
  {
    number: "10",
    title: "Monitoring",
    body: "Errors and security-relevant events — refused sign-ins, rate limits, rejected webhooks, background-worker health — are recorded through one filter that removes passwords, tokens, email addresses, amounts and the content of AI questions before anything is written.",
  },
  {
    number: "11",
    title: "Deleting your account",
    body: "Account deletion is self-serve and requires your password again. First, Countorra cancels the Stripe subscription of every workspace being deleted and confirms with Stripe that nothing can be charged again; if that cannot be confirmed, nothing is deleted. Then it asks Plaid to end its access and destroys every stored bank access key; if a key cannot be destroyed, nothing is deleted. Documents are removed from storage, then the workspaces you alone use, then your sign-in. A workspace cannot be deleted directly from the browser, and the database refuses to delete one whose subscription can still be charged.",
  },
];

/** Said plainly, because its absence would otherwise be read as a claim. */
const NOT_CLAIMED =
  "Countorra has not been audited or certified by a third party — no SOC 2 report, ISO 27001 certification, PCI DSS certification or independent penetration test. Card payments are handled entirely by Stripe, so card numbers never reach Countorra. No system is perfectly secure.";

/**
 * Security (product spec §9). Numbered, technically-grounded sections
 * (07–11 added in Task 16) rather than a card grid — every sentence here maps to a real
 * migration, policy, or code path (see ARCHITECTURE.md), nothing is a
 * marketing claim, a certification, or an invented statistic.
 */
export default function SecurityPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-14 lg:px-10 lg:pt-24">
        <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_auto]">
          <Reveal>
            <p className="font-numeric text-[11px] tracking-[0.14em] text-text-tertiary uppercase">Security</p>
            <h1 className="font-serif font-normal tracking-[0] mt-3 max-w-[20ch] text-[40px] leading-[46px] text-ink sm:text-[48px] sm:leading-[56px]">
              Protecting the financial layer.
            </h1>
            <p className="mt-5 max-w-[56ch] text-[17px] leading-[26px] text-text-secondary">
              This is software for real financial data. Every claim on this page reflects what is
              actually enforced in the schema and access-control layer — not a marketing
              checklist.
            </p>
          </Reveal>
          <Reveal delayMs={100} className="hidden lg:block">
            <LockMark size={120} className="text-border-strong" />
          </Reveal>
        </div>
      </section>

      <section className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
          <Reveal>
            <p className="text-[13px] font-semibold tracking-wide text-text-tertiary uppercase">How a request is scoped</p>
          </Reveal>
          <Reveal delayMs={80} className="mt-6 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
            {REQUEST_FLOW.map((step, i) => (
              <div key={step} className="flex flex-1 items-center gap-2">
                <div className="flex-1 rounded-md border border-border-subtle bg-surface px-4 py-3 text-center text-[13px] text-text-primary">{step}</div>
                {i < REQUEST_FLOW.length - 1 && <ArrowRight size={14} className="hidden shrink-0 text-border-strong sm:block" aria-hidden="true" />}
              </div>
            ))}
          </Reveal>
        </div>
      </section>

      <section className="mx-auto max-w-[820px] px-6 py-14 lg:px-10 lg:py-16">
        <div className="flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
          {SECTIONS.map((section) => (
            <Reveal key={section.number} className="py-8">
              <div className="flex items-baseline gap-3">
                <span className="font-numeric text-[13px] text-text-tertiary">{section.number}</span>
                <h2 className="text-[19px] font-semibold text-ink">{section.title}</h2>
              </div>
              <p className="mt-2 max-w-[64ch] text-[14px] leading-[1.65] text-text-secondary">{section.body}</p>

              {section.table && (
                <div className="mt-4 overflow-x-auto rounded-md border border-border-subtle">
                  <table className="w-full min-w-[420px] border-collapse text-[13px]">
                    <thead>
                      <tr className="bg-surface-sunken text-left">
                        <th className="px-3 py-2 font-medium text-text-secondary">Role</th>
                        <th className="px-3 py-2 text-right font-medium text-text-secondary">Read</th>
                        <th className="px-3 py-2 text-right font-medium text-text-secondary">Write</th>
                        <th className="px-3 py-2 text-right font-medium text-text-secondary">Delete</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.table.map((row) => (
                        <tr key={row.role} className="border-t border-border-subtle">
                          <td className="px-3 py-2 text-text-primary">{row.role}</td>
                          <td className="px-3 py-2 text-right font-numeric text-positive">{row.read ? "✓" : "—"}</td>
                          <td className={`px-3 py-2 text-right font-numeric ${row.write ? "text-positive" : "text-text-tertiary"}`}>{row.write ? "✓" : "—"}</td>
                          <td className={`px-3 py-2 text-right font-numeric ${row.delete ? "text-positive" : "text-text-tertiary"}`}>{row.delete ? "✓" : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Reveal>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[820px] px-6 pb-14 lg:px-10">
        <Reveal>
          <div className="rounded-md border border-border-subtle bg-surface-sunken p-4">
            <p className="text-[13px] font-semibold text-text-primary">What we do not claim</p>
            <p className="mt-1 max-w-[64ch] text-[13px] leading-[1.6] text-text-secondary">{NOT_CLAIMED}</p>
          </div>
        </Reveal>
      </section>

      <section className="border-t border-border-subtle">
        <div className="mx-auto max-w-[1200px] px-6 py-16 lg:px-10">
          <Reveal>
            <CtaSection />
          </Reveal>
        </div>
      </section>
    </MarketingShell>
  );
}
