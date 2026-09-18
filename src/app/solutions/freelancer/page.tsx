import type { Metadata } from "next";
import { PersonaPage } from "@/components/marketing/persona-page";
import { SEGMENTS } from "@/components/marketing/segments-data";
import { MonthlyBarChart } from "@/components/charts/monthly-bar-chart";
import { InvoiceStatusBadge } from "@/components/invoice-status-badge";
import { money, format } from "@/domain/money/money";

export const metadata: Metadata = {
  title: "Freelancer — Countorra",
  description: "Income, invoices, and cash flow across irregular pay cycles.",
};

const CASH_FLOW = [
  { label: "Aug", income: money(620000, "USD"), expense: money(210000, "USD") },
  { label: "Sep", income: money(410000, "USD"), expense: money(198000, "USD") },
  { label: "Oct", income: money(780000, "USD"), expense: money(224000, "USD") },
  { label: "Nov", income: money(480000, "USD"), expense: money(206000, "USD") },
];

const INVOICES = [
  { number: "INV-1042", client: "Nordholt Studio", status: "overdue" as const, amountMinor: 240000 },
  { number: "INV-1047", client: "Kessler & Co.", status: "sent" as const, amountMinor: 180000 },
  { number: "INV-1039", client: "Bright Path LLC", status: "paid" as const, amountMinor: 96000 },
];

export default function FreelancerSolutionPage() {
  const segment = SEGMENTS.find((s) => s.key === "freelancer")!;
  return (
    <PersonaPage
      segment={segment}
      layout="split"
      emphasis={{
        label: "The question",
        title: "Who owes me, and can I cover next month?",
        body: "Freelance income arrives in lumps and expenses do not. The two figures that matter are what is outstanding and what a thin month actually looks like against your real costs.",
      }}
      visual={
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-md border border-border-subtle bg-surface p-6 sm:p-8">
            <p className="mb-5 text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Income across pay cycles</p>
            <MonthlyBarChart data={CASH_FLOW} />
          </div>
          <div className="overflow-hidden rounded-md border border-border-subtle bg-surface">
            <p className="border-b border-border-subtle px-4 py-3 text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Outstanding</p>
            {INVOICES.map((inv) => (
              <div key={inv.number} className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 text-[13px] last:border-0">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="font-numeric text-text-secondary">{inv.number}</span>
                    <InvoiceStatusBadge status={inv.status} />
                  </span>
                  <span className="truncate text-text-primary">{inv.client}</span>
                </div>
                <span className="shrink-0 font-numeric text-text-primary">{format(money(inv.amountMinor, "USD"))}</span>
              </div>
            ))}
          </div>
        </div>
      }
    />
  );
}
