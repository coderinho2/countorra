import type { Metadata } from "next";
import { PersonaPage } from "@/components/marketing/persona-page";
import { SEGMENTS } from "@/components/marketing/segments-data";
import { CategoryBreakdown } from "@/components/charts/category-breakdown";
import { money } from "@/domain/money/money";

export const metadata: Metadata = {
  title: "Personal — Countorra",
  description: "Understand everyday spending, recurring costs, and financial health.",
};

const CATEGORIES = [
  { categoryId: "groceries", categoryName: "Groceries", total: money(48200, "USD") },
  { categoryId: "dining", categoryName: "Dining", total: money(38600, "USD") },
  { categoryId: "subscriptions", categoryName: "Subscriptions", total: money(21400, "USD") },
  { categoryId: "transport", categoryName: "Transport", total: money(16800, "USD") },
];

export default function PersonalSolutionPage() {
  const segment = SEGMENTS.find((s) => s.key === "personal")!;
  return (
    <PersonaPage
      segment={segment}
      emphasis={{
        label: "The question",
        title: "Where did it actually go?",
        body: "Not a budget you have to maintain — a picture of what already happened, grouped the way you would group it yourself, with the recurring costs you stopped noticing pulled back out into the open.",
      }}
      visual={
        <div className="rounded-md border border-border-subtle bg-surface p-6 sm:p-8">
          <p className="mb-5 text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Spending this month</p>
          <CategoryBreakdown items={CATEGORIES} />
        </div>
      }
    />
  );
}
