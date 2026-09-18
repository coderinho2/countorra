"use server";

import { createClient } from "@/server/supabase/server";
import { requireOrgMembership } from "@/server/auth/session";
import { parseSearchQuery } from "@/domain/search/query-parser";
import { listTransactions } from "@/server/db/repositories/transactions";
import { listInvoices } from "@/server/db/repositories/invoices";
import { listCustomers } from "@/server/db/repositories/customers";
import { listDocuments } from "@/server/db/repositories/documents";
import { format, money } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";
import { enforceRateLimit } from "@/server/security/rate-limit";

export interface SearchResultItem {
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

export interface SearchResults {
  transactions: SearchResultItem[];
  invoices: SearchResultItem[];
  customers: SearchResultItem[];
  documents: SearchResultItem[];
}

/**
 * Powers the command palette (product spec §6, §47). The free-text query
 * is parsed into a structured filter (src/domain/search/query-parser)
 * before it ever reaches a repository — every actual query is a
 * parameterized `.eq()/.ilike()/.gte()` call, never a string built from
 * the raw query text.
 */
const EMPTY_RESULTS: SearchResults = { transactions: [], invoices: [], customers: [], documents: [] };

export async function globalSearch(organizationId: string, rawQuery: string): Promise<SearchResults> {
  const { user } = await requireOrgMembership(organizationId);
  if (rawQuery.trim().length < 2) return EMPTY_RESULTS;

  // One palette query fans out across four tables. Generous enough to be
  // invisible while typing, tight enough to cap a scripted scan. Returns
  // empty rather than an error because the palette has no error surface and
  // a silent empty result is the honest UI for "not now".
  const rateLimited = await enforceRateLimit("search", { searchPerUser: user.id });
  if (!rateLimited.allowed) return EMPTY_RESULTS;

  const client = await createClient();
  const parsed = parseSearchQuery(rawQuery);
  const searchText = parsed.freeText || rawQuery;

  const wantsResource = (type: "transaction" | "invoice" | "customer" | "document") => !parsed.resourceType || parsed.resourceType === type;

  const [transactionsResult, invoicesResult, customers, documents] = await Promise.all([
    wantsResource("transaction")
      ? listTransactions(client, {
          organizationId,
          search: searchText || undefined,
          kind: parsed.kind ?? undefined,
          dateFrom: parsed.monthStart ?? undefined,
          dateTo: parsed.monthEnd ?? undefined,
          amountMinMinor: parsed.amountMinMinor ?? undefined,
          amountMaxMinor: parsed.amountMaxMinor ?? undefined,
          pageSize: 8,
        })
      : Promise.resolve({ transactions: [], total: 0, page: 1, pageSize: 0 }),
    wantsResource("invoice")
      ? listInvoices(client, { organizationId, search: searchText || undefined, overdueOnly: parsed.overdueOnly || undefined, pageSize: 8 })
      : Promise.resolve({ invoices: [], total: 0 }),
    wantsResource("customer") && searchText ? listCustomers(client, organizationId, searchText) : Promise.resolve([]),
    wantsResource("document") ? listDocuments(client, organizationId) : Promise.resolve([]),
  ]);

  const documentMatches = searchText
    ? documents.filter((d) => d.originalFilename?.toLowerCase().includes(searchText.toLowerCase())).slice(0, 8)
    : documents.slice(0, 8);

  return {
    transactions: transactionsResult.transactions.map((t) => ({
      id: t.id,
      title: t.description || "Transaction",
      subtitle: `${t.occurredOn} · ${isSupportedCurrency(t.currency) ? format(money(t.amountMinor, t.currency as CurrencyCode)) : t.amountMinor}`,
      href: `/app/${organizationId}/transactions/${t.id}`,
    })),
    invoices: invoicesResult.invoices.map((i) => ({
      id: i.id,
      title: `Invoice ${i.invoiceNumber}`,
      subtitle: `${i.status} · ${isSupportedCurrency(i.currency) ? format(money(i.totalMinor, i.currency as CurrencyCode)) : i.totalMinor}`,
      href: `/app/${organizationId}/invoices/${i.id}`,
    })),
    customers: customers.slice(0, 8).map((c) => ({
      id: c.id,
      title: c.displayName,
      subtitle: c.email ?? "",
      href: `/app/${organizationId}/customers/${c.id}`,
    })),
    documents: documentMatches.map((d) => ({
      id: d.id,
      title: d.originalFilename ?? "Document",
      subtitle: `${d.kind} · ${d.status}`,
      href: `/app/${organizationId}/documents`,
    })),
  };
}
