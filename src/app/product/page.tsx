import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { SectionHeader } from "@/components/marketing/section-header";
import { Reveal } from "@/components/marketing/reveal";
import { IntelligenceMap } from "@/components/marketing/intelligence-map";
import { DocumentsFlow } from "@/components/marketing/documents-flow";
import { CtaSection } from "@/components/marketing/cta-section";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { money, format } from "@/domain/money/money";

export const metadata: Metadata = {
  title: "Product — Countorra",
  description: "Financial intelligence, your accounts and transactions, personal tax preparation, and documents in one system.",
};

const SUB_NAV = [
  { href: "#financial-intelligence", label: "Financial intelligence" },
  { href: "#accounting", label: "Accounts" },
  { href: "#taxes", label: "Personal taxes" },
  { href: "#documents", label: "Documents" },
];

const ACCOUNTS = [
  { name: "Checking", balanceMinor: 818460 },
  { name: "Savings", balanceMinor: 1000000 },
  { name: "Credit card", balanceMinor: -84200 },
];

const TRANSACTIONS = [
  { label: "Paycheck — Northwind Co.", category: "Income", date: "Nov 21", amountMinor: 360000 },
  { label: "Grocery store", category: "Groceries", date: "Nov 19", amountMinor: -12480 },
  { label: "Electric utility", category: "Utilities", date: "Nov 15", amountMinor: -9620 },
  { label: "Rent", category: "Housing", date: "Nov 1", amountMinor: -185000 },
];

/** Illustrative figures for the tax preparation preview. The states shown —
 *  confirmed, and a suggestion awaiting review — are the real ones. */
const TAX_FACTS = [
  { label: "W-2 wages", state: "Confirmed", amountMinor: 8640000 },
  { label: "Federal withholding", state: "Confirmed", amountMinor: 912000 },
  { label: "Side income (Schedule C)", state: "Awaiting review", amountMinor: 625000 },
];

function AccountingPreview() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="rounded-md border border-border-subtle bg-surface">
        <Table>
          <TableBody>
            {TRANSACTIONS.map((t) => (
              <TableRow key={t.label}>
                <TableCell className="text-[13px]">{t.label}</TableCell>
                <TableCell className="hidden text-[13px] text-text-secondary sm:table-cell">
                  <Badge variant="neutral">{t.category}</Badge>
                </TableCell>
                <TableCell className="hidden text-[13px] text-text-secondary sm:table-cell">{t.date}</TableCell>
                <TableCell numeric className={t.amountMinor > 0 ? "text-[13px] text-positive" : "text-[13px] text-text-primary"}>
                  {t.amountMinor > 0 ? "+" : "-"}
                  {format(money(Math.abs(t.amountMinor), "USD"))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-0.5 rounded-md border border-border-subtle bg-surface p-4">
        <p className="mb-2 text-[13px] font-medium text-text-secondary">Accounts</p>
        {ACCOUNTS.map((a) => (
          <div key={a.name} className="flex items-center justify-between border-b border-border-subtle py-2.5 text-[13px] last:border-0">
            <span className="text-text-primary">{a.name}</span>
            <span className={`font-numeric ${a.balanceMinor < 0 ? "text-negative" : "text-text-primary"}`}>{format(money(a.balanceMinor, "USD"))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaxPreview() {
  return (
    <div className="mx-auto max-w-xl rounded-md border border-border-subtle bg-surface p-8 shadow-[var(--shadow-level-1)]">
      <div className="flex items-start justify-between border-b border-border-subtle pb-6">
        <div>
          <p className="text-[15px] font-semibold text-ink">2026 tax preparation</p>
          <p className="text-[13px] text-text-secondary">Federal · California</p>
        </div>
        <Badge variant="info">In progress</Badge>
      </div>

      <Table className="mt-4">
        <TableBody>
          {TAX_FACTS.map((fact) => (
            <TableRow key={fact.label}>
              <TableCell className="text-[13px]">{fact.label}</TableCell>
              <TableCell className="text-[13px]">
                <Badge variant={fact.state === "Confirmed" ? "positive" : "warning"}>{fact.state}</Badge>
              </TableCell>
              <TableCell numeric className="text-[13px]">
                {format(money(fact.amountMinor, "USD"))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <div className="mt-4 flex flex-col gap-1.5 border-t border-border pt-4">
        <p className="text-[13px] text-text-secondary">Only confirmed figures are used. Suggestions wait for your review.</p>
        <p className="text-[12px] text-text-tertiary">Estimates are before credits. Countorra prepares; it does not file.</p>
      </div>
    </div>
  );
}

/**
 * Product deep-dive (product spec §6, §10). A different composition from
 * the homepage — a persistent, sectioned exploration of the four real
 * product areas rather than a narrative scroll. Every figure is static
 * illustrative preview data; nothing here reads from or writes to the
 * database.
 */
export default function ProductPage() {
  return (
    <MarketingShell>
      <section className="mx-auto max-w-[1200px] px-6 pt-16 pb-12 lg:px-10 lg:pt-24">
        <Reveal>
          <h1 className="font-serif font-normal tracking-[0] max-w-[20ch] text-[40px] leading-[46px] text-ink sm:text-[48px] sm:leading-[56px]">
            One system for your entire financial picture.
          </h1>
          <p className="mt-5 max-w-[56ch] text-[17px] leading-[26px] text-text-secondary">
            Financial intelligence, your accounts, personal tax preparation, and documents —
            built on the same data, not four disconnected tools.
          </p>
        </Reveal>

        <nav aria-label="On this page" className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-y border-border-subtle py-3">
          {SUB_NAV.map((item) => (
            <a key={item.href} href={item.href} className="text-[13px] text-text-secondary transition-colors duration-100 ease-out hover:text-text-primary">
              {item.label}
            </a>
          ))}
        </nav>
      </section>

      <section id="financial-intelligence" className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
        <Reveal>
          <SectionHeader title="See the whole picture, and where it's headed.">
            Income, expenses and accounts read as one connected system — with a financial
            health score and cash flow forecast built in.
          </SectionHeader>
        </Reveal>
        <Reveal delayMs={80} className="mt-10">
          <IntelligenceMap />
        </Reveal>
      </section>

      <section id="accounting" className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
          <Reveal>
            <SectionHeader title="Every transaction, accounted for.">
              Categorize with a request to the AI assistant or by hand, search instantly, and
              check everything against real account balances.
            </SectionHeader>
          </Reveal>
          <Reveal delayMs={80} className="mt-10">
            <AccountingPreview />
          </Reveal>
        </div>
      </section>

      <section id="taxes" className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
        <Reveal>
          <SectionHeader title="Your tax year, organised as you go.">
            Wages, withholding, side income and dependents gathered in one place, with an
            estimate from the supported U.S. federal and state rules.
          </SectionHeader>
        </Reveal>
        <Reveal delayMs={80} className="mt-10">
          <TaxPreview />
        </Reveal>
      </section>

      <section id="documents" className="border-t border-border-subtle bg-surface-sunken/40">
        <div className="mx-auto max-w-[1200px] px-6 py-14 lg:px-10 lg:py-16">
          <Reveal>
            <SectionHeader title="Documents that become data.">
              Receipts, bills and tax forms move from a folder to structured, confirmable
              financial records.
            </SectionHeader>
          </Reveal>
          <Reveal delayMs={80} className="mt-10">
            <DocumentsFlow />
          </Reveal>
        </div>
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
