import type { AITool } from "./types";
import { isModuleEnabled, type ProductModule } from "@/domain/organizations/launch-scope";

/**
 * Which of the assistant's tools are part of the personal-only launch.
 *
 * `createToolRegistry` (./registry.ts) still defines all 36 tools, unchanged.
 * This filter decides which of them the assistant is given, and which a
 * pending action may still execute. A deferred tool is neither offered to the
 * model nor replayed on confirmation; when its module returns, it comes back
 * by being removed from `DEFERRED_TOOLS`, with no other change.
 *
 * DEFERRED — exclusively the invoicing module, which is deferred with the
 * Freelancer and Business entity types (src/domain/organizations/launch-scope.ts):
 *
 *   getInvoices, getInvoice, getOverdueInvoices   read invoices
 *   getCustomers                                   read customers
 *   createDraftInvoice                             write an invoice
 *
 * KEPT, AFTER REVIEW — they read like business tools but serve a person:
 *
 *   getProfitAndLoss, prepareReport,     income against spending by category
 *   calculateProfit, calculateMargin     for a period; "profit" and "margin"
 *                                        are a household's net and savings
 *                                        rate. The system prompt tells the
 *                                        assistant to speak in those terms.
 *   calculateSalesTax, calculateVAT      arithmetic on a rate the PERSON
 *                                        supplies (a purchase, a trip); no
 *                                        rates are looked up or implied.
 *   calculateTaxEstimate                 the individual Form 1040 — including
 *                                        self-employment income, which a
 *                                        person with side income reports on
 *                                        their personal return. No business
 *                                        return (1120, 1065) exists or is
 *                                        claimed.
 *   calculateCaliforniaSdi               withholding on an employee's wages.
 *
 * Every other tool — accounts, balances, transactions, categories, recurring
 * expenses, anomalies, forecasts, insights, documents, bank-connection status,
 * and tax preparation / filing readiness — is personal by nature and kept.
 */
export const DEFERRED_TOOLS: Readonly<Record<string, ProductModule>> = {
  getInvoices: "invoicing",
  getInvoice: "invoicing",
  getOverdueInvoices: "invoicing",
  getCustomers: "invoicing",
  createDraftInvoice: "invoicing",
};

export function isToolInLaunchScope(toolName: string): boolean {
  const deferredWith = DEFERRED_TOOLS[toolName];
  return deferredWith === undefined || isModuleEnabled(deferredWith);
}

/** The tools the assistant is given at launch. */
export function launchScopeTools(tools: AITool[]): AITool[] {
  return tools.filter((tool) => isToolInLaunchScope(tool.name));
}
