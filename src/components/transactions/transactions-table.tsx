"use client";

import * as React from "react";
import { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CaretLeft } from "@phosphor-icons/react/dist/ssr/CaretLeft";
import { CaretRight } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Panel, PanelFooter, PanelHeader } from "@/components/ui/panel";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Amount } from "@/components/amount";
import { money, zero } from "@/domain/money/money";
import { isSupportedCurrency } from "@/domain/money/currency";
import { cn } from "@/lib/utils";
import { categorizeTransactionAction, bulkCategorizeAction, markReviewedAction } from "@/server/transactions/actions";
import type { Transaction } from "@/server/db/repositories/transactions";
import type { Category } from "@/server/db/repositories/categories";
import type { Merchant } from "@/server/db/repositories/merchants";

function safeMoney(amountMinor: number, currency: string) {
  return isSupportedCurrency(currency) ? money(amountMinor, currency) : zero("USD");
}

/**
 * The transaction ledger.
 *
 * Composition notes from the Phase 2 pass:
 *
 * - The table lives inside a `Panel`, with the filters as its toolbar. A bare
 *   table on the page background has no edge, so the sticky header (§11) had
 *   nothing to be sticky *against* and the whole thing read as unfinished.
 * - Column widths are fixed and the description truncates. Without that, one
 *   long category name wrapped inside its select and made those rows two
 *   lines tall, breaking the 44px rhythm §11 specifies and turning a ruled
 *   table into a ragged one.
 * - The unreviewed flag became a dot rather than a "Unreviewed" pill. At 50
 *   rows the pills were the loudest thing on the page, which inverted the
 *   hierarchy: the amounts are what the page is for.
 * - The bulk bar is inside the panel header and reserves no space when empty,
 *   so selecting rows does not shove the table down the page.
 */
