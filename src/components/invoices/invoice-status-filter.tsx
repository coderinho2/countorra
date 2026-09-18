"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Segmented } from "@/components/ui/segmented";

const OPTIONS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "overdue", label: "Overdue" },
  { value: "paid", label: "Paid" },
];

/**
 * Status is the axis an invoice list is actually read along — what is owed,
 * what is late, what has landed — so it belongs on the surface as a segmented
 * control rather than buried in a dropdown. DESIGN.md §26 bans dropdown-only
 * period selectors for the same reason: a control whose options are visible
 * tells you what the data contains before you touch it.
 *
 * The state lives in the URL, like every other filter in the product, so a
 * link to "the overdue ones" is a link someone can send.
 */
export function InvoiceStatusFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const value = searchParams.get("status") ?? "all";

  const onChange = (next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("status");
    else params.set("status", next);
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  };

  return <Segmented options={OPTIONS} value={value} onValueChange={onChange} ariaLabel="Filter invoices by status" size="sm" />;
}