export function TransactionsTable({
  organizationId,
  transactions,
  categories,
  merchants,
  total,
  page,
  pageSize,
  filters,
}: {
  organizationId: string;
  transactions: Transaction[];
  categories: Category[];
  merchants: Merchant[];
  total: number;
  page: number;
  pageSize: number;
  filters: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [, startTransition] = useTransition();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const merchantName = new Map(merchants.map((m) => [m.id, m.name]));
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const allSelected = transactions.length > 0 && selected.size === transactions.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(transactions.map((t) => t.id)));
  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkCategorize = (categoryId: string) => {
    startTransition(async () => {
      await bulkCategorizeAction(organizationId, [...selected], categoryId === "none" ? null : categoryId);
      setSelected(new Set());
    });
  };

  const bulkMarkReviewed = () => {
    startTransition(async () => {
      await markReviewedAction(organizationId, [...selected]);
      setSelected(new Set());
    });
  };

  const goToPage = (next: number) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next <= 1) params.delete("page");
    else params.set("page", String(next));
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  };

  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);
  const lastPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Panel>
      <PanelHeader className="gap-2 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {filters}
          {/* Selection state replaces the right-hand side of the toolbar
              rather than adding a second bar above the table, so the table
              never moves when a row is ticked. */}
          {selected.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="font-numeric text-[13px] text-text-secondary">{selected.size} selected</span>
              <Select onValueChange={bulkCategorize}>
                <SelectTrigger className="h-8 w-44">
                  <SelectValue placeholder="Categorize as…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Uncategorized</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" variant="secondary" onClick={bulkMarkReviewed}>
                Mark reviewed
              </Button>
            </div>
          )}
        </div>
      </PanelHeader>

      {transactions.length === 0 ? (
        <EmptyState title="No transactions match these filters" description="Try widening your date range or clearing a filter." />
      ) : (
        <>
          <Table fixed>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pr-0">
                  <Checkbox checked={allSelected} onCheckedChange={toggleAll} aria-label="Select all" />
                </TableHead>
                {/* `w-full` is what makes the description column absorb the
                    remaining width under the browser's auto table layout;
                    every other column is fixed. Without it the cell's
                    `max-w-0` (which is what enables truncation) collapsed the
                    column to its minimum and every description read as three
                    letters and an ellipsis. */}
                <TableHead className="w-full">
                  <span className="font-numeric text-[10px] tracking-[0.08em] uppercase">Description</span>
                </TableHead>
                <TableHead className="w-56">
                  <span className="font-numeric text-[10px] tracking-[0.08em] uppercase">Merchant</span>
                </TableHead>
                <TableHead className="w-52">
                  <span className="font-numeric text-[10px] tracking-[0.08em] uppercase">Category</span>
                </TableHead>
                <TableHead className="w-28">
                  <span className="font-numeric text-[10px] tracking-[0.08em] uppercase">Date</span>
                </TableHead>
                <TableHead numeric className="border-border-subtle w-36 border-l">
                  <span className="font-numeric text-[10px] tracking-[0.08em] uppercase">Amount</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((t) => (
                <TableRow key={t.id} selected={selected.has(t.id)}>
                  <TableCell className="pr-0">
                    <Checkbox checked={selected.has(t.id)} onCheckedChange={() => toggleOne(t.id)} aria-label="Select row" />
                  </TableCell>
                  <TableCell className="max-w-0">
                    <span className="flex items-center gap-2">
                      {/* A dot, not a pill: it marks the row without
                          competing with the amount, and it carries a title so
                          the meaning is never colour-only (DESIGN.md §24). */}
                      <span
                        className={cn("size-1.5 shrink-0 rounded-full", t.isReviewed ? "bg-transparent" : "bg-warning")}
                        title={t.isReviewed ? undefined : "Not yet reviewed"}
                        aria-label={t.isReviewed ? undefined : "Not yet reviewed"}
                        role={t.isReviewed ? undefined : "img"}
                      />
                      <Link
                        href={`/app/${organizationId}/transactions/${t.id}`}
                        className="truncate rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {t.description ?? "—"}
                      </Link>
                    </span>
                  </TableCell>
                  <TableCell className="truncate text-text-secondary">{t.merchantId ? (merchantName.get(t.merchantId) ?? "—") : "—"}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1">
                      <Select
                        value={t.categoryId ?? "none"}
                        onValueChange={(v) => startTransition(() => categorizeTransactionAction(organizationId, t.id, v === "none" ? null : v))}
                      >
                        <SelectTrigger className="h-8 min-w-0 flex-1 border-transparent bg-transparent px-2 text-[13px] hover:border-border">
                          <SelectValue>{t.categoryId ? (categoryName.get(t.categoryId) ?? "Uncategorized") : "Uncategorized"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Uncategorized</SelectItem>
                          {categories
                            .filter((c) => c.kind === t.kind)
                            .map((c) => (
                              <SelectItem key={c.id} value={c.id}>
                                {c.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      {t.categorizedBy === "ai" && (
                        <span
                          className="shrink-0 rounded-[4px] border border-border-subtle px-1 text-[10px] font-semibold tracking-[0.02em] text-text-tertiary uppercase"
                          title="Suggested by Countorra"
                        >
                          AI
                        </span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-text-secondary">
                    <span className="font-numeric text-[13px]">{t.occurredOn}</span>
                  </TableCell>
                  <TableCell numeric className="border-border-subtle border-l">
                    <Amount
                      value={safeMoney(t.amountMinor, t.currency)}
                      sign={t.kind === "income" ? "positive" : t.kind === "expense" ? "negative" : "none"}
                      tone={t.kind === "income" ? "positive" : "neutral"}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <PanelFooter>
            <span className="font-numeric">
              {firstRow}–{lastRow} of {total.toLocaleString("en-US")}
            </span>
            {lastPage > 1 && (
              <span className="flex items-center gap-1">
                <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => goToPage(page - 1)} aria-label="Previous page">
                  <CaretLeft size={14} />
                  Previous
                </Button>
                <Button size="sm" variant="ghost" disabled={page >= lastPage} onClick={() => goToPage(page + 1)} aria-label="Next page">
                  Next
                  <CaretRight size={14} />
                </Button>
              </span>
            )}
          </PanelFooter>
        </>
      )}
    </Panel>
  );
}
